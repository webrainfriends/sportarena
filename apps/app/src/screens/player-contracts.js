// Player contracts: one screen, two doors. Without a team or event it is "My contracts" for the person paid (and their guardian); with team_id or
// event_id it is the club's console: contracts, approvals, payout runs and the desk. Logic lives in the API capabilities; this only calls them.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { useLayout } from '../layout';
import { c } from '../theme';
import { ContractDetail } from './player-contract-detail';
import { Ladder, Note, StatusTag, TermsForm, cash, formToTerms, key, plainDate, saveFile, termsToForm } from '../contracts-ui';

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const ROLE = [{ value: 'player', label: 'Player' }, { value: 'coach', label: 'Coach' }, { value: 'official', label: 'Official' }, { value: 'scorer', label: 'Scorer' }, { value: 'volunteer', label: 'Volunteer' }, { value: 'staff', label: 'Staff' }];
const BLOCK = { no_bank_account: 'No bank account yet', account_unverified: 'Bank account not verified', consent: 'Guardian consent not current', contract_inactive: 'Contract not active', not_signed: 'Not signed yet' };
const RUN_STATUS = { draft: ['Draft', c.violetSoft], approved: ['Approved', c.mint], exported: ['Bank file exported', c.cyan], closed: ['Closed', c.mint], cancelled: ['Cancelled', c.pinkSoft] };
const LINE_STATUS = { ready: ['Ready', c.mint], blocked: ['Blocked', c.pinkSoft], paid: ['Paid', c.mint], failed: ['Failed', c.pinkSoft] };

function ContractRow({ r, onPress, club }) {
  if (r.hidden) return <Row title="Hidden" sub="A young person's contract is hidden until a guardian's consent is current." />;
  return (
    <Row title={club ? r.payee_name : r.title} sub={`${club ? `${r.title} · ` : ''}${r.contract_no}${r.pending_version ? ' · amendment pending' : ''}`} onPress={onPress}
      right={<View style={{ alignItems: 'flex-end', gap: 4 }}>
        <StatusTag status={r.status} />
        {r.needs_my_action ? <Tag label="Needs you" color={c.sun} /> : null}
        {Number(r.owed_cents) > 0 ? <T size={12} weight="800">Owed {cash(r.owed_cents, r.currency)}</T> : null}
      </View>} />
  );
}

/** List + detail: side by side on tablets and desktops, one at a time on phones. */
function Split({ list, detail, selected }) {
  const L = useLayout();
  if (L.width >= 900) return <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}><View style={{ width: 340, gap: 10 }}>{list}</View><View style={{ flex: 1, minWidth: 0 }}>{selected ? detail : <Empty emoji="📑" title="Pick a contract" sub="Its terms, versions, money and expenses open here." />}</View></View>;
  return selected ? detail : <View style={{ gap: 10 }}>{list}</View>;
}

