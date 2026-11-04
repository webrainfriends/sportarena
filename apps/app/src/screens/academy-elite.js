// Academy leadership components for performance directors, owners and finance leads: a metric pulse with period-on-period change, a monthly
// revenue / cost / result trend, a cost mix with its sources, status chips that always carry an icon and a word (never colour alone), a branch
// comparison matrix and the evidence-completeness meters. They only render what the API returns (get_academy_pnl_trend, get_academy_branch_scorecard);
// a figure the data cannot show is written as "no data", never 0. Theme tokens only; every chart has a text summary for screen readers.
import React from 'react';
import { Pressable, View } from 'react-native';
import { T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { useLayout } from '../layout';
import { moneyIn } from '../vtime';
import { Block } from './academy-ui';

const NA = () => t('aco.dq.na');
const RULE_LABEL = { utilisation: 'aco.mx.util', attendance: 'aco.mx.att', cancellation: 'aco.mx.cancel', staffing: 'aco.mx.staffing', retention: 'aco.mx.retention', margin: 'aco.mx.margin' };
const M = (v, cur) => (v == null ? NA() : moneyIn(v, cur));
const PALETTE = { green: { bg: c.limeSoft, fg: c.lime, icon: '●' }, amber: { bg: c.sunSoft, fg: c.sun, icon: '▲' }, red: { bg: c.redSoft, fg: c.red, icon: '■' }, unknown: { bg: c.violetSoft, fg: c.mute, icon: '○' } };

/** On track / Watch / Action needed / No data: icon + word + tint, so the meaning never rests on colour. */
export function StatusChip({ status = 'unknown', text }) {
  const p = PALETTE[status] ?? PALETTE.unknown;
  const word = t(`aco.st.${status in PALETTE ? status : 'unknown'}`);
  return (
    <View accessible accessibilityLabel={`${word}${text ? `: ${text}` : ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, minHeight: 24, borderRadius: 12, backgroundColor: p.bg, alignSelf: 'flex-start' }}>
      <T size={10} color={p.fg} weight="800">{p.icon}</T>
      <T size={11} weight="800" color={c.ink}>{text ?? word}</T>
    </View>
  );
}

/** Change against the prior period, as a chip that says Up or Down in words. `goodWhen` says which direction is an improvement ('up' for revenue, 'down' for cost). */
export function Delta({ pct, goodWhen = 'up' }) {
  if (pct == null) return <T size={11} color={c.mute}>{t('aco.k.nodelta')}</T>;
  if (pct === 0) return <T size={11} color={c.mute}>{t('aco.k.flat')}</T>;
  const up = pct > 0, good = (goodWhen === 'up') === up;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 7, minHeight: 22, borderRadius: 11, backgroundColor: good ? c.limeSoft : c.redSoft }}>
      <T size={10} color={good ? c.lime : c.red} weight="800">{up ? '▲' : '▼'}</T>
      <T size={11} weight="800">{up ? t('aco.k.up', { pct: Math.abs(pct) }) : t('aco.k.down', { pct: Math.abs(pct) })}</T>
    </View>
  );
}

/** One headline metric: value, change vs the prior period, an optional status and a footnote. Tappable when it has somewhere to go. */
export function Pulse({ label, value, sub, delta, goodWhen, status, onPress, hint }) {
  const body = (
    <View style={{ flex: 1, minWidth: 150, padding: 14, borderRadius: 18, backgroundColor: status === 'red' ? c.redSoft : c.paper, borderWidth: 1, borderColor: status === 'red' ? c.red : c.line, gap: 3 }}>
      <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{label.toUpperCase()}</T>
      <T size={26} weight="800" style={{ letterSpacing: -0.8, fontVariant: ['tabular-nums'] }}>{value}</T>
      {status ? <StatusChip status={status} /> : null}
      {delta !== undefined ? <Delta pct={delta} goodWhen={goodWhen} /> : null}
      {sub ? <T size={12} color={c.mute}>{sub}</T> : null}
      {hint ? <T size={11} color={c.mute}>{hint}</T> : null}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}${sub ? `. ${sub}` : ''}`} style={{ flex: 1, minWidth: 150 }}>{body}</Pressable> : body;
}
export const PulseRow = ({ children }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{children}</View>;

const monthLabel = (m) => { try { return new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`)); } catch { return m; } };

/** Monthly revenue and cost as paired bars with the result printed under each month. Written summary for screen readers. */
export function TrendChart({ trend }) {
  const { months, currency } = trend;
  const max = Math.max(1, ...months.flatMap((m) => [m.revenue_minor, m.staff_minor + m.venue_minor + m.other_minor]));
  const cost = (m) => m.staff_minor + m.venue_minor + m.other_minor;
  const summary = months.map((m) => `${monthLabel(m.month)}: ${t('aco.trend.revenue')} ${M(m.revenue_minor, currency)}, ${t('aco.trend.cost')} ${M(cost(m), currency)}, ${t('aco.trend.result')} ${M(m.result_minor, currency)}`).join('; ');
  const H = 110;
  return (
    <Block title={t('aco.trend.title', { cur: currency })}>
      <View accessible accessibilityLabel={t('aco.trend.summary', { cur: currency, text: summary })} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, minHeight: H + 54 }}>
        {months.map((m) => (
          <View key={m.month} style={{ flex: 1, alignItems: 'center', gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: H }}>
              <View style={{ width: 12, height: Math.max(m.revenue_minor ? 3 : 0, Math.round((m.revenue_minor / max) * H)), borderRadius: 4, backgroundColor: c.violet }} />
              <View style={{ width: 12, height: Math.max(cost(m) ? 3 : 0, Math.round((cost(m) / max) * H)), borderRadius: 4, backgroundColor: c.orange }} />
            </View>
            <T size={10} color={c.mute}>{monthLabel(m.month)}</T>
            <T size={10} weight="800" style={{ fontVariant: ['tabular-nums'] }} numberOfLines={1}>{m.result_minor < 0 ? '−' : ''}{moneyIn(Math.abs(m.result_minor), currency)}</T>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
        <T size={11} color={c.mute}>■ {t('aco.trend.revenue')}</T><T size={11} color={c.mute}>■ {t('aco.trend.cost')}</T><T size={11} color={c.mute}>{t('aco.trend.result_note')}</T>
      </View>
    </Block>
  );
}

/** Stacked bar of where the cost goes, with each part named by its source (approved payroll, confirmed bookings, manual entries). */
export function CostMix({ totals, currency }) {
  const parts = [['staff', totals.staff_minor, c.violet], ['venue', totals.venue_minor, c.cyan], ['other', totals.other_minor, c.orange]].filter(([, v]) => v > 0);
  const sum = parts.reduce((s, [, v]) => s + v, 0);
  return (
    <Block title={t('aco.mix.title', { cur: currency })}>
      {!sum ? <T size={13} color={c.mute}>{t('aco.mix.none')}</T> : (
        <>
          <View accessible accessibilityLabel={parts.map(([k, v]) => `${t(`aco.mix.${k}`)} ${M(v, currency)} ${Math.round((v / sum) * 100)}%`).join(', ')} style={{ flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', backgroundColor: c.violetSoft }}>
            {parts.map(([k, v, col]) => <View key={k} style={{ flex: v, backgroundColor: col }} />)}
          </View>
          {parts.map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', gap: 8 }}>
              <T size={13} style={{ flex: 1 }}>{t(`aco.mix.${k}`)}</T>
              <T size={13} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{M(v, currency)} · {Math.round((v / sum) * 100)}%</T>
            </View>
          ))}
        </>
      )}
    </Block>
  );
}

/** How complete the evidence behind the figures is: a missing denominator reads "no data", never 100% or 0%. */
export function DataQuality({ dq }) {
  if (!dq) return null;
  const rows = ['venue_booked', 'payroll_covered', 'programmes_with_branch'].map((k) => [k, dq[k]]);
  return (
    <Block title={t('aco.dq.title')}>
      <T size={12} color={c.mute}>{t('aco.dq.hint')}</T>
      {rows.map(([k, v]) => (
        <View key={k} accessible accessibilityLabel={`${t(`aco.dq.${k}`)}: ${v.pct == null ? NA() : `${v.pct}%`}`} style={{ gap: 3 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}><T size={13} style={{ flex: 1 }}>{t(`aco.dq.${k}`)}</T><T size={13} weight="800">{v.pct == null ? NA() : `${v.pct}% · ${v.of}`}</T></View>
          <View style={{ height: 7, borderRadius: 4, backgroundColor: c.violetSoft }}>{v.pct == null ? null : <View style={{ height: 7, borderRadius: 4, width: `${v.pct}%`, backgroundColor: v.pct >= 90 ? c.lime : v.pct >= 60 ? c.sun : c.orange }} />}</View>
        </View>
      ))}
    </Block>
  );
}

const sub = (b) => [b.code, b.manager ? t('aco.mx.manager', { name: b.manager.name }) : b.branch_id ? t('aco.mx.no_manager') : null].filter(Boolean).join(' · ');

const Cell = ({ label, children, w }) => (
  <View style={{ width: w, gap: 3 }}>
    <T size={10} weight="800" color={c.mute} style={{ letterSpacing: 0.8 }}>{label.toUpperCase()}</T>
    {children}
  </View>
);

/**
 * Branch comparison: one row per branch with people, delivery and money, each with a stated status. A wide screen shows a table-like grid; a phone
 * shows one card per branch. `currency` picks which currency's money columns are shown (currencies are never added).
 */
export function BranchMatrix({ data, currency, onOpen }) {
  const { tablet } = useLayout();
  const rows = data?.branches ?? [];
  if (!rows.length) return null;
  const moneyOnly = data.money_only;
  return (
    <Block title={t('aco.mx.title')}>
      <T size={12} color={c.mute}>{t('aco.mx.hint')}</T>
      {rows.map((b) => {
        const f = b.finance.find((x) => x.currency === currency) ?? null;
        const name = b.branch_id ? b.name : t('aco.branch.unassigned');
        return (
          <Pressable key={b.branch_id ?? 'none'} onPress={onOpen ? () => onOpen(b) : undefined} accessibilityRole={onOpen ? 'button' : undefined} accessibilityLabel={`${name}${b.code ? ` ${b.code}` : ''}`}
            style={{ padding: 14, borderRadius: 18, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 160 }}>
                <T weight="800" size={16}>{name}</T>
                {sub(b) ? <T size={12} color={c.mute}>{sub(b)}</T> : null}
              </View>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, rowGap: 12 }}>
              {!moneyOnly && b.people ? (
                <>
                  <Cell label={t('aco.mx.athletes')} w={tablet ? 140 : 150}>
                    <T size={20} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{b.people.athletes}</T>
                    {b.people.target ? <T size={11} color={c.mute}>{t('aco.mx.target', { n: b.people.target })}{b.people.target_pct != null ? ` · ${b.people.target_pct}%` : ''}</T> : null}
                  </Cell>
                  <Cell label={t('aco.mx.util')} w={tablet ? 120 : 150}><StatusChip status={b.people.utilisation.status} text={b.people.utilisation.value == null ? undefined : `${b.people.utilisation.value}%`} /></Cell>
                  <Cell label={t('aco.mx.att')} w={tablet ? 120 : 150}><StatusChip status={b.delivery.attendance.status} text={b.delivery.attendance.value == null ? undefined : `${b.delivery.attendance.value}%`} /></Cell>
                  <Cell label={t('aco.mx.cancel')} w={tablet ? 120 : 150}><StatusChip status={b.delivery.cancellation.status} text={b.delivery.cancellation.value == null ? undefined : `${b.delivery.cancellation.value}%`} /></Cell>
                  <Cell label={t('aco.mx.staffing')} w={tablet ? 130 : 150}><StatusChip status={b.delivery.staffing.status} text={b.delivery.staffing.status === 'unknown' ? undefined : t('aco.mx.exceptions', { n: b.delivery.staffing.exceptions })} /></Cell>
                  <Cell label={t('aco.mx.retention')} w={tablet ? 130 : 150}><StatusChip status={b.people.retention.status} text={b.people.retention.value == null ? undefined : t('aco.mx.flagged', { n: b.people.retention.flagged })} /></Cell>
                </>
              ) : null}
              <Cell label={t('aco.mx.revenue')} w={tablet ? 150 : 150}>
                <T size={16} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{f ? M(f.management_revenue_minor, currency) : NA()}</T>
              </Cell>
              <Cell label={t('aco.mx.margin')} w={tablet ? 130 : 150}>{f ? <StatusChip status={f.margin.status} text={f.margin.value == null ? undefined : `${f.margin.value}%`} /> : <T size={13} color={c.mute}>{NA()}</T>}</Cell>
            </View>
          </Pressable>
        );
      })}
      <View style={{ gap: 3 }} accessibilityRole="summary">
        <T size={11} weight="800" color={c.mute}>{t('aco.mx.rules')}</T>
        {Object.entries(data.rules).map(([k, v]) => <T key={k} size={11} color={c.mute}><T size={11} weight="800" color={c.mute}>{t(RULE_LABEL[k] ?? 'aco.mx.title')}: </T>{v}</T>)}
      </View>
    </Block>
  );
}
