// Sports Media, Broadcast & Rights (#482) 4/4: data-feed rights and the reports. A feed grant is an entitlement on a licence with a real API credential behind it
// (an api_tokens row limited to the one event, issued by the partner itself so the secret is shown only to them). The feed endpoints read the CANONICAL fixtures, live
// state, published score sheets and standings; nothing is copied into a media database. Every call re-checks the grant, the licence, the dates and the quota, so revoking
// or expiring a right stops every credential on every surface (REST, OpenAPI clients and MCP) on the very next request.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { newOpaqueToken, sha256 } from '../crypto.js';
import { standings } from '../helpers.js';
import { liveState } from '../scoring/state.js';
import { notify } from '../notify.js';
import { RIGHTS, RIGHT_KEYS, IN_FORCE, LIC_STAGE, logMr, eventOf, isOrganiserOf, partnerFor, partnerAdmins, eventOrganisers, ASSET_COLS, assetState } from '../media-rights.js';

const TAG = 'Media data feeds';
const text = (n) => z.string().trim().max(n);
const dt = z.string().datetime({ offset: true });
const DATASETS = ['fixtures', 'live', 'results', 'standings'];
const DATASET_LABEL = { fixtures: 'Schedule & status', live: 'Live scores & events', results: 'Official results', standings: 'Standings' };

async function licenceSide(user, lid, c = pool) {
  const lic = (await c.query(`SELECT l.*, p.event_id, p.scope_kind, p.fixture_id, e.name AS event_name, ${IN_FORCE()} AS in_force FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN events e ON e.id=p.event_id JOIN media_partners m ON m.id=l.partner_id WHERE l.id=$1`, [lid])).rows[0];
  if (!lic) throw notFound('Licence');
  const ev = await eventOf(lic.event_id, c);
  const organiser = await isOrganiserOf(user, ev, c);
  let partner = null; try { partner = await partnerFor(user, lic.partner_id, { c }); } catch { /* not a member */ }
  if (!organiser && !partner) throw notFound('Licence');
  return { lic, ev, organiser, partner, partnerCanAct: !!partner && ['owner', 'admin', 'manager', 'legal', 'approver'].includes(partner.role) };
}
const FEED_VIEW = `g.id, g.licence_id, g.consumer_name, g.datasets, g.mode, g.delay_seconds, g.rate_per_minute, g.daily_quota, g.valid_from, g.valid_to, g.status, g.revoked_at, g.revoke_reason, (g.api_token_id IS NOT NULL) AS credential_issued,
  (g.status='active' AND g.valid_to > now()) AS usable, coalesce((SELECT sum(u.calls) FROM mr_feed_usage u WHERE u.grant_id=g.id AND u.day=current_date), 0)::int AS calls_today,
  coalesce((SELECT sum(u.calls) FROM mr_feed_usage u WHERE u.grant_id=g.id AND u.day > current_date - 30), 0)::int AS calls_30d, (SELECT max(u.last_at) FROM mr_feed_usage u WHERE u.grant_id=g.id) AS last_call_at`;

