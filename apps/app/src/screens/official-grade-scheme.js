// Official Grade Scheme detail + upgrade application flow (#1030 R32).
// Shown when tapping a grade card from OfficialIntlSettings → Grades tab.
// Params: { gradeId, schemeId } — either may be omitted to show scheme-only.
// Phone / tablet / desktop responsive. RTL-aware. Dusk theme.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, I18nManager, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import {
  Btn, Card, Chip, Empty, ErrorBox, GradCard, H1, H2, Loading,
  Row, Screen, Section, StatPill, T, Tag, Wrap,
} from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c, grad } from '../theme';
import { t } from '../i18n';

const RTL = I18nManager.isRTL;
const row = (gap = 8) => ({ flexDirection: RTL ? 'row-reverse' : 'row', gap, alignItems: 'center' });
const col = (gap = 10) => ({ flexDirection: 'column', gap });
const pad = (n = 16) => ({ padding: n });

// ── Chip helpers ──────────────────────────────────────────────────────────

function VerChip(vs) {
  const map = {
    verified:      [c.limeSoft, c.lime,   t('ointl.grade.verified')],
    self_declared: [c.cyanSoft, c.cyan,   t('ointl.grade.self_declared')],
    pending:       [c.sunSoft,  c.sun,    t('ointl.grade.pending')],
    rejected:      [c.redSoft,  c.red,    t('ointl.grade.rejected')],
    revoked:       [c.redSoft,  c.red,    t('ointl.grade.revoked')],
  };
  const [bg, ink, lbl] = map[vs] ?? [c.violetSoft, c.mute, vs];
  return <Tag label={lbl} color={bg} textColor={ink} />;
}

function AppStatusChip(s) {
  const map = {
    submitted:          [c.sunSoft,  c.sun,  t('ointl.app_status.submitted')],
    assessor_requested: [c.cyanSoft, c.cyan, t('ointl.app_status.assessor_requested')],
    assessor_endorsed:  [c.limeSoft, c.lime, t('ointl.app_status.assessor_endorsed')],
    evidence_needed:    [c.sunSoft,  c.sun,  t('ointl.app_status.evidence_needed')],
    in_review:          [c.pinkSoft, c.pink, t('ointl.app_status.in_review')],
    approved:           [c.limeSoft, c.lime, t('ointl.app_status.approved')],
    rejected:           [c.redSoft,  c.red,  t('ointl.app_status.rejected')],
    withdrawn:          [c.violetSoft, c.mute, t('ointl.app_status.withdrawn')],
  };
  const [bg, ink, lbl] = map[s] ?? [c.violetSoft, c.mute, s];
  return <Tag label={lbl} color={bg} textColor={ink} />;
}

// ── Main export ───────────────────────────────────────────────────────────

