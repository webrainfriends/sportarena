import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Bubble, Chip, Empty, ErrorBox, Loading, Row, Screen, Seg, Section, T } from '../ui';
import { HScroll } from '../pickers';
import { HomeSchedule } from './athlete-home';
import { Book } from './book';
import { Hire } from './coaching';
import { CreateEvent } from './event-create';
import { StartTeamSheet, TeamInvites } from './play';
import { c, day } from '../theme';

// One home for everything with a date on it: your calendar, booking venues and coaches, and running your own events and teams.
const SECTIONS = [['agenda', 'My schedule'], ['book', 'Venues'], ['coach', 'Coaches'], ['manage', 'Events & teams']];
let lastSection = 'agenda'; // survive pushing into a page and coming back

const EVENT_VIEWS = [['active', 'Active'], ['draft', 'Drafts'], ['completed', 'Finished']];

const Agenda = () => <Screen><HomeSchedule /></Screen>;

/** What I run: events I organise (the event console is where they are run) and the teams I belong to. */
function Manage({ onCreate }) {
  const { push } = useNav();
  const { user } = useSession();
  const [view, setView] = useState('active');
  const events = useLoad(() => api.get('/events/search', { organizer_id: user.id, status: view === 'active' ? undefined : view, limit: 50 }), [user.id, view]);
  const teams = useLoad(() => api.get('/teams', { mine: true, limit: 50 }), []);
  return (
    <Screen onRefresh={() => { events.reload(); teams.reload(); }}>
      <TeamInvites onChanged={teams.reload} />
      <Section title="Events I run" color={c.pink}>
        <Btn title="＋ Create event" color={c.pink} onPress={onCreate} />
        <Seg options={EVENT_VIEWS.map(([value, label]) => ({ value, label }))} value={view} onChange={setView} color={c.pink} />
        {events.error ? <ErrorBox error={events.error} onRetry={events.reload} /> : events.loading && !events.data ? <Loading /> : events.data?.items?.length ? events.data.items.map((e) => (
          <Row key={e.id} onPress={() => push('EventCommand', { id: e.id })} left={<Bubble emoji={e.banner_emoji} color={c.pinkSoft} />} title={e.name}
            sub={`${e.sport_emoji} ${e.sport} · ${e.status}${e.starts_on ? ` · ${day(e.starts_on)}` : ''} · ${e.entrants} in`} right={<T color={c.pink} weight="700">›</T>} />
        )) : <Empty emoji="🏆" title={view === 'active' ? 'No events running' : view === 'draft' ? 'No drafts' : 'Nothing finished yet'} sub={view === 'active' ? 'Tap Create event above and run it all from one console: teams, people, boards, games, venue, business and results.' : undefined} />}
      </Section>
      <Section title="My teams" color={c.violet}>
        {teams.error ? <ErrorBox error={teams.error} onRetry={teams.reload} /> : teams.loading && !teams.data ? <Loading /> : teams.data?.length ? teams.data.map((t) => (
          <Row key={t.id} onPress={() => push('TeamWorkspace', { id: t.id })} left={<Bubble emoji={t.emoji} color={t.color} />} title={t.name} sub={`${t.sport_emoji} ${t.sport} · ${t.members} members`} right={<T color={c.pink} weight="700">›</T>} />
        )) : <Empty emoji="🛡️" title="No teams yet" sub="Use Start a team above to plan sessions, pick squads and chat, or find one to join under Explore." />}
      </Section>
    </Screen>
  );
}

/** The event manager's own screen (shown under their queue on the Workbench): events they run and their teams, with the create sheets. */
export function EventsWorkspace() {
  const { push } = useNav();
  const [form, setForm] = useState(null);
  const [tick, setTick] = useState(0);
  const created = () => setTick((n) => n + 1);
  return (
    <View style={{ flex: 1 }}>
      <Manage key={tick} onCreate={() => setForm('event')} />
      <StartTeamSheet visible={form === 'team'} onClose={() => setForm(null)} onCreated={created} />
      <CreateEvent visible={form === 'event'} onClose={() => setForm(null)} onCreated={(e) => { created(); push('EventCommand', { id: e.id }); }} />
    </View>
  );
}

/** Schedule tab: create, book, track and manage in one place. `section` (via goTab) opens a specific part. */
export function Schedule({ section }) {
  const { push } = useNav();
  const { gutter, contentMax } = useLayout();
  const [sec, setSec] = useState(section ?? lastSection);
  const [form, setForm] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (section) { lastSection = section; setSec(section); } }, [section]);
  const pick = (v) => { lastSection = v; setSec(v); };
  const created = () => setTick((n) => n + 1);

  const actions = [
    ['🏆', 'Create event', () => setForm('event')],
    ['👥', 'Start a team', () => setForm('team')],
    ['📍', 'Book a venue', () => pick('book')],
    ['🔁', 'Recurring booking', () => push('RecurringVenue')],
    ['🧑‍🏫', 'Hire a coach', () => pick('coach')],
    ['🩺', 'Physio / doctor', () => push('Health')],
  ];
  const Body = { agenda: Agenda, book: Book, coach: Hire, manage: Manage }[sec];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ width: '100%', maxWidth: contentMax, alignSelf: 'center', paddingHorizontal: gutter, paddingTop: 8 }}>
        <HScroll>{actions.map(([emoji, label, go]) => <Chip key={label} label={`${emoji} ${label}`} onPress={go} />)}</HScroll>
        <Seg options={SECTIONS.map(([value, label]) => ({ value, label }))} value={sec} onChange={pick} color={c.pink} />
      </View>
      <View style={{ flex: 1 }}><Body key={`${sec}${tick}`} onCreate={() => setForm('event')} /></View>
      <StartTeamSheet visible={form === 'team'} onClose={() => setForm(null)} onCreated={created} />
      <CreateEvent visible={form === 'event'} onClose={() => setForm(null)} onCreated={(e) => { created(); push('EventCommand', { id: e.id }); }} />
    </View>
  );
}
