// Academy suppliers: maintenance contractors and sporting-goods suppliers, for every venue the academy runs or chosen ones, and the requests
// sent to them. All rules (who may manage, which venues a supplier serves, allowed status moves, encrypted contacts) live in the API capability.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { Block, when } from './academy-ui';

const KINDS = ['maintenance', 'sporting_goods', 'cleaning', 'security', 'technology', 'catering', 'transport', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const NEXT = { requested: 'quoted', quoted: 'approved', approved: 'in_progress', in_progress: 'delivered', delivered: 'done' };
const kindLabel = (k) => t(`sup.kind.${k}`);

export function Suppliers({ o, archived, toast }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/suppliers`), [o.id]);
  const venues = useLoad(() => api.get(`/organisations/${o.id}/academy/venues`).catch(() => []), [o.id]);
  const reqs = useLoad(() => api.get(`/organisations/${o.id}/academy/supplier-requests`, { open_only: true }).catch(() => []), [o.id]);
  const [form, setForm] = useState(null);      // { supplier? } add or edit
  const [ask, setAsk] = useState(null);        // the supplier a request is for
  const [finish, setFinish] = useState(null);  // a request being marked delivered / done: its final cost and invoice reach the academy P&L (#787)
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const venueOpts = (venues.data ?? []).map((v) => ({ value: v.id, label: v.name, sub: v.city }));
  const reload = () => { list.reload(); reqs.reload(); };
  const scope = (s) => (s.all_venues ? t('sup.scope.all') : s.venues?.length ? t('sup.scope.n', { n: s.venues.length }) + ': ' + s.venues.map((v) => v.name).join(', ') : t('sup.scope.none'));
  const edit = form?.supplier;
  return (
    <Block title={t('sup.title')} right={!archived ? <Btn small title={t('sup.add')} onPress={() => setForm({})} accessibilityLabel={t('sup.add')} /> : null}>
      <T size={12} color={c.mute}>{t('sup.intro')}</T>
      {list.data.length ? list.data.map((s) => (
        <View key={s.id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 6 }}>
          <Row title={`${s.name} · ${kindLabel(s.kind)}`} sub={`${scope(s)}${s.open_requests ? ` · ${t('sup.open', { n: s.open_requests })}` : ''}${s.emergency_24x7 ? ' · 24×7' : ''}`}
            right={<Tag label={t(`sup.st.${s.status}`)} color={s.status === 'active' ? c.lime : undefined} />} />
          {!archived ? (
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {s.status === 'active' ? <Btn small title={t('sup.request')} onPress={() => setAsk(s)} /> : null}
              {'contact_name' in s ? <Btn small title={t('sup.edit')} color={c.paper} ink={c.ink} onPress={() => setForm({ supplier: s })} /> : null}
            </View>
          ) : null}
        </View>
      )) : <Empty emoji="🧰" title={t('sup.empty.title')} sub={t('sup.empty.sub')} />}
      {reqs.data?.length ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={14}>{t('sup.reqs')}</T>
          {reqs.data.map((r) => (
            <Row key={r.id} title={`${r.title} · ${r.supplier}`} sub={`${r.venue ?? t('sup.r.venue_all')} · ${t(`sup.pri.${r.priority}`)}${r.due_on ? ` · ${when(r.due_on)}` : ''}`}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={t(`sup.st.${r.status}`)} />{NEXT[r.status] && !archived ? <Btn small title={t('sup.mark', { status: t(`sup.st.${NEXT[r.status]}`) })} color={c.paper} ink={c.ink}
                onPress={async () => { if (['delivered', 'done'].includes(NEXT[r.status])) { setFinish(r); return; } try { await api.patch(`/academy/supplier-requests/${r.id}`, { row_version: r.row_version, status: NEXT[r.status] }); reqs.reload(); } catch (e) { toast?.(e.message); } }} /> : null}</View>} />
          ))}
        </View>
      ) : null}
      <FormSheet visible={!!finish} onClose={() => setFinish(null)} title={finish ? `${finish.title} · ${t('sup.mark', { status: t(`sup.st.${NEXT[finish.status]}`) })}` : ''} submitLabel={t('common.save')} initial={{ currency: finish?.currency ?? undefined, amount_minor: finish?.estimated_cost_minor != null ? Number(finish.estimated_cost_minor) : undefined }}
        fields={[{ key: 'currency', label: t('arc.f.currency'), type: 'currency', optional: true }, { key: 'amount_minor', label: t('arc.f.amount'), type: 'money', currency: (v) => v.currency ?? finish?.currency ?? 'INR', optional: true, hint: t('arc.sup.final_hint') }, { key: 'invoice_ref', label: t('arc.f.invoice'), optional: true }]}
        onSubmit={async (v) => { await api.patch(`/academy/supplier-requests/${finish.id}`, { row_version: finish.row_version, status: NEXT[finish.status], ...(v.amount_minor ? { actual_cost_minor: v.amount_minor, currency: v.currency ?? finish.currency ?? undefined } : {}), ...(v.invoice_ref ? { invoice_ref: v.invoice_ref } : {}) }); reqs.reload(); return t('arc.sup.saved'); }} />
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? edit.name : t('sup.title')} submitLabel={t('common.save')}
        initial={edit ? { ...edit, venue_ids: (edit.venues ?? []).map((v) => v.id) } : { kind: 'maintenance', all_venues: venueOpts.length <= 1 }}
        fields={[
          { key: 'name', label: t('sup.f.name') },
          { key: 'kind', label: t('sup.f.kind'), type: 'chips', options: KINDS.map((k) => ({ value: k, label: kindLabel(k) })) },
          { key: 'all_venues', label: t('sup.f.all'), type: 'switch' },
          { key: 'venue_ids', label: t('sup.f.venues'), type: 'multimenu', options: venueOpts, optional: true, show: (v) => !v.all_venues },
          { key: 'contact_name', label: t('sup.f.contact'), optional: true }, { key: 'phone', label: t('sup.f.phone'), optional: true, input: 'phone' }, { key: 'email', label: t('sup.f.email'), optional: true, input: 'email' },
          { key: 'emergency_24x7', label: t('sup.f.emergency'), type: 'switch' },
          { key: 'lead_time_days', label: t('sup.f.lead'), type: 'stepper', min: 0, max: 365, default: 0 },
          { key: 'payment_terms', label: t('sup.f.terms'), optional: true },
          ...(edit ? [{ key: 'status', label: t('sup.f.status'), type: 'chips', options: ['active', 'paused', 'archived'].map((k) => ({ value: k, label: t(`sup.st.${k}`) })) }] : []),
        ]}
        onSubmit={async (v) => {
          const body = { ...v, venue_ids: v.all_venues ? [] : v.venue_ids ?? [] };
          if (edit) await api.patch(`/academy/suppliers/${edit.id}`, { ...body, row_version: edit.row_version });
          else await api.post(`/organisations/${o.id}/academy/suppliers`, body);
          reload(); return t('sup.saved');
        }} />
      <FormSheet visible={!!ask} onClose={() => setAsk(null)} title={t('sup.r.title', { name: ask?.name ?? '' })} submitLabel={t('sup.request')} initial={{ priority: 'normal' }}
        fields={[
          { key: 'title', label: t('sup.r.what') },
          { key: 'venue_id', label: t('sup.r.venue'), type: 'multimenu', max: 1, optional: true, hint: t('sup.r.venue_all'),
            options: venueOpts.filter((v) => ask?.all_venues || (ask?.venues ?? []).some((x) => x.id === v.value)) },
          { key: 'priority', label: t('sup.r.priority'), type: 'chips', options: PRIORITIES.map((k) => ({ value: k, label: t(`sup.pri.${k}`) })) },
          { key: 'due_on', label: t('sup.r.due'), type: 'date', optional: true },
          { key: 'details', label: t('sup.r.details'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { const { venue_id, ...rest } = v; await api.post(`/organisations/${o.id}/academy/supplier-requests`, { ...rest, supplier_id: ask.id, ...(venue_id?.[0] ? { venue_id: venue_id[0] } : {}) }); reqs.reload(); list.reload(); return t('sup.r.sent'); }} />
    </Block>
  );
}
