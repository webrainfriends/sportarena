import React, { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { SponsorPerformance } from './sponsor-performance';
import { YouthPanel } from './sponsor-youth';
import { SponsorNegotiation } from './sponsor-negotiation';
import { SponsorContract } from './sponsor-contract';
import { SponsorAmendments } from './sponsor-amendments';
import { GoodsReturns, ServiceVouchers, remainingGoods } from './sponsor-fulfilment';
import { saveText } from '../evidence';
import { SponsorTermination } from './sponsor-termination';
import { SponsorDisputes } from './sponsor-disputes';
import { SponsorPause } from './sponsor-pause';
import { SponsorRenewal, STATUS_LABEL } from './sponsor-renewal';
import { SponsorTasks } from './sponsor-collaboration';
import { SponsorAllocations, PayeeLine } from './sponsor-beneficiaries';
import { c } from '../theme';
import { explain, LoadError } from '../access';

const ROLE_LABEL = { manager: 'Manager', evaluator: 'Evaluator', finance: 'Finance', legal: 'Legal', approver: 'Approver', auditor: 'Auditor' };

// Amounts are minor units of THEIR OWN currency; currencies are never added together and estimates are labelled.
const fmt = (cents, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(cents / 10 ** (new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits)); } catch { return `${cents} ${cur ?? ''}`; } };
const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
const when = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const what = (o) => (o.kind === 'money' ? fmt(o.amount_cents, o.currency) : o.kind === 'goods' ? `${o.quantity} to deliver` : o.kind === 'service' ? `${o.quantity} funded` : 'Endorsement');
const statusOf = (o) => (o.status === 'scheduled' && o.held ? 'held' : o.status === 'scheduled' && o.overdue ? 'overdue' : o.status);
const left = (x) => Math.max(0, x.amount_cents - x.confirmed_cents - x.reported_unverified_cents - x.checkout_in_progress_cents);
const payState = (p) => ({ reported: 'unverified', confirmed: p.method === 'online' ? 'verified by provider ✓' : 'confirmed', awaiting_payment: 'checkout open', reversed: p.method === 'online' ? 'refunded' : 'reversed' }[p.status] ?? p.status);
const tone = { held: c.violetSoft, fulfilled: c.lime, overdue: c.pinkSoft, cancelled: c.paper, scheduled: c.sunSoft };

/** Endorsement rights in words: where, placement, approval, asset use and exclusivity. */
function Rights({ terms: t }) {
  if (!t || !Object.keys(t).length) return null;
  return (
    <View style={{ marginTop: 4, gap: 2 }}>
      {t.channels?.length ? <T size={12} color={c.mute}>Where: {t.channels.join(', ')}</T> : null}
      {t.placement ? <T size={12} color={c.mute}>Placement: {t.placement}</T> : null}
      {t.approval_criteria ? <T size={12} color={c.mute}>Counts as approved when: {t.approval_criteria}</T> : null}
      {t.asset_usage ? <T size={12} color={c.mute}>Logo and content use: {t.asset_usage}</T> : null}
      {t.exclusivity ? <T size={12} color={c.mute}>Exclusivity: {t.exclusivity}</T> : null}
    </View>
  );
}

