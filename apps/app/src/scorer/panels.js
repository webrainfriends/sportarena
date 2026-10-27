// Sport-aware pieces of the live scorer. Each shows what the server derived (the projection) or sends one event; none of them adds a score
// up. Built from the shared Arena components so they look the same on iOS, iPadOS, Android and the web, with 44pt+ touch targets and labels.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { A, ABtn, ACard, AChip, AT } from '../arena';
import { Btn, Chip, Field, Sheet, T } from '../ui';
import { c } from '../theme';

const oversText = (legal) => `${Math.floor(legal / 6)}${legal % 6 ? `.${legal % 6}` : ''}`;
const other = (s) => (s === 'home' ? 'away' : 'home');
const sideTone = (s) => (s === 'home' ? 'hero' : 'neon');

/** "Saved" / "N not sent yet" with a retry: the scorer always knows whether their taps reached the server. */
export function SyncLine({ pending, onRetry, mode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 1 }}>
      <AT size={12.5} weight="800" color={pending ? A.sun : A.green} accessibilityLiveRegion="polite">{pending ? `⚠ ${pending} not sent yet` : '✓ All saved'}</AT>
      {pending ? <ABtn small tone="sun" title="Retry sending" onPress={onRetry} /> : null}
      {mode ? <AT size={12} weight="700" color={mode === 'stream' ? A.green : A.mute}>{mode === 'stream' ? '⚡ Live' : mode === 'polling' ? '↻ Refreshing' : 'Connecting…'}</AT> : null}
    </View>
  );
}

