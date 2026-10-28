// Advertising — the platform's side (#524): the review desk, stopping an ad, reports from the public, advertiser suspension, policy and inventory,
// and the platform report. Platform admin only, enforced here on the server (mustBePlatformAdmin) and hidden in the app for everyone else.
// The platform's numbers come from the same immutable delivery records the advertiser's report is added up from.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { mustBePlatformAdmin } from '../platform.js';
import { CATEGORIES, PLACEMENT_CODES, PLACEMENTS, REVIEW_REASONS, isCategoryAllowed, CLAIM_TYPES, CTAS } from '../ads/policy.js';
import { CAMP, advertiserName, getPolicy, inventoryOf, logCampaign, moneyFor, reportFor, readiness, MICRO, creditUnusedFlat } from '../ads/engine.js';

const TAG = 'Advertising (platform)';
const adminOnly = ({ user }) => mustBePlatformAdmin(user);

const view = async (camp) => {
  const who = await one('SELECT organisation_id, user_id FROM ad_advertisers WHERE id=$1', [camp.advertiser_id]);
  return {
    id: camp.id, name: camp.name, status: camp.status, objective: camp.objective, category: camp.category, category_label: CATEGORIES[camp.category]?.label ?? camp.category,
    category_allowed: isCategoryAllowed(camp.category), advertiser_id: camp.advertiser_id, advertiser_name: await advertiserName(who),
    billing_model: camp.billing_model, rate_minor: Number(camp.rate_minor), currency: camp.currency, budget_minor: Number(camp.budget_minor), funded_minor: Number(camp.funded_minor),
    starts_on: camp.starts_on, ends_on: camp.ends_on, sports: camp.sports, countries: camp.countries, cities: camp.cities, keywords: camp.keywords, audience: camp.audience,
    frequency_per_day: camp.frequency_per_day, youth_contextual: camp.youth_contextual, held_by_platform: camp.held_by_platform, submitted_at: camp.submitted_at,
    landing: camp.landing_entity_type ? { type: 'entity', entity_type: camp.landing_entity_type, entity_id: camp.landing_entity_id } : camp.landing_url ? { type: 'external', url: camp.landing_url } : null,
  };
};

