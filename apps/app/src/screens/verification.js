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
function RequestSheet({ visible, onClose, rules, onDone, preset, presetSubject }) {
  const { user, toast } = useSession();
  const eligible = (rules?.types ?? []).filter((t) => (t.needs_role ? user.roles.includes(t.needs_role) : user.roles.includes(t.subject === 'sponsor' ? 'sponsor' : 'organizer') || user.roles.includes('admin')));
  const [type, setType] = useState(null);
  const [pickedSubject, setSubject] = useState(null);
  const subject = pickedSubject ?? presetSubject ?? null;
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

// ------------------------------------------------------------------ onboarding timeline (light, one vertical rail)
const DOT = { done: [c.lime, '✓'], current: [c.pink, '●'], upcoming: [c.line, '○'], blocked: [c.red, '!'] };

/** Vertical timeline: a coloured dot per stage joined by a rail; the current stage is highlighted. */
export function Timeline({ stages }) {
  return (
    <View>
      {stages.map((s, i) => {
        const [col, glyph] = DOT[s.state] ?? DOT.upcoming, last = i === stages.length - 1, on = s.state !== 'upcoming';
        return (
          <View key={s.key} style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ alignItems: 'center', width: 30 }}>
              <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: on ? col : c.paper, borderWidth: on ? 0 : 2, borderColor: c.line, alignItems: 'center', justifyContent: 'center', ...(s.state === 'current' ? { shadowColor: col, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } } : null) }}>
                <T size={14} weight="800" color={on ? '#fff' : c.mute}>{glyph}</T>
              </View>
              {!last ? <View style={{ flex: 1, width: 3, minHeight: 24, borderRadius: 2, backgroundColor: s.state === 'done' ? c.lime : c.line, marginVertical: 2 }} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: last ? 0 : 16 }}>
              <T weight="800" size={15} color={s.state === 'upcoming' ? c.mute : c.ink}>{s.title}</T>
              {s.at ? <T size={12} color={c.mute}>{day(s.at)}</T> : null}
              {s.detail ? <T size={13} color={s.state === 'blocked' ? c.red : c.mute}>{s.detail}</T> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const NEXT_TONE = { you: [c.sunSoft, '👉 Your turn'], platform: [c.cyanSoft, '⏳ With the platform team'], none: [c.limeSoft, '🎉 All set'] };
export const NextStep = ({ step }) => {
  const [bg, who] = NEXT_TONE[step.actor] ?? NEXT_TONE.none;
  return (
    <Card color={bg} pad={14}>
      <T size={12} weight="800" color={c.mute}>{who.toUpperCase()}</T>
      <T weight="800" size={16}>{step.title}</T>
      <T size={13} color={c.mute}>{step.detail}</T>
      {step.missing?.length ? step.missing.map((m) => <T key={m} size={13} weight="700">• {m}</T>) : null}
    </Card>
  );
};

/** Who can read my documents: search-and-pick a person, choose how long, revoke later. */
function SharePanel({ caseId, documents }) {
  const { toast } = useSession();
  const shares = useLoad(() => api.get(`/verification/cases/${caseId}/shares`), [caseId]);
  const [q, setQ] = useState('');
  const [who, setWho] = useState(null);
  const [days, setDays] = useState(30);
  const [only, setOnly] = useState([]);
  const found = useLoad(() => (q.trim().length < 2 ? Promise.resolve([]) : api.get('/people', { q: q.trim(), limit: 6 })), [q]);
  const files = documents.flatMap((d) => d.items.map((it) => ({ id: it.id, label: `${d.label}${it.file_name ? ` · ${it.file_name}` : ''}` })));
  const act = async (fn, msg) => { try { await fn(); toast(msg); shares.reload(); } catch (e) { toast(e.message); } };
  const active = (shares.data ?? []).filter((x) => x.active);
  return (
    <Card color={c.paper} pad={14} style={{ borderWidth: 1, borderColor: c.line }}>
      <T weight="800" size={15}>🔐 Who can see these documents</T>
      <T size={12} color={c.mute}>Only you, plus people you pick here. Access ends on its own and you can revoke it any time.</T>
      {active.length ? active.map((x) => <Row key={x.id} title={x.grantee} sub={`${x.evidence_id ? 'One document' : 'All documents'} · until ${day(x.expires_at)}${x.purpose ? ` · ${x.purpose}` : ''}`} right={<Btn small title="Revoke" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/verification/shares/${x.id}/revoke`), 'Access revoked')} />} />) : <T size={13} color={c.mute}>Not shared with anyone.</T>}
      {who ? <View style={{ gap: 8, marginTop: 6 }}>
        <T weight="700" size={13}>Share with {who.display_name}</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[7, 30, 90].map((d) => <Chip key={d} label={`${d} days`} active={days === d} onPress={() => setDays(d)} />)}</View>
        <T size={12} color={c.mute}>Which documents? (none picked = all)</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{files.map((f) => <Chip key={f.id} label={f.label} active={only.includes(f.id)} onPress={() => setOnly(only.includes(f.id) ? only.filter((x) => x !== f.id) : [...only, f.id])} />)}</View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn small title="Share" color={c.pink} onPress={() => act(async () => { await api.post(`/verification/cases/${caseId}/shares`, { user_id: who.id, days, evidence_ids: only.length ? only : undefined }); setWho(null); setOnly([]); setQ(''); }, 'Shared')} />
          <Btn small title="Cancel" color={c.paper} ink={c.mute} onPress={() => setWho(null)} />
        </View>
      </View> : <>
        <Field label="Share with someone" value={q} onChangeText={setQ} placeholder="Search by name or handle" />
        {(found.data ?? []).map((p) => <Row key={p.id} title={p.display_name} sub={`@${p.handle}`} onPress={() => setWho(p)} />)}
      </>}
    </Card>
  );
};

function CaseSheet({ id, rules, onClose, onChange, onNew }) {
  const { toast } = useSession();
  const d = useLoad(() => (id ? api.get(`/verification/cases/${id}/timeline`) : Promise.resolve(null)), [id]);
  const [slot, setSlot] = useState(null);
  const [val, setVal] = useState({});
  const x = d.data;
  const run = async (fn, msg) => { try { await fn(); toast(msg); d.reload(); onChange(); } catch (e) { toast(e.message); } };
  const open = ['submitted', 'needs_info'].includes(x?.status);
  const view = (docId) => run(async () => {
    const f = await api.get(`/verification/cases/${id}/documents/${docId}`);
    if (!f.data) return toast(f.reference ?? 'No file');
    const url = `data:${f.content_type};base64,${f.data}`;
    if (isWeb) { const w = window.open(); w.document.write(`<iframe src="${url}" style="border:0;width:100%;height:100%"></iframe>`); } else toast('Open this on the web app');
  }, 'Opened (logged)');
  return (
    <Sheet visible={!!id} onClose={onClose} title={x ? `${x.label} · #${x.case_no}` : 'Verification'}>
      {d.loading && !x ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : x ? <>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{stateTag(x.status)}<T size={12} color={c.mute}>{x.subject_name}</T></View>
        <NextStep step={x.next_step} />
        <Timeline stages={x.stages} />
        <T weight="800" size={15}>Documents</T>
        {x.documents.map((doc) => (
          <Card key={doc.kind} color={doc.provided ? c.limeSoft : c.paper} pad={12} style={doc.provided ? null : { borderWidth: 1, borderColor: c.line, borderStyle: 'dashed' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T style={{ flex: 1 }} weight="700" size={14}>{doc.provided ? '✅' : '⬜'} {doc.label}</T>
              <Tag label={doc.requirement === 'required' ? 'Required' : doc.requirement === 'one_of' ? 'One of' : 'Extra'} color={doc.requirement === 'required' ? c.sunSoft : c.violetSoft} />
            </View>
            {doc.items.map((it) => <View key={it.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}><T style={{ flex: 1 }} size={12} color={c.mute}>{it.file_name ?? 'Reference'} · {day(it.created_at)}</T><Btn small title="View" color={c.violet} onPress={() => view(it.id)} /></View>)}
            {open && slot !== doc.kind ? <Btn small title={doc.provided ? 'Add another' : 'Upload'} color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => { setSlot(doc.kind); setVal({}); }} /> : null}
            {open && slot === doc.kind ? <View style={{ marginTop: 8, gap: 6 }}>
              <EvidenceInput kind={doc.kind} label={doc.label} value={val} onChange={setVal} />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn small title="Save" color={c.pink} onPress={() => run(async () => { const ev = await buildEvidence({ [doc.kind]: val }); if (!ev.length) throw new Error('Add a reference or a file'); await api.post(`/verification/cases/${id}/evidence`, { evidence: ev }); setSlot(null); }, 'Document added')} />
                <Btn small title="Cancel" color={c.paper} ink={c.mute} onPress={() => setSlot(null)} />
              </View>
            </View> : null}
          </Card>
        ))}
        {x.shared_with !== null ? <SharePanel caseId={id} documents={x.documents} /> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {['rejected', 'withdrawn', 'revoked', 'expired'].includes(x.status) ? <Btn title={x.status === 'expired' ? 'Renew' : 'Start a new request'} color={c.pink} onPress={onNew} /> : null}
          {x.status === 'needs_info' ? <Btn title="Send back for review" color={c.pink} onPress={() => run(() => api.post(`/verification/cases/${id}/resubmit`), 'Back in the queue')} /> : null}
          {['submitted', 'in_review', 'needs_info'].includes(x.status) ? <Btn title="Withdraw" color={c.paper} ink={c.red} onPress={() => run(() => api.post(`/verification/cases/${id}/withdraw`), 'Withdrawn')} /> : null}
        </View>
      </> : null}
    </Sheet>
  );
}

/** One onboarding card per thing you can get verified (role or brand): mini progress + the next step. */
function OnboardingCard({ o, onOpen }) {
  const started = o.status !== 'not_started', pct = o.docs_total ? o.docs_provided / o.docs_total : 0;
  return (
    <Card color={c.paper} pad={14} onPress={onOpen} style={{ borderWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T style={{ flex: 1 }} weight="800" size={16}>{o.label}</T>{started ? stateTag(o.status) : <Tag label="Not started" color={c.violetSoft} />}
      </View>
      <T size={12} color={c.mute}>{o.subject_type === 'sponsor' ? `${o.subject_name} · ` : ''}{o.next}</T>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.line, marginTop: 8, overflow: 'hidden' }}><View style={{ height: 6, width: `${Math.round(pct * 100)}%`, backgroundColor: c.lime }} /></View>
      <T size={11} color={c.mute}>{o.docs_provided} of {o.docs_total} required documents on file</T>
    </Card>
  );
}

export function VerificationSection() {
  const rules = useLoad(() => api.get('/verification/rules'), []);
  const board = useLoad(() => api.get('/me/onboarding'), []);
  const [req, setReq] = useState(null);
  const [open, setOpen] = useState(null);
  return (
    <Section title="Onboarding & verification" color={c.lime}>
      <T size={13} color={c.mute}>Follow each step from documents to a public verified badge. Your documents are encrypted and only you and the people you share them with can read them.</T>
      {board.loading && !board.data ? <Loading /> : board.error ? <ErrorBox error={board.error} onRetry={board.reload} /> : (
        <View style={{ gap: 10, marginTop: 8 }}>
          {(board.data ?? []).map((o) => <OnboardingCard key={`${o.type}${o.subject_id}`} o={o} onOpen={() => (o.case_id ? setOpen(o.case_id) : setReq(o))} />)}
          {!board.data?.length ? <Empty emoji="🪪" title="Nothing to verify yet" sub="Add a role such as physio, doctor, insurer or sponsor to see your onboarding steps." /> : null}
        </View>
      )}
      <Btn small title="Request a badge" color={c.pink} onPress={() => setReq({})} style={{ alignSelf: 'flex-start', marginVertical: 8 }} disabled={!rules.data} />
      {rules.data ? <>
        <RequestSheet key={`${req?.type}${req?.subject_id}`} visible={!!req} onClose={() => setReq(null)} rules={rules.data} onDone={board.reload} preset={req?.type} presetSubject={req?.subject_type !== 'user' ? req?.subject_id : null} />
        <CaseSheet id={open} rules={rules.data} onClose={() => setOpen(null)} onChange={board.reload} onNew={() => { setReq(board.data?.find((o) => o.case_id === open) ?? {}); setOpen(null); }} />
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
