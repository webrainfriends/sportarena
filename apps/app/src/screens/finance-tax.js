// Finance console, Tax tab (#593): the tax the ledger holds (collected against paid, per period, code and rate), and the organisation's own tax profile and rules that
// decide it. Everything is read from and written through the finance API; nothing is computed here. Informational, not tax advice.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { t } from '../i18n';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Row, Section, Seg, Sheet, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { Counter, DateField } from '../pickers';
import { SwitchRow } from '../federation-bits';
import { c, day } from '../theme';
import { Kpi } from './academy-ui';
import { atLeast, catLabel, money } from './finance-parts';

const PERIODS = ['month', 'quarter', 'year'];
const REGIMES = ['none', 'gst_in', 'vat', 'sales_tax'];
const TREATMENTS = ['standard', 'zero_rated', 'exempt', 'out_of_scope', 'reverse_charge'];
const ROUNDING = ['half_up', 'half_even'];
// what the report understands; the dates and filters of the screen apply to it like to every other tab
const pick = (q) => Object.fromEntries(['organisation_id', 'from', 'to', 'currency', 'season_ids', 'event_ids', 'team_ids', 'workspace_ids', 'categories'].filter((k) => q[k] != null).map((k) => [k, q[k]]));
const pct = (bp) => (bp == null ? '' : `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`);
const iso = (d) => (d ? String(d).slice(0, 10) : '');
const today = () => new Date().toISOString().slice(0, 10);

export function Tax({ scope, whole, level, q, toast }) {
  const [period, setPeriod] = useState('month');
  const params = { ...pick(q), period };
  const report = useLoad(() => api.get('/finance/tax', params), [JSON.stringify(params)]);
  return (
    <View style={{ gap: 14 }}>
      <T color={c.mute} size={13}>{t('fin.tax.intro')}</T>
      <Seg options={PERIODS.map((value) => ({ value, label: t(`fin.tax.period.${value}`) }))} value={period} onChange={setPeriod} />
      {report.error ? <ErrorBox error={report.error} onRetry={report.reload} /> : !report.data ? <Loading /> : !report.data.currencies.length ? <Empty emoji="🧾" title={t('fin.tax.empty_title')} sub={t('fin.tax.empty_sub')} /> : report.data.currencies.map((x) => <Currency key={x.currency} x={x} />)}
      <T size={12} color={c.mute}>{t('fin.tax.note')}</T>
      {whole ? null : <Rules org={scope.organisation_id} level={level} toast={toast} />}
    </View>
  );
}

function Currency({ x }) {
  const cur = x.currency;
  const heading = [t('fin.tax.title'), cur].join(' · ');
  return (
    <Section title={heading} color={c.violet}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label={t('fin.tax.collected')} value={money(x.collected.tax, cur)} sub={t('fin.tax.collected_sub')} />
        <Kpi label={t('fin.tax.paid')} value={money(x.paid.tax, cur)} sub={t('fin.tax.paid_sub')} />
        <Kpi label={t('fin.tax.net')} value={money(x.net_tax, cur)} sub={t('fin.tax.net_sub')} tone={x.net_tax > 0 ? 'alert' : undefined} />
        <Kpi label={t('fin.tax.withheld')} value={money(x.withheld.total, cur)} sub={t('fin.tax.withheld_sub')} />
      </View>
      <Lines title={t('fin.tax.collected_by')} lines={x.collected.lines} cur={cur} />
      <Lines title={t('fin.tax.paid_by')} lines={x.paid.lines} cur={cur} />
      {x.withheld.by_period.length ? (
        <View style={{ gap: 8 }}>
          <T weight="800">{t('fin.tax.withheld_by')}</T>
          {x.withheld.by_period.map((w) => <Row key={w.period} title={w.period} sub={t('fin.tax.rows', { n: w.rows })} right={<T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(w.withheld_minor, cur)}</T>} />)}
        </View>
      ) : null}
      {x.zero_by_rule.length ? (
        <View style={{ gap: 8 }}>
          <T weight="800">{t('fin.tax.zero_by_rule')}</T>
          {x.zero_by_rule.map((z) => <Row key={z.treatment} title={t(`fin.tax.treatment.${z.treatment}`)} sub={t('fin.tax.rows', { n: z.rows })} right={<T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(z.gross_minor, cur)}</T>} />)}
        </View>
      ) : null}
      {x.no_tax_recorded.length ? (
        <View style={{ gap: 8 }}>
          <T weight="800">{t('fin.tax.no_tax')}</T>
          <T size={12} color={c.mute}>{t('fin.tax.no_tax_hint')}</T>
          {x.no_tax_recorded.map((z) => <Row key={z.category} title={catLabel(z.category)} sub={t('fin.tax.rows', { n: z.rows })} right={<T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(z.gross_minor, cur)}</T>} />)}
        </View>
      ) : null}
      {x.rounding_variance_minor ? <T size={12} color={c.mute}>{t('fin.tax.rounding', { amount: money(Math.round(x.rounding_variance_minor), cur) })}</T> : null}
    </Section>
  );
}

