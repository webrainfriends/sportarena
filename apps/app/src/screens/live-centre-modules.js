// Premium live-centre modules (#578). Pure presentation of the `centre` block of GET /public/fixtures/:id: the same canonical game state the
// spectator sees and the staff console shows. No state is kept here; every string goes through t(); Arena theme tokens only; start/end (not left/right)
// so Urdu lays out right-to-left; cards flow into two columns on tablet and desktop widths and stack on a phone.
import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { openPage } from '../video-player';
import { mediaUrl } from '../api';
import { t } from '../i18n';
import { A, ABtn, ACard, AChip, AEmpty, ASection, AT } from '../arena';

const mmss = (s) => (s == null ? '–' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/** Official / unofficial clock with its running state. A sport without a running timer shows its state label only, never an invented time. */
export function ClockBadge({ clock }) {
  if (!clock || clock.state === 'not_started') return null;
  const tone = clock.official ? A.green : A.sun;
  const word = t(`livec.clock.${clock.state}`);
  const label = `${clock.official ? t('livec.clock.official') : t('livec.clock.unofficial')} · ${word}${clock.timed && clock.elapsed_seconds != null ? ` · ${mmss(clock.elapsed_seconds)}` : ''}`;
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={label} style={{ borderRadius: 999, borderWidth: 1, borderColor: tone, paddingHorizontal: 12, minHeight: 32, justifyContent: 'center' }}>
      <AT size={12} weight="800" color={tone}>{label}</AT>
    </View>
  );
}

/** Shown while the stream is down and the last frame is on screen; Retry forces a fresh read. */
export function ConnectionBanner({ offline, updatedAt, onRetry }) {
  if (!offline && !updatedAt) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 44 }}>
      <AT size={12.5} color={offline ? A.orange : A.mute} weight={offline ? '800' : '600'}>
        {offline ? t('livec.conn.reconnecting') : t('livec.conn.updated', { time: updatedAt })}
      </AT>
      {offline ? <ABtn small tone="ghost" title={t('livec.conn.retry')} onPress={onRetry} /> : null}
    </View>
  );
}

const Block = ({ title, children, width }) => (
  <View style={{ flexGrow: 1, flexBasis: width >= 900 ? '48%' : '100%', minWidth: 0, gap: 8 }}>
    <ASection title={title} />
    {children}
  </View>
);

