import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({
  sport: z.string().max(40).optional(),
  locale: z.string().max(10).optional(),
}).strict();
export const secrets = ['api_key'];

export async function test(cfg) {
  if (!cfg.api_key) throw Object.assign(new Error('Sportradar API key is required'), { permanent: true });
  const sport = cfg.sport ?? 'soccer';
  const locale = cfg.locale ?? 'en';
  const r = await send('GET', `https://api.sportradar.com/${sport}-t3/${locale}/eu/seasons.json?api_key=${cfg.api_key}`, { headers: { accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Sportradar rejected the API key'), { permanent: true });
  if (r.status === 429) throw new Error('Sportradar rate limit exceeded');
  return { ok: true, message: 'Sportradar reachable' };
}

export async function pull(cfg, ctx) {
  if (!cfg.api_key) return { summary: { competitions: 0 } };
  const sport = cfg.sport ?? 'soccer';
  const locale = cfg.locale ?? 'en';
  const r = await send('GET', `https://api.sportradar.com/${sport}-t3/${locale}/eu/competitions.json?api_key=${cfg.api_key}`, { headers: { accept: 'application/json' } });
  if (r.status !== 200) throw new Error(`Sportradar answered ${r.status}`);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Sportradar did not return JSON'), { permanent: true }); }
  return { summary: { competitions: json?.competitions?.length ?? 0 } };
}

export const sandbox = { competitions: 42, seasons: 8, teams: 320, players: 7200 };
