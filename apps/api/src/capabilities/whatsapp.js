// WhatsApp: a person verifies their number (a code is sent to it) and then switches the channel on in their notification
// preferences. Platform admins link the platform number (QR) and may grant a dedicated number to an owner such as an event
// organiser, sponsor, physio, doctor or venue. See src/whatsapp.js for sending.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { blindIndex, decrypt, encrypt, sha256 } from '../crypto.js';
import { audit } from '../helpers.js';
import { isYouth } from '../youth.js';
import { tooMany } from '../account-security.js';
import { gateway, normalizePhone, resolveSender } from '../whatsapp.js';
import { activeProvider, guardVerificationTarget, liftStopSuppression, optOut, recordConsent, sendSystem } from '../comms.js';

const TAG = 'WhatsApp';
const CODE_TTL_MIN = 10;
const MAX_CODE_TRIES = 5;
const SCOPES = ['event', 'organisation', 'sponsor', 'provider', 'venue'];
const codeHash = (userId, code) => sha256(`wa:${userId}:${code}`);
const mask = (digits) => `+${digits.slice(0, 2)}${'•'.repeat(Math.max(0, digits.length - 5))}${digits.slice(-3)}`;
const needGateway = () => { if (!gateway.configured()) throw unprocessable('WhatsApp is not set up on this server yet'); };
// WhatsApp is available through the OpenWA gateway or an official Business Cloud API account (see communications.js)
const whatsappAvailable = async () => gateway.configured() || !!(await activeProvider(null, 'whatsapp', null));

cap({
  name: 'get_whatsapp_status', method: 'GET', path: '/me/whatsapp', tag: TAG,
  summary: 'Whether WhatsApp is available on this server, and the state of your WhatsApp number (masked): none, awaiting its code, verified, or opted out.',
  async handler({ user }) {
    const w = await one('SELECT phone_enc, verified_at, opted_out_at, code_expires_at FROM whatsapp_contacts WHERE user_id=$1', [user.id]);
    const state = !w ? 'none' : w.opted_out_at ? 'opted_out' : w.verified_at ? 'verified' : 'pending_code';
    return { available: await whatsappAvailable(), state, number: w ? mask(decrypt(w.phone_enc, 'whatsapp_contacts.phone')) : null, verified_at: w?.verified_at ?? null };
  },
});

cap({
  name: 'request_whatsapp_verification', method: 'POST', path: '/me/whatsapp/verify', tag: TAG,
  summary: 'Start WhatsApp notifications: give your number with the country code (e.g. +91…) and a 6-digit code is sent to it on WhatsApp. Adults only.',
  input: z.object({ phone: z.string().min(8).max(24).describe('with country code, e.g. +919876543210') }),
  async handler({ user }, i) {
    if (!(await whatsappAvailable())) throw unprocessable('WhatsApp is not set up on this server yet');
    const digits = normalizePhone(i.phone);
    if (!digits) throw badRequest('Enter the number with its country code, like +91 98765 43210');
    if (await isYouth(user.id)) throw unprocessable('WhatsApp messages are not sent to under-18 accounts. A parent or guardian can switch them on for their own number.');
    const cur = await one('SELECT code_sent_at FROM whatsapp_contacts WHERE user_id=$1', [user.id]);
    if (cur?.code_sent_at && Date.now() - cur.code_sent_at.getTime() < 60_000) throw tooMany('Wait a minute before asking for another code.');
    const target = await guardVerificationTarget(null, 'whatsapp', digits);
    if (!target.ok) throw target.reason === 'blocked' ? unprocessable('That number cannot receive messages') : tooMany('That number has been sent too many codes today.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (gateway.configured()) {
      const sender = await resolveSender(null);
      if (!sender) throw unprocessable('No WhatsApp number is linked yet');
      await gateway.sendText(sender.openwa_session, digits, `Your Sportarena code is ${code}. It works for ${CODE_TTL_MIN} minutes. If you did not ask for it, ignore this message.`);
    } else if (!(await sendSystem(null, { channel: 'whatsapp', digits, useCase: 'phone_verification', values: { code } }))) throw unprocessable('WhatsApp verification is not set up yet (no approved verification template)');
    await one(
      `INSERT INTO whatsapp_contacts(user_id, phone_enc, phone_idx, code_hash, code_expires_at, code_attempts, code_sent_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5), 0, now())
       ON CONFLICT (user_id) DO UPDATE SET phone_enc=$2, phone_idx=$3, code_hash=$4, code_expires_at=now() + make_interval(mins => $5), code_attempts=0, code_sent_at=now(), verified_at=NULL, opted_out_at=NULL, updated_at=now()
       RETURNING user_id`, [user.id, encrypt(digits, 'whatsapp_contacts.phone'), blindIndex(digits), codeHash(user.id, code), CODE_TTL_MIN]);
    return { sent: true, number: mask(digits), expires_in_minutes: CODE_TTL_MIN };
  },
});

