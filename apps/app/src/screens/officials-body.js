// Officials Development & Assessment (#486): the body side, as a tab of Federation Home (the one home for a governing body: no second console). Licensing
// staff run assessors, rubrics, observation assignments, the review queue and appeals, grade requirements, CPD verification and fitness results, and see
// transparent counts. A body above sees roll-ups only. The server enforces every permission; this hides what a role cannot use.
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, Loading, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Counter } from '../pickers';
import { saveText } from '../evidence';
import { explain, LoadError } from '../access';
import { c } from '../theme';
import { Banner, Metric, fmtDate } from '../federation-ui';
import { Bar, Cols, ListCard, Pager } from '../federation-bits';
import { DIMENSION_IDEAS, PURPOSE, PURPOSE_OPTIONS, ROLE_NAME, ROLE_OPTIONS, StateTag, REC, stateLabel, whenTime } from '../officials-dev-ui';

const cnt = (list, k) => list?.find((x) => x.k === k)?.n ?? 0;
const show = (n) => (n === null ? '<3' : n);
const slug = (t, taken) => { let k = t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'dimension'; if (!/^[a-z]/.test(k)) k = `d_${k}`; let n = k, i = 2; while (taken.has(n)) n = `${k}_${i++}`; return n; };

// ------------------------------------------------------------------ overview
function Overview({ id, below, go }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/officials-development/bodies/${id}/overview`, { include_descendants: below }), [id, below]);
  const [busy, setBusy] = useState(false);
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const o = q.data;
  const exportCsv = async () => { setBusy(true); try { const r = await api.get(`/officials-development/bodies/${id}/export`, { include_descendants: below }); await saveText(r.filename, r.csv); toast(`Exported ${r.rows} rows`); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const maxGrade = Math.max(1, ...o.grade_distribution.map((g) => g.n ?? 0));
  const maxMonth = Math.max(1, ...o.assessments.completed_by_month.map((m) => m.n ?? 0));
  const maxRec = Math.max(1, ...o.assessments.by_recommendation.map((m) => m.n ?? 0));
  const fit = ['valid', 'expiring', 'expired', 'failed', 'missing'];
  const awaiting = o.assessments.awaiting_review, openAppeals = cnt(o.appeals, 'lodged') + cnt(o.appeals, 'under_review');
  return (
    <View style={{ gap: 4 }}>
      {o.suppression ? <Banner tone={c.cyanSoft}>Groups of fewer than {o.suppression.below} are hidden in this view, so no individual can be picked out.</Banner> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
        <Metric value={show(awaiting)} label="Assessments to review" tone={awaiting ? c.sunSoft : undefined} onPress={() => go('review')} />
        <Metric value={openAppeals} label="Open reviews and appeals" tone={openAppeals ? c.sunSoft : undefined} onPress={() => go('review')} />
        <Metric value={show(o.observations.overdue)} label="Overdue observations" tone={o.observations.overdue ? c.sunSoft : undefined} onPress={() => go('observations')} />
        <Metric value={show(o.renewals.expiring_30)} label="Official licences expiring in 30 days" sub={`${show(o.renewals.expiring_90)} within 90`} />
        <Metric value={o.cpd.completion_rate === null ? '–' : `${o.cpd.completion_rate}%`} label="Meeting their CPD requirement" sub={`${show(o.cpd.officials_with_requirement)} officials with one`} onPress={() => go('cpd')} />
        <Metric value={cnt(o.assessors, 'active')} label="Active assessors" sub={cnt(o.assessors, 'lapsed') ? `${cnt(o.assessors, 'lapsed')} lapsed` : undefined} onPress={() => go('assessors')} />
      </View>
      <Cols
        a={<>
          <Section title="Grade distribution" color={c.pink}>
            {o.grade_distribution.length ? <Card color={c.paper}><View style={{ gap: 12 }}>{o.grade_distribution.map((g) => <Bar key={`${g.sport}${g.grade}`} label={`${g.sport} · ${g.grade || 'ungraded'}`} value={g.n ?? 0} max={maxGrade} sub={g.n === null ? 'fewer than 3' : undefined} />)}</View></Card> : <Empty emoji="📊" title="No licensed officials yet" />}
          </Section>
          <Section title="Assessments completed, last 12 months" color={c.cyan}>
            {o.assessments.completed_by_month.length ? <Card color={c.paper}><View style={{ gap: 10 }}>{o.assessments.completed_by_month.map((m) => <Bar key={m.k} label={m.k} value={m.n ?? 0} max={maxMonth} />)}</View></Card> : <Empty emoji="📈" title="No assessments yet" />}
          </Section>
        </>}
        b={<>
          <Section title="What assessors recommended" color={c.mint}>
            {o.assessments.by_recommendation.length ? <Card color={c.paper}><View style={{ gap: 12 }}>{o.assessments.by_recommendation.map((r) => <Bar key={r.k} label={REC[r.k]?.[0] ?? r.k} value={r.n ?? 0} max={maxRec} />)}</View><T size={11.5} color={c.mute} style={{ marginTop: 10 }}>Counts only. There is no score per official, no ranking and no cross-sport rating.</T></Card> : <Empty emoji="🧭" title="Nothing published yet" />}
          </Section>
          <Section title="Fitness and competency" color={c.orange}>
            <Card color={c.paper}><View style={{ gap: 12 }}>{fit.map((k) => <Bar key={k} label={{ valid: 'Valid', expiring: 'Expiring in 30 days', expired: 'Expired', failed: 'Not passed', missing: 'No result' }[k]} value={cnt(o.fitness, k)} max={Math.max(1, ...o.fitness.map((f) => f.n ?? 0))} />)}</View></Card>
          </Section>
          <Section title="Licence applications in progress" color={c.sun}>
            {o.renewals.applications.length ? o.renewals.applications.map((a) => <ListCard key={a.k} title={stateLabel(a.k)} sub={`${show(a.n)} official application${a.n === 1 ? '' : 's'}`} />) : <Empty emoji="🗂️" title="None waiting" />}
          </Section>
        </>} />
      <View style={{ marginTop: 8 }}><Btn small title="Download counts (CSV)" color={c.paper} ink={c.ink} loading={busy} onPress={exportCsv} style={{ alignSelf: 'flex-start' }} /></View>
    </View>
  );
}

// ------------------------------------------------------------------ review queue and appeals
function ReviewTab({ id, settings }) {
  const { push } = useNav();
  const [status, setStatus] = useState('submitted');
  const [off, setOff] = useState(0);
  const list = useLoad(() => api.get('/officials-development/assessments', { body_id: id, status, limit: 20, offset: off }), [id, status, off]);
  const appeals = useLoad(() => api.get(`/officials-development/bodies/${id}/appeals`, { limit: 20 }), [id]);
  return (
    <Cols
      a={<Section title="Assessments" color={c.cyan}>
        <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{settings.publication === 'after_review' ? 'Your policy reviews each report before the official can read it.' : 'Your policy publishes each report to the official as soon as it is submitted.'} Staff cannot edit what an assessor wrote; a report can be voided with a reason.</T>
        <Seg options={[{ value: 'submitted', label: 'To review' }, { value: 'published', label: 'Published' }, { value: 'voided', label: 'Voided' }]} value={status} onChange={(s) => { setStatus(s); setOff(0); }} />
        <View style={{ marginTop: 8, gap: 8 }}>
          {!list.data ? <Loading /> : list.data.items.length ? list.data.items.map((a) => (
            <ListCard key={a.id} title={`${a.official_name} · ${ROLE_NAME[a.official_role] ?? a.official_role}`} sub={`${a.event_name} · ${PURPOSE[a.purpose] ?? a.purpose}`} sub2={`Assessor ${a.assessor_name}${a.appeal_open ? ' · appeal open' : ''}`} status={a.status} onPress={() => push('OfficialAssessment', { id: a.id })} />))
            : <Empty emoji="✅" title="Nothing here" />}
          {list.data ? <Pager total={list.data.total} offset={off} limit={20} onOffset={setOff} busy={list.loading} /> : null}
        </View>
      </Section>}
      b={<Section title="Reviews and appeals" color={c.orange}>
        {!appeals.data ? <Loading /> : appeals.data.items.length ? appeals.data.items.map((p) => (
          <View key={p.id} style={{ marginBottom: 8 }}><ListCard title={`${p.kind === 'appeal' ? 'Appeal' : 'Review'} · ${p.official_name}`} sub={p.event_name} sub2={`Version ${p.version} · ${whenTime(p.created_at)}`} status={p.status} onPress={() => push('OfficialAssessment', { id: p.assessment_id })} /></View>))
          : <Empty emoji="⚖️" title="No reviews or appeals" sub="An official can ask for a review or lodge an appeal within the window you set." />}
      </Section>} />
  );
}

// ------------------------------------------------------------------ observations
function AssignSheet({ item, body, assessors, onClose, onSaved }) {
  const eligible = useMemo(() => (assessors ?? []).filter((a) => a.status === 'active' && a.sport_id === item?.sport_id && a.official_roles.includes(item?.role)).map((a) => ({ value: a.user_id, label: a.assessor_name })), [assessors, item]);
  return (
    <FormSheet visible={!!item} onClose={onClose} title="Assign an assessor" submitLabel="Assign" initial={{ purpose: 'routine', assessor_id: eligible[0]?.value }}
      notice={item ? `${item.official_name} (${ROLE_NAME[item.role] ?? item.role}) · ${item.event_name} · ${whenTime(item.scheduled_at)}` : undefined}
      fields={[
        eligible.length ? { key: 'assessor_id', label: 'Assessor', type: 'chips', options: eligible, hint: 'Appointed, live assessors for this sport and role.' } : { key: 'none', label: 'No eligible assessor', type: 'section' },
        { key: 'purpose', label: 'Purpose', type: 'chips', options: PURPOSE_OPTIONS },
        { key: 'due_on', label: 'Report due by', type: 'date', optional: true },
        { key: 'purpose_note', label: 'Note for the assessor', type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => {
        if (!v.assessor_id) throw new Error('Appoint an assessor for this sport and role first');
        await api.post('/officials-development/observations', { body_id: body.id, fixture_official_id: item.fixture_official_id, assessor_id: v.assessor_id, purpose: v.purpose, ...(v.due_on ? { due_on: v.due_on } : {}), ...(v.purpose_note ? { purpose_note: v.purpose_note } : {}) });
        onSaved(); return 'Assessor asked. They accept with a conflict-of-interest declaration.';
      }} />
  );
}

function ObservationsTab({ id, body, assessors }) {
  const [unobserved, setUnobserved] = useState(true);
  const [q, setQ] = useState('');
  const [item, setItem] = useState(null);
  const [cancel, setCancel] = useState(null);
  const pick = useLoad(() => api.get(`/officials-development/bodies/${id}/assignments`, { unobserved, q: q.trim() || undefined, limit: 30 }), [id, unobserved, q]);
  const mine = useLoad(() => api.get('/officials-development/observations', { body_id: id, limit: 50 }), [id]);
  const reload = () => { pick.reload(); mine.reload(); };
  return (
    <>
    <Cols
      a={<Section title="Official assignments you can have observed" color={c.cyan}>
        <T size={12} color={c.mute} style={{ marginBottom: 8 }}>These are the confirmed assignments from the event consoles for events you sanction or officials you license. Assigning an assessor changes nothing about the assignment or the match.</T>
        <Field value={q} onChangeText={setQ} placeholder="Search an official or an event" accessibilityLabel="Search assignments" />
        <View style={{ flexDirection: 'row', gap: 8, marginVertical: 8 }}><Chip label="Not yet observed" active={unobserved} onPress={() => setUnobserved(true)} /><Chip label="All" active={!unobserved} onPress={() => setUnobserved(false)} /></View>
        {!pick.data ? <Loading /> : pick.data.items.length ? pick.data.items.map((a) => (
          <View key={a.fixture_official_id} style={{ marginBottom: 8 }}>
            <ListCard title={`${a.official_name} · ${ROLE_NAME[a.role] ?? a.role}`} sub={`${a.event_name}${a.home_team ? ` · ${a.home_team} v ${a.away_team}` : ''}`} sub2={`${whenTime(a.scheduled_at)}${a.observations ? ` · ${a.observations} observation${a.observations === 1 ? '' : 's'}` : ''}`}
              right={<Btn small title="Assign" onPress={() => setItem(a)} />} onPress={() => setItem(a)} />
          </View>)) : <Empty emoji="🏁" title="No assignments to observe" sub="Confirmed officials at sanctioned events, or officials you license, appear here." />}
      </Section>}
      b={<Section title="Observations" color={c.pink}>
        {!mine.data ? <Loading /> : mine.data.items.length ? mine.data.items.map((o) => (
          <View key={o.id} style={{ marginBottom: 8 }}>
            <ListCard title={`${o.official_name} · ${ROLE_NAME[o.official_role] ?? o.official_role}`} sub={`${o.event_name} · ${PURPOSE[o.purpose]}`} sub2={`Assessor ${o.assessor_name}${o.due_on ? ` · due ${fmtDate(o.due_on)}` : ''}${o.overdue ? ' · overdue' : ''}${o.coi_declared ? ' · conflict declared' : ''}`}
              status={o.status} tone={o.overdue || o.coi_declared ? c.sunSoft : undefined} right={['assigned', 'accepted'].includes(o.status) ? <Btn small title="Cancel" color={c.paper} ink={c.ink} onPress={() => setCancel(o)} /> : null} />
          </View>)) : <Empty emoji="🧑‍⚖️" title="No observations yet" />}
      </Section>} />
      <AssignSheet item={item} body={body} assessors={assessors} onClose={() => setItem(null)} onSaved={reload} />
      <FormSheet visible={!!cancel} onClose={() => setCancel(null)} title="Cancel this assignment" submitLabel="Cancel assignment" fields={[{ key: 'reason', label: 'Reason', type: 'multiline', hint: 'The assessor is told.' }]}
        onSubmit={async (v) => { await api.post(`/officials-development/observations/${cancel.id}/cancel`, { reason: v.reason }); reload(); return 'Cancelled'; }} />
    </>
  );
}

// ------------------------------------------------------------------ assessors
function AssessorsTab({ id, body, assessors, reload }) {
  const { toast } = useSession();
  const [form, setForm] = useState(false);
  const [act, setAct] = useState(null);
  const grades = body.licence_types.filter((t) => t.holder_role === 'official');
  const sports = body.sports.map((s) => ({ value: s.sport_id, label: s.sport_name }));
  return (
    <View>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}><Btn small title="Appoint an assessor" onPress={() => setForm(true)} /></View>
      <T size={12} color={c.mute} style={{ marginBottom: 8 }}>An assessor is appointed for a sport, the roles they may assess, a top grade and a period. It rests on the person's own current licence and lapses with it. Being a referee grants nothing.</T>
      {!assessors ? <Loading /> : assessors.length ? assessors.map((a) => (
        <View key={a.id} style={{ marginBottom: 8 }}>
          <ListCard title={a.assessor_name} sub={`${a.sport_name} · ${a.official_roles.map((r) => ROLE_NAME[r] ?? r).join(', ')} · up to rank ${a.max_grade_rank}${a.scope_event_name ? ` · only ${a.scope_event_name}` : ''}`} sub2={`${fmtDate(a.valid_from)} to ${fmtDate(a.valid_until)} · licence ${a.credential_licence_no}`} status={a.status}
            right={<View style={{ flexDirection: 'row', gap: 6 }}>{a.recorded_status === 'active' ? <Btn small title="Suspend" color={c.paper} ink={c.ink} onPress={() => setAct({ a, action: 'suspend' })} /> : null}{a.recorded_status === 'suspended' ? <Btn small title="Reinstate" onPress={() => setAct({ a, action: 'reinstate' })} /> : null}{a.recorded_status !== 'revoked' ? <Btn small title="Revoke" color={c.paper} ink={c.red} onPress={() => setAct({ a, action: 'revoke' })} /> : null}</View>} />
        </View>)) : <Empty emoji="🧑‍⚖️" title="No assessors appointed" sub="Appoint a licensed official as an assessor to observe and write up matches." />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Appoint an assessor" submitLabel="Appoint" initial={{ sport_id: sports[0]?.value, official_roles: ['referee'], max_grade_rank: 20 }}
        fields={[
          { key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', role: 'referee', noun: 'licensed official' },
          ...(sports.length > 1 ? [{ key: 'sport_id', label: 'Sport', type: 'chips', options: sports }] : []),
          { key: 'official_roles', label: 'May assess', type: 'multi', options: ROLE_OPTIONS },
          { key: 'max_grade_rank', label: 'Highest grade they may assess', type: 'chips', options: [...grades.map((g) => ({ value: g.grade_rank, label: g.grade || g.name })), { value: 20, label: 'Any grade' }], hint: 'The person must hold a current licence from you (or a body above or below you) for the sport; the appointment rests on it.' },
          { key: 'valid_until', label: 'Appointed until', type: 'date' },
        ]}
        onSubmit={async (v) => { await api.post(`/officials-development/bodies/${id}/assessors`, { user_id: v.user_id, sport_id: v.sport_id ?? sports[0]?.value, official_roles: v.official_roles, max_grade_rank: Number(v.max_grade_rank), valid_until: v.valid_until }); reload(); return 'Assessor appointed'; }} />
      <FormSheet visible={!!act} onClose={() => setAct(null)} title={act ? `${act.action[0].toUpperCase()}${act.action.slice(1)} ${act.a.assessor_name}` : ''} submitLabel="Confirm"
        fields={[{ key: 'reason', label: 'Reason', type: 'multiline', hint: 'The assessor is shown this.' }]}
        onSubmit={async (v) => { await api.post(`/officials-development/assessors/${act.a.id}/decision`, { action: act.action, reason: v.reason }); reload(); return 'Done'; }} />
    </View>
  );
}

// ------------------------------------------------------------------ rubrics
function RubricSheet({ rubric, onClose, onSaved }) {
  const { toast } = useSession();
  const [max, setMax] = useState(4);
  const [labels, setLabels] = useState({});
  const [dims, setDims] = useState([]);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!rubric) return;
    setMax(rubric.scale?.max ?? 4); setLabels(rubric.scale?.labels ?? {}); setDims(rubric.dimensions ?? []); setCustom('');
  }, [rubric?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const levels = Array.from({ length: max }, (_, i) => i + 1);
  const add = (label) => { const l = label.trim(); if (!l || dims.some((d) => d.label.toLowerCase() === l.toLowerCase())) return; setDims([...dims, { key: slug(l, new Set(dims.map((d) => d.key))), label: l, description: '', evidence_expectation: '', evidence_required: false, allow_na: true }]); setCustom(''); };
  const edit = (i, patch) => setDims(dims.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const ready = dims.length >= 2 && levels.every((n) => labels[String(n)]?.trim());
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/officials-development/rubrics/${rubric.id}/versions`, { scale: { min: 1, max, labels: Object.fromEntries(levels.map((n) => [String(n), labels[String(n)].trim()])) }, dimensions: dims });
      toast('New version published'); onSaved(); onClose();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={!!rubric} onClose={onClose} title={rubric ? `${rubric.name}: new version` : ''}>
      <View style={{ gap: 14 }}>
        <T size={12.5} color={c.mute}>Published versions never change. Assessments already started or done keep the version they used.</T>
        <Counter label="Points on the scale" value={max} onChange={setMax} min={2} max={6} />
        {levels.map((n) => <Field key={n} label={`What does ${n} mean?`} value={labels[String(n)] ?? ''} onChangeText={(t) => setLabels({ ...labels, [String(n)]: t })} maxLength={160} />)}
        <T weight="800" size={13}>Dimensions</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {DIMENSION_IDEAS.filter((t) => !dims.some((d) => d.label === t)).map((t) => <Chip key={t} label={`+ ${t}`} onPress={() => add(t)} />)}
        </View>
        <Field value={custom} onChangeText={setCustom} placeholder="Another dimension (e.g. a sport-specific one)" accessibilityLabel="Custom dimension" maxLength={80} />
        <Btn small title="Add dimension" color={c.paper} ink={c.ink} disabled={!custom.trim()} onPress={() => add(custom)} style={{ alignSelf: 'flex-start' }} />
        {dims.map((d, i) => (
          <Card key={d.key} color={c.paper} pad={12}>
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{d.label}</T><Chip label="Remove" onPress={() => setDims(dims.filter((_, j) => j !== i))} /></View>
              <Field value={d.description} onChangeText={(t) => edit(i, { description: t })} placeholder="What good looks like" multiline maxLength={400} accessibilityLabel={`${d.label} description`} />
              <Field value={d.evidence_expectation} onChangeText={(t) => edit(i, { evidence_expectation: t })} placeholder="Evidence the assessor should cite" maxLength={300} accessibilityLabel={`${d.label} evidence expectation`} />
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Chip label="Evidence required" active={d.evidence_required} onPress={() => edit(i, { evidence_required: !d.evidence_required })} />
                <Chip label="N/A allowed" active={d.allow_na} onPress={() => edit(i, { allow_na: !d.allow_na })} />
              </View>
            </View>
          </Card>))}
        <Btn title="Publish version" disabled={!ready} loading={busy} onPress={save} />
        {!ready ? <T size={12} color={c.mute}>Needs a definition for every point and at least two dimensions.</T> : null}
      </View>
    </Sheet>
  );
}

