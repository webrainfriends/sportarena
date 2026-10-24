import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain } from '../access';

const SIDE = { sponsor: 'the sponsor', recipient: 'the recipient' };
const STATUS = { proposed: ['Waiting for an answer', c.sunSoft], accepted: ['Accepted', c.limeSoft], rejected: ['Rejected', c.pinkSoft], withdrawn: ['Withdrawn', c.paper], superseded: ['Superseded', c.paper] };
const cash = (v, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(v / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${v} ${cur}`; } };
const when = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const day = (iso) => String(iso).slice(0, 10);
const CADENCE = [{ value: 'once', label: 'Once' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }];
// the editable part of a line; everything else is carried over unchanged
const LINE_KEYS = ['kind', 'label', 'currency', 'amount_cents', 'total_cents', 'estimate_cents', 'quantity', 'unit', 'cadence', 'first_due_on', 'instalments', 'custom_dates', 'promoter', 'terms', 'service_type'];
const keep = (l) => Object.fromEntries(LINE_KEYS.filter((k) => l[k] != null).map((k) => [k, k === 'first_due_on' ? day(l[k]) : k === 'custom_dates' ? l[k].map(day) : l[k]]));
const download = (name, text) => { if (Platform.OS === 'web' && typeof document !== 'undefined') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); } };

/** What accepting would do to the dues, in plain words: what stays, what is replaced, what is new, and the cash before and after per currency. */
export function Impact({ impact: m }) {
  if (!m) return null;
  return (
    <View style={{ gap: 6 }} accessibilityLabel="Impact of this amendment">
      <T weight="800">What would change (from {when(m.effective_from)})</T>
      {m.totals.length ? m.totals.map((t) => (
        <T key={t.currency} size={14}>{cash(t.before_cents, t.currency)} → <T size={14} weight="800">{cash(t.after_cents, t.currency)}</T> <T size={13} color={t.delta_cents < 0 ? c.red : c.mute}>({t.delta_cents >= 0 ? '+' : '−'}{cash(Math.abs(t.delta_cents), t.currency)})</T></T>)) : <T size={13} color={c.mute}>No cash is involved.</T>}
      <T size={13}>✓ {m.retained_count} earlier due{m.retained_count === 1 ? '' : 's'} stay exactly as they are (settled history is never rewritten).</T>
      <T size={13}>↻ {m.replaced.length} future due{m.replaced.length === 1 ? '' : 's'} nothing has happened to {m.replaced.length === 1 ? 'is' : 'are'} replaced; {m.added.length} new due{m.added.length === 1 ? '' : 's'} take {m.added.length === 1 ? 'its' : 'their'} place.</T>
      {m.added.slice(0, 6).map((x, n) => <T key={n} size={12} color={c.mute}>{when(x.due_on)} · {x.label} · {x.kind === 'money' ? cash(x.amount_cents, x.currency) : x.kind === 'goods' ? `${x.quantity} to deliver` : 'Endorsement'}</T>)}
      {m.added.length > 6 ? <T size={12} color={c.mute}>…and {m.added.length - 6} more</T> : null}
      {m.blocked ? <T color={c.red} weight="700" accessibilityRole="alert">{m.blocked}</T> : null}
      <T size={12} color={c.mute}>Currencies are never combined. Estimates are not cash.</T>
    </View>
  );
}

/** Amendments of an ACCEPTED agreement: a versioned proposal either side can make, an impact preview, and a mutual accept that changes only untouched future dues. */
export function SponsorAmendments({ deal: d, can, act }) {
  const am = d.amendments;
  const [form, setForm] = useState(null); // 'propose' | 'edit' | 'reject'
  const [review, setReview] = useState(null); // { body, impact, editId, rev }
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState(null); // what was typed, kept while the impact is reviewed so Back loses nothing
  const open = am?.open;
  const detail = useLoad(() => (open ? api.get(`/sponsorship-amendments/${open.id}`) : Promise.resolve(null)), [open?.id, open?.rev, d.accepted_version]);
  const history = useLoad(() => (am?.total ? api.get(`/sponsorships/${d.id}/amendments`, { limit: 20 }) : Promise.resolve({ amendments: [], total: 0 })), [d.id, am?.total, d.accepted_version, open?.id]);
  const rep = d.beneficiary?.my_role === 'representative';
  const alloc = useLoad(() => (rep && d.role === 'recipient' ? api.get(`/sponsorships/${d.id}/allocations`) : Promise.resolve(null)), [d.id, rep]);
  if (!am || !['sponsor', 'recipient', 'admin'].includes(d.role) || d.status !== 'active' || !d.accepted_version) return null;
  const me = d.role, a = detail.data;
  const lines = d.lines;
  const money = lines.filter((l) => l.kind === 'money'), goods = lines.filter((l) => l.kind === 'goods'), posts = lines.filter((l) => l.kind === 'endorsement');
  const payees = alloc.data?.candidates?.payees ?? [], current = alloc.data?.allocations ?? [];
  const stale = (e) => { if (e.status === 409) { d.reload?.(); return new Error(`${e.message} The latest version is shown now: review it and try again.`); } return e; };

  const fields = [
    ...money.flatMap((l) => [
      { key: `m${l.position}`, label: `${l.label} — ${l.total_cents ? 'total' : 'each payment'}`, type: 'money', currency: l.currency },
      ...(l.cadence !== 'custom' ? [{ key: `c${l.position}`, label: `${l.label} — how often`, type: 'choice', options: CADENCE, default: l.cadence }, { key: `i${l.position}`, label: `${l.label} — number of payments`, type: 'stepper', min: 1, max: 120, default: l.instalments ?? 1, show: (v) => (v[`c${l.position}`] ?? l.cadence) !== 'once' }] : []),
    ]),
    ...goods.map((l) => ({ key: `g${l.position}`, label: `${l.label} — quantity`, type: 'stepper', min: 1, max: 100000, default: l.quantity })),
    ...posts.flatMap((l) => [
      { key: `x${l.position}`, label: `${l.label} — exclusivity`, type: 'multiline', optional: true },
      { key: `u${l.position}`, label: `${l.label} — how the brand's assets may be used`, type: 'multiline', optional: true },
    ]),
    { key: 'period', label: 'Agreement period', type: 'daterange', toKey: 'period_to', optional: true },
    { key: 'effective_from', label: 'Changes apply to dues from', type: 'date', min: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), hint: 'Earlier dues, and any due that already has a payment, delivery or evidence, never change.' },
    ...(rep && current.length ? current.map((x, n) => ({ key: `p${n}`, label: `Who is paid for ${x.beneficiary_name}`, type: 'chips', options: payees.map((p) => ({ value: p.id, label: `${p.display_name} (${p.role})` })), default: x.payee_user_id })) : []),
    { key: 'reason', label: me === 'recipient' ? 'Why you are asking for this change' : 'What changes and why', type: 'multiline', optional: true },
  ];
  // what the form opens with: today's agreed terms, then whatever was already typed or proposed on top
  const initial = (src) => ({ period: d.starts_on ? day(d.starts_on) : undefined, period_to: d.ends_on ? day(d.ends_on) : undefined,
    ...Object.fromEntries(money.map((l) => [`m${l.position}`, l.total_cents ?? l.amount_cents])), ...Object.fromEntries(goods.map((l) => [`g${l.position}`, l.quantity])),
    ...Object.fromEntries(posts.flatMap((l) => [[`x${l.position}`, l.terms?.exclusivity ?? ''], [`u${l.position}`, l.terms?.asset_usage ?? '']])), ...(src ?? {}) });
  const build = (v) => {
    const out = lines.map((l) => {
      const x = keep(l);
      if (l.kind === 'money') {
        const cents = v[`m${l.position}`]; if (l.total_cents) { x.total_cents = cents; delete x.amount_cents; } else { x.amount_cents = cents; delete x.total_cents; }
        if (l.cadence !== 'custom') { x.cadence = v[`c${l.position}`] ?? l.cadence; if (x.cadence === 'once') delete x.instalments; else x.instalments = v[`i${l.position}`] ?? l.instalments ?? 1; }
      }
      if (l.kind === 'goods') x.quantity = v[`g${l.position}`];
      if (l.kind === 'endorsement') { const t = { ...(l.terms ?? {}) }; for (const [k, key] of [['exclusivity', `x${l.position}`], ['asset_usage', `u${l.position}`]]) { if (v[key]) t[k] = v[key]; else delete t[k]; } x.terms = t; }
      return x;
    });
    const body = { lines: out, effective_from: v.effective_from, reason: v.reason || undefined, ...(v.period ? { starts_on: v.period, ends_on: v.period_to ?? v.period } : {}) };
    const changed = current.some((x, n) => v[`p${n}`] && v[`p${n}`] !== x.payee_user_id);
    if (changed) body.allocations = current.map((x, n) => ({ beneficiary_type: x.beneficiary_type, beneficiary_id: x.beneficiary_id, share_bp: x.share_bp, payee_user_id: v[`p${n}`] ?? x.payee_user_id }));
    return body;
  };
  const preview = async (v, editId, rev) => {
    setDraft(v);
    const body = build(v);
    if (!body.effective_from) throw new Error('Choose the date the changes start from');
    const impact = await api.post(`/sponsorships/${d.id}/amendments/preview`, { id: d.id, ...body }).catch((e) => { throw stale(e); });
    setReview({ body, impact, editId, rev });
    return 'Review the impact, then send it';
  };
  const send = async () => {
    setErr(null);
    try {
      if (review.editId) await api.post(`/sponsorship-amendments/${review.editId}/revise`, { ...review.body, rev: review.rev, expected_version: d.accepted_version });
      else await api.post(`/sponsorships/${d.id}/amendments`, { ...review.body, expected_version: d.accepted_version });
      setReview(null); setDraft(null); act(async () => {}, review.editId ? 'Proposal updated — the other side sees the new revision' : 'Proposal sent — nothing changes until the other side accepts');
    } catch (e) { setErr(e.status === 409 ? e.message : explain(e)); if (e.status === 409) d.reload?.(); }
  };
  const answer = (decision, note) => act(() => api.post(`/sponsorship-amendments/${open.id}/decision`, { decision, rev: open.rev, version: d.accepted_version, note }),
    { accept: 'Amendment accepted — only the affected future dues changed', reject: 'Amendment rejected — nothing changed', withdraw: 'Proposal withdrawn — nothing changed' }[decision]);
  const exportCsv = async () => { try { const r = await api.get(`/sponsorships/${d.id}/amendments/export`); download(r.filename, r.csv); } catch (e) { setErr(explain(e)); } };

  return (
    <Section title="Amendments" color={c.cyan}>
      <T size={12} color={c.mute} accessibilityRole="text">Changes to an accepted agreement need both sides. A proposal changes nothing until the other side accepts the exact version; only future dues that nothing has happened to can change, and everything already settled stays as it is.</T>
      {open ? (
        detail.loading && !a ? <Loading /> : detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : a ? (
          <Card color={a.can_answer ? c.sunSoft : c.paper}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Tag label={`Amendment ${a.seq}`} /><Tag label={`Revision ${a.rev}`} color={c.paper} /><Tag label={STATUS.proposed[0]} color={c.sunSoft} />
            </View>
            <T weight="700" style={{ marginTop: 8 }} accessibilityRole="text">{a.mine ? `You proposed this. Waiting for ${SIDE[me === 'sponsor' ? 'recipient' : 'sponsor']}.` : `Proposed by ${SIDE[a.proposed_side]}${a.proposed_by_name ? ` (${a.proposed_by_name})` : ''}. Your answer is needed.`}</T>
            {a.reason ? <T size={13} style={{ marginTop: 4 }}>“{a.reason}”</T> : null}
            <View style={{ marginTop: 10 }}>{a.impact ? <Impact impact={a.impact} /> : a.impact_error ? <T color={c.red}>{a.impact_error}</T> : null}</View>
            {a.changes_payees ? <T size={13} style={{ marginTop: 6 }}>Also changes who is paid{a.allocations && me === 'recipient' ? `: ${a.allocations.map((x) => `${x.beneficiary_name} → ${x.payee_name}`).join(', ')}` : ''}.</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {a.can_answer ? <Btn small title={`Accept these exact terms (revision ${a.rev})`} color={c.mint} ink={c.ink} disabled={!!a.impact?.blocked} onPress={() => answer('accept')} /> : null}
              {a.can_answer ? <Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => setForm('reject')} /> : null}
              {a.can_edit ? <Btn small title="Edit my proposal" color={c.violet} onPress={() => { setDraft(null); setForm('edit'); }} /> : null}
              {a.can_edit ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => answer('withdraw')} /> : null}
            </View>
            {!a.mine && !a.can_answer && me !== 'admin' ? <T size={12} color={c.mute} style={{ marginTop: 8 }} accessibilityRole="text">{me === 'sponsor' ? 'Your role cannot agree for the brand; a manager or approver can.' : d.youth?.minor_self ? 'Your guardian decides this for you.' : 'Only an owner or admin of the organisation can answer.'}</T> : null}
            {me === 'admin' ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Platform admins can read amendments but never agree for either side.</T> : null}
          </Card>) : null
      ) : am.can_propose ? (
        <Btn title="Propose an amendment" color={c.cyan} ink={c.ink} onPress={() => { setDraft(null); setForm('propose'); }} style={{ alignSelf: 'flex-start' }} />
      ) : me !== 'admin' ? <T size={12} color={c.mute} accessibilityRole="text">{me === 'sponsor' ? 'Your role cannot propose changes to the terms; a manager, legal or approver colleague can.' : d.youth?.minor_self ? 'Your guardian decides this for you.' : 'Only an owner or admin of the organisation can propose changes.'}</T> : null}

      {err ? <T color={c.red} weight="700" accessibilityRole="alert">{err}</T> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <T weight="700">Amendment history</T>
        {am.total && can('export') && Platform.OS === 'web' ? <Btn small title="⬇ Export (CSV)" color={c.paper} ink={c.ink} onPress={exportCsv} /> : null}
      </View>
      {history.loading && !history.data ? <Loading /> : history.error ? <ErrorBox error={history.error} onRetry={history.reload} /> : history.data?.amendments?.length ? history.data.amendments.map((x) => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800">Amendment {x.seq}</T><Tag label={(STATUS[x.status] ?? [x.status])[0]} color={(STATUS[x.status] ?? [])[1]} /></View>
          <T size={12} color={c.mute}>Proposed by {SIDE[x.proposed_side]} · effective {when(x.effective_from)}{x.resulting_version ? ` · created terms v${x.resulting_version}` : ''}{x.changes_payees ? ' · changes payee' : ''}</T>
          {x.reason ? <T size={13}>“{x.reason}”</T> : null}
          {x.decision_note ? <T size={13} color={c.mute}>Answer: {x.decision_note}</T> : null}
        </Card>)) : <Empty emoji="📝" title="No amendments yet" sub="This agreement is running on its original terms." />}

      <FormSheet visible={form === 'propose'} onClose={() => setForm(null)} title="Propose an amendment" submitLabel="Preview the impact" fields={fields} initial={initial(draft)} onSubmit={(v) => preview(v)} />
      <FormSheet visible={form === 'edit'} onClose={() => setForm(null)} title={`Edit amendment ${a?.seq ?? ''}`} submitLabel="Preview the impact" fields={fields}
        initial={a ? initial(draft ?? { effective_from: day(a.effective_from), reason: a.reason ?? '', period: a.starts_on ? day(a.starts_on) : undefined, period_to: a.ends_on ? day(a.ends_on) : undefined,
          ...Object.fromEntries(a.lines.filter((l) => l.kind === 'money').flatMap((l) => { const o = money.find((m) => m.label === l.label)?.position; return [[`m${o}`, l.total_cents ?? l.amount_cents], [`c${o}`, l.cadence], [`i${o}`, l.instalments ?? 1]]; })),
          ...Object.fromEntries(a.lines.filter((l) => l.kind === 'endorsement').flatMap((l) => { const o = posts.find((m) => m.label === l.label)?.position; return [[`x${o}`, l.terms?.exclusivity ?? ''], [`u${o}`, l.terms?.asset_usage ?? '']]; })),
          ...Object.fromEntries(a.lines.filter((l) => l.kind === 'goods').map((l) => [`g${goods.find((m) => m.label === l.label)?.position}`, l.quantity])) }) : undefined}
        onSubmit={(v) => preview(v, a.id, a.rev)} />
      <FormSheet visible={form === 'reject'} onClose={() => setForm(null)} title="Reject this amendment" submitLabel="Reject" fields={[{ key: 'note', label: 'Why (the other side will see this)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/sponsorship-amendments/${open.id}/decision`, { decision: 'reject', rev: open.rev, version: d.accepted_version, note: v.note }).catch((e) => { throw stale(e); }); d.reload?.(); return 'Rejected — nothing changed'; }} />
      <Sheet visible={!!review} onClose={() => { setReview(null); setErr(null); }} title="Review before sending">
        {review ? (
          <View style={{ gap: 12 }}>
            <Impact impact={review.impact} />
            {review.body.allocations ? <T size={13}>Also changes who is paid.</T> : null}
            <T size={12} color={c.mute}>Sending this changes nothing yet. The other side sees exactly this and must accept it.</T>
            {err ? <T color={c.red} weight="700" accessibilityRole="alert">{err}</T> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="Back" color={c.paper} ink={c.ink} style={{ flex: 1 }} onPress={() => { setReview(null); setErr(null); setForm(review.editId ? 'edit' : 'propose'); }} />
              <Btn title="Send proposal" style={{ flex: 2 }} disabled={!!review.impact.blocked} onPress={send} />
            </View>
          </View>) : null}
      </Sheet>
    </Section>
  );
}
