// Academy kit (#798): the Kit section of Organisation > Academy. Overview (coverage, due, loans, approvals, stock and shortages), the issue desk, entitlements by
// programme / group / squad, damaged-or-lost approvals, replenishment from the academy's suppliers and the stock monitor. The API enforces every rule and
// every permission; this screen only calls it and hides what the server would refuse. All text goes through t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Empty, Loading, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { Bars, Block, Kpi } from './academy-ui';
import { KitIssueDesk, HeldCard, StatusTag, day, kitError } from './academy-kit-desk';

const pctText = (v) => (v == null ? '—' : `${v}%`);
const tidy = (s) => (s ? String(s).replace(/[_-]/g, ' ') : '');

// ------------------------------------------------------------------------------------------------------------------ overview
function Overview({ d, go }) {
  const x = d.data;
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!x) return <Loading />;
  if (!x.required && !x.stock.length) {
    return (
      <View style={{ gap: 10 }}>
        <Empty emoji="🎽" title={t('kit.empty_overview_title')} sub={t('kit.empty_overview_sub')} />
        {go ? <Btn title={t('kit.add_entitlement')} onPress={() => go('entitlements')} style={{ alignSelf: 'center' }} /> : null}
      </View>
    );
  }
  const money = (rows) => (rows?.length ? rows.map((r) => moneyIn(r.minor, r.currency)).join(' · ') : '—');
  const short = x.shortages.filter((s) => s.short > 0 || s.awaiting_fitting).slice(0, 8);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('kit.k_coverage')} value={pctText(x.coverage_pct)} sub={t('kit.k_coverage_sub', { done: x.fulfilled, total: x.required })} />
        <Kpi label={t('kit.k_due')} value={x.due} sub={x.overdue_due ? t('kit.k_overdue_n', { n: x.overdue_due }) : t('kit.k_none_overdue')} tone={x.overdue_due ? 'alert' : undefined} onPress={() => go?.('issue')} />
        <Kpi label={t('kit.k_fitting')} value={x.awaiting_fitting} sub={t('kit.k_fitting_sub')} onPress={() => go?.('issue')} />
        <Kpi label={t('kit.k_loans')} value={x.on_loan} sub={x.overdue_returns ? t('kit.k_overdue_returns', { n: x.overdue_returns }) : t('kit.k_none_overdue')} tone={x.overdue_returns ? 'alert' : undefined} onPress={() => go?.('issue')} />
        <Kpi label={t('kit.k_approvals')} value={x.pending_approvals} sub={t('kit.k_approvals_sub')} tone={x.pending_approvals ? 'alert' : undefined} onPress={x.pending_approvals ? () => go?.('approvals') : undefined} />
        <Kpi label={t('kit.k_low')} value={x.low_stock} sub={t('kit.k_short_n', { n: x.short_lines })} tone={x.low_stock ? 'alert' : undefined} onPress={() => go?.('stock')} />
        {x.deposits_held ? <Kpi label={t('kit.k_deposits')} value={money(x.deposits_held)} sub={t('kit.k_deposits_sub')} /> : null}
        {x.unpaid_kit_charges ? <Kpi label={t('kit.k_unpaid')} value={money(x.unpaid_kit_charges.map((r) => ({ ...r })))} sub={t('kit.k_unpaid_sub', { n: x.unpaid_kit_charges.reduce((n, r) => n + r.count, 0) })} /> : null}
      </View>
      <Block title={t('kit.coverage_title')}>
        <Bars label={t('kit.coverage_title')} rows={[{ label: t('kit.owed'), value: x.required, text: String(x.required) }, { label: t('kit.issued_so_far'), value: x.fulfilled, text: String(x.fulfilled), tone: c.mint }]} />
      </Block>
      <Block title={t('kit.shortages_title')} right={go ? <Btn small title={t('kit.replenish')} color={c.paper} ink={c.ink} onPress={() => go('replenish')} /> : null}>
        {short.length === 0 ? <T size={13} color={c.mute}>{t('kit.no_shortages')}</T> : (
          <Bars label={t('kit.shortages_title')} rows={short.map((s) => ({
            label: `${s.name ?? tidy(s.style_key)}${s.size_label ? ` · ${s.size_label}` : ''}`, value: s.short || s.awaiting_fitting,
            text: s.awaiting_fitting ? t('kit.awaiting_fitting_n', { n: s.awaiting_fitting }) : t('kit.short_line', { short: s.short, hand: s.on_hand, order: s.on_order }), tone: s.short ? c.red : c.sun,
          }))} />
        )}
      </Block>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ entitlements
