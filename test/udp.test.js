import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T } from '../src/protocol/slcp.js';
import { DT, decodeDatagram, encodeEcho, encodeTelemetry } from '../src/protocol/sltp.js';
import { tmpDir, rmDir, sleep, waitFor, rawClient, startTestServer, udpClient } from './helpers/net.js';

async function withServer(overrides, fn) {
  const dir = tmpDir();
  const srv = await startTestServer({ dataDir: dir, ...overrides });
  const closers = [];
  const hello = async (droneId, name) => {
    const c = await rawClient(srv.ports.tcp);
    closers.push(() => c.destroy());
    c.json(T.HELLO, { droneId, name, model: 'SL-Quad', fw: '1.0' });
    await c.nextJson(T.WELCOME);
    return c;
  };
  const udp = async () => {
    const u = await udpClient();
    closers.push(() => u.close());
    return u;
  };
  try {
    await fn(srv, { hello, udp });
  } finally {
    for (const close of closers) await close();
    await srv.close();
    rmDir(dir);
  }
}

const telemetry = (droneId, seq) =>
  encodeTelemetry({ droneId, seq, tsMs: seq * 100, x: 10.5, y: 20.5, alt: 40, speed: 5, heading: 90, battery: 87, state: 4 });
const droneSnap = (srv, id) => srv.state.snapshot().drones.find((d) => d.id === id);

test('telemetry 1..100 without seq 5,15..95 -> received 90, lossPct 10', () =>
  withServer({}, async (srv, { hello, udp }) => {
    await hello(2, 'Bravo');
    const u = await udp();
    for (let seq = 1; seq <= 100; seq++) {
      if (seq % 10 === 5) continue;
      await u.send(telemetry(2, seq), srv.ports.udp);
      if (seq % 20 === 0) await sleep(2);
    }
    await waitFor(() => droneSnap(srv, 2).udp.received === 90, { what: '90 datagrams received' });
    const d = droneSnap(srv, 2);
    assert.equal(d.udp.expected, 100);
    assert.equal(d.udp.lossPct, 10);
    assert.equal(d.udp.outOfOrder, 0);
    assert.equal(srv.state.snapshot().totals.udpLost, 10);
    assert.equal(srv.state.snapshot().totals.udpDatagrams, 90);
    assert.equal(d.telemetry.state, 'MISSION');
    assert.equal(d.telemetry.battery, 87);
    assert.equal(d.telemetry.seq, 100);
    assert.ok(d.trail.length >= 10); // 1 telemetry in 5
  }));

test('ECHO_REQ reaches the drone address, ECHO_REP sets udp.rttMs', () =>
  withServer({ echoMs: 200 }, async (srv, { hello, udp }) => {
    await hello(4, 'Delta');
    const u = await udp();
    assert.equal(droneSnap(srv, 4).udp.rttMs, null);
    await u.send(telemetry(4, 1), srv.ports.udp); // the server learns our UDP address from this
    const req = decodeDatagram(await u.next((b) => b[3] === DT.ECHO_REQ, 1500));
    assert.equal(req.droneId, 4);
    await u.send(encodeEcho(DT.ECHO_REP, 4, req.echoSeq, req.t0us), srv.ports.udp);
    await waitFor(() => droneSnap(srv, 4).udp.rttMs !== null, { what: 'udp.rttMs' });
    assert.ok(droneSnap(srv, 4).udp.rttMs >= 0);
    assert.ok(srv.bus.recent().some((e) => e.type === 'udp:echo' && e.droneId === 4));
  }));

test('unknown droneId and garbage datagrams are dropped and counted', () =>
  withServer({}, async (srv, { udp }) => {
    const u = await udp();
    await u.send(telemetry(9, 1), srv.ports.udp); // drone 9 never said HELLO
    await waitFor(() => srv.state.snapshot().totals.udpDropped === 1, { what: 'udpDropped = 1' });
    await u.send(Buffer.from('not a datagram'), srv.ports.udp);
    await waitFor(() => srv.state.snapshot().totals.udpDropped === 2, { what: 'udpDropped = 2' });
    assert.equal(srv.state.snapshot().drones.length, 0);
  }));
