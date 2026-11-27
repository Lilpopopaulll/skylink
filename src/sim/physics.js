// Drone flight model: pure functions, no timers, no I/O. Units: metres, seconds, degrees.
// Coordinates: x east, y "south" on the map; heading = atan2(dx, dy) in degrees (0 = +y, 90 = +x).
import { STATES } from '../protocol/sltp.js';

export const MAX_SPEED = 15; // m/s
export const CLIMB = 4; // m/s
export const DESCEND = 3; // m/s
export const CRUISE_ALT = 40; // m
export const DRAIN_FLY = 0.08; // % per second, only while not LANDED
export const LOW_BATTERY = 20; // % : below or at this the drone returns home on its own
export const ARRIVE_M = 2; // m : intermediate mission waypoints are "reached" inside this radius

/** State name -> numeric code used on the wire (index in STATES). */
export const S = Object.freeze(Object.fromEntries(STATES.map((name, i) => [name, i])));

const EPS = 1e-9;

export function makeState(home) {
  return {
    x: home.x, y: home.y, alt: 0, speed: 0, heading: 0, battery: 100, state: S.LANDED,
    target: null, waypoints: [], home: { x: home.x, y: home.y },
  };
}

export function cloneState(s) {
  return {
    ...s,
    target: s.target ? { ...s.target } : null,
    waypoints: s.waypoints.map((w) => ({ ...w })),
    home: { ...s.home },
  };
}

// ---- commands (mutate the state they receive) ----------------------------------------------------

export function beginTakeoff(s, alt = CRUISE_ALT) {
  s.state = S.TAKEOFF;
  s.target = { x: s.x, y: s.y, alt };
  s.waypoints = [];
}

export function beginGoto(s, x, y, alt = CRUISE_ALT) {
  s.state = S.GOTO;
  s.target = { x, y, alt };
  s.waypoints = [];
}

export function beginMission(s, waypoints) {
  s.state = S.MISSION;
  s.waypoints = waypoints.map((w) => ({ x: w.x, y: w.y, alt: w.alt ?? CRUISE_ALT }));
  s.target = null;
}

export function beginRth(s) {
  s.state = S.RTH;
  s.target = { x: s.home.x, y: s.home.y, alt: CRUISE_ALT };
  s.waypoints = [];
}

export function beginLand(s) {
  s.state = S.LANDING;
  s.target = null;
  s.waypoints = [];
}

// ---- integration helpers -------------------------------------------------------------------------

/** Move altitude toward `target`; returns true once it is there. */
function climbTo(s, target, dt) {
  const diff = target - s.alt;
  const step = (diff >= 0 ? CLIMB : DESCEND) * dt;
  if (Math.abs(diff) <= step + EPS) {
    s.alt = target;
    return true;
  }
  s.alt += Math.sign(diff) * step;
  return false;
}

/** Move horizontally toward (tx, ty) at MAX_SPEED, snapping on arrival; returns true once there. */
function moveTo(s, tx, ty, dt) {
  const dx = tx - s.x;
  const dy = ty - s.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= EPS) {
    s.speed = 0;
    return true;
  }
  s.heading = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  const step = MAX_SPEED * dt;
  if (step >= dist - EPS) {
    s.x = tx;
    s.y = ty;
    s.speed = dt > 0 ? dist / dt : 0;
    return true;
  }
  s.x += (dx / dist) * step;
  s.y += (dy / dist) * step;
  s.speed = MAX_SPEED;
  return false;
}

/**
 * Advance the drone by `dt` seconds. Pure: `prev` is not modified.
 * @returns {{s: object, events: Array<'reached'|'mission-done'|'landed'|'low-battery'>}}
 */
export function stepDrone(prev, dt) {
  const s = cloneState(prev);
  const events = [];
  if (s.state === S.LANDED) {
    s.speed = 0; // no drain on the ground
    return { s, events };
  }

  s.battery = Math.max(0, s.battery - DRAIN_FLY * dt);
  if (s.battery <= LOW_BATTERY && s.state !== S.RTH && s.state !== S.LANDING) {
    beginRth(s);
    events.push('low-battery'); // once: the state is now RTH/LANDING/LANDED until the next takeoff
  }

  switch (s.state) {
    case S.TAKEOFF: {
      s.speed = 0;
      if (climbTo(s, s.target.alt, dt)) {
        s.state = S.HOVER;
        s.target = null;
        events.push('reached');
      }
      break;
    }
    case S.HOVER:
      s.speed = 0;
      break;
    case S.GOTO: {
      const h = moveTo(s, s.target.x, s.target.y, dt);
      const v = climbTo(s, s.target.alt, dt);
      if (h && v) {
        s.state = S.HOVER;
        s.target = null;
        s.speed = 0;
        events.push('reached');
      }
      break;
    }
    case S.MISSION: {
      const w = s.waypoints[0];
      if (!w) {
        s.state = S.HOVER;
        s.speed = 0;
        events.push('mission-done');
        break;
      }
      const last = s.waypoints.length === 1;
      if (!last && Math.hypot(w.x - s.x, w.y - s.y) <= ARRIVE_M) {
        s.waypoints.shift(); // fly through intermediate waypoints without stopping
        break;
      }
      const h = moveTo(s, w.x, w.y, dt);
      const v = climbTo(s, w.alt, dt);
      if (last && h && v) {
        s.waypoints = [];
        s.state = S.HOVER;
        s.speed = 0;
        events.push('mission-done');
      }
      break;
    }
    case S.RTH: {
      const nearHome = Math.hypot(s.home.x - s.x, s.home.y - s.y) <= ARRIVE_M;
      if (s.alt < CRUISE_ALT - EPS && !nearHome) {
        s.speed = 0;
        climbTo(s, CRUISE_ALT, dt); // climb to cruise altitude first
      } else if (moveTo(s, s.home.x, s.home.y, dt)) {
        s.state = S.LANDING;
        s.target = null;
        s.speed = 0;
      }
      break;
    }
    case S.LANDING: {
      s.speed = 0;
      if (climbTo(s, 0, dt)) {
        s.state = S.LANDED;
        s.alt = 0;
        events.push('landed');
      }
      break;
    }
    default:
      break;
  }
  return { s, events };
}
