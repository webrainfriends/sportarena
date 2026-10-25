// Buying-team home and tender console: one place to run a tender (overview and governance, opening, evaluation, negotiation, award, audit).
// Per CLAUDE.md the event console links here rather than duplicating it; there is exactly one console for a tender.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Screen, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Head } from './coaching';
import { c } from '../theme';
import { explain } from '../access';
import { EvaluationTab, AwardTab } from './tender-evaluation';
import { Checks, Chips, DataTable, KV, Notice, Panel, Split, Stages, StageTag, Status, Tabs, amount, blobOf, day, nice, openDocument, openStored, saveExport, when, wallOf, zonedIso } from '../tender-ui';

const ROLES = ['author', 'technical_evaluator', 'commercial_evaluator', 'chair', 'approver', 'opener', 'legal_reviewer', 'auditor', 'stakeholder'];
const MANDATES = ['procurement_admin', 'author', 'approver', 'evaluator', 'auditor'];

// ------------------------------------------------------------------ home: my RFPs, approvals, authority
export function TenderHome() {
  const { toast } = useSession();
  const { push } = useNav();
  const [stage, setStage] = useState('');
  const [sheet, setSheet] = useState(null);
  const rfps = useLoad(() => api.get('/rfps', { limit: 100, ...(stage ? { stage } : {}) }), [stage]);
  const approvals = useLoad(() => api.get('/approvals', { limit: 50 }), []);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const decide = async (a, decision, reason) => { try { await api.post(`/approvals/${a.id}/decide`, { decision, reason }); toast(decision === 'approve' ? 'Approved' : 'Rejected'); approvals.reload(); rfps.reload(); } catch (e) { toast(explain(e)); } };
  const [reject, setReject] = useState(null);
  return (
    <Screen wide>
      <Head eyebrow="TENDER ZONE · BUYING TEAM" title="My RFPs" sub="Everything you run or help run: drafts, approvals, live tenders, evaluation and awards."
        right={<View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Orders" color={c.violet} onPress={() => push('TenderOrders')} /><Btn small title="Reports" color={c.violet} onPress={() => push('TenderReports')} /><Btn small title="Create RFP" onPress={() => push('TenderBuilder')} /></View>} />
      <View style={{ marginTop: 14 }}>
        <Split main={
          <>
            <Panel title="Your tenders" right={<Chips options={[{ value: '', label: 'All' }, { value: 'draft', label: 'Drafts' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }, { value: 'evaluation', label: 'Evaluation' }, { value: 'awarded', label: 'Awarded' }]} value={stage} onChange={setStage} />}>
              {rfps.error ? <ErrorBox error={rfps.error} onRetry={rfps.reload} /> : rfps.loading && !rfps.data ? <Loading /> : <DataTable onRow={(r) => push('TenderConsole', { id: r.id })} empty="No tenders yet. Create an RFP for an event, a venue or a standalone service." rows={rfps.data ?? []} cols={[
                { key: 'title', label: 'Tender', flex: 2, min: 200, render: (r) => `${r.ref} · ${r.title}` }, { key: 'stage', label: 'Stage', min: 110, render: (r) => <StageTag stage={r.stage} /> }, { key: 'category', label: 'Category', min: 130 },
                { key: 'closes_at', label: 'Closes', min: 120, render: (r) => day(r.closes_at) }, { key: 'participants', label: 'Interested', min: 80, right: true }, { key: 'submitted', label: 'Proposals', min: 80, right: true }]} />}
            </Panel>
          </>
        } side={
          <>
            <Panel title="Needs your decision">
              {(approvals.data ?? []).length ? approvals.data.map((a) => (
                <View key={a.id} style={{ gap: 6, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}>
                  <T weight="700" size={13}>{nice(a.kind)}</T><T size={12} color={c.mute}>{a.ref} · {a.title}</T><T size={12} color={c.mute}>{a.approvals}/{a.required} approvals</T>
                  <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title="Approve" onPress={() => decide(a, 'approve')} /><Btn small title="Reject" color={c.violet} onPress={() => setReject(a)} /><Btn small title="Open" color={c.violet} onPress={() => push('TenderConsole', { id: a.project_id })} /></View>
                </View>)) : <T size={13} color={c.mute}>Nothing waiting. Approvals you can decide appear here; you can never approve your own request.</T>}
            </Panel>
            <Panel title="Procurement authority"><T size={13} color={c.mute}>Owners and admins of an organisation can give people explicit procurement authority. Plain membership never grants it.</T><Btn small title="Grant authority" color={c.violet} onPress={() => setSheet('mandate')} /><Btn small title="Approval thresholds" color={c.violet} onPress={() => setSheet('policy')} /></Panel>
          </>
        } />
      </View>
      <FormSheet visible={!!reject} onClose={() => setReject(null)} title="Reject" submitLabel="Reject" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => decide(reject, 'reject', v.reason)} />
      <FormSheet visible={sheet === 'mandate'} onClose={() => setSheet(null)} title="Grant procurement authority" submitLabel="Grant"
        fields={[{ key: 'organisation_id', label: 'Organisation', type: 'chips', options: (orgs.data ?? []).map((o) => ({ value: o.id, label: o.name })) }, { key: 'handle', label: 'Their handle' }, { key: 'role', label: 'Authority', type: 'chips', options: MANDATES.map((v) => ({ value: v, label: nice(v) })) }, { key: 'expires_on', label: 'Until (optional)', type: 'date', optional: true }]}
        onSubmit={async (v) => { await api.post('/procurement/mandates', { organisation_id: v.organisation_id, handle: v.handle, role: v.role, expires_at: v.expires_on ? new Date(`${v.expires_on}T23:59:59Z`).toISOString() : undefined }); return 'Authority granted'; }} />
      <FormSheet visible={sheet === 'policy'} onClose={() => setSheet(null)} title="Approval thresholds" submitLabel="Save"
        fields={[{ key: 'organisation_id', label: 'Organisation', type: 'chips', options: (orgs.data ?? []).map((o) => ({ value: o.id, label: o.name })) }, { key: 'currency', label: 'Currency', type: 'currency', default: 'INR' }, { key: 'publish_threshold_minor', label: 'Publishing needs extra approval from', type: 'money', currency: (v) => v.currency ?? 'INR', optional: true }, { key: 'award_threshold_minor', label: 'An award needs extra approval from', type: 'money', currency: (v) => v.currency ?? 'INR', optional: true }, { key: 'extra_approvals', label: 'Extra approvals', type: 'stepper', min: 0, max: 3, default: 1 }]}
        initial={{ extra_approvals: 1, currency: 'INR' }} onSubmit={async (v) => { await api.post('/procurement/policies', v); return 'Thresholds saved'; }} />
    </Screen>
  );
}

// ------------------------------------------------------------------ console
const TABS = [{ value: 'overview', label: 'Overview' }, { value: 'opening', label: 'Opening' }, { value: 'evaluation', label: 'Evaluation' }, { value: 'negotiation', label: 'Negotiation' }, { value: 'award', label: 'Award' }, { value: 'audit', label: 'Audit' }];

export function TenderConsole({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const [tab, setTab] = useState('overview');
  const [sheet, setSheet] = useState(null);
  const r = useLoad(() => api.get(`/rfps/${id}`), [id]);
  if (r.error) return <Screen><ErrorBox error={r.error} onRetry={r.reload} /></Screen>;
  if (r.loading && !r.data) return <Screen><Loading /></Screen>;
  const t = r.data, roles = t.my_roles, stage = t.stage;
  const can = (a) => t.can.includes(a);
  const run = async (fn, ok) => { try { await fn(); if (ok) toast(ok); r.reload(); } catch (e) { toast(explain(e)); } };
  const draft = t.status === 'draft';
  return (
    <Screen wide>
      <Head eyebrow={`${t.ref} · ${t.kind.toUpperCase()}`} title={t.title} sub={`You are: ${roles.map(nice).join(', ')}`}
        right={<View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StageTag stage={stage} />{draft && can('edit') ? <Btn small title="Edit in builder" onPress={() => push('TenderBuilder', { id })} /> : null}{t.status === 'approved' && can('publish') ? <Btn small title="Publish" onPress={() => run(() => api.post(`/rfps/${id}/publish`), 'Published')} /> : null}</View>} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <View style={{ marginTop: 14, gap: 14 }}>
        {tab === 'overview' ? <Overview t={t} id={id} reload={r.reload} run={run} setSheet={setSheet} can={can} push={push} toast={toast} /> : null}
        {tab === 'opening' ? <Opening t={t} id={id} reload={r.reload} can={can} toast={toast} /> : null}
        {tab === 'evaluation' ? <EvaluationTab t={t} id={id} can={can} toast={toast} reload={r.reload} /> : null}
        {tab === 'negotiation' ? <Negotiation t={t} id={id} can={can} toast={toast} reload={r.reload} /> : null}
        {tab === 'award' ? <AwardTab t={t} id={id} can={can} toast={toast} reload={r.reload} push={push} /> : null}
        {tab === 'audit' ? <Audit t={t} id={id} toast={toast} /> : null}
      </View>
      <Sheets t={t} id={id} sheet={sheet} setSheet={setSheet} reload={r.reload} />
    </Screen>
  );
}

function Overview({ t, id, reload, run, setSheet, can, push, toast }) {
  const q = useLoad(() => api.get(`/tenders/${id}/questions`, { limit: 100 }), [id]);
  const parts = useLoad(() => (can('invite') ? api.get(`/rfps/${id}/participants`, { limit: 100 }) : Promise.resolve([])), [id]);
  const steps = [['Draft', ['draft']], ['Approval', ['in_review', 'approved']], ['Published', ['published']], ['Evaluation', ['evaluation']], ['Award', ['award']], ['Awarded', ['awarded', 'closed']]];
  const idx = steps.findIndex(([, ss]) => ss.includes(t.status));
  const pend = t.approvals.filter((a) => a.status === 'pending');
  return (
    <Split main={
      <>
        <Panel><Stages steps={steps.map(([label], i) => ({ label, state: i < idx ? 'done' : i === idx ? 'on' : 'next' }))} />
          <KV items={[['Stage', nice(t.stage)], ['Closes', t.closes_at ? when(t.closes_at, t.timezone) : null], ['Opening not before', t.opens_at ? when(t.opens_at, t.timezone) : null], ['Version', `v${t.version} · rubric v${t.rubric_version}`], ['Envelopes', nice(t.envelope_mode)], ['Quorum', t.quorum], ['Participants', t.counts.participants], ['Proposals', t.counts.proposals_submitted], ['Questions waiting', t.counts.questions_waiting]]} /></Panel>
        {t.suspended_at ? <Notice>Submissions are suspended: {t.suspend_reason}</Notice> : null}
        <Panel title="Approvals">
          {t.approvals.length ? t.approvals.map((a) => <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T size={13} weight="700" style={{ flex: 1, minWidth: 140 }}>{nice(a.kind)}</T><T size={12} color={c.mute}>{a.approvals}/{a.required}</T><Status tone={a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'bad' : 'warn'} label={nice(a.status)} />{a.status === 'pending' && can('approve') ? <><Btn small title="Approve" onPress={() => run(() => api.post(`/approvals/${a.id}/decide`, { decision: 'approve' }), 'Approved')} /><Btn small title="Reject" color={c.violet} onPress={() => setSheet({ reject: a })} /></> : null}</View>) : <T size={13} color={c.mute}>No approvals yet.</T>}
          {t.status === 'draft' && can('request_approval') ? <Btn title="Request approval" onPress={() => run(() => api.post(`/rfps/${id}/request-approval`), 'Sent for approval')} style={{ alignSelf: 'flex-start' }} /> : null}
        </Panel>
        <Panel title="Participants" right={can('invite') ? <Btn small title="Invite" onPress={() => setSheet('invite')} /> : null}>
          <DataTable rows={parts.data ?? []} empty="No suppliers yet." cols={[{ key: 'legal_name', label: 'Supplier', flex: 2, min: 150, bold: true }, { key: 'status', label: 'Status', min: 100, render: (p) => <Status tone={p.status === 'declined' ? 'bad' : p.status === 'requested' ? 'warn' : 'ok'} label={nice(p.status)} /> }, { key: 'terms', label: 'Terms', min: 80, render: (p) => (p.terms_accepted_at ? 'Accepted' : '—') }, { key: 'act', label: '', min: 190, render: (p) => <View style={{ flexDirection: 'row', gap: 6 }}>{p.status === 'requested' ? <><Btn small title="Approve" onPress={() => run(() => api.post(`/rfps/${id}/invites`, { decide: [{ entity_id: p.entity_id, decision: 'approve' }] }), 'Approved')} /><Btn small title="Reject" color={c.violet} onPress={() => run(() => api.post(`/rfps/${id}/invites`, { decide: [{ entity_id: p.entity_id, decision: 'reject', reason: 'Not suitable for this tender' }] }), 'Rejected')} /></> : null}{t.site_visit_mandatory && !p.site_visit_attended && !p.site_visit_exempt_reason ? <Btn small title="Record visit" color={c.violet} onPress={() => run(() => api.post(`/rfps/${id}/site-visit`, { entity_id: p.entity_id, attended: true }), 'Recorded')} /> : null}</View> }]} />
        </Panel>
        <Panel title="Clarifications">
          {(q.data ?? []).length ? q.data.map((x) => <View key={x.id} style={{ gap: 4, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}><T weight="700" size={13}>{x.question}</T><T size={11} color={c.mute}>Asked by {x.asked_by}</T>{x.answer ? <T size={13}>{x.answer} <T size={11} color={c.mute}>{x.published ? '(published to all)' : '(private)'}</T></T> : can('qna') ? <Btn small title="Answer" onPress={() => setSheet({ answer: x })} style={{ alignSelf: 'flex-start' }} /> : null}</View>) : <T size={13} color={c.mute}>No questions yet.</T>}
        </Panel>
      </>
    } side={
      <>
        <Panel title="Team" right={can('members') ? <Btn small title="Add" color={c.violet} onPress={() => setSheet('member')} /> : null}>
          {t.members.map((m) => <View key={`${m.user_id}${m.role}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T size={13} style={{ flex: 1 }}>{m.display_name} <T size={12} color={c.mute}>@{m.handle}</T></T><Status tone="neutral" label={nice(m.role)} />{can('members') ? <Btn small title="Revoke" color={c.violet} onPress={() => run(() => api.post(`/rfps/${id}/members`, { handle: m.handle, role: m.role, revoke: true }), 'Revoked')} /> : null}</View>)}
          <Btn small title="Declare conflict of interest" color={c.violet} onPress={() => setSheet('conflict')} />
        </Panel>
        {can('schedule') || can('addendum') ? <Panel title="Control">
          {can('addendum') && ['published', 'approved'].includes(t.status) ? <Btn small title="Issue an addendum" onPress={() => setSheet('addendum')} /> : null}
          {can('schedule') && t.status === 'published' ? <><Btn small title="Extend the deadline" color={c.violet} onPress={() => setSheet('extend')} />{t.suspended_at ? <Btn small title="Resume submissions" color={c.violet} onPress={() => run(() => api.post(`/rfps/${id}/schedule`, { action: 'resume', reason: 'Submissions resumed' }), 'Resumed')} /> : <Btn small title="Suspend submissions" color={c.violet} onPress={() => setSheet('suspend')} />}<Btn small title="Allow a late submission" color={c.violet} onPress={() => setSheet('late')} /></> : null}
          {can('schedule') && !['awarded', 'cancelled', 'archived'].includes(t.status) ? <Btn small title="Cancel the tender" color={c.red} onPress={() => setSheet('cancel')} /> : null}
          {can('edit') && ['cancelled', 'closed', 'awarded'].includes(t.status) ? <Btn small title="Reissue" color={c.violet} onPress={() => setSheet('reissue')} /> : null}
          {can('schedule') && ['closed', 'awarded', 'cancelled'].includes(t.status) ? <Btn small title="Archive" color={c.violet} onPress={() => run(() => api.post(`/rfps/${id}/archive`), 'Archived')} /> : null}
        </Panel> : null}
        <Panel title="Addenda">{t.addenda.length ? t.addenda.map((a) => <View key={a.n} style={{ gap: 2 }}><T size={13} weight="700">Addendum {a.n} {a.material ? '· material' : ''}</T><T size={12} color={c.mute}>{a.summary}</T></View>) : <T size={13} color={c.mute}>None.</T>}</Panel>
        <Panel title="Pack documents" right={can('files') ? <Btn small title="Add" color={c.violet} onPress={() => setSheet('file')} /> : null}>{t.files.length ? t.files.map((f) => <View key={f.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={13} style={{ flex: 1 }}>{f.name}</T><Status tone="neutral" label={f.audience} /><Btn small title="Open" color={c.violet} onPress={() => openStored(`/tender-files/${f.id}`, f.name).catch((e) => toast(explain(e)))} /></View>) : <T size={13} color={c.mute}>No documents. Public ones show on the notice; participant ones open after suppliers accept the terms.</T>}</Panel>
        <Panel title="Export"><Btn small title="Tender pack (ZIP)" color={c.violet} onPress={() => run(async () => { await api.post('/procurement/exports', { kind: 'tender_pack', format: 'zip', project_id: id }); }, 'Building the pack. Download it from Reports when it is ready.')} /><Btn small title="Notice PDF" color={c.violet} onPress={() => openDocument('notice', id, {}, t.ref).catch((e) => toast(explain(e)))} /></Panel>
      </>
    } />
  );
}

function Sheets({ t, id, sheet, setSheet, reload }) {
  const { toast } = useSession();
  const tz = t.timezone;
  const close = () => setSheet(null);
  const post = (path, body) => api.post(path, body);
  const instant = (v, k) => zonedIso(v[`${k}_d`], v[`${k}_t`] ?? '17:00', tz);
  const sup = useLoad(() => (sheet === 'invite' ? api.get('/supplier-entities/search', { limit: 50, organisation_id: t.organisation_id ?? undefined }) : Promise.resolve([])), [sheet]);
  const partsLate = useLoad(() => (sheet === 'late' ? api.get(`/rfps/${id}/participants`, { limit: 100 }) : Promise.resolve([])), [sheet]);
  const answer = sheet?.answer;
  return (
    <>
      <FormSheet visible={sheet === 'member'} onClose={close} title="Add to the team" submitLabel="Add" fields={[{ key: 'handle', label: 'Their handle' }, { key: 'role', label: 'Role', type: 'chips', options: ROLES.map((v) => ({ value: v, label: nice(v) })) }, { key: 'expires_on', label: 'Until (optional)', type: 'date', optional: true }]}
        onSubmit={async (v) => { await post(`/rfps/${id}/members`, { handle: v.handle, role: v.role, expires_at: v.expires_on ? new Date(`${v.expires_on}T23:59:59Z`).toISOString() : undefined }); reload(); return 'Added'; }} />
      <FormSheet visible={sheet === 'conflict'} onClose={close} title="Conflict of interest" submitLabel="Record" fields={[{ key: 'has_conflict', label: 'I have a conflict of interest', type: 'switch' }, { key: 'note', label: 'Describe it', type: 'multiline', optional: true, show: (v) => v.has_conflict }]} initial={{ has_conflict: false }}
        onSubmit={async (v) => { await post(`/rfps/${id}/conflicts`, { has_conflict: !!v.has_conflict, note: v.note || undefined }); return 'Recorded'; }} />
      <FormSheet visible={sheet === 'invite'} onClose={close} title="Invite suppliers" submitLabel="Invite" fields={[{ key: 'ids', label: 'Suppliers', type: 'multi', options: (sup.data ?? []).map((s) => ({ value: s.id, label: `${s.legal_name}${s.verified_credentials?.length ? ` · ${s.verified_credentials.length} verified` : ''}` })) }]}
        onSubmit={async (v) => { await post(`/rfps/${id}/invites`, { entity_ids: v.ids }); reload(); return 'Invitations sent'; }} />
      <FormSheet visible={sheet === 'addendum'} onClose={close} title="Issue an addendum" submitLabel="Issue" fields={[{ key: 'summary', label: 'Summary' }, { key: 'reason', label: 'Reason' }, { key: 'body', label: 'Details', type: 'multiline', optional: true }, { key: 'scope', label: 'Replace the scope text (material change)', type: 'multiline', optional: true }, { key: 'new_d', label: 'New closing date', type: 'date', optional: true }, { key: 'new_t', label: 'New closing time', type: 'time', optional: true }]}
        onSubmit={async (v) => { const changes = v.scope ? { scope: v.scope } : {}; const r = await post(`/rfps/${id}/addenda`, { summary: v.summary, reason: v.reason, body: v.body || undefined, changes, new_closes_at: v.new_d ? zonedIso(v.new_d, v.new_t ?? '17:00', tz) : undefined }); reload(); return r.status === 'approval_pending' ? 'Sent for approval: a material change takes effect when approved' : 'Addendum issued'; }} />
      <FormSheet visible={sheet === 'extend'} onClose={close} title="Extend the deadline" submitLabel="Extend" fields={[{ key: 'd', label: 'New closing date', type: 'date' }, { key: 't', label: 'Time', type: 'time' }, { key: 'reason', label: 'Reason', type: 'multiline' }]}
        onSubmit={async (v) => { const r = await post(`/rfps/${id}/schedule`, { action: 'extend', reason: v.reason, new_closes_at: zonedIso(v.d, v.t ?? '17:00', tz) }); reload(); return r.status === 'extended' ? 'Deadline extended' : 'Sent for approval'; }} />
      <FormSheet visible={sheet === 'suspend'} onClose={close} title="Suspend submissions" submitLabel="Suspend" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await post(`/rfps/${id}/schedule`, { action: 'suspend', reason: v.reason }); reload(); return 'Suspended. Resuming gives suppliers back the time lost.'; }} />
      <FormSheet visible={sheet === 'late'} onClose={close} title="Allow a late submission" submitLabel="Request approval"
        fields={[{ key: 'entity', label: 'Supplier', type: 'chips', options: (partsLate.data ?? []).map((p) => ({ value: p.entity_id, label: p.legal_name })) }, { key: 'd', label: 'Allowed until (date)', type: 'date' }, { key: 't', label: 'Time', type: 'time' }, { key: 'reason', label: 'Documented reason', type: 'multiline', hint: 'For example a recorded outage. Another approver must agree.' }]}
        onSubmit={async (v) => { await post(`/rfps/${id}/schedule`, { action: 'late_window', reason: v.reason, entity_id: v.entity, until: zonedIso(v.d, v.t ?? '17:00', tz) }); reload(); return 'Sent for approval'; }} />
      <FormSheet visible={sheet === 'cancel'} onClose={close} title="Cancel the tender" submitLabel="Cancel tender" fields={[{ key: 'reason', label: 'Reason (suppliers are told)', type: 'multiline' }]} onSubmit={async (v) => { await post(`/rfps/${id}/schedule`, { action: 'cancel', reason: v.reason }); reload(); return 'Cancelled'; }} />
      <FormSheet visible={sheet === 'reissue'} onClose={close} title="Reissue as a new draft" submitLabel="Reissue" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await post(`/rfps/${id}/reissue`, { reason: v.reason }); return 'A new draft was created. Find it in My RFPs.'; }} />
      <FormSheet visible={!!sheet?.reject} onClose={close} title="Reject" submitLabel="Reject" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await post(`/approvals/${sheet.reject.id}/decide`, { decision: 'reject', reason: v.reason }); reload(); return 'Rejected'; }} />
      <FormSheet visible={!!answer} onClose={close} title="Answer the question" submitLabel="Answer" fields={[{ key: 'answer', label: 'Answer', type: 'multiline' }, { key: 'material', label: 'Material: share with every participant', type: 'switch' }]} initial={{ material: true }} onSubmit={async (v) => { await post(`/rfps/${id}/questions/${answer.id}/answer`, { answer: v.answer, material: !!v.material, publish: !!v.material }); reload(); return 'Answered'; }} />
      <FileSheet visible={sheet === 'file'} onClose={close} id={id} reload={reload} />
    </>
  );
}

function FileSheet({ visible, onClose, id, reload }) {
  const { toast } = useSession();
  const [aud, setAud] = useState('participants');
  const upload = async () => {
    try { const { pickEvidence } = await import('../evidence'); const f = await pickEvidence('files'); if (!f) return; await api.upload(`/rfps/${id}/files`, await blobOf(f), { name: f.file_name, audience: aud }); toast('Document added'); onClose(); reload(); } catch (e) { toast(explain(e)); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Add a document" footer={<Btn title="Choose a file" onPress={upload} style={{ flex: 1 }} />}>
      <T size={13} color={c.mute}>Who can download it. A public notice never makes attachments public unless you choose Public here.</T>
      <Chips options={[{ value: 'public', label: 'Public notice' }, { value: 'participants', label: 'Participants' }, { value: 'buyer', label: 'Buying team only' }]} value={aud} onChange={setAud} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ opening
function Opening({ t, id, reload, can, toast }) {
  const reg = useLoad(() => api.get(`/rfps/${id}/openings`), [id, t.status]);
  const subs = useLoad(() => api.get(`/rfps/${id}/submissions`, { limit: 100 }), [id, t.status]);
  const closed = t.closes_at && new Date(t.closes_at) <= new Date();
  const vote = async (envelope) => { try { const r = await api.post(`/rfps/${id}/open`, { envelope }); toast(r.opened ? 'Opened and recorded' : `Vote recorded: ${r.votes} of ${r.quorum}`); reg.reload(); subs.reload(); reload(); } catch (e) { toast(explain(e)); } };
  const tech = (reg.data?.openings ?? []).find((o) => o.envelope === 'technical' && o.round === 1), comm = (reg.data?.openings ?? []).find((o) => o.envelope === 'commercial' && o.round === 1);
  return (
    <Split main={
      <>
        <Panel title="Opening register">
          <Checks items={[
            { state: tech ? 'ok' : closed ? 'warn' : 'idle', title: tech ? 'Technical envelope opened' : 'Technical envelope sealed', detail: tech ? `${when(tech.opened_at, t.timezone)} · ${tech.participants.map((p) => p.handle).join(', ')} · ${tech.submissions.length} submissions` : closed ? 'Ready to open when the quorum votes' : `Sealed until ${when(t.closes_at, t.timezone)}`, action: !tech && closed && can('open') ? 'Cast opening vote' : null, onAction: () => vote('technical') },
            ...(t.envelope_mode === 'sealed_dual' ? [{ state: comm ? 'ok' : 'idle', title: comm ? 'Commercial envelope opened' : 'Commercial envelope sealed', detail: comm ? `${when(comm.opened_at, t.timezone)} · ${comm.participants.map((p) => p.handle).join(', ')}` : 'Unlocks only after a bidder passes the technical sign-off', action: tech && !comm && can('open') ? 'Cast opening vote' : null, onAction: () => vote('commercial') }] : []),
          ]} />
          <T size={12} color={c.mute}>Quorum: {reg.data?.quorum ?? t.quorum} different authorised openers. Votes so far: {(reg.data?.pending_votes ?? []).map((v) => `${v.handle} (${v.envelope})`).join(', ') || 'none'}. Nothing opens before the deadline and the earliest opening time, and a delayed background job can never open early.</T>
          {tech ? <Btn small title="Register PDF" color={c.violet} onPress={() => openDocument('opening', id, { envelope: 'technical' }, 'opening-register').catch((e) => toast(explain(e)))} style={{ alignSelf: 'flex-start' }} /> : null}
        </Panel>
        <Panel title="Submissions">
          {subs.data && !subs.data.opened ? <Notice tone="info">{subs.data.count} proposal(s) received and sealed. Nobody on the buying team can read them before the opening.</Notice> : null}
          <DataTable rows={subs.data?.items ?? []} empty={subs.data?.opened ? 'No submissions.' : ''} cols={[{ key: 'legal_name', label: 'Supplier', flex: 2, min: 150, bold: true }, { key: 'receipt_no', label: 'Receipt', min: 150 }, { key: 'submitted_at', label: 'Received', min: 150, render: (s) => when(s.submitted_at, t.timezone) }, { key: 'eligibility', label: 'Eligibility', min: 110, render: (s) => <Status tone={s.eligibility === 'eligible' ? 'ok' : s.eligibility === 'ineligible' ? 'bad' : 'warn'} label={nice(s.eligibility)} /> }, { key: 'late', label: '', min: 80, render: (s) => (s.late ? <Status tone="warn" label="Late window" /> : '') }]} />
        </Panel>
      </>
    } side={
      <Panel title="How sealing works">
        <T size={13} color={c.mute}>Proposals are encrypted when submitted and every read goes through one audited gate. They cannot be read through the API, exports, direct file links, search, logs or notifications before the deadline and the recorded opening.</T>
        <T size={13} color={c.mute}>Limit, stated plainly: a platform operator who holds both the database and the master key could decrypt offline. That access is outside the app, and the app's own break-glass reads are justified, audited and notify the tender team.</T>
      </Panel>
    } />
  );
}

// ------------------------------------------------------------------ negotiation
function Negotiation({ t, id, can, toast, reload }) {
  const rounds = useLoad(() => api.get(`/tenders/${id}/rounds`), [id]);
  const subs = useLoad(() => api.get(`/rfps/${id}/submissions`, { limit: 100 }), [id]);
  const [sheet, setSheet] = useState(false);
  const eligible = (subs.data?.items ?? []).filter((s) => s.eligibility === 'eligible');
  const tz = t.timezone;
  return (
    <>
      <Panel title="Rounds" right={can('rounds') && t.status === 'evaluation' ? <Btn small title="Start a round" onPress={() => setSheet(true)} /> : null}>
        <DataTable rows={rounds.data ?? []} keyOf={(r) => r.n} empty="Only the initial round so far." cols={[{ key: 'n', label: 'Round', min: 70, flex: 0.5, bold: true }, { key: 'kind', label: 'Type', min: 140, render: (r) => (r.kind === 'bafo' ? 'Best and final offer' : nice(r.kind)) }, { key: 'closes_at', label: 'Closes', min: 160, render: (r) => (r.closes_at ? when(r.closes_at, tz) : '—') }, { key: 'invited', label: 'Invited', min: 80, render: (r) => (r.invited ? r.invited.length : 'all') }, { key: 'note', label: 'Note', flex: 2, min: 160 }]} />
        <T size={12} color={c.mute}>Earlier submissions stay immutable. A best and final offer only re-prices, using the same rules for everyone; suppliers never see competitors' offers. After a round, open its envelopes from the Opening tab and rank with the round selector in Evaluation.</T>
      </Panel>
      <FormSheet visible={sheet} onClose={() => setSheet(false)} title="Start a round" submitLabel="Invite"
        fields={[{ key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'bafo', label: 'Best and final offer' }, { value: 'clarification', label: 'Clarification' }, { value: 'demo', label: 'Demo' }, { value: 'site_assessment', label: 'Site assessment' }] }, { key: 'ids', label: 'Invite', type: 'multi', options: eligible.map((s) => ({ value: s.entity_id, label: s.legal_name })) }, { key: 'd', label: 'Closes on', type: 'date' }, { key: 't', label: 'Time', type: 'time' }, { key: 'note', label: 'Instructions', type: 'multiline', optional: true }]} initial={{ kind: 'bafo' }}
        onSubmit={async (v) => { await api.post(`/rfps/${id}/rounds`, { kind: v.kind, entity_ids: v.ids, closes_at: zonedIso(v.d, v.t ?? '17:00', tz), note: v.note || undefined }); rounds.reload(); reload(); return 'Round started'; }} />
    </>
  );
}

// ------------------------------------------------------------------ audit
function Audit({ t, id, toast }) {
  const a = useLoad(() => api.get(`/rfps/${id}/audit`, { limit: 100 }), [id]);
  const docs = [['notice', 'Notice', id, {}], ['opening', 'Opening register', id, { envelope: 'technical' }], ['comparison', 'Ranked comparison', id, {}]];
  return (
    <Split main={
      <Panel title="Audit trail" right={a.data ? <Status tone={a.data.chain_broken_at ? 'bad' : 'ok'} label={a.data.chain_broken_at ? 'Chain broken' : 'Chain intact'} /> : null}>
        {a.error ? <Notice>{explain(a.error)}</Notice> : <DataTable rows={a.data?.entries ?? []} empty="Nothing recorded yet." cols={[{ key: 'at', label: 'When', min: 160, render: (e) => when(e.at, t.timezone) }, { key: 'actor', label: 'Who', min: 110, render: (e) => e.actor ?? 'system' }, { key: 'action', label: 'What', flex: 2, min: 180, render: (e) => nice(e.action) }]} />}
        <T size={12} color={c.mute}>Append-only and hash-chained: nothing recorded here can be edited or removed.</T>
      </Panel>
    } side={<Panel title="Documents">{docs.map(([k, label, did, q]) => <Btn key={k} small title={`${label} PDF`} color={c.violet} onPress={() => openDocument(k, did, q, label).catch((e) => toast(explain(e)))} style={{ alignSelf: 'flex-start' }} />)}<T size={12} color={c.mute}>Documents are issued once and keep their historical values. Technical-only roles get documents without commercial figures.</T></Panel>} />
  );
}
