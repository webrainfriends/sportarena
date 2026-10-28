// Finance: the academy's management accounts in one place with the charge-level billing it summarises. Charges (collect / fund / refund) are the
// canonical records; P&L, receivables and forecasts are read-only views over them plus audited management cost entries. Every figure says its
// basis and currency, and a figure that is not known is shown as missing rather than 0.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { Bars, Block, Fact, Kpi, pct, saveCsv, when } from './academy-ui';
import { Billing } from './academy-money';
import { Collections } from './collections';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const M = (v, cur) => (v == null ? 'missing' : moneyIn(v, cur));
const idem = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function Finance({ o, role, archived, toast }) {
  const [tab, setTab] = useState('charges');
  const staff = role === 'owner' || role === 'admin' || role === 'finance';
  const opts = [{ value: 'charges', label: 'Charges' }, ...(staff ? [{ value: 'pnl', label: 'Profit & loss' }, { value: 'collections', label: 'Collections' }, { value: 'costs', label: 'Costs' }, { value: 'forecast', label: 'Forecast' }] : [])];
  return (
    <View style={{ gap: 12 }}>
      <Seg value={tab} onChange={setTab} color={c.violet} options={opts} />
      {tab === 'charges' ? <Billing o={o} archived={archived} /> : null}
      {tab === 'pnl' ? <Pnl o={o} /> : null}
      {tab === 'collections' ? <Collections target={{ organisation_id: o.id }} archived={archived} /> : null}
      {tab === 'costs' ? <Costs o={o} archived={archived} toast={toast} /> : null}
      {tab === 'forecast' ? <Forecast o={o} archived={archived} toast={toast} /> : null}
    </View>
  );
}