cap({
  name: 'confirm_whatsapp_verification', method: 'POST', path: '/me/whatsapp/confirm', tag: TAG,
  summary: 'Enter the 6-digit code you received on WhatsApp. On success WhatsApp notifications are switched on.',
  input: z.object({ code: z.string().regex(/^\d{6}$/) }),
  async handler({ user }, i) {
    const w = await one('SELECT code_hash, code_expires_at, code_attempts, phone_idx FROM whatsapp_contacts WHERE user_id=$1 AND verified_at IS NULL', [user.id]);
    if (!w?.code_hash || w.code_expires_at < new Date()) throw badRequest('That code has expired. Ask for a new one.');
    if (w.code_attempts >= MAX_CODE_TRIES) throw tooMany('Too many wrong codes. Ask for a new one.');
    const a = Buffer.from(codeHash(user.id, i.code)), b = Buffer.from(w.code_hash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await one('UPDATE whatsapp_contacts SET code_attempts=code_attempts+1 WHERE user_id=$1 RETURNING user_id', [user.id]);
      throw badRequest('That code is not right.');
    }
    return tx(async (c) => {
      await c.query('UPDATE whatsapp_contacts SET verified_at=now(), code_hash=NULL, code_expires_at=NULL, opted_out_at=NULL, updated_at=now() WHERE user_id=$1', [user.id]);
      await c.query('INSERT INTO notification_prefs(user_id, whatsapp) VALUES ($1,true) ON CONFLICT (user_id) DO UPDATE SET whatsapp=true', [user.id]);
      await liftStopSuppression(c, w.phone_idx, 'whatsapp');
      await recordConsent(c, user.id, 'whatsapp', 'opt_in', 'app_verification', { phoneIdx: w.phone_idx });
      await audit(c, user.id, 'verify_whatsapp', 'users', user.id);
      return { verified: true };
    });
  },
});

cap({
  name: 'remove_whatsapp_number', method: 'DELETE', path: '/me/whatsapp', tag: TAG,
  summary: 'Stop WhatsApp notifications. Your number stays on file as opted out (nothing is deleted); verify again to switch back on.',
  async handler({ user }) {
    await tx((c) => optOut(c, user.id, 'whatsapp', { source: 'app_switch' })); // flag, switch, consent row and any queued messages, in one step
    return { state: 'opted_out' };
  },
});

// ---------------------------------------------------------------- numbers (platform admin)
const SENDER = 's.id, s.scope_kind, s.scope_id, s.label, s.openwa_session, s.entitled_at, s.revoked_at';

cap({
  name: 'list_whatsapp_senders', method: 'GET', path: '/admin/whatsapp/senders', tag: TAG, auth: ['admin'],
  summary: 'The platform WhatsApp number and any dedicated numbers granted to events, organisations, sponsors, providers or venues, with their live link status.',
  async handler() {
    const rows = await many(`SELECT ${SENDER} FROM whatsapp_senders s WHERE s.revoked_at IS NULL ORDER BY s.scope_kind <> 'platform', s.created_at`);
    const out = [];
    for (const r of rows) {
      let status = 'unknown';
      if (gateway.configured()) { try { status = (await gateway.session(r.openwa_session)).status; } catch { status = 'unreachable'; } }
      out.push({ ...r, status });
    }
    return { available: gateway.configured(), items: out };
  },
});

cap({
  name: 'link_whatsapp_sender', method: 'POST', path: '/admin/whatsapp/senders', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Add a sending number. Without scope it is the platform number; with a scope (event, organisation, sponsor, provider, venue + its id) it is a dedicated number for that owner, granted as part of their subscription. Returns the QR code to scan in WhatsApp > Linked devices.',
  input: z.object({ label: z.string().min(2).max(80), scope_kind: z.enum(SCOPES).optional(), scope_id: id.optional() }).refine((v) => !!v.scope_kind === !!v.scope_id, 'Give both scope_kind and scope_id, or neither'),
  async handler({ user }, i) {
    needGateway();
    const kind = i.scope_kind ?? 'platform';
    if (await one('SELECT 1 FROM whatsapp_senders WHERE scope_kind=$1 AND scope_id IS NOT DISTINCT FROM $2 AND revoked_at IS NULL', [kind, i.scope_id ?? null])) throw conflict('That owner already has a WhatsApp number');
    const s = await gateway.createSession(`sa-${kind}-${randomInt(100000, 999999)}`);
    await gateway.start(s.id);
    const row = await one(`INSERT INTO whatsapp_senders(scope_kind, scope_id, label, openwa_session, entitled_by) VALUES ($1,$2,$3,$4,$5) RETURNING ${SENDER.replaceAll('s.', '')}`, [kind, i.scope_id ?? null, i.label, s.id, user.id]);
    const qr = await gateway.qr(s.id).catch(() => null);
    return { ...row, qr: qr?.qrCode ?? null, status: qr?.status ?? s.status };
  },
});

cap({
  name: 'get_whatsapp_sender_qr', method: 'GET', path: '/admin/whatsapp/senders/:id/qr', tag: TAG, auth: ['admin'],
  summary: 'The current QR code (or the connected status) for a sending number. Scan it in WhatsApp > Linked devices; it refreshes, so poll.',
  input: z.object({ id }),
  async handler(_ctx, i) {
    needGateway();
    const s = await one('SELECT openwa_session FROM whatsapp_senders WHERE id=$1 AND revoked_at IS NULL', [i.id]);
    if (!s) throw notFound('WhatsApp number');
    const st = await gateway.session(s.openwa_session);
    if (st.status === 'ready') return { status: 'ready', phone: st.phone ?? null, qr: null };
    const qr = await gateway.qr(s.openwa_session).catch(() => null);
    return { status: qr?.status ?? st.status, phone: null, qr: qr?.qrCode ?? null };
  },
});

cap({
  name: 'revoke_whatsapp_sender', method: 'DELETE', path: '/admin/whatsapp/senders/:id', tag: TAG, auth: ['admin'],
  summary: 'Stop using a sending number (kept on file as revoked). That owner\'s messages fall back to the platform number.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE whatsapp_senders SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id, scope_kind', [i.id]);
    if (!r) throw notFound('WhatsApp number');
    await audit(null, user.id, 'revoke_whatsapp_sender', 'whatsapp_senders', r.id);
    return { revoked: true };
  },
});
