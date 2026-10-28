// Officials Home (#88): the match official's own operating view. Today's match, requests to accept or decline, a calendar with clashes, availability,
// my officiating history and "ask the rules" - all read from the canonical assignment, fixture and rulebook capabilities (the same ones agents use over MCP).
// The live scoring console is the existing Match Centre and the result goes through the existing score sheet; this screen links to them rather than copying them.
// The server decides every permission; this only shows what comes back and keeps touch targets large for pitch-side use.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Calendar, monthOf, todayLocal } from '../pickers';
import { explain, LoadError } from '../access';
import { c, grad } from '../theme';
import { Banner, Metric, money } from '../federation-ui';
import { openPdf } from '../open-file';
import { Cols } from '../federation-bits';
import { VerificationSection } from './verification';

export const ROLE_LABEL = { referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant referee', scorer: 'Scorer / timekeeper' };
const STATUS = {
  invited: ['⏳ Awaiting your reply', c.sunSoft], accepted: ['✅ Confirmed', c.mintSoft], completed: ['🏁 Completed', c.violetSoft], declined: ['Declined', c.paper],
  withdrawn: ['Withdrawn', c.paper], released: ['Released by organiser', c.paper], cancelled: ['Match cancelled', c.paper],
};
const CRED = {
  verified: ['✅ Verified official', c.mintSoft], expiring: ['⚠️ Verification ending soon', c.sunSoft], expired: ['⛔ Verification expired', c.sunSoft], revoked: ['⛔ Verification revoked', c.sunSoft],
  pending: ['⏳ Verification in review', c.cyanSoft], rejected: ['Verification not approved', c.paper], self_declared: ['Self-declared referee profile', c.paper], none: ['No referee profile yet', c.paper],
};
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const DECLINE_REASONS = ['Not available then', 'Too far to travel', 'Clash with another match', 'Not my level or sport'];
const REPORT_TYPES = [
  { value: 'match_report', label: 'Match report' }, { value: 'misconduct', label: 'Misconduct' }, { value: 'send_off', label: 'Send-off / ejection' }, { value: 'abandonment', label: 'Abandonment / suspension' },
  { value: 'venue_incident', label: 'Spectator / venue incident' }, { value: 'equipment_field', label: 'Equipment or field issue' }, { value: 'protest_noted', label: 'Protest noted' }, { value: 'other', label: 'Other' },
];

const PAY = { agreed: ['Fee agreed', c.cyanSoft], due: ['Payment due', c.sunSoft], paid: ['Paid', c.mintSoft], disputed: ['Payment disputed', c.sunSoft] };
const payTag = (a) => (a.fee_minor != null && PAY[a.pay_status] ? <Tag label={`💰 ${money(a.fee_minor, a.fee_currency)} · ${PAY[a.pay_status][0]}${a.pay_confirmed_at ? ' · receipt confirmed' : ''}`} color={PAY[a.pay_status][1]} /> : null);
const mins = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const when = (iso, tz) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '');
const clock = (iso, tz) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '');
const dayOf = (iso, tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(iso)); } catch { return String(iso).slice(0, 10); } };
const isoAt = (day, t) => new Date(`${day}T${t}:00`).toISOString();
const statusTag = (s) => <Tag label={STATUS[s]?.[0] ?? s} color={STATUS[s]?.[1] ?? c.paper} />;
const roleTag = (r) => <Tag label={ROLE_LABEL[r] ?? r} color={c.violetSoft} />;

