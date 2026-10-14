// "My file" (issue #212): what the athlete sees of the doctor workspace - visit summaries, care plans, tests & results, allergies/medicines,
// referral consent and fit-to-play. The athlete reports and consents; doctors decide. Nothing here shows a doctor's working notes.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, H2, Loading, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { ContextEntry, ContextState, PlanActions, ResultVersions, HistorySheet, ClearanceCard, useAct, valuesBody } from './doctor';
import { c, day } from '../theme';

const NEUTRAL = c.violetSoft;
const Bar = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>{children}</View>;
const Wait = ({ q, empty, children }) => (q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : q.data?.length === 0 && empty ? empty : children);
const Block = ({ title, action, onAction, children }) => (
  <View style={{ gap: 8 }}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><H2>{title}</H2>{action ? <Btn small title={action} color={c.mint} ink={c.ink} onPress={onAction} /> : null}</View>{children}</View>
);

const PLAIN = { requested: 'Waiting for your result', received: 'Received — waiting for your doctor to review it', reviewed: 'Your doctor has reviewed it', patient_informed: 'Your doctor has shared the outcome with you', closed: 'Finished' };

export function MyHealthFile() {
  const [sec, setSec] = useState('plans');
  const Body = { plans: MyPlans, results: MyResults, context: MyContext, referrals: MyReferrals, fit: MyFit }[sec];
  return (
    <View style={{ gap: 12 }}>
      <Card color={c.mintSoft} pad={12}><T weight="800">Your health file</T><T size={12} color={c.mute}>What your doctors have shared with you, and what you tell them. Doctors only see your file while you give them access — change that any time in Access.</T></Card>
      <Seg options={[{ value: 'plans', label: 'Care plans', emoji: '🗂️' }, { value: 'results', label: 'Tests', emoji: '🧪' }, { value: 'context', label: 'Allergies & meds', emoji: '💊' }, { value: 'referrals', label: 'Referrals', emoji: '↗️' }, { value: 'fit', label: 'Fit to play', emoji: '✅' }]} value={sec} onChange={setSec} color={c.mint} />
      <Body key={sec} />
    </View>
  );
}

function PlanItem({ p }) {
  const [open, setOpen] = useState(false);
  const d = useLoad(() => (open ? api.get(`/medical/care-plans/${p.id}`) : Promise.resolve(null)), [open]);
  const act = useAct(d.reload);
  const [note, setNote] = useState(false);
  const pub = d.data?.versions[0];
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="900">{p.title}</T><Tag label={p.status} color={p.status === 'active' ? c.lime : NEUTRAL} /></View>
      <Bar><Btn small title={open ? 'Hide' : 'Open'} color={c.paper} ink={c.ink} onPress={() => setOpen(!open)} /></Bar>
      {open && pub ? (
        <View style={{ marginTop: 8, gap: 4 }}>
          {pub.body.instructions ? <T size={14}>{pub.body.instructions}</T> : null}{(pub.body.goals ?? []).map((g, k) => <T key={k} size={13}>🎯 {g.text}{g.baseline ? ` (where you started: ${g.baseline})` : ''}</T>)}
          {pub.body.review_interval_days ? <T size={12} color={c.mute}>Your doctor plans to review this every {pub.body.review_interval_days} days.</T> : null}
          <PlanActions actions={pub.body.actions}>{(a) => (a.responsible === 'patient' && d.data.status === 'active' && a.state !== 'confirmed' ? (
            <Bar><Btn small title="I did this" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/medical/care-plans/${p.id}/entries`, { kind: 'completed', action_key: a.key }), 'Noted — your doctor can confirm it')} />
              <Btn small title="I couldn't" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/medical/care-plans/${p.id}/entries`, { kind: 'unable', action_key: a.key }), 'Noted')} /></Bar>) : null)}</PlanActions>
          {d.data.status === 'active' ? <Btn small title="Tell my doctor about a symptom" color={c.violet} onPress={() => setNote(true)} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
          <T size={11} color={c.mute}>Marking something done tells your doctor — it doesn't change the plan. Notes are not watched in real time: for anything urgent, call your doctor or emergency services.</T>
        </View>) : null}
      <FormSheet visible={note} onClose={() => setNote(false)} title="Note for your doctor" color={c.mint} submitLabel="Send note" fields={[{ key: 'note', label: 'What have you noticed?', type: 'multiline', hint: 'Not monitored in real time. For anything urgent contact your doctor or emergency services.' }]}
        onSubmit={async (v) => { await api.post(`/medical/care-plans/${p.id}/entries`, { kind: 'symptom', note: v.note }); d.reload(); return 'Sent to your doctor'; }} />
    </Card>
  );
}
function MyPlans() {
  const q = useLoad(() => api.get('/medical/care-plans', { limit: 50 }), []);
  return <Wait q={q} empty={<Empty emoji="🗂️" title="No care plans" sub="When a doctor publishes a plan for you, it appears here with your tasks." />}>{(q.data ?? []).map((p) => <PlanItem key={p.id} p={p} />)}</Wait>;
}

