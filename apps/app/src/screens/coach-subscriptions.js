// Monthly coaching subscriptions (issue #659). Athlete / guardian side (subscribe, pay, pause, cancel) and the coach's subscriber list with MRR.
// The UI only calls the API (apps/api/src/capabilities/coach-subscriptions.js); every rule - ownership, guardian consent, billing - is enforced there.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, ErrorBox, Loading, Section, Sheet, T } from '../ui';
import { Pill } from './marketplace';
import { PaySheet } from '../PaySheet';
import { AutoPayPanel } from '../AutoPay';
import { Confirm, Tile } from './coaching';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';
import { moneyIn } from '../vtime';
import { Collections } from './collections';

const day = (d) => new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
const TONE = { active: [c.mint, c.mintSoft], paused: [c.sun, c.sunSoft], past_due: [c.red, c.redSoft], lapsed: [c.mute, c.violetSoft], cancelled: [c.mute, c.violetSoft] };
export const StatusTag = ({ status, ending }) => {
  const [fg, bg] = TONE[status] ?? TONE.cancelled;
  return <Pill label={t(`coachSub.status.${ending && status === 'active' ? 'ending' : status}`).toUpperCase()} fg={fg} bg={bg} />;
};

/** Confirm the terms of a monthly card, create the subscription, then take the first payment. */
export function SubscribeSheet({ card, coach, currency, onClose, onDone }) {
  const { toast, user } = useSession();
  const kids = useLoad(() => api.get('/youth/guardian-links', { as: 'guardian', status: 'active', limit: 50 }).catch(() => []), []);
  const [athleteId, setAthleteId] = useState(user.id);
  const [busy, setBusy] = useState(false), [err, setErr] = useState(null), [pay, setPay] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/coach-subscriptions', { rate_card_id: card.id, ...(athleteId !== user.id ? { athlete_id: athleteId } : {}) });
      setPay({ id: r.period.id, type: 'coach_subscription_period', label: card.title, amount: Number(r.period.price_cents), currency: r.period.currency });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  if (pay) return <PaySheet target={pay} onClose={() => { onClose(); onDone?.(); }} onDone={() => { toast(t('coachSub.active')); onDone?.(); }} />;
  return (
    <Sheet visible onClose={onClose} title={t('coachSub.subscribeTo', { name: coach.display_name })}>
      <Card pad={14} color={c.violetSoft}>
        <T weight="800" size={16}>{card.title}</T>
        <T weight="800" size={20} style={{ marginTop: 4 }}>{t('coachSub.perMonth', { price: moneyIn(Number(card.price_cents), currency) })}</T>
        <View style={{ marginTop: 8, gap: 4 }}>
          {card.sessions_included ? <T size={13}>✓ {t('coachSub.sessionsIncluded', { n: card.sessions_included })}</T> : null}
          {card.rollover_max ? <T size={13}>✓ {t('coachSub.rollover', { n: card.rollover_max })}</T> : null}
          <T size={13}>✓ {t('coachSub.cancelAnytime')}</T>
          <T size={13}>✓ {t('coachSub.graceNote', { n: card.grace_days ?? 3 })}</T>
        </View>
      </Card>
      {kids.data?.length ? <MenuField label={t('coaching.bookingFor')} value={athleteId} onChange={setAthleteId} options={[{ value: user.id, label: user.display_name }, ...kids.data.map((l) => ({ value: l.child_id, label: l.child?.display_name ?? '—' }))]} /> : null}
      {athleteId !== user.id ? <T size={12} color={c.mute}>{t('coachSub.guardianPays')}</T> : null}
      <T size={12} color={c.mute}>{t('coachSub.autoNote')}</T>
      {err ? <T size={13} color={c.red} role="alert">{err}</T> : null}
      <Btn title={busy ? '…' : t('coachSub.continuePay')} onPress={go} disabled={busy} accessibilityLabel={t('coachSub.continuePay')} />
    </Sheet>
  );
}

