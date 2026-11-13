// Budget forecasting and scenario planning (#381 extension): monthly projections, best/base/worst scenarios, spread methods
// and accuracy tracking once actuals come in. Exported as components imported by sponsor-budgets.js (same pattern as budget-trace.js).
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, Empty, Field, Loading, Section, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { explain } from '../access';
import { toMinor } from './budget-wizard';

const SCENARIOS = [
  { value: 'base', label: 'Base', emoji: '📊', sub: 'Most likely spend — the working plan.' },
  { value: 'best', label: 'Best', emoji: '🟢', sub: 'Optimistic — lower spend, more headroom.' },
  { value: 'worst', label: 'Worst', emoji: '🔴', sub: 'Pessimistic — higher spend, risk view.' },
  { value: 'custom', label: 'Custom', emoji: '✏️', sub: 'Named scenario for what-if analysis.' },
];
const SPREAD = [
  { value: 'even', label: 'Even', hint: 'Equal each month.' },
  { value: 's_curve', label: 'S-curve', hint: 'Slow start, peak in mid-year, taper.' },
  { value: 'front', label: 'Front-loaded', hint: 'Heavy spend in Q1–Q2.' },
  { value: 'back', label: 'Back-loaded', hint: 'Heavy spend in Q3–Q4.' },
  { value: 'manual', label: 'Manual', hint: 'Enter each month yourself.' },
];

const monthLabel = (ym) => {
  try { return new Date(`${ym}-01`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); } catch { return ym; }
};
const fmtMoney = (cents, cur) => {
  try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return String(cents); }
};
const utilPct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

/** Spread total cents across 12 months by strategy */
function buildPeriods(totalCents, fiscalYear, method) {
  const months = Array.from({ length: 12 }, (_, i) => `${fiscalYear}-${String(i + 1).padStart(2, '0')}`);
  const weights = method === 's_curve' ? [1, 2, 4, 7, 10, 13, 15, 15, 13, 10, 7, 3]
    : method === 'front' ? [15, 13, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2]
    : method === 'back' ? [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15]
    : Array(12).fill(1); // even
  const wtotal = weights.reduce((a, b) => a + b, 0);
  let assigned = 0;
  return months.map((month, i) => {
    const cents = i === 11 ? totalCents - assigned : Math.round(totalCents * weights[i] / wtotal);
    assigned += cents;
    return { month, projected_cents: cents, notes: null };
  });
}

/** Scenario selector tabs */
function ScenarioTabs({ value, onChange, available }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {SCENARIOS.filter(s => available.includes(s.value) || s.value === value).map(s => (
        <Pressable key={s.value} onPress={() => onChange(s.value)} accessibilityRole="tab" accessibilityState={{ selected: s.value === value }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: s.value === value ? c.violet : c.paper, borderWidth: 1.5, borderColor: s.value === value ? c.violet : c.line }}>
          <T size={13}>{s.emoji}</T>
          <T weight="800" size={13} color={s.value === value ? c.onAccent : c.ink}>{s.label}</T>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** Monthly spend bars + totals */
function MonthGrid({ periods, authorized, currency }) {
  const total = (periods ?? []).reduce((s, p) => s + (p.projected_cents ?? 0), 0);
  const authPct = utilPct(total, authorized);
  const barColor = authPct >= 110 ? c.red : authPct >= 90 ? c.sun : c.violet;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" style={{ flex: 1 }}>Total projected</T>
        <T weight="800" size={15} style={{ fontVariant: ['tabular-nums'] }} color={authPct >= 110 ? c.red : authPct >= 90 ? c.sun : c.lime}>{fmtMoney(total, currency)}</T>
        <Tag label={`${authPct}%`} color={authPct > 100 ? c.redSoft : authPct > 90 ? c.sunSoft : c.limeSoft} />
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden' }}>
        <View style={{ width: `${Math.min(100, authPct)}%`, height: 6, backgroundColor: barColor }} />
      </View>
      {(periods ?? []).map((p) => {
        const rowPct = utilPct(p.projected_cents, authorized);
        return (
          <View key={p.month} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }} accessible accessibilityLabel={`${monthLabel(p.month)}: ${fmtMoney(p.projected_cents, currency)}`}>
            <T size={12} color={c.mute} weight="700" style={{ width: 36 }}>{monthLabel(p.month)}</T>
            <View style={{ flex: 1, height: 18, borderRadius: 3, backgroundColor: c.bg, overflow: 'hidden' }}>
              <View style={{ width: `${Math.min(100, rowPct)}%`, height: 18, backgroundColor: c.violet, opacity: 0.65 }} />
            </View>
            <T size={12} weight="600" style={{ width: 68, textAlign: 'right', fontVariant: ['tabular-nums'] }}>{fmtMoney(p.projected_cents, currency)}</T>
          </View>
        );
      })}
    </View>
  );
}

