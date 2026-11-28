// Pure incident detection for the drone simulator: no timers, no network.
import { S } from './physics.js';

export const BATTERY_LOW_PCT = 30;
export const BATTERY_CRITICAL_PCT = 10;

/**
 * Kinds newly detected in physical state `s` (makeState shape), skipping those in `raised` (Set).
 * motor_failure and gps_degraded are never detected here: they only come from injection.
 * Pure.
 * @returns {string[]}
 */
export function detectIncidents(s, area, raised) {
  const out = [];
  if (s.battery <= BATTERY_CRITICAL_PCT && !raised.has('battery_critical')) {
    out.push('battery_critical');
  } else if (
    s.battery <= BATTERY_LOW_PCT &&
    !raised.has('battery_low') &&
    !raised.has('battery_critical')
  ) {
    out.push('battery_low');
  }
  if (
    s.state !== S.LANDED &&
    (s.x < 0 || s.y < 0 || s.x > area.w || s.y > area.h) &&
    !raised.has('geofence_breach')
  ) {
    out.push('geofence_breach');
  }
  return out;
}
