// Pure helpers for the venue bulk-import domain (#697). No database access — the dry-run and the real import share the same rules.
import { toCsv } from './csv.js';

export const VENUE_SOURCES = [
  { key: 'playo', label: 'Playo', hint: 'Export your venues from Playo admin dashboard and upload the CSV.' },
  { key: 'gotsport', label: 'GotSport', hint: 'Export venues from GotSport facility management.' },
  { key: 'teamsnap_venue', label: 'TeamSnap Locations', hint: 'Export locations from TeamSnap.' },
  { key: 'sportsengine_venue', label: 'SportsEngine Facilities', hint: 'Export facilities from SportsEngine.' },
  { key: 'excel', label: 'Excel / Google Sheets', hint: 'Use our template, or any sheet with a header row.' },
  { key: 'csv', label: 'CSV', hint: 'Any CSV file with a header row.' },
];
export const VENUE_SOURCE_KEYS = VENUE_SOURCES.map((s) => s.key);

export const VENUE_FIELDS = [
  { key: 'name', label: 'Venue name', required: true, group: 'venue' },
  { key: 'city', label: 'City', required: true, group: 'venue' },
  { key: 'country', label: 'Country', group: 'venue' },
  { key: 'address', label: 'Street address', group: 'venue' },
  { key: 'lat', label: 'Latitude', group: 'venue' },
  { key: 'lng', label: 'Longitude', group: 'venue' },
  { key: 'sports', label: 'Sports (comma-separated)', group: 'venue' },
  { key: 'court_count', label: 'Number of courts/resources', group: 'resource' },
  { key: 'resource_kind', label: 'Resource type (court/ground/pool/etc.)', group: 'resource' },
  { key: 'base_rate_minor', label: 'Base rate (minor currency units, e.g. paise)', group: 'pricing' },
  { key: 'currency', label: 'Currency code (INR, USD, etc.)', group: 'pricing' },
  { key: 'hours_open', label: 'Opening time (HH:MM)', group: 'hours' },
  { key: 'hours_close', label: 'Closing time (HH:MM)', group: 'hours' },
  { key: 'hours_text', label: 'Hours (free text, e.g. 06:00–22:00)', group: 'hours' },
  { key: 'timezone', label: 'Timezone (e.g. Asia/Kolkata)', group: 'hours' },
  { key: 'description', label: 'Description', group: 'venue' },
  { key: 'amenities', label: 'Amenities (comma-separated)', group: 'venue' },
  { key: 'email', label: 'Contact email', group: 'contact' },
  { key: 'phone', label: 'Contact phone', group: 'contact' },
];
const VENUE_FIELD_KEYS = VENUE_FIELDS.map((f) => f.key);

// Column aliases per source, in priority order. Confirmed by a person before anything is validated.
const VENUE_COMMON = {
  name: ['name', 'venue_name', 'facility_name', 'location_name', 'title', 'venue'],
  city: ['city', 'city_name', 'town', 'municipality', 'location_city'],
  country: ['country', 'country_name', 'nation'],
  address: ['address', 'street_address', 'full_address', 'location_address', 'venue_address', 'address_line_1'],
  lat: ['lat', 'latitude', 'geo_lat', 'location_lat', 'latitude_decimal'],
  lng: ['lng', 'lon', 'long', 'longitude', 'geo_lon', 'location_lng', 'longitude_decimal'],
  sports: ['sports', 'sport', 'sports_played', 'sport_types', 'activities', 'discipline'],
  court_count: ['court_count', 'num_courts', 'courts', 'number_of_courts', 'resource_count', 'facility_count', 'pitches', 'lanes', 'fields'],
  resource_kind: ['resource_kind', 'court_type', 'facility_type', 'resource_type', 'type'],
  base_rate_minor: ['base_rate_minor', 'price', 'price_per_hr', 'hourly_rate', 'rate', 'cost_per_hour', 'booking_rate', 'price_hour'],
  currency: ['currency', 'currency_code', 'currency_symbol'],
  hours_open: ['hours_open', 'open_time', 'opening_time', 'opens_at', 'start_time'],
  hours_close: ['hours_close', 'close_time', 'closing_time', 'closes_at', 'end_time'],
  hours_text: ['hours_text', 'operating_hours', 'hours', 'business_hours', 'working_hours'],
  timezone: ['timezone', 'time_zone', 'tz'],
  description: ['description', 'about', 'details', 'venue_description', 'notes', 'info'],
  amenities: ['amenities', 'facilities', 'features', 'extras', 'amenity'],
  email: ['email', 'contact_email', 'venue_email', 'email_address'],
  phone: ['phone', 'contact_phone', 'venue_phone', 'phone_number', 'mobile', 'telephone'],
};
const VENUE_EXTRA = {
  playo: { name: ['venue_name', 'name'], sports: ['sports_played', 'sport_category', 'sports'], court_count: ['num_courts', 'court_count'], base_rate_minor: ['price_per_hr', 'hourly_rate', 'price'], city: ['city', 'area', 'locality'] },
  gotsport: { name: ['facility_name', 'name'], city: ['city', 'facility_city'], lat: ['latitude', 'lat'], lng: ['longitude', 'lng'] },
  teamsnap_venue: { name: ['location_name', 'name'], address: ['address', 'full_address'], city: ['city', 'location_city'] },
  sportsengine_venue: { name: ['facility_name', 'name'], city: ['city', 'facility_city'], sports: ['sport', 'sports_type'] },
  excel: {}, csv: {},
};
const venueAliases = (source, field) => [...(VENUE_EXTRA[source]?.[field] ?? []), ...(VENUE_COMMON[field] ?? [])];

