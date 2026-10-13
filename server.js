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
const PUBLIC_DIR   = path.join(__dirname, 'public');

// The host filesystem is mounted read-only at /host; PID 1's view of /proc is the host's.
const HOST_ROOT = fs.existsSync('/host/proc/1') ? '/host' : '';
const HOST_NET  = HOST_ROOT ? '/host/proc/1/net' : '/proc/net';

function loadServices() {
  try {
    return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to read services.json:', e.message);
    return [];
  }
}

function saveServices(services) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(services, null, 2) + '\n');
}

const serviceUrl = s => s.url || `http://${HOST}:${s.port}`;

// Status cache: { [url]: { up: bool, latency: ms, lastChecked: timestamp } }
const statusCache = {};

function pingUrl(url) {
  const mod = url.startsWith('https') ? https : http;
  const started = Date.now();
  let resolved = false;
  const done = up => {
    if (resolved) return;
    resolved = true;
    statusCache[url] = { up, latency: up ? Date.now() - started : null, lastChecked: Date.now() };
  };
  const req = mod.get(url, { timeout: 5000 }, res => {
    done(res.statusCode < 500);
    req.destroy();
  });
  req.on('error', () => done(false));
  req.on('timeout', () => { done(false); req.destroy(); });
}

function pingAllServices() {
  loadServices().forEach(s => pingUrl(serviceUrl(s)));
}

pingAllServices();
setInterval(pingAllServices, 30_000);

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
  containers: [],
  host: { name: '', uptime: 0, load: [0, 0, 0] },
};
const plexCache = { folders: null, lastUpdated: 0, scanning: false };

// Rolling history for sparklines: 120 samples × 5s = 10 minutes.
const HISTORY_LEN = 120;
const history = { cpu: [], ram: [], rx: [], tx: [] };
function pushHistory(key, value) {
  history[key].push(value);
  if (history[key].length > HISTORY_LEN) history[key].shift();
}

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

// Docker bridges and veth pairs just mirror container traffic; only show real interfaces.
const isVirtualIface = name => name === 'lo' || /^(veth|br-|docker)/.test(name);

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
    const raw = await fs.promises.readFile(`${HOST_NET}/dev`, 'utf8');
    const now = Date.now();
    const cur = {};
    raw.split('\n').slice(2).forEach(line => {
      const m = line.trim().match(/^(\S+):\s+(\d+)(?:\s+\d+){7}\s+(\d+)/);
      if (m && !isVirtualIface(m[1])) cur[m[1]] = { rx: +m[2], tx: +m[3] };
    });
    if (netPrev) {
      const dt = (now - netPrev.ts) / 1000 || 1;
      netRates = {};
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
      swapTotal: m.SwapTotal || 0,
      swapUsed:  (m.SwapTotal || 0) - (m.SwapFree || 0),
    };
  } catch {}
}

async function sampleHost() {
  try {
    const [uptime, load, name] = await Promise.all([
      fs.promises.readFile('/proc/uptime', 'utf8'),
      fs.promises.readFile('/proc/loadavg', 'utf8'),
      fs.promises.readFile(`${HOST_ROOT}/etc/hostname`, 'utf8').catch(() => 'server'),
    ]);
    mon.host = {
      name:   name.trim(),
      uptime: Math.round(parseFloat(uptime)),
      load:   load.split(' ').slice(0, 3).map(Number),
    };
  } catch {}
}