export function SponsorDeal({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const deal = useLoad(() => api.get(`/sponsorships/${id}`), [id]);
  const [form, setForm] = useState(null); // { kind, o }
  const d = deal.data;
  const exportFulfilment = async () => { try { const r = await api.get(`/sponsorships/${id}/fulfilment/export`); await saveText(r.filename, r.csv); toast(`${r.rows} row${r.rows === 1 ? '' : 's'} exported`); } catch (e) { toast(explain(e)); } };
  const act = async (fn, m) => { try { await fn(); toast(m); deal.reload(); } catch (e) { toast(explain(e)); if (e.status === 409) deal.reload(); } };
  if (deal.loading && !d) return <Screen><Loading /></Screen>;
  if (deal.error) return <Screen><LoadError error={deal.error} onRetry={deal.reload} /></Screen>;
  const sponsor = d.role === 'sponsor', recipient = d.role === 'recipient' && !d.youth?.minor_self; // a young person reads their agreement; their guardian acts (#307)
  // what this person's sponsor role may do (the server enforces it; this only hides what would be refused)
  const can = (a) => !sponsor || !d.can || d.can.includes(a);
  const o = form?.o;
  return (
    <Screen>
      <H1>{d.sponsor.name}</H1>
      <YouthPanel deal={d} reload={deal.reload} />
      {sponsor && d.my_sponsor_role ? <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 4 }}><Tag label={`You: ${ROLE_LABEL[d.my_sponsor_role]}`} />{!can('pay') || !can('revise') ? <T size={12} color={c.mute} accessibilityRole="text">{[!can('pay') ? 'cannot report payments' : null, !can('revise') ? 'cannot change or sign terms' : null].filter(Boolean).join(' · ')}</T> : null}</View> : null}
      {sponsor && d.budget ? <Btn small title={`Funded from ${d.budget.code} · ${d.budget.name}`} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => push('SponsorBudget', { id: d.budget.id })} accessibilityLabel={`Funded from budget ${d.budget.code}, ${d.budget.name}. Open the budget and its trace`} /> : sponsor && d.status !== 'withdrawn' && d.status !== 'declined' ? <T size={12} color={c.mute}>Not on any budget.</T> : null}
      {d.program ? <T size={12} color={c.mute} accessibilityRole="text">Awarded from the program “{d.program.name}”, {d.program.round_name}.</T> : null}
      <T size={12} color={c.mute}>{d.agreement_ref ?? 'Legacy agreement'} · {STATUS_LABEL[d.status] ?? d.status} · terms v{d.accepted_version ?? d.terms_version}{d.starts_on ? ` · ${when(String(d.starts_on).slice(0, 10))} – ${d.ends_on ? when(String(d.ends_on).slice(0, 10)) : 'open'}` : ''}</T>
      {!d.lines.length ? <Card><T>This agreement predates structured terms: {d.legacy_amount_cents ? `${d.legacy_amount_cents} (currency not recorded)` : 'no cash'}{d.legacy_in_kind ? ` · ${d.legacy_in_kind}` : ''}. No payment schedule exists for it.</T></Card> : null}
      <SponsorAmendments deal={{ ...d, reload: deal.reload }} can={can} act={act} />
      <SponsorTermination deal={{ ...d, reload: deal.reload, toast }} />
      <SponsorDisputes deal={{ ...d, reload: deal.reload }} />
      <SponsorNegotiation deal={{ ...d, reload: deal.reload }} can={can} act={act} />
      <SponsorPause deal={{ ...d, reload: deal.reload }} can={can} act={act} />
      <SponsorRenewal deal={{ ...d, reload: deal.reload }} act={act} />
      {['sponsor', 'recipient', 'admin'].includes(d.role) && d.status !== 'withdrawn' && d.status !== 'declined' ? <SponsorTasks target={{ sponsorship_id: d.id }} ends_on={d.ends_on} /> : null}
      <Section title="Terms" color={c.sun}>
        {d.objectives ? <T size={13}><T size={13} weight="800">Objectives: </T>{d.objectives}</T> : null}
        {d.deliverables ? <T size={13}><T size={13} weight="800">{sponsor ? 'Expected in return' : 'What the sponsor expects'}: </T>{d.deliverables}</T> : null}
        {d.lines.map((l) => (
          <Card key={l.id}><T weight="900">{l.label}</T>
            <T size={12} color={c.mute}>{l.kind}{l.kind === 'money' ? ` · ${l.total_cents ? `${fmt(l.total_cents, l.currency)} total` : `${fmt(l.amount_cents, l.currency)} each`}` : ''}{l.kind === 'goods' || l.kind === 'service' ? ` · ${l.quantity} ${l.unit ?? ''}` : ''}{l.kind === 'service' ? ` · ${l.service_type}` : ''}{l.kind === 'endorsement' ? ` · promoted by the ${l.promoter}` : ''} · {l.cadence}{l.instalments > 1 ? ` × ${l.instalments}` : ''}</T>
            {l.kind === 'endorsement' ? <Rights terms={l.terms} /> : null}
            {l.estimate_cents != null ? <T size={12} color={c.mute}>Estimated value {fmt(l.estimate_cents, l.currency)} — an estimate, not cash</T> : null}
          </Card>))}
        {d.schedule ? <T size={12} color={c.mute}>Committed cash: {Object.entries(d.schedule.committed).map(([cur, v]) => fmt(v, cur)).join(' · ') || 'none'}. Currencies are never combined.</T> : null}
      </Section>
      {d.beneficiary ? <SponsorAllocations deal={d} /> : null}
      <SponsorContract deal={d} can={can} onChanged={deal.reload} />
      {d.schedule ? (
        <Section title="Schedule to review" color={c.cyan}>
          {d.schedule.occurrences.map((x) => <T key={`${x.line}-${x.seq}`} size={13}>{when(x.due_on)} · {x.label} · {what(x)}</T>)}
          {recipient && d.status === 'proposed' ? <Card color={c.sunSoft}><T size={13} accessibilityRole="text">Accepting makes these dues, but no money is assumed paid: a payment only counts as received after <T size={13} weight="800">you</T> confirm it.</T></Card> : null}
          {d.negotiation?.my_turn && (recipient || can('sign_off')) ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn title={`${recipient ? 'Accept' : 'Sign off'} these exact terms (v${d.terms_version})`} color={c.mint} ink={c.ink}
                onPress={() => (recipient && d.target_type === 'athlete' ? setForm({ kind: 'accept' }) : act(() => api.patch(`/sponsorships/${d.id}`, { status: 'active', version: d.terms_version }), 'Agreement accepted'))} />
              {recipient && d.status === 'proposed' ? <Btn title="Decline" color={c.paper} ink={c.red} onPress={() => setForm({ kind: 'decline' })} /> : null}
            </View>) : null}
        </Section>) : null}
      {d.obligations ? (
        <Section title="Commitments" color={c.mint}>
          {d.obligations.length ? d.obligations.map((x) => (
            <Card key={x.id} color={tone[statusOf(x)] ?? c.paper}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="900" style={{ flex: 1 }}>{when(x.due_on)} · {x.label}</T><Tag label={x.cancelled_by_amendment ? 'replaced by amendment' : statusOf(x)} color={tone[statusOf(x)] ?? c.paper} /></View>
              <T size={12} color={c.mute}>{what(x)}{x.kind === 'money' ? ` · confirmed ${fmt(x.confirmed_cents, x.currency)}${x.reported_unverified_cents ? ` · reported, not yet confirmed ${fmt(x.reported_unverified_cents, x.currency)}` : ''}` : ''}{x.kind === 'goods' ? ` · received ${x.received_quantity}${x.returned_quantity ? ` · returned ${x.returned_quantity}` : ''}${x.credited_quantity ? ` · credited ${x.credited_quantity}` : ''}${x.in_transit_quantity ? ` · in transit ${x.in_transit_quantity}` : ''} · net accepted ${x.received_quantity - x.returned_quantity} of ${x.quantity}` : ''}</T>
              {x.payments.filter((p) => p.status !== 'failed').map((p) => (
                <View key={p.id} style={{ marginTop: 4 }}>
                  <T size={12}>{fmt(p.amount_cents, p.currency)} · {p.method === 'online' ? 'online' : p.method.replace('_', ' ')}{p.method === 'online' ? '' : ` · ref ${p.reference}`} · {payState(p)}{p.refunded_cents > 0 ? ` · refunded ${fmt(p.refunded_cents, p.currency)}` : ''}</T>
                  {p.status === 'confirmed' ? <PayeeLine p={p} /> : null}
                  {recipient && p.status === 'reported' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}><Btn small title="Confirm received" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorship-payments/${p.id}`, { status: 'confirmed' }), 'Payment confirmed')} /><Btn small title="Not received" color={c.paper} ink={c.red} onPress={() => setForm({ kind: 'reject', o: p })} /></View> : null}
                  {recipient && p.status === 'confirmed' && p.method !== 'online' ? <Btn small title="Reverse" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => setForm({ kind: 'reverse', o: p })} /> : null}
                  {sponsor && can('pay') && p.status === 'awaiting_payment' ? <Btn small title="Cancel this checkout" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => act(() => api.post(`/sponsorship-payments/${p.id}/cancel-checkout`), 'Checkout cancelled')} /> : null}
                </View>))}
              {x.deliveries.map((dl) => (
                <View key={dl.id} style={{ marginTop: 4 }}>
                  <T size={12}>{dl.replaces_return_id ? 'Replacement · ' : ''}{dl.quantity} dispatched{dl.reference ? ` · ${dl.reference}` : ''} · {dl.status === 'dispatched' ? 'dispatched — not yet received' : dl.status}{dl.status === 'received' ? ` (${dl.received_quantity})` : ''}{dl.rejection_reason ? ` · ${dl.rejection_reason.replace(/_/g, ' ')}` : ''}</T>
                  {dl.dispatch_evidence_url ? <T size={12} color={c.mute} accessibilityRole="link">Proof of dispatch: {dl.dispatch_evidence_url}</T> : null}
                  {dl.receipt_evidence_url ? <T size={12} color={c.mute} accessibilityRole="link">Proof of receipt: {dl.receipt_evidence_url}</T> : null}
                  {recipient && dl.status === 'dispatched' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}><Btn small title="Confirm receipt" color={c.mint} ink={c.ink} onPress={() => setForm({ kind: 'receive', o: dl })} /><Btn small title="Reject / damaged" color={c.paper} ink={c.red} onPress={() => setForm({ kind: 'rejectGoods', o: dl })} /></View> : null}
                </View>))}
              {x.kind === 'goods' && !x.deliveries.length ? <T size={12} color={c.mute}>{sponsor ? 'Nothing dispatched yet.' : 'No shipments yet. The sponsor records a dispatch; you confirm receipt here.'}</T> : null}
              {x.kind === 'goods' && (x.returns.length || recipient) ? <GoodsReturns o={x} sponsor={sponsor} recipient={recipient} can={can} act={act} reload={deal.reload} onReplace={(r) => setForm({ kind: 'dispatch', o: x, replaces: r })} /> : null}
              {x.kind === 'service' ? <ServiceVouchers o={x} service={d.lines.find((l) => l.id === x.line_id)?.service_type} sponsor={sponsor} recipient={recipient} can={can} act={act} reload={deal.reload} /> : null}
              {x.submissions.map((s) => (
                <View key={s.id} style={{ marginTop: 4 }}>
                  <T size={12}>Evidence {s.evidence_url} · {s.status.replace('_', ' ')}{s.review_note ? ` — ${s.review_note}` : ''}</T>
                  {s.status === 'submitted' && d.role === (x.promoter === 'recipient' ? 'sponsor' : 'recipient') && can('evaluate') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}><Btn small title="Accept" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorship-submissions/${s.id}`, { status: 'accepted' }), 'Accepted')} /><Btn small title="Ask for changes" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'revise', o: s })} /></View> : null}
                </View>))}
              {x.held ? <T size={12} weight="700" accessibilityRole="text">On hold while the agreement is paused. It can be paid once the agreement resumes.</T> : null}
              {x.original_due_on ? <T size={12} color={c.mute}>Moved from {when(x.original_due_on)} by a pause</T> : null}
              {x.kind === 'money' && x.status === 'scheduled' ? <T size={12} weight="700">Still due {fmt(left(x), x.currency)}</T> : null}
              {x.status === 'scheduled' && !x.held && x.kind === 'money' && sponsor && can('pay') ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  {left(x) > 0 ? <Btn small title="Pay online" color={c.pink} onPress={() => setForm({ kind: 'checkout', o: x })} /> : null}
                  {left(x) > 0 ? <Btn small title="Report a bank payment" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'pay', o: x })} /> : null}
                </View>) : null}
              {x.status === 'scheduled' && x.kind === 'money' && sponsor && !can('pay') ? <T size={12} color={c.mute}>Your role cannot make payments. Ask a Finance or Manager colleague.</T> : null}
              {x.status === 'scheduled' && !x.held && x.kind === 'goods' && sponsor && can('pay') && remainingGoods(x) > 0 ? <Btn small title="Record dispatch" color={c.orange} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setForm({ kind: 'dispatch', o: x })} /> : null}
              {x.status === 'scheduled' && !x.held && x.kind === 'endorsement' && d.role === x.promoter && can('evaluate') && !x.submissions.some((s) => s.status !== 'revision_requested') ? <Btn small title="Submit evidence" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setForm({ kind: 'submit', o: x })} /> : null}
            </Card>)) : <Empty emoji="🗓️" title="Nothing scheduled" />}
          {d.obligations.some((x) => x.deliveries.length || x.returns.length || x.vouchers.length) && (recipient || can('export')) ? <Btn small title="Export deliveries, returns and vouchers (CSV)" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={exportFulfilment} accessibilityLabel="Export deliveries, returns and vouchers as a CSV file" /> : null}
          <T size={12} color={c.mute}>Online payments are collected by Gotmygame through Stripe or PayPal, counted only once the provider verifies them, and paid out to the recipient after the hold period (see Earnings). Bank or cash payments you report stay unverified until the recipient confirms them.</T>
        </Section>) : null}
      {d.obligations?.some((x) => x.kind === 'money') ? <Reconciliation id={d.id} /> : null}
      {['proposed', 'active', 'paused', 'ended', 'term_expired', 'completed'].includes(d.status) && (sponsor || recipient) ? <SponsorPerformance deal={d} /> : null}
      <Section title="History" color={c.lime}>
        {d.history.map((h) => <T key={h.id} size={12} color={c.mute}>{new Date(h.created_at).toLocaleDateString()} · {h.action.replace(/_/g, ' ')}{h.version ? ` (v${h.version})` : ''} · {h.actor ?? 'system'}{h.reason ? ` — ${h.reason}` : ''}</T>)}
      </Section>

      {form?.kind === 'checkout' ? <CheckoutSheet o={o} onClose={() => setForm(null)} onChanged={deal.reload} /> : null}
      <FormSheet visible={form?.kind === 'accept'} onClose={() => setForm(null)} title="Accept this offer" submitLabel="Accept"
        fields={[{ key: 'show_publicly', label: 'Show this sponsor on my public profile', type: 'switch', default: false, hint: 'Off by default. Objectives, deliverables and messages are never public.' }]}
        onSubmit={async (v) => { try { await api.patch(`/sponsorships/${d.id}`, { status: 'active', version: d.terms_version, show_publicly: v.show_publicly }); } catch (e) { if (e.status === 409) deal.reload(); throw e; } deal.reload(); return 'Agreement accepted'; }} />
      <FormSheet visible={form?.kind === 'decline'} onClose={() => setForm(null)} title="Decline this offer" submitLabel="Decline"
        fields={[{ key: 'reason', label: 'Reason (the sponsor will see it)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { try { await api.patch(`/sponsorships/${d.id}`, { status: 'declined', reason: v.reason }); } catch (e) { if (e.status === 409) deal.reload(); throw e; } deal.reload(); return 'Offer declined'; }} />
      <FormSheet visible={form?.kind === 'pay'} onClose={() => setForm(null)} title="Report a bank payment" submitLabel="Report"
        fields={[{ key: 'amount_cents', label: 'Amount paid', type: 'money', currency: o?.currency ?? 'USD' }, { key: 'method', label: 'How', type: 'choice', options: [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cash', label: 'Cash' }, { value: 'other', label: 'Other' }] }, { key: 'reference', label: 'Bank / receipt reference' }, { key: 'paid_on', label: 'Paid on', type: 'date' }, { key: 'evidence_url', label: 'Link to proof (https)', optional: true, type: 'url' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-obligations/${o.id}/payments`, { ...v, currency: o.currency }); deal.reload(); return 'Reported — the recipient will confirm it'; }} />
      <FormSheet visible={form?.kind === 'dispatch'} onClose={() => setForm(null)} title={form?.replaces ? 'Dispatch replacement' : 'Record dispatch'} submitLabel="Record"
        fields={[{ key: 'quantity', label: 'Quantity sent', type: 'stepper', min: 1, max: Math.max(1, Math.min(form?.replaces?.quantity ?? Infinity, o ? remainingGoods(o) : 1)), default: Math.max(1, Math.min(form?.replaces?.quantity ?? Infinity, o ? remainingGoods(o) : 1)) }, { key: 'reference', label: 'Tracking reference', optional: true }, { key: 'evidence_url', label: 'Proof of dispatch (https link)', type: 'url', optional: true }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-obligations/${o.id}/deliveries`, { ...v, ...(form.replaces ? { replaces_return_id: form.replaces.id } : {}) }); deal.reload(); return 'Dispatch recorded — it counts only once the recipient confirms receipt'; }} />
      <FormSheet visible={form?.kind === 'receive'} onClose={() => setForm(null)} title="Confirm receipt" submitLabel="Confirm"
        fields={[{ key: 'received_quantity', label: 'Quantity actually received', type: 'stepper', min: 1, max: o?.quantity ?? 1, default: o?.quantity ?? 1 }, { key: 'evidence_url', label: 'Photo or receipt (https link)', type: 'url', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-deliveries/${o.id}`, { status: 'received', ...v, expected_version: o.version }); deal.reload(); return 'Receipt confirmed'; }} />
      <FormSheet visible={form?.kind === 'rejectGoods'} onClose={() => setForm(null)} title="Reject delivery" submitLabel="Reject"
        fields={[{ key: 'reason', label: 'What is wrong', type: 'chips', options: [{ value: 'damaged', label: 'Damaged' }, { value: 'wrong_item', label: 'Wrong item' }, { value: 'not_as_described', label: 'Not as described' }, { value: 'other', label: 'Other' }] }, { key: 'evidence_url', label: 'Photo (https link)', type: 'url', optional: true }, { key: 'note', label: 'Details', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-deliveries/${o.id}`, { status: 'rejected', ...v, expected_version: o.version }); deal.reload(); return 'Delivery rejected'; }} />
      <FormSheet visible={form?.kind === 'reject' || form?.kind === 'reverse'} onClose={() => setForm(null)} title={form?.kind === 'reverse' ? 'Reverse confirmed payment' : 'Payment not received'} submitLabel="Save" fields={[{ key: 'note', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-payments/${o.id}`, { status: form.kind === 'reverse' ? 'reversed' : 'rejected', note: v.note }); deal.reload(); return 'Saved'; }} />
      <FormSheet visible={form?.kind === 'submit'} onClose={() => setForm(null)} title="Submit evidence" submitLabel="Submit"
        fields={[{ key: 'evidence_url', label: 'Link to the post / photo (https)', type: 'url' }, { key: 'note', label: 'Note', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-obligations/${o.id}/submissions`, v); deal.reload(); return 'Submitted for review'; }} />
      <FormSheet visible={form?.kind === 'revise'} onClose={() => setForm(null)} title="Ask for changes" submitLabel="Send" fields={[{ key: 'note', label: 'What needs to change', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-submissions/${o.id}`, { status: 'revision_requested', note: v.note }); deal.reload(); return 'Sent back'; }} />
    </Screen>
  );
}

/** Pay a due online (Stripe / PayPal), in full or in part. The amount is checked again on the server; nothing counts until the provider verifies it. */
function CheckoutSheet({ o, onClose, onChanged }) {
  const { toast } = useSession();
  const methods = useLoad(() => api.get('/payments/methods'), []);
  const due = left(o);
  const [pick, setPick] = useState('full');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const half = Math.floor(due / 2);
  const cents = pick === 'full' ? due : pick === 'half' ? half : Math.round(Number(String(other).replace(/,/g, '')) * 10 ** digits(o.currency));
  const bad = !(cents > 0) || cents > due;
  const go = async (provider) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/sponsorship-obligations/${o.id}/checkout`, { provider, amount_cents: cents, return_url: Platform.OS === 'web' ? `${window.location.origin}${window.location.pathname}` : undefined });
      onChanged();
      if (Platform.OS === 'web') window.location.assign(r.checkout_url); else { await Linking.openURL(r.checkout_url); onClose(); toast('Finish the checkout, then come back — the payment shows here once verified'); }
    } catch (e) { setErr(e.status === 409 ? e.message : explain(e)); if (e.status === 409) onChanged(); } finally { setBusy(false); }
  };
  const m = methods.data;
  return (
    <Sheet visible onClose={onClose} title="Pay online">
      <T size={14} color={c.mute}>{o.label} · still due <T weight="800" size={14}>{fmt(due, o.currency)}</T> ({o.currency})</T>
      {methods.loading && !m ? <Loading /> : methods.error ? <LoadError error={methods.error} onRetry={methods.reload} /> : !m?.providers.length ? (
        <T weight="700" color={c.red}>Online payment is not switched on yet. Report a bank payment instead.</T>
      ) : (
        <View style={{ gap: 12 }}>
          <T size={13} weight="700">Amount (pay in full or in part)</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Chip label={`Full ${fmt(due, o.currency)}`} active={pick === 'full'} onPress={() => setPick('full')} />
            {half > 0 ? <Chip label={`Half ${fmt(half, o.currency)}`} active={pick === 'half'} onPress={() => setPick('half')} /> : null}
            <Chip label="Other amount" active={pick === 'other'} onPress={() => setPick('other')} />
          </View>
          {pick === 'other' ? <Field label={`Amount in ${o.currency}`} value={other} onChangeText={(x) => setOther(x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" hint={cents > due ? `At most ${fmt(due, o.currency)}` : undefined} /> : null}
          {m.providers.includes('stripe') ? <Btn title={`Pay ${bad ? '' : fmt(cents, o.currency)} with card (Stripe)`} onPress={() => go('stripe')} loading={busy} disabled={bad} /> : null}
          {m.providers.includes('paypal') ? <Btn title="Pay with PayPal" color={c.paper} ink={c.ink} onPress={() => go('paypal')} loading={busy} disabled={bad} /> : null}
          <T size={12} color={c.mute}>You are charged in {o.currency} on the provider's secure page; card details never reach Gotmygame. The payment counts only after the provider confirms it.</T>
        </View>)}
      {err ? <T color={c.red} weight="700" accessibilityRole="alert">{err}</T> : null}
    </Sheet>
  );
}

/** Per-currency reconciliation of the agreement's money: what was committed, collected, refunded and is still due, against the earnings ledger. */
function Reconciliation({ id }) {
  const rec = useLoad(() => api.get('/sponsorship-reconciliation', { sponsorship_id: id }), [id]);
  if (rec.loading && !rec.data) return <Loading />;
  if (rec.error) return <LoadError error={rec.error} onRetry={rec.reload} />;
  if (!rec.data?.length) return null;
  return (
    <Section title="Reconciliation" color={c.pink}>
      {rec.data.map((r) => (
        <Card key={r.currency}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="900">{r.currency}</T><Tag label={r.reconciles ? 'Reconciles ✓' : 'Needs review'} color={r.reconciles ? c.limeSoft : c.sunSoft} /></View>
          {[['Committed', r.committed_cents], ['Collected online', r.collected_online_cents], ['Refunded', r.refunded_cents ? -r.refunded_cents : 0], ['Confirmed bank / cash', r.confirmed_manual_cents], ['Reported, not yet confirmed', r.reported_unverified_cents], ['Checkout in progress', r.checkout_in_progress_cents], ['Still due', r.outstanding_cents]].map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}><T size={13} weight={k === 'Still due' ? '800' : '500'}>{k}</T><T size={13} weight={k === 'Still due' ? '800' : '500'}>{fmt(v, r.currency)}</T></View>))}
          <T size={12} color={c.mute}>Earnings ledger: sales {fmt(r.ledger.sale_cents, r.currency)} · refunds {fmt(r.ledger.refund_cents, r.currency)}{r.ledger.chargeback_cents ? ` · disputes lost ${fmt(r.ledger.chargeback_cents, r.currency)}` : ''}. Payouts to the recipient are a separate step under Earnings.</T>
        </Card>))}
    </Section>
  );
}
