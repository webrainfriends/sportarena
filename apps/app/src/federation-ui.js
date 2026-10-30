// Federation & Governing Body OS (#475): the pieces every federation screen shares, so the workspace, the club, the licence holder and the organiser all
// read the same way: status vocabulary and tones, requirement checks, the decision history, the evidence list, the body picker and the decision sheet.
// The server is the authority on every rule; this only shows what it returns and hides what a role cannot use.
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from './api';
import { Btn, Card, Chip, Empty, Field, Loading, Sheet, T, Tag } from './ui';
import { FormSheet } from './FormSheet';
import { DateField } from './pickers';
import { MenuField } from './menu-field';
import { openBase64, pickEvidence } from './evidence';
import { openPdf } from './open-file';
import { useSession } from './session';
import { explain } from './access';
import { c } from './theme';

export const LEVEL_LABEL = { international: 'International', continental: 'Continental', national: 'National', regional: 'Regional', state: 'State', district: 'District', league: 'League' };
export const ROLE_LABEL = { registrar: 'Registrar', licensing: 'Licensing officer', sanctioner: 'Sanctioning officer', secretary: 'Secretary', compliance: 'Compliance', auditor: 'Auditor', integrity: 'Integrity officer' };
export const ROLE_HELP = {
  registrar: 'Reviews and decides club affiliations', licensing: 'Reviews and decides licences', sanctioner: 'Reviews and decides competition sanctions',
  secretary: 'Publishes policies and sets the federation calendar', compliance: 'Reads evidence and reviews compliance exceptions; decides no applications', auditor: 'Reads reports and exports; decides nothing', integrity: 'Runs sport integrity and anti-doping administration: cases, references, decisions and education',
};
export const HOLDER_ROLES = [{ value: 'athlete', label: 'Athlete' }, { value: 'coach', label: 'Coach' }, { value: 'official', label: 'Official' }, { value: 'administrator', label: 'Administrator' }, { value: 'other', label: 'Other' }];
export const POLICY_LABEL = {
  affiliation: 'Club affiliation requirements', licence: 'Licence requirements', sanction: 'Sanctioning conditions', eligibility: 'Participant eligibility', roster: 'Roster limits', competition_entry: 'Competition entry',
  official_grade: 'Official grades', registration: 'Player registration', transfer: 'Transfer windows', discipline: 'Disciplinary accumulation', para_classification: 'Para-classification',
};
const STATUS = {
  draft: ['Draft', c.violetSoft], submitted: ['Submitted', c.sun], requested: ['Requested', c.sun], under_review: ['In review', c.cyan], needs_info: ['Needs information', c.orange],
  approved: ['Approved', c.mint], active: ['Active', c.mint], in_force: ['In force', c.mint], good_standing: ['Good standing', c.mint], recognised: ['Recognised', c.mint],
  suspended: ['Suspended', c.orange], rejected: ['Not approved', c.pinkSoft], revoked: ['Revoked', c.pinkSoft], expired: ['Expired', c.pinkSoft], withdrawn: ['Withdrawn', c.violetSoft],
  declined: ['Declined', c.violetSoft], ended: ['Ended', c.violetSoft], archived: ['Archived', c.violetSoft], cancelled: ['Cancelled', c.violetSoft], due: ['Due', c.sun], pending: ['Pending', c.sun],
};
export const statusLabel = (s) => STATUS[s]?.[0] ?? String(s).replace(/_/g, ' ');
export const StatusTag = ({ status, label }) => <Tag label={label ?? statusLabel(status)} color={STATUS[status]?.[1] ?? c.violetSoft} />;

