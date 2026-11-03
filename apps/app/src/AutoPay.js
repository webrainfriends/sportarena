// Automatic payment for a coaching subscription (#680): one control for UPI AutoPay (#694) and a saved card. The UI only calls the mandate capabilities
// (create / confirm / list / cancel_payment_mandate); guardian consent, ownership, price limits and live revocation are enforced there, never here.
// Card details are entered on the payment provider's own page and never reach the app or the server.
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, View } from 'react-native';
import { api } from './api';
import { CLIENT, openCheckout } from './checkout';
import { useLoad } from './hooks';
import { useSession } from './session';
import { Btn, Chip, Loading, Sheet, T } from './ui';
import { Confirm } from './screens/coaching';
import { Pill } from './screens/marketplace';
import { c } from './theme';
import { t } from './i18n';
import { locale } from './locale';
import { moneyIn } from './vtime';

const day = (d) => new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
export const LIVE = ['created', 'authorised', 'active'];
/** The newest mandate for a subscription (live first). */
export const mandateFor = (mandates, subId) => (mandates ?? []).filter((m) => m.subject_kind === 'coach_subscription' && m.subject_id === subId).sort((a, b) => (LIVE.includes(b.status) ? 1 : 0) - (LIVE.includes(a.status) ? 1 : 0) || new Date(b.created_at) - new Date(a.created_at))[0] ?? null;

/** Choose card or UPI, then approve on the provider's page. Resolves through onDone when the mandate is live. */
export function AutoPaySheet({ sub, onClose, onDone }) {
  const { toast } = useSession();
  const methods = useLoad(() => api.get('/payments/methods', { currency: sub.currency }), [sub.currency]);
  const [method, setMethod] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState(null), [mdt, setMdt] = useState(null);
  const offered = [];
  if (methods.data?.methods?.includes('card') && methods.data.providers?.includes('stripe')) offered.push('card');
  if (sub.currency === 'INR' && methods.data?.methods?.includes('upi') && methods.data.providers?.includes('razorpay')) offered.push('upi');
  const chosen = method ?? offered[0];
  const forChild = sub.athlete_id !== sub.payer_id;
  const finished = useRef(false);
  const check = async (quiet) => {
    if (!mdt || finished.current) return;
    if (!quiet) { setBusy(true); setErr(null); }
    try {
      const r = await api.post(`/payments/mandates/${mdt.id}/confirm`);
      if (r.status === 'active' || r.status === 'authorised') { finished.current = true; toast(t('autopay.done')); await onDone?.(); onClose(); } else if (!quiet) setErr(t('autopay.pending'));
    } catch (e) { if (!quiet) setErr(e.message); } finally { if (!quiet) setBusy(false); }
  };
  // coming back from the provider's page (another tab, or the in-app browser) checks by itself; the provider, not the app, says whether it worked
  useEffect(() => {
    if (!mdt) return undefined;
    const timer = setInterval(() => check(true), 4000);
    const sub2 = Platform.OS === 'web' ? null : AppState.addEventListener('change', (s) => { if (s === 'active') check(true); });
    return () => { clearInterval(timer); sub2?.remove(); };
  }, [mdt?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { subject_kind: 'coach_subscription', subject_id: sub.id, method: chosen, ...(chosen === 'card' ? (Platform.OS === 'web' ? { return_url: `${window.location.origin}${window.location.pathname}` } : { client: CLIENT }) : {}) };
      const m = await api.post('/payments/mandates', body);
      setMdt(m);
      if (!m.authorisation_url) return;
      if (Platform.OS === 'web') window.open(m.authorisation_url, '_blank', 'noopener');
      else if (chosen === 'card') { await openCheckout(m.authorisation_url); const r = await api.post(`/payments/mandates/${m.id}/confirm`); if (r.status === 'active') { finished.current = true; toast(t('autopay.done')); await onDone?.(); onClose(); } }
      else await Linking.openURL(m.authorisation_url);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('autopay.title')}>
      <T size={14} color={c.mute}>{sub.title} · <T weight="800" size={14}>{t('coachSub.perMonth', { price: moneyIn(Number(sub.price_cents), sub.currency) })}</T></T>
      {methods.loading && !methods.data ? <Loading /> : !offered.length ? <T weight="700" color={c.red}>{t('autopay.unavailable')}</T> : mdt ? (
        <View style={{ gap: 10 }}>
          <T size={14}>{t('autopay.opened')}</T>
          <Btn title={t('autopay.check')} onPress={() => check(false)} loading={busy} accessibilityLabel={t('autopay.check')} />
          {mdt.authorisation_url ? <Btn title={t('pay.reopen')} color={c.paper} ink={c.ink} onPress={() => (Platform.OS === 'web' ? window.open(mdt.authorisation_url, '_blank', 'noopener') : Linking.openURL(mdt.authorisation_url))} accessibilityLabel={t('pay.reopen')} /> : null}
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          {offered.length > 1 ? (
            <View style={{ gap: 6 }}>
              <T size={12} weight="800" color={c.mute}>{t('autopay.method')}</T>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{offered.map((m) => <Chip key={m} label={t(`autopay.method.${m}`)} active={chosen === m} onPress={() => setMethod(m)} />)}</View>
            </View>
          ) : <Pill label={t(`autopay.method.${chosen}`).toUpperCase()} fg={c.violet} bg={c.violetSoft} />}
          <View style={{ gap: 4 }}>
            {['how1', 'how2', 'how3', 'how4'].map((k) => <T key={k} size={13}>✓ {t(`autopay.${k}`)}</T>)}
          </View>
          {chosen === 'card' ? <T size={12} color={c.mute}>{t('autopay.cardNote')}</T> : null}
          {forChild ? <T size={12} color={c.mute}>{t('autopay.guardian', { name: sub.athlete_name })}</T> : null}
          <Btn title={t('autopay.turnOn')} onPress={go} loading={busy} accessibilityLabel={t('autopay.turnOn')} />
        </View>
      )}
      {err ? <T size={13} color={c.red} weight="700" role="alert">{err}</T> : null}
    </Sheet>
  );
}