async function sampleDisk() {
  const paths = [
    { key: 'system', path: HOST_ROOT || '/' },
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
    const raw = await fs.promises.readFile(`${HOST_NET}/tcp`, 'utf8').catch(() => '');
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

// Containers are read straight from Docker's state files and cgroups (read-only),
// so the dashboard never needs the Docker socket.
const containerCpuPrev = {};
async function sampleContainers() {
  if (!HOST_ROOT) return;
  const root = '/host/var/lib/docker/containers';
  const ids = await fs.promises.readdir(root).catch(() => []);
  const now = Date.now();
  const list = await Promise.all(ids.map(async id => {
    try {
      const [cfg, hostCfg] = await Promise.all([
        fs.promises.readFile(`${root}/${id}/config.v2.json`, 'utf8').then(JSON.parse),
        fs.promises.readFile(`${root}/${id}/hostconfig.json`, 'utf8').then(JSON.parse).catch(() => ({})),
      ]);
      const cg = `/host/sys/fs/cgroup/system.slice/docker-${id}.scope`;
      let memory = null;
      let cpu = null;
      if (cfg.State.Running) {
        memory = parseInt(await fs.promises.readFile(`${cg}/memory.current`, 'utf8').catch(() => '')) || null;
        const stat = await fs.promises.readFile(`${cg}/cpu.stat`, 'utf8').catch(() => '');
        const usage = parseInt((stat.match(/usage_usec (\d+)/) || [])[1]);
        const prev = containerCpuPrev[id];
        if (prev && usage >= prev.usage) cpu = Math.round(((usage - prev.usage) / ((now - prev.ts) * 1000)) * 1000) / 10;
        if (usage) containerCpuPrev[id] = { usage, ts: now };
      }
      const ports = Object.values(hostCfg.PortBindings || {})
        .flat().map(b => parseInt(b && b.HostPort)).filter(Boolean);
      return {
        id:        id.slice(0, 12),
        name:      cfg.Name.replace(/^\//, ''),
        image:     cfg.Config.Image,
        project:   (cfg.Config.Labels || {})['com.docker.compose.project'] || null,
        running:   !!cfg.State.Running,
        startedAt: cfg.State.StartedAt,
        ports:     [...new Set(ports)],
        memory,
        cpu,
      };
    } catch {
      return null;
    }
  }));
  mon.containers = list.filter(Boolean).sort((a, b) => (b.memory || 0) - (a.memory || 0));
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
async function fastSample() {
  await Promise.all([sampleCpu(), sampleNetwork(), sampleRam(), sampleContainers()]);
  pushHistory('cpu', cpuUsage);
  if (mon.ram) pushHistory('ram', Math.round((mon.ram.used / mon.ram.total) * 1000) / 10);
  const rates = Object.values(netRates);
  pushHistory('rx', rates.reduce((s, r) => s + r.rxRate, 0));
  pushHistory('tx', rates.reduce((s, r) => s + r.txRate, 0));
}
fastSample();
setInterval(fastSample, 5_000);

const slowSample = () => Promise.all([sampleHost(), sampleDisk(), sampleConnections(), sampleAuthFailures()]);
slowSample();
setInterval(slowSample, 30_000);

// ============================================================
// HTTP
// ============================================================

const STATIC = {
  '/':           ['index.html', 'text/html; charset=utf-8'],
  '/app.js':     ['app.js',     'application/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const STAGES = ['', 'POC', 'MVP', 'PROD'];

// Accepts only the fields the dashboard knows about, so services.json stays clean.
function cleanService(s) {
  if (!s || typeof s.name !== 'string' || !s.name.trim()) return null;
  const port = parseInt(s.port);
  const url = typeof s.url === 'string' && /^https?:\/\//.test(s.url) ? s.url.trim() : undefined;
  if (!port && !url) return null;
  const out = { name: s.name.trim().slice(0, 40) };
  if (port) out.port = port;
  out.color = HEX_COLOR.test(s.color) ? s.color : '#4a9eff';
  if (typeof s.description === 'string' && s.description.trim()) out.description = s.description.trim().slice(0, 80);
  if (STAGES.includes(s.stage) && s.stage) out.stage = s.stage;
  if (url) out.url = url;
  const links = (Array.isArray(s.links) ? s.links : [])
    .filter(l => l && typeof l.label === 'string' && typeof l.url === 'string' && /^https?:\/\//.test(l.url))
    .map(l => ({ label: l.label.trim().slice(0, 24), url: l.url.trim() }));
  if (links.length) out.links = links;
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && STATIC[url]) {
    const [file, type] = STATIC[url];
    fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
      if (err) { res.writeHead(500); res.end('Missing ' + file); return; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // The old standalone monitor page now lives on the main dashboard.
  if (url === '/monitor' && req.method === 'GET') {
    res.writeHead(302, { Location: '/#system' });
    res.end();
    return;
  }

  // GET /api/services — services with live status
  if (url === '/api/services' && req.method === 'GET') {
    const services = loadServices().map((s, index) => ({ ...s, index, href: serviceUrl(s), status: statusCache[serviceUrl(s)] || null }));
    sendJson(res, 200, services);
    return;
  }

  // GET /api/metrics — live metrics JSON
  if (url === '/api/metrics' && req.method === 'GET') {
    sendJson(res, 200, {
      host:         { ...mon.host, cores: cpuCores },
      cpu:          cpuUsage,
      cpuCores:     cpuCores,
      ram:          mon.ram,
      disk:         mon.disk,
      network:      netRates,
      connections:  mon.connections,
      authFailures: mon.authFailures,
      containers:   mon.containers,
      history,
      plex: {
        folders:     plexCache.folders,
        lastUpdated: plexCache.lastUpdated,
        scanning:    plexCache.scanning,
      },
    });
    return;
  }

  // POST /api/plex-scan — trigger background plex folder scan
  if (url === '/api/plex-scan' && req.method === 'POST') {
    triggerPlexScan();
    res.writeHead(202); res.end('scanning');
    return;
  }

  // GET /status — service health
  if (url === '/status' && req.method === 'GET') {
    sendJson(res, 200, statusCache);
    return;
  }

  // POST /services — add; PUT /services/:index — edit
  const idxMatch = url.match(/^\/services\/(\d+)$/);
  if ((url === '/services' && req.method === 'POST') || (idxMatch && req.method === 'PUT')) {
    let s;
    try { s = cleanService(await readJson(req)); } catch { s = null; }
    if (!s) { sendJson(res, 400, { error: 'Name and a port or http(s) URL are required' }); return; }
    const services = loadServices();
    if (idxMatch) {
      const i = parseInt(idxMatch[1]);
      if (i < 0 || i >= services.length) { sendJson(res, 404, { error: 'No such service' }); return; }
      services[i] = s;
    } else {
      services.push(s);
    }
    saveServices(services);
    pingUrl(serviceUrl(s));
    sendJson(res, 200, { ok: true });
    return;
  }

  // DELETE /services/:index
  if (idxMatch && req.method === 'DELETE') {
    const i = parseInt(idxMatch[1]);
    const services = loadServices();
    if (i >= 0 && i < services.length) services.splice(i, 1);
    saveServices(services);
    sendJson(res, 200, { ok: true });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Router running on http://0.0.0.0:${PORT}`));
