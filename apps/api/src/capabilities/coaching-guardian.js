import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { requireGuardian, hasConsent } from '../youth.js';
import { audit } from '../helpers.js';
import { sharedActions, sharedGoals, sharedNotes, sharedReports, sharedSummaries } from '../coaching-shared.js';

// A verified guardian sees what the coach shared with their child - the same items the child sees, and only while the guardian's own
// 'coaching' consent is in force. Private notes, coach criteria and anything not shared with the child never appear.
cap({
  name: 'guardian_coaching_overview', method: 'GET', path: '/guardian/children/:child_id/coaching', tag: 'Coaching journal', auth: 'user',
  summary: 'What a coach has shared with a young person you are a verified guardian of: notes, goals, actions, session summaries and reports published for guardians. Shown only while you allow coaching sharing for them (Family & guardians); withdrawing it hides everything again, and it is never deleted.',
  input: z.object({ child_id: id, ...page }),
  async handler({ user }, i) {
    await requireGuardian(user, i.child_id);
    await audit(null, user.id, 'read_child_coaching', 'users', i.child_id);
    if (!(await hasConsent(i.child_id, 'coaching'))) return { consent: false, note: 'Coaching sharing is not allowed for this child. Allow it under Family & guardians to see what their coach shares.', notes: [], goals: [], actions: [], summaries: [], reports: [] };
    const [notes, goals, actions, summaries, reports] = await Promise.all([sharedNotes(i.child_id, i), sharedGoals(i.child_id, i), sharedActions(i.child_id, i), sharedSummaries(i.child_id, i), sharedReports(i.child_id, 'guardian', i)]);
    return { consent: true, notes, goals, actions, summaries, reports };
  },
});