export function OfficialGradeScheme({ route, navigation }) {
  const { gradeId, schemeId } = route?.params ?? {};
  const { toast, userId } = useSession();
  const L = useLayout();
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyTarget, setApplyTarget] = useState(null);
  const [applyNote, setApplyNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Load scheme (public)
  const scheme = useLoad(
    () => schemeId ? api.get(`/official-grade-schemes/${schemeId}`) : Promise.resolve(null),
    [schemeId],
  );

  // Load official's grade + history for this scheme
  const myGrade = useLoad(
    () => gradeId ? api.get('/me/official-grades') : Promise.resolve(null),
    [gradeId],
  );
  const history = useLoad(
    () => schemeId ? api.get(`/me/official-grades/${schemeId}/history`) : Promise.resolve(null),
    [schemeId],
  );
  // Load open applications
  const openApps = useLoad(
    () => api.get('/me/official-grades/applications', { scheme_id: schemeId, limit: 10 }),
    [schemeId],
  );

  const currentGrade = myGrade.data?.grades?.find((g) => g.scheme_id === schemeId || g.grade_id === gradeId);
  const levels = scheme.data?.levels ?? [];
  const hasOpenApp = (openApps.data?.applications ?? []).some(
    (a) => !['approved', 'rejected', 'withdrawn'].includes(a.status),
  );

  // Eligible target levels: higher rank_order than current
  const eligibleTargets = levels.filter((l) =>
    currentGrade ? l.rank_order < currentGrade.rank_order : true,
  ).map((l) => ({ value: l.id, label: l.display_name }));

  const submitUpgrade = useCallback(async () => {
    if (!applyTarget) return toast(t('ograde.app.no_target'));
    setSubmitting(true);
    try {
      await api.post(`/me/official-grades/${schemeId}/upgrade`, {
        target_level_id: applyTarget,
        notes: applyNote || undefined,
      });
      toast(t('ograde.app.submitted'));
      setApplyOpen(false);
      openApps.reload();
    } catch (e) {
      toast(e.message);
    } finally {
      setSubmitting(false);
    }
  }, [applyTarget, applyNote, schemeId, openApps, toast]);

  if (scheme.error) return <Screen><Section><ErrorBox error={scheme.error} onRetry={scheme.reload} /></Section></Screen>;
  if (!scheme.data && schemeId) return <Screen><Section><Loading /></Section></Screen>;

  const sc = scheme.data?.scheme;

  return (
    <Screen>
      {/* Header */}
      <GradCard style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
        <T size={11} style={{ color: 'rgba(255,255,255,.65)', marginBottom: 2 }}>
          {sc?.governing_body ?? t('ograde.scheme.governing_body')}
          {sc?.country_scope ? ` · ${sc.country_scope}` : ''}
        </T>
        <H1 style={{ color: '#fff', marginTop: 0 }}>{sc?.display_name ?? t('ograde.scheme.title')}</H1>
        <View style={[row(8), { marginTop: 6, flexWrap: 'wrap' }]}>
          {sc?.scheme_version && <Chip label={`v${sc.scheme_version}`} color="rgba(255,255,255,.18)" textColor="#fff" />}
          {sc?.status && <Chip label={sc.status} color="rgba(255,255,255,.18)" textColor="#fff" />}
          {sc?.effective_from && <Chip label={`from ${sc.effective_from}`} color="rgba(255,255,255,.12)" textColor="rgba(255,255,255,.8)" />}
        </View>
      </GradCard>

      <ScrollView contentContainerStyle={[col(12), pad(16)]}>
        {/* Current grade strip */}
        {currentGrade && (
          <Card style={{ borderLeftWidth: 3, borderLeftColor: c.mint }}>
            <T size={11} weight="600" color={c.mute} style={{ marginBottom: 4 }}>{t('ograde.my_grade')}</T>
            <View style={[row(10)]}>
              <View style={{ flex: 1 }}>
                <T weight="800" size={20} color={c.ink}>{currentGrade.level_name}</T>
                <T size={12} color={c.mute}>
                  {currentGrade.assigned_by_name
                    ? t('ointl.grade.assigned_by', { name: currentGrade.assigned_by_name })
                    : t('ointl.grade.self_declared_note')}
                </T>
              </View>
              {VerChip(currentGrade.verification_status)}
            </View>
            {/* Progress bar along the ladder */}
            {levels.length > 1 && (
              <View style={{ marginTop: 10 }}>
                <View style={[row(0), { justifyContent: 'space-between', marginBottom: 4 }]}>
                  <T size={10} color={c.mute}>{levels[levels.length - 1]?.display_name}</T>
                  <T size={10} color={c.mute}>{levels[0]?.display_name}</T>
                </View>
                <LadderBar levels={levels} currentRank={currentGrade.rank_order} />
              </View>
            )}
            {/* Upgrade CTA */}
            {eligibleTargets.length > 0 && !hasOpenApp && (
              <Btn
                label={t('ograde.apply_upgrade')}
                style={{ marginTop: 10 }}
                onPress={() => setApplyOpen(true)}
              />
            )}
            {hasOpenApp && (
              <View style={[row(6), { marginTop: 10 }]}>
                <T size={22}>⏳</T>
                <T size={12} color={c.sun}>{t('ograde.app.already_open')}</T>
              </View>
            )}
          </Card>
        )}

        {/* KPI strip for scheme */}
        {sc && (
          <View style={[row(8), { flexWrap: 'wrap' }]}>
            <StatPill value={String(levels.length)} label={t('ograde.scheme.levels')} color={c.pinkSoft} />
            <StatPill value={String(sc.official_count ?? 0)} label={t('ograde.scheme.officials')} color={c.cyanSoft} />
            <StatPill value={String(sc.appeal_window_days ?? 30)} label={t('ograde.scheme.appeal_days')} color={c.sunSoft} />
          </View>
        )}

        {/* Grade ladder */}
        <Card>
          <H2 style={{ marginBottom: 10 }}>{t('ograde.scheme.ladder')}</H2>
          {levels.length === 0 ? (
            <T size={13} color={c.mute}>{t('ograde.scheme.no_levels')}</T>
          ) : (
            levels.map((lv, i) => {
              const isCurrent = currentGrade && lv.rank_order === currentGrade.rank_order;
              return (
                <View
                  key={lv.id}
                  style={[
                    row(10),
                    {
                      paddingVertical: 10,
                      borderBottomWidth: i < levels.length - 1 ? 1 : 0,
                      borderBottomColor: c.line,
                      backgroundColor: isCurrent ? c.pinkSoft : 'transparent',
                      borderRadius: isCurrent ? 8 : 0,
                      paddingHorizontal: isCurrent ? 8 : 0,
                    },
                  ]}
                >
                  {/* Rank badge */}
                  <View style={{
                    width: 32, height: 32, borderRadius: 16,
                    backgroundColor: isCurrent ? c.pink : c.line,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <T size={12} weight="700" color={isCurrent ? '#fff' : c.mute}>{lv.level_code}</T>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={[row(6)]}>
                      <T weight={isCurrent ? '700' : '500'} size={14} color={c.ink}>{lv.display_name}</T>
                      {isCurrent && <Chip label={t('ograde.current')} color={c.pink} textColor="#fff" />}
                    </View>
                    {lv.description && <T size={11} color={c.mute}>{lv.description}</T>}
                    {/* Requirements chips */}
                    <View style={[row(4), { marginTop: 4, flexWrap: 'wrap' }]}>
                      {lv.min_matches_required && (
                        <Chip label={t('ograde.level.min_matches', { n: lv.min_matches_required })} color={c.cyanSoft} />
                      )}
                      {lv.requires_assessor_endorsement && (
                        <Chip label={t('ograde.level.assessor_required')} color={c.sunSoft} />
                      )}
                      {lv.requires_fitness_cert && (
                        <Chip label={t('ograde.level.fitness_required')} color={c.limeSoft} />
                      )}
                      {lv.requires_federation_approval && (
                        <Chip label={t('ograde.level.fed_required')} color={c.pinkSoft} />
                      )}
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </Card>

        {/* Open upgrade applications */}
        {(openApps.data?.applications ?? []).length > 0 && (
          <Card>
            <H2 style={{ marginBottom: 8 }}>{t('ograde.my_applications')}</H2>
            {openApps.data.applications.map((a) => (
              <View key={a.id} style={[row(10), { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }]}>
                <View style={{ flex: 1 }}>
                  <T weight="600" size={13} color={c.ink}>
                    {a.current_level_name} → {a.target_level_name}
                  </T>
                  <T size={11} color={c.mute}>
                    {t('ograde.app.submitted_at', { date: new Date(a.submitted_at).toLocaleDateString() })}
                    {a.appeal_deadline ? ` · ${t('ograde.app.appeal_deadline', { date: a.appeal_deadline })}` : ''}
                  </T>
                </View>
                {AppStatusChip(a.status)}
              </View>
            ))}
          </Card>
        )}

        {/* Grade history */}
        {(history.data?.history ?? []).length > 0 && (
          <Card>
            <H2 style={{ marginBottom: 8 }}>{t('ograde.grade_history')}</H2>
            {history.data.history.map((h) => (
              <View key={h.id} style={[row(10), { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }]}>
                <View style={{
                  width: 8, height: 8, borderRadius: 4,
                  backgroundColor: h.status === 'active' ? c.mint : c.line,
                  marginTop: 2,
                }} />
                <View style={{ flex: 1 }}>
                  <T size={13} weight="600" color={h.status === 'active' ? c.ink : c.mute}>
                    {h.level_name}
                  </T>
                  <T size={11} color={c.mute}>
                    {h.effective_from ? new Date(h.effective_from).toLocaleDateString() : ''}
                    {h.effective_until ? ` → ${new Date(h.effective_until).toLocaleDateString()}` : ''}
                    {h.assigned_by_name ? ` · ${h.assigned_by_name}` : ''}
                  </T>
                </View>
                {VerChip(h.verification_status)}
              </View>
            ))}
          </Card>
        )}

        {/* Scheme description */}
        {sc?.description && (
          <Card>
            <H2 style={{ marginBottom: 6 }}>{t('ograde.scheme.about')}</H2>
            <T size={13} color={c.text} style={{ lineHeight: 20 }}>{sc.description}</T>
          </Card>
        )}
      </ScrollView>

      {/* Upgrade application sheet */}
      {applyOpen && (
        <FormSheet visible title={t('ograde.apply_upgrade')} onClose={() => setApplyOpen(false)}>
          <View style={col(14)}>
            <Card style={{ backgroundColor: c.cyanSoft, borderWidth: 0, padding: 12 }}>
              <T size={12} color={c.cyan} style={{ lineHeight: 17 }}>
                {t('ograde.app.info', { days: sc?.appeal_window_days ?? 30 })}
              </T>
            </Card>
            <MenuField
              label={t('ograde.app.target_level')}
              value={applyTarget}
              options={eligibleTargets}
              onChange={setApplyTarget}
            />
            <View style={row(10)}>
              <Btn style={{ flex: 1 }} label={t('common.cancel')} ghost onPress={() => setApplyOpen(false)} />
              <Btn
                style={{ flex: 1 }}
                label={submitting ? t('common.submitting') : t('ograde.app.submit')}
                onPress={submitUpgrade}
                disabled={submitting}
              />
            </View>
          </View>
        </FormSheet>
      )}
    </Screen>
  );
}

// ── Ladder progress bar ────────────────────────────────────────────────────

function LadderBar({ levels, currentRank }) {
  const sorted = [...levels].sort((a, b) => b.rank_order - a.rank_order); // highest first
  const idx = sorted.findIndex((l) => l.rank_order === currentRank);
  const pct = sorted.length > 1 ? Math.round(((sorted.length - 1 - idx) / (sorted.length - 1)) * 100) : 100;
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden' }}>
      <View style={{ width: `${pct}%`, height: 6, borderRadius: 3, backgroundColor: c.pink }} />
    </View>
  );
}
