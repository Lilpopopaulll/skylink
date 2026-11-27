import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  tmpDir, rmDir, sleep, waitFor, waitEvent, lastEventId, within, startTestServer,
} from './helpers/net.js';
import { Drone } from '../src/sim/drone.js';
import { startFleet } from '../src/sim/fleet.js';
import { makeFlightLog } from '../src/sim/flightlog.js';
import { T, FrameDecoder, jsonFrame, parseJson } from '../src/protocol/slcp.js';

const HOST = '127.0.0.1';

/** Starts a station and runs `fn(ctx)`; always stops the drones and closes everything afterwards. */
async function withStation(fn) {
  const dataDir = tmpDir();
  const server = await startTestServer({ dataDir });
  const drones = [];
  const ctx = {
    server,
    dataDir,
    snap: (id) => server.state.snapshot().drones.find((d) => d.id === id),
    drone(id, extra = {}) {
      const d = new Drone({
        droneId: id, host: HOST, tcpPort: server.ports.tcp, udpPort: server.ports.udp,
        rateHz: 50, backoffMs: [200], logChunkIntervalMs: 10, ...extra,
      });
      drones.push(d);
      return d;
    },
  };
  try {
    await fn(ctx);
  } finally {
    await Promise.allSettled(drones.map((d) => d.stop()));
    await server.close();
    rmDir(dataDir);
  }
}

const connectedOnServer = (ctx, id) => waitFor(() => ctx.snap(id)?.tcp.connected, { what: `drone ${id} connected` });

test('drone connects over TCP, gets a session and streams telemetry over UDP', { timeout: 20000 }, async () => {
  await withStation(async (ctx) => {
    const d = ctx.drone(1);
    d.start();
    await connectedOnServer(ctx, 1);
    assert.equal(ctx.snap(1).tcp.connected, true);
    await waitFor(() => d.sessionId, { what: 'WELCOME on the drone side' });
    assert.match(d.sessionId, /^[0-9a-f]{8}$/);
    assert.equal(d.connected, true);
    await waitFor(() => ctx.snap(1).telemetry, { what: 'first telemetry' });
    assert.equal(ctx.snap(1).telemetry.state, 'LANDED');
    assert.ok(d.stats.telemetrySent > 0);
    // PING / PONG gives the server a TCP RTT.
    await waitFor(() => ctx.snap(1).tcp.rttMs !== null, { timeoutMs: 4000, what: 'tcp rtt' });
  });
});

test('takeoff command is acknowledged accepted then done', { timeout: 20000 }, async () => {
  await withStation(async (ctx) => {
    const d = ctx.drone(1, { timeScale: 5 }); // physics runs 5x faster: the 10 s climb takes ~2 s
    d.start();
    await connectedOnServer(ctx, 1);
    const since = lastEventId(ctx.server.bus);
    const { cmdId, status } = ctx.server.sendCommand(1, 'takeoff', { alt: 40 });
    assert.equal(status, 'sent');
    await waitEvent(ctx.server.bus, 'command:ack', { sinceId: since, pred: (e) => e.cmdId === cmdId && e.status === 'accepted', timeoutMs: 5000 });
    await waitEvent(ctx.server.bus, 'command:ack', { sinceId: since, pred: (e) => e.cmdId === cmdId && e.status === 'done', timeoutMs: 15000 });
    assert.equal(d.state.state, 2); // HOVER
    assert.equal(d.state.alt, 40);
    assert.equal(d.stats.executed, 1);
  });
});

test('goto is rejected while the drone is still on the ground', { timeout: 20000 }, async () => {
  await withStation(async (ctx) => {
    const d = ctx.drone(1);
    d.start();
    await connectedOnServer(ctx, 1);
    const since = lastEventId(ctx.server.bus);
    const { cmdId } = ctx.server.sendCommand(1, 'goto', { x: 300, y: 300, alt: 40 });
    await waitEvent(ctx.server.bus, 'command:ack', { sinceId: since, pred: (e) => e.cmdId === cmdId && e.status === 'rejected', timeoutMs: 5000 });
    assert.equal(d.stats.executed, 0);
  });
});

test('set_udp_loss 20 makes about 20 % of telemetry disappear (counted by the server)', { timeout: 30000 }, async () => {
  await withStation(async (ctx) => {
    const d = ctx.drone(1, { rateHz: 100 });
    d.start();
    await connectedOnServer(ctx, 1);
    await waitFor(() => ctx.snap(1).udp.received > 5, { what: 'telemetry flowing' });
    const since = lastEventId(ctx.server.bus);
    const { cmdId } = ctx.server.setUdpLoss(1, 20);
    await waitEvent(ctx.server.bus, 'command:ack', { sinceId: since, pred: (e) => e.cmdId === cmdId && e.status === 'accepted', timeoutMs: 5000 });
    const base = ctx.snap(1).udp;
    // Delta over the next 500 sequence numbers, whatever the real timer rate is on this machine.
    const cur = await waitFor(() => {
      const u = ctx.snap(1).udp;
      return u.expected - base.expected >= 500 ? u : null;
    }, { timeoutMs: 25000, what: '500 more sequence numbers' });
    const expected = cur.expected - base.expected;
    const lost = expected - (cur.received - base.received);
    const pct = (100 * lost) / expected;
    assert.ok(pct >= 10 && pct <= 30, `measured loss ${pct.toFixed(1)} %`);
    assert.ok(d.stats.telemetrySkipped > 0);
    assert.equal(ctx.snap(1).udp.simLossPct, 20);
  });
});

