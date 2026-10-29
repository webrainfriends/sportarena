// Shared pieces of the representation screens (#484): labels from the published access matrix, status tags, the commission ladder, and the mandate terms
// form. One codebase for iOS, iPadOS, Android and web: only React Native primitives; nothing here knows a rule - the server is the source of truth.
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { Btn, Card, Chip, Empty, T, Tag } from './ui';
import { useLayout } from './layout';
import { FormSheet } from './FormSheet';
import { useSports } from './sportpicker';
import { c } from './theme';
import { moneyIn } from './vtime';

export const cash = (cents, cur) => moneyIn(Number(cents ?? 0), cur);
export const key = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const plainDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
export const when = (d) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const nice = (s) => String(s ?? '').replace(/_/g, ' ');
export const sentence = (s) => nice(s).replace(/^./, (x) => x.toUpperCase());
const dig = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
export const toMinor = (major, cur) => Math.round(Number(major) * 10 ** dig(cur));

/** The published vocabulary (purposes, data kinds, actions, what is never shared). Loaded once; it is the same text the API and MCP publish. */
let matrixCache = null;
export const useMatrix = () => useLoad(async () => (matrixCache ??= await api.get('/representation/matrix')), []);

export const say = (e) => (e?.details?.code === 'stale_version' ? 'This was changed somewhere else. Pull to reload, then try again.' : e?.details?.code === 'mandate_not_live' ? (REASON[e.details.reason] ?? e.message) : e?.message ?? 'Something went wrong');

export const STATUS = { draft: ['Draft', c.violetSoft], proposed: ['Waiting for signatures', c.sun], active: ['In force', c.mint], declined: ['Declined', c.pinkSoft], withdrawn: ['Withdrawn', c.violetSoft], revoked: ['Ended', c.pinkSoft], expired: ['Expired', c.violetSoft] };
export const REASON = {
  draft: 'Not agreed yet', proposed: 'Waiting for signatures', declined: 'Declined', withdrawn: 'Withdrawn', revoked: 'Ended', expired: 'Expired', no_version: 'No agreed version', not_started: 'Starts later',
  agent_suspended: 'Agent suspended', agent_unverified: 'Agent verification lapsed', licence_lapsed: 'Licence lapsed', guardian_consent_withdrawn: 'Guardian consent needed',
  purpose_not_in_mandate: 'Not part of this mandate', data_not_permitted: 'Not allowed by the athlete', action_not_permitted: 'Not allowed by the athlete', staff_not_allowed: 'Agency staff not allowed',
  no_grant: 'Not shared with you', conflict_open: 'Conflict to resolve first', recused: 'Stepped back', sport_not_in_mandate: 'Sport not in this mandate',
};
export const StatusTag = ({ status }) => { const [label, color] = STATUS[status] ?? [status, c.violetSoft]; return <Tag label={label} color={color} />; };
export const LiveTag = ({ m }) => (m.status !== 'active' ? <StatusTag status={m.status} /> : m.live ? <Tag label="Live now" color={c.mint} /> : <Tag label={REASON[m.not_live_reason] ?? 'Not live'} color={c.pinkSoft} />);
export const Note = ({ children, tone = c.sunSoft }) => <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 14, padding: 12 }}><T size={13} weight="600">{children}</T></View>;
export const Kv = ({ k, children }) => (
  <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.line }}>
    <T size={13} color={c.mute} style={{ width: 118 }}>{k}</T><View style={{ flex: 1 }}>{typeof children === 'string' ? <T size={14} weight="600">{children}</T> : children}</View>
  </View>
);

export const CHECKED = '✓';
/** What an agent may and may not do, in the words the server publishes: allowed items first, then what is never shared. */
export function AccessList({ version, matrix }) {
  if (!version || !matrix) return null;
  const row = (ok, text, k) => <View key={k} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}><T size={14} weight="800" color={ok ? c.mint : c.mute} style={{ width: 18 }}>{ok ? CHECKED : '–'}</T><T size={14} color={ok ? c.ink : c.mute} style={{ flex: 1 }}>{text}</T></View>;
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>May see</T>
      {Object.entries(matrix.data_access).map(([k, label]) => row(version.data_access.includes(k), label, k))}
      <T weight="800" size={13} style={{ marginTop: 8 }}>May do</T>
      {Object.entries(matrix.contact_actions).map(([k, label]) => row(version.contact_actions.includes(k), label, k))}
      {row(version.allow_staff, 'Agency staff may act for the agent', 'staff')}
      <T weight="800" size={13} style={{ marginTop: 8 }}>Never, under any mandate</T>
      {matrix.never_shared.map((x) => row(false, x, x))}
      {matrix.athlete_only.map((x) => row(false, `The agent cannot ${x}`, x))}
    </View>
  );
}

