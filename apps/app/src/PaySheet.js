import React, { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { useSession } from './session';
import { Btn, Loading, Sheet, T } from './ui';
import { c } from './theme';
import { moneyIn } from './vtime';

/**
 * Hosted checkout for one invoice, in the invoice's own currency: pick Stripe or PayPal, pay on the provider's page, then confirm.
 * target = { id, label, amount, currency }. Card details never touch SportArena.
 */
export function PaySheet({ target, onClose, onDone }) {
  const { toast } = useSession();
  const methods = useLoad(() => api.get('/payments/methods'), []);
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async (provider) => {
    setBusy(true); setErr(null);
    try {
      const p = await api.post('/payments', { purpose_type: 'venue_invoice', purpose_id: target.id, provider, return_url: Platform.OS === 'web' ? `${window.location.origin}${window.location.pathname}` : undefined });
      setPay(p);
      if (Platform.OS === 'web') window.location.assign(p.checkout_url); else await Linking.openURL(p.checkout_url);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/payments/${pay.id}/confirm`);
      if (r.status === 'paid') { toast('Payment received ✓'); await onDone?.(); onClose(); } else setErr('Not paid yet — finish the checkout, then check again.');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const m = methods.data;
  return (
    <Sheet visible onClose={onClose} title="Pay securely">
      <T size={14} color={c.mute}>{target.label} · <T weight="800" size={14}>{moneyIn(target.amount, target.currency)}</T> ({target.currency})</T>
      {methods.loading && !m ? <Loading /> : !m?.providers.length ? (
        <T weight="700" color={c.red}>Online payment isn't switched on yet — please pay at the venue.</T>
      ) : pay ? (
        <View style={{ gap: 10 }}>
          <T size={14}>Checkout opened in {pay.provider === 'stripe' ? 'Stripe' : 'PayPal'}. When you're done, come back and check.</T>
          <Btn title="I've paid — check payment" onPress={check} loading={busy} />
          <Btn title="Reopen checkout" color={c.paper} onPress={() => (Platform.OS === 'web' ? window.location.assign(pay.checkout_url) : Linking.openURL(pay.checkout_url))} />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {m.providers.includes('stripe') ? <Btn title="Pay with card (Stripe)" onPress={() => go('stripe')} loading={busy} /> : null}
          {m.providers.includes('paypal') ? <Btn title="Pay with PayPal" color={c.paper} onPress={() => go('paypal')} loading={busy} /> : null}
          <T size={12} color={c.mute}>You'll be charged in {target.currency}. You'll be taken to the provider's secure page; your card details never reach SportArena.</T>
        </View>
      )}
      {err ? <T color={c.red} weight="700">{err}</T> : null}
    </Sheet>
  );
}
