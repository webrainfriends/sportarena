import { one } from './db.js';
import { guardianLink, hasConsent } from './youth.js';

/**
 * May `user` read this observation (and therefore its attached evidence)? Derived live from the observation's current visibility, so
 * making a note private again immediately hides its files. The author always can. For a young person, shared items need a guardian's
 * current coaching consent.
 */
export async function canReadObservation(user, o) {
  if (!user || !o) return false;
  if (o.coach_id === user.id) return true;
  if (o.visibility === 'staff') return !!(o.team_id && (await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role='coach'", [o.team_id, user.id])));
  if (o.visibility === 'player') {
    if (!o.athlete_id || !(await hasConsent(o.athlete_id, 'coaching'))) return false;
    return o.athlete_id === user.id || !!(await guardianLink(user.id, o.athlete_id));
  }
  if (o.visibility === 'team') {
    if (!o.team_id || !(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [o.team_id, user.id]))) return false;
    return hasConsent(user.id, 'coaching');
  }
  return false;
}
