// Sports Services & Opportunity Marketplace (#600): the engagement lifecycle shared by every provider family.
// request -> quote -> negotiate -> contract -> schedule -> deliver -> invoice -> pay -> review.
// Money is paid through the canonical payments + provider ledger (create_payment, purpose_type marketplace_engagement), reviews through
// write_testimonial (#215), credentials through verification cases. Both parties only; everyone else gets 404.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { CURRENCIES, toMajor } from '../currency.js';
import { saveEncrypted } from '../doc-store.js';
import { renderServiceDocument } from '../documents/service-render.js';
import { FAMILY, FAMILY_SLUGS, STAGES } from '../marketplace/families.js';
import { badTimes, ctx, describe, loadEngagement, logEvent, mustBeAdult, mustHoldCredential, need, other, seal, snapshotTerms } from '../marketplace/engine.js';

const TAG = 'Marketplace';
const money = z.number().int().min(0).max(100_000_000_000);
const tell = (c, userId, e, title, body) => notify(c, userId, { kind: 'marketplace_engagement', title, body: body ?? e.title, data: { marketplace_engagement_id: e.id } });
const MAX_MESSAGES = 300;

cap({
  name: 'request_marketplace_engagement', method: 'POST', path: '/marketplace/engagements', tag: TAG, status: 201,
  summary: 'Start an engagement with a provider: from one of their listings (`listing_id`), or from an accepted response to your #67 opportunity post (`opportunity_response_id` + `family`). Say what you need; the provider then quotes. One open request per listing. You cannot engage yourself and children cannot use the marketplace.',
  input: z.object({
    listing_id: id.optional(), opportunity_response_id: id.optional(), family: z.enum(FAMILY_SLUGS).optional(), title: z.string().min(3).max(140), brief: z.string().max(2000).optional(),
    sport: z.string().max(60).optional().describe('sport slug'), budget_minor: money.optional(), currency: z.string().refine((c) => c in CURRENCIES, 'Unknown currency').optional(), buyer_organisation_id: id.optional(),
  }),
  async handler({ user }, i) {
    if (!!i.listing_id === !!i.opportunity_response_id) throw badRequest('Give either a listing or an opportunity response');
    await mustBeAdult(user);
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0];
      let listing = null, provider, family, origin = ['listing', i.listing_id ?? null], currency = i.currency;
      if (i.listing_id) {
        listing = await q("SELECT * FROM marketplace_listings WHERE id=$1 AND archived_at IS NULL AND status='active' AND accepting", [i.listing_id]);
        if (!listing) throw notFound('Listing');
        provider = listing.provider_id; family = listing.family; currency ??= listing.currency;
      } else {
        if (!i.family) throw badRequest('Say which provider family this is');
        const r = await q("SELECT r.id, r.responder_id, r.status, p.author_id, p.kind FROM billboard_responses r JOIN billboard_posts p ON p.id=r.post_id WHERE r.id=$1", [i.opportunity_response_id]);
        if (!r || r.author_id !== user.id) throw notFound('Opportunity response');
        if (r.status !== 'accepted') throw conflict('Accept the response on your opportunity first');
        provider = r.responder_id; family = i.family; origin = ['opportunity_response', r.id];
      }
      if (provider === user.id) throw badRequest('You cannot engage yourself');
      if ((await q('SELECT 1 AS y FROM users u WHERE u.id=$1 AND u.youth_until IS NOT NULL AND u.youth_until > current_date', [provider]))) throw forbidden('This provider cannot be engaged');
      let sport = null;
      if (i.sport) { sport = await q('SELECT id FROM sports WHERE slug=$1', [i.sport]); if (!sport) throw badRequest('Unknown sport'); }
      if (i.buyer_organisation_id && !(await q("SELECT 1 AS y FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [i.buyer_organisation_id, user.id]))) throw notFound('Organisation');
      let e;
      try {
        e = await q(`INSERT INTO marketplace_engagements(listing_id, family, buyer_id, buyer_org_id, provider_id, provider_org_id, title, sport_id, brief_enc, budget_minor, currency, origin_type, origin_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [listing?.id ?? null, family, user.id, i.buyer_organisation_id ?? null, provider, listing?.organisation_id ?? null, i.title, sport?.id ?? null, seal(i.brief, 'brief'), i.budget_minor ?? null, currency ?? 'INR', origin[0], origin[1]]);
      } catch (err) { if (err.code === '23505') throw conflict('You already have an open request with this provider'); throw err; }
      await logEvent(c, e.id, user.id, 'requested', { family });
      await tell(c, provider, e, `${user.display_name} asked for a quote`, i.title);
      return describe(user, e, 'buyer', c);
    });
  },
});

cap({
  name: 'list_my_marketplace_engagements', method: 'GET', path: '/me/marketplace/engagements', tag: TAG,
  summary: 'Your engagements, as buyer and as provider (including organisations you run), newest first. Filter by role, status or family.',
  input: z.object({ role: z.enum(['buyer', 'provider']).optional(), status: z.enum([...STAGES, 'declined', 'cancelled']).optional(), family: z.enum(FAMILY_SLUGS).optional(), ...page }),
  async handler({ user }, i) {
    return many(
      `SELECT x.id, x.number, x.family, x.title, x.status, x.currency, x.agreed_minor, x.budget_minor, x.starts_at, x.ends_at, x.updated_at, x.created_at,
              bu.display_name AS buyer_name, pu.display_name AS provider_name,
              CASE WHEN x.buyer_id=$1 OR x.buyer_org_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin')) THEN 'buyer' ELSE 'provider' END AS my_side
         FROM marketplace_engagements x JOIN users bu ON bu.id=x.buyer_id JOIN users pu ON pu.id=x.provider_id
        WHERE (x.buyer_id=$1 OR x.provider_id=$1
               OR x.buyer_org_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin'))
               OR x.provider_org_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin')))
          AND ($2::text IS NULL OR (CASE WHEN x.buyer_id=$1 THEN 'buyer' ELSE 'provider' END)=$2) AND ($3::text IS NULL OR x.status=$3) AND ($4::text IS NULL OR x.family=$4)
        ORDER BY x.updated_at DESC LIMIT $5 OFFSET $6`, [user.id, i.role ?? null, i.status ?? null, i.family ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_marketplace_engagement', method: 'GET', path: '/marketplace/engagements/:id', tag: TAG,
  summary: 'One engagement for a party: status and the steps you can take now (`next`), the quote history, the timeline, the contract snapshot and hash, the provider\'s credential state and the invoice once raised. Reading the free text is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { e, side } = await loadEngagement(user, i.id);
    const d = await describe(user, e, side);
    const quotes = (await many('SELECT * FROM marketplace_quotes WHERE engagement_id=$1 ORDER BY version', [e.id])).map(({ terms_enc, ...q }) => ({ ...q, terms: decrypt(terms_enc, ctx.terms) }));
    if (quotes.some((q) => q.terms)) await audit(null, user.id, 'marketplace.read_text', 'marketplace_engagement', e.id);
    const events = await many('SELECT ev.id, ev.kind, ev.detail, ev.created_at, u.display_name AS actor FROM marketplace_events ev LEFT JOIN users u ON u.id=ev.actor_id WHERE ev.engagement_id=$1 ORDER BY ev.created_at, ev.id', [e.id]);
    const invoice = e.invoice_number ? { number: e.invoice_number, issued_at: e.invoiced_at, amount_minor: Number(e.agreed_minor), currency: e.currency, status: e.paid_at ? 'paid' : 'open', paid_at: e.paid_at } : null;
    return { ...d, quotes, events, invoice, reviewable: side === 'buyer' && ['paid', 'reviewed'].includes(e.status), review_subject: { subject_type: 'user', subject_id: e.provider_id } };
  },
});

cap({
  name: 'offer_marketplace_quote', method: 'POST', path: '/marketplace/engagements/:id/quotes', tag: TAG, status: 201,
  summary: 'Make or counter a quote. The provider quotes first; after that the two sides take turns, each offer a new version and none is overwritten, so the negotiation history is kept. An offer is binding on the person making it until `valid_until`.',
  input: z.object({ id, amount_minor: money, valid_until: z.string().date().optional(), terms: z.string().max(4000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, side } = await loadEngagement(user, i.id, c, { lock: true });
      need(e, ['requested', 'quoted', 'negotiating'], 'make an offer');
      const last = (await c.query('SELECT * FROM marketplace_quotes WHERE engagement_id=$1 ORDER BY version DESC LIMIT 1', [e.id])).rows[0];
      if (!last && side !== 'provider') throw conflict('The provider quotes first');
      if (last && last.side === side) throw conflict('Wait for the other side to respond to your offer');
      if (i.valid_until && i.valid_until < new Date().toISOString().slice(0, 10)) throw badRequest('The offer cannot already have expired');
      if (last) await c.query("UPDATE marketplace_quotes SET status='superseded', responded_at=now() WHERE id=$1 AND status='offered'", [last.id]);
      const q = (await c.query(`INSERT INTO marketplace_quotes(engagement_id, version, by_id, side, amount_minor, currency, valid_until, terms_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, version, side, amount_minor, currency, valid_until, status, created_at`,
        [e.id, (last?.version ?? 0) + 1, user.id, side, i.amount_minor, e.currency, i.valid_until ?? null, seal(i.terms, 'terms')])).rows[0];
      const status = last ? 'negotiating' : 'quoted';
      await c.query('UPDATE marketplace_engagements SET status=$2, updated_at=now() WHERE id=$1', [e.id, status]);
      await logEvent(c, e.id, user.id, last ? 'counter' : 'quote', { version: q.version, side, amount_minor: i.amount_minor });
      await tell(c, other(e, side), e, side === 'provider' ? `${user.display_name} sent a quote` : `${user.display_name} sent a counter-offer`, e.title);
      return q;
    });
  },
});

cap({
  name: 'accept_marketplace_quote', method: 'POST', path: '/marketplace/engagements/:id/accept', tag: TAG,
  summary: 'Accept the latest offer made by the other side. That is the contract: the terms are frozen into a snapshot with a SHA-256 hash and a contract number. The provider must hold a current verified credential for regulated families, or this is refused.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, side } = await loadEngagement(user, i.id, c, { lock: true });
      need(e, ['quoted', 'negotiating'], 'accept an offer');
      const q = (await c.query("SELECT *, (valid_until IS NOT NULL AND valid_until < current_date) AS stale FROM marketplace_quotes WHERE engagement_id=$1 AND status='offered' ORDER BY version DESC LIMIT 1 FOR UPDATE", [e.id])).rows[0];
      if (!q) throw conflict('There is no open offer to accept');
      if (q.side === side) throw conflict('You cannot accept your own offer');
      if (q.stale) {
        await c.query("UPDATE marketplace_quotes SET status='expired', responded_at=now() WHERE id=$1", [q.id]);
        throw conflict('That offer has expired; ask for a new one');
      }
      await mustHoldCredential(e.provider_id, e.family, c);
      const { terms, sha } = snapshotTerms(e, q, decrypt(q.terms_enc, ctx.terms));
      await c.query("UPDATE marketplace_quotes SET status='accepted', responded_at=now() WHERE id=$1", [q.id]);
      const upd = (await c.query(`UPDATE marketplace_engagements SET status='contracted', agreed_minor=$2, currency=$3, accepted_quote_id=$4, contract_number='MC-'||number, terms_json=$5, terms_sha256=$6, contracted_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
        [e.id, q.amount_minor, q.currency, q.id, terms, sha])).rows[0];
      await logEvent(c, e.id, user.id, 'contracted', { version: q.version, amount_minor: Number(q.amount_minor), terms_sha256: sha });
      await tell(c, other(e, side), e, `${user.display_name} accepted — contract ${upd.contract_number}`, e.title);
      return describe(user, upd, side, c);
    });
  },
});

const close = (kind, status, sides, summary, path) => cap({
  name: `${kind}_marketplace_engagement`, method: 'POST', path: `/marketplace/engagements/:id/${path}`, tag: TAG, summary,
  input: z.object({ id, reason: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, side } = await loadEngagement(user, i.id, c, { lock: true });
      if (!sides.includes(side)) throw forbidden(`Only the ${sides.join(' / ')} can ${kind} an engagement`);
      need(e, kind === 'decline' ? ['requested', 'quoted', 'negotiating'] : ['requested', 'quoted', 'negotiating', 'contracted', 'scheduled'], kind);
      await c.query("UPDATE marketplace_quotes SET status=CASE WHEN status='offered' THEN 'declined' ELSE status END, responded_at=coalesce(responded_at, now()) WHERE engagement_id=$1 AND status='offered'", [e.id]);
      const upd = (await c.query('UPDATE marketplace_engagements SET status=$2, closed_reason=$3, closed_by=$4, updated_at=now() WHERE id=$1 RETURNING *', [e.id, status, i.reason, user.id])).rows[0];
      await logEvent(c, e.id, user.id, status, { by: side, reason: i.reason });
      await tell(c, other(e, side), e, `${user.display_name} ${status} the engagement`, i.reason);
      return describe(user, upd, side, c);
    });
  },
});
close('decline', 'declined', ['provider'], 'Provider declines a request or an offer round with a reason. The engagement closes and stays on both timelines.', 'decline');
close('cancel', 'cancelled', ['buyer', 'provider'], 'Either party cancels before work is delivered, with a reason. After the work is invoiced or paid use the payment refund and dispute routes instead.', 'cancel');

