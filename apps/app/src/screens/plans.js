// Memberships and multi-session passes: what a venue sells, what you hold, using a pass on an invoice, and the venue team's plan manager.
import { t } from '../i18n';
import React, { useState } from 'react';
import { View, Switch } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Counter } from '../pickers';
import { PaySheet } from '../PaySheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';
import { Collections } from './collections';

const until = (d) => new Date(d).toLocaleDateString(locale);
const PERKS = ['Locker', 'Towel', 'Coaching clinic', 'Equipment hire', 'Free guest pass', 'Priority booking', 'Shower & changing room', 'Café discount'];
const CURRENCIES = ['GBP', 'EUR', 'USD', 'AUD', 'INR', 'SGD', 'AED', 'LKR', 'IDR'];
const DURATION_OPTS = [{ label: '1 month', days: 30 }, { label: '3 months', days: 90 }, { label: '6 months', days: 180 }, { label: '1 year', days: 365 }];
const TRIAL_OPTS = [{ label: 'None', days: 0 }, { label: '7 days', days: 7 }, { label: '14 days', days: 14 }, { label: '30 days', days: 30 }];

function WizardBar({ step, steps }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, marginBottom: 16 }}>
      {steps.map((s, i) => <View key={s} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < step ? c.violet : i === step ? c.pink : c.p1 }} />)}
    </View>
  );
}
function WizardFooter({ step, steps, canNext, onBack, onNext, onSubmit, submitLabel }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
      {step > 0 && <Btn title="Back" color={c.paper} ink={c.ink} onPress={onBack} style={{ flex: 1 }} />}
      {step < steps.length - 1 && <Btn title="Next" color={c.pink} disabled={!canNext} onPress={onNext} style={{ flex: 1 }} />}
      {step === steps.length - 1 && <Btn title={submitLabel ?? 'Create'} color={c.pink} onPress={onSubmit} style={{ flex: 1 }} />}
    </View>
  );
}
function SwitchRow({ label, sub, value, onChange }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <View style={{ flex: 1 }}>
        <T weight="800" size={14}>{label}</T>
        {sub ? <T size={12} color={c.mute}>{sub}</T> : null}
      </View>
      <Switch value={value} onValueChange={onChange} thumbColor={c.p5} trackColor={{ false: c.p1, true: c.pink }} />
    </View>
  );
}

function MembershipWizard({ visible, onClose, v: venue, onDone }) {
  const steps = ['Plan Identity', 'Pricing & Entitlements', 'Rules & Launch'];
  const [step, setStep] = useState(0);
  const [v, setV] = useState({ name: '', duration_days: 30, discount_pct: 10, auto_renew: false, ent_days: [], ent_guests: 0 });
  const set = (k, val) => setV((p) => ({ ...p, [k]: val }));
  const { toast } = useSession();
  const can = [v.name.length > 0, v.price_cents > 0, true];
  return (
    <Sheet visible={visible} onClose={onClose} title="New membership">
      <WizardBar step={step} steps={steps} />
      <T weight="900" size={16} style={{ marginBottom: 12 }}>{steps[step]}</T>
      {step === 0 && (
        <View style={{ gap: 14 }}>
          <Field label="Membership name" value={v.name} onChangeText={(t) => set('name', t)} placeholder="e.g. Gold member, Annual member" />
          <T weight="800" size={13} color={c.mute}>Duration</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {DURATION_OPTS.map((o) => <Chip key={o.days} label={o.label} active={v.duration_days === o.days} onPress={() => set('duration_days', o.days)} />)}
          </View>
          <Field label="Description" value={v.description ?? ''} onChangeText={(t) => set('description', t)} multiline optional />
        </View>
      )}
      {step === 1 && (
        <View style={{ gap: 14 }}>
          <T weight="800" size={13} color={c.mute}>Discount on every booking</T>
          <Counter value={v.discount_pct} onChange={(n) => set('discount_pct', n)} min={5} max={90} step={5} label="%" />
          <Field label={`Price (${venue.currency})`} value={v.price_cents != null ? String(v.price_cents / 100) : ''} onChangeText={(t) => set('price_cents', Math.round(parseFloat(t || '0') * 100))} placeholder="0.00" />
          <T weight="800" size={13} color={c.mute}>Included perks</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {PERKS.map((p) => <Chip key={p} label={p} active={(v.includes ?? []).includes(p)} onPress={() => set('includes', (v.includes ?? []).includes(p) ? (v.includes ?? []).filter((x) => x !== p) : [...(v.includes ?? []), p])} />)}
          </View>
        </View>
      )}
      {step === 2 && (
        <View style={{ gap: 14 }}>
          <SwitchRow label="Subscription (auto-renew)" sub="Members are reminded to renew a week before it ends." value={v.auto_renew} onChange={(val) => set('auto_renew', val)} />
          <Card pad={12}><T weight="800">{v.name}</T><T size={12} color={c.mute}>{DURATION_OPTS.find((o) => o.days === v.duration_days)?.label} · {v.discount_pct}% off every booking{v.auto_renew ? ' · subscription' : ''}</T></Card>
        </View>
      )}
      <WizardFooter step={step} steps={steps} canNext={can[step]} onBack={() => setStep(step - 1)} onNext={() => setStep(step + 1)} submitLabel="Create membership" onSubmit={async () => { try { await api.post(`/venues/${venue.id}/plans`, { name: v.name, description: v.description, kind: 'membership', price_cents: v.price_cents, duration_days: v.duration_days, discount_bp: Math.round(v.discount_pct * 100), auto_renew: v.auto_renew, includes: v.includes ?? [], entitlements: { days: v.ent_days, guest_quota: v.ent_guests ?? 0 } }); onDone(); onClose(); } catch (e) { toast(e.message); } }} />
    </Sheet>
  );
}

