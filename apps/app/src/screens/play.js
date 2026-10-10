import { VerifiedBadges } from './verification';
import { SubjectPanel } from './insurance';
import { AvailabilityPicker, MySelections } from './team-manage';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Field, Avatar, Btn, Bubble, Card, Chip, Empty, ErrorBox, GradCard, H1, H2, Loading, Row, Screen, Seg, Section, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { CreateEvent } from './event-create';
import { RegisterVenue } from './book';
import { FixtureCard, Reviews, StandingsTable, TrophyShelf, Stars } from '../blocks';
import { SportSelect } from '../sportpicker';
import { c, grad, day, accentFor, money } from '../theme';


const TEAM_COLOURS = [['#7C4DFF', 'Violet'], ['#4F46E5', 'Indigo'], ['#0EA5E9', 'Sky'], ['#10B981', 'Green'], ['#F59E0B', 'Amber'], ['#EF4444', 'Red'], ['#EC4899', 'Pink'], ['#0F172A', 'Slate']].map(([value, label]) => ({ value, label }));

/** Teams that invited you, with accept / decline. Hidden when there are none. */
function TeamInvites({ onChanged }) {
  const { user, toast } = useSession();
  const { push } = useNav();
  const inv = useLoad(() => (user ? api.get('/me/team-invites') : []), [user?.id]);
  if (!inv.data?.length) return null;
  const answer = async (x, accept) => { try { await api.post(`/teams/${x.team_id}/invitations/respond`, { accept }); toast(accept ? `Welcome to ${x.name}!` : 'Declined'); inv.reload(); onChanged(); if (accept) push('Team', { id: x.team_id }); } catch (e) { toast('' + e.message); } };
  return (
    <Section title="Team invitations" color={c.pink}>
      {inv.data.map((x) => <Row key={x.team_id} left={<Bubble emoji={x.emoji} color={x.color} />} title={x.name} sub={`Invited as ${x.role}${x.rate_cents != null ? ` · ${money(x.rate_cents)} ${x.rate_unit}` : ''}`}
        right={<View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="Join" onPress={() => answer(x, true)} /><Btn small title="No" color={c.paper} ink={c.ink} onPress={() => answer(x, false)} /></View>} />)}
    </Section>
  );
}

