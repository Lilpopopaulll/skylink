import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAGIC, DT, STATES, TELEMETRY_LEN, ECHO_LEN, encodeTelemetry, encodeEcho, decodeDatagram, nowUs,
} from '../src/protocol/sltp.js';

const sample = {
  droneId: 3, seq: 4242, tsMs: 123456, x: 150.123, y: 849.987, alt: 40.5, speed: 12.345, heading: 359.9, battery: 93, state: 4,
};

test('TELEMETRY roundtrip, 36 bytes, magic 53 4C', () => {
  const buf = encodeTelemetry(sample);
  assert.equal(buf.length, TELEMETRY_LEN);
  assert.equal(buf.length, 36);
  assert.equal(buf[0], 0x53);
  assert.equal(buf[1], 0x4c);
  assert.equal(buf.readUInt16BE(0), MAGIC);
  assert.equal(buf[2], 1); // version
  assert.equal(buf[3], DT.TELEMETRY);
  const d = decodeDatagram(buf);
  assert.equal(d.type, DT.TELEMETRY);
  assert.equal(d.droneId, 3);
  assert.equal(d.seq, 4242);
  assert.equal(d.tsMs, 123456);
  for (const k of ['x', 'y', 'alt', 'speed', 'heading']) assert.equal(d[k], Math.fround(sample[k]), k);
  assert.equal(d.battery, 93);
  assert.equal(d.state, 4);
  assert.equal(STATES[d.state], 'MISSION');
  assert.equal(STATES.length, 7);
});

test('floats are big-endian on the wire', () => {
  const buf = encodeTelemetry({ ...sample, x: 1 });
  assert.deepEqual([...buf.subarray(14, 18)], [0x3f, 0x80, 0x00, 0x00]);
});

test('u32 fields wrap modulo 2^32', () => {
  const d = decodeDatagram(encodeTelemetry({ ...sample, seq: 0xffffffff, tsMs: 2 ** 32 + 5 }));
  assert.equal(d.seq, 0xffffffff);
  assert.equal(d.tsMs, 5);
});

test('ECHO roundtrip, 14 bytes', () => {
  for (const type of [DT.ECHO_REQ, DT.ECHO_REP]) {
    const buf = encodeEcho(type, 4, 17, 0xfedcba98);
    assert.equal(buf.length, ECHO_LEN);
    assert.equal(buf.length, 14);
    assert.deepEqual(decodeDatagram(buf), { type, droneId: 4, flags: 0, echoSeq: 17, t0us: 0xfedcba98 });
  }
  assert.throws(() => encodeEcho(DT.TELEMETRY, 1, 1, 1), RangeError);
});

test('decodeDatagram returns null for invalid datagrams', () => {
  const good = encodeTelemetry(sample);
  const badMagic = Buffer.from(good);
  badMagic[0] = 0x00;
  assert.equal(decodeDatagram(badMagic), null);
  assert.equal(decodeDatagram(good.subarray(0, 35)), null);
  assert.equal(decodeDatagram(Buffer.concat([good, Buffer.alloc(1)])), null);
  const v2 = Buffer.from(good);
  v2[2] = 2;
  assert.equal(decodeDatagram(v2), null);
  const badType = Buffer.from(good);
  badType[3] = 9;
  assert.equal(decodeDatagram(badType), null);
  assert.equal(decodeDatagram(Buffer.alloc(3)), null);
  assert.equal(decodeDatagram(encodeEcho(DT.ECHO_REQ, 1, 1, 1).subarray(0, 13)), null);
});

test('nowUs is a u32 and RTT uses unsigned subtraction', () => {
  const t = nowUs();
  assert.ok(Number.isInteger(t) && t >= 0 && t <= 0xffffffff);
  // wrap: t0 near the top, now just after the wrap -> small positive RTT
  assert.equal((5 - 0xfffffffb) >>> 0, 10);
});
