import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useBasket } from '../basket';
import { Bubble, Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Calendar } from '../pickers';
import { c } from '../theme';
import { PaySheet } from '../PaySheet';
import { PointsApplySheet, WalletApplySheet } from './wallet';
import { PassApplySheet } from './plans';
import { NewCaseSheet } from './cases';
import { currentDevice, disablePush, enablePush, pushSupport } from '../push';
import { KIND } from './book';
import { addDays, dateTimeIn, dayLabel, fmtMin, localDate, hoursSummary, localToIso, moneyIn, offerLabel, timeIn, todayIn } from '../vtime';
import { locale } from '../locale';

const open = (url) => (Platform.OS === 'web' ? window.open(url, '_blank', 'noopener') : Linking.openURL(url));
const Line = ({ k, v, strong }) => <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T color={c.mute} weight={strong ? '700' : '500'}>{k}</T><T weight={strong ? '700' : '600'}>{v}</T></View>;

// ------------------------------------------------------------------ basket / checkout
export function Basket() {
  const { items, remove, clear } = useBasket();
  const { toast } = useSession();
  const { replace, back } = useNav();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState([]);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({ items: items.map(({ resource_id, starts_at, ends_at, quantity }) => ({ resource_id, starts_at, ends_at, quantity })), promo_codes: codes });
  const sig = JSON.stringify(body());

  useEffect(() => {
    let live = true;
    setQuote(null);
    if (!items.length) return undefined;
    api.post('/reservations/quote', body()).then((q) => live && setQuote(q)).catch((e) => live && setQuote({ error: e.message }));
    return () => { live = false; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const currencies = [...new Set(items.map((i) => i.currency))];
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post('/reservations', body());
      clear(); toast(`Booked ${r.code} 🎉`); replace('Reservation', { id: r.id });
    } catch (e) { toast(e.message); setQuote(null); api.post('/reservations/quote', body()).then(setQuote).catch(() => {}); } finally { setBusy(false); }
  };
  const byVenue = [...new Map(items.map((i) => [i.venue_id, i.venue_name])).entries()];
  const problem = (idx) => quote?.problems?.find((p) => p.index === idx);

  if (!items.length) return <Screen><Empty emoji="🧺" title="Your basket is empty" sub="Pick slots on any venue — you can mix courts and venues in one booking." /><Btn title="Find a venue" onPress={back} style={{ marginTop: 12 }} /></Screen>;
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Your basket</H1>
      <T color={c.mute} weight="700">One booking for all of it. If any slot is taken in the meantime, nothing is booked.</T>
      {byVenue.map(([vid, vname]) => (
        <Section key={vid} title={vname} color={c.cyan}>
          {items.map((i, idx) => (i.venue_id === vid ? (
            <Card key={i.key} color={problem(idx) ? c.orangeSoft : c.paper}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <T weight="700">{i.resource_name}{i.quantity > 1 ? ` × ${i.quantity}` : ''}</T>
                  <T size={13} color={c.mute}>{dateTimeIn(i.starts_at, i.timezone)} → {timeIn(i.ends_at, i.timezone)}</T>
                  {problem(idx) ? <T size={12} color={c.red} weight="700" style={{ marginTop: 4 }}>{problem(idx).message}</T> : null}
                </View>
                <T weight="700">{moneyIn(quote?.lines?.find((l) => l.resource_id === i.resource_id && l.starts_at === i.starts_at)?.price_cents ?? i.est_cents, i.currency)}</T>
                <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => remove(i.key)} />
              </View>
            </Card>
          ) : null))}
        </Section>
      ))}
      <Section title="Promo code" color={c.sun}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}><Field value={code} onChangeText={setCode} placeholder="Have a code?" /></View>
          <Btn small title="Apply" color={c.violet} onPress={() => { if (code.trim()) { setCodes([...new Set([...codes, code.trim()])]); setCode(''); } }} />
        </View>
        {codes.length ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{codes.map((x) => <Chip key={x} label={`${x} ✕`} active onPress={() => setCodes(codes.filter((y) => y !== x))} />)}</View> : null}
        {quote?.unapplied_codes?.length ? <T size={12} color={c.mute}>Not applied (a better offer is already used, or the code's conditions aren't met): {quote.unapplied_codes.join(', ')}</T> : null}
      </Section>
      <Card style={{ marginTop: 20 }}>
        {!quote ? <Loading /> : quote.error ? <T color={c.red} weight="700">{quote.error}</T> : (
          <>
            {currencies.length > 1 ? <T size={12} color={c.mute} style={{ marginBottom: 6 }}>Venues in {currencies.join(' and ')} — you'll get one invoice per venue, each in its own currency.</T> : null}
            {(quote.totals ?? []).map((t) => (
              <View key={t.currency}>
                {currencies.length > 1 ? <T weight="700" size={12} color={c.mute} style={{ marginTop: 6 }}>{t.currency}</T> : null}
                <Line k="Subtotal" v={moneyIn(t.subtotal_cents, t.currency)} />
                {t.discount_cents ? <Line k="Discount" v={`− ${moneyIn(t.discount_cents, t.currency)}`} /> : null}
                {t.tax_cents ? <Line k={quote.invoices?.find((i) => i.currency === t.currency)?.tax_inclusive === false ? 'Tax (added)' : 'Includes tax'} v={moneyIn(t.tax_cents, t.currency)} /> : null}
                <Line k="To pay" v={moneyIn(t.payable_cents, t.currency)} strong />
              </View>
            ))}
            {quote.pay_within_minutes ? <T size={12} color={c.orange} weight="700" style={{ marginTop: 8 }}>This venue needs payment up front — pay within {quote.pay_within_minutes} minutes or the slots are released.</T> : <T size={12} color={c.mute} style={{ marginTop: 8 }}>Pay online or at the venue, depending on the venue.</T>}
            {quote.problems?.filter((p) => p.index === undefined).map((p, k) => <T key={k} color={c.red} weight="700" size={13}>{p.message}</T>)}
          </>
        )}
      </Card>
      <Btn title={quote?.ok ? `Confirm booking · ${(quote.totals ?? []).map((t) => moneyIn(t.payable_cents, t.currency)).join(' + ')}` : 'Fix the highlighted slots to continue'} disabled={!quote?.ok} loading={busy} onPress={confirm} style={{ marginTop: 14 }} />
      <Btn small title="Empty basket" color={c.paper} onPress={clear} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
    </Screen>
  );
}

