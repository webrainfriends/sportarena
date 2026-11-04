// Academy leadership screens built from the insight capabilities: the Finance Overview (pulse with change vs the prior period, monthly trend, cost
// mix, branch comparison, evidence completeness) and the Executive pulse that sits at the top of the Executive Home. The UI only calls the API.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Empty, ErrorBox, Loading, Seg, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { moneyIn } from '../vtime';
import { BranchFilter, PackButton } from './academy-closeout';
import { BranchMatrix, CostMix, DataQuality, Pulse, PulseRow, TrendChart } from './academy-elite';
import { Block } from './academy-ui';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 12, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const NA = () => t('aco.dq.na');
const M = (v, cur) => (v == null ? NA() : moneyIn(v, cur));
const PERIODS = ['90', '180', '365'];
const periodOptions = () => PERIODS.map((value) => ({ value, label: t(`aco.period.${value}`) }));

/** Finance → Overview: the page a finance lead or owner opens first. */
export function FinanceOverview({ o, role, toast }) {
  const [days, setDays] = useState('180'), [branch, setBranch] = useState(null), [cur, setCur] = useState(null);
  const from = day(Number(days)), to = day(0);
  const trend = useLoad(() => api.get(`/organisations/${o.id}/academy/pnl/trend`, { from, to, branch_id: branch || undefined }), [o.id, days, branch]);
  const score = useLoad(() => api.get(`/organisations/${o.id}/academy/branch-scorecard`, { from, to }), [o.id, days]);
  if (trend.error) return <ErrorBox error={trend.error} onRetry={trend.reload} />;
  if (!trend.data) return <Loading />;
  const currencies = trend.data.currencies;
  const biggest = [...currencies].sort((a, b) => b.totals.revenue_minor - a.totals.revenue_minor)[0]; // lead with the currency that carries the most revenue
  const active = currencies.find((x) => x.currency === cur) ?? biggest;
  const heading = active ? [active.currency, [from, to].join(' – ')].join(' · ') : '';
  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <T weight="800" size={18} style={{ flex: 1, minWidth: 160 }}>{t('aco.ov.title')}</T>
          <Seg value={days} onChange={setDays} color={c.violet} options={periodOptions()} />
        </View>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <View style={{ flex: 1, minWidth: 180 }}><BranchFilter o={o} value={branch} onChange={setBranch} /></View>
          <PackButton label={t('aco.pack.finance')} path={`/organisations/${o.id}/academy/finance-pack`} body={{ from, to }} name="finance-pack" toast={toast} />
        </View>
        <T size={12} color={c.mute}>{trend.data.basis}</T>
        {currencies.length > 1 ? <Seg value={active.currency} onChange={setCur} color={c.violet} options={currencies.map((x) => ({ value: x.currency, label: x.currency }))} /> : null}
      </Panel>
      {!active ? <Panel><Empty emoji="📈" title={t('aco.ov.empty_title')} sub={t('aco.ov.empty_sub')} /></Panel> : (
        <>
          <Panel>
            <Block title={heading}>
              <PulseRow>
                <Pulse label={t('aco.k.revenue')} value={M(active.totals.revenue_minor, active.currency)} delta={active.change_pct.revenue} sub={t('aco.k.basis_invoice')} />
                <Pulse label={t('aco.k.cash')} value={M(active.totals.cash_minor, active.currency)} delta={active.change_pct.cash} sub={t('aco.k.basis_cash')} />
                <Pulse label={t('aco.k.cost')} value={M(active.totals.staff_minor + active.totals.venue_minor + active.totals.other_minor, active.currency)} delta={active.change_pct.cost} goodWhen="down" sub={t('aco.k.cost_sub')} />
                <Pulse label={t('aco.k.result')} value={active.cost_complete ? M(active.totals.result_minor, active.currency) : t('aco.k.incomplete')} delta={active.cost_complete ? active.change_pct.result : undefined}
                  sub={active.cost_complete ? (active.totals.revenue_minor > 0 ? `${t('aco.k.margin')} ${Math.round((active.totals.result_minor / active.totals.revenue_minor) * 1000) / 10}%` : undefined) : t('aco.k.no_staff_cost')} status={active.cost_complete ? (active.totals.result_minor < 0 ? 'red' : undefined) : 'amber'} />
              </PulseRow>
              <T size={11} color={c.mute}>{t('aco.k.prior', { from: active.prior.from, to: active.prior.to })}</T>
            </Block>
          </Panel>
          <Panel><TrendChart trend={active} /></Panel>
          <Panel><CostMix totals={active.totals} currency={active.currency} /></Panel>
        </>
      )}
      {score.data ? <Panel><BranchMatrix data={score.data} currency={active?.currency} /></Panel> : null}
      {score.data?.data_quality ? <Panel><DataQuality dq={score.data.data_quality} /></Panel> : null}
    </View>
  );
}

