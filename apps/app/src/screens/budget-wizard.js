import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Field, Sheet, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { EntityPicker } from '../entity-picker';
import { CurrencyDropdown } from '../currency-dropdown';
import { moneyIn } from '../vtime';
import { c } from '../theme';
import { explain } from '../access';
import { pickDocument } from './insurance';
import { docMaxBytes, docMaxMb } from '../upload-limits';

// Guided flow to authorize a budget: what it is for -> how much (with what earlier budgets really used) -> controls -> supporting
// references and files -> review. The server still decides everything (limits, currency, parents); this only gathers and explains.
const KINDS = [
  { value: 'annual', label: 'A year', emoji: '📅', sub: 'The brand’s overall sponsorship envelope for a fiscal year.' },
  { value: 'program', label: 'A program', emoji: '🎯', sub: 'Funds the awards of one sponsorship program.' },
  { value: 'department', label: 'A department', emoji: '🏢', sub: 'One department’s share of the year.' },
  { value: 'event', label: 'An event', emoji: '🎟️', sub: 'Sponsorship for one specific event.' },
];
const KIND_NAME = { annual: 'annual', program: 'program', department: 'department', event: 'event' };
const REF_KINDS = [['approval', 'Approval'], ['board_minutes', 'Board minutes'], ['forecast', 'Forecast'], ['purchase_order', 'Purchase order'], ['contract', 'Contract'], ['policy', 'Policy'], ['other', 'Other']];
const FILE_KINDS = [['approval', 'Approval'], ['forecast', 'Forecast'], ['contract', 'Contract'], ['invoice', 'Invoice'], ['report', 'Report'], ['other', 'Other']];
const STEPS = ['Scope', 'Amount', 'Classification', 'Forecast', 'Controls', 'Support', 'Review'];
const COST_CENTRES = [
  ['coaching', 'Coaching'], ['medical', 'Medical'], ['facilities', 'Facilities'], ['travel', 'Travel'],
  ['equipment', 'Equipment'], ['scouting', 'Scouting'], ['marketing', 'Marketing'],
  ['admin', 'Admin'], ['it', 'IT'], ['legal', 'Legal'], ['other', 'Other'],
];
const ALERT_PCTS = [70, 80, 90, 100, 110];
const MAX_FILES = 10;

const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
/** Whole currency units typed by a person -> minor units, or null when it is not an amount. */
export const toMinor = (text, cur) => { const s = String(text ?? '').replace(/,/g, '').trim(); if (!s || !/^\d*\.?\d+$/.test(s) || (s.split('.')[1]?.length ?? 0) > digits(cur)) return null; return Math.round(Number(s) * 10 ** digits(cur)); };
const kb = (n) => (n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const label = (list, v) => list.find(([k]) => k === v)?.[1] ?? v;

const Block = ({ title, hint, children }) => (
  <View style={{ gap: 8 }}>
    <T weight="800" size={13}>{title}</T>
    {children}
    {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
  </View>
);

const Note = ({ tone = c.sunSoft, children }) => <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12 }}><T size={13}>{children}</T></View>;

const Progress = ({ step }) => (
  <View style={{ gap: 8 }} accessible accessibilityLabel={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {STEPS.map((s, i) => <View key={s} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: i <= step ? c.pink : c.line }} />)}
    </View>
    <T size={12} color={c.mute} weight="700">STEP {step + 1} OF {STEPS.length} · {STEPS[step].toUpperCase()}</T>
  </View>
);

