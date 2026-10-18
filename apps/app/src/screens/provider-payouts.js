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

const cash = (cents, cur) => moneyIn(Number(cents ?? 0), cur);
const label = (s) => String(s ?? '').replace(/_/g, ' ');
const BLOCKER = { no_account: 'No bank account yet', account_pending: 'Bank account not verified', payout_in_progress: 'A payout is already on its way', payouts_off: 'Payouts are switched off (SETTLEMENT_PAYOUTS)', currency_unsupported: 'Currency not supported for payouts' };
const KIND = { paid_without_ledger: 'Paid but not in the ledger', amount_mismatch: 'Provider amount did not match', refund_unrecorded: 'Refund made at the provider, not recorded', provider_dispute: 'Customer disputed the payment', payout_failed: 'Payout failed', ledger_drift: 'Ledger does not match the payment', share_mismatch: 'Seller shares do not add up' };
const FAILS = ['invalid_account', 'account_closed', 'bank_rejected', 'name_mismatch', 'other'];

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
  const due = useLoad(() => api.get('/admin/provider-payouts/due', { limit: 50 }), []);
  const accounts = useLoad(() => api.get('/admin/payout-accounts', { status: 'pending', limit: 50 }), []);
  const flight = useLoad(() => api.get('/admin/provider-payouts', { status: 'processing', limit: 50 }), []);
  const ex = useLoad(() => api.get('/admin/settlement/exceptions', { status: 'open', limit: 50 }), []);
  const [acc, setAcc] = useState(null);
  const [result, setResult] = useState(null);
  const [resolve, setResolve] = useState(null);
  const reloadAll = () => { due.reload(); accounts.reload(); flight.reload(); ex.reload(); };
  const act = useAct(reloadAll);
  const start = (r) => act(() => api.post('/admin/provider-payouts', { seller_id: r.seller_id, currency: r.currency, idempotency_key: `ui-${r.seller_id}-${r.currency}-${Date.now()}` }), 'Payout started — send the transfer, then record the result');

  return (
    <>
      <T size={13} color={c.mute}>Pay coaches, physios, doctors and shop sellers what customers paid for. Customer payments land with the platform; a seller is paid only when a payout is recorded as sent.</T>
      <Reconciliation onChanged={reloadAll} />

      <Section title="Bank accounts to verify" color={c.violet}>
        <Block state={accounts} empty="Nothing waiting.">
          {(accounts.data ?? []).map((a) => <Row key={a.id} onPress={() => setAcc(a)} title={`${a.owner} · ${a.currency} …${a.last4}`} sub={`Added ${new Date(a.created_at).toLocaleDateString(locale)}`} right={<Tag label="pending" color={c.sunSoft} />} />)}
        </Block>
      </Section>

      <Section title="Ready to pay" color={c.lime}>
        <Block state={due} empty="Nobody has anything available right now.">
          {(due.data ?? []).map((r) => (
            <Row key={`${r.seller_id}${r.currency}`} title={`${r.seller} · ${cash(r.available_cents, r.currency)}`} sub={r.blocker ? BLOCKER[r.blocker] : `Account …${r.last4} verified`}
              right={r.blocker ? (r.blocker === 'account_pending' ? <Btn small title="Review" color={c.violet} onPress={() => setAcc({ id: r.account_id, owner: r.seller, currency: r.currency, status: 'pending' })} /> : <Tag label="blocked" color={c.orangeSoft} />) : <Btn small title="Start payout" onPress={() => start(r)} />} />
          ))}
        </Block>
      </Section>

      <Section title="On its way" color={c.sun}>
        <Block state={flight} empty="No payouts in progress.">
          {(flight.data ?? []).map((p) => <Row key={p.id} onPress={() => setResult(p)} title={`${p.seller} · ${cash(p.amount_cents, p.currency)}`} sub={`Started ${new Date(p.created_at).toLocaleString(locale)} · tap to record the result`} right={<Tag label="processing" color={c.sunSoft} />} />)}
        </Block>
      </Section>

      <Section title="Exceptions" color={c.orange}>
        <Block state={ex} empty="No open exceptions.">
          {(ex.data ?? []).map((x) => <Row key={x.id} onPress={() => setResolve(x)} title={KIND[x.kind] ?? label(x.kind)} sub={`${x.amount_cents != null ? `${cash(x.amount_cents, x.currency)} · ` : ''}${new Date(x.created_at).toLocaleString(locale)}`} right={<Tag label="open" color={c.orangeSoft} />} />)}
        </Block>
      </Section>

      <AccountSheet account={acc} onClose={() => setAcc(null)} onChanged={reloadAll} />

      <FormSheet visible={!!result} onClose={() => setResult(null)} title={result ? `Payout ${cash(result.amount_cents, result.currency)} to ${result.seller}` : ''} submitLabel="Record result"
        initial={{ outcome: 'paid' }}
        fields={[
          { key: 'outcome', label: 'What happened?', type: 'choice', options: [{ value: 'paid', label: 'Transfer sent' }, { value: 'failed', label: 'Transfer failed' }] },
          { key: 'reference', label: 'Transfer reference (bank UTR / transaction id)', show: (v) => v.outcome === 'paid' },
          { key: 'failure_code', label: 'Why did it fail?', type: 'chips', options: FAILS.map((f) => ({ value: f, label: label(f) })), show: (v) => v.outcome === 'failed' },
          { key: 'reason', label: 'Explanation the seller will see', type: 'multiline', show: (v) => v.outcome === 'failed' },
        ]}
        onSubmit={async (v) => { await api.post(`/admin/provider-payouts/${result.id}/result`, v.outcome === 'paid' ? { outcome: 'paid', reference: v.reference } : { outcome: 'failed', failure_code: v.failure_code, reason: v.reason }); reloadAll(); return 'Recorded'; }} />

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
