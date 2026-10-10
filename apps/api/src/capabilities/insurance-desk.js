// The insurer's desk: onboarding, profile, own plans, book of business and a summary. Everything an insurer sees about people is
// limited to what a policy or quote with them needs (no dates of birth, no beneficiary, no contact details).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { config } from '../config.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { card, COVER_FOR, myInsurer, PLAN_SQL, subjectName } from './insurance.js';

const profileFields = {
  description: z.string().max(1000).nullable().optional(), headline: z.string().max(140).nullable().optional(), website: z.string().url().nullable().optional(),
  licence_no: z.string().max(80).optional().describe('regulator licence number: encrypted, read only when the platform team verifies it'),
  regions: z.array(z.string().min(1).max(60)).max(30).optional(), sports: z.array(z.string().min(1).max(60)).max(60).optional(),
  accepting_requests: z.boolean().optional(),
};
const PUBLIC = 'id, name, status, description, headline, website, regions, sports, accepting_requests, verified_at, created_at';

cap({
  name: 'onboard_insurer', method: 'POST', path: '/insurance/my-insurer', tag: 'Insurance', auth: ['insurer'], status: 201,
  summary: 'Set up your insurer profile (insurer role required; one profile per account). Buyers see the name, headline, regions and sports; the licence number is encrypted and only read when the platform team verifies it. You can publish plans and answer quote requests straight away; the "verified" badge appears once the licence is checked.',
  input: z.object({ name: z.string().min(2).max(120), ...profileFields }),
  async handler({ user }, i) {
    if (!user.roles.includes('insurer')) throw badRequest('Add the insurer role to your account first');
    if (await one('SELECT 1 FROM insurers WHERE owner_id=$1', [user.id])) throw conflict('You already have an insurer profile');
    if (await one('SELECT 1 FROM insurers WHERE lower(name)=lower($1)', [i.name])) throw conflict('An insurer with that name already exists. If it is yours, ask the platform team to link it to your account.');
    return one(
      `INSERT INTO insurers(name, description, headline, website, licence_no_enc, regions, sports, accepting_requests, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,true),$9) RETURNING ${PUBLIC}, (licence_no_enc IS NOT NULL) AS has_licence`,
      [i.name, i.description ?? null, i.headline ?? null, i.website ?? null, i.licence_no ? encrypt(i.licence_no, 'insurers.licence_no') : null, i.regions ?? [], i.sports ?? [], i.accepting_requests ?? null, user.id]);
  },
});

cap({
  name: 'get_my_insurer', method: 'GET', path: '/insurance/my-insurer', tag: 'Insurance', auth: ['insurer'],
  summary: 'Your insurer profile, or null if you have not set it up yet. Includes whether a licence number is on file and the licence tail (masked) so you can confirm it.',
  input: z.object({}),
  async handler({ user }) {
    const r = await one(`SELECT ${PUBLIC}, licence_no_enc FROM insurers WHERE owner_id=$1`, [user.id]);
    if (!r) return null;
    const { licence_no_enc, ...rest } = r;
    const lic = licence_no_enc ? decrypt(licence_no_enc, 'insurers.licence_no') : null;
    return { ...rest, verified: !!r.verified_at, has_licence: !!lic, licence_hint: lic ? `••••${lic.slice(-3)}` : null };
  },
});

cap({
  name: 'update_my_insurer', method: 'PATCH', path: '/insurance/my-insurer', tag: 'Insurance', auth: ['insurer'],
  summary: 'Edit your insurer profile. Changing the licence number removes the "verified" mark until the platform team checks the new one. Set accepting_requests=false to pause new quote requests without hiding your plans.',
  input: z.object({ name: z.string().min(2).max(120).optional(), ...profileFields }),
  async handler({ user }, i) {
    const cur = await myInsurer(user);
    if (i.name && i.name.toLowerCase() !== cur.name.toLowerCase() && await one('SELECT 1 FROM insurers WHERE lower(name)=lower($1) AND id<>$2', [i.name, cur.id])) throw conflict('An insurer with that name already exists');
    const has = (k) => i[k] !== undefined;
    const lic = has('licence_no') ? (i.licence_no ? encrypt(i.licence_no, 'insurers.licence_no') : null) : cur.licence_no_enc;
    const relic = has('licence_no') && lic !== cur.licence_no_enc;
    return one(
      `UPDATE insurers SET name=$2, description=$3, headline=$4, website=$5, licence_no_enc=$6, regions=$7, sports=$8, accepting_requests=$9,
         verified_at=CASE WHEN $10 THEN NULL ELSE verified_at END, verified_by=CASE WHEN $10 THEN NULL ELSE verified_by END, updated_at=now() WHERE id=$1 RETURNING ${PUBLIC}`,
      [cur.id, i.name ?? cur.name, has('description') ? i.description : cur.description, has('headline') ? i.headline : cur.headline, has('website') ? i.website : cur.website, lic,
        i.regions ?? cur.regions, i.sports ?? cur.sports, i.accepting_requests ?? cur.accepting_requests, relic]);
  },
});

