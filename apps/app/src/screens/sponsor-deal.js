import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Screen, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { SponsorPerformance } from './sponsor-performance';
import { c } from '../theme';

// Amounts are minor units of THEIR OWN currency; currencies are never added together and estimates are labelled.
const fmt = (cents, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(cents / 10 ** (new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits)); } catch { return `${cents} ${cur ?? ''}`; } };
const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
const when = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const what = (o) => (o.kind === 'money' ? fmt(o.amount_cents, o.currency) : o.kind === 'goods' ? `${o.quantity} to deliver` : 'Endorsement');
const statusOf = (o) => (o.status === 'scheduled' && o.overdue ? 'overdue' : o.status);
const tone = { fulfilled: c.lime, overdue: c.pinkSoft, cancelled: c.paper, scheduled: c.sunSoft };

export function SponsorDeal({ id }) {
  const { toast } = useSession();
  const deal = useLoad(() => api.get(`/sponsorships/${id}`), [id]);
  const [form, setForm] = useState(null); // { kind, o }
  const d = deal.data;
  const act = async (fn, m) => { try { await fn(); toast(m); deal.reload(); } catch (e) { toast('' + e.message); } };
  if (deal.loading && !d) return <Screen><Loading /></Screen>;
  if (deal.error) return <Screen><ErrorBox error={deal.error} onRetry={deal.reload} /></Screen>;
  const sponsor = d.role === 'sponsor', recipient = d.role === 'recipient';
  const o = form?.o;
  return (
    <Screen>
      <H1>{d.sponsor.name}</H1>
      <T size={12} color={c.mute}>{d.agreement_ref ?? 'Legacy agreement'} · {d.status} · terms v{d.accepted_version ?? d.terms_version}{d.starts_on ? ` · ${when(String(d.starts_on).slice(0, 10))} – ${d.ends_on ? when(String(d.ends_on).slice(0, 10)) : 'open'}` : ''}</T>
      {!d.lines.length ? <Card><T>This agreement predates structured terms: {d.legacy_amount_cents ? `${d.legacy_amount_cents} (currency not recorded)` : 'no cash'}{d.legacy_in_kind ? ` · ${d.legacy_in_kind}` : ''}. No payment schedule exists for it.</T></Card> : null}
      <Section title="Terms" color={c.sun}>
        {d.lines.map((l) => (
          <Card key={l.id}><T weight="900">{l.label}</T>
            <T size={12} color={c.mute}>{l.kind}{l.kind === 'money' ? ` · ${l.total_cents ? `${fmt(l.total_cents, l.currency)} total` : `${fmt(l.amount_cents, l.currency)} each`}` : ''}{l.kind === 'goods' ? ` · ${l.quantity} ${l.unit ?? ''}` : ''}{l.kind === 'endorsement' ? ` · promoted by the ${l.promoter}` : ''} · {l.cadence}{l.instalments > 1 ? ` × ${l.instalments}` : ''}</T>
            {l.estimate_cents != null ? <T size={12} color={c.mute}>Estimated value {fmt(l.estimate_cents, l.currency)} — an estimate, not cash</T> : null}
          </Card>))}
        {d.schedule ? <T size={12} color={c.mute}>Committed cash: {Object.entries(d.schedule.committed).map(([cur, v]) => fmt(v, cur)).join(' · ') || 'none'}. Currencies are never combined.</T> : null}
      </Section>
      {d.schedule ? (
        <Section title="Schedule to review" color={c.cyan}>
          {d.schedule.occurrences.map((x) => <T key={`${x.line}-${x.seq}`} size={13}>{when(x.due_on)} · {x.label} · {what(x)}</T>)}
          {recipient && d.status === 'proposed' ? <Btn title={`Accept these exact terms (v${d.terms_version})`} color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'active', version: d.terms_version }), 'Agreement accepted')} /> : null}
        </Section>) : null}
      {d.obligations ? (
        <Section title="Commitments" color={c.mint}>
          {d.obligations.length ? d.obligations.map((x) => (
            <Card key={x.id} color={tone[statusOf(x)] ?? c.paper}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="900" style={{ flex: 1 }}>{when(x.due_on)} · {x.label}</T><Tag label={statusOf(x)} color={tone[statusOf(x)] ?? c.paper} /></View>
              <T size={12} color={c.mute}>{what(x)}{x.kind === 'money' ? ` · confirmed ${fmt(x.confirmed_cents, x.currency)}${x.reported_unverified_cents ? ` · reported, not yet confirmed ${fmt(x.reported_unverified_cents, x.currency)}` : ''}` : ''}{x.kind === 'goods' ? ` · received ${x.received_quantity}${x.in_transit_quantity ? ` · in transit ${x.in_transit_quantity}` : ''}` : ''}</T>
              {x.payments.map((p) => (
                <View key={p.id} style={{ marginTop: 4 }}>
                  <T size={12}>{fmt(p.amount_cents, p.currency)} · {p.method.replace('_', ' ')} · ref {p.reference} · {p.status === 'reported' ? 'unverified' : p.status}</T>
                  {recipient && p.status === 'reported' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}><Btn small title="Confirm received" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorship-payments/${p.id}`, { status: 'confirmed' }), 'Payment confirmed')} /><Btn small title="Not received" color={c.paper} ink={c.red} onPress={() => setForm({ kind: 'reject', o: p })} /></View> : null}
                  {recipient && p.status === 'confirmed' ? <Btn small title="Reverse" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 4 }} onPress={() => setForm({ kind: 'reverse', o: p })} /> : null}
                </View>))}
              {x.deliveries.map((dl) => (
                <View key={dl.id} style={{ marginTop: 4 }}>
                  <T size={12}>{dl.quantity} dispatched{dl.reference ? ` · ${dl.reference}` : ''} · {dl.status}{dl.status === 'received' ? ` (${dl.received_quantity})` : ''}</T>
                  {recipient && dl.status === 'dispatched' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}><Btn small title="Received" color={c.mint} ink={c.ink} onPress={() => setForm({ kind: 'receive', o: dl })} /><Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => setForm({ kind: 'rejectGoods', o: dl })} /></View> : null}
                </View>))}
              {x.submissions.map((s) => (
                <View key={s.id} style={{ marginTop: 4 }}>
                  <T size={12}>Evidence {s.evidence_url} · {s.status.replace('_', ' ')}{s.review_note ? ` — ${s.review_note}` : ''}</T>
                  {s.status === 'submitted' && d.role === (x.promoter === 'recipient' ? 'sponsor' : 'recipient') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}><Btn small title="Accept" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorship-submissions/${s.id}`, { status: 'accepted' }), 'Accepted')} /><Btn small title="Ask for changes" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'revise', o: s })} /></View> : null}
                </View>))}
              {x.status === 'scheduled' && x.kind === 'money' && sponsor ? <Btn small title="Report a payment" color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setForm({ kind: 'pay', o: x })} /> : null}
              {x.status === 'scheduled' && x.kind === 'goods' && sponsor ? <Btn small title="Record dispatch" color={c.orange} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setForm({ kind: 'dispatch', o: x })} /> : null}
              {x.status === 'scheduled' && x.kind === 'endorsement' && d.role === x.promoter && !x.submissions.some((s) => s.status !== 'revision_requested') ? <Btn small title="Submit evidence" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setForm({ kind: 'submit', o: x })} /> : null}
            </Card>)) : <Empty emoji="🗓️" title="Nothing scheduled" />}
          <T size={12} color={c.mute}>Payments here are tracked, not collected: Gotmygame does not hold or transfer these funds. A payment counts as received only after the recipient confirms it.</T>
        </Section>) : null}
      {d.target_type === 'athlete' && ['proposed', 'active', 'ended'].includes(d.status) && (sponsor || recipient) ? <SponsorPerformance deal={d} /> : null}
      <Section title="History" color={c.lime}>
        {d.history.map((h) => <T key={h.id} size={12} color={c.mute}>{new Date(h.created_at).toLocaleDateString()} · {h.action.replace(/_/g, ' ')}{h.version ? ` (v${h.version})` : ''} · {h.actor ?? 'system'}{h.reason ? ` — ${h.reason}` : ''}</T>)}
      </Section>

      <FormSheet visible={form?.kind === 'pay'} onClose={() => setForm(null)} title="Report a payment" submitLabel="Report"
        fields={[{ key: 'amount_cents', label: 'Amount paid', type: 'money', currency: o?.currency ?? 'USD' }, { key: 'method', label: 'How', type: 'choice', options: [{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cash', label: 'Cash' }, { value: 'other', label: 'Other' }] }, { key: 'reference', label: 'Bank / receipt reference' }, { key: 'paid_on', label: 'Paid on', type: 'date' }, { key: 'evidence_url', label: 'Link to proof (https)', optional: true, type: 'url' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-obligations/${o.id}/payments`, { ...v, currency: o.currency }); deal.reload(); return 'Reported — the recipient will confirm it'; }} />
      <FormSheet visible={form?.kind === 'dispatch'} onClose={() => setForm(null)} title="Record dispatch" submitLabel="Record"
        fields={[{ key: 'quantity', label: 'Quantity sent', type: 'stepper', min: 1, max: o?.quantity ?? 1, default: o?.quantity ?? 1 }, { key: 'reference', label: 'Tracking reference', optional: true }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-obligations/${o.id}/deliveries`, v); deal.reload(); return 'Dispatch recorded'; }} />
      <FormSheet visible={form?.kind === 'receive'} onClose={() => setForm(null)} title="Confirm receipt" submitLabel="Confirm"
        fields={[{ key: 'received_quantity', label: 'Quantity actually received', type: 'stepper', min: 1, max: o?.quantity ?? 1, default: o?.quantity ?? 1 }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-deliveries/${o.id}`, { status: 'received', received_quantity: v.received_quantity }); deal.reload(); return 'Receipt confirmed'; }} />
      <FormSheet visible={form?.kind === 'rejectGoods'} onClose={() => setForm(null)} title="Reject delivery" submitLabel="Reject" fields={[{ key: 'note', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-deliveries/${o.id}`, { status: 'rejected', note: v.note }); deal.reload(); return 'Delivery rejected'; }} />
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
