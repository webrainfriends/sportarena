import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';

const SIDE = { sponsor: 'the sponsor', recipient: 'the recipient' };
const REASONS = [{ value: 'mutual', label: 'By agreement' }, { value: 'budget', label: 'Budget' }, { value: 'breach', label: 'Breach' }, { value: 'non_performance', label: 'Not delivered' }, { value: 'other', label: 'Other' }];
const REASON = Object.fromEntries(REASONS.map((r) => [r.value, r.label]));
const STATUS = { notice: ['Notice given', c.sunSoft], agreed: ['Terms accepted', c.limeSoft], ended: ['Ended', c.pinkSoft], settled: ['Settled', c.limeSoft], withdrawn: ['Withdrawn', c.paper] };
const STEP = { requested: ['Waiting for an answer', c.sunSoft], accepted: ['Accepted', c.limeSoft], approved: ['Approved', c.limeSoft], declined: ['Declined', c.pinkSoft], received: ['Received back', c.limeSoft], refunded: ['Money back', c.limeSoft] };
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const when = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const download = (name, text) => { if (Platform.OS === 'web' && typeof document !== 'undefined') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); } };
const Row = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{children}</View>;

/** What ending would do to the dues, in plain words: what stops, what stays, and what is still owed. Currencies are never combined. */
export function EndingImpact({ impact: m }) {
  if (!m) return null;
  return (
    <View style={{ gap: 6 }} accessibilityLabel="What ending would change">
      <T weight="800">What ending would change</T>
      <T size={13}>✓ {m.kept_count} due{m.kept_count === 1 ? '' : 's'} stay exactly as they are: anything already due, part-paid, dispatched, submitted or fulfilled is kept, and delivered value is never removed.</T>
      <T size={13}>⏹ {m.stopped_count} future due{m.stopped_count === 1 ? '' : 's'} that nothing has happened to {m.stopped_count === 1 ? 'is' : 'are'} stopped.</T>
      {m.totals.map((t) => <T key={t.currency} size={13} color={c.mute}>{t.currency}: paid {fmt(t.paid_cents, t.currency)} · still owed {fmt(t.still_owed_cents, t.currency)} · stopped {fmt(t.stopped_cents, t.currency)}</T>)}
    </View>
  );
}

