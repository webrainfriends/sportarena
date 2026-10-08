import React, { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { PaySheet } from '../PaySheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
const toMinor = (text, cur) => Math.round(Number(String(text).replace(/,/g, '')) * 10 ** digits(cur));
const KIND = { topup: '➕ Top-up', gift_card: '🎁 Gift card', spend: '🏟️ Booking', refund: '↩️ Refund', adjustment: '🛠️ Adjustment' };

/** Choose a currency and an amount (typed in whole currency units). Used by top-up and gift card purchase. */
function AmountSheet({ title, cta, visible, onClose, currencies, onSubmit, withMessage }) {
  const [cur, setCur] = useState('INR');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { const minor = toMinor(amount, cur); if (!(minor > 0)) throw new Error('Enter an amount'); await onSubmit({ currency: cur, amount_cents: minor, ...(withMessage && message ? { message } : {}) }); setAmount(''); setMessage(''); onClose(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <T weight="700">Currency</T>
      <Seg options={(currencies ?? [{ code: 'INR', symbol: '₹' }]).map((x) => ({ value: x.code, label: `${x.code} ${x.symbol}` }))} value={cur} onChange={setCur} color={c.violet} />
      <Field label={`Amount (${cur})`} value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder={digits(cur) ? '500.00' : '5000'} />
      {withMessage ? <Field label="Message (optional)" value={message} onChangeText={setMessage} placeholder="Happy birthday!" /> : null}
      {err ? <T color={c.red} weight="700">{err}</T> : null}
      <Btn title={cta} onPress={go} loading={busy} />
    </Sheet>
  );
}

export function Wallet() {
  const { toast } = useSession();
  const w = useLoad(() => api.get('/me/wallet'), []);
  const cards = useLoad(() => api.get('/me/gift-cards'), []);
  const cur = useLoad(() => api.get('/currencies'), []);
  const [topup, setTopup] = useState(false);
  const [buy, setBuy] = useState(false);
  const [redeem, setRedeem] = useState(false);
  const [code, setCode] = useState('');
  const [pay, setPay] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const reload = () => { w.reload(); cards.reload(); };

  const showCard = async (g) => { try { setOpen(await api.get(`/gift-cards/${g.id}`)); } catch (e) { toast(e.message); } };
  const share = (g) => {
    const text = `🎁 A ${moneyIn(g.amount_cents, g.currency)} SportArena gift card for you${g.message ? `: "${g.message}"` : ''}. Redeem code ${g.code} in the app (Wallet → Redeem).`;
    if (Platform.OS === 'web' && navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Message copied — paste it to your friend'));
    else Share.share({ message: text }).catch(() => {});
  };

  if (w.loading && !w.data) return <Screen><Loading /></Screen>;
  if (w.error) return <Screen><ErrorBox error={w.error} onRetry={w.reload} /></Screen>;
  const d = w.data;
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Wallet</H1>
      <T color={c.mute} weight="600">Pay for bookings in a tap. Money, gift cards and refunds all land here, per currency.</T>
      <View style={{ gap: 10, marginTop: 14 }}>
        {d.balances.length ? d.balances.map((b) => (
          <Card key={b.currency} color={c.limeSoft}><T size={12} weight="700" color={c.mute}>{b.currency} BALANCE</T><T size={32} weight="800">{moneyIn(Number(b.balance_cents), b.currency)}</T></Card>
        )) : <Card><T weight="700">Your wallet is empty</T><T size={13} color={c.mute}>Add money or redeem a gift card to get started.</T></Card>}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {d.online_payment ? <Btn small title="＋ Add money" onPress={() => setTopup(true)} /> : null}
        <Btn small title="🎁 Redeem a gift card" color={c.violet} onPress={() => setRedeem(true)} />
        {d.online_payment ? <Btn small title="Buy a gift card" color={c.paper} onPress={() => setBuy(true)} /> : null}
      </View>
      {!d.online_payment ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Adding money and buying gift cards needs online payment, which isn't switched on for this server yet.</T> : null}

      <Section title="Gift cards you bought" color={c.pink}>
        {cards.data?.length ? cards.data.map((g) => (
          <Row key={g.id} onPress={() => (g.status === 'awaiting_payment' ? setPay({ id: g.id, type: 'gift_card', label: 'Gift card', amount: g.amount_cents, currency: g.currency }) : showCard(g))}
            title={`${moneyIn(g.amount_cents, g.currency)} gift card${g.code_hint ? ` · …${g.code_hint}` : ''}`} sub={g.status === 'awaiting_payment' ? 'Tap to pay' : g.status === 'redeemed' ? `Redeemed ${new Date(g.redeemed_at).toLocaleDateString()}` : g.expires_at ? `Valid until ${new Date(g.expires_at).toLocaleDateString()}` : ''}
            right={<Tag label={g.status.replace('_', ' ')} color={g.status === 'active' ? c.mint : g.status === 'awaiting_payment' ? c.sun : c.violetSoft} />} />
        )) : <T size={13} color={c.mute}>None yet.</T>}
      </Section>

      <Section title="Activity" color={c.cyan}>
        {d.recent.length ? d.recent.map((l) => (
          <Row key={l.id} title={`${KIND[l.kind] ?? l.kind}${l.note ? ` · ${l.note}` : ''}`} sub={new Date(l.created_at).toLocaleString()}
            right={<View style={{ alignItems: 'flex-end' }}><T weight="700" color={l.amount_cents > 0 ? c.lime : c.ink}>{l.amount_cents > 0 ? '+' : '−'}{moneyIn(Math.abs(Number(l.amount_cents)), l.currency)}</T><T size={11} color={c.mute}>bal {moneyIn(Number(l.balance_after), l.currency)}</T></View>} />
        )) : <Empty emoji="👛" title="No activity yet" />}
      </Section>

      <AmountSheet title="Add money" cta="Continue to payment" visible={topup} onClose={() => setTopup(false)} currencies={cur.data}
        onSubmit={async (b) => { const t = await api.post('/me/wallet/topups', b); setPay({ id: t.id, type: 'wallet_topup', label: 'Wallet top-up', amount: Number(t.amount_cents), currency: t.currency }); }} />
      <AmountSheet title="Buy a gift card" cta="Continue to payment" visible={buy} onClose={() => setBuy(false)} currencies={cur.data} withMessage
        onSubmit={async (b) => { const g = await api.post('/gift-cards', b); setPay({ id: g.id, type: 'gift_card', label: 'Gift card', amount: Number(g.amount_cents), currency: g.currency }); }} />
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={reload} /> : null}

      <Sheet visible={redeem} onClose={() => setRedeem(false)} title="Redeem a gift card">
        <Field label="Gift card code" value={code} onChangeText={setCode} placeholder="ABCD-EFGH-JKMN" />
        <Btn title="Add to my wallet" loading={busy} onPress={async () => {
          setBusy(true);
          try { const r = await api.post('/gift-cards/redeem', { code }); toast(`${moneyIn(r.amount_cents, r.currency)} added to your wallet 🎉`); setCode(''); setRedeem(false); reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
        }} />
      </Sheet>
      <Sheet visible={!!open} onClose={() => setOpen(null)} title="Gift card">
        {open ? (
          <View style={{ gap: 10 }}>
            <T size={30} weight="800">{moneyIn(open.amount_cents, open.currency)}</T>
            {open.message ? <T color={c.mute}>"{open.message}"</T> : null}
            {open.code ? <Card color={c.sunSoft}><T size={11} weight="700" color={c.mute}>CODE</T><T size={26} weight="800" style={{ letterSpacing: 2 }}>{open.code}</T></Card> : null}
            <T size={12} color={c.mute}>{open.status === 'redeemed' ? 'This card has been redeemed.' : open.expires_at ? `Valid until ${new Date(open.expires_at).toLocaleDateString()}. Works once, in ${open.currency}.` : ''}</T>
            {open.status === 'active' ? <Btn title="Share" onPress={() => share(open)} /> : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** "Use my wallet" for an open invoice. */
export function WalletApplySheet({ invoice, onClose, onDone }) {
  const { toast } = useSession();
  const w = useLoad(() => api.get('/me/wallet'), []);
  const [busy, setBusy] = useState(false);
  const have = Number(w.data?.balances.find((b) => b.currency === invoice.currency)?.balance_cents ?? 0);
  const due = invoice.total_cents - (invoice.credits_cents ?? 0);
  const use = Math.min(have, due);
  return (
    <Sheet visible onClose={onClose} title="Pay from wallet">
      {w.loading ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <T>Wallet balance: <T weight="700">{moneyIn(have, invoice.currency)}</T></T>
          <T>Amount due: <T weight="700">{moneyIn(due, invoice.currency)}</T></T>
          {use > 0 ? <T color={c.mute} size={13}>{use >= due ? 'Your wallet covers all of it.' : `Your wallet covers ${moneyIn(use, invoice.currency)}; ${moneyIn(due - use, invoice.currency)} stays to pay online or at the venue.`}</T> : <T color={c.red} weight="700">Your {invoice.currency} wallet is empty.</T>}
          <Btn title={use > 0 ? `Use ${moneyIn(use, invoice.currency)}` : 'Nothing to use'} disabled={use <= 0} loading={busy} onPress={async () => {
            setBusy(true);
            try { const r = await api.post(`/invoices/${invoice.id}/wallet`, {}); toast(r.paid ? 'Paid from your wallet ✓' : `${moneyIn(r.applied_cents, invoice.currency)} applied`); await onDone?.(); onClose(); } catch (e) { toast(e.message); } finally { setBusy(false); }
          }} />
        </View>
      )}
    </Sheet>
  );
}
