import React, { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, H1, Loading, Screen, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { BudgetWizard } from './budget-wizard';
import { BudgetCoverage, BudgetTrace, LinkProgramsSheet } from './budget-trace';
import { DocumentsSheet } from './insurance';
import { c } from '../theme';
import { explain, LoadError } from '../access';

// Sponsorship budget controls (#293). A budget is what the brand has AUTHORIZED to reserve and commit. Planned offers are shown apart and
// never count as money used or received; each currency stays in its own budget unless a sourced rate is set. The server decides everything.
export const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`.trim(); } };
const KIND = { annual: 'Annual', program: 'Program', department: 'Department', event: 'Event' };
const KIND_TONE = { annual: c.violetSoft, program: c.pinkSoft, department: c.mintSoft, event: c.sunSoft };
const MAY_EDIT = ['manager', 'finance', 'admin'];
const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const stamp = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

const Banner = ({ tone = c.sunSoft, children, action, onAction }) => (
  <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <T size={13} style={{ flex: 1 }}>{children}</T>
    {action ? <Btn small title={action} color={c.paper} ink={c.ink} onPress={onAction} accessibilityLabel={action} /> : null}
  </View>
);

/** Authorized budget split into committed / reserved / allocated to children / still available. Nothing here is "received". */
export function BudgetBar({ b }) {
  const total = b.authorized_cents || 1;
  const w = (x) => `${Math.max(0, Math.min(100, (x / total) * 100))}%`;
  return (
    <View accessible accessibilityRole="progressbar"
      accessibilityLabel={`${fmt(b.committed_cents, b.currency)} committed, ${fmt(b.reserved_cents, b.currency)} reserved, ${fmt(b.allocated_cents, b.currency)} allocated to child budgets, ${fmt(b.available_cents, b.currency)} available of ${fmt(b.authorized_cents, b.currency)} authorized`}>
      <View style={{ height: 12, borderRadius: 6, backgroundColor: c.mintSoft, overflow: 'hidden', flexDirection: 'row' }}>
        <View style={{ width: w(b.committed_cents), backgroundColor: c.pink }} />
        <View style={{ width: w(b.reserved_cents), backgroundColor: c.sun }} />
        <View style={{ width: w(b.allocated_cents), backgroundColor: c.violet }} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
        {[[c.pink, 'Committed'], [c.sun, 'Reserved'], [c.violet, 'Allocated'], [c.mintSoft, 'Available']].map(([col, l]) => (
          <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: col, borderWidth: 1, borderColor: c.line }} /><T size={11} color={c.mute}>{l}</T></View>
        ))}
      </View>
    </View>
  );
}

const Figure = ({ label, value, tone, note }) => (
  <View style={{ minWidth: 150, flexGrow: 1, flexBasis: 150, backgroundColor: tone ?? c.paper, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 12 }}>
    <T size={11} color={c.mute} weight="700" style={{ letterSpacing: 0.6 }}>{label.toUpperCase()}</T>
    <T size={17} weight="800" numberOfLines={1} adjustsFontSizeToFit style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
    {note ? <T size={11} color={c.mute}>{note}</T> : null}
  </View>
);

const editFields = [
  { key: 'name', label: 'Budget name' },
  { key: 'notes', label: 'Why this amount?', type: 'multiline', optional: true, hint: 'The rationale reviewers and auditors read: what it funds and how the figure was reached.' },
  { key: 'authorized_cents', label: 'Authorized amount', type: 'money', currency: (v) => v.currency ?? 'USD' },
  { key: 'approval_over_cents', label: 'Second approver needed above', type: 'money', currency: (v) => v.currency ?? 'USD', optional: true, hint: 'Offers and awards larger than this wait for another person to approve. Leave empty for none.' },
  { key: 'fx_policy', label: 'Other currencies', type: 'chips', options: [{ value: 'none', label: 'Not allowed' }, { value: 'explicit', label: 'Only at a sourced rate' }], default: 'none', hint: 'Different currencies are never added together unless you record a rate with its source.' },
];

/** Brand staff: the budgets of the brands I can see. */
export function SponsorBudgets() {
  const { push } = useNav();
  const { toast } = useSession();
  const [brandId, setBrandId] = useState(null);
  const [status, setStatus] = useState('active');
  const [form, setForm] = useState(false);
  const brands = useLoad(() => api.get('/sponsors', { mine: true, limit: 50 }), []);
  const mine = (brands.data ?? []).filter((b) => ['manager', 'finance', 'approver', 'auditor', 'admin'].includes(b.my_role));
  const brand = mine.find((b) => b.id === brandId) ?? mine[0];
  const list = useLoad(() => (brand ? api.get('/sponsorship-budgets', { sponsor_id: brand.id, status, limit: 100 }) : Promise.resolve([])), [brand?.id, status]);
  const events = useLoad(() => api.get('/events', { limit: 50 }).catch(() => []), []);
  const may = brand && MAY_EDIT.includes(brand.my_role);
  const byId = Object.fromEntries((list.data ?? []).map((b) => [b.id, b]));
  return (
    <Screen onRefresh={() => { list.reload(); brands.reload(); }} refreshing={list.loading && !!list.data}>
      <H1>Budgets</H1>
      <T size={13} color={c.mute}>What your brand has authorized to reserve and commit. Offers that are only proposed are shown as planned — they are never money used or received.</T>
      {brands.error ? <LoadError error={brands.error} onRetry={brands.reload} /> : brands.loading && !brands.data ? <Loading /> : !mine.length ? (
        <Empty emoji="🏷️" title="No brand budgets" sub="Budgets belong to a sponsor brand. Managers, finance, approvers and auditors of a brand see them here." />
      ) : (
        <>
          {mine.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{mine.map((b) => <Chip key={b.id} label={`${b.emoji ?? ''} ${b.name}`.trim()} active={b.id === brand.id} onPress={() => setBrandId(b.id)} />)}</View> : <T weight="800">{brand.emoji} {brand.name}</T>}
          {may ? <Btn small title="New budget" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm(true)} accessibilityLabel="Authorize a new budget" /> : <T size={12} color={c.mute}>Your role ({brand.my_role}) can read budgets; managers and finance authorize them.</T>}
          <BudgetCoverage sponsorId={brand.id} may={may} refreshKey={`${form}-${list.data?.length}`} onLinked={list.reload} />
          <Seg options={[{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }]} value={status} onChange={setStatus} color={c.pink} />
          {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : list.data?.length ? list.data.map((b) => (
            <Card key={b.id} onPress={() => push('SponsorBudget', { id: b.id })} accessibilityLabel={`${b.name}, ${KIND[b.kind]} budget, ${fmt(b.available_cents, b.currency)} available of ${fmt(b.authorized_cents, b.currency)}. Open budget`}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <T weight="900" style={{ flex: 1 }}>{b.name}</T>
                <Tag label={KIND[b.kind] + (b.fiscal_year ? ` ${b.fiscal_year}` : '')} color={KIND_TONE[b.kind]} />
              </View>
              <T size={12} color={c.mute}>{b.code} · {b.parent_id && byId[b.parent_id] ? `Part of ${byId[b.parent_id].name} · ` : ''}{b.fx_policy === 'explicit' ? 'Other currencies at a sourced rate' : `${b.currency} only`}{b.approval_over_cents != null ? ` · approval above ${fmt(b.approval_over_cents, b.currency)}` : ''}</T>
              <BudgetBar b={b} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <T size={13} weight="800">{fmt(b.available_cents, b.currency)} available</T>
                <T size={12} color={c.mute}>of {fmt(b.authorized_cents, b.currency)} · {fmt(b.committed_cents, b.currency)} committed · {fmt(b.reserved_cents, b.currency)} reserved{b.planned_cents ? ` · ${fmt(b.planned_cents, b.currency)} planned` : ''}</T>
              </View>
              {b.over_committed ? <Banner tone={c.redSoft}>Committed and reserved money is above the authorized amount.</Banner> : null}
            </Card>
          )) : <Empty emoji="🧮" title={`No ${status} budgets`} sub={may ? 'Authorize a budget for a year, a program, a department or an event.' : 'Budgets of this brand appear here.'} />}
        </>
      )}
      <BudgetWizard visible={form} onClose={() => setForm(false)} brands={mine.filter((b) => MAY_EDIT.includes(b.my_role))} brand={brand} events={events.data ?? []}
        onCreated={(b, { failed }) => { list.reload(); push('SponsorBudget', { id: b.id }); toast(failed.length ? `Budget authorized — ${failed.length} file${failed.length === 1 ? '' : 's'} could not be uploaded; add ${failed.length === 1 ? 'it' : 'them'} from the budget` : 'Budget authorized'); }} />
    </Screen>
  );
}

const REF_KIND = { approval: 'Approval', board_minutes: 'Board minutes', forecast: 'Forecast', purchase_order: 'Purchase order', contract: 'Contract', policy: 'Policy', other: 'Other' };
/** One budget: balances, commitments, children, linked programs and sourced FX rates. */
export function SponsorBudget({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const [form, setForm] = useState(null); // 'edit' | 'rate' | 'ref' | { reject }
  const [docs, setDocs] = useState(false);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const bud = useLoad(() => api.get(`/sponsorship-budgets/${id}`), [id]);
  const b = bud.data;
  const reloadAll = () => { bud.reload(); setTick((x) => x + 1); };
  const act = async (fn, m) => { try { await fn(); if (m) toast(m); setStale(false); reloadAll(); } catch (e) { toast(explain(e)); if (e.status === 409) { setStale(true); reloadAll(); } } };
  if (bud.loading && !b) return <Screen><Loading /></Screen>;
  if (bud.error) return <Screen><LoadError error={bud.error} onRetry={bud.reload} /></Screen>;
  const may = b.can.includes('budget'), mayApprove = b.can.includes('budget_approve');
  const active = b.status === 'active';
  const download = async () => {
    try {
      const r = await api.get(`/sponsorship-budgets/${b.id}/export`);
      if (Platform.OS === 'web' && typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); toast('Export downloaded'); } else toast(`${r.rows} rows exported`);
    } catch (e) { toast(explain(e)); }
  };
  const ratesNow = b.fx_rates.filter((r) => !r.superseded_at);
  return (
    <Screen onRefresh={reloadAll} refreshing={bud.loading && !!b}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><H1 style={{ flex: 1 }}>{b.name}</H1><Tag label={active ? KIND[b.kind] + (b.fiscal_year ? ` ${b.fiscal_year}` : '') : 'Archived'} color={active ? KIND_TONE[b.kind] : c.paper} /></View>
      {stale ? <Banner action="Dismiss" onAction={() => setStale(false)}>Someone else changed this budget while you were working. The latest version is shown now — review it and try again.</Banner> : null}
      <T size={12} color={c.mute}><T size={12} weight="800" color={c.ink}>{b.code}</T> · {b.sponsor_name} · you: {b.my_role}{b.parent ? ` · part of ${b.parent.name}` : ''}{b.event ? ` · for ${b.event.name}` : ''}{b.department ? ` · ${b.department.name}` : ''}</T>
      <Card>
        <T weight="900">{fmt(b.available_cents, b.currency)} available</T>
        <BudgetBar b={b} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <Figure label="Authorized" value={fmt(b.authorized_cents, b.currency)} />
          <Figure label="Allocated to children" value={fmt(b.allocated_cents, b.currency)} />
          <Figure label="Reserved" value={fmt(b.reserved_cents, b.currency)} tone={c.sunSoft} note="held for awards not yet accepted" />
          <Figure label="Committed" value={fmt(b.committed_cents, b.currency)} tone={c.pinkSoft} note="accepted agreements" />
          <Figure label="Paid" value={fmt(b.paid_cents, b.currency)} tone={c.limeSoft} note={b.reported_unverified_cents ? `${fmt(b.reported_unverified_cents, b.currency)} reported, not confirmed` : 'confirmed by the recipient'} />
          <Figure label="Refunded" value={fmt(b.refunded_cents, b.currency)} note="confirmed payments later reversed" />
          <Figure label="Still to pay" value={fmt(b.outstanding_cents, b.currency)} note="committed minus paid" />
          <Figure label="Planned" value={fmt(b.planned_cents, b.currency)} tone={c.violetSoft} note="offers not yet accepted — not used, not income" />
        </View>
        {b.over_committed ? <Banner tone={c.redSoft}>Committed and reserved money is above what is authorized.</Banner> : null}
        <T size={12} color={c.mute} style={{ marginTop: 8 }}>{b.approval_over_cents != null ? `Offers and awards above ${fmt(b.approval_over_cents, b.currency)} need a second approver. ` : 'No approval threshold. '}{b.fx_policy === 'explicit' ? 'Other currencies count only at the sourced rates below.' : `Only ${b.currency} counts against this budget.`}</T>
        {may && active ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn small title="Edit" color={c.violet} onPress={() => setForm('edit')} accessibilityLabel="Edit this budget" />
            {b.can.includes('export') ? <Btn small title="Export (CSV)" color={c.paper} ink={c.ink} onPress={download} /> : null}
            <Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsorship-budgets/${b.id}`, { version: b.row_version, status: 'archived' }), 'Archived — kept on record')} accessibilityLabel="Archive this budget" />
          </View>
        ) : b.can.includes('export') ? <Btn small title="Export (CSV)" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={download} /> : <T size={12} color={c.mute} style={{ marginTop: 8 }}>Your role can read this budget; managers and finance change it.</T>}
      </Card>

      {b.notes || b.basis ? (
        <Section title="Why this amount" color={c.violet}>
          {b.notes ? <T size={13}>{b.notes}</T> : null}
          {b.basis ? <Card onPress={() => push('SponsorBudget', { id: b.basis.id })} accessibilityLabel={`Built on ${b.basis.name}. Open budget`}><T size={12} color={c.mute}>Built on an earlier budget</T><T weight="900">{b.basis.name}{b.basis.fiscal_year ? ` · ${b.basis.fiscal_year}` : ''}</T></Card> : null}
        </Section>
      ) : null}

      <Section title="References and documents" color={c.cyan} action={may && active ? '+ Reference' : undefined} onAction={() => setForm('ref')}>
        <T size={12} color={c.mute}>Where the authority for this budget is recorded. Files are encrypted and open only to the people who can see this budget; removing a reference or file only hides it.</T>
        {b.references.length ? b.references.map((r) => (
          <Card key={r.id} pad={12}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{r.title}</T><Tag label={REF_KIND[r.kind] ?? r.kind} color={c.paper} /></View>
            <T size={12} color={c.mute}>{r.ref_no ? `${r.ref_no} · ` : ''}added by {r.added_by} · {day(r.created_at)}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              {r.url ? <Btn small title="Open link" color={c.violet} onPress={() => Linking.openURL(r.url)} accessibilityLabel={`Open ${r.title}`} /> : null}
              {may && active ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/sponsorship-budgets/${b.id}/references/${r.id}`), 'Reference removed — kept on record')} accessibilityLabel={`Remove ${r.title}`} /> : null}
            </View>
          </Card>
        )) : <Empty emoji="📎" title="No references yet" sub={may && active ? 'Add the approval memo, board minutes, forecast or purchase order behind this budget.' : 'References appear here once a manager adds them.'} />}
        <Btn small title="Documents" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setDocs(true)} accessibilityLabel="Open the documents folder of this budget" />
      </Section>

      <Section title="Follow the money" color={c.pink}>
        <BudgetTrace budget={b} tick={tick} mayApprove={mayApprove}
          onApprove={(r) => act(() => api.post(`/sponsorships/${r.id}/budget-approval`, { decision: 'approve' }), 'Approved — the recipient can now see the offer')}
          onReject={(r) => setForm({ reject: r })} />
      </Section>

      {b.children.length ? (
        <Section title="Child budgets" color={c.violet}>
          {b.children.map((k) => (
            <Card key={k.id} onPress={() => push('SponsorBudget', { id: k.id })} accessibilityLabel={`${k.name}, ${fmt(k.available_cents, k.currency)} available. Open budget`}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{k.name}</T><Tag label={KIND[k.kind]} color={KIND_TONE[k.kind]} /></View>
              <BudgetBar b={k} />
              <T size={12} color={c.mute}>{fmt(k.available_cents, k.currency)} available of {fmt(k.authorized_cents, k.currency)}</T>
            </Card>
          ))}
        </Section>
      ) : null}

      <Section title="Programs on this budget" color={c.mint} action={may && active && b.kind !== 'event' ? '+ Link programs' : undefined} onAction={() => setForm('programs')}>
        {b.programs.length ? b.programs.map((p) => (
          <Card key={p.id} onPress={() => push('SponsorProgram', { id: p.id })} accessibilityLabel={`${p.name}, ${p.status}. Open program`}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{p.name}</T><Tag label={p.status} color={c.paper} /></View>
            <T size={12} color={c.mute}>Program budget {fmt(Number(p.budget_cents), p.currency)}</T>
          </Card>
        )) : <Empty emoji="🎯" title="No program linked" sub={b.kind === 'event' ? 'An event budget funds one event, not programs.' : may && active ? `Link the programs whose awards should draw on ${b.code}; their agreements and payments are then traced here.` : 'Programs linked to this budget appear here.'} />}
      </Section>

      {b.fx_policy === 'explicit' ? (
        <Section title="Sourced FX rates" color={c.sun} action={may && active ? '+ Rate' : undefined} onAction={() => setForm('rate')}>
          <T size={12} color={c.mute}>A new rate applies to future commitments only; what is already reserved or committed keeps the rate it was made at.</T>
          {ratesNow.length ? ratesNow.map((r) => (
            <Card key={r.id}><T weight="900">1 {r.currency} = {Number(r.rate)} {b.currency}</T><T size={12} color={c.mute}>{r.source} · as of {day(r.as_of)}{r.source_ref ? ` · ${r.source_ref}` : ''}</T></Card>
          )) : <Empty emoji="💱" title="No rates yet" sub="Without a rate, only the budget currency can be committed." />}
          {b.fx_rates.length > ratesNow.length ? <T size={12} color={c.mute}>{b.fx_rates.length - ratesNow.length} earlier rate{b.fx_rates.length - ratesNow.length === 1 ? '' : 's'} kept on record.</T> : null}
        </Section>
      ) : null}

      <Section title="History" color={c.cyan}>
        {b.history.map((h) => <T key={h.id} size={12} color={c.mute}>{stamp(h.created_at)} · {h.kind.replace(/_/g, ' ')}{h.actor ? ` · ${h.actor}` : ''}</T>)}
      </Section>

      <FormSheet visible={form === 'edit'} onClose={() => setForm(null)} title="Edit budget" fields={editFields}
        initial={{ ...b }}
        onSubmit={async (v) => { await api.patch(`/sponsorship-budgets/${b.id}`, { version: b.row_version, name: v.name, notes: v.notes ?? null, authorized_cents: v.authorized_cents, approval_over_cents: v.approval_over_cents ?? null, fx_policy: v.fx_policy }); reloadAll(); return 'Budget saved'; }} />
      <LinkProgramsSheet visible={form === 'programs'} onClose={() => setForm(null)} budget={b} onDone={reloadAll} />
      <FormSheet visible={form === 'ref'} onClose={() => setForm(null)} title="Add a reference" submitLabel="Add reference"
        fields={[
          { key: 'kind', label: 'What is it?', type: 'chips', options: Object.entries(REF_KIND).map(([value, label]) => ({ value, label })), default: 'approval' },
          { key: 'title', label: 'Title' },
          { key: 'url', label: 'Link', optional: true, input: 'url', hint: 'An https link to the document. Give a link, a reference number, or both.' },
          { key: 'ref_no', label: 'Reference number', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/sponsorship-budgets/${b.id}/references`, v); reloadAll(); return 'Reference added'; }} />
      {docs ? <DocumentsSheet subject={{ subject_type: 'budget', subject_id: b.id }} canEdit={may} title="Budget documents" kinds={['approval', 'forecast', 'contract', 'invoice', 'report', 'other']} onClose={() => setDocs(false)}
        blurb="PDF or photo, up to 10 MB each. Files are encrypted on the server and open only to the people who can see this budget; managers and finance add and hide them. Removing one only hides it." /> : null}
      <FormSheet visible={form === 'rate'} onClose={() => setForm(null)} title="Record an FX rate" submitLabel="Save rate"
        fields={[
          { key: 'currency', label: 'Currency to convert from', type: 'currency' },
          { key: 'rate', label: `Rate (1 unit = how many ${b.currency})`, type: 'number', input: 'decimal' },
          { key: 'source', label: 'Source of the rate', hint: 'Who published it, e.g. “ECB reference rate” or “Treasury memo”.' },
          { key: 'source_ref', label: 'Link to the source', optional: true, input: 'url' },
          { key: 'as_of', label: 'Rate as of', type: 'date' },
        ]}
        onSubmit={async (v) => { await api.post(`/sponsorship-budgets/${b.id}/fx-rates`, { ...v, rate: Number(v.rate) }); reloadAll(); return 'Rate recorded'; }} />
      <FormSheet visible={!!form?.reject} onClose={() => setForm(null)} title="Reject this offer" submitLabel="Reject and withdraw"
        fields={[{ key: 'note', label: 'Reason', type: 'multiline', hint: 'Shown to your team. The recipient never sees the offer.' }]}
        onSubmit={async (v) => { await api.post(`/sponsorships/${form.reject.id}/budget-approval`, { decision: 'reject', note: v.note }); reloadAll(); return 'Offer rejected and withdrawn'; }} />
    </Screen>
  );
}

