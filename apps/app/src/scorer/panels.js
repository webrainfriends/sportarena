// Sport-aware pieces of the live scorer. Each shows what the server derived (the projection) or sends one event; none of them adds a score
// up. Built from the shared Arena components so they look the same on iOS, iPadOS, Android and the web, with 44pt+ touch targets and labels.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { A, ABtn, ACard, AChip, AT } from '../arena';
import { Btn, Chip, Field, Sheet, T } from '../ui';
import { Counter } from '../pickers';
import { c } from '../theme';

const oversText = (legal) => `${Math.floor(legal / 6)}${legal % 6 ? `.${legal % 6}` : ''}`;
const other = (s) => (s === 'home' ? 'away' : 'home');
const sideTone = (s) => (s === 'home' ? 'hero' : 'neon');

/** "Saved" / "N not sent yet" with a retry: the scorer always knows whether their taps reached the server. */
export function SyncLine({ pending, onRetry, mode, offline }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 1 }}>
      <AT size={12.5} weight="800" color={pending ? A.sun : A.green} accessibilityLiveRegion="polite">{pending ? `⚠ ${pending} not sent yet` : '✓ All saved'}</AT>
      {pending && !offline ? <ABtn small tone="sun" title="Retry sending" onPress={onRetry} /> : null}
      {offline ? <AT size={12} weight="800" color={A.sun}>● Offline</AT>
        : mode ? <AT size={12} weight="700" color={mode === 'stream' ? A.green : A.mute}>{mode === 'stream' ? '⚡ Live' : mode === 'polling' ? '↻ Refreshing' : 'Connecting…'}</AT> : null}
    </View>
  );
}

/**
 * What the scorer needs to know about the signal: offline and scoring from the saved copy (provisional until sent), nothing saved yet,
 * the queue nearly full, or taps made by another account that this one must not send.
 */
