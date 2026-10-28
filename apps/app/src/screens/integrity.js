// Sport Integrity & Anti-Doping Administration (#489): the Integrity tab of Federation Home (the one home for a body's integrity work, shown only to its
// integrity officers), the case screen, and "My integrity" for the person concerned. The server decides who may see and do what; this shows what it returns.
// Nothing here interprets a result, scores a person or presents an allegation as a finding.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Empty, H1, Loading, Screen, Section, Seg, T, Tag, Chip } from '../ui';
import { FormSheet } from '../FormSheet';
import { BodyPicker, Banner, Metric, fmtDate, fmtRange } from '../federation-ui';
import { Cols, ListCard } from '../federation-bits';
import { LoadError, explain } from '../access';
import { c } from '../theme';

const TONE = { received: c.sun, under_review: c.cyan, response_due: c.orange, decision_pending: c.violet, decided: c.mint, closed: c.violetSoft, suspended: c.orange, deferred: c.violetSoft, withdrawn: c.violetSoft, unverified: c.sun, reviewed: c.mint, lodged: c.sun, upheld: c.violetSoft, dismissed: c.violetSoft, reduced: c.cyan, overturned: c.mint, remitted: c.cyan };
const STATE_LABEL = { received: 'Referral received', under_review: 'Under review', response_due: 'Response due', decision_pending: 'Decision pending', decided: 'Decided', closed: 'Closed', suspended: 'Suspended', deferred: 'Deferred', withdrawn: 'Withdrawn' };
const sTag = (s, label) => <Tag label={label ?? STATE_LABEL[s] ?? String(s).replace(/_/g, ' ')} color={TONE[s] ?? c.violetSoft} />;
const OUTCOME = { no_finding: 'No finding', finding_recorded: 'Finding recorded by the authority', no_further_action: 'No further action', withdrawn_by_authority: 'Withdrawn by the authority', other: 'Other' };
const KIND = { anti_doping: 'Anti-doping administration', match_integrity: 'Match integrity referral', betting_conflict: 'Betting / conflict declarations', accreditation_fraud: 'Accreditation or identity referral', other: 'Other authorised matter' };
const ACTION_LABEL = { start_review: 'Start review', request_response: 'Ask for a response', move_to_decision: 'Move to decision', suspend: 'Suspend', defer: 'Defer', resume: 'Resume', withdraw: 'Withdraw', close: 'Close' };
const opts = (o) => Object.entries(o).map(([value, label]) => ({ value, label }));
const WHAT = { initial: 'decision recorded', amendment: 'decision amended', reversal: 'decision reversed', appeal_outcome: 'appeal outcome recorded', lodged: 'appeal lodged', review_started: 'appeal review started', recorded: 'reference recorded', revised: 'reference revised', handoff_recorded: 'handoff recorded', reviewed: 'reviewed by a second officer', tombstoned: 'withdrawn at source', response_received: 'response received', access_granted: 'access given', access_revoked: 'access revoked' };
const dt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function useAct(reload) {
  const { toast } = useSession();
  return async (fn, ok) => { try { await fn(); if (ok) toast(ok); reload?.(); } catch (e) { toast(explain(e)); } };
}
const Notice = ({ children }) => <Banner tone={c.cyanSoft}>{children}</Banner>;

// ------------------------------------------------------------------ the tab
export function IntegrityTab({ id }) {
  const { push } = useNav();
  const [view, setView] = useState('cases');
  const body = useLoad(() => api.get(`/federation/bodies/${id}`), [id]);
  const cats = useLoad(() => api.get(`/integrity/bodies/${id}/categories`), [id]);
  const srcs = useLoad(() => api.get(`/integrity/bodies/${id}/sources`), [id]);
  if (cats.error && !cats.data) return <LoadError error={cats.error} onRetry={cats.reload} />;
  if (!cats.data || !srcs.data) return <Loading />;
  const sports = (body.data?.sports ?? []).map((s) => ({ value: s.sport_id, label: s.name ?? s.sport_name }));
  const tabs = [{ value: 'cases', label: 'Cases' }, { value: 'refs', label: 'References' }, { value: 'education', label: 'Education' }, { value: 'declarations', label: 'Declarations' }, { value: 'setup', label: 'Setup' }, { value: 'report', label: 'Report' }];
  const shared = { id, cats: cats.data, srcs: srcs.data, sports, push, reloadSetup: () => { cats.reload(); srcs.reload(); } };
  return (
    <View style={{ gap: 12 }}>
      <Notice>Strictly need-to-know. Everything you open here is recorded. A referral, an allegation or a pending test is not a finding, and SportArena does not interpret test results.</Notice>
      <Seg options={tabs} value={view} onChange={setView} />
      {view === 'cases' ? <CasesView {...shared} /> : null}
      {view === 'refs' ? <ReferencesView {...shared} /> : null}
      {view === 'education' ? <EducationView {...shared} /> : null}
      {view === 'declarations' ? <DeclarationsView {...shared} /> : null}
      {view === 'setup' ? <SetupView {...shared} /> : null}
      {view === 'report' ? <ReportView {...shared} /> : null}
    </View>
  );
}

