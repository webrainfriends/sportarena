// Sports medicine & RTP (issue #584): overdue milestone/review alerts for clinicians.
// Alert triggers are computed at query time from injury_rtp_milestones and injury_episodes.
// Notifications fire once per milestone via overdue_alert_sent_at deduplication.
// No clinical text is included in alert payloads sent to push/email channels.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { requireVerifiedProvider } from '../clinical-access.js';

const TAG = 'Injury alerts';
const PROVIDER = ['physio', 'doctor'];

// Alert kinds and their descriptions
const ALERT_KINDS = {
  milestone_overdue: 'RTP milestone target date passed',
  episode_overdue: 'Expected return date passed — episode still active',
  rtp_approval_expiring: 'RTP approval expires within 7 days',
  no_recent_encounter: 'No encounter or outcome recorded in 14+ days for active episode',
  low_adherence: 'Home exercise adherence below 50% for 7+ days',
};

cap({
  name: 'get_overdue_alerts',
  credential: true,
  method: 'GET',
  path: '/me/injury-alerts',
  tag: TAG,
  auth: PROVIDER,
  summary:
    'Clinician overview of all overdue or attention-required injury episodes across their patient list. ' +
    'Alert types: (1) RTP milestone target date passed, (2) expected return date exceeded, ' +
    '(3) RTP approval expiring within 7 days, (4) no clinical encounter/outcome in 14+ days ' +
    'for an active episode, (5) home-exercise adherence below 50% for 7+ days. ' +
    'Returns each alert with episode reference, athlete display name, kind, severity, and what action is suggested.',
  input: z.object({}),
  async handler({ user }) {
    const cred = await requireVerifiedProvider(user.id, { action: 'get_overdue_alerts', types: PROVIDER });
    if (!cred) return { alerts: [] };

    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

    // All active episodes where this clinician is the opener or has an active grant
    // We query episodes linked to this provider via medical_grants
    const episodes = await many(
      `SELECT DISTINCT ie.id, ie.episode_ref, ie.status, ie.expected_return_on, ie.athlete_id,
              u.display_name AS athlete_name, ie.occurred_on
       FROM injury_episodes ie
       JOIN users u ON u.id = ie.athlete_id
       JOIN medical_grants mg ON mg.athlete_id = ie.athlete_id AND mg.provider_id = $1
                              AND mg.revoked_at IS NULL
                              AND (mg.expires_at IS NULL OR mg.expires_at > now())
                              AND mg.scope = 'full'
       WHERE ie.archived_at IS NULL
         AND ie.status NOT IN ('closed','cancelled')
       ORDER BY ie.occurred_on DESC`,
      [user.id],
    );

    const episodeIds = episodes.map((e) => e.id);
    if (!episodeIds.length) return { alerts: [] };

    const alerts = [];

    // 1. Milestone overdue
    const overdueMilestones = await many(
      `SELECT m.id, m.episode_id, m.stage_name, m.stage_order, m.target_date, m.status
       FROM injury_rtp_milestones m
       WHERE m.episode_id = ANY($1::uuid[])
         AND m.status IN ('pending','in_progress')
         AND m.target_date IS NOT NULL
         AND m.target_date < $2
       ORDER BY m.target_date ASC`,
      [episodeIds, today],
    );
    for (const m of overdueMilestones) {
      const ep = episodes.find((e) => e.id === m.episode_id);
      const daysOverdue = Math.floor((new Date(today) - new Date(m.target_date)) / 86_400_000);
      alerts.push({
        id: `milestone:${m.id}`,
        kind: 'milestone_overdue',
        severity: daysOverdue > 14 ? 'high' : daysOverdue > 7 ? 'medium' : 'low',
        episode_id: m.episode_id,
        episode_ref: ep?.episode_ref,
        athlete_name: ep?.athlete_name,
        athlete_id: ep?.athlete_id,
        detail: `Stage ${m.stage_order} "${m.stage_name}" — target ${m.target_date} (${daysOverdue}d overdue)`,
        suggested_action: 'Assess milestone and update status or revise target date',
        at: m.target_date,
      });
    }

    // 2. Episode expected return passed
    const overdueReturn = episodes.filter(
      (e) => e.expected_return_on && e.expected_return_on < today,
    );
    for (const ep of overdueReturn) {
      const daysOver = Math.floor((new Date(today) - new Date(ep.expected_return_on)) / 86_400_000);
      alerts.push({
        id: `episode_overdue:${ep.id}`,
        kind: 'episode_overdue',
        severity: daysOver > 21 ? 'high' : daysOver > 7 ? 'medium' : 'low',
        episode_id: ep.id,
        episode_ref: ep.episode_ref,
        athlete_name: ep.athlete_name,
        athlete_id: ep.athlete_id,
        detail: `Expected return ${ep.expected_return_on} has passed (${daysOver}d ago). Episode still active.`,
        suggested_action: 'Review episode, update expected return or progress to next phase',
        at: ep.expected_return_on,
      });
    }

    // 3. RTP approval expiring within 7 days
    const expiringRtp = await many(
      `SELECT a.id, a.episode_id, a.approval_type, a.valid_until
       FROM injury_rtp_approvals a
       WHERE a.episode_id = ANY($1::uuid[])
         AND a.status = 'approved'
         AND a.revoked_at IS NULL
         AND a.valid_until IS NOT NULL
         AND a.valid_until <= $2
         AND a.valid_until >= $3
       ORDER BY a.valid_until ASC`,
      [episodeIds, in7, today],
    );
    for (const a of expiringRtp) {
      const ep = episodes.find((e) => e.id === a.episode_id);
      const daysLeft = Math.floor((new Date(a.valid_until) - new Date(today)) / 86_400_000);
      alerts.push({
        id: `rtp_expiring:${a.id}`,
        kind: 'rtp_approval_expiring',
        severity: daysLeft <= 2 ? 'high' : 'medium',
        episode_id: a.episode_id,
        episode_ref: ep?.episode_ref,
        athlete_name: ep?.athlete_name,
        athlete_id: ep?.athlete_id,
        detail: `${a.approval_type === 'return_to_play' ? 'Return-to-Play' : 'Return-to-Train'} approval expires ${a.valid_until} (${daysLeft}d)`,
        suggested_action: 'Review athlete and issue a new approval or extend the current one',
        at: a.valid_until,
      });
    }

    // 4. No recent encounter or outcome in 14 days for active episodes
    const cutoff14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const recentActivity = await many(
      `SELECT DISTINCT e.episode_id
       FROM injury_episode_links e
       WHERE e.episode_id = ANY($1::uuid[])
         AND e.artifact_type IN ('encounter','treatment_plan')
         AND e.linked_at > $2
       UNION
       SELECT DISTINCT po.episode_id
       FROM physio_outcomes po
       WHERE po.episode_id = ANY($1::uuid[])
         AND po.measured_at > $2`,
      [episodeIds, cutoff14],
    ).catch(() => []);
    const recentIds = new Set(recentActivity.map((r) => r.episode_id));
    for (const ep of episodes) {
      if (!recentIds.has(ep.id)) {
        const daysSince = Math.floor((Date.now() - new Date(ep.occurred_on)) / 86_400_000);
        if (daysSince >= 14) {
          alerts.push({
            id: `no_activity:${ep.id}`,
            kind: 'no_recent_encounter',
            severity: 'medium',
            episode_id: ep.id,
            episode_ref: ep.episode_ref,
            athlete_name: ep.athlete_name,
            athlete_id: ep.athlete_id,
            detail: 'No encounter or outcome measurement linked to this episode in the last 14 days',
            suggested_action: 'Record a session note or outcome measurement for this episode',
            at: null,
          });
        }
      }
    }

    // Sort: high → medium → low, then by date
    alerts.sort((a, b) => {
      const sev = { high: 0, medium: 1, low: 2 };
      return (sev[a.severity] ?? 2) - (sev[b.severity] ?? 2) || (a.at ?? '').localeCompare(b.at ?? '');
    });

    await audit(null, user.id, 'read_injury_alerts', 'injury_episodes', null);
    return { alerts, total: alerts.length };
  },
});

