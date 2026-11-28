// SkyLink UI: renders the /api/state snapshot. Live mode = SSE ("state" events); ?static=1 = one fetch, no SSE, no actions.
import { drawMap } from './map.js';
import { sparkline } from './charts.js';

const STATIC = new URLSearchParams(location.search).get('static') === '1';
const $ = (id) => document.getElementById(id);
const cards = new Map(); // droneId -> { el, r: refs }
const localErrors = []; // failed POSTs, merged into the events list
let last = null;

const ACTIONS = [
  ['takeoff', 'Take off'],
  ['mission', 'Mission'],
  ['rth', 'RTH', 'Return to home'],
  ['land', 'Land'],
];
const LOSS_CHOICES = [0, 5, 15, 30];
// [kind, label, short badge text]
const FAULTS = [
  ['battery_low', 'Battery low', 'BATT LOW'],
  ['battery_critical', 'Battery critical', 'BATT CRIT'],
  ['motor_failure', 'Motor failure', 'MOTOR'],
  ['geofence_breach', 'Geofence breach', 'GEOFENCE'],
  ['gps_degraded', 'GPS degraded', 'GPS'],
];
const FAULT_LABEL = Object.fromEntries(FAULTS.map(([k, l]) => [k, l]));
const FAULT_SHORT = Object.fromEntries(FAULTS.map(([k, , s]) => [k, s]));
const SEVERITY_CLASS = { info: 'sev-info', warning: 'sev-warning', critical: 'sev-critical' };
const UDP_COLOR = '#a78bfa';
const TCP_COLOR = '#3ad1ff';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, d = 1, unit = '') => (isNum(v) ? v.toFixed(d) + unit : '--');
const pad2 = (n) => String(n).padStart(2, '0');

