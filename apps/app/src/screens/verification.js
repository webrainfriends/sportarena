import React, { useState } from 'react';
import { Platform, Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Section, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';

const isWeb = Platform.OS === 'web';
const STATE = { submitted: ['In queue', c.sunSoft], in_review: ['Being reviewed', c.cyanSoft], needs_info: ['More info needed', c.orangeSoft], approved: ['Verified ✓', c.lime], rejected: ['Declined', c.pinkSoft], revoked: ['Revoked', c.pinkSoft], withdrawn: ['Withdrawn', c.violetSoft], expired: ['Expired', c.orangeSoft] };
const stateTag = (s) => <Tag label={STATE[s]?.[0] ?? s} color={STATE[s]?.[1]} />;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** Small public badge: "✓ Verified coach". */
export const VerifiedBadges = ({ list, style }) => (list?.length ? (
  <View style={[{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }, style]}>{list.map((b) => <Tag key={b.type} label={`✓ Verified ${b.type}`} color={c.lime} />)}</View>
) : null);

async function pickDocument() {
  if (isWeb) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'application/pdf,image/jpeg,image/png,image/webp';
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
  }
  const ImagePicker = await import('expo-image-picker');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
  if (r.canceled || !r.assets?.[0]) return null;
  const blob = await (await fetch(r.assets[0].uri)).blob();
  blob.name = r.assets[0].fileName ?? 'photo.jpg';
  return blob;
}
const toBase64 = (blob) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',').pop()); f.onerror = () => rej(new Error('Could not read that file')); f.readAsDataURL(blob); });

