// "Who is this for" answers shared by team posts, events and programmes, so a player's card can be compared with them
// (opportunity matching). Every answer is optional: what the organiser leaves out is shown to players as missing data.
export const LEVEL_OPTIONS = [{ value: 'beginner', label: 'Beginner' }, { value: 'amateur', label: 'Amateur' }, { value: 'semi_pro', label: 'Semi-pro' }, { value: 'pro', label: 'Pro' }];

export const whoForFields = ({ positions = false, region = false } = {}) => [
  { key: '_who', type: 'section', label: 'Who it is for (optional) — players see how well they fit' },
  ...(positions ? [{ key: 'positions_text', label: 'Positions wanted (separate with commas)', optional: true, placeholder: 'Striker, Goalkeeper' }] : []),
  { key: 'levels', label: 'Levels', type: 'multi', options: LEVEL_OPTIONS, optional: true },
  ...(region ? [{ key: 'region', label: 'Region', type: 'region', optional: true }] : []),
  { key: 'age_limited', label: 'Limit by age', type: 'switch' },
  { key: 'min_age', label: 'Youngest age', type: 'stepper', min: 3, max: 99, default: 12, show: (v) => !!v.age_limited },
  { key: 'max_age', label: 'Oldest age', type: 'stepper', min: 3, max: 99, default: 18, show: (v) => !!v.age_limited },
];

export const whoForInitial = (row = {}) => ({
  positions_text: (row.positions ?? []).join(', '), levels: row.levels ?? [], region: row.region ?? '',
  age_limited: row.min_age != null || row.max_age != null, min_age: row.min_age ?? 12, max_age: row.max_age ?? 18,
});

/** Request fields from the form values. `clear` sends nulls for an edit that removes the age limit. */
export const whoForBody = (v, { clear = false } = {}) => {
  const out = {};
  const positions = (v.positions_text ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (v.positions_text !== undefined) out.positions = positions;
  if (v.levels?.length) out.levels = v.levels; else if (clear) out.levels = [];
  if (v.region) out.region = v.region;
  if (v.age_limited) { out.min_age = v.min_age; out.max_age = Math.max(v.max_age, v.min_age); } else if (clear) { out.min_age = null; out.max_age = null; }
  return out;
};