function Pnl({ o }) {
  const [from, setFrom] = useState(day(90)), [to, setTo] = useState(day(0)), [open, setOpen] = useState(null);
  const r = useLoad(() => api.get(`/organisations/${o.id}/academy/pnl`, { from, to }), [o.id, from, to]);
  const lines = useLoad(() => (open ? api.get(`/organisations/${o.id}/academy/pnl/lines`, { from, to, programme_id: open.programme_id, currency: open.currency }) : Promise.resolve(null)), [open?.programme_id, open?.currency, from, to]);
  const exportCsv = async () => { try { const x = await api.get(`/organisations/${o.id}/academy/pnl/export`, { from, to }); await saveCsv(x.filename, x.csv); } catch (e) { /* shown by the error box on reload */ } };
  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <View style={{ flex: 1, minWidth: 150 }}><DateField label="From" value={from} onChange={setFrom} max={to} /></View>
          <View style={{ flex: 1, minWidth: 150 }}><DateField label="To" value={to} onChange={setTo} min={from} /></View>
          <Btn small title="Export CSV" color={c.paper} ink={c.ink} onPress={exportCsv} />
        </View>
        {r.data ? <T size={12} color={c.mute}>{r.data.definitions.basis} Currencies are never added together.</T> : null}
      </Panel>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !r.data ? <Loading /> : !r.data.currencies.length ? <Empty emoji="📊" title="No charges in this period" sub="Revenue appears once programmes are priced and people enrol. Costs are added on the Costs tab." /> : r.data.currencies.map((cur) => {
        const t = cur.totals, k = cur.currency;
        return (
          <Panel key={k}>
            <Block title={`${k} — management view`}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Kpi label="Gross billed" value={M(t.gross_billed_minor, k)} sub={`discounts ${M(t.discounts_minor, k)}`} />
                <Kpi label="Management revenue" value={M(t.management_revenue_minor, k)} sub={`refunds ${M(t.refunds_minor, k)} · tax ${M(t.tax_minor, k)}`} />
                <Kpi label="Cash collected" value={M(t.cash_collected_minor, k)} sub={`refunded in period ${M(t.cash_refunded_minor, k)}`} />
                <Kpi label="Outstanding" value={M(t.outstanding_minor, k)} sub="awaiting payment" />
              </View>
              <Fact k="Funded" v={`scholarship ${M(t.funded_minor.scholarship, k)} · bursary ${M(t.funded_minor.bursary, k)} · sponsor ${M(t.funded_minor.sponsor, k)}`} />
              <Fact k="Direct costs" v={`staff ${M(t.staff_cost_minor, k)} · venue ${M(t.venue_cost_minor, k)} · other ${M(t.other_direct_cost_minor, k)}`} />
              <Fact k="Contribution" v={`${M(t.contribution_minor, k)}${t.cost_picture_complete ? '' : ' (incomplete — a programme has no staff cost)'}`} />
              <Fact k="Overhead allocated" v={`${M(t.allocated_overhead_minor, k)}${t.unallocated_overhead_minor ? ` · ${M(t.unallocated_overhead_minor, k)} could not be allocated` : ''}`} />
              <Fact k="Operating result" v={`${M(t.operating_result_minor, k)} · margin ${pct(t.margin_pct)}`} />
            </Block>
            <Block title="By programme">
              <Bars label={`Operating result by programme in ${k}`} rows={cur.programmes.map((p) => ({ label: p.title, value: p.operating_result_minor, text: `${M(p.operating_result_minor, k)}${p.contribution_complete ? '' : ' (incomplete)'}`, tone: p.operating_result_minor < 0 ? c.orange : undefined }))} />
              {cur.programmes.map((p) => (
                <Row key={p.programme_id ?? 'x'} title={p.title} sub={`${p.unit.athletes_billed} billed · ${p.unit.participants} enrolled${p.unit.capacity ? ` of ${p.unit.capacity} (${pct(p.unit.utilisation_pct)})` : ''} · per athlete ${M(p.unit.revenue_per_athlete_minor, k)} · per session ${M(p.unit.revenue_per_session_minor, k)} · break-even ${p.unit.break_even_participants ?? 'missing'} athletes · refunds ${pct(p.unit.refund_rate_pct)} · unpaid ${pct(p.unit.receivable_rate_pct)} · discounts & funding ${pct(p.unit.discount_and_funding_pct)}`}
                  right={<Tag label={p.contribution_complete ? pct(p.margin_pct) : 'costs missing'} color={p.contribution_complete ? undefined : c.sunSoft} />} onPress={p.programme_id ? () => setOpen({ programme_id: p.programme_id, currency: k, title: p.title }) : undefined} />
              ))}
            </Block>
          </Panel>
        );
      })}
      {open ? (
        <Panel>
          <Block title={`Behind the figures: ${open.title} (${open.currency})`} right={<Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => setOpen(null)} />}>
            {!lines.data ? <Loading /> : (
              <>
                {lines.data.charges.map((l) => <Row key={l.source_id} title={`Charge · ${l.kind}`} sub={`due ${when(l.on_date)} · gross ${moneyIn(l.gross_minor, open.currency)} · discount ${moneyIn(l.discount_minor, open.currency)} · funded ${moneyIn(l.funded_minor, open.currency)}${l.funding_source ? ` (${l.funding_source})` : ''} · owed ${moneyIn(l.amount_minor, open.currency)} · source academy_charge ${l.source_id.slice(0, 8)}`} right={<Tag label={l.status.replace('_', ' ')} />} />)}
                {lines.data.cost_entries.map((l) => <Row key={l.source_id} title={`Cost · ${l.category.replace('_', ' ')} · ${moneyIn(l.amount_minor, open.currency)}`} sub={`${when(l.on_date)} · ${l.description} · management entry ${l.source_id.slice(0, 8)}`} />)}
                {!lines.data.charges.length && !lines.data.cost_entries.length ? <T size={13} color={c.mute}>Nothing in this period.</T> : null}
              </>
            )}
          </Block>
        </Panel>
      ) : null}
    </View>
  );
}

