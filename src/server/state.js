// Fleet state: everything the UI shows, built from TCP/UDP activity. snapshot() is the /api/state contract.
import { CALLSIGNS, COLORS, homeFor } from '../config.js';
import { SeqStats, RttTracker } from '../protocol/stats.js';
import { STATES } from '../protocol/sltp.js';

const INSPECTOR_MAX = 40;
const EVENTS_MAX = 30;
const TRAIL_MAX = 120;
const HISTORY_MAX = 60;
const TRAIL_EVERY = 5; // 1 telemetry in 5 goes to the trail
const INSPECT_TELEMETRY_EVERY = 10; // 1 telemetry in 10 goes to the inspector

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const r1 = (v) => Math.round(v * 10) / 10;

export class FleetState {
  constructor({ bus, config }) {
    this.bus = bus;
    this.config = config;
    this.startedAt = Date.now();
    this.ports = { tcp: null, udp: null, http: null }; // filled by startServer
    this.drones = new Map(); // droneId -> record
    this.totals = { tcpFrames: 0, udpDatagrams: 0, udpDropped: 0 };
    this.inspector = [];
    this.events = [];
    bus.on((e) => this._onBusEvent(e));
  }

  get(droneId) {
    return this.drones.get(droneId) ?? null;
  }

  nameOf(droneId) {
    return this.drones.get(droneId)?.name ?? `Drone ${droneId}`;
  }

  /** Create the drone record on first HELLO, refresh its identity afterwards. */
  ensureDrone({ droneId, name, model, fw }) {
    let rec = this.drones.get(droneId);
    if (!rec) {
      rec = {
        id: droneId,
        name: name ?? CALLSIGNS[droneId - 1] ?? `Drone${droneId}`,
        color: COLORS[(droneId - 1) % COLORS.length],
        model: model ?? 'SL-Quad',
        fw: fw ?? null,
        home: homeFor(droneId),
        sessionId: null,
        tcp: { connected: false, rtt: new RttTracker(), reconnects: 0, hellos: 0, queued: 0, lastCommand: null },
        udp: { stats: new SeqStats(), rtt: new RttTracker(), simLossPct: 0, addr: null, echoSeq: 0 },
        telemetry: null,
        telemetryAt: 0,
        telemetryCount: 0,
        trail: [],
        mission: null,
        history: { alt: [], speed: [], battery: [], lossPct: [], tcpRtt: [], udpRtt: [] },
        log: null,
      };
      this.drones.set(droneId, rec);
    } else {
      if (name) rec.name = name;
      if (model) rec.model = model;
      if (fw) rec.fw = fw;
    }
    return rec;
  }

  /** Returns false (and counts a drop) for a drone that never said HELLO. */
  onTelemetry(d, rinfo) {
    const rec = this.drones.get(d.droneId);
    if (!rec) {
      this.totals.udpDropped++;
      return false;
    }
    rec.udp.stats.onPacket(d.seq, d.tsMs);
    rec.udp.addr = { address: rinfo.address, port: rinfo.port };
    this.totals.udpDatagrams++;
    rec.telemetry = {
      x: d.x, y: d.y, alt: d.alt, speed: d.speed, heading: d.heading, battery: d.battery,
      state: STATES[d.state] ?? 'LANDED', seq: d.seq,
    };
    rec.telemetryAt = performance.now();
    rec.telemetryCount++;
    if (rec.telemetryCount % TRAIL_EVERY === 0) {
      rec.trail.push([r1(d.x), r1(d.y)]);
      if (rec.trail.length > TRAIL_MAX) rec.trail.shift();
    }
    if (rec.telemetryCount % INSPECT_TELEMETRY_EVERY === 1) {
      this.inspect({
        proto: 'UDP', dir: 'rx', drone: rec.name, type: 'TELEMETRY', size: 36,
        info: `seq=${d.seq} alt=${d.alt.toFixed(1)} bat=${d.battery}%`,
      });
    }
    return true;
  }

  onEcho(droneId, rttMs) {
    const rec = this.drones.get(droneId);
    if (!rec) {
      this.totals.udpDropped++;
      return false;
    }
    this.totals.udpDatagrams++;
    rec.udp.rtt.add(rttMs);
    this.bus.emit('udp:echo', { droneId, rttMs });
    return true;
  }

  inspect(entry) {
    if (entry.proto === 'TCP') this.totals.tcpFrames++;
    this.inspector.unshift({ t: Date.now(), ...entry });
    if (this.inspector.length > INSPECTOR_MAX) this.inspector.length = INSPECTOR_MAX;
  }

  note(level, text) {
    this.events.unshift({ t: Date.now(), level, text });
    if (this.events.length > EVENTS_MAX) this.events.length = EVENTS_MAX;
  }