function PassWizard({ visible, onClose, v: venue, onDone, isPackage }) {
  const steps = ['Pass Identity', 'Value & Validity', 'Rules & Launch'];
  const [step, setStep] = useState(0);
  const [v, setV] = useState({ name: '', sessions: 10, valid_days: 90, includes: [] });
  const set = (k, val) => setV((p) => ({ ...p, [k]: val }));
  const { toast } = useSession();
  const can = [v.name.length > 0, v.price_cents > 0, true];
  return (
    <Sheet visible={visible} onClose={onClose} title={isPackage ? 'New package' : 'New pass'}>
      <WizardBar step={step} steps={steps} />
      <T weight="900" size={16} style={{ marginBottom: 12 }}>{steps[step]}</T>
      {step === 0 && (
        <View style={{ gap: 14 }}>
          <Field label={isPackage ? 'Package name' : 'Pass name'} value={v.name} onChangeText={(t) => set('name', t)} placeholder={isPackage ? 'e.g. Badminton 10-hour pack' : 'e.g. 10-session pass'} />
          {isPackage && (
            <>
              <T weight="800" size={13} color={c.mute}>Valid on courts (leave empty for any)</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {venue.resources.map((r) => <Chip key={r.id} label={`${r.sport_emoji ?? ''} ${r.name}`.trim()} active={(v.resource_ids ?? []).includes(r.id)} onPress={() => set('resource_ids', (v.resource_ids ?? []).includes(r.id) ? (v.resource_ids ?? []).filter((x) => x !== r.id) : [...(v.resource_ids ?? []), r.id])} />)}
              </View>
            </>
          )}
          <Field label="Description" value={v.description ?? ''} onChangeText={(t) => set('description', t)} multiline optional />
        </View>
      )}
      {step === 1 && (
        <View style={{ gap: 14 }}>
          <Field label={`Price for whole ${isPackage ? 'package' : 'pass'} (${venue.currency})`} value={v.price_cents != null ? String(v.price_cents / 100) : ''} onChangeText={(t) => set('price_cents', Math.round(parseFloat(t || '0') * 100))} placeholder="0.00" />
          <T weight="800" size={13} color={c.mute}>Sessions included</T>
          <Counter value={v.sessions} onChange={(n) => set('sessions', n)} min={1} max={200} step={1} label="sessions" />
          <T weight="800" size={13} color={c.mute}>Use within</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {DURATION_OPTS.map((o) => <Chip key={o.days} label={o.label} active={v.valid_days === o.days} onPress={() => set('valid_days', o.days)} />)}
          </View>
        </View>
      )}
      {step === 2 && (
        <View style={{ gap: 14 }}>
          <T weight="800" size={13} color={c.mute}>Included perks</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {PERKS.map((p) => <Chip key={p} label={p} active={v.includes.includes(p)} onPress={() => set('includes', v.includes.includes(p) ? v.includes.filter((x) => x !== p) : [...v.includes, p])} />)}
          </View>
          <Card pad={12}><T weight="800">{v.name}</T><T size={12} color={c.mute}>{v.sessions} sessions · {DURATION_OPTS.find((o) => o.days === v.valid_days)?.label}</T></Card>
        </View>
      )}
      <WizardFooter step={step} steps={steps} canNext={can[step]} onBack={() => setStep(step - 1)} onNext={() => setStep(step + 1)} submitLabel={isPackage ? 'Create package' : 'Create pass'} onSubmit={async () => { try { await api.post(`/venues/${venue.id}/plans`, { name: v.name, description: v.description, kind: 'pass', price_cents: v.price_cents, sessions: v.sessions, valid_days: v.valid_days, includes: v.includes, ...(isPackage && v.resource_ids?.length ? { resource_ids: v.resource_ids } : {}) }); onDone(); onClose(); } catch (e) { toast(e.message); } }} />
    </Sheet>
  );
}

