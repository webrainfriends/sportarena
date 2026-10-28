// Team & delegation travel operations (#485). One home for trips: the list (Trips), one trip (Trip: board, party, transport, stay, documents, equipment,
// money, reports, history) and the Travel tab inside the event console. All logic is in the API; this only calls it and adapts to phone, tablet and desktop.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { A, AEmpty, ARow, ASection, AT, ATag } from '../arena';
import { Btn, Card, Chip, Empty, ErrorBox, H1, HScroll, Loading, Screen, Seg, Tag, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { useLayout } from '../layout';
import { CountryPicker } from '../country-picker';
import { MapLinks, placeIn, placeOut, placeText } from '../place-picker';
import { Block, DocsTab, GearTab, Grid, Head, HistoryTab, ItineraryTab, MoneyTab, PartyTab, ReportsTab, StayTab, Wrap, label, tone, useAct, useKey } from './trip-tabs';

const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };
const stamp = (iso, tz) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz });

/** Create a trip: the team or organisation it belongs to, where, when, and the events it is for. */
export function CreateTripSheet({ visible, onClose, eventId, onCreated }) {
  const teams = useLoad(() => (visible ? api.get('/teams', { mine: true, limit: 50 }) : Promise.resolve([])), [visible]);
  const events = useLoad(() => (visible && !eventId ? api.get('/events', { limit: 50 }) : Promise.resolve([])), [visible, eventId]);
  const key = useKey();
  return (
    <FormSheet visible={visible} onClose={onClose} title="Plan a trip" submitLabel="Create trip"
      notice="A trip points at your real events, teams and people; nothing is copied. You become the trip manager. Young travellers need their guardian's consent for this trip."
      fields={[
        { key: 'name', label: 'Trip name', type: 'text' }, { key: 'purpose', label: 'Purpose', type: 'text', optional: true },
        { key: 'team_id', label: 'Team travelling', type: 'entity', entityKind: 'team', noun: 'team', options: (teams.data ?? []).map((t) => ({ id: t.id, label: t.name, sub: t.sport, emoji: t.emoji })) },
        ...(eventId ? [] : [{ key: 'event_id', label: 'Event it is for', type: 'entity', entityKind: 'event', noun: 'event', optional: true, options: (events.data ?? []).map((e) => ({ id: e.id, label: e.name, sub: e.starts_on, emoji: e.banner_emoji })) }]),
        { key: 'origin', label: 'Travelling from', type: 'place' }, { key: 'destination', label: 'Travelling to', type: 'place' },
        { key: 'timezone', label: 'Time zone of the destination', type: 'timezone' },
        { key: 'depart_at', label: 'Leaves', type: 'datetime', step: 15 }, { key: 'return_at', label: 'Returns', type: 'datetime', step: 15 },
        { key: 'documents_required', label: 'International trip (passport / visa readiness counts)', type: 'switch', default: false },
        { key: 'allow_guests', label: 'Allow approved guests', type: 'switch', default: false },
      ]}
      initial={{ timezone: deviceZone() }}
      onSubmit={async (v) => {
        const trip = await api.post('/trips', { name: v.name, purpose: v.purpose || undefined, team_id: v.team_id, ...placeOut('origin_', v.origin), origin: v.origin.name, ...placeOut('destination_', v.destination), destination: v.destination.name, timezone: v.timezone, depart_at: v.depart_at, return_at: v.return_at, documents_required: !!v.documents_required, allow_guests: !!v.allow_guests, event_ids: eventId ? [eventId] : v.event_id ? [v.event_id] : [], idempotency_key: key.get() });
        key.renew(); onCreated?.(trip); return 'Trip created';
      }} />
  );
}