/** Owed, invoiced, reported by the payer, settled: each its own number, and "settled" only when the agent confirmed receipt. */
export function Ladder({ ladder, currency }) {
  const item = (label, v, hint) => <View key={label} style={{ minWidth: 120, flexGrow: 1 }}><T size={11} color={c.mute} weight="700">{label.toUpperCase()}</T><T weight="800" size={16}>{cash(v, currency)}</T>{hint ? <T size={11} color={c.mute}>{hint}</T> : null}</View>;
  const STAGE = { nothing_owed: 'Nothing owed yet', accruing: 'Accruing', invoiced: 'Invoiced', payment_reported: 'Payment reported - not yet confirmed', part_settled: 'Part settled', settled: 'Settled', credit: 'Credit' };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {item('Owed', ladder.owed_cents)}{item('Invoiced', ladder.invoiced_cents)}{item('Reported paid', ladder.reported_cents, 'by the payer')}{item('Settled', ladder.settled_cents, 'agent confirmed')}
      </View>
      <Tag label={STAGE[ladder.stage] ?? ladder.stage} color={ladder.stage === 'settled' ? c.mint : ladder.stage === 'payment_reported' ? c.sun : c.violetSoft} />
    </View>
  );
}


const yn = (b) => (b ? 'Yes' : 'No');
/** One field of a mandate's terms in words, for both the agreed terms and a change list. */
export function fmtField(field, v, { matrix, sports }) {
  if (v == null || (Array.isArray(v) && !v.length)) return 'none';
  if (field === 'sport_ids') return v.map((id) => sports.get(id)?.name ?? 'a sport').join(', ');
  if (field === 'purposes') return v.map((x) => matrix?.purposes[x] ?? nice(x)).join(' · ');
  if (field === 'data_access') return v.map((x) => matrix?.data_access[x] ?? nice(x)).join(' · ');
  if (field === 'contact_actions') return v.map((x) => matrix?.contact_actions[x] ?? nice(x)).join(' · ');
  if (field === 'territories') return v.includes('WW') ? 'Worldwide' : v.join(', ');
  if (field === 'starts_on' || field === 'ends_on') return plainDate(v);
  if (field === 'exclusive' || field === 'allow_staff') return yn(v);
  if (field === 'notice_days') return `${v} days`;
  if (field === 'licence_id') return 'a declared licence';
  return String(v);
}
/** The agreed (or proposed) terms of one mandate version, in words. */
export function TermsCard({ v, matrix, sports }) {
  const f = (field, val) => fmtField(field, val, { matrix, sports });
  return (
    <Card>
      <Kv k="Period">{`${plainDate(v.starts_on)} to ${plainDate(v.ends_on)}`}</Kv>
      <Kv k="Sports">{v.sports.map((x) => `${x.emoji} ${x.name}`).join(' · ')}</Kv>
      <Kv k="Territories">{f('territories', v.territories)}</Kv>
      <Kv k="Represents for">{f('purposes', v.purposes)}</Kv>
      <Kv k="Exclusive">{yn(v.exclusive)}</Kv>
      <Kv k="Notice">{v.notice_days != null ? `${v.notice_days} days${v.notice_terms_ref ? ` · ${v.notice_terms_ref}` : ''}` : 'Not stated'}</Kv>
      <Kv k="Commission">{v.commission_summary?.length ? <View style={{ gap: 4 }}>{v.commission_summary.map((t) => <T key={t.key} size={14} weight="600">{t.text}</T>)}</View> : 'None agreed'}</Kv>
    </Card>
  );
}
/** What a proposed version changes, in words (the server stores the raw difference). */
export function Changes({ changes, matrix, sports }) {
  if (!changes?.length) return null;
  return (
    <View style={{ gap: 4 }}>
      {changes.map((x) => (
        <T key={x.field} size={13}>• <T size={13} weight="700">{x.label}</T>: {x.field.startsWith('commission:') ? `${x.from ?? 'none'} → ${x.to ?? 'removed'}` : `${fmtField(x.field, x.from, { matrix, sports })} → ${fmtField(x.field, x.to, { matrix, sports })}`}</T>
      ))}
    </View>
  );
}

/** Id lookups for sports: the picker deals in slugs, the API in ids. */
export function useSportMaps() {
  const s = useSports();
  return useMemo(() => {
    const list = s.data ?? [];
    return { ready: !!list.length, slugToId: new Map(list.map((x) => [x.slug, x.id])), idToSlug: new Map(list.map((x) => [x.id, x.slug])), byId: new Map(list.map((x) => [x.id, x])) };
  }, [s.data]);
}

