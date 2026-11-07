// PS-08: Para-sport UX acceptance suite — conformance matrix, defects, release gate.
// Platform-admin / org-manager only. Hidden from athletes and general users.
import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, Platform, AccessibilityInfo } from 'react-native';
import { useTranslation } from '../i18n';
import { useFetch, usePost } from '../api';
import { useTheme } from '../theme';
import {
  Screen, T, H1, Row, Chip, Tag, Section, Loading, Empty,
  Card, GradCard, StatPill, Seg, Btn, FormSheet, MenuField,
} from '../components';

const JOURNEYS = [
  'athlete_onboarding','sport_discovery','classification_status',
  'tournament_entry','booking','coach_booking','learning',
  'health','sponsorship','support_person',
];
const PLATFORMS = ['ios','ipados','android','web'];
const TECHS = ['voiceover','talkback','keyboard','switch_control','magnification'];
const STATUSES = ['untested','partial','conformant','deferred','not_applicable'];
const SEVERITIES = ['critical','major','minor'];
const DEFECT_STATUSES = ['open','in_progress','resolved','wont_fix'];

function statusColor(status, c) {
  switch (status) {
    case 'conformant':     return { bg: c.limeSoft,    ink: c.lime };
    case 'partial':        return { bg: c.sunSoft,     ink: c.sun };
    case 'untested':       return { bg: c.violetSoft,  ink: c.mute };
    case 'deferred':       return { bg: c.cyanSoft,    ink: c.cyan };
    case 'not_applicable': return { bg: c.line,        ink: c.mute };
    default:               return { bg: c.redSoft,     ink: c.red };
  }
}

function severityColor(sev, c) {
  if (sev === 'critical') return { bg: c.redSoft,  ink: c.red };
  if (sev === 'major')    return { bg: c.sunSoft,  ink: c.sun };
  return { bg: c.limeSoft, ink: c.lime };
}

