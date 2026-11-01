// Pin clustering for the discovery map, shared by the native and web maps so both group pins identically.
// Pins that fall in the same grid cell merge into one marker showing a count; a lone pin stays a pin. The cell shrinks as the map zooms in.

/** @param pins [{key, kind, id, latitude, longitude}]  @param latSpan visible latitude span in degrees  @returns [{key, latitude, longitude, count, pins}] */
export function clusterPins(pins, latSpan, cells = 12) {
  const size = Math.max((latSpan || 1) / cells, 0.0005);
  const grid = new Map();
  for (const p of pins) {
    const k = `${Math.floor(p.latitude / size)}:${Math.floor(p.longitude / size)}`;
    const g = grid.get(k);
    if (g) g.push(p); else grid.set(k, [p]);
  }
  return [...grid.entries()].map(([k, list]) => {
    if (list.length === 1) return { key: list[0].key, latitude: list[0].latitude, longitude: list[0].longitude, count: 1, pins: list };
    const lat = list.reduce((s, p) => s + p.latitude, 0) / list.length;
    const lng = list.reduce((s, p) => s + p.longitude, 0) / list.length;
    return { key: `cluster:${k}:${list.length}`, latitude: lat, longitude: lng, count: list.length, pins: list };
  });
}

/** The box that holds every pin (with a little padding), or a ~20 km box around a fallback point. */
export function fitBox(pins, around) {
  if (!pins.length) {
    if (!around) return null;
    const d = 0.2;
    return { south: around.lat - d, north: around.lat + d, west: around.lng - d, east: around.lng + d };
  }
  const lats = pins.map((p) => p.latitude), lngs = pins.map((p) => p.longitude);
  const pad = 0.01;
  return { south: Math.min(...lats) - pad, north: Math.max(...lats) + pad, west: Math.min(...lngs) - pad, east: Math.max(...lngs) + pad };
}

export const bboxString = (b) => [b.south, b.west, b.north, b.east].map((x) => Number(x.toFixed(4))).join(',');