/** Create / edit forecast sheet */
export function BudgetForecastSheet({ visible, onClose, budget, existing, onDone }) {
  const isEdit = !!existing;
  const [name, setName] = useState('');
  const [scenario, setScenario] = useState('base');
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [spreadMethod, setSpreadMethod] = useState('even');
  const [totalRaw, setTotalRaw] = useState('');
  const [basisPct, setBasisPct] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const currency = budget?.currency ?? 'USD';
  const authorized = Number(budget?.authorized_cents ?? 0);

  useEffect(() => {
    if (!visible) return;
    if (isEdit) {
      setName(existing.name);
      setScenario(existing.scenario);
      setFiscalYear(existing.fiscal_year);
      setSpreadMethod(existing.spread_method ?? 'even');
      setBasisPct(existing.basis_actual_pct != null ? String(existing.basis_actual_pct) : '');
    } else {
      setName(''); setScenario('base'); setFiscalYear(new Date().getFullYear()); setSpreadMethod('even');
      setTotalRaw(''); setBasisPct('');
    }
    setErr(null);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalCents = toMinor(totalRaw, currency);
  const preview = totalCents && spreadMethod !== 'manual' ? buildPeriods(totalCents, fiscalYear, spreadMethod) : null;

  const submit = async () => {
    if (!name.trim() || name.trim().length < 2) { setErr('Give the forecast a name (at least 2 characters).'); return; }
    if (!isEdit && (!totalCents || totalCents <= 0) && spreadMethod !== 'manual') { setErr(`Enter the total projected amount in ${currency}.`); return; }
    setBusy(true); setErr(null);
    try {
      const body = { name: name.trim(), scenario, fiscal_year: Number(fiscalYear), spread_method: spreadMethod };
      if (totalCents && spreadMethod !== 'manual') body.total_projected_cents = totalCents;
      if (basisPct) body.basis_actual_pct = Number(basisPct);
      if (isEdit) {
        await api.patch(`/sponsorship-budgets/${budget.id}/forecasts/${existing.id}`, body);
      } else {
        await api.post(`/sponsorship-budgets/${budget.id}/forecasts`, body);
      }
      onDone?.();
      onClose();
    } catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={busy ? () => {} : onClose} title={isEdit ? 'Edit forecast' : 'New forecast'}
      footer={<><Btn small title="Cancel" color={c.paper} ink={c.ink} onPress={onClose} disabled={busy} /><View style={{ flex: 1 }} /><Btn title={busy ? 'Saving…' : isEdit ? 'Update' : 'Create forecast'} onPress={submit} loading={busy} /></>}>

      <Field label="Forecast name" value={name} onChangeText={v => { setErr(null); setName(v); }} maxLength={160}
        hint="E.g. 'FY 2026 Base — approved by board'" />

      <View style={{ gap: 8 }}>
        <T weight="800" size={13}>Scenario</T>
        <View style={{ gap: 6 }}>
          {SCENARIOS.map(s => (
            <Pressable key={s.value} onPress={() => setScenario(s.value)} accessibilityRole="radio" accessibilityState={{ selected: scenario === s.value }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 2, borderColor: scenario === s.value ? c.violet : c.line, backgroundColor: scenario === s.value ? c.violetSoft : c.paper }}>
              <T size={18}>{s.emoji}</T>
              <View style={{ flex: 1 }}><T weight="800">{s.label}</T><T size={12} color={c.mute}>{s.sub}</T></View>
              <T size={14} color={c.violet} weight="800">{scenario === s.value ? '✓' : ''}</T>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={{ gap: 8 }}>
        <T weight="800" size={13}>Spread method</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {SPREAD.map(s => <Chip key={s.value} label={s.label} active={spreadMethod === s.value} onPress={() => setSpreadMethod(s.value)} />)}
        </View>
        {SPREAD.find(s => s.value === spreadMethod) ? <T size={12} color={c.mute}>{SPREAD.find(s => s.value === spreadMethod).hint}</T> : null}
      </View>

      {spreadMethod !== 'manual' ? (
        <Field label={`Total projected (${currency})`} value={totalRaw} onChangeText={v => { setErr(null); setTotalRaw(v.replace(/[^0-9.,]/g, '')); }}
          keyboardType="decimal-pad" placeholder="0" hint={`Authorized: ${fmtMoney(authorized, currency)}. Forecast may exceed authorized.`} accessibilityLabel="Total projected amount" />
      ) : (
        <View style={{ backgroundColor: c.sunSoft, borderRadius: 12, padding: 12 }}>
          <T size={13}>Manual spread: set up the forecast first, then edit each month's amount from the detail view.</T>
        </View>
      )}

      <Field label="Based on utilisation % (optional)" value={basisPct} onChangeText={v => setBasisPct(v.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" placeholder="e.g. 87"
        hint="The historical utilisation % this forecast is based on. For reference only." accessibilityLabel="Basis utilisation percentage" />

      {preview ? (
        <View style={{ gap: 8, backgroundColor: c.violetSoft, borderRadius: 14, padding: 14 }}>
          <T weight="800" size={13}>Preview</T>
          <MonthGrid periods={preview} authorized={authorized} currency={currency} />
        </View>
      ) : null}

      {err ? <T size={13} color={c.red} accessibilityRole="alert">{err}</T> : null}
    </Sheet>
  );
}

/** Forecast section shown inside SponsorBudget detail view */
export function BudgetForecastSection({ budget, may, tick }) {
  const [activeScenario, setActiveScenario] = useState('base');
  const [form, setForm] = useState(null); // null | 'new' | {forecast object}
  const list = useLoad(() => api.get(`/sponsorship-budgets/${budget.id}/forecasts`).catch(() => []), [budget.id, tick]);
  const forecasts = list.data ?? [];
  const available = [...new Set(forecasts.map(f => f.scenario))];
  const shown = forecasts.find(f => f.scenario === activeScenario) ?? null;
  const authorized = Number(budget.authorized_cents);
  const currency = budget.currency;

  const archive = async (f) => {
    try { await api.del(`/sponsorship-budgets/${budget.id}/forecasts/${f.id}`); list.reload(); } catch { /* silent */ }
  };

  return (
    <Section title="Forecasts" color={c.violet} action={may ? '+ Forecast' : undefined} onAction={() => setForm('new')}>
      <T size={12} color={c.mute}>Monthly spend projections across scenarios. Forecasts help plan cash flow — they do not change what is authorized or committed.</T>

      {list.loading && !list.data ? <Loading /> : !forecasts.length ? (
        <Empty emoji="📈" title="No forecasts yet" sub={may ? 'Create a base forecast to project how this budget will be spent across the year.' : 'Forecasts appear here once a manager creates them.'} />
      ) : (
        <>
          <ScenarioTabs value={activeScenario} onChange={setActiveScenario} available={available} />
          {shown ? (
            <Card>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <T weight="900" style={{ flex: 1 }}>{shown.name}</T>
                <Tag label={shown.scenario} color={c.violetSoft} />
              </View>
              <T size={12} color={c.mute}>
                FY {shown.fiscal_year} · {shown.spread_method ?? 'manual'} spread
                {shown.basis_actual_pct != null ? ` · based on ${shown.basis_actual_pct}% utilisation` : ''}
                {' · '}created {new Date(shown.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                {shown.created_by_name ? ` by ${shown.created_by_name}` : ''}
              </T>
              <MonthGrid periods={shown.periods ?? []} authorized={authorized} currency={currency} />
              {may ? (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm(shown)} accessibilityLabel={`Edit ${shown.name}`} />
                  <Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => archive(shown)} accessibilityLabel={`Archive ${shown.name}`} />
                </View>
              ) : null}
            </Card>
          ) : (
            <T size={13} color={c.mute}>No {activeScenario} scenario for this budget.{may ? ' Use "+ Forecast" to create one.' : ''}</T>
          )}
        </>
      )}

      <BudgetForecastSheet visible={!!form} onClose={() => setForm(null)} budget={budget}
        existing={form === 'new' ? null : form} onDone={list.reload} />
    </Section>
  );
}
