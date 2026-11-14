// GST Period Report screen (#503): GSTR-1 breakup, HSN/SAC summary, reconciliation.
// Fetches from GET /gst-report?org_id=...&from=...&to=...
import React, { useState, useCallback } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Card, T, Tag, Btn, Section } from '../ui';
import { t } from '../i18n';
import { c } from '../theme';

const DOC_TYPE_LABELS = {
  invoice:      'B2B Invoices',
  b2cs:         'B2CS (< ₹2.5L)',
  b2cl:         'B2CL (> ₹2.5L)',
  credit_note:  'Credit Notes (B2B)',
  nil_exempt:   'Nil Rated / Exempt',
  advance:      'Advance Receipts',
  rcm:          'RCM Supplies',
  debit_note:   'Debit Notes',
  replacement:  'Replacement Invoices',
};

const FYS = ['2025-26', '2024-25', '2023-24'];
const QUARTERS = [
  { label: 'Q1 (Apr–Jun)', from: '-04-01', to: '-06-30' },
  { label: 'Q2 (Jul–Sep)', from: '-07-01', to: '-09-30' },
  { label: 'Q3 (Oct–Dec)', from: '-10-01', to: '-12-31' },
  { label: 'Q4 (Jan–Mar)', from: '-01-01', to: '-03-31' },
];

function fiscalYear(fy) {
  // e.g. '2025-26' → start year 2025
  return parseInt(fy.split('-')[0], 10);
}

function quarterDates(fy, qIdx) {
  const yr = fiscalYear(fy);
  const q = QUARTERS[qIdx];
  const startYear = qIdx < 3 ? yr : yr + 1;
  return {
    from: `${startYear}${q.from}`,
    to:   `${startYear}${q.to}`,
  };
}

function moneyINR(cents) {
  if (cents === undefined || cents === null) return '—';
  const n = Number(cents);
  if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (Math.abs(n) >= 100000)   return `₹${(n / 100000).toFixed(2)} L`;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n / 100);
}

function KpiTile({ label, value, color }) {
  return (
    <View style={[st.kpiTile, { backgroundColor: color || c.pinkSoft }]}>
      <T size={11} color={c.violet} weight="600">{label}</T>
      <T size={15} weight="700" color={c.ink} style={{ marginTop: 4 }}>{value}</T>
    </View>
  );
}

function TableRow({ cols, header, highlight }) {
  return (
    <View style={[st.tableRow, header && st.tableHeader, highlight && { backgroundColor: c.sunSoft }]}>
      {cols.map((col, i) => (
        <T key={i} size={12} weight={header ? '700' : '400'} color={header ? c.violet : c.ink}
          style={[{ flex: i === 0 ? 2 : 1, textAlign: i > 0 ? 'right' : 'left' }]}>
          {col}
        </T>
      ))}
    </View>
  );
}

