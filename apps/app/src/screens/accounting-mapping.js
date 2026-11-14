// Accounting mapping editor (#513 — CA-grade): effective-dated Chart-of-Accounts mapping with
// GST profile validation, template loader, and mapping completeness checks.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { DatePicker } from '../pickers';
import { t } from '../i18n';
import { c, day } from '../theme';
import { money, atLeast } from './finance-parts';

/* ─────────────────────── constants ─────────────────────── */
const PROVIDER_OPTS = [
  { value: 'accounting_tally',      label: t('acct.provider.tally') },
  { value: 'accounting_zoho_books', label: t('acct.provider.zoho_books') },
];
const MAP_TYPE_TABS = [
  { value: 'ledger',      label: t('acct.mapping.type.ledger') },
  { value: 'tax',         label: t('acct.mapping.type.tax') },
  { value: 'clearing',    label: t('acct.mapping.type.clearing') },
  { value: 'cost_centre', label: t('acct.mapping.type.cost_centre') },
];
const TAX_COMPONENTS = [
  { value: 'cgst', label: 'CGST (Central GST)' },
  { value: 'sgst', label: 'SGST (State GST)' },
  { value: 'igst', label: 'IGST (Integrated GST)' },
  { value: 'cess', label: 'GST Cess' },
  { value: 'tds_194c', label: 'TDS Section 194C (Contractors)' },
  { value: 'tds_194j', label: 'TDS Section 194J (Professional fees)' },
];
const CLEARING_KEYS = [
  { value: 'receivable',    label: t('acct.mapping.clearing.receivable') },
  { value: 'payable',       label: t('acct.mapping.clearing.payable') },
  { value: 'advance_recv',  label: t('acct.mapping.clearing.advance_recv') },
  { value: 'advance_paid',  label: t('acct.mapping.clearing.advance_paid') },
  { value: 'bank',          label: t('acct.mapping.clearing.bank') },
  { value: 'cash',          label: t('acct.mapping.clearing.cash') },
];
const REQUIRED_TAX = ['cgst', 'sgst', 'igst'];

/* ─────────────────────── validation chip ─────────────────────── */
function ValidationChip({ label, ok }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: ok ? c.limeSoft : c.orangeSoft }}>
      <T size={12} weight="700" color={ok ? c.lime : c.orange}>{ok ? '✓' : '⚠'} {label}</T>
    </View>
  );
}