export function Play() {
  const { has, hasAny } = useSession();
  const { push } = useNav();
  const [tab, setTab] = useState('events');
  const [sport, setSport] = useState(null);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const venues = useLoad(() => api.get('/venues', { limit: 60 }), []);
  const [flags, setFlags] = useState({});
  const [sort, setSort] = useState('soonest');
  const [size, setSize] = useState(20);
  const [form, setForm] = useState(null);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  useEffect(() => setSize(20), [tab, sport, dq, flags, sort]);
  const toggle = (k) => setFlags((f) => ({ ...f, [k]: !f[k] }));
  const list = useLoad(() => {
    const p = { sport: sport ?? undefined, limit: size };
    if (tab === 'events') return api.get('/events/search', { ...p, q: dq || undefined, sort, ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v)) });
    if (tab === 'teams') return api.get('/teams', { ...p, q: dq || undefined });
    if (tab === 'venues') return api.get('/venues', {});
    return api.get('/people', { ...p, sport: undefined, q: dq || undefined });
  }, [tab, sport, dq, flags, sort, size]);
  const rows = tab === 'events' ? list.data?.items : list.data;
  const total = tab === 'events' ? list.data?.total : rows?.length;

  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Play</H1>
      <Seg options={[{ value: 'events', label: 'Events', emoji: '🎟️', color: c.pink }, { value: 'teams', label: 'Teams', emoji: '🛡️', color: c.violet }, { value: 'venues', label: 'Venues', emoji: '🏟️', color: c.cyan }, { value: 'people', label: 'People', emoji: '🧑‍🤝‍🧑', color: c.orange }]} value={tab} onChange={setTab} />
      {tab === 'events' || tab === 'teams' ? <View style={{ marginTop: 6 }}><SportSelect allLabel="All sports" value={sport} onChange={setSport} /></View> : null}

      {tab !== 'venues' ? <View style={{ marginTop: 8 }}><Field value={q} onChangeText={setQ} placeholder={tab === 'events' ? 'Search events, cities, sports' : tab === 'teams' ? 'Search teams' : 'Search people'} /></View> : null}
      {tab === 'events' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }} accessibilityRole="toolbar">
          {[['open_for_entry', 'Open to join'], ['free', 'Free entry'], ['seeking_sponsors', 'Needs sponsors'], ['verified', 'Verified']].map(([k, label]) => <Chip key={k} label={label} active={!!flags[k]} onPress={() => toggle(k)} />)}
          <Chip label={sort === 'soonest' ? 'Sort: soonest' : sort === 'fee_low' ? 'Sort: lowest fee' : 'Sort: newest'} onPress={() => setSort((v) => (v === 'soonest' ? 'fee_low' : v === 'fee_low' ? 'newest' : 'soonest'))} />
        </View>
      ) : null}
      {tab === 'events' ? <Btn title="Create an event" color={c.violet} onPress={() => setForm('event')} style={{ marginTop: 8 }} /> : null}
      {tab === 'venues' && hasAny('venue_manager', 'organizer') ? <Btn title="Register a venue" color={c.violet} onPress={() => setForm('venue')} style={{ marginTop: 8 }} /> : null}
      {tab === 'teams' ? <TeamInvites onChanged={list.reload} /> : null}
      {tab === 'teams' ? <Btn title="Start a team" color={c.pink} onPress={() => setForm('team')} style={{ marginTop: 8 }} /> : null}

      <View style={{ gap: 12, marginTop: 14 }}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !rows.length ? (dq || Object.values(flags).some(Boolean) || sport ? <Empty title="No matches" sub="Try fewer filters or a different search." /> : <Empty title="Nothing here yet" sub="Be the one who starts it." />) :
          rows.map((x, i) => {
            if (tab === 'events') return <Row key={x.id} onPress={() => push('Event', { id: x.id })} color={[c.pinkSoft, c.violetSoft, c.limeSoft, c.sunSoft][i % 4]} left={<Bubble emoji={x.banner_emoji} color={c.paper} />} title={x.name} sub={`${x.sport_emoji} ${x.sport} · ${x.entrants} in${x.spots_left != null ? ` · ${x.spots_left} spots left` : ''}${x.city ? ' · ' + x.city : ''}${x.starts_on ? ' · ' + day(x.starts_on) : ''}${x.entry_fee_cents ? ' · ' + money(x.entry_fee_cents) : ' · Free'}`} right={<Tag label={x.registration_open ? 'open' : x.status === 'open' ? 'full / closed' : x.status} color={x.registration_open ? c.lime : c.sun} />} />;
            if (tab === 'teams') return <Row key={x.id} onPress={() => push('Team', { id: x.id })} left={<Bubble emoji={x.emoji} color={x.color} />} title={x.name} sub={`${x.sport_emoji} ${x.sport} · ${x.members} members${x.city ? ' · ' + x.city : ''}`} />;
            if (tab === 'venues') return <Row key={x.id} onPress={() => push('Venue', { id: x.id })} left={<Bubble emoji={x.emoji} color={c.cyan} />} title={x.name} sub={`${x.city ?? ''} · ${x.resources} bookable spots`} right={x.rating ? <T weight="900">⭐ {x.rating}</T> : null} />;
            return <Row key={x.id} onPress={() => push('Person', { id: x.id })} left={<Avatar user={x} />} title={x.display_name} sub={`@${x.handle} · ${(x.roles ?? []).join(', ')}`} />;
          })}
        {rows && total > rows.length && tab !== 'venues' ? <Btn small title={`Show more (${total - rows.length} more)`} color={c.paper} onPress={() => setSize((n) => n + 20)} /> : null}
      </View>

      <RegisterVenue visible={form === 'venue'} onClose={() => setForm(null)} onCreated={list.reload} />
      <FormSheet visible={form === 'team'} onClose={() => setForm(null)} title="Start a team" submitLabel="Create team"
        fields={[{ key: 'name', label: 'Team name' }, { key: 'sport', label: 'Sport', type: 'sport' }, { key: 'description', label: 'About the team', type: 'multiline', optional: true },
          { key: 'emoji', label: 'Mascot emoji', optional: true }, { key: 'color', label: 'Team colour', type: 'chips', optional: true, options: TEAM_COLOURS }, { key: 'city', label: 'City', optional: true }]}
        onSubmit={async (v) => { const t = await api.post('/teams', v); list.reload(); push('TeamWorkspace', { id: t.id }); return 'Team created — invite your players from the Roster tab'; }} />
      <CreateEvent visible={form === 'event'} onClose={() => setForm(null)} onCreated={(e) => { list.reload(); push('EventPlan', { id: e.id }); }} />
    </Screen>
  );
}