cap({
  name: 'grant_data_feed', method: 'POST', path: '/media/licences/:id/feeds', tag: TAG, status: 201,
  summary: 'Give a licensee data-feed access under a licence that carries the data-feed right: which datasets (schedule, live, official results, standings), live or delayed, a rate limit per minute, a daily quota, and an end date no later than the licence. Live datasets need live mode. The partner then issues its own credential; nothing is copied, the feed reads the official scoring and results. Organiser only.',
  input: z.object({ id, consumer_name: text(80).min(2), datasets: z.array(z.enum(DATASETS)).min(1).max(4), mode: z.enum(['live', 'delayed']).default('live'), delay_seconds: z.number().int().min(60).max(86400).default(900),
    rate_per_minute: z.number().int().min(1).max(6000).default(60), daily_quota: z.number().int().min(1).max(10_000_000).default(50000), valid_to: dt }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await licenceSide(user, i.id, c);
    if (!a.organiser) throw forbidden('Only the organiser can grant data-feed access');
    if (!a.lic.in_force) throw conflict('This licence is not in force');
    if (!a.lic.approved_rights.includes('data_feed')) throw badRequest('This licence does not carry the data-feed right', { code: 'no_data_feed_right' });
    if (a.lic.scope_kind === 'collection') throw badRequest('A data feed needs a licence for the competition or a game');
    if (i.mode === 'delayed' && i.datasets.some((d) => ['live', 'standings'].includes(d))) throw badRequest('Live scores and standings need live mode; a delayed feed gets the schedule and official results');
    if (new Date(i.valid_to) <= new Date()) throw badRequest('The end date must be in the future');
    if (new Date(i.valid_to) > new Date(a.lic.effective_to)) throw badRequest('A feed cannot outlast its licence');
    const row = (await c.query(
      'INSERT INTO mr_feed_grants(licence_id, consumer_name, datasets, mode, delay_seconds, rate_per_minute, daily_quota, valid_to, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [a.lic.id, i.consumer_name, [...new Set(i.datasets)], i.mode, i.mode === 'live' ? 0 : i.delay_seconds, i.rate_per_minute, i.daily_quota, i.valid_to, user.id])).rows[0];
    await logMr(c, a.lic.event_id, 'feed', row.id, 'granted', { actor: user.id, detail: { datasets: row.datasets, mode: row.mode, rate: row.rate_per_minute, valid_to: row.valid_to } });
    for (const uid of await partnerAdmins(c, a.lic.partner_id)) await notify(c, uid, { kind: 'media_feed_granted', title: 'Data feed ready', body: `${a.lic.event_name}: "${row.consumer_name}" can now be issued a credential.`, data: { feed_id: row.id, licence_id: a.lic.id }, dedupe_key: `mr-feed-granted:${row.id}:${uid}` });
    return (await c.query(`SELECT ${FEED_VIEW} FROM mr_feed_grants g WHERE g.id=$1`, [row.id])).rows[0];
  }),
});

cap({
  name: 'issue_feed_credential', method: 'POST', path: '/media/feeds/:id/credential', tag: TAG, status: 201,
  summary: 'Issue the API credential for a data feed. Only a partner member who can act for the partner can do this, and the secret is shown once, to them. The credential is a read token limited to this one event that expires with the feed; re-issuing revokes the previous one at once.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const g = (await c.query('SELECT * FROM mr_feed_grants WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!g) throw notFound('Data feed');
    const a = await licenceSide(user, g.licence_id, c);
    if (!a.partner || !a.partnerCanAct) throw a.organiser ? forbidden('The partner issues its own credential, so the secret is never shown to anyone else') : notFound('Data feed');
    if (g.status !== 'active' || new Date(g.valid_to) <= new Date()) throw conflict('This feed is no longer active');
    if (!a.lic.in_force) throw conflict('The licence is not in force');
    if (g.api_token_id) await c.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [g.api_token_id]);
    const token = newOpaqueToken();
    const expires = new Date(Math.min(new Date(g.valid_to).getTime(), new Date(a.lic.effective_to).getTime())).toISOString();
    const t = (await c.query('INSERT INTO api_tokens(user_id, name, token_hash, scopes, expires_at, resources) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [user.id, `Media feed: ${g.consumer_name}`.slice(0, 60), sha256(token), ['read'], expires, JSON.stringify([{ type: 'event', id: a.lic.event_id }])])).rows[0];
    await c.query('UPDATE mr_feed_grants SET api_token_id=$2, consumer_user_id=$3 WHERE id=$1', [g.id, t.id, user.id]);
    await logMr(c, a.lic.event_id, 'feed', g.id, g.api_token_id ? 'credential_reissued' : 'credential_issued', { actor: user.id });
    return { feed_id: g.id, token, token_id: t.id, expires_at: expires, event_id: a.lic.event_id, usage: `GET /api/v1/media/feed/events/${a.lic.event_id}/{dataset} with Authorization: Bearer <token>` };
  }),
});

