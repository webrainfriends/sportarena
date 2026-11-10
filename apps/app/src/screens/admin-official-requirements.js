// REF-R10: Platform admin screen for official crew requirements configuration.
// Configures per-sport governing-body requirements, degradation factors, and alert routing.
// Only visible to platform admin (enforced server-side; screen also checks roles).
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, T, Tag } from '../ui';
import { useLayout } from '../layout';
import { FormSheet } from '../FormSheet';
import { explain } from '../access';
import { c, grad } from '../theme';
import { t } from '../i18n';

const GB_OPTIONS = [
  { value: 'FIFA', label: 'FIFA' },
  { value: 'ICC', label: 'ICC' },
  { value: 'Olympics', label: 'Olympics / IOC' },
  { value: 'Para', label: 'Para / IPC' },
  { value: 'World Athletics', label: 'World Athletics' },
  { value: 'Aquatic', label: 'World Aquatics' },
  { value: 'Winter Olympics', label: 'Winter Olympics' },
  { value: 'FIBA', label: 'FIBA' },
  { value: 'BWF', label: 'BWF' },
  { value: 'generic', label: 'Generic' },
];

const LEVEL_OPTIONS = [
  { value: 'standard', label: 'Standard' },
  { value: 'competitive', label: 'Competitive' },
  { value: 'elite', label: 'Elite' },
  { value: 'international', label: 'International' },
];

function CatalogRow({ row, onEdit }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ flex: 1 }}>
        <T style={{ fontWeight: '700', fontSize: 13 }}>{row.sport} · {row.crew_role?.replace(/_/g, ' ')}</T>
        <T style={{ fontSize: 12, color: c.mute }}>{row.governing_body} · {row.competition_level ?? 'standard'}</T>
      </View>
      <T style={{ fontSize: 13, color: c.pink, fontWeight: '800' }}>×{row.min_required}</T>
      {row.min_grade ? <Tag label={row.min_grade} color={c.violetSoft} /> : null}
      <Btn small title="Edit" color={c.line} ink={c.ink} onPress={() => onEdit(row)} style={{ minHeight: 36, paddingHorizontal: 10 }} />
    </View>
  );
}

function PenaltyRow({ row, onEdit }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ flex: 1 }}>
        <T style={{ fontWeight: '700', fontSize: 13 }}>{row.sport ?? 'All sports'}</T>
        <T style={{ fontSize: 12, color: c.mute }}>Degradation: {row.degradation_factor ?? 0.75}×</T>
      </View>
      <Tag label={`${((row.degradation_factor ?? 0.75) * 100).toFixed(0)}% pts`} color={c.sunSoft} />
      <Btn small title="Edit" color={c.line} ink={c.ink} onPress={() => onEdit(row)} style={{ minHeight: 36, paddingHorizontal: 10 }} />
    </View>
  );
}

