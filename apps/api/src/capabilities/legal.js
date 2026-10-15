// Legal Services (issue #231), part 1: jurisdiction packs, lawyer credentials and profile, permitted discovery, anonymised public requests.
// Country selection is never compliance: regulated workflows stay off for a country until qualified local counsel has approved its pack.
// Search is informational and always available; it lists only lawyers with a current verified credential for the jurisdiction asked about.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, hasRole } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { DELIVERY_MODES, FEE_MODELS, NOT_SUPPORTED, PACKS, PACK_CODES, PACK_VERSION, PRACTICE_AREAS, REGULATED_FEATURES, packView } from '../legal/packs.js';
import { approvals, packFor, requireFeature, verifiedCredentials } from '../legal/core.js';

const TAG = 'Legal';
const country = z.string().trim().toUpperCase().refine((v) => PACK_CODES.includes(v), { message: `Choose from: ${PACK_CODES.join(', ')}` });
const area = z.enum(Object.keys(PRACTICE_AREAS));
const isLawyer = (user) => user.roles?.includes('lawyer');
const mustBeLawyer = (user) => { if (!isLawyer(user)) throw forbidden('Add the lawyer role to your account first'); };

cap({
  name: 'list_legal_packs', method: 'GET', path: '/legal/packs', tag: TAG, auth: 'public', scope: 'read',
  summary: 'The eleven jurisdiction packs (US, UK, Canada, UAE, India, Singapore, Malaysia, China, Japan, Australia, New Zealand): instruments, regulators, primary sources, open questions, and whether qualified local counsel has approved each regulated workflow. Also the practice areas, fee models and what the platform never offers. A research anchor, not legal advice.',
  input: z.object({}),
  async handler() {
    const ap = await approvals();
    return { pack_version: PACK_VERSION, regulated_features: REGULATED_FEATURES, practice_areas: PRACTICE_AREAS, fee_models: FEE_MODELS, not_supported: NOT_SUPPORTED, packs: PACK_CODES.map((c) => packView(c, ap[c])) };
  },
});