// ------------------------------------------------------------------ one assignment
function Assignment({ a, tz, onOpen, children, prominent }) {
  return (
    <Card color={prominent ? c.paper : c.paper} onPress={onOpen} accessibilityLabel={`${a.home_name ?? 'TBD'} versus ${a.away_name ?? 'TBD'}, ${when(a.scheduled_at, tz)}, ${ROLE_LABEL[a.role] ?? a.role}, ${a.status}`}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{roleTag(a.role)}{statusTag(a.status)}{a.needs_ack ? <Tag label="🔔 Changed: acknowledge" color={c.sunSoft} /> : null}{payTag(a)}</View>
        <T weight="800" size={prominent ? 22 : 17} style={{ letterSpacing: -0.4 }}>{a.home_name ?? 'TBD'} v {a.away_name ?? 'TBD'}</T>
        <T size={13} color={c.mute}>{a.sport_emoji} {a.event_name}{a.round ? ` · ${a.round}` : ''}</T>
        <T size={14} weight="700">{when(a.scheduled_at, tz)} · {a.duration_min} min</T>
        {a.resource_name || a.venue_name ? <T size={13} color={c.mute}>📍 {[a.resource_name, a.venue_name].filter(Boolean).join(' · ')}</T> : null}
        {children}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------ Today
function Today({ h, reload, go, tz }) {
  const { toast } = useSession();
  const [declining, setDeclining] = useState(null);
  const [busy, setBusy] = useState(null);
  const respond = async (a, response, reason) => {
    setBusy(a.id);
    try { await api.post(`/official-assignments/${a.id}/respond`, { response, reason }); toast(response === 'accept' ? 'Accepted. You are on the crew.' : 'Declined. The organiser has been told.'); await reload(); }
    catch (e) { toast(explain(e)); await reload(); } finally { setBusy(null); }
  };
  const act = (it) => {
    if (it.kind === 'invitation' || it.kind === 'changed') return null;
    if (it.fixture_id) return () => go('OfficialMatch', { id: it.fixture_id, ...(it.kind === 'report_due' ? { report: true } : {}) });
    if (it.kind === 'credential') return () => go('OfficialsHome', { tab: 'credential' });
    return null;
  };
  const quick = [
    ['📅', 'My assignments', () => go('OfficialsHome', { tab: 'calendar' })], ['🕒', 'My availability', () => go('OfficialsHome', { tab: 'availability' })],
    ['📨', `Pending requests${h.stats.pending ? ` (${h.stats.pending})` : ''}`, () => go('OfficialsHome', { tab: 'today' })],
    ['🎛️', 'Match-day console', h.next ? () => go('MatchCentre', { id: h.next.fixture_id }) : null], ['📖', 'Rules & interpretations', () => go('OfficialsHome', { tab: 'rules' })],
    ['🗂️', 'Officiating history', () => go('OfficialsHome', { tab: 'history' })], ['💼', 'Opportunities', () => go('Openings')], ['🪪', 'Verification & renewal', () => go('OfficialsHome', { tab: 'credential' })],
    ['⚖️', 'Reports & disputes', () => go('OfficialsHome', { tab: 'history' })], ['🎓', 'Grade, assessments & CPD', () => go('OfficialsDevelopment')],
  ];
  const matches = (
    <View style={{ gap: 14 }}>
      {h.today.length ? (
        <Section title="Today" color={c.mint}>
          <View style={{ gap: 10 }}>{h.today.map((a) => (
            <Assignment key={a.id} a={a} tz={tz} prominent onOpen={() => go('OfficialMatch', { id: a.fixture_id })}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                <Btn title="Briefing & checks" onPress={() => go('OfficialMatch', { id: a.fixture_id })} style={{ minHeight: 48 }} />
                <Btn title="Open live console" color={c.violet} onPress={() => go('MatchCentre', { id: a.fixture_id })} style={{ minHeight: 48 }} />
              </View>
            </Assignment>
          ))}</View>
        </Section>
      ) : h.next ? (
        <Section title="Next match" color={c.mint}><Assignment a={h.next} tz={tz} prominent onOpen={() => go('OfficialMatch', { id: h.next.fixture_id })} /></Section>
      ) : <Empty emoji="🏁" title="No matches coming up" sub="When an organiser asks you to officiate, the request appears here to accept or decline." />}

      {h.pending_requests.length ? (
        <Section title={`Requests waiting for you (${h.pending_requests.length})`} color={c.sun}>
          <View style={{ gap: 10 }}>{h.pending_requests.map((a) => (
            <Assignment key={a.id} a={a} tz={tz} onOpen={() => {}}>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                <Btn title="Accept" loading={busy === a.id} onPress={() => respond(a, 'accept')} style={{ flex: 1, minHeight: 48 }} accessibilityLabel={`Accept ${a.home_name} versus ${a.away_name}`} />
                <Btn title="Decline" onPress={() => setDeclining(a)} color={c.paper} ink={c.ink} style={{ flex: 1, minHeight: 48 }} accessibilityLabel={`Decline ${a.home_name} versus ${a.away_name}`} />
              </View>
            </Assignment>
          ))}</View>
        </Section>
      ) : null}
    </View>
  );
  const work = (
    <View style={{ gap: 14 }}>
      <Section title={`Needs your attention${h.inbox.length ? ` (${h.inbox.length})` : ''}`} color={c.pink}>
        {h.inbox.length ? <View style={{ gap: 8 }}>{h.inbox.map((it, i) => {
          const onPress = act(it);
          return (
            <Card key={`${it.kind}${it.official_id ?? it.case_id ?? i}`} onPress={onPress ?? undefined} pad={14} accessibilityLabel={`${it.title}. ${it.detail ?? ''}`}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <T weight="800" size={14.5}>{it.title}</T>
                  {it.detail ? <T size={12.5} color={c.mute}>{it.detail}</T> : null}
                </View>
                {it.kind === 'changed' ? <Btn small title="Acknowledge" onPress={() => respond({ id: it.official_id }, 'accept')} style={{ minHeight: 44 }} /> : onPress ? <T size={20} color={c.mute}>›</T> : null}
              </View>
            </Card>
          );
        })}</View> : <Empty emoji="✨" title="All clear" sub="No invitations, changes, pre-match checks, reports or disputes need you right now." />}
      </Section>

      <Section title="Quick actions" color={c.cyan}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {quick.map(([e, label, onPress]) => <Btn key={label} title={`${e} ${label}`} small color={c.paper} ink={c.ink} disabled={!onPress} onPress={onPress ?? undefined} style={{ minHeight: 44 }} />)}
        </View>
      </Section>
    </View>
  );
  return (
    <View style={{ gap: 14 }}>
      <Cols a={matches} b={work} ratio={[3, 2]} />
      <Sheet visible={!!declining} onClose={() => setDeclining(null)} title="Decline this request">
        <T size={13} color={c.mute}>Tell the organiser why so they can find someone quickly. You can also leave it blank.</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {DECLINE_REASONS.map((r) => <Chip key={r} label={r} onPress={() => { const a = declining; setDeclining(null); respond(a, 'decline', r); }} />)}
        </View>
        <Btn title="Decline without a reason" color={c.paper} ink={c.ink} style={{ marginTop: 12, minHeight: 48 }} onPress={() => { const a = declining; setDeclining(null); respond(a, 'decline'); }} />
      </Sheet>
    </View>
  );
}

// ------------------------------------------------------------------ Calendar
function CalendarTab({ tz, go, sportId }) {
  const [view, setView] = useState('week');
  const [role, setRole] = useState(null);
  const [month, setMonth] = useState(monthOf(todayLocal()));
  const [day, setDay] = useState(todayLocal());
  const range = useMemo(() => {
    if (view === 'month') { const [y, m] = month.split('-').map(Number); return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))]; }
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return [start, new Date(start.getTime() + (view === 'today' ? 1 : 7) * 864e5)];
  }, [view, month]);
  const q = useLoad(() => api.get('/me/officials/calendar', { from: range[0].toISOString(), to: range[1].toISOString(), ...(sportId ? { sport_id: sportId } : {}), ...(role ? { role } : {}) }), [range[0].getTime(), range[1].getTime(), sportId, role]);
  const entries = q.data?.entries ?? [];
  const shown = view === 'month' ? entries.filter((e) => dayOf(e.starts_at, tz) === day) : entries;
  const marks = useMemo(() => { const m = new Map(); for (const e of entries) { const d = dayOf(e.starts_at, tz); m.set(d, e.clash_with?.length || e.unavailable_with?.length || e.status === 'invited' ? 'limited' : m.get(d) ?? 'available'); } return [...m].map(([date, status]) => ({ date, status })); }, [entries, tz]);
  return (
    <View style={{ gap: 12 }}>
      <Seg options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} value={view} onChange={setView} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="All roles" active={!role} onPress={() => setRole(null)} />
        {Object.entries(ROLE_LABEL).map(([k, l]) => <Chip key={k} label={l} active={role === k} onPress={() => setRole(role === k ? null : k)} />)}
      </View>
      {q.data?.conflicts ? <Banner tone={c.sunSoft}>⚠️ {q.data.conflicts} entr{q.data.conflicts === 1 ? 'y clashes' : 'ies clash'} with another match or your time off. Look for the warning on the card.</Banner> : null}
      {view === 'month' ? <Card><Calendar month={month} onMonth={setMonth} value={day} onChange={setDay} days={marks} /></Card> : null}
      {q.error && !q.data ? <LoadError error={q.error} onRetry={q.reload} /> : !q.data ? <Loading /> : shown.length ? (
        <View style={{ gap: 10 }}>{shown.map((e) => (
          <Card key={`${e.source_type}${e.source_id}`} onPress={e.fixture_id ? () => go('OfficialMatch', { id: e.fixture_id }) : undefined} pad={14} accessibilityLabel={`${e.title}, ${when(e.starts_at, tz)}`}>
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {e.kind === 'assignment' ? <>{roleTag(e.role)}{statusTag(e.status)}</> : <Tag label={e.kind === 'time_off' ? '🌴 Time off' : '⚖️ Deadline'} color={c.cyanSoft} />}
                {e.clash_with?.length ? <Tag label="⚠️ Clashes with another match" color={c.sunSoft} /> : null}
                {e.unavailable_with?.length ? <Tag label="⚠️ During your time off" color={c.sunSoft} /> : null}
                {e.outside_availability ? <Tag label="Outside your usual hours" color={c.sunSoft} /> : null}
              </View>
              <T weight="800" size={16}>{e.title}</T>
              <T size={12.5} color={c.mute}>{when(e.starts_at, tz)}{e.kind === 'assignment' ? ` – ${clock(e.ends_at, tz)}` : ''}{e.subtitle ? ` · ${e.subtitle}` : ''}</T>
            </View>
          </Card>
        ))}</View>
      ) : <Empty emoji="📅" title="Nothing here" sub={view === 'month' ? 'No matches or time off on this day.' : 'No matches in this period.'} />}
      <T size={12} color={c.mute}>Times are shown in {tz}. Entries come straight from your assignments, so a change by the organiser appears here at once.</T>
    </View>
  );
}

