// Officials Development & Assessment (#486): one formal assessment, as the assessor, the assessed official or the body's licensing staff see it (the server
// shapes what each may read and do), and the assessor's report editor. A report is a private development record: never a public rating, never a result edit.
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Counter } from '../pickers';
import { explain, LoadError } from '../access';
import { c } from '../theme';
import { Banner } from '../federation-ui';
import { Cols } from '../federation-bits';
import { Notes, PURPOSE, REC_OPTIONS, RecTag, ROLE_NAME, StateTag, when, whenTime } from '../officials-dev-ui';

const ago = (iso) => whenTime(iso);

function ScoreRow({ dim, score, scale }) {
  const s = score ?? {};
  return (
    <View style={{ gap: 4, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.line }} accessible accessibilityLabel={`${dim.label}: ${s.na ? 'not applicable' : `${s.score} of ${scale.max}, ${scale.labels[String(s.score)] ?? ''}`}${s.evidence ? `. Evidence: ${s.evidence}` : ''}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <T weight="700" style={{ flex: 1 }}>{dim.label}</T>
        {s.na ? <Tag label="N/A" /> : <View style={{ alignItems: 'flex-end' }}><T size={18} weight="800">{s.score}<T size={12} color={c.mute}> / {scale.max}</T></T><T size={11.5} color={c.mute}>{scale.labels[String(s.score)]}</T></View>}
      </View>
      {dim.description ? <T size={12} color={c.mute}>{dim.description}</T> : null}
      {s.evidence ? <T size={12.5}>Evidence: {s.evidence}</T> : null}
    </View>
  );
}

function ReasonSheet({ visible, onClose, title, label, hint, submit, onSubmit, min = 5 }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={title} submitLabel={submit}
      fields={[{ key: 'reason', label, type: 'multiline', hint }]} onSubmit={async (v) => { if ((v.reason ?? '').trim().length < min) throw new Error(`Write at least ${min} characters`); return onSubmit(v.reason.trim()); }} />
  );
}

export function OfficialAssessment({ id }) {
  const { push } = useNav();
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/officials-development/assessments/${id}`), [id]);
  const [ver, setVer] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(null);
  const a = q.data;
  useEffect(() => { if (a && ver === null) setVer(a.current_version); }, [a, ver]);
  if (q.error && !a) return <Screen><H1>Assessment</H1><LoadError error={q.error} onRetry={q.reload} /></Screen>;
  if (!a) return <Screen><Loading /></Screen>;
  const v = a.versions.find((x) => x.version === (ver ?? a.current_version)) ?? a.versions[a.versions.length - 1];
  const scoreOf = (k) => v?.scores?.find((s) => s.key === k);
  const post = async (key, path, body, msg) => { setBusy(key); try { await api.post(path, body); toast(msg); setSheet(null); q.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const has = (x) => a.actions.includes(x);
  const open = a.appeals.filter((p) => ['lodged', 'under_review'].includes(p.status));
  const side = a.as.assessor ? 'You wrote this report' : a.as.official ? 'This report is about you' : 'Licensing staff view';
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload} wide>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><StateTag status={a.status} /><Tag label={PURPOSE[a.purpose] ?? a.purpose} color={c.cyan} /><RecTag value={v?.recommendation} /></View>
      <H1 style={{ marginTop: 8 }}>{a.event_name}</H1>
      <T size={13} color={c.mute} style={{ marginTop: 2 }}>{a.official_name} · {ROLE_NAME[a.official_role] ?? a.official_role}{a.grade_label ? ` · ${a.grade_label}` : ''} · {a.sport_name} · {when(a.scheduled_at)}</T>
      <T size={12} color={c.mute}>Assessor {a.assessor_name} · {side} · Rubric: {a.rubric.name} v{a.rubric.version}</T>
      {a.status === 'voided' ? <View style={{ marginTop: 10 }}><Banner tone={c.pinkSoft}>Voided by the body{a.voided_at ? ` on ${when(a.voided_at)}` : ''}: {a.void_reason}. The report and every version are kept.</Banner></View> : null}
      {a.status === 'draft' ? <View style={{ marginTop: 10 }}><Banner>Only you can see this draft. Submit it when the report is complete.</Banner></View> : null}
      {a.status === 'submitted' && !a.as.assessor ? <View style={{ marginTop: 10 }}><Banner tone={c.cyanSoft}>Submitted. The body reviews it before it is published to the official.</Banner></View> : null}
      {a.versions.length > 1 ? <View style={{ marginTop: 10 }}><Seg options={a.versions.map((x) => ({ value: x.version, label: `Version ${x.version}${x.version === a.current_version ? ' (current)' : ''}` }))} value={v?.version} onChange={setVer} /></View> : null}
      {v?.correction_reason ? <T size={12.5} style={{ marginTop: 8 }}>Correction on {ago(v.created_at)}: {v.correction_reason}</T> : null}
      <View style={{ marginTop: 12 }}>
        <Cols
          a={<>
            <Card color={c.paper} pad={14}>
              <T weight="800" size={14}>Scores against the rubric</T>
              <T size={11.5} color={c.mute} style={{ marginBottom: 4 }}>Scale {a.rubric.scale.min}–{a.rubric.scale.max}. Scores describe this match; they are not a ranking and they never decide a licence.</T>
              {a.rubric.dimensions.map((d) => <ScoreRow key={d.key} dim={d} score={scoreOf(d.key)} scale={a.rubric.scale} />)}
            </Card>
            <Card color={c.paper} pad={14}>
              <T weight="800" size={14}>What the scale means</T>
              <View style={{ gap: 4, marginTop: 6 }}>{Object.entries(a.rubric.scale.labels).map(([k, t]) => <T key={k} size={12.5}><T weight="800" size={12.5}>{k}</T>  {t}</T>)}</View>
            </Card>
          </>}
          b={<>
            {v?.recommendation ? (
              <Card color={c.cyanSoft} pad={14}>
                <T weight="800" size={14}>Assessor recommendation</T>
                <View style={{ marginTop: 6, flexDirection: 'row' }}><RecTag value={v.recommendation} /></View>
                <T size={12} color={c.mute} style={{ marginTop: 6 }}>A recommendation is advice to the body. A promotion, demotion or renewal is always a separate decision by a person.</T>
              </Card>) : null}
            <Notes title="Strengths" items={v?.narrative?.strengths} />
            <Notes title="Development areas" items={v?.narrative?.development_areas} />
            <Notes title="Required actions" items={v?.narrative?.required_actions} tone={c.sunSoft} />
            <Notes title="Recommended mentoring or training" items={v?.narrative?.recommended_support} />
            {v?.narrative?.observations?.length ? (
              <Card color={c.paper} pad={14}>
                <T weight="800" size={14}>Observations</T>
                <View style={{ gap: 8, marginTop: 8 }}>{v.narrative.observations.map((o, i) => (
                  <View key={`${i}-${o.note}`}><T size={13.5}>{o.note}</T><T size={11.5} color={c.mute}>{[o.minute != null ? `minute ${o.minute}` : null, o.evidence ? `evidence: ${o.evidence}` : null].filter(Boolean).join(' · ')}</T></View>))}</View>
              </Card>) : null}
          </>} />
      </View>

      {a.responses.length ? (
        <Section title="Acknowledgements and comments" color={c.mint}>
          {a.responses.map((r) => (
            <Card key={r.id} color={c.paper} pad={14} style={{ marginBottom: 8 }}>
              <T size={12} color={c.mute}>{r.by_name} · version {r.version} · {ago(r.created_at)}</T>
              <T weight={r.kind === 'acknowledgement' ? '800' : '500'} style={{ marginTop: 2 }}>{r.kind === 'acknowledgement' ? 'Acknowledged: read this version' : r.body}</T>
            </Card>))}
        </Section>) : null}
      {a.appeals.length ? (
        <Section title="Review requests and appeals" color={c.orange}>
          {a.appeals.map((p) => (
            <Card key={p.id} color={['lodged', 'under_review'].includes(p.status) ? c.sunSoft : c.paper} pad={14} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800">{p.kind === 'appeal' ? 'Appeal' : 'Review request'} · version {p.version}</T><StateTag status={p.status} /></View>
              <T size={12} color={c.mute}>{p.lodged_by_name} · {ago(p.created_at)}</T>
              <T style={{ marginTop: 4 }}>{p.grounds}</T>
              {p.decision ? <View style={{ marginTop: 8 }}><T size={12} weight="800">Decision{p.decided_at ? ` · ${ago(p.decided_at)}` : ''}</T><T>{p.decision}</T></View> : null}
              {a.as.official && ['lodged', 'under_review'].includes(p.status) ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => post('w', `/officials-development/appeals/${p.id}/withdraw`, {}, 'Withdrawn')} /> : null}
              {has('decide_appeal') && ['lodged', 'under_review'].includes(p.status) ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {p.status === 'lodged' ? <Btn small title="Start review" color={c.paper} ink={c.ink} onPress={() => post('s', `/officials-development/appeals/${p.id}/decision`, { action: 'start_review' }, 'In review')} /> : null}
                  <Btn small title="Decide" onPress={() => setSheet({ decide: p })} />
                </View>) : null}
            </Card>))}
        </Section>) : null}

      <View style={{ marginTop: 14, flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {has('acknowledge') ? <Btn title="Acknowledge: I have read it" loading={busy === 'ack'} onPress={() => post('ack', `/officials-development/assessments/${a.id}/respond`, { kind: 'acknowledgement' }, 'Acknowledged')} /> : null}
        {has('comment') ? <Btn title="Add a comment" color={c.paper} ink={c.ink} onPress={() => setSheet({ comment: true })} /> : null}
        {has('request_review') && !open.length ? <Btn title="Ask for a review" color={c.paper} ink={c.ink} onPress={() => setSheet({ appeal: 'review' })} /> : null}
        {has('appeal') && !open.length ? <Btn title="Lodge an appeal" color={c.paper} ink={c.ink} onPress={() => setSheet({ appeal: 'appeal' })} /> : null}
        {has('save') ? <Btn title="Continue the draft" onPress={() => push('AssessmentEditor', { assessment_id: a.id })} /> : null}
        {has('correct') ? <Btn title="Correct the report" color={c.paper} ink={c.ink} onPress={() => push('AssessmentEditor', { assessment_id: a.id, correct: true })} /> : null}
        {has('publish') ? <Btn title="Publish to the official" loading={busy === 'pub'} onPress={() => post('pub', `/officials-development/assessments/${a.id}/decision`, { action: 'publish' }, 'Published')} /> : null}
        {has('void') ? <Btn title="Void" color={c.paper} ink={c.red} onPress={() => setSheet({ voidIt: true })} /> : null}
      </View>
      {a.as.official && a.status === 'published' ? <T size={12} color={c.mute} style={{ marginTop: 10 }}>{a.appeal_window.closes_at && new Date(a.appeal_window.closes_at) > new Date() ? `You can ask for a review or appeal until ${when(a.appeal_window.closes_at)}.` : 'The window to ask for a review or appeal has closed.'} Acknowledging means you have read it, not that you agree.</T> : null}

      <FormSheet visible={!!sheet?.comment} onClose={() => setSheet(null)} title="Add a comment" submitLabel="Add comment" fields={[{ key: 'body', label: 'Your comment', type: 'multiline', hint: 'It stays with the report, next to the assessor\'s version.' }]}
        onSubmit={async (x) => { await api.post(`/officials-development/assessments/${a.id}/respond`, { kind: 'comment', body: x.body }); q.reload(); return 'Comment added'; }} />
      <FormSheet visible={!!sheet?.appeal} onClose={() => setSheet(null)} title={sheet?.appeal === 'appeal' ? 'Lodge an appeal' : 'Ask for a review'} submitLabel="Send" fields={[{ key: 'grounds', label: sheet?.appeal === 'appeal' ? 'Grounds for the appeal' : 'What would you like reviewed?', type: 'multiline', hint: 'Only you and the body\'s licensing staff can read this. It does not change the report or any match result.' }]}
        onSubmit={async (x) => { await api.post(`/officials-development/assessments/${a.id}/appeals`, { kind: sheet.appeal, grounds: x.grounds }); q.reload(); return 'Sent to the body'; }} />
      <ReasonSheet visible={!!sheet?.voidIt} onClose={() => setSheet(null)} title="Void this assessment" label="Reason" hint="The official is shown this reason. The report and its versions are kept, marked void." submit="Void assessment" min={10}
        onSubmit={async (reason) => { await api.post(`/officials-development/assessments/${a.id}/decision`, { action: 'void', reason }); q.reload(); return 'Voided'; }} />
      <FormSheet visible={!!sheet?.decide} onClose={() => setSheet(null)} title="Decide" submitLabel="Record decision" initial={{ action: 'dismiss' }}
        fields={[{ key: 'action', label: 'Outcome', type: 'chips', options: [{ value: 'uphold', label: 'Uphold' }, { value: 'partly_uphold', label: 'Partly uphold' }, { value: 'dismiss', label: 'Dismiss' }] },
          { key: 'decision', label: 'Decision the official will read', type: 'multiline', hint: 'Upholding does not edit the report: it asks the assessor to correct it, or you may void it.' }]}
        onSubmit={async (x) => { await api.post(`/officials-development/appeals/${sheet.decide.id}/decision`, { action: x.action, decision: x.decision }); q.reload(); return 'Decision recorded'; }} />
    </Screen>
  );
}