const BASIS = [{ value: 'none', label: 'No commission' }, { value: 'percentage', label: 'Percentage' }, { value: 'fixed', label: 'Fixed fee' }, { value: 'milestone', label: 'Milestones' }];

/** The form shows the first commission term; further terms (set through the API) are kept untouched. */
export function termsToForm(v, maps) {
  if (!v) return {};
  const t = v.commission?.[0];
  const cur = t?.currency;
  const major = (n) => (n == null ? '' : n);
  return {
    sports: (v.sport_ids ?? []).map((id) => maps.idToSlug.get(id)).filter(Boolean), worldwide: v.territories?.includes('WW'), countries: (v.territories ?? []).filter((x) => x !== 'WW'),
    purposes: v.purposes, exclusive: v.exclusive, starts_on: v.starts_on, ends_on: v.ends_on, notice_days: v.notice_days ?? 30, notice_terms_ref: v.notice_terms_ref ?? '',
    data_access: v.data_access, contact_actions: v.contact_actions, allow_staff: v.allow_staff, licence_id: v.licence_id ?? undefined,
    basis: t?.basis ?? 'none', applies_to: t?.applies_to ?? ['player_contract'], currency: cur, rate_pct: t?.rate_bp ? t.rate_bp / 100 : 10, calc_on: t?.calc_on ?? 'earned',
    fixed: major(t?.fixed_cents), threshold: major(t?.threshold_cents), cap: major(t?.cap_cents),
    m1_label: t?.milestones?.[0]?.label ?? '', m1_amount: major(t?.milestones?.[0]?.amount_cents), m2_label: t?.milestones?.[1]?.label ?? '', m2_amount: major(t?.milestones?.[1]?.amount_cents),
  };
}
const slugKey = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'milestone';
export function formToTerms(f, maps, keep = []) {
  const commission = [];
  if (f.basis && f.basis !== 'none') {
    const base = { key: keep[0]?.key ?? 'main', applies_to: f.applies_to, currency: f.currency, effective_from: f.starts_on, effective_to: f.ends_on, facts_until: keep[0]?.facts_until ?? null, cap_cents: f.cap ? f.cap : null, threshold_cents: f.threshold ? f.threshold : null };
    if (f.basis === 'percentage') commission.push({ ...base, basis: 'percentage', rate_bp: Math.round(f.rate_pct * 100), calc_on: f.calc_on });
    else if (f.basis === 'fixed') commission.push({ ...base, basis: 'fixed', fixed_cents: f.fixed });
    else commission.push({ ...base, basis: 'milestone', milestones: [[f.m1_label, f.m1_amount], [f.m2_label, f.m2_amount]].filter(([l, a]) => l && a).map(([label, amount_cents]) => ({ key: slugKey(label), label, amount_cents })) });
  }
  return {
    sport_ids: f.sports.map((s) => maps.slugToId.get(s)).filter(Boolean), territories: f.worldwide ? ['WW'] : f.countries, purposes: f.purposes, exclusive: !!f.exclusive, starts_on: f.starts_on, ends_on: f.ends_on,
    notice_days: f.notice_days, notice_terms_ref: f.notice_terms_ref || null, data_access: f.data_access ?? [], contact_actions: f.contact_actions ?? [], allow_staff: !!f.allow_staff, licence_id: f.licence_id ?? null,
    commission: [...commission, ...keep.slice(1)],
  };
}

/**
 * The mandate terms as one form, each answer with the right control: sports and countries are search-and-pick, dates are one calendar range, choices are chips and
 * switches, money is a currency amount, numbers are steppers. `agent` carries the verified licences to pick from and whether it is an agency.
 */
