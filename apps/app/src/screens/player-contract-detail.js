// One contract, for the person paid, their guardian and the club's managers: terms and versions, signatures, the money ladder and ledger,
// expenses, statements. Every action is an API capability (REST + MCP); this screen only calls them. The server decides who may do what and
// returns it in `permissions`, so the buttons shown here are never the only guard.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, Loading, Row, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField } from '../pickers';
import { pickDocument } from './insurance';
import { c } from '../theme';
import {
  AMEND_TYPES, CATEGORIES, Changes, Impact, KINDS, Ladder, Note, PARTY, StatusTag, TermsForm, VERSION_STATUS, cash, formToTerms, key, openReceipt, plainDate, saveFile, termsToForm, toMinor, when,
} from '../contracts-ui';

const TONE = { submitted: c.sun, approved: c.mint, declined: c.pinkSoft, reimbursed: c.mint, withdrawn: c.violetSoft };
const say = (e) => (e?.code === 'stale_version' || e?.details?.code === 'stale_version' ? 'Someone changed this while you were looking. The latest version is loaded; check it and try again.' : e?.message ?? 'Something went wrong');
const kindLabel = (k) => KINDS.find((x) => x.value === k)?.label ?? k;
const basisOf = (k) => KINDS.find((x) => x.value === k)?.basis ?? '';

function Terms({ v, cur }) {
  return (
    <Card>
      <T weight="800">Terms (version {v.version}{v.status === 'in_force' ? ', in force' : ''})</T>
      {v.components.map((x) => (
        <View key={x.key} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1 }}><T weight="700" size={14}>{x.label}</T><T size={12} color={c.mute}>{basisOf(x.kind)}{x.due_on ? ` · ${plainDate(x.due_on)}` : ''}</T></View>
          <T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{cash(x.amount_cents, cur)}</T>
        </View>
      ))}
      <View style={{ height: 1, backgroundColor: c.line, marginVertical: 4 }} />
      <T size={13}>Term: {plainDate(v.starts_on)} to {plainDate(v.ends_on)}{v.effective_from !== v.starts_on ? ` · this version applies from ${plainDate(v.effective_from)}` : ''}</T>
      <T size={13}>Paid {v.pay_terms_days} day{v.pay_terms_days === 1 ? '' : 's'} after it is earned · currency {cur}</T>
      <T size={13}>Tax withheld: {v.withholding_bp / 100}% · expense limit: {v.expense_cap_cents == null ? 'none' : `${cash(v.expense_cap_cents, cur)} per claim`}</T>
    </Card>
  );
}

function Readiness({ items, mine, onBank }) {
  const bank = items.find((x) => x.code === 'bank_account');
  return (
    <Card>
      <T weight="800">Ready to be paid?</T>
      {items.map((x) => (
        <View key={x.code} style={{ flexDirection: 'row', gap: 8 }}>
          <T color={x.ok ? c.lime : c.orange} weight="800">{x.ok ? '✓' : '•'}</T><T size={13} style={{ flex: 1 }}>{x.message}</T>
        </View>
      ))}
      {mine && bank && !bank.ok ? <Btn small title={bank.message.startsWith('No ') ? 'Add my bank account' : 'See my bank account'} onPress={onBank} color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 4 }} /> : null}
    </Card>
  );
}

