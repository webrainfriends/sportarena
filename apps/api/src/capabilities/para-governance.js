// Para-sport Classification (#488) 1/3: governed, versioned class definitions and verified classifier credentials.
// A governing body publishes a version per sport/discipline (immutable once published); historical outcomes stay linked to the version used at the time.
// A classifier is only ever a row in para_classifiers: a coach, doctor, referee or administrator is not one, and a clinical credential alone confers nothing.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { authority, need, mustBeActive, canSome } from '../federation.js';
import { hist, today } from '../para.js';

const TAG = 'Para classification';
const t = (n) => z.string().trim().max(n);
const day = z.string().date();
const CLASS = z.object({
  code: t(20).min(1), name: t(120).min(1),
  events: z.array(t(60)).max(60).default([]).describe('events/disciplines within the sport this class applies to'),
  categories: z.array(t(60)).max(30).default([]).describe('competition categories it applies to'),
  status_rules: t(500).optional().describe('how the review/status rules of the governing document apply to this class'),
}).strict();

async function sportOfBody(c, bodyId, sportId, discipline) {
  const ok = (await c.query("SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL AND (discipline='' OR $3='' OR discipline=$3)", [bodyId, sportId, discipline])).rowCount;
  if (!ok) throw badRequest('That governing body does not govern this sport/discipline');
}

const VERSION_COLS = `v.id, v.body_id, org.name AS authority, v.sport_id, s.name AS sport, v.discipline, v.version, v.title, v.source_ref, v.effective_from::text AS effective_from, v.effective_to::text AS effective_to,
  v.status, v.panel_size, v.review_rule, v.review_months, v.appeal_days, v.published_at,
  coalesce((SELECT json_agg(json_build_object('id', k.id, 'code', k.code, 'name', k.name, 'events', k.events, 'categories', k.categories, 'status_rules', k.status_rules) ORDER BY k.code) FROM para_classes k WHERE k.version_id=v.id), '[]') AS classes`;
const VERSION_FROM = 'para_class_versions v JOIN governing_bodies b ON b.id=v.body_id JOIN organisations org ON org.id=b.organisation_id JOIN sports s ON s.id=v.sport_id';

cap({
  name: 'create_para_class_version', method: 'POST', path: '/para/class-versions', tag: TAG, scope: 'admin', status: 201,
  summary: 'Draft a new classification version for a sport/discipline, transcribed from the governing body\'s own document. Nothing is invented: the source reference is required and the version is inert until published.',
  input: z.object({
    body_id: id, sport_id: id, discipline: t(60).default(''), title: t(120).min(2), source_ref: t(500).min(2).describe('the governing document, rulebook section or URL this version transcribes'),
    effective_from: day, panel_size: z.number().int().min(1).max(7).default(1).describe('classifiers who must independently agree under the governing process'),
    review_rule: z.enum(['none', 'fixed_term', 'review_required']).default('none'), review_months: z.number().int().min(1).max(240).optional(),
    appeal_days: z.number().int().min(1).max(365).default(14), classes: z.array(CLASS).min(1).max(120),
  }).strict().refine((i) => i.review_rule === 'none' || i.review_months, { message: 'review_months is required when a review rule applies' }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.body_id, { c });
    need(auth, 'governance', i.sport_id);
    mustBeActive(auth.body);
    await sportOfBody(c, i.body_id, i.sport_id, i.discipline);
    const codes = i.classes.map((k) => k.code.toUpperCase());
    if (new Set(codes).size !== codes.length) throw badRequest('Class codes must be unique within a version');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`para:${i.body_id}:${i.sport_id}:${i.discipline}`]);
    const n = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM para_class_versions WHERE body_id=$1 AND sport_id=$2 AND discipline=$3', [i.body_id, i.sport_id, i.discipline])).rows[0].n;
    const v = (await c.query(
      `INSERT INTO para_class_versions(body_id, sport_id, discipline, version, title, source_ref, effective_from, panel_size, review_rule, review_months, appeal_days, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, version`,
      [i.body_id, i.sport_id, i.discipline, n, i.title, i.source_ref, i.effective_from, i.panel_size, i.review_rule, i.review_months ?? null, i.appeal_days, user.id])).rows[0];
    for (const k of i.classes) await c.query('INSERT INTO para_classes(version_id, code, name, events, categories, status_rules) VALUES ($1,$2,$3,$4,$5,$6)', [v.id, k.code.toUpperCase(), k.name, k.events, k.categories, k.status_rules ?? null]);
    await hist(c, 'version', v.id, null, 'drafted', { to: 'draft', actor: user.id, detail: { version: n } });
    return { id: v.id, version: n, status: 'draft' };
  }),
});