export function TermsSheet({ visible, onClose, title, submitLabel, version, agent, onSubmit, notice }) {
  const matrix = useMatrix();
  const maps = useSportMaps();
  if (!visible) return null;
  if (!matrix.data || !maps.ready) return null;
  const m = matrix.data;
  const opts = (o) => Object.entries(o).map(([value, label]) => ({ value, label }));
  const licences = (agent?.licences ?? []).filter((l) => l.standing === 'verified').map((l) => ({ value: l.id, label: `${l.issuing_body}${l.grade ? ` · ${l.grade}` : ''} · ${l.jurisdiction}` }));
  const percent = (f) => f.basis === 'percentage', fixed = (f) => f.basis === 'fixed', mile = (f) => f.basis === 'milestone', some = (f) => f.basis && f.basis !== 'none';
  const fields = [
    { type: 'section', label: 'Scope' },
    { key: 'sports', label: 'Sports', type: 'sports', hint: 'Every sport in the catalogue is available.' },
    { key: 'worldwide', label: 'Worldwide', type: 'switch', hint: 'Turn off to pick the countries this covers.' },
    { key: 'countries', label: 'Territories', type: 'countries', show: (f) => !f.worldwide },
    { key: 'purposes', label: 'What the agent may represent you for', type: 'multi', options: opts(m.purposes) },
    { key: 'exclusive', label: 'Exclusive', type: 'switch', hint: 'No other agent for the same sports, territories and purposes while this runs.' },
    { key: 'starts_on', toKey: 'ends_on', label: 'Period', type: 'daterange' },
    { key: 'notice_days', label: 'Notice to end it', type: 'stepper', min: 0, max: 365, step: 5, suffix: ' days' },
    { key: 'notice_terms_ref', label: 'Where the termination terms are written', type: 'text', optional: true, placeholder: 'e.g. Schedule 2, clause 9' },
    { type: 'section', label: 'What the agent may see and do' },
    { key: 'data_access', label: 'Information', type: 'multi', optional: true, options: opts(m.data_access), hint: 'Private items are shared one by one later. Never available: medical records, private coaching notes, family finances, passwords, unrelated messages.' },
    { key: 'contact_actions', label: 'Actions', type: 'multi', optional: true, options: opts(m.contact_actions), hint: `Accepting a position or offer, signing and approving a transfer always stay with the athlete${agent?.young ? ' and a guardian' : ''}.` },
    ...(agent?.kind === 'agency' ? [{ key: 'allow_staff', label: 'Agency staff may act', type: 'switch', hint: 'Staff act only with the permissions the agency gave them.' }] : []),
    ...(licences.length ? [{ key: 'licence_id', label: 'Licence this relies on', type: 'chips', optional: true, options: licences, hint: 'If it lapses, access stops until it is renewed.' }] : []),
    { type: 'section', label: 'Commission' },
    { key: 'basis', label: 'How the agent is paid', type: 'chips', options: BASIS },
    { key: 'applies_to', label: 'On which deals', type: 'multi', options: [{ value: 'player_contract', label: 'Player contracts' }, { value: 'sponsorship', label: 'Sponsorship' }], show: some },
    { key: 'currency', label: 'Currency', type: 'currency', show: some },
    { key: 'rate_pct', label: 'Percentage', type: 'stepper', min: 0.5, max: 50, step: 0.5, suffix: '%', show: percent },
    { key: 'calc_on', label: 'Calculated on', type: 'chips', options: [{ value: 'earned', label: 'Fees earned' }, { value: 'paid', label: 'Money actually paid' }], show: percent },
    { key: 'fixed', label: 'Fixed fee', type: 'money', currency: (f) => f.currency, show: fixed },
    { key: 'threshold', label: 'Only above', type: 'money', currency: (f) => f.currency, optional: true, show: percent, hint: 'Commission applies only to the part above this amount.' },
    { key: 'cap', label: 'At most', type: 'money', currency: (f) => f.currency, optional: true, show: some },
    { key: 'm1_label', label: 'First milestone', type: 'text', placeholder: 'e.g. Contract signed', show: mile },
    { key: 'm1_amount', label: 'Amount', type: 'money', currency: (f) => f.currency, show: mile },
    { key: 'm2_label', label: 'Second milestone', type: 'text', optional: true, show: mile },
    { key: 'm2_amount', label: 'Amount', type: 'money', currency: (f) => f.currency, optional: true, show: mile },
  ];
  const initial = { worldwide: true, notice_days: 30, basis: 'none', rate_pct: 10, calc_on: 'earned', applies_to: ['player_contract'], purposes: ['opportunity_outreach'], contact_actions: ['share_opportunities', 'track_pipeline'], data_access: ['public_passport', 'opportunity_applications'], ...termsToForm(version, maps) };
  return (
    <FormSheet visible onClose={onClose} title={title} fields={fields} initial={initial} submitLabel={submitLabel} notice={notice}
      onSubmit={(v) => onSubmit(formToTerms({ ...v, notice_days: v.notice_days }, maps, version?.commission ?? []))} />
  );
}

/** List + detail: side by side on tablets and desktops, one at a time on phones. */
export function Split({ list, detail, selected, emptyTitle, emptySub }) {
  const L = useLayout();
  if (L.width >= 900) return <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}><View style={{ width: 340, gap: 10 }}>{list}</View><View style={{ flex: 1, minWidth: 0 }}>{selected ? detail : <Empty emoji="🤝" title={emptyTitle} sub={emptySub} />}</View></View>;
  return selected ? detail : <View style={{ gap: 10 }}>{list}</View>;
}

export function Pills({ items, active, onChange }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{items.map(([k, label]) => <Chip key={k} label={label} active={active === k} onPress={() => onChange(k)} />)}</View>;
}
export { Btn, Card, Chip };
