// Sports Front Desk & POS — the venue team's till. One screen for phone, tablet and desktop: catalogue on the left, cart on the right once there is room.
// The app only calls the API (docs/front-desk.md): prices, stock, tax, approvals and every money rule are decided on the server.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Section, Seg, Sheet, StatPill, T, Tag } from '../ui';
import { Counter, DateField, TimeField } from '../pickers';
import { EntityPicker } from '../entity-picker';
import { QrCode } from './passport';
import { c } from '../theme';
import { localToIso, moneyIn, timeIn, dateTimeIn, todayIn } from '../vtime';
import { DeskDrawer, DeskRentals, DeskReport, DeskRules, DeskStock } from './front-desk-ops';
import { askApproval, digitsOf, shareText, toMinor, uid, useApproval } from './front-desk-kit';

const EMOJI = { merch: '🏷️', apparel: '👕', equipment: '🏸', nutrition: '🥤', food_beverage: '🥤', medical: '🩹', other: '📦' };
const TENDER = { cash: '💵 Cash', card_terminal: '💳 Card terminal', upi_manual: '📲 UPI (checked on your phone)', bank_manual: '🏦 Bank transfer', other_manual: 'Other' };
const STATUS = { awaiting_payment: ['Awaiting payment', c.sunSoft], paid: ['Paid', c.mintSoft], void: ['Void', c.violetSoft] };
// ------------------------------------------------------------------ the container
const TABS = [['sell', 'Sell'], ['sales', 'Sales'], ['drawer', 'Cash drawer'], ['rentals', 'Rentals']];
const MANAGER_TABS = [['stock', 'Stock & prices'], ['report', 'Report'], ['rules', 'Rules & approvals']];