function RubricsTab({ id, body }) {
  const list = useLoad(() => api.get(`/officials-development/bodies/${id}/rubrics`, { include_archived: true }), [id]);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState(false);
  const grades = body.licence_types.filter((t) => t.holder_role === 'official');
  const sports = body.sports.map((s) => ({ value: s.sport_id, label: s.sport_name }));
  const rank = (n) => (grades.find((g) => g.grade_rank === n)?.grade || grades.find((g) => g.grade_rank === n)?.name || `rank ${n}`);
  return (
    <View>
      <View style={{ marginBottom: 10 }}><Btn small title="New rubric" onPress={() => setForm(true)} /></View>
      {!list.data ? <Loading /> : list.data.length ? list.data.map((r) => (
        <View key={r.id} style={{ marginBottom: 8 }}>
          <Card color={c.paper} pad={14}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <View style={{ flex: 1 }}><T weight="800">{r.name}</T><T size={12} color={c.mute}>{r.sport_name} · {ROLE_NAME[r.official_role]} · grades {rank(r.min_grade_rank)} to {r.max_grade_rank >= 20 ? 'any' : rank(r.max_grade_rank)}</T></View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}>{r.archived_at ? <Tag label="Archived" /> : <Tag label={r.version ? `Version ${r.version}` : 'No version yet'} color={r.version ? c.mint : c.sun} />}</View>
            </View>
            {r.dimensions ? <T size={12.5} style={{ marginTop: 6 }}>{r.dimensions.map((d) => d.label).join(' · ')}</T> : null}
            {!r.archived_at ? <Btn small title={r.version ? 'Publish a new version' : 'Define the scale and dimensions'} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setEdit(r)} /> : null}
          </Card>
        </View>)) : <Empty emoji="📐" title="No rubrics yet" sub="A rubric defines the scale and dimensions an assessor scores a role against. Without one, nobody can write a report." />}
      <RubricSheet rubric={edit} onClose={() => setEdit(null)} onSaved={list.reload} />
      <FormSheet visible={form} onClose={() => setForm(false)} title="New rubric" submitLabel="Create" initial={{ sport_id: sports[0]?.value, official_role: 'referee', min_grade_rank: 0, max_grade_rank: 20 }}
        fields={[
          { key: 'name', label: 'Name' },
          ...(sports.length > 1 ? [{ key: 'sport_id', label: 'Sport', type: 'chips', options: sports }] : []),
          { key: 'official_role', label: 'Role', type: 'chips', options: ROLE_OPTIONS },
          { key: 'min_grade_rank', label: 'From grade', type: 'chips', options: [{ value: 0, label: 'Any' }, ...grades.map((g) => ({ value: g.grade_rank, label: g.grade || g.name }))] },
          { key: 'max_grade_rank', label: 'To grade', type: 'chips', options: [...grades.map((g) => ({ value: g.grade_rank, label: g.grade || g.name })), { value: 20, label: 'Any' }] },
        ]}
        onSubmit={async (v) => { const r = await api.post(`/officials-development/bodies/${id}/rubrics`, { name: v.name, sport_id: v.sport_id ?? sports[0]?.value, official_role: v.official_role, min_grade_rank: Number(v.min_grade_rank), max_grade_rank: Number(v.max_grade_rank) }); list.reload(); setEdit(r); return 'Rubric created. Now define its scale and dimensions.'; }} />
    </View>
  );
}