function fmtUptime(s) {
  if (!isNum(s)) return '--';
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}h ${pad2(m)}m ${pad2(t % 60)}s` : `${pad2(m)}m ${pad2(t % 60)}s`;
}

function fmtTime(t) {
  if (!isNum(t)) return '--';
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const STATE_CLASS = {
  LANDED: 'st-idle',
  TAKEOFF: 'st-fly',
  HOVER: 'st-ok',
  GOTO: 'st-fly',
  MISSION: 'st-fly',
  RTH: 'st-warn',
  LANDING: 'st-warn',
};

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
function setClass(node, cls) {
  if (node.dataset.cls !== cls) {
    node.className = cls;
    node.dataset.cls = cls;
  }
}

// ---------- drone cards (built once per id, then updated in place) ----------

function buildCard(d) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = String(d.id);
  el.style.setProperty('--c', d.color || '#3ad1ff');
  el.innerHTML = `
    <header class="card-head">
      <span class="dot"></span>
      <h3>${esc(d.name)}</h3>
      <span class="model">${esc(d.model)}</span>
      <span class="badge" data-r="state">--</span>
      <span class="badge inc" data-r="inc" hidden></span>
    </header>
    <div class="batt">
      <span class="k">Battery</span>
      <div class="bar"><i data-r="battBar"></i></div>
      <span class="v mono" data-r="batt">--</span>
    </div>
    <div class="tiles">
      <div><span class="k">Alt</span><span class="v mono" data-r="alt">--</span></div>
      <div><span class="k">Speed</span><span class="v mono" data-r="speed">--</span></div>
      <div><span class="k">Heading</span><span class="v mono" data-r="hdg">--</span></div>
    </div>
    <dl class="net">
      <div><dt>TCP</dt><dd data-r="tcp"></dd></div>
      <div><dt>TCP RTT</dt><dd class="mono" data-r="tcpRtt">--</dd></div>
      <div><dt>UDP RTT</dt><dd class="mono" data-r="udpRtt">--</dd></div>
      <div><dt>Loss (recent)</dt><dd class="mono" data-r="loss">--</dd></div>
      <div><dt>Jitter</dt><dd class="mono" data-r="jitter">--</dd></div>
      <div><dt>Rate</dt><dd class="mono" data-r="pps">--</dd></div>
      <div><dt>Queued</dt><dd class="mono" data-r="queued">0</dd></div>
      <div><dt>Reconnects</dt><dd class="mono" data-r="reconn">0</dd></div>
    </dl>
    <div class="lastcmd"><span class="k">Last command</span><span class="mono" data-r="last">--</span></div>
    <div class="log">
      <div class="log-top"><span class="k">Flight log</span><span class="mono" data-r="logText">none</span></div>
      <div class="bar thin"><i data-r="logBar"></i></div>
    </div>
    <div class="charts">
      <canvas data-r="cAlt"></canvas>
      <canvas data-r="cLoss"></canvas>
      <canvas data-r="cRtt"></canvas>
    </div>
    <div class="actions">
      ${ACTIONS.map(([a, l, t]) => `<button type="button" data-act="${a}"${t ? ` title="${t}"` : ''}>${l}</button>`).join('')}
    </div>
    <div class="chaos">
      <label><span class="k">UDP loss</span>
        <select data-r="lossSel">${LOSS_CHOICES.map((p) => `<option value="${p}">${p} %</option>`).join('')}</select>
      </label>
      <select data-r="faultSel" aria-label="Inject fault"><option value="">Inject fault…</option>${FAULTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <button type="button" class="danger" data-chaos="cut_tcp">Cut TCP (RST)</button>
    </div>`;
  const r = {};
  el.querySelectorAll('[data-r]').forEach((n) => (r[n.dataset.r] = n));
  if (STATIC) el.querySelectorAll('button, select').forEach((n) => (n.disabled = true));
  return { el, r };
}

function updateCard(c, d) {
  const { r } = c;
  const t = d.telemetry;
  const tcp = d.tcp || {};
  const udp = d.udp || {};
  const h = d.history || {};

  // state badge
  let label = 'OFFLINE';
  let cls = 'badge st-off';
  if (t) {
    label = t.state || '--';
    cls = `badge ${STATE_CLASS[t.state] || 'st-idle'}`;
    if (isNum(t.ageMs) && t.ageMs > 2000) {
      label += ' (stale)';
      cls = 'badge st-warn';
    }
  }
  setText(r.state, label);
  setClass(r.state, cls);

  // latest incident badge
  if (d.incident) {
    r.inc.hidden = false;
    setText(r.inc, FAULT_SHORT[d.incident.kind] || String(d.incident.kind).toUpperCase());
    setClass(r.inc, `badge inc ${SEVERITY_CLASS[d.incident.severity] || ''}`.trim());
  } else {
    r.inc.hidden = true;
  }

  // battery
  const b = t && isNum(t.battery) ? t.battery : null;
  setText(r.batt, b === null ? '--' : `${Math.round(b)} %`);
  r.battBar.style.width = `${b === null ? 0 : Math.max(0, Math.min(100, b))}%`;
  r.battBar.style.background = b === null ? 'transparent' : b > 50 ? 'var(--ok)' : b > 20 ? 'var(--warn)' : 'var(--bad)';

  setText(r.alt, t ? fmt(t.alt, 1, ' m') : '--');
  setText(r.speed, t ? fmt(t.speed, 1, ' m/s') : '--');
  setText(r.hdg, t && isNum(t.heading) ? `${Math.round(t.heading)}°` : '--');

  // network
  const html = tcp.connected ? '<span class="led ok"></span>connected' : '<span class="led bad"></span>down';
  if (r.tcp.dataset.h !== html) {
    r.tcp.innerHTML = html;
    r.tcp.dataset.h = html;
  }
  setText(r.tcpRtt, fmt(tcp.rttMs, 2, ' ms'));
  setText(r.udpRtt, fmt(udp.rttMs, 2, ' ms'));
  setText(r.loss, fmt(udp.recentLossPct, 1, ' %'));
  setClass(r.loss, `mono ${!isNum(udp.recentLossPct) ? '' : udp.recentLossPct < 1 ? 'good' : udp.recentLossPct < 10 ? 'warn' : 'bad'}`);
  setText(r.jitter, fmt(udp.jitterMs, 2, ' ms'));
  setText(r.pps, isNum(udp.pps) ? `${udp.pps.toFixed(1)} pkt/s` : '--');
  setText(r.queued, String(tcp.queued ?? 0));
  setClass(r.queued, `mono ${tcp.queued > 0 ? 'warn' : ''}`);
  setText(r.reconn, String(tcp.reconnects ?? 0));
  const lc = tcp.lastCommand;
  setText(r.last, lc ? `${lc.action} #${lc.cmdId} ${lc.status}` : '--');

  // flight log
  const lg = d.log;
  if (lg && isNum(lg.size) && lg.size > 0) {
    const pct = Math.max(0, Math.min(100, (100 * (lg.acked || 0)) / lg.size));
    setText(r.logText, `${lg.logId} · ${pct.toFixed(0)} % · ${lg.status}`);
    r.logBar.style.width = `${pct}%`;
    r.logBar.className = `s-${lg.status}`;
  } else {
    setText(r.logText, lg ? `${lg.logId} · ${lg.status}` : 'none');
    r.logBar.style.width = '0%';
    r.logBar.className = '';
  }

  // chaos selector: follow the server value unless the user is using it
  const sel = r.lossSel;
  const sim = udp.simLossPct;
  if (isNum(sim) && document.activeElement !== sel) {
    if (![...sel.options].some((o) => Number(o.value) === sim)) {
      const o = document.createElement('option');
      o.value = String(sim);
      o.textContent = `${sim} %`;
      sel.appendChild(o);
    }
    sel.value = String(sim);
  }

  // sparklines
  sparkline(r.cAlt, h.alt || [], { color: d.color, min: 0, minSpan: 20, label: 'Alt m', digits: 0 });
  sparkline(r.cLoss, h.lossPct || [], { color: '#fbbf24', min: 0, minSpan: 5, label: 'Loss %', digits: 1 });
  sparkline(r.cRtt, h.tcpRtt || [], {
    color: TCP_COLOR,
    min: 0,
    minSpan: 0.5,
    label: 'RTT T/U',
    digits: 2,
    series2: { values: h.udpRtt || [], color: UDP_COLOR },
  });
}

