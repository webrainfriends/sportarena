// PS-01 (#831): shared rules for the governed para-sport catalogue. Para sports are rows of `sports` (is_para), never a second catalogue; the governed
// definition is para_class_versions (#488). Events pin one approved version with a frozen snapshot, so a later rule change never rewrites an event.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict } from './errors.js';
import { hist, outcomeAt } from './para.js';
import { audit } from './helpers.js';

/** A boolean that also accepts the strings 'true' / 'false' (query strings). */
export const qbool = () => z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
export const PROGRAMMES = ['paralympic_summer', 'paralympic_winter', 'other_adaptive'];
/** Per-sport governance state: governed (an approved, in-force version), awaiting (a draft/submitted one), deprecated (only withdrawn versions) or gap. */
export const STATE_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM para_class_versions v WHERE v.sport_id=s.id AND v.status='published' AND v.approval_status='approved' AND v.deprecated_at IS NULL) THEN 'governed'
  WHEN EXISTS (SELECT 1 FROM para_class_versions v WHERE v.sport_id=s.id AND v.status='draft' AND v.approval_status IN ('draft','submitted')) THEN 'awaiting'
  WHEN EXISTS (SELECT 1 FROM para_class_versions v WHERE v.sport_id=s.id) THEN 'deprecated' ELSE 'gap' END`;
export const LABEL = {
  governed: 'Governed definition published',
  awaiting: 'Rule version awaiting approval — not yet usable',
  deprecated: 'Governing definition withdrawn — historical records keep their version',
  gap: 'No governing definition published — classification unavailable',
};


export const CONTEXTS = ['standard', 'sanctioned', 'recreational', 'mixed_ability'];
export const sha = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

/** The reproducible content of a version (what a pin freezes). */
export async function versionContent(c, v) {
  const classes = (await c.query('SELECT code, name, events, categories, status_rules FROM para_classes WHERE version_id=$1 ORDER BY code', [v.id])).rows;
  const body = (await c.query('SELECT org.name FROM governing_bodies b JOIN organisations org ON org.id=b.organisation_id WHERE b.id=$1', [v.body_id])).rows[0];
  return {
    version_id: v.id, version: v.version, title: v.title, authority: body?.name ?? null, publisher: v.publisher, source_url: v.source_url, source_ref: v.source_ref,
    effective_from: String(v.effective_from).slice(0, 10), scope_countries: v.scope_countries, scope_competitions: v.scope_competitions,
    event_categories: v.event_categories, adaptations: v.adaptations, permitted_roles: v.permitted_roles, classification_required: v.classification_required, classes,
  };
}

/**
 * Validate and resolve the para fields of a discipline. Returns the column values to store, or null when nothing para-related is being changed.
 * Sanctioned = a governed, approved, in-force version is mandatory and cannot be swapped silently; recreational / mixed-ability never need classification.
 */
export async function resolvePara(c, user, d, sport, i) {
  const touched = i.participation_context !== undefined || i.para_version_id !== undefined || i.para_categories !== undefined;
  if (!touched) return null;
  const context = i.participation_context ?? d?.participation_context ?? 'standard';
  const versionId = i.para_version_id !== undefined ? i.para_version_id : d?.para_version_id ?? null;
  const categories = i.para_categories ?? d?.para_categories ?? [];
  if (context === 'standard') {
    if (versionId || categories.length) throw badRequest('A standard discipline carries no para rule version; choose sanctioned, recreational or mixed-ability');
    if (d?.para_version_id) throw conflict('A pinned rule version is never removed; choose recreational or mixed-ability and record why');
    return { context, versionId: null, categories: [], snapshot: null, hash: null, changed: false };
  }
  if (!sport.is_para) throw badRequest('Participation contexts apply to para / adaptive sports only');
  const pinned = d?.para_version_id ?? null;
  const changed = (pinned ?? null) !== (versionId ?? null) || (d?.participation_context ?? 'standard') !== context;
  if (d && pinned && changed) {
    if (!['nominations', 'scheduled'].includes(d.status)) throw conflict(`The rule version of a ${d.status} discipline cannot change`);
    if (!i.para_change_reason) throw badRequest('para_change_reason is required to change a pinned rule version or participation context');
  }
  if (context === 'sanctioned' && !versionId) throw badRequest('A sanctioned discipline must pin a governed rule version');
  let snapshot = d?.para_snapshot ?? null; let hash = d?.para_snapshot_hash ?? null;
  if (versionId && versionId !== pinned) {
    const v = (await c.query('SELECT * FROM para_class_versions WHERE id=$1', [versionId])).rows[0];
    if (!v || v.sport_id !== sport.id) throw badRequest('That rule version is not a version of this sport');
    if (v.status !== 'published' || v.approval_status !== 'approved' || v.deprecated_at) throw conflict('Only an approved, in-force rule version can be pinned');
    if (context === 'sanctioned' && v.effective_from > new Date().toISOString().slice(0, 10)) throw conflict('That rule version is not yet in force');
    snapshot = { ...(await versionContent(c, v)), participation_context: context };
    hash = sha(snapshot);
  }
  const base = snapshot?.event_categories ?? [];
  if (categories.length && versionId && base.length && categories.some((x) => !base.includes(x))) throw badRequest('Event categories must come from the pinned rule version');
  return { context, versionId: versionId ?? null, categories, snapshot, hash, changed: !!d && changed };
}

/** Store the resolved para fields on the discipline and write the append-only trail. */
export async function savePara(c, user, discId, r, reason = null) {
  if (!r) return;
  await c.query(
    `UPDATE event_disciplines SET participation_context=$2, para_version_id=$3, para_categories=$4, para_snapshot=$5, para_snapshot_hash=$6,
       para_pinned_by=CASE WHEN $3::uuid IS NOT NULL THEN $7::uuid ELSE para_pinned_by END, para_pinned_at=CASE WHEN $3::uuid IS NOT NULL THEN now() ELSE para_pinned_at END WHERE id=$1`,
    [discId, r.context, r.versionId, r.categories, r.snapshot, r.hash, user.id]);
  await hist(c, 'event_discipline', discId, null, r.changed ? 'rule_version_changed' : 'rule_version_pinned', { to: r.context, actor: user.id, detail: { version_id: r.versionId, hash: r.hash, reason } });
  await audit(c, user.id, 'para.discipline_pin', 'event_discipline', discId);
}

/**
 * Does this person meet the classification requirement of a discipline's pinned governed rule? (PS-01 follow-up)
 * Only a SANCTIONED discipline whose frozen snapshot says classification is required asks anything; standard, recreational and mixed-ability disciplines never do.
 * Reads the governed outcome in force now (never a typed class), then a live provisional approval already granted for the event. Returns null when nothing is required.
 */
export async function disciplineClassCheck(c, d, userId, at = new Date()) {
  if (d.participation_context !== 'sanctioned' || !d.para_snapshot?.classification_required) return null;
  const src = (o) => ({ kind: 'para_outcome', id: o.id, class_code: o.class_code, class_status: o.status, label: o.authority, version: o.version });
  if (!userId) return { status: 'pending', code: 'classification.no_account', reason: 'This rule requires a classification, which can only be checked for a participant with a linked athlete account' };
  const o = await outcomeAt(c, userId, d.sport_id, at);
  const day = at.toISOString().slice(0, 10);
  const allowed = (d.para_snapshot.classes ?? []).map((k) => String(k.code).toUpperCase());
  if (o) {
    if (o.status === 'not_eligible') return { status: 'fail', code: 'classification.not_eligible', reason: 'Classification: not eligible for this sport', source: src(o) };
    if (o.status === 'review_required' || (o.review_by && o.review_by < day)) return { status: 'pending', code: 'classification.review', reason: `Classification ${o.class_code ?? ''} needs review`.replace('  ', ' '), source: src(o) };
    if (allowed.length && !allowed.includes(String(o.class_code).toUpperCase())) return { status: 'fail', code: 'classification.class_outside', reason: `Class ${o.class_code} is not a class of this rule version`, source: src(o) };
    return { status: 'pass', code: 'classification.pass', reason: `Class ${o.class_code} confirmed by ${o.authority}`, source: src(o) };
  }
  const prov = (await c.query('SELECT id, valid_until::text AS valid_until FROM para_provisional WHERE event_id=$1 AND user_id=$2 AND revoked_at IS NULL AND valid_until >= $3::date ORDER BY created_at DESC LIMIT 1', [d.event_id, userId, day])).rows[0];
  if (prov) return { status: 'waived', code: 'classification.waived', reason: `Provisional participation approved until ${prov.valid_until}`, source: { kind: 'para_provisional', id: prov.id, valid_until: prov.valid_until } };
  return { status: 'pending', code: 'classification.none', reason: 'No authorised classification on record, and this rule requires one' };
}