function Lines({ title, lines, cur }) {
  if (!lines.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <T weight="800">{title}</T>
      {lines.map((l, i) => {
        const head = [l.period, l.code ?? t('fin.tax.no_code'), l.rate_bp == null ? null : pct(l.rate_bp)].filter(Boolean).join(' · ');
        return (
          <Row key={`${l.period}-${l.code}-${l.rate_bp}-${l.treatment}-${i}`} title={head}
            sub={[l.treatment ? t(`fin.tax.treatment.${l.treatment}`) : null, t('fin.tax.taxable', { amount: money(l.taxable_minor, cur) }), t('fin.tax.rows', { n: l.rows })].filter(Boolean).join(' · ')}
            right={<T weight="800" style={{ fontVariant: ['tabular-nums'] }}>{money(l.tax_minor, cur)}</T>} />
        );
      })}
    </View>
  );
}

/** The organisation's tax profile and rules: anyone with accountant access reads them, a controller changes them. Rules are never deleted, only ended. */
function Rules({ org, level, toast }) {
  const s = useLoad(() => api.get('/finance/tax/settings', { organisation_id: org }), [org, level]);
  const [profile, setProfile] = useState(null);
  const [rule, setRule] = useState(null);
  const [ending, setEnding] = useState(null);
  const canEdit = atLeast(level, 'controller');
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const reload = () => s.reload();
  return (
    <Section title={t('fin.tax.rules_title')} color={c.violet}>
      <T color={c.mute} size={13}>{t('fin.tax.rules_intro')}</T>
      <Card>
        <T weight="800">{t('fin.tax.profile')}</T>
        <T size={13} color={c.mute}>{[t(`fin.tax.regime.${d.profile.regime}`), d.profile.registered ? t('fin.tax.registered') : t('fin.tax.not_registered'), t(`fin.tax.rounding.${d.profile.rounding_mode}`)].join(' · ')}</T>
        {d.registration_id ? <T size={12} color={c.mute}>{t('fin.tax.registration_id', { id: d.registration_id })}</T> : null}
        {canEdit ? <Btn small title={t('fin.tax.edit_profile')} color={c.paper} ink={c.ink} onPress={() => setProfile({ ...d.profile })} style={{ alignSelf: 'flex-start' }} /> : null}
      </Card>
      {!d.rules.length ? <T size={13} color={c.mute}>{t('fin.tax.no_rules')}</T> : d.rules.map((r) => {
        const ended = r.effective_to && iso(r.effective_to) < today();
        const head = [r.code, r.treatment === 'standard' ? pct(r.rate_bp) : t(`fin.tax.treatment.${r.treatment}`)].join(' · ');
        const span = [r.category === '*' ? t('fin.tax.all_categories') : catLabel(r.category), r.source_type, t('fin.tax.from', { date: day(r.effective_from) }), r.effective_to ? t('fin.tax.until', { date: day(r.effective_to) }) : null].filter(Boolean).join(' · ');
        return (
          <Row key={r.id} title={head} sub={span}
            right={<><Tag label={ended ? t('fin.tax.ended') : t('fin.tax.active')} color={ended ? c.violetSoft : c.limeSoft} />{canEdit && !ended ? <Btn small title={t('fin.tax.end')} color={c.paper} ink={c.ink} onPress={() => setEnding(r)} /> : null}</>} />
        );
      })}
      {canEdit ? <Btn title={t('fin.tax.add_rule')} onPress={() => setRule({ category: '*', treatment: 'standard', percent: 0, code: '', effective_from: today(), evidence: '' })} style={{ alignSelf: 'flex-start' }} /> : null}
      <ProfileSheet org={org} value={profile} onClose={() => setProfile(null)} onSaved={() => { setProfile(null); reload(); toast(t('fin.tax.profile_saved')); }} toast={toast} />
      <RuleSheet org={org} value={rule} onClose={() => setRule(null)} onSaved={() => { setRule(null); reload(); toast(t('fin.tax.rule_saved')); }} toast={toast} />
      <EndSheet org={org} value={ending} onClose={() => setEnding(null)} onSaved={() => { setEnding(null); reload(); toast(t('fin.tax.rule_ended')); }} toast={toast} />
    </Section>
  );
}

