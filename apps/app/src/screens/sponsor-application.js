import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { storage } from '../storage';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, T, Tag } from '../ui';
import { Counter, DateField } from '../pickers';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { pickDocument } from './insurance';
import { fieldsOf, filled, fmtMoney, fromMinor, newKey, stepOfIssue, toMinor, visibleKeys } from '../application-forms';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const STATUS_TONE = { draft: c.sunSoft, submitted: c.sunSoft, returned: c.pinkSoft, awarded: c.lime, declined: c.pinkSoft, withdrawn: c.paper };
const EVENT_LABEL = { submitted: 'Submitted', correction_requested: 'Returned for correction', corrected: 'Corrected and resubmitted', withdrawn: 'Withdrawn' };
const mirrorKey = (r, t, i) => `sa-draft:${r}:${t}:${i}`;

/** A file question: the files attached to it, and a button to add one (a PDF or a photo; kept encrypted, seen only by you and the sponsor). */
function FileQuestion({ f, files, applicationId, ensureDraft, onChanged, disabled, uploadBase = '/program-applications', removeBase = '/application-files', who = "the sponsor's program staff" }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const mine = files.filter((x) => x.field_key === f.key);
  const add = async () => {
    setBusy(true);
    try {
      const picked = await pickDocument();
      if (!picked) return;
      const id = applicationId ?? (await ensureDraft());
      await api.upload(`${uploadBase}/${id}/files`, picked.blob, { field: f.key, name: picked.name });
      await onChanged();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const remove = async (x) => { try { await api.del(`${removeBase}/${x.id}`); await onChanged(); } catch (e) { toast(explain(e)); } };
  return (
    <View style={{ gap: 6 }}>
      {mine.map((x) => (
        <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T style={{ flex: 1 }} size={13}>📎 {x.original_name ?? 'File'} · {Math.max(1, Math.round(x.size_bytes / 1024))} KB</T>
          {!disabled ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => remove(x)} accessibilityLabel={`Remove ${x.original_name ?? 'file'}`} /> : null}
        </View>
      ))}
      {!disabled && mine.length < (f.max_files ?? 5) ? <Btn small title={mine.length ? 'Attach another file' : 'Attach a PDF or photo'} color={c.violet} loading={busy} onPress={add} style={{ alignSelf: 'flex-start' }} /> : null}
      <T size={12} color={c.mute}>Up to {f.max_files ?? 5} file{(f.max_files ?? 5) === 1 ? '' : 's'}, 10 MB each. Stored encrypted; only you and {who} can open them.</T>
    </View>
  );
}

function BudgetEditor({ f, lines, setLines, currency, requested, disabled, bad }) {
  const total = lines.reduce((s, l) => s + (l.amount_cents ?? 0), 0);
  const upd = (i, patch) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <View style={{ gap: 8 }}>
      {lines.map((l, i) => (
        <Card key={i}>
          <Field label="What it pays for" value={l.label} onChangeText={(x) => upd(i, { label: x })} maxLength={120} />
          <Field label={`Amount (${currency})`} value={l.text ?? fromMinor(l.amount_cents, currency)} keyboardType="decimal-pad" onChangeText={(x) => { const t = x.replace(/[^0-9.,]/g, ''); upd(i, { text: t, amount_cents: toMinor(t, currency) }); }} />
          {!disabled ? <Btn small title="Remove line" color={c.paper} ink={c.red} onPress={() => setLines(lines.filter((_, k) => k !== i))} style={{ alignSelf: 'flex-start' }} /> : null}
        </Card>
      ))}
      {!disabled && lines.length < 30 ? <Btn small title="+ Add a budget line" color={c.violet} onPress={() => setLines([...lines, { label: '', amount_cents: undefined }])} style={{ alignSelf: 'flex-start' }} /> : null}
      <T size={13} weight="800" color={requested != null && total < requested ? c.red : c.ink}>Budget total {fmtMoney(total, currency)}{requested != null ? ` · you request ${fmtMoney(requested, currency)}` : ''}</T>
      {requested != null && total < requested && lines.length ? <T size={12} color={c.red}>The budget total cannot be less than the amount you request.</T> : null}
      {bad ? <T size={12} color={c.red}>{bad}</T> : null}
    </View>
  );
}

