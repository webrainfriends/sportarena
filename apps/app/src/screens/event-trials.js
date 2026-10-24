// Trial console (a tab of the event console, shown for events of kind "trial"): roster with capacity, attendance, sport-rubric assessments,
// the selection outcome, follow-ups and release to the player and guardians. Attendance is never selection: the outcome is its own step.
import React, { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, ABtn, ACard, AChip, AEmpty, ARow, ASection, AT, ATag, ReasonSheet } from '../arena';
import { Btn, Chip, Field, Loading, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError, explain } from '../access';
import { c } from '../theme';
import { ATTENDANCE, DECISION, ScoreBars } from './trials';

const MARKS = ['present', 'late', 'left_early', 'absent', 'excused'];
const SHARE = [['after_outcome', 'After the outcome is released'], ['now', 'Share now'], ['private', 'Keep private']];
const FOLLOW = [['book_session', 'Book a session'], ['send_resource', 'Send a resource'], ['review', 'Review later'], ['other', 'Other']];

function saveCsv(filename, csv, setText) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  } else setText(csv);
}

/** Pick a sport rubric, score each dimension on its own scale, write dated feedback. Editing your own assessment sends its row_version. */
function AssessSheet({ eventId, player, mine, onClose, done }) {
  const { toast } = useSession();
  const rub = useLoad(() => api.get(`/trials/${eventId}/rubrics`), [eventId]);
  const [ref, setRef] = useState(mine?.rubric_ref ?? null), [scores, setScores] = useState(mine?.scores ?? {}), [fb, setFb] = useState(mine?.feedback ?? ''), [note, setNote] = useState(mine?.private_note ?? ''), [share, setShare] = useState(mine?.share ?? 'after_outcome');
  const [busy, setBusy] = useState(false), [key] = useState(() => `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const rubrics = rub.data?.items ?? [];
  const cur = rubrics.find((r) => r.ref === ref);
  useEffect(() => { if (!ref && rubrics.length === 1) setRef(rubrics[0].ref); }, [rubrics.length]);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/trial-bookings/${player.entry_id}/assessment`, { rubric_ref: ref, scores, feedback: fb || undefined, private_note: note || undefined, share, row_version: mine?.row_version, client_key: mine ? undefined : key });
      toast('Assessment saved'); done();
    } catch (e) { toast(explain(e)); if (e.status === 409) done(); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Assess ${player.display_name}`}>
      {rub.error ? <LoadError error={rub.error} onRetry={rub.reload} /> : !rub.data ? <Loading /> : !rubrics.length ? <T color={c.mute}>No rubric exists for this sport yet. Create one under Coaching → Rubrics.</T> : (
        <View style={{ gap: 12 }}>
          <T weight="800" size={13}>Rubric</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{rubrics.map((r) => <Chip key={r.ref} label={r.name} active={r.ref === ref} onPress={() => { setRef(r.ref); setScores({}); }} />)}</View>
          {cur ? cur.dimensions.map((d) => (
            <View key={d.key} style={{ gap: 6 }}>
              <T weight="700" size={14}>{d.name}</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {Array.from({ length: d.scale_max - d.scale_min + 1 }, (_, n) => d.scale_min + n).map((v) => <Chip key={v} label={String(v)} active={scores[d.key] === v} onPress={() => setScores({ ...scores, [d.key]: scores[d.key] === v ? undefined : v })} />)}
              </View>
            </View>
          )) : null}
          <Field label="Feedback for the player" value={fb} onChangeText={setFb} multiline maxLength={2000} />
          <Field label="Private staff note (never shown to the player or guardian)" value={note} onChangeText={setNote} multiline maxLength={2000} />
          <T weight="800" size={13}>Who sees the feedback</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{SHARE.map(([v, l]) => <Chip key={v} label={l} active={share === v} onPress={() => setShare(v)} />)}</View>
          <Btn title="Save assessment" onPress={save} loading={busy} disabled={!ref || !Object.values(scores).some((v) => v != null)} />
        </View>
      )}
    </Sheet>
  );
}

function Player({ eventId, others, p, isOrg, me, reload }) {
  const { toast } = useSession();
  const [assess, setAssess] = useState(false), [fix, setFix] = useState(null), [follow, setFollow] = useState(false), [note, setNote] = useState(p.outcome_note ?? ''), [busy, setBusy] = useState(false);
  const mine = p.assessments.find((a) => a.assessor_id === me);
  const act = async (fn, msg) => { setBusy(true); try { await fn(); toast(msg); } catch (e) { toast(explain(e)); } finally { setBusy(false); reload(); } };
  const mark = (status, reason) => act(() => api.post(`/trial-bookings/${p.entry_id}/attendance`, { status, reason, row_version: p.attendance ? p.attendance_version : undefined }), 'Attendance saved');
  const waiting = p.booking_status === 'waitlisted';
  const attended = p.attendance && !['absent', 'excused'].includes(p.attendance);
  return (
    <ACard style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <AT size={16} weight="800" style={{ flex: 1 }} numberOfLines={1}>{p.avatar_emoji ?? '🙂'} {p.display_name}</AT>
        {p.is_youth ? <ATag label="Under 18" /> : null}{waiting ? <ATag label="Waitlist" /> : null}
        {p.released_at ? <ATag label="Released" tone={A.lime} /> : p.decision ? <ATag label="Not released" /> : null}
      </View>
      {p.restricted ? <AT size={13} color={A.mute}>A guardian's coaching consent is not current, so assessments, outcome and follow-ups are held back for this young person.</AT> : null}
      {!waiting ? (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }} accessibilityLabel="Attendance">
          {MARKS.map((m) => <AChip key={m} label={ATTENDANCE[m]} active={p.attendance === m} onPress={() => (p.attendance === m ? null : p.attendance ? setFix(m) : mark(m))} />)}
        </View>
      ) : null}
      {p.assessments.map((a) => (
        <View key={a.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: A.line, paddingTop: 8 }}>
          <AT size={12} color={A.mute}>{a.assessor_name} · {new Date(a.assessed_at).toLocaleDateString()} · {a.rubric_name} · {a.share === 'private' ? 'private' : a.share === 'now' ? 'shared' : 'shared after outcome'}</AT>
          <ScoreBars dimensions={a.dimensions} scores={a.scores} />
          {a.feedback ? <AT size={13}>“{a.feedback}”</AT> : null}
          {a.private_note ? <AT size={12} color={A.mute}>Staff note: {a.private_note}</AT> : null}
        </View>
      ))}
      {attended && !p.restricted ? <ABtn small title={mine ? 'Edit my assessment' : 'Assess player'} tone="neon" onPress={() => setAssess(true)} /> : null}
      {attended && !p.restricted && isOrg ? (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: A.line, paddingTop: 8 }}>
          <AT size={13} weight="800">Outcome</AT>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(DECISION).map(([k, l]) => <AChip key={k} label={l} active={p.decision === k} onPress={() => act(() => api.post(`/trial-bookings/${p.entry_id}/outcome`, { decision: k, note: note || undefined, row_version: p.decision ? p.outcome_version : undefined }), 'Outcome saved (not yet released)')} />)}
          </View>
          <Field label="Note for the player (optional)" value={note} onChangeText={setNote} multiline maxLength={1000} />
          {p.decision && !p.released_at ? <ABtn small title="Release to player and guardians" tone="lime" loading={busy} onPress={() => act(() => api.post(`/trial-bookings/${p.entry_id}/release`, {}), 'Released — the player and guardians were told')} /> : null}
        </View>
      ) : null}
      {attended && !p.restricted ? (
        <View style={{ gap: 6 }}>
          {p.follow_ups.map((f) => (
            <ARow key={f.id} title={`${f.status === 'done' ? '✅ ' : ''}${f.title}`} sub={[FOLLOW.find(([k]) => k === f.kind)?.[1], f.next_event_id ? 'next trial linked' : null, f.due_on ? `by ${String(f.due_on).slice(0, 10)}` : null, f.status].filter(Boolean).join(' · ')}
              right={f.status === 'open' ? <ABtn small tone="ghost" title="Done" onPress={() => act(() => api.patch(`/trial-follow-ups/${f.id}`, { status: 'done', row_version: f.row_version }), 'Follow-up done')} /> : null} />
          ))}
          <ABtn small tone="ghost" title="Add follow-up" onPress={() => setFollow(true)} />
        </View>
      ) : null}
      {assess ? <AssessSheet eventId={eventId} player={p} mine={mine} onClose={() => setAssess(false)} done={() => { setAssess(false); reload(); }} /> : null}
      <ReasonSheet visible={!!fix} onClose={() => setFix(null)} title="Correct attendance" sub="Say why this mark is changing. The earlier mark stays in the log." confirmLabel="Save correction" tone="neon" presets={['Marked by mistake', 'Arrived later', 'Left early']} onConfirm={(r) => mark(fix, r)} />
      <FormSheet visible={follow} onClose={() => setFollow(false)} title={`Follow-up for ${p.display_name}`} submitLabel="Add follow-up"
        fields={[{ key: 'kind', label: 'Kind', type: 'chips', options: FOLLOW.map(([value, label]) => ({ value, label })) }, { key: 'title', label: 'What needs to happen' }, { key: 'next_event_id', label: 'Next trial the player can book', type: 'chips', optional: true, show: (x) => x.kind === 'book_session', options: (others.data?.items ?? []).filter((t) => t.id !== eventId).map((t) => ({ value: t.id, label: `${t.name}${t.starts_on ? ` · ${String(t.starts_on).slice(0, 10)}` : ''}` })) }, { key: 'due_on', label: 'Due', type: 'date', optional: true }, { key: 'detail', label: 'Details', type: 'multiline', optional: true }]}
        initial={{ kind: 'book_session' }}
        onSubmit={async (v) => { await api.post(`/trial-bookings/${p.entry_id}/follow-ups`, { kind: v.kind, title: v.title, due_on: v.due_on || undefined, next_event_id: v.kind === 'book_session' ? v.next_event_id || undefined : undefined, detail: v.detail || undefined, client_key: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }); toast('Follow-up added'); setFollow(false); reload(); }} />
    </ACard>
  );
}

export function TrialsTab({ id, isOrg }) {
  const { user, toast } = useSession();
  const s = useLoad(() => api.get(`/trials/${id}/session`), [id]);
  const [csv, setCsv] = useState(null);
  const others = useLoad(() => api.get('/events/search', { kind: 'trial', limit: 30 }), []);
  if (s.error) return s.error.status === 403 ? <AEmpty emoji="🔒" title="Organisers and assessors only" sub="Ask the organiser to add you as a trial assessor in People → Hiring." /> : <LoadError error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const exportCsv = async () => { try { const x = await api.get(`/trials/${id}/export`); saveCsv(x.filename, x.csv, setCsv); toast(x.withheld_young_people ? `Exported. ${x.withheld_young_people} young people left out (no guardian consent). This is logged.` : 'Exported. This download is logged.'); } catch (e) { toast(explain(e)); } };
  return (
    <>
      <ASection title="Trial roster" sub={`${d.booked}${d.event.capacity ? ` of ${d.event.capacity}` : ''} booked · ${d.waitlisted} on the waitlist · you are the ${d.your_role}`} />
      {isOrg ? <ABtn small tone="ghost" title="Export results (CSV)" onPress={exportCsv} /> : null}
      {csv ? <Field label="CSV (copy)" value={csv} multiline /> : null}
      {d.roster.length ? d.roster.map((p) => <Player key={p.entry_id} eventId={id} others={others} p={p} isOrg={isOrg} me={user?.id} reload={s.reload} />)
        : <AEmpty emoji="🎽" title="No bookings yet" sub="Players book from Trials in the app. Their places, waitlist and attendance appear here." />}
    </>
  );
}
