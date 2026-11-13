import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({
  outlet_auth_key: z.string().max(128).optional(),
  secret_key: z.string().max(128).optional(),
}).strict();
export const secrets = ['outlet_auth_key', 'secret_key'];

export async function test(cfg) {
  if (!cfg.outlet_auth_key) throw Object.assign(new Error('Opta outlet_auth_key is required'), { permanent: true });
  const r = await send('GET', `https://api.performfeeds.com/soccerdata/competition?_rt=b&_fmt=json&_pgSz=5&outletAuthKey=${cfg.outlet_auth_key ?? ''}`, { headers: { accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Opta rejected the outlet auth key'), { permanent: true });
  return { ok: true, message: 'Opta Stats Perform reachable' };
}

export async function pull(cfg, ctx) {
  if (!cfg.outlet_auth_key) return { summary: { competitions: 0 } };
  const r = await send('GET', `https://api.performfeeds.com/soccerdata/competition?_rt=b&_fmt=json&outletAuthKey=${cfg.outlet_auth_key}`, { headers: { accept: 'application/json' } });
  if (r.status !== 200) throw new Error(`Opta answered ${r.status}`);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Opta did not return JSON'), { permanent: true }); }
  return { summary: { competitions: json?.competition?.length ?? 0 } };
}

export const sandbox = { competitions: 18, matches: 240, players: 4500, events: 12800 };
