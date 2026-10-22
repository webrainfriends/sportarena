// Organisation workspaces: clubs, academies and schools. The server decides what each role may do; the screen
// only hides what a role cannot use. Staff, cohorts, enrolment (with a preview), attendance and linked teams/events/venues.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day } from '../theme';
import { moneyIn } from '../vtime';
import { Admissions } from './admissions';
import { Confirm } from './coaching';
import { EntityPicker } from '../entity-picker';
import { explain, LoadError } from '../access';

const KINDS = [['club', 'Club'], ['academy', 'Academy'], ['school', 'School'], ['college', 'College'], ['university', 'University'], ['company', 'Company'], ['other', 'Other']];
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', coach: 'Coach', finance: 'Finance', manager: 'Sponsor manager', evaluator: 'Evaluator', legal: 'Legal', approver: 'Approver', auditor: 'Auditor' };
const ROLE_HELP = {
  owner: 'Full control', admin: 'People, cohorts and linked assets', coach: 'Their cohorts and attendance', finance: 'Money only; reports sponsor payments',
  manager: 'Runs the linked sponsor brands, no people management', evaluator: 'Reads deals, sets objectives and reviews; cannot pay or sign',
  legal: 'Reads deals and changes terms; cannot pay', approver: 'Proposes, revises and withdraws offers; cannot pay', auditor: 'Read-only on deals, with exports',
};
const SPONSOR_ONLY = ['manager', 'evaluator', 'legal', 'approver', 'auditor']; // no cohorts, rosters or admissions
const SPONSOR_EXPORT = ['owner', 'admin', 'manager', 'finance', 'auditor'];
const STAFF = ['owner', 'admin'];
const today = () => new Date().toISOString().slice(0, 10);
const fail = (toast) => (e) => toast(explain(e));