// ------------------------------------------------------------------ the person's own contracts
function MyContracts({ id }) {
  const { push } = useNav();
  const [sel, setSel] = useState(id ?? null);
  const q = useLoad(() => api.get('/player-contracts', { limit: 100 }), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const rows = q.data;
  if (!rows.length) return <Empty emoji="🤝" title="No contracts yet" sub="When a team or event accepts you for paid work, your contract appears here to read and sign. Fees, bonuses, expenses and payments are tracked on it." />;
  const waiting = rows.filter((r) => r.needs_my_action).length;
  const list = (
    <>
      {waiting ? <Note tone={c.sunSoft}>{waiting} contract{waiting === 1 ? ' needs' : 's need'} your signature.</Note> : null}
      {rows.map((r) => <ContractRow key={r.id} r={r} onPress={() => setSel(r.id)} />)}
      <Btn small title="Find opportunities" color={c.paper} ink={c.ink} onPress={() => push('OpportunityMatches')} style={{ alignSelf: 'flex-start' }} />
    </>
  );
  return <Split list={list} selected={sel} detail={<ContractDetail key={sel} id={sel} onBack={() => setSel(null)} onChanged={q.reload} />} />;
}

// ------------------------------------------------------------------ club: new contract
function NewContract({ scope, payer, onClose, onCreated }) {
  const { toast } = useSession();
  const team = !!scope.team_id;
  const cands = useLoad(() => api.get('/player-contracts/candidates', { ...scope, limit: 50 }), [scope.team_id, scope.event_id]);
  const roster = useLoad(() => (team ? api.get(`/teams/${scope.team_id}/roster`) : Promise.resolve(null)), [scope.team_id]);
  const [pick, setPick] = useState(null);       // a candidate (accepted application)
  const [person, setPerson] = useState([]);     // someone else, from the roster or search
  const [title, setTitle] = useState('');
  const [role, setRole] = useState('player');
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ck] = useState(key);
  const cur = payer.currency;

  const start = (cand, who) => {
    const comps = cand?.legacy_amount_cents && cand.legacy_status === 'due'
      ? [{ kind: 'fixed', label: 'Fee agreed on acceptance', amount_cents: cand.legacy_amount_cents, due_on: cand.legacy_due_on ?? inDays(30) }]
      : [{ kind: team ? 'appearance_fee' : 'fixed', amount_cents: 0, ...(team ? {} : { due_on: inDays(30) }) }];
    setF(termsToForm({ starts_on: today(), ends_on: inDays(180), components: comps, expected_games: 0, withholding_bp: 0, pay_terms_days: 7 }, cur));
    setTitle(cand?.post_title ?? `${who ?? 'Contract'} · ${payer.name}`.slice(0, 160));
    setRole(cand?.target_role === 'physio' ? 'staff' : cand?.target_role === 'scorer' ? 'scorer' : ['referee', 'umpire', 'linesman'].includes(cand?.target_role) ? 'official' : cand?.target_role === 'volunteer' ? 'volunteer' : 'player');
  };
  const rosterOptions = (roster.data?.members ?? []).filter((m) => m.status === 'active').map((m) => ({ id: m.id, label: m.display_name, sub: m.team_role, emoji: m.avatar_emoji, color: m.avatar_color }));
  const save = async (send) => {
    setBusy(true); setErr(null);
    try {
      const payee = pick?.payee_id ?? person[0]?.id;
      if (!payee) throw new Error('Choose who the contract is for');
      const k = await api.post('/player-contracts', { ...scope, ...(pick ? { response_id: pick.response_id } : { payee_id: payee }), title: title.trim(), role, terms: formToTerms(f, cur), send, client_key: ck });
      toast(send ? 'Sent for signing' : 'Draft saved'); onCreated(k.id); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Sheet visible onClose={onClose} title="New contract"
      footer={f ? <><Btn title="Save draft" color={c.paper} ink={c.ink} loading={busy} onPress={() => save(false)} style={{ flex: 1 }} /><Btn title="Send for signing" loading={busy} onPress={() => save(true)} style={{ flex: 1 }} /></> : undefined}>
      {!f ? (
        <>
          <T weight="800">Accepted opportunities without a contract</T>
          {cands.loading && !cands.data ? <Loading /> : cands.error ? <ErrorBox error={cands.error} onRetry={cands.reload} /> : cands.data.length ? cands.data.map((x) => (
            <Row key={x.response_id} title={x.hidden ? 'Hidden' : x.display_name} sub={`${x.post_title}${x.legacy_amount_cents ? ` · ${cash(x.legacy_amount_cents, x.currency)} already recorded as due` : ''}`}
              onPress={x.hidden ? undefined : () => { setPick(x); start(x, x.display_name); }} />
          )) : <T size={13} color={c.mute}>Nobody is waiting. When you accept an application on the Billboard, it shows up here.</T>}
          <View style={{ height: 1, backgroundColor: c.line }} />
          <EntityPicker label={team ? 'Someone on the team' : 'Someone working the event'} value={person} onChange={(v) => { setPerson(v); if (v[0]) { setPick(null); start(null, v[0].label); } }}
            options={team ? rosterOptions : undefined} noun="person" />
        </>
      ) : (
        <>
          <T weight="800">{pick ? pick.display_name : person[0]?.label}</T>
          <Field label="Title" value={title} onChangeText={setTitle} maxLength={160} />
          <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute}>ROLE</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{ROLE.map((x) => <Chip key={x.value} label={x.label} active={role === x.value} onPress={() => setRole(x.value)} />)}</View></View>
          <TermsForm value={f} onChange={setF} currency={cur} hasTeam={team} />
          {err ? <ErrorBox error={{ message: err }} /> : null}
          <T size={12} color={c.mute}>Nothing is earned or owed until the person signs and a game is played or a date arrives. A young person also needs a guardian to sign.</T>
          <Btn small title="‹ Choose someone else" color={c.paper} ink={c.ink} onPress={() => { setF(null); setPick(null); setPerson([]); }} style={{ alignSelf: 'flex-start' }} />
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ club: payout runs
function RunDetail({ id, payer, onBack, onChanged }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/player-payout-runs/${id}`), [id]);
  const [line, setLine] = useState(null);
  const [cancel, setCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const r = q.data;
  const cur = r.currency;
  const [stLabel, stColor] = RUN_STATUS[r.status];
  const act = async (fn, ok) => { setBusy(true); try { await fn(); if (ok) toast(ok); q.reload(); onChanged(); } catch (e) { toast(e.message); q.reload(); } finally { setBusy(false); } };
  const approve = () => act(() => api.post(`/player-payout-runs/${r.id}/approve`, { row_version: r.row_version }), 'Run approved');
  const exportFile = () => act(async () => { const f = await api.post(`/player-payout-runs/${r.id}/export`); const how = await saveFile(f.filename, f.csv); toast(how === 'downloaded' ? `${f.rows} transfers in the bank file` : how === 'shared' ? 'Bank file ready to share' : 'Cancelled'); });
  return (
    <View style={{ gap: 12 }}>
      <Btn small title="‹ All runs" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800" size={18}>{r.run_no}</T><Tag label={stLabel} color={stColor} /></View>
        <T size={13} color={c.mute}>{payer.name} · everything due up to {plainDate(r.as_of)} · {cur}{r.note ? ` · ${r.note}` : ''}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <View style={{ flex: 1, minWidth: 120 }}><T size={11} color={c.mute}>GROSS</T><T weight="800">{cash(r.totals.gross_cents, cur)}</T></View>
          <View style={{ flex: 1, minWidth: 120 }}><T size={11} color={c.mute}>TAX WITHHELD</T><T weight="800">{cash(r.totals.withheld_cents, cur)}</T></View>
          <View style={{ flex: 1, minWidth: 120 }}><T size={11} color={c.mute}>NET TO PAY</T><T weight="800">{cash(r.totals.net_cents, cur)}</T></View>
          <View style={{ flex: 1, minWidth: 120 }}><T size={11} color={c.mute}>PAID SO FAR</T><T weight="800">{cash(r.totals.paid_cents, cur)}</T></View>
        </View>
        <T size={12} color={c.mute}>{r.totals.ready} ready · {r.totals.blocked} blocked · {r.totals.paid} paid · {r.totals.failed} failed{r.approval_basis === 'sole_authority' ? ' · approved by the only person with finance authority' : ''}</T>
      </Card>
      {r.can_approve ? <Btn title="Approve this run" loading={busy} onPress={approve} style={{ alignSelf: 'flex-start' }} /> : r.status === 'draft' ? <Note>A second person with finance authority approves a run you prepared.</Note> : null}
      {['approved', 'exported'].includes(r.status) ? (
        <Card color={c.violetSoft}>
          <T weight="800">Pay it from your bank</T>
          <T size={13}>Download the bank file, make the transfers, then record each result. SportArena does not move the money.</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Download bank file (CSV)" loading={busy} onPress={exportFile} /></View>
        </Card>
      ) : null}
      <Section title="Lines" color={c.cyan}>
        {r.lines.length ? r.lines.map((l) => {
          if (l.hidden) return <Row key={l.id} title="Hidden" sub="Guardian consent is not current." right={<Tag label="Blocked" color={c.pinkSoft} />} />;
          const [ls, lc] = LINE_STATUS[l.status];
          return (
            <Row key={l.id} title={l.payee_name} sub={`${l.contract_no} · gross ${cash(l.gross_cents, cur)} · tax ${cash(l.withheld_cents, cur)}${l.block_code ? ` · ${BLOCK[l.block_code]}` : ''}${l.reference ? ` · ref ${l.reference}` : ''}${l.failure_reason ? ` · ${l.failure_reason}` : ''}`}
              onPress={l.status === 'ready' && ['approved', 'exported'].includes(r.status) ? () => setLine(l) : undefined}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{cash(l.net_cents, cur)}</T><Tag label={ls} color={lc} /></View>} />
          );
        }) : <Empty emoji="🧮" title="Nobody is owed anything up to this date" sub="Earnings appear here once games are verified or payment dates arrive." />}
        {r.lines.some((l) => l.status === 'blocked') ? <T size={12} color={c.mute}>Blocked lines stay owed and are not dropped. Fix the cause (bank account, consent, signature), then prepare a new run.</T> : null}
      </Section>
      {['draft', 'approved', 'exported'].includes(r.status) && !r.lines.some((l) => l.status === 'paid') ? <Btn small title="Cancel this run" color={c.paper} ink={c.ink} onPress={() => setCancel(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={!!line} onClose={() => setLine(null)} title={line ? `Result for ${line.payee_name}` : ''} submitLabel="Record result"
        fields={[
          { key: 'result', label: 'What happened?', type: 'chips', options: [{ value: 'paid', label: `Paid ${line ? cash(line.net_cents, cur) : ''}` }, { value: 'failed', label: 'Transfer failed' }] },
          { key: 'reference', label: 'Bank reference', show: (v) => v.result === 'paid', hint: 'Must be unique across payments.' },
          { key: 'failure_reason', label: 'What went wrong?', type: 'multiline', show: (v) => v.result === 'failed' },
        ]}
        onSubmit={async (v) => { await api.post(`/player-payout-lines/${line.id}/result`, v); q.reload(); onChanged(); return v.result === 'paid' ? 'Payment recorded and the statement issued' : 'Recorded. The amount is still owed.'; }} />
      <FormSheet visible={cancel} onClose={() => setCancel(false)} title="Cancel this run" submitLabel="Cancel run"
        fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/player-payout-runs/${r.id}/cancel`, v); q.reload(); onChanged(); return 'Run cancelled. Everything stays owed.'; }} />
    </View>
  );
}

