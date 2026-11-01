// Event Operations Centre (#586): the Operations tab of the Event console. Readiness (derived live from the other domains), the event-day board,
// incidents with escalation, operational contacts, and the post-event debrief, report and close. All logic is in the API (capabilities
// "Event operations"); this only calls it, so iOS, iPadOS, Android and web behave the same.
import React, { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { usePoll } from '../live';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useDo } from './console-utils';
import { A, ABar, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStat, AT, ATag, ReasonSheet } from '../arena';
import { FormSheet } from '../FormSheet';
import { ErrorBox, Loading, Sheet } from '../ui';
import { locale } from '../locale';

const stamp = (d) => (d ? new Date(d).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const SEV = { critical: A.red, high: A.orange, medium: A.sun, low: A.cyan };
const SEV_CHOICES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['critical', 'Critical']].map(([value, label]) => ({ value, label }));
const CATEGORIES = ['medical', 'safety', 'security', 'crowd', 'weather', 'facility', 'conduct', 'technical', 'supplier', 'transport', 'other'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
const CONTACT_AREAS = [['control_room', 'Control room'], ['venue', 'Venue'], ['medical', 'Medical'], ['security', 'Security'], ['officials', 'Officials'], ['media', 'Media'], ['transport', 'Transport'], ['suppliers', 'Suppliers'], ['sponsors', 'Sponsors'], ['emergency', 'Emergency'], ['organiser', 'Organiser'], ['other', 'Other']].map(([value, label]) => ({ value, label }));
const STATE = { met: ['✓', A.green], open: ['○', A.sun], waived: ['⊘', A.mute] };

/** Save a CSV: a download on the web, the share sheet on a phone or tablet. */
async function saveCsv(r) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
    const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u);
  } else await Share.share({ title: r.filename, message: r.csv });
}

