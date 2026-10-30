// Academy Executive Home, the lower half: people & demand, delivery, outcomes, retention indicators, partners & risk, finance health and the
// advisory copilot. It sits under the operational Home (action inbox, programmes, funnel) so there is one home, not two. Every card opens
// the tab that owns its data. A figure that cannot be known is shown as "missing", never as 0.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Loading, Seg, T, Tag } from '../ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { useLayout } from '../layout';
import { Bars, Block, Kpi, Meter, pct, when } from './academy-ui';

const Panel = ({ children, onPress, label }) => {
  const body = <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>{body}</Pressable> : body;
};
const SIGNAL = { attendance_decline: 'Attendance falling', repeated_absence: 'Repeated absence', programme_ending_without_next: 'Programme ending, no next step', renewal_incomplete: 'Not renewed', overdue_balance: 'Balance overdue' };
const KINDS = [['margin_variance', 'Why did margin move?'], ['capacity', 'Room or demand'], ['receivables', 'Receivables'], ['retention_plan', 'Retention plan'], ['progression_summary', 'Progression'], ['management_narrative', 'Management narrative']];
const PERIODS = [['30', '30 days'], ['90', '90 days'], ['365', 'Year']];
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

function evidenceText(e) {
  const bits = [];
  if (e.recent_pct != null) bits.push(`attendance ${e.prior_pct}% → ${e.recent_pct}% (${e.window})`);
  if (e.unexcused_absences) bits.push(`${e.unexcused_absences} unexcused absences, ${e.window}`);
  if (e.programme && e.ends_on) bits.push(`${e.programme} ends ${when(e.ends_on)}`);
  if (e.programme && e.completed_on) bits.push(`${e.programme} completed ${when(e.completed_on)}`);
  if (e.amount_minor != null) bits.push(`${moneyIn(e.amount_minor, e.currency)} unpaid, oldest due ${when(e.oldest_due)}`);
  return bits.join(' · ');
}

function Copilot({ o, from, to, canMoney }) {
  const [kind, setKind] = useState('margin_variance'), [busy, setBusy] = useState(false), [res, setRes] = useState(null), [err, setErr] = useState(null);
  const kinds = canMoney ? KINDS : KINDS.filter(([k]) => ['capacity', 'retention_plan', 'progression_summary'].includes(k));
  const ask = async () => { setBusy(true); setErr(null); try { setRes(await api.post(`/organisations/${o.id}/academy/copilot`, { kind, from, to })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <Panel>
      <Block title="Ask the copilot" right={<Tag label="Advisory only" />}>
        <T size={12} color={c.mute}>Reads the figures on this page and nothing else: no clinical records, no private coach notes, no athlete names. It cannot change anything; any action stays with you.</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{kinds.map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => { setKind(k); setRes(null); }} />)}</View>
        <Btn small title={busy ? 'Reading the figures…' : 'Ask'} onPress={ask} disabled={busy} style={{ alignSelf: 'flex-start' }} />
        {err ? <ErrorBox error={err} /> : null}
        {res ? (
          <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><T weight="800" size={14}>{res.title}</T><Tag label={res.ai ? '✨ AI-worded' : '🧮 Calculated from your records'} /><Tag label={`${when(res.period.from)} – ${when(res.period.to)}`} /></View>
            <T size={13}>{res.summary}</T>
            {res.statements.map((s, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
                <Tag label={s.type === 'fact' ? 'Fact' : 'Suggestion'} color={s.type === 'fact' ? c.lime : c.sunSoft} /><T size={13} style={{ flex: 1 }}>{s.text} <T size={11} color={c.mute}>[{s.source}]</T></T>
              </View>
            ))}
            <T size={11} color={c.mute}>{res.note}</T>
          </View>
        ) : null}
      </Block>
    </Panel>
  );
}

