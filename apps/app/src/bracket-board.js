// The bracket as people read it, for every format: sections of rounds (winners / losers / grand final / main / repechage / placement),
// Swiss rounds with standings, pools with tables, series and aggregate ties. One component for organisers (Games tab) and spectators,
// always with a list next to the drawing: the list is the accessible reading of the same data, and it is the default on a phone.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { A, ABracket, ACard, AChip, AEmpty, AT, ATag, BracketGame, COL_W, LiveBadge } from './arena';
import { Sheet } from './ui';
import { useLayout } from './layout';
import { locale } from './locale';

const STATE = { scheduled: ['Scheduled', A.mute], live: ['Live', A.red], provisional: ['Provisional', A.sun], final: ['Final', A.green], not_required: ['Not required', A.mute], cancelled: ['Cancelled', A.mute] };
const STATUS = { draft: ['DRAFT', A.sun], published: ['PUBLISHED', A.cyan], in_progress: ['IN PROGRESS', A.red], completed: ['COMPLETED', A.green] };
const when = (g) => (g.scheduled_at ? new Date(g.scheduled_at).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: g.venue_timezone || undefined }) : null);
const nm = (g, side) => g[`${side}_name`] ?? g[`${side}_placeholder`] ?? 'To be decided';

/** One game as an accessible row: names, score or time, and an unmistakable state (never colour alone). */
export function GameLine({ g, onPress }) {
  const [label, color] = STATE[g.state] ?? STATE.scheduled;
  const shown = g.state !== 'scheduled' && g.state !== 'not_required' && (g.home_score != null);
  const hw = g.state === 'final' && g.winner_team_id && g.winner_team_id === g.home_team_id, aw = g.state === 'final' && g.winner_team_id && g.winner_team_id === g.away_team_id;
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${g.round ?? ''}: ${nm(g, 'home')} versus ${nm(g, 'away')}. ${g.tie ? g.tie.summary : shown ? `${g.home_score} to ${g.away_score}` : when(g) ?? ''}. ${label}`}
      style={{ minHeight: 56, borderRadius: 14, backgroundColor: A.panel, borderWidth: 1, borderColor: g.state === 'live' ? A.red : A.line, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: g.not_required ? 0.5 : 1 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <AT size={11} weight="800" color={A.mute} style={{ letterSpacing: 0.6 }}>{(g.round ?? '').toUpperCase()}</AT>
        <AT size={14} weight={hw ? '900' : '700'} numberOfLines={1}>{nm(g, 'home')}</AT>
        <AT size={14} weight={aw ? '900' : '700'} numberOfLines={1}>{nm(g, 'away')}</AT>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {g.tie ? <AT size={12} weight="800" color={A.cyan}>{g.tie.summary}</AT> : shown ? <><AT size={17} weight="900" num>{g.home_score}</AT><AT size={17} weight="900" num>{g.away_score}</AT></> : <AT size={12} color={A.mute}>{when(g) ?? 'Time to be set'}</AT>}
        <AT size={10.5} weight="900" color={color}>{label.toUpperCase()}</AT>
      </View>
    </Pressable>
  );
}

/** Columns of games without connector lines (used for losers / repechage / placement / series brackets). */
function Columns({ rounds, onGame }) {
  const max = Math.max(...rounds.map((r) => r.games.length));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 18, paddingVertical: 6 }}>
      {rounds.map((r) => (
        <View key={r.key} style={{ width: COL_W }}>
          <AT size={12} weight="800" color={A.mute} style={{ letterSpacing: 0.6, marginBottom: 8 }} accessibilityRole="header">{r.label.toUpperCase()}</AT>
          <View style={{ minHeight: max * 104, justifyContent: 'space-around', gap: 10 }}>
            {r.games.map((g) => <BracketGame key={g.id} g={g} onPress={onGame ? () => onGame(g) : undefined} />)}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

/** "knockout/seed-order@1" → "knockout · seed order v1", so the policy in force reads as words. */
const algoLabel = (a) => String(a).replace(/_/g, ' ').replace(/\//g, ' · ').replace(/-/g, ' ').replace(/@(\d+)/, ' v$1').replace(/\+/g, ' + ');

export function Table({ head, rows, highlight = 0 }) {
  return (
    <View accessibilityRole="table" style={{ borderRadius: 14, borderWidth: 1, borderColor: A.line, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', backgroundColor: A.panel2, paddingVertical: 8, paddingHorizontal: 10 }}>
        {head.map((h, i) => <AT key={h} size={11} weight="900" color={A.mute} style={{ flex: i === 1 ? 3 : 1, textAlign: i > 1 ? 'right' : 'left' }}>{h}</AT>)}
      </View>
      {rows.map((r, k) => (
        <View key={k} style={{ flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 10, minHeight: 44, alignItems: 'center', borderTopWidth: 1, borderTopColor: A.line, backgroundColor: k < highlight ? `${A.green}22` : 'transparent' }}>
          {r.map((c, i) => <AT key={i} size={13} weight={i === 1 ? '800' : '600'} numberOfLines={1} num={i !== 1} style={{ flex: i === 1 ? 3 : 1, textAlign: i > 1 ? 'right' : 'left' }}>{String(c ?? '')}</AT>)}
        </View>
      ))}
    </View>
  );
}

function TieSheet({ node, onClose, onGame }) {
  return (
    <Sheet visible={!!node} onClose={onClose} title={node?.round ?? ''}>
      {node ? (
        <View style={{ gap: 8 }}>
          <AT size={15} weight="800" color="#0F172A">{node.home_name ?? node.home_placeholder} vs {node.away_name ?? node.away_placeholder}</AT>
          <AT size={13} color="#475569">{node.tie.summary}{node.tie.needs_decider ? ' · level on aggregate: the last leg needs a winner (extra time / penalties)' : ''}</AT>
          {node.tie.config?.away_goals ? <AT size={12} color="#475569">Away goals count on a level aggregate (set by this competition).</AT> : node.tie.kind === 'legs' ? <AT size={12} color="#475569">Away goals do not count in this competition.</AT> : null}
          {node.tie.games.map((x) => (
            <Pressable key={x.id} onPress={() => onGame?.({ id: x.id })} accessibilityRole="button" accessibilityLabel={`${node.tie.kind === 'legs' ? 'Leg' : 'Game'} ${x.leg_no}, ${STATE[x.state]?.[0]}`} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#E2E8F0' }}>
              <AT size={14} weight="700" color="#0F172A">{node.tie.kind === 'legs' ? 'Leg' : 'Game'} {x.leg_no}{x.scheduled_at ? ` · ${when({ scheduled_at: x.scheduled_at, venue_timezone: node.venue_timezone })}` : ''}</AT>
              <AT size={14} weight="900" color={x.not_required ? '#94A3B8' : '#0F172A'}>{x.not_required ? 'Not required' : x.state === 'scheduled' ? 'Scheduled' : `${x.home_score}–${x.away_score}`}</AT>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Sheet>
  );
}

function SwissView({ stage, onGame }) {
  const sw = stage.swiss;
  const [sel, setSel] = useState(Math.max(1, sw.rounds.length));
  const r = sw.rounds.find((x) => x.round === sel);
  return (
    <View style={{ gap: 10 }}>
      <AT size={12} color={A.mute}>{sw.rounds.length} of {sw.rounds_total} rounds paired · {sw.policy.replace(/_/g, ' ')} · tie-breaks: {sw.tie_breaks.join(', ').replace(/_/g, ' ')}</AT>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {sw.rounds.map((x) => <AChip key={x.round} label={`Round ${x.round}${x.complete ? ' ✓' : ''}`} active={x.round === sel} onPress={() => setSel(x.round)} />)}
      </ScrollView>
      {r ? <View style={{ gap: 8 }}>{r.games.map((g) => <GameLine key={g.id} g={g} onPress={onGame ? () => onGame(g) : undefined} />)}{r.bye ? <AT size={13} color={A.mute}>Bye: {r.bye.name}</AT> : null}</View> : <AEmpty emoji="🔀" title="No round yet" />}
      <AT size={12} weight="800" color={A.mute} accessibilityRole="header">STANDINGS</AT>
      <Table head={['#', 'Team', 'Pts', 'W', 'Bch']} rows={sw.table.map((t) => [t.rank, t.name, t.points, t.wins, t.buchholz])} />
    </View>
  );
}

function PoolsView({ stage, onGame }) {
  const adv = stage.format?.pools?.advance_per_pool ?? 2;
  return (
    <View style={{ gap: 14 }}>
      {stage.pools.map((p) => (
        <View key={p.name} style={{ gap: 8 }}>
          <AT size={14} weight="900" accessibilityRole="header">Pool {p.name}{p.complete ? ' ✓' : ''}</AT>
          <Table head={['#', 'Team', 'P', 'W', 'GD', 'Pts']} highlight={p.complete ? adv : 0} rows={p.table.map((t) => [t.rank, t.name, t.played, t.won, t.goal_diff, t.points])} />
          {p.games.map((g) => <GameLine key={g.id} g={g} onPress={onGame ? () => onGame(g) : undefined} />)}
        </View>
      ))}
      {stage.qualifiers?.length ? <AT size={12} color={A.mute}>Going through: {stage.qualifiers.map((q) => `${q.name} (${q.kind === 'wildcard' ? 'wildcard' : `${q.pool}${q.pool_rank}`})`).join(', ')}</AT> : null}
    </View>
  );
}

/** A flat, ordered list of the stage's games: the reading that never depends on a drawing. */
export function StageList({ stage, onGame }) {
  const secs = [...(stage.sections ?? []), ...(stage.swiss || stage.pools ? [] : [])];
  if (!secs.length) return null;
  return (
    <View style={{ gap: 12 }}>
      {secs.map((s) => (
        <View key={s.key} style={{ gap: 8 }}>
          <AT size={13} weight="900" color={A.violet} accessibilityRole="header">{s.label.toUpperCase()}</AT>
          {s.rounds.map((r) => (
            <View key={r.key} style={{ gap: 6 }}>
              <AT size={12} weight="800" color={A.mute} accessibilityRole="header">{r.label}</AT>
              {r.games.map((g) => <GameLine key={g.id} g={g} onPress={g.tie || onGame ? () => (g.tie ? onGame?.(g) : onGame(g)) : undefined} />)}
            </View>
          ))}
        </View>
      ))}
      {stage.third_place ? <View style={{ gap: 6 }}><AT size={12} weight="800" color={A.mute}>THIRD PLACE</AT><GameLine g={stage.third_place} onPress={onGame ? () => onGame(stage.third_place) : undefined} /></View> : null}
    </View>
  );
}

/**
 * @param {object} p
 * @param {object} p.stage one entry of list_event_stages / the public bracket `stages`
 * @param {(g:object)=>void} [p.onGame] opens a game
 * @param {React.ReactNode} [p.children] organiser actions under the heading
 */
export function StageBoard({ stage, onGame, children }) {
  const { tablet } = useLayout();
  const [view, setView] = useState(tablet ? 'draw' : 'list');
  const [tie, setTie] = useState(null);
  const open = (g) => { if (g.tie) setTie(g); else onGame?.(g); };
  const [label, color] = STATUS[stage.status] ?? STATUS.published;
  const drawable = stage.sections?.length > 0;
  return (
    <ACard style={{ gap: 12 }} pad={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <AT size={18} weight="900" style={{ flexShrink: 1 }} accessibilityRole="header">{stage.name}</AT>
        <ATag label={label} tone={color} />
        {stage.algorithm ? <ATag label={`${algoLabel(stage.algorithm)}${stage.revision > 1 ? ` · redraw ${stage.revision - 1}` : ''}`} tone={A.violet} /> : null}
      </View>
      {stage.status === 'draft' ? <AT size={12.5} color={A.sun}>Draft: only organisers can see this. Spectators see it once it is published.</AT> : null}
      {stage.champion ? <AT size={16} weight="900" color={A.sun}>🏆 {stage.champion.name}</AT> : null}
      {children}
      {drawable ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <AChip label="List" active={view === 'list'} onPress={() => setView('list')} />
          <AChip label="Drawing" active={view === 'draw'} onPress={() => setView('draw')} />
        </View>
      ) : null}
      {stage.swiss ? <SwissView stage={stage} onGame={open} /> : stage.pools ? <PoolsView stage={stage} onGame={open} /> : drawable ? (
        view === 'list' ? <StageList stage={stage} onGame={open} /> : (
          <View style={{ gap: 14 }}>
            {stage.sections.map((s) => {
              const plain = s.key === 'main' && stage.kind === 'knockout' && !stage.ties.length && s.rounds.every((r) => ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final'].includes(r.key));
              return (
                <View key={s.key} style={{ gap: 6 }}>
                  <AT size={13} weight="900" color={A.violet} accessibilityRole="header">{s.label.toUpperCase()}</AT>
                  {plain ? <ABracket data={{ rounds: s.rounds.map((r) => ({ kind: r.key, label: r.label, games: r.games })), champion: null }} onGame={open} /> : <Columns rounds={s.rounds} onGame={open} />}
                </View>
              );
            })}
            {stage.third_place ? <View style={{ gap: 6 }}><AT size={13} weight="900" color={A.violet}>THIRD PLACE</AT><BracketGame g={stage.third_place} onPress={() => open(stage.third_place)} /></View> : null}
          </View>
        )
      ) : <AEmpty emoji="🗓️" title="No games yet" />}
      {stage.placements?.length > 3 ? <><AT size={12} weight="800" color={A.mute}>FINAL PLACINGS</AT><Table head={['#', 'Team']} rows={stage.placements.map((p) => [`${p.place}${p.shared ? '=' : ''}`, p.name])} /></> : null}
      {stage.draw_seed ? <AT size={11} color={A.mute}>Draw seed {stage.draw_seed} · the same field and seed reproduce this draw.</AT> : null}
      <TieSheet node={tie} onClose={() => setTie(null)} onGame={(g) => { setTie(null); onGame?.(g); }} />
    </ACard>
  );
}
export { LiveBadge };
