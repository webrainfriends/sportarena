// The sports-services catalogue: reference data (not demo data) describing each service family, its pricing units and the typed fields a
// requirement / offering must capture. Adding a family or field is a code change here; nothing is hard-coded into the UI, which renders from this.
import { badRequest } from '../errors.js';

export const UNITS = ['hour', 'shift', 'day', 'person_hour', 'person_shift', 'visit', 'area_sqm', 'job', 'trip', 'room_night', 'recurring_period', 'milestone', 'unit', 'kg', 'litre'];
const f = (key, label, type, extra = {}) => ({ key, label, type, ...extra });
const yn = (key, label) => f(key, label, 'bool');
const num = (key, label, extra) => f(key, label, 'number', extra);
const pick = (key, label, options, extra) => f(key, label, 'enum', { options, ...extra });
const multi = (key, label, options) => f(key, label, 'multi', { options });

export const CATEGORIES = [
  { slug: 'ground_maintenance', family: 'Groundsmen and ground maintenance', label: 'Ground maintenance', units: ['hour', 'visit', 'area_sqm', 'job', 'recurring_period'], goods: 'mixed',
    fields: [pick('surface', 'Ground / surface type', ['natural_grass', 'artificial_turf', 'clay', 'hard_court', 'sand', 'indoor_floor'], { required: true }), multi('tasks', 'Tasks', ['mowing', 'line_marking', 'cleaning', 'drainage', 'irrigation', 'waste_removal']), num('area_sqm', 'Area (m²)', { required: true }), pick('frequency', 'Frequency', ['once', 'daily', 'weekly', 'fortnightly', 'monthly']), yn('equipment_supplied', 'Supplier brings equipment')] },
  { slug: 'pitch_maintenance', family: 'Pitch maintenance', label: 'Pitch maintenance', units: ['visit', 'job', 'recurring_period', 'hour'], goods: 'mixed',
    fields: [f('sport', 'Sport', 'sport', { required: true }), pick('surface_kind', 'Surface', ['natural', 'artificial'], { required: true }), multi('works', 'Works', ['inspection', 'preparation', 'repairs', 'match_readiness']), f('window_from', 'Maintenance window starts', 'datetime'), f('window_to', 'Maintenance window ends', 'datetime')] },
  { slug: 'pool_maintenance', family: 'Pool maintenance', label: 'Pool maintenance', units: ['visit', 'recurring_period', 'job', 'hour'], goods: 'mixed',
    fields: [f('site', 'Pool / site', 'text', { required: true }), multi('tasks', 'Tasks', ['cleaning', 'water_testing', 'chemical_treatment', 'filter_service', 'readiness_signoff']), yn('treatment_materials', 'Treatment materials supplied'), yn('readiness_signoff', 'Authorised readiness sign-off required')] },
  { slug: 'event_crew', family: 'Ballboys/ballgirls and event support crew', label: 'Ball crew & event support', units: ['person_shift', 'person_hour', 'shift', 'day'], goods: 'service',
    fields: [num('headcount', 'Headcount', { required: true, integer: true }), f('shift_start', 'Shift start', 'time', { required: true }), f('shift_end', 'Shift end', 'time', { required: true }), f('assignments', 'Court / pitch assignments', 'text'), yn('supervisor', 'Supervisor included'), num('break_minutes', 'Break (minutes)', { integer: true }), yn('training', 'Training included'), yn('replacement_cover', 'Replacement cover'), yn('includes_minors', 'Crew may include under-18s')] },
  { slug: 'electrical', family: 'Electrical supplies and installation', label: 'Electrical supplies & installation', units: ['job', 'hour', 'day', 'unit'], goods: 'mixed',
    fields: [pick('work', 'Work', ['supply_only', 'install', 'temporary_power', 'test_inspect'], { required: true }), num('load_kw', 'Load (kW)'), f('site', 'Site details', 'text'), yn('testing', 'Installation testing'), yn('qualified_personnel', 'Qualified personnel required')] },
  { slug: 'wifi', family: 'Wi-Fi and connectivity', label: 'Wi-Fi & connectivity', units: ['day', 'job', 'recurring_period', 'unit'], goods: 'mixed',
    fields: [f('coverage', 'Venue coverage area', 'text', { required: true }), num('concurrent_users', 'Concurrent users', { required: true, integer: true }), num('bandwidth_mbps', 'Bandwidth (Mbps)'), yn('equipment_rental', 'Equipment rental & installation'), f('service_window', 'Service window', 'text'), num('sla_uptime_pct', 'SLA uptime (%)')] },
  { slug: 'travel', family: 'Travel and transport', label: 'Travel & transport', units: ['trip', 'person_hour', 'day', 'unit'], goods: 'service',
    fields: [f('origin', 'Origin', 'text', { required: true }), f('destination', 'Destination', 'text', { required: true }), f('depart_at', 'Departure', 'datetime', { required: true }), num('seats', 'Seats', { integer: true, required: true }), pick('vehicle', 'Vehicle', ['car', 'minibus', 'coach', 'van', 'other']), yn('accessible', 'Accessible vehicle'), num('luggage', 'Luggage pieces', { integer: true }), yn('transfers', 'Transfers included'), f('cancellation', 'Cancellation rule', 'text')] },
  { slug: 'accommodation', family: 'Accommodation', label: 'Accommodation', units: ['room_night', 'person_shift', 'unit'], goods: 'service',
    fields: [f('destination', 'Destination / property', 'text', { required: true }), f('check_in', 'Check-in', 'date', { required: true }), f('check_out', 'Check-out', 'date', { required: true }), pick('room_type', 'Room type', ['single', 'double', 'twin', 'triple', 'dorm']), num('rooms', 'Rooms', { integer: true, required: true }), num('occupancy', 'Occupancy per room', { integer: true }), pick('meals', 'Meals', ['none', 'breakfast', 'half_board', 'full_board']), yn('accessible', 'Accessible rooms'), f('cancellation', 'Cancellation rule', 'text')] },
  { slug: 'catering', family: 'Other sports operations', label: 'Catering', units: ['person_shift', 'job', 'unit', 'day'], goods: 'mixed', fields: [num('covers', 'Covers', { integer: true, required: true }), multi('diets', 'Dietary needs', ['vegetarian', 'vegan', 'halal', 'gluten_free', 'nut_free'])] },
  { slug: 'cleaning', family: 'Other sports operations', label: 'Cleaning', units: ['hour', 'visit', 'job', 'recurring_period'], goods: 'mixed', fields: [num('area_sqm', 'Area (m²)')] },
  { slug: 'equipment_rental', family: 'Other sports operations', label: 'Equipment installation / rental', units: ['day', 'job', 'unit'], goods: 'mixed', fields: [f('equipment', 'Equipment', 'text', { required: true }), yn('installation', 'Installation included')] },
  { slug: 'security', family: 'Other sports operations', label: 'Security', units: ['person_shift', 'person_hour', 'shift'], goods: 'service', fields: [num('headcount', 'Headcount', { required: true, integer: true }), yn('licensed', 'Licensed personnel required')] },
  { slug: 'logistics', family: 'Other sports operations', label: 'Logistics', units: ['trip', 'job', 'day', 'unit'], goods: 'mixed', fields: [f('origin', 'Origin', 'text'), f('destination', 'Destination', 'text')] },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.slug, c]));
