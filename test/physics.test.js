import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  S, makeState, stepDrone, beginTakeoff, beginGoto, beginMission, LOW_BATTERY,
} from '../src/sim/physics.js';
import { mulberry32 } from '../src/sim/rng.js';
import { makeFlightLog, sha256 } from '../src/sim/flightlog.js';
import { STATES } from '../src/protocol/sltp.js';

const DT = 0.1;

/** Step until `until(events)` is true or `maxSec` elapsed. Returns the final state, time and all events seen. */
function run(s0, until, maxSec = 300) {
  let s = s0;
  let t = 0;
  const seen = [];
  while (t < maxSec) {
    const r = stepDrone(s, DT);
    s = r.s;
    t += DT;
    seen.push(...r.events);
    if (until(r.events)) break;
  }
  return { s, t, seen };
}

function airborne(x = 150, y = 150, battery = 100) {
  const s = makeState({ x: 150, y: 150 });
  s.x = x;
  s.y = y;
  s.alt = 40;
  s.state = S.HOVER;
  s.battery = battery;
  return s;
}

test('S matches the wire STATES table', () => {
  for (const [i, name] of STATES.entries()) assert.equal(S[name], i);
});

test('takeoff climbs 0 -> 40 m in about 10 s and reports reached', () => {
  const s = makeState({ x: 150, y: 150 });
  beginTakeoff(s, 40);
  const r = run(s, (ev) => ev.includes('reached'));
  assert.ok(r.t >= 9.9 && r.t <= 10.6, `took ${r.t.toFixed(1)} s`);
  assert.equal(r.s.alt, 40);
  assert.equal(r.s.state, S.HOVER);
});

test('stepDrone is pure', () => {
  const s = makeState({ x: 1, y: 2 });
  beginTakeoff(s, 40);
  const before = JSON.stringify(s);
  stepDrone(s, 1);
  assert.equal(JSON.stringify(s), before);
});

test('goto 300 m at 15 m/s is reached in 20-22 s', () => {
  const s = airborne();
  beginGoto(s, 450, 150, 40);
  const r = run(s, (ev) => ev.includes('reached'));
  assert.ok(r.t >= 20 && r.t <= 22, `took ${r.t.toFixed(1)} s`);
  assert.equal(r.s.x, 450);
  assert.equal(r.s.y, 150);
  assert.equal(r.s.state, S.HOVER);
  assert.equal(r.seen.filter((e) => e === 'reached').length, 1);
});

test('mission of 4 waypoints ends with a single mission-done at the last point', () => {
  const s = airborne();
  const wps = [
    { x: 450, y: 150, alt: 40 }, { x: 450, y: 450, alt: 40 }, { x: 150, y: 450, alt: 40 }, { x: 150, y: 150, alt: 40 },
  ];
  beginMission(s, wps);
  const r = run(s, (ev) => ev.includes('mission-done'));
  assert.equal(r.seen.filter((e) => e === 'mission-done').length, 1);
  assert.equal(r.s.x, 150);
  assert.equal(r.s.y, 150);
  assert.equal(r.s.state, S.HOVER);
  assert.ok(r.t > 60 && r.t < 100, `took ${r.t.toFixed(1)} s`); // 4 x 300 m at 15 m/s = 80 s
});

test('low battery triggers RTH once, then the drone lands and the battery stops draining', () => {
  const s = airborne(450, 150, LOW_BATTERY + 1);
  const first = run(s, (ev) => ev.includes('low-battery'), 60);
  assert.equal(first.seen.filter((e) => e === 'low-battery').length, 1);
  assert.equal(first.s.state, S.RTH);

  const second = run(first.s, (ev) => ev.includes('landed'), 120);
  assert.equal(second.seen.includes('low-battery'), false, 'low-battery must fire only once');
  assert.equal(second.seen.filter((e) => e === 'landed').length, 1);
  assert.equal(second.s.state, S.LANDED);
  assert.equal(second.s.alt, 0);
  assert.equal(second.s.x, 150); // back at the home base
  assert.equal(second.s.y, 150);

  const battery = second.s.battery;
  const third = run(second.s, () => false, 10);
  assert.equal(third.s.battery, battery, 'no drain on the ground');
  assert.equal(third.seen.length, 0);
});

test('battery never goes below 0', () => {
  const s = airborne(150, 150, 0.01);
  beginGoto(s, 900, 900, 40);
  const r = run(s, () => false, 5);
  assert.ok(r.s.battery >= 0);
});

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const va = Array.from({ length: 50 }, a);
  assert.deepEqual(va, Array.from({ length: 50 }, b));
  assert.notDeepEqual(va, Array.from({ length: 50 }, c));
  assert.ok(va.every((v) => v >= 0 && v < 1));
});

test('flight log is deterministic, exactly `size` bytes, with a stable SHA-256', () => {
  const a = makeFlightLog(3, 10000);
  const b = makeFlightLog(3, 10000);
  assert.equal(a.length, 10000);
  assert.ok(a.equals(b));
  assert.equal(sha256(a), sha256(b));
  assert.ok(!a.equals(makeFlightLog(4, 10000)));
  assert.equal(makeFlightLog(3, 100).length, 100);
  assert.match(sha256(a), /^[0-9a-f]{64}$/);
});