export const fmtDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fmtRange = (a, b) => (a && b && a !== b ? `${fmtDate(a)} to ${fmtDate(b)}` : fmtDate(a ?? b));
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const addDaysIso = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const money = (minor, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(minor / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${minor} ${cur ?? ''}`; } };
export const jurisdiction = (b) => [b.district, b.state, b.region, b.country].filter(Boolean).join(', ');
export const ago = (iso) => { const d = Math.round((Date.now() - new Date(iso).getTime()) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
/** The error body of a refused decision carries the failed checks; show them, not just the sentence. */
/** The machine code of a refused call (e.g. approval_required), and its details. */
export const codeOf = (e) => e?.details?.code ?? e?.body?.error?.details?.code ?? null;
export const detailsOf = (e) => e?.details ?? e?.body?.error?.details ?? {};
/** An approved, unused approval this person asked for, for exactly this action and record (so a second try just uses it). */
export async function usableApproval(bodyId, action, subjectId) {
  const rows = await api.get(`/federation/bodies/${bodyId}/approvals`, { mine: true, state: 'approved', limit: 50 });
  return rows.find((a) => a.action === action && a.subject_id === subjectId && !a.used) ?? null;
}
/** Where a four-eyes rule stops an action: say why, take a summary for the second person, and send the request. */
export function ApprovalAskSheet({ visible, onClose, bodyId, action, label, request }) {
  const { toast } = useSession();
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet visible={visible} onClose={onClose} title="A second person must approve">
      <View style={{ gap: 12 }}>
        <T size={13} color={c.mute}>{label ?? 'This action'} is set to need two people. Tell the approver what you checked; once they approve, repeat the action and it goes through. The approval covers exactly what you asked and can be used once.</T>
        <Field label="What the approver should know" value={summary} onChangeText={setSummary} multiline maxLength={500} />
        <Btn title="Ask for approval" loading={busy} disabled={summary.trim().length < 5} onPress={async () => {
          setBusy(true);
          try { await api.post(`/federation/bodies/${bodyId}/approvals`, { action, summary: summary.trim(), ...request }); toast('Sent for approval'); setSummary(''); onClose(); } catch (e) { toast(explain(e)); } finally { setBusy(false); }
        }} />
      </View>
    </Sheet>
  );
}
export const checksOf = (e) => e?.details?.checks ?? e?.body?.error?.details?.checks ?? null;

/** A persistent notice. Role "alert" so assistive technology announces it. */
export const Banner = ({ tone = c.sunSoft, children, action, onAction }) => (
  <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <T size={13} style={{ flex: 1 }}>{children}</T>
    {action ? <Btn small title={action} color={c.paper} ink={c.ink} onPress={onAction} /> : null}
  </View>
);

/** One headline number. Tap to open the list it counts. */
export function Metric({ value, label, tone, onPress, sub }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : 'text'} accessibilityLabel={`${value} ${label}${sub ? `, ${sub}` : ''}`} style={{ flexGrow: 1, flexBasis: 150, minHeight: 88 }}>
      <Card color={tone ?? c.paper} pad={14} style={{ flex: 1 }}>
        <T size={28} weight="800" style={{ letterSpacing: -0.8 }}>{value}</T>
        <T size={12} color={c.mute} weight="600">{label}</T>
        {sub ? <T size={11} color={c.mute} style={{ marginTop: 2 }}>{sub}</T> : null}
      </Card>
    </Pressable>
  );
}

/** Requirement checks as the server evaluated them: what passed, what failed, and which failures block approval. */
export function Checks({ checks, title = 'Requirements' }) {
  if (!checks?.length) return null;
  return (
    <Card color={c.paper}>
      <T weight="700" size={14}>{title}</T>
      <View style={{ gap: 8, marginTop: 8 }}>
        {checks.map((k) => (
          <View key={k.key} accessible accessibilityLabel={`${k.label}: ${k.status === 'pass' ? 'met' : 'not met'}${k.required ? '' : ', advisory'}${k.detail ? `. ${k.detail}` : ''}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: k.status === 'pass' ? c.mint : c.red, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
              <T size={12} weight="800" color="#fff">{k.status === 'pass' ? '✓' : '!'}</T>
            </View>
            <View style={{ flex: 1 }}>
              <T size={13} weight="600">{k.label}</T>
              {k.detail ? <T size={12} color={c.mute}>{k.detail}</T> : null}
            </View>
          </View>))}
      </View>
    </Card>
  );
}

