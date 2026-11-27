// SLTP datagrams over UDP, big-endian everywhere. Pure, no network.
//   header (6): u16 magic 0x534C | u8 version | u8 type | u8 droneId | u8 flags
//   TELEMETRY (36): header | u32 seq | u32 tsMs | f32 x | f32 y | f32 alt | f32 speed | f32 heading | u8 battery | u8 state
//   ECHO_REQ / ECHO_REP (14): header | u32 echoSeq | u32 t0us

export const MAGIC = 0x534c;
export const VERSION = 1;
export const DT = Object.freeze({ TELEMETRY: 1, ECHO_REQ: 2, ECHO_REP: 3 });
export const STATES = Object.freeze(['LANDED', 'TAKEOFF', 'HOVER', 'GOTO', 'MISSION', 'RTH', 'LANDING']);
export const TELEMETRY_LEN = 36;
export const ECHO_LEN = 14;

function header(buf, type, droneId) {
  buf.writeUInt16BE(MAGIC, 0);
  buf[2] = VERSION;
  buf[3] = type;
  buf[4] = droneId & 0xff;
  buf[5] = 0; // flags
}

export function encodeTelemetry({ droneId, seq, tsMs, x, y, alt, speed, heading, battery, state }) {
  const b = Buffer.alloc(TELEMETRY_LEN);
  header(b, DT.TELEMETRY, droneId);
  b.writeUInt32BE(seq >>> 0, 6);
  b.writeUInt32BE(tsMs >>> 0, 10); // ms since drone start, mod 2^32
  b.writeFloatBE(x, 14);
  b.writeFloatBE(y, 18);
  b.writeFloatBE(alt, 22);
  b.writeFloatBE(speed, 26);
  b.writeFloatBE(heading, 30);
  b[34] = Math.max(0, Math.min(255, Math.round(battery)));
  b[35] = state & 0xff;
  return b;
}

export function encodeEcho(type, droneId, echoSeq, t0us) {
  if (type !== DT.ECHO_REQ && type !== DT.ECHO_REP) throw new RangeError(`Not an echo type: ${type}`);
  const b = Buffer.alloc(ECHO_LEN);
  header(b, type, droneId);
  b.writeUInt32BE(echoSeq >>> 0, 6);
  b.writeUInt32BE(t0us >>> 0, 10);
  return b;
}

/** Returns the decoded datagram, or null if length / magic / version / type is invalid. */
export function decodeDatagram(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) return null;
  if (buf.readUInt16BE(0) !== MAGIC || buf[2] !== VERSION) return null;
  const type = buf[3];
  const droneId = buf[4];
  const flags = buf[5];
  if (type === DT.TELEMETRY) {
    if (buf.length !== TELEMETRY_LEN) return null;
    return {
      type,
      droneId,
      flags,
      seq: buf.readUInt32BE(6),
      tsMs: buf.readUInt32BE(10),
      x: buf.readFloatBE(14),
      y: buf.readFloatBE(18),
      alt: buf.readFloatBE(22),
      speed: buf.readFloatBE(26),
      heading: buf.readFloatBE(30),
      battery: buf[34],
      state: buf[35],
    };
  }
  if (type === DT.ECHO_REQ || type === DT.ECHO_REP) {
    if (buf.length !== ECHO_LEN) return null;
    return { type, droneId, flags, echoSeq: buf.readUInt32BE(6), t0us: buf.readUInt32BE(10) };
  }
  return null;
}

/** Server/drone clock in microseconds, truncated to u32 (wraps every ~71.6 minutes). */
export function nowUs() {
  return Number((process.hrtime.bigint() / 1000n) & 0xffffffffn);
}
