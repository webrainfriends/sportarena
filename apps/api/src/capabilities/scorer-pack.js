// The referee's match-day pack (#7): everything a scorer needs to run today's games with no signal, in one read. It adds no new way to
// score: the pack is the same live state and lineup the Match Centre already reads (get_live_fixture, list_fixture_appearances), so the
// permission rules, void visibility and the youth-consent redaction are exactly theirs. The device keeps it encrypted, projects taps onto
// it with the same pure engine the server uses, and sends them back through log_match_event and the offline-safe controls.
import { z } from 'zod';
import { cap, capabilities, id } from '../registry.js';
import { many } from '../db.js';
import { fixtureContext } from './match-tracking.js';
import { liveState } from '../scoring/state.js';
import { isKnockout } from '../tournament/advance.js';
import { audit } from '../helpers.js';

const TAG = 'Match tracking';
const SCORERS = ['referee', 'umpire', 'scorer'];
const call = (name, user, input) => capabilities.find((c) => c.name === name).handler({ user }, input);

cap({
  name: 'get_scorer_pack', method: 'GET', path: '/me/scorer-pack', tag: TAG,
  summary: 'Download the games you may score in the next hours (organiser of the event, or an accepted referee / umpire / scorer) with their live state, pinned rules and declared lineup, so the app can keep scoring with no signal. Only games you can score are included; a young person without current guardian consent is hidden exactly as in the lineup.',
  input: z.object({
    hours_back: z.coerce.number().int().min(0).max(48).default(12).describe('include games that started up to this many hours ago and are still open'),
    hours_ahead: z.coerce.number().int().min(1).max(168).default(36),
    limit: z.coerce.number().int().min(1).max(20).default(12),
    fixture_id: id.optional().describe('refresh just this one game (the window is ignored); 404-style empty when you may not score it'),
  }),
  async handler({ user }, i) {
    const rows = i.fixture_id ? [{ id: i.fixture_id }] : await many(
      `SELECT f.id FROM fixtures f JOIN events e ON e.id=f.event_id
        WHERE e.status NOT IN ('draft','cancelled') AND f.status IN ('scheduled','live','paused','finished')
          AND f.scheduled_at BETWEEN now() - $2 * interval '1 hour' AND now() + $3 * interval '1 hour'
          AND (e.organizer_id=$1 OR f.referee_id=$1
               OR EXISTS (SELECT 1 FROM fixture_officials o WHERE o.fixture_id=f.id AND o.user_id=$1 AND o.status='accepted' AND o.role = ANY($4))
               OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=e.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin')))
        ORDER BY f.scheduled_at LIMIT $5`, [user.id, i.hours_back, i.hours_ahead, SCORERS, i.limit]);
    const games = [];
    for (const { id } of rows) {
      const x = await fixtureContext(user, id).catch(() => null);   // the authority, resolved now: the SQL above only narrows the candidates
      if (!x?.canScore) continue;
      // the whole log, not the last page: the device replays it with the same pure engine to show the score while offline
      const live = await liveState(id, null, { sinceSeq: 0, limit: 100000, includeVoided: true });
      const lineup = await call('list_fixture_appearances', user, { id });
      games.push({ ...live, viewer: { can_score: true, organiser: !!x.organiser, manages: x.side ?? null }, knockout: isKnockout(x.f), lineup: lineup.appearances });
    }
    if (games.length) await audit(null, user.id, 'scorer_pack.download', 'user', user.id);   // a pack holds lineups: who took one is recorded
    return { generated_at: new Date().toISOString(), games };
  },
});
