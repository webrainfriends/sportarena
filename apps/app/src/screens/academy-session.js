// Academy OS 2/3, the session level: one session (attendance, staff, venue, details & history), the coach's phone-first agenda and the
// athlete / guardian view of their sessions. Every action calls the server, which re-checks the caller's access on every request.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Loading, Row, Screen, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { c } from '../theme';
import { dateTimeIn, localDate, localHHMM, localToIso, timeIn } from '../vtime';
import { Block, Fact, Timeline } from './academy-ui';
import { CourtPicker } from './training-venue';

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const STATUS = [['present', 'Present'], ['late', 'Late'], ['left_early', 'Left early'], ['absent', 'Absent'], ['excused', 'Excused']];
const MARK = { expected: 'Expected', present: 'Present', late: 'Late', left_early: 'Left early', absent: 'Absent', excused: 'Excused', not_held: 'Not held' };
const MARK_ICON = { expected: '•', present: '✓', late: '⏱', left_early: '↪', absent: '✕', excused: '✉', not_held: '—' };
const LEVEL = { compliant: ['✓', 'Staffing meets the rules', c.paper], warning: ['⚠', 'Staffing needs attention', c.sunSoft], blocked: ['⛔', 'Staffing rule not met: cannot publish', c.orangeSoft] };
const REASONS = [['illness', 'Not well'], ['family', 'Family'], ['travel', 'Travel'], ['school', 'School'], ['injury_non_clinical', 'Minor knock'], ['other', 'Other']];
const ROLE = { lead: 'Lead coach', assistant: 'Assistant', duty: 'Duty' };
const SSTAT = { draft: 'Draft', published: 'Published', cancelled: 'Cancelled', completed: 'Completed' };
const tzOf = (s) => s.timezone ?? 'UTC';

/** Plain, non-colour-only banner for the staffing check, one line per requirement. */
export function Compliance({ compliance, conflicts = [] }) {
  const [icon, text, tone] = LEVEL[compliance.level];
  const bad = compliance.checks.filter((x) => x.severity !== 'ok');
  return (
    <View style={{ gap: 8 }}>
      <View accessible accessibilityLabel={`${text}. ${bad.map((b) => b.message).join('. ')}`} style={{ padding: 12, borderRadius: 16, backgroundColor: tone, gap: 4 }}>
        <T weight="800">{icon} {text}</T>
        {bad.map((b) => <T key={b.code} size={13}>{b.severity === 'blocked' ? '⛔' : '⚠'} {b.message}</T>)}
        {compliance.checks.filter((x) => x.severity === 'ok').map((b) => <T key={b.code} size={12} color={c.mute}>✓ {b.message}</T>)}
        <T size={11} color={c.mute}>Rules are your academy's own operating policy; they are not a statement of legal compliance.</T>
      </View>
      {conflicts.length ? (
        <View style={{ padding: 12, borderRadius: 16, backgroundColor: c.orangeSoft, gap: 4 }} accessible accessibilityLabel={`${conflicts.length} conflicts`}>
          <T weight="800">⛔ {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} to resolve before publishing</T>
          {conflicts.map((x, i) => <T key={i} size={13}>• {x.message}</T>)}
        </View>
      ) : null}
    </View>
  );
}

