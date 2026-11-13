import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({ club_id: z.string().max(80).optional() }).strict();
export const secrets = [];

export async function test(cfg) {
  const r = await send('GET', 'https://app.veo.co/api/v1/me', { headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Veo rejected the OAuth token'), { permanent: true });
  return { ok: true, message: 'Veo reachable' };
}

export async function pull(cfg, ctx) {
  const r = await send('GET', 'https://app.veo.co/api/v1/recordings', { headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Veo rejected the OAuth token'), { permanent: true });
  if (r.status !== 200) throw new Error(`Veo answered ${r.status}`);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Veo did not return JSON'), { permanent: true }); }
  const recordings = Array.isArray(json) ? json : (Array.isArray(json?.recordings) ? json.recordings : []);
  return { summary: { recordings: recordings.length } };
}
