// SLCP server (TCP): sessions, command outbox with resume, reliable flight-log upload, PING/PONG.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { CALLSIGNS } from '../config.js';
import {
  T, ProtocolError, FrameDecoder, jsonFrame, parseJson, decodeLogChunk, describeFrame,
} from '../protocol/slcp.js';
import { defaultMission } from './missions.js';

export const ACTIONS = Object.freeze(['takeoff', 'goto', 'mission', 'rth', 'land', 'set_udp_loss']);
const LOG_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SHA_RE = /^[0-9a-fA-F]{64}$/;
const MAX_WAYPOINTS = 16;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Validates and completes COMMAND params. Throws Error('BAD_PARAMS'). */
function normalizeParams(droneId, action, params) {
  const p = params ?? {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new Error('BAD_PARAMS');
  const alt = p.alt ?? 40;
  if (!isNum(alt) || alt < 0 || alt > 500) throw new Error('BAD_PARAMS');
  switch (action) {
    case 'takeoff':
      return { alt };
    case 'goto':
      if (!isNum(p.x) || !isNum(p.y)) throw new Error('BAD_PARAMS');
      return { x: p.x, y: p.y, alt };
    case 'mission': {
      if (p.waypoints === undefined) return { waypoints: defaultMission(droneId) };
      if (!Array.isArray(p.waypoints) || p.waypoints.length < 1 || p.waypoints.length > MAX_WAYPOINTS) {
        throw new Error('BAD_PARAMS');
      }
      const waypoints = p.waypoints.map((w) => {
        if (!w || !isNum(w.x) || !isNum(w.y) || (w.alt !== undefined && !isNum(w.alt))) throw new Error('BAD_PARAMS');
        return { x: w.x, y: w.y, alt: w.alt ?? 40 };
      });
      return { waypoints };
    }
    case 'set_udp_loss':
      if (!isNum(p.pct) || p.pct < 0 || p.pct > 100) throw new Error('BAD_PARAMS');
      return { pct: p.pct };
    default: // rth, land
      return {};
  }
}

function cleanName(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
  return s || null;
}

function dirName(rec) {
  return rec.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || `drone${rec.id}`;
}

function helloName(body) {
  try {
    return cleanName(parseJson(body).name);
  } catch {
    return null;
  }
}

/** @returns {Promise<{port:number, sendCommand:Function, cutTcp:Function, close:Function}>} */
export function startTcp({ config, state, bus }) {
  const peers = new Map(); // droneId -> {sessionId, seenAt, outbox: Map<cmdId, cmd>, conn}
  const conns = new Set();
  let nextCmdId = 1;

  // ---- frame I/O -------------------------------------------------------------------------------

  function inspectFrame(conn, dir, type, body, nameHint) {
    const d = describeFrame(type, body);
    state.inspect({
      proto: 'TCP', dir, drone: conn.name ?? nameHint ?? '?', type: d.type, size: body.length + 5, info: d.info,
    });
  }

  function writeFrame(conn, type, buf) {
    if (!conn.socket.writable) return false;
    conn.socket.write(buf);
    inspectFrame(conn, 'tx', type, buf.subarray(5));
    return true;
  }

  const send = (conn, type, obj) => writeFrame(conn, type, jsonFrame(type, obj));

  function fail(conn, err) {
    if (conn.dead) return;
    conn.dead = true;
    const code = err instanceof ProtocolError ? err.code : 'BAD_FRAME';
    bus.emit('frame:error', { code, droneId: conn.droneId });
    try {
      send(conn, T.ERROR, { code, message: String(err.message ?? code).slice(0, 200) });
    } catch {
      // ignore: we are closing anyway
    }
    conn.socket.end();
  }

  // ---- commands --------------------------------------------------------------------------------

  function writeCommand(peer, cmd) {
    send(peer.conn, T.COMMAND, { cmdId: cmd.cmdId, action: cmd.action, params: cmd.params });
    bus.emit('command:sent', { droneId: peer.droneId, cmdId: cmd.cmdId, action: cmd.action });
  }

  function sendCommand(droneId, action, params) {
    if (!ACTIONS.includes(action)) throw new Error('BAD_ACTION');
    const rec = state.get(droneId);
    const peer = peers.get(droneId);
    if (!rec || !peer) throw new Error('UNKNOWN_DRONE');
    const p = normalizeParams(droneId, action, params);
    const cmd = { cmdId: nextCmdId++, action, params: p };
    peer.outbox.set(cmd.cmdId, cmd);
    if (action === 'mission') rec.mission = p.waypoints;
    if (action === 'goto') rec.mission = [{ x: p.x, y: p.y, alt: p.alt }];
    if (action === 'set_udp_loss') {
      rec.udp.simLossPct = p.pct;
      bus.emit('chaos:udp_loss', { droneId, pct: p.pct });
    }
    rec.tcp.queued = peer.outbox.size;
    const online = rec.tcp.connected && peer.conn && !peer.conn.dead;
    const status = online ? 'sent' : 'queued';
    rec.tcp.lastCommand = { cmdId: cmd.cmdId, action, status };
    if (online) writeCommand(peer, cmd);
    else bus.emit('command:queued', { droneId, cmdId: cmd.cmdId, action });
    return { cmdId: cmd.cmdId, status };
  }

  function pauseLog(rec) {
    if (rec?.log && rec.log.status === 'uploading') rec.log.status = 'paused';
  }

  function cutTcp(droneId) {
    const peer = peers.get(droneId);
    const rec = state.get(droneId);
    if (!peer || !rec || !peer.conn || !rec.tcp.connected) return false;
    const conn = peer.conn;
    conn.reason = 'cut';
    rec.tcp.connected = false; // synchronous: a sendCommand right after this is queued
    pauseLog(rec);
    bus.emit('tcp:cut', { droneId });
    conn.socket.resetAndDestroy();
    return true;
  }

  // ---- frame handlers --------------------------------------------------------------------------

  function onHello(conn, body) {
    if (conn.peer) throw new ProtocolError('BAD_FRAME', 'Duplicate HELLO');
    const j = parseJson(body);
    const droneId = j.droneId;
    if (!Number.isInteger(droneId) || droneId < 1 || droneId > 255) {
      throw new ProtocolError('BAD_JSON', 'droneId must be an integer 1..255');
    }
    const name = cleanName(j.name) ?? CALLSIGNS[droneId - 1] ?? `Drone${droneId}`;
    const now = Date.now();
    let peer = peers.get(droneId);
    if (!peer) {
      peer = { droneId, sessionId: null, seenAt: now, outbox: new Map(), conn: null };
      peers.set(droneId, peer);
    }
    const resumed = typeof j.sessionId === 'string' && j.sessionId === peer.sessionId
      && now - peer.seenAt < config.sessionTtlMs;
    if (!resumed) {
      peer.sessionId = randomBytes(4).toString('hex');
      // A new session restarts the drone's telemetry numbering at 1: start the UDP statistics afresh.
      state.get(droneId)?.udp?.stats?.reset();
    }
    peer.seenAt = now;
    if (peer.conn && peer.conn !== conn) {
      peer.conn.replaced = true;
      peer.conn.socket.destroy();
    }
    peer.conn = conn;
    conn.peer = peer;
    conn.droneId = droneId;
    conn.name = name;

    const rec = state.ensureDrone({
      droneId, name, model: typeof j.model === 'string' ? j.model.slice(0, 32) : undefined,
      fw: typeof j.fw === 'string' ? j.fw.slice(0, 16) : undefined,
    });
    rec.sessionId = peer.sessionId;
    rec.tcp.connected = true;
    if (rec.tcp.hellos++ > 0) rec.tcp.reconnects++;
    rec.tcp.queued = peer.outbox.size;
    send(conn, T.WELCOME, { sessionId: peer.sessionId, resumed, queued: peer.outbox.size });
    bus.emit('drone:hello', { droneId, resumed });
    for (const cmd of peer.outbox.values()) writeCommand(peer, cmd); // at-least-once, in cmdId order
  }

  function onCommandAck(conn, body) {
    const j = parseJson(body);
    const peer = conn.peer;
    const rec = state.get(conn.droneId);
    const status = j.status;
    if (!Number.isInteger(j.cmdId) || !['accepted', 'done', 'rejected'].includes(status)) {
      throw new ProtocolError('BAD_JSON', 'COMMAND_ACK needs cmdId and status');
    }
    peer.outbox.delete(j.cmdId); // accepted, done and rejected all end the retransmission
    rec.tcp.queued = peer.outbox.size;
    if (rec.tcp.lastCommand && rec.tcp.lastCommand.cmdId === j.cmdId) rec.tcp.lastCommand.status = status;
    bus.emit('command:ack', { droneId: conn.droneId, cmdId: j.cmdId, status });
  }

  function onPong(conn, body) {
    const j = parseJson(body);
    if (!isNum(j.t)) return;
    const rtt = performance.now() - j.t;
    if (rtt >= 0 && rtt < 60000) state.get(conn.droneId).tcp.rtt.add(rtt);
  }

  function logPaths(rec, logId) {
    const dir = path.join(config.dataDir, 'logs', dirName(rec));
    return { dir, part: path.join(dir, `${logId}.part`), bin: path.join(dir, `${logId}.bin`), bad: path.join(dir, `${logId}.bad`) };
  }

  function finalizeLog(conn, rec) {
    const l = conn.log;
    const buf = fs.readFileSync(l.part);
    const digest = sha256(buf);
    const ok = buf.length === l.size && digest === l.sha;
    fs.renameSync(l.part, ok ? l.bin : l.bad);
    send(conn, T.LOG_DONE, { logId: l.logId, size: buf.length, sha256: digest, ok });
    rec.log.status = ok ? 'done' : 'failed';
    conn.log = null;
    bus.emit('log:done', { droneId: conn.droneId, logId: l.logId, ok });
  }

  function onLogBegin(conn, body) {
    const j = parseJson(body);
    const rec = state.get(conn.droneId);
    if (typeof j.logId !== 'string' || !LOG_ID_RE.test(j.logId)) throw new ProtocolError('BAD_LOG', 'Invalid logId');
    if (!Number.isInteger(j.size) || j.size < 1 || j.size > 64 * 1024 * 1024) throw new ProtocolError('BAD_LOG', 'Invalid size');
    if (typeof j.sha256 !== 'string' || !SHA_RE.test(j.sha256)) throw new ProtocolError('BAD_LOG', 'Invalid sha256');
    const sha = j.sha256.toLowerCase();
    const p = logPaths(rec, j.logId);
    let acked = 0; // the truth is the size of the .part file on disk
    try {
      fs.mkdirSync(p.dir, { recursive: true });
      // Upload already completed earlier (the LOG_DONE got lost): confirm it again.
      if (fs.existsSync(p.bin) && fs.statSync(p.bin).size === j.size && sha256(fs.readFileSync(p.bin)) === sha) {
        rec.log = { logId: j.logId, size: j.size, acked: j.size, status: 'done' };
        bus.emit('log:begin', { droneId: conn.droneId, logId: j.logId, size: j.size, offset: j.size });
        send(conn, T.LOG_ACK, { logId: j.logId, offset: j.size });
        send(conn, T.LOG_DONE, { logId: j.logId, size: j.size, sha256: sha, ok: true });
        bus.emit('log:done', { droneId: conn.droneId, logId: j.logId, ok: true });
        return;
      }
      if (fs.existsSync(p.part)) acked = fs.statSync(p.part).size;
      if (acked > j.size) {
        fs.rmSync(p.part);
        acked = 0;
      }
      conn.log = { logId: j.logId, size: j.size, sha, acked, ...p };
    } catch (err) {
      throw new ProtocolError('BAD_LOG', `Log storage error: ${err.code ?? err.message}`);
    }
    rec.log = { logId: j.logId, size: j.size, acked, status: 'uploading' };
    bus.emit('log:begin', { droneId: conn.droneId, logId: j.logId, size: j.size, offset: acked });
    send(conn, T.LOG_ACK, { logId: j.logId, offset: acked });
    if (acked === j.size) finalizeLog(conn, rec);
  }

  function onLogChunk(conn, body) {
    const l = conn.log;
    if (!l) throw new ProtocolError('BAD_LOG', 'LOG_CHUNK without LOG_BEGIN');
    const rec = state.get(conn.droneId);
    const { offset, data } = decodeLogChunk(body);
    if (offset > l.acked) throw new ProtocolError('BAD_OFFSET', `Chunk offset ${offset} is beyond acked ${l.acked}`);
    if (offset < l.acked) {
      send(conn, T.LOG_ACK, { logId: l.logId, offset: l.acked }); // duplicate: ignore, re-acknowledge
      return;
    }
    if (l.acked + data.length > l.size) throw new ProtocolError('BAD_LOG', 'Chunk goes past the declared size');
    try {
      fs.appendFileSync(l.part, data); // acknowledge only after the bytes are on disk
    } catch (err) {
      throw new ProtocolError('BAD_LOG', `Log write error: ${err.code ?? err.message}`);
    }
    l.acked += data.length;
    rec.log.acked = l.acked;
    bus.emit('log:progress', { droneId: conn.droneId, logId: l.logId, acked: l.acked, size: l.size });
    send(conn, T.LOG_ACK, { logId: l.logId, offset: l.acked });
    if (l.acked === l.size) finalizeLog(conn, rec);
  }

  function handleFrame(conn, { type, body }) {
    if (!conn.peer && type !== T.HELLO) {
      inspectFrame(conn, 'rx', type, body);
      throw new ProtocolError('NOT_HELLO', 'First frame must be HELLO');
    }
    inspectFrame(conn, 'rx', type, body, type === T.HELLO ? helloName(body) : undefined);
    if (conn.peer) conn.peer.seenAt = Date.now();
    switch (type) {
      case T.HELLO: return onHello(conn, body);
      case T.COMMAND_ACK: return onCommandAck(conn, body);
      case T.LOG_BEGIN: return onLogBegin(conn, body);
      case T.LOG_CHUNK: return onLogChunk(conn, body);
      case T.PONG: return onPong(conn, body);
      default: throw new ProtocolError('UNKNOWN_TYPE', `Unexpected frame type 0x${type.toString(16)}`);
    }
  }

  // ---- sockets ---------------------------------------------------------------------------------

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const conn = {
      socket, decoder: new FrameDecoder({ maxLen: config.maxFrameLen }), peer: null, droneId: null, name: null,
      lastRx: performance.now(), pingN: 0, dead: false, replaced: false, reason: null, log: null, timer: null,
    };
    conns.add(conn);

    // One timer per connection: PING every pingMs, idle watchdog.
    conn.timer = setInterval(() => {
      if (performance.now() - conn.lastRx > config.idleMs) {
        conn.reason = conn.reason ?? 'idle';
        socket.destroy();
        return;
      }
      if (conn.peer && !conn.dead) send(conn, T.PING, { n: ++conn.pingN, t: Math.round(performance.now() * 1000) / 1000 });
    }, config.pingMs);
    conn.timer.unref();

    socket.on('data', (chunk) => {
      if (conn.dead) return;
      conn.lastRx = performance.now();
      let frames;
      let pending = null;
      try {
        frames = conn.decoder.push(chunk);
      } catch (err) {
        frames = err.frames ?? [];
        pending = err;
      }
      for (const f of frames) {
        if (conn.dead) return;
        try {
          handleFrame(conn, f);
        } catch (err) {
          fail(conn, err);
          return;
        }
      }
      if (pending) fail(conn, pending);
    });

    socket.on('error', () => {
      conn.reason = conn.reason ?? 'error';
    });

    socket.on('close', () => {
      clearInterval(conn.timer);
      conns.delete(conn);
      const peer = conn.peer;
      if (!peer || peer.conn !== conn || conn.replaced) return;
      peer.conn = null;
      peer.seenAt = Date.now();
      const rec = state.get(conn.droneId);
      rec.tcp.connected = false;
      pauseLog(rec);
      bus.emit('drone:disconnect', { droneId: conn.droneId, reason: conn.reason ?? 'closed' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.tcpPort, config.host, () => {
      server.off('error', reject);
      server.on('error', (err) => console.error(`TCP server error: ${err.code ?? err.message}`)); // e.g. EMFILE: never crash
      resolve({
        port: server.address().port,
        sendCommand,
        cutTcp,
        close() {
          for (const conn of conns) {
            clearInterval(conn.timer);
            conn.socket.destroy();
          }
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}