export function OfflineBanner({ offline, saved, savedTime, waiting, full, foreign }) {
  if (!offline && !foreign && !full) return null;
  return (
    <View style={{ gap: 8 }}>
      {offline ? (
        <ACard pad={12} tone={A.sun}>
          <AT size={13.5} weight="800">{saved ? `Offline · scoring from the copy saved${savedTime ? ` at ${savedTime}` : ''}` : 'Offline · this game is not saved on this device'}</AT>
          <AT size={12.5} color={A.mute}>{saved
            ? `Every tap, undo and correction is checked against the sport's rules here, kept on this device and sent in order when the signal returns${waiting ? ` (${waiting} waiting)` : ''}. The score shown is provisional until then.`
            : 'You can look, but not score. Open the game while online to save it for next time.'}</AT>
        </ACard>
      ) : null}
      {full ? <ACard pad={12} tone={A.sun}><AT size={13} weight="800">Too many taps are waiting. Get back online before scoring more.</AT></ACard> : null}
      {foreign ? <ACard pad={12} tone={A.sun}><AT size={13} weight="800">{`${foreign} tap${foreign === 1 ? '' : 's'} on this device were made by another account.`}</AT><AT size={12.5} color={A.mute}>They are kept, not sent and not deleted. Sign in as that person to send them.</AT></ACard> : null}
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
      {conflict?.missed?.length ? (
        <View style={{ gap: 4 }} accessibilityLabel={`${conflict.missed.length} moments you have not seen`}>
          <T weight="800" size={13}>While you were away</T>
          {conflict.missed.map((m) => <T key={m.seq} size={13.5} color="#334155" style={m.voided ? { textDecorationLine: 'line-through' } : null}>{`${m.by_you ? 'You' : 'Another official'} · ${describe(m)}${m.voided ? ' (voided)' : ''}`}</T>)}
        </View>
      ) : null}
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

function CardsSummary({ pr, names }) {
  return (
    <View style={{ gap: 6 }}>
      <AT size={15} weight="900">{pr.complete ? (pr.winner ? `${names[pr.winner]} win` : 'Draw') : 'Judges are still scoring'}{pr.decision ? ` · ${pr.decision}` : ''}</AT>
      <AT size={12.5} color={A.mute}>Judges: {pr.votes.red} for {names.home}, {pr.votes.blue} for {names.away}{pr.votes.draw ? `, ${pr.votes.draw} level` : ''}</AT>
      {pr.judges.map((j, i) => <AT key={i} size={12} color={A.mute} num>{`Judge ${i + 1}: ${j.rounds ? `${j.red}–${j.blue} over ${j.rounds} round${j.rounds === 1 ? '' : 's'}` : 'no card yet'}`}</AT>)}
    </View>
  );
}

/** The sport-specific live read-out for a game. `p` is /fixtures/:id/projection. */
export function ProjectionCard({ p, names }) {
  if (!p) return null;
  const pr = p.projection;
  const body = pr.judges ? <CardsSummary pr={pr} names={names} /> : 'result' in pr && !pr.sets && !pr.innings ? (
    <AT size={15} weight="900">{pr.result ? (pr.result.outcome === 'draw' ? 'Drawn' : `${names[pr.result.outcome]} won`) + (pr.result.method ? ` · ${pr.result.method}` : '') : 'Result to come'}</AT>
  ) : pr.innings ? <CricketSummary pr={pr} names={names} /> : pr.current_game ? <RacketSummary pr={pr} names={names} /> : pr.sets ? (
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

// ------------------------------------------------------------------ bouts decided by the judges' cards
const QUICK = [[10, 9], [9, 10], [10, 10], [10, 8], [8, 10], [10, 7], [7, 10]];
/** Boxing-style bouts: pick the judge and the round, tap the card the judge wrote. The decision is derived on the server from every card. */
export function CardsPad({ g, names, disabled, onLog }) {
  const { judges, rounds } = g.phase;
  const [judge, setJudge] = useState(1);
  const [round, setRound] = useState(1);
  const cards = {};
  for (const e of g.events) if (e.kind === 'round_card' && !e.voided_at) cards[`${e.payload.judge}:${e.payload.round}`] = `${e.payload.home}–${e.payload.away}`;
  const next = Array.from({ length: rounds }, (_, i) => i + 1).find((r) => !cards[`${judge}:${r}`]);
  useEffect(() => { if (next) setRound(next); }, [judge, next]);
  const decided = !!g.score.over;
  return (
    <View style={{ gap: 12 }}>
      <ACard pad={12} style={{ gap: 8 }}>
        <AT size={12} weight="800" color={A.mute}>WHICH JUDGE'S CARD?</AT>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{Array.from({ length: judges }, (_, i) => <AChip key={i} label={`Judge ${i + 1}`} active={judge === i + 1} onPress={() => setJudge(i + 1)} />)}</View>
        <Counter label="Round" value={round} min={1} max={rounds} onChange={setRound} />
        <AT size={12.5} color={A.mute}>{cards[`${judge}:${round}`] ? `Judge ${judge} already scored round ${round}: ${cards[`${judge}:${round}`]}` : `${names.home} (red) – ${names.away} (blue)`}</AT>
      </ACard>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {QUICK.map(([h, a]) => <AChip key={`${h}${a}`} label={h === a ? `${h}–${a} level` : `${h}–${a} ${names[h > a ? 'home' : 'away']}`} disabled={disabled || decided || !!cards[`${judge}:${round}`]} onPress={() => onLog('round_card', null, { payload: { judge, round, home: h, away: a } })} />)}
      </View>
      <AT size={11.5} color={A.mute}>A round is out of 10 for each side; the pad lists the usual cards. Knockdowns and warnings are tracked below.</AT>
    </View>
  );
}

// ------------------------------------------------------------------ sports decided by a result (chess, esports, judo …)
const METHODS = ['points', 'decision', 'knockout', 'submission', 'checkmate', 'resignation', 'time', 'forfeit', 'disqualification', 'agreed'];
export function OutcomePad({ g, names, disabled, onLog }) {
  const [outcome, setOutcome] = useState(null);
  const [method, setMethod] = useState(null);
  const done = g.score.result;
  if (done) return <ACard pad={14} tone={A.green}><AT size={15} weight="900">{done.outcome === 'draw' ? 'Drawn' : `${names[done.outcome]} won`}{done.method ? ` · ${done.method}` : ''}</AT><AT size={12.5} color={A.mute}>Recorded live. The score sheet is entered by the official at full time.</AT></ACard>;
  return (
    <ACard pad={14} style={{ gap: 10 }}>
      <AT size={15} weight="900">Who won?</AT>
      <AT size={12.5} color={A.mute}>This sport has no running score. Run the clock, then record the result here; the score sheet is entered at full time.</AT>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {[['home', `${names.home} won`], ['draw', 'Draw'], ['away', `${names.away} won`]].map(([k, l]) => <AChip key={k} label={l} active={outcome === k} onPress={() => setOutcome(k)} />)}
      </View>
      <AT size={12} weight="800" color={A.mute}>HOW? (OPTIONAL)</AT>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{METHODS.map((m) => <AChip key={m} label={m[0].toUpperCase() + m.slice(1)} active={method === m} onPress={() => setMethod(method === m ? null : m)} />)}</View>
      <ABtn title="Record the result" tone="live" disabled={disabled || !outcome} onPress={() => onLog('result', null, { payload: { outcome, ...(method ? { method } : {}) } })} />
    </ACard>
  );
}

// ------------------------------------------------------------------ stoppage time
/** The referee's announced added time for the period now running. */
export function AddedTimeBar({ g, disabled, onLog }) {
  const [open, setOpen] = useState(false);
  const [mins, setMins] = useState(3);
  const ph = g.phase;
  if (!ph.period_open) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {ph.added_time ? <AT size={13} weight="900" color={A.sun} accessibilityLiveRegion="polite">+{ph.added_time}′ added time</AT> : null}
      <ABtn small tone="ghost" title={ph.added_time ? '✎ Change added time' : '＋ Added time'} disabled={disabled} onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} title="Added time">
        <T size={14} color="#334155">The minutes the referee has announced at the end of this period.</T>
        <Counter label="Minutes" value={mins} min={1} max={30} onChange={setMins} />
        <Btn title="Announce" onPress={async () => { await onLog('added_time', null, { payload: { minutes: mins } }); setOpen(false); }} />
      </Sheet>
    </View>
  );
}

// ------------------------------------------------------------------ sport rules (basketball, kabaddi, volleyball, badminton …)
const PROMPTS = { technical_timeout: ['Technical timeout due', 'technical_timeout', 'Log it'], interval: ['Interval due', 'interval', 'Log it'], change_ends: ['Change ends', 'change_ends', 'Ends changed'] };
const Dots = ({ n, of, color, label }) => (
  <View accessible accessibilityLabel={label} style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
    {Array.from({ length: of }, (_, i) => <View key={i} style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: i < n ? color : 'transparent', borderWidth: 1.5, borderColor: color }} />)}
  </View>
);

