import { z } from 'zod';
import { cap, capabilities, id } from '../registry.js';
import { many, tx } from '../db.js';
import { conflict } from '../errors.js';
import { notify } from '../notify.js';
import { eventForOrganizer } from './events.js';

// Moving an event between statuses always stamps who/when/why; a trigger copies that into event_status_history.
const stamp = (c, eventId, user, status, reason, extra = '') =>
  c.query(`UPDATE events SET status=$2, status_changed_by=$3, status_reason=$4, status_changed_at=clock_timestamp()${extra} WHERE id=$1 RETURNING *`, [eventId, status, user.id, reason ?? null]);

/** Everyone who should hear about an event-wide change: accepted entrants (team owners / solo players) and active crew. */
async function audience(c, eventId) {
  const rows = (await c.query(
    `SELECT DISTINCT uid FROM (
       SELECT coalesce(t.owner_id, e.user_id) AS uid FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id WHERE e.event_id=$1 AND e.status IN ('accepted','pending')
       UNION SELECT a.user_id FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE r.event_id=$1 AND a.status='accepted') x
     WHERE uid IS NOT NULL`, [eventId])).rows;
  return rows.map((r) => r.uid);
}

cap({
  name: 'pause_event', method: 'POST', path: '/events/:id/pause', tag: 'Events',
  summary: 'Pause a running event (weather, safety, delay). Games that are live are frozen with it and everyone entered or on the crew is told. Resume restores exactly the games this paused.',
  input: z.object({ id, reason: z.string().min(2).max(300).describe('why the event is paused; shown to participants') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (ev.status !== 'ongoing') throw conflict(`Only a running event can be paused; this one is ${ev.status}`);
      const frozen = (await c.query("UPDATE fixtures SET status='paused', paused_by_event=true WHERE event_id=$1 AND status='live' RETURNING id", [i.id])).rows;
      const out = (await stamp(c, i.id, user, 'paused', i.reason, ', paused_at=now(), pause_reason=$4')).rows[0];
      for (const uid of await audience(c, i.id)) await notify(c, uid, { kind: 'event_paused', title: 'Event paused', body: `${ev.name} is paused: ${i.reason}`, data: { event_id: ev.id } });
      return { ...out, frozen_fixtures: frozen.length };
    });
  },
});

cap({
  name: 'resume_event', method: 'POST', path: '/events/:id/resume', tag: 'Events',
  summary: 'Resume a paused event. Games frozen by the pause go live again; participants are told.',
  input: z.object({ id, note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (ev.status !== 'paused') throw conflict(`Only a paused event can be resumed; this one is ${ev.status}`);
      const resumed = (await c.query("UPDATE fixtures SET status='live', paused_by_event=false WHERE event_id=$1 AND status='paused' AND paused_by_event RETURNING id", [i.id])).rows;
      const out = (await stamp(c, i.id, user, 'ongoing', i.note ?? 'Resumed', ', paused_at=NULL, pause_reason=NULL')).rows[0];
      for (const uid of await audience(c, i.id)) await notify(c, uid, { kind: 'event_resumed', title: 'Event resumed', body: `${ev.name} is back on.${i.note ? ' ' + i.note : ''}`, data: { event_id: ev.id } });
      return { ...out, resumed_fixtures: resumed.length };
    });
  },
});

cap({
  name: 'end_event', method: 'POST', path: '/events/:id/end', tag: 'Events',
  summary: 'End an event: awards the podium like complete_event and stamps who ended it. Refuses while games are live or paused unless force is set with a reason.',
  input: z.object({ id, force: z.boolean().default(false), reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    const blocking = await many("SELECT id FROM fixtures WHERE event_id=$1 AND status IN ('live','paused')", [i.id]);
    if (blocking.length && !i.force) throw conflict(`${blocking.length} game(s) are still live or paused; finish them or end with force`, { fixtures: blocking.map((f) => f.id) });
    if (blocking.length && !i.reason) throw conflict('Ending with games still running needs a reason');
    const complete = capabilities.find((x) => x.name === 'complete_event');
    const out = await complete.handler({ user }, { id: i.id, force: i.force, reason: i.reason });
    if (blocking.length) await many("UPDATE fixtures SET status='abandoned', paused_by_event=false WHERE event_id=$1 AND status IN ('live','paused') RETURNING id", [i.id]);
    return { ...out, ended_by: user.id };
  },
});

cap({
  name: 'get_event_status_history', method: 'GET', path: '/events/:id/status-history', tag: 'Events',
  summary: 'Every status change of an event with who made it and why (organiser only).', input: z.object({ id }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    return many('SELECT h.*, u.display_name AS actor_name FROM event_status_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.event_id=$1 ORDER BY h.at', [i.id]);
  },
});
