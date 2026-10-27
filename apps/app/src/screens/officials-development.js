// Officials Development & Assessment (#486): the OFFICIAL and ASSESSOR side. One home for an official's development (grade and renewal readiness, next-grade
// requirements, assessments, actions, mentoring, CPD, fitness) and, for an appointed assessor, the observations they were asked to write up. Every rule is
// decided by the server (api capabilities, shared with REST/OpenAPI/MCP); this only shows what it returns and hides what a role cannot use.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { explain, LoadError } from '../access';
import { c, grad } from '../theme';
import { Banner, Checks, Metric, StatusTag, fmtDate } from '../federation-ui';
import { Cols, ListCard } from '../federation-bits';
import { Progress, PURPOSE, RecTag, REC_OPTIONS, ROLE_NAME, StateTag, when, whenTime } from '../officials-dev-ui';

const days = (d) => (d === null || d === undefined ? '' : d < 0 ? `ended ${-d} days ago` : d === 0 ? 'ends today' : `${d} days left`);
const gradeName = (g) => (g.grade && !String(g.type_name).toLowerCase().includes(String(g.grade).toLowerCase()) ? `${g.type_name} · ${g.grade}` : g.type_name);
const FITNESS = { valid: 'Valid', expiring: 'Expiring soon', expired: 'Expired', failed: 'Not passed', missing: 'No result yet' };

// ------------------------------------------------------------------ overview
function GradeCard({ g, onApply, busy }) {
  const { push } = useNav();
  const next = g.next_grade;
  return (
    <Card color={c.paper}>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <T weight="800" size={17}>{gradeName(g)}</T>
            <T size={12.5} color={c.mute}>{g.body_name} · {g.sport_name} · {g.licence_no}</T>
          </View>
          <StatusTag status={g.status === 'active' ? 'good_standing' : g.status} />
        </View>
        <T size={12.5} color={c.mute}>Valid to {fmtDate(g.expires_on)} · {days(g.days_to_expiry)}</T>
        {g.renewal.checks.length ? <Checks checks={g.renewal.checks} title={g.renewal.window_open ? 'Ready to renew?' : 'What renewal asks'} /> : <T size={12.5} color={c.mute}>Renewal asks for nothing beyond the licence itself.</T>}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="Licence record" color={c.paper} ink={c.ink} onPress={() => push('FederationRecord', { type: 'licence', id: g.id })} />
          {g.renewal.window_open ? <Btn small title="Renew" onPress={() => push('FederationRecord', { type: 'licence', id: g.id })} /> : null}
        </View>
        {next ? (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="800" size={14}>Next grade: {next.name}</T><T size={12} color={c.mute}>{next.has_requirements ? (next.ready ? 'You meet every requirement. Apply when you are ready.' : 'Some requirements are still open.') : 'No extra requirements are set; the body decides on your application.'}</T></View>
              <Tag label={next.applied ? 'Applied' : next.ready ? 'Ready' : 'In progress'} color={next.applied || next.ready ? c.mint : c.sun} />
            </View>
            {next.checks.length ? <Checks checks={next.checks} title="Requirements for this grade" /> : null}
            {!next.applied ? <Btn small title={`Apply for ${next.name}`} loading={busy === next.type_id} onPress={() => onApply(g, next)} /> : <T size={12} color={c.mute}>Your application is with {g.body_name}; follow it under Applications.</T>}
          </View>) : null}
      </View>
    </Card>
  );
}