cap({
  name: 'publish_para_class_version', method: 'POST', path: '/para/class-versions/:id/publish', tag: TAG, scope: 'admin',
  summary: 'Publish a drafted classification version. It becomes immutable; the previous published version of the same sport/discipline is retired for new cases, while every outcome already issued stays linked to the version it used.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const v = (await c.query('SELECT * FROM para_class_versions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!v) throw notFound('Classification version');
    const auth = await authority(user, v.body_id, { c, optional: true });
    if (!auth) throw notFound('Classification version');
    need(auth, 'governance', v.sport_id);
    mustBeActive(auth.body);
    if (v.status !== 'draft') throw conflict(`This version is already ${v.status}`);
    // dual control: the person who drafted a version does not publish it when someone else holds the authority
    if (v.created_by === user.id && !auth.admin) throw conflict('A second officer publishes a version after it has been drafted');
    await c.query("UPDATE para_class_versions SET status='retired', effective_to=$4 WHERE body_id=$1 AND sport_id=$2 AND discipline=$3 AND status='published'",
      [v.body_id, v.sport_id, v.discipline, v.effective_from]);
    await c.query("UPDATE para_class_versions SET status='published', published_by=$2, published_at=now() WHERE id=$1", [v.id, user.id]);
    await hist(c, 'version', v.id, null, 'published', { from: 'draft', to: 'published', actor: user.id, detail: { version: v.version } });
    return { id: v.id, version: v.version, status: 'published' };
  }),
});

