import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { pickDocument } from './insurance';

const SUBJECT = { agreement: 'Agreement', payment: 'Payment', goods: 'Goods', evidence: 'Evidence' };
const STATUS = { open: ['Contested', c.pinkSoft], under_review: ['Under review', c.sunSoft], appealed: ['Appealed', c.sunSoft], resolved: ['Resolved', c.limeSoft], withdrawn: ['Withdrawn', c.paper] };
const FLAG = { amount_mismatch: 'Amount mismatch', suspected_fraud: 'Suspected fraud', duplicate_claim: 'Duplicate claim', evidence_concern: 'Evidence concern', consent_concern: 'Consent concern', other: 'Other' };
const OUTCOME = [{ value: 'concession', label: 'Waive part of a due' }, { value: 'no_financial_change', label: 'No financial change' }, { value: 'dismissed', label: 'Dismiss' }];
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`.trim(); } };
const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const download = (name, text) => { if (Platform.OS === 'web' && typeof document !== 'undefined') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); } };
const Row = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{children}</View>;
const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

/** Disputes and complaints on one agreement: raise one against a payment, delivery, evidence or the agreement, follow it, and (for reviewers) decide it. */
export function SponsorDisputes({ deal: d }) {
  const list = useLoad(() => api.get(`/sponsorships/${d.id}/disputes`), [d.id, d.status]);
  const [open, setOpen] = useState(null); // the dispute being read
  const [form, setForm] = useState(null); // 'new' | 'reply' | 'flag' | 'resolve' | 'appeal' | { kind: 'clear', flag }
  const [err, setErr] = useState(null);
  if (!['sponsor', 'recipient', 'admin'].includes(d.role)) return null;
  const x = list.data;
  if (!x && list.loading) return <Section title="Disputes & complaints" color={c.pink}><Loading /></Section>;
  if (list.error) {
    if (list.error.status === 403) return null; // this role is not allowed to see disputes: nothing to show
    return <Section title="Disputes & complaints" color={c.pink}><LoadError error={list.error} onRetry={list.reload} /></Section>;
  }
  if (d.role === 'admin' && !x.disputes.length) return null;
  const refresh = async () => { await list.reload(); d.reload?.(); };
  const stale = (e) => { if (e.status === 409) { refresh(); return new Error(`${e.message} The latest version is shown: review it and try again.`); } return e; };
  const csv = async () => { try { const r = await api.get(`/sponsorships/${d.id}/disputes/export`); download(r.filename, r.csv); } catch (e) { setErr(explain(e)); } };

  return (
    <Section title="Disputes & complaints" color={c.pink}>
      <T size={12} color={c.mute} accessibilityRole="text">Raise an issue about a payment, a delivery, endorsement evidence or the agreement. The money owed and every record stay exactly as they are while it is reviewed.</T>
      {err ? <T color={c.red} accessibilityRole="alert">{err}</T> : null}
      {!x.disputes.length ? <Empty emoji="🤝" title="No disputes on this agreement" sub="If something looks wrong, raise it here and the other side is told." /> : null}
      {x.disputes.map((r) => (
        <Card key={r.id} onPress={() => { setErr(null); setOpen(r.id); }} accessibilityLabel={`Dispute ${r.case_no}, ${SUBJECT[r.subject_type]}, ${(STATUS[r.status] ?? [r.status])[0]}`}>
          <Row><T weight="800">#{r.case_no} · {SUBJECT[r.subject_type]}</T><Tag label={(STATUS[r.status] ?? [r.status])[0]} color={(STATUS[r.status] ?? [null, c.paper])[1]} />{r.open_flags ? <Tag label={`${r.open_flags} risk flag${r.open_flags === 1 ? '' : 's'}`} color={c.sunSoft} /> : null}</Row>
          <T size={12} color={c.mute}>{r.subject}{r.disputed_cents ? ` · ${fmt(r.disputed_cents, r.currency)} disputed` : ''} · opened {when(r.created_at)} by the {r.opened_side}</T>
          {r.contested ? <T size={12} color={c.red}>Contested — the record is unchanged until a decision is applied.</T> : null}
        </Card>))}
      <Row>
        {x.can_open ? <Btn small title="Raise a dispute" color={c.violet} onPress={() => { setErr(null); setForm('new'); }} /> : null}
        {x.disputes.length ? <Btn small title="Export CSV" color={c.paper} ink={c.ink} onPress={csv} /> : null}
      </Row>
      <FormSheet visible={form === 'new'} onClose={() => setForm(null)} title="Raise a dispute" submitLabel="Open dispute"
        fields={[
          { key: 'subject_type', label: 'What is it about?', type: 'chips', options: [{ value: 'payment', label: 'A payment' }, { value: 'goods', label: 'Goods' }, { value: 'evidence', label: 'Endorsement evidence' }, { value: 'agreement', label: 'The agreement' }] },
          { key: 'payment_id', label: 'Which payment', type: 'chips', optional: true, show: (v) => v.subject_type === 'payment', options: (x.subjects?.payments ?? []).map((p) => ({ value: p.id, label: `${p.label} · ${fmt(Number(p.amount_cents), p.currency)} · ${p.reference} (${p.status})` })) },
          { key: 'delivery_id', label: 'Which delivery', type: 'chips', optional: true, show: (v) => v.subject_type === 'goods', options: (x.subjects?.deliveries ?? []).map((p) => ({ value: p.id, label: `${p.label} · ${p.quantity} sent (${p.status})` })) },
          { key: 'evidence_id', label: 'Which evidence', type: 'chips', optional: true, show: (v) => v.subject_type === 'evidence', options: (x.subjects?.evidence ?? []).map((p) => ({ value: p.id, label: `${p.label} · ${when(p.created_at)} (${p.status})` })) },
          { key: 'obligation_id', label: 'Which due (optional)', type: 'chips', optional: true, show: (v) => v.subject_type === 'agreement', options: (x.subjects?.dues ?? []).map((o) => ({ value: o.id, label: `${o.label} · due ${o.due_on} · ${fmt(Number(o.amount_cents), o.currency)}` })) },
          { key: 'disputed_cents', label: 'Amount you dispute', type: 'money', show: (v) => v.subject_type === 'payment', currency: (v) => (x.subjects?.payments ?? []).find((p) => p.id === v.payment_id)?.currency ?? 'USD', hint: 'In the payment’s currency; cannot be more than the payment.' },
          { key: 'title', label: 'Short title', type: 'text' },
          { key: 'description', label: 'What happened?', type: 'multiline' },
          { key: 'reference', label: 'Evidence link (optional, https)', type: 'text', optional: true },
        ]}
        onSubmit={async (v) => {
          const body = { subject_type: v.subject_type, title: v.title, description: v.description, idempotency_key: `dsp-${d.id}-${Date.now()}` };
          if (v.subject_type === 'agreement') { if (v.obligation_id) body.obligation_id = v.obligation_id; } else body.subject_id = { payment: v.payment_id, goods: v.delivery_id, evidence: v.evidence_id }[v.subject_type];
          if (v.subject_type === 'payment') body.disputed_cents = v.disputed_cents;
          if (v.reference) body.evidence = [{ label: 'Link', reference: v.reference }];
          await api.post(`/sponsorships/${d.id}/disputes`, body).catch((e) => { throw stale(e); });
          await refresh();
          return 'Dispute opened — nothing about the debt or records changed';
        }} />
      {open ? <DisputeSheet id={open} onClose={() => { setOpen(null); refresh(); }} onChanged={refresh} /> : null}
    </Section>
  );
}

function DisputeSheet({ id, onClose, onChanged }) {
  const q = useLoad(() => api.get(`/sponsorship-disputes/${id}`), [id]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const x = q.data;
  const reload = async () => { await q.reload(); onChanged?.(); };
  const run = async (key, fn) => { setErr(null); setBusy(key); try { await fn(); await reload(); } catch (e) { if (e.status === 409) { await reload(); setErr(`${e.message} The latest version is shown: review it and try again.`); } else setErr(explain(e)); } finally { setBusy(null); } };
  const post = (path, body) => api.post(`/sponsorship-disputes/${id}/${path}`, { rev: x.rev, ...body });
  const attach = () => run('attach', async () => {
    const f = await pickDocument();
    if (!f) return;
    await post('replies', { body: `Added a document: ${f.name ?? 'file'}`, evidence: [{ label: f.name ?? 'Document', file_name: f.name ?? 'document', data: await toBase64(f.blob) }] });
  });
  return (
    <Sheet visible onClose={onClose} title={x ? `Dispute #${x.case_no}` : 'Dispute'}>
      {q.error ? <LoadError error={q.error} onRetry={q.reload} /> : !x ? <Loading /> : (
        <View style={{ gap: 12 }}>
          {err ? <T color={c.red} accessibilityRole="alert">{err}</T> : null}
          <Card color={x.contested ? c.pinkSoft : c.paper} accessibilityLabel="Dispute status">
            <Row><T weight="800">{SUBJECT[x.subject_type]}</T><Tag label={(STATUS[x.status] ?? [x.status])[0]} color={(STATUS[x.status] ?? [null, c.paper])[1]} /></Row>
            <T size={12} color={c.mute}>{x.subject}{x.disputed_cents ? ` · ${fmt(Number(x.disputed_cents), x.currency)} disputed` : ''} · opened {when(x.created_at)} by {x.opened_by}</T>
            {x.contested ? <T size={12}>Contested. The debt, payment and evidence stay on record exactly as before until a decision is applied.</T> : null}
            {x.status === 'resolved' ? <T size={13}>Decision: {x.resolution}{x.adjustments.length ? ` · waived ${x.adjustments.map((a) => fmt(Number(a.amount_cents), a.currency)).join(' + ')}` : ''}{x.appeal_until && x.can.appeal ? ` · appeal until ${when(x.appeal_until)}` : ''}</T> : null}
          </Card>
          <Row>
            {x.can.reply ? <Btn small title="Reply" color={c.violet} onPress={() => setForm('reply')} /> : null}
            {x.can.reply ? <Btn small title="Add a document" color={c.paper} ink={c.ink} loading={busy === 'attach'} onPress={attach} /> : null}
            {x.can.flag ? <Btn small title="Flag a risk" color={c.paper} ink={c.ink} onPress={() => setForm('flag')} /> : null}
            {x.can.resolve ? <Btn small title="Decide" color={c.violet} onPress={() => setForm('resolve')} /> : null}
            {x.can.appeal ? <Btn small title="Appeal" color={c.paper} ink={c.red} onPress={() => setForm('appeal')} /> : null}
            {x.can.withdraw ? <Btn small title="Withdraw" color={c.paper} ink={c.red} loading={busy === 'withdraw'} onPress={() => run('withdraw', () => post('withdraw', {}))} /> : null}
            {x.side === 'reviewer' && !x.reviewers.some((r) => !r.removed_at) ? <Btn small title="Claim this review" color={c.violet} onPress={() => setForm('claim')} /> : null}
          </Row>
          <T weight="800">Risk flags</T>
          {!x.flags.length ? <T size={12} color={c.mute}>No risk flags.</T> : x.flags.map((f) => (
            <Card key={f.id} color={f.cleared_at ? c.paper : c.sunSoft}>
              <Row><Tag label={FLAG[f.kind]} color={f.cleared_at ? c.paper : c.sunSoft} />{f.cleared_at ? <Tag label="Cleared" color={c.limeSoft} /> : null}</Row>
              <T size={13}>{f.reason}</T><T size={11} color={c.mute}>{f.raised_by} · {when(f.created_at)}{f.cleared_at ? ` · cleared: ${f.cleared_reason}` : ''}</T>
              {x.can.clear_flag && !f.cleared_at ? <Btn small title="Clear flag" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'clear', flag: f })} /> : null}
            </Card>))}
          <T weight="800">Conversation</T>
          {x.thread.map((m) => <Card key={m.id} color={m.visibility === 'internal' ? c.sunSoft : c.paper}><T size={11} color={c.mute}>{m.author} · {when(m.created_at)}{m.visibility === 'internal' ? ' · internal note' : ''}</T><T size={13}>{m.body}</T></Card>)}
          <T weight="800">Evidence</T>
          {!x.evidence.length ? <T size={12} color={c.mute}>No evidence added.</T> : x.evidence.map((e) => <T key={e.id} size={13}>• {e.label ?? e.file_name ?? 'Link'} · {e.added_by} · {when(e.created_at)}{e.sha256 ? ` · SHA-256 ${e.sha256.slice(0, 8)}…` : ''}</T>)}
          {x.reviewers.length ? <><T weight="800">Reviewers</T>{x.reviewers.map((r) => <T key={r.id} size={13}>• {r.name}{r.removed_at ? ' (removed)' : ''} — {r.reason}</T>)}</> : null}
          <T weight="800">Timeline</T>
          {x.history.map((h, i) => <T key={i} size={12} color={c.mute}>{when(h.created_at)} · {h.actor} · {h.action.replace(/_/g, ' ')}{h.reason ? `: ${h.reason}` : ''}</T>)}
          {x.appeals.map((a, i) => <Card key={i}><T weight="800">Appeal by the {a.side}</T><T size={13}>{a.reason}</T><T size={11} color={c.mute}>Decision appealed: {a.decision_before}</T></Card>)}
        </View>)}
      {x ? (<>
        <FormSheet visible={form === 'reply'} onClose={() => setForm(null)} title="Reply" submitLabel="Send"
          fields={[{ key: 'body', label: 'Your reply', type: 'multiline' }, ...(x.side === 'reviewer' ? [{ key: 'internal', label: 'Internal note (the sides cannot see it)', type: 'switch', default: false }] : [])]}
          onSubmit={async (v) => { await post('replies', { body: v.body, internal: !!v.internal }); await reload(); return 'Reply sent'; }} />
        <FormSheet visible={form === 'flag'} onClose={() => setForm(null)} title="Flag a risk" submitLabel="Flag"
          fields={[{ key: 'kind', label: 'What kind of risk?', type: 'chips', options: Object.entries(FLAG).map(([value, label]) => ({ value, label })) }, { key: 'reason', label: 'Why (required — it is recorded with your name)', type: 'multiline' }]}
          onSubmit={async (v) => { await post('flags', { kind: v.kind, reason: v.reason }); await reload(); return 'Flag recorded'; }} />
        <FormSheet visible={form?.kind === 'clear'} onClose={() => setForm(null)} title="Clear this flag" submitLabel="Clear" fields={[{ key: 'reason', label: 'Why is it cleared?', type: 'multiline' }]}
          onSubmit={async (v) => { await post(`flags/${form.flag.id}/clear`, { reason: v.reason }); await reload(); return 'Flag cleared — it stays on record'; }} />
        <FormSheet visible={form === 'claim'} onClose={() => setForm(null)} title="Claim this review" submitLabel="Claim" fields={[{ key: 'reason', label: 'Why you (shown in the timeline)', type: 'multiline' }]}
          onSubmit={async (v) => { await post('reviewers', { action: 'claim', reason: v.reason }); await reload(); return 'You are now a reviewer'; }} />
        <FormSheet visible={form === 'appeal'} onClose={() => setForm(null)} title="Appeal this decision" submitLabel="Appeal" fields={[{ key: 'reason', label: 'Why should it be reviewed again? (a different reviewer decides; one appeal only)', type: 'multiline' }]}
          onSubmit={async (v) => { await post('appeal', { reason: v.reason }); await reload(); return 'Appeal sent'; }} />
        <FormSheet visible={form === 'resolve'} onClose={() => setForm(null)} title="Decide this dispute" submitLabel="Apply decision"
          fields={[
            { key: 'outcome', label: 'Outcome', type: 'chips', options: OUTCOME },
            { key: 'amount_cents', label: 'Amount to waive', type: 'money', show: (v) => v.outcome === 'concession', currency: () => x.currency ?? 'USD', hint: 'Applied to the money due itself; cannot be more than is still owed or disputed.' },
            { key: 'reason', label: 'Reason (both sides will read this)', type: 'multiline' },
          ]}
          onSubmit={async (v) => { await post('resolve', { outcome: v.outcome, reason: v.reason, ...(v.outcome === 'concession' ? { amount_cents: v.amount_cents } : {}) }); await reload(); return 'Decision applied'; }} />
      </>) : null}
    </Sheet>
  );
}
