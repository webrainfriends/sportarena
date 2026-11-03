// Finance console (#564, organisation control plane #593): the single home for the money of an organisation (or, for the platform admin, of the
// whole platform). It only calls the finance API (REST + OpenAPI + MCP from one capability definition); every figure comes from the canonical
// ledger, nothing is computed here and nothing is edited here. Module screens keep their own workflow and link to this one for the money view.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { t } from '../i18n';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { DateRangeField } from '../pickers';
import { MenuField, MultiMenuField } from '../menu-field';
import { c, day } from '../theme';
import { Bars, Kpi, Split, saveCsv } from './academy-ui';
import { Obligations, Settlements, AccessAudit } from './finance-books';
import { Detail, TxRow, atLeast, catLabel, kindLabel, modLabel, money } from './finance-parts';

const FINANCE_ROLES = ['owner', 'admin', 'finance'];
const TABS = ['overview', 'transactions', 'receivables', 'payables', 'settlements', 'reconciliation', 'access'];
const RECON_KINDS = ['payment_unrecorded', 'refund_drift', 'amount_drift', 'paid_without_ledger', 'amount_mismatch', 'refund_unrecorded', 'provider_dispute', 'payout_failed', 'ledger_drift', 'share_mismatch'];
const iso = (d) => (d ? String(d).slice(0, 10) : undefined);
const join = (v) => (v?.length ? v.join(',') : undefined);
const NO_DIMS = { season: [], event: [], team: [], workspace: [], category: [] };

