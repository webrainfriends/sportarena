// Federation governance at scale (#525): the Governance tab of Federation Home. One place for the hierarchy dashboard (definition-backed, drillable,
// small cells hidden), maker-checker approvals and rules, delegated administration and the periodic access review. Every number and permission comes
// from the API (REST / OpenAPI / MCP share the capabilities); this only shows what it returns and hides what a role cannot use.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Empty, Loading, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { LoadError, explain } from '../access';
import { c } from '../theme';
import { Metric, StatusTag, LEVEL_LABEL, ROLE_LABEL, ROLE_HELP, fmtDate, ago } from '../federation-ui';
import { Bar, Cols, ListCard, Pager, SwitchRow } from '../federation-bits';
import { ReasonSheet } from './federation-gov';

const SUB = [['dashboard', 'Dashboard'], ['approvals', 'Approvals'], ['delegation', 'Delegation'], ['access', 'Access review']];
const STATE_TONE = { pending: 'pending', approved: 'approved', rejected: 'rejected', cancelled: 'cancelled', expired: 'expired' };
const HIDDEN = '<5';
const ACTION = { affiliation_approve: 'Approve an affiliation', affiliation_suspend: 'Suspend an affiliation', eligibility_override: 'Approve over a failed requirement', credential_exception: 'Issue a licence over a failed requirement', sanction_approve: 'Sanction a competition', policy_publish: 'Publish a requirement version', bulk_export: 'Export a report as a file' };

// ------------------------------------------------------------------ dashboard
const CARD_METRICS = [['affiliations_in_force', 'Affiliations'], ['organisations', 'Organisations'], ['athletes', 'Athletes'], ['licences_good_standing', 'Licences'], ['credential_health_pct', 'Credential health', '%'], ['sanctions_in_force', 'Competitions sanctioned'], ['awaiting_decision', 'Awaiting a decision'], ['exceptions', 'Over a failed requirement']];
const DRILLABLE = new Set(['affiliations_in_force', 'organisations', 'sanctions_in_force', 'awaiting_decision', 'exceptions']);

function DrillSheet({ id, drill, sportId, onClose }) {
  const [offset, setOffset] = useState(0);
  const res = useLoad(() => (drill ? api.get(`/federation/bodies/${id}/rollup/records`, { metric: drill.metric, node_id: drill.node_id, sport_id: sportId || undefined, limit: 20, offset }) : Promise.resolve(null)), [id, drill?.metric, drill?.node_id, sportId, offset]);
  const d = res.data;
  return (
    <Sheet visible={!!drill} onClose={() => { setOffset(0); onClose(); }} title={drill?.label ?? 'Records'}>
      {res.error ? <LoadError error={res.error} onRetry={res.reload} /> : !d ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <T size={12} color={c.mute}>{d.definition}</T>
          {d.rows.length ? d.rows.map((r) => <ListCard key={r.record_id} title={r.label} sub={[r.number, r.body_name].filter(Boolean).join(' · ')} sub2={r.ends_on ? `Until ${fmtDate(r.ends_on)}` : undefined} status={r.status} />) : <Empty emoji="📭" title="Nothing behind this number" />}
          <Pager total={d.total} offset={offset} limit={20} onOffset={setOffset} busy={res.loading} />
        </View>)}
    </Sheet>
  );
}

