// Memberships and multi-session passes: what a venue sells, what you hold, using a pass on an invoice, and the venue team's plan manager.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, Loading, Row, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';

const until = (d) => new Date(d).toLocaleDateString(locale);

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
      <T weight="700" size={16}>🎟️ Memberships & passes</T>
      {venue.my_member_discount_bp > 0 ? <T size={13} weight="700" style={{ marginTop: 4 }}>You're a member: {venue.my_member_discount_bp / 100}% off until {until(venue.my_membership_until)}</T> : null}
      {venue.my_pass_sessions > 0 ? <T size={13} weight="700">You have {venue.my_pass_sessions} pass sessions here</T> : null}
      {venue.plans.map((p) => (
        <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <T weight="700">{p.name}</T>
            <T size={12} color={c.mute}>{p.kind === 'membership' ? `${p.discount_bp / 100}% off every booking · ${p.duration_days} days` : `${p.sessions} sessions · valid ${p.valid_days} days · each pays up to ${moneyIn(p.session_value_cents, venue.currency)}`}</T>
            {p.description ? <T size={12} color={c.mute}>{p.description}</T> : null}
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
  return (
    <Section title="Memberships & passes" color={c.violet}>
      <T color={c.mute} size={13}>Sell a membership (a % off every booking for a period) or a pass (prepaid sessions). Customers pay online in {v.currency}; the money is collected by the platform.</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="＋ Membership" onPress={() => setForm('membership')} />
        <Btn small title="＋ Pass" color={c.violet} onPress={() => setForm('pass')} />
      </View>
      {report.data ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><StatPill label="Plan sales" value={moneyIn(report.data.revenue_cents, v.currency)} /></View> : null}
      {rows.length ? rows.map((p) => (
        <Card key={p.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{p.kind === 'membership' ? '🏅' : '🎟️'} {p.name} {p.active ? '' : '(not on sale)'}</T>
              <T size={12} color={c.mute}>{p.sold} sold · {p.active_holders} active{p.kind === 'pass' ? ` · ${p.sessions_outstanding} sessions outstanding` : ''} · {moneyIn(Number(p.revenue_cents), v.currency)}</T>
            </View>
            <Btn small title={p.active ? 'Stop selling' : 'Sell again'} color={c.paper} onPress={async () => { await api.patch(`/venue-plans/${p.id}`, { active: !p.active }); reload(); }} />
          </View>
        </Card>
      )) : <Empty emoji="🎟️" title="No plans yet" sub="Add a membership or a pass above." />}
      <FormSheet visible={form === 'membership'} onClose={() => setForm(null)} title="New membership" submitLabel="Create"
        fields={[{ key: 'name', label: 'Name', type: 'chips', options: ['Silver member', 'Gold member', 'Platinum member', 'Monthly member', 'Annual member'] },
          { key: 'description', label: 'Description', optional: true },
          { key: 'price_cents', label: 'Price', type: 'money', currency: v.currency },
          { key: 'duration_days', label: 'Lasts', type: 'chips', default: 30, options: [{ value: 30, label: '1 month' }, { value: 90, label: '3 months' }, { value: 180, label: '6 months' }, { value: 365, label: '1 year' }] },
          { key: 'discount_pct', label: 'Discount on every booking', type: 'stepper', min: 5, max: 90, step: 5, default: 10, suffix: '%' }]}
        onSubmit={async ({ discount_pct, ...f }) => { await api.post(`/venues/${v.id}/plans`, { ...f, kind: 'membership', discount_bp: Math.round(discount_pct * 100) }); reload(); return 'Membership created'; }} />
      <FormSheet visible={form === 'pass'} onClose={() => setForm(null)} title="New pass" submitLabel="Create"
        fields={[{ key: 'name', label: 'Name', type: 'chips', options: ['5-session pass', '10-session pass', '20-session pass', 'Coaching pack'] },
          { key: 'description', label: 'Description', optional: true },
          { key: 'price_cents', label: 'Price for the whole pass', type: 'money', currency: v.currency },
          { key: 'sessions', label: 'Sessions', type: 'chips', default: 10, options: [5, 10, 20, 30, 50].map((n) => ({ value: n, label: String(n) })) },
          { key: 'valid_days', label: 'Use within', type: 'chips', default: 90, options: [{ value: 30, label: '1 month' }, { value: 90, label: '3 months' }, { value: 180, label: '6 months' }, { value: 365, label: '1 year' }] },
          { key: 'session_value_cents', label: 'Most one session pays toward a booking', type: 'money', currency: v.currency, optional: true, hint: 'Leave empty to use price ÷ sessions' }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/plans`, { ...f, kind: 'pass' }); reload(); return 'Pass created'; }} />
    </Section>
  );
}
