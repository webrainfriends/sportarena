import React, { useMemo, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useBasket } from '../basket';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { KIND } from './book';
import { Calendar, Counter, Stepper, StickyBar, byPartOfDay } from '../pickers';
import { addDays, longDay, moneyIn, offerLabel, timeIn, todayIn } from '../vtime';
import { useLayout } from '../layout';
import { AlertSheet } from './alerts';

const STEPS = ['Court', 'Date', 'Time', 'Review'];

/** Join slots that touch (end == next start) into single booking lines. */
export const mergeRuns = (slots) => {
  const runs = [];
  for (const s of [...slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
    const last = runs[runs.length - 1];
    if (last && last.ends_at === s.starts_at) { last.ends_at = s.ends_at; last.est_cents += s.price_cents; last.slots += 1; } else runs.push({ starts_at: s.starts_at, ends_at: s.ends_at, est_cents: s.price_cents, slots: 1 });
  }
  return runs;
};

/**
 * Booking wizard: Court(s) → Date (availability calendar) → Time (slots by part of day, multi-select) → Review.
 * Courts, dates and times can be combined freely — everything you pick lands in one basket / one booking.
 */
export function BookFlow({ venueId, resourceId, date: startDate }) {
  const { toast } = useSession();
  const { push } = useNav();
  const { add, items: basketItems } = useBasket();
  const L = useLayout();
  const v = useLoad(() => api.get(`/venues/${venueId}`), [venueId]);
  const [step, setStep] = useState(resourceId ? (startDate ? 2 : 1) : 0);
  const [courts, setCourts] = useState(resourceId ? [resourceId] : []);
  const [sport, setSport] = useState('');
  const [date, setDate] = useState(startDate ?? null);
  const [month, setMonth] = useState((startDate ?? '').slice(0, 7) || null);
  const [len, setLen] = useState(1);              // slots selected per tap
  const [qty, setQty] = useState({});             // courtId -> units
  const [sel, setSel] = useState({});             // `${courtId}|${starts_at}` -> { res, slot }
  const [alertOpen, setAlertOpen] = useState(false);
  const [wl, setWl] = useState(null);           // a sold-out slot the person may queue for
  const [wlBusy, setWlBusy] = useState(false);
  const tz = v.data?.timezone ?? 'UTC';
  const today = todayIn(tz);
  const m = month ?? today.slice(0, 7);
  const single = courts.length === 1 ? courts[0] : undefined;
  const cal = useLoad(() => (v.data && step === 1 ? api.get(`/venues/${venueId}/calendar`, { month: m, resource_id: single, sport: single ? undefined : sport }) : Promise.resolve(null)), [venueId, m, single, sport, step, v.data?.id]);
  const grid = useLoad(() => (v.data && date && step === 2 ? api.get(`/venues/${venueId}/availability`, { date }) : Promise.resolve(null)), [venueId, date, step, v.data?.id]);

  if (v.loading && !v.data) return <Screen><Loading /></Screen>;
  if (v.error) return <Screen><ErrorBox error={v.error} onRetry={v.reload} /></Screen>;
  const x = v.data;
  const sports = [...new Map(x.resources.filter((r) => r.sport_slug && r.kind !== 'equipment').map((r) => [r.sport_slug, r])).values()];
  const list = x.resources.filter((r) => (!sport || r.sport_slug === sport));
  const picked = Object.values(sel);
  const total = picked.reduce((s, p) => s + p.slot.price_cents * (qty[p.res.id] ?? 1), 0);
  const photoOf = (r) => x.media?.find((md) => md.resource_id === r.id && md.kind === 'photo') ?? null;
  const gridFor = (rid) => grid.data?.resources.find((r) => r.id === rid);

  const toggleCourt = (r) => setCourts((cur) => (cur.includes(r.id) ? cur.filter((i) => i !== r.id) : [...cur, r.id]));
  const keyOf = (rid, s) => `${rid}|${s.starts_at}`;
  const tapSlot = (res, slots, i) => {
    const s = slots[i];
    if (s.status === 'booked' && !sel[keyOf(res.id, s)]) return setWl({ res, slot: s });
    const units = qty[res.id] ?? 1;
    const key = keyOf(res.id, s);
    if (sel[key]) {
      // deselect the whole contiguous selected run around this slot
      const drop = new Set([key]);
      for (let j = i - 1; j >= 0 && sel[keyOf(res.id, slots[j])]; j--) drop.add(keyOf(res.id, slots[j]));
      for (let j = i + 1; j < slots.length && sel[keyOf(res.id, slots[j])]; j++) drop.add(keyOf(res.id, slots[j]));
      setSel((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !drop.has(k))));
      return;
    }
    const run = slots.slice(i, i + len);
    const ok = run.length === len && run.every((q, k) => q.status === 'free' && q.free_units >= units && (k === 0 || run[k - 1].ends_at === q.starts_at));
    if (!ok) return toast(len > 1 ? `Need ${len} free slots in a row from ${timeIn(s.starts_at, tz)}` : 'That slot is no longer free');
    if (run.length < res.min_slots) return toast(`${res.name} needs at least ${res.min_slots} slot(s)`);
    setSel((cur) => ({ ...cur, ...Object.fromEntries(run.map((q) => [keyOf(res.id, q), { res, slot: q, date }])) }));
  };

  const toBasket = () => {
    const byRes = {};
    for (const p of picked) (byRes[p.res.id] ??= { res: p.res, slots: [] }).slots.push(p.slot);
    const out = [];
    for (const { res, slots } of Object.values(byRes)) {
      const units = qty[res.id] ?? 1;
      for (const run of mergeRuns(slots)) out.push({ key: `${res.id}|${run.starts_at}|${run.ends_at}`, resource_id: res.id, resource_name: res.name, venue_id: x.id, venue_name: x.name, timezone: tz, currency: x.currency, starts_at: run.starts_at, ends_at: run.ends_at, quantity: units, est_cents: run.est_cents * units });
    }
    add(out); setSel({});
    return out.length;
  };

  const next = () => {
    if (step === 0) { if (!courts.length) return toast('Pick at least one court'); setStep(1); if (!month) setMonth(today.slice(0, 7)); }
    else if (step === 1) { if (!date) return toast('Pick a date'); setStep(2); }
    else if (step === 2) { if (!picked.length) return toast('Pick at least one time slot'); setStep(3); }
    else { toBasket(); push('Basket'); }
  };
  const footer = step === 0 ? { title: courts.length ? `${courts.length} court${courts.length === 1 ? '' : 's'} selected` : 'Choose a court', action: 'Continue', off: !courts.length }
    : step === 1 ? { title: date ? longDay(date) : 'Choose a date', action: 'Continue', off: !date }
      : step === 2 ? { title: picked.length ? `${picked.length} slot${picked.length === 1 ? '' : 's'} · ${moneyIn(total, x.currency)}` : 'Choose your times', sub: basketItems.length ? `${basketItems.length} already in your basket` : undefined, action: 'Review', off: !picked.length }
        : { title: moneyIn(total, x.currency), sub: 'Excl. discounts — final price on the next screen', action: 'Checkout', off: !picked.length };

  const runsByCourt = [...new Set(picked.map((p) => p.res.id))].map((rid) => ({ res: picked.find((p) => p.res.id === rid).res, runs: [...new Set(picked.filter((p) => p.res.id === rid).map((p) => p.date))].sort().flatMap((d) => mergeRuns(picked.filter((p) => p.res.id === rid && p.date === d).map((p) => p.slot)).map((r) => ({ ...r, date: d }))) }));

  return (
    <View style={{ flex: 1 }}>
      <Screen wide={L.tablet}>
        <H1 style={{ marginTop: 6, fontSize: 24 }}>{x.emoji} {x.name}</H1>
        <Stepper steps={STEPS} current={step} onJump={setStep} />

        {step === 0 ? (
          <View style={{ gap: 10 }}>
            <T color={c.mute} weight="600">Pick the court(s) you want. Choose several to play side by side — or book at more than one venue from your basket.</T>
            {sports.length > 1 ? <Seg options={[{ value: '', label: 'All sports' }, ...sports.map((r) => ({ value: r.sport_slug, label: `${r.sport_emoji ?? ''} ${r.sport}` }))]} value={sport} onChange={setSport} color={c.cyan} /> : null}
            {list.length ? list.map((r) => {
              const on = courts.includes(r.id);
              const ph = photoOf(r);
              return (
                <Pressable key={r.id} onPress={() => toggleCourt(r)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                  <Card color={c.paper} pad={0} style={on ? { borderRadius: 18, borderWidth: 2, borderColor: c.pink } : null}>
                    <View style={{ flexDirection: 'row', gap: 12, padding: 12, alignItems: 'center' }}>
                      {ph ? <Image source={{ uri: mediaUrl(ph.url) }} style={{ width: 84, height: 84, borderRadius: 14, backgroundColor: c.violetSoft }} /> : <View style={{ width: 84, height: 84, borderRadius: 14, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T size={34}>{KIND[r.kind] ?? '📍'}</T></View>}
                      <View style={{ flex: 1, gap: 3 }}>
                        <T weight="700" size={16}>{r.name}</T>
                        <T size={12} color={c.mute}>{[r.sport && `${r.sport_emoji ?? ''} ${r.sport}`, r.indoor != null && (r.indoor ? 'Indoor' : 'Outdoor'), r.surface, r.max_players && `up to ${r.max_players} players`, r.capacity > 1 && `${r.capacity} ${r.kind === 'equipment' ? 'units' : 'available'}`].filter(Boolean).join(' · ')}</T>
                        <T weight="700" color={c.pink}>{r.hourly_rate_cents ? `${moneyIn(r.hourly_rate_cents, x.currency)}/hr` : 'Free'}</T>
                      </View>
                      <View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: on ? c.pink : c.line, backgroundColor: on ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{on ? <T size={14} color="#fff" weight="700">✓</T> : null}</View>
                    </View>
                  </Card>
                </Pressable>
              );
            }) : <Empty emoji="🏟️" title="No courts for that sport" />}
          </View>
        ) : null}

        {step === 1 ? (
          <View style={{ gap: 10 }}>
            <Card>
              <Calendar month={m} onMonth={setMonth} value={date} days={cal.data?.days} currency={x.currency} today={today} onChange={(d) => { setDate(d); setStep(2); }} />
              {cal.loading && !cal.data ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Checking availability…</T> : null}
            </Card>
            <Btn small title="🔔 Nothing that suits? Alert me when a slot opens" color={c.paper} onPress={() => setAlertOpen(true)} style={{ alignSelf: 'flex-start' }} />
            <T size={12} color={c.mute}>Prices show the cheapest free slot that day. {single ? '' : 'Availability covers all courts at this venue.'}</T>
          </View>
        ) : null}

        {step === 2 ? (
          <View style={{ gap: 12 }}>
            <Card pad={12}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <Pressable onPress={() => setStep(1)}><T weight="700">📅 {longDay(date)} <T color={c.pink} weight="700">change</T></T></Pressable>
              </View>
              <View style={{ marginTop: 10 }}><Counter label={`Slots per tap${grid.data?.resources?.[0] ? ` (${len * grid.data.resources[0].slot_minutes} min)` : ''}`} value={len} onChange={setLen} min={1} max={8} /></View>
            </Card>
            {grid.loading && !grid.data ? <Loading /> : grid.error ? <ErrorBox error={grid.error} onRetry={grid.reload} /> : courts.map((cid) => {
              const r = gridFor(cid);
              const res = x.resources.find((q) => q.id === cid);
              if (!r) return null;
              const slots = r.slots;
              return (
                <Card key={cid}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ flex: 1 }}><T weight="700" size={16}>{r.name}</T><T size={12} color={c.mute}>{r.slot_minutes}-min slots{r.min_slots > 1 ? ` · min ${r.min_slots}` : ''}{r.max_slots ? ` · max ${r.max_slots}` : ''}</T></View>
                    {r.capacity > 1 ? <Counter value={qty[cid] ?? 1} onChange={(n) => { setQty((q) => ({ ...q, [cid]: n })); setSel((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith(`${cid}|`)))); }} min={1} max={Math.min(r.capacity, 12)} suffix={r.kind === 'equipment' ? ' units' : ''} /> : null}
                  </View>
                  {slots.length ? byPartOfDay(slots.map((s, i) => ({ s, i })), ({ s }) => Number(new Date(s.starts_at).toLocaleString('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }))).map((g) => (
                    <View key={g.label} style={{ marginTop: 12 }}>
                      <T size={12} weight="700" color={c.mute}>{g.label.toUpperCase()}</T>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                        {g.items.map(({ s, i }) => {
                          const on = !!sel[keyOf(cid, s)];
                          const free = s.status === 'free' && s.free_units >= (qty[cid] ?? 1);
                          return (
                            <Pressable key={s.starts_at} disabled={!free && !on && s.status !== 'booked'} onPress={() => tapSlot(res, slots, i)} accessibilityState={{ selected: on, disabled: !free }}
                              style={{ borderRadius: 12, borderWidth: 1.5, borderColor: on ? c.pink : free ? c.line : 'transparent', backgroundColor: on ? c.pink : free ? c.paper : c.violetSoft, paddingVertical: 8, paddingHorizontal: 10, minWidth: 84, alignItems: 'center', opacity: free || on ? 1 : s.status === 'booked' ? 0.8 : 0.5 }}>
                              <T weight="700" size={13} color={on ? '#fff' : c.ink}>{timeIn(s.starts_at, tz)}</T>
                              <T size={11} color={on ? '#fff' : c.mute}>{free ? moneyIn(s.price_cents * (qty[cid] ?? 1), x.currency) : s.status === 'blocked' ? 'closed' : s.status === 'booked' ? 'waitlist' : s.status.replace('_', ' ')}</T>
                              {free && r.capacity > 1 && s.free_units <= 2 ? <T size={9} color={on ? '#fff' : c.orange} weight="700">{s.free_units} left</T> : null}
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  )) : <T color={c.mute} style={{ marginTop: 10 }}>Closed this day.</T>}
                </Card>
              );
            })}
            <Btn small title="🔔 Can't find a time? Alert me when one opens" color={c.paper} onPress={() => setAlertOpen(true)} style={{ alignSelf: 'flex-start' }} />
            <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
              {[[c.pink, 'Selected'], [c.paper, 'Available'], [c.violetSoft, 'Sold out / closed']].map(([bg, l]) => <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: bg, borderWidth: 1, borderColor: c.line }} /><T size={11} color={c.mute}>{l}</T></View>)}
            </View>
          </View>
        ) : null}

        {step === 3 ? (
          <View style={{ gap: 10 }}>
            <T color={c.mute} weight="600">Check your picks. You can still change courts, dates or times — then go to checkout for promo codes and payment.</T>
            {runsByCourt.map(({ res, runs }) => (
              <Card key={res.id}>
                <T weight="700" size={16}>{res.name}{(qty[res.id] ?? 1) > 1 ? ` × ${qty[res.id]}` : ''}</T>
                {runs.map((r) => (
                  <View key={r.starts_at} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line, marginTop: 6 }}>
                    <View style={{ flex: 1 }}><T weight="600">{longDay(r.date)}</T><T size={13} color={c.mute}>{timeIn(r.starts_at, tz)} → {timeIn(r.ends_at, tz)} · {r.slots} slot{r.slots === 1 ? '' : 's'}</T></View>
                    <T weight="700">{moneyIn(r.est_cents * (qty[res.id] ?? 1), x.currency)}</T>
                    <Btn small title="✕" color={c.paper} ink={c.red} onPress={() => setSel((cur) => Object.fromEntries(Object.entries(cur).filter(([k, p]) => !(p.res.id === res.id && p.date === r.date && p.slot.starts_at >= r.starts_at && p.slot.starts_at < r.ends_at))))} />
                  </View>
                ))}
              </Card>
            ))}
            {!picked.length ? <Empty emoji="🗓️" title="Nothing selected" sub="Go back and pick some times." /> : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title="+ Add another date" color={c.paper} onPress={() => setStep(1)} />
              <Btn small title="+ Add another court" color={c.paper} onPress={() => setStep(0)} />
            </View>
            {x.offers?.length ? <Card color={c.limeSoft} pad={12}>{x.offers.map((o) => <T key={o.id} size={13} weight="700" color={c.lime}>🏷️ {offerLabel(o, x.currency)}</T>)}</Card> : null}
          </View>
        ) : null}
        {step > 0 ? <Btn small title="‹ Back" color={c.paper} onPress={() => setStep(step - 1)} style={{ marginTop: 14, alignSelf: 'flex-start' }} /> : null}
      </Screen>
      <Sheet visible={!!wl} onClose={() => setWl(null)} title="Sold out — join the waitlist?">
        {wl ? <T color={c.mute}>{wl.res.name} · {timeIn(wl.slot.starts_at, tz)}. If someone cancels, the first person in line gets the slot held for them for a few minutes and we notify you straight away.</T> : null}
        <Btn title="Join the waitlist" loading={wlBusy} onPress={async () => {
          setWlBusy(true);
          try { const r = await api.post('/waitlist', { resource_id: wl.res.id, starts_at: wl.slot.starts_at, ends_at: wl.slot.ends_at, quantity: qty[wl.res.id] ?? 1 }); toast(`You're #${r.position} in line 🕒`); setWl(null); }
          catch (e) { toast(e.message); setWl(null); grid.reload(); } finally { setWlBusy(false); }
        }} />
      </Sheet>
      <AlertSheet venue={x} visible={alertOpen} onClose={() => setAlertOpen(false)} date={date ?? undefined} resourceId={single} />
      <StickyBar title={footer.title} sub={footer.sub} action={footer.action} onAction={next} disabled={footer.off} bottom={L.floatingBar ? 84 : 0} />
    </View>
  );
}