cap({
  name: 'schedule_marketplace_engagement', method: 'POST', path: '/marketplace/engagements/:id/schedule', tag: TAG,
  summary: 'Put the contracted work in the calendar (or move it). Refused if the provider already has contracted work or a personal block in that window. It then shows in both parties\' schedules.',
  input: z.object({ id, starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }).optional(), timezone: z.string().max(60).default('UTC') }),
  async handler({ user }, i) {
    badTimes(i.starts_at, i.ends_at);
    return tx(async (c) => {
      const { e, side } = await loadEngagement(user, i.id, c, { lock: true });
      need(e, ['contracted', 'scheduled'], 'schedule');
      const end = i.ends_at ?? new Date(+new Date(i.starts_at) + 3600e3).toISOString();
      const clash = (await c.query(`SELECT 1 FROM marketplace_engagements x WHERE x.provider_id=$1 AND x.id<>$2 AND x.status IN ('contracted','scheduled') AND x.starts_at IS NOT NULL AND x.starts_at < $4 AND coalesce(x.ends_at, x.starts_at + interval '1 hour') > $3
        UNION ALL SELECT 1 FROM athlete_blocks b WHERE b.user_id=$1 AND b.status='active' AND b.starts_at < $4 AND b.ends_at > $3 LIMIT 1`, [e.provider_id, e.id, i.starts_at, end])).rowCount > 0;
      if (clash) throw conflict('The provider is not available in that window');
      const upd = (await c.query("UPDATE marketplace_engagements SET status='scheduled', starts_at=$2, ends_at=$3, timezone=$4, updated_at=now() WHERE id=$1 RETURNING *", [e.id, i.starts_at, end, i.timezone])).rows[0];
      await logEvent(c, e.id, user.id, 'scheduled', { starts_at: i.starts_at, ends_at: end });
      await tell(c, other(e, side), e, `${user.display_name} scheduled the work`, e.title);
      return describe(user, upd, side, c);
    });
  },
});

