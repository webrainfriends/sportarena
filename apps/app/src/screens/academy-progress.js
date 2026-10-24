// Progress: the academy's development pathways, the review queue, assessments against pathway levels and human progression decisions.
// Evidence is always shown with where it came from (academy attendance, coach-shared observations, official results); nothing is merged into
// a score, and every decision is a person's, recorded with a reason. Moving programme / squad / certificate is done in the screen that owns it.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { Block, Fact, Initials, Origin, Split, Timeline, when } from './academy-ui';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const WHY = { not_placed: ['🆕', 'Not placed on a level'], assessment_due: ['🗓️', 'Assessment due'], assessment_awaiting_review: ['🔎', 'Assessment awaiting review'], assessment_awaiting_decision: ['⚖️', 'Assessment approved, no decision yet'] };
const DECISIONS = [['place', 'Place on a level'], ['remain', 'Stay at this level'], ['promote', 'Promote'], ['move_programme', 'Move programme'], ['invite_squad', 'Invite to squad'], ['reassess', 'Reassess'], ['graduate', 'Graduate'], ['pause', 'Pause progression']];
const OUTCOME = { criteria_met: ['✅', 'Criteria met', c.lime], criteria_partly_met: ['◐', 'Partly met', c.sunSoft], criteria_not_met: ['✖', 'Not met', c.orangeSoft], pending: ['…', 'No evidence yet', undefined] };
const key = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const monthsAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10); };

