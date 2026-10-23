// Sponsorship reports (#305): financial ageing, award funnel, beneficiary outcomes, fulfilment and renewals, with CSV / XLSX / branded PDF export,
// saved filters and scheduled delivery. One screen, read live from the agreements under the caller's current role: the server decides what each
// person may see, so a revoked role or consent shows nothing here either. Amounts are minor units in their own currency and are never added across currencies.
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { CurrencyDropdown } from '../currency-dropdown';
import { DateField, DateRangeField, Counter } from '../pickers';
import { EntityPicker } from '../entity-picker';

const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const PAGE = 20;
const KINDS = [{ value: 'ageing', label: 'Ageing' }, { value: 'funnel', label: 'Funnel' }, { value: 'outcomes', label: 'Outcomes' }, { value: 'fulfilment', label: 'Fulfilment' }, { value: 'renewals', label: 'Renewals' }];
const BLURB = {
  ageing: 'Instalments by how long they are past due. Cash is confirmed payments only; goods and endorsement estimates are shown apart and are never cash.',
  funnel: 'Applications to offers to awards, by program. An offer is not an award until it is accepted.',
  outcomes: 'Agreed objectives against the athlete’s own results, only while the athlete shares them.',
  fulfilment: 'Goods and endorsements. A shipment or a post only counts as delivered once the other side confirms it.',
  renewals: 'Agreements ending soon or already ended, with both sides’ intentions and any renewal.',
};
const BUCKETS = [['current_cents', 'Not yet due'], ['d1_30_cents', '1–30 days'], ['d31_60_cents', '31–60 days'], ['d61_90_cents', '61–90 days'], ['over_90_cents', 'Over 90 days'], ['on_hold_cents', 'On hold (paused)']];
const BUCKET_CHIPS = [{ value: null, label: 'All ages' }, { value: 'current', label: 'Not due' }, { value: '1_30', label: '1–30' }, { value: '31_60', label: '31–60' }, { value: '61_90', label: '61–90' }, { value: 'over_90', label: '90+' }, { value: 'on_hold', label: 'On hold' }];
const STATE_CHIPS = [{ value: null, label: 'All' }, { value: 'overdue', label: 'Overdue' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'in_transit', label: 'In transit' }, { value: 'awaiting_review', label: 'To review' }, { value: 'on_hold', label: 'On hold' }, { value: 'fulfilled', label: 'Fulfilled' }];
const BUCKET_WORD = { current: 'Not yet due', '1_30': '1–30 days', '31_60': '31–60 days', '61_90': '61–90 days', over_90: 'Over 90 days', on_hold: 'On hold (paused)' };
const SRC_TONE = { ok: c.lime, stale: c.sunSoft, missing: c.pinkSoft };
const SRC_WORD = { ok: 'Current', stale: 'Stale', missing: 'Missing' };
const CADENCE = [{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }];
const FORMATS = [{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'XLSX' }, { value: 'pdf', label: 'PDF' }];
const todayIso = () => new Date().toISOString().slice(0, 10);
const tomorrowIso = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const word = (k) => k.replace(/_cents$/, '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

const Banner = ({ tone = c.sunSoft, children, action, onAction }) => (
  <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <T size={13} style={{ flex: 1 }}>{children}</T>
    {action ? <Btn small title={action} color={c.paper} ink={c.ink} onPress={onAction} /> : null}
  </View>
);

/** Every missing or stale source is named, with what it means for the numbers; a clean report says so in one line. */
function Sources({ sources }) {
  const bad = sources.filter((s) => s.status !== 'ok');
  if (!bad.length) return <Banner tone={c.lime}>All data sources are current: {sources.map((s) => s.label).join(', ')}.</Banner>;
  return (
    <View style={{ gap: 8 }}>
      {bad.map((s) => (
        <View key={s.key} accessibilityRole="alert" style={{ backgroundColor: SRC_TONE[s.status], borderRadius: 12, padding: 12, gap: 2 }}>
          <T size={12} weight="800">{SRC_WORD[s.status].toUpperCase()} · {s.label}</T>
          <T size={13}>{s.detail}</T>
        </View>))}
    </View>
  );
}

const Stat = ({ label, value, tone }) => (
  <View style={{ minWidth: 110 }}><T size={11} color={c.mute}>{label}</T><T size={15} weight="800" color={tone ?? c.ink}>{value}</T></View>
);

/** Per currency: cash apart from estimates, then the age buckets. Never added across currencies. */
function AgeingTotals({ totals }) {
  return totals.map((t) => (
    <Card key={t.currency} color={c.paper}>
      <View style={{ gap: 10 }} accessible accessibilityLabel={`${t.currency}: cash outstanding ${fmt(t.outstanding_cents, t.currency)}, estimates ${fmt(t.estimate_cents, t.currency)}`}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" color={c.mute}>{t.currency}</T>{t.converted ? <Tag label="Converted at sourced rate" color={c.violetSoft} /> : null}</View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8 }}>
          <Stat label="Committed" value={fmt(t.committed_cents, t.currency)} />
          <Stat label="Cash confirmed" value={fmt(t.cash_confirmed_cents, t.currency)} />
          <Stat label="Reported, unconfirmed" value={fmt(t.reported_unverified_cents, t.currency)} />
          <Stat label="Cash outstanding" value={fmt(t.outstanding_cents, t.currency)} tone={t.outstanding_cents > 0 ? c.pink : c.ink} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8 }}>
          {BUCKETS.filter(([k]) => t[k] > 0).map(([k, l]) => <Stat key={k} label={l} value={fmt(t[k], t.currency)} tone={k === 'over_90_cents' || k === 'd61_90_cents' ? c.pink : c.ink} />)}
          {BUCKETS.every(([k]) => !t[k]) ? <T size={12} color={c.mute}>Nothing outstanding.</T> : null}
        </View>
        <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8 }}><Stat label="Estimates, not cash (goods and endorsements)" value={fmt(t.estimate_cents, t.currency)} /></View>
      </View>
    </Card>));
}

