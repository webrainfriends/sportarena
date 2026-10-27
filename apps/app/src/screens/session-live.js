// Live heat / final / field flight: call room, start, splits, finishes or attempts, provisional places and the step to the official
// result. It lives inside the session sheet of the Games screen (the one place sessions are run) and is read-only for everyone who is
// not the organiser or an assigned official. The server derives places and Q/q from what is recorded; nothing here ranks anyone.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLiveSession } from '../live';
import { Btn, Card, Chip, Loading, Sheet, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { useScoreQueue } from '../scorer/queue';
import { ConflictSheet, SyncLine } from '../scorer/panels';
import { c } from '../theme';

const STATE = { scheduled: ['Not started', c.violetSoft], live: ['Live', c.mint], provisional: ['Provisional', c.sunSoft], final: ['Official', c.limeSoft], corrected: ['Corrected', c.sunSoft] };
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

export function SessionLive({ id, toast, onFinalised }) {
  const { state: s, mode, push, revoked } = useLiveSession(id);
  const [sheet, setSheet] = useState(null); // {kind, entry}
  const [mark, setMark] = useState(0);
  const [dist, setDist] = useState(50);
  const [round, setRound] = useState(1);
  const [outcome, setOutcome] = useState('valid');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const seen = React.useRef(0);
  if (s && s.last_seq > seen.current) seen.current = s.last_seq;
  const queue = useScoreQueue(`sa_queue_ss_${id}`,
    async (e) => { const r = await api.post(`/sessions/${id}/events`, e); seen.current = Math.max(seen.current, r.state.last_seq); push(r.state); return r; },
    { onDrop: (err) => toast('' + err.message) });
  if (!s) return <Loading />;

  const pr = s.projection, type = s.session.result_type, field = pr.kind === 'field';
  const scorer = !!s.viewer?.can_score && !revoked;
  const official = ['final', 'corrected'].includes(s.live.state);
  const [stateLabel, stateColor] = STATE[s.live.state] ?? STATE.scheduled;
  const send = async (kind, entry, payload = {}) => {
    const r = await queue.enqueue({ kind, ...(entry ? { entry_id: entry.entry_id } : {}), payload, expected_seq: seen.current });
    if (r.queued && !r.full) toast('Not sent yet. It is kept on this device and will be retried.');
    return !r.queued;
  };
  const lastEvent = [...(s.events ?? [])].reverse().find((e) => !e.voided && e.id);
  const describe = (e) => `${e.kind.replace('_', ' ')}${e.payload?.value != null ? ` ${showMark(type, e.payload.value)}` : ''}`;
  const open = (kind, entry) => {
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
      else await send('entry_status', entry, { status: kind, reason: outcome === 'valid' ? undefined : outcome });
      setSheet(null);
    } finally { setBusy(false); }
  };
  const finalise = async () => {
    setBusy(true);
    try { const r = await api.post(`/sessions/${id}/finalize-live`); push(r.live); setConfirm(false); toast('Result recorded. It is now official.'); onFinalised?.(); }
    catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag label={stateLabel} color={stateColor} />
        {pr.status && !official ? <T size={12} color={c.mute}>{STEPS.find((x) => x[0] === pr.status)?.[1] ?? pr.status.replace('_', ' ')}</T> : null}
        <T size={12} color={mode === 'stream' ? c.mint : c.mute}>{mode === 'stream' ? '⚡ Live' : '↻ Refreshing'}</T>
      </View>
      {!official ? <T size={12.5} color={c.mute}>Places shown here are provisional. They become official when the result is recorded.</T> : null}
      {revoked ? <T size={13} weight="800" color={c.red}>Your scoring access for this session has ended.</T> : null}

      {scorer && !official ? (
        <View style={{ gap: 10 }}>
          <SyncLine pending={queue.pending.length} onRetry={queue.flush} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {STEPS.slice(0, 2).map(([k, l]) => <Chip key={k} label={l} active={pr.status === k} onPress={() => send('status', null, { status: k })} />)}
            <Btn small title="▶ Start the race" color={c.red} disabled={pr.status === 'in_progress' || pr.status === 'provisional'} onPress={() => send('start', null, {})} />
          </View>
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        {pr.entries.map((e) => {
          const out = ['dns', 'dnf', 'dq'].includes(e.status);
          const last = e.splits?.[e.splits.length - 1];
          const sub = [out ? e.status.toUpperCase() : e.best != null ? showMark(type, e.best) : e.status === 'competing' ? 'competing' : 'waiting', last ? `split ${showMark('time', last.value)} @ ${last.distance_m} m` : null, field && e.attempts.length ? `${e.attempts.length} attempt${e.attempts.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
          return (
            <Card key={e.entry_id} pad={12} accessibilityLabel={`${e.rank ? `Place ${e.rank}, ` : ''}${e.name ?? 'Participant'}, ${sub}`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <T weight="800" size={22} style={{ width: 30, textAlign: 'center' }}>{e.rank ?? '–'}</T>
                <View style={{ flex: 1 }}>
                  <T weight="700" size={15}>{e.lane ? `Lane ${e.lane} · ` : ''}{e.name ?? 'Participant'}</T>
                  <T size={13} color={c.mute}>{[e.house, sub].filter(Boolean).join(' · ')}</T>
                </View>
                {e.q ? <Tag label={e.q === 'Q' ? 'Qualified' : 'Fastest loser'} color={c.limeSoft} /> : null}
              </View>
              {scorer && !official && !out ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  {field ? <Btn small title="Attempt" onPress={() => open('attempt', e)} />
                    : (<>{e.status !== 'finished' ? <Btn small title="Finish" onPress={() => open('finish', e)} /> : null}<Btn small title="Split" color={c.paper} ink={c.ink} onPress={() => open('split', e)} /></>)}
                  <Btn small title="DNS / DNF / DQ" color={c.paper} ink={c.ink} onPress={() => open('status', e)} />
                </View>
              ) : null}
            </Card>
          );
        })}
      </View>

      {scorer && !official ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="↩ Undo last entry" color={c.paper} ink={c.ink} disabled={!lastEvent} onPress={async () => { try { push(await api.post(`/session-events/${lastEvent.id}/void`, { reason: 'Entered by mistake' })); } catch (x) { toast('' + x.message); } }} />
          <Btn small title="Finalise result" color={c.lime} disabled={queue.pending.length > 0} onPress={() => setConfirm(true)} />
        </View>
      ) : null}

      <Sheet visible={!!sheet} onClose={() => setSheet(null)} title={sheet ? { finish: 'Finish', split: 'Split time', attempt: 'Attempt', status: 'Did not complete' }[sheet.kind] + ` · ${sheet.entry.name ?? 'Participant'}` : ''}>
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
        <T size={14} color="#475569">This hands the marks to the results record, with the same checks as entering them by hand. Everyone who has not finished must have a result or be DNS / DNF / DQ.</T>
        <Btn title="Yes, record it" color={c.lime} loading={busy} onPress={finalise} />
      </Sheet>
      <ConflictSheet conflict={queue.conflict} describe={describe} names={{ home: '', away: '' }} onResend={() => queue.resolve('resend')} onDiscard={() => queue.resolve('discard')} />
    </View>
  );
}