// ── Status cell in the matrix heat-map ───────────────────────────────────────
function StatusCell({ status, label, onPress, c }) {
  const col = statusColor(status, c);
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={`Status: ${status}. Tap to update.`}
      style={{
        flex: 1, minWidth: 60, minHeight: 44,
        backgroundColor: col.bg, borderRadius: 8, margin: 2,
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <T style={{ fontSize: 10, fontWeight: '700', color: col.ink, textAlign: 'center' }} numberOfLines={2}>
        {label}
      </T>
    </TouchableOpacity>
  );
}

// ── Matrix tab ────────────────────────────────────────────────────────────────
function MatrixTab({ t, c, nav }) {
  const [techFilter, setTechFilter] = useState(null);
  const { data, loading, refetch } = useFetch('/para/conformance', { tech: techFilter });
  const { data: summary } = useFetch('/para/conformance/summary');
  const [sheet, setSheet] = useState(null); // { journey, platform, tech, entry }
  const [updating, setUpdating] = useState(false);
  const post = usePost();

  const entries = data?.entries ?? [];
  const entryMap = {};
  entries.forEach((e) => { entryMap[`${e.journey}|${e.platform}|${e.tech}`] = e; });

  const techOptions = TECHS.map((tech) => ({ label: t(`para_a11y.tech.${tech}`), value: tech }));
  const statusOptions = STATUSES.map((s) => ({ label: t(`para_a11y.status.${s}`), value: s }));

  async function saveEntry(values) {
    if (!sheet) return;
    setUpdating(true);
    await post(`/para/conformance/${sheet.journey}/${sheet.platform}/${sheet.tech}`, values, { method: 'PUT' });
    setUpdating(false);
    setSheet(null);
    refetch();
  }

  const shownTechs = techFilter ? [techFilter] : TECHS;

  if (loading) return <Loading />;

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      {/* Summary strip */}
      {summary && (
        <Row style={{ marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          {STATUSES.map((s) => {
            const col = statusColor(s, c);
            const n = summary.counts?.find((x) => x.status === s)?.n ?? 0;
            return (
              <StatPill
                key={s}
                label={t(`para_a11y.status.${s}`)}
                value={String(n)}
                color={col.ink}
                bg={col.bg}
                accessibilityLabel={`${t(`para_a11y.status.${s}`)}: ${n}`}
              />
            );
          })}
        </Row>
      )}

      {/* Tech filter */}
      <MenuField
        label={t('para_a11y.filter_tech')}
        value={techFilter}
        options={[{ label: t('para_a11y.all_techs'), value: null }, ...techOptions]}
        onChange={setTechFilter}
        accessibilityLabel={t('para_a11y.filter_tech')}
      />

      {/* Matrix: one card per journey */}
      {JOURNEYS.map((journey) => {
        const jLabel = t(`para_a11y.journey.${journey}`);
        const worstStatus = (() => {
          const statuses = PLATFORMS.flatMap((p) => shownTechs.map((tech) => {
            return entryMap[`${journey}|${p}|${tech}`]?.status ?? 'untested';
          }));
          const rank = { critical: 0, untested: 1, partial: 2, deferred: 3, not_applicable: 4, conformant: 5 };
          return statuses.sort((a, b) => (rank[a] ?? 0) - (rank[b] ?? 0))[0] ?? 'untested';
        })();
        const { bg: jBg, ink: jInk } = statusColor(worstStatus, c);
        return (
          <Card
            key={journey}
            style={{ marginBottom: 12 }}
            accessibilityLabel={`${jLabel} — ${t(`para_a11y.status.${worstStatus}`)}`}
          >
            <Row style={{ marginBottom: 8, alignItems: 'center' }}>
              <T style={{ flex: 1, fontWeight: '700', color: c.ink, fontSize: 14 }}>{jLabel}</T>
              <Tag label={t(`para_a11y.status.${worstStatus}`)} bg={jBg} color={jInk} />
            </Row>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                {/* Header row */}
                <Row style={{ marginBottom: 2 }}>
                  <View style={{ width: 70 }} />
                  {PLATFORMS.map((p) => (
                    <View key={p} style={{ flex: 1, minWidth: 60, alignItems: 'center' }}>
                      <T style={{ fontSize: 10, color: c.mute, fontWeight: '600' }}>{t(`para_a11y.platform.${p}`)}</T>
                    </View>
                  ))}
                </Row>
                {/* Tech rows */}
                {shownTechs.map((tech) => (
                  <Row key={tech} style={{ marginBottom: 2, alignItems: 'center' }}>
                    <View style={{ width: 70 }}>
                      <T style={{ fontSize: 10, color: c.mute }} numberOfLines={2}>{t(`para_a11y.tech.${tech}`)}</T>
                    </View>
                    {PLATFORMS.map((p) => {
                      const entry = entryMap[`${journey}|${p}|${tech}`];
                      const status = entry?.status ?? 'untested';
                      return (
                        <StatusCell
                          key={p}
                          status={status}
                          label={`${t(`para_a11y.platform.${p}`)} ${t(`para_a11y.status.${status}`)}`}
                          onPress={() => setSheet({ journey, platform: p, tech, entry })}
                          c={c}
                        />
                      );
                    })}
                  </Row>
                ))}
              </View>
            </ScrollView>
          </Card>
        );
      })}

      {/* Update sheet */}
      {sheet && (
        <FormSheet
          visible={!!sheet}
          onClose={() => setSheet(null)}
          title={`${t(`para_a11y.journey.${sheet.journey}`)} · ${t(`para_a11y.platform.${sheet.platform}`)} · ${t(`para_a11y.tech.${sheet.tech}`)}`}
          fields={[
            {
              key: 'status',
              label: t('para_a11y.status_label'),
              type: 'menu',
              options: statusOptions,
              defaultValue: sheet.entry?.status ?? 'untested',
              required: true,
            },
            {
              key: 'evidence_ref',
              label: t('para_a11y.evidence_url'),
              type: 'url',
              defaultValue: sheet.entry?.evidence_ref ?? '',
            },
            {
              key: 'notes',
              label: t('para_a11y.notes'),
              type: 'text',
              multiline: true,
              defaultValue: sheet.entry?.notes ?? '',
            },
          ]}
          onSubmit={saveEntry}
          submitting={updating}
          submitLabel={t('para_a11y.save')}
          accessibilityLabel={t('para_a11y.update_entry')}
        />
      )}
    </ScrollView>
  );
}

// ── Defects tab ───────────────────────────────────────────────────────────────
function DefectsTab({ t, c }) {
  const [sevFilter, setSevFilter]    = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  const { data, loading, refetch } = useFetch('/para/conformance/defects', { severity: sevFilter, status: statusFilter });
  const [addSheet, setAddSheet]   = useState(false);
  const [resolveSheet, setResolveSheet] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const post = usePost();

  const sevOptions    = SEVERITIES.map((s) => ({ label: t(`para_a11y.severity.${s}`), value: s }));
  const dstatOptions  = DEFECT_STATUSES.map((s) => ({ label: t(`para_a11y.defect_status.${s}`), value: s }));
  const journeyOpts   = JOURNEYS.map((j) => ({ label: t(`para_a11y.journey.${j}`), value: j }));
  const platformOpts  = PLATFORMS.map((p) => ({ label: t(`para_a11y.platform.${p}`), value: p }));

  async function createDefect(values) {
    setSubmitting(true);
    await post('/para/conformance/defects', values, { method: 'PUT' });
    setSubmitting(false);
    setAddSheet(false);
    refetch();
  }

  async function resolveDefect(values) {
    if (!resolveSheet) return;
    setSubmitting(true);
    await post(`/para/conformance/defects/${resolveSheet.id}/resolve`, values);
    setSubmitting(false);
    setResolveSheet(null);
    refetch();
  }

  if (loading) return <Loading />;

  const defects = data?.defects ?? [];

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Row style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <MenuField
          label={t('para_a11y.severity_label')}
          value={sevFilter}
          options={[{ label: t('para_a11y.all_severities'), value: null }, ...sevOptions]}
          onChange={setSevFilter}
          accessibilityLabel={t('para_a11y.filter_severity')}
          style={{ flex: 1, minWidth: 140 }}
        />
        <MenuField
          label={t('para_a11y.status_label')}
          value={statusFilter}
          options={[{ label: t('para_a11y.all_statuses'), value: null }, ...dstatOptions]}
          onChange={setStatusFilter}
          accessibilityLabel={t('para_a11y.filter_status')}
          style={{ flex: 1, minWidth: 140 }}
        />
      </Row>
      <Btn
        label={t('para_a11y.log_defect')}
        onPress={() => setAddSheet(true)}
        accessibilityLabel={t('para_a11y.log_defect')}
        accessibilityHint={t('para_a11y.log_defect_hint')}
        style={{ marginBottom: 16 }}
      />
      {defects.length === 0 && (
        <Empty
          title={t('para_a11y.no_defects')}
          message={t('para_a11y.no_defects_msg')}
        />
      )}
      {defects.map((d) => {
        const sevCol   = severityColor(d.severity, c);
        const statCol  = statusColor(d.status, c);
        const resolved = ['resolved','wont_fix'].includes(d.status);
        return (
          <Card
            key={d.id}
            style={{ marginBottom: 10 }}
            accessibilityLabel={`${d.title}. ${t(`para_a11y.severity.${d.severity}`)}. ${t(`para_a11y.defect_status.${d.status}`)}.`}
          >
            <Row style={{ marginBottom: 6, alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <Tag label={t(`para_a11y.severity.${d.severity}`)} bg={sevCol.bg} color={sevCol.ink} />
              <Tag label={t(`para_a11y.defect_status.${d.status}`)} bg={statCol.bg} color={statCol.ink} />
              {d.wcag_criterion && (
                <Tag label={d.wcag_criterion} bg={c.cyanSoft} color={c.cyan} />
              )}
            </Row>
            <T style={{ fontWeight: '700', color: c.ink, marginBottom: 4 }}>{d.title}</T>
            <T style={{ color: c.mute, fontSize: 13, marginBottom: 4 }}>
              {t(`para_a11y.journey.${d.journey}`)} · {t(`para_a11y.platform.${d.platform}`)}
              {d.screen ? ` · ${d.screen}` : ''}
            </T>
            <T style={{ color: c.ink, fontSize: 13, marginBottom: 8 }}>{d.description}</T>
            {!resolved && (
              <Btn
                label={t('para_a11y.resolve_defect')}
                onPress={() => setResolveSheet(d)}
                accessibilityLabel={`${t('para_a11y.resolve_defect')}: ${d.title}`}
                size="sm"
                variant="outline"
              />
            )}
            {resolved && d.resolution_note && (
              <T style={{ color: c.lime, fontSize: 12, fontStyle: 'italic' }}>{d.resolution_note}</T>
            )}
          </Card>
        );
      })}

      {/* Add defect sheet */}
      {addSheet && (
        <FormSheet
          visible={addSheet}
          onClose={() => setAddSheet(false)}
          title={t('para_a11y.log_defect')}
          fields={[
            { key: 'journey',  label: t('para_a11y.journey_label'),  type: 'menu', options: journeyOpts, required: true },
            { key: 'platform', label: t('para_a11y.platform_label'), type: 'menu', options: platformOpts, required: true },
            { key: 'screen',   label: t('para_a11y.screen_label'),   type: 'text' },
            { key: 'title',    label: t('para_a11y.defect_title'),   type: 'text', required: true },
            { key: 'severity', label: t('para_a11y.severity_label'), type: 'menu', options: sevOptions, required: true },
            { key: 'description', label: t('para_a11y.description'), type: 'text', multiline: true, required: true },
            { key: 'steps_to_reproduce', label: t('para_a11y.steps_to_reproduce'), type: 'text', multiline: true },
            { key: 'evidence_ref',   label: t('para_a11y.evidence_url'),   type: 'url' },
            { key: 'wcag_criterion', label: t('para_a11y.wcag_criterion'), type: 'text' },
          ]}
          onSubmit={createDefect}
          submitting={submitting}
          submitLabel={t('para_a11y.log_defect')}
        />
      )}

      {/* Resolve sheet */}
      {resolveSheet && (
        <FormSheet
          visible={!!resolveSheet}
          onClose={() => setResolveSheet(null)}
          title={t('para_a11y.resolve_defect')}
          fields={[
            { key: 'status', label: t('para_a11y.resolution_status'), type: 'menu',
              options: [{ label: t('para_a11y.defect_status.resolved'), value: 'resolved' },
                        { label: t('para_a11y.defect_status.wont_fix'), value: 'wont_fix' }],
              required: true },
            { key: 'resolution_note', label: t('para_a11y.resolution_note'), type: 'text', multiline: true, required: true },
          ]}
          onSubmit={resolveDefect}
          submitting={submitting}
          submitLabel={t('para_a11y.resolve_defect')}
        />
      )}
    </ScrollView>
  );
}

// ── Release gate tab ──────────────────────────────────────────────────────────
function ReleaseGateTab({ t, c, nav }) {
  const { data, loading, refetch } = useFetch('/para/conformance/release-gate');

  if (loading) return <Loading />;

  const gate = data ?? {};
  const passes = gate.passes;
  const gateCol = passes
    ? { bg: c.limeSoft, ink: c.lime, label: t('para_a11y.gate_pass') }
    : { bg: c.redSoft,  ink: c.red,  label: t('para_a11y.gate_fail', { count: gate.blocker_count ?? 0 }) };

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <GradCard
        colors={passes ? [c.lime, c.limeSoft] : [c.red, c.redSoft]}
        style={{ marginBottom: 20, borderRadius: 18 }}
        accessibilityRole="status"
        accessibilityLabel={gateCol.label}
        accessibilityLiveRegion="polite"
      >
        <T style={{ fontSize: 20, fontWeight: '800', color: passes ? c.lime : c.red, marginBottom: 4 }}>
          {passes ? '✓' : '✗'} {gateCol.label}
        </T>
        <T style={{ color: c.mute, fontSize: 13 }}>
          {t('para_a11y.gate_evaluated', { date: gate.evaluated_at ? new Date(gate.evaluated_at).toLocaleDateString() : '—' })}
        </T>
      </GradCard>

      {/* Stats */}
      <Row style={{ marginBottom: 20, gap: 10, flexWrap: 'wrap' }}>
        <StatPill
          label={t('para_a11y.critical_defects')}
          value={String(gate.critical_defect_count ?? 0)}
          color={gate.critical_defect_count ? c.red : c.lime}
          bg={gate.critical_defect_count ? c.redSoft : c.limeSoft}
          accessibilityLabel={`${t('para_a11y.critical_defects')}: ${gate.critical_defect_count ?? 0}`}
        />
        <StatPill
          label={t('para_a11y.untested_critical')}
          value={String(gate.untested_critical_count ?? 0)}
          color={gate.untested_critical_count ? c.sun : c.lime}
          bg={gate.untested_critical_count ? c.sunSoft : c.limeSoft}
          accessibilityLabel={`${t('para_a11y.untested_critical')}: ${gate.untested_critical_count ?? 0}`}
        />
      </Row>

      {/* Blockers */}
      {!passes && gate.blockers && gate.blockers.length > 0 && (
        <Section title={t('para_a11y.blockers')} accessibilityLabel={t('para_a11y.blockers')}>
          {gate.blockers.map((b, idx) => {
            if (b.type === 'critical_defect') {
              return (
                <Card
                  key={b.id ?? idx}
                  style={{ marginBottom: 8, borderLeftWidth: 3, borderLeftColor: c.red }}
                  accessibilityLabel={`${t('para_a11y.critical_defect_blocker')}: ${b.title}`}
                >
                  <Row style={{ marginBottom: 4, gap: 6 }}>
                    <Tag label="CRITICAL DEFECT" bg={c.redSoft} color={c.red} />
                    <Tag label={b.status} bg={c.sunSoft} color={c.sun} />
                  </Row>
                  <T style={{ fontWeight: '700', color: c.ink }}>{b.title}</T>
                  <T style={{ color: c.mute, fontSize: 12 }}>
                    {t(`para_a11y.journey.${b.journey}`)} · {t(`para_a11y.platform.${b.platform}`)}
                  </T>
                </Card>
              );
            }
            return (
              <Card
                key={`${b.journey}|${b.platform}`}
                style={{ marginBottom: 8, borderLeftWidth: 3, borderLeftColor: c.sun }}
                accessibilityLabel={`${t('para_a11y.untested_blocker')}: ${t(`para_a11y.journey.${b.journey}`)} on ${t(`para_a11y.platform.${b.platform}`)}`}
              >
                <Tag label="UNTESTED CRITICAL JOURNEY" bg={c.sunSoft} color={c.sun} style={{ marginBottom: 4 }} />
                <T style={{ fontWeight: '700', color: c.ink }}>
                  {t(`para_a11y.journey.${b.journey}`)} · {t(`para_a11y.platform.${b.platform}`)}
                </T>
              </Card>
            );
          })}
        </Section>
      )}

      {passes && (
        <Card style={{ alignItems: 'center', paddingVertical: 24 }} accessibilityLabel={t('para_a11y.gate_all_clear')}>
          <T style={{ fontSize: 32, marginBottom: 8 }}>🏅</T>
          <T style={{ fontWeight: '800', color: c.lime, fontSize: 16 }}>{t('para_a11y.gate_all_clear')}</T>
          <T style={{ color: c.mute, textAlign: 'center', marginTop: 4 }}>{t('para_a11y.gate_all_clear_msg')}</T>
        </Card>
      )}

      <Btn
        label={t('para_a11y.refresh_gate')}
        onPress={refetch}
        accessibilityLabel={t('para_a11y.refresh_gate')}
        variant="outline"
        style={{ marginTop: 16 }}
      />
    </ScrollView>
  );
}

// ── Root screen ───────────────────────────────────────────────────────────────
export default function ParaUxConformance({ navigation }) {
  const { t } = useTranslation();
  const c = useTheme();
  const [tab, setTab] = useState(0);

  const tabs = [
    t('para_a11y.matrix'),
    t('para_a11y.defects'),
    t('para_a11y.release_gate'),
  ];

  return (
    <Screen
      title={t('para_a11y.title')}
      accessibilityLabel={t('para_a11y.title')}
    >
      <Seg
        values={tabs}
        selected={tab}
        onChange={setTab}
        accessibilityLabel={t('para_a11y.tabs_label')}
      />
      {tab === 0 && <MatrixTab    t={t} c={c} nav={navigation} />}
      {tab === 1 && <DefectsTab   t={t} c={c} />}
      {tab === 2 && <ReleaseGateTab t={t} c={c} nav={navigation} />}
    </Screen>
  );
}