/** Every module the organiser enabled and the data supports. Missing data is an empty state, never a placeholder. */
export default function LiveModules({ centre, fixture }) {
  const { width } = useWindowDimensions();
  if (!centre) return null;
  const { lineups, substitutions, discipline, stats, standings_impact: impact, highlights } = centre;
  const nameOf = (side) => (side === 'home' ? fixture.home.name : fixture.away.name);
  const cards = [];

  if (stats) {
    cards.push(
      <Block key="stats" title={t('livec.stats')} width={width}>
        <ACard>
          {stats.rows.length ? stats.rows.map((r) => (
            <View key={r.kind} accessible accessibilityLabel={`${r.label}: ${fixture.home.name} ${r.home}, ${fixture.away.name} ${r.away}`} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40 }}>
              <AT size={16} weight="900" num style={{ width: 36 }}>{r.home}</AT>
              <AT size={13} weight="700" color={A.mute} style={{ flex: 1, textAlign: 'center' }}>{r.icon ? `${r.icon} ` : ''}{r.label}</AT>
              <AT size={16} weight="900" num style={{ width: 36, textAlign: 'right' }}>{r.away}</AT>
            </View>
          )) : <AEmpty emoji="📊" title={t('livec.stats')} sub="" />}
        </ACard>
      </Block>,
    );
  }

  if (discipline && discipline.length) {
    cards.push(
      <Block key="discipline" title={t('livec.discipline')} width={width}>
        <ACard>{discipline.map((e) => (
          <View key={e.seq} style={{ flexDirection: 'row', gap: 10, minHeight: 40, alignItems: 'center' }}>
            <AT size={12} weight="800" color={A.mute} num style={{ width: 34 }}>{e.clock_seconds != null ? `${Math.floor(e.clock_seconds / 60)}'` : ''}</AT>
            <AT size={14} weight="700" style={{ flex: 1 }}>{e.label} · {e.side ? nameOf(e.side) : ''}{e.player ? ` — ${e.player.display_name}` : ''}</AT>
          </View>
        ))}</ACard>
      </Block>,
    );
  }

  if (lineups) {
    cards.push(
      <Block key="lineups" title={t('livec.lineups')} width={width}>
        {lineups.available ? (
          <ACard>{lineups.teams.map((tm) => (
            <View key={tm.team_id} style={{ marginBottom: 10 }}>
              <AT size={13} weight="900" color={A.cyan} style={{ marginBottom: 4 }}>{nameOf(tm.side)}</AT>
              {tm.players.map((p) => (
                <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 }}>
                  <AT size={18}>{p.avatar_emoji}</AT>
                  <AT size={14} weight="700" style={{ flex: 1 }}>{p.display_name}</AT>
                  <AChip label={p.role === 'starter' ? t('livec.lineups.starting') : p.role === 'came_on' ? t('livec.subs') : t('livec.lineups.bench')} active={p.role === 'starter'} />
                </View>
              ))}
            </View>
          ))}</ACard>
        ) : <AEmpty emoji="📋" title={t('livec.lineups')} sub={t('livec.lineups.empty')} />}
      </Block>,
    );
  }

  if (substitutions && substitutions.length) {
    cards.push(
      <Block key="subs" title={t('livec.subs')} width={width}>
        <ACard>{substitutions.map((s, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 10, minHeight: 40, alignItems: 'center' }}>
            <AT size={12} weight="800" color={A.mute} num style={{ width: 34 }}>{Math.floor(s.clock_seconds / 60)}'</AT>
            <AT size={14} weight="700" style={{ flex: 1 }}>{nameOf(s.side)} · {t('livec.subs.row', { on: s.on?.display_name ?? '–', off: s.off?.display_name ?? '–' })}</AT>
          </View>
        ))}</ACard>
      </Block>,
    );
  }

  if (impact?.available) {
    cards.push(
      <Block key="impact" title={t('livec.impact')} width={width}>
        <ACard tone={A.sun}>
          <AT size={12} color={A.mute} style={{ marginBottom: 6 }}>{t('livec.impact.note')}</AT>
          {impact.rows.map((r) => (
            <View key={r.team_id} accessible accessibilityLabel={`${r.rank}. ${r.name}, ${t('livec.impact.points', { n: r.points })}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40 }}>
              <AT size={14} weight="900" num style={{ width: 24 }}>{r.rank}</AT>
              <AT size={13} weight="800" color={r.moved > 0 ? A.green : r.moved < 0 ? A.red : A.mute} style={{ width: 28 }}>{r.moved > 0 ? `▲${r.moved}` : r.moved < 0 ? `▼${-r.moved}` : '–'}</AT>
              <AT size={14} weight={r.in_this_game ? '900' : '600'} style={{ flex: 1 }}>{r.emoji ? `${r.emoji} ` : ''}{r.name}</AT>
              <AT size={13} weight="800" num>{t('livec.impact.points', { n: r.points })}</AT>
            </View>
          ))}
        </ACard>
      </Block>,
    );
  }

  if (highlights && highlights.length) {
    cards.push(
      <Block key="highlights" title={t('livec.highlights')} width={width}>
        {highlights.map((m) => (
          <ACard key={m.id} onPress={() => openPage(mediaUrl(m.link))} accessibilityRole="link" accessibilityLabel={m.title}>
            <AT weight="700">🎬 {m.title}</AT>
            {m.credit ? <AT size={12} color={A.mute}>{m.credit}</AT> : null}
          </ACard>
        ))}
      </Block>,
    );
  }

  if (!cards.length) return null;
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>{cards}</View>;
}

/** Staff-only operations card (organiser and accepted match officials): read from the same game through GET /fixtures/:id/live, which only returns `ops` to them. */
export function StaffOps({ ops }) {
  if (!ops) return null;
  const rows = [
    ops.scorer ? t('livec.ops.scorer', { name: ops.scorer.name }) : t('livec.ops.no_scorer'),
    `${ops.clock_official ? t('livec.clock.official') : t('livec.clock.unofficial')}`,
    t('livec.ops.voided', { n: ops.voided_events }),
    t('livec.ops.corrections', { n: ops.corrections }),
    ops.sheet_status ? t('livec.ops.sheet', { status: ops.sheet_status }) : t('livec.ops.sheet_none'),
    t('livec.ops.fan_view', { v: ops.fan_view.modules ? ops.fan_view.modules.join(', ') || '–' : t('livec.ops.fan_all') }),
  ];
  return (
    <ACard tone={A.cyan} pad={14}>
      <AT size={12} weight="900" color={A.cyan} style={{ marginBottom: 6 }}>{t('livec.ops.title')}</AT>
      {rows.map((r) => <AT key={r} size={13} style={{ minHeight: 28 }}>{r}</AT>)}
    </ACard>
  );
}
