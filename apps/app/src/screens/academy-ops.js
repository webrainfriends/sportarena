// Academy OS 2/3, the director's side: Operations Today, the week timetable (with a term builder), staff & leave, and time & pay.
// Everything here is a view over the canonical records; each action opens the screen or call that owns the work. The server decides what
// the signed-in role may see, and this module only hides what it cannot use.
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Loading, Row, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { addDays, dateTimeIn, localToIso, moneyIn, timeIn, todayIn } from '../vtime';
import { Block, Fact, Kpi } from './academy-ui';

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const LEVEL = { compliant: ['✓', 'Staffed'], warning: ['⚠', 'Needs attention'], blocked: ['⛔', 'Rule not met'] };
const DELIVERY = ['training', 'assessment', 'trial', 'workshop', 'camp', 'classroom', 'match_prep', 'other'].map((value) => ({ value, label: value.replace('_', ' ').replace(/^./, (x) => x.toUpperCase()) }));
const PHASE = { current: 'Now', upcoming: 'Upcoming', done: 'Done' };
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const monday = (d) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const hrs = (m) => `${(m / 60).toFixed(m % 60 ? 1 : 0)} h`;

function saveCsv(filename, csv, setText) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  } else setText(csv);
}

// ================================================================================== TODAY
function SessionCard({ s, onAction, tz }) {
  const [icon, text] = LEVEL[s.compliance.level];
  const issues = [...s.compliance.issues.map((x) => x.message), ...s.conflicts.map((x) => x.message)];
  return (
    <Card pad={14}>
      <View accessible accessibilityLabel={`${s.title}, ${timeIn(s.starts_at, tz)}, ${text}, ${s.present} of ${s.expected} present`} style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <T weight="800" size={16} style={{ flex: 1 }}>{timeIn(s.starts_at, tz)} · {s.title}</T>
          <Tag label={PHASE[s.phase]} color={s.phase === 'current' ? c.lime : undefined} /><Tag label={`${icon} ${text}`} color={s.compliance.level === 'compliant' ? c.lime : s.compliance.level === 'blocked' ? c.orangeSoft : c.sunSoft} />
          {s.status === 'draft' ? <Tag label="Draft" /> : null}
        </View>
        <T size={13} color={c.mute}>{s.cohort}{s.programme ? ` · ${s.programme}` : ''}{s.venue ? ` · 📍 ${s.venue.name}${s.venue.confirmed ? '' : ' (not confirmed)'}` : ' · no venue booked'}</T>
        <T size={13}>{s.staff.length ? s.staff.map((x) => `${x.display_name}${x.role === 'lead' ? ' (lead)' : x.role === 'duty' ? ` (${x.duty_label ?? 'duty'})` : ''}${x.status === 'assigned' ? ' · awaiting reply' : ''}`).join(', ') : 'No staff assigned'}</T>
        <T size={13} color={c.mute}>{s.expected} expected · {s.present} present · {s.absent} away{s.attendance_progress != null ? ` · ${s.attendance_progress}% marked` : ''}{s.cover_open ? ' · ⚠ cover requested' : ''}</T>
        {issues.slice(0, 3).map((x, i) => <T key={i} size={12} color={c.red}>⚠ {x}</T>)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {s.actions.filter((a) => a.enabled).map((a) => <Btn key={a.key} small title={a.label} color={a.key === 'attendance' ? c.pink : c.paper} ink={a.key === 'attendance' ? '#fff' : c.ink} onPress={() => onAction(a)} />)}
      </View>
    </Card>
  );
}

function Today({ o, toast, setTab }) {
  const [date, setDate] = useState(undefined);
  const { push } = useNav();
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/today`, { date }), [o.id, date]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const { sessions, inbox, timezone: tz } = d.data;
  const k = [
    ['Need attention', inbox.understaffed, 'sessions with a staffing warning', inbox.understaffed ? 'alert' : undefined, () => {}],
    ['Cover needed', inbox.cover_open, 'open cover requests', inbox.cover_open ? 'alert' : undefined, () => setTab('staff')],
    ['Drafts', inbox.drafts, 'sessions not yet published', undefined, () => setTab('week')],
    ['Leave requests', inbox.time_off_pending, 'waiting for a decision', undefined, () => setTab('staff')],
    ['Timesheets', inbox.timesheets_to_approve, inbox.timesheet_exceptions ? `${inbox.timesheet_exceptions} missing clock-out` : 'to approve', inbox.timesheet_exceptions ? 'alert' : undefined, () => setTab('pay')],
    ['Payroll drafts', inbox.payroll_drafts, 'runs to approve', undefined, () => setTab('pay')],
  ].filter((x) => x[1] > 0 || ['Need attention'].includes(x[0]));
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="←" color={c.paper} ink={c.ink} onPress={() => setDate(addDays(d.data.date, -1))} accessibilityLabel="Previous day" />
        <T weight="800" size={17} style={{ flex: 1, textAlign: 'center' }}>{new Date(`${d.data.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })}</T>
        <Btn small title="→" color={c.paper} ink={c.ink} onPress={() => setDate(addDays(d.data.date, 1))} accessibilityLabel="Next day" /><Btn small title="Today" color={c.paper} ink={c.ink} onPress={() => setDate(undefined)} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{k.map(([l, v, sub, tone, go]) => <Kpi key={l} label={l} value={v} sub={sub} tone={tone} onPress={go} />)}</View>
      {inbox.unpaid_commercial ? <Card pad={12}><T size={13}>💷 {inbox.unpaid_commercial} overdue tuition payment{inbox.unpaid_commercial === 1 ? '' : 's'} (owned by Academy billing)</T></Card> : null}
      {sessions.length ? sessions.map((s) => <SessionCard key={s.id} s={s} tz={tz} onAction={(a) => push(a.screen, a.params)} />) : <Empty emoji="🗓️" title="Nothing scheduled this day" sub="Build a term timetable or add a session from the Week tab." />}
    </View>
  );
}

