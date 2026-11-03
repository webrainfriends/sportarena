// Team / batch performance for a coach: how a team or an academy batch is doing across the sessions the coach ran, with findings and recommendations.
// Aggregates only (no athlete is named); the shareable report built from this is in coaching-reports.js (kind team_performance).
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { badRequest } from '../errors.js';
import { audit } from '../helpers.js';
import { listScopes, teamPerformance, MIN_SHARED_COHORT } from '../team-performance.js';
import { findingsFor, headlineFor, aiPolish } from '../team-findings.js';
import { aiConfigured } from '../ai.js';

const TAG = 'Team performance';
const COACH = ['coach'];
const day = z.string().date();
const query = z.object({ team_id: id.optional(), cohort_id: id.optional(), from: day, to: day, rubric_id: id.optional() });
const check = (i) => { if (i.to < i.from) throw badRequest('to is before from'); if ((Date.parse(i.to) - Date.parse(i.from)) / 864e5 > 400) throw badRequest('Choose a period of up to about a year'); };

cap({
  name: 'list_team_performance_scopes', method: 'GET', path: '/coaching/team-performance/scopes', tag: TAG, auth: COACH,
  summary: 'The teams you coach and the academy batches (cohorts) you take sessions for: what you can analyse.', input: z.object({}),
  handler: ({ user }) => listScopes(user),
});

cap({
  name: 'get_team_performance', method: 'GET', path: '/coaching/team-performance', tag: TAG, auth: COACH,
  summary: `How a team or an academy batch performed across the sessions you ran in a period: sessions and attendance by week, planned load and intensity by week, plan delivery (blocks completed, modified, skipped), evaluation coverage, goals, and the group's average and change on each criterion of one of your evaluation sheets. Aggregates only, no athlete is named. A young person counts only while a guardian's coaching consent is in force. Criterion figures need at least ${MIN_SHARED_COHORT} athletes to be shared outside; you can look at smaller groups and are told they cannot be shared. Unrecorded data is shown as missing, never as zero.`,
  input: query,
  async handler({ user }, i) { check(i); return teamPerformance(user, i); },
});

cap({
  name: 'get_team_findings', method: 'POST', path: '/coaching/team-performance/findings', tag: TAG, auth: COACH,
  summary: 'Findings and recommendations for a team or batch over a period. The findings are rules over your own numbers, each with the figure it came from, why it matters and a suggested next step; where your drill library has drills tagged for a weak criterion they are named. With use_ai (and AI configured) a model rewords the headline and adds up to five clearly labelled suggestions; it sees aggregates only, never names or individual scores, and cannot change an observed finding. Nothing is shared or saved by reading this.',
  input: query.extend({ use_ai: z.boolean().default(true) }),
  async handler({ user }, i) {
    check(i);
    const perf = await teamPerformance(user, i);
    if (!perf.sessions.total) return { perf_summary: { sessions: 0 }, headline: 'No sessions of yours fall in this period for this team or batch.', findings: [], ai: null, ai_available: aiConfigured() };
    const findings = await findingsFor(user, perf);
    const ai = i.use_ai ? await aiPolish(user, perf, findings) : null;
    await audit(null, user.id, 'team_findings', 'coaching_team_performance', null);
    return {
      perf_summary: { sessions: perf.sessions.total, athletes: perf.athletes.n, shareable: perf.shareable, attendance_rate: perf.attendance.rate, total_au: perf.load.total_au },
      headline: headlineFor(perf, findings), findings,
      ai: ai ? { headline: ai.headline, suggestions: ai.suggestions.map((s) => ({ ...s, basis: 'suggestion' })) } : null, ai_available: aiConfigured(),
      note: 'Findings are from your own records. AI suggestions are ideas to check, not facts.',
    };
  },
});
