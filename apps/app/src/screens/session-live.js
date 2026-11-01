// Live heat / final / field flight: call room, start, splits, finishes or attempts, provisional places and the step to the official
// result. It lives inside the session sheet of the Games screen (the one place sessions are run) and is read-only for everyone who is
// not the organiser or an assigned official. The server derives places and Q/q from what is recorded; nothing here ranks anyone.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLiveSession } from '../live';
import { useSession } from '../session';
import { Btn, Chip, Loading, Sheet, T } from '../ui';
import { A, ABtn, ACard, AChip, AT, ATag, LiveBadge } from '../arena';
import { Counter } from '../pickers';
import { useScoreQueue } from '../scorer/queue';
import { useSavedSession } from '../scorer/pack';
import { projectSession, sessionReject } from '../scorer/local';
import { ConflictSheet, OfflineBanner, SyncLine } from '../scorer/panels';
import { c } from '../theme';

// the same Arena look as the Match Centre: a heat is scored on a midnight scoreboard wherever it is opened
const STATE = { scheduled: ['scheduled', 'NOT STARTED'], live: ['live', 'LIVE'], provisional: ['finished', 'PROVISIONAL'], final: ['completed', 'OFFICIAL'], corrected: ['completed', 'CORRECTED'] };
const STEPS = [['call_room', 'Call room'], ['ready', 'Ready'], ['in_progress', 'In progress']];
const pad2 = (n) => String(n).padStart(2, '0');

/** A race time or a measured distance built from steppers, never typed: minutes, seconds, hundredths / metres, centimetres. */
export function MarkInput({ type, onChange }) {
  const [a, setA] = useState(0), [b, setB] = useState(0), [d, setD] = useState(0);
  const emit = (x, y, z) => onChange(type === 'time' ? x * 60 + y + z / 100 : type === 'distance' ? x + y / 100 : x);
  if (type === 'score') return <Counter label="Points" value={a} min={0} max={9999} onChange={(v) => { setA(v); emit(v, 0, 0); }} />;
  const time = type === 'time';
  return (
    <View style={{ gap: 8 }}>
      <Counter label={time ? 'Minutes' : 'Metres'} value={a} min={0} max={time ? 59 : 99} onChange={(v) => { setA(v); emit(v, b, d); }} />
      <Counter label={time ? 'Seconds' : 'Centimetres'} value={b} min={0} max={time ? 59 : 99} onChange={(v) => { setB(v); emit(a, v, d); }} />
      {time ? <Counter label="Hundredths" value={d} min={0} max={99} onChange={(v) => { setD(v); emit(a, b, v); }} /> : null}
      <T weight="800" size={16} accessibilityLiveRegion="polite">{time ? `${a ? `${a}:${pad2(b)}` : b}.${pad2(d)} s` : `${a}.${pad2(b)} m`}</T>
    </View>
  );
}
const showMark = (type, v) => (v == null ? '–' : type === 'time' ? (v >= 60 ? `${Math.floor(v / 60)}:${(v % 60).toFixed(2).padStart(5, '0')}` : v.toFixed(2)) : type === 'distance' ? `${v.toFixed(2)} m` : String(v));

