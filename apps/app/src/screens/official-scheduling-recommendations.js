// Official Scheduling Recommendations — Issue #1022 (REF-R24)
// Explainable AI-ranked official suggestions: per-dimension score cards,
// override audit, event-level policy config, suggestion history.
// iOS · iPadOS · Android · web. No web-only APIs.
import React, { useMemo, useState, useCallback } from 'react';
import { Platform, Pressable, ScrollView, View, FlatList } from 'react-native';
import { api } from '../api';
import { useLoad, useRefresh } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import {
  Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen,
  Section, Seg, Sheet, T, Tag,
} from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, grad, r } from '../theme';
import { t } from '../i18n';
import { Metric } from '../federation-ui';
import { MenuField } from '../menu-field';
import { useSession } from '../session';

const DIMENSIONS = ['grade','travel','neutral','rotation','cost','avail'];
const DIM_ICON = { grade: '🏅', travel: '📍', neutral: '⚖️', rotation: '🔄', cost: '💰', avail: '📅' };

function scoreColor(score, max) {
  const pct = max > 0 ? score / max : 0;
  return pct >= 0.8 ? c.lime : pct >= 0.5 ? c.sun : c.red;
}

function totalScoreColor(score) {
  return score >= 80 ? c.lime : score >= 55 ? c.sun : c.red;
}

// ─── ScoreBar ────────────────────────────────────────────────────────────────
function ScoreBar({ score, maxScore, style }) {
  const pct = maxScore > 0 ? Math.min(1, score / maxScore) : 0;
  const bg = scoreColor(score, maxScore);
  return (
    <View style={[{ height: 6, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden' }, style]}>
      <View style={{ width: `${Math.round(pct * 100)}%`, height: '100%', backgroundColor: bg, borderRadius: 3 }} />
    </View>
  );
}

// ─── DataGapBadge ────────────────────────────────────────────────────────────
function DataGapBadge() {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: c.sunSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 3,
    }}>
      <T size={11}>⚠️</T>
      <T size={11} color={c.sun} weight="600">{t('osr.data_gap')}</T>
    </View>
  );
}

// ─── DimensionCard (expandable) ──────────────────────────────────────────────
function DimensionCard({ card, expanded, onToggle }) {
  if (!card) return null;
  const col = scoreColor(card.score, card.max_score);
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${t(`osr.dim.${card.dimension}`)} score ${card.score} of ${card.max_score}. ${card.label}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? c.pinkSoft : c.bg,
        borderRadius: r.card / 2,
        padding: 10,
        gap: 6,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T size={14}>{DIM_ICON[card.dimension]}</T>
        <T size={12} weight="600" style={{ flex: 1 }}>{t(`osr.dim.${card.dimension}`)}</T>
        {card.data_gap && <DataGapBadge />}
        {card.warning && !card.data_gap && <T size={12}>⚠️</T>}
        <T size={12} weight="700" color={col}>{card.score}<T size={10} color={c.mute}>/{card.max_score}</T></T>
        <T size={12} color={c.mute}>{expanded ? '▲' : '▼'}</T>
      </View>
      <ScoreBar score={card.score} maxScore={card.max_score} />
      <T size={11} color={c.mute} numberOfLines={expanded ? undefined : 1}>{card.label}</T>
      {expanded && (
        <T size={11} color={c.ink} style={{ marginTop: 4, lineHeight: 16 }}>{card.detail}</T>
      )}
    </Pressable>
  );
}

// ─── TotalScoreRing ───────────────────────────────────────────────────────────
function TotalScoreRing({ score }) {
  const col = totalScoreColor(score);
  if (Platform.OS === 'web') {
    const pct = Math.min(100, score);
    const r2 = 20, cx = 24, cy = 24;
    const circumference = 2 * Math.PI * r2;
    const dash = (pct / 100) * circumference;
    return (
      <svg width={48} height={48} viewBox="0 0 48 48" aria-label={`Score ${score}`}>
        <circle cx={cx} cy={cy} r={r2} fill="none" stroke={c.line} strokeWidth={4} />
        <circle
          cx={cx} cy={cy} r={r2} fill="none"
          stroke={col} strokeWidth={4}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight="800" fill={col}>{score}</text>
      </svg>
    );
  }
  return (
    <View style={{
      width: 48, height: 48, borderRadius: 24,
      borderWidth: 4, borderColor: col,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.paper,
    }}>
      <T size={12} weight="800" color={col}>{score}</T>
    </View>
  );
}

