// Compliance, safeguarding & eligibility (#595): the one place to see and run it, on phone, tablet and desktop.
//   MyCompliance          "Mine": what is required of me (or of a young person I am guardian of), what is missing or expiring, and the next step.
//                         "Manage": the scopes I run (organisation, event, governing body, platform) opened in the workspace below.
//   ComplianceWorkspace   one scope: who is short, the review queue, the rulebook (requirements and who must meet them), waivers and evidence packs.
//                         Embedded as the Compliance tab of the organisation and of the event console, and reached from Manage.
// Nothing is decided here; every control calls the API (REST / MCP share the same capabilities) and the server enforces access, consent and audit.
import React, { createContext, useContext, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Screen, Seg, Sheet, T, Tag, Field } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Pager, SwitchRow } from '../federation-bits';
import { explain } from '../access';
import { c } from '../theme';
import { locale } from '../locale';

const TONE = { met: c.mint, expiring: c.sun, grace: c.sun, pending_review: c.cyan, missing: c.red, expired: c.red, rejected: c.red, revoked: c.red, waived: c.violetSoft };
const DECISION = { clear: ['In order', c.mint], pending: ['Awaiting review', c.cyan], blocked: ['Action needed', c.red] };
const SOURCE_SCREEN = { federation_licence: 'MyLicences', service_credential: 'SupplierWorkspace' };
const VALIDITY = [[null, 'Never expires'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [1095, '3 years'], [1825, '5 years']];
const REMINDERS = [90, 60, 30, 14, 7];
const STOPS = { youth_contact: 'contact with young people', youth_access: 'access to young people\'s records', registration: 'competition registration', accreditation: 'event accreditation', event_open: 'opening the event', event_start: 'starting the event', tender_award: 'awarding a tender' };
const DECISION_TONE = { true: c.red, false: c.mint };
const nice = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const ago = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 864e5); return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`; };
const subjectWord = { person: 'people', organisation: 'organisations', event: 'events' };

// The event console is a dark canvas; the same workspace sits on a light one elsewhere. Text that lives on the canvas (not inside a card) follows it.
const OnDark = createContext(false);
const Head = ({ children, style }) => <T weight="800" size={19} color={useContext(OnDark) ? '#fff' : c.ink} style={style}>{children}</T>;
const Note = ({ children, style }) => <T size={13} color={useContext(OnDark) ? 'rgba(255,255,255,0.72)' : c.mute} style={style}>{children}</T>;
function Block({ title, children }) { return <View style={{ marginTop: 22 }}><Head>{title}</Head><View style={{ gap: 10, marginTop: 10 }}>{children}</View></View>; }

/** Upload picked files (base64) to a record, one by one. Resolves the names that failed with the reason, so a partly saved submission is never lost. */
async function attachFiles(recordId, files = []) {
  const failed = [];
  for (const f of files) {
    try { await api.post(`/compliance/records/${recordId}/files`, { file_name: f.file_name, data: f.data }); }
    catch (e) { failed.push(`${f.file_name}: ${e.message}`); }
  }
  return failed;
}

/** Open an evidence file: a tab on the web, the share / open sheet on a phone or tablet. The sign-in header is needed, so it is fetched as a blob. */
async function openEvidenceFile(recordId, file) {
  const blob = await api.download(`/compliance/records/${recordId}/files/${file.id}`);
  const type = file.type || blob.type || 'application/octet-stream', name = String(file.name ?? 'evidence').replace(/[^\w. -]/g, '_');
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const u = URL.createObjectURL(blob);
    if (/^(application\/pdf|image\/)/.test(type)) window.open(u, '_blank', 'noopener');
    else { const a = document.createElement('a'); a.href = u; a.download = name; a.click(); }
    setTimeout(() => URL.revokeObjectURL(u), 120000);
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const f = new File(Paths.cache, name);
  f.create({ overwrite: true }); f.write(new Uint8Array(await new Response(blob).arrayBuffer()));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open files from here. Open it in the web app.');
  await Sharing.shareAsync(f.uri, { mimeType: type, dialogTitle: name });
}

// ---------------------------------------------------------------- the holder's side

/** One obligation: what it is, who asks, where it stands, why, and the single next step. */
function ItemCard({ it, onAct, onHistory, onAttach }) {
  const step = it.next_step;
  const canAttach = it.record?.can_attach && it.requirement.method === 'evidence' && !it.requirement.sensitive;
  return (
    <Card pad={14} accessibilityLabel={`${it.requirement.name}. ${it.state_label}. ${it.explanation}`}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <T weight="700" size={16}>{it.requirement.name}</T>
            <T size={12} color={c.mute}>{it.requirement.category_label === it.requirement.name ? '' : `${it.requirement.category_label} · `}asked by {it.scope.name ?? 'the platform'}{it.mandatory ? '' : ' · optional'}</T>
          </View>
          <Tag label={it.state_label} color={TONE[it.state] ?? c.violetSoft} />
        </View>
        <T size={14}>{it.explanation}</T>
        {it.record?.file_count ? <T size={12} color={c.mute}>📎 {it.record.file_count} file{it.record.file_count === 1 ? '' : 's'} attached</T> : null}
        {it.consequences.length ? <T size={12} color={c.mute}>If this is not in order it stops: {it.consequences.map((x) => STOPS[x] ?? x).join(', ')}.</T> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {step && step.action !== 'wait' ? <Btn small title={step.label} onPress={() => onAct(it)} accessibilityLabel={`${step.label}: ${it.requirement.name}`} /> : null}
          {canAttach ? <Btn small color={c.paper} ink={c.ink} title="Add files" onPress={() => onAttach(it)} accessibilityLabel={`Add files to ${it.requirement.name}`} /> : null}
          <Btn small color={c.paper} ink={c.ink} title="History" onPress={() => onHistory(it)} accessibilityLabel={`History of ${it.requirement.name}`} />
        </View>
      </View>
    </Card>
  );
}

function History({ subject, onClose }) {
  const h = useLoad(() => (subject ? api.get('/compliance/history', { subject_kind: subject.kind, subject_id: subject.id, limit: 50 }) : Promise.resolve(null)), [subject?.id, subject?.kind]);
  return (
    <Sheet visible={!!subject} onClose={onClose} title="History">
      {h.error ? <ErrorBox error={h.error} onRetry={h.reload} /> : !h.data ? <Loading /> : h.data.items.length ? h.data.items.map((e) => (
        <Row key={e.id} title={`${String(e.action).replace(/_/g, ' ')}${e.requirement ? ` · ${e.requirement}` : ''}`} sub={`${e.actor ?? 'System'} · ${new Date(e.at).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`} />
      )) : <Empty emoji="🗒️" title="Nothing yet" sub="Submissions, decisions and waivers appear here." />}
    </Sheet>
  );
}

/** Submit evidence or make a declaration for one obligation of a subject. */
function SubmitSheet({ item, subject, onClose, onDone }) {
  const { toast } = useSession();
  if (!item) return null;
  const r = item.requirement;
  const declare = r.method === 'declaration';
  const fields = declare
    ? [{ key: 'confirm', label: 'I have read this and agree', type: 'switch' }, ...(r.category === 'conflict_of_interest' ? [{ key: 'detail', label: 'Describe any conflict (leave empty if you have none)', type: 'multiline', optional: true }] : [])]
    : [
      { key: 'reference', label: r.category === 'background_check' ? 'Reference of the check' : 'Certificate, permit or policy reference', type: 'text', hint: r.sensitive ? 'Only you can see this reference. Reviewers see the outcome.' : 'Stored encrypted.' },
      { key: 'provider', label: 'Issued by', type: 'text', optional: true },
      { key: 'issued_on', label: 'Issued on', type: 'date', optional: true },
      { key: 'expires_on', label: 'Expires on', type: 'date', optional: true, hint: r.validity_days ? `Leave empty to use ${r.validity_days} days from the issue date.` : 'Leave empty if it does not expire.' },
      ...(r.sensitive ? [] : [{ key: 'files', label: 'Attach the certificate or document', type: 'files', max: 5, documents: 'wide', optional: true }]),
    ];
  return (
    <FormSheet visible onClose={onClose} title={declare ? r.name : `Submit ${r.name}`} fields={fields} submitLabel={declare ? 'Confirm declaration' : 'Submit for review'}
      notice={declare ? r.statement : undefined}
      onSubmit={async (v) => {
        if (declare && !v.confirm) throw new Error('Confirm that you have read and agree');
        try {
          const { files, ...rest } = v;
          const rec = await api.post('/compliance/records', { requirement_id: item.requirement_id, subject_kind: subject.kind, subject_id: subject.id, ...rest, ...(declare ? { statement_version: r.version } : {}) });
          const failed = declare ? [] : await attachFiles(rec.id, files);
          onDone();
          if (failed.length) return `Submitted, but ${failed.length === 1 ? 'a file' : 'some files'} did not upload (${failed.join('; ')}). Use Add files to try again.`;
          return declare ? 'Declaration recorded' : 'Submitted for review';
        } catch (e) { if (e.status === 409) toast(explain(e)); throw e; }
      }} />
  );
}

/** Add files to a submission that is still waiting for review. */
function AttachSheet({ item, onClose, onDone }) {
  if (!item) return null;
  return (
    <FormSheet visible onClose={onClose} title={`Add files to ${item.requirement.name}`} submitLabel="Upload"
      fields={[{ key: 'files', label: 'Files', type: 'files', max: 5, documents: 'wide' }]}
      onSubmit={async (v) => {
        const failed = await attachFiles(item.record.id, v.files);
        onDone();
        if (failed.length) throw new Error(failed.join('; '));
        return 'Files added';
      }} />
  );
}

function Subject({ subject, title, empty, hideWhenEmpty }) {
  const { push, goTab } = useNav();
  const s = useLoad(() => api.get('/compliance/status', { subject_kind: subject.kind, subject_id: subject.id }), [subject.kind, subject.id]);
  const [open, setOpen] = useState(null), [hist, setHist] = useState(null), [attach, setAttach] = useState(null);
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  if (hideWhenEmpty && !d.items.length) return null;
  const act = (it) => {
    const step = it.next_step;
    if (step?.action === 'open_source') { const target = SOURCE_SCREEN[step.source]; if (target) push(target); else goTab('Me'); return; }
    setOpen(it);
  };
  const groups = [
    ['Needs action', d.items.filter((i) => i.blocking || ['expired'].includes(i.state))],
    ['Awaiting review', d.items.filter((i) => i.state === 'pending_review' && !i.blocking)],
    ['Expiring soon', d.items.filter((i) => ['expiring', 'grace'].includes(i.state))],
    ['In order', d.items.filter((i) => ['met', 'waived'].includes(i.state))],
  ];
  const [label, color] = DECISION[d.decision];
  return (
    <View>
      {title ? <Head>{title}</Head> : null}
      <Card pad={16} color={d.decision === 'clear' ? c.mintSoft : d.decision === 'pending' ? c.cyanSoft : c.pinkSoft} style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 180 }}>
            <T weight="800" size={20}>{d.items.length ? label : 'Nothing is required'}</T>
            <T size={13} color={c.mute}>{d.items.length ? `${d.counts.met} in order · ${d.counts.expiring} expiring · ${d.counts.pending} awaiting review · ${d.counts.blocked} need action${d.counts.waived ? ` · ${d.counts.waived} waived` : ''}` : (empty ?? 'No requirement applies to you right now.')}</T>
          </View>
          {d.items.length ? <Tag label={label} color={color} /> : null}
        </View>
      </Card>
      {groups.map(([name, list]) => (list.length ? (
        <Block key={name} title={`${name} · ${list.length}`}>
          {list.map((it) => <ItemCard key={it.obligation_id} it={it} onAct={act} onHistory={() => setHist(subject)} onAttach={setAttach} />)}
        </Block>
      ) : null))}
      <SubmitSheet item={open} subject={subject} onClose={() => setOpen(null)} onDone={() => { setOpen(null); s.reload(); }} />
      <AttachSheet item={attach} onClose={() => setAttach(null)} onDone={() => { setAttach(null); s.reload(); }} />
      <History subject={hist} onClose={() => setHist(null)} />
    </View>
  );
}

// ---------------------------------------------------------------- evidence packs

function PackView({ id, onClose }) {
  const p = useLoad(() => (id ? api.get(`/compliance/packs/${id}`) : Promise.resolve(null)), [id]);
  return (
    <Sheet visible={!!id} onClose={onClose} title="Evidence pack">
      {p.error ? <ErrorBox error={p.error} onRetry={p.reload} /> : !p.data ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>{p.data.purpose}</T>
          <T size={12} color={c.mute}>{p.data.content.scope.name} · {p.data.content.totals.subjects} {subjectWord[p.data.content.subject_kind]} · {p.data.content.totals.clear} in order · {p.data.content.totals.pending} awaiting review · {p.data.content.totals.blocked} short. SHA-256 {p.data.sha256.slice(0, 16)}… Expires {nice(p.data.expires_at)}.</T>
          {p.data.content.subjects.map((s) => (
            <Card key={s.id} pad={12}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{s.name}</T><Tag label={DECISION[s.decision][0]} color={DECISION[s.decision][1]} /></View>
              {s.items.map((x, i) => <T key={i} size={12} color={c.mute}>{x.requirement} · {x.state}{x.expires_on ? ` · until ${nice(x.expires_on)}` : ''}{x.waived_until ? ` · waived until ${nice(x.waived_until)}` : ''}</T>)}
            </Card>
          ))}
          {p.data.content.truncated ? <T size={12} color={c.mute}>The pack is limited to the first 500 entries.</T> : null}
        </View>
      )}
    </Sheet>
  );
}

function PacksForMe() {
  const l = useLoad(() => api.get('/compliance/packs', { limit: 20 }), []);
  const [open, setOpen] = useState(null);
  const mine = (l.data?.items ?? []).filter((p) => p.mine);
  if (!mine.length) return null;
  return (
    <Block title="Evidence packs for you">
      {mine.map((p) => <Row key={p.id} title={p.scope_name ?? 'Compliance'} sub={`${p.purpose} · ${p.readable ? `until ${nice(p.expires_at)}` : p.revoked_at ? 'revoked' : 'expired'}`} onPress={p.readable ? () => setOpen(p.id) : undefined} right={<Tag label={p.readable ? 'Open' : 'Closed'} color={p.readable ? c.mint : c.violetSoft} />} />)}
      <PackView id={open} onClose={() => setOpen(null)} />
    </Block>
  );
}

// ---------------------------------------------------------------- the manager's side

function useCatalogue() { return useLoad(() => api.get('/compliance/catalogue'), []); }

function ReviewQueue({ scope, cat, reload }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/compliance/records', { scope_kind: scope.kind, ...(scope.id ? { scope_id: scope.id } : {}), status: 'submitted', limit: 50 }), [scope.kind, scope.id]);
  const [pick, setPick] = useState(null), [reason, setReason] = useState(''), [shown, setShown] = useState(null), [busy, setBusy] = useState(false);
  const decide = async (rec, decision, why) => {
    setBusy(true);
    try { await api.post(`/compliance/records/${rec.id}/decision`, { decision, ...(why ? { reason: why } : {}), row_version: rec.row_version }); toast(decision === 'approve' ? 'Approved' : 'Declined'); setPick(null); setReason(''); q.reload(); reload(); }
    catch (e) { toast(explain(e)); q.reload(); } finally { setBusy(false); }
  };
  const view = async (rec) => { try { setShown({ ...(await api.get(`/compliance/records/${rec.id}/reference`)), name: rec.requirement.name }); } catch (e) { toast(explain(e)); } };
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      {q.data.items.length ? q.data.items.map((r) => (
        <Card key={r.id} pad={14}>
          <T weight="700" size={15}>{r.subject.name} · {r.requirement.name}</T>
          <T size={12} color={c.mute}>{r.requirement.category_label} · submitted {ago(r.submitted_at)}{r.issued_on ? ` · issued ${nice(r.issued_on)}` : ''}{r.expires_on ? ` · expires ${nice(r.expires_on)}` : ''}{r.provider ? ` · ${r.provider}` : ''}</T>
          {r.files?.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {r.files.map((f) => <Btn key={f.id} small color={c.paper} ink={c.ink} title={`📎 ${f.name}`} onPress={() => openEvidenceFile(r.id, f).catch((e) => toast(explain(e)))} accessibilityLabel={`Open ${f.name}`} />)}
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            <Btn small title="Approve" onPress={() => decide(r, 'approve')} disabled={busy} accessibilityLabel={`Approve ${r.requirement.name} for ${r.subject.name}`} />
            <Btn small color={c.paper} ink={c.ink} title="Decline" onPress={() => { setReason(''); setPick(r); }} accessibilityLabel={`Decline ${r.requirement.name} for ${r.subject.name}`} />
            {r.has_reference && !r.requirement.sensitive ? <Btn small color={c.paper} ink={c.ink} title="Show reference" onPress={() => view(r)} /> : null}
          </View>
          {r.requirement.sensitive ? <T size={11} color={c.mute} style={{ marginTop: 6 }}>The reference of a background check is only shown to the person it belongs to.</T> : null}
        </Card>
      )) : <Empty emoji="✅" title="Nothing to review" sub="Evidence people submit for this scope's requirements appears here, oldest first." />}
      <Sheet visible={!!pick} onClose={() => setPick(null)} title={pick?.requirement.category === 'background_check' ? 'Not cleared' : 'Decline with a reason'}>
        {pick?.requirement.category === 'background_check' ? <T size={13} color={c.mute}>The person is told the check was not accepted. No reason is recorded or shared for a background check.</T>
          : <Field label="Reason (they see this)" value={reason} onChangeText={setReason} multiline placeholder="What needs to change?" />}
        <Btn title={busy ? 'Working…' : 'Decline'} color={c.red} disabled={busy || (pick?.requirement.category !== 'background_check' && reason.trim().length < 5)} onPress={() => decide(pick, 'reject', reason.trim())} />
      </Sheet>
      <Sheet visible={!!shown} onClose={() => setShown(null)} title={shown?.name ?? 'Reference'}>
        <T weight="700" size={17}>{shown?.reference}</T>
        {shown?.detail ? <T size={14}>{shown.detail}</T> : null}
        <T size={12} color={c.mute}>Viewing a reference is recorded in the audit log.</T>
      </Sheet>
    </View>
  );
}

function Overview({ scope, subjectKind, reload }) {
  const { toast } = useSession();
  const [offset, setOffset] = useState(0), [open, setOpen] = useState(null), [waive, setWaive] = useState(null);
  const g = useLoad(() => api.get('/compliance/gaps', { scope_kind: scope.kind, ...(scope.id ? { scope_id: scope.id } : {}), subject_kind: subjectKind, limit: 25, offset }), [scope.kind, scope.id, subjectKind, offset]);
  if (g.error) return <ErrorBox error={g.error} onRetry={g.reload} />;
  if (!g.data) return <Loading />;
  const S = g.data.summary;
  return (
    <View style={{ gap: 10 }}>
      <Card pad={14} color={S.blocked ? c.pinkSoft : S.pending ? c.cyanSoft : c.mintSoft}>
        <T weight="800" size={18}>{S.blocked ? `${S.blocked} short on a requirement` : S.pending ? `${S.pending} waiting for a review` : g.data.subjects.length ? 'Everyone shown is in order' : 'Nothing to chase'}</T>
        <T size={13} color={c.mute}>{S.pending} awaiting review · {S.expiring} with something expiring{g.data.total > g.data.limit ? ` · showing ${g.data.offset + 1}–${Math.min(g.data.total, g.data.offset + g.data.limit)} of ${g.data.total} ${subjectWord[subjectKind]}` : ''}</T>
      </Card>
      {g.data.subjects.length ? g.data.subjects.map((s) => (
        <Row key={s.subject.id} title={s.subject.name ?? 'Unknown'} sub={s.items.slice(0, 2).map((i) => `${i.name}: ${i.state_label.toLowerCase()}`).join(' · ') + (s.items.length > 2 ? ` · +${s.items.length - 2} more` : '')}
          right={<Tag label={DECISION[s.decision][0]} color={DECISION[s.decision][1]} />} onPress={() => setOpen(s)} />
      )) : <Empty emoji="🛡️" title="No gaps found" sub="Define requirements under Rulebook and say who must meet them. People who are short, or about to be, appear here." />}
      <Pager total={g.data.total} offset={g.data.offset} limit={g.data.limit} onOffset={setOffset} busy={g.loading} />
      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open?.subject.name ?? ''}>
        {open?.items.map((i) => (
          <Card key={i.requirement_id} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{i.name}</T><Tag label={i.state_label} color={TONE[i.state] ?? c.violetSoft} /></View>
            <T size={13}>{i.explanation}</T>
            {i.blocking ? <View style={{ marginTop: 8 }}>{i.waivable ? <Btn small color={c.paper} ink={c.ink} title="Grant a waiver" onPress={() => setWaive({ requirement_id: i.requirement_id, name: i.name, subject: { ...open.subject } })} /> : <T size={12} color={c.mute}>This protects young people and cannot be waived.</T>}</View> : null}
          </Card>
        ))}
      </Sheet>
      {waive ? (
        <FormSheet visible onClose={() => setWaive(null)} title={`Waive ${waive.name}`} submitLabel="Grant waiver" notice="A waiver is documented, lasts at most 180 days and never changes the record. Safeguarding that protects young people and background checks cannot be waived."
          fields={[{ key: 'reason', label: 'Why', type: 'multiline' }, { key: 'effective_to', label: 'Until', type: 'date' }]}
          onSubmit={async (v) => { try { await api.post('/compliance/waivers', { requirement_id: waive.requirement_id, subject_kind: subjectKind, subject_id: waive.subject.id, ...v }); g.reload(); reload(); return 'Waiver granted'; } catch (e) { toast(explain(e)); throw e; } }} />
      ) : null}
    </View>
  );
}

/** The requirement form: what is needed, how it is satisfied, validity and reminders. Every choice is a control; only the name and the wording are typed. */
function RequirementForm({ scope, cat, edit, onClose, onSaved }) {
  const verifTypes = cat.sources.verification_types, creds = cat.sources.credential_kinds;
  const lab = (s) => s.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
  const initial = edit ? { ...edit, source_kind: edit.source?.kind, verification_type: edit.source?.type, credential_kind: edit.source?.credential_kind, validity_days: edit.validity_days ?? null } : { subject_kind: 'person', method: 'evidence', category: 'qualification', validity_days: 365, reminder_days: [60, 30, 7], grace_days: 0, escalate_after_days: 7, requires_review: true, source_kind: 'verification' };
  const fields = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'category', label: 'What kind of requirement', type: 'chips', options: cat.categories.map((x) => ({ value: x.value, label: x.label })) },
    { key: 'subject_kind', label: 'Who it is about', type: 'choice', options: cat.subjects.map((x) => ({ value: x.value, label: x.label })) },
    { key: 'method', label: 'How it is satisfied', type: 'chips', options: cat.methods.map((x) => ({ value: x.value, label: x.label })) },
    { key: 'source_kind', label: 'Checked from', type: 'chips', options: cat.sources.kinds.filter((k) => k.value !== 'federation_licence' || scope.kind === 'body').map((x) => ({ value: x.value, label: x.label })), show: (v) => v.method === 'linked' },
    { key: 'verification_type', label: 'Which verification', type: 'chips', options: verifTypes.map((v) => ({ value: v, label: lab(v) })), show: (v) => v.method === 'linked' && v.source_kind === 'verification' },
    { key: 'credential_kind', label: 'Which credential', type: 'chips', options: creds.map((v) => ({ value: v, label: lab(v) })), show: (v) => v.method === 'linked' && v.source_kind === 'service_credential' },
    { key: 'statement', label: 'The statement people read and agree to', type: 'multiline', show: (v) => v.method === 'declaration', hint: 'Changing the wording starts a new version; people who agreed to the old one keep that record.' },
    { key: 'classification', label: 'What kind of rule it is', type: 'chips', options: (cat.classifications ?? []).filter((x) => x.scopes.includes(scope.kind)).map((x) => ({ value: x.value, label: x.label })), hint: 'Laws and regulations take effect only after a second platform administrator approves them, and are never waived. A recommended standard advises and never blocks.' },
    { key: 'topic', label: 'Topic (rules on one topic compete; the higher kind of rule and the narrower place win)', type: 'text', optional: true },
    { key: 'source_title', label: 'Where it comes from (law, regulation or rulebook)', type: 'text', optional: true },
    { key: 'source_url', label: 'Link to the source', type: 'text', optional: true },
    { key: 'approval_owner', label: 'Who owns its approval', type: 'text', optional: true },
    { key: 'requires_review', label: 'A reviewer must approve the evidence', type: 'switch', show: (v) => v.method === 'evidence' && v.category !== 'background_check' },
    { key: 'validity_days', label: 'Valid for', type: 'chips', options: VALIDITY.map(([value, label]) => ({ value, label })), show: (v) => v.method !== 'linked', optional: true },
    { key: 'reminder_days', label: 'Remind before it runs out (days)', type: 'multi', options: REMINDERS.map((d) => ({ value: d, label: `${d}` })), optional: true },
    { key: 'grace_days', label: 'Grace period after expiry', type: 'stepper', min: 0, max: 180, suffix: ' days' },
    { key: 'escalate_after_days', label: 'Tell the managers after it has stayed expired for', type: 'stepper', min: 0, max: 180, suffix: ' days' },
  ];
  return (
    <FormSheet visible onClose={onClose} title={edit ? 'Change requirement' : 'New requirement'} fields={fields} initial={initial} submitLabel="Save requirement"
      onSubmit={async (v) => {
        const linked = v.method === 'linked';
        const source = linked ? (v.source_kind === 'verification' ? { kind: 'verification', type: v.verification_type } : v.source_kind === 'service_credential' ? { kind: 'service_credential', credential_kind: v.credential_kind } : { kind: 'federation_licence', body_id: scope.id }) : undefined;
        await api.post('/compliance/requirements', {
          ...(edit ? { requirement_id: edit.id } : {}), scope_kind: scope.kind, ...(scope.id ? { scope_id: scope.id } : {}), name: v.name, category: v.category, subject_kind: v.subject_kind, method: v.method, source,
          requires_review: v.requires_review ?? true, validity_days: linked ? null : (v.validity_days ?? null), reminder_days: v.reminder_days?.length ? v.reminder_days : [30], grace_days: v.grace_days, escalate_after_days: v.escalate_after_days, ...(v.method === 'declaration' ? { statement: v.statement } : {}),
          ...(v.classification ? { classification: v.classification } : {}), topic: v.topic || null, source_title: v.source_title || null, source_url: v.source_url || null, approval_owner: v.approval_owner || null,
        });
        onSaved();
        return 'Saved';
      }} />
  );
}

function ObligationForm({ req, scope, cat, edit, onClose, onSaved }) {
  const sports = useLoad(() => api.get('/sports'), []);
  const roles = req.subject_kind === 'person' ? cat.roles.person[scope.kind] : cat.roles[req.subject_kind];
  const person = req.subject_kind === 'person';
  const sportId = (slug) => sports.data?.find((s) => s.slug === slug)?.id ?? null;
  const fields = [
    { key: 'roles', label: person ? 'Roles it applies to (none = everyone in this scope)' : 'Kinds it applies to (none = all)', type: 'multi', options: roles.map((r) => ({ value: r.value, label: r.label })), optional: true },
    { key: 'sport', label: 'Only for one sport', type: 'sport', optional: true },
    { key: 'youth_work', label: 'Only for adults who coach or manage young people', type: 'switch', show: () => person },
    { key: 'mandatory', label: 'Mandatory', type: 'switch' },
    { key: 'consequences', label: 'If it is not in order, stop', type: 'multi', options: cat.consequences.filter((x) => !(scope.kind === 'event' && x.value === 'youth_contact')).filter((x) => (['event_open', 'event_start'].includes(x.value) ? req.subject_kind === 'event' : ['youth_contact', 'youth_access', 'registration', 'accreditation'].includes(x.value) ? person : true)).map((x) => ({ value: x.value, label: x.label })), optional: true },
    { key: 'country', label: 'Only in one country', type: 'choice', optional: true, options: (cat.jurisdictions ?? []).map((j) => ({ value: j.code, label: j.name })), hint: 'A place the platform does not know yet is “cannot be judged yet”, never silently “does not apply”.' },
    { key: 'region', label: 'Only in one state or province', type: 'text', optional: true, show: (v) => !!v.country },
    { key: 'municipality', label: 'Only in one city or municipality', type: 'text', optional: true, show: (v) => !!v.country },
    { key: 'event_types', label: 'Only for these kinds of event', type: 'multi', options: (cat.event_types ?? []).map((x) => ({ value: x, label: x.replace(/^./, (ch) => ch.toUpperCase()) })), optional: true },
    { key: 'age_band', label: 'Only for an age band', type: 'switch', show: () => person },
    { key: 'min_age', label: 'From age', type: 'stepper', min: 0, max: 120, default: 18, show: (v) => person && v.age_band },
    { key: 'max_age', label: 'Up to age', type: 'stepper', min: 0, max: 120, default: 120, show: (v) => person && v.age_band },
    { key: 'starts_on', label: 'Applies from', type: 'date', optional: true },
    { key: 'ends_on', label: 'Applies until', type: 'date', optional: true },
  ];
  return (
    <FormSheet visible onClose={onClose} title={`Who must meet “${req.name}”`} fields={fields} submitLabel="Save"
      initial={edit ? { ...edit, country: edit.country ?? '', age_band: edit.min_age != null || edit.max_age != null } : { mandatory: true, roles: [], consequences: [], youth_work: false }}
      onSubmit={async (v) => {
        await api.post(`/compliance/requirements/${req.id}/obligations`, { ...(edit ? { obligation_id: edit.id } : {}), roles: v.roles ?? [], sport_id: v.sport ? sportId(v.sport) : null, youth_work: !!v.youth_work, mandatory: !!v.mandatory, consequences: v.consequences ?? [], country: v.country || null, region: v.country ? (v.region || null) : null, municipality: v.country ? (v.municipality || null) : null, event_types: v.event_types ?? [], min_age: v.age_band ? v.min_age : null, max_age: v.age_band ? v.max_age : null, body_ids: edit?.body_ids ?? [], competition_ids: edit?.competition_ids ?? [], venue_ids: edit?.venue_ids ?? [], ...(v.starts_on ? { starts_on: v.starts_on } : {}), ends_on: v.ends_on ?? null });
        onSaved();
        return 'Saved';
      }} />
  );
}

function Rulebook({ scope, cat, reload }) {
  const { toast } = useSession();
  const l = useLoad(() => api.get('/compliance/requirements', { scope_kind: scope.kind, ...(scope.id ? { scope_id: scope.id } : {}) }), [scope.kind, scope.id]);
  const [form, setForm] = useState(null), [ob, setOb] = useState(null);
  const after = () => { l.reload(); reload(); };
  const archive = async (r) => { try { await api.post(`/compliance/requirements/${r.id}/archive`); toast('Archived. Records are kept.'); after(); } catch (e) { toast(explain(e)); } };
  const approve = async (r, decision) => { try { await api.post(`/compliance/requirements/${r.id}/approval`, { decision }); toast(decision === 'approve' ? 'Approved. It takes effect now.' : 'Withdrawn'); after(); } catch (e) { toast(explain(e)); } };
  const dropOb = async (r, o) => { try { await api.post(`/compliance/requirements/${r.id}/obligations`, { obligation_id: o.id, roles: o.roles, sport_id: o.sport_id, youth_work: o.youth_work, mandatory: o.mandatory, consequences: o.consequences, archived: true }); after(); } catch (e) { toast(explain(e)); } };
  if (l.error) return <ErrorBox error={l.error} onRetry={l.reload} />;
  if (!l.data) return <Loading />;
  const write = cat.scopes.find((s) => s.kind === scope.kind && (s.id ?? null) === (scope.id ?? null))?.write !== false;
  return (
    <View style={{ gap: 10 }}>
      {write ? <Btn title="+ New requirement" onPress={() => setForm({})} /> : <Note>You can read this rulebook but not change it.</Note>}
      {l.data.requirements.length ? l.data.requirements.map((r) => (
        <Card key={r.id} pad={14}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="700" size={16}>{r.name}</T>
              <T size={12} color={c.mute}>{r.category_label} · for {subjectWord[r.subject_kind]} · {({ evidence: 'evidence a reviewer approves', declaration: 'a declaration', linked: 'checked from an existing record' })[r.method]}{r.validity_days ? ` · valid ${r.validity_days >= 365 ? `${Math.round(r.validity_days / 365 * 10) / 10} yr` : `${r.validity_days} days`}` : ''} · v{r.version}</T>
            </View>
            <Tag label={`${r.counts.valid} valid`} color={c.mint} />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
            <Tag label={r.classification_label} color={['legal_mandatory', 'regulatory'].includes(r.classification) ? c.red : r.classification === 'recommended_standard' ? c.cyan : c.violetSoft} />
            {r.topic ? <Tag label={`Topic: ${r.topic}`} /> : null}
            {r.approval_status === 'pending_approval' ? <Tag label="Waiting for a second administrator" color={c.sun} /> : null}
            {r.source_title ? <T size={12} color={c.mute}>{r.source_title}</T> : null}
            {r.approval_status === 'pending_approval' && scope.kind === 'platform' && write ? <><Chip label="Approve" onPress={() => approve(r, 'approve')} /><Chip label="Withdraw" onPress={() => approve(r, 'withdraw')} /></> : null}
          </View>
          {r.counts.awaiting || r.counts.expiring ? <T size={12} color={c.mute}>{r.counts.awaiting} awaiting review · {r.counts.expiring} expiring within 30 days</T> : null}
          <View style={{ gap: 6, marginTop: 8 }}>
            {r.obligations.length ? r.obligations.map((o) => (
              <View key={o.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <T size={13} style={{ flex: 1, minWidth: 160 }}>{o.role_labels.length ? o.role_labels.join(', ') : 'Everyone in this scope'}{o.sport_name ? ` · ${o.sport_name}` : ''}{[o.municipality, o.region, o.country].filter(Boolean).length ? ` · in ${[o.municipality, o.region, o.country].filter(Boolean).join(', ')}` : ''}{o.event_types?.length ? ` · ${o.event_types.join('/')} events` : ''}{o.min_age != null || o.max_age != null ? ` · ages ${o.min_age ?? 0}–${o.max_age ?? '∞'}` : ''}{o.starts_on && String(o.starts_on).slice(0, 10) > new Date().toISOString().slice(0, 10) ? ` · from ${nice(o.starts_on)}` : ''}{o.youth_work ? ' · works with young people' : ''}{o.mandatory ? '' : ' · optional'}{o.consequences.length ? ` · blocks ${o.consequences.map((x) => STOPS[x] ?? x).join(', ')}` : ''}</T>
                {write ? <><Chip label="Edit" onPress={() => setOb({ req: r, edit: { ...o, sport: undefined } })} /><Chip label="Remove" onPress={() => dropOb(r, o)} /></> : null}
              </View>
            )) : <T size={13} color={c.red}>Nobody has to meet this yet. Say who must.</T>}
          </View>
          {write ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <Btn small title="+ Who must meet it" onPress={() => setOb({ req: r })} />
              <Btn small color={c.paper} ink={c.ink} title="Change" onPress={() => setForm(r)} />
              <Btn small color={c.paper} ink={c.ink} title="Archive" onPress={() => archive(r)} />
            </View>
          ) : null}
        </Card>
      )) : <Empty emoji="📋" title="No requirements yet" sub="A requirement is what is needed (a certificate, a check, a declaration, a permit …). Then choose who must meet it and what an unmet one blocks." />}
      {form ? <RequirementForm scope={scope} cat={cat} edit={form.id ? form : null} onClose={() => setForm(null)} onSaved={after} /> : null}
      {ob ? <ObligationForm req={ob.req} scope={scope} cat={cat} edit={ob.edit} onClose={() => setOb(null)} onSaved={after} /> : null}
    </View>
  );
}

function Packs({ scope, subjectKind }) {
  const { toast } = useSession();
  const l = useLoad(() => api.get('/compliance/packs', { limit: 30 }), []);
  const [make, setMake] = useState(false), [open, setOpen] = useState(null);
  const mine = (l.data?.items ?? []).filter((p) => !p.mine && p.scope_kind === scope.kind && (p.scope_id ?? null) === (scope.id ?? null));
  const revoke = async (p) => { try { await api.post(`/compliance/packs/${p.id}/revoke`); toast('Revoked'); l.reload(); } catch (e) { toast(explain(e)); } };
  return (
    <View style={{ gap: 10 }}>
      <Note>An evidence pack is a frozen summary for an auditor or federation reviewer: states and dates only, never references or notes. You choose who may read it and for how long.</Note>
      <Btn title="+ Create an evidence pack" onPress={() => setMake(true)} />
      {mine.map((p) => <Row key={p.id} title={`For ${p.recipient_name}`} sub={`${p.purpose} · ${p.revoked_at ? 'revoked' : `until ${nice(p.expires_at)}`}`} onPress={() => setOpen(p.id)} right={!p.revoked_at ? <Btn small color={c.paper} ink={c.ink} title="Revoke" onPress={() => revoke(p)} /> : <Tag label="Revoked" />} />)}
      {make ? (
        <FormSheet visible onClose={() => setMake(false)} title="Evidence pack" submitLabel="Create pack"
          fields={[{ key: 'purpose', label: 'Purpose (the reviewer sees this)', type: 'text' }, { key: 'recipient_id', label: 'Who may read it', type: 'entity', entityKind: 'person', noun: 'reviewer' }, { key: 'expires_in_days', label: 'Available for', type: 'stepper', min: 1, max: 30, default: 7, suffix: ' days' }]}
          onSubmit={async (v) => { await api.post('/compliance/packs', { scope_kind: scope.kind, ...(scope.id ? { scope_id: scope.id } : {}), subject_kind: subjectKind, ...v }); l.reload(); return 'Pack created'; }} />
      ) : null}
      <PackView id={open} onClose={() => setOpen(null)} />
    </View>
  );
}

/**
 * One scope's compliance. `own` (organisation or event) adds the scope's own requirements at the top (its permits, insurance, declarations).
 */
export function ComplianceWorkspace({ scope, own = null, initial = 'overview', onDark = false }) {
  const cat = useCatalogue();
  const [tab, setTab] = useState(initial), [kind, setKind] = useState('person'), [tick, setTick] = useState(0);
  if (cat.error) return <ErrorBox error={cat.error} onRetry={cat.reload} />;
  if (!cat.data) return <Loading />;
  const reload = () => setTick((t) => t + 1);
  const tabs = [['overview', 'Who is short'], ['review', 'Review queue'], ['rules', 'Rulebook'], ['waivers', 'Waivers'], ['decisions', 'Decisions'], ['packs', 'Evidence packs']];
  return (
    <OnDark.Provider value={onDark}>
    <View key={`${scope.kind}:${scope.id}:${tick}`} style={{ gap: 12, marginTop: 4 }}>
      {own ? <View style={{ marginTop: 8 }}><Subject subject={own.subject} title={own.title} hideWhenEmpty /></View> : null}
      <Seg options={tabs.map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.violet} />
      {['overview', 'packs'].includes(tab) ? (
        <Seg options={cat.data.subjects.map((x) => ({ value: x.value, label: x.label }))} value={kind} onChange={setKind} color={c.cyan} />
      ) : null}
      {tab === 'overview' ? <Overview scope={scope} subjectKind={kind} reload={reload} />
        : tab === 'review' ? <ReviewQueue scope={scope} cat={cat.data} reload={reload} />
        : tab === 'rules' ? <Rulebook scope={scope} cat={cat.data} reload={reload} />
        : tab === 'waivers' ? <Waivers scope={scope} />
        : tab === 'decisions' ? <Decisions scope={scope} />
        : <Packs scope={scope} subjectKind={kind} />}
    </View>
    </OnDark.Provider>
  );
}

/** The kept decisions of an event or organisation, and a check of the rules in force on any date (nothing is saved unless you ask). */
function Decisions({ scope }) {
  const { toast } = useSession();
  const subject = scope.kind === 'event' || scope.kind === 'organisation' ? { kind: scope.kind, id: scope.id } : null;
  const l = useLoad(() => (scope.kind === 'event' ? api.get('/compliance/decisions', { event_id: scope.id, limit: 30 }) : subject ? api.get('/compliance/decisions', { subject_kind: subject.kind, subject_id: subject.id, limit: 30 }) : Promise.resolve({ items: [] })), [scope.kind, scope.id]);
  const [check, setCheck] = useState(false), [res, setRes] = useState(null), [open, setOpen] = useState(null);
  if (l.error) return <ErrorBox error={l.error} onRetry={l.reload} />;
  if (!l.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      <Note>Every time a rule stopped or allowed opening an event, starting it or awarding a tender, the decision is kept with the facts, the rules (and their versions) and who decided. It cannot be edited or deleted.</Note>
      {subject ? <Btn title="Check the rules on a date" onPress={() => setCheck(true)} accessibilityLabel="Check the rules in force on a date" /> : <Note>Open an organisation or an event to check its rules on a date.</Note>}
      {res ? (
        <Card pad={14}>
          <T weight="800" size={16}>{DECISION[res.decision][0]} on {nice(res.as_of)}</T>
          {res.explanation?.text ? <Note style={{ marginTop: 6 }}>{res.explanation.text}</Note> : null}
          {res.items.map((it) => <Row key={it.requirement_id} title={it.requirement.name} sub={`${it.state_label} · ${it.explanation}`} right={<Tag label={it.policy.classification.replace(/_/g, ' ')} />} />)}
          {res.excluded?.map((x) => <Note key={x.requirement.id ?? x.requirement.name} style={{ marginTop: 4 }}>{x.requirement.name}: {x.reason}</Note>)}
        </Card>
      ) : null}
      {l.data.items.length ? l.data.items.map((d) => (
        <Row key={d.id} title={`${STOPS[d.consequence] ?? d.consequence} · ${d.blocked ? 'refused' : 'allowed'}`} sub={`${nice(d.decided_at)} · as of ${nice(d.as_of)} · ${d.blockers ?? 0} of ${d.rules ?? 0} rules in the way${d.decided_by ? ` · ${d.decided_by}` : ''}`}
          right={<Tag label={d.blocked ? 'Refused' : 'Allowed'} color={DECISION_TONE[d.blocked]} />} onPress={() => setOpen(d.id)} />
      )) : <Empty emoji="🧭" title="No decisions kept yet" sub="Refused openings, starts and awards appear here. You can also keep a check." />}
      {check ? (
        <FormSheet visible onClose={() => setCheck(false)} title="Rules in force on a date" submitLabel="Check"
          fields={[{ key: 'as_of', label: 'On this date', type: 'date', optional: true }, { key: 'record', label: 'Keep this check in the decision trail', type: 'switch' }]} initial={{ record: false }}
          onSubmit={async (v) => { try { setRes(await api.post('/compliance/evaluate', { subject_kind: subject.kind, subject_id: subject.id, ...(scope.kind === 'event' ? { event_id: scope.id } : {}), ...(v.as_of ? { as_of: v.as_of } : {}), record: !!v.record })); l.reload(); } catch (e) { toast(explain(e)); throw e; } return 'Checked'; }} />
      ) : null}
      <DecisionView id={open} onClose={() => setOpen(null)} />
    </View>
  );
}

function DecisionView({ id, onClose }) {
  const l = useLoad(() => (id ? api.get(`/compliance/decisions/${id}`) : Promise.resolve(null)), [id]);
  if (!id) return null;
  const d = l.data;
  return (
    <Sheet visible onClose={onClose} title="Decision">
      {l.error ? <ErrorBox error={l.error} onRetry={l.reload} /> : !d ? <Loading /> : (
        <View style={{ gap: 8 }}>
          <T weight="700">{STOPS[d.consequence] ?? d.consequence} · {d.blocked ? 'refused' : 'allowed'} · as of {nice(d.as_of)}</T>
          {Object.entries(d.facts?.values ?? {}).map(([k, v]) => <Note key={k}>{k.replace(/_/g, ' ')}: {String(v)} ({d.facts.sources?.[k] ?? 'on record'})</Note>)}
          {(d.results?.items ?? []).map((it, i) => <Row key={i} title={`${it.name} v${it.version}`} sub={`${(it.classification ?? '').replace(/_/g, ' ')} · ${it.state}${it.blocking ? ' · in the way' : ''}`} />)}
        </View>
      )}
    </Sheet>
  );
}

function Waivers({ scope }) {
  const { toast } = useSession();
  const [ended, setEnded] = useState(false);
  const l = useLoad(() => api.get('/compliance/waivers', { scope_kind: scope.kind, ...(scope.id ? { scope_id: scope.id } : {}), include_ended: ended, limit: 50 }), [scope.kind, scope.id, ended]);
  const revoke = async (w) => { try { await api.post(`/compliance/waivers/${w.id}/revoke`); toast('Waiver ended'); l.reload(); } catch (e) { toast(explain(e)); } };
  if (l.error) return <ErrorBox error={l.error} onRetry={l.reload} />;
  if (!l.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      <Note>Waivers are granted from “Who is short”, against one person and one requirement. They last at most 180 days and never change the record.</Note>
      <Card pad={8}><SwitchRow label="Show ended waivers" value={ended} onChange={setEnded} /></Card>
      {l.data.items.length ? l.data.items.map((w) => (
        <Row key={w.id} title={`${w.subject.name} · ${w.requirement_name}`} sub={`${w.reason} · until ${nice(w.effective_to)} · by ${w.granted_by_name}`}
          right={w.revoked_at ? <Tag label="Ended" /> : <Btn small color={c.paper} ink={c.ink} title="End" onPress={() => revoke(w)} accessibilityLabel={`End waiver for ${w.subject.name}`} />} />
      )) : <Empty emoji="🧾" title="No waivers" sub="Exceptions you grant appear here with who granted them and why." />}
    </View>
  );
}

// ---------------------------------------------------------------- the page

/** Compliance: what is required of me, and (when I run something) the scopes I manage. A guardian opens a young person's with subjectId. */
export function MyCompliance({ subjectId, subjectName }) {
  const { user } = useSession();
  const cat = useCatalogue();
  const [view, setView] = useState('mine'), [scopeKey, setScopeKey] = useState(null);
  const subject = { kind: 'person', id: subjectId ?? user?.id };
  const scopes = cat.data?.scopes ?? [];
  const manage = !subjectId && scopes.length > 0;
  const chosen = scopes.find((s) => `${s.kind}:${s.id ?? ''}` === scopeKey) ?? scopes[0];
  return (
    <Screen wide>
      <Head>{subjectName ? `${subjectName}: compliance` : 'Compliance & safeguarding'}</Head>
      <Note style={{ marginTop: 4 }}>What is required, what is missing or about to expire, and exactly what to do next.</Note>
      {manage ? <View style={{ marginTop: 12 }}><Seg options={[{ value: 'mine', label: 'Mine' }, { value: 'manage', label: 'Manage' }]} value={view} onChange={setView} color={c.pink} /></View> : null}
      {view === 'manage' && manage ? (
        <View style={{ marginTop: 12, gap: 12 }}>
          <MenuField label="Scope" value={`${chosen.kind}:${chosen.id ?? ''}`} onChange={setScopeKey} options={scopes.map((s) => ({ value: `${s.kind}:${s.id ?? ''}`, label: s.name, sub: s.kind === 'body' ? 'Governing body' : s.kind[0].toUpperCase() + s.kind.slice(1) }))} />
          <ComplianceWorkspace key={`${chosen.kind}:${chosen.id}`} scope={{ kind: chosen.kind, id: chosen.id }} />
        </View>
      ) : (
        <View style={{ marginTop: 12 }}>
          <Subject subject={subject} />
          {!subjectId ? <PacksForMe /> : null}
        </View>
      )}
    </Screen>
  );
}