/** Another official scored since this device last looked: nothing is applied silently. */
export function ConflictSheet({ conflict, describe, names, onResend, onDiscard }) {
  const sc = conflict?.state?.score;
  return (
    <Sheet visible={!!conflict} onClose={onDiscard} title="The game moved on">
      <T size={14} color="#334155">Someone else has scored since you last looked, so this tap was held back instead of being added blindly.</T>
      {sc ? <T weight="800" size={16}>Now: {names.home} {sc.home} – {sc.away} {names.away}</T> : null}
      {conflict ? <T size={14} color="#334155">Your tap: {describe(conflict.event)}</T> : null}
      <Btn title="Still happened: send it" onPress={onResend} />
      <Btn title="Discard my tap" color={c.paper} ink={c.ink} onPress={onDiscard} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ what the server derived
const Pill = ({ children, color = A.cyan }) => <View style={{ borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: `${color}26`, borderWidth: 1, borderColor: `${color}77` }}><AT size={11.5} weight="800" color={color}>{children}</AT></View>;

function CricketSummary({ pr, names }) {
  const open = pr.innings[pr.innings.length - 1];
  return (
    <View style={{ gap: 8 }}>
      {pr.innings.map((i) => (
        <View key={i.n} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <AT size={13} weight="800" color={A.mute}>{names[i.side]} · innings {i.n}</AT>
          <AT size={20} weight="900" num>{i.runs}/{i.wickets} <AT size={12} weight="700" color={A.mute}>({oversText(i.overs)} ov)</AT></AT>
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {pr.current_run_rate != null ? <Pill>CRR {pr.current_run_rate.toFixed(2)}</Pill> : null}
        {pr.required_run_rate != null ? <Pill color={A.sun}>RRR {pr.required_run_rate.toFixed(2)}</Pill> : null}
        {open && !open.closed && open.partnerships ? <Pill color={A.violet}>{open.partnerships.length} down</Pill> : null}
      </View>
      {pr.target ? <AT size={13.5} weight="800" color={A.sun}>Target {pr.target} · need {pr.to_win} off {pr.balls_left} ball{pr.balls_left === 1 ? '' : 's'}</AT> : null}
      {pr.result ? <AT size={14} weight="900" color={A.green}>{pr.result.text}</AT> : null}
      {open?.partnerships?.length ? (
        <AT size={12} color={A.mute}>Last partnership: {open.partnerships[open.partnerships.length - 1].runs} runs off {open.partnerships[open.partnerships.length - 1].balls} balls</AT>
      ) : null}
      {open?.fow?.length ? <AT size={12} color={A.mute}>Fall of wickets: {open.fow.map((f) => `${f.n}-${f.runs} (${f.over})`).join(', ')}</AT> : null}
    </View>
  );
}

function RacketSummary({ pr, names }) {
  const gm = pr.current_game;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {pr.sets.map((s, i) => <Pill key={i} color={s.winner === 'home' ? A.magenta : A.cyan}>{s.home}–{s.away}{s.tiebreak ? ` (${s.tiebreak.home}–${s.tiebreak.away})` : ''}</Pill>)}
      </View>
      {!pr.over && pr.current_set ? <AT size={16} weight="900" num>Set {pr.sets.length + 1}: {pr.current_set.home}–{pr.current_set.away}</AT> : null}
      {gm ? <AT size={22} weight="900" num accessibilityLabel={`Game score ${gm.call}`}>{gm.tiebreak ? (gm.match_tiebreak ? 'Match tie-break ' : 'Tie-break ') : ''}{gm.call}</AT> : null}
      {pr.server ? <AT size={13} weight="800" color={A.sun}>🎾 {names[pr.server]} to serve</AT> : null}
      {pr.outcome ? <AT size={14} weight="900" color={A.green}>{pr.outcome === 'retired' ? 'Match ended: retirement' : 'Walkover'}</AT> : null}
    </View>
  );
}

function PointsSummary({ pr, names }) {
  return (
    <View style={{ gap: 6 }}>
      {pr.periods?.length ? <AT size={13} color={A.mute}>{pr.periods.map((p) => `${p.period}: ${p.home}–${p.away}`).join('   ')}</AT> : null}
      {pr.shootout?.started ? <AT size={14} weight="800" color={A.sun}>Shoot-out {pr.shootout.goals.home}–{pr.shootout.goals.away}{pr.shootout.winner ? ` · ${names[pr.shootout.winner]} win` : ''}</AT> : null}
      {pr.sent_off?.length ? <AT size={12.5} weight="800" color={A.red}>🟥 Sent off: {pr.sent_off.length} ({pr.sent_off.map((p) => (p.reason === 'second_yellow' ? '2nd yellow' : 'red')).join(', ')})</AT> : null}
    </View>
  );
}

/** The sport-specific live read-out for a game. `p` is /fixtures/:id/projection. */
export function ProjectionCard({ p, names }) {
  if (!p) return null;
  const pr = p.projection;
  const body = pr.innings ? <CricketSummary pr={pr} names={names} /> : pr.current_game ? <RacketSummary pr={pr} names={names} /> : pr.sets ? (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{pr.sets.map((s, i) => <Pill key={i} color={s.winner === 'home' ? A.magenta : A.cyan}>{s.home}–{s.away}</Pill>)}</View>
      {pr.server ? <AT size={13} weight="800" color={A.sun}>Serving: {names[pr.server]}</AT> : null}
    </View>
  ) : <PointsSummary pr={pr} names={names} />;
  return <ACard pad={14} style={{ gap: 6 }}><AT size={12} weight="900" color={A.mute} style={{ letterSpacing: 0.8 }}>{String(p.ruleset.label).toUpperCase()}{p.ruleset.version ? ` · RULES v${p.ruleset.version}` : ''}</AT>{body}</ACard>;
}

// ------------------------------------------------------------------ pads
/** Tennis, padel and other game-in-set sports: who serves first, then a big tap for whoever won the point. */
export function RacketPad({ g, names, disabled, onLog }) {
  const sc = g.score, started = (sc.sets?.length ?? 0) > 0 || (sc.current_game?.home ?? 0) + (sc.current_game?.away ?? 0) > 0 || (sc.current_set?.home ?? 0) + (sc.current_set?.away ?? 0) > 0;
  const [retire, setRetire] = useState(false);
  const gm = sc.current_game;
  return (
    <View style={{ gap: 12 }}>
      {started && gm && !sc.over ? (
        <ACard pad={14} style={{ gap: 4, alignItems: 'center' }} >
          <AT size={12} weight="800" color={A.mute}>{(gm.tiebreak ? (gm.match_tiebreak ? 'MATCH TIE-BREAK' : 'TIE-BREAK') : 'THIS GAME')}{sc.current_set ? `  ·  SET ${sc.sets.length + 1}: ${sc.current_set.home}–${sc.current_set.away}` : ''}</AT>
          <AT size={34} weight="900" num accessibilityLabel={`Game score ${gm.call}`}>{gm.call}</AT>
          {sc.server ? <AT size={13} weight="800" color={A.sun}>🎾 {names[sc.server]} serving</AT> : null}
        </ACard>
      ) : null}
      {!started && !sc.server ? (
        <ACard pad={12} style={{ gap: 8 }}>
          <AT size={13} weight="800">Who serves first?</AT>
          <View style={{ flexDirection: 'row', gap: 8 }}>{['home', 'away'].map((s) => <AChip key={s} label={names[s]} onPress={() => onLog('server', s)} />)}</View>
        </ACard>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {['home', 'away'].map((s) => (
          <View key={s} style={{ flex: 1, gap: 6 }}>
            <AT size={12} weight="800" color={A.mute} numberOfLines={1} style={{ textAlign: 'center' }}>{names[s].toUpperCase()}{sc.server === s ? '  🎾' : ''}</AT>
            <ABtn tone={sideTone(s)} title="Point" disabled={disabled || sc.over} onPress={() => onLog('point', s)} style={{ minHeight: 76 }} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <ABtn small tone="ghost" title="Retirement" disabled={disabled || sc.over} onPress={() => setRetire(true)} />
        {!started ? <ABtn small tone="ghost" title="Walkover" disabled={disabled} onPress={() => setRetire('walkover')} /> : null}
      </View>
      <Sheet visible={!!retire} onClose={() => setRetire(false)} title={retire === 'walkover' ? 'Walkover: who did not turn up?' : 'Retirement: who cannot continue?'}>
        <T size={14} color="#475569">The other side is awarded the match. This is recorded in the log with who entered it.</T>
        {['home', 'away'].map((s) => <Btn key={s} title={names[s]} onPress={async () => { await onLog(retire === 'walkover' ? 'walkover' : 'retire', s); setRetire(false); }} />)}
      </Sheet>
    </View>
  );
}

/** Rally sports with a derived server: who serves first. The point buttons stay with the normal pad. */
export function ServerPick({ g, names, onLog }) {
  const rs = g.ruleset;
  if (rs.kind !== 'sets' || !rs.racket || rs.racket.serve === 'none') return null;
  const started = (g.score.sets?.length ?? 0) > 0 || (g.score.current_set?.home ?? 0) + (g.score.current_set?.away ?? 0) > 0;
  if (started && !g.score.server) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <AT size={12.5} weight="800" color={A.mute}>{g.score.server ? `Serving: ${names[g.score.server]}` : 'First server'}</AT>
      {!started && !g.score.server ? ['home', 'away'].map((s) => <AChip key={s} label={names[s]} onPress={() => onLog('server', s)} />) : null}
    </View>
  );
}

/** Extra time and the penalty shoot-out, offered only when the pinned rules allow them and the score is level. */
export function FootballExtras({ g, names, disabled, onLog }) {
  const [first, setFirst] = useState('home');
  const ph = g.phase, so = g.score.shootout;
  const rs = g.ruleset;
  if (!(ph.extra_time_available || ph.shootout_available || so?.started)) return null;
  const next = so?.next ?? null, kicker = next ?? first;
  return (
    <ACard pad={14} tone={A.sun} style={{ gap: 10 }}>
      <AT size={15} weight="900">{ph.period > rs.periods.count ? 'Still level after extra time' : 'Level at full time'}</AT>
      {ph.extra_time_available ? (
        <ABtn tone="sun" title={`Start extra time ${ph.period - rs.periods.count + 1} (${ph.extra_minutes}′)`} disabled={disabled} onPress={() => onLog('period_start', null, { period: ph.period + 1 })} />
      ) : null}
      {ph.shootout_available || so?.started ? (
        <View style={{ gap: 10 }}>
          <AT size={14} weight="800">Penalty shoot-out · best of {so?.rounds ?? rs.shootout.rounds}</AT>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            {['home', 'away'].map((s) => (
              <View key={s} style={{ flex: 1, gap: 6 }}>
                <AT size={12} weight="800" color={kicker === s && !so?.over ? A.sun : A.mute} numberOfLines={1}>{names[s].toUpperCase()}</AT>
                {kicker === s && !so?.over ? <AT size={11} weight="900" color={A.sun}>▶ KICKS NEXT</AT> : null}
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', minHeight: 24 }}>
                  {(so?.sequence ?? []).filter((k) => k.side === s).map((k, i) => <AT key={i} size={18} accessibilityLabel={k.scored ? 'scored' : 'missed'}>{k.scored ? '⚽' : '✖️'}</AT>)}
                </View>
                <AT size={22} weight="900" num>{so?.goals?.[s] ?? 0}</AT>
              </View>
            ))}
          </View>
          {so?.over ? <AT size={14} weight="900" color={A.green}>{names[so.winner]} win the shoot-out</AT> : (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <ABtn tone="lime" title="⚽ Scored" disabled={disabled} onPress={() => onLog('shootout_goal', kicker)} style={{ flex: 1 }} />
              <ABtn tone="ghost" title="✖ Missed" disabled={disabled} onPress={() => onLog('shootout_miss', kicker)} style={{ flex: 1 }} />
            </View>
          )}
          {!so?.started ? (
            <View style={{ gap: 6 }}>
              <AT size={12.5} weight="800" color={A.mute}>Who kicks first? (coin toss)</AT>
              <View style={{ flexDirection: 'row', gap: 8 }}>{['home', 'away'].map((s) => <AChip key={s} label={names[s]} active={first === s} onPress={() => setFirst(s)} />)}</View>
            </View>
          ) : null}
        </View>
      ) : null}
    </ACard>
  );
}

// ------------------------------------------------------------------ corrections
const PRESETS = ['Wrong team', 'Wrong action', 'Wrong player', 'Entered by mistake', 'Review overturned'];

/** Correct one event: change the side or the action; the original stays in the log and the rest of the game is replayed first. */
export function CorrectSheet({ event, rs, names, label, onClose, onSubmit }) {
  const [side, setSide] = useState(null), [kind, setKind] = useState(null), [why, setWhy] = useState(null), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  useEffect(() => { setSide(null); setKind(null); setWhy(null); setNote(''); setErr(null); }, [event?.id]);
  if (!event) return null;
  const kinds = [...(rs.events ?? []), ...(rs.stats ?? [])];
  const scoringBall = rs.kind === 'cricket';
  const changed = (side && side !== event.side) || (kind && kind !== event.kind);
  const reason = [why, note.trim()].filter(Boolean).join(': ');
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onSubmit({ id: event.id, reason, ...(side && side !== event.side ? { side } : {}), ...(kind && kind !== event.kind ? { kind } : {}) }); onClose(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Correct this moment">
      <T size={14} color="#334155">Now: {label(event.kind)}{event.side ? ` · ${names[event.side]}` : ''}. The original stays in the log, marked as corrected, with who changed it and why.</T>
      {event.side ? (<><T weight="800" size={13}>Which side?</T><View style={{ flexDirection: 'row', gap: 8 }}>{['home', 'away'].map((s) => <Chip key={s} label={names[s]} active={(side ?? event.side) === s} onPress={() => setSide(s)} />)}</View></>) : null}
      {!scoringBall && kinds.length > 1 && !['period_start', 'period_end', 'note'].includes(event.kind) ? (<><T weight="800" size={13}>What happened?</T><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{kinds.map((k) => <Chip key={k.kind} label={k.label} active={(kind ?? event.kind) === k.kind} onPress={() => setKind(k.kind)} />)}</View></>) : null}
      <T weight="800" size={13}>Why?</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{PRESETS.map((p) => <Chip key={p} label={p} active={why === p} onPress={() => setWhy(why === p ? null : p)} />)}</View>
      <Field label="Add a note (optional)" value={note} onChangeText={setNote} multiline />
      {err ? <T size={13} color="#B91C1C" accessibilityLiveRegion="polite">{err}</T> : null}
      <Btn title="Save correction" loading={busy} disabled={!changed || !reason} onPress={go} />
    </Sheet>
  );
}

/** Pick the batting order from the declared lineup: tap players in the order they bat, tap again to remove. Names reach the scorebook and the cricket scorecards. */
export function BattingOrderSheet({ name, players, value, onClose, onSave }) {
  const [ids, setIds] = useState(value);
  const [busy, setBusy] = useState(false);
  const toggle = (id) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < 11 ? [...cur, id] : cur));
  return (
    <Sheet visible onClose={onClose} title={`${name} batting order`}>
      <T size={14} color="#334155">Tap players in the order they bat. Tap a chosen player again to take them out.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {players.map((p) => { const k = ids.indexOf(p.user_id); return <Chip key={p.user_id} label={k >= 0 ? `${k + 1}. ${p.display_name}` : p.display_name} active={k >= 0} onPress={() => toggle(p.user_id)} />; })}
      </View>
      <T size={12} color="#64748B" accessibilityLiveRegion="polite">{ids.length} of {Math.min(11, players.length)} chosen</T>
      <Btn title="Save batting order" loading={busy} disabled={!ids.length} onPress={async () => { setBusy(true); try { await onSave(ids); } finally { setBusy(false); } }} />
    </Sheet>
  );
}