/** What earlier budgets of the same kind authorized against what was really used, with one-tap ways to build on it. */
function Guidance({ g, loading, currency, kind, onUse }) {
  if (loading && !g) return <T size={13} color={c.mute}>Looking at your earlier budgets…</T>;
  if (!g) return null;
  const shownYear = g.year_authorized.length ? g.year_authorized.map((y) => moneyIn(y.authorized_cents, y.currency)).join(' + ') : null;
  return (
    <View style={{ gap: 10, backgroundColor: c.violetSoft, borderRadius: 14, padding: 14 }}>
      <T weight="800">Learn from earlier budgets</T>
      {g.existing ? <Note tone={c.redSoft}>“{g.existing.name}” is already an active budget for this scope. Open it instead of authorizing a second one.</Note> : null}
      {g.comparable.length ? g.comparable.map((b) => {
        const pct = b.utilisation_pct ?? 0;
        const tone = b.over_committed ? c.red : pct < 60 ? c.sun : c.lime;
        return (
          <View key={b.id} style={{ gap: 5 }} accessible accessibilityLabel={`${b.name}${b.fiscal_year ? ` ${b.fiscal_year}` : ''}: ${moneyIn(b.authorized_cents, b.currency)} authorized, ${moneyIn(b.used_cents, b.currency)} used${b.utilisation_pct != null ? `, ${b.utilisation_pct} percent` : ''}`}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <T weight="700" size={13} style={{ flex: 1 }} numberOfLines={1}>{b.name}</T>
              {b.status === 'archived' ? <Tag label="Archived" color={c.paper} /> : null}
              {b.currency !== currency ? <Tag label={b.currency} color={c.paper} /> : null}
            </View>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: c.paper, overflow: 'hidden' }}><View style={{ width: `${Math.min(100, pct)}%`, height: 8, backgroundColor: tone }} /></View>
            <T size={12} color={c.mute}>
              {moneyIn(b.used_cents, b.currency)} used of {moneyIn(b.authorized_cents, b.currency)}{b.utilisation_pct != null ? ` · ${b.utilisation_pct}%` : ''}
              {' · '}{b.over_committed ? `over by ${moneyIn(-b.unspent_cents, b.currency)}` : `${moneyIn(b.unspent_cents, b.currency)} unspent`}
            </T>
          </View>
        );
      }) : <T size={13} color={c.mute}>There is no earlier {kind} budget to compare with yet, so this one becomes the baseline for the next.</T>}
      {g.average_utilisation_pct != null ? <T size={12} color={c.mute}>On average, earlier {currency} budgets used {g.average_utilisation_pct}% of what was authorized. “Used” is committed plus reserved, including child budgets.</T> : null}
      {g.suggestion ? (
        <View style={{ gap: 6 }}>
          <T size={12} color={c.mute}>Based on “{g.suggestion.basis_name}”:</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Btn small title={`Match its actual use · ${moneyIn(g.suggestion.suggested_cents, g.suggestion.currency)}`} color={c.violet} onPress={() => onUse(g.suggestion.suggested_cents, g.suggestion.basis_budget_id)} />
            <Btn small title={`Match what it authorized · ${moneyIn(g.suggestion.last_authorized_cents, g.suggestion.currency)}`} color={c.paper} ink={c.ink} onPress={() => onUse(g.suggestion.last_authorized_cents, g.suggestion.basis_budget_id)} />
          </View>
        </View>
      ) : null}
      {shownYear ? <T size={12} color={c.mute}>Already authorized for this year across annual budgets: {shownYear}.</T> : null}
    </View>
  );
}

