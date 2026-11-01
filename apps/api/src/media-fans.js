// Fan side of the media rights (#590): the people who follow an event, a team, a game or an athlete are told once when a public asset goes live, and can see
// the public media of what they follow. Only what the rights engine says is live, public and worldwide is ever shown (the same rule as the public event page).
// Following grants nothing private. Young people's events and private events never feed fan alerts.
import { many, tx } from './db.js';
import { notify } from './notify.js';
import { ASSET_COLS, assetState } from './media-rights.js';
import { NOT_YOUTH_SQL } from './youth.js';

const YOUTH_AGE = 18;
const PUBLIC_PLATFORMS = "ARRAY['web','mobile_app','social']::text[]";
const linkOf = (a) => (a.source_kind === 'upload' ? (a.stored_file ? `/api/v1/media/assets/${a.id}/file` : null) : a.external_url);
const fanShape = (a, ev) => ({ id: a.id, kind: a.kind, right_kind: a.right_kind, title: a.title, caption: a.caption, credit: a.credit, fixture_id: a.fixture_id, content_type: a.content_type, link: linkOf(a), published_at: a.status_changed_at ?? a.created_at, event: { id: ev.id, name: ev.name, emoji: ev.banner_emoji } });

/** Followers (with the "media" alert switched on) of an asset's event, game, either team, or an adult shown in it. */
export async function followersOfAsset(c, a) {
  return (await c.query(
    `SELECT DISTINCT f.user_id FROM spectator_follows f
      WHERE f.removed_at IS NULL AND 'media' = ANY(f.alerts) AND (
            (f.subject_type='event' AND f.subject_id=$1)
         OR (f.subject_type='fixture' AND f.subject_id=$2)
         OR (f.subject_type='team' AND f.subject_id IN (SELECT t FROM fixtures x, unnest(ARRAY[x.home_team_id, x.away_team_id]) t WHERE x.id=$2 AND t IS NOT NULL
               UNION SELECT s.team_id FROM mr_asset_subjects s WHERE s.asset_id=$3 AND s.removed_at IS NULL AND s.team_id IS NOT NULL))
         OR (f.subject_type='athlete' AND f.subject_id IN (SELECT s.user_id FROM mr_asset_subjects s JOIN users u ON u.id=s.user_id WHERE s.asset_id=$3 AND s.removed_at IS NULL AND ${NOT_YOUTH_SQL})))`,
    [a.event_id, a.fixture_id, a.id])).rows.map((r) => r.user_id);
}

/** Tell the followers once. Claimed with a guarded update, so a retry, a second instance or a republish never alerts twice. Returns how many were told. */
export async function notifyAssetFollowers(c, a, state = null) {
  if (a.audience !== 'public' || a.status !== 'published') return 0;
  if ((state ?? await assetState(a, c)) !== 'live') return 0;
  const ev = (await c.query('SELECT id, name, public_visibility, max_age, status FROM events WHERE id=$1', [a.event_id])).rows[0];
  if (!ev || ev.public_visibility === 'private' || ev.status === 'draft' || (ev.max_age != null && ev.max_age < YOUTH_AGE)) return 0;
  if (a.territory_mode !== 'worldwide' || (a.platforms.length && !a.platforms.some((p) => ['web', 'mobile_app', 'social'].includes(p)))) return 0;
  const claimed = (await c.query('UPDATE mr_assets SET followers_notified_at=now() WHERE id=$1 AND followers_notified_at IS NULL RETURNING id', [a.id])).rowCount;
  if (!claimed) return 0;
  let n = 0;
  for (const uid of await followersOfAsset(c, a)) {
    await notify(c, uid, { kind: 'media_published', title: `New ${a.kind === 'photo' ? 'photo' : 'media'}: ${ev.name}`, body: a.title, data: { asset_id: a.id, event_id: ev.id, fixture_id: a.fixture_id }, dedupe_key: `mr-fan:${a.id}:${uid}` });
    n++;
  }
  return n;
}

/** Background pass for assets that went live later than they were published (scheduled, or an embargo lifting). */
export async function sendMediaFollowerAlerts(limit = 100) {
  let sent = 0;
  const due = await many(
    `SELECT a.id FROM mr_assets a WHERE a.status='published' AND a.audience='public' AND a.followers_notified_at IS NULL
        AND (a.publish_at IS NULL OR a.publish_at <= now()) AND (a.embargo_until IS NULL OR a.embargo_until <= now()) AND (a.expires_at IS NULL OR a.expires_at > now()) ORDER BY a.updated_at LIMIT $1`, [limit]);
  for (const d of due) {
    sent += await tx(async (c) => {
      await c.query('SELECT id FROM mr_assets WHERE id=$1 FOR UPDATE', [d.id]);
      const a = (await c.query(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.id=$1`, [d.id])).rows[0];
      return a.followers_notified_at ? 0 : notifyAssetFollowers(c, a);
    });
  }
  return sent;
}

/** The public media of everything a person follows, newest first. Same visibility rule as the event page: published, public, worldwide, live. */
export async function followedMedia(userId, { limit = 30 } = {}) {
  const rows = await many(
    `SELECT ${ASSET_COLS}, to_jsonb(e.*) AS ev FROM mr_assets a JOIN events e ON e.id=a.event_id
      WHERE a.audience='public' AND a.status='published' AND a.territory_mode='worldwide' AND (cardinality(a.platforms)=0 OR a.platforms && ${PUBLIC_PLATFORMS})
        AND e.public_visibility <> 'private' AND e.status <> 'draft' AND (e.max_age IS NULL OR e.max_age >= ${YOUTH_AGE}) AND EXISTS (
          SELECT 1 FROM spectator_follows f WHERE f.user_id=$1 AND f.removed_at IS NULL AND (
                (f.subject_type='event' AND f.subject_id=a.event_id)
             OR (f.subject_type='fixture' AND f.subject_id=a.fixture_id)
             OR (f.subject_type='team' AND (f.subject_id IN (SELECT t FROM fixtures x, unnest(ARRAY[x.home_team_id, x.away_team_id]) t WHERE x.id=a.fixture_id)
                  OR f.subject_id IN (SELECT s.team_id FROM mr_asset_subjects s WHERE s.asset_id=a.id AND s.removed_at IS NULL AND s.team_id IS NOT NULL)))
             OR (f.subject_type='athlete' AND f.subject_id IN (SELECT s.user_id FROM mr_asset_subjects s JOIN users u ON u.id=s.user_id WHERE s.asset_id=a.id AND s.removed_at IS NULL AND ${NOT_YOUTH_SQL}))))
      ORDER BY coalesce(a.status_changed_at, a.created_at) DESC LIMIT 200`, [userId]);
  const out = [];
  for (const a of rows) {
    if (out.length >= limit) break;
    if (await assetState(a) !== 'live' || !linkOf(a)) continue;
    out.push(fanShape(a, a.ev));
  }
  return out;
}