/** One evidence line: a reference (number or link) and/or a file. */
function EvidenceInput({ kind, label, value, onChange }) {
  const [busy, setBusy] = useState(false);
  const attach = async () => {
    setBusy(true);
    try { const f = await pickDocument(); if (f) onChange({ ...value, file: f, file_name: f.name }); } finally { setBusy(false); }
  };
  return (
    <Card color={c.violetSoft} pad={12}>
      <T weight="800" size={13}>{label}</T>
      <Field value={value?.reference ?? ''} onChangeText={(x) => onChange({ ...value, reference: x })} placeholder="Number or https:// link" />
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <Btn small title={value?.file ? 'Replace file' : 'Attach file (PDF/photo)'} color={c.violet} loading={busy} onPress={attach} />
        {value?.file ? <T size={12} color={c.mute}>{value.file_name} ✓</T> : null}
      </View>
    </Card>
  );
}
async function buildEvidence(inputs) {
  const out = [];
  for (const [kind, v] of Object.entries(inputs)) {
    if (!v?.reference?.trim() && !v?.file) continue;
    out.push({ kind, ...(v.reference?.trim() ? { reference: v.reference.trim() } : {}), ...(v.file ? { data: await toBase64(v.file), file_name: v.file_name } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------ requester
function RequestSheet({ visible, onClose, rules, onDone, preset }) {
  const { user, toast } = useSession();
  const eligible = (rules?.types ?? []).filter((t) => (t.needs_role ? user.roles.includes(t.needs_role) : user.roles.includes(t.subject === 'sponsor' ? 'sponsor' : 'organizer') || user.roles.includes('admin')));
  const [type, setType] = useState(null);
  const [subject, setSubject] = useState(null);
  const [inputs, setInputs] = useState({});
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const t = eligible.find((x) => x.type === (type ?? preset)) ?? null;
  const subjects = useLoad(() => (!visible || !t || t.subject === 'user' ? Promise.resolve([]) : t.subject === 'sponsor' ? api.get('/sponsors', { mine: true, limit: 50 }) : api.get('/events', { organizer_id: user.id, limit: 50 })), [visible, t?.type]);
  const kinds = t ? [...t.required, ...(t.one_of ?? [])] : [];
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const evidence = await buildEvidence(inputs);
      await api.post('/verification/cases', { type: t.type, subject_id: t.subject === 'user' ? undefined : subject, claim_note: note || undefined, evidence });
      toast('Sent to the platform team'); onDone(); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Request verification">
      {!eligible.length ? <T color={c.mute}>Add a role first (athlete, coach, physio, doctor, sponsor or organizer) — then you can ask for the matching badge.</T> : <>
        <T weight="800" size={13}>What do you want verified?</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{eligible.map((x) => <Chip key={x.type} label={x.label} active={t?.type === x.type} onPress={() => { setType(x.type); setSubject(null); setInputs({}); }} />)}</View>
        {t ? <>
          <T size={13} color={c.mute}>{t.summary} The badge lasts {t.validity_months} months.</T>
          {t.subject !== 'user' ? (subjects.data?.length ? <View style={{ gap: 6 }}><T weight="800" size={13}>{t.subject === 'sponsor' ? 'Which brand?' : 'Which event?'}</T><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{subjects.data.map((s) => <Chip key={s.id} label={s.name} active={subject === s.id} onPress={() => setSubject(s.id)} />)}</View></View> : <T color={c.mute}>{subjects.loading ? 'Loading…' : `You don't have a ${t.subject} yet — create one first.`}</T>) : null}
          <T weight="800" size={13}>Evidence — {t.required.length ? 'all required' : 'at least one'}{t.one_of?.length && t.required.length ? ', plus one of the optional proofs' : ''}</T>
          {t.required.map((k) => <EvidenceInput key={k} kind={k} label={`${rules.evidence_kinds[k]} · required`} value={inputs[k]} onChange={(v) => setInputs({ ...inputs, [k]: v })} />)}
          {(t.one_of ?? []).map((k) => <EvidenceInput key={k} kind={k} label={`${rules.evidence_kinds[k]} · give at least one of these`} value={inputs[k]} onChange={(v) => setInputs({ ...inputs, [k]: v })} />)}
          <Field label="Anything the reviewer should know (optional)" value={note} onChangeText={setNote} multiline />
          <T size={12} color={c.mute}>Documents are encrypted and only visible to the platform review team. Your public page only ever shows the badge.</T>
          {err ? <T color={c.red} weight="700">{err}</T> : null}
          <Btn title="Submit for review" color={c.pink} loading={busy} disabled={t.subject !== 'user' && !subject} onPress={send} />
        </> : null}
      </>}
    </Sheet>
  );
}

function CaseSheet({ id, rules, onClose, onChange }) {
  const { toast } = useSession();
  const d = useLoad(() => (id ? api.get(`/verification/cases/${id}`) : Promise.resolve(null)), [id]);
  const [kind, setKind] = useState(null);
  const [val, setVal] = useState({});
  const x = d.data;
  const run = async (fn, msg) => { try { await fn(); toast(msg); d.reload(); onChange(); } catch (e) { toast(e.message); } };
  const kinds = x ? Object.keys(rules.evidence_kinds) : [];
  return (
    <Sheet visible={!!id} onClose={onClose} title={x ? `Case #${x.case_no} · ${x.label}` : 'Verification case'}>
      {d.loading && !x ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : x ? <>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{stateTag(x.status)}{x.expires_at ? <T size={12} color={c.mute}>{x.status === 'expired' ? 'expired' : 'valid until'} {day(x.expires_at)}</T> : null}</View>
        {x.decision_reason ? <Card color={c.sunSoft} pad={12}><T weight="800" size={13}>Reviewer's note</T><T>{x.decision_reason}</T></Card> : null}
        <T weight="800" size={13}>Evidence on file</T>
        {x.evidence.map((e) => <T key={e.id} size={13}>• {rules.evidence_kinds[e.kind] ?? e.kind}{e.file_name ? ` · ${e.file_name}` : ''}{e.has_reference ? ' · reference' : ''}</T>)}
        <T weight="800" size={13}>History</T>
        {x.history.map((h, i) => <T key={i} size={12} color={c.mute}>{day(h.created_at)} · {h.actor} · {h.action.replace('_', ' ')}{h.reason ? ` — ${h.reason}` : ''}</T>)}
        {['submitted', 'needs_info'].includes(x.status) ? <Card color={c.violetSoft} pad={12}>
          <T weight="800" size={13}>Add evidence</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{kinds.map((k) => <Chip key={k} label={rules.evidence_kinds[k]} active={kind === k} onPress={() => { setKind(k); setVal({}); }} />)}</View>
          {kind ? <>
            <EvidenceInput kind={kind} label={rules.evidence_kinds[kind]} value={val} onChange={setVal} />
            <Btn small title="Add" color={c.violet} onPress={() => run(async () => { const ev = await buildEvidence({ [kind]: val }); if (!ev.length) throw new Error('Add a reference or a file'); await api.post(`/verification/cases/${id}/evidence`, { evidence: ev }); setKind(null); }, 'Evidence added')} />
          </> : null}
        </Card> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {x.status === 'needs_info' ? <Btn title="Send back for review" color={c.pink} onPress={() => run(() => api.post(`/verification/cases/${id}/resubmit`), 'Back in the queue')} /> : null}
          {['submitted', 'in_review', 'needs_info'].includes(x.status) ? <Btn title="Withdraw" color={c.paper} ink={c.red} onPress={() => run(() => api.post(`/verification/cases/${id}/withdraw`), 'Withdrawn')} /> : null}
        </View>
      </> : null}
    </Sheet>
  );
}

export function VerificationSection() {
  const rules = useLoad(() => api.get('/verification/rules'), []);
  const mine = useLoad(() => api.get('/me/verifications'), []);
  const [req, setReq] = useState(false);
  const [open, setOpen] = useState(null);
  return (
    <Section title="Verification" color={c.lime}>
      <T size={13} color={c.mute}>Get a verified badge like on LinkedIn or Instagram. Request it, attach proof, and the platform team reviews your case. Only the badge is ever public.</T>
      <Btn small title="Request a badge" color={c.pink} onPress={() => setReq(true)} style={{ alignSelf: 'flex-start', marginVertical: 8 }} disabled={!rules.data} />
      {mine.loading && !mine.data ? <Loading /> : mine.data?.length ? mine.data.map((cs) => (
        <Row key={cs.id} onPress={() => setOpen(cs.id)} title={`${rules.data?.types.find((t) => t.type === cs.type)?.label ?? cs.type} · ${cs.subject_name}`} sub={`Case #${cs.case_no} · sent ${day(cs.submitted_at)}${cs.expires_at ? ` · ${cs.status === 'expired' ? 'expired' : 'until'} ${day(cs.expires_at)}` : ''}`} right={stateTag(cs.status)} />
      )) : <Empty emoji="🪪" title="No verification requests yet" />}
      {rules.data ? <>
        <RequestSheet visible={req} onClose={() => setReq(false)} rules={rules.data} onDone={mine.reload} />
        <CaseSheet id={open} rules={rules.data} onClose={() => setOpen(null)} onChange={mine.reload} />
      </> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ platform team
function ReviewSheet({ id, rules, me, onClose, onChange }) {
  const { toast } = useSession();
  const d = useLoad(() => (id ? api.get(`/verification/cases/${id}`) : Promise.resolve(null)), [id]);
  const [ev, setEv] = useState(null);
  const [ticks, setTicks] = useState({});
  const [reason, setReason] = useState('');
  const x = d.data;
  const mineCase = x && x.reviewer_id === me;
  const run = async (fn, msg) => { try { await fn(); toast(msg); d.reload(); onChange(); } catch (e) { toast(e.message); } };
  const decide = (decision) => run(async () => {
    await api.post(`/admin/verification/cases/${id}/decision`, { decision, reason: reason || undefined, checklist: x.checklist_template.map((t) => ({ key: t.key, ok: !!ticks[t.key] })) });
    if (decision !== 'needs_info') onClose();
  }, decision === 'approve' ? 'Approved' : decision === 'reject' ? 'Declined' : 'Asked for more information');
  return (
    <Sheet visible={!!id} onClose={onClose} title={x ? `Case #${x.case_no} · ${x.label}` : 'Review case'}>
      {d.loading && !x ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : x ? <>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{stateTag(x.status)}{x.expires_at ? <T size={12} color={c.mute}>until {day(x.expires_at)}</T> : null}</View>
        {x.claim_note ? <T size={13}>Requester says: {x.claim_note}</T> : null}
        <T weight="800" size={13}>Evidence</T>
        {ev ? ev.map((e) => <Card key={e.id} color={c.violetSoft} pad={12}><T weight="800" size={13}>{rules.evidence_kinds[e.kind] ?? e.kind}</T>{e.reference ? <T selectable size={13}>{e.reference}</T> : null}{e.file_name ? <T size={12} color={c.mute}>{e.file_name} · {Math.round(e.size_bytes / 1024)} KB · sha256 {e.sha256?.slice(0, 12)}…</T> : null}
          {e.file_name ? <Btn small title="Open file" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={async () => { try { const f = (await api.get(`/admin/verification/cases/${id}/evidence`, { evidence_id: e.id })).find((z) => z.id === e.id); const url = `data:${e.content_type};base64,${f.data}`; if (isWeb) { const w = window.open(); w.document.write(`<iframe src="${url}" style="border:0;width:100%;height:100%"></iframe>`); } else toast('Open this on the web console'); } catch (er) { toast(er.message); } }} /> : null}</Card>)
          : <Btn small title="Show evidence (audit-logged)" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => run(async () => setEv(await api.get(`/admin/verification/cases/${id}/evidence`)), 'Evidence opened and logged')} />}
        {x.status === 'in_review' && mineCase ? <>
          <T weight="800" size={13}>Reviewer checklist</T>
          {x.checklist_template.map((t) => <View key={t.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><T style={{ flex: 1 }} size={14}>{t.label}</T><Switch value={!!ticks[t.key]} onValueChange={(v) => setTicks({ ...ticks, [t.key]: v })} trackColor={{ true: c.pink }} /></View>)}
          <Field label="Reason (required to decline or ask for more; the requester sees it)" value={reason} onChangeText={setReason} multiline />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn title="Approve" color={c.mint} ink={c.ink} disabled={!x.checklist_template.every((t) => ticks[t.key])} onPress={() => decide('approve')} />
            <Btn title="Ask for more" color={c.sun} ink={c.ink} disabled={reason.trim().length < 5} onPress={() => decide('needs_info')} />
            <Btn title="Decline" color={c.paper} ink={c.red} disabled={reason.trim().length < 5} onPress={() => decide('reject')} />
          </View>
        </> : null}
        {x.status === 'submitted' ? <Btn title="Claim this case" color={c.pink} onPress={() => run(() => api.post(`/admin/verification/cases/${id}/claim`), 'Claimed')} /> : null}
        {x.status === 'approved' ? <>
          <Field label="Reason to revoke this badge" value={reason} onChangeText={setReason} multiline />
          <Btn title="Revoke badge" color={c.paper} ink={c.red} disabled={reason.trim().length < 5} onPress={() => run(() => api.post(`/admin/verification/cases/${id}/revoke`, { reason }), 'Badge revoked')} />
        </> : null}
        <T weight="800" size={13}>History</T>
        {x.history.map((h, i) => <T key={i} size={12} color={c.mute}>{day(h.created_at)} · {h.actor} · {h.action.replace('_', ' ')}{h.reason ? ` — ${h.reason}` : ''}</T>)}
      </> : null}
    </Sheet>
  );
}

export function VerificationQueue() {
  const { user } = useSession();
  const rules = useLoad(() => api.get('/verification/rules'), []);
  const [status, setStatus] = useState('open');
  const q = useLoad(() => api.get('/admin/verification/cases', { status, limit: 100 }), [status]);
  const [open, setOpen] = useState(null);
  return (
    <Section title="Verification queue (platform team)" color={c.cyan}>
      <Seg options={[['open', 'Open'], ['approved', 'Approved'], ['expired', 'Expired'], ['rejected', 'Declined'], ['revoked', 'Revoked']].map(([value, label]) => ({ value, label }))} value={status} onChange={setStatus} color={c.violet} />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : q.data?.length ? q.data.map((cs) => (
        <Row key={cs.id} onPress={() => setOpen(cs.id)} title={`#${cs.case_no} ${rules.data?.types.find((t) => t.type === cs.type)?.label ?? cs.type} · ${cs.subject_name}`} sub={`${cs.requester} · ${cs.evidence_count} item(s) · ${day(cs.submitted_at)}`} right={stateTag(cs.status)} />
      )) : <Empty emoji="📭" title="Nothing here" />}
      {rules.data ? <ReviewSheet id={open} rules={rules.data} me={user.id} onClose={() => setOpen(null)} onChange={q.reload} /> : null}
    </Section>
  );
}
