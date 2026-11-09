// Referee tax settings and reports (#1020 R39).
// 4-tab screen: Tax Profile / Earnings / Invoices / Statements.
// API-first: every read and write goes through /me/official-tax-* capabilities.
// Works on iOS, iPadOS, Android and web. Phone, tablet and desktop widths.
import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { saveExport } from '../open-file';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, GradCard, H1, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField, DateRangeField } from '../pickers';
import { MenuField } from '../menu-field';
import { Counter } from '../pickers';
import { SwitchRow } from '../federation-bits';
import { c, money as moneyFmt } from '../theme';
import { t } from '../i18n';
import { openPdf } from '../open-file';
import { Kpi } from './academy-ui';

const TABS = ['profile', 'earnings', 'invoices', 'statements'];
const TAB_LABELS = { profile: t('otax.tab.profile'), earnings: t('otax.tab.earnings'), invoices: t('otax.tab.invoices'), statements: t('otax.tab.statements') };

const PAYEE_TYPES = [{ value: 'individual', label: t('otax.payee.individual') }, { value: 'company', label: t('otax.payee.company') }];
const REG_STATUSES = [
  { value: 'registered', label: t('otax.reg.registered') },
  { value: 'not_registered', label: t('otax.reg.not_registered') },
  { value: 'pending', label: t('otax.reg.pending') },
  { value: 'exempt', label: t('otax.reg.exempt') },
];
const TAX_REGIMES = [
  { value: 'none', label: t('otax.regime.none') },
  { value: 'gst', label: t('otax.regime.gst') },
  { value: 'vat', label: t('otax.regime.vat') },
  { value: 'sales_tax', label: t('otax.regime.sales_tax') },
  { value: 'hst', label: t('otax.regime.hst') },
  { value: 'consumption_tax', label: t('otax.regime.consumption_tax') },
];
const TAX_CLASSES = [
  { value: 'standard', label: t('otax.class.standard') },
  { value: 'zero_rated', label: t('otax.class.zero_rated') },
  { value: 'exempt', label: t('otax.class.exempt') },
  { value: 'out_of_scope', label: t('otax.class.out_of_scope') },
  { value: 'reverse_charge', label: t('otax.class.reverse_charge') },
  { value: 'reduced', label: t('otax.class.reduced') },
];
const GRANULARITIES = [
  { value: 'month', label: t('otax.granularity.month') },
  { value: 'quarter', label: t('otax.granularity.quarter') },
  { value: 'year', label: t('otax.granularity.year') },
];
const BASES = [{ value: 'billed', label: t('otax.basis.billed') }, { value: 'collected', label: t('otax.basis.collected') }];

const REG_STATUS_COLOR = {
  registered: c.mintSoft, not_registered: c.violetSoft, pending: c.sunSoft, exempt: c.cyanSoft,
};
const REG_STATUS_INK = {
  registered: c.mint, not_registered: c.mute, pending: c.sun, exempt: c.cyan,
};

const pct = (bp) => (bp == null ? '' : `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`);
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const today = () => new Date().toISOString().slice(0, 10);
const thisYear = () => new Date().getFullYear();
const cash = (minor, cur) => moneyFmt(Number(minor ?? 0), cur);

// ---- main export -----------------------------------------------------------

