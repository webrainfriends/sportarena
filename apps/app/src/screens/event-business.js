// The money side of an event: income and cost at a glance, sponsors and vendors (invite, track, end) and what is on sale.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { A, ABtn, AEmpty, ARow, ASection, AStat, AT, ATag } from '../arena';
import { FormSheet } from '../FormSheet';
import { Chip, Empty, Field, Loading, Row, Sheet, T } from '../ui';
import { moneyIn } from '../vtime';
import { useDo } from './console-utils';

const KINDS = [['sponsor', '💎', 'Sponsor'], ['retail', '🛍️', 'Retail stall'], ['catering', '🍽️', 'Catering'], ['other', '🔧', 'Other']];

export function MoneyTiles({ money, short }) {
  if (!money) return null;
  const m = (x) => moneyIn(x, money.currency);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {short ? (
        <><AStat icon="📥" label="Income" value={m(money.income_cents)} tone={A.green} /><AStat icon="📤" label="Crew cost" value={m(money.expected_cost_cents)} tone={A.sun} /><AStat icon="📊" label="Net" value={m(money.net_cents)} /></>
      ) : (
        <><AStat icon="🎟️" label="Entry fees" value={m(money.entry_fees_cents)} /><AStat icon="💎" label="Sponsors" value={m(money.sponsors.cents)} tone={A.green} /><AStat icon="🛍️" label="Vendor fees" value={m(money.vendors.pitch_fees_cents)} /><AStat icon="📤" label="Crew cost" value={m(money.staff.cost_cents)} tone={A.sun} /><AStat icon="📊" label="Net" value={m(money.net_cents)} /></>
      )}
    </View>
  );
}

export function BusinessTab({ id, e, vend, money, reload }) {
  const [invite, setInvite] = useState(false);
  const prods = useLoad(() => api.get(`/events/${id}/products`), [id]);
  const act = useDo(() => { reload(); prods.reload(); });
  return (
    <>
      <MoneyTiles money={money} />
      <ABtn title="Invite a sponsor or vendor" onPress={() => setInvite(true)} />
      {vend.length ? vend.map((v) => (
        <ARow key={v.id} left={<AT size={26}>{KINDS.find(([k]) => k === v.kind)?.[1]}</AT>} title={v.sponsor_name ?? v.vendor_name} sub={`${v.kind}${v.fee_cents ? ` · ${moneyIn(v.fee_cents, v.currency)}` : ''}${v.in_kind ? ` · ${v.in_kind}` : ''}`}
          right={<><ATag label={v.status} />{v.status === 'accepted' ? <ABtn small tone="ghost" title="End" onPress={() => act(() => api.post(`/event-vendors/${v.id}/end`), 'Ended')} /> : null}</>} />
      )) : <AEmpty emoji="💼" title="No sponsors or vendors yet" sub="Invite a brand to sponsor, or shops and caterers to run stalls." />}
      <ASection title="On sale at the event" />
      {prods.data?.length ? prods.data.map((p) => <ARow key={p.id} left={<AT size={24}>{p.emoji}</AT>} title={p.name} sub={`${moneyIn(p.price_cents, e.currency)} · ${p.seller_name}`} />) : <AT size={13} color={A.mute}>Confirmed retail vendors list their shop products here.</AT>}
      {invite ? <InviteSheet id={id} e={e} onClose={() => setInvite(false)} onSent={reload} /> : null}
    </>
  );
}

function InviteSheet({ id, e, onClose, onSent }) {
  const [kind, setKind] = useState(null), [q, setQ] = useState(''), [target, setTarget] = useState(null);
  const pk = kind === 'sponsor' ? 'sponsor' : 'supplier';
  const found = useLoad(() => (kind && !target ? api.get(`/events/${id}/partners`, { kind: pk, q: q || undefined, limit: 30 }) : Promise.resolve([])), [kind, q, target]);
  return (
    <Sheet visible onClose={onClose} title={target ? `Invite ${target.name}` : 'Invite a sponsor or vendor'}>
      {!kind ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{KINDS.map(([k, icon, label]) => <Chip key={k} label={`${icon} ${label}`} onPress={() => setKind(k)} />)}</View>
        : !target ? (
          <>
            <Chip label={`${KINDS.find(([k]) => k === kind)[1]} ${KINDS.find(([k]) => k === kind)[2]}  ✕`} active onPress={() => setKind(null)} />
            <Field value={q} onChangeText={setQ} placeholder={kind === 'sponsor' ? 'Search sponsor brands…' : 'Search suppliers and shops…'} />
            {found.loading ? <Loading /> : (found.data ?? []).length ? found.data.map((x) => <Row key={x.id} left={<T size={24}>{x.emoji ?? '🏷️'}</T>} title={x.name} sub={x.city ?? ''} onPress={() => setTarget(x)} />) : <Empty emoji="🔎" title="No match" sub="Try another search." />}
          </>
        ) : (
          <FormSheet inline visible onClose={onClose} title="" onBack={() => setTarget(null)} submitLabel="Send invitation"
            fields={[{ key: 'fee', label: kind === 'sponsor' ? 'Sponsorship amount' : 'Stall / pitch fee', type: 'money', currency: e.currency, optional: true }, ...(kind === 'sponsor' ? [{ key: 'in_kind', label: 'In-kind support (kit, drinks, prizes…)', optional: true }] : []), { key: 'notes', label: 'Message', type: 'multiline', optional: true }]}
            onSubmit={async (v) => { await api.post(`/events/${id}/vendors`, { kind, ...(kind === 'sponsor' ? { sponsor_id: target.id } : { vendor_user_id: target.id }), fee_cents: v.fee || 0, in_kind: v.in_kind || undefined, notes: v.notes || undefined }); onSent(); onClose(); return 'Invitation sent'; }} />
        )}
    </Sheet>
  );
}
