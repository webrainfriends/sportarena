import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Section, Bubble, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { useNav } from '../nav';

const TYPE_LABEL = { organisation: 'Organisation', group: 'Group', team: 'Team' };
const pct = (bp) => `${bp / 100}%`;
const money = (cents, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(cents / 100); } catch { return `${cents / 100} ${cur ?? ''}`; } };

/** Beneficiaries & payees of an organisation / group sponsorship: the sponsor sees names and shares only; an owner/admin edits them. */
export function SponsorAllocations({ deal }) {
  const { toast } = useSession();
  const al = useLoad(() => api.get(`/sponsorships/${deal.id}/allocations`), [deal.id]);
  const [edit, setEdit] = useState(false);
  const a = al.data;
  if (al.loading && !a) return <Section title="Beneficiaries & payees" color={c.cyan}><Loading /></Section>;
  if (al.error) return <Section title="Beneficiaries & payees" color={c.cyan}><LoadError error={al.error} onRetry={al.reload} /></Section>;
  const cands = a.can_edit ? [{ type: 'organisation', ...(deal.target_type === 'organisation' ? { id: a.beneficiary.organisation.id, name: a.beneficiary.organisation.name } : null) }, ...a.candidates.groups.map((g) => ({ type: 'group', ...g })), ...a.candidates.teams.map((t) => ({ type: 'team', ...t }))].filter((x) => x.id) : [];
  const payees = (a.candidates?.payees ?? []).map((p) => ({ value: p.id, label: `${p.display_name} · ${p.role}` }));
  const live = (x) => a.allocations.find((r) => r.beneficiary_type === x.type && r.beneficiary_id === x.id);
  const fields = cands.flatMap((x, i) => [
    { key: `use_${i}`, label: `${TYPE_LABEL[x.type]}: ${x.name}`, type: 'switch' },
    { key: `pct_${i}`, label: 'Share of every payment', type: 'stepper', min: 5, max: 100, step: 5, suffix: '%', show: (v) => v[`use_${i}`] },
    { key: `payee_${i}`, label: 'Payee (receives and confirms the money)', type: 'choice', options: payees, show: (v) => v[`use_${i}`] },
  ]);
  const initial = Object.fromEntries(cands.flatMap((x, i) => { const r = live(x); return [[`use_${i}`, !!r], [`pct_${i}`, r ? r.share_bp / 100 : 25], [`payee_${i}`, r?.payee_user_id ?? payees[0]?.value]]; }));
  const save = async (v) => {
    const allocations = cands.flatMap((x, i) => (v[`use_${i}`] ? [{ beneficiary_type: x.type, beneficiary_id: x.id, share_bp: Math.round(v[`pct_${i}`] * 100), payee_user_id: v[`payee_${i}`] }] : []));
    const total = allocations.reduce((s, r) => s + r.share_bp, 0);
    if (total > 10000) throw new Error(`Allocations total ${total / 100}% — reduce by ${(total - 10000) / 100}%.`);
    if (allocations.length && !payees.length) throw new Error('Add an owner, admin or finance member to the organisation first — a payee is needed.');
    try { await api.post(`/sponsorships/${deal.id}/allocations`, { rev: a.rev, allocations }); } catch (e) { if (e.status === 409) al.reload(); throw e; }
    al.reload(); return 'Allocations saved';
  };
  return (
    <Section title="Beneficiaries & payees" color={c.cyan} action={a.can_edit ? 'Edit' : undefined} onAction={() => setEdit(true)}>
      <T size={13} color={c.mute}>For {a.beneficiary.name}{a.beneficiary.type === 'group' ? ` (${a.beneficiary.organisation.name})` : ''}.{a.my_role ? ` You: ${a.my_role === 'representative' ? 'organisation representative' : 'payee'}.` : ''}</T>
      {a.allocations.length ? a.allocations.map((r) => (
        <Card key={r.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="900" style={{ flex: 1 }}>{r.beneficiary_name}</T><Tag label={pct(r.share_bp)} color={c.mint} /></View>
          <T size={12} color={c.mute}>{TYPE_LABEL[r.beneficiary_type]} · Payee: {r.payee_name}</T>
        </Card>))
        : <Empty emoji="🧾" title="No allocation yet" sub={a.can_edit ? `All support goes to ${a.beneficiary.organisation.name} until you allocate it.` : `All support goes to ${a.beneficiary.organisation.name} until its representative allocates it.`} />}
      {a.allocations.length ? <T size={12} color={c.mute}>Allocated {pct(a.allocated_bp)} · {pct(a.unallocated_bp)} unallocated (stays with the organisation).</T> : null}
      {a.history.length ? <T size={12} color={c.mute}>{a.history.length} earlier allocation{a.history.length === 1 ? '' : 's'} kept on record, with the payee as it was.</T> : null}
      <T size={12} color={c.mute}>A payment's payees are frozen when it is confirmed; later staff or membership changes never alter past payments. Rosters and member details are never shared with sponsors.</T>
      {a.can_edit ? (
        <FormSheet key={a.rev} visible={edit} onClose={() => setEdit(false)} title="Allocate this sponsorship" submitLabel="Save allocations" fields={fields} initial={initial} onSubmit={save} />) : null}
    </Section>
  );
}

/** Frozen payees on a confirmed payment. */
export function PayeeLine({ p }) {
  const s = p.payee_snapshot;
  if (!s?.allocations?.length) return null;
  return <T size={12} color={c.mute}>Paid to: {s.allocations.map((x) => `${x.payee_name} for ${x.beneficiary_name} (${pct(x.share_bp)}${p.currency ? `, ${money(x.amount_cents, p.currency)}` : ''})`).join(' · ')}{s.unallocated_cents ? ` · ${money(s.unallocated_cents, p.currency)} unallocated` : ''}</T>;
}

/** Sponsor: find organisations / groups that opted in, then offer to them. Names only; never rosters. */
export function BeneficiaryFinder({ brands, onSent }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('organisation');
  const [offerTo, setOfferTo] = useState(null);
  const list = useLoad(() => api.get('/sponsorship-beneficiaries', { type, limit: 20, ...(q.trim() ? { q: q.trim() } : {}) }), [q, type]);
  const { toast } = useSession();
  return (
    <Section title="Sponsor an organisation or group" color={c.cyan}>
      <T size={13} color={c.mute}>Only organisations that turned on “open to sponsors” appear. You see names only — never members.</T>
      <View style={{ flexDirection: 'row', gap: 8 }}><Chip label="Organisations" active={type === 'organisation'} onPress={() => setType('organisation')} /><Chip label="Groups" active={type === 'group'} onPress={() => setType('group')} /></View>
      <Field label="Search by name" value={q} onChangeText={setQ} placeholder="e.g. Riverside" />
      {list.loading && !list.data ? <Loading /> : list.error ? <LoadError error={list.error} onRetry={list.reload} />
        : list.data?.length ? list.data.map((o) => <Row key={o.id} left={<Bubble emoji={o.type === 'group' ? '👥' : '🏟️'} color={c.sun} />} title={o.name} sub={[o.organisation_name, o.kind, o.city].filter(Boolean).join(' · ')} right={<Btn small title="Offer" color={c.pink} onPress={() => setOfferTo(o)} />} />)
          : <Empty emoji="🔎" title="Nothing open to sponsors yet" sub="Organisations appear here once an owner or admin opens them to sponsors." />}
      <FormSheet visible={!!offerTo} onClose={() => setOfferTo(null)} title={`Offer to ${offerTo?.name ?? ''}`} submitLabel="Send offer"
        fields={[{ key: 'sponsor_id', label: 'Brand', type: 'choice', options: (brands ?? []).map((s) => ({ value: s.id, label: `${s.emoji} ${s.name}` })) },
          { key: 'currency', label: 'Currency', type: 'chips', options: ['INR', 'SGD', 'USD', 'EUR', 'GBP', 'AED'], default: 'INR' },
          { key: 'amount_cents', label: 'Amount', type: 'money', currency: (v) => v.currency ?? 'INR' },
          { key: 'first_due_on', label: 'Payment due', type: 'date' },
          { key: 'starts_on', label: 'Sponsorship period', type: 'daterange', toKey: 'ends_on' },
          { key: 'message', label: 'Message', type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          const { currency, amount_cents, first_due_on, starts_on, ends_on, message, sponsor_id } = v;
          await api.post('/sponsorships', { sponsor_id, target_type: offerTo.type, target_id: offerTo.id, starts_on, ends_on, message, lines: [{ kind: 'money', label: 'Support', currency, amount_cents, cadence: 'once', first_due_on }] });
          onSent?.(); toast('Offer sent'); return 'Offer sent — the organisation\'s representatives will be notified';
        }} />
    </Section>
  );
}

/** Organisation staff: offers and agreements aimed at this organisation or its groups, with a way into each. */
export function IncomingSponsorship({ orgId }) {
  const { push } = useNav();
  const deals = useLoad(() => api.get('/sponsorships', { organisation_id: orgId, as: 'target', limit: 100 }), [orgId]);
  return (
    <Section title="Sponsorship offers & agreements" color={c.sun}>
      {deals.loading && !deals.data ? <Loading /> : deals.error ? <LoadError error={deals.error} onRetry={deals.reload} />
        : deals.data?.length ? deals.data.map((d) => (
          <Row key={d.id} left={<Bubble emoji={d.sponsor_emoji ?? '💎'} color={c.sun} />} title={`${d.sponsor_name} → ${d.target_name}`} sub={`${d.target_type === 'group' ? 'Group' : 'Organisation'} · ${d.status}${d.agreement_ref ? ` · ${d.agreement_ref}` : ''}`}
            right={<Btn small title={d.status === 'proposed' ? 'Review' : 'Open'} color={c.violet} onPress={() => push('SponsorDeal', { id: d.id })} />} />))
          : <Empty emoji="💎" title="No sponsorship yet" sub="Turn on “Open to sponsors” in Edit details to let sponsors find this organisation and its groups." />}
    </Section>
  );
}
