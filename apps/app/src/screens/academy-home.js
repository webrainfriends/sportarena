// Academy Executive Home: what needs doing now (action inbox), how each programme is filling, how the funnel converts and what is owed,
// then the executive view (outcomes, retention indicators, partners, finance health, copilot) from academy-executive.js.
import React from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { useLayout } from '../layout';
import { Block, FunnelBars, Kpi, Meter, Spark, when } from './academy-ui';
import { ExecutiveCards } from './academy-executive';

const KIND = { review: ['📨', 'Review'], offer_expiring: ['⏰', 'Offer ending'], follow_up: ['↪️', 'Follow up'], overdue: ['💷', 'Overdue'] };

const Panel = ({ children, style }) => <View style={[{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }, style]}>{children}</View>;

export function Home({ o, go, openApplication, canMoney }) {
  const dash = useLoad(() => api.get(`/organisations/${o.id}/academy/dashboard`), [o.id]);
  const pipe = useLoad(() => api.get(`/organisations/${o.id}/pipeline`), [o.id]);
  const { tablet } = useLayout();
  if (dash.error) return <ErrorBox error={dash.error} onRetry={dash.reload} />;
  if (!dash.data || !pipe.data) return <Loading />;
  const d = dash.data, p = pipe.data, a = d.outstanding_actions;
  const open = d.programmes.reduce((t, x) => t + (x.capacity ? Math.max(0, x.capacity - x.filled - x.offers_held) : 0), 0);
  const money = d.money.by_currency;
  const f = p.funnel;
  const rate = (x, y) => (y ? Math.round((x / y) * 100) : null);
  const funnel = [{ label: 'Enquiries', value: f.enquiries }, { label: 'Trials', value: f.trials, rate: rate(f.trials, f.enquiries) }, { label: 'Applications', value: f.applications, rate: rate(f.applications, f.enquiries) }, { label: 'Offers', value: f.offers, rate: rate(f.offers, f.applications) }, { label: 'Enrolled', value: f.enrolled, rate: rate(f.enrolled, f.offers) }];
  const col = tablet ? { flex: 1, minWidth: 0 } : { width: '100%' };
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label="Active athletes" value={d.enrolments.active} sub={`+${d.enrolments.new_30d} · −${d.enrolments.withdrawn_30d} in 30 days`} onPress={() => go('families')} />
        <Kpi label="Open places" value={open} sub={`${d.programmes.length} live programme${d.programmes.length === 1 ? '' : 's'}`} onPress={() => go('programmes')} />
        <Kpi label="To review" value={a.applications_to_review} sub={a.offers_expiring ? `${a.offers_expiring} offers ending soon` : 'applications waiting'} tone={a.applications_to_review ? 'alert' : undefined} onPress={() => go('admissions')} />
        {canMoney ? money.length ? money.map((m) => <Kpi key={m.currency} label={`Outstanding ${m.currency}`} value={moneyIn(m.outstanding_minor, m.currency)} sub={Number(m.overdue_minor) ? `${moneyIn(m.overdue_minor, m.currency)} overdue` : 'nothing overdue'} tone={Number(m.overdue_minor) ? 'alert' : undefined} onPress={() => go('billing')} />) : <Kpi label="Outstanding" value="–" sub="no fees yet" onPress={() => go('billing')} /> : null}
      </View>
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
        <View style={[col, { gap: 14 }]}>
          <Panel>
            <Block title="Action inbox" right={d.inbox.length ? <Tag label={String(d.inbox.length)} color={c.sunSoft} /> : null}>
              {d.inbox.length ? d.inbox.map((it, i) => (
                <Pressable key={i} onPress={() => (it.application_id ? openApplication(it.application_id) : go('billing'))} accessibilityRole="button" accessibilityLabel={`${KIND[it.kind]?.[1]}: ${it.title}. ${it.sub}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 10, borderRadius: 14, backgroundColor: c.bg }}>
                  <T size={20}>{KIND[it.kind]?.[0]}</T>
                  <View style={{ flex: 1 }}><T weight="700" size={14}>{it.title}</T><T size={12} color={c.mute}>{it.kind === 'overdue' ? `${moneyIn(it.amount_minor, it.currency)} outstanding` : it.sub}</T></View>
                  <Tag label={KIND[it.kind]?.[1] ?? ''} />
                </Pressable>
              )) : <Empty emoji="🎉" title="Inbox zero" sub="No reviews, ending offers, follow-ups or overdue payments need you right now." />}
            </Block>
          </Panel>
          <Panel>
            <Block title="Programmes" right={<Btn small title="Manage" color={c.paper} ink={c.ink} onPress={() => go('programmes')} />}>
              {d.programmes.length ? d.programmes.map((x) => {
                const full = x.capacity && x.filled + x.offers_held >= x.capacity;
                return (
                  <Pressable key={x.id} onPress={() => go('programmes', x.id)} accessibilityRole="button" accessibilityLabel={`${x.title}, ${x.filled} of ${x.capacity ?? 'unlimited'} filled`} style={{ gap: 6, paddingVertical: 4 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" size={14} style={{ flex: 1 }}>{x.title}</T>{full ? <Tag label="Full" color={c.orangeSoft} /> : x.status === 'closed' ? <Tag label="Closed" /> : null}</View>
                    <Meter filled={x.filled} held={x.offers_held} capacity={x.capacity} waitlisted={x.waitlisted} compact />
                  </Pressable>
                );
              }) : <Empty emoji="🏅" title="No live programmes" sub="Publish a programme to start taking enquiries." />}
            </Block>
          </Panel>
        </View>
        <View style={[col, { gap: 14 }]}>
          <Panel>
            <Block title="Admissions funnel" right={<Btn small title="Open pipeline" color={c.paper} ink={c.ink} onPress={() => go('admissions')} />}>
              <FunnelBars steps={funnel} />
              <T size={12} color={c.mute}>Counts people who ever reached each step, so the funnel never shrinks when someone is enrolled.</T>
            </Block>
          </Panel>
          {d.fill_trend.length ? <Panel><Block title="Joins per week"><Spark label="Joins per week" points={d.fill_trend.map((w) => ({ label: when(w.week), value: w.enrolled }))} /></Block></Panel> : null}
          {canMoney ? (
            <Panel>
              <Block title="Fees" right={<Btn small title="Billing" color={c.paper} ink={c.ink} onPress={() => go('billing')} />}>
                {money.length ? money.map((m) => {
                  const billed = Number(m.billed_minor) || 1, paid = Math.round((Number(m.paid_minor) / billed) * 100), over = Math.round((Number(m.overdue_minor) / billed) * 100);
                  return (
                    <View key={m.currency} style={{ gap: 4 }} accessible accessibilityLabel={`${m.currency}: billed ${moneyIn(m.billed_minor, m.currency)}, customers paid ${moneyIn(m.paid_minor, m.currency)}, outstanding ${moneyIn(m.outstanding_minor, m.currency)}`}>
                      <View style={{ flexDirection: 'row' }}><T weight="800" style={{ flex: 1 }}>{m.currency}</T><T size={13}>billed {moneyIn(m.billed_minor, m.currency)}</T></View>
                      <View style={{ height: 10, borderRadius: 6, backgroundColor: c.violetSoft, flexDirection: 'row', overflow: 'hidden' }}><View style={{ width: `${paid}%`, backgroundColor: c.lime }} /><View style={{ width: `${Math.min(100 - paid, over)}%`, backgroundColor: c.orange }} /></View>
                      <T size={12} color={c.mute}>paid {moneyIn(m.paid_minor, m.currency)} · due in 14 days {moneyIn(m.due_14d_minor, m.currency)} · overdue {moneyIn(m.overdue_minor, m.currency)}</T>
                    </View>
                  );
                }) : <T size={13} color={c.mute}>No fees yet.</T>}
                {d.money.funded.map((x) => <T key={x.funding_source + x.currency} size={12} color={c.mute}>{x.charges} charge{x.charges === 1 ? '' : 's'} funded by {x.funding_source}: {moneyIn(x.funded_minor, x.currency)}</T>)}
                <T size={11} color={c.mute}>{d.money.note} Operational reporting, not profit and loss.</T>
              </Block>
            </Panel>
          ) : null}
          {p.renewals_due.length || p.recently_left.length ? (
            <Panel>
              <Block title="Renewals & retention">
                {p.renewals_due.map((r) => <T key={r.enrolment_id} size={13}>🔁 {r.title} ends {when(r.ends_on)}</T>)}
                {p.recently_left.map((r) => <T key={r.enrolment_id} size={13} color={c.mute}>↩ Left {r.title} {when(r.withdrawn_at)}{r.ended_reason ? ` — ${r.ended_reason}` : ''}</T>)}
              </Block>
            </Panel>
          ) : null}
        </View>
      </View>
      <T size={12} color={c.mute}>{d.families.payers} paying families · {d.families.multi_child} with more than one child</T>
      <ExecutiveCards o={o} go={go} canMoney={canMoney} />
    </View>
  );
}
