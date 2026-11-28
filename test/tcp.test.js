import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { T, jsonFrame, encodeLogChunk } from '../src/protocol/slcp.js';
import { tmpDir, rmDir, waitFor, waitEvent, lastEventId, rawClient, startTestServer, within, sleep } from './helpers/net.js';

/** Starts a station in a temp dir, runs fn(srv, dir), always cleans up. */
async function withServer(overrides, fn) {
  const dir = tmpDir();
  const srv = await startTestServer({ dataDir: dir, ...overrides });
  const clients = [];
  const connect = async (droneId = 3, extra = {}) => {
    const c = await rawClient(srv.ports.tcp);
    clients.push(c);
    c.json(T.HELLO, { droneId, name: ['Alpha', 'Bravo', 'Charlie', 'Delta'][droneId - 1], model: 'SL-Quad', fw: '1.0', ...extra });
    const welcome = await c.nextJson(T.WELCOME);
    return { c, welcome };
  };
  try {
    await fn(srv, dir, connect);
  } finally {
    for (const c of clients) c.destroy();
    await srv.close();
    rmDir(dir);
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const droneSnap = (srv, id) => srv.state.snapshot().drones.find((d) => d.id === id);

test('HELLO -> WELCOME resumed:false with an 8-hex sessionId', () =>
  withServer({}, async (srv, dir, connect) => {
    const { welcome } = await connect(3);
    assert.equal(welcome.resumed, false);
    assert.match(welcome.sessionId, /^[0-9a-f]{8}$/);
    assert.equal(welcome.queued, 0);
    const d = droneSnap(srv, 3);
    assert.equal(d.name, 'Charlie');
    assert.equal(d.tcp.connected, true);
    assert.equal(d.sessionId, welcome.sessionId);
  }));

test('first frame that is not HELLO -> ERROR NOT_HELLO, then close', () =>
  withServer({}, async (srv) => {
    const c = await rawClient(srv.ports.tcp);
    c.send(jsonFrame(T.PING, { n: 1, t: 0 }));
    const err = await c.nextJson(T.ERROR);
    assert.equal(err.code, 'NOT_HELLO');
    await within(c.closed, 2000, 'server to close the socket');
  }));

test('oversized header len=20001 -> ERROR FRAME_TOO_BIG, then close', () =>
  withServer({}, async (srv) => {
    const c = await rawClient(srv.ports.tcp);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(20001, 0);
    c.send(header);
    const err = await c.nextJson(T.ERROR);
    assert.equal(err.code, 'FRAME_TOO_BIG');
    await within(c.closed, 2000, 'server to close the socket');
    assert.ok(srv.bus.recent().some((e) => e.type === 'frame:error' && e.code === 'FRAME_TOO_BIG'));
  }));

test('sendCommand validates action and drone', () =>
  withServer({}, async (srv, dir, connect) => {
    await connect(3);
    assert.throws(() => srv.sendCommand(3, 'fly', {}), /BAD_ACTION/);
    assert.throws(() => srv.sendCommand(9, 'takeoff', {}), /UNKNOWN_DRONE/);
    assert.throws(() => srv.sendCommand(3, 'goto', { x: 'a' }), /BAD_PARAMS/);
  }));

test('takeoff reaches the drone, COMMAND_ACK accepted -> command:ack', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(3);
    const since = lastEventId(srv.bus);
    const res = srv.sendCommand(3, 'takeoff');
    assert.equal(res.status, 'sent');
    const cmd = await c.nextJson(T.COMMAND);
    assert.equal(cmd.cmdId, res.cmdId);
    assert.equal(cmd.action, 'takeoff');
    assert.equal(cmd.params.alt, 40);
    c.json(T.COMMAND_ACK, { cmdId: cmd.cmdId, status: 'accepted' });
    const ev = await waitEvent(srv.bus, 'command:ack', { sinceId: since });
    assert.equal(ev.status, 'accepted');
    assert.equal(ev.droneId, 3);
    const d = droneSnap(srv, 3);
    assert.equal(d.tcp.queued, 0);
    assert.deepEqual(d.tcp.lastCommand, { cmdId: res.cmdId, action: 'takeoff', status: 'accepted' });
  }));

test('mission without waypoints gets the default mission', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(1);
    srv.sendCommand(1, 'mission', {});
    const cmd = await c.nextJson(T.COMMAND);
    assert.equal(cmd.params.waypoints.length, 4);
    assert.deepEqual(cmd.params.waypoints[1], { x: 450, y: 150, alt: 40 });
    assert.equal(droneSnap(srv, 1).mission.length, 4);
  }));