/** What you (or a child you are guardian of) hold: status, sessions left, the open payment, pause / resume / cancel. */
export function MyCoachSubscriptions() {
  const { toast } = useSession();
  const subs = useLoad(() => api.get('/me/coach-subscriptions', { limit: 50 }), []);
  const autopay = useLoad(() => api.get('/payments/mandates', { limit: 100 }).catch(() => []), []);   // automatic payment (#680): a failure here never hides the subscriptions
  const [pay, setPay] = useState(null), [cancel, setCancel] = useState(null);
  const act = async (s, verb) => { try { await api.post(`/coach-subscriptions/${s.id}/${verb}`); await subs.reload(); toast(t(`coachSub.done.${verb}`)); } catch (e) { toast(e.message); } };
  const rows = subs.data ?? [];
  if (!subs.loading && !subs.error && !rows.length) return null;   // nothing to show until you subscribe to a coach
  return (
    <Section title={t('coachSub.mine')} color={c.violet}>
      {subs.error ? <ErrorBox error={subs.error} onRetry={subs.reload} /> : subs.loading && !subs.data ? <Loading /> : rows.map((s) => {
        const cur = s.periods.find((p) => p.status === 'active' && new Date(p.expires_at) > new Date());
        const live = ['active', 'past_due', 'paused'].includes(s.status);
        return (
          <Card key={s.id} pad={14}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <T weight="800">{s.title}</T>
                <T size={12} color={c.mute}>{s.coach_name}{s.athlete_id !== s.payer_id ? ` · ${t('coachSub.forAthlete', { name: s.athlete_name })}` : ''}</T>
              </View>
              <StatusTag status={s.status} ending={s.cancel_at_period_end} />
            </View>
            <T size={13} style={{ marginTop: 6 }}>{moneyIn(Number(s.price_cents), s.currency)} · {t('coachSub.perMonthShort')}{cur ? ` · ${t('coachSub.sessionsLeft', { n: cur.sessions_left })} · ${s.cancel_at_period_end ? t('coachSub.endsOn', { date: day(cur.expires_at) }) : t('coachSub.renewsOn', { date: day(cur.expires_at) })}` : ''}</T>
            {s.status === 'past_due' ? <T size={12} color={c.red} weight="700" style={{ marginTop: 4 }}>{t('coachSub.pastDueNote', { n: s.grace_days })}</T> : null}
            {s.status === 'lapsed' ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('coachSub.lapsedNote')}</T> : null}
            <AutoPayPanel sub={s} mandates={autopay.data} onChange={async () => { await autopay.reload(); await subs.reload(); }} />
            {live || s.open_period_id ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {s.open_period_id && s.i_pay ? <Btn small title={t('coachSub.payMonth')} accessibilityLabel={t('coachSub.payMonth')} onPress={() => setPay({ id: s.open_period_id, type: 'coach_subscription_period', label: s.title, amount: Number(s.price_cents), currency: s.currency })} /> : null}
                {s.status === 'active' && !s.cancel_at_period_end ? <Btn small title={t('coachSub.pause')} color={c.paper} ink={c.ink} accessibilityLabel={t('coachSub.pause')} onPress={() => act(s, 'pause')} /> : null}
                {s.status === 'paused' ? <Btn small title={t('coachSub.resume')} accessibilityLabel={t('coachSub.resume')} onPress={() => act(s, 'resume')} /> : null}
                {live && !s.cancel_at_period_end ? <Btn small title={t('coachSub.cancelEnd')} color={c.paper} ink={c.red} accessibilityLabel={t('coachSub.cancelEnd')} onPress={() => setCancel(s)} /> : null}
              </View>
            ) : null}
          </Card>
        );
      })}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={subs.reload} /> : null}
      <Confirm visible={!!cancel} title={t('coachSub.cancelTitle')} yes={t('coachSub.cancelEnd')} danger onClose={() => setCancel(null)} body={t('coachSub.cancelBody')}
        onYes={async () => { const s = cancel; setCancel(null); await act(s, 'cancel'); }} />
    </Section>
  );
}

