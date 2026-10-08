import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';

const STATE = { open: ['Open', c.sunSoft], in_progress: ['In progress', c.cyanSoft], awaiting_user: ['Needs your reply', c.orangeSoft], escalated: ['Escalated', c.pinkSoft], resolved: ['Resolved', c.lime], withdrawn: ['Withdrawn', c.violetSoft] };
const SLA = { breached: ['SLA breached', c.pinkSoft], at_risk: ['SLA at risk', c.orangeSoft] };
const stateTag = (s) => <Tag label={STATE[s]?.[0] ?? s} color={STATE[s]?.[1]} />;
const when = (d) => (d ? new Date(d).toLocaleString() : '');
const label = (s) => String(s).replace(/_/g, ' ');

/** The new-ticket / new-dispute form. `links` pre-fills the record a case is about (e.g. from an invoice). */
export function NewCaseSheet({ visible, onClose, kind: kind0 = 'support', links = [], onDone }) {
  const cats = useLoad(() => api.get('/cases/categories'), []);
  const options = (k) => (cats.data?.kinds[k] ?? []).map((x) => ({ value: x, label: label(x) }));
  return (
    <FormSheet visible={visible} onClose={onClose} title={kind0 === 'dispute' ? 'Raise a dispute' : 'Contact support'} submitLabel="Send"
      fields={[
        { key: 'kind', label: 'What is this?', type: 'choice', options: [{ value: 'support', label: 'Question / problem' }, { value: 'dispute', label: 'Dispute' }], default: kind0 },
        { key: 'category', label: 'Category', type: 'chips', options: options('support'), show: (v) => v.kind === 'support' },
        { key: 'category_d', label: 'Category', type: 'chips', options: options('dispute'), show: (v) => v.kind === 'dispute' },
        { key: 'subject', label: 'Subject' },
        { key: 'description', label: 'What happened?', type: 'multiline', hint: 'Do not include passwords or card numbers.' },
        { key: 'priority', label: 'How urgent?', type: 'choice', options: [{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }], default: 'normal' },
        { key: 'contact_channel', label: 'Tell me about updates by', type: 'choice', options: [{ value: 'in_app', label: 'In app' }, { value: 'email', label: 'Email' }, { value: 'push', label: 'Push' }], default: 'in_app' },
        { key: 'reference', label: 'Evidence link (optional)', optional: true, hint: 'An https:// link to a screenshot, receipt or document.' },
        { key: 'amount', label: 'Disputed amount (optional)', type: 'number', optional: true, show: (v) => v.kind === 'dispute' },
      ]}
      onSubmit={async (v) => {
        const body = { kind: v.kind, category: v.kind === 'dispute' ? v.category_d : v.category, subject: v.subject, description: v.description, priority: v.priority, contact_channel: v.contact_channel, links, evidence: v.reference ? [{ reference: v.reference }] : [] };
        if (v.kind === 'dispute' && v.amount) body.details = { disputed_amount_cents: Math.round(v.amount * 100) };
        const r = await api.post('/cases', body);
        onDone?.(r);
        return `Case #${r.case_no} created`;
      }} />
  );
}

function Thread({ x }) {
  return <>
    {x.thread.map((m) => (
      <Card key={m.id} color={m.visibility === 'internal' ? c.sunSoft : m.kind === 'info_request' ? c.orangeSoft : c.violetSoft} pad={12}>
        <T size={12} color={c.mute}>{m.author} · {when(m.created_at)}{m.visibility === 'internal' ? ' · internal note' : ''}{m.kind === 'info_request' ? ' · information requested' : ''}</T>
        <T>{m.body}</T>
      </Card>
    ))}
    <T weight="800" size={13}>Timeline</T>
    {x.history.map((h, i) => <T key={i} size={12} color={c.mute}>{when(h.created_at)} · {h.actor} · {label(h.action)}{h.reason ? ` — ${h.reason}` : ''}</T>)}
  </>;
}

