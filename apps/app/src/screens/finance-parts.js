// Shared bits of the Finance console (#593): money formatting, labels, the transaction row and the transaction detail (trace to the source workflow).
import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { t } from '../i18n';
import { Btn, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { c, day } from '../theme';
import { moneyIn } from '../vtime';
import { Block, Fact, Timeline } from './academy-ui';

export const money = (minor, cur) => moneyIn(Number(minor ?? 0), cur);
const RANK = { viewer: 1, accountant: 2, controller: 3 };
export const atLeast = (level, need) => (RANK[level] ?? 0) >= RANK[need];
export const kindLabel = (k) => t(`fin.kind.${k}`);
export const statusLabel = (s) => t(`fin.status.${s}`);
export const catLabel = (k) => t(`fin.cat.${k ?? 'other'}`);
/** A module's name in the reader's language; a module the app does not know yet shows its own name, never a raw key. */
export const modLabel = (m) => { const k = `fin.mod.${m}`; const v = t(k); return v === k ? String(m).replace(/_/g, ' ') : v; };
// state is always a word as well as a colour
const STATUS_TONE = { open: c.sunSoft, settled: c.lime, failed: c.orangeSoft, cancelled: c.violetSoft, disputed: c.orangeSoft, reversed: c.violetSoft };
const STEP_ICON = { done: '✅', pending: '⏳', attention: '⚠️', na: '–' };
// where a source record opens, for the sources that have a screen of their own
const SOURCE_ROUTE = { venue_invoice: (id) => ['Invoice', { id }] };

export function TxRow({ r, onPress }) {
  const out = r.kind === 'refund' || r.kind === 'chargeback' || r.direction === 'out';
  return (
    <Row onPress={onPress} title={[modLabel(r.module), kindLabel(r.kind)].join(' · ')}
      sub={[r.payer || r.payee ? `${r.payer ?? '—'} → ${r.payee ?? '—'}` : null, r.provider, r.currency, day(r.occurred_at)].filter(Boolean).join(' · ')}
      right={<><T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{out ? '−' : ''}{money(r.gross_minor, r.currency)}</T><Tag label={statusLabel(r.status)} color={STATUS_TONE[r.status]} /></>} />
  );
}

export function Detail({ id, scope }) {
  const { push } = useNav();
  const tx = useLoad(() => api.get(`/finance/transactions/${id}`, scope), [id]);
  if (tx.error) return <ErrorBox error={tx.error} onRetry={tx.reload} />;
  if (!tx.data) return <Loading />;
  const x = tx.data, route = SOURCE_ROUTE[x.source_type]?.(x.source_id);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Tag label={kindLabel(x.kind)} color={c.cyanSoft} /><Tag label={statusLabel(x.status)} color={STATUS_TONE[x.status]} /></View>
      <Block title={t('fin.d.trace')}><Timeline items={x.steps.map((s) => ({ title: `${STEP_ICON[s.status] ?? ''} ${s.label}`, sub: [s.at ? day(s.at) : null, s.ref, s.provider].filter(Boolean).join(' · ') }))} /></Block>
      <Block title={t('fin.d.amounts')}>
        <Fact k={t('fin.d.gross')} v={money(x.gross_minor, x.currency)} /><Fact k={t('fin.d.discount')} v={money(x.discount_minor, x.currency)} /><Fact k={t('fin.d.tax')} v={money(x.tax_minor, x.currency)} />
        <Fact k={t('fin.d.fee')} v={money(x.fee_minor, x.currency)} /><Fact k={t('fin.d.net')} v={money(x.net_minor, x.currency)} />
      </Block>
      <Block title={t('fin.d.parties')}>
        <Fact k={t('fin.d.payer')} v={x.payer} /><Fact k={t('fin.d.payee')} v={x.payee} /><Fact k={t('fin.d.provider')} v={x.provider} /><Fact k={t('fin.d.reference')} v={x.provider_ref} />
        <Fact k={t('fin.d.category')} v={x.category ? catLabel(x.category) : null} /><Fact k={t('fin.d.due')} v={x.due_on ? day(x.due_on) : null} /><Fact k={t('fin.d.ledger_key')} v={x.ledger_key} />
      </Block>
      <Block title={t('fin.d.history')}><Timeline items={(x.history.length ? x.history : [{ action: 'posted', created_at: x.occurred_at }]).map((h) => ({ title: String(h.action).replace(/_/g, ' '), sub: [h.actor, day(h.created_at)].filter(Boolean).join(' · ') }))} /></Block>
      {route ? <Btn title={t('fin.d.open_source')} color={c.paper} ink={c.ink} onPress={() => push(route[0], route[1])} /> : null}
    </View>
  );
}

