// Lineup, substitutions and verified minutes for one game — a panel of the Match Centre (the single home for running a game), shown to
// the organiser, the match officials and the two team managers. Players come from the team roster; nothing is typed as free text
// except the reason for a correction.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, ABtn, ACard, AChip, AEmpty, ASection, AStepper, AT } from '../arena';
import { Field, Loading, Sheet } from '../ui';

const key = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const STATUS = { started: 'Started', substitute_on: 'Came on', unused_sub: 'Unused sub', dnp: 'Did not play' };
const SOURCE_LABEL = { match_clock: 'from the game clock', scheduled_duration: 'scheduled length, no match clock', staff_entry: 'entered by staff', official_sheet: 'official sheet' };
const fmt = (m) => (m == null ? 'minutes not verified' : `${Math.round(m * 10) / 10} min`);

export function AppearancesPanel({ id, f, names, viewer }) {
  const { toast } = useSession();
  const { data, loading, error, reload } = useLoad(() => api.get(`/fixtures/${id}/appearances`), [id, f.status]);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);
  const [subSide, setSubSide] = useState(null);
  const [lineupSide, setLineupSide] = useState(null);
  const run = async (fn) => { setBusy(true); try { await fn(); reload(); } catch (x) { toast('' + x.message); } finally { setBusy(false); } };
  const sides = ['home', 'away'].filter((s) => viewer.can_score || viewer.manages === s || viewer.manages === 'both');
  if (loading && !data) return <Loading />;
  if (error) return <ACard pad={12}><AT size={13} color={A.mute}>Could not load appearances: {error.message}</AT><ABtn small tone="ghost" title="Try again" onPress={reload} /></ACard>;
  const rows = data?.appearances ?? [];
  const teamOf = (s) => f[`${s}_team_id`] ?? f[s]?.id;
  const live = ['live', 'paused'].includes(f.status);
  const over = ['finished', 'completed'].includes(f.status);

  return (
    <>
      <ASection title="Lineup & minutes" sub="Who actually played, and for how long" />
      {sides.map((s) => {
        const mine = rows.filter((r) => r.team_id === teamOf(s));
        return (
          <ACard key={s} pad={12} style={{ gap: 8 }}>
            <AT size={13} weight="900">{names[s]}</AT>
            {!mine.length ? <AEmpty emoji="📋" title="No lineup yet" sub={f.status === 'scheduled' ? 'Name the starters and the bench before kick-off.' : 'No lineup was recorded for this side.'} /> : mine.map((r) => (
              r.hidden ? <AT key={r.id} size={12.5} color={A.mute}>A young player's details are hidden until a guardian's consent is current.</AT> : (
                <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <View style={{ flex: 1, minWidth: 160 }}>
                    <AT size={14} weight="800">{r.display_name}</AT>
                    <AT size={11.5} color={A.mute}>{STATUS[r.status]}{r.on_clock_seconds ? ` · on ${Math.floor(r.on_clock_seconds / 60)}'` : ''}{r.off_clock_seconds != null ? ` · off ${Math.floor(r.off_clock_seconds / 60)}'` : ''} · {fmt(r.minutes_played)}{r.minutes_basis ? ` (${SOURCE_LABEL[r.minutes_basis]})` : ''}</AT>
                  </View>
                  {r.verified_at ? <AChip label="✔ Verified" active color={A.green} /> : null}
                  <ABtn small tone="ghost" title="Correct" onPress={() => setEdit(r)} />
                </View>
              )))}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {f.status === 'scheduled' ? <ABtn small tone="neon" title={mine.length ? 'Change lineup' : 'Set lineup'} onPress={() => setLineupSide(s)} /> : null}
              {live && mine.length ? <ABtn small tone="sun" title="Substitution" onPress={() => setSubSide(s)} /> : null}
            </View>
          </ACard>
        );
      })}
      {over && viewer.can_score ? <ABtn small tone="ghost" title="Calculate minutes from the game clock" loading={busy} onPress={() => run(async () => { const r = await api.post(`/fixtures/${id}/appearances/finalize`); toast(r.updated ? `${r.updated} updated` : 'Already up to date'); })} /> : null}
      {data?.substitutions?.length ? (
        <ACard pad={12} style={{ gap: 6 }}>
          <AT size={13} weight="900">Substitutions</AT>
          {data.substitutions.map((s) => (
            <View key={s.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <AT size={12} weight="800" color={A.cyan} style={{ width: 38 }}>{Math.floor(s.clock_seconds / 60)}'</AT>
              <AT size={13} style={{ flex: 1, textDecorationLine: s.voided_at ? 'line-through' : 'none' }}>{s.hidden ? 'Hidden' : `${rows.find((r) => r.user_id === s.player_on_id)?.display_name ?? 'Player'} on for ${rows.find((r) => r.user_id === s.player_off_id)?.display_name ?? 'player'}`}</AT>
              {live && viewer.can_score && !s.voided_at && !s.hidden ? <ABtn small tone="ghost" title="Void" onPress={() => run(() => api.post(`/substitutions/${s.id}/void`, { reason: 'Logged by mistake' }))} /> : null}
            </View>
          ))}
        </ACard>
      ) : null}

      {lineupSide ? <LineupSheet side={lineupSide} teamId={teamOf(lineupSide)} current={rows} id={id} onClose={() => setLineupSide(null)} onDone={reload} toast={toast} /> : null}
      {subSide ? <SubSheet side={subSide} rows={rows.filter((r) => r.team_id === teamOf(subSide) && !r.hidden)} f={f} id={id} onClose={() => setSubSide(null)} onDone={reload} toast={toast} /> : null}
      {edit ? <CorrectSheet row={edit} onClose={() => setEdit(null)} onDone={reload} toast={toast} /> : null}
    </>
  );
}