export function OperationsTab({ id, e, isOrg, sub, setSub, goTab }) {
  const view = sub || (isOrg ? 'readiness' : 'live');
  const views = [['readiness', '✅ Readiness', isOrg], ['live', '📟 Live', true], ['incidents', '🚨 Incidents', true], ['contacts', '☎️ Contacts', true], ['debrief', '📝 Debrief', isOrg]].filter((v) => v[2]);
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {views.map(([k, label]) => <AChip key={k} label={label} active={view === k} onPress={() => setSub(k)} />)}
      </View>
      {view === 'readiness' && isOrg && <Readiness id={id} goTab={goTab} />}
      {view === 'live' && <LiveBoard id={id} setSub={setSub} />}
      {view === 'incidents' && <Incidents id={id} isOrg={isOrg} />}
      {view === 'contacts' && <Contacts id={id} isOrg={isOrg} />}
      {view === 'debrief' && isOrg && <Debrief id={id} e={e} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------- readiness
/** Where each requirement is fixed: the tab that owns the data (never re-entered here). */
export const FIX = { programme: ['games'], venue: ['venue'], participants: ['teams'], officials: ['people', 'hiring'], staff: ['people', 'departments'], suppliers: ['business', 'partners'], accreditation: ['accreditation'], transport: ['travel'], media: ['broadcast'], sponsors: ['business', 'partners'], finance: ['business', 'budget'], tasks: ['boards'], safety: ['people', 'departments'], medical: ['people', 'departments'], tickets: ['tickets'], procurement: ['business', 'services'] };

export function Readiness({ id, goTab }) {
  const r = useLoad(() => api.get(`/events/${id}/ops/readiness`), [id]);
  const act = useDo(r.reload);
  const [form, setForm] = useState(false);
  const [waive, setWaive] = useState(null);
  const [filter, setFilter] = useState('open');
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  if (!d.items.length) return (
    <>
      <AEmpty emoji="✅" title="Define what “ready” means" sub="Add the standard requirements. Each one is read live from venue, teams, crew, accreditation, budget, sponsors, travel and media, so nothing is typed twice." action="Add the standard requirements" onAction={() => act(() => api.post(`/events/${id}/ops/requirements/standard`, {}), 'Requirements added')} />
      <ABtn small tone="ghost" title="＋ Add your own requirement" onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      <ReqForm id={id} visible={form} onClose={() => setForm(false)} onDone={r.reload} />
    </>
  );
  const shown = d.items.filter((i) => filter === 'all' || (filter === 'open' ? i.state === 'open' : i.state === filter));
  return (
    <>
      <ACard tone={d.percent === 100 ? A.green : A.violet} style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <AT size={34} weight="900" num>{d.percent}%</AT>
          <AT size={13} color={A.mute}>{d.met} of {d.total} requirements met{d.waived ? ` · ${d.waived} waived` : ''}</AT>
        </View>
        <ABar pct={d.percent} color={d.percent === 100 ? A.green : A.magenta} height={10} />
        <View style={{ gap: 6, marginTop: 4 }}>
          {d.areas.map((a) => (
            <View key={a.area} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <AT size={12.5} weight="700" style={{ flex: 1 }}>{a.label}</AT>
              <AT size={12} color={a.met === a.total ? A.green : A.mute} num>{a.met}/{a.total}</AT>
            </View>
          ))}
        </View>
      </ACard>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {[['open', 'To do'], ['met', 'Met'], ['waived', 'Waived'], ['all', 'All']].map(([k, label]) => <AChip key={k} label={label} active={filter === k} onPress={() => setFilter(k)} />)}
      </View>
      {shown.length ? shown.map((i) => {
        const [mark, col] = STATE[i.state];
        const fix = FIX[i.area];
        return (
          <ARow key={i.id} tone={i.state === 'met' ? undefined : undefined}
            left={<View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: `${col}33` }}><AT size={14} weight="900" color={col}>{mark}</AT></View>}
            title={i.title} sub={[i.area_label, i.detail, i.state === 'waived' ? `Waived: ${i.waived_reason}` : null, i.owner_name ? `Owner ${i.owner_name}` : null, i.due_on ? `Due ${i.due_on}` : null].filter(Boolean).join(' · ')}
            right={<>
              {!i.required ? <ATag label="Optional" tone={A.mute} /> : null}
              {i.state === 'open' && !i.derived ? <ABtn small title="Done" onPress={() => act(() => api.patch(`/events/${id}/ops/requirements/${i.id}`, { status: 'done' }), 'Marked done')} /> : null}
              {i.state === 'open' && i.derived && fix ? <ABtn small tone="ghost" title="Fix" onPress={() => goTab(...fix)} /> : null}
              {i.state === 'open' ? <ABtn small tone="ghost" title="Waive" onPress={() => setWaive(i)} /> : null}
              {i.state !== 'open' && !i.derived && i.state === 'met' ? <ABtn small tone="ghost" title="Reopen" onPress={() => act(() => api.patch(`/events/${id}/ops/requirements/${i.id}`, { status: 'open' }), 'Reopened')} /> : null}
              {i.state === 'waived' ? <ABtn small tone="ghost" title="Restore" onPress={() => act(() => api.patch(`/events/${id}/ops/requirements/${i.id}`, { status: 'open' }), 'Restored')} /> : null}
            </>} />
        );
      }) : <AEmpty emoji="🎉" title={filter === 'open' ? 'Nothing left to do' : 'Nothing here'} />}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <ABtn small tone="ghost" title="＋ Add a requirement" onPress={() => setForm(true)} />
        <ABtn small tone="ghost" title="Add any missing standard ones" onPress={() => act(() => api.post(`/events/${id}/ops/requirements/standard`, {}), (x) => (x.added ? `${x.added} added` : 'Already complete'))} />
      </View>
      <ReqForm id={id} visible={form} onClose={() => setForm(false)} onDone={r.reload} />
      <ReasonSheet visible={!!waive} onClose={() => setWaive(null)} title={waive ? `Waive “${waive.title}”` : ''} sub="It stops counting toward readiness, and the reason is kept." presets={['Not applicable to this event', 'Handled outside the platform', 'Organiser decision']} confirmLabel="Waive" tone="sun"
        onConfirm={(reason) => act(() => api.patch(`/events/${id}/ops/requirements/${waive.id}`, { status: 'waived', waived_reason: reason }), 'Waived')} />
    </>
  );
}

