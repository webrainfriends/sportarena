// Explainable opportunity matching (issue #316): one place that compares a player's card, preferences and availability with
// open team posts, events/trials, study programmes and sponsorship calls, and says why each fits or what is missing.
// It reads the existing sources only (no copies) and stores nothing. Rules live in src/opportunity-match.js; docs/opportunity-matching.md.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one } from '../db.js';
import { notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt } from '../crypto.js';
import { toCsv } from '../csv.js';
import { badgesFor } from '../verification.js';
import { CLOSES_AT, roundState } from '../sponsorship-calls.js';
import { CONSENT_PURPOSE } from '../recruitment.js';
import { YOUTH_SQL, ageOf, requireConsent, requireGuardian } from '../youth.js';
import { KINDS, compareMatches, evaluate } from '../opportunity-match.js';

const TAG = 'Opportunities';
const POOL = 200; // candidates read per kind before scoring; the response says when a pool was full
const SPORT_COLS = 's.slug AS sport_slug, s.name AS sport_name';

/** Everything about the player the rules need, read live on every call (so revoked consent or removed availability takes effect at once). */
async function subjectOf(user, subjectId) {
  const self = subjectId === user.id;
  if (!self) await requireGuardian(user, subjectId);
  const u = await one(`SELECT u.id, u.dob_enc, ${YOUTH_SQL} AS youth FROM users u WHERE u.id=$1`, [subjectId]);
  if (!u) throw notFound('Player');
  if (u.youth) await requireConsent(subjectId, CONSENT_PURPOSE, 'matching opportunities for a young person');
  let age = null;
  if (u.dob_enc) {
    if (!self) await audit(null, user.id, 'read_dob_for_matching', 'users', subjectId);
    age = ageOf(decrypt(u.dob_enc, 'users.dob'));
  }
  const [profiles, prefs, windows, badges] = await Promise.all([
    many(`SELECT p.id, p.level, p.position, p.positions, p.region, p.is_default, ${SPORT_COLS} FROM active_sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 ORDER BY p.is_default DESC, s.slug, p.id`, [subjectId]),
    one('SELECT sport_slugs, regions, open_to, budget_cents::bigint AS budget_cents, budget_currency FROM recruitment_preferences WHERE user_id=$1', [subjectId]),
    many("SELECT kind, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date, weekdays FROM recruitment_availability WHERE user_id=$1 AND removed_at IS NULL AND to_date >= current_date ORDER BY from_date, id", [subjectId]),
    badgesFor('user', [subjectId]),
  ]);
  const p = prefs ?? { sport_slugs: [], regions: [], open_to: [], budget_cents: null, budget_currency: null };
  return {
    id: subjectId, age, youth: u.youth, verified: (badges.get(subjectId) ?? []).length > 0, profiles, windows,
    prefs: { ...p, budget_cents: p.budget_cents == null ? null : Number(p.budget_cents) },
  };
}

const sportsOf = (s, only) => {
  const fromCards = s.profiles.filter((p) => !only || p.id === only).map((p) => p.sport_slug);
  return [...new Set(only ? fromCards : [...fromCards, ...s.prefs.sport_slugs])];
};
/** The card of the sport an opportunity is for (the default card wins when there are several). */
const withCard = (s, o) => ({ ...s, profile: o.sport_slug ? s.profiles.find((p) => p.sport_slug === o.sport_slug) ?? null : s.profiles.find((p) => p.is_default) ?? s.profiles[0] ?? null });

// ───── candidate readers: one per kind, each returns the neutral shape the scorer reads ─────
const base = (kind, row, extra) => ({ kind, id: row.id, title: row.title, sport_slug: row.sport_slug ?? null, sport_name: row.sport_name ?? null, positions: [], levels: [], region: null, regions: [], min_age: null, max_age: null, starts_on: null, deadline_at: null, cost: null, window_kinds: null, date: null, ...extra });