/** The immutable decision log, oldest first. */
export function History({ history, title = 'History' }) {
  if (!history?.length) return null;
  return (
    <Card color={c.paper}>
      <T weight="700" size={14}>{title}</T>
      <View style={{ gap: 12, marginTop: 10 }}>
        {history.map((h) => (
          <View key={h.id} style={{ flexDirection: 'row', gap: 10 }} accessible accessibilityLabel={`${h.action.replace(/_/g, ' ')}${h.actor_name ? ` by ${h.actor_name}` : ''}, ${fmtDate(h.created_at)}${h.reason ? `. ${h.reason}` : ''}`}>
            <View style={{ alignItems: 'center' }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.pink, marginTop: 5 }} /><View style={{ flex: 1, width: 2, backgroundColor: c.line, marginTop: 2 }} /></View>
            <View style={{ flex: 1, paddingBottom: 2 }}>
              <T size={13} weight="700">{h.action.replace(/_/g, ' ')}{h.to_status ? ` → ${statusLabel(h.to_status)}` : ''}</T>
              <T size={12} color={c.mute}>{h.actor_name ? `${h.actor_name} · ` : 'System · '}{fmtDate(h.created_at)}</T>
              {h.reason ? <T size={12} style={{ marginTop: 2 }}>{h.reason}</T> : null}
            </View>
          </View>))}
      </View>
    </Card>
  );
}

/** Where the record sits among the body's regions, states and districts (#574). Shown only when the body has set any up; one pick, never typed. */
export function JurisdictionPick({ bodyId, value, onChange, label = 'Region, state or district', hint }) {
  const [list, setList] = useState([]);
  useEffect(() => { setList([]); onChange(undefined); if (bodyId) api.get(`/federation/bodies/${bodyId}/jurisdictions`).then(setList).catch(() => setList([])); }, [bodyId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return null;
  return <MenuField label={label} value={value ?? ''} onChange={(v) => onChange(v || undefined)} placeholder="Choose" hint={hint}
    options={[{ value: '', label: 'Not set' }, ...list.map((j) => ({ value: j.id, label: j.name, sub: j.level }))]} />;
}

/** Search-and-pick a governing body (never an id). Filter by the sport it must govern. */
export function BodyPicker({ label = 'Governing body', value, onChange, sportId, optional }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const t = setTimeout(async () => { try { const r = await api.get('/federation/bodies', { q: q.trim() || undefined, sport_id: sportId || undefined, limit: 20 }); if (live) setRows(r); } catch { if (live) setRows([]); } }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, sportId]);
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}{optional ? ' (optional)' : ''}</T>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={value ? `${label}: ${value.name}. Change` : `Choose ${label.toLowerCase()}`}>
        <Card color={c.paper} pad={12}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <T weight={value ? '700' : '500'} color={value ? c.ink : c.mute}>{value ? value.name : 'Search a federation, association or league…'}</T><T color={c.pink} weight="700" size={13}>{value ? 'Change' : 'Choose'}</T>
        </View></Card>
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
        <Field value={q} onChangeText={setQ} placeholder="Search by name or abbreviation" accessibilityLabel="Search governing bodies" />
        <View style={{ gap: 8, marginTop: 10 }}>
          {rows === null ? <Loading /> : rows.length ? rows.map((b) => (
            <Pressable key={b.id} accessibilityRole="button" accessibilityLabel={`${b.name}, ${LEVEL_LABEL[b.level]}`} onPress={() => { onChange(b); setOpen(false); }}>
              <Card color={c.paper} pad={12}>
                <T weight="700">{b.name}</T>
                <T size={12} color={c.mute}>{b.abbreviation} · {LEVEL_LABEL[b.level]}{jurisdiction(b) ? ` · ${jurisdiction(b)}` : ''}{b.parent_name ? ` · under ${b.parent_name}` : ''}</T>
              </Card>
            </Pressable>)) : <Empty emoji="🔎" title="No governing body found" sub={sportId ? 'None governs this sport yet, or try another name.' : 'Try another name.'} />}
        </View>
      </Sheet>
    </View>
  );
}

const PLURAL = { affiliation: 'affiliations', licence: 'licences', sanction: 'sanctions' };
/**
 * The evidence on an application. Metadata only is listed; reading one item is audit-logged server-side. The applicant adds while the application is a
 * draft or sent back; the body's reviewers can open items they are allowed to see.
 */
