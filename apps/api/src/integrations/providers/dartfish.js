import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({ account_id: z.string().max(80).optional() }).strict();
export const secrets = [];

export async function test(cfg) {
  const r = await send('GET', 'https://api.dartfish.tv/v1/account/me', { headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Dartfish rejected the OAuth token'), { permanent: true });
  return { ok: true, message: 'Dartfish reachable' };
}

export async function pull(cfg, ctx) {
  const r = await send('GET', 'https://api.dartfish.tv/v1/videos', { headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Dartfish rejected the OAuth token'), { permanent: true });
  if (r.status !== 200) throw new Error(`Dartfish answered ${r.status}`);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Dartfish did not return JSON'), { permanent: true }); }
  const videos = Array.isArray(json) ? json : (Array.isArray(json?.videos) ? json.videos : []);
  return { summary: { videos: videos.length } };
}

export const sandbox = { videos: 12, annotations: 87, categories: 4 };
