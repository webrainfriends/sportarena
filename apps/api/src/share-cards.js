// Share cards (#501): the public-safe summary of an event, game, table, final result or award that a link preview, a social card or an in-app share sheet shows.
// A card is ALWAYS built as an anonymous visitor would see it: a private event, a draft, a young person or an unfinished result produces no card,
// so a card (and a link to it) stops working the moment the organiser withdraws the event. Nothing here is stored.
import { one } from './db.js';
import { conflict, notFound } from './errors.js';
import { config } from './config.js';
import { YOUTH_SQL } from './youth.js';
import { isYouthEvent, loadViewableEvent, loadViewableFixture, publicFixtures, publicStandings, eventState, UUID } from './spectator.js';

export const CARD_TYPES = ['event', 'fixture', 'result', 'standings', 'award'];
const AWARD_LABEL = { cup: 'Cup', trophy: 'Trophy', medal_gold: 'Gold medal', medal_silver: 'Silver medal', medal_bronze: 'Bronze medal', mvp: 'MVP', badge: 'Badge' };
const STATE_LABEL = { upcoming: 'Upcoming', live: 'Live now', in_progress: 'Under way', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled' };
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export function appBase() {
  if (config.appUrl) return config.appUrl.replace(/\/$/, '');
  const o = config.corsOrigins.find((x) => x && x !== '*');
  return o ? o.replace(/\/$/, '') : null;
}
const apiPath = (kind, id) => `/api/v1/share/${kind}/${id}`;

/** May search engines index the share page of this event? Only public, non-youth, non-archived events whose organiser opted in. */
export const isIndexable = (ev) => ev.public_visibility === 'public' && !!ev.public_indexable && !isYouthEvent(ev) && ev.status !== 'draft' && !ev.archived_at;

async function liveCount(eventId) {
  return (await one("SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1 AND status IN ('live','paused')", [eventId])).n;
}

const frame = (ev, extra) => {
  const base = appBase();
  return { event_id: ev.id, event_name: ev.name, sport: ev.sport, youth: isYouthEvent(ev), indexable: isIndexable(ev), ...extra, app_path: `/?event=${ev.id}${extra.fixture_id ? `&fixture=${extra.fixture_id}` : ''}`,
    app_url: base ? `${base}/?event=${ev.id}${extra.fixture_id ? `&fixture=${extra.fixture_id}` : ''}` : null };
};

export async function buildCard(type, id) {
  if (!CARD_TYPES.includes(type)) throw notFound('Share card');
  if (!UUID.test(String(id))) throw notFound('Share card');

  if (type === 'event' || type === 'standings') {
    const { ev } = await loadViewableEvent(null, id);
    const state = eventState(ev, await liveCount(ev.id));
    const org = ev.organisation_id ? (await one('SELECT name FROM organisations WHERE id=$1', [ev.organisation_id]))?.name : null;
    const where = ev.city ?? (ev.venue_id ? (await one('SELECT city FROM venues WHERE id=$1', [ev.venue_id]))?.city : null);
    if (type === 'event') {
      const champion = state === 'completed' ? (await one("SELECT t.name FROM fixtures f JOIN teams t ON t.id=f.winner_team_id WHERE f.event_id=$1 AND f.round_kind='final' AND f.status='completed'", [ev.id]))?.name : null;
      return frame(ev, { type, title: ev.name, kicker: `${ev.sport_emoji} ${ev.sport}`, label: STATE_LABEL[state], state,
        lines: [[day(ev.starts_on), ev.ends_on && ev.ends_on !== ev.starts_on ? `to ${day(ev.ends_on)}` : null].filter(Boolean).join(' '), where, org ? `Organised by ${org}` : null, champion ? `Champions: ${champion}` : null].filter(Boolean),
        description: [`${ev.name} — ${ev.sport}`, STATE_LABEL[state], where].filter(Boolean).join(' · '), path: apiPath('events', ev.id) });
    }
    const t = await publicStandings(ev);
    if (!t.rows.length) throw conflict('There is no table to share yet');
    return frame(ev, { type, title: `${ev.name} — table`, kicker: `${ev.sport_emoji} ${ev.sport}`, label: t.label === 'final' ? 'Final table' : 'Provisional table', state,
      lines: t.rows.slice(0, 4).map((r) => `${r.rank}. ${r.name} — ${r.points} pts (${r.played} played)`),
      description: `${ev.name}: ${t.rows.slice(0, 3).map((r) => `${r.rank}. ${r.name} ${r.points}`).join(', ')} (${t.label})`, path: apiPath('events', ev.id) });
  }

  if (type === 'fixture' || type === 'result') {
    const { f, ev } = await loadViewableFixture(null, id);
    const [row] = await publicFixtures(ev.id, { ids: [f.id], limit: 1 });
    if (type === 'result' && row.label !== 'final') throw conflict('This result is not final yet');
    const sc = row.score;
    const scoreText = sc ? `${row.home.name} ${sc.home}–${sc.away} ${row.away.name}` : `${row.home.name} v ${row.away.name}`;
    const when = row.scheduled_at ? new Date(row.scheduled_at).toLocaleString('en-GB', { timeZone: row.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
    const label = row.label === 'final' ? 'Full time' : row.label === 'provisional' ? 'Full time (provisional)' : row.label === 'live' ? 'Live' : row.label.charAt(0).toUpperCase() + row.label.slice(1);
    return frame(ev, { type, fixture_id: f.id, title: scoreText, kicker: `${ev.sport_emoji} ${ev.name}`, label, state: row.label, corrected: row.corrected,
      lines: [row.round, row.label === 'scheduled' ? when : null, row.venue?.name, row.corrected ? 'Result corrected' : null].filter(Boolean),
      description: `${scoreText} · ${label}${row.round ? ` · ${row.round}` : ''} · ${ev.name}`, path: apiPath('fixtures', f.id) });
  }

  // award
  const a = await one('SELECT * FROM awards WHERE id=$1', [id]);
  if (!a) throw notFound('Share card');
  let ev = null;
  if (a.event_id) ev = (await loadViewableEvent(null, a.event_id)).ev;
  else throw notFound('Share card'); // an award with no event has no public home to link to
  const who = a.team_id ? (await one('SELECT name FROM teams WHERE id=$1', [a.team_id]))?.name
    : (await one(`SELECT u.display_name FROM users u WHERE u.id=$1 AND NOT ${YOUTH_SQL}`, [a.user_id]))?.display_name;
  if (!who || (isYouthEvent(ev) && a.user_id)) throw notFound('Share card'); // young people's achievements are never shared publicly
  return frame(ev, { type, title: a.name, kicker: `🏆 ${AWARD_LABEL[a.kind] ?? 'Award'}`, label: AWARD_LABEL[a.kind] ?? 'Award', state: 'awarded', lines: [who, ev.name],
    description: `${who} — ${a.name} (${ev.name})`, path: apiPath('awards', a.id) });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };
const wrap = (text, n) => { const out = []; let line = ''; for (const w of String(text).split(/\s+/)) { if ((line + ' ' + w).trim().length > n) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out.slice(0, 2); };

/** A 1200×630 card as SVG: self-contained (no fonts or images fetched), safe to download, embed or rasterise. */
export function cardSvg(card) {
  const title = wrap(card.title, 26);
  const lines = card.lines.slice(0, 4);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(card.description)}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#23252F"/><stop offset="1" stop-color="#494D5F"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/><circle cx="1080" cy="80" r="190" fill="#8B5CF6" opacity="0.28"/><circle cx="90" cy="610" r="150" fill="#9B72C6" opacity="0.2"/>
<text x="70" y="110" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" fill="#A79FCB">${esc(card.kicker)}</text>
<rect x="70" y="140" width="${Math.min(520, 40 + card.label.length * 20)}" height="52" rx="26" fill="${card.state === 'live' ? '#F43F5E' : card.state === 'provisional' ? '#FBBF24' : '#A3E635'}"/>
<text x="${70 + 22}" y="176" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="800" fill="#23252F">${esc(card.label.toUpperCase())}</text>
${title.map((t, i) => `<text x="70" y="${290 + i * 84}" font-family="Helvetica, Arial, sans-serif" font-size="72" font-weight="800" fill="#F8F5FF">${esc(t)}</text>`).join('\n')}
${lines.map((t, i) => `<text x="70" y="${450 + i * 42}" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#D8D2F0">${esc(t)}</text>`).join('\n')}
<text x="1130" y="600" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#A79FCB">Gotmygame</text>
</svg>`;
}