function Versions({ k, onCompare }) {
  return (
    <Section title="Versions" color={c.cyan}>
      {[...k.versions].reverse().map((v) => (
        <Card key={v.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <T weight="800">Version {v.version}{v.kind === 'amendment' ? ' · amendment' : ''}</T>
            <Tag label={VERSION_STATUS[v.status] ?? v.status} color={v.status === 'in_force' ? c.mint : v.status === 'proposed' ? c.sun : c.violetSoft} />
          </View>
          <T size={12} color={c.mute}>{v.proposed_by_name ? `Proposed by ${v.proposed_by_name}` : ''}{v.proposed_at ? ` · ${when(v.proposed_at)}` : ''}{v.kind === 'amendment' ? ` · from ${plainDate(v.effective_from)}` : ''}{v.retroactive ? ' · from a past date' : ''}</T>
          {v.reason ? <T size={13}>{v.reason}</T> : null}
          {v.kind === 'amendment' ? <Changes changes={v.changes} currency={k.currency} /> : <T size={13} color={c.mute}>The first offer. Its terms are shown above.</T>}
          {v.signatures.map((s) => <T key={s.party} size={12} color={s.decision === 'signed' ? c.lime : c.red}>{s.decision === 'signed' ? '✓ Signed' : '✕ Declined'} for {PARTY[s.party]} by {s.signer}{s.signed_at ? ` · ${when(s.signed_at)}` : ''}{s.comment ? ` — ${s.comment}` : ''}</T>)}
          {v.waiting_for.length ? <T size={12} color={c.orange} weight="700">Waiting for {v.waiting_for.map((p) => PARTY[p]).join(' and ')}</T> : null}
          {v.status !== 'in_force' && k.in_force && v.version !== k.in_force.version ? <Btn small title={`Compare with version ${k.in_force.version}`} color={c.paper} ink={c.ink} onPress={() => onCompare(v)} style={{ alignSelf: 'flex-start' }} /> : null}
        </Card>
      ))}
    </Section>
  );
}

// ------------------------------------------------------------------ sheets
const signLabel = (k, parties) => (k.viewer_role === 'payee' ? 'Sign' : k.viewer_role === 'guardian' ? 'Sign as guardian' : `Sign for ${parties.map((p) => (p === 'team' ? 'the club' : p === 'finance' ? 'finance' : PARTY[p])).join(' and ')}`);
/** The version that governs a date: the highest version number whose effective date has arrived (the same rule the server applies). */
const versionOn = (k, date) => k.versions.filter((v) => (v.status === 'in_force' || v.status === 'superseded') && v.effective_from <= date).sort((a, b) => b.version - a.version)[0] ?? k.in_force;

function ReviewSheet({ k, v, canSign, onClose, onDone, onCounter }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const [decline, setDecline] = useState(false);
  const [comment, setComment] = useState('');
  const act = async (decision) => {
    setBusy(true);
    try { await api.post(`/contract-versions/${v.id}/decision`, { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) }); toast(decision === 'sign' ? 'Signed' : 'Declined'); onDone(); onClose(); }
    catch (e) { toast(say(e)); onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Review version ${v.version}`}
      footer={decline
        ? <><Btn title="Confirm decline" color={c.red} loading={busy} onPress={() => act('decline')} style={{ flex: 1 }} /><Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setDecline(false)} /></>
        : <><Btn title={signLabel(k, canSign)} loading={busy} onPress={() => act('sign')} style={{ flex: 1 }} /><Btn title="Decline" color={c.paper} ink={c.ink} onPress={() => setDecline(true)} /></>}>
      <T weight="800">{k.title}</T>
      <T size={13} color={c.mute}>{k.contract_no} · {k.payer.name} · {v.kind === 'amendment' ? `amendment from ${plainDate(v.effective_from)}` : 'first offer'}</T>
      {v.reason ? <Note>{v.reason}</Note> : null}
      {v.kind === 'amendment' ? <Changes changes={v.changes} currency={k.currency} /> : null}
      <Terms v={v} cur={k.currency} />
      <T size={12} color={c.mute}>By signing you agree to these terms. Earlier signed versions and anything already paid stay on record and are not changed.</T>
      {decline ? (
        <>
          <Field label="Why? (optional)" value={comment} onChangeText={setComment} multiline maxLength={500} />
          {k.status !== 'offered' ? <Btn small title="Propose different terms instead" color={c.violet} onPress={() => { onClose(); onCounter(); }} style={{ alignSelf: 'flex-start' }} /> : null}
        </>
      ) : <Field label="Add a comment (optional)" value={comment} onChangeText={setComment} multiline maxLength={500} />}
    </Sheet>
  );
}

function AmendSheet({ k, replace, onClose, onDone }) {
  const { toast, user } = useSession();
  const base = k.in_force;
  const [f, setF] = useState(() => termsToForm({ ...base, components: base.components }, k.currency));
  const [types, setTypes] = useState(['fee_change']);
  const [eff, setEff] = useState(base.effective_from > new Date().toISOString().slice(0, 10) ? base.effective_from : new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [pre, setPre] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const body = () => {
    if (!reason.trim()) throw new Error('Say why the terms change');
    return { base_version: base.version, terms: formToTerms({ ...f, starts_on: base.starts_on }, k.currency), effective_from: eff, amendment_types: types, reason: reason.trim() };
  };
  const preview = async () => { setBusy(true); setErr(null); try { setPre(await api.post(`/player-contracts/${k.id}/amendments/preview`, body())); } catch (e) { setPre(null); setErr(say(e)); } finally { setBusy(false); } };
  const send = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/player-contracts/${k.id}/amendments`, { ...body(), replace_pending: !!replace }); toast('Sent for signatures'); onDone(); onClose(); }
    catch (e) { setErr(say(e)); if (e?.details?.code === 'stale_version' || e?.code === 'stale_version') onDone(); } finally { setBusy(false); }
  };
  const toggle = (t) => setTypes((p) => (p.includes(t) ? (p.length > 1 ? p.filter((x) => x !== t) : p) : [...p, t]));
  return (
    <Sheet visible onClose={onClose} title={replace ? (k.pending?.proposed_by === user.id ? 'Replace your pending amendment' : 'Counter-offer') : k.permissions.manage_money ? 'Propose an amendment' : 'Ask for a change'}
      footer={<><Btn title="See the effect" color={c.paper} ink={c.ink} loading={busy} onPress={preview} style={{ flex: 1 }} /><Btn title={pre ? 'Send for signatures' : 'Send'} loading={busy} onPress={send} style={{ flex: 1 }} /></>}>
      <T size={13} color={c.mute}>Change what is different. Version {base.version} stays in force until every party signs the new one.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{AMEND_TYPES.map((t) => <Chip key={t.value} label={t.label} active={types.includes(t.value)} onPress={() => toggle(t.value)} />)}</View>
      <DateField label="Takes effect on" value={eff} min={base.starts_on} max={f.ends_on} onChange={setEff} hint="A date in the past re-prices games already earned with separate adjustment lines. Paid lines are never edited." />
      <TermsForm value={f} onChange={setF} currency={k.currency} hasTeam={!!k.team_id} lockStart />
      <Field label="Reason" value={reason} onChangeText={setReason} multiline maxLength={500} hint="Everyone who signs can read this." />
      {err ? <ErrorBox error={{ message: err }} /> : null}
      {pre ? (<><Changes changes={pre.changes} currency={k.currency} /><Impact impact={pre.impact} currency={k.currency} /></>) : null}
    </Sheet>
  );
}