function Runs({ scope, payer }) {
  const [sel, setSel] = useState(null);
  const [make, setMake] = useState(false);
  const q = useLoad(() => api.get('/player-payout-runs', { ...scope, limit: 50 }), [scope.team_id, scope.event_id]);
  if (sel) return <RunDetail id={sel} payer={payer} onBack={() => setSel(null)} onChanged={q.reload} />;
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  return (
    <>
      <Btn title="Prepare a payout run" onPress={() => setMake(true)} style={{ alignSelf: 'flex-start' }} />
      {q.data.length ? q.data.map((r) => {
        const [l, col] = RUN_STATUS[r.status];
        return <Row key={r.id} title={r.run_no} sub={`Up to ${plainDate(r.as_of)} · ${r.lines} line${r.lines === 1 ? '' : 's'}${r.blocked ? ` · ${r.blocked} blocked` : ''}`} onPress={() => setSel(r.id)} right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800">{cash(r.net_cents, r.currency)}</T><Tag label={l} color={col} /></View>} />;
      }) : <Empty emoji="🏦" title="No payout runs yet" sub="A run gathers everything owed up to a date, checks each person can be paid, and gives you a bank file." />}
      <FormSheet visible={make} onClose={() => setMake(false)} title="Prepare a payout run" submitLabel="Prepare"
        fields={[{ key: 'as_of', label: 'Pay everything due up to', type: 'date', hint: 'Today or earlier.' }, { key: 'note', label: 'Note (optional)', optional: true }]}
        initial={{ as_of: today() }}
        onSubmit={async (v) => { const r = await api.post('/player-payout-runs', { ...scope, currency: payer.currency, as_of: v.as_of, ...(v.note ? { note: v.note } : {}), client_key: key() }); setSel(r.id); q.reload(); return `${r.lines.length} line${r.lines.length === 1 ? '' : 's'} prepared`; }} />
    </>
  );
}