function NodeCard({ row, onDrill }) {
  const cell = (key, label, suffix = '') => {
    const hidden = row.suppressed?.includes(key);
    const v = hidden ? HIDDEN : row[key] == null ? '–' : `${row[key]}${suffix}`;
    const press = DRILLABLE.has(key) && !hidden && row[key] ? () => onDrill(key, label, row) : undefined;
    return <Metric key={key} value={v} label={label} onPress={press} sub={hidden ? 'hidden: fewer than 5 people' : undefined} />;
  };
  return (
    <Card color={row.own ? c.mintSoft : c.paper}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <T weight="800" size={16}>{row.name}</T>
          <T size={12} color={c.mute}>{LEVEL_LABEL[row.level] ?? row.level}{row.own ? ' · this body only' : row.bodies > 1 ? ` · with ${row.bodies - 1} below` : ''}</T>
        </View>
        {row.affiliations_expiring || row.licences_expiring ? <Tag label={`${(row.affiliations_expiring ?? 0) + (row.licences_expiring ?? 0)} ending in 60 days`} color={c.sunSoft} /> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>{CARD_METRICS.map(([k, l, s]) => cell(k, l, s))}</View>
    </Card>
  );
}

const MEASURES = [['affiliations', 'Affiliations'], ['licences', 'Licences'], ['sanctions', 'Sanctions']];
const GROUPS = [['level', 'Body level'], ['country', 'Country'], ['region', 'Region'], ['state', 'State'], ['district', 'District'], ['sport', 'Sport'], ['season', 'Season'], ['status', 'Standing']];
const STATES = [['', 'Any standing'], ['in_force', 'In force'], ['suspended', 'Suspended'], ['expiring', 'Ending in 60 days'], ['expired', 'Expired']];

function AggregateBuilder({ id, sportId }) {
  const [measure, setMeasure] = useState('affiliations');
  const [group, setGroup] = useState('level');
  const [state, setState] = useState('');
  const res = useLoad(() => api.get(`/federation/bodies/${id}/aggregate`, { measure, group_by: group, credential_state: state || undefined, sport_id: sportId || undefined }), [id, measure, group, state, sportId]);
  const d = res.data;
  const max = Math.max(1, ...(d?.rows ?? []).map((r) => r.count ?? 0));
  return (
    <Card>
      <T weight="800" size={15}>Aggregate report</T>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>Totals only. People are counted, never listed; cells under 5 are hidden and youth are never shown separately.</T>
      <View style={{ gap: 10, marginTop: 10 }}>
        <Seg options={MEASURES.map(([value, label]) => ({ value, label }))} value={measure} onChange={setMeasure} />
        <MenuField label="Group by" value={group} onChange={setGroup} options={GROUPS.map(([value, label]) => ({ value, label }))} />
        <MenuField label="Standing" value={state} onChange={setState} options={STATES.map(([value, label]) => ({ value, label }))} />
      </View>
      <View style={{ gap: 10, marginTop: 12 }}>
        {res.error ? <LoadError error={res.error} onRetry={res.reload} /> : !d ? <Loading /> : d.rows.length ? (
          <>
            {d.rows.map((r) => <Bar key={r.key} label={String(r.key).replace(/_/g, ' ')} value={r.suppressed ? HIDDEN : r.count} max={max} />)}
            <T size={12} color={c.mute}>{d.total != null ? `Total ${d.total} ${d.unit}` : 'Total withheld while a cell is hidden'} · {d.bodies} bod{d.bodies === 1 ? 'y' : 'ies'}</T>
          </>) : <Empty emoji="📊" title="Nothing matches" />}
      </View>
    </Card>
  );
}

function Dashboard({ id, home }) {
  const [sportId, setSportId] = useState('');
  const [drill, setDrill] = useState(null);
  const res = useLoad(() => api.get(`/federation/bodies/${id}/rollup`, { sport_id: sportId || undefined }), [id, sportId]);
  const [defs, setDefs] = useState(false);
  const d = res.data;
  const sports = home.breakdown?.by_sport ?? [];
  return (
    <View style={{ gap: 12 }}>
      {sports.length > 1 ? <MenuField label="Sport" value={sportId} onChange={setSportId} options={[{ value: '', label: 'All sports' }, ...sports.map((s) => ({ value: s.sport_id, label: s.sport_name }))]} /> : null}
      {res.error ? <LoadError error={res.error} onRetry={res.reload} /> : !d ? <Loading /> : (
        <>
          <Cols
            a={<Section title="This body and the bodies directly beneath it" color={c.mint}>
              {d.rows.map((r) => <NodeCard key={r.body_id} row={r} onDrill={(metric, label, row) => setDrill({ metric, label: `${label} · ${row.name}`, node_id: row.own ? undefined : row.body_id })} />)}
            </Section>}
            b={<AggregateBuilder id={id} sportId={sportId} />} />
          <SwitchRow label="Show how every number is defined" sub={`${Object.keys(d.definitions).length} published definitions`} value={defs} onChange={setDefs} />
          {defs ? <View style={{ gap: 8 }}>{Object.entries(d.definitions).map(([k, m]) => <Card key={k}><T weight="700" size={14}>{m.label}</T><T size={12} color={c.mute}>{m.definition}</T></Card>)}</View> : null}
        </>)}
      <DrillSheet id={id} drill={drill} sportId={sportId} onClose={() => setDrill(null)} />
    </View>
  );
}

// ------------------------------------------------------------------ approvals
function Rules({ id, admin }) {
  const { toast } = useSession();
  const rules = useLoad(() => api.get(`/federation/bodies/${id}/approval-rules`), [id]);
  const [change, setChange] = useState(null);
  return (
    <Section title="Actions that need a second person" color={c.violet}>
      {rules.error ? <LoadError error={rules.error} onRetry={rules.reload} /> : !rules.data ? <Loading /> : (
        <Card>
          {rules.data.map((r) => (
            <View key={r.action} style={{ paddingVertical: 4 }}>
              <SwitchRow label={r.label} value={r.required} onChange={admin && !(r.required && r.inherited) ? (v) => setChange({ action: r.action, required: v, label: r.label }) : () => toast(r.inherited ? `Required by ${r.source_name}; a body beneath it cannot relax it` : 'Only the body\'s owners and admins change this')}
                sub={r.required ? (r.inherited ? `Required by ${r.source_name}` : 'Required here') : 'Not required'} />
            </View>))}
        </Card>)}
      <ReasonSheet visible={!!change} onClose={() => setChange(null)} title={change?.required ? 'Require a second person' : 'Stop requiring a second person'} body={change?.label} confirm={change?.required ? 'Require' : 'Stop requiring'}
        onConfirm={async (reason) => { try { await api.post(`/federation/bodies/${id}/approval-rules`, { action: change.action, required: change.required, reason }); toast('Rule saved'); rules.reload(); } catch (e) { toast(explain(e)); } }} />
    </Section>
  );
}

function Requests({ id, me }) {
  const { toast } = useSession();
  const [view, setView] = useState('awaiting');
  const q = view === 'awaiting' ? { awaiting_me: true } : view === 'mine' ? { mine: true } : {};
  const list = useLoad(() => api.get(`/federation/bodies/${id}/approvals`, { ...q, limit: 30 }), [id, view]);
  const [decide, setDecide] = useState(null);
  const act = async (fn, msg) => { try { await fn(); toast(msg); list.reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Section title="Approval requests" color={c.pink}>
      <Seg options={[{ value: 'awaiting', label: 'Waiting for me' }, { value: 'mine', label: 'I asked' }, { value: 'all', label: 'All' }]} value={view} onChange={setView} />
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((a) => (
        <Card key={a.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T weight="800" size={14} style={{ flex: 1 }}>{ACTION[a.action] ?? a.action}</T>
            <StatusTag status={STATE_TONE[a.state] ?? a.state} label={a.state === 'approved' && a.used ? 'Approved · used' : undefined} />
          </View>
          <T size={13} style={{ marginTop: 4 }}>{a.summary}</T>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>{a.body_name} · asked by {a.requested_by_name} {ago(a.requested_at)}{a.decided_by_name ? ` · ${a.state} by ${a.decided_by_name}` : ''}</T>
          {a.rule_body_id !== a.body_id ? <T size={12} color={c.mute}>Required by {a.rule_body_name}</T> : null}
          {a.decision_reason ? <T size={12} style={{ marginTop: 2 }}>{a.decision_reason}</T> : null}
          {a.state === 'pending' ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {a.requested_by !== me.user_id ? <>
                <Btn small title="Approve" onPress={() => act(() => api.post(`/federation/approvals/${a.id}/decision`, { decision: 'approve' }), 'Approved')} accessibilityLabel={`Approve ${a.action.replace(/_/g, ' ')}`} />
                <Btn small title="Reject" color={c.paper} ink={c.ink} onPress={() => setDecide(a)} accessibilityLabel={`Reject ${a.action.replace(/_/g, ' ')}`} />
              </> : <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/federation/approvals/${a.id}/cancel`, {}), 'Withdrawn')} />}
            </View>) : null}
        </Card>)) : <Empty emoji="🤝" title={view === 'awaiting' ? 'Nothing waiting for you' : 'No requests'} sub="High-impact actions the body has marked as needing two people appear here." />}
      <ReasonSheet visible={!!decide} onClose={() => setDecide(null)} title="Reject this request" body={decide?.summary} confirm="Reject" danger
        onConfirm={async (reason) => act(() => api.post(`/federation/approvals/${decide.id}/decision`, { decision: 'reject', reason }), 'Rejected')} />
    </Section>
  );
}

// ------------------------------------------------------------------ delegation
function Delegation({ id, me, body }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/federation/bodies/${id}/delegations`, { limit: 50 }), [id]);
  const [add, setAdd] = useState(false);
  const [revoke, setRevoke] = useState(null);
  const sports = body?.sports ?? [];
  return (
    <Section title="Delegated administration" color={c.cyan}>
      <T size={12.5} color={c.mute}>Give one role, for this body and the bodies beneath it down to a depth you choose. It never reaches sibling bodies or the bodies above, cannot be passed on, ends on its date and can be withdrawn at once.</T>
      {me.admin ? <Btn small title="Delegate a role" onPress={() => setAdd(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((d) => (
        <ListCard key={d.id} title={d.display_name} sub={`${ROLE_LABEL[d.role] ?? d.role} · ${d.max_depth === 0 ? 'this body only' : `${d.max_depth} level${d.max_depth > 1 ? 's' : ''} below`}${d.sport_name ? ` · ${d.sport_name}` : ''}`}
          sub2={`${d.reason}${d.expires_on ? ` · until ${fmtDate(d.expires_on)}` : ''}`} status={d.in_force ? 'active' : 'ended'} statusLabel={d.in_force ? 'In force' : d.status === 'revoked' ? 'Withdrawn' : 'Expired'}
          right={me.admin && d.status === 'active' ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => setRevoke(d)} accessibilityLabel={`Withdraw ${d.display_name}'s delegation`} /> : undefined} />)) : <Empty emoji="🧭" title="No delegations" sub="Roles you give to people on this body directly are under Setup; this is for administration that reaches the bodies beneath." />}
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Delegate a role" submitLabel="Delegate" initial={{ role: 'registrar', max_depth: 1 }}
        fields={[{ key: 'user_id', label: 'Person', type: 'entity', noun: 'person' },
          { key: 'role', label: 'Role', type: 'chips', options: Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })), hint: ROLE_HELP.registrar },
          { key: 'max_depth', label: 'Levels below this body', type: 'stepper', min: 0, max: 6, step: 1, hint: '0 = this body only. 1 adds the bodies recognised directly beneath it.' },
          ...(sports.length > 1 ? [{ key: 'sport_id', label: 'Only for one sport (optional)', type: 'chips', options: sports.map((s) => ({ value: s.sport_id, label: s.sport_name })), optional: true }] : []),
          { key: 'expires_on', label: 'Ends on (optional)', type: 'date', optional: true },
          { key: 'reason', label: 'Why', multiline: true, hint: 'Kept with the grant for the audit trail.' }]}
        onSubmit={async (v) => { await api.post(`/federation/bodies/${id}/delegations`, { user_id: v.user_id, role: v.role, max_depth: Number(v.max_depth ?? 0), sport_id: v.sport_id || undefined, expires_on: v.expires_on || undefined, reason: v.reason }); list.reload(); return 'Role delegated'; }} />
      <ReasonSheet visible={!!revoke} onClose={() => setRevoke(null)} title="Withdraw delegation" body={revoke ? `${revoke.display_name} loses this role at once on ${revoke.max_depth ? 'this body and those beneath it' : 'this body'}. The grant stays in the history.` : ''} confirm="Withdraw" danger
        onConfirm={async (reason) => { try { await api.del(`/federation/bodies/${id}/delegations/${revoke.id}`, { reason }); toast('Delegation withdrawn'); list.reload(); } catch (e) { toast(explain(e)); } }} />
    </Section>
  );
}

// ------------------------------------------------------------------ access review
function AccessReview({ id, me }) {
  const { toast } = useSession();
  const rev = useLoad(() => api.get(`/federation/bodies/${id}/access-review`), [id]);
  const [pending, setPending] = useState({});
  const [ask, setAsk] = useState(null);
  const [certify, setCertify] = useState(false);
  const d = rev.data;
  if (rev.error) return <LoadError error={rev.error} onRetry={rev.reload} />;
  if (!d) return <Loading />;
  const mark = (item, decision) => setAsk({ item, decision });
  const rows = (list, kind) => list.map((r) => {
    const key = `${kind}:${r.ref_id}`;
    const p = pending[key];
    return (
      <ListCard key={key} title={r.display_name} sub={`${kind === 'delegation' ? `${ROLE_LABEL[r.role] ?? r.role} · ${r.max_depth} level${r.max_depth === 1 ? '' : 's'} below` : kind === 'role' ? ROLE_LABEL[r.role] ?? r.role : r.role === 'owner' ? 'Owner' : 'Admin'} · ${r.body_name}`}
        sub2={[r.stale ? `Not seen for ${d.stale_days}+ days` : null, r.lapsed ? 'Delegation has ended' : null, r.source && r.source !== 'manual' ? `Managed by ${r.source.toUpperCase()}` : null, r.service ? `${r.service.tokens} API token${r.service.tokens > 1 ? 's' : ''}${r.service.broad ? ' · broad access' : ''}${r.service.never_expires ? ' · never expires' : ''}` : null].filter(Boolean).join(' · ') || undefined}
        tone={r.stale || r.service?.broad || r.lapsed ? c.sunSoft : undefined} status={p ? (p.decision === 'revoke' ? 'revoked' : 'pending') : 'active'} statusLabel={p ? (p.decision === 'revoke' ? 'Will revoke' : 'Will flag') : 'Keep'}
        right={me.admin ? (p ? <Btn small title="Undo" color={c.paper} ink={c.ink} onPress={() => setPending((x) => { const n = { ...x }; delete n[key]; return n; })} /> : kind === 'org_admin' ? <Btn small title="Flag" color={c.paper} ink={c.ink} onPress={() => mark({ ...r, kind }, 'flag')} accessibilityLabel={`Flag ${r.display_name}`} /> : <Btn small title="Revoke" color={c.paper} ink={c.ink} onPress={() => mark({ ...r, kind }, 'revoke')} accessibilityLabel={`Revoke ${r.display_name}`} />) : undefined} />
    );
  });
  const s = d.summary;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Metric value={s.admins} label="Owners and admins" /><Metric value={s.roles} label="Scoped roles" /><Metric value={s.delegations} label="Delegations" sub={s.lapsed_delegations ? `${s.lapsed_delegations} ended` : undefined} />
        <Metric value={s.stale} label={`Not seen in ${d.stale_days} days`} tone={s.stale ? c.sunSoft : undefined} /><Metric value={s.service_identities} label="With API tokens" sub={s.broad_tokens ? `${s.broad_tokens} broad` : undefined} tone={s.broad_tokens ? c.orangeSoft : undefined} />
        <Metric value={s.pending_revocations} label="Revocations pending" tone={s.pending_revocations ? c.orangeSoft : undefined} />
      </View>
      {d.last_review ? <T size={12} color={c.mute}>Last certified {ago(d.last_review.created_at)} by {d.last_review.reviewer_name}: {d.last_review.kept} kept, {d.last_review.revoked} revoked, {d.last_review.flagged} flagged.</T> : <T size={12} color={c.mute}>No access review has been certified yet.</T>}
      <Cols
        a={<>
          <Section title="Organisation owners and admins" color={c.violet}>{d.admins.length ? rows(d.admins, 'org_admin') : <Empty emoji="👤" title="None" />}</Section>
          <Section title="Scoped roles" color={c.cyan}>{d.roles.length ? rows(d.roles, 'role') : <Empty emoji="🧩" title="No scoped roles" />}</Section>
          <Section title="Delegations" color={c.mint}>{d.delegations.length ? rows(d.delegations, 'delegation') : <Empty emoji="🧭" title="No delegations" />}</Section>
        </>}
        b={<>
          <Section title="Single sign-on and SCIM" color={c.sun}>
            {d.identity.map((i) => <ListCard key={i.body_id} title={i.body_name} sub={i.connection_id ? `${i.protocol?.toUpperCase()} ${i.status}${i.local_login === 'sso_required' ? ' · sign-in required' : ''}` : 'No single sign-on'} sub2={`${i.sso_members} via SSO · ${i.scim_members} via SCIM · ${i.manual_admins} manual admin${i.manual_admins === 1 ? '' : 's'}`} status={i.active ? 'active' : undefined} statusLabel={i.active ? 'SSO on' : undefined} />)}
          </Section>
          <Section title="Sensitive actions, last 30 days" color={c.pink}>
            {d.recent_sensitive.length ? d.recent_sensitive.slice(0, 12).map((e, k) => <ListCard key={k} title={`${e.action.replace(/_/g, ' ')} · ${e.subject_type.replace(/_/g, ' ')}`} sub={`${e.actor_name ?? 'System'} · ${e.body_name}`} sub2={fmtDate(e.created_at)} />) : <Empty emoji="🛡️" title="None" />}
          </Section>
          {d.pending_revocations.length ? <Section title="Pending revocations" color={c.orange}>
            {d.pending_revocations.map((p) => <ListCard key={p.ref_id} title="Flagged organisation admin" sub={`${p.body_name} · ${p.reason ?? ''}`} sub2={`Flagged ${ago(p.created_at)}; the organisation removes them`} tone={c.orangeSoft} />)}
          </Section> : null}
        </>} />
      {me.admin ? <Btn title={`Certify this review${Object.keys(pending).length ? ` (${Object.keys(pending).length} change${Object.keys(pending).length > 1 ? 's' : ''})` : ''}`} onPress={() => setCertify(true)} accessibilityLabel="Certify the access review" /> : null}
      <ReasonSheet visible={!!ask} onClose={() => setAsk(null)} title={ask?.decision === 'revoke' ? 'Revoke access' : 'Flag for removal'} body={ask ? `${ask.item.display_name} · ${ask.item.body_name}` : ''} confirm="Add to review" danger={ask?.decision === 'revoke'}
        onConfirm={async (reason) => setPending((x) => ({ ...x, [`${ask.item.kind}:${ask.item.ref_id}`]: { kind: ask.item.kind, ref_id: ask.item.ref_id, decision: ask.decision, reason } }))} />
      <ReasonSheet visible={certify} onClose={() => setCertify(false)} title="Certify the access review" body="Everything you did not change is recorded as kept. Revocations take effect now and stay in the history." confirm="Certify"
        onConfirm={async (note) => { try { const out = await api.post(`/federation/bodies/${id}/access-reviews`, { note, decisions: Object.values(pending) }); toast(`Certified: ${out.kept} kept, ${out.revoked} revoked, ${out.flagged} flagged`); setPending({}); rev.reload(); } catch (e) { toast(explain(e)); } }} />
    </View>
  );
}

// ------------------------------------------------------------------ the tab
export function GovernanceTab({ id, home, me }) {
  const { tablet } = useLayout();
  const [sub, setSub] = useState('dashboard');
  const body = useLoad(() => api.get(`/federation/bodies/${id}`), [id]);
  const mine = { ...me, user_id: home.me.user_id };
  const auditor = me.roles?.includes('auditor');
  const options = SUB.filter(([v]) => v !== 'access' || me.admin || auditor).map(([value, label]) => ({ value, label }));
  return (
    <View style={{ gap: 10 }}>
      <T size={12.5} color={c.mute}>Run a national, state and district hierarchy from one place: what the numbers are, who decides what, who can act where, and who still needs access.</T>
      <Seg options={options} value={sub} onChange={setSub} />
      {sub === 'dashboard' ? <Dashboard id={id} home={home} /> : null}
      {sub === 'approvals' ? <View style={{ gap: 12, flexDirection: tablet ? 'row' : 'column', alignItems: 'flex-start' }}><View style={{ flex: 1, alignSelf: 'stretch' }}><Requests id={id} me={mine} /></View><View style={{ flex: 1, alignSelf: 'stretch' }}><Rules id={id} admin={me.admin} /></View></View> : null}
      {sub === 'delegation' ? <Delegation id={id} me={me} body={body.data} /> : null}
      {sub === 'access' ? <AccessReview id={id} me={me} /> : null}
    </View>
  );
}