/** The coach's view: monthly recurring revenue, reconciliation to payments, and every subscriber. */
export function CoachSubscribers() {
  const { toast } = useSession();
  const rep = useLoad(() => api.get('/coach/subscriptions', { limit: 100 }), []);
  const [cancel, setCancel] = useState(null);
  const d = rep.data;
  if (rep.error) return <Section title={t('coachSub.subscribers')} color={c.violet}><ErrorBox error={rep.error} onRetry={rep.reload} /></Section>;
  if (!d) return rep.loading ? <Loading /> : null;
  return (
    <Section title={t('coachSub.subscribers')} color={c.violet}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {d.mrr.length ? d.mrr.map((m) => <Tile key={m.currency} value={moneyIn(Number(m.mrr_cents), m.currency)} label={t('coachSub.mrr')} />) : <Tile value="—" label={t('coachSub.mrr')} />}
        <Tile value={String((d.counts.active ?? 0) + (d.counts.past_due ?? 0))} label={t('coachSub.live')} />
        {d.counts.past_due ? <Tile value={String(d.counts.past_due)} label={t('coachSub.status.past_due')} /> : null}
      </View>
      {d.revenue.map((r) => <T key={r.currency} size={12} color={r.reconciled ? c.mute : c.red}>{r.reconciled ? '✓ ' : '⚠ '}{t(r.reconciled ? 'coachSub.reconciled' : 'coachSub.notReconciled', { paid: moneyIn(Number(r.paid_cents), r.currency), n: r.periods_paid })}</T>)}
      {!d.items.length ? <T size={13} color={c.mute}>{t('coachSub.noSubscribers')}</T> : d.items.map((s) => {
        const cur = s.periods.find((p) => p.status === 'active' && new Date(p.expires_at) > new Date());
        return (
          <Card key={s.id} pad={12}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <View style={{ flex: 1 }}><T weight="800">{s.athlete_name}</T><T size={12} color={c.mute}>{s.title} · {moneyIn(Number(s.price_cents), s.currency)}</T></View>
              <StatusTag status={s.status} ending={s.cancel_at_period_end} />
            </View>
            {cur ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('coachSub.sessionsLeft', { n: cur.sessions_left })} · {t(s.cancel_at_period_end ? 'coachSub.endsOn' : 'coachSub.renewsOn', { date: day(cur.expires_at) })}</T> : null}
            {['active', 'past_due', 'paused'].includes(s.status) && !s.cancel_at_period_end ? <Btn small title={t('coachSub.endForClient')} color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} accessibilityLabel={t('coachSub.endForClient')} onPress={() => setCancel(s)} /> : null}
          </Card>
        );
      })}
      <Confirm visible={!!cancel} title={t('coachSub.endForClient')} yes={t('coachSub.endForClient')} danger onClose={() => setCancel(null)} body={t('coachSub.endForClientBody')}
        onYes={async () => { const s = cancel; setCancel(null); try { await api.post(`/coach-subscriptions/${s.id}/cancel`); await rep.reload(); toast(t('coachSub.done.cancel')); } catch (e) { toast(e.message); } }} />
    </Section>
  );
}

/** A coach's late subscription months, in the one collections desk (same states, reminders, promises and holds as every other receivable). */
export function CoachLatePayments() {
  const { user } = useSession();
  if (!user?.id) return null;
  return (
    <Section title={t('collections.coach.title')} color={c.violet}>
      <Collections target={{ coach_id: user.id }} />
    </Section>
  );
}

// ================================================================================== PREPAID SESSION PACKAGES (issue #655)
// A package rate card (unit "package", one-to-one) is a real balance: buy it here, spend a session when booking ("Pay with" in the booking sheet),
// see what is left, and get the unused part back. The UI only calls /coach-packages and /me/coach-packages; ownership, guardian consent, expiry and refunds are enforced there.

/** A package card that is a prepaid balance (one-to-one, with a number of sessions). Other package cards stay a price label, as before. */
export const isRedeemablePack = (k) => k.unit === 'package' && k.audience === 'individual' && !k.per_person && !!k.sessions_included;

const PKG_TONE = { active: [c.mint, c.mintSoft], awaiting_payment: [c.sun, c.sunSoft], used_up: [c.mute, c.violetSoft], expired: [c.red, c.redSoft], refunded: [c.mute, c.violetSoft], cancelled: [c.mute, c.violetSoft] };
const PackageTag = ({ state }) => { const [fg, bg] = PKG_TONE[state] ?? PKG_TONE.cancelled; return <Pill label={t(`pkg.state.${state}`).toUpperCase()} fg={fg} bg={bg} />; };
const Balance = ({ left, total }) => (
  <View accessible accessibilityLabel={t('pkg.left', { n: left, total })} style={{ marginTop: 8, gap: 4 }}>
    <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 8, width: `${total ? Math.round((left / total) * 100) : 0}%`, backgroundColor: c.mint }} /></View>
    <T size={13} weight="700">{t('pkg.left', { n: left, total })}</T>
  </View>
);