function CasesView({ id, cats, sports, push }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const list = useLoad(() => api.get(`/integrity/bodies/${id}/cases`, { status: status ?? undefined, limit: 50 }), [id, status]);
  const act = useAct(list.reload);
  const catOptions = cats.items.map((k) => ({ value: k.id, label: k.label }));
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="All" active={!status} onPress={() => setStatus(null)} />
        {Object.entries(STATE_LABEL).map(([s, l]) => <Chip key={s} label={l} active={status === s} onPress={() => setStatus(s)} />)}
      </View>
      <Btn title="Open a case" disabled={!catOptions.length} onPress={() => setOpen(true)} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Open an integrity case" />
      {!catOptions.length ? <T size={12} color={c.mute}>Set up at least one category first (Setup tab).</T> : null}
      {!list.data ? <Loading /> : list.data.items.length ? list.data.items.map((k) => (
        <ListCard key={k.id} title={`${k.case_no} · ${k.category_label}`} sub={`${k.subject_name}${k.sport_name ? ` · ${k.sport_name}` : ''}`}
          sub2={[k.response_overdue ? 'Response overdue' : k.response_due_on && k.status === 'response_due' ? `Response due ${fmtDate(k.response_due_on)}` : null, k.decision_overdue ? 'Decision overdue' : k.decision_due_on ? `Decision by ${fmtDate(k.decision_due_on)}` : null].filter(Boolean).join(' · ')}
          status={k.status} statusLabel={k.status_label} tone={k.response_overdue || k.decision_overdue ? c.orangeSoft : undefined} onPress={() => push('IntegrityCase', { id: k.id })} />
      )) : <Empty emoji="⚖️" title="No cases" sub="Referrals and administrative references you open appear here." />}
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Open an integrity case" submitLabel="Open case" color={c.violet}
        notice="The person is told only that there is a matter to open. The notice carries no details."
        fields={[
          { key: 'category_id', label: 'Category', type: 'chips', options: catOptions },
          { key: 'subject_id', label: 'Person concerned', type: 'entity', entityKind: 'person', noun: 'person' },
          ...(sports.length ? [{ key: 'sport_id', label: 'Sport', type: 'chips', options: sports, optional: true }] : []),
          { key: 'summary', label: 'Summary (visible to officers and the panel only)', type: 'multiline' },
          { key: 'source_label', label: 'Source of the referral', optional: true, hint: 'For example the authority or report it came from' },
        ]}
        onSubmit={async (v) => { const k = await api.post(`/integrity/bodies/${id}/cases`, v); list.reload(); push('IntegrityCase', { id: k.id }); return 'Case opened'; }} />
    </View>
  );
}