/** The pulse at the top of the Executive Home: people, delivery and money at a glance, each with a stated status and (for money) change vs the prior period. */
export function LeadershipPulse({ h, o, go }) {
  const days = Math.max(1, Math.round((Date.parse(h.period.to) - Date.parse(h.period.from)) / 864e5) + 1);
  const trend = useLoad(() => (h.finance ? api.get(`/organisations/${o.id}/academy/pnl/trend`, { from: h.period.from, to: h.period.to }) : Promise.resolve(null)), [o.id, h.period.from, h.period.to]);
  const s = h.status;
  const first = [...(trend.data?.currencies ?? [])].sort((a, b) => b.totals.revenue_minor - a.totals.revenue_minor)[0]; // lead with the currency that carries the most revenue
  const revLabel = first ? [t('aco.k.revenue'), first.currency].join(' · ') : '', resLabel = first ? [t('aco.k.result'), first.currency].join(' · ') : '';
  return (
    <Panel>
      <Block title={t('aco.pulse.title')} right={<T size={11} color={c.mute}>{t('aco.pulse.window', { n: days })}</T>}>
        {h.people && s ? (
          <PulseRow>
            <Pulse label={t('aco.k.athletes')} value={h.people.enrolled_athletes} sub={t('aco.pulse.new_returning', { a: h.people.new_athletes, b: h.people.returning_athletes })} onPress={() => go('admissions')} />
            <Pulse label={t('aco.k.utilisation')} value={s.utilisation.value == null ? NA() : `${s.utilisation.value}%`} status={s.utilisation.status} sub={h.people.capacity ? t('aco.pulse.places', { a: h.people.enrolled_in_capped, b: h.people.capacity }) : undefined} onPress={() => go('programmes')} />
            <Pulse label={t('aco.k.attendance')} value={s.attendance.value == null ? NA() : `${s.attendance.value}%`} status={s.attendance.status} sub={t('aco.deliv.recorded', { n: h.delivery.sessions_recorded })} onPress={() => go('ops')} />
            <Pulse label={t('aco.k.cancel')} value={h.delivery.sessions_cancelled} status={s.cancellation.status} sub={s.cancellation.value == null ? NA() : t('aco.deliv.rate', { pct: s.cancellation.value })} onPress={() => go('ops')} />
            <Pulse label={t('aco.deliv.exceptions')} value={h.delivery.staffing_exceptions} status={s.staffing.status} sub={t('aco.deliv.exceptions_sub')} onPress={() => go('ops')} />
            <Pulse label={t('aco.k.retention')} value={h.retention.athletes_flagged} status={s.retention.status} sub={t('aco.pulse.flag_sub')} onPress={() => go('progress')} />
          </PulseRow>
        ) : null}
        {first ? (
          <PulseRow>
            <Pulse label={revLabel} value={M(first.totals.revenue_minor, first.currency)} delta={first.change_pct.revenue} sub={t('aco.k.basis_invoice')} onPress={() => go('billing')} />
            <Pulse label={resLabel} value={first.cost_complete ? M(first.totals.result_minor, first.currency) : t('aco.k.incomplete')} delta={first.cost_complete ? first.change_pct.result : undefined} sub={first.cost_complete ? undefined : t('aco.k.no_staff_cost')} status={first.cost_complete ? (first.totals.result_minor < 0 ? 'red' : undefined) : 'amber'} onPress={() => go('billing')} />
          </PulseRow>
        ) : null}
        {trend.data?.currencies?.length > 1 ? <T size={11} color={c.mute}>{t('aco.pulse.more_currencies')}</T> : null}
      </Block>
    </Panel>
  );
}
