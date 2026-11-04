// Professional ticketing & fan entry (#587). These are parts of the ONE ticketing experience, not a second console: the organiser panels plug into
// TicketsTab (event-tickets.js) as sub-tabs and into its overview; the buyer's package picker plugs into TicketShop; the box office and the scanner
// session plug into TicketGatePanel (also used by the accreditation gate). All rules live in the API (src/capabilities/ticketing-ops.js); this only calls it.
//   BundlePanel / BundlePicker   bundles and hospitality packages (organiser builds, buyer picks)
//   BoxOfficePanel / TillsPanel  walk-up sales with tenders and cash-up (operator) and the tills overview (organiser)
//   ScannerSession               a device shift: reports what it scanned so the organiser can reconcile
//   ReconcilePanel               organiser: gates reconciled and signed off
//   FansPanel / AnalyticsPanel   fan segments and sell-through analytics
import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useDo } from './console-utils';
import { A, ABar, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStat, AT, ATag } from '../arena';
import { FormSheet } from '../FormSheet';
import { Counter } from '../pickers';
import { QrCode } from './passport';
import { locale } from '../locale';
import { moneyIn } from '../vtime';
import { t } from '../i18n';

const stamp = (d) => (d ? new Date(d).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const key = () => `bo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const pctText = (v) => (v == null ? '–' : `${v}%`);
export const PERKS = ['lounge', 'catering', 'host', 'premium_seating', 'drinks', 'meet_greet', 'parking', 'programme'];
const CHANNEL_OPTS = ['online', 'box_office', 'partner'];
const TENDERS = ['cash', 'card_terminal', 'upi', 'voucher'];
const wrap = { flexDirection: 'row', flexWrap: 'wrap', gap: 10 };
const inputStyle = { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: A.line, backgroundColor: A.panel2, color: A.ink, paddingHorizontal: 14, fontSize: 16 };
const dayStart = (d) => (d ? `${d}T00:00:00.000Z` : undefined);
const dayEnd = (d) => (d ? `${d}T23:59:59.000Z` : undefined);

/** A thin bar chart: one column per value, the tallest fills the height. Accessible: the whole chart carries a summary label. */
function Bars({ values, labels, color = A.violet, label }) {
  const max = Math.max(1, ...values);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 84 }}>
      {values.map((v, i) => (
        <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
          <View style={{ width: '100%', minHeight: v ? 4 : 2, height: `${(v / max) * 100}%`, borderRadius: 4, backgroundColor: v ? color : A.line }} />
          {labels?.[i] ? <AT size={9} color={A.mute} style={{ marginTop: 2 }}>{labels[i]}</AT> : null}
        </View>
      ))}
    </View>
  );
}

// ---- organiser: analytics ----------------------------------------------------------------------------------------------------------------------------
export function AnalyticsPanel({ analytics: X }) {
  if (!X) return null;
  const days = {};
  for (const v of X.velocity ?? []) days[String(v.day).slice(0, 10)] = (days[String(v.day).slice(0, 10)] ?? 0) + v.tickets;
  const dayKeys = Object.keys(days).sort().slice(-14);
  const hours = Array.from({ length: 24 }, (_, h) => (X.arrival?.by_hour ?? []).find((x) => x.hour === h)?.admitted ?? 0);
  const firstHour = Math.max(0, hours.findIndex((v) => v > 0) - 1), lastHour = Math.min(23, 23 - [...hours].reverse().findIndex((v) => v > 0) + 1);
  const shown = hours.slice(firstHour, lastHour + 1);
  return (
    <>
      <ASection title={t('pro.analytics')} sub={t('pro.analytics_sub')} />
      <View style={wrap}>
        <AStat icon="📈" value={pctText(X.sell_through.overall_pct)} label={t('pro.sell_through')} tone={A.green} />
        <AStat icon="🙈" value={pctText(X.no_show.rate_pct)} label={t('pro.no_show_rate')} tone={X.no_show.rate_pct > 25 ? A.sun : undefined} />
        <AStat icon="🛒" value={pctText(X.online_conversion.pct)} label={t('pro.conversion')} tone={A.cyan} />
        {(X.average_order ?? []).map((a) => <AStat key={a.currency} icon="🧾" value={moneyIn(a.avg_minor, a.currency)} label={t('pro.avg_order')} />)}
      </View>
      <ACard pad={14} style={{ gap: 10 }}>
        <AT size={14} weight="800">{t('pro.by_fixture')}</AT>
        {X.sell_through.fixtures.length ? X.sell_through.fixtures.map((f) => (
          <View key={f.fixture_id} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><AT size={12} color={A.mute}>{stamp(f.scheduled_at)}</AT><AT size={12} weight="800" num>{f.sold}{f.capacity != null ? ` / ${f.capacity}` : ''} · {pctText(f.pct)}</AT></View>
            <ABar pct={f.pct ?? 0} color={f.pct >= 90 ? A.sun : A.green} />
            {f.attended ? <AT size={11} color={A.mute}>{t('pro.attended_of', { a: f.attended, s: f.sold, p: pctText(f.attendance_pct) })}</AT> : null}
          </View>
        )) : <AT size={12} color={A.mute}>{t('pro.no_fixtures')}</AT>}
      </ACard>
      <ACard pad={14} style={{ gap: 10 }}>
        <AT size={14} weight="800">{t('pro.by_product')}</AT>
        {X.sell_through.products.map((p) => (
          <View key={p.id} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><AT size={12} style={{ flex: 1 }}>{p.name}</AT><AT size={12} weight="800" num>{p.sold}{p.allocation != null ? ` / ${p.allocation}` : ''}{p.held ? ` · ${t('pro.held', { n: p.held })}` : ''}</AT></View>
            {p.allocation != null ? <ABar pct={p.pct ?? 0} color={A.violet} /> : null}
          </View>
        ))}
      </ACard>
      <ACard pad={14} style={{ gap: 8 }}>
        <AT size={14} weight="800">{t('pro.velocity')}</AT>
        {dayKeys.length ? <Bars values={dayKeys.map((k) => days[k])} labels={dayKeys.map((k) => k.slice(8))} color={A.cyan} label={t('pro.velocity_a11y', { n: dayKeys.reduce((s, k) => s + days[k], 0) })} /> : <AT size={12} color={A.mute}>{t('pro.velocity_empty')}</AT>}
      </ACard>
      <ACard pad={14} style={{ gap: 8 }}>
        <AT size={14} weight="800">{t('pro.arrival')}</AT>
        {X.arrival?.peak_hour != null ? <>
          <Bars values={shown} labels={shown.map((_, i) => String(firstHour + i))} color={A.lime} label={t('pro.arrival_a11y', { h: X.arrival.peak_hour })} />
          <AT size={12} color={A.mute}>{t('pro.peak', { h: X.arrival.peak_hour })}</AT>
        </> : <AT size={12} color={A.mute}>{t('pro.arrival_empty')}</AT>}
      </ACard>
      {(X.bundles ?? []).length ? <ACard pad={14} style={{ gap: 6 }}>
        <AT size={14} weight="800">{t('pro.bundle_perf')}</AT>
        {X.bundles.map((b) => <ARow key={b.id} title={b.name} sub={t('pro.bundle_perf_line', { sold: b.sold, saving: moneyIn(b.saving_minor, b.currency) })} right={<AT size={14} weight="800" num>{moneyIn(b.revenue_minor, b.currency)}</AT>} />)}
      </ACard> : null}
    </>
  );
}

// ---- organiser: bundles and hospitality packages -----------------------------------------------------------------------------------------------------
export function BundlePanel({ id, products }) {
  const list = useLoad(() => api.get(`/events/${id}/ticket-bundles`), [id]);
  const addons = useLoad(() => api.get(`/events/${id}/ticket-addons`).catch(() => []), [id]);
  const act = useDo(list.reload);
  const [form, setForm] = useState(null);
  const prods = (products ?? []).filter((p) => p.status !== 'archived' && p.class !== 'complimentary');
  const cur = prods[0]?.currency;
  const adds = (addons.data ?? []).filter((a) => a.status !== 'archived');
  return (
    <>
      <ASection title={t('pro.sub.bundles')} sub={t('pro.bundle_sub')} action={prods.length ? t('pro.bundle_new') : undefined} onAction={() => setForm({})} />
      {(list.data?.items ?? []).length ? list.data.items.map((b) => (
        <ACard key={b.id} pad={14} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AT size={16} weight="800" style={{ flex: 1 }}>{b.name}</AT>
            <ATag label={t(`pro.kind.${b.kind}`)} tone={b.kind === 'hospitality' ? A.sun : A.cyan} />
            <ATag label={t(`tix.status.${b.status}`)} tone={b.status === 'active' ? A.green : undefined} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <AT size={20} weight="900" num>{moneyIn(b.price_minor, b.currency)}</AT>
            {b.saving_minor ? <AT size={12} color={A.green} weight="800">{t('pro.saves', { amount: moneyIn(b.saving_minor, b.currency), list: moneyIn(b.list_minor, b.currency) })}</AT> : null}
          </View>
          <View style={{ gap: 2 }}>{b.items.map((x, i) => <AT key={i} size={12} color={A.mute}>{x.qty} × {x.name}{x.type === 'addon' ? ` · ${t('pro.addon')}` : ''}</AT>)}</View>
          {b.perks?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{b.perks.map((p) => <ATag key={p} label={PERKS.includes(p) ? t(`pro.perk.${p}`) : p} />)}</View> : null}
          <AT size={12} color={A.mute}>{t('pro.bundle_line', { sold: b.sold, left: b.left ?? '∞', channels: b.channels.map((x) => t(`pro.channel.${x}`)).join(' · ') })}</AT>
          {b.stock ? <ABar pct={Math.min(100, (b.taken / b.stock) * 100)} color={A.violet} /> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {b.status !== 'active' ? <ABtn small title={t('tix.put_on_sale')} onPress={() => act(() => api.patch(`/ticket-bundles/${b.id}`, { status: 'active' }), t('tix.on_sale'))} /> : <ABtn small tone="ghost" title={t('tix.pause')} onPress={() => act(() => api.patch(`/ticket-bundles/${b.id}`, { status: 'paused' }), t('pro.saved'))} />}
            <ABtn small tone="ghost" title={t('pro.edit')} onPress={() => setForm(b)} />
            {b.status !== 'archived' ? <ABtn small tone="ghost" title={t('tix.archive')} onPress={() => act(() => api.patch(`/ticket-bundles/${b.id}`, { status: 'archived' }), t('tix.archived'))} /> : null}
          </View>
        </ACard>
      )) : <AEmpty emoji="🥂" title={t('pro.bundle_none')} sub={prods.length ? t('pro.bundle_none_sub') : t('pro.bundle_need_product')} action={prods.length ? t('pro.bundle_new') : undefined} onAction={() => setForm({})} />}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.id ? t('pro.bundle_edit') : t('pro.bundle_new')} submitLabel={form?.id ? t('common.save') : t('tix.create')}
        initial={form?.id ? { name: form.name, kind: form.kind, perks: form.perks, tickets: form.items.filter((x) => x.type === 'ticket').map((x) => x.product_id), per: form.items.find((x) => x.type === 'ticket')?.qty ?? 1, addon_ids: form.items.filter((x) => x.type === 'addon').map((x) => x.addon_id), price: form.price_minor, stock: form.stock ?? '', per_order_limit: form.per_order_limit, channels: form.channels, window: form.sale_starts_at?.slice(0, 10), window_to: form.sale_ends_at?.slice(0, 10), currency: form.currency }
          : { kind: 'bundle', per: 1, per_order_limit: 4, channels: ['online'], perks: [], tickets: [], addon_ids: [], currency: cur }}
        fields={[
          { key: 'kind', label: t('pro.bundle_kind'), type: 'chips', options: [{ value: 'bundle', label: t('pro.kind.bundle') }, { value: 'hospitality', label: t('pro.kind.hospitality') }] },
          { key: 'name', label: t('pro.bundle_name') },
          { key: 'tickets', label: t('pro.bundle_tickets'), type: 'multimenu', options: prods.map((p) => ({ value: p.id, label: `${p.name} · ${moneyIn(p.price_minor, p.currency)}` })), hint: t('pro.bundle_tickets_hint') },
          { key: 'per', label: t('pro.bundle_per'), type: 'stepper', min: 1, max: 20 },
          { key: 'addon_ids', label: t('pro.bundle_addons'), type: 'multimenu', optional: true, options: adds.map((a) => ({ value: a.id, label: `${a.name} · ${moneyIn(a.price_minor, a.currency)}` })) },
          { key: 'price', label: t('pro.bundle_price'), type: 'money', currency: (v) => v.currency || cur, hint: t('pro.bundle_price_hint') },
          { key: 'perks', label: t('pro.bundle_perks'), type: 'multimenu', optional: true, options: PERKS.map((p) => ({ value: p, label: t(`pro.perk.${p}`) })), show: (v) => v.kind === 'hospitality' },
          { key: 'stock', label: t('pro.bundle_stock'), type: 'number', optional: true },
          { key: 'per_order_limit', label: t('pro.bundle_order_limit'), type: 'stepper', min: 1, max: 20 },
          { key: 'channels', label: t('pro.bundle_channels'), type: 'multimenu', options: CHANNEL_OPTS.map((x) => ({ value: x, label: t(`pro.channel.${x}`) })) },
          { key: 'window', label: t('pro.bundle_window'), type: 'daterange', toKey: 'window_to', optional: true },
        ]}
        onSubmit={async (v) => {
          const items = [...(v.tickets ?? []).map((product_id) => ({ product_id, qty: v.per })), ...(v.addon_ids ?? []).map((addon_id) => ({ addon_id, qty: 1 }))];
          const body = { name: v.name, price_minor: Number(v.price), perks: v.kind === 'hospitality' ? v.perks ?? [] : [], stock: v.stock === '' || v.stock == null ? null : Number(v.stock), per_order_limit: v.per_order_limit, channels: v.channels,
            sale_starts_at: dayStart(v.window) ?? null, sale_ends_at: dayEnd(v.window_to) ?? null };
          if (form?.id) await api.patch(`/ticket-bundles/${form.id}`, { ...body, ...(form.sold ? {} : { items }) });
          else await api.post(`/events/${id}/ticket-bundles`, { ...body, kind: v.kind, currency: v.currency || cur, items, status: 'draft' });
          list.reload(); return null;
        }} />
    </>
  );
}

/** Buyer: pick packages in the shop. `qty` is { [bundle_id]: n }; the shop adds them to the order and the quote. */
export function BundlePicker({ id, qty, setQty }) {
  const list = useLoad(() => api.get(`/public/events/${id}/tickets/bundles`).catch(() => ({ items: [] })), [id]);
  const items = list.data?.items ?? [];
  if (!items.length) return null;
  return (
    <>
      <ASection title={t('pro.packages')} sub={t('pro.packages_sub')} />
      {items.map((b) => {
        const sold = ['sold_out', 'ended', 'not_started', 'paused'].includes(b.availability);
        return (
          <ACard key={b.id} pad={14} style={{ gap: 8, opacity: sold ? 0.6 : 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <AT size={16} weight="800" style={{ flex: 1 }}>{b.name}</AT>
              <ATag label={t(`pro.kind.${b.kind}`)} tone={b.kind === 'hospitality' ? A.sun : A.cyan} />
              {b.availability !== 'available' ? <ATag label={t(`tix.avail.${b.availability}`)} tone={b.availability === 'low' ? A.sun : A.red} /> : null}
            </View>
            {b.description ? <AT size={13} color={A.mute}>{b.description}</AT> : null}
            <View style={{ gap: 2 }}>{b.items.map((x, i) => <AT key={i} size={13}>• {x.qty} × {x.name}</AT>)}</View>
            {b.perks?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{b.perks.map((p) => <ATag key={p} label={PERKS.includes(p) ? t(`pro.perk.${p}`) : p} tone={A.sun} />)}</View> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <View>
                <AT size={20} weight="900" num>{moneyIn(b.price_minor, b.currency)}</AT>
                {b.saving_minor ? <AT size={12} color={A.green} weight="800">{t('pro.saves', { amount: moneyIn(b.saving_minor, b.currency), list: moneyIn(b.list_minor, b.currency) })}</AT> : null}
              </View>
              {!sold ? <Counter value={qty[b.id] ?? 0} onChange={(n) => setQty({ ...qty, [b.id]: n })} min={0} max={b.per_order_limit} a11y={b.name} /> : null}
            </View>
          </ACard>
        );
      })}
    </>
  );
}

// ---- box office ----------------------------------------------------------------------------------------------------------------------------------------
function TillStrip({ till }) {
  const T0 = till.totals;
  return (
    <View style={wrap}>
      <AStat icon="💷" value={moneyIn(T0.sales_minor, till.currency)} label={t('pro.till_sales')} tone={A.green} />
      <AStat icon="🧾" value={T0.orders} label={t('pro.till_orders')} />
      <AStat icon="💵" value={moneyIn(T0.cash_expected_minor, till.currency)} label={t('pro.till_cash')} tone={A.cyan} />
      <AStat icon="↩️" value={moneyIn(T0.refunds_minor, till.currency)} label={t('pro.till_refunds')} tone={T0.refunds_minor ? A.sun : undefined} />
    </View>
  );
}

export function BoxOfficePanel({ id }) {
  const { toast } = useSession();
  const till = useLoad(() => api.get(`/events/${id}/box-office/tills/mine`), [id]);
  const catalogue = useLoad(() => api.get(`/events/${id}/box-office/catalogue`), [id]);
  const [openForm, setOpenForm] = useState(false), [closeForm, setCloseForm] = useState(false), [refund, setRefund] = useState(false);
  const [qty, setQty] = useState({}), [bq, setBq] = useState({}), [aq, setAq] = useState({});
  const [tender, setTender] = useState('cash'), [given, setGiven] = useState(''), [ref, setRef] = useState(''), [name, setName] = useState(''), [email, setEmail] = useState(''), [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false), [done, setDone] = useState(null), [attempt, setAttempt] = useState(key());
  const cat = catalogue.data, tl = till.data?.till;
  const lines = Object.entries(qty).filter(([, n]) => n > 0).map(([product_id, quantity]) => ({ product_id, quantity }));
  const bundles = Object.entries(bq).filter(([, n]) => n > 0).map(([bundle_id, quantity]) => ({ bundle_id, quantity }));
  const addons = Object.entries(aq).filter(([, n]) => n > 0).map(([addon_id, quantity]) => ({ addon_id, quantity }));
  const total = (cat?.products ?? []).reduce((s, p) => s + (qty[p.id] ?? 0) * p.price_minor, 0) + (cat?.bundles ?? []).reduce((s, b) => s + (bq[b.id] ?? 0) * b.price_minor, 0) + (cat?.addons ?? []).reduce((s, a) => s + (aq[a.id] ?? 0) * a.price_minor, 0);
  const givenMinor = Math.round(Number(String(given).replace(',', '.')) * 100) || 0;
  const change = tender === 'cash' && givenMinor > total ? givenMinor - total : 0;
  const empty = !lines.length && !bundles.length;
  const reset = () => { setQty({}); setBq({}); setAq({}); setGiven(''); setRef(''); setName(''); setEmail(''); setOptIn(false); setAttempt(key()); };
  const sell = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/events/${id}/box-office/sales`, {
        idempotency_key: attempt, lines, bundles: bundles.length ? bundles : undefined, addons: addons.length ? addons : undefined,
        buyer: name.trim() ? { name: name.trim(), email: email.trim() || undefined, marketing_opt_in: optIn } : undefined,
        tenders: total > 0 ? [{ method: tender, amount_minor: total, ...(tender === 'cash' && givenMinor > total ? { tendered_minor: givenMinor } : {}), ...(tender !== 'cash' ? { reference: ref.trim() } : {}) }] : [],
      });
      setDone(r); reset(); till.reload(); catalogue.reload();
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  if (till.loading || catalogue.loading) return null;
  if (!tl) {
    return (
      <>
        <AEmpty emoji="🧾" title={t('pro.till_closed')} sub={t('pro.till_closed_sub')} action={t('pro.till_open')} onAction={() => setOpenForm(true)} />
        <FormSheet visible={openForm} onClose={() => setOpenForm(false)} title={t('pro.till_open')} submitLabel={t('pro.till_open')} initial={{ currency: cat?.currency, float: 0 }}
          fields={[{ key: 'currency', label: t('tix.currency'), type: 'currency' }, { key: 'float', label: t('pro.till_float'), type: 'money', currency: (v) => v.currency || cat?.currency, hint: t('pro.till_float_hint') }, { key: 'label', label: t('pro.till_label'), optional: true }]}
          onSubmit={async (v) => { await api.post(`/events/${id}/box-office/tills`, { currency: v.currency || cat?.currency, opening_float_minor: Number(v.float) || 0, label: v.label || undefined }); till.reload(); return null; }} />
      </>
    );
  }
  return (
    <>
      <ASection title={t('pro.box_office')} sub={t('pro.till_open_since', { when: stamp(tl.opened_at), float: moneyIn(tl.opening_float_minor, tl.currency) })} action={t('pro.till_close')} onAction={() => setCloseForm(true)} />
      <TillStrip till={tl} />
      {done ? (
        <ACard pad={16} style={{ gap: 10, borderColor: A.green, borderWidth: 1 }} accessibilityRole="alert">
          <AT size={16} weight="900" color={A.green}>✓ {t('pro.sold_done', { n: done.tickets.length, total: moneyIn(done.total_minor, done.currency) })}</AT>
          {done.change_minor ? <AT size={20} weight="900">{t('pro.give_change', { amount: moneyIn(done.change_minor, done.currency) })}</AT> : null}
          <View style={wrap}>{done.tickets.map((k) => (
            <View key={k.id} style={{ alignItems: 'center', gap: 4 }}>
              <QrCode value={k.token} size={120} label={t('pro.qr_a11y', { s: k.serial })} />
              <AT size={11} color={A.mute}>{k.serial}{k.seat ? ` · ${k.seat}` : ''}</AT>
              {k.claim_code ? <AT size={11} weight="800">{t('pro.claim_code', { c: k.claim_code })}</AT> : null}
            </View>
          ))}</View>
          <ABtn small tone="ghost" title={t('pro.next_sale')} onPress={() => setDone(null)} />
        </ACard>
      ) : (
        <>
          <ASection title={t('pro.sell_tickets')} />
          {(cat?.products ?? []).length ? cat.products.map((p) => (
            <ARow key={p.id} title={p.name} sub={`${moneyIn(p.price_minor, p.currency)}${p.left != null ? ` · ${t('pro.left', { n: p.left })}` : ''}`}
              right={p.left === 0 ? <ATag label={t('tix.avail.sold_out')} tone={A.red} /> : <Counter value={qty[p.id] ?? 0} onChange={(n) => setQty({ ...qty, [p.id]: n })} min={0} max={Math.min(20, p.left ?? 20)} a11y={p.name} />} />
          )) : <AEmpty emoji="🎟️" title={t('pro.no_desk_products')} sub={t('pro.no_desk_products_sub')} />}
          {(cat?.bundles ?? []).map((b) => <ARow key={b.id} title={b.name} sub={`${moneyIn(b.price_minor, b.currency)} · ${t(`pro.kind.${b.kind}`)}`} right={<Counter value={bq[b.id] ?? 0} onChange={(n) => setBq({ ...bq, [b.id]: n })} min={0} max={Math.min(10, b.left ?? 10)} a11y={b.name} />} />)}
          {(cat?.addons ?? []).map((a) => <ARow key={a.id} title={a.name} sub={`${moneyIn(a.price_minor, a.currency)} · ${t(`tix2.addon_kind_${a.kind}`)}`} right={<Counter value={aq[a.id] ?? 0} onChange={(n) => setAq({ ...aq, [a.id]: n })} min={0} max={10} a11y={a.name} />} />)}
          <ACard pad={14} style={{ gap: 10 }}>
            <AT size={13} weight="800">{t('pro.walkup_buyer')}</AT>
            <TextInput value={name} onChangeText={setName} placeholder={t('pro.buyer_name')} placeholderTextColor={A.mute} accessibilityLabel={t('pro.buyer_name')} style={inputStyle} />
            {name.trim() ? <>
              <TextInput value={email} onChangeText={setEmail} placeholder={t('pro.buyer_email')} placeholderTextColor={A.mute} accessibilityLabel={t('pro.buyer_email')} keyboardType="email-address" autoCapitalize="none" style={inputStyle} />
              <AChip label={t('pro.buyer_optin')} active={optIn} onPress={() => setOptIn(!optIn)} />
            </> : <AT size={12} color={A.mute}>{t('pro.walkup_buyer_sub')}</AT>}
          </ACard>
          {total > 0 ? (
            <ACard pad={14} style={{ gap: 10 }}>
              <AT size={13} weight="800">{t('pro.take_payment')}</AT>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{TENDERS.map((m) => <AChip key={m} label={t(`pro.tender.${m}`)} active={tender === m} onPress={() => setTender(m)} />)}</View>
              {tender === 'cash'
                ? <TextInput value={given} onChangeText={setGiven} placeholder={t('pro.cash_given')} placeholderTextColor={A.mute} accessibilityLabel={t('pro.cash_given')} keyboardType="decimal-pad" style={inputStyle} />
                : <TextInput value={ref} onChangeText={setRef} placeholder={t(`pro.ref.${tender}`)} placeholderTextColor={A.mute} accessibilityLabel={t(`pro.ref.${tender}`)} autoCapitalize="characters" style={inputStyle} />}
              {change ? <AT size={18} weight="900" color={A.sun}>{t('pro.give_change', { amount: moneyIn(change, tl.currency) })}</AT> : null}
            </ACard>
          ) : null}
          <ABtn title={empty ? t('pro.choose_items') : `${t('pro.charge')} ${moneyIn(total, tl.currency)}`} onPress={sell} loading={busy} disabled={empty || (total > 0 && tender !== 'cash' && !ref.trim())} />
        </>
      )}
      <ABtn small tone="ghost" title={t('pro.refund_desk')} onPress={() => setRefund(true)} />
      <FormSheet visible={refund} onClose={() => setRefund(false)} title={t('pro.refund_desk')} submitLabel={t('pro.refund_go')}
        fields={[{ key: 'code', label: t('pro.refund_code'), hint: t('pro.refund_code_hint') }, { key: 'method', label: t('pro.refund_method'), type: 'chips', optional: true, options: TENDERS.map((m) => ({ value: m, label: t(`pro.tender.${m}`) })) }, { key: 'reason', label: t('pro.refund_reason'), type: 'multiline' }]}
        onSubmit={async (v) => {
          const r = await api.post(`/events/${id}/box-office/refunds`, { code: v.code, method: v.method || undefined, reason: v.reason });
          toast(t('pro.refunded', { amount: moneyIn(r.refunded_minor, r.currency) })); till.reload(); return null;
        }} />
      <FormSheet visible={closeForm} onClose={() => setCloseForm(false)} title={t('pro.till_close')} submitLabel={t('pro.till_close')}
        fields={[{ key: 'counted', label: t('pro.till_counted'), type: 'money', currency: () => tl.currency, hint: t('pro.till_expected', { amount: moneyIn(tl.totals.cash_expected_minor, tl.currency) }) }, { key: 'note', label: t('pro.till_note'), type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/ticket-tills/${tl.id}/close`, { counted_cash_minor: Number(v.counted), note: v.note || undefined }); till.reload(); return null; }} />
    </>
  );
}

/** Organiser: every till with what it took, what it should hold and the variance. */
export function TillsPanel({ id }) {
  const list = useLoad(() => api.get(`/events/${id}/box-office/tills`), [id]);
  const items = list.data?.items ?? [];
  const short = items.filter((x) => x.status === 'closed' && x.variance_minor).length;
  return (
    <>
      <ASection title={t('pro.tills')} sub={t('pro.tills_sub')} />
      {items.length ? <>
        <View style={wrap}><AStat icon="🧾" value={items.length} label={t('pro.tills')} /><AStat icon="🟢" value={items.filter((x) => x.status === 'open').length} label={t('pro.tills_open')} tone={A.green} /><AStat icon="⚠️" value={short} label={t('pro.tills_variance')} tone={short ? A.sun : undefined} /></View>
        {items.map((x) => (
          <ACard key={x.id} pad={14} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AT size={15} weight="800" style={{ flex: 1 }}>{x.operator}{x.label ? ` · ${x.label}` : ''}</AT><ATag label={t(`pro.till_status.${x.status}`)} tone={x.status === 'open' ? A.green : undefined} /></View>
            <AT size={12} color={A.mute}>{stamp(x.opened_at)}{x.closed_at ? ` → ${stamp(x.closed_at)}` : ''}</AT>
            <View style={wrap}>{x.totals.methods.map((m) => <ATag key={m.method} label={`${t(`pro.tender.${m.method}`)} ${moneyIn(m.sales_minor - m.refunds_minor, x.currency)}`} />)}</View>
            {x.status === 'closed' ? <AT size={13} weight="800" color={x.variance_minor ? A.sun : A.green}>{x.variance_minor ? t('pro.variance', { amount: moneyIn(x.variance_minor, x.currency) }) : t('pro.balanced')}</AT> : <AT size={12} color={A.mute}>{t('pro.till_expected', { amount: moneyIn(x.totals.cash_expected_minor, x.currency) })}</AT>}
            {x.close_note ? <AT size={12} color={A.mute}>{x.close_note}</AT> : null}
          </ACard>
        ))}
      </> : <AEmpty emoji="🧾" title={t('pro.tills_none')} sub={t('pro.tills_none_sub')} />}
    </>
  );
}

// ---- scanner session (gate) ---------------------------------------------------------------------------------------------------------------------------
/** A device shift. `session` = { id, label, scans, admitted } kept by the gate panel; closing reports the counts so the organiser can reconcile. */
export function ScannerSession({ id, gate, fixture, session, onStart, onEnd, queued }) {
  const [form, setForm] = useState(false), [closing, setClosing] = useState(false);
  return (
    <ACard pad={14} style={{ gap: 8 }}>
      <AT size={13} weight="800">{t('pro.session')}</AT>
      {session ? <>
        <AT size={12} color={A.mute}>{t('pro.session_on', { label: session.label, scans: session.scans, admitted: session.admitted })}</AT>
        {queued ? <AT size={12} weight="800" color={A.sun}>{t('pro.session_queued', { n: queued })}</AT> : null}
        <ABtn small tone="ghost" title={t('pro.session_end')} onPress={() => setClosing(true)} />
      </> : <>
        <AT size={12} color={A.mute}>{t('pro.session_none')}</AT>
        <ABtn small title={t('pro.session_start')} onPress={() => setForm(true)} />
      </>}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('pro.session_start')} submitLabel={t('pro.session_start')} fields={[{ key: 'label', label: t('pro.device_label'), hint: t('pro.device_label_hint') }]}
        onSubmit={async (v) => { const s = await api.post(`/events/${id}/tickets/scan-sessions`, { device_label: v.label, access_point_id: gate || undefined, fixture_id: fixture || undefined }); onStart({ id: s.id, label: s.device_label, scans: 0, admitted: 0 }); return null; }} />
      <FormSheet visible={closing} onClose={() => setClosing(false)} title={t('pro.session_end')} submitLabel={t('pro.session_end')} fields={[{ key: 'note', label: t('pro.till_note'), type: 'multiline', optional: true, hint: queued ? t('pro.session_end_queued', { n: queued }) : undefined }]}
        onSubmit={async (v) => { await api.post(`/ticket-scan-sessions/${session.id}/close`, { reported_scans: session.scans, reported_admitted: session.admitted, note: v.note || undefined }); onEnd(); return null; }} />
    </ACard>
  );
}

// ---- organiser: reconciliation ------------------------------------------------------------------------------------------------------------------------
export function ReconcilePanel({ id }) {
  const rec = useLoad(() => api.get(`/events/${id}/tickets/reconciliation`), [id]);
  const act = useDo(rec.reload);
  const [sign, setSign] = useState(false);
  const R = rec.data;
  if (!R) return null;
  const T0 = R.totals;
  return (
    <>
      <ASection title={t('pro.sub.reconcile')} sub={t('pro.reconcile_sub')} action={t('pro.sign')} onAction={() => setSign(true)} />
      <View style={wrap}>
        <AStat icon="✅" value={T0.issued} label={t('tix.stat_issued')} /><AStat icon="🚪" value={T0.attended} label={t('tix.stat_scanned')} tone={A.cyan} />
        <AStat icon="🙈" value={T0.no_show} label={t('pro.no_show')} tone={T0.no_show ? A.sun : undefined} /><AStat icon="📴" value={T0.offline_scans} label={t('pro.offline_scans')} />
        <AStat icon="⚠️" value={T0.missing_scans} label={t('pro.missing_scans')} tone={T0.missing_scans ? A.red : A.green} /><AStat icon="🔁" value={T0.duplicates} label={t('pro.duplicates')} tone={T0.duplicates ? A.sun : undefined} />
      </View>
      <ACard pad={14} style={{ gap: 6, borderColor: R.ready_to_sign ? A.green : A.sun, borderWidth: 1 }}>
        <AT size={14} weight="900" color={R.ready_to_sign ? A.green : A.sun}>{R.ready_to_sign ? `✓ ${t('pro.ready')}` : t('pro.not_ready')}</AT>
        {R.blockers.map((b, i) => <AT key={i} size={12} color={A.mute}>• {b}</AT>)}
      </ACard>
      <ASection title={t('pro.devices')} />
      {R.sessions.length ? R.sessions.map((s) => (
        <ACard key={s.id} pad={14} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AT size={15} weight="800" style={{ flex: 1 }}>{s.device_label}</AT><ATag label={t(`pro.till_status.${s.status}`)} tone={s.status === 'open' ? A.sun : A.green} /></View>
          <AT size={12} color={A.mute}>{s.operator}{s.gate ? ` · ${s.gate}` : ''} · {stamp(s.started_at)}</AT>
          <AT size={13}>{t('pro.session_line', { rec: s.received, adm: s.admitted, dup: s.duplicates, off: s.offline })}</AT>
          {s.missing ? <AT size={13} weight="800" color={A.red}>{t('pro.session_missing', { n: s.missing })}</AT> : s.reported_scans != null ? <AT size={12} color={A.green}>✓ {t('pro.session_synced')}</AT> : null}
        </ACard>
      )) : <AEmpty emoji="📱" title={t('pro.no_sessions')} sub={t('pro.no_sessions_sub')} />}
      {R.conflicts.length ? <>
        <ASection title={t('pro.conflicts')} sub={t('pro.conflicts_sub')} />
        {R.conflicts.map((x) => <ARow key={x.serial} title={x.serial} sub={t('pro.conflict_line', { devices: (x.device_labels ?? []).join(', '), n: x.duplicates })} right={<ATag label={x.class} />} />)}
      </> : null}
      {R.signed.length ? <>
        <ASection title={t('pro.signed')} />
        {R.signed.map((x) => <ARow key={x.id} title={x.signed_by} sub={`${stamp(x.signed_at)}${x.note ? ` · ${x.note}` : ''}`} />)}
      </> : null}
      <FormSheet visible={sign} onClose={() => setSign(false)} title={t('pro.sign')} submitLabel={t('pro.sign')} fields={[{ key: 'note', label: t('pro.till_note'), type: 'multiline', optional: true }, { key: 'accept', label: t('pro.accept_gaps'), type: 'switch', show: () => !R.ready_to_sign }]}
        onSubmit={async (v) => { await act(() => api.post(`/events/${id}/tickets/reconciliation`, { note: v.note || undefined, accept_gaps: !!v.accept }), t('pro.signed_done')); return null; }} />
    </>
  );
}

// ---- organiser: fans ----------------------------------------------------------------------------------------------------------------------------------
export function FansPanel({ id }) {
  const [segment, setSegment] = useState(''), [q, setQ] = useState('');
  const fans = useLoad(() => api.get(`/events/${id}/tickets/fans`, { segment: segment || undefined, q: q || undefined, limit: 50 }), [id, segment, q]);
  const F = fans.data;
  return (
    <>
      <ASection title={t('pro.sub.fans')} sub={t('pro.fans_sub')} />
      {F ? <>
        <View style={wrap}>
          {['new', 'returning', 'pass_holder', 'vip', 'no_show'].map((s) => <AStat key={s} icon={{ new: '🌱', returning: '🔁', pass_holder: '🎫', vip: '⭐', no_show: '🙈' }[s]} value={F.segments[s]} label={t(`pro.seg.${s}`)} tone={segment === s ? A.violet : undefined} />)}
          <AStat icon="👤" value={F.guests.tickets} label={t('pro.seg.guest')} /><AStat icon="📣" value={F.may_contact} label={t('pro.may_contact')} tone={A.green} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <AChip label={t('pro.seg.all')} active={!segment} onPress={() => setSegment('')} />
          {['new', 'returning', 'pass_holder', 'vip', 'no_show'].map((s) => <AChip key={s} label={`${t(`pro.seg.${s}`)} · ${F.segments[s]}`} active={segment === s} onPress={() => setSegment(s)} />)}
        </View>
        <TextInput value={q} onChangeText={setQ} placeholder={t('pro.fans_search')} placeholderTextColor={A.mute} accessibilityLabel={t('pro.fans_search')} style={inputStyle} />
        {F.items.length ? F.items.map((p) => (
          <ARow key={p.user_id} title={p.display_name} sub={`${t('pro.fan_line', { tickets: p.tickets, attended: p.attended })} · ${p.spend.map((x) => moneyIn(x.net_minor, x.currency)).join(' + ') || t('tix.free')}`}
            right={<View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 170 }}>{p.segments.map((s) => <ATag key={s} label={t(`pro.seg.${s}`)} tone={s === 'vip' ? A.sun : s === 'no_show' ? A.red : undefined} />)}{p.may_contact ? <ATag label="📣" tone={A.green} /> : null}</View>} />
        )) : <AEmpty emoji="🫶" title={t('pro.fans_none')} sub={t('pro.fans_none_sub')} />}
        <AT size={11} color={A.mute}>{t('pro.fans_privacy')}</AT>
      </> : null}
    </>
  );
}
