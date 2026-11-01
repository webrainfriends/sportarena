// Federation extras (#703) 1/3: the licence ID card / pass. It extends the licence register (federation-licences.js) and adds no second licence record:
// the card is built from the live licence row, its QR resolves through verify_licence, and revoked / expired / suspended licences fail the check at once.
// A young person's card is reached only by their verified guardian (scope `calendar` to see it, `register` to share it), and never carries their name outwards.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { newOpaqueToken, sha256 } from '../crypto.js';
import { guardianLink, guardianCan, isYouth } from '../youth.js';
import { config } from '../config.js';
import { licenceRow } from './federation-licences.js';
import { mintCardToken, verifyUrl, cardData, cardSvg, cardPng, cardPdf } from '../licence-card.js';

const TAG = 'Federation';
const fileOf = (name, type, buf) => ({ filename: name, content_type: type, encoding: 'base64', content: buf.toString('base64') });
const sharedUrl = (token) => `${(config.appUrl ?? config.apiPublicUrl).replace(/\/$/, '')}/?licence_card=${encodeURIComponent(token)}`;

/**
 * Who may open a licence's card: its holder, or their verified guardian (for a young person). Everyone else gets a 404, staff included (they use get_licence).
 * `scope` is the guardian scope an action needs; `outward` actions (share, file) are refused to a young person acting alone.
 */
async function cardFor(user, lid, { scope = 'calendar', outward = false } = {}) {
  const l = await licenceRow(lid);
  if (!l || !['active', 'suspended', 'expired', 'revoked'].includes(l.status)) throw notFound('Licence card');   // a card exists once a licence has been issued
  const own = l.holder_id === user.id;
  const link = own ? null : await guardianLink(user.id, l.holder_id);
  if (!own && !link) throw notFound('Licence card');
  const minor = await isYouth(l.holder_id);
  if (link && !(await guardianCan(link, scope))) throw new AppError(403, 'guardian_scope_required', `Your guardian authority for this young person does not cover this (${scope})`, { scope });
  if (outward && minor && own) throw forbidden('A young person\'s card is shared by their guardian');
  return { l, minor, by: own ? 'holder' : 'guardian' };
}

cap({
  name: 'get_licence_card', method: 'GET', path: '/federation/licences/:id/card', tag: TAG,
  summary: 'The licence as a wallet-style ID card (the holder, or the verified guardian of a young person with the `calendar` scope). Status, expiry and revocation are read live. Returns the card, a QR token that rotates every minute and resolves through verify_licence (re-fetch after `refresh_in_s`), and the share links. A young person\'s card is for their guardian\'s eyes only: the name is withheld from anything shared.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { l, minor, by } = await cardFor(user, i.id);
    await audit(null, user.id, 'view_licence_card', 'fed_licences', l.id);
    const asOf = new Date(), qr = mintCardToken(l.id, asOf);
    const shares = await many('SELECT id, expires_at, revoked_at, view_count, last_viewed_at, created_at FROM fed_licence_card_shares WHERE licence_id=$1 ORDER BY created_at DESC LIMIT 20', [l.id]);
    return { card: cardData(l, { minor: false }), minor, viewing_as: by, qr: { ...qr, url: verifyUrl(qr.token) }, shares: shares.map((s) => ({ ...s, active: !s.revoked_at && new Date(s.expires_at) > asOf })), as_of: asOf.toISOString() };
  },
});

cap({
  name: 'create_licence_card_share', method: 'POST', path: '/federation/licences/:id/card/shares', tag: TAG, status: 201,
  summary: 'Make a link to the card that others can open without signing in, for 1 to 30 days (default 7). It shows the licence\'s live standing, never a young person\'s name, and can be revoked at any time. Needs the `register` scope for a guardian. The token is returned once and only its hash is stored.',
  input: z.object({ id, days: z.number().int().min(1).max(30).default(7) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { l } = await cardFor(user, i.id, { scope: 'register', outward: true });
    const token = newOpaqueToken();
    const row = (await c.query('INSERT INTO fed_licence_card_shares(licence_id, token_sha256, created_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4)) RETURNING id, expires_at', [l.id, sha256(token), user.id, i.days])).rows[0];
    await audit(c, user.id, 'create_licence_card_share', 'fed_licences', l.id);
    return { share_id: row.id, token, url: sharedUrl(token), expires_at: row.expires_at };
  }),
});

cap({
  name: 'revoke_licence_card_share', method: 'DELETE', path: '/federation/licences/:id/card/shares/:share_id', tag: TAG,
  summary: 'Stop a shared card link working, at once. It is stamped revoked and kept as history.',
  input: z.object({ id, share_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { l } = await cardFor(user, i.id, { scope: 'register', outward: true });
    const r = (await c.query('UPDATE fed_licence_card_shares SET revoked_at=coalesce(revoked_at, now()) WHERE id=$1 AND licence_id=$2 RETURNING id, revoked_at', [i.share_id, l.id])).rows[0];
    if (!r) throw notFound('Share link');
    await audit(c, user.id, 'revoke_licence_card_share', 'fed_licences', l.id);
    return { share_id: r.id, revoked_at: r.revoked_at };
  }),
});

cap({
  name: 'view_shared_licence_card', method: 'GET', path: '/federation/cards/:token', tag: TAG, auth: 'public',
  summary: 'Open a shared licence card from its link (public). Standing is read live, so a revoked, suspended or expired licence shows as such; a revoked or lapsed link is a 404. A young person\'s name is withheld.',
  input: z.object({ token: z.string().trim().min(20).max(80) }),
  async handler(_ctx, i) {
    const s = await one('SELECT id, licence_id FROM fed_licence_card_shares WHERE token_sha256=$1 AND revoked_at IS NULL AND expires_at > now()', [sha256(i.token)]);
    if (!s) throw notFound('Licence card');
    const l = await licenceRow(s.licence_id);
    if (!l) throw notFound('Licence card');
    await one('UPDATE fed_licence_card_shares SET view_count=view_count+1, last_viewed_at=now() WHERE id=$1 RETURNING id', [s.id]);
    const card = cardData(l, { minor: await isYouth(l.holder_id) });
    const { public_code: _code, ...shown } = card;      // a shared view does not hand out the code that opens the register check
    return { card: shown, valid: card.valid, as_of: new Date().toISOString() };
  },
});

cap({
  name: 'get_licence_card_file', method: 'GET', path: '/federation/licences/:id/card/file', tag: TAG,
  summary: 'The card as a PDF or a PNG image to save or share (the holder, or the guardian with the `register` scope; a young person\'s own account cannot export it). Status is read live when it is made, and the file says when. Its QR is the licence\'s public code, which the register check resolves live. Returns { filename, content_type, encoding, content }.',
  input: z.object({ id, format: z.enum(['pdf', 'png']).default('png') }),
  async handler({ user }, i) {
    const { l, minor } = await cardFor(user, i.id, { scope: 'register', outward: true });
    const asOf = new Date(), card = cardData(l, { minor }), qrValue = verifyUrl(l.public_code);
    await audit(null, user.id, `export_licence_card_${i.format}`, 'fed_licences', l.id);
    const base = `licence-${(l.licence_no ?? l.id).toString().replace(/[^A-Za-z0-9_-]/g, '')}`;
    return i.format === 'pdf'
      ? fileOf(`${base}.pdf`, 'application/pdf', await cardPdf(card, { qrValue, asOf }))
      : fileOf(`${base}.png`, 'image/png', await cardPng(cardSvg(card, { qrValue, asOf })));
  },
});
