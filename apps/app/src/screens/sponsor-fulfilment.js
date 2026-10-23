import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { Btn, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';

// Returns / replacements of sponsored goods and vouchers for funded services (#300). Lives inside the Commitments card of the deal screen:
// there is one place to run an agreement. Dispatched is never received; a value shown here is a quantity, never cash.
const REASONS = [{ value: 'damaged', label: 'Damaged' }, { value: 'wrong_item', label: 'Wrong item' }, { value: 'not_as_described', label: 'Not as described' }, { value: 'other', label: 'Other' }];
const SERVICES = { coaching: 'Coaching', venue: 'Venue', travel: 'Travel', medical: 'Medical' };
const tone = { requested: c.sunSoft, accepted: c.limeSoft, disputed: c.redSoft, cancelled: c.paper, issued: c.sunSoft, redeemed: c.limeSoft, void: c.paper, expired: c.redSoft };
const day = (iso) => (iso ? new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const code = (v) => `··${String(v.id).slice(-4).toUpperCase()}`;
/** Units of a goods due the sponsor may still dispatch: what the recipient has accepted, what is on its way and what was closed by credit all count. */
export const remainingGoods = (o) => Math.max(0, o.quantity - (o.received_quantity - o.returned_quantity + o.in_transit_quantity + o.credited_quantity));
const returnable = (o, dl) => dl.status === 'received' ? dl.received_quantity - o.returns.filter((r) => r.delivery_id === dl.id && ['requested', 'accepted'].includes(r.status)).reduce((s, r) => s + r.quantity, 0) : 0;
const Row = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>{children}</View>;

/** Returns on a goods due. `onReplace(return)` opens the dispatch sheet pre-filled as the replacement. */
export function GoodsReturns({ o, sponsor, recipient, can, act, reload, onReplace }) {
  const [form, setForm] = useState(null);
  const key = useRef(null);
  const eligible = recipient ? o.deliveries.filter((dl) => returnable(o, dl) > 0) : [];
  const replaced = new Set(o.deliveries.filter((dl) => dl.replaces_return_id && dl.status !== 'rejected').map((dl) => dl.replaces_return_id));
  const r = form?.r;
  return (
    <View>
      {o.returns.map((x) => (
        <View key={x.id} style={{ marginTop: 6, borderLeftWidth: 3, borderLeftColor: c.line, paddingLeft: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T size={12} weight="800" style={{ flex: 1 }}>Return of {x.quantity} · {x.reason.replace(/_/g, ' ')}{x.status === 'accepted' ? (x.resolution === 'credit' ? ' · closed by credit' : replaced.has(x.id) ? ' · replacement sent' : ' · replacement due') : ''}</T>
            <Tag label={x.status} color={tone[x.status]} />
          </View>
          {x.note ? <T size={12} color={c.mute}>{x.note}</T> : null}
          {x.decision_note ? <T size={12} color={c.mute}>Answer: {x.decision_note}</T> : null}
          {x.evidence_url ? <T size={12} color={c.mute} accessibilityRole="link">Evidence: {x.evidence_url}</T> : null}
          {sponsor && can('pay') && x.status === 'requested' ? <Row><Btn small title="Accept return" color={c.mint} ink={c.ink} onPress={() => setForm({ kind: 'accept', r: x })} /><Btn small title="Dispute" color={c.paper} ink={c.red} onPress={() => setForm({ kind: 'dispute', r: x })} /></Row> : null}
          {sponsor && can('pay') && x.status === 'accepted' && x.resolution === 'replace' && !replaced.has(x.id) && o.status === 'scheduled' ? <Btn small title="Dispatch replacement" color={c.orange} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => onReplace(x)} /> : null}
          {recipient && x.status === 'requested' ? <Btn small title="Cancel request" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => act(() => api.patch(`/sponsorship-returns/${x.id}`, { status: 'cancelled', expected_version: x.version }), 'Request cancelled')} /> : null}
        </View>))}
      {eligible.length ? <Btn small title="Report a return" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => { key.current = `ret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; setForm({ kind: 'request' }); }} /> : null}
      {sponsor && !can('pay') && o.returns.some((x) => x.status === 'requested') ? <T size={12} color={c.mute}>Your role cannot answer returns. Ask a Finance or Manager colleague.</T> : null}
      <FormSheet visible={form?.kind === 'request'} onClose={() => setForm(null)} title="Report a return" submitLabel="Send return"
        fields={[
          { key: 'delivery_id', label: 'Which shipment', type: 'chips', options: eligible.map((dl) => ({ value: dl.id, label: `${dl.reference || 'Shipment'} · ${returnable(o, dl)} returnable` })) },
          { key: 'quantity', label: 'Quantity returned', type: 'stepper', min: 1, max: Math.max(1, ...eligible.map((dl) => returnable(o, dl))), default: 1 },
          { key: 'reason', label: 'Reason', type: 'chips', options: REASONS },
          { key: 'evidence_url', label: 'Link to a photo or courier note (https)', type: 'url', optional: true },
          { key: 'note', label: 'Note', type: 'multiline', optional: true },
          { key: 'resolution', label: 'You would like the sponsor to', type: 'choice', options: [{ value: 'replace', label: 'Replace' }, { value: 'credit', label: 'Credit (no replacement)' }] }]}
        onSubmit={async (v) => { const { delivery_id, ...body } = v; await api.post(`/sponsorship-deliveries/${delivery_id}/returns`, { ...body, idempotency_key: key.current }); reload(); return 'Return sent — the sponsor will answer it'; }} />
      <FormSheet visible={form?.kind === 'accept'} onClose={() => setForm(null)} title="Accept this return" submitLabel="Accept"
        fields={[{ key: 'resolution', label: 'You will', type: 'choice', options: [{ value: 'replace', label: 'Replace' }, { value: 'credit', label: 'Credit (no replacement)' }], default: r?.resolution ?? 'replace' }, { key: 'note', label: 'Note', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-returns/${r.id}`, { status: 'accepted', resolution: v.resolution, note: v.note, expected_version: r.version }); reload(); return 'Return accepted'; }} />
      <FormSheet visible={form?.kind === 'dispute'} onClose={() => setForm(null)} title="Dispute this return" submitLabel="Dispute" fields={[{ key: 'note', label: 'Why', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-returns/${r.id}`, { status: 'disputed', note: v.note, expected_version: r.version }); reload(); return 'Dispute sent'; }} />
    </View>
  );
}

/** Vouchers of a funded service due. A voucher pays for the service; it never shares health or private information with the sponsor. */
export function ServiceVouchers({ o, service, sponsor, recipient, can, act, reload }) {
  const [form, setForm] = useState(null);
  const key = useRef(null);
  const [bookings, setBookings] = useState(null); // venue vouchers only: the person's own upcoming bookings
  useEffect(() => { if (form?.kind === 'redeem' && form.v.service_type === 'venue') { setBookings(null); api.get('/bookings').then((r) => setBookings(Array.isArray(r) ? r : r?.items ?? [])).catch(() => setBookings([])); } }, [form]);
  const toIssue = Math.max(0, o.quantity - o.vouchers_redeemed - o.vouchers_open);
  const v = form?.v;
  const redeemFields = !v ? [] : v.service_type === 'medical'
    ? [{ key: 'ack', type: 'section', label: 'This uses the funded service only. No health information is shared with the sponsor.' }]
    : v.service_type === 'venue'
      ? [{ key: 'booking_id', label: 'Which booking does it pay for', type: 'chips', optional: true, options: (bookings ?? []).map((b) => ({ value: b.id, label: `${b.venue_name} · ${b.resource_name} · ${new Date(b.starts_at).toLocaleString()}` })) }, { key: 'reference', label: 'Reference', optional: true }]
      : [{ key: 'reference', label: 'Reference (session or trip)', optional: true }];
  return (
    <View style={{ marginTop: 4 }}>
      <T size={12} weight="700">{SERVICES[service] ?? 'Service'} · {o.quantity} funded · redeemed {o.vouchers_redeemed} · usable {o.vouchers_open}{sponsor ? ` · still to issue ${toIssue}` : ''}</T>
      {service === 'medical' ? <T size={12} color={c.mute}>Funding a medical service pays for it. It never gives the sponsor access to any health or clinical information.</T> : null}
      {o.vouchers.length ? o.vouchers.map((x) => (
        <View key={x.id} style={{ marginTop: 6, borderLeftWidth: 3, borderLeftColor: c.line, paddingLeft: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T size={12} weight="800" style={{ flex: 1 }}>Voucher {code(x)}{x.valid_until ? ` · valid to ${day(x.valid_until)}` : ''}</T><Tag label={x.status} color={tone[x.status]} />
          </View>
          {x.status === 'redeemed' && x.redeemed_at ? <T size={12} color={c.mute}>Redeemed {day(x.redeemed_at)}{x.reference ? ` · ${x.reference}` : ''}{x.has_booking ? ' · against a booking' : ''}</T> : null}
          {x.void_reason ? <T size={12} color={c.mute}>Voided: {x.void_reason}</T> : null}
          {recipient && x.status === 'issued' && o.status === 'scheduled' && !o.held ? <Btn small title="Redeem" color={c.mint} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => { key.current = `rdm-${x.id.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; setForm({ kind: 'redeem', v: x }); }} /> : null}
          {sponsor && can('pay') && x.status === 'issued' ? <Btn small title="Void" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => setForm({ kind: 'void', v: x })} /> : null}
        </View>)) : <T size={12} color={c.mute}>{sponsor ? 'No vouchers issued yet.' : 'No vouchers issued yet. They appear here once the sponsor issues them.'}</T>}
      {sponsor && can('pay') && o.status === 'scheduled' && !o.held && toIssue > 0 ? <Btn small title="Issue vouchers" color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setForm({ kind: 'issue' })} /> : null}
      {sponsor && !can('pay') ? <T size={12} color={c.mute}>Your role cannot issue vouchers. Ask a Finance or Manager colleague.</T> : null}
      <FormSheet visible={form?.kind === 'issue'} onClose={() => setForm(null)} title="Issue vouchers" submitLabel="Issue"
        fields={[{ key: 'count', label: 'How many', type: 'stepper', min: 1, max: Math.max(1, toIssue), default: 1 }, { key: 'valid_until', label: 'Valid until', type: 'date', optional: true }]}
        onSubmit={async (f) => { await api.post(`/sponsorship-obligations/${o.id}/vouchers`, f); reload(); return 'Vouchers issued'; }} />
      <FormSheet visible={form?.kind === 'redeem'} onClose={() => setForm(null)} title={`Redeem voucher ${v ? code(v) : ''}`} submitLabel="Redeem" fields={redeemFields}
        onSubmit={async (f) => { const { ack, ...body } = f; try { const r = await api.post(`/sponsorship-vouchers/${v.id}/redeem`, { ...body, idempotency_key: key.current }); reload(); return r.replayed ? 'Already redeemed — nothing was charged twice' : 'Voucher redeemed'; } catch (e) { if (e.status === 409) reload(); throw e; } }} />
      <FormSheet visible={form?.kind === 'void'} onClose={() => setForm(null)} title="Void this voucher" submitLabel="Void" fields={[{ key: 'reason', label: 'Why', type: 'multiline' }]}
        onSubmit={async (f) => { await api.patch(`/sponsorship-vouchers/${v.id}`, { reason: f.reason, expected_version: v.version }); reload(); return 'Voucher voided'; }} />
    </View>
  );
}