function ReferencesView({ id, srcs, sports }) {
  const tests = useLoad(() => api.get(`/integrity/bodies/${id}/test-references`, { limit: 50 }), [id]);
  const ex = useLoad(() => api.get(`/integrity/bodies/${id}/exemptions`, { limit: 50 }), [id]);
  const [form, setForm] = useState(null);
  const [custody, setCustody] = useState(null);
  const reload = () => { tests.reload(); ex.reload(); };
  const act = useAct(reload);
  const src = srcs.items.map((s) => ({ value: s.id, label: `${s.name} (${s.designation.replace(/_/g, ' ')})` }));
  const verify = (type, r) => <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
    {r.verification === 'unverified' && r.current ? <Btn small title="Confirm against source" color={c.violet} onPress={() => act(() => api.post(`/integrity/references/${r.id}/review`, { type }), 'Reviewed')} accessibilityLabel={`Confirm ${r.external_ref} against the source`} /> : null}
    {r.current ? <Btn small title="Withdrawn at source" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'tomb', type, ref: r })} /> : null}
  </View>;
  return (
    <View style={{ gap: 12 }}>
      <Notice>Administrative references only: what the authoritative source supplied, exactly as supplied. Entered by hand, a reference stays unverified until a second officer confirms it. No external feed is connected yet.</Notice>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn title="Record a testing reference" disabled={!src.length} onPress={() => setForm({ kind: 'test' })} />
        <Btn title="Record an exemption" color={c.paper} ink={c.ink} disabled={!src.length} onPress={() => setForm({ kind: 'ex' })} />
      </View>
      {!src.length ? <T size={12} color={c.mute}>Name a source first (Setup tab).</T> : null}
      <Cols
        a={<Section title="Testing references" color={c.cyan}>
          {!tests.data ? <Loading /> : tests.data.items.length ? tests.data.items.map((r) => (
            <Card key={r.id} color={c.paper} pad={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="700">{r.external_ref}</T><View style={{ flexDirection: 'row', gap: 6 }}>{sTag(r.verification, r.verification === 'reviewed' ? 'Reviewed' : 'Unverified')}{r.tombstoned_at ? <Tag label="Withdrawn at source" color={c.violetSoft} /> : null}</View></View>
              <T size={12.5} color={c.mute}>{r.subject_name} · {r.source_name}{r.revision > 1 ? ` · revision ${r.revision}` : ''}</T>
              <T size={13} style={{ marginTop: 4 }}>Status as supplied: {r.external_status}{r.result_category ? ` · ${r.result_category}` : ''}</T>
              <T size={12} color={c.mute}>{[r.context.replace(/_/g, ' '), r.collected_at ? `collected ${dt(r.collected_at)}` : null, `received ${dt(r.received_at)}`].filter(Boolean).join(' · ')}</T>
              {r.custody.length ? <View style={{ marginTop: 6, gap: 2 }}>{r.custody.map((x, i) => <T key={i} size={12} color={c.mute}>↳ {x.step} · {x.actor_label} · {dt(x.occurred_at)}</T>)}</View> : null}
              <View style={{ marginTop: 8, gap: 6 }}>{verify('test_reference', r)}{r.current ? <Btn small title="Add a handoff the source reported" color={c.paper} ink={c.ink} onPress={() => setCustody(r)} style={{ alignSelf: 'flex-start' }} /> : null}</View>
            </Card>)) : <Empty emoji="🧾" title="No testing references" sub="Only what an authorised anti-doping organisation supplied is recorded here." />}
        </Section>}
        b={<Section title="Therapeutic-use exemptions" color={c.mint}>
          {!ex.data ? <Loading /> : ex.data.items.length ? ex.data.items.map((r) => (
            <Card key={r.id} color={c.paper} pad={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="700">{r.external_ref}</T><View style={{ flexDirection: 'row', gap: 6 }}>{sTag(r.verification, r.verification === 'reviewed' ? 'Reviewed' : 'Unverified')}<Tag label={r.in_force ? 'In force' : r.current ? 'Not in force' : 'Withdrawn'} color={r.in_force ? c.mint : c.violetSoft} /></View></View>
              <T size={12.5} color={c.mute}>{r.subject_name} · {r.issuing_authority}{r.revision > 1 ? ` · revision ${r.revision}` : ''}</T>
              <T size={13} style={{ marginTop: 4 }}>Status as supplied: {r.external_status}</T>
              <T size={12} color={c.mute}>{[r.valid_from || r.valid_until ? fmtRange(r.valid_from, r.valid_until) : null, r.scope_note, `last verified ${dt(r.last_verified_at)}`].filter(Boolean).join(' · ')}</T>
              <View style={{ marginTop: 8 }}>{verify('exemption', r)}</View>
            </Card>)) : <Empty emoji="📎" title="No exemptions recorded" sub="Only the authority's reference, status and validity: never a diagnosis or medication." />}
        </Section>} />
      <FormSheet visible={form?.kind === 'test'} onClose={() => setForm(null)} title="Record a testing reference" submitLabel="Record" color={c.cyan}
        notice="Enter exactly what the authority supplied. Do not add results or conclusions."
        fields={[
          { key: 'subject_id', label: 'Person', type: 'entity', entityKind: 'person', noun: 'person' },
          { key: 'source_id', label: 'Source', type: 'chips', options: src },
          { key: 'external_ref', label: 'Test or sample reference (as supplied)' },
          { key: 'testing_authority', label: 'Testing authority', optional: true },
          { key: 'collected_at', label: 'Collection date and time', type: 'datetime', optional: true },
          { key: 'context', label: 'Context', type: 'choice', options: [{ value: 'in_competition', label: 'In competition' }, { value: 'out_of_competition', label: 'Out of competition' }, { value: 'unspecified', label: 'Not stated' }], default: 'unspecified' },
          { key: 'sample_type', label: 'Sample type (only if operationally needed)', optional: true },
          { key: 'external_status', label: 'Status (as supplied)' },
          { key: 'result_category', label: 'Result category (as supplied)', optional: true },
        ]}
        onSubmit={async (v) => { const r = await api.post(`/integrity/bodies/${id}/test-references`, v); reload(); return r.replayed ? 'Already recorded: nothing changed' : 'Recorded as unverified'; }} />
      <FormSheet visible={form?.kind === 'ex'} onClose={() => setForm(null)} title="Record an exemption reference" submitLabel="Record" color={c.mint}
        notice="Reference, authority, status and validity only. Diagnosis, medication and clinical papers stay with the authority or in Health."
        fields={[
          { key: 'subject_id', label: 'Person', type: 'entity', entityKind: 'person', noun: 'person' },
          { key: 'source_id', label: 'Source', type: 'chips', options: src },
          { key: 'external_ref', label: 'Exemption reference (as supplied)' },
          { key: 'issuing_authority', label: 'Issuing authority' },
          { key: 'external_status', label: 'Status (as supplied)' },
          { key: 'valid_from', label: 'Valid from', type: 'date', optional: true },
          { key: 'valid_until', label: 'Valid until', type: 'date', optional: true },
          { key: 'scope_note', label: 'Permitted scope (if supplied)', optional: true },
        ]}
        onSubmit={async (v) => { const r = await api.post(`/integrity/bodies/${id}/exemptions`, v); reload(); return r.replayed ? 'Confirmed again: last verified updated' : 'Recorded as unverified'; }} />
      <FormSheet visible={form?.kind === 'tomb'} onClose={() => setForm(null)} title="Withdrawn at the source" submitLabel="Mark withdrawn" color={c.orange}
        notice="The record and its history stay. It stops counting as current."
        fields={[{ key: 'reason', label: 'What the source reported', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/integrity/references/${form.ref.id}/tombstone`, { type: form.type, reason: v.reason }); reload(); return 'Marked withdrawn'; }} />
      <FormSheet visible={!!custody} onClose={() => setCustody(null)} title="Add a handoff" submitLabel="Add" color={c.cyan}
        notice="Append-only. SportArena is not the laboratory chain-of-custody authority: record only what the source reported."
        fields={[
          { key: 'step', label: 'Step or status' }, { key: 'actor_label', label: 'Who or what reported it' },
          { key: 'occurred_at', label: 'When it happened', type: 'datetime' }, { key: 'external_id', label: "Source's own identifier", optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/integrity/test-references/${custody.id}/custody`, v); reload(); return 'Handoff added'; }} />
    </View>
  );
}

function EducationView({ id, sports }) {
  const list = useLoad(() => api.get(`/integrity/bodies/${id}/education`), [id]);
  const [form, setForm] = useState(null);
  const act = useAct(list.reload);
  if (!list.data) return <Loading />;
  return (
    <View style={{ gap: 12 }}>
      <Notice>Completion is a record, not proof of wider compliance, and never a score.</Notice>
      <Btn title="New requirement" onPress={() => setForm({ kind: 'req' })} style={{ alignSelf: 'flex-start' }} />
      <Cols
        a={<Section title="Requirements" color={c.mint}>
          {list.data.items.length ? list.data.items.map((r) => (
            <Card key={r.id} color={c.paper} pad={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{r.title}</T><Tag label={`v${r.version}${r.status === 'retired' ? ' · retired' : ''}`} color={c.violetSoft} /></View>
              <T size={12.5} color={c.mute}>{r.programme_title ? `${r.programme_title} · ` : ''}{r.valid_months ? `valid ${r.valid_months} months` : 'does not expire'}</T>
              <T size={13} style={{ marginTop: 4 }}>{r.assigned} assigned · {r.completed} current · {r.expired} expired</T>
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <Btn small title="Assign" color={c.violet} onPress={() => setForm({ kind: 'assign', req: r })} accessibilityLabel={`Assign ${r.title}`} />
                <Btn small title="New version" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'version', req: r })} />
              </View>
            </Card>)) : <Empty emoji="🎓" title="No requirements" sub="Define what governing policy asks people to complete." />}
        </Section>}
        b={<Section title="Still to complete" color={c.sun}>
          {list.data.outstanding.length ? list.data.outstanding.map((o) => <ListCard key={o.id} title={o.display_name} sub={o.status === 'assigned' ? 'Not completed yet' : `Expired ${fmtDate(o.expires_on)}`} />) : <Empty emoji="✅" title="Nobody outstanding" />}
        </Section>} />
      <FormSheet visible={form?.kind === 'req' || form?.kind === 'version'} onClose={() => setForm(null)} title={form?.kind === 'version' ? 'Publish a new version' : 'New requirement'} submitLabel="Save" color={c.mint}
        initial={form?.req ? { title: form.req.title, valid_months: form.req.valid_months ?? undefined } : {}}
        fields={[
          { key: 'title', label: 'Title' },
          ...(sports.length ? [{ key: 'sport_id', label: 'Applies to sport', type: 'chips', options: sports, optional: true }] : []),
          { key: 'valid_months', label: 'Valid for (months)', type: 'stepper', min: 1, max: 120, default: 12, step: 1, suffix: 'months' },
        ]}
        onSubmit={async (v) => { await api.post(`/integrity/bodies/${id}/education`, { ...v, ...(form.req ? { requirement_id: form.req.id } : {}) }); list.reload(); return 'Saved'; }} />
      <FormSheet visible={form?.kind === 'assign'} onClose={() => setForm(null)} title="Assign to people" submitLabel="Assign" color={c.violet}
        notice="People are told only that there is something to open."
        fields={[
          { key: 'all_licence_holders', label: 'Every current licence holder of this body', type: 'switch' },
          { key: 'user_id', label: 'Or one named person', type: 'entity', entityKind: 'person', noun: 'person', optional: true },
        ]}
        onSubmit={async (v) => { const r = await api.post(`/integrity/education/${form.req.id}/assign`, { all_licence_holders: v.all_licence_holders, user_ids: v.user_id ? [v.user_id] : [] }); list.reload(); return `${r.assigned} assigned${r.already_assigned ? `, ${r.already_assigned} already had it` : ''}`; }} />
    </View>
  );
}