function ReqForm({ id, visible, onClose, onDone }) {
  const [areas, setAreas] = useState([]);
  useLoad(async () => { if (visible && !areas.length) setAreas((await api.get('/event-ops/requirements/standard')).areas); return null; }, [visible]);
  return (
    <FormSheet visible={visible} onClose={onClose} title="Add a requirement" submitLabel="Add" initial={{ area: 'other', required: true }}
      fields={[
        { key: 'title', label: 'What must be true before the event?', hint: 'e.g. Fire-safety certificate signed' },
        { key: 'area', label: 'Area', type: 'chips', options: areas.map((a) => ({ value: a.key, label: a.label })) },
        { key: 'owner_id', label: 'Owner', type: 'entity', entityKind: 'person', optional: true },
        { key: 'due_on', label: 'Due by', type: 'date', optional: true },
        { key: 'required', label: 'Counts toward readiness', type: 'switch' },
      ]}
      onSubmit={async (v) => { await api.post(`/events/${id}/ops/requirements`, { title: v.title, area: v.area, owner_id: v.owner_id || undefined, due_on: v.due_on || undefined, required: v.required }); onDone(); return null; }} />
  );
}

// ---------------------------------------------------------------------------------------------------------------- live board
export function LiveBoard({ id, setSub }) {
  const nav = useNav();
  const b = useLoad(() => api.get(`/events/${id}/ops/board`), [id]);
  usePoll(b.reload, 10000);
  if (b.error) return <ErrorBox error={b.error} onRetry={b.reload} />;
  if (!b.data) return <Loading />;
  const d = b.data;
  const worst = d.incidents.worst;
  return (
    <>
      {d.event.status === 'paused' ? <ACard tone={A.sun}><AT size={14} weight="800">⏸ Event paused{d.event.pause_reason ? `: ${d.event.pause_reason}` : ''}</AT></ACard> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="🔴" value={d.games.live} label="Live now" />
        <AStat icon="⏭️" value={d.games.scheduled} label="To play" />
        <AStat icon="🚨" value={d.incidents.open} label="Incidents" tone={worst ? SEV[worst] : undefined} />
        <AStat icon="🎫" value={d.access.checked_in} label="Checked in" />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="⛔" value={d.access.refused} label="Gate refusals" />
        <AStat icon="🧱" value={d.tasks.blocked} label="Blocked" />
        <AStat icon="⏰" value={d.tasks.overdue} label="Overdue" />
        <AStat icon="🧩" value={d.crew.active} label="Crew" />
      </View>
      {d.incidents.media_open || d.incidents.travel_open ? (
        <ACard tone={A.orange} style={{ gap: 4 }}>
          <AT size={13} weight="800">Open in other desks</AT>
          {d.incidents.media_open ? <AT size={12.5} color={A.mute}>{d.incidents.media_open} broadcast / media incident{d.incidents.media_open === 1 ? '' : 's'} (Broadcast tab)</AT> : null}
          {d.incidents.travel_open ? <AT size={12.5} color={A.mute}>{d.incidents.travel_open} team-travel incident{d.incidents.travel_open === 1 ? '' : 's'} (Travel tab)</AT> : null}
        </ACard>
      ) : null}
      <ASection title="Up next" />
      {d.next_up.length ? d.next_up.map((g) => (
        <ARow key={g.id} title={`${g.home ?? 'TBD'} v ${g.away ?? 'TBD'}`} sub={stamp(g.scheduled_at)} right={<ATag label={g.status} />} onPress={() => nav.push('MatchCentre', { id: g.id })} />
      )) : <AEmpty emoji="🗓️" title="No games waiting" />}
      <ABtn tone="live" title="🚨 Report an incident" onPress={() => setSub('incidents')} style={{ alignSelf: 'flex-start' }} />
      <AT size={11} color={A.mute}>Updated {stamp(d.as_of)} · refreshes every 10 seconds</AT>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------- incidents
export function Incidents({ id, isOrg }) {
  const { user } = useSession();
  const [filter, setFilter] = useState('active');
  const list = useLoad(() => api.get(`/events/${id}/ops/incidents`, { status: filter }), [id, filter]);
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState(null);
  usePoll(list.reload, 15000);
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['active', 'Active'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['all', 'All']].map(([k, label]) => <AChip key={k} label={label} active={filter === k} onPress={() => setFilter(k)} />)}
        <ABtn small tone="live" title="＋ Report" onPress={() => setForm(true)} />
      </View>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((i) => (
        <ARow key={i.id} tone={SEV[i.severity]} title={`${i.ref} · ${i.title}`}
          sub={[i.category, i.location, `${stamp(i.occurred_at)}`, i.assignee_name ? `Handling: ${i.assignee_name}` : 'Unassigned', i.escalation_level ? `Escalation L${i.escalation_level}` : null].filter(Boolean).join(' · ')}
          right={<><ATag label={i.severity} tone={SEV[i.severity]} /><ATag label={i.status} /></>} onPress={() => setOpen(i)} />
      )) : <AEmpty emoji="🟢" title="No incidents" sub={filter === 'active' ? 'Anything reported shows up here for the whole crew.' : undefined} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Report an incident" submitLabel="Report" color={A.red} initial={{ severity: 'medium', category: 'other' }}
        fields={[
          { key: 'title', label: 'What happened?' },
          { key: 'severity', label: 'How serious?', type: 'chips', options: SEV_CHOICES },
          { key: 'category', label: 'Kind', type: 'chips', options: CATEGORIES },
          { key: 'location', label: 'Where', optional: true, hint: 'e.g. Gate B, Court 2' },
          { key: 'detail', label: 'Details', type: 'multiline', optional: true, hint: 'Stored encrypted. Only the organiser, department leads, the reporter and the handler can read it.' },
        ]}
        onSubmit={async (v) => { await api.post(`/events/${id}/ops/incidents`, { title: v.title, severity: v.severity, category: v.category, location: v.location || undefined, detail: v.detail || undefined, client_key: `${user?.id?.slice(0, 8) ?? 'u'}-${Date.now()}` }); list.reload(); return null; }} />
      <IncidentSheet id={id} inc={open} isOrg={isOrg} onClose={() => setOpen(null)} onChanged={() => { list.reload(); setOpen(null); }} />
    </>
  );
}

function IncidentSheet({ id, inc, isOrg, onClose, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => (inc ? api.get(`/events/${id}/ops/incidents/${inc.id}`) : Promise.resolve(null)), [inc?.id]);
  const [ask, setAsk] = useState(null);       // 'escalate' | 'resolve' | 'reopen' | 'note'
  const [assign, setAssign] = useState(false);
  const post = async (action, extra = {}) => {
    try { await api.post(`/events/${id}/ops/incidents/${inc.id}/action`, { action, ...extra }); toast('Done'); onChanged(); } catch (x) { toast('' + x.message); }
  };
  const x = d.data;
  const active = inc && ['open', 'acknowledged', 'escalated'].includes(inc.status);
  return (
    <Sheet visible={!!inc} onClose={onClose} title={inc ? `${inc.ref} · ${inc.severity}` : ''}>
      {!inc ? null : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !x ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <AT size={17} weight="900" color="#0F172A">{x.title}</AT>
          <AT size={13} color="#475569">{[x.category, x.location, `Reported by ${x.reporter_name}`, stamp(x.occurred_at)].filter(Boolean).join(' · ')}</AT>
          {x.detail ? <AT size={14} color="#0F172A">{x.detail}</AT> : null}
          {x.resolution ? <ACard tone={A.green}><AT size={13} weight="800">Resolution</AT><AT size={13}>{x.resolution}</AT></ACard> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {active && inc.status === 'open' ? <ABtn small title="Acknowledge" onPress={() => post('acknowledge')} /> : null}
            {active && isOrg ? <ABtn small tone="ghost" title="Assign" onPress={() => setAssign(true)} /> : null}
            {active && isOrg ? <ABtn small tone="sun" title="Escalate" onPress={() => setAsk('escalate')} /> : null}
            {active ? <ABtn small tone="lime" title="Resolve" onPress={() => setAsk('resolve')} /> : null}
            {inc.status === 'resolved' && isOrg ? <ABtn small title="Close" onPress={() => post('close')} /> : null}
            {['resolved', 'closed'].includes(inc.status) && isOrg ? <ABtn small tone="ghost" title="Reopen" onPress={() => setAsk('reopen')} /> : null}
            <ABtn small tone="ghost" title="Add note" onPress={() => setAsk('note')} />
          </View>
          <AT size={12} weight="800" color="#64748B" style={{ marginTop: 6 }}>HISTORY</AT>
          {x.history.map((h) => <AT key={h.id} size={12.5} color="#475569">{stamp(h.at)} · <AT size={12.5} weight="800" color="#0F172A">{h.action}</AT>{h.actor_name ? ` · ${h.actor_name}` : ''}{h.note ? ` · ${h.note}` : ''}</AT>)}
        </View>
      )}
      <ReasonSheet visible={ask === 'escalate'} onClose={() => setAsk(null)} title="Escalate" sub="The organiser and every department lead are alerted." presets={['Needs more resources', 'Spreading', 'Needs emergency services', 'Nobody responding']} confirmLabel="Escalate" tone="live" onConfirm={(r) => post('escalate', { note: r })} />
      <ReasonSheet visible={ask === 'resolve'} onClose={() => setAsk(null)} title="Resolve" sub="What was done?" presets={['Treated on site', 'Referred to hospital', 'Fixed', 'Handed to venue', 'No action needed']} confirmLabel="Resolve" tone="lime" onConfirm={(r) => post('resolve', { note: r })} />
      <ReasonSheet visible={ask === 'reopen'} onClose={() => setAsk(null)} title="Reopen" sub="Why?" presets={['Happened again', 'Not actually fixed']} confirmLabel="Reopen" tone="sun" onConfirm={(r) => post('reopen', { note: r })} />
      <ReasonSheet visible={ask === 'note'} onClose={() => setAsk(null)} title="Add a note" presets={[]} confirmLabel="Add note" tone="hero" onConfirm={(r) => post('note', { note: r })} />
      <FormSheet visible={assign} onClose={() => setAssign(false)} title="Who handles it?" submitLabel="Assign"
        fields={[{ key: 'assignee_id', label: 'Crew member', type: 'entity', entityKind: 'person' }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/ops/incidents/${inc.id}/action`, { action: 'assign', assignee_id: v.assignee_id }); onChanged(); return null; }} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------- contacts
export function Contacts({ id, isOrg }) {
  const [reveal, setReveal] = useState(false);
  const list = useLoad(() => api.get(`/events/${id}/ops/contacts`, { include_contact: reveal }), [id, reveal]);
  const act = useDo(list.reload);
  const [form, setForm] = useState(false);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <AChip label={reveal ? '🔓 Numbers shown' : '🔒 Show phone & email'} active={reveal} onPress={() => setReveal(!reveal)} />
        {isOrg ? <ABtn small title="＋ Add contact" onPress={() => setForm(true)} /> : null}
      </View>
      <AT size={11.5} color={A.mute}>Showing phone numbers and emails is recorded in the audit log.</AT>
      {list.data.length ? list.data.map((k) => (
        <ARow key={k.id} title={k.name} sub={[CONTACT_AREAS.find((a) => a.value === k.area)?.label, k.role_title, k.on_duty, reveal ? [k.phone, k.email].filter(Boolean).join(' · ') : null].filter(Boolean).join(' · ')}
          right={isOrg ? <ABtn small tone="ghost" title="Remove" onPress={() => act(() => api.patch(`/events/${id}/ops/contacts/${k.id}`, { archive: true }), 'Removed (kept in the history)')} /> : null} />
      )) : <AEmpty emoji="☎️" title="No contacts yet" sub={isOrg ? 'Add the control room, venue manager, medical lead, security and emergency numbers.' : 'The organiser has not added any.'} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Add a contact" submitLabel="Add" initial={{ area: 'control_room' }}
        fields={[
          { key: 'area', label: 'Area', type: 'chips', options: CONTACT_AREAS },
          { key: 'who', label: 'Person on the platform', type: 'entity', entityKind: 'person', optional: true, hint: 'Pick someone, or just type a name below.' },
          { key: 'name', label: 'Name' },
          { key: 'role_title', label: 'Role', optional: true },
          { key: 'phone', label: 'Phone', input: 'phone', optional: true },
          { key: 'email', label: 'Email', input: 'email', optional: true },
          { key: 'on_duty', label: 'On duty', optional: true, hint: 'e.g. Sat–Sun 07:00–20:00' },
        ]}
        onSubmit={async (v) => { await api.post(`/events/${id}/ops/contacts`, { area: v.area, name: v.name, role_title: v.role_title || undefined, user_id: v.who || undefined, phone: v.phone || undefined, email: v.email || undefined, on_duty: v.on_duty || undefined }); list.reload(); return null; }} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------- debrief, report, close
export function Debrief({ id, e }) {
  const d = useLoad(() => api.get(`/events/${id}/ops/debrief`), [id]);
  const board = useLoad(() => api.get(`/events/${id}/ops/board`), [id]);
  const { toast } = useSession();
  const act = useDo(() => { d.reload(); board.reload(); });
  const [summary, setSummary] = useState(false);
  const [item, setItem] = useState(null);
  const [blockers, setBlockers] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data;
  const closed = board.data?.event.closed;
  const exportReport = async () => { try { const r = await api.get(`/events/${id}/ops/report/export`); await saveCsv(r); toast(`${r.rows} rows exported`); } catch (z) { toast('' + z.message); } };
  const close = async () => { try { await api.post(`/events/${id}/ops/close`, {}); toast('Operations closed'); setBlockers(null); d.reload(); board.reload(); } catch (z) { if (z.status === 409 && z.details?.blockers) setBlockers(z.details.blockers); else toast('' + z.message); } };
  const KINDS = [['went_well', '👍 What went well'], ['improve', '🔧 What to improve'], ['lesson', '💡 Lessons learned']];
  return (
    <>
      <ACard tone={closed ? A.green : A.violet} style={{ gap: 6 }}>
        <AT size={16} weight="900">{closed ? 'Operations closed 🔒' : 'Post-event debrief'}</AT>
        <AT size={13} color={A.mute}>{x.summary || 'Write what happened, in a few lines.'}</AT>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <ABtn small tone="ghost" title={x.summary ? 'Edit summary' : 'Write summary'} onPress={() => setSummary(true)} />
          <ABtn small tone="ghost" title="⬇ Export report (CSV)" onPress={exportReport} />
        </View>
      </ACard>
      {KINDS.map(([k, label]) => (
        <View key={k} style={{ gap: 8 }}>
          <ASection title={label} action="Add" onAction={() => setItem(k)} />
          {x.items.filter((i) => i.kind === k).map((i) => (
            <ARow key={i.id} title={i.body} sub={[i.area, i.owner_name ? `Owner ${i.owner_name}` : null, i.task_id ? `Follow-up task: ${i.task_status}` : null].filter(Boolean).join(' · ')}
              right={<ABtn small tone="ghost" title="Archive" onPress={() => act(() => api.del(`/events/${id}/ops/debrief/items/${i.id}`), 'Archived')} />} />
          ))}
        </View>
      ))}
      {closed ? <ABtn tone="ghost" title="Reopen operations" onPress={() => act(() => api.post(`/events/${id}/ops/reopen`, {}), 'Reopened')} style={{ alignSelf: 'flex-start' }} />
        : <ABtn tone="live" title="🔒 Close event operations" onPress={close} style={{ alignSelf: 'flex-start' }} />}
      {blockers ? <ACard tone={A.orange} style={{ gap: 4 }}><AT size={14} weight="900">Not ready to close</AT>{blockers.map((b) => <AT key={b} size={13} color={A.mute}>• {b}</AT>)}</ACard> : null}
      <FormSheet visible={summary} onClose={() => setSummary(false)} title="Debrief summary" submitLabel="Save" initial={{ summary: x.summary ?? '' }}
        fields={[{ key: 'summary', label: 'Summary', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/ops/debrief`, { summary: v.summary }); d.reload(); return null; }} />
      <FormSheet visible={!!item} onClose={() => setItem(null)} title={KINDS.find((k) => k[0] === item)?.[1] ?? ''} submitLabel="Add" initial={{}}
        fields={[
          { key: 'body', label: 'What?', type: 'multiline' },
          { key: 'area', label: 'Area', type: 'chips', optional: true, options: [['venue', 'Venue'], ['programme', 'Programme'], ['officials', 'Officials'], ['staff', 'Staff'], ['suppliers', 'Suppliers'], ['safety', 'Safety'], ['medical', 'Medical'], ['media', 'Media'], ['sponsors', 'Sponsors'], ['finance', 'Budget'], ['transport', 'Transport']].map(([value, label]) => ({ value, label })) },
          ...(item === 'improve' ? [{ key: 'owner_id', label: 'Who follows up?', type: 'entity', entityKind: 'person', optional: true }, { key: 'due_on', label: 'Follow up by', type: 'date', optional: true }] : []),
        ]}
        onSubmit={async (v) => { await api.post(`/events/${id}/ops/debrief/items`, { kind: item, body: v.body, area: v.area || undefined, follow_up: item === 'improve' && (v.owner_id || v.due_on) ? { owner_id: v.owner_id || undefined, due_on: v.due_on || undefined } : undefined }); d.reload(); return null; }} />
    </>
  );
}

