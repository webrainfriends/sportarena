// Signed inbound deliveries from a connected system (e.g. a ticket scanner). Public URL, no session: authenticity is the HMAC of the exact
// install named in the URL, checked before the body is read. Bad signature -> 401 with no detail; replay -> acknowledged and ignored;
// over the install's rate limit -> 429; processing error -> 500 so the sender retries.
import express from 'express';
import { one } from '../db.js';
import { logger } from '../logger.js';
import { providerOf } from './registry.js';
import { decrypt } from '../crypto.js';
import { CHANNEL_HOOK_CTX } from '../travel/adapters.js';
import { allowCall, countFailure, emit, logEvent, webhookSecret } from './engine.js';
import { query } from '../db.js';

/** A signed callback from a travel channel partner the platform admin connected. Same rules: bad signature -> 401, replay -> acknowledged and ignored. Returns true when it handled the request. */
async function channelHook(req, res) {
  const partner = await one("SELECT * FROM travel_channel_partners WHERE id=$1 AND status <> 'archived'", [req.params.installId]);
  if (!partner) return false;
  const p = providerOf(partner.provider_key);
  const secret = p?.inbound && partner.webhook_secret_enc ? decrypt(partner.webhook_secret_enc, CHANNEL_HOOK_CTX) : null;
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!secret || !p.inbound.verify(secret, raw, req.headers)) { res.status(401).json({ error: 'bad_signature' }); return true; }
  let json; try { json = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'bad_json' }); return true; }
  const { applyPartnerEvent } = await import('../travel/changes.js');
  let accepted = 0, duplicates = 0;
  for (const ev of p.inbound.parse(json)) {
    const fresh = await one('INSERT INTO provider_events(provider, event_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id', [`travel_partner:${partner.id}`, ev.id, ev.kind]);
    if (!fresh) { duplicates++; continue; }
    await applyPartnerEvent({ id: partner.id, channel: true }, ev); accepted++;
  }
  if (accepted) await query('UPDATE travel_channel_partners SET last_ok_at=now(), last_error=NULL WHERE id=$1', [partner.id]);
  res.json({ received: true, accepted, duplicates });
  return true;
}

export function integrationWebhookRouter() {
  const r = express.Router();
  r.post('/:installId', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    try {
      if (/^[0-9a-f-]{36}$/.test(req.params.installId) && await channelHook(req, res)) return;
      const install = /^[0-9a-f-]{36}$/.test(req.params.installId) ? await one("SELECT * FROM integration_installs WHERE id=$1 AND status IN ('connected','error')", [req.params.installId]) : null;
      const p = install && providerOf(install.provider_key);
      const secret = p?.inbound ? await webhookSecret(install.id) : null;
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!secret || !p.inbound.verify(secret, raw, req.headers)) return res.status(401).json({ error: 'bad_signature' });
      if (!(await allowCall(install))) return res.status(429).json({ error: 'rate_limited' });
      let json;
      try { json = JSON.parse(raw.toString('utf8')); } catch { await countFailure(install.id); return res.status(400).json({ error: 'bad_json' }); }
      let accepted = 0; let duplicates = 0;
      for (const ev of p.inbound.parse(json)) {
        const fresh = await one('INSERT INTO provider_events(provider, event_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id', [`integration:${install.id}`, ev.id, ev.kind]);
        if (!fresh) { duplicates++; continue; }
        const logged = await logEvent(install.id, 'webhook_in', 'ok', `Received ${ev.kind}`, { event_id: ev.id });
        await emit(install.organisation_id, install.id, 'integration.webhook.received', { install_id: install.id, provider: install.provider_key, kind: ev.kind, event_id: ev.id }, logged.id);
        if (install.category === 'travel') await (await import('../travel/changes.js')).applyPartnerEvent({ id: install.id }, ev);
        accepted++;
      }
      if (accepted) await query("UPDATE integration_installs SET status='connected', last_success_at=now(), last_attempt_at=now(), last_error=NULL WHERE id=$1", [install.id]);
      res.json({ received: true, accepted, duplicates });
    } catch (e) { logger.error('integration webhook failed', { error: e.message }); res.status(500).end(); }
  });
  return r;
}