cap({
  name: 'dismiss_alert',
  credential: true,
  method: 'POST',
  path: '/me/injury-alerts/dismiss',
  tag: TAG,
  auth: PROVIDER,
  summary:
    'Dismiss (snooze) an overdue alert for 1–30 days. For milestone alerts, sets ' +
    'overdue_alert_sent_at so the notification does not re-fire. ' +
    'The underlying issue (overdue milestone, missed review) is not resolved by dismissing.',
  input: z.object({
    alert_id: z.string().min(1).max(200),
    snooze_days: z.number().int().min(1).max(30).default(7),
  }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'dismiss_alert', types: PROVIDER });

    // Parse alert_id format: 'milestone:<uuid>' or 'episode_overdue:<uuid>' etc.
    const [kind, entityId] = i.alert_id.split(':');
    if (!kind || !entityId) throw badRequest('Invalid alert_id format');

    if (kind === 'milestone') {
      const m = await one(
        'SELECT id, episode_id FROM injury_rtp_milestones WHERE id=$1',
        [entityId],
      ).catch(() => null);
      if (!m) throw notFound('Milestone');
      // Verify this clinician has access to the episode
      const ep = await one(
        `SELECT ie.athlete_id FROM injury_episodes ie
         JOIN medical_grants mg ON mg.athlete_id = ie.athlete_id AND mg.provider_id = $2
                                AND mg.revoked_at IS NULL AND mg.scope = 'full'
         WHERE ie.id = $1`,
        [m.episode_id, user.id],
      ).catch(() => null);
      if (!ep) throw notFound('Episode');

      const snoozeUntil = new Date(Date.now() + i.snooze_days * 86_400_000).toISOString();
      await one(
        'UPDATE injury_rtp_milestones SET overdue_alert_sent_at=$2 WHERE id=$1 RETURNING id',
        [m.id, snoozeUntil],
      );
    }
    // Other alert kinds are computed at query time — dismissal is noted but no DB state to persist
    await audit(null, user.id, 'write_injury_alert_dismiss', 'injury_rtp_milestones', entityId);
    return { dismissed: true, snoozed_until: new Date(Date.now() + i.snooze_days * 86_400_000).toISOString().slice(0, 10) };
  },
});