/** Program detail section: which budget this program's awards draw on. */
export function ProgramBudget({ program: p, may, onChanged }) {
  const { toast } = useSession();
  const { push } = useNav();
  const budgets = useLoad(() => api.get('/sponsorship-budgets', { sponsor_id: p.sponsor_id, status: 'active', limit: 100 }).catch(() => []), [p.sponsor_id, p.budget_id]);
  const linked = (budgets.data ?? []).find((b) => b.id === p.budget_id);
  const choices = (budgets.data ?? []).filter((b) => b.kind !== 'event' && b.id !== p.budget_id);
  const link = async (budgetId) => { try { await api.post(`/sponsorship-programs/${p.id}/budget`, { budget_id: budgetId, version: p.row_version }); toast(budgetId ? 'Awards now draw on this budget' : 'Program unlinked'); onChanged?.(); } catch (e) { toast(explain(e)); onChanged?.(); } };
  return (
    <Section title="Budget" color={c.sun}>
      {linked ? (
        <Card onPress={() => push('SponsorBudget', { id: linked.id })} accessibilityLabel={`${linked.name}, ${fmt(linked.available_cents, linked.currency)} available. Open budget`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{linked.name}</T><Tag label={linked.code} color={c.paper} /></View><BudgetBar b={linked} />
          <T size={12} color={c.mute}>{fmt(linked.available_cents, linked.currency)} available of {fmt(linked.authorized_cents, linked.currency)} — every award reserves from here first.</T>
        </Card>
      ) : p.budget_id ? <T size={13} color={c.mute}>Linked to a budget you cannot see.</T> : <Banner tone={c.sunSoft}>This program’s spending is not on any budget. Link one so its awards, agreements and payments respect the brand’s authorized limits and are traced end to end.</Banner>}
      {may && ['draft', 'published'].includes(p.status) ? (
        <>
          {choices.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{choices.map((b) => <Chip key={b.id} label={`${p.budget_id ? 'Move to ' : 'Use '}${b.code} · ${b.name}`} onPress={() => link(b.id)} />)}</View> : !p.budget_id ? <T size={12} color={c.mute}>No budget to link yet — authorize one under Budgets.</T> : null}
          {p.budget_id ? <Btn small title="Unlink budget" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start' }} onPress={() => link(null)} /> : null}
        </>
      ) : null}
    </Section>
  );
}
