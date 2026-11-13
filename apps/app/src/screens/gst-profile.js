// India GST billing profile (#503): per-venue profile (existing) + org billing profile (new).
// One place for it: the server checks the GSTIN, takes the state from it and shows CGST+SGST or IGST
// on invoices, credit notes and front-desk receipts.
import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, T, Tag, Section } from '../ui';
import { FormSheet } from '../FormSheet';
import { t } from '../i18n';
import { c } from '../theme';

// ─── Indian state code list ────────────────────────────────────────────────
const INDIAN_STATES = [
  { code: '01', label: 'Jammu & Kashmir' }, { code: '02', label: 'Himachal Pradesh' },
  { code: '03', label: 'Punjab' }, { code: '04', label: 'Chandigarh' },
  { code: '05', label: 'Uttarakhand' }, { code: '06', label: 'Haryana' },
  { code: '07', label: 'Delhi' }, { code: '08', label: 'Rajasthan' },
  { code: '09', label: 'Uttar Pradesh' }, { code: '10', label: 'Bihar' },
  { code: '11', label: 'Sikkim' }, { code: '12', label: 'Arunachal Pradesh' },
  { code: '13', label: 'Nagaland' }, { code: '14', label: 'Manipur' },
  { code: '15', label: 'Mizoram' }, { code: '16', label: 'Tripura' },
  { code: '17', label: 'Meghalaya' }, { code: '18', label: 'Assam' },
  { code: '19', label: 'West Bengal' }, { code: '20', label: 'Jharkhand' },
  { code: '21', label: 'Odisha' }, { code: '22', label: 'Chhattisgarh' },
  { code: '23', label: 'Madhya Pradesh' }, { code: '24', label: 'Gujarat' },
  { code: '25', label: 'Daman & Diu' }, { code: '26', label: 'Dadra & Nagar Haveli' },
  { code: '27', label: 'Maharashtra' }, { code: '28', label: 'Andhra Pradesh (old)' },
  { code: '29', label: 'Karnataka' }, { code: '30', label: 'Goa' },
  { code: '31', label: 'Lakshadweep' }, { code: '32', label: 'Kerala' },
  { code: '33', label: 'Tamil Nadu' }, { code: '34', label: 'Puducherry' },
  { code: '35', label: 'Andaman & Nicobar' }, { code: '36', label: 'Telangana' },
  { code: '37', label: 'Andhra Pradesh' },
];

const ENTITY_TYPES = ['Private Limited', 'Public Limited', 'LLP', 'Partnership', 'Trust', 'Society', 'Sole Proprietor', 'Other'];
const GST_REG_STATUS = ['regular', 'composition', 'sez', 'unregistered', 'overseas'];
const GST_REG_LABELS = { regular: 'Regular', composition: 'Composition', sez: 'SEZ', unregistered: 'Unregistered', overseas: 'Overseas' };
const ROUNDING_POLICIES = ['half_up', 'floor', 'ceiling'];
const RATE_OPTIONS = [{ bp: 500, label: '5%' }, { bp: 1200, label: '12%' }, { bp: 1800, label: '18%' }, { bp: 2800, label: '28%' }];
const WITHHOLDING_DEFAULTS = [
  { section_ref: '194J', label: 'Professional Services (194J)', rate_bp: 1000, threshold_cents: 3000000 },
  { section_ref: '194C', label: 'Contracts / Services (194C)', rate_bp: 100, threshold_cents: 3000000 },
  { section_ref: '194I', label: 'Rent (194I)', rate_bp: 1000, threshold_cents: 24000000 },
];

function gstinFormatOk(g) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(g || '').trim().toUpperCase());
}

function fmt(cents, cur = 'INR') {
  if (!cents && cents !== 0) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(cents / 100);
}

