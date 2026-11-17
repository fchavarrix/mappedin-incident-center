import type { Feature, Polygon } from '@mappedin/mappedin-js';

/** Small-area geometry in metres: enough for a mall (no projection error worth caring about). */
export type LL = { latitude: number; longitude: number };

const M_LAT = 111_320;
const mLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

export function metres(a: LL, b: LL) {
  const dx = (b.longitude - a.longitude) * mLon(a.latitude);
  const dy = (b.latitude - a.latitude) * M_LAT;
  return Math.hypot(dx, dy);
}

/** Compass bearing from a to b, degrees clockwise from north. */
export function bearing(a: LL, b: LL) {
  const dx = (b.longitude - a.longitude) * mLon(a.latitude);
  const dy = (b.latitude - a.latitude) * M_LAT;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Smallest difference between two bearings, 0–180. */
export const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Point at `dist` metres from c along `deg`, as [lon, lat]. */
export function offset(c: LL, deg: number, dist: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [c.longitude + (Math.sin(r) * dist) / mLon(c.latitude), c.latitude + (Math.cos(r) * dist) / M_LAT];
}

const polygon = (ring: [number, number][]): Feature<Polygon> => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
});

/** A camera's field of view: a wedge of `fov` degrees and `range` metres. */
export function cone(c: LL, deg: number, fov: number, range: number, steps = 10) {
  const ring: [number, number][] = [[c.longitude, c.latitude]];
  for (let i = 0; i <= steps; i++) ring.push(offset(c, deg - fov / 2 + (fov * i) / steps, range));
  return polygon(ring);
}

export function circle(c: LL, r: number, steps = 32) {
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) ring.push(offset(c, (360 * i) / steps, r));
  return polygon(ring);
}

/** Deterministic random numbers, so the simulated data is the same on every load and every rehearsal. */
export function seeded(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}
