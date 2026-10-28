// Team & delegation travel (#485): the tabs inside one trip. The UI only calls the API (/trips/...); every rule (who sees what, youth consent, safeguarding,
// time zones, versions, idempotency) is enforced on the server. Phone: bottom sheets and one column. Tablet / desktop: centred sheets and wider cards.
import React, { useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Seg, Sheet, Tag, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { localDate, localHHMM, localToIso, moneyIn } from '../vtime';
import { useLayout } from '../layout';
import { MapLinks, placeIn, placeOut } from '../place-picker';
import { openPdf } from '../open-file';
import { useNav } from '../nav';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const MODE = { air: '✈️ Air', rail: '🚆 Rail', coach: '🚌 Coach', car: '🚗 Car / van', ferry: '⛴️ Ferry', local_transfer: '🚕 Local transfer', other: '🧭 Other' };
export const ROLE = { athlete: 'Athlete', coach: 'Coach', staff: 'Team staff', official: 'Official', medical: 'Medical / physio', manager: 'Manager', chaperone: 'Chaperone', guest: 'Guest', guardian: 'Guardian' };
const STATUS_TAG = { planning: c.violetSoft, approval_pending: c.sun, confirmed: c.mint, in_progress: c.cyan, completed: c.ink, cancelled: c.red, invited: c.sun, declined: c.red, delayed: c.sun, cancelled_leg: c.red, booked: c.mint, planned: c.violetSoft, completed_leg: c.ink };
export const tone = (s) => STATUS_TAG[s] ?? c.violetSoft;
export const label = (s) => String(s ?? '').replace(/_/g, ' ');

/** Run an API call with a busy flag and a toast; reload the tab afterwards. */
export function useAct(reload) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const act = async (fn, msg) => {
    setBusy(true);
    try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); await reload?.(); return r; } catch (e) { toast(e.message); return null; } finally { setBusy(false); }
  };
  return { act, busy };
}
/** One idempotency key per form opening, so a retry after a lost response never records twice. */
export const useKey = () => { const k = useRef(uid()); return { get: () => k.current, renew: () => { k.current = uid(); } }; };

export const Wrap = ({ children, gap = 8, style }) => <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap, alignItems: 'center' }, style]}>{children}</View>;
export const Head = ({ title, sub, action }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 }}>
    <View style={{ flex: 1 }}><T weight="800" size={17}>{title}</T>{sub ? <T size={12} color={c.mute}>{sub}</T> : null}</View>{action}
  </View>
);
const Notice = ({ children, tone: bg = c.sunSoft }) => <View accessibilityRole="alert" style={{ backgroundColor: bg, borderRadius: 12, padding: 12 }}><T size={12.5} weight="600">{children}</T></View>;
export const Block = ({ state, children }) => (state.loading ? <Loading /> : state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : children(state.data));
/** Two or three cards across on a tablet / desktop, one column on a phone. */
export function Grid({ children }) {
  const L = useLayout();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{React.Children.map(children, (ch) => (ch ? <View style={{ width: L.tablet ? '48.5%' : '100%', flexGrow: 1 }}>{ch}</View> : null))}</View>;
}
const zoneHint = 'Local time at that place';
const confirmOf = (r) => (r?.reference_info ? r.reference_info.label : null);

// ---------------------------------------------------------------- party