cap({
  name: 'revoke_data_feed', method: 'POST', path: '/media/feeds/:id/revoke', tag: TAG,
  summary: 'End a data feed now. The organiser, or the partner, can. Its credential stops working on the next request on every surface (REST, OpenAPI clients, MCP); the usage history is kept.',
  input: z.object({ id, reason: text(500).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    const g = (await c.query('SELECT * FROM mr_feed_grants WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!g) throw notFound('Data feed');
    const a = await licenceSide(user, g.licence_id, c);
    if (!a.organiser && !a.partnerCanAct) throw forbidden('Your role cannot do that');
    if (g.status === 'revoked') return (await c.query(`SELECT ${FEED_VIEW} FROM mr_feed_grants g WHERE g.id=$1`, [g.id])).rows[0];
    await c.query("UPDATE mr_feed_grants SET status='revoked', revoked_at=now(), revoked_by=$2, revoke_reason=$3 WHERE id=$1", [g.id, user.id, i.reason]);
    if (g.api_token_id) await c.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [g.api_token_id]);
    await logMr(c, a.lic.event_id, 'feed', g.id, 'revoked', { actor: user.id, detail: { reason: i.reason } });
    const them = a.organiser ? await partnerAdmins(c, a.lic.partner_id) : await eventOrganisers(c, a.ev);
    for (const uid of new Set(them)) if (uid !== user.id) await notify(c, uid, { kind: 'media_feed_revoked', title: 'Data feed ended', body: `${a.lic.event_name}: "${g.consumer_name}" was ended: ${i.reason}`, data: { feed_id: g.id }, dedupe_key: `mr-feed-revoked:${g.id}:${uid}` });
    return (await c.query(`SELECT ${FEED_VIEW} FROM mr_feed_grants g WHERE g.id=$1`, [g.id])).rows[0];
  }),
});

cap({
  name: 'list_data_feeds', method: 'GET', path: '/events/:id/media/feeds', tag: TAG,
  summary: 'The data feeds of an event with their limits, state and usage (calls today and in 30 days, last call). Never includes secrets. Organiser only; partners see theirs in the workspace.',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (!(await isOrganiserOf(user, await eventOf(i.id)))) throw forbidden('Only the organiser of this event can do that');
    return many(`SELECT ${FEED_VIEW}, o.name AS partner_name, l.licence_no FROM mr_feed_grants g JOIN mr_licences l ON l.id=g.licence_id JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id JOIN organisations o ON o.id=m.organisation_id WHERE p.event_id=$1 ORDER BY g.created_at DESC`, [i.id]);
  },
});

cap({
  name: 'get_feed_usage', method: 'GET', path: '/media/feeds/:id/usage', tag: TAG,
  summary: 'Audit and usage metrics of one data feed by day and dataset (calls served, calls refused) for the last 30 days. The organiser and the partner can read it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const g = await one('SELECT * FROM mr_feed_grants WHERE id=$1', [i.id]);
    if (!g) throw notFound('Data feed');
    await licenceSide(user, g.licence_id);
    return { feed: (await one(`SELECT ${FEED_VIEW} FROM mr_feed_grants g WHERE g.id=$1`, [g.id])), days: await many('SELECT day::text, dataset, calls, refused, last_at FROM mr_feed_usage WHERE grant_id=$1 AND day > current_date - 30 ORDER BY day DESC, dataset', [g.id]) };
  },
});

// ------------------------------------------------------------------ the feed itself
const refuse = () => forbidden('No data-feed right is active for this credential on this event');

/** The one grant that lets this caller read this dataset right now, or null. Everything is read live; nothing is cached. */
async function activeGrant(user, eventId, dataset, c = pool) {
  const cred = user.credential;
  const rows = (await c.query(
    `SELECT g.*, l.effective_to, p.scope_kind, p.fixture_id FROM mr_feed_grants g JOIN mr_licences l ON l.id=g.licence_id JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id
      WHERE p.event_id=$1 AND g.status='active' AND g.valid_from <= now() AND g.valid_to > now() AND $2 = ANY(g.datasets) AND ${IN_FORCE()} AND l.approved_rights @> ARRAY['data_feed']::text[]
        AND (CASE WHEN $3::uuid IS NOT NULL THEN g.api_token_id = $3 ELSE g.consumer_user_id = $4 END)
        AND EXISTS (SELECT 1 FROM organisation_members om WHERE om.organisation_id=m.organisation_id AND om.user_id=g.consumer_user_id AND om.status='active')
      ORDER BY g.valid_to DESC`, [eventId, dataset, cred?.type === 'api_token' ? cred.id : null, user.id])).rows;
  return rows[0] ?? null;
}
const bump = (c, gid, dataset, field) => c.query(
  `INSERT INTO mr_feed_usage(grant_id, day, dataset, ${field}, last_at) VALUES ($1, current_date, $2, 1, now())
   ON CONFLICT (grant_id, day, dataset) DO UPDATE SET ${field}=mr_feed_usage.${field}+1, last_at=now()`, [gid, dataset]);

