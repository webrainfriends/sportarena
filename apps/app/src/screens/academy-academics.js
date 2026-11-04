// Academics & school: sport and study side by side. Verified schools are linked to an enrolment (the school stays one canonical organisation), families decide what
// the academy may hold, school exams and lessons are checked against the sport timetable before it is published, school attendance raises follow-ups, and grades are
// restricted to education staff with record access and the family. This screen only calls the API; the server decides who sees what, and hides what a role cannot use.
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Row, Seg, Sheet, T, Tag } from '../ui';
import { DateField, DateRangeField } from '../pickers';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';
import { Bars, Block, Fact, Kpi, Split, when } from './academy-ui';

const Panel = ({ children, tone }) => <View style={{ backgroundColor: tone ?? c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const key = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (n) => iso(new Date(Date.now() + n * 86400000));
const at = (v) => { try { return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(v)); } catch { return String(v); } };
const hm = (v) => { try { return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(v)); } catch { return String(v); } };
const KINDS = ['school_day', 'lesson', 'exam', 'tutoring', 'study_hall', 'school_event'];
const TKINDS = ['coach_school_liaison', 'guardian_meeting', 'report_due', 'tutoring_support', 'attendance_exception', 'exam_clash', 'other'];
const AUDS = ['coach', 'school', 'guardian', 'education'];
const SRC = ['school_confirmed', 'manual_verified', 'partner_import'];
const kindLabel = (k) => t(`ax.kind.${k}`);
const srcLabel = (s) => t(`ax.src.${s}`);
const opts = (list, ns) => list.map((v) => ({ value: v, label: t(`${ns}.${v}`) }));
const SOURCE_TONE = { school_confirmed: c.lime, manual_verified: c.violetSoft, partner_import: c.sunSoft, school_report: c.lime };

/** Where a piece of information came from, always written out. */
const Source = ({ s, ref: r }) => <Tag label={`${srcLabel(s)}${r ? ` · ${r}` : ''}`} color={SOURCE_TONE[s]} />;
const Shared = ({ on, label }) => { const text = `${on ? '✓' : '○'} ${label}: ${on ? t('ax.share.on') : t('ax.share.off')}`; return <Tag label={text} color={on ? c.lime : c.sunSoft} />; };

