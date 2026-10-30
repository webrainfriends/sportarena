// Finance console (#564): the single home for the money of an organisation (or, for the platform admin, of the whole platform). It only
// calls the finance API (REST + OpenAPI + MCP from one capability definition); every figure comes from the canonical ledger, nothing is
// computed here and nothing is edited here. Module screens keep their own workflow and link to this one for the money view.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { DateRangeField } from '../pickers';
import { c, day } from '../theme';
import { moneyIn } from '../vtime';
import { Bars, Block, Fact, Kpi, Split, Timeline, saveCsv } from './academy-ui';

const FINANCE_ROLES = ['owner', 'admin', 'finance'];
const TABS = [['overview', 'Overview'], ['transactions', 'Transactions'], ['receivables', 'Receivables'], ['payables', 'Payables'], ['settlements', 'Settlements'], ['reconciliation', 'Reconciliation']];
const KIND = { charge: 'Charge', payment: 'Payment', refund: 'Refund', credit_note: 'Credit note', chargeback: 'Chargeback', payout: 'Payout', payout_reversal: 'Payout reversed', adjustment: 'Adjustment' };
const STATUS = { open: 'Awaiting payment', settled: 'Settled', failed: 'Failed', cancelled: 'Cancelled', disputed: 'Disputed', reversed: 'Reversed' };
// state is always a word as well as a colour
const STATUS_TONE = { open: c.sunSoft, settled: c.lime, failed: c.orangeSoft, cancelled: c.violetSoft, disputed: c.orangeSoft, reversed: c.violetSoft };
const STEP_ICON = { done: '✅', pending: '⏳', attention: '⚠️', na: '–' };
const RECON = { payment_unrecorded: 'Payment not recorded', refund_drift: 'Refund does not match', amount_drift: 'Amount does not match', paid_without_ledger: 'Paid but not in the seller ledger', amount_mismatch: 'Provider amount does not match', refund_unrecorded: 'Provider refund not recorded', provider_dispute: 'Customer dispute', payout_failed: 'Payout failed', ledger_drift: 'Seller ledger drift', share_mismatch: 'Seller shares do not add up' };
// where a source record opens, for the sources that have a screen of their own
const SOURCE_ROUTE = { venue_invoice: (id) => ['Invoice', { id }] };
const money = (minor, cur) => moneyIn(Number(minor ?? 0), cur);
const iso = (d) => (d ? String(d).slice(0, 10) : undefined);