function Overview({ home, setTab, reload }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [busy, setBusy] = useState(null);
  const apply = async (g, next) => {
    setBusy(next.type_id);
    try { const l = await api.post('/federation/licences', { body_id: g.body_id, type_id: next.type_id }); toast('Application started. Add anything the body asks for and send it.'); reload(); push('FederationRecord', { type: 'licence', id: l.id }); }
    catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 4 }}>
      <Cols
        a={<>
          <Section title="Your grade" color={c.pink}>{home.grades.map((g) => <GradeCard key={g.id} g={g} onApply={apply} busy={busy} />)}</Section>
          {home.applications.length ? (
            <Section title="Applications in progress" color={c.sun}>
              {home.applications.map((a) => <ListCard key={a.id} title={gradeName(a)} sub={`${a.body_name} · ${a.previous_id ? 'Renewal' : 'Application'}`} status={a.recorded_status} onPress={() => push('FederationRecord', { type: 'licence', id: a.id })} />)}
            </Section>) : null}
        </>}
        b={<>
          <Section title="Recent assessments" color={c.cyan} action="All" onAction={() => setTab('assessments')}>
            {home.recent_assessments.length ? home.recent_assessments.map((a) => (
              <ListCard key={a.id} title={a.event_name} sub={`${PURPOSE[a.purpose] ?? a.purpose} · ${when(a.published_at)}`} status={a.status} right={a.status === 'published' ? <RecTag value={a.recommendation} /> : null}
                sub2={a.status === 'published' && a.needs_acknowledgement ? 'Waiting for your acknowledgement' : a.appeal_open ? 'Review or appeal open' : undefined} tone={a.status === 'published' && a.needs_acknowledgement ? c.sunSoft : undefined}
                onPress={() => push('OfficialAssessment', { id: a.id })} />)) : <Empty emoji="📝" title="No assessments yet" sub="When an assessor writes up a match you officiated, the report appears here once it is published to you." />}
          </Section>
          {home.upcoming_observations.length ? (
            <Section title="You will be observed" color={c.violet}>
              {home.upcoming_observations.map((o) => <ListCard key={o.id} title={o.event_name} sub={`${PURPOSE[o.purpose] ?? o.purpose} · ${whenTime(o.scheduled_at)}`} />)}
            </Section>) : null}
          <Section title="Open actions" color={c.mint} action="All" onAction={() => setTab('growth')}>
            {home.development.next.length ? home.development.next.slice(0, 4).map((i) => <ListCard key={i.id} title={i.title} sub={[i.kind === 'action' ? 'Action' : 'Goal', i.due_on ? `due ${fmtDate(i.due_on)}` : null].filter(Boolean).join(' · ')} tone={i.overdue ? c.sunSoft : undefined} />)
              : <Empty emoji="🎯" title="Nothing open" sub="Actions from your assessments and the goals you set appear here." />}
          </Section>
        </>} />
    </View>
  );
}

// ------------------------------------------------------------------ assessments
function AssessmentsTab() {
  const { push } = useNav();
  const q = useLoad(() => api.get('/officials-development/assessments', { mine: true, limit: 50 }), []);
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const privateNote = <T size={12} color={c.mute} style={{ marginBottom: 8 }}>Formal assessments are private development records. They are separate from the public reviews people leave about you, and they never change a match result.</T>;
  return (
    <View>
      {privateNote}
      {q.data.items.length ? q.data.items.map((a) => (
        <View key={a.id} style={{ marginBottom: 10 }}>
          <ListCard title={a.event_name} sub={`${ROLE_NAME[a.official_role] ?? a.official_role} · ${a.grade_label || 'grade n/a'} · ${when(a.published_at ?? a.scheduled_at)}`} sub2={`Assessor ${a.assessor_name}`} status={a.status}
            right={a.status === 'published' ? <RecTag value={a.recommendation} /> : null} tone={a.status === 'published' && a.needs_acknowledgement ? c.sunSoft : undefined} onPress={() => push('OfficialAssessment', { id: a.id })} />
        </View>)) : <Empty emoji="📝" title="No assessments published to you" sub="They appear here as soon as your body publishes them." />}
    </View>
  );
}