// ─── RecommendationCard ───────────────────────────────────────────────────────
function RecommendationCard({ item, rank, onInvite, onShortlist, onOverride, onViewHistory }) {
  const [expandedDim, setExpandedDim] = useState(null);
  const [busy, setBusy] = useState(null);

  const toggleDim = (dim) => setExpandedDim((prev) => prev === dim ? null : dim);

  const handle = async (action, setter) => {
    setBusy(setter);
    try { await action(); } catch (e) { /* caller handles */ } finally { setBusy(null); }
  };

  return (
    <Card style={{ gap: 12, padding: 16 }}>
      {/* Header: rank, avatar, name, grade, score ring */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        {/* Rank badge */}
        <View style={{
          width: 28, height: 28, borderRadius: 14,
          backgroundColor: rank === 1 ? c.pink : rank === 2 ? c.violet : c.line,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <T size={12} weight="800" color={c.on}>#{rank}</T>
        </View>

        {/* Avatar */}
        <View style={{
          width: 40, height: 40, borderRadius: 20,
          backgroundColor: item.avatar_color ?? c.violet,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <T size={15} weight="800" color={c.on}>
            {(item.display_name ?? '').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
          </T>
        </View>

        {/* Name + grade + preferred badge */}
        <View style={{ flex: 1, gap: 4 }}>
          <T weight="700" size={15}>{item.display_name ?? item.handle}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
            {item.grade_name ? <Chip label={item.grade_name} color={c.pinkSoft} small /> : null}
            {item.is_preferred ? <Chip label={t('osr.preferred_badge')} color={c.mintSoft} small /> : null}
            {item.dist_label ? <Chip label={item.dist_label} color={c.cyanSoft} small /> : null}
            {item.availability_state === 'unavailable' ? <Chip label="Unavailable" color={c.redSoft} small /> : null}
          </View>
        </View>

        <TotalScoreRing score={item.score ?? 0} />
      </View>

      {/* Dimension cards */}
      <View style={{ gap: 2 }}>
        {(item.dimension_cards ?? []).map((card) => (
          <DimensionCard
            key={card.dimension}
            card={card}
            expanded={expandedDim === card.dimension}
            onToggle={() => toggleDim(card.dimension)}
          />
        ))}
      </View>

      {/* Action bar */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 }}>
        <Btn
          label={t('osr.invite')}
          small
          color={c.pink}
          onPress={() => handle(onInvite, 'invite')}
          loading={busy === 'invite'}
          style={{ flex: 1, minHeight: 44 }}
          accessibilityLabel={`Invite ${item.display_name}`}
        />
        <Btn
          label={t('osr.shortlist')}
          small
          color={c.cyanSoft}
          ink={c.ink}
          onPress={() => handle(onShortlist, 'shortlist')}
          loading={busy === 'shortlist'}
          style={{ flex: 1, minHeight: 44 }}
          accessibilityLabel={`Shortlist ${item.display_name}`}
        />
        {rank > 1 && (
          <Btn
            label={t('osr.override')}
            small
            color={c.sunSoft}
            ink={c.ink}
            onPress={onOverride}
            style={{ minHeight: 44 }}
            accessibilityLabel={`Override and select ${item.display_name}`}
          />
        )}
      </View>
    </Card>
  );
}

// ─── OverrideSheet ────────────────────────────────────────────────────────────
function OverrideSheet({ skipped, chosen, onConfirm, onClose }) {
  const [category, setCategory] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const CATS = ['local_preference','budget_constraint','rotation_policy','special_skills','other'];

  const submit = async () => {
    if (!category || reason.trim().length < 20) return;
    setBusy(true); setErr(null);
    try {
      await onConfirm({ category, reason: reason.trim() });
      onClose();
    } catch (e) { setErr(e); setBusy(false); }
  };

  return (
    <Sheet onClose={onClose} title={t('osr.override.title')}>
      <View style={{ gap: 16, padding: 16 }}>
        {/* Comparison */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1, alignItems: 'center', gap: 4, padding: 12, backgroundColor: c.pinkSoft, borderRadius: r.card }}>
            <T size={11} color={c.mute}>Skipping #{skipped?.rank}</T>
            <T weight="700" size={13}>{skipped?.display_name}</T>
            <T size={22} weight="800" color={c.pink}>{skipped?.score}</T>
            <T size={11} color={c.mute}>score</T>
          </View>
          <T size={20} style={{ alignSelf: 'center' }}>→</T>
          <View style={{ flex: 1, alignItems: 'center', gap: 4, padding: 12, backgroundColor: c.sunSoft, borderRadius: r.card }}>
            <T size={11} color={c.mute}>Selecting #{chosen?.rank}</T>
            <T weight="700" size={13}>{chosen?.display_name}</T>
            <T size={22} weight="800" color={c.sun}>{chosen?.score}</T>
            <T size={11} color={c.mute}>score</T>
          </View>
        </View>

        {/* Category */}
        <View style={{ gap: 8 }}>
          <T weight="600" size={13}>{t('osr.override.why')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {CATS.map((cat) => (
              <Pressable
                key={cat}
                onPress={() => setCategory(cat)}
                accessibilityRole="radio"
                accessibilityState={{ checked: category === cat }}
                style={{
                  paddingHorizontal: 14, paddingVertical: 10,
                  borderRadius: r.pill,
                  borderWidth: 1.5,
                  borderColor: category === cat ? c.pink : c.line,
                  backgroundColor: category === cat ? c.pinkSoft : c.paper,
                  minHeight: 44,
                  justifyContent: 'center',
                }}
              >
                <T size={12} weight={category === cat ? '700' : '400'}>{t(`osr.override.category.${cat}`)}</T>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Reason */}
        <Field
          label={t('osr.override.reason_label')}
          value={reason}
          onChangeText={setReason}
          placeholder={t('osr.override.reason_placeholder')}
          multiline
          minHeight={80}
          helper={reason.trim().length < 20 ? t('osr.override.reason_min') : undefined}
        />

        {err ? <T size={12} color={c.red}>{err.message ?? 'Error recording override'}</T> : null}

        <Btn
          label={t('osr.override.submit')}
          onPress={submit}
          loading={busy}
          disabled={!category || reason.trim().length < 20}
          color={c.sun}
          style={{ minHeight: 44 }}
        />
      </View>
    </Sheet>
  );
}

// ─── PolicyConfigSheet ────────────────────────────────────────────────────────
function PolicyConfigSheet({ eventId, policy, pool, onSaved, onClose }) {
  const [weights, setWeights] = useState({
    w_grade: policy?.weights?.grade ?? 30,
    w_travel: policy?.weights?.travel ?? 24,
    w_neutral: policy?.weights?.neutral ?? 20,
    w_rotation: policy?.weights?.rotation ?? 14,
    w_cost: policy?.weights?.cost ?? 8,
    w_avail: policy?.weights?.avail ?? 4,
  });
  const [maxPerDay, setMaxPerDay] = useState(String(policy?.max_per_official_per_day ?? ''));
  const [travelBudget, setTravelBudget] = useState(String(policy?.travel_budget_km ?? ''));
  const [minGrade, setMinGrade] = useState(String(policy?.min_grade_rank ?? ''));
  const [requireNeutral, setRequireNeutral] = useState(policy?.require_neutral ?? false);
  const [autoSuggest, setAutoSuggest] = useState(policy?.auto_suggest_on_publish ?? false);
  const [preferredIds, setPreferredIds] = useState(policy?.preferred_user_ids ?? []);
  const [blockedIds, setBlockedIds] = useState(policy?.blocked_user_ids ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const weightSum = Object.values(weights).reduce((s, v) => s + (Number(v) || 0), 0);
  const sumOk = weightSum <= 100;

  const updateW = (key, val) => setWeights((prev) => ({ ...prev, [key]: Number(val) || 0 }));

  const save = async () => {
    if (!sumOk) return;
    setBusy(true); setErr(null);
    try {
      const payload = {
        ...weights,
        require_neutral: requireNeutral,
        max_per_official_per_day: maxPerDay ? Number(maxPerDay) : null,
        travel_budget_km: travelBudget ? Number(travelBudget) : null,
        min_grade_rank: minGrade ? Number(minGrade) : null,
        preferred_user_ids: preferredIds,
        blocked_user_ids: blockedIds,
        auto_suggest_on_publish: autoSuggest,
      };
      await api.post(`/events/${eventId}/officials/scheduling-policy`, payload);
      onSaved();
      onClose();
    } catch (e) { setErr(e); setBusy(false); }
  };

  const DIM_KEYS = ['w_grade','w_travel','w_neutral','w_rotation','w_cost','w_avail'];
  const DIM_NAMES = {
    w_grade: t('osr.dim.grade'), w_travel: t('osr.dim.travel'), w_neutral: t('osr.dim.neutral'),
    w_rotation: t('osr.dim.rotation'), w_cost: t('osr.dim.cost'), w_avail: t('osr.dim.avail'),
  };

  return (
    <Sheet onClose={onClose} title={t('osr.policy.title')}>
      <ScrollView contentContainerStyle={{ gap: 20, padding: 16, paddingBottom: 40 }}>

        {/* Weights */}
        <Section title={t('osr.policy.weights_title')}>
          <View style={{ gap: 10 }}>
            {DIM_KEYS.map((key) => (
              <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <T size={12} style={{ flex: 1 }}>{DIM_NAMES[key]}</T>
                <Field
                  value={String(weights[key])}
                  onChangeText={(v) => updateW(key, v)}
                  keyboardType="numeric"
                  style={{ width: 60 }}
                />
              </View>
            ))}
            <T size={12} color={sumOk ? c.mute : c.red} weight={sumOk ? '400' : '700'}>
              {sumOk ? `Total: ${weightSum}/100` : t('osr.policy.weights_sum_error') + ` (${weightSum})`}
            </T>
          </View>
        </Section>

        {/* Rules */}
        <Section title={t('osr.policy.rules_title')}>
          <View style={{ gap: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}>
              <T size={13}>{t('osr.policy.require_neutral')}</T>
              <Pressable
                onPress={() => setRequireNeutral(!requireNeutral)}
                accessibilityRole="switch"
                accessibilityState={{ checked: requireNeutral }}
                style={{
                  width: 44, height: 26, borderRadius: 13,
                  backgroundColor: requireNeutral ? c.pink : c.line,
                  justifyContent: 'center', paddingHorizontal: 2,
                }}
              >
                <View style={{
                  width: 22, height: 22, borderRadius: 11,
                  backgroundColor: c.on,
                  alignSelf: requireNeutral ? 'flex-end' : 'flex-start',
                }} />
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}>
              <T size={13}>{t('osr.policy.auto_suggest')}</T>
              <Pressable
                onPress={() => setAutoSuggest(!autoSuggest)}
                accessibilityRole="switch"
                accessibilityState={{ checked: autoSuggest }}
                style={{
                  width: 44, height: 26, borderRadius: 13,
                  backgroundColor: autoSuggest ? c.pink : c.line,
                  justifyContent: 'center', paddingHorizontal: 2,
                }}
              >
                <View style={{
                  width: 22, height: 22, borderRadius: 11,
                  backgroundColor: c.on,
                  alignSelf: autoSuggest ? 'flex-end' : 'flex-start',
                }} />
              </Pressable>
            </View>
            <Field
              label={t('osr.policy.max_per_day')}
              value={maxPerDay}
              onChangeText={setMaxPerDay}
              keyboardType="numeric"
            />
            <Field
              label={t('osr.policy.travel_budget')}
              value={travelBudget}
              onChangeText={setTravelBudget}
              keyboardType="numeric"
            />
            <Field
              label={t('osr.policy.min_grade')}
              value={minGrade}
              onChangeText={setMinGrade}
              keyboardType="numeric"
            />
          </View>
        </Section>

        {/* Preferred / blocked officials */}
        {pool?.officials?.length ? (
          <>
            <MenuField
              label={t('osr.policy.preferred')}
              options={pool.officials.map((o) => ({ value: String(o.id), label: o.display_name }))}
              value={preferredIds.map(String)}
              onChange={(v) => setPreferredIds(v.map(Number))}
              multi
            />
            <MenuField
              label={t('osr.policy.blocked')}
              options={pool.officials.map((o) => ({ value: String(o.id), label: o.display_name }))}
              value={blockedIds.map(String)}
              onChange={(v) => setBlockedIds(v.map(Number))}
              multi
            />
          </>
        ) : null}

        {err ? <T size={12} color={c.red}>{err.message ?? 'Error saving policy'}</T> : null}

        <Btn
          label={t('osr.policy.save')}
          onPress={save}
          loading={busy}
          disabled={!sumOk}
          color={c.pink}
          style={{ minHeight: 44 }}
        />
      </ScrollView>
    </Sheet>
  );
}

// ─── SuggestionHistorySheet ───────────────────────────────────────────────────
function SuggestionHistorySheet({ fixtureId, role, onClose }) {
  const q = useLoad(() => api.get(`/fixtures/${fixtureId}/officials/suggestion-history`, { role }), [fixtureId, role]);

  return (
    <Sheet onClose={onClose} title={t('osr.history.title')}>
      {q.loading ? <Loading /> : q.error ? <LoadError error={q.error} onRetry={q.reload} /> : (
        (q.data?.history ?? []).length === 0
          ? <Empty icon="📋" label={t('osr.history.empty')} />
          : (
            <FlatList
              data={q.data.history}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={{ gap: 10, padding: 12 }}
              renderItem={({ item }) => (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12,
                  borderRadius: r.card, backgroundColor: c.paper,
                  borderWidth: 1, borderColor: c.line,
                }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: item.avatar_color ?? c.violet, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={12} weight="800" color={c.on}>{(item.display_name ?? '').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</T>
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <T weight="700" size={13}>{item.display_name}</T>
                    <T size={11} color={c.mute}>{item.grade_name ?? '—'}</T>
                    <T size={11} color={c.mute}>{new Date(item.created_at).toLocaleDateString()}</T>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <T size={16} weight="800" color={totalScoreColor(item.score)}>{item.score}</T>
                    {item.was_overridden ? <Chip label={t('osr.history.overridden')} color={c.sunSoft} small /> : null}
                    {item.was_invited ? <Chip label={t('osr.history.invited')} color={c.mintSoft} small /> : null}
                    {item.was_shortlisted ? <Chip label={t('osr.history.shortlisted')} color={c.cyanSoft} small /> : null}
                  </View>
                </View>
              )}
            />
          )
      )}
    </Sheet>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────
export function OfficialSchedulingRecommendations({ eventId, fixtureId, role }) {
  const { width } = useLayout();
  const { session } = useSession();
  const nav = useNav();
  const isTablet = width >= 768;
  const isDesktop = width >= 1200;
  const numColumns = isDesktop ? 3 : isTablet ? 2 : 1;

  const q = useLoad(
    () => api.get(`/fixtures/${fixtureId}/officials/suggest`, { role, limit: 20 }),
    [fixtureId, role]
  );
  const policyQ = useLoad(
    () => api.get(`/events/${eventId}/officials/scheduling-policy`),
    [eventId]
  );
  const poolQ = useLoad(
    () => api.get(`/events/${eventId}/officials/pool`, { limit: 100 }),
    [eventId]
  );

  const refresh = useRefresh(() => { q.reload(); policyQ.reload(); }, []);

  const [sortBy, setSortBy] = useState('score');
  const [filterBy, setFilterBy] = useState('all');
  const [showPolicy, setShowPolicy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [overrideState, setOverrideState] = useState(null); // { skipped, chosen }

  const suggestions = useMemo(() => {
    let list = q.data?.suggestions ?? [];
    if (filterBy === 'available') list = list.filter((s) => s.availability_state !== 'unavailable');
    if (sortBy === 'grade') list = [...list].sort((a, b) => (b.grade_rank ?? 0) - (a.grade_rank ?? 0));
    else if (sortBy === 'travel') list = [...list].sort((a, b) => (b.score_travel ?? 0) - (a.score_travel ?? 0));
    else if (sortBy === 'cost') list = [...list].sort((a, b) => (b.score_cost ?? 0) - (a.score_cost ?? 0));
    else list = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return list;
  }, [q.data, sortBy, filterBy]);

  const handleInvite = useCallback(async (item) => {
    await api.post(`/events/${eventId}/officials/bulk-invite`, {
      role,
      fixture_ids: [fixtureId],
      user_ids: [item.user_id],
    });
    q.reload();
  }, [eventId, fixtureId, role]);

  const handleShortlist = useCallback(async (item) => {
    await api.post(`/fixtures/${fixtureId}/officials/shortlist`, {
      user_id: item.user_id,
      role,
    });
    q.reload();
  }, [fixtureId, role]);

  const handleOverrideConfirm = useCallback(async ({ category, reason }) => {
    if (!overrideState) return;
    // Find the log entry for the skipped official
    const logEntry = overrideState.skipped;
    if (logEntry?.log_id) {
      await api.post(`/suggestion-logs/${logEntry.log_id}/override`, {
        selected_user_id: overrideState.chosen.user_id,
        original_rank: overrideState.skipped.rank,
        override_category: category,
        override_reason: reason,
      });
    }
    // Then invite the chosen official
    await handleInvite(overrideState.chosen);
    setOverrideState(null);
  }, [overrideState, handleInvite]);

  const fixtureLabel = q.data?.fixture_id ? `Fixture #${fixtureId}` : '';
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';

  return (
    <Screen>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 10 }}>
        <View style={{ flex: 1 }}>
          <H1>{t('osr.title')}</H1>
          <T size={12} color={c.mute}>{roleLabel} · {fixtureLabel}</T>
        </View>
        <Pressable
          onPress={() => setShowHistory(true)}
          accessibilityRole="button"
          accessibilityLabel="Suggestion history"
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <T size={20}>📋</T>
        </Pressable>
        <Pressable
          onPress={() => setShowPolicy(true)}
          accessibilityRole="button"
          accessibilityLabel={t('osr.policy.title')}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <T size={20}>⚙️</T>
        </Pressable>
      </View>

      {/* Stats bar */}
      {q.data && (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          <Chip label={`${suggestions.length} candidates`} color={c.pinkSoft} />
          {q.data.blocked_count > 0 && <Chip label={`${q.data.blocked_count} ${t('osr.blocked_excluded')}`} color={c.sunSoft} small />}
          {q.data.preferred_count > 0 && <Chip label={`${q.data.preferred_count} preferred`} color={c.mintSoft} small />}
          {policyQ.data?.is_customised && <Chip label="Custom policy" color={c.violetSoft ?? c.pinkSoft} small />}
        </View>
      )}

      {/* Filter bar */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8 }}>
        <Seg
          value={sortBy}
          onChange={setSortBy}
          options={[
            { value: 'score', label: 'Score' },
            { value: 'grade', label: 'Grade' },
            { value: 'travel', label: 'Travel' },
            { value: 'cost', label: 'Cost' },
          ]}
        />
        <Seg
          value={filterBy}
          onChange={setFilterBy}
          options={[
            { value: 'all', label: 'All' },
            { value: 'available', label: 'Available only' },
          ]}
        />
      </View>

      {/* Content */}
      {q.loading
        ? <Loading />
        : q.error
          ? <LoadError error={q.error} onRetry={q.reload} />
          : suggestions.length === 0
            ? <Empty icon="👤" label={t('osr.empty.title')} body={t('osr.empty.body')} />
            : (
              <FlatList
                key={numColumns}
                data={suggestions}
                numColumns={numColumns}
                keyExtractor={(item) => String(item.user_id)}
                contentContainerStyle={{ padding: 16, gap: 12 }}
                columnWrapperStyle={numColumns > 1 ? { gap: 12 } : undefined}
                refreshing={q.loading}
                onRefresh={refresh}
                renderItem={({ item, index }) => (
                  <View style={numColumns > 1 ? { flex: 1 } : undefined}>
                    <RecommendationCard
                      item={item}
                      rank={index + 1}
                      onInvite={() => handleInvite(item)}
                      onShortlist={() => handleShortlist(item)}
                      onOverride={() => {
                        const top = suggestions[0];
                        if (top && top.user_id !== item.user_id) {
                          setOverrideState({ skipped: { ...top, rank: 1 }, chosen: { ...item, rank: index + 1 } });
                        }
                      }}
                    />
                  </View>
                )}
              />
            )
      }

      {/* Sheets */}
      {showPolicy && (
        <PolicyConfigSheet
          eventId={eventId}
          policy={policyQ.data}
          pool={poolQ.data}
          onSaved={() => { policyQ.reload(); q.reload(); }}
          onClose={() => setShowPolicy(false)}
        />
      )}
      {showHistory && (
        <SuggestionHistorySheet
          fixtureId={fixtureId}
          role={role}
          onClose={() => setShowHistory(false)}
        />
      )}
      {overrideState && (
        <OverrideSheet
          skipped={overrideState.skipped}
          chosen={overrideState.chosen}
          onConfirm={handleOverrideConfirm}
          onClose={() => setOverrideState(null)}
        />
      )}
    </Screen>
  );
}