export function Event({ id }) {
  const { user, has, toast } = useSession();
  const { push } = useNav();
  const [tab, setTab] = useState('table');
  const [score, setScore] = useState(null);
  const [joining, setJoining] = useState(false);
  const [panel, setPanel] = useState(false);
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  const fx = useLoad(() => api.get('/fixtures', { event_id: id, limit: 100 }), [id]);
  const myTeams = useLoad(() => (user ? api.get('/teams', { mine: true, limit: 50 }) : []), [id]);
  const entries = useLoad(async () => (ev.data && ev.data.organizer_id === user.id ? api.get(`/events/${id}/entries`) : []), [ev.data?.organizer_id]);
  if (ev.loading && !ev.data) return <Screen><Loading /></Screen>;
  if (ev.error) return <Screen><ErrorBox error={ev.error} onRetry={ev.reload} /></Screen>;
  const e = ev.data;
  const isOrg = e.organizer_id === user.id || has('admin');
  const reloadAll = () => { ev.reload(); fx.reload(); entries.reload(); };
  const act = (fn, msg) => async () => { try { await fn(); toast(msg); reloadAll(); } catch (x) { toast('' + x.message); } };
  const eligible = (myTeams.data ?? []).filter((t) => t.sport === e.sport);

  return (
    <Screen>
      <GradCard colors={grad.hero}>
        <T size={60}>{e.banner_emoji}</T>
        <H1 color="#fff" style={{ fontSize: 30 }}>{e.name}</H1>
        <T color="#fff" weight="800">{e.sport_emoji} {e.sport} · {e.kind}{e.starts_on ? ` · ${day(e.starts_on)}` : ''}{e.venue ? ` · 📍${e.venue.name}` : ''}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Tag label={e.status} color={c.lime} /><Tag label={`${e.entrants.length} in`} color={c.sun} />{e.entry_fee_cents ? <Tag label={`Entry ${money(e.entry_fee_cents)}`} color={c.cyan} /> : null}
          {e.rating?.n ? <Tag label={`⭐ ${e.rating.avg}`} color={c.pinkSoft} /> : null}
        </View>
      </GradCard>
      {e.description ? <T style={{ marginTop: 12 }}>{e.description}</T> : null}
      {isOrg ? <Btn title="Plan, contact & budget" color={c.pink} onPress={() => push('EventPlan', { id })} style={{ marginTop: 14 }} /> : null}
      {e.sport === 'Multi-sport games' ? <Btn title={isOrg ? 'Run the games programme' : 'Open the games programme'} color={c.violet} onPress={() => push('Games', { id })} style={{ marginTop: 14 }} /> : null}

      {e.status === 'open' && !isOrg && !e.entrants.some((x) => x.user_id === user.id || eligible.some((t) => t.id === x.team_id)) ? <Btn title="Join this event" onPress={() => setJoining(true)} style={{ marginTop: 14 }} /> : null}

      {isOrg ? (
        <Card color={c.limeSoft} style={{ marginTop: 14 }}>
          <T weight="900" size={16}>Organizer tools</T>
          <Btn small title="Tournament console" color={c.violet} onPress={() => push('EventAdmin', { id })} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
          {entries.data?.filter((x) => x.status === 'pending').map((x) => (
            <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <T weight="800" style={{ flex: 1 }}>{x.team_name ?? x.display_name} wants in</T>
              <Btn small title="Accept" color={c.mint} ink={c.ink} onPress={act(() => api.patch(`/entries/${x.id}`, { status: 'accepted' }), 'Accepted')} />
              <Btn small title="Pass" color={c.paper} ink={c.ink} onPress={act(() => api.patch(`/entries/${x.id}`, { status: 'rejected' }), 'Declined')} />
            </View>
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {!fx.data?.length && e.entrants.filter((x) => x.team_id).length > 1 ? <Btn small title="Auto-schedule" color={c.violet} onPress={act(() => api.post(`/events/${id}/schedule/round-robin`, { first_round_at: new Date(Date.now() + 2 * 864e5).toISOString() }), 'Round-robin created')} /> : null}
            {e.status === 'open' ? <Btn small title="Start" color={c.cyan} ink={c.ink} onPress={act(() => api.patch(`/events/${id}`, { status: 'ongoing' }), 'Event is underway')} /> : null}
            <Btn small title="Insurance & documents" color={c.paper} ink={c.ink} onPress={() => setPanel((x) => !x)} />
            {e.status !== 'completed' ? <Btn small title="Finish & award" color={c.orange} onPress={act(() => api.post(`/events/${id}/complete`), 'Champions crowned')} /> : null}
          </View>
        </Card>
      ) : null}

      {isOrg && panel ? <View style={{ marginTop: 14 }}><SubjectPanel type="event" id={id} name={e.name} /></View> : null}
      <View style={{ marginTop: 14 }}>
        <Seg options={[{ value: 'table', label: 'Table', emoji: '📊' }, { value: 'games', label: 'Games', emoji: '⚽' }, { value: 'crew', label: 'Crew', emoji: '🤝' }, { value: 'reviews', label: 'Reviews', emoji: '💬' }]} value={tab} onChange={setTab} color={c.pink} />
      </View>
      <View style={{ gap: 12, marginTop: 8 }}>
        {tab === 'table' && <StandingsTable rows={e.standings} />}
        {tab === 'games' && (fx.data?.length ? fx.data.map((f) => <FixtureCard key={f.id} f={f} onScore={isOrg || f.referee_id === user.id ? setScore : null} />) : <Empty emoji="🗓️" title="No games scheduled" />)}
        {tab === 'crew' && <>
          <H2>Teams & players</H2>
          {e.entrants.map((x) => <Row key={x.entry_id} onPress={() => (x.team_id ? push('Team', { id: x.team_id }) : push('Person', { id: x.user_id }))} left={<Bubble emoji={x.emoji ?? '🏃'} color={x.color ?? c.cyan} />} title={x.name ?? x.display_name} />)}
          <H2 style={{ marginTop: 8 }}>Sponsors</H2>
          {e.sponsors.length ? e.sponsors.map((s) => <Row key={s.id} left={<Bubble emoji={s.emoji} color={c.sun} />} title={s.name} sub={s.in_kind ?? 'Title partner'} />) : <Empty emoji="💎" title="No sponsors yet" />}
        </>}
        {tab === 'reviews' && <Reviews type="event" id={id} />}
      </View>

      <FormSheet visible={joining} onClose={() => setJoining(false)} title="Join as…" submitLabel="Register"
        fields={[{ key: 'team_id', label: 'Register', type: 'choice', options: [...eligible.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` })), { value: 'solo', label: 'Just me' }] }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/entries`, v.team_id === 'solo' ? {} : { team_id: v.team_id }); reloadAll(); return 'Registered — waiting for the organizer'; }} />
      <FormSheet visible={!!score} onClose={() => setScore(null)} title={score ? `${score.home_name} vs ${score.away_name}` : ''} submitLabel="Save result"
        fields={[{ key: 'home_score', label: score?.home_name ?? 'Home', type: 'number' }, { key: 'away_score', label: score?.away_name ?? 'Away', type: 'number' }]}
        onSubmit={async (v) => { await api.post(`/fixtures/${score.id}/result`, v); reloadAll(); return 'Result saved'; }} />
    </Screen>
  );
}

export function Team({ id }) {
  const { push } = useNav();
  const { user } = useSession();
  const t = useLoad(() => api.get(`/teams/${id}`), [id]);
  if (t.loading && !t.data) return <Screen><Loading /></Screen>;
  if (t.error) return <Screen><ErrorBox error={t.error} onRetry={t.reload} /></Screen>;
  const x = t.data;
  return (
    <Screen>
      <GradCard colors={[x.color, c.ink]}>
        <T size={64}>{x.emoji}</T><H1 color="#fff" style={{ fontSize: 32 }}>{x.name}</H1>
        <T color="#fff" weight="800">{x.sport_emoji} {x.sport}{x.city ? ` · ${x.city}` : ''} · {x.members.length} players</T>
        {x.rating?.n ? <Stars n={x.rating.avg} /> : null}
      </GradCard>
      {x.my_membership?.status === 'active' || x.can_manage ? <Btn title="💬 Team chat" color={c.violet} onPress={() => push('TeamChat', { id })} style={{ marginTop: 12 }} /> : null}
      {x.can_manage || x.my_membership?.status === 'active' ? <Btn title={x.can_manage ? '🗂️ Team workspace — tasks, schedule, roster, squads' : '🗂️ Team workspace — tasks & schedule'} onPress={() => push('TeamWorkspace', { id })} style={{ marginTop: 12 }} /> : null}
      {x.my_membership?.status === 'active' ? <>
        <Section title="My availability" color={c.mint}><AvailabilityPicker teamId={id} userId={user.id} value={x.my_membership.availability} onDone={t.reload} /></Section>
        <MySelections teamId={id} />
      </> : null}
      <Section title="Roster" color={c.cyan}>
        {x.members.map((m) => <Row key={m.id} onPress={() => push('Person', { id: m.id })} left={<Avatar user={m} />} title={`${m.jersey_no != null ? '#' + m.jersey_no + ' ' : ''}${m.display_name}`} sub={m.team_role} />)}
      </Section>
      <Section title="Trophy cabinet" color={c.sun}><TrophyShelf awards={x.awards} /></Section>
      <Section title="Fan wall" color={c.pink}><Reviews type="team" id={id} /></Section>
    </Screen>
  );
}

export function Person({ id }) {
  const { user } = useSession();
  const { push } = useNav();
  const p = useLoad(() => api.get(`/people/${id}`), [id]);
  const stats = useLoad(() => api.get(`/people/${id}/stats`), [id]);
  const awards = useLoad(() => api.get('/awards', { user_id: id }), [id]);
  if (p.loading && !p.data) return <Screen><Loading /></Screen>;
  if (p.error) return <Screen><ErrorBox error={p.error} onRetry={p.reload} /></Screen>;
  const x = p.data;
  return (
    <Screen>
      <GradCard colors={[x.avatar_color, c.violet]}>
        <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
          <Avatar user={x} size={76} />
          <View style={{ flex: 1 }}><H1 color="#fff" style={{ fontSize: 28 }}>{x.display_name}</H1><T color="#fff" weight="800">@{x.handle}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{x.roles.map((r) => <Tag key={r} label={r.replace('_', ' ')} color={c.lime} />)}</View><VerifiedBadges list={x.verified} style={{ marginTop: 6 }} /></View>
        </View>
        {x.bio ? <T color="#fff" style={{ marginTop: 10 }}>{x.bio}</T> : null}
      </GradCard>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <StatPill value={stats.data?.total_points ?? '–'} label="POINTS" color={c.lime} /><StatPill value={awards.data?.length ?? '–'} label="AWARDS" color={c.sun} /><StatPill value={x.rating?.avg ?? '–'} label="RATING" color={c.pinkSoft} />
      </View>
      {x.sport_profiles.length ? <Section title="Sports" color={c.cyan}>{x.sport_profiles.map((s, i) => <Row key={i} left={<Bubble emoji={s.emoji} color={c.cyanSoft} />} title={`${s.sport} · ${s.role}`} sub={`${s.level}${s.position ? ' · ' + s.position : ''}`} />)}</Section> : null}
      {x.teams.length ? <Section title="Teams" color={c.violet}>{x.teams.map((t) => <Row key={t.id} onPress={() => push('Team', { id: t.id })} left={<Bubble emoji={t.emoji} color={t.color} />} title={t.name} sub={t.role} />)}</Section> : null}
      {stats.data?.by_metric?.length ? <Section title="Stats" color={c.mint}>
        <Card color={c.mintSoft}>{stats.data.by_metric.map((m, i) => <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}><T weight="800">{m.emoji} {m.metric}</T><T weight="900">{m.total} <T size={12} color={c.mute}>total · best {m.best}</T></T></View>)}</Card>
      </Section> : null}
      <Section title="Trophy cabinet" color={c.sun}><TrophyShelf awards={awards.data} /></Section>
      <Section title="Props from the community" color={c.pink}><Reviews type="user" id={id} canWrite={user.id !== id} /></Section>
    </Screen>
  );
}
