import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, when, day } from '../theme';
import { moneyIn } from '../vtime';

export const AVAIL = {
  available: ['✅', 'Available', c.mint], tentative: ['🤔', 'Maybe', c.sun], unavailable: ['⛔', 'Unavailable', c.orange], injured: ['🤕', 'Injured', c.pink],
};
const ROLES = [['player', 'Player'], ['captain', 'Captain'], ['coach', 'Coach'], ['manager', 'Manager'], ['physio', 'Physio']];
const SQUAD_ROLES = [['player', 'Player'], ['captain', 'Captain'], ['vice_captain', 'Vice-captain'], ['substitute', 'Sub'], ['coach', 'Coach'], ['physio', 'Physio'], ['manager', 'Manager']];
const UNITS = [['match', 'per match'], ['hour', 'per hour'], ['month', 'per month'], ['season', 'per season']];
const unitLabel = (u) => (UNITS.find(([k]) => k === u) ?? [, u])[1];
const rateText = (m, cur) => (m.rate_cents != null ? `${moneyIn(m.rate_cents, cur)} ${unitLabel(m.rate_unit)}` : null);
const SELECTION = { selected: ['Selected', c.violet], confirmed: ['Confirmed', c.mint], declined: ['Declined', c.orange] };

/** Pick availability for yourself or (as a manager) for a player. */
export function AvailabilityPicker({ teamId, userId, value, note, onDone }) {
  const { toast } = useSession();
  const [n, setN] = useState(note ?? '');
  const set = async (availability) => {
    try { await api.patch(`/teams/${teamId}/members/${userId}/availability`, { availability, note: n.trim() || null }); toast('Availability updated'); onDone?.(); } catch (e) { toast('' + e.message); }
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {Object.entries(AVAIL).map(([k, [e, l]]) => <Chip key={k} label={`${e} ${l}`} active={k === value} onPress={() => set(k)} />)}
      </View>
      <Field value={n} onChangeText={setN} placeholder="Add a note, e.g. back from injury on the 20th (optional)" />
    </View>
  );
}

export function TeamManage({ id }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('roster');
  const team = useLoad(() => api.get(`/teams/${id}`), [id]);
  const roster = useLoad(() => api.get(`/teams/${id}/roster`), [id]);
  if (team.error || roster.error) return <Screen><ErrorBox error={team.error ?? roster.error} onRetry={() => { team.reload(); roster.reload(); }} /></Screen>;
  if (!team.data || !roster.data) return <Screen><Loading /></Screen>;
  const t = team.data, r = roster.data;
  if (!r.can_manage) return <Screen><Empty emoji="🔒" title="Managers only" sub="Only the team owner or managers can manage this team." /></Screen>;
  const P = { t, r, reload: () => { team.reload(); roster.reload(); }, toast };
  const tabs = [['roster', 'Roster'], ['squads', 'Matches & squads'], ['recruit', 'Recruit'], ...(r.can_manage_money ? [['money', 'Rates & settlement']] : [])];
  return (
    <Screen wide>
      <GradCard colors={[t.color, c.ink]}>
        <T size={44}>{t.emoji}</T><H1 color="#fff" style={{ fontSize: 28 }}>{t.name}</H1>
        <T color="#fff" weight="800">Team management · {t.sport_emoji} {t.sport} · pays in {r.currency}</T>
      </GradCard>
      <View style={{ marginTop: 10 }}><Seg options={tabs.map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.violet} /></View>
      {tab === 'roster' ? <RosterTab {...P} /> : tab === 'squads' ? <SquadsTab {...P} /> : tab === 'recruit' ? <RecruitTab {...P} /> : <MoneyTab {...P} />}
    </Screen>
  );
}

