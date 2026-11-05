// Adaptive coaching expertise (#837): the rules shared by the coach-adaptive capabilities.
// Principles: a coach opts in and DECLARES expertise; "verified" is never stored, it is derived live from the existing verification case
// (approved, unexpired, not revoked, scope covers the discipline). A coaching credential is never medical authorisation or official classification.
// Search and ranking use only what coaches declare or the platform verified about the coach, never anything about the athlete.
import { SPORT_TEMPLATES, NEED_TYPES } from './inclusion.js';
import { many } from './db.js';

/** Governed discipline catalogue: the native adaptation templates (the same families #808 uses). `generic` is the labelled fallback. */
export const DISCIPLINES = Object.entries(SPORT_TEMPLATES).filter(([, t]) => !t.fallback).map(([key, t]) => ({ key, sports: t.sports }));
export const DISCIPLINE_KEYS = DISCIPLINES.map((d) => d.key);
export const FORMATS = ['in_person', 'online', 'accessible_venue', 'home_visit'];
export const COMM = NEED_TYPES.communication;
export const DISCLAIMER = 'A coaching credential confirms coaching qualifications only. It is never medical authorisation and never an official classification.';

export const catalogue = () => ({
  disciplines: DISCIPLINES, delivery_formats: FORMATS, communication_support: COMM, credential_states: ['verified', 'self_declared', 'expired', 'revoked', 'none'], disclaimer: DISCLAIMER,
  generic_fallback: { key: 'generic', fallback: true, note: 'Sports without a native para template are served by the generic fallback.' },
});

/** The state of one verification case for display. Derived live, so expiry and revocation take effect at once. */
export const caseState = (c) => {
  if (!c) return 'self_declared';
  if (c.status === 'revoked') return 'revoked';
  if (c.status !== 'approved') return 'self_declared';
  const end = [c.expires_at, c.credential_expires_on ? new Date(`${c.credential_expires_on}T23:59:59Z`) : null].filter(Boolean).map((d) => new Date(d).getTime());
  return end.length && Math.min(...end) <= Date.now() ? 'expired' : 'verified';
};
const RANK = { verified: 4, expired: 3, revoked: 2, self_declared: 1, none: 0 };

/** Adaptive block for many coaches at once: { coachId -> { opted_in, state, formats, comm, expertise[] } }. Only opted-in, listed coaches carry expertise. */
export async function adaptiveFor(ids, { includePrivate = false } = {}) {
  if (!ids.length) return new Map();
  const profiles = await many('SELECT user_id, adaptive_opt_in, adaptive_formats, adaptive_comm FROM coach_profiles WHERE user_id = ANY($1::uuid[])', [ids]);
  const rows = await many(
    `SELECT e.id, e.coach_id, e.sport_id, s.slug AS sport, e.discipline, e.years, ${includePrivate ? 'e.training_enc,' : ''} e.case_id,
            v.status, v.expires_at, v.credential_expires_on::text AS credential_expires_on, v.issuing_authority, v.credential_title, v.scope_disciplines
       FROM coach_adaptive_expertise e JOIN sports s ON s.id=e.sport_id LEFT JOIN verification_cases v ON v.id=e.case_id AND v.type='coach'
      WHERE e.coach_id = ANY($1::uuid[]) AND e.archived_at IS NULL ORDER BY e.created_at`, [ids]);
  const out = new Map(ids.map((i) => [i, { opted_in: false, state: 'none', formats: [], comm: [], expertise: [] }]));
  for (const p of profiles) Object.assign(out.get(p.user_id), { opted_in: p.adaptive_opt_in, formats: p.adaptive_formats, comm: p.adaptive_comm });
  for (const r of rows) {
    const o = out.get(r.coach_id);
    // a credential backs a discipline only if its scope names that discipline (an empty scope names none)
    const backed = r.case_id && (r.scope_disciplines ?? []).includes(r.discipline) ? r : null;
    o.expertise.push({ id: r.id, sport: r.sport, discipline: r.discipline, years: r.years, state: caseState(backed ?? (r.case_id ? { status: 'submitted' } : null)),
      authority: backed?.issuing_authority ?? null, credential: backed?.credential_title ?? null,
      valid_to: backed ? [r.expires_at && new Date(r.expires_at).toISOString().slice(0, 10), r.credential_expires_on].filter(Boolean).sort()[0] ?? null : null, case_id: r.case_id, ...(includePrivate ? { training_enc: r.training_enc } : {}) });
  }
  for (const o of out.values()) o.state = o.opted_in && o.expertise.length ? o.expertise.reduce((b, e) => (RANK[e.state] > RANK[b] ? e.state : b), 'self_declared') : 'none';
  return out;
}