// ================================================================================== ATTENDANCE
function Attendance({ s, reload, toast }) {
  const r = useLoad(() => api.get(`/academy/sessions/${s.id}/roster`), [s.id]);
  const [fix, setFix] = useState(null), [busy, setBusy] = useState(null);
  if (r.error) return <LoadError error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const { roster, counts, expected } = r.data;
  const open = s.status === 'published' || s.status === 'completed';
  const mark = async (row, status, reason) => {
    setBusy(row.user_id);
    try {
      await api.post(`/academy/sessions/${s.id}/attendance`, { idempotency_key: uid(), reason, entries: [{ user_id: row.user_id, status }] });
      toast(`${row.display_name}: ${MARK[status]}`);
    } catch (e) { toast(explain(e)); } finally { setBusy(null); r.reload(); reload(); }
  };
  const tap = (row, status) => (row.status !== 'expected' && row.status !== status ? setFix({ row, status }) : mark(row, status));
  const everyone = async () => {
    const todo = roster.filter((x) => x.status === 'expected');
    if (!todo.length) return;
    try { await api.post(`/academy/sessions/${s.id}/attendance`, { idempotency_key: uid(), bulk: true, entries: todo.map((x) => ({ user_id: x.user_id, status: 'present' })) }); toast(`${todo.length} marked present`); } catch (e) { toast(explain(e)); } finally { r.reload(); reload(); }
  };
  return (
    <View style={{ gap: 10 }}>
      {!open ? <Empty emoji="🗓️" title={s.status === 'cancelled' ? 'Session cancelled' : 'Publish the session first'} sub={s.status === 'cancelled' ? 'Attendance shows "not held".' : 'Attendance opens once the session is published.'} /> : null}
      <View accessible accessibilityLabel={`${expected} expected. ${STATUS.map(([k, l]) => `${counts[k]} ${l}`).join(', ')}`} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Tag label={`${expected} expected`} />{STATUS.filter(([k]) => counts[k]).map(([k, l]) => <Tag key={k} label={`${counts[k]} ${l.toLowerCase()}`} />)}
      </View>
      {open ? <Btn small title="Mark everyone still expected as present" color={c.paper} ink={c.ink} onPress={everyone} style={{ alignSelf: 'flex-start' }} /> : null}
      {roster.length ? roster.map((row) => (
        <View key={row.user_id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T weight="700" style={{ flex: 1 }}>{row.display_name}{row.guest ? '  · make-up guest' : ''}</T>
            <Tag label={`${MARK_ICON[row.status]} ${MARK[row.status]}`} color={['present', 'late'].includes(row.status) ? c.lime : row.status === 'expected' ? c.violetSoft : c.sunSoft} />
          </View>
          {open ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {STATUS.map(([k, l]) => <Chip key={k} label={l} active={row.status === k} onPress={busy ? undefined : () => tap(row, k)} />)}
            </View>
          ) : null}
        </View>
      )) : <Empty emoji="👥" title="Nobody is enrolled in this group" sub="Enrol athletes in the cohort and they appear here." />}
      <T size={12} color={c.mute}>This records attendance at the session. Arrival at the venue is recorded by the venue's own check-in and is not counted here. Clocking in as staff never marks anyone present.</T>
      <FormSheet visible={!!fix} onClose={() => setFix(null)} title={fix ? `Correct ${fix.row.display_name}: ${MARK[fix.row.status]} → ${MARK[fix.status]}` : ''} submitLabel="Save correction" fields={[{ key: 'reason', label: 'Why are you changing it?' }]}
        onSubmit={async (v) => { await api.post(`/academy/sessions/${s.id}/attendance`, { idempotency_key: uid(), reason: v.reason, entries: [{ user_id: fix.row.user_id, status: fix.status }] }); r.reload(); reload(); return 'Corrected. The history keeps both marks.'; }} />
    </View>
  );
}