/** Count the call against the minute window and the daily quota in one atomic step; refuse with 429 when either is spent. */
async function meter(g, dataset) {
  return tx(async (c) => {
    const w = (await c.query(
      `INSERT INTO mr_feed_windows(grant_id, window_start, calls) VALUES ($1, now(), 1)
       ON CONFLICT (grant_id) DO UPDATE SET window_start=CASE WHEN mr_feed_windows.window_start < now() - interval '1 minute' THEN now() ELSE mr_feed_windows.window_start END,
                                           calls=CASE WHEN mr_feed_windows.window_start < now() - interval '1 minute' THEN 1 ELSE mr_feed_windows.calls+1 END RETURNING calls`, [g.id])).rows[0];
    const today = Number((await c.query('SELECT coalesce(sum(calls),0) AS n FROM mr_feed_usage WHERE grant_id=$1 AND day=current_date', [g.id])).rows[0].n);
    if (w.calls > g.rate_per_minute || today >= g.daily_quota) {
      await bump(c, g.id, dataset, 'refused');
      return { limited: w.calls > g.rate_per_minute ? 'rate' : 'quota' };
    }
    await bump(c, g.id, dataset, 'calls');
    return { limited: null };
  });
}

cap({
  name: 'get_media_feed', method: 'GET', path: '/media/feed/events/:event_id/:dataset', tag: TAG,
  summary: 'The licensed data feed of an event: `fixtures` (schedule and status), `live` (score, phase and recent events of games in play), `results` (official published results) or `standings`. Authenticate with the feed credential (or, to try it, as the partner member it was issued to). The grant, licence, dates, dataset, delay, rate limit and daily quota are checked on every request, so a revoked or expired right stops here immediately. Individual players and rosters are never part of it.',
  input: z.object({ event_id: id, dataset: z.enum(DATASETS), fixture_id: id.optional() }),
  async handler({ user }, i) {
    const g = await activeGrant(user, i.event_id, i.dataset);
    if (!g) throw refuse();
    if (g.scope_kind === 'fixture' && i.fixture_id && i.fixture_id !== g.fixture_id) throw refuse();
    const m = await meter(g, i.dataset);
    if (m.limited) throw new AppError(429, 'rate_limited', m.limited === 'rate' ? `Rate limit of ${g.rate_per_minute} calls a minute reached` : `Daily quota of ${g.daily_quota} calls reached`, { limit: m.limited });
    const only = g.scope_kind === 'fixture' ? g.fixture_id : (i.fixture_id ?? null);
    const ev = await eventOf(i.event_id);
    if (ev.status === 'draft') throw refuse();
    let data;
    if (i.dataset === 'fixtures') {
      data = await many(`SELECT f.id, f.round, f.round_kind, f.scheduled_at, f.status, h.id AS home_id, h.name AS home_name, a.id AS away_id, a.name AS away_name FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
        WHERE f.event_id=$1 AND ($2::uuid IS NULL OR f.id=$2) ORDER BY f.scheduled_at LIMIT 1000`, [i.event_id, only]);
    } else if (i.dataset === 'live') {
      const ids = (await many("SELECT id FROM fixtures WHERE event_id=$1 AND ($2::uuid IS NULL OR id=$2) AND status IN ('live','paused','finished') ORDER BY started_at NULLS LAST, scheduled_at", [i.event_id, only])).map((r) => r.id);
      data = (await Promise.all(ids.map((fid) => liveState(fid, null, { limit: 20 })))).map((s) => ({
        fixture: { id: s.fixture.id, status: s.fixture.status, round: s.fixture.round, scheduled_at: s.fixture.scheduled_at, home: s.fixture.home && { id: s.fixture.home.id, name: s.fixture.home.name }, away: s.fixture.away && { id: s.fixture.away.id, name: s.fixture.away.name } },
        score: s.score, phase: s.phase, last_seq: s.last_seq, events: s.events.map((e) => ({ seq: e.seq, kind: e.kind, side: e.side, period: e.period, clock_seconds: e.clock_seconds })) }));   // no player identities
    } else if (i.dataset === 'results') {
      data = await many(`SELECT s.fixture_id, s.version, s.home_score, s.away_score, s.winner_team_id, s.totals, s.published_at, f.round, f.scheduled_at, h.name AS home_name, a.name AS away_name
        FROM score_sheets s JOIN fixtures f ON f.id=s.fixture_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
        WHERE s.event_id=$1 AND s.status='published' AND ($2::uuid IS NULL OR s.fixture_id=$2) AND s.published_at <= now() - make_interval(secs => $3) ORDER BY f.scheduled_at, s.published_at`, [i.event_id, only, g.delay_seconds]);
    } else {
      data = await standings(i.event_id);
    }
    return { dataset: i.dataset, event_id: i.event_id, grant: { id: g.id, mode: g.mode, delay_seconds: g.delay_seconds, valid_to: g.valid_to }, generated_at: new Date().toISOString(), source: 'SportArena official scoring and results', data };
  },
});