/** One line of facts, label above value, that wraps on a phone and sits in a row on a tablet or desktop. */
const Fact = ({ label, value, tone }) => (
  <View style={{ flexGrow: 1, flexBasis: 120, minWidth: 110 }} accessible accessibilityLabel={`${label}: ${value}`}>
    <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.6 }}>{label.toUpperCase()}</T>
    <T size={14} weight="800" color={tone ?? c.ink} style={{ marginTop: 2 }}>{value}</T>
  </View>
);

/** The subscription card's automatic-payment panel: status, the card on file, next charge, last result, and turn on / off. */
export function AutoPayPanel({ sub, mandates, onChange }) {
  const { toast } = useSession();
  const [setup, setSetup] = useState(false), [off, setOff] = useState(false);
  const m = mandateFor(mandates, sub.id);
  const live = m && LIVE.includes(m.status);
  const open = sub.periods?.find((p) => p.status === 'awaiting_payment');
  if (!sub.i_pay || !['active', 'past_due'].includes(sub.status)) return null;       // only the payer decides, and only while the subscription is running
  const last = m?.last_charge;
  const lastText = last ? `${t(`autopay.result.${last.status}`)} · ${t('coachSub.period', { n: last.period_no })}` : t('autopay.result.none');
  const method = m?.method === 'card' && m.card ? `${cap1(m.card.brand)} •••• ${m.card.last4}` : m?.method === 'upi' ? t('autopay.method.upi') : '—';
  return (
    <View style={{ marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 12, gap: 10, backgroundColor: live ? c.mintSoft : c.paper }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <T weight="800" style={{ flex: 1 }}>{t('autopay.title')}</T>
        <Pill label={t(live ? 'autopay.on' : 'autopay.off').toUpperCase()} fg={live ? c.mint : c.mute} bg={live ? c.mintSoft : c.violetSoft} />
      </View>
      {live ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <Fact label={t('autopay.method')} value={method} />
          <Fact label={t('autopay.nextCharge')} value={open?.due_on ? `${day(open.due_on)} · ${moneyIn(Number(sub.price_cents), sub.currency)}` : t('autopay.nextWhenRaised')} />
          <Fact label={t('autopay.lastResult')} value={lastText} tone={last?.status === 'failed' ? c.red : undefined} />
          {m.card?.exp ? <Fact label={t('autopay.expires')} value={m.card.exp} /> : null}
        </View>
      ) : m?.revoked_reason && ['halted', 'cancelled'].includes(m.status) ? <T size={12} color={c.red} weight="700">{t('autopay.stopped')}: {m.revoked_reason}</T> : <T size={12} color={c.mute}>{t('autopay.offNote')}</T>}
      {live && last?.status === 'failed' ? <T size={12} color={c.red}>{last.reason}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {live ? <Btn small title={t('autopay.turnOff')} color={c.paper} ink={c.red} accessibilityLabel={`${t('autopay.turnOff')} · ${sub.title}`} onPress={() => setOff(true)} />
          : <Btn small title={m ? t('autopay.setupAgain') : t('autopay.turnOn')} accessibilityLabel={`${t('autopay.turnOn')} · ${sub.title}`} onPress={() => setSetup(true)} />}
      </View>
      {setup ? <AutoPaySheet sub={sub} onClose={() => setSetup(false)} onDone={onChange} /> : null}
      <Confirm visible={off} title={t('autopay.confirmTitle')} yes={t('autopay.turnOff')} danger onClose={() => setOff(false)} body={t('autopay.confirmBody')}
        onYes={async () => { setOff(false); try { await api.post(`/payments/mandates/${m.id}/cancel`); await onChange?.(); toast(t('autopay.offDone')); } catch (e) { toast(e.message); } }} />
    </View>
  );
}