const READERS = {
  async team_opening(s, { sports, ids }) {
    const rows = await many(
      `SELECT b.id, b.title, b.kind AS post_kind, b.compensation, b.budget_cents, b.currency, b.rate_unit, b.closes_at, b.verified_applicants_only, b.city, b.region, b.positions, b.levels, b.min_age, b.max_age, b.starts_at, t.name AS team_name, ${SPORT_COLS}
         FROM billboard_posts b LEFT JOIN sports s ON s.id=b.sport_id LEFT JOIN teams t ON t.id=b.team_id
        WHERE b.status='open' AND b.kind IN ('team_recruiting','match_players','assignment') AND (b.closes_at IS NULL OR b.closes_at > now() OR $2::uuid IS NOT NULL) AND b.author_id <> $1
          AND ($2::uuid IS NOT NULL AND b.id=$2 OR $2::uuid IS NULL AND (b.sport_id IS NULL OR s.slug = ANY($3::text[])))
          AND (b.starts_at IS NULL OR b.starts_at > now() OR $2::uuid IS NOT NULL)
        ORDER BY b.created_at DESC, b.id LIMIT $4`, [s.id, ids ?? null, sports, POOL]);
    return rows.map((r) => base('team_opening', r, { positions: r.positions, levels: r.levels, region: r.region ?? r.city, min_age: r.min_age, max_age: r.max_age, starts_on: r.starts_at, date: r.starts_at, window_kinds: ['trial', 'start'], team_name: r.team_name, post_kind: r.post_kind, deadline_at: r.closes_at, verified_only: r.verified_applicants_only,
      compensation: r.compensation, pay: r.compensation === 'paid' && r.budget_cents != null ? { cents: Number(r.budget_cents), currency: r.currency, rate_unit: r.rate_unit } : null }));
  },
  async competition(s, { sports, ids, wide }) {
    const rows = await many(
      `SELECT e.id, e.name AS title, e.kind AS event_kind, e.city, e.region, e.levels, e.min_age, e.max_age, e.starts_on, e.registration_deadline, e.entry_fee_cents, e.currency, ${SPORT_COLS}
         FROM events e JOIN sports s ON s.id=e.sport_id
        WHERE e.status='open' AND e.organizer_id <> $1 AND (e.registration_deadline IS NULL OR e.registration_deadline > now() OR $2::uuid IS NOT NULL OR $5::boolean)
          AND ($2::uuid IS NOT NULL AND e.id=$2 OR $2::uuid IS NULL AND (s.slug = ANY($3::text[]) AND (e.starts_on IS NULL OR e.starts_on >= current_date)))
        ORDER BY e.starts_on NULLS LAST, e.id LIMIT $4`, [s.id, ids ?? null, sports, POOL, !!wide]);
    return rows.map((r) => base('competition', r, { levels: r.levels, region: r.region ?? r.city, min_age: r.min_age, max_age: r.max_age, starts_on: r.starts_on, date: r.starts_on, deadline_at: r.registration_deadline,
      cost: { cents: Number(r.entry_fee_cents), currency: r.currency }, window_kinds: r.event_kind === 'trial' ? ['trial'] : null, event_kind: r.event_kind }));
  },
  async study(s, { sports, ids }) {
    const rows = await many(
      `SELECT p.id, p.title, p.kind AS programme_kind, p.fee_minor, p.currency, p.next_intake_on, p.levels, p.min_age, p.max_age, o.name AS institution, o.city, ip.country,
              (SELECT s.slug FROM programme_sports ps JOIN sports s ON s.id=ps.sport_id WHERE ps.programme_id=p.id AND ps.removed_at IS NULL AND s.slug = ANY($2::text[]) ORDER BY s.slug LIMIT 1) AS sport_slug,
              (SELECT s.name FROM programme_sports ps JOIN sports s ON s.id=ps.sport_id WHERE ps.programme_id=p.id AND ps.removed_at IS NULL AND s.slug = ANY($2::text[]) ORDER BY s.slug LIMIT 1) AS sport_name
         FROM programmes p JOIN organisations o ON o.id=p.organisation_id JOIN institution_profiles ip ON ip.organisation_id=o.id
        WHERE p.status='active' AND o.status='active' AND ip.listed AND (p.next_intake_on IS NULL OR p.next_intake_on >= current_date OR $1::uuid IS NOT NULL)
          AND ($1::uuid IS NOT NULL AND p.id=$1 OR $1::uuid IS NULL AND (NOT EXISTS (SELECT 1 FROM programme_sports ps WHERE ps.programme_id=p.id AND ps.removed_at IS NULL)
               OR EXISTS (SELECT 1 FROM programme_sports ps JOIN sports s ON s.id=ps.sport_id WHERE ps.programme_id=p.id AND ps.removed_at IS NULL AND s.slug = ANY($2::text[]))))
        ORDER BY p.next_intake_on NULLS LAST, p.id LIMIT $3`, [ids ?? null, sports, POOL]);
    return rows.map((r) => base('study', { ...r, title: `${r.title} · ${r.institution}` }, { levels: r.levels, region: [r.city, r.country].filter(Boolean).join(', ') || null, min_age: r.min_age, max_age: r.max_age, starts_on: r.next_intake_on, date: r.next_intake_on,
      cost: r.fee_minor == null ? null : { cents: Number(r.fee_minor), currency: r.currency }, window_kinds: ['start', 'visit'], institution: r.institution, programme_kind: r.programme_kind, cost_unstated: r.fee_minor == null }));
  },
  async sponsor(s, { sports, ids }) {
    const rows = await many(
      `SELECT p.id, p.name AS title, p.sports, p.regions, p.eligibility, p.max_award_cents, p.currency, sp.name AS sponsor_name,
              (SELECT min(${CLOSES_AT('r')}) FROM sponsorship_rounds r WHERE r.program_id=p.id AND ${roundState('r')}='open') AS closes_at
         FROM sponsorship_programs p JOIN sponsors sp ON sp.id=p.sponsor_id
        WHERE p.status='published' AND EXISTS (SELECT 1 FROM sponsorship_rounds r WHERE r.program_id=p.id AND ${roundState('r')}='open')
          AND (p.visibility='public' OR EXISTS (SELECT 1 FROM sponsorship_invitations iv WHERE iv.program_id=p.id AND iv.invitee_user_id=$1 AND iv.status IN ('invited','viewed','applied')))
          AND ($2::uuid IS NOT NULL AND p.id=$2 OR $2::uuid IS NULL AND (cardinality(p.sports)=0 OR p.sports && $3::text[]))
        ORDER BY closes_at NULLS LAST, p.id LIMIT $4`, [s.id, ids ?? null, sports, POOL]);
    return rows.map((r) => {
      const slug = r.sports.length ? r.sports.find((x) => sports.includes(x)) ?? r.sports[0] : null;
      return base('sponsor', r, { sport_slug: slug, sport_name: slug, regions: r.regions, target_types: r.eligibility?.target_types ?? [], verified_only: !!r.eligibility?.verified_only, deadline_at: r.closes_at, date: r.closes_at,
        sponsor_name: r.sponsor_name, max_award_cents: r.max_award_cents == null ? null : Number(r.max_award_cents), currency: r.currency });
    });
  },
};

