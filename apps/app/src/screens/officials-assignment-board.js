// Officials Assignment Board — Issue #1005 (R13)
// Organiser-facing board: fixture grid × roles, AI suggest, availability overlay,
// drag-swap indicator, conflict flags, coverage stats, shortlist, bulk-action bar.
// Accessible on iOS, iPadOS, Android and web. No web-only APIs.
import React, { useMemo, useState, useCallback, useRef } from 'react';
import { AccessibilityInfo, Alert, Platform, Pressable, ScrollView, View } from 'react-native';
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
import { money } from '../federation-ui';
import { useSession } from '../session';

const ROLE_LABEL = {
  referee: t('officials.role.referee'),
  umpire: t('officials.role.umpire'),
  linesman: t('officials.role.linesman'),
  scorer: t('officials.role.scorer'),
};
const ROLE_SHORT = { referee: 'Ref', umpire: 'Umpire', linesman: 'AR', scorer: 'Scorer' };
const STATUS_COLOR = {
  accepted: c.mintSoft,
  invited: c.sunSoft,
  shortlisted: c.cyanSoft,
};
const STATUS_ICON = { accepted: '✅', invited: '⏳', shortlisted: '📋' };

// ─── Coverage ring ────────────────────────────────────────────────────────────
function CoverageRing({ pct, size = 56 }) {
  const radius = (size - 10) / 2;
  const circ = 2 * Math.PI * radius;
  const filled = (pct / 100) * circ;
  const color = pct >= 100 ? c.lime : pct >= 60 ? c.sun : c.red;
  if (Platform.OS === 'web') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={c.line} strokeWidth={8} />
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={8}
            strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" />
        </svg>
        <T size={12} weight="800" color={color}>{pct}%</T>
      </View>
    );
  }
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', borderRadius: size / 2, borderWidth: 5, borderColor: color }}>
      <T size={12} weight="800" color={color}>{pct}%</T>
    </View>
  );
}

