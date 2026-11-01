import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, View } from 'react-native';
import { api } from './api';
import { CLIENT, openCheckout } from './checkout';
import { useLoad } from './hooks';
import { useSession } from './session';
import { Btn, Field, Loading, Sheet, T } from './ui';
import { QrCode } from './screens/passport';
import { c } from './theme';
import { PointsSheet } from './screens/rewards';
import { CoverSendSheet } from './screens/cover-ui';
import { moneyIn } from './vtime';
import { t } from './i18n';

// Method families the admin can switch per country, with the provider that serves each when several can. Labels come from the language packs.
const ORDER = ['upi', 'card', 'netbanking', 'wallet', 'paypal'];
const PROVIDER = { card: ['stripe', 'razorpay'], paypal: ['paypal'], upi: ['razorpay'], netbanking: ['razorpay'], wallet: ['razorpay'] };
const PROVIDER_NAME = { stripe: 'Stripe', paypal: 'PayPal', razorpay: 'Razorpay' };
const providerFor = (method, offered) => PROVIDER[method].find((p) => offered.includes(p));

/**
 * Hosted checkout for one invoice, in the invoice's own currency: pick Stripe or PayPal, pay on the provider's page, then confirm.
 * target = { id, label, amount, currency }. Card details never touch Gotmygame.
 */