cap({
  name: 'deliver_marketplace_engagement', method: 'POST', path: '/marketplace/engagements/:id/deliver', tag: TAG,
  summary: 'Provider marks the scheduled work delivered, with an optional note. The buyer then accepts the delivery, which raises the invoice.',
  input: z.object({ id, note: z.string().max(2000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, side } = await loadEngagement(user, i.id, c, { lock: true });
      if (side !== 'provider') throw forbidden('Only the provider delivers the work');
      need(e, ['scheduled'], 'deliver');
      const upd = (await c.query("UPDATE marketplace_engagements SET status='delivered', delivered_at=now(), delivery_note_enc=$2, updated_at=now() WHERE id=$1 RETURNING *", [e.id, seal(i.note, 'delivery')])).rows[0];
      await logEvent(c, e.id, user.id, 'delivered');
      await tell(c, e.buyer_id, e, `${user.display_name} delivered the work — please review and accept`, e.title);
      return describe(user, upd, side, c);
    });
  },
});

cap({
  name: 'accept_marketplace_delivery', method: 'POST', path: '/marketplace/engagements/:id/accept-delivery', tag: TAG,
  summary: 'Buyer accepts the delivered work. The provider\'s invoice (number MI-…) is raised for the agreed amount and the engagement becomes payable through create_payment (purpose_type marketplace_engagement), where platform commission and payouts are handled by the provider ledger. A zero-value agreement closes as paid.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, side } = await loadEngagement(user, i.id, c, { lock: true });
      if (side !== 'buyer') throw forbidden('Only the buyer accepts delivery');
      need(e, ['delivered'], 'accept delivery');
      const free = Number(e.agreed_minor) === 0;
      const upd = (await c.query(`UPDATE marketplace_engagements SET status=$2, delivery_accepted_at=now(), invoice_number='MI-'||number, invoiced_at=now(), paid_at=CASE WHEN $2='paid' THEN now() END, updated_at=now() WHERE id=$1 RETURNING *`, [e.id, free ? 'paid' : 'invoiced'])).rows[0];
      await logEvent(c, e.id, user.id, 'invoiced', { invoice: upd.invoice_number, amount_minor: Number(e.agreed_minor) });
      await tell(c, e.provider_id, e, `${user.display_name} accepted delivery — invoice ${upd.invoice_number}`, e.title);
      return describe(user, upd, side, c);
    });
  },
});