  /** 1 Hz: push the current values of every drone into its history. */
  sampleHistory() {
    for (const rec of this.drones.values()) {
      const h = rec.history;
      const push = (arr, v) => {
        arr.push(v);
        if (arr.length > HISTORY_MAX) arr.shift();
      };
      const t = rec.telemetry;
      push(h.alt, t ? r1(t.alt) : 0);
      push(h.speed, t ? r1(t.speed) : 0);
      push(h.battery, t ? t.battery : 0);
      push(h.lossPct, r2(rec.udp.stats.snapshot().recentLossPct));
      push(h.tcpRtt, r2(rec.tcp.rtt.last) ?? 0);
      push(h.udpRtt, r2(rec.udp.rtt.last) ?? 0);
    }
  }

  snapshot() {
    const now = Date.now();
    const perf = performance.now();
    let udpLost = 0;
    const drones = [...this.drones.values()]
      .sort((a, b) => a.id - b.id)
      .map((rec) => {
        const s = rec.udp.stats.snapshot();
        udpLost += s.lost;
        const t = rec.telemetry;
        return {
          id: rec.id,
          name: rec.name,
          color: rec.color,
          model: rec.model,
          home: { ...rec.home },
          sessionId: rec.sessionId,
          tcp: {
            connected: rec.tcp.connected,
            rttMs: r2(rec.tcp.rtt.last),
            reconnects: rec.tcp.reconnects,
            queued: rec.tcp.queued,
            lastCommand: rec.tcp.lastCommand ? { ...rec.tcp.lastCommand } : null,
          },
          udp: {
            rttMs: r2(rec.udp.rtt.last),
            lossPct: r2(s.lossPct),
            recentLossPct: r2(s.recentLossPct),
            outOfOrder: s.outOfOrder,
            jitterMs: r2(s.jitterMs),
            pps: s.pps,
            received: s.received,
            expected: s.expected,
            simLossPct: rec.udp.simLossPct,
          },
          telemetry: t
            ? {
                x: r1(t.x), y: r1(t.y), alt: r1(t.alt), speed: r1(t.speed), heading: r1(t.heading),
                battery: t.battery, state: t.state, seq: t.seq, ageMs: Math.round(perf - rec.telemetryAt),
              }
            : null,
          trail: rec.trail.map((p) => [...p]),
          mission: rec.mission ? rec.mission.map((w) => ({ ...w })) : null,
          history: Object.fromEntries(Object.entries(rec.history).map(([k, v]) => [k, [...v]])),
          log: rec.log ? { ...rec.log } : null,
        };
      });
    return {
      serverTime: now,
      uptimeS: Math.round((now - this.startedAt) / 100) / 10,
      ports: { ...this.ports },
      area: { ...this.config.area },
      totals: { ...this.totals, udpLost },
      drones,
      inspector: this.inspector.map((e) => ({ ...e })),
      events: this.events.map((e) => ({ ...e })),
    };
  }

  /** Human-readable event feed, derived from bus events. */
  _onBusEvent(e) {
    const n = e.droneId !== undefined ? this.nameOf(e.droneId) : '';
    switch (e.type) {
      case 'drone:hello': {
        const q = this.drones.get(e.droneId)?.tcp.queued ?? 0;
        if (e.resumed) this.note('ok', `${n} session resumed, ${q} queued command${q === 1 ? '' : 's'}`);
        else this.note('info', `${n} connected (new session)`);
        break;
      }
      case 'drone:disconnect':
        if (e.reason !== 'cut') this.note('warn', `${n} TCP link lost (${e.reason})`);
        break;
      case 'tcp:cut':
        this.note('warn', `${n} TCP link reset (RST) by operator`);
        break;
      case 'command:sent':
        this.note('info', `Command ${e.action} #${e.cmdId} sent to ${n}`);
        break;
      case 'command:queued':
        this.note('warn', `Command ${e.action} #${e.cmdId} queued for ${n} (link down)`);
        break;
      case 'command:ack':
        if (e.status === 'done') this.note('ok', `${n} completed command #${e.cmdId}`);
        else if (e.status === 'rejected') this.note('warn', `${n} rejected command #${e.cmdId}`);
        else this.note('info', `${n} accepted command #${e.cmdId}`);
        break;
      case 'log:begin':
        this.note('info', e.offset > 0
          ? `${n} flight log ${e.logId} resumed at byte ${e.offset}`
          : `${n} flight log ${e.logId} upload started`);
        break;
      case 'log:done':
        this.note(e.ok ? 'ok' : 'warn', e.ok
          ? `${n} flight log ${e.logId} verified (SHA-256 OK)`
          : `${n} flight log ${e.logId} FAILED verification (SHA-256 mismatch)`);
        break;
      case 'chaos:udp_loss':
        this.note('warn', `${n} simulated UDP loss set to ${e.pct}%`);
        break;
      case 'frame:error':
        this.note('warn', `Protocol error ${e.code}${e.droneId ? ` from ${n}` : ''}`);
        break;
      default:
    }
  }
}
