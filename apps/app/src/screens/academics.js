// Academics & school integration (#783): the academy's Academics module (overview, athletes and their school files, the school calendar and clash
// planner, coordination tasks, attainment frameworks, imports), the school's own desk, and the athlete / guardian sharing centre. Only calls the
// capabilities in academy-academics.js / academy-attainment.js: the server decides what each person may see; this screen shows what it is given and
// hides what a role cannot use. Sport and academic progress are always separate, source-labelled blocks.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { useLayout } from '../layout';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../menu-field';
import { DateField } from '../pickers';
import { Bars, Block, Kpi, Meter, Split, when } from './academy-ui';
import { t } from '../i18n';

const today = () => new Date().toISOString().slice(0, 10);
/** Join the parts that exist with a space (labels built from icons, names and numbers). */
const cat = (...parts) => parts.filter((x) => x !== undefined && x !== null && x !== '').join(' ');
const vTag = (n) => ['v', n].join('');
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null));
const Panel = ({ children, style }) => <View style={[{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }, style]}>{children}</View>;
const BAND = { on_track: [t('ac.band.on_track'), c.limeSoft], watch: [t('ac.band.watch'), c.sunSoft], support_needed: [t('ac.band.support_needed'), c.orangeSoft] };
const BandTag = ({ band }) => (band ? <Tag label={BAND[band][0]} color={BAND[band][1]} /> : null);
const CONSENT = { active: [t('ac.consent.active'), c.limeSoft], expiring: [t('ac.consent.expiring'), c.sunSoft], not_granted: [t('ac.consent.not_granted'), c.violetSoft] };
const KIND = { class_block: ['🏫', t('ac.kind.class_block')], exam: ['📝', t('ac.kind.exam')], tutoring: ['👩‍🏫', t('ac.kind.tutoring')], school_event: ['🎒', t('ac.kind.school_event')], holiday: ['🏖️', t('ac.kind.holiday')], deadline: ['⏳', t('ac.kind.deadline')] };
const CURRICULA = [['cbse', 'CBSE'], ['icse', 'ICSE'], ['state_board', t('ac.cur.state_board')], ['ib', 'IB'], ['igcse', 'IGCSE'], ['a_level', 'A-level'], ['us_high_school', t('ac.cur.us')], ['spanish_eso', 'ESO / Bachillerato'], ['other', t('ac.cur.other')]];
const YEARS = ['Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12', 'Year 9', 'Year 10', 'Year 11', 'Year 12', 'Year 13', 'First year', 'Second year', 'Third year'];
const TERMS = ['Term 1', 'Term 2', 'Term 3', 'Semester 1', 'Semester 2', 'Mid-year', 'Mock exams', 'Annual'];
const REASONS = ['clash_with_exam', 'clash_with_class', 'low_attendance', 'unauthorised_absence', 'late_pattern', 'report_overdue', 'needs_support', 'other'];
const REASON_LABEL = { clash_with_exam: t('ac.reason.clash_with_exam'), clash_with_class: t('ac.reason.clash_with_class'), low_attendance: t('ac.reason.low_attendance'), unauthorised_absence: t('ac.reason.unauthorised_absence'), late_pattern: t('ac.reason.late_pattern'), report_overdue: t('ac.reason.report_overdue'), needs_support: t('ac.reason.needs_support'), other: t('ac.reason.other') };
const TASK_KIND = { exam_clash: ['⚠️', t('ac.task.exam_clash')], attendance_exception: ['📉', t('ac.task.attendance_exception')], coach_school_sync: ['🤝', t('ac.task.coach_school_sync')], guardian_meeting: ['👪', t('ac.task.guardian_meeting')], tutoring: ['👩‍🏫', t('ac.task.tutoring')], report_due: ['📄', t('ac.task.report_due')], other: ['📌', t('ac.task.other')] };
const ROLE = { academic_lead: t('ac.role.academic_lead'), coach: t('ac.role.coach'), school_liaison: t('ac.role.school_liaison'), guardian: t('ac.role.guardian') };
const fmtDT = (d) => (d ? new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Local date + time of day in a named time zone -> the UTC instant, as an ISO string. */
export function zonedISO(date, time, tz) {
  const off = (ms) => { const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)); const g = (k) => +f.find((p) => p.type === k).value; return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000; };
  const guess = Date.parse(`${date}T${time.padStart(5, '0')}:00Z`);
  let t = guess - off(guess); t = guess - off(t);
  return new Date(t).toISOString();
}