/* ─────────────────────── mapping row ─────────────────────── */
function MappingRow({ m, onEdit }) {
  return (
    <Pressable accessibilityRole="button"
      accessibilityLabel={`${m.source_key} → ${m.target_account}, ${t(`acct.mapping.type.${m.mapping_type}`)}`}
      onPress={() => onEdit(m)} style={{ minHeight: 52 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, gap: 10 }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T size={14} weight="700">{m.source_key.toUpperCase()}</T>
            <T size={14} color={c.mute}>→</T>
            <T size={14} weight="700" color={c.cyan} style={{ fontFamily: 'monospace' }}>{m.target_account}</T>
          </View>
          <T size={12} color={c.mute}>{day(m.effective_from)} – {m.effective_to ? day(m.effective_to) : t('acct.mapping.open')}</T>
        </View>
        <Tag label={t(`acct.mapping.type.${m.mapping_type}`)} color={c.violetSoft} />
      </View>
    </Pressable>
  );
}

/* ─────────────────────── Add mapping sheet ─────────────────────── */
function AddMappingSheet({ visible, onClose, onSaved, provider, orgId, template, editRow }) {
  const [mapType,       setMapType]       = useState(editRow?.mapping_type ?? 'ledger');
  const [sourceKey,     setSourceKey]     = useState(editRow?.source_key   ?? '');
  const [targetAccount, setTargetAccount] = useState(editRow?.target_account ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(editRow?.effective_from ?? '');
  const [effectiveTo,   setEffectiveTo]   = useState(editRow?.effective_to   ?? '');
  const [busy,          setBusy]          = useState(false);
  const [err,           setErr]           = useState(null);

  // Source options depend on mapping type
  const sourceOpts = (() => {
    if (mapType === 'tax')         return TAX_COMPONENTS;
    if (mapType === 'clearing')    return CLEARING_KEYS;
    if (mapType === 'cost_centre') return (template?.branches ?? []).map((b) => ({ value: b.id, label: b.name }));
    // Ledger: use product categories from template
    return (template?.ledger_keys ?? []).map((k) => ({ value: k.id, label: `${k.name}${k.hsn_sac ? ` (${k.hsn_sac})` : ''}` }));
  })();

  const save = async () => {
    if (!sourceKey.trim())     { setErr(t('acct.mapping.err.source_required')); return; }
    if (!targetAccount.trim()) { setErr(t('acct.mapping.err.target_required')); return; }
    if (!effectiveFrom)        { setErr(t('acct.mapping.err.from_required'));    return; }
    setBusy(true); setErr(null);
    try {
      const body = {
        provider, mapping_type: mapType, source_key: sourceKey.trim(),
        target_account: targetAccount.trim(), effective_from: effectiveFrom,
        ...(effectiveTo ? { effective_to: effectiveTo } : {}),
      };
      await api.post(`/organisations/${orgId}/accounting/mappings`, body);
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const title = editRow ? t('acct.mapping.edit_title') : t('acct.mapping.add_title');

  return (
    <FormSheet visible={visible} onClose={onClose} title={title}>
      <View style={{ gap: 14 }}>
        <Seg options={MAP_TYPE_TABS} value={mapType} onChange={(v) => { setMapType(v); setSourceKey(''); }} />

        {/* Source key */}
        {sourceOpts.length > 0 ? (
          <MenuField label={t('acct.mapping.source_key')} value={sourceKey} onChange={setSourceKey} options={sourceOpts} />
        ) : (
          <Field label={t('acct.mapping.source_key')} value={sourceKey} onChangeText={setSourceKey}
            placeholder={t('acct.mapping.source_key_placeholder')} autoCapitalize="none"
            accessibilityLabel={t('acct.mapping.source_key')} />
        )}

        {/* Target account CoA code */}
        <Field label={t('acct.mapping.target_account')} value={targetAccount} onChangeText={setTargetAccount}
          placeholder={t('acct.mapping.target_account_placeholder')} autoCapitalize="characters"
          accessibilityLabel={t('acct.mapping.target_account')}
          style={{ fontFamily: 'monospace' }} />

        <T size={12} color={c.mute}>{t('acct.mapping.target_account_hint')}</T>

        <DatePicker label={t('acct.mapping.effective_from')} value={effectiveFrom} onChange={setEffectiveFrom} />
        <DatePicker label={t('acct.mapping.effective_to_opt')} value={effectiveTo} onChange={setEffectiveTo} />

        {err ? <T size={13} color={c.red}>{err}</T> : null}

        <Btn title={t('common.save')} loading={busy} onPress={save} color={c.pink} ink="#fff" accessibilityLabel={t('acct.mapping.save')} />
      </View>
    </FormSheet>
  );
}

/* ─────────────────────── Main editor ─────────────────────── */
export function AccountingMappingEditor({ orgId }) {
  const [provider, setProvider] = useState('accounting_tally');
  const [mapType,  setMapType]  = useState('');
  const [adding,   setAdding]   = useState(false);
  const [editRow,  setEditRow]  = useState(null);
  const [reload,   setReload]   = useState(0);

  const params  = { provider, ...(mapType ? { mapping_type: mapType } : {}) };
  const data    = useLoad(() => api.get(`/organisations/${orgId}/accounting/mappings`, params), [orgId, provider, mapType, reload]);
  const tmpl    = useLoad(() => api.get(`/organisations/${orgId}/accounting/mappings/template`, { provider }), [orgId, provider]);
  const gstProf = tmpl.data?.gst_profile;

  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;

  // Validation: check required tax components mapped
  const mappedKeys   = (data.data?.items ?? []).map((m) => m.source_key);
  const missingTax   = REQUIRED_TAX.filter((k) => !mappedKeys.includes(k));
  const hasLedger    = mappedKeys.some((k) => !['cgst','sgst','igst','cess','tds_194c','tds_194j','receivable','payable','advance_recv','advance_paid','bank','cash'].includes(k));
  const hasClearing  = mappedKeys.includes('receivable');

  const loadTemplate = async () => {
    if (!tmpl.data?.template_rows?.length) return;
    // Bulk-add template rows that aren't already mapped
    for (const row of tmpl.data.template_rows) {
      if (mappedKeys.includes(row.source_key)) continue;
      try {
        await api.post(`/organisations/${orgId}/accounting/mappings`, { ...row, provider });
      } catch { /* skip conflicts */ }
    }
    setReload((r) => r + 1);
  };

  const filterOpts = [{ value: '', label: t('common.all') }, ...MAP_TYPE_TABS];

  return (
    <View style={{ gap: 14 }}>
      {/* Provider picker */}
      <MenuField label={t('acct.provider.label')} value={provider} onChange={setProvider} options={PROVIDER_OPTS} />

      {/* GST Profile summary */}
      {gstProf ? (
        <Card style={{ gap: 6 }}>
          <T size={12} weight="700" color={c.mute}>{t('acct.gst_profile_summary')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
            <T size={13} weight="700">{gstProf.legal_name}</T>
            <Tag label={gstProf.gstin} color={c.violetSoft} />
            <Tag label={`State ${gstProf.state_code}`} color={c.cyanSoft} />
          </View>
        </Card>
      ) : null}

      {/* Validation status strip */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <ValidationChip label={`${t('acct.mapping.type.ledger')}: ${hasLedger ? t('acct.mapping.valid.ok') : t('acct.mapping.valid.missing')}`} ok={hasLedger} />
        <ValidationChip label={`GST: ${missingTax.length === 0 ? t('acct.mapping.valid.ok') : `${missingTax.join(', ')} ${t('acct.mapping.valid.missing')}`}`} ok={missingTax.length === 0} />
        <ValidationChip label={`${t('acct.mapping.type.clearing')}: ${hasClearing ? t('acct.mapping.valid.ok') : t('acct.mapping.valid.missing')}`} ok={hasClearing} />
      </View>

      {/* Actions */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn small title={t('acct.mapping.add')} color={c.pink} ink="#fff" onPress={() => { setEditRow(null); setAdding(true); }} accessibilityLabel={t('acct.mapping.add')} />
        {tmpl.data?.template_rows?.length ? (
          <Btn small title={t('acct.mapping.load_template')} color={c.paper} ink={c.ink} onPress={loadTemplate} accessibilityLabel={t('acct.mapping.load_template')} />
        ) : null}
      </View>

      {/* Filter by type */}
      <MenuField label={t('acct.mapping.type.label')} value={mapType} onChange={setMapType} options={filterOpts} />

      {!data.data ? <Loading /> : !data.data.items?.length ? (
        <Empty title={t('acct.empty.mappings')} sub={t('acct.empty.mappings_hint')} />
      ) : (
        <>
          {/* Ledger section */}
          {(!mapType || mapType === 'ledger') ? (
            <Section title={t('acct.mapping.type.ledger')}>
              {data.data.items.filter((m) => m.mapping_type === 'ledger').map((m) => <MappingRow key={m.id} m={m} onEdit={(r) => { setEditRow(r); setAdding(true); }} />)}
            </Section>
          ) : null}
          {/* Tax section */}
          {(!mapType || mapType === 'tax') ? (
            <Section title={t('acct.mapping.type.tax')}>
              {data.data.items.filter((m) => m.mapping_type === 'tax').map((m) => <MappingRow key={m.id} m={m} onEdit={(r) => { setEditRow(r); setAdding(true); }} />)}
            </Section>
          ) : null}
          {/* Clearing section */}
          {(!mapType || mapType === 'clearing') ? (
            <Section title={t('acct.mapping.type.clearing')}>
              {data.data.items.filter((m) => m.mapping_type === 'clearing').map((m) => <MappingRow key={m.id} m={m} onEdit={(r) => { setEditRow(r); setAdding(true); }} />)}
            </Section>
          ) : null}
          {/* Cost Centre section */}
          {(!mapType || mapType === 'cost_centre') ? (
            <Section title={t('acct.mapping.type.cost_centre')}>
              {data.data.items.filter((m) => m.mapping_type === 'cost_centre').map((m) => <MappingRow key={m.id} m={m} onEdit={(r) => { setEditRow(r); setAdding(true); }} />)}
            </Section>
          ) : null}
        </>
      )}

      <AddMappingSheet
        visible={adding}
        onClose={() => { setAdding(false); setEditRow(null); }}
        onSaved={() => { setAdding(false); setEditRow(null); setReload((r) => r + 1); }}
        provider={provider}
        orgId={orgId}
        template={tmpl.data}
        editRow={editRow}
      />
    </View>
  );
}