// ─── Official pill (one slot in the grid) ────────────────────────────────────
function OfficialPill({ assignment, onPress, hasConflict, isDragging }) {
  const isLocked = !!assignment.locked_at;
  const isTravelClash = hasConflict && assignment.clash_type === 'travel_gap';
  const bgColor = hasConflict ? (isTravelClash ? c.orangeSoft : c.orangeSoft) : isLocked ? c.pinkSoft : STATUS_COLOR[assignment.status] ?? c.paper;
  const icon = hasConflict ? (isTravelClash ? '🚗' : '⚠️') : isLocked ? '🔒' : STATUS_ICON[assignment.status] ?? '';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${assignment.display_name}, ${ROLE_LABEL[assignment.role]}, ${assignment.status}${hasConflict ? ', conflict' : ''}${isLocked ? ', locked' : ''}`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10,
        borderRadius: r.card / 2, backgroundColor: bgColor,
        opacity: pressed || isDragging ? 0.7 : 1,
        borderWidth: hasConflict || isLocked ? 1 : 0,
        borderColor: hasConflict ? c.orange : isLocked ? c.pink : 'transparent',
        minHeight: 44,
      })}
    >
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: isLocked ? c.pink : c.pink, alignItems: 'center', justifyContent: 'center' }}>
        <T size={10} weight="800" color={c.on}>
          {(assignment.display_name ?? '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
        </T>
      </View>
      <T size={12} weight="700" style={{ flex: 1 }} numberOfLines={1}>{assignment.display_name}</T>
      {assignment.grade_name ? <Chip label={assignment.grade_name.slice(0, 4)} color={c.pinkSoft} small /> : null}
      <T size={12}>{icon}</T>
    </Pressable>
  );
}

/** Bottom sheet showing full clash detail — venue distance, gap, travel time needed. */
function ClashDetailSheet({ assignment, clashInfo, visible, onClose, onOverride, isOrganizer }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useSession?.() ?? { toast: () => {} };
  if (!visible || !assignment) return null;
  const isTravelGap = clashInfo?.clash_type === 'travel_gap';
  const isLocked = !!assignment.locked_at;

  const handleOverride = async () => {
    if (!reason.trim() || reason.trim().length < 10) return;
    setBusy(true);
    try {
      await onOverride(reason.trim());
      onClose();
    } catch (e) { toast?.(e?.message ?? 'Override failed'); }
    finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t(isLocked ? 'officials.lock.unlock_title' : 'officials.clash.detail_title')}>
      <View style={{ gap: 14, padding: 4 }}>
        {isLocked && (
          <View style={{ gap: 8, padding: 14, backgroundColor: c.pinkSoft, borderRadius: r.card }}>
            <T weight="700" size={14}>{t('officials.clash.locked_error')}</T>
            <T size={13} color={c.mute}>{assignment.lock_reason}</T>
          </View>
        )}
        {isTravelGap && (
          <View style={{ gap: 8, padding: 14, backgroundColor: c.orangeSoft, borderRadius: r.card }}>
            <T weight="700" size={14}>{t('officials.clash.travel_error')}</T>
            <T size={13} color={c.mute}>
              {t('officials.clash.travel_error_body', {
                distKm: clashInfo.venue_distance_km,
                gapMin: clashInfo.computed_gap_min,
                reqMin: clashInfo.required_travel_min,
              })}
            </T>
            {clashInfo.clash_fixture_name ? (
              <T size={13}>{t('officials.clash.other_fixture')}: <T weight="700">{clashInfo.clash_fixture_name}</T></T>
            ) : null}
          </View>
        )}
        {!isTravelGap && !isLocked && clashInfo?.clash_fixture_name ? (
          <T size={13}>{t('officials.clash.other_fixture')}: <T weight="700">{clashInfo.clash_fixture_name}</T></T>
        ) : null}
        {isOrganizer && (
          <View style={{ gap: 8 }}>
            <Field
              label={t('officials.clash.override_reason')}
              placeholder={t(isLocked ? 'officials.lock.unlock_reason_placeholder' : 'officials.clash.override_placeholder')}
              value={reason}
              onChange={setReason}
              multiline
              minHeight={80}
            />
            <Btn
              label={t(isLocked ? 'officials.lock.unlock_confirm' : 'officials.clash.confirm_override')}
              onPress={handleOverride}
              loading={busy}
              disabled={reason.trim().length < 10}
              color={c.pink}
            />
          </View>
        )}
      </View>
    </Sheet>
  );
}

// ─── Empty slot ───────────────────────────────────────────────────────────────
function EmptySlot({ roleVal, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Add ${ROLE_LABEL[roleVal] ?? roleVal}`}
      style={({ pressed }) => ({
        borderWidth: 1.5, borderStyle: 'dashed', borderColor: pressed ? c.pink : c.line,
        borderRadius: r.card / 2, padding: 8, alignItems: 'center', justifyContent: 'center',
        minHeight: 44, backgroundColor: pressed ? c.pinkSoft : 'transparent',
      })}
    >
      <T size={12} color={c.mute}>＋ {ROLE_SHORT[roleVal] ?? roleVal}</T>
    </Pressable>
  );
}