cap({
  name: 'send_marketplace_message', method: 'POST', path: '/marketplace/engagements/:id/messages', tag: TAG, status: 201,
  summary: 'Message the other party inside the engagement. The thread is kept with the engagement (negotiation history), encrypted at rest, and closed engagements are read-only.',
  input: z.object({ id, body: z.string().min(1).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { e, side } = await loadEngagement(user, i.id, c, { lock: true });
      if (['declined', 'cancelled'].includes(e.status)) throw conflict('This engagement is closed');
      if (Number((await c.query('SELECT count(*) AS n FROM marketplace_messages WHERE engagement_id=$1', [e.id])).rows[0].n) >= MAX_MESSAGES) throw conflict('This thread has reached its message limit');
      const m = (await c.query('INSERT INTO marketplace_messages(engagement_id, sender_id, body_enc) VALUES ($1,$2,$3) RETURNING id, created_at', [e.id, user.id, seal(i.body, 'message')])).rows[0];
      await logEvent(c, e.id, user.id, 'message');
      await tell(c, other(e, side), e, `${user.display_name} sent a message`, e.title);
      return { ...m, sender_id: user.id, body: i.body };
    });
  },
});

cap({
  name: 'list_marketplace_messages', method: 'GET', path: '/marketplace/engagements/:id/messages', tag: TAG,
  summary: 'The message thread of an engagement, oldest first. Parties only; the read is audit-logged because the text is decrypted.',
  input: z.object({ id, limit: z.coerce.number().int().min(1).max(300).default(100) }),
  async handler({ user }, i) {
    const { e } = await loadEngagement(user, i.id);
    const rows = await many('SELECT m.id, m.sender_id, m.body_enc, m.created_at, u.display_name AS sender_name FROM marketplace_messages m JOIN users u ON u.id=m.sender_id WHERE m.engagement_id=$1 ORDER BY m.created_at, m.id LIMIT $2', [e.id, i.limit]);
    if (rows.length) await audit(null, user.id, 'marketplace.read_text', 'marketplace_engagement', e.id);
    return rows.map(({ body_enc, ...m }) => ({ ...m, body: decrypt(body_enc, ctx.message), mine: m.sender_id === user.id }));
  },
});