// ------------------------------------------------------------------ Availability
function AvailabilityTab({ sports }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/officials/availability'), []);
  const [form, setForm] = useState(null); // 'window' | 'off' | 'prefs'
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const { prefs, weekly, time_off: off } = q.data;
  const save = async (fn, msg) => { try { await fn(); toast(msg); await q.reload(); } catch (e) { toast(explain(e)); throw e; } };
  const addWindow = (v) => save(async () => {
    const next = [...weekly.map((w) => ({ weekday: w.weekday, start_minute: w.start_minute, end_minute: w.end_minute })), ...v.days.map((d) => ({ weekday: d, start_minute: toMin(v.start), end_minute: toMin(v.end) }))];
    await api.post('/me/officials/availability/weekly', { windows: next });
  }, 'Weekly hours saved');
  const dropWindow = (w) => save(() => api.post('/me/officials/availability/weekly', { windows: weekly.filter((x) => x.id !== w.id).map((x) => ({ weekday: x.weekday, start_minute: x.start_minute, end_minute: x.end_minute })) }), 'Removed');
  const grouped = DAYS.map(([d, label]) => [label, weekly.filter((w) => w.weekday === d)]).filter(([, l]) => l.length);
  return (
    <View style={{ gap: 14 }}>
      <Section title="Weekly hours" color={c.mint} action="Add hours" onAction={() => setForm('window')}>
        {grouped.length ? <Card><View style={{ gap: 8 }}>{grouped.map(([label, list]) => (
          <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T weight="800" style={{ width: 46 }}>{label}</T>
            {list.map((w) => <Chip key={w.id} label={`${mins(w.start_minute)}–${mins(w.end_minute)}  ✕`} onPress={() => dropWindow(w)} />)}
          </View>
        ))}</View></Card> : <Empty emoji="🕒" title="No weekly limits" sub="You count as available any time. Add hours if you only officiate at certain times; matches outside them get a warning." />}
      </Section>
      <Section title="Time off" color={c.sun} action="Block time" onAction={() => setForm('off')}>
        {off.length ? <View style={{ gap: 8 }}>{off.map((o) => (
          <Card key={o.id} pad={14}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{when(o.starts_at, prefs.timezone)} → {when(o.ends_at, prefs.timezone)}</T>{o.note ? <T size={12.5} color={c.mute}>{o.note}</T> : null}</View>
            <Btn small title="Remove" color={c.paper} ink={c.ink} style={{ minHeight: 44 }} onPress={() => save(() => api.post(`/me/officials/availability/${o.id}/remove`, {}), 'Time off removed')} />
          </View></Card>
        ))}</View> : <Empty emoji="🌴" title="No time off booked" sub="Organisers cannot assign you during blocked time." />}
      </Section>
      <Section title="Preferences" color={c.cyan} action="Edit" onAction={() => setForm('prefs')}>
        <Card><View style={{ gap: 4 }}>
          <T>🌍 Timezone: <T weight="800">{prefs.timezone}</T></T>
          <T>↔️ Gap between matches: <T weight="800">{prefs.buffer_min ? `${prefs.buffer_min} min` : 'none'}</T></T>
          <T>🚗 Travel range: <T weight="800">{prefs.travel_km ? `${prefs.travel_km} km` : 'not set'}</T></T>
          <T>📍 Area: <T weight="800">{prefs.region || 'not set'}</T></T>
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>Only a coarse area is stored, never an address. The gap between matches is checked whenever you are asked to officiate.</T>
        </View></Card>
      </Section>
      <FormSheet visible={form === 'window'} onClose={() => setForm(null)} title="Add weekly hours" submitLabel="Add" onSubmit={async (v) => { if (!v.days?.length) throw new Error('Pick at least one day'); await addWindow(v); setForm(null); }}
        fields={[{ key: 'days', label: 'Days', type: 'weekdays' }, { key: 'start', label: 'From', type: 'time' }, { key: 'end', label: 'Until', type: 'time' }]} initial={{ days: [], start: '08:00', end: '18:00' }} />
      <FormSheet visible={form === 'off'} onClose={() => setForm(null)} title="Block time off" submitLabel="Block" onSubmit={async (v) => {
        const r = await api.post('/me/officials/availability/time-off', { starts_at: v.starts, ends_at: v.ends, note: v.note || undefined });
        toast(r.affected_assignments.length ? `Blocked. ${r.affected_assignments.length} confirmed match(es) fall inside it: withdraw from them if you cannot go.` : 'Time off saved'); setForm(null); await q.reload();
      }} fields={[{ key: 'starts', label: 'From', type: 'datetime' }, { key: 'ends', label: 'Until', type: 'datetime' }, { key: 'note', label: 'Note for yourself', optional: true }]} />
      <FormSheet visible={form === 'prefs'} onClose={() => setForm(null)} title="Preferences" onSubmit={async (v) => { await save(() => api.post('/me/officials/availability/prefs', { timezone: v.timezone, buffer_min: v.buffer_min, travel_km: v.travel_km || null, region: v.region?.[0] || null, sport_ids: prefs.sport_ids, levels: prefs.levels }), 'Preferences saved'); setForm(null); }}
        fields={[{ key: 'timezone', label: 'Your timezone', type: 'timezone' }, { key: 'buffer_min', label: 'Minimum gap between matches (minutes)', type: 'stepper', min: 0, max: 240, step: 15, suffix: 'min' }, { key: 'travel_km', label: 'How far will you travel (km)', type: 'stepper', min: 0, max: 1000, step: 5, suffix: 'km', optional: true }, { key: 'region', label: 'City or area you cover (optional)', type: 'regions', optional: true }]}
        initial={{ timezone: prefs.timezone, buffer_min: prefs.buffer_min, travel_km: prefs.travel_km ?? 0, region: prefs.region ? [prefs.region] : [] }} />
    </View>
  );
}


