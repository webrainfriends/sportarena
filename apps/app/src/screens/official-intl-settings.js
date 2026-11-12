// Official International Settings (#1030 R32).
// Locale preferences, payout country, invoice localisation, operating countries
// and per-country data-residency consent. 5-tab screen.
// Phone, tablet (≥768px), desktop (≥1180px). RTL-aware. API-first. MCP-enabled.
// All text via t(). Dusk theme tokens only.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, I18nManager, TouchableOpacity, StyleSheet } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import {
  Btn, Card, Chip, Empty, ErrorBox, GradCard, H1, H2, Loading,
  Row, Screen, Section, Seg, Sheet, StatPill, T, Tag, Wrap,
} from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { SwitchRow } from '../federation-bits';
import { c, grad, r } from '../theme';
import { t } from '../i18n';
import { CountryPicker, countryName } from '../country-picker';

const RTL = I18nManager.isRTL;
const row = (gap = 8) => ({ flexDirection: RTL ? 'row-reverse' : 'row', gap, alignItems: 'center' });
const col = (gap = 10) => ({ flexDirection: 'column', gap });
const pad = (n = 16) => ({ padding: n });

const TABS = ['locale', 'grades', 'countries', 'invoice', 'residency'];

const TIMEZONE_OPTIONS = [
  'UTC','Europe/London','Europe/Paris','Europe/Berlin','Europe/Madrid',
  'America/New_York','America/Chicago','America/Los_Angeles','America/Toronto',
  'America/Sao_Paulo','Africa/Johannesburg','Africa/Cairo','Africa/Lagos',
  'Asia/Dubai','Asia/Karachi','Asia/Kolkata','Asia/Bangkok','Asia/Singapore',
  'Asia/Jakarta','Asia/Hong_Kong','Asia/Tokyo','Asia/Seoul',
  'Australia/Sydney','Australia/Melbourne','Australia/Perth',
  'Pacific/Auckland',
].map((v) => ({ value: v, label: v.replace('_', ' ') }));