async function loadForReview(c, campaignId) {
  const camp = (await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1 FOR UPDATE`, [campaignId])).rows[0];
  if (!camp) throw notFound('Campaign');
  return camp;
}

async function tell(c, camp, title, body) {
  await notify(c, camp.created_by, { kind: 'ad_campaign_update', title, body, data: { campaign_id: camp.id }, dedupe_key: `ad:${camp.id}:${title}:${Date.now()}` });
}

// ================================================================================================== review desk
cap({
  name: 'admin_ad_review_queue', method: 'GET', path: '/admin/advertising/queue', tag: TAG,
  summary: 'Campaigns waiting for a decision, oldest first, with who is asking and what they promote. Platform admin only.',
  input: z.object({ status: z.enum(['submitted', 'approved', 'active', 'scheduled', 'paused']).default('submitted'), ...page }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const rows = await many(`SELECT ${CAMP} FROM ad_campaigns WHERE status=$1 ORDER BY submitted_at NULLS LAST, created_at LIMIT $2 OFFSET $3`, [i.status, i.limit, i.offset]);
    return { campaigns: await Promise.all(rows.map(view)), waiting: Number((await one("SELECT count(*) AS n FROM ad_campaigns WHERE status='submitted'")).n) };
  },
});

cap({
  name: 'admin_get_ad_campaign', method: 'GET', path: '/admin/advertising/campaigns/:id', tag: TAG,
  summary: 'A campaign as the reviewer sees it: its settings and destination, the ad as it will appear (including the disclosure label), the claims the advertiser declared, earlier decisions, the timeline, and open reports against it. Platform admin only.',
  input: z.object({ id }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const camp = (await one(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [i.id]));
    if (!camp) throw notFound('Campaign');
    const advertiser = await one('SELECT * FROM ad_advertisers WHERE id=$1', [camp.advertiser_id]);
    return {
      campaign: await view(camp), placements: (await many('SELECT placement_code FROM ad_campaign_placements WHERE campaign_id=$1 AND removed_at IS NULL ORDER BY 1', [camp.id])).map((r) => ({ code: r.placement_code, label: PLACEMENTS[r.placement_code]?.label })),
      creatives: (await many('SELECT id, version, headline, body, cta, media_id, alt_text, claims, status, created_at FROM ad_creatives WHERE campaign_id=$1 ORDER BY version DESC', [camp.id])).map((x) => ({ ...x, cta_label: CTAS[x.cta], claim_labels: x.claims.map((k) => CLAIM_TYPES[k] ?? k) })),
      reviews: await many('SELECT r.decision, r.reason_category, r.reason, r.claims_checked, r.youth_contextual, r.created_at, u.display_name AS reviewer FROM ad_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.campaign_id=$1 ORDER BY r.created_at DESC', [camp.id]),
      timeline: await many('SELECT action, detail, created_at FROM ad_campaign_log WHERE campaign_id=$1 ORDER BY id DESC LIMIT 60', [camp.id]),
      open_reports: Number((await one("SELECT count(*) AS n FROM ad_reports WHERE campaign_id=$1 AND status='open'", [camp.id])).n),
      advertiser: { id: advertiser.id, status: advertiser.status, kind: advertiser.organisation_id ? 'organisation' : 'person', suspended_reason: advertiser.suspended_reason },
      money: await moneyFor(camp.id),
    };
  },
});

cap({
  name: 'admin_review_ad', method: 'POST', path: '/admin/advertising/campaigns/:id/review', tag: TAG,
  summary: 'Approve or reject a submitted campaign with a recorded reason, its category and the claims you checked. A prohibited category can never be approved. Approving may mark the campaign as safe for approved contextual delivery to young people — which still only takes effect while the platform policy allows it. Takes effect on the next request. Platform admin only.',
  input: z.object({
    id, decision: z.enum(['approved', 'rejected']), reason_category: z.enum(REVIEW_REASONS).optional(), reason: z.string().trim().max(1000).optional(),
    claims_checked: z.array(z.enum(Object.keys(CLAIM_TYPES))).max(6).default([]), youth_contextual: z.boolean().default(false),
  }).refine((x) => x.decision === 'approved' || (x.reason_category && x.reason && x.reason.length >= 5), { message: 'Rejecting needs a reason category and a reason' }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const { user } = ctx;
    return tx(async (c) => {
      const camp = await loadForReview(c, i.id);
      if (camp.status !== 'submitted') throw conflict(`A ${camp.status} campaign is not waiting for review`);
      const advertiser = (await c.query('SELECT * FROM ad_advertisers WHERE id=$1', [camp.advertiser_id])).rows[0];
      const cr = (await c.query('SELECT * FROM ad_creatives WHERE id=$1', [camp.current_creative_id])).rows[0];
      if (!cr || cr.status !== 'submitted') throw conflict('The ad changed since it was submitted; it has to be submitted again');
      if (i.decision === 'approved') {
        if (!isCategoryAllowed(camp.category)) throw conflict('A prohibited category cannot be approved');
        const declared = cr.claims.filter((k) => k !== 'none');
        const unchecked = declared.filter((k) => !i.claims_checked.includes(k));
        if (unchecked.length) throw badRequest(`Check the claims the ad makes before approving: ${unchecked.map((k) => CLAIM_TYPES[k]).join(', ')}`, { unchecked });
        if (advertiser.status !== 'active') throw conflict('The advertiser account is suspended');
        const problems = (await readiness(user, camp, advertiser, c)).filter((p) => !/start date has passed/.test(p));
        if (problems.length) throw conflict('The campaign no longer meets the requirements', { problems });
      }
      await c.query('UPDATE ad_creatives SET status=$2 WHERE id=$1', [cr.id, i.decision]);
      await c.query("UPDATE ad_campaigns SET status=$2, decided_at=now(), youth_contextual=$3, updated_at=now() WHERE id=$1", [camp.id, i.decision, i.decision === 'approved' && i.youth_contextual]);
      await c.query('INSERT INTO ad_reviews(campaign_id, creative_id, decision, reason_category, reason, claims_checked, youth_contextual, reviewer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [camp.id, cr.id, i.decision, i.reason_category ?? null, i.reason ?? null, i.claims_checked, i.decision === 'approved' && i.youth_contextual, user.id]);
      await logCampaign(c, camp.id, user.id, i.decision, i.reason_category ? { reason_category: i.reason_category } : {});
      await tell(c, camp, i.decision === 'approved' ? 'Your ad was approved' : 'Your ad was not approved', i.decision === 'approved' ? `${camp.name} is approved. Add funds and start it.` : `${camp.name}: ${i.reason}`);
      return view((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
    });
  },
});

cap({
  name: 'admin_stop_ad', method: 'POST', path: '/admin/advertising/campaigns/:id/stop', tag: TAG,
  summary: 'Pause or withdraw a campaign for a policy reason (or release a pause the platform set). The ad stops on the very next request and the advertiser cannot resume a platform pause. A withdrawal is final and credits a flat fee if nothing was shown. Platform admin only.',
  input: z.object({ id, action: z.enum(['pause', 'withdraw', 'release']), reason_category: z.enum(REVIEW_REASONS).optional(), reason: z.string().trim().min(5).max(1000) }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const { user } = ctx;
    return tx(async (c) => {
      const camp = await loadForReview(c, i.id);
      const to = i.action === 'pause' ? 'paused' : i.action === 'withdraw' ? 'withdrawn' : camp.activated_at ? (camp.starts_on > new Date().toISOString().slice(0, 10) ? 'scheduled' : 'active') : 'approved';
      if (i.action === 'release' && !(camp.status === 'paused' && camp.held_by_platform)) throw conflict('That campaign is not on a platform pause');
      if (i.action === 'pause' && !['scheduled', 'active'].includes(camp.status)) throw conflict(`A ${camp.status} campaign is not running`);
      if (i.action === 'withdraw' && ['ended', 'withdrawn'].includes(camp.status)) throw conflict('That campaign is already over');
      if (to === 'withdrawn') await creditUnusedFlat(c, camp);
      await c.query(
        `UPDATE ad_campaigns SET status=$2, held_by_platform = ($3 = 'pause'), updated_at=now(), ended_at = CASE WHEN $2='withdrawn' THEN now() ELSE ended_at END, end_reason = CASE WHEN $2='withdrawn' THEN 'withdrawn_by_platform' ELSE end_reason END WHERE id=$1`, [camp.id, to, i.action]);
      if (to === 'withdrawn' && camp.current_creative_id) await c.query("UPDATE ad_creatives SET status='withdrawn' WHERE id=$1", [camp.current_creative_id]);
      await c.query('INSERT INTO ad_reviews(campaign_id, creative_id, decision, reason_category, reason, reviewer_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [camp.id, camp.current_creative_id, i.action === 'pause' ? 'paused' : i.action === 'withdraw' ? 'withdrawn' : 'resumed', i.reason_category ?? null, i.reason, user.id]);
      await logCampaign(c, camp.id, user.id, `platform_${i.action}`, { reason_category: i.reason_category ?? null });
      await tell(c, camp, i.action === 'release' ? 'Your ad can run again' : `Your ad was ${i.action === 'pause' ? 'paused' : 'withdrawn'}`, `${camp.name}: ${i.reason}`);
      return view((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
    });
  },
});

// ================================================================================================== reports from the public
cap({
  name: 'admin_list_ad_reports', method: 'GET', path: '/admin/advertising/reports', tag: TAG,
  summary: 'Reports people made about ads they were shown, newest first. The reporter\'s note is decrypted here only, and each read is audit-logged. Platform admin only.',
  input: z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open'), ...page }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const rows = await many(
      `SELECT r.id, r.campaign_id, r.reason, r.note_enc, r.status, r.outcome, r.created_at, c.name AS campaign, c.status AS campaign_status, cr.headline
         FROM ad_reports r JOIN ad_campaigns c ON c.id=r.campaign_id JOIN ad_creatives cr ON cr.id=r.creative_id WHERE r.status=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [i.status, i.limit, i.offset]);
    if (rows.some((r) => r.note_enc)) await audit(null, ctx.user.id, 'read_ad_report_notes', 'ad_reports', null);
    return rows.map(({ note_enc, ...r }) => ({ ...r, note: note_enc ? decrypt(note_enc, 'ad_reports.note') : null }));
  },
});