export function Academics({ o, role, archived, toast }) {
  const owner = role === 'owner' || role === 'admin';
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/academics`), [o.id]);
  const links = useLoad(() => api.get(`/organisations/${o.id}/academy/school-links`, { limit: 100 }), [o.id]);
  const [sec, setSec] = useState('overview'), [open, setOpen] = useState(null), [q, setQ] = useState(''), [showLink, setShowLink] = useState(false);
  const reload = () => { d.reload(); links.reload(); };
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data, k = x.kpis, rec = x.my_access.academic_records;
  const sections = [{ value: 'overview', label: t('ax.sec.overview') }, { value: 'athletes', label: t('ax.sec.athletes') }, { value: 'timetable', label: t('ax.sec.timetable') }, { value: 'tasks', label: t('ax.sec.tasks') }, { value: 'setup', label: t('ax.sec.setup') }];
  const P = { o, toast, archived, data: x, reload, rec, owner };
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}>
        <T size={22} weight="800" accessibilityRole="header">{t('ax.title')}</T>
        <T size={13} color={c.mute}>{t('ax.intro')}</T>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label={t('ax.kpi.linked')} value={k.linked} sub={k.enrolled ? t('ax.kpi.linked_sub', { pct: k.coverage_pct ?? 0, total: k.enrolled }) : t('ax.kpi.linked_sub_none')} />
        <Kpi label={t('ax.kpi.pending')} value={k.consent_pending} sub={t('ax.kpi.pending_sub')} />
        <Kpi label={t('ax.kpi.exams')} value={k.exams_14d} sub={t('ax.kpi.exams_sub')} />
        <Kpi label={t('ax.kpi.clashes')} value={k.open_clashes} sub={t('ax.kpi.clashes_sub')} tone={k.open_clashes ? 'alert' : undefined} onPress={() => setSec('overview')} />
        <Kpi label={t('ax.kpi.exceptions')} value={k.attendance_exceptions} sub={t('ax.kpi.exceptions_sub', { pct: x.settings.attendance_threshold_pct })} tone={k.attendance_exceptions ? 'alert' : undefined} />
        {k.snapshots_due != null ? <Kpi label={t('ax.kpi.snapshots')} value={k.snapshots_due} sub={t('ax.kpi.snapshots_sub', { days: x.settings.snapshot_cadence_days })} /> : null}
        <Kpi label={t('ax.kpi.tasks')} value={k.tasks_open} sub={t('ax.kpi.tasks_sub', { n: k.tasks_overdue })} tone={k.tasks_overdue ? 'alert' : undefined} onPress={() => setSec('tasks')} />
      </View>
      <Seg value={sec} onChange={setSec} color={c.violet} options={sections} />
      {sec === 'overview' ? <Overview {...P} goAthlete={(id) => { setSec('athletes'); setOpen(id); }} /> : null}
      {sec === 'athletes' ? <Athletes {...P} links={links} open={open} setOpen={setOpen} q={q} setQ={setQ} onLink={() => setShowLink(true)} /> : null}
      {sec === 'timetable' ? <Timetable {...P} /> : null}
      {sec === 'tasks' ? <Tasks {...P} /> : null}
      {sec === 'setup' ? <Setup {...P} /> : null}
      <LinkSheet visible={showLink} o={o} onClose={() => setShowLink(false)} onDone={() => { setShowLink(false); toast(t('ax.link.done')); reload(); }} />
    </View>
  );
}

// ------------------------------------------------------------------ overview
function Overview({ o, toast, archived, data: x, reload, rec, goAthlete }) {
  const resolve = async (cl) => { try { await api.post(`/academy/sessions/${cl.session_id}/academic-clashes`, { athlete_id: cl.athlete_id, block_id: cl.block_id }); toast(t('ax.clash.excused')); reload(); } catch (e) { toast(e.message); } };
  const task = async (e) => { try { await api.post(`/organisations/${o.id}/academy/academic-tasks`, { athlete_id: e.athlete_id, link_id: e.link_id, kind: 'attendance_exception', audience: 'education', title: t('ax.tk.attendance_exception'), priority: 'high', due_on: plus(7), idempotency_key: key('att') }); toast(t('ax.tasks.saved')); reload(); } catch (err) { toast(err.message); } };
  return (
    <View style={{ gap: 14 }}>
      <Panel tone={x.clashes.length ? c.orangeSoft : undefined}>
        <Block title={t('ax.clashes.title')}>
          <T size={12} color={c.mute}>{t('ax.clashes.help')}</T>
          {x.clashes.length ? x.clashes.map((cl) => (
            <View key={`${cl.session_id}${cl.athlete_id}${cl.block_id}`} style={{ padding: 10, borderRadius: 14, backgroundColor: c.paper, gap: 6, borderWidth: 1, borderColor: c.line }}>
              <T weight="800" size={14}>{t('ax.clash.line', { athlete: cl.athlete_name, kind: t(`ax.kindword.${cl.block_kind}`) })}</T>
              <T size={12} color={c.mute}>{cl.title} · {cl.cohort_name} · {at(cl.starts_at)} · {cl.status}</T>
              {!archived ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title={t('ax.clash.excuse')} onPress={() => resolve(cl)} /></View> : null}
            </View>
          )) : <Empty emoji="🗓️" title={t('ax.clashes.empty_t')} sub={x.kpis.schedule_shared ? t('ax.clashes.empty_s') : t('ax.clashes.none_shared')} />}
        </Block>
      </Panel>
      <Panel>
        <Block title={t('ax.exams.title')}>
          {x.exams.length ? x.exams.map((e) => <Row key={e.id} title={e.athlete_name} sub={`${at(e.starts_at)} – ${hm(e.ends_at)} · ${srcLabel(e.source)}`} right={<Tag label={kindLabel('exam')} color={c.sunSoft} />} onPress={() => goAthlete(e.link_id)} />) : <T size={13} color={c.mute}>{t('ax.exams.empty')}</T>}
        </Block>
      </Panel>
      <Panel>
        <Block title={t('ax.att.title')}>
          {x.exceptions.length ? x.exceptions.map((e) => (
            <View key={e.link_id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={14} style={{ flex: 1 }}>{e.athlete_name} · {e.school}</T><Tag label={t('ax.att.line', { pct: e.percent, period: `${when(e.period_from)} – ${when(e.period_to)}` })} color={c.orangeSoft} /></View>
              <Bars label={t('ax.att.section')} rows={[{ label: t('ax.att.present'), value: e.percent, text: `${e.percent}%`, tone: c.orange }]} />
              {e.reasons.map((r) => <T key={r} size={12} color={c.mute}>• {r}</T>)}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={e.source_label} color={c.violetSoft} /><Btn small title={t('ax.sec.athletes')} color={c.paper} ink={c.ink} onPress={() => goAthlete(e.link_id)} />{!archived ? <Btn small title={t('ax.att.task')} onPress={() => task(e)} /> : null}</View>
            </View>
          )) : <Empty emoji="📈" title={t('ax.att.empty_t')} sub={t('ax.att.empty_s')} />}
        </Block>
      </Panel>
      {rec ? (
        <Panel>
          <Block title={t('ax.snap.due_title')}>
            {x.snapshots_due.length ? x.snapshots_due.map((s) => <Row key={s.link_id} title={s.athlete_name} sub={`${s.school} · ${s.last_snapshot_days == null ? t('ax.snap.never') : t('ax.snap.days', { n: s.last_snapshot_days })}`} onPress={() => goAthlete(s.link_id)} />) : <T size={13} color={c.mute}>{t('ax.snap.due_empty')}</T>}
          </Block>
        </Panel>
      ) : null}
      <Panel>
        <Block title={t('ax.schools.title')}>
          {x.schools.length ? x.schools.map((s) => <Row key={s.school_id} title={s.name} sub={t('ax.schools.line', { n: s.athletes, shared: s.shared })} />) : <Empty emoji="🏫" title={t('ax.schools.title')} sub={t('ax.schools.empty')} />}
        </Block>
      </Panel>
      <Panel>
        <Block title={t('ax.src.title')}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[...SRC, 'school_report'].map((s) => <Tag key={s} label={srcLabel(s)} color={SOURCE_TONE[s]} />)}</View>
          <T size={12} color={c.mute}>{t('ax.priv.body')}</T>
        </Block>
      </Panel>
    </View>
  );
}

// ------------------------------------------------------------------ athletes
function Athletes({ o, toast, archived, links, open, setOpen, q, setQ, onLink, rec, owner, reload }) {
  const [status, setStatus] = useState('active');
  const ended = useLoad(() => (status === 'ended' ? api.get(`/organisations/${o.id}/academy/school-links`, { status: 'ended', limit: 100 }) : Promise.resolve(null)), [o.id, status]);
  const rows = (status === 'ended' ? ended.data?.links : links.data?.links) ?? [];
  const shown = useMemo(() => rows.filter((l) => !q.trim() || l.athlete_name.toLowerCase().includes(q.trim().toLowerCase())), [rows, q]);
  const cur = rows.find((l) => l.id === open);
  const list = (
    <Panel>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Seg value={status} onChange={setStatus} options={[{ value: 'active', label: t('ax.sec.athletes') }, { value: 'ended', label: t('ax.athletes.ended') }]} />
        {!archived ? <Btn small title={t('ax.athletes.link')} onPress={onLink} accessibilityLabel={t('ax.athletes.link')} /> : null}
      </View>
      <FormSearch value={q} onChange={setQ} />
      {links.error ? <ErrorBox error={links.error} onRetry={links.reload} /> : !links.data ? <Loading /> : shown.length ? shown.map((l) => (
        <Row key={l.id} title={l.athlete_name} sub={`${l.school.name}${l.year_group ? ` · ${l.year_group}` : ''}${l.programme ? ` · ${l.programme}` : ''}`}
          right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Shared on={l.shared?.schedule} label={t('ax.share.schedule')} />{l.next_exam ? <T size={11} color={c.mute}>{t('ax.athletes.next_exam', { date: at(l.next_exam) })}</T> : null}{l.attendance ? <T size={11} color={c.mute}>{t('ax.athletes.attendance', { pct: l.attendance.percent })}</T> : null}</View>}
          onPress={() => setOpen(l.id)} color={open === l.id ? c.violetSoft : c.paper} />
      )) : <Empty emoji="🎓" title={t('ax.athletes.empty_t')} sub={t('ax.athletes.empty_s')} />}
    </Panel>
  );
  return <Split open={!!cur} onClose={() => setOpen(null)} detailTitle={cur?.athlete_name} list={list} detail={cur ? <AthleteDetail key={cur.id} o={o} link={cur} toast={toast} archived={archived} rec={rec} owner={owner} onChanged={() => { links.reload(); reload(); }} /> : null} />;
}

const FormSearch = ({ value, onChange }) => <Field value={value} onChangeText={onChange} placeholder={t('ax.athletes.search')} accessibilityLabel={t('ax.athletes.search')} />;

function AthleteDetail({ o, link: l, toast, archived, rec, owner, onChanged }) {
  const from = iso(new Date()), to = plus(60);
  const blocks = useLoad(() => api.get(`/organisations/${o.id}/academy/school-blocks`, { from, to, athlete_id: l.athlete_id }), [o.id, l.athlete_id]);
  const att = useLoad(() => api.get(`/academy/school-links/${l.id}/attendance`), [l.id]);
  const snaps = useLoad(() => api.get(`/academy/school-links/${l.id}/snapshots`), [l.id]);
  const tasks = useLoad(() => api.get(`/organisations/${o.id}/academy/academic-tasks`, { athlete_id: l.athlete_id, limit: 20 }), [o.id, l.athlete_id]);
  const [form, setForm] = useState(null);
  const reload = () => { blocks.reload(); att.reload(); snaps.reload(); tasks.reload(); onChanged(); };
  const sched = l.shared?.schedule, prog = l.shared?.progress, live = l.status === 'active' && !archived;
  const cancel = async (b) => { try { await api.post(`/academy/school-blocks/${b.block_id}/cancel`, { reason: t('ax.block.cancelled') }); toast(t('ax.block.cancelled')); reload(); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 12 }}>
      <Block title={t('ax.detail.link')} right={l.status === 'active' && !archived ? <Btn small title={t('ax.link.edit')} color={c.paper} ink={c.ink} onPress={() => setForm('edit')} /> : undefined}>
        <Fact k={t('ax.link.school')} v={l.school.name} /><Fact k={t('ax.detail.year')} v={l.year_group} /><Fact k={t('ax.detail.provision')} v={t(`ax.prov.${l.provision}`)} /><Fact k={t('ax.detail.since')} v={when(l.starts_on)} />
        <T size={12} color={c.mute}>{l.import_authorised ? t('ax.detail.partner_on') : t('ax.detail.partner_off')}</T>
        {l.status === 'ended' ? <Tag label={t('ax.me.ended')} /> : null}
      </Block>
      <Block title={t('ax.sec.athletes')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Shared on={sched} label={t('ax.share.schedule')} /><Shared on={prog} label={t('ax.share.progress')} /></View>
        <T size={12} color={c.mute}>{t('ax.share.explain')}</T>
      </Block>
      <Block title={t('ax.block.title')} right={live && sched ? <Btn small title={t('ax.block.add')} onPress={() => setForm('block')} /> : undefined}>
        {!sched ? <T size={13} color={c.mute}>{t('ax.block.locked')}</T> : blocks.error ? <ErrorBox error={blocks.error} onRetry={blocks.reload} /> : !blocks.data ? <Loading /> : blocks.data.items.length ? blocks.data.items.slice(0, 40).map((b) => (
          <Row key={`${b.block_id}${b.starts_at}`} title={`${kindLabel(b.kind)}${b.label ? ` · ${b.label}` : ''}`} sub={`${at(b.starts_at)} – ${hm(b.ends_at)}`} right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Source s={b.source} />{live ? <Btn small title={t('ax.block.cancel')} color={c.paper} ink={c.ink} onPress={() => cancel(b)} /> : null}</View>} />
        )) : <T size={13} color={c.mute}>{t('ax.block.empty')}</T>}
      </Block>
      <Block title={t('ax.att.section')} right={live && sched ? <Btn small title={t('ax.att.record')} onPress={() => setForm('att')} /> : undefined}>
        {!sched ? <T size={13} color={c.mute}>{t('ax.block.locked')}</T> : !att.data ? <Loading /> : att.data.periods.length ? att.data.periods.map((p) => (
          <View key={p.id} style={{ gap: 4 }}>
            <Bars label={t('ax.att.section')} rows={[{ label: `${when(p.period_from)} – ${when(p.period_to)}`, value: p.percent, text: `${p.percent}%`, tone: p.exceptions.length ? c.orange : c.cyan }]} />
            <T size={12} color={c.mute}>{t('ax.att.row', { present: p.present, possible: p.sessions_possible, auth: p.authorised_absence, unauth: p.unauthorised_absence })}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Source s={p.source} ref={p.source_ref} />{p.exceptions.length ? <Tag label={t('ax.att.flag')} color={c.orangeSoft} /> : null}</View>
          </View>
        )) : <T size={13} color={c.mute}>{t('ax.att.none')}</T>}
      </Block>
      <Block title={t('ax.prog.title')} right={live && prog && rec ? <Btn small title={t('ax.prog.add')} onPress={() => setForm('snap')} /> : undefined}>
        {!prog ? <T size={13} color={c.mute}>{t('ax.prog.not_shared')}</T> : !snaps.data ? <Loading /> : snaps.data.snapshots.length ? snaps.data.snapshots.map((s) => <Snapshot key={s.id} s={s} />) : <T size={13} color={c.mute}>{t('ax.prog.empty')}</T>}
        {prog && snaps.data && !snaps.data.can_read_grades && snaps.data.snapshots.length ? <T size={12} color={c.mute}>🔒 {t('ax.prog.locked_s')}</T> : null}
      </Block>
      <Block title={t('ax.tasks.title')} right={live ? <Btn small title={t('ax.tasks.new')} onPress={() => setForm('task')} /> : undefined}>
        {!tasks.data ? <Loading /> : tasks.data.tasks.length ? tasks.data.tasks.map((k) => <Row key={k.id} title={k.title} sub={`${t(`ax.tk.${k.kind}`)} · ${t(`ax.aud.${k.audience}`)}${k.due_on ? ` · ${when(k.due_on)}` : ''}`} right={k.overdue ? <Tag label={t('ax.tasks.overdue')} color={c.orangeSoft} /> : <Tag label={k.status} />} />) : <T size={13} color={c.mute}>{t('ax.tasks.empty_t')}</T>}
      </Block>
      <BlockForm visible={form === 'block'} link={l} onClose={() => setForm(null)} rec={rec} onDone={(r) => { setForm(null); toast(r.clashes_with_published_sessions ? t('ax.block.clash_task', { n: r.clashes_with_published_sessions }) : t('ax.block.saved')); reload(); }} />
      <AttendanceForm visible={form === 'att'} link={l} onClose={() => setForm(null)} onDone={() => { setForm(null); toast(t('ax.att.saved')); reload(); }} />
      <SnapshotForm visible={form === 'snap'} link={l} o={o} previous={[...new Set((snaps.data?.snapshots ?? []).flatMap((x) => (x.entries ?? []).map((e) => e.subject)))]} onClose={() => setForm(null)} onDone={() => { setForm(null); toast(t('ax.prog.saved')); reload(); }} />
      <TaskForm visible={form === 'task'} o={o} athleteId={l.athlete_id} linkId={l.id} onClose={() => setForm(null)} onDone={() => { setForm(null); toast(t('ax.tasks.saved')); reload(); }} />
      <EditLinkForm visible={form === 'edit'} link={l} owner={owner} onClose={() => setForm(null)} onDone={(msg) => { setForm(null); toast(msg); reload(); }} />
    </View>
  );
}

function Snapshot({ s }) {
  const lock = `🔒 ${t('ax.restricted')}`;
  return (
    <View style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800" size={14} style={{ flex: 1 }}>{s.term_label} · {t('ax.prog.version', { n: s.version })}</T>
        {s.restricted ? <Tag label={lock} /> : <Tag label={t(`ax.prog.standing.${s.standing}`)} color={s.standing === 'on_track' ? c.lime : s.standing === 'watch' ? c.sunSoft : c.orangeSoft} />}
      </View>
      {!s.restricted ? s.entries.map((e) => <View key={e.subject} style={{ flexDirection: 'row', gap: 8 }}><T size={13} style={{ flex: 1 }}>{e.subject}</T><T size={13} weight="800">{e.grade}{e.target ? ` → ${e.target}` : ''}</T></View>) : null}
      {!s.restricted && s.comment ? <T size={12} color={c.mute}>“{s.comment}”</T> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Source s={s.source} ref={s.source_ref} /><Tag label={t(`ax.prog.vis.${s.visibility}`)} /><Tag label={s.framework.name} /></View>
      <T size={11} color={c.mute}>{t('ax.prog.recorded', { date: when(s.source_date) })}</T>
    </View>
  );
}

// ------------------------------------------------------------------ forms
function LinkSheet({ visible, o, onClose, onDone }) {
  const loadAthletes = useMemo(() => async (qq) => (await api.get(`/organisations/${o.id}/academy/school-links/candidates`, { q: qq || undefined, limit: 30 })).map((a) => ({ value: a.enrolment_id, label: a.display_name, sub: [a.programme, a.cohort].filter(Boolean).join(' · ') })), [o.id]);
  const loadSchools = useMemo(() => async (qq) => (await api.get(`/organisations/${o.id}/academy/schools`, { q: qq || undefined, limit: 20 })).schools.map((x) => ({ value: x.id, label: x.name, sub: [x.kind, x.city].filter(Boolean).join(' · ') })), [o.id]);
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('ax.link.title')} submitLabel={t('ax.athletes.link')} color={c.violet}
      fields={[
        { key: 'enrolment_id', label: t('ax.link.enrolment'), type: 'multimenu', max: 1, load: loadAthletes },
        { key: 'school_org_id', label: t('ax.link.school'), type: 'multimenu', max: 1, load: loadSchools, hint: t('ax.link.school_hint') },
        { key: 'provision', label: t('ax.link.provision'), type: 'chips', options: opts(['partner_school', 'on_site', 'online', 'tutoring_provider'], 'ax.prov') },
        { key: 'year_group', label: t('ax.link.year'), optional: true },
        { key: 'student_ref', label: t('ax.link.ref'), hint: t('ax.link.ref_hint'), optional: true },
        { key: 'import_authorised', label: t('ax.link.partner'), type: 'switch' },
      ]}
      onSubmit={async (v) => {
        await api.post(`/academy/enrolments/${v.enrolment_id[0]}/school-links`, { school_org_id: v.school_org_id[0], provision: v.provision, year_group: v.year_group || undefined, student_ref: v.student_ref || undefined, import_authorised: !!v.import_authorised, idempotency_key: key('link') });
        onDone();
      }} />
  );
}

function EditLinkForm({ visible, link, onClose, onDone }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('ax.link.edit')} color={c.violet} initial={{ year_group: link.year_group ?? '', provision: link.provision, import_authorised: link.import_authorised, end_reason: '' }}
      fields={[
        { key: 'year_group', label: t('ax.link.year'), optional: true },
        { key: 'provision', label: t('ax.link.provision'), type: 'chips', options: opts(['partner_school', 'on_site', 'online', 'tutoring_provider'], 'ax.prov') },
        { key: 'import_authorised', label: t('ax.link.partner'), type: 'switch' },
        { key: 'end_reason', label: `${t('ax.link.end')}: ${t('ax.link.end_reason')}`, optional: true },
      ]}
      onSubmit={async (v) => {
        const body = { row_version: link.row_version, year_group: v.year_group || null, provision: v.provision, import_authorised: !!v.import_authorised };
        if (v.end_reason) body.end = { reason: v.end_reason };
        await api.patch(`/academy/school-links/${link.id}`, body);
        onDone(v.end_reason ? t('ax.link.end_done') : t('ax.link.saved'));
      }} />
  );
}

function BlockForm({ visible, link, onClose, onDone, rec }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('ax.block.add')} color={c.violet} initial={{ kind: 'lesson', recurrence: 'once', source: 'manual_verified' }}
      fields={[
        { key: 'kind', label: t('ax.block.kind'), type: 'chips', options: opts(KINDS, 'ax.kind') },
        ...(rec ? [{ key: 'label', label: t('ax.block.label'), hint: t('ax.block.label_hint'), optional: true }] : []),
        { key: 'recurrence', label: t('ax.block.repeat'), type: 'choice', options: [{ value: 'once', label: t('ax.block.once') }, { value: 'weekly', label: t('ax.block.weekly') }] },
        { key: 'starts_at', label: t('ax.block.starts'), type: 'datetime', show: (v) => v.recurrence === 'once' },
        { key: 'ends_at', label: t('ax.block.ends'), type: 'datetime', show: (v) => v.recurrence === 'once' },
        { key: 'weekday_list', label: t('ax.block.day'), type: 'weekdays', show: (v) => v.recurrence === 'weekly' },
        { key: 'start_time', label: t('ax.block.from_time'), type: 'time', show: (v) => v.recurrence === 'weekly' },
        { key: 'end_time', label: t('ax.block.to_time'), type: 'time', show: (v) => v.recurrence === 'weekly' },
        { key: 'valid_from', label: t('ax.block.term'), type: 'daterange', toKey: 'valid_to', show: (v) => v.recurrence === 'weekly' },
        { key: 'source', label: t('ax.block.source'), type: 'chips', options: opts(SRC, 'ax.src') },
        { key: 'source_ref', label: t('ax.block.ref'), hint: t('ax.block.ref_hint') },
      ]}
      onSubmit={async (v) => {
        const base = { kind: v.kind, label: v.label || undefined, recurrence: v.recurrence, source: v.source, source_ref: v.source_ref, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
        if (v.recurrence === 'once') onDone(await api.post(`/academy/school-links/${link.id}/blocks`, { ...base, starts_at: v.starts_at, ends_at: v.ends_at }));
        else {
          let last;
          for (const wd of v.weekday_list) last = await api.post(`/academy/school-links/${link.id}/blocks`, { ...base, weekday: wd, start_time: v.start_time, end_time: v.end_time, valid_from: v.valid_from, valid_to: v.valid_to });
          onDone(last);
        }
      }} />
  );
}

function AttendanceForm({ visible, link, onClose, onDone }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('ax.att.record')} color={c.violet} initial={{ source: 'manual_verified', present: 0, authorised_absence: 0, unauthorised_absence: 0, late: 0, sessions_possible: 20 }}
      fields={[
        { key: 'period_from', label: t('ax.att.period'), type: 'daterange', toKey: 'period_to' },
        { key: 'sessions_possible', label: t('ax.att.possible'), type: 'stepper', min: 1, max: 500 },
        { key: 'present', label: t('ax.att.present'), type: 'stepper', min: 0, max: 500 },
        { key: 'authorised_absence', label: t('ax.att.authorised'), type: 'stepper', min: 0, max: 500 },
        { key: 'unauthorised_absence', label: t('ax.att.unauthorised'), type: 'stepper', min: 0, max: 500 },
        { key: 'late', label: t('ax.att.late'), type: 'stepper', min: 0, max: 500 },
        { key: 'source', label: t('ax.block.source'), type: 'chips', options: opts(SRC, 'ax.src') },
        { key: 'source_ref', label: t('ax.block.ref'), hint: t('ax.block.ref_hint') },
      ]}
      onSubmit={async (v) => { await api.post(`/academy/school-links/${link.id}/attendance`, { period_from: v.period_from, period_to: v.period_to || v.period_from, sessions_possible: v.sessions_possible, present: v.present, authorised_absence: v.authorised_absence, unauthorised_absence: v.unauthorised_absence, late: v.late, source: v.source, source_ref: v.source_ref }); onDone(); }} />
  );
}

function SnapshotForm({ visible, link, o, previous, onClose, onDone }) {
  const fw = useLoad(() => (visible ? api.get(`/organisations/${o.id}/academy/academics/frameworks`) : Promise.resolve(null)), [o.id, visible]);
  const frameworks = fw.data?.frameworks ?? [];
  const blank = () => ({ term_label: '', from: '', to: '', framework_id: '', standing: 'on_track', visibility: 'athlete_guardian', source: 'school_report', source_ref: '', source_date: iso(new Date()), comment: '' });
  const [v, setV] = useState(blank), [rows, setRows] = useState([{ subject: '', grade: '' }]), [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setV(blank()); setRows([{ subject: '', grade: '' }]); setErr(null); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, x) => setV((p) => ({ ...p, [k]: x }));
  const fid = v.framework_id || frameworks[0]?.id, f = frameworks.find((x) => x.id === fid);
  const grades = f?.scale?.grades?.map((g) => ({ value: g, label: g }));
  const subjectLabel = (i) => `${t('ax.prog.subject')} ${i + 1}`;
  const setRow = (i, k, x) => setRows((p) => p.map((r, j) => (j === i ? { ...r, [k]: x } : r)));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const entries = rows.filter((r) => r.subject.trim() && r.grade);
      if (!f) throw new Error(t('ax.prog.no_framework'));
      await api.post(`/academy/school-links/${link.id}/snapshots`, { term_label: v.term_label, period_from: v.from, period_to: v.to || v.from, framework_id: f.id, entries: entries.map((r) => ({ subject: r.subject.trim(), grade: r.grade })), comment: v.comment || undefined, standing: v.standing, visibility: v.visibility, source: v.source, source_ref: v.source_ref, source_date: v.source_date, idempotency_key: key('snap') });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('ax.prog.add')} footer={<Btn title={t('ax.prog.add')} color={c.violet} loading={busy} onPress={save} disabled={!f} />}>
      <View style={{ gap: 12 }}>
        {fw.data && !frameworks.length ? <T size={13} color={c.orange}>{t('ax.prog.no_framework')}</T> : null}
        <Field label={t('ax.prog.term')} value={v.term_label} onChangeText={(x) => set('term_label', x)} />
        <DateRangeField label={t('ax.prog.period')} from={v.from} to={v.to} onChange={(a, b) => { set('from', a); set('to', b); }} />
        <MenuField label={t('ax.prog.framework')} value={fid ?? ''} onChange={(x) => set('framework_id', x)} options={frameworks.map((x) => ({ value: x.id, label: x.name }))} />
        <T weight="800" size={13}>{t('ax.prog.entries')}</T>
        {previous.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{previous.filter((p) => !rows.some((r) => r.subject === p)).map((p) => <Chip key={p} label={`+ ${p}`} onPress={() => setRows((r) => [...r.filter((x) => x.subject || x.grade), { subject: p, grade: '' }])} />)}</View> : null}
        {rows.map((r, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <View style={{ flex: 2 }}><Field label={subjectLabel(i)} value={r.subject} onChangeText={(x) => setRow(i, 'subject', x)} /></View>
            <View style={{ flex: 1 }}>{grades ? <MenuField label={t('ax.prog.grade')} value={r.grade} onChange={(x) => setRow(i, 'grade', x)} options={grades} /> : <Field label={t('ax.prog.grade')} value={r.grade} onChangeText={(x) => setRow(i, 'grade', x)} keyboardType="decimal-pad" />}</View>
          </View>
        ))}
        {rows.length < 20 ? <Btn small title={t('ax.prog.add_subject')} color={c.paper} ink={c.ink} onPress={() => setRows((r) => [...r, { subject: '', grade: '' }])} /> : null}
        <T weight="800" size={13}>{t('ax.prog.standing')}</T>
        <Seg value={v.standing} onChange={(x) => set('standing', x)} options={opts(['on_track', 'watch', 'concern'], 'ax.prog.standing')} />
        <Field label={t('ax.prog.comment')} value={v.comment} onChangeText={(x) => set('comment', x)} multiline />
        <T weight="800" size={13}>{t('ax.prog.visibility')}</T>
        <Seg value={v.visibility} onChange={(x) => set('visibility', x)} options={opts(['athlete_guardian', 'education_staff'], 'ax.prog.vis')} />
        <T weight="800" size={13}>{t('ax.prog.source')}</T>
        <Seg value={v.source} onChange={(x) => set('source', x)} options={opts(['school_report', 'manual_verified', 'partner_import'], 'ax.src')} />
        <Field label={t('ax.prog.source_ref')} value={v.source_ref} onChangeText={(x) => set('source_ref', x)} />
        <DateField label={t('ax.prog.source_date')} value={v.source_date} onChange={(x) => set('source_date', x)} />
        {err ? <T size={13} color={c.orange}>{err}</T> : null}
      </View>
    </Sheet>
  );
}

function TaskForm({ visible, o, athleteId, linkId, onClose, onDone }) {
  const members = useLoad(() => (visible ? api.get(`/organisations/${o.id}/members`).catch(() => []) : Promise.resolve(null)), [o.id, visible]);
  const people = (members.data ?? []).map((m) => ({ value: m.id, label: m.display_name, sub: m.org_role }));
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('ax.tasks.new')} color={c.violet} initial={{ kind: 'coach_school_liaison', audience: 'coach', priority: 'normal' }}
      fields={[
        { key: 'kind', label: t('ax.tasks.kind'), type: 'chips', options: opts(TKINDS, 'ax.tk') },
        { key: 'audience', label: t('ax.tasks.audience'), type: 'chips', options: opts(AUDS, 'ax.aud') },
        { key: 'title', label: t('ax.tasks.title_f') },
        { key: 'note', label: t('ax.tasks.note'), hint: t('ax.tasks.note_hint'), type: 'multiline', optional: true },
        { key: 'assignee_id', label: t('ax.tasks.assignee'), type: 'multimenu', max: 1, options: people, optional: true },
        { key: 'due_on', label: t('ax.tasks.due'), type: 'date', optional: true },
        { key: 'priority', label: t('ax.tasks.priority'), type: 'choice', options: opts(['low', 'normal', 'high'], 'ax.pri') },
      ]}
      onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/academic-tasks`, { athlete_id: athleteId, link_id: linkId, kind: v.kind, audience: v.audience, title: v.title, note: v.note || undefined, assignee_id: Array.isArray(v.assignee_id) ? v.assignee_id[0] : v.assignee_id, due_on: v.due_on || undefined, priority: v.priority, idempotency_key: key('task') }); onDone(); }} />
  );
}

