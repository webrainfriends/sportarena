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

const KINDS = [['club', 'Club'], ['academy', 'Academy'], ['school', 'School'], ['other', 'Other']];
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', coach: 'Coach', finance: 'Finance' };
const ROLE_HELP = { owner: 'Full control', admin: 'People, cohorts and linked assets', coach: 'Their cohorts and attendance', finance: 'Money only' };
const STAFF = ['owner', 'admin'];
const today = () => new Date().toISOString().slice(0, 10);
const fail = (toast) => (e) => toast('' + e.message);

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
  if (org.error || dash.error) return <Screen><ErrorBox error={dash.error ?? org.error} onRetry={() => { org.reload(); dash.reload(); }} /></Screen>;
  if (!org.data || !dash.data) return <Screen><Loading /></Screen>;
  const o = org.data, d = dash.data, role = d.role, archived = o.status === 'archived';
  const P = { o, d, role, archived, toast, reload: () => { org.reload(); dash.reload(); } };
  const tabs = [['overview', 'Overview'], ...(role !== 'finance' ? [['cohorts', 'Cohorts']] : []), ['people', 'People'], ...(role !== 'finance' ? [['assets', 'Teams, events & venues']] : [])];
  return (
    <Screen wide>
      <GradCard colors={[c.violet, c.ink]}>
        <H1 color="#fff" style={{ fontSize: 28 }}>{o.name}</H1>
        <T color="#fff" weight="800">{KINDS.find(([k]) => k === o.kind)?.[1]}{o.city ? ` · ${o.city}` : ''} · you are {ROLE_LABEL[role].toLowerCase()}</T>
      </GradCard>
      {archived ? <View style={{ marginTop: 10 }}><Empty emoji="🗄️" title="This organisation is archived" sub="Everything is kept and readable. Ask an owner to restore it to make changes." /></View> : null}
      <View style={{ marginTop: 10 }}><Seg options={tabs.map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.violet} /></View>
      {tab === 'overview' ? <Overview {...P} /> : tab === 'cohorts' ? <Cohorts {...P} /> : tab === 'people' ? <People {...P} /> : <Assets {...P} />}
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
    } catch (e) { fail(toast)(e); }
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
function People({ o, role, archived, toast }) {
  const [invite, setInvite] = useState(false);
  const [sel, setSel] = useState(null);
  const staff = useLoad(() => api.get(`/organisations/${o.id}/members`), [o.id]);
  const pending = useLoad(() => (STAFF.includes(role) ? api.get(`/organisations/${o.id}/members`, { status: 'invited' }) : Promise.resolve([])), [o.id, role]);
  const refresh = () => { staff.reload(); pending.reload(); };
  const act = async (fn, msg) => { try { await fn(); toast(msg); setSel(null); refresh(); } catch (e) { fail(toast)(e); } };
  const manage = STAFF.includes(role) && !archived;
  return (
    <>
      {manage ? <View style={{ marginTop: 10 }}><Btn small title="Invite someone" onPress={() => setInvite(true)} /></View> : null}
      <Section title="Staff" color={c.violet}>
        {staff.error ? <ErrorBox error={staff.error} onRetry={staff.reload} /> : !staff.data ? <Loading /> : staff.data.length ? staff.data.map((m) => (
          <Row key={m.id} title={m.display_name} sub={`@${m.handle} · ${ROLE_HELP[m.org_role]}`} right={<Tag label={ROLE_LABEL[m.org_role]} />} onPress={manage ? () => setSel(m) : undefined} />
        )) : <Empty title="No staff yet" />}
      </Section>
      {pending.data?.length ? <Section title="Waiting for a reply" color={c.sun}>{pending.data.map((m) => <Row key={m.id} title={m.display_name} sub={`@${m.handle} · invited as ${ROLE_LABEL[m.org_role]}`} onPress={manage ? () => setSel(m) : undefined} />)}</Section> : null}
      <FormSheet visible={invite} onClose={() => setInvite(false)} title="Invite to this organisation" submitLabel="Send invitation"
        fields={[{ key: 'person', label: 'Handle or email', hint: 'They need a SportArena account. Nothing is shared until they accept.' }, { key: 'role', label: 'Role', type: 'chips', options: Object.entries(ROLE_LABEL).filter(([k]) => role === 'owner' || k !== 'owner').map(([value, label]) => ({ value, label })) }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/members`, v); refresh(); return 'Invitation sent'; }} />
      <Sheet visible={!!sel} onClose={() => setSel(null)} title={sel?.display_name ?? ''}>
        {sel ? (
          <View style={{ gap: 10 }}>
            {sel.status === 'active' ? (
              <>
                <T color={c.mute}>Change role</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {Object.entries(ROLE_LABEL).filter(([k]) => role === 'owner' || k !== 'owner').map(([k, l]) => <Chip key={k} label={l} active={k === sel.org_role} onPress={() => act(() => api.patch(`/organisations/${o.id}/members/${sel.id}`, { role: k }), 'Role updated')} />)}
                </View>
                {role === 'owner' && sel.org_role !== 'owner' ? <Btn small title="Make owner and step down to admin" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/organisations/${o.id}/transfer`, { to_user_id: sel.id }), 'Ownership transferred')} /> : null}
              </>
            ) : null}
            <Btn title={sel.status === 'invited' ? 'Cancel invitation' : 'Remove from organisation'} color={c.orange} onPress={() => act(() => api.del(`/organisations/${o.id}/members/${sel.id}`), 'Access removed — history is kept')} />
            <T size={12} color={c.mute}>Their access ends immediately. Attendance and enrolment records they created stay in place.</T>
          </View>
        ) : null}
      </Sheet>
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
  const mine = useLoad(() => (!link ? Promise.resolve([]) : kind === 'team' ? api.get('/teams', { mine: true }) : kind === 'event' ? api.get('/events', { organizer_id: user.id }) : api.get('/me/venues')), [link, kind]);
  const manage = STAFF.includes(role) && !archived;
  const unlink = async (a) => { try { await api.del(`/organisations/${o.id}/assets/${a.id}`, { kind }); toast('Removed from the organisation'); list.reload(); } catch (e) { fail(toast)(e); } };
  const add = async (a) => { try { await api.post(`/organisations/${o.id}/assets`, { kind, asset_id: a.id }); toast(`${a.name} added`); setLink(false); list.reload(); } catch (e) { fail(toast)(e); } };
  const items = (Array.isArray(mine.data) ? mine.data : mine.data?.items ?? []).filter((a) => !a.organisation_id);
  return (
    <>
      <View style={{ marginTop: 10 }}><Seg options={[{ value: 'team', label: 'Teams' }, { value: 'event', label: 'Events' }, { value: 'venue', label: 'Venues' }]} value={kind} onChange={setKind} color={c.cyan} /></View>
      {manage ? <View style={{ marginTop: 6 }}><Btn small title={`Add one of my ${kind}s`} onPress={() => setLink(true)} /></View> : null}
      <Section title={`Linked ${kind}s`} color={c.cyan}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((a) => (
          <Row key={a.id} title={a.name} right={manage ? <Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => unlink(a)} /> : null} />
        )) : <Empty emoji="🔗" title={`No ${kind}s linked`} sub="Owners and admins of this organisation can manage linked items. You keep ownership of anything you add." />}
      </Section>
      <Sheet visible={link} onClose={() => setLink(false)} title={`Add a ${kind}`}>
        <View style={{ gap: 8 }}>
          {!mine.data ? <Loading /> : items.length ? items.map((a) => <Row key={a.id} title={a.name} onPress={() => add(a)} />) : <Empty title={`No ${kind}s to add`} sub={`Only ${kind}s you own can be added.`} />}
        </View>
      </Sheet>
    </>
  );
}
