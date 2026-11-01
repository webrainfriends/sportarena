// Travel channel partners (#704): the platform admin connects hotel / flight channel partners (an online travel site such as Booking.com, MakeMyTrip,
// Trip.com, Agoda or Expedia, or a travel gateway) per region, as many as needed. Trips search every partner that serves their destination and book
// through the one the person picks. Platform admin only, enforced here with mustBePlatformAdmin (the paths sit under /admin, so API tokens need the
// admin scope); the app hides the screen from everyone else. Credentials are encrypted and never returned; partners are paused or archived, never deleted.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { encrypt, decrypt, newOpaqueToken } from '../crypto.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { providerOf } from '../integrations/registry.js';
import { checkTarget } from '../integrations/http.js';
import { CHANNEL_CTX, CHANNEL_HOOK_CTX, PRESETS } from '../travel/adapters.js';

const TAG = 'Travel partners';
const adminOnly = ({ user }) => mustBePlatformAdmin(user);
const iso = z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter ISO country code, e.g. IN');
const kinds = z.array(z.enum(['stay', 'air'])).min(1).max(2);
const url = z.string().url().max(500);
const hookPath = (pid) => `/api/v1/webhooks/integrations/${pid}`;

const shape = (r) => ({ id: r.id, label: r.label, preset: r.preset, preset_name: PRESETS[r.preset]?.name, provider_key: r.provider_key, kinds: r.kinds, regions: r.regions, worldwide: r.regions.length === 0, mode: r.mode, status: r.status, priority: r.priority, rate_per_minute: r.rate_per_minute,
  credentials_set: !!r.config_enc, last_ok_at: r.last_ok_at, last_error: r.last_error, webhook_path: hookPath(r.id), created_at: r.created_at });
const cfgOf = (r) => (r.config_enc ? JSON.parse(decrypt(r.config_enc, CHANNEL_CTX)) : {});
const checkUrls = (cfg) => { for (const k of ['url', 'sandbox_url']) if (cfg[k]) { const bad = checkTarget(cfg[k]); if (bad) throw badRequest(`${k}: ${bad}`); } };

const CONN = z.object({ url, sandbox_url: url.optional(), api_key: z.string().min(8).max(500) }).strict();

cap({
  name: 'list_travel_channel_partners', method: 'GET', path: '/admin/travel-partners', tag: TAG,
  summary: 'Platform admin: the connected hotel / flight channel partners with kinds, regions (none = worldwide), mode, status, priority and health, plus the known sites. Credentials are never returned.',
  input: z.object({ include_archived: z.boolean().default(false) }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const rows = await many(`SELECT * FROM travel_channel_partners ${i.include_archived ? '' : "WHERE status <> 'archived'"} ORDER BY priority, label`);
    return { items: rows.map(shape), presets: Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, kinds: p.kinds })) };
  },
});

