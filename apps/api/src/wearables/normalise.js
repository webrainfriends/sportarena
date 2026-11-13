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
  // Elite-academy extensions (#583)
  sleep_quality: { unit: 'score', label: 'Sleep quality score', min: 0, max: 100, agg: 'avg' },
  spo2: { unit: '%', label: 'Blood oxygen (SpO₂)', min: 70, max: 100, agg: 'avg' },
  vo2max: { unit: 'ml/kg/min', label: 'VO₂max estimate', min: 20, max: 90, agg: 'avg' },
  sprint_distance: { unit: 'm', label: 'Sprint distance', min: 0, max: 10000, agg: 'sum' },
  max_speed:          { unit: 'km/h',  label: 'Max speed',                     min: 0,   max: 50,     agg: 'avg' },
  // Data Hub extensions (#566): elite lab/field assessment metrics
  acceleration:       { unit: 'm/s²',  label: 'Peak acceleration',             min: 0,   max: 30,     agg: 'avg' },
  jump_height:        { unit: 'cm',    label: 'Jump height (CMJ)',              min: 0,   max: 150,    agg: 'avg' },
  jump_power:         { unit: 'W',     label: 'Peak power (jump)',              min: 0,   max: 8000,   agg: 'avg' },
  sprint_10m:         { unit: 's',     label: '10 m sprint time',              min: 0.5, max: 5,      agg: 'avg' },
  sprint_30m:         { unit: 's',     label: '30 m sprint time',              min: 2,   max: 12,     agg: 'avg' },
  sprint_40m:         { unit: 's',     label: '40 m / 40 yd sprint time',      min: 3,   max: 16,     agg: 'avg' },
  body_fat_pct:       { unit: '%',     label: 'Body fat percentage',           min: 1,   max: 60,     agg: 'avg' },
  lean_mass:          { unit: 'kg',    label: 'Lean body mass',                min: 10,  max: 150,    agg: 'avg' },
  muscle_mass:        { unit: 'kg',    label: 'Skeletal muscle mass',          min: 5,   max: 100,    agg: 'avg' },
  squat_1rm:          { unit: 'kg',    label: 'Back squat 1RM',                min: 0,   max: 500,    agg: 'avg' },
  deadlift_1rm:       { unit: 'kg',    label: 'Deadlift 1RM',                  min: 0,   max: 600,    agg: 'avg' },
  bench_1rm:          { unit: 'kg',    label: 'Bench press 1RM',               min: 0,   max: 400,    agg: 'avg' },
  peak_force:         { unit: 'N',     label: 'Peak force (isometric / jump)', min: 0,   max: 10000,  agg: 'avg' },
  rate_of_force_dev:  { unit: 'N/s',   label: 'Rate of force development',     min: 0,   max: 100000, agg: 'avg' },
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
  score: { score: 1 },
  '%': { '%': 1 },
  'ml/kg/min': { 'ml/kg/min': 1 },
  'm': { m: 1, km: 1000 },
  'km/h': { 'km/h': 1, 'm/s': 3.6, mph: 1.60934 },
  // Data Hub unit extensions (#566)
  'm/s²': { 'm/s²': 1, 'g': 9.80665 },
  cm:     { cm: 1, m: 100, in: 2.54, ft: 30.48 },
  W:      { W: 1, kW: 1000 },
  N:      { N: 1 },
  'N/s':  { 'N/s': 1 },
  kg:     { kg: 1, lb: 0.453592, g: 0.001 },
  s:      { s: 1, ms: 0.001 },
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
  // Polar AccessLink v3 — exercise transactions + nightly recharge
  polar: {
    base: 'https://www.polaraccesslink.com',
    path: '/v3/users/transaction/exercise',
    parse: (j) => arr(j, 'exercises').flatMap((d) => [
      row('training-load-index', 'training_load', d.training_load_status?.training_load_shorthand ?? null, 'au', d.start_time),
      row('distance', 'distance', d.distance, 'm', d.start_time),
      row('calories', 'active_energy', d.calories, 'kcal', d.start_time),
      row('vo2max', 'vo2max', d.vo2max, 'ml/kg/min', d.start_time),
    ]).concat(
      arr(j, 'nightly_recharge').flatMap((d) => [
        row('sleep_score', 'sleep_quality', d.sleep_charge_status?.sleep_charge ?? null, 'score', d.date),
        row('nightly_recharge_spo2', 'spo2', d.spo2_average ?? null, '%', d.date),
      ]),
    ),
  },
  // Catapult OpenField API — GPS and accelerometer data for team sports
  catapult_opf: {
    base: 'https://openfield.catapultsports.com',
    path: '/api/v1/activities',
    parse: (j) => arr(j, 'activities').flatMap((d) => [
      row('total_distance', 'distance', d.total_distance_m, 'm', d.start_time),
      row('high_speed_running', 'sprint_distance', d.high_speed_running_m, 'm', d.start_time),
      row('max_vel', 'max_speed', d.max_velocity_kmh, 'km/h', d.start_time),
      row('player_load', 'training_load', d.player_load, 'au', d.start_time),
      row('max_acceleration', 'acceleration', d.max_acceleration_ms2, 'm/s²', d.start_time),
    ]),
  },
  // Vald ForceDecks REST API v2 — jump and force plate data
  forcedecks: {
    base: 'https://prd-api.valdperformance.com',
    path: '/v2/tests',
    parse: (j) => arr(j, 'data').flatMap((d) => [
      row('jumpHeight_cm',  'jump_height',       d.jumpHeight_cm,  'cm',  d.startTime),
      row('peakForce_N',    'peak_force',        d.peakForce_N,    'N',   d.startTime),
      row('rfd_Ns',         'rate_of_force_dev', d.rfd_Ns,         'N/s', d.startTime),
      row('peakPower_W',    'jump_power',        d.peakPower_W,    'W',   d.startTime),
    ]),
  },
  // InBody body composition analyser — CSV/API export
  inbody: {
    base: 'https://inbody.com',
    path: null,
    parse: (j) => arr(j, 'results').flatMap((d) => [
      row('bodyFatPercent',        'body_fat_pct', d.bodyFatPercent,         '%',  d.testDate),
      row('leanBodyMass_kg',       'lean_mass',    d.leanBodyMass_kg,        'kg', d.testDate),
      row('skeletalMuscleMass_kg', 'muscle_mass',  d.skeletalMuscleMass_kg,  'kg', d.testDate),
    ]),
  },
  // Brower timing gates CSV export
  brower: {
    base: null,
    path: null,
    parse: (j) => arr(j, 'splits').flatMap((d) => [
      row('split_10m', 'sprint_10m', d.split10m, 's', d.date),
      row('split_30m', 'sprint_30m', d.split30m, 's', d.date),
      row('split_40m', 'sprint_40m', d.split40m, 's', d.date),
    ]),
  },
  // SmartSpeed timing system (same CSV schema as Brower, different field names)
  smartspeed: {
    base: null,
    path: null,
    parse: (j) => arr(j, 'runs').flatMap((d) => [
      row('time_10m', 'sprint_10m', d.time_10m, 's', d.session_date),
      row('time_30m', 'sprint_30m', d.time_30m, 's', d.session_date),
      row('time_40m', 'sprint_40m', d.time_40m, 's', d.session_date),
    ]),
  },
};
