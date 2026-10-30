// Plans & billing: the plans a person can take for an account they manage (themselves, or one event), straight from the published price list.
// Only plans offered to that kind of account and to the roles the person holds are shown. The price is always the server's frozen quote;
// a paid plan goes through the hosted checkout and starts only when the provider confirms. Same REST API the agents use over MCP.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Sheet, T, Tag } from '../ui';
import { PaySheet } from '../PaySheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const label = (s) => String(s ?? '').replace(/[_.]/g, ' ');
const EVERY = { monthly: 'month', annual: 'year', per_event: 'event', one_time: 'once', usage: 'use' };
const TONE = { active: c.lime, trial: c.cyanSoft, pending_payment: c.sunSoft, scheduled: c.violetSoft };
const price = (v) => (Number(v.amount_minor) === 0 ? 'Free' : `${moneyIn(Number(v.amount_minor), v.currency)}${v.tax_bp ? ' + tax' : ''} / ${EVERY[v.billing_interval] ?? label(v.billing_interval)}`);
const ent = (e) => `${label(e.key)}${e.limit_value == null ? '' : ` · ${Number(e.limit_value).toLocaleString()}`}`;
const wrap = { flexDirection: 'row', flexWrap: 'wrap', gap: 8 };
const d10 = (d) => (d ? String(d).slice(0, 10) : '');

/** One account's plans: what it holds now, and the plans on offer. Used by the Plans & billing screen and inside the event console. */
export function PlanPicker({ subjectType, subjectId, subjectName }) {
  const { toast } = useSession();
  const offers = useLoad(() => api.get('/commercial/offers', { subject_type: subjectType, subject_id: subjectId }), [subjectType, subjectId]);
  const acct = useLoad(() => api.get('/commercial/account', { subject_type: subjectType, subject_id: subjectId }), [subjectType, subjectId]);
  const [pick, setPick] = useState(null);
  const [pay, setPay] = useState(null);
  const reload = () => { offers.reload(); acct.reload(); };
  const subs = (acct.data?.subscriptions ?? []).filter((s) => s.status !== 'cancelled');

  const cancel = async (s) => { try { await api.post(`/commercial/subscriptions/${s.id}/cancel`); toast(s.status === 'pending_payment' ? 'Cancelled — nothing was charged' : 'Renewal stopped — your plan runs to the end of the period'); reload(); } catch (e) { toast(e.message); } };
  const payNow = async (s) => {
    try {
      const q = s.quote_id ? await api.get(`/commercial/quotes/${s.quote_id}`) : null;
      setPay({ type: 'commercial_subscription', id: s.id, label: `Plan: ${s.plan_name}`, amount: Number(q?.total_minor ?? s.amount_minor), currency: q?.currency ?? s.currency });
    } catch (e) { toast(e.message); }
  };

  if (offers.error) return <ErrorBox error={offers.error} onRetry={offers.reload} />;
  if ((offers.loading && !offers.data) || (acct.loading && !acct.data)) return <Loading />;
  const products = offers.data?.products ?? [];
  return (
    <View style={{ gap: 14 }}>
      {subjectName ? <T color={c.mute} weight="700">Plans for {subjectName}</T> : null}
      <Card pad={14}>
        <T weight="900" size={16}>Your plan now</T>
        {subs.length ? subs.map((s) => (
          <View key={s.id} style={{ gap: 6, marginTop: 8 }}>
            <View style={{ ...wrap, alignItems: 'center' }}>
              <T weight="800">{s.plan_name}</T><Tag label={label(s.status)} color={TONE[s.status] ?? c.violetSoft} />
              {s.current_period_end ? <T size={12} color={c.mute}>{s.cancel_at_period_end ? 'ends' : 'renews'} {d10(s.current_period_end)}</T> : null}
            </View>
            <View style={wrap}>
              {s.status === 'pending_payment' ? <Btn small title="Pay now" accessibilityLabel={`Pay for ${s.plan_name}`} onPress={() => payNow(s)} /> : null}
              {['pending_payment', 'trial', 'active'].includes(s.status) && !s.cancel_at_period_end ? <Btn small color={c.paper} ink={c.ink} title={s.status === 'pending_payment' ? 'Cancel' : 'Stop renewal'} accessibilityLabel={`Stop ${s.plan_name}`} onPress={() => cancel(s)} /> : null}
            </View>
          </View>
        )) : <T size={13} color={c.mute} style={{ marginTop: 6 }}>You are on the free plan. Choose a plan below to unlock more.</T>}
      </Card>

      {!products.length ? <Empty emoji="🏷️" title="No plans on offer yet" sub="The platform team has not published a plan for this account yet." /> : products.map((p) => (
        <View key={p.key} style={{ gap: 8 }}>
          <T weight="900" size={16}>{p.name}</T>
          <View style={wrap}>
            {p.plans.map((pl) => <PlanCard key={pl.key} plan={pl} held={pl.held} onChoose={(v) => setPick({ plan: pl, version: v })} />)}
          </View>
        </View>
      ))}

      {pick ? <Confirm subjectType={subjectType} subjectId={subjectId} pick={pick} hasBase={subs.some((s) => s.kind === 'base' && s.status !== 'pending_payment')} onClose={() => setPick(null)} onDone={(r) => { setPick(null); reload(); if (r.pay) setPay(r.pay); }} /> : null}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={reload} /> : null}
    </View>
  );
}

