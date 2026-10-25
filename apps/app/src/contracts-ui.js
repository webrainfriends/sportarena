// Shared pieces of the player-contract screens (#333): money formatting, the terms editor, the money ladder and change lists.
// One codebase for iOS, iPadOS, Android and web: only React Native primitives; files go through Share on native and a download on web.
import React from 'react';
import { Platform, Share, View } from 'react-native';
import { Btn, Card, Chip, Field, T, Tag } from './ui';
import { Counter, DateField, DateRangeField } from './pickers';
import { c } from './theme';
import { moneyIn } from './vtime';

export const cash = (cents, cur) => moneyIn(Number(cents ?? 0), cur);
export const key = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const exp = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
export const toMinor = (text, cur) => { const n = Number(String(text ?? '').replace(/,/g, '')); return Number.isFinite(n) && n >= 0 && String(text ?? '').trim() !== '' ? Math.round(n * 10 ** exp(cur)) : NaN; };
export const toMajorText = (minor, cur) => (minor == null ? '' : String(Number(minor) / 10 ** exp(cur)));
export const when = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const plainDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

export const STATUS = { draft: ['Draft', c.violetSoft], offered: ['Waiting for signatures', c.sun], active: ['Active', c.mint], completed: ['Completed', c.cyan], terminated: ['Ended early', c.pinkSoft], void: ['Void', c.violetSoft] };
export const VERSION_STATUS = { draft: 'Draft', proposed: 'Waiting for signatures', in_force: 'In force', superseded: 'Replaced', declined: 'Declined', withdrawn: 'Withdrawn', countered: 'Countered' };
export const PARTY = { player: 'the person', guardian: 'a guardian', team: 'the club', finance: 'finance' };
export const StatusTag = ({ status }) => { const [label, color] = STATUS[status] ?? [status, c.violetSoft]; return <Tag label={label} color={color} />; };

export const KINDS = [
  { value: 'appearance_fee', label: 'Appearance fee', basis: 'per game played', game: true },
  { value: 'start_bonus', label: 'Start bonus', basis: 'per game started', game: true },
  { value: 'goal_bonus', label: 'Goal bonus', basis: 'per goal', game: true },
  { value: 'win_bonus', label: 'Win bonus', basis: 'per win', game: true },
  { value: 'monthly', label: 'Monthly pay', basis: 'each month of the term' },
  { value: 'fixed', label: 'Fixed fee', basis: 'on a date', dated: true },
  { value: 'signing_fee', label: 'Signing fee', basis: 'on a date', dated: true },
  { value: 'retention', label: 'Retention bonus', basis: 'if still under contract on the date', dated: true },
  { value: 'custom', label: 'Other payment', basis: 'on a date', dated: true },
];
const kindOf = (k) => KINDS.find((x) => x.value === k) ?? KINDS[0];
export const CATEGORIES = [{ value: 'travel', label: 'Travel' }, { value: 'meals', label: 'Meals' }, { value: 'kit', label: 'Kit' }, { value: 'accommodation', label: 'Stay' }, { value: 'other', label: 'Other' }];
export const AMEND_TYPES = [{ value: 'fee_change', label: 'Fee change' }, { value: 'term_extension', label: 'Term extension' }, { value: 'add_bonus', label: 'Add a bonus' }, { value: 'correction', label: 'Correction' }, { value: 'early_termination', label: 'Shorten the term' }, { value: 'pause', label: 'Pause' }];

/** Save text as a file: a download on the web, the share sheet on iOS, iPadOS and Android. */
export async function saveFile(name, text, type = 'text/csv') {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    return 'downloaded';
  }
  try { await Share.share({ title: name, message: text }); return 'shared'; } catch { return 'cancelled'; }
}

