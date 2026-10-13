const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const { exec, execFile } = require('child_process');
const { promisify }      = require('util');
const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);

const PORT         = process.env.PORT || 3000;
const HOST         = process.env.SERVICE_HOST || '100.70.102.120';
const CFG_PATH     = path.join(__dirname, 'services.json');

function loadServices() {
  try {
    return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to read services.json:', e.message);
    return [];
  }
}

function saveServices(services) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(services, null, 2));
}

// Status cache: { [url]: { up: bool, lastChecked: timestamp } }
const statusCache = {};

function pingUrl(url) {
  const mod = url.startsWith('https') ? https : http;
  let resolved = false;
  const req = mod.get(url, { timeout: 5000 }, res => {
    resolved = true;
    statusCache[url] = { up: res.statusCode < 500, lastChecked: Date.now() };
    req.destroy();
  });
  req.on('error', () => { if (!resolved) statusCache[url] = { up: false, lastChecked: Date.now() }; });
  req.on('timeout', () => { if (!resolved) statusCache[url] = { up: false, lastChecked: Date.now() }; req.destroy(); });
}

function pingAllServices() {
  loadServices().forEach(s => pingUrl(s.url || `http://${HOST}:${s.port}`));
}

pingAllServices();
setInterval(pingAllServices, 60_000);

// ============================================================
// MONITORING
// ============================================================

// --- State ---
let cpuPrev  = null;
let cpuUsage = 0;
let cpuCores = 0;
let netPrev  = null;
let netRates = {};

const mon = {
  ram: null,
  disk: {},
  connections: [],
  authFailures: { topIps: [], recent: [] },
};
const plexCache = { folders: null, lastUpdated: 0, scanning: false };

// --- Helpers ---
function hexToIp(h) {
  const n = parseInt(h, 16);
  return [(n & 0xff), (n >> 8 & 0xff), (n >> 16 & 0xff), (n >> 24 & 0xff)].join('.');
}

function isPrivateIp(ip) {
  // Filter loopback, RFC1918, and link-local — but NOT 100.x.x.x (Tailscale range)
  return ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') || ip.startsWith('172.2') || ip.startsWith('172.3') ||
    ip === '0.0.0.0';
}

// --- Samplers ---
async function sampleCpu() {
  try {
    const raw = await fs.promises.readFile('/proc/stat', 'utf8');
    const lines = raw.split('\n');
    const parts = lines[0].trim().split(/\s+/).slice(1).map(Number);
    const idle  = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    if (cpuPrev) {
      const dTotal = total - cpuPrev.total;
      const dIdle  = idle  - cpuPrev.idle;
      if (dTotal > 0) cpuUsage = Math.round((1 - dIdle / dTotal) * 1000) / 10;
    }
    cpuPrev  = { total, idle };
    cpuCores = lines.filter(l => /^cpu\d/.test(l)).length;
  } catch {}
}

async function sampleNetwork() {
  try {
    // Try host-level first (mounted /proc/net), fall back to container-level
    const devPath = fs.existsSync('/host-net/dev') ? '/host-net/dev' : '/proc/net/dev';
    const raw = await fs.promises.readFile(devPath, 'utf8');
    const now = Date.now();
    const cur = {};
    raw.split('\n').slice(2).forEach(line => {
      const m = line.trim().match(/^(\S+):\s+(\d+)(?:\s+\d+){7}\s+(\d+)/);
      if (m && m[1] !== 'lo') cur[m[1]] = { rx: +m[2], tx: +m[3] };
    });
    if (netPrev) {
      const dt = (now - netPrev.ts) / 1000 || 1;
      Object.keys(cur).forEach(iface => {
        const p = netPrev.data[iface];
        if (p) netRates[iface] = {
          rxRate:  Math.max(0, Math.round((cur[iface].rx - p.rx) / dt)),
          txRate:  Math.max(0, Math.round((cur[iface].tx - p.tx) / dt)),
          rxTotal: cur[iface].rx,
          txTotal: cur[iface].tx,
        };
      });
    }
    netPrev = { data: cur, ts: now };
  } catch {}
}

async function sampleRam() {
  try {
    const raw = await fs.promises.readFile('/proc/meminfo', 'utf8');
    const m = {};
    raw.split('\n').forEach(line => {
      const [k, v] = line.split(':');
      if (k && v) m[k.trim()] = parseInt(v) * 1024; // kB → bytes
    });
    mon.ram = {
      total:     m.MemTotal,
      available: m.MemAvailable,
      used:      m.MemTotal - m.MemAvailable,
      cached:    (m.Cached || 0) + (m.Buffers || 0),
    };
  } catch {}
}

async function sampleDisk() {
  const paths = [
    { key: 'system', path: fs.existsSync('/host') ? '/host' : '/' },
    { key: 'plex',   path: '/mnt/plex' },
  ];
  for (const { key, path: p } of paths) {
    await new Promise(resolve => {
      fs.statfs(p, (err, s) => {
        if (!err) mon.disk[key] = {
          path:      p === '/host' ? '/' : p,
          total:     s.blocks * s.bsize,
          free:      s.bfree  * s.bsize,
          available: s.bavail * s.bsize,
          used:      (s.blocks - s.bfree) * s.bsize,
        };
        resolve();
      });
    });
  }
}

