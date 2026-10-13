const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { services: [], metrics: null, filter: 'all', query: '', ctrQuery: '', editIndex: -1 };

// ---------- Formatting ----------
function bytes(n, digits = 1) {
  if (n == null || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}
const rate = (n) => `${bytes(n)}/s`;
function duration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
const since = (iso) => duration(Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000));
const initials = (name) => name.split(/\s+|(?=[A-Z][a-z])/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

// ---------- SVG helpers ----------
function sparkPath(series, w, h, max) {
  if (!series.length) return { line: '', area: '' };
  const top = max || Math.max(...series, 1);
  const step = w / Math.max(series.length - 1, 1);
  const pts = series.map((v, i) => [i * step, h - (Math.min(v, top) / top) * (h - 2) - 1]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return { line, area: `${line}L${w},${h}L0,${h}Z` };
}

function drawSpark(svg, layers) {
  const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
  svg.innerHTML = layers.map(({ series, color, max, id }) => {
    const { line, area } = sparkPath(series, w, h, max);
    return `<defs><linearGradient id="g-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#g-${id})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  }).join('');
}

function levelColor(pct) {
  const css = getComputedStyle(document.documentElement);
  if (pct >= 92) return css.getPropertyValue('--bad').trim();
  if (pct >= 80) return css.getPropertyValue('--warn').trim();
  return css.getPropertyValue('--accent').trim();
}

function drawGauge(el, title, disk) {
  if (!disk) { el.innerHTML = `<div class="label">${title}</div><div class="dim">unavailable</div>`; return; }
  const pct = (disk.used / disk.total) * 100;
  const r = 40, c = 2 * Math.PI * r;
  const color = levelColor(pct);
  el.innerHTML = `
    <svg class="gauge" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--line-strong)" stroke-width="9"/>
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
        stroke-dasharray="${(pct / 100) * c} ${c}" transform="rotate(-90 50 50)" style="filter:drop-shadow(0 0 6px ${color})"/>
      <text x="50" y="55" text-anchor="middle" font-family="JetBrains Mono" font-size="17" font-weight="600" fill="var(--ink)">${Math.round(pct)}%</text>
    </svg>
    <div class="gauge-info">
      <div class="label">${title}</div>
      <div class="big mono">${bytes(disk.available, 0)}<small>free</small></div>
      <div class="sub mono">${bytes(disk.used, 0)} of ${bytes(disk.total, 0)}</div>
    </div>`;
}

// ---------- Services ----------
function containersFor(svc) {
  const list = state.metrics?.containers || [];
  return svc.port ? list.filter((c) => c.ports.includes(svc.port)) : [];
}

function renderServices() {
  const grid = $('#svc-grid');
  const q = state.query.toLowerCase();
  const list = state.services.filter((s) => {
    const up = s.status?.up;
    if (state.filter === 'up' && !up) return false;
    if (state.filter === 'down' && up !== false) return false;
    return !q || `${s.name} ${s.description || ''} ${s.stage || ''} ${s.port || ''}`.toLowerCase().includes(q);
  });

  const upCount = state.services.filter((s) => s.status?.up).length;
  const health = $('#health');
  health.textContent = `${upCount} / ${state.services.length} up`;
  health.className = `health ${upCount === state.services.length ? 'ok' : 'bad'}`;

  if (!list.length) {
    grid.innerHTML = `<div class="empty">No services match.</div>`;
    return;
  }

  grid.innerHTML = list.map((s, i) => {
    const st = s.status;
    const cls = st ? (st.up ? 'up' : 'down') : '';
    const statusText = !st ? 'checking…' : st.up ? `${st.latency ?? '—'} ms` : 'unreachable';
    const ctrs = containersFor(s);
    const mem = ctrs.reduce((sum, c) => sum + (c.memory || 0), 0);
    const ctrText = ctrs.length ? `${ctrs.length} container${ctrs.length > 1 ? 's' : ''} · ${bytes(mem, 0)}` : '';
    const where = s.url ? new URL(s.url).host : `:${s.port}`;
    return `
      <a class="svc ${cls}" href="${esc(s.href)}" target="_blank" rel="noopener" style="--c:${esc(s.color || '#22d3ee')};animation-delay:${i * 25}ms">
        <div class="svc-top">
          <div class="avatar">${esc(initials(s.name))}</div>
          <div class="svc-meta">
            <div class="svc-name">${esc(s.name)} ${s.stage ? `<span class="stage ${esc(s.stage)}">${esc(s.stage)}</span>` : ''}</div>
            <div class="svc-desc">${esc(s.description || where)}</div>
          </div>
        </div>
        <div class="svc-status">
          <span class="status-line"><span class="dot ${cls}"></span><span class="mono">${statusText}</span></span>
          <span class="mono dim">${esc(ctrText || where)}</span>
        </div>
        ${(s.links || []).length ? `<div class="svc-links">${s.links.map((l) => `<span class="chip" data-href="${esc(l.url)}">${esc(l.label)}</span>`).join('')}</div>` : ''}
        <button class="svc-edit" data-edit="${s.index}" aria-label="Edit ${esc(s.name)}" title="Edit">⋯</button>
      </a>`;
  }).join('');
}

$('#svc-grid').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  const link = e.target.closest('[data-href]');
  if (edit) { e.preventDefault(); openModal(Number(edit.dataset.edit)); }
  else if (link) { e.preventDefault(); window.open(link.dataset.href, '_blank', 'noopener'); }
});

// ---------- Metrics ----------
function renderVitals(m) {
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim();
  const accent2 = css.getPropertyValue('--accent-2').trim();

  $('#cpu-val').textContent = m.cpu.toFixed(1);
  $('#cpu-cores').textContent = `${m.host.cores || m.cpuCores} cores`;
  $('#cpu-foot').textContent = `load ${m.host.load.map((l) => l.toFixed(2)).join(' · ')}`;
  drawSpark($('#cpu-spark'), [{ series: m.history.cpu, color: accent, max: 100, id: 'cpu' }]);

  if (m.ram) {
    $('#ram-val').textContent = (m.ram.used / 1024 ** 3).toFixed(1);
    $('#ram-total').textContent = `of ${bytes(m.ram.total, 0)}`;
    $('#ram-foot').textContent = m.ram.swapTotal ? `swap ${bytes(m.ram.swapUsed)} / ${bytes(m.ram.swapTotal, 0)}` : '';
    drawSpark($('#ram-spark'), [{ series: m.history.ram, color: accent2, max: 100, id: 'ram' }]);
  }

  drawGauge($('#disk-sys'), 'System disk', m.disk.system);
  drawGauge($('#disk-plex'), 'Media drive', m.disk.plex);

  $('#host-name').textContent = m.host.name || 'server';
  $('#host-sub').textContent = `up ${duration(m.host.uptime)} · ${m.containers.filter((c) => c.running).length} containers running`;
  document.title = `${m.host.name || 'Router'} · Router`;

  // Network
  const peak = Math.max(...m.history.rx, ...m.history.tx, 1024);
  drawSpark($('#net-spark'), [
    { series: m.history.rx, color: accent, max: peak, id: 'rx' },
    { series: m.history.tx, color: accent2, max: peak, id: 'tx' },
  ]);
  const ifaces = Object.entries(m.network);
  $('#ifaces').innerHTML = `<div class="label">Interfaces</div>` + (ifaces.length
    ? ifaces.map(([name, r]) => `
      <div class="iface">
        <span class="iface-name mono">${esc(name)}</span>
        <span class="iface-rate rx mono">↓ ${rate(r.rxRate)}</span>
        <span class="iface-rate tx mono">↑ ${rate(r.txRate)}</span>
        <span class="iface-total mono">${bytes(r.rxTotal)} received · ${bytes(r.txTotal)} sent since boot</span>
      </div>`).join('')
    : `<div class="muted-empty">Waiting for samples…</div>`);
  const last = (a) => a[a.length - 1] || 0;
  $('#net-total').textContent = `↓ ${rate(last(m.history.rx))}  ↑ ${rate(last(m.history.tx))}`;
}

function renderContainers(m) {
  const q = state.ctrQuery.toLowerCase();
  const list = m.containers.filter((c) => !q || `${c.name} ${c.image} ${c.project || ''}`.toLowerCase().includes(q));
  const running = m.containers.filter((c) => c.running);
  const totalMem = running.reduce((s, c) => s + (c.memory || 0), 0);
  $('#ctr-summary').textContent = `${running.length}/${m.containers.length} running · ${bytes(totalMem)}`;
  const maxMem = Math.max(...m.containers.map((c) => c.memory || 0), 1);

  const head = `<div class="th">Container</div><div class="th col-img">Image</div><div class="th">CPU</div><div class="th">Memory</div><div class="th col-up">Up</div>`;
  $('#ctr-table').innerHTML = head + list.map((c) => {
    return `
      <div><span class="dot ${c.running ? 'up' : 'down'}"></span><span style="min-width:0"><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.project || '—')}${c.ports.length ? ' · :' + c.ports.join(' :') : ''}</div></span></div>
      <div class="col-img sub mono">${esc(c.image.replace(/^.*\//, ''))}</div>
      <div class="mono">${c.cpu == null ? '—' : c.cpu.toFixed(1) + '%'}</div>
      <div><span class="mem"><span class="mem-bar"><span style="width:${((c.memory || 0) / maxMem) * 100}%"></span></span><span class="mono sub" style="width:64px;text-align:right">${c.memory ? bytes(c.memory, 0) : '—'}</span></span></div>
      <div class="col-up mono sub">${c.running ? since(c.startedAt) : 'stopped'}</div>`;
  }).join('');
}

function renderSecurity(m) {
  $('#conn-count').textContent = m.connections.length;
  $('#conn-list').innerHTML = m.connections.length
    ? m.connections.slice(0, 50).map((c) => `<div class="row mono"><span class="dot up"></span><span class="grow">${esc(c.remIp)}:${c.remPort}</span><span class="dim">→ :${c.localPort}</span></div>`).join('')
    : `<div class="muted-empty">No external connections right now.</div>`;

  const top = m.authFailures.topIps;
  $('#auth-count').textContent = top.reduce((s, x) => s + x.count, 0);
  const max = Math.max(...top.map((x) => x.count), 1);
  $('#auth-list').innerHTML = top.length
    ? top.map((x) => `<div class="row mono"><span style="width:120px">${esc(x.ip)}</span><span class="bar"><span style="width:${(x.count / max) * 100}%;background:var(--warn)"></span></span><span class="dim" style="width:40px;text-align:right">${x.count}</span></div>`).join('')
    : `<div class="muted-empty">No failed logins in the recent auth log. 🎉</div>`;
}

const MEDIA_COLORS = ['var(--accent)', 'var(--accent-2)', '#f472b6', '#fbbf24', '#34d399', '#60a5fa', '#fb923c'];
function renderMedia(m) {
  const btn = $('#plex-btn');
  btn.disabled = m.plex.scanning;
  btn.textContent = m.plex.scanning ? 'Scanning…' : 'Scan sizes';
  $('#plex-ts').textContent = m.plex.lastUpdated ? `scanned ${since(new Date(m.plex.lastUpdated).toISOString())} ago` : '';
  const disk = m.disk.plex;
  const folders = Object.entries(m.plex.folders || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!folders.length) {
    $('#plex').innerHTML = `<div class="muted-empty">${m.plex.scanning ? 'Measuring folders — big libraries take a minute…' : 'Hit “Scan sizes” to break down what is using the media drive.'}</div>`;
    return;
  }
  const total = disk ? disk.total : folders.reduce((s, [, v]) => s + v, 0);
  $('#plex').innerHTML = `
    <div class="stack">${folders.map(([, v], i) => `<span style="width:${(v / total) * 100}%;background:${MEDIA_COLORS[i % MEDIA_COLORS.length]}"></span>`).join('')}</div>
    ${folders.map(([name, v], i) => `
      <div class="row media-row"><span class="sw" style="background:${MEDIA_COLORS[i % MEDIA_COLORS.length]}"></span>
        <span class="grow">${esc(name)}</span><span class="mono">${bytes(v)}</span><span class="mono dim" style="width:52px;text-align:right">${((v / total) * 100).toFixed(1)}%</span></div>`).join('')}
    ${disk ? `<div class="row media-row"><span class="sw" style="background:var(--line-strong)"></span><span class="grow dim">Free</span><span class="mono">${bytes(disk.available)}</span><span class="mono dim" style="width:52px;text-align:right">${((disk.available / total) * 100).toFixed(1)}%</span></div>` : ''}`;
}

$('#plex-btn').addEventListener('click', async () => {
  $('#plex-btn').disabled = true;
  await fetch('/api/plex-scan', { method: 'POST' });
  loadMetrics();
});

// ---------- Data loading ----------
async function loadServices() {
  try {
    state.services = await (await fetch('/api/services')).json();
    renderServices();
  } catch { /* keep the last good render; the next poll retries */ }
}

async function loadMetrics() {
  try {
    const m = await (await fetch('/api/metrics')).json();
    state.metrics = m;
    $('#host-dot').style.background = '';
    renderVitals(m);
    renderContainers(m);
    renderSecurity(m);
    renderMedia(m);
    renderServices();
  } catch {
    $('#host-sub').textContent = 'connection lost — retrying…';
    $('#host-dot').style.background = 'var(--bad)';
  }
}

// ---------- Controls ----------
$('#svc-search').addEventListener('input', (e) => { state.query = e.target.value; renderServices(); });
$('#ctr-search').addEventListener('input', (e) => { state.ctrQuery = e.target.value; if (state.metrics) renderContainers(state.metrics); });
$('#svc-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.filter = b.dataset.f;
  document.querySelectorAll('#svc-filter button').forEach((x) => x.classList.toggle('on', x === b));
  renderServices();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    $('#svc-search').focus();
  }
});

$('#theme-btn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('router-theme', next); } catch { /* not persisted in private mode */ }
  if (state.metrics) renderVitals(state.metrics);
});

function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Highlight the tab for the section currently in view.
const tabLinks = [...document.querySelectorAll('#tabs a')];
const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (en.isIntersecting) tabLinks.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${en.target.id}`));
  });
}, { rootMargin: '-40% 0px -55% 0px' });
document.querySelectorAll('main .section').forEach((s) => sectionObserver.observe(s));