const view = (o) => ({ kind: o.kind, id: o.id, title: o.title, sport: o.sport_name, sport_slug: o.sport_slug, date: o.date ? new Date(o.date).toISOString() : null, deadline_at: o.deadline_at ? new Date(o.deadline_at).toISOString() : null, region: o.region ?? (o.regions?.length ? o.regions.join(', ') : null), cost: o.cost, organiser: o.team_name ?? o.institution ?? o.sponsor_name ?? null, compensation: o.compensation ?? null, pay: o.pay ?? null, max_award_cents: o.max_award_cents ?? null, currency: o.currency ?? o.cost?.currency ?? null });

async function runMatch(user, i) {
  const s = await subjectOf(user, i.on_behalf_of ?? user.id);
  const only = i.sport_profile_id;
  if (only && !s.profiles.some((p) => p.id === only)) throw notFound('Sport card');
  const sports = sportsOf(s, only);
  const kinds = i.kinds?.length ? i.kinds : KINDS;
  const now = new Date();
  const out = [];
  const full = [];
  if (sports.length) {
    for (const k of kinds) {
      const pool = await READERS[k](s, { sports, wide: i.include_ineligible });
      if (pool.length >= POOL) full.push(k);
      for (const o of pool) {
        const r = evaluate(withCard(s, o), o, now);
        out.push({ opportunity: view(o), fit: r.fit, score: r.score, eligible: r.eligible, checks: r.checks, rules: r.rules, missing: r.missing });
      }
    }
  }
  const shown = out.filter((m) => i.include_ineligible || m.eligible).sort(compareMatches);
  const gaps = new Map();
  for (const m of shown) for (const g of m.missing) {
    const key = `${g.who}|${g.dimension}|${g.where ?? ''}`;
    gaps.set(key, { who: g.who, dimension: g.dimension, where: g.where ?? null, matches: (gaps.get(key)?.matches ?? 0) + 1 });
  }
  return {
    subject_id: s.id, total: shown.length, hidden_ineligible: out.length - out.filter((m) => m.eligible).length,
    profile_gaps: sports.length ? [] : [{ who: 'player', dimension: 'sport', where: 'SportProfile', detail: 'Add a sport card (or pick sports in your recruitment preferences) so there is something to match.' }],
    gaps: [...gaps.values()].sort((a, b) => b.matches - a.matches || (a.dimension < b.dimension ? -1 : 1)),
    pool_full: full, shown,
  };
}

