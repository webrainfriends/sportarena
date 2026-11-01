// Ticketing completion (#699): promo codes, waitlist, parking and merchandise add-ons, resale rules and the commerce report. These are parts of the
// ONE ticketing experience, not a second console: the organiser panels plug into TicketsTab (event-tickets.js) as sub-tabs and into its overview and
// rules; the buyer pieces plug into TicketShop and MyTickets; the gate collects add-ons in TicketGatePanel. All rules live in the API
// (src/capabilities/ticketing-commerce.js); this only calls it.
import React, { useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useDo } from './console-utils';
import { A, ABtn, ACard, AEmpty, ARow, ASection, AStat, AT, ATag } from '../arena';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Sheet, T } from '../ui';
import { Counter } from '../pickers';
import { QrCode } from './passport';
import { c } from '../theme';
import { locale } from '../locale';
import { moneyIn } from '../vtime';
import { t } from '../i18n';

const stamp = (d) => (d ? new Date(d).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

// ---- organiser: promo codes ----------------------------------------------------------------------------------------------------------------------
export function PromoPanel({ id, products }) {
  const list = useLoad(() => api.get(`/events/${id}/ticket-promos`), [id]);
  const act = useDo(list.reload);
  const [form, setForm] = useState(false);
  const prods = (products ?? []).filter((p) => p.status !== 'archived');
  const cur = prods[0]?.currency;
  return (
    <>
      <ASection title={t('tix2.sub.promos')} sub={t('tix2.promo_sub')} action={t('tix2.promo_new')} onAction={() => setForm(true)} />
      {(list.data ?? []).length ? list.data.map((d) => (
        <ACard key={d.id} pad={14} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AT size={16} weight="800" style={{ flex: 1, letterSpacing: 1 }}>{d.code}</AT>
            <ATag label={d.active ? t('tix2.live') : t('tix2.off')} tone={d.active ? A.green : undefined} />
          </View>
          <AT size={13} color={A.mute}>{d.kind === 'percent' ? `${d.value}%` : moneyIn(d.value, d.currency)}{d.max_discount_minor ? ` · ${t('tix2.promo_cap_line', { amount: moneyIn(d.max_discount_minor, d.currency ?? cur) })}` : ''}{d.stackable ? ` · ${t('tix2.promo_stacks')}` : ` · ${t('tix2.promo_exclusive')}`}</AT>
          <AT size={12} color={A.mute}>{t('tix2.promo_usage', { used: d.uses, max: d.max_redemptions ?? '∞', held: d.held })} · {t('tix2.promo_given', { amount: moneyIn(d.discount_minor, d.currency ?? cur) })}</AT>
          {d.valid_from || d.valid_to ? <AT size={12} color={A.mute}>{[d.valid_from && String(d.valid_from).slice(0, 10), d.valid_to && String(d.valid_to).slice(0, 10)].filter(Boolean).join(' → ')}</AT> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <ABtn small tone={d.active ? 'ghost' : 'hero'} title={d.active ? t('tix2.promo_off') : t('tix2.promo_on')} onPress={() => act(() => api.patch(`/ticket-promos/${d.id}`, { active: !d.active }), t('common.done'))} />
          </View>
        </ACard>
      )) : <AEmpty emoji="🏷️" title={t('tix2.promo_none')} sub={t('tix2.promo_none_sub')} action={t('tix2.promo_new')} onAction={() => setForm(true)} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('tix2.promo_new')} submitLabel={t('tix.create')} initial={{ kind: 'percent', value_pct: 10, currency: cur, stackable: false, product_ids: [] }}
        fields={[
          { key: 'code', label: t('tix2.promo_code'), hint: t('tix2.promo_code_hint') },
          { key: 'kind', label: t('tix2.promo_kind'), type: 'chips', options: [{ value: 'percent', label: t('tix2.promo_percent') }, { value: 'fixed', label: t('tix2.promo_fixed') }] },
          { key: 'currency', label: t('tix.currency'), type: 'currency' },
          { key: 'value_pct', label: t('tix2.promo_value'), type: 'stepper', min: 1, max: 100, suffix: '%', show: (v) => v.kind === 'percent' },
          { key: 'value_money', label: t('tix2.promo_value'), type: 'money', currency: (v) => v.currency || cur, show: (v) => v.kind === 'fixed' },
          { key: 'cap', label: t('tix2.promo_cap'), type: 'money', currency: (v) => v.currency || cur, optional: true, hint: t('tix2.promo_cap_hint') },
          { key: 'window', label: t('tix2.promo_window'), type: 'daterange', toKey: 'window_to', optional: true },
          { key: 'max_redemptions', label: t('tix2.promo_total'), type: 'number', optional: true },
          { key: 'per_user_limit', label: t('tix2.promo_per_account'), type: 'number', optional: true },
          { key: 'product_ids', label: t('tix2.promo_products'), type: 'multimenu', optional: true, options: prods.map((p) => ({ value: p.id, label: p.name })), hint: t('tix2.promo_all') },
          { key: 'stackable', label: t('tix2.promo_stack'), type: 'switch' },
        ]}
        onSubmit={async (v) => {
          const percent = v.kind === 'percent';
          await api.post(`/events/${id}/ticket-promos`, {
            code: v.code, kind: v.kind, value: percent ? v.value_pct : Number(v.value_money), currency: v.currency || undefined,
            max_discount_minor: Number(v.cap) > 0 ? Number(v.cap) : undefined, valid_from: v.window || undefined, valid_to: v.window_to || undefined,
            max_redemptions: v.max_redemptions === '' || v.max_redemptions == null ? undefined : Number(v.max_redemptions), per_user_limit: v.per_user_limit === '' || v.per_user_limit == null ? undefined : Number(v.per_user_limit),
            product_ids: v.product_ids ?? [], stackable: !!v.stackable,
          });
          list.reload(); return null;
        }} />
    </>
  );
}

// ---- organiser: add-ons --------------------------------------------------------------------------------------------------------------------------
export function AddonPanel({ id, products }) {
  const list = useLoad(() => api.get(`/events/${id}/ticket-addons`), [id]);
  const act = useDo(list.reload);
  const [form, setForm] = useState(null);
  const cur = (products ?? [])[0]?.currency;
  const edit = !!form?.id;
  return (
    <>
      <ASection title={t('tix2.sub.addons')} sub={t('tix2.addon_sub')} action={t('tix2.addon_new')} onAction={() => setForm({})} />
      {(list.data ?? []).length ? list.data.map((a) => (
        <ACard key={a.id} pad={14} style={{ gap: 6 }} onPress={() => setForm(a)}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AT size={15} weight="800" style={{ flex: 1 }}>{a.name}</AT><ATag label={t(`tix.status.${a.status}`)} tone={a.status === 'active' ? A.green : undefined} /></View>
          <AT size={12} color={A.mute}>{t(`tix2.addon_kind_${a.kind}`)} · {a.price_minor ? moneyIn(a.price_minor, a.currency) : t('tix.free')}{a.collect_note ? ` · ${a.collect_note}` : ''}</AT>
          <AT size={12} color={A.mute}>{t('tix2.addon_line', { sold: a.sold, collected: a.collected, left: a.left ?? '∞' })}</AT>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {a.status !== 'active' ? <ABtn small title={t('tix.put_on_sale')} onPress={() => act(() => api.patch(`/ticket-addons/${a.id}`, { status: 'active' }), t('tix.on_sale'))} /> : <ABtn small tone="ghost" title={t('tix.pause')} onPress={() => act(() => api.patch(`/ticket-addons/${a.id}`, { status: 'paused' }), t('common.done'))} />}
            {a.status !== 'archived' ? <ABtn small tone="ghost" title={t('tix.archive')} onPress={() => act(() => api.patch(`/ticket-addons/${a.id}`, { status: 'archived' }), t('tix.archived'))} /> : null}
          </View>
        </ACard>
      )) : <AEmpty emoji="🅿️" title={t('tix2.addon_none')} sub={t('tix2.addon_none_sub')} action={t('tix2.addon_new')} onAction={() => setForm({})} />}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? t('tix2.addon_edit') : t('tix2.addon_new')} submitLabel={edit ? t('common.save') : t('tix.create')}
        initial={edit ? { ...form, tax_pct: form.tax_bp / 100, stock: form.stock ?? '' } : { kind: 'parking', currency: cur, tax_pct: 0, tax_inclusive: true, per_order_limit: 4 }}
        fields={[
          { key: 'kind', label: t('tix2.addon_kind'), type: 'chips', options: ['parking', 'merchandise', 'other'].map((x) => ({ value: x, label: t(`tix2.addon_kind_${x}`) })), show: () => !edit },
          { key: 'name', label: t('tix2.addon_name') },
          { key: 'collect_note', label: t('tix2.addon_collect'), optional: true, hint: t('tix2.addon_collect_hint') },
          { key: 'currency', label: t('tix.currency'), type: 'currency', show: () => !edit },
          { key: 'price_minor', label: t('tix.price_each'), type: 'money', currency: (v) => v.currency || cur, optional: true },
          { key: 'tax_pct', label: t('tix.tax'), type: 'stepper', min: 0, max: 100, suffix: '%' },
          { key: 'tax_inclusive', label: t('tix.tax_inclusive'), type: 'switch' },
          { key: 'stock', label: t('tix2.addon_stock'), type: 'number', optional: true, hint: t('tix.allocation_hint') },
          { key: 'per_order_limit', label: t('tix.per_order'), type: 'stepper', min: 1, max: 100 },
        ]}
        onSubmit={async (v) => {
          const body = { name: v.name, collect_note: v.collect_note || null, price_minor: Number(v.price_minor) || 0, tax_bp: Math.round(Number(v.tax_pct) * 100), tax_inclusive: !!v.tax_inclusive, stock: v.stock === '' || v.stock == null ? null : Number(v.stock), per_order_limit: v.per_order_limit };
          if (edit) await api.patch(`/ticket-addons/${form.id}`, body);
          else await api.post(`/events/${id}/ticket-addons`, { ...body, kind: v.kind, currency: v.currency, status: 'active' });
          list.reload(); return null;
        }} />
    </>
  );
}

// ---- organiser: waitlist -------------------------------------------------------------------------------------------------------------------------
export function WaitlistPanel({ id }) {
  const wl = useLoad(() => api.get(`/events/${id}/ticket-waitlist`), [id]);
  const rows = wl.data?.products ?? [];
  return (
    <>
      <ASection title={t('tix2.sub.waitlist')} sub={t('tix2.wl_sub')} />
      {wl.data && !wl.data.enabled ? <AT size={13} color={A.sun} weight="800">{t('tix2.wl_off')}</AT> : null}
      {rows.length ? rows.map((r) => (
        <ACard key={r.product_id} pad={14} style={{ gap: 4 }}>
          <AT size={15} weight="800">{r.name}</AT>
          <AT size={13} color={A.mute}>{t('tix2.wl_line', { waiting: r.waiting, places: r.places_wanted, offered: r.offered })}</AT>
          <AT size={12} color={A.mute}>{t('tix2.wl_outcome', { bought: r.purchased, lapsed: r.expired, passed: r.passed + r.left_queue })}</AT>
        </ACard>
      )) : <AEmpty emoji="⏳" title={t('tix2.wl_none')} sub={t('tix2.wl_none_sub')} />}
    </>
  );
}

// ---- organiser: report additions and policy history ------------------------------------------------------------------------------------------
export function CommerceReport({ R }) {
  if (!R) return null;
  const rec = R.reconciliation;
  const money = (n) => (R.currency ? moneyIn(n, R.currency) : String(n));
  return (
    <>
      <ASection title={t('tix2.r_title')} sub={t('tix2.r_sub')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="🏷️" value={money(R.totals.discount)} label={t('tix2.r_discounts')} tone={R.totals.discount ? A.sun : undefined} />
        <AStat icon="🅿️" value={money(R.totals.addons)} label={t('tix2.r_addons')} tone={A.cyan} />
        <AStat icon={rec.reconciled ? '✅' : '⚠️'} value={rec.reconciled ? t('tix2.r_yes') : money(rec.difference_minor)} label={t('tix2.r_reconciled')} tone={rec.reconciled ? A.green : A.sun} />
      </View>
      {R.channels.map((ch) => <ARow key={ch.channel} title={t(`tix.channel.${ch.channel}`)} sub={t('tix2.r_channel_line', { orders: ch.orders, tickets: ch.tickets })} right={<AT size={16} weight="900" num>{money(ch.total_minor)}</AT>} />)}
      {R.promos.map((p) => <ARow key={p.id} title={p.code} sub={t('tix2.promo_usage', { used: p.uses, max: p.max_redemptions ?? '∞', held: p.held })} right={<AT size={14} weight="800" num>{money(p.discount_minor)}</AT>} />)}
      {R.addons.map((a) => <ARow key={a.id} title={a.name} sub={`${t('tix2.addon_line', { sold: a.sold, collected: a.collected, left: a.left ?? '∞' })} · ${t('tix2.attach', { pct: a.attach_rate })}`} right={<AT size={14} weight="800" num>{money(a.gross_minor - a.refunded_minor)}</AT>} />)}
    </>
  );
}

export function PolicyHistory({ id, version }) {
  const h = useLoad(() => api.get(`/events/${id}/tickets/policy-history`), [id, version]);
  const rows = h.data?.history ?? [];
  const val = (field, x) => {
    if (x === null || x === undefined) return '–';
    if (typeof x === 'boolean') return x ? t('tix2.on') : t('tix2.off');
    if (field.endsWith('_bp')) return `${Math.round(x / 100)}%`;
    if (field === 'resale_mode') return x === 'resale' ? t('tix2.resale_resale') : t('tix2.resale_transfer_only');
    if (field === 'refund_policy') return t(`tix.policy_short.${x}`);
    if (field.endsWith('_hours')) return `${x} h`;
    if (field.endsWith('_minutes')) return `${x} min`;
    return String(x);
  };
  return (
    <>
      <ASection title={t('tix2.history')} sub={t('tix2.history_sub')} />
      {h.data?.resales?.count ? <AT size={13} color={A.mute}>{t('tix2.resales_summary', { n: h.data.resales.count, fee: moneyIn(h.data.resales.fee_owed_minor, h.data.resales.currency) })}</AT> : null}
      {rows.length ? rows.slice(0, 12).map((r) => <ARow key={r.id} title={t(`tix2.field.${r.field}`)} sub={`${stamp(r.at)} · ${r.actor ?? ''}`} right={<AT size={13} weight="800">{val(r.field, r.old_value)} → {val(r.field, r.new_value)}</AT>} />) : <AT size={13} color={A.mute}>{t('tix2.history_none')}</AT>}
    </>
  );
}

/** The extra fields of the existing rules form (resale and waitlist), and how they go back to the API. */
export const ruleFields = () => [
  { key: 'resale_mode', label: t('tix2.resale_mode'), type: 'choice', options: [{ value: 'transfer_only', label: t('tix2.resale_transfer_only') }, { value: 'resale', label: t('tix2.resale_resale') }], show: (v) => v.transfer_allowed },
  { key: 'resale_cap_pct', label: t('tix2.resale_cap'), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', show: (v) => v.transfer_allowed && v.resale_mode === 'resale', hint: t('tix2.resale_cap_hint') },
  { key: 'resale_fee_pct', label: t('tix2.resale_fee'), type: 'stepper', min: 0, max: 50, step: 1, suffix: '%', show: (v) => v.transfer_allowed && v.resale_mode === 'resale' },
  { key: 'waitlist_enabled', label: t('tix2.wl_on'), type: 'switch' },
  { key: 'waitlist_offer_minutes', label: t('tix2.wl_minutes'), type: 'stepper', min: 5, max: 120, step: 5, suffix: ' min', show: (v) => v.waitlist_enabled },
];
export const ruleInitial = (S) => ({ ...S, resale_cap_pct: Math.round((S?.resale_cap_bp ?? 10000) / 100), resale_fee_pct: Math.round((S?.resale_fee_bp ?? 0) / 100) });
export const ruleBody = (v) => ({
  resale_mode: v.transfer_allowed ? v.resale_mode : 'transfer_only', resale_cap_bp: Math.round(Number(v.resale_cap_pct ?? 100) * 100), resale_fee_bp: Math.round(Number(v.resale_fee_pct ?? 0) * 100),
  waitlist_enabled: !!v.waitlist_enabled, waitlist_offer_minutes: v.waitlist_offer_minutes,
});
export const resaleLine = (S) => (S.transfer_allowed && S.resale_mode === 'resale' ? t('tix2.resale_line', { cap: Math.round(S.resale_cap_bp / 100), fee: Math.round(S.resale_fee_bp / 100) }) : t('tix2.resale_line_only'));

// ---- buyer: shop pieces ----------------------------------------------------------------------------------------------------------------------------
const inputStyle = { flex: 1, minWidth: 0, minHeight: 48, borderRadius: 12, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper, color: c.ink, paddingHorizontal: 12, fontSize: 16 };

export function PromoBox({ applied, error, busy, onApply, onRemove }) {
  const [text, setText] = useState('');
  const add = () => { const code = text.trim(); if (code) { onApply(code); setText(''); } };
  return (
    <Card style={{ gap: 8 }}>
      <T size={15} weight="800">{t('tix2.promo_label')}</T>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput value={text} onChangeText={setText} onSubmitEditing={add} autoCapitalize="characters" autoCorrect={false} placeholder={t('tix2.promo_placeholder')} placeholderTextColor={c.mute} accessibilityLabel={t('tix2.promo_label')} style={inputStyle} />
        <Btn small title={t('tix2.apply')} onPress={add} loading={busy} disabled={!text.trim()} accessibilityLabel={t('tix2.apply')} />
      </View>
      {applied.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {applied.map((code) => <Btn key={code} small title={`${code} ✕`} color={c.limeSoft} ink={c.lime} onPress={() => onRemove(code)} accessibilityLabel={t('tix2.promo_remove', { code })} />)}
      </View> : null}
      {error ? <T size={12} color={c.red} weight="700" accessibilityRole="alert">{error}</T> : null}
    </Card>
  );
}

export function AddonPicker({ addons, qty, onChange }) {
  if (!addons.length) return null;
  return (
    <Card style={{ gap: 10 }}>
      <T size={17} weight="800">{t('tix2.addons')}</T>
      {addons.map((a) => {
        const sellable = ['available', 'low'].includes(a.availability);
        const max = Math.min(a.per_order_limit, a.remaining ?? a.per_order_limit);
        return (
          <View key={a.id} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={15} weight="800">{a.name}</T>
                <T size={12} color={c.mute}>{t(`tix2.addon_kind_${a.kind}`)}{a.collect_note ? ` · ${a.collect_note}` : ''}{a.remaining != null ? ` · ${t('tix2.addon_left', { n: a.remaining })}` : ''}</T>
              </View>
              <T size={15} weight="800">{a.price_minor ? moneyIn(a.price_minor, a.currency) : t('tix.free')}</T>
            </View>
            {sellable ? <View style={{ minWidth: 190, flexShrink: 1 }}><Counter value={qty[a.id] ?? 0} onChange={(n) => onChange(a, n)} min={0} max={max} a11y={a.name} /></View> : <T size={12} weight="800" color={c.red}>{t(`tix.avail.${a.availability}`)}</T>}
          </View>
        );
      })}
    </Card>
  );
}

export function WaitlistJoin({ product, onJoined }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  if (!product.waitlist?.open) return null;
  const join = async () => {
    setBusy(true);
    try { await api.post(`/ticket-products/${product.id}/waitlist`, { quantity: 1 }); toast(t('tix2.wl_joined')); onJoined(); } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 4 }}>
      <Btn small title={`${t('tix2.wl_join')}${product.waitlist.ahead ? ` · ${t('tix2.wl_ahead', { n: product.waitlist.ahead })}` : ''}`} color={c.paper} ink={c.pink} onPress={join} loading={busy} accessibilityLabel={t('tix2.wl_join')} />
      <T size={12} color={c.mute}>{t('tix2.wl_note')}</T>
    </View>
  );
}

// ---- buyer: my tickets pieces ----------------------------------------------------------------------------------------------------------------------
export function MyWaitlist({ onPay, onChanged }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/ticket-waitlist'), []);
  const items = (list.data?.items ?? []).filter((w) => ['waiting', 'offered'].includes(w.status));
  if (!items.length) return null;
  const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); list.reload(); onChanged?.(); } catch (x) { toast('' + x.message); } };
  return (
    <View style={{ gap: 10 }}>
      <T size={18} weight="800">{t('tix2.my_waitlist')}</T>
      {items.map((w) => (
        <Card key={w.id} style={{ gap: 8, borderWidth: w.status === 'offered' ? 2 : 0, borderColor: c.pink }}>
          {w.status === 'offered' ? (
            <>
              <T size={16} weight="800">{t('tix2.offer_title')}</T>
              <T size={13} color={c.mute}>{t('tix2.offer_body', { qty: w.quantity, name: w.product_name, event: w.event_name })}</T>
              <T size={12} weight="800" color={c.sun}>{t('tix2.offer_until', { when: stamp(w.offer_expires_at) })}</T>
              <Btn title={w.order?.total_minor ? `${t('tix2.offer_buy')} · ${moneyIn(w.order.total_minor, w.order.currency)}` : t('tix2.offer_buy')} accessibilityLabel={t('tix2.offer_buy')}
                onPress={() => (w.order?.total_minor ? onPay({ id: w.order.id, type: 'ticket_order', label: `${w.event_name} · ${t('tix.tickets')}`, amount: w.order.total_minor, currency: w.order.currency }) : run(() => api.post(`/ticket-waitlist/${w.id}/accept`, {}), t('tix.ready')))} />
              <Btn small title={t('tix2.offer_pass')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/ticket-waitlist/${w.id}/leave`, {}))} accessibilityLabel={t('tix2.offer_pass')} />
            </>
          ) : (
            <>
              <T size={15} weight="800">{w.product_name}</T>
              <T size={13} color={c.mute}>{w.event_name} · {t('tix2.position', { n: w.position })}</T>
              <Btn small title={t('tix2.wl_leave')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/ticket-waitlist/${w.id}/leave`, {}))} accessibilityLabel={t('tix2.wl_leave')} />
            </>
          )}
        </Card>
      ))}
    </View>
  );
}

