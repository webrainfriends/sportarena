// Canonical wearable metrics (#583). Vendor-specific names and units are mapped here, in code, so no screen or capability knows a vendor.
// Every stored reading keeps the vendor's own metric/value/unit next to the canonical one (provenance) and the mapping version used.
export const MAPPING_VERSION = 1;

/** canonical metric -> unit, label, plausible range (outside it a reading is flagged, never silently dropped or "fixed"), and how it is aggregated per day. */
export const METRICS = {
  resting_hr: { unit: 'bpm', label: 'Resting heart rate', min: 25, max: 140, agg: 'avg' },
  hrv_rmssd: { unit: 'ms', label: 'Heart-rate variability (RMSSD)', min: 5, max: 300, agg: 'avg' },
  sleep_duration: { unit: 'h', label: 'Sleep duration', min: 0, max: 18, agg: 'sum' },
  training_load: { unit: 'au', label: 'Training load (provider scale)', min: 0, max: 2000, agg: 'sum' },
  distance: { unit: 'km', label: 'Distance', min: 0, max: 400, agg: 'sum' },
  active_energy: { unit: 'kcal', label: 'Active energy', min: 0, max: 15000, agg: 'sum' },
  steps: { unit: 'count', label: 'Steps', min: 0, max: 150000, agg: 'sum' },
};

// factor to the canonical unit; a function for non-linear conversions
const UNITS = {
  bpm: { bpm: 1 },
  ms: { ms: 1, s: 1000 },
  h: { h: 1, min: 1 / 60, s: 1 / 3600, ms: 1 / 3.6e6 },
  au: { au: 1 },
  km: { km: 1, m: 0.001, mi: 1.609344 },
  kcal: { kcal: 1, kj: 0.239006, j: 0.000239006 },
  count: { count: 1 },
};

/** Convert a vendor reading. Returns { value, flags } or null when the unit is not understood (the caller records it as unmapped, never guesses). */
export function normalise(metricKey, value, unit) {
  const m = METRICS[metricKey];
  const v = Number(value);
  if (!m || !Number.isFinite(v)) return null;
  const f = UNITS[m.unit][String(unit ?? m.unit).toLowerCase()];
  if (f === undefined) return null;
  const out = Math.round(v * f * 1000) / 1000;
  const flags = out < m.min || out > m.max ? ['out_of_range'] : [];
  return { value: out, unit: m.unit, flags };
}

/** Provider adapters turn a vendor response into [{ source_metric, metric_key, value, unit, on }]. Unknown fields are ignored, not guessed. */
const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
const row = (source_metric, metric_key, value, unit, on) => ({ source_metric, metric_key, value: num(value), unit, on: String(on).slice(0, 10) });
const arr = (j, k) => (Array.isArray(j) ? j : Array.isArray(j?.[k]) ? j[k] : []);

export const ADAPTERS = {
  oura: {
    base: 'https://api.ouraring.com',
    path: '/v2/usercollection/daily_summary',
    parse: (j) => arr(j, 'data').flatMap((d) => [row('average_resting_heart_rate', 'resting_hr', d.average_resting_heart_rate, 'bpm', d.day), row('average_hrv', 'hrv_rmssd', d.average_hrv, 'ms', d.day), row('total_sleep_duration', 'sleep_duration', d.total_sleep_duration, 's', d.day)]),
  },
  whoop: {
    base: 'https://api.prod.whoop.com',
    path: '/developer/v1/recovery',
    parse: (j) => arr(j, 'records').flatMap((d) => [row('resting_heart_rate', 'resting_hr', d.score?.resting_heart_rate, 'bpm', d.created_at), row('hrv_rmssd_milli', 'hrv_rmssd', d.score?.hrv_rmssd_milli, 'ms', d.created_at)]),
  },
  garmin: {
    base: 'https://apis.garmin.com',
    path: '/wellness-api/rest/dailies',
    parse: (j) => arr(j, 'dailies').flatMap((d) => [row('restingHeartRateInBeatsPerMinute', 'resting_hr', d.restingHeartRateInBeatsPerMinute, 'bpm', d.calendarDate), row('steps', 'steps', d.steps, 'count', d.calendarDate), row('distanceInMeters', 'distance', d.distanceInMeters, 'm', d.calendarDate), row('activeKilocalories', 'active_energy', d.activeKilocalories, 'kcal', d.calendarDate)]),
  },
  fitbit: {
    base: 'https://api.fitbit.com',
    path: '/1/user/-/activities/summary',
    parse: (j) => arr(j, 'days').flatMap((d) => [row('restingHeartRate', 'resting_hr', d.restingHeartRate, 'bpm', d.date), row('steps', 'steps', d.steps, 'count', d.date), row('distance_mi', 'distance', d.distance, 'mi', d.date), row('minutesAsleep', 'sleep_duration', d.minutesAsleep, 'min', d.date)]),
  },
  strava: {
    base: 'https://www.strava.com',
    path: '/api/v3/athlete/activities',
    parse: (j) => arr(j, 'activities').flatMap((d) => [row('distance', 'distance', d.distance, 'm', d.start_date), row('kilojoules', 'active_energy', d.kilojoules, 'kj', d.start_date)]),
  },
  // Apple Health / Health Connect are pushed from the device app (no server pull); the push uses canonical names and units directly.
  device_push: { path: null, parse: (j) => arr(j, 'readings').map((d) => row(d.metric, d.metric, d.value, d.unit, d.date)) },
};
