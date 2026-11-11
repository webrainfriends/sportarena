// Officials Development & Assessment (#486): the OFFICIAL and ASSESSOR side. One home for an official's development (grade and renewal readiness, next-grade
// requirements, assessments, actions, mentoring, CPD, fitness) and, for an appointed assessor, the observations they were asked to write up. Every rule is
// decided by the server (api capabilities, shared with REST/OpenAPI/MCP); this only shows what it returns and hides what a role cannot use.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
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

const days = (d) => (d === null || d === undefined ? '' : d < 0 ? t('od.days_ended', { n: -d }) : d === 0 ? t('od.ends_today') : t('od.days_left', { n: d }));
const gradeName = (g) => (g.grade && !String(g.type_name).toLowerCase().includes(String(g.grade).toLowerCase()) ? `${g.type_name} · ${g.grade}` : g.type_name);
const FITNESS = { valid: t('od.fitness_valid'), expiring: t('od.fitness_expiring'), expired: t('od.fitness_expired'), failed: t('od.fitness_failed'), missing: t('od.fitness_missing') };

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
        <T size={12.5} color={c.mute}>{t('od.valid_to', { date: fmtDate(g.expires_on) })} · {days(g.days_to_expiry)}</T>
        {g.renewal.checks.length ? <Checks checks={g.renewal.checks} title={g.renewal.window_open ? t('od.renewal_checks_title_ready') : t('od.renewal_checks_title_open')} /> : <T size={12.5} color={c.mute}>{t('od.renewal_nothing')}</T>}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title={t('od.btn_licence_record')} color={c.paper} ink={c.ink} onPress={() => push('FederationRecord', { type: 'licence', id: g.id })} />
          {g.renewal.window_open ? <Btn small title={t('od.btn_renew')} onPress={() => push('FederationRecord', { type: 'licence', id: g.id })} /> : null}
        </View>
        {next ? (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="800" size={14}>{t('od.next_grade', { name: next.name })}</T><T size={12} color={c.mute}>{next.has_requirements ? (next.ready ? t('od.next_grade_ready') : t('od.next_grade_in_progress')) : t('od.next_grade_no_reqs')}</T></View>
              <Tag label={next.applied ? t('od.tag_applied') : next.ready ? t('od.tag_ready') : t('od.tag_in_progress')} color={next.applied || next.ready ? c.mint : c.sun} />
            </View>
            {next.checks.length ? <Checks checks={next.checks} title="Requirements for this grade" /> : null}
            {!next.applied ? <Btn small title={t('od.btn_apply_grade', { name: next.name })} loading={busy === next.type_id} onPress={() => onApply(g, next)} /> : <T size={12} color={c.mute}>{t('od.next_grade_applied', { body: g.body_name })}</T>}
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
          <Section title={t('od.section_your_grade')} color={c.pink}>{home.grades.map((g) => <GradeCard key={g.id} g={g} onApply={apply} busy={busy} />)}</Section>
          {home.applications.length ? (
            <Section title={t('od.section_applications')} color={c.sun}>
              {home.applications.map((a) => <ListCard key={a.id} title={gradeName(a)} sub={`${a.body_name} · ${a.previous_id ? 'Renewal' : 'Application'}`} status={a.recorded_status} onPress={() => push('FederationRecord', { type: 'licence', id: a.id })} />)}
            </Section>) : null}
        </>}
        b={<>
          <Section title={t('od.section_recent_assessments')} color={c.cyan} action={t('od.section_all')} onAction={() => setTab('assessments')}>
            {home.recent_assessments.length ? home.recent_assessments.map((a) => (
              <ListCard key={a.id} title={a.event_name} sub={`${PURPOSE[a.purpose] ?? a.purpose} · ${when(a.published_at)}`} status={a.status} right={a.status === 'published' ? <RecTag value={a.recommendation} /> : null}
                sub2={a.status === 'published' && a.needs_acknowledgement ? t('od.assessment_needs_ack') : a.appeal_open ? t('od.appeal_open') : undefined} tone={a.status === 'published' && a.needs_acknowledgement ? c.sunSoft : undefined}
                onPress={() => push('OfficialAssessment', { id: a.id })} />)) : <Empty emoji="📝" title={t('od.no_assessments')} sub="When an assessor writes up a match you officiated, the report appears here once it is published to you." />}
          </Section>
          {home.upcoming_observations.length ? (
            <Section title={t('od.section_upcoming_obs')} color={c.violet}>
              {home.upcoming_observations.map((o) => <ListCard key={o.id} title={o.event_name} sub={`${PURPOSE[o.purpose] ?? o.purpose} · ${whenTime(o.scheduled_at)}`} />)}
            </Section>) : null}
          <Section title={t('od.section_open_actions')} color={c.mint} action={t('od.section_all')} onAction={() => setTab('growth')}>
            {home.development.next.length ? home.development.next.slice(0, 4).map((i) => <ListCard key={i.id} title={i.title} sub={[i.kind === 'action' ? t('od.action_kind') : t('od.goal_kind'), i.due_on ? t('od.due_on', { date: fmtDate(i.due_on) }) : null].filter(Boolean).join(' · ')} tone={i.overdue ? c.sunSoft : undefined} />)
              : <Empty emoji="🎯" title={t('od.no_actions')} sub="Actions from your assessments and the goals you set appear here." />}
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
  const privateNote = <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('od.assessments_private')}</T>;
  return (
    <View>
      {privateNote}
      {q.data.items.length ? q.data.items.map((a) => (
        <View key={a.id} style={{ marginBottom: 10 }}>
          <ListCard title={a.event_name} sub={`${ROLE_NAME[a.official_role] ?? a.official_role} · ${a.grade_label || 'grade n/a'} · ${when(a.published_at ?? a.scheduled_at)}`} sub2={`Assessor ${a.assessor_name}`} status={a.status}
            right={a.status === 'published' ? <RecTag value={a.recommendation} /> : null} tone={a.status === 'published' && a.needs_acknowledgement ? c.sunSoft : undefined} onPress={() => push('OfficialAssessment', { id: a.id })} />
        </View>)) : <Empty emoji="📝" title={t('od.no_assessments')} sub={t('od.no_assessments_sub')} />}
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
    <Sheet visible={visible} onClose={() => { setDraft(null); onClose(); }} title={t('od.plan_draft_title')}>
      <View style={{ gap: 12 }}>
        <T size={13} color={c.mute}>{t('od.plan_draft_sub')}</T>
        {!draft ? <Btn title={t('od.btn_draft_my_goals')} loading={busy} onPress={run} /> : (
          <>
            <T weight="800">{draft.headline}</T>
            {draft.items.length ? draft.items.map((it, i) => (
              <Card key={`${i}-${it.title}`} color={c.paper} pad={12}>
                <T weight="700">{it.title}</T>{it.detail ? <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{it.detail}</T> : null}
                <Btn small title={t('od.plan_draft_add')} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => onAdd(it)} />
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
        <Section title={t('od.section_goals')} color={c.mint}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <Btn small title={t('od.btn_add_goal')} onPress={() => setGoal({})} />
            <Btn small title={t('od.btn_draft_feedback')} color={c.paper} ink={c.ink} onPress={() => setPlan(true)} />
          </View>
          {!items.data ? <Loading /> : open.length ? open.map((i) => (
            <Card key={i.id} color={i.overdue ? c.sunSoft : c.paper} pad={14} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <T weight="700">{i.title}</T>{i.detail ? <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{i.detail}</T> : null}
                  <T size={12} color={c.mute} style={{ marginTop: 4 }}>{[i.kind === 'action' ? (i.source_type === 'assessment' ? t('od.action_from_assessment') : i.source_type === 'body' ? t('od.action_from_body') : t('od.action_kind')) : i.kind === 'meeting' ? t('od.meeting_kind') : t('od.goal_kind'), i.due_on ? t('od.due_on', { date: fmtDate(i.due_on) }) : null].filter(Boolean).join(' · ')}</T>
                </View>
                <Btn small title={t('od.btn_done')} color={c.paper} ink={c.ink} onPress={() => mark(i, 'done')} />
              </View>
            </Card>)) : <Empty emoji="🎯" title={t('od.no_actions')} sub={t('od.no_actions_sub')} />}
          {done.length ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('od.done_count', { n: done.length })}</T> : null}
        </Section>
      </>}
      b={<>
        <Section title={t('od.section_mentoring')} color={c.cyan}>
          <View style={{ marginBottom: 8 }}><Btn small title={t('od.btn_propose_mentor')} color={c.paper} ink={c.ink} onPress={() => setMentor(true)} style={{ alignSelf: 'flex-start' }} /></View>
          {mentorships.length ? mentorships.map((m) => (
            <Card key={m.id} color={m.needs_my_response ? c.sunSoft : c.paper} pad={14} style={{ marginBottom: 8 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800">{m.role === 'mentor' ? t('od.mentor_as', { name: m.mentee_name }) : t('od.mentee_as', { name: m.mentor_name })}</T><StateTag status={m.status} /></View>
                <T size={12} color={c.mute}>{m.sport_name} · from {fmtDate(m.starts_on)}{m.ends_on ? ` to ${fmtDate(m.ends_on)}` : ''}</T>
                {m.scope ? <T size={12.5}>{m.scope}</T> : null}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {m.needs_my_response ? <><Btn small title={t('od.btn_accept')} onPress={() => respond(m, 'accept')} /><Btn small title={t('od.btn_decline')} color={c.paper} ink={c.ink} onPress={() => respond(m, 'decline')} /></> : null}
                  {m.status === 'active' ? <Btn small title={m.role === 'mentor' ? t('od.btn_add_goal_or_note') : t('od.btn_add_goal')} color={c.paper} ink={c.ink} onPress={() => setNote(m)} /> : null}
                </View>
              </View>
            </Card>)) : <Empty emoji="🤝" title={t('od.no_mentoring')} sub={t('od.no_mentoring_sub')} />}
          {home.mentoring.mentee_actions_overdue ? <Banner tone={c.sunSoft}>{t('od.mentee_actions_overdue', { n: home.mentoring.mentee_actions_overdue })}</Banner> : null}
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
    <FormSheet visible={!!value} onClose={onClose} title={t('od.goal_sheet_title')} submitLabel="Save goal" initial={{ body_id: bodies[0]?.value, ...value }}
      fields={[
        ...(bodies.length > 1 ? [{ key: 'body_id', label: t('od.mentor_body'), type: 'chips', options: bodies }] : []),
        { key: 'title', label: t('od.goal_field'), hint: t('od.goal_hint') },
        { key: 'detail', label: t('od.goal_how'), type: 'multiline', optional: true },
        { key: 'due_on', label: t('od.goal_aim'), type: 'date', optional: true },
      ]}
      onSubmit={async (v) => { await api.post('/officials-development/items', { body_id: v.body_id ?? bodies[0]?.value, kind: 'goal', title: v.title, ...(v.detail ? { detail: v.detail } : {}), ...(v.due_on ? { due_on: v.due_on } : {}) }); onSaved(); return 'Goal added'; }} />
  );
}

function NoteSheet({ m, onClose, onSaved }) {
  const mentor = m?.role === 'mentor';
  return (
    <FormSheet visible={!!m} onClose={onClose} title={m ? `With ${mentor ? m.mentee_name : m.mentor_name}` : ''} submitLabel="Save"
      fields={[
        { key: 'kind', label: t('od.note_sheet_field_kind'), type: 'chips', options: mentor ? [{ value: 'goal', label: t('od.goal_kind') }, { value: 'action', label: t('od.action_kind') }, { value: 'meeting', label: t('od.meeting_kind') }] : [{ value: 'goal', label: t('od.goal_kind') }, { value: 'action', label: t('od.action_kind') }] },
        { key: 'title', label: 'Title' },
        { key: 'detail', label: 'Notes', type: 'multiline', optional: true },
        { key: 'happened_on', label: t('od.note_sheet_happened'), type: 'date', show: (v) => v.kind === 'meeting' },
        { key: 'due_on', label: t('od.note_sheet_due'), type: 'date', optional: true, show: (v) => v.kind !== 'meeting' },
        ...(mentor ? [{ key: 'private', label: t('od.note_private'), type: 'switch', hint: t('od.note_private_hint') }] : []),
      ]}
      onSubmit={async (v) => { await api.post('/officials-development/items', { body_id: m.body_id, mentorship_id: m.id, kind: v.kind, title: v.title, ...(v.detail ? { detail: v.detail } : {}), ...(v.happened_on ? { happened_on: v.happened_on } : {}), ...(v.due_on ? { due_on: v.due_on } : {}), visibility: v.private ? 'mentor_only' : 'shared' }); onSaved(); return 'Saved'; }} />
  );
}

function MentorSheet({ visible, onClose, bodies, grades, me, onSaved }) {
  const [who, setWho] = useState([]);
  const sports = useMemo(() => [...new Map(grades.map((g) => [g.sport_id, { value: g.sport_id, label: g.sport_name }])).values()], [grades]);
  return (
    <FormSheet visible={visible} onClose={() => { setWho([]); onClose(); }} title={t('od.mentor_sheet_title')} submitLabel="Send proposal"
      initial={{ body_id: bodies[0]?.value, sport_id: sports[0]?.value, role: 'mentee' }}
      fields={[
        { key: 'role', label: t('od.mentor_i_am'), type: 'chips', options: [{ value: 'mentee', label: 'Mentee' }, { value: 'mentor', label: 'Mentor' }] },
        { key: 'person', label: t('od.mentor_other'), type: 'entity', entityKind: 'person', role: 'referee', noun: 'official', onPick: (p) => setWho([p]) },
        ...(bodies.length > 1 ? [{ key: 'body_id', label: t('od.mentor_body'), type: 'chips', options: bodies }] : []),
        ...(sports.length > 1 ? [{ key: 'sport_id', label: t('od.mentor_sport'), type: 'chips', options: sports }] : []),
        { key: 'scope', label: t('od.mentor_scope'), type: 'multiline', optional: true },
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
    <FormSheet visible={visible} onClose={onClose} title={t('od.cpd_sheet_title')} submitLabel="Save" initial={{ body_id: bodies[0]?.value, kind: 'course', hours: 1, credits: 0 }}
      fields={[
        ...(bodies.length > 1 ? [{ key: 'body_id', label: t('od.cpd_counts_for'), type: 'chips', options: bodies }] : []),
        { key: 'kind', label: t('od.cpd_kind'), type: 'chips', options: [{ value: 'course', label: 'Course' }, { value: 'module', label: 'Module' }, { value: 'workshop', label: 'Workshop' }, { value: 'conference', label: 'Conference' }, { value: 'mentoring', label: 'Mentoring' }, { value: 'other', label: 'Other' }] },
        { key: 'title', label: t('od.cpd_title_field') },
        ...(usable.length ? [{ key: 'credential_id', label: t('od.cpd_backed_by'), type: 'chips', optional: true, options: usable.map((x) => ({ value: x.id, label: `${x.title} · ${x.institution}` })), hint: t('od.cpd_backed_hint') }] : []),
        { key: 'provider_name', label: t('od.cpd_provider'), optional: true },
        { key: 'completed_on', label: t('od.cpd_completed_on'), type: 'date' },
        { key: 'hours', label: t('od.cpd_hours'), type: 'stepper', min: 0, max: 200, default: 1 },
        { key: 'credits', label: t('od.cpd_credits'), type: 'stepper', min: 0, max: 200, default: 0 },
        { key: 'expires_on', label: t('od.cpd_expires_on'), type: 'date', optional: true },
        { key: 'evidence', label: t('od.cpd_evidence'), optional: true },
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
      a={<Section title={t('od.cpd_section')} color={c.mint}>
        <View style={{ gap: 12, marginBottom: 10 }}>
          {home.cpd.map((p) => p.required_hours > 0
            ? <Progress key={p.body_id} label={p.body_name} value={p.verified_hours} target={p.required_hours} unit="h" sub={`Verified hours in the last ${p.window_months} months${p.pending_verification ? ` · ${p.pending_verification} awaiting verification` : ''}`} />
            : <T key={p.body_id} size={13} color={c.mute}>{p.body_name} sets no CPD hours for your grade. {p.verified_hours}h verified in the last {p.window_months} months.</T>)}
        </View>
        <Btn small title={t('od.btn_record_cpd')} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start', marginBottom: 8 }} />
        {!list.data ? <Loading /> : list.data.items.length ? list.data.items.map((r) => (
          <Card key={r.id} color={c.paper} pad={14} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <T weight="700">{r.title}</T>
                <T size={12} color={c.mute}>{r.kind} · {fmtDate(r.completed_on)} · {r.hours}h{r.credits ? ` · ${r.credits} credits` : ''}{r.provider_name || r.provider_org_name ? ` · ${r.provider_org_name ?? r.provider_name}` : ''}</T>
                {r.status === 'rejected' && r.decision_reason ? <T size={12} style={{ marginTop: 4 }}>{r.decision_reason}</T> : null}
              </View>
              <View style={{ gap: 6, alignItems: 'flex-end' }}><StateTag status={r.status} />{['recorded', 'verified'].includes(r.status) ? <Btn small title={t('od.btn_withdraw')} color={c.paper} ink={c.ink} onPress={() => withdraw(r)} /> : null}</View>
            </View>
          </Card>)) : <Empty emoji="🎓" title={t('od.no_cpd')} sub={t('od.no_cpd_sub')} />}
        <CpdSheet visible={form} onClose={() => setForm(false)} bodies={bodies} onSaved={() => { list.reload(); reload(); }} />
      </Section>}
      b={<Section title={t('od.fitness_section')} color={c.cyan}>
        {home.fitness.length ? home.fitness.map((f) => (
          <Card key={f.test_id} color={f.status === 'valid' ? c.paper : f.status === 'expiring' ? c.sunSoft : c.paper} pad={14} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}><T weight="700">{f.name}</T><T size={12} color={c.mute}>v{f.version}{f.taken_on ? ` · taken ${fmtDate(f.taken_on)}` : ''}{f.valid_until ? ` · valid to ${fmtDate(f.valid_until)}` : ''}</T></View>
              <StateTag status={f.status} label={FITNESS[f.status]} />
            </View>
          </Card>)) : <Empty emoji="🏃" title={t('od.fitness_no_test')} sub={t('od.fitness_no_test_sub')} />}
        <T size={11.5} color={c.mute}>{t('od.fitness_visibility')}</T>
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
    <Sheet visible={!!obs} onClose={onClose} title={t('od.coi_title')}>
      {obs ? (
        <View style={{ gap: 12 }}>
          <View><T weight="800">{obs.official_name} · {ROLE_NAME[obs.official_role] ?? obs.official_role}</T><T size={12.5} color={c.mute}>{obs.event_name} · {whenTime(obs.scheduled_at)} · {PURPOSE[obs.purpose]}</T></View>
          <T size={13} weight="700">{t('od.coi_conflict_header')}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Chip label={t('od.coi_none')} active={mode === 'none'} onPress={() => setMode('none')} />
            <Chip label={t('od.coi_declared')} active={mode === 'declared'} onPress={() => setMode('declared')} />
          </View>
          {mode === 'declared' ? <Field label={t('od.coi_note_label')} value={note} onChangeText={setNote} multiline maxLength={500} hint={t('od.coi_note_hint')} /> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn title={t('od.btn_accept')} disabled={mode !== 'none'} loading={busy === 'accept'} onPress={() => send('accept')} />
            <Btn title={mode === 'declared' ? t('od.coi_decline_conflict') : t('od.btn_decline')} color={c.paper} ink={c.ink} disabled={mode === 'declared' && !note.trim()} loading={busy === 'decline'} onPress={() => send('decline')} />
          </View>
          <T size={12} color={c.mute}>{t('od.coi_footer')}</T>
        </View>) : null}
    </Sheet>
  );
}

function AssessorTab({ home, reload }) {
  const { push } = useNav();
  const obs = useLoad(() => api.get('/officials-development/observations', { as_assessor: true, limit: 50 }), []);
  const [sheet, setSheet] = useState(null);
  const a = home.assessor;
  if (!a) return <Empty emoji="🧑‍⚖️" title={t('od.assessor_not_appointed')} sub={t('od.assessor_not_appointed_sub')} />;
  const items = obs.data?.items ?? [];
  const writeUp = (o) => push('AssessmentEditor', o.assessment_id ? { assessment_id: o.assessment_id } : { observation_id: o.id });
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={a.to_accept} label={t('od.assessor_waiting')} tone={a.to_accept ? c.sunSoft : undefined} />
        <Metric value={a.to_assess} label={t('od.assessor_to_assess')} sub={a.overdue ? t('od.overdue_count', { n: a.overdue }) : undefined} tone={a.overdue ? c.sunSoft : undefined} />
        <Metric value={a.drafts} label={t('od.assessor_drafts')} />
      </View>
      <Cols
        a={<Section title={t('od.assessor_appointments')} color={c.pink}>{a.appointments.map((p) => (
          <ListCard key={p.id} title={`${p.sport_name} · ${p.body_name}`} sub={`${p.official_roles.map((r) => ROLE_NAME[r] ?? r).join(', ')} · up to grade rank ${p.max_grade_rank} · until ${fmtDate(p.valid_until)}`} status={p.status} />))}
        </Section>}
        b={<Section title={t('od.assessor_assignments')} color={c.cyan}>
          {!obs.data ? <Loading /> : items.length ? items.map((o) => (
            <View key={o.id} style={{ marginBottom: 8 }}>
              <ListCard title={`${o.official_name} · ${ROLE_NAME[o.official_role] ?? o.official_role}`} sub={`${o.event_name} · ${whenTime(o.scheduled_at)}`} sub2={`${PURPOSE[o.purpose]}${o.due_on ? ` · ${t('od.due_on', { date: fmtDate(o.due_on) })}` : ''}${o.overdue ? ` · ${t('od.overdue')}` : ''}`}
                status={o.assessment_status === 'draft' ? 'draft' : o.assessment_status ?? o.status} tone={o.overdue ? c.sunSoft : undefined}
                onPress={o.status === 'assigned' ? () => setSheet(o) : o.status === 'accepted' || o.assessment_id ? () => writeUp(o) : undefined}
                right={o.status === 'assigned' ? <Btn small title={t('od.btn_reply')} onPress={() => setSheet(o)} /> : o.status === 'accepted' ? <Btn small title={o.assessment_id ? t('od.btn_continue') : t('od.btn_write_up')} onPress={() => writeUp(o)} /> : null} />
            </View>)) : <Empty emoji="📋" title={t('od.no_assignments')} sub={t('od.no_assignments_sub')} />}
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
  const tabs = [{ value: 'overview', label: t('od.tab_overview') }, { value: 'assessments', label: `${t('od.tab_assessments')}${h.awaiting_acknowledgement ? ` (${h.awaiting_acknowledgement})` : ''}` }, { value: 'growth', label: t('od.tab_growth') }, { value: 'cpd', label: t('od.tab_cpd') }, ...(h.assessor ? [{ value: 'assessor', label: t('od.tab_assessor') }] : [])];
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
            <T size={24} weight="800" color="#fff" style={{ marginTop: 10 }} accessibilityRole="header">{t('od.your_officiating_path')}</T>
            <T size={13} color="rgba(255,255,255,0.8)" style={{ marginTop: 4 }}>{t('od.no_licence_sub')}</T>
          </>)}
      </GradCard>
      {h.awaiting_acknowledgement ? <View style={{ marginTop: 12 }}><Banner action="Open" onAction={() => setTab('assessments')}>{t('od.banner_waiting', { n: h.awaiting_acknowledgement })}</Banner></View> : null}
      {g ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          <Metric value={h.awaiting_acknowledgement} label={t('od.to_acknowledge')} tone={h.awaiting_acknowledgement ? c.sunSoft : undefined} onPress={() => setTab('assessments')} />
          <Metric value={h.development.open_items} label={t('od.open_actions')} sub={h.development.overdue_items ? t('od.overdue_count', { n: h.development.overdue_items }) : undefined} onPress={() => setTab('growth')} />
          <Metric value={cpdNeed ? `${cpdNeed.verified_hours}/${cpdNeed.required_hours}h` : `${h.cpd.reduce((s, p) => s + p.verified_hours, 0)}h`} label={t('od.cpd_label')} sub={cpdNeed ? t('od.cpd_period', { n: cpdNeed.window_months }) : t('od.cpd_no_hours')} onPress={() => setTab('cpd')} />
          <Metric value={h.fitness.length ? (fitnessBad ? t('od.fitness_to_renew', { n: fitnessBad }) : t('od.fitness_current')) : '–'} label={t('od.fitness_label')} tone={fitnessBad ? c.sunSoft : undefined} onPress={() => setTab('cpd')} />
          <Metric value={nextReady ? `${nextReady.checks.filter((x) => x.status === 'pass').length}/${nextReady.checks.length || 0}` : '–'} label={nextReady ? t('od.towards_grade', { name: nextReady.name }) : t('od.highest_grade')} sub={nextReady?.ready ? t('od.ready_to_apply') : undefined} onPress={() => setTab('overview')} />
        </View>) : null}
      <View style={{ marginTop: 14 }}><Seg options={tabs} value={tab} onChange={setTab} /></View>
      <View style={{ marginTop: 8 }}>
        {tab === 'overview' ? (g ? <Overview home={h} setTab={setTab} reload={home.reload} /> : (
          <Empty emoji="🏅" title={t('od.no_licence_yet')} sub={t('od.no_licence_yet_sub')} />)) : null}
        {tab === 'assessments' ? <AssessmentsTab /> : null}
        {tab === 'growth' ? <GrowthTab home={h} reload={home.reload} /> : null}
        {tab === 'cpd' ? <CpdFitnessTab home={h} reload={home.reload} /> : null}
        {tab === 'assessor' ? <AssessorTab home={h} reload={home.reload} /> : null}
      </View>
      {!g ? <View style={{ marginTop: 12 }}><Btn title={t('od.find_body')} onPress={() => push('Federations')} /></View> : null}
    </Screen>
  );
}