function ReferencesEditor({ f, refs, setRefs, disabled }) {
  const max = f.max_items ?? 3;
  const upd = (i, patch) => setRefs(refs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <View style={{ gap: 8 }}>
      {refs.map((r, i) => (
        <Card key={i}>
          <Field label="Name" value={r.name} onChangeText={(x) => upd(i, { name: x })} maxLength={120} />
          <Field label="Relationship to you" value={r.relationship} onChangeText={(x) => upd(i, { relationship: x })} maxLength={120} />
          <Field label="Email" value={r.email} keyboardType="email-address" onChangeText={(x) => upd(i, { email: x })} />
          <Field label="Phone" value={r.phone} keyboardType="phone-pad" onChangeText={(x) => upd(i, { phone: x })} />
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>May the sponsor contact this person?</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[[true, 'Yes, with my consent'], [false, 'No, keep on file only']].map(([v, l]) => <Chip key={String(v)} label={l} active={r.may_contact === v} onPress={() => upd(i, { may_contact: v })} />)}</View>
          </View>
          {!disabled ? <Btn small title="Remove reference" color={c.paper} ink={c.red} onPress={() => setRefs(refs.filter((_, k) => k !== i))} style={{ alignSelf: 'flex-start' }} /> : null}
        </Card>
      ))}
      {!disabled && refs.length < max ? <Btn small title="+ Add a reference" color={c.violet} onPress={() => setRefs([...refs, { name: '', relationship: '', may_contact: false }])} style={{ alignSelf: 'flex-start' }} /> : null}
      <T size={12} color={c.mute}>References are stored encrypted. Nobody is contacted unless you say yes above.</T>
    </View>
  );
}

/** One question, with the right control for its kind. */
export function Question({ f, form, disabled, bad }) {
  const { values, setValue, currency, texts, setText } = form;
  const v = values[f.key];
  const label = <T weight="800" size={13}>{f.label}{f.required ? '' : ' (optional)'}{f.confidential ? '  🔒' : ''}</T>;
  const body = (() => {
    switch (f.type) {
      case 'text': return <Field accessibilityLabel={f.label} value={v ?? ''} onChangeText={(x) => setValue(f.key, x)} maxLength={f.max ?? 300} />;
      case 'longtext': return <Field accessibilityLabel={f.label} value={v ?? ''} onChangeText={(x) => setValue(f.key, x)} multiline maxLength={f.max ?? 4000} />;
      case 'number': return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Counter value={v ?? f.min ?? 0} min={f.min ?? 0} max={f.max ?? 1e6} onChange={(x) => setValue(f.key, x)} />
          {v === undefined ? <T size={12} color={c.mute}>Tap + or − to answer</T> : !disabled && !f.required ? <Chip label="Clear" onPress={() => setValue(f.key, undefined)} /> : null}
        </View>);
      case 'money': return <Field accessibilityLabel={f.label} value={texts[f.key] ?? fromMinor(v, currency)} keyboardType="decimal-pad" placeholder={`${currency} 0`} onChangeText={(x) => { const t = x.replace(/[^0-9.,]/g, ''); setText(f.key, t); setValue(f.key, toMinor(t, currency)); }} />;
      case 'date': return <DateField value={v} onChange={(x) => setValue(f.key, x)} optional={!f.required} />;
      case 'yesno': return <Seg options={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} value={v} onChange={(x) => setValue(f.key, x)} color={c.pink} />;
      case 'choice': return f.options.length > 4
        ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{f.options.map((o) => <Chip key={o.value} label={o.label} active={v === o.value} onPress={() => setValue(f.key, o.value)} />)}</View>
        : <Seg options={f.options} value={v} onChange={(x) => setValue(f.key, x)} color={c.pink} />;
      case 'multi': return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{f.options.map((o) => <Chip key={o.value} label={o.label} active={v?.includes(o.value)} onPress={() => setValue(f.key, v?.includes(o.value) ? v.filter((x) => x !== o.value) : [...(v ?? []), o.value])} />)}</View>;
      case 'file': return <FileQuestion f={f} files={form.files} applicationId={form.applicationId} ensureDraft={form.ensureDraft} onChanged={form.reloadFiles} disabled={disabled} uploadBase={form.uploadBase} removeBase={form.removeBase} who={form.who} />;
      case 'budget': return <BudgetEditor f={f} lines={form.budget} setLines={form.setBudget} currency={currency} requested={form.requested} disabled={disabled} bad={bad} />;
      case 'references': return <ReferencesEditor f={f} refs={form.refs} setRefs={form.setRefs} disabled={disabled} />;
      default: return null;
    }
  })();
  return (
    <View style={{ gap: 6, opacity: disabled ? 0.6 : 1 }} pointerEvents={disabled && !['file', 'budget', 'references'].includes(f.type) ? 'none' : 'auto'}>
      {label}
      {f.hint ? <T size={12} color={c.mute}>{f.hint}</T> : null}
      {f.profile_key && v !== undefined && form.fromProfile?.has(f.key) ? <T size={12} color={c.mute}>Filled from your saved details</T> : null}
      {body}
      {bad ? <T size={12} color={c.red}>{bad}</T> : null}
    </View>
  );
}