export function AdminOfficialRequirements() {
  const { toast } = useSession();
  const L = useLayout();
  const catalogQ = useLoad(() => api.get('/crew-ai/catalog/seed', {}).catch(() => ({ catalog: [] })), []);
  const penaltiesQ = useLoad(() => api.get('/crew-ai/penalty-config').catch(() => ({ configs: [] })), []);
  const [addOpen, setAddOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [penaltyOpen, setPenaltyOpen] = useState(false);
  const [editPenalty, setEditPenalty] = useState(null);
  const [busy, setBusy] = useState(false);
  const sports = useLoad(() => api.get('/sports').catch(() => []), []);

  const catalog = catalogQ.data?.catalog ?? [];
  const penalties = penaltiesQ.data?.configs ?? [];
  const sportOptions = (sports.data ?? []).map((s) => ({ value: s.slug, label: `${s.emoji ?? ''} ${s.name}` }));

  const submitCatalog = async (v) => {
    setBusy(true);
    try {
      await api.post('/crew-ai/catalog/seed', {
        rows: [{ sport: v.sport, crew_role: v.crew_role, min_required: Number(v.min_required), recommended: Number(v.recommended ?? v.min_required), governing_body: v.governing_body, competition_level: v.level ?? 'standard', min_grade: v.min_grade || undefined, notes: v.notes || undefined }],
      });
      toast('Requirement saved');
      setAddOpen(false);
      setEditRow(null);
      catalogQ.reload();
    } catch (e) { toast(explain(e)); throw e; } finally { setBusy(false); }
  };

  const submitPenalty = async (v) => {
    setBusy(true);
    try {
      await api.post('/crew-ai/penalty-config', {
        sport: v.sport || undefined,
        degradation_factor: parseFloat(v.degradation_factor),
        alert_officials: v.alert_officials === true || v.alert_officials === 'true',
        alert_organiser: v.alert_organiser === true || v.alert_organiser === 'true',
      });
      toast('Penalty config saved');
      setPenaltyOpen(false);
      setEditPenalty(null);
      penaltiesQ.reload();
    } catch (e) { toast(explain(e)); throw e; } finally { setBusy(false); }
  };

  const catalogFields = [
    { key: 'sport', label: 'Sport', type: 'chips', options: sportOptions },
    { key: 'crew_role', label: 'Role', type: 'text' },
    { key: 'min_required', label: 'Min required', type: 'stepper', min: 0, max: 20, default: 1 },
    { key: 'recommended', label: 'Recommended', type: 'stepper', min: 0, max: 20, default: 1 },
    { key: 'governing_body', label: 'Governing body', type: 'chips', options: GB_OPTIONS },
    { key: 'level', label: 'Competition level', type: 'chips', options: LEVEL_OPTIONS },
    { key: 'min_grade', label: 'Minimum grade (optional)', type: 'text', optional: true },
    { key: 'notes', label: 'Notes (optional)', type: 'multiline', optional: true },
  ];

  const penaltyFields = [
    { key: 'sport', label: 'Sport (blank = all sports)', type: 'chips', optional: true, options: [{ value: '', label: 'All sports' }, ...sportOptions] },
    { key: 'degradation_factor', label: 'Degradation factor (0.5 – 1.0)', type: 'text', placeholder: '0.75' },
    { key: 'alert_officials', label: 'Alert assigned officials', type: 'choice', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
    { key: 'alert_organiser', label: 'Alert event organiser', type: 'choice', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
  ];

  if (catalogQ.loading && !catalogQ.data) return <Screen><Loading /></Screen>;

  const catalogSection = (
    <Section title="Crew requirements catalog" color={c.violet} action="+ Add rule" onAction={() => { setEditRow(null); setAddOpen(true); }}>
      <Card style={{ padding: 14 }}>
        {catalog.length === 0
          ? <Empty label="No requirements configured. Add rules or seed defaults." />
          : catalog.map((row, i) => <CatalogRow key={i} row={row} onEdit={(r) => { setEditRow(r); setAddOpen(true); }} />)}
      </Card>
    </Section>
  );

  const penaltySection = (
    <Section title="Degradation factor config" color={c.sun} action="+ Add config" onAction={() => { setEditPenalty(null); setPenaltyOpen(true); }}>
      <Card style={{ padding: 2 }}>
        <View style={{ padding: 12, backgroundColor: c.sunSoft, borderRadius: 10, marginBottom: 8 }}>
          <T style={{ fontSize: 13, color: c.sun }}>
            When a match proceeds with insufficient officials, results are recorded with a degradation multiplier.
            League tables show a ⚠️ indicator. The factor applies to points, not scores.
          </T>
        </View>
        {penalties.length === 0
          ? <Empty label="Default 0.75× applies to all sports." />
          : penalties.map((row, i) => <PenaltyRow key={i} row={row} onEdit={(r) => { setEditPenalty(r); setPenaltyOpen(true); }} />)}
      </Card>
    </Section>
  );

  return (
    <Screen>
      <GradCard colors={grad.sunset}>
        <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6, textTransform: 'uppercase' }}>Platform admin</T>
        <H1 style={{ color: '#fff', marginTop: 4 }}>Official Requirements</H1>
        <T size={13} style={{ color: 'rgba(255,255,255,.75)', marginTop: 4 }}>
          Configure governing-body requirements and degradation rules for all sports.
        </T>
      </GradCard>

      {L.tablet ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start', marginTop: 8 }}>
          <View style={{ flex: 1.5 }}>{catalogSection}</View>
          <View style={{ flex: 1 }}>{penaltySection}</View>
        </View>
      ) : (
        <View style={{ marginTop: 8 }}>
          {catalogSection}
          {penaltySection}
        </View>
      )}

      <FormSheet
        visible={addOpen}
        onClose={() => { setAddOpen(false); setEditRow(null); }}
        title={editRow ? 'Edit requirement' : 'Add requirement'}
        submitLabel="Save"
        onSubmit={submitCatalog}
        fields={catalogFields}
        initial={editRow ? { sport: editRow.sport, crew_role: editRow.crew_role, min_required: editRow.min_required, recommended: editRow.recommended ?? editRow.min_required, governing_body: editRow.governing_body, level: editRow.competition_level ?? 'standard', min_grade: editRow.min_grade ?? '', notes: editRow.notes ?? '' } : { min_required: 1, recommended: 1, level: 'standard' }}
      />
      <FormSheet
        visible={penaltyOpen}
        onClose={() => { setPenaltyOpen(false); setEditPenalty(null); }}
        title={editPenalty ? 'Edit degradation config' : 'Add degradation config'}
        submitLabel="Save"
        onSubmit={submitPenalty}
        fields={penaltyFields}
        initial={editPenalty ? { sport: editPenalty.sport ?? '', degradation_factor: String(editPenalty.degradation_factor ?? '0.75'), alert_officials: String(editPenalty.alert_officials ?? 'true'), alert_organiser: String(editPenalty.alert_organiser ?? 'true') } : { degradation_factor: '0.75', alert_officials: 'true', alert_organiser: 'true' }}
      />
    </Screen>
  );
}
