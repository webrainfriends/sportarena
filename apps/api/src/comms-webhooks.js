// Delivery receipts and replies from the WhatsApp Business Cloud API and the SMS gateway. Public URLs (no session): authenticity is the
// provider's signature, checked against the secret of the exact provider account named in the URL, before the body is looked at.
// A bad signature is rejected with no detail; a processing error answers 500 so the provider retries; a replay is acknowledged and ignored.
import express from 'express';
import { one } from './db.js';
import { logger } from './logger.js';
import { adapterFor } from './comms-providers.js';
import { providerConfig } from './comms.js';
import { applyProviderEvents } from './comms-dispatch.js';

export function commsWebhookRouter() {
  const r = express.Router();
  const raw = express.raw({ type: '*/*', limit: '512kb' });
  // A closed account still delivers receipts for a while (messages sent before a rotation can be delivered later), then its secret stops being accepted.
  const load = async (req) => {
    const adapter = adapterFor(req.params.kind);
    const row = adapter && /^[0-9a-f-]{36}$/.test(req.params.providerId) ? await one("SELECT * FROM comm_providers WHERE id=$1 AND kind=$2 AND (effective_to IS NULL OR effective_to > now() - interval '14 days')", [req.params.providerId, req.params.kind]) : null;
    return row ? { adapter, row, cfg: providerConfig(row) } : null;
  };

  // Meta's subscription handshake
  r.get('/:kind/:providerId', async (req, res) => {
    try {
      const p = await load(req);
      const challenge = p?.adapter.handshake({ cfg: p.cfg, query: req.query });
      if (challenge == null) return res.status(403).end();
      res.type('text/plain').send(challenge);
    } catch (e) { logger.error('comms webhook handshake failed', { error: e.message }); res.status(500).end(); }
  });

  r.post('/:kind/:providerId', raw, async (req, res) => {
    try {
      const p = await load(req);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!p || !p.adapter.verifyWebhook({ cfg: p.cfg, rawBody: body, headers: req.headers })) return res.status(401).json({ error: 'bad_signature' });
      let json;
      try { json = JSON.parse(body.toString('utf8')); } catch { return res.status(400).json({ error: 'bad_json' }); }
      const result = await applyProviderEvents(p.row, p.adapter.parseWebhook(json));
      res.json({ received: true, ...result });
    } catch (e) {
      logger.error('comms webhook failed', { error: String(e.message).slice(0, 200) });
      res.status(500).json({ error: 'processing_failed' }); // non-2xx => the provider retries
    }
  });
  return r;
}