// ------------------------------------------------------------------ reports (organiser)
const REPORTS = ['rights_inventory', 'expiring', 'partner_coverage', 'production_readiness', 'published_assets', 'embargo_takedown', 'revenue'];
cap({
  name: 'get_media_report', method: 'GET', path: '/events/:id/media/reports/:report', tag: TAG,
  summary: 'Organiser reports: `rights_inventory` (what is offered, licensed and still unsold), `expiring` (licences and feeds ending soon), `partner_coverage` (per partner: rights, games covered, crew, streams, assets), `production_readiness` (per upcoming game: crew confirmed and badged, run sheet, stream, open incidents), `published_assets` (by right and state), `embargo_takedown` (what is embargoed, expired, withdrawn, taken down or blocked by consent) and `revenue` (contracted, invoiced, collected online or offline, outstanding, overdue and refunded rights fees, one line per currency).',
  input: z.object({ id, report: z.enum(REPORTS), days: z.coerce.number().int().min(1).max(365).default(60) }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    if (!(await isOrganiserOf(user, ev))) throw forbidden('Only the organiser of this event can do that');
    const q = (sql, args = [i.id]) => many(sql, args);
    let data;
    if (i.report === 'rights_inventory') {
      const pk = await q(`SELECT p.id, p.name, p.scope_kind, p.status, p.rights, p.exclusivity, p.valid_from, p.valid_to, (SELECT count(*)::int FROM mr_licences l WHERE l.package_id=p.id AND l.stage='active' AND l.effective_to > now()) AS active_licences,
        (SELECT count(*)::int FROM mr_licences l WHERE l.package_id=p.id AND l.stage IN ('proposed','negotiating')) AS open_proposals FROM mr_packages p WHERE p.event_id=$1 AND p.status <> 'withdrawn' ORDER BY p.created_at`);
      const matrix = RIGHT_KEYS.map((r) => {
        const offered = pk.filter((p) => p.rights.includes(r));
        return { right: r, label: RIGHTS[r], packages: offered.length, licensed: offered.filter((p) => p.active_licences > 0).length, unlicensed: offered.filter((p) => p.active_licences === 0 && p.status === 'open').length };
      }).filter((x) => x.packages > 0);
      data = { packages: pk, rights: matrix };
    } else if (i.report === 'expiring') {
      data = {
        days: i.days,
        licences: await q(`SELECT l.id, l.licence_no, l.effective_to, ceil(extract(epoch FROM (l.effective_to - now())) / 86400)::int AS days_left, o.name AS partner_name, l.approved_rights FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id JOIN organisations o ON o.id=m.organisation_id
          WHERE p.event_id=$1 AND l.stage='active' AND l.effective_to > now() AND l.effective_to < now() + make_interval(days => $2) ORDER BY l.effective_to`, [i.id, i.days]),
        feeds: await q(`SELECT g.id, g.consumer_name, g.valid_to, o.name AS partner_name FROM mr_feed_grants g JOIN mr_licences l ON l.id=g.licence_id JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id JOIN organisations o ON o.id=m.organisation_id
          WHERE p.event_id=$1 AND g.status='active' AND g.valid_to > now() AND g.valid_to < now() + make_interval(days => $2) ORDER BY g.valid_to`, [i.id, i.days]),
      };
    } else if (i.report === 'partner_coverage') {
      data = await q(`SELECT m.id AS partner_id, o.name, m.kind, count(DISTINCT l.id) FILTER (WHERE ${IN_FORCE()})::int AS licences_in_force, count(DISTINCT l.id)::int AS licences_total,
          coalesce(array_agg(DISTINCT r) FILTER (WHERE ${IN_FORCE()} AND r IS NOT NULL), '{}') AS rights,
          CASE WHEN bool_or(${IN_FORCE()} AND p.scope_kind <> 'fixture') THEN (SELECT count(*) FROM fixtures f WHERE f.event_id=$1 AND f.status <> 'cancelled')::int ELSE count(DISTINCT p.fixture_id) FILTER (WHERE ${IN_FORCE()})::int END AS games_covered,
          (SELECT count(*)::int FROM mr_crew c JOIN mr_licences l2 ON l2.id=c.licence_id WHERE l2.partner_id=m.id AND c.event_id=$1 AND c.status IN ('assigned','acknowledged')) AS crew,
          (SELECT count(*)::int FROM mr_streams s JOIN mr_licences l2 ON l2.id=s.licence_id WHERE l2.partner_id=m.id AND s.event_id=$1 AND s.status='active') AS streams,
          (SELECT count(*)::int FROM mr_assets a WHERE a.owner_partner_id=m.id AND a.event_id=$1 AND a.status='published') AS assets_published
        FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id JOIN organisations o ON o.id=m.organisation_id LEFT JOIN LATERAL unnest(l.approved_rights) r ON true
       WHERE p.event_id=$1 GROUP BY m.id, o.name, m.kind ORDER BY o.name`);
    } else if (i.report === 'production_readiness') {
      const games = await q(`SELECT f.id, f.scheduled_at, f.status, f.round, h.name AS home_name, a.name AS away_name,
          (SELECT count(*)::int FROM mr_crew c WHERE c.event_id=f.event_id AND (c.fixture_id=f.id OR c.fixture_id IS NULL) AND c.status IN ('assigned','acknowledged')) AS crew,
          (SELECT count(*)::int FROM mr_crew c WHERE c.event_id=f.event_id AND (c.fixture_id=f.id OR c.fixture_id IS NULL) AND c.status='acknowledged') AS confirmed,
          (SELECT count(*)::int FROM mr_crew c JOIN event_department_members dm ON dm.id=c.department_member_id WHERE c.event_id=f.event_id AND (c.fixture_id=f.id OR c.fixture_id IS NULL) AND c.status IN ('assigned','acknowledged') AND dm.accreditation='issued') AS badged,
          (SELECT count(*)::int FROM mr_run_items r WHERE r.event_id=f.event_id AND (r.fixture_id=f.id OR r.fixture_id IS NULL) AND r.status <> 'cancelled') AS run_items,
          (SELECT count(*)::int FROM mr_streams s WHERE s.event_id=f.event_id AND (s.fixture_id=f.id OR s.fixture_id IS NULL) AND s.status='active') AS streams,
          (SELECT count(*)::int FROM mr_incidents n WHERE n.event_id=f.event_id AND (n.fixture_id=f.id OR n.fixture_id IS NULL) AND n.status='open') AS open_incidents
        FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.event_id=$1 AND f.status IN ('scheduled','live','paused') ORDER BY f.scheduled_at LIMIT 300`);
      data = games.map((g) => ({ ...g, readiness: g.crew === 0 && g.run_items === 0 && g.streams === 0 ? 'not_started' : g.crew > 0 && g.confirmed === g.crew && g.badged === g.crew && g.run_items > 0 && g.open_incidents === 0 ? 'ready' : 'attention' }));
    } else if (i.report === 'published_assets') {
      const rows = await q(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.event_id=$1 AND a.status <> 'draft' ORDER BY a.created_at DESC LIMIT 1000`);
      const by = {};
      for (const a of rows) { const st = await assetState(a); const k = `${a.right_kind}|${st}`; by[k] = (by[k] ?? 0) + 1; }
      data = { total: rows.length, groups: Object.entries(by).map(([k, n]) => ({ right: k.split('|')[0], state: k.split('|')[1], count: n })).sort((x, y) => y.count - x.count) };
    } else if (i.report === 'embargo_takedown') {
      const rows = await q(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.event_id=$1 ORDER BY a.updated_at DESC LIMIT 1000`);
      const out = [];
      for (const a of rows) { const st = await assetState(a); if (['embargoed', 'scheduled', 'expired', 'withdrawn', 'taken_down', 'consent_lapsed', 'source_withdrawn'].includes(st)) out.push({ id: a.id, title: a.title, right_kind: a.right_kind, state: st, embargo_until: a.embargo_until, expires_at: a.expires_at, status_reason: a.status_reason, status_changed_at: a.status_changed_at }); }
      data = out.slice(0, 300);
    } else {
      const rows = await q(`SELECT l.currency, ${LIC_STAGE('l')} AS stage, count(*)::int AS licences, sum(l.fee_minor)::bigint AS fee_minor FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id WHERE p.event_id=$1 AND l.stage NOT IN ('declined') GROUP BY l.currency, ${LIC_STAGE('l')} ORDER BY l.currency`);
      const fees = await q(`SELECT f.currency, f.status, f.paid_method, count(*)::int AS n, sum(f.amount_minor)::bigint AS amount_minor, sum(f.amount_minor) FILTER (WHERE f.status='awaiting_payment' AND f.due_on < current_date)::bigint AS overdue_minor
        FROM mr_fees f JOIN mr_licences l ON l.id=f.licence_id JOIN mr_packages p ON p.id=l.package_id WHERE p.event_id=$1 GROUP BY f.currency, f.status, f.paid_method`);
      const cur = [...new Set([...rows.map((r) => r.currency), ...fees.map((r) => r.currency)])].sort().map((currency) => {
        const of = (...st) => rows.filter((r) => r.currency === currency && st.includes(r.stage)).reduce((t, r) => t + Number(r.fee_minor), 0);
        const fe = (st, pred = () => true) => fees.filter((r) => r.currency === currency && st.includes(r.status) && pred(r)).reduce((t, r) => t + Number(r.amount_minor), 0);
        const contracted = of('active', 'suspended', 'expired');
        return { currency, contracted_minor: contracted, pending_minor: of('proposed', 'negotiating'), terminated_minor: of('terminated'), licences: rows.filter((r) => r.currency === currency).reduce((t, r) => t + r.licences, 0),
          invoiced_minor: fe(['awaiting_payment', 'paid', 'refunded']), collected_minor: fe(['paid']), collected_online_minor: fe(['paid'], (r) => r.paid_method === 'online'), collected_offline_minor: fe(['paid'], (r) => r.paid_method === 'offline'),
          outstanding_minor: fe(['awaiting_payment']), overdue_minor: fees.filter((r) => r.currency === currency).reduce((t, r) => t + Number(r.overdue_minor ?? 0), 0), refunded_minor: fe(['refunded']), not_yet_invoiced_minor: Math.max(0, contracted - fe(['awaiting_payment', 'paid', 'refunded'])) };
      });
      data = { currencies: cur, note: 'Contracted is the agreed fee on active, suspended or lapsed licences; pending is still being negotiated. Invoiced, collected (online or recorded as received outside the platform), outstanding and refunded come from the fees raised against those licences. Each currency stands alone and is never converted or added to another.' };
    }
    return { report: i.report, event_id: i.id, generated_at: new Date().toISOString(), data };
  },
});
