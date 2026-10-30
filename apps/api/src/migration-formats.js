// Pure helpers for the shared migration framework (#514): which column in a spreadsheet means what, and how one row becomes a canonical
// roster row. No database access here, so the dry run and the real import use exactly the same rules.
import { parseCsv, toCsv } from './csv.js';

export const SOURCES = [
  { key: 'teamsnap', label: 'TeamSnap', hint: 'Export your roster from TeamSnap (Roster → Export) and upload the file.' },
  { key: 'sportsengine', label: 'SportsEngine', hint: 'Export your members or registrations from SportsEngine and upload the file.' },
  { key: 'excel', label: 'Excel or Google Sheets', hint: 'Use our template, or any sheet with a header row. Excel (.xlsx) and CSV files both work.' },
];
export const SOURCE_KEYS = [...SOURCES.map((s) => s.key), 'csv'];

/** Canonical roster fields. `required` fields must be mapped (or covered by a default) before the file can be checked. */
export const ROSTER_FIELDS = [
  { key: 'first_name', label: 'First name', required: true, group: 'person' },
  { key: 'last_name', label: 'Last name', group: 'person' },
  { key: 'full_name', label: 'Full name (when first and last are one column)', group: 'person' },
  { key: 'email', label: 'Email', required: true, group: 'person', hint: 'The only thing a person is matched on. Names are never used to match.' },
  { key: 'phone', label: 'Phone', group: 'person' },
  { key: 'dob', label: 'Date of birth', group: 'person', hint: 'Needed to tell a young person apart; they must come with a guardian email.' },
  { key: 'team', label: 'Team', group: 'team' },
  { key: 'role', label: 'Role', group: 'team' },
  { key: 'jersey_no', label: 'Jersey number', group: 'team' },
  { key: 'guardian_email', label: 'Guardian email', group: 'guardian' },
  { key: 'guardian_name', label: 'Guardian name', group: 'guardian' },
];
const FIELD_KEYS = ROSTER_FIELDS.map((f) => f.key);

// Column names these products' exports usually use, in priority order. They are a starting point, never a promise: the person confirms
// the mapping before anything is checked, and any column can be pointed at another field.
const COMMON = {
  first_name: ['first_name', 'first', 'firstname', 'given_name', 'forename'],
  last_name: ['last_name', 'last', 'lastname', 'surname', 'family_name'],
  full_name: ['full_name', 'name', 'player_name', 'member_name', 'participant_name', 'athlete_name'],
  email: ['email', 'email_address', 'e_mail', 'member_email', 'player_email', 'participant_email', 'primary_email', 'email_1'],
  phone: ['phone', 'phone_number', 'mobile', 'mobile_phone', 'mobile_number', 'cell', 'cell_phone', 'contact_number'],
  dob: ['date_of_birth', 'dob', 'birthday', 'birth_date', 'birthdate', 'birth_day'],
  team: ['team', 'team_name', 'squad', 'division', 'group', 'class'],
  role: ['role', 'member_type', 'participant_type', 'type', 'position_type', 'registration_role'],
  jersey_no: ['jersey_number', 'jersey_no', 'jersey', 'uniform_number', 'shirt_number', 'number'],
  guardian_email: ['guardian_email', 'parent_email', 'parent_guardian_email', 'parent_1_email', 'guardian_1_email', 'parent_email_1', 'guardian_email_1'],
  guardian_name: ['guardian_name', 'parent_name', 'parent_guardian_name', 'parent_1_name', 'guardian_1_name', 'parent_name_1', 'guardian_name_1'],
};
const EXTRA = {
  teamsnap: { role: ['member_role', 'is_manager'], team: ['team_name'], jersey_no: ['jersey_number'] },
  sportsengine: { team: ['team_name', 'program'], dob: ['date_of_birth'], guardian_email: ['parent_guardian_email', 'guardian_email_1'] },
  excel: {}, csv: {},
};
const aliases = (source, field) => [...(EXTRA[source]?.[field] ?? []), ...COMMON[field]];