export function SessionLive({ id, toast, onFinalised, framed = true }) {
  const { user } = useSession();
  const feed = useLiveSession(id);
  const { state: live, mode, push, revoked } = feed;
  const pack = useSavedSession(user?.id, id, live);   // the encrypted copy of this heat for scoring with no signal
  const [sheet, setSheet] = useState(null); // {kind, entry}
  const [mark, setMark] = useState(0);
  const [dist, setDist] = useState(50);
  const [round, setRound] = useState(1);
  const [outcome, setOutcome] = useState('valid');
  const [judge, setJudge] = useState(1);
  const [mult, setMult] = useState(1);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const seen = React.useRef(0);
  const seenNow = Math.max(live?.last_seq ?? 0, pack.saved?.last_seq ?? 0);
  if (seenNow > seen.current) seen.current = seenNow;
  const queue = useScoreQueue(`sa_queue_ss_${id}`,
    async ({ owner, op, target, ...e }) => {
      if (op === 'void') { const r = await api.post(`/session-events/${target}/void`, { reason: e.reason, client_key: e.client_key }); push(r); return r; }   // undo of a saved entry: queued like a tap, sent once, in order
      if (op === 'finalize') { const r = await api.post(`/sessions/${id}/finalize-live`); push(r.live); onFinalised?.(); return r; }                  // re-running re-records, so a retry is safe
      const r = await api.post(`/sessions/${id}/events`, e); seen.current = Math.max(seen.current, r.state.last_seq); push(r.state); return r;
    },
    { onDrop: (err) => toast('' + err.message), owner: user?.id });

  // With no signal the saved copy stands in and the waiting entries are applied on top of it by the same pure plugin the server runs.
  const offline = !live || (!!feed.error && !feed.error.status);
  const useSaved = !!pack.saved && (offline || queue.pending.length > 0) && pack.saved.last_seq >= (live?.last_seq ?? 0);
  const s = useMemo(() => (useSaved ? projectSession(pack.saved, queue.pending) : live), [useSaved, pack.saved, queue.pending, live]);
  if (!s) return pack.ready && feed.error ? (
    <ACard pad={16} tone={A.sun}>
      <AT size={14} weight="800">No connection, and this heat is not saved on this device.</AT>
      <AT size={13} color={A.mute}>Open it once while online, or save the day's heats from Officials home, and it keeps working with no signal.</AT>
      <ABtn small title="Try again" tone="neon" onPress={feed.refresh} style={{ marginTop: 10 }} />
    </ACard>
  ) : <Loading />;

  const pr = s.projection, type = s.session.result_type, field = pr.kind === 'field', panel = pr.aggregate === 'panel';
  const scorer = !!s.viewer?.can_score && !revoked;
  const official = ['final', 'corrected'].includes(s.live.state);
  const [badge, badgeLabel] = STATE[s.live.state] ?? STATE.scheduled;
  const send = async (kind, entry, payload = {}) => {
    if (useSaved) { const bad = sessionReject(s, kind, entry?.entry_id, payload); if (bad) { toast(bad); return false; } }   // the plugin's own refusals, answered at once offline
    const r = await queue.enqueue({ kind, ...(entry ? { entry_id: entry.entry_id } : {}), payload, expected_seq: seen.current });
    if (r.queued && !r.full) toast('Not sent yet. It is kept on this device and will be retried.');
    return !r.queued;
  };
  const lastEvent = [...(s.events ?? [])].reverse().find((e) => !e.voided && e.id);
  const describe = (e) => `${e.kind.replace('_', ' ')}${e.payload?.value != null ? ` ${showMark(type, e.payload.value)}` : ''}`;
  const open = (kind, entry) => {
    if (kind === 'judge') {
      const r = Math.max(1, ...entry.panel.map((m) => m.round ?? 1));
      const used = new Set(entry.panel.filter((m) => m.round === r).map((m) => m.judge));
      setJudge([...Array(20).keys()].map((k) => k + 1).find((j) => !used.has(j)) ?? 1); setRound(r); setMark(entry.panel.length ? entry.panel[entry.panel.length - 1].value : 5); setMult(entry.panel.length ? entry.panel[entry.panel.length - 1].multiplier ?? 1 : 1);
      setSheet({ kind, entry }); return;
    }
    setMark(0); setOutcome('valid'); setDist(Math.min(50 * ((entry.splits?.length ?? 0) + 1), 1000));
    setRound(Math.max(1, ...entry.attempts.map((a) => a.round ?? 0)) + (entry.attempts.length ? 1 : 0));
    setSheet({ kind, entry });
  };
  const submit = async () => {
    const { kind, entry } = sheet;
    setBusy(true);
    try {
      if (kind === 'finish') await send('finish', entry, { value: mark });
      else if (kind === 'split') await send('split', entry, { distance_m: dist, value: mark });
      else if (kind === 'attempt') await send('attempt', entry, { round, outcome, ...(outcome === 'valid' ? { value: mark } : {}) });
      else if (kind === 'judge') await send('judge_score', entry, { judge, round, value: mark, ...(mult !== 1 ? { multiplier: mult } : {}) });
      else await send('entry_status', entry, { status: kind, reason: outcome === 'valid' ? undefined : outcome });
      setSheet(null);
    } finally { setBusy(false); }
  };
  const finalise = async () => {
    setBusy(true);
    try {
      const r = await queue.enqueue({ op: 'finalize' });   // sent now, or kept on this device and sent after the entries when the signal returns
      setConfirm(false);
      toast(r.queued ? 'Saved on this device. The result is recorded as soon as there is a signal.' : 'Result recorded. It is now official.');
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  const undo = async () => {
    if (lastEvent.local) { queue.cancel(String(lastEvent.id).slice(6)); return; }   // not sent yet: just take it back
    const r = await queue.enqueue({ op: 'void', target: lastEvent.id, reason: 'Entered by mistake' });
    if (r.queued && !r.full) toast('Undo saved on this device. It is sent as soon as there is a signal.');
  };

  const FRAME = framed ? { backgroundColor: A.bg, borderRadius: 24, padding: 14 } : null;
  const body = (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <LiveBadge status={badge} label={badgeLabel} />
        {pr.status && !official ? <AT size={12} weight="800" color={A.mute}>{STEPS.find((x) => x[0] === pr.status)?.[1] ?? pr.status.replace('_', ' ')}</AT> : null}
        <AT size={12} weight="700" color={mode === 'stream' ? A.green : A.mute}>{mode === 'stream' ? '⚡ Live' : '↻ Refreshing'}</AT>
      </View>
      {!official ? <AT size={12.5} color={A.mute}>Places shown here are provisional. They become official when the result is recorded.</AT> : null}
      {revoked ? <AT size={13} weight="800" color={A.red}>Your scoring access for this session has ended.</AT> : null}

      {scorer && !official ? (
        <View style={{ gap: 10 }}>
          <OfflineBanner offline={offline} saved={!!pack.saved} savedTime={pack.savedAt ? new Date(pack.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null} waiting={queue.pending.length} full={queue.full} foreign={queue.foreign} />
          <SyncLine pending={queue.pending.length} onRetry={queue.flush} offline={offline} />
          {s.finalizing ? <ATag label="Result waiting to be recorded" tone={A.sun} /> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {STEPS.slice(0, 2).map(([k, l]) => <AChip key={k} label={l} active={pr.status === k} onPress={() => send('status', null, { status: k })} />)}
            <ABtn small title="▶ Start the race" tone="live" disabled={pr.status === 'in_progress' || pr.status === 'provisional'} onPress={() => send('start', null, {})} />
          </View>
        </View>
      ) : null}

      <View style={{ gap: 10 }}>
        {pr.entries.map((e) => {
          const out = ['dns', 'dnf', 'dq'].includes(e.status);
          const last = e.splits?.[e.splits.length - 1];
          const sub = [out ? e.status.toUpperCase() : e.best != null ? showMark(type, e.best) : e.status === 'competing' ? 'competing' : 'waiting', last ? `split ${showMark('time', last.value)} @ ${last.distance_m} m` : null, field && !panel && e.attempts.length ? `${e.attempts.length} attempt${e.attempts.length === 1 ? '' : 's'}` : null, panel && e.rounds?.length ? e.rounds.map((r) => `R${r.round}: ${r.mark} (${r.judges} judge${r.judges === 1 ? '' : 's'})`).join(', ') : null].filter(Boolean).join(' · ');
          return (
            <ACard key={e.entry_id} pad={14} tone={e.rank === 1 ? A.lime : undefined} accessibilityLabel={`${e.rank ? `Place ${e.rank}, ` : ''}${e.name ?? 'Participant'}, ${sub}`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <AT weight="900" size={26} num color={e.rank === 1 ? A.lime : A.ink} style={{ width: 34, textAlign: 'center' }}>{e.rank ?? '–'}</AT>
                <View style={{ flex: 1 }}>
                  <AT weight="800" size={15.5}>{e.lane ? `Lane ${e.lane} · ` : ''}{e.name ?? 'Participant'}</AT>
                  <AT size={13} color={A.mute}>{[e.house, sub].filter(Boolean).join(' · ')}</AT>
                </View>
                {e.q ? <ATag label={e.q === 'Q' ? 'Qualified' : 'Fastest loser'} tone={A.lime} /> : null}
              </View>
              {scorer && !official && !out ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                  {panel ? <ABtn small title="Judges' marks" tone="neon" onPress={() => open('judge', e)} /> : field ? <ABtn small title="Attempt" tone="neon" onPress={() => open('attempt', e)} />
                    : (<>{e.status !== 'finished' ? <ABtn small title="Finish" tone="neon" onPress={() => open('finish', e)} /> : null}<ABtn small title="Split" tone="ghost" onPress={() => open('split', e)} /></>)}
                  <ABtn small title="DNS / DNF / DQ" tone="ghost" onPress={() => open('status', e)} />
                </View>
              ) : null}
            </ACard>
          );
        })}
      </View>

      {scorer && !official ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <ABtn small tone="ghost" title="↩ Undo last entry" disabled={!lastEvent} onPress={undo} />
          <ABtn small tone="lime" title="Finalise result" disabled={!!s.finalizing} onPress={() => setConfirm(true)} />
        </View>
      ) : null}

    </View>
  );
  return (
    <View style={FRAME}>
      {body}
      <Sheet visible={!!sheet} onClose={() => setSheet(null)} title={sheet ? { finish: 'Finish', split: 'Split time', attempt: 'Attempt', judge: 'Judge\'s mark', status: 'Did not complete' }[sheet.kind] + ` · ${sheet.entry.name ?? 'Participant'}` : ''}>
        {sheet?.kind === 'status' ? (
          <View style={{ gap: 10 }}>
            <T size={13} color={c.mute}>This takes them out of the ranking.</T>
            {[['dns', 'Did not start'], ['dnf', 'Did not finish'], ['dq', 'Disqualified']].map(([k, l]) => <Btn key={k} title={l} color={k === 'dq' ? c.red : c.violet} onPress={() => { setSheet({ ...sheet, kind: k }); }} />)}
          </View>
        ) : sheet && ['dns', 'dnf', 'dq'].includes(sheet.kind) ? (
          <View style={{ gap: 10 }}>
            <T weight="800">Reason</T>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{['False start', 'Lane violation', 'Injury', 'Withdrew', 'Did not report'].map((r) => <Chip key={r} label={r} active={outcome === r} onPress={() => setOutcome(r)} />)}</View>
            <Btn title={`Confirm ${sheet.kind.toUpperCase()}`} color={c.red} loading={busy} disabled={outcome === 'valid'} onPress={submit} />
          </View>
        ) : sheet?.kind === 'judge' ? (
          <View style={{ gap: 12 }}>
            <Counter label="Judge" value={judge} min={1} max={20} onChange={setJudge} />
            <Counter label="Round / routine" value={round} min={1} max={12} onChange={setRound} />
            <Counter label="Mark" value={mark} min={0} max={30} step={0.1} onChange={setMark} />
            <Counter label="Difficulty (1 = none)" value={mult} min={0.1} max={10} step={0.1} onChange={setMult} />
            <T weight="800" size={16} accessibilityLiveRegion="polite">Judge {judge} gives {mark}{mult !== 1 ? ` × ${mult}` : ''}</T>
            <Btn title="Record the mark" loading={busy} onPress={submit} />
          </View>
        ) : sheet ? (
          <View style={{ gap: 12 }}>
            {sheet.kind === 'split' ? <Counter label="Distance (m)" value={dist} min={10} max={1000} step={10} onChange={setDist} /> : null}
            {sheet.kind === 'attempt' ? (
              <>
                <Counter label="Round" value={round} min={1} max={12} onChange={setRound} />
                <View style={{ flexDirection: 'row', gap: 8 }}>{[['valid', 'Valid'], ['foul', 'Foul'], ['pass', 'Pass']].map(([k, l]) => <Chip key={k} label={l} active={outcome === k} onPress={() => setOutcome(k)} />)}</View>
              </>
            ) : null}
            {sheet.kind !== 'attempt' || outcome === 'valid' ? <MarkInput key={sheet.kind + sheet.entry.entry_id} type={sheet.kind === 'split' ? 'time' : type} onChange={setMark} /> : null}
            <Btn title="Record" loading={busy} disabled={(sheet.kind !== 'attempt' || outcome === 'valid') && !(mark > 0)} onPress={submit} />
          </View>
        ) : null}
      </Sheet>
      <Sheet visible={confirm} onClose={() => setConfirm(false)} title="Record the official result?">
        <T size={14} color="#475569">This hands the marks to the results record, with the same checks as entering them by hand. Everyone who has not finished must have a result or be DNS / DNF / DQ.{offline || queue.pending.length ? ' With no signal it is kept on this device and recorded, after your entries, as soon as there is one.' : ''}</T>
        <Btn title="Yes, record it" color={c.lime} loading={busy} onPress={finalise} />
      </Sheet>
      <ConflictSheet conflict={queue.conflict} describe={describe} names={{ home: '', away: '' }} onResend={() => queue.resolve('resend')} onDiscard={() => queue.resolve('discard')} />
    </View>
  );
}