// ================================================================================== STAFF
function Staff({ s, reload, toast, me, openFind }) {
  const [add, setAdd] = useState(false), [who, setWho] = useState([]), [role, setRole] = useState('assistant'), [replace, setReplace] = useState(null), [find, setFind] = useState(openFind ?? false);
  const members = useLoad(() => api.get(`/organisations/${s.organisation_id}/members`).catch(() => []), [s.organisation_id]);
  const rec = useLoad(() => (find ? api.get(`/academy/sessions/${s.id}/recommendations`, { role: replace ? 'lead' : role }) : Promise.resolve(null)), [find, s.id, role, replace?.user_id]);
  const people = (members.data ?? []).filter((m) => ['owner', 'admin', 'coach', 'staff'].includes(m.org_role)).map((m) => ({ id: m.id ?? m.user_id, label: m.display_name, sub: `@${m.handle}`, emoji: m.avatar_emoji, color: m.avatar_color }));
  const live = s.staff.filter((x) => !['declined', 'removed'].includes(x.status));
  const done = async (fn, msg) => { try { await fn(); toast(msg); } catch (e) { toast(explain(e)); } finally { reload(); } };
  const assign = (userId, r, replaces) => done(() => api.post(`/academy/sessions/${s.id}/staff`, { user_id: userId, role: r, replaces }), 'Assigned. They have been asked to confirm.');
  const mine = live.find((x) => x.user_id === me);
  return (
    <View style={{ gap: 10 }}>
      {mine && mine.status === 'assigned' ? (
        <Card pad={12} color={c.sunSoft}><T weight="800">You were assigned as {ROLE[mine.role].toLowerCase()}</T><View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Confirm" onPress={() => done(() => api.post(`/academy/sessions/${s.id}/staff/respond`, { accept: true }), 'Confirmed')} /><Btn small title="Can't make it" color={c.paper} ink={c.ink} onPress={() => done(() => api.post(`/academy/sessions/${s.id}/staff/respond`, { accept: false, reason: 'Declined' }), 'Declined. The academy was told.')} /></View></Card>
      ) : null}
      {live.map((x) => (
        <Row key={x.id} title={x.display_name} sub={`${ROLE[x.role]}${x.duty_label ? ` · ${x.duty_label.replace(/_/g, ' ')}` : ''}`} right={<Tag label={x.status === 'confirmed' ? '✓ Confirmed' : 'Awaiting reply'} color={x.status === 'confirmed' ? c.lime : c.sunSoft} />}
          onPress={s.canEdit ? () => setReplace(x) : undefined} />
      ))}
      {!live.length ? <Empty emoji="🧑‍🏫" title="Nobody is assigned" sub="Assign a lead coach and any assistants or duty cover." /> : null}
      {s.staff.filter((x) => x.status === 'declined').map((x) => <T key={x.id} size={12} color={c.mute}>↩ {x.display_name} declined</T>)}
      {s.canEdit ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn small title="＋ Assign" onPress={() => setAdd(true)} /><Btn small title="Find a substitute" color={c.paper} ink={c.ink} onPress={() => { setReplace(null); setFind(true); }} />
        </View>
      ) : null}
      {find ? (
        <Block title={replace ? `Replace ${replace.display_name}` : 'Suggested people'} right={<Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => { setFind(false); setReplace(null); }} />}>
          <T size={12} color={c.mute}>Ranked on facts only: availability, clashes, scope, credential and workload. You confirm every assignment.</T>
          {!rec.data ? <Loading /> : rec.data.candidates.map((cd) => (
            <View key={cd.user_id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{cd.display_name}{cd.job_title ? ` · ${cd.job_title}` : ''}</T><Tag label={cd.eligible ? '✓ Available' : '✕ Not available'} color={cd.eligible ? c.lime : c.orangeSoft} /></View>
              {cd.reasons.map((x, i) => <T key={i} size={12} color={c.mute}>+ {x}</T>)}
              {cd.concerns.map((x, i) => <T key={i} size={12} color={c.red}>− {x}</T>)}
              {cd.eligible ? <Btn small title={replace ? `Assign instead of ${replace.display_name}` : 'Assign'} onPress={() => assign(cd.user_id, replace ? replace.role : role, replace?.user_id).then(() => { setFind(false); setReplace(null); })} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          ))}
        </Block>
      ) : null}
      <Sheet visible={add} onClose={() => setAdd(false)} title="Assign staff">
        <View style={{ gap: 10 }}>
          <EntityPicker label="Person" value={who} onChange={setWho} options={people} />
          <T weight="800" size={13}>Role</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{Object.entries(ROLE).map(([k, l]) => <Chip key={k} label={l} active={role === k} onPress={() => setRole(k)} />)}</View>
          <Btn title="Assign" disabled={!who.length} onPress={() => assign(who[0].id, role).then(() => { setAdd(false); setWho([]); })} />
        </View>
      </Sheet>
      <Sheet visible={!!replace && !find} onClose={() => setReplace(null)} title={replace?.display_name ?? ''}>
        <View style={{ gap: 8 }}>
          <Btn title="Find a substitute" onPress={() => setFind(true)} />
          <Btn title="Remove from this session" color={c.paper} ink={c.red} onPress={() => done(() => api.del(`/academy/sessions/${s.id}/staff/${replace.user_id}`), 'Removed').then(() => setReplace(null))} />
        </View>
      </Sheet>
    </View>
  );
}

