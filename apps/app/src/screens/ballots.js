// Venue slot ballots. The venue team opens a ballot for oversubscribed slots (manager tab), people bid for a slot (bid sheet, open
// ballots on the venue page and the booking flow) and a winner accepts and pays within the pay window (My ballots).
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, Loading, Row, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { addDays, dateTimeIn, localToIso, moneyIn, timeIn, todayIn } from '../vtime';

const STATUS_COLOR = { draft: c.violetSoft, open: c.mint, closed: c.orange, drawn: c.cyan, settled: c.violetSoft, cancelled: c.red };
const SLOT_LABEL = { open: 'Taking bids', offered: 'Winner has the pay window', awaiting_payment: 'Awaiting payment', confirmed: 'Confirmed', unfilled: 'Unfilled', cancelled: 'Cancelled' };
const ENTRY_LABEL = { entered: 'Entered', ranked: 'In the queue', offered: 'Won — pay to confirm', awaiting_payment: 'Awaiting payment', confirmed: 'Confirmed', lost: 'Not this time', expired: 'Expired', withdrawn: 'Withdrawn' };
const METHOD_HELP = { highest_bid: 'The highest bid wins each slot', random_draw: 'A fair draw — everyone pays the floor price' };

/** Dates from `from` to `to` (inclusive) on the chosen weekdays (0 = Sunday); all days when none are chosen. */
export function datesBetween(from, to, weekdays) {
  const out = [];
  for (let d = from, i = 0; d <= to && i < 120; d = addDays(d, 1), i++) {
    if (!weekdays?.length || weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) out.push(d);
  }
  return out;
}

// ------------------------------------------------------------------ venue team
export function BallotsManager({ v }) {
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState(null);
  const list = useLoad(() => api.get(`/venues/${v.id}/ballots`, { limit: 50 }), [v.id]);
  const tz = v.timezone;
  const courts = (v.resources ?? []).filter((r) => r.kind !== 'equipment');
  return (
    <Section title="Slot ballots" color={c.violet}>
      <T color={c.mute} size={13}>For slots more people want than you have: open a ballot, people bid, then draw or pick the winners. A winner holds the slot only until they pay.</T>
      <Btn title="New ballot" color={c.violet} onPress={() => setForm(true)} accessibilityLabel="Create a new slot ballot" />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (list.data ?? []).length ? list.data.map((b) => (
        <View key={b.id} style={{ gap: 8 }}>
          <Row title={b.title} color={open === b.id ? c.violetSoft : c.paper} onPress={() => setOpen(open === b.id ? null : b.id)}
            sub={`${b.slots} slot${b.slots === 1 ? '' : 's'} · ${b.entries} bid${b.entries === 1 ? '' : 's'} · closes ${dateTimeIn(b.closes_at, tz)}`}
            right={<Tag color={STATUS_COLOR[b.status]} label={b.status} />} />
          {open === b.id ? <BallotDetail id={b.id} venue={v} onChanged={list.reload} /> : null}
        </View>
      )) : <Empty emoji="🎟️" title="No ballots yet" sub="Create one for your busiest evenings and weekends." />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="New ballot" submitLabel="Create draft"
        initial={{ from_date: addDays(todayIn(tz), 7), to_date: addDays(todayIn(tz), 7), method: 'highest_bid', mode: 'auto', pay_window_minutes: 30, start_time: '18:00', end_time: '19:00' }}
        fields={[
          { key: 'title', label: 'Ballot name' },
          { key: 'resource_ids', label: 'Courts', type: 'multimenu', options: courts.map((r) => ({ value: r.id, label: r.name })), placeholder: 'Choose courts' },
          { key: 'from_date', toKey: 'to_date', label: 'Slot dates', type: 'daterange' },
          { key: 'weekdays', label: 'Only on these days', type: 'weekdays', optional: true, hint: 'Leave empty for every day in the range' },
          { key: 'start_time', label: 'Slot starts', type: 'time' }, { key: 'end_time', label: 'Slot ends', type: 'time' },
          { key: 'closes_at', label: 'Bidding closes', type: 'datetime', hint: 'Must be before the first slot starts' },
          { key: 'method', label: 'Winner is chosen by', type: 'chips', options: [{ value: 'highest_bid', label: 'Highest bid' }, { value: 'random_draw', label: 'Random draw' }] },
          { key: 'mode', label: 'Allocation', type: 'chips', options: [{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'I pick the winners' }] },
          { key: 'pay_window_minutes', label: 'Winner has to pay within', type: 'stepper', min: 5, max: 2880, step: 5, suffix: ' min' },
        ]}
        onSubmit={async (f) => {
          const dates = datesBetween(f.from_date, f.to_date, f.weekdays);
          if (!dates.length) throw new Error('No dates match those days');
          const slots = dates.flatMap((d) => f.resource_ids.map((rid) => ({ resource_id: rid, starts_at: localToIso(d, f.start_time, tz), ends_at: localToIso(d, f.end_time, tz) })));
          await api.post(`/venues/${v.id}/ballots`, { title: f.title, method: f.method, mode: f.mode, closes_at: f.closes_at, pay_window_minutes: f.pay_window_minutes, slots });
          list.reload(); return `Draft created with ${slots.length} slot${slots.length === 1 ? '' : 's'}`;
        }} />
    </Section>
  );
}