export function ExecutiveCards({ o, go, canMoney }) {
  const [days, setDays] = useState('90'), [all, setAll] = useState(false);
  const from = day(Number(days)), to = day(0);
  const home = useLoad(() => api.get(`/organisations/${o.id}/academy/executive`, { from, to }), [o.id, days]);
  const sig = useLoad(() => api.get(`/organisations/${o.id}/academy/signals`), [o.id]);
  const { tablet } = useLayout();
  if (home.error) return <ErrorBox error={home.error} onRetry={home.reload} />;
  if (!home.data) return <Loading />;
  const h = home.data;
  const col = tablet ? { flex: 1, minWidth: 0 } : { width: '100%' };
  const list = sig.data?.signals ?? [];
  const shown = all ? list : list.slice(0, 6);
  return (
    <View style={{ gap: 14, marginTop: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <T weight="800" size={18} style={{ flex: 1 }}>Executive view</T>
        <Seg value={days} onChange={setDays} color={c.violet} options={PERIODS.map(([value, label]) => ({ value, label }))} />
      </View>
      <T size={12} color={c.mute}>{when(from)} – {when(to)}. Management figures from your own records, not statutory accounts. Currencies are never added together.</T>
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
        <View style={[col, { gap: 14 }]}>
          {h.people ? (
            <Panel onPress={() => go('admissions')} label="People and demand. Open admissions.">
              <Block title="People & demand">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Kpi label="Enrolled athletes" value={h.people.enrolled_athletes} sub={`${h.people.new_athletes} new · ${h.people.returning_athletes} returning`} />
                  <Kpi label="Capacity used" value={pct(h.people.utilisation_pct)} sub={h.people.capacity ? `${h.people.enrolled_in_capped} of ${h.people.capacity} places` : 'no capacities set'} />
                </View>
                <T size={12} color={c.mute}>{h.people.waitlisted} waiting · {Object.entries(h.people.funnel).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' · ') || 'no applications in this period'}</T>
              </Block>
            </Panel>
          ) : null}
          {h.delivery ? (
            <Panel onPress={() => go('programmes')} label="Delivery. Open programmes.">
              <Block title="Delivery">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Kpi label="Sessions recorded" value={h.delivery.sessions_recorded} sub="with attendance taken" />
                  <Kpi label="Attendance" value={pct(h.delivery.attendance_pct)} sub="present of present + absent" />
                </View>
                <T size={12} color={c.mute}>Cancelled sessions: missing · Staffing exceptions: missing. {h.delivery.missing_note}</T>
              </Block>
            </Panel>
          ) : null}
          {h.outcomes ? (
            <Panel onPress={() => go('progress')} label="Outcomes. Open progress.">
              <Block title="Outcomes">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Kpi label="Need a pathway look" value={h.outcomes.review_queue} tone={h.outcomes.review_queue ? 'alert' : undefined} sub="not placed, assessment due or awaiting decision" />
                  <Kpi label="Assessments approved" value={h.outcomes.assessments_approved} sub={`${h.outcomes.assessments_awaiting_review} awaiting review`} />
                </View>
                {h.outcomes.level_distribution.length ? <Bars label="Athletes by pathway level" rows={h.outcomes.level_distribution.map((r) => ({ label: `${r.title} · ${r.decision === 'graduate' ? 'graduated' : r.level}`, value: r.n, text: String(r.n) }))} /> : <T size={13} color={c.mute}>No pathway placements yet.</T>}
                {h.outcomes.decisions.length ? <T size={12} color={c.mute}>Decisions: {h.outcomes.decisions.map((d) => `${d.n} ${d.decision.replace(/_/g, ' ')}`).join(' · ')}</T> : null}
                <T size={11} color={c.mute}>{h.outcomes.official_note}</T>
              </Block>
            </Panel>
          ) : null}
        </View>
        <View style={[col, { gap: 14 }]}>
          {h.finance ? (
            <Panel onPress={() => go('billing')} label="Finance. Open billing and accounts.">
              <Block title="Finance">
                {h.finance.currencies.length ? h.finance.currencies.map((f) => (
                  <View key={f.currency} style={{ gap: 6 }}>
                    <T weight="800">{f.currency}</T>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      <Kpi label="Revenue" value={moneyIn(f.management_revenue_minor, f.currency)} sub="invoice basis" />
                      <Kpi label="Collected" value={moneyIn(f.cash_collected_minor, f.currency)} sub="cash basis" />
                      <Kpi label="Outstanding" value={moneyIn(f.outstanding_minor, f.currency)} />
                      <Kpi label="Result" value={f.cost_picture_complete ? moneyIn(f.operating_result_minor, f.currency) : 'incomplete'} sub={f.cost_picture_complete ? pct(f.margin_pct) + ' margin' : 'staff cost missing for some programmes'} tone={f.cost_picture_complete ? undefined : 'alert'} />
                    </View>
                    <Bars label={`Margin by programme in ${f.currency}`} rows={f.programmes.map((p) => ({ label: p.title, value: p.margin_pct, text: p.margin_pct == null ? 'missing' : `${p.margin_pct}%`, tone: p.margin_pct < 0 ? c.orange : undefined }))} />
                  </View>
                )) : <T size={13} color={c.mute}>No charges in this period.</T>}
                {h.finance.ageing.map((a) => (
                  <Bars key={a.currency} label={`Receivables ageing in ${a.currency}`} rows={[['Not yet due', 'not_yet_due'], ['1–30 days', 'd1_30'], ['31–60 days', 'd31_60'], ['61–90 days', 'd61_90'], ['90+ days', 'd90_plus']].map(([l, k]) => ({ label: `${a.currency} ${l}`, value: a.buckets[k].amount_minor, text: moneyIn(a.buckets[k].amount_minor, a.currency), tone: k === 'not_yet_due' ? c.cyan : c.orange }))} />
                ))}
              </Block>
            </Panel>
          ) : null}
          {h.partners ? (
            <Panel onPress={() => go('partners')} label="Partners and risk. Open partners.">
              <Block title="Partners & risk">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Kpi label="Sponsor agreements" value={h.partners.active_sponsorships} sub={h.partners.overdue_sponsor_obligations ? `${h.partners.overdue_sponsor_obligations} obligations overdue` : 'none overdue'} tone={h.partners.overdue_sponsor_obligations ? 'alert' : undefined} />
                  <Kpi label="Health providers" value={h.partners.providers} sub="associated" />
                  <Kpi label="Legal matters" value={h.partners.legal_open_matters} sub={`${h.partners.legal_intakes_in_progress} intake${h.partners.legal_intakes_in_progress === 1 ? '' : 's'} in progress`} />
                </View>
              </Block>
            </Panel>
          ) : null}
        </View>
      </View>
      {h.retention ? (
        <Panel>
          <Block title="Retention & engagement indicators" right={<Tag label={`${h.retention.athletes_flagged} athlete${h.retention.athletes_flagged === 1 ? '' : 's'}`} />}>
            <T size={12} color={c.mute}>Each indicator is a plain rule over attendance, enrolment and fee records, with the evidence shown. There is no score, and nothing happens automatically: you decide what to do.</T>
            {shown.length ? shown.map((s, i) => (
              <View key={`${s.athlete_id}${s.signal}${i}`} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 3 }}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" size={14} style={{ flex: 1 }}>{s.athlete_name}</T><Tag label={SIGNAL[s.signal] ?? s.signal} color={c.sunSoft} /></View>
                <T size={12} color={c.mute}>{evidenceText(s.evidence)}</T>
                <T size={12}>Could do: {s.suggested_actions.join(' · ')}</T>
              </View>
            )) : <Empty emoji="🌱" title="No indicators firing" sub="Nobody currently matches a retention rule." />}
            {list.length > 6 ? <Btn small title={all ? 'Show fewer' : `Show all ${list.length}`} color={c.paper} ink={c.ink} onPress={() => setAll(!all)} style={{ alignSelf: 'flex-start' }} /> : null}
            {sig.data ? <T size={11} color={c.mute}>Rules: {Object.entries(sig.data.rules).map(([k, v]) => `${SIGNAL[k]} — ${v}`).join(' ')}</T> : null}
          </Block>
        </Panel>
      ) : null}
      <Copilot o={o} from={from} to={to} canMoney={canMoney} />
    </View>
  );
}