// ================================================================================== VENUE
function Venue({ s, reload, toast }) {
  const [venueId, setVenueId] = useState(null), [resourceId, setResourceId] = useState(null), [busy, setBusy] = useState(false);
  const v = s.venue;
  const book = async () => { setBusy(true); try { const r = await api.post(`/academy/sessions/${s.id}/venue`, { resource_id: resourceId }); toast(r.reservation?.awaiting_payment ? 'Court reserved. Payment is due on the booking.' : 'Court booked'); } catch (e) { toast(explain(e)); } finally { setBusy(false); reload(); } };
  if (v) {
    return (
      <View style={{ gap: 10 }}>
        <Card pad={14}>
          <T weight="800" size={16}>📍 {v.venue_name} · {v.resource_name}</T>
          <T color={c.mute} size={13}>{v.booking_status === 'confirmed' ? 'Booking confirmed' : `Booking ${v.booking_status}`} · booked through the venue's own reservation system, so its price and cancellation terms apply.</T>
        </Card>
        {s.canEdit ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Btn small title="Open booking" onPress={() => s.nav.push('Reservation', { id: v.reservation_id })} />
            <Btn small title="Detach from this session" color={c.paper} ink={c.ink} onPress={async () => { try { await api.del(`/academy/sessions/${s.id}/venue`); toast('Detached. The booking itself is unchanged.'); } catch (e) { toast(explain(e)); } finally { reload(); } }} />
          </View>
        ) : null}
        <T size={12} color={c.mute}>To change or cancel the booking use the booking itself, so refund and change rules apply.</T>
      </View>
    );
  }
  if (!s.canEdit) return <Empty emoji="📍" title="No venue booked yet" />;
  return (
    <View style={{ gap: 10 }}>
      <T color={c.mute} size={13}>Pick a venue and court. The court is checked against opening hours, blocks and other bookings, and is never taken from anyone who already booked it.</T>
      <CourtPicker sport={s.sport} window={{ from: s.starts_at, to: s.ends_at }} venueId={venueId} resourceId={resourceId} onVenue={setVenueId} onResource={setResourceId} />
      <Btn title="Reserve this court" disabled={!resourceId} loading={busy} onPress={book} />
    </View>
  );
}