const TripCard = ({ t, onPress }) => (
  <Card onPress={onPress} pad={14} accessibilityLabel={`${t.name}, ${label(t.status)}, ${t.origin} to ${t.destination}`}>
    <Wrap><T weight="800" size={16} style={{ flex: 1 }}>{t.name}</T><Tag label={label(t.status)} color={tone(t.status)} /></Wrap>
    <T size={13.5} style={{ marginTop: 4 }}>{t.origin} → {t.destination}{t.destination_country ? ` (${t.destination_country})` : ''}</T>
    <T size={12.5} color={c.mute}>{stamp(t.depart_at, t.timezone)} → {stamp(t.return_at, t.timezone)} · {t.timezone.replace(/_/g, ' ')}</T>
    <T size={12.5} color={c.mute}>{[t.team_name, t.organisation_name].filter(Boolean).join(' · ')} · {t.confirmed}/{t.party_size} confirmed</T>
  </Card>
);

/** My trips: the ones I run, travel on, or guard a young traveller on. */
export function TripsHome() {
  const nav = useNav();
  const [scope, setScope] = useState('open'), [create, setCreate] = useState(false), [country, setCountry] = useState('');
  const st = useLoad(() => api.get('/trips', { status: scope === 'open' ? 'open' : 'completed', ...(country ? { country } : {}) }), [scope, country]);
  return (
    <Screen onRefresh={st.reload} refreshing={st.loading && !!st.data}>
      <H1>Trips</H1>
      <T color={c.mute} style={{ marginBottom: 10 }}>Itineraries, travel party, stays and logistics for your team or delegation. Each trip is tied to real events and real people.</T>
      <Wrap style={{ marginBottom: 12 }}><Btn title="＋ Plan a trip" onPress={() => setCreate(true)} /></Wrap>
      <Seg options={[{ value: 'open', label: 'Upcoming & active' }, { value: 'done', label: 'Completed' }]} value={scope} onChange={setScope} />
      <View style={{ height: 12 }} />
      <CountryPicker label="Filter by destination country" value={country} onChange={setCountry} optional />
      <View style={{ height: 12 }} />
      <Block state={st}>{(rows) => (!rows.length ? <Empty emoji="🧳" title={scope === 'open' ? 'No trips yet' : 'No completed trips'} sub={scope === 'open' ? 'Plan a trip for a team or delegation, link it to the event, then invite the travel party.' : undefined} /> : <Grid>{rows.map((t) => <TripCard key={t.id} t={t} onPress={() => nav.push('Trip', { id: t.id })} />)}</Grid>)}</Block>
      <CreateTripSheet visible={create} onClose={() => setCreate(false)} onCreated={(t) => { st.reload(); nav.push('Trip', { id: t.id }); }} />
    </Screen>
  );
}

// ---------------------------------------------------------------- the daily board

function Stat({ value, label: l, warn }) {
  return <View style={{ minWidth: 140, flexGrow: 1, borderWidth: 1, borderColor: warn ? c.sun : c.line, borderRadius: 14, padding: 12, backgroundColor: warn ? c.sunSoft : c.paper }}><T weight="800" size={24}>{value}</T><T size={11} weight="700" color={c.mute}>{l.toUpperCase()}</T></View>;
}
const Move = ({ m, strong }) => (
  <Card pad={14} color={strong ? c.violetSoft : c.paper}>
    <Wrap><T weight="800" style={{ flex: 1 }}>{label(m.mode)} · {m.origin} → {m.destination}</T><Tag label={label(m.status)} color={tone(m.status)} /></Wrap>
    <T size={13.5}>Departs <T weight="800" size={13.5}>{m.depart_local}</T> ({m.depart_tz.replace(/_/g, ' ')})</T>
    <T size={13.5}>Arrives <T weight="800" size={13.5}>{m.arrive_local}</T> ({m.arrive_tz.replace(/_/g, ' ')})</T>
    {m.meeting_point ? <T size={13}>📍 Meet at {m.meeting_point}</T> : null}
  </Card>
);

