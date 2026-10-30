// The Match Centre, and the Games tab of the event console: the referee's live console (kick off, score with the sport's own buttons, track
// fouls and cards, undo, pause, full time) that doubles as a live scoreboard for everyone else.
import { locale } from '../locale';
import React, { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useLiveFixture, usePoll } from '../live';
import { useSession } from '../session';
import { useNav } from '../nav';
import { A, ABracket, ABtn, ACard, AChip, AEmpty, AScreen, ASection, AT, LiveBadge, ReasonSheet, ScoreTicker } from '../arena';
import { Loading, Sheet, T } from '../ui';
import { GamesByDay, SchedulePlanner } from './event-schedule';
import { StageDesk, StagesView } from '../bracket-studio';
import { AppearancesPanel } from './appearances';
import { CricketScorer } from './cricket-scorer';
import { useScoreQueue } from '../scorer/queue';
import { AddedTimeBar, BattingOrderSheet, CardsPad, ConflictSheet, CorrectSheet, FootballExtras, OutcomePad, ProjectionCard, RacketPad, RulesPanel, ServerPick, SyncLine } from '../scorer/panels';

const EXTRA = { wd: 'Wide', nb: 'No-ball', b: 'Bye', lb: 'Leg bye', pen: 'Penalty' };
/** What a cricket ball was, in the scorer's words: so the timeline can be read, and a ball found to correct. */
const ballText = (p = {}) => {
  const runs = (p.runs || 0) + (p.extra_runs || 0);
  if (p.wicket) return `Wicket · ${String(p.wicket.how).replace(/_/g, ' ')}${runs ? ` (+${runs})` : ''}`;
  if (p.extra) return `${EXTRA[p.extra] ?? p.extra}${runs ? ` +${runs}` : ''}`;
  return p.runs === 4 ? 'FOUR' : p.runs === 6 ? 'SIX' : p.runs ? `${p.runs} run${p.runs === 1 ? '' : 's'}` : 'Dot ball';
};
/** Events whose substance is in their payload: they are undone and entered again, never corrected by changing a side or an action. */
const NO_CORRECT = new Set(['ball', 'innings_end', 'declare', 'follow_on', 'lineup', 'server', 'round_card', 'result', 'added_time', 'period_start', 'period_end', 'note']);
const clockOf = (s) => (s == null ? '' : `${Math.floor(s / 60)}'`);
const LIVE_STATE = { scheduled: 'scheduled', live: 'live', provisional: 'finished', final: 'completed', corrected: 'completed' };
const LIVE_LABEL = { provisional: 'PROVISIONAL', final: 'FINAL', corrected: 'CORRECTED', live: 'LIVE', scheduled: 'UPCOMING' };