const Row = ({ k, v, onEdit }) => (
  <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line, alignItems: 'flex-start' }}>
    <T size={12} color={c.mute} weight="700" style={{ width: 118 }}>{k}</T>
    <T size={13} weight="700" style={{ flex: 1 }}>{v}</T>
    {onEdit ? <Pressable onPress={onEdit} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Change ${k}`}><T size={12} color={c.pink} weight="800">Change</T></Pressable> : null}
  </View>
);

/**
 * @param {{ visible: boolean, onClose: () => void, brands: any[], brand: any, events: any[], onCreated: (b: any, report: { failed: string[] }) => void }} p
 * `brands` are the brands the person may authorize for. The brand's budgets (possible parents) and departments load for the chosen brand.
 */
export function BudgetWizard({ visible, onClose, brands, brand, events, onCreated }) {
  const [step, setStep] = useState(0);
  const [v, setV] = useState({});
  const [refs, setRefs] = useState([]);
  const [files, setFiles] = useState([]);
  const [draft, setDraft] = useState({ kind: 'approval', title: '', url: '', ref_no: '' });
  const [fileKind, setFileKind] = useState('approval');
  const [basis, setBasis] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const set = (k, x) => { setErr(null); setV((p) => ({ ...p, [k]: x })); };

  useEffect(() => { if (visible) { setStep(0); setV({ sponsor_id: brand?.id, kind: 'annual', fiscal_year: new Date().getFullYear(), fx_policy: 'none', name: '' }); setRefs([]); setFiles([]); setBasis(null); setErr(null); setProgress(null); setDraft({ kind: 'approval', title: '', url: '', ref_no: '' }); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = brands.find((b) => b.id === v.sponsor_id) ?? brand;
  const budgetList = useLoad(() => (visible && v.sponsor_id ? api.get('/sponsorship-budgets', { sponsor_id: v.sponsor_id, status: 'active', limit: 100 }).catch(() => []) : Promise.resolve([])), [visible, v.sponsor_id]);
  const deptList = useLoad(() => (visible && chosen?.organisation_id ? api.get(`/organisations/${chosen.organisation_id}/departments`).catch(() => []) : Promise.resolve([])), [visible, chosen?.organisation_id]);
  const sponsorBudgets = (budgetList.data ?? []).filter((b) => b.kind !== 'event');
  const depts = deptList.data ?? [];
  const parent = sponsorBudgets.find((b) => b.id === v.parent_id) ?? null;
  const currency = parent?.currency ?? v.currency;
  const amount = toMinor(v.amount, currency);
  const threshold = v.threshold_on ? toMinor(v.threshold, currency) : null;
  const gq = { sponsor_id: v.sponsor_id, kind: v.kind, fiscal_year: v.kind === 'annual' || v.kind === 'department' ? v.fiscal_year : undefined, department_id: v.kind === 'department' ? v.department_id : undefined, event_id: v.kind === 'event' ? v.event_id : undefined, currency };
  const guide = useLoad(() => (visible && step === 1 && v.sponsor_id && v.kind && currency ? api.get('/budget-guidance', Object.fromEntries(Object.entries(gq).filter(([, x]) => x !== undefined && x !== ''))) : Promise.resolve(null)), [visible, step, v.sponsor_id, v.kind, v.fiscal_year, v.department_id, v.event_id, currency]);
  const pickedEvent = events.find((e) => e.id === v.event_id);

  const capexCents = toMinor(v.capex_amount, currency);

  const problem = (s) => {
    if (s === 0) {
      if (!v.sponsor_id) return 'Choose the brand.';
      if (v.kind === 'department' && !v.department_id) return 'Choose the department.';
      if (v.kind === 'event' && !v.event_id) return 'Choose the event.';
    }
    if (s === 1) {
      if ((v.name ?? '').trim().length < 2) return 'Give the budget a name (at least 2 characters).';
      if (!currency) return 'Choose a currency.';
      if (amount == null) return 'Enter the authorized amount.';
      if (parent && amount > parent.available_cents) return `${parent.name} has only ${moneyIn(parent.available_cents, parent.currency)} left to carve out.`;
    }
    if (s === 2) {
      if (v.grant_restricted && !(v.grant_source ?? '').trim()) return 'Enter the grant source or programme name.';
    }
    if (s === 4 && v.threshold_on && (threshold == null || threshold <= 0)) return 'Enter the amount above which a second approver is needed, or switch it off.';
    return null;
  };
  const go = (to) => { const p = to > step ? [...Array(to).keys()].map(problem).find(Boolean) : null; if (p) { setErr(p); return; } setErr(null); setStep(to); };

  const addRef = () => {
    const t = draft.title.trim(), url = draft.url.trim(), no = draft.ref_no.trim();
    if (t.length < 2) { setErr('Give the reference a title.'); return; }
    if (!url && !no) { setErr('Add a link or a reference number.'); return; }
    if (url && !/^https:\/\/\S+$/i.test(url)) { setErr('Links must start with https://'); return; }
    if (refs.length >= 10) { setErr('Add up to 10 references now; more can be added once the budget exists.'); return; }
    setRefs([...refs, { kind: draft.kind, title: t, ...(url ? { url } : {}), ...(no ? { ref_no: no } : {}) }]);
    setDraft({ ...draft, title: '', url: '', ref_no: '' }); setErr(null);
  };
  const addFile = async () => {
    if (files.length >= MAX_FILES) { setErr(`Attach up to ${MAX_FILES} files now; more can be added once the budget exists.`); return; }
    const f = await pickDocument();
    if (!f) return;
    if (f.blob.size > docMaxBytes()) { setErr(`Files can be up to ${docMaxMb()} MB.`); return; }
    setErr(null); setFiles((x) => [...x, { blob: f.blob, name: (f.name ?? 'Document').slice(0, 120), size: f.blob.size, kind: fileKind }]);
  };

  const submit = async () => {
    const bad = [0, 1, 2, 3, 4].map(problem).find(Boolean);
    if (bad) { setErr(bad); return; }
    setBusy(true); setErr(null);
    let b;
    try {
      const body = { sponsor_id: v.sponsor_id, kind: v.kind, name: v.name.trim(), currency, authorized_cents: amount, fx_policy: v.fx_policy };
      if (v.kind === 'annual' || v.kind === 'department') body.fiscal_year = v.fiscal_year;
      if (v.kind === 'department') body.department_id = v.department_id;
      if (v.kind === 'event') body.event_id = v.event_id;
      if (v.parent_id && v.kind !== 'annual') body.parent_id = v.parent_id;
      if (threshold) body.approval_over_cents = threshold;
      if ((v.notes ?? '').trim()) body.notes = v.notes.trim();
      if (basis) body.basis_budget_id = basis;
      if (refs.length) body.references = refs;
      // classification fields (step 2)
      if (v.cost_centre) body.cost_centre = v.cost_centre;
      if (capexCents && capexCents > 0) body.capex_cents = capexCents;
      if (v.grant_restricted) { body.grant_restricted = true; body.grant_source = (v.grant_source ?? '').trim(); }
      if (v.vat_exclusive) body.vat_exclusive = true;
      if ((v.alert_at_pcts ?? []).length) body.alert_at_pcts = v.alert_at_pcts;
      b = await api.post('/sponsorship-budgets', body);
      // create forecast if requested (step 3); failure is non-fatal
      if (v.forecast_now && v.forecast_total) {
        const fCents = toMinor(v.forecast_total, currency);
        if (fCents && fCents > 0) {
          try {
            await api.post(`/sponsorship-budgets/${b.id}/forecasts`, {
              name: `${v.name.trim()} — ${v.forecast_scenario ?? 'base'} forecast`,
              scenario: v.forecast_scenario ?? 'base',
              fiscal_year: v.fiscal_year ?? new Date().getFullYear(),
              spread_method: v.forecast_spread ?? 'even',
              total_projected_cents: fCents,
            });
          } catch { /* silent — budget was created */ }
        }
      }
    } catch (e) { setErr(explain(e)); setBusy(false); return; }
    // the budget exists now; a file that fails to upload never undoes it, it is reported so it can be added again
    const failed = [];
    for (let i = 0; i < files.length; i++) {
      setProgress(`Uploading file ${i + 1} of ${files.length}…`);
      try { await api.upload('/documents', files[i].blob, { subject_type: 'budget', subject_id: b.id, kind: files[i].kind, title: files[i].name }); } catch { failed.push(files[i].name); }
    }
    setBusy(false); setProgress(null); onClose(); onCreated(b, { failed });
  };

  const last = step === STEPS.length - 1;
  const footer = (
    <>
      {step > 0 ? <Btn small title="Back" color={c.paper} ink={c.ink} onPress={() => go(step - 1)} disabled={busy} /> : null}
      <View style={{ flex: 1 }} />
      {last ? <Btn title={busy ? (progress ?? 'Authorizing…') : 'Authorize budget'} onPress={submit} loading={busy} accessibilityLabel="Authorize budget" />
        : <Btn title="Continue" onPress={() => go(step + 1)} accessibilityLabel={`Continue to ${STEPS[step + 1]}`} />}
    </>
  );

  const kindOf = KINDS.find((k) => k.value === v.kind);
  return (
    <Sheet visible={visible} onClose={busy ? () => {} : onClose} title="New budget" footer={footer}>
      <Progress step={step} />

      {step === 0 ? (
        <>
          {brands.length > 1 ? <Block title="Brand"><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{brands.map((b) => <Chip key={b.id} label={`${b.emoji ?? ''} ${b.name}`.trim()} active={b.id === v.sponsor_id} onPress={() => setV((p) => ({ ...p, sponsor_id: b.id, parent_id: undefined }))} />)}</View></Block> : <T weight="800">{brand?.emoji} {brand?.name}</T>}
          <Block title="What is this budget for?">
            <View style={{ gap: 8 }}>
              {KINDS.map((k) => (
                <Pressable key={k.value} onPress={() => setV((p) => ({ ...p, kind: k.value, parent_id: k.value === 'annual' ? undefined : p.parent_id }))} accessibilityRole="radio" accessibilityState={{ selected: v.kind === k.value }} accessibilityLabel={`${k.label}. ${k.sub}`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 2, borderColor: v.kind === k.value ? c.pink : c.line, backgroundColor: v.kind === k.value ? c.pinkSoft : c.paper }}>
                  <T size={22}>{k.emoji}</T>
                  <View style={{ flex: 1 }}><T weight="800">{k.label}</T><T size={12} color={c.mute}>{k.sub}</T></View>
                  <T size={16} color={c.pink} weight="800">{v.kind === k.value ? '✓' : ''}</T>
                </Pressable>
              ))}
            </View>
          </Block>
          {v.kind === 'annual' || v.kind === 'department' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <T weight="800" size={13}>Fiscal year</T>
              <Counter value={v.fiscal_year} min={2000} max={2200} onChange={(x) => set('fiscal_year', x)} />
            </View>
          ) : null}
          {v.kind === 'department' ? (
            <Block title="Department" hint={depts.length ? undefined : 'This brand’s organisation has no departments yet. Add one in the organisation first.'}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{depts.map((d) => <Chip key={d.id} label={d.name} active={d.id === v.department_id} onPress={() => set('department_id', d.id)} />)}</View>
            </Block>
          ) : null}
          {v.kind === 'event' ? (
            <EntityPicker kind="event" label="Event" noun="event" options={events.map((e) => ({ id: e.id, label: e.name, sub: e.city ?? '' }))} value={pickedEvent ? [{ id: pickedEvent.id, label: pickedEvent.name }] : []} onChange={(l) => set('event_id', l[0]?.id)} />
          ) : null}
          {v.kind !== 'annual' && sponsorBudgets.length ? (
            <Block title="Carved out of (optional)" hint="A child budget is part of its parent, in the same currency, and can never exceed what the parent has left.">
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {sponsorBudgets.map((b) => <Chip key={b.id} label={`${b.name} · ${moneyIn(b.available_cents, b.currency)} free`} active={b.id === v.parent_id} onPress={() => set('parent_id', b.id === v.parent_id ? undefined : b.id)} />)}
              </View>
            </Block>
          ) : null}
        </>
      ) : null}

      {step === 1 ? (
        <>
          <Field label="Budget name" value={v.name} onChangeText={(x) => set('name', x)} maxLength={120} hint={`Shown on every award and agreement that draws on this ${KIND_NAME[v.kind]} budget.`} />
          <CurrencyDropdown label="Currency" value={currency} onChange={(x) => set('currency', x)} disabled={!!parent} hint={parent ? `Same currency as ${parent.name}. Currencies are never mixed inside a budget tree.` : 'Starts on your region’s currency. Change it if this budget is held in another.'} />
          <Block title={`Authorized amount${currency ? ` (${currency})` : ''}`} hint={parent ? `${parent.name} has ${moneyIn(parent.available_cents, parent.currency)} available to carve out.` : 'The most that can be reserved and committed against this budget.'}>
            <Field value={v.amount ?? ''} onChangeText={(x) => { setBasis(null); set('amount', x.replace(/[^0-9.,]/g, '')); }} keyboardType="decimal-pad" placeholder="0" accessibilityLabel="Authorized amount" />
            {amount != null && currency ? <T size={13} weight="800">{moneyIn(amount, currency)}</T> : null}
          </Block>
          <Guidance g={guide.data} loading={guide.loading} currency={currency} kind={KIND_NAME[v.kind]} onUse={(cents, id) => { setErr(null); setV((p) => ({ ...p, amount: String(cents / 10 ** digits(currency)) })); setBasis(id); }} />
          {basis ? <T size={12} color={c.mute}>This amount is built on an earlier budget; that link is kept with the new one.</T> : null}
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Block title="Cost centre" hint="Tag this budget to its function. Used in finance reports and cross-brand health views.">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {COST_CENTRES.map(([k, l]) => <Chip key={k} label={l} active={v.cost_centre === k} onPress={() => set('cost_centre', v.cost_centre === k ? undefined : k)} />)}
            </View>
          </Block>

          <Block title="Budget type" hint={`CapEx = assets that last more than one year. OpEx = everything else. ${currency ? `Authorized: ${moneyIn(amount ?? 0, currency)}.` : ''}`}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Chip label="All OpEx" active={!v.capex_split} onPress={() => set('capex_split', false)} />
              <Chip label="Split CapEx + OpEx" active={!!v.capex_split} onPress={() => set('capex_split', true)} />
            </View>
            {v.capex_split ? <Field label={`Capital spend (${currency})`} value={v.capex_amount ?? ''} onChangeText={(x) => set('capex_amount', x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder="0" hint={`The CapEx portion. OpEx = ${amount != null && capexCents != null ? moneyIn(amount - capexCents, currency) : 'remainder'}.`} accessibilityLabel="Capital expenditure amount" /> : null}
          </Block>

          <Block title="Grant funding" hint="Grants from governing bodies, foundations or government programmes often have restricted spend rules.">
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Chip label="Not a grant" active={!v.grant_restricted} onPress={() => set('grant_restricted', false)} />
              <Chip label="Restricted grant" active={!!v.grant_restricted} onPress={() => set('grant_restricted', true)} />
            </View>
            {v.grant_restricted ? <Field label="Grant source / programme" value={v.grant_source ?? ''} onChangeText={(x) => set('grant_source', x)} maxLength={200} placeholder="e.g. World Rugby Academy Fund" accessibilityLabel="Grant source" /> : null}
          </Block>

          <Block title="VAT treatment" hint="When amounts are entered VAT-exclusive, budget reports add it back to show the gross spend.">
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Chip label="Inclusive" active={!v.vat_exclusive} onPress={() => set('vat_exclusive', false)} />
              <Chip label="Exclusive (net)" active={!!v.vat_exclusive} onPress={() => set('vat_exclusive', true)} />
            </View>
          </Block>

          <Block title="Spend alerts" hint="You will be notified when utilisation crosses these thresholds. Finance managers can dismiss alerts.">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {ALERT_PCTS.map((p) => {
                const on = (v.alert_at_pcts ?? []).includes(p);
                return <Chip key={p} label={`${p}%`} active={on} onPress={() => { const cur = v.alert_at_pcts ?? []; set('alert_at_pcts', on ? cur.filter(x => x !== p) : [...cur, p].sort((a, b) => a - b)); }} />;
              })}
            </View>
          </Block>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Block title="Forecast (optional)" hint="Create a base spend forecast now to track projected vs actual monthly spend across the year. You can add or change forecasts any time.">
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Chip label="Set up later" active={!v.forecast_now} onPress={() => set('forecast_now', false)} />
              <Chip label="Set up now" active={!!v.forecast_now} onPress={() => set('forecast_now', true)} />
            </View>
          </Block>
          {v.forecast_now ? (
            <>
              <Block title="Scenario">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {[['base', '📊 Base'], ['best', '🟢 Best'], ['worst', '🔴 Worst']].map(([k, l]) => <Chip key={k} label={l} active={(v.forecast_scenario ?? 'base') === k} onPress={() => set('forecast_scenario', k)} />)}
                </View>
              </Block>
              <Block title="Spread method" hint="How the total projected amount is distributed across the 12 months.">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {[['even', 'Even'], ['s_curve', 'S-curve'], ['front', 'Front-loaded'], ['back', 'Back-loaded']].map(([k, l]) => <Chip key={k} label={l} active={(v.forecast_spread ?? 'even') === k} onPress={() => set('forecast_spread', k)} />)}
                </View>
              </Block>
              <Block title={`Total projected (${currency})`} hint="Can differ from authorized — forecasts track expected spend, which may be less or more.">
                <Field value={v.forecast_total ?? ''} onChangeText={(x) => set('forecast_total', x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder="0" accessibilityLabel="Total projected amount" />
              </Block>
            </>
          ) : (
            <Note>Forecasts can be created from the budget detail view after authorization.</Note>
          )}
        </>
      ) : null}

      {step === 4 ? (
        <>
          <Block title="Second approver" hint="Offers and awards above this amount wait for another person to approve. Leave it off for none.">
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Chip label="Not needed" active={!v.threshold_on} onPress={() => set('threshold_on', false)} />
              <Chip label="Above an amount" active={!!v.threshold_on} onPress={() => set('threshold_on', true)} />
            </View>
            {v.threshold_on ? <Field label={`Needed above (${currency})`} value={v.threshold ?? ''} onChangeText={(x) => set('threshold', x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder="0" accessibilityLabel="Approval threshold" /> : null}
          </Block>
          <Block title="Other currencies" hint="Different currencies are never added together unless you record a rate with its source.">
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Chip label="Not allowed" active={v.fx_policy === 'none'} onPress={() => set('fx_policy', 'none')} />
              <Chip label="Only at a sourced rate" active={v.fx_policy === 'explicit'} onPress={() => set('fx_policy', 'explicit')} />
            </View>
          </Block>
        </>
      ) : null}

      {step === 5 ? (
        <>
          <Field label="Why this amount? (optional)" value={v.notes} onChangeText={(x) => set('notes', x)} multiline maxLength={2000} hint="The rationale reviewers and auditors will read: what it funds and how the figure was reached." />
          <Block title="References" hint="Where the authority for this budget is recorded: an approval memo, board minutes, a forecast or a purchase order. Give a link, a reference number, or both.">
            {refs.map((r, i) => (
              <View key={`${r.title}-${i}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10, borderRadius: 12, backgroundColor: c.violetSoft }}>
                <View style={{ flex: 1 }}><T size={13} weight="800">{r.title}</T><T size={12} color={c.mute} numberOfLines={1}>{label(REF_KINDS, r.kind)}{r.ref_no ? ` · ${r.ref_no}` : ''}{r.url ? ` · ${r.url}` : ''}</T></View>
                <Pressable onPress={() => setRefs(refs.filter((_, j) => j !== i))} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${r.title}`}><T size={13} color={c.red} weight="800">Remove</T></Pressable>
              </View>
            ))}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{REF_KINDS.map(([k, l]) => <Chip key={k} label={l} active={draft.kind === k} onPress={() => setDraft({ ...draft, kind: k })} />)}</View>
            <Field value={draft.title} onChangeText={(x) => setDraft({ ...draft, title: x })} placeholder="Title" maxLength={160} accessibilityLabel="Reference title" />
            <Field value={draft.url} onChangeText={(x) => setDraft({ ...draft, url: x })} placeholder="Link (https://…)" keyboardType="url" accessibilityLabel="Reference link" />
            <Field value={draft.ref_no} onChangeText={(x) => setDraft({ ...draft, ref_no: x })} placeholder="Reference number" maxLength={80} accessibilityLabel="Reference number" />
            <Btn small title="Add reference" color={c.violet} onPress={addRef} style={{ alignSelf: 'flex-start' }} />
          </Block>
          <Block title="Files" hint={`PDF or photo, up to ${docMaxMb()} MB each. Files are encrypted on the server and open only to people who can see this budget.`}>
            {files.map((f, i) => (
              <View key={`${f.name}-${i}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10, borderRadius: 12, backgroundColor: c.violetSoft }}>
                <T size={20}>📎</T>
                <View style={{ flex: 1 }}><T size={13} weight="800" numberOfLines={1}>{f.name}</T><T size={12} color={c.mute}>{label(FILE_KINDS, f.kind)} · {kb(f.size)}</T></View>
                <Pressable onPress={() => setFiles(files.filter((_, j) => j !== i))} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${f.name}`}><T size={13} color={c.red} weight="800">Remove</T></Pressable>
              </View>
            ))}
            <T size={12} color={c.mute}>What kind of file is next?</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{FILE_KINDS.map(([k, l]) => <Chip key={k} label={l} active={fileKind === k} onPress={() => setFileKind(k)} />)}</View>
            <Btn small title="Choose a file" color={c.violet} onPress={addFile} style={{ alignSelf: 'flex-start' }} />
          </Block>
        </>
      ) : null}

      {step === 6 ? (
        <>
          <View>
            <Row k="Brand" v={brands.find((b) => b.id === v.sponsor_id)?.name ?? ''} onEdit={() => go(0)} />
            <Row k="For" v={`${kindOf?.label ?? ''}${v.kind === 'annual' || v.kind === 'department' ? ` · ${v.fiscal_year}` : ''}${v.kind === 'department' ? ` · ${depts.find((d) => d.id === v.department_id)?.name ?? ''}` : ''}${v.kind === 'event' ? ` · ${pickedEvent?.name ?? ''}` : ''}`} onEdit={() => go(0)} />
            {parent ? <Row k="Carved out of" v={parent.name} onEdit={() => go(0)} /> : null}
            <Row k="Name" v={v.name} onEdit={() => go(1)} />
            <Row k="Authorized" v={amount != null && currency ? moneyIn(amount, currency) : ''} onEdit={() => go(1)} />
            {v.cost_centre ? <Row k="Cost centre" v={COST_CENTRES.find(([k]) => k === v.cost_centre)?.[1] ?? v.cost_centre} onEdit={() => go(2)} /> : null}
            {v.capex_split && capexCents ? <Row k="CapEx" v={moneyIn(capexCents, currency)} onEdit={() => go(2)} /> : null}
            {v.grant_restricted ? <Row k="Grant" v={v.grant_source ?? ''} onEdit={() => go(2)} /> : null}
            {(v.alert_at_pcts ?? []).length ? <Row k="Alerts at" v={(v.alert_at_pcts).map(p => `${p}%`).join(', ')} onEdit={() => go(2)} /> : null}
            <Row k="Second approver" v={threshold ? `Above ${moneyIn(threshold, currency)}` : 'Not needed'} onEdit={() => go(4)} />
            <Row k="Other currencies" v={v.fx_policy === 'explicit' ? 'Only at a sourced rate' : 'Not allowed'} onEdit={() => go(4)} />
            {basis ? <Row k="Built on" v="An earlier budget" /> : null}
            {(v.notes ?? '').trim() ? <Row k="Rationale" v={v.notes.trim()} onEdit={() => go(5)} /> : null}
            <Row k="References" v={refs.length ? refs.map((r) => r.title).join(', ') : 'None'} onEdit={() => go(5)} />
            <Row k="Files" v={files.length ? files.map((f) => f.name).join(', ') : 'None'} onEdit={() => go(5)} />
          </View>
          <T size={12} color={c.mute}>Authorizing records who approved this and when. Nothing is deleted later: budgets are archived and keep their history.</T>
        </>
      ) : null}

      {err ? <Note tone={c.redSoft}>{err}</Note> : null}
    </Sheet>
  );
}
