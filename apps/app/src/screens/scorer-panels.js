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
      <T size={12} color={c.mute}>{saved ? 'Saved. Places are worked out from the marks.' : 'Saving…'} {unit === 'time' ? 'Type times like 9.83 or 1:45.20.' : 'Type distances or heights in metres, like 7.85.'}</T>
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
            <View style={{ flex: 1, minWidth: 100 }}><Field label={unit === 'time' ? 'Finish time' : vertical(variant) ? 'Best height (m)' : 'Best mark (m)'} value={r.result ?? ''} onChangeText={(v) => set(i, { result: v })} keyboardType="decimal-pad" maxLength={12} /></View>
          </View>
          {live ? <Seg options={STATUS} value={r.status ?? ''} onChange={(v) => set(i, { status: v })} /> : null}
        </Card>
      ))}
    </View>
  );
}