cap({
  name: 'list_my_insurance_plans', method: 'GET', path: '/insurance/my-plans', tag: 'Insurance', auth: ['insurer'],
  summary: 'Your plans, active and retired, with how many policies and open quotes each has. Use create_insurance_plan / update_insurance_plan to publish, change, advertise (promo_text) or retire them.',
  input: z.object({ status: z.enum(['active', 'retired']).optional(), ...page }),
  async handler({ user }, i) {
    const ins = await myInsurer(user);
    const rows = await many(
      `SELECT x.*, (SELECT count(*)::int FROM insurance_policies p WHERE p.plan_id=x.id AND p.status IN ('active','pending_payment')) AS live_policies,
         (SELECT count(*)::int FROM insurance_quotes q WHERE q.plan_id=x.id AND q.status='offered' AND q.valid_until >= current_date) AS open_quotes
       FROM (${PLAN_SQL.replace('$CUR', '$2')} WHERE pl.insurer_id=$1 AND ($3::text IS NULL OR pl.status=$3)) x ORDER BY x.status, x.name LIMIT $4 OFFSET $5`,
      [ins.id, config.payments.currency, i.status ?? null, i.limit, i.offset]);
    return rows.map(({ live_policies, open_quotes, ...r }) => ({ ...card(r), live_policies, open_quotes }));
  },
});