export function PartyTab({ id, data, reload }) {
  const { you, party, trip } = data;
  const { act, busy } = useAct(reload);
  const [invite, setInvite] = useState(false), [withdraw, setWithdraw] = useState(null), [consent, setConsent] = useState(null);
  const cands = useLoad(() => (you.manager ? api.get(`/trips/${id}/candidates`) : Promise.resolve([])), [id, party.length]);
  const open = !['completed', 'cancelled'].includes(trip.status);
  const mine = party.find((p) => p.id === you.participant_id);
  return (
    <View style={{ gap: 12 }}>
      <Head title="Travel party" sub={`${party.length} ${party.length === 1 ? 'person' : 'people'}. Chosen from the team, the organisation and linked fixtures; being on the team is not the same as being on the trip.`} action={you.manager && open ? <Btn small title="＋ Invite" onPress={() => setInvite(true)} /> : null} />
      {mine?.status === 'invited' && !mine.masked ? (
        <Card color={c.sunSoft}><T weight="800">You are invited to travel</T>
          <Wrap style={{ marginTop: 10 }}>
            <Btn small title="Confirm I'm going" loading={busy} onPress={() => act(() => api.post(`/trips/${id}/party/respond`, { response: 'confirm' }), 'You are on the trip')} />
            <Btn small title="Can't go" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/trips/${id}/party/respond`, { response: 'decline' }), 'Declined')} />
          </Wrap></Card>) : null}
      <Grid>
        {party.map((p) => (
          <Card key={p.id} pad={14} accessibilityLabel={`${p.display_name}, ${ROLE[p.role] ?? p.role}, ${label(p.status)}`}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T size={22}>{p.masked ? '🛡️' : p.avatar_emoji ?? '🙂'}</T></View>
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="800">{p.display_name}{p.young ? '  🛡️' : ''}</T>
                <Wrap gap={6}><Tag label={ROLE[p.role] ?? p.role} color={c.cyan} /><Tag label={label(p.status)} color={tone(p.status)} />{p.young ? <Tag label="young traveller" color={c.sun} /> : null}</Wrap>
              </View>
            </View>
            {(you.manager || you.guardian_of.includes(p.id)) && !p.masked ? (
              <Wrap style={{ marginTop: 10 }}>
                {you.guardian_of.includes(p.id) ? <Btn small title="Trip consent" onPress={() => setConsent(p)} /> : null}
                {open && (you.manager || p.id === you.participant_id || you.guardian_of.includes(p.id)) && p.user_id !== trip.manager_id ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => setWithdraw(p)} /> : null}
              </Wrap>) : null}
          </Card>))}
      </Grid>
      <InviteSheet visible={invite} onClose={() => setInvite(false)} id={id} cands={cands.data ?? []} party={party} trip={trip} reload={reload} />
      <FormSheet visible={!!withdraw} onClose={() => setWithdraw(null)} title={`Withdraw ${withdraw?.display_name ?? ''}`} submitLabel="Withdraw" color={c.red}
        notice="Their transport and room pass to a replacement if you name one. Their documents and consent never do. Everything stays in the history and only the people affected are told."
        fields={[{ key: 'reason', label: 'Reason', type: 'text' }, ...(you.manager ? [{ key: 'replacement_user_id', label: 'Replacement (optional)', type: 'entity', entityKind: 'person', options: (cands.data ?? []).map((x) => ({ id: x.user_id, label: x.display_name, sub: x.young ? 'young traveller: needs guardian consent' : ROLE[x.suggested_role], emoji: x.avatar_emoji })), optional: true }] : [])]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/party/${withdraw.id}/withdraw`, { reason: v.reason, ...(v.replacement_user_id ? { replacement_user_id: v.replacement_user_id } : {}) }); await reload(); return 'Updated'; }} />
      <FormSheet visible={!!consent} onClose={() => setConsent(null)} title={`Trip consent for ${consent?.display_name ?? ''}`} submitLabel="Save" color={c.mint}
        notice="This is consent for THIS trip only. General sport-participation consent does not cover travel. Trip staff only get your contact through the platform, and only if you allow it."
        fields={[{ key: 'decision', label: 'Decision', type: 'chips', options: consent?.status === 'confirmed' ? [{ value: 'revoke', label: 'Withdraw consent' }] : [{ value: 'grant', label: 'Give consent' }, { value: 'decline', label: 'Decline the trip' }] },
          { key: 'emergency_contact_ok', label: 'Staff may contact me in an emergency during the trip', type: 'switch', show: (v) => v.decision === 'grant' }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/party/${consent.id}/consent`, { decision: v.decision, emergency_contact_ok: !!v.emergency_contact_ok }); await reload(); return 'Saved'; }} />
    </View>
  );
}

function InviteSheet({ visible, onClose, id, cands, party, trip, reload }) {
  const [pick, setPick] = useState(null);
  const { act } = useAct(reload);
  const roles = (x) => (x.young ? ['athlete'] : ['athlete', 'coach', 'staff', 'medical', 'official', 'chaperone', 'manager']);
  return (
    <FormSheet visible={visible} onClose={onClose} title="Invite to the trip" submitLabel="Send invitation"
      notice="Only people already on the team, in the organisation or accepted as officials on a linked fixture can be invited. Young travellers can only travel as athletes and need a guardian's trip consent."
      fields={[
        { key: 'guest', label: 'Invite an approved guest instead (not on the roster)', type: 'switch', show: () => !!trip.allow_guests, hint: 'This trip allows guests. They are searched across the platform.' },
        { key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', noun: 'person', show: (v) => !v.guest, options: cands.map((x) => ({ id: x.user_id, label: x.display_name, sub: [ROLE[x.suggested_role], x.young ? '🛡️ young traveller' : null].filter(Boolean).join(' · '), emoji: x.avatar_emoji })), onPick: (it) => setPick(cands.find((x) => x.user_id === it?.id) ?? null) },
        { key: 'guest_user_id', label: 'Guest', type: 'entity', entityKind: 'person', noun: 'person', show: (v) => !!v.guest },
        { key: 'role', label: 'Role on the trip', type: 'chips', show: (v) => !v.guest, options: (pick ? roles(pick) : Object.keys(ROLE).filter((r) => !['guest', 'guardian'].includes(r))).map((r) => ({ value: r, label: ROLE[r] })), default: pick?.suggested_role ?? 'athlete' },
      ]}
      onSubmit={async (v) => { await api.post(`/trips/${id}/party`, v.guest ? { user_id: v.guest_user_id, role: 'guest' } : { user_id: v.user_id, role: v.role }); await reload(); setPick(null); return 'Invitation sent'; }} />
  );
}

// ---------------------------------------------------------------- supplier sourcing (procurement stays in Services & suppliers)

const ORDER_OK = ['confirmed', 'in_progress', 'completed'];
/** Accepted supplier orders of one category the person can buy for, as options for an order picker. */
export function useOrders(category) {
  const st = useLoad(() => api.get('/service-orders', { side: 'buyer', limit: 100 }).catch(() => []), []);
  return (st.data ?? []).filter((o) => ORDER_OK.includes(o.status) && o.category === category).map((o) => ({ id: o.id, label: `${o.number} · ${o.supplier_name}`, sub: `${o.title ?? label(o.category)} · ${label(o.status)}`, emoji: category === 'travel' ? '🚌' : '🏨' }));
}

/** The trip's linked RFQs and orders, how to link more, and a way into Services & suppliers where quotes and orders really live. */
export function SuppliersCard({ id, data, reload, purpose }) {
  const { you, trip } = data;
  const nav = useNav();
  const st = useLoad(() => (you.ops ? api.get(`/trips/${id}/suppliers`) : Promise.resolve([])), [id]);
  const orders = useLoad(() => (you.manager ? api.get('/service-orders', { side: 'buyer', limit: 100 }).catch(() => []) : Promise.resolve([])), [id]);
  const [link, setLink] = useState(false);
  const { act } = useAct(st.reload);
  if (!you.ops) return null;
  const open = !['completed', 'cancelled'].includes(trip.status);
  const mine = (st.data ?? []).filter((l) => !purpose || l.purpose === purpose);
  return (
    <Card pad={14} color={c.violetSoft}>
      <Wrap><T weight="800" style={{ flex: 1 }}>🤝 Suppliers & orders</T>
        <Btn small title="Source in Services" color={c.paper} ink={c.ink} onPress={() => nav.push('ServicesBuyer')} />
        {you.manager && open ? <Btn small title="Link an order" onPress={() => setLink(true)} /> : null}</Wrap>
      <T size={12} color={c.mute} style={{ marginTop: 4 }}>Quotes, orders and supplier contact stay in Services & suppliers; nothing is duplicated here. A confirmed order can then feed a leg or stay.</T>
      {mine.map((l) => (
        <View key={l.id} style={{ marginTop: 8 }}>
          <T size={13.5} weight="700">{label(l.purpose)} · {l.order_number ? `order ${l.order_number}` : `RFQ ${l.rfq_title}`}{l.supplier_name ? ` · ${l.supplier_name}` : ''}</T>
          <T size={12} color={c.mute}>{l.order_number ? `${label(l.order_status)}${l.travel_confirmation ? ` · ${label(l.travel_confirmation)}` : ''}` : label(l.rfq_status)}{l.gross_minor ? ` · ${moneyIn(l.gross_minor, l.currency)}` : ''}</T>
          {you.manager && open ? <Btn small title="Unlink" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/trips/${id}/suppliers/${l.id}/unlink`, {}), 'Unlinked')} style={{ alignSelf: 'flex-start', marginTop: 4 }} /> : null}
        </View>))}
      <FormSheet visible={link} onClose={() => setLink(false)} title="Link a supplier order" submitLabel="Link"
        notice="Pick an order your buyer account already holds. This only links it to the trip; the order itself is not copied or changed."
        fields={[{ key: 'purpose', label: 'What is it for', type: 'chips', options: ['travel', 'accommodation', 'local_transfer', 'equipment_freight', 'other'].map((value) => ({ value, label: label(value) })), default: purpose ?? 'travel' },
          { key: 'order_id', label: 'Order', type: 'entity', entityKind: 'person', noun: 'order', options: (orders.data ?? []).filter((o) => ORDER_OK.includes(o.status)).map((o) => ({ id: o.id, label: `${o.number} · ${o.supplier_name}`, sub: `${o.title ?? label(o.category)} · ${label(o.status)}`, emoji: '📦' })) }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/suppliers`, { purpose: v.purpose, order_id: v.order_id }); await st.reload(); return 'Linked'; }} />
    </Card>
  );
}

// ---------------------------------------------------------------- itinerary

const legFields = (party, edit, orders = []) => [
  { key: 'mode', label: 'How', type: 'chips', options: Object.entries(MODE).map(([value, l]) => ({ value, label: l })), default: 'coach' },
  { key: 'mode_label', label: 'Name the mode', type: 'text', show: (v) => v.mode === 'other' },
  { key: 'provider', label: 'Provider (airline, rail, coach company)', type: 'text', optional: true },
  { key: 'reference', label: 'Booking reference', type: 'text', optional: true, hint: 'Recorded as typed by the team. SportArena does not check it against the provider.' },
  { key: 'origin', label: 'From', type: 'place' }, { key: 'destination', label: 'To', type: 'place' },
  { key: 'd1', label: 'Departs', type: 'section' },
  { key: 'dep_date', label: 'Departure date', type: 'date' }, { key: 'dep_time', label: 'Departure time', type: 'time', step: 5 }, { key: 'depart_tz', label: 'Time zone of the departure place', type: 'timezone' },
  { key: 'a1', label: 'Arrives', type: 'section' },
  { key: 'arr_date', label: 'Arrival date', type: 'date' }, { key: 'arr_time', label: 'Arrival time', type: 'time', step: 5 }, { key: 'arrive_tz', label: 'Time zone of the arrival place', type: 'timezone' },
  ...(orders.length ? [{ key: 'svc_order_id', label: 'Supplier order that provides this leg', type: 'entity', entityKind: 'person', noun: 'order', optional: true, options: orders, hint: 'A confirmed order from Services & suppliers. The reference is then labelled as a supplier order.' }] : []),
  { key: 'meeting_point', label: 'Meeting point / terminal', type: 'text', optional: true }, { key: 'baggage_ref', label: 'Baggage / equipment allowance reference', type: 'text', optional: true },
  { key: 'passenger_ids', label: 'Who is on this leg', type: 'multi', options: party.filter((p) => !p.masked || true).map((p) => ({ value: p.id, label: p.display_name })), optional: true },
  ...(edit ? [{ key: 'status', label: 'Status', type: 'chips', options: ['planned', 'booked', 'delayed', 'cancelled', 'completed'].map((value) => ({ value, label: label(value) })) }, { key: 'change_note', label: 'What changed (travellers are told)', type: 'text' }] : []),
];
const legBody = (v, clear) => ({
  mode: v.mode, mode_label: v.mode === 'other' ? v.mode_label : undefined, provider: v.provider || undefined, reference: v.reference || undefined, ...placeOut('origin_', v.origin, clear), origin: v.origin.name, ...placeOut('destination_', v.destination, clear), destination: v.destination.name,
  depart_at: localToIso(v.dep_date, v.dep_time, v.depart_tz), depart_tz: v.depart_tz, arrive_at: localToIso(v.arr_date, v.arr_time, v.arrive_tz), arrive_tz: v.arrive_tz,
  meeting_point: v.meeting_point || undefined, baggage_ref: v.baggage_ref || undefined, passenger_ids: v.passenger_ids ?? [], svc_order_id: v.svc_order_id || undefined,
});
const legInitial = (s) => ({ mode: s.mode, mode_label: s.mode_label, provider: s.provider, reference: s.reference, origin: placeIn('origin_', s, 'origin'), destination: placeIn('destination_', s, 'destination'), dep_date: localDate(s.depart_at, s.depart_tz), dep_time: localHHMM(s.depart_at, s.depart_tz), depart_tz: s.depart_tz, arr_date: localDate(s.arrive_at, s.arrive_tz), arr_time: localHHMM(s.arrive_at, s.arrive_tz), arrive_tz: s.arrive_tz, meeting_point: s.meeting_point, baggage_ref: s.baggage_ref, status: s.status, passenger_ids: (s.travellers ?? []).map((t) => t.participant_id) });

export function ItineraryTab({ id, data, reload }) {
  const { you, party, trip } = data;
  const st = useLoad(() => api.get(`/trips/${id}/itinerary`), [id]);
  const travelOrders = useOrders('travel');
  const [add, setAdd] = useState(false), [edit, setEdit] = useState(null), [impact, setImpact] = useState(null);
  const done = async () => { await st.reload(); await reload(); };
  const open = !['completed', 'cancelled'].includes(trip.status);
  const tz0 = trip.timezone;
  return (
    <View style={{ gap: 12 }}>
      <Head title="Transport" sub={`Times are shown in the zone of each place. Trip zone: ${tz0.replace(/_/g, ' ')}.`} action={you.ops && open ? <Btn small title="＋ Add a leg" onPress={() => setAdd(true)} /> : null} />
      <SuppliersCard id={id} data={data} reload={reload} purpose="travel" />
      <Block state={st}>{(legs) => (!legs.length ? <Empty emoji="🧳" title="No transport yet" sub={you.ops ? 'Add each leg: flight, train, coach, ferry or local transfer.' : 'Nothing has been planned for you yet.'} /> : (
        <Grid>{legs.map((s) => (
          <Card key={s.id} pad={14} accessibilityLabel={`${MODE[s.mode]} from ${s.origin} to ${s.destination}, ${s.status}`}>
            <Wrap><T weight="800" style={{ flex: 1 }}>{MODE[s.mode]} · {s.origin} → {s.destination}</T><Tag label={label(s.status)} color={tone(s.status)} /></Wrap>
            <View style={{ marginTop: 8, gap: 4 }}>
              <T size={14}>Departs <T weight="800" size={14}>{s.depart_local}</T> <T size={12} color={c.mute}>({s.depart_tz.replace(/_/g, ' ')})</T></T>
              <T size={14}>Arrives <T weight="800" size={14}>{s.arrive_local}</T> <T size={12} color={c.mute}>({s.arrive_tz.replace(/_/g, ' ')})</T></T>
              {s.meeting_point ? <T size={13}>📍 Meet: {s.meeting_point}</T> : null}
              <MapLinks place={placeIn('destination_', s, 'destination')} />
              {s.baggage_ref ? <T size={13} color={c.mute}>🧳 {s.baggage_ref}</T> : null}
              {s.provider || s.reference ? <T size={13} color={c.mute}>{[s.provider, s.reference].filter(Boolean).join(' · ')}</T> : null}
              <T size={11.5} color={c.mute}>{confirmOf(s)}</T>
              {you.ops ? <T size={12} color={c.mute}>{s.travellers.length} on this leg{s.travellers.some((t) => t.young) ? ' · includes young travellers' : ''}</T> : null}
            </View>
            {you.ops && open ? <Wrap style={{ marginTop: 10 }}><Btn small title="Edit / report a change" color={c.paper} ink={c.ink} onPress={() => setEdit(s)} />{['delayed', 'cancelled'].includes(s.status) ? <Btn small title="See impact" onPress={() => setImpact(s)} /> : null}</Wrap> : null}
          </Card>))}</Grid>))}</Block>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add a transport leg" fields={legFields(party, false, travelOrders)} initial={{ dep_date: localDate(trip.depart_at, tz0), depart_tz: tz0, arrive_tz: tz0 }}
        onSubmit={async (v) => { await api.post(`/trips/${id}/segments`, legBody(v)); await done(); return 'Leg added'; }} />
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title="Change this leg" submitLabel="Save and tell the travellers" fields={legFields(party, true, travelOrders)} initial={edit ? legInitial(edit) : {}}
        notice="Only the travellers on this leg, their guardians and the trip manager are told. The old version stays in the history. A fixture is never edited from here."
        onSubmit={async (v) => { const { passenger_ids, ...body } = legBody(v, true); await api.patch(`/trips/${id}/segments/${edit.id}`, { ...body, passenger_ids, status: v.status, change_note: v.change_note, row_version: edit.row_version }); await done(); return 'Leg updated'; }} />
      <ImpactSheet id={id} seg={impact} onClose={() => setImpact(null)} />
    </View>
  );
}

function ImpactSheet({ id, seg, onClose }) {
  const st = useLoad(() => (seg ? api.get(`/trips/${id}/impact`, { segment_id: seg.id, buffer_hours: 12 }) : Promise.resolve(null)), [seg?.id]);
  const d = st.data;
  return (
    <Sheet visible={!!seg} onClose={onClose} title="Impact of this change">
      {st.loading || !d ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <Notice>{d.note}</Notice>
          <T weight="800">Travellers on this leg ({d.travellers.length})</T>
          <T size={13} color={c.mute}>{d.travellers.map((t) => t.display_name).join(', ') || 'Nobody assigned'}</T>
          <T weight="800">Fixtures that may be affected</T>
          {d.fixtures_at_risk.length ? d.fixtures_at_risk.map((f) => <T key={f.fixture_id} size={13}>⚽ {f.home_name ?? 'TBC'} v {f.away_name ?? 'TBC'} · {f.event_name} · {new Date(f.scheduled_at).toLocaleString()} ({f.slack_minutes} min after arrival)</T>) : <T size={13} color={c.mute}>None within 12 hours of the arrival.</T>}
          {d.stays_touched.length ? <><T weight="800">Check-ins close to this arrival</T>{d.stays_touched.map((x) => <T key={x.id} size={13}>🏨 {x.property_name} · {x.check_in_local}</T>)}</> : null}
          {d.equipment.length ? <><T weight="800">Equipment on this leg</T>{d.equipment.map((g) => <T key={g.id} size={13}>🧰 {g.quantity} × {g.description} ({label(g.state)})</T>)}</> : null}
        </View>)}
    </Sheet>
  );
}

// ---------------------------------------------------------------- stay and rooming

export function StayTab({ id, data, reload }) {
  const { you, party, trip } = data;
  const st = useLoad(() => api.get(`/trips/${id}/rooming`), [id]);
  const stayOrders = useOrders('accommodation');
  const [add, setAdd] = useState(false), [edit, setEdit] = useState(null), [rooms, setRooms] = useState(null), [assign, setAssign] = useState(null);
  const { act } = useAct(st.reload);
  const open = !['completed', 'cancelled'].includes(trip.status);
  const tz0 = trip.timezone;
  const stayFields = [
    { key: 'property_name', label: 'Property', type: 'text' }, { key: 'where', label: 'Location', type: 'place', optional: true, hint: 'Search the city or country, then pin the exact spot from Google Maps or Apple Maps.' }, { key: 'reference', label: 'Booking reference', type: 'text', optional: true, hint: 'Recorded as typed by the team; not a live availability check.' },
    ...(stayOrders.length ? [{ key: 'svc_order_id', label: 'Supplier order that provides this stay', type: 'entity', entityKind: 'person', noun: 'order', optional: true, options: stayOrders }] : []),
    { key: 'tz', label: 'Time zone of the property', type: 'timezone' },
    { key: 'in_date', label: 'Check-in date', type: 'date' }, { key: 'in_time', label: 'Check-in time', type: 'time', step: 15 },
    { key: 'out_date', label: 'Check-out date', type: 'date' }, { key: 'out_time', label: 'Check-out time', type: 'time', step: 15 },
    { key: 'status', label: 'Status', type: 'chips', options: ['planned', 'booked', 'changed', 'cancelled', 'completed'].map((value) => ({ value, label: label(value) })) },
    ...(edit ? [{ key: 'change_note', label: 'What changed (people with rooms are told)', type: 'text' }] : []),
  ];
  const stayBody = (v) => ({ property_name: v.property_name, address: v.where?.name || undefined, country: v.where?.country ?? (edit ? null : undefined), lat: v.where?.lat ?? (edit ? null : undefined), lng: v.where?.lng ?? (edit ? null : undefined), reference: v.reference || undefined, tz: v.tz, check_in_at: localToIso(v.in_date, v.in_time, v.tz), check_out_at: localToIso(v.out_date, v.out_time, v.tz), status: v.status, svc_order_id: v.svc_order_id || undefined });
  return (
    <View style={{ gap: 12 }}>
      <Head title="Stay & rooming" sub={you.ops ? 'Staff see the full rooming list. Room numbers and roommates of young travellers are never shown to other travellers.' : 'You see your own room. Others\' rooms stay private.'} action={you.ops && open ? <Btn small title="＋ Add a stay" onPress={() => setAdd(true)} /> : null} />
      <SuppliersCard id={id} data={data} reload={reload} purpose="accommodation" />
      <Block state={st}>{(stays) => (!stays.length ? <Empty emoji="🏨" title="No accommodation yet" sub={you.ops ? 'Add the hotel or lodging, then its rooms.' : 'Your stay has not been shared yet.'} /> : (
        <Grid>{stays.map((s) => (
          <Card key={s.id} pad={14}>
            <Wrap><T weight="800" style={{ flex: 1 }}>🏨 {s.property_name}</T><Tag label={label(s.status)} color={tone(s.status)} /></Wrap>
            <T size={13} style={{ marginTop: 4 }}>In <T weight="800" size={13}>{s.check_in_local}</T> · Out <T weight="800" size={13}>{s.check_out_local}</T> <T size={12} color={c.mute}>({s.tz.replace(/_/g, ' ')})</T></T>
            {s.address ? <T size={12.5} color={c.mute}>{s.address}</T> : null}
            <MapLinks place={{ name: s.address || s.property_name, lat: s.lat ?? undefined, lng: s.lng ?? undefined }} />
            <T size={11.5} color={c.mute}>{s.reference_info.label}</T>
            <View style={{ gap: 8, marginTop: 10 }}>
              {s.rooms.map((r) => (
                <View key={r.room_id} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 10, gap: 6 }}>
                  <T weight="700" size={13.5}>{r.label ? `Room ${r.label}` : 'Room'} · {label(r.room_type)} · sleeps {r.capacity}</T>
                  <Wrap gap={6}>
                    {r.occupants.map((o) => <Chip key={o.participant_id} label={`${o.display_name}${o.young ? ' 🛡️' : ''}${you.ops ? '  ✕' : ''}`} onPress={you.ops && open ? () => act(() => api.post(`/trips/${id}/rooms/${r.room_id}/assign`, { participant_id: o.participant_id, release: true }), 'Released') : undefined} />)}
                    {you.ops && open && r.occupants.length < r.capacity ? <Chip label="＋ Assign" onPress={() => setAssign(r)} /> : null}
                  </Wrap>
                </View>))}
              {you.ops && open ? <Wrap><Btn small title="＋ Add rooms" color={c.paper} ink={c.ink} onPress={() => setRooms(s)} /><Btn small title="Edit / report a change" color={c.paper} ink={c.ink} onPress={() => setEdit(s)} /></Wrap> : null}
            </View>
          </Card>))}</Grid>))}</Block>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add accommodation" fields={stayFields} initial={{ tz: tz0, in_date: localDate(trip.depart_at, tz0), out_date: localDate(trip.return_at, tz0), in_time: '14:00', out_time: '11:00', status: 'planned' }}
        onSubmit={async (v) => { await api.post(`/trips/${id}/stays`, stayBody(v)); await st.reload(); await reload(); return 'Stay added'; }} />
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title="Change this stay" submitLabel="Save and tell them" fields={stayFields}
        initial={edit ? { property_name: edit.property_name, where: edit.address ? { name: edit.address, country: edit.country ?? undefined, lat: edit.lat ?? undefined, lng: edit.lng ?? undefined } : undefined, reference: edit.reference, tz: edit.tz, in_date: localDate(edit.check_in_at, edit.tz), in_time: localHHMM(edit.check_in_at, edit.tz), out_date: localDate(edit.check_out_at, edit.tz), out_time: localHHMM(edit.check_out_at, edit.tz), status: edit.status } : {}}
        onSubmit={async (v) => { await api.patch(`/trips/${id}/stays/${edit.id}`, { ...stayBody(v), change_note: v.change_note, row_version: edit.row_version }); await st.reload(); return 'Stay updated'; }} />
      <FormSheet visible={!!rooms} onClose={() => setRooms(null)} title="Add rooms" submitLabel="Add"
        fields={[{ key: 'room_type', label: 'Room type', type: 'chips', options: ['single', 'double', 'twin', 'triple', 'quad', 'family', 'dorm', 'other'].map((value) => ({ value, label: label(value) })), default: 'twin' },
          { key: 'capacity', label: 'Sleeps', type: 'stepper', min: 1, max: 20, default: 2 }, { key: 'count', label: 'How many rooms like this', type: 'stepper', min: 1, max: 100, default: 1 },
          { key: 'label', label: 'Room number (only when adding one room)', type: 'text', optional: true, show: (v) => (v.count ?? 1) === 1 }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/stays/${rooms.id}/rooms`, { room_type: v.room_type, capacity: v.capacity, count: v.count, label: v.label || undefined }); await st.reload(); return 'Rooms added'; }} />
      <FormSheet visible={!!assign} onClose={() => setAssign(null)} title="Put someone in this room" submitLabel="Assign"
        notice="A young traveller can only share with other young travellers or their own verified guardian."
        fields={[{ key: 'participant_id', label: 'Traveller', type: 'entity', entityKind: 'person', noun: 'traveller', options: party.filter((p) => !p.masked).map((p) => ({ id: p.id, label: p.display_name, sub: `${ROLE[p.role]}${p.young ? ' · 🛡️ young' : ''}`, emoji: p.avatar_emoji })) }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/rooms/${assign.room_id}/assign`, { participant_id: v.participant_id }); await st.reload(); return 'Assigned'; }} />
    </View>
  );
}

// ---------------------------------------------------------------- documents (status only)

const DOC_STATUS = { passport: ['held', 'not_held', 'unknown'], visa: ['not_required', 'required', 'submitted', 'approved', 'unknown'] };
export function DocsTab({ id, data, reload }) {
  const { you, trip } = data;
  const st = useLoad(() => api.get(`/trips/${id}/compliance`), [id]);
  const [edit, setEdit] = useState(null), [shown, setShown] = useState(null);
  const { toast } = useSession();
  const mineIds = [you.participant_id, ...you.guardian_of].filter(Boolean);
  const reveal = async (r, kind) => { try { setShown({ name: r.display_name, kind, ...(await api.get(`/trips/${id}/party/${r.participant_id}/documents/${kind}/reveal`)) }); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 12 }}>
      <Head title="Documents & consent" sub={trip.documents_required ? `International trip: a passport valid ${trip.passport_min_months} months after return counts toward readiness.` : 'Readiness status only. Passport and visa numbers are encrypted and never shown to trip staff.'} />
      <Notice tone={c.cyanSoft}>This records readiness. It is not immigration advice and does not decide anyone's eligibility to travel.</Notice>
      <Block state={st}>{(rows) => (!rows.length ? <Empty emoji="🛂" title="Nobody to show yet" /> : (
        <Grid>{rows.map((r) => (
          <Card key={r.participant_id} pad={14}>
            <Wrap><T weight="800" style={{ flex: 1 }}>{r.display_name}{r.young ? ' 🛡️' : ''}</T><Tag label={ROLE[r.role] ?? r.role} color={c.cyan} /></Wrap>
            {['passport', 'visa'].map((k) => (
              <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <T size={13.5} weight="700" style={{ width: 70 }}>{k === 'passport' ? '🛂 Passport' : '📄 Visa'}</T>
                <Tag label={r[k] ? label(r[k].status) : 'not recorded'} color={r[k] && ['held', 'approved', 'not_required'].includes(r[k].status) ? c.mint : c.sun} />
                {r[k]?.expires_on ? <T size={12} color={c.mute}>expires {r[k].expires_on}</T> : null}
                {(you.ops || mineIds.includes(r.participant_id)) && !['completed', 'cancelled'].includes(trip.status) ? <Btn small title="Update" color={c.paper} ink={c.ink} onPress={() => setEdit({ r, kind: k })} /> : null}
                {mineIds.includes(r.participant_id) && r[k]?.has_number ? <Btn small title="Show my number" color={c.paper} ink={c.ink} onPress={() => reveal(r, k)} /> : null}
              </View>))}
            {r.consent !== null ? (
              <View style={{ marginTop: 10, flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <T size={13.5} weight="700">🛡️ Guardian trip consent</T><Tag label={r.consent.current ? 'given' : 'missing'} color={r.consent.current ? c.mint : c.sun} />
              </View>) : null}
          </Card>))}</Grid>))}</Block>
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.kind === 'passport' ? 'Passport' : 'Visa'}: ${edit.r.display_name}` : ''}
        notice={mineIds.includes(edit?.r.participant_id) ? 'The number and reference are encrypted and visible only to you (or a young traveller\'s verified guardian). Trip staff see the status and expiry only.' : 'You can set status and expiry. Only the holder or their guardian can store the number.'}
        fields={[{ key: 'status', label: 'Status', type: 'chips', options: (edit ? DOC_STATUS[edit.kind] : []).map((value) => ({ value, label: label(value) })) }, { key: 'expires_on', label: 'Expiry date', type: 'date', optional: true },
          ...(mineIds.includes(edit?.r.participant_id) ? [{ key: 'number', label: 'Document number (encrypted)', type: 'secret', optional: true }, { key: 'evidence_ref', label: 'Where the scan is kept (encrypted note)', type: 'text', optional: true }] : [])]}
        initial={edit ? { status: edit.r[edit.kind]?.status, expires_on: edit.r[edit.kind]?.expires_on ?? undefined } : {}}
        onSubmit={async (v) => { await api.post(`/trips/${id}/party/${edit.r.participant_id}/documents/${edit.kind}`, { status: v.status, expires_on: v.expires_on || null, ...(v.number ? { number: v.number } : {}), ...(v.evidence_ref ? { evidence_ref: v.evidence_ref } : {}) }); await st.reload(); await reload(); return 'Saved'; }} />
      <FormSheet visible={!!shown} onClose={() => setShown(null)} title="Your stored details" submitLabel="Done" fields={[]} onSubmit={async () => {}}
        notice={shown ? `${shown.kind === 'passport' ? 'Passport' : 'Visa'} number: ${shown.number ?? 'not stored'}${shown.evidence_ref ? ` · Note: ${shown.evidence_ref}` : ''}. This view was recorded in the audit log.` : ''} />
    </View>
  );
}