// ─── Suggest panel sheet ─────────────────────────────────────────────────────
function SuggestSheet({ fixtureId, roleVal, fixtureName, onInvite, onShortlist, onClose }) {
  const q = useLoad(() => api.get(`/fixtures/${fixtureId}/officials/suggest`, { role: roleVal }), [fixtureId, roleVal]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const handleInvite = async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      await onInvite(selected);
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  const handleShortlist = async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      await onShortlist(selected);
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  const scoreColor = (s) => s >= 80 ? c.lime : s >= 55 ? c.sun : c.red;

  return (
    <Sheet onClose={onClose} title={t('officials.board.suggest_title')} subtitle={`${ROLE_LABEL[roleVal] ?? roleVal} · ${fixtureName}`}>
      {q.loading ? <Loading /> : q.error ? <LoadError error={q.error} onRetry={q.reload} /> : (
        <View style={{ gap: 12 }}>
          {/* Official list */}
          {(q.data?.suggestions ?? []).length === 0 ? (
            <Empty icon="👤" label={t('officials.board.no_pool')} />
          ) : (
            (q.data.suggestions).map((s) => (
              <Pressable
                key={s.user_id}
                onPress={() => setSelected(s)}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected?.user_id === s.user_id }}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 12,
                  borderRadius: r.card, backgroundColor: selected?.user_id === s.user_id ? c.pinkSoft : c.paper,
                  borderWidth: 1.5, borderColor: selected?.user_id === s.user_id ? c.pink : c.line,
                  opacity: pressed ? 0.8 : 1, minHeight: 44,
                })}
              >
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.violet, alignItems: 'center', justifyContent: 'center' }}>
                  <T size={13} weight="800" color={c.on}>{(s.display_name ?? '').split(' ').map((w) => w[0]).join('').slice(0, 2)}</T>
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <T weight="700">{s.display_name}</T>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                    {s.grade_name ? <Chip label={s.grade_name} color={c.pinkSoft} small /> : null}
                    {s.dist_band && s.dist_band !== 'unknown' ? <Chip label={t(`oav.band.${s.dist_band}`)} color={c.cyanSoft} small /> : null}
                    {s.availability_state && s.availability_state !== 'unknown' ? <Chip label={t(`oav.state.${s.availability_state}`)} color={s.availability_state === 'available' ? c.mintSoft : s.availability_state === 'unavailable' ? c.redSoft : c.sunSoft} small /> : null}
                    {s.has_conflict ? <Chip label="⚠️ Neutrality" color={c.orangeSoft} small /> : <Chip label="Neutral ✓" color={c.mintSoft} small />}
                  </View>
                  <T size={11} color={c.mute} numberOfLines={3}>{s.explanation}</T>
                </View>
                <View style={{ alignItems: 'center', gap: 4 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: scoreColor(s.score), alignItems: 'center', justifyContent: 'center' }}>
                    <T size={13} weight="800" color="#fff">{s.score}</T>
                  </View>
                  <T size={10} color={c.mute}>/ 100</T>
                </View>
              </Pressable>
            ))
          )}

          {/* Score breakdown for selected */}
          {selected ? (
            <Card color={c.violetSoft}>
              <T size={13} weight="700" style={{ marginBottom: 8 }}>{t('officials.board.explain_why', { name: selected.display_name })}</T>
              {Object.entries(selected.reasons ?? {}).map(([key, r]) => (
                <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <T size={18}>{key === 'grade' ? '🎓' : key === 'travel' ? '📍' : key === 'neutral' ? '⚖️' : key === 'rotation' ? '🔄' : key === 'cost' ? '💰' : '📅'}</T>
                  <View style={{ flex: 1 }}>
                    <T size={12} weight="600">{r.label}</T>
                    <View style={{ height: 5, borderRadius: 3, backgroundColor: c.line, marginTop: 3, overflow: 'hidden' }}>
                      <View style={{ height: 5, width: `${Math.min(100, (r.score / 30) * 100)}%`, borderRadius: 3, backgroundColor: c.pink }} />
                    </View>
                  </View>
                  <T size={12} weight="800" color={c.pink}>+{r.score}</T>
                </View>
              ))}
            </Card>
          ) : null}

          {err ? <T size={13} color={c.red}>{err.message}</T> : null}

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn title={`✉️ ${t('officials.board.invite')}`} onPress={handleInvite} loading={busy} disabled={!selected} style={{ flex: 1, minHeight: 48 }} />
            <Btn title={`📋 ${t('officials.board.shortlist')}`} onPress={handleShortlist} loading={busy} disabled={!selected} color={c.paper} ink={c.ink} style={{ flex: 1, minHeight: 48 }} />
          </View>
          <Btn title={t('officials.board.manual_override')} onPress={onClose} color={c.paper} ink={c.mute} small />
        </View>
      )}
    </Sheet>
  );
}