// ------------------------------------------------------------------ growth: actions, goals, mentoring
function PlanDraft({ visible, onClose, onAdd }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useSession();
  const run = async () => { setBusy(true); try { setDraft(await api.post('/me/officials-development/plan-draft', {})); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  return (
    <Sheet visible={visible} onClose={() => { setDraft(null); onClose(); }} title="Draft goals from my feedback">
      <View style={{ gap: 12 }}>
        <T size={13} color={c.mute}>A draft written from your own published assessments only. It does not grade you or say anything about your licence; you decide which lines to keep.</T>
        {!draft ? <Btn title="Draft my goals" loading={busy} onPress={run} /> : (
          <>
            <T weight="800">{draft.headline}</T>
            {draft.items.length ? draft.items.map((it, i) => (
              <Card key={`${i}-${it.title}`} color={c.paper} pad={12}>
                <T weight="700">{it.title}</T>{it.detail ? <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{it.detail}</T> : null}
                <Btn small title="Add as a goal" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => onAdd(it)} />
              </Card>)) : <Empty emoji="🗒️" title="Nothing to draft yet" sub={draft.limitations?.[0]} />}
            {draft.items.length ? <T size={11.5} color={c.mute}>{draft.source === 'ai' ? 'Drafted by AI. ' : 'Plain list. '}{draft.limitations?.[0]}</T> : null}
          </>)}
      </View>
    </Sheet>
  );
}

function GrowthTab({ home, reload }) {
  const { toast, user: me } = useSession();
  const items = useLoad(() => api.get('/officials-development/items', { mine: true, limit: 100 }), []);
  const [goal, setGoal] = useState(null);
  const [mentor, setMentor] = useState(false);
  const [plan, setPlan] = useState(false);
  const [note, setNote] = useState(null);
  const bodies = useMemo(() => [...new Map(home.grades.map((g) => [g.body_id, { value: g.body_id, label: g.body_abbreviation ?? g.body_name }])).values()], [home.grades]);
  const mark = async (it, status) => { try { await api.post(`/officials-development/items/${it.id}`, { status }); items.reload(); reload(); } catch (e) { toast(explain(e)); } };
  const respond = async (m, response) => { try { await api.post(`/officials-development/mentorships/${m.id}/respond`, { response }); reload(); } catch (e) { toast(explain(e)); } };
  const open = (items.data?.items ?? []).filter((i) => i.status === 'open'), done = (items.data?.items ?? []).filter((i) => i.status !== 'open');
  const mentorships = home.mentoring.items;
  return (
    <>
    <Cols
      a={<>
        <Section title="Goals and actions" color={c.mint}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <Btn small title="Add a goal" onPress={() => setGoal({})} />
            <Btn small title="Draft from my feedback" color={c.paper} ink={c.ink} onPress={() => setPlan(true)} />
          </View>
          {!items.data ? <Loading /> : open.length ? open.map((i) => (
            <Card key={i.id} color={i.overdue ? c.sunSoft : c.paper} pad={14} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <T weight="700">{i.title}</T>{i.detail ? <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{i.detail}</T> : null}
                  <T size={12} color={c.mute} style={{ marginTop: 4 }}>{[i.kind === 'action' ? (i.source_type === 'assessment' ? 'From an assessment' : i.source_type === 'body' ? 'From your body' : 'Action') : i.kind === 'meeting' ? 'Meeting' : 'Goal', i.due_on ? `due ${fmtDate(i.due_on)}` : null].filter(Boolean).join(' · ')}</T>
                </View>
                <Btn small title="Done" color={c.paper} ink={c.ink} onPress={() => mark(i, 'done')} />
              </View>
            </Card>)) : <Empty emoji="🎯" title="No open goals or actions" sub="Set a goal, or turn feedback into one." />}
          {done.length ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{done.length} completed or closed are kept in your history.</T> : null}
        </Section>
      </>}
      b={<>
        <Section title="Mentoring" color={c.cyan}>
          <View style={{ marginBottom: 8 }}><Btn small title="Propose a mentoring relationship" color={c.paper} ink={c.ink} onPress={() => setMentor(true)} style={{ alignSelf: 'flex-start' }} /></View>
          {mentorships.length ? mentorships.map((m) => (
            <Card key={m.id} color={m.needs_my_response ? c.sunSoft : c.paper} pad={14} style={{ marginBottom: 8 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800">{m.role === 'mentor' ? `Mentoring ${m.mentee_name}` : `Mentor: ${m.mentor_name}`}</T><StateTag status={m.status} /></View>
                <T size={12} color={c.mute}>{m.sport_name} · from {fmtDate(m.starts_on)}{m.ends_on ? ` to ${fmtDate(m.ends_on)}` : ''}</T>
                {m.scope ? <T size={12.5}>{m.scope}</T> : null}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {m.needs_my_response ? <><Btn small title="Accept" onPress={() => respond(m, 'accept')} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => respond(m, 'decline')} /></> : null}
                  {m.status === 'active' ? <Btn small title={m.role === 'mentor' ? 'Add goal, action or note' : 'Add a goal'} color={c.paper} ink={c.ink} onPress={() => setNote(m)} /> : null}
                </View>
              </View>
            </Card>)) : <Empty emoji="🤝" title="No mentoring yet" sub="A mentor or mentee relationship is agreed by both people. A mentor only sees the goals, actions and meetings of that relationship." />}
          {home.mentoring.mentee_actions_overdue ? <Banner tone={c.sunSoft}>{home.mentoring.mentee_actions_overdue} of your mentees' actions are overdue.</Banner> : null}
        </Section>
      </>} />
    <GrowthSheets {...{ items, home, reload, goal, setGoal, mentor, setMentor, plan, setPlan, note, setNote, bodies, me }} />
    </>
  );
}

function GrowthSheets({ items, home, reload, goal, setGoal, mentor, setMentor, plan, setPlan, note, setNote, bodies, me }) {
  return (
    <>
      <GoalSheet value={goal} onClose={() => setGoal(null)} bodies={bodies} onSaved={() => { items.reload(); reload(); }} />
      <MentorSheet visible={mentor} onClose={() => setMentor(false)} bodies={bodies} me={me} grades={home.grades} onSaved={reload} />
      <NoteSheet m={note} onClose={() => setNote(null)} onSaved={() => { items.reload(); reload(); }} />
      <PlanDraft visible={plan} onClose={() => setPlan(false)} onAdd={(it) => { setPlan(false); setGoal({ title: it.title, detail: it.detail }); }} />
    </>
  );
}

function GoalSheet({ value, onClose, bodies, onSaved }) {
  return (
    <FormSheet visible={!!value} onClose={onClose} title="Add a goal" submitLabel="Save goal" initial={{ body_id: bodies[0]?.value, ...value }}
      fields={[
        ...(bodies.length > 1 ? [{ key: 'body_id', label: 'Body', type: 'chips', options: bodies }] : []),
        { key: 'title', label: 'Goal', hint: 'What do you want to get better at?' },
        { key: 'detail', label: 'How will you know?', type: 'multiline', optional: true },
        { key: 'due_on', label: 'Aim to finish by', type: 'date', optional: true },
      ]}
      onSubmit={async (v) => { await api.post('/officials-development/items', { body_id: v.body_id ?? bodies[0]?.value, kind: 'goal', title: v.title, ...(v.detail ? { detail: v.detail } : {}), ...(v.due_on ? { due_on: v.due_on } : {}) }); onSaved(); return 'Goal added'; }} />
  );
}

function NoteSheet({ m, onClose, onSaved }) {
  const mentor = m?.role === 'mentor';
  return (
    <FormSheet visible={!!m} onClose={onClose} title={m ? `With ${mentor ? m.mentee_name : m.mentor_name}` : ''} submitLabel="Save"
      fields={[
        { key: 'kind', label: 'What is it?', type: 'chips', options: mentor ? [{ value: 'goal', label: 'Goal' }, { value: 'action', label: 'Action' }, { value: 'meeting', label: 'Meeting' }] : [{ value: 'goal', label: 'Goal' }, { value: 'action', label: 'Action' }] },
        { key: 'title', label: 'Title' },
        { key: 'detail', label: 'Notes', type: 'multiline', optional: true },
        { key: 'happened_on', label: 'Met on', type: 'date', show: (v) => v.kind === 'meeting' },
        { key: 'due_on', label: 'Due', type: 'date', optional: true, show: (v) => v.kind !== 'meeting' },
        ...(mentor ? [{ key: 'private', label: 'Keep this note to myself', type: 'switch', hint: 'The mentee will not see it. Your body never sees the text of any note.' }] : []),
      ]}
      onSubmit={async (v) => { await api.post('/officials-development/items', { body_id: m.body_id, mentorship_id: m.id, kind: v.kind, title: v.title, ...(v.detail ? { detail: v.detail } : {}), ...(v.happened_on ? { happened_on: v.happened_on } : {}), ...(v.due_on ? { due_on: v.due_on } : {}), visibility: v.private ? 'mentor_only' : 'shared' }); onSaved(); return 'Saved'; }} />
  );
}

function MentorSheet({ visible, onClose, bodies, grades, me, onSaved }) {
  const [who, setWho] = useState([]);
  const sports = useMemo(() => [...new Map(grades.map((g) => [g.sport_id, { value: g.sport_id, label: g.sport_name }])).values()], [grades]);
  return (
    <FormSheet visible={visible} onClose={() => { setWho([]); onClose(); }} title="Propose mentoring" submitLabel="Send proposal"
      initial={{ body_id: bodies[0]?.value, sport_id: sports[0]?.value, role: 'mentee' }}
      fields={[
        { key: 'role', label: 'I am the', type: 'chips', options: [{ value: 'mentee', label: 'Mentee' }, { value: 'mentor', label: 'Mentor' }] },
        { key: 'person', label: 'The other person', type: 'entity', entityKind: 'person', role: 'referee', noun: 'official', onPick: (p) => setWho([p]) },
        ...(bodies.length > 1 ? [{ key: 'body_id', label: 'Body', type: 'chips', options: bodies }] : []),
        ...(sports.length > 1 ? [{ key: 'sport_id', label: 'Sport', type: 'chips', options: sports }] : []),
        { key: 'scope', label: 'What will it cover?', type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => {
        const other = who[0]?.id ?? v.person;
        if (!other) throw new Error('Pick the other person');
        await api.post('/officials-development/mentorships', { body_id: v.body_id ?? bodies[0]?.value, sport_id: v.sport_id ?? sports[0]?.value, mentor_id: v.role === 'mentor' ? me.id : other, mentee_id: v.role === 'mentor' ? other : me.id, ...(v.scope ? { scope: v.scope } : {}) });
        setWho([]); onSaved(); return 'Proposal sent';
      }} />
  );
}

// ------------------------------------------------------------------ CPD and fitness
function CpdSheet({ visible, onClose, bodies, onSaved }) {
  const creds = useLoad(() => (visible ? api.get('/me/credentials', { limit: 50 }) : Promise.resolve([])), [visible]);
  const usable = (creds.data ?? []).filter((x) => x.status === 'issued' && !x.expired);
  return (
    <FormSheet visible={visible} onClose={onClose} title="Record CPD" submitLabel="Save" initial={{ body_id: bodies[0]?.value, kind: 'course', hours: 1, credits: 0 }}
      fields={[
        ...(bodies.length > 1 ? [{ key: 'body_id', label: 'Counts for', type: 'chips', options: bodies }] : []),
        { key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'course', label: 'Course' }, { value: 'module', label: 'Module' }, { value: 'workshop', label: 'Workshop' }, { value: 'conference', label: 'Conference' }, { value: 'mentoring', label: 'Mentoring' }, { value: 'other', label: 'Other' }] },
        { key: 'title', label: 'Title' },
        ...(usable.length ? [{ key: 'credential_id', label: 'Backed by a certificate I hold', type: 'chips', optional: true, options: usable.map((x) => ({ value: x.id, label: `${x.title} · ${x.institution}` })), hint: 'A certificate issued by an institution counts straight away. Anything else is checked by your body first.' }] : []),
        { key: 'provider_name', label: 'Provider', optional: true },
        { key: 'completed_on', label: 'Completed on', type: 'date' },
        { key: 'hours', label: 'Hours', type: 'stepper', min: 0, max: 200, default: 1 },
        { key: 'credits', label: 'Credits (if the provider defines them)', type: 'stepper', min: 0, max: 200, default: 0 },
        { key: 'expires_on', label: 'Valid until (if it expires)', type: 'date', optional: true },
        { key: 'evidence', label: 'Reference or note for the verifier', optional: true },
      ]}
      onSubmit={async (v) => {
        await api.post('/officials-development/cpd', { body_id: v.body_id ?? bodies[0]?.value, kind: v.kind, title: v.title, completed_on: v.completed_on, hours: v.hours, credits: v.credits,
          ...(v.provider_name ? { provider_name: v.provider_name } : {}), ...(v.credential_id ? { credential_id: v.credential_id } : {}), ...(v.expires_on ? { expires_on: v.expires_on } : {}), ...(v.evidence ? { evidence: v.evidence } : {}) });
        onSaved(); return 'CPD recorded';
      }} />
  );
}

function CpdFitnessTab({ home, reload }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/officials-development/cpd', { mine: true, limit: 50 }), []);
  const [form, setForm] = useState(false);
  const bodies = useMemo(() => [...new Map(home.grades.map((g) => [g.body_id, { value: g.body_id, label: g.body_abbreviation ?? g.body_name }])).values()], [home.grades]);
  const withdraw = async (r) => { try { await api.post(`/officials-development/cpd/${r.id}/withdraw`, {}); list.reload(); reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Cols
      a={<Section title="Continuing professional development" color={c.mint}>
        <View style={{ gap: 12, marginBottom: 10 }}>
          {home.cpd.map((p) => p.required_hours > 0
            ? <Progress key={p.body_id} label={p.body_name} value={p.verified_hours} target={p.required_hours} unit="h" sub={`Verified hours in the last ${p.window_months} months${p.pending_verification ? ` · ${p.pending_verification} awaiting verification` : ''}`} />
            : <T key={p.body_id} size={13} color={c.mute}>{p.body_name} sets no CPD hours for your grade. {p.verified_hours}h verified in the last {p.window_months} months.</T>)}
        </View>
        <Btn small title="Record CPD" onPress={() => setForm(true)} style={{ alignSelf: 'flex-start', marginBottom: 8 }} />
        {!list.data ? <Loading /> : list.data.items.length ? list.data.items.map((r) => (
          <Card key={r.id} color={c.paper} pad={14} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <T weight="700">{r.title}</T>
                <T size={12} color={c.mute}>{r.kind} · {fmtDate(r.completed_on)} · {r.hours}h{r.credits ? ` · ${r.credits} credits` : ''}{r.provider_name || r.provider_org_name ? ` · ${r.provider_org_name ?? r.provider_name}` : ''}</T>
                {r.status === 'rejected' && r.decision_reason ? <T size={12} style={{ marginTop: 4 }}>{r.decision_reason}</T> : null}
              </View>
              <View style={{ gap: 6, alignItems: 'flex-end' }}><StateTag status={r.status} />{['recorded', 'verified'].includes(r.status) ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => withdraw(r)} /> : null}</View>
            </View>
          </Card>)) : <Empty emoji="🎓" title="No CPD recorded" sub="Courses, workshops and modules you complete count toward your renewal once verified." />}
        <CpdSheet visible={form} onClose={() => setForm(false)} bodies={bodies} onSaved={() => { list.reload(); reload(); }} />
      </Section>}
      b={<Section title="Fitness and competency" color={c.cyan}>
        {home.fitness.length ? home.fitness.map((f) => (
          <Card key={f.test_id} color={f.status === 'valid' ? c.paper : f.status === 'expiring' ? c.sunSoft : c.paper} pad={14} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}><T weight="700">{f.name}</T><T size={12} color={c.mute}>v{f.version}{f.taken_on ? ` · taken ${fmtDate(f.taken_on)}` : ''}{f.valid_until ? ` · valid to ${fmtDate(f.valid_until)}` : ''}</T></View>
              <StateTag status={f.status} label={FITNESS[f.status]} />
            </View>
          </Card>)) : <Empty emoji="🏃" title="No fitness or competency test applies" sub="If your body requires one, your result and its validity appear here. Only the operational result is stored, never health information." />}
        <T size={11.5} color={c.mute}>Results are visible to you and your body's licensing staff only.</T>
      </Section>} />
  );
}

// ------------------------------------------------------------------ assessor
function ConflictSheet({ obs, onClose, onDone }) {
  const { toast } = useSession();
  const [mode, setMode] = useState('none');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const send = async (response) => {
    setBusy(response);
    try { await api.post(`/officials-development/observations/${obs.id}/respond`, { response, conflict: response === 'accept' ? 'none' : mode, ...(mode === 'declared' && note.trim() ? { conflict_note: note.trim() } : {}) }); onClose(); onDone(); toast(response === 'accept' ? 'Accepted' : 'Declined'); }
    catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };
  return (
    <Sheet visible={!!obs} onClose={onClose} title="Assignment to assess">
      {obs ? (
        <View style={{ gap: 12 }}>
          <View><T weight="800">{obs.official_name} · {ROLE_NAME[obs.official_role] ?? obs.official_role}</T><T size={12.5} color={c.mute}>{obs.event_name} · {whenTime(obs.scheduled_at)} · {PURPOSE[obs.purpose]}</T></View>
          <T size={13} weight="700">Conflict of interest</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Chip label="I have no conflict of interest" active={mode === 'none'} onPress={() => setMode('none')} />
            <Chip label="I have a conflict" active={mode === 'declared'} onPress={() => setMode('declared')} />
          </View>
          {mode === 'declared' ? <Field label="What is the conflict?" value={note} onChangeText={setNote} multiline maxLength={500} hint="Only you and the body's licensing staff can read this." /> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn title="Accept" disabled={mode !== 'none'} loading={busy === 'accept'} onPress={() => send('accept')} />
            <Btn title={mode === 'declared' ? 'Decline: conflict' : 'Decline'} color={c.paper} ink={c.ink} disabled={mode === 'declared' && !note.trim()} loading={busy === 'decline'} onPress={() => send('decline')} />
          </View>
          <T size={12} color={c.mute}>Assessing never gives you any say over the match result, the crew or a disciplinary record.</T>
        </View>) : null}
    </Sheet>
  );
}

function AssessorTab({ home, reload }) {
  const { push } = useNav();
  const obs = useLoad(() => api.get('/officials-development/observations', { as_assessor: true, limit: 50 }), []);
  const [sheet, setSheet] = useState(null);
  const a = home.assessor;
  if (!a) return <Empty emoji="🧑‍⚖️" title="You are not an appointed assessor" sub="Assessor authority is granted by a governing body for a sport, roles and grades. Being a referee does not grant it." />;
  const items = obs.data?.items ?? [];
  const writeUp = (o) => push('AssessmentEditor', o.assessment_id ? { assessment_id: o.assessment_id } : { observation_id: o.id });
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={a.to_accept} label="Waiting for your reply" tone={a.to_accept ? c.sunSoft : undefined} />
        <Metric value={a.to_assess} label="To assess" sub={a.overdue ? `${a.overdue} overdue` : undefined} tone={a.overdue ? c.sunSoft : undefined} />
        <Metric value={a.drafts} label="Drafts" />
      </View>
      <Cols
        a={<Section title="Your appointments" color={c.pink}>{a.appointments.map((p) => (
          <ListCard key={p.id} title={`${p.sport_name} · ${p.body_name}`} sub={`${p.official_roles.map((r) => ROLE_NAME[r] ?? r).join(', ')} · up to grade rank ${p.max_grade_rank} · until ${fmtDate(p.valid_until)}`} status={p.status} />))}
        </Section>}
        b={<Section title="Assignments" color={c.cyan}>
          {!obs.data ? <Loading /> : items.length ? items.map((o) => (
            <View key={o.id} style={{ marginBottom: 8 }}>
              <ListCard title={`${o.official_name} · ${ROLE_NAME[o.official_role] ?? o.official_role}`} sub={`${o.event_name} · ${whenTime(o.scheduled_at)}`} sub2={`${PURPOSE[o.purpose]}${o.due_on ? ` · due ${fmtDate(o.due_on)}` : ''}${o.overdue ? ' · overdue' : ''}`}
                status={o.assessment_status === 'draft' ? 'draft' : o.assessment_status ?? o.status} tone={o.overdue ? c.sunSoft : undefined}
                onPress={o.status === 'assigned' ? () => setSheet(o) : o.status === 'accepted' || o.assessment_id ? () => writeUp(o) : undefined}
                right={o.status === 'assigned' ? <Btn small title="Reply" onPress={() => setSheet(o)} /> : o.status === 'accepted' ? <Btn small title={o.assessment_id ? 'Continue' : 'Write up'} onPress={() => writeUp(o)} /> : null} />
            </View>)) : <Empty emoji="📋" title="No assignments" sub="When a body asks you to assess a match it appears here." />}
        </Section>} />
      <ConflictSheet obs={sheet} onClose={() => setSheet(null)} onDone={() => { obs.reload(); reload(); }} />
    </View>
  );
}

// ------------------------------------------------------------------ screen
export function OfficialsDevelopment({ tab: startTab }) {
  const { push } = useNav();
  const [tab, setTab] = useState(startTab ?? 'overview');
  const home = useLoad(() => api.get('/me/officials-development'), []);
  const h = home.data;
  if (h && tab === 'assessor' && !h.assessor) setTab('overview'); // a notification for a role you do not hold lands on the overview
  if (home.error && !h) return <Screen><H1>Officials development</H1><LoadError error={home.error} onRetry={home.reload} /></Screen>;
  if (!h) return <Screen><Loading /></Screen>;
  const g = h.grades[0];
  const tabs = [{ value: 'overview', label: 'Overview' }, { value: 'assessments', label: `Assessments${h.awaiting_acknowledgement ? ` (${h.awaiting_acknowledgement})` : ''}` }, { value: 'growth', label: 'Growth' }, { value: 'cpd', label: 'CPD & fitness' }, ...(h.assessor ? [{ value: 'assessor', label: 'Assessor' }] : [])];
  const cpdNeed = h.cpd.find((p) => p.required_hours > 0);
  const nextReady = g?.next_grade;
  const fitnessBad = h.fitness.filter((f) => f.status !== 'valid').length;
  return (
    <Screen refreshing={home.loading} onRefresh={home.reload} wide>
      <GradCard colors={grad.hero} pad={20}>
        <Tag label="Officials development" color={c.violetSoft} />
        {g ? (
          <>
            <T size={26} weight="800" color="#fff" style={{ marginTop: 10, letterSpacing: -0.6 }} accessibilityRole="header">{gradeName(g)}</T>
            <T size={13} color="rgba(255,255,255,0.8)" style={{ marginTop: 2 }}>{g.body_name} · {g.sport_name} · {g.licence_no}</T>
            <T size={13} color="rgba(255,255,255,0.8)" style={{ marginTop: 6 }}>Valid to {fmtDate(g.expires_on)} · {days(g.days_to_expiry)}</T>
          </>) : (
          <>
            <T size={24} weight="800" color="#fff" style={{ marginTop: 10 }} accessibilityRole="header">Your officiating path</T>
            <T size={13} color="rgba(255,255,255,0.8)" style={{ marginTop: 4 }}>Assessments, grades, CPD and mentoring start once a governing body licenses you as an official.</T>
          </>)}
      </GradCard>
      {h.awaiting_acknowledgement ? <View style={{ marginTop: 12 }}><Banner action="Open" onAction={() => setTab('assessments')}>{h.awaiting_acknowledgement} assessment{h.awaiting_acknowledgement === 1 ? ' is' : 's are'} waiting for you to read and acknowledge.</Banner></View> : null}
      {g ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          <Metric value={h.awaiting_acknowledgement} label="To acknowledge" tone={h.awaiting_acknowledgement ? c.sunSoft : undefined} onPress={() => setTab('assessments')} />
          <Metric value={h.development.open_items} label="Open actions" sub={h.development.overdue_items ? `${h.development.overdue_items} overdue` : undefined} onPress={() => setTab('growth')} />
          <Metric value={cpdNeed ? `${cpdNeed.verified_hours}/${cpdNeed.required_hours}h` : `${h.cpd.reduce((s, p) => s + p.verified_hours, 0)}h`} label="CPD" sub={cpdNeed ? `last ${cpdNeed.window_months} months` : 'no hours required'} onPress={() => setTab('cpd')} />
          <Metric value={h.fitness.length ? (fitnessBad ? `${fitnessBad} to renew` : 'Current') : '–'} label="Fitness" tone={fitnessBad ? c.sunSoft : undefined} onPress={() => setTab('cpd')} />
          <Metric value={nextReady ? `${nextReady.checks.filter((x) => x.status === 'pass').length}/${nextReady.checks.length || 0}` : '–'} label={nextReady ? `Towards ${nextReady.name}` : 'Highest grade'} sub={nextReady?.ready ? 'ready to apply' : undefined} onPress={() => setTab('overview')} />
        </View>) : null}
      <View style={{ marginTop: 14 }}><Seg options={tabs} value={tab} onChange={setTab} /></View>
      <View style={{ marginTop: 8 }}>
        {tab === 'overview' ? (g ? <Overview home={h} setTab={setTab} reload={home.reload} /> : (
          <Empty emoji="🏅" title="No official licence yet" sub="Apply to the governing body for your sport. Once it licenses you, your grade, renewal readiness and next grade appear here." />)) : null}
        {tab === 'assessments' ? <AssessmentsTab /> : null}
        {tab === 'growth' ? <GrowthTab home={h} reload={home.reload} /> : null}
        {tab === 'cpd' ? <CpdFitnessTab home={h} reload={home.reload} /> : null}
        {tab === 'assessor' ? <AssessorTab home={h} reload={home.reload} /> : null}
      </View>
      {!g ? <View style={{ marginTop: 12 }}><Btn title="Find a governing body" onPress={() => push('Federations')} /></View> : null}
    </Screen>
  );
}