// ------------------------------------------------------------------ reservation detail
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, '');
const icsText = (t) => String(t).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
/** An .ics calendar file with one event per active slot (opens in Apple/Google/Outlook calendars). */
export function icsFor(r) {
  const ev = r.bookings.filter((b) => b.status === 'confirmed').map((b) => ['BEGIN:VEVENT', `UID:${b.id}@sportarena`, `DTSTAMP:${icsTime(new Date().toISOString())}`, `DTSTART:${icsTime(b.starts_at)}`, `DTEND:${icsTime(b.ends_at)}`, `SUMMARY:${icsText(`${b.resource_name} · ${b.venue_name}`)}`, `LOCATION:${icsText(b.venue_name)}`, `DESCRIPTION:${icsText(`SportArena booking ${r.code}`)}`, 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SportArena//Booking//EN', ...ev, 'END:VCALENDAR'].join('\r\n');
}
function addToCalendar(r, toast) {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([icsFor(r)], { type: 'text/calendar' }));
    const a = document.createElement('a'); a.href = url; a.download = `booking-${r.code}.ics`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else Share.share({ message: r.bookings.filter((b) => b.status === 'confirmed').map((b) => `${b.resource_name} · ${b.venue_name}: ${dateTimeIn(b.starts_at, b.timezone)}`).join('\n') + `\nBooking ${r.code}` }).catch(() => toast('Could not share'));
}

export function Invoice({ id }) {
  const inv = useLoad(() => api.get(`/invoices/${id}`), [id]);
  const { toast } = useSession();
  const [report, setReport] = useState(false);
  if (inv.loading && !inv.data) return <Screen><Loading /></Screen>;
  if (inv.error) return <Screen><ErrorBox error={inv.error} onRetry={inv.reload} /></Screen>;
  const d = inv.data;
  const money = (n) => moneyIn(n, d.currency);
  const credit = d.kind === 'credit_note';
  return (
    <Screen>
      <Card style={{ marginTop: 8 }} pad={20}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}><T weight="700" size={22}>{credit ? 'CREDIT NOTE' : d.status === 'paid' ? 'RECEIPT / TAX INVOICE' : 'TAX INVOICE'}</T><T color={c.mute}>{d.number}</T></View>
          <Tag label={credit ? (d.refund_status ?? 'issued') : d.status} color={d.status === 'paid' ? c.mint : d.status === 'void' ? c.violetSoft : c.sun} />
        </View>
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 200 }}><T size={11} color={c.mute} weight="700">FROM</T><T weight="700">{d.seller.name}</T>{d.seller.address ? <T size={13}>{d.seller.address}</T> : null}{d.seller.tax_id ? <T size={13}>{d.tax_name} ID: {d.seller.tax_id}</T> : null}{d.seller.phone ? <T size={13}>{d.seller.phone}</T> : null}</View>
          <View style={{ flex: 1, minWidth: 200 }}><T size={11} color={c.mute} weight="700">BILLED TO</T><T weight="700">{d.buyer?.name}</T>{d.buyer?.address ? <T size={13}>{d.buyer.address}</T> : null}{d.buyer?.tax_id ? <T size={13}>Tax ID: {d.buyer.tax_id}</T> : null}</View>
        </View>
        <T size={12} color={c.mute} style={{ marginTop: 10 }}>Issued {new Date(d.issued_at).toLocaleDateString(locale)} · Booking {d.reservation_code} · {d.venue_name} · {d.currency}{d.paid_at && !credit ? ` · Paid ${new Date(d.paid_at).toLocaleDateString(locale)}${d.payment_method ? ` (${d.payment_method})` : ''}` : ''}</T>
        <View style={{ marginTop: 14, borderTopWidth: 1, borderColor: c.line }}>
          {d.lines.map((l, k) => (
            <View key={k} style={{ flexDirection: 'row', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
              <View style={{ flex: 1 }}><T weight="600">{l.description}</T>{l.starts_at ? <T size={12} color={c.mute}>{new Date(l.starts_at).toLocaleString(locale)} · {l.slots} slot{l.slots === 1 ? '' : 's'}{l.discount_cents ? ` · discount ${money(l.discount_cents)}` : ''}</T> : null}</View>
              <T weight="700">{money(l.amount_cents)}</T>
            </View>
          ))}
        </View>
        <View style={{ marginTop: 10 }}>
          {d.credits_cents > 0 && d.status === 'open' ? <Line k="Paid from wallet" v={`− ${money(d.credits_cents)}`} /> : null}
          {d.tax_rate_bp ? <Line k={`${d.tax_name} ${d.tax_rate_bp / 100}% ${d.tax_inclusive ? '(included)' : ''}`} v={money(d.tax_cents)} /> : null}
          <Line k={credit ? 'Total credited' : d.status === 'paid' ? 'Total paid' : 'Total due'} v={`${credit ? '−' : ''}${money(d.total_cents)}`} strong />
        </View>
      </Card>
      {d.credit_notes?.length ? <Section title="Credit notes" color={c.sun}>{d.credit_notes.map((n) => <Row key={n.id} title={n.number} sub={n.refund_status} right={<T weight="700">−{money(n.total_cents)}</T>} />)}</Section> : null}
      {Platform.OS === 'web' ? <Btn title="Print / save as PDF" color={c.violet} onPress={() => window.print()} style={{ marginTop: 14 }} /> : <Btn title="Share" color={c.violet} onPress={() => toast('Open this on the web app to print or save as PDF')} style={{ marginTop: 14 }} />}
      {!credit ? <Btn small title="Dispute this invoice" color={c.paper} ink={c.ink} onPress={() => setReport(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} /> : null}
      <NewCaseSheet visible={report} onClose={() => setReport(false)} kind="dispute" links={[{ type: 'invoice', id }]} />
    </Screen>
  );
}

export function Reservation({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const r = useLoad(() => api.get(`/reservations/${id}`), [id]);
  const [report, setReport] = useState(false);
  const [moving, setMoving] = useState(null);
  const [cancelAll, setCancelAll] = useState(false);
  const [paying, setPaying] = useState(null);
  const [useWallet, setUseWallet] = useState(null);
  const [usePoints, setUsePoints] = useState(null);
  const [usePass, setUsePass] = useState(null);
  const myPlans = useLoad(() => api.get('/me/plans'), []);
  const rewards = useLoad(() => api.get('/me/loyalty'), []);
  if (r.loading && !r.data) return <Screen><Loading /></Screen>;
  if (r.error) return <Screen><ErrorBox error={r.error} onRetry={r.reload} /></Screen>;
  const x = r.data;
  const active = x.bookings.filter((b) => b.status === 'confirmed');
  const cancelLine = async (b) => {
    try { const out = await api.del(`/bookings/${b.id}`); toast(out.refund_cents ? `Cancelled — refund due ${moneyIn(out.refund_cents, b.currency)}` : 'Cancelled — no refund under the venue policy'); r.reload(); } catch (e) { toast(e.message); }
  };
  return (
    <Screen>
      <Card style={{ marginTop: 8 }} pad={18}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View><T size={11} weight="700" color={c.mute} style={{ letterSpacing: 1.2 }}>BOOKING CODE</T><T size={30} weight="800" style={{ letterSpacing: 3 }}>{x.code}</T></View>
          <Tag label={x.awaiting_payment ? 'awaiting payment' : x.status} color={x.awaiting_payment ? c.orange : x.status === 'confirmed' ? c.mint : c.red} />
        </View>
        <T size={13} color={c.mute} style={{ marginTop: 6 }}>Show this code at the venue. {active[0] ? `Next: ${dateTimeIn(active[0].starts_at, active[0].timezone)}` : ''}</T>
        {active.length ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}><Btn small title="📅 Add to calendar" color={c.violet} onPress={() => addToCalendar(x, toast)} /><Btn small title={`Open ${active[0].venue_name}`} color={c.paper} onPress={() => push('Venue', { id: active[0].venue_id })} /></View> : null}
      </Card>
      <Section title="Your slots" color={c.lime}>
        {x.bookings.map((b) => (
          <Card key={b.id} color={b.status === 'confirmed' ? c.paper : c.violetSoft}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Bubble emoji={KIND[b.kind] ?? '📍'} color={c.limeSoft} />
              <View style={{ flex: 1 }}>
                <T weight="700">{b.resource_name}{b.quantity > 1 ? ` × ${b.quantity}` : ''} · {b.venue_name}</T>
                <T size={13} color={c.mute}>{dateTimeIn(b.starts_at, b.timezone)} → {timeIn(b.ends_at, b.timezone)}</T>
                <T size={12} color={c.mute}>{b.slots} slot{b.slots === 1 ? '' : 's'}{b.discount_cents ? ` · saved ${moneyIn(b.discount_cents, b.currency)}` : ''}{b.status === 'cancelled' && b.refund_cents ? ` · refund ${moneyIn(b.refund_cents, b.currency)}` : ''}</T>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="700">{moneyIn(b.price_cents, b.currency)}</T><Tag label={b.status.replace('_', ' ')} color={b.status === 'confirmed' ? c.mint : c.red} /></View>
            </View>
            {b.status === 'confirmed' ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Btn small title="Change time" color={c.violet} onPress={() => setMoving(b)} />
                <Btn small title="Cancel this slot" color={c.paper} ink={c.red} onPress={() => cancelLine(b)} />
              </View>
            ) : null}
          </Card>
        ))}
      </Section>
      {x.awaiting_payment ? <Card color={c.orangeSoft} style={{ marginTop: 14 }}><T weight="700" color={c.orange}>⏱ Pay by {new Date(x.payment_deadline).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })} or these slots are released.</T></Card> : null}
      <Section title="Invoices & payment" color={c.sun}>
        {x.invoices.map((inv) => (
          <Card key={inv.id} color={inv.status === 'void' ? c.violetSoft : c.paper}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <T weight="700">{inv.kind === 'credit_note' ? 'Credit note' : 'Invoice'} {inv.number}</T>
                <T size={13} color={c.mute}>{inv.venue_name}{inv.tax_cents ? ` · ${inv.tax_inclusive ? 'includes' : 'plus'} ${moneyIn(inv.tax_cents, inv.currency)} tax` : ''}</T>
                {inv.kind === 'credit_note' ? <T size={12} color={c.mute}>{{ pending: 'Refund on its way to your card', done: 'Refunded', manual: 'The venue returns this to you', failed: 'Refund needs attention — contact the venue' }[inv.refund_status] ?? ''}</T> : null}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <T weight="700">{inv.kind === 'credit_note' ? '−' : ''}{moneyIn(inv.total_cents, inv.currency)}</T>
                {inv.credits_cents > 0 && inv.status === 'open' ? <T size={11} color={c.lime} weight="700">credit −{moneyIn(inv.credits_cents, inv.currency)} · due {moneyIn(inv.total_cents - inv.credits_cents, inv.currency)}</T> : null}
                <Tag label={inv.kind === 'credit_note' ? 'credited' : inv.status} color={inv.status === 'paid' ? c.mint : inv.status === 'void' ? c.violetSoft : c.sun} />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {inv.kind === 'invoice' && inv.status === 'open' ? <Btn small title="👛 Use wallet" color={c.violet} onPress={() => setUseWallet(inv)} /> : null}
              {inv.kind === 'invoice' && inv.status === 'open' && myPlans.data?.some((p) => p.kind === 'pass' && p.status === 'active' && p.sessions_left > 0 && p.venue_id === inv.venue_id) ? <Btn small title="🎟️ Use pass" color={c.violet} onPress={() => setUsePass(inv)} /> : null}
              {inv.kind === 'invoice' && inv.status === 'open' && rewards.data?.some((p) => p.venue_id === inv.venue_id) ? <Btn small title="⭐ Use points" color={c.violet} onPress={() => setUsePoints(inv)} /> : null}
              {inv.kind === 'invoice' && inv.status === 'open' && inv.payment_mode !== 'pay_at_venue' ? <Btn small title={`Pay ${moneyIn(inv.total_cents - (inv.credits_cents ?? 0), inv.currency)} online`} onPress={() => setPaying(inv)} /> : null}
              {inv.kind === 'invoice' && inv.status === 'open' && inv.payment_mode !== 'online_required' ? <T size={12} color={c.mute} style={{ alignSelf: 'center' }}>or pay at the venue</T> : null}
              <Btn small title="View invoice" color={c.paper} onPress={() => push('Invoice', { id: inv.id })} />
            </View>
          </Card>
        ))}
        {x.totals.length > 1 ? <T size={12} color={c.mute}>This booking spans venues that charge in different currencies, so it has separate totals and invoices.</T> : null}
      </Section>
      {active.length ? <Btn title="Cancel the whole booking" color={c.paper} ink={c.red} onPress={() => setCancelAll(true)} style={{ marginTop: 14 }} /> : null}
      {active.length ? <Btn small title={`Add more at ${active[0].venue_name}`} color={c.paper} onPress={() => push('Venue', { id: active[0].venue_id })} style={{ marginTop: 10, alignSelf: 'flex-start' }} /> : null}

      {usePass ? <PassApplySheet invoice={usePass} onClose={() => setUsePass(null)} onDone={r.reload} /> : null}
      {usePoints ? <PointsApplySheet invoice={usePoints} onClose={() => setUsePoints(null)} onDone={r.reload} /> : null}
      {useWallet ? <WalletApplySheet invoice={useWallet} onClose={() => setUseWallet(null)} onDone={r.reload} /> : null}
      {paying ? <PaySheet target={{ id: paying.id, label: `${paying.venue_name} · ${paying.number}`, amount: paying.total_cents - (paying.credits_cents ?? 0), currency: paying.currency }} onClose={() => setPaying(null)} onDone={r.reload} /> : null}
      <MoveSheet booking={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); r.reload(); }} />
      <FormSheet visible={cancelAll} onClose={() => setCancelAll(false)} title="Cancel the whole booking?" submitLabel="Yes, cancel everything" color={c.red}
        fields={[{ key: 'reason', label: 'Reason', optional: true }]}
        onSubmit={async (v) => { const out = await api.del(`/reservations/${id}`, v); r.reload(); return out.refund_cents ? `Cancelled — refund due ${moneyIn(out.refund_cents, x.currency)}` : 'Cancelled'; }} />
      <Btn small title="Report a problem with this booking" color={c.paper} ink={c.ink} onPress={() => setReport(true)} style={{ marginTop: 14, alignSelf: 'flex-start' }} />
      <NewCaseSheet visible={report} onClose={() => setReport(false)} kind="dispute" links={[{ type: 'reservation', id }]} />
    </Screen>
  );
}