export const venueHeaderKey = (h) => String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Propose which column holds which canonical venue field.
 * @returns {{ mapping: Record<string,string>, ambiguous: {field:string, candidates:string[]}[], unmapped_columns: string[], missing: string[] }}
 */
export function proposeVenueMapping(headers, source, current = {}) {
  const byKey = new Map();
  for (const h of headers) if (h) byKey.set(venueHeaderKey(h), h);
  const mapping = {}, ambiguous = [], taken = new Set();
  for (const f of VENUE_FIELD_KEYS) {
    if (current[f] && headers.includes(current[f])) { mapping[f] = current[f]; taken.add(current[f]); continue; }
    const hits = venueAliases(source, f).map((a) => byKey.get(a)).filter(Boolean);
    const free = [...new Set(hits)].filter((h) => !taken.has(h));
    if (!free.length) continue;
    mapping[f] = free[0]; taken.add(free[0]);
    if (free.length > 1) ambiguous.push({ field: f, candidates: free });
  }
  const unmapped_columns = headers.filter((h) => h && !taken.has(h));
  return { mapping, ambiguous, unmapped_columns, missing: missingVenueFields(mapping) };
}

/** Required fields: name and city. */
export function missingVenueFields(mapping) {
  const out = [];
  if (!mapping.name) out.push('name');
  if (!mapping.city) out.push('city');
  return out;
}

/** Header-only CSV template for a venue source. */
export function venueTemplateCsv(source) {
  let cols;
  if (source === 'playo') {
    cols = ['venue_name', 'city', 'sports_played', 'num_courts', 'price_per_hr', 'currency', 'operating_hours', 'address', 'lat', 'lng', 'description'];
  } else if (source === 'gotsport') {
    cols = ['facility_name', 'city', 'country', 'address', 'latitude', 'longitude', 'sport'];
  } else if (source === 'teamsnap_venue') {
    cols = ['location_name', 'address', 'city', 'country', 'hours'];
  } else if (source === 'sportsengine_venue') {
    cols = ['facility_name', 'city', 'country', 'address', 'sport'];
  } else {
    cols = ['name', 'city', 'country', 'address', 'lat', 'lng', 'sports', 'court_count', 'resource_kind', 'base_rate_minor', 'currency', 'hours_open', 'hours_close', 'timezone', 'description', 'amenities', 'email', 'phone'];
  }
  return toCsv(cols, []);
}

const VALID_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'AED', 'LKR', 'IDR', 'BDT', 'PKR', 'NPR', 'MYR', 'THB', 'PHP', 'ZAR', 'KES', 'NGN', 'GHS', 'TZS', 'UGX', 'XAF', 'XOF']);
const HH_MM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Strip currency symbols and thousands separators, multiply if value looks like it's in major units. */
function parseRate(raw) {
  if (!raw) return { value: null, hint: null };
  let s = String(raw).trim().replace(/^[₹$€£¥₩₫₦]/u, '').replace(/,/g, '').trim();
  const n = Number(s);
  if (Number.isNaN(n) || !s) return { value: null, hint: null };
  // Heuristic: if value is suspiciously small (< 500) assume it's already in major units → multiply by 100
  const needsConversion = n > 0 && n < 500;
  return { value: needsConversion ? Math.round(n * 100) : Math.round(n), hint: needsConversion ? `Value ${n} looks like a major-unit amount (e.g. ₹${n}); stored as ${Math.round(n * 100)} minor units` : null };
}

/**
 * Validate one venue row. `row` is the raw string array; `mapping` maps field → header; `headers` is the headers array.
 * @returns {{ valid: boolean, reasons: Array<{field: string, level: 'error'|'warning', message: string}> }}
 */
