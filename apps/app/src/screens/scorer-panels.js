// Pieces of the scorer's screen that sit around the score itself: the rules in force, match details and team lists, picking who scored,
// and the heat / field results table for athletics and other timed or measured sports. None of them adds a score up: results,
// places and qualifiers come back from the server with the sheet.
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useNav } from '../nav';
import { Btn, Card, Chip, Field, H2, HScroll, Seg, T, Tag } from '../ui';
import { c } from '../theme';

const OFFICIALS = {
  football: [['referee', 'Referee'], ['ar1', 'Assistant referee 1'], ['ar2', 'Assistant referee 2'], ['fourth', 'Fourth official'], ['var', 'VAR']],
  futsal: [['referee', 'Referee'], ['second', 'Second referee'], ['third', 'Third referee'], ['timekeeper', 'Timekeeper']],
  cricket: [['umpire1', 'Umpire 1'], ['umpire2', 'Umpire 2'], ['third_umpire', 'Third umpire'], ['match_referee', 'Match referee'], ['scorer', 'Scorer']],
  hockey: [['umpire1', 'Umpire 1'], ['umpire2', 'Umpire 2'], ['video', 'Video umpire'], ['technical', 'Technical officer']],
  'ice-hockey': [['referee1', 'Referee 1'], ['referee2', 'Referee 2'], ['linesman1', 'Linesman 1'], ['linesman2', 'Linesman 2'], ['scorer', 'Official scorer']],
  rugby: [['referee', 'Referee'], ['ar1', 'Assistant referee 1'], ['ar2', 'Assistant referee 2'], ['tmo', 'TMO']],
  'american-football': [['referee', 'Referee'], ['umpire', 'Umpire'], ['head_linesman', 'Head linesman'], ['line_judge', 'Line judge']],
  athletics: [['chief_judge', 'Chief judge'], ['starter', 'Starter'], ['photo_finish', 'Photo-finish judge'], ['timekeeper', 'Timekeeper']],
  chess: [['arbiter', 'Arbiter']],
};
const INFO = [['competition', 'Competition'], ['match_no', 'Match no.'], ['round', 'Round / group'], ['weather', 'Weather / ground']];
const TEAM_SPORTS = new Set(['football', 'futsal', 'hockey', 'ice-hockey', 'rugby', 'rugby-sevens', 'american-football', 'baseball', 'cricket', 'handball', 'basketball', 'volleyball', 'netball', 'water-polo', 'kabaddi', 'lacrosse']);

/** The rules this sheet is played under: the standard rulebook, or a named set of local rules with what differs. */
export function RulesBanner({ s }) {
  const { push } = useNav();
  const r = s.rules;
  const sport = s.template.layout.sport;
  return (
    <Card pad={12} color={r?.local ? c.orangeSoft : c.paper} accessibilityLabel="Rules in force">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" size={13} style={{ flex: 1 }}>{r?.local ? `Local rules: ${r.local.name} (v${r.local.version})` : 'Standard rules'}</T>
        <Btn small title="Read the rules" color={c.violet} onPress={() => push('SportRules', { sport, tab: 'rulebook' })} />
      </View>
      {(r?.lines ?? []).map((l) => <T key={l} size={12}>{l}</T>)}
      {!r?.lines?.length ? <T size={12} color={c.mute}>No local changes: the sport&apos;s standard rules apply.</T> : null}
    </Card>
  );
}