const BUCKETS = [['not_yet_due', 'Not yet due'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90_plus', '90+ days']];
function Forecast({ o, archived, toast }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/scenarios`, { limit: 50 }), [o.id]);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 }), [o.id]);
  const profile = useLoad(() => api.get(`/organisations/${o.id}/academy`), [o.id]);
  const cur = () => profile.data?.currency ?? 'GBP';
  const [form, setForm] = useState(false), [key, setKey] = useState('');
  const options = (progs.data ?? []).filter((p) => p.status === 'published').map((p) => ({ id: p.id, label: p.title, sub: p.sport }));
  const R = ({ s }) => {
    const r = s.result, k = s.currency;
    return (
      <View style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 4 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" size={14} style={{ flex: 1 }}>{s.name}</T><Tag label="Scenario — not actuals" color={c.sunSoft} /></View>
        <T size={12} color={c.mute}>{s.programme} · baseline: {s.baseline.enrolled} enrolled now, price {M(s.baseline.fee_minor, k)}, {s.baseline.source_period}</T>
        <Fact k="Athletes" v={`${r.athletes.enrolled_now} now → ${r.athletes.projected}${r.athletes.capped ? ` (capped at ${r.athletes.capacity}; ${r.athletes.waitlist_left} would wait)` : ''}`} />
        <Fact k="Revenue" v={`${M(r.revenue_minor, k)} at ${M(r.unit_price_minor, k)} each`} />
        <Fact k="Costs" v={`staff ${M(r.staff_cost_minor, k)} · venue ${M(r.venue_cost_minor, k)} · extra cohorts ${M(r.extra_cohort_cost_minor, k)}`} />
        <Fact k="Contribution" v={`${M(r.contribution_minor, k)}${r.contribution_complete ? '' : ` (incomplete: ${r.missing_costs.join(', ')} cost missing)`}`} />
        <Fact k="Break-even" v={r.break_even_athletes == null ? 'missing' : `${r.break_even_athletes} athletes`} />
        <Fact k="Confirmed invoices" v={`${s.baseline.confirmed_future_invoices} future charges, ${M(s.baseline.confirmed_future_invoices_minor, k)} (actual)`} />
        <T size={11} color={c.mute}>{r.formulas.athletes}. {r.formulas.revenue}. This scenario changes no price, payroll or booking.</T>
        {!archived ? <Btn small title="Archive" color={c.paper} ink={c.ink} onPress={async () => { await api.post(`/academy/scenarios/${s.id}/archive`, {}); list.reload(); }} style={{ alignSelf: 'flex-start' }} /> : null}
      </View>
    );
  };
  return (
    <Panel>
      <Block title="Forecast & scenarios" right={!archived ? <Btn small title="＋ New scenario" onPress={() => { setKey(idem('scen')); setForm(true); }} /> : null}>
        <T size={12} color={c.mute}>Try “what if” on one programme, starting from its real enrolment, price and recent costs. Assumptions are yours to edit; results are stored apart from actuals.</T>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((s) => <R key={s.id} s={s} />) : <Empty emoji="🔮" title="No scenarios" sub="Create one to compare, for example, a price rise or an extra cohort." />}
      </Block>
      <FormSheet visible={form} onClose={() => setForm(false)} title="New scenario" submitLabel="Run scenario" initial={{ renewal_pct: 100, new_athletes: 0, price_change_pct: 0, discount_pct: 0, extra_cohorts: 0, extra_cohort_size: 12, billing_periods: 1, has_cost: false, scholarship: '' }}
        fields={[{ key: 'programme_id', label: 'Programme', type: 'entity', entityKind: 'programme', noun: 'programme', options }, { key: 'name', label: 'Scenario name', hint: 'For example “Add a Saturday cohort”.' },
          { key: 'renewal_pct', label: 'Current athletes who stay', type: 'stepper', min: 0, max: 100, step: 5, suffix: '%' }, { key: 'new_athletes', label: 'New athletes', type: 'stepper', min: 0, max: 500 },
          { key: 'price_change_pct', label: 'Price change', type: 'stepper', min: -50, max: 100, step: 5, suffix: '%' }, { key: 'discount_pct', label: 'Average discount', type: 'stepper', min: 0, max: 100, step: 5, suffix: '%' },
          { key: 'extra_cohorts', label: 'Extra cohorts', type: 'stepper', min: 0, max: 20 }, { key: 'extra_cohort_size', label: 'Places per extra cohort', type: 'stepper', min: 1, max: 100, show: (v) => v.extra_cohorts > 0 },
          { key: 'extra_cohort_cost_minor', label: 'Running cost per extra cohort', type: 'money', currency: cur, optional: true, show: (v) => v.extra_cohorts > 0 },
          { key: 'billing_periods', label: 'Billing periods', type: 'stepper', min: 1, max: 12, hint: 'For a monthly programme, how many months.' },
          { key: 'scholarship_funding_minor', label: 'Scholarship / sponsor funding assumed', type: 'money', currency: cur, optional: true }]}
        onSubmit={async (v) => {
          const a = { renewal_pct: v.renewal_pct, new_athletes: v.new_athletes, price_change_pct: v.price_change_pct, discount_pct: v.discount_pct, extra_cohorts: v.extra_cohorts, extra_cohort_size: v.extra_cohort_size ?? 12, extra_cohort_cost_minor: v.extra_cohort_cost_minor ?? 0, billing_periods: v.billing_periods, scholarship_funding_minor: v.scholarship_funding_minor ?? 0 };
          await api.post(`/organisations/${o.id}/academy/scenarios`, { programme_id: v.programme_id, name: v.name, assumptions: a, idempotency_key: key });
          list.reload(); return 'Scenario saved. Nothing in your academy changed.';
        }} />
    </Panel>
  );
}