function SubscriptionWizard({ visible, onClose, v: venue, onDone }) {
  const steps = ['Plan Identity', 'Pricing & Perks', 'Rules & Launch'];
  const [step, setStep] = useState(0);
  const [v, setV] = useState({ name: '', duration_days: 30, discount_pct: 15, includes: [] });
  const set = (k, val) => setV((p) => ({ ...p, [k]: val }));
  const { toast } = useSession();
  const can = [v.name.length > 0, v.price_cents > 0, true];
  return (
    <Sheet visible={visible} onClose={onClose} title="New subscription">
      <WizardBar step={step} steps={steps} />
      <T weight="900" size={16} style={{ marginBottom: 12 }}>{steps[step]}</T>
      {step === 0 && (
        <View style={{ gap: 14 }}>
          <Field label="Subscription name" value={v.name} onChangeText={(t) => set('name', t)} placeholder="e.g. Monthly subscription, Quarterly subscription" />
          <T weight="800" size={13} color={c.mute}>Billing period</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {[{ label: 'Monthly', days: 30 }, { label: 'Quarterly', days: 90 }, { label: 'Yearly', days: 365 }].map((o) => <Chip key={o.days} label={o.label} active={v.duration_days === o.days} onPress={() => set('duration_days', o.days)} />)}
          </View>
          <Field label="Description" value={v.description ?? ''} onChangeText={(t) => set('description', t)} multiline optional />
        </View>
      )}
      {step === 1 && (
        <View style={{ gap: 14 }}>
          <Field label={`Price per period (${venue.currency})`} value={v.price_cents != null ? String(v.price_cents / 100) : ''} onChangeText={(t) => set('price_cents', Math.round(parseFloat(t || '0') * 100))} placeholder="0.00" />
          <T weight="800" size={13} color={c.mute}>Discount on every booking</T>
          <Counter value={v.discount_pct} onChange={(n) => set('discount_pct', n)} min={5} max={90} step={5} label="%" />
          <T weight="800" size={13} color={c.mute}>Included perks</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {PERKS.map((p) => <Chip key={p} label={p} active={v.includes.includes(p)} onPress={() => set('includes', v.includes.includes(p) ? v.includes.filter((x) => x !== p) : [...v.includes, p])} />)}
          </View>
        </View>
      )}
      {step === 2 && (
        <View style={{ gap: 14 }}>
          <Card pad={12}><T weight="800">{v.name}</T><T size={12} color={c.mute}>{v.discount_pct}% off every booking · subscription (auto-renew){v.includes.length ? ` · includes ${v.includes.join(', ')}` : ''}</T></Card>
        </View>
      )}
      <WizardFooter step={step} steps={steps} canNext={can[step]} onBack={() => setStep(step - 1)} onNext={() => setStep(step + 1)} submitLabel="Create subscription" onSubmit={async () => { try { await api.post(`/venues/${venue.id}/plans`, { name: v.name, description: v.description, kind: 'membership', auto_renew: true, price_cents: v.price_cents, duration_days: v.duration_days, discount_bp: Math.round(v.discount_pct * 100), includes: v.includes, entitlements: { days: [], guest_quota: 0 } }); onDone(); onClose(); } catch (e) { toast(e.message); } }} />
    </Sheet>
  );
}