// ------------------------------------------------------------------ payment actions (the official's side)
function PayActions({ a, reload }) {
  const { toast } = useSession();
  const [dispute, setDispute] = useState(false);
  if (!['due', 'paid'].includes(a.pay_status) || a.fee_minor == null) return null;
  const send = async (response, note) => { try { await api.post(`/official-assignments/${a.id}/payment-response`, { response, note }); toast(response === 'confirm' ? 'Receipt confirmed' : 'The organiser has been told'); await reload(); } catch (e) { toast(explain(e)); throw e; } };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {a.pay_status === 'paid' && !a.pay_confirmed_at ? <Btn small title="I received this" onPress={() => send('confirm')} style={{ minHeight: 44 }} /> : null}
      <Btn small title="Something is wrong" color={c.paper} ink={c.ink} onPress={() => setDispute(true)} style={{ minHeight: 44 }} />
      <FormSheet visible={dispute} onClose={() => setDispute(false)} title="Dispute this payment" submitLabel="Tell the organiser" onSubmit={async (v) => { await send('dispute', v.note); setDispute(false); }}
        fields={[{ key: 'note', label: 'What is wrong (amount, date, not received)', type: 'multiline' }]} />
    </View>
  );
}

// ------------------------------------------------------------------ feedback about me, and the reporting extract
function Feedback() {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/officials/feedback'), []);
  const [reply, setReply] = useState(null);
  const [contest, setContest] = useState(null);
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const f = q.data;
  return (
    <View style={{ gap: 10 }}>
      {!f.enough ? <Empty emoji="🔒" title={`${f.responses} response${f.responses === 1 ? '' : 's'} so far`} sub={`Feedback appears once at least ${f.minimum} people have answered, so nobody can be picked out. It is never one overall score.`} /> : (
        <>
          <Card><View style={{ gap: 8 }}>
            {f.criteria.map((x) => (
              <View key={x.key} accessible accessibilityLabel={`${x.label}: average ${x.average ?? 'none'} from ${x.responses} responses`} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T weight="700">{x.label}</T><T>{x.average ?? 'n/a'} <T size={12} color={c.mute}>/ 5 · {x.responses}</T></T>
              </View>
            ))}
            <T size={12} color={c.mute}>Averages of {f.responses} responses from team managers and event organisers. Authors are never shown.</T>
          </View></Card>
          {f.comments.map((m) => (
            <Card key={m.id} pad={14}><View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Tag label={m.capacity === 'event_official' ? 'Event official' : 'Team official'} color={c.violetSoft} />{m.status === 'contested' ? <Tag label="Under review" color={c.sunSoft} /> : null}</View>
              {m.comment ? <T>“{m.comment}”</T> : null}
              <T size={12} color={c.mute}>{m.event_name}</T>
              {m.reply ? <T size={13}><T weight="800">Your reply: </T>{m.reply}</T> : null}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {m.comment && !m.reply ? <Btn small title="Reply" color={c.paper} ink={c.ink} onPress={() => setReply(m)} style={{ minHeight: 44 }} /> : null}
                {m.status !== 'contested' ? <Btn small title="Ask for a review" color={c.paper} ink={c.ink} onPress={() => setContest(m)} style={{ minHeight: 44 }} /> : null}
              </View>
            </View></Card>
          ))}
        </>
      )}
      <FormSheet visible={!!reply} onClose={() => setReply(null)} title="Reply publicly" submitLabel="Reply" onSubmit={async (v) => { try { await api.post(`/official-feedback/${reply.id}/reply`, { reply: v.reply }); toast('Reply added'); setReply(null); await q.reload(); } catch (e) { toast(explain(e)); throw e; } }} fields={[{ key: 'reply', label: 'Your reply', type: 'multiline' }]} />
      <FormSheet visible={!!contest} onClose={() => setContest(null)} title="Ask the platform team to review" submitLabel="Send for review" notice="Use this for abuse, the wrong match or retaliation. The response stays visible, marked as under review, until it is decided."
        onSubmit={async (v) => { try { await api.post(`/official-feedback/${contest.id}/contest`, { reason: v.reason }); toast('Sent for review'); setContest(null); await q.reload(); } catch (e) { toast(explain(e)); throw e; } }} fields={[{ key: 'reason', label: 'Why', type: 'multiline' }]} />
    </View>
  );
}

