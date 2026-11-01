import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cap, capabilities, id, page } from '../registry.js';
import { invoke } from '../invoke.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, hasRole } from '../helpers.js';
import { decrypt, encrypt, sha256 } from '../crypto.js';
import { askJson, aiConfigured, aiModel, AI_RULES, quoteData } from '../ai.js';
import { COPILOTS, TASKS, DELEGATED, EXECUTABLE, FORBIDDEN, RULES_VERSION, forbiddenKind, taskNames } from '../copilots.js';

// Role copilots (issue #598). One framework for every role; the athlete and coach copilots run the existing assistants rather than a second
// implementation. A run reads only through the owning capabilities (so their ownership, consent and youth rules apply unchanged), derives items by
// plain rules with a source reference each, and proposes actions from those items. A model, when configured, may add a short "why" to items that
// already exist; it cannot add items or actions. Nothing happens until a human approves an action, and forbidden decisions can never be executed.
const TAG = 'Role copilots';
const SEVERITY = { high: 0, medium: 1, low: 2 };
const through = (name, user, input) => invoke(capabilities.find((c) => c.name === name), user, input);
const hidden = (e) => e?.status === 404 || e?.status === 403;

const entitled = (user, copilot) => { const r = COPILOTS[copilot].roles; return !r || hasRole(user, ...r); };
const runView = async (r, viewerId) => ({
  id: r.id, copilot: r.copilot, task: r.task, scope_type: r.scope_type, scope_id: r.scope_id, headline: r.headline, items: r.items, sources: r.sources, limitations: r.limitations,
  provider: r.provider, model: r.model, rules_version: r.rules_version, ai: r.ai, status: r.status, created_at: r.created_at,
  note: r.note_enc && r.requested_by === viewerId ? decrypt(r.note_enc, `copilot:${r.id}`) : undefined,
  actions: await many('SELECT id, item_id, kind, label, risk, executable, status, decided_at, executed_at, result FROM copilot_actions WHERE run_id=$1 ORDER BY created_at, id', [r.id]),
});

cap({
  name: 'list_copilots', method: 'GET', path: '/copilots', tag: TAG,
  summary: 'The role copilots available to you and the tasks each one can do, with the kind of record each task needs (an event, a federation body, a venue or an organisation, picked from what you manage). A copilot is workflow help grounded in records you may already read: it never takes a consequential decision. Federation and organisation copilots are listed for everyone; what they can read is decided by your access to the body or organisation you name.',
  input: z.object({}),
  async handler({ user }) {
    return Object.entries(COPILOTS).filter(([k]) => entitled(user, k)).map(([k, d]) => ({ copilot: k, scope: d.scope, tasks: taskNames(k) }));
  },
});