/** Pick a new day / start / length for one booking line, using the live slot grid so only free times show. */
function MoveSheet({ booking, onClose, onDone }) {
  const { toast } = useSession();
  const [dayIdx, setDayIdx] = useState(0);
  const tz = booking?.timezone ?? 'UTC';
  const date = booking ? addDays(todayIn(tz), dayIdx) : null;
  const grid = useLoad(() => (booking ? api.get(`/venues/${booking.venue_id}/availability`, { date, resource_id: booking.resource_id }) : Promise.resolve(null)), [booking?.id, date]);
  const slots = grid.data?.resources?.[0]?.slots ?? [];
  const len = booking ? new Date(booking.ends_at) - new Date(booking.starts_at) : 0;
  const mine = (s) => booking && s.starts_at < booking.ends_at && s.ends_at > booking.starts_at;
  const move = async (s) => {
    try { await api.patch(`/bookings/${booking.id}`, { starts_at: s.starts_at, ends_at: new Date(new Date(s.starts_at).getTime() + len).toISOString() }); toast('Booking moved'); onDone(); } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible={!!booking} onClose={onClose} title="Change time">
      <T color={c.mute} size={13}>Same length ({Math.round(len / 60000)} min). Tap a start time — it's re-checked and repriced.</T>
      <Seg options={Array.from({ length: 14 }, (_, i) => ({ value: i, label: dayLabel(addDays(todayIn(tz), i), i) }))} value={dayIdx} onChange={setDayIdx} color={c.pink} />
      {grid.loading ? <Loading /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {slots.filter((s) => s.status === 'free' || mine(s)).map((s) => <Chip key={s.starts_at} label={timeIn(s.starts_at, tz)} active={mine(s)} onPress={() => move(s)} />)}
          {!slots.length ? <T color={c.mute}>Closed that day.</T> : null}
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ compare
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6);
const MAX_DAYS = 7;
const rangeDays = (from, to) => Array.from({ length: Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 864e5) + 1 }, (_, i) => addDays(from, i));
const dayText = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
// nulls always sort last, whichever way the key runs
const byKey = (key, dir = 1) => (a, b) => { const [x, y] = [key(a), key(b)]; return x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : dir * (x - y); };
const SORTS = [
  { value: 'default', label: 'As selected' },
  { value: 'rating', label: '⭐ Top rated', cmp: (w) => (a, b) => byKey((x) => x.rating, -1)(a, b) || byKey((x) => x.reviews, -1)(a, b) },
  { value: 'reviews', label: '💬 Most reviews', cmp: () => byKey((x) => x.reviews, -1) },
  { value: 'distance', label: '📍 Nearby', cmp: () => byKey((x) => x.distance_km) },
  { value: 'price', label: '💰 Cheapest', cmp: (w) => byKey((x) => (w ? x.window?.cheapest_price_cents : x.pricing?.from_hourly_cents)) },
  { value: 'open', label: '✅ Most open', cmp: (w) => (w ? byKey((x) => x.window?.bookable_areas, -1) : byKey((x) => x.totals.areas, -1)) },
];

export function Compare({ ids }) {
  const { push } = useNav();
  const { add, toggleCompare } = useBasket();
  const { toast } = useSession();
  const [range, setRange] = useState(null); // { from, to } — null until the first pick, then defaults to tomorrow
  const [pickOpen, setPickOpen] = useState(false);
  const [month, setMonth] = useState(null);
  const [hour, setHour] = useState(18);
  const [dur, setDur] = useState(1);
  const [useWindow, setUseWindow] = useState(true);
  const [sort, setSort] = useState('default');
  const [near, setNear] = useState(null);
  const [locMsg, setLocMsg] = useState(null);
  const [viewDay, setViewDay] = useState(null);
  // the first venue's zone anchors the window; venues in other zones will simply show "closed"
  const first = useLoad(() => api.get(`/venues/${ids[0]}`), []);
  const vtz = first.data?.timezone ?? 'UTC';
  const today = todayIn(vtz);
  const tomorrow = addDays(today, 1);
  const from_d = range?.from ?? tomorrow;
  const to_d = range?.to ?? from_d;
  const days = rangeDays(from_d, to_d);
  const date = days.includes(viewDay) ? viewDay : from_d;
  const win = (d) => { const f = localToIso(d, `${String(hour).padStart(2, '0')}:00`, vtz); return { from: f, to: new Date(new Date(f).getTime() + dur * 3600e3).toISOString() }; };
  const { from, to } = win(date);
  const loc = near ? { lat: near.lat, lng: near.lng } : {};
  const cmp = useLoad(() => (first.data ? api.get('/venue-comparison', { ids: ids.join(','), ...loc, ...(useWindow ? { from, to } : {}) }) : Promise.resolve(null)), [ids.join(','), first.data?.id, useWindow, from, to, near]);
  // the same hour on every other day in the range, to say "free on 3 of 5 days"
  const others = useLoad(() => (first.data && useWindow && days.length > 1 ? Promise.all(days.filter((d) => d !== date).map((d) => api.get('/venue-comparison', { ids: ids.join(','), ...win(d) }).then((r) => [d, r]))) : Promise.resolve(null)), [ids.join(','), first.data?.id, useWindow, from_d, to_d, hour, dur, date]);
  const freeDays = (id) => {
    if (!cmp.data || !useWindow || days.length < 2) return null;
    const mine = cmp.data.venues.find((x) => x.venue.id === id)?.window?.bookable_areas ? 1 : 0;
    const more = (others.data ?? []).filter(([, r]) => r.venues.find((x) => x.venue.id === id)?.window?.bookable_areas).length;
    return others.data ? mine + more : null;
  };

  const pick = (d) => setRange((r) => (!r || !r.from || r.to || d < r.from ? { from: d, to: null } : { from: r.from, to: d }));
  const locate = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setLocMsg('Location is not available here.'); return; }
    navigator.geolocation.getCurrentPosition((p) => { setNear({ lat: p.coords.latitude, lng: p.coords.longitude }); setLocMsg(null); setSort('distance'); }, () => setLocMsg('Could not get your location.'), { timeout: 10000 });
  };
  const chooseSort = (v) => { if (v === 'distance' && !near) locate(); else setSort(v); };

  const best = cmp.data?.highlights ?? {};
  const badges = (id) => [id === best.cheapest_venue_id && '💰 Cheapest', id === best.nearest_venue_id && '📍 Nearest', id === best.top_rated_venue_id && '⭐ Top rated', id === best.most_available_venue_id && '✅ Most open', id === best.earliest_free_venue_id && '⏱️ Earliest free'].filter(Boolean);
  const sorter = SORTS.find((x) => x.value === sort)?.cmp;
  const columns = cmp.data ? (sorter ? [...cmp.data.venues].sort(sorter(useWindow)) : cmp.data.venues) : [];
  const picking = range && !range.to;
  return (
    <Screen wide>
      <H1 style={{ marginTop: 8 }}>Compare venues</H1>
      <Section title="When do you want to play?" color={c.sun}>
        <Seg options={[{ value: true, label: 'Pick a time' }, { value: false, label: 'Just compare' }]} value={useWindow} onChange={setUseWindow} color={c.violet} />
        {useWindow ? (
          <>
            <Pressable onPress={() => { setMonth(from_d.slice(0, 7)); setPickOpen(true); }} accessibilityLabel="Choose dates" style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, flexDirection: 'row', alignItems: 'center' }}>
              <T style={{ flex: 1 }} weight="600">{from_d === to_d ? dayText(from_d) : `${dayText(from_d)}  →  ${dayText(to_d)}`}{days.length > 1 ? `  ·  ${days.length} days` : ''}</T>
              <T size={18}>📅</T>
            </Pressable>
            {days.length > 1 ? <Seg options={days.map((d) => ({ value: d, label: dayLabel(d, d === today ? 0 : d === tomorrow ? 1 : 2) }))} value={date} onChange={setViewDay} color={c.pink} /> : null}
            <Seg options={HOURS.map((h) => ({ value: h, label: `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}` }))} value={hour} onChange={setHour} color={c.violet} />
            <Seg options={[1, 2, 3].map((d) => ({ value: d, label: `${d}h` }))} value={dur} onChange={setDur} color={c.cyan} />
          </>
        ) : null}
      </Section>
      <Section title="Rank by" color={c.violet}>
        <Seg options={SORTS.map(({ value, label }) => ({ value, label }))} value={sort} onChange={chooseSort} color={c.ink} />
        {locMsg ? <T size={12} color={c.mute}>{locMsg}</T> : near ? <T size={12} color={c.mute}>Distances are from your current location.</T> : <T size={12} color={c.mute}>Tap “Nearby” to rank by distance from where you are.</T>}
      </Section>
      <Sheet visible={pickOpen} onClose={() => setPickOpen(false)} title="Choose dates">
        <Calendar month={month ?? from_d.slice(0, 7)} onMonth={setMonth} range={range ? { from: range.from, to: range.to } : { from: from_d, to: to_d }} today={today}
          minDate={today} maxDate={picking ? addDays(range.from, MAX_DAYS - 1) : addDays(today, 90)} onChange={pick} />
        <T size={12} color={c.mute}>{picking ? 'Now tap the last day (up to 7 days).' : 'Tap a day to start, then tap another to make a range. Tap once for a single day.'}</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn small title="Done" color={c.violet} onPress={() => { if (picking) setRange({ from: range.from, to: range.from }); setViewDay(null); setPickOpen(false); }} />
          <Btn small title="Tomorrow" color={c.paper} onPress={() => { setRange({ from: tomorrow, to: tomorrow }); setViewDay(null); setPickOpen(false); }} />
        </View>
      </Sheet>
      {cmp.loading && !cmp.data ? <Loading /> : cmp.error ? <ErrorBox error={cmp.error} onRetry={cmp.reload} /> : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 14 }}>
          {columns.map((col, rank) => {
            const v = col.venue;
            return (
              <Card key={v.id} style={{ width: 290 }}>
                {sort !== 'default' ? <T size={12} weight="700" color={c.mute}>#{rank + 1}</T> : null}
                <T size={36}>{v.emoji}</T>
                <H2>{v.name}</H2>
                <T size={13} color={c.mute}>{[v.city, col.distance_km != null && `${col.distance_km} km`].filter(Boolean).join(' · ')}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 }}>{badges(v.id).map((b) => <Tag key={b} label={b} color={c.sun} />)}</View>
                <Line k="Rating" v={col.rating ? `⭐ ${col.rating} (${col.reviews})` : 'No reviews'} />
                <Line k="Areas" v={`${col.totals.areas} · fits ${col.totals.players || '—'} players`} />
                <Line k="Price / hour" v={col.pricing ? (col.pricing.from_hourly_cents === col.pricing.to_hourly_cents ? moneyIn(col.pricing.from_hourly_cents, v.currency) : `${moneyIn(col.pricing.from_hourly_cents, v.currency)} – ${moneyIn(col.pricing.to_hourly_cents, v.currency)}`) : '—'} />
                <Line k="Hours" v={hoursSummary(col.hours)} />
                <Line k="Free cancel" v={`${col.policy.cancel_free_hours}h before`} />
                {v.amenities?.length ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{v.amenities.join(' · ')}</T> : null}
                {col.offers.map((o) => <T key={o.id} size={12} color={c.lime} weight="700" style={{ marginTop: 4 }}>🏷️ {offerLabel(o, v.currency)}</T>)}
                {col.window ? (
                  <View style={{ marginTop: 10, gap: 6 }}>
                    <T weight="700">{col.window.bookable_areas ? `${col.window.bookable_areas} free at your time` : 'Nothing free at your time'}</T>
                    {freeDays(v.id) != null ? <T size={12} color={c.mute}>Free on {freeDays(v.id)} of {days.length} days in your range</T> : null}
                    {col.window.areas.map((a) => (
                      <View key={a.resource_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <T size={13} style={{ flex: 1 }} color={a.bookable ? c.ink : c.mute}>{a.name}{a.bookable ? '' : ` · ${a.reason}`}</T>
                        {a.bookable ? <><T size={13} weight="700">{moneyIn(a.estimated_price_cents, v.currency)}</T>
                          <Btn small title="Add" color={c.violet} onPress={() => { add([{ key: `${a.resource_id}|${from}|${to}`, resource_id: a.resource_id, resource_name: a.name, venue_id: v.id, venue_name: v.name, timezone: v.timezone, currency: v.currency, starts_at: from, ends_at: to, quantity: 1, est_cents: a.estimated_price_cents }]); toast(`${a.name} added`); }} /></> : null}
                      </View>
                    ))}
                  </View>
                ) : null}
                {col.next_free ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Next free: {col.next_free.resource_name}, {dateTimeIn(col.next_free.starts_at, v.timezone)}</T> : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <Btn small title="Open" onPress={() => push('Venue', { id: v.id })} />
                  {v.map_links ? <Btn small title="Map" color={c.paper} onPress={() => open(v.map_links.google)} /> : null}
                </View>
              </Card>
            );
          })}
        </ScrollView>
      )}
      <Btn title="Go to basket" color={c.pink} onPress={() => push('Basket')} />
      <T size={12} color={c.mute} style={{ marginTop: 8 }}>Add a court from each venue to book them together — one booking, one total.</T>
    </Screen>
  );
}

