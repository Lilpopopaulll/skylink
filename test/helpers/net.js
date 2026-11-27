// Test helpers: temp dirs, waiting utilities, a raw SLCP client, a UDP client, a tiny HTTP client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
import { FrameDecoder, jsonFrame, parseJson } from '../../src/protocol/slcp.js';
import { startServer } from '../../src/server/index.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function tmpDir(prefix = 'skylink-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Station on ephemeral loopback ports; `rest` overrides any config key (pingMs, idleMs, echoMs...). */
export function startTestServer({ dataDir, ...rest }) {
  return startServer({ host: '127.0.0.1', tcpPort: 0, udpPort: 0, httpPort: 0, dataDir, ...rest });
}

export async function waitFor(predicate, { timeoutMs = 5000, stepMs = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

/** Resolves with the first bus event of `type` (id > sinceId) matching `pred`, past or future. */
export function waitEvent(bus, type, { pred = () => true, sinceId = 0, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const match = (e) => e.type === type && e.id > sinceId && pred(e);
    const past = bus.recent().find(match);
    if (past) return resolve(past);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for event ${type}`));
    }, timeoutMs);
    const off = bus.on((e) => {
      if (!match(e)) return;
      clearTimeout(timer);
      off();
      resolve(e);
    });
    return undefined;
  });
}

export const lastEventId = (bus) => bus.recent(1)[0]?.id ?? 0;

/** Rejects if `promise` does not settle within `ms`. */
export function within(promise, ms, what = 'operation') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms);
    }),
  ]);
}

/**
 * Raw SLCP client to send hand-made (and malformed) frames.
 * `next(type)` resolves with the next not-yet-consumed frame of that type.
 */
export function rawClient(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });
    const decoder = new FrameDecoder();
    const frames = [];
    const taken = new Set();
    const waiters = new Set();
    let isClosed = false;
    const wake = () => {
      for (const w of [...waiters]) w();
    };
    const closed = new Promise((res) => {
      socket.on('close', () => {
        isClosed = true;
        wake();
        res();
      });
    });
    socket.on('error', () => {}); // RST from the server is expected in some tests
    socket.on('data', (chunk) => {
      for (const f of decoder.push(chunk)) frames.push(f);
      wake();
    });

    const api = {
      socket,
      frames,
      closed,
      get isClosed() {
        return isClosed;
      },
      send(buf) {
        socket.write(buf);
      },
      json(type, obj) {
        socket.write(jsonFrame(type, obj));
      },
      next(type, timeoutMs = 3000) {
        return new Promise((res, rej) => {
          let timer = null;
          const cleanup = () => {
            clearTimeout(timer);
            waiters.delete(check);
          };
          function check() {
            const i = frames.findIndex((f, idx) => !taken.has(idx) && (type === undefined || f.type === type));
            if (i >= 0) {
              taken.add(i);
              cleanup();
              res(frames[i]);
              return true;
            }
            if (isClosed) {
              cleanup();
              rej(new Error(`Socket closed before frame type ${type}`));
              return true;
            }
            return false;
          }
          if (check()) return;
          waiters.add(check);
          timer = setTimeout(() => {
            cleanup();
            rej(new Error(`Timed out waiting for frame type ${type}`));
          }, timeoutMs);
        });
      },
      async nextJson(type, timeoutMs) {
        return parseJson((await api.next(type, timeoutMs)).body);
      },
      destroy() {
        socket.destroy();
      },
    };

    socket.once('connect', () => resolve(api));
    socket.once('error', reject);
  });
}

/** UDP socket bound on 127.0.0.1:0 that records every datagram it receives. */
export function udpClient() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4' });
    const received = []; // {buf, rinfo}
    const taken = new Set();
    socket.on('message', (buf, rinfo) => received.push({ buf, rinfo }));
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      socket.on('error', () => {});
      resolve({
        socket,
        port: socket.address().port,
        received,
        send(buf, port) {
          return new Promise((res) => socket.send(buf, port, '127.0.0.1', () => res()));
        },
        /** Next not-yet-consumed datagram accepted by `pred(buf)`. */
        async next(pred = () => true, timeoutMs = 3000) {
          const end = Date.now() + timeoutMs;
          for (;;) {
            const i = received.findIndex((m, idx) => !taken.has(idx) && pred(m.buf));
            if (i >= 0) {
              taken.add(i);
              return received[i].buf;
            }
            if (Date.now() > end) throw new Error('Timed out waiting for a datagram');
            await sleep(10);
          }
        },
        close() {
          return new Promise((res) => {
            try {
              socket.close(() => res());
            } catch {
              res();
            }
          });
        },
      });
    });
  });
}

/** Minimal HTTP client (no keep-alive, so nothing lingers). Resolves {status, headers, text, json()}. */
export function request(port, { method = 'GET', path: urlPath = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: h }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const postJson = (port, urlPath, obj) =>
  request(port, { method: 'POST', path: urlPath, body: typeof obj === 'string' ? obj : JSON.stringify(obj), headers: { 'Content-Type': 'application/json' } });
