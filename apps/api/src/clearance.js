// Fit-to-play projection (issue #212, slice 3a). Combines structured decisions (clinical_clearances) with the legacy medical_records.clearance:
// whichever is more recent for the question asked wins, so an old "cleared" can never mask a newer "not_cleared" from either source.
// Structured decisions can expire; once past `valid_until` the status is `expired`, never a stale "cleared". The projection never contains
// diagnosis, notes or the doctor's private text - only status, validity, review date and the restrictions the doctor chose to share.
import { many, one } from './db.js';
import { decrypt } from './crypto.js';

const RANK = { not_cleared: 3, restricted: 2, cleared: 1 };

export async function currentClearance(athleteId, { sportId = null } = {}) {
  const rows = await many(
    `SELECT id, sport_id, activity, status, restrictions_enc, assessed_on, valid_until, review_by, created_at, (valid_until IS NOT NULL AND valid_until < current_date) AS expired,
            (review_by IS NOT NULL AND review_by < current_date) AS review_due
       FROM clinical_clearances WHERE athlete_id=$1 AND superseded_at IS NULL AND withdrawn_at IS NULL AND ($2::uuid IS NULL OR sport_id IS NULL OR sport_id=$2) ORDER BY created_at DESC, id`, [athleteId, sportId]);
  const live = rows.filter((r) => !r.expired);
  const legacy = await one('SELECT clearance, created_at FROM medical_records WHERE athlete_id=$1 AND clearance IS NOT NULL ORDER BY created_at DESC LIMIT 1', [athleteId]);
  const newest = rows[0]?.created_at ?? null;
  const decisions = (arr) => arr.map((r) => ({ id: r.id, sport_id: r.sport_id, activity: r.activity, status: r.status, assessed_on: r.assessed_on, valid_until: r.valid_until, review_due: r.review_due,
    restrictions: r.restrictions_enc ? JSON.parse(decrypt(r.restrictions_enc, 'clinical_clearances.restrictions')) : [] }));
  // a legacy record newer than every structured decision is the latest word
  if (legacy && (!newest || legacy.created_at > newest)) return { status: legacy.clearance, as_of: legacy.created_at, valid_until: null, review_due: false, restrictions: [], decisions: [], source: 'record' };
  if (!rows.length) return { status: 'unknown', as_of: null, valid_until: null, review_due: false, restrictions: [], decisions: [], source: 'none' };
  if (!live.length) return { status: 'expired', as_of: rows[0].created_at, valid_until: rows[0].valid_until, review_due: true, restrictions: [], decisions: decisions(rows), source: 'decision' };
  const worst = live.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
  return { status: worst.status, as_of: worst.created_at, valid_until: live.map((r) => r.valid_until).filter(Boolean).sort()[0] ?? null, review_due: live.some((r) => r.review_due),
    restrictions: decisions(live).flatMap((d) => d.restrictions), decisions: decisions(live), source: 'decision' };
}