export function BoardTab({ id, data, reload, go }) {
  const st = useLoad(() => api.get(`/trips/${id}/board`), [id]);
  const [report, setReport] = useState(false);
  const { you } = data;
  const L = useLayout();
  const done = async () => { await st.reload(); await reload(); };
  const { act } = useAct(done);
  return (
    <View style={{ gap: 12 }}>
      <Block state={st}>{(b) => (
        <>
          <Head title={b.scope === 'manager' ? 'Today on the trip' : 'Your day'} sub={`It is ${b.trip.now_local} at the destination (${b.trip.timezone.replace(/_/g, ' ')}). Planned times only; nobody is tracked.`} />
          {b.next_movement ? <><T weight="800" size={13} color={c.mute}>NEXT MOVEMENT</T><Move m={b.next_movement} strong /></> : <Empty emoji="🧭" title="No movement coming up" sub={you.ops ? 'Add transport legs under Transport.' : 'Nothing is planned for you yet.'} />}
          {b.scope === 'manager' ? (
            <>
              <Wrap gap={10}>
                <Stat value={`${b.counts.ready}/${b.counts.party}`} label="Ready" /><Stat value={b.counts.unconfirmed} label="Unconfirmed" warn={b.counts.unconfirmed > 0} />
                <Stat value={b.counts.missing_documents} label="Document gaps" warn={b.counts.missing_documents > 0} /><Stat value={b.counts.missing_consent} label="Consent needed" warn={b.counts.missing_consent > 0} />
              </Wrap>
              <Grid>
                <Card pad={14}><T weight="800">Needs attention</T>{b.exceptions.length ? b.exceptions.slice(0, 8).map((x) => <View key={x.participant_id} style={{ marginTop: 8 }}><T weight="700" size={13.5}>{x.display_name}{x.young ? ' 🛡️' : ''}</T>{x.issues.map((i) => <T key={i.code} size={12.5} color={c.mute}>• {i.label}</T>)}</View>) : <T size={13} color={c.mute} style={{ marginTop: 6 }}>Everyone is ready. ✅</T>}</Card>
                <Card pad={14}><T weight="800">Arrivals, departures & check-ins today</T>
                  {[...b.departures.map((m) => `⬆️ Departs ${m.depart_local} · ${m.origin} → ${m.destination}`), ...b.arrivals.map((m) => `⬇️ Arrives ${m.arrive_local} · ${m.destination}`), ...b.check_ins.map((s) => `🏨 Check-in ${s.check_in_local} · ${s.property_name}`), ...b.check_outs.map((s) => `🚪 Check-out ${s.check_out_local} · ${s.property_name}`)].map((t, i) => <T key={i} size={13} style={{ marginTop: 6 }}>{t}</T>)}
                  {!b.departures.length && !b.arrivals.length && !b.check_ins.length && !b.check_outs.length ? <T size={13} color={c.mute} style={{ marginTop: 6 }}>Nothing scheduled today.</T> : null}</Card>
                <Card pad={14}><T weight="800">Changes in the last 3 days</T>{b.recent_changes.length ? b.recent_changes.slice(0, 6).map((x, i) => <T key={i} size={12.5} style={{ marginTop: 6 }}>{label(x.entity)} {label(x.action)}{x.note ? ` — ${x.note}` : ''}</T>) : <T size={13} color={c.mute} style={{ marginTop: 6 }}>No changes.</T>}</Card>
                <Card pad={14}><T weight="800">Equipment</T>{b.equipment.by_state.length ? <Wrap style={{ marginTop: 8 }} gap={6}>{b.equipment.by_state.map((g) => <Tag key={g.state} label={`${g.state.replace(/_/g, ' ')} ${g.n}`} color={['missing', 'damaged'].includes(g.state) ? c.red : c.violetSoft} />)}</Wrap> : <T size={13} color={c.mute} style={{ marginTop: 6 }}>No consignments.</T>}{b.equipment.problems.map((g) => <T key={g.id} size={12.5} color={c.red}>⚠️ {g.quantity} × {g.description} is {g.state}</T>)}</Card>
                <Card pad={14}><T weight="800">Open incidents ({b.open_incidents.length})</T>{b.open_incidents.map((i) => <View key={i.id} style={{ marginTop: 8 }}><T size={13}>{label(i.kind)}: {i.summary}</T><Btn small title="Resolve" color={c.paper} ink={c.ink} onPress={() => go('resolve', i)} style={{ alignSelf: 'flex-start', marginTop: 4 }} /></View>)}</Card>
                <Card pad={14}><T weight="800">Suppliers (approved channel)</T>{b.suppliers.length ? b.suppliers.map((s, i) => <T key={i} size={13} style={{ marginTop: 6 }}>{label(s.purpose)} · {s.supplier_name ?? 'Supplier'} · order {s.order_number} ({label(s.order_status)})</T>) : <T size={13} color={c.mute} style={{ marginTop: 6 }}>No supplier order linked. Source travel or hotels under Services & suppliers, then link the order here.</T>}</Card>
              </Grid>
              {b.today_movements.length ? <><T weight="800" size={13} color={c.mute}>TODAY'S MOVEMENTS</T><Grid>{b.today_movements.map((m) => <Move key={m.id} m={m} />)}</Grid></> : null}
            </>
          ) : (
            <Grid>
              {b.readiness.map((r) => <Card key={r.participant_id} pad={14} color={r.ready ? c.mintSoft : c.sunSoft}><T weight="800">{r.display_name}: {r.ready ? 'ready ✅' : 'not ready yet'}</T>{r.issues.map((i) => <T key={i.code} size={12.5}>• {i.label}</T>)}</Card>)}
              {b.today_movements.map((m) => <Move key={m.id} m={m} />)}
            </Grid>
          )}
          <Wrap><Btn small title="⚠️ Report a travel incident" color={c.paper} ink={c.ink} onPress={() => setReport(true)} /></Wrap>
        </>)}</Block>
      <FormSheet visible={report} onClose={() => setReport(false)} title="Report a travel incident" submitLabel="Report" notice="Keep it operational: no diagnosis, no document numbers, nothing about other people. Safeguarding reports go only to the trip manager."
        fields={[{ key: 'kind', label: 'What kind', type: 'chips', options: ['delay', 'medical', 'safeguarding', 'lost_item', 'security', 'other'].map((value) => ({ value, label: label(value) })), default: 'delay' }, { key: 'summary', label: 'What happened', type: 'text' }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/incidents`, v); await done(); return 'Reported'; }} />
    </View>
  );
}

// ---------------------------------------------------------------- one trip

const NEXT_STEPS = {
  planning: [['approval_pending', 'Send for approval']], approval_pending: [['confirmed', 'Approve & confirm'], ['planning', 'Send back']], confirmed: [['in_progress', 'Start the trip']], in_progress: [['completed', 'Complete the trip']],
};

export function Trip({ id }) {
  const nav = useNav();
  const st = useLoad(() => api.get(`/trips/${id}`), [id]);
  const [tab, setTab] = useState('board'), [cancel, setCancel] = useState(false), [edit, setEdit] = useState(false), [resolve, setResolve] = useState(null);
  const L = useLayout();
  const { act, busy } = useAct(st.reload);
  if (st.loading && !st.data) return <Screen><Loading /></Screen>;
  if (st.error) return <Screen><ErrorBox error={st.error} onRetry={st.reload} /></Screen>;
  const d = st.data, t = d.trip, you = d.you;
  const tabs = [['board', '🧭 Board'], ['party', '👥 Party'], ['transport', '✈️ Transport'], ['stay', '🏨 Stay'], ['docs', '🛂 Documents'], ['gear', '🧰 Equipment'], ['money', '💵 Money'], ['reports', '📄 Reports'], ['history', '🕘 History']];
  const props = { id, data: d, reload: st.reload };
  const steps = you.manager ? (NEXT_STEPS[t.status] ?? []).filter(([to]) => !(to === 'confirmed' && !you.can_approve)) : [];
  return (
    <Screen wide onRefresh={st.reload} refreshing={st.loading}>
      <Card pad={16} color={c.violetSoft}>
        <Wrap><T weight="800" size={22} style={{ flex: 1 }}>{t.name}</T><Tag label={label(t.status)} color={tone(t.status)} /></Wrap>
        <T size={14} style={{ marginTop: 4 }}>{placeText(placeIn('origin_', t, 'origin'))} → {placeText(placeIn('destination_', t, 'destination'))}{t.competition ? ` · ${t.competition}` : ''}</T>
        <MapLinks place={placeIn('destination_', t, 'destination')} />
        <T size={13} color={c.mute}>{stamp(t.depart_at, t.timezone)} → {stamp(t.return_at, t.timezone)} · {t.timezone.replace(/_/g, ' ')} · {t.days} {t.days === 1 ? 'day' : 'days'}</T>
        <T size={13} color={c.mute}>Managed by {t.manager_name}{t.team_name ? ` · ${t.team_name}` : ''}{t.organisation_name ? ` · ${t.organisation_name}` : ''}</T>
        {d.events.length ? <View style={{ marginTop: 8, gap: 2 }}>{d.events.map((e) => <T key={e.id} size={12.5}>🏆 {e.event_name}{e.fixture_id ? ` · ${e.home_name ?? 'TBC'} v ${e.away_name ?? 'TBC'}${e.scheduled_at ? ` · ${stamp(e.scheduled_at, t.timezone)}` : ''}` : ''}</T>)}</View> : null}
        {you.manager ? (
          <Wrap style={{ marginTop: 12 }}>
            {steps.map(([to, l]) => <Btn key={to} small title={l} loading={busy} onPress={() => act(() => api.post(`/trips/${id}/status`, { to }), `Trip is now ${label(to)}`)} />)}
            {!['completed', 'cancelled'].includes(t.status) ? <Btn small title="Edit trip" color={c.paper} ink={c.ink} onPress={() => setEdit(true)} /> : null}
            {!['completed', 'cancelled'].includes(t.status) ? <Btn small title="Cancel trip" color={c.paper} ink={c.red} onPress={() => setCancel(true)} /> : null}
          </Wrap>) : null}
        {t.status_reason ? <T size={12.5} color={c.mute} style={{ marginTop: 6 }}>Note: {t.status_reason}</T> : null}
      </Card>
      <View style={{ height: 12 }} />
      <HScroll gap={8}>{tabs.filter(([k]) => you.ops || !['gear'].includes(k) || d.party.length).map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</HScroll>
      <View style={{ height: 12 }} />
      {tab === 'board' && <BoardTab {...props} go={(w, x) => w === 'resolve' && setResolve(x)} />}
      {tab === 'party' && <PartyTab {...props} />}
      {tab === 'transport' && <ItineraryTab {...props} />}
      {tab === 'stay' && <StayTab {...props} />}
      {tab === 'docs' && <DocsTab {...props} />}
      {tab === 'gear' && <GearTab {...props} />}
      {tab === 'money' && <MoneyTab {...props} />}
      {tab === 'reports' && <ReportsTab {...props} />}
      {tab === 'history' && <HistoryTab {...props} />}
      {you.manager ? <Notes id={id} d={d} reload={st.reload} /> : d.notes.length ? <Notes id={id} d={d} reload={st.reload} /> : null}
      <FormSheet visible={cancel} onClose={() => setCancel(false)} title="Cancel this trip" submitLabel="Cancel the trip" color={c.red} notice="Everything is kept and read-only. The whole travel party is told."
        fields={[{ key: 'note', label: 'Why is it cancelled', type: 'text' }]} onSubmit={async (v) => { await api.post(`/trips/${id}/status`, { to: 'cancelled', note: v.note }); await st.reload(); return 'Trip cancelled'; }} />
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Edit trip" notice="Moving the dates tells the travel party. The previous values stay in the history."
        initial={{ name: t.name, purpose: t.purpose ?? '', origin: placeIn('origin_', t, 'origin'), destination: placeIn('destination_', t, 'destination'), depart_at: t.depart_at, return_at: t.return_at, documents_required: t.documents_required, allow_guests: t.allow_guests }}
        fields={[{ key: 'name', label: 'Trip name', type: 'text' }, { key: 'purpose', label: 'Purpose', type: 'text', optional: true }, { key: 'origin', label: 'From', type: 'place' }, { key: 'destination', label: 'To', type: 'place' }, { key: 'depart_at', label: 'Leaves', type: 'datetime', step: 15 }, { key: 'return_at', label: 'Returns', type: 'datetime', step: 15 },
          { key: 'documents_required', label: 'International trip', type: 'switch' }, { key: 'allow_guests', label: 'Allow approved guests', type: 'switch' }]}
        onSubmit={async (v) => { await api.patch(`/trips/${id}`, { row_version: t.row_version, name: v.name, purpose: v.purpose || null, ...placeOut('origin_', v.origin, true), origin: v.origin.name, ...placeOut('destination_', v.destination, true), destination: v.destination.name, depart_at: v.depart_at, return_at: v.return_at, documents_required: !!v.documents_required, allow_guests: !!v.allow_guests }); await st.reload(); return 'Trip updated'; }} />
      <FormSheet visible={!!resolve} onClose={() => setResolve(null)} title="Resolve incident" submitLabel="Resolve" fields={[{ key: 'resolution', label: 'What was done', type: 'text' }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/incidents/${resolve.id}/resolve`, v); await st.reload(); return 'Resolved'; }} />
    </Screen>
  );
}

