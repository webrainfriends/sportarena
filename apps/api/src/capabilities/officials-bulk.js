// Officials Bulk Assignment — Issue #1005 (R13)
// Eight capabilities: pool availability query, auto-suggest with scored explanation,
// shortlist add/remove, bulk invite, swap, bulk reschedule impact preview, bulk reschedule confirm.
// All extend the existing officials.js single-invite flow; no finance tables are duplicated.
import { z } from 'zod';
import { cap, id, page, money as moneySchema } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, hasRole, audit } from '../helpers.js';
import { notify } from '../notify.js';
import { OFFICIAL_ROLES, lockOfficial, assertOfficialEligible, recordHistory, credentialFor, closeOfficial, recordClashException } from '../officials.js';
import { eventForOrganizer, inviteOfficial } from './events.js';

const role = z.enum(OFFICIAL_ROLES);

// ─── helpers ────────────────────────────────────────────────────────────────

async function eventForOrganizerOrAdmin(user, eventId, c) {
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) throw notFound('event');
  if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Only the event organiser can manage assignments');
  return ev;
}

async function lockedFixture(c, fixtureId) {
  return (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [fixtureId])).rows[0];
}

/** Compute a 0–100 match score for one official against one fixture slot. */
async function scoreOfficial(c, { userId, role: roleVal, fixture, event, minGradeRank = 0 }) {
  let score = 0;
  const reasons = {};

  // 1. Grade (max 30) ─────────────────────────────────────────────────────────
  const cred = await credentialFor(c, userId, event.sport_id);
  let gradeScore = 0;
  if (cred.licence) {
    const excess = cred.licence.grade_rank - minGradeRank;
    gradeScore = excess >= 2 ? 30 : excess === 1 ? 25 : 20;
    reasons.grade = { label: `${cred.licence.name} (grade rank ${cred.licence.grade_rank})`, score: gradeScore };
  } else if (roleVal === 'scorer') {
    gradeScore = 15;
    reasons.grade = { label: 'No licence required for scorer', score: gradeScore };
  } else {
    reasons.grade = { label: 'No active licence found', score: 0 };
  }
  score += gradeScore;

  // 2. Travel distance (max 24) ───────────────────────────────────────────────
  let travelScore = 12; // default: unknown distance, give partial credit
  const userLoc = (await c.query('SELECT base_lat, base_lng FROM sport_profiles WHERE user_id=$1 AND base_lat IS NOT NULL LIMIT 1', [userId])).rows[0];
  const venLoc = fixture.venue_id
    ? (await c.query('SELECT lat, lng FROM venues WHERE id=$1', [fixture.venue_id])).rows[0]
    : null;
  let distKm = null;
  if (userLoc && venLoc) {
    const R = 6371;
    const dLat = ((venLoc.lat - userLoc.base_lat) * Math.PI) / 180;
    const dLon = ((venLoc.lng - userLoc.base_lng) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((userLoc.base_lat * Math.PI) / 180) * Math.cos((venLoc.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    distKm = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    travelScore = distKm < 50 ? 24 : distKm < 100 ? 18 : distKm < 200 ? 12 : distKm < 400 ? 6 : 2;
    reasons.travel = { label: `${distKm} km from home base`, score: travelScore, dist_km: distKm };
  } else {
    reasons.travel = { label: 'Distance unknown', score: travelScore };
  }
  score += travelScore;

  // 3. Neutrality (max 20) ────────────────────────────────────────────────────
  let neutralScore = 20;
  const userNat = (await c.query("SELECT nationality FROM users WHERE id=$1", [userId])).rows[0]?.nationality;
  if (userNat && fixture.home_team_id && fixture.away_team_id) {
    const teamNats = await c.query(
      `SELECT DISTINCT unnest(nationalities) AS nat FROM team_members WHERE team_id = ANY($1::uuid[]) AND status='active'`,
      [[fixture.home_team_id, fixture.away_team_id]]
    );
    const conflict = teamNats.rows.some((r) => r.nat === userNat);
    if (conflict) { neutralScore = 0; reasons.neutral = { label: 'Nationality matches a player', score: 0, conflict: true }; }
    else reasons.neutral = { label: 'Neutral — no nationality match', score: 20 };
  } else {
    reasons.neutral = { label: 'Neutrality unchecked (data unavailable)', score: neutralScore };
  }
  score += neutralScore;

  // 4. Fair rotation (max 14) — fewer assignments this event = higher score ──
  const assignCount = (await c.query(
    `SELECT count(*) FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id
      WHERE fo.user_id=$1 AND f.event_id=$2 AND fo.status IN ('invited','accepted','completed')`,
    [userId, event.id]
  )).rows[0].count;
  const rotScore = assignCount == 0 ? 14 : assignCount == 1 ? 12 : assignCount == 2 ? 9 : assignCount <= 4 ? 6 : 2;
  reasons.rotation = { label: `${assignCount} assignment(s) in this event`, score: rotScore, count: Number(assignCount) };
  score += rotScore;

  // 5. Cost (max 8) — cheaper = more points ─────────────────────────────────
  let costScore = 4; // neutral default
  const marketplace = (await c.query(
    `SELECT hourly_rate_cents FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 AND hourly_rate_cents IS NOT NULL LIMIT 1`,
    [userId, event.sport_id]
  )).rows[0];
  if (marketplace) {
    const budget = event.official_fee_budget_minor;
    if (!budget) costScore = 4;
    else costScore = marketplace.hourly_rate_cents <= budget ? 8 : marketplace.hourly_rate_cents <= budget * 1.2 ? 4 : 1;
    reasons.cost = { label: `Fee ~${marketplace.hourly_rate_cents} minor units`, score: costScore };
  } else {
    reasons.cost = { label: 'No rate on file', score: costScore };
  }
  score += costScore;

  // 6. Availability (max 4) ──────────────────────────────────────────────────
  let availScore = 0;
  if (fixture.scheduled_at) {
    const start = new Date(fixture.scheduled_at).toISOString();
    const end = new Date(new Date(fixture.scheduled_at).getTime() + (fixture.duration_min ?? 90) * 60000).toISOString();
    const blackout = await c.query(
      `SELECT 1 FROM official_availability WHERE user_id=$1 AND kind='blackout' AND archived_at IS NULL AND starts_at < $3 AND ends_at > $2 LIMIT 1`,
      [userId, start, end]
    );
    const avail = await c.query(
      `SELECT 1 FROM official_availability WHERE user_id=$1 AND kind='available' AND archived_at IS NULL AND starts_at <= $2 AND ends_at >= $3 LIMIT 1`,
      [userId, start, end]
    );
    if (blackout.rowCount) { availScore = 0; reasons.availability = { label: 'Marked as unavailable', score: 0 }; }
    else if (avail.rowCount) { availScore = 4; reasons.availability = { label: 'Explicitly available', score: 4 }; }
    else { availScore = 2; reasons.availability = { label: 'No explicit availability set', score: 2 }; }
  } else {
    availScore = 2; reasons.availability = { label: 'Fixture not yet scheduled', score: 2 };
  }
  score += availScore;

  return {
    score,
    score_grade: gradeScore,
    score_travel: travelScore,
    score_neutral: neutralScore,
    score_rotation: rotScore,
    score_cost: costScore,
    score_avail: availScore,
    reasons,
    dist_km: distKm,
    has_conflict: reasons.neutral?.conflict ?? false,
    grade_rank: cred.licence?.grade_rank ?? null,
    grade_name: cred.licence?.name ?? null,
  };
}

// ─── 1. Event official pool availability ────────────────────────────────────

cap({
  name: 'list_event_official_pool',
  method: 'GET',
  path: '/events/:id/officials/pool',
  tag: 'Officials',
  summary: 'Returns officials in the platform pool who are eligible for the given event sport, with their availability for each day of the event. Organisers only.',
  input: z.object({
    id,
    role: role.optional(),
    date: z.string().optional().describe('ISO date YYYY-MM-DD to filter to officials available on that day'),
    min_grade_rank: z.coerce.number().int().min(0).max(10).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const ev = await one('SELECT * FROM events WHERE id=$1', [i.id]);
    if (!ev) throw notFound('event');
    if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Organisers only');

    const rows = await many(
      `SELECT DISTINCT u.id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color,
              sp.base_lat, sp.base_lng, sp.base_city, sp.hourly_rate_cents,
              fl.grade_rank, fl.name AS grade_name, fl.grade AS grade_code,
              vc.expires_at AS verification_expires_at,
              (SELECT count(*) FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id
                WHERE fo.user_id=u.id AND f.event_id=$1 AND fo.status IN ('invited','accepted','completed'))::int AS event_assignments
         FROM active_sport_profiles asp
         JOIN users u ON u.id=asp.user_id
         LEFT JOIN sport_profiles sp ON sp.user_id=u.id AND sp.sport_id=asp.sport_id
         LEFT JOIN LATERAL (
           SELECT t.grade_rank, t.name, t.grade FROM fed_licences l
           JOIN fed_licence_types t ON t.id=l.type_id
           WHERE l.holder_id=u.id AND l.status='active' AND l.expires_on>=current_date
             AND t.holder_role='official' AND t.sport_id=asp.sport_id
           ORDER BY t.grade_rank DESC LIMIT 1
         ) fl ON true
         LEFT JOIN LATERAL (
           SELECT expires_at FROM verification_cases
           WHERE type='referee' AND subject_type='user' AND subject_id=u.id AND status='approved' AND expires_at>now()
           ORDER BY expires_at DESC LIMIT 1
         ) vc ON true
        WHERE asp.role='referee' AND asp.sport_id=$2
          AND ($3::int IS NULL OR fl.grade_rank >= $3)
        ORDER BY fl.grade_rank DESC NULLS LAST, u.display_name
        LIMIT $4 OFFSET $5`,
      [i.id, ev.sport_id, i.min_grade_rank ?? null, i.limit, i.offset]
    );

    // Attach a 7-day availability summary keyed by ISO date
    const eventStart = ev.starts_at ? new Date(ev.starts_at) : null;
    const days = eventStart
      ? Array.from({ length: 7 }, (_, k) => {
          const d = new Date(eventStart);
          d.setDate(d.getDate() + k);
          return d.toISOString().slice(0, 10);
        })
      : [];

    const userIds = rows.map((r) => r.id);
    const avails = userIds.length && days.length
      ? await many(
          `SELECT user_id, starts_at::date::text AS day, kind
             FROM official_availability
            WHERE user_id = ANY($1::uuid[])
              AND archived_at IS NULL
              AND starts_at::date = ANY($2::date[])`,
          [userIds, days]
        )
      : [];

    const availMap = {};
    for (const a of avails) {
      if (!availMap[a.user_id]) availMap[a.user_id] = {};
      availMap[a.user_id][a.day] = a.kind;
    }

    return {
      officials: rows.map((r) => ({
        ...r,
        availability: days.reduce((acc, d) => ({ ...acc, [d]: availMap[r.id]?.[d] ?? 'unknown' }), {}),
      })),
      days,
      total: rows.length,
    };
  },
});

// ─── 2. Auto-suggest with scored explanation for a single fixture slot ───────

cap({
  name: 'suggest_fixture_officials',
  method: 'GET',
  path: '/fixtures/:id/officials/suggest',
  tag: 'Officials',
  summary: 'Returns a ranked list of officials for a fixture-role with a scored breakdown (grade, travel, neutrality, rotation, cost, availability) and a plain-language explanation. Organisers only.',
  input: z.object({ id, role, limit: z.coerce.number().int().min(1).max(20).default(10) }),
  async handler({ user }, i) {
    const f = await one('SELECT * FROM fixtures WHERE id=$1', [i.id]);
    if (!f) throw notFound('fixture');
    const ev = await one('SELECT * FROM events WHERE id=$1', [f.event_id]);
    if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Organisers only');

    // Pool: active referee profiles for this sport, not already confirmed/invited for this fixture
    const pool = await many(
      `SELECT u.id FROM active_sport_profiles asp
        JOIN users u ON u.id=asp.user_id
       WHERE asp.role='referee' AND asp.sport_id=$1
         AND NOT EXISTS (
           SELECT 1 FROM fixture_officials fo
            WHERE fo.fixture_id=$2 AND fo.user_id=u.id AND fo.status IN ('invited','accepted') AND fo.role=$3
         )`,
      [ev.sport_id, i.id, i.role]
    );

    const { withClient } = await import('../db.js');
    const results = await withClient(async (c) => {
      const scored = [];
      for (const { id: userId } of pool) {
        try {
          const s = await scoreOfficial(c, { userId, role: i.role, fixture: f, event: ev, minGradeRank: ev.official_min_grade_rank ?? 0 });
          scored.push({ user_id: userId, ...s });
        } catch { /* skip ineligible */ }
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, i.limit);
    });

    // Enrich with display names
    const ids = results.map((r) => r.user_id);
    const users = ids.length ? await many('SELECT id, display_name, handle, avatar_emoji, avatar_color FROM users WHERE id = ANY($1::uuid[])', [ids]) : [];
    const uMap = Object.fromEntries(users.map((u) => [u.id, u]));

    const enriched = results.map((r) => ({
      ...r,
      ...uMap[r.user_id],
      explanation: buildExplanation(r.reasons),
    }));

    // Log suggestions (non-blocking)
    if (enriched.length) {
      one(
        `INSERT INTO official_suggestion_log(event_id,fixture_id,user_id,role,score,score_grade,score_travel,score_neutral,score_rotation,score_cost,score_avail,reasons,queried_by)
         SELECT $1,$2,unnest($3::uuid[]),$4,unnest($5::int[]),unnest($6::int[]),unnest($7::int[]),unnest($8::int[]),unnest($9::int[]),unnest($10::int[]),unnest($11::int[]),$12,$13
         ON CONFLICT DO NOTHING`,
        [
          ev.id, i.id, enriched.map((r) => r.user_id), i.role,
          enriched.map((r) => r.score), enriched.map((r) => r.score_grade),
          enriched.map((r) => r.score_travel), enriched.map((r) => r.score_neutral),
          enriched.map((r) => r.score_rotation), enriched.map((r) => r.score_cost),
          enriched.map((r) => r.score_avail), JSON.stringify(enriched.map((r) => r.reasons)), user.id,
        ]
      ).catch(() => {});
    }

    return { suggestions: enriched, fixture_id: i.id, role: i.role };
  },
});

function buildExplanation(reasons) {
  const parts = [];
  if (reasons.grade?.score > 0) parts.push(`Grade: ${reasons.grade.label} (+${reasons.grade.score} pts)`);
  else parts.push('No active licence for this sport (qualification not met)');
  if (reasons.travel) parts.push(`Travel: ${reasons.travel.label} (+${reasons.travel.score} pts)`);
  if (reasons.neutral?.conflict) parts.push('⚠️ Neutrality: nationality matches a player in this fixture');
  else if (reasons.neutral) parts.push(`Neutrality: ${reasons.neutral.label} (+${reasons.neutral.score} pts)`);
  if (reasons.rotation) parts.push(`Rotation: ${reasons.rotation.label} (+${reasons.rotation.score} pts)`);
  if (reasons.cost) parts.push(`Cost: ${reasons.cost.label} (+${reasons.cost.score} pts)`);
  if (reasons.availability) parts.push(`Availability: ${reasons.availability.label}`);
  return parts.join(' · ');
}

// ─── 3. Add to shortlist ─────────────────────────────────────────────────────

cap({
  name: 'shortlist_fixture_official',
  method: 'POST',
  path: '/fixtures/:id/officials/shortlist',
  tag: 'Officials',
  summary: 'Add an official to the shortlist for a fixture-role. They are not notified — no commitment is made until a formal invitation is sent.',
  input: z.object({ id, user_id: id, role, note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = await one('SELECT event_id FROM fixtures WHERE id=$1', [i.id]);
      if (!f) throw notFound('fixture');
      await eventForOrganizerOrAdmin(user, f.event_id, c);
      await c.query(
        `INSERT INTO official_shortlists(fixture_id, user_id, role, shortlisted_by, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (fixture_id, user_id, role) DO UPDATE SET note=$5, archived_at=NULL`,
        [i.id, i.user_id, i.role, user.id, i.note ?? null]
      );
      return (await c.query('SELECT * FROM official_shortlists WHERE fixture_id=$1 AND user_id=$2 AND role=$3', [i.id, i.user_id, i.role])).rows[0];
    });
  },
});

// ─── 4. Remove from shortlist ────────────────────────────────────────────────

cap({
  name: 'remove_shortlist_official',
  method: 'POST',
  path: '/official-shortlists/:id/remove',
  tag: 'Officials',
  summary: 'Remove an official from a fixture shortlist.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const sl = (await c.query('SELECT * FROM official_shortlists WHERE id=$1', [i.id])).rows[0];
      if (!sl) throw notFound('shortlist entry');
      const f = await one('SELECT event_id FROM fixtures WHERE id=$1', [sl.fixture_id]);
      await eventForOrganizerOrAdmin(user, f.event_id, c);
      await c.query('UPDATE official_shortlists SET archived_at=now() WHERE id=$1', [i.id]);
      return { removed: true };
    });
  },
});

