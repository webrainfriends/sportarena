// Recruitment sections of the player passport (issue #312) and the one gate every shared read goes through.
// Nothing here is a snapshot: approval, consent, recipient, revocation and expiry are all re-checked on every request.
import { one, many } from './db.js';
import { decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { notFound } from './errors.js';
import { YOUTH_SQL } from './youth.js';

export const SECTION_FLAGS = ['show_matches', 'show_results', 'show_awards', 'show_credentials', 'show_career', 'show_video', 'show_references', 'show_preferences', 'show_availability', 'show_academic'];
export const scopeOf = (l) => Object.fromEntries(SECTION_FLAGS.map((k) => [k, !!l[k]]));
export const FULL_SCOPE = Object.fromEntries(SECTION_FLAGS.map((k) => [k, true]));

/** Does `coachId` currently coach `athleteId`: on a team together as coach/manager, or through an active hire, cohort or plan? */
export async function coachesAthlete(coachId, athleteId) {
  if (await one(`SELECT 1 FROM team_members v JOIN team_members a ON a.team_id=v.team_id
                  WHERE v.user_id=$1 AND a.user_id=$2 AND v.status='active' AND a.status='active' AND v.role IN ('coach','manager')`, [coachId, athleteId])) return true;
  const { RELATIONSHIP_SQL } = await import('./coaching.js');
  return !!(await one(`SELECT 1 FROM (${RELATIONSHIP_SQL}) r WHERE coach_id=$1 AND athlete_id=$2 LIMIT 1`, [coachId, athleteId]));
}

// a young athlete's link works only while a verified guardian's recruitment_sharing consent is in force
const CONSENT_OK = `(NOT EXISTS (SELECT 1 FROM users u WHERE u.id=l.user_id AND ${YOUTH_SQL})
  OR EXISTS (SELECT 1 FROM youth_consents c WHERE c.child_id=l.user_id AND c.purpose='recruitment_sharing' AND c.revoked_at IS NULL AND c.expires_at > now()
        AND EXISTS (SELECT 1 FROM guardian_links g WHERE g.guardian_id=c.granted_by AND g.child_id=c.child_id AND g.status='active' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()))))`;
const LIVE = `l.token_hash=$1 AND l.revoked_at IS NULL AND l.expires_at > now() AND (l.recipient_id IS NULL OR l.recipient_id=$2) AND ${CONSENT_OK}`;
const RET = `l.id, l.user_id, l.recipient_id, l.expires_at, ${SECTION_FLAGS.map((k) => `l.${k}`).join(', ')}`;

/** The single enforcement point. A wrong, expired, revoked, other-recipient or consent-withdrawn link all look the same (404). */
export async function openLink(tokenHash, viewer, kind = 'passport') {
  const args = [tokenHash, viewer?.id ?? null];
  const link = kind === 'passport' || kind === 'export'
    ? await one(`UPDATE passport_links l SET view_count=view_count+1, last_viewed_at=now() WHERE ${LIVE} RETURNING ${RET}`, args)
    : await one(`SELECT ${RET} FROM passport_links l WHERE ${LIVE}`, args);
  if (!link) throw notFound('Passport link');
  await many('INSERT INTO passport_link_views(link_id, viewer_id, kind) VALUES ($1,$2,$3)', [link.id, link.recipient_id ? viewer?.id ?? null : null, kind]);
  return link;
}

export async function recruitmentSections(userId, scope, { viewerId = null, token = null } = {}) {
  const [videos, references, preferences, availability, academic] = await Promise.all([
    scope.show_video ? many(
      `SELECT v.id, v.title, s.slug AS sport_slug, v.link_url, (v.file_name IS NOT NULL) AS has_file, v.reviewed_at, r.display_name AS approved_by
         FROM passport_videos v LEFT JOIN sports s ON s.id=v.sport_id LEFT JOIN users r ON r.id=v.reviewed_by
        WHERE v.user_id=$1 AND v.status='approved' AND v.removed_at IS NULL ORDER BY v.reviewed_at, v.id LIMIT 20`, [userId]) : null,
    scope.show_references ? many(
      `SELECT r.id, r.body, s.slug AS sport_slug, u.display_name AS coach_name, u.handle AS coach_handle, r.created_at
         FROM passport_references r JOIN users u ON u.id=r.coach_id LEFT JOIN sports s ON s.id=r.sport_id
        WHERE r.user_id=$1 AND r.status='approved' AND r.removed_at IS NULL ORDER BY r.created_at, r.id LIMIT 20`, [userId]) : null,
    scope.show_preferences ? one(`SELECT sport_slugs, levels, regions, open_to, open_to_contact, notes FROM recruitment_preferences WHERE user_id=$1`, [userId]) : null,
    scope.show_availability ? many(
      `SELECT id, kind, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date, weekdays, to_char(from_time,'HH24:MI') AS from_time, to_char(to_time,'HH24:MI') AS to_time, note
         FROM recruitment_availability WHERE user_id=$1 AND removed_at IS NULL AND to_date >= current_date ORDER BY from_date, id LIMIT 50`, [userId]) : null,
    scope.show_academic ? many(
      `SELECT id, kind, institution, to_char(period_from,'YYYY-MM-DD') AS period_from, to_char(period_to,'YYYY-MM-DD') AS period_to, summary_enc, (file_name IS NOT NULL) AS has_file, provenance
         FROM academic_evidence WHERE user_id=$1 AND removed_at IS NULL ORDER BY created_at, id LIMIT 20`, [userId]) : null,
  ]);
  const base = `/api/v1/passport/${encodeURIComponent(token ?? '')}`;
  const academicOut = academic?.map(({ summary_enc, ...a }) => ({ ...a, summary: summary_enc ? decrypt(summary_enc, 'academic_evidence.summary') : null, file_url: a.has_file ? (token ? `${base}/academic/${a.id}` : `/api/v1/academic-evidence/${a.id}/file`) : null }));
  if (academicOut?.length && viewerId !== userId) for (const a of academicOut) await audit(null, viewerId, 'read_passport_academic', 'academic_evidence', a.id);
  return {
    videos: videos?.map((v) => withEmbed({ ...v, file_url: v.has_file ? (token ? `${base}/video/${v.id}` : `/api/v1/passport-videos/${v.id}/file`) : null })) ?? null,
    references,
    preferences: scope.show_preferences ? preferences ?? { sport_slugs: [], levels: [], regions: [], open_to: [], open_to_contact: false, notes: null } : null,
    availability,
    academic: academicOut ?? null,
  };
}

/** Linked videos are limited to YouTube and Vimeo, so they can be played inside the app. Returns null for any other address. */
export function videoEmbed(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^(www|m)\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const yt = /^[\w-]{11}$/;
  let m;
  if (host === 'youtu.be' && yt.test(seg[0] ?? '')) m = seg[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch' && yt.test(u.searchParams.get('v') ?? '')) m = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live'].includes(seg[0]) && yt.test(seg[1] ?? '')) m = seg[1];
  }
  if (m) return { provider: 'youtube', embed_url: `https://www.youtube-nocookie.com/embed/${m}` };
  const vid = host === 'player.vimeo.com' ? (seg[0] === 'video' ? seg[1] : null) : host === 'vimeo.com' ? seg.find((x) => /^\d+$/.test(x)) : null;
  if (vid && /^\d{5,12}$/.test(vid)) return { provider: 'vimeo', embed_url: `https://player.vimeo.com/video/${vid}` };
  return null;
}
export const withEmbed = (v) => ({ ...v, embed_url: v.link_url ? videoEmbed(v.link_url)?.embed_url ?? null : null });
