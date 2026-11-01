// Payouts (#701): the one place the platform team pays officials fees, venue settlements and seller earnings. Pick what is due, group it in a
// batch, a second person approves it, then download the bank file (or send by Stripe) and record each result. All rules live in the API.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, ErrorBox, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { saveCsv } from './academy-ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';
import { t } from '../i18n';

const cash = (minor, cur) => moneyIn(Number(minor ?? 0), cur);
const SOURCES = ['official_fee', 'venue_settlement', 'provider_balance'];
const FAILS = ['invalid_account', 'account_closed', 'bank_rejected', 'name_mismatch', 'other'];
const STATUS_COLOR = { pending_approval: c.sunSoft, approved: c.limeSoft, exported: c.limeSoft, executing: c.sunSoft, closed: c.limeSoft, cancelled: c.orangeSoft, pending: c.sunSoft, paid: c.limeSoft, failed: c.orangeSoft };
const key = (o) => `${o.source_type}:${o.source_id ?? o.payee_id}:${o.currency}`;
const Block = ({ state, children, empty }) => (state.loading && !state.data ? <Loading /> : state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : state.data?.length === 0 ? <T size={13} color={c.mute}>{empty}</T> : children);

function BatchSheet({ id, onClose, onChanged }) {
  const { toast } = useSession();
  const b = useLoad(() => (id ? api.get(`/admin/payout-batches/${id}`) : Promise.resolve(null)), [id]);
  const [form, setForm] = useState(null);
  const done = () => { b.reload(); onChanged(); };
  const act = async (fn, ok = t('payout.done')) => { try { await fn(); toast(ok); done(); } catch (e) { toast(e.message); } };
  const d = b.data;
  return (
    <Sheet visible={!!id} onClose={onClose} title={d ? t('payout.batch_title', { no: d.batch_no, amount: cash(d.net_minor, d.currency) }) : ''}>
      {b.loading && !d ? <Loading /> : b.error ? <ErrorBox error={b.error} onRetry={b.reload} /> : d ? (
        <>
          <Tag label={t(`payout.status_${d.status}`)} color={STATUS_COLOR[d.status]} />
          <Card pad={12}>
            <T size={13}>{t('payout.gross')}: {cash(d.gross_minor, d.currency)}</T>
            <T size={13}>{t('payout.withheld')}: {cash(d.tax_minor, d.currency)}</T>
            <T size={13}>{t('payout.fees')}: {cash(d.fee_minor, d.currency)}</T>
            <T size={14} weight="800">{t('payout.net')}: {cash(d.net_minor, d.currency)}</T>
          </Card>
          {d.status === 'pending_approval' ? <T size={12} color={c.mute}>{t('payout.second_person')}</T> : null}
          {d.items.map((i) => (
            <Row key={i.id} title={`${i.payee} · ${cash(i.net_minor, i.currency)}`} sub={`${t(`payout.source_${i.source_type}`)}${i.reference ? ` · ${i.reference}` : ''}${i.explanation ? ` · ${i.explanation.title}` : ''}`}
              right={i.status === 'pending' && ['exported', 'executing'].includes(d.status) ? <Btn small title={t('payout.record_result')} color={c.violet} onPress={() => setForm({ item: i })} />
                : i.status === 'failed' ? <Btn small title={t('payout.retry')} color={c.violet} onPress={() => act(() => api.post(`/admin/payout-items/${i.id}/retry`, {}))} />
                : <Tag label={t(`payout.status_${i.status}`)} color={STATUS_COLOR[i.status]} />} />
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {d.status === 'pending_approval' ? <Btn small title={t('payout.approve')} onPress={() => act(() => api.post(`/admin/payout-batches/${d.id}/approve`, { row_version: d.row_version }))} /> : null}
            {['approved', 'exported'].includes(d.status) && d.rail === 'bank_file' ? <Btn small title={t('payout.export')} onPress={() => act(async () => { const f = await api.post(`/admin/payout-batches/${d.id}/export`, {}); await saveCsv(f.filename, f.csv); })} /> : null}
            {['approved', 'executing'].includes(d.status) && d.rail === 'stripe' ? <Btn small title={t('payout.execute')} onPress={() => act(() => api.post(`/admin/payout-batches/${d.id}/execute`, {}))} /> : null}
            {['pending_approval', 'approved'].includes(d.status) ? <Btn small title={t('payout.cancel_batch')} color={c.paper} ink={c.red} onPress={() => setForm({ cancel: true })} /> : null}
          </View>
          <FormSheet visible={!!form?.cancel} onClose={() => setForm(null)} title={t('payout.cancel_batch')} submitLabel={t('payout.cancel_batch')} fields={[{ key: 'reason', label: t('payout.reason_cancel'), type: 'multiline' }]}
            onSubmit={async (v) => { await api.post(`/admin/payout-batches/${d.id}/cancel`, { reason: v.reason }); done(); return t('payout.done'); }} />
          <FormSheet visible={!!form?.item} onClose={() => setForm(null)} title={t('payout.record_result')} submitLabel={t('payout.record_result')} initial={{ outcome: 'paid' }}
            fields={[
              { key: 'outcome', label: t('payout.outcome'), type: 'choice', options: [{ value: 'paid', label: t('payout.outcome_paid') }, { value: 'failed', label: t('payout.outcome_failed') }] },
              { key: 'reference', label: t('payout.reference'), show: (v) => v.outcome === 'paid' },
              { key: 'failure_code', label: t('payout.fail_code'), type: 'chips', options: FAILS.map((f) => ({ value: f, label: f.replace(/_/g, ' ') })), show: (v) => v.outcome === 'failed' },
              { key: 'reason', label: t('payout.fail_reason'), type: 'multiline', show: (v) => v.outcome === 'failed' },
            ]}
            onSubmit={async (v) => { await api.post(`/admin/payout-items/${form.item.id}/result`, v.outcome === 'paid' ? { outcome: 'paid', reference: v.reference } : { outcome: 'failed', failure_code: v.failure_code, reason: v.reason }); done(); return t('payout.done'); }} />
        </>
      ) : null}
    </Sheet>
  );
}

function RulesSheet({ visible, onClose, currency }) {
  const cur = useLoad(() => (visible ? api.get('/admin/payout-settings') : Promise.resolve([])), [visible]);
  const mine = (cur.data ?? []).find((r) => r.currency === currency);
  if (visible && cur.loading && !cur.data) return null;
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('payout.rules')} submitLabel={t('payout.rules')}
      initial={{ currency, withholding_pct: mine ? String(mine.withholding_bp / 100) : '', fee_pct: mine ? String(mine.fee_bp / 100) : '', fee_flat_minor: mine ? Number(mine.fee_flat_minor) : undefined, approval_threshold_minor: mine?.approval_threshold_minor == null ? undefined : Number(mine.approval_threshold_minor) }}
      fields={[
        { key: 'currency', label: t('payout.rules_currency'), type: 'currency' },
        { key: 'withholding_pct', label: t('payout.rules_withholding'), type: 'number', optional: true },
        { key: 'fee_pct', label: t('payout.rules_fee_pct'), type: 'number', optional: true },
        { key: 'fee_flat_minor', label: t('payout.rules_fee_flat'), type: 'money', currency: (v) => v.currency, optional: true },
        { key: 'approval_threshold_minor', label: t('payout.rules_threshold'), type: 'money', currency: (v) => v.currency, optional: true, hint: t('payout.rules_threshold_hint') }]}
      onSubmit={async (v) => {
        await api.post(`/admin/payout-settings/${v.currency}`, { currency: v.currency, withholding_bp: Math.round(Number(v.withholding_pct || 0) * 100), fee_bp: Math.round(Number(v.fee_pct || 0) * 100), fee_flat_minor: v.fee_flat_minor || 0, approval_threshold_minor: v.approval_threshold_minor ?? null });
        onClose(); return t('payout.done');
      }} />
  );
}

export function PayoutBatches() {
  const { toast } = useSession();
  const [source, setSource] = useState('');
  const [picked, setPicked] = useState({});
  const [open, setOpen] = useState(null);
  const [mk, setMk] = useState(false);
  const [rules, setRules] = useState(false);
  const due = useLoad(() => api.get('/admin/payouts/obligations', { ...(source ? { source } : {}), limit: 100 }), [source]);
  const batches = useLoad(() => api.get('/admin/payout-batches', { limit: 50 }), []);
  const reload = () => { due.reload(); batches.reload(); setPicked({}); };
  const chosen = (due.data ?? []).filter((o) => picked[key(o)]);
  const cur = chosen[0]?.currency;
  const toggle = (o) => setPicked((p) => (p[key(o)] ? { ...p, [key(o)]: false } : { ...Object.fromEntries(Object.entries(p).filter(([k]) => k.endsWith(`:${o.currency}`))), [key(o)]: true }));
  return (
    <>
      <Section title={t('payout.ready')} color={c.lime} action={t('payout.rules')} onAction={() => setRules(true)}>
        <MenuField label={t('payout.show')} value={source} onChange={setSource} options={[{ value: '', label: t('common.all') }, ...SOURCES.map((s) => ({ value: s, label: t(`payout.source_${s}`) }))]} />
        <T size={12} color={c.mute}>{t('payout.select_hint')}</T>
        <Block state={due} empty={t('payout.empty_ready')}>
          {(due.data ?? []).map((o) => (
            <Row key={key(o)} title={`${o.payee} · ${cash(o.gross_minor, o.currency)}`} sub={`${t(`payout.source_${o.source_type}`)} · ${o.label}${o.blocker ? ` · ${t(`payout.blocker_${o.blocker}`)}` : ''}`}
              right={o.blocker ? <Tag label={t(`payout.blocker_${o.blocker}`)} color={c.orangeSoft} /> : <Chip label={picked[key(o)] ? '✓' : '+'} active={!!picked[key(o)]} onPress={() => toggle(o)} />} />
          ))}
        </Block>
        {chosen.length ? <Btn title={t('payout.create_batch', { n: chosen.length })} onPress={() => setMk(true)} accessibilityLabel={t('payout.create_batch', { n: chosen.length })} /> : null}
      </Section>

      <Section title={t('payout.batches')} color={c.sun}>
        <Block state={batches} empty={t('payout.empty_batches')}>
          {(batches.data ?? []).map((b) => (
            <Row key={b.id} onPress={() => setOpen(b.id)} title={t('payout.batch_title', { no: b.batch_no, amount: cash(b.net_minor, b.currency) })} sub={new Date(b.created_at).toLocaleString(locale)}
              right={<Tag label={t(`payout.status_${b.status}`)} color={STATUS_COLOR[b.status]} />} />
          ))}
        </Block>
      </Section>

      <FormSheet visible={mk} onClose={() => setMk(false)} title={t('payout.create_batch', { n: chosen.length })} submitLabel={t('payout.create_batch', { n: chosen.length })} initial={{ rail: 'bank_file' }}
        fields={[{ key: 'rail', label: t('payout.rail'), type: 'choice', options: [{ value: 'bank_file', label: t('payout.rail_bank_file') }, { value: 'stripe', label: t('payout.rail_stripe') }] }]}
        onSubmit={async (v) => {
          const r = await api.post('/admin/payout-batches', { currency: cur, rail: v.rail, client_key: `ui-${Date.now()}-${chosen.length}-${Math.random().toString(36).slice(2, 8)}`, items: chosen.map((o) => ({ source_type: o.source_type, ...(o.source_id ? { source_id: o.source_id } : { payee_id: o.payee_id }) })) });
          reload(); setMk(false); setOpen(r.id); toast(t('payout.done')); return t('payout.done');
        }} />
      <BatchSheet id={open} onClose={() => setOpen(null)} onChanged={reload} />
      <RulesSheet visible={rules} onClose={() => setRules(false)} currency={due.data?.[0]?.currency ?? batches.data?.[0]?.currency} />
    </>
  );
}
