// The on-screen cricket scorebook (T10 / T20 / ODI / Test). The scorer taps what happened ball by ball; the server (scoring/cricket.js)
// works out strike, the batting card, bowling figures, extras, fall of wickets, the over grid, the target and the result, and refuses
// what the rules refuse (two overs in a row, an over limit, a batter off a free hit). Nothing here adds a score up.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Field, H2, Seg, Sheet, T, Tag } from '../ui';
import { HScroll } from '../ui';
import { c } from '../theme';

const HOW = [['bowled', 'Bowled'], ['caught', 'Caught'], ['lbw', 'LBW'], ['run_out', 'Run out'], ['stumped', 'Stumped'], ['hit_wicket', 'Hit wicket'], ['handled_ball', 'Handled the ball'], ['obstructing', 'Obstructing the field'], ['hit_twice', 'Hit the ball twice'], ['timed_out', 'Timed out']];
const howText = (h) => (HOW.find((x) => x[0] === h)?.[1] ?? h ?? '').toLowerCase();
const oversText = (legal) => `${Math.floor(legal / 6)}${legal % 6 ? `.${legal % 6}` : ''}`;
const nameOf = (s, side, idx, fallback) => s.details?.players?.[side]?.[idx]?.name?.trim() || `${fallback} ${idx + 1}`;
const other = (side) => (side === 'home' ? 'away' : 'home');

function Pad({ label, sub, onPress, color = c.paper, ink = c.ink, disabled, flex = 1, big }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityLabel={sub ? `${label}, ${sub}` : label}
      style={({ pressed }) => ({ flex, minWidth: 64, minHeight: big ? 76 : 60, borderRadius: 18, backgroundColor: disabled ? c.violetSoft : color, borderWidth: 1, borderColor: c.line ?? '#ddd', alignItems: 'center', justifyContent: 'center', padding: 6, opacity: pressed ? 0.75 : disabled ? 0.5 : 1 })}>
      <T size={big ? 26 : 20} weight="800" color={disabled ? c.mute : ink}>{label}</T>
      {sub ? <T size={11} color={disabled ? c.mute : ink}>{sub}</T> : null}
    </Pressable>
  );
}

const Cell = ({ children, w = 48, bold, left, color }) => <T size={12} weight={bold ? '800' : '500'} color={color} style={{ width: w, textAlign: left ? 'left' : 'right' }} numberOfLines={1}>{children}</T>;

function Ball({ b }) {
  const bg = b.wicket ? c.red : b.four || b.six ? c.mint : b.extra ? c.sun : c.paper;
  return (
    <View accessible accessibilityLabel={`Ball ${b.sym}`} style={{ minWidth: 30, height: 30, borderRadius: 15, paddingHorizontal: 4, backgroundColor: bg, borderWidth: 1.5, borderColor: b.free_hit ? c.pink : c.ink, borderStyle: b.extra ? 'dashed' : 'solid', alignItems: 'center', justifyContent: 'center' }}>
      <T size={11} weight="800" color={b.wicket ? '#fff' : c.ink}>{b.sym}</T>
    </View>
  );
}

function WicketSheet({ s, cs, inn, onClose, onDone }) {
  const [how, setHow] = useState('bowled');
  const [who, setWho] = useState('striker');
  const [fielder, setFielder] = useState('');
  const [runs, setRuns] = useState(0);
  const bat = inn.side;
  const runOutLike = ['run_out', 'obstructing', 'handled_ball'].includes(how);
  return (
    <Sheet visible onClose={onClose} title="Wicket">
      <View style={{ gap: 12 }}>
        <T weight="800" size={13}>How out</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{HOW.map(([v, l]) => <Chip key={v} label={l} active={how === v} onPress={() => { setHow(v); if (!['run_out', 'obstructing', 'handled_ball'].includes(v)) setWho('striker'); }} />)}</View>
        <T weight="800" size={13}>Who is out</T>
        <Seg options={[{ label: `Striker · ${nameOf(s, bat, inn.striker, 'Batter')}`, value: 'striker' }, ...(runOutLike ? [{ label: `Non-striker · ${nameOf(s, bat, inn.non_striker, 'Batter')}`, value: 'non_striker' }] : [])]} value={who} onChange={setWho} />
        {['caught', 'stumped', 'run_out'].includes(how) ? <Field label={how === 'caught' ? 'Caught by' : how === 'stumped' ? 'Wicket-keeper' : 'Fielder who ran them out'} value={fielder} onChangeText={setFielder} maxLength={60} /> : null}
        {runOutLike ? (<><T weight="800" size={13}>Runs completed before the run out</T><View style={{ flexDirection: 'row', gap: 8 }}>{[0, 1, 2, 3].map((n) => <Chip key={n} label={String(n)} active={runs === n} onPress={() => setRuns(n)} />)}</View></>) : null}
        <Btn title="Record wicket" color={c.red} onPress={() => onDone({ runs: runOutLike ? runs : 0, wicket: { how, out: who, ...(fielder.trim() ? { fielder: fielder.trim() } : {}) } })} />
      </View>
    </Sheet>
  );
}