export function Progress({ o, role, archived, toast }) {
  const staff = role === 'owner' || role === 'admin';
  const [tab, setTab] = useState('queue'), [open, setOpen] = useState(null);
  const paths = useLoad(() => api.get(`/organisations/${o.id}/academy/pathways`), [o.id]);
  const queue = useLoad(() => api.get(`/organisations/${o.id}/academy/review-queue`, { limit: 100 }), [o.id]);
  const asm = useLoad(() => api.get(`/organisations/${o.id}/academy/assessments`, { limit: 100 }), [o.id]);
  const refresh = () => { paths.reload(); queue.reload(); asm.reload(); };
  const review = async (a, action) => { try { await api.post(`/academy/assessments/${a.id}/review`, { row_version: a.row_version, action }); toast(action === 'approve' ? 'Assessment approved' : 'Sent for reassessment'); refresh(); } catch (e) { toast(e.message); } };
  const opts = [{ value: 'queue', label: `Review queue${queue.data?.length ? ` (${queue.data.length})` : ''}` }, { value: 'assessments', label: 'Assessments' }, ...(staff ? [{ value: 'pathways', label: 'Pathways' }] : [])];
  const list = (
    <View style={{ gap: 12 }}>
      <Seg value={tab} onChange={setTab} color={c.violet} options={opts} />
      {tab === 'queue' ? (
        <Panel>
          <Block title="Who needs a look">
            <T size={12} color={c.mute}>Built from pathway placements, assessments and attendance. {staff ? 'Everyone in the academy.' : 'Athletes in your groups.'}</T>
            {queue.error ? <ErrorBox error={queue.error} onRetry={queue.reload} /> : !queue.data ? <Loading /> : queue.data.length ? queue.data.map((r) => (
              <Row key={`${r.pathway_id}${r.athlete_id}`} title={r.athlete_name} sub={`${r.pathway}${r.level ? ` · ${r.level}` : ''}`} right={<Tag label={`${WHY[r.reason][0]} ${WHY[r.reason][1]}`} color={c.sunSoft} />} onPress={() => setOpen({ pathway_id: r.pathway_id, athlete_id: r.athlete_id })} />
            )) : <Empty emoji="🌱" title="Nothing waiting" sub={paths.data?.length ? 'Every athlete on a pathway has a current assessment and decision.' : staff ? 'Create a pathway on the Pathways tab to start placing athletes.' : 'No pathway has been set up yet.'} />}
          </Block>
        </Panel>
      ) : null}
      {tab === 'assessments' ? (
        <Panel>
          <Block title="Assessments">
            {asm.error ? <ErrorBox error={asm.error} onRetry={asm.reload} /> : !asm.data ? <Loading /> : asm.data.length ? asm.data.map((a) => (
              <View key={a.id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={14} style={{ flex: 1 }}>{a.athlete_name} · {a.level_key}</T><Tag label={a.status} color={a.status === 'approved' ? c.lime : undefined} /></View>
                <T size={12} color={c.mute}>{a.pathway} · {when(a.period_from)} – {when(a.period_to)} · by {a.assessor_name} · {OUTCOME[a.outcome][0]} {OUTCOME[a.outcome][1]}</T>
                {a.comment ? <T size={13}>“{a.comment}” <T size={11} color={c.mute}>({a.comment_visibility === 'athlete' ? 'visible to the athlete' : 'staff only'})</T></T> : null}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Btn small title="Open athlete" color={c.paper} ink={c.ink} onPress={() => setOpen({ pathway_id: a.pathway_id, athlete_id: a.athlete_id })} />
                  {staff && !archived && ['submitted', 'appealed'].includes(a.status) ? <><Btn small title="Approve" onPress={() => review(a, 'approve')} /><Btn small title="Reassess" color={c.paper} ink={c.ink} onPress={() => review(a, 'reassess')} /></> : null}
                </View>
              </View>
            )) : <Empty emoji="📋" title="No assessments yet" sub="Open an athlete from the review queue and record an assessment against their level." />}
          </Block>
        </Panel>
      ) : null}
      {tab === 'pathways' && staff ? <Pathways o={o} data={paths} archived={archived} toast={toast} reload={refresh} /> : null}
    </View>
  );
  return <Split open={!!open} onClose={() => setOpen(null)} detailTitle="Athlete progress" list={list} detail={open ? <AthleteProgress key={`${open.pathway_id}${open.athlete_id}`} o={o} staff={staff} archived={archived} toast={toast} {...open} onChanged={refresh} /> : null} />;
}

function AthleteProgress({ o, pathway_id, athlete_id, staff, archived, toast, onChanged }) {
  const [win, setWin] = useState({ from: monthsAgo(3), to: todayStr() });
  const d = useLoad(() => api.get(`/academy/pathways/${pathway_id}/athletes/${athlete_id}`, win), [pathway_id, athlete_id, win.from, win.to]);
  const pw = useLoad(() => api.get(`/academy/pathways/${pathway_id}`), [pathway_id]);
  const [form, setForm] = useState(null), [dkey, setDkey] = useState('');
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data || !pw.data) return <Loading />;
  const p = d.data;
  const levels = [...(pw.data.versions[0]?.levels ?? [])].sort((a, b) => a.position - b.position);
  const lvlOpts = levels.map((l) => ({ value: l.key, label: l.title }));
  const unmet = p.criteria && p.criteria.outcome !== 'criteria_met' && p.criteria.checks.length > 0;
  const after = async () => { d.reload(); onChanged?.(); };
  const pending = p.assessments.find((a) => ['submitted', 'appealed'].includes(a.status));
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <T weight="800" size={16} style={{ flex: 1 }}>{p.pathway.title}</T>
        <Tag label={p.graduated ? '🎓 Graduated' : p.level ? `Level: ${levels.find((l) => l.key === p.level)?.title ?? p.level}` : 'Not placed'} color={p.level ? c.lime : c.sunSoft} />{p.paused ? <Tag label="⏸ Paused" /> : null}
      </View>
      <T size={12} color={c.mute}>Evidence window {when(p.window.from)} – {when(p.window.to)} · pathway version {p.pathway.version}</T>
      <Block title={p.evaluating ? `Against “${levels.find((l) => l.key === p.evaluating)?.title ?? p.evaluating}”` : 'Criteria'}>
        {p.criteria ? (
          <>
            <Tag label={`${OUTCOME[p.criteria.outcome][0]} ${OUTCOME[p.criteria.outcome][1]}`} color={OUTCOME[p.criteria.outcome][2]} />
            {p.criteria.checks.length ? p.criteria.checks.map((k, i) => (
              <View key={i} style={{ padding: 10, borderRadius: 12, backgroundColor: c.bg, gap: 3 }} accessible accessibilityLabel={`${k.label}. ${k.met == null ? 'No evidence yet' : k.met ? 'Met' : 'Not met'}. Required ${k.required}, actual ${k.actual ?? 'missing'}.`}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={16}>{k.met == null ? '…' : k.met ? '✅' : '✖'}</T><T size={13} weight="700" style={{ flex: 1 }}>{k.label}</T><Origin origin={k.origin} /></View>
                <T size={12} color={c.mute}>{k.kind === 'attendance' ? `Actual ${k.actual == null ? 'missing (no sessions recorded)' : `${k.actual}%`}` : `Average ${k.actual ?? 'missing'} from ${k.observations} shared observation${k.observations === 1 ? '' : 's'} (needs ${k.required_observations})`}</T>
              </View>
            )) : <T size={13} color={c.mute}>This level has no configured criteria; a person decides.</T>}
          </>
        ) : <T size={13} color={c.mute}>There is no next level on this pathway.</T>}
      </Block>
      <Block title="Evidence, with its source">
        <View style={{ gap: 4 }}><View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><T size={13} weight="700">Attendance</T><Origin origin="academy_recorded" /></View><T size={12} color={c.mute}>{p.evidence.attendance.pct == null ? 'No sessions recorded in this window.' : `${p.evidence.attendance.present} present, ${p.evidence.attendance.absent} absent, ${p.evidence.attendance.excused} excused → ${p.evidence.attendance.pct}%`}</T></View>
        <View style={{ gap: 4 }}><View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><T size={13} weight="700">Coach observations shared with the athlete</T><Origin origin="coach_observed" /></View>
          {!p.evidence.observations.consent ? <T size={12} color={c.mute}>A guardian has not allowed coaching material to be used.</T> : p.evidence.observations.dimensions.length ? p.evidence.observations.dimensions.map((x) => <T key={x.rubric_id + x.dimension_key} size={12} color={c.mute}>{x.rubric} · {x.dimension_key}: average {x.avg_score} from {x.n} (rubric v{x.rubric_version}, {when(x.first_on)} – {when(x.last_on)})</T>) : <T size={12} color={c.mute}>None in this window. Private coach notes are never used.</T>}</View>
        <View style={{ gap: 4 }}><View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><T size={13} weight="700">Competition results</T><Origin origin="official" /></View>
          {p.evidence.official.results.length ? p.evidence.official.results.map((x) => <T key={x.sport + x.metric} size={12} color={c.mute}>{x.sport} · {x.metric}: average {x.avg_value} over {x.n}</T>) : <T size={12} color={c.mute}>No approved competition results in this window.</T>}</View>
      </Block>
      {!archived ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="Record assessment" onPress={() => setForm('assess')} />
          <Btn small title="Record a decision" color={c.paper} ink={c.ink} onPress={() => { setDkey(key('dec')); setForm('decide'); }} />
        </View>
      ) : null}
      {pending ? <T size={12} color={c.mute}>An assessment from {when(pending.created_at)} is {pending.status === 'appealed' ? 'under appeal' : 'waiting for review'}.</T> : null}
      <Block title="Decisions so far">
        {p.history.length ? <Timeline items={p.history.map((h) => ({ title: `${DECISIONS.find(([k]) => k === h.decision)?.[1] ?? h.decision}${h.to_level ? ` → ${h.to_level}` : ''}`, sub: `${when(h.created_at)} · ${h.decided_by_name} · v${h.pathway_version} · ${h.reason}` }))} /> : <T size={13} color={c.mute}>No decisions yet.</T>}
        <T size={11} color={c.mute}>A decision is always a person’s. Payment status plays no part in it, and nothing here is automatic.</T>
      </Block>
      <FormSheet visible={form === 'assess'} onClose={() => setForm(null)} title="Record an assessment" submitLabel="Save assessment" initial={{ level_key: p.evaluating ?? levels[0]?.key, from: win.from, to: win.to, comment_visibility: 'staff' }}
        fields={[{ key: 'level_key', label: 'Assessed against', type: 'chips', options: lvlOpts }, { key: 'from', toKey: 'to', label: 'Period assessed', type: 'daterange' },
          { key: 'comment', label: 'Assessor comment', type: 'multiline', optional: true }, { key: 'comment_visibility', label: 'Who may read the comment', type: 'choice', options: [{ value: 'staff', label: 'Staff only' }, { value: 'athlete', label: 'The athlete / guardian too' }] }]}
        onSubmit={async (v) => { await api.post(`/academy/pathways/${pathway_id}/assessments`, { athlete_id, level_key: v.level_key, period_from: v.from, period_to: v.to, comment: v.comment, comment_visibility: v.comment_visibility }); await after(); return 'Assessment saved. The evidence it looked at is attached.'; }} />
      <FormSheet visible={form === 'decide'} onClose={() => setForm(null)} title="Record a decision" submitLabel="Record decision" initial={{ decision: p.level ? 'remain' : 'place' }}
        fields={[{ key: 'decision', label: 'Decision', type: 'chips', options: DECISIONS.map(([value, label]) => ({ value, label })) },
          { key: 'to_level', label: 'Place on', type: 'chips', options: lvlOpts, show: (v) => v.decision === 'place', optional: true },
          { key: 'reason', label: 'Reason', type: 'multiline', hint: 'Recorded with your name and the criteria as they stand now.' },
          { key: 'acknowledge_unmet_criteria', label: 'Promote even though the criteria are not all met', type: 'switch', show: (v) => v.decision === 'promote' && unmet }]}
        onSubmit={async (v) => { const r = await api.post(`/academy/pathways/${pathway_id}/decisions`, { athlete_id, decision: v.decision, to_level: v.to_level, reason: v.reason, acknowledge_unmet_criteria: !!v.acknowledge_unmet_criteria, expected_from_level: p.level ?? null, assessment_id: p.assessments.find((a) => a.status === 'approved')?.id, idempotency_key: dkey }); await after(); return r.follow_up ? r.follow_up.note : 'Decision recorded'; }} />
    </View>
  );
}

