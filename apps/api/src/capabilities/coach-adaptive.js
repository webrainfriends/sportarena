// Adaptive coaching expertise & credential discovery (#837). One definition -> REST + OpenAPI + MCP. Rules live in src/coach-adaptive.js.
// Reuses: coach profiles + verification cases (credentials), #808 need catalogue and guardian authority, coach hires. Search filters live in `list_coaches`.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many, one } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { catalogue, adaptiveFor, DISCIPLINE_KEYS, FORMATS, COMM, DISCLAIMER } from '../coach-adaptive.js';
import { checkNeeds, SHARE_MONTHS_MAX, typeOfNeed } from '../inclusion.js';
import { actingFor, screen } from '../wellbeing.js';

const TAG = 'Adaptive coaching';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const sealTraining = (t) => (t ? encrypt(t, 'coach_adaptive_expertise.training') : null);
const unsealTraining = (e) => (e ? decrypt(e, 'coach_adaptive_expertise.training') : null);
const pickOf = (allowed, label) => z.array(z.string()).max(12).default([]).refine((a) => a.every((k) => allowed.includes(k)), `Unknown ${label}`);

cap({
  name: 'get_adaptive_catalogue', method: 'GET', path: '/coaches/adaptive/catalogue', tag: TAG, auth: 'public',
  summary: 'The governed vocabulary for adaptive coaching: para disciplines, delivery formats, communication support, credential states and the fixed credential disclaimer. Sports without a native template use the labelled generic fallback.',
  handler: async () => catalogue(),
});

cap({
  name: 'get_my_adaptive_coaching', method: 'GET', path: '/me/coach-adaptive', tag: TAG, auth: ['coach'],
  summary: 'Coach: your adaptive-coaching opt-in, delivery and communication support, declared expertise with its live credential state (verified, self-declared, expired, revoked), and your coach credential cases.',
  async handler({ user }) {
    const a = (await adaptiveFor([user.id], { includePrivate: true })).get(user.id);
    const expertise = a.expertise.map(({ training_enc, ...e }) => ({ ...e, specialist_training: unsealTraining(training_enc) }));
    const cases = await many(`SELECT id, case_no, status, issuing_authority, credential_title, scope_disciplines, credential_expires_on, expires_at, decision_reason, submitted_at FROM verification_cases WHERE type='coach' AND subject_type='user' AND subject_id=$1 ORDER BY submitted_at DESC`, [user.id]);
    return { ...a, expertise, cases, disclaimer: DISCLAIMER };
  },
});

cap({
  name: 'set_my_adaptive_coaching', method: 'POST', path: '/me/coach-adaptive', tag: TAG, auth: ['coach'],
  summary: 'Coach: opt in or out of adaptive-coaching listing and say which delivery formats and communication support you offer. Opt-in is yours alone and can be switched off at any time; your data is kept.',
  input: z.object({ opt_in: z.boolean(), formats: pickOf(FORMATS, 'delivery format').optional(), comm: pickOf(COMM, 'communication support').optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await c.query('INSERT INTO coach_profiles(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [user.id]);
      await c.query(`UPDATE coach_profiles SET adaptive_opt_in=$2, adaptive_opt_in_at=CASE WHEN $2 AND NOT adaptive_opt_in THEN now() ELSE adaptive_opt_in_at END,
        adaptive_formats=coalesce($3, adaptive_formats), adaptive_comm=coalesce($4, adaptive_comm), updated_at=now() WHERE user_id=$1`, [user.id, i.opt_in, i.formats ?? null, i.comm ?? null]);
      await audit(c, user.id, 'set_my_adaptive_coaching', 'coach_profiles', user.id);
      return { opted_in: i.opt_in };
    });
  },
});