const MATCH_IN = { kinds: z.array(z.enum(KINDS)).max(4).optional(), sport_profile_id: id.optional(), on_behalf_of: id.optional(), include_ineligible: z.coerce.boolean().default(false) };
const kindsParam = z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), MATCH_IN.kinds);

cap({
  name: 'match_my_opportunities', method: 'GET', path: '/me/opportunity-matches', tag: TAG,
  summary: 'Open team posts, events and trials, study programmes and sponsorship calls compared with your sport card, preferences, availability and budget. Each result says per rule (position, level, region, availability, cost, eligibility) whether it fits, does not fit, or cannot be told because data is missing, who can add that data, and where. Unknown is never counted as a match. Ranked deterministically (fit, score, soonest date); results you are not eligible for are hidden unless include_ineligible. A guardian can pass on_behalf_of for a young person (needs current recruitment-sharing consent, checked on every call). Nothing is stored or shared: matches are private to you.',
  input: z.object({ ...MATCH_IN, kinds: kindsParam, ...page }),
  async handler({ user }, i) {
    const r = await runMatch(user, i);
    const { shown, ...rest } = r;
    return { ...rest, items: shown.slice(i.offset, i.offset + i.limit) };
  },
});

cap({
  name: 'explain_opportunity_match', method: 'GET', path: '/me/opportunity-matches/:kind/:id', tag: TAG,
  summary: 'The full rule-by-rule explanation of how one opportunity (team_opening, competition, study or sponsor) fits you, including data that is missing and who can add it.',
  input: z.object({ kind: z.enum(KINDS), id, sport_profile_id: id.optional(), on_behalf_of: id.optional() }),
  async handler({ user }, i) {
    const s = await subjectOf(user, i.on_behalf_of ?? user.id);
    if (i.sport_profile_id && !s.profiles.some((p) => p.id === i.sport_profile_id)) throw notFound('Sport card');
    const [o] = await READERS[i.kind](s, { sports: sportsOf(s, i.sport_profile_id), ids: i.id });
    if (!o) throw notFound('Opportunity');
    const r = evaluate(withCard(s, o), o, new Date());
    return { subject_id: s.id, opportunity: view(o), fit: r.fit, score: r.score, eligible: r.eligible, checks: r.checks, rules: r.rules, missing: r.missing };
  },
});

cap({
  name: 'export_my_opportunity_matches', method: 'GET', path: '/me/opportunity-matches/export', tag: TAG,
  summary: 'CSV of your current matches with the fit, score and which rules matched, did not match or are unknown. Same checks as the list (guardian consent is re-read); audit-logged.',
  input: z.object({ ...MATCH_IN, kinds: kindsParam }),
  async handler({ user }, i) {
    const r = await runMatch(user, i);
    await audit(null, user.id, 'export_opportunity_matches', 'users', r.subject_id);
    const list = (m, st) => m.rules.filter((x) => x.status === st).map((x) => x.rule).join(' ');
    const rows = r.shown.map((m) => ({ kind: m.opportunity.kind, title: m.opportunity.title, sport: m.opportunity.sport, fit: m.fit, score: m.score ?? '', eligible: m.eligible, date: m.opportunity.date ?? '', deadline: m.opportunity.deadline_at ?? '',
      matched: list(m, 'match'), not_matched: list(m, 'mismatch'), unknown: list(m, 'unknown') }));
    return { filename: 'opportunity-matches.csv', rows: rows.length, csv: toCsv(['kind', 'title', 'sport', 'fit', 'score', 'eligible', 'date', 'deadline', 'matched', 'not_matched', 'unknown'], rows) };
  },
});
