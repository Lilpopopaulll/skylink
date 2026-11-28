import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIncidents } from '../src/sim/incidents.js';
import { S } from '../src/sim/physics.js';

const AREA = { w: 1000, h: 1000 };
const at = (battery) => ({ x: 500, y: 500, state: S.MISSION, battery });

test('detectIncidents: battery thresholds, critical supersedes low, raised kinds are skipped', () => {
  assert.deepEqual(detectIncidents(at(31), AREA, new Set()), []);
  assert.deepEqual(detectIncidents(at(30), AREA, new Set()), ['battery_low']);
  assert.deepEqual(detectIncidents(at(9), AREA, new Set()), ['battery_critical']);
  assert.deepEqual(detectIncidents(at(9), AREA, new Set(['battery_critical'])), []);
  assert.deepEqual(detectIncidents(at(25), AREA, new Set(['battery_low'])), []);
});

test('detectIncidents: geofence only when airborne and outside the area', () => {
  assert.deepEqual(detectIncidents({ x: 1005, y: 500, state: S.MISSION, battery: 90 }, AREA, new Set()), ['geofence_breach']);
  assert.deepEqual(detectIncidents({ x: 1005, y: 500, state: S.LANDED, battery: 90 }, AREA, new Set()), []);
  assert.deepEqual(detectIncidents({ x: 1000, y: 500, state: S.MISSION, battery: 90 }, AREA, new Set()), []);
});
