import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({ team_id: z.string().max(80).optional() }).strict();
export const secrets = [];

export async function test(cfg) {
  const r = await send('GET', 'https://www.hudl.com/api/v3/healthcheck', { headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Hudl rejected the OAuth token'), { permanent: true });
  return { ok: true, message: 'Hudl reachable' };
}

export async function pull(cfg, ctx) {
  const base = 'https://www.hudl.com/api/v3';
  const teamParam = cfg.team_id ? `?teamId=${encodeURIComponent(cfg.team_id)}` : '';
  const r = await send('GET', `${base}/playlists${teamParam}`, { headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Hudl rejected the OAuth token'), { permanent: true });
  if (r.status !== 200) throw new Error(`Hudl answered ${r.status}`);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Hudl did not return JSON'), { permanent: true }); }
  const playlists = Array.isArray(json) ? json : (Array.isArray(json?.playlists) ? json.playlists : []);
  return { summary: { playlists: playlists.length } };
}

export const sandbox = { playlists: 3, clips: 47, analytics_events: 120 };