cap({
  name: 'list_para_class_versions', method: 'GET', path: '/para/class-versions', tag: TAG,
  summary: 'Published classification versions (class codes and names only) for a sport, so athletes and competitions can pick from the real catalogue. Staff of the issuing body also see its drafts. A sport with no published version has no governed classification: it is reported as a gap, never defaulted.',
  input: z.object({ sport_id: id.optional(), body_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT ${VERSION_COLS} FROM ${VERSION_FROM} WHERE ($1::uuid IS NULL OR v.sport_id=$1) AND ($2::uuid IS NULL OR v.body_id=$2) AND v.status <> 'draft'
        ORDER BY s.name, v.discipline, v.version DESC LIMIT $3 OFFSET $4`, [i.sport_id ?? null, i.body_id ?? null, i.limit, i.offset]);
    let drafts = [];
    if (i.body_id) {
      const auth = await authority(user, i.body_id, { optional: true });
      if (auth && canSome(auth, 'governance')) drafts = await many(`SELECT ${VERSION_COLS} FROM ${VERSION_FROM} WHERE v.body_id=$1 AND v.status='draft' AND ($2::uuid IS NULL OR v.sport_id=$2) ORDER BY v.created_at DESC`, [i.body_id, i.sport_id ?? null]);
    }
    return { versions: [...drafts, ...rows], note: 'A competition class is an administrative sporting classification, not a medical diagnosis.' };
  },
});

cap({
  name: 'para_sport_coverage', method: 'GET', path: '/para/coverage', tag: TAG,
  summary: 'Which catalogue sports have a published governed classification definition and which do not. Sports without one are labelled as a gap; no generic default is applied.',
  input: z.object({}),
  handler: async () => {
    const rows = await many(
      `SELECT s.id, s.slug, s.name, s.category, EXISTS (SELECT 1 FROM para_class_versions v WHERE v.sport_id=s.id AND v.status='published') AS has_definition FROM sports s ORDER BY s.name`);
    return { sports: rows.map((r) => ({ ...r, coverage: r.has_definition ? 'governed' : 'gap', label: r.has_definition ? 'Governed definition published' : 'No governing definition published — classification unavailable' })) };
  },
});

// ------------------------------------------------------------------ classifier credentials
const CLASSIFIER_COLS = `k.id, k.user_id, u.display_name AS name, k.body_id, org.name AS issuing_body, k.sport_id, s.name AS sport, k.discipline, k.class_codes, k.jurisdiction, k.grade,
  k.issued_on::text AS issued_on, k.expires_on::text AS expires_on, k.status, (k.status='active' AND k.expires_on >= current_date AND k.issued_on <= current_date) AS live, k.ended_reason`;
const CLASSIFIER_FROM = 'para_classifiers k JOIN users u ON u.id=k.user_id JOIN governing_bodies b ON b.id=k.body_id JOIN organisations org ON org.id=b.organisation_id JOIN sports s ON s.id=k.sport_id';

cap({
  name: 'grant_para_classifier', method: 'POST', path: '/para/classifiers', tag: TAG, scope: 'admin', status: 201,
  summary: 'Issue a classifier credential: sport/discipline scope, the classes they may assess, issuing body, grade and validity. Holding a clinical, coaching, refereeing or admin role confers no classifier authority.',
  input: z.object({
    body_id: id, user_id: id, sport_id: id, discipline: t(60).default(''), class_codes: z.array(t(20)).max(120).default([]).describe('empty = every class of the sport/discipline'),
    jurisdiction: t(60).optional(), grade: t(60).min(1), credential_no: t(80).optional(), issued_on: day, expires_on: day,
  }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.body_id, { c });
    need(auth, 'governance', i.sport_id);
    mustBeActive(auth.body);
    await sportOfBody(c, i.body_id, i.sport_id, i.discipline);
    if (i.expires_on < i.issued_on) throw badRequest('The credential cannot expire before it is issued');
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.user_id])).rowCount) throw notFound('Person');
    if (i.class_codes.length) {
      const known = (await c.query("SELECT code FROM para_classes k JOIN para_class_versions v ON v.id=k.version_id WHERE v.body_id=$1 AND v.sport_id=$2 AND v.status='published'", [i.body_id, i.sport_id])).rows.map((r) => r.code);
      const bad = i.class_codes.filter((x) => !known.includes(x.toUpperCase()));
      if (bad.length) throw badRequest(`Not classes of a published version: ${bad.join(', ')}`);
    }
    const r = (await c.query(
      `INSERT INTO para_classifiers(user_id, body_id, sport_id, discipline, class_codes, jurisdiction, grade, credential_no_enc, issued_on, expires_on, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [i.user_id, i.body_id, i.sport_id, i.discipline, i.class_codes.map((x) => x.toUpperCase()), i.jurisdiction ?? null, i.grade, i.credential_no ? encrypt(i.credential_no, 'para_classifiers.credential_no') : null, i.issued_on, i.expires_on, user.id])).rows[0];
    await hist(c, 'classifier', r.id, null, 'granted', { to: 'active', actor: user.id, detail: { sport_id: i.sport_id } });
    await notify(c, i.user_id, { kind: 'para_classifier', title: 'Classifier credential issued', body: `You can assess para classifications for ${auth.body.name} within your credential's scope.`, data: { id: r.id } });
    return { id: r.id, status: 'active' };
  }),
});

