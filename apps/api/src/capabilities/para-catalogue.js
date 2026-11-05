// PS-01 (#831) Governed para-sport catalogue: discovery and approval lifecycle on top of the existing sports catalogue and the governed classification
// versions (#488). Para sports are flagged rows of `sports`; this file adds NO second catalogue, only the discovery read and the approval workflow
// (submit / reject / roll back / deprecate); the catalogue list itself is para_sport_coverage. Publishing stays in publish_para_class_version; event pinning lives on the discipline capabilities.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { authority, need, mustBeActive } from '../federation.js';
import { hist } from '../para.js';
import { sha, STATE_SQL, LABEL } from '../para-catalogue.js';

const TAG = 'Para classification';

cap({
  name: 'get_para_sport', method: 'GET', path: '/para/sports/:sport', tag: TAG, auth: 'public',
  summary: 'One para sport for discovery and registration: its governed rule versions with governing body, publisher, official source URL, effective/expiry dates, scope, event categories, adaptations, permitted participant and support roles, classes and a rule reference (version id + content hash). Also states which participation contexts exist: recreational and mixed-ability never require classification; sanctioned requires it only where the governing rule says so. Optionally pass country_iso to include regional governance metadata for that country.',
  input: z.object({ sport: z.string().trim().min(1).max(80), country_iso: z.string().trim().length(2).toUpperCase().optional() }),
  handler: async (_, i) => {
    const s = await one(
      `SELECT s.id, s.slug, s.name, s.emoji, s.play_type, s.programmes, b.slug AS base_slug, b.name AS base_name, ${STATE_SQL} AS state FROM sports s LEFT JOIN sports b ON b.id=s.base_sport_id
        WHERE s.is_para AND (s.slug=$1 OR s.id::text=$1)`, [i.sport]);
    if (!s) throw notFound('Para sport');
    const versions = await many(
      `SELECT v.id, v.version, v.discipline, v.title, org.name AS authority, v.publisher, v.source_url, v.source_ref, v.effective_from::text AS effective_from, v.effective_to::text AS effective_to,
              v.status, v.approval_status, v.scope_countries, v.scope_competitions, v.event_categories, v.adaptations, v.permitted_roles, v.classification_required, v.supersedes_id, v.deprecated_at, v.deprecated_reason,
              v.published_at,
              coalesce((SELECT json_agg(json_build_object('code', k.code, 'name', k.name, 'events', k.events, 'categories', k.categories) ORDER BY k.code) FROM para_classes k WHERE k.version_id=v.id), '[]') AS classes,
              coalesce((SELECT json_agg(json_build_object('action', h.action, 'from', h.from_status, 'to', h.to_status, 'at', h.created_at) ORDER BY h.id) FROM para_history h WHERE h.subject_type='version' AND h.subject_id=v.id), '[]') AS history
         FROM para_class_versions v JOIN governing_bodies b ON b.id=v.body_id JOIN organisations org ON org.id=b.organisation_id
        WHERE v.sport_id=$1 AND v.status <> 'draft' ORDER BY v.discipline, v.version DESC`, [s.id]);
    // PS-29: optional country-scoped regional governance records
    const regionalGovernance = i.country_iso
      ? await many(
          `SELECT id, country_iso, governing_body, source_url, source_ref, effective_from::text AS effective_from, effective_to::text AS effective_to,
                  event_divisions, accreditation_refs, federation_connection_type, review_status
             FROM para_regional_governance
            WHERE sport_id=$1 AND country_iso=$2 AND review_status IN ('sourced','verified')`,
          [s.id, i.country_iso])
      : [];
    return {
      sport: { ...s, label: LABEL[s.state] },
      versions: versions.map((v) => ({ ...v, rule_ref: { version_id: v.id, hash: sha({ id: v.id, version: v.version, source_url: v.source_url, classes: v.classes, event_categories: v.event_categories }) } })),
      regional_governance: regionalGovernance,
      contexts: [
        { key: 'sanctioned', classification: 'only where the pinned governing rule requires it', needs_version: true },
        { key: 'recreational', classification: 'never required', needs_version: false },
        { key: 'mixed_ability', classification: 'never required', needs_version: false },
      ],
      note: 'A competition class is an administrative sporting classification, not a medical diagnosis.',
    };
  },
});

const loadVersion = async (c, user, vid) => {
  const v = (await c.query('SELECT * FROM para_class_versions WHERE id=$1 FOR UPDATE', [vid])).rows[0];
  if (!v) throw notFound('Classification version');
  const auth = await authority(user, v.body_id, { c, optional: true });
  if (!auth) throw notFound('Classification version');
  need(auth, 'governance', v.sport_id);
  mustBeActive(auth.body);
  return { v, auth };
};