const Receipt = ({ app, onWithdraw, openFile }) => {
  const def = app.form.definition;
  return (
    <>
      <Card color={c.mintSoft}>
        <T weight="900" size={18}>✔ {app.status === 'submitted' ? 'Application received' : `Application ${app.status}`}</T>
        <T weight="800">Receipt {app.receipt_no}</T>
        <T size={12} color={c.mute}>Submitted {when(app.submitted_at)} · form version {app.form_version} · {app.program_name}, {app.round_name}</T>
        <T size={12} color={c.mute}>You asked for {fmtMoney(app.requested_cents, app.currency)}{app.awarded_cents ? ` · awarded ${fmtMoney(app.awarded_cents, app.currency)}` : ''}</T>
        {app.decision_reason ? <T size={13}>Note from the sponsor: {app.decision_reason}</T> : null}
      </Card>
      {def.sections.map((s) => (
        <Section key={s.id} title={s.title} color={c.cyan}>
          {s.fields.filter((f) => !['budget', 'references', 'file'].includes(f.type) && filled(app.answers[f.key])).map((f) => (
            <View key={f.key}><T size={12} color={c.mute}>{f.label}</T><T>{Array.isArray(app.answers[f.key]) ? app.answers[f.key].map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(', ') : f.type === 'yesno' ? (app.answers[f.key] ? 'Yes' : 'No') : f.type === 'money' ? fmtMoney(app.answers[f.key], app.currency) : f.options?.find((o) => o.value === app.answers[f.key])?.label ?? String(app.answers[f.key])}</T></View>
          ))}
          {s.fields.some((f) => f.type === 'budget') && app.budget.length ? app.budget.map((l, i) => <T key={i}>{l.label} · {fmtMoney(l.amount_cents, app.currency)}</T>) : null}
          {s.fields.some((f) => f.type === 'references') && app.references.length ? app.references.map((r, i) => <T key={i}>{r.name} ({r.relationship}) · {r.may_contact ? 'may be contacted' : 'on file only'}</T>) : null}
          {s.fields.filter((f) => f.type === 'file').flatMap((f) => app.files.filter((x) => x.field_key === f.key).map((x) => <Btn key={x.id} small title={`📎 ${x.original_name ?? 'File'}`} color={c.paper} onPress={() => openFile(x)} style={{ alignSelf: 'flex-start' }} />))}
        </Section>
      ))}
      <Section title="History" color={c.sun}>
        {app.events.map((e, i) => <T key={i} size={13}>{EVENT_LABEL[e.kind] ?? e.kind} · {when(e.created_at)}{e.note ? ` — ${e.note}` : ''}</T>)}
      </Section>
      {['submitted', 'returned'].includes(app.status) ? <Btn title="Withdraw application" color={c.paper} ink={c.red} onPress={onWithdraw} /> : null}
    </>
  );
};