function ProfileSheet({ org, value, onClose, onSaved, toast }) {
  const [v, setV] = useState(null);
  const cur = v ?? value;
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post('/finance/tax/profile', { organisation_id: org, regime: cur.regime, registered: !!cur.registered, rounding_mode: cur.rounding_mode }); setV(null); onSaved(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={!!value} onClose={() => { setV(null); onClose(); }} title={t('fin.tax.profile')}>
      {cur ? (
        <View style={{ gap: 12 }}>
          <MenuField label={t('fin.tax.regime')} value={cur.regime} onChange={(x) => setV({ ...cur, regime: x })} options={REGIMES.map((value) => ({ value, label: t(`fin.tax.regime.${value}`) }))} />
          <SwitchRow label={t('fin.tax.registered_switch')} value={!!cur.registered} onChange={(x) => setV({ ...cur, registered: x })} />
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('fin.tax.rounding_label').toUpperCase()}</T>
            <Seg options={ROUNDING.map((value) => ({ value, label: t(`fin.tax.rounding.${value}`) }))} value={cur.rounding_mode} onChange={(x) => setV({ ...cur, rounding_mode: x })} />
          </View>
          <T size={12} color={c.mute}>{t('fin.tax.profile_hint')}</T>
          <Btn title={t('fin.tax.save')} loading={busy} onPress={save} />
        </View>
      ) : null}
    </Sheet>
  );
}

function RuleSheet({ org, value, onClose, onSaved, toast }) {
  const [v, setV] = useState(null);
  const cur = v ?? value;
  const [busy, setBusy] = useState(false);
  const categories = [{ value: '*', label: t('fin.tax.all_categories') }, ...['registration', 'tickets', 'venue_service', 'sponsorship', 'suppliers', 'event_budget', 'commissions', 'contracts', 'travel', 'other'].map((k) => ({ value: k, label: catLabel(k) }))];
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/finance/tax/rules', { organisation_id: org, category: cur.category, code: cur.code.trim(), treatment: cur.treatment, rate_bp: cur.treatment === 'standard' ? Math.round(cur.percent * 100) : 0, effective_from: cur.effective_from, evidence: cur.evidence.trim() || undefined });
      setV(null); onSaved();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={!!value} onClose={() => { setV(null); onClose(); }} title={t('fin.tax.add_rule')}>
      {cur ? (
        <View style={{ gap: 12 }}>
          <MenuField label={t('fin.tax.applies_to')} value={cur.category} onChange={(x) => setV({ ...cur, category: x })} options={categories} />
          <MenuField label={t('fin.tax.treatment')} value={cur.treatment} onChange={(x) => setV({ ...cur, treatment: x })} options={TREATMENTS.map((value) => ({ value, label: t(`fin.tax.treatment.${value}`), sub: t(`fin.tax.treatment.${value}_sub`) }))} />
          {cur.treatment === 'standard' ? <Counter label={t('fin.tax.rate')} value={cur.percent} onChange={(x) => setV({ ...cur, percent: x })} min={0} max={100} step={0.5} suffix="%" /> : null}
          <Field label={t('fin.tax.code')} value={cur.code} onChangeText={(x) => setV({ ...cur, code: x })} placeholder={t('fin.tax.code_ph')} hint={t('fin.tax.code_hint')} maxLength={20} />
          <DateField label={t('fin.tax.effective_from')} value={cur.effective_from} onChange={(x) => setV({ ...cur, effective_from: x })} />
          <Field label={t('fin.tax.evidence')} value={cur.evidence} onChangeText={(x) => setV({ ...cur, evidence: x })} multiline placeholder={t('fin.tax.evidence_ph')} hint={t('fin.tax.evidence_hint')} />
          <T size={12} color={c.mute}>{t('fin.tax.rule_hint')}</T>
          <Btn title={t('fin.tax.save_rule')} disabled={!cur.code.trim() || !cur.effective_from} loading={busy} onPress={save} />
        </View>
      ) : null}
    </Sheet>
  );
}

function EndSheet({ org, value, onClose, onSaved, toast }) {
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const end = async () => {
    setBusy(true);
    try { await api.post(`/finance/tax/rules/${value.id}/end`, { organisation_id: org, effective_to: date }); onSaved(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={!!value} onClose={onClose} title={t('fin.tax.end_title')}>
      <T color={c.mute} size={13}>{t('fin.tax.end_help')}</T>
      <DateField label={t('fin.tax.effective_to')} value={date} onChange={setDate} />
      <Btn title={t('fin.tax.end')} loading={busy} onPress={end} />
    </Sheet>
  );
}