// ------------------------------------------------------------------ roster
export function RosterTab({ t, r, reload, toast }) {
  const [sel, setSel] = useState(null);
  const [edit, setEdit] = useState(null);
  const [find, setFind] = useState(null);
  const active = r.members.filter((m) => m.status === 'active');
  const invited = r.members.filter((m) => m.status === 'invited');
  const counts = Object.keys(AVAIL).map((k) => [k, active.filter((m) => m.availability === k).length]);
  const remove = async (m) => { try { await api.del(`/teams/${t.id}/members/${m.id}`); toast(`${m.display_name} removed`); setSel(null); reload(); } catch (e) { toast('' + e.message); } };
  const cur = sel && r.members.find((m) => m.id === sel);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{counts.map(([k, n]) => <Tag key={k} label={`${AVAIL[k][0]} ${n} ${AVAIL[k][1].toLowerCase()}`} />)}</View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <View style={{ flex: 1 }}><Btn small title="Find players" onPress={() => setFind('player')} /></View>
        <View style={{ flex: 1 }}><Btn small title="Find a coach" color={c.violet} onPress={() => setFind('coach')} /></View>
      </View>
      <Section title="Players & staff" color={c.cyan}>
        {active.map((m) => (
          <Row key={m.id} onPress={() => setSel(m.id)} left={<Avatar user={m} />} title={`${m.jersey_no != null ? '#' + m.jersey_no + ' ' : ''}${m.display_name}`}
            sub={[m.team_role, m.position, m.availability !== 'available' ? m.availability_note : null].filter(Boolean).join(' · ')}
            right={<Tag label={`${AVAIL[m.availability][0]} ${AVAIL[m.availability][1]}`} />} />
        ))}
      </Section>
      {invited.length ? <Section title="Invitations sent" color={c.sun}>{invited.map((m) => <Row key={m.id} left={<Avatar user={m} />} title={m.display_name} sub={`${m.team_role}${rateText(m, r.currency) ? ' · ' + rateText(m, r.currency) : ''} · waiting for an answer`} />)}</Section> : null}

      <Sheet visible={!!cur} onClose={() => setSel(null)} title={cur?.display_name ?? ''}>
        {cur ? <>
          <T color={c.mute}>{cur.team_role}{cur.position ? ` · ${cur.position}` : ''}{rateText(cur, r.currency) && r.can_manage_money ? ` · ${rateText(cur, r.currency)}` : ''}</T>
          <T weight="800" size={13}>Availability</T>
          <AvailabilityPicker teamId={t.id} userId={cur.id} value={cur.availability} note={cur.availability_note} onDone={reload} />
          <Btn title="Edit role, jersey, position & rate" onPress={() => { setEdit(cur); setSel(null); }} />
          {!cur.is_owner ? <Btn title="Remove from team" color={c.orange} onPress={() => remove(cur)} /> : <T size={12} color={c.mute}>The owner can't be removed.</T>}
        </> : null}
      </Sheet>

      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.display_name ?? ''}`} submitLabel="Save"
        initial={edit ? { role: edit.team_role, jersey_no: edit.jersey_no ?? '', position: edit.position ?? '', notes: edit.notes ?? '', rate_cents: edit.rate_cents ?? '', rate_unit: edit.rate_unit ?? 'match' } : {}}
        fields={[
          { key: 'role', label: 'Role', type: 'chips', options: ROLES.map(([value, label]) => ({ value, label })) },
          { key: 'jersey_no', label: 'Jersey number', type: 'number', optional: true },
          { key: 'position', label: 'Position / batting order', optional: true },
          { key: 'notes', label: 'Private notes (managers only)', type: 'multiline', optional: true },
          ...(r.can_manage_money ? [{ key: 'rate_cents', label: `Agreed fee (${r.currency})`, type: 'money', currency: r.currency, optional: true }, { key: 'rate_unit', label: 'Fee is', type: 'chips', options: UNITS.map(([value, label]) => ({ value, label })) }] : []),
        ]}
        onSubmit={async (v) => {
          const body = { role: v.role, jersey_no: v.jersey_no === '' ? null : Number(v.jersey_no), position: v.position || null, notes: v.notes || null };
          if (r.can_manage_money) { if (v.rate_cents !== '' && v.rate_cents != null) body.rate_cents = v.rate_cents; body.rate_unit = v.rate_unit; }
          await api.patch(`/teams/${t.id}/members/${edit.id}`, body); reload(); return 'Saved';
        }} />
      <FindPeople mode={find} team={t} currency={r.currency} money={r.can_manage_money} onClose={() => setFind(null)} onInvited={reload} />
    </>
  );
}

/** Search the wider community for players or coaches of this sport and invite them. */
function FindPeople({ mode, team, currency, money, onClose, onInvited }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null);
  const res = useLoad(() => (mode ? (mode === 'coach' ? api.get('/coaches', { sport: team.sport_id, q: q.trim() || undefined, limit: 30 }) : api.get('/people', { role: 'athlete', sport: team.sport_id, q: q.trim() || undefined, limit: 30 })) : []), [mode, q, team.sport_id]);
  const have = new Set(team.members.map((m) => m.id));
  return (
    <>
      <Sheet visible={!!mode && !pick} onClose={onClose} title={mode === 'coach' ? `Coaches for ${team.sport}` : `${team.sport} players`}>
        <Field value={q} onChangeText={setQ} placeholder="Search by name or @handle" />
        {res.loading && !res.data ? <Loading /> : null}
        {(res.data ?? []).filter((p) => !have.has(p.id)).map((p) => (
          <Row key={p.id} left={<Avatar user={p} />} title={p.display_name} sub={[`@${p.handle}`, p.level, mode === 'coach' && p.hourly_rate_cents != null ? `${moneyIn(p.hourly_rate_cents, currency)}/hr` : null].filter(Boolean).join(' · ')} right={<Btn small title="Invite" onPress={() => setPick(p)} />} />
        ))}
        {res.data && !res.data.filter((p) => !have.has(p.id)).length ? <Empty emoji="🔎" title="Nobody found" sub="Try another name, or post to the Recruit tab so people can come to you." /> : null}
      </Sheet>
      <FormSheet visible={!!pick} onClose={() => setPick(null)} title={`Invite ${pick?.display_name ?? ''}`} submitLabel="Send invitation"
        initial={{ role: mode === 'coach' ? 'coach' : 'player', rate_unit: mode === 'coach' ? 'month' : 'match' }}
        fields={[
          { key: 'role', label: 'Role', type: 'chips', options: ROLES.map(([value, label]) => ({ value, label })) },
          ...(money ? [{ key: 'rate_cents', label: `Fee offered (${currency})`, type: 'money', currency, optional: true }, { key: 'rate_unit', label: 'Fee is', type: 'chips', options: UNITS.map(([value, label]) => ({ value, label })) }] : []),
          { key: 'message', label: 'Message', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          const body = { user_id: pick.id, role: v.role, message: v.message || undefined };
          if (money) { if (v.rate_cents !== '' && v.rate_cents != null) body.rate_cents = v.rate_cents; body.rate_unit = v.rate_unit; }
          await api.post(`/teams/${team.id}/invitations`, body); onInvited(); setPick(null); onClose(); return 'Invitation sent';
        }} />
    </>
  );
}

// ------------------------------------------------------------------ matches & squads
export function SquadsTab({ t, r, toast }) {
  const sch = useLoad(() => api.get(`/teams/${t.id}/schedule`), [t.id]);
  const [scope, setScope] = useState(null);
  if (sch.loading && !sch.data) return <Loading />;
  if (sch.error) return <ErrorBox error={sch.error} onRetry={sch.reload} />;
  const { fixtures, events } = sch.data;
  const chip = (sq) => (sq?.selected ? `${sq.confirmed}/${sq.selected} confirmed` : 'No squad yet');
  return (
    <>
      <Section title="Upcoming matches" color={c.pink}>
        {fixtures.length ? fixtures.map((f) => (
          <Row key={f.fixture_id} onPress={() => setScope({ fixture_id: f.fixture_id, title: `${f.home_name ?? 'TBD'} v ${f.away_name ?? 'TBD'}`, sub: `${f.event_name} · ${when(f.scheduled_at)}` })}
            left={<T size={26}>🏏</T>} title={`${f.home_name ?? 'TBD'} v ${f.away_name ?? 'TBD'}`} sub={`${f.event_name}${f.round ? ' · ' + f.round : ''} · ${when(f.scheduled_at)}`} right={<Tag label={chip(f.squad)} />} />
        )) : <Empty emoji="📅" title="No matches scheduled" sub="Matches appear here once an organiser schedules your team." />}
      </Section>
      <Section title="Events entered" color={c.violet}>
        {events.length ? events.map((e) => (
          <Row key={e.event_id} onPress={() => setScope({ event_id: e.event_id, title: e.name, sub: `${e.kind}${e.starts_on ? ' · ' + day(e.starts_on) : ''}` })}
            left={<T size={26}>🎟️</T>} title={e.name} sub={`${e.kind}${e.starts_on ? ' · ' + day(e.starts_on) : ''} · entry ${e.entry_status}`} right={<Tag label={chip(e.squad)} />} />
        )) : <Empty emoji="🎟️" title="Not entered in any event" sub="Enter a team from an event page, then pick who plays here." />}
      </Section>
      <SquadEditor scope={scope} t={t} r={r} toast={toast} onClose={() => setScope(null)} onSaved={sch.reload} />
    </>
  );
}

function SquadEditor({ scope, t, r, toast, onClose, onSaved }) {
  const q = scope ? (scope.fixture_id ? { fixture_id: scope.fixture_id } : { event_id: scope.event_id }) : null;
  const cur = useLoad(() => (q ? api.get(`/teams/${t.id}/squad`, q) : []), [scope?.fixture_id, scope?.event_id]);
  const [picked, setPicked] = useState(null);   // user_id -> { role, position }
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = picked ?? Object.fromEntries((cur.data ?? []).map((x) => [x.id, { role: x.role, position: x.position }]));
  const status = Object.fromEntries((cur.data ?? []).map((x) => [x.id, x.status]));
  const toggle = (m) => { const n = { ...state }; if (n[m.id]) delete n[m.id]; else n[m.id] = { role: m.team_role === 'coach' ? 'coach' : m.team_role === 'physio' ? 'physio' : m.team_role === 'manager' ? 'manager' : 'player' }; setPicked(n); };
  const role = (m, v) => setPicked({ ...state, [m.id]: { ...state[m.id], role: v } });
  const close = () => { setPicked(null); setForce(false); onClose(); };
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/teams/${t.id}/squad`, { ...q, allow_unavailable: force, members: Object.entries(state).map(([user_id, v]) => ({ user_id, role: v.role, position: v.position || undefined })) });
      toast('Squad saved — selected players are notified'); onSaved(); close();
    } catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };
  const fees = async () => {
    try { const o = await api.post(`/teams/${t.id}/payouts/from-squad`, q); toast(`${o.created.length} fee(s) added to settlement${o.skipped.length ? `, ${o.skipped.length} skipped` : ''}`); } catch (e) { toast('' + e.message); }
  };
  const members = r.members.filter((m) => m.status === 'active');
  const blocked = members.filter((m) => state[m.id] && ['unavailable', 'injured'].includes(m.availability));
  return (
    <Sheet visible={!!scope} onClose={close} title={scope?.title ?? ''}>
      <T color={c.mute}>{scope?.sub}</T>
      <T size={13} color={c.mute}>Tap people to select them, then choose each person's role.</T>
      {cur.loading && !cur.data ? <Loading /> : members.map((m) => {
        const on = !!state[m.id];
        return (
          <Card key={m.id} color={on ? c.violetSoft : c.paper} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Avatar user={m} size={36} />
              <View style={{ flex: 1 }}>
                <T weight="700">{m.jersey_no != null ? `#${m.jersey_no} ` : ''}{m.display_name}</T>
                <T size={12} color={c.mute}>{AVAIL[m.availability][0]} {AVAIL[m.availability][1]}{m.position ? ` · ${m.position}` : ''}{status[m.id] && SELECTION[status[m.id]] ? ` · ${SELECTION[status[m.id]][0]}` : ''}</T>
              </View>
              <Btn small title={on ? 'Selected ✓' : 'Select'} color={on ? c.violet : c.paper} onPress={() => toggle(m)} />
            </View>
            {on ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{SQUAD_ROLES.map(([k, l]) => <Chip key={k} label={l} active={state[m.id].role === k} onPress={() => role(m, k)} />)}</View> : null}
          </Card>
        );
      })}
      {blocked.length ? <>
        <T color={c.orange} weight="700">{blocked.map((m) => m.display_name).join(', ')} {blocked.length > 1 ? 'are' : 'is'} marked unavailable or injured.</T>
        <Chip label={force ? 'Selecting them anyway ✓' : 'Select them anyway'} active={force} onPress={() => setForce(!force)} />
      </> : null}
      <Btn title={`Save squad (${Object.keys(state).length})`} loading={busy} onPress={save} />
      {r.can_manage_money && (cur.data ?? []).length ? <Btn title="Add match fees to settlement" color={c.violet} onPress={fees} /> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ recruit
export function RecruitTab({ t, toast }) {
  const posts = useLoad(() => api.get('/billboard', { mine: true, include_closed: true, limit: 50 }), [t.id]);
  const [form, setForm] = useState(null);
  const [open, setOpen] = useState(null);
  const mine = (posts.data ?? []).filter((p) => p.team_id === t.id && ['team_recruiting', 'coach_wanted'].includes(p.kind));
  const post = (kind) => (
    <FormSheet visible={form === kind} onClose={() => setForm(null)} title={kind === 'coach_wanted' ? 'Advertise for a coach' : 'Advertise for players'} submitLabel="Post to the billboard"
      initial={{ title: '', positions_needed: 1, rate_unit: kind === 'coach_wanted' ? 'month' : 'match' }}
      fields={[
        { key: 'title', label: 'Headline' },
        { key: 'body', label: 'What you are looking for', type: 'multiline', optional: true },
        { key: 'positions_needed', label: kind === 'coach_wanted' ? 'Coaches needed' : 'Players needed', type: 'stepper', min: 1, max: 50, default: 1 },
        { key: 'budget_cents', label: `What you pay (${t.currency})`, type: 'money', currency: t.currency, optional: true },
        { key: 'rate_unit', label: 'Paid', type: 'chips', options: UNITS.map(([value, label]) => ({ value, label })) },
        { key: 'city', label: 'City', optional: true },
      ]}
      onSubmit={async (v) => {
        const body = { kind, team_id: t.id, sport: t.sport_id, title: v.title, body: v.body || undefined, positions_needed: Number(v.positions_needed) || 1, rate_unit: v.rate_unit, city: v.city || t.city || undefined };
        if (v.budget_cents !== '' && v.budget_cents != null) body.budget_cents = v.budget_cents;
        await api.post('/billboard', body); posts.reload(); return 'Posted — people can now apply';
      }} />
  );
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <View style={{ flex: 1 }}><Btn small title="Players wanted" onPress={() => setForm('team_recruiting')} /></View>
        <View style={{ flex: 1 }}><Btn small title="Coach wanted" color={c.violet} onPress={() => setForm('coach_wanted')} /></View>
      </View>
      <T size={13} color={c.mute} style={{ marginTop: 6 }}>Posts go on the billboard. When you accept someone, they join the roster at the fee you advertised.</T>
      <Section title="Your team's posts" color={c.pink}>
        {posts.loading && !posts.data ? <Loading /> : mine.length ? mine.map((p) => (
          <Row key={p.id} onPress={() => setOpen(p)} left={<T size={26}>{p.kind === 'coach_wanted' ? '🧑‍🏫' : '📣'}</T>} title={p.title}
            sub={`${p.kind === 'coach_wanted' ? 'Coach' : 'Players'} · ${p.accepted}/${p.positions_needed} filled${p.budget_cents ? ` · ${moneyIn(p.budget_cents, t.currency)} ${unitLabel(p.rate_unit)}` : ''}`} right={<Tag label={p.status} />} />
        )) : <Empty emoji="📣" title="No posts yet" sub="Advertise for players or a coach and review the applications here." />}
      </Section>
      {post('team_recruiting')}{post('coach_wanted')}
      <Responses post={open} toast={toast} onClose={() => setOpen(null)} onChanged={posts.reload} />
    </>
  );
}

function Responses({ post, toast, onClose, onChanged }) {
  const res = useLoad(() => (post ? api.get(`/billboard/${post.id}/responses`) : []), [post?.id]);
  const decide = async (r, status) => { try { await api.patch(`/billboard/responses/${r.response_id}`, { status }); toast(status === 'accepted' ? `${r.display_name} joined the team` : 'Declined'); res.reload(); onChanged(); } catch (e) { toast('' + e.message); } };
  const close = async () => { try { await api.post(`/billboard/${post.id}/close`); toast('Post closed'); onChanged(); onClose(); } catch (e) { toast('' + e.message); } };
  return (
    <Sheet visible={!!post} onClose={onClose} title={post?.title ?? ''}>
      {res.loading && !res.data ? <Loading /> : (res.data ?? []).length ? res.data.map((r) => (
        <Row key={r.response_id} left={<Avatar user={r} />} title={r.display_name} sub={r.message || `@${r.handle}`}
          right={r.status === 'pending' ? <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="Accept" onPress={() => decide(r, 'accepted')} /><Btn small title="No" color={c.paper} ink={c.ink} onPress={() => decide(r, 'declined')} /></View> : <Tag label={r.status} />} />
      )) : <Empty emoji="⏳" title="No applications yet" />}
      {post?.status === 'open' ? <Btn title="Close this post" color={c.orange} onPress={close} /> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ rates & settlement
export function MoneyTab({ t, r, toast }) {
  const s = useLoad(() => api.get(`/teams/${t.id}/settlement`), [t.id]);
  const [who, setWho] = useState(null);
  const [add, setAdd] = useState(null);
  if (s.loading && !s.data) return <Loading />;
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  const d = s.data;
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
        <Card pad={14} style={{ flex: 1 }}><T size={12} color={c.mute} weight="700">STILL DUE</T><T size={22} weight="800">{moneyIn(d.total_due_cents, d.currency)}</T></Card>
        <Card pad={14} style={{ flex: 1 }}><T size={12} color={c.mute} weight="700">PAID</T><T size={22} weight="800">{moneyIn(d.total_paid_cents, d.currency)}</T></Card>
      </View>
      <Btn small title="Record an amount" style={{ marginTop: 8 }} onPress={() => setAdd({})} />
      <T size={13} color={c.mute} style={{ marginTop: 6 }}>Set each person's agreed fee on the Roster tab. Match fees are added from a squad on the Matches tab. This is a ledger: mark items paid once you've paid them.</T>
      <Section title="By person" color={c.mint}>
        {d.people.map((p) => (
          <Row key={p.id} onPress={() => setWho(p)} left={<Avatar user={p} />} title={p.display_name} sub={`${p.team_role}${p.rate_cents != null ? ' · ' + moneyIn(p.rate_cents, d.currency) + ' ' + unitLabel(p.rate_unit) : ' · no fee set'}`}
            right={<View style={{ alignItems: 'flex-end' }}>{p.due_cents ? <T weight="800" color={c.orange}>{moneyIn(p.due_cents, d.currency)} due</T> : null}{p.paid_cents ? <T size={12} color={c.mute}>{moneyIn(p.paid_cents, d.currency)} paid</T> : null}</View>} />
        ))}
      </Section>
      <Ledger who={who} t={t} currency={d.currency} toast={toast} onClose={() => setWho(null)} onChanged={s.reload} onAdd={(p) => { setWho(null); setAdd({ user_id: p.id }); }} />
      <FormSheet visible={!!add} onClose={() => setAdd(null)} title="Record an amount" submitLabel="Add to ledger"
        initial={{ user_id: add?.user_id ?? d.people[0]?.id, kind: 'bonus' }}
        fields={[
          { key: 'user_id', label: 'Who', type: 'chips', options: d.people.map((p) => ({ value: p.id, label: p.display_name })) },
          { key: 'kind', label: 'What for', type: 'chips', options: [['match_fee', 'Match fee'], ['coach_fee', 'Coaching fee'], ['session_fee', 'Session'], ['bonus', 'Bonus'], ['expense', 'Expense'], ['other', 'Other']].map(([value, label]) => ({ value, label })) },
          { key: 'amount_cents', label: `Amount (${d.currency})`, type: 'money', currency: d.currency },
          { key: 'note', label: 'Note', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/teams/${t.id}/payouts`, { user_id: v.user_id, kind: v.kind, amount_cents: v.amount_cents, note: v.note || undefined }); s.reload(); return 'Added'; }} />
    </>
  );
}

function Ledger({ who, t, currency, toast, onClose, onChanged, onAdd }) {
  const rows = useLoad(() => (who ? api.get(`/teams/${t.id}/payouts`, { user_id: who.id, limit: 100 }) : []), [who?.id]);
  const patch = async (p, body, msg) => { try { await api.patch(`/team-payouts/${p.id}`, body); toast(msg); rows.reload(); onChanged(); } catch (e) { toast('' + e.message); } };
  return (
    <Sheet visible={!!who} onClose={onClose} title={who?.display_name ?? ''}>
      {rows.loading && !rows.data ? <Loading /> : (rows.data ?? []).length ? rows.data.map((p) => (
        <Row key={p.id} title={`${moneyIn(p.amount_cents, currency)} · ${p.kind.replace('_', ' ')}`} sub={`${p.note ?? ''}${p.note ? ' · ' : ''}${p.status === 'paid' ? 'paid ' + day(p.paid_at) : day(p.created_at)}`}
          right={p.status === 'due' ? <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="Mark paid" onPress={() => patch(p, { status: 'paid' }, 'Marked paid')} /><Btn small title="Cancel" color={c.paper} ink={c.ink} onPress={() => patch(p, { status: 'cancelled' }, 'Cancelled')} /></View> : <Tag label={p.status} />} />
      )) : <Empty emoji="🧾" title="Nothing recorded" />}
      {who ? <Btn title="Record an amount" color={c.violet} onPress={() => onAdd(who)} /> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ for players: my selections
/** Selections for the signed-in player in one team, with confirm / decline. */
export function MySelections({ teamId }) {
  const { toast } = useSession();
  const sel = useLoad(() => api.get('/me/selections', { limit: 50 }), [teamId]);
  const mine = (sel.data ?? []).filter((x) => x.team_id === teamId);
  if (!mine.length) return null;
  const answer = async (x, status) => { try { await api.patch(`/squads/${x.squad_id}`, { status }); toast(status === 'confirmed' ? "You're in 👍" : 'Declined'); sel.reload(); } catch (e) { toast('' + e.message); } };
  return (
    <Section title="You're selected" color={c.pink}>
      {mine.map((x) => (
        <Row key={x.squad_id} title={x.event_name ?? 'Match'} sub={`${x.role.replace('_', ' ')}${x.scheduled_at ? ' · ' + when(x.scheduled_at) : ''}`}
          right={x.status === 'selected' ? <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="I'm in" onPress={() => answer(x, 'confirmed')} /><Btn small title="Can't" color={c.paper} ink={c.ink} onPress={() => answer(x, 'declined')} /></View> : <Tag label={SELECTION[x.status]?.[0] ?? x.status} />} />
      ))}
    </Section>
  );
}