/** Open a protected receipt (PDF or photo): a new tab on the web, the share / open sheet on a phone or tablet. */
export async function openReceipt(path, name = 'receipt') {
  const { api } = await import('./api');
  const blob = await api.download(path);
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return;
  }
  const ext = /pdf/.test(blob.type) ? 'pdf' : /png/.test(blob.type) ? 'png' : /webp/.test(blob.type) ? 'webp' : /gif/.test(blob.type) ? 'gif' : 'jpg';
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`);
  file.create({ overwrite: true });
  file.write(new Uint8Array(await new Response(blob).arrayBuffer()));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open files from here. Open the receipt in the web app.');
  await Sharing.shareAsync(file.uri, { mimeType: blob.type, dialogTitle: name });
}

// ------------------------------------------------------------------ terms form state
export function termsToForm(t, cur) {
  return {
    starts_on: t?.starts_on, ends_on: t?.ends_on,
    expected_games: t?.expected_games ?? 0, withholding_pct: (t?.withholding_bp ?? 0) / 100, pay_terms_days: t?.pay_terms_days ?? 7,
    expense_cap: t?.expense_cap_cents == null ? '' : toMajorText(t.expense_cap_cents, cur),
    components: (t?.components ?? [{ kind: 'appearance_fee', amount_cents: 0 }]).map((x, n) => ({ id: `${n}-${x.key ?? x.kind}`, key: x.key, kind: x.kind, amount: x.amount_cents ? toMajorText(x.amount_cents, cur) : '', due_on: x.due_on })),
  };
}
export function formToTerms(f, cur) {
  if (!f.starts_on || !f.ends_on) throw new Error('Pick the start and end dates of the contract');
  if (!f.components.length) throw new Error('Add at least one payment');
  const components = f.components.map((x) => {
    const amount = toMinor(x.amount, cur);
    if (!(amount > 0)) throw new Error(`${kindOf(x.kind).label}: enter an amount`);
    if (kindOf(x.kind).dated && !x.due_on) throw new Error(`${kindOf(x.kind).label}: pick the date it is due`);
    return { ...(x.key ? { key: x.key } : {}), kind: x.kind, amount_cents: amount, ...(kindOf(x.kind).dated ? { due_on: x.due_on } : {}) };
  });
  const cap = f.expense_cap === '' ? null : toMinor(f.expense_cap, cur);
  if (Number.isNaN(cap)) throw new Error('Expense limit: enter an amount or leave it empty');
  return { starts_on: f.starts_on, ends_on: f.ends_on, currency: cur, components, expected_games: f.expected_games, withholding_bp: Math.round(f.withholding_pct * 100), expense_cap_cents: cap, pay_terms_days: f.pay_terms_days };
}

/** Pickers for every term: dates on the calendar, payments as a kind chip plus an amount, steppers for counts, a currency amount for the limit. */
export function TermsForm({ value: f, onChange, currency, hasTeam = true, lockStart }) {
  const set = (patch) => onChange({ ...f, ...patch });
  const setComp = (id, patch) => set({ components: f.components.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const kinds = KINDS.filter((k) => hasTeam || !k.game);
  return (
    <View style={{ gap: 14 }}>
      {lockStart
        ? <View><T size={12} weight="600" color={c.mute}>START DATE</T><T weight="700">{plainDate(f.starts_on)} (cannot move)</T></View>
        : null}
      {lockStart
        ? <DateField label="Contract ends" value={f.ends_on} onChange={(d) => set({ ends_on: d })} min={f.starts_on} />
        : <DateRangeField label="Contract term" from={f.starts_on} to={f.ends_on} onChange={(r) => set({ starts_on: r.from, ends_on: r.to })} />}
      <View style={{ gap: 8 }}>
        <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>PAYMENTS</T>
        {f.components.map((x) => {
          const k = kindOf(x.kind);
          return (
            <Card key={x.id} pad={12} color={c.violetSoft}>
              <View style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {kinds.map((o) => <Chip key={o.value} label={o.label} active={o.value === x.kind} onPress={() => setComp(x.id, { kind: o.value })} />)}
                </View>
                <T size={12} color={c.mute}>Paid {k.basis}</T>
                <Field label={`Amount (${currency})`} value={x.amount} onChangeText={(t) => setComp(x.id, { amount: t.replace(/[^0-9.,]/g, '') })} keyboardType="decimal-pad" placeholder="0" />
                {k.dated ? <DateField label="Due on" value={x.due_on} min={f.starts_on} max={f.ends_on} onChange={(d) => setComp(x.id, { due_on: d })} /> : null}
                {f.components.length > 1 ? <Btn small title="Remove this payment" color={c.paper} ink={c.ink} onPress={() => set({ components: f.components.filter((y) => y.id !== x.id) })} style={{ alignSelf: 'flex-start' }} /> : null}
              </View>
            </Card>
          );
        })}
        <Btn small title="+ Add a payment" color={c.paper} ink={c.ink} onPress={() => set({ components: [...f.components, { id: key(), kind: kinds.find((k) => !f.components.some((x) => x.kind === k.value))?.value ?? 'custom', amount: '' }] })} style={{ alignSelf: 'flex-start' }} />
      </View>
      {hasTeam ? <Counter label="Games the club expects (for the value only)" value={f.expected_games} onChange={(v) => set({ expected_games: v })} min={0} max={500} /> : null}
      <Counter label="Tax withheld by the club" value={f.withholding_pct} onChange={(v) => set({ withholding_pct: v })} min={0} max={50} step={0.5} suffix="%" />
      <T size={12} color={c.mute} style={{ marginTop: -8 }}>A rate the club enters. It is recorded on every payment line; SportArena does not calculate or file tax.</T>
      <Field label={`Expense limit per claim (${currency}, optional)`} value={f.expense_cap} onChangeText={(t) => set({ expense_cap: t.replace(/[^0-9.,]/g, '') })} keyboardType="decimal-pad" placeholder="No limit" />
      <Counter label="Days to pay after it is earned" value={f.pay_terms_days} onChange={(v) => set({ pay_terms_days: v })} min={0} max={120} />
    </View>
  );
}

// ------------------------------------------------------------------ display blocks
const Tile = ({ label, value, tone }) => (
  <View accessible accessibilityLabel={`${label}: ${value}`} style={{ flexGrow: 1, flexBasis: 140, minWidth: 130, backgroundColor: tone ?? c.violetSoft, borderRadius: 14, padding: 12 }}>
    <T size={10.5} weight="700" color={c.mute} style={{ letterSpacing: 0.8 }}>{label.toUpperCase()}</T>
    <T size={20} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
  </View>
);

/** Committed value, earned, withheld, expenses, paid, refunded and owed: always separate. Committed value is what could be paid, never income. */
export function Ladder({ ladder, currency, compact }) {
  const cur = currency;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {ladder.committed_cents != null ? <Tile label="Contract value" value={cash(ladder.committed_cents, cur)} /> : null}
        <Tile label="Earned" value={cash(ladder.earned_cents, cur)} />
        <Tile label="Tax withheld" value={cash(ladder.withheld_cents, cur)} tone={c.sunSoft} />
        <Tile label="Expenses" value={cash(ladder.expenses_cents, cur)} />
        <Tile label="Paid" value={cash(ladder.paid_cents, cur)} tone={c.limeSoft} />
        <Tile label="Owed now" value={cash(ladder.owed_cents, cur)} tone={Number(ladder.owed_cents) > 0 ? c.pinkSoft : c.violetSoft} />
      </View>
      {Number(ladder.adjustments_cents) || Number(ladder.refunded_cents) ? <T size={12} color={c.mute}>Adjustments {cash(ladder.adjustments_cents, cur)} · refunds received {cash(ladder.refunded_cents, cur)}</T> : null}
      {!compact ? <T size={12} color={c.mute}>Contract value is what the terms could pay. It is not income. Earned needs a played game or a due date on the record. Paid means the club recorded a transfer; SportArena does not hold this money.</T> : null}
      {Number(ladder.owed_cents) < 0 ? <T size={12} color={c.orange} weight="700">The balance is negative: this person owes the club. It is settled by the next payment or a refund, and nothing is paid out while it is negative.</T> : null}
    </View>
  );
}

const fmtChange = (ch, cur) => {
  const f = ch.field;
  const show = (v) => (v == null ? 'none' : f.startsWith('component:') || f === 'expense_cap_cents' ? cash(v, cur) : f === 'withholding_bp' ? `${v / 100}%` : f.endsWith('_on') ? plainDate(v) : String(v));
  if (ch.change === 'added') return `Added: ${show(ch.to)}`;
  if (ch.change === 'removed') return `Removed (was ${show(ch.from)})`;
  return `${show(ch.from)} → ${show(ch.to)}${ch.due_to && ch.due_to !== ch.due_from ? ` · due ${plainDate(ch.due_to)}` : ''}`;
};
export function Changes({ changes, currency }) {
  if (!changes?.length) return <T size={13} color={c.mute}>No changes.</T>;
  return (
    <View style={{ gap: 6 }}>
      {changes.map((ch) => (
        <View key={ch.field} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <T size={13} weight="700" style={{ flexShrink: 1 }}>{ch.label}</T>
          <T size={13} color={c.ink} style={{ fontVariant: ['tabular-nums'], flexShrink: 1 }}>{fmtChange(ch, currency)}</T>
        </View>
      ))}
    </View>
  );
}

export function Impact({ impact, currency }) {
  return (
    <Card pad={12} color={c.sunSoft}>
      <T weight="800" size={13}>What this does before anyone signs</T>
      <T size={13}>Contract value {cash(impact.value_before_cents, currency)} → {cash(impact.value_after_cents, currency)} ({impact.value_change_cents >= 0 ? '+' : '−'}{cash(Math.abs(impact.value_change_cents), currency)})</T>
      <T size={13}>{impact.upcoming_games_affected} upcoming game{impact.upcoming_games_affected === 1 ? '' : 's'} priced differently</T>
      {impact.retroactive ? <T size={13}>From a past date: {impact.earned_lines_repriced} game{impact.earned_lines_repriced === 1 ? '' : 's'} already earned would be adjusted by {cash(impact.adjustment_cents, currency)} in separate lines.</T> : null}
      <T size={13}>Paid lines changed: {impact.paid_entries_touched}. Earned and paid lines are never edited.</T>
      {impact.finance_approval_needed ? <T size={13} weight="700">A finance approver must also sign.</T> : null}
    </Card>
  );
}

export const Note = ({ children, tone = c.violetSoft }) => <Card pad={12} color={tone}><T size={13}>{children}</T></Card>;
