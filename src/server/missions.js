// Default patrol missions, so "mission" works without any waypoint.
import { homeFor } from '../config.js';

const ALT = 40;

/**
 * Drones 1-4: a 300 m square starting at the base and heading to the centre of the area.
 * Other drones: a diamond of radius 120 m around the base.
 */
export function defaultMission(droneId) {
  const { x, y } = homeFor(droneId);
  if (droneId <= 4) {
    const dx = x < 500 ? 300 : -300;
    const dy = y < 500 ? 300 : -300;
    return [
      { x, y, alt: ALT },
      { x: x + dx, y, alt: ALT },
      { x: x + dx, y: y + dy, alt: ALT },
      { x, y: y + dy, alt: ALT },
    ];
  }
  const r = 120;
  return [
    { x, y: y - r, alt: ALT },
    { x: x + r, y, alt: ALT },
    { x, y: y + r, alt: ALT },
    { x: x - r, y, alt: ALT },
  ];
}