export const catalogue = () => CATEGORIES.map(({ slug, family, label, units, goods, fields }) => ({ slug, family, label, units, goods, fields }));

/** Validate a typed spec/scope object against the category's fields. Unknown keys are rejected; returns the cleaned object. */
export function validateSpec(category, spec = {}, { requireAll = false } = {}) {
  const c = CATEGORY[category];
  if (!c) throw badRequest(`Unknown service category: ${category}`);
  const out = {};
  const keys = new Set(c.fields.map((x) => x.key));
  for (const k of Object.keys(spec)) if (!keys.has(k)) throw badRequest(`${k} is not a field of ${c.label}`);
  for (const fld of c.fields) {
    const v = spec[fld.key];
    if (v === undefined || v === null || v === '') { if (requireAll && fld.required) throw badRequest(`${fld.label} is required for ${c.label}`); continue; }
    if (fld.type === 'number') { const n = Number(v); if (!Number.isFinite(n) || n < 0 || (fld.integer && !Number.isInteger(n))) throw badRequest(`${fld.label} must be a ${fld.integer ? 'whole ' : ''}number`); out[fld.key] = n; }
    else if (fld.type === 'bool') { if (typeof v !== 'boolean') throw badRequest(`${fld.label} must be yes or no`); out[fld.key] = v; }
    else if (fld.type === 'enum') { if (!fld.options.includes(v)) throw badRequest(`${fld.label} must be one of ${fld.options.join(', ')}`); out[fld.key] = v; }
    else if (fld.type === 'multi') { if (!Array.isArray(v) || v.some((x) => !fld.options.includes(x))) throw badRequest(`${fld.label} has an unknown choice`); out[fld.key] = [...new Set(v)]; }
    else { if (typeof v !== 'string' || v.length > 400) throw badRequest(`${fld.label} must be text up to 400 characters`); out[fld.key] = v; }
  }
  return out;
}
export const assertUnit = (category, unit) => {
  const c = CATEGORY[category];
  if (!c) throw badRequest(`Unknown service category: ${category}`);
  if (!UNITS.includes(unit)) throw badRequest(`Unknown unit: ${unit}`);
  if (!c.units.includes(unit)) throw badRequest(`${c.label} is priced per ${c.units.join(', ')}`);
};