function Extracts({ sports }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/officials/extracts'), []);
  const [form, setForm] = useState(false);
  const [share, setShare] = useState(null);
  const [busy, setBusy] = useState(false);
  const year = new Date().getFullYear();
  const build = async (v) => {
    setBusy(true);
    try { const r = await api.post('/me/officials/extracts', { from: v.from, to: v.to, ...(v.sport ? { sport_id: sports.find((s) => s.slug === v.sport)?.id } : {}), client_key: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }); toast(`Extract built (${r.pages} pages)`); setForm(false); await q.reload(); }
    catch (e) { toast(explain(e)); throw e; } finally { setBusy(false); }
  };
  const open = async (x) => { try { await openPdf(`/official-extracts/${x.id}/pdf`, `officiating-extract-${x.period_to}`); } catch (e) { toast(explain(e)); } };
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>A PDF of your assignments, the closure forms in detail (score sheet, sign-offs, your reports and revisions), fees and payment status, linked disputes and feedback. It is a frozen snapshot you own, and you decide who may read it.</T>
      <Btn title="📄 Build a new extract" onPress={() => setForm(true)} loading={busy} style={{ minHeight: 48 }} />
      {q.data.length ? q.data.map((x) => (
        <Card key={x.id} pad={14}><View style={{ gap: 6 }}>
          <T weight="800">{x.period_from} to {x.period_to}</T>
          <T size={12.5} color={c.mute}>{x.counts.assignments} assignments · {x.counts.completed} completed · {x.counts.reports} reports · {x.pages} page{x.pages === 1 ? '' : 's'} · built {new Date(x.created_at).toLocaleDateString()}</T>
          {x.shares.filter((s) => s.active).map((s) => <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><T size={13}>Shared with {s.recipient_name} until {new Date(s.expires_at).toLocaleDateString()}</T><Btn small title="Stop" color={c.paper} ink={c.ink} style={{ minHeight: 44 }} onPress={async () => { try { await api.post(`/me/officials/extract-shares/${s.id}/revoke`, {}); toast('Sharing stopped'); await q.reload(); } catch (e) { toast(explain(e)); } }} /></View>)}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Open PDF" onPress={() => open(x)} style={{ minHeight: 44 }} /><Btn small title="Share" color={c.paper} ink={c.ink} onPress={() => setShare(x)} style={{ minHeight: 44 }} /></View>
        </View></Card>
      )) : <Empty emoji="📄" title="No extracts yet" sub="Build one to keep a complete, dated record of your officiating." />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Build an extract" submitLabel="Build PDF" onSubmit={build}
        fields={[{ key: 'from', label: 'Period', type: 'daterange', toKey: 'to' }, { key: 'sport', label: 'Only this sport (optional)', type: 'sport', optional: true }]} initial={{ from: `${year}-01-01`, to: todayLocal() }} />
      <FormSheet visible={!!share} onClose={() => setShare(null)} title="Share this extract" submitLabel="Share" notice="The person can read the PDF until it expires or you stop sharing. Every read is logged."
        onSubmit={async (v) => { try { await api.post(`/me/officials/extracts/${share.id}/shares`, { recipient_id: v.person, days: v.days }); toast('Shared'); setShare(null); await q.reload(); } catch (e) { toast(explain(e)); throw e; } }}
        fields={[{ key: 'person', label: 'Who', type: 'entity', entityKind: 'person', noun: 'person' }, { key: 'days', label: 'For how many days', type: 'stepper', min: 1, max: 90, default: 14, suffix: 'days' }]} initial={{ days: 14 }} />
    </View>
  );
}

function RecordTab({ sports }) {
  return (
    <View style={{ gap: 14 }}>
      <Section title="Reporting extract (PDF)" color={c.pink}><Extracts sports={sports} /></Section>
      <Section title="Feedback about you" color={c.mint}><Feedback /></Section>
    </View>
  );
}

// ------------------------------------------------------------------ History
function HistoryTab({ go, tz }) {
  const [status, setStatus] = useState(null);
  const q = useLoad(() => api.get('/me/officials/history', { ...(status ? { status } : {}), limit: 50 }), [status]);
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const { items, totals } = q.data;
  return (
    <View style={{ gap: 12 }}>
      {totals.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{totals.map((t) => <Metric key={`${t.sport_name}${t.role}`} value={t.matches} label={`${t.sport_name} · ${ROLE_LABEL[t.role] ?? t.role}`} />)}</View> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {[[null, 'All'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['released', 'Released'], ['withdrawn', 'Withdrawn'], ['declined', 'Declined']].map(([v, l]) => <Chip key={l} label={l} active={status === v} onPress={() => setStatus(v)} />)}
      </View>
      {items.length ? <View style={{ gap: 10 }}>{items.map((a) => (
        <Assignment key={a.id} a={a} tz={tz} onOpen={() => go('OfficialMatch', { id: a.fixture_id })}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {a.verified_at_the_time ? <Tag label="Verified at the time" color={c.mintSoft} /> : null}
            <Tag label={`${a.reports_filed} report${a.reports_filed === 1 ? '' : 's'}`} color={c.paper} />
            {a.disputes_linked ? <Tag label={`${a.disputes_linked} dispute${a.disputes_linked === 1 ? '' : 's'} linked`} color={c.sunSoft} /> : null}
          </View>
          <PayActions a={a} reload={q.reload} />
        </Assignment>
      ))}</View> : <Empty emoji="🗂️" title="No officiating history yet" sub="Matches you have officiated build up here from your assignments." />}
      <T size={12} color={c.mute}>This is a record of what you did, not a rating. There is no score or ranking of officials.</T>
    </View>
  );
}

// ------------------------------------------------------------------ Rules
export function AskRules({ fixtureId, sport }) {
  const [question, setQuestion] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { push } = useNav();
  const ask = async () => {
    setBusy(true); setErr(null);
    try { setOut(await api.get('/officials/rules/ask', { question, ...(fixtureId ? { fixture_id: fixtureId } : { sport }) })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 10 }}>
      <Field label="Ask the rules" value={question} onChangeText={setQuestion} placeholder="e.g. How does a free kick restart play?" maxLength={300} hint="Explains what the rulebook says. It never makes a call, judges a player, issues a card or changes a score." />
      <Btn title="Ask" onPress={ask} loading={busy} disabled={question.trim().length < 3} style={{ minHeight: 48 }} />
      {err ? <LoadError error={err} onRetry={ask} /> : null}
      {out ? (
        <Card color={out.declined ? c.sunSoft : c.paper}>
          <View style={{ gap: 8 }}>
            {out.declined || out.insufficient ? <T>{out.message}</T> : <T>{out.answer}</T>}
            {out.citations?.map((x) => (
              <View key={x.n} style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8, gap: 2 }}>
                <T weight="800" size={13}>[{x.n}] {x.no ? `${x.no} · ` : ''}{x.title}</T>
                <T size={12.5} color={c.mute}>{x.source}</T>
                {x.settings.filter((s) => s.local_change).map((s) => <T key={s.label} size={12.5}>Local rule: {s.label} = {String(s.value)} (standard {String(s.standard)})</T>)}
              </View>
            ))}
            {out.rule_version ? <T size={11.5} color={c.mute}>Rulebook version {out.rule_version.standard_hash}{out.rule_version.local ? ` · local rules "${out.rule_version.local.name}" v${out.rule_version.local.version}` : ''}{out.ai ? ' · explained by AI from the sections above' : ''}</T> : null}
          </View>
        </Card>
      ) : null}
      <Btn small title="📖 Open the full rulebook" color={c.paper} ink={c.ink} onPress={() => push('SportRules', sport ? { sport, tab: 'rulebook' } : {})} style={{ alignSelf: 'flex-start', minHeight: 44 }} />
    </View>
  );
}