export function GstReportScreen({ orgId }) {
  const [fy, setFy] = useState('2025-26');
  const [qIdx, setQIdx] = useState(1); // Q2
  const [tab, setTab] = useState('gstr1'); // gstr1 | hsn | recon
  const [customMode, setCustomMode] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const { from, to } = customMode && customFrom && customTo
    ? { from: customFrom, to: customTo }
    : quarterDates(fy, qIdx);

  const report = useLoad(
    () => api.get(`/gst-report?org_id=${orgId}&from=${from}&to=${to}`),
    [orgId, from, to],
  );

  const data = report.data;
  const totals = data?.totals || {};
  const breakdown = data?.breakdown || [];

  const creditRows = breakdown.filter(r => r.document_type === 'credit_note' || r.document_type === 'debit_note');
  const creditTax = creditRows.reduce((s, r) => s + Number(r.total_tax_cents || 0), 0);
  const netGst = Number(totals.total_tax_cents || 0) - Math.abs(creditTax);

  const handleExportCsv = async () => {
    await api.get(`/gst-report?org_id=${orgId}&from=${from}&to=${to}&format=csv`);
  };

  return (
    <ScrollView style={st.screen} contentContainerStyle={{ paddingBottom: 40 }}>
      <T size={18} weight="700" style={st.title}>{t('gst.periodReport')}</T>

      {/* Period selector */}
      <Card style={st.card}>
        <T size={11} weight="700" color={c.violet} style={st.secLabel}>FINANCIAL YEAR</T>
        <View style={st.chipRow}>
          {FYS.map(f => (
            <TouchableOpacity key={f} onPress={() => { setFy(f); setCustomMode(false); }}
              style={[st.chip, f === fy && !customMode && st.chipActive]}
              accessibilityRole="radio" accessibilityState={{ selected: f === fy && !customMode }}>
              <T size={12} weight="600" color={f === fy && !customMode ? '#fff' : c.violet}>FY {f}</T>
            </TouchableOpacity>
          ))}
        </View>

        <T size={11} weight="700" color={c.violet} style={[st.secLabel, { marginTop: 10 }]}>QUARTER</T>
        <View style={st.chipRow}>
          {QUARTERS.map((q, i) => (
            <TouchableOpacity key={i} onPress={() => { setQIdx(i); setCustomMode(false); }}
              style={[st.chip, i === qIdx && !customMode && st.chipActive]}
              accessibilityRole="radio" accessibilityState={{ selected: i === qIdx && !customMode }}>
              <T size={12} weight="600" color={i === qIdx && !customMode ? '#fff' : c.violet}>{q.label}</T>
            </TouchableOpacity>
          ))}
        </View>

        <T size={12} color={c.mute} style={{ marginTop: 8 }}>
          Period: {from} → {to}
        </T>
      </Card>

      {/* KPI strip */}
      {report.loading ? (
        <T size={13} color={c.mute} style={{ padding: 16 }}>{t('common.loading')}</T>
      ) : (
        <>
          <View style={st.kpiGrid}>
            <KpiTile label={t('gst.taxableValue')} value={moneyINR(totals.taxable_cents)} color={c.cyanSoft} />
            <KpiTile label={t('gst.cgst')} value={moneyINR(totals.cgst_cents)} color={c.pinkSoft} />
            <KpiTile label={t('gst.sgst')} value={moneyINR(totals.sgst_cents)} color={c.pinkSoft} />
          </View>
          <View style={st.kpiGrid}>
            <KpiTile label={t('gst.igst')} value={moneyINR(totals.igst_cents)} color={c.violetSoft} />
            <KpiTile label={t('gst.creditNotes')} value={moneyINR(creditTax)} color={c.sunSoft} />
            <KpiTile label={t('gst.netGstPayable')} value={moneyINR(netGst)} color={c.limeSoft} />
          </View>

          {/* Tabs */}
          <View style={st.tabRow}>
            {[
              { key: 'gstr1', label: t('gst.gstr1Breakup') },
              { key: 'hsn',   label: t('gst.hsnSacSummary') },
              { key: 'recon', label: t('gst.reconciliation') },
            ].map(tb => (
              <TouchableOpacity key={tb.key} onPress={() => setTab(tb.key)}
                style={[st.tab, tb.key === tab && st.tabActive]}
                accessibilityRole="tab" accessibilityState={{ selected: tb.key === tab }}>
                <T size={13} weight="600" color={tb.key === tab ? c.pink : c.mute}>{tb.label}</T>
              </TouchableOpacity>
            ))}
          </View>

          {/* GSTR-1 Breakup */}
          {tab === 'gstr1' && (
            <Card style={st.card}>
              <TableRow header cols={['Document Type', 'Count', 'Taxable', 'Tax']} />
              {breakdown.length === 0 && (
                <T size={13} color={c.mute} style={{ padding: 12 }}>{t('empty.nothing')}</T>
              )}
              {breakdown.map(r => (
                <TableRow key={r.document_type}
                  highlight={r.document_type === 'credit_note' || r.document_type === 'debit_note'}
                  cols={[
                    DOC_TYPE_LABELS[r.document_type] || r.document_type,
                    String(r.count),
                    moneyINR(r.taxable_cents),
                    moneyINR(r.total_tax_cents),
                  ]} />
              ))}
              {/* Totals row */}
              {breakdown.length > 0 && (
                <View style={[st.tableRow, { borderTopWidth: 2, borderTopColor: c.border }]}>
                  <T size={12} weight="700" style={{ flex: 2 }}>Total</T>
                  <T size={12} weight="700" style={{ flex: 1, textAlign: 'right' }}>{breakdown.reduce((s,r)=>s+r.count,0)}</T>
                  <T size={12} weight="700" style={{ flex: 1, textAlign: 'right' }}>{moneyINR(totals.taxable_cents)}</T>
                  <T size={12} weight="700" style={{ flex: 1, textAlign: 'right' }}>{moneyINR(totals.total_tax_cents)}</T>
                </View>
              )}
            </Card>
          )}

          {/* HSN / SAC Summary */}
          {tab === 'hsn' && (
            <Card style={st.card}>
              <T size={12} color={c.mute} style={{ marginBottom: 8 }}>
                HSN/SAC-wise summary across all invoices in this period.
              </T>
              <TableRow header cols={['SAC/HSN', 'Description', 'Taxable', 'Rate', 'Tax']} />
              {breakdown.length === 0 && (
                <T size={13} color={c.mute} style={{ padding: 12 }}>{t('empty.nothing')}</T>
              )}
              {/* HSN rows come from gst_detail on invoices; shown when API supports it */}
              <T size={12} color={c.mute} style={{ padding: 8 }}>
                HSN/SAC-wise detail available once invoices carry gst_detail with hsn_sac_code.
              </T>
            </Card>
          )}

          {/* Reconciliation */}
          {tab === 'recon' && (
            <Card style={st.card}>
              <T size={13} weight="700" style={{ marginBottom: 8 }}>{t('gst.reconciliation')}</T>
              <TableRow header cols={['Category', 'Invoiced', 'Collected', 'Variance']} />
              {breakdown.map(r => (
                <TableRow key={r.document_type}
                  highlight={Number(r.paid_count || 0) < Number(r.count || 0)}
                  cols={[
                    DOC_TYPE_LABELS[r.document_type] || r.document_type,
                    moneyINR(r.gross_cents),
                    moneyINR(r.paid_count > 0 ? r.gross_cents : 0),
                    r.paid_count < r.count ? `${r.count - r.paid_count} unpaid` : '—',
                  ]} />
              ))}
            </Card>
          )}

          {/* Export */}
          <View style={st.exportRow}>
            <Btn small title={t('gst.exportGstr1Json')} color={c.violet} onPress={handleExportCsv}
              accessibilityLabel={t('gst.exportGstr1Json')} />
            <Btn small title={t('gst.exportCsv')} color={c.violet} onPress={handleExportCsv}
              style={{ marginInlineStart: 8 }} accessibilityLabel={t('gst.exportCsv')} />
          </View>
        </>
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  title:     { margin: 16, marginBottom: 8 },
  card:      { marginHorizontal: 16, marginBottom: 12 },
  secLabel:  { marginBottom: 4, letterSpacing: 0.5 },
  chipRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip:      { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: c.border },
  chipActive:{ backgroundColor: c.pink, borderColor: c.pink },
  kpiGrid:   { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginBottom: 8 },
  kpiTile:   { flex: 1, borderRadius: 10, padding: 12 },
  tabRow:    { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  tab:       { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: c.pink },
  tableRow:  { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  tableHeader: { backgroundColor: c.violetSoft },
  exportRow: { flexDirection: 'row', marginHorizontal: 16, marginTop: 8 },
});