/** Notes and checklists (staff-only or shared with the party). */
function Notes({ id, d, reload }) {
  const { you, trip } = d;
  const [add, setAdd] = useState(false);
  const { act } = useAct(reload);
  const open = !['completed', 'cancelled'].includes(trip.status);
  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Head title="Notes & checklist" sub="Staff-only notes stay with trip staff; shared ones are visible to the whole party." action={you.ops && open ? <Btn small title="＋ Add" onPress={() => setAdd(true)} /> : null} />
      {d.notes.map((n) => (
        <Card key={n.id} pad={12}><Wrap>
          {n.kind === 'checklist' ? <Chip label={n.done ? '☑' : '☐'} active={n.done} onPress={you.ops && open ? () => act(() => api.patch(`/trips/${id}/notes/${n.id}`, { done: !n.done })) : undefined} /> : null}
          <T style={{ flex: 1 }} size={14}>{n.body}</T><Tag label={n.visibility === 'party' ? 'shared' : 'staff only'} color={n.visibility === 'party' ? c.cyan : c.violetSoft} />
          {you.ops && open ? <Chip label="Archive" onPress={() => act(() => api.patch(`/trips/${id}/notes/${n.id}`, { archived: true }))} /> : null}</Wrap></Card>))}
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add a note" fields={[{ key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'note', label: 'Note' }, { value: 'checklist', label: 'Checklist item' }], default: 'checklist' }, { key: 'visibility', label: 'Who can see it', type: 'chips', options: [{ value: 'managers', label: 'Trip staff only' }, { value: 'party', label: 'Whole party' }], default: 'managers' }, { key: 'body', label: 'Text', type: 'text' }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/notes`, v); await reload(); return 'Added'; }} />
    </View>
  );
}