export function Finance({ id: routeOrg }) {
  const { user, toast } = useSession();
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const platform = user.roles.includes('platform_admin');
  const mine = (orgs.data ?? []).filter((o) => o.my_status === 'active' && (FINANCE_ROLES.includes(o.my_role) || o.id === routeOrg));
  const [orgId, setOrgId] = useState(routeOrg ?? null);
  const [whole, setWhole] = useState(!routeOrg && platform);
  useEffect(() => { if (!routeOrg && !whole && !orgId && mine.length) setOrgId(mine[0].id); }, [orgs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [range, setRange] = useState({});
  const [cur, setCur] = useState(null);
  const [mod, setMod] = useState(null);
  const [dims, setDims] = useState(NO_DIMS);
  const [showFilters, setShowFilters] = useState(false);
  const [tab, setTab] = useState('overview');
  const scope = whole ? {} : { organisation_id: orgId };
  const ready = whole || orgId;
  const dimQ = { season_ids: join(dims.season), event_ids: join(dims.event), team_ids: join(dims.team), workspace_ids: join(dims.workspace), categories: join(dims.category) };
  const activeDims = Object.values(dims).filter((v) => v.length).length + (mod ? 1 : 0);
  const q = { ...scope, from: iso(range.from), to: iso(range.to), currency: cur ?? undefined, module: mod ?? undefined, ...dimQ };
  const depKey = JSON.stringify(q);
  const sum = useLoad(() => (ready ? api.get('/finance/summary', q) : Promise.resolve(null)), [ready, depKey]);
  const everyCurrency = useLoad(() => (ready ? api.get('/finance/summary', { ...scope, from: iso(range.from), to: iso(range.to) }) : Promise.resolve(null)), [ready, whole, orgId, range.from, range.to]);
  const options = useLoad(() => (ready ? api.get('/finance/filters', scope).catch(() => null) : Promise.resolve(null)), [ready, whole, orgId]);
  const currencies = everyCurrency.data?.currencies ?? [];
  const modules = [...new Map(currencies.flatMap((x) => x.by_module).map((m) => [m.module, modLabel(m.module)])).entries()];
  const shown = sum.data?.currencies ?? [];
  const head = shown[0];
  const needs = sum.data?.needs_review ?? 0;
  const level = sum.data?.level ?? (whole ? 'controller' : null);
  const reset = () => { setDims(NO_DIMS); setMod(null); };
  const pickOrg = (v) => { if (v === '__all') { setWhole(true); setOrgId(null); } else { setWhole(false); setOrgId(v); } setCur(null); reset(); };

  if (!orgs.loading && !routeOrg && !platform && !mine.length) {
    return <Screen><H1>{t('fin.title')}</H1><Empty emoji="🔒" title={t('fin.no_access_title')} sub={t('fin.no_access_sub')} /></Screen>;
  }
  const o = options.data;
  const opt = (rows, label = 'name') => (rows ?? []).map((x) => ({ value: x.id, label: x[label] }));
  return (
    <Screen wide>
      <H1>{t('fin.title')}</H1>
      <T color={c.mute} weight="700">{t('fin.intro')}</T>
      <View style={{ gap: 12, marginTop: 14 }}>
        <DateRangeField label={t('fin.dates')} from={range.from} to={range.to} optional onChange={setRange} hint={t('fin.dates_hint')} />
        {mine.length || platform ? (
          <MenuField label={t('fin.org')} value={whole ? '__all' : orgId}
            options={[...(platform ? [{ value: '__all', label: t('fin.whole_platform') }] : []), ...mine.map((x) => ({ value: x.id, label: x.name }))]} onChange={pickOrg} />
        ) : null}
        {currencies.length > 1 ? (
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('fin.currency').toUpperCase()}</T>
            <Seg options={[{ value: null, label: t('fin.all_currencies') }, ...currencies.map((x) => ({ value: x.currency, label: x.currency }))]} value={cur} onChange={setCur} />
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Chip label={activeDims ? t('fin.filters_n', { n: activeDims }) : t('fin.filters')} active={showFilters || activeDims > 0} onPress={() => setShowFilters(!showFilters)} />
          {activeDims ? <Chip label={t('fin.clear_filters')} onPress={reset} /> : null}
        </View>
        {showFilters ? (
          <View style={{ gap: 12 }}>
            {!whole ? <MultiMenuField label={t('fin.season')} value={dims.season} onChange={(v) => setDims({ ...dims, season: v })} options={opt(o?.seasons)} placeholder={t('fin.any')} /> : null}
            <MultiMenuField label={t('fin.event')} value={dims.event} onChange={(v) => setDims({ ...dims, event: v })} options={opt(o?.events)} placeholder={t('fin.any')} />
            <MultiMenuField label={t('fin.team')} value={dims.team} onChange={(v) => setDims({ ...dims, team: v })} options={opt(o?.teams)} placeholder={t('fin.any')} />
            {!whole ? <MultiMenuField label={t('fin.workspace')} value={dims.workspace} onChange={(v) => setDims({ ...dims, workspace: v })} options={opt(o?.workspaces)} placeholder={t('fin.any')} /> : null}
            <MultiMenuField label={t('fin.category')} value={dims.category} onChange={(v) => setDims({ ...dims, category: v })} options={(o?.categories ?? []).map((x) => ({ value: x.value, label: catLabel(x.value) }))} placeholder={t('fin.any')} />
            {modules.length ? <MenuField label={t('fin.module')} value={mod ?? ''} onChange={(v) => setMod(v || null)} options={[{ value: '', label: t('fin.all_modules') }, ...modules.map(([value, label]) => ({ value, label }))]} /> : null}
          </View>
        ) : null}
      </View>
      <View style={{ marginVertical: 12 }}><Seg options={TABS.map((value) => ({ value, label: value === 'reconciliation' && needs ? `${t(`fin.tab.${value}`)} (${needs})` : t(`fin.tab.${value}`) }))} value={tab} onChange={setTab} /></View>
      {!ready ? <Loading /> : sum.error ? <ErrorBox error={sum.error} onRetry={sum.reload} /> : sum.loading && !sum.data ? <Loading /> : (
        <>
          {tab === 'overview' ? <Overview shown={shown} head={head} needs={needs} onReview={() => setTab('reconciliation')} onCategory={(k) => { setDims({ ...dims, category: [k] }); setTab('transactions'); }} /> : null}
          {tab === 'transactions' ? <Transactions q={q} scope={scope} level={level} toast={toast} /> : null}
          {tab === 'receivables' ? <Obligations direction="in" q={q} scope={scope} cur={cur} /> : null}
          {tab === 'payables' ? <Obligations direction="out" q={q} scope={scope} cur={cur} /> : null}
          {tab === 'settlements' ? <Settlements q={q} scope={scope} /> : null}
          {tab === 'reconciliation' ? <Reconciliation scope={scope} whole={whole} platform={platform} level={level} onChanged={() => { sum.reload(); everyCurrency.reload(); }} toast={toast} /> : null}
          {tab === 'access' ? <AccessAudit scope={scope} whole={whole} level={level} toast={toast} onChanged={sum.reload} /> : null}
        </>
      )}
    </Screen>
  );
}

function Overview({ shown, head, needs, onReview, onCategory }) {
  if (!head) return <Empty emoji="💸" title={t('fin.empty_title')} sub={t('fin.empty_sub')} />;
  return (
    <View style={{ gap: 12 }}>
      {shown.map((x) => (
        <View key={x.currency} style={{ gap: 12 }}>
          <GradCard>
            <T size={11} weight="800" color="#fff" style={{ letterSpacing: 1, opacity: 0.85 }}>{t('fin.net_revenue', { cur: x.currency })}</T>
            <T size={34} weight="800" color="#fff" style={{ letterSpacing: -1.2, fontVariant: ['tabular-nums'] }}>{money(x.net, x.currency)}</T>
            <T size={13} color="#fff" style={{ opacity: 0.85 }}>{t('fin.net_sub', { n: x.payments })}</T>
          </GradCard>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <Kpi label={t('fin.kpi.gross')} value={money(x.gross, x.currency)} sub={t('fin.kpi.gross_sub')} />
            <Kpi label={t('fin.kpi.receivables')} value={money(x.receivable, x.currency)} sub={t('fin.kpi.receivables_sub')} />
            <Kpi label={t('fin.kpi.payables')} value={money(x.payable, x.currency)} sub={t('fin.kpi.payables_sub')} />
            <Kpi label={t('fin.kpi.refunds')} value={money(x.refunds, x.currency)} sub={t('fin.kpi.refunds_sub')} />
            <Kpi label={t('fin.kpi.commissions')} value={money(x.commissions, x.currency)} sub={t('fin.kpi.commissions_sub')} />
            <Kpi label={t('fin.kpi.taxes')} value={money(x.taxes, x.currency)} sub={t('fin.kpi.taxes_sub')} />
            {x.spend ? <Kpi label={t('fin.kpi.spend')} value={money(x.spend, x.currency)} sub={t('fin.kpi.spend_sub')} /> : null}
            <Kpi label={t('fin.kpi.review')} value={String(needs)} sub={t('fin.kpi.review_sub')} tone={needs ? 'alert' : undefined} onPress={onReview} />
          </View>
          <Section title={t('fin.by_category')} color={c.violet}>
            <T size={12} color={c.mute}>{t('fin.by_category_hint')}</T>
            <Card><Bars label={t('fin.by_category_chart', { cur: x.currency })} rows={x.by_category.filter((k) => k.net || k.gross).map((k) => ({ label: catLabel(k.category), value: k.net, text: money(k.net, x.currency) }))} /></Card>
            {x.by_category.map((k) => (
              <Row key={k.category} onPress={() => onCategory(k.category)} title={catLabel(k.category)}
                sub={[k.spend ? t('fin.spend_line', { label: t('fin.kpi.spend'), amount: money(k.spend, x.currency) }) : null, k.receivable ? `${t('fin.kpi.receivables')} ${money(k.receivable, x.currency)}` : null, k.payable ? `${t('fin.kpi.payables')} ${money(k.payable, x.currency)}` : null].filter(Boolean).join(' · ') || undefined}
                right={<T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(k.net, x.currency)}</T>} />
            ))}
          </Section>
          <T size={12} color={c.mute}>{t('fin.currencies_note')}</T>
        </View>
      ))}
    </View>
  );
}

function Transactions({ q, scope, level, toast }) {
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
  const exportCsv = async () => {
    try { const r = await api.get('/finance/transactions/export', { ...q, ...(kind ? { kind } : {}) }); await saveCsv(r.filename, r.csv); toast?.(t('fin.exported', { n: r.rows, hash: r.manifest.sha256.slice(0, 12) })); } catch (e) { toast?.(e.message); }
  };
  return (
    <Split
      open={!!openId} onClose={() => setOpenId(null)} detailTitle={t('fin.tx_detail')}
      detail={openId ? <Detail id={openId} scope={scope} /> : null}
      list={(
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip label={t('fin.all_kinds')} active={!kind} onPress={() => setKind(null)} />
            {['payment', 'refund', 'chargeback', 'charge', 'payout'].map((k) => <Chip key={k} label={kindLabel(k)} active={kind === k} onPress={() => setKind(k)} />)}
          </View>
          {state.error ? <ErrorBox error={state.error} onRetry={() => load(0)} /> : state.loading && !rows.length ? <Loading /> : !rows.length ? (
            <Empty emoji="🧾" title={t('fin.tx_empty_title')} sub={t('fin.tx_empty_sub')} />
          ) : rows.map((r) => <TxRow key={r.id} r={r} onPress={() => setOpenId(r.id)} />)}
          {more ? <Btn small title={t('fin.show_more')} color={c.paper} ink={c.ink} loading={state.loading} onPress={() => load(rows.length)} style={{ alignSelf: 'flex-start' }} /> : null}
          {rows.length && atLeast(level, 'accountant') ? <Btn small title={t('fin.export')} color={c.paper} ink={c.ink} onPress={exportCsv} style={{ alignSelf: 'flex-start' }} /> : null}
        </View>
      )}
    />
  );
}

function Reconciliation({ scope, whole, platform, level, onChanged, toast }) {
  const items = useLoad(() => api.get('/finance/reconciliation', { ...scope, status: 'open', limit: 50 }), [whole, scope.organisation_id]);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { const r = await api.post('/admin/finance/reconcile', {}); toast(t('fin.recon.done', { backfilled: r.backfilled, repaired: r.refunds_repaired, open: r.open_items })); items.reload(); onChanged(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const [closing, setClosing] = useState(null);
  const [reason, setReason] = useState('');
  const canClose = (x) => x.source === 'canonical' && ((platform && whole) || (!whole && atLeast(level, 'accountant')));
  const resolve = async () => {
    try {
      if (whole) await api.post(`/admin/finance/reconciliation/${closing.id}/resolve`, { reason });
      else await api.post(`/finance/reconciliation/${closing.id}/resolve`, { organisation_id: scope.organisation_id, reason });
      toast(t('fin.recon.closed')); setClosing(null); setReason(''); items.reload(); onChanged();
    } catch (e) { toast(e.message); }
  };
  return (
    <View style={{ gap: 10 }}>
      <T color={c.mute} size={13}>{t('fin.recon.intro')}</T>
      {platform && whole ? <Btn small title={t('fin.recon.run')} loading={busy} onPress={run} style={{ alignSelf: 'flex-start' }} /> : null}
      {items.error ? <ErrorBox error={items.error} onRetry={items.reload} /> : !items.data ? <Loading /> : !items.data.length ? <Empty emoji="✅" title={t('fin.recon.ok_title')} sub={t('fin.recon.ok_sub')} /> : items.data.map((x) => (
        <Row key={`${x.source}-${x.id}`} title={RECON_KINDS.includes(x.kind) ? t(`fin.recon.${x.kind}`) : String(x.kind).replace(/_/g, ' ')}
          sub={`${x.source === 'settlement' ? t('fin.recon.provider') : t('fin.recon.ledger')} · ${x.currency ?? ''} ${x.amount_minor != null ? money(x.amount_minor, x.currency ?? 'INR') : ''} · ${day(x.created_at)}`}
          right={<><Tag label={t('fin.recon.tag')} color={c.orangeSoft} />{canClose(x) ? <Btn small title={t('fin.recon.close')} color={c.paper} ink={c.ink} onPress={() => setClosing(x)} /> : null}</>} />
      ))}
      <Sheet visible={!!closing} onClose={() => setClosing(null)} title={t('fin.recon.close_title')}>
        <T color={c.mute} size={13}>{t('fin.recon.close_help')}</T>
        <Field label={t('fin.recon.reason')} value={reason} onChangeText={setReason} multiline placeholder={t('fin.recon.reason_ph')} hint={t('fin.recon.reason_hint')} />
        <Btn title={t('fin.recon.close_title')} disabled={reason.trim().length < 5} onPress={resolve} />
      </Sheet>
    </View>
  );
}