// ================================================================================== DETAILS
function Details({ s, reload, toast, onPublished }) {
  const [move, setMove] = useState(false), [cancel, setCancel] = useState(false), [note, setNote] = useState(false);
  const tz = tzOf(s);
  const publish = async (ack) => {
    try {
      const r = await api.post(`/organisations/${s.organisation_id}/academy/sessions/publish`, { session_ids: [s.id], acknowledge_warnings: ack });
      const x = r.results[0];
      if (x.published) { toast('Published. Staff, athletes and guardians have been told.'); onPublished?.(); } else toast(x.reason === 'staffing warnings need acknowledgement' ? 'Staffing warnings need your OK: use "Publish anyway".' : `Not published: ${x.reason}`);
    } catch (e) { toast(explain(e)); } finally { reload(); }
  };
  return (
    <View style={{ gap: 12 }}>
      <Block title="This session">
        <Fact k="Group" v={s.cohort_name} /><Fact k="Programme" v={s.programme_title} /><Fact k="Sport" v={s.sport} /><Fact k="Type" v={s.delivery_type.replace('_', ' ')} />
        <Fact k="When" v={`${dateTimeIn(s.starts_at, tz)} – ${timeIn(s.ends_at, tz)} (${tz})`} /><Fact k="Capacity" v={s.capacity ? `${s.capacity} places` : 'No limit'} />
        <Fact k="Self check-in" v={s.self_checkin ? 'Allowed' : 'Off'} />{s.status === 'cancelled' ? <Fact k="Cancelled because" v={s.cancel_reason} /> : null}
      </Block>
      {s.canEdit && ['draft', 'published'].includes(s.status) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {s.status === 'draft' ? <Btn small title="Publish" onPress={() => publish(false)} /> : null}
          {s.status === 'draft' && s.compliance.level === 'warning' ? <Btn small title="Publish anyway" color={c.paper} ink={c.ink} onPress={() => publish(true)} /> : null}
          <Btn small title="Move / reschedule" color={c.paper} ink={c.ink} onPress={() => setMove(true)} />
          <Btn small title="Notify the group" color={c.paper} ink={c.ink} onPress={() => setNote(true)} />
          <Btn small title="Cancel session" color={c.paper} ink={c.red} onPress={() => setCancel(true)} />
        </View>
      ) : null}
      {s.canEdit && s.status === 'cancelled' ? <Btn small title="Add a make-up session" color={c.paper} ink={c.ink} onPress={() => s.nav.push('Org', { id: s.organisation_id })} /> : null}
      <Block title="History">
        <Timeline items={[...s.changes].reverse().map((ch) => ({ title: ch.kind.replace(/_/g, ' '), sub: `${new Date(ch.created_at).toLocaleString()}${ch.reason ? ` · ${ch.reason}` : ''}` }))} />
      </Block>
      <FormSheet visible={move} onClose={() => setMove(false)} title="Move this session" submitLabel="Move" initial={{ date: localDate(s.starts_at, tz), time: localHHMM(s.starts_at, tz), duration_min: Math.round((new Date(s.ends_at) - new Date(s.starts_at)) / 60000) }}
        fields={[{ key: 'date', label: 'New date', type: 'date' }, { key: 'time', label: 'Start time', type: 'time' }, { key: 'duration_min', label: 'Length (minutes)', type: 'stepper', min: 10, max: 600, step: 5, default: 60 }, { key: 'reason', label: 'Reason (shown to staff and families)' }]}
        onSubmit={async (v) => { const r = await api.patch(`/academy/sessions/${s.id}`, { row_version: s.row_version, starts_at: localToIso(v.date, v.time, tz), duration_min: v.duration_min, reason: v.reason }); reload(); return r.notice ?? 'Moved. Everyone affected has been told.'; }} />
      <FormSheet visible={cancel} onClose={() => setCancel(false)} title="Cancel this session" submitLabel="Cancel session" color={c.red} fields={[{ key: 'reason', label: 'Reason (shown to families)' }]}
        onSubmit={async (v) => { await api.post(`/academy/sessions/${s.id}/cancel`, { reason: v.reason }); reload(); return 'Cancelled. A venue booking, if any, is unchanged: cancel it from the booking.'; }} />
      <FormSheet visible={note} onClose={() => setNote(false)} title="Message the group" submitLabel="Send" fields={[{ key: 'title', label: 'Title' }, { key: 'body', label: 'Message', type: 'multiline' }, { key: 'include_staff', label: 'Also send to assigned staff', type: 'switch', default: false }]}
        onSubmit={async (v) => { const r = await api.post(`/academy/sessions/${s.id}/notify`, v); return `Sent to ${r.recipients} people`; }} />
    </View>
  );
}

// ================================================================================== SESSION SCREEN
export function AcademySession({ id, tab: want, find }) {
  const { toast, user } = useSession();
  const nav = useNav();
  const d = useLoad(() => api.get(`/academy/sessions/${id}`), [id]);
  const [tab, setTab] = useState(want ?? 'attendance');
  const [cover, setCover] = useState(false);
  if (d.error) return <Screen><LoadError error={d.error} onRetry={d.reload} /></Screen>;
  if (!d.data) return <Screen><Loading /></Screen>;
  const s = { ...d.data, nav };
  const mine = s.staff.find((x) => x.user_id === user.id && !['declined', 'removed'].includes(x.status));
  s.canEdit = !!d.data.can_edit;
  const tz = tzOf(s);
  const tabs = [['attendance', 'Attendance'], ['staff', `Staff (${s.staff.filter((x) => !['declined', 'removed'].includes(x.status)).length})`], ['venue', 'Venue'], ['details', 'Details & history']];
  const reload = () => d.reload();
  return (
    <Screen wide>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{s.title}</T><Tag label={SSTAT[s.status]} color={s.status === 'published' ? c.lime : s.status === 'cancelled' ? c.orangeSoft : undefined} /></View>
        <T color={c.mute}>{dateTimeIn(s.starts_at, tz)} – {timeIn(s.ends_at, tz)}{s.venue ? ` · 📍 ${s.venue.venue_name} · ${s.venue.resource_name}` : ' · no venue yet'}</T>
      </View>
      {s.status !== 'cancelled' ? <View style={{ marginTop: 10 }}><Compliance compliance={s.compliance} conflicts={s.conflicts ?? []} /></View> : null}
      {mine && ['lead', 'assistant'].includes(mine.role) && s.status !== 'draft' && s.status !== 'cancelled' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <Btn small title="Open in Performance Studio" onPress={() => nav.push('CoachSession', { source_type: 'academy_session', source_id: s.id })} />
          <Btn small title="Clock in" color={c.paper} ink={c.ink} onPress={async () => { try { await api.post(`/academy/sessions/${s.id}/clock-in`); toast('Clocked in. This does not mark anyone present.'); } catch (e) { toast(explain(e)); } }} />
          <Btn small title="Can't make it: ask for cover" color={c.paper} ink={c.ink} onPress={() => setCover(true)} />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 12 }} accessibilityRole="tablist">{tabs.map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</View>
      {tab === 'attendance' ? <Attendance s={s} reload={reload} toast={toast} /> : null}
      {tab === 'staff' ? <Staff s={s} reload={reload} toast={toast} me={user.id} openFind={!!find} /> : null}
      {tab === 'venue' ? <Venue s={s} reload={reload} toast={toast} /> : null}
      {tab === 'details' ? <Details s={s} reload={reload} toast={toast} /> : null}
      <FormSheet visible={cover} onClose={() => setCover(false)} title="Ask for cover" submitLabel="Send request" fields={[{ key: 'reason', label: 'What happened? (shared with the managers)', optional: true }]}
        onSubmit={async (v) => { await api.post(`/academy/sessions/${s.id}/cover`, { reason: v.reason || undefined }); reload(); return 'Request sent. A manager will find a substitute.'; }} />
    </Screen>
  );
}