function CaseSheet({ id, onClose, onChange, staff }) {
  const { user, toast } = useSession();
  const d = useLoad(() => (id ? api.get(`/cases/${id}`) : Promise.resolve(null)), [id]);
  const [text, setText] = useState('');
  const [ev, setEv] = useState(null);
  const x = d.data;
  const run = async (fn, msg) => { try { await fn(); toast(msg); setText(''); d.reload(); onChange(); } catch (e) { toast(e.message); } };
  const active = x && ['open', 'in_progress', 'awaiting_user', 'escalated'].includes(x.status);
  const own = x && x.requester_id === user.id;
  const act = (name, body) => api.post(`/admin/cases/${id}/${name}`, body);
  return (
    <Sheet visible={!!id} onClose={() => { setEv(null); onClose(); }} title={x ? `Case #${x.case_no} · ${label(x.category)}` : 'Case'}>
      {d.loading && !x ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : x ? <>
        <T weight="800">{x.subject}</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {stateTag(x.status)}<Tag label={x.kind} color={c.cyanSoft} />{x.priority !== 'normal' ? <Tag label={x.priority} color={c.sunSoft} /> : null}
          {staff && SLA[x.sla_state] ? <Tag label={SLA[x.sla_state][0]} color={SLA[x.sla_state][1]} /> : null}
        </View>
        {staff ? <T size={12} color={c.mute}>From {x.requester}{x.assignee ? ` · assigned to ${x.assignee}` : ' · unassigned'} · first reply due {when(x.first_response_due)} · resolve by {when(x.resolution_due)}</T> : null}
        {x.links.length ? <T size={12} color={c.mute}>About: {x.links.map((l) => `${label(l.entity_type)} ${l.entity_id.slice(0, 8)}`).join(', ')}</T> : null}
        {x.details?.disputed_amount_cents ? <T size={12} color={c.mute}>Disputed amount: {(x.details.disputed_amount_cents / 100).toFixed(2)} {x.details.currency ?? ''}</T> : null}
        {x.resolution ? <Card color={c.mintSoft} pad={12}><T weight="800" size={13}>Outcome</T><T>{x.resolution}</T></Card> : null}
        <Thread x={x} />
        {x.evidence.length ? <T size={12} color={c.mute}>{x.evidence.length} evidence item(s) on file{staff ? '' : ' — only the support team can open them'}</T> : null}
        {staff && own === false && x.evidence.length ? (ev
          ? ev.map((e) => <T key={e.id} size={12} selectable>{e.label ?? 'Evidence'}: {e.reference ?? e.file_name}</T>)
          : <Btn small title="Show evidence (audit-logged)" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => run(async () => setEv(await api.get(`/admin/cases/${id}/evidence`)), 'Evidence opened and logged')} />) : null}

        {active ? <Field label={staff && !own ? 'Reply / note / outcome' : 'Reply'} value={text} onChangeText={setText} multiline /> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {active && own ? <Btn title="Send reply" color={c.pink} disabled={!text.trim()} onPress={() => run(() => api.post(`/cases/${id}/replies`, { body: text }), 'Sent')} /> : null}
          {active && own ? <Btn title="Withdraw" color={c.paper} ink={c.red} onPress={() => run(() => api.post(`/cases/${id}/withdraw`, {}), 'Withdrawn')} /> : null}
          {x.status === 'resolved' && own ? <Btn title="Reopen" color={c.pink} disabled={text.trim().length < 5} onPress={() => run(() => api.post(`/cases/${id}/reopen`, { reason: text }), 'Reopened')} /> : null}
          {staff && active && !own ? <>
            <Btn small title="Take it" color={c.violet} onPress={() => run(() => act('triage', {}), 'Assigned to you')} />
            <Btn small title="Reply" color={c.pink} disabled={!text.trim()} onPress={() => run(() => act('respond', { body: text }), 'Sent')} />
            <Btn small title="Ask for info" color={c.sun} ink={c.ink} disabled={!text.trim()} onPress={() => run(() => act('respond', { body: text, request_info: true }), 'Asked')} />
            <Btn small title="Internal note" color={c.violet} disabled={!text.trim()} onPress={() => run(() => act('notes', { body: text }), 'Note saved')} />
            <Btn small title="Escalate" color={c.paper} ink={c.red} disabled={text.trim().length < 5} onPress={() => run(() => act('escalate', { reason: text }), 'Escalated')} />
            <Btn small title="Resolve" color={c.mint} ink={c.ink} disabled={text.trim().length < 5} onPress={() => run(() => act('resolve', { resolution: text }), 'Resolved')} />
          </> : null}
        </View>
        {staff && active && !own ? <T size={12} color={c.mute}>Refunds, cancellations and other changes are made with their own actions on the booking / payment, then described in the outcome. This screen never changes them.</T> : null}
      </> : null}
    </Sheet>
  );
}