const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const amount = (minor, cur) => `${cur} ${toMajor(Number(minor), cur)}`;

/** The printable content, read from the engagement's own records (never typed in) and shown to its parties only. */
async function documentOf(user, engagementId, type) {
  const { e } = await loadEngagement(user, engagementId);
  const people = await many('SELECT u.id, u.display_name, o.name AS org FROM users u LEFT JOIN organisations o ON o.id = CASE WHEN u.id=$1 THEN $3::uuid ELSE $4::uuid END WHERE u.id = ANY($2)', [e.provider_id, [e.buyer_id, e.provider_id], e.provider_org_id, e.buyer_org_id]);
  const who = (id) => people.find((p) => p.id === id);
  const parties = [{ label: 'Provider', lines: [who(e.provider_id).display_name, who(e.provider_id).org] }, { label: 'Client', lines: [who(e.buyer_id).display_name, who(e.buyer_id).org] }];
  if (type === 'agreement') {
    if (!e.contract_number) throw conflict('There is no contract yet; accept an offer first');
    const q = (await many('SELECT * FROM marketplace_quotes WHERE id=$1', [e.accepted_quote_id]))[0];
    return { version: q?.version ?? null, doc: { title: 'Service agreement', number: e.contract_number, status: `agreed ${day(e.contracted_at)}`, parties, sections: [
      { heading: 'The engagement', kind: 'kv', rows: [['Service', e.title], ['Category', FAMILY[e.family]?.label ?? e.family], ['Agreed amount', amount(e.agreed_minor, e.currency)], ['Offer', q ? `version ${q.version}${q.valid_until ? `, valid until ${day(q.valid_until)}` : ''}` : ''], ['Scheduled', e.starts_at ? `${e.starts_at.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'to be scheduled']] },
      ...(q?.terms_enc ? [{ heading: 'Scope and conditions', kind: 'text', text: decrypt(q.terms_enc, ctx.terms) }] : []),
      { heading: 'Acceptance', kind: 'text', text: `Both parties accepted these terms in Gotmygame on ${day(e.contracted_at)}. Terms fingerprint (SHA-256): ${e.terms_sha256}.` }], footnote: 'General wording, not legal advice. The agreed terms above are the record of what both parties accepted.' } };
  }
  if (!e.invoice_number) throw conflict('There is no invoice yet; it is raised when the buyer accepts delivery');
  return { version: null, doc: { title: 'Invoice', number: e.invoice_number, status: e.paid_at ? `paid ${day(e.paid_at)}` : 'unpaid', issued_at: e.invoiced_at, parties: [{ label: 'From', lines: parties[0].lines }, { label: 'Bill to', lines: parties[1].lines }],
    sections: [{ heading: 'Services', kind: 'table', columns: [{ t: 'Description', w: 4 }, { t: 'Amount', w: 1, a: 'right' }], rows: [[`${e.title} (contract ${e.contract_number})`, amount(e.agreed_minor, e.currency)]] }], totals: [['Total', amount(e.agreed_minor, e.currency), true]],
    footnote: 'Paid through Gotmygame. Platform commission is settled with the provider separately and is not part of this invoice.' } };
}
export const marketplaceDocumentAccess = (user, engagementId) => loadEngagement(user, engagementId);

cap({
  name: 'generate_marketplace_document', method: 'POST', path: '/marketplace/engagements/:id/documents', tag: TAG, status: 201,
  summary: 'Render the engagement\'s agreement (once contracted) or invoice (once delivery is accepted) as a PDF through the shared document store. The content is read from the engagement itself; both parties can download it from `url`, and every download re-checks that they are still a party.',
  input: z.object({ id, type: z.enum(['agreement', 'invoice']) }),
  async handler({ user }, i) {
    const loaded = await documentOf(user, i.id, i.type);
    const { buffer, pages } = await renderServiceDocument({ doc: loaded.doc });
    const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
    const row = await one(`INSERT INTO generated_documents(id, family, source_type, source_id, source_version, file_name, size_bytes, sha256, pages, generated_by)
      VALUES ($1,'service_document','marketplace_engagement',$2,$3,$4,$5,$6,$7,$8) RETURNING id, family, source_type, source_id, size_bytes, sha256, pages, created_at`,
    [did, i.id, loaded.version, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id]);
    await audit(null, user.id, 'generate_document', 'generated_documents', did);
    return { ...row, type: i.type, url: `/api/v1/branded-documents/${did}/file` };
  },
});