// ================================================================================== COACH AGENDA (phone-first)
export function AcademyAgenda() {
  const { toast } = useSession();
  const { push } = useNav();
  const d = useLoad(() => api.get('/me/academy/agenda'), []);
  const stm = useLoad(() => api.get('/me/academy/statements').catch(() => []), []);
  const [leave, setLeave] = useState(null), [avail, setAvail] = useState(null), [pay, setPay] = useState(false);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  if (d.error) return <Screen><LoadError error={d.error} onRetry={d.reload} /></Screen>;
  if (!d.data) return <Screen><Loading /></Screen>;
  const { sessions, shifts, time_off } = d.data;
  const respond = async (sid, accept) => { try { await api.post(`/academy/sessions/${sid}/staff/respond`, { accept, reason: accept ? undefined : 'Declined' }); toast(accept ? 'Confirmed' : 'Declined. The academy was told.'); } catch (e) { toast(explain(e)); } finally { d.reload(); } };
  const respondShift = async (sid, accept) => { try { await api.post(`/academy/shifts/${sid}/respond`, { accept }); toast(accept ? 'Confirmed' : 'Declined'); } catch (e) { toast(explain(e)); } finally { d.reload(); } };
  const orgOpts = (orgs.data ?? []).filter((o) => o.my_status === 'active' && o.kind === 'academy').map((o) => ({ value: o.id, label: o.name }));
  return (
    <Screen wide>
      <T weight="800" size={26} style={{ letterSpacing: -0.8 }}>My academy week</T>
      <T color={c.mute}>Sessions and shifts you are on. They also show in your coach calendar.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        <Btn small title="Request time off" onPress={() => setLeave({})} /><Btn small title="My availability" color={c.paper} ink={c.ink} onPress={() => setAvail({})} /><Btn small title={`Pay statements (${stm.data?.length ?? 0})`} color={c.paper} ink={c.ink} onPress={() => setPay(true)} />
      </View>
      <View style={{ gap: 10, marginTop: 14 }}>
        {sessions.length ? sessions.map((s) => (
          <Card key={s.id} pad={14}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{s.title}</T><Tag label={s.my_status === 'confirmed' ? '✓ Confirmed' : 'Please confirm'} color={s.my_status === 'confirmed' ? c.lime : c.sunSoft} /></View>
            <T color={c.mute} size={13}>{dateTimeIn(s.starts_at, s.timezone)} – {timeIn(s.ends_at, s.timezone)} · {ROLE[s.role]} · {s.enrolled} athletes</T>
            <T size={13} color={c.mute}>{s.organisation} · {s.cohort}{s.venue ? ` · 📍 ${s.venue}` : ' · venue not booked yet'}</T>
            {s.status === 'draft' ? <T size={12} color={c.mute}>Draft: not yet published to families.</T> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {s.my_status === 'assigned' ? <><Btn small title="Confirm" onPress={() => respond(s.id, true)} /><Btn small title="Can't make it" color={c.paper} ink={c.ink} onPress={() => respond(s.id, false)} /></> : null}
              <Btn small title="Take attendance" color={c.paper} ink={c.ink} onPress={() => push('AcademySession', { id: s.id, tab: 'attendance' })} />
              {s.cover_requested ? <Tag label="Cover requested" /> : <Btn small title="Request cover" color={c.paper} ink={c.ink} onPress={() => push('AcademySession', { id: s.id, tab: 'staff' })} />}
            </View>
          </Card>
        )) : <Empty emoji="🗓️" title="No academy sessions in the next two weeks" sub="When you are assigned to a published session it appears here and in your coach calendar." />}
        {shifts.map((s) => (
          <Card key={s.id} pad={14}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>🧾 {s.title}</T><Tag label={s.status === 'confirmed' ? '✓ Confirmed' : 'Please confirm'} color={s.status === 'confirmed' ? c.lime : c.sunSoft} /></View>
            <T size={13} color={c.mute}>{dateTimeIn(s.starts_at, s.timezone)} – {timeIn(s.ends_at, s.timezone)} · {s.organisation}</T>
            {s.status === 'assigned' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Confirm" onPress={() => respondShift(s.id, true)} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => respondShift(s.id, false)} /></View> : null}
          </Card>
        ))}
        {time_off.map((t) => <Row key={t.id} title={`Time off ${t.on_date.slice(0, 10)}${t.ends_on ? ` → ${t.ends_on.slice(0, 10)}` : ''}`} sub={t.reason} right={<Tag label={t.status === 'approved' ? '✓ Approved' : 'Waiting'} color={t.status === 'approved' ? c.lime : c.sunSoft} />} />)}
      </View>
      <FormSheet visible={!!leave} onClose={() => setLeave(null)} title="Request time off" submitLabel="Send request" fields={[
        ...(orgOpts.length > 1 ? [{ key: 'org', label: 'Academy', type: 'chips', options: orgOpts }] : []),
        { key: 'range', label: 'Dates', type: 'daterange', toKey: 'range_to' }, { key: 'reason', label: 'Note', optional: true }]}
        onSubmit={async (v) => { await api.post(`/organisations/${v.org ?? orgOpts[0]?.value}/academy/time-off`, { on_date: v.range, ends_on: v.range_to, reason: v.reason || undefined }); d.reload(); return 'Request sent. You will be told when it is decided.'; }} />
      <FormSheet visible={!!avail} onClose={() => setAvail(null)} title="Standing availability" submitLabel="Save" fields={[
        ...(orgOpts.length > 1 ? [{ key: 'org', label: 'Academy', type: 'chips', options: orgOpts }] : []),
        { key: 'days', label: 'Days you can coach', type: 'weekdays' }, { key: 'from', label: 'From', type: 'time' }, { key: 'to', label: 'Until', type: 'time' }]}
        onSubmit={async (v) => { const r = await api.post(`/organisations/${v.org ?? orgOpts[0]?.value}/academy/availability`, { replace_weekly: true, weekly: v.days.map((weekday) => ({ weekday, start_time: v.from, end_time: v.to })) }); return r.sessions_outside_availability.length ? `Saved. ${r.sessions_outside_availability.length} assigned session(s) now fall outside it: tell your manager.` : 'Saved'; }} />
      <Sheet visible={pay} onClose={() => setPay(false)} title="My pay statements">
        <View style={{ gap: 8 }}>
          {stm.data?.length ? stm.data.map((x) => <Row key={x.run_id} title={`${x.organisation} · ${String(x.period_start).slice(0, 10)} → ${String(x.period_end).slice(0, 10)}`} sub={`${(x.minutes / 60).toFixed(1)} h · ${x.sessions} sessions`} right={<T weight="800">{(x.gross_minor / 100).toFixed(2)} {x.currency}</T>} />) : <T color={c.mute}>No approved statements yet.</T>}
          <T size={11} color={c.mute}>A statement of what the academy owes you for approved work. It is not a payslip and shows no tax or deductions.</T>
        </View>
      </Sheet>
    </Screen>
  );
}

// ================================================================================== ATHLETE / GUARDIAN
/** Embedded in "My academy": upcoming and past sessions for an athlete (or their child), with absence notice and make-up options. */
export function MySessions({ athleteId, toast }) {
  const d = useLoad(() => api.get('/me/academy/sessions', { athlete_id: athleteId }), [athleteId]);
  const [away, setAway] = useState(null), [ask, setAsk] = useState(null);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const { sessions, makeup_options, summary } = d.data;
  const now = Date.now();
  const upcoming = sessions.filter((s) => new Date(s.ends_at) >= now), past = sessions.filter((s) => new Date(s.ends_at) < now).reverse();
  const Card1 = (s) => (
    <Card key={s.id} pad={12} color={s.status === 'cancelled' ? c.orangeSoft : c.paper}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{s.title}</T>{s.status === 'cancelled' ? <Tag label="✕ Cancelled" color={c.orangeSoft} /> : <Tag label={`${MARK_ICON[s.attendance]} ${MARK[s.attendance]}`} />}</View>
      <T size={13} color={c.mute}>{dateTimeIn(s.starts_at, s.timezone)} · {s.organisation}{s.venue ? ` · 📍 ${s.venue}` : ''}</T>
      {s.status === 'cancelled' ? <T size={13}>Cancelled: {s.cancel_reason}</T> : null}
      {s.rescheduled_at && s.status !== 'cancelled' ? <T size={12} color={c.mute}>This session was moved. The time shown is the new one.</T> : null}
      {new Date(s.ends_at) >= now && s.status === 'published' && !['absent', 'excused'].includes(s.attendance) ? <Btn small title="Can't attend" color={c.paper} ink={c.ink} onPress={() => setAway(s)} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
    </Card>
  );
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>{summary.present} attended · {summary.absent} missed of {summary.held} held. These sessions also appear in the schedule.</T>
      <Block title="Coming up">{upcoming.length ? upcoming.map(Card1) : <Empty emoji="🗓️" title="No sessions scheduled" sub="Published sessions for your groups appear here." />}</Block>
      {makeup_options.length ? (
        <Block title="Make-up options"><T size={12} color={c.mute}>Sessions with a free place in the same programme. The academy decides, and any fee follows its normal terms.</T>
          {makeup_options.map((m) => <Row key={m.id} title={m.title} sub={`${dateTimeIn(m.starts_at, 'UTC')} · ${m.cohort}`} right={<Btn small title="Ask" color={c.paper} ink={c.ink} onPress={() => setAsk(m)} />} />)}
        </Block>
      ) : null}
      <Block title="Attendance history">{past.length ? past.slice(0, 20).map(Card1) : <T size={13} color={c.mute}>Nothing yet.</T>}</Block>
      <FormSheet visible={!!away} onClose={() => setAway(null)} title="Tell the academy" submitLabel="Send" fields={[{ key: 'reason_code', label: 'Reason (kept simple: no health details)', type: 'chips', options: REASONS.map(([value, label]) => ({ value, label })) }]}
        onSubmit={async (v) => { await api.post(`/academy/sessions/${away.id}/absence`, { athlete_id: athleteId, reason_code: v.reason_code, idempotency_key: uid() }); d.reload(); return 'Thanks. The coaches have been told.'; }} />
      <FormSheet visible={!!ask} onClose={() => setAsk(null)} title="Ask for a make-up place" submitLabel="Ask" fields={[{ key: 'from', label: 'Which missed session is it for?', type: 'chips', options: sessions.filter((s) => s.programme_id === ask?.programme_id && (['absent', 'excused', 'not_held'].includes(s.attendance) || s.status === 'cancelled')).map((s) => ({ value: s.id, label: `${s.title} · ${String(s.starts_at).slice(0, 10)}` })) }]}
        onSubmit={async (v) => { await api.post(`/academy/sessions/${v.from}/makeup-request`, { athlete_id: athleteId, to_session_id: ask.id }); toast?.('Request sent'); return 'Sent. The academy will confirm.'; }} />
    </View>
  );
}