// ─── 5. Bulk invite ──────────────────────────────────────────────────────────

cap({
  name: 'bulk_invite_officials',
  method: 'POST',
  path: '/events/:id/officials/bulk-invite',
  tag: 'Officials',
  status: 201,
  summary: `Invite one or more officials to one or more fixtures in a single operation.
Each (fixture, official, role) triple is validated independently; failures are reported per-item without aborting the batch.
No silent bookings: every official must accept before they appear as confirmed crew.`,
  input: z.object({
    id,
    role,
    fixture_ids: z.array(id).min(1).max(50),
    user_ids: z.array(id).min(1).max(10),
    message: z.string().max(1000).optional(),
    fee_minor: moneySchema.optional(),
    fee_currency: z.string().length(3).optional(),
    override_reason: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    const ev = await one('SELECT * FROM events WHERE id=$1', [i.id]);
    if (!ev) throw notFound('event');
    if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Organisers only');

    const results = { sent: [], skipped: [], errors: [] };

    // Record the batch header
    const { withClient } = await import('../db.js');
    const batch = await withClient(async (c) => {
      return (await c.query(
        `INSERT INTO official_bulk_batches(event_id, role, message, fee_minor, fee_currency, sent_by, fixture_ids, user_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [i.id, i.role, i.message ?? null, i.fee_minor ?? null, i.fee_currency ?? null, user.id, i.fixture_ids, i.user_ids]
      )).rows[0];
    });

    // Process each (fixture × official) pair in its own tx for concurrency safety
    for (const fixtureId of i.fixture_ids) {
      for (const userId of i.user_ids) {
        try {
          const fo = await tx(async (c) => {
            const f = await lockedFixture(c, fixtureId);
            if (!f) throw notFound(`fixture ${fixtureId}`);
            if (f.event_id !== i.id) throw badRequest('Fixture does not belong to this event');
            if (['completed', 'cancelled'].includes(f.status)) throw conflict(`Fixture is ${f.status}`);
            await lockOfficial(c, userId);
            const fo = await inviteOfficial(c, user, ev, f, userId, i.role);
            // Link to batch
            await c.query('UPDATE fixture_officials SET bulk_batch_id=$2 WHERE id=$1', [fo.id, batch.id]);
            if (i.fee_minor && i.fee_currency) {
              await c.query(`UPDATE fixture_officials SET fee_minor=$2, fee_currency=$3, pay_status='agreed' WHERE id=$1`, [fo.id, i.fee_minor, i.fee_currency]);
            }
            if (i.message) {
              await notify(c, userId, { kind: 'official_assignment', title: 'You have been invited as an official', body: i.message, data: { official_id: fo.id, fixture_id: fixtureId } });
            }
            return fo;
          });
          results.sent.push({ fixture_id: fixtureId, user_id: userId, official_assignment_id: fo.id });
        } catch (err) {
          if (err.statusCode === 409 && String(err.message).includes('already')) {
            results.skipped.push({ fixture_id: fixtureId, user_id: userId, reason: err.message });
          } else {
            results.errors.push({ fixture_id: fixtureId, user_id: userId, reason: err.message });
          }
        }
      }
    }

    // Update batch invite_count
    await one('UPDATE official_bulk_batches SET invite_count=$2 WHERE id=$1', [batch.id, results.sent.length]);

    return { batch_id: batch.id, ...results };
  },
});

// ─── 6. Swap official between fixtures ──────────────────────────────────────

cap({
  name: 'swap_fixture_official',
  method: 'POST',
  path: '/official-assignments/:id/swap',
  tag: 'Officials',
  summary: `Move an accepted official from their current fixture to a different fixture (same role).
Performs all eligibility, neutrality, travel, overlap and double-booking checks.
If a preference-only warning is raised, an override_reason is required. The old assignment is released and a new one is created.`,
  input: z.object({
    id,
    to_fixture_id: id,
    override_reason: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      // Lock and validate the source assignment
      const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!fo) throw notFound('official assignment');
      if (fo.status !== 'accepted') throw conflict(`Assignment is ${fo.status} — only accepted assignments can be swapped`);

      const fromF = await lockedFixture(c, fo.fixture_id);
      if (!fromF) throw notFound('source fixture');
      const ev = await eventForOrganizerOrAdmin(user, fromF.event_id, c);

      const toF = await lockedFixture(c, i.to_fixture_id);
      if (!toF) throw notFound('destination fixture');
      if (toF.event_id !== ev.id) throw badRequest('Destination fixture is in a different event');
      if (['completed', 'cancelled'].includes(toF.status)) throw conflict(`Destination fixture is ${toF.status}`);

      // Check no duplicate
      const dupe = await c.query(
        "SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND role=$3 AND status IN ('invited','accepted')",
        [i.to_fixture_id, fo.user_id, fo.role]
      );
      if (dupe.rowCount) throw conflict('Official is already assigned to the destination fixture in this role');

      // Eligibility + overlap check (treating toF as the target)
      await lockOfficial(c, fo.user_id);
      const warnings = [];
      try {
        await assertOfficialEligible(c, {
          event: ev,
          fixtureId: i.to_fixture_id,
          userId: fo.user_id,
          role: fo.role,
          start: toF.scheduled_at,
          durationMin: toF.duration_min,
        });
      } catch (err) {
        // Preference warnings are allowed with an override reason; hard disqualifications are not
        if (err.message?.includes('unavailable') || err.message?.includes('clash') || err.message?.includes('blackout')) {
          throw err;
        }
        // Rotation preference or similar soft warning
        if (!i.override_reason) throw badRequest(`${err.message} — supply override_reason to proceed`);
        warnings.push(err.message);
      }

      // Release the old assignment
      await closeOfficial(c, fo, user.id, 'released', `Swapped to fixture ${i.to_fixture_id}${i.override_reason ? `: ${i.override_reason}` : ''}`);

      // Create the new assignment (auto-accepted since the official is already confirmed)
      const newFo = await inviteOfficial(c, user, ev, toF, fo.user_id, fo.role);
      await c.query("UPDATE fixture_officials SET status='accepted', responded_at=now() WHERE id=$1", [newFo.id]);
      await recordHistory(c, newFo.id, user.id, 'invited', 'accepted', 'Transferred via swap');

      // Record swap history
      await c.query(
        `INSERT INTO official_swap_history(from_fo_id,to_fo_id,user_id,actor_id,from_fixture_id,to_fixture_id,role,override_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fo.id, newFo.id, fo.user_id, user.id, fo.fixture_id, i.to_fixture_id, fo.role, i.override_reason ?? null]
      );

      // Notify the official
      await notify(c, fo.user_id, {
        kind: 'official_assignment',
        title: 'Your assignment has been updated',
        body: `You have been moved to a different match in ${ev.name}.`,
        data: { official_id: newFo.id, fixture_id: i.to_fixture_id },
      });

      return { released: fo.id, created: newFo.id, warnings };
    });
  },
});

// ─── 7. Bulk reschedule impact preview ──────────────────────────────────────

cap({
  name: 'preview_bulk_reschedule_officials',
  method: 'POST',
  path: '/events/:id/officials/reschedule-preview',
  tag: 'Officials',
  summary: 'Given a proposed rescheduling (fixture IDs + new times), returns the officials affected, any availability conflicts, and which assignments would need action.',
  input: z.object({
    id,
    changes: z.array(z.object({
      fixture_id: id,
      new_scheduled_at: z.string().datetime(),
    })).min(1).max(100),
  }),
  async handler({ user }, i) {
    const ev = await one('SELECT * FROM events WHERE id=$1', [i.id]);
    if (!ev) throw notFound('event');
    if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Organisers only');

    const impacts = [];

    for (const change of i.changes) {
      const f = await one('SELECT * FROM fixtures WHERE id=$1 AND event_id=$2', [change.fixture_id, i.id]);
      if (!f) { impacts.push({ fixture_id: change.fixture_id, error: 'Fixture not found in this event' }); continue; }

      const crew = await many(
        `SELECT fo.id, fo.user_id, fo.role, fo.status, u.display_name
           FROM fixture_officials fo JOIN users u ON u.id=fo.user_id
          WHERE fo.fixture_id=$1 AND fo.status IN ('invited','accepted')`,
        [change.fixture_id]
      );

      const start = change.new_scheduled_at;
      const end = new Date(new Date(start).getTime() + (f.duration_min ?? 90) * 60000).toISOString();

      const memberImpacts = [];
      for (const member of crew) {
        // Check blackout at new time
        const bo = await one(
          `SELECT 1 FROM official_availability WHERE user_id=$1 AND kind='blackout' AND archived_at IS NULL AND starts_at < $3 AND ends_at > $2 LIMIT 1`,
          [member.user_id, start, end]
        );
        // Check clash with another confirmed fixture
        const clash = await one(
          `SELECT f2.id, f2.scheduled_at FROM fixtures f2
            WHERE f2.status IN ('scheduled','live') AND f2.id <> $4
              AND (f2.referee_id=$1 OR EXISTS (SELECT 1 FROM fixture_officials fo2 WHERE fo2.fixture_id=f2.id AND fo2.user_id=$1 AND fo2.status='accepted'))
              AND f2.scheduled_at < $3 AND f2.scheduled_at + f2.duration_min * interval '1 minute' > $2 LIMIT 1`,
          [member.user_id, start, end, change.fixture_id]
        );
        memberImpacts.push({
          user_id: member.user_id,
          display_name: member.display_name,
          role: member.role,
          fo_id: member.id,
          status: member.status,
          has_blackout: !!bo,
          has_clash: !!clash,
          clash_fixture_id: clash?.id ?? null,
          action_needed: !!(bo || clash),
        });
      }

      impacts.push({
        fixture_id: change.fixture_id,
        current_scheduled_at: f.scheduled_at,
        new_scheduled_at: change.new_scheduled_at,
        crew: memberImpacts,
        conflicts: memberImpacts.filter((m) => m.action_needed).length,
      });
    }

    const totalAffected = new Set(impacts.flatMap((imp) => (imp.crew ?? []).map((m) => m.user_id))).size;
    const totalConflicts = impacts.reduce((s, imp) => s + (imp.conflicts ?? 0), 0);
    return { impacts, total_officials_affected: totalAffected, total_conflicts: totalConflicts };
  },
});

// ─── 8. Assignment board summary ─────────────────────────────────────────────

cap({
  name: 'get_assignment_board',
  method: 'GET',
  path: '/events/:id/officials/board',
  tag: 'Officials',
  summary: 'Returns the full assignment board for an event: every fixture with its officiating crew per role, coverage stats, shortlists and pending invites. Organisers only.',
  input: z.object({
    id,
    day: z.string().optional().describe('Filter to fixtures on this ISO date (YYYY-MM-DD)'),
    venue_id: id.optional(),
    uncovered_only: z.coerce.boolean().default(false),
    ...page,
  }),
  async handler({ user }, i) {
    const ev = await one('SELECT * FROM events WHERE id=$1', [i.id]);
    if (!ev) throw notFound('event');
    if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Organisers only');

    const whereExtra = [];
    const params = [i.id];
    if (i.day) { params.push(i.day); whereExtra.push(`f.scheduled_at::date = $${params.length}::date`); }
    if (i.venue_id) { params.push(i.venue_id); whereExtra.push(`f.venue_id = $${params.length}`); }

    const fixtures = await many(
      `SELECT f.id, f.scheduled_at, f.duration_min, f.status, f.round, f.round_kind, f.venue_id,
              f.home_team_id, f.away_team_id,
              ht.name AS home_name, at2.name AS away_name,
              ht.emoji AS home_emoji, at2.emoji AS away_emoji,
              v.name AS venue_name, v.timezone AS venue_timezone,
              r.name AS resource_name
         FROM fixtures f
         LEFT JOIN teams ht ON ht.id=f.home_team_id
         LEFT JOIN teams at2 ON at2.id=f.away_team_id
         LEFT JOIN venues v ON v.id=f.venue_id
         LEFT JOIN resources r ON r.id=f.resource_id
        WHERE f.event_id=$1 AND f.status NOT IN ('cancelled')
          ${whereExtra.length ? ' AND ' + whereExtra.join(' AND ') : ''}
        ORDER BY f.scheduled_at NULLS LAST, f.id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, i.limit, i.offset]
    );

    const fIds = fixtures.map((f) => f.id);
    if (!fIds.length) return { fixtures: [], stats: { total: 0, confirmed: 0, pending: 0, uncovered_slots: 0, conflicts: 0 } };

    // All officials for these fixtures
    const officials = await many(
      `SELECT fo.id, fo.fixture_id, fo.user_id, fo.role, fo.status, fo.fee_minor, fo.fee_currency,
              fo.pay_status, fo.needs_ack, fo.bulk_batch_id, fo.shortlist_id,
              u.display_name, u.handle, u.avatar_emoji, u.avatar_color,
              fl.grade_rank, fl.name AS grade_name,
              vc.expires_at AS verification_expires_at
         FROM fixture_officials fo
         JOIN users u ON u.id=fo.user_id
         LEFT JOIN LATERAL (
           SELECT t.grade_rank, t.name FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id
           WHERE l.holder_id=fo.user_id AND l.status='active' AND l.expires_on>=current_date AND t.holder_role='official' AND t.sport_id=$2
           ORDER BY t.grade_rank DESC LIMIT 1
         ) fl ON true
         LEFT JOIN LATERAL (
           SELECT expires_at FROM verification_cases
           WHERE type='referee' AND subject_type='user' AND subject_id=fo.user_id AND status='approved' AND expires_at>now()
           ORDER BY expires_at DESC LIMIT 1
         ) vc ON true
        WHERE fo.fixture_id = ANY($1::uuid[]) AND fo.status NOT IN ('declined','withdrawn','released','cancelled')
        ORDER BY fo.fixture_id, fo.role, fo.created_at`,
      [fIds, ev.sport_id]
    );

    // Shortlists
    const shortlists = await many(
      `SELECT sl.*, u.display_name, u.avatar_emoji, u.avatar_color
         FROM official_shortlists sl JOIN users u ON u.id=sl.user_id
        WHERE sl.fixture_id = ANY($1::uuid[]) AND sl.archived_at IS NULL`,
      [fIds]
    );

    // Neutrality conflicts check
    const neutralityConflicts = await many(
      `SELECT fo.id AS fo_id, fo.fixture_id, fo.user_id
         FROM fixture_officials fo
         JOIN users u ON u.id=fo.user_id
         WHERE fo.fixture_id = ANY($1::uuid[])
           AND fo.status IN ('invited','accepted')
           AND u.nationality IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM fixtures f
             JOIN team_members tm ON tm.team_id IN (f.home_team_id, f.away_team_id)
             WHERE f.id = fo.fixture_id AND tm.user_id != fo.user_id AND tm.status='active'
             AND EXISTS (SELECT 1 FROM users u2 WHERE u2.id=tm.user_id AND u2.nationality=u.nationality)
           )`,
      [fIds]
    );
    const conflictFoIds = new Set(neutralityConflicts.map((r) => r.fo_id));

    // Build fixture map
    const fixtureMap = Object.fromEntries(
      fixtures.map((f) => [f.id, { ...f, crew: {}, shortlists: [] }])
    );
    for (const o of officials) {
      if (!fixtureMap[o.fixture_id]) continue;
      const roleCrew = (fixtureMap[o.fixture_id].crew[o.role] ??= []);
      roleCrew.push({ ...o, neutrality_conflict: conflictFoIds.has(o.id) });
    }
    for (const sl of shortlists) {
      if (fixtureMap[sl.fixture_id]) fixtureMap[sl.fixture_id].shortlists.push(sl);
    }

    // Coverage stats
    const expectedRolesPerFixture = ev.required_official_roles?.length ?? OFFICIAL_ROLES.length;
    let totalConfirmed = 0, totalPending = 0, totalUncoveredSlots = 0, totalConflicts = conflictFoIds.size;
    for (const f of Object.values(fixtureMap)) {
      const covered = Object.values(f.crew).flat().filter((o) => o.status === 'accepted').length;
      const pending = Object.values(f.crew).flat().filter((o) => o.status === 'invited').length;
      totalConfirmed += covered;
      totalPending += pending;
      totalUncoveredSlots += Math.max(0, expectedRolesPerFixture - covered - pending);
    }

    const result = Object.values(fixtureMap);
    if (i.uncovered_only) {
      return {
        fixtures: result.filter((f) => {
          const covered = Object.values(f.crew).flat().filter((o) => ['invited','accepted'].includes(o.status)).length;
          return covered < expectedRolesPerFixture;
        }),
        stats: { total: fixtures.length, confirmed: totalConfirmed, pending: totalPending, uncovered_slots: totalUncoveredSlots, conflicts: totalConflicts },
      };
    }

    return {
      fixtures: result,
      stats: { total: fixtures.length, confirmed: totalConfirmed, pending: totalPending, uncovered_slots: totalUncoveredSlots, conflicts: totalConflicts },
      event: { id: ev.id, name: ev.name, sport_id: ev.sport_id, starts_at: ev.starts_at, ends_at: ev.ends_at },
    };
  },
});

// ─── Lock / Unlock fixture official assignment ───────────────────────────────

cap({
  name: 'lock_fixture_official',
  method: 'POST',
  path: '/official-assignments/:id/lock',
  tag: 'officials',
  summary: 'Lock an accepted official assignment so it cannot be released or swapped without an authorised override.',
  input: z.object({
    id,
    lock_reason: z.string().min(5).max(500).describe('Why this assignment is being locked (e.g. "confirmed for final, travel booked")'),
  }),
  output: z.object({ id, locked_at: z.string(), locked_by: id, lock_reason: z.string() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fo = (await c.query(
        `SELECT fo.*, f.event_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE fo.id=$1`,
        [i.id])).rows[0];
      if (!fo) throw notFound('assignment');
      await eventForOrganizerOrAdmin(user, fo.event_id, c);
      if (fo.status !== 'accepted') throw badRequest('Only accepted assignments can be locked');
      if (fo.locked_at) throw conflict('Assignment is already locked');

      await c.query(
        'UPDATE fixture_officials SET locked_at=now(), locked_by=$2, lock_reason=$3 WHERE id=$1',
        [fo.id, user.id, i.lock_reason]);
      await recordHistory(c, fo.id, user.id, fo.status, fo.status, `locked: ${i.lock_reason}`);
      await audit(c, user.id, 'official_assignment_locked', { fixture_official_id: fo.id, lock_reason: i.lock_reason });

      return { id: fo.id, locked_at: new Date().toISOString(), locked_by: user.id, lock_reason: i.lock_reason };
    });
  },
});

cap({
  name: 'unlock_fixture_official',
  method: 'POST',
  path: '/official-assignments/:id/unlock',
  tag: 'officials',
  summary: 'Unlock a locked official assignment, requiring a documented override reason. Records an exception audit row.',
  input: z.object({
    id,
    override_reason: z.string().min(10).max(500).describe('Mandatory reason for overriding the lock (min 10 chars)'),
  }),
  output: z.object({ id, unlocked_at: z.string() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fo = (await c.query(
        `SELECT fo.*, f.event_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE fo.id=$1`,
        [i.id])).rows[0];
      if (!fo) throw notFound('assignment');
      await eventForOrganizerOrAdmin(user, fo.event_id, c);
      if (!fo.locked_at) throw badRequest('Assignment is not locked');

      await c.query(
        'UPDATE fixture_officials SET locked_at=NULL, locked_by=NULL, lock_reason=NULL WHERE id=$1',
        [fo.id]);
      await recordHistory(c, fo.id, user.id, fo.status, fo.status, `unlocked: ${i.override_reason}`);
      await recordClashException(c, {
        foId: fo.id,
        overridingFoId: null,
        actorId: user.id,
        overrideReason: i.override_reason,
        gapMin: null,
        distKm: null,
      });
      await audit(c, user.id, 'official_assignment_unlocked', { fixture_official_id: fo.id, override_reason: i.override_reason });

      return { id: fo.id, unlocked_at: new Date().toISOString() };
    });
  },
});