cap({
  name: 'create_travel_channel_partner', method: 'POST', path: '/admin/travel-partners', tag: TAG, status: 201,
  summary: 'Platform admin: connect a channel partner for regions. Pick the site (or "other"), what it supplies (stays, flights), the regions it serves (ISO countries; none = worldwide), live or sandbox, and give its API address and key. The partner\'s callback secret is shown once; the partner signs each change or cancellation with it.',
  input: z.object({ label: z.string().trim().min(2).max(80), preset: z.enum(['booking_com', 'makemytrip', 'trip_com', 'agoda', 'expedia', 'other', 'sandbox']), kinds, regions: z.array(iso).max(250).default([]), mode: z.enum(['live', 'sandbox']).default('live'),
    priority: z.number().int().min(1).max(1000).default(100), rate_per_minute: z.number().int().min(1).max(6000).default(60), connection: CONN.optional() }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const user = ctx.user;
    const sandbox = i.preset === 'sandbox';
    if (!sandbox && !i.connection) throw badRequest('Give the partner\'s API address and key');
    if (sandbox && i.mode === 'live') throw badRequest('The sandbox partner books nothing real: use sandbox mode');
    if (i.connection) checkUrls(i.connection);
    const bad = i.kinds.filter((k) => !PRESETS[i.preset].kinds.includes(k));
    if (bad.length) throw badRequest(`${PRESETS[i.preset].name} does not supply: ${bad.join(', ')}`);
    const secret = newOpaqueToken();
    return tx(async (c) => {
      const r = (await c.query(`INSERT INTO travel_channel_partners(label, preset, provider_key, kinds, regions, mode, priority, rate_per_minute, config_enc, webhook_secret_enc, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [i.label, i.preset, sandbox ? 'travel_sandbox' : 'travel_partner_https', i.kinds, [...new Set(i.regions)].sort(), i.mode, i.priority, i.rate_per_minute,
        i.connection ? encrypt(JSON.stringify(i.connection), CHANNEL_CTX) : null, encrypt(secret, CHANNEL_HOOK_CTX), user.id])).rows[0];
      await audit(c, user.id, 'create_travel_channel_partner', 'travel_channel_partners', r.id);
      return { ...shape(r), webhook_secret: secret, webhook_secret_note: 'Shown once. Sign each callback body with HMAC-SHA256 and send it as x-sportarena-signature.' };
    });
  },
});

cap({
  name: 'update_travel_channel_partner', method: 'PATCH', path: '/admin/travel-partners/:id', tag: TAG,
  summary: 'Platform admin: change a channel partner\'s name, kinds, regions, mode, priority, rate limit or status (active, paused, archived), replace its credentials, or rotate its callback secret (shown once). Pausing stops new searches and holds; bookings already made can still be confirmed and cancelled. Nothing is deleted.',
  input: z.object({ id, label: z.string().trim().min(2).max(80).optional(), kinds: kinds.optional(), regions: z.array(iso).max(250).optional(), mode: z.enum(['live', 'sandbox']).optional(), priority: z.number().int().min(1).max(1000).optional(),
    rate_per_minute: z.number().int().min(1).max(6000).optional(), status: z.enum(['active', 'paused', 'archived']).optional(), connection: CONN.optional(), rotate_webhook_secret: z.boolean().default(false) }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const user = ctx.user;
    return tx(async (c) => {
      const r0 = (await c.query('SELECT * FROM travel_channel_partners WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r0) throw notFound('Travel partner');
      if (r0.status === 'archived' && i.status !== 'active') throw conflict('This partner is archived. Set it active to use it again.');
      const kindsNext = i.kinds ?? r0.kinds;
      const bad = kindsNext.filter((k) => !PRESETS[r0.preset].kinds.includes(k));
      if (bad.length) throw badRequest(`${PRESETS[r0.preset].name} does not supply: ${bad.join(', ')}`);
      if (r0.provider_key === 'travel_sandbox' && (i.mode === 'live' || i.connection)) throw badRequest('The sandbox partner books nothing real');
      if (i.connection) checkUrls(i.connection);
      if (i.status === 'active' && r0.provider_key !== 'travel_sandbox' && !r0.config_enc && !i.connection) throw badRequest('Give the partner\'s API address and key first');
      const secret = i.rotate_webhook_secret ? newOpaqueToken() : null;
      const r = (await c.query(`UPDATE travel_channel_partners SET label=COALESCE($2,label), kinds=$3, regions=COALESCE($4,regions), mode=COALESCE($5,mode), priority=COALESCE($6,priority), rate_per_minute=COALESCE($7,rate_per_minute),
          status=COALESCE($8,status), archived_at = CASE WHEN COALESCE($8,status)='archived' THEN COALESCE(archived_at, now()) ELSE NULL END, config_enc=COALESCE($9,config_enc), webhook_secret_enc=COALESCE($10,webhook_secret_enc), updated_at=now() WHERE id=$1 RETURNING *`,
        [i.id, i.label ?? null, kindsNext, i.regions ? [...new Set(i.regions)].sort() : null, i.mode ?? null, i.priority ?? null, i.rate_per_minute ?? null, i.status ?? null,
          i.connection ? encrypt(JSON.stringify(i.connection), CHANNEL_CTX) : null, secret ? encrypt(secret, CHANNEL_HOOK_CTX) : null])).rows[0];
      await audit(c, user.id, secret ? 'rotate_travel_partner_secret' : i.connection ? 'replace_travel_partner_credentials' : 'update_travel_channel_partner', 'travel_channel_partners', r.id);
      return { ...shape(r), ...(secret ? { webhook_secret: secret, webhook_secret_note: 'Shown once. The old secret no longer works.' } : {}) };
    });
  },
});

cap({
  name: 'test_travel_channel_partner', method: 'POST', path: '/admin/travel-partners/:id/test', tag: TAG,
  summary: 'Platform admin: check that the partner answers with the stored credentials (a health call; nothing is booked). The result and any error are kept on the partner.',
  input: z.object({ id }),
  async handler(ctx, i) {
    await adminOnly(ctx);
    const r = await one('SELECT * FROM travel_channel_partners WHERE id=$1', [i.id]);
    if (!r) throw notFound('Travel partner');
    const p = providerOf(r.provider_key);
    let out;
    try { out = await p.test(cfgOf(r), { mode: r.mode }); } catch (e) { out = { ok: false, message: String(e.message).slice(0, 200) }; }
    await pool.query('UPDATE travel_channel_partners SET last_ok_at=CASE WHEN $2 THEN now() ELSE last_ok_at END, last_error=CASE WHEN $2 THEN NULL ELSE $3 END WHERE id=$1', [r.id, !!out.ok, out.ok ? null : out.message]);
    await audit(null, ctx.user.id, 'test_travel_channel_partner', 'travel_channel_partners', r.id);
    return out;
  },
});
