// The Match Centre, and the Games tab of the event console: the referee's live console (kick off, score with the sport's own buttons, track
// fouls and cards, undo, pause, full time) that doubles as a live scoreboard for everyone else.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLiveFixture, usePoll } from '../live';
import { useSession } from '../session';
import { useNav } from '../nav';
import { A, ABracket, ABtn, ACard, AChip, AEmpty, AScreen, ASection, AT, ReasonSheet, ScoreTicker } from '../arena';
import { Loading, Sheet, T } from '../ui';
import { GamesByDay, SchedulePlanner } from './event-schedule';

const key = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const clockOf = (s) => (s == null ? '' : `${Math.floor(s / 60)}'`);

// ---------------------------------------------------------------- Match Centre
export function MatchCentre({ id }) {
  const { toast } = useSession();
  const { push: go } = useNav();
  const { state: g, mode, push, refresh } = useLiveFixture(id);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null); // 'undo' | 'end' | null
  if (!g) return <AScreen><Loading /></AScreen>;
  const f = g.fixture, rs = g.ruleset, ph = g.phase, v = g.viewer ?? {};
  const names = { home: f.home?.name ?? 'Home', away: f.away?.name ?? 'Away' };
  const scorer = !!v.can_score;
  const run = async (fn) => { setBusy(true); try { return await fn(); } catch (x) { toast('' + x.message); return null; } finally { setBusy(false); } };
  const control = (path) => run(async () => push(await api.post(`/fixtures/${id}/${path}`)));
  const log = (kind, side) => run(async () => {
    const elapsed = f.started_at ? Math.max(0, Math.floor((Date.now() - new Date(f.started_at)) / 1000)) : undefined;
    const r = await api.post(`/fixtures/${id}/events`, { kind, side, clock_seconds: elapsed, client_key: key() });
    push(r.state);
  });
  const lastLogged = [...g.events].reverse().find((e) => !['period_start', 'period_end', 'note'].includes(e.kind));
  const label = (kind) => [...(rs.events ?? []), ...(rs.stats ?? [])].find((x) => x.kind === kind)?.label ?? (kind === 'point' ? 'Point' : kind.replace(/_/g, ' '));
  const live = f.status === 'live';
  const between = rs.kind === 'points_events' && ph.period > 0 && !ph.period_open;
  const canPoint = live && ph.can_score && !between;
  const sides = ['home', 'away'];

  return (
    <AScreen>
      <ScoreTicker g={g} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <AT size={12} weight="700" color={mode === 'stream' ? A.green : A.mute}>{mode === 'stream' ? '⚡ Live updates' : mode === 'polling' ? '↻ Refreshing every few seconds' : 'Connecting…'}</AT>
        <Pressable onPress={refresh} hitSlop={10}><AT size={12} weight="800" color={A.cyan}>Refresh</AT></Pressable>
      </View>

      {scorer ? (
        <>
          {f.status === 'scheduled' ? <ABtn title="⚡ Kick off" tone="live" onPress={() => control('start')} loading={busy} /> : null}
          {f.status === 'paused' ? <ABtn title="▶ Resume play" tone="lime" onPress={() => control('resume')} loading={busy} /> : null}
          {(f.status === 'finished' || f.status === 'completed') ? <ABtn title="📝 Open the score sheet" tone="neon" onPress={() => go('ScoreSheet', { id })} /> : null}

          {live ? (
            <>
              {rs.kind === 'points_events' ? (
                <ABtn tone={ph.period_open ? 'ghost' : 'neon'} small title={ph.period_open ? `⏹ End ${rs.periods.label.toLowerCase()} ${ph.period}` : `▶ Start ${rs.periods.label.toLowerCase()} ${ph.period + 1}`} onPress={() => log(ph.period_open ? 'period_end' : 'period_start')} loading={busy} />
              ) : null}
              {between ? <AT size={12.5} weight="700" color={A.sun}>Between {rs.periods.label.toLowerCase()}s: start the next one to score.</AT> : null}
              {rs.kind === 'sets' && !ph.can_score ? <AT size={13} weight="800" color={A.green}>Match decided. Tap Full time.</AT> : null}

              <ASection title="Score" sub={rs.kind === 'sets' ? 'Every rally point' : 'Tap the moment it happens'} />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {sides.map((s) => (
                  <View key={s} style={{ flex: 1, gap: 8 }}>
                    <AT size={12} weight="800" color={A.mute} numberOfLines={1} style={{ textAlign: 'center' }}>{names[s].toUpperCase()}</AT>
                    {(rs.kind === 'sets' ? [{ kind: 'point', label: 'Point', points: 1, icon: '🏸' }] : rs.events).map((e) => (
                      <ABtn key={e.kind} tone={s === 'home' ? 'hero' : 'neon'} title={`${e.icon ? `${e.icon} ` : ''}${e.label}${rs.kind === 'sets' ? '' : ` +${e.points}`}`} disabled={!canPoint || busy} onPress={() => log(e.kind, s)} />
                    ))}
                  </View>
                ))}
              </View>

              {rs.stats?.length ? (
                <>
                  <ASection title="Track" sub="Fouls, cards, timeouts" />
                  <ACard pad={12} style={{ gap: 8 }}>
                    {rs.stats.map((st) => (
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
                <ABtn small tone="sun" title="⏸ Pause" onPress={() => control('pause')} loading={busy} />
                <ABtn small tone="live" title="🏁 Full time" onPress={() => setAsk('end')} />
              </View>
            </>
          ) : null}
        </>
      ) : <AT size={13} color={A.mute}>You are watching. Only the organiser and match officials can score.</AT>}

      <ASection title="Timeline" sub={`${g.events.length} moment${g.events.length === 1 ? '' : 's'}`} />
      {!g.events.length ? <AEmpty emoji="⏱️" title="Nothing yet" sub="Moments appear here as they happen." /> : (
        <View style={{ gap: 8 }}>
          {[...g.events].reverse().map((e) => (
            <ACard key={e.id} pad={12} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: e.voided_at ? 0.45 : 1 }}>
              <AT size={12} weight="800" color={A.cyan} style={{ width: 38 }}>{clockOf(e.clock_seconds) || `#${e.seq}`}</AT>
              <View style={{ flex: 1 }}>
                <AT size={14} weight="800" style={e.voided_at ? { textDecorationLine: 'line-through' } : null}>{label(e.kind)}{e.side ? ` · ${names[e.side]}` : ''}</AT>
                {e.voided_at ? <AT size={11.5} color={A.mute}>Voided: {e.void_reason}</AT> : e.period ? <AT size={11.5} color={A.mute}>{rs.periods?.label ?? 'Period'} {e.period}</AT> : null}
              </View>
            </ACard>
          ))}
        </View>
      )}
      <RecapCard id={id} f={f} />

      <ReasonSheet visible={ask === 'undo'} onClose={() => setAsk(null)} title="Undo the last moment" sub={lastLogged ? `${label(lastLogged.kind)}${lastLogged.side ? ` · ${names[lastLogged.side]}` : ''} will be voided and the score recomputed. It stays in the log.` : ''}
        presets={['Wrong team', 'Wrong action', 'Disallowed by referee', 'Review overturned']} confirmLabel="Void it" tone="sun"
        onConfirm={(reason) => run(async () => push(await api.post(`/match-events/${lastLogged.id}/void`, { reason })))} />
      <Sheet visible={ask === 'end'} onClose={() => setAsk(null)} title="Full time?">
        <T size={14} color="#475569">This ends the match and opens the score sheet, pre-filled from what you logged. The result is not official until it is signed, approved and published.</T>
        <ABtn title="🏁 Yes, full time" tone="live" loading={busy} onPress={async () => { const r = await run(() => api.post(`/fixtures/${id}/end`)); if (r) { setAsk(null); refresh(); go('ScoreSheet', { id }); } }} />
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
      ) : bracket?.rounds?.length ? <ABracket data={bracket} onGame={open} /> : (
        <AEmpty emoji="🏆" title="No knockout yet" sub="Seed the teams, book courts, then plan a knockout: quarter-finals, semi-finals and the final fill in as results are published." action={isOrg ? 'Plan the knockout' : undefined} onAction={() => setView('schedule')} />
      )}

      <Sheet visible={!!fix} onClose={() => setFix(null)} title={fix?.ok ? 'Schedule is clean ✅' : 'Schedule clashes'}>
        {fix ? (
          <>
            <T size={14} color="#334155">{fix.advice}</T>
            {fix.ai ? <T size={11} color="#64748B">Advice written by AI. Proposed times come from the built-in clash check.</T> : null}
            {fix.proposals?.map((p) => {
              const g = games.find((x) => x.id === p.fixture_id);
              return <T key={p.fixture_id} weight="700">{g ? `${g.home_name ?? 'TBD'} vs ${g.away_name ?? 'TBD'}` : 'Game'} → move to {new Date(p.move_to).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</T>;
            })}
          </>
        ) : null}
      </Sheet>
    </>
  );
}