// ------------------------------------------------------------------ club: approvals and desk
function Approvals({ scope, onOpen, onNew }) {
  const { toast } = useSession();
  const contracts = useLoad(() => api.get('/player-contracts', { ...scope, limit: 100 }), [scope.team_id, scope.event_id]);
  const exp = useLoad(() => api.get('/player-contract-expenses', { ...scope, status: 'submitted', limit: 50 }), [scope.team_id, scope.event_id]);
  const cands = useLoad(() => api.get('/player-contracts/candidates', { ...scope, limit: 50 }), [scope.team_id, scope.event_id]);
  const [declining, setDeclining] = useState(null);
  const decide = async (x, decision, reason) => { try { await api.post(`/contract-expenses/${x.id}/decision`, { decision, row_version: x.row_version, ...(reason ? { reason } : {}) }); toast(decision === 'approve' ? 'Approved' : 'Declined'); exp.reload(); } catch (e) { toast(e.message); exp.reload(); } };
  const mine = (contracts.data ?? []).filter((r) => r.needs_my_action);
  return (
    <>
      <Section title="Waiting for your signature" color={c.sun}>
        {contracts.loading && !contracts.data ? <Loading /> : mine.length ? mine.map((r) => <ContractRow key={r.id} r={r} club onPress={() => onOpen(r.id)} />) : <T size={13} color={c.mute}>Nothing waiting for you.</T>}
      </Section>
      <Section title="Expenses to decide" color={c.cyan}>
        {exp.loading && !exp.data ? <Loading /> : exp.error ? <ErrorBox error={exp.error} onRetry={exp.reload} /> : exp.data.length ? exp.data.map((x) => x.hidden ? <Row key={x.id} title="Hidden" sub="Guardian consent is not current." /> : (
          <Card key={x.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{x.payee_name} · {x.category}</T><T size={12} color={c.mute}>{x.contract_no} · {plainDate(x.incurred_on)}{x.has_receipt ? ' · receipt attached' : ' · no receipt'}</T></View><View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800">{cash(x.amount_cents, x.currency)}</T>{x.over_limit ? <Tag label="Over limit" color={c.sun} /> : null}</View></View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Approve" color={c.violet} onPress={() => decide(x, 'approve')} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => setDeclining(x)} /><Btn small title="Open contract" color={c.paper} ink={c.ink} onPress={() => onOpen(x.contract_id)} /></View>
          </Card>
        )) : <T size={13} color={c.mute}>No claims are waiting.</T>}
      </Section>
      <Section title="Accepted, no contract yet" color={c.pink} action={cands.data?.length ? 'Create' : undefined} onAction={onNew}>
        {cands.data?.length ? cands.data.map((x) => <Row key={x.response_id} title={x.hidden ? 'Hidden' : x.display_name} sub={x.post_title} onPress={onNew} />) : <T size={13} color={c.mute}>Everyone you accepted has a contract.</T>}
      </Section>
      <FormSheet visible={!!declining} onClose={() => setDeclining(null)} title="Decline this expense" submitLabel="Decline" fields={[{ key: 'reason', label: 'Reason the person will read', type: 'multiline' }]}
        onSubmit={async (v) => { await decide(declining, 'decline', v.reason); }} />
    </>
  );
}