// ------------------------------------------------------------------ grade requirements
function RequirementsTab({ id, body, tests }) {
  const reqs = useLoad(() => api.get(`/officials-development/bodies/${id}/requirements`), [id]);
  const [edit, setEdit] = useState(null);
  const grades = body.licence_types.filter((t) => t.holder_role === 'official');
  const byType = Object.fromEntries((reqs.data ?? []).map((r) => [r.licence_type_id, r]));
  const lower = (t) => grades.filter((g) => g.sport_id === t.sport_id && g.grade_rank < t.grade_rank);
  const line = (r) => !r ? 'No extra requirements: the body decides on the application alone.' : [r.prerequisite_name ? `holds ${r.prerequisite_name}${r.min_months_at_prerequisite ? ` ${r.min_months_at_prerequisite}+ months` : ''}` : null, r.min_assessments ? `${r.min_assessments} assessments (${r.min_favourable} supportive) in ${r.assessment_window_months} months${r.require_promotion_assessment ? ', one for promotion' : ''}` : null, r.cpd_hours ? `${r.cpd_hours} CPD hours in ${r.cpd_window_months} months` : null, r.fitness_test_name ? `${r.fitness_test_name} current` : null].filter(Boolean).join(' · ') || 'No extra requirements.';
  return (
    <View>
      <T size={12} color={c.mute} style={{ marginBottom: 8 }}>Requirements are read by the licence approval itself, for promotion, first issue and renewal. They are counts of recommendations, hours and tests: a score never promotes anyone, and approving is always a decision by a person.</T>
      {!reqs.data ? <Loading /> : grades.length ? grades.map((g) => (
        <View key={g.id} style={{ marginBottom: 8 }}>
          <Card color={c.paper} pad={14}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{g.name}{g.grade ? ` · ${g.grade}` : ''}</T><T size={12} color={c.mute}>{g.sport_name} · rank {g.grade_rank}</T></View>{byType[g.id] ? <Tag label={`Version ${byType[g.id].version}`} color={c.mint} /> : null}</View>
            <T size={12.5} style={{ marginTop: 6 }}>{line(byType[g.id])}</T>
            <Btn small title="Set requirements" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setEdit(g)} />
          </Card>
        </View>)) : <Empty emoji="🪜" title="No official grades yet" sub="Define official licence types (with grade ranks) under Licences first; requirements attach to them." />}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit ? `Requirements for ${edit.name}` : ''} submitLabel="Save requirements" initial={edit ? { ...(byType[edit.id] ?? {}), prerequisite_type_id: byType[edit.id]?.prerequisite_type_id ?? undefined, fitness_test_type_id: byType[edit.id]?.fitness_test_type_id ?? undefined } : {}}
        fields={edit ? [
          ...(lower(edit).length ? [{ key: 'prerequisite_type_id', label: 'Must already hold', type: 'chips', optional: true, options: lower(edit).map((g) => ({ value: g.id, label: g.grade || g.name })) },
            { key: 'min_months_at_prerequisite', label: 'For at least (months)', type: 'stepper', min: 0, max: 120, default: 0, show: (v) => !!v.prerequisite_type_id }] : []),
          { key: 'min_assessments', label: 'Formal assessments needed', type: 'stepper', min: 0, max: 20, default: 0 },
          { key: 'min_favourable', label: 'Of which supportive (maintain or ready for review)', type: 'stepper', min: 0, max: 20, default: 0, show: (v) => (v.min_assessments ?? 0) > 0 },
          { key: 'assessment_window_months', label: 'Within the last (months)', type: 'stepper', min: 1, max: 60, default: 12, show: (v) => (v.min_assessments ?? 0) > 0 },
          { key: 'require_promotion_assessment', label: 'One must be a promotion assessment recommending review', type: 'switch', default: false },
          { key: 'cpd_hours', label: 'Verified CPD hours', type: 'stepper', min: 0, max: 500, default: 0 },
          { key: 'cpd_window_months', label: 'Counted over the last (months)', type: 'stepper', min: 1, max: 60, default: 12, show: (v) => (v.cpd_hours ?? 0) > 0 },
          ...(tests?.length ? [{ key: 'fitness_test_type_id', label: 'Fitness or competency test', type: 'chips', optional: true, options: tests.map((t) => ({ value: t.id, label: `${t.name} v${t.version}` })) }] : []),
        ] : []}
        onSubmit={async (v) => { await api.post(`/officials-development/bodies/${id}/requirements`, { licence_type_id: edit.id, prerequisite_type_id: v.prerequisite_type_id ?? null, min_months_at_prerequisite: v.prerequisite_type_id ? v.min_months_at_prerequisite ?? 0 : 0, min_assessments: v.min_assessments ?? 0, min_favourable: Math.min(v.min_favourable ?? 0, v.min_assessments ?? 0), assessment_window_months: v.assessment_window_months ?? 12,
          require_promotion_assessment: !!v.require_promotion_assessment, cpd_hours: v.cpd_hours ?? 0, cpd_window_months: v.cpd_window_months ?? 12, fitness_test_type_id: v.fitness_test_type_id ?? null }); reqs.reload(); return 'Saved. The earlier version is kept.'; }} />
    </View>
  );
}