/** Pushed screen: my tickets and disputes. */
export function Support() {
  const [kind, setKind] = useState('');
  const list = useLoad(() => api.get('/me/cases', { ...(kind ? { kind } : {}), limit: 100 }), [kind]);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(false);
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Support & disputes</H1>
      <T size={13} color={c.mute}>Ask a question, report a problem, or dispute a booking, payment or recorded result. You can follow every step here.</T>
      <Btn title="New case" color={c.pink} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start', marginVertical: 8 }} />
      <Seg options={[{ value: '', label: 'All' }, { value: 'support', label: 'Tickets' }, { value: 'dispute', label: 'Disputes' }]} value={kind} onChange={setKind} color={c.violet} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data?.length ? list.data.map((cs) => (
        <Row key={cs.id} onPress={() => setOpen(cs.id)} title={`#${cs.case_no} ${cs.subject}`} sub={`${label(cs.category)} · ${when(cs.created_at)}`} right={stateTag(cs.status)} />
      )) : <Empty emoji="💬" title="No cases yet" sub="When you contact support or raise a dispute it shows up here." />}
      <NewCaseSheet visible={form} onClose={() => setForm(false)} onDone={(r) => { list.reload(); setOpen(r.id); }} />
      <CaseSheet id={open} onClose={() => setOpen(null)} onChange={list.reload} />
    </Screen>
  );
}

/** Platform team queue (admin). */
export function CaseQueue() {
  const [f, setF] = useState({ status: 'active', kind: '', sla: '', assignee: '', q: '' });
  const q = useLoad(() => api.get('/admin/cases', { limit: 100, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }), [JSON.stringify(f)]);
  const [open, setOpen] = useState(null);
  const set = (k) => (v) => setF({ ...f, [k]: v });
  const opts = (arr) => arr.map(([value, l]) => ({ value, label: l }));
  return (
    <Section title="Support queue (platform team)" color={c.cyan}>
      <Seg options={opts([['active', 'Active'], ['resolved', 'Resolved'], ['withdrawn', 'Withdrawn']])} value={f.status} onChange={set('status')} color={c.violet} />
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {[['', 'Any kind'], ['support', 'Tickets'], ['dispute', 'Disputes']].map(([v, l]) => <Chip key={v} label={l} active={f.kind === v} onPress={() => set('kind')(v)} />)}
        {[['', 'Any SLA'], ['breached', 'Breached'], ['at_risk', 'At risk']].map(([v, l]) => <Chip key={v} label={l} active={f.sla === v} onPress={() => set('sla')(v)} />)}
        {[['', 'Anyone'], ['me', 'Mine'], ['unassigned', 'Unassigned']].map(([v, l]) => <Chip key={v} label={l} active={f.assignee === v} onPress={() => set('assignee')(v)} />)}
      </View>
      <Field value={f.q} onChangeText={set('q')} placeholder="Search subject or case number…" />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : q.data?.length ? q.data.map((cs) => (
        <Row key={cs.id} onPress={() => setOpen(cs.id)} title={`#${cs.case_no} ${cs.subject}`} sub={`${cs.requester} · ${cs.kind} · ${label(cs.category)} · ${cs.priority}${cs.assignee ? ` · ${cs.assignee}` : ''}`}
          right={<View style={{ gap: 4, alignItems: 'flex-end' }}>{stateTag(cs.status)}{SLA[cs.sla_state] ? <Tag label={SLA[cs.sla_state][0]} color={SLA[cs.sla_state][1]} /> : null}</View>} />
      )) : <Empty emoji="📭" title="Nothing here" />}
      <CaseSheet id={open} staff onClose={() => setOpen(null)} onChange={q.reload} />
    </Section>
  );
}