const emptyLevel = (n) => ({ key: `level_${n}`, position: n });

function Pathways({ o, data, archived, toast, reload }) {
  const [form, setForm] = useState(null), [edit, setEdit] = useState(null);
  const rub = useLoad(() => api.get(`/organisations/${o.id}/academy/rubrics`), [o.id]);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 }), [o.id]);
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  return (
    <Panel>
      <Block title="Development pathways" right={!archived ? <Btn small title="＋ New pathway" onPress={() => setForm('new')} /> : null}>
        <T size={12} color={c.mute}>A pathway is your own ladder: foundation to elite, belts and grades, age groups, a goalkeeper stream. Each level can ask for minimum attendance and coach-rubric scores. Publishing a new version never changes past decisions.</T>
        {data.data.length ? data.data.map((p) => (
          <View key={p.id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={15} style={{ flex: 1 }}>{p.title}</T><Tag label={p.current_version ? `v${p.current_version}` : 'No levels yet'} />{p.sport ? <Tag label={p.sport} /> : null}</View>
            {p.levels.map((l) => <T key={l.key} size={13}>{l.position}. <T weight="700">{l.title}</T> <T size={12} color={c.mute}>{[l.age_min != null ? `ages ${l.age_min}–${l.age_max ?? '+'}` : null, l.min_attendance_pct != null ? `≥${l.min_attendance_pct}% attendance` : null, l.criteria.length ? `${l.criteria.length} rubric criteri${l.criteria.length === 1 ? 'on' : 'a'}` : null, `${p.distribution.find((d) => d.level === l.key)?.n ?? 0} athletes`].filter(Boolean).join(' · ')}</T></T>)}
            {!archived ? <Btn small title={p.current_version ? 'Edit levels (new version)' : 'Add levels'} color={c.paper} ink={c.ink} onPress={() => setEdit(p)} style={{ alignSelf: 'flex-start' }} /> : null}
          </View>
        )) : <Empty emoji="🪜" title="No pathways yet" sub="Create one, add its levels, then place athletes on it from the review queue." />}
      </Block>
      <FormSheet visible={form === 'new'} onClose={() => setForm(null)} title="New pathway" submitLabel="Create"
        fields={[{ key: 'title', label: 'Name', hint: 'For example “Outfield player pathway”.' }, { key: 'sport', label: 'Sport', type: 'sport', optional: true }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/pathways`, v); reload(); return 'Pathway created. Add its levels next.'; }} />
      {edit ? <LevelsEditor pathway={edit} rubrics={rub.data ?? []} programmes={progs.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); toast('New version published'); }} /> : null}
    </Panel>
  );
}

function LevelsEditor({ pathway, rubrics, programmes, onClose, onSaved }) {
  const [levels, setLevels] = useState(() => pathway.levels.map((l) => ({ ...l })));
  const [form, setForm] = useState(null), [crit, setCrit] = useState(null), [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  const move = (i, d) => setLevels((ls) => { const a = [...ls]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a.map((l, n) => ({ ...l, position: n + 1 })); });
  const publish = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/academy/pathways/${pathway.id}/versions`, { row_version: pathway.row_version, levels: levels.map((l, n) => ({ ...l, position: n + 1 })) }); onSaved(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const dims = (rid) => rubrics.find((r) => r.id === rid)?.dimensions ?? [];
  return (
    <View style={{ marginTop: 12, padding: 14, borderRadius: 18, backgroundColor: c.bg, gap: 10, borderWidth: 1, borderColor: c.line }}>
      <T weight="800" size={15}>Levels of “{pathway.title}” — new version</T>
      {levels.map((l, i) => (
        <View key={l.key} style={{ padding: 10, borderRadius: 14, backgroundColor: c.paper, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><T weight="800" size={14} style={{ flex: 1 }}>{i + 1}. {l.title}</T>
            <Btn small title="↑" color={c.paper} ink={c.ink} onPress={() => move(i, -1)} accessibilityLabel="Move up" /><Btn small title="↓" color={c.paper} ink={c.ink} onPress={() => move(i, 1)} accessibilityLabel="Move down" />
            <Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => setLevels((ls) => ls.filter((_, n) => n !== i).map((x, n) => ({ ...x, position: n + 1, prerequisites: (x.prerequisites ?? []).filter((p) => p !== l.key) })))} /></View>
          <T size={12} color={c.mute}>{[l.age_min != null ? `ages ${l.age_min}–${l.age_max ?? '+'}` : 'any age', l.min_attendance_pct != null ? `≥${l.min_attendance_pct}% attendance` : 'no attendance rule', (l.programme_ids ?? []).length ? `${l.programme_ids.length} programme(s)` : null].filter(Boolean).join(' · ')}</T>
          {(l.criteria ?? []).map((k, n) => <T key={n} size={12}>• {rubrics.find((r) => r.id === k.rubric_id)?.name ?? 'Rubric'} · {k.dimension_key} ≥ {k.min_avg_score} over {k.min_observations}+ observations</T>)}
          <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm({ at: i, level: l })} /><Btn small title="＋ Rubric criterion" color={c.paper} ink={c.ink} onPress={() => setCrit({ at: i })} disabled={!rubrics.length} /></View>
        </View>
      ))}
      <Btn small title="＋ Add level" onPress={() => setForm({ at: levels.length, level: null })} style={{ alignSelf: 'flex-start' }} />
      {!rubrics.length ? <T size={12} color={c.mute}>Rubric criteria use the scoring rubrics your coaches build in Coach Performance Studio. None exist yet, so levels can only use attendance and a person’s judgement.</T> : null}
      {err ? <ErrorBox error={err} /> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}><Btn title={busy ? 'Publishing…' : 'Publish version'} onPress={publish} disabled={busy || !levels.length} /><Btn title="Cancel" color={c.paper} ink={c.ink} onPress={onClose} /></View>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.level ? 'Edit level' : 'Add a level'} submitLabel="Save level"
        initial={form?.level ? { title: form.level.title, has_age: form.level.age_min != null, age_min: form.level.age_min ?? 8, age_max: form.level.age_max ?? 12, has_att: form.level.min_attendance_pct != null, min_attendance_pct: form.level.min_attendance_pct ?? 75, programme_ids: form.level.programme_ids ?? [], prerequisites: form.level.prerequisites ?? [], destinations: (form.level.destinations ?? []).map((d) => d.kind) } : { has_age: false, age_min: 8, age_max: 12, has_att: false, min_attendance_pct: 75, programme_ids: [], prerequisites: [], destinations: [] }}
        fields={[{ key: 'title', label: 'Level name', hint: 'For example Foundation, Development, Yellow belt.' },
          { key: 'has_age', label: 'Guide to an age range', type: 'switch' }, { key: 'age_min', label: 'From age', type: 'stepper', min: 3, max: 99, show: (v) => v.has_age }, { key: 'age_max', label: 'To age', type: 'stepper', min: 3, max: 99, show: (v) => v.has_age },
          { key: 'has_att', label: 'Require minimum attendance', type: 'switch' }, { key: 'min_attendance_pct', label: 'Attendance at least', type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', show: (v) => v.has_att },
          { key: 'prerequisites', label: 'Must have completed', type: 'multi', optional: true, options: levels.filter((_, n) => n < (form?.at ?? 0)).map((x) => ({ value: x.key, label: x.title })) },
          { key: 'programme_ids', label: 'Expected programmes', type: 'multi', optional: true, options: programmes.map((p) => ({ value: p.id, label: p.title })) },
          { key: 'destinations', label: 'Where it can lead', type: 'multi', optional: true, options: [{ value: 'next_level', label: 'Next level' }, { value: 'squad', label: 'Squad / team' }, { value: 'elite_programme', label: 'Elite programme' }, { value: 'graduation', label: 'Graduation' }, { value: 'external', label: 'External opportunity' }] }]}
        onSubmit={async (v) => {
          const base = form.level ?? emptyLevel(form.at + 1);
          const slug = base.key.startsWith('level_') ? v.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || base.key : base.key;
          const lvl = { ...base, key: slug, title: v.title, position: form.at + 1, age_min: v.has_age ? v.age_min : undefined, age_max: v.has_age ? v.age_max : undefined, min_attendance_pct: v.has_att ? v.min_attendance_pct : undefined, prerequisites: v.prerequisites ?? [], programme_ids: v.programme_ids ?? [], criteria: base.criteria ?? [],
            destinations: (v.destinations ?? []).map((k) => ({ kind: k, label: { next_level: 'Next level', squad: 'Squad / team', elite_programme: 'Elite programme', graduation: 'Graduation', external: 'External opportunity' }[k] })) };
          if (levels.some((x, n) => x.key === lvl.key && n !== form.at)) throw new Error('Another level has the same name');
          setLevels((ls) => { const a = [...ls]; a[form.at] = lvl; return a; });
        }} />
      <FormSheet visible={!!crit} onClose={() => setCrit(null)} title="Rubric criterion" submitLabel="Add criterion" initial={{ min_avg_score: 3, min_observations: 2 }}
        fields={[{ key: 'rubric_id', label: 'Coach rubric', type: 'chips', options: rubrics.map((r) => ({ value: r.id, label: `${r.name} · ${r.coach_name}` })) },
          { key: 'dimension_key', label: 'Dimension', type: 'chips', options: (v) => dims(v.rubric_id).map((d) => ({ value: d.key, label: d.name ?? d.key })) },
          { key: 'min_avg_score', label: 'Average score at least', type: 'stepper', min: 0, max: 100 }, { key: 'min_observations', label: 'From at least this many observations', type: 'stepper', min: 1, max: 50 }]}
        onSubmit={async (v) => setLevels((ls) => ls.map((l, n) => (n === crit.at ? { ...l, criteria: [...(l.criteria ?? []), { rubric_id: v.rubric_id, dimension_key: v.dimension_key, min_avg_score: v.min_avg_score, min_observations: v.min_observations }] } : l)))} />
    </View>
  );
}

/** The athlete / guardian side: where the athlete is on each pathway, what they may read, and what they choose to share about fitness. */
export function FamilyProgress({ athlete, toast }) {
  const isMe = athlete.is_me;
  const q = isMe ? undefined : { athlete_id: athlete.id };
  const d = useLoad(() => api.get('/academy/my-progress', q), [athlete.id]);
  const sh = useLoad(() => api.get('/academy/clearance-shares', q), [athlete.id]);
  const [appeal, setAppeal] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const live = (orgId) => (sh.data ?? []).find((s) => s.organisation_id === orgId && !s.revoked_at);
  const toggle = async (org) => {
    try {
      const cur = live(org.id);
      if (cur) await api.post(`/academy/clearance-shares/${cur.id}/revoke`, {});
      else await api.post('/academy/clearance-shares', { organisation_id: org.id, ...(isMe ? {} : { athlete_id: athlete.id }) });
      toast(cur ? 'Stopped sharing' : 'Shared the fit status only'); sh.reload();
    } catch (e) { toast(e.message); }
  };
  if (!d.data.academies.length) return <Panel><Empty emoji="🪜" title="No progress yet" sub="Once an academy places you on a pathway, your level, assessments and next review appear here." /></Panel>;
  return (
    <View style={{ gap: 14, marginTop: 12 }}>
      {d.data.is_youth && !d.data.coaching_consent ? <Panel><T size={13}>Coaching assessments are hidden because a guardian has not allowed coaching material to be shared. Your level and decisions are still shown.</T></Panel> : null}
      {d.data.academies.map((a) => (
        <Panel key={a.organisation.id}>
          <Block title={a.organisation.name}>
            {a.pathways.length ? a.pathways.map((p) => (
              <View key={p.pathway_id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={15} style={{ flex: 1 }}>{p.title}</T><Tag label={p.graduated ? '🎓 Graduated' : `Level: ${p.level_title ?? p.level}`} color={c.lime} /></View>
                {p.next_level ? <T size={13}>Next level: {p.next_level}</T> : null}
                {p.next_review_on ? <T size={12} color={c.mute}>Next review around {when(p.next_review_on)}</T> : null}
                {p.destinations.length ? <T size={12} color={c.mute}>Could lead to: {p.destinations.map((x) => x.label).join(', ')}</T> : null}
                {p.assessments.map((s) => (
                  <View key={s.id} style={{ gap: 2 }}>
                    <T size={13} weight="700">Assessment {when(s.created_at)} · {s.level_key}</T>
                    {s.comment ? <T size={13}>“{s.comment}”</T> : null}
                    <Btn small title="Ask for a second look" color={c.paper} ink={c.ink} onPress={() => setAppeal(s)} style={{ alignSelf: 'flex-start' }} />
                  </View>
                ))}
                <Timeline items={p.decisions.slice(0, 5).map((x) => ({ title: `${(DECISIONS.find(([k]) => k === x.decision) ?? [0, x.decision])[1]}${x.to_level ? ` → ${x.to_level}` : ''}`, sub: `${when(x.created_at)} · ${x.reason}` }))} />
              </View>
            )) : <T size={13} color={c.mute}>Not placed on a pathway yet.</T>}
            {a.attendance_weeks.length ? <T size={12} color={c.mute}>Attendance, last 8 weeks: {a.attendance_weeks.map((w) => `${when(w.week)} ${w.present}/${w.present + w.absent}`).join(' · ')}</T> : null}
            <View style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 6 }}>
              <T weight="800" size={14}>Fit-to-take-part status</T>
              <T size={12} color={c.mute}>You can let this academy see only whether {isMe ? 'you are' : `${athlete.display_name} is`} cleared, restricted or not cleared, and until when. Never a diagnosis, treatment or reason. {isMe ? 'Stop any time.' : 'A guardian’s medical consent is needed, and stopping it hides the status at once.'}</T>
              <Btn small title={live(a.organisation.id) ? 'Stop sharing' : 'Share fit status only'} color={live(a.organisation.id) ? c.paper : c.pink} ink={live(a.organisation.id) ? c.ink : '#fff'} onPress={() => toggle(a.organisation)} style={{ alignSelf: 'flex-start' }} />
            </View>
          </Block>
        </Panel>
      ))}
      <T size={11} color={c.mute}>Coaching evidence and official competition results are kept separate. Private coach notes are never shown here.</T>
      <FormSheet visible={!!appeal} onClose={() => setAppeal(null)} title="Ask for a second look" submitLabel="Send" fields={[{ key: 'reason', label: 'What would you like looked at again?', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/academy/assessments/${appeal.id}/appeal`, v); d.reload(); return 'Sent. The academy will review it.'; }} />
    </View>
  );
}