const MODES = () => [{ value: 'included', label: t('kit.mode_included') }, { value: 'charged', label: t('kit.mode_charged') }, { value: 'deposit', label: t('kit.mode_deposit') }];
const modeLabel = (m) => MODES().find((x) => x.value === m)?.label ?? m;
const SCOPES = () => [{ value: 'programme', label: t('kit.scope_programme') }, { value: 'cohort', label: t('kit.scope_cohort') }, { value: 'team', label: t('kit.scope_team') }];

function Entitlements({ orgId, cat, toast }) {
  const list = useLoad(() => api.get(`/organisations/${orgId}/academy/kit/entitlements`, { include_archived: true }), [orgId]);
  const [edit, setEdit] = useState(null);
  const base = `/organisations/${orgId}/academy/kit`;
  const cur = cat.data?.currency;
  const scopes = cat.data?.scopes ?? {};
  const styles = cat.data?.styles ?? [];
  const venues = cat.data?.venues ?? [];
  const fields = (isNew) => [
    { key: 'name', label: t('kit.ent_name'), hint: t('kit.ent_name_hint') },
    ...(isNew ? [
      { key: 'scope_type', label: t('kit.ent_applies_to'), type: 'chips', options: SCOPES },
      { key: 'scope_id', label: t('kit.ent_which'), type: 'multimenu', max: 1, options: (v) => (scopes[v.scope_type ?? 'programme'] ?? []).map((s) => ({ value: s.id, label: s.name })), hint: t('kit.ent_which_hint') },
      { key: 'style_key', label: t('kit.ent_product'), type: 'multimenu', max: 1, options: styles.map((s) => ({ value: s.style_key, label: s.name, sub: s.sizes.map((z) => z.size_label).filter(Boolean).join(' · ') })), hint: t('kit.ent_product_hint') },
    ] : []),
    { key: 'qty', label: t('kit.ent_qty'), type: 'stepper', min: 1, max: 20, default: 1 },
    { key: 'mode', label: t('kit.ent_mode'), type: 'chips', options: MODES, default: 'included', hint: (v) => ({ included: t('kit.mode_included_hint'), charged: t('kit.mode_charged_hint'), deposit: t('kit.mode_deposit_hint') })[v.mode ?? 'included'] },
    { key: 'price_minor', label: t('kit.ent_price'), type: 'money', currency: cur, optional: true, show: (v) => v.mode === 'charged', hint: t('kit.ent_price_hint') },
    { key: 'deposit_minor', label: t('kit.ent_deposit'), type: 'money', currency: cur, optional: true, show: (v) => v.mode === 'deposit', hint: t('kit.ent_deposit_hint') },
    { key: 'return_days', label: t('kit.ent_return_days'), type: 'stepper', min: 1, max: 1095, step: 5, default: 30, suffix: t('kit.days'), show: (v) => v.mode === 'deposit' },
    { key: 'require_payment', label: t('kit.ent_pay_first'), type: 'switch', show: (v) => v.mode !== 'included', hint: t('kit.ent_pay_first_hint') },
    { key: 'size_required', label: t('kit.ent_sized'), type: 'switch', default: true, hint: t('kit.ent_sized_hint') },
    { key: 'due_rule', label: t('kit.ent_due'), type: 'chips', options: () => [{ value: 'on_enrolment', label: t('kit.due_on_enrolment') }, { value: 'days_after', label: t('kit.due_days_after') }] },
    { key: 'due_days', label: t('kit.ent_due_days'), type: 'stepper', min: 0, max: 365, default: 14, suffix: t('kit.days'), show: (v) => v.due_rule === 'days_after' },
    { key: 'replace_after_months', label: t('kit.ent_replace'), type: 'stepper', min: 1, max: 120, default: 12, suffix: t('kit.months'), optional: true, hint: t('kit.ent_replace_hint') },
    ...(venues.length ? [{ key: 'fulfil_venue_id', label: t('kit.ent_venue'), type: 'multimenu', max: 1, optional: true, options: venues.map((v) => ({ value: v.id, label: v.name })), hint: t('kit.ent_venue_hint') }] : []),
    { key: 'collection_note', label: t('kit.ent_collection'), type: 'multiline', optional: true, hint: t('kit.ent_collection_hint') },
  ];
  const one = (x) => (Array.isArray(x) ? x[0] : x);
  const submit = async (v) => {
    const body = { ...v, scope_id: one(v.scope_id), style_key: one(v.style_key), fulfil_venue_id: one(v.fulfil_venue_id) };
    if (body.mode !== 'charged') delete body.price_minor; if (body.mode !== 'deposit') { delete body.deposit_minor; delete body.return_days; } if (body.mode === 'included') delete body.require_payment;
    try {
      if (edit?.id) { const { scope_type, scope_id, style_key, ...rest } = body; await api.patch(`/academy/kit/entitlements/${edit.id}`, { ...rest, row_version: edit.row_version }); } else await api.post(`${base}/entitlements`, body);
    } catch (e) { throw new Error(kitError(e)); }
    toast(t('kit.ent_saved')); setEdit(null); list.reload();
  };
  const archive = async (e, archived) => { try { await api.patch(`/academy/kit/entitlements/${e.id}`, { row_version: e.row_version, archived }); toast(archived ? t('kit.ent_archived') : t('kit.ent_restored')); list.reload(); } catch (err) { toast(explain(err)); } };
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T size={13} color={c.mute} style={{ flex: 1, minWidth: 200 }}>{t('kit.ent_intro')}</T>
        <Btn small title={t('kit.add_entitlement')} onPress={() => setEdit({})} disabled={!styles.length} accessibilityLabel={t('kit.add_entitlement')} />
      </View>
      {!styles.length && cat.data ? <Card color={c.sunSoft} pad={12}><T weight="800">{t('kit.no_stock_yet')}</T><T size={13} color={c.mute}>{t('kit.no_stock_yet_sub')}</T></Card> : null}
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length === 0 ? <Empty emoji="📋" title={t('kit.ent_empty_title')} sub={t('kit.ent_empty_sub')} /> : list.data.map((e) => (
        <Card key={e.id} pad={14} color={e.archived_at ? c.violetSoft : c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <T weight="800" style={{ flexShrink: 1 }}>{e.name}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              <Tag label={modeLabel(e.mode)} color={c.cyanSoft} />
              {e.archived_at ? <Tag label={t('kit.archived')} color={c.violetSoft} /> : null}
            </View>
          </View>
          <T size={13} color={c.mute}>{SCOPES().find((s) => s.value === e.scope_type)?.label}: {e.scope_name} · {tidy(e.style_key)} · {t('kit.qty_n', { n: e.qty })}</T>
          <T size={12} color={c.mute}>
            {[e.price_minor != null ? moneyIn(e.price_minor, cur) : null, e.deposit_minor != null ? t('kit.deposit_amount', { amount: moneyIn(e.deposit_minor, cur) }) : null, e.return_days ? t('kit.back_after', { n: e.return_days }) : null,
              e.replace_after_months ? t('kit.replace_after', { n: e.replace_after_months }) : null, e.require_payment ? t('kit.ent_pay_first') : null, t('kit.in_use_n', { n: e.in_use })].filter(Boolean).join(' · ')}
          </T>
          <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            {e.archived_at ? <Btn small title={t('kit.restore')} color={c.paper} ink={c.ink} onPress={() => archive(e, false)} /> : <><Btn small title={t('kit.archive')} color={c.paper} ink={c.red} onPress={() => archive(e, true)} /><Btn small title={t('kit.edit')} onPress={() => setEdit(e)} /></>}
          </View>
        </Card>
      ))}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t('kit.ent_edit') : t('kit.add_entitlement')} fields={fields(!edit?.id)} onSubmit={submit}
        initial={edit?.id ? { ...edit, collection_note: edit.collection_note ?? undefined, replace_after_months: edit.replace_after_months ?? undefined } : { scope_type: 'programme', mode: 'included', due_rule: 'on_enrolment', size_required: true, qty: 1 }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ approvals
function Approvals({ orgId, cat, toast, onChanged }) {
  const q = useLoad(() => api.get(`/organisations/${orgId}/academy/kit/issues`, { status: 'writeoff_pending', limit: 100 }), [orgId]);
  const [pick, setPick] = useState(null);
  const cur = cat.data?.currency;
  const decide = async (v) => {
    const body = { decision: pick.decision, note: v.note || undefined, forfeit_minor: pick.decision === 'approved' ? v.forfeit_minor : undefined, replacement_minor: pick.decision === 'approved' ? v.replacement_minor : undefined };
    try { await api.post(`/organisations/${orgId}/academy/kit/issues/${pick.r.id}/decision`, body); } catch (e) { throw new Error(kitError(e)); }
    toast(t('kit.decided')); setPick(null); q.reload(); onChanged?.();
  };
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>{t('kit.approvals_intro')}</T>
      {q.error ? <LoadError error={q.error} onRetry={q.reload} /> : !q.data ? <Loading /> : q.data.length === 0 ? <Empty emoji="✅" title={t('kit.approvals_empty_title')} sub={t('kit.approvals_empty_sub')} /> : q.data.map((r) => (
        <View key={r.id} style={{ gap: 6 }}>
          <HeldCard r={r} onReturn={() => {}} onExchange={() => {}} onReport={() => {}} onReceipt={() => {}} onHandover={() => {}} />
          <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {r.writeoff_note ? <T size={12} color={c.mute} style={{ flex: 1, minWidth: 160 }}>{r.writeoff_note}</T> : null}
            <Btn small title={t('kit.reject')} color={c.paper} ink={c.ink} onPress={() => setPick({ r, decision: 'rejected' })} accessibilityLabel={t('kit.reject_a11y', { name: r.athlete })} />
            <Btn small title={t('kit.approve')} onPress={() => setPick({ r, decision: 'approved' })} accessibilityLabel={t('kit.approve_a11y', { name: r.athlete })} />
          </View>
        </View>
      ))}
      <FormSheet visible={!!pick} onClose={() => setPick(null)} title={pick ? `${pick.decision === 'approved' ? t('kit.approve') : t('kit.reject')} · ${pick.r.athlete}` : ''} submitLabel={pick?.decision === 'approved' ? t('kit.approve') : t('kit.reject')}
        notice={pick?.r.deposit ? t('kit.deposit_notice', { amount: moneyIn(pick.r.deposit.amount_minor, pick.r.deposit.currency) }) : undefined}
        fields={[
          ...(pick?.decision === 'approved' ? [
            ...(pick.r.deposit ? [{ key: 'forfeit_minor', label: t('kit.forfeit'), type: 'money', currency: pick.r.deposit.currency ?? cur, optional: true, hint: t('kit.forfeit_hint') }] : []),
            { key: 'replacement_minor', label: t('kit.replacement_fee'), type: 'money', currency: cur, optional: true, hint: t('kit.replacement_fee_hint') },
          ] : []),
          { key: 'note', label: t('kit.note'), type: 'multiline', optional: true },
        ]} onSubmit={decide} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ replenishment
function Replenish({ orgId, cat, toast, onChanged }) {
  const r = useLoad(() => api.get(`/organisations/${orgId}/academy/kit/replenishment`), [orgId]);
  const [order, setOrder] = useState(null);
  const cur = cat.data?.currency;
  if (r.error) return <LoadError error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const lines = r.data.lines.filter((l) => l.short > 0);
  const update = async (o, status) => { try { await api.patch(`/organisations/${orgId}/academy/kit/orders/${o.id}`, { status }); toast(t('kit.order_updated')); r.reload(); onChanged?.(); cat.reload?.(); } catch (e) { toast(kitError(e)); } };
  const send = async (v) => {
    const stocked = lines.filter((l) => l.item_id && v[`q_${l.item_id}`] > 0);
    try {
      await api.post(`/organisations/${orgId}/academy/kit/orders`, { academy_supplier_id: Array.isArray(v.supplier) ? v.supplier[0] : v.supplier, expected_on: v.expected_on || undefined, note: v.note || undefined, lines: stocked.map((l) => ({ item_id: l.item_id, quantity: v[`q_${l.item_id}`], unit_cost_cents: v.unit_cost ? v.unit_cost : undefined })) });
    } catch (e) { throw new Error(kitError(e)); }
    toast(t('kit.order_placed')); setOrder(null); r.reload(); onChanged?.();
  };
  const orderable = lines.filter((l) => l.item_id);
  return (
    <View style={{ gap: 12 }}>
      <Block title={t('kit.shortages_title')} right={<Btn small title={t('kit.order_from_supplier')} onPress={() => setOrder({})} disabled={!orderable.length || !r.data.suppliers.length} />}>
        {lines.length === 0 ? <Empty emoji="📦" title={t('kit.no_shortages')} sub={t('kit.no_shortages_sub')} /> : lines.map((l) => (
          <Card key={`${l.style_key}|${l.size_label}`} pad={12}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800">{l.name ?? tidy(l.style_key)}{l.size_label ? ` · ${l.size_label}` : ''}</T><Tag label={t('kit.short_n', { n: l.short })} color={c.red} /></View>
            <T size={13} color={c.mute}>{t('kit.demand_line', { demand: l.demand, hand: l.on_hand, order: l.on_order })}</T>
            {l.missing_stock_row ? <T size={12} color={c.mute}>{t('kit.missing_row')}</T> : null}
          </Card>
        ))}
        {!r.data.suppliers.length ? <T size={12} color={c.mute}>{t('kit.no_suppliers')}</T> : null}
      </Block>
      <Block title={t('kit.orders_title')}>
        {r.data.orders.length === 0 ? <T size={13} color={c.mute}>{t('kit.orders_empty')}</T> : r.data.orders.map((o) => (
          <Card key={o.id} pad={12}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <T weight="800" style={{ flexShrink: 1 }}>{o.quantity} × {o.name}{o.size_label ? ` (${o.size_label})` : ''}</T>
              <Tag label={({ ordered: t('kit.o_ordered'), shipped: t('kit.o_shipped'), received: t('kit.o_received'), cancelled: t('kit.o_cancelled') })[o.status] ?? o.status} color={o.status === 'received' ? c.mint : o.status === 'cancelled' ? c.violetSoft : c.sunSoft} />
            </View>
            <T size={12} color={c.mute}>{[o.supplier, o.venue, o.expected_on ? t('kit.expected_on', { date: day(o.expected_on) }) : null, o.unit_cost_cents != null ? moneyIn(o.unit_cost_cents, cur) : null].filter(Boolean).join(' · ')}</T>
            {['ordered', 'shipped'].includes(o.status) ? (
              <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
                <Btn small title={t('kit.o_cancel')} color={c.paper} ink={c.red} onPress={() => update(o, 'cancelled')} />
                {o.status === 'ordered' ? <Btn small title={t('kit.o_mark_shipped')} color={c.paper} ink={c.ink} onPress={() => update(o, 'shipped')} /> : null}
                {o.serialised ? <T size={12} color={c.mute}>{t('kit.serial_receive_hint')}</T> : <Btn small title={t('kit.o_mark_received')} onPress={() => update(o, 'received')} />}
              </View>
            ) : null}
          </Card>
        ))}
      </Block>
      <FormSheet visible={!!order} onClose={() => setOrder(null)} title={t('kit.order_from_supplier')} submitLabel={t('kit.place_order')} notice={t('kit.order_notice')}
        fields={[
          { key: 'supplier', label: t('kit.supplier'), type: 'multimenu', max: 1, options: r.data.suppliers.map((s) => ({ value: s.id, label: s.name, sub: tidy(s.kind) })) },
          ...orderable.map((l) => ({ key: `q_${l.item_id}`, label: `${l.name ?? tidy(l.style_key)}${l.size_label ? ` · ${l.size_label}` : ''}`, type: 'stepper', min: 0, max: 100000, step: 1, default: l.short, hint: t('kit.short_n', { n: l.short }) })),
          { key: 'unit_cost', label: t('kit.unit_cost'), type: 'money', currency: cur, optional: true },
          { key: 'expected_on', label: t('kit.expected'), type: 'date', optional: true },
          { key: 'note', label: t('kit.note'), type: 'multiline', optional: true },
        ]} onSubmit={send} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ stock monitor
function Stock({ d, cat, orgId, toast, onChanged }) {
  const [add, setAdd] = useState(null);
  const [serials, setSerials] = useState(null);
  const venues = cat.data?.venues ?? [];
  const slots = [...new Map((cat.data?.sports ?? []).flatMap((s) => s.slots).map((x) => [x.key, x])).values()];
  const x = d.data;
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!x) return <Loading />;
  const byStyle = [...x.stock.reduce((m, s) => m.set(s.style_key, [...(m.get(s.style_key) ?? []), s]), new Map())];
  const save = async (v) => {
    const venue = Array.isArray(v.venue_id) ? v.venue_id[0] : v.venue_id;
    const body = { venue_id: venue, name: v.name, category: 'apparel', quantity: v.serialised ? 0 : v.quantity, style_key: v.style_key, size_label: v.size_label || undefined, kit_slot: v.kit_slot || undefined, barcode: v.barcode || undefined, serialised: !!v.serialised, reorder_level: v.reorder_level };
    try { await api.post('/inventory', body); } catch (e) { throw new Error(kitError(e)); }
    toast(t('kit.stock_added')); setAdd(null); d.reload(); cat.reload?.(); onChanged?.();
  };
  const reg = async (v) => {
    const list = String(v.serials ?? '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    try { await api.post(`/organisations/${orgId}/academy/kit/units`, { item_id: serials.item_id, serials: list }); } catch (e) { throw new Error(kitError(e)); }
    toast(t('kit.units_added', { n: list.length })); setSerials(null); d.reload(); onChanged?.();
  };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <T size={13} color={c.mute} style={{ flex: 1, minWidth: 200 }}>{t('kit.stock_intro')}</T>
        <Btn small title={t('kit.add_stock')} onPress={() => setAdd({})} disabled={!venues.length} accessibilityLabel={t('kit.add_stock')} />
      </View>
      {!venues.length && cat.data ? <Card color={c.sunSoft} pad={12}><T weight="800">{t('kit.no_venues')}</T><T size={13} color={c.mute}>{t('kit.no_venues_sub')}</T></Card> : null}
      {byStyle.length === 0 ? <Empty emoji="📦" title={t('kit.stock_empty_title')} sub={t('kit.stock_empty_sub')} /> : byStyle.map(([style, rows]) => (
        <Card key={style} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <T weight="800">{rows[0].name ?? tidy(style)}</T>
            <T size={12} color={c.mute}>{t('kit.on_hand_n', { n: rows.reduce((n, s) => n + s.quantity, 0) })}</T>
          </View>
          <View style={{ gap: 6, marginTop: 8 }}>
            {rows.map((s) => (
              <View key={s.item_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <T weight="700" style={{ minWidth: 70 }}>{s.size_label ?? t('kit.one_size')}</T>
                <T style={{ fontVariant: ['tabular-nums'], minWidth: 36 }} weight="800">{s.quantity}</T>
                {s.low ? <Tag label={t('kit.low')} color={c.orangeSoft} /> : null}
                {s.on_order ? <Tag label={t('kit.on_order_n', { n: s.on_order })} color={c.sunSoft} /> : null}
                {s.damaged ? <Tag label={t('kit.damaged_n', { n: s.damaged })} color={c.redSoft} /> : null}
                {s.serialised ? <Tag label={t('kit.serialised')} color={c.cyanSoft} /> : null}
                <T size={12} color={c.mute} style={{ flex: 1, minWidth: 100 }}>{s.venue}</T>
                {s.serialised ? <Btn small title={t('kit.register_units')} color={c.paper} ink={c.ink} onPress={() => setSerials(s)} /> : null}
              </View>
            ))}
          </View>
        </Card>
      ))}
      <FormSheet visible={!!add} onClose={() => setAdd(null)} title={t('kit.add_stock')} submitLabel={t('common.save')}
        initial={{ quantity: 0, reorder_level: 2, venue_id: venues.length === 1 ? [venues[0].id] : undefined }}
        fields={[
          { key: 'name', label: t('kit.product_name') },
          { key: 'style_key', label: t('kit.product_key'), hint: t('kit.product_key_hint') },
          { key: 'size_label', label: t('kit.size'), optional: true, hint: t('kit.size_label_hint') },
          { key: 'kit_slot', label: t('kit.slot'), type: 'multimenu', max: 1, optional: true, options: slots.map((s) => ({ value: s.key, label: s.label })), hint: t('kit.slot_hint') },
          { key: 'venue_id', label: t('kit.venue'), type: 'multimenu', max: 1, options: venues.map((v) => ({ value: v.id, label: v.name })) },
          { key: 'serialised', label: t('kit.serialised_switch'), type: 'switch', hint: t('kit.serialised_hint') },
          { key: 'quantity', label: t('kit.opening_qty'), type: 'stepper', min: 0, max: 100000, show: (v) => !v.serialised },
          { key: 'reorder_level', label: t('kit.reorder_level'), type: 'stepper', min: 0, max: 100000 },
          { key: 'barcode', label: t('kit.barcode'), optional: true, hint: t('kit.barcode_hint') },
        ]} onSubmit={save} />
      <FormSheet visible={!!serials} onClose={() => setSerials(null)} title={t('kit.register_units')} submitLabel={t('kit.register_units')}
        fields={[{ key: 'serials', label: t('kit.serials'), type: 'multiline', hint: t('kit.serials_hint') }]} onSubmit={reg} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ the section
/** The Kit section. `role` is the person's organisation role: owners and admins manage; everyone else gets what the API's kit permissions allow. */
export function KitSection({ o, role, toast }) {
  const { tablet } = useLayout();
  const [tab, setTab] = useState('overview');
  const dash = useLoad(() => api.get(`/organisations/${o.id}/academy/kit/dashboard`), [o.id]);
  const cat = useLoad(() => api.get(`/organisations/${o.id}/academy/kit/catalogue`), [o.id]);
  const manage = role === 'owner' || role === 'admin' || Array.isArray(dash.data?.deposits_held);   // kit managers (the kit_admin permission) are told by the server: only they get finance figures
  const pending = dash.data?.pending_approvals ?? 0;
  const tabs = [
    { value: 'overview', label: t('kit.tab_overview') }, { value: 'issue', label: t('kit.tab_issue') },
    ...(manage ? [{ value: 'entitlements', label: t('kit.tab_entitlements') }, { value: 'approvals', label: pending ? `${t('kit.tab_approvals')} (${pending})` : t('kit.tab_approvals') }, { value: 'replenish', label: t('kit.tab_replenish') }] : []),
    { value: 'stock', label: t('kit.tab_stock') },
  ];
  const changed = () => { dash.reload?.(); };
  const body = tab === 'overview' ? <Overview d={dash} go={setTab} />
    : tab === 'issue' ? <KitIssueDesk orgId={o.id} venues={cat.data?.venues ?? []} toast={toast} onChanged={changed} />
    : tab === 'entitlements' ? <Entitlements orgId={o.id} cat={cat} toast={toast} />
    : tab === 'approvals' ? <Approvals orgId={o.id} cat={cat} toast={toast} onChanged={changed} />
    : tab === 'replenish' ? <Replenish orgId={o.id} cat={cat} toast={toast} onChanged={changed} />
    : <Stock d={dash} cat={cat} orgId={o.id} toast={toast} onChanged={changed} />;
  return (
    <View style={{ gap: 14 }}>
      <View>
        <T size={22} weight="800" style={{ letterSpacing: -0.5 }}>{t('kit.title')}</T>
        <T size={13} color={c.mute}>{t('kit.subtitle')}</T>
      </View>
      <View style={tablet ? undefined : { marginHorizontal: -2 }}><Seg options={tabs} value={tab} onChange={setTab} color={c.violet} /></View>
      {body}
    </View>
  );
}

export { StatusTag };