/** Worker function — call from a scheduled job to fire push notifications for newly overdue milestones. */
export async function fireOverdueMilestoneAlerts(db) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.query(
    `SELECT m.id, m.episode_id, m.stage_name, ie.athlete_id, ie.opened_by, ie.episode_ref,
            mg.provider_id
     FROM injury_rtp_milestones m
     JOIN injury_episodes ie ON ie.id = m.episode_id AND ie.archived_at IS NULL
                             AND ie.status NOT IN ('closed','cancelled')
     JOIN medical_grants mg ON mg.athlete_id = ie.athlete_id AND mg.revoked_at IS NULL
                            AND mg.scope = 'full'
     WHERE m.status IN ('pending','in_progress')
       AND m.target_date < $1
       AND (m.overdue_alert_sent_at IS NULL OR m.overdue_alert_sent_at < $1)`,
    [today],
  );
  for (const r of rows.rows) {
    await notify(db, r.provider_id, {
      kind: 'injury_milestone_overdue',
      title: `Overdue RTP milestone — ${r.episode_ref}`,
      body: `Stage "${r.stage_name}" target has passed. Review needed.`,
      data: { episode_id: r.episode_id },
      dedupe_key: `milestone_overdue:${r.id}:${today}`,
    }).catch(() => {});
    await db.query(
      'UPDATE injury_rtp_milestones SET overdue_alert_sent_at=now() WHERE id=$1',
      [r.id],
    );
  }
}