// ---------------------------------------------------------------- equipment

const GEAR_FLOW = ['planned', 'packed', 'loaded', 'in_transit', 'unloaded', 'received', 'missing', 'damaged'];
export function GearTab({ id, data, reload }) {
  const { you, party, trip } = data;
  const st = useLoad(() => api.get(`/trips/${id}/gear`), [id]);
  const [add, setAdd] = useState(false), [move, setMove] = useState(null);
  const open = !['completed', 'cancelled'].includes(trip.status);
  return (
    <View style={{ gap: 12 }}>
      <Head title="Equipment & baggage" sub="Consignments for the trip, tracked from packing to receipt. This does not replace your stock records." action={you.ops && open ? <Btn small title="＋ Add" onPress={() => setAdd(true)} /> : null} />
      <Block state={st}>{(rows) => (!rows.length ? <Empty emoji="🧰" title="No equipment recorded" sub={you.ops ? 'Add kit, medical and technical gear, or anything that travels with the team.' : 'Nothing is assigned to you.'} /> : (
        <Grid>{rows.map((g) => (
          <Card key={g.id} pad={14}>
            <Wrap><T weight="800" style={{ flex: 1 }}>{g.quantity} × {g.description}</T><Tag label={label(g.state)} color={['missing', 'damaged'].includes(g.state) ? c.red : g.state === 'received' ? c.mint : c.violetSoft} /></Wrap>
            <T size={12.5} color={c.mute}>{label(g.category)}{g.responsible_name ? ` · ${g.responsible_name}` : ''}{g.logistics_ref ? ` · ${g.logistics_ref}` : ''}</T>
            {g.last_checkpoint?.checkpoint ? <T size={12.5}>Last checkpoint: {g.last_checkpoint.checkpoint}{g.last_checkpoint.note ? ` — ${g.last_checkpoint.note}` : ''}</T> : null}
            {open ? <Btn small title="Update status" color={c.paper} ink={c.ink} onPress={() => setMove(g)} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
          </Card>))}</Grid>))}</Block>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add equipment" fields={[
        { key: 'category', label: 'Category', type: 'chips', options: ['kit', 'equipment', 'medical', 'technical', 'food', 'personal', 'other'].map((value) => ({ value, label: label(value) })), default: 'kit' },
        { key: 'description', label: 'What is it', type: 'text' }, { key: 'quantity', label: 'Quantity', type: 'stepper', min: 1, max: 1000, default: 1 },
        { key: 'responsible_id', label: 'Responsible person', type: 'entity', entityKind: 'person', noun: 'traveller', optional: true, options: party.filter((p) => !p.masked && p.status === 'confirmed').map((p) => ({ id: p.user_id, label: p.display_name, sub: ROLE[p.role], emoji: p.avatar_emoji })) },
        { key: 'logistics_ref', label: 'Courier / logistics reference', type: 'text', optional: true }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/gear`, { ...v, responsible_id: v.responsible_id || undefined, logistics_ref: v.logistics_ref || undefined }); await st.reload(); return 'Added'; }} />
      <FormSheet visible={!!move} onClose={() => setMove(null)} title="Update status" fields={[
        { key: 'state', label: 'Status', type: 'chips', options: GEAR_FLOW.map((value) => ({ value, label: label(value) })) }, { key: 'checkpoint', label: 'Checkpoint (where)', type: 'text', optional: true }, { key: 'note', label: 'Note', type: 'text', optional: true }]}
        initial={move ? { state: move.state } : {}}
        onSubmit={async (v) => { await api.patch(`/trips/${id}/gear/${move.id}`, { row_version: move.row_version, state: v.state, checkpoint: v.checkpoint || undefined, note: v.note || undefined }); await st.reload(); return 'Updated'; }} />
    </View>
  );
}

// ---------------------------------------------------------------- money

export function MoneyTab({ id, data, reload }) {
  const { you, trip } = data;
  const st = useLoad(() => api.get(`/trips/${id}/finance`), [id]);
  const { act } = useAct(st.reload);
  const [pol, setPol] = useState(false), [pay, setPay] = useState(null), [claim, setClaim] = useState(null);
  const key = useKey();
  const open = !['completed', 'cancelled'].includes(trip.status);
  return (
    <View style={{ gap: 12 }}>
      <Block state={st}>{(f) => (
        <>
          <Head title="Per diem & expenses" sub="Entitlement, claims and payments are kept apart: being entitled is not being owed, and a claim is not a payment." action={you.manager && open ? <Btn small title={f.policy ? 'Change policy' : 'Set per diem'} onPress={() => setPol(true)} /> : null} />
          {f.policy ? (
            <Card color={f.policy.approved ? c.mintSoft : c.sunSoft}><T weight="800">{moneyIn(f.policy.daily_minor, f.policy.currency)} a day{f.policy.roles.length ? ` · ${f.policy.roles.map((r) => ROLE[r]).join(', ')}` : ' · every confirmed traveller'}</T>
              <T size={12.5}>{f.policy.approved ? 'Approved: payable.' : 'Proposed, not payable until the team owner or organisation admin approves.'}</T>
              {!f.policy.approved && data.you.can_approve ? <Btn small title="Approve policy" onPress={() => act(() => api.post(`/trips/${id}/perdiem/approve`, {}), 'Approved')} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}</Card>) : <Empty emoji="💵" title="No per diem policy" sub={you.manager ? 'Set a daily allowance if your trip pays one.' : 'This trip has no per diem.'} />}
          <Grid>{f.travellers.map((t) => {
            const cur = t.entitlement?.currency ?? f.policy?.currency ?? 'INR';
            const line = (name, minor, sub) => <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T size={13.5} weight="600">{name}</T>{sub ? <T size={11.5} color={c.mute}>{sub}</T> : null}</View><T size={13.5} weight="800">{minor === null ? '—' : moneyIn(minor, cur)}</T></View>;
            return (
              <Card key={t.participant_id} pad={14} accessibilityLabel={`${t.display_name} money`}>
                <T weight="800">{t.display_name}</T>
                <View style={{ gap: 6, marginTop: 8 }}>
                  {line('Entitlement', t.entitlement ? t.entitlement.amount_minor : null, t.entitlement ? `${t.entitlement.days} days${t.entitlement.approved ? '' : ' (not approved)'}` : 'no per diem')}
                  {line('Per diem paid', t.per_diem_paid_minor)}{line('Advances paid', t.advances_minor)}
                  {line('Claims approved', t.claims.approved_minor, `${moneyIn(t.claims.submitted_minor, cur)} waiting · ${moneyIn(t.claims.rejected_minor, cur)} rejected`)}{line('Reimbursed', t.claims.reimbursed_minor)}
                  <View style={{ height: 1, backgroundColor: c.line }} />{line('Still owed / (overpaid)', t.net_due_minor, 'entitlement + approved claims − paid − reimbursed − advances')}
                </View>
                {t.claims.items.map((x) => (
                  <View key={x.id} style={{ marginTop: 8, borderTopWidth: 1, borderColor: c.line, paddingTop: 8, gap: 4 }}>
                    <T size={13} weight="700">{label(x.category)} · {moneyIn(x.amount_minor, x.currency)} <T size={12} color={c.mute}>({x.incurred_on})</T></T>
                    <Wrap gap={6}><Tag label={x.status} color={x.status === 'approved' ? c.mint : x.status === 'rejected' ? c.red : c.sun} />{x.reimbursed ? <Tag label="reimbursed" color={c.cyan} /> : null}</Wrap>
                    {you.manager && open && x.status === 'submitted' ? <Wrap><Btn small title="Approve" onPress={() => act(() => api.post(`/trips/${id}/claims/${x.id}/decide`, { decision: 'approve' }), 'Approved')} /><Btn small title="Reject" color={c.paper} ink={c.ink} onPress={() => setClaim({ reject: x })} /></Wrap> : null}
                    {you.manager && open && x.status === 'approved' && !x.reimbursed ? <Btn small title="Record reimbursement" onPress={() => act(() => api.post(`/trips/${id}/claims/${x.id}/reimburse`, {}), 'Recorded')} style={{ alignSelf: 'flex-start' }} /> : null}
                  </View>))}
                <Wrap style={{ marginTop: 10 }}>
                  {open && (t.participant_id === you.participant_id || you.guardian_of.includes(t.participant_id)) ? <Btn small title="Claim an expense" onPress={() => { key.renew(); setClaim({ who: t }); }} /> : null}
                  {you.manager && open ? <Btn small title="Record a payment" color={c.paper} ink={c.ink} onPress={() => { key.renew(); setPay({ t, cur }); }} /> : null}
                </Wrap>
              </Card>);
          })}</Grid>
        </>)}</Block>
      <FormSheet visible={pol} onClose={() => setPol(false)} title="Per diem policy" submitLabel="Propose" notice="A proposal pays nobody. The team owner or organisation admin approves it before anything is payable."
        fields={[{ key: 'currency', label: 'Currency', type: 'currency' }, { key: 'daily_minor', label: 'Per day', type: 'money', currency: (v) => v.currency }, { key: 'roles', label: 'Who gets it (none chosen = every confirmed traveller)', type: 'multi', options: Object.entries(ROLE).map(([value, l]) => ({ value, label: l })), optional: true }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/perdiem`, { currency: v.currency, daily_minor: v.daily_minor, roles: v.roles ?? [] }); await st.reload(); return 'Proposed'; }} />
      <FormSheet visible={!!pay} onClose={() => setPay(null)} title={`Record a payment: ${pay?.t.display_name ?? ''}`} submitLabel="Record" notice="This records money that was actually paid. It is not an entitlement and not a claim."
        fields={[{ key: 'kind', label: 'Kind', type: 'chips', options: [{ value: 'per_diem', label: 'Per diem' }, { value: 'advance', label: 'Advance' }], default: 'per_diem' }, { key: 'amount_minor', label: 'Amount', type: 'money', currency: () => pay?.cur ?? 'INR' }, { key: 'reference', label: 'Payment reference', type: 'text', optional: true }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/payments`, { participant_id: pay.t.participant_id, kind: v.kind, amount_minor: v.amount_minor, currency: pay.cur, reference: v.reference || undefined, idempotency_key: key.get() }); await st.reload(); return 'Recorded'; }} />
      <FormSheet visible={!!claim?.who} onClose={() => setClaim(null)} title="Claim an expense" submitLabel="Submit claim" notice="A claim is a request. It is approved, then paid, as separate steps."
        fields={[{ key: 'category', label: 'What for', type: 'chips', options: ['meals', 'transport', 'lodging', 'visa_fees', 'baggage', 'other'].map((value) => ({ value, label: label(value) })), default: 'meals' }, { key: 'description', label: 'Description', type: 'text' },
          { key: 'currency', label: 'Currency', type: 'currency' }, { key: 'amount_minor', label: 'Amount', type: 'money', currency: (v) => v.currency }, { key: 'incurred_on', label: 'Date spent', type: 'date' }, { key: 'receipt_ref', label: 'Receipt reference (encrypted)', type: 'text', optional: true }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/claims`, { participant_id: claim.who.participant_id, category: v.category, description: v.description, amount_minor: v.amount_minor, currency: v.currency, incurred_on: v.incurred_on, receipt_ref: v.receipt_ref || undefined, idempotency_key: key.get() }); await st.reload(); return 'Claim submitted'; }} />
      <FormSheet visible={!!claim?.reject} onClose={() => setClaim(null)} title="Reject this claim" submitLabel="Reject" color={c.red} fields={[{ key: 'note', label: 'Why', type: 'text' }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/claims/${claim.reject.id}/decide`, { decision: 'reject', note: v.note }); await st.reload(); return 'Rejected'; }} />
    </View>
  );
}

// ---------------------------------------------------------------- reports

const REPORTS = [['manifest', 'Travel manifest'], ['itinerary', 'Itinerary'], ['movement', 'Movement plan'], ['rooming', 'Rooming list'], ['equipment', 'Equipment manifest'], ['readiness', 'Readiness exceptions'], ['cost', 'Cost summary']];
export function ReportsTab({ id, data }) {
  const { you } = data;
  const [kind, setKind] = useState('manifest'), [audience, setAudience] = useState(you.ops ? 'manager' : 'traveller');
  const [rep, setRep] = useState(null), [busy, setBusy] = useState(false), [kit, setKit] = useState(null);
  const kits = useLoad(() => api.get('/brand-kits').catch(() => []), []);
  const { toast } = useSession();
  const run = async (k, a) => { setBusy(true); try { setRep(await api.get(`/trips/${id}/reports/${k}`, { audience: a })); } catch (e) { setRep(null); toast(e.message); } finally { setBusy(false); } };
  const save = async () => {
    if (!rep) return;
    if (Platform.OS === 'web' && typeof document !== 'undefined') { const url = URL.createObjectURL(new Blob([rep.csv], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = rep.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); return; }
    try { await Share.share({ message: rep.csv, title: rep.title }); } catch (e) { toast(e.message); }
  };
  const pdf = async () => { setBusy(true); try { const d = await api.post(`/trips/${id}/reports/${kind}/document`, { audience, ...(kit ? { kit_id: kit } : {}) }); await openPdf(d.url.replace('/api/v1', ''), `${kind}-${audience}`); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  const kinds = REPORTS.filter(([k]) => you.ops || !['rooming', 'cost'].includes(k));
  return (
    <View style={{ gap: 12 }}>
      <Head title="Reports" sub="Audience-safe exports. Each one is logged and expires after 24 hours." />
      <Wrap>{kinds.map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => { setKind(k); setRep(null); }} />)}</Wrap>
      {you.ops ? <Seg options={[{ value: 'manager', label: 'Trip staff' }, { value: 'supplier', label: 'Supplier' }, { value: 'traveller', label: 'My rows' }]} value={audience} onChange={(a) => { setAudience(a); setRep(null); }} /> : null}
      {audience === 'supplier' ? <Notice tone={c.cyanSoft}>Supplier version: adult travellers by name; young travellers counted only. No rooms, documents or money.</Notice> : null}
      <Btn title={busy ? 'Preparing…' : 'Prepare report'} loading={busy} onPress={() => run(kind, audience)} />
      {rep ? (
        <Card pad={14}>
          <T weight="800">{rep.title}</T><T size={11.5} color={c.mute}>{rep.timezone_note} Expires {new Date(rep.expires_at).toLocaleString()}.</T>
          <View style={{ marginTop: 8, gap: 6 }}>
            <T size={11.5} weight="800" color={c.mute}>{rep.columns.join('  ·  ')}</T>
            {rep.rows.length ? rep.rows.map((r, i) => <T key={i} size={13}>{r.filter((x) => x !== '' && x !== null).join('  ·  ')}</T>) : <T size={13} color={c.mute}>Nothing to list.</T>}
          </View>
          <Wrap style={{ marginTop: 10 }}><Btn small title={Platform.OS === 'web' ? 'Download CSV' : 'Share / save CSV'} onPress={save} color={c.paper} ink={c.ink} /><Btn small title="Branded PDF" onPress={pdf} loading={busy} /></Wrap>
          {(kits.data ?? []).length ? <View style={{ marginTop: 8 }}><T size={12} color={c.mute}>Brand kit for the PDF</T><Wrap style={{ marginTop: 4 }}><Chip label="Plain" active={!kit} onPress={() => setKit(null)} />{kits.data.map((k) => <Chip key={k.id} label={k.display_name} active={kit === k.id} onPress={() => setKit(k.id)} />)}</Wrap></View> : null}
        </Card>) : null}
    </View>
  );
}

// ---------------------------------------------------------------- history

export function HistoryTab({ id }) {
  const st = useLoad(() => api.get(`/trips/${id}/changes`, { limit: 50 }), [id]);
  return (
    <View style={{ gap: 12 }}>
      <Head title="Change history" sub="Every change is kept. You see the ones that affected you; trip staff see all of them." />
      <Block state={st}>{(rows) => (!rows.length ? <Empty emoji="🕘" title="Nothing has changed yet" /> : (
        <View style={{ gap: 8 }}>{rows.map((r) => (
          <Card key={r.id} pad={12}><Wrap><T weight="700" size={13.5} style={{ flex: 1 }}>{label(r.entity)} · {label(r.action)}{r.version ? ` (v${r.version})` : ''}</T><T size={11.5} color={c.mute}>{new Date(r.created_at).toLocaleString()}</T></Wrap>
            {r.note ? <T size={12.5}>{r.note}</T> : null}<T size={11.5} color={c.mute}>{r.actor_name ? `by ${r.actor_name}` : ''}{r.people_told ? ` · ${r.people_told} told` : ''}</T></Card>))}</View>))}</Block>
    </View>
  );
}