// ─── Swap confirm sheet ───────────────────────────────────────────────────────
function SwapSheet({ fo, toFixture, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);

  const checkSwap = useCallback(async () => {
    setChecking(true);
    try {
      const res = await api.post(`/official-assignments/${fo.id}/swap`, { to_fixture_id: toFixture.id, dry_run: true });
      setPreview(res);
    } catch (e) {
      setPreview({ error: e.message });
    } finally { setChecking(false); }
  }, [fo, toFixture]);

  React.useEffect(() => { checkSwap(); }, []);

  const handleConfirm = async () => {
    setBusy(true); setErr(null);
    try {
      await onConfirm({ fo_id: fo.id, to_fixture_id: toFixture.id, override_reason: reason || undefined });
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const hasWarning = preview?.warnings?.length > 0;
  const hasError = preview?.error;

  return (
    <Sheet onClose={onClose} title={t('officials.board.swap_title')} subtitle={fo.display_name}>
      <View style={{ gap: 12 }}>
        {/* From / To */}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Card color={c.violetSoft} style={{ flex: 1, padding: 12 }}>
            <T size={11} color={c.mute} weight="700">{t('officials.board.from')}</T>
            <T weight="700" style={{ marginTop: 2 }}>{fo.fixture_name ?? fo.fixture_id.slice(0, 8)}</T>
            <T size={12} color={c.mute}>{ROLE_LABEL[fo.role]}</T>
          </Card>
          <T size={22}>⇄</T>
          <Card color={c.violetSoft} style={{ flex: 1, padding: 12 }}>
            <T size={11} color={c.mute} weight="700">{t('officials.board.to')}</T>
            <T weight="700" style={{ marginTop: 2 }}>{toFixture.name ?? toFixture.id.slice(0, 8)}</T>
            <T size={12} color={c.mute}>{ROLE_LABEL[fo.role]}</T>
          </Card>
        </View>

        {/* Conflict checks */}
        {checking ? <Loading small /> : preview ? (
          preview.error ? (
            <Card color={c.redSoft}>
              <T size={13} color={c.red}>⛔ {preview.error}</T>
            </Card>
          ) : (
            <View style={{ gap: 6 }}>
              {preview.checks?.map((chk, idx) => (
                <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 10, backgroundColor: chk.ok ? c.mintSoft : c.sunSoft }}>
                  <T size={16}>{chk.ok ? '✅' : '⚠️'}</T>
                  <T size={13} weight="600" color={chk.ok ? '#1a6b56' : '#7a4a00'}>{chk.message}</T>
                </View>
              ))}
            </View>
          )
        ) : null}

        {hasWarning ? (
          <Field
            label={t('officials.board.override_reason')}
            value={reason}
            onChangeText={setReason}
            placeholder={t('officials.board.override_reason_placeholder')}
            maxLength={500}
            multiline
          />
        ) : null}

        {err ? <T size={13} color={c.red}>{err}</T> : null}

        <Btn
          title={t('officials.board.confirm_swap')}
          onPress={handleConfirm}
          loading={busy}
          disabled={!!hasError || (hasWarning && reason.trim().length < 5)}
          style={{ minHeight: 48 }}
        />
      </View>
    </Sheet>
  );
}

