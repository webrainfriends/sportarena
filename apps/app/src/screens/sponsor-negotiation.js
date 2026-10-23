import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain } from '../access';

const SIDE = { sponsor: 'The sponsor', recipient: 'The recipient' };
const FIELD = { amount_cents: 'Amount each', total_cents: 'Total', currency: 'Currency', quantity: 'Quantity', estimate_cents: 'Estimated value', cadence: 'Cadence', instalments: 'Instalments', first_due_on: 'First due', starts_on: 'Starts', ends_on: 'Ends', timezone: 'Time zone', promoter: 'Promoter', kind: 'Kind', unit: 'Unit', custom_dates: 'Dates', terms: 'Terms' };
const show = (v) => (v == null ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const cash = (v, cur) => { if (v == null) return '—'; try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(v / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return String(v / 100); } };
const ago = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
// The editable part of a counteroffer: one amount per money line, one quantity per goods line, the period and a reason. Everything else is carried over unchanged.
const LINE_KEYS = ['kind', 'label', 'currency', 'amount_cents', 'total_cents', 'estimate_cents', 'quantity', 'unit', 'cadence', 'first_due_on', 'instalments', 'custom_dates', 'promoter', 'terms', 'service_type'];
const keep = (l) => Object.fromEntries(LINE_KEYS.filter((k) => l[k] != null).map((k) => [k, k === 'first_due_on' ? String(l[k]).slice(0, 10) : k === 'custom_dates' ? l[k].map((x) => String(x).slice(0, 10)) : l[k]]));

/** Negotiation of an open offer: whose turn it is, counteroffer, version comparison, comments (shared and private) and the version history. */
export function SponsorNegotiation({ deal: d, can, act }) {
  const n = d.negotiation;
  const [form, setForm] = useState(null); // 'counter' | 'comment'
  const [cmp, setCmp] = useState(null);  // [from, to]
  const diff = useLoad(() => (cmp ? api.get(`/sponsorships/${d.id}/compare`, { from: cmp[0], to: cmp[1] }) : Promise.resolve(null)), [d.id, cmp?.join('-')]);
  if (!n || !['sponsor', 'recipient'].includes(d.role)) return null;
  const me = d.role, canSpeak = me === 'recipient' || can('revise');
  const open = n.open;
  const money = d.lines.filter((l) => l.kind === 'money'), goods = d.lines.filter((l) => l.kind === 'goods');
  const counterFields = [
    ...money.map((l) => ({ key: `m${l.position}`, label: `${l.label}${l.total_cents ? ' — total' : ' — each payment'}`, type: 'money', currency: l.currency })),
    ...goods.map((l) => ({ key: `g${l.position}`, label: `${l.label} — quantity`, type: 'stepper', min: 1, max: 100000, default: l.quantity })),
    { key: 'period', label: 'Period', type: 'daterange', toKey: 'period_to', optional: true },
    { key: 'reason', label: me === 'recipient' ? 'Why you are asking for this' : 'What changed and why', type: 'multiline', optional: true },
  ];
  const counterInitial = { period: d.starts_on ? String(d.starts_on).slice(0, 10) : undefined, period_to: d.ends_on ? String(d.ends_on).slice(0, 10) : undefined,
    ...Object.fromEntries(money.map((l) => [`m${l.position}`, l.total_cents ?? l.amount_cents])), ...Object.fromEntries(goods.map((l) => [`g${l.position}`, l.quantity])) };
  const sendCounter = async (v) => {
    const lines = d.lines.map((l) => {
      const x = keep(l);
      if (l.kind === 'money') { const cents = v[`m${l.position}`]; if (l.total_cents) x.total_cents = cents; else x.amount_cents = cents; }
      if (l.kind === 'goods') x.quantity = v[`g${l.position}`];
      return x;
    });
    try { await api.post(`/sponsorships/${d.id}/revise`, { lines, expected_version: d.terms_version, reason: v.reason, ...(v.period ? { starts_on: v.period, ends_on: v.period_to ?? v.period } : {}) }); }
    catch (e) { if (e.status === 409) { d.reload?.(); throw new Error('The terms changed while you were editing. The latest version is now shown — review it and try again.'); } throw e; }
    d.reload?.();
    return me === 'recipient' ? 'Counteroffer sent — nothing changes until the sponsor signs it off' : 'Revised version sent';
  };
  const turn = !open ? null : n.my_turn ? 'Your turn: sign off these terms, counter them, or comment.' : `Waiting for ${n.awaiting === 'sponsor' ? 'the sponsor' : 'the recipient'} to respond to your version.`;
  return (
    <Section title="Negotiation" color={c.violet}>
      {open ? (
        <Card color={n.my_turn ? c.sunSoft : c.paper}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={`Version ${d.terms_version}`} /><Tag label={`Written by ${me === n.terms_side ? 'you' : SIDE[n.terms_side].toLowerCase()}`} color={c.paper} /></View>
          <T style={{ marginTop: 8 }} weight="700" accessibilityRole="text">{turn}</T>
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>Nothing becomes active until the other side signs off the exact version. Counteroffers create no payments or deliveries.</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {n.can_counter && d.lines.length && (me === 'recipient' || can('revise')) ? <Btn small title={me === 'recipient' ? 'Make a counteroffer' : 'Revise my offer'} color={c.violet} onPress={() => setForm('counter')} /> : null}
            {n.can_withdraw_change && (me === 'recipient' || can('revise')) ? <Btn small title="Withdraw my change" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsorships/${d.id}/withdraw-counter`, { expected_version: d.terms_version }), 'Earlier terms re-issued as a new version')} /> : null}
          </View>
          {me === 'sponsor' && n.my_turn && !can('sign_off') ? <T size={12} color={c.mute} style={{ marginTop: 8 }} accessibilityRole="text">Your role cannot sign off for the brand; a manager or approver can.</T> : null}
        </Card>) : <T size={12} color={c.mute}>This agreement is no longer open to negotiation. The history below is kept.</T>}

      <T weight="700" style={{ marginTop: 6 }}>Compare versions</T>
      {n.versions.length < 2 ? <Empty emoji="🔁" title="Only one version so far" sub="Once a side changes the terms, you can see exactly what moved." /> : (
        <>
          <Seg options={n.versions.slice(1).map((v) => ({ value: v.version, label: `v${v.version - 1} → v${v.version}` }))} value={cmp ? cmp[1] : null} onChange={(to) => setCmp([to - 1, to])} />
          {!cmp ? <T size={12} color={c.mute}>Choose a step to see what changed.</T> : diff.loading ? <Loading /> : diff.error ? <ErrorBox error={diff.error} onRetry={diff.reload} /> : diff.data ? (
            <Card>
              <T size={12} color={c.mute} accessibilityRole="text">v{diff.data.from.version} by {SIDE[diff.data.from.authored_side].toLowerCase()} → v{diff.data.to.version} by {SIDE[diff.data.to.authored_side].toLowerCase()}{diff.data.to.reason ? ` — “${diff.data.to.reason}”` : ''}</T>
              {diff.data.unchanged ? <T style={{ marginTop: 6 }}>No changes to the terms.</T> : null}
              {diff.data.period.map((p) => <T key={p.field} style={{ marginTop: 6 }}>{FIELD[p.field]}: {show(p.from)} → <T weight="700">{show(p.to)}</T></T>)}
              {diff.data.changes.map((ch) => (
                <View key={`${ch.type}-${ch.label}`} style={{ marginTop: 8 }}>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Tag label={ch.type} color={ch.type === 'added' ? c.lime : ch.type === 'removed' ? c.pinkSoft : c.sunSoft} /><T weight="700" style={{ flex: 1 }}>{ch.label}</T></View>
                  {(ch.fields ?? []).map((f) => <T key={f.field} size={13} style={{ marginTop: 2 }}>{FIELD[f.field] ?? f.field}: {f.field.endsWith('_cents') && ch.currency ? cash(f.from, ch.currency) : show(f.from)} → <T size={13} weight="700">{f.field.endsWith('_cents') && ch.currency ? cash(f.to, ch.currency) : show(f.to)}</T></T>)}
                </View>))}
              <T size={12} color={c.mute} style={{ marginTop: 8 }}>Amounts are shown in each line's own currency; currencies are never combined.</T>
            </Card>) : null}
        </>)}

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <T weight="700">Comments on the terms</T>
        <Btn small title="Add a comment" color={c.paper} ink={c.ink} onPress={() => setForm('comment')} />
      </View>
      {n.comments.length ? n.comments.map((m) => (
        <Card key={m.id} color={m.visibility === 'internal' ? c.orangeSoft : c.paper}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <T size={12} weight="700">{m.author}</T><T size={12} color={c.mute}>{SIDE[m.side]} · v{m.version}{m.line_position ? ` · ${d.lines.find((l) => l.position === m.line_position)?.label ?? `line ${m.line_position}`}` : ''} · {ago(m.created_at)}</T>
            {m.visibility === 'internal' ? <Tag label="Private to your side" color={c.orangeSoft} /> : null}
          </View>
          <T style={{ marginTop: 4 }}>{m.body}</T>
        </Card>)) : <Empty emoji="💬" title="No comments yet" sub="Ask a question about a term, or keep a private note for your own side." />}

      <T weight="700" style={{ marginTop: 6 }}>Versions</T>
      {n.versions.slice().reverse().map((v) => (
        <T key={v.version} size={12} color={c.mute}>v{v.version} · {SIDE[v.authored_side]}{v.author ? ` (${v.author})` : ''} · {ago(v.created_at)}{v.restores ? ` · re-issues v${v.restores}` : ''}{v.signed_off_at ? ' · signed off' : ''}{v.reason ? ` — ${v.reason}` : ''}</T>))}

      <FormSheet visible={form === 'counter'} onClose={() => setForm(null)} title={me === 'recipient' ? `Counter version ${d.terms_version}` : 'Revise your offer'} submitLabel="Send" fields={counterFields} initial={counterInitial} onSubmit={sendCounter} />
      <FormSheet visible={form === 'comment'} onClose={() => setForm(null)} title="Comment on the terms" submitLabel="Post"
        fields={[
          { key: 'visibility', label: 'Who can see it', type: 'chips', options: [...(open && canSpeak ? [{ value: 'shared', label: 'Both sides' }] : []), { value: 'internal', label: 'Only my side (private)' }], default: open && canSpeak ? 'shared' : 'internal' },
          ...(d.lines.length ? [{ key: 'line_position', label: 'About', type: 'choice', optional: true, options: [{ value: undefined, label: 'The whole offer' }, ...d.lines.map((l) => ({ value: l.position, label: l.label }))] }] : []),
          { key: 'body', label: 'Comment', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${d.id}/comments`, { ...v, version: d.terms_version }); d.reload?.(); return v.visibility === 'internal' ? 'Private note saved' : 'Comment posted'; }} />
    </Section>
  );
}
