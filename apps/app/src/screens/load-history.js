import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { todayIn } from '../vtime';

// Unified training and match load history (#328). One list for manual logs, completed training sessions and played matches. Sessions and
// matches that have no effort rating yet are shown but never counted or estimated until the athlete rates them.

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const SOURCE = { manual: ['Logged by hand', c.violetSoft], training_session: ['Training session', c.cyan], match: ['Match', c.mint] };
const KIND = { training: 'Training', match: 'Match', gym: 'Gym', other: 'Other' };
const shown = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const say = (e) => {
  const code = e?.details?.code;
  if (code === 'stale_version') return 'This record changed on another device. It has been reloaded; please check and try again.';
  if (code === 'guardian_consent_required') return 'A guardian has not given current consent for this. Ask them under Family & guardians.';
  if (code === 'date_mismatch') return 'That log is on a different day from the session. Correct its date first.';
  return e?.message ?? 'Something went wrong';
};
const RPE = Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) }));
const RANGES = [{ value: 28, label: '4 weeks' }, { value: 84, label: '12 weeks' }, { value: 180, label: '6 months' }];
const PAGE = 50;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Entry({ e, onPress }) {
  const [label, tone] = SOURCE[e.source] ?? SOURCE.manual;
  return (
    <Card onPress={onPress} pad={14} accessibilityLabel={`${shown(e.session_date)}, ${KIND[e.kind] ?? e.kind}, ${e.minutes} minutes, effort ${e.rpe} of 10, load ${e.load}. ${label}${e.corrected ? ', corrected' : ''}. Open details`}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View style={{ flex: 1, gap: 3 }}>
          <T weight="800">{e.source_title ?? KIND[e.kind] ?? e.kind}</T>
          <T size={12} color={c.mute}>{shown(e.session_date)}{e.source_context ? ` · ${e.source_context}` : ''}</T>
          <T size={12} color={c.mute}>{e.minutes} min · {e.minutes_label} · effort {e.rpe}/10</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            <Tag label={label} color={tone} />
            {e.corrected ? <Tag label="Corrected" color={c.sun} /> : null}
            {e.source_hidden ? <Tag label="Details hidden" color={c.violetSoft} /> : null}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}><T weight="800" size={22}>{e.load}</T><T size={10} color={c.mute} weight="700">LOAD</T></View>
      </View>
    </Card>
  );
}

/** Rate a confirmed session or match. Minutes and effort are yours to give: the form never pre-picks an effort. */
function RateSheet({ p, dupes, onClose, onDone }) {
  const verified = p.verified_minutes != null;
  return (
    <FormSheet visible onClose={onClose} title={`${p.title} · ${shown(p.date)}`} submitLabel="Add to my load"
      initial={{ minutes: verified ? Math.round(p.verified_minutes) : p.planned_minutes ?? 60, rpe: p.reported_rpe ?? undefined, ...(dupes ? { separate: true } : {}) }}
      notice={verified ? 'Playing time comes from the match record. Change it if it is wrong.' : p.planned_minutes ? `Planned length was ${p.planned_minutes} min. Set the minutes you actually trained.` : 'Set the minutes you actually played.'}
      fields={[
        { key: 'minutes', label: verified ? 'Minutes played (verified)' : 'Minutes you actually trained', type: 'stepper', min: 1, max: 600, step: 5, suffix: ' min' },
        { key: 'rpe', label: 'How hard it felt (1 easy – 10 maximal)', type: 'chips', options: () => RPE },
      ]}
      onSubmit={async (v) => { await onDone({ source: p.source, source_id: p.id, minutes: Number(v.minutes), rpe: Number(v.rpe), ...(dupes ? { separate: true } : {}) }); return 'Added to your load'; }} />
  );
}