const ADDON_TONE = { issued: c.cyan, collected: c.mute, refund_due: c.sun, refunded: c.mute };
export function MyAddons({ onChanged }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/ticket-addons'), []);
  const [refund, setRefund] = useState(null);
  const items = list.data?.items ?? [];
  if (!items.length) return null;
  return (
    <View style={{ gap: 10 }}>
      <T size={18} weight="800">{t('tix2.my_addons')}</T>
      {items.map((a) => (
        <Card key={a.id} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={15} weight="800" style={{ flex: 1 }}>{a.name}</T><T size={12} weight="800" color={ADDON_TONE[a.status]}>{t(`tix2.addon_state.${a.status}`)}</T></View>
          <T size={12} color={c.mute}>{a.event.name}{a.collect_note ? ` · ${t('tix2.collect_at', { where: a.collect_note })}` : ''}</T>
          {a.token ? (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <QrCode value={a.token} size={Platform.OS === 'web' ? 180 : 200} label={t('tix.qr_label', { name: a.name })} />
              <T size={14} weight="800" style={{ letterSpacing: 2 }} accessibilityLabel={t('tix.code_label')}>{a.short_code}</T>
            </View>
          ) : null}
          {a.status === 'issued' ? <Btn small title={t('tix2.addon_refund')} color={c.paper} ink={c.ink} onPress={() => setRefund(a)} accessibilityLabel={t('tix2.addon_refund')} /> : null}
        </Card>
      ))}
      <Sheet visible={!!refund} onClose={() => setRefund(null)} title={t('tix.refund_title')}
        footer={<Btn title={t('tix.refund_confirm')} onPress={async () => { const a = refund; setRefund(null); try { await api.post(`/ticket-addon-items/${a.id}/refund`, {}); toast(t('tix.refund_started')); list.reload(); onChanged?.(); } catch (x) { toast('' + x.message); } }} />}>
        <T>{t('tix.refund_body', { amount: refund ? moneyIn(refund.price_minor, refund.currency) : '' })}</T>
      </Sheet>
    </View>
  );
}