// ------------------------------------------------------------------ CPD and fitness
function CpdFitnessTab({ id, body, tests, reloadTests }) {
  const { toast } = useSession();
  const queue = useLoad(() => api.get('/officials-development/cpd', { body_id: id, status: 'recorded', limit: 30 }), [id]);
  const [reject, setReject] = useState(null);
  const [testForm, setTestForm] = useState(false);
  const [resForm, setResForm] = useState(false);
  const results = useLoad(() => api.get('/officials-development/fitness-results', { body_id: id }), [id]);
  const [voidIt, setVoidIt] = useState(null);
  const verify = async (r) => { try { await api.post(`/officials-development/cpd/${r.id}/decision`, { action: 'verify' }); queue.reload(); } catch (e) { toast(explain(e)); } };
  const sports = body.sports.map((s) => ({ value: s.sport_id, label: s.sport_name }));
  return (
    <Cols
      a={<Section title="CPD to verify" color={c.mint}>
        {!queue.data ? <Loading /> : queue.data.items.length ? queue.data.items.map((r) => (
          <Card key={r.id} color={c.paper} pad={14} style={{ marginBottom: 8 }}>
            <T weight="700">{r.title}</T><T size={12} color={c.mute}>{r.holder_name} · {r.kind} · {fmtDate(r.completed_on)} · {r.hours}h{r.has_evidence ? ' · evidence attached' : ''}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Verify" onPress={() => verify(r)} /><Btn small title="Not accepted" color={c.paper} ink={c.ink} onPress={() => setReject(r)} /></View>
          </Card>)) : <Empty emoji="🎓" title="Nothing to verify" sub="Self-reported CPD waits here. Records backed by an issued certificate count automatically." />}
        <FormSheet visible={!!reject} onClose={() => setReject(null)} title="Not accepted" submitLabel="Send" fields={[{ key: 'reason', label: 'Reason', type: 'multiline', hint: 'The official is shown this.' }]}
          onSubmit={async (v) => { await api.post(`/officials-development/cpd/${reject.id}/decision`, { action: 'reject', reason: v.reason }); queue.reload(); return 'Done'; }} />
      </Section>}
      b={<Section title="Fitness and competency" color={c.cyan}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}><Btn small title="Define a test" color={c.paper} ink={c.ink} onPress={() => setTestForm(true)} /><Btn small title="Record a result" disabled={!tests?.length} onPress={() => setResForm(true)} /></View>
        {(tests ?? []).map((t) => <ListCard key={t.id} title={`${t.name} v${t.version}`} sub={`${t.result_kind === 'measured' ? `Measured (${t.unit}, ${t.pass_direction === 'at_least' ? 'at least' : 'at most'} ${t.pass_threshold})` : 'Pass or fail'} · valid ${t.validity_months} months`} />)}
        {!tests?.length ? <Empty emoji="🏃" title="No test defined" sub="Only operational results are stored: never health information." /> : null}
        {(results.data ?? []).slice(0, 10).map((r) => (
          <View key={r.id} style={{ marginTop: 8 }}><ListCard title={`${r.official_name} · ${r.test_name}`} sub={`${fmtDate(r.taken_on)}${r.measured_value != null ? ` · ${r.measured_value} ${r.unit}` : ''} · valid to ${fmtDate(r.valid_until)}`} status={r.standing} statusLabel={stateLabel(r.standing)} right={!r.voided_at ? <Btn small title="Void" color={c.paper} ink={c.ink} onPress={() => setVoidIt(r)} /> : null} /></View>))}
        <FormSheet visible={testForm} onClose={() => setTestForm(false)} title="Define a test" submitLabel="Save test" initial={{ result_kind: 'pass_fail', validity_months: 12, version: '1', pass_direction: 'at_least' }}
          fields={[
            { key: 'name', label: 'Name' }, { key: 'version', label: 'Version' },
            { key: 'result_kind', label: 'Result', type: 'chips', options: [{ value: 'pass_fail', label: 'Pass or fail' }, { value: 'measured', label: 'A measured value' }] },
            { key: 'unit', label: 'Unit (for example level or seconds)', show: (v) => v.result_kind === 'measured' },
            { key: 'pass_direction', label: 'To pass the value must be', type: 'chips', options: [{ value: 'at_least', label: 'At least' }, { value: 'at_most', label: 'At most' }], show: (v) => v.result_kind === 'measured' },
            { key: 'pass_threshold', label: 'Pass threshold', type: 'number', show: (v) => v.result_kind === 'measured' },
            { key: 'validity_months', label: 'Result stays valid for (months)', type: 'stepper', min: 1, max: 60, default: 12 },
          ]}
          onSubmit={async (v) => { await api.post(`/officials-development/bodies/${id}/fitness-tests`, { name: v.name, version: v.version, result_kind: v.result_kind, validity_months: v.validity_months, ...(v.result_kind === 'measured' ? { unit: v.unit, pass_direction: v.pass_direction, pass_threshold: Number(v.pass_threshold) } : {}) }); reloadTests(); return 'Test saved'; }} />
        <FormSheet visible={resForm} onClose={() => setResForm(false)} title="Record a result" submitLabel="Record" initial={{ test_id: tests?.[0]?.id, outcome: 'pass' }}
          fields={[
            { key: 'official_id', label: 'Official', type: 'entity', entityKind: 'person', role: 'referee', noun: 'licensed official' },
            { key: 'test_id', label: 'Test', type: 'chips', options: (tests ?? []).map((t) => ({ value: t.id, label: `${t.name} v${t.version}` })) },
            { key: 'taken_on', label: 'Taken on', type: 'date' },
            { key: 'measured_value', label: 'Measured value', type: 'number', show: (v) => (tests ?? []).find((t) => t.id === v.test_id)?.result_kind === 'measured' },
            { key: 'outcome', label: 'Outcome', type: 'chips', options: [{ value: 'pass', label: 'Pass' }, { value: 'fail', label: 'Not passed' }, { value: 'completed', label: 'Completed' }], show: (v) => (tests ?? []).find((t) => t.id === v.test_id)?.result_kind !== 'measured' },
            { key: 'provider', label: 'Who ran it', optional: true },
          ]}
          onSubmit={async (v) => { const t = tests.find((x) => x.id === v.test_id); await api.post(`/officials-development/bodies/${id}/fitness-results`, { test_id: v.test_id, official_id: v.official_id, taken_on: v.taken_on, ...(t.result_kind === 'measured' ? { measured_value: Number(v.measured_value) } : { outcome: v.outcome }), ...(v.provider ? { provider: v.provider } : {}) }); results.reload(); return 'Result recorded'; }} />
        <FormSheet visible={!!voidIt} onClose={() => setVoidIt(null)} title="Void this result" submitLabel="Void" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]}
          onSubmit={async (v) => { await api.post(`/officials-development/fitness-results/${voidIt.id}/void`, { reason: v.reason }); results.reload(); return 'Voided; the record is kept'; }} />
      </Section>} />
  );
}