/** Ending an agreement: notice, accepted terms, returns of goods, refunds of confirmed payments, disputes and the final settlement. All inside the agreement screen. */
export function SponsorTermination({ deal: d }) {
  const tm = useLoad(() => api.get(`/sponsorships/${d.id}/termination`), [d.id, d.status, d.accepted_version]);
  const [form, setForm] = useState(null); // 'notice' | 'return' | 'refund' | { kind: 'decline-return' | 'decline-refund' | 'dispute', row? }
  const [review, setReview] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  if (!['sponsor', 'recipient', 'admin'].includes(d.role)) return null;
  const x = tm.data, t = x?.termination;
  if (!x && tm.loading) return <Section title="Ending this agreement" color={c.pink}><Loading /></Section>;
  if (tm.error) return <Section title="Ending this agreement" color={c.pink}><LoadError error={tm.error} onRetry={tm.reload} /></Section>;
  if (!t && !['active', 'paused'].includes(d.status)) return null;
  const can = x.can, me = x.role;
  const refresh = () => { tm.reload(); d.reload?.(); };
  const stale = (e) => { if (e.status === 409) { refresh(); return new Error(`${e.message} The latest version is shown now: review it and try again.`); } return e; };
  const run = async (key, fn, ok) => { setErr(null); setBusy(key); try { await fn(); d.toast?.(ok); refresh(); } catch (e) { setErr(stale(e).message ?? explain(e)); } finally { setBusy(null); } };
  const answer = (action, extra = {}) => run(action, () => api.post(`/sponsorship-terminations/${t.id}/answer`, { action, rev: t.rev, ...extra }),
    { accept: 'Terms accepted', withdraw: 'Notice withdrawn — nothing changed', dispute: 'Dispute recorded', resolve_dispute: 'Dispute resolved' }[action]);
  const csv = async () => { try { const r = await api.get(`/sponsorships/${d.id}/termination/export`); download(r.filename, r.csv); } catch (e) { setErr(explain(e)); } };
  const returns = x.returns ?? [], refunds = x.refunds ?? [], s = x.settlement;
  const live = t && ['notice', 'agreed', 'ended'].includes(t.status);

  return (
    <Section title="Ending this agreement" color={c.pink}>
      <T size={12} color={c.mute} accessibilityRole="text">Either side can give notice. When the agreement ends, only future dues that nothing has happened to stop. Money already due or paid and goods already received are kept, and nothing is deleted.</T>

      {!t ? (
        <Card accessibilityLabel="No termination in progress">
          <T weight="800">No termination in progress</T>
          <View style={{ marginTop: 8 }}><EndingImpact impact={x.preview} /></View>
          {can.end_now ? <Btn title="End this paused agreement now" color={c.pink} loading={busy === 'endnow'} style={{ alignSelf: 'flex-start', marginTop: 12 }} onPress={() => run('endnow', () => api.patch(`/sponsorships/${d.id}`, { status: 'ended' }), 'Agreement ended — what is already due or paid is kept')} /> : can.give ? <Btn title="Give notice to end" color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 12 }} onPress={() => { setErr(null); setForm('notice'); }} /> : (
            <T size={12} color={c.mute} style={{ marginTop: 8 }} accessibilityRole="text">{me === 'admin' ? 'Platform admins can read terminations but never end an agreement for either side.' : me === 'sponsor' ? 'Your role cannot end agreements; a manager or approver can.' : 'Only an owner or admin of the organisation can give notice.'}</T>)}
        </Card>
      ) : (
        <Card color={t.status === 'notice' && can.accept ? c.sunSoft : c.paper} accessibilityLabel="Termination notice">
          <Row><Tag label={STATUS[t.status][0]} color={STATUS[t.status][1]} /><Tag label={REASON[t.reason_code]} color={c.paper} /><Tag label={`Revision ${t.rev}`} color={c.paper} /></Row>
          <T weight="700" style={{ marginTop: 8 }} accessibilityRole="text">{t.mine ? 'You gave notice.' : `Notice from ${SIDE[t.given_side]}${t.given_by_name ? ` (${t.given_by_name})` : ''}.`} Effective {when(t.effective_on)}{t.status === 'notice' || t.status === 'agreed' ? ' — the agreement keeps running until then.' : '.'}</T>
          <T size={12} color={c.mute}>Notice given {when(t.notice_on)}{t.agreed_at ? ` · terms accepted ${when(t.agreed_at)}` : ''}{t.ended_at ? ` · ended ${when(t.ended_at)}` : ''}</T>
          {t.reason ? <T size={13} style={{ marginTop: 4 }}>“{t.reason}”</T> : null}
          {t.disputed_at ? <Card color={t.dispute_resolved_at ? c.limeSoft : c.pinkSoft} style={{ marginTop: 8 }}><T weight="800" accessibilityRole="alert">{t.dispute_resolved_at ? 'Dispute resolved' : `Disputed${t.disputed_by_name ? ` by ${t.disputed_by_name}` : ''}`}</T><T size={13}>{t.dispute_note}</T>{t.dispute_case_id ? <T size={12} color={c.mute}>Linked to a support case.</T> : null}</Card> : null}
          <Row>
            {can.accept ? <Btn small title="Accept these terms" color={c.mint} ink={c.ink} loading={busy === 'accept'} onPress={() => answer('accept')} /> : null}
            {can.withdraw ? <Btn small title="Withdraw notice" color={c.paper} ink={c.red} loading={busy === 'withdraw'} onPress={() => answer('withdraw')} /> : null}
            {can.dispute ? <Btn small title="Dispute" color={c.paper} ink={c.red} onPress={() => { setErr(null); setForm({ kind: 'dispute' }); }} /> : null}
            {can.resolve_dispute ? <Btn small title="Resolve dispute" color={c.violet} loading={busy === 'resolve_dispute'} onPress={() => answer('resolve_dispute')} /> : null}
          </Row>
          {t.status === 'notice' && !can.accept && !can.withdraw ? <T size={12} color={c.mute} style={{ marginTop: 8 }} accessibilityRole="text">{me === 'admin' ? 'Platform admins can read this but never answer for either side.' : t.mine ? 'Waiting for the other side. You can withdraw it until they accept.' : 'Your role cannot answer for the brand; a manager or approver can.'}</T> : null}
        </Card>)}

      {err ? <T color={c.red} weight="700" accessibilityRole="alert">{err}</T> : null}

      {live ? (
        <>
          <Section title="Goods returned" color={c.orange}>
            {returns.length ? returns.map((r) => (
              <Card key={r.id} accessibilityLabel={`Return of ${r.quantity} ${r.label}`}>
                <Row><T weight="800" style={{ flex: 1 }}>{r.quantity} × {r.label}</T><Tag label={STEP[r.status][0]} color={STEP[r.status][1]} /></Row>
                {r.note ? <T size={12} color={c.mute}>“{r.note}”</T> : null}{r.decision_note ? <T size={12} color={c.mute}>Answer: {r.decision_note}</T> : null}
                <Row>
                  {can.answer_return && r.status === 'requested' ? <><Btn small title="Accept" color={c.mint} ink={c.ink} loading={busy === `r${r.id}`} onPress={() => run(`r${r.id}`, () => api.patch(`/sponsorship-returns/${r.id}`, { status: 'accepted' }), 'Return accepted')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => { setErr(null); setForm({ kind: 'decline-return', row: r }); }} /></> : null}
                  {can.return && r.status === 'accepted' ? <Btn small title="Goods arrived" color={c.mint} ink={c.ink} loading={busy === `r${r.id}`} onPress={() => run(`r${r.id}`, () => api.patch(`/sponsorship-returns/${r.id}`, { status: 'received' }), 'Goods confirmed back')} /> : null}
                </Row>
              </Card>)) : <Empty emoji="📦" title="No goods to return" sub={x.returnable.length ? 'The sponsor can ask for received goods back.' : 'Only goods the recipient confirmed as received can be returned.'} />}
            {can.return && x.returnable.length ? <Btn small title="Ask for goods back" color={c.orange} style={{ alignSelf: 'flex-start' }} onPress={() => { setErr(null); setForm('return'); }} /> : null}
          </Section>

          <Section title="Refunds" color={c.mint}>
            {refunds.length ? refunds.map((r) => (
              <Card key={r.id} accessibilityLabel={`Refund of ${fmt(r.amount_cents, r.currency)}`}>
                <Row><T weight="800" style={{ flex: 1 }}>{fmt(r.amount_cents, r.currency)} · {r.label}</T><Tag label={STEP[r.status][0]} color={STEP[r.status][1]} /></Row>
                <T size={12} color={c.mute}>Payment of {when(r.paid_on)} · {r.method === 'online' ? 'online, refunded by the payment provider' : r.method.replace('_', ' ')}</T>
                {r.note ? <T size={12} color={c.mute}>“{r.note}”</T> : null}{r.decision_note ? <T size={12} color={c.mute}>Answer: {r.decision_note}</T> : null}
                <Row>
                  {can.answer_refund && r.status === 'requested' ? <><Btn small title="Approve" color={c.mint} ink={c.ink} loading={busy === `f${r.id}`} onPress={() => run(`f${r.id}`, () => api.patch(`/sponsorship-refunds/${r.id}`, { status: 'approved' }), 'Refund approved')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => { setErr(null); setForm({ kind: 'decline-refund', row: r }); }} /></> : null}
                  {can.refund && r.status === 'approved' ? <Btn small title={r.method === 'online' ? 'Retry the provider refund' : 'Money is back'} color={c.mint} ink={c.ink} loading={busy === `f${r.id}`} onPress={() => run(`f${r.id}`, () => api.patch(`/sponsorship-refunds/${r.id}`, { status: 'refunded' }), 'Refund recorded')} /> : null}
                </Row>
              </Card>)) : <Empty emoji="💸" title="No refunds" sub={x.refundable.length ? 'The sponsor can ask for money back on a confirmed payment.' : 'Only confirmed payments can be refunded.'} />}
            {can.refund && x.refundable.length ? <Btn small title="Ask for a refund" color={c.mint} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => { setErr(null); setForm('refund'); }} /> : null}
          </Section>
        </>) : null}

      {t && s ? (
        <Section title="Final settlement" color={c.violet}>
          {s.currencies?.length ? s.currencies.map((r) => (
            <Card key={r.currency} accessibilityLabel={`Settlement in ${r.currency}`}>
              <T weight="900">{r.currency}</T>
              {[['Committed', r.committed_cents], ['Stopped (future dues)', r.stopped_cents], ['Received', r.received_cents], ['Refunded', r.refunded_cents], ['Still owed', r.still_owed_cents]].map(([k, v]) => (
                <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}><T size={13} weight={k === 'Still owed' ? '800' : '500'}>{k}</T><T size={13} weight={k === 'Still owed' ? '800' : '500'}>{fmt(v, r.currency)}</T></View>))}
            </Card>)) : <T size={13} color={c.mute}>No money is involved in this agreement.</T>}
          <Card color={s.items.length ? c.sunSoft : c.limeSoft} accessibilityLabel="Unresolved items">
            <T weight="800" accessibilityRole={s.items.some((i) => i.blocking) ? 'alert' : 'text'}>{s.items.length ? `Unresolved (${s.items.length})` : 'Nothing unresolved'}</T>
            {s.items.map((i) => <T key={`${i.kind}${i.ref}`} size={13}>{i.blocking ? '⚠ ' : '↪ '}{i.label}{i.amount_cents != null ? ` — ${fmt(i.amount_cents, i.currency)}` : i.quantity != null ? ` — ${i.quantity}` : ''}{i.blocking ? '' : ' (stays on record as owed)'}</T>)}
            {s.items.length ? <T size={12} color={c.mute}>⚠ must be resolved before the settlement can be final. ↪ dues that are still owed stay on record; nothing is erased.</T> : null}
          </Card>
          {t.status === 'settled' ? <T weight="700" accessibilityRole="text">Settled {when(t.settled_at)}. This record is final.</T> : null}
          <Row>
            {can.finalise ? <Btn title="Finalise settlement" color={c.violet} disabled={!!s.blocking} loading={busy === 'finalise'} onPress={() => run('finalise', () => api.post(`/sponsorship-terminations/${t.id}/settlement`, { rev: t.rev, carry_forward: s.carried > 0 }), s.carried ? 'Settlement final — owed dues stay on record' : 'Settlement final')} /> : null}
            {can.export && Platform.OS === 'web' ? <Btn small title="⬇ Settlement (CSV)" color={c.paper} ink={c.ink} onPress={csv} /> : null}
          </Row>
          {t.status === 'notice' || t.status === 'agreed' ? <T size={12} color={c.mute}>The settlement can be finalised after the agreement ends on {when(t.effective_on)}.</T> : null}
        </Section>) : null}

      {x.history?.length ? <Section title="Earlier notices" color={c.lime}>{x.history.map((h) => <T key={h.id} size={12} color={c.mute}>{when(h.notice_on)} · {SIDE[h.given_side]} · {REASON[h.reason_code]} · {STATUS[h.status][0]}</T>)}</Section> : null}

      <FormSheet visible={form === 'notice'} onClose={() => setForm(null)} title="Give notice to end" submitLabel="Review the impact"
        fields={[
          { key: 'reason_code', label: 'Reason', type: 'chips', options: REASONS, default: 'mutual' },
          { key: 'effective_on', label: 'Ends on', type: 'date', min: todayIso(), hint: 'Dues already due, part-paid or delivered are never removed.' },
          { key: 'reason', label: 'Details (shared with the other side)', type: 'multiline', optional: true },
        ]}
        initial={{ reason_code: 'mutual' }}
        onSubmit={async (v) => {
          if (!v.effective_on) throw new Error('Choose the date the agreement ends');
          const impact = await api.get(`/sponsorships/${d.id}/termination`).then((r) => r.preview).catch((e) => { throw stale(e); });
          setReview({ body: { reason_code: v.reason_code, reason: v.reason || undefined, effective_on: v.effective_on }, impact: impact ? { ...impact, effective_on: v.effective_on } : null });
          return 'Review the impact, then send the notice';
        }} />
      <Sheet visible={!!review} onClose={() => setReview(null)} title="Review before sending">
        {review ? (
          <View style={{ gap: 12 }}>
            <T size={14}>{REASON[review.body.reason_code]} · ends {when(review.body.effective_on)}{review.body.reason ? ` · “${review.body.reason}”` : ''}</T>
            <EndingImpact impact={review.impact} />
            <T size={12} color={c.mute}>{review.body.effective_on <= todayIso() ? 'The agreement ends immediately. The other side is told and can dispute.' : 'The agreement keeps running until the end date. The other side is told and can accept the terms or dispute.'}</T>
            {err ? <T color={c.red} weight="700" accessibilityRole="alert">{err}</T> : null}
            <Row>
              <Btn title="Back" color={c.paper} ink={c.ink} style={{ flex: 1 }} onPress={() => { setReview(null); setForm('notice'); }} />
              <Btn title="Send notice" style={{ flex: 2 }} loading={busy === 'give'} onPress={async () => { const body = review.body; setReview(null); await run('give', () => api.post(`/sponsorships/${d.id}/termination`, { ...body, expected_version: d.accepted_version }), 'Notice sent — the agreement keeps running until the end date'); }} />
            </Row>
          </View>) : null}
      </Sheet>
      <FormSheet visible={form?.kind === 'dispute'} onClose={() => setForm(null)} title="Dispute this termination" submitLabel="Record dispute" fields={[{ key: 'note', label: 'What do you dispute? (the other side will see this)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-terminations/${t.id}/answer`, { action: 'dispute', rev: t.rev, note: v.note }).catch((e) => { throw stale(e); }); refresh(); return 'Dispute recorded — it blocks the final settlement until resolved'; }} />
      <FormSheet visible={form === 'return'} onClose={() => setForm(null)} title="Ask for goods back" submitLabel="Send request"
        fields={[
          { key: 'delivery_id', label: 'Which delivery', type: 'chips', options: (x.returnable ?? []).map((r) => ({ value: r.delivery_id, label: `${r.label} — up to ${r.returnable_quantity}` })) },
          { key: 'quantity', label: 'How many', type: 'stepper', min: 1, max: Math.max(...(x.returnable ?? []).map((r) => r.returnable_quantity), 1), default: 1, hint: 'Cannot exceed what the recipient confirmed as received.' },
          { key: 'note', label: 'Note', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/sponsorship-terminations/${t.id}/returns`, { delivery_id: v.delivery_id, quantity: v.quantity, note: v.note || undefined }).catch((e) => { throw stale(e); }); refresh(); return 'Return requested'; }} />
      <FormSheet visible={form === 'refund'} onClose={() => setForm(null)} title="Ask for a refund" submitLabel="Send request"
        fields={[
          { key: 'sponsorship_payment_id', label: 'Which payment', type: 'chips', options: (x.refundable ?? []).map((r) => ({ value: r.payment_id, label: `${r.label} · ${when(r.paid_on)} · ${fmt(r.refundable_cents, r.currency)} refundable` })) },
          { key: 'amount_cents', label: 'Amount to get back', type: 'money', currency: (v) => (x.refundable ?? []).find((r) => r.payment_id === v.sponsorship_payment_id)?.currency ?? (x.refundable?.[0]?.currency ?? 'USD'), hint: 'In the currency of that payment; cannot exceed what is still refundable.' },
          { key: 'note', label: 'Note', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/sponsorship-terminations/${t.id}/refunds`, { sponsorship_payment_id: v.sponsorship_payment_id, amount_cents: v.amount_cents, note: v.note || undefined }).catch((e) => { throw stale(e); }); refresh(); return 'Refund requested'; }} />
      <FormSheet visible={form?.kind === 'decline-return'} onClose={() => setForm(null)} title="Decline this return" submitLabel="Decline" fields={[{ key: 'note', label: 'Why', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-returns/${form.row.id}`, { status: 'declined', note: v.note }).catch((e) => { throw stale(e); }); refresh(); return 'Return declined'; }} />
      <FormSheet visible={form?.kind === 'decline-refund'} onClose={() => setForm(null)} title="Decline this refund" submitLabel="Decline" fields={[{ key: 'note', label: 'Why', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/sponsorship-refunds/${form.row.id}`, { status: 'declined', note: v.note }).catch((e) => { throw stale(e); }); refresh(); return 'Refund declined'; }} />
    </Section>
  );
}