function BallotDetail({ id, venue, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/ballots/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  const b = d.data, cur = b.venue?.currency ?? venue.currency, tz = venue.timezone;
  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await d.reload(); onChanged?.(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const act = (title, path, ok, color = c.violet, body) => <Btn small title={title} color={color} disabled={busy} onPress={() => run(() => api.post(path, body), ok)} accessibilityLabel={title} />;
  const entriesOf = (sid) => (b.entries ?? []).filter((e) => e.slot_id === sid);
  return (
    <Card pad={12} color={c.paper}>
      <T color={c.mute} size={12}>{METHOD_HELP[b.method]} · {b.mode === 'auto' ? 'automatic allocation' : 'you pick the winners'} · winners pay within {b.pay_window_minutes} min</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {b.status === 'draft' ? act('Open bidding', `/ballots/${b.id}/open`, 'Bidding is open', c.pink) : null}
        {b.status === 'open' ? act('Close bidding', `/ballots/${b.id}/close`, 'Bidding closed', c.orange) : null}
        {['open', 'closed'].includes(b.status) ? act(b.mode === 'auto' ? 'Run the draw' : 'Rank the entries', `/ballots/${b.id}/draw`, b.mode === 'auto' ? 'Winners drawn and notified' : 'Entries ranked', c.pink) : null}
        {!['settled', 'cancelled'].includes(b.status) ? act('Cancel ballot', `/ballots/${b.id}/cancel`, 'Ballot cancelled', c.paper, {}) : null}
      </View>
      {b.slots.map((s) => (
        <View key={s.id} style={{ marginTop: 12, gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800">{s.resource_name} · {dateTimeIn(s.starts_at, tz)}–{timeIn(s.ends_at, tz)}</T>
              <T size={12} color={c.mute}>Floor {moneyIn(s.floor_cents, cur)} · {s.entries} bid{s.entries === 1 ? '' : 's'} · {SLOT_LABEL[s.status]}</T>
            </View>
            {['closed', 'drawn'].includes(b.status) && ['open', 'offered', 'awaiting_payment'].includes(s.status)
              ? <Btn small title="Release" color={c.paper} ink={c.red} disabled={busy} onPress={() => run(() => api.post(`/ballot-slots/${s.id}/release`, {}), 'Slot released')} accessibilityLabel={`Release ${s.resource_name} slot`} /> : null}
          </View>
          {entriesOf(s.id).map((e) => (
            <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8 }}>
              <T style={{ flex: 1 }} size={13}>{e.rank ? `#${e.rank} ` : ''}{e.display_name} · {moneyIn(e.bid_cents, cur)} · {ENTRY_LABEL[e.status]}</T>
              {['closed', 'drawn'].includes(b.status) && ['entered', 'ranked'].includes(e.status) && ['open', 'offered'].includes(s.status)
                ? <Btn small title="Give slot" color={c.violet} disabled={busy} onPress={() => run(() => api.post(`/ballot-slots/${s.id}/allocate`, { entry_id: e.id }), `Held for ${e.display_name}`)} accessibilityLabel={`Give the slot to ${e.display_name}`} /> : null}
            </View>
          ))}
        </View>
      ))}
      {b.draw_seed ? <T size={11} color={c.mute} style={{ marginTop: 10 }}>Draw seed {b.draw_seed} — the ranking can be reproduced from it.</T> : null}
    </Card>
  );
}

// ------------------------------------------------------------------ people bidding
/** Bid (or change / withdraw a bid) for one ballot slot. */
export function BidSheet({ visible, onClose, ballot, slot, venue, onDone }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  if (!ballot || !slot) return null;
  const tz = venue.timezone, cur = ballot.currency ?? venue.currency;
  const mine = (ballot.my_entries ?? []).find((e) => e.slot_id === slot.id && !['lost', 'expired', 'withdrawn'].includes(e.status));
  const lottery = ballot.method === 'random_draw';
  const title = `${slot.resource_name} · ${dateTimeIn(slot.starts_at, tz)}–${timeIn(slot.ends_at, tz)}`;
  return (
    <FormSheet visible={visible} onClose={onClose} title={mine ? 'Your bid' : 'Bid for this slot'} submitLabel={mine ? 'Change bid' : lottery ? 'Enter the draw' : 'Place bid'} initial={{ bid_cents: mine?.bid_cents ?? slot.floor_cents }}
      fields={[
        { key: 'info', label: title, type: 'section' },
        ...(lottery ? [] : [{ key: 'bid_cents', label: `Your bid (floor ${moneyIn(slot.floor_cents, cur)})`, type: 'money', currency: cur, hint: 'Nothing is charged now. If you win, the slot is held for you until you pay.' }]),
      ]}
      onSubmit={async (f) => {
        setBusy(true);
        try {
          if (mine) { if (!lottery) await api.patch(`/ballot-entries/${mine.id}`, { bid_cents: f.bid_cents }); } else await api.post(`/ballot-slots/${slot.id}/entries`, lottery ? {} : { bid_cents: f.bid_cents });
          onDone?.(); return mine ? 'Bid updated' : lottery ? `You're in the draw at ${moneyIn(slot.floor_cents, cur)}` : 'Bid placed — we will tell you the result';
        } finally { setBusy(false); }
      }}
      extra={mine ? <Btn title="Withdraw my entry" color={c.paper} ink={c.red} disabled={busy} onPress={async () => { try { await api.del(`/ballot-entries/${mine.id}`); toast('Entry withdrawn'); onDone?.(); onClose(); } catch (e) { toast(e.message); } }} /> : null} />
  );
}

/** Ballots currently taking bids at a venue; tap a slot to bid. */
export function OpenBallots({ venue }) {
  const open = useLoad(() => api.get(`/venues/${venue.id}/ballots/open`), [venue.id]);
  const [pick, setPick] = useState(null);
  const tz = venue.timezone;
  if (!open.data?.length) return null;
  return (
    <Section title="Slot ballots" color={c.violet}>
      {open.data.map((b) => (
        <Card key={b.id} pad={12} color={c.violetSoft}>
          <T weight="800">{b.title}</T>
          <T size={12} color={c.mute}>{METHOD_HELP[b.method]} · bidding closes {dateTimeIn(b.closes_at, tz)} · winners pay within {b.pay_window_minutes} min</T>
          <View style={{ gap: 6, marginTop: 8 }}>
            {b.slots.filter((s) => s.status === 'open').map((s) => {
              const mine = (b.my_entries ?? []).some((e) => e.slot_id === s.id && !['lost', 'expired', 'withdrawn'].includes(e.status));
              return <Row key={s.id} title={`${s.resource_name} · ${dateTimeIn(s.starts_at, tz)}`} sub={`Floor ${moneyIn(s.floor_cents, b.currency)} · ${s.entries} bid${s.entries === 1 ? '' : 's'}`}
                right={<Tag color={mine ? c.mint : c.cyan} label={mine ? 'Entered' : 'Bid'} />} onPress={() => setPick({ b, s })} />;
            })}
          </View>
        </Card>
      ))}
      <BidSheet visible={!!pick} onClose={() => setPick(null)} ballot={pick?.b} slot={pick?.s} venue={venue} onDone={open.reload} />
    </Section>
  );
}

// ------------------------------------------------------------------ my ballots
/** Your entries: results, offers to accept and pay, and entries still waiting for the draw. */
export function MyBallots() {
  const { toast } = useSession();
  const { push } = useNav();
  const [all, setAll] = useState(false);
  const list = useLoad(() => api.get('/me/ballot-entries', { include_done: all }), [all]);
  if (list.loading && !list.data) return <Loading />;
  const rows = list.data ?? [];
  return (
    <View style={{ gap: 8 }}>
      <Seg options={[{ value: false, label: 'Active' }, { value: true, label: 'All' }]} value={all} onChange={setAll} color={c.violet} />
      {!rows.length ? <T size={13} color={c.mute}>No ballot entries. Look for “Slot ballots” on a venue page to bid for a busy slot.</T> : rows.map((e) => (
        <Card key={e.id} pad={12} color={e.status === 'offered' ? c.limeSoft : c.paper}>
          <T weight="700">{e.venue_name} · {e.resource_name}</T>
          <T size={12} color={c.mute}>{dateTimeIn(e.starts_at, e.timezone)}–{timeIn(e.ends_at, e.timezone)} · your bid {moneyIn(e.bid_cents, e.currency)}</T>
          <T size={12} weight="700" color={e.status === 'offered' ? c.lime : c.mute}>
            {e.status === 'offered' ? `Yours until ${timeIn(e.hold_expires_at, e.timezone)} — accept and pay to confirm` : e.status === 'ranked' ? `Drawn: you are #${e.rank} in the queue` : ENTRY_LABEL[e.status]}
          </T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {e.status === 'offered' ? <Btn small title="Accept & pay" onPress={async () => { try { const r = await api.post(`/ballot-entries/${e.id}/accept`, {}); list.reload(); push('Reservation', { id: r.reservation.id }); } catch (x) { toast(x.message); list.reload(); } }} accessibilityLabel="Accept the slot and pay" /> : null}
            {e.status === 'awaiting_payment' && e.reservation_id ? <Btn small title="Pay now" onPress={() => push('Reservation', { id: e.reservation_id })} accessibilityLabel="Pay for the slot" /> : null}
            {['entered', 'ranked', 'offered', 'awaiting_payment'].includes(e.status) ? <Btn small title={e.status === 'entered' || e.status === 'ranked' ? 'Withdraw' : 'Give up'} color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/ballot-entries/${e.id}`); list.reload(); } catch (x) { toast(x.message); } }} accessibilityLabel="Withdraw from this ballot" /> : null}
          </View>
        </Card>
      ))}
    </View>
  );
}
