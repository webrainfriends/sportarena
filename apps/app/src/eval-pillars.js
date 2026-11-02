// Pillars group the criteria of an evaluation sheet. The usual ones have translated names; a coach can name any other group, so a sport is never forced
// into groups that do not fit it. The order is the order the sheet lists its criteria in.
import { t } from './i18n';

export const STANDARD_PILLARS = ['technical', 'tactical', 'physical', 'mental', 'behaviour', 'lifestyle', 'other'];
export const pillarName = (key, labels) => labels?.[key] ?? (STANDARD_PILLARS.includes(key) ? t(`es.pillar.${key}`) : String(key).replace(/_/g, ' '));
export const pillarKey = (name) => String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
/** Pillars in first-use order across criteria (criteria need `pillar`). */
export const orderOf = (criteria) => [...new Set(criteria.map((x) => x.pillar ?? 'other'))];
/** Whether a criterion is scored by typing a number (a time, a distance, a judge's score, a count) rather than tapping a level. */
export const isNumeric = (d) => d.input === 'number' || !!d.unit || (d.scale_max - d.scale_min) / (d.step ?? 1) > 10 || (d.step != null && d.step % 1 !== 0);
