// HTTP side of the station: static UI, JSON API, SSE state stream, command and chaos endpoints. node:http only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  const body = Buffer.from('Not found\n');
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Reads a small body; resolves {tooBig:true} as soon as the limit is crossed (the rest is discarded). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let settled = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on('data', (c) => {
      size += c.length;
      if (settled) return;
      if (size > limit) {
        parts.length = 0;
        settle({ tooBig: true });
      } else {
        parts.push(c);
      }
    });
    req.on('end', () => settle({ tooBig: false, text: Buffer.concat(parts).toString('utf8') }));
    req.on('error', (err) => (settled ? undefined : reject(err)));
  });
}

/** Maps a URL path to a file under publicDir, or null (traversal, absolute path, unknown extension). */
function resolveStatic(publicDir, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p === '/') p = '/index.html';
  if (p.includes('\0') || p.includes('\\') || !p.startsWith('/')) return null;
  const parts = p.split('/').slice(1);
  if (parts.some((s) => s === '..' || s === '.' || s === '')) return null;
  const type = TYPES.get(path.extname(p).toLowerCase());
  if (!type) return null;
  const full = path.resolve(publicDir, ...parts);
  if (!full.startsWith(publicDir + path.sep)) return null;
  return { file: full, type };
}

/** @returns {Promise<{port:number, close:Function}>} */
export function startHttp({ config, state, tcp, publicDir }) {
  const root = path.resolve(publicDir);
  const clients = new Set(); // open SSE responses
  const kaMs = config.kaMs ?? 15000;

  const stateTimer = setInterval(() => {
    if (clients.size === 0) return;
    const frame = `event: state\ndata: ${JSON.stringify(state.snapshot())}\n\n`;
    for (const res of clients) res.write(frame);
  }, config.sseMs);
  const kaTimer = setInterval(() => {
    for (const res of clients) res.write(': ka\n\n');
  }, kaMs);
  stateTimer.unref();
  kaTimer.unref();

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(state.snapshot())}\n\n`);
    clients.add(res);
    res.on('close', () => clients.delete(res));
  }

  /** Reads + parses a JSON object body. Returns the object, or null after having answered 413/400. */
  async function jsonBody(req, res) {
    // Only application/json: a web page cannot send it cross-origin without a CORS preflight (which we never allow).
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      res.setHeader('Connection', 'close');
      sendJson(res, 415, { error: 'Content-Type must be application/json' });
      return null;
    }
    const body = await readBody(req, config.maxJsonBody);
    if (body.tooBig) {
      res.setHeader('Connection', 'close');
      sendJson(res, 413, { error: `Body larger than ${config.maxJsonBody} bytes` });
      return null;
    }
    let data;
    try {
      data = JSON.parse(body.text);
    } catch {
      sendJson(res, 400, { error: 'Body must be JSON' });
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return null;
    }
    return data;
  }

  /** Runs a tcp.* call and maps its errors to HTTP statuses. Returns true if it answered with an error. */
  function answerError(res, err) {
    const code = err?.message;
    if (code === 'UNKNOWN_DRONE') sendJson(res, 404, { error: 'Unknown drone' });
    else if (code === 'BAD_ACTION' || code === 'BAD_PARAMS') sendJson(res, 400, { error: code });
    else sendJson(res, 500, { error: 'Internal error' });
  }

  async function handleCommand(req, res) {
    const data = await jsonBody(req, res);
    if (!data) return;
    if (!Number.isInteger(data.droneId)) return sendJson(res, 400, { error: 'droneId must be an integer' });
    if (typeof data.action !== 'string') return sendJson(res, 400, { error: 'action must be a string' });
    try {
      return sendJson(res, 202, tcp.sendCommand(data.droneId, data.action, data.params));
    } catch (err) {
      return answerError(res, err);
    }
  }

  async function handleChaos(req, res) {
    const data = await jsonBody(req, res);
    if (!data) return;
    if (!Number.isInteger(data.droneId)) return sendJson(res, 400, { error: 'droneId must be an integer' });
    if (!state.get(data.droneId)) return sendJson(res, 404, { error: 'Unknown drone' });
    if (data.kind === 'udp_loss') {
      try {
        tcp.sendCommand(data.droneId, 'set_udp_loss', { pct: data.pct });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return answerError(res, err);
      }
    }
    if (data.kind === 'cut_tcp') return sendJson(res, 200, { ok: tcp.cutTcp(data.droneId) });
    if (data.kind === 'fault') {
      try {
        const { cmdId, status } = tcp.sendCommand(data.droneId, 'inject_fault', { fault: data.fault });
        return sendJson(res, 200, { ok: true, cmdId, status });
      } catch (err) {
        return answerError(res, err);
      }
    }
    return sendJson(res, 400, { error: 'kind must be udp_loss, cut_tcp or fault' });
  }

  async function handle(req, res) {
    const p = String(req.url ?? '/').split('?')[0];
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/api/state') return sendJson(res, 200, state.snapshot());
      if (p === '/events' && req.method === 'GET') return handleEvents(req, res);
      const target = resolveStatic(root, p);
      if (!target) return notFound(res);
      let buf;
      try {
        buf = await fs.promises.readFile(target.file);
      } catch {
        return notFound(res);
      }
      res.writeHead(200, { 'Content-Type': target.type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    if (req.method === 'POST') {
      if (p === '/api/command') return handleCommand(req, res);
      if (p === '/api/chaos') return handleChaos(req, res);
    }
    return notFound(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.destroy();
    });
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, config.host, () => {
      server.off('error', reject);
      server.on('error', (err) => console.error(`HTTP server error: ${err.code ?? err.message}`)); // never crash
      resolve({
        port: server.address().port,
        close() {
          clearInterval(stateTimer);
          clearInterval(kaTimer);
          for (const res of clients) res.end();
          clients.clear();
          return new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
