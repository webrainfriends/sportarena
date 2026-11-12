// Cross-role onboarding state hub (#1126): aggregates wizard status for all 6 roles.
// Returns NO cross-role PII — only status, completeness, entry route.
import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { requireApproved } from '../access.js';
import { badRequest } from '../errors.js';

const TAG = 'Onboarding';
const PERSONAL_ROLES = ['coach','official','physio','sponsor'];
const ORG_ROLES = ['academy','organisation'];
const ALL_ROLES = [...PERSONAL_ROLES, ...ORG_ROLES];

async function getOfficialState(userId) {
  const p = await one('SELECT status, completeness_pct, step_reached FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [userId]).catch(() => null);
  if (!p) return { status: 'not_started', completeness_pct: 0, step_reached: null, entry_route: 'OfficialProfileWizard' };
  return { status: p.status === 'published' ? 'published' : 'in_progress', completeness_pct: p.completeness_pct ?? 0, step_reached: p.step_reached, entry_route: 'OfficialProfileWizard' };
}

async function getCoachState(userId) {
  const p = await one('SELECT status, completeness_pct, step_reached FROM coach_profiles WHERE user_id=$1', [userId]).catch(() => null);
  if (!p) return { status: 'not_started', completeness_pct: 0, step_reached: null, entry_route: 'CoachProfileWizard' };
  return { status: p.status === 'published' ? 'published' : 'in_progress', completeness_pct: p.completeness_pct ?? 0, step_reached: p.step_reached, entry_route: 'CoachProfileWizard' };
}

async function getPhysioState(userId) {
  const p = await one('SELECT status, completeness_pct, step_reached FROM physio_profiles WHERE user_id=$1', [userId]).catch(() => null);
  if (!p) return { status: 'not_started', completeness_pct: 0, step_reached: null, entry_route: 'PhysioProfileWizard' };
  return { status: p.status === 'published' ? 'published' : 'in_progress', completeness_pct: p.completeness_pct ?? 0, step_reached: p.step_reached, entry_route: 'PhysioProfileWizard' };
}

async function getSponsorState(userId) {
  const identities = await many('SELECT se.id, se.identity_confirmed FROM sponsor_entities se JOIN sponsor_representatives sr ON sr.entity_id=se.id WHERE sr.user_id=$1 AND sr.left_at IS NULL LIMIT 1', [userId]).catch(() => []);
  if (!identities.length) return { status: 'not_started', completeness_pct: 0, step_reached: null, entry_route: 'SponsorWizard' };
  const e = identities[0];
  const confirmed = e.identity_confirmed;
  return { status: confirmed ? 'published' : 'in_progress', completeness_pct: confirmed ? 80 : 20, step_reached: confirmed ? 4 : 1, entry_route: 'SponsorWizard' };
}

async function getAcademyState(userId) {
  const orgs = await many("SELECT o.id, o.status FROM organisations o JOIN org_members om ON om.org_id=o.id WHERE om.user_id=$1 AND o.kind='academy' AND om.left_at IS NULL LIMIT 5", [userId]).catch(() => []);
  if (!orgs.length) return { status: 'not_started', completeness_pct: 0, step_reached: null, entry_route: 'OrgWizard', entry_params: { kind: 'academy' } };
  const approved = orgs.filter(o => o.status === 'approved');
  const pct = approved.length > 0 ? 70 : 30;
  return { status: approved.length > 0 ? 'published' : 'in_progress', completeness_pct: pct, step_reached: null, entry_route: 'AcademySetup', entity_ids: orgs.map(o => o.id) };
}

async function getOrgState(userId) {
  const orgs = await many("SELECT o.id, o.status FROM organisations o JOIN org_members om ON om.org_id=o.id WHERE om.user_id=$1 AND o.kind != 'academy' AND om.left_at IS NULL LIMIT 5", [userId]).catch(() => []);
  if (!orgs.length) return { status: 'not_started', completeness_pct: 0, step_reached: null, entry_route: 'OrgWizard' };
  const approved = orgs.filter(o => o.status === 'approved');
  return { status: approved.length > 0 ? 'published' : 'in_progress', completeness_pct: approved.length > 0 ? 65 : 25, step_reached: null, entry_route: 'OrgWizard', entity_ids: orgs.map(o => o.id) };
}

cap({
  name: 'get_onboarding_roles', method: 'GET', path: '/me/onboarding/roles', tag: TAG,
  summary: 'All 6 role setup states: status, completeness_pct, entry_route, step_reached. No cross-role PII.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const uid = user.id;
    const [official, coach, physio, sponsor, academy, organisation] = await Promise.all([
      getOfficialState(uid),
      getCoachState(uid),
      getPhysioState(uid),
      getSponsorState(uid),
      getAcademyState(uid),
      getOrgState(uid),
    ]);
    const roles = [
      { role: 'official', label: 'Official / Referee', section: 'personal', icon: '🏳️', ...official },
      { role: 'coach', label: 'Coach', section: 'personal', icon: '🎯', ...coach },
      { role: 'physio', label: 'Physio / Clinician', section: 'personal', icon: '🩺', ...physio },
      { role: 'sponsor', label: 'Sponsor', section: 'personal', icon: '🏆', ...sponsor },
      { role: 'academy', label: 'Academy', section: 'organisation', icon: '🏫', ...academy },
      { role: 'organisation', label: 'Club / Organisation', section: 'organisation', icon: '🏟️', ...organisation },
    ];
    // load dismiss states
    const dismissed = await many('SELECT role, dismissed_at FROM onboarding_role_states WHERE user_id=$1', [uid]).catch(() => []);
    const dismissMap = Object.fromEntries(dismissed.map(d => [d.role, d.dismissed_at]));
    return roles.map(r => ({ ...r, dismissed: !!dismissMap[r.role] }));
  },
});

cap({
  name: 'dismiss_onboarding_role', method: 'POST', path: '/me/onboarding/roles/:role/dismiss', tag: TAG,
  summary: 'Dismiss the setup CTA for a role ("set up later"). Does not block future setup.',
  input: z.object({ role: z.enum(ALL_ROLES) }),
  async handler({ user, params }) {
    await requireApproved(user);
    const role = params.role;
    if (!ALL_ROLES.includes(role)) throw badRequest('Unknown role');
    await one(
      `INSERT INTO onboarding_role_states (user_id, role, dismissed_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (user_id, role) DO UPDATE SET dismissed_at=now(), updated_at=now()`,
      [user.id, role]
    );
    return { dismissed: true };
  },
});