/** Confirm the terms of a package card, create the purchase, then take the payment. */
export function BuyPackageSheet({ card, coach, currency, onClose, onDone }) {
  const { toast, user } = useSession();
  const kids = useLoad(() => api.get('/youth/guardian-links', { as: 'guardian', status: 'active', limit: 50 }).catch(() => []), []);
  const [athleteId, setAthleteId] = useState(user.id);
  const [busy, setBusy] = useState(false), [err, setErr] = useState(null), [pay, setPay] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/coach-packages', { rate_card_id: card.id, ...(athleteId !== user.id ? { athlete_id: athleteId } : {}) });
      if (!r.pay) { toast(t('pkg.done')); onDone?.(); onClose(); return; }   // free, or a platform without payments: ready straight away
      setPay({ id: r.package.id, type: 'coach_package', label: card.title, amount: Number(r.package.price_cents), currency: r.package.currency });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  if (pay) return <PaySheet target={pay} onClose={() => { onClose(); onDone?.(); }} onDone={() => { toast(t('pkg.done')); onDone?.(); }} />;
  return (
    <Sheet visible onClose={onClose} title={t('pkg.buyTitle', { title: card.title })}>
      <Card pad={14} color={c.violetSoft}>
        <T weight="800" size={16}>{coach.display_name}</T>
        <T weight="800" size={20} style={{ marginTop: 4 }}>{moneyIn(Number(card.price_cents), currency)}</T>
        <T size={13} style={{ marginTop: 6 }}>✓ {card.valid_days ? t('pkg.summary', { n: card.sessions_included, days: card.valid_days }) : t('pkg.summaryNoExpiry', { n: card.sessions_included })}</T>
      </Card>
      {kids.data?.length ? <MenuField label={t('coaching.bookingFor')} value={athleteId} onChange={setAthleteId} options={[{ value: user.id, label: user.display_name }, ...kids.data.map((l) => ({ value: l.child_id, label: l.child_name ?? l.child?.display_name ?? '' }))]} /> : null}
      {athleteId !== user.id ? <T size={12} color={c.mute}>{t('pkg.guardianPays')}</T> : null}
      {err ? <T size={13} color={c.red} role="alert">{err}</T> : null}
      <Btn title={busy ? '…' : t('pkg.continuePay')} onPress={go} disabled={busy} accessibilityLabel={t('pkg.continuePay')} />
    </Sheet>
  );
}

const Spent = ({ rows }) => (
  <View style={{ marginTop: 8, gap: 2 }}>
    <T size={12} weight="800" color={c.mute}>{t('pkg.history')}</T>
    {rows.length ? rows.slice(0, 6).map((h) => <T key={h.hire_id} size={12} color={h.counts ? c.ink : c.mute}>{day(h.starts_at)}{h.counts ? '' : ` · ${t('pkg.returned')}`}</T>) : <T size={12} color={c.mute}>{t('pkg.noHistory')}</T>}
  </View>
);