// ---------- other panels ----------

function renderTopbar(s) {
  setText($('uptime'), fmtUptime(s.uptimeS));
  const p = s.ports || {};
  setText($('ports'), `TCP ${p.tcp ?? '--'} · UDP ${p.udp ?? '--'} · HTTP ${p.http ?? '--'}`);
  const t = s.totals || {};
  setText($('t-tcp'), isNum(t.tcpFrames) ? t.tcpFrames.toLocaleString('en-US') : '--');
  setText($('t-udp'), isNum(t.udpDatagrams) ? t.udpDatagrams.toLocaleString('en-US') : '--');
  setText($('t-lost'), isNum(t.udpLost) ? t.udpLost.toLocaleString('en-US') : '--');
  setText($('t-drop'), isNum(t.udpDropped) ? t.udpDropped.toLocaleString('en-US') : '--');
  const a = s.area || {};
  setText($('map-sub'), `${a.w ?? 1000} × ${a.h ?? 1000} m · grid 100 m`);
}

function renderInspector(s) {
  const rows = (Array.isArray(s.inspector) ? s.inspector : [])
    .map(
      (e) => `<tr>
        <td class="mono dim">${fmtTime(e.t)}</td>
        <td><span class="tag ${e.proto === 'UDP' ? 'udp' : 'tcp'}">${esc(e.proto)}</span></td>
        <td class="hide-sm mono dim">${e.dir === 'tx' ? '→ tx' : '← rx'}</td>
        <td>${esc(e.drone)}</td>
        <td class="mono type">${esc(e.type)}</td>
        <td class="hide-sm num mono dim">${isNum(e.size) ? e.size : ''}</td>
        <td class="mono info">${esc(e.info)}</td>
      </tr>`
    )
    .join('');
  $('inspector-body').innerHTML = rows || '<tr><td colspan="7" class="empty">No frames yet</td></tr>';
}

function renderIncidents(s) {
  const rows = (Array.isArray(s.incidents) ? s.incidents : [])
    .map((e) => {
      const action = e.action ? `${e.action} #${e.cmdId} ${e.cmdStatus ?? ''}`.trim() : 'logged';
      const late = isNum(e.ageMs) && e.ageMs >= 1000 ? ` · ${(e.ageMs / 1000).toFixed(1)} s late` : '';
      return `<tr>
        <td class="hide-sm mono dim">${fmtTime(e.t)}</td>
        <td>${esc(e.drone)}</td>
        <td>${esc(FAULT_LABEL[e.kind] || e.kind)}</td>
        <td><span class="tag ${esc(SEVERITY_CLASS[e.severity] || '')}">${esc(e.severity)}</span></td>
        <td class="mono">${esc(action)}</td>
        <td class="hide-sm mono dim">${esc(`acked${late}`)}</td>
      </tr>`;
    })
    .join('');
  $('incidents-body').innerHTML = rows || '<tr><td colspan="6" class="empty">No incidents</td></tr>';
}