function LineupSheet({ side, teamId, current, id, onClose, onDone, toast }) {
  const { data, loading } = useLoad(() => api.get(`/teams/${teamId}/roster`), [teamId]);
  const [pick, setPick] = useState(() => Object.fromEntries(current.filter((r) => r.team_id === teamId && !r.hidden).map((r) => [r.user_id, r.status === 'started' ? 'start' : 'bench'])));
  const [busy, setBusy] = useState(false);
  const cycle = (u) => setPick((p) => { const n = { ...p }; if (!p[u]) n[u] = 'start'; else if (p[u] === 'start') n[u] = 'bench'; else delete n[u]; return n; });
  const starters = Object.keys(pick).filter((u) => pick[u] === 'start'), bench = Object.keys(pick).filter((u) => pick[u] === 'bench');
  const save = async () => {
    setBusy(true);
    try { await api.post(`/fixtures/${id}/lineup`, { side, starters, bench }); onDone(); onClose(); } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Lineup · ${side}`}>
      <AT size={12.5} color={A.mute}>Tap a player once for starter, twice for bench, three times to remove.</AT>
      {loading ? <Loading /> : !data?.members?.length ? <AEmpty emoji="👥" title="No roster" sub="Add players to the team first." /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {data.members.filter((m) => m.status === 'active').map((m) => <AChip key={m.id} label={`${m.jersey_no != null ? `${m.jersey_no} · ` : ''}${m.display_name}${pick[m.id] === 'start' ? ' ▶' : pick[m.id] === 'bench' ? ' ⇄' : ''}`} active={!!pick[m.id]} color={pick[m.id] === 'bench' ? A.sun : A.green} onPress={() => cycle(m.id)} />)}
        </View>
      )}
      <AT size={12.5} weight="700">{starters.length} starting · {bench.length} on the bench</AT>
      <ABtn title="Save lineup" tone="neon" disabled={!starters.length} loading={busy} onPress={save} />
    </Sheet>
  );
}

function SubSheet({ side, rows, f, id, onClose, onDone, toast }) {
  const onField = rows.filter((r) => ['started', 'substitute_on'].includes(r.status) && r.off_clock_seconds == null);
  const bench = rows.filter((r) => r.status === 'unused_sub');
  const [off, setOff] = useState(null), [on, setOn] = useState(null), [busy, setBusy] = useState(false);
  // starts at the wall-clock minutes since kick-off; the referee adjusts it to the game clock (pauses and half-time do not count)
  const [minute, setMinute] = useState(() => (f.started_at ? Math.max(0, Math.floor((Date.now() - new Date(f.started_at)) / 60000)) : 0));
  const go = async () => {
    setBusy(true);
    try { await api.post(`/fixtures/${id}/substitutions`, { side, player_off_id: off, player_on_id: on, clock_seconds: minute * 60, client_key: key() }); onDone(); onClose(); } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Substitution">
      <AT size={13} weight="800" color="#334155">Coming off</AT>
      {!onField.length ? <AT size={12.5} color={A.mute}>Nobody is on the field.</AT> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{onField.map((r) => <AChip key={r.user_id} label={r.display_name} active={off === r.user_id} color={A.magenta} onPress={() => setOff(r.user_id)} />)}</View>}
      <AT size={13} weight="800" color="#334155">Going on</AT>
      {!bench.length ? <AT size={12.5} color={A.mute}>No unused substitutes left.</AT> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{bench.map((r) => <AChip key={r.user_id} label={r.display_name} active={on === r.user_id} color={A.green} onPress={() => setOn(r.user_id)} />)}</View>}
      <AStepper label="Game minute" value={minute} min={0} max={600} onChange={setMinute} />
      <ABtn title="Confirm substitution" tone="sun" disabled={!off || !on} loading={busy} onPress={go} />
    </Sheet>
  );
}

function CorrectSheet({ row, onClose, onDone, toast }) {
  const [status, setStatus] = useState(row.status);
  const [minutes, setMinutes] = useState(Math.round(row.minutes_played ?? 0));
  const [touched, setTouched] = useState(false);
  const [preset, setPreset] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const nonPlay = ['unused_sub', 'dnp'].includes(status);
  const reason = [preset, note.trim()].filter(Boolean).join(': ');
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/appearances/${row.id}/correct`, { row_version: row.row_version, reason, status, ...(touched && !nonPlay ? { minutes_played: minutes } : {}) });
      onDone(); onClose();
    } catch (x) { toast(x.details?.code === 'stale_version' ? 'Someone else changed this. Reloaded the latest.' : '' + x.message); if (x.details?.code === 'stale_version') { onDone(); onClose(); } } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Correct · ${row.display_name}`}>
      <AT size={13} color={A.mute}>Every correction keeps the earlier value in the history. A source of lower authority cannot overwrite a higher one.</AT>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {Object.entries(STATUS).map(([k, label]) => <AChip key={k} label={label} active={status === k} onPress={() => setStatus(k)} />)}
      </View>
      {!nonPlay ? <AStepper label="Minutes played" value={minutes} min={0} max={600} onChange={(v) => { setTouched(true); setMinutes(v); }} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {['Scorer sheet', 'Referee report', 'Substitution not logged', 'Wrong player'].map((p) => <AChip key={p} label={p} active={preset === p} onPress={() => setPreset(preset === p ? null : p)} />)}
      </View>
      <Field label="Add a note (optional)" value={note} onChangeText={setNote} multiline />
      <ABtn title="Save correction" tone="neon" onPress={save} loading={busy} disabled={reason.length < 3} />
    </Sheet>
  );
}