const LANG_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
  { value: 'ar', label: 'العربية' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'ta', label: 'தமிழ்' },
  { value: 'te', label: 'తెలుగు' },
  { value: 'ml', label: 'മലയാളം' },
  { value: 'mr', label: 'मराठी' },
  { value: 'kn', label: 'ಕನ್ನಡ' },
  { value: 'bn', label: 'বাংলা' },
  { value: 'or', label: 'ଓଡ଼ିଆ' },
  { value: 'si', label: 'සිංහල' },
  { value: 'ur', label: 'اردو' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

const DATE_LOCALES = [
  { value: 'en-GB', label: 'DD/MM/YYYY (en-GB)' },
  { value: 'en-US', label: 'MM/DD/YYYY (en-US)' },
  { value: 'en-AU', label: 'DD/MM/YYYY (en-AU)' },
  { value: 'en-IN', label: 'DD/MM/YYYY (en-IN)' },
  { value: 'de',    label: 'DD.MM.YYYY (de)' },
  { value: 'fr',    label: 'DD/MM/YYYY (fr)' },
  { value: 'ja',    label: 'YYYY年MM月DD日 (ja)' },
  { value: 'ko',    label: 'YYYY.MM.DD (ko)' },
  { value: 'zh',    label: 'YYYY/MM/DD (zh)' },
];

const NUMBER_LOCALES = [
  { value: 'en-AU', label: '1,234.56 (en-AU)' },
  { value: 'en-GB', label: '1,234.56 (en-GB)' },
  { value: 'en-US', label: '1,234.56 (en-US)' },
  { value: 'en-IN', label: '1,23,456.00 (en-IN)' },
  { value: 'de',    label: '1.234,56 (de)' },
  { value: 'fr',    label: '1 234,56 (fr)' },
  { value: 'ar',    label: '١٬٢٣٤٫٥٦ (ar)' },
];

const TAX_REGIMES = [
  { value: 'none', label: t('otax.regime.none') },
  { value: 'gst',  label: t('otax.regime.gst') },
  { value: 'vat',  label: t('otax.regime.vat') },
  { value: 'sales_tax', label: t('otax.regime.sales_tax') },
  { value: 'hst',  label: t('otax.regime.hst') },
  { value: 'consumption_tax', label: t('otax.regime.consumption_tax') },
  { value: 'unknown', label: t('ointl.tax_regime.unknown') },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function statusChip(consent, revoked) {
  if (revoked) return <Tag label={t('ointl.country.consent_revoked')} color={c.redSoft} textColor={c.red} />;
  if (consent) return <Tag label={t('ointl.country.consented')} color={c.limeSoft} textColor={c.lime} />;
  return <Tag label={t('ointl.country.no_consent')} color={c.sunSoft} textColor={c.sun} />;
}

function VerChip(vs) {
  const map = { verified: [c.limeSoft, c.lime, t('ointl.grade.verified')], self_declared: [c.cyanSoft, c.cyan, t('ointl.grade.self_declared')], pending: [c.sunSoft, c.sun, t('ointl.grade.pending')], rejected: [c.redSoft, c.red, t('ointl.grade.rejected')], revoked: [c.redSoft, c.red, t('ointl.grade.revoked')] };
  const [bg, ink, lbl] = map[vs] ?? [c.violetSoft, c.mute, vs];
  return <Tag label={lbl} color={bg} textColor={ink} />;
}

function GradeBar({ rank, maxRank }) {
  const pct = maxRank > 0 ? Math.round(((maxRank - rank) / maxRank) * 100) : 0;
  const fillColor = pct >= 80 ? c.pink : pct >= 50 ? c.mint : c.sun;
  return (
    <View style={{ height: 5, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden', marginTop: 5 }}>
      <View style={{ width: `${pct}%`, height: 5, borderRadius: 3, backgroundColor: fillColor }} />
    </View>
  );
}

// ── Main export ──────────────────────────────────────────────────────────

export function OfficialIntlSettings({ navigation }) {
  const { toast } = useSession();
  const L = useLayout();
  const [tab, setTab] = useState('locale');

  return (
    <Screen>
      <GradCard style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
        <View style={[row(10), { marginBottom: 4 }]}>
          <T size={26}>🌐</T>
          <View>
            <H1 style={{ color: '#fff', marginTop: 0 }}>{t('ointl.title')}</H1>
            <T size={12} style={{ color: 'rgba(255,255,255,.75)' }}>{t('ointl.subtitle')}</T>
          </View>
        </View>
        <Seg
          style={{ marginTop: 14 }}
          options={TABS.map((v) => ({ value: v, label: t(`ointl.tab.${v}`) }))}
          value={tab}
          onChange={setTab}
          dark
        />
      </GradCard>

      {tab === 'locale'    && <LocaleTab toast={toast} L={L} />}
      {tab === 'grades'    && <GradesTab toast={toast} L={L} nav={navigation} />}
      {tab === 'countries' && <CountriesTab toast={toast} L={L} />}
      {tab === 'invoice'   && <InvoiceTab toast={toast} L={L} />}
      {tab === 'residency' && <ResidencyTab toast={toast} L={L} nav={navigation} />}
    </Screen>
  );
}

// ═══════════════════════════════════════════════ LOCALE TAB

function LocaleTab({ toast, L }) {
  const data = useLoad(() => api.get('/me/official-intl-prefs'), []);
  const opts = useLoad(() => api.get('/official-intl/options'), []);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});

  const openEdit = useCallback(() => {
    if (data.data) setForm({ ...data.data });
    setEditing(true);
  }, [data.data]);

  const save = useCallback(async () => {
    try {
      await api.post('/me/official-intl-prefs', form);
      toast(t('ointl.saved'));
      setEditing(false);
      data.reload();
    } catch (e) { toast(e.message); }
  }, [form, data, toast]);

  if (data.error) return <Section><ErrorBox error={data.error} onRetry={data.reload} /></Section>;
  if (!data.data) return <Section><Loading /></Section>;
  const p = data.data;

  return (
    <ScrollView contentContainerStyle={[col(12), pad(16)]}>
      {/* Stats strip */}
      <View style={[row(8), { flexWrap: 'wrap' }]}>
        <StatPill value={p.timezone?.split('/')[1]?.replace('_',' ') ?? p.timezone} label={t('ointl.field.timezone')} color={c.cyanSoft} />
        <StatPill value={(LANG_OPTIONS.find((l) => l.value === p.profile_language)?.label ?? p.profile_language)} label={t('ointl.field.profile_language')} color={c.pinkSoft} />
        <StatPill value={p.currency_preference} label={t('ointl.field.currency')} color={c.limeSoft} />
      </View>

      {/* Profile & communication language */}
      <Card>
        <View style={[row(0), { justifyContent: 'space-between', marginBottom: 10 }]}>
          <H2>{t('ointl.section.language')}</H2>
          <Btn label={t('common.edit')} onPress={openEdit} size="sm" ghost />
        </View>
        <Row label={t('ointl.field.profile_language')} value={LANG_OPTIONS.find((l) => l.value === p.profile_language)?.label ?? p.profile_language} />
        <Row label={t('ointl.field.comms_language')} value={LANG_OPTIONS.find((l) => l.value === p.comms_language)?.label ?? p.comms_language} />
        <Row label={t('ointl.field.match_language')} value={LANG_OPTIONS.find((l) => l.value === p.match_language)?.label ?? p.match_language} />
      </Card>

      {/* Timezone & format */}
      <Card>
        <H2 style={{ marginBottom: 10 }}>{t('ointl.section.formats')}</H2>
        <Row label={t('ointl.field.timezone')} value={p.timezone} />
        <Row label={t('ointl.field.date_locale')} value={DATE_LOCALES.find((x) => x.value === p.date_locale)?.label ?? p.date_locale} />
        <Row label={t('ointl.field.number_locale')} value={NUMBER_LOCALES.find((x) => x.value === p.number_locale)?.label ?? p.number_locale} />
        <Row label={t('ointl.field.currency_preference')} value={p.currency_preference} />
      </Card>

      {/* Edit sheet */}
      {editing && (
        <FormSheet visible title={t('ointl.edit.locale_title')} onClose={() => setEditing(false)}>
          <View style={col(14)}>
            <MenuField
              label={t('ointl.field.profile_language')}
              value={form.profile_language}
              options={LANG_OPTIONS}
              onChange={(v) => setForm((f) => ({ ...f, profile_language: v }))}
            />
            <MenuField
              label={t('ointl.field.comms_language')}
              value={form.comms_language}
              options={LANG_OPTIONS}
              onChange={(v) => setForm((f) => ({ ...f, comms_language: v }))}
            />
            <MenuField
              label={t('ointl.field.match_language')}
              value={form.match_language}
              options={LANG_OPTIONS}
              onChange={(v) => setForm((f) => ({ ...f, match_language: v }))}
            />
            <MenuField
              label={t('ointl.field.timezone')}
              value={form.timezone}
              options={TIMEZONE_OPTIONS}
              onChange={(v) => setForm((f) => ({ ...f, timezone: v }))}
            />
            <MenuField
              label={t('ointl.field.date_locale')}
              value={form.date_locale}
              options={DATE_LOCALES}
              onChange={(v) => setForm((f) => ({ ...f, date_locale: v }))}
            />
            <MenuField
              label={t('ointl.field.number_locale')}
              value={form.number_locale}
              options={NUMBER_LOCALES}
              onChange={(v) => setForm((f) => ({ ...f, number_locale: v }))}
            />
            <View style={row(10)}>
              <Btn style={{ flex: 1 }} label={t('common.cancel')} onPress={() => setEditing(false)} ghost />
              <Btn style={{ flex: 1 }} label={t('common.save')} onPress={save} />
            </View>
          </View>
        </FormSheet>
      )}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════ GRADES TAB

function GradesTab({ toast, L, nav }) {
  const data = useLoad(() => api.get('/me/official-grades'), []);
  const apps = useLoad(() => api.get('/me/official-grades/applications', { limit: 5 }), []);

  if (data.error) return <Section><ErrorBox error={data.error} onRetry={data.reload} /></Section>;
  if (!data.data) return <Section><Loading /></Section>;
  const grades = data.data.grades ?? [];

  return (
    <ScrollView contentContainerStyle={[col(12), pad(16)]}>
      {/* KPI strip */}
      <View style={[row(8), { flexWrap: 'wrap' }]}>
        <StatPill value={String(grades.length)} label={t('ointl.grades.count')} color={c.pinkSoft} />
        <StatPill value={String(grades.filter((g) => g.verification_status === 'verified').length)} label={t('ointl.grades.verified')} color={c.limeSoft} />
        <StatPill value={String(apps.data?.applications?.filter((a) => !['approved','rejected','withdrawn'].includes(a.status)).length ?? 0)} label={t('ointl.grades.pending_apps')} color={c.sunSoft} />
      </View>

      {/* Grade cards */}
      {grades.length === 0 ? (
        <Empty
          icon="🎖️"
          title={t('ointl.grades.empty_title')}
          subtitle={t('ointl.grades.empty_sub')}
        />
      ) : (
        grades.map((g) => (
          <TouchableOpacity
            key={g.grade_id}
            onPress={() => nav.push('OfficialGradeScheme', { gradeId: g.grade_id, schemeId: g.scheme_id })}
            activeOpacity={0.75}
          >
            <Card style={{ borderLeftWidth: 3, borderLeftColor: g.verification_status === 'verified' ? c.mint : c.sun }}>
              <View style={[row(8), { marginBottom: 6 }]}>
                <T size={18}>{g.sport_emoji ?? '🎖️'}</T>
                <View style={{ flex: 1 }}>
                  <View style={[row(6)]}>
                    <T weight="700" size={14} color={c.ink}>{g.scheme_name}</T>
                    {VerChip(g.verification_status)}
                  </View>
                  <T size={11} color={c.mute}>{g.governing_body}{g.country_scope ? ` · ${g.country_scope}` : ''}</T>
                </View>
                <Chip label={g.level_name} color={c.pinkSoft} />
              </View>
              <GradeBar rank={g.rank_order} maxRank={Math.max(...(g.levels ?? []).map((l) => l.rank_order), 5)} />
              <T size={11} color={c.mute} style={{ marginTop: 4 }}>
                {g.assigned_by_name ? t('ointl.grade.assigned_by', { name: g.assigned_by_name }) : t('ointl.grade.self_declared_note')}
                {g.effective_from ? ` · ${new Date(g.effective_from).toLocaleDateString()}` : ''}
              </T>
            </Card>
          </TouchableOpacity>
        ))
      )}

      {/* Pending applications */}
      {(apps.data?.applications?.length ?? 0) > 0 && (
        <Card>
          <H2 style={{ marginBottom: 8 }}>{t('ointl.grades.my_applications')}</H2>
          {apps.data.applications.map((a) => (
            <View key={a.id} style={[row(8), { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }]}>
              <View style={{ flex: 1 }}>
                <T weight="700" size={13} color={c.ink}>{a.scheme_name}</T>
                <T size={11} color={c.mute}>{a.current_level_name} → {a.target_level_name}</T>
              </View>
              <Tag label={t(`ointl.app_status.${a.status}`)} color={a.status === 'approved' ? c.limeSoft : a.status === 'rejected' ? c.redSoft : c.sunSoft} />
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════ OPERATING COUNTRIES TAB

function CountriesTab({ toast, L }) {
  const data = useLoad(() => api.get('/me/official-intl/operating-countries'), []);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({
    country_code: '', is_home_country: false, residency_consent_given: false,
    typical_tax_regime: 'unknown', residency_region: '',
  });

  const submitAdd = useCallback(async () => {
    if (!addForm.country_code) return toast(t('ointl.country.no_code'));
    if (addForm.residency_consent_given && !addForm.residency_region)
      return toast(t('ointl.country.region_required'));
    try {
      const payload = {
        country_code: addForm.country_code,
        is_home_country: addForm.is_home_country,
        typical_tax_regime: addForm.typical_tax_regime,
        residency_consent_given: addForm.residency_consent_given,
        ...(addForm.residency_consent_given ? {
          residency_region: addForm.residency_region,
          consent_policy_version: 1,
          consent_policy_hash: 'placeholder',
        } : {}),
      };
      await api.post('/me/official-intl/operating-countries', payload);
      toast(t('ointl.country.added'));
      setAdding(false);
      data.reload();
    } catch (e) { toast(e.message); }
  }, [addForm, data, toast]);

  const revokeConsent = useCallback(async (cc) => {
    try {
      await api.patch(`/me/official-intl/operating-countries/${cc}/consent`, { country_code: cc, consent_given: false });
      toast(t('ointl.country.consent_revoked'));
      data.reload();
    } catch (e) { toast(e.message); }
  }, [data, toast]);

  if (data.error) return <Section><ErrorBox error={data.error} onRetry={data.reload} /></Section>;
  if (!data.data) return <Section><Loading /></Section>;
  const active = (data.data.countries ?? []).filter((c) => !c.removed_at);
  const removed = (data.data.countries ?? []).filter((c) => c.removed_at);

  return (
    <ScrollView contentContainerStyle={[col(12), pad(16)]}>
      {/* KPI strip */}
      <View style={[row(8), { flexWrap: 'wrap' }]}>
        <StatPill value={String(active.length)} label={t('ointl.countries.active')} color={c.pinkSoft} />
        <StatPill value={String(active.filter((x) => x.residency_consent_given).length)} label={t('ointl.countries.consented')} color={c.limeSoft} />
        <StatPill value={String(active.filter((x) => !x.residency_consent_given).length)} label={t('ointl.countries.no_consent')} color={c.sunSoft} />
      </View>

      {/* Info banner */}
      <Card style={{ backgroundColor: c.cyanSoft, borderWidth: 0 }}>
        <T size={12} color={c.cyan} style={{ lineHeight: 18 }}>{t('ointl.countries.residency_info')}</T>
      </Card>

      {/* Active countries */}
      <Card>
        <View style={[row(0), { justifyContent: 'space-between', marginBottom: 10 }]}>
          <H2>{t('ointl.countries.list_title')}</H2>
          <Btn label={`+ ${t('ointl.country.add')}`} size="sm" onPress={() => setAdding(true)} />
        </View>
        {active.length === 0 ? (
          <Empty icon="🌍" title={t('ointl.countries.empty_title')} subtitle={t('ointl.countries.empty_sub')} />
        ) : (
          active.map((country) => (
            <View key={country.id} style={[row(10), { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line }]}>
              <T size={22}>{flagEmoji(country.country_code)}</T>
              <View style={{ flex: 1 }}>
                <View style={[row(6)]}>
                  <T weight="700" size={14} color={c.ink}>{countryName(country.country_code)}</T>
                  {country.is_home_country && <Chip label={t('ointl.country.home')} color={c.pinkSoft} />}
                </View>
                <T size={11} color={c.mute}>
                  {[country.currency, country.typical_tax_regime !== 'unknown' && country.typical_tax_regime?.toUpperCase(), country.typical_timezone].filter(Boolean).join(' · ')}
                </T>
              </View>
              {statusChip(country.residency_consent_given, !!country.consent_revoked_at)}
            </View>
          ))
        )}
      </Card>

      {/* Removed countries (compact) */}
      {removed.length > 0 && (
        <Card>
          <H2 style={{ marginBottom: 8 }}>{t('ointl.countries.removed_title')}</H2>
          {removed.map((country) => (
            <View key={country.id} style={[row(10), { paddingVertical: 8, opacity: 0.5 }]}>
              <T size={18}>{flagEmoji(country.country_code)}</T>
              <T size={13} color={c.mute}>{countryName(country.country_code)}</T>
            </View>
          ))}
        </Card>
      )}

      {/* Add country sheet */}
      {adding && (
        <FormSheet visible title={t('ointl.country.add_title')} onClose={() => setAdding(false)}>
          <View style={col(14)}>
            <View>
              <T size={11} weight="600" color={c.mute} style={{ marginBottom: 6 }}>{t('ointl.field.country')}</T>
              <CountryPicker
                value={addForm.country_code}
                onChange={(cc) => setAddForm((f) => ({ ...f, country_code: cc }))}
              />
            </View>
            <MenuField
              label={t('ointl.field.typical_tax_regime')}
              value={addForm.typical_tax_regime}
              options={TAX_REGIMES}
              onChange={(v) => setAddForm((f) => ({ ...f, typical_tax_regime: v }))}
            />
            <SwitchRow
              label={t('ointl.country.is_home')}
              value={addForm.is_home_country}
              onChange={(v) => setAddForm((f) => ({ ...f, is_home_country: v }))}
            />
            {/* Residency consent block */}
            <Card style={{ backgroundColor: c.cyanSoft, borderWidth: 0, padding: 12 }}>
              <T weight="700" size={13} color={c.cyan} style={{ marginBottom: 6 }}>{t('ointl.country.residency_consent_title')}</T>
              <T size={12} color={c.cyan} style={{ lineHeight: 17, marginBottom: 10 }}>{t('ointl.country.residency_consent_body')}</T>
              <SwitchRow
                label={t('ointl.country.consent_toggle')}
                value={addForm.residency_consent_given}
                onChange={(v) => setAddForm((f) => ({ ...f, residency_consent_given: v }))}
              />
            </Card>
            <View style={row(10)}>
              <Btn style={{ flex: 1 }} label={t('common.cancel')} ghost onPress={() => setAdding(false)} />
              <Btn style={{ flex: 1 }} label={t('ointl.country.add_btn')} onPress={submitAdd} />
            </View>
          </View>
        </FormSheet>
      )}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════ INVOICE TAB

function InvoiceTab({ toast, L }) {
  const data = useLoad(() => api.get('/me/official-intl-prefs'), []);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});

  const openEdit = useCallback(() => {
    if (data.data) setForm({ ...data.data });
    setEditing(true);
  }, [data.data]);

  const save = useCallback(async () => {
    try {
      await api.post('/me/official-intl-prefs', { payout_country: form.payout_country, invoice_language: form.invoice_language, tax_number_label: form.tax_number_label || null });
      toast(t('ointl.saved'));
      setEditing(false);
      data.reload();
    } catch (e) { toast(e.message); }
  }, [form, data, toast]);

  if (data.error) return <Section><ErrorBox error={data.error} onRetry={data.reload} /></Section>;
  if (!data.data) return <Section><Loading /></Section>;
  const p = data.data;

  return (
    <ScrollView contentContainerStyle={[col(12), pad(16)]}>
      <Card style={{ backgroundColor: c.sunSoft, borderWidth: 0 }}>
        <T size={12} color={c.sun} style={{ lineHeight: 17 }}>{t('ointl.invoice.info')}</T>
      </Card>
      <Card>
        <View style={[row(0), { justifyContent: 'space-between', marginBottom: 10 }]}>
          <H2>{t('ointl.section.invoice')}</H2>
          <Btn label={t('common.edit')} size="sm" ghost onPress={openEdit} />
        </View>
        <Row label={t('ointl.field.payout_country')} value={p.payout_country ? `${flagEmoji(p.payout_country)} ${countryName(p.payout_country)}` : t('ointl.field.not_set')} />
        <Row label={t('ointl.field.invoice_language')} value={LANG_OPTIONS.find((l) => l.value === p.invoice_language)?.label ?? p.invoice_language} />
        <Row label={t('ointl.field.tax_number_label')}
          value={p.tax_number_label ?? (p._auto_label ? t('ointl.field.auto_label', { label: p.tax_number_label }) : t('ointl.field.not_set'))}
          right={p._auto_label ? <Chip label={t('ointl.field.auto')} color={c.cyanSoft} /> : null}
        />
      </Card>
      {editing && (
        <FormSheet visible title={t('ointl.edit.invoice_title')} onClose={() => setEditing(false)}>
          <View style={col(14)}>
            <View>
              <T size={11} weight="600" color={c.mute} style={{ marginBottom: 6 }}>{t('ointl.field.payout_country')}</T>
              <CountryPicker
                value={form.payout_country}
                onChange={(cc) => setForm((f) => ({ ...f, payout_country: cc }))}
              />
            </View>
            <MenuField
              label={t('ointl.field.invoice_language')}
              value={form.invoice_language}
              options={LANG_OPTIONS}
              onChange={(v) => setForm((f) => ({ ...f, invoice_language: v }))}
            />
            <View style={row(10)}>
              <Btn style={{ flex: 1 }} label={t('common.cancel')} ghost onPress={() => setEditing(false)} />
              <Btn style={{ flex: 1 }} label={t('common.save')} onPress={save} />
            </View>
          </View>
        </FormSheet>
      )}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════ RESIDENCY TAB

function ResidencyTab({ toast, L, nav }) {
  const data = useLoad(() => api.get('/data-residency/me'), []);
  const countries = useLoad(() => api.get('/me/official-intl/operating-countries'), []);

  if (data.error) return <Section><ErrorBox error={data.error} onRetry={data.reload} /></Section>;
  if (!data.data) return <Section><Loading /></Section>;
  const { assignment, consents, active_transfer } = data.data;
  const consentedCountries = (countries.data?.countries ?? []).filter((c) => c.residency_consent_given && !c.consent_revoked_at);

  return (
    <ScrollView contentContainerStyle={[col(12), pad(16)]}>
      {/* Storage region */}
      <Card style={{ borderLeftWidth: 3, borderLeftColor: c.mint }}>
        <H2 style={{ marginBottom: 8 }}>{t('ointl.residency.home_region')}</H2>
        <Row label={t('ointl.residency.region')} value={assignment ? `${assignment.aws_region}` : t('ointl.residency.none')} right={assignment ? <Tag label={t('ointl.residency.active')} color={c.limeSoft} textColor={c.lime} /> : null} />
        {active_transfer && (
          <Row label={t('ointl.residency.transfer_in_progress')} value={`${active_transfer.from_region} → ${active_transfer.to_region}`} />
        )}
      </Card>

      {/* Per-country consents */}
      <Card>
        <H2 style={{ marginBottom: 8 }}>{t('ointl.residency.country_consents')}</H2>
        {consentedCountries.length === 0 ? (
          <T size={13} color={c.mute}>{t('ointl.residency.no_country_consents')}</T>
        ) : (
          consentedCountries.map((country) => (
            <View key={country.id} style={[row(10), { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }]}>
              <T size={18}>{flagEmoji(country.country_code)}</T>
              <View style={{ flex: 1 }}>
                <T weight="700" size={13} color={c.ink}>{countryName(country.country_code)}</T>
                <T size={11} color={c.mute}>{country.residency_region ?? '—'}</T>
              </View>
              <Tag label={t('ointl.country.consented')} color={c.limeSoft} textColor={c.lime} />
            </View>
          ))
        )}
      </Card>

      {/* Manage full residency → DataResidency screen */}
      <Btn
        label={t('ointl.residency.manage_full')}
        ghost
        onPress={() => nav.push('DataResidency')}
      />
    </ScrollView>
  );
}

// ── Flag emoji helper ─────────────────────────────────────────────────────
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '🏳️';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1F1E0 - 65 + c.charCodeAt(0)));
}
