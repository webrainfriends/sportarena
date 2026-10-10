// Multi-sport events (sports day, Olympics-style games): one screen for the organiser's whole workflow — houses and
// people, sports and nominations, qualifying rounds, a clash-free timetable, results and points, crew and medical
// cover, certificates and trophies, announcements — and a read-only view for participants, house masters and crew.
// The server decides what each person may do; the screen only hides what a role cannot use.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';

const fail = (toast) => (e) => toast('' + e.message);
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const hm = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayName = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const localIso = (date, time) => new Date(`${date}T${time}:00`).toISOString();
const STAGE = { qualifying: 'Qualifier', heat: 'Heat', round_robin: 'League', knockout: 'Knockout', quarter_final: 'Quarter-final', semi_final: 'Semi-final', third_place: 'Third place', final: 'Final' };
const ROLES = ['referee', 'umpire', 'judge', 'starter', 'timekeeper', 'scorer', 'physio', 'doctor', 'first_aider', 'volunteer'];
const opts = (list, label = (x) => x.name, value = (x) => x.id) => (list ?? []).map((x) => ({ value: value(x), label: label(x) }));

/** Wrap an action: run it, toast the message, refresh. */
const useDo = (toast, refresh) => async (fn, msg) => {
  try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg); refresh?.(); return r; } catch (e) { fail(toast)(e); return null; }
};

export function Games({ id }) {
  const { user, has, toast } = useSession();
  const [tab, setTab] = useState('overview');
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  const prog = useLoad(() => api.get(`/events/${id}/programme`).catch((e) => (e.status === 404 ? null : Promise.reject(e))), [id]);
  const mine = useLoad(() => (user ? api.get('/me/games') : Promise.resolve(null)), [id]);
  if (ev.error || prog.error) return <Screen><ErrorBox error={ev.error ?? prog.error} onRetry={() => { ev.reload(); prog.reload(); }} /></Screen>;
  if (!ev.data || prog.loading) return <Screen><Loading /></Screen>;
  const e = ev.data;
  const isOrg = !!user && (e.organizer_id === user.id || has('admin'));
  if (!prog.data) {
    return (
      <Screen>
        <H1>{e.name}</H1>
        {isOrg ? (
          <>
            <T color={c.mute} style={{ marginTop: 6 }}>Run this event as a multi-sport programme: several sports, houses or groups, nominations, qualifying rounds, one clash-free timetable, crew, points and certificates.</T>
            <Btn title="Set up multi-sport programme" style={{ marginTop: 14 }} onPress={async () => { try { await api.patch(`/events/${id}/programme`, {}); toast('Programme created'); prog.reload(); } catch (x) { fail(toast)(x); } }} />
          </>
        ) : <Empty emoji="🏅" title="No programme yet" sub="The organiser has not set up the sports for this event." />}
      </Screen>
    );
  }
  const myHouses = (mine.data?.managing_houses ?? []).filter((h) => h.event_id === id);
  const myParts = (mine.data?.participating ?? []).filter((p) => p.event_id === id);
  const P = { id, e, prog: prog.data.programme, houses: prog.data.houses, isOrg, myHouses, myParts, toast, reload: () => { prog.reload(); mine.reload(); } };
  const tabs = [['overview', 'Overview'], ...(isOrg ? [['people', 'People'], ['sports', 'Sports']] : []), ['schedule', 'Schedule'], ['standings', 'Standings'],
    ...(isOrg ? [['crew', 'Crew & medical'], ['awards', 'Awards']] : []), ['messages', 'Messages']];
  return (
    <Screen wide>
      <GradCard colors={[c.pink, c.violet]}>
        <T size={44}>{e.banner_emoji}</T>
        <H1 color="#fff" style={{ fontSize: 28 }}>{e.name}</H1>
        <T color="#fff" weight="800">Multi-sport games{e.starts_on ? ` · ${dayName(e.starts_on)}` : ''}{e.city ? ` · ${e.city}` : ''}</T>
      </GradCard>
      <View style={{ marginTop: 10 }}><Seg options={tabs.map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.pink} /></View>
      {tab === 'overview' ? <Overview {...P} /> : tab === 'people' ? <People {...P} /> : tab === 'sports' ? <Sports {...P} /> : tab === 'schedule' ? <Schedule {...P} />
        : tab === 'standings' ? <Standings {...P} /> : tab === 'crew' ? <Crew {...P} /> : tab === 'awards' ? <Awards {...P} /> : <Messages {...P} />}
    </Screen>
  );
}

