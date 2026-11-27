import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeqStats, RttTracker } from '../src/protocol/stats.js';

function feed(stats, seqs, { dtMs = 100, extra = () => 0 } = {}) {
  seqs.forEach((seq, i) => stats.onPacket(seq, i * dtMs, 1000 + i * dtMs + extra(i)));
  return stats.snapshot();
}

test('seq 1..100 without gaps -> no loss', () => {
  const s = feed(new SeqStats(), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(s.received, 100);
  assert.equal(s.expected, 100);
  assert.equal(s.lost, 0);
  assert.equal(s.lossPct, 0);
  assert.equal(s.recentLossPct, 0);
  assert.equal(s.outOfOrder, 0);
});

test('100 sent, 10 dropped (the last one is delivered) -> lost=10, lossPct=10', () => {
  // A trailing loss cannot be detected, so the dropped seqs end in 5 and seq 100 arrives.
  const seqs = Array.from({ length: 100 }, (_, i) => i + 1).filter((n) => n % 10 !== 5);
  const s = feed(new SeqStats(), seqs);
  assert.equal(s.received, 90);
  assert.equal(s.expected, 100);
  assert.equal(s.lost, 10);
  assert.equal(s.lossPct, 10);
  assert.equal(s.recentLossPct, 10); // the last 100 numbers are exactly 1..100
});

test('recentLossPct only looks at the last 100 sequence numbers', () => {
  const stats = new SeqStats();
  // 1..100: drop 20 of the first 50; then 101..300 clean
  const seqs = [];
  for (let n = 1; n <= 300; n++) if (!(n <= 50 && n % 5 > 0 && n % 5 < 3 && n % 2 === 0) || n > 50) seqs.push(n);
  const s = feed(stats, seqs);
  assert.ok(s.lossPct > 0);
  assert.equal(s.recentLossPct, 0);
});

test('reordering 1,2,4,3 -> outOfOrder=1, lost=0', () => {
  const s = feed(new SeqStats(), [1, 2, 4, 3]);
  assert.equal(s.outOfOrder, 1);
  assert.equal(s.lost, 0);
  assert.equal(s.received, 4);
  assert.equal(s.recentLossPct, 0);
});

test('duplicates are counted, not double-counted as received', () => {
  const s = feed(new SeqStats(), [1, 2, 3, 3, 4, 2]);
  assert.equal(s.duplicates, 2);
  assert.equal(s.received, 4);
  assert.equal(s.lost, 0);
});

test('u32 sequence wrap is not a loss', () => {
  const s = feed(new SeqStats(), [0xfffffffe, 0xffffffff, 0, 1]);
  assert.equal(s.expected, 4);
  assert.equal(s.lost, 0);
  assert.equal(s.outOfOrder, 0);
});

test('constant transit -> jitter ~ 0', () => {
  const s = feed(new SeqStats(), Array.from({ length: 200 }, (_, i) => i + 1));
  assert.ok(s.jitterMs < 0.01, `jitter ${s.jitterMs}`);
});

test('transit alternating +0 / +10 ms -> jitter > 1 ms', () => {
  const s = feed(new SeqStats(), Array.from({ length: 200 }, (_, i) => i + 1), { extra: (i) => (i % 2 ? 10 : 0) });
  assert.ok(s.jitterMs > 1, `jitter ${s.jitterMs}`);
  assert.ok(s.jitterMs < 10);
});

test('sender timestamp wrap (2^32 ms) does not create a jitter spike', () => {
  const stats = new SeqStats();
  const base = 2 ** 32 - 300;
  for (let i = 0; i < 6; i++) stats.onPacket(i + 1, (base + i * 100) % 2 ** 32, 5000 + i * 100);
  assert.ok(stats.snapshot().jitterMs < 0.01);
});

test('pps ~ 10 for 10 packets in one second', () => {
  const stats = new SeqStats();
  for (let i = 0; i < 10; i++) stats.onPacket(i + 1, i * 100, i * 100);
  const { pps } = stats.snapshot();
  assert.ok(pps >= 9 && pps <= 11, `pps ${pps}`);
});

test('reset clears everything', () => {
  const stats = new SeqStats();
  feed(stats, [1, 2, 4]);
  stats.reset();
  const s = stats.snapshot();
  assert.equal(s.received, 0);
  assert.equal(s.expected, 0);
  assert.equal(s.lossPct, 0);
});

test('RttTracker: last and average of the last 20 values', () => {
  const r = new RttTracker();
  assert.equal(r.last, null);
  assert.equal(r.avg, null);
  r.add(1);
  r.add(3);
  assert.equal(r.last, 3);
  assert.equal(r.avg, 2);
  for (let i = 0; i < 20; i++) r.add(10);
  assert.equal(r.avg, 10);
  assert.equal(r.last, 10);
});