/** Extras: choose the kind, then how many runs came with it. */
function ExtraSheet({ kind, c: cfg, onClose, onDone }) {
  const label = { wd: 'Wide', nb: 'No-ball', b: 'Byes', lb: 'Leg byes', pen: 'Penalty runs' }[kind];
  const [bat, setBat] = useState(0);
  const options = kind === 'wd' ? [0, 1, 2, 3, 4] : kind === 'pen' ? [5] : [1, 2, 3, 4];
  return (
    <Sheet visible onClose={onClose} title={label}>
      <View style={{ gap: 12 }}>
        {kind === 'nb' ? (<><T weight="800" size={13}>Runs off the bat</T><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{[0, 1, 2, 3, 4, 6].map((n) => <Chip key={n} label={String(n)} active={bat === n} onPress={() => setBat(n)} />)}</View></>) : null}
        <T weight="800" size={13}>{kind === 'wd' ? `Runs run on top of the ${cfg.wide_runs} penalty` : kind === 'nb' ? `Byes run on top of the ${cfg.noball_runs} penalty (usually none)` : kind === 'pen' ? 'Penalty runs awarded' : 'Runs'}</T>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          {(kind === 'nb' ? [0, 1, 2, 3, 4] : options).map((n) => <Pad key={n} label={String(n)} onPress={() => onDone({ runs: kind === 'nb' ? bat : 0, extra: kind, extra_runs: n })} />)}
        </View>
        <T size={12} color={c.mute}>{kind === 'wd' || kind === 'nb' ? 'Not a legal ball: the over is not used up.' : kind === 'pen' ? 'Penalty runs do not use a ball.' : 'Credited as extras, not to the batter or the bowler.'}</T>
      </View>
    </Sheet>
  );
}

