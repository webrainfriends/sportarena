// Application scoring and evaluation committees (#288), inside the program screen: a round's weighted rubric, its committee, the
// scoring board, the reviewer's score sheet, shortlist / interview rounds, moderation, applicant consent and the decision history.
// Everything the server refuses (recused, stale, closed) comes back as a plain message and the latest data is reloaded.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { DateField, TimeField } from '../pickers';
import { c } from '../theme';
import { explain, LoadError } from '../access';

const STAGE_TONE = { received: c.paper, shortlisted: c.sunSoft, interview: c.violetSoft, finalist: c.lime };
const STAGE_LABEL = { received: 'Received', shortlisted: 'Shortlisted', interview: 'In interview', finalist: 'Finalist' };
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
const at = (iso, zone) => { if (!iso) return ''; try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone || undefined }); } catch { return String(iso); } };
const pts = (v) => (v == null ? '–' : `${Math.round(Number(v) * 10) / 10}`);

/** Weights live in text boxes so a total can be typed freely; the running total tells you what is missing. */
function RubricEditor({ visible, onClose, round, rubric, onSaved }) {
  const { toast } = useSession();
  const blank = [{ name: '', weight: '' }];
  const [rows, setRows] = useState(null);
  const [anon, setAnon] = useState(true);
  const [scale, setScale] = useState(5);
  const [closeOn, setCloseOn] = useState(undefined);
  const [closeAt, setCloseAt] = useState(undefined);
  const [busy, setBusy] = useState(false);
  React.useEffect(() => {
    if (!visible) return;
    setRows(rubric?.criteria?.length ? rubric.criteria.map((x) => ({ name: x.name, weight: String(x.weight) })) : blank);
    setAnon(rubric?.anonymize ?? true); setScale(rubric?.scale_max ?? 5); setCloseOn(undefined); setCloseAt(undefined);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = rows ?? blank;
  const total = list.reduce((t, x) => t + (Number(x.weight) || 0), 0);
  const ok = total === 100 && list.every((x) => x.name.trim() && Number(x.weight) >= 1);
  const set = (k, patch) => setRows(list.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/program-rounds/${round.id}/rubric`, {
        criteria: list.map((x) => ({ name: x.name.trim(), weight: Number(x.weight) })), anonymize: anon, scale_max: scale,
        ...(closeOn ? { scoring_closes_on: closeOn, scoring_closes_time: closeAt ?? '23:59', timezone: round.timezone } : {}),
        ...(rubric ? { version: rubric.row_version } : {}),
      });
      toast('Rubric saved'); onSaved(); onClose();
    } catch (e) { toast(explain(e)); if (e.status === 409) onSaved(); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={rubric ? 'Edit rubric' : 'Set up the rubric'}>
      <T size={13} color={c.mute}>Each criterion is scored from 1 to {scale}. The weights are percentages and must add up to exactly 100.</T>
      {list.map((x, k) => (
        <View key={k} style={{ gap: 6 }}>
          <Field label={`Criterion ${k + 1}`} value={x.name} onChangeText={(v) => set(k, { name: v })} placeholder="What the committee judges" maxLength={120} />
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}><Field label="Weight (%)" value={x.weight} keyboardType="numeric" onChangeText={(v) => set(k, { weight: v.replace(/[^0-9]/g, '').slice(0, 3) })} /></View>
            {list.length > 1 ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => setRows(list.filter((_, j) => j !== k))} accessibilityLabel={`Remove criterion ${k + 1}`} /> : null}
          </View>
        </View>
      ))}
      {list.length < 20 ? <Btn small title="+ Criterion" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setRows([...list, { name: '', weight: '' }])} /> : null}
      <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`Weights total ${total} of 100`}>
        <T weight="900" color={total === 100 ? c.ink : c.red}>Total {total} / 100{total === 100 ? ' ✓' : total < 100 ? ` — add ${100 - total}` : ` — remove ${total - 100}`}</T>
      </View>
      <T weight="800" size={14}>Scale</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{[3, 4, 5, 7, 10].map((n) => <Chip key={n} label={`1–${n}`} active={scale === n} onPress={() => setScale(n)} />)}</View>
      <T weight="800" size={14}>Applicant identity</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="Hidden until they consent" active={anon} onPress={() => setAnon(true)} />
        <Chip label="Shown to the committee" active={!anon} onPress={() => setAnon(false)} />
      </View>
      <DateField label="Scoring closes" optional value={closeOn} onChange={setCloseOn} hint={`In the round's timezone (${round.timezone ?? 'UTC'}).`} />
      {closeOn ? <TimeField label="Closing time" optional value={closeAt} onChange={setCloseAt} /> : null}
      <Btn title={busy ? 'Saving…' : 'Save rubric'} disabled={!ok || busy} onPress={save} color={c.mint} ink={c.ink} />
    </Sheet>
  );
}

/** A reviewer's score sheet. Others' scores are shown to moderators and managers only (the server decides). */
function ScoreSheet({ appId, onClose, onChanged, round }) {
  const { toast } = useSession();
  const s = useLoad(() => (appId ? api.get(`/program-applications/${appId}/scoresheet`) : Promise.resolve(null)), [appId]);
  const [marks, setMarks] = useState({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null); // 'conflict' | 'moderate'
  const d = s.data;
  React.useEffect(() => {
    if (!d) return;
    const m = {}; for (const x of d.my_score?.criteria ?? []) m[x.criterion_id] = x.score;
    setMarks(m); setComment(d.my_score?.comment ?? '');
  }, [d?.my_score?.row_version, d?.application?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const rb = d?.rubric;
  const total = rb ? rb.criteria.reduce((t, x) => t + ((marks[x.id] ?? 0) / rb.scale_max) * x.weight, 0) : 0;
  const complete = rb && rb.criteria.every((x) => marks[x.id]);
  const save = async (submit) => {
    setBusy(true);
    try {
      await api.post(`/program-applications/${appId}/score`, { rubric_version: rb.row_version, submit, comment: comment || undefined, ...(d.my_score && d.my_score.status !== 'voided' ? { version: d.my_score.row_version } : {}), scores: rb.criteria.filter((x) => marks[x.id]).map((x) => ({ criterion_id: x.id, score: marks[x.id] })) });
      toast(submit ? 'Score submitted' : 'Draft saved'); s.reload(); onChanged();
    } catch (e) { toast(explain(e)); s.reload(); onChanged(); } finally { setBusy(false); }
  };
  const a = d?.application;
  return (
    <Sheet visible={!!appId} onClose={onClose} title={a ? `${a.applicant_name ? `${a.applicant_name} → ${a.target_name ?? a.target_type}` : `Application ${a.alias}`}` : 'Score sheet'}>
      {s.error ? <LoadError error={s.error} onRetry={s.reload} /> : s.loading && !d ? <Loading /> : d ? (
        <>
          <T size={12} color={c.mute}>{a.anonymized ? 'Identity hidden until the applicant consents · ' : ''}asks {fmt(a.requested_cents, a.currency)} · terms v{a.round_terms_version}</T>
          {a.pitch ? <Card color={c.violetSoft}><T size={13}>{a.pitch}</T></Card> : null}
          {d.recused ? <Card color={c.pinkSoft}><T weight="900">You cannot score this application</T><T size={13}>{d.recused}</T></Card> : null}
          {!d.scoring_open ? <T size={13} color={c.mute}>{rb ? 'Scoring is not open: it has closed or the rubric has not been activated.' : 'No rubric has been set up for this round yet.'}</T> : null}
          {rb ? rb.criteria.map((x) => (
            <View key={x.id} style={{ gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={`${x.name}, weight ${x.weight} percent`}>
              <T weight="800">{x.name} <T size={12} color={c.mute}>· {x.weight}%</T></T>
              {x.description ? <T size={12} color={c.mute}>{x.description}</T> : null}
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {Array.from({ length: rb.scale_max }, (_, k) => k + 1).map((n) => (
                  <Pressable key={n} disabled={!d.can_score} onPress={() => setMarks({ ...marks, [x.id]: n })} accessibilityRole="radio" accessibilityState={{ selected: marks[x.id] === n, disabled: !d.can_score }} accessibilityLabel={`${x.name}: ${n} of ${rb.scale_max}`}
                    style={{ minWidth: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: marks[x.id] === n ? c.pink : c.paper, borderWidth: 1, borderColor: c.line, opacity: d.can_score ? 1 : 0.5 }}>
                    <T weight="800" color={marks[x.id] === n ? '#fff' : c.ink}>{n}</T>
                  </Pressable>
                ))}
              </View>
            </View>
          )) : null}
          {rb ? <T weight="900">Weighted total {pts(total)} / 100{d.my_score?.status === 'submitted' ? ' · submitted' : d.my_score?.status === 'draft' ? ' · draft' : ''}</T> : null}
          {d.can_score ? (
            <>
              <Field label="Comment (internal)" multiline value={comment} onChangeText={setComment} maxLength={2000} hint="Visible to moderators and managers only, never to the applicant." />
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Btn title="Save draft" color={c.paper} ink={c.ink} disabled={busy || !Object.keys(marks).length} onPress={() => save(false)} />
                <Btn title={d.my_score?.status === 'submitted' ? 'Update score' : 'Submit score'} color={c.mint} ink={c.ink} disabled={busy || !complete} onPress={() => save(true)} />
              </View>
              {!complete ? <T size={12} color={c.mute}>Score every criterion to submit.</T> : null}
            </>
          ) : null}
          {d.is_reviewer && !d.recused && a.status === 'submitted' ? <Btn small title="Declare a conflict of interest" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('conflict')} /> : null}
          {d.all_scores ? (
            <Card color={c.sunSoft}>
              <T weight="900">Committee scores (confidential)</T>
              {d.summary ? <T size={12} color={c.mute}>{d.summary.submitted} submitted · average {pts(d.summary.average)} · spread {pts(d.summary.spread)}{d.summary.moderated_total != null ? ` · moderated ${pts(d.summary.moderated_total)} (${d.summary.moderation_reason})` : ''}</T> : null}
              {d.summary?.needs_moderation ? <T size={12} color={c.red}>Reviewers disagree by {pts(d.summary.spread)} points. Moderate before deciding.</T> : null}
              {d.all_scores.length ? d.all_scores.map((x) => <T key={x.reviewer_user_id} size={13}>{x.reviewer_name}: {pts(x.total)}{x.comment ? ` — ${x.comment}` : ''}</T>) : <T size={13} color={c.mute}>No submitted scores yet.</T>}
              {d.can_moderate && a.status === 'submitted' ? <Btn small title="Moderate" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setForm('moderate')} /> : null}
            </Card>
          ) : null}
        </>
      ) : null}
      <FormSheet visible={form === 'conflict'} onClose={() => setForm(null)} title="Declare a conflict" submitLabel="Recuse myself"
        fields={[{ key: 'reason', label: 'Why you cannot score this fairly', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/program-applications/${appId}/conflicts`, { reason: v.reason }); s.reload(); onChanged(); return 'You are recused; your score for this application no longer counts'; }} />
      <FormSheet visible={form === 'moderate'} onClose={() => setForm(null)} title="Moderate the score" submitLabel="Record moderated score"
        fields={[{ key: 'total', label: 'Moderated total (0–100)', type: 'number', input: 'decimal' }, { key: 'reason', label: 'Reason', type: 'multiline' }]}
        initial={{ total: d?.summary?.average != null ? String(d.summary.average) : '' }}
        onSubmit={async (v) => { await api.post(`/program-applications/${appId}/moderation`, { total: Number(v.total), reason: v.reason, eval_version: d.application.eval_version }); s.reload(); onChanged(); return 'Moderated score recorded; reviewers\' scores stay on record'; }} />
    </Sheet>
  );
}

/** Interview rounds of one application: as many as needed, each a slot, a video link or both. */
function InterviewSheet({ app, may, onClose, onChanged, round }) {
  const { toast } = useSession();
  const list = useLoad(() => (app ? api.get(`/program-applications/${app.id}/interviews`) : Promise.resolve([])), [app?.id, app?.eval_version]);
  const [form, setForm] = useState(null); // 'new' | { edit }
  const edit = typeof form === 'object' && form?.edit;
  const fields = [
    { key: 'on', label: 'Date', type: 'date', optional: true }, { key: 'at', label: 'Time', type: 'time', optional: true }, { key: 'timezone', label: 'Timezone', type: 'timezone' },
    { key: 'video_url', label: 'Video call link (https)', optional: true, placeholder: 'https://…', hint: 'Give a date and time, a video link, or both.' },
    { key: 'location', label: 'Where (if in person)', optional: true }, { key: 'notes', label: 'Note to the applicant', type: 'multiline', optional: true },
  ];
  const clean = (v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null));
  const done = async (iv, status) => { try { await api.patch(`/program-interviews/${iv.id}`, { version: iv.row_version, status }); toast(status === 'cancelled' ? 'Interview cancelled' : 'Marked completed'); list.reload(); onChanged(); } catch (e) { toast(explain(e)); list.reload(); } };
  const open = (list.data ?? []).some((x) => x.status === 'scheduled');
  return (
    <Sheet visible={!!app} onClose={onClose} title={`Interviews · ${app?.display_name ?? ''}`}>
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : (list.data ?? []).length ? list.data.map((iv) => (
        <Card key={iv.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>Round {iv.seq}</T><Tag label={iv.status} color={iv.status === 'scheduled' ? c.sunSoft : iv.status === 'completed' ? c.lime : c.paper} /></View>
          <T size={12} color={c.mute}>{iv.scheduled_at ? at(iv.scheduled_at, iv.timezone) : 'No time set'}{iv.timezone ? ` (${iv.timezone})` : ''}{iv.location ? ` · ${iv.location}` : ''}</T>
          {iv.video_url ? <T size={12}>{iv.video_url}</T> : null}
          {iv.outcome ? <T size={12}>Outcome: {iv.outcome}</T> : null}
          {may && iv.status === 'scheduled' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title="Change" color={c.violet} onPress={() => setForm({ edit: iv })} />
            <Btn small title="Completed" color={c.mint} ink={c.ink} onPress={() => setForm({ complete: iv })} />
            <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => done(iv, 'cancelled')} />
          </View> : null}
        </Card>
      )) : <Empty emoji="🎤" title="No interviews yet" sub={may ? 'Schedule a first round. You can add more rounds until you decide.' : undefined} />}
      {may && ['shortlisted', 'interview'].includes(app?.stage) && !open ? <Btn title={(list.data ?? []).length ? `Schedule round ${(list.data ?? []).length + 1}` : 'Schedule an interview'} color={c.pink} onPress={() => setForm('new')} /> : null}
      <FormSheet visible={form === 'new'} onClose={() => setForm(null)} title="New interview round" fields={fields} initial={{ timezone: round?.timezone }}
        onSubmit={async (v) => { await api.post(`/program-applications/${app.id}/interviews`, { ...clean(v), eval_version: app.eval_version }); list.reload(); onChanged(); return 'Interview scheduled; the applicant has been told'; }} />
      <FormSheet visible={!!edit} onClose={() => setForm(null)} title="Change interview" fields={fields} initial={edit ? { timezone: edit.timezone ?? round?.timezone, video_url: edit.video_url ?? '', location: edit.location ?? '', notes: edit.notes ?? '' } : {}}
        onSubmit={async (v) => { await api.patch(`/program-interviews/${edit.id}`, { ...clean(v), version: edit.row_version }); list.reload(); onChanged(); return 'Interview updated; the applicant has been told'; }} />
      <FormSheet visible={typeof form === 'object' && !!form?.complete} onClose={() => setForm(null)} title="Interview completed" submitLabel="Mark completed"
        fields={[{ key: 'outcome', label: 'Outcome (internal)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/program-interviews/${form.complete.id}`, { version: form.complete.row_version, status: 'completed', ...(v.outcome ? { outcome: v.outcome } : {}) }); list.reload(); onChanged(); return 'Completed'; }} />
    </Sheet>
  );
}

function HistorySheet({ appId, onClose }) {
  const h = useLoad(() => (appId ? api.get(`/program-applications/${appId}/history`, { limit: 100 }) : Promise.resolve(null)), [appId]);
  const d = h.data;
  return (
    <Sheet visible={!!appId} onClose={onClose} title="Decision history">
      {h.error ? <LoadError error={h.error} onRetry={h.reload} /> : h.loading && !d ? <Loading /> : d ? (
        <>
          {d.decision ? (
            <Card color={d.decision.decision === 'award' ? c.lime : c.pinkSoft}>
              <T weight="900">{d.decision.decision === 'award' ? 'Awarded' : 'Declined'} · {at(d.decision.created_at)}</T>
              <T size={12}>Final score {pts(d.decision.score_snapshot?.final_score)} · {d.decision.score_snapshot?.submitted ?? 0} score(s){d.decision.rubric_snapshot ? ` · rubric v${d.decision.rubric_snapshot.version}: ${d.decision.rubric_snapshot.criteria.map((x) => `${x.name} ${x.weight}%`).join(', ')}` : ' · no rubric'}</T>
              <T size={12} color={c.mute}>References: application {d.alias}, terms v{d.decision.source_refs?.round_terms_version}{d.decision.source_refs?.identity_consent_id ? ', identity consented' : ''}</T>
            </Card>
          ) : null}
          {d.events.length ? d.events.map((e) => <T key={e.id} size={13}>{at(e.created_at)} · {String(e.kind).replace(/_/g, ' ')}{e.actor ? ` · ${e.actor}` : ''}</T>) : <Empty emoji="🕘" title="Nothing yet" sub="Stage changes, scores, conflicts and interviews are recorded here." />}
        </>
      ) : null}
    </Sheet>
  );
}

/** A round's evaluation: rubric, committee and the scoring board. `may` = manager/approver. */
export function RoundEvaluation({ round, program, may, onChanged }) {
  const { toast } = useSession();
  const rub = useLoad(() => api.get(`/program-rounds/${round.id}/rubric`), [round.id]);
  const ev = useLoad(() => api.get(`/program-rounds/${round.id}/evaluation`, { limit: 100 }), [round.id]);
  const [stage, setStage] = useState(null);
  const [edit, setEdit] = useState(false);
  const [scoring, setScoring] = useState(null);
  const [interviews, setInterviews] = useState(null);
  const [history, setHistory] = useState(null);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState([]);
  const [role, setRole] = useState('reviewer');
  const eligible = useLoad(() => (adding ? api.get(`/program-rounds/${round.id}/eligible-reviewers`) : Promise.resolve([])), [adding]);
  const reloadAll = () => { rub.reload(); ev.reload(); onChanged?.(); };
  const act = async (fn, m) => { try { await fn(); if (m) toast(m); reloadAll(); } catch (e) { toast(explain(e)); if (e.status === 409) reloadAll(); } };
  if (rub.error?.status === 403) return <Section title="Evaluation" color={c.cyan}><Empty emoji="🔒" title="Not part of the evaluation" sub="Only the brand's evaluators, managers, approvers and auditors can see how applications are scored." /></Section>;
  if (rub.error) return <Section title="Evaluation" color={c.cyan}><LoadError error={rub.error} onRetry={rub.reload} /></Section>;
  if (rub.loading && !rub.data) return <Section title="Evaluation" color={c.cyan}><Loading /></Section>;
  const rb = rub.data?.rubric, committee = rub.data?.reviewers ?? [], b = ev.data;
  const items = (b?.items ?? []).filter((x) => !stage || x.stage === stage);
  const download = async () => { try { const r = await api.get(`/program-rounds/${round.id}/evaluation-export`); if (typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); } toast(`${r.rows} row${r.rows === 1 ? '' : 's'} exported`); } catch (e) { toast(explain(e)); } };
  const move = (x, to) => act(() => api.post(`/program-applications/${x.id}/stage`, { stage: to, eval_version: x.eval_version }), `Moved to ${STAGE_LABEL[to].toLowerCase()}`);
  const ask = (x) => act(() => api.post(`/program-applications/${x.id}/identity-request`, {}), 'Request sent — the applicant decides');
  return (
    <Section title={`Evaluation · ${round.name}`} color={c.cyan}>
      <Card color={c.cyanSoft ?? c.paper}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>Rubric</T>{rb ? <Tag label={rb.status === 'active' ? 'Scoring open' : rb.status} color={rb.status === 'active' ? c.lime : c.sunSoft} /> : null}</View>
        {rb ? (
          <>
            {rb.criteria.map((x) => <T key={x.id} size={13}>{x.name} · {x.weight}%</T>)}
            <T size={12} color={c.mute}>Scale 1–{rb.scale_max} · applicants {rb.anonymize ? 'hidden until they consent' : 'shown to the committee'}{rb.scoring_closes_at ? ` · scoring closes ${at(rb.scoring_closes_at, round.timezone)}` : ''}{rb.locked_at ? ' · locked (scoring started)' : ''}</T>
            {may && rb.status === 'draft' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Btn small title="Edit" color={c.violet} onPress={() => setEdit(true)} />
              <Btn small title="Open scoring" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/program-rounds/${round.id}/rubric/activate`, { version: rb.row_version }), 'Scoring is open — reviewers have been told')} />
            </View> : null}
          </>
        ) : <Empty emoji="📐" title="No rubric yet" sub={may ? 'Set weighted criteria so a committee can score applications independently.' : 'A manager sets up the rubric.'} />}
        {may && !rb ? <Btn small title="Set up rubric" color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setEdit(true)} /> : null}
      </Card>
      {rb ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>Committee</T>{may ? <Btn small title="+ Reviewer" color={c.violet} onPress={() => setAdding(true)} /> : null}</View>
          {committee.length ? committee.map((m) => (
            <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <T size={13} style={{ flex: 1 }}>{m.display_name} · {m.role}</T>
              {may ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/program-rounds/${round.id}/reviewers/${m.user_id}/remove`), 'Removed from the committee')} accessibilityLabel={`Remove ${m.display_name} from the committee`} /> : null}
            </View>
          )) : <T size={13} color={c.mute}>No reviewers yet. Add the brand's evaluators or managers.</T>}
        </Card>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {[null, 'received', 'shortlisted', 'interview', 'finalist'].map((s) => <Chip key={s ?? 'all'} label={s ? STAGE_LABEL[s] : 'All'} active={stage === s} onPress={() => setStage(s)} />)}
      </View>
      {ev.error ? <LoadError error={ev.error} onRetry={ev.reload} /> : ev.loading && !b ? <Loading /> : items.length ? items.map((x) => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T weight="900">{x.anonymized ? `Application ${x.alias}` : `${x.applicant_name} → ${x.target_name ?? x.target_type}`}</T>
              <T size={12} color={c.mute}>asks {fmt(x.requested_cents, x.currency)} · {x.status}{x.interviews ? ` · ${x.interviews} interview${x.interviews === 1 ? '' : 's'}` : ''}{x.identity_status ? ` · identity ${x.identity_status === 'granted' ? 'shared' : 'requested'}` : ''}</T>
            </View>
            <Tag label={STAGE_LABEL[x.stage]} color={STAGE_TONE[x.stage]} />
          </View>
          <T size={12}>{b.can_see_all_scores ? `${x.summary.submitted} score${x.summary.submitted === 1 ? '' : 's'}${x.summary.final_score != null ? ` · final ${pts(x.summary.final_score)}` : ''}${x.summary.needs_moderation ? ' · needs moderation' : ''}` : `${x.summary.submitted} submitted`}{x.my_score ? ` · your score ${x.my_score.status}` : ''}</T>
          {x.my_conflict ? <T size={12} color={c.red}>You are recused: {x.my_conflict}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title={x.my_score?.status === 'submitted' ? 'My score' : 'Score'} color={c.pink} onPress={() => setScoring(x.id)} accessibilityLabel={`Open the score sheet for ${x.alias}`} />
            {b.can_moderate && x.status === 'submitted' && x.stage === 'received' && b.scoring_open ? <Btn small title="Shortlist" color={c.mint} ink={c.ink} onPress={() => move(x, 'shortlisted')} /> : null}
            {b.can_moderate && x.status === 'submitted' && x.stage === 'shortlisted' ? <Btn small title="Not shortlisted" color={c.paper} ink={c.red} onPress={() => move(x, 'received')} /> : null}
            {b.can_moderate && x.status === 'submitted' && x.stage === 'interview' ? <Btn small title="To finalists" color={c.mint} ink={c.ink} onPress={() => move(x, 'finalist')} /> : null}
            {x.stage !== 'received' || x.interviews ? <Btn small title="Interviews" color={c.violet} onPress={() => setInterviews(x)} /> : null}
            {may && x.status === 'submitted' && x.anonymized && !x.identity_status ? <Btn small title="Ask to identify" color={c.paper} ink={c.ink} onPress={() => ask(x)} /> : null}
            {b.can_see_all_scores ? <Btn small title="History" color={c.paper} ink={c.ink} onPress={() => setHistory(x.id)} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="📝" title={stage ? 'Nothing at this stage' : 'No applications to evaluate'} sub={stage ? 'Try another stage.' : 'They appear here as applicants submit to this round.'} />}
      {b && (may || b.can_see_all_scores) ? <Btn small title="Export evaluation (CSV)" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={download} /> : null}
      <RubricEditor visible={edit} onClose={() => setEdit(false)} round={round} rubric={rb?.status === 'draft' ? rb : null} onSaved={reloadAll} />
      <ScoreSheet appId={scoring} round={round} onClose={() => setScoring(null)} onChanged={reloadAll} />
      <InterviewSheet app={interviews ? { ...interviews, display_name: interviews.anonymized ? interviews.alias : interviews.applicant_name, eval_version: (ev.data?.items ?? []).find((y) => y.id === interviews.id)?.eval_version ?? interviews.eval_version } : null} may={b?.can_moderate} round={round} onClose={() => setInterviews(null)} onChanged={reloadAll} />
      <HistorySheet appId={history} onClose={() => setHistory(null)} />
      <Sheet visible={adding} onClose={() => setAdding(false)} title="Add to the committee">
        {eligible.error ? <LoadError error={eligible.error} onRetry={eligible.reload} /> : eligible.loading ? <Loading /> : (
          <>
            <EntityPicker label="Person" noun="evaluator" value={pick} onChange={setPick} options={(eligible.data ?? []).filter((e) => !e.on_committee).map((e) => ({ id: e.id, label: e.display_name, sub: `@${e.handle}` }))} />
            <View style={{ flexDirection: 'row', gap: 8 }}><Chip label="Reviewer" active={role === 'reviewer'} onPress={() => setRole('reviewer')} /><Chip label="Moderator" active={role === 'moderator'} onPress={() => setRole('moderator')} /></View>
            <T size={12} color={c.mute}>Moderators also resolve disagreement and move applications between stages.</T>
            <Btn title="Add" disabled={!pick.length} color={c.mint} ink={c.ink} onPress={() => act(async () => { await api.post(`/program-rounds/${round.id}/reviewers`, { user_id: pick[0].id, role }); setPick([]); setAdding(false); }, 'Added to the committee')} />
          </>
        )}
      </Sheet>
    </Section>
  );
}

/** Applicant: the identity request from the brand and the interviews I am invited to. Scores are never part of this. */
export function ApplicantEvaluation({ application, onChanged }) {
  const { toast } = useSession();
  const iv = useLoad(() => api.get('/my/program-interviews', { limit: 50 }), []);
  const mine = (iv.data ?? []).filter((x) => x.application_id === application.id);
  const respond = async (decision) => { try { await api.post(`/program-applications/${application.id}/identity-response`, { decision }); toast(decision === 'grant' ? 'You agreed to be identified' : decision === 'deny' ? 'Declined' : 'Withdrawn'); onChanged(); } catch (e) { toast(explain(e)); onChanged(); } };
  return (
    <>
      {application.identity_status === 'requested' ? (
        <Card color={c.sunSoft}>
          <T weight="900">The sponsor asks to know who you are</T>
          <T size={12}>Until you agree, the committee only sees an alias. You decide; you can withdraw later.</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Agree" color={c.mint} ink={c.ink} onPress={() => respond('grant')} /><Btn small title="Not now" color={c.paper} ink={c.red} onPress={() => respond('deny')} /></View>
        </Card>
      ) : application.identity_status === 'granted' ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={12} style={{ flex: 1 }}>You agreed to be identified to this sponsor.</T>{application.status === 'submitted' ? <Btn small title="Withdraw consent" color={c.paper} ink={c.red} onPress={() => respond('revoke')} /> : null}</View> : null}
      {mine.map((x) => (
        <Card key={x.id} color={c.violetSoft}>
          <T weight="900">Interview round {x.seq}</T>
          <T size={12}>{x.scheduled_at ? `${at(x.scheduled_at, x.timezone)}${x.timezone ? ` (${x.timezone})` : ''}` : 'Time to be confirmed'}{x.location ? ` · ${x.location}` : ''}</T>
          {x.video_url ? <T size={12}>Video call: {x.video_url}</T> : null}
          {x.notes ? <T size={12}>{x.notes}</T> : null}
        </Card>
      ))}
    </>
  );
}
