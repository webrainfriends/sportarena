import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({
  feed_url: z.string().url().optional(),
  api_key: z.string().max(128).optional(),
}).strict();
export const secrets = [];

export async function test(cfg, ctx) {
  if (cfg.feed_url) {
    const r = await send('GET', cfg.feed_url, { headers: { accept: 'application/xml,application/json', 'x-api-key': cfg.api_key ?? '' } });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Federation feed rejected credentials'), { permanent: true });
    if (r.status !== 200) throw new Error(`Feed answered ${r.status}`);
  }
  return { ok: true, message: 'Federation feed reachable' };
}

export async function pull(cfg, ctx) {
  const url = cfg.feed_url;
  if (!url) return { summary: { events: 0 } };
  const r = await send('GET', url, { headers: { accept: 'application/xml,application/json', 'x-api-key': cfg.api_key ?? '' } });
  if (r.status !== 200) throw new Error(`Feed answered ${r.status}`);
  const isXml = (r.headers?.['content-type'] ?? '').includes('xml');
  const count = isXml ? (r.text.match(/<event/g) ?? []).length : 0;
  return { summary: { events: count, format: isXml ? 'xml' : 'json' } };
}

export const sandbox = { events: 24, athletes: 150, results: 48 };