function DeclarationsView({ id }) {
  const list = useLoad(() => api.get(`/integrity/bodies/${id}/declarations`, { limit: 50 }), [id]);
  if (!list.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      <Notice>Declared interests only, each with its purpose and retention date. No betting history is gathered, and past its retention date the content is no longer shown.</Notice>
      {list.data.items.length ? list.data.items.map((d) => (
        <Card key={d.id} color={c.paper} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="700">{d.display_name}</T><Tag label={d.status === 'withdrawn' ? 'Withdrawn' : d.retention_ended ? 'Retention ended' : d.kind === 'conflict' ? 'Conflict' : 'Betting interest'} color={d.status === 'active' && !d.retention_ended ? c.sun : c.violetSoft} /></View>
          <T size={12.5} color={c.mute}>Purpose: {d.purpose} · keep until {fmtDate(d.retain_until)}</T>
          {d.detail ? <T size={13} style={{ marginTop: 4 }}>{d.detail}</T> : null}
        </Card>)) : <Empty emoji="📝" title="No declarations" sub="People declare from My integrity once you define a betting and conflict category in Setup." />}
    </View>
  );
}

function SetupView({ id, cats, srcs, reloadSetup }) {
  const [form, setForm] = useState(null);
  return (
    <View style={{ gap: 12 }}>
      <Cols
        a={<Section title="Categories" color={c.violet} action="Add" onAction={() => setForm({ kind: 'cat' })}>
          {cats.items.length ? cats.items.map((k) => (
            <ListCard key={k.id} title={k.label} sub={`${KIND[k.kind]} · respond in ${k.response_days} days · decide in ${k.decision_days} days`} sub2={k.policy_ref ? `Policy: ${k.policy_ref}` : undefined} onPress={() => setForm({ kind: 'cat', cat: k })} label={`Edit category ${k.label}`} />
          )) : <Empty emoji="🗂️" title="No categories" sub="Safeguarding and harassment complaints stay in the safeguarding case domain." />}
        </Section>}
        b={<Section title="Sources" color={c.cyan} action="Add" onAction={() => setForm({ kind: 'src' })}>
          <T size={12} color={c.mute} style={{ marginBottom: 6 }}>{srcs.integration_note}</T>
          {srcs.items.length ? srcs.items.map((s) => <ListCard key={s.id} title={s.name} sub={`${s.designation.replace(/_/g, ' ')}${s.integration === 'blocked_awaiting_credentials' ? ' · connection blocked: no supported feed or credentials yet' : ''}`} />) : <Empty emoji="📡" title="No sources" sub="Name the authority a reference comes from." />}
        </Section>} />
      <FormSheet visible={form?.kind === 'cat'} onClose={() => setForm(null)} title={form?.cat ? 'Edit category' : 'New category'} submitLabel="Save" color={c.violet}
        initial={form?.cat ? { ...form.cat, ...Object.fromEntries(Object.entries(form.cat.state_labels ?? {}).map(([s, l]) => [`label_${s}`, l])) } : {}}
        fields={[
          { key: 'kind', label: 'Kind', type: 'chips', options: opts(KIND) },
          { key: 'label', label: 'Name' },
          { key: 'response_days', label: 'Response window', type: 'stepper', min: 1, max: 365, default: 14, step: 1, suffix: 'days' },
          { key: 'decision_days', label: 'Decision window', type: 'stepper', min: 1, max: 730, default: 30, step: 1, suffix: 'days' },
          { key: 'policy_ref', label: 'Governing policy reference', optional: true },
          { key: 's', type: 'section', label: 'Your names for each state (optional)' },
          ...Object.entries(STATE_LABEL).map(([s, l]) => ({ key: `label_${s}`, label: l, optional: true })),
        ]}
        onSubmit={async (v) => {
          const state_labels = Object.fromEntries(Object.keys(STATE_LABEL).filter((s) => v[`label_${s}`]).map((s) => [s, v[`label_${s}`]]));
          await api.post(`/integrity/bodies/${id}/categories`, { category_id: form.cat?.id, kind: v.kind, label: v.label, response_days: v.response_days, decision_days: v.decision_days, policy_ref: v.policy_ref, state_labels });
          reloadSetup(); return 'Saved';
        }} />
      <FormSheet visible={form?.kind === 'src'} onClose={() => setForm(null)} title="New source" submitLabel="Save" color={c.cyan}
        notice="Designating a source does not make hand-entered records verified. A second officer still confirms them."
        fields={[
          { key: 'name', label: 'Name of the authority or source' },
          { key: 'designation', label: 'Designation', type: 'chips', options: [{ value: 'authoritative', label: 'Authoritative' }, { value: 'verified_reference', label: 'Verified reference' }, { value: 'manual', label: 'Manual entry' }] },
          { key: 'note', label: 'Note', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/integrity/bodies/${id}/sources`, v); reloadSetup(); return 'Saved'; }} />
    </View>
  );
}

function ReportView({ id }) {
  const r = useLoad(() => api.get(`/integrity/bodies/${id}/report`), [id]);
  if (!r.data) return <Loading />;
  const d = r.data, n = (s) => d.by_status.find((x) => x.status === s)?.n ?? 0;
  return (
    <View style={{ gap: 10 }}>
      <Notice>Counts of work only. There is no ranking of people and no risk score.</Notice>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={n('received') + n('under_review') + n('response_due') + n('decision_pending')} label="Open cases" />
        <Metric value={d.overdue.responses} label="Overdue responses" tone={d.overdue.responses ? c.orangeSoft : undefined} />
        <Metric value={d.overdue.decisions} label="Overdue decisions" tone={d.overdue.decisions ? c.orangeSoft : undefined} />
        <Metric value={d.awaiting_second_review.test_refs + d.awaiting_second_review.exemptions} label="References awaiting a second review" />
        <Metric value={d.appeals_open} label="Open appeals" />
        <Metric value={`${d.education.current}/${d.education.assigned}`} label="Education current" sub={`${d.education.expired} expired`} />
      </View>
      <Section title="Open by category" color={c.violet}>{d.by_category.map((k) => <ListCard key={k.id} title={k.label} sub={KIND[k.kind]} right={<T weight="800">{k.open}</T>} />)}</Section>
      <Section title="Sporting sanction handoff" color={c.pink}>
        {d.sanction_handoff.length ? d.sanction_handoff.map((h) => <ListCard key={h.status} title={h.status === 'delivered_to_eligibility' ? 'In force in competition eligibility' : h.status.replace(/_/g, ' ')} right={<T weight="800">{h.n}</T>} />) : <Empty emoji="🤝" title="No sporting sanctions recorded" />}
      </Section>
      <Notice>{d.sync_note}</Notice>
    </View>
  );
}

// ------------------------------------------------------------------ one case
export function IntegrityCase({ id }) {
  const k = useLoad(() => api.get(`/integrity/cases/${id}`), [id]);
  const [form, setForm] = useState(null);
  const act = useAct(k.reload);
  if (k.error && !k.data) return <Screen><H1>Case</H1><LoadError error={k.error} onRetry={k.reload} /></Screen>;
  if (!k.data) return <Screen><Loading /></Screen>;
  const x = k.data, staff = x.as !== 'subject';
  const current = x.decisions.find((d) => d.current);
  const openAppeal = x.appeals.find((a) => ['lodged', 'under_review'].includes(a.status));
  return (
    <Screen wide refreshing={k.loading} onRefresh={k.reload}>
      <H1>{x.case_no}</H1>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>{sTag(x.status, x.status_label)}<Tag label={x.category_label} color={c.violetSoft} /></View>
      <View style={{ marginTop: 10 }}><Notice>{x.notice}</Notice></View>
      <T size={13} color={c.mute} style={{ marginTop: 10 }}>{[staff ? x.subject_name : null, x.sport_name, x.response_due_on && x.status === 'response_due' ? `Response due ${fmtDate(x.response_due_on)}${x.response_overdue ? ' (overdue)' : ''}` : null, x.decision_due_on && !['decided', 'closed', 'withdrawn'].includes(x.status) ? `Decision by ${fmtDate(x.decision_due_on)}` : null].filter(Boolean).join(' · ')}</T>
      {staff && x.actions.length ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {x.actions.map((a) => <Btn key={a} small title={ACTION_LABEL[a]} color={['suspend', 'defer', 'withdraw'].includes(a) ? c.paper : c.violet} ink={['suspend', 'defer', 'withdraw'].includes(a) ? c.ink : '#fff'}
          onPress={() => (['suspend', 'defer', 'withdraw', 'request_response'].includes(a) ? setForm({ kind: 'act', action: a }) : act(() => api.post(`/integrity/cases/${id}/transition`, { action: a, version: x.row_version }), 'Done'))} accessibilityLabel={ACTION_LABEL[a]} />)}
      </View> : null}
      <View style={{ marginTop: 12 }}>
        <Cols
          a={<>
            {staff ? <Card color={c.paper}><T weight="700" size={14}>Summary</T><T size={13} style={{ marginTop: 6 }}>{x.summary}</T></Card> : null}
            <Section title="Decisions" color={c.mint}>
              {x.decisions.length ? x.decisions.map((d) => (
                <Card key={d.id} color={d.current ? c.paper : c.violetSoft} pad={14}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="700">{d.seq}. {OUTCOME[d.outcome]}</T><Tag label={d.current ? 'Current' : 'Superseded'} color={d.current ? c.mint : c.violetSoft} /></View>
                  <T size={12.5} color={c.mute}>{d.kind.replace(/_/g, ' ')} · {d.authority_label} · ref {d.decision_ref}</T>
                  {d.outcome_text ? <T size={13} style={{ marginTop: 4 }}>{d.outcome_text}</T> : null}
                  <T size={12} color={c.mute}>{[d.effective_from || d.effective_to ? fmtRange(d.effective_from, d.effective_to) : null, d.scope_note, d.sporting_sanction ? (d.current ? 'Sporting sanction in force in competition eligibility' : 'Sporting sanction lifted') : null].filter(Boolean).join(' · ')}</T>
                </Card>)) : <Empty emoji="📄" title="No decision recorded" sub="Nothing is a finding until an authorised body records a decision." />}
              {x.can.decide && ['under_review', 'response_due', 'decision_pending'].includes(x.status) && !current ? <Btn title="Record the decision" onPress={() => setForm({ kind: 'decision', mode: 'initial' })} style={{ alignSelf: 'flex-start' }} /> : null}
              {x.can.decide && current ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Amend" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'decision', mode: 'amendment' })} /><Btn small title="Reverse" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'decision', mode: 'reversal' })} /></View> : null}
            </Section>
            <Section title="Appeals" color={c.pink}>
              {x.appeals.length ? x.appeals.map((a) => (
                <Card key={a.id} color={c.paper} pad={14}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700">Appeal · {fmtDate(a.created_at)}</T>{sTag(a.status, a.status.replace(/_/g, ' '))}</View>
                  <T size={13} style={{ marginTop: 4 }}>{a.grounds}</T>
                  {a.panel_label ? <T size={12} color={c.mute}>Panel: {a.panel_label}</T> : null}
                  {x.can.decide && ['lodged', 'under_review'].includes(a.status) ? <Btn small title="Review or rule" color={c.violet} onPress={() => setForm({ kind: 'ruling', appeal: a })} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
                </Card>)) : <T size={13} color={c.mute}>No appeal lodged.</T>}
              {x.can.appeal && !openAppeal ? <Btn title="Appeal the decision" color={c.pink} onPress={() => setForm({ kind: 'appeal' })} style={{ alignSelf: 'flex-start' }} /> : null}
            </Section>
          </>}
          b={<>
            <Section title={staff ? 'Responses' : 'Your responses'} color={c.cyan}>
              {x.messages.length ? x.messages.map((m) => <Card key={m.id} color={c.paper} pad={14}><T size={12} color={c.mute}>{m.author_name} · {dt(m.created_at)}</T><T size={13} style={{ marginTop: 2 }}>{m.body}</T></Card>) : <T size={13} color={c.mute}>No response yet.</T>}
              {x.can.respond ? <Btn title="Add a response" color={c.cyan} onPress={() => setForm({ kind: 'response' })} style={{ alignSelf: 'flex-start' }} /> : null}
            </Section>
            {staff ? <Section title="Who can see this case" color={c.violet}>
              {x.access.map((a) => <ListCard key={a.id} title={a.display_name} sub={`${a.role === 'panel' ? 'Panel member' : 'Reviewer'} · since ${fmtDate(a.granted_at)}`} right={x.can.manage_access ? <Btn small title="Revoke" color={c.paper} ink={c.ink} onPress={() => act(() => api.del(`/integrity/cases/${id}/access/${a.id}`), 'Access revoked')} accessibilityLabel={`Revoke ${a.display_name}`} /> : undefined} />)}
              <T size={12} color={c.mute}>Integrity officers of this body, and only the people named here.</T>
              {x.can.manage_access ? <Btn small title="Add panel member or reviewer" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'access' })} style={{ alignSelf: 'flex-start' }} /> : null}
            </Section> : null}
            <Section title="History" color={c.sun}>
              {x.history.map((h) => <T key={h.id} size={12.5} color={c.mute}>{dt(h.created_at)} · {WHAT[h.action] ?? h.action.replace(/_/g, ' ')}{h.to_status && h.subject_type === 'case' ? ` → ${STATE_LABEL[h.to_status] ?? h.to_status}` : ''}{h.actor_name && staff ? ` · ${h.actor_name}` : ''}{h.reason && staff ? ` — ${h.reason}` : ''}</T>)}
            </Section>
          </>} />
      </View>

      <FormSheet visible={form?.kind === 'act'} onClose={() => setForm(null)} title={ACTION_LABEL[form?.action] ?? ''} submitLabel="Confirm" color={c.violet}
        fields={[
          ...(form?.action === 'request_response' ? [{ key: 'response_due_on', label: 'Respond by', type: 'date', optional: true, hint: 'Leave empty to use the category window' }] : [{ key: 'reason', label: 'Reason (kept in the history)', type: 'multiline' }]),
        ]}
        onSubmit={async (v) => { await api.post(`/integrity/cases/${id}/transition`, { action: form.action, version: x.row_version, ...v }); k.reload(); return 'Done'; }} />
      <FormSheet visible={form?.kind === 'decision'} onClose={() => setForm(null)} title={{ initial: 'Record the decision', amendment: 'Amend the decision', reversal: 'Reverse the decision' }[form?.mode] ?? ''} submitLabel="Record" color={c.mint}
        notice="Record exactly what was decided and by whom. The earlier decision stays in the history."
        fields={[
          { key: 'made_by', label: 'Decided by', type: 'choice', options: [{ value: 'external_body', label: 'External body' }, { value: 'internal_panel', label: 'Internal panel' }], default: 'external_body' },
          { key: 'authority_label', label: 'Authority or panel' },
          { key: 'decision_ref', label: 'Decision reference (as issued)' },
          { key: 'outcome', label: 'Outcome', type: 'chips', options: form?.mode === 'reversal' ? opts({ no_finding: OUTCOME.no_finding, no_further_action: OUTCOME.no_further_action, withdrawn_by_authority: OUTCOME.withdrawn_by_authority, other: OUTCOME.other }) : opts(OUTCOME) },
          { key: 'outcome_text', label: 'Outcome as stated', type: 'multiline', optional: true },
          { key: 'effective_from', label: 'Effective from', type: 'date', optional: true },
          { key: 'effective_to', label: 'Effective until', type: 'date', optional: true, hint: 'Leave empty if open-ended' },
          { key: 'scope_note', label: 'Scope', optional: true },
          { key: 'sporting_sanction', label: 'Hand a sporting sanction to competition eligibility', type: 'switch', show: (v) => v.outcome === 'finding_recorded' },
        ]}
        onSubmit={async (v) => { await api.post(`/integrity/cases/${id}/decisions`, { ...v, kind: form.mode, version: x.row_version }); k.reload(); return 'Decision recorded'; }} />
      <FormSheet visible={form?.kind === 'response'} onClose={() => setForm(null)} title="Your response" submitLabel="Send" color={c.cyan}
        notice="Only the integrity officers and panel for this case can read it."
        fields={[{ key: 'body', label: 'Your response', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/integrity/cases/${id}/response`, v); k.reload(); return 'Response sent'; }} />
      <FormSheet visible={form?.kind === 'appeal'} onClose={() => setForm(null)} title="Appeal the decision" submitLabel="Lodge appeal" color={c.pink}
        notice="Your grounds are visible only to the officers and panel reviewing the appeal."
        fields={[{ key: 'grounds', label: 'Your grounds', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/integrity/cases/${id}/appeals`, v); k.reload(); return 'Appeal lodged'; }} />
      <FormSheet visible={form?.kind === 'access'} onClose={() => setForm(null)} title="Give access to this case" submitLabel="Give access" color={c.violet}
        notice="Access is for this one case and can be revoked at any time."
        fields={[{ key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', noun: 'person' }, { key: 'role', label: 'Role', type: 'choice', options: [{ value: 'panel', label: 'Panel member (can decide)' }, { value: 'reviewer', label: 'Reviewer (read only)' }], default: 'reviewer' }]}
        onSubmit={async (v) => { await api.post(`/integrity/cases/${id}/access`, v); k.reload(); return 'Access given'; }} />
      <FormSheet visible={form?.kind === 'ruling'} onClose={() => setForm(null)} title="Review the appeal" submitLabel="Confirm" color={c.violet}
        notice="Someone who did not make the original decision must review it. A person decides, never the system."
        fields={[
          { key: 'action', label: 'Step', type: 'chips', options: [{ value: 'start_review', label: 'Start review' }, { value: 'upheld', label: 'Decision upheld' }, { value: 'dismissed', label: 'Appeal dismissed' }, { value: 'reduced', label: 'Reduced' }, { value: 'overturned', label: 'Overturned' }, { value: 'remitted', label: 'Remit for review' }] },
          { key: 'panel_label', label: 'Panel', optional: true },
          { key: 'reason', label: 'Reason', type: 'multiline', optional: true },
          { key: 'authority_label', label: 'Authority for the new decision', optional: true, show: (v) => ['reduced', 'overturned'].includes(v.action) },
          { key: 'decision_ref', label: 'New decision reference', optional: true, show: (v) => ['reduced', 'overturned'].includes(v.action) },
          { key: 'effective_from', label: 'Reduced sanction from', type: 'date', optional: true, show: (v) => v.action === 'reduced' },
          { key: 'effective_to', label: 'Reduced sanction until', type: 'date', optional: true, show: (v) => v.action === 'reduced' },
        ]}
        onSubmit={async (v) => {
          const body = { action: v.action, panel_label: v.panel_label, reason: v.reason };
          if (['reduced', 'overturned'].includes(v.action)) body.decision = { made_by: 'internal_panel', authority_label: v.authority_label, decision_ref: v.decision_ref, outcome: v.action === 'overturned' ? 'no_finding' : 'finding_recorded', effective_from: v.effective_from, effective_to: v.effective_to, sporting_sanction: v.action === 'reduced' };
          await api.post(`/integrity/appeals/${form.appeal.id}/ruling`, body); k.reload(); return 'Recorded';
        }} />
    </Screen>
  );
}

// ------------------------------------------------------------------ the person concerned
export function MyIntegrity() {
  const { push } = useNav();
  const me = useLoad(() => api.get('/me/integrity'), []);
  const kids = useLoad(() => api.get('/youth/guardian-links', { as: 'guardian', status: 'active', limit: 50 }).catch(() => []), []);
  const act = useAct(me.reload);
  const [declare, setDeclare] = useState(false);
  const [body, setBody] = useState(null);
  if (me.error && !me.data) return <Screen><H1>My integrity</H1><LoadError error={me.error} onRetry={me.reload} /></Screen>;
  if (!me.data) return <Screen><Loading /></Screen>;
  const d = me.data;
  const empty = !d.cases.length && !d.exemptions.length && !d.education.length && !d.declarations.length;
  return (
    <Screen wide refreshing={me.loading} onRefresh={me.reload}>
      <H1>My integrity</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>Notices from the governing bodies of your sport, your exemption status as the authority supplied it, education you are asked to complete and declarations you have made. Only you{(kids.data ?? []).length ? ' and your verified guardians' : ''} can see this.</T>
      <View style={{ marginTop: 10 }}><Notice>{d.notice}</Notice></View>
      <Section title="Make a declaration" color={c.violet}>
        <BodyPicker label="Governing body that asked for it" value={body} onChange={setBody} />
        <Btn title="Make a declaration" color={c.violet} disabled={!body} onPress={() => setDeclare(true)} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Make a declaration to the chosen governing body" />
      </Section>
      {empty ? <View style={{ marginTop: 16 }}><Empty emoji="🛡️" title="Nothing to show" sub="You have no open matters, exemptions or education requirements." /></View> : null}
      {d.cases.length ? <Section title="Matters" color={c.violet}>{d.cases.map((k) => <ListCard key={k.id} title={`${k.case_no} · ${k.category_label}`} sub={[k.status === 'response_due' && k.response_due_on ? `Please respond by ${fmtDate(k.response_due_on)}` : null].filter(Boolean).join(' · ') || undefined} status={k.status} statusLabel={k.status_label} onPress={() => push('IntegrityCase', { id: k.id })} />)}</Section> : null}
      {d.exemptions.length ? <Section title="Exemptions" color={c.mint}>{d.exemptions.map((e) => <ListCard key={e.id} title={`${e.issuing_authority}: ${e.external_status}`} sub={[e.body_name, fmtRange(e.valid_from, e.valid_until), e.scope_note].filter(Boolean).join(' · ')} sub2={`Last verified ${dt(e.last_verified_at)}`} />)}</Section> : null}
      {d.education.length ? <Section title="Education" color={c.sun}>{d.education.map((e) => (
        <ListCard key={e.id} title={e.title} sub={`${e.body_name} · version ${e.version}`} sub2={e.status === 'completed' ? `Completed ${fmtDate(e.completed_on)}${e.expires_on ? ` · ${e.expired ? 'expired' : 'valid until'} ${fmtDate(e.expires_on)}` : ''}` : 'Not completed yet'}
          right={e.status === 'assigned' || e.expired ? <Btn small title="Mark complete" color={c.violet} onPress={() => act(() => api.post(`/integrity/education-records/${e.id}/complete`, {}), 'Recorded')} accessibilityLabel={`Mark ${e.title} complete`} /> : undefined} />))}</Section> : null}
      {d.declarations.length ? <Section title="My declarations" color={c.cyan}>{d.declarations.map((x) => (
        <ListCard key={x.id} title={`${x.kind === 'conflict' ? 'Conflict' : 'Betting interest'} · ${x.body_name}`} sub={`Purpose: ${x.purpose} · kept until ${fmtDate(x.retain_until)}`} status={x.status === 'active' ? 'received' : 'withdrawn'} statusLabel={x.status === 'active' ? 'Active' : 'Withdrawn'}
          right={x.status === 'active' ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/integrity/declarations/${x.id}/withdraw`), 'Withdrawn')} accessibilityLabel="Withdraw this declaration" /> : undefined} />))}</Section> : null}
      <FormSheet visible={declare} onClose={() => setDeclare(false)} title="Make a declaration" submitLabel="Declare" color={c.violet}
        notice={`To ${body?.name ?? 'the governing body'}. Declare only what it asks for. Only you and its integrity officers can read it, and it is hidden after the retention date you choose.`}
        fields={[
          { key: 'kind', label: 'What are you declaring', type: 'choice', options: [{ value: 'conflict', label: 'A conflict of interest' }, { value: 'betting_interest', label: 'A betting interest' }], default: 'conflict' },
          { key: 'purpose', label: 'Why (the purpose)' },
          { key: 'detail', label: 'Details', type: 'multiline' },
          { key: 'retain_until', label: 'Keep until', type: 'date' },
        ]}
        onSubmit={async (v) => { await api.post(`/integrity/bodies/${body.id}/declarations`, { kind: v.kind, purpose: v.purpose, detail: v.detail, retain_until: v.retain_until }); me.reload(); return 'Declaration recorded'; }} />
    </Screen>
  );
}