function Desk({ scope }) {
  const q = useLoad(() => api.get('/player-contract-desk', scope), [scope.team_id, scope.event_id]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const d = q.data;
  const a = d.attention;
  const status = Object.entries(d.contracts_by_status);
  return (
    <>
      <Card>
        <T weight="800">Contracts</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{status.length ? status.map(([s, n]) => <Tag key={s} label={`${s} ${n}`} color={s === 'active' ? c.mint : c.violetSoft} />) : <T size={13} color={c.mute}>No contracts yet.</T>}</View>
      </Card>
      {d.money.map((m) => (
        <Card key={m.currency}>
          <T weight="800">{m.currency} · {m.contracts} contract{m.contracts === 1 ? '' : 's'}</T>
          <Ladder ladder={{ ...m, committed_cents: m.committed_cents }} currency={m.currency} compact />
        </Card>
      ))}
      <Card>
        <T weight="800">Needs attention</T>
        {[[a.accepted_without_contract, 'accepted without a contract'], [a.versions_waiting, 'offers or amendments waiting for signatures'], [a.expenses_waiting, 'expense claims waiting'], [a.blocked_lines, 'payout lines blocked in an open run'], [a.failed_payments, 'failed payments not yet paid'], [a.ending_within_30_days, 'contracts ending within 30 days']].map(([n, t]) => (
          <View key={t} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Tag label={String(n)} color={n ? c.sun : c.violetSoft} /><T size={13} style={{ flex: 1 }}>{t}</T></View>
        ))}
      </Card>
      {d.by_role.length ? <Card><T weight="800">By role</T>{d.by_role.map((r) => <View key={r.role + r.currency} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><T size={13} style={{ flex: 1 }}>{r.role} · {r.contracts}</T><T size={13} weight="700" style={{ fontVariant: ['tabular-nums'] }}>{cash(r.committed_cents, r.currency)} committed · {cash(r.paid_cents, r.currency)} paid</T></View>)}</Card> : null}
      <Card color={d.reconciliation.every((r) => r.balanced) ? c.limeSoft : c.pinkSoft}>
        <T weight="800">Reconciliation</T>
        {d.reconciliation.length ? d.reconciliation.map((r) => <T key={r.currency} size={13}>{r.currency}: ledger payments {cash(r.ledger_paid_cents, r.currency)} · recorded in payout runs {cash(r.runs_paid_cents, r.currency)} · {r.balanced ? 'balanced' : 'does not match: investigate before the next run'}</T>) : <T size={13} color={c.mute}>Nothing paid yet.</T>}
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ club console
function ClubConsole({ team_id, event_id }) {
  const scope = useMemo(() => (team_id ? { team_id } : { event_id }), [team_id, event_id]);
  const payer = useLoad(() => api.get(team_id ? `/teams/${team_id}` : `/events/${event_id}`), [team_id, event_id]);
  const [tab, setTab] = useState('contracts');
  const [status, setStatus] = useState('active');
  const [sel, setSel] = useState(null);
  const [make, setMake] = useState(false);
  const list = useLoad(() => api.get('/player-contracts', { ...scope, status, limit: 100 }), [team_id, event_id, status]);
  if (payer.error) return <ErrorBox error={payer.error} onRetry={payer.reload} />;
  if (!payer.data) return <Loading />;
  const p = { name: payer.data.name, currency: (payer.data.currency ?? 'INR').toUpperCase() };
  const open = (id) => { setTab('contracts'); setSel(id); };
  const tabs = [{ value: 'contracts', label: 'Contracts' }, { value: 'approvals', label: 'Approvals' }, { value: 'runs', label: 'Payout runs' }, { value: 'desk', label: 'Desk' }];
  const rows = (
    <>
      <Btn title="New contract" onPress={() => setMake(true)} style={{ alignSelf: 'flex-start' }} />
      <Seg options={['active', 'offered', 'draft', 'completed', 'terminated'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} value={status} onChange={(s) => { setStatus(s); setSel(null); }} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((r) => <ContractRow key={r.id} r={r} club onPress={() => setSel(r.id)} />) : <Empty emoji="🤝" title={`No ${status} contracts`} sub={status === 'active' ? 'Create a contract from an accepted application, or for someone on the roster.' : 'Nothing here.'} />}
    </>
  );
  return (
    <View style={{ gap: 12 }}>
      <GradCard pad={18}><T weight="800" size={20} color="#fff">{p.name}</T><T size={13} color="rgba(255,255,255,0.8)">Player contracts · pays in {p.currency}. Fees, bonuses, expenses and payments are recorded here; SportArena does not hold the money.</T></GradCard>
      <Seg options={tabs} value={tab} onChange={(t) => { setTab(t); }} />
      {tab === 'contracts' ? <Split list={rows} selected={sel} detail={<ContractDetail key={sel} id={sel} onBack={() => setSel(null)} onChanged={list.reload} />} />
        : tab === 'approvals' ? <Approvals scope={scope} onOpen={open} onNew={() => setMake(true)} />
          : tab === 'runs' ? <Runs scope={scope} payer={p} /> : <Desk scope={scope} />}
      {make ? <NewContract scope={scope} payer={p} onClose={() => setMake(false)} onCreated={(id) => { setStatus('draft'); list.reload(); open(id); }} /> : null}
    </View>
  );
}

export function PlayerContracts({ team_id, event_id, id }) {
  const club = !!(team_id || event_id);
  return (
    <Screen wide>
      <H1 style={{ marginTop: 8 }}>{club ? 'Player contracts' : 'My contracts'}</H1>
      <T color={c.mute} weight="600" style={{ marginBottom: 10 }}>{club ? 'Versioned terms, signatures, earnings, expenses and payout runs for the people you pay.' : 'What you have agreed, what you have earned and what you have been paid. An offer is not earnings.'}</T>
      {club ? <ClubConsole team_id={team_id} event_id={event_id} /> : <MyContracts id={id} />}
    </Screen>
  );
}