export function FrontDesk({ v }) {
  const desk = useLoad(() => api.get(`/venues/${v.id}/front-desk`), [v.id]);
  const [tab, setTab] = useState('sell');
  if (desk.loading && !desk.data) return <Loading />;
  if (desk.error) return <ErrorBox error={desk.error} onRetry={desk.reload} />;
  const d = desk.data;
  const tabs = d.role === 'manager' ? [...TABS, ...MANAGER_TABS] : TABS;
  const P = { v, desk: d, reloadDesk: desk.reload };
  return (
    <View style={{ gap: 12, marginTop: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag label={d.shift ? `Drawer open · ${moneyIn(Number(d.shift.expected_cash_cents), v.currency)} expected` : 'Drawer closed'} color={d.shift ? c.mint : c.sun} />
        <Tag label={d.role === 'manager' ? 'Manager' : 'Cashier'} color={c.violetSoft} />
        {!d.shift && !d.rules.require_shift ? <T size={12} color={c.mute}>Cash can be taken without a shift; open the drawer to reconcile it.</T> : null}
      </View>
      <Seg options={tabs.map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.violet} />
      {tab === 'sell' ? <Sell {...P} /> : tab === 'sales' ? <Sales {...P} /> : tab === 'drawer' ? <DeskDrawer {...P} /> : tab === 'rentals' ? <DeskRentals {...P} />
        : tab === 'stock' ? <DeskStock {...P} /> : tab === 'report' ? <DeskReport {...P} /> : <DeskRules {...P} />}
    </View>
  );
}

// ------------------------------------------------------------------ selling
const MODES = [['shop', '🛍️ Shop'], ['rent', '🏸 Rent kit'], ['court', '🎾 Court time'], ['plans', '🎟️ Memberships'], ['collect', '🧾 Collect a fee']];

function Sell({ v, desk, reloadDesk }) {
  const L = useLayout();
  const { toast } = useSession();
  const [mode, setMode] = useState('shop');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState([]);
  const [customer, setCustomer] = useState([]);
  const [guest, setGuest] = useState({ name: '', phone: '' });
  const [promo, setPromo] = useState('');
  const [disc, setDisc] = useState(null);
  const [reason, setReason] = useState('Regular customer');
  const [quote, setQuote] = useState(null);
  const [qerr, setQerr] = useState(null);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState(null);
  const [approval, setApproval] = useState('');
  const [run, approvalSheet] = useApproval();
  const handle = customer[0]?.sub?.replace(/^@/, '');
  const cur = v.currency;

  const body = useMemo(() => ({
    lines: cart.map((l) => l.line),
    ...(handle ? { customer_handle: handle } : guest.name || guest.phone ? { guest_name: guest.name || undefined, guest_phone: guest.phone || undefined } : {}),
    promo_codes: promo.trim() ? [promo.trim()] : [],
    ...(disc ? { discount: { kind: disc.kind, value: disc.value, reason, ...(approval ? { approval_id: approval } : {}) } } : {}),
  }), [cart, handle, guest, promo, disc, reason, approval]);
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!cart.length) { setQuote(null); setQerr(null); return undefined; }
    let live = true;
    const t = setTimeout(async () => {
      try { const r = await api.post(`/venues/${v.id}/pos/quote`, body); if (live) { setQuote(r); setQerr(null); } }
      catch (e) { if (live) { setQuote(null); setQerr(e.message); } }
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (line, label, emoji, price) => setCart((cur0) => {
    const id = line.kind === 'booking' ? uid() : `${line.kind}:${line.item_id ?? line.plan_id ?? line.invoice_id ?? line.charge_id}`;
    const same = cur0.find((x) => x.id === id);
    if (!same) return [...cur0, { id, label, emoji, price, line }];
    if (line.kind === 'item' || line.kind === 'rental') return cur0.map((x) => (x === same ? { ...x, line: { ...x.line, qty: Math.min(500, x.line.qty + 1) } } : x));
    toast('Already in the cart');
    return cur0;
  });
  const setQty = (l, qty) => setCart((x) => x.map((y) => (y === l ? { ...y, line: { ...y.line, qty } } : y)));
  const drop = (l) => setCart((x) => x.filter((y) => y !== l));
  const total = quote?.total_cents;
  const charge = async () => {
    try { if (quote?.needs_approval && !approval) setApproval(await askApproval(run, 'discount')); setPaying(true); } catch { /* backed out */ }
  };

  const catalogue = (
    <View style={{ gap: 10, flex: 1 }}>
      <Seg options={MODES.map(([value, label]) => ({ value, label }))} value={mode} onChange={setMode} color={c.pink} />
      {mode === 'shop' || mode === 'rent' ? (
        <>
          <Field value={q} onChangeText={setQ} placeholder="Search by name or SKU…" accessibilityLabel="Search the catalogue" />
          <Tiles items={(mode === 'shop' ? desk.items : desk.rental_items).filter((i) => !q.trim() || `${i.name} ${i.sku ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))} cur={cur} rent={mode === 'rent'}
            onPick={(i) => (mode === 'rent' ? add({ kind: 'rental', item_id: i.id, qty: 1 }, `Rent · ${i.name}`, EMOJI[i.category] ?? '🏸', Number(i.rental_fee_cents) + Number(i.deposit_cents)) : add({ kind: 'item', item_id: i.id, qty: 1 }, i.name, EMOJI[i.category] ?? '📦', Number(i.sell_price_cents)))} />
        </>
      ) : mode === 'court' ? <CourtPicker v={v} courts={desk.courts} onAdd={(line, label, price) => { add(line, label, '🎾', price); toast('Added — the price is checked by the booking engine'); }} />
        : mode === 'plans' ? (desk.plans.length ? desk.plans.map((p) => (
          <Row key={p.id} onPress={() => (handle ? add({ kind: 'plan', plan_id: p.id }, p.name, '🎟️', Number(p.price_cents)) : toast('Pick the customer first — a membership belongs to a person'))} left={<T size={22}>🎟️</T>} title={p.name}
            sub={p.kind === 'membership' ? `${p.duration_days} days · ${(p.discount_bp ?? 0) / 100}% off every booking` : `${p.sessions} sessions · valid ${p.valid_days} days`} right={<T weight="800">{moneyIn(Number(p.price_cents), cur)}</T>} />
        )) : <Empty emoji="🎟️" title="No memberships or passes" sub="Create them in Passes, packages & memberships." />)
          : <Collect v={v} handle={handle} onAdd={(line, label, price) => add(line, label, '🧾', price)} />}
    </View>
  );

  const cartPane = (
    <View style={{ gap: 10, flex: 1 }}>
      <Card color={c.paper} pad={14}>
        <View style={{ gap: 10 }}>
          <T weight="800" size={16}>Cart</T>
          <EntityPicker kind="person" label="Customer" optional noun="customer" value={customer} onChange={setCustomer} />
          {!handle ? (
            <View style={{ gap: 6 }}>
              <T size={12} color={c.mute}>Walk-in guest — a name and number are optional.</T>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}><Field value={guest.name} onChangeText={(x) => setGuest((g) => ({ ...g, name: x }))} placeholder="Guest name" accessibilityLabel="Guest name" /></View>
                <View style={{ flex: 1 }}><Field value={guest.phone} onChangeText={(x) => setGuest((g) => ({ ...g, phone: x.replace(/[^0-9+ ]/g, '') }))} placeholder="Phone" keyboardType="phone-pad" accessibilityLabel="Guest phone" /></View>
              </View>
            </View>
          ) : null}
          {!cart.length ? <Empty emoji="🛒" title="Nothing yet" sub="Tap an item, a court, a membership or a fee to add it." /> : cart.map((l) => {
            const stocked = l.line.kind === 'item' || l.line.kind === 'rental';
            return (
              <View key={l.id} style={{ gap: 6, borderBottomWidth: 1, borderColor: c.line, paddingBottom: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <T size={20}>{l.emoji}</T>
                  <T weight="700" size={14} style={{ flex: 1 }}>{l.label}</T>
                  <T weight="800" size={14}>{moneyIn(Math.round(l.price * (stocked ? l.line.qty : 1)), cur)}</T>
                  <Btn small title="✕" color={c.paper} ink={c.mute} onPress={() => drop(l)} accessibilityLabel={`Remove ${l.label}`} />
                </View>
                {stocked ? <Counter value={l.line.qty} onChange={(n) => setQty(l, n)} min={1} max={l.line.kind === 'rental' ? 50 : 500} label={l.line.kind === 'rental' ? 'How many (fee + deposit each)' : 'How many'} /> : null}
              </View>
            );
          })}
          {cart.some((l) => l.line.kind === 'booking') && desk.offers.length ? (
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>Offer for the court time</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{desk.offers.map((o) => <Chip key={o.code} label={`🏷️ ${o.name}`} active={promo === o.code} onPress={() => setPromo(promo === o.code ? '' : o.code)} />)}</View>
            </View>
          ) : null}
          {cart.some((l) => ['item', 'rental'].includes(l.line.kind)) ? (
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>Discount</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Chip label="None" active={!disc} onPress={() => setDisc(null)} />
                <Chip label="Percent" active={disc?.kind === 'percent'} onPress={() => setDisc({ kind: 'percent', value: 10 })} />
                <Chip label="Amount" active={disc?.kind === 'fixed'} onPress={() => setDisc({ kind: 'fixed', value: 0 })} />
              </View>
              {disc?.kind === 'percent' ? <Counter value={disc.value} onChange={(n) => setDisc({ kind: 'percent', value: n })} min={1} max={100} step={1} suffix="%" label="Percent off" /> : null}
              {disc?.kind === 'fixed' ? <Field label={`Amount off (${cur})`} value={String(disc.display ?? '')} onChangeText={(x) => setDisc({ kind: 'fixed', display: x.replace(/[^0-9.]/g, ''), value: toMinor(x, cur) ?? 0 })} keyboardType="decimal-pad" accessibilityLabel="Discount amount" /> : null}
              {disc ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['Regular customer', 'Staff', 'Damaged pack', 'Promotion', 'Other'].map((r) => <Chip key={r} label={r} active={reason === r} onPress={() => setReason(r)} />)}</View> : null}
            </View>
          ) : null}
          {cart.length ? (
            <View style={{ gap: 4, paddingTop: 4 }}>
              {qerr ? <T color={c.red} weight="700" size={13}>{qerr}</T> : null}
              {quote?.needs_approval && !approval ? <T size={12} color={c.mute}>This discount is above your limit — you'll be asked for a manager's code when you charge.</T> : null}
              {quote ? (
                <>
                  {Number(quote.discount_cents) ? <Line k="Discount" v={`−${moneyIn(Number(quote.discount_cents), cur)}`} /> : null}
                  {Number(quote.tax_cents) ? <Line k={v.tax_name ?? 'Tax'} v={`${moneyIn(Number(quote.tax_cents), cur)} ${v.tax_inclusive ? 'incl.' : 'added'}`} /> : null}
                  <Line k="Total" v={moneyIn(Number(total), cur)} big />
                </>
              ) : null}
            </View>
          ) : null}
          <Btn title={cart.length ? `Charge ${total != null ? moneyIn(Number(total), cur) : ''}`.trim() : 'Charge'} disabled={!cart.length || !!qerr || total == null} onPress={charge} accessibilityLabel="Charge the customer" />
          {cart.length ? <Btn small title="Clear cart" color={c.paper} ink={c.mute} onPress={() => { setCart([]); setDisc(null); setPromo(''); setApproval(''); }} /> : null}
        </View>
      </Card>
    </View>
  );

  return (
    <View style={{ gap: 12 }}>
      {Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.onLine === false ? <Card color={c.sunSoft} pad={10}><T weight="700" size={13}>Offline — cash sales are kept on this device and sent when you're back online. Keep this window open. Online payments aren't available.</T></Card> : null}
      <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
        <View style={{ flex: L.tablet ? 3 : undefined, width: L.tablet ? undefined : '100%' }}>{catalogue}</View>
        <View style={{ flex: L.tablet ? 2 : undefined, width: L.tablet ? undefined : '100%' }}>{cartPane}</View>
      </View>
      {approvalSheet}
      <DeskPay visible={paying} onClose={() => setPaying(false)} v={v} desk={desk} body={body} total={total} onPaid={(sale) => { setPaying(false); setDone(sale); setCart([]); setDisc(null); setPromo(''); setApproval(''); setCustomer([]); setGuest({ name: '', phone: '' }); reloadDesk(); }} />
      <Sheet visible={!!done} onClose={() => setDone(null)} title="Sale complete ✓">{done ? <DeskReceipt saleId={done.id} onNew={() => setDone(null)} v={v} /> : null}</Sheet>
    </View>
  );
}

const Line = ({ k, v, big }) => <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={big ? 17 : 13} weight={big ? '800' : '600'} color={big ? c.ink : c.mute}>{k}</T><T size={big ? 17 : 13} weight={big ? '800' : '600'}>{v}</T></View>;

function Tiles({ items, cur, rent, onPick }) {
  if (!items.length) return <Empty emoji={rent ? '🏸' : '🛍️'} title={rent ? 'No rental kit' : 'Nothing to sell yet'} sub="Managers add stock, prices and rental terms under Stock & prices." />;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map((i) => (
        <View key={i.id} style={{ width: '48%', minWidth: 150, flexGrow: 1 }}>
          <Card color={c.paper} pad={12} onPress={() => (i.quantity > 0 ? onPick(i) : null)} accessibilityLabel={`${i.name}, ${rent ? 'rent' : 'sell'}, ${i.quantity} in stock`}>
            <T size={24}>{EMOJI[i.category] ?? '📦'}</T>
            <T weight="700" size={14} numberOfLines={2}>{i.name}</T>
            <T weight="800" size={15}>{moneyIn(Number(rent ? i.rental_fee_cents : i.sell_price_cents), cur)}{rent && Number(i.deposit_cents) ? <T size={11} color={c.mute}> + {moneyIn(Number(i.deposit_cents), cur)} deposit</T> : null}</T>
            <T size={11} color={i.quantity > 0 ? (i.low_stock ? c.orange : c.mute) : c.red} weight="700">{i.quantity > 0 ? `${i.quantity} ${rent ? 'available' : 'in stock'}${i.low_stock ? ' · low' : ''}` : 'Out of stock'}</T>
          </Card>
        </View>
      ))}
    </View>
  );
}

function CourtPicker({ v, courts, onAdd }) {
  const [court, setCourt] = useState(courts[0]?.id);
  const [date, setDate] = useState(todayIn(v.timezone));
  const [time, setTime] = useState();
  const [slots, setSlots] = useState(1);
  const ct = courts.find((x) => x.id === court);
  if (!courts.length) return <Empty emoji="🎾" title="No courts yet" sub="Add courts under Courts & special rates." />;
  const go = () => {
    const starts = localToIso(date, time, v.timezone);
    const ends = new Date(+new Date(starts) + slots * ct.slot_minutes * 60000).toISOString();
    onAdd({ kind: 'booking', resource_id: ct.id, starts_at: starts, ends_at: ends, quantity: 1 }, `${ct.name} · ${timeIn(starts, v.timezone)}–${timeIn(ends, v.timezone)}`, Math.round(Number(ct.hourly_rate_cents) * slots * ct.slot_minutes / 60));
  };
  return (
    <Card color={c.paper} pad={14}>
      <View style={{ gap: 10 }}>
        <T weight="800" size={13}>Court</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{courts.map((x) => <Chip key={x.id} label={x.name} active={x.id === court} onPress={() => setCourt(x.id)} />)}</View>
        <DateField label="Day" value={date} onChange={setDate} min={todayIn(v.timezone)} />
        <TimeField label="Start" value={time} onChange={setTime} step={ct?.slot_minutes === 15 || ct?.slot_minutes === 30 ? ct.slot_minutes : 30} />
        <Counter value={slots} onChange={setSlots} min={ct?.min_slots ?? 1} max={ct?.max_slots ?? 8} label={`Length (${ct?.slot_minutes ?? 60}-minute slots)`} />
        <Btn small title="＋ Add court time" disabled={!time} onPress={go} />
      </View>
    </Card>
  );
}

function Collect({ v, handle, onAdd }) {
  const dues = useLoad(() => api.get(`/venues/${v.id}/pos/dues`, { customer_handle: handle }), [v.id, handle]);
  if (dues.loading && !dues.data) return <Loading />;
  if (dues.error) return <ErrorBox error={dues.error} onRetry={dues.reload} />;
  const { invoices, academy_charges: charges } = dues.data;
  if (!invoices.length && !charges.length) return <Empty emoji="🧾" title="Nothing to collect" sub={handle ? 'This customer owes the venue nothing right now.' : 'There are no open invoices. Pick a customer to also see their academy fees.'} />;
  return (
    <View style={{ gap: 8 }}>
      {invoices.map((i) => <Row key={i.id} onPress={() => onAdd({ kind: 'invoice', invoice_id: i.id }, `Invoice ${i.number}`, Number(i.due_cents))} left={<T size={22}>🧾</T>} title={`Invoice ${i.number}`} sub={`${i.customer}${i.reservation_code ? ` · booking ${i.reservation_code}` : ''}`} right={<T weight="800">{moneyIn(Number(i.due_cents), i.currency)}</T>} />)}
      {charges.map((ch) => <Row key={ch.id} onPress={() => onAdd({ kind: 'academy_charge', charge_id: ch.id }, `Academy ${ch.kind} fee`, Number(ch.due_cents))} left={<T size={22}>🎓</T>} title={`Academy ${ch.kind} fee`} sub={`Due ${String(ch.due_on).slice(0, 10)}`} right={<T weight="800">{moneyIn(Number(ch.due_cents), ch.currency)}</T>} />)}
    </View>
  );
}

// ------------------------------------------------------------------ taking the money
export function DeskPay({ visible, onClose, v, desk, body, total, existing, onPaid }) {
  const { toast } = useSession();
  const [run, approvalSheet] = useApproval();
  const [sale, setSale] = useState(existing ?? null);
  const [method, setMethod] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(null);
  const key = useRef(uid());
  const cur = v.currency;
  const due = sale ? Number(sale.amount_due_cents) : Number(total ?? 0);
  useEffect(() => { if (visible) { setSale(existing ?? null); setOnline(null); setTendered(''); setRef(''); setMethod('cash'); if (!existing) key.current = uid(); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = (s) => { setSale(s); if (s.status === 'paid') onPaid(s); };
  const create = (extra = {}) => run((approval) => api.post(`/venues/${v.id}/pos/sales`, { ...body, ...(approval ? { discount: { ...body.discount, approval_id: approval } } : {}), client_ref: key.current, ...extra }));
  const take = async () => {
    setBusy(true);
    try {
      const tender = method === 'cash' ? { method, tendered_cents: toMinor(tendered, cur) ?? due } : { method, reference: ref.trim(), amount_cents: toMinor(tendered, cur) ?? due };
      if (!sale) {
        try { settle(await create({ payments: [tender] })); }
        catch (e) {
          if (e.status || method !== 'cash') throw e;
          // no connection: a cash sale is kept on this device and uploaded later (the same client_ref means it can never be recorded twice)
          const { send } = await import('../outbox');
          await send(`/venues/${v.id}/pos/sales`, { ...body, payments: [tender], client_ref: key.current, client_key: key.current, captured_offline_at: new Date().toISOString() });
          toast('No connection — the cash sale is saved on this device and will upload when you are back online'); onClose();
        }
      } else settle(await api.post(`/pos/sales/${sale.id}/payments`, tender));
      setTendered(''); setRef('');
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const startOnline = async (provider) => {
    setBusy(true);
    try {
      const s = sale ?? await create();
      setSale(s);
      setOnline(await api.post(`/pos/sales/${s.id}/online-payment`, { provider }));
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const check = async (quiet) => {
    if (!sale) return;
    try { const s = await api.post(`/pos/sales/${sale.id}/online-payment/confirm`, {}); if (s.status === 'paid') settle(s); else if (!quiet) toast('Not paid yet — the provider has not confirmed it'); } catch (e) { if (!quiet) toast(e.message); }
  };
  useEffect(() => { if (!online || !visible) return undefined; const t = setInterval(() => check(true), 4000); return () => clearInterval(t); }, [online, visible, sale?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const manual = desk.tenders.manual;
  const need = toMinor(tendered, cur);
  const quick = [due, ...[100, 500, 1000, 2000, 5000].map((n) => Math.ceil(due / (n * 10 ** digitsOf(cur))) * n * 10 ** digitsOf(cur))].filter((x, i, a) => x >= due && a.indexOf(x) === i).slice(0, 4);
  const change = method === 'cash' && need != null && need > due ? need - due : 0;
  return (
    <Sheet visible={visible} onClose={onClose} title={`Charge ${moneyIn(due, cur)}`}>
      {sale && Number(sale.received_cents) ? <T size={13} color={c.mute}>Already received {moneyIn(Number(sale.received_cents), cur)} · still due {moneyIn(due, cur)}</T> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {manual.map((m) => <Chip key={m} label={TENDER[m] ?? m} active={method === m} onPress={() => { setMethod(m); setOnline(null); }} />)}
        {desk.tenders.online.length ? <Chip label="📱 Online (QR)" active={method === 'online'} onPress={() => setMethod('online')} /> : null}
      </View>
      {method === 'online' ? (
        online ? (
          <View style={{ alignItems: 'center', gap: 8 }}>
            <QrCode value={online.checkout_url} size={220} label="Payment QR code. The customer scans it with their phone to pay." />
            <T weight="800">{moneyIn(Number(online.amount_cents), cur)} · waiting for the customer</T>
            <T size={12} color={c.mute} style={{ textAlign: 'center' }}>The sale becomes paid only when the payment provider confirms it. This screen checks every few seconds.</T>
            <Btn small title="Check now" color={c.violet} onPress={() => check(false)} />
            <Btn small title="Open the payment page" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(online.checkout_url)} />
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <T size={13} color={c.mute}>The customer pays on their own phone through the payment provider. Nothing is marked paid until the provider confirms.</T>
            {desk.tenders.online.map((p) => <Btn key={p} title={`Show QR · ${p === 'stripe' ? 'card / wallet' : p}`} loading={busy} onPress={() => startOnline(p)} />)}
          </View>
        )
      ) : (
        <View style={{ gap: 10 }}>
          {method === 'cash' ? (
            <>
              <T weight="800" size={13}>Cash handed over</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{quick.map((q) => <Chip key={q} label={q === due ? 'Exact' : moneyIn(q, cur)} active={need === q} onPress={() => setTendered(String(q / 10 ** digitsOf(cur)))} />)}</View>
              <Field value={tendered} onChangeText={(x) => setTendered(x.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" placeholder={`${cur} ${due / 10 ** digitsOf(cur)}`} accessibilityLabel="Cash handed over" />
              {change > 0 ? <Card color={c.mintSoft} pad={10}><T weight="800" size={16}>Give change {moneyIn(change, cur)}</T></Card> : null}
            </>
          ) : (
            <>
              <T size={13} color={c.mute}>Recorded by hand: confirm the payment on your own terminal or phone first, then enter its reference so it can be matched later.</T>
              <Field label="Terminal / UPI / bank reference" value={ref} onChangeText={setRef} accessibilityLabel="Payment reference" />
              <Field label={`Amount (${cur}) — leave empty for all of it`} value={tendered} onChangeText={(x) => setTendered(x.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" />
            </>
          )}
          <Btn title={method === 'cash' ? `Take ${moneyIn(Math.min(need ?? due, due), cur)} cash` : `Record ${TENDER[method]?.replace(/^\S+\s/, '') ?? method} payment`} loading={busy} disabled={method !== 'cash' && ref.trim().length < 2} onPress={take} />
        </View>
      )}
      {sale && sale.status !== 'paid' ? <Btn small title="Cancel this sale" color={c.paper} ink={c.red} onPress={async () => { try { await run((a) => api.post(`/pos/sales/${sale.id}/void`, { reason: 'Cancelled at the desk', approval_id: a })); setSale(null); onClose(); toast('Sale cancelled'); } catch (e) { toast(e.message); } }} /> : null}
      {approvalSheet}
    </Sheet>
  );
}

export function DeskReceipt({ saleId, onNew, v }) {
  const { toast } = useSession();
  const r = useLoad(() => api.get(`/pos/sales/${saleId}/receipt`), [saleId]);
  const sale = useLoad(() => api.get(`/pos/sales/${saleId}`), [saleId]);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const x = r.data, cur = x.currency, change = x.payments.reduce((s, p) => s + p.change_cents, 0);
  const reserved = (sale.data?.rentals ?? []).filter((k) => k.status === 'reserved').length;
  const send = async (channel) => {
    try {
      const o = await api.post(`/pos/sales/${saleId}/receipt`, { channel });
      if (channel === 'whatsapp') await Linking.openURL(o.whatsapp_url); else toast('Receipt sent to the customer\'s app');
    } catch (e) { toast(e.message); }
  };
  return (
    <View style={{ gap: 10 }}>
      {change > 0 ? <Card color={c.mintSoft} pad={12}><T weight="800" size={18}>Give change {moneyIn(change, cur)}</T></Card> : null}
      <Card color={c.paper} pad={14}>
        <T weight="800">{x.seller.name}</T>
        {x.seller.tax_id ? <T size={12} color={c.mute}>{x.tax.name ?? 'Tax'} ID {x.seller.tax_id}</T> : null}
        <T size={12} color={c.mute}>{x.documents.map((d) => d.number).join(' · ')}</T>
        <View style={{ height: 8 }} />
        {x.lines.map((l, i) => <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={13} style={{ flex: 1 }}>{l.qty > 1 ? `${l.qty} × ` : ''}{l.description}</T><T size={13} weight="700">{moneyIn(l.total_cents, cur)}</T></View>)}
        <View style={{ height: 8 }} />
        {x.totals.discount_cents ? <Line k="Discount" v={`−${moneyIn(x.totals.discount_cents, cur)}`} /> : null}
        {x.totals.tax_cents ? <Line k={`${x.tax.name ?? 'Tax'} ${x.tax.inclusive ? 'included' : 'added'}`} v={moneyIn(x.totals.tax_cents, cur)} /> : null}
        <Line k="Total" v={moneyIn(x.totals.total_cents, cur)} big />
        {x.payments.map((p, i) => <Line key={i} k={`Paid · ${p.label}${p.reference ? ` (${p.reference})` : ''}`} v={moneyIn(p.amount_cents, cur)} />)}
        {x.totals.due_cents ? <Line k="Still due" v={moneyIn(x.totals.due_cents, cur)} /> : null}
        <T size={11} color={c.mute} style={{ marginTop: 6 }}>{x.notice}</T>
      </Card>
      {reserved ? <Card color={c.sunSoft} pad={10}><T weight="700" size={13}>{reserved} rental item{reserved > 1 ? 's' : ''} waiting to be handed over — see Rentals.</T></Card> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="Share / print" color={c.violet} onPress={() => shareText(x.text, toast)} />
        {sale.data?.customer ? <Btn small title="Send to their app" color={c.paper} ink={c.ink} onPress={() => send('app')} /> : null}
        {sale.data?.guest?.phone ? <Btn small title="WhatsApp" color={c.paper} ink={c.ink} onPress={() => send('whatsapp')} /> : null}
      </View>
      <Btn title="New sale" onPress={onNew} />
    </View>
  );
}

// ------------------------------------------------------------------ sales history, refunds and voids
function Sales({ v, desk }) {
  const [status, setStatus] = useState(undefined);
  const list = useLoad(() => api.get(`/venues/${v.id}/pos/sales`, { status, limit: 50 }), [v.id, status]);
  const [open, setOpen] = useState(null);
  return (
    <Section title="Sales" color={c.violet}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[[undefined, 'All'], ['awaiting_payment', 'Awaiting payment'], ['paid', 'Paid'], ['void', 'Void']].map(([k, l]) => <Chip key={l} label={l} active={status === k} onPress={() => setStatus(k)} />)}</View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((s) => (
        <Row key={s.id} onPress={() => setOpen(s.id)} left={<T size={22}>{s.status === 'paid' ? '✅' : s.status === 'void' ? '🚫' : '⏳'}</T>} title={`${s.customer} · ${moneyIn(Number(s.total_cents), s.currency)}`}
          sub={`${dateTimeIn(s.created_at, v.timezone)} · ${s.cashier} · ${s.line_count} line${s.line_count === 1 ? '' : 's'}${s.methods ? ` · ${s.methods.split(',').map((m) => (m === 'online' ? 'online' : 'by hand')).filter((x, i, a) => a.indexOf(x) === i).join(' + ')}` : ''}`}
          right={<Tag label={STATUS[s.status][0]} color={STATUS[s.status][1]} />} />
      )) : <Empty emoji="🧾" title="No sales yet" sub="Sales you ring up appear here with their receipt, refunds and rentals." />}
      <SaleSheet id={open} v={v} desk={desk} onClose={() => { setOpen(null); list.reload(); }} />
    </Section>
  );
}

function SaleSheet({ id, v, desk, onClose }) {
  const { toast } = useSession();
  const [run, approvalSheet] = useApproval();
  const s = useLoad(() => (id ? api.get(`/pos/sales/${id}`) : Promise.resolve(null)), [id]);
  const [picks, setPicks] = useState({});
  const [method, setMethod] = useState(null);
  const [why, setWhy] = useState('Wrong item');
  const [back, setBack] = useState(true);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState(false);
  useEffect(() => { setPicks({}); setReceipt(false); }, [id]);
  const d = s.data;
  if (!id) return null;
  const cur = d?.currency ?? v.currency;
  const hadOnline = d?.payments?.some((p) => p.method === 'online' && p.status === 'confirmed');
  const m = method ?? (hadOnline ? 'original' : 'cash');
  const refundable = (d?.lines ?? []).filter((l) => ['item', 'booking'].includes(l.kind) && l.returned_qty < l.qty);
  const chosen = Object.entries(picks).filter(([, n]) => n > 0).map(([line_id, qty]) => ({ line_id, qty, restock: back }));
  const act = async (fn, ok) => { try { await fn(); toast(ok); s.reload(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible onClose={onClose} title={d ? `${d.customer?.name ?? d.guest?.name ?? 'Walk-in'} · ${moneyIn(Number(d.total_cents), cur)}` : 'Sale'}>
      {s.loading && !d ? <Loading /> : s.error ? <ErrorBox error={s.error} onRetry={s.reload} /> : d ? (
        <>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={STATUS[d.status][0]} color={STATUS[d.status][1]} />{d.documents.map((x) => <Tag key={x.id} label={`${x.number} · ${x.status}`} color={c.violetSoft} />)}</View>
          {d.lines.map((l) => <View key={l.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={13} style={{ flex: 1 }}>{l.qty > 1 ? `${l.qty} × ` : ''}{l.description}{l.returned_qty ? ` (returned ${l.returned_qty})` : ''}</T><T size={13} weight="700">{moneyIn(Number(l.total_cents), cur)}</T></View>)}
          {d.payments.length ? <T size={12} color={c.mute}>{d.payments.map((p) => `${p.kind === 'refund' ? 'Paid back' : 'Paid'} ${moneyIn(Number(p.amount_cents), cur)} ${p.method === 'online' ? 'online — confirmed by the provider' : `${(TENDER[p.method] ?? p.method).replace(/^\S+\s/, '').replace(/ \(checked on your phone\)/, '')} — recorded by hand${p.reference ? ` (${p.reference})` : ''}`}${p.status === 'pending' ? ' (pending)' : ''}`).join(' · ')}</T> : null}
          {d.status === 'awaiting_payment' ? (
            <View style={{ gap: 8 }}>
              <Card color={c.sunSoft} pad={10}><T weight="700">Still to pay: {moneyIn(Number(d.amount_due_cents), cur)}{d.pending_online ? ' · online payment waiting for the customer' : ''}</T></Card>
              <Btn title="Take payment" onPress={() => setPaying(true)} />
              <Btn small title="Cancel this sale" color={c.paper} ink={c.red} onPress={() => act(() => run((a) => api.post(`/pos/sales/${d.id}/void`, { reason: 'Cancelled at the desk', approval_id: a })), 'Sale cancelled')} />
            </View>
          ) : null}
          {d.refunds.filter((r) => ['manual', 'failed'].includes(r.refund_status)).map((r) => (
            <Card key={r.id} color={c.orangeSoft} pad={10}><T weight="700" size={13}>Credit note {r.number}: {moneyIn(Number(r.total_cents), cur)} to pay back to the customer</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{desk.tenders.manual.filter((x) => x === 'cash').map((x) => <Btn key={x} small title="Paid back in cash" onPress={() => act(() => api.post(`/pos/credit-notes/${r.id}/paid-back`, { method: x }), 'Recorded')} />)}</View></Card>
          ))}
          {d.status === 'paid' && refundable.length ? (
            <View style={{ gap: 8 }}>
              <T weight="800" size={14}>Return or refund</T>
              {refundable.map((l) => <Counter key={l.id} label={l.description} value={picks[l.id] ?? 0} min={0} max={l.kind === 'booking' ? 1 : l.qty - l.returned_qty} onChange={(n) => setPicks((p) => ({ ...p, [l.id]: n }))} />)}
              {chosen.length ? (
                <>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[['cash', '💵 Cash from the drawer'], ['original', '↩︎ Back to how it was paid']].map(([k, l]) => <Chip key={k} label={l} active={m === k} onPress={() => setMethod(k)} />)}</View>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['Wrong item', 'Faulty', 'Changed their mind', 'Rained off', 'Staff error'].map((r) => <Chip key={r} label={r} active={why === r} onPress={() => setWhy(r)} />)}</View>
                  <View style={{ flexDirection: 'row', gap: 6 }}><Chip label="Back to stock" active={back} onPress={() => setBack(true)} /><Chip label="Write off (not resaleable)" active={!back} onPress={() => setBack(false)} /></View>
                  <Btn title="Refund" color={c.orange} onPress={() => act(() => run((a) => api.post(`/pos/sales/${d.id}/refund`, { lines: chosen, method: m, reason: why, approval_id: a })), 'Refund recorded')} />
                </>
              ) : null}
            </View>
          ) : null}
          <Btn small title={receipt ? 'Hide receipt' : 'Receipt'} color={c.violet} onPress={() => setReceipt((x) => !x)} />
          {receipt ? <DeskReceipt saleId={d.id} v={v} onNew={onClose} /> : null}
          <DeskPay visible={paying} onClose={() => setPaying(false)} v={v} desk={desk} existing={d} onPaid={() => { setPaying(false); s.reload(); }} body={{}} />
        </>
      ) : null}
      {approvalSheet}
    </Sheet>
  );
}