function Detail({ e, readOnly, onClose, onChanged }) {
  const { toast } = useSession();
  const [mode, setMode] = useState(null); // 'correct' | 'remove'
  const rev = useLoad(() => api.get(`/me/loads/${e.id}/revisions`), [e.id, e.row_version]);
  const fmt = (s) => (s ? `${shown(s.session_date)} · ${KIND[s.kind] ?? s.kind} · ${s.minutes} min · effort ${s.rpe}` : '');
  const ACTION = { created: 'Added', linked: 'Linked to a session', corrected: 'Corrected', archived: 'Removed' };
  return (
    <Sheet visible onClose={onClose} title={e.source_title ?? KIND[e.kind] ?? 'Load record'}>
      <T size={13} color={c.mute}>{shown(e.session_date)} · {e.minutes} min ({e.minutes_label}) · effort {e.rpe}/10 · load {e.load}</T>
      {!readOnly ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="Correct" onPress={() => setMode('correct')} accessibilityLabel="Correct this record" />
          <Btn small color={c.paper} ink={c.red} title="Remove from my load" onPress={() => setMode('remove')} accessibilityLabel="Remove this record from my load" />
        </View>
      ) : null}
      <T weight="800" size={14}>History</T>
      {rev.error ? <ErrorBox error={rev.error} onRetry={rev.reload} /> : !rev.data ? <Loading /> : rev.data.map((r) => (
        <View key={r.id} style={{ gap: 2, borderLeftWidth: 3, borderLeftColor: c.line, paddingLeft: 10 }}>
          <T weight="700" size={13}>{ACTION[r.action] ?? r.action} · {new Date(r.created_at).toLocaleString()}</T>
          {r.before ? <T size={12} color={c.mute}>Before: {fmt(r.before)}</T> : null}
          <T size={12} color={c.mute}>{r.action === 'archived' ? 'Was' : 'Now'}: {fmt(r.after)}</T>
          {r.reason ? <T size={12}>Reason: {r.reason}</T> : null}
        </View>
      ))}
      {mode === 'correct' ? (
        <FormSheet visible onClose={() => setMode(null)} title="Correct this record" submitLabel="Save correction"
          initial={{ minutes: e.minutes, rpe: e.rpe, date: e.session_date, kind: e.kind }}
          notice={e.source === 'manual' ? 'The old values stay in the history.' : 'This record belongs to a session or match, so its day and type stay as they are. The old values stay in the history.'}
          fields={[
            { key: 'minutes', label: 'Minutes', type: 'stepper', min: 1, max: 600, step: 5, suffix: ' min' },
            { key: 'rpe', label: 'How hard it felt (1–10)', type: 'stepper', min: 1, max: 10 },
            ...(e.source === 'manual' ? [
              { key: 'kind', label: 'What was it', type: 'chips', options: Object.entries(KIND).map(([value, label]) => ({ value, label })) },
              { key: 'date', label: 'Day', type: 'date', max: todayIn(deviceTz) },
            ] : []),
            { key: 'reason', label: 'Why are you correcting it?', type: 'multiline' },
          ]}
          onSubmit={async (v) => {
            const body = { expected_version: e.row_version, reason: v.reason.trim(), minutes: Number(v.minutes), rpe: Number(v.rpe), ...(e.source === 'manual' ? { kind: v.kind, date: v.date } : {}) };
            for (const k of ['minutes', 'rpe', 'kind', 'date']) if (body[k] === e[k === 'date' ? 'session_date' : k]) delete body[k];
            try { await api.patch(`/me/loads/${e.id}`, body); } catch (x) { if (x?.details?.code === 'stale_version') await onChanged(); throw new Error(say(x)); }
            await onChanged(); setMode(null); onClose(); return 'Correction saved';
          }} />
      ) : null}
      {mode === 'remove' ? (
        <FormSheet visible onClose={() => setMode(null)} title="Remove from my load?" submitLabel="Remove"
          notice="It stops counting towards your workload. Nothing is deleted: it stays in the history, and a linked session can be added again."
          fields={[{ key: 'reason', label: 'Why are you removing it?', type: 'multiline' }]}
          onSubmit={async (v) => { try { await api.post(`/me/loads/${e.id}/archive`, { reason: v.reason.trim() }); } catch (x) { throw new Error(say(x)); } await onChanged(); setMode(null); onClose(); toast('Removed from your load'); return null; }} />
      ) : null}
    </Sheet>
  );
}

/**
 * The unified load history. `userId` shows a young person's history to their guardian (read only, audit-logged on the server).
 */