// ------------------------------------------------------------------ overview
function Overview({ id, prog, houses, isOrg, myParts, myHouses, toast, reload }) {
  const [edit, setEdit] = useState(false);
  const dash = useLoad(() => (isOrg ? api.get(`/events/${id}/dashboard`) : Promise.resolve(null)), [id, isOrg]);
  const duties = useLoad(() => api.get('/me/event-duties').catch(() => ({ posts: [], shifts: [] })), [id]);
  const certs = useLoad(() => api.get('/me/certificates').catch(() => []), [id]);
  const done = useDo(toast, () => { reload(); duties.reload(); });
  const d = dash.data;
  const posts = (duties.data?.posts ?? []).filter((p) => p.event_id === id);
  const shifts = (duties.data?.shifts ?? []).filter((s) => s.event_id === id);
  return (
    <>
      {d ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            <StatPill value={d.participants} label="PEOPLE" /><StatPill value={d.houses} label="HOUSES" />
            <StatPill value={Object.values(d.disciplines).reduce((a, b) => a + b, 0)} label="SPORTS" />
            <StatPill value={(d.sessions.scheduled ?? 0) + (d.sessions.live ?? 0)} label="ON TIMETABLE" color={c.paper} />
            <StatPill value={d.clashes} label="CLASHES" color={d.clashes ? c.sun : c.paper} />
          </View>
          <Section title="To do next" color={c.sun}>
            {d.todo.length ? d.todo.map((t) => <Row key={t} title={t} />) : <Empty emoji="✅" title="Nothing outstanding" sub="Everyone is nominated, scheduled, staffed and covered." />}
          </Section>
        </>
      ) : null}
      <Section title="House league" color={c.cyan}>
        {houses?.length ? houses.map((h) => (
          <Row key={h.house_id} left={<T size={26}>{h.emoji ?? '🏠'}</T>} title={`${h.rank}. ${h.name}`} sub={`🥇 ${h.gold}  🥈 ${h.silver}  🥉 ${h.bronze}`} right={<T weight="800" size={22}>{h.points}</T>} />
        )) : <Empty emoji="🏠" title="No houses yet" sub={isOrg ? 'Add houses or groups on the People tab.' : 'Houses will appear here.'} />}
      </Section>
      {myParts.length ? (
        <Section title="Your games" color={c.mint}>
          {myParts.map((p) => <Row key={p.participant_id} title={`${p.house ?? 'No house'} · ${p.points} points`} sub={p.nominations.map((n) => n.name).join(' · ') || 'Not nominated yet'} right={p.certificates ? <Tag label={`${p.certificates} 🏅`} /> : null} />)}
        </Section>
      ) : null}
      {myHouses.length ? <Section title="You manage" color={c.violet}>{myHouses.map((h) => <Row key={h.id} title={h.name} sub="You can nominate people, build teams and message this house." />)}</Section> : null}
      {posts.length ? (
        <Section title="Your crew posts" color={c.orange}>
          {posts.map((p) => (
            <Row key={p.id} title={`${p.role}`} sub={`${p.status}${p.rate_cents ? ` · ${(p.rate_cents / 100).toFixed(2)} ${p.currency}` : ''}`}
              right={p.status === 'invited' ? <View style={{ gap: 6 }}><Btn small title="Accept" onPress={() => done(() => api.post(`/event-staff/${p.id}/respond`, { response: 'accept' }), 'Accepted')} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => done(() => api.post(`/event-staff/${p.id}/respond`, { response: 'decline' }), 'Declined')} /></View> : null} />
          ))}
          {shifts.map((s) => <Row key={s.id} title={s.session ?? s.kind.replace('_', ' ')} sub={`${dayName(s.starts_at)} ${hm(s.starts_at)}–${hm(s.ends_at)}${s.location ? ` · ${s.location}` : ''}`} />)}
        </Section>
      ) : null}
      {(certs.data ?? []).length ? <Section title="Your certificates" color={c.sun}>{certs.data.map((x) => <Row key={x.id} title={x.title} sub={`${x.event} · code ${x.code}`} />)}</Section> : null}
      {isOrg ? (
        <Section title="Rules" color={c.violet}>
          <T color={c.mute}>Up to {prog.max_individual_entries} individual and {prog.max_team_entries} team sports per person · {prog.rest_gap_min} min rest between a person's games · places {Object.entries(prog.default_points).map(([k, v]) => `${k}:${v}`).join(' ')}{prog.participation_points ? ` · ${prog.participation_points} for taking part` : ''}</T>
          <Btn small title="Edit rules" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setEdit(true)} />
          <FormSheet visible={edit} onClose={() => setEdit(false)} title="Programme rules" initial={prog}
            fields={[
              { key: 'max_individual_entries', label: 'Individual sports per person', type: 'stepper', min: 1, max: 50 }, { key: 'max_team_entries', label: 'Team sports per person', type: 'stepper', min: 1, max: 50 },
              { key: 'rest_gap_min', label: 'Rest between a person\'s games', type: 'stepper', min: 0, max: 240, step: 5, suffix: ' min' }, { key: 'participation_points', label: 'Points for taking part', type: 'stepper', min: 0, max: 100 },
              { key: 'nominations_open', label: 'Nominations open to house masters and participants', type: 'switch' },
              { key: 'public_names', label: 'Show participant names publicly', type: 'switch', hint: 'Off by default — many participants are children.' }]}
            onSubmit={async (v) => { await api.patch(`/events/${id}/programme`, v); reload(); return 'Saved'; }} />
        </Section>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ people
function People({ id, toast }) {
  const [q, setQ] = useState('');
  const [house, setHouse] = useState(false), [person, setPerson] = useState(false), [imp, setImp] = useState(false);
  const houses = useLoad(() => api.get(`/events/${id}/houses`), [id]);
  const people = useLoad(() => api.get(`/events/${id}/participants`, { q, limit: 100 }), [id, q]);
  const refresh = () => { houses.reload(); people.reload(); };
  const manager = async (handle) => {
    if (!handle) return undefined;
    const r = await api.get('/people', { q: handle.replace(/^@/, ''), limit: 5 });
    const m = r.find((x) => x.handle.toLowerCase() === handle.replace(/^@/, '').toLowerCase());
    if (!m) throw new Error(`No one with the handle ${handle}`);
    return m.id;
  };
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn small title="Add house" onPress={() => setHouse(true)} /><Btn small title="Add person" color={c.violet} onPress={() => setPerson(true)} /><Btn small title="Import roster" color={c.cyan} onPress={() => setImp(true)} />
      </View>
      <Section title="Houses & groups" color={c.cyan}>
        {houses.error ? <ErrorBox error={houses.error} onRetry={houses.reload} /> : !houses.data ? <Loading /> : houses.data.length ? houses.data.map((h) => <Row key={h.house_id} left={<T size={24}>{h.emoji ?? '🏠'}</T>} title={h.name} sub={`${h.kind} · ${h.members} people · ${h.points} pts`} />) : <Empty emoji="🏠" title="No houses yet" />}
      </Section>
      <Section title={`People${people.data ? ` (${people.data.length})` : ''}`} color={c.mint}>
        <Field value={q} onChangeText={setQ} placeholder="Search name or roll number…" />
        {people.error ? <ErrorBox error={people.error} onRetry={people.reload} /> : !people.data ? <Loading /> : people.data.length ? people.data.map((p) => (
          <Row key={p.id} title={p.full_name} sub={`${p.house ?? 'No house'}${p.grade ? ` · ${p.grade}` : ''}${p.roll_no ? ` · #${p.roll_no}` : ''} · ${p.nominations.length} sport(s)`} right={p.medical_hold ? <Tag label="medical hold" color={c.sunSoft} /> : null} />
        )) : <Empty emoji="🧑‍🎓" title="No one registered" sub="Add people one by one or import a roster." />}
      </Section>
      <FormSheet visible={house} onClose={() => setHouse(false)} title="New house / group" submitLabel="Create"
        fields={[{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Type', type: 'chips', options: ['house', 'group', 'class', 'region', 'club'] }, { key: 'color', label: 'Colour (e.g. #e11)', optional: true }, { key: 'manager', label: 'House master (handle)', optional: true, hint: 'They can nominate people, build teams and message this house.' }]}
        onSubmit={async ({ manager: m, ...v }) => { await api.post(`/events/${id}/houses`, { ...v, manager_user_id: await manager(m) }); refresh(); return 'House added'; }} />
      <FormSheet visible={person} onClose={() => setPerson(false)} title="Register a person" submitLabel="Add"
        fields={[{ key: 'full_name', label: 'Full name' }, { key: 'house_id', label: 'House', type: 'chips', optional: true, options: opts(houses.data, (h) => h.name, (h) => h.house_id) },
          { key: 'gender', label: 'Gender', type: 'chips', optional: true, options: ['male', 'female', 'other'] }, { key: 'grade', label: 'Class / age group', optional: true }, { key: 'roll_no', label: 'Roll number', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/participants`, v); refresh(); return 'Registered'; }} />
      <FormSheet visible={imp} onClose={() => setImp(false)} title="Import roster" submitLabel="Run"
        fields={[{ key: 'csv', label: 'One person per line', type: 'multiline', placeholder: 'full name, house, gender, grade, roll no', hint: 'Houses are created when missing. Existing roll numbers are skipped.' }, { key: 'dry_run', label: 'Dry run (check first, change nothing)', type: 'switch' }]}
        initial={{ dry_run: true }}
        onSubmit={async ({ csv, dry_run }) => {
          const rows = csv.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((r) => r[0]).map(([full_name, house, gender, grade, roll_no]) => ({ full_name, house: house || undefined, gender: ['male', 'female', 'other'].includes(gender) ? gender : undefined, grade: grade || undefined, roll_no: roll_no || undefined }));
          const r = await api.post(`/events/${id}/participants/import`, { rows, dry_run: !!dry_run });
          refresh();
          return `${r.committed ? 'Imported' : 'Would import'} ${r.would_create.participants} people${r.errors.length ? ` · ${r.errors.length} problem(s), first: row ${r.errors[0].row} ${r.errors[0].error}` : ''}`;
        }} />
    </>
  );
}

// ------------------------------------------------------------------ sports
function Sports({ id, toast }) {
  const [add, setAdd] = useState(false), [sel, setSel] = useState(null);
  const list = useLoad(() => api.get(`/events/${id}/disciplines`), [id]);
  return (
    <>
      <View style={{ marginTop: 12 }}><Btn small title="Add a sport" onPress={() => setAdd(true)} /></View>
      <Section title="Sports in this event" color={c.pink}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((d) => (
          <Row key={d.id} left={<T size={26}>{d.emoji}</T>} title={d.name} onPress={() => setSel(d)}
            sub={`${d.mode === 'team' ? `${d.teams} teams` : `${d.entrants} entered`}${d.gender !== 'any' ? ` · ${d.gender}` : ''} · ${d.sessions_done}/${d.sessions} sessions`} right={<Tag label={d.status} />} />
        )) : <Empty emoji="🏅" title="No sports yet" sub="Add athletics events, team games, anything — one person can enter several." />}
      </Section>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add a sport" submitLabel="Add" initial={{ mode: 'individual', gender: 'any', officials_required: 1, team_size_min: 5, team_size_max: 7 }}
        fields={[{ key: 'sport', label: 'Sport', type: 'sport' }, { key: 'name', label: 'Name', placeholder: 'e.g. 100m U14 girls' },
          { key: 'mode', label: 'Entered as', type: 'choice', options: [{ value: 'individual', label: 'Individuals' }, { value: 'team', label: 'Teams' }] },
          { key: 'gender', label: 'Open to', type: 'choice', options: [{ value: 'any', label: 'Anyone' }, { value: 'male', label: 'Boys / men' }, { value: 'female', label: 'Girls / women' }] },
          { key: 'team_size_min', label: 'Team size — minimum', type: 'stepper', min: 1, max: 50, show: (v) => v.mode === 'team' }, { key: 'team_size_max', label: 'Team size — maximum', type: 'stepper', min: 1, max: 50, show: (v) => v.mode === 'team' },
          { key: 'max_per_house', label: 'Entries per house (blank = no limit)', type: 'number', optional: true }, { key: 'officials_required', label: 'Officials per session', type: 'stepper', min: 0, max: 20 }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/disciplines`, { ...v, ...(v.mode === 'individual' ? { team_size_min: undefined, team_size_max: undefined } : {}) }); list.reload(); return 'Sport added'; }} />
      {sel ? <DisciplineSheet d={sel} id={id} toast={toast} onClose={() => { setSel(null); list.reload(); }} /> : null}
    </>
  );
}

function DisciplineSheet({ d, id, toast, onClose }) {
  const [nom, setNom] = useState(false), [advance, setAdvance] = useState(false), [heats, setHeats] = useState(false), [draw, setDraw] = useState(false);
  const people = useLoad(() => api.get(`/events/${id}/participants`, { limit: 100 }), [id]);
  const noms = useLoad(() => api.get(`/disciplines/${d.id}/nominations`), [d.id]);
  const teams = useLoad(() => (d.mode === 'team' ? api.get(`/disciplines/${d.id}/teams`) : Promise.resolve([])), [d.id]);
  const res = useLoad(() => api.get(`/disciplines/${d.id}/results`), [d.id]);
  const refresh = () => { noms.reload(); teams.reload(); res.reload(); };
  const done = useDo(toast, refresh);
  const made = res.data?.sessions?.length > 0;
  return (
    <Sheet visible onClose={onClose} title={d.name}>
      <View style={{ gap: 10 }}>
        <T color={c.mute}>{d.sport_name} · {d.mode === 'team' ? `teams of ${d.team_size_min}–${d.team_size_max}` : 'individual'} · points {Object.entries(d.points_table).map(([k, v]) => `${k}:${v}`).join(' ')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn small title="Nominate people" onPress={() => setNom(true)} />
          {d.mode === 'team' && !made ? <Btn small title="Build house teams" color={c.violet} onPress={() => done(() => api.post(`/disciplines/${d.id}/teams/build`, {}), (r) => `${r.built.length} team(s) built${r.skipped.length ? `, ${r.skipped.length} house(s) skipped: ${r.skipped[0].reason}` : ''}`)} /> : null}
          {!made && d.mode === 'individual' ? <Btn small title="Make heats" color={c.cyan} onPress={() => setHeats(true)} /> : null}
          {!made && d.mode === 'team' ? <Btn small title="Draw fixtures" color={c.cyan} onPress={() => setDraw(true)} /> : null}
          {made ? <Btn small title="Next round" color={c.orange} onPress={() => setAdvance(true)} /> : null}
          {made ? <Btn small title="Finalize & award points" color={c.lime} onPress={() => done(() => api.post(`/disciplines/${d.id}/finalize`), (r) => `${r.points_awarded} points awarded`)} /> : null}
          {d.finalized_at ? <Btn small title="Issue certificates" color={c.sun} onPress={() => done(() => api.post(`/disciplines/${d.id}/certificates`, { participation: true }), (r) => `${r.issued} certificate(s) issued`)} /> : null}
          {d.status !== 'cancelled' && d.status !== 'completed' ? <Btn small title="Cancel sport" color={c.paper} ink={c.red} onPress={() => done(() => api.patch(`/disciplines/${d.id}`, { status: 'cancelled' }), 'Sport cancelled — history is kept')} /> : null}
        </View>
        {res.data?.final_places?.length ? (
          <>
            <T weight="800">Final places</T>
            {res.data.final_places.map((p, i) => <Row key={i} title={`${p.rank}. ${p.team ?? p.full_name ?? p.house ?? 'Participant'}`} sub={p.house ? `House ${p.house}` : undefined} right={<T weight="800">{p.points} pts</T>} />)}
          </>
        ) : null}
        {res.data?.table ? (<><T weight="800">League table</T>{res.data.table.map((r) => <Row key={r.team_id} title={`${r.rank}. ${r.team}`} sub={`P${r.played} W${r.won} D${r.drawn} L${r.lost} · ${r.score_for}-${r.score_against}`} right={<T weight="800">{r.points}</T>} />)}</>) : null}
        <T weight="800">{d.mode === 'team' ? 'Teams' : 'Entered'}</T>
        {d.mode === 'team'
          ? (teams.data ?? []).map((t) => <Row key={t.id} title={t.name} sub={t.members.map((m) => m.full_name).join(', ')} />)
          : (noms.data ?? []).map((n) => <Row key={n.id} title={n.full_name} sub={`${n.house ?? 'No house'}${n.grade ? ` · ${n.grade}` : ''}`} right={<Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => done(() => api.post(`/nominations/${n.id}/withdraw`), 'Withdrawn')} />} />)}
        {d.mode === 'team' && (noms.data ?? []).filter((n) => !n.team_id).length ? <T size={12} color={c.mute}>{(noms.data ?? []).filter((n) => !n.team_id).length} nominated, not in a team yet.</T> : null}
      </View>
      <FormSheet visible={nom} onClose={() => setNom(false)} title={`Nominate for ${d.name}`} submitLabel="Nominate"
        fields={[{ key: 'participant_ids', label: 'Choose people', type: 'multi', options: opts(people.data, (p) => `${p.full_name}${p.house ? ` (${p.house})` : ''}`) }]}
        onSubmit={async (v) => { const r = await api.post(`/disciplines/${d.id}/nominations/bulk`, v); refresh(); return `${r.nominated} of ${r.requested} nominated${r.nominated < r.requested ? ` — ${r.results.find((x) => !x.ok).error}` : ''}`; }} />
      <FormSheet visible={heats} onClose={() => setHeats(false)} title="Qualifying heats" submitLabel="Create heats" initial={{ lanes: 8, duration_min: 15 }}
        fields={[{ key: 'lanes', label: 'Lanes per heat', type: 'stepper', min: 2, max: 24 }, { key: 'duration_min', label: 'Minutes per heat', type: 'stepper', min: 5, max: 600, step: 5 }]}
        onSubmit={async (v) => { const r = await api.post(`/disciplines/${d.id}/heats`, v); refresh(); return `${r.sessions.length} session(s) for ${r.entrants} entrants`; }} />
      <FormSheet visible={draw} onClose={() => setDraw(false)} title="Draw fixtures" submitLabel="Draw" initial={{ format: 'round_robin', duration_min: 40 }}
        fields={[{ key: 'format', label: 'Format', type: 'choice', options: [{ value: 'round_robin', label: 'Everyone plays everyone' }, { value: 'knockout', label: 'Knockout' }] }, { key: 'duration_min', label: 'Minutes per match', type: 'stepper', min: 5, max: 600, step: 5 }]}
        onSubmit={async (v) => { const r = await api.post(`/disciplines/${d.id}/draw`, v); refresh(); return `${r.sessions.length} match(es) drawn`; }} />
      <FormSheet visible={advance} onClose={() => setAdvance(false)} title="Next round" submitLabel="Create" initial={{ qualifiers_per_session: 2, wildcards: 0, lanes: 8, qualifiers: 4, third_place: false }}
        fields={d.mode === 'individual'
          ? [{ key: 'qualifiers_per_session', label: 'Qualify from each heat', type: 'stepper', min: 1, max: 24 }, { key: 'wildcards', label: 'Extra places for the next best', type: 'stepper', min: 0, max: 48 }, { key: 'lanes', label: 'Lanes in the next round', type: 'stepper', min: 2, max: 24 }]
          : [{ key: 'qualifiers', label: 'Teams through from the league (if any)', type: 'stepper', min: 2, max: 64 }, { key: 'third_place', label: 'Play a third-place game', type: 'switch' }]}
        onSubmit={async (v) => { const r = await api.post(`/disciplines/${d.id}/advance`, v); refresh(); return `${r.sessions.length} session(s) created, ${r.qualified} through`; }} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ schedule
function Schedule({ id, isOrg, toast }) {
  const [auto, setAuto] = useState(false), [sel, setSel] = useState(null), [mineOnly, setMineOnly] = useState(false);
  const { user } = useSession();
  const list = useLoad(() => api.get(`/events/${id}/sessions`, { limit: 100, mine: mineOnly ? 'true' : undefined }), [id, mineOnly]);
  const conf = useLoad(() => (isOrg ? api.get(`/events/${id}/schedule/conflicts`) : Promise.resolve(null)), [id, isOrg]);
  const refresh = () => { list.reload(); conf.reload(); };
  const sessions = list.data ?? [];
  const days = [...new Set(sessions.filter((s) => s.scheduled_at).map((s) => new Date(s.scheduled_at).toDateString()))];
  const draft = sessions.filter((s) => !s.scheduled_at);
  return (
    <>
      {user ? <View style={{ marginTop: 10 }}><Seg options={[{ value: false, label: 'Everything' }, { value: true, label: 'Only me' }]} value={mineOnly} onChange={setMineOnly} color={c.pink} /></View> : null}
      {isOrg ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <Btn small title="Auto-schedule" onPress={() => setAuto(true)} />
          {conf.data ? <Tag label={conf.data.ok ? 'No clashes' : `${conf.data.total} clash(es)`} color={conf.data.ok ? c.limeSoft : c.sunSoft} /> : null}
        </View>
      ) : null}
      {conf.data && !conf.data.ok ? (
        <Section title="Clashes to fix" color={c.sun}>
          {conf.data.conflicts.slice(0, 8).map((x, i) => <Row key={i} title={x.type.replace(/_/g, ' ')} sub={x.full_name ? `${x.full_name}: ${x.label_a ?? x.label} / ${x.label_b ?? ''}` : `${x.label_a ?? x.label} / ${x.label_b ?? ''}${x.ground ? ` @ ${x.ground}` : ''}`} color={c.sunSoft} />)}
        </Section>
      ) : null}
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : null}
      {days.map((dn) => (
        <Section key={dn} title={dn} color={c.cyan}>
          {sessions.filter((s) => s.scheduled_at && new Date(s.scheduled_at).toDateString() === dn).map((s) => <SessionRow key={s.id} s={s} onPress={() => setSel(s)} />)}
        </Section>
      ))}
      {draft.length ? <Section title={`Not scheduled (${draft.length})`} color={c.sun}>{draft.map((s) => <SessionRow key={s.id} s={s} onPress={isOrg ? () => setSel(s) : undefined} />)}</Section> : null}
      {list.data && !sessions.length ? <Empty emoji="🗓️" title="Nothing scheduled yet" sub={isOrg ? 'Make heats or draw fixtures on the Sports tab, then auto-schedule.' : 'The timetable will appear here.'} /> : null}
      <FormSheet visible={auto} onClose={() => setAuto(false)} title="Auto-schedule" submitLabel="Run" initial={{ days: 1, day_start: '09:00', day_end: '16:00', dry_run: true }}
        fields={[{ key: 'start', label: 'First day', type: 'date' }, { key: 'days', label: 'Days', type: 'stepper', min: 1, max: 14 }, { key: 'day_start', label: 'Day starts', type: 'time' }, { key: 'day_end', label: 'Day ends', type: 'time' },
          { key: 'lunch_start', label: 'Break from', type: 'time', optional: true }, { key: 'lunch_end', label: 'Break until', type: 'time', optional: true },
          { key: 'grounds', label: 'Grounds running in parallel', placeholder: 'Track, Main field, Court 1', hint: 'Comma separated. Nobody is ever put in two places, or without the rest gap.' },
          { key: 'dry_run', label: 'Preview only', type: 'switch' }]}
        onSubmit={async (v) => {
          const dates = Array.from({ length: v.days }, (_, k) => new Date(Date.parse(`${v.start}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10));
          const r = await api.post(`/events/${id}/schedule/auto`, { dates, day_start: v.day_start, day_end: v.day_end, timezone: zone(), breaks: v.lunch_start && v.lunch_end ? [{ start: v.lunch_start, end: v.lunch_end }] : [], grounds: v.grounds.split(',').map((x) => x.trim()).filter(Boolean).map((name) => ({ name })), dry_run: !!v.dry_run });
          refresh();
          return `${v.dry_run ? 'Would place' : 'Placed'} ${r.placed} session(s)${r.unplaced ? ` · ${r.unplaced} did not fit: ${r.unplaced_sessions[0].reason}` : ''}`;
        }} />
      {sel ? <SessionSheet s={sel} isOrg={isOrg} toast={toast} onClose={() => { setSel(null); refresh(); }} /> : null}
    </>
  );
}

const SessionRow = ({ s, onPress }) => (
  <Row title={s.label} onPress={onPress} sub={`${STAGE[s.stage] ?? s.stage}${s.scheduled_at ? ` · ${hm(s.scheduled_at)} (${s.duration_min} min)` : ''}${s.ground ? ` · ${s.ground}` : ''} · ${s.entrants} in`} right={<Tag label={s.status} color={c.violetSoft} />} />
);

function SessionSheet({ s, isOrg, toast, onClose }) {
  const [time, setTime] = useState(false), [vals, setVals] = useState({});
  const det = useLoad(() => api.get(`/sessions/${s.id}`), [s.id]);
  const d = det.data;
  const done = useDo(toast, () => det.reload());
  const team = d?.mode === 'team';
  const save = async (complete) => {
    const results = d.entries.filter((e) => e.result_status !== 'scratched').map((e) => ({ entry_id: e.id, ...(team ? { score: Number(vals[e.id] ?? e.score ?? 0) } : vals[e.id] !== undefined && vals[e.id] !== '' ? { value: Number(vals[e.id]) } : { status: 'dns' }) }));
    await done(() => api.post(`/sessions/${s.id}/results`, { results, complete }), complete ? 'Result recorded' : 'Saved');
  };
  return (
    <Sheet visible onClose={onClose} title={s.label}>
      {!d ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <T color={c.mute}>{STAGE[d.stage]} · {d.discipline}{d.scheduled_at ? ` · ${dayName(d.scheduled_at)} ${hm(d.scheduled_at)}` : ' · not scheduled'}{d.ground ?? d.location ? ` · ${d.location}` : ''}</T>
          {d.officials?.length ? <T>Officials: {d.officials.map((o) => `${o.display_name} (${o.role})`).join(', ')}</T> : null}
          {d.entries.map((e) => (
            <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T style={{ flex: 1 }} weight="700">{e.lane ? `L${e.lane} ` : ''}{e.team_name ?? e.full_name ?? 'Participant'}{e.house ? ` · ${e.house}` : ''}{e.result_status === 'scratched' ? ' (scratched)' : ''}</T>
              {e.position ? <Tag label={`#${e.position}`} color={c.limeSoft} /> : null}
              {isOrg && d.status !== 'cancelled' && e.result_status !== 'scratched' ? (
                <View style={{ width: 90 }}><Field value={String(vals[e.id] ?? e.result_value ?? e.score ?? '')} onChangeText={(x) => setVals((p) => ({ ...p, [e.id]: x.replace(/[^0-9.]/g, '') }))} keyboardType="decimal-pad" placeholder={team ? 'score' : d.result_type} /></View>
              ) : (e.result_value ?? e.score) != null ? <T weight="800">{e.result_value ?? e.score}</T> : null}
            </View>
          ))}
          {isOrg && d.status !== 'cancelled' ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Btn small title="Save result" color={c.lime} onPress={() => save(true)} />
              <Btn small title="Set time / ground" color={c.cyan} onPress={() => setTime(true)} />
              <Btn small title="Cancel session" color={c.paper} ink={c.red} onPress={() => done(() => api.patch(`/sessions/${s.id}`, { cancel: true }), 'Cancelled')} />
            </View>
          ) : null}
        </View>
      )}
      <FormSheet visible={time} onClose={() => setTime(false)} title="Time & ground" initial={{ duration_min: s.duration_min, location: s.location ?? '' }}
        fields={[{ key: 'date', label: 'Day', type: 'date' }, { key: 'time', label: 'Start', type: 'time', step: 5 }, { key: 'duration_min', label: 'Minutes', type: 'stepper', min: 5, max: 600, step: 5 }, { key: 'location', label: 'Ground', optional: true }, { key: 'allow_tight', label: 'Accept less rest than the programme rule', type: 'switch' }]}
        onSubmit={async (v) => { await api.patch(`/sessions/${s.id}`, { scheduled_at: localIso(v.date, v.time), duration_min: v.duration_min, location: v.location || undefined, allow_tight: !!v.allow_tight }); det.reload(); return 'Timetable updated'; }} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ standings
function Standings({ id }) {
  const [scope, setScope] = useState('house');
  const board = useLoad(() => api.get(`/events/${id}/leaderboard`, { scope }), [id, scope]);
  return (
    <>
      <View style={{ marginTop: 10 }}><Seg options={[{ value: 'house', label: 'Houses' }, { value: 'individual', label: 'Individuals' }, { value: 'team', label: 'Teams' }]} value={scope} onChange={setScope} color={c.pink} /></View>
      <Section title="Points" color={c.mint}>
        {board.error ? <ErrorBox error={board.error} onRetry={board.reload} /> : !board.data ? <Loading /> : board.data.rows.length ? board.data.rows.map((r) => (
          <Row key={r.subject_id ?? r.house_id} title={`${r.rank}. ${r.name ?? (scope === 'individual' ? `Participant (${r.house ?? '—'})` : '—')}`} sub={`🥇 ${r.gold}  🥈 ${r.silver}  🥉 ${r.bronze}${scope !== 'house' && r.house ? ` · ${r.house}` : ''}`} right={<T weight="800" size={22}>{r.points}</T>} />
        )) : <Empty emoji="📊" title="No points yet" sub="Points appear when a sport is finalized." />}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ crew & medical
function Crew({ id, toast }) {
  const [hire, setHire] = useState(false), [shift, setShift] = useState(null), [pay, setPay] = useState(null);
  const staff = useLoad(() => api.get(`/events/${id}/staff`), [id]);
  const gaps = useLoad(() => api.get(`/events/${id}/staffing-gaps`), [id]);
  const shifts = useLoad(() => api.get(`/events/${id}/shifts`), [id]);
  const sessions = useLoad(() => api.get(`/events/${id}/sessions`, { limit: 100, status: 'scheduled' }), [id]);
  const incidents = useLoad(() => api.get(`/events/${id}/medical-incidents`).catch(() => []), [id]);
  const refresh = () => { staff.reload(); gaps.reload(); shifts.reload(); };
  const done = useDo(toast, refresh);
  const findUser = async (handle) => {
    const r = await api.get('/people', { q: handle.replace(/^@/, ''), limit: 5 });
    const m = r.find((x) => x.handle.toLowerCase() === handle.replace(/^@/, '').toLowerCase());
    if (!m) throw new Error(`No one with the handle ${handle}`);
    return m.id;
  };
  return (
    <>
      <View style={{ marginTop: 12 }}><Btn small title="Hire referee / physio / doctor / volunteer" onPress={() => setHire(true)} /></View>
      {gaps.data && !gaps.data.ok ? (
        <Section title="Not covered yet" color={c.sun}>
          {gaps.data.sessions_missing_officials.slice(0, 5).map((g) => <Row key={`o${g.session_id}`} color={c.sunSoft} title={`${g.label}`} sub={`Needs ${g.required - g.assigned} more official(s) · ${dayName(g.scheduled_at)} ${hm(g.scheduled_at)}`} />)}
          {gaps.data.sessions_without_medical_cover.slice(0, 5).map((g) => <Row key={`m${g.session_id}`} color={c.sunSoft} title={`${g.label}`} sub={`No doctor / physio on cover · ${dayName(g.scheduled_at)} ${hm(g.scheduled_at)}`} />)}
        </Section>
      ) : null}
      <Section title="Crew" color={c.orange}>
        {staff.error ? <ErrorBox error={staff.error} onRetry={staff.reload} /> : !staff.data ? <Loading /> : staff.data.length ? staff.data.map((m) => (
          <Row key={m.id} title={`${m.display_name} · ${m.role}`} sub={`${m.status}${m.rate_cents ? ` · ${(m.rate_cents / 100).toFixed(2)} ${m.currency} (paid ${(m.paid_cents / 100).toFixed(2)})` : ''} · ${m.shifts} shift(s)`}
            right={['invited', 'accepted'].includes(m.status) ? <View style={{ gap: 6 }}>{m.status === 'accepted' ? <Btn small title="Assign" onPress={() => setShift(m)} /> : null}{m.rate_cents ? <Btn small title="Paid" color={c.paper} ink={c.ink} onPress={() => setPay(m)} /> : null}<Btn small title="Release" color={c.paper} ink={c.red} onPress={() => done(() => api.post(`/event-staff/${m.id}/release`, {}), 'Released')} /></View> : null} />
        )) : <Empty emoji="🤝" title="No crew yet" sub="Hire referees for each sport, plus physios and doctors for cover." />}
      </Section>
      <Section title="Duty roster" color={c.cyan}>
        {(shifts.data ?? []).length ? shifts.data.map((s) => <Row key={s.id} title={`${s.display_name} · ${s.session ?? s.kind.replace('_', ' ')}`} sub={`${dayName(s.starts_at)} ${hm(s.starts_at)}–${hm(s.ends_at)}${s.location ? ` · ${s.location}` : ''}`} right={<Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => done(() => api.post(`/shifts/${s.id}/cancel`), 'Removed')} />} />) : <Empty emoji="🗒️" title="No shifts yet" />}
      </Section>
      <Section title="Medical log" color={c.red}>
        {(incidents.data ?? []).length ? incidents.data.map((m) => <Row key={m.id} title={`${m.full_name ?? 'Participant'} · ${m.severity}`} sub={`${m.outcome.replace('_', ' ')}${m.return_to_play ? ` · ${m.return_to_play.replace('_', ' ')}` : ''}`} />) : <Empty emoji="🩺" title="No incidents" sub="Event doctors and physios log incidents from their own account. You see severity and fitness only, never clinical text." />}
      </Section>
      <FormSheet visible={hire} onClose={() => setHire(false)} title="Hire crew" submitLabel="Send invitation" initial={{ role: 'referee', rate: '' }}
        fields={[{ key: 'role', label: 'Role', type: 'chips', options: ROLES }, { key: 'handle', label: 'Their handle', hint: 'A doctor post needs the doctor role on SportArena, a physio post the physio role, officials the referee role.' },
          { key: 'sport', label: 'Sport they officiate', type: 'sport', optional: true, show: (v) => ['referee', 'umpire', 'judge', 'starter', 'timekeeper'].includes(v.role) }, { key: 'rate', label: 'Fee (whole currency units)', type: 'number', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/staff`, { user_id: await findUser(v.handle), role: v.role, sport: v.sport || undefined, rate_cents: Math.round(Number(v.rate || 0) * 100) }); refresh(); return 'Invitation sent'; }} />
      {shift ? (
        <FormSheet visible onClose={() => setShift(null)} title={`Assign ${shift.display_name}`} submitLabel="Assign" initial={{}}
          fields={['referee', 'umpire', 'judge', 'starter', 'timekeeper', 'scorer'].includes(shift.role)
            ? [{ key: 'session_id', label: 'Session', type: 'chips', options: opts(sessions.data, (s) => `${s.label} · ${s.scheduled_at ? hm(s.scheduled_at) : ''}`) }]
            : [{ key: 'date', label: 'Day', type: 'date' }, { key: 'from', label: 'From', type: 'time' }, { key: 'to', label: 'Until', type: 'time' }, { key: 'location', label: 'Where', optional: true }]}
          onSubmit={async (v) => { await api.post(`/event-staff/${shift.id}/shifts`, v.session_id ? { session_id: v.session_id } : { starts_at: localIso(v.date, v.from), ends_at: localIso(v.date, v.to), location: v.location || undefined }); refresh(); return 'Shift assigned'; }} />
      ) : null}
      {pay ? <FormSheet visible onClose={() => setPay(null)} title={`Payment to ${pay.display_name}`} submitLabel="Record" fields={[{ key: 'amount', label: 'Amount paid', type: 'number' }]}
        onSubmit={async (v) => { await api.post(`/event-staff/${pay.id}/payments`, { amount_cents: Math.round(Number(v.amount) * 100) }); refresh(); return 'Recorded'; }} /> : null}
    </>
  );
}

// ------------------------------------------------------------------ awards
function Awards({ id, toast }) {
  const [troph, setTroph] = useState(false), [give, setGive] = useState(null), [cert, setCert] = useState(false);
  const certs = useLoad(() => api.get(`/events/${id}/certificates`, { limit: 100 }), [id]);
  const trophies = useLoad(() => api.get(`/events/${id}/trophies`), [id]);
  const houses = useLoad(() => api.get(`/events/${id}/houses`), [id]);
  const refresh = () => { certs.reload(); trophies.reload(); };
  const done = useDo(toast, refresh);
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn small title="New trophy" onPress={() => setTroph(true)} /><Btn small title="Special certificate" color={c.violet} onPress={() => setCert(true)} />
      </View>
      <Section title="Trophies" color={c.sun}>
        {(trophies.data ?? []).length ? trophies.data.map((t) => (
          <Row key={t.id} left={<T size={26}>🏆</T>} title={t.name} sub={t.holder ? `Held by ${t.holder.team ?? t.holder.participant ?? t.holder.house}` : `${t.scope} trophy — not awarded`}
            right={<View style={{ gap: 6 }}><Btn small title="Award to leader" onPress={() => done(() => api.post(`/trophies/${t.id}/award`, { auto: true }), (r) => `Awarded to ${r.recipient}`)} />{t.scope === 'house' ? <Btn small title="Choose house" color={c.paper} ink={c.ink} onPress={() => setGive(t)} /> : null}</View>} />
        )) : <Empty emoji="🏆" title="No trophies yet" sub="Overall house champion, best athlete, a cup per sport…" />}
      </Section>
      <Section title={`Certificates${certs.data ? ` (${certs.data.length})` : ''}`} color={c.mint}>
        {(certs.data ?? []).slice(0, 40).map((x) => <Row key={x.id} title={x.title} sub={`${x.recipient_name} · code ${x.code}${x.revoked_at ? ' · revoked' : ''}`} right={!x.revoked_at ? <Btn small title="Revoke" color={c.paper} ink={c.red} onPress={() => done(() => api.post(`/certificates/${x.code}/revoke`, { reason: 'Issued in error' }), 'Revoked')} /> : null} />)}
        {certs.data && !certs.data.length ? <Empty emoji="📜" title="None issued" sub="Finalize a sport, then issue its certificates from the Sports tab." /> : null}
      </Section>
      <FormSheet visible={troph} onClose={() => setTroph(false)} title="New trophy" submitLabel="Create" initial={{ scope: 'house' }}
        fields={[{ key: 'name', label: 'Name', placeholder: 'e.g. Champion House Shield' }, { key: 'scope', label: 'Goes to', type: 'choice', options: [{ value: 'house', label: 'A house' }, { value: 'individual', label: 'A person' }, { value: 'team', label: 'A team' }] }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/trophies`, v); refresh(); return 'Trophy created'; }} />
      <FormSheet visible={cert} onClose={() => setCert(false)} title="Special certificate" submitLabel="Issue"
        fields={[{ key: 'title', label: 'Title', placeholder: 'e.g. Spirit of the Games' }, { key: 'house_id', label: 'House', type: 'chips', options: opts(houses.data, (h) => h.name, (h) => h.house_id) }, { key: 'citation', label: 'Citation', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/certificates`, { ...v, kind: 'custom' }); refresh(); return 'Issued'; }} />
      {give ? <FormSheet visible onClose={() => setGive(null)} title={`Award ${give.name}`} submitLabel="Award" fields={[{ key: 'house_id', label: 'House', type: 'chips', options: opts(houses.data, (h) => h.name, (h) => h.house_id) }]}
        onSubmit={async (v) => { await api.post(`/trophies/${give.id}/award`, v); refresh(); return 'Awarded'; }} /> : null}
    </>
  );
}

// ------------------------------------------------------------------ messages
function Messages({ id, isOrg, myHouses, toast }) {
  const [send, setSend] = useState(false);
  const list = useLoad(() => api.get(`/events/${id}/announcements`), [id]);
  const houses = useLoad(() => api.get(`/events/${id}/houses`), [id]);
  const sports = useLoad(() => (isOrg ? api.get(`/events/${id}/disciplines`) : Promise.resolve([])), [id, isOrg]);
  const canSend = isOrg || myHouses.length > 0;
  const audiences = isOrg ? ['all', 'house', 'discipline', 'staff'] : ['house'];
  return (
    <>
      {canSend ? <View style={{ marginTop: 12 }}><Btn small title="Send an announcement" onPress={() => setSend(true)} /></View> : null}
      <Section title="Announcements" color={c.cyan}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((a) => (
          <Row key={a.id} color={a.urgent ? c.sunSoft : c.paper} title={`${a.urgent ? '🚨 ' : ''}${a.title}`} sub={`${a.body}\n${a.sent_by} · ${dayName(a.created_at)} ${hm(a.created_at)}${isOrg ? ` · ${a.recipients} reached` : ''}`} />
        )) : <Empty emoji="📣" title="No announcements" />}
      </Section>
      <FormSheet visible={send} onClose={() => setSend(false)} title="Announcement" submitLabel="Send" initial={{ audience: audiences[0], house_id: myHouses[0]?.id }}
        fields={[{ key: 'audience', label: 'To', type: 'chips', options: audiences.map((v) => ({ value: v, label: { all: 'Everyone', house: 'One house', discipline: 'One sport', staff: 'Crew' }[v] })) },
          { key: 'house_id', label: 'House', type: 'chips', show: (v) => v.audience === 'house', options: isOrg ? opts(houses.data, (h) => h.name, (h) => h.house_id) : myHouses.map((h) => ({ value: h.id, label: h.name })) },
          { key: 'discipline_id', label: 'Sport', type: 'chips', show: (v) => v.audience === 'discipline', options: opts(sports.data, (d) => d.name) },
          { key: 'title', label: 'Title' }, { key: 'body', label: 'Message', type: 'multiline' }, { key: 'urgent', label: 'Urgent', type: 'switch' }]}
        onSubmit={async (v) => { const r = await api.post(`/events/${id}/announcements`, v); list.reload(); return `Sent to ${r.recipients} people`; }} />
    </>
  );
}