export function Evidence({ type, id, items, canAdd, canRead, required = [], onChanged }) {
  const { toast } = useSession();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const have = new Set((items ?? []).map((e) => e.requirement.toLowerCase()));
  const open = async (e) => {
    setBusy(e.id);
    try {
      const r = await api.get(`/federation/${PLURAL[type]}/${id}/evidence/${e.id}`);
      if (r.file) await openBase64({ file_name: r.file.name, data: r.file.data, type: r.file.content_type });
      else toast(r.reference);
    } catch (err) { toast(explain(err)); } finally { setBusy(null); }
  };
  const remove = async (e) => { try { await api.del(`/federation/${PLURAL[type]}/${id}/evidence/${e.id}`); onChanged?.(); } catch (err) { toast(explain(err)); } };
  const fields = [
    { key: 'requirement', label: 'What is this for?', type: required.length ? 'chips' : 'text', options: required.length ? [...required, 'Other'] : undefined, hint: 'e.g. Constitution, First-aid certificate' },
    { key: 'other', label: 'Name it', show: (v) => v.requirement === 'Other', optional: true },
    { key: 'reference', label: 'Registration number or link', optional: true, hint: 'A number, or an https link. Or attach a file below.' },
    { key: 'file', label: 'File', type: 'files', max: 1, optional: true },
  ];
  return (
    <Card color={c.paper}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T weight="700" size={14}>Documents and evidence</T>
        {canAdd ? <Btn small title="Add" onPress={() => setAdding(true)} /> : null}
      </View>
      {required.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {required.map((r) => <Tag key={r} label={`${have.has(r.toLowerCase()) ? '✓' : '○'} ${r}`} color={have.has(r.toLowerCase()) ? c.mint : c.sun} />)}
        </View>) : null}
      <View style={{ gap: 8, marginTop: 10 }}>
        {(items ?? []).length ? items.map((e) => (
          <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}><T size={13} weight="700">{e.requirement}</T><T size={12} color={c.mute}>{e.has_file ? `${e.file_name} · ${Math.max(1, Math.round(e.size_bytes / 1024))} KB` : 'Reference'} · {fmtDate(e.created_at)}</T></View>
            {canRead ? <Btn small title="Open" color={c.paper} ink={c.ink} loading={busy === e.id} onPress={() => open(e)} /> : null}
            {canAdd ? <Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => remove(e)} /> : null}
          </View>)) : <T size={13} color={c.mute}>{canAdd ? 'Nothing attached yet.' : 'Nothing attached.'}</T>}
      </View>
      <FormSheet visible={adding} onClose={() => setAdding(false)} title="Add a document" fields={fields} initial={{ requirement: required.find((r) => !have.has(r.toLowerCase())) ?? required[0] }} submitLabel="Attach"
        onSubmit={async (v) => {
          const f = v.file?.[0];
          if (!v.reference && !f) throw new Error('Give a reference or attach a file');
          await api.post(`/federation/${PLURAL[type]}/${id}/evidence`, { requirement: v.requirement === 'Other' ? v.other : v.requirement, reference: v.reference || undefined, file_name: f?.file_name, data: f?.data });
          setAdding(false); onChanged?.();
        }} />
    </Card>
  );
}

/**
 * Decide a record: pick the action, say why, and (for approvals) the dates and an override when a requirement fails. The refusal of a decision shows
 * the failed checks, and an override is only offered after the server has said a requirement is not met.
 */