// ------------------------------------------------------------------ Officials Home
export function OfficialsHome({ tab: tab0 }) {
  const { push: go } = useNav();
  const L = useLayout();
  const [tab, setTab] = useState(tab0 ?? 'today');
  const [sportId, setSportId] = useState(null);
  const q = useLoad(() => api.get('/me/officials/home', sportId ? { sport_id: sportId } : {}), [sportId]);
  React.useEffect(() => { if (tab0) setTab(tab0); }, [tab0]);
  if (q.error && !q.data) return <Screen><H1>Officials home</H1><LoadError error={q.error} onRetry={q.reload} /></Screen>;
  if (!q.data) return <Screen><Loading /></Screen>;
  const h = q.data, tz = h.timezone;
  const cred = CRED[h.credential.state] ?? CRED.none;
  const body = tab === 'today' ? <Today h={h} reload={q.reload} go={go} tz={tz} />
    : tab === 'calendar' ? <CalendarTab tz={tz} go={go} sportId={sportId} />
    : tab === 'availability' ? <AvailabilityTab sports={h.sports} />
    : tab === 'history' ? <HistoryTab go={go} tz={tz} />
    : tab === 'record' ? <RecordTab sports={h.sports} />
    : tab === 'rules' ? <Section title="Rules & interpretations" color={c.violet}>
        {h.next ? <T size={13} color={c.mute}>Answers use the rulebook and local rules for your next match: {h.next.event_name}.</T> : null}
        <AskRules fixtureId={h.next?.fixture_id} sport={h.sport?.slug} />
      </Section>
    : <Section title="Credential" color={c.lime}>
        <Card><View style={{ gap: 6 }}>
          <Tag label={cred[0]} color={cred[1]} />
          {h.credential.licence ? <T>🏅 {h.credential.licence.licence_type} · {h.credential.licence.body_name} · valid to {String(h.credential.licence.expires_on).slice(0, 10)}</T> : <T size={13} color={c.mute}>No federation licence on record for this sport. Licences are managed under Grade, assessments &amp; CPD.</T>}
          <T size={12.5} color={c.mute}>A self-declared profile is not verification. Some competitions only accept verified or licensed officials; the server checks this whenever you are asked to officiate.</T>
        </View></Card>
        <VerificationSection />
      </Section>;
  return (
    <Screen onRefresh={q.reload} refreshing={q.loading}>
      <GradCard colors={grad.hero}>
        <View style={{ gap: 10 }}>
          <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6 }}>OFFICIALS HOME</T>
          <T size={26} weight="800" color="#fff" style={{ letterSpacing: -0.8 }}>{h.sport ? `${h.sport.emoji} ${h.sport.name}` : 'Match official'}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Tag label={cred[0]} color={cred[1]} />
            {h.credential.licence ? <Tag label={`🏅 ${h.credential.licence.licence_type}`} color={c.violetSoft} /> : null}
          </View>
          {h.sports.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{h.sports.map((s) => <Chip key={s.id} label={`${s.emoji} ${s.name}`} active={(sportId ?? h.sport?.id) === s.id} onPress={() => setSportId(s.id)} />)}</View> : null}
        </View>
      </GradCard>
      {!h.sports.length ? <Banner tone={c.sunSoft} action="Add a sport profile" onAction={() => go('SportProfile')}>Add a referee sport profile so organisers can find and ask you.</Banner> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
        <Metric value={h.stats.this_week} label="Matches this week" onPress={() => setTab('calendar')} />
        <Metric value={h.stats.pending} label="Requests to answer" tone={h.stats.pending ? c.sunSoft : undefined} onPress={() => setTab('today')} />
        <Metric value={h.stats.completed_this_season} label="Completed this season" onPress={() => setTab('history')} />
        <Metric value={h.stats.actions} label="Need attention" tone={h.stats.actions ? c.sunSoft : undefined} onPress={() => setTab('today')} />
      </View>
      <View style={{ marginTop: 12, marginBottom: 12 }}>
        <Seg options={[{ value: 'today', label: 'Overview' }, { value: 'calendar', label: 'Calendar' }, { value: 'availability', label: 'Availability' }, { value: 'history', label: 'History' }, { value: 'record', label: 'Record' }, { value: 'rules', label: 'Rules' }, { value: 'credential', label: 'Credential' }]} value={tab} onChange={setTab} />
      </View>
      {body}
    </Screen>
  );
}