async function sampleConnections() {
  try {
    const tcpPath = fs.existsSync('/host-net/tcp') ? '/host-net/tcp' : '/proc/net/tcp';
    const raw = await fs.promises.readFile(tcpPath, 'utf8').catch(() => '');
    const conns = [];
    raw.split('\n').slice(1).forEach(line => {
      const p = line.trim().split(/\s+/);
      if (p.length < 4 || p[3] !== '01') return; // only ESTABLISHED
      const [, lPortHex] = (p[1] || '').split(':');
      const [remHex, rPortHex] = (p[2] || '').split(':');
      if (!remHex || !lPortHex) return;
      const remIp = hexToIp(remHex);
      if (isPrivateIp(remIp)) return;
      conns.push({
        localPort: parseInt(lPortHex, 16),
        remIp,
        remPort: parseInt(rPortHex, 16),
      });
    });
    mon.connections = conns;
  } catch {}
}

async function sampleAuthFailures() {
  try {
    const logFile = '/var/log/auth.log';
    await fs.promises.access(logFile);
    const { stdout } = await execAsync(
      `tail -n 5000 /var/log/auth.log | grep -iE "Failed password|Invalid user|authentication failure" 2>/dev/null || true`
    );
    const ipCounts = {};
    const lines = stdout.split('\n').filter(Boolean);
    lines.forEach(line => {
      const m = line.match(/from\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      if (m) ipCounts[m[1]] = (ipCounts[m[1]] || 0) + 1;
    });
    mon.authFailures = {
      topIps: Object.entries(ipCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([ip, count]) => ({ ip, count })),
      recent: lines.slice(-10).reverse(),
    };
  } catch {
    mon.authFailures = { topIps: [], recent: [] };
  }
}

async function triggerPlexScan() {
  if (plexCache.scanning) return;
  plexCache.scanning = true;
  try {
    const entries = await fs.promises.readdir('/mnt/plex', { withFileTypes: true }).catch(() => []);
    const folders = {};
    await Promise.all(
      entries.filter(e => e.isDirectory()).map(async e => {
        try {
          const { stdout } = await execFileAsync('du', ['-sk', `/mnt/plex/${e.name}`]);
          folders[e.name] = (parseInt(stdout.split('\t')[0]) || 0) * 1024;
        } catch { folders[e.name] = -1; }
      })
    );
    plexCache.folders    = folders;
    plexCache.lastUpdated = Date.now();
  } finally {
    plexCache.scanning = false;
  }
}

// --- Background intervals ---
(async function fastSample() { await Promise.all([sampleCpu(), sampleNetwork()]); })();
setInterval(() => Promise.all([sampleCpu(), sampleNetwork()]), 5_000);

(async function slowSample() { await Promise.all([sampleRam(), sampleDisk(), sampleConnections(), sampleAuthFailures()]); })();
setInterval(() => Promise.all([sampleRam(), sampleDisk(), sampleConnections(), sampleAuthFailures()]), 30_000);

function renderPage(services) {
  const cards = services.map((s, i) => {
    const url = s.url || `http://${HOST}:${s.port}`;
    const accent = s.color || '#888';
    const initial = s.name.charAt(0).toUpperCase();
    const links = (s.links || []).map(l =>
      `<a class="extra-link" href="${l.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${l.label}</a>`
    ).join('');
    const stageBadge = s.stage ? `<span class="stage-badge stage-${s.stage.toLowerCase()}">${s.stage}</span>` : '';
    return `
    <div class="card-wrap">
      <a class="card" href="${url}" target="_blank" rel="noopener" style="--accent:${accent}">
        <div class="card-top">
          <div class="card-top-left">
            <div class="card-icon">${initial}</div>
            <div class="card-meta">
              <span class="card-name">${s.name}</span>
              ${s.description ? `<span class="card-desc">${s.description}</span>` : ''}
            </div>
          </div>
          ${stageBadge}
        </div>
        <small class="card-url">${url}</small>
        <span class="status-badge" data-url="${url}"></span>
      </a>
      ${links ? `<div class="card-links">${links}</div>` : ''}
      <button class="edit-btn" onclick="openEdit(${i})" title="Edit">✎</button>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Router</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background: #0b0b0f;
      color: #e8e8f0;
      font-family: system-ui, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem 1rem 4rem;
    }
    h1 { font-size: 1.3rem; font-weight: 500; letter-spacing: .15em; color: #555; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1rem;
      width: 100%;
      max-width: 960px;
    }
    .card-wrap { position: relative; display: flex; flex-direction: column; }
    .edit-btn {
      position: absolute;
      top: .6rem;
      right: .6rem;
      opacity: 0;
      background: transparent;
      border: none;
      color: #666;
      border-radius: 5px;
      width: 24px;
      height: 24px;
      cursor: pointer;
      font-size: .8rem;
      display: flex; align-items: center; justify-content: center;
      transition: opacity .15s, background .15s, color .15s;
    }
    .card-wrap:hover .edit-btn { opacity: 1; }
    .edit-btn:hover { background: #2a2a3a; color: #fff; }

    .card {
      display: flex;
      flex-direction: column;
      gap: .55rem;
      padding: 1.1rem 1.2rem 1rem;
      border-radius: 10px 10px 0 0;
      border: 1px solid #1c1c28;
      border-bottom: none;
      background: #12121a;
      text-decoration: none;
      color: inherit;
      transition: background .15s, border-color .15s, box-shadow .15s;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: var(--accent);
      opacity: .7;
    }
    .card:hover {
      background: #15151f;
      border-color: #2a2a3a;
      box-shadow: 0 8px 32px color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .card:hover::before { opacity: 1; }

    .card-top {
      display: flex;
      align-items: center;
      gap: .75rem;
      justify-content: space-between;
    }
    .card-top-left { display: flex; align-items: center; gap: .75rem; min-width: 0; flex: 1; }
    .card-icon {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--accent) 15%, #0b0b0f);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      color: var(--accent);
      font-size: .95rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .card-meta { display: flex; flex-direction: column; gap: .1rem; min-width: 0; flex: 1; }
    .card-name { font-size: .95rem; font-weight: 600; color: #e0e0ec; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card-desc { font-size: .7rem; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card-url  { font-size: .65rem; color: #383848; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .card-links {
      display: flex;
      flex-wrap: wrap;
      gap: .35rem;
      padding: .55rem .9rem .65rem;
      background: #0e0e16;
      border: 1px solid #1c1c28;
      border-top: 1px solid #191926;
      border-radius: 0 0 10px 10px;
    }
    .extra-link {
      font-size: .65rem;
      font-weight: 500;
      color: #666;
      text-decoration: none;
      padding: .2rem .55rem;
      border-radius: 20px;
      border: 1px solid #242434;
      background: #13131e;
      transition: color .15s, border-color .15s, background .15s;
      white-space: nowrap;
    }
    .extra-link:hover { color: #bbb; border-color: #3a3a55; background: #1a1a28; }

    /* no extra links: rounded bottom on card itself */
    .card-wrap:not(:has(.card-links)) .card { border-radius: 10px; border-bottom: 1px solid #1c1c28; }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: .28rem;
      align-self: flex-start;
      font-size: .6rem;
      font-weight: 600;
      letter-spacing: .07em;
      text-transform: uppercase;
      padding: .15rem .45rem;
      border-radius: 20px;
      background: #181822;
      color: #383848;
      border: 1px solid #202030;
      transition: background .3s, color .3s, border-color .3s;
    }
    .status-badge::before {
      content: '';
      width: 5px; height: 5px;
      border-radius: 50%;
      background: #383848;
      flex-shrink: 0;
      transition: background .3s, box-shadow .3s;
    }
    .status-badge.up {
      background: rgba(74,207,94,.07);
      color: #4acf5e;
      border-color: rgba(74,207,94,.2);
    }
    .status-badge.up::before   { background: #4acf5e; box-shadow: 0 0 5px #4acf5e; }
    .status-badge.down {
      background: rgba(244,67,54,.07);
      color: #f44336;
      border-color: rgba(244,67,54,.18);
    }
    .status-badge.down::before { background: #f44336; }

    .stage-badge {
      font-size: .55rem;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      padding: .15rem .45rem;
      border-radius: 20px;
      flex-shrink: 0;
      align-self: flex-start;
    }
    .stage-poc  { background: rgba(155,89,182,.12); color: #9b59b6; border: 1px solid rgba(155,89,182,.25); }
    .stage-mvp  { background: rgba(255,159,67,.1);  color: #ff9f43; border: 1px solid rgba(255,159,67,.25); }
    .stage-prod { background: rgba(74,207,94,.1);   color: #4acf5e; border: 1px solid rgba(74,207,94,.25); }

    .add-btn {
      margin-top: 2rem;
      padding: .55rem 1.4rem;
      background: #13131e;
      border: 1px solid #22223a;
      color: #555;
      border-radius: 8px;
      cursor: pointer;
      font-size: .9rem;
      transition: background .15s, color .15s, border-color .15s;
    }
    .add-btn:hover { background: #1c1c2c; color: #aaa; border-color: #3a3a55; }

    /* Modal */
    .overlay {
      display: none;
      position: fixed; inset: 0;
      background: rgba(0,0,0,.7);
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .overlay.open { display: flex; }
    .modal {
      background: #13131e;
      border: 1px solid #2a2a3a;
      border-radius: 14px;
      padding: 1.75rem;
      width: 100%;
      max-width: 400px;
      display: flex;
      flex-direction: column;
      gap: .9rem;
      max-height: 90vh;
      overflow-y: auto;
    }
    .modal h2 { font-size: 1rem; font-weight: 600; color: #ccc; }
    .field { display: flex; flex-direction: column; gap: .3rem; }
    .field label { font-size: .75rem; color: #666; letter-spacing: .05em; }
    .field input {
      background: #0b0b0f;
      border: 1px solid #222232;
      border-radius: 7px;
      color: #e8e8f0;
      padding: .5rem .75rem;
      font-size: .9rem;
      outline: none;
      width: 100%;
    }
    .field input:focus { border-color: #3a3a60; }
    .field select {
      background: #0b0b0f;
      border: 1px solid #222232;
      border-radius: 7px;
      color: #e8e8f0;
      padding: .5rem .75rem;
      font-size: .9rem;
      outline: none;
      width: 100%;
      cursor: pointer;
    }
    .field select:focus { border-color: #3a3a60; }
    .field select option { background: #13131e; }
    .color-row { display: flex; align-items: center; gap: .75rem; }
    .color-row input[type=color] { width: 38px; height: 32px; padding: 2px; border-radius: 6px; border: 1px solid #222232; background: #0b0b0f; cursor: pointer; flex-shrink: 0; }
    .color-row input[type=text] { flex: 1; }

    .links-section { display: flex; flex-direction: column; gap: .5rem; }
    .links-label { font-size: .75rem; color: #666; letter-spacing: .05em; }
    .link-row { display: flex; gap: .4rem; align-items: center; }
    .link-row input { flex: 1; }
    .link-row input:first-child { max-width: 90px; }
    .link-remove {
      background: transparent;
      border: none;
      color: #555;
      cursor: pointer;
      font-size: 1rem;
      padding: 0 .2rem;
      line-height: 1;
      flex-shrink: 0;
      transition: color .15s;
    }
    .link-remove:hover { color: #f44336; }
    .add-link-btn {
      align-self: flex-start;
      background: #1a1a28;
      border: 1px solid #282840;
      color: #666;
      border-radius: 6px;
      padding: .3rem .75rem;
      font-size: .75rem;
      cursor: pointer;
      transition: background .15s, color .15s;
    }
    .add-link-btn:hover { background: #222236; color: #aaa; }

    .actions { display: flex; gap: .6rem; justify-content: flex-end; margin-top: .25rem; }
    .btn { padding: .45rem 1.1rem; border-radius: 7px; border: none; cursor: pointer; font-size: .875rem; transition: background .15s; }
    .btn-cancel { background: #222234; color: #888; }
    .btn-cancel:hover { background: #2e2e48; color: #ccc; }
    .btn-save { background: #3a6fff; color: #fff; }
    .btn-save:hover { background: #5580ff; }
    .btn-delete { background: #3a1818; color: #f44336; margin-right: auto; }
    .btn-delete:hover { background: #5a2020; }
  </style>
</head>
<body>
  <div style="display:flex;align-items:center;justify-content:space-between;width:100%;max-width:960px;margin-bottom:2.5rem">
    <h1>ROUTER</h1>
    <div style="display:flex;gap:.6rem;align-items:center">
      <a href="/monitor" style="font-size:.72rem;color:#444;text-decoration:none;letter-spacing:.1em;padding:.3rem .75rem;border:1px solid #1c1c28;border-radius:6px;transition:color .15s,border-color .15s" onmouseover="this.style.color='#aaa';this.style.borderColor='#3a3a55'" onmouseout="this.style.color='#444';this.style.borderColor='#1c1c28'">MONITOR</a>
    </div>
  </div>
  <div class="grid">${cards}</div>
  <button class="add-btn" onclick="openAdd()">+ Add Service</button>

  <div class="overlay" id="overlay" onclick="closeIfOutside(event)">
    <div class="modal">
      <h2 id="modal-title">Add Service</h2>
      <div class="field">
        <label>Name</label>
        <input id="f-name" placeholder="My App" />
      </div>
      <div class="field">
        <label>Description <span style="color:#444">(optional)</span></label>
        <input id="f-desc" placeholder="Short description" />
      </div>
      <div class="field">
        <label>Stage <span style="color:#444">(optional)</span></label>
        <select id="f-stage">
          <option value="">— none —</option>
          <option value="POC">POC</option>
          <option value="MVP">MVP</option>
          <option value="PROD">PROD</option>
        </select>
      </div>
      <div class="field">
        <label>Port</label>
        <input id="f-port" placeholder="8080" type="number" />
      </div>
      <div class="field">
        <label>URL override <span style="color:#444">(optional — overrides port)</span></label>
        <input id="f-url" placeholder="https://example.com" />
      </div>
      <div class="field">
        <label>Color</label>
        <div class="color-row">
          <input type="color" id="f-color" value="#4a9eff" />
          <input type="text" id="f-color-hex" placeholder="#4a9eff" maxlength="7" />
        </div>
      </div>
      <div class="links-section">
        <div class="links-label">Extra links <span style="color:#444">(GitHub, Supabase, Docs…)</span></div>
        <div id="link-rows"></div>
        <button class="add-link-btn" onclick="addLinkRow()">+ Add link</button>
      </div>
      <div class="actions">
        <button class="btn btn-delete" id="btn-delete" onclick="deleteService()" style="display:none">Delete</button>
        <button class="btn btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn btn-save" onclick="saveService()">Save</button>
      </div>
    </div>
  </div>

  <script>
    const services = ${JSON.stringify(services)};
    const HOST = '${HOST}';
    let editIndex = -1;

    const colorPicker = document.getElementById('f-color');
    const colorHex    = document.getElementById('f-color-hex');
    colorPicker.addEventListener('input', () => { colorHex.value = colorPicker.value; });
    colorHex.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value)) colorPicker.value = colorHex.value;
    });

    function addLinkRow(label = '', url = '') {
      const row = document.createElement('div');
      row.className = 'link-row';
      row.innerHTML = \`
        <input placeholder="Label" value="\${label.replace(/"/g,'&quot;')}" class="link-label" />
        <input placeholder="https://..." value="\${url.replace(/"/g,'&quot;')}" class="link-url" />
        <button class="link-remove" onclick="this.parentElement.remove()" title="Remove">×</button>
      \`;
      document.getElementById('link-rows').appendChild(row);
    }

    function getLinkRows() {
      return [...document.querySelectorAll('.link-row')].map(r => ({
        label: r.querySelector('.link-label').value.trim(),
        url:   r.querySelector('.link-url').value.trim(),
      })).filter(l => l.label && l.url);
    }

    function openAdd() {
      editIndex = -1;
      document.getElementById('modal-title').textContent = 'Add Service';
      document.getElementById('f-name').value  = '';
      document.getElementById('f-desc').value  = '';
      document.getElementById('f-stage').value = '';
      document.getElementById('f-port').value  = '';
      document.getElementById('f-url').value   = '';
      colorPicker.value = '#4a9eff';
      colorHex.value    = '#4a9eff';
      document.getElementById('link-rows').innerHTML = '';
      document.getElementById('btn-delete').style.display = 'none';
      document.getElementById('overlay').classList.add('open');
    }

    function openEdit(i) {
      editIndex = i;
      const s = services[i];
      document.getElementById('modal-title').textContent = 'Edit Service';
      document.getElementById('f-name').value  = s.name;
      document.getElementById('f-desc').value  = s.description || '';
      document.getElementById('f-stage').value = s.stage || '';
      document.getElementById('f-port').value  = s.port || '';
      document.getElementById('f-url').value   = s.url || '';
      const c = s.color || '#4a9eff';
      colorPicker.value = c;
      colorHex.value    = c;
      document.getElementById('link-rows').innerHTML = '';
      (s.links || []).forEach(l => addLinkRow(l.label, l.url));
      document.getElementById('btn-delete').style.display = '';
      document.getElementById('overlay').classList.add('open');
    }

    function closeModal() {
      document.getElementById('overlay').classList.remove('open');
    }

    function closeIfOutside(e) {
      if (e.target === document.getElementById('overlay')) closeModal();
    }

    async function saveService() {
      const name  = document.getElementById('f-name').value.trim();
      const port  = parseInt(document.getElementById('f-port').value) || undefined;
      const color = colorHex.value || colorPicker.value;
      const desc  = document.getElementById('f-desc').value.trim();
      const stage = document.getElementById('f-stage').value;
      const urlOv = document.getElementById('f-url').value.trim();
      if (!name || (!port && !urlOv)) return alert('Name and port (or URL) are required.');
      const body = { name, port, color };
      if (desc)  body.description = desc;
      if (stage) body.stage = stage;
      if (urlOv) body.url = urlOv;
      const links = getLinkRows();
      if (links.length) body.links = links;
      const endpoint = editIndex === -1 ? '/services' : '/services/' + editIndex;
      const method   = editIndex === -1 ? 'POST' : 'PUT';
      await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      location.reload();
    }

    async function deleteService() {
      if (!confirm('Delete this service?')) return;
      await fetch('/services/' + editIndex, { method: 'DELETE' });
      location.reload();
    }

    async function updateStatus() {
      try {
        const data = await fetch('/status').then(r => r.json());
        document.querySelectorAll('.status-badge').forEach(badge => {
          const entry = data[badge.dataset.url];
          if (entry !== undefined) {
            badge.classList.toggle('up', entry.up);
            badge.classList.toggle('down', !entry.up);
            badge.textContent = entry.up ? 'Online' : 'Offline';
          }
        });
      } catch(e) {}
    }
    updateStatus();
    setInterval(updateStatus, 60_000);
  </script>
</body>
</html>`;
}

function renderMonitorPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Monitor — Router</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; background: #0f0f13; color: #e8e8f0; font-family: system-ui, sans-serif; padding: 2rem 1rem; }
    nav { max-width: 1100px; margin: 0 auto 2rem; display: flex; align-items: center; gap: 1rem; }
    nav h1 { font-size: 1.4rem; font-weight: 500; letter-spacing: .1em; color: #888; margin-right: auto; }
    nav a { font-size: .75rem; color: #555; text-decoration: none; letter-spacing: .08em; padding: .35rem .75rem; border: 1px solid #22222e; border-radius: 6px; transition: color .15s, border-color .15s; }
    nav a:hover { color: #aaa; border-color: #3a3a50; }
    #last-refresh { font-size: .65rem; color: #333; }
    .container { max-width: 1100px; margin: 0 auto; display: grid; gap: 1.2rem; }
    .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; }
    .panel { background: #13131b; border: 1px solid #22222e; border-radius: 10px; padding: 1.25rem 1.5rem; }
    .panel-title { font-size: .68rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #555; margin-bottom: 1rem; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .panel-header .panel-title { margin-bottom: 0; }
    .big-val { font-size: 1.8rem; font-weight: 600; }
    .big-unit { font-size: .85rem; color: #555; margin-left: .2rem; }
    .sub-text { font-size: .7rem; color: #555; margin-top: .3rem; }
    .metric-row { display: flex; align-items: center; gap: .75rem; margin-bottom: .6rem; }
    .metric-label { font-size: .72rem; color: #666; width: 80px; flex-shrink: 0; }
    .bar-wrap { flex: 1; height: 8px; background: #1e1e2a; border-radius: 4px; overflow: hidden; }
    .bar { height: 100%; border-radius: 4px; transition: width .6s ease; }
    .bar-blue   { background: #3a6fff; }
    .bar-green  { background: #4acf5e; }
    .bar-orange { background: #ff9f43; }
    .bar-red    { background: #f44336; }
    .bar-purple { background: #9b59b6; }
    .metric-val { font-size: .72rem; color: #888; width: 120px; text-align: right; flex-shrink: 0; }
    .badge { display: inline-block; font-size: .6rem; padding: .15rem .5rem; border-radius: 20px; background: rgba(74,207,94,.08); color: #4acf5e; border: 1px solid rgba(74,207,94,.2); }
    .badge-warn  { background: rgba(255,159,67,.08); color: #ff9f43; border-color: rgba(255,159,67,.2); }
    .badge-alert { background: rgba(244,67,54,.08); color: #f44336; border-color: rgba(244,67,54,.2); }
    table { width: 100%; border-collapse: collapse; }
    th { font-size: .65rem; letter-spacing: .1em; text-transform: uppercase; color: #555; text-align: left; padding: .4rem 0; border-bottom: 1px solid #1e1e2a; }
    td { font-size: .75rem; color: #999; padding: .4rem 0; border-bottom: 1px solid #18181f; font-family: monospace; }
    .no-data { font-size: .75rem; color: #444; padding: .8rem 0; }
    .net-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1rem; }
    .net-card { background: #0f0f13; border: 1px solid #1e1e2a; border-radius: 8px; padding: .85rem 1rem; }
    .net-iface { font-size: .7rem; color: #555; font-family: monospace; margin-bottom: .6rem; }
    .net-row { display: flex; justify-content: space-between; margin-bottom: .3rem; }
    .net-lbl { font-size: .65rem; color: #555; }
    .net-val { font-size: .85rem; font-weight: 600; font-family: monospace; }
    .rx-color { color: #4acf5e; }
    .tx-color { color: #3a6fff; }
    .scan-btn { background: #1e1e2a; border: 1px solid #2a2a38; color: #aaa; border-radius: 6px; padding: .3rem .8rem; cursor: pointer; font-size: .75rem; transition: background .15s, color .15s; }
    .scan-btn:hover:not(:disabled) { background: #2a2a38; color: #fff; }
    .scan-btn:disabled { opacity: .4; cursor: default; }
    .td-ip { color: #ff9f43; }
    .td-port { color: #3a6fff; }
    .td-count { color: #f44336; font-weight: 700; }
    .td-name { color: #e8e8f0; }
    @media (max-width: 680px) { .row-2 { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <nav>
    <h1>MONITOR</h1>
    <a href="/">Router</a>
    <span id="last-refresh"></span>
  </nav>

  <div class="container">

    <!-- CPU + RAM -->
    <div class="row-2">
      <div class="panel">
        <div class="panel-title">CPU</div>
        <div class="big-val" id="cpu-val">—<span class="big-unit">%</span></div>
        <div class="sub-text" id="cpu-sub"></div>
        <div style="margin-top:1rem;height:12px" class="bar-wrap">
          <div class="bar bar-blue" id="cpu-bar" style="width:0%"></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">Memory</div>
        <div class="big-val" id="ram-val">—<span class="big-unit">used</span></div>
        <div class="sub-text" id="ram-sub"></div>
        <div style="margin-top:1rem">
          <div class="metric-row">
            <div class="metric-label">Used</div>
            <div class="bar-wrap"><div class="bar bar-blue" id="ram-used-bar" style="width:0%"></div></div>
            <div class="metric-val" id="ram-used-val"></div>
          </div>
          <div class="metric-row">
            <div class="metric-label">Cache/buf</div>
            <div class="bar-wrap"><div class="bar bar-purple" id="ram-cache-bar" style="width:0%"></div></div>
            <div class="metric-val" id="ram-cache-val"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Disks -->
    <div class="row-2">
      <div class="panel">
        <div class="panel-title">System Disk</div>
        <div class="metric-row">
          <div class="metric-label">Used</div>
          <div class="bar-wrap"><div class="bar bar-blue" id="disk-sys-bar" style="width:0%"></div></div>
          <div class="metric-val" id="disk-sys-val"></div>
        </div>
        <div class="sub-text" id="disk-sys-sub"></div>
      </div>

      <div class="panel">
        <div class="panel-title">Plex Drive (/mnt/plex)</div>
        <div class="metric-row">
          <div class="metric-label">Used</div>
          <div class="bar-wrap"><div class="bar bar-orange" id="disk-plex-bar" style="width:0%"></div></div>
          <div class="metric-val" id="disk-plex-val"></div>
        </div>
        <div class="sub-text" id="disk-plex-sub"></div>
      </div>
    </div>

    <!-- Network -->
    <div class="panel">
      <div class="panel-title">Network I/O</div>
      <div class="net-cards" id="net-cards"><div class="no-data">Loading...</div></div>
    </div>

    <!-- Plex library breakdown -->
    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Plex Library Breakdown</div>
          <div style="font-size:.65rem;color:#444" id="plex-ts">Not scanned — click Scan to calculate folder sizes</div>
        </div>
        <button class="scan-btn" id="plex-btn" onclick="startPlexScan()">Scan</button>
      </div>
      <div id="plex-content"></div>
    </div>

    <!-- External connections -->
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">Active External Connections</div>
        <span class="badge" id="conn-badge">0</span>
      </div>
      <table>
        <thead><tr><th>Remote IP</th><th>Remote Port</th><th>Local Port</th></tr></thead>
        <tbody id="conn-tbody"><tr><td colspan="3" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>

    <!-- Security -->
    <div class="row-2">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">Top Attacking IPs</div>
          <span class="badge badge-alert" id="atk-badge">0 IPs</span>
        </div>
        <table>
          <thead><tr><th>IP Address</th><th>Attempts</th></tr></thead>
          <tbody id="atk-tbody"><tr><td colspan="2" class="no-data">Loading...</td></tr></tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-title">Recent Auth Failures</div>
        <div id="auth-recent" style="font-family:monospace;font-size:.62rem;color:#555;line-height:1.9;word-break:break-all">
          Loading...
        </div>
      </div>
    </div>

  </div>

  <script>
    function fb(b) {
      if (b == null || b < 0) return '—';
      if (b >= 1e12) return (b/1e12).toFixed(2) + ' TB';
      if (b >= 1e9)  return (b/1e9).toFixed(2)  + ' GB';
      if (b >= 1e6)  return (b/1e6).toFixed(2)  + ' MB';
      return (b/1e3).toFixed(0) + ' KB';
    }
    function fr(b) {
      if (b >= 1e6) return (b/1e6).toFixed(1) + ' MB/s';
      if (b >= 1e3) return (b/1e3).toFixed(0) + ' KB/s';
      return b + ' B/s';
    }
    function pct(u, t) { return t > 0 ? Math.min(100, Math.round(u/t*100)) : 0; }
    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function barClass(p) { return p > 85 ? 'bar-red' : p > 65 ? 'bar-orange' : 'bar-blue'; }

    async function refresh() {
      try {
        const d = await fetch('/api/metrics').then(r => r.json());

        // CPU
        const cp = d.cpu ?? 0;
        document.getElementById('cpu-val').innerHTML = cp + '<span class="big-unit">%</span>';
        document.getElementById('cpu-sub').textContent = d.cpuCores ? d.cpuCores + ' logical cores' : '';
        const cb = document.getElementById('cpu-bar');
        cb.style.width = cp + '%';
        cb.className = 'bar ' + barClass(cp);

        // RAM
        if (d.ram) {
          const up = pct(d.ram.used, d.ram.total);
          const cp2 = pct(d.ram.cached, d.ram.total);
          document.getElementById('ram-val').innerHTML = fb(d.ram.used) + '<span class="big-unit"> used</span>';
          document.getElementById('ram-sub').textContent = fb(d.ram.available) + ' available of ' + fb(d.ram.total);
          document.getElementById('ram-used-bar').style.width = up + '%';
          document.getElementById('ram-used-val').textContent = fb(d.ram.used) + ' (' + up + '%)';
          document.getElementById('ram-cache-bar').style.width = cp2 + '%';
          document.getElementById('ram-cache-val').textContent = fb(d.ram.cached);
        }

        // Disks
        if (d.disk.system) {
          const ds = d.disk.system;
          const p = pct(ds.used, ds.total);
          document.getElementById('disk-sys-bar').style.width = p + '%';
          document.getElementById('disk-sys-bar').className = 'bar ' + barClass(p);
          document.getElementById('disk-sys-val').textContent = fb(ds.used) + ' (' + p + '%)';
          document.getElementById('disk-sys-sub').textContent = fb(ds.free) + ' free of ' + fb(ds.total);
        }
        if (d.disk.plex) {
          const dp = d.disk.plex;
          const p = pct(dp.used, dp.total);
          document.getElementById('disk-plex-bar').style.width = p + '%';
          document.getElementById('disk-plex-bar').className = 'bar ' + barClass(p);
          document.getElementById('disk-plex-val').textContent = fb(dp.used) + ' (' + p + '%)';
          document.getElementById('disk-plex-sub').textContent = fb(dp.free) + ' free of ' + fb(dp.total);
        }

        // Network
        const nc = document.getElementById('net-cards');
        const ifaces = Object.entries(d.network || {});
        if (ifaces.length > 0) {
          nc.innerHTML = ifaces.map(([name, s]) =>
            \`<div class="net-card">
              <div class="net-iface">\${name}</div>
              <div class="net-row"><span class="net-lbl">Down</span><span class="net-val rx-color">\${fr(s.rxRate)}</span></div>
              <div class="net-row"><span class="net-lbl">Up</span><span class="net-val tx-color">\${fr(s.txRate)}</span></div>
              <div class="net-row" style="margin-top:.4rem"><span class="net-lbl" style="font-size:.6rem">Total RX</span><span style="font-size:.65rem;color:#444">\${fb(s.rxTotal)}</span></div>
              <div class="net-row"><span class="net-lbl" style="font-size:.6rem">Total TX</span><span style="font-size:.65rem;color:#444">\${fb(s.txTotal)}</span></div>
            </div>\`
          ).join('');
        } else {
          nc.innerHTML = '<div class="no-data">No interfaces detected yet (refreshes in 5s)</div>';
        }

        // Plex folders
        if (d.plex.folders) {
          const entries = Object.entries(d.plex.folders).sort((a, b) => b[1] - a[1]);
          const total = entries.reduce((s, [, v]) => s + Math.max(0, v), 0);
          document.getElementById('plex-content').innerHTML =
            \`<table>
              <thead><tr><th>Folder</th><th>Size</th><th style="width:160px">Share</th></tr></thead>
              <tbody>\${entries.map(([name, bytes]) => {
                const p = total > 0 && bytes > 0 ? Math.round(bytes/total*100) : 0;
                return \`<tr>
                  <td class="td-name">\${esc(name)}</td>
                  <td>\${fb(bytes)}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:.5rem">
                      <div class="bar-wrap" style="flex:1"><div class="bar bar-orange" style="width:\${p}%"></div></div>
                      <span style="font-size:.65rem;color:#555;width:28px;text-align:right">\${p}%</span>
                    </div>
                  </td>
                </tr>\`;
              }).join('')}</tbody>
            </table>\`;
          const age = Math.round((Date.now() - d.plex.lastUpdated) / 60000);
          document.getElementById('plex-ts').textContent = age < 1 ? 'Updated just now' : 'Updated ' + age + 'm ago';
        }
        if (!d.plex.scanning) {
          const btn = document.getElementById('plex-btn');
          btn.disabled = false;
          btn.textContent = 'Scan';
        }

        // Connections
        const conns = d.connections || [];
        const cb2 = document.getElementById('conn-badge');
        cb2.textContent = conns.length;
        cb2.className = 'badge' + (conns.length > 15 ? ' badge-alert' : conns.length > 5 ? ' badge-warn' : '');
        document.getElementById('conn-tbody').innerHTML = conns.length
          ? conns.slice(0, 40).map(c =>
              \`<tr><td class="td-ip">\${c.remIp}</td><td class="td-port">\${c.remPort}</td><td class="td-port">\${c.localPort}</td></tr>\`
            ).join('')
          : '<tr><td colspan="3" class="no-data">No external connections detected</td></tr>';

        // Auth failures
        const af = d.authFailures || { topIps: [], recent: [] };
        document.getElementById('atk-badge').textContent = af.topIps.length + ' IPs';
        document.getElementById('atk-tbody').innerHTML = af.topIps.length
          ? af.topIps.map(({ ip, count }) =>
              \`<tr><td class="td-ip">\${ip}</td><td class="td-count">\${count}</td></tr>\`
            ).join('')
          : '<tr><td colspan="2" class="no-data">No failures in log (or auth.log not mounted)</td></tr>';
        document.getElementById('auth-recent').innerHTML = af.recent.length
          ? af.recent.map(l => \`<div style="margin-bottom:.25rem">\${esc(l)}</div>\`).join('')
          : '<div class="no-data">No recent auth failures</div>';

        document.getElementById('last-refresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch(e) { console.error(e); }
    }

    async function startPlexScan() {
      const btn = document.getElementById('plex-btn');
      btn.disabled = true;
      btn.textContent = 'Scanning...';
      document.getElementById('plex-ts').textContent = 'Scanning… this may take a while for large libraries';
      await fetch('/api/plex-scan', { method: 'POST' });
    }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  // GET /
  if ((req.url === '/' || req.url === '') && req.method === 'GET') {
    const services = loadServices();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage(services));
    return;
  }

  // GET /monitor — monitoring page
  if (req.url === '/monitor' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderMonitorPage());
    return;
  }

  // GET /api/metrics — live metrics JSON
  if (req.url === '/api/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cpu:          cpuUsage,
      cpuCores:     cpuCores,
      ram:          mon.ram,
      disk:         mon.disk,
      network:      netRates,
      connections:  mon.connections,
      authFailures: mon.authFailures,
      plex: {
        folders:     plexCache.folders,
        lastUpdated: plexCache.lastUpdated,
        scanning:    plexCache.scanning,
      },
    }));
    return;
  }

  // POST /api/plex-scan — trigger background plex folder scan
  if (req.url === '/api/plex-scan' && req.method === 'POST') {
    triggerPlexScan();
    res.writeHead(202); res.end('scanning');
    return;
  }

  // GET /status — service health
  if (req.url === '/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusCache));
    return;
  }

  // POST /services — add
  if (req.url === '/services' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const s = JSON.parse(body);
      const services = loadServices();
      services.push(s);
      saveServices(services);
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  // PUT /services/:index — edit
  const putMatch = req.url.match(/^\/services\/(\d+)$/) ;
  if (putMatch && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const i = parseInt(putMatch[1]);
      const s = JSON.parse(body);
      const services = loadServices();
      if (i >= 0 && i < services.length) services[i] = s;
      saveServices(services);
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  // DELETE /services/:index
  const delMatch = req.url.match(/^\/services\/(\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    const i = parseInt(delMatch[1]);
    const services = loadServices();
    if (i >= 0 && i < services.length) services.splice(i, 1);
    saveServices(services);
    res.writeHead(200); res.end('ok');
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Router running on http://0.0.0.0:${PORT}`));