// ---------- Service modal ----------
const modal = $('#modal');
const form = $('#svc-form');

function addLinkRow(label = '', url = '') {
  const row = document.createElement('div');
  row.className = 'link-row';
  row.innerHTML = `<input placeholder="Label" value="${esc(label)}"><input placeholder="https://…" value="${esc(url)}"><button type="button" aria-label="Remove link">×</button>`;
  row.querySelector('button').onclick = () => row.remove();
  $('#link-rows').appendChild(row);
}

function openModal(index = -1) {
  state.editIndex = index;
  const s = index >= 0 ? state.services.find((x) => x.index === index) : {};
  $('#modal-title').textContent = index >= 0 ? `Edit ${s.name}` : 'Add service';
  form.name.value = s.name || '';
  form.description.value = s.description || '';
  form.stage.value = s.stage || '';
  form.port.value = s.port || '';
  form.url.value = s.url || '';
  form.color.value = s.color || '#22d3ee';
  form.colorHex.value = s.color || '#22d3ee';
  $('#link-rows').innerHTML = '';
  (s.links || []).forEach((l) => addLinkRow(l.label, l.url));
  $('#del-btn').style.display = index >= 0 ? '' : 'none';
  $('#form-error').textContent = '';
  modal.showModal();
}

form.color.addEventListener('input', () => { form.colorHex.value = form.color.value; });
form.colorHex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(form.colorHex.value)) form.color.value = form.colorHex.value; });
$('#add-btn').addEventListener('click', () => openModal(-1));
$('#add-link').addEventListener('click', () => addLinkRow());
$('#cancel-btn').addEventListener('click', () => modal.close());
modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: form.name.value,
    description: form.description.value,
    stage: form.stage.value,
    port: form.port.value ? Number(form.port.value) : undefined,
    url: form.url.value || undefined,
    color: form.colorHex.value || form.color.value,
    links: [...document.querySelectorAll('.link-row')].map((r) => {
      const [l, u] = r.querySelectorAll('input');
      return { label: l.value.trim(), url: u.value.trim() };
    }).filter((l) => l.label && l.url),
  };
  const editing = state.editIndex >= 0;
  const res = await fetch(editing ? `/services/${state.editIndex}` : '/services', {
    method: editing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    $('#form-error').textContent = (await res.json().catch(() => ({}))).error || 'Could not save';
    return;
  }
  modal.close();
  setTimeout(loadServices, 600);
  loadServices();
});

$('#del-btn').addEventListener('click', async () => {
  if (!confirm('Remove this service from the dashboard?')) return;
  await fetch(`/services/${state.editIndex}`, { method: 'DELETE' });
  modal.close();
  loadServices();
});

// ---------- Boot ----------
tickClock();
setInterval(tickClock, 15_000);
loadServices();
loadMetrics();
setInterval(loadMetrics, 5_000);
setInterval(loadServices, 15_000);