// ------------------------------------------------------------------ school timetable
function Timetable({ o }) {
  const [days, setDays] = useState('14'), [school, setSchool] = useState('');
  const from = iso(new Date()), to = plus(Number(days));
  const tt = useLoad(() => api.get(`/organisations/${o.id}/academy/school-blocks`, { from, to }), [o.id, days]);
  const sch = useLoad(() => api.get(`/organisations/${o.id}/academy/school-links`, { limit: 100 }), [o.id]);
  const schools = [{ value: '', label: t('ax.tt.all_schools') }, ...[...new Map((sch.data?.links ?? []).map((l) => [l.school.id, l.school.name]))].map(([value, label]) => ({ value, label }))];
  const ids = new Set((sch.data?.links ?? []).filter((l) => !school || l.school.id === school).map((l) => l.id));
  const items = (tt.data?.items ?? []).filter((b) => !school || ids.has(b.link_id));
  const byDay = items.reduce((m, b) => { const k = b.starts_at.slice(0, 10); (m[k] = m[k] ?? []).push(b); return m; }, {});
  return (
    <Panel>
      <Block title={t('ax.tt.title')}>
        <T size={12} color={c.mute}>{t('ax.tt.help')}</T>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 220 }}><MenuField label={t('ax.tt.school')} value={school} onChange={setSchool} options={schools} /></View>
          <View style={{ flex: 1, minWidth: 220 }}><MenuField label={t('ax.tt.window')} value={days} onChange={setDays} options={[{ value: '14', label: t('ax.tt.days14') }, { value: '30', label: t('ax.tt.days30') }]} /></View>
        </View>
        {tt.error ? <ErrorBox error={tt.error} onRetry={tt.reload} /> : !tt.data ? <Loading /> : items.length ? Object.keys(byDay).sort().map((dKey) => (
          <View key={dKey} style={{ gap: 6 }}>
            <T weight="800" size={13} color={c.mute}>{when(dKey)}</T>
            {byDay[dKey].map((b) => <Row key={`${b.block_id}${b.starts_at}`} title={`${b.athlete_name} · ${kindLabel(b.kind)}${b.label ? ` · ${b.label}` : ''}`} sub={`${hm(b.starts_at)} – ${hm(b.ends_at)}`} right={<Source s={b.source} />} />)}
          </View>
        )) : <Empty emoji="🏫" title={t('ax.tt.title')} sub={t('ax.tt.empty')} />}
      </Block>
    </Panel>
  );
}