function renderEvents(s) {
  const list = (Array.isArray(s.events) ? s.events : []).concat(localErrors);
  list.sort((a, b) => b.t - a.t);
  const items = list
    .slice(0, 30)
    .map((e) => `<li class="${esc(e.level)}"><span class="mono dim">${fmtTime(e.t)}</span><span class="lv"></span><span>${esc(e.text)}</span></li>`)
    .join('');
  $('events').innerHTML = items || '<li class="empty">No events yet</li>';
}

function render(s) {
  last = s;
  renderTopbar(s);
  const drones = Array.isArray(s.drones) ? s.drones : [];
  const host = $('cards');
  drones.forEach((d, i) => {
    let c = cards.get(d.id);
    if (!c) {
      c = buildCard(d);
      cards.set(d.id, c);
    }
    if (host.children[i] !== c.el) host.insertBefore(c.el, host.children[i] || null);
    updateCard(c, d);
  });
  drawMap($('map'), s);
  renderInspector(s);
  renderIncidents(s);
  renderEvents(s);
}

function setLive(mode) {
  const el = $('live');
  const text = { live: 'live', static: 'snapshot', down: 'reconnecting', connecting: 'connecting' }[mode];
  el.textContent = text;
  el.className = `pill ${mode}`;
}

// ---------- actions ----------

function pushError(text) {
  localErrors.unshift({ t: Date.now(), level: 'bad', text });
  localErrors.length = Math.min(localErrors.length, 5);
  if (last) renderEvents(last);
}

async function post(url, body, what) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await res.json()).error || '';
      } catch {
        /* no JSON body */
      }
      pushError(`${what} failed: HTTP ${res.status}${msg ? ` (${msg})` : ''}`);
    }
  } catch (err) {
    pushError(`${what} failed: ${err.message}`);
  }
}

const command = (droneId, action) => post('/api/command', { droneId, action }, `Command ${action} (drone ${droneId})`);

function wireActions() {
  $('cards').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    const card = ev.target.closest('.card');
    if (!btn || !card || btn.disabled) return;
    const id = Number(card.dataset.id);
    if (btn.dataset.act) command(id, btn.dataset.act);
    else if (btn.dataset.chaos === 'cut_tcp') post('/api/chaos', { droneId: id, kind: 'cut_tcp' }, `Cut TCP (drone ${id})`);
  });
  $('cards').addEventListener('change', (ev) => {
    const sel = ev.target.closest('select');
    const card = ev.target.closest('.card');
    if (!sel || !card) return;
    const id = Number(card.dataset.id);
    if (sel.dataset.r === 'faultSel') {
      if (sel.value) post('/api/chaos', { droneId: id, kind: 'fault', fault: sel.value }, `Inject ${sel.value} (drone ${id})`);
      sel.value = '';
      sel.blur();
      return;
    }
    if (sel.dataset.r !== 'lossSel') return;
    post('/api/chaos', { droneId: id, kind: 'udp_loss', pct: Number(sel.value) }, `UDP loss ${sel.value}% (drone ${id})`);
    sel.blur();
  });
  $('fleet-actions').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn || btn.disabled || !last) return;
    for (const d of last.drones || []) command(d.id, btn.dataset.fleet);
  });
}

// ---------- boot ----------

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => last && render(last), 120);
});

async function main() {
  if (STATIC) {
    document.body.classList.add('static');
    document.querySelectorAll('#fleet-actions button').forEach((b) => (b.disabled = true));
    setLive('static');
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      render(await res.json());
    } catch (err) {
      pushError(`Snapshot failed: ${err.message}`);
      document.getElementById('events').innerHTML = `<li class="bad"><span class="lv"></span><span>Snapshot failed: ${esc(err.message)}</span></li>`;
    }
    document.body.dataset.ready = '1';
    return;
  }
  wireActions();
  setLive('connecting');
  const es = new EventSource('/events');
  es.onopen = () => setLive('live');
  es.onerror = () => setLive('down');
  es.addEventListener('state', (ev) => {
    try {
      render(JSON.parse(ev.data));
      setLive('live');
      document.body.dataset.ready = '1';
    } catch (err) {
      console.error('render failed', err);
    }
  });
}

main();