// ------------------------------------------------------------------ the assessor's editor
function Lines({ label, hint, items, onChange, placeholder }) {
  const [t, setT] = useState('');
  const add = () => { const x = t.trim(); if (x) { onChange([...items, x]); setT(''); } };
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      {items.map((x, i) => (
        <View key={`${i}-${x}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <T size={13.5} style={{ flex: 1 }}>• {x}</T>
          <Chip label="Remove" onPress={() => onChange(items.filter((_, j) => j !== i))} />
        </View>))}
      <Field value={t} onChangeText={setT} placeholder={placeholder ?? 'Add a line'} multiline maxLength={600} accessibilityLabel={label} />
      <Btn small title="Add" color={c.paper} ink={c.ink} disabled={!t.trim()} onPress={add} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}

function ObservationLines({ items, onChange }) {
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const [minute, setMinute] = useState(0);
  const add = () => { if (!note.trim()) return; onChange([...items, { note: note.trim(), ...(minute > 0 ? { minute } : {}), ...(evidence.trim() ? { evidence: evidence.trim() } : {}) }]); setNote(''); setEvidence(''); setMinute(0); };
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>Observations with evidence</T>
      <T size={12} color={c.mute}>Moments you saw, with where the evidence is (clip, incident, timestamp).</T>
      {items.map((o, i) => (
        <View key={`${i}-${o.note}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <View style={{ flex: 1 }}><T size={13.5}>• {o.note}</T><T size={11.5} color={c.mute}>{[o.minute != null ? `minute ${o.minute}` : null, o.evidence].filter(Boolean).join(' · ')}</T></View>
          <Chip label="Remove" onPress={() => onChange(items.filter((_, j) => j !== i))} />
        </View>))}
      <Field value={note} onChangeText={setNote} placeholder="What you saw" multiline maxLength={600} accessibilityLabel="Observation" />
      <Field value={evidence} onChangeText={setEvidence} placeholder="Where the evidence is (optional)" maxLength={300} accessibilityLabel="Evidence reference" />
      <Counter label="Match minute (0 = not specific)" value={minute} onChange={setMinute} min={0} max={300} />
      <Btn small title="Add observation" color={c.paper} ink={c.ink} disabled={!note.trim()} onPress={add} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}

export function AssessmentEditor({ observation_id, assessment_id, correct }) {
  const { back, replace } = useNav();
  const { toast } = useSession();
  const [a, setA] = useState(null);
  const [error, setError] = useState(null);
  const [scores, setScores] = useState({});
  const [nar, setNar] = useState({ strengths: [], development_areas: [], required_actions: [], recommended_support: [], observations: [] });
  const [rec, setRec] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const d = assessment_id ? await api.get(`/officials-development/assessments/${assessment_id}`) : await api.post(`/officials-development/observations/${observation_id}/assessment`, { scores: [], narrative: {} });
        setA(d);
        const last = d.versions[d.versions.length - 1];
        setScores(Object.fromEntries((last?.scores ?? []).map((s) => [s.key, s])));
        if (last?.narrative) setNar({ strengths: [], development_areas: [], required_actions: [], recommended_support: [], observations: [], ...last.narrative });
        setRec(last?.recommendation ?? null);
      } catch (e) { setError(e); }
    })();
  }, [observation_id, assessment_id]);
  const payload = useMemo(() => Object.values(scores).filter((s) => s.na || s.score != null).map((s) => ({ key: s.key, score: s.na ? null : s.score, na: !!s.na, evidence: s.evidence ?? '' })), [scores]);
  if (error) return <Screen><H1>Assessment</H1><LoadError error={error} onRetry={() => setError(null)} /></Screen>;
  if (!a) return <Screen><Loading /></Screen>;
  const dims = a.rubric.dimensions, scale = a.rubric.scale;
  const set = (k, patch) => setScores((p) => ({ ...p, [k]: { key: k, ...p[k], ...patch } }));
  const levels = Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i);
  const missing = dims.filter((d) => { const s = scores[d.key]; return !s || (s.score == null && !s.na); });
  const needEvidence = dims.filter((d) => d.evidence_required && scores[d.key]?.score != null && !scores[d.key]?.evidence?.trim());
  const complete = !missing.length && !needEvidence.length && rec && (nar.strengths.length || nar.development_areas.length) && (!correct || reason.trim().length >= 5);
  const run = async (key, fn, msg) => { setBusy(key); try { await fn(); toast(msg); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const save = () => run('save', async () => { await api.post(`/officials-development/observations/${a.observation_id}/assessment`, { scores: payload, narrative: nar, ...(rec ? { recommendation: rec } : {}) }); }, 'Draft saved');
  const submit = () => run('submit', async () => {
    if (correct) await api.post(`/officials-development/assessments/${a.id}/correct`, { scores: payload, narrative: nar, recommendation: rec, reason: reason.trim() });
    else { await api.post(`/officials-development/observations/${a.observation_id}/assessment`, { scores: payload, narrative: nar, ...(rec ? { recommendation: rec } : {}) }); await api.post(`/officials-development/assessments/${a.id}/submit`, {}); }
    setConfirm(false); replace('OfficialAssessment', { id: a.id });
  }, correct ? 'Correction added as a new version' : 'Submitted');
  return (
    <Screen wide>
      <H1>{correct ? 'Correct the report' : 'Assessment report'}</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>{a.official_name} · {ROLE_NAME[a.official_role] ?? a.official_role} · {a.event_name} · {PURPOSE[a.purpose]}. Rubric: {a.rubric.name} v{a.rubric.version}.</T>
      <View style={{ marginTop: 10 }}><Banner tone={c.cyanSoft}>{correct ? 'Your correction becomes a new version. The earlier version stays in the history and the official is asked to acknowledge again.' : 'Your draft is private until you submit. After that it is an immutable version 1; later changes are corrections.'}</Banner></View>
      <Section title="Score each dimension" color={c.pink}>
        <View style={{ gap: 12 }}>
          {dims.map((d) => {
            const s = scores[d.key] ?? {};
            return (
              <Card key={d.key} color={c.paper} pad={14}>
                <T weight="800">{d.label}{d.evidence_required ? '  ·  evidence required' : ''}</T>
                {d.description ? <T size={12.5} color={c.mute}>{d.description}</T> : null}
                {d.evidence_expectation ? <T size={12} color={c.mute}>Evidence expected: {d.evidence_expectation}</T> : null}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {levels.map((n) => <Chip key={n} label={`${n} · ${scale.labels[String(n)]}`} active={!s.na && s.score === n} onPress={() => set(d.key, { score: n, na: false })} />)}
                  {d.allow_na ? <Chip label="N/A" active={!!s.na} onPress={() => set(d.key, { na: true, score: null })} /> : null}
                </View>
                {!s.na && s.score != null ? <View style={{ marginTop: 8 }}><Field value={s.evidence ?? ''} onChangeText={(t) => set(d.key, { evidence: t })} placeholder={d.evidence_required ? 'Evidence for this rating' : 'Evidence (optional)'} multiline maxLength={500} accessibilityLabel={`Evidence for ${d.label}`} /></View> : null}
              </Card>);
          })}
        </View>
      </Section>
      <Section title="Your report" color={c.cyan}>
        <View style={{ gap: 16 }}>
          <Lines label="Strengths" items={nar.strengths} onChange={(x) => setNar({ ...nar, strengths: x })} />
          <Lines label="Development areas" items={nar.development_areas} onChange={(x) => setNar({ ...nar, development_areas: x })} />
          <Lines label="Required actions" hint="Each becomes an action on the official's own list." items={nar.required_actions} onChange={(x) => setNar({ ...nar, required_actions: x })} />
          <Lines label="Recommended mentoring or training" items={nar.recommended_support} onChange={(x) => setNar({ ...nar, recommended_support: x })} />
          <ObservationLines items={nar.observations} onChange={(x) => setNar({ ...nar, observations: x })} />
        </View>
      </Section>
      <Section title="Recommendation" color={c.mint}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{REC_OPTIONS.map((o) => <Chip key={o.value} label={o.label} active={rec === o.value} onPress={() => setRec(o.value)} />)}</View>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>Advice to the body only. It never promotes or demotes anyone by itself.</T>
      </Section>
      {correct ? <View style={{ marginTop: 12 }}><Field label="Why are you correcting it?" value={reason} onChangeText={setReason} multiline maxLength={500} /></View> : null}
      {(missing.length || needEvidence.length) ? <T size={12.5} color={c.mute} style={{ marginTop: 12 }}>Still needed: {[...missing.map((d) => d.label), ...needEvidence.map((d) => `evidence for ${d.label}`)].join(', ')}.</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        {!correct ? <Btn title="Save draft" color={c.paper} ink={c.ink} loading={busy === 'save'} onPress={save} /> : null}
        <Btn title={correct ? 'Add correction' : 'Submit report'} disabled={!complete} onPress={() => setConfirm(true)} />
        <Btn title="Back" color={c.paper} ink={c.ink} onPress={back} />
      </View>
      <Sheet visible={confirm} onClose={() => setConfirm(false)} title={correct ? 'Add this correction?' : 'Submit this report?'}>
        <View style={{ gap: 12 }}>
          <T size={13.5}>{correct ? 'It is added as a new version with your reason.' : 'It becomes version 1 and cannot be edited. The body\'s policy decides whether it reaches the official straight away or after its own review.'}</T>
          <Btn title={correct ? 'Add correction' : 'Submit'} loading={busy === 'submit'} onPress={submit} />
        </View>
      </Sheet>
    </Screen>
  );
}
