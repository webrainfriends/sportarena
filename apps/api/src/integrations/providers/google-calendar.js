import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({ calendar_id: z.string().max(200).optional() }).strict();
export const secrets = [];

export async function test(cfg) {
  const r = await send('GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` },
  });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Google Calendar rejected the OAuth token'), { permanent: true });
  return { ok: true, message: 'Google Calendar reachable' };
}

export async function pull(cfg, ctx) {
  const calId = encodeURIComponent(cfg.calendar_id ?? 'primary');
  const now = new Date().toISOString();
  const r = await send('GET', `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${now}&maxResults=250&singleEvents=true&orderBy=startTime`, {
    headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` },
  });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Google Calendar rejected the OAuth token'), { permanent: true });
  if (r.status !== 200) throw new Error(`Google Calendar answered ${r.status}`);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Google Calendar did not return JSON'), { permanent: true }); }
  return { summary: { events: json?.items?.length ?? 0 } };
}

export const sandbox = { events: 18, recurring: 4, calendars: 3 };
