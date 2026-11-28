import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  T, TYPE_NAMES, ProtocolError, FrameDecoder, encodeFrame, jsonFrame, parseJson,
  encodeLogChunk, decodeLogChunk, describeFrame, ALERT_KINDS, SEVERITIES,
} from '../src/protocol/slcp.js';

test('encodeFrame/FrameDecoder roundtrip', () => {
  const dec = new FrameDecoder({ maxLen: 20000 });
  const frames = dec.push(encodeFrame(T.PING, Buffer.from('abc')));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, T.PING);
  assert.equal(frames[0].body.toString(), 'abc');
  assert.equal(TYPE_NAMES[T.PING], 'PING');
});

test('three frames concatenated in one push', () => {
  const dec = new FrameDecoder({ maxLen: 20000 });
  const buf = Buffer.concat([
    encodeFrame(T.PING, Buffer.from('1')),
    encodeFrame(T.PONG, Buffer.from('22')),
    encodeFrame(T.ERROR, Buffer.alloc(0)),
  ]);
  const frames = dec.push(buf);
  assert.deepEqual(frames.map((f) => f.type), [T.PING, T.PONG, T.ERROR]);
  assert.equal(frames[1].body.toString(), '22');
  assert.equal(frames[2].body.length, 0);
});

test('frame split byte by byte', () => {
  const dec = new FrameDecoder({ maxLen: 20000 });
  const buf = encodeFrame(T.COMMAND, Buffer.from('{"cmdId":1}'));
  const out = [];
  for (const byte of buf) out.push(...dec.push(Buffer.from([byte])));
  assert.equal(out.length, 1);
  assert.equal(out[0].body.toString(), '{"cmdId":1}');
});

test('header split in two pushes (2 bytes, then the rest)', () => {
  const dec = new FrameDecoder({ maxLen: 20000 });
  const buf = encodeFrame(T.PONG, Buffer.from('xyz'));
  assert.deepEqual(dec.push(buf.subarray(0, 2)), []);
  const frames = dec.push(buf.subarray(2));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].body.toString(), 'xyz');
});

test('len = maxLen + 1 -> FRAME_TOO_BIG before any body, earlier frames kept in err.frames', () => {
  const dec = new FrameDecoder({ maxLen: 20000 });
  const bad = Buffer.alloc(4);
  bad.writeUInt32BE(20001, 0);
  const buf = Buffer.concat([encodeFrame(T.PING, Buffer.from('ok')), bad]);
  assert.throws(
    () => dec.push(buf),
    (err) => {
      assert.ok(err instanceof ProtocolError);
      assert.equal(err.code, 'FRAME_TOO_BIG');
      assert.equal(err.frames.length, 1);
      assert.equal(err.frames[0].body.toString(), 'ok');
      return true;
    },
  );
});

test('len = 0 -> EMPTY_FRAME', () => {
  const dec = new FrameDecoder({ maxLen: 20000 });
  assert.throws(() => dec.push(Buffer.alloc(4)), (err) => err.code === 'EMPTY_FRAME' && err.frames.length === 0);
});

test('encodeFrame refuses frames over maxLen', () => {
  assert.throws(() => encodeFrame(T.PING, Buffer.alloc(100), 50), (err) => err.code === 'FRAME_TOO_BIG');
});

test('parseJson accepts objects only', () => {
  assert.deepEqual(parseJson(Buffer.from('{"a":1}')), { a: 1 });
  assert.throws(() => parseJson(Buffer.from('[1]')), (err) => err.code === 'BAD_JSON');
  assert.throws(() => parseJson(Buffer.from('{x')), (err) => err.code === 'BAD_JSON');
  assert.throws(() => parseJson(Buffer.from('null')), (err) => err.code === 'BAD_JSON');
});

test('jsonFrame is compact and refuses oversized bodies', () => {
  const f = jsonFrame(T.WELCOME, { sessionId: 'a1b2c3d4', resumed: true, queued: 1 });
  const [frame] = new FrameDecoder({ maxLen: 20000 }).push(f);
  assert.equal(frame.body.toString(), '{"sessionId":"a1b2c3d4","resumed":true,"queued":1}');
  assert.throws(() => jsonFrame(T.ERROR, { message: 'x'.repeat(5000) }), (err) => err.code === 'BAD_JSON');
});

test('log chunk of 16384 bytes roundtrips, offset is u32 BE', () => {
  const data = Buffer.alloc(16384);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
  const frame = encodeLogChunk(0xfffff000, data);
  const [f] = new FrameDecoder({ maxLen: 20000 }).push(frame);
  assert.equal(f.type, T.LOG_CHUNK);
  const { offset, data: back } = decodeLogChunk(f.body);
  assert.equal(offset, 0xfffff000);
  assert.ok(back.equals(data));
  assert.throws(() => decodeLogChunk(Buffer.alloc(4)), (err) => err.code === 'BAD_FRAME');
  assert.throws(() => encodeLogChunk(0, Buffer.alloc(16385)), RangeError);
});

test('describeFrame', () => {
  const body = (o) => Buffer.from(JSON.stringify(o));
  assert.deepEqual(describeFrame(T.COMMAND, body({ cmdId: 3, action: 'takeoff', params: { alt: 40 } })), { type: 'COMMAND', info: 'takeoff #3' });
  assert.equal(describeFrame(T.COMMAND_ACK, body({ cmdId: 3, status: 'accepted' })).info, '#3 accepted');
  assert.equal(describeFrame(T.LOG_ACK, body({ offset: 49152 })).info, 'offset=49152');
  assert.equal(describeFrame(T.LOG_DONE, body({ ok: true })).info, 'ok=true');
  assert.equal(describeFrame(T.PING, body({ n: 12, t: 1 })).info, 'n=12');
  assert.equal(describeFrame(T.HELLO, body({ droneId: 3, name: 'Charlie', sessionId: 'a1b2c3d4' })).info, 'Charlie resumed');
  assert.equal(describeFrame(T.ERROR, body({ code: 'BAD_OFFSET' })).info, 'BAD_OFFSET');
  const chunk = encodeLogChunk(32768, Buffer.alloc(16384)).subarray(5);
  assert.equal(describeFrame(T.LOG_CHUNK, chunk).info, 'off=32768 len=16384');
  assert.equal(describeFrame(T.PING, Buffer.from('nope')).info, '(undecodable)');
});

test('ALERT / ALERT_ACK: codes, kinds table, describeFrame', () => {
  const body = (o) => Buffer.from(JSON.stringify(o));
  assert.equal(T.ALERT, 0x40);
  assert.equal(TYPE_NAMES[0x41], 'ALERT_ACK');
  assert.equal(Object.keys(ALERT_KINDS).length, 5);
  for (const sev of Object.values(ALERT_KINDS)) assert.ok(SEVERITIES.includes(sev));
  assert.equal(describeFrame(T.ALERT, body({ alertId: 2, kind: 'motor_failure', severity: 'critical' })).info, 'motor_failure critical #2');
  assert.equal(describeFrame(T.ALERT_ACK, body({ alertId: 2, action: 'land', cmdId: 14 })).info, '#2 land cmd #14');
  assert.equal(describeFrame(T.ALERT_ACK, body({ alertId: 1, action: null, cmdId: null })).info, '#1 logged');
});
