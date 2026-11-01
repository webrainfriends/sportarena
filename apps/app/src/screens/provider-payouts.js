// Provider payouts: the platform team's desk for paying coaches, physios/doctors and shop sellers — verify bank accounts, start and
// close payouts, work the exception queue and check that customer payments reconcile to what sellers are owed. Lives in the partner
// console next to venue settlements. The server rejects every action for anyone who is not on the platform team.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, ErrorBox, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';
import { PayoutBatches } from './payout-batches';

const cash = (cents, cur) => moneyIn(Number(cents ?? 0), cur);
const label = (s) => String(s ?? '').replace(/_/g, ' ');
const KIND = { paid_without_ledger: 'Paid but not in the ledger', amount_mismatch: 'Provider amount did not match', refund_unrecorded: 'Refund made at the provider, not recorded', provider_dispute: 'Customer disputed the payment', payout_failed: 'Payout failed', ledger_drift: 'Ledger does not match the payment', share_mismatch: 'Seller shares do not add up' };

const Block = ({ state, children, empty }) => (state.loading && !state.data ? <Loading /> : state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : state.data?.length === 0 && empty ? <T size={13} color={c.mute}>{empty}</T> : children);

function useAct(reload) {
  const { toast } = useSession();
  return async (fn, ok) => { try { const r = await fn(); toast(ok ?? 'Done'); reload?.(); return r; } catch (e) { toast(e.message); return null; } };
}

function Reconciliation({ onChanged }) {
  const r = useLoad(() => api.get('/admin/settlement/reconciliation'), []);
  const act = useAct(() => { r.reload(); onChanged?.(); });
  return (
    <Section title="Do the numbers match?" color={c.cyan}>
      <Block state={{ ...r, data: r.data?.currencies }} empty="No provider sales yet.">
        {(r.data?.currencies ?? []).map((x) => (
          <Card key={x.currency} color={x.balanced ? c.limeSoft : c.orangeSoft}>
            <T weight="800">{x.currency} · {x.balanced ? '✓ Customer payments and the ledger agree' : '⚠️ Needs attention'}</T>
            <T size={13}>Customers paid {cash(x.customer_payments_net_cents, x.currency)} (net of refunds) · ledger {cash(x.ledger_net_sales_cents, x.currency)}{x.unrecorded_payments ? ` · ${x.unrecorded_payments} payments (${cash(x.unrecorded_cents, x.currency)}) not in the ledger yet` : ''}</T>
            <T size={13}>Owed to sellers {cash(x.owed_to_sellers_cents, x.currency)} · on its way {cash(x.payouts_in_progress_cents, x.currency)} · paid out {cash(x.paid_out_cents, x.currency)} · held {cash(x.held_cents, x.currency)} · fees kept {cash(x.platform_commission_cents, x.currency)}</T>
            {x.other_funds.map((f) => <T key={f.class} size={12} color={c.mute}>{label(f.class)}: {cash(f.net_cents, x.currency)} across {f.payments} payments — not provider money</T>)}
          </Card>
        ))}
      </Block>
      <Btn small title="Run reconciliation" color={c.violet} onPress={() => act(async () => { const o = await api.post('/admin/settlement/reconcile', {}); return o; }, 'Reconciliation finished')} style={{ alignSelf: 'flex-start' }} />
    </Section>
  );
}

function AccountSheet({ account, onClose, onChanged }) {
  const d = useLoad(() => (account ? api.get(`/admin/payout-accounts/${account.id}/details`) : Promise.resolve(null)), [account?.id]);
  const [form, setForm] = useState(null);
  return (
    <Sheet visible={!!account} onClose={onClose} title={account ? `${account.owner} · ${account.currency}` : 'Account'}>
      {d.loading && !d.data ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : d.data ? (
        <Card pad={12}>
          <T size={13}>Holder: {d.data.holder_name}</T><T size={13}>Account: {d.data.account_number}</T><T size={13}>Bank code: {d.data.bank_code}</T>
          <T size={11} color={c.mute}>Viewing bank details is logged.</T>
        </Card>
      ) : null}
      {account?.status === 'pending' ? <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title="Verify" onPress={() => setForm('verify')} /><Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => setForm('reject')} /></View> : null}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form === 'verify' ? 'Verify account' : 'Reject account'} submitLabel="Save" fields={[{ key: 'reason', label: form === 'verify' ? 'What did you check?' : 'Why is it not accepted? The seller sees this', hint: 'Check that the holder name matches the seller.' }]}
        onSubmit={async (v) => { await api.post(`/admin/payout-accounts/${account.id}/decision`, { decision: form, reason: v.reason }); onChanged(); onClose(); return 'Saved'; }} />
    </Sheet>
  );
}

export function ProviderPayouts() {
  const accounts = useLoad(() => api.get('/admin/payout-accounts', { status: 'pending', limit: 50 }), []);
  const ex = useLoad(() => api.get('/admin/settlement/exceptions', { status: 'open', limit: 50 }), []);
  const [acc, setAcc] = useState(null);
    const [resolve, setResolve] = useState(null);
  const reloadAll = () => { accounts.reload(); ex.reload(); };
  const act = useAct(reloadAll);

  return (
    <>
      <T size={13} color={c.mute}>Pay officials, venues, coaches, physios, doctors and shop sellers from one place. Nobody is paid until a payout is recorded as sent.</T>
      <Reconciliation onChanged={reloadAll} />

      <Section title="Bank accounts to verify" color={c.violet}>
        <Block state={accounts} empty="Nothing waiting.">
          {(accounts.data ?? []).map((a) => <Row key={a.id} onPress={() => setAcc(a)} title={`${a.owner} · ${a.currency} …${a.last4}`} sub={`Added ${new Date(a.created_at).toLocaleDateString(locale)}`} right={<Tag label="pending" color={c.sunSoft} />} />)}
        </Block>
      </Section>

      <PayoutBatches />

      <Section title="Exceptions" color={c.orange}>
        <Block state={ex} empty="No open exceptions.">
          {(ex.data ?? []).map((x) => <Row key={x.id} onPress={() => setResolve(x)} title={KIND[x.kind] ?? label(x.kind)} sub={`${x.amount_cents != null ? `${cash(x.amount_cents, x.currency)} · ` : ''}${new Date(x.created_at).toLocaleString(locale)}`} right={<Tag label="open" color={c.orangeSoft} />} />)}
        </Block>
      </Section>

      <AccountSheet account={acc} onClose={() => setAcc(null)} onChanged={reloadAll} />

      <FormSheet visible={!!resolve} onClose={() => setResolve(null)} title={resolve ? (KIND[resolve.kind] ?? 'Exception') : ''} submitLabel="Close exception"
        initial={{ action: resolve?.kind === 'provider_dispute' ? 'release' : 'note' }}
        fields={[
          ...(resolve?.kind === 'provider_dispute' ? [{ key: 'action', label: 'Outcome of the dispute', type: 'choice', options: [{ value: 'release', label: 'Won — release the hold' }, { value: 'reverse', label: 'Lost — take it back from sellers' }] }] : []),
          { key: 'reason', label: 'What was done?', type: 'multiline', hint: 'Fix the cause first (for example run reconciliation); the ledger itself is never edited.' },
        ]}
        onSubmit={async (v) => { await api.post(`/admin/settlement/exceptions/${resolve.id}/resolution`, { action: resolve.kind === 'provider_dispute' ? v.action : 'note', reason: v.reason }); reloadAll(); return 'Closed'; }} />
    </>
  );
}
