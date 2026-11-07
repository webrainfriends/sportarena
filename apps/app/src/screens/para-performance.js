/**
 * PS-28 — Governed adaptive athlete performance insights & coach review for para-sport.
 * Exports: ParaPerformanceDashboard, CoachParaInsightReview, AcademyParaProgressView
 * Shared: ParaInsightCard, ParaMetricCatalogSheet, InsightSourceDrawer, InsightChallengeSheet, ParaInsightStatusChip
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c, day } from '../theme';
import { t } from '../i18n';

// ─── Shared helpers ────────────────────────────────────────────────────────

const ANNOTATION_TAGS = ['accurate', 'needs_context', 'clinical_concern', 'outstanding_progress', 'revise'];
const BIAS_RESOLUTION = ['addressed', 'updated_insight', 'referred_to_clinician'];

const INSIGHT_TYPE_COLOR = {
  trend: c.cyanSoft,
  plateau: c.sunSoft,
  milestone: c.limeSoft,
  regression: c.orangeSoft,
  training_recommendation: c.pinkSoft,
};
const INSIGHT_TYPE_INK = {
  trend: c.cyan,
  plateau: c.sun,
  milestone: c.lime,
  regression: c.orange,
  training_recommendation: c.pink,
};
const CONF_COLOR = { high: c.limeSoft, medium: c.sunSoft, low: c.orangeSoft };
const CONF_INK   = { high: c.lime,     medium: c.sun,     low: c.orange };
const STATUS_COLOR = { draft: c.violetSoft, under_review: c.cyanSoft, approved: c.limeSoft, rejected: c.orangeSoft, published: c.limeSoft };
const STATUS_INK   = { draft: c.violet,     under_review: c.cyan,     approved: c.lime,     rejected: c.orange,     published: c.lime };

const expires = (date) => {
  if (!date) return null;
  const days = Math.ceil((new Date(date) - Date.now()) / 86400000);
  if (days < 14)  return { color: c.red,  text: t('para_perf.expires_critical', { days }) };
  if (days < 60)  return { color: c.sun,  text: t('para_perf.expires_soon',     { days }) };
  return { color: c.lime, text: t('para_perf.class_expires_soon', { date: day(date) }) };
};

function Row({ children, style }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', ...style }}>{children}</View>;
}
function Gap({ h = 12 }) { return <View style={{ height: h }} />; }
function Spacer({ w = 8 }) { return <View style={{ width: w }} />; }

// ─── ParaInsightStatusChip ─────────────────────────────────────────────────

export function ParaInsightStatusChip({ status }) {
  return (
    <View style={{ backgroundColor: STATUS_COLOR[status] || c.violetSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <T size={11} weight='med' color={STATUS_INK[status] || c.violet}>{t(`para_perf.status_${status}`)}</T>
    </View>
  );
}

// ─── ParaInsightCard ────────────────────────────────────────────────────────

export function ParaInsightCard({ insight, onChallenge, showCoachDecision = false }) {
  const [srcOpen, setSrcOpen] = useState(false);
  const bg = INSIGHT_TYPE_COLOR[insight.insight_type] || c.pinkSoft;
  const ink = INSIGHT_TYPE_INK[insight.insight_type] || c.pink;
  const conf = insight.ai_draft?.confidence;
  const sources = insight.sources || [];
  return (
    <Card style={{ gap: 10, backgroundColor: c.paper }}>
      <Row style={{ gap: 8 }}>
        <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
          <T size={11} weight='med' color={ink}>{t(`para_perf.type_${insight.insight_type}`)}</T>
        </View>
        {conf && (
          <View style={{ backgroundColor: CONF_COLOR[conf] || c.sunSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
            <T size={11} weight='med' color={CONF_INK[conf] || c.sun}>{t(`para_perf.confidence_${conf}`)}</T>
          </View>
        )}
        {showCoachDecision && insight.coach_decision && (
          <ParaInsightStatusChip status={insight.coach_decision} />
        )}
      </Row>
      <T size={15} weight='med' color={c.ink} style={{ lineHeight: 22 }}>{insight.ai_draft?.summary}</T>
      {insight.ai_draft?.limitations && (
        <T size={13} color={c.mute} style={{ lineHeight: 19 }}>{insight.ai_draft.limitations}</T>
      )}
      {insight.review_due_at && (
        <T size={12} color={c.sun}>{t('para_perf.review_due', { date: day(insight.review_due_at) })}</T>
      )}
      {sources.length > 0 && (
        <>
          <Btn label={t('para_perf.sources_title')} variant='ghost' size='sm' onPress={() => setSrcOpen(true)} />
          <InsightSourceDrawer visible={srcOpen} onClose={() => setSrcOpen(false)} sources={sources} />
        </>
      )}
      {onChallenge && (
        <Gap h={4} />
      )}
      {onChallenge && (
        <Btn label={t('para_perf.challenge_insight')} variant='outline' size='sm' onPress={onChallenge} />
      )}
    </Card>
  );
}

// ─── ParaInsightStatusChip (re-export label) ────────────────────────────────

// ─── InsightSourceDrawer ────────────────────────────────────────────────────

export function InsightSourceDrawer({ visible, onClose, sources }) {
  return (
    <Sheet visible={visible} onClose={onClose} title={t('para_perf.sources_title')}>
      {sources.map((s, i) => (
        <Card key={i} style={{ marginBottom: 8, backgroundColor: c.violetSoft }}>
          <T size={12} weight='med' color={c.ink}>{s.label || s.metric_key || s.ref}</T>
          {s.provenance && <T size={11} color={c.mute}>{s.provenance}</T>}
          {s.on && <T size={11} color={c.mute}>{day(s.on)}</T>}
        </Card>
      ))}
    </Sheet>
  );
}

// ─── InsightChallengeSheet ──────────────────────────────────────────────────

export function InsightChallengeSheet({ visible, onClose, insightId, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await api.post(`/para/insights/${insightId}/challenge`, { challenge_note: note });
      setNote('');
      onDone?.();
      onClose();
    } finally { setBusy(false); }
  };
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('para_perf.challenge_insight')}
      fields={[{ key: 'challenge_note', label: t('para_perf.challenge_note_label'), multiline: true, value: note, onChange: setNote }]}
      onSubmit={submit} submitLabel={t('para_perf.challenge_submit')} busy={busy}
    />
  );
}

// ─── ParaMetricCatalogSheet ─────────────────────────────────────────────────

export function ParaMetricCatalogSheet({ visible, onClose, sportKey, classCode }) {
  const { data, loading, error } = useLoad(
    () => visible ? api.get('/para/metrics', { params: { sport_key: sportKey, class_code: classCode } }) : null,
    [visible, sportKey, classCode]
  );
  const metrics = data?.metrics || [];
  return (
    <Sheet visible={visible} onClose={onClose} title={t('para_perf.catalog_title')}>
      <T size={12} color={c.mute} style={{ marginBottom: 10 }}>{t('para_perf.disclaimer')}</T>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {metrics.map(m => (
        <Card key={m.metric_key} style={{ marginBottom: 8, backgroundColor: c.paper, gap: 4 }}>
          <Row style={{ gap: 6 }}>
            <T size={14} weight='med' color={c.ink} style={{ flex: 1 }}>{m.display_name}</T>
            {m.unit && <T size={12} color={c.mute}>{m.unit}</T>}
            <View style={{ backgroundColor: m.metric_tier === 'factual' ? c.cyanSoft : c.sunSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
              <T size={10} weight='med' color={m.metric_tier === 'factual' ? c.cyan : c.sun}>
                {t(m.metric_tier === 'factual' ? 'para_perf.metric_factual_chip' : 'para_perf.metric_heuristic_chip')}
              </T>
            </View>
          </Row>
          <T size={12} color={c.mute}>{t(`para_perf.provenance_${m.provenance}`)}</T>
          {m.completeness_note && <T size={11} color={c.mute} style={{ fontStyle: 'italic' }}>{m.completeness_note}</T>}
          {m.governing_body_allows_cohort && (
            <T size={11} color={c.lime}>{t('para_perf.cohort_allowed_label')}</T>
          )}
        </Card>
      ))}
    </Sheet>
  );
}

// ─── Metric trend mini-strip ────────────────────────────────────────────────

function MetricStrip({ metrics }) {
  if (!metrics?.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {metrics.map(m => {
        const pts = m.points || [];
        const latest = pts[pts.length - 1]?.value;
        const prev   = pts.length > 1 ? pts[pts.length - 2]?.value : null;
        const delta  = prev != null ? latest - prev : null;
        const isHeuristic = m.metric_tier === 'heuristic';
        return (
          <Card key={m.metric_key} style={{ flex: 1, minWidth: 130, backgroundColor: isHeuristic ? c.sunSoft : c.cyanSoft, gap: 2 }}>
            <T size={11} color={c.mute}>{m.display_name || m.metric_key}</T>
            <Row style={{ alignItems: 'baseline', gap: 4 }}>
              <T size={22} weight='bold' color={isHeuristic ? c.sun : c.cyan}>
                {latest != null ? `${latest}${m.unit ? ` ${m.unit}` : ''}` : '—'}
              </T>
              {delta != null && <T size={12} color={delta > 0 ? c.lime : delta < 0 ? c.orange : c.mute}>{delta > 0 ? '▲' : delta < 0 ? '▼' : '—'}</T>}
            </Row>
            {isHeuristic && (
              <View style={{ backgroundColor: c.sun, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1, alignSelf: 'flex-start', marginTop: 2 }}>
                <T size={10} color={c.on}>{t('para_perf.metric_heuristic_chip')}</T>
              </View>
            )}
          </Card>
        );
      })}
    </View>
  );
}

// ─── Class badge ───────────────────────────────────────────────────────────

function ClassBadge({ cls }) {
  if (!cls) return null;
  const exp = expires(cls.valid_until);
  return (
    <Card style={{ backgroundColor: c.pink, gap: 6 }}>
      <Row style={{ gap: 10, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={11} color={c.on} weight='med'>{t('para_perf.class_badge', { class: cls.class_code, authority: cls.authority || '' })}</T>
          {cls.decision_ref && <T size={11} color={c.on} style={{ opacity: 0.8 }}>{cls.decision_ref}</T>}
        </View>
        {exp && (
          <View style={{ backgroundColor: exp.color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
            <T size={11} color={c.on} weight='med'>{exp.text}</T>
          </View>
        )}
      </Row>
      <T size={11} color={c.on} style={{ opacity: 0.75, fontStyle: 'italic' }}>{t('para_perf.disclaimer')}</T>
    </Card>
  );
}

// ─── ParaPerformanceDashboard ───────────────────────────────────────────────

export function ParaPerformanceDashboard({ athleteId: propAthleteId, sportKey: propSport, classCode: propClass }) {
  const { user } = useSession();
  const { cols } = useLayout();
  const athleteId = propAthleteId || user.id;

  const [sportKey, setSportKey]   = useState(propSport || '');
  const [classCode, setClassCode] = useState(propClass || '');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [challengeInsight, setChallengeInsight] = useState(null);

  const { data: trendData, loading: tl, error: te, reload: reloadTrend } = useLoad(
    () => sportKey && classCode ? api.get('/me/para/trends', { params: { sport_key: sportKey, class_code: classCode } }) : null,
    [athleteId, sportKey, classCode]
  );
  const { data: insightData, loading: il, error: ie, reload: reloadInsights } = useLoad(
    () => api.get('/me/para/insights', { params: { sport_key: sportKey || undefined, class_code: classCode || undefined } }),
    [athleteId, sportKey, classCode]
  );
  const { data: cohortData } = useLoad(
    () => sportKey && classCode ? api.get('/me/para/cohort', { params: { sport_key: sportKey, class_code: classCode } }).catch(() => null) : null,
    [sportKey, classCode]
  );

  const cls   = trendData?.class_state;
  const metrics = trendData?.metrics || [];
  const insights = insightData?.insights || [];

  const gridCols = cols >= 3 ? 3 : cols >= 2 ? 2 : 1;

  return (
    <Screen title={t('para_perf.dashboard_title')} accessibilityLabel={t('para_perf.dashboard_title')}>
      <Gap />
      <ClassBadge cls={cls} />
      <Gap />
      {cohortData?.cohort && (
        <Card style={{ backgroundColor: c.cyanSoft, gap: 4 }}>
          <T size={12} weight='med' color={c.cyan}>{t('para_perf.cohort_range_label')}</T>
          <Row style={{ gap: 16 }}>
            <T size={12} color={c.mute}>p25: {cohortData.cohort.p25}</T>
            <T size={12} color={c.mute}>p50: {cohortData.cohort.p50}</T>
            <T size={12} color={c.mute}>p75: {cohortData.cohort.p75}</T>
          </Row>
        </Card>
      )}
      {cohortData === null && classCode && (
        <T size={12} color={c.mute} style={{ textAlign: 'center' }}>{t('para_perf.cohort_unavailable')}</T>
      )}
      <Gap />
      {(tl || il) && <Loading />}
      {te && <ErrorBox error={te} onRetry={reloadTrend} />}
      {ie && <ErrorBox error={ie} onRetry={reloadInsights} />}
      {!tl && metrics.length > 0 && (
        <>
          <T size={13} weight='med' color={c.mute} style={{ marginBottom: 6 }}>{t('para_perf.within_athlete_only')}</T>
          <MetricStrip metrics={metrics} />
          <Gap />
        </>
      )}
      <Btn label={t('para_perf.catalog_title')} variant='ghost' size='sm' onPress={() => setCatalogOpen(true)} />
      <Gap />
      {!il && insights.length === 0 && (
        <Empty message={t('para_perf.empty_athlete')} />
      )}
      {insights.length > 0 && (
        <View style={{ gap: 10 }}>
          {insights.map(ins => (
            <ParaInsightCard
              key={ins.id}
              insight={ins}
              onChallenge={() => setChallengeInsight(ins.id)}
            />
          ))}
        </View>
      )}
      <ParaMetricCatalogSheet visible={catalogOpen} onClose={() => setCatalogOpen(false)} sportKey={sportKey} classCode={classCode} />
      {challengeInsight && (
        <InsightChallengeSheet
          visible={!!challengeInsight}
          insightId={challengeInsight}
          onClose={() => setChallengeInsight(null)}
          onDone={reloadInsights}
        />
      )}
    </Screen>
  );
}

// ─── Review detail form ─────────────────────────────────────────────────────

function ReviewDetailPanel({ insight, onDone }) {
  const [resolutions, setResolutions] = useState(() => {
    const r = {};
    (insight.metric_keys || []).forEach(k => { r[k] = insight.metric_resolutions?.[k] || 'pending'; });
    return r;
  });
  const [tags, setTags] = useState(insight.annotation_tags || []);
  const [annotation, setAnnotation] = useState('');
  const [biasFlag, setBiasFlag] = useState(insight.bias_flag || false);
  const [biasBusy, setBiasBusy] = useState(false);
  const [decision, setDecision] = useState('');
  const [busy, setBusy] = useState(false);
  const [biasConfirm, setBiasConfirm] = useState(false);

  const toggleTag = (tag) => setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  const toggleResolution = (mk) => setResolutions(prev => ({ ...prev, [mk]: prev[mk] === 'approved' ? 'rejected' : 'approved' }));
  const canPublish = decision === 'approved' && !biasFlag;

  const submitReview = async (dec) => {
    setBusy(true);
    try {
      await api.post(`/para/insights/${insight.id}/review`, {
        coach_decision: dec,
        metric_resolutions: resolutions,
        annotation_tags: tags,
        coach_annotation: annotation || undefined,
      });
      onDone?.();
    } finally { setBusy(false); }
  };

  const toggleBias = async () => {
    if (!biasFlag) { setBiasConfirm(true); return; }
    setBiasBusy(true);
    try {
      await api.post(`/para/insights/${insight.id}/bias`, { bias_flag: false });
      setBiasFlag(false);
    } finally { setBiasBusy(false); }
  };
  const confirmBias = async () => {
    setBiasConfirm(false);
    setBiasBusy(true);
    try {
      await api.post(`/para/insights/${insight.id}/bias`, { bias_flag: true });
      setBiasFlag(true);
    } finally { setBiasBusy(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      {/* Metric trend mini */}
      {insight.metric_keys?.length > 0 && (
        <Card style={{ backgroundColor: c.violetSoft, gap: 6 }}>
          <T size={12} weight='med' color={c.mute}>{t('para_perf.per_metric_resolution')}</T>
          {insight.metric_keys.map(mk => (
            <Row key={mk} style={{ justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: c.line }}>
              <T size={13} color={c.ink} style={{ flex: 1 }}>{mk}</T>
              <Seg
                value={resolutions[mk]}
                onChange={v => setResolutions(prev => ({ ...prev, [mk]: v }))}
                options={[
                  { value: 'approved', label: t('para_perf.res_approve') },
                  { value: 'pending',  label: t('para_perf.res_pending') },
                  { value: 'rejected', label: t('para_perf.res_reject') },
                ]}
              />
            </Row>
          ))}
        </Card>
      )}

      {/* AI summary */}
      <Card style={{ backgroundColor: c.paper, gap: 6 }}>
        <T size={13} weight='med' color={c.mute}>{t('para_perf.ai_summary_label')}</T>
        <T size={15} color={c.ink} style={{ lineHeight: 22 }}>{insight.ai_draft?.summary}</T>
        {insight.ai_draft?.detail && <T size={13} color={c.mute} style={{ lineHeight: 19 }}>{insight.ai_draft.detail}</T>}
        {insight.ai_draft?.limitations && (
          <T size={12} color={c.orange} style={{ fontStyle: 'italic' }}>{insight.ai_draft.limitations}</T>
        )}
      </Card>

      {/* Annotation tags */}
      <Card style={{ backgroundColor: c.paper, gap: 8 }}>
        <T size={13} weight='med' color={c.mute}>{t('para_perf.annotation_tags_label')}</T>
        <Row style={{ gap: 6 }}>
          {ANNOTATION_TAGS.map(tag => (
            <View key={tag} style={{
              backgroundColor: tags.includes(tag) ? c.pink : c.violetSoft,
              borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
            }}>
              <T size={12} weight='med' color={tags.includes(tag) ? c.on : c.violet}
                accessibilityRole='button' onPress={() => toggleTag(tag)}>
                {t(`para_perf.tag_${tag}`)}
              </T>
            </View>
          ))}
        </Row>
        <FormSheet.TextInput
          label={t('para_perf.annotation_note_label')}
          multiline value={annotation} onChangeText={setAnnotation}
          placeholder={t('para_perf.annotation_placeholder')}
        />
      </Card>

      {/* Bias flag */}
      <Card style={{ backgroundColor: biasFlag ? c.orangeSoft : c.paper, gap: 6 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={13} weight='med' color={biasFlag ? c.orange : c.mute} style={{ flex: 1 }}>{t(biasFlag ? 'para_perf.bias_flagged' : 'para_perf.bias_flag_label')}</T>
          <Btn label={biasFlag ? t('para_perf.bias_clear') : t('para_perf.bias_flag_action')} variant={biasFlag ? 'outline' : 'ghost'} size='sm' onPress={toggleBias} busy={biasBusy} />
        </Row>
        {biasFlag && <T size={12} color={c.orange}>{t('para_perf.bias_blocks_publish')}</T>}
      </Card>

      {/* Action row */}
      <Row style={{ gap: 8, justifyContent: 'flex-end' }}>
        <Btn label={t('para_perf.reject_insight')} variant='outline' onPress={() => submitReview('rejected')} busy={busy} />
        <Btn label={t('para_perf.save_draft')}     variant='ghost'   onPress={() => submitReview('modified')} busy={busy} />
        <Btn label={t('para_perf.approve_publish')} variant='primary' onPress={() => submitReview('approved')} busy={busy} disabled={biasFlag} />
      </Row>

      {/* Bias confirm sheet */}
      <Sheet visible={biasConfirm} onClose={() => setBiasConfirm(false)} title={t('para_perf.bias_confirm_title')}>
        <T size={14} color={c.ink} style={{ marginBottom: 16 }}>{t('para_perf.bias_confirm_body')}</T>
        <Row style={{ gap: 8, justifyContent: 'flex-end' }}>
          <Btn label={t('para_perf.cancel')} variant='ghost' onPress={() => setBiasConfirm(false)} />
          <Btn label={t('para_perf.bias_flag_action')} variant='primary' onPress={confirmBias} />
        </Row>
      </Sheet>
    </View>
  );
}

