// The role workspace and the setup checklist come from the API with English text and a stable `key`. Translate by key here, and fall back to the
// server's own text for any key without a translation, so a new server item is never blank. (Server error/notification codes are a later batch.)
import { t } from './i18n';
import { hasKey } from './i18n/core';
import { roleLabel } from './roles';

const pick = (key, params, fallback) => (hasKey(key) ? t(key, params) : fallback);

const HINT = {
  'Create an event first': 'ws.hint.create_event_first', 'No event to scan for yet': 'ws.hint.no_event_scan', 'No event yet': 'ws.hint.no_event',
  'No upcoming assignment': 'ws.hint.no_assignment', 'Register a venue first': 'ws.hint.register_venue', 'No venue yet': 'ws.hint.no_venue',
};
export const hintText = (s) => (s && HINT[s] ? t(HINT[s]) : s);

export const statLabel = (role, s) => pick(`ws.stat.${role}.${s.key}`, undefined, s.label);

export const actionLabel = (role, a) => {
  if (a.key === 'home') return role ? t('ws.act.open_own', { role: roleLabel(role).toLowerCase() }) : t('ws.act.open_workspace');
  return pick(`ws.act.${role}.${a.key}`, undefined, pick(`ws.act.${a.key}`, undefined, a.label));
};

/** Persona label and blurb of the setup checklist. */
export const personaLabel = (p) => pick(`setup.p.${p.key}`, undefined, p.label);
export const personaBlurb = (p) => pick(`setup.pb.${p.key}`, undefined, p.blurb);

/** A setup step's title / why. A step can read differently per persona (e.g. the first transaction), so try `<key>_<persona>` first. */
export const stepTitle = (s, persona) => pick(`setup.step.${s.key}_${persona}.t`, undefined, pick(`setup.step.${s.key}.t`, undefined, s.title));
export const stepWhy = (s, persona, noOrg) => pick(noOrg ? `setup.step.${s.key}_none.w` : `setup.step.${s.key}_${persona}.w`, undefined, pick(`setup.step.${s.key}.w`, undefined, s.why));
