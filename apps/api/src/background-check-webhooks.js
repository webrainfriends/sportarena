// Background-check provider callbacks (#703). A public URL (no session): authenticity is the provider's HMAC signature, checked against the secret of the exact
// credentials named in the URL, before the body is looked at. A bad signature gets no detail; a processing error answers 500 so the provider retries; a replay
// (same event id) is acknowledged and ignored. Only the mapped state is applied: the body is never stored.
import express from 'express';
import { one, tx } from './db.js';
import { logger } from './logger.js';
import { adapterFor, applyVendorState, credentialsFor, refIndex } from './background-checks.js';

export function backgroundCheckWebhookRouter() {
  const r = express.Router();
  r.post('/:credentialId', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const cred = /^[0-9a-f-]{36}$/.test(req.params.credentialId) ? await credentialsFor(req.params.credentialId) : null;
      // a rotated-away credential still delivers results for checks ordered under it, for a while
      const usable = cred && (!cred.row.effective_to || new Date(cred.row.effective_to) > new Date(Date.now() - 14 * 86_400_000));
      const adapter = usable ? adapterFor(cred.row.provider) : null;
      if (!adapter || !adapter.verifyWebhook({ cfg: cred.cfg, rawBody: body, headers: req.headers })) return res.status(401).json({ error: 'bad_signature' });
      let json;
      try { json = JSON.parse(body.toString('utf8')); } catch { return res.status(400).json({ error: 'bad_json' }); }
      let applied = 0, replays = 0;
      for (const ev of adapter.parseWebhook(json)) {
        await tx(async (c) => {
          const v = (await c.query(
            `SELECT v.* FROM comp_check_vendor v JOIN comp_vendor_credentials k ON k.id=v.credential_id
              WHERE v.provider=$1 AND v.provider_ref_idx=$2 AND k.organisation_id IS NOT DISTINCT FROM $3 FOR UPDATE OF v`, [cred.row.provider, refIndex(cred.row.provider, ev.ref), cred.row.organisation_id])).rows[0];
          const first = (await c.query('INSERT INTO comp_vendor_events(provider, event_id, record_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [cred.row.provider, ev.eventId, v?.record_id ?? null])).rowCount;
          if (!first) { replays++; return; }
          if (v && await applyVendorState(c, v, ev.state, 'webhook')) applied++;
        });
      }
      res.json({ received: true, applied, replays });
    } catch (e) {
      logger.error('background check webhook failed', { error: String(e.message).slice(0, 200) });
      res.status(500).json({ error: 'processing_failed' });
    }
  });
  return r;
}
