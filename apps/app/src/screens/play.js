import { VerifiedBadges } from './verification';
import { SanctionBadge } from './federation-club';
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
import { Reviews, TrophyShelf, Stars } from '../blocks';
import { EventFacts, EventHeader, SpectatorBody, Sponsors } from './spectate';
import { SportSelect } from '../sportpicker';
import { CredentialList } from './pathways';
import { c, grad, day, accentFor, money, withUnit } from '../theme';


const TEAM_COLOURS = [['#7C4DFF', 'Violet'], ['#8458B3', 'Indigo'], ['#0EA5E9', 'Sky'], ['#10B981', 'Green'], ['#F59E0B', 'Amber'], ['#EF4444', 'Red'], ['#9B72C6', 'Pink'], ['#0F172A', 'Slate']].map(([value, label]) => ({ value, label }));

/** Teams that invited you, with accept / decline. Hidden when there are none. */
export function TeamInvites({ onChanged }) {
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

/** "Start a team" form. Lives with the rest of creating and managing in the Schedule tab. */
export function StartTeamSheet({ visible, onClose, onCreated }) {
  const { push } = useNav();
  return (
    <FormSheet visible={visible} onClose={onClose} title="Start a team" submitLabel="Create team"
      fields={[{ key: 'name', label: 'Team name' }, { key: 'sport', label: 'Sport', type: 'sport' }, { key: 'description', label: 'About the team', type: 'multiline', optional: true },
          { key: 'emoji', label: 'Mascot emoji', optional: true }, { key: 'color', label: 'Team colour', type: 'chips', optional: true, options: TEAM_COLOURS }, { key: 'city', label: 'City or area', type: 'region', optional: true }]}
        onSubmit={async (v) => { const t = await api.post('/teams', v); onCreated?.(); push('TeamWorkspace', { id: t.id }); return 'Team created — invite your players from the Roster tab'; }} />
  );
}

/** Find things to join: events, teams and people. Creating and running your own lives under the Schedule tab. */
export function Explore() {
  const { push } = useNav();
  const [tab, setTab] = useState('events');
  const [sport, setSport] = useState(null);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [flags, setFlags] = useState({});
  const [sort, setSort] = useState('soonest');
  const [phase, setPhase] = useState(null);   // live | upcoming | completed
  const [level, setLevel] = useState(null);
  const [size, setSize] = useState(20);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  useEffect(() => setSize(20), [tab, sport, dq, flags, sort, phase, level]);
  const toggle = (k) => setFlags((f) => ({ ...f, [k]: !f[k] }));
  const list = useLoad(() => {
    const p = { sport: sport ?? undefined, limit: size };
    if (tab === 'events') return api.get('/events/search', { ...p, q: dq || undefined, sort, phase: phase ?? undefined, level: level ?? undefined, ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v)) });
    if (tab === 'teams') return api.get('/teams', { ...p, q: dq || undefined });
    return api.get('/people', { ...p, sport: undefined, q: dq || undefined });
  }, [tab, sport, dq, flags, sort, size, phase, level]);
  const raw = tab === 'events' ? list.data?.items : list.data;
  const rows = Array.isArray(raw) ? raw : [];
  const total = tab === 'events' ? list.data?.total ?? rows.length : rows.length;

  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Explore</H1>
      <T color={c.mute} weight="600">Find events to join, teams to play for and people to play with.</T>
      <Seg options={[{ value: 'events', label: 'Events', emoji: '🎟️', color: c.pink }, { value: 'teams', label: 'Teams', emoji: '🛡️', color: c.violet }, { value: 'people', label: 'People', emoji: '🧑‍🤝‍🧑', color: c.orange }]} value={tab} onChange={setTab} />
      {tab === 'events' || tab === 'teams' ? <View style={{ marginTop: 6 }}><SportSelect allLabel="All sports" value={sport} onChange={setSport} /></View> : null}

      <View style={{ marginTop: 8 }}><Field value={q} onChangeText={setQ} placeholder={tab === 'events' ? 'Search events, cities, sports' : tab === 'teams' ? 'Search teams' : 'Search people'} /></View>
      {tab === 'events' ? (
        <View style={{ gap: 8, marginTop: 8 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="toolbar">
            {[['live', '🔴 Live now'], ['upcoming', 'Upcoming'], ['completed', 'Completed']].map(([k, label]) => <Chip key={k} label={label} active={phase === k} onPress={() => setPhase((v) => (v === k ? null : k))} />)}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="toolbar">
            {[['beginner', 'Beginner'], ['amateur', 'Amateur'], ['semi_pro', 'Semi-pro'], ['pro', 'Pro']].map(([k, label]) => <Chip key={k} label={label} active={level === k} onPress={() => setLevel((v) => (v === k ? null : k))} />)}
          </View>
        </View>
      ) : null}
      {tab === 'events' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }} accessibilityRole="toolbar">
          {[['open_for_entry', 'Open to join'], ['free', 'Free entry'], ['seeking_sponsors', 'Needs sponsors'], ['verified', 'Verified']].map(([k, label]) => <Chip key={k} label={label} active={!!flags[k]} onPress={() => toggle(k)} />)}
          <Chip label={sort === 'soonest' ? 'Sort: soonest' : sort === 'fee_low' ? 'Sort: lowest fee' : 'Sort: newest'} onPress={() => setSort((v) => (v === 'soonest' ? 'fee_low' : v === 'fee_low' ? 'newest' : 'soonest'))} />
        </View>
      ) : null}

      <View style={{ gap: 12, marginTop: 14 }}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !rows.length ? (dq || Object.values(flags).some(Boolean) || sport ? <Empty title="No matches" sub="Try fewer filters or a different search." /> : <Empty title="Nothing here yet" sub="Be the one who starts it." />) :
          rows.map((x, i) => {
            if (tab === 'events') return <Row key={x.id} onPress={() => push('Event', { id: x.id })} color={[c.pinkSoft, c.violetSoft, c.limeSoft, c.sunSoft][i % 4]} left={<Bubble emoji={x.banner_emoji} color={c.paper} />} title={x.name} sub={`${x.live_now ? '🔴 LIVE · ' : ''}${x.sport_emoji} ${x.sport} · ${x.entrants} in${x.spots_left != null ? ` · ${x.spots_left} spots left` : ''}${x.city ? ' · ' + x.city : ''}${x.starts_on ? ' · ' + day(x.starts_on) : ''}${x.entry_fee_cents ? ' · ' + money(x.entry_fee_cents) : ' · Free'}`} right={<Tag label={x.registration_open ? 'open' : x.status === 'open' ? 'full / closed' : x.status} color={x.registration_open ? c.lime : c.sun} />} />;
            if (tab === 'teams') return <Row key={x.id} onPress={() => push('Team', { id: x.id })} left={<Bubble emoji={x.emoji} color={x.color} />} title={x.name} sub={`${x.sport_emoji} ${x.sport} · ${x.members} members${x.city ? ' · ' + x.city : ''}`} />;
            return <Row key={x.id} onPress={() => push('Person', { id: x.id })} left={<Avatar user={x} />} title={x.display_name} sub={`@${x.handle} · ${(x.roles ?? []).join(', ')}`} />;
          })}
        {total > rows.length ? <Btn small title={`Show more (${total - rows.length} more)`} color={c.paper} onPress={() => setSize((n) => n + 20)} /> : null}
      </View>

    </Screen>
  );
}