/** Team list for one side: number, name, captain, goalkeeper, substitute. */
function Roster({ side, label, rows, onChange, size }) {
  const set = (i, patch) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      {rows.map((p, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}>
          <View style={{ width: 62 }}><Field label={i === 0 ? 'No.' : undefined} value={p.no ?? ''} onChangeText={(v) => set(i, { no: v.replace(/[^0-9A-Za-z]/g, '').slice(0, 3) })} keyboardType="number-pad" accessibilityLabel={`${label} player ${i + 1} number`} /></View>
          <View style={{ flex: 1 }}><Field label={i === 0 ? 'Player' : undefined} value={p.name ?? ''} onChangeText={(v) => set(i, { name: v })} maxLength={60} accessibilityLabel={`${label} player ${i + 1} name`} /></View>
          <Chip label="C" active={!!p.captain} onPress={() => set(i, { captain: !p.captain })} />
          {size !== 11 ? <Chip label="GK" active={!!p.gk} onPress={() => set(i, { gk: !p.gk })} /> : null}
          {size !== 11 ? <Chip label="Sub" active={p.role === 'sub'} onPress={() => set(i, { role: p.role === 'sub' ? 'starter' : 'sub' })} /> : null}
        </View>
      ))}
      <Btn small title="+ Add player" color={c.violet} onPress={() => onChange([...rows, { no: '', name: '', role: size === 11 && rows.length >= 11 ? 'sub' : 'starter', captain: false, gk: false, pos: '' }])} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}