/** On the venue page: what's for sale and what you already hold here. */
export function VenuePlans({ venue, onChanged }) {
  const { user, toast } = useSession();
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(null);
  if (!venue.plans?.length) return null;
  const buy = async (p) => {
    if (!user) { toast('Sign in to buy'); return; }
    setBusy(p.id);
    try {
      const up = await api.post(`/venue-plans/${p.id}/buy`, {});
      setPay({ id: up.id, type: 'venue_plan', label: p.name, amount: Number(up.price_cents), currency: up.currency });
    } catch (e) { toast(e.message); } finally { setBusy(null); }
  };
  return (
    <Card color={c.violetSoft}>
      <T weight="700" size={16}>🎟️ Passes, packages & memberships</T>
      {venue.my_member_discount_bp > 0 ? <T size={13} weight="700" style={{ marginTop: 4 }}>You're a member: {venue.my_member_discount_bp / 100}% off until {until(venue.my_membership_until)}</T> : null}
      {venue.my_pass_sessions > 0 ? <T size={13} weight="700">You have {venue.my_pass_sessions} pass sessions here</T> : null}
      {venue.plans.map((p) => (
        <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <T weight="700">{p.name}</T>
            <T size={12} color={c.mute}>{p.kind === 'membership' ? `${p.discount_bp / 100}% off every booking · ${p.duration_days} days` : `${p.sessions} sessions · valid ${p.valid_days} days · each pays up to ${moneyIn(p.session_value_cents, venue.currency)}`}</T>
            {p.description ? <T size={12} color={c.mute}>{p.description}</T> : null}
            {p.resource_ids?.length ? <T size={12} color={c.mute}>Valid on: {p.resource_ids.map((rid) => venue.resources?.find((r) => r.id === rid)?.name).filter(Boolean).join(', ')}</T> : null}
            {p.includes?.length ? <T size={12} color={c.mute}>Includes: {p.includes.join(' · ')}</T> : null}
            {p.auto_renew ? <T size={12} color={c.mute}>Subscription — we'll remind you to renew a week before it ends</T> : null}
          </View>
          <Btn small title={moneyIn(p.price_cents, venue.currency)} loading={busy === p.id} onPress={() => buy(p)} />
        </View>
      ))}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={() => onChanged?.()} /> : null}
    </Card>
  );
}

/** On the Wallet screen: everything you hold. */
export function MyPlans() {
  const { toast } = useSession();
  const plans = useLoad(() => api.get('/me/plans'), []);
  const [pay, setPay] = useState(null);
  return (
    <Section title="Memberships & passes" color={c.violet}>
      {plans.loading && !plans.data ? <Loading /> : plans.data?.length ? plans.data.map((p) => (
        <Row key={p.id} onPress={p.status === 'awaiting_payment' ? () => setPay({ id: p.id, type: 'venue_plan', label: p.name, amount: Number(p.price_cents), currency: p.currency }) : undefined}
          title={`${p.emoji ?? '🎟️'} ${p.name} · ${p.venue_name}`}
          sub={p.status === 'awaiting_payment' ? 'Tap to pay' : p.kind === 'membership' ? `${p.discount_bp / 100}% off · ${p.status === 'expired' ? 'ended' : 'until'} ${until(p.expires_at)}` : `${p.sessions_left} of ${p.sessions_total} sessions left · ${p.status === 'expired' ? 'ended' : 'until'} ${until(p.expires_at)}`}
          right={<Tag label={p.status.replace('_', ' ')} color={p.status === 'active' ? c.mint : p.status === 'awaiting_payment' ? c.sun : c.violetSoft} />} />
      )) : <T size={13} color={c.mute}>Venues sell memberships (a discount on every booking) and multi-session passes. You'll find them on a venue's page.</T>}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={plans.reload} /> : null}
    </Section>
  );
}

/** "Use my pass" for an open invoice. */
export function PassApplySheet({ invoice, onClose, onDone }) {
  const { toast } = useSession();
  const plans = useLoad(() => api.get('/me/plans', { venue_id: invoice.venue_id }), []);
  const [busy, setBusy] = useState(false);
  const passes = (plans.data ?? []).filter((p) => p.kind === 'pass' && p.status === 'active' && p.sessions_left > 0);
  const due = invoice.total_cents - (invoice.credits_cents ?? 0);
  return (
    <Sheet visible onClose={onClose} title="Pay with a pass">
      {plans.loading ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <T>Amount due: <T weight="700">{moneyIn(due, invoice.currency)}</T></T>
          {passes.map((p) => <T key={p.id} size={13} color={c.mute}>{p.name}: {p.sessions_left} sessions left, each pays up to {moneyIn(p.session_value_cents, p.currency)} · until {until(p.expires_at)}</T>)}
          <T size={13} color={c.mute}>As many sessions as the booking needs are used, soonest-expiring pass first. Sessions come back if the booking is cancelled.</T>
          <Btn title={passes.length ? 'Use my pass' : 'No sessions left'} disabled={!passes.length} loading={busy} onPress={async () => {
            setBusy(true);
            try { const r = await api.post(`/invoices/${invoice.id}/pass`, {}); toast(r.paid ? `Paid with ${r.sessions_used} session${r.sessions_used > 1 ? 's' : ''} ✓` : `${r.sessions_used} sessions used`); await onDone?.(); onClose(); } catch (e) { toast(e.message); } finally { setBusy(false); }
          }} />
        </View>
      )}
    </Sheet>
  );
}

