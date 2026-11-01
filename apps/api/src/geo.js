// Shared geography for discovery (#696): one great-circle distance, one map-viewport box and one privacy rounding,
// used by venue, open-game and coach-class search so the map, the list and the filters can never disagree.
import { z } from 'zod';

/** A map viewport "south,west,north,east" in degrees. Crossing the antimeridian (west > east) is supported. */
export const bboxField = z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, 'bbox is south,west,north,east')
  .describe('map viewport as south,west,north,east (degrees)').optional();

export function parseBbox(s) {
  if (!s) return null;
  const [south, west, north, east] = s.split(',').map(Number);
  if (south < -90 || north > 90 || south > north || west < -180 || west > 180 || east < -180 || east > 180) return null;
  return { south, west, north, east };
}

/** True when a point sits inside the box. Points without coordinates are never inside. */
export function inBbox(b, lat, lng) {
  if (!b) return true;
  if (lat == null || lng == null) return false;
  lat = Number(lat); lng = Number(lng);
  if (lat < b.south || lat > b.north) return false;
  return b.west <= b.east ? lng >= b.west && lng <= b.east : lng >= b.west || lng <= b.east;
}

/** SQL for the distance in km between a (lat, lng) pair of columns and two bound parameters, null when either side is unknown. */
export const haversineSql = (latCol, lngCol, latParam, lngParam, digits = 2) =>
  `CASE WHEN ${latParam}::float8 IS NULL OR ${latCol} IS NULL THEN NULL ELSE round((6371 * 2 * asin(sqrt(
    power(sin(radians(${latCol} - ${latParam}) / 2), 2) + cos(radians(${latParam})) * cos(radians(${latCol})) * power(sin(radians(${lngCol} - ${lngParam}) / 2), 2))))::numeric, ${digits}) END`;

/** SQL predicate for a box held in four bound parameters (south, west, north, east); true when no box is sent. */
export const bboxSql = (latCol, lngCol, [s, w, n, e]) => {
  const [S, W, N, E] = [s, w, n, e].map((p) => `${p}::float8`);
  return `(${S} IS NULL OR (${latCol} BETWEEN ${S} AND ${N} AND (CASE WHEN ${W} <= ${E} THEN ${lngCol} BETWEEN ${W} AND ${E} ELSE (${lngCol} >= ${W} OR ${lngCol} <= ${E}) END)))`;
};

/** Coordinates shown to the public are rounded to ~110 m (3 decimals): a pin for a venue or public place, never a precise private spot. */
export const roundCoord = (v) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);
