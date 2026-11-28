// Simulated drone: a real SLCP client (TCP) and a real SLTP sender (UDP), driven by the flight model.
// Always connects to an explicit host (127.0.0.1 by default), never "localhost".
import net from 'node:net';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { CONFIG, CALLSIGNS, homeFor } from '../config.js';
import {
  T, FrameDecoder, encodeFrame, jsonFrame, parseJson, encodeLogChunk, ALERT_KINDS,
} from '../protocol/slcp.js';
import { DT, decodeDatagram, encodeTelemetry, encodeEcho } from '../protocol/sltp.js';
import { mulberry32 } from './rng.js';
import { sha256 } from './flightlog.js';
import {
  S, makeState, cloneState, stepDrone, beginTakeoff, beginGoto, beginMission, beginRth, beginLand,
} from './physics.js';
import { detectIncidents, BATTERY_LOW_PCT, BATTERY_CRITICAL_PCT } from './incidents.js';

const MIN_TAKEOFF_BATTERY = 10;
const r1 = (v) => Math.round(v * 10) / 10;
const MAX_REAL_DT = 0.25; // seconds: a stalled event loop must not teleport the drone

export class Drone extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.droneId  1-based
   * @param {number} [o.timeScale=1]  test helper: simulated seconds per real second (physics only)
   */
  constructor({
    droneId, name = CALLSIGNS[droneId - 1] ?? `Drone${droneId}`, model = 'SL-Quad', host = CONFIG.host,
    tcpPort = CONFIG.tcpPort, udpPort = CONFIG.udpPort, rateHz = 10, udpLossPct = 0, seed = droneId,
    backoffMs = CONFIG.backoffMs, logChunkIntervalMs = 100, timeScale = 1, area = CONFIG.area,
  }) {
    super();
    this.droneId = droneId;
    this.name = name;
    this.model = model;
    this.host = host;
    this.tcpPort = tcpPort;
    this.udpPort = udpPort;
    this.rateHz = rateHz;
    this.udpLossPct = udpLossPct;
    this.backoffMs = backoffMs.length ? [...backoffMs] : [...CONFIG.backoffMs];
    this.logChunkIntervalMs = logChunkIntervalMs;
    this.timeScale = timeScale;
    this._rng = mulberry32(seed);
    this._phys = makeState(homeFor(droneId));

    this._stopped = false;
    this._sock = null; // current TCP socket (null while disconnected)
    this._connected = false; // true between WELCOME and close
    this._sessionId = null;
    this._welcomes = 0;
    this._backoffN = 0;
    this._reconnectTimer = null;
    this._idleTimer = null;

    this._udp = null;
    this._udpOpen = false;
    this._tick = null;
    this._lastTick = 0;
    this._t0 = performance.now();
    this._seq = 0;

    this._cmdResults = new Map(); // cmdId -> 'accepted' | 'rejected' (+reason), for deduplication
    this._pending = null; // {cmdId, kind} : command waiting for its 'done' ack
    this._upload = null;
    this._pump = null;

    this.area = area;
    this._alerts = new Map(); // alertId -> alert, kept until the station's ALERT_ACK (at-least-once)
    this._nextAlertId = 1;
    this._raised = new Set(); // kinds already reported since the last takeoff

    this._stats = {
      reconnects: 0, telemetrySent: 0, telemetrySkipped: 0, executed: 0, alertsRaised: 0, alertsDeferred: 0,
    };
  }

  /** Alerts raised but not yet acknowledged by the station. */
  get pendingAlerts() { return this._alerts.size; }

  get connected() { return this._connected; }

  get sessionId() { return this._sessionId; }

  /** Copy of the physical state. `state` is the numeric code (see S / STATES). */
  get state() { return cloneState(this._phys); }

  get stats() { return { ...this._stats }; }

  start() {
    if (this._stopped || this._tick) return this;
    this._startUdp();
    this._lastTick = performance.now();
    this._tick = setInterval(() => this._onTick(), 1000 / this.rateHz);
    this._connect();
    return this;
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    clearInterval(this._tick);
    clearTimeout(this._reconnectTimer);
    clearInterval(this._idleTimer);
    clearInterval(this._pump);
    this._tick = null;
    this._reconnectTimer = null;
    this._idleTimer = null;
    this._pump = null;
    this._connected = false;
    if (this._upload) {
      const up = this._upload;
      this._upload = null;
      up.resolve({ ok: false, sha256: up.sha, aborted: true });
    }
    const waits = [];
    const sock = this._sock;
    this._sock = null;
    if (sock && !sock.destroyed) {
      waits.push(new Promise((res) => sock.once('close', res)));
      sock.destroy();
    }
    if (this._udp && this._udpOpen) {
      this._udpOpen = false;
      const udp = this._udp;
      waits.push(new Promise((res) => {
        try {
          udp.close(() => res());
        } catch {
          res();
        }
      }));
    }
    await Promise.all(waits);
  }

  // ---- UDP (SLTP) --------------------------------------------------------------------------------

  _startUdp() {
    const udp = dgram.createSocket({ type: 'udp4' });
    this._udp = udp;
    this._udpOpen = true;
    udp.on('error', () => {}); // a failed datagram must never crash the drone
    udp.on('message', (msg, rinfo) => this._onDatagram(msg, rinfo));
    udp.bind(0, this.host);
  }

  _sendUdp(buf, port = this.udpPort, address = this.host) {
    if (!this._udpOpen) return;
    try {
      this._udp.send(buf, port, address, () => {});
    } catch {
      // socket closing: nothing to do
    }
  }

  _lossy() {
    return this._rng() < this.udpLossPct / 100;
  }

  _onDatagram(msg, rinfo) {
    const d = decodeDatagram(msg);
    if (!d || d.type !== DT.ECHO_REQ || d.droneId !== this.droneId) return;
    if (this._lossy()) return; // the echo reply suffers the same simulated loss
    this._sendUdp(encodeEcho(DT.ECHO_REP, this.droneId, d.echoSeq, d.t0us), rinfo.port, rinfo.address);
  }

  _onTick() {
    const now = performance.now();
    const dtReal = Math.min(MAX_REAL_DT, Math.max(0, (now - this._lastTick) / 1000));
    this._lastTick = now;
    const { s, events } = stepDrone(this._phys, dtReal * this.timeScale);
    this._phys = s;
    for (const ev of events) this._onPhysicsEvent(ev);
    for (const k of detectIncidents(s, this.area, this._raised)) this._raise(k);

    // The server ignores telemetry from a drone it never saw in a HELLO, so wait for the first WELCOME.
    // After that telemetry keeps flowing even while TCP is down.
    if (this._welcomes === 0) return;
    this._seq++;
    if (this._lossy()) {
      this._stats.telemetrySkipped++; // simulated loss at the sender: seq still advances
      return;
    }
    this._stats.telemetrySent++;
    this._sendUdp(encodeTelemetry({
      droneId: this.droneId,
      seq: this._seq,
      tsMs: Math.round(now - this._t0),
      x: s.x, y: s.y, alt: s.alt, speed: s.speed, heading: s.heading, battery: s.battery, state: s.state,
    }));
  }

  // ---- TCP (SLCP) --------------------------------------------------------------------------------

  _connect() {
    if (this._stopped) return;
    const sock = net.connect({ host: this.host, port: this.tcpPort });
    this._sock = sock;
    const decoder = new FrameDecoder();
    let lastRx = performance.now();
    let reason = 'closed';

    sock.on('connect', () => {
      sock.setNoDelay(true);
      lastRx = performance.now();
      const hello = {
        droneId: this.droneId, name: this.name, model: this.model, fw: '1.0',
      };
      if (this._sessionId) hello.sessionId = this._sessionId;
      this._write(sock, jsonFrame(T.HELLO, hello));
      clearInterval(this._idleTimer);
      this._idleTimer = setInterval(() => {
        if (performance.now() - lastRx > CONFIG.idleMs) {
          reason = 'idle';
          sock.destroy();
        }
      }, 500);
    });

    sock.on('data', (chunk) => {
      lastRx = performance.now();
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        reason = 'bad-frame';
        sock.destroy();
        return;
      }
      for (const f of frames) {
        if (sock.destroyed) return;
        try {
          this._onFrame(sock, f);
        } catch {
          reason = 'bad-frame';
          sock.destroy();
          return;
        }
      }
    });

    sock.on('error', (err) => { reason = err.code ?? 'error'; }); // ECONNREFUSED / ECONNRESET: close follows
    sock.on('close', () => this._onClose(sock, reason));
  }

  _write(sock, buf) {
    if (!sock || sock.destroyed || !sock.writable) return false;
    sock.write(buf);
    return true;
  }

  /** Send a JSON frame on the live, welcomed connection. False if disconnected (the message is lost). */
  _send(type, obj) {
    if (!this._connected) return false;
    return this._write(this._sock, jsonFrame(type, obj));
  }

  // ---- incidents (ALERT / ALERT_ACK) -------------------------------------------------------------

  /** Simulates a fault (chaos): forces the physical cause when there is one, then raises the alert. Returns the alertId. */
  injectFault(kind) {
    if (typeof kind !== 'string' || !Object.hasOwn(ALERT_KINDS, kind)) throw new RangeError(`Unknown fault: ${kind}`);
    if (kind === 'battery_low') this._phys.battery = Math.min(this._phys.battery, BATTERY_LOW_PCT);
    if (kind === 'battery_critical') this._phys.battery = Math.min(this._phys.battery, BATTERY_CRITICAL_PCT);
    return this._raise(kind);
  }

  /** Queues an alert (kept until acknowledged) and sends it if the link is up. */
  _raise(kind) {
    const s = this._phys;
    const a = {
      alertId: this._nextAlertId++,
      kind,
      severity: ALERT_KINDS[kind],
      detectedAt: performance.now(),
      x: r1(s.x), y: r1(s.y), alt: r1(s.alt), battery: Math.round(s.battery),
    };
    this._raised.add(kind);
    if (kind === 'battery_critical') this._raised.add('battery_low');
    this._alerts.set(a.alertId, a);
    this._stats.alertsRaised++;
    if (!this._connected) this._stats.alertsDeferred++;
    this.emit('alert', { alertId: a.alertId, kind, severity: a.severity, queued: !this._connected });
    this._sendAlert(a);
    return a.alertId;
  }

  /** ageMs is recomputed at every (re)send, on the drone's own clock only. */
  _sendAlert(a) {
    this._send(T.ALERT, {
      alertId: a.alertId,
      kind: a.kind,
      severity: a.severity,
      ageMs: Math.round(performance.now() - a.detectedAt),
      x: a.x,
      y: a.y,
      alt: a.alt,
      battery: a.battery,
    });
  }

  _onAlertAck({ alertId, action, cmdId }) {
    if (!this._alerts.has(alertId)) return;
    this._alerts.delete(alertId);
    this.emit('alert:ack', { alertId, action, cmdId });
  }

  _onClose(sock, reason) {
    if (sock !== this._sock) return; // an old socket closing after a newer one took over
    this._sock = null;
    clearInterval(this._idleTimer);
    this._idleTimer = null;
    const wasConnected = this._connected;
    this._connected = false;
    clearInterval(this._pump);
    this._pump = null;
    if (this._upload) this._upload.begun = false; // resume starts with a new LOG_BEGIN after WELCOME
    if (wasConnected) this.emit('disconnected', { reason });
    if (this._stopped) return;
    const delay = this.backoffMs[Math.min(this._backoffN, this.backoffMs.length - 1)];
    this._backoffN++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _onFrame(sock, { type, body }) {
    switch (type) {
      case T.WELCOME: return this._onWelcome(sock, parseJson(body));
      case T.COMMAND: return this._onCommand(parseJson(body));
      case T.PING:
        this._write(sock, encodeFrame(T.PONG, body)); // exact copy of the PING body
        return undefined;
      case T.ALERT_ACK: return this._onAlertAck(parseJson(body));
      case T.LOG_ACK: return this._onLogAck(parseJson(body));
      case T.LOG_DONE: return this._onLogDone(parseJson(body));
      default: return undefined; // ERROR: the server closes right after, we reconnect from 'close'
    }
  }

  _onWelcome(sock, j) {
    if (typeof j.sessionId === 'string') this._sessionId = j.sessionId;
    this._connected = true;
    this._backoffN = 0;
    this._welcomes++;
    if (this._welcomes > 1) this._stats.reconnects++;
    this.emit('connected', { resumed: Boolean(j.resumed) });
    for (const a of this._alerts.values()) this._sendAlert(a); // unacknowledged alerts, in alertId order
    if (this._upload) this._beginUpload();
  }

  // ---- commands ----------------------------------------------------------------------------------

  _onCommand({ cmdId, action, params }) {
    if (!Number.isInteger(cmdId)) return;
    const known = this._cmdResults.get(cmdId);
    if (known) { // duplicate (at-least-once delivery): answer again, never execute twice
      this._send(T.COMMAND_ACK, { cmdId, ...known });
      return;
    }
    const p = params ?? {};
    const result = this._execute(cmdId, action, p);
    this._cmdResults.set(cmdId, result);
    this._send(T.COMMAND_ACK, { cmdId, ...result });
    if (result.status !== 'accepted') return;
    this._stats.executed++;
    this.emit('command', { cmdId, action });
    if (this._pending?.cmdId === cmdId && this._pending.kind === 'now') {
      this._pending = null;
      this._send(T.COMMAND_ACK, { cmdId, status: 'done' });
    }
    // After the 'accepted' and 'done' acks: the alert (and the station's failsafe) comes next.
    if (action === 'inject_fault') this.injectFault(p.fault);
  }

  /** @returns {{status:'accepted'}|{status:'rejected', reason:string}} */
  _execute(cmdId, action, p) {
    const s = this._phys;
    const grounded = s.state === S.LANDED || s.state === S.LANDING;
    const reject = (reason) => ({ status: 'rejected', reason });
    switch (action) {
      case 'takeoff':
        if (s.battery < MIN_TAKEOFF_BATTERY) return reject('battery');
        if (s.state !== S.LANDED) return reject('airborne');
        beginTakeoff(s, p.alt);
        this._pending = { cmdId, kind: 'reached' };
        this._raised.clear(); // a new flight: incidents can be reported again
        return { status: 'accepted' };
      case 'goto':
        if (grounded) return reject('not airborne');
        beginGoto(s, p.x, p.y, p.alt);
        this._pending = { cmdId, kind: 'reached' };
        return { status: 'accepted' };
      case 'mission':
        if (grounded) return reject('not airborne');
        beginMission(s, Array.isArray(p.waypoints) ? p.waypoints : []);
        this._pending = { cmdId, kind: 'mission-done' };
        return { status: 'accepted' };
      case 'rth':
        if (s.state === S.LANDED) { this._pending = { cmdId, kind: 'now' }; return { status: 'accepted' }; }
        if (s.state !== S.LANDING) beginRth(s);
        this._pending = { cmdId, kind: 'landed' };
        return { status: 'accepted' };
      case 'land':
        if (s.state === S.LANDED) { this._pending = { cmdId, kind: 'now' }; return { status: 'accepted' }; }
        if (s.state !== S.LANDING) beginLand(s);
        this._pending = { cmdId, kind: 'landed' };
        return { status: 'accepted' };
      case 'set_udp_loss': {
        const pct = Number(p.pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return reject('bad pct');
        this.udpLossPct = pct;
        this._pending = { cmdId, kind: 'now' };
        return { status: 'accepted' };
      }
      case 'inject_fault':
        if (typeof p.fault !== 'string' || !Object.hasOwn(ALERT_KINDS, p.fault)) return reject('bad fault');
        this._pending = { cmdId, kind: 'now' };
        return { status: 'accepted' };
      default:
        return reject('unknown action');
    }
  }

  _onPhysicsEvent(ev) {
    if (ev === 'low-battery') {
      this._pending = null; // the autonomous return home supersedes whatever was running
      return;
    }
    const p = this._pending;
    if (!p) return;
    const completes = (ev === 'reached' && p.kind === 'reached')
      || (ev === 'mission-done' && p.kind === 'mission-done')
      || (ev === 'landed' && p.kind === 'landed');
    if (!completes) return;
    this._pending = null;
    this._send(T.COMMAND_ACK, { cmdId: p.cmdId, status: 'done' }); // lost if the link is down
  }

  // ---- reliable flight-log upload ----------------------------------------------------------------

  /** Resolves {ok, sha256} when the server confirms (or refuses) the log. Survives link cuts. */
  uploadLog({ logId, bytes }) {
    if (this._upload) return Promise.reject(new Error('An upload is already running'));
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const up = {
      logId, bytes: buf, size: buf.length, sha: sha256(buf), acked: 0, sent: 0, begun: false, resolve: null,
    };
    const promise = new Promise((resolve) => { up.resolve = resolve; });
    this._upload = up;
    if (this._connected) this._beginUpload();
    return promise;
  }

  _beginUpload() {
    const up = this._upload;
    if (!up) return;
    up.begun = false; // wait for the LOG_ACK that carries the resume offset (bytes on the server disk)
    this._send(T.LOG_BEGIN, { logId: up.logId, size: up.size, sha256: up.sha });
  }

  _onLogAck({ logId, offset }) {
    const up = this._upload;
    if (!up || logId !== up.logId || !Number.isInteger(offset)) return;
    if (!up.begun) { // answer to LOG_BEGIN: the disk is the truth
      up.begun = true;
      up.acked = offset;
      up.sent = offset;
      clearInterval(this._pump);
      this._pump = setInterval(() => this._pumpChunk(), this.logChunkIntervalMs);
      return;
    }
    if (offset > up.acked) up.acked = offset;
  }

  _pumpChunk() {
    const up = this._upload;
    if (!up || !up.begun || !this._connected) return;
    if (up.sent >= up.size) return;
    const inflight = Math.ceil((up.sent - up.acked) / CONFIG.logChunk);
    if (inflight >= CONFIG.logWindow) return;
    const end = Math.min(up.sent + CONFIG.logChunk, up.size);
    const ok = this._write(this._sock, encodeLogChunk(up.sent, up.bytes.subarray(up.sent, end)));
    if (ok) up.sent = end;
  }

  _onLogDone({ logId, ok, sha256: digest }) {
    const up = this._upload;
    if (!up || logId !== up.logId) return;
    this._upload = null;
    clearInterval(this._pump);
    this._pump = null;
    this.emit('log:done', { ok: Boolean(ok) });
    up.resolve({ ok: Boolean(ok), sha256: digest ?? up.sha });
  }
}