cap({
  name: 'admin_handle_ad_report', method: 'POST', path: '/admin/advertising/reports/:id/handle', tag: TAG,
  summary: 'Close a report: dismiss it, or action it by pausing or withdrawing the campaign (a pause is held by the platform). Platform admin only.',
  input: z.object({ id, outcome: z.enum(['none', 'paused', 'withdrawn']), reason: z.string().trim().min(5).max(1000).optional() }).refine((x) => x.outcome === 'none' || !!x.reason, { message: 'Say why' }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const { user } = ctx;
    return tx(async (c) => {
      const r = (await c.query("SELECT * FROM ad_reports WHERE id=$1 AND status='open' FOR UPDATE", [i.id])).rows[0];
      if (!r) throw notFound('Report');
      if (i.outcome !== 'none') {
        const camp = await loadForReview(c, r.campaign_id);
        if (i.outcome === 'paused' && ['scheduled', 'active'].includes(camp.status)) {
          await c.query("UPDATE ad_campaigns SET status='paused', held_by_platform=true, updated_at=now() WHERE id=$1", [camp.id]);
          await c.query("INSERT INTO ad_reviews(campaign_id, creative_id, decision, reason_category, reason, reviewer_id) VALUES ($1,$2,'paused','other',$3,$4)", [camp.id, camp.current_creative_id, i.reason, user.id]);
          await logCampaign(c, camp.id, user.id, 'platform_pause', { from_report: r.id });
        } else if (i.outcome === 'withdrawn' && !['ended', 'withdrawn'].includes(camp.status)) {
          await creditUnusedFlat(c, camp);
          await c.query("UPDATE ad_campaigns SET status='withdrawn', ended_at=now(), end_reason='withdrawn_by_platform', updated_at=now() WHERE id=$1", [camp.id]);
          if (camp.current_creative_id) await c.query("UPDATE ad_creatives SET status='withdrawn' WHERE id=$1", [camp.current_creative_id]);
          await c.query("INSERT INTO ad_reviews(campaign_id, creative_id, decision, reason_category, reason, reviewer_id) VALUES ($1,$2,'withdrawn','other',$3,$4)", [camp.id, camp.current_creative_id, i.reason, user.id]);
          await logCampaign(c, camp.id, user.id, 'platform_withdraw', { from_report: r.id });
        }
      }
      await c.query("UPDATE ad_reports SET status=$2, outcome=$3, handled_by=$4, handled_at=now() WHERE id=$1", [r.id, i.outcome === 'none' ? 'dismissed' : 'actioned', i.outcome, user.id]);
      return { id: r.id, status: i.outcome === 'none' ? 'dismissed' : 'actioned', outcome: i.outcome };
    });
  },
});