// ------------------------------------------------------------------------------------------------------------------------ the module
export function Academics({ o, role, archived, toast }) {
  const { tablet } = useLayout();
  const [sec, setSec] = useState('overview');
  const [open, setOpen] = useState(null);   // a link id
  const [sheet, setSheet] = useState(null);
  const links = useLoad(() => api.get(`/organisations/${o.id}/academics/links`, { limit: 100 }).catch((e) => ({ error: e })), [o.id]);
  const ov = useLoad(() => api.get(`/organisations/${o.id}/academics/overview`).catch(() => null), [o.id]);
  const reload = () => { links.reload(); ov.reload(); };
  if (links.loading && !links.data) return <Loading />;
  if (links.data?.error) return <Empty emoji="🔒" title={t('ac.locked')} sub={t('ac.locked_sub')} />;
  const lead = !!ov.data || links.data?.can_manage;
  const P = { o, toast, reload, lead, tablet, setSheet, openLink: setOpen, ov: ov.data, links: links.data, archived };
  const body = sec === 'overview' ? <Overview {...P} go={setSec} /> : sec === 'athletes' ? <Athletes {...P} /> : sec === 'calendar' ? <CalendarPlanner {...P} /> : sec === 'tasks' ? <Tasks {...P} /> : sec === 'framework' ? <Frameworks {...P} /> : <Imports {...P} />;
  return (
    <View style={{ gap: 12 }}>
      <Seg value={sec} onChange={setSec} options={[{ value: 'overview', label: t('ac.sec.overview') }, { value: 'athletes', label: t('ac.sec.athletes') }, { value: 'calendar', label: t('ac.sec.calendar') }, { value: 'tasks', label: t('ac.sec.tasks') }, ...(lead ? [{ value: 'framework', label: t('ac.sec.framework') }, { value: 'imports', label: t('ac.sec.imports') }] : [])]} />
      <Split open={!!open} onClose={() => setOpen(null)} detailTitle={links.data?.items?.find((x) => x.id === open)?.athlete_name ?? ''} list={body} detail={open ? <AthleteFile key={open} {...P} linkId={open} side="academy" /> : null} />
      {sheet?.type === 'link' ? <LinkWizard {...P} onClose={() => setSheet(null)} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ overview
function Overview({ ov, links, lead, setSheet, go, openLink, o, toast, reload }) {
  if (!lead) return <Panel><Empty emoji="🎓" title={t('ac.coach.title')} sub={t('ac.coach.sub')} /></Panel>;
  if (!ov) return <Loading />;
  if (!ov.linked) return (
    <Panel style={{ padding: 22, gap: 12 }}>
      <T size={34}>🎓</T><T size={21} weight="800">{t('ac.empty.title')}</T>
      <T color={c.mute}>{t('ac.empty.body')}</T>
      <Btn title={t('ac.link.cta')} onPress={() => setSheet({ type: 'link' })} style={{ alignSelf: 'flex-start' }} />
    </Panel>
  );
  const scan = async () => { try { const r = await api.post(`/organisations/${o.id}/academics/exceptions/scan`, {}); toast?.(t('ac.scan.done', { n: r.raised })); reload(); } catch (e) { toast?.(e.message); } };
  const bandTotal = Object.values(ov.bands).reduce((a, b) => a + b, 0);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label={t('ac.kpi.linked')} value={`${ov.linked}/${ov.enrolled}`} sub={t('ac.kpi.coverage', { n: ov.coverage_pct ?? 0 })} onPress={() => go('athletes')} />
        <Kpi label={t('ac.kpi.consent')} value={ov.consent.active} sub={ov.consent.missing ? t('ac.kpi.consent_missing', { n: ov.consent.missing }) : t('ac.kpi.consent_all')} tone={ov.consent.missing ? 'alert' : undefined} onPress={() => go('athletes')} />
        <Kpi label={t('ac.kpi.exams')} value={ov.exams_14d} sub={ov.high_stakes_14d ? t('ac.kpi.high', { n: ov.high_stakes_14d }) : t('ac.kpi.none_high')} onPress={() => go('calendar')} />
        <Kpi label={t('ac.kpi.clash')} value={ov.clashing_sessions} sub={t('ac.kpi.clash_sub')} tone={ov.clashing_sessions ? 'alert' : undefined} onPress={() => go('calendar')} />
        <Kpi label={t('ac.kpi.attendance', { n: ov.floor_pct })} value={ov.attendance_below_floor} sub={t('ac.kpi.attendance_sub')} tone={ov.attendance_below_floor ? 'alert' : undefined} onPress={() => go('athletes')} />
        <Kpi label={t('ac.kpi.tasks')} value={ov.tasks.open} sub={ov.tasks.overdue ? t('ac.kpi.overdue', { n: ov.tasks.overdue }) : t('ac.kpi.on_time')} tone={ov.tasks.overdue ? 'alert' : undefined} onPress={() => go('tasks')} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        <Panel style={{ flex: 1, minWidth: 300 }}>
          <Block title={t('ac.clash.title')} right={<Btn small title={t('ac.scan')} color={c.paper} ink={c.ink} onPress={scan} />}>
            {ov.clash_sessions.length ? ov.clash_sessions.map((s) => (
              <View key={s.session_id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.orangeSoft, gap: 2 }}>
                <T weight="800">{s.title} · {fmtDT(s.starts_at)}</T>
                {s.clashes.map((x, n) => <T key={n} size={13}>{x.message}</T>)}
              </View>
            )) : <Empty emoji="✅" title={t('ac.clash.none')} sub={t('ac.clash.none_sub')} />}
          </Block>
        </Panel>
        <Panel style={{ flex: 1, minWidth: 280 }}>
          <Block title={t('ac.bands.title')}>
            <Bars label={t('ac.bands.title')} rows={['on_track', 'watch', 'support_needed'].map((b) => ({ label: BAND[b][0], value: ov.bands[b], text: String(ov.bands[b]) }))} />
            <T size={12} color={c.mute}>{bandTotal ? t('ac.bands.note') : t('ac.bands.empty')}</T>
          </Block>
          <Block title={t('ac.schools.title')}>
            {ov.schools.map((s) => <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{s.name}</T>{s.verified ? <Tag label={t('ac.verified')} color={c.limeSoft} /> : <Tag label={t('ac.unverified')} color={c.sunSoft} />}<T weight="800">{s.athletes}</T></View>)}
          </Block>
        </Panel>
      </View>
      <Btn title={t('ac.link.cta')} color={c.paper} ink={c.ink} onPress={() => setSheet({ type: 'link' })} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ roster
function Athletes({ links, openLink, setSheet, lead }) {
  const [state, setState] = useState('');
  const [school, setSchool] = useState('');
  if (!links) return <Loading />;
  const schools = [...new Map(links.items.map((l) => [l.school.id, l.school.name])).entries()];
  const rows = links.items.filter((l) => (!state || l.consent.state === state) && (!school || l.school.id === school));
  return (
    <Panel>
      <Block title={t('ac.ath.title')} right={lead ? <Btn small title={t('ac.link.cta')} onPress={() => setSheet({ type: 'link' })} /> : null}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <View style={{ flex: 1, minWidth: 150 }}><MenuField label={t('ac.f.school')} value={school} onChange={setSchool} options={[{ value: '', label: t('ac.f.all') }, ...schools.map(([v, label]) => ({ value: v, label }))]} /></View>
          <View style={{ flex: 1, minWidth: 150 }}><MenuField label={t('ac.f.sharing')} value={state} onChange={setState} options={[{ value: '', label: t('ac.f.all') }, { value: 'active', label: CONSENT.active[0] }, { value: 'expiring', label: CONSENT.expiring[0] }, { value: 'not_granted', label: CONSENT.not_granted[0] }]} /></View>
        </View>
        {rows.length ? rows.map((l) => (
          <Pressable key={l.id} onPress={() => openLink(l.id)} accessibilityRole="button" accessibilityLabel={[l.athlete_name, l.school.name].join(', ')} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 6, minHeight: 64 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <T weight="800" style={{ flex: 1 }}>{l.athlete_name}</T>
              <Tag label={CONSENT[l.consent.state][0]} color={CONSENT[l.consent.state][1]} />
              <BandTag band={l.band} />
            </View>
            <T size={12} color={c.mute}>{l.school.name}{l.school.verified ? '' : ` · ${t('ac.unverified')}`}{l.year_group ? ` · ${l.year_group}` : ''}{l.curriculum ? ` · ${l.curriculum.toUpperCase()}` : ''}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {l.attendance ? <Tag label={l.attendance.pct != null ? `${t('ac.att')} ${l.attendance.pct}%` : l.attendance.below_floor ? t('ac.att_low') : t('ac.att_ok')} color={l.attendance.below_floor || (l.attendance.pct != null && l.attendance.pct < links.floor_pct) ? c.orangeSoft : c.paper} /> : null}
              {l.next_exam ? <Tag label={cat('📝', t('ac.next_exam'), when(l.next_exam))} color={c.paper} /> : null}
              {l.open_tasks ? <Tag label={cat('📌', l.open_tasks)} color={c.sunSoft} /> : null}
            </View>
          </Pressable>
        )) : <Empty emoji="🎓" title={t('ac.ath.empty')} sub={t('ac.ath.empty_sub')} />}
      </Block>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ one athlete: sport and academic progress, separately
export function AthleteFile({ o, linkId, side = 'academy', toast, reload, archived }) {
  const [tab, setTab] = useState('timetable');
  const [sheet, setSheet] = useState(null);
  const prog = useLoad(() => api.get(`/academics/links/${linkId}/progress`), [linkId]);
  const [bump, setBump] = useState(0);
  const sport = useLoad(() => (side === 'academy' && prog.data?.link ? api.get(`/organisations/${o.id}/academy/athletes/${prog.data.link.athlete_id}/360`).catch(() => null) : Promise.resolve(null)), [prog.data?.link?.athlete_id]);
  if (prog.error) return <ErrorBox error={prog.error} onRetry={prog.reload} />;
  if (!prog.data) return <Loading />;
  const p = prog.data, v = p.view, again = () => { prog.reload(); setBump(bump + 1); reload?.(); };
  const rec = side === 'school' || (side === 'academy' && (v.timetable !== 'none' || v.attendance !== 'none' || v.attainment !== 'none'));
  const sp = sport.data?.sections;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Tag label={cat('🏫', p.link.school.name)} color={c.paper} />{p.link.school.verified ? <Tag label={t('ac.verified')} color={c.limeSoft} /> : <Tag label={t('ac.unverified')} color={c.sunSoft} />}
        {p.link.year_group ? <Tag label={p.link.year_group} color={c.paper} /> : null}{p.link.curriculum ? <Tag label={p.link.curriculum.toUpperCase()} color={c.paper} /> : null}
      </View>
      {p.consent ? <T size={12} color={c.mute}>{t('ac.shared_with_you', { scopes: p.consent.scopes.join(', '), detail: p.consent.detail === 'detail' ? t('ac.detail') : t('ac.summary'), date: when(p.consent.expires_on) })}</T> : side === 'academy' ? <T size={12} color={c.orange}>{t('ac.not_shared')}</T> : null}
      {side === 'academy' && !p.consent ? <RequestConsent linkId={linkId} toast={toast} /> : null}

      <View style={{ gap: 10 }}>
        {side === 'academy' ? (
        <Panel style={{ backgroundColor: c.cyanSoft, borderColor: c.cyan }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{t('ac.sport.head').toUpperCase()}</T>
          {sp?.pathway?.access === 'ok' && sp.pathway.data?.length ? sp.pathway.data.map((x) => <View key={x.pathway_id} style={{ gap: 2 }}><T weight="800">{x.pathway}</T><T size={13}>{t('ac.sport.level')}: {x.level ?? '–'} · {x.decision}</T></View>)
              : <T size={13} color={c.mute}>{t('ac.sport.none')}</T>}
          {sp?.attendance?.access === 'ok' && sp.attendance.data?.pct != null ? <T size={13}>{t('ac.sport.att')}: {sp.attendance.data.pct}%</T> : null}
          <T size={11} color={c.mute}>{t('ac.source')}: {t('ac.sport.source')}</T>
        </Panel>
        ) : null}
        <Panel style={{ backgroundColor: c.violetSoft, borderColor: c.pink }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{t('ac.acad.head').toUpperCase()}</T>
          {v.attainment === 'none' ? <T size={13} color={c.mute}>{t('ac.acad.hidden')}</T> : p.attainment?.length ? p.attainment.map((a) => (
            <View key={a.id} style={{ gap: 4, paddingVertical: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="800">{a.term_label}</T><BandTag band={a.progress_band} /><Tag label={a.provenance.verified ? t('ac.verified') : t('ac.unverified')} color={a.provenance.verified ? c.limeSoft : c.sunSoft} /></View>
              {a.rows ? a.rows.map((r) => <T key={r.subject} size={13}>{r.subject}: <T weight="800" size={13}>{r.value}</T>{r.comment ? ` · ${r.comment}` : ''}</T>) : null}
              <T size={11} color={c.mute}>{t('ac.source')}: {a.provenance.label} · v{a.version}{a.provenance.reported_on ? ` · ${when(a.provenance.reported_on)}` : ''}{a.provenance.source_ref ? ` · ${a.provenance.source_ref}` : ''} · {a.framework.name}</T>
            </View>
          )) : <T size={13} color={c.mute}>{t('ac.acad.none')}</T>}
          {p.attendance ? <View style={{ gap: 2 }}><T size={13}>{t('ac.att')}: {p.attendance.pct != null ? `${p.attendance.pct}%` : p.attendance.below_floor ? t('ac.att_low') : t('ac.att_ok')} <T size={11} color={c.mute}>({when(p.attendance.period.from)} – {when(p.attendance.period.to)})</T></T><T size={11} color={c.mute}>{t('ac.source')}: {p.attendance.provenance.label}{p.attendance.provenance.source_name ? ` · ${p.attendance.provenance.source_name}` : ''} · v{p.attendance.provenance.version}</T></View> : null}
          {p.next_exam ? <T size={13}>📝 {t('ac.next_exam')}: {fmtDT(p.next_exam.starts_at)}{p.next_exam.high_stakes ? ` · ${t('ac.high_stakes')}` : ''}</T> : null}
        </Panel>
      </View>

      <Seg value={tab} onChange={setTab} options={[{ value: 'timetable', label: t('ac.tab.timetable') }, { value: 'attendance', label: t('ac.tab.attendance') }, { value: 'attainment', label: t('ac.tab.attainment') }, ...(side === 'academy' ? [{ value: 'tasks', label: t('ac.tab.tasks') }] : [])]} />
      {tab === 'timetable' ? <TimetableTab linkId={linkId} v={v} rec={rec && v.timetable !== 'none'} setSheet={setSheet} key={`t${bump}`} /> : tab === 'attendance' ? <AttendanceTab linkId={linkId} v={v} rec={rec && v.attendance !== 'none' && side !== 'athlete'} setSheet={setSheet} key={`a${bump}`} /> : tab === 'attainment' ? <AttainmentTab linkId={linkId} v={v} rec={rec && v.attainment !== 'none'} setSheet={setSheet} key={`s${bump}`} /> : <LinkTasks o={o} linkId={linkId} toast={toast} setSheet={setSheet} key={`k${bump}`} />}
      {sheet?.type === 'item' ? <ItemSheet linkId={linkId} toast={toast} onClose={() => setSheet(null)} onDone={again} /> : null}
      {sheet?.type === 'attendance' ? <AttendanceSheet linkId={linkId} toast={toast} onClose={() => setSheet(null)} onDone={again} /> : null}
      {sheet?.type === 'snapshot' ? <SnapshotSheet o={o} linkId={linkId} side={side} toast={toast} onClose={() => setSheet(null)} onDone={again} /> : null}
      {sheet?.type === 'task' ? <TaskSheet linkId={linkId} toast={toast} onClose={() => setSheet(null)} onDone={again} /> : null}
    </View>
  );
}
function RequestConsent({ linkId, toast }) {
  const ask = async () => { try { await api.post(`/academics/links/${linkId}/consent-request`, {}); toast?.(t('ac.asked')); } catch (e) { toast?.(e.message); } };
  return <Btn small title={t('ac.ask')} color={c.paper} ink={c.ink} onPress={ask} style={{ alignSelf: 'flex-start' }} />;
}

function TimetableTab({ linkId, v, rec, setSheet }) {
  const q = useLoad(() => api.get(`/academics/links/${linkId}/timetable`, { from: today(), to: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) }).catch((e) => ({ error: e })), [linkId]);
  if (!q.data) return <Loading />;
  if (q.data.error) return <Empty emoji="🔒" title={t('ac.tt.hidden')} />;
  return (
    <View style={{ gap: 8 }}>
      {rec ? <Btn small title={t('ac.tt.add')} onPress={() => setSheet({ type: 'item' })} style={{ alignSelf: 'flex-start' }} /> : null}
      {v.timetable === 'blocks' ? <T size={12} color={c.mute}>{t('ac.tt.blocks')}</T> : null}
      {q.data.items.length ? q.data.items.map((x, n) => (
        <View key={`${x.item_id}${x.date ?? x.starts_at}${n}`} style={{ flexDirection: 'row', gap: 10, padding: 10, borderRadius: 14, backgroundColor: c.bg, alignItems: 'center' }}>
          <T size={20}>{KIND[x.kind][0]}</T>
          <View style={{ flex: 1 }}>
            <T weight="700">{KIND[x.kind][1]}{x.title ? ` · ${x.title}` : ''}</T>
            <T size={12} color={c.mute}>{x.date ? `${when(x.date)} · ${x.start_time.slice(0, 5)}–${x.end_time.slice(0, 5)}` : `${fmtDT(x.starts_at)} – ${new Date(x.ends_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`} · {x.source_label}</T>
          </View>
          {x.high_stakes ? <Tag label={t('ac.high_stakes')} color={c.orangeSoft} /> : null}{!x.verified ? <Tag label={t('ac.unverified')} color={c.sunSoft} /> : null}
        </View>
      )) : <Empty emoji="🗓️" title={t('ac.tt.empty')} />}
    </View>
  );
}
function AttendanceTab({ linkId, v, rec, setSheet }) {
  const q = useLoad(() => api.get(`/academics/links/${linkId}/attendance`).catch((e) => ({ error: e })), [linkId]);
  if (!q.data) return <Loading />;
  if (q.data.error) return <Empty emoji="🔒" title={t('ac.att.hidden')} />;
  return (
    <View style={{ gap: 8 }}>
      {rec ? <Btn small title={t('ac.att.record')} onPress={() => setSheet({ type: 'attendance' })} style={{ alignSelf: 'flex-start' }} /> : null}
      {q.data.view === 'flag' ? <Tag label={q.data.below_floor ? t('ac.att_low') : t('ac.att_ok')} color={q.data.below_floor ? c.orangeSoft : c.limeSoft} /> : q.data.items.length ? q.data.items.map((r) => (
        <View key={r.id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{when(r.period_from)} – {when(r.period_to)}</T><T weight="800" color={r.pct < q.data.floor_pct ? c.orange : c.ink}>{r.pct}%</T></View>
          <Meter filled={r.present} capacity={r.sessions_total} compact />
          <T size={12} color={c.mute}>{t('ac.att.line', { present: r.present, late: r.late, auth: r.authorised_absent, unauth: r.unauthorised_absent, total: r.sessions_total })}</T>
          <T size={11} color={c.mute}>{t('ac.source')}: {r.source_label} · v{r.version}</T>
        </View>
      )) : <Empty emoji="📉" title={t('ac.att.empty')} sub={t('ac.att.empty_sub')} />}
    </View>
  );
}
function AttainmentTab({ linkId, v, rec, setSheet }) {
  const q = useLoad(() => api.get(`/academics/links/${linkId}/snapshots`, { include_history: true }).catch((e) => ({ error: e })), [linkId]);
  if (!q.data) return <Loading />;
  if (q.data.error) return <Empty emoji="🔒" title={t('ac.snap.hidden')} />;
  return (
    <View style={{ gap: 8 }}>
      {rec ? <Btn small title={t('ac.snap.record')} onPress={() => setSheet({ type: 'snapshot' })} style={{ alignSelf: 'flex-start' }} /> : null}
      {q.data.view === 'band' ? <T size={12} color={c.mute}>{t('ac.snap.band_only')}</T> : null}
      {q.data.items.length ? q.data.items.map((a) => (
        <View key={a.id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 3, opacity: a.current ? 1 : 0.6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="800">{a.term_label}</T><Tag label={`v${a.version}${a.current ? '' : ` · ${t('ac.snap.superseded')}`}`} color={c.paper} /><BandTag band={a.progress_band} /></View>
          {a.rows ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{a.rows.map((r) => <Tag key={r.subject} label={cat(r.subject, r.value)} color={c.paper} />)}</View> : null}
          <T size={11} color={c.mute}>{t('ac.source')}: {a.provenance.label}{a.provenance.reported_on ? ` · ${when(a.provenance.reported_on)}` : ''} · {a.provenance.verified ? t('ac.verified') : t('ac.unverified')} · {a.framework.name} v{a.framework.version}</T>
        </View>
      )) : <Empty emoji="📊" title={t('ac.snap.empty')} />}
    </View>
  );
}
function LinkTasks({ o, linkId, setSheet, toast }) {
  const q = useLoad(() => api.get(`/organisations/${o.id}/academics/tasks`, { limit: 100 }).catch(() => []), [o.id]);
  const mine = (q.data ?? []).filter((x) => x.link_id === linkId);
  return (
    <View style={{ gap: 8 }}>
      <Btn small title={t('ac.task.new')} onPress={() => setSheet({ type: 'task' })} style={{ alignSelf: 'flex-start' }} />
      {mine.length ? mine.map((x) => <TaskRow key={x.id} x={x} />) : <Empty emoji="📌" title={t('ac.task.none')} />}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ sheets that record
function ItemSheet({ linkId, toast, onClose, onDone }) {
  const [out, setOut] = useState(null);
  const fields = [
    { key: 'kind', label: t('ac.f.kind'), type: 'chips', options: ['exam', 'class_block', 'tutoring', 'school_event', 'holiday', 'deadline'].map((k) => ({ value: k, label: `${KIND[k][0]} ${KIND[k][1]}` })) },
    { key: 'title', label: t('ac.f.subject'), optional: true },
    { key: 'when', label: t('ac.f.when'), type: 'choice', options: [{ value: 'once', label: t('ac.f.once') }, { value: 'weekly', label: t('ac.f.weekly') }], show: (x) => x.kind !== 'exam' },
    { key: 'date', label: t('ac.f.date'), type: 'date', show: (x) => x.kind === 'exam' || x.when !== 'weekly' },
    { key: 'weekdays', label: t('ac.f.weekdays'), type: 'weekdays', show: (x) => x.kind !== 'exam' && x.when === 'weekly' },
    { key: 'start_time', label: t('ac.f.start'), type: 'time' }, { key: 'end_time', label: t('ac.f.end'), type: 'time' },
    { key: 'range', label: t('ac.f.term_dates'), type: 'daterange', toKey: 'to_on', show: (x) => x.kind !== 'exam' && x.when === 'weekly' },
    { key: 'timezone', label: t('ac.f.tz'), type: 'timezone' },
    { key: 'high_stakes', label: t('ac.f.high'), type: 'switch', default: false, show: (x) => x.kind === 'exam' },
    { key: 'blocks_sport', label: t('ac.f.blocks'), type: 'switch', default: true, show: (x) => x.kind !== 'holiday' },
  ];
  return (
    <>
      <FormSheet visible={!out} onClose={onClose} title={t('ac.tt.add')} fields={fields} initial={{ kind: 'exam', when: 'once', timezone: 'Asia/Kolkata', start_time: '09:00', end_time: '11:00', date: today(), blocks_sport: true }} submitLabel={t('ac.save')}
        onSubmit={async (x) => {
          const tz = x.timezone ?? 'UTC', weekly = x.kind !== 'exam' && x.when === 'weekly';
          const item = clean({ kind: x.kind, title: x.title, timezone: tz, high_stakes: !!x.high_stakes, blocks_sport: x.kind === 'holiday' ? false : x.blocks_sport !== false,
            ...(weekly ? { weekdays: x.weekdays, start_time: x.start_time, end_time: x.end_time, from_on: x.range, to_on: x.to_on } : { starts_at: zonedISO(x.date, x.start_time, tz), ends_at: zonedISO(x.date, x.end_time, tz) }) });
          const r = await api.post(`/academics/links/${linkId}/items`, { items: [item] });
          setOut(r); onDone();
        }} />
      {out ? <Sheet visible onClose={onClose} title={t('ac.saved')} footer={<Btn title={t('ac.done')} onPress={onClose} />}>
        {out.clashes.length ? <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.orangeSoft, gap: 4 }}><T weight="800">{t('ac.tt.clashes', { n: out.clashes.length })}</T>{out.clashes.map((s) => <T key={s.session_id} size={13}>{s.title} · {fmtDT(s.starts_at)} · {s.status}</T>)}</View>
          : <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.limeSoft }}><T weight="800">{t('ac.tt.no_clash')}</T></View>}
      </Sheet> : null}
    </>
  );
}
function AttendanceSheet({ linkId, toast, onClose, onDone }) {
  return (
    <FormSheet visible onClose={onClose} title={t('ac.att.record')} submitLabel={t('ac.save')} initial={{ sessions_total: 20, present: 20, late: 0, authorised_absent: 0, unauthorised_absent: 0 }}
      fields={[
        { key: 'period_from', label: t('ac.f.period'), type: 'daterange', toKey: 'period_to' },
        { key: 'sessions_total', label: t('ac.f.total'), type: 'stepper', min: 1, max: 400, default: 20 },
        { key: 'present', label: t('ac.f.present'), type: 'stepper', min: 0, max: 400, default: 20 },
        { key: 'late', label: t('ac.f.late'), type: 'stepper', min: 0, max: 400, default: 0 },
        { key: 'authorised_absent', label: t('ac.f.auth'), type: 'stepper', min: 0, max: 400, default: 0 },
        { key: 'unauthorised_absent', label: t('ac.f.unauth'), type: 'stepper', min: 0, max: 400, default: 0 },
        { key: 'source_ref', label: t('ac.f.ref'), optional: true },
      ]}
      onSubmit={async (x) => { const r = await api.post(`/academics/links/${linkId}/attendance`, clean(x)); toast?.(r.task_id ? t('ac.att.task') : t('ac.saved')); onDone(); onClose(); }} />
  );
}
function SnapshotSheet({ o, linkId, side, toast, onClose, onDone }) {
  const fw = useLoad(() => api.get(`/organisations/${o.id}/academics/frameworks`).catch(() => ({ frameworks: [], scales: [] })), [o.id]);
  const [v, setV] = useState({ framework_id: '', term: 'Term 1', rows: [], band: '', ref: '', on: undefined });
  const [busy, setBusy] = useState(false);
  const F = fw.data?.frameworks?.find((f) => f.id === v.framework_id) ?? fw.data?.frameworks?.[0];
  const opts = !F ? [] : F.scale === 'custom' ? F.bands : (fw.data.scales.find((s) => s.key === F.scale)?.options ?? (F.scale === 'numeric_1_9' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : F.scale === 'numeric_1_7' ? [1, 2, 3, 4, 5, 6, 7] : null));
  const setRow = (subject, value) => setV({ ...v, rows: [...v.rows.filter((r) => r.subject !== subject), ...(value === '' || value == null ? [] : [{ subject, value }])] });
  const get = (s) => v.rows.find((r) => r.subject === s)?.value ?? '';
  const save = async () => { setBusy(true); try { await api.post(`/academics/links/${linkId}/snapshots`, clean({ framework_id: F.id, term_label: v.term, rows: v.rows.map((r) => ({ subject: r.subject, value: opts ? r.value : Number(r.value) })), progress_band: v.band, source_kind: side === 'school' ? 'school_report' : 'manual_verified', source_ref: v.ref, reported_on: v.on })); toast?.(t('ac.saved')); onDone(); onClose(); } catch (e) { toast?.(e.message); } finally { setBusy(false); } };
  return (
    <Sheet visible onClose={onClose} title={t('ac.snap.record')} footer={<Btn title={t('ac.save')} loading={busy} disabled={!F || (!v.rows.length && !v.band)} onPress={save} />}>
      {!fw.data ? <Loading /> : !F ? <Empty emoji="🧩" title={t('ac.fw.none')} sub={t('ac.fw.none_sub')} /> : (
        <>
          <MenuField label={t('ac.f.framework')} value={F.id} onChange={(x) => setV({ ...v, framework_id: x, rows: [] })} options={fw.data.frameworks.map((f) => ({ value: f.id, label: f.name, sub: `v${f.version}` }))} />
          <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>{t('ac.f.term')}</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{TERMS.map((term) => <Chip key={term} label={term} active={v.term === term} onPress={() => setV({ ...v, term })} />)}</View></View>
          {side === 'academy' && !F.subjects.length ? null : null}
          {F.subjects.map((s) => (
            <View key={s} style={{ gap: 4 }}>
              <T weight="700">{s}</T>
              {opts ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{opts.map((o2) => <Chip key={String(o2)} label={String(o2)} active={String(get(s)) === String(o2)} onPress={() => setRow(s, String(get(s)) === String(o2) ? '' : o2)} />)}</View>
                : <Field value={String(get(s))} onChangeText={(x) => setRow(s, x.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" placeholder={F.scale === 'percent' ? '0–100' : '0–4'} />}
            </View>
          ))}
          <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>{t('ac.f.band').toUpperCase()}</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Chip label={t('ac.f.band_auto')} active={!v.band} onPress={() => setV({ ...v, band: '' })} />{['on_track', 'watch', 'support_needed'].map((b) => <Chip key={b} label={BAND[b][0]} active={v.band === b} onPress={() => setV({ ...v, band: b })} />)}</View></View>
          <DateField label={t('ac.f.reported')} value={v.on} onChange={(x) => setV({ ...v, on: x })} optional max={today()} />
          <Field label={t('ac.f.ref')} value={v.ref} onChangeText={(x) => setV({ ...v, ref: x })} placeholder={t('ac.f.ref_hint')} />
          <T size={12} color={c.mute}>{t('ac.snap.provenance', { kind: side === 'school' ? t('ac.src.school_report') : t('ac.src.manual_verified') })}</T>
        </>
      )}
    </Sheet>
  );
}
function TaskSheet({ linkId, toast, onClose, onDone }) {
  return (
    <FormSheet visible onClose={onClose} title={t('ac.task.new')} submitLabel={t('ac.create')} initial={{ kind: 'coach_school_sync', people: ['academic_lead', 'coach'] }}
      fields={[
        { key: 'kind', label: t('ac.f.task_kind'), type: 'chips', options: Object.entries(TASK_KIND).map(([value, [e, label]]) => ({ value, label: `${e} ${label}` })) },
        { key: 'title', label: t('ac.f.task_title'), type: 'text' },
        { key: 'reason_code', label: t('ac.f.reason'), type: 'chips', optional: true, options: REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] })) },
        { key: 'due_on', label: t('ac.f.due'), type: 'date', optional: true },
        { key: 'people', label: t('ac.f.people'), type: 'multi', options: Object.entries(ROLE).map(([value, label]) => ({ value, label })) },
        { key: 'note', label: t('ac.f.note'), type: 'multiline', optional: true },
      ]}
      onSubmit={async (x) => { await api.post(`/academics/links/${linkId}/tasks`, clean(x)); toast?.(t('ac.saved')); onDone(); onClose(); }} />
  );
}

// ------------------------------------------------------------------------------------------------------------------------ link an athlete to a school
function LinkWizard({ o, toast, reload, onClose }) {
  const [v, setV] = useState({ enrol: [], school: [], kind: 'school', curriculum: 'cbse', year: 'Grade 10', start: undefined, ref: '' });
  const [busy, setBusy] = useState(false);
  const loadAthletes = useMemo(() => async (q) => {
    const cohorts = await api.get(`/organisations/${o.id}/cohorts`).catch(() => []);
    const out = [];
    for (const k of (Array.isArray(cohorts) ? cohorts : cohorts.items ?? []).slice(0, 12)) for (const e of (await api.get(`/cohorts/${k.id}/enrolments`).catch(() => [])) ?? []) if (e.status === 'enrolled' && (!q || `${e.display_name}`.toLowerCase().includes(q.toLowerCase()))) out.push({ value: e.enrolment_id ?? e.id, label: e.display_name ?? e.handle, sub: k.name });
    return out.slice(0, 40);
  }, [o.id]);
  const loadSchools = useMemo(() => async (q) => (await api.get(`/organisations/${o.id}/academics/providers`, clean({ q, limit: 30 })).catch(() => [])).map((s) => ({ value: s.id, label: s.name, sub: [s.kind, s.city, s.verified ? t('ac.verified') : t('ac.unverified')].filter(Boolean).join(' · ') })), [o.id]);
  const go = async () => { setBusy(true); try { await api.post(`/organisations/${o.id}/academics/links`, clean({ enrolment_id: v.enrol[0], school_org_id: v.school[0], provider_kind: v.kind, curriculum: v.curriculum, year_group: v.year, starts_on: v.start, student_ref: v.ref })); toast?.(t('ac.link.done')); reload(); onClose(); } catch (e) { toast?.(e.message); } finally { setBusy(false); } };
  return (
    <Sheet visible onClose={onClose} title={t('ac.link.cta')} footer={<Btn title={t('ac.link.go')} loading={busy} disabled={!v.enrol.length || !v.school.length} onPress={go} />}>
      <T size={13} color={c.mute}>{t('ac.link.help')}</T>
      <MultiMenuField label={t('ac.link.athlete')} value={v.enrol} onChange={(x) => setV({ ...v, enrol: x.slice(-1) })} load={loadAthletes} max={1} placeholder={t('ac.link.pick')} />
      <MultiMenuField label={t('ac.link.school')} value={v.school} onChange={(x) => setV({ ...v, school: x.slice(-1) })} load={loadSchools} max={1} placeholder={t('ac.link.pick_school')} hint={t('ac.link.school_hint')} />
      <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>{t('ac.f.provider').toUpperCase()}</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[['school', t('ac.prov.school')], ['college', t('ac.prov.college')], ['tutoring', t('ac.prov.tutoring')], ['online_school', t('ac.prov.online')]].map(([k, l]) => <Chip key={k} label={l} active={v.kind === k} onPress={() => setV({ ...v, kind: k })} />)}</View></View>
      <MenuField label={t('ac.f.curriculum')} value={v.curriculum} onChange={(x) => setV({ ...v, curriculum: x })} options={CURRICULA.map(([value, label]) => ({ value, label }))} />
      <MenuField label={t('ac.f.year')} value={v.year} onChange={(x) => setV({ ...v, year: x })} options={YEARS.map((y) => ({ value: y, label: y }))} />
      <DateField label={t('ac.f.from')} value={v.start} onChange={(x) => setV({ ...v, start: x })} optional />
      <Field label={t('ac.f.studentref')} value={v.ref} onChangeText={(x) => setV({ ...v, ref: x })} />
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ calendar and clash planner
function CalendarPlanner({ o, links }) {
  const [from, setFrom] = useState(today());
  const to = new Date(new Date(`${from}T00:00:00Z`).getTime() + 21 * 864e5).toISOString().slice(0, 10);
  const cl = useLoad(() => api.get(`/organisations/${o.id}/academics/clashes`, { from, to }).catch(() => null), [o.id, from]);
  const cal = useLoad(() => api.get(`/organisations/${o.id}/academics/calendar`, { from, to, limit: 100 }).catch(() => null), [o.id, from]);
  return (
    <View style={{ gap: 14 }}>
      <DateField label={t('ac.cal.from')} value={from} onChange={(x) => setFrom(x ?? today())} />
      <Panel>
        <Block title={t('ac.cal.clashes')}>
          {!cl.data ? <Loading /> : cl.data.sessions.length ? cl.data.sessions.map((s) => (
            <View key={s.session_id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.orangeSoft, gap: 2 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{s.title} · {fmtDT(s.starts_at)}</T><Tag label={s.status} color={c.paper} /></View>
              {s.clashes.map((x, n) => <T key={n} size={13}>{x.message}</T>)}
            </View>
          )) : <Empty emoji="✅" title={t('ac.clash.none')} sub={t('ac.cal.checked', { n: cl.data.checked, a: when(from), b: when(to) })} />}
        </Block>
      </Panel>
      <Panel>
        <Block title={t('ac.cal.commitments')}>
          {!cal.data ? <Loading /> : cal.data.items.length ? cal.data.items.map((x, n) => (
            <View key={`${x.item_id}${n}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 12, backgroundColor: c.bg }}>
              <T size={18}>{KIND[x.kind][0]}</T>
              <View style={{ flex: 1 }}><T weight="700">{x.athlete_name} · {KIND[x.kind][1]}</T><T size={12} color={c.mute}>{x.date ? `${when(x.date)} · ${x.start_time.slice(0, 5)}–${x.end_time.slice(0, 5)}` : fmtDT(x.starts_at)}</T></View>
              {x.high_stakes ? <Tag label={t('ac.high_stakes')} color={c.orangeSoft} /> : null}
            </View>
          )) : <Empty emoji="🗓️" title={t('ac.cal.empty')} />}
        </Block>
      </Panel>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ tasks
function TaskRow({ x, onPress }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={x.title} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 4, minHeight: 56 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T size={18}>{TASK_KIND[x.kind][0]}</T><T weight="800" style={{ flex: 1 }}>{x.title}</T>{x.overdue ? <Tag label={t('ac.overdue')} color={c.orangeSoft} /> : null}<Tag label={x.status === 'in_progress' ? t('ac.task.in_progress') : x.status === 'done' ? t('ac.task.done') : t('ac.task.open')} color={x.status === 'done' ? c.limeSoft : c.paper} /></View>
      <T size={12} color={c.mute}>{x.athlete_name}{x.reason_code ? ` · ${REASON_LABEL[x.reason_code]}` : ''}{x.due_on ? ` · ${t('ac.due')} ${when(x.due_on)}` : ''}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>{(x.people ?? []).map((p, n) => <Tag key={n} label={[ROLE[p.role], p.name].join(': ')} color={c.paper} />)}{x.messages ? <Tag label={cat('💬', x.messages)} color={c.paper} /> : null}</View>
    </Pressable>
  );
}
function Tasks({ o, toast, reload }) {
  const [st, setSt] = useState('active');
  const [open, setOpen] = useState(null);
  const q = useLoad(() => api.get(`/organisations/${o.id}/academics/tasks`, { status: st, limit: 100 }).catch(() => []), [o.id, st]);
  return (
    <Panel>
      <Block title={t('ac.sec.tasks')}>
        <Seg value={st} onChange={setSt} options={[{ value: 'active', label: t('ac.task.active') }, { value: 'done', label: t('ac.task.done') }]} />
        {!q.data ? <Loading /> : q.data.length ? q.data.map((x) => <TaskRow key={x.id} x={x} onPress={() => setOpen(x.id)} />) : <Empty emoji="🎉" title={t('ac.task.empty')} sub={t('ac.task.empty_sub')} />}
      </Block>
      {open ? <TaskDetail id={open} toast={toast} onClose={() => { setOpen(null); q.reload(); }} /> : null}
    </Panel>
  );
}
function TaskDetail({ id, toast, onClose }) {
  const q = useLoad(() => api.get(`/academics/tasks/${id}`), [id]);
  const [msg, setMsg] = useState('');
  if (!q.data) return <Sheet visible onClose={onClose} title=""><Loading /></Sheet>;
  const task = q.data;
  const act = async (b) => { try { await api.patch(`/academics/tasks/${id}`, b); setMsg(''); q.reload(); } catch (e) { toast?.(e.message); } };
  return (
    <Sheet visible onClose={onClose} title={task.title}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Tag label={cat(TASK_KIND[task.kind][0], TASK_KIND[task.kind][1])} />{task.reason_code ? <Tag label={REASON_LABEL[task.reason_code]} color={c.paper} /> : null}{task.due_on ? <Tag label={cat(t('ac.due'), when(task.due_on))} color={c.paper} /> : null}</View>
      <T size={13} color={c.mute}>{task.athlete_name} · {task.people.map((p) => `${ROLE[p.role]}: ${p.display_name}`).join(' · ')}</T>
      {task.note ? <T>{task.note}</T> : null}
      <Block title={t('ac.task.thread')}>
        {task.messages.map((m) => <View key={m.id} style={{ padding: 10, borderRadius: 12, backgroundColor: c.bg }}><T size={12} weight="800">{m.author}</T><T>{m.body}</T></View>)}
        {task.can_manage && !['done', 'cancelled'].includes(task.status) ? (
          <View style={{ gap: 8 }}>
            <Field value={msg} onChangeText={setMsg} placeholder={t('ac.task.say')} multiline />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Btn small title={t('ac.task.send')} disabled={!msg.trim()} onPress={() => act({ message: msg.trim() })} />
              {task.status === 'open' ? <Btn small title={t('ac.task.start')} color={c.paper} ink={c.ink} onPress={() => act({ status: 'in_progress' })} /> : null}
              <Btn small title={t('ac.task.finish')} color={c.paper} ink={c.ink} onPress={() => act({ status: 'done' })} />
            </View>
          </View>
        ) : null}
      </Block>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ frameworks
function Frameworks({ o, toast }) {
  const q = useLoad(() => api.get(`/organisations/${o.id}/academics/frameworks`).catch(() => null), [o.id]);
  const [edit, setEdit] = useState(null);
  if (!q.data) return <Loading />;
  const scales = q.data.scales;
  return (
    <Panel>
      <Block title={t('ac.fw.title')} right={q.data.can_manage ? <Btn small title={t('ac.fw.new')} onPress={() => setEdit({})} /> : null}>
        <T size={13} color={c.mute}>{t('ac.fw.sub')}</T>
        {q.data.frameworks.length ? q.data.frameworks.map((f) => (
          <View key={f.id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{f.name}</T><Tag label={vTag(f.version)} color={c.paper} />{q.data.can_manage ? <Btn small title={t('ac.edit')} color={c.paper} ink={c.ink} onPress={() => setEdit(f)} /> : null}</View>
            <T size={12} color={c.mute}>{scales.find((s) => s.key === f.scale)?.label}{f.subjects.length ? ` · ${f.subjects.join(', ')}` : ''}</T>
            <T size={12} color={c.mute}>{t('ac.fw.thresholds', { w: f.watch_below ?? 60, s: f.support_below ?? 45, a: f.attendance_floor_pct })}</T>
          </View>
        )) : <Empty emoji="🧩" title={t('ac.fw.none')} sub={t('ac.fw.none_sub')} />}
      </Block>
      {edit ? <FormSheet visible onClose={() => setEdit(null)} title={edit.id ? t('ac.fw.edit') : t('ac.fw.new')} submitLabel={t('ac.save')}
        initial={edit.id ? { ...edit, bands: edit.bands ?? [] } : { scale: 'cbse_grade', attendance_floor_pct: 90, watch_below: 60, support_below: 45, subjects: [] }}
        fields={[
          { key: 'name', label: t('ac.fw.name'), type: 'text' },
          { key: 'scale', label: t('ac.fw.scale'), type: 'chips', options: scales.map((s) => ({ value: s.key, label: s.label })) },
          { key: 'bands', label: t('ac.fw.bands'), type: 'custom', default: [], show: (x) => x.scale === 'custom', render: ({ v, set }) => <ListEditor label={t('ac.fw.bands')} add={t('ac.fw.add_band')} value={v.bands ?? []} onChange={(x) => set('bands', x)} /> },
          { key: 'subjects', label: t('ac.fw.subjects'), type: 'custom', default: [], render: ({ v, set }) => <ListEditor label={t('ac.fw.subjects')} add={t('ac.fw.add_subject')} value={v.subjects ?? []} onChange={(x) => set('subjects', x)} /> },
          { key: 'watch_below', label: t('ac.fw.watch'), type: 'stepper', min: 1, max: 99, step: 5, default: 60 },
          { key: 'support_below', label: t('ac.fw.support'), type: 'stepper', min: 1, max: 99, step: 5, default: 45 },
          { key: 'attendance_floor_pct', label: t('ac.fw.floor'), type: 'stepper', min: 50, max: 100, step: 1, suffix: '%', default: 90 },
        ]}
        onSubmit={async (x) => { await api.post(`/organisations/${o.id}/academics/frameworks`, clean({ name: x.name, scale: x.scale, bands: x.scale === 'custom' ? x.bands : [], subjects: x.subjects ?? [], watch_below: x.watch_below, support_below: x.support_below, attendance_floor_pct: x.attendance_floor_pct })); toast?.(t('ac.saved')); setEdit(null); q.reload(); }} /> : null}
    </Panel>
  );
}
function ListEditor({ label, add, value, onChange }) {
  const [x, setX] = useState('');
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{value.map((it, n) => <Chip key={`${it}${n}`} label={`${it} ✕`} active onPress={() => onChange(value.filter((_, k) => k !== n))} />)}</View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={x} onChangeText={setX} placeholder={add} /></View><Btn small title="+" disabled={x.trim().length < 1} onPress={() => { onChange([...value, x.trim()]); setX(''); }} accessibilityLabel={add} /></View>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ imports
function Imports({ o, toast }) {
  const [kind, setKind] = useState('attendance');
  const [csv, setCsv] = useState('');
  const [pre, setPre] = useState(null);
  const [fw, setFw] = useState('');
  const fws = useLoad(() => api.get(`/organisations/${o.id}/academics/frameworks`).catch(() => ({ frameworks: [] })), [o.id]);
  const hist = useLoad(() => api.get(`/organisations/${o.id}/academics/imports`, { limit: 20 }).catch(() => []), [o.id]);
  const COLS = { attendance: 'student_ref, period_from, period_to, sessions_total, present, late, authorised_absent, unauthorised_absent', timetable: 'student_ref, kind, date, start_time, end_time, timezone, title, high_stakes', snapshot: 'student_ref, term, subject, value, band, reported_on' };
  const body = (x) => ({ kind, csv, ...(kind === 'snapshot' ? { framework_id: fw || fws.data?.frameworks?.[0]?.id } : {}), ...x });
  const stage = async () => { try { setPre(await api.post(`/organisations/${o.id}/academics/imports`, body({}))); } catch (e) { toast?.(e.message); } };
  const commit = async () => { try { const r = await api.post(`/organisations/${o.id}/academics/imports/${pre.import_id}/commit`, {}); toast?.(t('ac.imp.applied', { n: r.applied })); setPre(null); setCsv(''); hist.reload(); } catch (e) { toast?.(e.message); } };
  return (
    <Panel>
      <Block title={t('ac.imp.title')}>
        <T size={13} color={c.mute}>{t('ac.imp.sub')}</T>
        <Seg value={kind} onChange={(k) => { setKind(k); setPre(null); }} options={[{ value: 'attendance', label: t('ac.tab.attendance') }, { value: 'timetable', label: t('ac.tab.timetable') }, { value: 'snapshot', label: t('ac.tab.attainment') }]} />
        {kind === 'snapshot' ? <MenuField label={t('ac.f.framework')} value={fw || fws.data?.frameworks?.[0]?.id || ''} onChange={setFw} options={(fws.data?.frameworks ?? []).map((f) => ({ value: f.id, label: f.name }))} /> : null}
        <T size={12} color={c.mute}>{t('ac.imp.cols', { cols: COLS[kind] })}</T>
        <Field label={t('ac.imp.paste')} value={csv} onChangeText={(x) => { setCsv(x); setPre(null); }} multiline />
        <Btn small title={t('ac.imp.preview')} disabled={csv.trim().length < 10} onPress={stage} style={{ alignSelf: 'flex-start' }} />
        {pre ? (
          <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.violetSoft, gap: 6 }}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={t('ac.imp.ok', { n: pre.summary.ok })} color={c.limeSoft} /><Tag label={t('ac.imp.bad', { n: pre.summary.invalid })} color={pre.summary.invalid ? c.orangeSoft : c.paper} /><Tag label={t('ac.imp.athletes', { n: pre.summary.athletes })} color={c.paper} /></View>
            {pre.summary.errors.map((e) => <T key={e.row} size={12}>{t('ac.imp.row', { n: e.row })}: {e.reason}</T>)}
            <Btn small title={t('ac.imp.commit')} disabled={!pre.summary.ok} onPress={commit} style={{ alignSelf: 'flex-start' }} />
          </View>
        ) : null}
      </Block>
      <Block title={t('ac.imp.recent')}>
        {(hist.data ?? []).map((h) => <View key={h.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T style={{ flex: 1 }} size={13}>{h.kind} · {h.channel} · {h.by_name}</T><Tag label={h.status} color={h.status === 'applied' ? c.limeSoft : c.paper} /><T size={12} color={c.mute}>{h.summary.ok}/{h.summary.total}</T></View>)}
        {hist.data && !hist.data.length ? <T size={13} color={c.mute}>{t('ac.imp.none')}</T> : null}
      </Block>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ the school's own desk (the Org tab of a school, college or university)
export function SchoolDesk({ o, toast }) {
  const { tablet } = useLayout();
  const [open, setOpen] = useState(null);
  const q = useLoad(() => api.get(`/organisations/${o.id}/academics/school-athletes`, { limit: 100 }).catch(() => []), [o.id]);
  const [imp, setImp] = useState(false);
  const list = (
    <Panel>
      <Block title={t('ac.school.title')} right={<Btn small title={t('ac.imp.title2')} color={c.paper} ink={c.ink} onPress={() => setImp(true)} />}>
        <T size={13} color={c.mute}>{t('ac.school.sub')}</T>
        {!q.data ? <Loading /> : q.data.length ? q.data.map((x) => (
          <Pressable key={x.link_id} onPress={() => setOpen(x.link_id)} accessibilityRole="button" accessibilityLabel={x.athlete_name} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 4, minHeight: 60 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="800" style={{ flex: 1 }}>{x.athlete_name}</T><Tag label={CONSENT[x.consent_state][0]} color={CONSENT[x.consent_state][1]} />{x.mine ? <Tag label={t('ac.mine')} color={c.pinkSoft} /> : null}</View>
            <T size={12} color={c.mute}>{x.academy_name}{x.year_group ? ` · ${x.year_group}` : ''} · {x.granted.length ? x.granted.join(', ') : t('ac.school.nothing')}{x.expires_on ? ` · ${t('ac.until')} ${when(x.expires_on)}` : ''}</T>
          </Pressable>
        )) : <Empty emoji="🏫" title={t('ac.school.empty')} sub={t('ac.school.empty_sub')} />}
      </Block>
    </Panel>
  );
  return (
    <View style={{ marginTop: 10 }}>
      <Split open={!!open} onClose={() => setOpen(null)} detailTitle={q.data?.find((x) => x.link_id === open)?.athlete_name ?? ''} list={list} detail={open ? <AthleteFile key={open} o={o} linkId={open} side="school" toast={toast} reload={q.reload} /> : null} />
      {imp ? <Sheet visible onClose={() => setImp(false)} title={t('ac.imp.title2')}><Imports o={o} toast={toast} /></Sheet> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ the athlete / guardian sharing centre
export function MyStudy() {
  const { toast } = useSession();
  const [who, setWho] = useState(null);
  const q = useLoad(() => api.get('/me/academics/consents', who ? { athlete_id: who } : {}).catch(() => []), [who]);
  const [edit, setEdit] = useState(null);
  const [log, setLog] = useState(null);
  if (!q.data?.length) return null;
  const revoke = async (g) => { try { await api.post(`/academics/consents/${g.id}/revoke`, {}); toast?.(t('ac.my.withdrawn')); q.reload(); } catch (e) { toast?.(e.message); } };
  return (
    <View style={{ gap: 10 }}>
      {q.data.map((x) => (
        <Panel key={x.link.id}>
          <T weight="800" size={16}>{t('ac.my.title')}</T>
          <T size={13} color={c.mute}>{x.link.athlete_name} · {x.link.school.name}{x.link.year_group ? ` · ${x.link.year_group}` : ''}</T>
          <T size={12} color={c.mute}>{t('ac.my.help')}</T>
          {x.parties.map((p) => (
            <View key={p.org_id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="800" style={{ flex: 1 }}>{p.name}</T><Tag label={p.role === 'academy' ? t('ac.my.academy') : t('ac.my.school')} color={c.paper} /><Tag label={p.consent ? CONSENT.active[0] : CONSENT.not_granted[0]} color={p.consent ? c.limeSoft : c.violetSoft} /></View>
              <T size={12} color={c.mute}>{p.consent ? `${p.consent.scopes.join(', ')} · ${p.consent.detail === 'detail' ? t('ac.detail') : t('ac.summary')} · ${t('ac.until')} ${when(p.consent.expires_on)}` : t('ac.my.nothing')} · {t('ac.my.reads', { n: p.reads_90d })}</T>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title={p.consent ? t('ac.my.change') : t('ac.my.share')} onPress={() => setEdit({ x, p })} />{p.consent ? <Btn small title={t('ac.my.withdraw')} color={c.paper} ink={c.red} onPress={() => revoke(p.consent)} /> : null}</View>
            </View>
          ))}
          <Btn small title={t('ac.my.log')} color={c.paper} ink={c.ink} onPress={() => setLog(x.link.id)} style={{ alignSelf: 'flex-start' }} />
        </Panel>
      ))}
      {edit ? <FormSheet visible onClose={() => setEdit(null)} title={edit.p.name} submitLabel={t('ac.my.save')} initial={{ scopes: edit.p.consent?.scopes ?? ['timetable'], detail: edit.p.consent?.detail ?? 'summary', expires_on: edit.p.consent?.expires_on }}
        fields={[
          { key: 'scopes', label: t('ac.my.what'), type: 'multi', options: [{ value: 'timetable', label: t('ac.my.timetable') }, { value: 'attendance', label: t('ac.my.attendance') }, { value: 'attainment', label: t('ac.my.attainment') }] },
          { key: 'detail', label: t('ac.my.level'), type: 'choice', options: [{ value: 'summary', label: t('ac.summary_cap') }, { value: 'detail', label: t('ac.detail_cap') }], hint: t('ac.my.level_hint') },
          { key: 'expires_on', label: t('ac.my.until'), type: 'date', optional: true, hint: t('ac.my.until_hint') },
        ]}
        onSubmit={async (v) => { await api.post('/academics/consents', clean({ athlete_id: edit.x.link.athlete_id, party_org_id: edit.p.org_id, scopes: v.scopes, detail: v.detail, expires_on: v.expires_on })); toast?.(t('ac.my.saved')); setEdit(null); q.reload(); }} /> : null}
      {log ? <AccessLog linkId={log} onClose={() => setLog(null)} /> : null}
    </View>
  );
}
function AccessLog({ linkId, onClose }) {
  const q = useLoad(() => api.get(`/academics/links/${linkId}/access-log`, { limit: 50 }).catch(() => []), [linkId]);
  return (
    <Sheet visible onClose={onClose} title={t('ac.my.log')}>
      {!q.data ? <Loading /> : q.data.length ? q.data.map((e) => <View key={e.id} style={{ padding: 10, borderRadius: 12, backgroundColor: c.bg }}><T weight="700">{e.actor_name} · {e.organisation_name ?? ''}</T><T size={12} color={c.mute}>{e.scope} · {e.detail} · {fmtDT(e.at)}</T></View>) : <Empty emoji="👀" title={t('ac.my.log_empty')} />}
    </Sheet>
  );
}