/** Any other report: each totals object is a tile; money keys use their own currency. */
const GenericTotals = ({ totals }) => totals.map((t, i) => (
  <Card key={i} color={c.paper}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8 }}>
      {t.currency ? <View style={{ width: '100%' }}><T weight="800" color={c.mute}>{t.currency}</T></View> : null}
      {Object.entries(t).filter(([k, v]) => k !== 'currency' && v !== null && v !== false).map(([k, v]) => <Stat key={k} label={word(k)} value={k.endsWith('_cents') ? fmt(v, t.currency) : String(v)} />)}
    </View>
  </Card>));

const show = (col, row) => {
  const v = row[col.key];
  if (v === null || v === undefined || v === '') return '—';
  if (col.type === 'money') return fmt(v, row.currency);
  if (col.key === 'bucket') return BUCKET_WORD[v] ?? v;
  return String(v).replace(/_/g, ' ');
};

function Rows({ report, offset, onPage, loading, filtered, onClear }) {
  const cols = report.columns;
  const [first, ...rest] = cols.filter((x) => !['basis', 'currency', 'native_currency'].includes(x.key));
  if (!report.rows.length) return <Empty emoji={filtered ? '🔎' : '📊'} title={filtered ? 'Nothing matches these filters' : 'Nothing to report yet'} sub={filtered ? 'Widen the dates or clear a filter.' : 'Rows appear here as soon as agreements, applications or payments exist for the brands you can report on.'} />;
  return (
    <View style={{ gap: 10 }}>
      {report.rows.map((r, i) => (
        <Card key={`${offset}-${i}`} color={c.paper} accessibilityLabel={cols.map((x) => `${x.label} ${show(x, r)}`).join(', ')}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <T weight="800" size={15} style={{ flex: 1 }}>{show(first, r)}{r.currency ? ` · ${r.currency}` : ''}</T>
              {r.basis === 'estimate' ? <Tag label="Estimate — not cash" color={c.sunSoft} /> : null}
              {r.bucket && r.bucket !== 'current' ? <Tag label={BUCKET_WORD[r.bucket]} color={r.bucket === 'over_90' || r.bucket === '61_90' ? c.pinkSoft : c.sunSoft} /> : null}
              {r.converted ? <Tag label={`from ${r.native_currency}`} color={c.violetSoft} /> : null}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6 }}>
              {rest.filter((x) => r[x.key] !== null && r[x.key] !== undefined && r[x.key] !== '').map((x) => <Stat key={x.key} label={x.label} value={show(x, r)} />)}
            </View>
          </View>
        </Card>))}
      {report.total_rows > PAGE ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Btn small title="Previous" color={c.paper} ink={c.ink} disabled={offset === 0 || loading} onPress={() => onPage(Math.max(0, offset - PAGE))} />
          <T size={12} color={c.mute} accessibilityLiveRegion="polite">{offset + 1}–{Math.min(offset + PAGE, report.total_rows)} of {report.total_rows}</T>
          <Btn small title="Next" color={c.paper} ink={c.ink} disabled={offset + PAGE >= report.total_rows || loading} onPress={() => onPage(offset + PAGE)} />
        </View>) : null}
      {filtered ? <Btn small title="Clear filters" color={c.paper} ink={c.ink} onPress={onClear} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}

