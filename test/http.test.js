import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { T } from '../src/protocol/slcp.js';
import { tmpDir, rmDir, lastEventId, waitEvent, rawClient, startTestServer, request, postJson, within } from './helpers/net.js';

async function withServer(overrides, fn) {
  const dir = tmpDir();
  const srv = await startTestServer({ dataDir: dir, ...overrides });
  const clients = [];
  const hello = async (droneId = 1, name = 'Alpha') => {
    const c = await rawClient(srv.ports.tcp);
    clients.push(c);
    c.json(T.HELLO, { droneId, name, model: 'SL-Quad', fw: '1.0' });
    await c.nextJson(T.WELCOME);
    return c;
  };
  try {
    await fn(srv, hello);
  } finally {
    for (const c of clients) c.destroy();
    await srv.close();
    rmDir(dir);
  }
}

test('GET /api/state -> 200 JSON with the snapshot contract', () =>
  withServer({}, async (srv, hello) => {
    await hello(1, 'Alpha');
    const res = await request(srv.ports.http, { path: '/api/state' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const s = res.json();
    for (const k of ['serverTime', 'uptimeS', 'ports', 'area', 'totals', 'drones', 'inspector', 'events']) assert.ok(k in s, k);
    assert.deepEqual(s.ports, srv.ports);
    assert.deepEqual(s.area, { w: 1000, h: 1000 });
    const d = s.drones[0];
    assert.equal(d.id, 1);
    assert.equal(d.name, 'Alpha');
    assert.equal(d.color, '#3ad1ff');
    assert.deepEqual(d.home, { x: 150, y: 150 });
    assert.equal(d.tcp.connected, true);
    assert.equal(d.telemetry, null);
    assert.equal(d.log, null);
    for (const k of ['alt', 'speed', 'battery', 'lossPct', 'tcpRtt', 'udpRtt']) assert.ok(Array.isArray(d.history[k]), k);
    assert.ok(s.inspector.some((e) => e.proto === 'TCP' && e.type === 'HELLO' && e.drone === 'Alpha'));
    assert.ok(s.events.length >= 1);
  }));

test('GET / serves the UI with no-store', () =>
  withServer({}, async (srv) => {
    const res = await request(srv.ports.http, { path: '/' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.text, /SkyLink/);
  }));

test('GET /events sends an "event: state" within 1 s', () =>
  withServer({}, async (srv) => {
    let req;
    const text = await within(
      new Promise((resolve, reject) => {
        let buf = '';
        req = http.get({ host: '127.0.0.1', port: srv.ports.http, path: '/events', agent: false }, (res) => {
          assert.match(res.headers['content-type'], /text\/event-stream/);
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buf += chunk;
            if (buf.includes('event: state\ndata: ')) resolve(buf);
          });
        });
        req.on('error', reject);
      }),
      1000,
      'SSE state event',
    ).finally(() => req.destroy());
    assert.ok(text.startsWith('retry: 2000'));
    const data = text.split('event: state\ndata: ')[1].split('\n')[0];
    assert.ok(Array.isArray(JSON.parse(data).drones));
  }));

test('POST /api/command: 404 unknown drone, 400 bad action, 400 bad JSON, 413 big body', () =>
  withServer({}, async (srv, hello) => {
    const port = srv.ports.http;
    await hello(1, 'Alpha');
    assert.equal((await postJson(port, '/api/command', { droneId: 9, action: 'takeoff' })).status, 404);
    const fly = await postJson(port, '/api/command', { droneId: 1, action: 'fly' });
    assert.equal(fly.status, 400);
    assert.ok(fly.json().error);
    assert.equal((await postJson(port, '/api/command', '{not json')).status, 400);
    assert.equal((await postJson(port, '/api/command', { droneId: 1, action: 'goto', params: { x: 'a' } })).status, 400);
    assert.equal((await postJson(port, '/api/command', 'x'.repeat(5000))).status, 413);
  }));

test('POST /api/command -> 202 {cmdId, status}; mission without waypoints uses the default', () =>
  withServer({}, async (srv, hello) => {
    const c = await hello(1, 'Alpha');
    const res = await postJson(srv.ports.http, '/api/command', { droneId: 1, action: 'mission' });
    assert.equal(res.status, 202);
    const body = res.json();
    assert.equal(body.status, 'sent');
    const cmd = await c.nextJson(T.COMMAND);
    assert.equal(cmd.cmdId, body.cmdId);
    assert.equal(cmd.params.waypoints.length, 4);
  }));

test('POST /api/chaos: cut_tcp -> 200 + tcp:cut; udp_loss -> chaos:udp_loss; bad kind -> 400', () =>
  withServer({}, async (srv, hello) => {
    const c = await hello(1, 'Alpha');
    const port = srv.ports.http;
    const since = lastEventId(srv.bus);

    const loss = await postJson(port, '/api/chaos', { droneId: 1, kind: 'udp_loss', pct: 15 });
    assert.equal(loss.status, 200);
    const ev = await waitEvent(srv.bus, 'chaos:udp_loss', { sinceId: since });
    assert.equal(ev.pct, 15);
    assert.equal((await c.nextJson(T.COMMAND)).action, 'set_udp_loss');
    assert.equal(srv.state.snapshot().drones[0].udp.simLossPct, 15);

    assert.equal((await postJson(port, '/api/chaos', { droneId: 1, kind: 'udp_loss', pct: 500 })).status, 400);
    assert.equal((await postJson(port, '/api/chaos', { droneId: 1, kind: 'explode' })).status, 400);
    assert.equal((await postJson(port, '/api/chaos', { droneId: 9, kind: 'cut_tcp' })).status, 404);

    const cut = await postJson(port, '/api/chaos', { droneId: 1, kind: 'cut_tcp' });
    assert.equal(cut.status, 200);
    assert.deepEqual(cut.json(), { ok: true });
    await waitEvent(srv.bus, 'tcp:cut', { sinceId: since });
    await within(c.closed, 2000, 'client to see the reset');
  }));

test('path traversal and non-static files -> 404', () =>
  withServer({}, async (srv) => {
    const port = srv.ports.http;
    // Raw request: node's http client keeps "/../" as written (fetch would normalise it away).
    assert.equal((await request(port, { path: '/../package.json' })).status, 404);
    assert.equal((await request(port, { path: '/%2e%2e/package.json' })).status, 404);
    assert.equal((await request(port, { path: '/..%5Cpackage.json' })).status, 404);
    assert.equal((await request(port, { path: '/package.json' })).status, 404);
    assert.equal((await request(port, { path: '/nope.js' })).status, 404);
    assert.equal((await request(port, { method: 'POST', path: '/api/state', body: '{}' })).status, 404);
  }));