export function PaySheet({ target, onClose, onDone }) {
  const { toast } = useSession();
  const methods = useLoad(() => api.get('/payments/methods', target.currency ? { currency: target.currency } : undefined), [target.currency]);
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [points, setPoints] = useState(false);
  const [cover, setCover] = useState(false);
  const [upi, setUpi] = useState(false);          // the UPI panel (open my UPI app, or send a request to my UPI ID)
  const [vpa, setVpa] = useState('');
  const [mobile, setMobile] = useState('');
  const [auto, setAuto] = useState(null);         // a UPI AutoPay mandate that was just set up
  const balances = useLoad(() => api.get('/me/loyalty'), []);
  const go = async (method) => {
    const provider = providerFor(method, methods.data?.providers ?? []);
    setBusy(true); setErr(null);
    try {
      const p = await api.post('/payments', { purpose_type: target.type ?? 'venue_invoice', purpose_id: target.id, provider, method, country: methods.data?.country ?? undefined, return_url: Platform.OS === 'web' ? `${window.location.origin}${window.location.pathname}` : undefined, client: CLIENT });
      setPay(p);
      // on a phone the checkout opens in a sheet that closes by itself when the provider returns; then we ask the server how it went
      if (Platform.OS === 'web') window.location.assign(p.checkout_url); else { setBusy(false); await openCheckout(p.checkout_url); await check(p.id, true); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  // UPI without leaving the app: collect (a request lands in the customer's UPI app) or intent (a upi:// link / QR for any UPI app)
  const goUpi = async (flow) => {
    setBusy(true); setErr(null);
    try {
      const p = await api.post('/payments', { purpose_type: target.type ?? 'venue_invoice', purpose_id: target.id, provider: 'razorpay', method: 'upi', country: methods.data?.country ?? undefined, upi: { flow, ...(flow === 'collect' ? { vpa: vpa.trim() } : {}), ...(mobile.trim() ? { contact: mobile.trim() } : {}) } });
      setPay(p);
      if (flow === 'intent' && Platform.OS !== 'web' && p.upi_intent_url) await Linking.openURL(p.upi_intent_url);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const setUpAutoPay = async () => {
    setBusy(true); setErr(null);
    try {
      const mdt = await api.post('/payments/mandates', { subject_kind: target.type === 'venue_plan' ? 'membership' : 'coach_subscription', subject_id: target.id });
      setAuto(mdt);
      if (Platform.OS === 'web') window.open(mdt.authorisation_url, '_blank', 'noopener'); else await Linking.openURL(mdt.authorisation_url);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  // Ask the server whether the payment went through (the only source of truth). quiet = an automatic check: no spinner, no "not paid yet" message.
  const finished = useRef(false);
  const check = async (id = pay?.id, quiet = false) => {
    if (!id || finished.current) return;
    if (!quiet) { setBusy(true); setErr(null); }
    try {
      const r = await api.post(`/payments/${id}/confirm`);
      if (r.status === 'paid') { finished.current = true; toast('Payment received ✓'); await onDone?.(); onClose(); } else if (!quiet) setErr('Not paid yet — finish the checkout, then check again.');
    } catch (e) { if (!quiet) setErr(e.message); } finally { if (!quiet) setBusy(false); }
  };
  // Coming back to the app after paying elsewhere (a UPI app, a bank app, the browser) checks automatically; a UPI request is also checked every few seconds for a while.
  const payId = pay?.id;
  useEffect(() => {
    if (!payId || Platform.OS === 'web') return undefined;
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check(payId, true); });
    return () => sub.remove();
  }, [payId]); // eslint-disable-line react-hooks/exhaustive-deps
  const collecting = pay?.upi_flow === 'collect';
  useEffect(() => {
    if (!payId || !collecting) return undefined;
    let n = 0;
    const timer = setInterval(() => { if (++n > 20) clearInterval(timer); else check(payId, true); }, 4000);
    return () => clearInterval(timer);
  }, [payId, collecting]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = methods.data;
  const mobileOk = !!m?.contact_known || /^\+?[0-9]{10,13}$/.test(mobile.trim());   // UPI needs a mobile number: the account's own, or one typed here
  return (
    <Sheet visible onClose={onClose} title={t('pay.secure')}>
      <T size={14} color={c.mute}>{target.label} · <T weight="800" size={14}>{moneyIn(target.amount, target.currency)}</T> ({target.currency})</T>
      {methods.loading && !m ? <Loading /> : !m?.providers.length ? (
        <T weight="700" color={c.red}>{t('pay.none_country')}</T>
      ) : pay?.upi_flow ? (
        <View style={{ gap: 10 }}>
          {pay.upi_flow === 'intent' ? (
            <View style={{ gap: 10, alignItems: 'center' }}>
              <T size={14}>{t('pay.upi.scan')}</T>
              {pay.upi_intent_url ? <QrCode value={pay.upi_intent_url} size={190} label={t('pay.upi.scan')} /> : null}
              {pay.upi_intent_url ? <Btn title={t('pay.upi.app')} color={c.paper} ink={c.ink} onPress={() => Linking.openURL(pay.upi_intent_url)} /> : null}
            </View>
          ) : <T size={14}>{t('pay.upi.waiting')}</T>}
          <Btn title={t('pay.paid_check')} onPress={() => check()} loading={busy} />
        </View>
      ) : pay ? (
        <View style={{ gap: 10 }}>
          <T size={14}>{t('pay.opened', { provider: PROVIDER_NAME[pay.provider] ?? pay.provider })}</T>
          <Btn title={t('pay.paid_check')} onPress={() => check()} loading={busy} />
          <Btn title={t('pay.reopen')} color={c.paper} onPress={async () => { await openCheckout(pay.checkout_url); if (Platform.OS !== 'web') await check(pay.id, true); }} />
        </View>
      ) : upi ? (
        <View style={{ gap: 10 }}>
          <T weight="800">{t('pay.method.upi')}</T>
          {m.contact_known ? null : <Field label={t('pay.upi.mobile')} value={mobile} onChangeText={(x) => setMobile(x.replace(/[^0-9+]/g, ''))} keyboardType="phone-pad" maxLength={13} accessibilityLabel={t('pay.upi.mobile')} />}
          <Btn title={t('pay.upi.app')} onPress={() => goUpi('intent')} loading={busy} disabled={!mobileOk} accessibilityLabel={t('pay.upi.app')} />
          <T size={12} color={c.mute}>{t('pay.upi.or')}</T>
          <Field label={t('pay.upi.vpa')} value={vpa} onChangeText={setVpa} placeholder={t('pay.upi.vpa_hint')} accessibilityLabel={t('pay.upi.vpa')} />
          <Btn title={t('pay.upi.send')} color={c.paper} ink={c.ink} onPress={() => goUpi('collect')} loading={busy} disabled={!mobileOk || !/^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/.test(vpa.trim())} accessibilityLabel={t('pay.upi.send')} />
          <Btn title="‹" color={c.paper} ink={c.ink} onPress={() => setUpi(false)} accessibilityLabel={t('pay.upi.back')} />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Btn title={t('pay.ask_other')} color={c.paper} ink={c.ink} onPress={() => setCover(true)} />
          {balances.data?.length && ['venue_invoice', 'academy_charge', 'coach_hire'].includes(target.type ?? 'venue_invoice') ? <Btn title={t('pay.points')} color={c.violet} onPress={() => setPoints(true)} /> : null}
          {ORDER.filter((x) => (m.methods ?? []).includes(x)).map((x, i) => <Btn key={x} title={t(`pay.method.${x}`)} color={i === 0 ? undefined : c.paper} ink={i === 0 ? undefined : c.ink} onPress={() => (x === 'upi' && target.currency === 'INR' ? setUpi(true) : go(x))} loading={busy} accessibilityLabel={t(`pay.method.${x}`)} />)}
          {(m.methods ?? []).includes('upi') && target.currency === 'INR' && ['coach_subscription_period', 'venue_plan'].includes(target.type) ? (auto ? <T size={13} color={c.mute}>{t('pay.upi.autopay_done')}</T> : <Btn title={t('pay.upi.autopay')} color={c.paper} ink={c.ink} onPress={setUpAutoPay} loading={busy} accessibilityLabel={t('pay.upi.autopay')} />) : null}
          {(m.methods ?? []).includes('upi') && ['coach_subscription_period', 'venue_plan'].includes(target.type) && !auto ? <T size={12} color={c.mute}>{t('pay.upi.autopay_note')}</T> : null}
          <T size={12} color={c.mute}>{t('pay.note', { currency: target.currency })}</T>
        </View>
      )}
      {err ? <T color={c.red} weight="700">{err}</T> : null}
      {cover ? <CoverSendSheet target={{ id: target.id, type: target.type ?? 'venue_invoice', label: target.label, amount: target.amount, currency: target.currency }} onClose={() => setCover(false)} onDone={onDone} /> : null}
      {points ? <PointsSheet target={{ id: target.id, type: target.type ?? 'venue_invoice', label: target.label, amount: target.amount, currency: target.currency }} onClose={() => setPoints(false)} onDone={async () => { await onDone?.(); onClose(); }} /> : null}
    </Sheet>
  );
}