// ─── Main Assignment Board screen ─────────────────────────────────────────────
export function AssignmentBoard({ event_id }) {
  const L = useLayout();
  const { push } = useNav();
  const [tab, setTab] = useState('board');
  const [uncoveredOnly, setUncoveredOnly] = useState(false);
  const [dayFilter, setDayFilter] = useState(null);
  const [selectedFos, setSelectedFos] = useState(new Set()); // bulk selected fixture_official ids (fixture ids for board)
  const [suggestCtx, setSuggestCtx] = useState(null); // { fixtureId, role, fixtureName }
  const [swapCtx, setSwapCtx] = useState(null); // { fo, toFixture }
  const [pendingSwapFo, setPendingSwapFo] = useState(null); // first leg of a drag-swap
  const [bulkBusy, setBulkBusy] = useState(false);
  const [clashSheet, setClashSheet] = useState(null); // { assignment, clashInfo }
  const { toast } = useSession();

  const q = useLoad(
    () => api.get(`/events/${event_id}/officials/board`, {
      ...(dayFilter ? { day: dayFilter } : {}),
      uncovered_only: uncoveredOnly,
    }),
    [event_id, dayFilter, uncoveredOnly]
  );
  const { reload } = q;

  const ev = q.data?.event;
  const stats = q.data?.stats ?? {};
  const fixtures = q.data?.fixtures ?? [];
  const coveragePct = stats.total ? Math.round(((stats.confirmed) / (stats.total * 4)) * 100) : 0;

  // Collect unique days for filter chips
  const days = useMemo(() => {
    const seen = new Set();
    for (const f of fixtures) {
      if (f.scheduled_at) seen.add(f.scheduled_at.slice(0, 10));
    }
    return [...seen].sort();
  }, [fixtures]);

  // All roles expected
  const roles = ['referee', 'umpire', 'linesman', 'scorer'];

  const handleInvite = useCallback(async ({ fixtureId, userId, roleVal, featureSource }) => {
    await api.post(`/fixtures/${fixtureId}/officials`, { user_id: userId, role: roleVal });
    reload();
  }, [reload]);

  const handleShortlist = useCallback(async ({ fixtureId, userId, roleVal }) => {
    await api.post(`/fixtures/${fixtureId}/officials/shortlist`, { user_id: userId, role: roleVal });
    reload();
  }, [reload]);

  const handleSwapConfirm = useCallback(async ({ fo_id, to_fixture_id, override_reason }) => {
    await api.post(`/official-assignments/${fo_id}/swap`, { to_fixture_id, override_reason });
    reload();
  }, [reload]);

  const handleBulkAutoSuggest = useCallback(async () => {
    if (selectedFos.size === 0) return;
    setBulkBusy(true);
    try {
      push('OfficialsBulkInvite', { event_id, fixture_ids: [...selectedFos], step: 'auto' });
    } finally { setBulkBusy(false); }
  }, [selectedFos, event_id, push]);

  const handleBulkInvite = useCallback(() => {
    if (selectedFos.size === 0) return;
    push('OfficialsBulkInvite', { event_id, fixture_ids: [...selectedFos] });
  }, [selectedFos, event_id, push]);

  const toggleSelect = (fixtureId) =>
    setSelectedFos((prev) => { const s = new Set(prev); s.has(fixtureId) ? s.delete(fixtureId) : s.add(fixtureId); return s; });

  const isWide = L.wide;

  if (q.loading && !q.data) return <Screen><Loading /></Screen>;
  if (q.error) return <Screen><LoadError error={q.error} onRetry={reload} /></Screen>;

  return (
    <Screen>
      {/* Hero */}
      <GradCard colors={grad.hero} style={{ margin: 16, marginBottom: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 16 }}>
          <View style={{ flex: 1 }}>
            <T size={20} weight="800" color={c.on} style={{ letterSpacing: -0.4 }}>
              {ev?.name ?? t('officials.board.title')}
            </T>
            <T size={13} color="rgba(255,255,255,0.8)" style={{ marginTop: 4 }}>
              {t('officials.board.subtitle', { count: stats.total ?? 0 })}
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {stats.confirmed > 0 ? <Chip label={`✅ ${stats.confirmed} confirmed`} color="rgba(255,255,255,0.18)" textColor={c.on} small /> : null}
              {stats.pending > 0 ? <Chip label={`⏳ ${stats.pending} pending`} color="rgba(255,255,255,0.18)" textColor={c.on} small /> : null}
              {stats.uncovered_slots > 0 ? <Chip label={`⚠️ ${stats.uncovered_slots} uncovered`} color="rgba(255,255,255,0.3)" textColor={c.on} small /> : null}
              {stats.conflicts > 0 ? <Chip label={`⚡ ${stats.conflicts} conflicts`} color="rgba(255,255,255,0.3)" textColor={c.on} small /> : null}
            </View>
          </View>
          <CoverageRing pct={coveragePct} size={60} />
        </View>
      </GradCard>

      {/* Tabs */}
      <View style={{ marginHorizontal: 16, marginTop: 16 }}>
        <Seg
          value={tab}
          options={[
            { value: 'board', label: t('officials.board.tab_board') },
            { value: 'by_official', label: t('officials.board.tab_by_official') },
            { value: 'shortlist', label: t('officials.board.tab_shortlist') },
          ]}
          onChange={setTab}
        />
      </View>

      {/* Filter bar */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, padding: 16, paddingBottom: 8 }}>
        <Pressable
          onPress={() => setUncoveredOnly((x) => !x)}
          accessibilityRole="checkbox" accessibilityState={{ checked: uncoveredOnly }}
          style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: uncoveredOnly ? c.pink : c.paper, borderWidth: 1.5, borderColor: uncoveredOnly ? c.pink : c.line, minHeight: 44, justifyContent: 'center' }}
        >
          <T size={12} weight="700" color={uncoveredOnly ? c.on : c.ink}>🔴 {t('officials.board.filter_uncovered')}</T>
        </Pressable>
        {days.map((d) => (
          <Pressable
            key={d}
            onPress={() => setDayFilter(dayFilter === d ? null : d)}
            accessibilityRole="radio" accessibilityState={{ checked: dayFilter === d }}
            style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: dayFilter === d ? c.violet : c.paper, borderWidth: 1.5, borderColor: dayFilter === d ? c.violet : c.line, minHeight: 44, justifyContent: 'center' }}
          >
            <T size={12} weight="700" color={dayFilter === d ? c.on : c.ink}>{new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</T>
          </Pressable>
        ))}
      </ScrollView>

      {/* Bulk action bar */}
      {selectedFos.size > 0 ? (
        <View style={{ marginHorizontal: 16, marginBottom: 10, borderRadius: r.card, backgroundColor: c.violet, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <T size={22} weight="800" color={c.on}>{selectedFos.size}</T>
          <T size={14} weight="600" color={c.on}>{t('officials.board.selected_fixtures')}</T>
          <View style={{ flex: 1 }} />
          <Btn title={`🤖 ${t('officials.board.auto_suggest')}`} onPress={handleBulkAutoSuggest} loading={bulkBusy} small color="rgba(255,255,255,0.18)" ink={c.on} style={{ minHeight: 44 }} />
          <Btn title={`📧 ${t('officials.board.bulk_invite')}`} onPress={handleBulkInvite} small color="rgba(255,255,255,0.18)" ink={c.on} style={{ minHeight: 44 }} />
          <Btn title="✕" onPress={() => setSelectedFos(new Set())} small color={c.red} ink={c.on} style={{ minHeight: 44 }} />
        </View>
      ) : null}

      {/* Board: scrollable horizontal grid */}
      <ScrollView style={{ flex: 1 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={true} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
          <View style={{ minWidth: isWide ? 900 : 680 }}>
            {/* Header row */}
            <View style={{ flexDirection: 'row', backgroundColor: c.violet, borderRadius: r.card, marginBottom: 6, overflow: 'hidden' }}>
              <View style={{ width: isWide ? 240 : 180, padding: 12 }}>
                <T size={11} weight="700" color={c.on} style={{ letterSpacing: 0.4 }}>{t('officials.board.fixture').toUpperCase()}</T>
              </View>
              {roles.map((rol) => (
                <View key={rol} style={{ flex: 1, minWidth: 130, padding: 12, borderLeftWidth: 1, borderLeftColor: 'rgba(255,255,255,0.1)' }}>
                  <T size={11} weight="700" color={c.on} style={{ letterSpacing: 0.4 }}>{ROLE_SHORT[rol]}</T>
                </View>
              ))}
              <View style={{ width: 70, padding: 12, borderLeftWidth: 1, borderLeftColor: 'rgba(255,255,255,0.1)', alignItems: 'center' }}>
                <T size={11} weight="700" color={c.on} style={{ letterSpacing: 0.4 }}>COV</T>
              </View>
            </View>

            {/* Fixture rows */}
            {fixtures.length === 0 ? (
              <Card><Empty icon="📋" label={t('officials.board.no_fixtures')} /></Card>
            ) : fixtures.map((f) => {
              const covCount = roles.reduce((s, rol) => s + ((f.crew?.[rol] ?? []).filter((o) => o.status === 'accepted').length > 0 ? 1 : 0), 0);
              const totalCov = roles.length;
              const covPct = Math.round((covCount / totalCov) * 100);
              const isSelected = selectedFos.has(f.id);

              return (
                <View
                  key={f.id}
                  style={{
                    flexDirection: 'row', backgroundColor: isSelected ? c.pinkSoft : c.paper,
                    borderRadius: r.card, marginBottom: 6, borderWidth: 1.5,
                    borderColor: isSelected ? c.pink : c.line, overflow: 'hidden',
                    minHeight: 70,
                  }}
                >
                  {/* Fixture info + checkbox */}
                  <Pressable
                    onPress={() => toggleSelect(f.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={`Select ${f.home_name ?? 'TBD'} vs ${f.away_name ?? 'TBD'}`}
                    style={{ width: isWide ? 240 : 180, padding: 12, justifyContent: 'center', borderRightWidth: 1, borderRightColor: c.line }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                      <View style={{ width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: isSelected ? c.pink : c.line, backgroundColor: isSelected ? c.pink : 'transparent', marginTop: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {isSelected ? <T size={12} color={c.on} weight="800">✓</T> : null}
                      </View>
                      <View style={{ flex: 1 }}>
                        <T size={13} weight="700" numberOfLines={1}>{f.round ? `${f.round} · ` : ''}{f.home_name ?? 'TBD'} v {f.away_name ?? 'TBD'}</T>
                        {f.scheduled_at ? (
                          <T size={11} color={c.mute}>{new Date(f.scheduled_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</T>
                        ) : null}
                        {f.resource_name ? <T size={11} color={c.mute}>📍 {f.venue_name ?? ''}{f.resource_name ? ` · ${f.resource_name}` : ''}</T> : null}
                        {/* Coverage status chip */}
                        {covCount === 0 ? <Chip label={`⚠️ ${t('officials.board.uncovered')}`} color={c.redSoft} textColor={c.red} small style={{ marginTop: 4 }} />
                          : covCount === totalCov ? <Chip label={`✅ ${t('officials.board.all_covered')}`} color={c.mintSoft} small style={{ marginTop: 4 }} />
                          : <Chip label={`⏳ ${covCount}/${totalCov}`} color={c.sunSoft} small style={{ marginTop: 4 }} />}
                      </View>
                    </View>
                  </Pressable>

                  {/* Role columns */}
                  {roles.map((rol) => {
                    const crew = f.crew?.[rol] ?? [];
                    const shortlisted = (f.shortlists ?? []).filter((sl) => sl.role === rol);
                    return (
                      <View key={rol} style={{ flex: 1, minWidth: 130, padding: 8, borderLeftWidth: 1, borderLeftColor: c.line, gap: 4 }}>
                        {crew.map((o) => (
                          <OfficialPill
                            key={o.id}
                            assignment={o}
                            hasConflict={o.neutrality_conflict || o.clash_type === 'travel_gap'}
                            isDragging={pendingSwapFo?.id === o.id}
                            onPress={() => {
                              if (o.neutrality_conflict || o.clash_type === 'travel_gap' || o.locked_at) {
                                // Show clash/lock detail sheet on tap when conflict or locked
                                setClashSheet({ assignment: o, clashInfo: o.clash_type ? { clash_type: o.clash_type, clash_fixture_id: o.clash_fixture_id, clash_fixture_name: o.clash_fixture_name, venue_distance_km: o.venue_distance_km, computed_gap_min: o.computed_gap_min, required_travel_min: o.required_travel_min } : null });
                              } else if (pendingSwapFo && pendingSwapFo.id !== o.id) {
                                // Second tap on a different pill triggers swap
                                setSwapCtx({ fo: pendingSwapFo, toFixture: f });
                                setPendingSwapFo(null);
                              } else {
                                // First tap: stage as swap source (or deselect)
                                setPendingSwapFo(pendingSwapFo?.id === o.id ? null : { ...o, fixture_name: `${f.home_name ?? 'TBD'} v ${f.away_name ?? 'TBD'}` });
                              }
                            }}
                          />
                        ))}
                        {shortlisted.map((sl) => (
                          <View key={sl.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 5, borderRadius: 8, backgroundColor: c.cyanSoft }}>
                            <T size={11}>📋</T>
                            <T size={11} numberOfLines={1} style={{ flex: 1 }}>{sl.display_name}</T>
                          </View>
                        ))}
                        {crew.filter((o) => ['invited','accepted'].includes(o.status)).length === 0 ? (
                          <EmptySlot
                            roleVal={rol}
                            onPress={() => setSuggestCtx({ fixtureId: f.id, roleVal: rol, fixtureName: `${f.home_name ?? 'TBD'} v ${f.away_name ?? 'TBD'}` })}
                          />
                        ) : null}
                      </View>
                    );
                  })}

                  {/* Coverage column */}
                  <View style={{ width: 70, padding: 8, borderLeftWidth: 1, borderLeftColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
                    <CoverageRing pct={covPct} size={44} />
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>

        {/* Swap hint */}
        {pendingSwapFo ? (
          <Card color={c.sunSoft} style={{ margin: 16, marginTop: 0 }}>
            <T size={13} weight="700">🔄 {t('officials.board.swap_hint', { name: pendingSwapFo.display_name })}</T>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('officials.board.swap_hint_sub')}</T>
            <Btn title={t('officials.board.cancel_swap')} onPress={() => setPendingSwapFo(null)} small color={c.paper} style={{ marginTop: 10, alignSelf: 'flex-start', minHeight: 44 }} />
          </Card>
        ) : null}

        <Card color={c.cyanSoft} style={{ margin: 16, marginTop: 0 }}>
          <T size={12} color={c.ink}>ℹ️ {t('officials.board.drag_hint')}</T>
        </Card>
      </ScrollView>

      {/* Suggest sheet */}
      {suggestCtx ? (
        <SuggestSheet
          fixtureId={suggestCtx.fixtureId}
          roleVal={suggestCtx.roleVal}
          fixtureName={suggestCtx.fixtureName}
          onInvite={({ user_id }) => handleInvite({ fixtureId: suggestCtx.fixtureId, userId: user_id, roleVal: suggestCtx.roleVal })}
          onShortlist={({ user_id }) => handleShortlist({ fixtureId: suggestCtx.fixtureId, userId: user_id, roleVal: suggestCtx.roleVal })}
          onClose={() => setSuggestCtx(null)}
        />
      ) : null}

      {/* Swap sheet */}
      {swapCtx ? (
        <SwapSheet
          fo={swapCtx.fo}
          toFixture={swapCtx.toFixture}
          onConfirm={handleSwapConfirm}
          onClose={() => setSwapCtx(null)}
        />
      ) : null}

      {/* Clash / lock detail sheet */}
      <ClashDetailSheet
        assignment={clashSheet?.assignment ?? null}
        clashInfo={clashSheet?.clashInfo ?? null}
        visible={!!clashSheet}
        onClose={() => setClashSheet(null)}
        isOrganizer
        onOverride={async (overrideReason) => {
          const fo = clashSheet?.assignment;
          if (!fo) return;
          if (fo.locked_at) {
            await api.post(`/official-assignments/${fo.id}/unlock`, { override_reason: overrideReason });
            toast(t('officials.lock.unlock_confirm') + ' — assignment unlocked');
          }
          await reload();
          setClashSheet(null);
        }}
      />
    </Screen>
  );
}

export default AssignmentBoard;