// ------------------------------------------------------------------ tasks
function Tasks({ o, toast, archived, reload }) {
  const [status, setStatus] = useState('active'), [mine, setMine] = useState(false), [form, setForm] = useState(false);
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/academic-tasks`, { status, mine: mine ? 'true' : undefined, limit: 100 }), [o.id, status, mine]);
  const links = useLoad(() => api.get(`/organisations/${o.id}/academy/school-links`, { limit: 100 }), [o.id]);
  const move = async (k, s) => { try { await api.patch(`/academy/academic-tasks/${k.id}`, { row_version: k.row_version, status: s }); toast(t('ax.tasks.updated')); list.reload(); reload(); } catch (e) { toast(e.message); } };
  const athletes = (links.data?.links ?? []).map((l) => ({ value: l.athlete_id, label: l.athlete_name, sub: l.school.name }));
  return (
    <Panel>
      <Block title={t('ax.tasks.title')} right={!archived ? <Btn small title={t('ax.tasks.new')} onPress={() => setForm(true)} /> : undefined}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Seg value={status} onChange={setStatus} options={[{ value: 'active', label: t('ax.tasks.active') }, { value: 'done', label: t('ax.tasks.done') }]} />
          <Chip label={t('ax.tasks.mine')} active={mine} onPress={() => setMine(!mine)} />
        </View>
        {list.data?.scope === 'assigned_to_me' ? <T size={12} color={c.mute}>{t('ax.tasks.scope_mine')}</T> : null}
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.tasks.length ? list.data.tasks.map((k) => (
          <View key={k.id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 6 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" size={14} style={{ flex: 1 }}>{k.title}</T>{k.overdue ? <Tag label={t('ax.tasks.overdue')} color={c.orangeSoft} /> : null}<Tag label={t(`ax.pri.${k.priority}`)} /></View>
            <T size={12} color={c.mute}>{k.athlete_name} · {t(`ax.tk.${k.kind}`)} · {t(`ax.aud.${k.audience}`)}{k.due_on ? ` · ${when(k.due_on)}` : ''}{k.assignee_name ? ` · ${k.assignee_name}` : ''}</T>
            {k.note ? <T size={12}>{k.note}</T> : null}
            {!archived && ['open', 'in_progress'].includes(k.status) ? <View style={{ flexDirection: 'row', gap: 8 }}>{k.status === 'open' ? <Btn small title={t('ax.tasks.start')} color={c.paper} ink={c.ink} onPress={() => move(k, 'in_progress')} /> : null}<Btn small title={t('ax.tasks.finish')} onPress={() => move(k, 'done')} /></View> : null}
          </View>
        )) : <Empty emoji="🤝" title={t('ax.tasks.empty_t')} sub={t('ax.tasks.empty_s')} />}
      </Block>
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('ax.tasks.new')} color={c.violet} initial={{ kind: 'coach_school_liaison', audience: 'coach', priority: 'normal' }}
        fields={[
          { key: 'athlete_id', label: t('ax.tasks.athlete'), type: 'multimenu', max: 1, options: athletes },
          { key: 'kind', label: t('ax.tasks.kind'), type: 'chips', options: opts(TKINDS, 'ax.tk') },
          { key: 'audience', label: t('ax.tasks.audience'), type: 'chips', options: opts(AUDS, 'ax.aud') },
          { key: 'title', label: t('ax.tasks.title_f') },
          { key: 'note', label: t('ax.tasks.note'), hint: t('ax.tasks.note_hint'), type: 'multiline', optional: true },
          { key: 'due_on', label: t('ax.tasks.due'), type: 'date', optional: true },
          { key: 'priority', label: t('ax.tasks.priority'), type: 'choice', options: opts(['low', 'normal', 'high'], 'ax.pri') },
        ]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/academic-tasks`, { athlete_id: Array.isArray(v.athlete_id) ? v.athlete_id[0] : v.athlete_id, kind: v.kind, audience: v.audience, title: v.title, note: v.note || undefined, due_on: v.due_on || undefined, priority: v.priority, idempotency_key: key('task') }); setForm(false); toast(t('ax.tasks.saved')); list.reload(); reload(); }} />
    </Panel>
  );
}

