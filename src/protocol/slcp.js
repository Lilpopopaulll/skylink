// SLCP framing over TCP: len (u32 BE) | type (u8) | body (len - 1 bytes). Pure, no network.
import { CONFIG } from '../config.js';

export const T = Object.freeze({
  HELLO: 0x01,
  WELCOME: 0x02,
  COMMAND: 0x10,
  COMMAND_ACK: 0x11,
  LOG_BEGIN: 0x20,
  LOG_CHUNK: 0x21,
  LOG_ACK: 0x22,
  LOG_DONE: 0x23,
  PING: 0x30,
  PONG: 0x31,
  ERROR: 0x7f,
});

export const TYPE_NAMES = Object.freeze(Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k])));

/** Codes: BAD_FRAME, FRAME_TOO_BIG, EMPTY_FRAME, BAD_JSON, NOT_HELLO, UNKNOWN_TYPE, BAD_OFFSET, BAD_LOG. */
export class ProtocolError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function encodeFrame(type, body = Buffer.alloc(0), maxLen = CONFIG.maxFrameLen) {
  if (!Number.isInteger(type) || type < 0 || type > 255) {
    throw new RangeError(`Frame type out of range: ${type}`);
  }
  const len = 1 + body.length;
  if (len > maxLen) throw new ProtocolError('FRAME_TOO_BIG', `Frame length ${len} exceeds ${maxLen}`);
  const out = Buffer.allocUnsafe(4 + len);
  out.writeUInt32BE(len, 0);
  out[4] = type;
  body.copy(out, 5);
  return out;
}

/**
 * Incremental decoder for a TCP byte stream. Handles frames split across
 * several pushes and several frames glued in one push. The length header is
 * validated as soon as its 4 bytes are available, before any body arrives.
 * On error, `err.frames` holds the frames decoded before the faulty header.
 */
export class FrameDecoder {
  constructor({ maxLen = CONFIG.maxFrameLen } = {}) {
    this.maxLen = maxLen;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames = [];
    let pos = 0;
    while (this.buf.length - pos >= 4) {
      const len = this.buf.readUInt32BE(pos);
      if (len === 0 || len > this.maxLen) {
        const err =
          len === 0
            ? new ProtocolError('EMPTY_FRAME', 'Frame length is 0')
            : new ProtocolError('FRAME_TOO_BIG', `Frame length ${len} exceeds ${this.maxLen}`);
        err.frames = frames;
        this.buf = Buffer.alloc(0);
        throw err;
      }
      if (this.buf.length - pos - 4 < len) break; // body not complete yet
      const type = this.buf[pos + 4];
      const body = Buffer.from(this.buf.subarray(pos + 5, pos + 4 + len)); // copy: do not pin the big buffer
      frames.push({ type, body });
      pos += 4 + len;
    }
    this.buf = pos >= this.buf.length ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(pos));
    return frames;
  }
}

/** Frame with a compact JSON body. */
export function jsonFrame(type, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > CONFIG.maxJsonBody) {
    throw new ProtocolError('BAD_JSON', `JSON body ${body.length} bytes exceeds ${CONFIG.maxJsonBody}`);
  }
  return encodeFrame(type, body);
}

/** Parse a JSON body; only plain objects are accepted. */
export function parseJson(body) {
  let v;
  try {
    v = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ProtocolError('BAD_JSON', 'Body is not valid JSON');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ProtocolError('BAD_JSON', 'JSON body must be an object');
  }
  return v;
}

/** Complete LOG_CHUNK frame: u32 BE offset | data (1..logChunk bytes). */
export function encodeLogChunk(offset, data) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) {
    throw new RangeError(`Chunk offset out of range: ${offset}`);
  }
  if (data.length < 1 || data.length > CONFIG.logChunk) {
    throw new RangeError(`Chunk data must be 1..${CONFIG.logChunk} bytes, got ${data.length}`);
  }
  const body = Buffer.allocUnsafe(4 + data.length);
  body.writeUInt32BE(offset, 0);
  data.copy(body, 4);
  return encodeFrame(T.LOG_CHUNK, body);
}

export function decodeLogChunk(body) {
  if (body.length < 5) throw new ProtocolError('BAD_FRAME', `LOG_CHUNK body too short (${body.length})`);
  return { offset: body.readUInt32BE(0), data: body.subarray(4) };
}

/** Human summary used by the protocol inspector. Never throws. */
export function describeFrame(type, body) {
  const name = TYPE_NAMES[type] ?? `0x${type.toString(16).padStart(2, '0')}`;
  let info = '';
  try {
    if (type === T.LOG_CHUNK) {
      const { offset, data } = decodeLogChunk(body);
      info = `off=${offset} len=${data.length}`;
    } else {
      const j = parseJson(body);
      switch (type) {
        case T.HELLO: info = `${j.name ?? `drone ${j.droneId}`}${j.sessionId ? ' resumed' : ''}`; break;
        case T.WELCOME: info = `${j.resumed ? 'resumed' : 'new session'} queued=${j.queued ?? 0}`; break;
        case T.COMMAND: info = `${j.action} #${j.cmdId}`; break;
        case T.COMMAND_ACK: info = `#${j.cmdId} ${j.status}`; break;
        case T.LOG_BEGIN: info = `${j.logId} size=${j.size}`; break;
        case T.LOG_ACK: info = `offset=${j.offset}`; break;
        case T.LOG_DONE: info = `ok=${j.ok}`; break;
        case T.PING:
        case T.PONG: info = `n=${j.n}`; break;
        case T.ERROR: info = String(j.code); break;
        default: info = '';
      }
    }
  } catch {
    info = '(undecodable)';
  }
  return { type: name, info };
}