const save = (out) => {
  if (typeof document === 'undefined') return false;
  const bytes = out.encoding === 'base64' ? Uint8Array.from(atob(out.content), (ch) => ch.charCodeAt(0)) : out.content;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: out.content_type })); a.download = out.filename; a.click();
  return true;
};

export function SponsorReports() {
  const { toast } = useSession();
  const [view, setView] = useState('sponsor');
  const [kind, setKind] = useState('ageing');
  const [asOf, setAsOf] = useState();
  const [brands, setBrands] = useState([]);
  const [program, setProgram] = useState([]);
  const [range, setRange] = useState({});
  const [basis, setBasis] = useState('native');
  const [currency, setCurrency] = useState();
  const [bucket, setBucket] = useState(null);
  const [state, setState] = useState(null);
  const [windowDays, setWindowDays] = useState(90);
  const [offset, setOffset] = useState(0);
  const [saved, setSaved] = useState(null); // the saved filter these parameters came from
  const [sheet, setSheet] = useState(null); // 'save' | 'schedule' | null
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false); // the filter controls are folded away on small screens: the numbers come first

  const params = useMemo(() => ({
    view, ...(asOf ? { as_of: asOf } : {}), ...(brands.length ? { sponsor_ids: brands.map((b) => b.id).join(',') } : {}), ...(program[0] ? { program_id: program[0].id } : {}),
    ...(range.from ? { from: range.from, to: range.to ?? range.from } : {}), ...(basis === 'reporting' && currency ? { currency_basis: 'reporting', currency } : {}),
    ...(kind === 'ageing' && bucket ? { bucket } : {}), ...(kind === 'fulfilment' && state ? { state } : {}), ...(kind === 'renewals' ? { window_days: windowDays } : {}),
  }), [view, asOf, brands, program, range, basis, currency, bucket, state, windowDays, kind]);
  const rep = useLoad(() => (basis === 'reporting' && !currency ? Promise.resolve(null) : api.get(`/sponsorship-reports/${kind}`, { ...params, limit: PAGE, offset })), [kind, JSON.stringify(params), offset]);
  const brandList = useLoad(() => api.get('/sponsors', { mine: true, limit: 50 }), []);
  const programs = useLoad(() => api.get('/sponsorship-programs', { limit: 100, ...(brands.length === 1 ? { sponsor_id: brands[0].id } : {}) }).catch(() => []), [brands.map((b) => b.id).join(',')]);
  const kits = useLoad(() => api.get('/brand-kits').catch(() => []), []);
  const filters = useLoad(() => api.get('/sponsorship-report-filters', { kind, limit: 50 }).catch(() => []), [kind]);
  const schedules = useLoad(() => api.get('/sponsorship-report-schedules', { limit: 50 }).catch(() => []), []);
  const runs = useLoad(() => api.get('/sponsorship-report-runs', { limit: 10 }).catch(() => []), []);
  const d = rep.data;
  useEffect(() => { setOffset(0); }, [kind, JSON.stringify(params)]);
  useEffect(() => { if (view === 'recipient') setBrands([]); }, [view]);
  // a person who runs no brand is a beneficiary: start there instead of on a denied screen
  useEffect(() => { if (brandList.data && !brandList.data.length) setView('recipient'); }, [brandList.data]);

  const filtered = !!(asOf || brands.length || program.length || range.from || bucket || state || basis === 'reporting');
  const summary = [`As of ${asOf ?? 'today'}`, brands.length ? brands.map((b) => b.label).join(', ') : view === 'sponsor' ? 'all my brands' : 'my agreements', program[0]?.label, range.from ? `${range.from} → ${range.to ?? range.from}` : null,
    basis === 'reporting' && currency ? `converted to ${currency}` : 'each currency apart', bucket ? `age ${bucket.replace('_', '–')}` : null, state ? state.replace('_', ' ') : null].filter(Boolean).join(' · ');
  const clear = () => { setAsOf(undefined); setBrands([]); setProgram([]); setRange({}); setBasis('native'); setBucket(null); setState(null); setSaved(null); };
  const apply = (f) => {
    const p = f.params ?? {};
    setSaved(f); setView(f.view); setAsOf(p.as_of); setRange(p.from ? { from: p.from, to: p.to } : {}); setBasis(p.currency_basis ?? 'native'); setCurrency(p.currency); setBucket(p.bucket ?? null); setState(p.state ?? null); setWindowDays(p.window_days ?? 90);
    setBrands((brandList.data ?? []).filter((b) => (p.sponsor_ids ?? []).includes(b.id)).map((b) => ({ id: b.id, label: b.name, emoji: b.emoji })));
    setProgram([]);
  };
  const exportAs = async (format, kit) => {
    setBusy(true);
    try {
      const out = await api.get(`/sponsorship-reports/${kind}/export`, { ...params, format, ...(kit ? { kit_id: kit } : {}) });
      toast(save(out) ? `Exported ${out.rows} rows as ${format.toUpperCase()}` : `${out.rows} rows ready — open this on the web to download`);
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const [kit, setKit] = useState([]);

  const views = <Seg options={[{ value: 'sponsor', label: 'Brands I run' }, { value: 'recipient', label: 'I am the beneficiary' }]} value={view} onChange={setView} />;
  if (rep.error && !d) return <Screen><H1>Sponsorship reports</H1>{views}<LoadError error={rep.error} onRetry={rep.reload} /></Screen>;
  return (
    <Screen refreshing={rep.loading && !!d} onRefresh={rep.reload}>
      <H1>Sponsorship reports</H1>
      <T size={13} color={c.mute}>{BLURB[kind]}</T>
      {views}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{KINDS.map((k) => <Chip key={k.value} label={k.label} active={kind === k.value} onPress={() => { setKind(k.value); setBucket(null); setState(null); }} />)}</View>

      <Section title="Saved filters" color={c.violet}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {(filters.data ?? []).map((f) => <Chip key={f.id} label={f.name} active={saved?.id === f.id} onPress={() => apply(f)} />)}
          {!(filters.data ?? []).length ? <T size={12} color={c.mute}>No saved filters for this report yet.</T> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="Save these filters" color={c.violet} onPress={() => setSheet('save')} />
          {saved ? <Btn small title="Update saved filter" color={c.paper} ink={c.ink} onPress={async () => { try { const u = await api.patch(`/sponsorship-report-filters/${saved.id}`, { row_version: saved.row_version, params }); setSaved(u); filters.reload(); toast('Filter updated'); } catch (e) { toast(explain(e)); filters.reload(); } }} /> : null}
          {saved ? <Btn small title="Archive" color={c.paper} ink={c.ink} onPress={async () => { try { await api.post(`/sponsorship-report-filters/${saved.id}/archive`, { row_version: saved.row_version }); setSaved(null); filters.reload(); schedules.reload(); toast('Filter archived'); } catch (e) { toast(explain(e)); filters.reload(); } }} /> : null}
          {saved && view === 'sponsor' ? <Btn small title="Schedule delivery" color={c.pink} onPress={() => setSheet('schedule')} /> : null}
        </View>
      </Section>

      <Section title="Basis and filters" color={c.cyan}>
        <Card color={c.paper} onPress={() => setOpen(!open)} accessibilityLabel={`Filters, ${open ? 'hide' : 'show'}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T size={13} style={{ flex: 1 }}>{summary}</T><T weight="800" color={c.violet}>{open ? 'Hide ▲' : 'Change ▼'}</T>
          </View>
        </Card>
        {open ? <View style={{ gap: 12 }}>
        <DateField label="Reporting date" value={asOf} onChange={setAsOf} optional max={todayIso()} hint={asOf ? undefined : 'Today. Pick an earlier date to see the position as it was.'} />
        {view === 'sponsor' ? <EntityPicker label="Brands" multi optional noun="brand" value={brands} onChange={setBrands} options={(brandList.data ?? []).map((b) => ({ id: b.id, label: b.name, sub: b.my_role, emoji: b.emoji }))} /> : null}
        {view === 'sponsor' && ['ageing', 'funnel', 'fulfilment', 'renewals'].includes(kind) ? <EntityPicker label="Program" optional noun="program" value={program} onChange={setProgram} options={(programs.data ?? []).map((p) => ({ id: p.id, label: p.name, sub: p.status }))} /> : null}
        {kind !== 'ageing' && kind !== 'outcomes' ? <DateRangeField label={kind === 'funnel' ? 'Applications submitted between' : kind === 'renewals' ? 'Ending between' : 'Due between'} from={range.from} to={range.to} onChange={setRange} optional /> : null}
        {kind === 'renewals' ? <Counter label="Look ahead" value={windowDays} onChange={setWindowDays} min={7} max={365} step={7} suffix=" days" /> : null}
        {kind === 'ageing' ? <><T size={12} weight="600" color={c.mute}>CURRENCY BASIS</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Chip label="Each currency apart" active={basis === 'native'} onPress={() => setBasis('native')} /><Chip label="Convert at sourced rates" active={basis === 'reporting'} onPress={() => setBasis('reporting')} /></View>
          {basis === 'reporting' ? <><CurrencyDropdown label="Reporting currency" value={currency} onChange={setCurrency} suggest={false} hint="Only amounts whose agreement records a sourced budget FX rate are converted; the rest stay in their own currency and are flagged." />{!currency ? <Banner>Pick the reporting currency to see converted figures.</Banner> : null}</> : null}
          <T size={12} weight="600" color={c.mute}>AGE</T><Seg options={BUCKET_CHIPS} value={bucket} onChange={setBucket} /></> : null}
        {kind === 'fulfilment' ? <Seg options={STATE_CHIPS} value={state} onChange={setState} /> : null}
        {filtered ? <Btn small title="Reset" color={c.paper} ink={c.ink} onPress={clear} style={{ alignSelf: 'flex-start' }} /> : null}
        </View> : null}
      </Section>

      {rep.error ? <Banner tone={c.pinkSoft} action="Try again" onAction={rep.reload}>{explain(rep.error)}</Banner> : null}
      {rep.loading && !d ? <Loading /> : d ? (
        <>
          <Card color={c.paper}>
            <T size={12} color={c.mute} accessibilityLiveRegion="polite">As of <T size={12} weight="800">{d.basis.as_of}</T> · {d.basis.currency_basis === 'reporting' ? `converted to ${d.basis.currency}` : 'each currency apart'} · cash and estimates separate · read {new Date(d.basis.generated_at).toLocaleTimeString()}</T>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              {d.reconciles === false ? <Tag label="Does not reconcile — do not use" color={c.pinkSoft} /> : <Tag label="Reconciles to source" color={c.lime} />}
              <Btn small title="Refresh" color={c.paper} ink={c.ink} onPress={rep.reload} />
            </View>
          </Card>
          <Sources sources={d.sources} />
          {d.totals.length ? <Section title="Totals" color={c.cyan}>{kind === 'ageing' ? <AgeingTotals totals={d.totals} /> : <GenericTotals totals={d.totals} />}</Section> : null}
          <Section title={`${d.total_rows} ${d.total_rows === 1 ? 'row' : 'rows'}`} color={c.sun}>
            <Rows report={d} offset={offset} onPage={setOffset} loading={rep.loading} filtered={filtered} onClear={clear} />
          </Section>
          <Section title="Export" color={c.violet}>
            <T size={12} color={c.mute}>Built from exactly these rows, under your current role{kind === 'outcomes' ? ' and the athlete’s current consent' : ''}. Amounts are exported in minor units with their currency.</T>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title="CSV" color={c.violet} loading={busy} onPress={() => exportAs('csv')} />
              <Btn small title="XLSX" color={c.violet} loading={busy} onPress={() => exportAs('xlsx')} />
              <Btn small title="Branded PDF" color={c.violet} loading={busy} onPress={() => exportAs('pdf', kit[0]?.id)} />
            </View>
            <EntityPicker label="Brand kit for the PDF" optional noun="brand kit" value={kit} onChange={setKit} options={(kits.data ?? []).map((k) => ({ id: k.id, label: k.display_name ?? k.name }))} />
          </Section>
        </>) : null}

      <Section title="Scheduled delivery" color={c.pink}>
        {(schedules.data ?? []).length ? schedules.data.map((s) => (
          <Card key={s.id} color={c.paper}>
            <View style={{ gap: 6 }}>
              <T weight="800">{s.filter_name} · {s.cadence} · {s.format.toUpperCase()}</T>
              <T size={12} color={c.mute}>{s.paused_at ? 'Paused' : `Next ${s.next_run_on}`}{s.last_run_on ? ` · last ${s.last_run_on}` : ''} · {s.recipient_ids.length} recipient{s.recipient_ids.length > 1 ? 's' : ''}</T>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn small title={s.paused_at ? 'Resume' : 'Pause'} color={c.paper} ink={c.ink} onPress={async () => { try { await api.patch(`/sponsorship-report-schedules/${s.id}`, { row_version: s.row_version, paused: !s.paused_at }); } catch (e) { toast(explain(e)); } schedules.reload(); }} />
                <Btn small title="Stop" color={c.paper} ink={c.ink} onPress={async () => { try { await api.patch(`/sponsorship-report-schedules/${s.id}`, { row_version: s.row_version, archived: true }); } catch (e) { toast(explain(e)); } schedules.reload(); }} />
              </View>
            </View>
          </Card>)) : <T size={13} color={c.mute}>Nothing scheduled. Save a filter, then choose “Schedule delivery” to get it weekly, monthly or quarterly.</T>}
        {(runs.data ?? []).filter((r) => r.mine).map((r) => (
          <Card key={r.id} color={c.paper}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}><T weight="800">{r.filter_name}</T><T size={12} color={c.mute}>As of {r.as_of} · {r.status === 'delivered' ? `${r.row_count} rows` : r.status.replace(/_/g, ' ')}</T></View>
              {r.status === 'delivered' ? <Btn small title="Download" color={c.violet} onPress={async () => { try { const out = await api.get(`/sponsorship-report-runs/${r.id}`, { download: true }); toast(save(out) ? 'Downloaded' : 'Open this on the web to download'); } catch (e) { toast(explain(e)); } }} /> : null}
            </View>
          </Card>))}
      </Section>

      <SaveSheet visible={sheet === 'save'} onClose={() => setSheet(null)} kind={kind} view={view} params={params} onSaved={(f) => { setSaved(f); filters.reload(); setSheet(null); toast('Filter saved'); }} />
      <ScheduleSheet visible={sheet === 'schedule'} onClose={() => setSheet(null)} filter={saved} onDone={() => { schedules.reload(); setSheet(null); toast('Delivery scheduled'); }} />
    </Screen>
  );
}

function SaveSheet({ visible, onClose, kind, view, params, onSaved }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const go = async () => {
    setErr(null);
    try {
      const { view: _v, sponsor_ids, ...rest } = params;
      onSaved(await api.post('/sponsorship-report-filters', { name, kind, view, params: { ...rest, ...(sponsor_ids ? { sponsor_ids: sponsor_ids.split(',') } : {}) } }));
      setName('');
    } catch (e) { setErr(explain(e)); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Save these filters">
      <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Monthly ageing, all brands" maxLength={80} />
      <T size={12} color={c.mute}>Without a reporting date, the filter reports as of the day it is opened or delivered. A saved filter holds no data and no access; your role is checked every time.</T>
      {err ? <Banner tone={c.pinkSoft}>{err}</Banner> : null}
      <Btn title="Save filter" color={c.violet} disabled={name.trim().length < 2} onPress={go} />
    </Sheet>
  );
}

function ScheduleSheet({ visible, onClose, filter, onDone }) {
  const { user } = useSession();
  const [cadence, setCadence] = useState('monthly');
  const [format, setFormat] = useState('xlsx');
  const [first, setFirst] = useState(tomorrowIso());
  const [people, setPeople] = useState([]);
  const [err, setErr] = useState(null);
  const go = async () => {
    setErr(null);
    try { await api.post('/sponsorship-report-schedules', { filter_id: filter.id, cadence, format, first_run_on: first, recipient_ids: people.length ? people.map((p) => p.id) : [user.id] }); onDone(); } catch (e) { setErr(explain(e)); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Schedule delivery">
      <T size={13}>{filter ? `Deliver “${filter.name}”.` : ''} Each person gets a notice with no figures in it; the report is read under their own role when they open it.</T>
      <T size={12} weight="600" color={c.mute}>HOW OFTEN</T><Seg options={CADENCE} value={cadence} onChange={setCadence} />
      <T size={12} weight="600" color={c.mute}>FORMAT</T><Seg options={FORMATS} value={format} onChange={setFormat} />
      <DateField label="First delivery" value={first} onChange={setFirst} min={tomorrowIso()} />
      <EntityPicker label="Send to" multi optional noun="person" value={people} onChange={setPeople} />
      <T size={12} color={c.mute}>{people.length ? 'Each recipient needs a role that may read sponsorship reports.' : 'Just you, unless you add people.'}</T>
      {err ? <Banner tone={c.pinkSoft}>{err}</Banner> : null}
      <Btn title="Schedule" color={c.pink} onPress={go} />
    </Sheet>
  );
}