// ------------------------------------------------------------------ rules, grading scales, import
function Setup({ o, toast, archived, data: x, reload, rec, owner }) {
  const fw = useLoad(() => api.get(`/organisations/${o.id}/academy/academics/frameworks`), [o.id]);
  const [rules, setRules] = useState(false), [imp, setImp] = useState(false);
  const usePreset = async (p) => { try { await api.post(`/organisations/${o.id}/academy/academics/frameworks`, { key: p.key, name: p.name, kind: p.kind, scale: p.scale, pass_mark: p.pass_mark }); toast(t('ax.fw.saved')); fw.reload(); } catch (e) { toast(e.message); } };
  const s = x.settings;
  return (
    <View style={{ gap: 14 }}>
      <Panel>
        <Block title={t('ax.setup.rules')} right={owner && !archived ? <Btn small title={t('ax.link.edit')} color={c.paper} ink={c.ink} onPress={() => setRules(true)} /> : undefined}>
          <T size={12} color={c.mute}>{owner ? t('ax.setup.rules_help') : t('ax.setup.owner_only')}</T>
          <Fact k={t('ax.setup.threshold')} v={`${s.attendance_threshold_pct}%`} /><Fact k={t('ax.setup.unauth')} v={String(s.unauthorised_limit)} /><Fact k={t('ax.setup.buffer')} v={String(s.exam_buffer_min)} /><Fact k={t('ax.setup.cadence')} v={String(s.snapshot_cadence_days)} />
        </Block>
        <FormSheet visible={rules} onClose={() => setRules(false)} title={t('ax.setup.rules')} color={c.violet} initial={s}
          fields={[
            { key: 'attendance_threshold_pct', label: t('ax.setup.threshold'), type: 'stepper', min: 50, max: 100, suffix: '%' },
            { key: 'unauthorised_limit', label: t('ax.setup.unauth'), type: 'stepper', min: 0, max: 60 },
            { key: 'exam_buffer_min', label: t('ax.setup.buffer'), type: 'stepper', min: 0, max: 720, step: 15 },
            { key: 'snapshot_cadence_days', label: t('ax.setup.cadence'), type: 'stepper', min: 7, max: 400, step: 7 },
          ]}
          onSubmit={async (v) => { await api.patch(`/organisations/${o.id}/academy/academics/settings`, v); setRules(false); toast(t('ax.setup.saved')); reload(); }} />
      </Panel>
      <Panel>
        <Block title={t('ax.fw.title')}>
          {!rec ? <T size={12} color={c.mute}>{t('ax.fw.locked')}</T> : null}
          {fw.data?.frameworks?.length ? fw.data.frameworks.map((f) => <Row key={f.id} title={f.name} sub={`${f.kind} · ${t('ax.fw.version', { n: f.version })}`} />) : <T size={13} color={c.mute}>{t('ax.fw.empty')}</T>}
          {rec && !archived ? (
            <>
              <T weight="800" size={13}>{t('ax.fw.presets')}</T>
              {(fw.data?.presets ?? []).map((p) => <Row key={p.key} title={p.name} sub={p.kind === 'letter' || p.kind === 'band' ? p.scale.grades.join(' · ') : `${p.scale.min}–${p.scale.max}`} right={<Btn small title={t('ax.fw.use')} onPress={() => usePreset(p)} />} />)}
            </>
          ) : null}
        </Block>
      </Panel>
      <Panel>
        <Block title={t('ax.imp.title')} right={!archived ? <Btn small title={t('ax.imp.preview')} onPress={() => setImp(true)} /> : undefined}>
          <T size={12} color={c.mute}>{t('ax.imp.help')}</T>
        </Block>
        <ImportSheet visible={imp} o={o} onClose={() => setImp(false)} toast={toast} onDone={reload} />
      </Panel>
      <Panel>
        <Block title={t('ax.api.title')}>
          <T size={12} color={c.mute}>{t('ax.api.help')}</T>
          <Tag label={t('ax.api.endpoint', { school: ':id' })} />
        </Block>
      </Panel>
    </View>
  );
}