export const headerKey = (h) => String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** First row = header. Returns { headers, rows } where each row is an array in header order; blank-header columns are dropped. */
export function readTable(csv) {
  const parsed = parseCsv(csv);
  if (parsed.length < 2) return { headers: [], rows: [] };
  const seen = new Map();
  const headers = parsed[0].map((h) => {
    const base = String(h ?? '').trim();
    if (!base) return '';
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
  return { headers, rows: parsed.slice(1) };
}

/**
 * Propose which column holds which canonical field.
 * @returns {{ mapping: Record<string,string>, ambiguous: {field:string, candidates:string[]}[], unmapped_columns: string[], missing: string[] }}
 */
export function proposeMapping(headers, source, current = {}) {
  const byKey = new Map();
  for (const h of headers) if (h) byKey.set(headerKey(h), h);
  const mapping = {}, ambiguous = [], taken = new Set();
  for (const f of FIELD_KEYS) {
    if (current[f] && headers.includes(current[f])) { mapping[f] = current[f]; taken.add(current[f]); continue; }
    const hits = aliases(source, f).map((a) => byKey.get(a)).filter(Boolean);
    const free = [...new Set(hits)].filter((h) => !taken.has(h));
    if (!free.length) continue;
    mapping[f] = free[0]; taken.add(free[0]);
    if (free.length > 1) ambiguous.push({ field: f, candidates: free });
  }
  // a name column that is the only name column is the full name, and first/last override it when both exist
  const unmapped_columns = headers.filter((h) => h && !taken.has(h));
  return { mapping, ambiguous, unmapped_columns, missing: missingFields(mapping) };
}

/** Required things still not covered: an email column, and some way to read a name. */
export function missingFields(mapping) {
  const out = [];
  if (!mapping.email) out.push('email');
  if (!mapping.first_name && !mapping.full_name) out.push('first_name');
  return out;
}

// ------------------------------------------------------------------ values
export const DATE_FORMATS = [
  { value: 'DD/MM/YYYY', label: 'Day / Month / Year (31/12/2010)' },
  { value: 'MM/DD/YYYY', label: 'Month / Day / Year (12/31/2010)' },
  { value: 'YYYY-MM-DD', label: 'Year-Month-Day (2010-12-31)' },
];
const validYmd = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1900;
};
const ymd = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** A date of birth in the chosen format (an Excel serial number is accepted too). Returns YYYY-MM-DD or null. Never guesses day vs month. */
export function parseDate(raw, format = 'DD/MM/YYYY') {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s))) return validYmd(+m[1], +m[2], +m[3]) ? ymd(+m[1], +m[2], +m[3]) : null;
  if ((m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s))) {
    if (format === 'YYYY-MM-DD') return null;
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    const [d, mo] = format === 'MM/DD/YYYY' ? [b, a] : [a, b];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  if (/^\d{5}$/.test(s) && +s > 1000 && +s < 80000) { // Excel serial day count
    const t = new Date(Date.UTC(1899, 11, 30) + +s * 86400000);
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  return null;
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
export const cleanEmail = (v) => { const s = String(v ?? '').trim().toLowerCase(); return EMAIL.test(s) && s.length <= 200 ? s : null; };
export const cleanPhone = (v) => { const s = String(v ?? '').replace(/[\s().-]/g, ''); return /^\+?\d{7,15}$/.test(s) ? s : null; };

const ROLE_WORDS = [
  [/^(player|athlete|member|participant|student|swimmer|runner|skater|rider|shooter|archer)s?$/, 'player'],
  [/^captain$|^team captain$/, 'captain'],
  [/^(head |assistant |asst\.? |lead )?(coach|trainer|instructor)$/, 'coach'],
  [/^(team )?(manager|admin|administrator)$/, 'manager'],
  [/^(physio|physiotherapist|medic)$/, 'physio'],
];
const NOT_IMPORTED = /^(parent|guardian|fan|supporter|non[- ]?player|spectator|volunteer|sponsor|other|alumni)s?$/;
/** player | captain | coach | manager | physio, or null when the role is something that is not a team role (parents are linked under Family & guardians). */
export function mapRole(raw, fallback = 'player') {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return { role: fallback };
  if (NOT_IMPORTED.test(s)) return { role: null, skipped: s };
  for (const [re, role] of ROLE_WORDS) if (re.test(s)) return { role };
  return { role: fallback, guessed: s };
}

/**
 * One source row -> canonical row + the reasons it is fine, doubtful or unusable.
 * @param {Record<string,string>} raw   header -> cell
 * @param {Record<string,string>} mapping canonical field -> header
 * @param {{ date_format?: string, default_role?: string, default_team?: string|null, independent_age?: number, today?: Date }} opt
 */
export function normaliseRosterRow(raw, mapping, opt = {}) {
  const cell = (f) => (mapping[f] ? String(raw[mapping[f]] ?? '').trim() : '');
  const reasons = [];
  const err = (field, message) => reasons.push({ level: 'error', field, message });
  const warn = (field, message) => reasons.push({ level: 'warning', field, message });

  let first = cell('first_name'), last = cell('last_name');
  if (!first && cell('full_name')) { const p = cell('full_name').split(/\s+/); first = p.shift(); last = last || p.join(' '); }
  if (!first) err('first_name', 'No name on this row');
  const email = cleanEmail(cell('email'));
  if (!cell('email')) err('email', 'No email: a person can only be matched on an email, never on a name');
  else if (!email) err('email', `"${cell('email').slice(0, 60)}" is not a valid email address`);

  const phoneRaw = cell('phone'), phone = phoneRaw ? cleanPhone(phoneRaw) : null;
  if (phoneRaw && !phone) warn('phone', 'Phone number not recognised, so it was left out');

  let dob = null;
  if (cell('dob')) {
    dob = parseDate(cell('dob'), opt.date_format);
    if (!dob) err('dob', `Date of birth "${cell('dob').slice(0, 20)}" does not read as ${opt.date_format ?? 'DD/MM/YYYY'}. Check the date format chosen for this file`);
    else if (new Date(dob) > (opt.today ?? new Date())) err('dob', 'Date of birth is in the future');
  }

  const gEmailRaw = cell('guardian_email'), gEmail = gEmailRaw ? cleanEmail(gEmailRaw) : null;
  if (gEmailRaw && !gEmail) warn('guardian_email', 'Guardian email not valid, so it was left out');
  let youth = false;
  if (dob) {
    const now = opt.today ?? new Date();
    const age = now.getUTCFullYear() - +dob.slice(0, 4) - (now < new Date(Date.UTC(now.getUTCFullYear(), +dob.slice(5, 7) - 1, +dob.slice(8, 10))) ? 1 : 0);
    youth = age < (opt.independent_age ?? 18);
    if (youth && !gEmail) err('guardian_email', 'Under 18: add a guardian email. Guardian links and consent are never created by an import');
    if (youth && gEmail && gEmail === email) err('guardian_email', 'The guardian email is the same as the young person\'s email');
  }

  const r = mapRole(cell('role'), opt.default_role ?? 'player');
  let role = r.role, skipped = null;
  if (r.skipped) skipped = `"${r.skipped}" is not a team role (parents and guardians are linked under Family & guardians), so the row was skipped`;
  if (r.guessed) warn('role', `Role "${r.guessed}" not recognised, imported as ${role}`);

  let jersey_no = null;
  if (cell('jersey_no')) {
    const n = Number(cell('jersey_no').replace(/^#/, ''));
    if (Number.isInteger(n) && n >= 0 && n <= 999) jersey_no = n; else warn('jersey_no', `Jersey number "${cell('jersey_no').slice(0, 10)}" ignored`);
  }
  const team = (cell('team') || opt.default_team || '').slice(0, 60) || null;
  if (team && team.length < 2) err('team', 'Team name is too short');
  if (!team && !skipped) warn('team', 'No team on this row: the person is matched but not put on a team');

  const data = { first_name: first || null, last_name: last || null, email, phone, dob, team, role, jersey_no, guardian_email: gEmail, guardian_name: cell('guardian_name').slice(0, 120) || null, youth };
  return { data, reasons, skipped, ok: !reasons.some((x) => x.level === 'error') };
}

/** A header-only template (plus the optional columns) for a source, so a first-time user can fill it in instead of guessing. */
export function templateCsv(source) {
  const cols = source === 'sportsengine'
    ? ['First Name', 'Last Name', 'Email', 'Date of Birth', 'Team Name', 'Role', 'Jersey Number', 'Parent/Guardian Email', 'Phone']
    : source === 'teamsnap'
      ? ['First', 'Last', 'Email', 'Phone', 'Team', 'Role', 'Jersey Number', 'Birthday', 'Parent Email']
      : ['first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'team', 'role', 'jersey_number', 'guardian_email', 'guardian_name'];
  return toCsv(cols, []);
}

export const maskEmail = (e) => {
  if (!e) return null;
  const [u, d] = String(e).split('@');
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(u.length - 1, 5)))}@${d ?? ''}`;
};