/** Apply to a round that uses an application form: stepped, autosaved, resumable, with a receipt and controlled corrections. */
export function ApplicationForm({ round_id, target_type, target_id }) {
  const { toast } = useSession();
  const { back } = useNav();
  const load = useLoad(() => api.get(`/program-rounds/${round_id}/application-form`, { target_type, target_id }), [round_id, target_type, target_id]);
  const [app, setApp] = useState(null);
  const [answers, setAnswers] = useState({});
  const [texts, setTexts] = useState({});
  const [requested, setRequested] = useState(undefined);
  const [reqText, setReqText] = useState('');
  const [budget, setBudget] = useState([]);
  const [refs, setRefs] = useState([]);
  const [fromProfile, setFromProfile] = useState(new Set());
  const [step, setStep] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('saved'); // saved | saving | unsaved | error
  const [banner, setBanner] = useState(null);          // { kind: 'form' | 'conflict' | 'error', text }
  const [issues, setIssues] = useState([]);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const saving = useRef(false);
  const again = useRef(false);
  const latest = useRef({});
  const data = load.data;
  const def = data?.form?.definition;
  const currency = data?.program.currency;
  const returned = app?.status === 'returned';
  const flagged = new Set(app?.correction?.fields ?? []);

  // take the server's state (or restore unsent edits kept on this device) whenever the form is (re)loaded
  useEffect(() => {
    if (!data?.form) return;
    const mine = data.applications[0] ?? null;
    setApp(mine);
    const a = { ...(mine?.answers ?? {}) };
    const prof = new Set();
    if (!mine) for (const [k, val] of Object.entries(data.profile)) { a[k] = val; prof.add(k); }
    setFromProfile(prof);
    setAnswers(a); setBudget(mine?.budget ?? []); setRefs(mine?.references ?? []);
    setRequested(mine?.requested_cents ?? undefined); setReqText(fromMinor(mine?.requested_cents, currency));
    setDirty(false); setSaveState('saved'); setBanner(null);
    if (!mine || mine.status === 'draft') {
      storage.get(mirrorKey(round_id, target_type, target_id)).then((raw) => {
        try {
          const m = raw ? JSON.parse(raw) : null;
          if (m && m.base === (mine?.row_version ?? 0)) { setAnswers((p) => ({ ...p, ...m.answers })); if (m.requested !== undefined) { setRequested(m.requested); setReqText(fromMinor(m.requested, currency)); } if (m.budget) setBudget(m.budget); setDirty(true); }
        } catch {}
      });
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const vis = def ? visibleKeys(def, answers) : new Set();
  latest.current = { answers, requested, budget, refs, app, def };

  const payload = () => {
    const { answers: a, requested: r, budget: b, refs: rf, def: d } = latest.current;
    const v = visibleKeys(d, a), clean = {};
    for (const f of fieldsOf(d)) if (v.has(f.key) && !['file', 'budget', 'references'].includes(f.type) && filled(a[f.key])) clean[f.key] = a[f.key];
    return { requested_cents: r, answers: clean, budget: b.filter((l) => l.label || l.amount_cents).map(({ label, amount_cents }) => ({ label, amount_cents })), references: rf };
  };

  const save = useCallback(async ({ rebase = false } = {}) => {
    if (saving.current) { again.current = true; return latest.current.app; }
    saving.current = true; setSaveState('saving');
    try {
      const cur = latest.current.app;
      const res = await api.post(`/program-rounds/${round_id}/draft`, { target_type, target_id, version: cur?.row_version, rebase: rebase || undefined, ...payload() });
      latest.current.app = res; setApp(res); setDirty(false); setSaveState('saved'); setBanner(null);
      await storage.del(mirrorKey(round_id, target_type, target_id));
      return res;
    } catch (e) {
      if (e.details?.code === 'stale_form_version') setBanner({ kind: 'form', text: 'The sponsor updated this form while you were filling it. Your matching answers can be carried over to the new version.' });
      else if (e.status === 409 && e.details?.current_version) setBanner({ kind: 'conflict', text: 'This draft was changed on another device or tab. Load the latest to keep going.' });
      else { setBanner({ kind: 'error', text: explain(e) }); }
      setSaveState('error');
      throw e;
    } finally {
      saving.current = false;
      if (again.current) { again.current = false; setDirty(true); }
    }
  }, [round_id, target_type, target_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // autosave: shortly after the last change, and keep unsent edits (never confidential answers or references) on this device meanwhile
  useEffect(() => {
    if (!dirty || !def || returned || (app && app.status !== 'draft')) return undefined;
    setSaveState('unsaved');
    const open = {}; for (const f of fieldsOf(def)) if (!f.confidential && answers[f.key] !== undefined && !['file', 'budget', 'references'].includes(f.type)) open[f.key] = answers[f.key];
    storage.set(mirrorKey(round_id, target_type, target_id), JSON.stringify({ base: app?.row_version ?? 0, answers: open, requested, budget: budget.map(({ label, amount_cents }) => ({ label, amount_cents })) }));
    const t = setTimeout(() => { if (!banner) save().catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [dirty, answers, requested, budget, refs]); // eslint-disable-line react-hooks/exhaustive-deps

  const touch = () => { setDirty(true); setIssues([]); };
  const setValue = (k, v) => { setAnswers((p) => { const n = { ...p }; if (v === undefined || v === '') delete n[k]; else n[k] = v; return n; }); touch(); };
  const ensureDraft = async () => (await save()).id;
  const reloadFiles = async () => { if (!latest.current.app) return; const fresh = await api.get(`/program-applications/${latest.current.app.id}`); latest.current.app = { ...latest.current.app, files: fresh.files }; setApp((p) => ({ ...p, files: fresh.files })); };

  if (load.error) return <Screen><LoadError error={load.error} onRetry={load.reload} /></Screen>;
  if (load.loading && !data) return <Screen><Loading /></Screen>;
  if (!data.form) return <Screen><Empty emoji="📝" title="This round uses the plain application" sub="Go back and apply from the funding opportunities list." /></Screen>;
  const closed = data.round.state !== 'open';
  const sections = def.sections;
  const reviewing = step >= sections.length;
  const form = { values: answers, setValue, currency, texts, setText: (k, t) => setTexts((p) => ({ ...p, [k]: t })), files: app?.files ?? [], applicationId: app?.id, ensureDraft, reloadFiles, budget, setBudget: (b) => { setBudget(b); touch(); }, refs, setRefs: (r) => { setRefs(r); touch(); }, requested, fromProfile };
  const badOf = (f) => issues.find((i) => i.path === `answers.${f.key}` || i.path === `files.${f.key}` || (f.type === 'budget' && i.path === 'budget') || (f.type === 'references' && i.path === 'references'))?.message;
  const openFile = async (x) => { try { const blob = await api.download(`/application-files/${x.id}`); if (Platform.OS === 'web') { const u = URL.createObjectURL(blob); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 120000); } else toast('Open documents in the web app'); } catch (e) { toast(explain(e)); } };
  const remember = async () => {
    try {
      const cur = await api.get('/me/applicant-profile');
      const data = { ...cur.data };
      for (const f of fieldsOf(def)) if (f.profile_key && filled(answers[f.key]) && ['text', 'longtext', 'number', 'money', 'date', 'choice', 'yesno'].includes(f.type)) data[f.profile_key] = answers[f.key];
      await api.post('/me/applicant-profile', { version: cur.row_version, data });
      toast('Saved to your applicant details — they prefill future applications');
    } catch (e) { toast(explain(e)); }
  };
  const withdraw = async () => { try { await api.post(`/program-applications/${app.id}/withdraw`); toast('Application withdrawn'); back(); } catch (e) { toast(explain(e)); } };

  if (app && !['draft', 'returned'].includes(app.status)) return <Screen><H1>Your application</H1><Receipt app={app} onWithdraw={withdraw} openFile={openFile} /></Screen>;
  if (closed && !app) return <Screen><H1>{data.program.name}</H1><Empty emoji="⏳" title={data.round.state === 'scheduled' ? 'This round has not opened yet' : 'This round is closed'} sub={`${data.round.name}: ${data.round.opens_on} to ${data.round.closes_on}`} /></Screen>;

  const submit = async () => {
    setBusy(true); setIssues([]);
    try {
      let res;
      if (returned) {
        const p = payload();
        res = await api.post(`/program-applications/${app.id}/correction`, { idempotency_key: key.current, version: app.row_version, requested_cents: p.requested_cents, answers: { ...app.answers, ...p.answers }, budget: p.budget, references: p.references });
      } else {
        await save(); // everything on screen is on the server before it is submitted
        res = await api.post(`/program-applications/${latest.current.app.id}/submit`, { idempotency_key: key.current });
      }
      setApp(res); key.current = newKey(); toast(`Received — receipt ${res.receipt_no}`);
    } catch (e) {
      if (Array.isArray(e.details) && e.details[0]?.path) { setIssues(e.details); setStep(stepOfIssue(def, e.details[0].path)); toast('Some answers need attention'); }
      else if (!e.details?.code) toast(explain(e));
    } finally { setBusy(false); }
  };

  const mayEdit = (f) => !returned || flagged.has(f.key) || (f.type === 'budget' && flagged.has(f.key)) || (f.type === 'references' && flagged.has(f.key));
  return (
    <Screen>
      <H1>{data.program.name}</H1>
      <T size={12} color={c.mute}>{data.round.name} · closes {data.round.closes_on} · form version {data.form.version}{data.program.max_award_cents ? ` · up to ${fmtMoney(data.program.max_award_cents, currency)}` : ''}</T>
      <View accessibilityRole="progressbar" accessibilityLabel={`Step ${Math.min(step + 1, sections.length + 1)} of ${sections.length + 1}`} style={{ flexDirection: 'row', gap: 6 }}>
        {[...sections, { id: 'review' }].map((s, i) => <View key={s.id} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= step ? c.pink : c.line }} />)}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T size={12} color={c.mute} style={{ flex: 1 }}>{returned ? 'Returned for correction' : saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? (app ? `Draft saved ${when(app.updated_at)} — you can continue on any device` : 'Nothing saved yet') : saveState === 'unsaved' ? 'Unsaved changes — saving shortly' : 'Not saved'}</T>
        {!returned ? <Btn small title="Save draft" color={c.paper} ink={c.ink} onPress={() => save().then(() => toast('Draft saved')).catch((e) => toast(explain(e)))} /> : null}
      </View>
      {returned ? <Card color={c.pinkSoft}><T weight="900">The sponsor asked you to correct this</T><T>{app.correction?.note}</T><T size={12} color={c.mute}>Only these can be changed: {[...flagged].map((k) => (k === 'requested_cents' ? 'Amount requested' : fieldsOf(def).find((f) => f.key === k)?.label ?? k)).join(', ')}.</T></Card> : null}
      {banner ? (
        <Card color={c.pinkSoft}>
          <T weight="800">{banner.kind === 'form' ? 'The form changed' : banner.kind === 'conflict' ? 'Draft changed elsewhere' : 'We could not save'}</T>
          <T size={13}>{banner.text}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            {banner.kind === 'form' ? <Btn small title="Carry my answers over" onPress={() => save({ rebase: true }).then(load.reload).catch(() => {})} /> : null}
            {banner.kind === 'conflict' ? <Btn small title="Load the latest" onPress={() => { setBanner(null); load.reload(); }} /> : null}
            {banner.kind === 'error' ? <Btn small title="Try again" onPress={() => { setBanner(null); save().catch(() => {}); }} /> : null}
          </View>
        </Card>
      ) : null}
      {issues.length ? <Card color={c.pinkSoft}><T weight="800">Please check</T>{issues.slice(0, 6).map((i, k) => <T key={k} size={13}>• {i.message}</T>)}</Card> : null}

      {!reviewing ? (
        <Section title={sections[step].title} color={c.pink}>
          {step === 0 ? (
            <View style={{ gap: 6, opacity: returned && !flagged.has('requested_cents') ? 0.6 : 1 }} pointerEvents={returned && !flagged.has('requested_cents') ? 'none' : 'auto'}>
              <T weight="800" size={13}>Amount you are asking for ({currency})</T>
              <Field accessibilityLabel="Amount you are asking for" value={reqText} keyboardType="decimal-pad" placeholder={`${currency} 0`} onChangeText={(x) => { const t = x.replace(/[^0-9.,]/g, ''); setReqText(t); setRequested(toMinor(t, currency)); touch(); }} />
              {issues.some((i) => i.path === 'requested_cents') ? <T size={12} color={c.red}>Enter the amount you are requesting</T> : null}
            </View>
          ) : null}
          {sections[step].fields.filter((f) => vis.has(f.key)).map((f) => <Question key={f.key} f={f} form={form} disabled={!mayEdit(f)} bad={badOf(f)} />)}
        </Section>
      ) : (
        <Section title="Review and submit" color={c.mint}>
          <T>Amount requested: {requested != null ? fmtMoney(requested, currency) : '—'}</T>
          {sections.map((s, i) => (
            <Card key={s.id}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{s.title}</T><Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setStep(i)} /></View>
              {s.fields.filter((f) => vis.has(f.key)).map((f) => {
                const done = f.type === 'file' ? form.files.some((x) => x.field_key === f.key) : f.type === 'budget' ? budget.length > 0 : f.type === 'references' ? refs.length > 0 : filled(answers[f.key]);
                return <T key={f.key} size={13} color={done ? c.ink : f.required ? c.red : c.mute}>{done ? '✓' : f.required ? '✗ Missing:' : '–'} {f.label}</T>;
              })}
            </Card>
          ))}
          {fieldsOf(def).some((f) => f.profile_key && filled(answers[f.key])) && !returned ? <Btn small title="Remember these details for next time" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={remember} /> : null}
          <T size={12} color={c.mute}>When you submit, the form version and the program terms you applied under are kept with your application and you get a receipt number. Submitting twice (a retry or a double tap) never files it twice.</T>
          <Btn title={returned ? 'Send correction' : 'Submit application'} loading={busy} disabled={!!banner} onPress={submit} />
        </Section>
      )}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : null}
        {!reviewing ? <Btn title={step === sections.length - 1 ? 'Review' : 'Next'} onPress={() => setStep(step + 1)} style={{ flex: 2 }} /> : null}
      </View>
    </Screen>
  );
}
