// Officials Console — the pitch-side command centre for referees, umpires and scorers.
// Three sequential phases from one screen: pre-match checks → live scoring & control → post-match review.
// All backend calls go through the same offline-safe queue as MatchCentre; this is the officials UX layer, not a second scorer.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLiveFixture } from '../live';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, GradCard, Loading, Screen, Section, Sheet, T, Tag } from '../ui';
import { explain } from '../access';
import { c, grad } from '../theme';
import { t } from '../i18n';
import { tapped } from '../haptics';
import { CricketScorer } from './cricket-scorer';
import { useScoreQueue } from '../scorer/queue';
import { useSavedGame } from '../scorer/pack';
import { controlReject, localReject, project } from '../scorer/local';
import {
  AddedTimeBar, BattingOrderSheet, CardsPad, ConflictSheet, CorrectSheet,
  FootballExtras, OfflineBanner, OutcomePad, RacketPad, RulesPanel, ServerPick, SyncLine,
} from '../scorer/panels';
import { ROLE_LABEL } from './officials-home';
import { OfficialsPara } from './officials-para';

// ─── helpers ────────────────────────────────────────────────────────────────
const when = (iso, tz) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '';
const clockOf = (s) => s == null ? '' : `${Math.floor(s / 60)}′`;
const pctOf = (done, total) => total ? Math.round((done / total) * 100) : 0;

// ─── PHASE BADGE ────────────────────────────────────────────────────────────
function PhaseBadge({ status }) {
  if (status === 'live') return <Tag label={`● ${t('oc.live_badge')}`} color="#E11D48" style={{ paddingHorizontal: 10 }} />;
  if (status === 'paused') return <Tag label={`⏸ ${t('oc.paused_badge')}`} color={c.sunSoft} />;
  if (status === 'finished' || status === 'completed' || status === 'corrected' || status === 'provisional') return <Tag label={`⏹ ${t('oc.already_ended')}`} color={c.violetSoft} />;
  return <Tag label={t('oc.pre_match')} color={c.cyanSoft} />;
}