function PlanCard({ plan, held, onChoose }) {
  const [vi, setVi] = useState(0);
  const v = plan.versions[Math.min(vi, plan.versions.length - 1)];
  const isHeld = held && ['trial', 'active', 'pending_payment', 'scheduled'].includes(held.status);
  return (
    <Card pad={14} style={{ minWidth: 240, flexGrow: 1, flexBasis: 260 }}>
      <View style={{ gap: 8 }}>
      <View style={{ ...wrap, alignItems: 'center' }}>
        <T weight="900" size={15}>{plan.name}</T>
        {plan.kind === 'addon' ? <Tag label="add-on" /> : null}
        {isHeld ? <Tag label={held.status === 'pending_payment' ? 'awaiting payment' : 'current'} color={c.lime} /> : null}
      </View>
      {plan.versions.length > 1 ? <View style={wrap}>{plan.versions.map((x, i) => <Chip key={x.price_point_code} label={label(x.billing_interval)} active={i === vi} onPress={() => setVi(i)} />)}</View> : null}
      <T weight="800" size={18}>{price(v)}</T>
      {v.trial_days ? <T size={12} color={c.mute}>{v.trial_days}-day free trial</T> : null}
      <View style={{ gap: 3 }}>
        {v.entitlements.length ? v.entitlements.map((e) => <T key={e.key} size={13}>✓ {ent(e)}</T>) : <T size={13} color={c.mute}>Includes what every account has</T>}
      </View>
      {plan.requires?.length ? <T size={12} color={c.mute}>Needs one of: {plan.requires.map(label).join(', ')}</T> : null}
      {plan.is_default ? <T size={12} color={c.mute}>Included free with every account</T>
        : isHeld ? null
        : <Btn small title={Number(v.amount_minor) === 0 ? 'Take this plan' : 'Choose'} accessibilityLabel={`Choose ${plan.name}`} onPress={() => onChoose(v)} />}
      </View>
    </Card>
  );
}