// ================================================================================================== advertisers, policy, inventory
cap({
  name: 'admin_set_advertiser_status', method: 'POST', path: '/admin/advertising/advertisers/:id/status', tag: TAG,
  summary: 'Suspend an advertiser account (every one of its campaigns stops serving at once) or reinstate it. A reason is recorded. Nothing is deleted. Platform admin only.',
  input: z.object({ id, status: z.enum(['active', 'suspended']), reason: z.string().trim().min(5).max(500).optional() }).refine((x) => x.status === 'active' || !!x.reason, { message: 'Say why' }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const a = await one("UPDATE ad_advertisers SET status=$2, suspended_reason=CASE WHEN $2='suspended' THEN $3 ELSE NULL END, suspended_by=CASE WHEN $2='suspended' THEN $4::uuid ELSE NULL END, suspended_at=CASE WHEN $2='suspended' THEN now() ELSE NULL END WHERE id=$1 RETURNING id, status", [i.id, i.status, i.reason ?? null, ctx.user.id]);
    if (!a) throw notFound('Advertiser');
    await audit(null, ctx.user.id, `ad_advertiser_${i.status}`, 'ad_advertisers', a.id);
    return a;
  },
});

cap({
  name: 'admin_get_ad_policy', method: 'GET', path: '/admin/advertising/policy', tag: TAG,
  summary: 'The platform\'s advertising switches: the youth rule, frequency limits, and which placements are on sale with how many slots each. Platform admin only.',
  async handler(ctx) {
    await adminOnly(ctx);
    return { policy: await getPolicy(), inventory: (await inventoryOf()).map((p) => ({ code: p.code, label: p.label, enabled: p.enabled, max_slots: p.max_slots })) };
  },
});

