// Officials development background work (#486): gentle, content-free reminders. Licence renewal reminders already come from the federation sweep, so this only
// covers what is new: an assessment report that is due or overdue, and a fitness/competency result about to lapse. Idempotent: every notification is deduplicated.
import { tx, many } from './db.js';
import { notify } from './notify.js';

/** Assessors are reminded two days before a report is due, and once more when it is overdue. */
export async function remindAssessors() {
  let n = 0;
  for (const o of await many(
    `SELECT o.id, o.assessor_id, o.due_on, (o.due_on - current_date)::int AS left FROM off_observations o WHERE o.status IN ('assigned','accepted') AND o.due_on IS NOT NULL AND o.due_on <= current_date + 2 ORDER BY o.due_on LIMIT 500`)) {
    const late = o.left < 0;
    n += await tx(async (c) => (await notify(c, o.assessor_id, { kind: late ? 'official_observation_overdue' : 'official_observation_due', title: late ? 'An assessment report is overdue' : 'An assessment report is due soon', body: 'Open Officials development.', data: { observation_id: o.id }, dedupe_key: `off-obs-${late ? 'overdue' : 'due'}:${o.id}:${o.assessor_id}` })) ? 1 : 0);
  }
  return n;
}

/** Officials are told 30 days before a fitness/competency result stops being valid. */
export async function remindFitness() {
  let n = 0;
  for (const r of await many(
    `SELECT DISTINCT ON (r.official_id, r.test_type_id) r.id, r.official_id, r.valid_until::text AS valid_until, t.name FROM off_fitness_results r JOIN off_fitness_test_types t ON t.id=r.test_type_id
      WHERE r.voided_at IS NULL AND r.outcome <> 'fail' AND r.valid_until BETWEEN current_date AND current_date + 30 ORDER BY r.official_id, r.test_type_id, r.taken_on DESC LIMIT 500`)) {
    n += await tx(async (c) => (await notify(c, r.official_id, { kind: 'official_fitness_expiring', title: `${r.name} is due again`, body: `Your current result is valid until ${r.valid_until}.`, data: { result_id: r.id }, dedupe_key: `off-fit-expiring:${r.id}` })) ? 1 : 0);
  }
  return n;
}

export const runOfficialsSweeps = async () => ({ assessor_reminders: await remindAssessors(), fitness_reminders: await remindFitness() });
