// Server-rendered share pages and cards for public events (#501): stable URLs with link-preview metadata that work without the app or a login.
//   GET /api/v1/share/events/:id | /fixtures/:id | /awards/:id   HTML page (Open Graph / Twitter metadata, JSON-LD only when indexing is allowed)
//   GET /api/v1/share/cards/:type/:id.svg                       the share card image
//   GET /api/v1/share/sitemap.xml                               indexable events only
// Everything is built as an anonymous visitor sees it, so a private or withdrawn event is a 404 here and never appears in the sitemap.
// Indexing is off unless the organiser opted in, and is forced off for private, unlisted, youth, draft and archived events (X-Robots-Tag + meta robots).
import { Router } from 'express';
import { many } from './db.js';
import { toErrorBody } from './invoke.js';
import { buildCard, cardSvg, esc, isIndexable } from './share-cards.js';
import { loadViewableEvent, loadViewableFixture, publicFixtures, publicStandings, isYouthEvent, UUID } from './spectator.js';

const robots = (res, indexable) => res.set('X-Robots-Tag', indexable ? 'index, follow' : 'noindex, nofollow, noarchive');
const page404 = (res) => {
  robots(res, false);
  res.status(404).type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title></head><body style="font-family:system-ui;background:#23252F;color:#F8F5FF;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center;padding:24px"><h1>This page is not available</h1><p>It may be private, or the organiser has withdrawn it.</p></main></body></html>');
};

const STYLE = `:root{color-scheme:dark}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#23252F;color:#F8F5FF;line-height:1.45}
main{max-width:760px;margin:0 auto;padding:20px 16px 48px}h1{font-size:clamp(26px,5vw,40px);margin:.2em 0}h2{font-size:18px;margin:1.6em 0 .5em}.k{color:#A79FCB;font-weight:700}
.pill{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:800;font-size:13px;background:#A3E635;color:#23252F}.pill.live{background:#F43F5E;color:#fff}.pill.prov{background:#FBBF24}
table{width:100%;border-collapse:collapse}th,td{padding:10px 8px;text-align:left;border-bottom:1px solid rgba(255,255,255,.12)}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.g{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.12)}a.btn{display:inline-block;margin-top:18px;padding:14px 22px;min-height:44px;border-radius:999px;background:#9B72C6;color:#fff;font-weight:800;text-decoration:none}`;