// ------------------------------------------------------------------ notifications
/** Turn push on or off for this phone / browser, see the devices that get push, send a test. */
function PushCard({ prefs }) {
  const { toast } = useSession();
  const sup = useLoad(() => pushSupport(), []);
  const devices = useLoad(() => api.get('/me/push-devices'), []);
  const [mine, setMine] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { currentDevice().then(setMine); }, [devices.data]);
  const here = devices.data?.some((d) => d.id === mine);
  const toggle = async () => {
    setBusy(true);
    try { if (here) { await disablePush(mine); setMine(null); toast('Push turned off on this device'); } else { await enablePush(); toast('Push is on for this device 🔔'); } devices.reload(); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <T weight="700">Push notifications</T>
      <T size={13} color={c.mute} style={{ marginTop: 2 }}>Booking confirmations, changes, reminders and freed-up slots, straight to this device.</T>
      {sup.data && !sup.data.ok ? <T size={13} color={c.mute} style={{ marginTop: 8 }}>{sup.data.reason}</T> : (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <Btn small title={here ? 'Turn off on this device' : 'Turn on for this device'} color={here ? c.paper : c.pink} onPress={toggle} loading={busy} />
          {devices.data?.length ? <Btn small title="Send a test" color={c.paper} onPress={async () => { try { await api.post('/me/push-test'); toast('Test sent'); } catch (e) { toast(e.message); } }} /> : null}
        </View>
      )}
      {devices.data?.length ? <View style={{ marginTop: 10 }}>{devices.data.map((d) => (
        <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
          <T size={13}>{d.platform === 'web' ? '🌐' : d.platform === 'ios' ? '📱' : '🤖'} {d.label ?? d.platform}{d.id === mine ? ' · this device' : ''}</T>
          <Btn small title="Remove" color={c.paper} ink={c.red} onPress={async () => { await api.del(`/me/push-devices/${d.id}`).catch(() => {}); devices.reload(); }} />
        </View>
      ))}</View> : null}
    </Card>
  );
}