// ---------------------------------------------------------------- inside the event console (the single home for running an event)

/** The Travel tab of the event console: trips linked to this event, and a way to plan one. */
export function TravelTab({ id, e }) {
  const nav = useNav();
  const st = useLoad(() => api.get('/trips', { event_id: id }), [id]);
  const [create, setCreate] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      <ASection title="Travel" sub="Trips your teams and delegations are making to this event." action="＋ Plan a trip" onAction={() => setCreate(true)} />
      {st.loading ? <Loading /> : st.error ? <ErrorBox error={st.error} onRetry={st.reload} /> : !(st.data ?? []).length
        ? <AEmpty emoji="🧳" title="No trips for this event yet" sub="Teams and delegations travelling here can plan itineraries, stays and logistics. You only see the trips you run, travel on or guard a young traveller on." action="Plan a trip" onAction={() => setCreate(true)} />
        : st.data.map((t) => <ARow key={t.id} left={<AT size={22}>🧳</AT>} title={t.name} sub={`${t.origin} → ${t.destination} · ${t.confirmed}/${t.party_size} confirmed`} right={<ATag label={label(t.status)} tone={t.status === 'confirmed' ? A.green : t.status === 'cancelled' ? A.red : undefined} />} onPress={() => nav.push('Trip', { id: t.id })} />)}
      <CreateTripSheet visible={create} onClose={() => setCreate(false)} eventId={id} onCreated={(t) => { st.reload(); nav.push('Trip', { id: t.id }); }} />
    </View>
  );
}