/** Venue console tab: define, stop selling, and see how plans are doing. */
export function PlansManager({ v }) {
  const [form, setForm] = useState(null); // 'membership' | 'pass'
  const plans = useLoad(() => api.get(`/venues/${v.id}/plans`), [v.id]);
  const report = useLoad(() => api.get(`/venues/${v.id}/plans/report`), [v.id]);
  const reload = () => { plans.reload(); report.reload(); };
  const rows = report.data?.plans ?? [];
  const meta = (id) => (plans.data ?? []).find((p) => p.id === id);
  const courtNames = (ids) => ids.map((rid) => v.resources.find((r) => r.id === rid)?.name).filter(Boolean).join(', ');
  return (
    <>
    <Section title="Passes, packages & memberships" color={c.violet}>
      <T color={c.mute} size={13}>A pass is prepaid sessions; a package is a pass that only works on the courts you choose and lists what comes with it. A membership takes a % off every booking; make it a subscription and members are reminded to renew a week before it ends. Customers pay online in {v.currency}; the money is collected by the platform.</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="＋ Membership" onPress={() => setForm('membership')} />
        <Btn small title="＋ Subscription" onPress={() => setForm('subscription')} />
        <Btn small title="＋ Pass" color={c.violet} onPress={() => setForm('pass')} />
        <Btn small title="＋ Package" color={c.violet} onPress={() => setForm('package')} />
      </View>
      {report.data ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><StatPill label="Plan sales" value={moneyIn(report.data.revenue_cents, v.currency)} /></View> : null}
      {rows.length ? rows.map((p) => (
        <Card key={p.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{p.kind === 'membership' ? (meta(p.id)?.auto_renew ? '🔁' : '🏅') : (meta(p.id)?.resource_ids?.length ? '📦' : '🎟️')} {p.name} {p.active ? '' : '(not on sale)'}</T>
              {meta(p.id)?.resource_ids?.length || meta(p.id)?.includes?.length || meta(p.id)?.auto_renew ? <T size={12} color={c.mute}>{[meta(p.id).auto_renew && 'subscription', meta(p.id).resource_ids.length && `only ${courtNames(meta(p.id).resource_ids)}`, meta(p.id).includes.length && `includes ${meta(p.id).includes.join(', ')}`].filter(Boolean).join(' · ')}</T> : null}
              <T size={12} color={c.mute}>{p.sold} sold · {p.active_holders} active{p.kind === 'pass' ? ` · ${p.sessions_outstanding} sessions outstanding` : ''} · {moneyIn(Number(p.revenue_cents), v.currency)}</T>
            </View>
            <Btn small title={p.active ? 'Stop selling' : 'Sell again'} color={c.paper} onPress={async () => { await api.patch(`/venue-plans/${p.id}`, { active: !p.active }); reload(); }} />
          </View>
        </Card>
      )) : <Empty emoji="🎟️" title="No plans yet" sub="Add a membership or a pass above." />}
      <MembershipWizard visible={form === 'membership'} onClose={() => setForm(null)} v={v} onDone={reload} />
      <PassWizard visible={form === 'pass'} onClose={() => setForm(null)} v={v} onDone={reload} isPackage={false} />
      <SubscriptionWizard visible={form === 'subscription'} onClose={() => setForm(null)} v={v} onDone={reload} />
      <PassWizard visible={form === 'package'} onClose={() => setForm(null)} v={v} onDone={reload} isPackage={true} />
    </Section>
      <Section title="Renewals waiting for payment" color={c.violet}>
        <T color={c.mute} size={13}>Subscriptions that have renewed and are waiting for the member to pay: who was reminded, who promised to pay, and what is overdue. The same desk academies and clubs use.</T>
        <Collections target={{ venue_id: v.id }} />
      </Section>
    </>
  );
}