function DraftSheet({ k, onClose, onDone }) {
  const { toast } = useSession();
  const v = k.versions[0];
  const [title, setTitle] = useState(k.title);
  const [f, setF] = useState(() => termsToForm(v, k.currency));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async (send) => {
    setBusy(true); setErr(null);
    try {
      const upd = await api.patch(`/player-contracts/${k.id}`, { row_version: k.row_version, title: title.trim() || k.title, terms: formToTerms(f, k.currency) });
      if (send) await api.post(`/player-contracts/${k.id}/send`, { row_version: upd.row_version });
      toast(send ? 'Sent to the person for signing' : 'Draft saved'); onDone(); onClose();
    } catch (e) { setErr(say(e)); onDone(); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Edit the draft" footer={<><Btn title="Save draft" color={c.paper} ink={c.ink} loading={busy} onPress={() => save(false)} style={{ flex: 1 }} /><Btn title="Send for signing" loading={busy} onPress={() => save(true)} style={{ flex: 1 }} /></>}>
      <Field label="Title" value={title} onChangeText={setTitle} maxLength={160} />
      <TermsForm value={f} onChange={setF} currency={k.currency} hasTeam={!!k.team_id} />
      {err ? <ErrorBox error={{ message: err }} /> : null}
      <T size={12} color={c.mute}>Once sent, the terms are frozen. Later changes are amendments that everyone signs.</T>
    </Sheet>
  );
}

function ExpenseSheet({ k, onClose, onDone }) {
  const { toast } = useSession();
  const [cat, setCat] = useState('travel');
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ck] = useState(key);
  const cap = versionOn(k, on)?.expense_cap_cents;
  const minor = toMinor(amount, k.currency);
  const over = cap != null && minor > cap;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (!(minor > 0)) throw new Error('Enter the amount you spent');
      const x = await api.post(`/player-contracts/${k.id}/expenses`, { category: cat, incurred_on: on, amount_cents: minor, ...(note.trim() ? { note: note.trim() } : {}), client_key: ck });
      if (file && !x.has_receipt) { try { await api.upload(`/player-contract-expenses/${x.id}/receipt`, file.blob); } catch (e) { toast(`Claim sent, but the receipt did not upload: ${e.message}`); } }
      toast('Expense sent to the club'); onDone(); onClose();
    } catch (e) { setErr(say(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Add an expense" footer={<Btn title="Send to the club" loading={busy} onPress={submit} style={{ flex: 1 }} />}>
      <T size={13} color={c.mute}>For {k.title}. The club approves it and pays it with your next payment.</T>
      <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>TYPE</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{CATEGORIES.map((x) => <Chip key={x.value} label={x.label} active={cat === x.value} onPress={() => setCat(x.value)} />)}</View></View>
      <DateField label="Date" value={on} min={k.versions[0]?.starts_on} max={new Date().toISOString().slice(0, 10)} onChange={setOn} />
      <Field label={`Amount (${k.currency})`} value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder="0" hint={cap == null ? 'No limit in your contract.' : over ? `Over the limit of ${cash(cap, k.currency)} per claim. You can still send it; it is marked "over limit" for the club.` : `Limit in your contract: ${cash(cap, k.currency)} per claim.`} />
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute}>RECEIPT (OPTIONAL)</T>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn small title={file ? 'Choose another' : 'Add a photo or PDF'} color={c.paper} ink={c.ink} onPress={async () => { try { const f = await pickDocument(); if (f) setFile(f); } catch (e) { toast(e.message); } }} />
          {file ? <Tag label={file.name ?? 'Attached'} color={c.mint} /> : null}
        </View>
      </View>
      <Field label="Note (optional)" value={note} onChangeText={setNote} multiline maxLength={500} />
      {err ? <ErrorBox error={{ message: err }} /> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ tabs
function Money({ k }) {
  const { toast } = useSession();
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState([]);
  const q = useLoad(() => api.get(`/player-contracts/${k.id}/ledger`, { limit: 25 }), [k.id, k.ladder.owed_cents, k.ladder.paid_cents]);
  const loadMore = async () => { try { const next = offset + 25; const r = await api.get(`/player-contracts/${k.id}/ledger`, { limit: 25, offset: next }); setMore((m) => [...m, ...r.entries]); setOffset(next); } catch (e) { toast(e.message); } };
  const exportCsv = async () => { try { const r = await api.get(`/player-contracts/${k.id}/ledger`, { format: 'csv' }); const how = await saveFile(r.filename, r.csv); toast(how === 'downloaded' ? `${r.rows} lines exported` : how === 'shared' ? 'Ready to share' : 'Cancelled'); } catch (e) { toast(e.message); } };
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const rows = [...q.data.entries, ...more];
  return (
    <>
      <Ladder ladder={k.ladder} currency={k.currency} />
      <Section title="Ledger" color={c.sun} action="Export CSV" onAction={exportCsv}>
        {rows.length ? rows.map((e) => (
          <Row key={e.id} title={e.label} sub={`${plainDate(e.occurred_on)} · ${e.kind}${e.reason ? ` · ${e.reason}` : ''}`}
            right={<T weight="800" color={Number(e.amount_cents) < 0 ? c.ink : c.lime} style={{ fontVariant: ['tabular-nums'] }}>{Number(e.amount_cents) < 0 ? '−' : '+'}{cash(Math.abs(Number(e.amount_cents)), e.currency)}</T>} />
        )) : <Empty emoji="🧾" title="Nothing earned yet" sub="Fees appear here when a game is played and verified, or a payment date arrives. An offer is not earnings." />}
        {rows.length >= 25 && rows.length % 25 === 0 ? <Btn small title="Load more" color={c.paper} ink={c.ink} onPress={loadMore} style={{ alignSelf: 'center' }} /> : null}
        <T size={12} color={c.mute}>Entries are never edited. A correction is a new line with its reason.</T>
      </Section>
    </>
  );
}

function Expenses({ k, onAdd, onChanged }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/player-contract-expenses', { contract_id: k.id, limit: 50 }), [k.id, k.expenses_waiting]);
  const [declining, setDeclining] = useState(null);
  const decide = async (x, decision, reason) => { try { await api.post(`/contract-expenses/${x.id}/decision`, { decision, row_version: x.row_version, ...(reason ? { reason } : {}) }); toast(decision === 'approve' ? 'Approved' : decision === 'withdraw' ? 'Withdrawn' : 'Declined'); q.reload(); onChanged(); } catch (e) { toast(say(e)); q.reload(); } };
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const mine = k.viewer_role === 'payee';
  return (
    <>
      {k.permissions.submit_expense ? <Btn title="Add an expense" onPress={onAdd} style={{ alignSelf: 'flex-start' }} /> : null}
      {q.data.length ? q.data.map((x) => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{CATEGORIES.find((y) => y.value === x.category)?.label ?? x.category} · {plainDate(x.incurred_on)}</T><T size={12} color={c.mute}>{x.status === 'declined' && x.decision_reason ? `Declined: ${x.decision_reason}` : x.status === 'reimbursed' ? `Paid ${when(x.paid_at)}` : x.status === 'approved' ? 'Approved. It is paid with the next payment.' : x.status === 'withdrawn' ? 'Withdrawn' : 'Waiting for the club'}</T></View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{cash(x.amount_cents, x.currency)}</T><Tag label={x.status} color={TONE[x.status]} />{x.over_limit ? <Tag label="Over limit" color={c.sun} /> : null}</View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {x.has_receipt ? <Btn small title="View receipt" color={c.paper} ink={c.ink} onPress={() => openReceipt(`/player-contract-expenses/${x.id}/receipt`, `receipt-${x.id.slice(0, 8)}`).catch((e) => toast(e.message))} /> : <T size={12} color={c.mute}>No receipt</T>}
            {x.status === 'submitted' && k.permissions.manage_money ? <><Btn small title="Approve" color={c.violet} onPress={() => decide(x, 'approve')} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => setDeclining(x)} /></> : null}
            {x.status === 'submitted' && mine ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => decide(x, 'withdraw')} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🧳" title="No expenses" sub={mine ? 'Claim travel, meals or kit your contract covers.' : 'Claims from this person appear here.'} />}
      <FormSheet visible={!!declining} onClose={() => setDeclining(null)} title="Decline this expense" submitLabel="Decline"
        fields={[{ key: 'reason', label: 'Reason the person will read', type: 'multiline' }]}
        onSubmit={async (v) => { await decide(declining, 'decline', v.reason); }} />
    </>
  );
}

function Statements({ k }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/player-contract-invoices', { contract_id: k.id, limit: 50 }), [k.id, k.ladder.paid_cents]);
  const [open, setOpen] = useState(null);
  const [credit, setCredit] = useState(null);
  const view = async (r) => { try { setOpen(await api.get(`/player-contract-invoices/${r.id}`)); } catch (e) { toast(e.message); } };
  const csv = async (r) => { try { const f = await api.get(`/player-contract-invoices/${r.id}`, { format: 'csv' }); toast((await saveFile(f.filename, f.csv)) === 'downloaded' ? 'Downloaded' : 'Ready to share'); } catch (e) { toast(e.message); } };
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  return (
    <>
      {q.data.length ? q.data.map((r) => (
        <Row key={r.id} title={`${r.number}${r.kind === 'credit_note' ? ' · credit note' : ''}`} sub={`${when(r.issued_at)}${r.withheld_cents ? ` · tax withheld ${cash(r.withheld_cents, r.currency)}` : ''}`}
          right={<T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{cash(r.net_cents, r.currency)}</T>} onPress={() => view(r)} />
      )) : <Empty emoji="📄" title="No statements yet" sub="A statement is issued for every payment, with the tax withheld and the lines it covers." />}
      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open ? `${open.kind === 'credit_note' ? 'Credit note' : 'Statement'} ${open.number}` : ''}>
        {open ? (
          <>
            <T size={13} color={c.mute}>{open.payer.name} pays {open.payee.display_name} · {when(open.issued_at)}{open.reason ? ` · ${open.reason}` : ''}</T>
            {open.lines.map((l, n) => <View key={n} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><T size={13} style={{ flex: 1 }}>{l.label}</T><T size={13} weight="700" style={{ fontVariant: ['tabular-nums'] }}>{Number(l.amount_cents) < 0 ? '−' : ''}{cash(Math.abs(Number(l.amount_cents)), open.currency)}</T></View>)}
            <View style={{ height: 1, backgroundColor: c.line }} />
            <T weight="800">Net {cash(open.net_cents, open.currency)}{open.withheld_cents ? ` (after ${cash(open.withheld_cents, open.currency)} tax withheld)` : ''}</T>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title="Download CSV" color={c.paper} ink={c.ink} onPress={() => csv(open)} />
              {k.permissions.finance && open.kind === 'statement' ? <Btn small title="Issue a credit note" color={c.paper} ink={c.ink} onPress={() => { setCredit(open); setOpen(null); }} /> : null}
            </View>
            <T size={12} color={c.mute}>A statement is never edited. A correction is a credit note.</T>
          </>
        ) : null}
      </Sheet>
      <FormSheet visible={!!credit} onClose={() => setCredit(null)} title={`Credit note against ${credit?.number ?? ''}`} submitLabel="Issue credit note"
        fields={[{ key: 'amount_cents', label: 'Amount to credit', type: 'money', currency: k.currency }, { key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/player-contract-invoices/${credit.id}/credit-note`, { ...v, client_key: key() }); q.reload(); return 'Credit note issued'; }} />
    </>
  );
}

// ------------------------------------------------------------------ the screen body
export function ContractDetail({ id, onBack, onChanged }) {
  const { toast } = useSession();
  const { push } = useNav();
  const wide = useLayout().width >= 900;
  const q = useLoad(() => api.get(`/player-contracts/${id}`), [id]);
  const [tab, setTab] = useState('contract');
  const [sheet, setSheet] = useState(null);
  const [cmp, setCmp] = useState(null);
  const done = () => { q.reload(); onChanged?.(); };
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={{ ...q.error, message: q.error.status === 404 ? 'This contract is not available to you.' : say(q.error) }} onRetry={q.reload} />;
  const k = q.data;
  const p = k.permissions;
  const shown = k.in_force ?? k.pending ?? k.versions[k.versions.length - 1];
  const withdraw = async () => { try { await api.post(`/contract-versions/${k.pending.id}/withdraw`, { reason: 'Withdrawn by the proposer' }); toast('Withdrawn'); done(); } catch (e) { toast(say(e)); done(); } };
  const compare = async (v) => { try { setCmp({ v, ...(await api.get(`/player-contracts/${k.id}/compare`, { from: k.in_force.version, to: v.version })) }); } catch (e) { toast(e.message); } };
  const tabs = [{ value: 'contract', label: 'Contract' }, { value: 'money', label: 'Money' }, { value: 'expenses', label: k.expenses_waiting ? `Expenses (${k.expenses_waiting})` : 'Expenses' }, { value: 'statements', label: 'Statements' }];

  return (
    <View style={{ gap: 12 }}>
      {onBack && !wide ? <Btn small title="‹ All contracts" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Back to all contracts" /> : null}
      <GradCard pad={18}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 200 }}>
            <T weight="800" size={20} color="#fff">{k.title}</T>
            <T size={13} color="rgba(255,255,255,0.8)">{k.contract_no} · {k.payer.name} · {k.viewer_role === 'staff' ? k.payee.display_name : `paid by ${k.payer.name}`}</T>
          </View>
          <StatusTag status={k.status} />
        </View>
        {shown ? <T size={13} color="rgba(255,255,255,0.8)">{plainDate(shown.starts_on)} to {plainDate(shown.ends_on)}{k.ended_on ? ` · ended ${plainDate(k.ended_on)}` : ''}</T> : null}
      </GradCard>

      {k.viewer_role === 'guardian' ? <Note>You are viewing this as the guardian of {k.payee.display_name}. Your reads are recorded.</Note> : null}
      {p.sign.length ? (
        <Card color={c.sunSoft}>
          <T weight="800">{k.pending.kind === 'amendment' ? `Version ${k.pending.version} needs your signature` : 'This contract needs your signature'}</T>
          <T size={13}>{k.pending.kind === 'amendment' ? `Changes: ${k.pending.changes.slice(0, 3).map((x) => x.label).join(', ')}.` : 'Read the terms, then sign or decline.'}</T>
          <Btn title="Review and sign" onPress={() => setSheet('review')} style={{ alignSelf: 'flex-start' }} />
        </Card>
      ) : k.pending ? <Note tone={c.violetSoft}>Version {k.pending.version} is waiting for {k.pending.waiting_for.map((x) => PARTY[x]).join(' and ')}. Version {k.in_force?.version ?? '—'} stays in force until then.</Note> : null}

      <Seg options={tabs} value={tab} onChange={setTab} />

      {tab === 'contract' ? (
        <>
          {shown ? <Terms v={shown} cur={k.currency} /> : null}
          <Card>
            <T weight="800">Money at a glance</T>
            <Ladder ladder={k.ladder} currency={k.currency} compact />
          </Card>
          {k.upcoming.length ? (
            <Card>
              <T weight="800">Coming up</T>
              {k.upcoming.map((u) => <View key={u.label + u.due_on} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><View style={{ flex: 1 }}><T size={13} weight="700">{u.label}</T><T size={12} color={c.mute}>{plainDate(u.due_on)}{u.basis === 'one_off' ? ' · if still under contract' : ''}</T></View><T size={13} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{cash(u.amount_cents, k.currency)}</T></View>)}
              <T size={12} color={c.mute}>Not owed yet. These become earnings on their date.</T>
            </Card>
          ) : null}
          {['active', 'offered'].includes(k.status) ? <Readiness items={k.readiness} mine={k.viewer_role === 'payee'} onBank={() => push('Earnings')} /> : null}
          {k.legacy_payout ? <Note>The {cash(k.legacy_payout.amount_cents, k.legacy_payout.currency)} fee recorded when the application was accepted is paid through this contract (the earlier entry is kept as {k.legacy_payout.status}).</Note> : null}
          <Versions k={k} onCompare={compare} />
        </>
      ) : tab === 'money' ? <Money k={k} />
        : tab === 'expenses' ? <Expenses k={k} onAdd={() => setSheet('expense')} onChanged={done} />
          : <Statements k={k} />}

      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {p.edit_draft ? <Btn title="Edit and send" onPress={() => setSheet('draft')} /> : null}
        {p.propose && k.in_force ? <Btn title={p.manage_money ? 'Propose an amendment' : 'Ask for a change'} color={c.violet} onPress={() => setSheet('amend')} /> : null}
        {p.withdraw && k.pending ? <Btn title="Withdraw pending version" color={c.paper} ink={c.ink} onPress={withdraw} /> : null}
        {p.finance && ['active', 'completed', 'terminated'].includes(k.status) ? <><Btn small title="Post an adjustment" color={c.paper} ink={c.ink} onPress={() => setSheet('adjust')} /><Btn small title="Record a refund received" color={c.paper} ink={c.ink} onPress={() => setSheet('refund')} /></> : null}
        {p.end ? <Btn small title="End contract" color={c.paper} ink={c.ink} onPress={() => setSheet('end')} /> : null}
      </View>

      {sheet === 'review' ? <ReviewSheet k={k} v={k.pending} canSign={p.sign} onClose={() => setSheet(null)} onDone={done} onCounter={() => setSheet('counter')} /> : null}
      {sheet === 'amend' || sheet === 'counter' ? <AmendSheet k={k} replace={sheet === 'counter' || !!k.pending} onClose={() => setSheet(null)} onDone={done} /> : null}
      {sheet === 'draft' ? <DraftSheet k={k} onClose={() => setSheet(null)} onDone={done} /> : null}
      {sheet === 'expense' ? <ExpenseSheet k={k} onClose={() => setSheet(null)} onDone={done} /> : null}
      <FormSheet visible={sheet === 'end'} onClose={() => setSheet(null)} title="End this contract" submitLabel="End contract"
        fields={[{ key: 'outcome', label: 'How does it end?', type: 'chips', options: [{ value: 'terminated', label: 'Ended early' }, { value: 'completed', label: 'Completed' }] }, { key: 'ended_on', label: 'Last day', type: 'date' }, { key: 'reason', label: 'Reason', type: 'multiline' }]}
        initial={{ ended_on: new Date().toISOString().slice(0, 10) }}
        onSubmit={async (v) => { await api.post(`/player-contracts/${k.id}/end`, { ...v, row_version: k.row_version }); done(); return 'Contract ended. Pay earned up to that day stays payable.'; }} />
      <FormSheet visible={sheet === 'adjust'} onClose={() => setSheet(null)} title="Post an adjustment" submitLabel="Post"
        fields={[{ key: 'direction', label: 'Effect', type: 'chips', options: [{ value: 'up', label: 'The club owes more' }, { value: 'down', label: 'The club owes less' }] }, { key: 'amount', label: 'Amount', type: 'money', currency: k.currency }, { key: 'label', label: 'Line shown to the person' }, { key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/player-contracts/${k.id}/adjustments`, { amount_cents: v.direction === 'down' ? -v.amount : v.amount, label: v.label, reason: v.reason, client_key: key() }); done(); return 'Adjustment posted'; }} />
      <FormSheet visible={sheet === 'refund'} onClose={() => setSheet(null)} title="Record a refund received" submitLabel="Record"
        fields={[{ key: 'amount_cents', label: 'Amount received back', type: 'money', currency: k.currency }, { key: 'reference', label: 'Bank reference' }, { key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/player-contracts/${k.id}/refunds`, { ...v, client_key: key() }); done(); return 'Refund recorded'; }} />
      <Sheet visible={!!cmp} onClose={() => setCmp(null)} title={cmp ? `Version ${cmp.from} → ${cmp.to}` : ''}>{cmp ? <Changes changes={cmp.changes} currency={k.currency} /> : null}</Sheet>
    </View>
  );
}