/** My workspaces + pending invitations + create. */
export function Orgs() {
  const { push } = useNav();
  const { toast } = useSession();
  const [make, setMake] = useState(false);
  const list = useLoad(() => api.get('/organisations'), []);
  if (list.error) return <Screen><ErrorBox error={list.error} onRetry={list.reload} /></Screen>;
  const respond = async (o, accept) => { try { await api.post(`/organisations/${o.id}/invite/respond`, { accept }); toast(accept ? `Welcome to ${o.name}` : 'Invitation declined'); list.reload(); } catch (e) { fail(toast)(e); } };
  const invites = (list.data ?? []).filter((o) => o.my_status === 'invited');
  const mine = (list.data ?? []).filter((o) => o.my_status === 'active');
  return (
    <Screen>
      <H1>My organisations</H1>
      <T color={c.mute} style={{ marginTop: 4 }}>Run a club, academy or school: invite staff, group people into cohorts and track attendance.</T>
      <View style={{ marginTop: 12 }}><Btn title="Create an organisation" onPress={() => setMake(true)} /></View>
      {!list.data ? <Loading /> : (
        <>
          {invites.length ? (
            <Section title="Invitations" color={c.sun}>
              {invites.map((o) => (
                <Row key={o.id} title={o.name} sub={`Invited as ${ROLE_LABEL[o.my_role]} — ${ROLE_HELP[o.my_role]}`}
                  right={<View style={{ gap: 6 }}><Btn small title="Accept" onPress={() => respond(o, true)} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => respond(o, false)} /></View>} />
              ))}
            </Section>
          ) : null}
          <Section title="Workspaces" color={c.cyan}>
            {mine.length ? mine.map((o) => (
              <Row key={o.id} title={o.name} sub={`${KINDS.find(([k]) => k === o.kind)?.[1] ?? o.kind}${o.city ? ` · ${o.city}` : ''}`}
                right={<Tag label={o.status === 'archived' ? 'Archived' : ROLE_LABEL[o.my_role]} />} onPress={() => push('Org', { id: o.id })} />
            )) : <Empty emoji="🏫" title="No organisations yet" sub="Create one, or ask an organisation owner to invite you." />}
          </Section>
        </>
      )}
      <FormSheet visible={make} onClose={() => setMake(false)} title="New organisation" submitLabel="Create"
        fields={[{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Type', type: 'chips', options: KINDS.map(([value, label]) => ({ value, label })) }, { key: 'city', label: 'City', optional: true }]}
        onSubmit={async (v) => { const o = await api.post('/organisations', v); list.reload(); push('Org', { id: o.id }); return 'Organisation created'; }} />
    </Screen>
  );
}

export function Org({ id }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('overview');
  const org = useLoad(() => api.get(`/organisations/${id}`), [id]);
  const dash = useLoad(() => api.get(`/organisations/${id}/dashboard`), [id]);
  const brands = useLoad(() => api.get(`/organisations/${id}/assets`, { kind: 'sponsor' }).catch(() => []), [id]); // a coach has no sponsor access: treated as none
  if (org.error || dash.error) return <Screen><LoadError error={dash.error ?? org.error} onRetry={() => { org.reload(); dash.reload(); }} /></Screen>;
  if (!org.data || !dash.data) return <Screen><Loading /></Screen>;
  const o = org.data, d = dash.data, role = d.role, archived = o.status === 'archived';
  const P = { o, d, role, archived, toast, brands, reload: () => { org.reload(); dash.reload(); brands.reload(); } };
  const teaching = !SPONSOR_ONLY.includes(role) && role !== 'finance';
  const tabs = [['overview', 'Overview'], ...(teaching ? [['cohorts', 'Cohorts']] : []), ['people', 'People'], ...(brands.data?.length && role !== 'coach' ? [['sponsor', 'Sponsor']] : []), ...(teaching ? [['assets', 'Teams, events, venues & brands']] : []), ...(STAFF.includes(role) ? [['admissions', 'Admissions']] : [])];
  return (
    <Screen wide>
      <GradCard colors={[c.violet, c.ink]}>
        <H1 color="#fff" style={{ fontSize: 28 }}>{o.name}</H1>
        <T color="#fff" weight="800">{KINDS.find(([k]) => k === o.kind)?.[1]}{o.city ? ` · ${o.city}` : ''} · you are {ROLE_LABEL[role].toLowerCase()}</T>
      </GradCard>
      {archived ? <View style={{ marginTop: 10 }}><Empty emoji="🗄️" title="This organisation is archived" sub="Everything is kept and readable. Ask an owner to restore it to make changes." /></View> : null}
      <View style={{ marginTop: 10 }}><Seg options={tabs.map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.violet} /></View>
      {tab === 'overview' ? <Overview {...P} /> : tab === 'cohorts' ? <Cohorts {...P} /> : tab === 'people' ? <People {...P} /> : tab === 'admissions' ? <Admissions {...P} /> : tab === 'sponsor' ? <SponsorTab {...P} /> : <Assets {...P} />}
    </Screen>
  );
}

// ------------------------------------------------------------------ overview
function Overview({ o, d, role, archived, reload, toast }) {
  const [edit, setEdit] = useState(false);
  const a = d.attendance_30d;
  const exportCsv = async (section) => {
    try {
      const r = await api.get(`/organisations/${o.id}/export`, { section });
      if (typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); }
      toast(`${r.rows} rows exported`);
    } catch (e) { toast(explain(e)); }
  };
  const archive = async () => { try { await api.post(`/organisations/${o.id}/${archived ? 'restore' : 'archive'}`); toast(archived ? 'Organisation restored' : 'Organisation archived — data is kept'); reload(); } catch (e) { fail(toast)(e); } };
  return (
    <>
      {d.counts ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {[['Staff', d.counts.staff], ['People', d.counts.people], ['Cohorts', d.counts.cohorts], ['Teams', d.counts.teams], ['Events', d.counts.events], ['Venues', d.counts.venues]].map(([l, n]) => <Tag key={l} label={`${n} ${l.toLowerCase()}`} />)}
        </View>
      ) : null}
      {a ? <Section title="Attendance, last 30 days" color={c.mint}>{a.marked ? <T>{Math.round((a.present / a.marked) * 100)}% present across {a.marked} marks</T> : <Empty emoji="📋" title="No attendance yet" sub="Mark attendance from a cohort to see the rate here." />}</Section> : null}
      {d.seasons?.length ? <Section title="Seasons" color={c.sun}>{d.seasons.map((s) => <Row key={s.id} title={s.name} sub={`${day(s.starts_on)} – ${day(s.ends_on)} · ${s.cohorts} cohorts`} />)}</Section> : null}
      {d.finance ? (
        <Section title="Money (linked teams)" color={c.lime}>
          {d.finance.length ? d.finance.map((f) => <Row key={f.currency + f.status} title={moneyIn(f.amount_cents, f.currency)} sub={`${f.entries} ${f.status} entries`} />) : <Empty emoji="💸" title="Nothing recorded" sub="Fees owed to players and coaches of linked teams appear here." />}
          <Btn small title="Export finance CSV" color={c.paper} ink={c.ink} onPress={() => exportCsv('finance')} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
        </Section>
      ) : null}
      {STAFF.includes(role) ? (
        <Section title="Manage" color={c.cyan}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {!archived ? <Btn small title="Edit details" color={c.paper} ink={c.ink} onPress={() => setEdit(true)} /> : null}
            <Btn small title="Export staff CSV" color={c.paper} ink={c.ink} onPress={() => exportCsv('staff')} />
            <Btn small title="Export enrolments CSV" color={c.paper} ink={c.ink} onPress={() => exportCsv('enrolments')} />
            <Btn small title="Export attendance CSV" color={c.paper} ink={c.ink} onPress={() => exportCsv('attendance')} />
            {role === 'owner' ? <Btn small title={archived ? 'Restore organisation' : 'Archive organisation'} color={c.orange} onPress={archive} /> : null}
          </View>
        </Section>
      ) : null}
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Organisation details" initial={o}
        fields={[{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Type', type: 'chips', options: KINDS.map(([value, label]) => ({ value, label })) }, { key: 'city', label: 'City', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/organisations/${o.id}`, v); reload(); return 'Saved'; }} />
    </>
  );
}

// ------------------------------------------------------------------ people
function People({ o, role, archived, toast, reload: reloadOrg }) {
  const [invite, setInvite] = useState(false);
  const [sel, setSel] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const staff = useLoad(() => api.get(`/organisations/${o.id}/members`), [o.id]);
  const pending = useLoad(() => (STAFF.includes(role) ? api.get(`/organisations/${o.id}/members`, { status: 'invited' }) : Promise.resolve([])), [o.id, role]);
  const depts = useLoad(() => api.get(`/organisations/${o.id}/departments`).catch(() => []), [o.id]);
  const refresh = () => { staff.reload(); pending.reload(); };
  // a stale change (409) reloads the list so the sheet shows what is true now
  const act = async (fn, msg) => { try { await fn(); toast(msg); setSel(null); refresh(); } catch (e) { toast(explain(e)); if (e.status === 409 || e.status === 404) { setSel(null); refresh(); } } };
  const manage = STAFF.includes(role) && !archived;
  const roles = Object.entries(ROLE_LABEL).filter(([k]) => role === 'owner' || k !== 'owner');
  return (
    <>
      {manage ? <View style={{ marginTop: 10 }}><Btn small title="Invite someone" onPress={() => setInvite(true)} /></View> : null}
      <Section title="Staff" color={c.violet}>
        {staff.error ? <LoadError error={staff.error} onRetry={staff.reload} /> : !staff.data ? <Loading /> : staff.data.length ? staff.data.map((m) => (
          <Row key={m.id} title={m.display_name} sub={`@${m.handle} · ${ROLE_HELP[m.org_role]}${m.department_name ? ` · ${m.department_name}` : ''}`} right={<Tag label={ROLE_LABEL[m.org_role]} />} onPress={manage ? () => setSel(m) : undefined} accessibilityLabel={`${m.display_name}, ${ROLE_LABEL[m.org_role]}${manage ? ', open to change role or remove' : ''}`} />
        )) : <Empty title="No staff yet" />}
      </Section>
      {pending.data?.length ? <Section title="Waiting for a reply" color={c.sun}>{pending.data.map((m) => <Row key={m.id} title={m.display_name} sub={`@${m.handle} · invited as ${ROLE_LABEL[m.org_role]}`} onPress={manage ? () => setSel(m) : undefined} />)}</Section> : null}
      <InviteSheet visible={invite} onClose={() => setInvite(false)} o={o} roles={roles} depts={depts.data ?? []} done={refresh} />
      <Sheet visible={!!sel && !confirm} onClose={() => setSel(null)} title={sel?.display_name ?? ''}>
        {sel ? (
          <View style={{ gap: 10 }}>
            {sel.status === 'active' ? (
              <>
                <T color={c.mute}>Change role</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {roles.map(([k, l]) => <Chip key={k} label={l} active={k === sel.org_role} onPress={() => k !== sel.org_role && act(() => api.patch(`/organisations/${o.id}/members/${sel.id}`, { role: k, expected_role: sel.org_role }), 'Role updated')} />)}
                </View>
                {SPONSOR_ONLY.includes(sel.org_role) || sel.org_role === 'finance' ? (
                  <>
                    <T color={c.mute}>Department</T>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      <Chip label="All departments" active={!sel.department_id} onPress={() => sel.department_id && act(() => api.patch(`/organisations/${o.id}/members/${sel.id}`, { role: sel.org_role, department_id: null, expected_role: sel.org_role }), 'Department updated')} />
                      {(depts.data ?? []).map((d) => <Chip key={d.id} label={d.name} active={sel.department_id === d.id} onPress={() => sel.department_id !== d.id && act(() => api.patch(`/organisations/${o.id}/members/${sel.id}`, { role: sel.org_role, department_id: d.id, expected_role: sel.org_role }), 'Department updated')} />)}
                    </View>
                  </>
                ) : null}
                {role === 'owner' && sel.org_role !== 'owner' ? <Btn small title="Make owner and step down to admin" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/organisations/${o.id}/transfer`, { to_user_id: sel.id }), 'Ownership transferred')} /> : null}
              </>
            ) : null}
            <Btn title={sel.status === 'invited' ? 'Cancel invitation' : 'Revoke access'} color={c.orange} onPress={() => setConfirm(true)} />
            <T size={12} color={c.mute}>Their access ends immediately, including sponsor deals, payments and exports. History they created stays in place.</T>
          </View>
        ) : null}
      </Sheet>
      <Confirm visible={confirm} danger title={sel?.status === 'invited' ? 'Cancel this invitation?' : `Revoke ${sel?.display_name ?? ''}'s access?`} yes={sel?.status === 'invited' ? 'Cancel invitation' : 'Revoke access'}
        body="This takes effect at once. Nothing is deleted: payments, reviews and other history stay, and you can invite them again later."
        onClose={() => setConfirm(false)} onYes={async () => { await act(() => api.del(`/organisations/${o.id}/members/${sel.id}`), 'Access removed — history is kept'); setConfirm(false); reloadOrg?.(); }} />
    </>
  );
}

/** Invite: search-and-pick the person (never a typed handle), a role chip, and an optional department. */
function InviteSheet({ visible, onClose, o, roles, depts, done }) {
  const { toast } = useSession();
  const [who, setWho] = useState([]);
  const [role, setRole] = useState(null);
  const [dept, setDept] = useState(null);
  const [busy, setBusy] = useState(false);
  const scoped = role && (SPONSOR_ONLY.includes(role) || role === 'finance');
  const close = () => { setWho([]); setRole(null); setDept(null); onClose(); };
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/organisations/${o.id}/members`, { person: who[0].sub.replace(/^@/, ''), role, ...(scoped && dept ? { department_id: dept } : {}) });
      toast('Invitation sent'); done(); close();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={close} title="Invite to this organisation">
      <View style={{ gap: 12 }}>
        <EntityPicker label="Person" value={who} onChange={setWho} />
        <T size={12} color={c.mute}>They need a Gotmygame account. Nothing is shared until they accept.</T>
        <T color={c.mute}>Role</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{roles.map(([k, l]) => <Chip key={k} label={l} active={role === k} onPress={() => setRole(k)} />)}</View>
        {role ? <T size={12} color={c.mute}>{ROLE_HELP[role]}</T> : null}
        {scoped && depts.length ? (
          <>
            <T color={c.mute}>Department (optional)</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Chip label="All departments" active={!dept} onPress={() => setDept(null)} />
              {depts.map((d) => <Chip key={d.id} label={d.name} active={dept === d.id} onPress={() => setDept(d.id)} />)}
            </View>
          </>
        ) : null}
        <Btn title="Send invitation" loading={busy} disabled={!who.length || !role} onPress={send} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ sponsor brands: deals, departments, export
function SponsorTab({ o, role, archived, toast, brands }) {
  const { push } = useNav();
  const [dept, setDept] = useState(null); // department filter
  const [add, setAdd] = useState(false);
  const depts = useLoad(() => api.get(`/organisations/${o.id}/departments`), [o.id]);
  const deals = useLoad(() => api.get('/sponsorships', { limit: 100 }), [o.id]);
  const ids = new Set((brands.data ?? []).map((b) => b.id));
  const names = Object.fromEntries((depts.data ?? []).map((d) => [d.id, d.name]));
  const rows = (deals.data ?? []).filter((d) => ids.has(d.sponsor_id) && (!dept || d.department_id === dept));
  const manage = STAFF.includes(role) && !archived;
  const exportCsv = async (section) => {
    try {
      const r = await api.get(`/organisations/${o.id}/export`, { section });
      if (typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); }
      toast(`${r.rows} rows exported`);
    } catch (e) { toast(explain(e)); }
  };
  return (
    <>
      <Section title="Brands" color={c.violet}>
        {(brands.data ?? []).map((b) => <Row key={b.id} title={b.name} sub="Run by this organisation's staff under their sponsor roles" />)}
      </Section>
      <Section title="Deals" color={c.sun}>
        {depts.data?.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            <Chip label="All departments" active={!dept} onPress={() => setDept(null)} />
            {depts.data.map((d) => <Chip key={d.id} label={d.name} active={dept === d.id} onPress={() => setDept(d.id)} />)}
          </View>
        ) : null}
        {deals.error ? <LoadError error={deals.error} onRetry={deals.reload} /> : deals.loading && !deals.data ? <Loading /> : rows.length ? rows.map((d) => (
          <Row key={d.id} title={`${d.sponsor_name} → ${d.target_name ?? d.target_type}`} sub={`${d.status}${d.department_id ? ` · ${names[d.department_id] ?? 'Archived department'}` : ' · All departments'}`}
            right={d.agreement_ref ? <Btn small title="Open" color={c.paper} ink={c.ink} onPress={() => push('SponsorDeal', { id: d.id })} /> : <Tag label="Legacy" />} />
        )) : <Empty emoji="🤝" title="No deals to show" sub={dept ? 'No deals in this department yet.' : 'Deals appear here once a linked brand makes or receives an offer.'} />}
      </Section>
      <Section title="Departments" color={c.cyan}>
        {depts.error ? <LoadError error={depts.error} onRetry={depts.reload} /> : !depts.data ? <Loading /> : depts.data.length ? depts.data.map((d) => (
          <Row key={d.id} title={d.name} right={manage ? <Btn small title="Archive" color={c.paper} ink={c.ink} onPress={async () => { try { await api.del(`/organisations/${o.id}/departments/${d.id}`); toast('Department archived — deals and people are kept'); depts.reload(); } catch (e) { toast(explain(e)); } }} /> : null} />
        )) : <Empty emoji="🏢" title="No departments" sub="Departments limit who sees which deals. Without any, everyone with a role sees every deal." />}
        {manage ? <Btn small title="Add department" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setAdd(true)} /> : null}
      </Section>
      {SPONSOR_EXPORT.includes(role) ? (
        <Section title="Export" color={c.mint}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Btn small title="Export deals CSV" color={c.paper} ink={c.ink} onPress={() => exportCsv('sponsor_deals')} />
            <Btn small title="Export dues CSV" color={c.paper} ink={c.ink} onPress={() => exportCsv('sponsor_obligations')} />
          </View>
          <T size={12} color={c.mute}>Exports follow your role and department and are recorded in the audit log. They never include contact details.</T>
        </Section>
      ) : null}
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add a department" fields={[{ key: 'name', label: 'Department name' }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/departments`, v); depts.reload(); return 'Department added'; }} />
    </>
  );
}

// ------------------------------------------------------------------ cohorts, enrolment, attendance
function Cohorts({ o, role, archived, toast }) {
  const [make, setMake] = useState(false), [season, setSeason] = useState(false);
  const [enrol, setEnrol] = useState(null), [mark, setMark] = useState(null), [view, setView] = useState(null);
  const cohorts = useLoad(() => api.get(`/organisations/${o.id}/cohorts`), [o.id]);
  const seasons = useLoad(() => api.get(`/organisations/${o.id}/seasons`), [o.id]);
  const staff = useLoad(() => (STAFF.includes(role) ? api.get(`/organisations/${o.id}/members`) : Promise.resolve([])), [o.id, role]);
  const manage = STAFF.includes(role) && !archived;
  const sName = (id) => seasons.data?.find((s) => s.id === id)?.name;
  return (
    <>
      {manage ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <Btn small title="New cohort" onPress={() => setMake(true)} />
          <Btn small title="New season" color={c.violet} onPress={() => setSeason(true)} />
        </View>
      ) : null}
      <Section title="Cohorts" color={c.mint}>
        {cohorts.error ? <ErrorBox error={cohorts.error} onRetry={cohorts.reload} /> : !cohorts.data ? <Loading /> : cohorts.data.length ? cohorts.data.map((k) => (
          <Row key={k.id} title={k.name} sub={`${k.enrolled} enrolled${k.season_id ? ` · ${sName(k.season_id) ?? 'season'}` : ''}`}
            right={archived ? null : <View style={{ gap: 6 }}><Btn small title="Enrol" onPress={() => setEnrol(k)} /><Btn small title="Attendance" color={c.paper} ink={c.ink} onPress={() => setMark(k)} /></View>} onPress={() => setView(k)} />
        )) : <Empty emoji="🧑‍🤝‍🧑" title="No cohorts yet" sub={manage ? 'Create a cohort for a class, age group or squad, then enrol people.' : 'Cohorts assigned to you will appear here.'} />}
      </Section>
      <FormSheet visible={make} onClose={() => setMake(false)} title="New cohort" submitLabel="Create"
        fields={[{ key: 'name', label: 'Name' },
          { key: 'season_id', label: 'Season', type: 'chips', optional: true, options: (seasons.data ?? []).map((s) => ({ value: s.id, label: s.name })) },
          { key: 'coach_id', label: 'Coach', type: 'chips', optional: true, options: (staff.data ?? []).filter((m) => m.org_role !== 'finance').map((m) => ({ value: m.id, label: m.display_name })) }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/cohorts`, v); cohorts.reload(); return 'Cohort created'; }} />
      <FormSheet visible={season} onClose={() => setSeason(false)} title="New season" submitLabel="Create"
        fields={[{ key: 'name', label: 'Name', placeholder: 'e.g. Autumn term' }, { key: 'starts_on', label: 'Starts', type: 'date' }, { key: 'ends_on', label: 'Ends', type: 'date' }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/seasons`, v); seasons.reload(); return 'Season created'; }} />
      {enrol ? <EnrolSheet cohort={enrol} onClose={() => setEnrol(null)} onDone={cohorts.reload} toast={toast} /> : null}
      {mark ? <AttendanceSheet cohort={mark} onClose={() => setMark(null)} toast={toast} /> : null}
      {view ? <CohortSheet cohort={view} canWithdraw={manage || role === 'coach'} onClose={() => setView(null)} onDone={cohorts.reload} toast={toast} /> : null}
    </>
  );
}

/** Paste a CSV, check it, fix problems, then enrol. Nothing is written until you confirm. */
function EnrolSheet({ cohort, onClose, onDone, toast }) {
  const [csv, setCsv] = useState('handle,consent\n');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const check = async () => { setBusy(true); try { setRes(await api.post(`/cohorts/${cohort.id}/enrolments/preview`, { csv })); } catch (e) { fail(toast)(e); } setBusy(false); };
  const commit = async (allow_partial) => {
    setBusy(true);
    try { const r = await api.post(`/cohorts/${cohort.id}/enrolments`, { csv, allow_partial }); toast(`${r.summary.enrolled} people enrolled`); onDone(); onClose(); } catch (e) { fail(toast)(e); }
    setBusy(false);
  };
  const s = res?.summary;
  return (
    <Sheet visible onClose={onClose} title={`Enrol into ${cohort.name}`}>
      <View style={{ gap: 10 }}>
        <T size={13} color={c.mute}>One person per line with the columns handle (or email) and consent. Write yes in consent only when the person, or their guardian, has agreed to be enrolled.</T>
        <Field label="People (CSV)" value={csv} onChangeText={(x) => { setCsv(x); setRes(null); }} multiline placeholder={'handle,consent\nasha_k,yes'} />
        <Btn title="Check list" onPress={check} loading={busy} disabled={csv.trim().length < 3} />
        {s ? (
          <>
            <T weight="800">{s.ok} ready · {s.duplicate} already listed or enrolled · {s.invalid} need fixing</T>
            {res.rows.filter((r) => r.status !== 'ok').map((r) => <Row key={r.line} title={`Line ${r.line}: ${r.ref}`} sub={r.reason} color={c.orangeSoft} />)}
            {!s.duplicate && !s.invalid && s.ok ? <Btn title={`Enrol ${s.ok} people`} onPress={() => commit(false)} loading={busy} /> : null}
            {(s.duplicate || s.invalid) && s.ok ? <Btn title={`Enrol the ${s.ok} ready people and skip the rest`} color={c.violet} onPress={() => commit(true)} loading={busy} /> : null}
            {!s.ok ? <Empty emoji="🤔" title="Nobody to enrol" sub="Fix the lines above, or remove the ones that are already enrolled." /> : null}
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

function AttendanceSheet({ cohort, onClose, toast }) {
  const [date, setDate] = useState(today());
  const list = useLoad(() => api.get(`/cohorts/${cohort.id}/enrolments`), [cohort.id]);
  const [marks, setMarks] = useState({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { const r = await api.post(`/cohorts/${cohort.id}/attendance`, { session_date: date, records: Object.entries(marks).map(([user_id, status]) => ({ user_id, status })) }); toast(`Attendance saved for ${r.saved} people`); onClose(); } catch (e) { fail(toast)(e); }
    setBusy(false);
  };
  const STATES = [['present', 'Present'], ['absent', 'Absent'], ['excused', 'Excused']];
  return (
    <Sheet visible onClose={onClose} title={`Attendance · ${cohort.name}`}>
      <View style={{ gap: 10 }}>
        <Field label="Session date (YYYY-MM-DD)" value={date} onChangeText={setDate} />
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? (
          <>
            <Btn small title="Mark everyone present" color={c.paper} ink={c.ink} onPress={() => setMarks(Object.fromEntries(list.data.map((p) => [p.id, 'present'])))} style={{ alignSelf: 'flex-start' }} />
            {list.data.map((p) => (
              <Row key={p.id} title={p.display_name} sub={`@${p.handle}`}
                right={<View style={{ flexDirection: 'row', gap: 4 }}>{STATES.map(([k, l]) => <Chip key={k} label={l} active={marks[p.id] === k} onPress={() => setMarks((m) => ({ ...m, [p.id]: k }))} />)}</View>} />
            ))}
            <Btn title="Save attendance" onPress={save} loading={busy} disabled={!Object.keys(marks).length} />
          </>
        ) : <Empty emoji="🧑‍🤝‍🧑" title="Nobody enrolled yet" sub="Enrol people first, then mark attendance." />}
      </View>
    </Sheet>
  );
}

function CohortSheet({ cohort, canWithdraw, onClose, onDone, toast }) {
  const att = useLoad(() => api.get(`/cohorts/${cohort.id}/attendance`), [cohort.id]);
  const out = async (p) => { try { await api.del(`/cohorts/${cohort.id}/enrolments/${p.id}`); toast(`${p.display_name} withdrawn — attendance history kept`); att.reload(); onDone(); } catch (e) { fail(toast)(e); } };
  return (
    <Sheet visible onClose={onClose} title={cohort.name}>
      <View style={{ gap: 8 }}>
        {att.error ? <ErrorBox error={att.error} onRetry={att.reload} /> : !att.data ? <Loading /> : att.data.people.length ? att.data.people.map((p) => (
          <Row key={p.id} title={p.display_name} sub={p.sessions ? `${p.present} present · ${p.absent} absent · ${p.excused} excused` : 'No sessions marked yet'}
            right={canWithdraw ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => out(p)} /> : null} />
        )) : <Empty emoji="🧑‍🤝‍🧑" title="Nobody enrolled" sub="Use Enrol to add people." />}
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ linked teams / events / venues
function Assets({ o, role, archived, toast }) {
  const [kind, setKind] = useState('team');
  const [link, setLink] = useState(false);
  const list = useLoad(() => api.get(`/organisations/${o.id}/assets`, { kind }), [o.id, kind]);
  const { user } = useSession();
  const mine = useLoad(() => (!link ? Promise.resolve([]) : kind === 'team' ? api.get('/teams', { mine: true }) : kind === 'event' ? api.get('/events', { organizer_id: user.id }) : kind === 'sponsor' ? api.get('/sponsors', { mine: true, limit: 50 }) : api.get('/me/venues')), [link, kind]);
  const manage = STAFF.includes(role) && !archived;
  const unlink = async (a) => { try { await api.del(`/organisations/${o.id}/assets/${a.id}`, { kind }); toast('Removed from the organisation'); list.reload(); } catch (e) { fail(toast)(e); } };
  const add = async (a) => { try { await api.post(`/organisations/${o.id}/assets`, { kind, asset_id: a.id }); toast(`${a.name} added`); setLink(false); list.reload(); } catch (e) { fail(toast)(e); } };
  const items = (Array.isArray(mine.data) ? mine.data : mine.data?.items ?? []).filter((a) => !a.organisation_id && (kind !== 'sponsor' || a.my_role === 'manager'));
  return (
    <>
      <View style={{ marginTop: 10 }}><Seg options={[{ value: 'team', label: 'Teams' }, { value: 'event', label: 'Events' }, { value: 'venue', label: 'Venues' }, { value: 'sponsor', label: 'Brands' }]} value={kind} onChange={setKind} color={c.cyan} /></View>
      {manage ? <View style={{ marginTop: 6 }}><Btn small title={kind === 'sponsor' ? 'Link one of my brands' : `Add one of my ${kind}s`} onPress={() => setLink(true)} /></View> : null}
      <Section title={kind === 'sponsor' ? 'Linked brands' : `Linked ${kind}s`} color={c.cyan}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((a) => (
          <Row key={a.id} title={a.name} right={manage ? <Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => unlink(a)} /> : null} />
        )) : <Empty emoji="🔗" title={kind === 'sponsor' ? 'No brands linked' : `No ${kind}s linked`} sub="Owners and admins of this organisation can manage linked items. You keep ownership of anything you add." />}
      </Section>
      <Sheet visible={link} onClose={() => setLink(false)} title={kind === 'sponsor' ? 'Link a brand' : `Add a ${kind}`}>
        <View style={{ gap: 8 }}>
          {!mine.data ? <Loading /> : items.length ? items.map((a) => <Row key={a.id} title={a.name} onPress={() => add(a)} />) : <Empty title={`No ${kind}s to add`} sub={`Only ${kind}s you own can be added.`} />}
        </View>
      </Sheet>
    </>
  );
}