test('log upload survives a TCP reset: resume from disk offset, command delivered once', { timeout: 30000 }, async () => {
  await withStation(async (ctx) => {
    const { server } = ctx;
    const d = ctx.drone(1, { timeScale: 10, logChunkIntervalMs: 25 });
    const gotoRuns = [];
    d.on('command', (c) => { if (c.action === 'goto') gotoRuns.push(c.cmdId); });
    d.start();
    await connectedOnServer(ctx, 1);

    // Airborne first: goto is refused on the ground.
    const t0 = lastEventId(server.bus);
    const takeoff = server.sendCommand(1, 'takeoff', { alt: 40 });
    await waitEvent(server.bus, 'command:ack', { sinceId: t0, pred: (e) => e.cmdId === takeoff.cmdId && e.status === 'done', timeoutMs: 10000 });

    // Cut the link synchronously when the third chunk is on disk, and queue a goto right after.
    const bytes = makeFlightLog(7, 200000);
    let cut = null;
    const off = server.bus.on((e) => {
      if (cut || e.type !== 'log:progress' || e.acked < 49152) return;
      cut = { cutOk: server.cutTcp(1), ...server.sendCommand(1, 'goto', { x: 500, y: 500, alt: 40 }) };
    });
    const executedBefore = d.stats.executed;
    const upload = d.uploadLog({ logId: 'flight-t4', bytes });
    await waitFor(() => cut, { timeoutMs: 10000, what: 'link cut during upload' });
    off();
    assert.equal(cut.cutOk, true);
    assert.equal(cut.status, 'queued');
    const cutId = lastEventId(server.bus);

    await waitEvent(server.bus, 'drone:hello', { sinceId: cutId, pred: (e) => e.resumed === true, timeoutMs: 10000 });
    await waitEvent(server.bus, 'command:ack', { sinceId: cutId, pred: (e) => e.cmdId === cut.cmdId && e.status === 'accepted', timeoutMs: 10000 });
    const begin = await waitEvent(server.bus, 'log:begin', { sinceId: cutId, timeoutMs: 10000 });
    assert.ok(begin.offset >= 49152, `resume offset ${begin.offset}`);
    assert.ok(begin.offset < 200000);

    const result = await within(upload, 15000, 'upload result');
    assert.equal(result.ok, true);
    assert.equal(result.sha256.length, 64);

    await sleep(300); // a duplicated delivery would show up by now
    assert.deepEqual(gotoRuns, [cut.cmdId]);
    assert.equal(d.stats.executed, executedBefore + 1);
    assert.ok(d.stats.reconnects >= 1);
    const stored = fs.readFileSync(path.join(ctx.dataDir, 'logs', 'Alpha', 'flight-t4.bin'));
    assert.ok(stored.equals(bytes), 'stored log differs from the original');
  });
});

test('a command delivered twice (same cmdId) is acknowledged twice but executed once', { timeout: 15000 }, async () => {
  const sockets = new Set();
  const acks = [];
  const srv = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    const dec = new FrameDecoder();
    sock.on('data', (chunk) => {
      for (const f of dec.push(chunk)) {
        if (f.type === T.HELLO) {
          sock.write(jsonFrame(T.WELCOME, { sessionId: 'deadbeef', resumed: false, queued: 0 }));
          const cmd = jsonFrame(T.COMMAND, { cmdId: 5, action: 'set_udp_loss', params: { pct: 10 } });
          sock.write(cmd);
          sock.write(cmd);
        } else if (f.type === T.COMMAND_ACK) {
          acks.push(parseJson(f.body));
        }
      }
    });
  });
  await new Promise((res) => srv.listen(0, HOST, res));
  const d = new Drone({
    droneId: 2, host: HOST, tcpPort: srv.address().port, udpPort: 9, rateHz: 20, backoffMs: [100],
  });
  try {
    d.start();
    await waitFor(() => acks.filter((a) => a.status === 'accepted').length >= 2, { what: 'two accepted acks' });
    assert.equal(d.stats.executed, 1);
    assert.equal(d.udpLossPct, 10);
  } finally {
    await d.stop();
    for (const s of sockets) s.destroy();
    await new Promise((res) => srv.close(res));
  }
});

test('drone survives a refused connection and keeps retrying', { timeout: 15000 }, async () => {
  // Grab a free port, then close it so nothing listens there.
  const probe = net.createServer();
  await new Promise((res) => probe.listen(0, HOST, res));
  const port = probe.address().port;
  await new Promise((res) => probe.close(res));

  const d = new Drone({
    droneId: 1, host: HOST, tcpPort: port, udpPort: port, rateHz: 20, backoffMs: [30],
  });
  d.start();
  await sleep(400); // several ECONNREFUSED + reconnect cycles
  assert.equal(d.connected, false);
  await within(d.stop(), 3000, 'stop()');
  await d.stop(); // idempotent
});

test('startFleet runs several drones and stop() releases everything', { timeout: 20000 }, async () => {
  await withStation(async (ctx) => {
    const fleet = startFleet({
      count: 2, host: HOST, tcpPort: ctx.server.ports.tcp, udpPort: ctx.server.ports.udp, rateHz: 20, backoffMs: [200],
    });
    try {
      await waitFor(() => ctx.snap(1)?.tcp.connected && ctx.snap(2)?.tcp.connected, { what: 'both drones connected' });
      assert.deepEqual(fleet.drones.map((x) => x.name), ['Alpha', 'Bravo']);
    } finally {
      await within(fleet.stop(), 3000, 'fleet.stop()');
    }
    await waitFor(() => !ctx.snap(1).tcp.connected && !ctx.snap(2).tcp.connected, { what: 'server sees both gone' });
  });
});