const parseCsv = (text) => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (l) => l.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
};
const num = (v) => (v === undefined || v === '' ? 0 : Number(v));

function ImportSheet({ visible, o, onClose, toast, onDone }) {
  const [kind, setKind] = useState('attendance'), [csv, setCsv] = useState(''), [res, setRes] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setCsv(''); setRes(null); } }, [visible]);
  const body = (mode) => ({
    mode, idempotency_key: `imp-${kind}-${csv.length}-${csv.slice(0, 24).replace(/\W/g, '')}`,
    rows: parseCsv(csv).map((r) => (kind === 'attendance'
      ? { type: 'attendance', student_ref: r.student_ref, attendance: { period_from: r.period_from, period_to: r.period_to, sessions_possible: num(r.sessions_possible), present: num(r.present), authorised_absence: num(r.authorised_absence), unauthorised_absence: num(r.unauthorised_absence), late: num(r.late), source: 'manual_verified', source_ref: r.source_ref || 'CSV import' } }
      : { type: 'block', student_ref: r.student_ref, block: { kind: r.kind || 'lesson', recurrence: 'once', starts_at: r.starts_at, ends_at: r.ends_at, label: r.label || undefined, source: 'manual_verified', source_ref: r.source_ref || 'CSV import' } })),
  });
  const run = async (mode) => {
    if (!parseCsv(csv).length) { toast(t('ax.imp.empty')); return; }
    setBusy(true);
    try { const r = await api.post(`/organisations/${o.id}/academy/school-records/import`, body(mode)); setRes(r); if (mode === 'commit') { toast(t('ax.imp.saved', { n: r.accepted })); onDone(); onClose(); } }
    catch (e) { setRes(e.details?.results ? { results: e.details.results, rows: e.details.results.length, accepted: e.details.results.filter((x) => x.ok).length } : null); toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('ax.imp.title')} footer={<View style={{ flexDirection: 'row', gap: 8 }}><Btn title={t('ax.imp.preview')} color={c.paper} ink={c.ink} loading={busy} onPress={() => run('preview')} /><Btn title={t('ax.imp.commit')} color={c.violet} loading={busy} disabled={!res || res.rows !== res.accepted} onPress={() => run('commit')} /></View>}>
      <View style={{ gap: 10 }}>
        <T size={12} color={c.mute}>{t('ax.imp.help')}</T>
        <T weight="800" size={13}>{t('ax.imp.type')}</T>
        <Seg value={kind} onChange={(v) => { setKind(v); setRes(null); }} options={[{ value: 'attendance', label: t('ax.imp.attendance') }, { value: 'blocks', label: t('ax.imp.blocks') }]} />
        <T size={12} color={c.mute}>{kind === 'attendance' ? t('ax.imp.cols_attendance') : t('ax.imp.cols_blocks')}</T>
        <Field label={t('ax.imp.csv')} value={csv} onChangeText={(v) => { setCsv(v); setRes(null); }} multiline minHeight={140} />
        {res ? <View style={{ gap: 4 }}><T weight="800">{t('ax.imp.result', { ok: res.accepted, n: res.rows })}</T>{(res.results ?? []).filter((r) => !r.ok).slice(0, 10).map((r) => <T key={r.row} size={12} color={c.orange}>{t('ax.imp.row_err', { row: r.row, msg: r.error })}</T>)}</View> : null}
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ the athlete / guardian side
const WHAT = { schedule: 'ax.share.schedule', progress: 'ax.share.progress' };

/** "School & studies" for the athlete (or a guardian, per child): consent controls, school and sport kept apart with sources, attendance and the family's progress reports. */
export function SchoolStudies({ athleteId, name, toast }) {
  const d = useLoad(() => api.get('/me/academy/academics', { child_id: athleteId || undefined }), [athleteId]);
  const [ask, setAsk] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  const setShare = async (l, level, enabled) => {
    try { await api.post('/me/academy/academics/share', { organisation_id: l.academy.id, athlete_id: x.athlete_id, level, enabled }); toast(t('ax.me.updated')); d.reload(); }
    catch (e) { if (e.details?.code === 'guardian_consent_required') setAsk({ l, level }); else toast(e.message); }
  };
  const allow = async () => { try { await api.post(`/youth/children/${x.athlete_id}/consents`, { purpose: 'academic' }); const a = ask; setAsk(null); await setShare(a.l, a.level, true); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}><T size={20} weight="800" accessibilityRole="header">{t('ax.me.title')}{name ? ` · ${t('ax.me.for', { name })}` : ''}</T><T size={13} color={c.mute}>{t('ax.me.intro')}</T></View>
      {x.links.length ? x.links.map((l) => (
        <Panel key={l.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="800" size={16} style={{ flex: 1 }}>{l.school.name}</T><Tag label={l.academy.name} /></View>
          <T size={12} color={c.mute}>{[l.year_group, t(`ax.prov.${l.provision}`)].filter(Boolean).join(' · ')}</T>
          {l.status === 'ended' ? <T size={13} color={c.mute}>{t('ax.me.ended')}</T> : (
            <>
              <View style={{ gap: 8 }}>
                {['schedule', 'progress'].map((lv) => (
                  <View key={lv} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Shared on={l.shared[lv]} label={t(WHAT[lv])} />
                    <Btn small title={l.shared[lv] ? t('ax.me.withdraw', { what: t(WHAT[lv]) }) : t('ax.me.allow', { what: t(WHAT[lv]) })} color={l.shared[lv] ? c.paper : c.pink} ink={l.shared[lv] ? c.ink : '#fff'} onPress={() => setShare(l, lv, !l.shared[lv])} />
                  </View>
                ))}
                <T size={12} color={c.mute}>{t('ax.share.explain')}</T>
              </View>
              <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                <View style={{ flex: 1, minWidth: 240, gap: 6 }}>
                  <T weight="800" size={13}>{t('ax.me.school_col')} · {t('ax.me.window', { days: 14 })}</T>
                  {l.shared.schedule ? (l.school_timetable.length ? l.school_timetable.slice(0, 12).map((b) => <Row key={`${b.block_id}${b.starts_at}`} title={`${kindLabel(b.kind)}${b.label ? ` · ${b.label}` : ''}`} sub={`${at(b.starts_at)} – ${hm(b.ends_at)}`} right={<Source s={b.source} />} />) : <T size={13} color={c.mute}>{t('ax.me.nothing')}</T>) : <T size={13} color={c.mute}>{t('ax.share.off')}</T>}
                </View>
                <View style={{ flex: 1, minWidth: 240, gap: 6 }}>
                  <T weight="800" size={13}>{t('ax.me.sport_col')} · {t('ax.me.window', { days: 14 })}</T>
                  {l.sport_timetable.length ? l.sport_timetable.slice(0, 12).map((s) => <Row key={s.id} title={s.title} sub={`${at(s.starts_at)} – ${hm(s.ends_at)}`} right={<Tag label={s.source_label} />} />) : <T size={13} color={c.mute}>{t('ax.me.nothing')}</T>}
                </View>
              </View>
              {l.clashes.map((cl) => <Tag key={`${cl.session_id}${cl.kind}`} label={t('ax.me.clash', { msg: `${cl.message} · ${at(cl.starts_at)}` })} color={c.orangeSoft} />)}
              {l.shared.schedule && l.attendance.length ? (
                <View style={{ gap: 6 }}>
                  <T weight="800" size={13}>{t('ax.me.attendance')}</T>
                  {l.attendance.map((a) => <View key={`${a.period_from}${a.period_to}`} style={{ gap: 4 }}><Bars label={t('ax.me.attendance')} rows={[{ label: `${when(a.period_from)} – ${when(a.period_to)}`, value: a.percent, text: `${a.percent}%` }]} /><Source s={a.source} ref={a.source_ref} /></View>)}
                </View>
              ) : null}
              {l.shared.progress ? (
                <View style={{ gap: 6 }}>
                  <T weight="800" size={13}>{t('ax.me.grades')}</T>
                  <T size={12} color={c.mute}>{t('ax.me.grades_only')}</T>
                  {l.snapshots.length ? l.snapshots.map((s) => <Snapshot key={s.id} s={{ ...s, restricted: false, visibility: 'athlete_guardian' }} />) : <T size={13} color={c.mute}>{t('ax.me.no_grades')}</T>}
                </View>
              ) : null}
            </>
          )}
        </Panel>
      )) : <Empty emoji="🏫" title={t('ax.me.empty_t')} sub={t('ax.me.empty_s')} />}
      <T size={12} color={c.mute}>{t('ax.priv.body')}</T>
      <FormSheet visible={!!ask} onClose={() => setAsk(null)} title={t('ax.me.title')} color={c.violet} fields={[]} notice={t('ax.me.consent_needed')} submitLabel={t('ax.me.consent_go')} onSubmit={allow} />
    </View>
  );
}