cap({
  name: 'record_legal_pack_approval', method: 'POST', path: '/admin/legal/packs/:country/approval', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: record qualified local counsel\'s decision on one country\'s pack - which regulated workflows are switched on (requests, responses, intake, quotes, engagement) - or withdraw it. Append-only: the latest decision is the state, earlier ones are kept. Switching a workflow on needs the reviewer\'s name, firm and review date.',
  input: z.object({ country, status: z.enum(['approved', 'withdrawn']), features: z.array(z.enum(REGULATED_FEATURES)).max(5).default([]), reviewer_name: z.string().trim().min(3).max(120), reviewer_firm: z.string().trim().max(160).optional(), reviewed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().max(2000).optional() }),
  async handler({ user }, i) {
    if (i.status === 'approved' && !i.features.length) throw badRequest('Choose at least one workflow to switch on');
    if (i.status === 'approved' && !i.reviewer_firm) throw badRequest('Name the firm or chambers that reviewed this pack');
    if (Date.parse(i.reviewed_on) > Date.now()) throw badRequest('The review date cannot be in the future');
    if (i.status === 'approved' && i.features.includes('responses') && !i.features.includes('requests')) throw badRequest('Lawyer responses need public requests to be switched on too');
    return tx(async (c) => {
      const r = (await c.query('INSERT INTO legal_pack_approvals(country, pack_version, status, features, reviewer_name, reviewer_firm, reviewed_on, note_enc, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [i.country, PACK_VERSION, i.status, i.status === 'approved' ? [...new Set(i.features)] : [], i.reviewer_name, i.reviewer_firm ?? null, i.reviewed_on, encrypt(i.note, 'legal_pack_approvals.note'), user.id])).rows[0];
      await audit(c, user.id, 'record_legal_pack_approval', 'legal_pack_approvals', null);
      return packView(i.country, r);
    });
  },
});

// ---------- lawyer credentials and profile ----------

const credOut = (r) => ({
  id: r.id, jurisdiction: r.jurisdiction, region: r.region, regulator: r.regulator, title: r.title, practice_areas: r.practice_areas,
  register_ref: decrypt(r.register_ref_enc, 'legal_credentials.register_ref'), restrictions: decrypt(r.restrictions_enc, 'legal_credentials.restrictions'),
  verified: !!r.verified_at, verified_at: r.verified_at ?? null, verified_until: r.verified_until ?? null,
});

cap({
  name: 'save_my_legal_credential', method: 'POST', path: '/legal/me/credentials', tag: TAG, auth: ['lawyer'], status: 201,
  summary: 'Lawyer: state where you are admitted - jurisdiction, state/province/legal system, regulator, register reference, title, practice areas and any restrictions. It counts only once the platform team has approved a `lawyer` verification (identity + admission + right to practise) for the same jurisdiction. Admission in one jurisdiction never covers another. Saving again for the same jurisdiction and region updates it.',
  input: z.object({ jurisdiction: country, region: z.string().trim().max(80).optional().describe('state / province / emirate / legal system as the regulator names it'), regulator: z.string().trim().min(2).max(160), register_ref: z.string().trim().min(2).max(80), title: z.string().trim().min(2).max(80), practice_areas: z.array(area).min(1).max(10), restrictions: z.string().trim().max(1000).optional() }),
  async handler({ user }, i) {
    mustBeLawyer(user);
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO legal_credentials(user_id, jurisdiction, region, regulator, register_ref_enc, title, practice_areas, restrictions_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, jurisdiction, coalesce(region, '')) WHERE archived_at IS NULL
         DO UPDATE SET regulator=$4, register_ref_enc=$5, title=$6, practice_areas=$7, restrictions_enc=$8, updated_at=now() RETURNING *`,
        [user.id, i.jurisdiction, i.region ?? null, i.regulator, encrypt(i.register_ref, 'legal_credentials.register_ref'), i.title, [...new Set(i.practice_areas)], encrypt(i.restrictions, 'legal_credentials.restrictions')])).rows[0];
      await audit(c, user.id, 'save_legal_credential', 'legal_credentials', row.id);
      const [v] = await verifiedCredentials([user.id], { country: i.jurisdiction }, c);
      return credOut({ ...row, verified_at: v?.verified_at, verified_until: v?.verified_until });
    });
  },
});

cap({
  name: 'list_my_legal_credentials', method: 'GET', path: '/legal/me/credentials', tag: TAG, auth: ['lawyer'], scope: 'read',
  summary: 'Lawyer: your admissions with whether each is currently verified (approved lawyer verification for that jurisdiction, not expired). A lapsed or revoked verification stops new regulated engagements; existing matters, handover and cancellation are not blocked.',
  input: z.object({}),
  async handler({ user }) {
    mustBeLawyer(user);
    const rows = await many('SELECT * FROM legal_credentials WHERE user_id=$1 AND archived_at IS NULL ORDER BY jurisdiction, region NULLS FIRST', [user.id]);
    const ok = await verifiedCredentials([user.id]);
    await audit(null, user.id, 'read_legal_credential', 'legal_credentials', null);
    return rows.map((r) => credOut({ ...r, ...(ok.find((o) => o.id === r.id) ? { verified_at: ok.find((o) => o.id === r.id).verified_at, verified_until: ok.find((o) => o.id === r.id).verified_until } : {}) }));
  },
});

cap({
  name: 'archive_my_legal_credential', method: 'POST', path: '/legal/me/credentials/:id/archive', tag: TAG, auth: ['lawyer'],
  summary: 'Lawyer: stop relying on an admission (for example after it lapsed). The record is archived, never deleted; matters opened under it keep their history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE legal_credentials SET archived_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 AND archived_at IS NULL RETURNING id', [i.id, user.id]);
    if (!r) throw notFound('Credential');
    return { id: r.id, archived: true };
  },
});

const profileOut = (p) => p && ({ headline: p.headline, bio: p.bio, languages: p.languages, delivery_modes: p.delivery_modes, fee_models: p.fee_models, firm_name: p.firm_name, listed: p.listed, updated_at: p.updated_at });

cap({
  name: 'save_my_legal_profile', method: 'POST', path: '/legal/me/profile', tag: TAG, auth: ['lawyer'],
  summary: 'Lawyer: your public presence - headline, short bio, languages, delivery modes, fee models you offer (flat, hourly, capped, milestone, retainer; contingency is not offered) and a displayed firm name. Listing needs at least one currently verified credential. There are no ratings, win counts, "specialist" labels or free-consultation flags.',
  input: z.object({ headline: z.string().trim().max(140).optional(), bio: z.string().trim().max(1500).optional(), languages: z.array(z.string().trim().min(2).max(40)).max(8).default([]), delivery_modes: z.array(z.enum(DELIVERY_MODES)).min(1).default(['remote']), fee_models: z.array(z.enum(Object.keys(FEE_MODELS))).max(5).default([]), firm_name: z.string().trim().max(160).optional(), listed: z.boolean().default(false) }),
  async handler({ user }, i) {
    mustBeLawyer(user);
    if (i.listed && !(await verifiedCredentials([user.id])).length) throw conflict('You can be listed once the platform team has verified at least one of your admissions (request a lawyer verification under Me → Verification).');
    const p = await one(
      `INSERT INTO legal_profiles(user_id, headline, bio, languages, delivery_modes, fee_models, firm_name, listed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id) DO UPDATE SET headline=$2, bio=$3, languages=$4, delivery_modes=$5, fee_models=$6, firm_name=$7, listed=$8, updated_at=now() RETURNING *`,
      [user.id, i.headline ?? null, i.bio ?? null, i.languages, [...new Set(i.delivery_modes)], [...new Set(i.fee_models)], i.firm_name ?? null, i.listed]);
    return profileOut(p);
  },
});

cap({
  name: 'get_my_legal_profile', method: 'GET', path: '/legal/me/profile', tag: TAG, auth: ['lawyer'], scope: 'read',
  summary: 'Lawyer: your public presence as saved (null before the first save).',
  input: z.object({}),
  async handler({ user }) { return profileOut(await one('SELECT * FROM legal_profiles WHERE user_id=$1', [user.id])); },
});

// ---------- discovery ----------

async function cards(rows, ap) {
  const creds = await verifiedCredentials(rows.map((r) => r.user_id));
  return rows.map((r) => {
    const mine = creds.filter((x) => x.user_id === r.user_id);
    return {
      id: r.user_id, handle: r.handle, display_name: r.display_name, headline: r.headline, bio: r.bio, firm_name: r.firm_name, solo: !r.firm_name,
      languages: r.languages, delivery_modes: r.delivery_modes, fee_models: r.fee_models,
      admissions: mine.map((x) => ({ jurisdiction: x.jurisdiction, region: x.region, regulator: x.regulator, title: x.title, practice_areas: x.practice_areas, verified_at: x.verified_at, verified_until: x.verified_until, can_engage_online: !!ap[x.jurisdiction] && ap[x.jurisdiction].status === 'approved' && ap[x.jurisdiction].pack_version === PACK_VERSION && ['intake', 'quotes', 'engagement'].every((f) => ap[x.jurisdiction].features.includes(f)), restrictions: decrypt(x.restrictions_enc, 'legal_credentials.restrictions') })),
      note: 'Listed only for the jurisdictions shown. International experience is not local admission.',
    };
  });
}

cap({
  name: 'search_legal_counsel', method: 'GET', path: '/legal/counsel', tag: TAG, auth: 'public', scope: 'read',
  summary: 'Find counsel (informational; always available). Only listed lawyers with a currently verified credential appear, and a jurisdiction filter matches admission there - not foreign experience. Filters: jurisdiction, practice area, language, delivery mode, fee model, solo or firm. No paid placement, no ratings: results are ordered by name. `can_engage_online` says whether that admission\'s country has had its regulated workflows approved.',
  input: z.object({ jurisdiction: country.optional(), region: z.string().trim().max(80).optional(), practice_area: area.optional(), language: z.string().trim().max(40).optional(), delivery_mode: z.enum(DELIVERY_MODES).optional(), fee_model: z.enum(Object.keys(FEE_MODELS)).optional(), firm: z.enum(['solo', 'firm']).optional(), ...page }),
  async handler(_, i) {
    const rows = await many(
      `SELECT p.*, u.handle, u.display_name FROM legal_profiles p JOIN users u ON u.id=p.user_id
        WHERE p.listed AND u.access_status = 'approved'
          AND ($1::text IS NULL OR $1 = ANY(p.delivery_modes)) AND ($2::text IS NULL OR $2 = ANY(p.fee_models))
          AND ($3::text IS NULL OR lower($3) = ANY(SELECT lower(x) FROM unnest(p.languages) x))
          AND ($4::text IS NULL OR ($4 = 'solo') = (p.firm_name IS NULL))
          AND EXISTS (SELECT 1 FROM legal_credentials cr WHERE cr.user_id=p.user_id AND cr.archived_at IS NULL
                        AND ($5::text IS NULL OR cr.jurisdiction=$5) AND ($6::text IS NULL OR cr.region ILIKE $6) AND ($7::text IS NULL OR $7 = ANY(cr.practice_areas))
                        AND EXISTS (SELECT 1 FROM verification_cases v WHERE v.type='lawyer' AND v.subject_id=cr.user_id AND v.status='approved' AND v.expires_at > now() AND upper(v.jurisdiction)=cr.jurisdiction))
        ORDER BY u.display_name, p.user_id LIMIT $8 OFFSET $9`,
      [i.delivery_mode ?? null, i.fee_model ?? null, i.language ?? null, i.firm ?? null, i.jurisdiction ?? null, i.region ?? null, i.practice_area ?? null, i.limit, i.offset]);
    return cards(rows, await approvals());
  },
});

cap({
  name: 'get_legal_counsel', method: 'GET', path: '/legal/counsel/:id', tag: TAG, auth: 'public', scope: 'read',
  summary: 'One lawyer\'s public profile with their verified admissions and limits.',
  input: z.object({ id }),
  async handler(_, i) {
    const row = await one('SELECT p.*, u.handle, u.display_name FROM legal_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND p.listed', [i.id]);
    if (!row) throw notFound('Lawyer');
    const [card] = await cards([row], await approvals());
    if (!card.admissions.length) throw notFound('Lawyer');
    return card;
  },
});

// ---------- public requests (anonymised) ----------

const reqOut = (r) => ({ id: r.id, practice_area: r.practice_area, practice_area_label: PRACTICE_AREAS[r.practice_area], jurisdiction: r.jurisdiction, region: r.region, language: r.language, timeframe: r.timeframe, budget_cents: r.budget_cents, currency: r.currency, status: r.status, created_at: r.created_at, responses: r.responses ?? undefined });

cap({
  name: 'create_legal_request', method: 'POST', path: '/legal/requests', tag: TAG, status: 201,
  summary: 'Ask for counsel without naming anyone: practice area, jurisdiction, timeframe and budget only - there is deliberately no free text, so no opponents, medical detail, evidence or strategy can be posted. Sensitive details go into a private intake with one lawyer. Needs the country\'s `requests` workflow to be approved.',
  input: z.object({ practice_area: area, jurisdiction: country, region: z.string().trim().max(80).optional(), language: z.string().trim().max(40).optional(), timeframe: z.enum(['urgent', 'this_month', 'flexible']), budget_cents: z.number().int().min(0).max(1e10).optional(), currency: z.string().trim().toUpperCase().length(3).optional() }),
  async handler({ user }, i) {
    if (i.budget_cents != null && !i.currency) throw badRequest('Give the currency of the budget');
    await requireFeature(i.jurisdiction, 'requests');
    const r = await one('INSERT INTO legal_requests(author_id, practice_area, jurisdiction, region, language, timeframe, budget_cents, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [user.id, i.practice_area, i.jurisdiction, i.region ?? null, i.language ?? null, i.timeframe, i.budget_cents ?? null, i.currency ?? null]);
    return reqOut(r);
  },
});

cap({
  name: 'list_my_legal_requests', method: 'GET', path: '/legal/requests/mine', tag: TAG, scope: 'read',
  summary: 'Your own public requests with how many verified lawyers have said they are available.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    return (await many('SELECT r.*, (SELECT count(*)::int FROM legal_request_responses x WHERE x.request_id=r.id) AS responses FROM legal_requests r WHERE r.author_id=$1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset])).map(reqOut);
  },
});

cap({
  name: 'list_legal_requests', method: 'GET', path: '/legal/requests', tag: TAG, auth: ['lawyer'], scope: 'read',
  summary: 'Lawyer: open public requests that match a jurisdiction and practice area you hold a current verified credential for, in countries whose `responses` workflow is approved. Where solicitation is restricted (for example India) and not approved, nothing is listed. No requester identity is shown.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    mustBeLawyer(user);
    const creds = await verifiedCredentials([user.id]);
    const ap = await approvals();
    const open = (c) => ap[c]?.status === 'approved' && ap[c].pack_version === PACK_VERSION && ap[c].features.includes('responses');
    const mine = creds.filter((c) => open(c.jurisdiction));
    if (!mine.length) return [];
    const rows = await many(
      `SELECT r.*, EXISTS (SELECT 1 FROM legal_request_responses x WHERE x.request_id=r.id AND x.lawyer_id=$1) AS responded FROM legal_requests r
        WHERE r.status='open' AND r.author_id <> $1 AND r.jurisdiction = ANY($2::text[]) AND r.practice_area = ANY($3::text[])
        ORDER BY r.created_at DESC, r.id`,
      [user.id, [...new Set(mine.map((c) => c.jurisdiction))], [...new Set(mine.flatMap((c) => c.practice_areas))]]);
    const fits = (r) => mine.some((c) => c.jurisdiction === r.jurisdiction && c.practice_areas.includes(r.practice_area) && (!r.region || !c.region || c.region.toLowerCase() === r.region.toLowerCase()));
    return rows.filter(fits).slice(i.offset, i.offset + i.limit).map((r) => ({ ...reqOut(r), responded: r.responded }));
  },
});

cap({
  name: 'respond_to_legal_request', method: 'POST', path: '/legal/requests/:id/respond', tag: TAG, auth: ['lawyer'], status: 201,
  summary: 'Lawyer: tell the requester you are available. This is an availability signal only - not advice and not an engagement. The requester is told a verified lawyer admitted in their jurisdiction is available and can open your profile; nothing else is shared. Needs the country\'s `responses` workflow to be approved and a current credential for the practice area.',
  input: z.object({ id }),
  async handler({ user }, i) {
    mustBeLawyer(user);
    const r = await one("SELECT * FROM legal_requests WHERE id=$1 AND status='open'", [i.id]);
    if (!r) throw notFound('Request');
    await requireFeature(r.jurisdiction, 'responses');
    const cr = (await verifiedCredentials([user.id], { country: r.jurisdiction, practiceArea: r.practice_area }))[0];
    if (!cr) throw forbidden('You need a current verified credential for this practice area in this jurisdiction to respond');
    if (r.author_id === user.id) throw badRequest('You cannot respond to your own request');
    return tx(async (c) => {
      const x = (await c.query('INSERT INTO legal_request_responses(request_id, lawyer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [r.id, user.id])).rows[0];
      if (!x) throw conflict('You have already responded to this request');
      await notify(c, r.author_id, { kind: 'legal_request_response', title: 'A verified lawyer is available', body: 'Open Legal → Find Counsel to view their profile. Nothing has been shared and no engagement exists.', data: { request_id: r.id, lawyer_id: user.id } });
      return { request_id: r.id, responded: true };
    });
  },
});

cap({
  name: 'close_legal_request', method: 'POST', path: '/legal/requests/:id/close', tag: TAG,
  summary: 'Close your own public request. It is kept, not deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one("UPDATE legal_requests SET status='closed', closed_at=now() WHERE id=$1 AND author_id=$2 AND status='open' RETURNING *", [i.id, user.id]);
    if (!r) throw notFound('Open request');
    return reqOut(r);
  },
});