// ================================================================================== WEEK + TERM BUILDER
function Builder({ o, cohorts, people, visible, onClose, onDone, toast }) {
  const [prev, setPrev] = useState(null), [busy, setBusy] = useState(false);
  const lead = people.filter((p) => p.role !== 'finance');
  const submitBody = (v) => ({
    starts_on: v.range, ends_on: v.range_to, weekdays: v.weekdays, start_time: v.start_time, duration_min: v.duration_min, delivery_type: v.delivery_type, timezone: deviceTz,
    closures: v.closure ? [{ from: v.closure, to: v.closure_to ?? v.closure }] : [], skip_dates: v.skip ? [v.skip] : [], lead_id: v.lead_id || undefined, assistant_ids: v.assistants ?? [], title: v.title || undefined, capacity: v.capacity || undefined,
  });
  return (
    <>
      <FormSheet visible={visible && !prev} onClose={onClose} title="Build a term timetable" submitLabel="Preview" initial={{ weekdays: [], duration_min: 60, delivery_type: 'training' }} fields={[
        { key: 'cohort_id', label: 'Group', type: 'chips', options: cohorts.map((k) => ({ value: k.id, label: k.name })) },
        { key: 'range', label: 'Term dates', type: 'daterange', toKey: 'range_to' }, { key: 'weekdays', label: 'Sessions on', type: 'weekdays' },
        { key: 'start_time', label: 'Start time', type: 'time' }, { key: 'duration_min', label: 'Length (minutes)', type: 'stepper', min: 10, max: 600, step: 5, default: 60 },
        { key: 'delivery_type', label: 'Type', type: 'chips', options: DELIVERY },
        { key: 'lead_id', label: 'Lead coach', type: 'entity', optional: true, entityKind: 'person', options: lead.map((p) => ({ id: p.user_id, display_name: p.display_name, handle: p.handle })) },
        { key: 'assistants', label: 'Assistants', type: 'multi', optional: true, options: lead.map((p) => ({ value: p.user_id, label: p.display_name })) },
        { key: 'closure', label: 'Holiday / closure', type: 'daterange', toKey: 'closure_to', optional: true }, { key: 'skip', label: 'Skip one more date', type: 'date', optional: true },
        { key: 'title', label: 'Session title', optional: true }, { key: 'capacity', label: 'Places per session', type: 'stepper', min: 1, max: 500, default: 12, optional: true }]}
        onSubmit={async (v) => { const body = submitBody(v); const r = await api.post(`/cohorts/${v.cohort_id}/academy/timetable/preview`, body); setPrev({ cohort_id: v.cohort_id, body, r }); return `${r.new_sessions} new session(s) in the preview`; }} />
      <Sheet visible={visible && !!prev} onClose={() => { setPrev(null); onClose(); }} title="Preview: nothing is created yet">
        {prev ? (
          <View style={{ gap: 8 }}>
            <T>{prev.r.new_sessions} new · {prev.r.existing} already scheduled · {prev.r.conflicts} conflict{prev.r.conflicts === 1 ? '' : 's'}</T>
            {prev.r.sessions.map((s) => {
              const issues = [...s.cohort_issues.map((x) => x.message), ...s.staff.flatMap((t) => t.issues.map((x) => x.message))];
              return (
                <View key={s.date} style={{ padding: 10, borderRadius: 12, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, gap: 2 }} accessible accessibilityLabel={`${s.date}: ${s.existing_session_id ? 'already scheduled' : issues.length ? `${issues.length} conflicts` : 'ok'}`}>
                  <T weight="700">{dateTimeIn(s.starts_at, prev.r.timezone)}</T>
                  {s.existing_session_id ? <T size={12} color={c.mute}>↷ Already scheduled: skipped</T> : issues.length ? issues.map((x, i) => <T key={i} size={12} color={c.red}>⚠ {x}</T>) : <T size={12} color={c.mute}>✓ No conflicts</T>}
                </View>
              );
            })}
            <T size={12} color={c.mute}>Anyone who would clash is left unassigned on that date and listed afterwards. Sessions are created as drafts; you publish them when ready.</T>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setPrev(null)} style={{ flex: 1 }} />
              <Btn title={`Create ${prev.r.new_sessions} draft session${prev.r.new_sessions === 1 ? '' : 's'}`} loading={busy} disabled={!prev.r.new_sessions} style={{ flex: 2 }} onPress={async () => {
                setBusy(true);
                try { const r = await api.post(`/cohorts/${prev.cohort_id}/academy/timetable`, { ...prev.body, idempotency_key: uid() }); toast(`${r.created_count} created${r.unassigned.length ? ` · ${r.unassigned.length} staff clash(es) left unassigned` : ''}`); setPrev(null); onClose(); onDone(); } catch (e) { toast(explain(e)); } finally { setBusy(false); }
              }} />
            </View>
          </View>
        ) : null}
      </Sheet>
    </>
  );
}