cap({
  name: 'upsert_adaptive_expertise', method: 'POST', path: '/me/coach-adaptive/expertise', tag: TAG, auth: ['coach'], status: 201,
  summary: 'Coach: declare expertise in a para discipline (self-declared until a verified credential backs it). Optionally attach your own coach verification case; the case must name the discipline in its scope to count as verified.',
  input: z.object({ sport: z.string(), discipline: z.string(), years: z.number().int().min(0).max(80).nullable().optional(), specialist_training: z.string().trim().max(300).nullable().optional(), case_id: id.nullable().optional() }),
  async handler({ user }, i) {
    if (!DISCIPLINE_KEYS.includes(i.discipline)) throw badRequest('Unknown discipline');
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw badRequest('Unknown sport');
    return tx(async (c) => {
      if (!(await c.query("SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND sport_id=$2 AND role='coach'", [user.id, sport.id])).rowCount) throw badRequest('Add this sport to your profile as a coach first');
      if (i.case_id && !(await c.query("SELECT 1 FROM verification_cases WHERE id=$1 AND type='coach' AND subject_type='user' AND subject_id=$2", [i.case_id, user.id])).rowCount) throw notFound('Verification case');
      const note = i.specialist_training ? sealTraining(screen(i.specialist_training)) : null;
      const row = (await c.query(`INSERT INTO coach_adaptive_expertise(coach_id, sport_id, discipline, years, training_enc, case_id) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (coach_id, sport_id, discipline) WHERE archived_at IS NULL DO UPDATE SET years=EXCLUDED.years, training_enc=coalesce(EXCLUDED.training_enc, coach_adaptive_expertise.training_enc),
        case_id=coalesce(EXCLUDED.case_id, coach_adaptive_expertise.case_id), updated_at=now() RETURNING id, discipline, years, case_id`, [user.id, sport.id, i.discipline, i.years ?? null, note, i.case_id ?? null])).rows[0];
      await audit(c, user.id, 'upsert_adaptive_expertise', 'coach_adaptive_expertise', row.id);
      return row;
    });
  },
});

cap({
  name: 'archive_adaptive_expertise', method: 'POST', path: '/me/coach-adaptive/expertise/:id/archive', tag: TAG, auth: ['coach'],
  summary: 'Coach: remove a declared expertise from your profile. It is archived, not deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE coach_adaptive_expertise SET archived_at=now(), updated_at=now() WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL RETURNING id', [i.id, user.id]);
    if (!r) throw notFound('Expertise');
    return { id: r.id, archived: true };
  },
});

cap({
  name: 'get_coach_adaptive', method: 'GET', path: '/coaches/:id/adaptive', tag: TAG, auth: 'public',
  summary: 'The public adaptive-coaching block of a coach: declared expertise with its live credential state, issuing authority, scope and validity, delivery formats and communication support. 404 unless the coach opted in and is listed. Carries the credential disclaimer.',
  input: z.object({ id }),
  async handler(_, i) {
    const listed = await one('SELECT 1 FROM coach_profiles WHERE user_id=$1 AND adaptive_opt_in AND coalesce(listed, true)', [i.id]);
    if (!listed) throw notFound('Coach');
    const a = (await adaptiveFor([i.id])).get(i.id);
    return { ...a, expertise: a.expertise.map(({ case_id, ...e }) => e), disclaimer: DISCLAIMER, no_formal_credential: !a.expertise.some((e) => e.state === 'verified') };
  },
});

// ------------------------------------------------------------------------------------------------------------------ booking adjustments
const hireFor = async (hireId) => { const h = await one('SELECT id, hirer_id, coach_id, coalesce(athlete_id, hirer_id) AS athlete_id, status FROM coach_hires WHERE id=$1', [hireId]); if (!h) throw notFound('Booking'); return h; };
const view = (r, withNote) => ({ id: r.id, hire_id: r.hire_id, need_keys: r.need_keys, needs: r.need_keys.map((k) => ({ key: k, type: typeOfNeed(k) })), granted_as: r.granted_as, expires_at: r.expires_at, revoked_at: r.revoked_at, ...(withNote ? { note: r.note_enc ? decrypt(r.note_enc, 'coach_hire_adjustments.note') : null } : {}) });
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