cap({
  name: 'end_para_classifier', method: 'POST', path: '/para/classifiers/:id/end', tag: TAG, scope: 'admin',
  summary: 'Suspend, reinstate or revoke a classifier credential. Takes effect on the next decision: authority is read live, and nothing already issued is rewritten.',
  input: z.object({ id, action: z.enum(['suspend', 'reinstate', 'revoke']), reason: t(500).min(2) }),
  handler: ({ user }, i) => tx(async (c) => {
    const k = (await c.query('SELECT * FROM para_classifiers WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!k) throw notFound('Classifier');
    const auth = await authority(user, k.body_id, { c, optional: true });
    if (!auth) throw notFound('Classifier');
    need(auth, 'governance', k.sport_id);
    const to = { suspend: 'suspended', reinstate: 'active', revoke: 'revoked' }[i.action];
    if (k.status === 'revoked') throw conflict('A revoked credential stays revoked; issue a new one');
    if (k.status === to) throw conflict(`Already ${to}`);
    await c.query('UPDATE para_classifiers SET status=$2, ended_by=$3, ended_reason=$4 WHERE id=$1', [k.id, to, user.id, i.reason]);
    await hist(c, 'classifier', k.id, null, i.action, { from: k.status, to, actor: user.id });
    await notify(c, k.user_id, { kind: 'para_classifier', title: `Classifier credential ${to}`, body: i.reason, data: { id: k.id } });
    return { id: k.id, status: to };
  }),
});

cap({
  name: 'list_para_classifiers', method: 'GET', path: '/para/classifiers', tag: TAG, scope: 'admin',
  summary: 'The classifiers a governing body has credentialed, with scope, grade, validity and whether each is live today. Credential numbers are never listed.',
  input: z.object({ body_id: id, ...page }),
  handler: async ({ user }, i) => {
    const auth = await authority(user, i.body_id);
    if (!canSome(auth, 'governance')) throw notFound('Governing body');
    const rows = await many(`SELECT ${CLASSIFIER_COLS} FROM ${CLASSIFIER_FROM} WHERE k.body_id=$1 ORDER BY k.expires_on DESC, k.id LIMIT $2 OFFSET $3`, [i.body_id, i.limit, i.offset]);
    await audit(null, user.id, 'read_pii', 'para_classifiers', i.body_id);
    return { classifiers: rows };
  },
});

cap({
  name: 'my_para_classifier', method: 'GET', path: '/me/para-classifier', tag: TAG,
  summary: 'The caller\'s own classifier credentials and whether each is live today.',
  input: z.object({}),
  handler: async ({ user }) => ({ today: today(), credentials: await many(`SELECT ${CLASSIFIER_COLS} FROM ${CLASSIFIER_FROM} WHERE k.user_id=$1 ORDER BY k.expires_on DESC`, [user.id]) }),
});


cap({
  name: 'my_para_desk', method: 'GET', path: '/me/para-desk', tag: TAG, scope: 'clinical',
  summary: 'What the caller can do in para classification: their wards, the governing bodies they run classification for, whether they hold classifier credentials, and how much waits for them. Drives which tabs the app shows.',
  input: z.object({}),
  handler: async ({ user }) => {
    const [wards, bodies, creds, assigned, appeals] = await Promise.all([
      many("SELECT u.id, u.display_name AS name FROM guardian_links l JOIN users u ON u.id=l.child_id WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) ORDER BY u.display_name", [user.id]),
      many(`SELECT b.id, org.name FROM governing_bodies b JOIN organisations org ON org.id=b.organisation_id
             WHERE b.status='active' AND (EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin'))
                OR EXISTS (SELECT 1 FROM governing_body_roles r WHERE r.body_id=b.id AND r.user_id=$1 AND r.status='active' AND r.role='secretary')) ORDER BY org.name`, [user.id]),
      many(`SELECT ${CLASSIFIER_COLS} FROM ${CLASSIFIER_FROM} WHERE k.user_id=$1 ORDER BY k.expires_on DESC`, [user.id]),
      one("SELECT count(*)::int AS n FROM para_case_panel p JOIN para_classifiers k ON k.id=p.classifier_id JOIN para_cases c ON c.id=p.case_id WHERE k.user_id=$1 AND c.status IN ('submitted','evidence_review','assessment_scheduled','assessment_completed','panel_review')", [user.id]),
      one("SELECT count(*)::int AS n FROM para_appeals a JOIN para_classifiers k ON k.id=a.reviewer_id WHERE k.user_id=$1 AND a.status='open'", [user.id]),
    ]);
    return { wards, governs: bodies, classifier: creds, classifier_live: creds.some((x) => x.live), assigned_cases: assigned.n, assigned_appeals: appeals.n };
  },
});