export function LoadHistory({ userId, onChanged, version = 0 }) {
  const { toast } = useSession();
  const [span, setSpan] = useState(28);
  const [extra, setExtra] = useState([]);   // further pages appended after the first
  const [more, setMore] = useState(false);
  const [rate, setRate] = useState(null);   // pending source being rated
  const [open, setOpen] = useState(null);   // entry being viewed
  const [busy, setBusy] = useState(null);
  const readOnly = !!userId;
  const to = todayIn(deviceTz), from = addDays(to, -(span - 1));
  const h = useLoad(async () => { setExtra([]); return api.get('/me/load-history', { from, to, limit: PAGE, offset: 0, ...(userId ? { user_id: userId } : {}) }); }, [span, userId, version]);
  const all = async () => { if (onChanged) await onChanged(); else await h.reload(); }; // a parent that owns the panel bumps `version` to reload us
  const d = h.data;
  const dupesFor = (p) => d?.possible_duplicates.find((x) => x.source === p.source && x.source_id === p.id);

  const save = async (body) => {
    try { await api.post('/me/load-history/record', body); } catch (x) { throw new Error(say(x)); }
    await all();
  };
  const link = async (p, m) => {
    setBusy(m.id);
    try { await api.post(`/me/loads/${m.id}/link`, { source: p.source, source_id: p.id, expected_version: m.row_version }); toast('Linked: counted once'); await all(); }
    catch (x) { toast(say(x)); if (x?.details?.code === 'stale_version') await all(); } finally { setBusy(null); }
  };
  const entries = [...(d?.entries ?? []), ...extra];
  const loadMore = async () => {
    setMore(true);
    try { const r = await api.get('/me/load-history', { from, to, limit: PAGE, offset: entries.length, ...(userId ? { user_id: userId } : {}) }); setExtra((x) => [...x, ...r.entries]); }
    catch (x) { toast(say(x)); } finally { setMore(false); }
  };

  return (
    <Card pad={16} style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800" size={16} accessibilityRole="header">Load history</T>
        <Seg options={RANGES} value={span} onChange={setSpan} color={c.pink} />
      </View>
      <T size={12} color={c.mute}>Training sessions, matches and sessions you logged by hand, counted once each. Minutes and effort are yours: nothing is estimated.</T>
      {h.error ? <ErrorBox error={h.error} onRetry={h.reload} /> : !d ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }} accessible accessibilityLabel={`${d.totals.entries} records, ${d.totals.minutes} minutes, total load ${d.totals.load}`}>
            <View><T weight="800" size={22}>{d.totals.entries}</T><T size={11} color={c.mute}>{d.totals.entries === 1 ? 'RECORD' : 'RECORDS'}</T></View>
            <View><T weight="800" size={22}>{Math.round(d.totals.minutes / 6) / 10}</T><T size={11} color={c.mute}>HOURS</T></View>
            <View><T weight="800" size={22}>{d.totals.load}</T><T size={11} color={c.mute}>TOTAL LOAD</T></View>
          </View>

          <T size={12} color={c.mute}>{plural(d.totals.training_sessions, 'training session')} · {plural(d.totals.matches, 'match', 'matches')} · {d.totals.manual} logged by hand</T>

          {d.hidden_sources.length ? <T size={12} color={c.mute}>Some session and match details are hidden until a guardian gives current consent under Family & guardians.</T> : null}

          {d.pending.length ? (
            <View style={{ gap: 8 }}>
              <T weight="800" size={14}>Needs your effort rating ({d.pending.length})</T>
              <T size={12} color={c.mute}>These finished but are not counted yet.</T>
              {d.pending.map((p) => {
                const dup = dupesFor(p);
                return (
                  <View key={`${p.source}${p.id}`} style={{ backgroundColor: c.bg, borderRadius: 14, padding: 12, gap: 8 }}>
                    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <View style={{ flex: 1, minWidth: 180 }}>
                        <T weight="800">{p.title}</T>
                        <T size={12} color={c.mute}>{shown(p.date)} · {SOURCE[p.source][0]}{p.context ? ` · ${p.context}` : ''}</T>
                        <T size={12} color={c.mute}>{p.verified_minutes != null ? `${Math.round(p.verified_minutes)} min verified` : p.planned_minutes ? `${p.planned_minutes} min planned` : 'No verified playing time'}{p.reported_rpe ? ` · you rated it ${p.reported_rpe}/10` : ''}</T>
                      </View>
                      {!readOnly && !dup ? <Btn small title="Add effort" onPress={() => setRate({ p, dupes: false })} accessibilityLabel={`Add effort rating for ${p.title} on ${shown(p.date)}`} /> : null}
                    </View>
                    {dup && !readOnly ? (
                      <View style={{ gap: 6 }}>
                        <T size={12} weight="700" color={c.orange}>You already logged something that day. Is it the same session?</T>
                        {dup.manual.map((m) => (
                          <View key={m.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <T size={12} style={{ flex: 1, minWidth: 150 }}>{KIND[m.kind]} · {m.minutes} min · effort {m.rpe}/10</T>
                            <Btn small disabled={busy === m.id} title="Same session" onPress={() => link(p, m)} accessibilityLabel={`Link your ${m.minutes} minute log to ${p.title}`} />
                          </View>
                        ))}
                        <Btn small color={c.paper} ink={c.ink} title="A different session" onPress={() => setRate({ p, dupes: true })} style={{ alignSelf: 'flex-start' }} />
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          {!entries.length ? (
            <Empty emoji="📈" title="No load recorded in this period" sub={readOnly ? 'Nothing has been recorded yet.' : d.pending.length ? 'Add an effort rating above, or log a session with “+ Log session”.' : 'Log a session with “+ Log session”. Completed training sessions and matches appear here to rate.'} />
          ) : (
            <View style={{ gap: 8 }}>
              {entries.map((e) => <Entry key={e.id} e={e} onPress={() => setOpen(e)} />)}
              {d.totals.entries > entries.length ? <Btn small loading={more} color={c.paper} ink={c.ink} title={`Show more (${d.totals.entries - entries.length} left)`} onPress={loadMore} style={{ alignSelf: 'center' }} /> : null}
            </View>
          )}
        </View>
      )}
      {rate ? <RateSheet p={rate.p} dupes={rate.dupes} onClose={() => setRate(null)} onDone={save} /> : null}
      {open ? <Detail e={open} readOnly={readOnly} onClose={() => setOpen(null)} onChanged={all} /> : null}
    </Card>
  );
}