/** Your active "tell me when a slot opens" alerts. */
function AlertsList() {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/slot-alerts'), []);
  if (!list.data?.length) return <T size={13} color={c.mute}>No alerts. Open a venue and tap 🔔 Alert me to be told when a slot frees up.</T>;
  return list.data.map((a) => (
    <Card key={a.id} pad={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T weight="700">{a.venue_name}{a.resource_name ? ` · ${a.resource_name}` : ''}</T>
          <T size={12} color={c.mute}>{String(a.date_from).slice(0, 10)}{a.date_to !== a.date_from ? ` → ${String(a.date_to).slice(0, 10)}` : ''}{a.from_min != null ? ` · from ${fmtMin(a.from_min)}` : ''}{a.to_min != null ? ` until ${fmtMin(a.to_min)}` : ''}{a.slots > 1 ? ` · ${a.slots} slots` : ''}</T>
        </View>
        <Btn small title="Stop" color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/slot-alerts/${a.id}`); list.reload(); } catch (e) { toast(e.message); } }} />
      </View>
    </Card>
  ));
}

/** Slots you are queueing for, and offers waiting for you to claim. */
function WaitlistList() {
  const { toast } = useSession();
  const { push } = useNav();
  const list = useLoad(() => api.get('/me/waitlist'), []);
  if (!list.data?.length) return <T size={13} color={c.mute}>Nothing on your waitlist. Tap a sold-out slot while booking to queue for it.</T>;
  return list.data.map((w) => (
    <Card key={w.id} pad={12} color={w.status === 'offered' ? c.limeSoft : c.paper}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T weight="700">{w.venue_name} · {w.resource_name}</T>
          <T size={12} color={c.mute}>{dateTimeIn(w.starts_at, w.timezone)} → {timeIn(w.ends_at, w.timezone)}{w.quantity > 1 ? ` · × ${w.quantity}` : ''}</T>
          <T size={12} weight="700" color={w.status === 'offered' ? c.lime : c.mute}>{w.status === 'offered' ? `Yours until ${timeIn(w.offer_expires_at, w.timezone)} — book it now!` : `You're #${w.position} in line`}</T>
        </View>
        <View style={{ gap: 6 }}>
          {w.status === 'offered' ? <Btn small title="Book now" onPress={() => push('BookFlow', { venueId: w.venue_id, resourceId: w.resource_id, date: localDate(w.starts_at, w.timezone) })} /> : null}
          <Btn small title={w.status === 'offered' ? 'Give up' : 'Leave'} color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/waitlist/${w.id}`); list.reload(); } catch (e) { toast(e.message); } }} />
        </View>
      </View>
    </Card>
  ));
}

export function Notifications() {
  const { toast } = useSession();
  const { push } = useNav();
  const list = useLoad(() => api.get('/notifications', { limit: 50 }), []);
  const prefs = useLoad(() => api.get('/me/notification-preferences'), []);
  const setPref = async (patch) => { try { await api.patch('/me/notification-preferences', patch); prefs.reload(); } catch (e) { toast(e.message); } };
  const readAll = async () => { await api.post('/notifications/read', {}); list.reload(); };
  const tap = async (n) => {
    if (!n.read_at) { await api.post('/notifications/read', { ids: [n.id] }); list.reload(); }
    if (n.data?.reservation_id) push('Reservation', { id: n.data.reservation_id });
  };
  const p = prefs.data;
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Notifications</H1>
      <Section title="How you hear from us" color={c.cyan}>
        {p ? (
          <Card>
            <Line k="In the app" v="" />
            <Seg options={[{ value: true, label: 'On' }, { value: false, label: 'Off' }]} value={p.in_app} onChange={(v) => setPref({ in_app: v })} color={c.pink} />
            <Line k="Email" v="" />
            <Seg options={[{ value: true, label: 'On' }, { value: false, label: 'Off' }]} value={p.email} onChange={(v) => setPref({ email: v })} color={c.pink} />
            <Line k="Push" v="" />
            <Seg options={[{ value: true, label: 'On' }, { value: false, label: 'Off' }]} value={p.push !== false} onChange={(v) => setPref({ push: v })} color={c.pink} />
            <Line k="Remind me before a booking" v="" />
            <Seg options={[2, 6, 12, 24, 48].map((h) => ({ value: h, label: `${h}h` }))} value={p.reminder_hours} onChange={(v) => setPref({ reminder_hours: v })} color={c.violet} />
          </Card>
        ) : <Loading />}
      </Section>
      <Section title="Push" color={c.violet}><PushCard /></Section>
      <Section title="Waitlist" color={c.lime}><WaitlistList /></Section>
      <Section title="Slot alerts" color={c.sun}><AlertsList /></Section>
      <Section title="Inbox" action={list.data?.unread ? 'Mark all read' : undefined} onAction={readAll} color={c.pink}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.items.length ? list.data.items.map((n) => (
          <Row key={n.id} onPress={() => tap(n)} color={n.read_at ? c.paper : c.pinkSoft} left={<Bubble emoji={n.kind.includes('cancel') ? '❌' : n.kind.includes('remind') ? '⏰' : n.kind.includes('modif') ? '✏️' : '✅'} />}
            title={n.title} sub={`${n.body} · ${new Date(n.created_at).toLocaleString(locale)}`} />
        )) : <Empty emoji="🔕" title="Nothing yet" sub="Booking confirmations, changes and reminders land here." />}
      </Section>
    </Screen>
  );
}