test('cutTcp: RST, command queued, resumed session re-delivers it with the same cmdId', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c, welcome } = await connect(3);
    assert.equal(srv.cutTcp(3), true);
    assert.equal(droneSnap(srv, 3).tcp.connected, false); // synchronous
    await within(c.closed, 2000, 'client to see the reset');

    const res = srv.sendCommand(3, 'goto', { x: 500, y: 500, alt: 40 });
    assert.equal(res.status, 'queued');
    assert.equal(droneSnap(srv, 3).tcp.queued, 1);

    const { c: c2, welcome: w2 } = await connect(3, { sessionId: welcome.sessionId });
    assert.equal(w2.resumed, true);
    assert.equal(w2.queued, 1);
    assert.equal(w2.sessionId, welcome.sessionId);
    const cmd = await c2.nextJson(T.COMMAND);
    assert.equal(cmd.action, 'goto');
    assert.equal(cmd.cmdId, res.cmdId);
    c2.json(T.COMMAND_ACK, { cmdId: cmd.cmdId, status: 'accepted' });
    await waitFor(() => droneSnap(srv, 3).tcp.queued === 0, { what: 'outbox to drain' });
    assert.equal(droneSnap(srv, 3).tcp.reconnects, 1);
  }));

test('HELLO with an unknown sessionId starts a new session', () =>
  withServer({}, async (srv, dir, connect) => {
    const { welcome } = await connect(3, { sessionId: 'deadbeef' });
    assert.equal(welcome.resumed, false);
    assert.notEqual(welcome.sessionId, 'deadbeef');
  }));

test('a new connection of the same drone destroys the old socket', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c: first } = await connect(3);
    await connect(3);
    await within(first.closed, 2000, 'old socket to be destroyed');
    assert.equal(droneSnap(srv, 3).tcp.connected, true);
  }));

/**
 * Upload 100 000 bytes, cut after 3 chunks, resume, finish. Returns {done, data, dir}.
 * `declaredSha` lets a test lie about the hash.
 */
async function uploadWithCut(srv, connect, data, declaredSha) {
  const logId = 'flight-003';
  const CH = 16384;
  const { c, welcome } = await connect(3);
  c.json(T.LOG_BEGIN, { logId, size: data.length, sha256: declaredSha });
  assert.equal((await c.nextJson(T.LOG_ACK)).offset, 0);
  for (let i = 0; i < 3; i++) c.send(encodeLogChunk(i * CH, data.subarray(i * CH, (i + 1) * CH)));
  let ack;
  for (let i = 0; i < 3; i++) ack = await c.nextJson(T.LOG_ACK);
  assert.equal(ack.offset, 49152);
  assert.equal(droneSnap(srv, 3).log.status, 'uploading');

  srv.cutTcp(3);
  assert.equal(droneSnap(srv, 3).log.status, 'paused');
  await within(c.closed, 2000, 'client to see the reset');

  const { c: c2, welcome: w2 } = await connect(3, { sessionId: welcome.sessionId });
  assert.equal(w2.resumed, true);
  const since = lastEventId(srv.bus);
  c2.json(T.LOG_BEGIN, { logId, size: data.length, sha256: declaredSha });
  const resume = await c2.nextJson(T.LOG_ACK);
  assert.equal(resume.offset, 49152); // the size of the .part file on disk
  const begin = await waitEvent(srv.bus, 'log:begin', { sinceId: since });
  assert.equal(begin.offset, 49152);
  for (let off = resume.offset; off < data.length; off += CH) {
    c2.send(encodeLogChunk(off, data.subarray(off, Math.min(off + CH, data.length))));
  }
  return c2.nextJson(T.LOG_DONE, 5000);
}

test('log upload resumes at the on-disk offset and ends with SHA-256 OK', () =>
  withServer({}, async (srv, dir, connect) => {
    const data = randomBytes(100000);
    const done = await uploadWithCut(srv, connect, data, sha256(data));
    assert.equal(done.ok, true);
    assert.equal(done.size, 100000);
    assert.equal(done.sha256, sha256(data));
    const bin = path.join(dir, 'logs', 'Charlie', 'flight-003.bin');
    assert.ok(fs.readFileSync(bin).equals(data));
    assert.equal(fs.existsSync(path.join(dir, 'logs', 'Charlie', 'flight-003.part')), false);
    assert.equal(droneSnap(srv, 3).log.status, 'done');
  }));

test('log upload with a wrong SHA-256 -> ok:false and a .bad file', () =>
  withServer({}, async (srv, dir, connect) => {
    const data = randomBytes(100000);
    const done = await uploadWithCut(srv, connect, data, '0'.repeat(64));
    assert.equal(done.ok, false);
    assert.equal(done.sha256, sha256(data)); // the server reports what it actually computed
    assert.ok(fs.existsSync(path.join(dir, 'logs', 'Charlie', 'flight-003.bad')));
    assert.equal(fs.existsSync(path.join(dir, 'logs', 'Charlie', 'flight-003.bin')), false);
    assert.equal(droneSnap(srv, 3).log.status, 'failed');
  }));

test('chunk offset beyond acked -> ERROR BAD_OFFSET', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(3);
    c.json(T.LOG_BEGIN, { logId: 'flight-004', size: 50000, sha256: '0'.repeat(64) });
    assert.equal((await c.nextJson(T.LOG_ACK)).offset, 0);
    c.send(encodeLogChunk(16384, randomBytes(1000)));
    const err = await c.nextJson(T.ERROR);
    assert.equal(err.code, 'BAD_OFFSET');
    await within(c.closed, 2000, 'server to close the socket');
  }));