function MyResults() {
  const q = useLoad(() => api.get('/medical/investigations', { limit: 50 }), []);
  const [up, setUp] = useState(null), [hist, setHist] = useState(null);
  const act = useAct(q.reload);
  return (
    <Block title="Tests & results">
      <Wait q={q} empty={<Empty emoji="🧪" title="No tests" sub="Tests your doctor asks for show here. You can add your result when you have it." />}>
        {(q.data ?? []).map((i) => (
          <Card key={i.id}><T weight="900">{i.test}</T><T size={13} color={c.mute}>{PLAIN[i.status]}</T>{i.review_due ? <T size={12} color={c.mute}>Your doctor aims to review it by {day(i.review_due)}</T> : null}
            <ResultVersions results={i.results} />
            <Bar>{i.status !== 'closed' ? <Btn small title="Add my result" color={c.mint} ink={c.ink} onPress={() => setUp(i)} /> : null}<Btn small title="History" color={c.paper} ink={c.mute} onPress={() => setHist(i.id)} /></Bar>
            <T size={11} color={c.mute}>Seeing a result here does not mean a doctor has looked at it yet.</T></Card>
        ))}
      </Wait>
      <FormSheet visible={!!up} onClose={() => setUp(null)} title="Add my result" color={c.mint} submitLabel="Add result"
        fields={[1, 2, 3].flatMap((n) => [{ key: `s${n}`, label: `Value ${n}`, type: 'section' }, { key: `v${n}_name`, label: 'Test', type: 'text', optional: n > 1 }, { key: `v${n}_value`, label: 'Result exactly as printed', type: 'text', optional: n > 1, show: (v) => n === 1 || !!v[`v${n}_name`] },
          { key: `v${n}_unit`, label: 'Unit', type: 'text', optional: true, show: (v) => n === 1 || !!v[`v${n}_name`] }, { key: `v${n}_ref`, label: "The report's reference range", type: 'text', optional: true, show: (v) => n === 1 || !!v[`v${n}_name`] }])}
        onSubmit={async (v) => { await api.post(`/medical/investigations/${up.id}/results`, { values: valuesBody(v) }); q.reload(); return 'Added — your doctor will review it'; }} />
      {hist ? <HistorySheet id={hist} onClose={() => setHist(null)} /> : null}
    </Block>
  );
}