/** Match details around the score: header fields, officials and both team lists (saved beside the sheet, never part of the score). */
export function DetailsPanel({ s, patch, roster = true }) {
  const [open, setOpen] = useState(false);
  const slug = s.template.layout.sport;
  const d = s.details ?? {};
  const [info, setInfo] = useState(d.info ?? {});
  const [officials, setOfficials] = useState(d.officials ?? {});
  const [players, setPlayers] = useState({ home: d.players?.home ?? [], away: d.players?.away ?? [] });
  const timer = useRef(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => patch({ details: { info, officials, players } }), 800);
    return () => clearTimeout(timer.current);
  }, [info, officials, players]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = s.status === 'in_progress';
  const team = roster && TEAM_SPORTS.has(slug);
  const xi = slug === 'cricket' ? 11 : undefined;
  const seed = (side) => (players[side].length ? players[side] : Array.from({ length: slug === 'cricket' ? 11 : 11 }, (_, i) => ({ no: String(i + 1), name: '', role: 'starter', captain: false, gk: false, pos: '' })));
  const filled = Object.values(info).filter(Boolean).length + Object.values(officials).filter(Boolean).length + players.home.length + players.away.length;
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" style={{ flex: 1 }}>Match details{team ? ', teams' : ''} and officials</T>
        {filled ? <Tag label={`${filled} filled`} color={c.mintSoft} /> : null}
        <Btn small title={open ? 'Hide' : 'Open'} color={c.violet} onPress={() => setOpen(!open)} />
      </View>
      {open ? (
        <View style={{ gap: 12, marginTop: 8 }}>
          <T size={12} color={c.mute}>Kept with the sheet and printed on the PDF. It never changes the score.</T>
          {INFO.map(([k, l]) => <Field key={k} label={l} value={info[k] ?? ''} onChangeText={(v) => setInfo((x) => ({ ...x, [k]: v }))} maxLength={200} />)}
          <T weight="800" size={13}>Officials</T>
          {(OFFICIALS[slug] ?? [['referee', 'Referee / judge'], ['scorer', 'Scorer'], ['timekeeper', 'Timekeeper']]).map(([k, l]) => <Field key={k} label={l} value={officials[k] ?? ''} onChangeText={(v) => setOfficials((x) => ({ ...x, [k]: v }))} maxLength={80} />)}
          {team ? (
            <>
              {live ? null : <T size={12} color={c.mute}>This sheet is completed; team lists can no longer change.</T>}
              <Roster side="home" label={`${s.labels.home} · ${slug === 'cricket' ? 'batting order, 11 players' : 'starters then substitutes'}`} rows={seed('home')} onChange={(rows) => setPlayers((p) => ({ ...p, home: rows }))} size={xi} />
              <Roster side="away" label={`${s.labels.away} · ${slug === 'cricket' ? 'batting order, 11 players' : 'starters then substitutes'}`} rows={seed('away')} onChange={(rows) => setPlayers((p) => ({ ...p, away: rows }))} size={xi} />
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** Who scored / who is involved: the players typed into the team list, as large touch targets. */
export function PlayerPick({ s, side, value, onChange, label = 'Player' }) {
  const list = (s.details?.players?.[side] ?? []).filter((p) => p.no);
  if (!list.length) return null;
  return (
    <View style={{ gap: 4 }}>
      <T size={12} weight="800" color={c.mute}>{label}: {s.labels[side]}</T>
      <HScroll>
        {list.map((p) => <Chip key={p.no} label={`${p.no}${p.name ? ` ${p.name.split(' ').slice(-1)[0]}` : ''}`} active={value === p.no} onPress={() => onChange(value === p.no ? null : p.no)} />)}
      </HScroll>
    </View>
  );
}

const STATUS = [{ label: 'Finished', value: '' }, 'DNS', 'DNF', 'DQ'];
const track = (v) => /track|heat/i.test(v ?? '');
const vertical = (v) => /high jump|pole vault/i.test(v ?? '');

/** Heat sheet / field card: lanes or order, reaction, mark; places and Q/q come back from the server as the marks are saved. */
export function HeatSheet({ s, patch }) {
  const layout = s.template.layout, variant = layout.variant ?? '';
  const n = layout.results.rows, unit = layout.results.unit;
  const [rows, setRows] = useState(() => Array.from({ length: n }, (_, i) => ({ order: i + 1, lane: track(variant) ? String(i + 1) : '', ...(s.rows?.[i] ?? {}) })));
  const [saved, setSaved] = useState(true);
  const timer = useRef(null);
  const first = useRef(true);
  const live = s.status === 'in_progress';
  const set = (i, p) => { setSaved(false); setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r))); };
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const last = rows.reduce((m, r, i) => (['name', 'result', 'bib', 'status', 'reaction'].some((k) => r[k]) ? i : m), -1);
      await patch({ rows: rows.slice(0, last + 1).map((r, i) => ({ ...r, order: i + 1 })) });
      setSaved(true);
    }, 800);
    return () => clearTimeout(timer.current);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const rank = s.ranking?.rows ?? [];
  const warn = s.ranking?.warnings ?? [];
  return (
    <View style={{ gap: 10 }}>
      <H2>{layout.form?.title ?? 'Results'}</H2>
      <T size={12} color={c.mute}>{saved ? 'Saved. Places are worked out from the marks.' : 'Saving…'} {unit === 'time' ? 'Type times like 9.83 or 1:45.20.' : unit === 'score' ? 'Type the final score, for example 24.30.' : 'Type distances or heights in metres, like 7.85.'}</T>
      {warn.map((w, i) => <T key={i} size={13} weight="700" color={c.orange} accessibilityRole="alert">⚠ {w.message}</T>)}
      {rows.map((r, i) => (
        <Card key={i} pad={10}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T weight="800" size={18} style={{ width: 26 }}>{track(variant) ? (r.lane || i + 1) : i + 1}</T>
            <View style={{ flex: 1 }}><Field label="Athlete / participant" value={r.name ?? ''} onChangeText={(v) => set(i, { name: v })} maxLength={80} /></View>
            <View style={{ width: 54, alignItems: 'center' }}>
              <T size={11} color={c.mute}>Place</T>
              <T weight="800" size={20}>{r.status || rank[i]?.rank || '–'}</T>
              {rank[i]?.q ? <Tag label={rank[i].q} color={c.mint} /> : null}
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            <View style={{ width: 70 }}><Field label="Bib" value={r.bib ?? ''} onChangeText={(v) => set(i, { bib: v })} maxLength={10} /></View>
            <View style={{ width: 74 }}><Field label="Country" value={r.country ?? ''} onChangeText={(v) => set(i, { country: v.toUpperCase().slice(0, 3) })} maxLength={3} /></View>
            {track(variant) ? <View style={{ width: 90 }}><Field label="Reaction s" value={r.reaction ?? ''} onChangeText={(v) => set(i, { reaction: v })} keyboardType="decimal-pad" maxLength={6} /></View> : null}
            <View style={{ flex: 1, minWidth: 100 }}><Field label={unit === 'time' ? 'Finish time' : unit === 'score' ? 'Final score' : vertical(variant) ? 'Best height (m)' : 'Best mark (m)'} value={r.result ?? ''} onChangeText={(v) => set(i, { result: v })} keyboardType="decimal-pad" maxLength={12} /></View>
          </View>
          {live ? <Seg options={STATUS} value={r.status ?? ''} onChange={(v) => set(i, { status: v })} /> : null}
        </Card>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ boxing
const SIDE_NAME = { red: 'Red corner', blue: 'Blue corner' };
/** A side's own name, or the sport's word for it (Red corner, White, ...) while it still has the default Home / Away. */
const sideName = (s, side, named) => { const l = s.labels?.[side]; return l && l !== (side === 'home' ? 'Home' : 'Away') ? l : named[side === 'home' ? 0 : 1]; };

/** One round on one card: who won it and, for the loser, how many points (9, or less after a deduction). */
function RoundRow({ n, r, onChange, disabled }) {
  const winner = r.red === 10 && r.blue === 10 ? 'even' : r.red > r.blue ? 'red' : 'blue';
  const loser = winner === 'red' ? r.blue : winner === 'blue' ? r.red : 10;
  const set = (w, low) => onChange(w === 'even' ? { red: 10, blue: 10 } : w === 'red' ? { red: 10, blue: low } : { red: low, blue: 10 });
  return (
    <View style={{ gap: 6 }} accessible={false}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800" style={{ width: 56 }}>Round {n}</T>
        <Seg options={[{ label: 'Red', value: 'red' }, { label: 'Even', value: 'even' }, { label: 'Blue', value: 'blue' }]} value={winner} onChange={(w) => !disabled && set(w, loser === 10 ? 9 : loser)} />
        <T weight="800" size={18} style={{ minWidth: 60 }}>{r.red}–{r.blue}</T>
        {winner !== 'even' ? <View style={{ flexDirection: 'row', gap: 6 }}>{[9, 8, 7].map((p) => <Chip key={p} label={`${p}`} active={loser === p} onPress={() => !disabled && set(winner, p)} />)}</View> : null}
      </View>
    </View>
  );
}

/** Boxing: a card per judge, round by round (10-point must). The decision comes back from the server as the cards are saved. */
export function ScoreCards({ s, patch }) {
  const sc = s.template.layout.scorecard;
  const live = s.status === 'in_progress';
  const blank = () => Array.from({ length: sc.rounds }, () => ({ red: 10, blue: 9 }));
  const [cards, setCards] = useState(() => Array.from({ length: Math.max(3, Math.min(sc.judges, 5)) }, (_, j) => ({ judge: s.details?.cards?.[j]?.judge ?? '', rounds: Array.from({ length: sc.rounds }, (_, i) => s.details?.cards?.[j]?.rounds?.[i] ?? null) })));
  const [judge, setJudge] = useState(0);
  const timer = useRef(null);
  const first = useRef(true);
  const done = (j) => cards[j].rounds.filter(Boolean).length;
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => patch({ details: { cards: cards.map((k) => ({ judge: k.judge, rounds: k.rounds.filter(Boolean) })) } }), 700);
    return () => clearTimeout(timer.current);
  }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps
  const setRound = (j, i, v) => setCards((cs) => cs.map((k, a) => (a === j ? { ...k, rounds: k.rounds.map((r, b) => (b === i ? v : r)) } : k)));
  const d = s.scorecard;
  return (
    <View style={{ gap: 12 }}>
      <Card pad={16}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View><T weight="800" size={13}>{sideName(s, 'home', ['Red corner', 'Blue corner'])}</T><T size={34} weight="800">{d?.votes.red ?? 0}</T></View>
          <View style={{ alignItems: 'center' }}><Tag label={`${sc.rounds} rounds × ${sc.minutes} min`} color={c.violetSoft} /><T size={12} color={c.mute}>judges for each corner</T></View>
          <View style={{ alignItems: 'flex-end' }}><T weight="800" size={13}>{sideName(s, 'away', ['Red corner', 'Blue corner'])}</T><T size={34} weight="800">{d?.votes.blue ?? 0}</T></View>
        </View>
        {d?.kind ? <T weight="800" size={15} style={{ textAlign: 'center' }} accessibilityRole="alert">{d.winner === 'draw' ? 'Draw' : `${SIDE_NAME[d.winner]} wins`} · {d.kind}</T> : <T size={12} color={c.mute} style={{ textAlign: 'center' }}>Score each round on a judge&apos;s card. The decision appears when judges have scored.</T>}
      </Card>
      {(d?.problems ?? []).map((p, i) => <T key={i} size={13} weight="700" color={c.orange} accessibilityRole="alert">⚠ {p.message}</T>)}
      <Seg options={cards.map((k, j) => ({ label: `Judge ${j + 1}${done(j) ? ` · ${done(j)}/${sc.rounds}` : ''}`, value: j }))} value={judge} onChange={setJudge} />
      <Field label="Judge's name" value={cards[judge].judge} onChangeText={(v) => setCards((cs) => cs.map((k, a) => (a === judge ? { ...k, judge: v } : k)))} maxLength={60} />
      {cards[judge].rounds.map((r, i) => (
        r ? <RoundRow key={i} n={i + 1} r={r} disabled={!live} onChange={(v) => setRound(judge, i, v)} />
          : <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ width: 56 }}>Round {i + 1}</T><Btn small title="Score this round" color={c.violet} disabled={!live} onPress={() => setRound(judge, i, { red: 10, blue: 9 })} /></View>
      ))}
      {d?.judges?.[judge]?.rounds ? <T weight="800">Card total: {d.judges[judge].red}–{d.judges[judge].blue}{d.judges[judge].winner === 'draw' ? ' (even)' : ''}</T> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ weightlifting
const OK = [{ label: '–', value: 'none' }, { label: 'Good', value: 'good' }, { label: 'No lift', value: 'no' }];
const okOf = (a) => (a?.ok === true ? 'good' : a?.ok === false ? 'no' : 'none');

/** Weightlifting competition card: a lifter per row, three snatch and three clean-and-jerk attempts. Bests, totals and places come from the server. */
export function LiftSheet({ s, patch }) {
  const layout = s.template.layout, n = layout.results.attempts;
  const [rows, setRows] = useState(() => Array.from({ length: layout.results.rows }, (_, i) => ({ order: i + 1, attempts: Array.from({ length: n * 2 }, (_, k) => s.rows?.[i]?.attempts?.[k] ?? { kg: 0, ok: null }), ...(s.rows?.[i] ?? {}) })).map((r) => ({ ...r, attempts: Array.from({ length: n * 2 }, (_, k) => r.attempts?.[k] ?? { kg: 0, ok: null }) })));
  const [open, setOpen] = useState(0);
  const [saved, setSaved] = useState(true);
  const timer = useRef(null);
  const first = useRef(true);
  const live = s.status === 'in_progress';
  const set = (i, p) => { setSaved(false); setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r))); };
  const setAt = (i, k, p) => set(i, { attempts: rows[i].attempts.map((a, b) => (b === k ? { ...a, ...p } : a)) });
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const last = rows.reduce((m, r, i) => (r.name || r.attempts.some((a) => a.kg) ? i : m), -1);
      await patch({ rows: rows.slice(0, last + 1).map((r, i) => ({ order: i + 1, name: r.name, body_kg: r.body_kg || undefined, country: r.country, attempts: r.attempts.map((a) => ({ kg: Math.round(a.kg || 0), ok: a.ok })) })) });
      setSaved(true);
    }, 800);
    return () => clearTimeout(timer.current);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const rank = s.ranking?.rows ?? [];
  return (
    <View style={{ gap: 10 }}>
      <H2>{layout.form?.title}</H2>
      <T size={12} color={c.mute}>{saved ? 'Saved. Bests, totals and places are worked out from the attempts.' : 'Saving…'} Enter the weight, then mark each attempt a good lift or a no lift.</T>
      {(s.ranking?.warnings ?? []).map((w, i) => <T key={i} size={13} weight="700" color={c.orange} accessibilityRole="alert">⚠ {w.message}</T>)}
      {rows.map((r, i) => {
        const x = rank[i];
        const used = r.name || r.attempts.some((a) => a.kg);
        return (
          <Card key={i} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T weight="800" size={16} style={{ width: 26 }}>{i + 1}</T>
              <View style={{ flex: 1 }}><Field label="Lifter" value={r.name ?? ''} onChangeText={(v) => set(i, { name: v })} maxLength={80} /></View>
              <View style={{ alignItems: 'center', width: 70 }}><T size={11} color={c.mute}>Total</T><T weight="800" size={20}>{x?.total ?? '–'}</T>{x?.rank ? <Tag label={`#${x.rank}`} color={c.mint} /> : x?.bust ? <Tag label="bomb out" color={c.orangeSoft} /> : null}</View>
              <Btn small title={open === i ? 'Close' : used ? 'Attempts' : 'Open'} color={c.violet} onPress={() => setOpen(open === i ? -1 : i)} />
            </View>
            {open === i ? (
              <View style={{ gap: 8, marginTop: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}><Field label="Body weight (kg)" value={r.body_kg ? String(r.body_kg) : ''} onChangeText={(v) => set(i, { body_kg: Number(v.replace(',', '.')) || 0 })} keyboardType="decimal-pad" maxLength={6} /></View>
                  <View style={{ width: 90 }}><Field label="Country" value={r.country ?? ''} onChangeText={(v) => set(i, { country: v.toUpperCase().slice(0, 3) })} maxLength={3} /></View>
                </View>
                {['Snatch', 'Clean and jerk'].map((g, gi) => (
                  <View key={g} style={{ gap: 6 }}>
                    <T weight="800" size={13}>{g}{x ? ` · best ${gi ? x.best_cj ?? '–' : x.best_snatch ?? '–'}` : ''}</T>
                    {Array.from({ length: n }, (_, k) => {
                      const idx = gi * n + k, a = r.attempts[idx];
                      return (
                        <View key={k} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
                          <View style={{ width: 100 }}><Field label={`Attempt ${k + 1} (kg)`} value={a.kg ? String(a.kg) : ''} onChangeText={(v) => setAt(i, idx, { kg: Number(v.replace(/[^0-9]/g, '')) || 0 })} keyboardType="number-pad" maxLength={3} /></View>
                          <Seg options={OK} value={okOf(a)} onChange={(v) => live && setAt(i, idx, { ok: v === 'good' ? true : v === 'no' ? false : null })} />
                        </View>
                      );
                    })}
                  </View>
                ))}
              </View>
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ judo and chess
const METHODS = {
  judo: [['ippon', 'Ippon'], ['waza_ari', 'Waza-ari at time'], ['shido', 'Shido (penalty)'], ['golden_score', 'Golden score'], ['hansoku_make', 'Hansoku-make'], ['walkover', 'Walkover / injury']],
  chess: [['checkmate', 'Checkmate'], ['resignation', 'Resignation'], ['time', 'Time forfeit'], ['agreement', 'Draw by agreement'], ['stalemate', 'Stalemate'], ['repetition', 'Repetition'], ['fifty_move', 'Fifty-move rule'], ['material', 'Insufficient material']],
};
const TALLY = { judo: [['ippon', 'Ippon'], ['waza_ari', 'Waza-ari'], ['shido', 'Shido']] };

/** Judo and chess: who won and how, plus the judo score tally or the chess move list. Totals (1-0, 0-1, 0-0) are saved with the sheet. */
export function ContestResult({ s, patch }) {
  const slug = s.template.layout.sport;
  const live = s.status === 'in_progress';
  const contest = s.details?.contest ?? {};
  const tally = s.details?.tally ?? {};
  const [moves, setMoves] = useState(() => (s.details?.moves?.length ? s.details.moves : [['', '']]));
  const timer = useRef(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => patch({ details: { moves: moves.filter(([a, b]) => a || b) } }), 900);
    return () => clearTimeout(timer.current);
  }, [moves]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = slug === 'chess' ? ['White', 'Black'] : slug === 'judo' ? ['White', 'Blue'] : ['Home', 'Away'];
  const result = (winner, method) => patch({ manual_totals: { home: winner === 'home' ? 1 : 0, away: winner === 'away' ? 1 : 0 }, details: { contest: { winner, method: method ?? contest.method } } });
  const bump = (side, k, d) => patch({ details: { tally: { ...tally, [`${side}_${k}`]: Math.max(0, (tally[`${side}_${k}`] ?? 0) + d) } } });
  return (
    <View style={{ gap: 12 }}>
      <Card pad={14}>
        <T weight="800">Result</T>
        <Seg options={[{ label: `${sideName(s, 'home', names)} wins`, value: 'home' }, { label: 'Draw', value: 'draw' }, { label: `${sideName(s, 'away', names)} wins`, value: 'away' }]} value={contest.winner ?? null} onChange={(w) => live && result(w)} />
        <T weight="800" size={13} style={{ marginTop: 8 }}>How it ended</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{METHODS[slug].map(([v, l]) => <Chip key={v} label={l} active={contest.method === v} onPress={() => live && patch({ details: { contest: { winner: contest.winner ?? null, method: v } } })} />)}</View>
      </Card>
      {TALLY[slug] ? (
        <Card pad={14}>
          <T weight="800">Scores and penalties</T>
          {['home', 'away'].map((side) => (
            <View key={side} style={{ gap: 4 }}>
              <T weight="700" size={13}>{sideName(s, side, names)}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {TALLY[slug].map(([k, l]) => <Chip key={k} label={`${l} · ${tally[`${side}_${k}`] ?? 0}`} onPress={() => live && bump(side, k, 1)} />)}
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{TALLY[slug].map(([k, l]) => <Chip key={k} label={`− ${l}`} onPress={() => live && (tally[`${side}_${k}`] ?? 0) > 0 && bump(side, k, -1)} />)}</View>
            </View>
          ))}
        </Card>
      ) : null}
      {slug === 'chess' ? (
        <Card pad={14}>
          <T weight="800">Moves</T>
          <T size={12} color={c.mute}>Write each move in algebraic notation, for example e4 or Nf3. The record is kept with the sheet and printed on the scoresheet.</T>
          {moves.map(([w, b], i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <T weight="800" style={{ width: 30 }}>{i + 1}.</T>
              <View style={{ flex: 1 }}><Field value={w} onChangeText={(v) => setMoves((m) => m.map((x, k) => (k === i ? [v, x[1]] : x)))} maxLength={12} accessibilityLabel={`Move ${i + 1} White`} /></View>
              <View style={{ flex: 1 }}><Field value={b} onChangeText={(v) => setMoves((m) => m.map((x, k) => (k === i ? [x[0], v] : x)))} maxLength={12} accessibilityLabel={`Move ${i + 1} Black`} /></View>
            </View>
          ))}
          {live ? <Btn small title="+ Next move" color={c.violet} onPress={() => setMoves((m) => [...m, ['', '']])} style={{ alignSelf: 'flex-start' }} /> : null}
        </Card>
      ) : null}
    </View>
  );
}