export function DecisionSheet({ visible, onClose, kind, record, action, onDone }) {
  const { toast } = useSession();
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [until, setUntil] = useState(null);
  const [failed, setFailed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);
  useEffect(() => { if (visible) { setReason(''); setOverride(''); setFrom(null); setTo(null); setUntil(null); setFailed(null); setAsk(null); } }, [visible, action]);
  if (!action) return null;
  const needsReason = ['request_info', 'reject', 'suspend', 'revoke'].includes(action);
  const verb = { start_review: 'Start review', request_info: 'Ask for information', approve: 'Approve', reject: 'Do not approve', suspend: 'Suspend', reinstate: 'Reinstate', revoke: 'Revoke' }[action];
  const submit = async () => {
    setBusy(true);
    try {
      const body = { action, version: record.row_version, ...(reason ? { reason } : {}), ...(override ? { override_reason: override } : {}) };
      if (action === 'approve') {
        if (kind === 'affiliations') Object.assign(body, from ? { effective_from: from } : {}, to ? { effective_to: to } : {});
        if (kind === 'licences') Object.assign(body, from ? { issued_on: from } : {}, to ? { expires_on: to } : {});
        if (kind === 'sanctions') Object.assign(body, from ? { approved_starts_on: from } : {}, to ? { approved_ends_on: to } : {});
      }
      if (action === 'suspend' && kind === 'licences' && until) body.suspended_until = until;
      try { await api.post(`/federation/${kind}/${record.id}/decision`, body); }
      catch (e) {
        // a four-eyes rule: use an approval already granted for this record, otherwise ask for one
        if (codeOf(e) !== 'approval_required') throw e;
        const key = detailsOf(e).action;
        const found = await usableApproval(record.body_id, key, record.id);
        if (!found) { setAsk({ action: key, request: { subject_id: record.id, ...(override ? { override_reason: override } : {}), ...(action === 'suspend' ? { reason } : {}) } }); return; }
        await api.post(`/federation/${kind}/${record.id}/decision`, { ...body, approval_id: found.id });
      }
      toast(`${verb}: done`); onClose(); onDone?.();
    } catch (e) {
      const ch = checksOf(e);
      if (ch) setFailed(ch); else toast(explain(e));
    } finally { setBusy(false); }
  };
  const label = kind === 'licences' ? ['Issue date', 'Expiry date'] : kind === 'sanctions' ? ['Approved from', 'Approved to'] : ['Effective from', 'Effective to'];
  return (
    <Sheet visible={visible} onClose={onClose} title={verb}>
      <View style={{ gap: 12 }}>
        {needsReason || action === 'reinstate' ? <Field label={needsReason ? 'Reason (the applicant is shown this)' : 'Note (optional)'} value={reason} onChangeText={setReason} multiline maxLength={500} /> : null}
        {action === 'approve' ? (
          <>
            <T size={12} color={c.mute}>Leave the dates empty to use the defaults from the category, type or request.</T>
            <DateField label={label[0]} value={from} onChange={setFrom} optional />
            <DateField label={label[1]} value={to} onChange={setTo} optional min={from ?? undefined} />
          </>) : null}
        {action === 'suspend' && kind === 'licences' ? <DateField label="Suspended until (optional)" value={until} onChange={setUntil} optional min={todayIso()} hint="Leave empty to suspend until you reinstate." /> : null}
        {failed ? (
          <>
            <Checks checks={failed} title="Not all requirements are met" />
            <Field label="Approve anyway — record why (this is logged as a compliance exception)" value={override} onChangeText={setOverride} multiline maxLength={500} />
          </>) : null}
        <ApprovalAskSheet visible={!!ask} onClose={() => { setAsk(null); onClose(); }} bodyId={record.body_id} action={ask?.action} label={verb} request={ask?.request} />
        <Btn title={failed && override ? 'Approve with override' : verb} loading={busy} disabled={(needsReason && reason.trim().length < 3) || (!!failed && override.trim().length < 5)} onPress={submit} />
      </View>
    </Sheet>
  );
}

/** The actions a record offers, as buttons, plus the PDF the body can issue. `actions` is what the server says the caller may do. */
export function ActionBar({ kind, record, onAct, onDocument, documentLabel, busy }) {
  const staff = ['start_review', 'request_info', 'approve', 'reject', 'suspend', 'reinstate', 'revoke'];
  const mine = (record.actions ?? []).filter((a) => staff.includes(a));
  const tone = (a) => (a === 'approve' ? c.pink : a === 'reinstate' || a === 'start_review' ? c.violet : c.paper);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {mine.map((a) => <Btn key={a} small title={{ start_review: 'Start review', request_info: 'Ask for information', approve: 'Approve', reject: 'Do not approve', suspend: 'Suspend', reinstate: 'Reinstate', revoke: 'Revoke' }[a]} color={tone(a)} ink={tone(a) === c.paper ? c.ink : '#fff'} onPress={() => onAct(a)} />)}
      {onDocument ? <Btn small title={documentLabel ?? 'Issue document'} color={c.paper} ink={c.ink} loading={busy} onPress={onDocument} /> : null}
    </View>
  );
}

/** Issue the branded document for a record in force and open it. */
export async function issueDocument(subjectType, subjectId, note) {
  const d = await api.post('/federation/documents', { subject_type: subjectType, subject_id: subjectId, ...(note ? { note } : {}) });
  await openPdf(`/branded-documents/${d.id}/file`, `${subjectType}-${d.id.slice(0, 8)}`);
  return d;
}