/** The one event page, for everyone: the public tournament home (live games, table, bracket, awards, media, partners, follow and share) with the
 *  participant and organiser actions around it. It works signed out too (see PublicShell); running the event is the Event console. */
export function Event({ id }) {
  const { user, has, toast } = useSession();
  const { push } = useNav();
  const [joining, setJoining] = useState(false);
  const [panel, setPanel] = useState(false);
  const pub = useLoad(() => api.get(`/public/events/${id}`), [id]);
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  const myTeams = useLoad(() => (user ? api.get('/teams', { mine: true, limit: 50 }) : Promise.resolve([])), [id, user?.id]);
  const entries = useLoad(async () => (ev.data && user && ev.data.organizer_id === user.id ? api.get(`/events/${id}/entries`) : []), [ev.data?.organizer_id, user?.id]);
  const badges = useLoad(() => (user ? api.get('/me/accreditations', { limit: 100 }).catch(() => []) : Promise.resolve([])), [id, user?.id]);
  if ((pub.loading && !pub.data) || (ev.loading && !ev.data)) return <Screen><Loading /></Screen>;
  if (pub.error) return <Screen><ErrorBox error={pub.error} onRetry={pub.reload} /></Screen>;
  if (ev.error) return <Screen><ErrorBox error={ev.error} onRetry={ev.reload} /></Screen>;
  const p = pub.data, e = ev.data;
  const isOrg = !!user && (e.organizer_id === user.id || has('admin'));
  const reloadAll = () => { pub.reload(); ev.reload(); entries.reload(); };
  const act = (fn, msg) => async () => { try { await fn(); toast(msg); reloadAll(); } catch (x) { toast('' + x.message); } };
  const eligible = (myTeams.data ?? []).filter((t) => t.sport === e.sport);
  const mine = !!user && e.entrants.some((x) => x.user_id === user.id || eligible.some((t) => t.id === x.team_id));
  const nav = { team: (tid) => push('Team', { id: tid }), race: (rid) => push('RaceLive', { id: rid }) };

  return (
    <Screen>
      <GradCard colors={grad.hero}>
        <T size={60}>{e.banner_emoji}</T>
        <H1 color="#fff" style={{ fontSize: 30 }}>{e.name}</H1>
        <T color="#fff" weight="800">{e.sport_emoji} {e.sport} · {e.kind}{e.starts_on ? ` · ${day(e.starts_on)}` : ''}{e.venue ? ` · 📍${e.venue.name}` : ''}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Tag label={`${e.entrants.length} in`} color={c.sun} />{e.entry_fee_cents ? <Tag label={`Entry ${money(e.entry_fee_cents)}`} color={c.cyan} /> : null}
          {e.rating?.n ? <Tag label={`⭐ ${e.rating.avg}`} color={c.pinkSoft} /> : null}
        </View>
      </GradCard>
      <View style={{ marginTop: 12 }}><EventHeader p={p} mine={p.follow.mine} onFollowChange={pub.reload} /></View>
      <EventFacts p={p} />
      <SanctionBadge id={id} />
      {e.description ? <T style={{ marginTop: 12 }}>{e.description}</T> : null}
      {isOrg || e.is_assessor ? <Btn title={isOrg ? '⚡ Event console' : '🎽 Trial desk'} color={c.violet} onPress={() => push('EventCommand', { id })} style={{ marginTop: 14 }} /> : null}
      {isOrg ? <Btn title="📣 Public page: visibility, sponsors, sharing" color={c.paper} ink={c.ink} onPress={() => push('EventCommand', { id, tab: 'public' })} style={{ marginTop: 10 }} /> : null}
      {mine ? <Btn title="🪪 My registration" color={c.violet} onPress={() => push('EventCommand', { id, tab: 'registration' })} style={{ marginTop: 14 }} /> : null}
      {!isOrg && (badges.data ?? []).some((b) => b.event_id === id && b.status !== 'draft') ? <Btn title="🎫 My accreditation" color={c.violet} onPress={() => push('EventCommand', { id, tab: 'accreditation' })} style={{ marginTop: 14 }} /> : null}
      {e.sport === 'Multi-sport games' ? <Btn title={isOrg ? 'Run the games programme' : 'Open the games programme'} color={c.violet} onPress={() => push('Games', { id })} style={{ marginTop: 14 }} /> : null}
      {user && e.status === 'open' && !isOrg && !mine ? <Btn title="Join this event" onPress={() => setJoining(true)} style={{ marginTop: 14 }} /> : null}
      {!user && p.registration.open ? <T size={13} color={c.mute} style={{ marginTop: 14 }}>Sign in to register for this event.</T> : null}

      {isOrg ? (
        <Card color={c.limeSoft} style={{ marginTop: 14 }}>
          <T weight="900" size={16}>Organizer tools</T>
          {entries.data?.filter((x) => x.status === 'pending').map((x) => (
            <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <T weight="800" style={{ flex: 1 }}>{x.team_name ?? x.display_name} wants in</T>
              <Btn small title="Accept" color={c.mint} ink={c.ink} onPress={act(() => api.patch(`/entries/${x.id}`, { status: 'accepted' }), 'Accepted')} />
              <Btn small title="Pass" color={c.paper} ink={c.ink} onPress={act(() => api.patch(`/entries/${x.id}`, { status: 'rejected' }), 'Declined')} />
            </View>
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {e.status === 'open' ? <Btn small title="Start" color={c.cyan} ink={c.ink} onPress={act(() => api.patch(`/events/${id}`, { status: 'ongoing' }), 'Event is underway')} /> : null}
            <Btn small title="Insurance & documents" color={c.paper} ink={c.ink} onPress={() => setPanel((x) => !x)} />
            {e.status !== 'completed' ? <Btn small title="Finish & award" color={c.orange} onPress={act(() => api.post(`/events/${id}/complete`), 'Champions crowned')} /> : null}
          </View>
        </Card>
      ) : null}
      {isOrg && panel ? <View style={{ marginTop: 14 }}><SubjectPanel type="event" id={id} name={e.name} /></View> : null}

      <SpectatorBody id={id} p={p} openGame={(gid) => push('LiveCentre', { id: gid })} goTeam={nav} extra={[{ value: 'reviews', label: '💬 Reviews', node: <Reviews type="event" id={id} canWrite={!!user && !isOrg} /> }]} />
      <Sponsors list={p.sponsors.placements.filter((x) => x.slot === 'fixture' || x.slot === 'scorecard')} title="Event partners" />

      <FormSheet visible={joining} onClose={() => setJoining(false)} title="Join as…" submitLabel="Register"
        fields={[{ key: 'team_id', label: 'Register', type: 'choice', options: [...eligible.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` })), { value: 'solo', label: 'Just me' }] }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/entries`, v.team_id === 'solo' ? {} : { team_id: v.team_id }); reloadAll(); return 'Registered — waiting for the organizer'; }} />
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
      {x.my_membership?.status === 'active' || x.can_manage || x.guardian_of_member ? <Btn title={x.guardian_of_member && !x.my_membership && !x.can_manage ? '💬 Guardians chat' : '💬 Team chat'} color={c.violet} onPress={() => push('TeamChat', { id })} style={{ marginTop: 12 }} /> : null}
      {x.my_membership?.status === 'active' || x.can_manage || x.guardian_of_member ? <Btn title="💳 Dues & funds" color={c.paper} ink={c.ink} onPress={() => push('TeamDues', { id })} style={{ marginTop: 10 }} /> : null}
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
  const ranks = useLoad(() => api.get(`/rankings/subjects/${id}`), [id]);
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
      <View style={{ marginTop: 12, alignItems: 'flex-start' }}><Btn small title="360° view" color={c.paper} ink={c.ink} onPress={() => push('Athlete360', { id })} accessibilityLabel="Open the 360 view" /></View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <StatPill value={stats.data?.total_points ?? '–'} label="OFFICIAL PTS" color={c.lime} /><StatPill value={awards.data?.length ?? '–'} label="AWARDS" color={c.sun} /><StatPill value={x.rating?.avg ?? '–'} label="RATING" color={c.pinkSoft} />
      </View>
      {x.sport_profiles.length ? <Section title="Sports" color={c.cyan}>{x.sport_profiles.map((s, i) => <Row key={i} left={<Bubble emoji={s.emoji} color={c.cyanSoft} />} title={`${s.sport} · ${s.role}`} sub={`${s.level}${s.position ? ' · ' + s.position : ''}`} />)}</Section> : null}
      {x.teams.length ? <Section title="Teams" color={c.violet}>{x.teams.map((t) => <Row key={t.id} onPress={() => push('Team', { id: t.id })} left={<Bubble emoji={t.emoji} color={t.color} />} title={t.name} sub={t.role} />)}</Section> : null}
      {stats.data?.by_metric?.length ? <Section title="Stats" color={c.mint}>
        <Card color={c.mintSoft}>{stats.data.by_metric.map((m, i) => <View key={i} style={{ paddingVertical: 4 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">{m.emoji} {m.metric.replace(/_/g, ' ')}</T><T weight="900">{withUnit(m.unit === 's' ? m.lowest : m.best, m.unit)} <T size={12} color={c.mute}>best · {m.entries} {m.entries === 1 ? 'entry' : 'entries'}</T></T></View><T size={11} color={c.mute}>{m.evidence_label}</T></View>)}</Card>
      </Section> : null}
      {ranks.data?.rankings?.length ? <Section title="Rankings" color={c.violet}>{ranks.data.rankings.map((r) => <Row key={r.ranking_id} title={`#${r.rank} · ${r.name}`} sub={`Based on ${r.sample_n} verified result${r.sample_n === 1 ? '' : 's'} across ${r.events_n} event${r.events_n === 1 ? '' : 's'} · version ${r.version} · ${r.evidence_strength} evidence`} />)}</Section> : null}
      {x.credentials?.length ? <Section title="Certificates & badges" color={c.mint}><CredentialList list={x.credentials} /></Section> : null}
      <Section title="Trophy cabinet" color={c.sun}><TrophyShelf awards={awards.data} /></Section>
      <Section title="Props from the community" color={c.pink}><Reviews type="user" id={id} canWrite={user.id !== id} /></Section>
    </Screen>
  );
}