/** What you (or a child you are guardian of) hold: sessions left, expiry, history, pay / cancel an open purchase, refund the unused part. */
export function MyCoachPackages() {
  const { toast } = useSession();
  const pk = useLoad(() => api.get('/me/coach-packages', { limit: 50 }), []);
  const [pay, setPay] = useState(null), [refund, setRefund] = useState(null);
  const rows = pk.data ?? [];
  if (!pk.loading && !pk.error && !rows.length) return null;   // nothing to show until you buy a package
  return (
    <Section title={t('pkg.mine')} color={c.violet}>
      {pk.error ? <ErrorBox error={pk.error} onRetry={pk.reload} /> : pk.loading && !pk.data ? <Loading /> : rows.map((p) => (
        <Card key={p.id} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800">{p.title}</T>
              <T size={12} color={c.mute}>{p.coach_name}{p.athlete_id !== p.payer_id ? ` · ${t('pkg.forAthlete', { name: p.athlete_name })}` : ''}</T>
            </View>
            <PackageTag state={p.state} />
          </View>
          {['active', 'used_up', 'expired'].includes(p.state) ? <Balance left={p.sessions_left} total={p.sessions_total} /> : null}
          {p.status === 'active' ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{p.expires_at ? t('pkg.expires', { date: day(p.expires_at) }) : t('pkg.noExpiry')}</T> : null}
          {p.history.length || p.status === 'active' ? <Spent rows={p.history} /> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {p.pay ? <Btn small title={t('pkg.payNow')} accessibilityLabel={`${t('pkg.payNow')} · ${p.title}`} onPress={() => setPay({ id: p.id, type: 'coach_package', label: p.title, amount: Number(p.price_cents), currency: p.currency })} /> : null}
            {p.pay ? <Btn small title={t('pkg.cancelBuy')} color={c.paper} ink={c.red} accessibilityLabel={`${t('pkg.cancelBuy')} · ${p.title}`} onPress={async () => { try { await api.post(`/coach-packages/${p.id}/cancel`); await pk.reload(); } catch (e) { toast(e.message); } }} /> : null}
            {p.status === 'active' && p.sessions_left > 0 && p.refund_estimate_cents > 0 && (p.i_pay || p.athlete_id !== p.payer_id) ? <Btn small title={t('pkg.refund')} color={c.paper} ink={c.red} accessibilityLabel={`${t('pkg.refund')} · ${p.title}`} onPress={() => setRefund(p)} /> : null}
          </View>
        </Card>
      ))}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={pk.reload} /> : null}
      <Confirm visible={!!refund} title={t('pkg.refundTitle')} yes={t('pkg.refund')} danger onClose={() => setRefund(null)}
        body={refund ? t('pkg.refundBody', { n: refund.sessions_left, amount: moneyIn(refund.refund_estimate_cents, refund.currency) }) : ''}
        onYes={async () => { const p = refund; setRefund(null); try { await api.post(`/coach-packages/${p.id}/refund`, {}); await pk.reload(); toast(t('pkg.refunded')); } catch (e) { toast(e.message); } }} />
    </Section>
  );
}

/** The coach's view: packages sold, sessions still owed (unearned revenue) and every buyer's balance; the coach can refund the unused part. */
export function CoachPackageBuyers() {
  const { toast } = useSession();
  const rep = useLoad(() => api.get('/coach/packages', { limit: 100 }), []);
  const [refund, setRefund] = useState(null);
  const d = rep.data;
  if (rep.error) return <Section title={t('pkg.buyers')} color={c.violet}><ErrorBox error={rep.error} onRetry={rep.reload} /></Section>;
  if (!d) return rep.loading ? <Loading /> : null;
  return (
    <Section title={t('pkg.buyers')} color={c.violet}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Tile value={String(d.totals.sold)} label={t('pkg.sold')} />
        <Tile value={String(d.totals.sessions_left)} label={t('pkg.owedSessions')} />
        <Tile value={moneyIn(d.totals.unearned_cents, d.totals.currency)} label={t('pkg.owedValue')} />
      </View>
      {!d.packages.length ? <T size={13} color={c.mute}>{t('pkg.noBuyers')}</T> : d.packages.map((p) => (
        <Card key={p.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{p.athlete_name}</T><T size={12} color={c.mute}>{p.title} · {moneyIn(p.price_cents, p.currency)}</T></View>
            <PackageTag state={p.state} />
          </View>
          <Balance left={p.sessions_left} total={p.sessions_total} />
          {p.expires_at ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('pkg.expires', { date: day(p.expires_at) })}</T> : null}
          {p.refund_estimate_cents > 0 ? <Btn small title={t('pkg.refund')} color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} accessibilityLabel={`${t('pkg.refund')} · ${p.athlete_name}`} onPress={() => setRefund(p)} /> : null}
        </Card>
      ))}
      <Confirm visible={!!refund} title={t('pkg.refundTitle')} yes={t('pkg.refund')} danger onClose={() => setRefund(null)}
        body={refund ? t('pkg.refundBody', { n: refund.sessions_total - refund.sessions_used, amount: moneyIn(refund.refund_estimate_cents, refund.currency) }) : ''}
        onYes={async () => { const p = refund; setRefund(null); try { await api.post(`/coach-packages/${p.id}/refund`, {}); await rep.reload(); toast(t('pkg.refunded')); } catch (e) { toast(e.message); } }} />
    </Section>
  );
}