export function OfficialTax({ navigation }) {
  const { toast } = useSession();
  const L = useLayout();
  const [tab, setTab] = useState('profile');

  return (
    <Screen>
      <GradCard style={{ marginBottom: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
        <H1 style={{ color: '#fff', marginTop: 0 }}>⚖️ {t('otax.title')}</H1>
        <T size={13} style={{ color: 'rgba(255,255,255,.75)' }}>{t('otax.subtitle')}</T>
        <Seg
          style={{ marginTop: 14 }}
          options={TABS.map((v) => ({ value: v, label: TAB_LABELS[v] }))}
          value={tab}
          onChange={setTab}
          dark
        />
      </GradCard>
      {tab === 'profile' && <ProfileTab toast={toast} L={L} />}
      {tab === 'earnings' && <EarningsTab toast={toast} L={L} />}
      {tab === 'invoices' && <InvoicesTab toast={toast} L={L} />}
      {tab === 'statements' && <StatementsTab toast={toast} L={L} />}
    </Screen>
  );
}

// ============================================================ TAX PROFILE TAB

function ProfileTab({ toast, L }) {
  const data = useLoad(() => api.get('/me/official-tax-profile'), []);
  const jurisdictions = useLoad(() => api.get('/tax-jurisdictions'), []);
  const [editing, setEditing] = useState(false);
  const [addingRate, setAddingRate] = useState(false);
  const reload = () => { data.reload(); };

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const prof = data.data?.current;
  const history = data.data?.history ?? [];
  const rates = data.data?.rates ?? [];
  const stdRate = rates.filter((r) => r.tax_class === 'standard').sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from))[0];

  return (
    <View style={{ flex: 1 }}>
      {/* Status banner */}
      <View style={{ marginHorizontal: 16, marginTop: 16 }}>
        {prof ? (
          <Card color={prof.registration_status === 'registered' ? c.mintSoft : c.sunSoft}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <T size={22}>{prof.registration_status === 'registered' ? '✅' : '📋'}</T>
              <View style={{ flex: 1 }}>
                <T weight="800" style={{ color: prof.registration_status === 'registered' ? c.mint : c.sun }}>
                  {prof.registration_status === 'registered' ? t('otax.profile.complete') : t('otax.profile.setup')}
                </T>
                <T size={12} color={c.mute}>
                  {[prof.tax_country, prof.tax_regime?.toUpperCase(), stdRate ? pct(stdRate.rate_bp) : null].filter(Boolean).join(' · ')}
                </T>
              </View>
              <Btn small title={t('otax.edit')} onPress={() => setEditing(true)} style={{ minHeight: 44 }} />
            </View>
          </Card>
        ) : (
          <Card color={c.sunSoft}>
            <T weight="800" color={c.sun}>{t('otax.profile.none_title')}</T>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('otax.profile.none_sub')}</T>
            <Btn title={t('otax.profile.setup')} onPress={() => setEditing(true)} style={{ marginTop: 12 }} />
          </Card>
        )}
      </View>

      {prof ? (
        <>
          {/* Payee & registration */}
          <Section title={t('otax.section.payee')} color={c.violet}>
            <Card>
              <View style={{ gap: 10 }}>
                <Row title={t('otax.field.payee_type')} right={<Tag label={prof.payee_type === 'company' ? t('otax.payee.company') : t('otax.payee.individual')} color={c.pinkSoft} />} />
                <Row title={t('otax.field.legal_name')} right={<T weight="800">{prof.legal_name}</T>} />
                <Row title={t('otax.field.tax_country')} right={<T weight="800">{prof.tax_country}</T>} />
                <Row title={t('otax.field.tax_regime')} right={<T weight="800">{prof.tax_regime?.toUpperCase()}</T>} />
                <Row title={t('otax.field.reg_status')}
                  right={<Tag label={REG_STATUSES.find((r) => r.value === prof.registration_status)?.label ?? prof.registration_status} color={REG_STATUS_COLOR[prof.registration_status] ?? c.violetSoft} />} />
                {prof.registration_id ? (
                  <Row title={t('otax.field.reg_id')} right={<T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{prof.registration_id}</T>} />
                ) : null}
                {prof.payee_type === 'company' ? (
                  <Row title={t('otax.field.business_name')} right={<T weight="800">{prof.business_name ?? '—'}</T>} />
                ) : null}
                <Row title={t('otax.field.price_display')} right={<T weight="800">{prof.price_display === 'inclusive' ? t('otax.inclusive') : t('otax.exclusive')}</T>} />
                <Row title={t('otax.field.withholding')} right={
                  prof.withholding_applicable
                    ? <Tag label={`${pct(prof.withholding_rate_bp)} ${t('otax.withheld')}`} color={c.sunSoft} />
                    : <Tag label={t('otax.no_withholding')} color={c.mintSoft} />
                } />
              </View>
            </Card>
          </Section>

          {/* Tax rates */}
          <Section title={t('otax.section.rates')} color={c.cyan} action={t('otax.add_rate')} onAction={() => setAddingRate(true)}>
            {rates.length ? (
              <Card>
                <View style={{ gap: 0 }}>
                  {rates.map((r, i) => (
                    <Row key={r.id}
                      title={<View><T weight="800">{pct(r.rate_bp)} · {TAX_CLASSES.find((c) => c.value === r.tax_class)?.label ?? r.tax_class}</T><T size={12} color={c.mute}>{t('otax.from')} {isoDate(r.effective_from)}</T></View>}
                      right={<T size={11} color={c.mute} style={{ maxWidth: 140, textAlign: 'right' }} numberOfLines={2}>{r.source}</T>}
                    />
                  ))}
                </View>
              </Card>
            ) : <Empty emoji="📋" title={t('otax.rates.empty')} sub={t('otax.rates.empty_sub')} />}
          </Section>

          {/* Profile history */}
          {history.length > 1 ? (
            <Section title={t('otax.section.history')} color={c.mute}>
              <Card><View style={{ gap: 8 }}>
                {history.slice(0, 5).map((h, i) => (
                  <Row key={h.id} title={<View><T size={13}>{h.legal_name} · {h.tax_country} · {h.tax_regime?.toUpperCase()}</T><T size={11} color={c.mute}>{isoDate(h.effective_from)}</T></View>}
                    right={<Tag label={REG_STATUSES.find((r) => r.value === h.registration_status)?.label ?? h.registration_status} color={REG_STATUS_COLOR[h.registration_status] ?? c.violetSoft} />} />
                ))}
              </View></Card>
            </Section>
          ) : null}

          {/* Jurisdiction reference */}
          <Section title={t('otax.section.jurisdictions')} color={c.mute}>
            <Card color={c.violetSoft}>
              <T size={12} color={c.mute}>{t('otax.jurisdictions.hint')}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {(jurisdictions.data ?? []).slice(0, 10).map((j) => (
                  <Tag key={`${j.country_code}-${j.tax_regime}`} label={`${j.country_code} ${j.tax_regime?.toUpperCase()} ${pct(j.standard_rate_bp)}`} color={c.violetSoft} />
                ))}
              </View>
            </Card>
          </Section>
        </>
      ) : null}

      {/* Disclaimer */}
      <View style={{ marginHorizontal: 16, marginTop: 8 }}>
        <Card color={c.sunSoft}>
          <T size={12} color={c.mute}>{t('otax.disclaimer')}</T>
        </Card>
      </View>

      {/* Edit sheet */}
      <ProfileEditSheet visible={editing} onClose={() => setEditing(false)} current={prof} onSaved={() => { setEditing(false); reload(); toast(t('otax.profile.saved')); }} toast={toast} />
      <AddRateSheet visible={addingRate} onClose={() => setAddingRate(false)} onSaved={() => { setAddingRate(false); reload(); toast(t('otax.rate.saved')); }} toast={toast} />
    </View>
  );
}