// ------------------------------------------------------------------ One match: briefing, checks, console, report
export function OfficialMatch({ id, report: openReport }) {
  const { toast } = useSession();
  const { push: go } = useNav();
  const L = useLayout();
  const q = useLoad(() => api.get(`/fixtures/${id}/briefing`), [id]);
  const reports = useLoad(() => api.get(`/fixtures/${id}/reports`).catch(() => []), [id]);
  const [rep, setRep] = useState(!!openReport);
  const [rules, setRules] = useState(false);
  const [busy, setBusy] = useState(null);
  const [fee, setFee] = useState(null);
  const [rate, setRate] = useState(null);
  const due = useLoad(() => api.get('/me/officials/feedback-due', { limit: 50 }).catch(() => []), [id]);
  if (q.error && !q.data) return <Screen><H1>Match briefing</H1><LoadError error={q.error} onRetry={q.reload} /></Screen>;
  if (!q.data) return <Screen><Loading /></Screen>;
  const b = q.data, tz = b.fixture.timezone;
  const left = b.checklist.filter((x) => !x.done).length;
  const tick = async (item) => {
    setBusy(item.key);
    try { await api.post(`/fixtures/${id}/briefing/checks`, { item_key: item.key, done: !item.done }); await q.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };
  const live = ['scheduled', 'live', 'paused'].includes(b.fixture.status);
  const crew = (
    <Section title="Officiating crew" color={c.violet}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{b.crew.map((m) => (
        <Card key={m.id} pad={12} style={{ minWidth: 150 }}>
          <T weight="800">{m.display_name}</T>
          <View style={{ marginTop: 4, alignSelf: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{roleTag(m.role)}{payTag(m)}</View>
          {['organiser', 'admin'].includes(b.my_role) && m.pay_status !== 'paid' ? <Btn small title={m.fee_minor == null ? 'Set fee' : 'Update fee'} color={c.paper} ink={c.ink} onPress={() => setFee(m)} style={{ marginTop: 8, minHeight: 44, alignSelf: 'flex-start' }} /> : null}
        </Card>
      ))}</View>
      <T size={12} color={c.mute}>Only officials who accepted count as crew. Being on the crew gives no organiser or finance access.</T>
    </Section>
  );
  const rulesCard = (
    <Section title="Rules in force" color={c.cyan}>
      <Card><View style={{ gap: 6 }}>
        {b.rules ? <><T weight="800">{b.rules.book}</T><T size={12.5} color={c.mute}>{b.rules.governing_body} · version {b.rules.standard_hash}</T>
          {b.rules.local ? <T>Local rules: <T weight="800">{b.rules.local.name}</T> v{b.rules.local.version}</T> : <T size={12.5} color={c.mute}>No local rules published for this event: standard rules apply.</T>}
          {b.rules.local_changes?.slice(0, 6).map((ch) => <T key={ch.key ?? ch.label} size={12.5}>• {ch.label ?? ch.key}: {String(ch.value)} (standard {String(ch.std)})</T>)}</>
          : <T size={13} color={c.mute}>No governed rulebook for this sport yet. The scoring set-up below is what the console will use.</T>}
        <T weight="800" style={{ marginTop: 6 }}>{b.structure.label}</T>
        <T size={13}>{b.structure.periods.count} × {b.structure.periods.label.toLowerCase()}{b.structure.sets ? ` · best of ${b.structure.sets.best_of}, first to ${b.structure.sets.points_to_win}` : ''}{b.structure.extra_time ? ` · extra time ${b.structure.extra_time.periods}×${b.structure.extra_time.minutes} min` : ''}{b.structure.shootout ? ' · shoot-out if level' : ''}{b.structure.draw_allowed ? ' · draws allowed' : ' · no draws'}</T>
        {b.structure.actions.length ? <T size={12.5} color={c.mute}>Console actions: {b.structure.actions.join(', ')}</T> : null}
        <Btn small title="📖 Ask the rules" color={c.violet} onPress={() => setRules(true)} style={{ alignSelf: 'flex-start', marginTop: 6, minHeight: 44 }} />
      </View></Card>
    </Section>
  );
  const checks = (
    <Section title={`Pre-match checks · ${b.checklist.length - left}/${b.checklist.length}`} color={c.mint}>
      <View style={{ gap: 8 }}>{b.checklist.map((it) => (
        <Card key={it.key} pad={14} onPress={() => tick(it)} accessibilityLabel={`${it.label}: ${it.done ? 'done' : 'not done'}. Double tap to ${it.done ? 'undo' : 'tick'}`} color={it.done ? c.mintSoft : c.paper} style={{ minHeight: 56 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <T size={24}>{busy === it.key ? '…' : it.done ? '✅' : '⬜'}</T>
            <View style={{ flex: 1 }}><T weight="700" size={15}>{it.label}</T>{it.done && it.by ? <T size={11.5} color={c.mute}>{it.by} · {clock(it.at, tz)}</T> : null}</View>
          </View>
        </Card>
      ))}</View>
    </Section>
  );
  const matchInfo = (
    <Card><View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{roleTag(b.my_role)}<Tag label={b.fixture.status} color={c.paper} /></View>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{b.teams.home ?? 'TBD'} v {b.teams.away ?? 'TBD'}</T>
      <T size={13} color={c.mute}>{b.sport.emoji} {b.event.name}{b.fixture.round ? ` · ${b.fixture.round}` : ''}</T>
      <T weight="700">{when(b.fixture.scheduled_at, tz)} · {b.fixture.duration_min} min</T>
      {b.venue.resource || b.venue.name ? <T size={13} color={c.mute}>📍 {[b.venue.resource, b.venue.name, b.venue.city].filter(Boolean).join(' · ')}</T> : null}
      <T size={13} color={c.mute}>Organiser: {b.organiser.name} (contact in the app)</T>
      <T size={12} color={c.mute}>🛟 {b.safety}</T>
    </View></Card>
  );
  const lineups = (
    <Section title="Line-ups" color={c.pink}>
      <Cols a={<Lineup side={b.lineups.home} name={b.teams.home} youth={b.event.youth} />} b={<Lineup side={b.lineups.away} name={b.teams.away} youth={b.event.youth} />} />
    </Section>
  );
  const actions = (
    <Section title="Match day" color={c.sun}>
      <View style={{ gap: 8 }}>
        {live ? <Btn title="🎛️ Open the live console" onPress={() => go('MatchCentre', { id })} style={{ minHeight: 56 }} /> : null}
        <Btn title="📝 Result & sign-off (score sheet)" color={c.violet} onPress={() => go('ScoreSheet', { id })} style={{ minHeight: 56 }} />
        <Btn title="🗒️ File a match or incident report" color={c.paper} ink={c.ink} onPress={() => setRep(true)} style={{ minHeight: 56 }} />
        <T size={12} color={c.mute}>Scoring, fouls, cards and substitutions are recorded in the live console; undo is an audited correction, and taps are safe to repeat after a lost connection. The result is not official until the score sheet is signed, approved and published. Disputes and appeals go through Support, linked to this match.</T>
      </View>
    </Section>
  );
  const mine = reports.data ?? [];
  return (
    <Screen onRefresh={() => { q.reload(); reports.reload(); }} refreshing={q.loading}>
      <H1>Match briefing</H1>
      {matchInfo}
      <View style={{ height: 12 }} />
      {L.tablet ? <Cols a={<>{checks}{actions}</>} b={<>{crew}{rulesCard}{lineups}</>} /> : <>{checks}{actions}{crew}{rulesCard}{lineups}</>}
      {(due.data ?? []).filter((x) => x.fixture_id === id).length ? (
        <Section title="Give feedback on the officials" color={c.sun}>
          <View style={{ gap: 8 }}>{(due.data ?? []).filter((x) => x.fixture_id === id).map((x) => <Card key={x.official_assignment_id} pad={14}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{x.official_name}</T>{roleTag(x.role)}</View><Btn small title="Rate" onPress={() => setRate(x)} style={{ minHeight: 44 }} /></View></Card>)}</View>
          <T size={12} color={c.mute}>Five fixed criteria, no overall score. The official sees the averages and your comment without your name, once at least three people have answered.</T>
        </Section>
      ) : null}
      <Section title="Reports on this match" color={c.violet}>
        {mine.length ? <View style={{ gap: 8 }}>{mine.map((r) => <Card key={r.id} pad={14}><T weight="800">{REPORT_TYPES.find((t) => t.value === r.category)?.label ?? r.category}</T><T size={13}>{r.summary}</T><T size={11.5} color={c.mute}>{r.author_name} · revision {r.revision}</T></Card>)}</View> : <Empty emoji="🗒️" title="No reports yet" />}
      </Section>
      <FormSheet visible={rep} onClose={() => setRep(false)} title="Official report" submitLabel="File report" onSubmit={async (v) => {
        await api.post(`/fixtures/${id}/reports`, { category: v.category, summary: v.summary, note: v.note || undefined, visibility: v.visibility });
        toast('Report filed. The organiser has been told one exists.'); setRep(false); reports.reload();
      }} notice="Operational facts only: what happened and who was involved. Do not record medical detail; clinical information is never stored in a report."
        fields={[{ key: 'category', label: 'Type', type: 'chips', options: REPORT_TYPES }, { key: 'summary', label: 'One-line summary', type: 'text' }, { key: 'note', label: 'Details (kept encrypted)', type: 'multiline', optional: true },
          { key: 'visibility', label: 'Who can read the details', type: 'choice', options: [{ value: 'organiser', label: 'Organiser' }, { value: 'author', label: 'Only me' }] }]}
        initial={{ category: 'match_report', visibility: 'organiser' }} />
      <FormSheet visible={!!fee} onClose={() => setFee(null)} title={`Fee for ${fee?.display_name ?? ''}`} submitLabel="Save" notice="This records the agreed fee and where payment stands. It does not move money; payments made through SportArena settle through the payment system."
        onSubmit={async (v) => { try { await api.post(`/official-assignments/${fee.id}/fee`, { fee_minor: v.fee, currency: v.currency, status: v.status, note: v.note || undefined }); toast('Fee recorded'); setFee(null); await q.reload(); } catch (e) { toast(explain(e)); throw e; } }}
        fields={[{ key: 'fee', label: 'Fee', type: 'money', currency: (v) => v.currency }, { key: 'currency', label: 'Currency', type: 'currency' }, { key: 'status', label: 'Status', type: 'choice', options: [{ value: 'agreed', label: 'Agreed' }, { value: 'due', label: 'Due' }, { value: 'paid', label: 'Paid' }] }, { key: 'note', label: 'Note (optional)', optional: true }]}
        initial={{ fee: fee?.fee_minor ?? '', currency: fee?.fee_currency ?? undefined, status: fee?.pay_status && fee.pay_status !== 'none' && fee.pay_status !== 'disputed' ? fee.pay_status : 'agreed' }} />
      <FormSheet visible={!!rate} onClose={() => setRate(null)} title={`Feedback on ${rate?.official_name ?? ''}`} submitLabel="Send feedback"
        onSubmit={async (v) => { try { await api.post(`/official-assignments/${rate.official_assignment_id}/feedback`, { ratings: { communication: v.communication, consistency: v.consistency, game_control: v.game_control, positioning_fitness: v.positioning_fitness, conduct: v.conduct }, comment: v.comment || undefined }); toast('Thank you. Your feedback was recorded.'); setRate(null); await due.reload(); } catch (e) { toast(explain(e)); throw e; } }}
        fields={[['communication', 'Communication'], ['consistency', 'Consistency'], ['game_control', 'Game control'], ['positioning_fitness', 'Positioning and fitness'], ['conduct', 'Professional conduct']].map(([key, label]) => ({ key, label: `${label} (1 to 5)`, type: 'stepper', min: 1, max: 5, default: 3 })).concat([{ key: 'comment', label: 'Comment (optional, kept encrypted)', type: 'multiline', optional: true }])} initial={{ communication: 3, consistency: 3, game_control: 3, positioning_fitness: 3, conduct: 3 }} />
      <Sheet visible={rules} onClose={() => setRules(false)} title="Ask the rules"><AskRules fixtureId={id} sport={b.sport.slug} /></Sheet>
    </Screen>
  );
}

function Lineup({ side, name, youth }) {
  return (
    <Card><View style={{ gap: 4 }}>
      <T weight="800">{name ?? 'TBD'}</T>
      {!side ? <T size={13} color={c.mute}>Team not decided yet.</T> : !side.declared ? <T size={13} color={c.mute}>No line-up declared yet.</T>
        : youth ? <T size={13} color={c.mute}>{side.count} players declared. Names are hidden for youth events.</T>
        : side.players.map((p, i) => <T key={i} size={13.5}>{p.name}{p.status === 'unused_sub' || p.status === 'substitute_on' ? <T size={12} color={c.mute}> · sub</T> : null}</T>)}
    </View></Card>
  );
}

// ------------------------------------------------------------------ event settings (organiser): who may officiate, and whose logo heads the closure reports
const POLICY = [{ value: 'optional', label: 'Anyone with a referee profile' }, { value: 'verified', label: 'Verified officials only' }, { value: 'licensed', label: 'Federation-licensed officials only' }];
export function EventOfficialsSettings({ e, reload }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const kits = useLoad(() => api.get('/brand-kits').catch(() => []), []);
  const withLogo = (kits.data ?? []).filter((k) => k.logo_asset_id && !k.archived_at);
  const kit = withLogo.find((k) => k.id === e.brand_kit_id);
  return (
    <Section title="Officials & report branding" color={c.violet} action="Edit" onAction={() => setOpen(true)}>
      <Card><View style={{ gap: 4 }}>
        <T>🏅 Who may officiate: <T weight="800">{POLICY.find((p) => p.value === (e.official_policy ?? 'optional'))?.label}</T>{e.official_policy === 'licensed' && e.official_min_grade_rank ? <T> · grade rank {e.official_min_grade_rank}+</T> : null}</T>
        <T>🖼️ Logo on referee reports: <T weight="800">{kit ? (kit.display_name ?? kit.name) : 'none chosen'}</T></T>
        <T size={12} color={c.mute}>The rule is enforced by the server whenever someone is asked to officiate. The organisation's own logo is added automatically when the event belongs to an organisation with a brand kit.</T>
      </View></Card>
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Officials & report branding"
        onSubmit={async (v) => { try { await api.patch(`/events/${e.id}`, { official_policy: v.policy, official_min_grade_rank: v.policy === 'licensed' ? v.rank : 0, brand_kit_id: v.kit || null }); toast('Saved'); setOpen(false); await reload?.(); } catch (x) { toast(explain(x)); throw x; } }}
        fields={[{ key: 'policy', label: 'Who may be assigned as an official', type: 'chips', options: POLICY }, { key: 'rank', label: 'Minimum licence grade rank', type: 'stepper', min: 0, max: 20, default: 0, show: (v) => v.policy === 'licensed' },
          { key: 'kit', label: 'Logo on referee reports (a brand kit with a logo)', type: 'chips', optional: true, options: [{ value: '', label: 'None' }, ...withLogo.map((k) => ({ value: k.id, label: k.display_name ?? k.name }))] }]}
        initial={{ policy: e.official_policy ?? 'optional', rank: e.official_min_grade_rank ?? 0, kit: e.brand_kit_id ?? '' }} />
    </Section>
  );
}