/** Overview summary: the readiness percentage and the next things to fix. Replaces the old client-side "Get the event ready" list (same checks, now server-side in Readiness). */
export function ReadinessCard({ id, goTab }) {
  const r = useLoad(() => api.get(`/events/${id}/ops/readiness`), [id]);
  const act = useDo(r.reload);
  if (!r.data) return null;
  const d = r.data;
  if (!d.items.length) return (
    <ACard tone={A.violet} style={{ gap: 8 }}>
      <AT size={17} weight="900">Get the event ready</AT>
      <AT size={13} color={A.mute}>Add the standard requirements: venue, teams, crew, accreditation, budget and more, each read live from where you already entered it.</AT>
      <ABtn small title="Add the requirements" onPress={() => act(() => api.post(`/events/${id}/ops/requirements/standard`, {}), 'Requirements added')} style={{ alignSelf: 'flex-start' }} />
    </ACard>
  );
  const next = d.items.filter((i) => i.state === 'open' && i.required).slice(0, 3);
  return (
    <ACard tone={d.percent === 100 ? A.green : A.violet} style={{ gap: 6 }} onPress={() => goTab('operations', 'readiness')}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <AT size={17} weight="900">{d.percent === 100 ? 'All set 🎉' : 'Get the event ready'}</AT>
        <AT size={13} weight="900" color={A.cyan} num>{d.percent}%</AT>
      </View>
      <ABar pct={d.percent} color={d.percent === 100 ? A.green : A.magenta} />
      {next.map((i) => <AT key={i.id} size={13} color={A.mute}>○ {i.title}{i.detail ? ` · ${i.detail}` : ''}</AT>)}
      <AT size={12} weight="800" color={A.cyan}>Open the Operations centre →</AT>
    </ACard>
  );
}