// ─── Challenge inbox item ────────────────────────────────────────────────────

function ChallengeItem({ item, onDone }) {
  const [resolution, setResolution] = useState('addressed');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const resolve = async () => {
    setBusy(true);
    try {
      await api.post(`/para/insights/${item.id}/challenge/resolve`, { challenge_resolution: resolution, resolution_note: note });
      onDone?.();
    } finally { setBusy(false); }
  };
  return (
    <Card style={{ backgroundColor: c.paper, gap: 10 }}>
      <Row style={{ gap: 8 }}>
        <ParaInsightStatusChip status={item.status} />
        <T size={12} color={c.mute} style={{ flex: 1 }}>{item.class_code} · {item.sport_key}</T>
      </Row>
      <T size={14} weight='med' color={c.ink}>{item.ai_draft?.summary}</T>
      <Card style={{ backgroundColor: c.sunSoft, gap: 4 }}>
        <T size={12} weight='med' color={c.sun}>{t('para_perf.challenge_note_label')}</T>
        <T size={13} color={c.ink}>{item.challenge_note}</T>
      </Card>
      <MenuField label={t('para_perf.resolution_label')} value={resolution} onChange={setResolution}
        options={BIAS_RESOLUTION.map(v => ({ value: v, label: t(`para_perf.resolution_${v}`) }))} />
      <FormSheet.TextInput label={t('para_perf.resolution_note')} value={note} onChangeText={setNote} multiline />
      <Btn label={t('para_perf.challenge_resolve')} onPress={resolve} busy={busy} />
    </Card>
  );
}

