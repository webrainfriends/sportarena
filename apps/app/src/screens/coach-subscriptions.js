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
import { Confirm, Tile } from './coaching';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';
import { moneyIn } from '../vtime';

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
      <T size={12} color={c.mute}>{t('coachSub.noAutoCharge')}</T>
      {err ? <T size={13} color={c.red} role="alert">{err}</T> : null}
      <Btn title={busy ? '…' : t('coachSub.continuePay')} onPress={go} disabled={busy} accessibilityLabel={t('coachSub.continuePay')} />
    </Sheet>
  );
}

/** What you (or a child you are guardian of) hold: status, sessions left, the open payment, pause / resume / cancel. */
export function MyCoachSubscriptions() {
  const { toast } = useSession();
  const subs = useLoad(() => api.get('/me/coach-subscriptions', { limit: 50 }), []);
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