cap({
  name: 'run_copilot_task', method: 'POST', path: '/copilots/:copilot/tasks', tag: TAG, status: 201,
  summary: 'Run one copilot task. It reads only through the existing capabilities, so you see exactly what you could already open (anything you may not open is a 404, never a hint it exists), and returns a DRAFT: items each citing the records behind them, the data limits, who/what produced it (rules or a named model) and suggested actions. Actions stay inert until you approve them with resolve_copilot_action; award, medical clearance, discipline, classification, signature, transfer approval and money movement are never executable. Repeating the same client_key returns the same run.',
  input: z.object({
    copilot: z.enum(Object.keys(COPILOTS)), task: z.string().max(40),
    scope_id: id.optional().describe('the event, body, venue or organisation, as the copilot requires'),
    athlete_id: id.optional().describe('coach copilot: the athlete'), team_id: id.optional().describe('coach copilot: the team'),
    session_record_id: id.optional().describe('coach copilot: the session record being planned'),
    note: z.string().trim().min(2).max(400).optional().describe('optional context; kept encrypted and shown only to you'),
    client_key: z.string().max(80).optional(),
  }),
  async handler({ user }, i) {
    const def = COPILOTS[i.copilot];
    if (!entitled(user, i.copilot)) throw notFound('Copilot');
    if (!taskNames(i.copilot).includes(i.task)) throw badRequest(`Unknown task for the ${i.copilot} copilot. Use one of: ${taskNames(i.copilot).join(', ')}`);
    if (i.client_key) {
      const prior = await one('SELECT * FROM copilot_runs WHERE requested_by=$1 AND client_key=$2', [user.id, i.client_key]);
      if (prior) return runView(prior, user.id);
    }
    if (def.scope && !i.scope_id) throw badRequest(`This copilot needs the ${def.scope} it should look at (scope_id)`);
    const scope = { id: i.scope_id };
    const limitations = [], sources = [];
    const src = (capability, label) => { const ref = `S${sources.length + 1}`; sources.push({ ref, capability, label, at: new Date().toISOString() }); return ref; };
    let headline, items = [];

    if (DELEGATED[i.copilot]?.[i.task]) {
      // the existing assistant does the reading, the permission and consent checks and the drafting; this only re-presents what it cites
      const task = DELEGATED[i.copilot][i.task];
      let d;
      try {
        d = i.copilot === 'athlete'
          ? await through('ask_player_assistant', user, { task })
          : await through('draft_ai_coaching_assist', user, { task, athlete_id: i.athlete_id, team_id: i.team_id, session_record_id: i.session_record_id });
      } catch (e) { throw hidden(e) ? notFound('Record') : e; } // never reveal that a team or athlete exists
      const out = d.output ?? d;
      const own = (d.sources ?? []).map((s) => ({ ...s }));
      const refMap = new Map();
      for (const s of own) refMap.set(s.ref, src(i.copilot === 'athlete' ? 'ask_player_assistant' : 'draft_ai_coaching_assist', s.label ?? s.kind ?? s.ref));
      if (!own.length) src(i.copilot === 'athlete' ? 'ask_player_assistant' : 'draft_ai_coaching_assist', 'Assistant draft');
      headline = out.headline ?? 'Draft ready';
      items = (out.items ?? []).slice(0, 25).map((x, n) => ({ key: `d-${n}`, severity: 'low', title: x.title, detail: x.detail, why: x.why, ref: null, source_refs: (x.source_refs ?? []).map((r) => refMap.get(r)).filter(Boolean), basis: x.basis, action: x.action ? { kind: 'todo', label: x.action.title ?? x.title, payload: {} } : undefined }));
      for (const l of d.limitations ?? []) limitations.push(l);
    } else {
      if (def.scope) await audit(null, user.id, `copilot_${i.copilot}_${i.task}`, def.scope, i.scope_id);
      const t = TASKS[i.copilot][i.task];
      // some readers are public (a vendor list shows confirmed vendors to anyone), so an event must always be one the caller runs
      if (def.scope === 'event') { try { await through('get_event_readiness', user, { id: i.scope_id }); } catch (e) { if (hidden(e)) throw notFound('event'); throw e; } }
      const results = {}, refs = {};
      for (const r of t.reads) {
        try { results[r.key] = await through(r.cap, user, r.input(scope)); refs[r.key] = src(r.cap, r.key); } catch (e) {
          if (hidden(e) && def.scope) throw notFound(def.scope); // never reveal that a record exists
          limitations.push(`${r.key.replace(/_/g, ' ')} could not be read just now (${hidden(e) ? 'not available to you' : 'temporary problem'}), so it is left out.`);
        }
      }
      const derived = t.derive(results, scope);
      items = derived.map((x) => ({ ...x, source_refs: [refs[x.ref]].filter(Boolean) }));
      headline = t.headline(items, results);
    }

    items = items.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]).map((x, n) => ({ id: `i${n + 1}`, ...x }));
    const clean = items.map(({ action, ref, key, ...rest }) => rest);

    // the model may only explain items that exist
    let ai = false, provider = 'rules', model = null;
    if (aiConfigured() && items.length && !DELEGATED[i.copilot]?.[i.task]) {
      const reply = await askJson({
        system: `You help a ${i.copilot} understand a list of work items. Add one short plain sentence "why it matters" per item id. Never add items, never recommend a decision (award, clearance, discipline, classification, signature, transfer, payments). ${AI_RULES}`,
        user: `<data>${clean.map((x) => `${x.id}: ${quoteData(x.title, 120)} (${quoteData(x.detail, 160)})`).join('\n')}</data>`,
        schema: z.object({ whys: z.array(z.object({ id: z.string(), why: z.string().max(240) })).max(30) }),
        shape: '{"whys":[{"id":"i1","why":"..."}]}', maxTokens: 900,
      });
      if (reply) { const ids = new Set(clean.map((x) => x.id)); for (const w of reply.whys) if (ids.has(w.id)) clean.find((x) => x.id === w.id).why = quoteData(w.why, 240); ai = true; provider = 'anthropic'; model = aiModel(); }
    }
    if (i.note && forbiddenKind(i.note)) limitations.push(`Your note mentions a decision a copilot never takes (${forbiddenKind(i.note).replace(/_/g, ' ')}). It can prepare facts for you, but the decision stays with you in the screen that owns it.`);

    const runId = randomUUID();
    await tx(async (c) => {
      const inputHash = sha256(JSON.stringify([i.copilot, i.task, i.scope_id ?? null, i.athlete_id ?? null, i.team_id ?? null]));
      const run = (await c.query(
        `INSERT INTO copilot_runs (id, note_enc, requested_by, copilot, task, scope_type, scope_id, headline, items, sources, limitations, provider, model, rules_version, input_hash, ai, client_key)
         VALUES ($16,$17,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [user.id, i.copilot, i.task, def.scope, i.scope_id ?? null, headline, JSON.stringify(clean), JSON.stringify(sources), JSON.stringify(limitations), provider, model, RULES_VERSION, inputHash, ai, i.client_key ?? null, runId, i.note ? encrypt(i.note, `copilot:${runId}`) : null])).rows[0];
      for (const x of items) {
        if (!x.action) continue;
        const forbidden = forbiddenKind(`${x.action.label} ${x.title}`);
        const exec = !forbidden && x.action.kind in EXECUTABLE;
        await c.query(
          'INSERT INTO copilot_actions (run_id, item_id, kind, label, capability, payload, risk, executable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [run.id, x.id, forbidden ? `advisory:${forbidden}` : x.action.kind, String(x.action.label).slice(0, 200), exec ? EXECUTABLE[x.action.kind] : null, JSON.stringify(x.action.payload ?? {}), forbidden ? 'forbidden' : 'low', exec]);
      }
      await audit(c, user.id, 'copilot_run', 'copilot_runs', run.id);
    });
    return runView(await one('SELECT * FROM copilot_runs WHERE id=$1', [runId]), user.id);
  },
});

cap({
  name: 'list_copilot_runs', method: 'GET', path: '/copilots/runs', tag: TAG,
  summary: 'Your own copilot runs, newest first, with what each proposed and what was approved or executed (the log of proposed and executed AI actions). Only the person who ran it sees it.',
  input: z.object({ copilot: z.enum(Object.keys(COPILOTS)).optional(), ...page }),
  async handler({ user }, i) {
    const rs = await many('SELECT * FROM copilot_runs WHERE requested_by=$1 AND ($2::text IS NULL OR copilot=$2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4', [user.id, i.copilot ?? null, i.limit, i.offset]);
    return Promise.all(rs.map((r) => runView(r, user.id)));
  },
});

cap({
  name: 'get_copilot_run', method: 'GET', path: '/copilots/runs/:id', tag: TAG,
  summary: 'One of your copilot runs with its items, sources, limits, model metadata and actions. Someone else\'s run is a 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT * FROM copilot_runs WHERE id=$1 AND requested_by=$2', [i.id, user.id]);
    if (!r) throw notFound('Run');
    return runView(r, user.id);
  },
});

cap({
  name: 'resolve_copilot_action', method: 'POST', path: '/copilots/actions/:id/resolve', tag: TAG,
  summary: 'Approve or reject one proposed action. Approving runs only an allowlisted low-risk action (save as a to-do, or create an event task) as YOU, so your permissions are checked again at that moment. Actions that stand for a forbidden decision (award, medical clearance, discipline, classification, signature, transfer approval, money movement) can only be rejected: they are advisory.',
  input: z.object({ id, decision: z.enum(['approve', 'reject']) }),
  async handler({ user }, i) {
    const a = await one('SELECT a.*, r.requested_by FROM copilot_actions a JOIN copilot_runs r ON r.id=a.run_id WHERE a.id=$1', [i.id]);
    if (!a || a.requested_by !== user.id) throw notFound('Action');
    if (a.status !== 'proposed') return a; // already decided: repeating is harmless
    if (i.decision === 'approve' && !a.executable) throw conflict('This action is advisory only: take the decision yourself in the screen that owns it.');
    if (i.decision === 'reject') {
      await audit(null, user.id, 'copilot_action_rejected', 'copilot_actions', a.id);
      return one("UPDATE copilot_actions SET status='rejected', decided_by=$2, decided_at=now() WHERE id=$1 RETURNING *", [a.id, user.id]);
    }
    let result = { saved: true }, status = 'executed';
    if (a.capability) {
      try { result = { ok: true, ref: (await through(a.capability, user, a.payload))?.id ?? null }; } catch (e) { status = 'failed'; result = { error: hidden(e) ? 'Not allowed for you' : String(e?.message ?? 'failed').slice(0, 200) }; }
    }
    await audit(null, user.id, `copilot_action_${status}`, 'copilot_actions', a.id);
    return one('UPDATE copilot_actions SET status=$2, decided_by=$3, decided_at=now(), executed_at=now(), result=$4 WHERE id=$1 RETURNING *', [a.id, status, user.id, JSON.stringify(result)]);
  },
});

export { FORBIDDEN };
