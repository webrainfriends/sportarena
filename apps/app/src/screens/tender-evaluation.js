// Evaluation and award workspaces inside the tender console. Scoring is by people against the frozen rubric; the ranking, evaluated cost and
// scenarios are computed by the server from locked scores and sealed-then-opened bids, so every figure here is reproducible.
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Sheet, T } from '../ui';
import { Counter } from '../pickers';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain } from '../access';
import { Checks, Chips, DataTable, Heat, KV, Notice, Panel, Split, Status, amount, day, fromMinor, nice, openDocument, toMinor, when } from '../tender-ui';

const ELIG = { eligible: 'ok', ineligible: 'bad', pending: 'warn', withdrawn: 'neutral' };

/** Criteria in rows, suppliers in columns: each cell is the reviewers' (or the chair's consensus) score, shaded and always printed. */
function Matrix({ rubric, rows }) {
  const crit = rubric?.criteria ?? [];
  const W = 112;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ minWidth: '100%' }}>
      <View style={{ flex: 1, minWidth: '100%' }}>
        <View style={{ flexDirection: 'row', backgroundColor: c.bg, borderRadius: 10, paddingVertical: 8 }}>
          <View style={{ width: 168, paddingHorizontal: 10 }}><T size={10} weight="700" color={c.mute} style={{ letterSpacing: 0.7 }}>CRITERION</T></View>
          {rows.map((r) => <View key={r.id} style={{ flex: 1, minWidth: W, paddingHorizontal: 6 }}><T size={11} weight="700" numberOfLines={2}>{r.supplier}</T></View>)}
        </View>
        {[{ key: '__gate', title: 'Eligibility gate', w: null }, ...crit.map((x) => ({ key: x.key, title: x.title, w: x.weight, max: x.scale_max })), { key: '__tech', title: 'Technical score', w: rubric?.weights?.technical, total: true }, { key: '__cost', title: 'Evaluated cost', w: rubric?.weights?.commercial }, { key: '__comm', title: 'Commercial score', total: true }, { key: '__total', title: 'Total', total: true }, { key: '__rank', title: 'Rank', total: true }].map((row) => (
          <View key={row.key} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, borderBottomWidth: 1, borderColor: c.line, backgroundColor: row.total ? c.bg : 'transparent' }}>
            <View style={{ width: 168, paddingHorizontal: 10 }}><T size={13} weight={row.total || row.key === '__gate' ? '700' : '500'}>{row.title}{row.w != null && !row.total ? ` · ${row.w}%` : ''}</T></View>
            {rows.map((r) => {
              let cell = '—';
              if (row.key === '__gate') cell = <Status tone={ELIG[r.eligibility] ?? 'neutral'} label={nice(r.eligibility)} />;
              else if (row.key === '__tech') cell = r.technical != null ? r.technical.toFixed(1) : '—';
              else if (row.key === '__cost') cell = r.evaluated_cost ? amount(r.evaluated_cost.total_minor, r.evaluated_cost.currency) : <T size={11} color={c.mute}>sealed</T>;
              else if (row.key === '__comm') cell = r.commercial != null ? r.commercial.toFixed(1) : '—';
              else if (row.key === '__total') cell = r.total != null ? r.total.toFixed(2) : r.eligibility === 'eligible' && r.exceptions?.length ? <T size={11} color={c.mute}>blocked</T> : 'not ranked';
              else if (row.key === '__rank') cell = r.rank ? `#${r.rank}${r.tied ? ' (tied)' : ''}` : '—';
              else { const d = r.technical_detail?.[row.key]; cell = d ? <Heat value={d.na ? null : d.raw} max={row.max} na={d.na} /> : <T size={12} color={c.mute}>—</T>; }
              return <View key={r.id} style={{ flex: 1, minWidth: W, paddingHorizontal: 6, alignItems: 'flex-start' }}>{typeof cell === 'object' ? cell : <T size={13} weight={row.total ? '700' : '500'}>{cell}</T>}</View>;
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function EvaluationTab({ t, id, can, toast, reload }) {
  const [round, setRound] = useState(1);
  const [sheet, setSheet] = useState(null);
  const [work, setWork] = useState(null);
  const rk = useLoad(() => api.get(`/rfps/${id}/ranking`, { round }), [id, round, t.status]);
  const subs = useLoad(() => api.get(`/rfps/${id}/submissions`, { round, limit: 100 }), [id, round, t.status]);
  const rubric = t.rubric;
  const rows = rk.data?.rows ?? [];
  const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); rk.reload(); subs.reload(); reload(); } catch (e) { toast(explain(e)); } };
  const rounds = Math.max(1, ...(t.rounds ?? []).map((x) => x.n));
  const priv = can('rank');
  if (t.status === 'published' || t.status === 'approved' || t.status === 'draft' || t.status === 'in_review') return <Notice tone="info">Evaluation starts after the technical envelope is opened (Opening tab).</Notice>;
  return (
    <>
      {rounds > 1 ? <Chips options={Array.from({ length: rounds }, (_, i) => ({ value: i + 1, label: i === 0 ? 'Round 1 · initial' : `Round ${i + 1} · ${t.rounds[i]?.kind === 'bafo' ? 'BAFO' : nice(t.rounds[i]?.kind)}` }))} value={round} onChange={setRound} /> : null}
      <Panel title="Ranking" right={<View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{priv ? <Btn small title="What if the weights change" color={c.violet} onPress={() => setSheet('sens')} /> : null}{priv ? <Btn small title="Comparison PDF" color={c.violet} onPress={() => openDocument('comparison', id, {}, 'comparison').catch((e) => toast(explain(e)))} /> : null}{priv && rk.data?.committed_at ? <Status tone="ok" label={`Committed ${new Date(rk.data.committed_at).toISOString().slice(0, 10)}`} /> : null}{priv && rk.data?.final ? <Btn small title={rk.data?.committed_at ? 'Commit again' : 'Commit ranking'} color={rk.data?.committed_at ? c.violet : c.pink} onPress={() => act(() => api.post(`/rfps/${id}/ranking/commit`, { round }), 'Ranking committed as an immutable snapshot')} /> : null}</View>}>
        {rk.error ? <ErrorBox error={rk.error} onRetry={rk.reload} /> : rk.loading && !rk.data ? <Loading /> : !rk.data?.opened ? <Notice tone="info">The technical envelope has not been opened for this round.</Notice> : (
          <>
            <Matrix rubric={rubric} rows={rows} />
            {rk.data.final ? <Status tone="ok" label="Final: every score and cost needed is in" /> : <Notice>The ranking is not final yet.{(rk.data.blockers ?? []).length ? ` ${rk.data.blockers.length} thing(s) block it: missing scores, unknown costs or an unopened commercial envelope.` : ''}</Notice>}
            {(rk.data.blockers ?? []).length ? <T size={12} color={c.mute}>{rk.data.blockers.slice(0, 5).join(' · ')}</T> : null}
            <T size={12} color={c.mute}>Ineligible bids are listed but never ranked, however cheap. Missing scores are never counted as zero. Rubric v{rk.data.rubric_version}, formula v{rk.data.formula_version}.</T>
          </>
        )}
      </Panel>
      <Split main={
        <>
          <Panel title="Suppliers" right={can('consensus') || can('members') ? <Btn small title="Assign reviewers" color={c.violet} onPress={() => setSheet('assign')} /> : null}>
            <DataTable rows={subs.data?.items ?? []} empty={subs.data?.opened === false ? 'Sealed until opening.' : 'No submissions.'} cols={[
              { key: 'legal_name', label: 'Supplier', flex: 2, min: 150, bold: true }, { key: 'eligibility', label: 'Gate', min: 100, render: (s) => <Status tone={ELIG[s.eligibility] ?? 'neutral'} label={nice(s.eligibility)} /> },
              { key: 'reason', label: 'Why', flex: 2, min: 170, render: (s) => s.eligibility_reason ?? '' },
              { key: 'sign', label: 'Sign-off', min: 90, render: (s) => (s.tech_signoff ? <Status tone={s.tech_signoff === 'pass' ? 'ok' : 'bad'} label={s.tech_signoff} /> : '—') },
              { key: 'act', label: '', min: 330, render: (s) => <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {can('score_technical') && s.eligibility === 'eligible' ? <Btn small title="Score" onPress={() => setWork(s)} /> : null}
                {can('consensus') && s.eligibility === 'eligible' && !s.tech_signoff && round === 1 ? <Btn small title="Sign off" color={c.violet} onPress={() => act(() => api.post(`/rfps/${id}/proposals/${s.id}/technical-signoff`, { result: 'pass' }), 'Technical sign-off recorded')} /> : null}
                {can('disqualify_request') && s.eligibility !== 'ineligible' ? <Btn small title="Disqualify…" color={c.violet} onPress={() => setSheet({ status: s, action: 'disqualify' })} /> : null}
                {can('disqualify_request') && s.eligibility === 'ineligible' ? <Btn small title="Reinstate…" color={c.violet} onPress={() => setSheet({ status: s, action: 'reinstate' })} /> : null}
                {can('score_commercial') ? <Btn small title="Commercial review" color={c.violet} onPress={() => act(() => api.post(`/rfps/${id}/proposals/${s.id}/gate`, { gate_key: 'commercial_review', result: 'pass' }), 'Recorded')} /> : null}</View> }]} />
          </Panel>
          {work ? <ScoreWork t={t} id={id} s={work} can={can} toast={toast} onClose={() => { setWork(null); rk.reload(); }} setSheet={setSheet} /> : null}
        </>
      } side={
        <>
          <Panel title="Frozen rubric">
            {rubric ? <><KV items={[['Technical', `${rubric.weights.technical}%`], ['Commercial', `${rubric.weights.commercial}%`], ['Pass mark', rubric.technical_pass_mark], ['Reviewers per criterion', rubric.min_reviewers]]} /><T size={12} color={c.mute}>Frozen at approval (v{t.rubric_version}). Commercial score is 100 × lowest comparable cost ÷ own cost. Tie-break: {rubric.tie_break.map(nice).join(', then ')}.</T></> : <T size={13} color={c.mute}>No rubric.</T>}
          </Panel>
          <Panel title="Rules in force"><Checks items={[{ state: 'ok', title: 'Reviewers score only what they are assigned' }, { state: 'ok', title: 'Others\' scores stay hidden until everyone has locked' }, { state: 'ok', title: 'Supplier-affiliated people cannot grade their own organisation' }, { state: 'ok', title: 'Overrides need a reason and a second approver' }]} /></Panel>
        </>
      } />
      <FormSheet visible={sheet === 'assign'} onClose={() => setSheet(null)} title="Assign reviewers" submitLabel="Assign"
        fields={[{ key: 'handle', label: 'Reviewer handle', hint: 'They need the technical or commercial evaluator role on this tender first.' }, { key: 'section', label: 'Section', type: 'choice', options: [{ value: 'technical', label: 'Technical' }, { value: 'commercial', label: 'Commercial' }] }, { key: 'criteria', label: 'Only these criteria (blank = all)', type: 'multi', optional: true, options: (rubric?.criteria ?? []).map((x) => ({ value: x.key, label: x.title })) }, { key: 'blind', label: 'Blind: hide supplier names', type: 'switch' }, { key: 'weight', label: 'Reviewer weight', type: 'stepper', min: 1, max: 10, default: 1 }]} initial={{ section: 'technical', blind: false, weight: 1 }}
        onSubmit={async (v) => { await api.post(`/rfps/${id}/assignments`, { assignments: [{ handle: v.handle, section: v.section, criteria: v.criteria?.length ? v.criteria : undefined, blind: !!v.blind, weight: v.weight ?? 1 }] }); return 'Assigned'; }} />
      <FormSheet visible={!!sheet?.status} onClose={() => setSheet(null)} title={sheet?.action === 'disqualify' ? 'Disqualify this bid' : 'Reinstate this bid'} submitLabel="Request approval" fields={[{ key: 'reason', label: 'Reason (at least 10 characters)', type: 'multiline', hint: 'Someone other than you must approve. Nothing changes until they do.' }]}
        onSubmit={async (v) => { await api.post(`/rfps/${id}/proposals/${sheet.status.id}/status`, { action: sheet.action, reason: v.reason }); return 'Sent for approval'; }} />
      <FormSheet visible={!!sheet?.consensus} onClose={() => setSheet(null)} title="Record a consensus score" submitLabel="Record"
        fields={[{ key: 'criterion_key', label: 'Criterion', type: 'chips', options: (rubric?.criteria ?? []).map((x) => ({ value: x.key, label: x.title })) }, { key: 'score', label: 'Consensus score', type: 'number' }, { key: 'rationale', label: 'Chair rationale (at least 10 characters)', type: 'multiline', hint: 'Every assigned reviewer must have locked first. Their original scores are kept.' }]}
        onSubmit={async (v) => { await api.post(`/rfps/${id}/consensus`, { proposal_id: sheet.consensus.id, criterion_key: v.criterion_key, score: Number(v.score), rationale: v.rationale }); rk.reload(); return 'Consensus recorded'; }} />
      <Sens visible={sheet === 'sens'} onClose={() => setSheet(null)} id={id} round={round} t={t} />
    </>
  );
}

function Sens({ visible, onClose, id, round, t }) {
  const [tech, setTech] = useState(40);
  const [res, setRes] = useState(null);
  const run = async () => setRes(await api.post(`/rfps/${id}/ranking/sensitivity`, { round, alternatives: [{ technical: tech, commercial: 100 - tech }] }).catch(() => null));
  return (
    <Sheet visible={visible} onClose={onClose} title="What if the weights change?" footer={<Btn title="Run analysis" onPress={run} style={{ flex: 1 }} />}>
      <T size={13} color={c.mute}>Analysis only. The official ranking and award always use the frozen rubric (technical {t.rubric?.weights?.technical}% / commercial {t.rubric?.weights?.commercial}%).</T>
      <View style={{ gap: 6 }}><T size={11} weight="700" color={c.mute}>TECHNICAL WEIGHT %</T><Counter value={tech} onChange={setTech} min={0} max={100} step={5} /></View>
      {res ? <Notice tone={res.scenarios[0].changed ? 'warn' : 'info'}>{res.scenarios[0].changed ? 'The order of the ranked suppliers would change.' : 'The order would not change.'}</Notice> : null}
    </Sheet>
  );
}

/** One reviewer scoring one supplier: read the opened technical envelope, score each criterion with rationale and evidence, save or lock. */
function ScoreWork({ t, id, s, can, toast, onClose, setSheet }) {
  const content = useLoad(() => api.get(`/rfps/${id}/proposals/${s.id}/content`, { envelope: 'technical' }), [s.id]);
  const scores = useLoad(() => api.get(`/rfps/${id}/scores`, { proposal_id: s.id }), [s.id]);
  const [key, setKey] = useState(null);
  const [score, setScore] = useState('');
  const [na, setNa] = useState(false);
  const [why, setWhy] = useState('');
  const [ev, setEv] = useState(null);
  const [ai, setAi] = useState(null);
  const crit = t.rubric?.criteria ?? [];
  const cur = crit.find((x) => x.key === (key ?? crit[0]?.key));
  const mine = (scores.data?.scores ?? []).filter((x) => x.reviewer === 'you');
  const mineFor = mine.find((x) => x.criterion_key === cur?.key);
  const save = async (lock) => {
    try { await api.post(`/rfps/${id}/scores`, { proposal_id: s.id, criterion_key: cur.key, ...(na ? { na: true } : { score: Number(score) }), rationale: why || undefined, evidence: ev ? { question_key: ev } : undefined, lock }); toast(lock ? 'Score locked' : 'Draft saved'); scores.reload(); } catch (e) { toast(explain(e)); }
  };
  const declare = () => api.post(`/rfps/${id}/conflicts`, { has_conflict: false }).then(() => { toast('Declared: no conflict'); content.reload(); }).catch((e) => toast(explain(e)));
  return (
    <Panel title={`Scoring · ${content.data?.supplier ?? s.legal_name}`} right={<Btn small title="Close" color={c.violet} onPress={onClose} />}>
      {content.error ? (/declare/i.test(content.error.message) ? <><Notice>Before you evaluate, declare whether you have a conflict of interest on this tender.</Notice><Btn small title="I have no conflict of interest" onPress={declare} style={{ alignSelf: 'flex-start' }} /></> : <ErrorBox error={content.error} onRetry={content.reload} />) : content.loading && !content.data ? <Loading /> : (
        <>
          {(content.data.questions ?? []).filter((q) => q.section !== 'commercial').map((q) => <View key={q.key} style={{ gap: 2, paddingVertical: 4, borderTopWidth: 1, borderColor: c.line }}><T size={12} weight="700" color={c.mute}>{q.prompt}</T><T size={13}>{String(content.data.content.answers?.[q.key] ?? '—')}</T></View>)}
          {content.data.content.delivery_plan ? <View style={{ gap: 2 }}><T size={12} weight="700" color={c.mute}>Delivery plan</T><T size={13}>{content.data.content.delivery_plan}</T></View> : null}
          {(content.data.files ?? []).length ? <T size={12} color={c.mute}>{content.data.files.length} evidence file(s) are attached; open them from the supplier's receipt view.</T> : null}
          <View style={{ gap: 8, marginTop: 8 }}>
            <T size={11} weight="700" color={c.mute}>CRITERION</T>
            <Chips options={crit.map((x) => ({ value: x.key, label: `${x.title}${mine.find((m) => m.criterion_key === x.key)?.status === 'locked' ? ' ✓' : ''}` }))} value={cur?.key} onChange={(v) => { setKey(v); setScore(''); setWhy(''); setNa(false); }} />
            {mineFor ? <T size={12} color={c.mute}>Your score: {mineFor.na ? 'N/A' : mineFor.score} ({mineFor.status}{mineFor.status === 'locked' ? ', cannot change' : ''}).</T> : null}
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <View style={{ flexGrow: 1, flexBasis: 140 }}><Field label={`Score (${cur?.scale_min ?? 0} to ${cur?.scale_max ?? 10})`} value={score} onChangeText={(x) => setScore(x.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" /></View>
              <Chips options={[{ value: false, label: 'Scored' }, { value: true, label: 'Not applicable' }]} value={na} onChange={setNa} />
            </View>
            <Field label="Rationale (required to lock)" multiline value={why} onChangeText={setWhy} hint={cur?.evidence_required ? 'This criterion needs an evidence reference to lock.' : undefined} />
            <View style={{ gap: 6 }}><T size={11} weight="700" color={c.mute}>EVIDENCE: WHICH ANSWER SUPPORTS IT</T><Chips options={(content.data.questions ?? []).filter((q) => q.section !== 'commercial').map((q) => ({ value: q.key, label: q.key }))} value={ev} onChange={(v) => setEv(ev === v ? null : v)} /></View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Save draft" color={c.violet} onPress={() => save(false)} /><Btn small title="Lock score" onPress={() => save(true)} />
              <Btn small title="Summarise evidence (assistive)" color={c.violet} onPress={async () => { try { setAi(await api.post(`/rfps/${id}/proposals/${s.id}/ai/summary`)); } catch (e) { toast(explain(e)); } }} />
              {can('consensus') ? <Btn small title="Consensus…" color={c.violet} onPress={() => setSheet({ consensus: s })} /> : null}</View>
          </View>
          {ai ? <Card color={c.violetSoft}><View style={{ gap: 6 }}><T weight="700" size={12}>{ai.available ? 'Assistive summary: not an evaluation' : 'AI assistance is off'}</T>{ai.available ? <>{ai.points.map((p, i) => <T key={i} size={13}>• {p.text} <T size={11} color={c.mute}>[{p.source.question_key}]</T></T>)}<T size={12} color={c.mute}>Uncertainty: {ai.uncertainty}</T><T size={11} color={c.mute}>{ai.note}</T></> : <T size={13} color={c.mute}>{ai.note}</T>}</View></Card> : null}
          {(scores.data?.progress ?? []).length ? <Checks items={scores.data.progress.map((p) => ({ state: p.locked >= p.total ? 'ok' : 'warn', title: p.handle, detail: `${p.locked} of ${p.total} locked` }))} /> : null}
          {(scores.data?.scores ?? []).filter((x) => x.reviewer !== 'you').map((x) => <T key={x.id} size={12} color={c.mute}>{x.reviewer}: {x.criterion_key} {x.na ? 'N/A' : x.score}</T>)}
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ award
const KINDS = [['highest_score', 'Highest score'], ['lowest_cost', 'Lowest compliant cost'], ['single_supplier', 'Single supplier'], ['split_by_lot', 'Split by lot']];

function ScenarioCard({ s, onRecommend, cur }) {
  const r = s.result ?? s;
  return (
    <Card><View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><T weight="700" size={14} style={{ flex: 1 }}>{nice(s.kind ?? r.kind)}</T><Status tone={r.optimal ? 'ok' : 'warn'} label={r.optimal ? 'Proven best' : 'Heuristic'} /><Status tone={r.feasible ? 'ok' : 'bad'} label={r.feasible ? 'Feasible' : 'Infeasible'} /></View>
      <T weight="800" size={20}>{amount(r.cost_minor, r.currency ?? cur)}</T>
      <KV items={[['Coverage', `${r.coverage.filled} of ${r.coverage.total} lots`], ['Suppliers', r.suppliers], ['Budget impact', r.budget_impact_minor != null ? amount(r.budget_impact_minor, r.currency ?? cur) : null], ['Solver', r.solver]]} />
      {r.allocation.map((a, i) => <T key={i} size={13}>Lot {a.lot} → <T size={13} weight="700">{r.entities?.[a.entity] ?? 'Supplier'}</T> · {a.qty} · {amount(a.cost_minor, r.currency ?? cur)}</T>)}
      {r.reserve?.length ? <Notice tone="info">Reserve award: lot {r.reserve.map((x) => x.lot).join(', ')} goes to the next ranked bidder because the earlier supplier declined or did not respond. It needs a fresh approval.</Notice> : null}
      {r.unfilled?.map((u) => <Notice key={u.lot}>Lot {u.lot} unfilled ({u.missing_qty}): {u.reason}</Notice>)}
      {r.violations?.map((v) => <Notice key={v} tone="bad">{v}</Notice>)}
      <T size={12} color={c.mute}>{r.explanation}</T>
      {onRecommend ? <Btn small title="Recommend this award" onPress={onRecommend} style={{ alignSelf: 'flex-start' }} /> : null}
    </View></Card>
  );
}

export function AwardTab({ t, id, can, toast, reload, push }) {
  const sc = useLoad(() => api.get(`/rfps/${id}/scenarios`, { limit: 20 }).catch(() => []), [id, t.status]);
  const awards = useLoad(() => api.get(`/rfps/${id}/awards`).catch(() => []), [id, t.status]);
  const live = (awards.data ?? [])[0];
  const award = useLoad(() => (live ? api.get(`/awards/${live.id}`) : Promise.resolve(null)), [live?.id, live?.status]);
  const orders = useLoad(() => api.get('/procurement-orders', { project_id: id, limit: 50 }).catch(() => []), [id, award.data?.status]);
  const appeals = useLoad(() => api.get(`/rfps/${id}/appeals`).catch(() => []), [id]);
  const reserve = useLoad(() => (can('scenario') ? api.get(`/rfps/${id}/reserve`).catch(() => null) : Promise.resolve(null)), [id, award.data?.status, t.status]);
  const pubs = useLoad(() => (t.disclosure?.award_public ? api.get(`/rfps/${id}/award-publications`).catch(() => []) : Promise.resolve([])), [id, t.status, award.data?.status]);
  const [sheet, setSheet] = useState(null);
  const [kind, setKind] = useState('highest_score');
  const [maxS, setMaxS] = useState(0), [minScore, setMinScore] = useState(0), [budget, setBudget] = useState('');
  const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); sc.reload(); awards.reload(); award.reload(); orders.reload(); reserve.reload(); pubs.reload(); reload(); } catch (e) { toast(explain(e)); } };
  if (!['evaluation', 'award', 'awarded', 'closed'].includes(t.status)) return <Notice tone="info">Awards start after evaluation.</Notice>;
  const a = award.data;
  const step = !a ? 0 : a.status === 'approval_pending' ? 1 : a.status === 'approved' ? 2 : a.status === 'notified' ? 3 : ['partially_accepted', 'accepted'].includes(a.status) ? 4 : 0;
  const stages = ['Recommendation', 'Approval', 'Award notice', 'Supplier accepts', 'Orders'];
  return (
    <>
      {a ? (
        <Panel title={`Award · ${nice(a.status)}`} right={<View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Btn small title="Recommendation PDF" color={c.violet} onPress={() => openDocument('recommendation', a.id, {}, 'recommendation').catch((e) => toast(explain(e)))} />{a.status === 'approved' && can('recommend') ? <Btn small title="Issue award notices" onPress={() => act(() => api.post(`/awards/${a.id}/notify`, {}), 'Award notices issued')} /> : null}{['approval_pending', 'approved', 'notified'].includes(a.status) && can('recommend') ? <Btn small title="Cancel award" color={c.red} onPress={() => setSheet('cancel')} /> : null}</View>}>
          <Checks items={stages.map((s, i) => ({ state: i < step ? 'ok' : i === step ? 'warn' : 'idle', title: s, detail: i === 1 && a.approval ? `${a.approval.approvals} of ${a.approval.required} approvals (never the requester)` : i === 3 && a.accept_by ? `Respond by ${when(a.accept_by, t.timezone)}${a.accept_after && new Date(a.accept_after) > new Date() ? ` · standstill until ${when(a.accept_after, t.timezone)}` : ''}` : undefined }))} />
          <DataTable rows={a.lines} empty="Lines appear when the award notice is issued." cols={[{ key: 'lot_code', label: 'Lot', min: 60, flex: 0.5, bold: true }, { key: 'supplier', label: 'Supplier', flex: 2, min: 150 }, { key: 'amount_minor', label: 'Amount', min: 120, render: (l) => amount(l.amount_minor, l.currency) }, { key: 'status', label: 'Response', min: 130, render: (l) => <View style={{ gap: 4 }}><Status tone={l.status === 'accepted' ? 'ok' : l.status === 'provisional' ? 'warn' : 'bad'} label={nice(l.status)} />{l.reserve_of ? <Status tone="info" label="Reserve bidder" /> : null}</View> }, { key: 'order_ref', label: 'Order', min: 120, render: (l) => l.order_ref ?? '—' }]} />
          <T size={12} color={c.mute}>A provisional award is not a contract or a confirmed order. Accepting creates exactly one order and one budget commitment per lot; contract, delivery and payment are tracked separately.</T>
        </Panel>
      ) : null}
      {(reserve.data?.lots ?? []).length ? (
        <Panel title="Lots open again" right={<Status tone={reserve.data.reserve_policy === 'next_ranked' ? 'info' : 'neutral'} label={reserve.data.reserve_policy === 'next_ranked' ? 'Reserve: next ranked' : 'Reserve: not allowed'} />}>
          {reserve.data.lots.map((l) => (
            <View key={l.lot} style={{ gap: 6, paddingVertical: 8, borderTopWidth: 1, borderColor: c.line }}>
              <T weight="700" size={13}>Lot {l.lot} · {l.title} <T size={12} color={c.mute}>({l.qty_open} still to award)</T></T>
              {l.previous.map((h) => <T key={h.line_id} size={12} color={c.mute}>{h.supplier} {h.status === 'declined' ? 'declined' : 'did not respond'}{h.reason ? `: ${h.reason}` : ''}</T>)}
              {l.allowed ? (l.next ? <T size={13}>Next in ranking order: <T size={13} weight="700">{l.next.supplier}</T> (rank {l.next.rank})</T> : <Notice>No other eligible, ranked bidder priced this lot.</Notice>) : <Notice tone="info">This tender's published rule does not allow the lot to go to another bidder. Re-tender it or close the tender.</Notice>}
            </View>
          ))}
          {reserve.data.reserve_policy === 'next_ranked' && can('scenario') && reserve.data.lots.some((l) => l.next) ? <Btn small title="Build a reserve scenario" onPress={() => act(() => api.post(`/rfps/${id}/scenarios`, { kind: 'highest_score' }), 'Reserve scenario built')} style={{ alignSelf: 'flex-start' }} /> : null}
          <T size={12} color={c.mute}>Offering a lot to a reserve bidder is never automatic. The scenario is recommended and approved again before any notice is issued.</T>
        </Panel>
      ) : null}
      {t.disclosure?.award_public && can('recommend') && ['awarded', 'award', 'closed'].includes(t.status) ? (
        <Panel title="Public award notice" right={(pubs.data ?? []).every((x) => !['approval_pending', 'published'].includes(x.status)) ? <Btn small title="Request publication" onPress={() => setSheet('pub')} accessibilityLabel="Request publication of the award result" /> : null}>
          <T size={13} color={c.mute}>Nothing is public until it is approved by someone other than the requester. You choose exactly which fields appear; losing bids, scores and prices never do.</T>
          {(pubs.data ?? []).length ? pubs.data.map((x) => (
            <View key={x.id} style={{ gap: 6, paddingVertical: 8, borderTopWidth: 1, borderColor: c.line }}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><Status tone={x.status === 'published' ? 'ok' : x.status === 'approval_pending' ? 'warn' : 'neutral'} label={nice(x.status)} />{x.fields.map((f) => <Status key={f} tone="neutral" label={nice(f)} />)}{x.status === 'approval_pending' ? <T size={12} color={c.mute}>{x.approvals}/{x.required} approvals</T> : null}</View>
              <T size={12} color={c.mute}>{x.status === 'published' ? `Published ${day(x.published_at)}` : x.status === 'withdrawn' ? `Withdrawn ${day(x.withdrawn_at)}: ${x.withdraw_reason}` : `Requested ${day(x.requested_at)}`}</T>
              {x.status === 'published' ? <Btn small title="Withdraw" color={c.red} onPress={() => setSheet({ withdraw: x })} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          )) : <T size={13} color={c.mute}>Not requested yet.</T>}
        </Panel>
      ) : null}
      {can('scenario') && ['evaluation', 'award'].includes(t.status) ? (
        <Panel title="Build an award scenario">
          <Chips options={KINDS.map(([value, label]) => ({ value, label }))} value={kind} onChange={setKind} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
            <View style={{ gap: 6 }}><T size={11} weight="700" color={c.mute}>MAX SUPPLIERS (0 = ANY)</T><Counter value={maxS} onChange={setMaxS} min={0} max={50} /></View>
            <View style={{ gap: 6 }}><T size={11} weight="700" color={c.mute}>MINIMUM SCORE</T><Counter value={minScore} onChange={setMinScore} min={0} max={100} step={5} /></View>
            <View style={{ flexGrow: 1, flexBasis: 180 }}><Field label={`Budget limit (${t.currency}, blank = tender budget)`} value={budget} onChangeText={(x) => setBudget(x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" /></View>
          </View>
          <Btn title="Build scenario" onPress={() => act(() => api.post(`/rfps/${id}/scenarios`, { kind, ...(maxS ? { max_suppliers: maxS } : {}), ...(minScore ? { min_score: minScore } : {}), ...(budget ? { budget_minor: toMinor(budget, t.currency) } : {}) }), 'Scenario built')} style={{ alignSelf: 'flex-start' }} />
          <T size={12} color={c.mute}>Small cases are solved exhaustively and marked proven best. Larger ones use a heuristic that is labelled and never presented as a global optimum. Only eligible, ranked bidders are considered; lots already awarded are not offered again.</T>
        </Panel>
      ) : null}
      {(sc.data ?? []).length ? <Panel title="Scenarios"><View style={{ gap: 12 }}>{sc.data.map((s) => <ScenarioCard key={s.id} s={s} cur={t.currency} onRecommend={can('recommend') && ['evaluation', 'award'].includes(t.status) && s.result.allocation?.length ? () => setSheet({ rec: s }) : null} />)}</View></Panel> : can('scenario') ? null : null}
      <Panel title="Orders" right={<Btn small title="All orders" color={c.violet} onPress={() => push('TenderOrders')} />}>
        <DataTable rows={orders.data ?? []} onRow={(o) => push('TenderOrder', { id: o.id })} empty="Orders appear when suppliers accept their awards." cols={[{ key: 'ref', label: 'Order', min: 120, bold: true }, { key: 'supplier', label: 'Supplier', flex: 2, min: 150 }, { key: 'lot_code', label: 'Lot', min: 60, flex: 0.5 }, { key: 'amount_minor', label: 'Amount', min: 120, render: (o) => amount(o.amount_minor, o.currency) }, { key: 'status', label: 'Order', min: 100, render: (o) => <Status tone="info" label={nice(o.status)} /> }, { key: 'contract_status', label: 'Contract', min: 120, render: (o) => nice(o.contract_status) }]} />
      </Panel>
      {(appeals.data ?? []).length ? <Panel title="Appeals">{appeals.data.map((x) => <View key={x.id} style={{ gap: 4, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}><T weight="700" size={13}>{x.supplier} · {nice(x.status)}</T><T size={13}>{x.reason}</T>{x.status === 'open' && can('recommend') ? <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title="Uphold" onPress={() => setSheet({ appeal: x, outcome: 'upheld' })} /><Btn small title="Dismiss" color={c.violet} onPress={() => setSheet({ appeal: x, outcome: 'dismissed' })} /></View> : x.decision ? <T size={12} color={c.mute}>{x.decision}</T> : null}</View>)}</Panel> : null}
      {can('recommend') && ['evaluation', 'award'].includes(t.status) && !(live && ['approval_pending', 'approved', 'notified'].includes(live.status)) ? <Btn small title="Close without an award" color={c.violet} onPress={() => setSheet('noaward')} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={!!sheet?.rec} onClose={() => setSheet(null)} title="Recommend this award" submitLabel="Send for approval" fields={[{ key: 'rationale', label: 'Rationale (at least 20 characters)', type: 'multiline', hint: 'Why this allocation is the best value, against the published rubric.' }, ...(sheet?.rec?.result?.unfilled?.length ? [{ key: 'partial', label: 'I confirm this is a partial award: some lots stay unfilled', type: 'switch' }] : [])]}
        onSubmit={async (v) => { await api.post(`/rfps/${id}/awards`, { scenario_id: sheet.rec.id, rationale: v.rationale, allow_partial: !!v.partial }); sc.reload(); awards.reload(); reload(); return 'Sent for approval. Nothing is awarded until it is approved and issued.'; }} />
      <FormSheet visible={sheet === 'pub'} onClose={() => setSheet(null)} title="Request a public award notice" submitLabel="Send for approval"
        fields={[{ key: 'fields', label: 'What may appear', type: 'multi', options: [{ value: 'supplier', label: 'Supplier names' }, { value: 'lots', label: 'Lots awarded' }, { value: 'award_date', label: 'Award date' }, { value: 'service_period', label: 'Service period' }, { value: 'value', label: 'Contract value (commercially sensitive)' }], hint: 'The contract value is off unless you choose it, and the approver sees that you did.' }, { key: 'note', label: 'Note for the approver (optional)', type: 'multiline' }]} initial={{ fields: ['supplier', 'lots', 'award_date'] }}
        onSubmit={async (v) => { if (!v.fields?.length) throw new Error('Choose at least one field'); await api.post(`/rfps/${id}/award-publication`, { fields: v.fields, note: v.note || undefined }); pubs.reload(); reload(); return 'Sent for approval. It is not public until approved.'; }} />
      <FormSheet visible={!!sheet?.withdraw} onClose={() => setSheet(null)} title="Withdraw the award notice" submitLabel="Withdraw" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/award-publications/${sheet.withdraw.id}/withdraw`, { reason: v.reason }); pubs.reload(); return 'Withdrawn. The record is kept.'; }} />
      <FormSheet visible={sheet === 'cancel'} onClose={() => setSheet(null)} title="Cancel the award" submitLabel="Cancel award" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/awards/${a.id}/cancel`, { reason: v.reason }); awards.reload(); award.reload(); reload(); return 'Award cancelled'; }} />
      <FormSheet visible={sheet === 'noaward'} onClose={() => setSheet(null)} title="Close without an award" submitLabel="Close tender" fields={[{ key: 'reason', label: 'Reason (bidders are told)', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/rfps/${id}/no-award`, { reason: v.reason }); reload(); return 'Closed without an award'; }} />
      <FormSheet visible={!!sheet?.appeal} onClose={() => setSheet(null)} title={`${nice(sheet?.outcome ?? '')} this appeal`} submitLabel="Record decision" fields={[{ key: 'decision', label: 'Decision sent to the supplier', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/appeals/${sheet.appeal.id}/decide`, { outcome: sheet.outcome, decision: v.decision }); appeals.reload(); return 'Recorded'; }} />
    </>
  );
}
