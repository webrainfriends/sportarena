import { many } from './db.js';

/** Who may see a field: the athlete always; everyone else only at or above the field's scope. `recruiter` waits for the verified recruiter workspace (#313). */
export const SCOPES = ['private', 'coach', 'recruiter', 'public'];
export const SCOPED_FIELDS = ['dominant_side', 'positions', 'play_prefs', 'affiliations'];

/** Measurements an athlete may opt in to. Values are stored in the display unit entered and validated by range in the canonical unit. */
export const METRICS = {
  height: { label: 'Height', units: { cm: 1, in: 2.54 }, min: 50, max: 260 },
  weight: { label: 'Weight', units: { kg: 1, lb: 0.45359237 }, min: 10, max: 300 },
  wingspan: { label: 'Wingspan', units: { cm: 1, in: 2.54 }, min: 50, max: 300 },
  vertical_jump: { label: 'Vertical jump', units: { cm: 1, in: 2.54 }, min: 5, max: 200 },
  sprint_20m: { label: '20 m sprint', units: { s: 1 }, min: 1.5, max: 10 },
  sprint_40m: { label: '40 m sprint', units: { s: 1 }, min: 3, max: 15 },
};
export const METRIC_KEYS = Object.keys(METRICS);

/** Validates a value against the metric's unit and canonical range; returns the canonical value. */
export function canonical(metric, unit, value) {
  const m = METRICS[metric];
  if (!m) return null;
  const f = m.units[unit];
  if (!f) return null;
  const v = value * f;
  return v >= m.min && v <= m.max ? v : null;
}

const POSITIONS = {
  football: ['Goalkeeper', 'Centre-back', 'Full-back', 'Defensive midfield', 'Central midfield', 'Attacking midfield', 'Winger', 'Striker'],
  basketball: ['Point guard', 'Shooting guard', 'Small forward', 'Power forward', 'Center'],
  cricket: ['Opening batter', 'Middle-order batter', 'Wicket-keeper', 'Fast bowler', 'Spin bowler', 'All-rounder'],
  hockey: ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'],
  volleyball: ['Setter', 'Outside hitter', 'Middle blocker', 'Opposite', 'Libero'],
  rugby: ['Prop', 'Hooker', 'Lock', 'Flanker', 'Number 8', 'Scrum-half', 'Fly-half', 'Centre', 'Wing', 'Full-back'],
  baseball: ['Pitcher', 'Catcher', 'Infield', 'Outfield', 'Designated hitter'],
  handball: ['Goalkeeper', 'Wing', 'Back', 'Pivot'],
};
const PREFS = {
  football: ['Short passing', 'Long passing', 'Pressing', 'Counter-attack', 'Set pieces', 'Aerial duels'],
  basketball: ['Drive to the basket', 'Three-point shooting', 'Post play', 'Pick and roll', 'Defence first'],
  cricket: ['Aggressive', 'Anchor', 'Powerplay', 'Death overs'],
};
const GENERIC_PREFS = ['Team play', 'Individual play', 'Attacking', 'Defensive', 'Indoor', 'Outdoor'];

export const optionsFor = (slug) => ({
  sport: slug,
  positions: POSITIONS[slug] ?? [],
  positions_open: !POSITIONS[slug], // no fixed list for this sport: the athlete types their own
  play_prefs: PREFS[slug] ?? GENERIC_PREFS,
  metrics: METRIC_KEYS.map((k) => ({ metric: k, label: METRICS[k].label, units: Object.keys(METRICS[k].units) })),
});

/** The tiers a viewer holds toward one athlete. Self sees everything; a coach of a team the athlete is on sees `coach` fields. */
export async function viewerTiers(viewer, ownerId) {
  if (viewer?.id === ownerId) return { self: true, tiers: SCOPES };
  const tiers = ['public'];
  if (viewer) {
    const [shared] = await many(
      `SELECT 1 FROM team_members v JOIN team_members a ON a.team_id = v.team_id
        WHERE v.user_id=$1 AND a.user_id=$2 AND v.status='active' AND a.status='active' AND v.role IN ('coach','manager')`, [viewer.id, ownerId]);
    if (shared) tiers.push('coach');
  }
  return { self: false, tiers };
}

/** Keep only the scoped fields of a card the viewer's tiers allow. */
export function visibleFields(card, tiers) {
  const out = {};
  for (const f of SCOPED_FIELDS) {
    if (tiers.includes((card.field_scopes ?? {})[f] ?? 'private') && card[f] !== undefined) out[f] = card[f];
  }
  return out;
}

/** Completeness is computed from what the athlete chose to fill in; no biometric is ever required. */
export function completeness(card, { measurements = 0, affiliations = 0 } = {}) {
  const checks = [
    ['level', !!card.level], ['position', (card.positions?.length ?? 0) > 0 || !!card.position], ['dominant_side', !!card.dominant_side],
    ['play_prefs', (card.play_prefs?.length ?? 0) > 0], ['club', !!card.club], ['region', !!card.region],
    ['experience_years', card.experience_years != null], ['jersey_no', card.jersey_no != null], ['measurement', measurements > 0], ['affiliation', affiliations > 0],
  ];
  const done = checks.filter(([, ok]) => ok).length;
  return { percent: Math.round((done / checks.length) * 100), missing: checks.filter(([, ok]) => !ok).map(([k]) => k) };
}
