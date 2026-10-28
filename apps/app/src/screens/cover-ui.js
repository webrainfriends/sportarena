// Shared pieces of the Cover flow, used by the Cover screen and the pay sheet: the terms form, the payer search, ask-for-cover and send-this-bill.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, ErrorBox, Field, Loading, Row, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const KINDS = [['venue_invoice', 'Venue bookings'], ['venue_plan', 'Memberships & passes'], ['coach_hire', 'Coaching sessions'], ['appointment', 'Health appointments'], ['physio_package', 'Health session packages'], ['academy_charge', 'Academy fees'], ['insurance_policy', 'Insurance'], ['shop_order', 'Shop orders']];
const TERMS = [{ value: 'one_time', label: 'One payment' }, { value: 'duration', label: 'For a period' }, { value: 'unlimited', label: 'Until someone ends it' }];
/** The terms, shared by "ask" and "offer". `extra` fields go first. */
export const termFields = (extra = [], bill) => [
  ...extra,
  ...(bill ? [] : [{ key: 'purposes', label: 'What should be covered?', type: 'multi', options: KINDS.map(([value, label]) => ({ value, label })) }]),
  ...(bill ? [] : [{ key: 'term', label: 'For how long?', type: 'chips', options: TERMS }]),
  { key: 'valid_until', label: 'Covered until', type: 'date', min: new Date().toISOString().slice(0, 10), show: (v) => !bill && v.term === 'duration' },
  { key: 'auto_send', label: 'Send every bill to the payer automatically', type: 'switch', hint: 'Off: the payer only sees bills you choose to send.', show: (v) => !bill && v.term !== 'one_time' },
  { key: 'limits', label: 'Set spending limits', type: 'switch', show: () => !bill },
  { key: 'currency', label: 'Limits are in', type: 'currency', show: (v) => !bill && v.limits },
  { key: 'max_per_bill_minor', label: 'Most for one bill', type: 'money', currency: (v) => v.currency, optional: true, show: (v) => !bill && v.limits },
  { key: 'max_total_minor', label: 'Most in total', type: 'money', currency: (v) => v.currency, optional: true, show: (v) => !bill && v.limits },
  { key: 'note', label: 'A note for them', type: 'chips', optional: true, options: ['Season fees', 'Kit and bookings', 'Coaching', 'Health costs', 'Studies', 'Thank you'] },
];
export const termBody = (v, bill) => ({
  ...(bill ? { purposes: [bill.purpose_type], term: 'one_time', bill } : { purposes: v.purposes, term: v.term, ...(v.term === 'duration' ? { valid_until: v.valid_until } : {}), auto_send: !!v.auto_send && v.term !== 'one_time' }),
  ...(v.limits && !bill ? { currency: v.currency, ...(v.max_per_bill_minor ? { max_per_bill_minor: v.max_per_bill_minor } : {}), ...(v.max_total_minor ? { max_total_minor: v.max_total_minor } : {}) } : {}),
  ...(v.note ? { note: v.note } : {}),
});

/** Search a person or an organisation by name (never an id). */
function PayerPicker({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const res = useLoad(() => (q.trim().length >= 3 ? api.get('/cover/payers', { q: q.trim() }) : Promise.resolve(null)), [q]);
  return (
    <Sheet visible onClose={onClose} title="Who should pay?">
      <Field label="Search by name" value={q} onChangeText={setQ} placeholder="A person, a club, a sponsor…" />
      {res.loading && q.trim().length >= 3 ? <Loading /> : null}
      {(res.data?.people ?? []).map((p) => <Row key={p.id} title={`${p.avatar_emoji ?? '🙂'} ${p.display_name}`} sub={`@${p.handle}`} onPress={() => onPick({ payer_user_id: p.id, name: p.display_name })} />)}
      {(res.data?.organisations ?? []).map((o) => <Row key={o.id} title={`🏢 ${o.name}`} sub={String(o.kind).replace(/_/g, ' ')} onPress={() => onPick({ payer_org_id: o.id, name: o.name })} />)}
      {res.data && !res.data.people.length && !res.data.organisations.length ? <T size={13} color={c.mute}>Nobody found. Ask them to join Gotmygame, or try another spelling.</T> : null}
    </Sheet>
  );
}

/** Ask someone to pay: pick the payer, then the terms (or just one bill). */
export function AskForCover({ bill, onClose, onDone }) {
  const { toast } = useSession();
  const [payer, setPayer] = useState(null);
  if (!payer) return <PayerPicker onPick={setPayer} onClose={onClose} />;
  return (
    <FormSheet visible onClose={onClose} title={`Ask ${payer.name}`} submitLabel="Send request" initial={{ term: 'unlimited', purposes: bill ? [bill.purpose_type] : ['venue_invoice'] }}
      fields={termFields([], bill)}
      onSubmit={async (v) => { await api.post('/cover/requests', { ...(payer.payer_user_id ? { payer_user_id: payer.payer_user_id } : { payer_org_id: payer.payer_org_id }), ...termBody(v, bill) }); onDone?.(); toast(`Request sent to ${payer.name}`); return null; }} />
  );
}

/** At a bill: send it to whoever already covers you, or ask someone new. */
export function CoverSendSheet({ target, onClose, onDone }) {
  const { toast } = useSession();
  const opts = useLoad(() => api.get('/cover/options', { purpose_type: target.type ?? 'venue_invoice', purpose_id: target.id }), [target.id]);
  const [ask, setAsk] = useState(false);
  if (ask) return <AskForCover bill={{ purpose_type: target.type ?? 'venue_invoice', purpose_id: target.id }} onClose={() => { setAsk(false); onClose(); }} onDone={onDone} />;
  return (
    <Sheet visible onClose={onClose} title="Ask someone else to pay">
      {opts.loading && !opts.data ? <Loading /> : opts.error ? <ErrorBox error={opts.error} onRetry={opts.reload} /> : (
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>{target.label} · {moneyIn(target.amount, target.currency)}. They see what it is and the amount — never who provides it.</T>
          {opts.data.options.map((o) => (
            <Row key={o.mandate_id} title={`Send to ${o.payer_name}`} sub={o.sent ? 'Already sent' : o.auto_send ? 'They receive every bill automatically' : 'Under your agreement'}
              onPress={o.sent ? undefined : async () => { try { await api.post(`/cover/${o.mandate_id}/bills`, { purpose_type: target.type ?? 'venue_invoice', purpose_id: target.id }); toast(`Sent to ${o.payer_name}`); await onDone?.(); onClose(); } catch (e) { toast(e.message); } }} />
          ))}
          {!opts.data.options.length ? <T size={13}>You have no agreement that covers this bill yet.</T> : null}
          <Btn title="Ask someone to pay just this bill" color={c.violet} onPress={() => setAsk(true)} />
        </View>
      )}
    </Sheet>
  );
}