export function Finance({ id: routeOrg }) {
  const { user, toast } = useSession();
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const platform = user.roles.includes('platform_admin');
  const mine = (orgs.data ?? []).filter((o) => o.my_status === 'active' && FINANCE_ROLES.includes(o.my_role));
  const [orgId, setOrgId] = useState(routeOrg ?? null);
  const [whole, setWhole] = useState(!routeOrg && platform);
  useEffect(() => { if (!routeOrg && !whole && !orgId && mine.length) setOrgId(mine[0].id); }, [orgs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [range, setRange] = useState({});
  const [cur, setCur] = useState(null);
  const [mod, setMod] = useState(null);
  const [tab, setTab] = useState('overview');
  const scope = whole ? {} : { organisation_id: orgId };
  const ready = whole || orgId;
  const q = { ...scope, from: iso(range.from), to: iso(range.to), currency: cur ?? undefined, module: mod ?? undefined };
  const sum = useLoad(() => (ready ? api.get('/finance/summary', q) : Promise.resolve(null)), [ready, whole, orgId, range.from, range.to, cur, mod]);
  const everyCurrency = useLoad(() => (ready ? api.get('/finance/summary', { ...scope, from: iso(range.from), to: iso(range.to) }) : Promise.resolve(null)), [ready, whole, orgId, range.from, range.to]);
  const currencies = everyCurrency.data?.currencies ?? [];
  const modules = [...new Map(currencies.flatMap((x) => x.by_module).map((m) => [m.module, m.label])).entries()];
  const shown = sum.data?.currencies ?? [];
  const head = shown[0];
  const needs = sum.data?.needs_review ?? 0;

  if (!orgs.loading && !routeOrg && !platform && !mine.length) {
    return <Screen><H1>Finance</H1><Empty emoji="🔒" title="No finance access" sub="Finance is open to the owner, admins and finance staff of an organisation." /></Screen>;
  }
  return (
    <Screen wide>
      <H1>Finance</H1>
      <T color={c.mute} weight="700">One place for every charge, payment, refund and settlement across your organisation.</T>
      <View style={{ gap: 12, marginTop: 14 }}>
        <DateRangeField label="Dates" from={range.from} to={range.to} optional onChange={setRange} hint="Leave empty for everything." />
        {mine.length || platform ? (
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>ORGANISATION</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {platform ? <Chip label="Whole platform" active={whole} onPress={() => { setWhole(true); setOrgId(null); setCur(null); setMod(null); }} /> : null}
              {mine.map((o) => <Chip key={o.id} label={o.name} active={!whole && orgId === o.id} onPress={() => { setWhole(false); setOrgId(o.id); setCur(null); setMod(null); }} />)}
            </View>
          </View>
        ) : null}
        {currencies.length > 1 ? (
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>CURRENCY</T>
            <Seg options={[{ value: null, label: 'All currencies' }, ...currencies.map((x) => ({ value: x.currency, label: x.currency }))]} value={cur} onChange={setCur} />
          </View>
        ) : null}
      </View>
      <View style={{ marginVertical: 12 }}><Seg options={TABS.map(([value, label]) => ({ value, label: value === 'reconciliation' && needs ? `${label} (${needs})` : label }))} value={tab} onChange={setTab} /></View>
      {!ready ? <Loading /> : sum.error ? <ErrorBox error={sum.error} onRetry={sum.reload} /> : sum.loading && !sum.data ? <Loading /> : (
        <>
          {tab === 'overview' ? <Overview shown={shown} head={head} needs={needs} modules={modules} mod={mod} setMod={setMod} onReview={() => setTab('reconciliation')} /> : null}
          {tab === 'transactions' ? <Transactions q={q} scope={scope} modules={modules} mod={mod} setMod={setMod} toast={toast} /> : null}
          {tab === 'receivables' ? <Transactions q={{ ...q, kind: 'charge', status: 'open' }} scope={scope} only="in" empty="Nothing is waiting to be paid to you." /> : null}
          {tab === 'payables' ? <Transactions q={{ ...q, kind: 'charge', status: 'open' }} scope={scope} only="out" empty="You do not owe anything right now." /> : null}
          {tab === 'settlements' ? <Transactions q={{ ...q, kind: 'payout' }} scope={scope} empty="No payouts yet." /> : null}
          {tab === 'reconciliation' ? <Reconciliation scope={scope} whole={whole} platform={platform} onChanged={() => { sum.reload(); everyCurrency.reload(); }} toast={toast} /> : null}
        </>
      )}
    </Screen>
  );
}

function Overview({ shown, head, needs, modules, mod, setMod, onReview }) {
  if (!head) return <Empty emoji="💸" title="Nothing in this period yet" sub="Charges, payments and refunds from every module appear here as soon as they happen." />;
  return (
    <View style={{ gap: 12 }}>
      {shown.map((x) => (
        <View key={x.currency} style={{ gap: 12 }}>
          <GradCard>
            <T size={11} weight="800" color="#fff" style={{ letterSpacing: 1, opacity: 0.85 }}>NET REVENUE · {x.currency}</T>
            <T size={34} weight="800" color="#fff" style={{ letterSpacing: -1.2, fontVariant: ['tabular-nums'] }}>{money(x.net, x.currency)}</T>
            <T size={13} color="#fff" style={{ opacity: 0.85 }}>Gross less tax, fees, discounts and refunds · {x.payments} payment{x.payments === 1 ? '' : 's'}</T>
          </GradCard>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <Kpi label="Gross billed" value={money(x.gross, x.currency)} sub="before deductions" />
            <Kpi label="Receivables" value={money(x.receivable, x.currency)} sub="owed to you" />
            <Kpi label="Payables" value={money(x.payable, x.currency)} sub="you owe" />
            <Kpi label="Refunds" value={money(x.refunds, x.currency)} sub="in the period" />
            <Kpi label="Fees and tax" value={money(x.fee + x.tax, x.currency)} sub={`${money(x.fee, x.currency)} fees · ${money(x.tax, x.currency)} tax`} />
            <Kpi label="Needs review" value={String(needs)} sub="unmatched or failed" tone={needs ? 'alert' : undefined} onPress={onReview} />
          </View>
          <Section title="Where the money comes from" color={c.violet}>
            {modules.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Chip label="All" active={!mod} onPress={() => setMod(null)} />{modules.map(([m, l]) => <Chip key={m} label={l} active={mod === m} onPress={() => setMod(m)} />)}</View> : null}
            <Card><Bars label={`Net revenue by module in ${x.currency}`} rows={x.by_module.filter((m) => m.net || m.gross).map((m) => ({ label: m.label, value: m.net, text: money(m.net, x.currency) }))} /></Card>
          </Section>
          <T size={12} color={c.mute}>Currencies are never added together. Tax figures are informational, not tax advice.</T>
        </View>
      ))}
    </View>
  );
}

function Transactions({ q, scope, modules, mod, setMod, only, empty, toast }) {
  q = only ? { ...q, direction: only } : q;
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [state, setState] = useState({ loading: true, error: null });
  const [openId, setOpenId] = useState(null);
  const [kind, setKind] = useState(null);
  const key = JSON.stringify(q) + kind;
  const load = async (offset) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const got = await api.get('/finance/transactions', { ...q, ...(kind ? { kind } : {}), limit: 25, offset });
      setRows((prev) => (offset ? [...prev, ...got] : got)); setMore(got.length === 25); setState({ loading: false, error: null });
    } catch (e) { setState({ loading: false, error: e }); }
  };
  useEffect(() => { load(0); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = rows;
  const exportCsv = async () => {
    try { const r = await api.get('/finance/transactions/export', { ...q, ...(kind ? { kind } : {}) }); await saveCsv(r.filename, r.csv); toast?.(`${r.rows} rows exported`); } catch (e) { toast?.(e.message); }
  };
  return (
    <Split
      open={!!openId} onClose={() => setOpenId(null)} detailTitle="Transaction"
      detail={openId ? <Detail id={openId} scope={scope} /> : null}
      list={(
        <View style={{ gap: 10 }}>
          {setMod ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Chip label="All kinds" active={!kind} onPress={() => setKind(null)} />
              {['payment', 'refund', 'chargeback', 'charge', 'payout'].map((k) => <Chip key={k} label={KIND[k]} active={kind === k} onPress={() => setKind(k)} />)}
            </View>
          ) : null}
          {setMod && modules?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Chip label="All modules" active={!mod} onPress={() => setMod(null)} />{modules.map(([m, l]) => <Chip key={m} label={l} active={mod === m} onPress={() => setMod(m)} />)}</View> : null}
          {state.error ? <ErrorBox error={state.error} onRetry={() => load(0)} /> : state.loading && !rows.length ? <Loading /> : !list.length ? (
            <Empty emoji="🧾" title={empty ?? 'Nothing in this period yet'} sub="Charges from every module appear here as soon as they are raised." />
          ) : list.map((r) => (
            <Row key={r.id} onPress={() => setOpenId(r.id)} title={`${r.module_label} · ${KIND[r.kind] ?? r.kind}`}
              sub={[r.payer || r.payee ? `${r.payer ?? '—'} → ${r.payee ?? '—'}` : null, r.provider, r.currency, day(r.occurred_at)].filter(Boolean).join(' · ')}
              right={<><T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{r.kind === 'refund' || r.kind === 'chargeback' || r.direction === 'out' ? '−' : ''}{money(r.gross_minor, r.currency)}</T><Tag label={STATUS[r.status] ?? r.status} color={STATUS_TONE[r.status]} /></>} />
          ))}
          {more ? <Btn small title="Show more" color={c.paper} ink={c.ink} loading={state.loading} onPress={() => load(rows.length)} style={{ alignSelf: 'flex-start' }} /> : null}
          {setMod && list.length ? <Btn small title="Export CSV" color={c.paper} ink={c.ink} onPress={exportCsv} style={{ alignSelf: 'flex-start' }} /> : null}
        </View>
      )}
    />
  );
}

function Detail({ id, scope }) {
  const { push } = useNav();
  const t = useLoad(() => api.get(`/finance/transactions/${id}`, scope), [id]);
  if (t.error) return <ErrorBox error={t.error} onRetry={t.reload} />;
  if (!t.data) return <Loading />;
  const x = t.data, route = SOURCE_ROUTE[x.source_type]?.(x.source_id);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Tag label={KIND[x.kind] ?? x.kind} color={c.cyanSoft} /><Tag label={STATUS[x.status] ?? x.status} color={STATUS_TONE[x.status]} /></View>
      <Block title="Trace"><Timeline items={x.steps.map((s) => ({ title: `${STEP_ICON[s.status] ?? ''} ${s.label}`, sub: [s.at ? day(s.at) : null, s.ref, s.provider].filter(Boolean).join(' · ') }))} /></Block>
      <Block title="Amounts">
        <Fact k="Gross" v={money(x.gross_minor, x.currency)} /><Fact k="Discount" v={money(x.discount_minor, x.currency)} /><Fact k="Tax" v={money(x.tax_minor, x.currency)} />
        <Fact k="Fee" v={money(x.fee_minor, x.currency)} /><Fact k="Net" v={money(x.net_minor, x.currency)} />
      </Block>
      <Block title="Parties"><Fact k="Payer" v={x.payer} /><Fact k="Payee" v={x.payee} /><Fact k="Provider" v={x.provider} /><Fact k="Reference" v={x.provider_ref} /></Block>
      <Block title="History"><Timeline items={(x.history.length ? x.history : [{ action: 'posted', created_at: x.occurred_at }]).map((h) => ({ title: String(h.action).replace(/_/g, ' '), sub: [h.actor, day(h.created_at)].filter(Boolean).join(' · ') }))} /></Block>
      {route ? <Btn title="Open the source record" color={c.paper} ink={c.ink} onPress={() => push(route[0], route[1])} /> : null}
    </View>
  );
}