/** The server's frozen quote for what is about to be bought; confirming creates the subscription (and, if it costs money, hands over to checkout). */
function Confirm({ subjectType, subjectId, pick, hasBase, onClose, onDone }) {
  const { toast } = useSession();
  const { plan, version } = pick;
  const [codes, setCodes] = useState([]);   // codes the customer keyed in, each already checked by the server
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const body = (keys) => ({ subject_type: subjectType, subject_id: subjectId, billing_interval: version.billing_interval, currency: version.currency, region: version.region, promotion_keys: keys });
  const getQuote = async (keys) => {
    const q = await api.post('/commercial/quotes', { ...body(keys), items: [{ plan_key: plan.key, billing_interval: version.billing_interval }] });
    setQuote(q); setCodes(keys); return q;
  };
  React.useEffect(() => { (async () => { setBusy(true); try { await getQuote([]); } catch (e) { setErr(e.message); } finally { setBusy(false); } })(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const addCode = async () => {
    const k = input.trim().toLowerCase();
    if (!k) return;
    if (codes.includes(k)) { setErr('You already added that code'); return; }
    setBusy(true); setErr(null);
    try { await getQuote([...codes, k]); setInput(''); } catch (e) { setErr(e.message); } finally { setBusy(false); }   // a code the server refuses is never added; the reason is shown
  };
  const removeCode = async (k) => { setBusy(true); setErr(null); try { await getQuote(codes.filter((x) => x !== k)); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/commercial/subscriptions', { ...body(codes), plan_key: plan.key });
      const sb = r.subscription;
      if (sb.status === 'pending_payment') onDone({ pay: { type: 'commercial_subscription', id: sb.id, label: `Plan: ${plan.name}`, amount: Number(r.quote.total_minor), currency: r.quote.currency } });
      else { toast(sb.status === 'trial' ? 'Trial started ✓' : 'Plan active ✓'); onDone({}); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const q = quote;
  const row = { flexDirection: 'row', justifyContent: 'space-between' };
  return (
    <Sheet visible onClose={onClose} title={plan.name}>
      <T size={13} color={c.mute}>{price(version)}{hasBase && plan.kind === 'base' ? ' · replaces your current plan only once you have paid' : ''}</T>
      {q?.promotions?.length ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Offers applied</T>
          <View style={wrap}>
            {q.promotions.map((o) => (
              <View key={o.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Tag label={`${o.name}${o.auto ? ' · automatic' : ''}`} color={o.auto ? c.cyanSoft : c.lime} />
                {!o.auto ? <Btn small color={c.paper} ink={c.ink} title="Remove" accessibilityLabel={`Remove offer ${o.name}`} onPress={() => removeCode(o.key)} disabled={busy} /> : null}
              </View>
            ))}
          </View>
        </View>
      ) : null}
      <Field label="Have an offer or promo code?" value={input} onChangeText={setInput} placeholder="Enter a code you were sent" maxLength={60} hint="You can add more than one; offers stack." />
      <Btn small color={c.paper} ink={c.ink} title="Add code" onPress={addCode} disabled={busy || !input.trim()} />
      {err ? <T color={c.red} weight="700">{err}</T> : null}
      {q ? (
        <View style={{ gap: 4 }}>
          {q.lines.map((l, i) => <View key={i} style={row}><T size={13}>{l.label ?? label(l.kind)}</T><T size={13}>{moneyIn(Number(l.amount_minor), q.currency)}</T></View>)}
          {q.discount_minor > 0 ? <View style={row}><T size={13} color={c.green}>Offers</T><T size={13} color={c.green}>−{moneyIn(Number(q.discount_minor), q.currency)}</T></View> : null}
          {q.tax_minor > 0 ? <View style={row}><T size={13}>Tax</T><T size={13}>{moneyIn(Number(q.tax_minor), q.currency)}</T></View> : null}
          <View style={{ ...row, marginTop: 4 }}><T weight="900">{q.trial_days ? `Due after ${q.trial_days}-day trial` : 'Due now'}</T><T weight="900">{moneyIn(Number(q.total_minor), q.currency)}</T></View>
          {q.extra_free_months ? <T size={12} color={c.mute}>Includes {q.extra_free_months} extra free month{q.extra_free_months > 1 ? 's' : ''}</T> : null}
        </View>
      ) : null}
      <Btn title={q && Number(q.total_minor) > 0 && !q.trial_days ? 'Continue to payment' : 'Confirm'} onPress={confirm} loading={busy && !!q} disabled={!q || busy} />
    </Sheet>
  );
}

/** The Plans & billing screen: the signed-in person's own account (event plans live in each event's console). */
export function PlansBilling() {
  const { user } = useSession();
  return (
    <Screen wide>
      <H1>Plans & billing</H1>
      <T color={c.mute} weight="700">The plans that fit your roles. Paying is secure and the plan starts as soon as the payment is confirmed.</T>
      <PlanPicker subjectType="user" subjectId={user.id} />
      <T size={12} color={c.mute}>Running an event? Open it and choose <T weight="800" size={12}>Business → Plan</T> to pick the plan for that event.</T>
    </Screen>
  );
}