/** Players on the pitch for one side, from the declared lineup: a tap picks who the next event is for. No lineup, no row. */
function PlayerQuick({ rows, side, name, value, onChange }) {
  const list = rows.filter((r) => r.side === side);
  if (!list.length) return null;
  return (
    <View style={{ gap: 6 }}>
      <AT size={11.5} weight="800" color={A.mute}>{`${String(name).toUpperCase()} · WHO WAS IT? (OPTIONAL)`}</AT>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {list.map((r) => <AChip key={r.user_id} label={r.display_name} active={value === r.user_id} onPress={() => onChange(value === r.user_id ? null : r.user_id)} />)}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Match Centre
export function MatchCentre({ id }) {
  const { toast } = useSession();
  const { push: go } = useNav();
  const L = useLayout();
  const { state: g, mode, push, refresh, revoked } = useLiveFixture(id);
  const proj = useLoad(() => api.get(`/fixtures/${id}/projection`), [id, g?.version]);
  const lineup = useLoad(() => (g?.viewer?.can_score ? api.get(`/fixtures/${id}/appearances`).catch(() => null) : Promise.resolve(null)), [id, !!g?.viewer?.can_score, g?.fixture?.status]);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null); // 'undo' | 'end' | null
  const [fix, setFix] = useState(null); // event being corrected
  const [who, setWho] = useState({ home: null, away: null });
  const [order, setOrder] = useState(null); // side whose batting order is being picked
  const seen = useRef(0);
  if (g && g.last_seq > seen.current) seen.current = g.last_seq; // what this device has seen, plus its own sent taps

  // every tap goes through the queue: kept on the device, retried, and never counted twice (client_key)
  const queue = useScoreQueue(`sa_queue_fx_${id}`,
    async (e) => { const r = await api.post(`/fixtures/${id}/events`, e); seen.current = Math.max(seen.current, r.state.last_seq); push(r.state); return r; },
    { onDrop: (err) => toast('' + err.message) });

  if (!g) return <AScreen><Loading /></AScreen>;
  const f = g.fixture, rs = g.ruleset, ph = g.phase, v = g.viewer ?? {};
  const names = { home: f.home?.name ?? 'Home', away: f.away?.name ?? 'Away' };
  const scorer = !!v.can_score && !revoked;
  const run = async (fn) => { setBusy(true); try { return await fn(); } catch (x) { toast('' + x.message); return null; } finally { setBusy(false); } };
  const control = (path) => run(async () => push(await api.post(`/fixtures/${id}/${path}`)));
  const log = async (kind, side, extra = {}) => {
    const elapsed = f.started_at ? Math.max(0, Math.floor((Date.now() - new Date(f.started_at)) / 1000)) : undefined;
    const pid = side ? who[side] : null;
    const r = await queue.enqueue({ kind, ...(side ? { side } : {}), ...(extra.period ? { period: extra.period } : {}), ...(extra.payload ? { payload: extra.payload } : {}), ...(pid ? { player_id: pid } : {}), clock_seconds: elapsed, expected_seq: seen.current });
    if (pid && side) setWho((w) => ({ ...w, [side]: null }));
    if (r.queued && !r.full) toast('Not sent yet. It is kept on this device and will be retried.');
    return !r.queued;
  };
  const events = g.events;
  const lastLogged = [...events].reverse().find((e) => !e.voided_at && !['period_start', 'period_end', 'note'].includes(e.kind));
  const label = (kind) => [...(rs.events ?? []), ...(rs.stats ?? [])].find((x) => x.kind === kind)?.label
    ?? ({ point: 'Point', ball: 'Ball', server: 'Server set', retire: 'Retirement', walkover: 'Walkover', shootout_goal: 'Shoot-out: scored', shootout_miss: 'Shoot-out: missed', lineup: 'Batting order', innings_end: 'Innings ended', declare: 'Declared', period_start: 'Period started', period_end: 'Period ended', added_time: 'Added time', round_card: 'Round card', result: 'Result' }[kind] ?? kind.replace(/_/g, ' '));
  const live = f.status === 'live';
  const between = rs.kind === 'points_events' && ph.period > 0 && !ph.period_open && !ph.extra_time_available && !ph.shootout_available;
  const canPoint = live && ph.can_score && !between && !(g.score.shootout?.started);
  const games = rs.kind === 'sets' && rs.racket?.scoring === 'games';
  const sides = ['home', 'away'];
  const lineRows = (lineup.data?.appearances ?? []).filter((a) => !a.hidden && ['started', 'substitute_on'].includes(a.status) && a.off_clock_seconds == null)
    .map((a) => ({ ...a, side: a.team_id === f.home?.id ? 'home' : a.team_id === f.away?.id ? 'away' : null })).filter((a) => a.side);
  const what = (e) => (e.kind === 'ball' ? ballText(e.payload)
    : e.kind === 'round_card' ? `Judge ${e.payload?.judge} · round ${e.payload?.round}: ${e.payload?.home}–${e.payload?.away}`
    : e.kind === 'result' ? (e.payload?.outcome === 'draw' ? 'Drawn' : `${names[e.payload?.outcome] ?? ''} won`) + (e.payload?.method ? ` · ${e.payload.method}` : '')
    : e.kind === 'added_time' ? `Added time: ${e.payload?.minutes}′` : label(e.kind));
  const describe = (e) => `${what(e)}${e.side ? ` · ${names[e.side]}` : ''}`;

  // the cricket scorebook is the existing component; it is handed the fixture's live state in the shape it already reads
  const declared = g.score.cricket?.lineup ?? {};
  const nameOfPlayer = (uid) => lineup.data?.appearances?.find((a) => a.user_id === uid)?.display_name;
  const book = rs.kind === 'cricket' ? { template: { ruleset: rs }, result: g.score, status: live ? 'in_progress' : f.status, labels: names, entries: events,
    details: { players: Object.fromEntries(sides.map((sd) => [sd, (declared[sd] ?? []).map((uid) => ({ name: nameOfPlayer(uid) ?? '' }))])) } } : null;

  const pad = scorer ? (
    <View style={{ gap: 14 }}>
      {f.status === 'scheduled' ? <ABtn title="⚡ Kick off" tone="live" onPress={() => control('start')} loading={busy} /> : null}
      {f.status === 'paused' ? <ABtn title="▶ Resume play" tone="lime" onPress={() => control('resume')} loading={busy} /> : null}
      {(f.status === 'finished' || f.status === 'completed') ? <ABtn title="📝 Open the score sheet" tone="neon" onPress={() => go('ScoreSheet', { id })} /> : null}

      {live ? (
        <>
          {(rs.kind === 'manual' || (rs.kind === 'points_events' && (ph.period_open || !(rs.extra_time || rs.shootout) || ph.period < ph.periods_total))) ? (
            <ABtn tone={ph.period_open ? 'ghost' : 'neon'} small title={ph.period_open ? `⏹ End ${rs.periods.label.toLowerCase()} ${ph.period}` : `▶ Start ${rs.periods.label.toLowerCase()} ${ph.period + 1}`} onPress={() => log(ph.period_open ? 'period_end' : 'period_start')} />
          ) : null}
          {between ? <AT size={12.5} weight="700" color={A.sun}>Between {rs.periods.label.toLowerCase()}s: start the next one to score.</AT> : null}
          {rs.kind === 'sets' && !ph.can_score ? <AT size={13} weight="800" color={A.green}>Match decided. Tap Full time.</AT> : null}
          {rs.kind === 'points_events' ? <AddedTimeBar g={g} disabled={busy} onLog={log} /> : null}
          {rs.kind === 'points_events' ? <FootballExtras g={g} names={names} disabled={busy} onLog={log} /> : null}

          {rs.kind === 'cricket' ? (
            <View style={{ gap: 10 }}>
              {lineRows.length ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{sides.map((sd) => lineRows.some((r) => r.side === sd) ? <ABtn key={sd} small tone="ghost" title={`${declared[sd]?.length ? '✎' : '＋'} ${names[sd]} batting order`} onPress={() => setOrder(sd)} /> : null)}</View> : null}
            <View style={{ backgroundColor: '#F8FAFC', borderRadius: 22, padding: 12 }}>
              <CricketScorer s={book} record={(kind, side, x = {}) => log(kind, side, x)} undo={() => setAsk('undo')} patch={() => {}} busy={busy} />
            </View>
            </View>
          ) : games ? (
            <>
              <RacketPad g={g} names={names} disabled={busy} onLog={log} />
              {sides.map((s) => <PlayerQuick key={s} rows={lineRows} side={s} name={names[s]} value={who[s]} onChange={(x) => setWho((w) => ({ ...w, [s]: x }))} />)}
            </>
          ) : rs.cards ? (
            <CardsPad g={g} names={names} disabled={busy} onLog={log} />
          ) : rs.kind === 'manual' ? (
            <OutcomePad g={g} names={names} disabled={busy} onLog={log} />
          ) : (
            <>
              <ASection title="Score" sub={rs.kind === 'sets' ? 'Every rally point' : 'Tap the moment it happens'} />
              {rs.kind === 'sets' ? <ServerPick g={g} names={names} onLog={log} /> : null}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {sides.map((s) => (
                  <View key={s} style={{ flex: 1, gap: 8 }}>
                    <AT size={12} weight="800" color={A.mute} numberOfLines={1} style={{ textAlign: 'center' }}>{names[s].toUpperCase()}{g.score.server === s ? '  🏸' : ''}</AT>
                    {(rs.kind === 'sets' ? [{ kind: 'point', label: 'Point', points: 1, icon: '🏸' }] : rs.events ?? []).map((e) => (
                      <ABtn key={e.kind} tone={s === 'home' ? 'hero' : 'neon'} title={`${e.icon ? `${e.icon} ` : ''}${e.label}${rs.kind === 'sets' ? '' : ` +${e.points}`}`} disabled={!canPoint || busy} onPress={() => log(e.kind, s)} style={{ minHeight: 56 }} />
                    ))}
                  </View>
                ))}
              </View>
              {sides.map((s) => <PlayerQuick key={s} rows={lineRows} side={s} name={names[s]} value={who[s]} onChange={(x) => setWho((w) => ({ ...w, [s]: x }))} />)}
            </>
          )}

          {(rs.basketball || rs.kabaddi || rs.rally) ? <RulesPanel g={g} names={names} disabled={busy} onLog={log} playerName={nameOfPlayer} /> : null}

          {rs.stats?.length && rs.kind !== 'cricket' && (rs.kind !== 'manual' || rs.cards) ? (
            <>
              <ASection title="Track" sub="Fouls, cards, timeouts" />
              <ACard pad={12} style={{ gap: 8 }}>
                {rs.stats.filter((st) => !(rs.rally && ['technical_timeout', 'interval', 'change_ends'].includes(st.kind))).map((st) => (
                  <View key={st.kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <AT size={13} weight="700" style={{ flex: 1 }}>{st.icon ? `${st.icon} ` : ''}{st.label}</AT>
                    <AT size={12} weight="800" color={A.mute} num>{g.score.stats?.home?.[st.kind] ?? 0} – {g.score.stats?.away?.[st.kind] ?? 0}</AT>
                    {sides.map((s) => <AChip key={s} label={s === 'home' ? 'Home' : 'Away'} color={s === 'home' ? A.magenta : A.cyan} onPress={() => log(st.kind, s)} />)}
                  </View>
                ))}
              </ACard>
            </>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <ABtn small tone="ghost" title="↩ Undo last" disabled={!lastLogged || busy} onPress={() => setAsk('undo')} />
            {lastLogged && !NO_CORRECT.has(lastLogged.kind) ? <ABtn small tone="ghost" title="✎ Correct last" disabled={busy} onPress={() => setFix(lastLogged)} /> : null}
            <ABtn small tone="sun" title="⏸ Pause" onPress={() => control('pause')} loading={busy} />
            <ABtn small tone="live" title="🏁 Full time" onPress={() => setAsk('end')} />
          </View>
        </>
      ) : null}
    </View>
  ) : null;

  const timeline = (
    <>
      <ASection title="Timeline" sub={`${events.filter((e) => !e.voided_at).length} moment${events.filter((e) => !e.voided_at).length === 1 ? '' : 's'}`} />
      {!events.length ? <AEmpty emoji="⏱️" title="Nothing yet" sub="Moments appear here as they happen." /> : (
        <View style={{ gap: 8 }}>
          {[...events].reverse().map((e) => (
            <ACard key={e.id ?? e.seq} pad={12} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: e.voided_at ? 0.45 : 1 }}>
              <AT size={12} weight="800" color={A.cyan} style={{ width: 38 }}>{clockOf(e.clock_seconds) || `#${e.seq}`}</AT>
              <View style={{ flex: 1 }}>
                <AT size={14} weight="800" style={e.voided_at ? { textDecorationLine: 'line-through' } : null}>{what(e)}{e.side ? ` · ${names[e.side]}` : ''}</AT>
                {e.voided_at ? <AT size={11.5} color={A.mute}>{/^Corrected/.test(e.void_reason ?? '') ? `${e.void_reason} (replaced by a later entry)` : `Voided: ${e.void_reason}`}</AT>
                  : <AT size={11.5} color={A.mute}>{[e.period ? `${rs.periods?.label ?? 'Period'} ${e.period}` : null, e.supersedes_id || e.corrects_seq ? '✎ corrected entry' : null].filter(Boolean).join(' · ')}</AT>}
              </View>
              {scorer && live && !e.voided_at && !NO_CORRECT.has(e.kind) ? (
                <Pressable onPress={() => setFix(e)} accessibilityRole="button" accessibilityLabel={`Correct ${describe(e)}`} hitSlop={8} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><AT size={18}>✎</AT></Pressable>
              ) : null}
            </ACard>
          ))}
        </View>
      )}
    </>
  );

  const split = L.tablet && scorer;
  return (
    <AScreen>
      <ScoreTicker g={g} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {['provisional', 'final', 'corrected'].includes(g.live?.state) ? <LiveBadge status={LIVE_STATE[g.live.state]} label={LIVE_LABEL[g.live.state]} /> : null}
        {g.live?.corrected && g.live.state === 'live' ? <AT size={12} weight="800" color={A.sun}>✎ includes corrections</AT> : null}
        {scorer ? <SyncLine pending={queue.pending.length} onRetry={queue.flush} mode={mode} /> : <AT size={12} weight="700" color={mode === 'stream' ? A.green : A.mute}>{mode === 'stream' ? '⚡ Live updates' : mode === 'polling' ? '↻ Refreshing every few seconds' : 'Connecting…'}</AT>}
        <View style={{ flex: 1 }} />
        <Pressable onPress={refresh} accessibilityRole="button" accessibilityLabel="Refresh" hitSlop={10} style={{ minHeight: 44, justifyContent: 'center' }}><AT size={12} weight="800" color={A.cyan}>Refresh</AT></Pressable>
      </View>
      {revoked ? <ACard pad={12} tone={A.sun}><AT size={13} weight="800">Your scoring access for this game has ended. You are now watching.</AT></ACard> : null}
      {!scorer && !revoked ? <AT size={13} color={A.mute}>You are watching. Only the organiser and match officials can score.</AT> : null}

      <View style={{ flexDirection: split ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
        {pad ? <View style={{ flex: split ? 1.2 : undefined, width: split ? undefined : '100%', gap: 14 }}>{pad}</View> : null}
        <View style={{ flex: split ? 1 : undefined, width: split ? undefined : '100%', gap: 14 }}>
          <ProjectionCard p={proj.data} names={names} />
          {timeline}
        </View>
      </View>

      {scorer || v.manages ? <AppearancesPanel id={id} f={f} names={names} viewer={v} /> : null}
      <RecapCard id={id} f={f} />

      <ReasonSheet visible={ask === 'undo'} onClose={() => setAsk(null)} title="Undo the last moment" sub={lastLogged ? `${describe(lastLogged)} will be voided and the score recomputed. It stays in the log.` : ''}
        presets={['Wrong team', 'Wrong action', 'Disallowed by referee', 'Review overturned']} confirmLabel="Void it" tone="sun"
        onConfirm={(reason) => run(async () => push(await api.post(`/match-events/${lastLogged.id}/void`, { reason })))} />
      {fix ? <CorrectSheet event={fix} rs={rs} names={names} label={label} onClose={() => setFix(null)} onSubmit={async (body) => { const r = await api.post(`/match-events/${body.id}/correct`, { ...body, id: undefined }); push(r.state); toast('Corrected. The original stays in the log.'); }} /> : null}
      {order ? <BattingOrderSheet name={names[order]} players={lineRows.filter((r) => r.side === order)} value={declared[order] ?? []} onClose={() => setOrder(null)} onSave={async (ids) => { await log('lineup', null, { payload: { [order]: ids } }); setOrder(null); }} /> : null}
      <ConflictSheet conflict={queue.conflict} describe={describe} names={names} onResend={() => queue.resolve('resend')} onDiscard={() => queue.resolve('discard')} />
      <Sheet visible={ask === 'end'} onClose={() => setAsk(null)} title="Full time?">
        <T size={14} color="#475569">This ends the match and opens the score sheet, pre-filled from what you logged. The result is not official until it is signed, approved and published.</T>
        {queue.pending.length ? <T size={13} color="#B45309">{queue.pending.length} tap{queue.pending.length === 1 ? ' is' : 's are'} still waiting to be sent. Send them first so the sheet is complete.</T> : null}
        <ABtn title="🏁 Yes, full time" tone="live" loading={busy} disabled={queue.pending.length > 0} onPress={async () => { const r = await run(() => api.post(`/fixtures/${id}/end`)); if (r) { setAsk(null); refresh(); go('ScoreSheet', { id }); } }} />
      </Sheet>
    </AScreen>
  );
}
/** Shareable recap, written by Claude when AI is on and by built-in rules otherwise. */
function RecapCard({ id, f }) {
  const { toast } = useSession();
  const [tone, setTone] = useState('hype');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!['live', 'paused', 'finished', 'completed'].includes(f.status)) return null;
  const make = async (t) => {
    setTone(t); setBusy(true);
    try { setOut(await api.post(`/fixtures/${id}/ai/recap`, { tone: t })); } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <>
      <ASection title="Recap" sub="Ready to share" />
      <ACard tone={out ? A.violet : undefined}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {[['hype', '🔥 Hype'], ['neutral', 'Neutral'], ['formal', 'Formal']].map(([k, l]) => <AChip key={k} label={l} active={out && tone === k} onPress={() => make(k)} />)}
        </View>
        {busy ? <AT size={13} color={A.mute} style={{ marginTop: 10 }}>Writing…</AT> : null}
        {out && !busy ? (
          <View style={{ marginTop: 12, gap: 6 }}>
            <AT size={19} weight="900">{out.headline}</AT>
            <AT size={14} weight="500" color={A.ink} style={{ lineHeight: 21 }}>{out.body}</AT>
            {out.hashtags?.length ? <AT size={13} weight="700" color={A.cyan}>{out.hashtags.join(' ')}</AT> : null}
            <AT size={11} color={A.mute}>{out.ai ? 'Written by AI from the match log' : 'Built-in summary (AI is off)'}{out.official ? ' · official result' : ' · not official yet'}</AT>
          </View>
        ) : null}
      </ACard>
    </>
  );
}

// ---------------------------------------------------------------- Games tab of the event console
/** Live games, the schedule by day, planning tools and the knockout bracket. Results are entered through the match centre and score sheet only. */
export function FixturesTab({ id, isOrg, games, accepted, venues, bracket, reload, goVenue }) {
  const { toast } = useSession();
  const { push } = useNav();
  const ticker = useLoad(() => api.get(`/events/${id}/live`), [id]);
  const [view, setView] = useState('schedule');
  const [fix, setFix] = useState(null);
  const [busy, setBusy] = useState(false);
  usePoll(ticker.reload, 6000);
  const inPlay = ticker.data ?? [];
  const playing = new Set(inPlay.map((g) => g.fixture.id));
  const waiting = games.filter((x) => x.status === 'finished' && !playing.has(x.id));
  const open = (g) => push('MatchCentre', { id: g.id ?? g.fixture?.id });
  const check = async () => {
    setBusy(true);
    try { setFix(await api.post(`/events/${id}/ai/schedule-fix`, { min_rest_min: 30 })); } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <>
      <ASection title="Happening now" sub={inPlay.length ? 'Tap a game to open its match centre' : undefined} />
      {inPlay.length ? inPlay.map((g) => <ScoreTicker key={g.fixture.id} g={g} onPress={() => open(g)} compact />) : <AEmpty emoji="📺" title="No game is on" sub="Live and just-finished games show up here." />}
      {waiting.map((x) => <ACard key={x.id} onPress={() => push('ScoreSheet', { id: x.id })} pad={14} tone={A.cyan}><AT weight="800">📝 {x.home_name} vs {x.away_name} is at full time: score sheet waiting</AT></ACard>)}

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <AChip label="🗓️ Schedule" active={view === 'schedule'} onPress={() => setView('schedule')} />
        <AChip label="🏆 Bracket" active={view === 'bracket'} onPress={() => setView('bracket')} />
      </View>

      {view === 'schedule' ? (
        <>
          <ASection title="Games" sub={games.length ? `${games.length} scheduled` : undefined} action={isOrg && games.length ? 'Check clashes' : undefined} onAction={check} />
          {busy ? <AT size={13} color={A.mute}>Checking the schedule…</AT> : null}
          <GamesByDay games={games} onOpen={open} />
          {isOrg ? <SchedulePlanner id={id} accepted={accepted} venues={venues} reload={reload} goVenue={goVenue} /> : null}
        </>
      ) : isOrg ? <StageDesk id={id} accepted={accepted} openGame={open} reload={reload} /> : <StagesView id={id} openGame={open} />}

      <Sheet visible={!!fix} onClose={() => setFix(null)} title={fix?.ok ? 'Schedule is clean ✅' : 'Schedule clashes'}>
        {fix ? (
          <>
            <T size={14} color="#334155">{fix.advice}</T>
            {fix.ai ? <T size={11} color="#64748B">Advice written by AI. Proposed times come from the built-in clash check.</T> : null}
            {fix.proposals?.map((p) => {
              const g = games.find((x) => x.id === p.fixture_id);
              return <T key={p.fixture_id} weight="700">{g ? `${g.home_name ?? 'TBD'} vs ${g.away_name ?? 'TBD'}` : 'Game'} → move to {new Date(p.move_to).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</T>;
            })}
          </>
        ) : null}
      </Sheet>
    </>
  );
}