export function validateVenueRow(rowObj, mapping, opts = {}) {
  const reasons = [];
  const err = (field, message) => reasons.push({ level: 'error', field, message });
  const warn = (field, message) => reasons.push({ level: 'warning', field, message });
  const cell = (f) => (mapping[f] ? String(rowObj[mapping[f]] ?? '').trim() : '');

  const name = cell('name');
  if (!name) err('name', 'Venue name is required');

  const city = cell('city');
  if (!city) err('city', 'City is required');

  const latRaw = cell('lat'), lngRaw = cell('lng');
  if (latRaw || lngRaw) {
    const lat = Number(latRaw), lng = Number(lngRaw);
    if (Number.isNaN(lat) || lat < -90 || lat > 90) err('lat', `Latitude "${latRaw}" is not valid (must be between -90 and 90)`);
    if (Number.isNaN(lng) || lng < -180 || lng > 180) err('lng', `Longitude "${lngRaw}" is not valid (must be between -180 and 180)`);
  } else {
    warn('lat', 'No coordinates: venue will appear in search but cannot show on a map');
  }

  const rateRaw = cell('base_rate_minor');
  if (rateRaw) {
    const { value, hint } = parseRate(rateRaw);
    if (value === null) err('base_rate_minor', `"${rateRaw.slice(0, 30)}" is not a numeric rate. Use whole numbers (e.g. 150000 for ₹1,500 in paise)`);
    else if (hint) warn('base_rate_minor', hint);
  }

  const currency = cell('currency') || opts.defaultCurrency;
  if (rateRaw && currency && !VALID_CURRENCIES.has(currency.toUpperCase())) {
    err('currency', `"${currency}" is not a supported currency code`);
  }

  const hoursOpen = cell('hours_open'), hoursClose = cell('hours_close');
  if (hoursOpen && !HH_MM.test(hoursOpen)) err('hours_open', `Opening time "${hoursOpen}" must be HH:MM (e.g. 06:00)`);
  if (hoursClose && !HH_MM.test(hoursClose)) err('hours_close', `Closing time "${hoursClose}" must be HH:MM (e.g. 22:00)`);
  if (!hoursOpen && !hoursClose && !cell('hours_text')) warn('hours_open', 'No hours provided: venue will show hours as unavailable until set');

  const courtCountRaw = cell('court_count');
  if (courtCountRaw) {
    const n = parseInt(courtCountRaw, 10);
    if (Number.isNaN(n) || n < 1 || n > 500) err('court_count', `Court count "${courtCountRaw}" must be a whole number between 1 and 500`);
  }

  const hasErrors = reasons.some((r) => r.level === 'error');
  return { valid: !hasErrors, reasons };
}

/**
 * Extract a clean JS object from a raw row (header→value map) using the confirmed mapping.
 * Returns null values for unmapped or blank fields; normalises rate and coordinates.
 */
export function normaliseVenueRow(rowObj, mapping, opts = {}) {
  const cell = (f) => (mapping[f] ? String(rowObj[mapping[f]] ?? '').trim() : '');
  const { value: baseRateMinor } = parseRate(cell('base_rate_minor'));
  const latRaw = cell('lat'), lngRaw = cell('lng');
  const lat = latRaw ? Number(latRaw) : null;
  const lng = lngRaw ? Number(lngRaw) : null;
  const courtCountRaw = cell('court_count');
  const courtCount = courtCountRaw ? (parseInt(courtCountRaw, 10) || null) : null;
  const resourceKind = cell('resource_kind') || 'court';
  const currency = (cell('currency') || opts.defaultCurrency || 'INR').toUpperCase();
  const sportsRaw = cell('sports');
  const sports = sportsRaw ? sportsRaw.split(/[,;|]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  const amenitiesRaw = cell('amenities');
  const amenities = amenitiesRaw ? amenitiesRaw.split(/[,;|]+/).map((s) => s.trim()).filter(Boolean) : [];
  return {
    name: cell('name') || null,
    city: cell('city') || null,
    country: cell('country') || null,
    address: cell('address') || null,
    lat: (lat !== null && !Number.isNaN(lat)) ? lat : null,
    lng: (lng !== null && !Number.isNaN(lng)) ? lng : null,
    sports,
    court_count: courtCount,
    resource_kind: resourceKind,
    base_rate_minor: baseRateMinor,
    currency,
    hours_open: cell('hours_open') || null,
    hours_close: cell('hours_close') || null,
    hours_text: cell('hours_text') || null,
    timezone: cell('timezone') || opts.defaultTimezone || null,
    description: cell('description') || null,
    amenities,
    email: cell('email') || null,
    phone: cell('phone') || null,
  };
}