// ─── SCORE HEADER (sticky live strip) ───────────────────────────────────────
function ScoreHeader({ f, g, rs }) {
  const ph = g.phase ?? {};
  const score = g.score ?? {};
  const elapsed = f.started_at ? Math.max(0, Math.floor((Date.now() - new Date(f.started_at)) / 1000)) : null;

  // cricket: runs/wickets
  if (rs.kind === 'innings') {
    const inn = g.innings_state;
    return (
      <GradCard colors={grad.hero} style={{ gap: 10, padding: 20, borderRadius: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <PhaseBadge status={f.status} />
          {ph.period > 0 ? <Tag label={`Innings ${ph.period}`} color="rgba(255,255,255,.18)" /> : null}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View>
            <T weight="900" size={56} style={{ color: '#fff', letterSpacing: -2, lineHeight: 60 }}>
              {inn?.runs ?? score.home ?? 0}
              <T weight="700" size={28} style={{ color: 'rgba(255,255,255,.65)' }}>
                {inn?.wickets != null ? `/${inn.wickets}` : ''}
              </T>
            </T>
            <T size={14} style={{ color: 'rgba(255,255,255,.65)' }}>
              {inn ? `${inn.overs}.${inn.balls ?? 0} ov · RR ${inn.rr ?? '—'}` : ''}
            </T>
          </View>
          {inn?.target ? (
            <View style={{ alignItems: 'flex-end' }}>
              <T size={12} weight="700" style={{ color: 'rgba(255,255,255,.5)' }}>TARGET</T>
              <T weight="900" size={36} style={{ color: '#fff', letterSpacing: -1 }}>{inn.target}</T>
              <T size={12} style={{ color: 'rgba(255,255,255,.5)' }}>to win</T>
            </View>
          ) : null}
        </View>
        {inn?.striker || inn?.bowler ? (
          <View style={{ flexDirection: 'row', gap: 16, paddingTop: 10, borderTopWidth: 1, borderColor: 'rgba(255,255,255,.12)' }}>
            {inn.striker ? <View style={{ flex: 1 }}><T size={11} weight="700" style={{ color: 'rgba(255,255,255,.45)', letterSpacing: .5 }}>STRIKER</T><T size={14} weight="800" style={{ color: '#fff' }}>{inn.striker.name}</T><T size={11.5} style={{ color: 'rgba(255,255,255,.55)' }}>{inn.striker.runs}({inn.striker.balls})</T></View> : null}
            {inn.bowler ? <View style={{ flex: 1, borderLeftWidth: 1, borderColor: 'rgba(255,255,255,.12)', paddingLeft: 16 }}><T size={11} weight="700" style={{ color: 'rgba(255,255,255,.45)', letterSpacing: .5 }}>BOWLER</T><T size={14} weight="800" style={{ color: '#fff' }}>{inn.bowler.name}</T><T size={11.5} style={{ color: 'rgba(255,255,255,.55)' }}>{inn.bowler.overs}-{inn.bowler.runs}-{inn.bowler.wickets}</T></View> : null}
          </View>
        ) : null}
      </GradCard>
    );
  }

  // all other sports: home – away numerals
  const homeScore = score.home ?? 0;
  const awayScore = score.away ?? 0;
  return (
    <GradCard colors={grad.hero} style={{ gap: 10, padding: 20, borderRadius: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <PhaseBadge status={f.status} />
          {f.status === 'live' && elapsed != null ? (
            <View style={{ backgroundColor: 'rgba(255,255,255,.12)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 5 }}>
              <T weight="900" size={20} style={{ color: '#fff', letterSpacing: .5 }}>{clockOf(elapsed)}</T>
            </View>
          ) : null}
          {ph.period > 0 ? <T size={12} weight="700" style={{ color: 'rgba(255,255,255,.55)' }}>{ph.extra_time ? t('oc.extra_time') : ph.shootout_started ? t('oc.shootout') : `${t('oc.period')} ${ph.period}`}</T> : null}
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <T weight="800" size={13} numberOfLines={2} style={{ flex: 1, color: 'rgba(255,255,255,.75)' }}>{f.home?.name ?? 'Home'}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <T weight="900" size={64} style={{ color: '#fff', letterSpacing: -3, lineHeight: 68 }}>{homeScore}</T>
          <T weight="300" size={36} style={{ color: 'rgba(255,255,255,.4)' }}>–</T>
          <T weight="900" size={64} style={{ color: '#fff', letterSpacing: -3, lineHeight: 68 }}>{awayScore}</T>
        </View>
        <T weight="800" size={13} numberOfLines={2} style={{ flex: 1, textAlign: 'right', color: 'rgba(255,255,255,.75)' }}>{f.away?.name ?? 'Away'}</T>
      </View>
      {score.shootout ? (
        <T size={12} weight="700" style={{ color: 'rgba(255,255,255,.55)', textAlign: 'center' }}>
          Shoot-out: {score.shootout.home}–{score.shootout.away}
        </T>
      ) : null}
    </GradCard>
  );
}

// ─── CONTROL STRIP ──────────────────────────────────────────────────────────
function ControlStrip({ f, ph, canScore, onControl, onInjury, busy }) {
  const live = f.status === 'live';
  const paused = f.status === 'paused';
  const scheduled = f.status === 'scheduled';
  const finished = ['finished', 'completed', 'provisional', 'corrected', 'cancelled'].includes(f.status);

  const btn = (icon, label, onPress, style) => (
    <Pressable
      onPress={tapped(onPress)}
      disabled={!onPress || busy}
      accessibilityLabel={label}
      style={({ pressed }) => [{
        flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 14, padding: 10, minHeight: 68,
        backgroundColor: c.paper, borderWidth: 1.5, borderColor: c.line, opacity: pressed ? 0.65 : 1, ...style,
      }]}
    >
      <T size={22}>{icon}</T>
      <T size={10.5} weight="800" color={style?.color ?? c.mute} style={{ textAlign: 'center' }}>{label}</T>
    </Pressable>
  );

  if (scheduled) return canScore ? (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {btn('🏁', t('oc.start_period'), () => onControl('start'), { backgroundColor: c.pink, borderColor: c.pink, color: '#fff' })}
    </View>
  ) : null;

  if (live) return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {btn('⏸', t('oc.pause_match'), () => onControl('pause'), { backgroundColor: c.sunSoft, borderColor: '#FDE68A', color: c.sun })}
      {ph?.period_open && ph.period < (ph.max_periods ?? 2) ? btn('▶▶', t('oc.next_period'), () => onControl('next_period'), {}) : null}
      {btn('🩹', t('oc.injury_stop'), onInjury, {})}
      {btn('⏹', t('oc.end_match'), () => onControl('end'), { backgroundColor: c.redSoft, borderColor: '#FFBAC8', color: c.red })}
    </View>
  );

  if (paused) return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {btn('▶', t('oc.resume_match'), () => onControl('resume'), { backgroundColor: c.mint, borderColor: c.mint, color: '#fff' })}
      {btn('⏹', t('oc.end_match'), () => onControl('end'), { backgroundColor: c.redSoft, borderColor: '#FFBAC8', color: c.red })}
    </View>
  );

  return null;
}

// ─── FOOTBALL / GENERIC ACTION ZONE ─────────────────────────────────────────
function FootballZone({ names, canScore, canCorrect, log, g, rs, who, setWho, queue, toast }) {
  const ph = g.phase ?? {};
  const live = g.fixture.status === 'live';
  const canPoint = live && ph.can_score;

  const bigBtn = (icon, label, side, kind, extra = {}, style = {}) => (
    <Pressable
      key={`${kind}-${side}`}
      onPress={tapped(() => log(kind, side, extra))}
      disabled={!canScore || !canPoint}
      accessibilityLabel={`${label} ${side === 'home' ? names.home : names.away}`}
      style={({ pressed }) => [{
        flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 14, padding: 14, minHeight: 72,
        backgroundColor: side === 'home' ? c.pink : c.paper, borderWidth: side === 'away' ? 1.5 : 0, borderColor: c.line,
        opacity: pressed ? 0.65 : (canScore && canPoint ? 1 : 0.4), ...style,
      }]}
    >
      <T size={20}>{icon}</T>
      <T size={15} weight="800" style={{ color: side === 'home' ? '#fff' : c.ink, textAlign: 'center' }}>{label}</T>
      <T size={11} weight="700" style={{ color: side === 'home' ? 'rgba(255,255,255,.65)' : c.mute, textAlign: 'center' }} numberOfLines={1}>{side === 'home' ? names.home : names.away}</T>
    </Pressable>
  );

  const smBtn = (icon, label, side, kind, style = {}) => (
    <Pressable
      key={`sm-${kind}-${side}`}
      onPress={tapped(() => log(kind, side))}
      disabled={!canScore || !canPoint}
      accessibilityLabel={`${label} ${side === 'home' ? names.home : names.away}`}
      style={({ pressed }) => [{
        flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 12, padding: 10, minHeight: 60,
        backgroundColor: c.paper, borderWidth: 1.5, borderColor: c.line,
        opacity: pressed ? 0.65 : (canScore && canPoint ? 1 : 0.45), ...style,
      }]}
    >
      <T size={17}>{icon}</T>
      <T size={11} weight="800" style={{ color: style.color ?? c.ink, textAlign: 'center' }}>{label}</T>
    </Pressable>
  );

  // Find goal / card / foul events from ruleset
  const goalKind = rs.events?.find((e) => ['goal', 'score', 'try', 'basket', 'point'].includes(e.kind))?.kind ?? 'goal';
  const hasCards = rs.events?.some((e) => ['yellow_card', 'red_card', 'foul'].includes(e.kind));
  const hasSub = rs.events?.some((e) => e.kind === 'substitution');

  return (
    <View style={{ gap: 8 }}>
      {/* Goal row */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {bigBtn('⚽', rs.events?.find((e) => e.kind === goalKind)?.label ?? 'Goal', 'home', goalKind)}
        {bigBtn('⚽', rs.events?.find((e) => e.kind === goalKind)?.label ?? 'Goal', 'away', goalKind)}
      </View>
      {/* Cards + fouls + sub row */}
      {hasCards ? (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {smBtn('🟨', 'Yellow', 'home', 'yellow_card', { backgroundColor: '#FEF9C3', borderColor: '#FDE68A' })}
          {smBtn('🟥', 'Red', 'home', 'red_card', { backgroundColor: c.redSoft, borderColor: '#FFBAC8', color: c.red })}
          {smBtn('🟨', 'Yellow', 'away', 'yellow_card', { backgroundColor: '#FEF9C3', borderColor: '#FDE68A' })}
          {smBtn('🟥', 'Red', 'away', 'red_card', { backgroundColor: c.redSoft, borderColor: '#FFBAC8', color: c.red })}
        </View>
      ) : null}
      {/* Foul / sub / corner row */}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {rs.events?.find((e) => e.kind === 'foul') ? smBtn('🦵', 'Foul Home', 'home', 'foul', { backgroundColor: c.sunSoft, borderColor: '#FDE68A' }) : null}
        {rs.events?.find((e) => e.kind === 'foul') ? smBtn('🦵', 'Foul Away', 'away', 'foul', { backgroundColor: c.sunSoft, borderColor: '#FDE68A' }) : null}
        {hasSub ? smBtn('🔁', 'Sub', 'home', 'substitution', { backgroundColor: c.cyanSoft, borderColor: '#BAE6FD' }) : null}
        {hasSub ? smBtn('🔁', 'Sub', 'away', 'substitution', { backgroundColor: c.cyanSoft, borderColor: '#BAE6FD' }) : null}
      </View>
      {/* Operational events */}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {rs.events?.find((e) => e.kind === 'corner') ? smBtn('↩', 'Corner H', 'home', 'corner') : null}
        {rs.events?.find((e) => e.kind === 'corner') ? smBtn('↩', 'Corner A', 'away', 'corner') : null}
        {rs.events?.find((e) => e.kind === 'offside') ? smBtn('🏃', 'Offside H', 'home', 'offside') : null}
        {rs.events?.find((e) => e.kind === 'offside') ? smBtn('🏃', 'Offside A', 'away', 'offside') : null}
      </View>
      {/* Football extras (extra time, shoot-out) */}
      <FootballExtras g={g} rs={rs} queue={queue} toast={toast} names={names} />
    </View>
  );
}

// ─── GENERIC FALLBACK ACTION ZONE ───────────────────────────────────────────
function GenericZone({ rs, names, log, canScore, g }) {
  const live = g.fixture.status === 'live';
  const ph = g.phase ?? {};
  const canPoint = live && ph.can_score;
  const events = (rs.events ?? []).filter((e) => !['period_start', 'period_end', 'note', 'added_time', 'lineup', 'result'].includes(e.kind));
  if (!events.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {['home', 'away'].flatMap((side) =>
        events.map((ev) => (
          <Pressable
            key={`${ev.kind}-${side}`}
            onPress={tapped(() => log(ev.kind, side))}
            disabled={!canScore || !canPoint}
            accessibilityLabel={`${ev.label} ${side === 'home' ? names.home : names.away}`}
            style={({ pressed }) => [{
              flexBasis: 'calc(50% - 4px)', flex: 1, minWidth: 120, alignItems: 'center', justifyContent: 'center', gap: 4,
              borderRadius: 12, padding: 12, minHeight: 64, backgroundColor: c.paper, borderWidth: 1.5, borderColor: c.line,
              opacity: pressed ? 0.65 : (canScore && canPoint ? 1 : 0.4),
            }]}
          >
            <T size={13.5} weight="800" style={{ textAlign: 'center' }}>{ev.label}</T>
            <T size={11} weight="700" color={c.mute} style={{ textAlign: 'center' }}>{side === 'home' ? names.home : names.away}</T>
          </Pressable>
        ))
      )}
    </View>
  );
}

// ─── TIMELINE ROW ────────────────────────────────────────────────────────────
function TimelineRow({ ev, canScore, finished, onUndo, label }) {
  const icon = {
    goal: '⚽', try: '🏉', basket: '🏀', score: '⚽',
    yellow_card: '🟨', red_card: '🟥', foul: '🦵',
    substitution: '🔁', injury: '🩹', note: '📝',
    period_start: '▶', period_end: '⏹',
  }[ev.kind] ?? '•';
  const bg = {
    yellow_card: '#FEF9C3', red_card: c.redSoft, substitution: c.cyanSoft,
    injury: c.sunSoft, period_start: c.cyanSoft, period_end: c.violetSoft,
  }[ev.kind] ?? c.pinkSoft;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
      <T size={12} weight="800" color={c.mute} style={{ minWidth: 32, marginTop: 2 }}>{clockOf(ev.clock_seconds)}</T>
      <View style={{ width: 28, height: 28, borderRadius: 999, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <T size={13}>{icon}</T>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T size={13.5} weight="700" style={{ ...(ev.voided_at ? { textDecorationLine: 'line-through', opacity: .5 } : {}) }}>{label(ev.kind)}{ev.player_name ? ` · ${ev.player_name}` : ''}</T>
        {ev.side ? <T size={12} color={c.mute}>{ev.side === 'home' ? 'Home' : 'Away'}</T> : null}
      </View>
      {!ev.voided_at && canScore && !finished ? (
        <Pressable onPress={tapped(onUndo)} accessibilityLabel={`Undo ${label(ev.kind)}`} style={({ pressed }) => [{ backgroundColor: c.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, opacity: pressed ? 0.65 : 1 }]}>
          <T size={12} color={c.mute}>{t('oc.undo')}</T>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── PRE-MATCH CHECKLIST ─────────────────────────────────────────────────────
function ChecklistSection({ briefing, onCheck, canScore }) {
  const items = briefing?.checklist ?? [];
  const done = items.filter((x) => x.checked_at).length;
  const pct = pctOf(done, items.length);
  return (
    <Section title={`${t('oc.checklist')} (${done} / ${items.length})`} color={c.cyan}>
      <Card pad={14}>
        {items.length ? (
          <>
            <View style={{ height: 4, backgroundColor: c.line, borderRadius: 999, marginBottom: 12, overflow: 'hidden' }}>
              <View style={{ height: 4, width: `${pct}%`, backgroundColor: c.mint, borderRadius: 999 }} />
            </View>
            {items.map((item) => (
              <Pressable
                key={item.key}
                onPress={tapped(() => canScore && onCheck(item.key, !item.checked_at))}
                disabled={!canScore}
                accessibilityLabel={item.label}
                accessibilityState={{ checked: !!item.checked_at }}
                style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderColor: c.line, opacity: pressed ? 0.65 : 1 }]}
              >
                <View style={{ width: 26, height: 26, borderRadius: 8, borderWidth: item.checked_at ? 0 : 2, borderColor: c.line, backgroundColor: item.checked_at ? c.mint : 'transparent', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {item.checked_at ? <T size={14} style={{ color: '#fff' }}>✓</T> : null}
                </View>
                <T size={15} weight="600" color={item.checked_at ? c.mute : c.ink} style={{ flex: 1, ...(item.checked_at ? { textDecorationLine: 'line-through' } : {}) }}>{item.label}</T>
              </Pressable>
            ))}
          </>
        ) : <T size={14} color={c.mute}>No checklist configured for this event.</T>}
      </Card>
    </Section>
  );
}

// ─── CREW STRIP ──────────────────────────────────────────────────────────────
function CrewStrip({ crew }) {
  if (!crew?.length) return null;
  return (
    <Section title={t('oc.crew')} color={c.violet}>
      <Card pad={14}>
        {crew.map((m, i) => (
          <View key={m.user_id ?? i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: i < crew.length - 1 ? 1 : 0, borderColor: c.line }}>
            <View style={{ width: 36, height: 36, borderRadius: 999, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <T size={16}>👤</T>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T size={14} weight="700">{m.name ?? 'Unknown'}{m.is_self ? ' (You)' : ''}</T>
              <T size={12} color={c.mute}>{ROLE_LABEL[m.role] ?? m.role}</T>
            </View>
            <Tag label={m.verified ? `✅ ${t('oc.verified')}` : `⏳ ${t('oc.pending')}`} color={m.verified ? c.mintSoft : c.sunSoft} />
          </View>
        ))}
      </Card>
    </Section>
  );
}

// ─── INJURY SHEET ────────────────────────────────────────────────────────────
const INJURY_REASONS = ['Injury attended (non-clinical)', 'Equipment check', 'Field/court inspection', 'Player disturbance', 'Weather assessment', 'Other operational stoppage'];

function InjurySheet({ open, onClose, onConfirm }) {
  const [reason, setReason] = useState(INJURY_REASONS[0]);
  if (!open) return null;
  return (
    <Sheet open onClose={onClose} title={t('oc.injury_stop')}>
      <View style={{ gap: 10, padding: 16 }}>
        <T size={13} color={c.mute}>Operational stop only — no clinical or medical detail is ever recorded. Select the closest reason.</T>
        {INJURY_REASONS.map((r) => (
          <Pressable key={r} onPress={tapped(() => setReason(r))} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 12, backgroundColor: reason === r ? c.pinkSoft : c.paper, borderWidth: 1.5, borderColor: reason === r ? c.pink : c.line, opacity: pressed ? 0.65 : 1 }]}>
            <View style={{ width: 20, height: 20, borderRadius: 999, borderWidth: 2, borderColor: reason === r ? c.pink : c.line, backgroundColor: reason === r ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {reason === r ? <T size={10} style={{ color: '#fff' }}>✓</T> : null}
            </View>
            <T size={14} weight={reason === r ? '700' : '400'}>{r}</T>
          </Pressable>
        ))}
        <Btn title={t('oc.pause_match')} onPress={() => { onConfirm(reason); onClose(); }} style={{ minHeight: 56, marginTop: 8 }} />
      </View>
    </Sheet>
  );
}

// ─── CONFIRM SHEET ───────────────────────────────────────────────────────────
function ConfirmSheet({ open, title, body, confirmLabel, danger, onClose, onConfirm }) {
  if (!open) return null;
  return (
    <Sheet open onClose={onClose} title={title}>
      <View style={{ gap: 14, padding: 16 }}>
        <T size={14} color={c.mute}>{body}</T>
        <Btn title={confirmLabel} onPress={() => { onConfirm(); onClose(); }} color={danger ? c.red : c.pink} style={{ minHeight: 56 }} />
        <Btn title={t('common.cancel')} onPress={onClose} color={c.paper} ink={c.ink} style={{ minHeight: 48 }} />
      </View>
    </Sheet>
  );
}

// ─── UNDO SHEET ───────────────────────────────────────────────────────────────
function UndoSheet({ open, onClose, onConfirm }) {
  const reasons = ['Entered for wrong team', 'Incorrect event type', 'Player mis-identified', 'Duplicated entry', 'Other'];
  const [reason, setReason] = useState(reasons[0]);
  if (!open) return null;
  return (
    <Sheet open onClose={onClose} title={t('oc.undo')}>
      <View style={{ gap: 10, padding: 16 }}>
        <T size={13} color={c.mute}>This creates an audited correction in the match log. The entry is not deleted; it is marked voided with this reason.</T>
        {reasons.map((r) => (
          <Pressable key={r} onPress={tapped(() => setReason(r))} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, backgroundColor: reason === r ? c.pinkSoft : c.paper, borderWidth: 1.5, borderColor: reason === r ? c.pink : c.line, opacity: pressed ? 0.65 : 1 }]}>
            <View style={{ width: 18, height: 18, borderRadius: 999, borderWidth: 2, borderColor: reason === r ? c.pink : c.line, backgroundColor: reason === r ? c.pink : 'transparent' }} />
            <T size={13.5} weight={reason === r ? '700' : '400'}>{r}</T>
          </Pressable>
        ))}
        <Btn title="Confirm undo" onPress={() => { onConfirm(reason); onClose(); }} color={c.pink} style={{ minHeight: 56, marginTop: 8 }} />
      </View>
    </Sheet>
  );
}

// ─── POST-MATCH REVIEW ───────────────────────────────────────────────────────
function PostMatchReview({ g, f, canScore, go, id, queue }) {
  const { toast } = useSession();
  const events = (g.events ?? []).filter((e) => !['period_start', 'period_end', 'note'].includes(e.kind));
  const score = g.score ?? {};
  const hasRedCard = events.some((e) => e.kind === 'red_card' && !e.voided_at);

  return (
    <View style={{ gap: 14 }}>
      {/* Final score */}
      <GradCard colors={['#2A2D3A', '#3B3F51']} style={{ gap: 12, padding: 20, borderRadius: 20 }}>
        <View style={{ alignItems: 'center', gap: 4 }}>
          <Tag label={`⏹ ${t('oc.already_ended').toUpperCase()}`} color="rgba(255,255,255,.12)" />
          <T size={13} weight="700" style={{ color: 'rgba(255,255,255,.55)', marginTop: 4 }}>
            {f.event_name}{f.round ? ` · ${f.round}` : ''}
          </T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
          <View style={{ alignItems: 'center' }}>
            <T size={12} weight="700" style={{ color: 'rgba(255,255,255,.5)', marginBottom: 4 }}>{f.home?.name ?? 'Home'}</T>
            <T weight="900" size={64} style={{ color: '#fff', letterSpacing: -3 }}>{score.home ?? 0}</T>
          </View>
          <T weight="300" size={36} style={{ color: 'rgba(255,255,255,.35)' }}>–</T>
          <View style={{ alignItems: 'center' }}>
            <T size={12} weight="700" style={{ color: 'rgba(255,255,255,.5)', marginBottom: 4 }}>{f.away?.name ?? 'Away'}</T>
            <T weight="900" size={64} style={{ color: '#fff', letterSpacing: -3 }}>{score.away ?? 0}</T>
          </View>
        </View>
        <T size={11.5} style={{ color: 'rgba(255,255,255,.4)', textAlign: 'center' }}>Computed from match log · pinned ruleset</T>
      </GradCard>

      {/* Events to review */}
      <Section title={t('oc.review')} color={c.violet}>
        <Card pad={14}>
          <T size={13} weight="700" color={c.mute} style={{ marginBottom: 10 }}>{events.filter((e) => !e.voided_at).length} events logged · review before sign-off</T>
          {events.slice(-8).reverse().map((ev) => (
            <View key={ev.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.line }}>
              <T size={12} weight="800" color={c.mute}>{clockOf(ev.clock_seconds)}</T>
              <T size={13.5} weight={ev.voided_at ? '400' : '700'} color={ev.voided_at ? c.mute : c.ink} style={{ flex: 1, ...(ev.voided_at ? { textDecorationLine: 'line-through' } : {}) }}>
                {ev.kind.replace(/_/g, ' ')}{ev.player_name ? ` · ${ev.player_name}` : ''}{ev.side ? ` · ${ev.side}` : ''}
              </T>
              {ev.voided_at ? <Tag label="Voided" color={c.violetSoft} /> : (
                canScore ? (
                  <Pressable onPress={tapped(() => {})} style={({ pressed }) => [{ backgroundColor: c.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, opacity: pressed ? 0.65 : 1 }]}>
                    <T size={12} color={c.mute}>Correct</T>
                  </Pressable>
                ) : null
              )}
            </View>
          ))}
        </Card>
      </Section>

      {/* Report suggestion */}
      {hasRedCard ? (
        <Section title="Official report" color={c.sun}>
          <Card pad={14} style={{ gap: 10 }}>
            <T size={14} weight="700">🟥 Red card logged — misconduct report suggested</T>
            <T size={12.5} color={c.mute}>Operational facts only. No clinical or personal detail is ever recorded.</T>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="📝 File report" onPress={() => go('OfficialMatch', { id, report: true })} style={{ flex: 1, minHeight: 48 }} />
              <Btn title="Skip" color={c.paper} ink={c.ink} onPress={() => {}} style={{ flex: 1, minHeight: 48 }} />
            </View>
          </Card>
        </Section>
      ) : null}

      {/* Sign-off */}
      <Btn
        title="✍️ Open score sheet & sign off"
        onPress={() => go('ScoreSheet', { id })}
        color={c.violet}
        style={{ minHeight: 64 }}
        accessibilityLabel="Open score sheet and sign off"
      />
      <T size={12} color={c.mute} style={{ textAlign: 'center' }}>
        The result is not official until the score sheet is approved and published by the event organiser.
      </T>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
export function OfficialsConsole({ id }) {
  const { toast, user } = useSession();
  const { push: go } = useNav();
  const L = useLayout();
  const feed = useLiveFixture(id);
  const { push: pushState } = feed;
  const pack = useSavedGame(user?.id, id, feed.state);
  const briefing = useLoad(() => api.get(`/fixtures/${id}/briefing`), [id]);
  const [busy, setBusy] = useState(false);
  const [undoTarget, setUndoTarget] = useState(null);
  const [injuryOpen, setInjuryOpen] = useState(false);
  const [confirm, setConfirm] = useState(null); // { op, title, body, label, danger }
  const [who, setWho] = useState({ home: null, away: null });
  const [showRules, setShowRules] = useState(false);
  const seen = useRef(0);

  const queue = useScoreQueue(`sa_queue_fx_${id}`,
    async ({ owner, op, target, ...e }) => {
      if (op === 'void') {
        const r = await api.post(`/match-events/${target}/void`, { reason: e.reason, client_key: e.client_key });
        pushState(r);
        return r;
      }
      if (op === 'correct') {
        const r = await api.post(`/match-events/${target}/correct`, { reason: e.reason, client_key: e.client_key, ...(e.kind ? { kind: e.kind } : {}), ...(e.side ? { side: e.side } : {}) });
        pushState(r.state);
        return r;
      }
      if (op) {
        const r = await api.post(`/fixtures/${id}/${op}`, { client_key: e.client_key, occurred_at: e.occurred_at });
        if (r?.fixture) pushState(r);
        return r;
      }
      const r = await api.post(`/fixtures/${id}/events`, e);
      seen.current = Math.max(seen.current, r.state.last_seq);
      pushState(r.state);
      return r;
    },
    { onDrop: (err) => toast('' + err.message), owner: user?.id }
  );

  const offline = !feed.state || (!!feed.error && !feed.error?.status);
  const useSaved = !!pack.saved && (offline || queue.pending.length > 0) && pack.saved.last_seq >= (feed.state?.last_seq ?? 0);
  const g = useMemo(() => (useSaved ? project(pack.saved, queue.pending) : feed.state), [useSaved, pack.saved, queue.pending, feed.state]);

  if (!g) return (
    <Screen>
      {feed.error && pack.ready
        ? <Card pad={16} color={c.sunSoft}><T size={14} weight="800">No connection — game not saved on this device.</T><T size={13} color={c.mute} style={{ marginTop: 4, marginBottom: 12 }}>Open it online once to save it. Officials can save today's games from Officials home.</T><Btn title="Try again" onPress={feed.refresh} /></Card>
        : <Loading />}
    </Screen>
  );

  const f = g.fixture;
  const rs = g.ruleset;
  const ph = g.phase ?? {};
  const v = g.viewer ?? {};
  const names = { home: f.home?.name ?? 'Home', away: f.away?.name ?? 'Away' };
  const canScore = !!v.can_score && !feed.revoked;
  const finished = ['finished', 'completed', 'provisional', 'corrected', 'cancelled'].includes(f.status);
  const isLiveOrPaused = f.status === 'live' || f.status === 'paused';
  const isPreMatch = f.status === 'scheduled';

  const run = async (fn) => { setBusy(true); try { return await fn(); } catch (x) { toast('' + x.message); return null; } finally { setBusy(false); } };

  const control = (op) => run(async () => {
    const bad = controlReject(g, op);
    if (bad) { toast(bad); return false; }
    const r = await queue.enqueue({ op, occurred_at: new Date().toISOString() });
    if (r?.queued && !r.full) toast(t('oc.sync_pending'));
    return !r?.queued;
  });

  const confirmControl = (op) => {
    const map = {
      end: { title: t('oc.end_confirm'), body: t('oc.end_confirm_msg'), label: t('oc.end_confirm_yes'), danger: true },
      start: { title: t('oc.start_confirm'), body: t('oc.start_confirm_msg'), label: t('oc.start_confirm_yes'), danger: false },
    };
    const cfg = map[op];
    if (cfg) setConfirm({ op, ...cfg });
    else control(op);
  };

  const log = async (kind, side, extra = {}) => {
    if (!canScore) { toast('You do not have scoring permission for this match.'); return false; }
    const elapsed = f.started_at ? Math.max(0, Math.floor((Date.now() - new Date(f.started_at)) / 1000)) : undefined;
    const pid = side ? who[side] : null;
    if (useSaved) {
      const bad = localReject(g, { kind, side, period: extra.period, payload: extra.payload, player_id: pid });
      if (bad) { toast(bad); return false; }
    }
    const r = await queue.enqueue({ kind, ...(side ? { side } : {}), ...(extra.period ? { period: extra.period } : {}), ...(extra.payload ? { payload: extra.payload } : {}), ...(pid ? { player_id: pid } : {}), clock_seconds: elapsed, expected_seq: seen.current });
    if (pid && side) setWho((w) => ({ ...w, [side]: null }));
    if (r?.queued && !r.full) toast(t('oc.sync_pending'));
    return !r?.queued;
  };

  const handleUndo = async (reason) => {
    if (!undoTarget) return;
    await queue.enqueue({ op: 'void', target: undoTarget.id, reason, client_key: `void-${undoTarget.id}-${Date.now()}` });
    setUndoTarget(null);
  };

  const handleCheck = async (key, checked) => {
    await api.post(`/fixtures/${id}/briefing/checks`, { key, checked }).catch((e) => toast(explain(e)));
    briefing.reload();
  };

  const handleInjury = async (reason) => {
    await control('pause');
    await log('note', null, { payload: { text: reason, clinical: false } });
  };

  const label = (kind) => [...(rs.events ?? []), ...(rs.stats ?? [])].find((x) => x.kind === kind)?.label
    ?? ({ point: 'Point', ball: 'Ball', server: 'Server set', retire: 'Retirement', walkover: 'Walkover', shootout_goal: 'Shoot-out: scored', shootout_miss: 'Shoot-out: missed', lineup: 'Batting order', innings_end: 'Innings ended', declare: 'Declared', period_start: 'Period started', period_end: 'Period ended', added_time: 'Added time', round_card: 'Round card', result: 'Result', yellow_card: 'Yellow card', red_card: 'Red card', foul: 'Foul', substitution: 'Substitution', goal: 'Goal', corner: 'Corner', offside: 'Offside', injury: 'Injury stop' }[kind] ?? kind.replace(/_/g, ' '));

  const events = g.events ?? [];
  const recentEvents = [...events].reverse().slice(0, 12);

  // ── Crew from briefing ──
  const crew = briefing.data?.crew ?? [];
  const b = briefing.data;

  // ── Sport action zone ──
  const sportZone = (() => {
    if (!isLiveOrPaused) return null;
    if (rs.kind === 'innings') return <CricketScorer g={g} rs={rs} queue={queue} pack={pack} names={names} who={who} setWho={setWho} log={log} toast={toast} label={label} />;
    if (rs.kind === 'sets') return <RacketPad g={g} rs={rs} names={names} log={log} canScore={canScore} />;
    if (rs.kind === 'outcomes') return <OutcomePad g={g} rs={rs} names={names} log={log} canScore={canScore} />;
    // points_events covers football, futsal, hockey, basketball, volleyball, rugby — most common
    if (rs.kind === 'points_events' || rs.events?.some((e) => ['goal', 'try', 'basket', 'yellow_card'].includes(e.kind))) {
      return <FootballZone names={names} canScore={canScore} canCorrect={canScore} log={log} g={g} rs={rs} who={who} setWho={setWho} queue={queue} toast={toast} />;
    }
    return <GenericZone rs={rs} names={names} log={log} canScore={canScore} g={g} />;
  })();

  // ── Added time bar ──
  const addedTime = isLiveOrPaused && (rs.events ?? []).some((e) => e.kind === 'added_time')
    ? <AddedTimeBar g={g} rs={rs} queue={queue} toast={toast} names={names} />
    : null;

  // ── Cards pad (if separate from football zone) ──
  const cards = isLiveOrPaused && (rs.events ?? []).some((e) => ['yellow_card', 'red_card'].includes(e.kind)) && rs.kind !== 'points_events'
    ? <CardsPad g={g} rs={rs} names={names} log={log} canScore={canScore} />
    : null;

  // ── Batting order ──
  const [orderSide, setOrderSide] = useState(null);
  const battingOrder = rs.kind === 'innings' ? <BattingOrderSheet side={orderSide} g={g} onClose={() => setOrderSide(null)} queue={queue} toast={toast} /> : null;

  // ── Server pick (racket sports) ──
  const serverPick = rs.kind === 'sets' ? <ServerPick g={g} rs={rs} names={names} log={log} canScore={canScore} /> : null;

  // ── Rules panel ──
  const rulesPanel = showRules ? <RulesPanel fixtureId={id} onClose={() => setShowRules(false)} /> : null;

  // ── Match meta card ──
  const matchMeta = b ? (
    <Section title={t('oc.briefing')} color={c.pink}>
      <Card pad={14} style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={rs.label ?? rs.kind} color={c.violetSoft} />
          {f.event_name ? <Tag label={f.event_name} color={c.cyanSoft} /> : null}
          {f.round ? <Tag label={f.round} color={c.cyanSoft} /> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <View style={{ flex: 1, borderRightWidth: 1, borderColor: c.line, paddingRight: 16, gap: 2 }}>
            <T size={11} weight="700" color={c.mute} style={{ letterSpacing: .5, textTransform: 'uppercase' }}>Home</T>
            <T size={18} weight="800">{names.home}</T>
            <T size={12} color={c.mute}>{b.lineups?.home?.length ?? 0} declared</T>
          </View>
          <View style={{ flex: 1, paddingLeft: 16, gap: 2 }}>
            <T size={11} weight="700" color={c.mute} style={{ letterSpacing: .5, textTransform: 'uppercase' }}>Away</T>
            <T size={18} weight="800">{names.away}</T>
            <T size={12} color={c.mute}>{b.lineups?.away?.length ?? 0} declared</T>
          </View>
        </View>
        {f.resource_name || f.venue_name ? <T size={13} color={c.mute}>📍 {[f.resource_name, f.venue_name].filter(Boolean).join(' · ')}</T> : null}
        {b.safety ? <T size={12} color={c.mute}>🛟 {b.safety}</T> : null}
      </Card>
    </Section>
  ) : null;

  // ── Rules quick card ──
  const rulesCard = (
    <Card pad={14} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <T size={14} weight="700">📐 {rs.label ?? 'Rules in force'}</T>
        {rs.authority ? <T size={12} color={c.mute}>{rs.authority}</T> : null}
      </View>
      <Btn small title={t('oc.ask_rules')} onPress={() => setShowRules(true)} style={{ minHeight: 44 }} accessibilityLabel="Ask rules assistant" />
    </Card>
  );

  // ── Layout ──
  const leftCol = (
    <View style={{ gap: 14 }}>
      {isLiveOrPaused || finished ? <ScoreHeader f={f} g={g} rs={rs} /> : null}
      {f?.has_para_athletes ? <OfficialsPara fixtureId={id} sport={f.sport} event={f.event} /> : null}
      {isLiveOrPaused ? (
        <ControlStrip f={f} ph={ph} canScore={canScore} onControl={confirmControl} onInjury={() => setInjuryOpen(true)} busy={busy} />
      ) : null}
      {isPreMatch ? matchMeta : null}
      {isPreMatch ? <ChecklistSection briefing={briefing.data} onCheck={handleCheck} canScore={canScore} /> : null}
      {isLiveOrPaused && sportZone ? (
        <Section title={t('oc.score_events')} color={c.pink}>
          {sportZone}
          {addedTime}
          {cards}
          {serverPick}
        </Section>
      ) : null}
      {finished ? <PostMatchReview g={g} f={f} canScore={canScore} go={go} id={id} queue={queue} /> : null}
    </View>
  );

  const rightCol = (
    <View style={{ gap: 14 }}>
      {isPreMatch ? rulesCard : null}
      {isPreMatch ? <CrewStrip crew={crew} /> : null}
      {isLiveOrPaused ? (
        <>
          <Section title={t('oc.recent_events')} color={c.violet}>
            <Card pad={14}>
              {recentEvents.length ? recentEvents.map((ev) => (
                <TimelineRow key={ev.id} ev={ev} canScore={canScore} finished={finished} onUndo={() => setUndoTarget(ev)} label={label} />
              )) : <T size={14} color={c.mute}>No events yet.</T>}
            </Card>
          </Section>
          {rulesCard}
          <SyncLine queue={queue} offline={offline} />
        </>
      ) : null}
      {isPreMatch ? (
        <View style={{ gap: 10 }}>
          <Btn
            title={`🏁 ${t('oc.start_match')}`}
            onPress={() => confirmControl('start')}
            disabled={!canScore || busy}
            loading={busy}
            style={{ minHeight: 72, borderRadius: 18 }}
            accessibilityLabel={t('oc.start_match')}
          />
          <T size={12} color={c.mute} style={{ textAlign: 'center' }}>
            Complete all checks before starting. You will be asked to confirm.
          </T>
          <SyncLine queue={queue} offline={offline} />
        </View>
      ) : null}
    </View>
  );

  return (
    <Screen onRefresh={() => { feed.refresh(); briefing.reload(); }} refreshing={busy || feed.loading}>
      {/* Role + match header */}
      <GradCard colors={grad.hero} style={{ gap: 10, padding: 18, borderRadius: 20, marginBottom: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 48, height: 48, borderRadius: 999, backgroundColor: 'rgba(255,255,255,.18)', alignItems: 'center', justifyContent: 'center' }}>
            <T size={22}>{f.sport_emoji ?? '🏅'}</T>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T size={12} weight="700" style={{ color: 'rgba(255,255,255,.65)', letterSpacing: .4, textTransform: 'uppercase' }}>{f.event_name ?? ''}{f.round ? ` · ${f.round}` : ''}</T>
            <T size={18} weight="900" style={{ color: '#fff', letterSpacing: -.4 }} numberOfLines={1}>{names.home} v {names.away}</T>
          </View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {v.role ? <Tag label={`🏅 ${ROLE_LABEL[v.role] ?? v.role}`} color="rgba(255,255,255,.18)" /> : null}
          <PhaseBadge status={f.status} />
          {f.resource_name ? <Tag label={`📍 ${f.resource_name}`} color="rgba(255,255,255,.12)" /> : null}
        </View>
      </GradCard>

      <OfflineBanner queue={queue} offline={offline} savedAt={pack.savedAt} />

      {L.tablet ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <View style={{ flex: 1.3 }}>{leftCol}</View>
          <View style={{ flex: 1 }}>{rightCol}</View>
        </View>
      ) : (
        <View style={{ gap: 14 }}>
          {leftCol}
          {rightCol}
        </View>
      )}

      {/* Sheets */}
      <InjurySheet open={injuryOpen} onClose={() => setInjuryOpen(false)} onConfirm={handleInjury} />
      <UndoSheet open={!!undoTarget} onClose={() => setUndoTarget(null)} onConfirm={handleUndo} />
      {confirm ? (
        <ConfirmSheet
          open
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onClose={() => setConfirm(null)}
          onConfirm={() => control(confirm.op)}
        />
      ) : null}
      {rulesPanel}
      {battingOrder}
      <ConflictSheet feed={feed} queue={queue} />
    </Screen>
  );
}

// ------------------------------------------------------------------ R10 additions

/** Audit trail tab — shows tamper-evident audit chain for the fixture (organiser/admin only). */
export function FixtureAuditTab({ fixtureId }) {
  const { data, loading, error } = useLoad(() => api.get(`/fixtures/${fixtureId}/audit`, { limit: 100, offset: 0 }), [fixtureId]);
  if (loading) return <Loading />;
  if (error) return <T style={{ color: c.error }}>{error.message}</T>;
  const rows = data?.rows ?? [];
  return (
    <ScrollView style={{ flex: 1 }}>
      <Section title={t('official.audit_trail.title')}>
        {rows.length === 0
          ? <Empty label={t('official.audit_trail.no_rows')} />
          : rows.map((row) => (
              <Card key={row.id} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Chip label={row.action} />
                  <T style={{ color: c.muted, fontSize: 11 }}>{new Date(row.created_at).toLocaleString()}</T>
                </View>
                <T style={{ fontSize: 12, color: c.muted, marginTop: 4 }}>
                  {t('official.audit_trail.hash')}: {String(row.hash ?? '').slice(0, 8)}…
                </T>
              </Card>
            ))}
      </Section>
    </ScrollView>
  );
}

/** Permissions panel — shows role-based capability flags for the current user on this fixture. */
export function FixturePermissionsPanel({ fixtureId }) {
  const { data, loading, error } = useLoad(() => api.get(`/fixtures/${fixtureId}/permissions`), [fixtureId]);
  if (loading) return <Loading />;
  if (error) return <T style={{ color: c.error }}>{error.message}</T>;
  const flags = [
    { key: 'canScore',          label: t('official.role_permissions.can_score') },
    { key: 'canFileReport',     label: t('official.role_permissions.can_file_report') },
    { key: 'canSubmitReport',   label: t('official.role_permissions.can_submit_report') },
    { key: 'canReadAllReports', label: t('official.role_permissions.can_read_all') },
    { key: 'isChief',           label: t('official.role_permissions.is_chief') },
    { key: 'isScorer',          label: t('official.role_permissions.is_scorer') },
    { key: 'isObserver',        label: t('official.role_permissions.is_observer') },
  ];
  return (
    <Card style={{ padding: 16 }}>
      <T style={{ fontWeight: '700', fontSize: 15, marginBottom: 12 }}>{t('official.role_permissions.title')}</T>
      {data?.role ? <T style={{ color: c.muted, fontSize: 13, marginBottom: 10 }}>Role: {data.role.replace(/_/g, ' ')}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {flags.map(({ key, label }) => (
          <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: data?.[key] ? c.success + '22' : c.error + '11', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
            <T style={{ fontSize: 12, color: data?.[key] ? c.success : c.muted }}>{data?.[key] ? '✓' : '✗'} {label}</T>
          </View>
        ))}
      </View>
    </Card>
  );
}

/** Crew compliance section — AI-suggested crew requirements vs assigned. For match/event reports. */
export function CrewComplianceSection({ fixtureId }) {
  const { data, loading, error } = useLoad(() => api.get(`/fixtures/${fixtureId}/crew-compliance`), [fixtureId]);
  if (loading) return <Loading />;
  if (error) return null; // non-fatal — compliance may not be set up yet
  if (!data) return null;
  const statusColor = data.compliance_status === 'compliant' ? c.success : data.compliance_status === 'severe_deficit' ? c.error : c.warning;
  const statusLabel = data.compliance_status === 'compliant'
    ? t('crew.requirements.compliant')
    : data.compliance_status === 'severe_deficit'
    ? t('crew.requirements.severe')
    : t('crew.requirements.deficit');
  return (
    <Card style={{ padding: 16, marginTop: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <T style={{ fontWeight: '700', fontSize: 15 }}>{t('crew.requirements.title')}</T>
        <View style={{ backgroundColor: statusColor + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
          <T style={{ color: statusColor, fontSize: 12, fontWeight: '600' }}>{statusLabel}</T>
        </View>
      </View>
      <T style={{ color: c.muted, fontSize: 12, marginBottom: 10 }}>
        {t('crew.requirements.subtitle', { sport: data.sport ?? '' })}
      </T>
      {data.required_crew?.length > 0 && (
        <View style={{ gap: 6 }}>
          {data.required_crew.map((row) => (
            <View key={row.role} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <T style={{ flex: 2, fontSize: 13 }}>{row.role?.replace(/_/g, ' ')}</T>
              <T style={{ flex: 1, textAlign: 'center', fontSize: 13 }}>{row.assigned}/{row.min_required}</T>
              {row.deficit > 0 ? <Tag label={`−${row.deficit}`} color={c.error} /> : <Tag label="✓" color={c.success} />}
            </View>
          ))}
        </View>
      )}
      {data.penalty_applicable && data.penalty_detail ? (
        <View style={{ marginTop: 12, padding: 10, backgroundColor: c.error + '11', borderRadius: 8 }}>
          <T style={{ color: c.error, fontSize: 12, fontWeight: '600' }}>{t('crew.requirements.penalty')}</T>
          <T style={{ color: c.error, fontSize: 12 }}>
            {data.penalty_detail.penalty_type?.replace(/_/g, ' ')} — {data.penalty_detail.penalty_value}
          </T>
        </View>
      ) : null}
    </Card>
  );
}