function Reconciliation({ scope, whole, platform, onChanged, toast }) {
  const items = useLoad(() => api.get('/finance/reconciliation', { ...scope, status: 'open', limit: 50 }), [whole, scope.organisation_id]);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { const r = await api.post('/admin/finance/reconcile', {}); toast(`Reconciled: ${r.backfilled} payments backfilled, ${r.refunds_repaired} refunds repaired, ${r.open_items} items open`); items.reload(); onChanged(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const [closing, setClosing] = useState(null);
  const [reason, setReason] = useState('');
  const resolve = async () => {
    try { await api.post(`/admin/finance/reconciliation/${closing.id}/resolve`, { reason }); toast('Item closed'); setClosing(null); setReason(''); items.reload(); onChanged(); } catch (e) { toast(e.message); }
  };
  return (
    <View style={{ gap: 10 }}>
      <T color={c.mute} size={13}>Payments, refunds, settlements, failures, chargebacks and unmatched items that need a person. Items close themselves when the records agree again.</T>
      {platform && whole ? <Btn small title="Run reconciliation now" loading={busy} onPress={run} style={{ alignSelf: 'flex-start' }} /> : null}
      {items.error ? <ErrorBox error={items.error} onRetry={items.reload} /> : !items.data ? <Loading /> : !items.data.length ? <Empty emoji="✅" title="Everything matches" sub="No unmatched or failed money movements." /> : items.data.map((x) => (
        <Row key={`${x.source}-${x.id}`} title={RECON[x.kind] ?? String(x.kind).replace(/_/g, ' ')} sub={`${x.source === 'settlement' ? 'Provider settlement' : 'Ledger'} · ${x.currency ?? ''} ${x.amount_minor != null ? money(x.amount_minor, x.currency ?? 'INR') : ''} · ${day(x.created_at)}`}
          right={<><Tag label="Needs review" color={c.orangeSoft} />{platform && whole && x.source === 'canonical' ? <Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => setClosing(x)} /> : null}</>} />
      ))}
      <Sheet visible={!!closing} onClose={() => setClosing(null)} title="Close this item">
        <T color={c.mute} size={13}>The item stays on record with your reason. Say what you checked and what you found.</T>
        <Field label="Reason" value={reason} onChangeText={setReason} multiline placeholder="e.g. Provider statement confirms the original amount" hint="At least 5 characters." />
        <Btn title="Close item" disabled={reason.trim().length < 5} onPress={resolve} />
      </Sheet>
    </View>
  );
}