// ------------------------------------------------------------------ settings
function SettingsTab({ id, settings, reload }) {
  return (
    <Card color={c.paper}>
      <T weight="800" size={15}>How assessments reach officials</T>
      <FormSheet inline visible title="" submitLabel="Save policy" initial={settings}
        fields={[
          { key: 'publication', label: 'Publish a submitted report', type: 'chips', options: [{ value: 'on_submit', label: 'Straight away' }, { value: 'after_review', label: 'After my review' }] },
          { key: 'appeal_window_days', label: 'Official can ask for a review or appeal for (days)', type: 'stepper', min: 1, max: 90, default: 14 },
          { key: 'disclose_observation', label: 'Tell officials in advance that they will be observed', type: 'switch' },
        ]}
        onClose={() => {}} onSubmit={async (v) => { await api.post(`/officials-development/bodies/${id}/settings`, v); reload(); return 'Policy saved'; }} />
    </Card>
  );
}

// ------------------------------------------------------------------ the tab
export function OfficialsTab({ id, below, me }) {
  const can = me?.can ?? {};
  const staff = !!can.licences;
  const [sub, setSub] = useState('overview');
  const body = useLoad(() => api.get(`/federation/bodies/${id}`), [id]);
  const settings = useLoad(() => api.get(`/officials-development/bodies/${id}/settings`), [id]);
  const assessors = useLoad(() => (staff ? api.get(`/officials-development/bodies/${id}/assessors`, { limit: 100 }) : Promise.resolve(null)), [id, staff]);
  const tests = useLoad(() => api.get(`/officials-development/bodies/${id}/fitness-tests`), [id]);
  if (!body.data || !settings.data) return body.error ? <LoadError error={body.error} onRetry={body.reload} /> : <Loading />;
  const subs = [{ value: 'overview', label: 'Overview' },
    ...(staff ? [{ value: 'review', label: 'Review' }, { value: 'observations', label: 'Observations' }, { value: 'assessors', label: 'Assessors' }, { value: 'rubrics', label: 'Rubrics' }, { value: 'requirements', label: 'Grade requirements' }, { value: 'cpd', label: 'CPD & fitness' }, { value: 'settings', label: 'Policy' }] : [])];
  return (
    <View style={{ gap: 8 }}>
      <Seg options={subs} value={sub} onChange={setSub} color={c.violet} />
      {sub === 'overview' ? <Overview id={id} below={below} go={setSub} /> : null}
      {staff && sub === 'review' ? <ReviewTab id={id} settings={settings.data} /> : null}
      {staff && sub === 'observations' ? <ObservationsTab id={id} body={body.data} assessors={assessors.data?.items} /> : null}
      {staff && sub === 'assessors' ? <AssessorsTab id={id} body={body.data} assessors={assessors.data?.items} reload={assessors.reload} /> : null}
      {staff && sub === 'rubrics' ? <RubricsTab id={id} body={body.data} /> : null}
      {staff && sub === 'requirements' ? <RequirementsTab id={id} body={body.data} tests={tests.data} /> : null}
      {staff && sub === 'cpd' ? <CpdFitnessTab id={id} body={body.data} tests={tests.data} reloadTests={tests.reload} /> : null}
      {staff && sub === 'settings' ? <SettingsTab id={id} settings={settings.data} reload={settings.reload} /> : null}
    </View>
  );
}