test('invalid logId -> ERROR BAD_LOG', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(3);
    c.json(T.LOG_BEGIN, { logId: '../evil', size: 10, sha256: '0'.repeat(64) });
    assert.equal((await c.nextJson(T.ERROR)).code, 'BAD_LOG');
  }));

test('PING arrives, PONG sets tcp.rttMs', () =>
  withServer({ pingMs: 200 }, async (srv, dir, connect) => {
    const { c } = await connect(3);
    assert.equal(droneSnap(srv, 3).tcp.rttMs, null);
    const ping = await c.next(T.PING, 1500);
    c.send(jsonFrame(T.PONG, JSON.parse(ping.body.toString('utf8'))));
    await waitFor(() => droneSnap(srv, 3).tcp.rttMs !== null, { what: 'tcp.rttMs' });
    assert.ok(droneSnap(srv, 3).tcp.rttMs >= 0);
  }));

test('ALERT critical -> COMMAND land, then ALERT_ACK with its cmdId; incident in the snapshot', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(3);
    const since = lastEventId(srv.bus);
    c.json(T.ALERT, { alertId: 1, kind: 'motor_failure', severity: 'critical', ageMs: 0, x: 1, y: 2, alt: 40, battery: 80 });
    const cmd = await c.nextJson(T.COMMAND);
    assert.equal(cmd.action, 'land');
    const ack = await c.nextJson(T.ALERT_ACK);
    assert.deepEqual(ack, { alertId: 1, action: 'land', cmdId: cmd.cmdId });
    const posCmd = c.frames.findIndex((f) => f.type === T.COMMAND);
    const posAck = c.frames.findIndex((f) => f.type === T.ALERT_ACK);
    assert.ok(posCmd >= 0 && posAck > posCmd, 'COMMAND must be received before ALERT_ACK');
    const inc = srv.state.snapshot().incidents[0];
    assert.equal(inc.kind, 'motor_failure');
    assert.equal(inc.severity, 'critical');
    assert.equal(inc.action, 'land');
    assert.equal(inc.drone, 'Charlie');
    assert.equal(droneSnap(srv, 3).incident.severity, 'critical');
    const ev = await waitEvent(srv.bus, 'incident', { sinceId: since });
    assert.equal(ev.alertId, 1);
  }));

test('ALERT motor_failure sent with severity info -> the station table wins, land is ordered', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(3);
    c.json(T.ALERT, { alertId: 1, kind: 'motor_failure', severity: 'info', ageMs: 0 });
    const cmd = await c.nextJson(T.COMMAND);
    assert.equal(cmd.action, 'land');
    const ack = await c.nextJson(T.ALERT_ACK);
    assert.equal(ack.action, 'land');
    assert.equal(srv.state.snapshot().incidents[0].severity, 'critical');
  }));

test('ALERT info -> ALERT_ACK action null, no command, incident logged', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(3);
    c.json(T.ALERT, { alertId: 1, kind: 'gps_degraded', severity: 'info', ageMs: 0 });
    const ack = await c.nextJson(T.ALERT_ACK);
    assert.equal(ack.action, null);
    assert.equal(ack.cmdId, null);
    await sleep(200);
    assert.equal(c.frames.some((f) => f.type === T.COMMAND), false);
    assert.equal(srv.state.snapshot().incidents.length, 1);
  }));

test('a duplicated alertId is acknowledged again but the failsafe runs once', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(3);
    const alert = { alertId: 1, kind: 'battery_low', severity: 'warning', ageMs: 0, x: 1, y: 2, alt: 40, battery: 29 };
    c.json(T.ALERT, alert);
    const ack1 = await c.nextJson(T.ALERT_ACK);
    c.json(T.ALERT, alert);
    const ack2 = await c.nextJson(T.ALERT_ACK);
    assert.deepEqual(ack2, ack1);
    await sleep(200);
    const commands = c.frames.filter((f) => f.type === T.COMMAND);
    assert.equal(commands.length, 1);
    assert.equal(JSON.parse(commands[0].body.toString('utf8')).action, 'rth');
    assert.equal(srv.state.snapshot().incidents.length, 1);
  }));

test('invalid ALERT -> ERROR BAD_JSON', () =>
  withServer({}, async (srv, dir, connect) => {
    const { c } = await connect(3);
    c.json(T.ALERT, { alertId: 1, kind: 'toString', severity: 'info' });
    assert.equal((await c.nextJson(T.ERROR)).code, 'BAD_JSON');
    await within(c.closed, 2000, 'server to close the socket');
  }));

test('a silent connection is destroyed after idleMs', () =>
  withServer({ pingMs: 100, idleMs: 400 }, async (srv, dir, connect) => {
    const { c } = await connect(3);
    await within(c.closed, 3000, 'idle watchdog');
    await waitFor(() => droneSnap(srv, 3).tcp.connected === false, { what: 'drone marked disconnected' });
    const ev = srv.bus.recent().find((e) => e.type === 'drone:disconnect');
    assert.equal(ev.reason, 'idle');
  }));