cap({
  name: 'submit_para_class_version', method: 'POST', path: '/para/class-versions/:id/submit', tag: TAG, scope: 'admin',
  summary: 'Submit a drafted rule version (with its official source) for approval by a second officer of the governing body. A rejected version is revised by drafting a new one.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { v } = await loadVersion(c, user, i.id);
    if (v.status !== 'draft' || !['draft'].includes(v.approval_status)) throw conflict(`This version is ${v.status === 'draft' ? v.approval_status : v.status}`);
    if (!v.source_url || !v.publisher) throw badRequest('An official source URL and publisher are required before submitting');
    await c.query("UPDATE para_class_versions SET approval_status='submitted', submitted_by=$2, submitted_at=now() WHERE id=$1", [v.id, user.id]);
    await hist(c, 'version', v.id, null, 'submitted', { from: 'draft', to: 'submitted', actor: user.id });
    await audit(c, user.id, 'para.version_submit', 'para_class_version', v.id);
    return { id: v.id, approval_status: 'submitted' };
  }),
});

cap({
  name: 'reject_para_class_version', method: 'POST', path: '/para/class-versions/:id/reject', tag: TAG, scope: 'admin',
  summary: 'Reject a submitted rule version with a reason. It is never published; the reason stays in the history.',
  input: z.object({ id, reason: z.string().trim().min(3).max(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { v, auth } = await loadVersion(c, user, i.id);
    if (v.approval_status !== 'submitted') throw conflict('Only a submitted version can be rejected');
    if (v.submitted_by === user.id && !auth.admin) throw conflict('A second officer decides on a submitted version');
    await c.query("UPDATE para_class_versions SET approval_status='rejected', rejected_reason=$2 WHERE id=$1", [v.id, i.reason]);
    await hist(c, 'version', v.id, null, 'rejected', { from: 'submitted', to: 'rejected', actor: user.id, detail: { reason: i.reason } });
    await audit(c, user.id, 'para.version_reject', 'para_class_version', v.id);
    return { id: v.id, approval_status: 'rejected' };
  }),
});

cap({
  name: 'rollback_para_class_version', method: 'POST', path: '/para/class-versions/:id/rollback', tag: TAG, scope: 'admin', status: 201,
  summary: 'Roll back to an earlier rule version without rewriting history: drafts a NEW version (next number) that copies a retired or deprecated one and records which it restores. It goes through submit and approval like any other; completed events keep the version they used.',
  input: z.object({ id, reason: z.string().trim().min(3).max(500), effective_from: z.string().date() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { v } = await loadVersion(c, user, i.id);
    if (v.status !== 'retired') throw conflict('Only a retired or deprecated version can be restored');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`para:${v.body_id}:${v.sport_id}:${v.discipline}`]);
    const n = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM para_class_versions WHERE body_id=$1 AND sport_id=$2 AND discipline=$3', [v.body_id, v.sport_id, v.discipline])).rows[0].n;
    const nv = (await c.query(
      `INSERT INTO para_class_versions(body_id, sport_id, discipline, version, title, source_ref, effective_from, panel_size, review_rule, review_months, appeal_days, created_by,
         source_url, publisher, scope_countries, scope_competitions, event_categories, adaptations, permitted_roles, classification_required, supersedes_id)
       SELECT body_id, sport_id, discipline, $2, title, source_ref, $3, panel_size, review_rule, review_months, appeal_days, $4,
         source_url, publisher, scope_countries, scope_competitions, event_categories, adaptations, permitted_roles, classification_required, id FROM para_class_versions WHERE id=$1 RETURNING id, version`,
      [v.id, n, i.effective_from, user.id])).rows[0];
    await c.query('INSERT INTO para_classes(version_id, code, name, events, categories, status_rules) SELECT $2, code, name, events, categories, status_rules FROM para_classes WHERE version_id=$1', [v.id, nv.id]);
    await hist(c, 'version', nv.id, null, 'rollback_drafted', { to: 'draft', actor: user.id, detail: { restores: v.id, version: n, reason: i.reason } });
    await audit(c, user.id, 'para.version_rollback', 'para_class_version', nv.id);
    return { id: nv.id, version: nv.version, status: 'draft', restores: v.id };
  }),
});

cap({
  name: 'deprecate_para_class_version', method: 'POST', path: '/para/class-versions/:id/deprecate', tag: TAG, scope: 'admin',
  summary: 'Deprecate a published rule version: no event can pin it from now on. Outcomes, cases and event snapshots that used it keep it unchanged.',
  input: z.object({ id, reason: z.string().trim().min(3).max(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { v } = await loadVersion(c, user, i.id);
    if (v.status !== 'published') throw conflict('Only a published version can be deprecated');
    await c.query("UPDATE para_class_versions SET status='retired', deprecated_at=now(), deprecated_reason=$2, effective_to=coalesce(effective_to, current_date) WHERE id=$1", [v.id, i.reason]);
    await hist(c, 'version', v.id, null, 'deprecated', { from: 'published', to: 'retired', actor: user.id, detail: { reason: i.reason } });
    await audit(c, user.id, 'para.version_deprecate', 'para_class_version', v.id);
    return { id: v.id, status: 'retired', deprecated: true };
  }),
});