cap({
  name: 'share_hire_adjustments', method: 'POST', path: '/hires/:id/adjustments', tag: TAG, status: 201,
  summary: 'Share operational session adjustments (access, equipment, support person, communication, schedule) with the coach of one booking, until a date you choose. Catalogue codes plus an optional 300-character note with no health details. An adult decides for themself; a verified guardian with the consent scope decides for a young person. Withdraw any time. Booking and relationship permissions are unchanged.',
  input: z.object({ id, need_keys: z.array(z.string().max(40)).min(1).max(12), note: z.string().trim().max(300).optional(), expires_on: day }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const h = await hireFor(i.id);
      const as = await actingFor(c, user, h.athlete_id, 'consent');
      const needs = checkNeeds(i.need_keys);
      if (i.expires_on <= today() || i.expires_on > plusDays(SHARE_MONTHS_MAX * 31)) throw badRequest(`Choose an expiry date within the next ${SHARE_MONTHS_MAX} months`);
      const row = (await c.query('INSERT INTO coach_hire_adjustments(hire_id, athlete_id, need_keys, note_enc, granted_by, granted_as, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [h.id, h.athlete_id, needs, i.note ? encrypt(screen(i.note), 'coach_hire_adjustments.note') : null, user.id, as, `${i.expires_on}T23:59:59Z`])).rows[0];
      await notify(c, h.coach_id, { kind: 'coach_adjustments', title: 'Session adjustments were shared with you', body: 'Open the booking to see what was shared. It is operational information only.', data: { hire_id: h.id }, dedupe_key: `adj:${row.id}` });
      await audit(c, user.id, 'share_hire_adjustments', 'coach_hire_adjustments', row.id);
      return view(row, true);
    });
  },
});

cap({
  name: 'revoke_hire_adjustments', method: 'POST', path: '/hires/:id/adjustments/revoke', tag: TAG,
  summary: 'Withdraw every live adjustment you shared for this booking. Effective immediately; the history is kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const h = await hireFor(i.id);
      await actingFor(c, user, h.athlete_id, 'consent');
      const r = await c.query('UPDATE coach_hire_adjustments SET revoked_at=now() WHERE hire_id=$1 AND revoked_at IS NULL RETURNING id', [h.id]);
      if (!r.rowCount) throw conflict('Nothing is shared for this booking');
      await audit(c, user.id, 'revoke_hire_adjustments', 'coach_hire_adjustments', h.id);
      return { revoked: r.rowCount };
    });
  },
});

cap({
  name: 'get_hire_adjustments', method: 'GET', path: '/hires/:id/adjustments', tag: TAG,
  summary: 'The adjustments shared for one booking. The coach sees only live ones (not withdrawn, not expired) and every read is logged and visible to the athlete; the athlete or guardian sees their own history. Anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const h = await hireFor(i.id);
    if (h.coach_id === user.id) {
      const rows = await many('SELECT * FROM coach_hire_adjustments WHERE hire_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC', [h.id]);
      for (const r of rows) await one('INSERT INTO coach_hire_adjustment_reads(adjustment_id, reader_id) VALUES ($1,$2) RETURNING id', [r.id, user.id]);
      if (rows.length) await tx((c) => audit(c, user.id, 'read_hire_adjustments', 'coach_hires', h.id));
      return rows.map((r) => view(r, true));
    }
    // the athlete (adult) or a LIVE verified guardian; a guardian whose link lapsed, even if they placed the booking, sees nothing
    const standing = await tx((c) => actingFor(c, user, h.athlete_id, 'consent').catch(() => null));
    if (!standing) throw notFound('Booking');
    const rows = await many('SELECT a.*, (SELECT count(*)::int FROM coach_hire_adjustment_reads r WHERE r.adjustment_id=a.id) AS reads FROM coach_hire_adjustments a WHERE hire_id=$1 ORDER BY created_at DESC', [h.id]);
    return rows.map((r) => ({ ...view(r, true), coach_reads: r.reads }));
  },
});