const head = (card, url, indexable, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(card.title)} · Gotmygame</title><meta name="description" content="${esc(card.description)}">
<meta name="robots" content="${indexable ? 'index, follow' : 'noindex, nofollow, noarchive'}">${indexable && url ? `<link rel="canonical" href="${esc(url)}">` : ''}
<meta property="og:type" content="website"><meta property="og:title" content="${esc(card.title)}"><meta property="og:description" content="${esc(card.description)}">${url ? `<meta property="og:url" content="${esc(url)}">` : ''}
${card.image_url ? `<meta property="og:image" content="${esc(card.image_url)}"><meta property="og:image:type" content="image/svg+xml"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="${esc(card.image_url)}">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(card.title)}"><meta name="twitter:description" content="${esc(card.description)}">
${extra}<style>${STYLE}</style></head>`;

const when = (iso, tz) => { try { return new Date(iso).toLocaleString('en-GB', { timeZone: tz || 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const gameRow = (g) => `<div class="g"><span>${esc(g.home.name)} v ${esc(g.away.name)}<br><span class="k">${esc(g.round ?? '')}${g.round ? ' · ' : ''}${g.label === 'scheduled' ? esc(when(g.scheduled_at, g.timezone)) : esc(g.label)}${g.corrected ? ' · corrected' : ''}</span></span><strong>${g.score ? `${g.score.home}–${g.score.away}` : ''}</strong></div>`;

function selfUrls(req, kind, id, card) {
  const origin = `${req.protocol}://${req.get('host')}`;
  return { url: `${origin}/api/v1/share/${kind}/${id}`, image_url: `${origin}/api/v1/share/cards/${card.type}/${kind === 'events' ? card.event_id : id}.svg` };
}

export function publicWebRouter() {
  const r = Router();
  const fail = (res, e) => { const { status } = toErrorBody(e); if (status === 404 || status === 409) return page404(res); res.status(status).type('text').send('Something went wrong'); };

  r.get('/share/events/:id', async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) return page404(res);
      const { ev } = await loadViewableEvent(null, req.params.id);
      const card = await buildCard('event', ev.id);
      const indexable = isIndexable(ev);
      const { url, image_url } = selfUrls(req, 'events', ev.id, card);
      const youth = isYouthEvent(ev);
      const [table, games] = await Promise.all([publicStandings(ev), publicFixtures(ev.id, { limit: 12 })]);
      const ld = indexable ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'SportsEvent', name: ev.name, sport: ev.sport, startDate: ev.starts_on, endDate: ev.ends_on, url,
        eventStatus: ev.status === 'cancelled' ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled', ...(ev.city ? { location: { '@type': 'Place', name: ev.city } } : {}) }).replace(/</g, '\\u003c')}</script>` : '';
      const app = card.app_url;
      robots(res, indexable);
      res.set('Cache-Control', indexable ? 'public, max-age=60' : 'no-store');
      res.type('html').send(`${head({ ...card, image_url }, url, indexable, ld)}<body><main>
<p class="k">${esc(card.kicker)}</p><h1>${esc(ev.name)}</h1><span class="pill ${card.state === 'live' ? 'live' : ''}">${esc(card.label)}</span>
<p>${card.lines.map(esc).join('<br>')}</p>${ev.description ? `<p>${esc(ev.description)}</p>` : ''}
${table.rows.length ? `<h2>Table <span class="pill ${table.label === 'final' ? '' : 'prov'}">${table.label === 'final' ? 'Final' : 'Provisional'}</span></h2><table><thead><tr><th>#</th><th>Team</th><th class="n">P</th><th class="n">GD</th><th class="n">Pts</th></tr></thead><tbody>${table.rows.map((t) => `<tr><td>${t.rank}</td><td>${esc(t.name)}</td><td class="n">${t.played}</td><td class="n">${t.goal_diff}</td><td class="n">${t.points}</td></tr>`).join('')}</tbody></table>` : ''}
${games.length ? `<h2>Games</h2>${games.map(gameRow).join('')}` : ''}
${youth ? '<p class="k">Players are not named on youth events.</p>' : ''}
${app ? `<a class="btn" href="${esc(app)}">Open in the app</a>` : ''}</main></body></html>`);
    } catch (e) { fail(res, e); }
  });

  r.get('/share/fixtures/:id', async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) return page404(res);
      const { f, ev } = await loadViewableFixture(null, req.params.id);
      const card = await buildCard('fixture', f.id);
      const indexable = false; // single games are shared, not indexed
      const { url, image_url } = selfUrls(req, 'fixtures', f.id, card);
      const [g] = await publicFixtures(ev.id, { ids: [f.id], limit: 1 });
      robots(res, indexable);
      res.set('Cache-Control', 'no-store');
      res.type('html').send(`${head({ ...card, image_url }, url, indexable)}<body><main><p class="k">${esc(card.kicker)}</p><h1>${esc(card.title)}</h1>
<span class="pill ${card.state === 'live' ? 'live' : card.state === 'provisional' ? 'prov' : ''}">${esc(card.label)}</span><p>${card.lines.map(esc).join('<br>')}</p>${gameRow(g)}
${card.app_url ? `<a class="btn" href="${esc(card.app_url)}">Open the live centre</a>` : ''}</main></body></html>`);
    } catch (e) { fail(res, e); }
  });

  r.get('/share/awards/:id', async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) return page404(res);
      const card = await buildCard('award', req.params.id);
      const { url, image_url } = selfUrls(req, 'awards', req.params.id, card);
      robots(res, false);
      res.set('Cache-Control', 'no-store');
      res.type('html').send(`${head({ ...card, image_url }, url, false)}<body><main><p class="k">${esc(card.kicker)}</p><h1>${esc(card.title)}</h1><p>${card.lines.map(esc).join('<br>')}</p>${card.app_url ? `<a class="btn" href="${esc(card.app_url)}">Open the event</a>` : ''}</main></body></html>`);
    } catch (e) { fail(res, e); }
  });

  r.get(/^\/share\/cards\/([a-z]+)\/([0-9a-f-]{36})\.svg$/, async (req, res) => {
    try {
      const card = await buildCard(req.params[0], req.params[1]);
      robots(res, false);
      res.set('Cache-Control', 'public, max-age=30').type('image/svg+xml').send(cardSvg(card));
    } catch (e) { fail(res, e); }
  });

  r.get('/share/sitemap.xml', async (req, res) => {
    try {
      const rows = await many(
        `SELECT id, coalesce(ends_on, starts_on, created_at::date) AS lastmod FROM events
          WHERE public_visibility='public' AND public_indexable AND status <> 'draft' AND archived_at IS NULL AND (max_age IS NULL OR max_age >= 18) ORDER BY created_at DESC LIMIT 5000`);
      const origin = `${req.protocol}://${req.get('host')}`;
      res.set('Cache-Control', 'public, max-age=300').type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map((x) => `<url><loc>${esc(`${origin}/api/v1/share/events/${x.id}`)}</loc><lastmod>${new Date(x.lastmod).toISOString().slice(0, 10)}</lastmod></url>`).join('')}</urlset>`);
    } catch (e) { fail(res, e); }
  });
  return r;
}