cap({
  name: 'list_insurer_policies', method: 'GET', path: '/insurance/insurer/policies', tag: 'Insurance', auth: ['insurer'],
  summary: 'Your book of business: policies written on your plans, with the holder\'s display name, what is covered, the premium, status and days left. Pass expiring_in_days to see what is about to lapse and who has already renewed. The policy number is shown in full (audit-logged); the beneficiary and the holder\'s personal details are never shown.',
  input: z.object({ status: z.enum(['pending_payment', 'active', 'expired', 'cancelled']).optional(), expiring_in_days: z.coerce.number().int().min(1).max(365).optional(), ...page }),
  async handler({ user }, i) {
    const ins = await myInsurer(user);
    const rows = await many(
      `SELECT p.id, p.plan_id, pl.name AS plan_name, p.holder_id, u.display_name AS holder, p.subject_type, p.subject_id,
              ${subjectName('p.subject_type', 'p.subject_id')} AS subject_name,
              p.status, (CASE WHEN p.ends_on < current_date AND p.status='active' THEN 'expired' ELSE p.status END) AS effective_status, p.starts_on, p.ends_on, (p.ends_on - current_date)::int AS days_left,
              p.amount_cents, (p.terms->>'coverage_cents')::bigint AS coverage_cents, p.quote_id, p.renewed_from,
              EXISTS (SELECT 1 FROM insurance_policies r WHERE r.renewed_from = p.id) AS renewed, p.policy_no_enc
         FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id JOIN users u ON u.id=p.holder_id
        WHERE pl.insurer_id=$1 AND ($2::text IS NULL OR p.status=$2) AND ($3::int IS NULL OR (p.status='active' AND p.ends_on BETWEEN current_date AND current_date + $3::int))
        ORDER BY p.ends_on LIMIT $4 OFFSET $5`, [ins.id, i.status ?? null, i.expiring_in_days ?? null, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_pii', 'insurance_policies', null);
    return rows.map(({ policy_no_enc, ...r }) => ({ ...r, policy_no: decrypt(policy_no_enc, 'insurance_policies.policy_no') }));
  },
});

cap({
  name: 'get_insurer_summary', method: 'GET', path: '/insurance/insurer/summary', tag: 'Insurance', auth: ['insurer'],
  summary: 'Your desk at a glance: requests waiting for a quote, quotes out, quotes accepted, live policies, policies expiring within 30 days that have not renewed, open claims, and premium written on live policies. `inbox` says whether you can receive open requests (profile active, accepting requests), how many open requests are on the Billboard, and how many open requests are your own (you cannot quote those).',
  input: z.object({}),
  async handler({ user }) {
    const ins = await myInsurer(user);
    const takes = ins.accepting_requests && ins.status === 'active';
    const s = await one(
      `SELECT
         (SELECT count(*)::int FROM insurance_quote_requests r WHERE r.status IN ('open','quoted') AND r.requester_id<>$4 AND (r.insurer_id=$1 OR (r.insurer_id IS NULL AND $2))
            AND NOT EXISTS (SELECT 1 FROM insurance_quotes q WHERE q.request_id=r.id AND q.insurer_id=$1) AND NOT EXISTS (SELECT 1 FROM insurance_request_declines d WHERE d.request_id=r.id AND d.insurer_id=$1)) AS requests_waiting,
         (SELECT count(*)::int FROM insurance_quotes WHERE insurer_id=$1 AND status='offered' AND valid_until >= current_date) AS quotes_out,
         (SELECT count(*)::int FROM insurance_quotes WHERE insurer_id=$1 AND status='accepted') AS quotes_accepted,
         (SELECT count(*)::int FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE pl.insurer_id=$1 AND p.status='active' AND p.ends_on >= current_date) AS live_policies,
         (SELECT count(*)::int FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE pl.insurer_id=$1 AND p.status='active' AND p.ends_on BETWEEN current_date AND current_date + 30
            AND NOT EXISTS (SELECT 1 FROM insurance_policies r WHERE r.renewed_from=p.id)) AS expiring_soon,
         (SELECT count(*)::int FROM insurance_claims cl JOIN insurance_policies p ON p.id=cl.policy_id JOIN insurance_plans pl ON pl.id=p.plan_id WHERE pl.insurer_id=$1 AND cl.status IN ('submitted','under_review')) AS open_claims,
         (SELECT coalesce(sum(p.amount_cents),0)::bigint FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE pl.insurer_id=$1 AND p.status='active' AND p.ends_on >= current_date) AS premium_live_cents,
         (SELECT count(*)::int FROM insurance_quote_requests r WHERE r.status IN ('open','quoted') AND r.insurer_id IS NULL AND r.requester_id<>$4) AS market_open,
         (SELECT count(*)::int FROM insurance_quote_requests r WHERE r.status IN ('open','quoted') AND (r.insurer_id IS NULL OR r.insurer_id=$1) AND r.requester_id=$4) AS own_hidden,
         $3::text AS currency`,
      [ins.id, takes, config.payments.currency, user.id]);
    const { market_open, own_hidden, ...rest } = s;
    return { ...rest, inbox: { status: ins.status, accepting_requests: ins.accepting_requests, market_open, own_requests_hidden: own_hidden } };
  },
});

cap({
  name: 'list_insurance_market', method: 'GET', path: '/insurance/market', tag: 'Insurance', auth: ['insurer'],
  summary: 'The insurance marketplace on the Billboard: requests open to every insurer (people, teams, events and venues asking for quotes), newest first, with what is wanted (cover, who or what, sport, city, people, months), how many quotes it already has and your own quote on it. Needs an active insurer profile that takes requests. Details a requester wrote in a note are only readable through get_quote_request. Answer with create_quote; pass on one with decline_quote_request.',
  input: z.object({ cover_for: z.enum(COVER_FOR).optional(), sport: z.string().max(60).optional(), city: z.string().max(80).optional(), unanswered: z.coerce.boolean().optional().describe('only requests you have not quoted yet'), ...page }),
  async handler({ user }, i) {
    const ins = await myInsurer(user);
    if (!(ins.accepting_requests && ins.status === 'active')) return [];
    return many(
      `SELECT r.id, r.cover_for, r.subject_id, CASE r.cover_for WHEN 'individual' THEN ur.display_name ELSE ${subjectName('r.cover_for', 'r.subject_id')} END AS subject_name, ur.display_name AS requester,
              r.months, r.participants, r.sport, r.city, r.status, r.created_at,
              (SELECT count(*)::int FROM insurance_quotes q WHERE q.request_id=r.id) AS quotes,
              (SELECT q.id FROM insurance_quotes q WHERE q.request_id=r.id AND q.insurer_id=$1 ORDER BY q.created_at DESC LIMIT 1) AS my_quote_id,
              (SELECT CASE WHEN q.status='offered' AND q.valid_until < current_date THEN 'expired' ELSE q.status END FROM insurance_quotes q WHERE q.request_id=r.id AND q.insurer_id=$1 ORDER BY q.created_at DESC LIMIT 1) AS my_quote_status
         FROM insurance_quote_requests r JOIN users ur ON ur.id=r.requester_id
        WHERE r.insurer_id IS NULL AND r.status IN ('open','quoted') AND r.requester_id<>$2
          AND NOT EXISTS (SELECT 1 FROM insurance_request_declines d WHERE d.request_id=r.id AND d.insurer_id=$1)
          AND ($3::text IS NULL OR r.cover_for=$3) AND ($4::text IS NULL OR r.sport=$4) AND ($5::text IS NULL OR r.city ILIKE '%' || $5 || '%')
          AND (NOT $6 OR NOT EXISTS (SELECT 1 FROM insurance_quotes q WHERE q.request_id=r.id AND q.insurer_id=$1))
        ORDER BY r.created_at DESC LIMIT $7 OFFSET $8`,
      [ins.id, user.id, i.cover_for ?? null, i.sport ?? null, i.city ? i.city.replace(/[%_\\]/g, '\\$&') : null, !!i.unanswered, i.limit, i.offset]);
  },
});
