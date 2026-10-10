import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, H2, Loading, Screen, Section, Tag, T } from '../ui';
import { c } from '../theme';
import { dateTimeIn, localDate } from '../vtime';
import { locale } from '../locale';

const KINDS = [['match', 'Matches'], ['team', 'Team'], ['event', 'Events'], ['training', 'Training'], ['venue', 'Venue'], ['health', 'Health']];
const ICON = { match: '🏟️', team: '👥', event: '🏆', training: '🏋️', venue: '📍', health: '🩺' };
const STATUS = { proposed: 'Proposed', awaiting_response: 'Awaiting your response', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', open: 'Open', ongoing: 'Ongoing' };

export const ACTIONS = [
  ['🔎', 'Find a match', (n) => n.goTab('Play')],
  ['🧑‍🏫', 'Find a coach', (n) => n.goTab('Player')],
  ['👥', 'Create team', (n) => n.goTab('Play')],
  ['📍', 'Book venue', (n) => n.goTab('Book')],
  ['🏆', 'Create event', (n) => n.goTab('Play')],
  ['🩺', 'Physio / doctor', (n) => n.push('Health')],
];

export function Item({ x, reload }) {
  const nav = useNav();
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const respond = async (status) => {
    setBusy(true);
    try { await api.patch(`/squads/${x.source_id}`, { status }); toast(status === 'confirmed' ? 'Confirmed' : 'Declined'); await reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const open = () => {
    const { screen, params = {} } = x.link ?? {};
    if (screen === 'Health') nav.push('Health');
    else if (screen === 'Event' && params.id) nav.push('Event', params);
    else nav.goTab(x.kind === 'training' ? 'Player' : x.kind === 'venue' ? 'Book' : 'Play');
  };
  const when = x.all_day ? new Date(x.starts_at).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : dateTimeIn(x.starts_at, x.timezone);
  const label = `${x.title}. ${when}. ${STATUS[x.status] ?? x.status}${x.conflict ? '. Overlaps another commitment' : ''}`;
  return (
    <Card onPress={open} style={{ minHeight: 44 }}>
      <View accessible accessibilityLabel={label} style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <T size={22}>{ICON[x.kind]}</T>
          <View style={{ flex: 1 }}>
            <T weight="700" numberOfLines={2}>{x.title}</T>
            <T size={13} color={c.mute}>{when}{x.timezone && x.timezone !== 'UTC' ? ` (${x.timezone})` : ''}{x.context ? ` · ${x.context}` : ''}</T>
          </View>
          <Tag label={STATUS[x.status] ?? x.status} color={x.action_required ? c.sunSoft : c.violetSoft} />
        </View>
        {x.conflict ? <T size={13} weight="700" color={c.red}>⚠ Overlaps another commitment. Nothing was changed, so check each one.</T> : null}
        {x.actions?.includes('respond_to_selection') ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small title="Confirm" disabled={busy} onPress={() => respond('confirmed')} />
            <Btn small title="Decline" color={c.paper} ink={c.ink} disabled={busy} onPress={() => respond('declined')} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

export function AthleteToday() {
  const nav = useNav();
  const [kind, setKind] = useState(null);
  const sched = useLoad(() => api.get('/me/sport-schedule', kind ? { kinds: kind } : {}), [kind]);
  const items = sched.data?.items ?? [];
  const today = localDate(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const isToday = (x) => localDate(x.starts_at, x.all_day ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone) === today;
  const todays = items.filter(isToday);
  const inbox = items.filter((x) => x.action_required);

  return (
    <Screen refreshing={sched.loading && !!sched.data} onRefresh={sched.reload}>
      <H2>My sport</H2>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {ACTIONS.map(([emoji, label, go]) => <Btn key={label} small color={c.paper} ink={c.ink} title={`${emoji} ${label}`} onPress={() => go(nav)} />)}
      </View>

      {sched.loading && !sched.data ? <Loading /> : sched.error ? <ErrorBox error={sched.error} onRetry={sched.reload} /> : (
        <>
          {inbox.length ? <Section title={`Needs your response (${inbox.length})`}><View style={{ gap: 10 }}>{inbox.map((x) => <Item key={`i${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />)}</View></Section> : null}
          <Section title="Today"><View style={{ gap: 10 }}>
            {todays.length ? todays.map((x) => <Item key={`t${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />) : <Empty emoji="🗓️" title="Nothing scheduled today" sub="Find a match, book a venue or hire a coach to fill your week." />}
          </View></Section>
          <Section title="Next 14 days">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }} accessibilityRole="toolbar">
              <Chip label="All" active={!kind} onPress={() => setKind(null)} />
              {KINDS.map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => setKind(kind === k ? null : k)} />)}
            </View>
            {sched.data?.conflicts ? <T size={13} weight="700" color={c.red} style={{ marginBottom: 8 }}>⚠ {sched.data.conflicts} overlapping commitments</T> : null}
            <View style={{ gap: 10 }}>{items.length ? items.map((x) => <Item key={`w${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />) : <Empty emoji="✨" title="A clear fortnight" sub="Nothing on your calendar yet." />}</View>
          </Section>
        </>
      )}
    </Screen>
  );
}