// ─── CoachParaInsightReview ─────────────────────────────────────────────────

export function CoachParaInsightReview({ athleteId: propAthleteId }) {
  const { cols } = useLayout();
  const isTablet = cols >= 2;
  const [tab, setTab] = useState('draft');
  const [selected, setSelected] = useState(null);

  const { data, loading, error, reload } = useLoad(
    () => api.get('/para/insights', { params: { status: tab === 'challenge' ? 'under_review' : tab, athlete_id: propAthleteId || undefined } }),
    [tab, propAthleteId]
  );
  const { data: statsData } = useLoad(() => api.get('/para/insights', { params: { athlete_id: propAthleteId || undefined, limit: 200 } }), [propAthleteId]);

  const rows = data?.insights || [];
  const selectedRow = rows.find(r => r.id === selected) || null;

  const counts = useMemo(() => {
    const all = statsData?.insights || [];
    return {
      draft: all.filter(i => i.status === 'draft').length,
      under_review: all.filter(i => i.status === 'under_review').length,
      approved: all.filter(i => i.status === 'approved').length,
      rejected: all.filter(i => i.status === 'rejected').length,
      challenge: all.filter(i => i.challenge_note && !i.challenge_resolved_at).length,
      bias: all.filter(i => i.bias_flag).length,
    };
  }, [statsData]);

  const TAB_OPTS = [
    { value: 'draft',        label: `${t('para_perf.status_draft')} ${counts.draft > 0 ? `(${counts.draft})` : ''}`.trim() },
    { value: 'under_review', label: `${t('para_perf.status_under_review')} ${counts.under_review > 0 ? `(${counts.under_review})` : ''}`.trim() },
    { value: 'approved',     label: t('para_perf.status_approved') },
    { value: 'rejected',     label: t('para_perf.status_rejected') },
    { value: 'challenge',    label: `${t('para_perf.tab_challenges')} ${counts.challenge > 0 ? `(${counts.challenge})` : ''}`.trim() },
  ];

  return (
    <Screen title={t('para_perf.coach_review_title')} accessibilityLabel={t('para_perf.coach_review_title')}>
      {/* Stat strip */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {[
          { label: t('para_perf.stat_drafts'),    value: counts.draft,        color: c.violet },
          { label: t('para_perf.stat_pending'),   value: counts.under_review, color: c.cyan   },
          { label: t('para_perf.stat_approved'),  value: counts.approved,     color: c.lime   },
          { label: t('para_perf.stat_rejected'),  value: counts.rejected,     color: c.orange },
          { label: t('para_perf.stat_challenge'), value: counts.challenge,    color: c.sun    },
          { label: t('para_perf.stat_bias'),      value: counts.bias,         color: c.red    },
        ].map(s => (
          <Card key={s.label} style={{ flex: 1, minWidth: 80, backgroundColor: c.paper, alignItems: 'center', paddingVertical: 8 }}>
            <T size={22} weight='bold' color={s.color}>{s.value}</T>
            <T size={11} color={c.mute}>{s.label}</T>
          </Card>
        ))}
      </View>

      <Seg value={tab} onChange={setTab} options={TAB_OPTS} />
      <Gap />

      {loading && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}

      {!loading && rows.length === 0 && <Empty message={t('para_perf.empty_coach')} />}

      {isTablet ? (
        /* Tablet: split pane */
        <View style={{ flexDirection: 'row', gap: 12, flex: 1 }}>
          <View style={{ flex: 1 }}>
            {rows.map(ins => (
              <View key={ins.id} onTouchEnd={() => setSelected(ins.id)}>
                <Card style={{ marginBottom: 8, backgroundColor: selected === ins.id ? c.pinkSoft : c.paper, gap: 6 }}>
                  <Row style={{ gap: 6 }}>
                    <ParaInsightStatusChip status={ins.status} />
                    {ins.bias_flag && (
                      <View style={{ backgroundColor: c.orangeSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                        <T size={11} color={c.orange}>{t('para_perf.bias_flagged_short')}</T>
                      </View>
                    )}
                  </Row>
                  <T size={13} weight='med' color={c.ink}>{ins.class_code} · {ins.sport_key}</T>
                  <T size={12} color={c.mute} numberOfLines={2}>{ins.ai_draft?.summary}</T>
                </Card>
              </View>
            ))}
          </View>
          <View style={{ flex: 2 }}>
            {selectedRow ? (
              tab === 'challenge'
                ? <ChallengeItem item={selectedRow} onDone={() => { reload(); setSelected(null); }} />
                : <ReviewDetailPanel insight={selectedRow} onDone={() => { reload(); setSelected(null); }} />
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <T size={14} color={c.mute}>{t('para_perf.select_insight_hint')}</T>
              </View>
            )}
          </View>
        </View>
      ) : (
        /* Phone: list → sheet */
        <>
          {rows.map(ins => (
            <View key={ins.id} onTouchEnd={() => setSelected(ins.id)}>
              <Card style={{ marginBottom: 8, backgroundColor: c.paper, gap: 6 }}>
                <Row style={{ gap: 6 }}>
                  <ParaInsightStatusChip status={ins.status} />
                  {ins.bias_flag && (
                    <View style={{ backgroundColor: c.orangeSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <T size={11} color={c.orange}>{t('para_perf.bias_flagged_short')}</T>
                    </View>
                  )}
                </Row>
                <T size={13} weight='med' color={c.ink}>{ins.class_code} · {ins.sport_key}</T>
                <T size={12} color={c.mute} numberOfLines={2}>{ins.ai_draft?.summary}</T>
              </Card>
            </View>
          ))}
          <Sheet visible={!!selectedRow} onClose={() => setSelected(null)} title={t('para_perf.review_sheet_title')}>
            {selectedRow && (tab === 'challenge'
              ? <ChallengeItem item={selectedRow} onDone={() => { reload(); setSelected(null); }} />
              : <ReviewDetailPanel insight={selectedRow} onDone={() => { reload(); setSelected(null); }} />
            )}
          </Sheet>
        </>
      )}
    </Screen>
  );
}

// ─── AcademyParaProgressView ────────────────────────────────────────────────

export function AcademyParaProgressView({ organisationId }) {
  const { cols } = useLayout();
  const isTablet = cols >= 2;
  const [sportKey, setSportKey] = useState('');
  const [classCode, setClassCode] = useState('');
  const [q, setQ] = useState('');

  const { data, loading, error, reload } = useLoad(
    () => organisationId
      ? api.get(`/organisations/${organisationId}/para/progress`, { params: { sport_key: sportKey || undefined, class_code: classCode || undefined } })
      : null,
    [organisationId, sportKey, classCode]
  );

  const rows = useMemo(() => {
    const all = data?.athletes || [];
    if (!q) return all;
    const lq = q.toLowerCase();
    return all.filter(a => (a.name || '').toLowerCase().includes(lq) || (a.class_code || '').toLowerCase().includes(lq));
  }, [data, q]);

  return (
    <Screen title={t('para_perf.academy_progress_title')} accessibilityLabel={t('para_perf.academy_progress_title')}>
      <Card style={{ backgroundColor: c.cyanSoft, marginBottom: 10 }}>
        <T size={12} weight='med' color={c.cyan}>{t('para_perf.no_cross_class_notice')}</T>
      </Card>

      <Row style={{ gap: 8, marginBottom: 12 }}>
        <MenuField label={t('para_perf.filter_sport')} value={sportKey} onChange={setSportKey}
          options={[{ value: '', label: t('para_perf.all_sports') }].concat((data?.sports || []).map(s => ({ value: s.key, label: s.display })))}
          style={{ flex: 1 }} />
        <MenuField label={t('para_perf.filter_class')} value={classCode} onChange={setClassCode}
          options={[{ value: '', label: t('para_perf.all_classes') }].concat((data?.classes || []).map(c2 => ({ value: c2.code, label: c2.code })))}
          style={{ flex: 1 }} />
      </Row>

      <FormSheet.TextInput label={t('para_perf.search_placeholder')} value={q} onChangeText={setQ} style={{ marginBottom: 12 }} />

      {loading && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!loading && rows.length === 0 && <Empty message={t('para_perf.empty_academy')} />}

      {isTablet ? (
        /* Tablet/desktop: table */
        <View>
          <Row style={{ backgroundColor: c.violetSoft, padding: 8, borderRadius: 10, marginBottom: 4 }}>
            <T size={12} weight='med' color={c.mute} style={{ flex: 3 }}>{t('para_perf.col_athlete')}</T>
            <T size={12} weight='med' color={c.mute} style={{ flex: 2 }}>{t('para_perf.col_sport')}</T>
            <T size={12} weight='med' color={c.mute} style={{ flex: 2 }}>{t('para_perf.col_class')}</T>
            <T size={12} weight='med' color={c.mute} style={{ flex: 2 }}>{t('para_perf.col_last_review')}</T>
            <T size={12} weight='med' color={c.mute} style={{ flex: 1 }}>{t('para_perf.col_approved')}</T>
            <T size={12} weight='med' color={c.mute} style={{ flex: 1 }}>{t('para_perf.col_challenges')}</T>
            <T size={12} weight='med' color={c.mute} style={{ flex: 1 }}>{t('para_perf.col_bias')}</T>
          </Row>
          {rows.map(a => (
            <Row key={a.athlete_id} style={{ padding: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
              <T size={13} color={c.ink}  style={{ flex: 3 }}>{a.name}</T>
              <T size={13} color={c.mute} style={{ flex: 2 }}>{a.sport_key}</T>
              <Tag style={{ flex: 2 }}>{a.class_code}</Tag>
              <T size={13} color={c.mute} style={{ flex: 2 }}>{a.last_review ? day(a.last_review) : '—'}</T>
              <T size={13} color={c.lime} style={{ flex: 1 }}>{a.approved_count ?? 0}</T>
              <T size={13} color={a.open_challenges > 0 ? c.sun : c.mute} style={{ flex: 1 }}>{a.open_challenges ?? 0}</T>
              <T size={13} color={a.bias_flags > 0 ? c.red : c.mute} style={{ flex: 1 }}>{a.bias_flags ?? 0}</T>
            </Row>
          ))}
        </View>
      ) : (
        /* Phone: list */
        rows.map(a => (
          <Card key={a.athlete_id} style={{ marginBottom: 8, backgroundColor: c.paper, gap: 6 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={14} weight='med' color={c.ink} style={{ flex: 1 }}>{a.name}</T>
              <Tag>{a.class_code}</Tag>
            </Row>
            <Row style={{ gap: 10 }}>
              <T size={12} color={c.mute}>{a.sport_key}</T>
              {a.last_review && <T size={12} color={c.mute}>{day(a.last_review)}</T>}
            </Row>
            <Row style={{ gap: 10 }}>
              <T size={12} color={c.lime}>{a.approved_count ?? 0} {t('para_perf.col_approved')}</T>
              {a.open_challenges > 0 && <T size={12} color={c.sun}>{a.open_challenges} {t('para_perf.col_challenges')}</T>}
              {a.bias_flags > 0 && <T size={12} color={c.red}>{a.bias_flags} {t('para_perf.stat_bias')}</T>}
            </Row>
          </Card>
        ))
      )}
    </Screen>
  );
}