export function CricketScorer({ s, record, undo, patch, busy }) {
  const L = useLayout();
  const cfg = s.template.ruleset.cricket;
  const cs = s.result.cricket ?? { innings: [], over: false, current: { n: 0, side: null, closed: true }, home: 0, away: 0, wickets: { home: 0, away: 0 } };
  const test = cfg.format === 'Test';
  const live = s.status === 'in_progress';
  const [first, setFirst] = useState('home');
  const [view, setView] = useState(null);
  const [bowler, setBowler] = useState(0);
  const [wicket, setWicket] = useState(false);
  const [extra, setExtra] = useState(null);
  const [injury, setInjury] = useState(false);
  const [book, setBook] = useState(false);

  const shown = view ?? cs.current.n ?? 0;
  const inn = cs.innings.find((i) => i.n === shown) ?? cs.innings[cs.innings.length - 1] ?? null;
  const cur = cs.innings[cs.innings.length - 1] ?? null;
  const open = cur && !cur.closed;
  const nextN = open ? cur.n : cs.innings.length + 1;
  const batting = open ? cur.side : cs.innings.length ? (nextN === 2 ? other(cs.first_side) : nextN === 3 ? (cs.follow_on ? other(cs.first_side) : cs.first_side) : (cs.follow_on ? cs.first_side : other(cs.first_side))) : first;
  const fielding = other(batting);
  const canBat = live && !cs.over && nextN <= cfg.innings;
  const bq = cfg.bowler_max;
  const bw = open ? cur.bowlers[bowler] : null;
  const midOver = open && cur.over_bowler != null; // an over is under way (a ball, a wide or a no-ball has been bowled in it)
  const mustBowler = midOver && cur.over_bowler !== bowler && !injury;
  const quota = bq && bw && bw.legal >= bq * 6;
  const sameAsLast = open && !midOver && cur.prev_over_bowler === bowler;
  const blocked = !canBat || (open && cur.closed);
  const why = quota ? `Bowler has bowled the maximum ${bq} overs` : sameAsLast ? 'The same bowler cannot bowl two overs in a row' : mustBowler ? 'The bowler must finish the over' : null;
  const disabled = busy || blocked || !!why;
  const total = (side) => `${cs[side]}/${cs.wickets[side]}`;
  const send = (p) => record('ball', batting, { period: nextN, payload: { bowler, ...(injury && midOver ? { bowler_change: true } : {}), ...p } }).then((ok) => { if (ok !== false) setInjury(false); });
  const label = (side) => s.labels[side];
  const lastOver = cur?.overs?.[cur.overs.length - 1] ?? [];
  const showOver = open && cur.legal % 6 === 0 && cur.overs.length && !lastOver.length ? [] : lastOver;

  return (
    <View style={{ gap: 14 }}>
      {/* scoreboard */}
      <Card pad={16} color={c.paper}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flex: 1 }}><T weight="800" size={13} numberOfLines={1}>{label('home')}</T><T size={30} weight="800">{total('home')}</T></View>
          <View style={{ alignItems: 'center' }}>
            <Tag label={`${cfg.format}${cfg.overs ? ` · ${cfg.overs} overs` : ` · ${cfg.days ?? 5} days`}`} color={c.violetSoft} />
            {open ? <T size={13} color={c.mute}>Innings {cur.n} · {oversText(cur.legal)}{cfg.overs ? ` / ${cfg.overs}` : ''} ov</T> : null}
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}><T weight="800" size={13} numberOfLines={1}>{label('away')}</T><T size={30} weight="800">{total('away')}</T></View>
        </View>
        {open ? <T size={12} color={c.mute} style={{ textAlign: 'center' }}>Run rate {cur.legal ? (cur.runs / (cur.legal / 6)).toFixed(2) : '0.00'}{cs.to_win ? ` · ${label(cur.side)} need ${cs.to_win}${cs.balls_left != null ? ` from ${cs.balls_left} balls` : ''}` : ''}{test && cs.lead != null ? ` · lead ${cs.lead}` : ''}</T> : null}
        {cs.result ? <T weight="800" size={16} color={c.mint} style={{ textAlign: 'center', marginTop: 6 }} accessibilityRole="alert">{cs.result.text.split('Home').join(label('home')).split('Away').join(label('away'))}</T> : null}
      </Card>

      {cs.innings.length > 1 ? <Seg options={cs.innings.map((i) => ({ label: `Innings ${i.n}`, value: i.n }))} value={shown} onChange={setView} /> : null}

      {/* before the first ball: who bats */}
      {live && !cs.innings.length ? (
        <Card pad={14}>
          <T weight="800">Toss: who bats first?</T>
          <Seg options={[{ label: label('home'), value: 'home' }, { label: label('away'), value: 'away' }]} value={first} onChange={setFirst} />
          <T size={12} color={c.mute}>Add the two XIs under “Teams” below to see names on the card, or just score with batter and bowler numbers.</T>
        </Card>
      ) : null}

      {/* the scoring pad */}
      {live && canBat ? (
        <View style={{ gap: 10 }}>
          <Card pad={14}>
            {open ? (
              <View style={{ gap: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">🏏 {nameOf(s, batting, cur.striker, 'Batter')}*</T><T weight="800">{cur.batters[cur.striker].runs} ({cur.batters[cur.striker].balls})</T></View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T>{nameOf(s, batting, cur.non_striker, 'Batter')}</T><T>{cur.batters[cur.non_striker].runs} ({cur.batters[cur.non_striker].balls})</T></View>
              </View>
            ) : <T weight="800">{label(batting)} to bat (innings {nextN})</T>}
            <T weight="800" size={13} style={{ marginTop: 8 }}>Bowling</T>
            <HScroll>
              {Array.from({ length: 11 }, (_, i) => {
                const b = open ? cur.bowlers[i] : null;
                return <Chip key={i} label={`${nameOf(s, fielding, i, 'Bowler')}${b ? ` ${oversText(b.legal)}-${b.runs}-${b.wickets}` : ''}`} active={bowler === i} onPress={() => setBowler(i)} />;
              })}
            </HScroll>
            {why ? <T size={12} weight="700" color={c.orange} accessibilityRole="alert">{why}</T> : null}
            {midOver ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Chip label="Injury change of bowler" active={injury} onPress={() => setInjury(!injury)} /></View> : null}
            {open && cur.free_hit ? <Tag label="FREE HIT" color={c.pink} /> : null}
          </Card>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            {[0, 1, 2, 3].map((n) => <Pad key={n} label={n === 0 ? '•' : String(n)} sub={n === 0 ? 'dot' : undefined} disabled={disabled} onPress={() => send({ runs: n })} big />)}
          </View>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Pad label="4" color={c.mintSoft} disabled={disabled} onPress={() => send({ runs: 4 })} big />
            <Pad label="6" color={c.mintSoft} disabled={disabled} onPress={() => send({ runs: 6 })} big />
            <Pad label="5" sub="runs" disabled={disabled} onPress={() => send({ runs: 5 })} />
            <Pad label="W" sub="wicket" color={c.red} ink="#fff" disabled={disabled} onPress={() => setWicket(true)} big />
          </View>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Pad label="Wd" sub="wide" color={c.sunSoft ?? c.paper} disabled={disabled} onPress={() => setExtra('wd')} />
            <Pad label="Nb" sub="no-ball" color={c.sunSoft ?? c.paper} disabled={disabled} onPress={() => setExtra('nb')} />
            <Pad label="B" sub="bye" disabled={disabled} onPress={() => setExtra('b')} />
            <Pad label="Lb" sub="leg bye" disabled={disabled} onPress={() => setExtra('lb')} />
            <Pad label="Pen" sub="penalty" disabled={disabled || !open} onPress={() => setExtra('pen')} />
          </View>
        </View>
      ) : null}

      {live ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn title="↩︎ Undo last ball" color={c.violet} disabled={!s.entries.some((e) => !e.voided_at)} onPress={undo} />
          {open ? <Btn small title="End innings" color={c.violet} onPress={() => record('innings_end', batting, { period: cur.n })} /> : null}
          {test && open ? <Btn small title="Declare" color={c.violet} onPress={() => record('declare', batting, { period: cur.n })} /> : null}
          {test && cs.innings.length === 2 && cur.closed && !cs.follow_on ? <Btn small title="Enforce follow-on" color={c.violet} onPress={() => record('follow_on', fielding)} /> : null}
          {!cs.over && cs.innings.length ? <><Btn small title="Draw" color={c.violet} onPress={() => record('result', batting, { payload: { outcome: 'draw' } })} /><Btn small title="Abandoned" color={c.violet} onPress={() => record('result', batting, { payload: { outcome: 'abandoned' } })} /></> : null}
        </View>
      ) : null}

      {/* this over */}
      {open ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>This over</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{showOver.length ? showOver.map((b, i) => <Ball key={i} b={b} />) : <T size={12} color={c.mute}>New over</T>}</View>
        </View>
      ) : null}

      {/* the scorebook */}
      {inn ? (
        <View style={{ gap: 12 }}>
          <H2>Batting · {label(inn.side)} · innings {inn.n}</H2>
          <HScroll>
            <View>
              <View style={{ flexDirection: 'row' }}><Cell w={170} left bold>Batter</Cell><Cell w={150} left bold>How out</Cell><Cell bold>R</Cell><Cell bold>B</Cell><Cell bold>4s</Cell><Cell bold>6s</Cell><Cell w={56} bold>SR</Cell></View>
              {inn.batters.filter((b) => b.arrived).map((b) => (
                <View key={b.idx} style={{ flexDirection: 'row', paddingVertical: 3 }}>
                  <Cell w={170} left bold={!b.out}>{nameOf(s, inn.side, b.idx, 'Batter')}{!b.out && !inn.closed && (inn.striker === b.idx) ? ' *' : ''}</Cell>
                  <Cell w={150} left color={c.mute}>{b.out ? `${howText(b.out.how)}${b.out.bowler != null ? ` b ${nameOf(s, other(inn.side), b.out.bowler, 'Bowler')}` : ''}${b.out.fielder ? ` (${b.out.fielder})` : ''}` : inn.closed ? 'not out' : 'batting'}</Cell>
                  <Cell bold>{b.runs}</Cell><Cell>{b.balls}</Cell><Cell>{b.fours}</Cell><Cell>{b.sixes}</Cell><Cell w={56}>{b.balls ? ((b.runs * 100) / b.balls).toFixed(1) : '–'}</Cell>
                </View>
              ))}
            </View>
          </HScroll>
          <T size={13}>Extras {inn.extras.wd + inn.extras.nb + inn.extras.b + inn.extras.lb + inn.extras.pen} <T size={12} color={c.mute}>(w {inn.extras.wd}, nb {inn.extras.nb}, b {inn.extras.b}, lb {inn.extras.lb}{inn.extras.pen ? `, pen ${inn.extras.pen}` : ''})</T> · <T weight="800" size={13}>Total {inn.runs}/{inn.wickets} ({oversText(inn.legal)} ov)</T></T>
          <H2>Bowling · {label(other(inn.side))}</H2>
          <HScroll>
            <View>
              <View style={{ flexDirection: 'row' }}><Cell w={170} left bold>Bowler</Cell><Cell bold>O</Cell><Cell bold>M</Cell><Cell bold>R</Cell><Cell bold>W</Cell><Cell bold>Wd</Cell><Cell bold>Nb</Cell><Cell w={56} bold>Econ</Cell></View>
              {Object.values(inn.bowlers).sort((a, b) => a.idx - b.idx).map((b) => {
                const maidens = Object.values(b.by_over).filter((o) => o.legal === 6 && o.runs === 0).length;
                return (
                  <View key={b.idx} style={{ flexDirection: 'row', paddingVertical: 3 }}>
                    <Cell w={170} left>{nameOf(s, other(inn.side), b.idx, 'Bowler')}</Cell><Cell>{oversText(b.legal)}</Cell><Cell>{maidens}</Cell><Cell>{b.runs}</Cell><Cell bold>{b.wickets}</Cell><Cell>{b.wd}</Cell><Cell>{b.nb}</Cell><Cell w={56}>{b.legal ? (b.runs / (b.legal / 6)).toFixed(1) : '–'}</Cell>
                  </View>
                );
              })}
            </View>
          </HScroll>
          {inn.fow.length ? <T size={13}><T weight="800" size={13}>Fall of wickets: </T>{inn.fow.map((f) => `${f.n}-${f.runs} (${nameOf(s, inn.side, f.batter, 'Batter')}, ${f.over} ov)`).join(', ')}</T> : null}
          <Btn small title={book ? 'Hide the ball-by-ball book' : 'Show the ball-by-ball book'} color={c.violet} onPress={() => setBook(!book)} style={{ alignSelf: 'flex-start' }} />
          {book ? inn.overs.map((o, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <T size={12} weight="800" color={c.mute} style={{ width: 54 }}>Over {i + 1}</T>
              <T size={12} color={c.mute} style={{ width: 90 }} numberOfLines={1}>{nameOf(s, other(inn.side), o[0]?.bowler ?? 0, 'Bowler')}</T>
              <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap', flex: 1 }}>{o.map((b, k) => <Ball key={k} b={b} />)}</View>
            </View>
          )) : null}
        </View>
      ) : null}

      {wicket && open ? <WicketSheet s={s} cs={cs} inn={cur} onClose={() => setWicket(false)} onDone={(p) => { setWicket(false); send(p); }} /> : null}
      {extra ? <ExtraSheet kind={extra} c={cfg} onClose={() => setExtra(null)} onDone={(p) => { setExtra(null); send(p); }} /> : null}
    </View>
  );
}