function ProfileEditSheet({ visible, onClose, current, onSaved, toast }) {
  const empty = { payee_type: 'individual', legal_name: '', tax_country: '', tax_regime: 'none', registration_status: 'not_registered', registration_id: '', business_name: '', business_reg: '', price_display: 'inclusive', withholding_applicable: false, withholding_rate_bp: 0 };
  const [v, setV] = useState(null);
  const [busy, setBusy] = useState(false);
  const val = v ?? (current ? { ...current, withholding_rate_bp: current.withholding_rate_bp ?? 0 } : empty);
  const set = (k, x) => setV((p) => ({ ...(p ?? val), [k]: x }));

  const save = async () => {
    if (!val.legal_name.trim()) { toast(t('otax.err.legal_name')); return; }
    if (!val.tax_country.trim()) { toast(t('otax.err.tax_country')); return; }
    setBusy(true);
    try {
      await api.post('/me/official-tax-profile', {
        payee_type: val.payee_type, legal_name: val.legal_name.trim(), tax_country: val.tax_country.trim().toUpperCase(),
        tax_regime: val.tax_regime, registration_status: val.registration_status,
        registration_id: val.registration_id?.trim() || undefined,
        business_name: val.business_name?.trim() || undefined, business_reg: val.business_reg?.trim() || undefined,
        price_display: val.price_display, withholding_applicable: val.withholding_applicable,
        withholding_rate_bp: val.withholding_applicable ? val.withholding_rate_bp : undefined,
      });
      setV(null); onSaved();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };

  return (
    <FormSheet visible={visible} onClose={() => { setV(null); onClose(); }} title={t('otax.profile.edit_title')}
      submitLabel={t('otax.save')} onSubmit={save} loading={busy}
      notice={t('otax.profile.edit_notice')}
      fields={[
        { key: 'payee_type', label: t('otax.field.payee_type'), type: 'chips', options: PAYEE_TYPES },
        { key: 'legal_name', label: t('otax.field.legal_name'), type: 'text', placeholder: t('otax.ph.legal_name') },
        { key: 'tax_country', label: t('otax.field.tax_country'), type: 'text', placeholder: t('otax.ph.tax_country'), hint: t('otax.hint.tax_country') },
        { key: 'tax_regime', label: t('otax.field.tax_regime'), type: 'chips', options: TAX_REGIMES },
        { key: 'registration_status', label: t('otax.field.reg_status'), type: 'chips', options: REG_STATUSES },
        { key: 'registration_id', label: t('otax.field.reg_id'), type: 'text', placeholder: t('otax.ph.reg_id'), optional: true, hint: t('otax.hint.reg_id'), show: (v) => v.registration_status === 'registered' },
        { key: 'business_name', label: t('otax.field.business_name'), type: 'text', optional: true, show: (v) => v.payee_type === 'company' },
        { key: 'business_reg', label: t('otax.field.business_reg'), type: 'text', optional: true, show: (v) => v.payee_type === 'company' },
        { key: 'price_display', label: t('otax.field.price_display'), type: 'chips', options: [{ value: 'inclusive', label: t('otax.inclusive') }, { value: 'exclusive', label: t('otax.exclusive') }] },
        { key: 'withholding_applicable', label: t('otax.field.withholding'), type: 'switch' },
        { key: 'withholding_rate_bp', label: t('otax.field.withholding_rate'), type: 'stepper', min: 0, max: 5000, step: 50, suffix: 'bp', show: (v) => v.withholding_applicable },
      ]}
      initial={val}
    />
  );
}

function AddRateSheet({ visible, onClose, onSaved, toast }) {
  const [busy, setBusy] = useState(false);
  const save = async (v) => {
    setBusy(true);
    try {
      await api.post('/me/official-tax-rates', { tax_class: v.tax_class, rate_percent: v.rate_percent, source: v.source.trim() });
      onSaved();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('otax.rate.add_title')} submitLabel={t('otax.save')} onSubmit={save} loading={busy}
      notice={t('otax.rate.notice')}
      fields={[
        { key: 'tax_class', label: t('otax.field.tax_class'), type: 'chips', options: TAX_CLASSES },
        { key: 'rate_percent', label: t('otax.field.rate_percent'), type: 'stepper', min: 0, max: 100, step: 0.5, suffix: '%', default: 9 },
        { key: 'source', label: t('otax.field.source'), type: 'text', placeholder: t('otax.ph.source'), hint: t('otax.hint.source') },
      ]}
      initial={{ tax_class: 'standard', rate_percent: 0, source: '' }}
    />
  );
}

// ============================================================ EARNINGS TAB

function EarningsTab({ toast, L }) {
  const [period, setPeriod] = useState({ from: `${thisYear()}-01-01`, to: today() });
  const [basis, setBasis] = useState('billed');
  const [currency, setCurrency] = useState(null);
  const params = { from: period.from, to: period.to, basis, ...(currency ? { currency } : {}) };
  const report = useLoad(() => api.get('/me/official-earnings', params), [JSON.stringify(params)]);
  const [downloading, setDownloading] = useState(false);
  const [dlSheet, setDlSheet] = useState(false);

  const download = async (format) => {
    if (!currency) { toast(t('otax.earnings.select_currency')); return; }
    setDownloading(true);
    try {
      const r = await api.get('/me/official-tax-summary/download', { from: period.from, to: period.to, currency, format, basis });
      if (format === 'csv') await saveExport({ filename: r.filename, content_type: 'text/csv', encoding: 'utf8', content: r.csv });
      else await openPdf(`/me/official-tax-summary/download?from=${period.from}&to=${period.to}&currency=${currency}&format=pdf&basis=${basis}`, r.filename).catch((e) => toast(e.message));
    } catch (e) { toast(e.message); } finally { setDownloading(false); setDlSheet(false); }
  };

  const groups = report.data?.groups ?? [];
  const displayCurrencies = [...new Set(groups.map((g) => g.currency))];

  return (
    <View style={{ flex: 1, paddingBottom: 16 }}>
      {/* Controls */}
      <View style={{ marginHorizontal: 16, marginTop: 16, gap: 12 }}>
        <DateRangeField label={t('otax.earnings.period')} from={period.from} to={period.to} onChange={(f, t2) => setPeriod({ from: f, to: t2 })} />
        <Seg options={BASES} value={basis} onChange={setBasis} />
      </View>

      {report.error ? <ErrorBox error={report.error} onRetry={report.reload} style={{ margin: 16 }} /> :
        report.loading && !report.data ? <Loading /> :
        !groups.length ? <Empty emoji="📊" title={t('otax.earnings.empty')} sub={t('otax.earnings.empty_sub')} style={{ margin: 16 }} /> : (
          <>
            {/* Currency tabs if multiple */}
            {displayCurrencies.length > 1 ? (
              <View style={{ marginHorizontal: 16, marginTop: 12 }}>
                <Seg options={[{ value: null, label: t('otax.all') }, ...displayCurrencies.map((c) => ({ value: c, label: c }))]} value={currency} onChange={setCurrency} />
              </View>
            ) : null}

            {groups.filter((g) => !currency || g.currency === currency).map((g) => (
              <EarningsGroup key={`${g.currency}|${g.tax_class}`} g={g} L={L} />
            ))}
          </>
        )
      }

      {/* Download */}
      <View style={{ marginHorizontal: 16, marginTop: 8 }}>
        <Btn title={t('otax.earnings.download')} color={c.violet} onPress={() => setDlSheet(true)} style={{ minHeight: 44 }} />
      </View>

      <Sheet visible={dlSheet} onClose={() => setDlSheet(false)} title={t('otax.download.title')}>
        <T color={c.mute} size={13}>{t('otax.download.hint')}</T>
        <MenuField label={t('otax.download.currency')} value={currency} onChange={setCurrency} options={displayCurrencies.map((c) => ({ value: c, label: c }))} style={{ marginTop: 12 }} />
        <View style={{ gap: 8, marginTop: 12 }}>
          <Btn title={t('otax.download.csv')} color={c.violet} loading={downloading} onPress={() => download('csv')} style={{ minHeight: 44 }} />
          <Btn title={t('otax.download.pdf')} color={c.violet} loading={downloading} onPress={() => download('pdf')} style={{ minHeight: 44 }} />
        </View>
        <T size={12} color={c.mute} style={{ marginTop: 8 }}>{t('otax.disclaimer')}</T>
      </Sheet>
    </View>
  );
}

function EarningsGroup({ g, L }) {
  const [expanded, setExpanded] = useState(false);
  const fixtures = g.fixtures ?? [];
  const taxLabel = TAX_CLASSES.find((c) => c.value === g.tax_class)?.label ?? g.tax_class;
  return (
    <Section title={`${g.currency} · ${taxLabel}`} color={c.pink}>
      <View style={{ flexDirection: L.tablet ? 'row' : 'column', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
        <Kpi label={t('otax.kpi.gross')} value={cash(g.gross_minor, g.currency)} sub={`${g.lines} ${t('otax.fixtures')}`} />
        <Kpi label={t('otax.kpi.tax')} value={cash(g.tax_minor, g.currency)} sub={g.tax_class === 'standard' ? t('otax.kpi.tax_sub') : taxLabel} />
        {g.withholding_minor > 0 ? <Kpi label={t('otax.kpi.withholding')} value={cash(g.withholding_minor, g.currency)} /> : null}
        <Kpi label={t('otax.kpi.net')} value={cash(g.net_minor, g.currency)} sub={t('otax.kpi.net_sub')} />
      </View>
      {g.untaxed_taxable_lines > 0 ? (
        <Card color={c.sunSoft}><T size={12} color={c.sun}>{t('otax.earnings.untaxed_hint', { n: g.untaxed_taxable_lines })}</T></Card>
      ) : null}
      {fixtures.length ? (
        <>
          <Btn small title={expanded ? t('otax.earnings.hide_lines') : t('otax.earnings.show_lines', { n: fixtures.length })} onPress={() => setExpanded((x) => !x)} color={c.violetSoft} ink={c.violet} style={{ alignSelf: 'flex-start', marginBottom: 8, minHeight: 44 }} />
          {expanded ? (
            <Card>
              <View style={{ gap: 0 }}>
                {fixtures.map((f, i) => (
                  <Row key={f.fixture_id ?? i}
                    title={<View><T weight="700" size={13}>{f.event_name || '—'}</T><T size={11} color={c.mute}>{isoDate(f.at)}{f.role ? ` · ${f.role}` : ''}</T></View>}
                    right={<View style={{ alignItems: 'flex-end' }}><T weight="700" size={13}>{cash(f.gross_minor, g.currency)}</T><T size={11} color={c.mute}>{t('otax.tax_abbr')} {cash(f.tax_minor, g.currency)}</T></View>}
                  />
                ))}
              </View>
            </Card>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

// ============================================================ INVOICES TAB

function InvoicesTab({ toast, L }) {
  const [filters, setFilters] = useState({ kind: null, status: null, currency: null });
  const [generating, setGenerating] = useState(false);
  const [genSheet, setGenSheet] = useState(false);
  const [voidSheet, setVoidSheet] = useState(null);
  const [paySheet, setPaySheet] = useState(null);
  const list = useLoad(() => api.get('/me/official-tax-invoices', { ...filters }), [JSON.stringify(filters)]);
  const reload = () => list.reload();

  const KIND_TAG = {
    invoice: { label: t('otax.kind.invoice'), color: c.pinkSoft },
    credit_note: { label: t('otax.kind.credit_note'), color: c.cyanSoft },
  };
  const STATUS_TAG = {
    open: { label: t('otax.status.open'), color: c.sunSoft },
    paid: { label: t('otax.status.paid'), color: c.mintSoft },
    void: { label: t('otax.status.void'), color: c.violetSoft },
  };

  const invoices = list.data ?? [];

  return (
    <View style={{ flex: 1, paddingBottom: 16 }}>
      <View style={{ marginHorizontal: 16, marginTop: 16, gap: 10 }}>
        {/* Summary KPIs */}
        <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 10 }}>
          <Kpi label={t('otax.inv.total')} value={invoices.filter((x) => x.kind === 'invoice').length.toString()} sub={t('otax.inv.total_sub')} />
          <Kpi label={t('otax.inv.open_count')} value={invoices.filter((x) => x.status === 'open').length.toString()} sub={t('otax.inv.open_sub')} />
        </View>

        {/* Filters */}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {[null, 'invoice', 'credit_note'].map((k) => (
            <Chip key={k ?? 'all'} label={k == null ? t('otax.filter.all') : KIND_TAG[k].label} active={filters.kind === k} onPress={() => setFilters((f) => ({ ...f, kind: k }))} />
          ))}
          {['open', 'paid', 'void'].map((s) => (
            <Chip key={s} label={STATUS_TAG[s].label} active={filters.status === s} onPress={() => setFilters((f) => ({ ...f, status: filters.status === s ? null : s }))} />
          ))}
        </View>

        {/* Generate button */}
        <Btn title={t('otax.inv.generate')} onPress={() => setGenSheet(true)} style={{ minHeight: 44 }} />
      </View>

      {list.error ? <ErrorBox error={list.error} onRetry={reload} style={{ margin: 16 }} /> :
        list.loading && !list.data ? <Loading /> :
        !invoices.length ? <Empty emoji="🧾" title={t('otax.inv.empty')} sub={t('otax.inv.empty_sub')} style={{ margin: 16 }} /> : (
          <Section title={t('otax.inv.list_title')} color={c.violet}>
            <View style={{ gap: 8 }}>
              {invoices.map((inv) => (
                <Card key={inv.id} color={inv.status === 'open' ? c.pinkSoft : c.paper}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                        <Tag label={inv.invoice_no} color={c.violetSoft} />
                        <Tag label={KIND_TAG[inv.kind]?.label ?? inv.kind} color={KIND_TAG[inv.kind]?.color ?? c.paper} />
                        <Tag label={STATUS_TAG[inv.status]?.label ?? inv.status} color={STATUS_TAG[inv.status]?.color ?? c.paper} />
                      </View>
                      <T size={12} color={c.mute}>{inv.period_from} → {inv.period_to} · {inv.tax_country} {inv.tax_regime?.toUpperCase()}</T>
                      {inv.paid_at ? <T size={11} color={c.mint}>{t('otax.inv.paid_on')} {isoDate(inv.paid_at)}</T> : null}
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <T weight="800" size={18} style={{ fontVariant: ['tabular-nums'] }}>{cash(inv.gross_minor, inv.currency)}</T>
                      <T size={11} color={c.mute}>{t('otax.tax_abbr')} {cash(inv.tax_minor, inv.currency)}</T>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <Btn small title={t('otax.inv.download_pdf')} color={c.violet}
                      onPress={() => openPdf(`/me/official-tax-invoices/${inv.id}`, `${inv.invoice_no}.pdf`).catch((e) => toast(e.message))}
                      style={{ minHeight: 44 }} />
                    {inv.status === 'open' ? (
                      <>
                        <Btn small title={t('otax.inv.mark_paid')} color={c.mint} onPress={() => setPaySheet(inv)} style={{ minHeight: 44 }} />
                        <Btn small title={t('otax.inv.void')} color={c.sunSoft} ink={c.sun} onPress={() => setVoidSheet(inv)} style={{ minHeight: 44 }} />
                      </>
                    ) : null}
                  </View>
                </Card>
              ))}
            </View>
          </Section>
        )
      }

      {/* Generate sheet */}
      <FormSheet visible={genSheet} onClose={() => setGenSheet(false)} title={t('otax.inv.generate_title')} submitLabel={t('otax.inv.generate')} loading={generating}
        notice={t('otax.inv.generate_notice')}
        onSubmit={async (v) => {
          setGenerating(true);
          try {
            await api.post('/me/official-tax-invoices', { from: v.from, to: v.to, currency: v.currency.toUpperCase(), kind: v.kind });
            setGenSheet(false); reload(); toast(t('otax.inv.generated'));
          } catch (e) { toast(e.message); } finally { setGenerating(false); }
        }}
        fields={[
          { key: 'kind', label: t('otax.field.kind'), type: 'chips', options: [{ value: 'invoice', label: t('otax.kind.invoice') }, { value: 'credit_note', label: t('otax.kind.credit_note') }] },
          { key: 'from', label: t('otax.field.period_from'), type: 'date' },
          { key: 'to', label: t('otax.field.period_to'), type: 'date' },
          { key: 'currency', label: t('otax.field.currency'), type: 'currency' },
        ]}
        initial={{ kind: 'invoice', from: `${thisYear()}-01-01`, to: today(), currency: '' }}
      />

      {/* Mark paid sheet */}
      <FormSheet visible={!!paySheet} onClose={() => setPaySheet(null)} title={t('otax.inv.mark_paid_title')} submitLabel={t('otax.inv.mark_paid')}
        onSubmit={async (v) => {
          try { await api.post(`/me/official-tax-invoices/${paySheet.id}/paid`, { paid_note: v.note || undefined }); setPaySheet(null); reload(); toast(t('otax.inv.marked_paid')); }
          catch (e) { toast(e.message); }
        }}
        fields={[{ key: 'note', label: t('otax.field.paid_note'), type: 'text', optional: true }]}
        initial={{ note: '' }}
      />

      {/* Void sheet */}
      <FormSheet visible={!!voidSheet} onClose={() => setVoidSheet(null)} title={t('otax.inv.void_title')} submitLabel={t('otax.inv.void')}
        notice={t('otax.inv.void_notice')}
        onSubmit={async (v) => {
          if (!v.reason?.trim()) { toast(t('otax.err.void_reason')); return; }
          try { await api.post(`/me/official-tax-invoices/${voidSheet.id}/void`, { void_reason: v.reason.trim() }); setVoidSheet(null); reload(); toast(t('otax.inv.voided')); }
          catch (e) { toast(e.message); }
        }}
        fields={[{ key: 'reason', label: t('otax.field.void_reason'), type: 'text' }]}
        initial={{ reason: '' }}
      />
    </View>
  );
}

// ============================================================ STATEMENTS TAB

function StatementsTab({ toast, L }) {
  const [year, setYear] = useState(thisYear());
  const [granularity, setGranularity] = useState('quarter');
  const [basis, setBasis] = useState('billed');
  const [currency, setCurrency] = useState(null);
  const params = { year, granularity, basis, ...(currency ? { currency } : {}) };
  const stmt = useLoad(() => api.get('/me/official-tax-statement', params), [JSON.stringify(params)]);
  const [downloading, setDownloading] = useState(false);

  const periods = stmt.data?.periods ?? [];
  const displayCurrencies = [...new Set(periods.map((p) => p.currency))];
  const filtered = currency ? periods.filter((p) => p.currency === currency) : periods;

  const totals = filtered.reduce((acc, p) => ({
    gross_minor: acc.gross_minor + p.gross_minor,
    tax_minor: acc.tax_minor + p.tax_minor,
    withholding_minor: acc.withholding_minor + p.withholding_minor,
    net_minor: acc.net_minor + p.net_minor,
  }), { gross_minor: 0, tax_minor: 0, withholding_minor: 0, net_minor: 0 });

  const download = async (format) => {
    if (!currency && displayCurrencies.length > 1) { toast(t('otax.earnings.select_currency')); return; }
    const cur2 = currency ?? displayCurrencies[0];
    if (!cur2) return;
    setDownloading(true);
    try {
      const r = await api.get('/me/official-tax-summary/download', { from: `${year}-01-01`, to: `${year}-12-31`, currency: cur2, format, basis });
      if (format === 'csv') await saveExport({ filename: r.filename, content_type: 'text/csv', encoding: 'utf8', content: r.csv });
      else await openPdf(`/me/official-tax-summary/download?from=${year}-01-01&to=${year}-12-31&currency=${cur2}&format=pdf&basis=${basis}`, r.filename).catch((e) => toast(e.message));
    } catch (e) { toast(e.message); } finally { setDownloading(false); }
  };

  return (
    <View style={{ flex: 1, paddingBottom: 16 }}>
      {/* Controls */}
      <View style={{ marginHorizontal: 16, marginTop: 16, gap: 12 }}>
        <Counter label={t('otax.stmt.year')} value={year} onChange={setYear} min={2020} max={thisYear()} step={1} />
        <Seg options={GRANULARITIES} value={granularity} onChange={setGranularity} />
        <Seg options={BASES} value={basis} onChange={setBasis} />
        {displayCurrencies.length > 1 ? (
          <Seg options={[{ value: null, label: t('otax.all') }, ...displayCurrencies.map((c) => ({ value: c, label: c }))]} value={currency} onChange={setCurrency} />
        ) : null}
      </View>

      {stmt.error ? <ErrorBox error={stmt.error} onRetry={stmt.reload} style={{ margin: 16 }} /> :
        stmt.loading && !stmt.data ? <Loading /> :
        !periods.length ? <Empty emoji="📋" title={t('otax.stmt.empty')} sub={t('otax.stmt.empty_sub')} style={{ margin: 16 }} /> : (
          <>
            {/* YTD KPIs */}
            <Section title={t('otax.stmt.ytd_title', { year })} color={c.mint}>
              <View style={{ flexDirection: L.tablet ? 'row' : 'column', flexWrap: 'wrap', gap: 10 }}>
                <Kpi label={t('otax.kpi.gross')} value={displayCurrencies.length === 1 ? cash(totals.gross_minor, displayCurrencies[0]) : `${displayCurrencies.length} currencies`} />
                <Kpi label={t('otax.kpi.tax')} value={displayCurrencies.length === 1 ? cash(totals.tax_minor, displayCurrencies[0]) : '—'} />
                {totals.withholding_minor > 0 ? <Kpi label={t('otax.kpi.withholding')} value={displayCurrencies.length === 1 ? cash(totals.withholding_minor, displayCurrencies[0]) : '—'} /> : null}
                <Kpi label={t('otax.kpi.net')} value={displayCurrencies.length === 1 ? cash(totals.net_minor, displayCurrencies[0]) : '—'} />
              </View>
            </Section>

            {/* Period table */}
            <Section title={t('otax.stmt.breakdown')} color={c.violet}>
              <Card>
                <View style={{ gap: 0 }}>
                  {filtered.map((p) => (
                    <Row key={`${p.currency}|${p.period}`}
                      title={<View>
                        <T weight="800" size={14}>{p.period}</T>
                        <T size={11} color={c.mute}>{p.lines} {t('otax.fixtures')}</T>
                      </View>}
                      right={<View style={{ alignItems: 'flex-end', gap: 2 }}>
                        <T weight="800" size={14} style={{ fontVariant: ['tabular-nums'] }}>{cash(p.gross_minor, p.currency)}</T>
                        <T size={11} color={c.mute}>{t('otax.tax_abbr')} {cash(p.tax_minor, p.currency)}</T>
                        {p.withholding_minor > 0 ? <T size={11} color={c.sun}>{t('otax.wh_abbr')} {cash(p.withholding_minor, p.currency)}</T> : null}
                        <T size={11} color={c.mint}>{t('otax.net_abbr')} {cash(p.net_minor, p.currency)}</T>
                      </View>}
                    />
                  ))}
                </View>
              </Card>
            </Section>

            {/* Download */}
            <View style={{ marginHorizontal: 16, marginTop: 8, gap: 8 }}>
              <Btn title={t('otax.download.csv')} color={c.violet} loading={downloading} onPress={() => download('csv')} style={{ minHeight: 44 }} />
              <Btn title={t('otax.download.pdf')} color={c.violet} loading={downloading} onPress={() => download('pdf')} style={{ minHeight: 44 }} />
            </View>
          </>
        )
      }

      <View style={{ marginHorizontal: 16, marginTop: 8 }}>
        <Card color={c.sunSoft}>
          <T size={12} color={c.mute}>{t('otax.disclaimer')}</T>
        </Card>
      </View>
    </View>
  );
}
