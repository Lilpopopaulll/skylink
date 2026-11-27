// Deterministic fake flight log: telemetry-shaped 36-byte records, filled by a seeded PRNG.
import { createHash } from 'node:crypto';
import { mulberry32 } from './rng.js';
import { MAGIC, VERSION, DT, TELEMETRY_LEN } from '../protocol/sltp.js';

/** Same (seed, size) always gives the same bytes. The last record is truncated to `size`. */
export function makeFlightLog(seed, size) {
  if (!Number.isInteger(size) || size < 0) throw new RangeError(`Invalid log size: ${size}`);
  const rng = mulberry32(seed);
  const out = Buffer.alloc(size);
  const rec = Buffer.alloc(TELEMETRY_LEN);
  for (let off = 0, seq = 0; off < size; off += TELEMETRY_LEN, seq++) {
    rec.writeUInt16BE(MAGIC, 0);
    rec[2] = VERSION;
    rec[3] = DT.TELEMETRY;
    rec[4] = seed & 0xff;
    rec[5] = 0;
    rec.writeUInt32BE(seq >>> 0, 6);
    for (let i = 10; i < TELEMETRY_LEN; i++) rec[i] = Math.floor(rng() * 256);
    rec.copy(out, off, 0, Math.min(TELEMETRY_LEN, size - off));
  }
  return out;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