/**
 * What the server derived from the taps under the sport's own rules: team fouls and the bonus, fouled-out players, timeouts left (basketball);
 * players on the mat, do-or-die raids and the all-out (kabaddi); timeouts, substitutions, rotation, service court and the prompts that are due
 * (volleyball, badminton). Prompts clear when the scorer logs them. Renders nothing for a sport with no rules block.
 */
export function RulesPanel({ g, names, disabled, onLog, playerName }) {
  const r = g.score?.rules, rs = g.ruleset;
  if (!r) return null;
  const sides = ['home', 'away'];
  const Row = ({ s, children }) => (
    <View key={s} style={{ flex: 1, minWidth: 140, gap: 6 }}>
      <AT size={12} weight="800" color={A.mute} numberOfLines={1}>{names[s].toUpperCase()}</AT>
      {children}
    </View>
  );
  if (rs.basketball) {
    const B = rs.basketball;
    return (
      <ACard pad={12} style={{ gap: 10 }}>
        <AT size={12} weight="800" color={A.mute}>FOULS AND TIMEOUTS</AT>
        <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
          {sides.map((s) => (
            <Row key={s} s={s}>
              <AT size={13} weight="800" accessibilityLiveRegion="polite">Team fouls {r.team_fouls[s]}{B.team_fouls_bonus ? ` / ${B.team_fouls_bonus}` : ''}</AT>
              {B.team_fouls_bonus ? <Dots n={Math.min(r.team_fouls[s], B.team_fouls_bonus)} of={B.team_fouls_bonus} color={r.bonus[other(s)] ? A.red : A.sun} label={`${names[s]} team fouls ${r.team_fouls[s]}`} /> : null}
              {r.bonus[other(s)] ? <Pill color={A.red}>{names[other(s)]} in the bonus</Pill> : null}
              {r.timeouts_left[s] != null ? <AT size={12.5} color={A.mute}>Timeouts left: {r.timeouts_left[s]}</AT> : null}
            </Row>
          ))}
        </View>
        {r.fouled_out.length ? <AT size={12.5} weight="800" color={A.red} accessibilityLiveRegion="polite">Fouled out: {r.fouled_out.map((p) => playerName?.(p.player_id) ?? 'A player').join(', ')}</AT> : null}
        {r.target_score ? <AT size={12} color={A.mute}>First to {r.target_score} wins.</AT> : null}
      </ACard>
    );
  }
  if (rs.kabaddi) {
    const K = rs.kabaddi;
    return (
      <ACard pad={12} style={{ gap: 10 }}>
        <AT size={12} weight="800" color={A.mute}>ON THE MAT</AT>
        <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
          {sides.map((s) => (
            <Row key={s} s={s}>
              <AT size={13} weight="800" accessibilityLiveRegion="polite">{r.on_mat[s]} of {K.players} players</AT>
              <Dots n={r.on_mat[s]} of={K.players} color={s === 'home' ? A.magenta : A.cyan} label={`${names[s]} ${r.on_mat[s]} on the mat`} />
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {r.do_or_die[s] ? <Pill color={A.red}>Do-or-die raid</Pill> : null}
                {r.super_tackle[s] ? <Pill color={A.sun}>Super tackle on</Pill> : null}
              </View>
            </Row>
          ))}
        </View>
        {r.all_out_for ? <AT size={13} weight="900" color={A.red} accessibilityLiveRegion="polite">{names[other(r.all_out_for)]} have no one on the mat: log the all-out for {names[r.all_out_for]}.</AT> : null}
      </ACard>
    );
  }
  if (rs.rally) {
    const due = (r.prompts ?? []).map((p) => PROMPTS[p]).filter(Boolean);
    const info = r.service_court || r.rotation || r.timeouts_left || r.subs_left;
    if (!due.length && !info) return null;
    return (
      <ACard pad={12} style={{ gap: 10 }}>
        {due.map(([text, kind, action]) => (
          <View key={kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <AT size={14} weight="900" color={A.sun} accessibilityLiveRegion="polite" style={{ flex: 1 }}>{text}</AT>
            <ABtn small tone="sun" title={action} disabled={disabled} onPress={() => onLog(kind, 'home')} />
          </View>
        ))}
        {r.decider ? <AT size={12} weight="800" color={A.mute}>Deciding set</AT> : null}
        <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
          {sides.map((s) => (
            <Row key={s} s={s}>
              {r.service_court && g.score.server === s ? <Pill color={A.green}>Serves from the {r.service_court} court ({r.server_score})</Pill> : null}
              {r.rotation ? <AT size={12.5} color={A.mute}>Rotation {r.rotation[s]}{r.rotation.serving === s ? ' · serving' : ''}</AT> : null}
              {r.timeouts_left ? <AT size={12.5} color={A.mute}>Timeouts left: {r.timeouts_left[s]}</AT> : null}
              {r.subs_left ? <AT size={12.5} color={A.mute}>Substitutions left: {r.subs_left[s]}</AT> : null}
            </Row>
          ))}
        </View>
      </ACard>
    );
  }
  return null;
}