cap({
  name: 'admin_set_ad_policy', method: 'PATCH', path: '/admin/advertising/policy', tag: TAG,
  summary: 'Change the youth rule (whether approved, contextual-only campaigns may reach young people and youth pages; off by default), the default and maximum daily frequency, and which placements are on sale and how many slots each shows. Each change is logged. Platform admin only.',
  input: z.object({
    youth_contextual: z.boolean().optional(), default_frequency: z.number().int().min(1).max(50).optional(), max_frequency: z.number().int().min(1).max(100).optional(),
    inventory: z.array(z.object({ code: z.enum(PLACEMENT_CODES), enabled: z.boolean(), max_slots: z.number().int().min(1).max(3).default(1) })).max(PLACEMENT_CODES.length).optional(),
  }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM ad_policy WHERE id FOR UPDATE')).rows[0];
      const next = { youth_contextual: i.youth_contextual ?? cur.youth_contextual, default_frequency: i.default_frequency ?? cur.default_frequency, max_frequency: i.max_frequency ?? cur.max_frequency };
      if (next.default_frequency > next.max_frequency) throw badRequest('The default frequency cannot exceed the maximum');
      await c.query('UPDATE ad_policy SET youth_contextual=$1, default_frequency=$2, max_frequency=$3, version=version+1, updated_by=$4, updated_at=now() WHERE id', [next.youth_contextual, next.default_frequency, next.max_frequency, ctx.user.id]);
      for (const p of i.inventory ?? []) {
        await c.query('INSERT INTO ad_inventory(placement_code, enabled, max_slots, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (placement_code) DO UPDATE SET enabled=$2, max_slots=$3, updated_by=$4, updated_at=now()', [p.code, p.enabled, p.max_slots, ctx.user.id]);
      }
      await audit(c, ctx.user.id, 'set_ad_policy', 'ad_policy', null);
      return { policy: (await c.query('SELECT * FROM ad_policy WHERE id')).rows[0], inventory: (await inventoryOf(c)).map((p) => ({ code: p.code, enabled: p.enabled, max_slots: p.max_slots })) };
    });
  },
});

// ================================================================================================== platform report
cap({
  name: 'admin_ad_overview', method: 'GET', path: '/admin/advertising/overview', tag: TAG,
  summary: 'The platform\'s view of advertising: campaigns by status, what is waiting on review and on reports, delivery and spend across everything — added up from the same delivery records each advertiser\'s own report uses — and the reconciliation of every campaign\'s running spend against those records. Platform admin only.',
  input: z.object({ from: z.string().date().optional(), to: z.string().date().optional() }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const byStatus = await many('SELECT status, count(*)::int AS n FROM ad_campaigns GROUP BY status ORDER BY status');
    const report = await reportFor({ from: i.from ?? null, to: i.to ?? null });
    const drift = await many(
      `SELECT c.id, c.name, c.spent_micro,
              coalesce((SELECT sum(cost_micro) FROM ad_delivery_events d WHERE d.campaign_id=c.id),0)::bigint + coalesce((SELECT sum(-amount_minor) FROM ad_ledger l WHERE l.campaign_id=c.id AND l.kind IN ('flat_charge','flat_credit')),0)::bigint * ${MICRO} AS facts_micro
         FROM ad_campaigns c`);
    const mismatched = drift.filter((d) => Number(d.spent_micro) !== Number(d.facts_micro)).map((d) => ({ campaign_id: d.id, name: d.name, counter_micro: Number(d.spent_micro), facts_micro: Number(d.facts_micro) }));
    const totals = await one(
      `SELECT c.currency, coalesce(sum(c.funded_minor),0)::bigint AS funded_minor, coalesce(sum(c.refunded_minor),0)::bigint AS refunded_minor, coalesce(sum(c.spent_micro),0)::bigint AS spent_micro FROM ad_campaigns c GROUP BY c.currency ORDER BY 1 LIMIT 1`);
    return {
      campaigns_by_status: byStatus, waiting_review: Number((await one("SELECT count(*) AS n FROM ad_campaigns WHERE status='submitted'")).n), open_reports: Number((await one("SELECT count(*) AS n FROM ad_reports WHERE status='open'")).n),
      delivery: report, funds_by_currency: await many('SELECT currency, sum(funded_minor)::bigint AS funded_minor, sum(refunded_minor)::bigint AS refunded_minor, ceil(sum(spent_micro)::numeric / 1000000)::bigint AS spent_minor FROM ad_campaigns GROUP BY currency ORDER BY currency'),
      reconciliation: { campaigns_checked: drift.length, mismatched }, first_currency: totals?.currency ?? null,
    };
  },
});