// ─── Chip row ──────────────────────────────────────────────────────────────
function Chips({ options, value, onSelect, labelFn }) {
  return (
    <View style={s.chipRow}>
      {options.map(opt => {
        const selected = opt === value || (opt.bp !== undefined && opt.bp === value);
        const label = labelFn ? labelFn(opt) : (typeof opt === 'object' ? opt.label : opt);
        return (
          <TouchableOpacity key={String(opt.bp ?? opt)} onPress={() => onSelect(opt.bp ?? opt)}
            style={[s.chip, selected && { backgroundColor: c.pink, borderColor: c.pink }]}
            accessibilityRole="radio" accessibilityState={{ selected }}>
            <T size={12} weight="600" color={selected ? '#fff' : c.violet}>{label}</T>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Org Billing Profile Card ──────────────────────────────────────────────
export function OrgBillingProfileCard({ orgId }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revealPan, setRevealPan] = useState(false);
  const [revealTan, setRevealTan] = useState(false);

  const profile = useLoad(() => api.get(`/org-billing-profiles/${orgId}`), [orgId]);
  const history = useLoad(() => historyOpen ? api.get(`/org-billing-profiles/${orgId}/history`) : Promise.resolve([]), [orgId, historyOpen]);

  const p = profile.data;

  // Form state mirrors all billing profile fields
  const [form, setForm] = useState(null);
  const startEdit = () => {
    setForm({
      legal_name: p?.legal_name ?? '',
      trade_name: p?.trade_name ?? '',
      entity_type: p?.entity_type ?? '',
      cin: p?.cin ?? '',
      gstin: p?.gstin ?? '',
      pan: '',
      tan: '',
      state_code: p?.state_code ?? '',
      billing_address: '',
      invoice_prefix: p?.invoice_prefix ?? '',
      invoice_series: p?.invoice_series ?? '',
      auto_rotate_fy: p?.auto_rotate_fy !== false,
      gst_registration_status: p?.gst_registration_status ?? 'regular',
      einvoice_threshold: p?.einvoice_threshold ?? false,
      reverse_charge_applicable: p?.reverse_charge_applicable ?? false,
      lut_bond_number: p?.lut_bond_number ?? '',
      default_sac_code: p?.default_sac_code ?? '',
      tax_inclusive: p?.tax_inclusive ?? false,
      default_rate_bp: p?.default_rate_bp ?? 1800,
      rounding_policy: p?.rounding_policy ?? 'half_up',
    });
    setOpen(true);
  };

  const save = async () => {
    if (form.gstin && !gstinFormatOk(form.gstin)) {
      toast(t('gst.gstinInvalid')); return;
    }
    await api.post(`/org-billing-profiles/${orgId}`, {
      ...form,
      gstin: form.gstin ? form.gstin.trim().toUpperCase() : undefined,
    });
    await profile.reload();
    toast(t('gst.saved'));
    setOpen(false);
  };

  const handleRevealPan = async () => {
    const full = await api.get(`/org-billing-profiles/${orgId}`);
    setRevealPan(full.pan || '—');
  };
  const handleRevealTan = async () => {
    const full = await api.get(`/org-billing-profiles/${orgId}`);
    setRevealTan(full.tan || '—');
  };

  const whMatrix = p?.withholding_matrix || WITHHOLDING_DEFAULTS;

  return (
    <Card style={s.card}>
      {/* Header */}
      <View style={s.row}>
        <T weight="700" size={15} style={{ flex: 1 }}>{t('gst.orgBillingProfile')}</T>
        {p && <Tag label="ACTIVE" color={c.limeSoft} textColor={c.success} />}
      </View>
      {p && (
        <T size={12} color={c.mute} style={{ marginTop: 2 }}>
          {t('gst.billingProfileVersion', { n: 'current', date: p.effective_from })}
        </T>
      )}

      {!p && (
        <View style={s.emptyBox}>
          <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{t('gst.noProfile')}</T>
        </View>
      )}

      {p && (
        <>
          {/* Identity */}
          <View style={s.fieldGrid}>
            <InfoRow label={t('gst.legalName')} value={p.legal_name} />
            {p.trade_name ? <InfoRow label={t('gst.tradeName')} value={p.trade_name} /> : null}
            {p.entity_type ? <InfoRow label={t('gst.entityType')} value={p.entity_type} /> : null}
            {p.cin ? <InfoRow label={t('gst.cin')} value={p.cin} mono /> : null}
          </View>

          {/* GSTIN */}
          <View style={[s.row, { marginTop: 10 }]}>
            <InfoRow label={t('gst.gstin')} value={p.gstin} mono style={{ flex: 1 }} />
            {p.gstin && (
              <Tag label={gstinFormatOk(p.gstin) ? `✓ ${t('gst.gstinValid')}` : t('gst.gstinInvalid')}
                color={gstinFormatOk(p.gstin) ? c.limeSoft : c.sunSoft}
                textColor={gstinFormatOk(p.gstin) ? c.success : c.danger} />
            )}
          </View>
          <InfoRow label={t('gst.stateCode')} value={`${p.state_code} — ${INDIAN_STATES.find(x => x.code === p.state_code)?.label ?? ''}`} />

          {/* GST Reg status chip */}
          <View style={[s.row, { marginTop: 8 }]}>
            <T size={12} color={c.mute} style={{ marginInlineEnd: 8 }}>{t('gst.registrationStatus')}:</T>
            <Tag label={GST_REG_LABELS[p.gst_registration_status] ?? p.gst_registration_status}
              color={c.pinkSoft} textColor={c.pink} />
          </View>

          {/* Invoice series */}
          <View style={s.separator} />
          <T size={11} weight="700" color={c.violet} style={s.sectionLabel}>INVOICE SERIES</T>
          <View style={s.fieldGrid}>
            <InfoRow label={t('gst.invoicePrefix')} value={p.invoice_prefix} mono />
            <InfoRow label={t('gst.invoiceSeries')} value={p.invoice_series} mono />
            <InfoRow label={t('gst.currentNumber')} value={String(p.current_number ?? 1).padStart(5, '0')} mono />
          </View>

          {/* PAN / TAN */}
          <View style={s.separator} />
          <T size={11} weight="700" color={c.violet} style={s.sectionLabel}>PAN / TAN</T>
          <View style={s.row}>
            <InfoRow label={t('gst.panRef')} value={revealPan || '••••••••••'} mono style={{ flex: 1 }} />
            <TouchableOpacity onPress={handleRevealPan} style={s.revealBtn} accessibilityLabel={t('gst.reveal')}>
              <T size={12} color={c.pink}>{t('gst.reveal')}</T>
            </TouchableOpacity>
          </View>
          <View style={s.row}>
            <InfoRow label={t('gst.tanRef')} value={revealTan || '••••••••••'} mono style={{ flex: 1 }} />
            <TouchableOpacity onPress={handleRevealTan} style={s.revealBtn} accessibilityLabel={t('gst.reveal')}>
              <T size={12} color={c.pink}>{t('gst.reveal')}</T>
            </TouchableOpacity>
          </View>

          {/* Withholding matrix */}
          <View style={s.separator} />
          <T size={11} weight="700" color={c.violet} style={s.sectionLabel}>{t('gst.withholdingMatrix').toUpperCase()}</T>
          {whMatrix.map(row => (
            <View key={row.section_ref} style={s.tableRow}>
              <T size={12} style={{ flex: 1 }}>{row.label || row.section_ref}</T>
              <T size={12} color={c.mute}>{row.rate_bp / 100}%</T>
              <T size={12} color={c.mute} style={{ marginInlineStart: 12 }}>
                ≥ {fmt(row.threshold_cents)}
              </T>
            </View>
          ))}

          {/* E-invoice & RCM toggles (read-only) */}
          <View style={s.separator} />
          <View style={s.row}>
            <T size={13} style={{ flex: 1 }}>{t('gst.einvoiceThreshold')}</T>
            <Tag label={p.einvoice_threshold ? 'ON' : 'OFF'}
              color={p.einvoice_threshold ? c.limeSoft : c.violetSoft}
              textColor={p.einvoice_threshold ? c.success : c.mute} />
          </View>
          <View style={[s.row, { marginTop: 6 }]}>
            <T size={13} style={{ flex: 1 }}>{t('gst.reverseCharge')}</T>
            <Tag label={p.reverse_charge_applicable ? 'ON' : 'OFF'}
              color={p.reverse_charge_applicable ? c.sunSoft : c.violetSoft}
              textColor={p.reverse_charge_applicable ? c.danger : c.mute} />
          </View>
        </>
      )}

      <Btn small title={p ? t('gst.editBillingProfile') : t('gst.add')}
        color={c.pink} onPress={startEdit}
        style={{ marginTop: 14, alignSelf: 'flex-start' }}
        accessibilityLabel={t('gst.orgBillingProfile')} />

      {/* Version history toggle */}
      {p && (
        <TouchableOpacity onPress={() => setHistoryOpen(x => !x)} style={{ marginTop: 10 }}
          accessibilityRole="button">
          <T size={12} color={c.pink}>
            {historyOpen ? '▲ ' : '▼ '}{t('gst.versionHistory')}
          </T>
        </TouchableOpacity>
      )}
      {historyOpen && Array.isArray(history.data) && history.data.map((v, i) => (
        <View key={v.id} style={s.historyRow}>
          <T size={12} weight="600">v{history.data.length - i} · {v.effective_from}</T>
          <T size={12} color={c.mute} style={{ marginInlineStart: 8 }}>{v.legal_name} · {v.gstin}</T>
          {v.archived_at && <T size={11} color={c.mute}> (archived)</T>}
        </View>
      ))}

      {/* Edit FormSheet */}
      {form && (
        <FormSheet visible={open} onClose={() => { setOpen(false); setForm(null); }}
          title={t('gst.editBillingProfile')}
          initial={form}
          fields={[
            { key: 'legal_name',  label: t('gst.legalName'), required: true },
            { key: 'trade_name',  label: t('gst.tradeName'), optional: true },
            { key: 'entity_type', label: t('gst.entityType'), type: 'select', options: ENTITY_TYPES.map(v => ({ value: v, label: v })) },
            { key: 'cin',         label: t('gst.cin'), optional: true, hint: 'e.g. U93090MH2019PTC123456' },
            { key: 'gstin',       label: t('gst.gstin'), hint: '15 characters, e.g. 27AAACN1234F1Z5' },
            { key: 'pan',         label: t('gst.panRef'), optional: true, hint: 'Encrypted at rest' },
            { key: 'tan',         label: t('gst.tanRef'), optional: true, hint: 'Encrypted at rest' },
            { key: 'state_code',  label: t('gst.stateCode'), type: 'select', options: INDIAN_STATES.map(x => ({ value: x.code, label: `${x.code} — ${x.label}` })) },
            { key: 'billing_address', label: 'Registered Address', optional: true, multiline: true, hint: 'Encrypted at rest' },
            { key: 'invoice_prefix', label: t('gst.invoicePrefix'), optional: true, hint: 'e.g. NTA' },
            { key: 'invoice_series', label: t('gst.invoiceSeries'), optional: true, hint: 'e.g. 2025-26' },
            { key: 'auto_rotate_fy', label: t('gst.autoRotateFy'), type: 'switch' },
            { key: 'gst_registration_status', label: t('gst.registrationStatus'), type: 'select', options: GST_REG_STATUS.map(v => ({ value: v, label: GST_REG_LABELS[v] })) },
            { key: 'einvoice_threshold', label: t('gst.einvoiceThreshold'), type: 'switch' },
            { key: 'reverse_charge_applicable', label: t('gst.reverseCharge'), type: 'switch' },
            { key: 'lut_bond_number', label: t('gst.lutBondNumber'), optional: true },
            { key: 'default_sac_code', label: t('gst.defaultSacCode'), optional: true, hint: 'e.g. 999311' },
            { key: 'tax_inclusive', label: t('gst.taxInclusive'), type: 'switch' },
            { key: 'default_rate_bp', label: t('gst.defaultRate'), type: 'select', options: RATE_OPTIONS.map(r => ({ value: r.bp, label: r.label })) },
            { key: 'rounding_policy', label: t('gst.roundingPolicy'), type: 'select', options: ROUNDING_POLICIES.map(v => ({ value: v, label: v.replace('_', ' ') })) },
          ]}
          onSubmit={save}
        />
      )}
    </Card>
  );
}

function InfoRow({ label, value, mono, style }) {
  return (
    <View style={[{ marginTop: 4 }, style]}>
      <T size={11} color={c.mute} weight="600">{label}</T>
      <T size={13} weight={mono ? '500' : '400'} style={mono ? { fontFamily: 'monospace' } : undefined}>
        {value || '—'}
      </T>
    </View>
  );
}

// ─── Per-venue GST Profile Card (existing, preserved) ─────────────────────
export function GstProfileCard({ venueId, currency }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const gst = useLoad(() => api.get(`/gst-profiles/venue/${venueId}`), [venueId]);
  if (currency !== 'INR') return null;
  const p = gst.data?.profile;
  return (
    <Card style={s.card}>
      <T weight="700" size={15}>{t('gst.title')}</T>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>
        {p ? t('gst.summary', { gstin: p.gstin, state: p.state_code, rate: p.rate_bp / 100 }) : t('gst.none')}
      </T>
      <Btn small title={p ? t('gst.edit') : t('gst.add')} color={c.violet}
        onPress={() => setOpen(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }}
        accessibilityLabel={t('gst.title')} />
      <FormSheet visible={open} onClose={() => setOpen(false)} title={t('gst.title')}
        initial={{ gstin: p?.gstin ?? '', default_sac: p?.default_sac ?? '', rate_pct: p ? p.rate_bp / 100 : 18, tax_inclusive: p?.tax_inclusive ?? true }}
        fields={[
          { key: 'gstin',       label: t('gst.gstin'),    hint: t('gst.gstin_hint') },
          { key: 'default_sac', label: t('gst.sac'),      optional: true, hint: t('gst.sac_hint') },
          { key: 'rate_pct',    label: t('gst.rate'),     type: 'stepper', min: 0, max: 40, step: 0.5, suffix: '%' },
          { key: 'tax_inclusive', label: t('gst.inclusive'), type: 'switch' },
        ]}
        onSubmit={async ({ rate_pct, gstin, default_sac, ...f }) => {
          await api.post(`/gst-profiles/venue/${venueId}`, { ...f, gstin: String(gstin).trim().toUpperCase(), ...(default_sac ? { default_sac } : {}), rate_bp: Math.round((rate_pct ?? 18) * 100) });
          await gst.reload(); toast(t('gst.saved')); return t('gst.saved');
        }} />
    </Card>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  card:        { marginBottom: 12 },
  row:         { flexDirection: 'row', alignItems: 'center' },
  chipRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chip:        { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: c.border },
  fieldGrid:   { gap: 6, marginTop: 8 },
  separator:   { height: 1, backgroundColor: c.border, marginVertical: 12 },
  sectionLabel: { marginBottom: 6, letterSpacing: 0.5 },
  tableRow:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.border },
  historyRow:  { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: c.border },
  emptyBox:    { paddingVertical: 20, alignItems: 'center' },
  revealBtn:   { paddingHorizontal: 10, paddingVertical: 4 },
});