const KIND = { allergy: 'Allergies & intolerances', medication: 'Medicines I take', problem: 'Health problems' };
const STATUSES = { problem: ['active', 'resolved', 'uncertain'], allergy: ['active', 'resolved', 'uncertain'], medication: ['active', 'stopped', 'uncertain'] };
function MyContext() {
  const q = useLoad(() => api.get('/medical/context', { limit: 100 }), []);
  const act = useAct(q.reload);
  const [form, setForm] = useState(null);
  const d = q.data;
  return (
    <Wait q={{ ...q, data: d ? [d] : d }}>
      <T size={12} color={c.mute}>Tell your doctors what you have and take. A doctor will check it with you. If nothing is recorded it shows as "unknown" — say so below if you really have none.</T>
      {d ? ['allergy', 'medication', 'problem'].map((kind) => (
        <Block key={kind} title={KIND[kind]} action="＋ Add" onAction={() => setForm({ kind })}>
          <ContextState kind={kind} state={d.state[kind]} />
          {d.entries.filter((e) => e.kind === kind).map((e) => (
            <ContextEntry key={e.id} e={e}>{e.source === 'patient_reported' && e.verification === 'unverified' ? <Bar><Btn small title="Correct" color={c.violet} onPress={() => setForm({ kind, correct: e })} /></Bar> : null}</ContextEntry>
          ))}
          {kind !== 'problem' && d.state[kind] === 'unknown' ? <Btn small title={`I have no ${kind === 'allergy' ? 'known allergies' : 'regular medicines'}`} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }}
            onPress={() => act(() => api.post('/medical/context/declarations', { kind, state: 'none_reported' }), 'Saved')} /> : null}
        </Block>
      )) : null}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.correct ? 'Correct entry' : `Add ${form ? KIND[form.kind].toLowerCase() : ''}`} color={c.mint}
        fields={form ? [{ key: 'name', label: form.kind === 'allergy' ? 'What are you allergic to?' : form.kind === 'medication' ? 'Medicine name' : 'Problem', type: 'text' }, { key: 'status', label: 'Status', type: 'choice', options: STATUSES[form.kind] },
          ...(form.kind === 'allergy' ? [{ key: 'reaction', label: 'What happens', type: 'text', optional: true }] : []),
          ...(form.kind === 'medication' ? [{ key: 'strength', label: 'Strength', type: 'text', optional: true }, { key: 'frequency', label: 'How often', type: 'text', optional: true }] : []),
          { key: 'note', label: 'Anything else', type: 'text', optional: true }] : []}
        initial={form?.correct ? { name: form.correct.name, status: form.correct.status, ...form.correct.detail } : {}}
        onSubmit={async (v) => {
          const entry = { kind: form.kind, ...v };
          if (form.correct) await api.post(`/medical/context/${form.correct.id}/reconcile`, { action: 'correct', entry }); else await api.post('/medical/context', { entry });
          q.reload(); return 'Saved';
        }} />
    </Wait>
  );
}

function MyReferrals() {
  const q = useLoad(() => api.get('/medical/referrals', { box: 'mine', limit: 50 }), []);
  const act = useAct(q.reload);
  return (
    <Wait q={q} empty={<Empty emoji="↗️" title="No referrals" sub="If a doctor wants to refer you, you'll see exactly what would be shared and decide here." />}>
      {(q.data ?? []).map((r) => (
        <Card key={r.id}><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="900">Dr {r.from_name} → {r.to_name ?? r.external_recipient}</T><Tag label={r.status} color={NEUTRAL} /><Tag label={r.consent === 'granted' ? 'You agreed' : r.consent === 'declined' ? 'You declined' : 'Needs your decision'} color={r.consent === 'granted' ? c.lime : c.sun} /></View>
          <T size={14} style={{ marginTop: 4 }}>{r.reason}</T>
          <T weight="800" size={13} color={c.mute} style={{ marginTop: 6 }}>If you agree, they can see only this:</T>{(r.shared ?? []).map((s, k) => <T key={k} size={13}>• <T weight="800" size={13}>{s.label}:</T> {s.text}</T>)}
          {r.return_summary ? <><T weight="800" size={13} color={c.mute} style={{ marginTop: 6 }}>Their reply</T><T size={13}>{r.return_summary}</T></> : null}
          {r.expires_at ? <T size={12} color={c.mute}>Expires {day(r.expires_at)}</T> : null}
          {!['withdrawn', 'closed', 'completed', 'declined'].includes(r.status) ? (
            <Bar>{r.consent !== 'granted' ? <Btn small title="Agree to share" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/medical/referrals/${r.id}/consent`, { decision: 'grant' }), 'Shared as listed')} /> : null}
              <Btn small title={r.consent === 'granted' ? 'Stop sharing' : 'Decline'} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/medical/referrals/${r.id}/consent`, { decision: 'decline' }), 'Not shared')} /></Bar>) : null}
        </Card>
      ))}
    </Wait>
  );
}

function MyFit() {
  const me = useLoad(() => api.get('/medical/clearances', { limit: 50 }), []);
  return (
    <Block title="Fit to play">
      <T size={12} color={c.mute}>Decisions your doctor has made. Coaches and team staff see only the status and the restrictions listed — never the reason.</T>
      <Wait q={me} empty={<Empty emoji="✅" title="No decisions yet" sub="Until a doctor decides, your status is unknown." />}>
        {(me.data ?? []).map((x) => <ClearanceCard key={x.id} x={x}>{x.doctor_name ? <T size={12} color={c.mute}>Dr {x.doctor_name}</T> : null}{x.internal_note ? <T size={12} color={c.mute}>Note: {x.internal_note}</T> : null}</ClearanceCard>)}
      </Wait>
    </Block>
  );
}