function Week({ o, toast, perms, cohorts: allCohorts }) {
  const { tablet } = useLayout();
  const { push } = useNav();
  const [from, setFrom] = useState(monday(todayIn(deviceTz))), [cohort, setCohort] = useState(null), [build, setBuild] = useState(false), [one, setOne] = useState(false);
  const to = addDays(from, 6);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/sessions`, { from, to, cohort_id: cohort ?? undefined }), [o.id, from, cohort]);
  const cohorts = { data: allCohorts };
  const members = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  const people = (members.data ?? []).filter((m) => ['owner', 'admin', 'coach', 'staff'].includes(m.org_role)).map((m) => ({ user_id: m.id ?? m.user_id, display_name: m.display_name, handle: m.handle, role: m.org_role }));
  const can = perms.includes('schedule');
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  const rows = d.data ?? [];
  const drafts = rows.filter((s) => s.status === 'draft');
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const dayOf = (s) => new Date(s.starts_at).toLocaleDateString('en-CA', { timeZone: s.timezone });
  const publish = async () => {
    try { const r = await api.post(`/organisations/${o.id}/academy/sessions/publish`, { session_ids: drafts.map((s) => s.id), acknowledge_warnings: false }); const bad = r.results.filter((x) => !x.published); toast(`${r.published} published${bad.length ? ` · ${bad.length} need attention (open them to see why)` : ''}`); } catch (e) { toast(explain(e)); } finally { d.reload(); }
  };
  const lane = (day) => (
    <View key={day} style={{ flex: tablet ? 1 : undefined, minWidth: 0, gap: 6 }}>
      <T weight="800" size={13}>{DAY[new Date(`${day}T00:00:00Z`).getUTCDay()]} {day.slice(8)}</T>
      {rows.filter((s) => dayOf(s) === day).map((s) => {
        const [icon, text] = LEVEL[s.compliance.level];
        return (
          <Pressable key={s.id} onPress={() => push('AcademySession', { id: s.id })} accessibilityRole="button" accessibilityLabel={`${s.title}, ${timeIn(s.starts_at, s.timezone)}, ${s.status}, ${text}, ${s.venue ?? 'no venue'}`}
            style={{ padding: 8, borderRadius: 12, backgroundColor: s.status === 'cancelled' ? c.orangeSoft : c.paper, borderWidth: 1, borderColor: s.compliance.level === 'compliant' ? c.line : c.orange, gap: 2, minHeight: 56 }}>
            <T size={12} weight="800">{timeIn(s.starts_at, s.timezone)}{s.status === 'draft' ? ' · draft' : s.status === 'cancelled' ? ' · cancelled' : ''}</T>
            <T size={12} weight="700">{s.cohort_name}</T>
            <T size={11} color={c.mute}>{icon} {text} · {s.staff.length} staff{s.venue ? '' : ' · no venue'}</T>
          </Pressable>
        );
      })}
    </View>
  );
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Btn small title="←" color={c.paper} ink={c.ink} onPress={() => setFrom(addDays(from, -7))} accessibilityLabel="Previous week" />
        <T weight="800" style={{ flex: 1, textAlign: 'center' }}>{new Date(`${from}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })} – {new Date(`${to}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}</T>
        <Btn small title="→" color={c.paper} ink={c.ink} onPress={() => setFrom(addDays(from, 7))} accessibilityLabel="Next week" /><Btn small title="This week" color={c.paper} ink={c.ink} onPress={() => setFrom(monday(todayIn(deviceTz)))} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        <Chip label="All groups" active={!cohort} onPress={() => setCohort(null)} />{(cohorts.data ?? []).map((k) => <Chip key={k.id} label={k.name} active={cohort === k.id} onPress={() => setCohort(k.id)} />)}
      </ScrollView>
      {can ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn small title="Build a term timetable" onPress={() => setBuild(true)} /><Btn small title="＋ One session" color={c.paper} ink={c.ink} onPress={() => setOne(true)} />
          {drafts.length ? <Btn small title={`Publish ${drafts.length} draft${drafts.length === 1 ? '' : 's'}`} color={c.paper} ink={c.ink} onPress={publish} /> : null}
        </View>
      ) : null}
      {!d.data ? <Loading /> : tablet ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>{days.map(lane)}</View> : <View style={{ gap: 14 }}>{days.map(lane)}</View>}
      {d.data && !rows.length ? <Empty emoji="🗓️" title="No sessions this week" sub={can ? 'Build a term timetable to create them from a pattern, with conflicts shown before anything is saved.' : 'Nothing for you this week.'} /> : null}
      <T size={12} color={c.mute}>Open a session to move it, change its staff or book its court. Moving a session shows every clash first.</T>
      <Builder o={o} cohorts={cohorts.data ?? []} people={people} visible={build} onClose={() => setBuild(false)} onDone={d.reload} toast={toast} />
      <FormSheet visible={one} onClose={() => setOne(false)} title="Add a session" submitLabel="Add" initial={{ duration_min: 60, delivery_type: 'training' }} fields={[
        { key: 'cohort_id', label: 'Group', type: 'chips', options: (cohorts.data ?? []).map((k) => ({ value: k.id, label: k.name })) }, { key: 'date', label: 'Date', type: 'date' }, { key: 'time', label: 'Start time', type: 'time' },
        { key: 'duration_min', label: 'Length (minutes)', type: 'stepper', min: 10, max: 600, step: 5, default: 60 }, { key: 'delivery_type', label: 'Type', type: 'chips', options: [...DELIVERY, { value: 'makeup', label: 'Make-up' }].filter((x) => x.value !== 'makeup') },
        { key: 'lead_id', label: 'Lead coach', type: 'entity', optional: true, entityKind: 'person', options: people.map((p) => ({ id: p.user_id, display_name: p.display_name, handle: p.handle })) }]}
        onSubmit={async (v) => { const r = await api.post(`/cohorts/${v.cohort_id}/academy/sessions`, { starts_at: localToIso(v.date, v.time, deviceTz), duration_min: v.duration_min, delivery_type: v.delivery_type, timezone: deviceTz, lead_id: v.lead_id || undefined }); d.reload(); return r.unassigned?.length ? 'Added. The lead coach clashes at that time, so nobody is assigned yet.' : 'Added as a draft'; }} />
    </View>
  );
}

// ================================================================================== STAFF
const PERM_LABEL = { schedule: 'Timetable', attendance: 'Attendance', roster: 'Rosters', timesheets: 'Timesheets', payroll: 'Payroll', safeguarding: 'Safeguarding' };
function StaffTab({ o, toast, admin, perms }) {
  const { push } = useNav();
  const st = useLoad(() => api.get(`/organisations/${o.id}/academy/staff`).catch((e) => ({ error: e })), [o.id]);
  const off = useLoad(() => api.get(`/organisations/${o.id}/academy/availability`, { kind: 'time_off', status: 'pending' }).catch(() => []), [o.id]);
  const cover = useLoad(() => api.get(`/organisations/${o.id}/academy/cover`).catch(() => []), [o.id]);
  const from = todayIn(deviceTz);
  const shifts = useLoad(() => api.get(`/organisations/${o.id}/academy/shifts`, { from, to: addDays(from, 14) }).catch(() => []), [o.id]);
  const [edit, setEdit] = useState(null), [shift, setShift] = useState(false);
  if (!st.data) return <Loading />;
  if (st.data.error) return <LoadError error={st.data.error} />;
  const { staff, templates } = st.data;
  const decide = async (id, approve) => { try { const r = await api.post(`/academy/time-off/${id}/decision`, { approve }); toast(approve ? `Approved. ${r.sessions_needing_cover.length} session(s) now need cover.` : 'Not approved'); } catch (e) { toast(explain(e)); } finally { off.reload(); cover.reload(); } };
  const mem = staff.map((p) => ({ id: p.user_id, label: p.display_name, sub: p.job_title ?? p.role }));
  return (
    <View style={{ gap: 14 }}>
      {off.data?.length ? <Block title={`Leave requests (${off.data.length})`}>{off.data.map((r) => <Row key={r.id} title={r.display_name} sub={`${String(r.on_date).slice(0, 10)}${r.ends_on ? ` → ${String(r.ends_on).slice(0, 10)}` : ''}${r.reason ? ` · ${r.reason}` : ''}`} right={admin ? <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="Approve" onPress={() => decide(r.id, true)} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => decide(r.id, false)} /></View> : undefined} />)}</Block> : null}
      {cover.data?.length ? <Block title={`Cover needed (${cover.data.length})`}>{cover.data.map((r) => <Row key={r.id} title={`${r.title}`} sub={`${dateTimeIn(r.starts_at, 'UTC')} · ${r.requester_name}${r.reason ? ` · ${r.reason}` : ''}`} right={<Btn small title="Find substitute" onPress={() => push('AcademySession', { id: r.session_id, tab: 'staff', find: true })} />} />)}</Block> : null}
      <Block title={`Staff (${staff.length})`} right={perms.includes('schedule') ? <Btn small title="＋ Roster a shift" color={c.paper} ink={c.ink} onPress={() => setShift(true)} /> : undefined}>
        {staff.map((p) => (
          <Row key={p.user_id} title={`${p.display_name}${p.job_title ? ` · ${p.job_title}` : ''}`} sub={`${p.engagement_type ?? 'no engagement set'} · ${hrs(p.week_minutes)} this week${p.unconfirmed ? ` · ${p.unconfirmed} unconfirmed` : ''}${p.credential.coach_badge ? ` · ✓ coach credential${p.credential.coach_badge.expiring_soon ? ` (expires in ${p.credential.coach_badge.days_left} days)` : ''}` : ''}${p.credential.missing ? ' · ⚠ required credential missing' : ''}`}
            right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{p.state && p.state !== 'active' ? <Tag label={p.state} color={c.orangeSoft} /> : null}<T size={11} color={c.mute}>{(p.permissions ?? []).map((x) => PERM_LABEL[x]).join(', ')}</T></View>}
            onPress={admin ? () => setEdit(p) : undefined} />
        ))}
        {admin ? <T size={12} color={c.mute}>Invite more people under People (role "staff" for registrars, operations and similar), then set what they can do here.</T> : null}
      </Block>
      {shifts.data?.length ? <Block title="Shifts, next 14 days">{shifts.data.map((s) => <Row key={s.id} title={`${s.title} · ${s.display_name}`} sub={`${dateTimeIn(s.starts_at, s.timezone)} – ${timeIn(s.ends_at, s.timezone)} · ${s.status === 'confirmed' ? '✓ confirmed' : s.status === 'declined' ? '✕ declined' : 'awaiting reply'}`} right={perms.includes('schedule') ? <Btn small title="Cancel" color={c.paper} ink={c.ink} onPress={async () => { try { await api.del(`/academy/shifts/${s.id}`); toast('Shift cancelled'); } catch (e) { toast(explain(e)); } finally { shifts.reload(); } }} /> : undefined} />)}</Block> : null}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.display_name}: engagement` : ''} submitLabel="Save"
        initial={edit ? { job_title: edit.job_title ?? '', template: edit.template ?? 'custom', engagement_type: edit.engagement_type ?? 'employee', state: edit.state ?? 'active', permissions: edit.permissions ?? [], scope_sports: edit.scope_sports ?? [], required_credentials: edit.required_credentials ?? [], staff_ref: edit.staff_ref ?? '' } : {}}
        fields={[
          { key: 'template', label: 'Job title template', type: 'chips', options: templates.map((t) => ({ value: t.key, label: t.title })) }, { key: 'job_title', label: 'Job title' },
          { key: 'engagement_type', label: 'Engagement', type: 'chips', options: [{ value: 'employee', label: 'Employee' }, { value: 'contractor', label: 'Contractor' }, { value: 'volunteer', label: 'Volunteer' }] },
          { key: 'permissions', label: 'What they can do', type: 'multi', optional: true, options: Object.entries(PERM_LABEL).map(([value, label]) => ({ value, label })) },
          { key: 'scope_sports', label: 'Limit to sports (none = all)', type: 'sports', optional: true },
          { key: 'required_credentials', label: 'Required credential', type: 'multi', optional: true, options: [{ value: 'coach_badge', label: 'Verified coach credential' }] },
          { key: 'state', label: 'Status', type: 'chips', options: [{ value: 'active', label: 'Active' }, { value: 'leave', label: 'On leave' }, { value: 'suspended', label: 'Suspended' }, { value: 'ended', label: 'Ended' }] },
          { key: 'staff_ref', label: 'Staff reference', optional: true }, { key: 'notes', label: 'HR notes (encrypted, owners/admins only)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { const t = templates.find((x) => x.key === v.template); await api.post(`/organisations/${o.id}/academy/staff/${edit.user_id}`, { ...v, permissions: v.permissions?.length ? v.permissions : (edit.permissions?.length ? [] : t?.permissions ?? []), staff_ref: v.staff_ref || undefined, row_version: edit.row_version }); st.reload(); return 'Saved. Access changes apply on their next request.'; }} />
      <FormSheet visible={shift} onClose={() => setShift(false)} title="Roster a shift" submitLabel="Roster" fields={[
        { key: 'user_id', label: 'Who', type: 'entity', entityKind: 'person', options: staff.map((p) => ({ id: p.user_id, display_name: p.display_name, handle: p.job_title ?? '' })) }, { key: 'title', label: 'What (e.g. registration desk)' },
        { key: 'date', label: 'Date', type: 'date' }, { key: 'from', label: 'From', type: 'time' }, { key: 'to', label: 'Until', type: 'time' }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/shifts`, { user_id: v.user_id, title: v.title, starts_at: localToIso(v.date, v.from, deviceTz), ends_at: localToIso(v.date, v.to, deviceTz), timezone: deviceTz }); shifts.reload(); return 'Rostered. They have been asked to confirm.'; }} />
    </View>
  );
}

// ================================================================================== TIME & PAY
function Timesheets({ o, toast, mgr }) {
  const [status, setStatus] = useState(mgr ? 'submitted' : undefined), [fix, setFix] = useState(null), [add, setAdd] = useState(false);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/timesheets`, { status }), [o.id, status]);
  const members = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  const decide = async (t, action, reason) => { try { await api.post(`/academy/timesheets/${t.id}/decision`, { action, reason }); toast(action === 'approve' ? 'Approved' : action === 'reject' ? 'Sent back' : 'Reopened'); } catch (e) { toast(explain(e)); } finally { d.reload(); } };
  const people = (members.data ?? []).map((m) => ({ id: m.id ?? m.user_id, display_name: m.display_name, handle: m.handle }));
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[['submitted', 'To approve'], ['approved', 'Approved'], ['rejected', 'Sent back'], ['open', 'Open']].map(([k, l]) => <Chip key={k} label={l} active={status === k} onPress={() => setStatus(k)} />)}<Chip label="All" active={!status} onPress={() => setStatus(undefined)} /><Btn small title="＋ Add time" color={c.paper} ink={c.ink} onPress={() => setAdd(true)} /></View>
      {!d.data ? <Loading /> : d.data.length ? d.data.map((t) => (
        <Card key={t.id} pad={12}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{t.display_name} · {t.label ?? t.kind}</T><Tag label={t.status} color={t.status === 'approved' ? c.lime : t.status === 'rejected' ? c.orangeSoft : undefined} /></View>
          <T size={13} color={c.mute}>{String(t.work_date).slice(0, 10)} · {t.minutes != null ? hrs(t.minutes) : 'no finished time'}{t.scheduled_start ? ` · scheduled ${hrs(Math.round((new Date(t.scheduled_end) - new Date(t.scheduled_start)) / 60000))}` : ''}{t.break_min ? ` · ${t.break_min} min break` : ''}</T>
          {t.exceptions.map((x) => <T key={x} size={12} color={c.red}>⚠ {x}</T>)}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {mgr && t.status === 'submitted' ? <><Btn small title="Approve" onPress={() => decide(t, 'approve')} /><Btn small title="Send back" color={c.paper} ink={c.ink} onPress={() => setFix({ t, action: 'reject' })} /></> : null}
            {mgr && t.status === 'approved' && !t.payroll_run_id ? <Btn small title="Reopen" color={c.paper} ink={c.ink} onPress={() => setFix({ t, action: 'reopen' })} /> : null}
            {t.status !== 'approved' ? <Btn small title="Correct times" color={c.paper} ink={c.ink} onPress={() => setFix({ t, action: 'adjust' })} /> : null}
            {t.payroll_run_id ? <Tag label="In a payroll run" /> : null}
          </View>
        </Card>
      )) : <Empty emoji="⏱️" title="No timesheets here" sub="Time appears when staff clock in to a session or add a shift." />}
      <FormSheet visible={!!fix} onClose={() => setFix(null)} title={fix?.action === 'adjust' ? 'Correct this timesheet' : fix?.action === 'reject' ? 'Send back with a reason' : 'Reopen with a reason'} submitLabel="Save"
        initial={fix?.t ? { break_min: fix.t.break_min } : {}} fields={fix?.action === 'adjust' ? [{ key: 'break_min', label: 'Unpaid break (minutes)', type: 'stepper', min: 0, max: 240, step: 5, default: 0 }, { key: 'reason', label: 'Why? (kept in the history)' }] : [{ key: 'reason', label: 'Reason' }]}
        onSubmit={async (v) => { if (fix.action === 'adjust') await api.post(`/academy/timesheets/${fix.t.id}/adjust`, { row_version: fix.t.row_version, reason: v.reason, break_min: v.break_min }); else await api.post(`/academy/timesheets/${fix.t.id}/decision`, { action: fix.action, reason: v.reason }); d.reload(); return 'Saved. The history keeps every change.'; }} />
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add time worked" submitLabel="Submit" fields={[
        ...(mgr ? [{ key: 'user_id', label: 'For', type: 'entity', entityKind: 'person', optional: true, options: people }] : []), { key: 'label', label: 'What (e.g. registration desk)' }, { key: 'date', label: 'Date', type: 'date' },
        { key: 'from', label: 'Started', type: 'time' }, { key: 'to', label: 'Finished', type: 'time' }, { key: 'break_min', label: 'Unpaid break (minutes)', type: 'stepper', min: 0, max: 240, step: 5, default: 0 }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/timesheets`, { idempotency_key: uid(), user_id: v.user_id || undefined, label: v.label, clock_in: localToIso(v.date, v.from, deviceTz), clock_out: localToIso(v.date, v.to, deviceTz), break_min: v.break_min }); d.reload(); return 'Submitted for approval'; }} />
    </View>
  );
}

function Terms({ o, toast }) {
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/comp-rules`), [o.id]);
  const members = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`).catch(() => []), [o.id]);
  const [add, setAdd] = useState(false), [adj, setAdj] = useState(false);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  const people = (members.data ?? []).map((m) => ({ id: m.id ?? m.user_id, display_name: m.display_name, handle: m.handle }));
  const MODEL = { hourly: 'per hour', per_session: 'per session', day_rate: 'per day', programme_fixed: 'per programme', volunteer: 'unpaid' };
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="＋ New compensation term" onPress={() => setAdd(true)} /><Btn small title="＋ Bonus / allowance" color={c.paper} ink={c.ink} onPress={() => setAdj(true)} /></View>
      <T size={12} color={c.mute}>A new term starts on a date you choose and never changes pay already approved. Each term is in one currency.</T>
      {!d.data ? <Loading /> : d.data.length ? d.data.map((r) => <Row key={r.id} title={`${r.display_name} · ${r.model === 'volunteer' ? 'Volunteer' : `${moneyIn(r.rate_minor, r.currency)} ${MODEL[r.model]}`}`} sub={`from ${String(r.effective_from).slice(0, 10)}${r.role !== 'any' ? ` · ${r.role} only` : ''}${r.programme ? ` · ${r.programme}` : ''}${r.overtime_bp > 10000 ? ` · overtime ×${r.overtime_bp / 10000}` : ''}`} />) : <Empty emoji="💼" title="No terms yet" sub="Add how each person is compensated, then run payroll from approved time." />}
      <FormSheet visible={add} onClose={() => setAdd(false)} title="New compensation term" submitLabel="Save term" initial={{ model: 'hourly', role: 'any', overtime: 1 }} fields={[
        { key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', options: people },
        { key: 'model', label: 'Basis', type: 'chips', options: [{ value: 'hourly', label: 'Hourly' }, { value: 'per_session', label: 'Per session' }, { value: 'day_rate', label: 'Day rate' }, { value: 'programme_fixed', label: 'Fixed per programme' }, { value: 'volunteer', label: 'Volunteer (unpaid)' }] },
        { key: 'role', label: 'Applies to', type: 'chips', options: [{ value: 'any', label: 'Any role' }, { value: 'lead', label: 'Lead coach' }, { value: 'assistant', label: 'Assistant' }, { value: 'duty', label: 'Duty' }] },
        { key: 'currency', label: 'Currency', type: 'currency' }, { key: 'rate_minor', label: 'Rate', type: 'money', currency: (v) => v.currency, show: (v) => v.model !== 'volunteer' },
        { key: 'overtime', label: 'Overtime multiplier (hourly, beyond scheduled time)', type: 'stepper', min: 1, max: 4, step: 0.25, default: 1, show: (v) => v.model === 'hourly' },
        { key: 'programme_id', label: 'Only for programme', type: 'chips', optional: true, options: (progs.data ?? []).map((p) => ({ value: p.id, label: p.title })) }, { key: 'effective_from', label: 'Starts on', type: 'date' }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/comp-rules`, { user_id: v.user_id, model: v.model, role: v.role, currency: v.currency, rate_minor: v.rate_minor ?? 0, overtime_multiplier: v.overtime ?? 1, programme_id: v.programme_id || undefined, effective_from: v.effective_from }); d.reload(); return 'Term saved'; }} />
      <FormSheet visible={adj} onClose={() => setAdj(false)} title="Bonus, allowance or deduction" submitLabel="Add" initial={{ kind: 'add' }} fields={[
        { key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', options: people }, { key: 'currency', label: 'Currency', type: 'currency' }, { key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'add', label: 'Bonus / allowance' }, { value: 'deduct', label: 'Deduction' }] }, { key: 'amount_minor', label: 'Amount', type: 'money', currency: (v) => v.currency },
        { key: 'on_date', label: 'For the date', type: 'date' }, { key: 'reason', label: 'Reason' }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/pay-adjustments`, { user_id: v.user_id, currency: v.currency, amount_minor: v.kind === 'deduct' ? -v.amount_minor : v.amount_minor, on_date: v.on_date, reason: v.reason }); return 'Added. It joins the next run for that period.'; }} />
    </View>
  );
}

function Payroll({ o, toast }) {
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/payroll`), [o.id]);
  const [make, setMake] = useState(false), [prev, setPrev] = useState(null), [run, setRun] = useState(null), [csv, setCsv] = useState(null), [busy, setBusy] = useState(false);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  const open = async (id) => { try { setRun(await api.get(`/academy/payroll/${id}`)); } catch (e) { toast(explain(e)); } };
  const lines = (ls, cur) => ls.map((l) => <Row key={l.user_id} title={l.display_name} sub={`${hrs(l.minutes)} worked${l.scheduled_minutes ? ` of ${hrs(l.scheduled_minutes)} scheduled` : ''} · base ${moneyIn(l.base_minor, cur)}${l.adjustments_minor ? ` · adjustments ${moneyIn(l.adjustments_minor, cur)}` : ''}`} right={<T weight="800">{moneyIn(l.gross_minor, cur)}</T>} />);
  return (
    <View style={{ gap: 10 }}>
      <Btn small title="＋ New payroll run" onPress={() => setMake(true)} style={{ alignSelf: 'flex-start' }} />
      <Card pad={12} color={c.sunSoft}><T size={12}>A run is a statement of what the academy owes for approved work, per period and currency. It moves no money and does not calculate tax, pension or other statutory deductions: export it for your payroll or bank process.</T></Card>
      {!d.data ? <Loading /> : d.data.length ? d.data.map((r) => <Row key={r.id} title={`${String(r.period_start).slice(0, 10)} → ${String(r.period_end).slice(0, 10)} · ${r.currency}`} sub={`${r.people} people · ${r.status}`} right={<T weight="800">{moneyIn(r.total_minor, r.currency)}</T>} onPress={() => open(r.id)} />) : <Empty emoji="🧾" title="No payroll runs yet" sub="Approve timesheets and add compensation terms, then create a run." />}
      <FormSheet visible={make} onClose={() => setMake(false)} title="New payroll run" submitLabel="Preview" fields={[{ key: 'currency', label: 'Currency (one per run)', type: 'currency' }, { key: 'from', label: 'Period', type: 'daterange', toKey: 'to' }]}
        onSubmit={async (v) => { const r = await api.post(`/organisations/${o.id}/academy/payroll`, { currency: v.currency, period_start: v.from, period_end: v.to, idempotency_key: uid() }); setPrev({ ...v, r, key: uid() }); return 'Preview ready'; }} />
      <Sheet visible={!!prev} onClose={() => setPrev(null)} title="Preview: nothing is saved yet">
        {prev ? (
          <View style={{ gap: 8 }}>
            <T weight="800" size={18}>{moneyIn(prev.r.total_minor, prev.currency)} <T size={13} color={c.mute}>for {prev.r.lines.length} people</T></T>
            {lines(prev.r.lines, prev.currency)}
            {prev.r.unpriced.length ? <Card pad={12} color={c.orangeSoft}><T weight="800">⚠ {prev.r.unpriced.length} approved timesheet(s) left out</T>{prev.r.unpriced.map((u) => <T key={u.timesheet_id} size={12}>• {u.display_name} {u.work_date}: {u.reason}</T>)}</Card> : null}
            <Btn title="Create draft run" disabled={!prev.r.lines.length} loading={busy} onPress={async () => { setBusy(true); try { await api.post(`/organisations/${o.id}/academy/payroll`, { currency: prev.currency, period_start: prev.from, period_end: prev.to, idempotency_key: prev.key, commit: true }); toast('Draft run created. Approve it when finance has checked it.'); setPrev(null); d.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } }} />
          </View>
        ) : null}
      </Sheet>
      <Sheet visible={!!run} onClose={() => setRun(null)} title={run ? `${String(run.period_start).slice(0, 10)} → ${String(run.period_end).slice(0, 10)} · ${run.currency}` : ''}>
        {run ? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Tag label={run.status === 'approved' ? '✓ Approved' : run.status} color={run.status === 'approved' ? c.lime : undefined} /><T weight="800" size={18}>{moneyIn(run.total_minor, run.currency)}</T></View>
            {lines(run.lines, run.currency)}
            <T size={12} color={c.mute}>{run.limitations}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {run.status === 'draft' ? <><Btn small title="Approve" onPress={async () => { try { setRun(await api.post(`/academy/payroll/${run.id}/approve`, { row_version: run.row_version })); toast('Approved and frozen'); } catch (e) { toast(explain(e)); } finally { d.reload(); } }} /><Btn small title="Discard draft" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/academy/payroll/${run.id}/void`); toast('Discarded. The timesheets are free again.'); setRun(null); } catch (e) { toast(explain(e)); } finally { d.reload(); } }} /></> : null}
              {run.status === 'approved' ? <Btn small title="Export CSV" onPress={async () => { try { const x = await api.get(`/academy/payroll/${run.id}/export`); saveCsv(x.filename, x.csv, setCsv); toast('Exported. This download is logged.'); } catch (e) { toast(explain(e)); } }} /> : null}
            </View>
            {csv ? <T size={11} selectable>{csv}</T> : null}
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}

function Pay({ o, toast, perms }) {
  const [sub, setSub] = useState('time');
  const opts = [{ value: 'time', label: 'Timesheets' }, ...(perms.includes('payroll') ? [{ value: 'terms', label: 'Terms' }, { value: 'payroll', label: 'Payroll' }] : [])];
  return (
    <View style={{ gap: 12 }}>
      <Seg options={opts} value={sub} onChange={setSub} color={c.violet} />
      {sub === 'time' ? <Timesheets o={o} toast={toast} mgr={perms.includes('timesheets')} /> : sub === 'terms' ? <Terms o={o} toast={toast} /> : <Payroll o={o} toast={toast} />}
    </View>
  );
}

// ================================================================================== ANALYTICS
function Insights({ o }) {
  const from = addDays(todayIn(deviceTz), -28), to = todayIn(deviceTz);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/analytics`, { from, to }), [o.id]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const a = d.data;
  return (
    <View style={{ gap: 12 }}>
      <T color={c.mute}>Last 4 weeks. Operational measures only; programme profitability lives with finance.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label="Delivered" value={a.sessions.delivered} sub={`of ${a.sessions.planned} planned`} /><Kpi label="Cancelled" value={a.sessions.cancelled} sub={a.sessions.cancellation_rate_pct != null ? `${a.sessions.cancellation_rate_pct}% of planned` : ''} /><Kpi label="Rescheduled" value={a.sessions.rescheduled} sub={a.sessions.reschedule_rate_pct != null ? `${a.sessions.reschedule_rate_pct}%` : ''} /><Kpi label="Substitutions" value={a.substitutions} />
      </View>
      {a.staff_hours ? <Fact k="Staff hours" v={`${a.staff_hours.worked_hours} h worked vs ${a.staff_hours.scheduled_hours} h scheduled for sessions${a.staff_hours.unscheduled_hours ? ` · plus ${a.staff_hours.unscheduled_hours} h of shifts and other work` : ''}`} /> : null}
      <Block title="Attendance by group">{a.attendance_by_group.length ? a.attendance_by_group.map((g) => <Row key={g.cohort_id} title={g.cohort} sub={`${g.present} of ${g.marked} marked present · ${g.late} late`} right={<T weight="800">{g.attendance_rate_pct ?? '–'}%</T>} />) : <T size={13} color={c.mute}>No attendance recorded yet.</T>}</Block>
      <Block title="Absence by weekday">{a.absence_by_weekday.map((w) => <T key={w.weekday} size={13}>{DAY[w.weekday]}: {w.absences} of {w.marked} ({w.absence_rate_pct}%)</T>)}</Block>
      <Block title="Coach workload">{a.coach_utilisation.map((x) => <T key={x.user_id} size={13}>{x.display_name}: {x.sessions} sessions · {hrs(x.scheduled_minutes)}</T>)}</Block>
      <Block title="Staffing exceptions">{a.staffing_exceptions.length ? a.staffing_exceptions.map((x) => <T key={x.session_id} size={13} color={c.red}>⚠ {x.title}: {x.issues.join('; ')}</T>) : <T size={13} color={c.mute}>None in this period.</T>}</Block>
      <Block title="Venue use">{a.venue_usage.length ? a.venue_usage.map((v) => <T key={v.venue_id} size={13}>{v.venue}: {v.sessions} sessions · {hrs(v.minutes)}</T>) : <T size={13} color={c.mute}>No venue bookings linked yet.</T>}</Block>
      {a.compensation_by_programme ? <Block title="Approved compensation by programme">{a.compensation_by_programme.length ? a.compensation_by_programme.map((x, i) => <T key={i} size={13}>{x.programme}: {moneyIn(x.amount_minor, x.currency)} ({x.currency})</T>) : <T size={13} color={c.mute}>No approved payroll yet. Amounts are never added across currencies.</T>}</Block> : null}
    </View>
  );
}

// ================================================================================== MODULE
export function Operations({ o, role, toast }) {
  const { push } = useNav();
  const probe = useLoad(() => api.get(`/organisations/${o.id}/academy/today`).catch((e) => ({ error: e })), [o.id]);
  const [tab, setTab] = useState('today');
  if (!probe.data) return <Loading />;
  if (probe.data.error) return <LoadError error={probe.data.error} />;
  const perms = probe.data.permissions ?? [];
  const has = (...p) => p.some((x) => perms.includes(x));
  const admin = role === 'owner' || role === 'admin';
  const tabs = [
    ...(has('schedule', 'attendance', 'roster') ? [['today', 'Today'], ['week', 'Week']] : []),
    ...(has('schedule', 'timesheets') ? [['staff', 'Staff & leave']] : []),
    ['pay', 'Time & pay'], ...(has('schedule') ? [['insights', 'Insights']] : []),
  ];
  const cur = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{tabs.map(([k, l]) => <Chip key={k} label={l} active={cur === k} onPress={() => setTab(k)} />)}<Btn small title="My academy week" color={c.paper} ink={c.ink} onPress={() => push('AcademyAgenda')} /></View>
      {cur === 'today' ? <Today o={o} toast={toast} setTab={setTab} /> : cur === 'week' ? <Week o={o} toast={toast} perms={perms} cohorts={probe.data.cohorts ?? []} /> : cur === 'staff' ? <StaffTab o={o} toast={toast} admin={admin} perms={perms} /> : cur === 'pay' ? <Pay o={o} toast={toast} perms={perms} /> : <Insights o={o} />}
    </View>
  );
}
