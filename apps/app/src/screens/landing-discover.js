// Public "Find support" block on the landing page: sponsorship calls and sponsors, physios & doctors, coaches, and study options.
// Everything reads the existing public endpoints; nothing is created here. Acting on a card (apply, book, enquire) sends the visitor
// to sign in, remembering what they wanted.
import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Avatar, T } from '../ui';
import { c, fam } from '../theme';
import { setIntent } from '../market/intent';
import { HScroll } from '../pickers';
import { moneyIn } from '../vtime';
import { absolute } from './spectate';

export const DISCOVER_TABS = [
  { key: 'events', emoji: '🏆', label: 'Events' },
  { key: 'sponsors', emoji: '🤝', label: 'Sponsors' },
  { key: 'health', emoji: '🩺', label: 'Physio & doctors' },
  { key: 'coaches', emoji: '🧑‍🏫', label: 'Coaches' },
  { key: 'study', emoji: '🎓', label: 'Study' },
];

const COPY = {
  events: ['Tournaments & events', 'Live scores, schedules, tables and results of public events. Open one to follow it — no login needed to watch.', 'Search events, cities and sports…'],
  sponsors: ['Sponsorship calls', 'Brands with a round open for applications right now. Apply for yourself, your team or your event.', 'Search calls and sponsors…'],
  health: ['Physios & doctors', 'Verified practitioners who treat athletes. See their fees and ratings, then log in to book.', 'Search by name, clinic or speciality…'],
  coaches: ['Coaches & trainers', 'Find a coach by sport and city. Log in to see open slots and book a session.', 'Search by name or speciality…'],
  study: ['Study & scholarships', 'Courses, certifications and degrees at colleges, universities and academies that welcome athletes.', 'Search courses and institutions…'],
};

const deadline = (instant, zone) => {
  if (!instant) return '';
  try { return new Date(instant).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone || 'UTC' }); } catch { return ''; }
};
const shortDay = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

const Tile = ({ children, tone = c.line }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, borderWidth: 1, borderColor: tone, padding: 18, gap: 8 }}>{children}</View>;
const Facts = ({ items }) => { const l = items.filter(Boolean); return l.length ? <T size={12} color={c.mute} style={{ lineHeight: 18 }}>{l.join(' · ')}</T> : null; };
const Cta = ({ title, onPress, label }) => (
  <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label ?? title} style={{ alignSelf: 'flex-start', backgroundColor: c.pink, borderRadius: 999, paddingVertical: 9, paddingHorizontal: 18, marginTop: 4 }}>
    <T weight="800" size={13} color={c.onAccent}>{title}</T>
  </Pressable>
);
const Rating = ({ r, n }) => (n ? <T size={12} weight="700" color={c.ink}>★ {Number(r).toFixed(1)} <T size={11} color={c.mute}>({n})</T></T> : <T size={12} weight="700" color={c.mute}>New</T>);
const Verified = ({ on }) => (on ? <T size={11} weight="800" color={c.lime}>✔ VERIFIED</T> : null);

/** Public events: live now, upcoming and completed. Opening one shows the public page (live games, table, bracket) without signing in. */
function Events({ q, sport }) {
  const [phase, setPhase] = useState(null);
  const res = useLoad(async () => (await api.get('/events/search', { limit: 12, sort: 'soonest', ...(phase ? { phase } : {}), ...(q ? { q } : {}), ...(sport ? { sport } : {}) })).items, [phase, q, sport]);
  const open = (id) => { if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.assign(`/?event=${id}`); else Linking.openURL(absolute(`/api/v1/share/events/${id}`)); };
  return (
    <View style={{ gap: 14 }}>
      <Chips value={phase} onChange={setPhase} options={[[null, 'All'], ['live', '🔴 Live now'], ['upcoming', 'Upcoming'], ['completed', 'Completed']]} />
      <Grid load={res} empty={['🏆', q || sport || phase ? 'No events match' : 'No public events yet', 'Organisers publish events here. Join free to host your own or to get alerts for the ones you follow.']} ask={() => {}}
        render={(e) => (
          <Tile key={e.id} tone={e.live_now ? '#F43F5E' : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}><T size={22}>{e.banner_emoji}</T></View>
              <View style={{ flex: 1 }}><T weight="800" size={16} numberOfLines={2}>{e.name}</T><T size={12} color={c.mute} numberOfLines={1}>{e.sport_emoji} {e.sport}{e.city ? ` · ${e.city}` : ''}</T></View>
              {e.live_now ? <T size={11} weight="900" color={c.red}>● LIVE</T> : null}
            </View>
            <Facts items={[shortDay(e.starts_on), e.entrants ? `${e.entrants} in` : null, e.registration_open ? 'Registration open' : null, e.entry_fee_cents === 0 ? 'Free entry' : null]} />
            <Cta title={e.live_now ? 'Watch live' : 'Open event page'} onPress={() => open(e.id)} label={`Open ${e.name}`} />
          </Tile>
        )} />
    </View>
  );
}

function Sponsors({ q, sport, ask }) {
  const calls = useLoad(() => api.get('/funding-opportunities', { limit: 12, ...(q ? { q } : {}), ...(sport ? { sport } : {}) }), [q, sport]);
  const brands = useLoad(() => api.get('/sponsors', { limit: 24, ...(q ? { q } : {}) }), [q]);
  const list = (sport ? (brands.data ?? []).filter((b) => !b.sports?.length || b.sports.includes(sport)) : brands.data) ?? [];
  return (
    <View style={{ gap: 18 }}>
      <Grid load={calls} empty={['📣', q || sport ? 'No open calls match' : 'No sponsorship calls are open right now', 'Sponsors publish calls here while a round is open. Join free to be told the moment one opens.']} ask={ask}
        render={(p) => (
          <Tile key={p.id} tone="#F59E0B">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: c.sunSoft, alignItems: 'center', justifyContent: 'center' }}><T size={22}>{p.sponsor_emoji ?? '🤝'}</T></View>
              <View style={{ flex: 1 }}><T weight="800" size={16} numberOfLines={2}>{p.name}</T><T size={12} color={c.mute} numberOfLines={1}>{p.sponsor_name}{p.sponsor_verified?.length ? ' ✔' : ''}</T></View>
            </View>
            {p.objective ? <T size={13} color="#334155" numberOfLines={3} style={{ lineHeight: 19 }}>{p.objective}</T> : null}
            <Facts items={[p.max_award_cents ? `Up to ${moneyIn(p.max_award_cents, p.currency)}` : null, p.sports?.length ? p.sports.join(', ') : 'Any sport', p.regions?.length ? p.regions.join(', ') : null, p.next_deadline ? `Closes ${deadline(p.next_deadline, p.rounds?.[0]?.timezone)}` : null]} />
            <Cta title="Apply for sponsorship" onPress={() => ask('sponsor', p.name)} label={`Apply to ${p.name}`} />
          </Tile>
        )} />
      {list.length ? (
        <View style={{ gap: 10 }}>
          <T weight="800" size={17}>Sponsors on the platform</T>
          <HScroll gap={12}>
            {list.map((b) => (
              <Pressable key={b.id} onPress={() => ask('sponsor', b.name)} accessibilityRole="button" accessibilityLabel={`${b.name}. Sign in to approach this sponsor`} style={{ width: 230, backgroundColor: c.paper, borderRadius: 18, borderWidth: 1, borderColor: c.line, padding: 14, gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T size={26}>{b.emoji ?? '🏷️'}</T><T weight="800" size={14} numberOfLines={1} style={{ flex: 1 }}>{b.name}</T></View>
                {b.tagline ? <T size={12} color="#334155" numberOfLines={2}>{b.tagline}</T> : null}
                <Facts items={[b.industry, b.sports?.length ? b.sports.slice(0, 3).join(', ') : null]} />
                <Verified on={b.verified?.length || b.badges?.length} />
              </Pressable>
            ))}
          </HScroll>
        </View>
      ) : null}
    </View>
  );
}

function Health({ q, sport, ask }) {
  const [type, setType] = useState(null);
  const res = useLoad(() => api.get('/providers/search', { limit: 12, ...(type ? { type } : {}), ...(q ? { q } : {}), ...(sport ? { sport } : {}) }), [type, q, sport]);
  return (
    <View style={{ gap: 14 }}>
      <Chips value={type} onChange={setType} options={[[null, 'All'], ['physio', '💆 Physios'], ['doctor', '🩺 Doctors']]} />
      <Grid load={res} empty={['🩺', 'No practitioners match', 'Try another sport or clear the search. Physios and doctors can join free and list their practice.']} ask={ask}
        render={(p) => (
          <Tile key={p.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Avatar user={p} size={48} />
              <View style={{ flex: 1 }}><T weight="800" size={16} numberOfLines={1}>{p.display_name}</T><T size={12} color={c.mute} numberOfLines={1}>{p.provider_type === 'doctor' ? '🩺 Doctor' : '💆 Physio'}{p.clinic ? ` · ${p.clinic}` : ''}</T></View>
              <Verified on={p.credential_verified} />
            </View>
            {p.headline ? <T size={13} color="#334155" numberOfLines={2}>{p.headline}</T> : null}
            <Facts items={[p.city, p.remote_ok ? 'Remote consults' : null, p.specialties?.length ? p.specialties.slice(0, 3).join(', ') : null, p.fee_cents ? `${moneyIn(p.fee_cents, p.currency)} / consult` : null]} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Rating r={p.rating} n={p.rating_count} /></View>
            <Cta title="Book an appointment" onPress={() => ask('provider', p.display_name)} label={`Book ${p.display_name}`} />
          </Tile>
        )} />
    </View>
  );
}

function Coaches({ q, sport, ask }) {
  const res = useLoad(() => api.get('/coaches', { limit: 12, ...(q ? { q } : {}), ...(sport ? { sport } : {}) }), [q, sport]);
  return (
    <Grid load={res} empty={['🧑‍🏫', sport || q ? 'No coaches match' : 'No coaches have listed yet', 'Coaches can join free, set their rates and hours and be found here.']} ask={ask}
      render={(p) => (
        <Tile key={`${p.id}-${p.sport_slug}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar user={p} size={48} />
            <View style={{ flex: 1 }}><T weight="800" size={16} numberOfLines={1}>{p.display_name}</T><T size={12} color={c.mute} numberOfLines={1}>{p.sport_emoji} {p.sport}{p.level ? ` · ${p.level}` : ''}</T></View>
            <Verified on={p.credential_verified} />
          </View>
          {p.headline || p.tagline ? <T size={13} color="#334155" numberOfLines={2}>{p.headline || p.tagline}</T> : null}
          <Facts items={[p.city, p.delivery === 'online' ? 'Online' : p.delivery === 'both' ? 'In person & online' : null, p.experience_years ? `${p.experience_years} yrs experience` : null, p.hourly_rate_cents ? `${moneyIn(p.hourly_rate_cents, p.currency)} / hour` : null, p.has_intro ? 'Intro offer' : null]} />
          <Rating r={p.rating} n={p.rating_count} />
          <Cta title="Book a session" onPress={() => ask('coach', p.display_name)} label={`Book ${p.display_name}`} />
        </Tile>
      )} />
  );
}

function Study({ q, sport, ask }) {
  const res = useLoad(() => api.get('/programmes', { limit: 12, ...(q ? { q } : {}), ...(sport ? { sport } : {}) }), [q, sport]);
  return (
    <Grid load={res} empty={['🎓', 'No courses match', 'Colleges, universities and academies can list their programmes for athletes here.']} ask={ask}
      render={(p) => (
        <Tile key={p.id}>
          <T weight="800" size={16} numberOfLines={2}>{p.title}</T>
          <T size={12} color={c.mute} numberOfLines={1}>🏫 {p.institution}{p.city ? ` · ${p.city}` : ''}{p.country ? `, ${p.country}` : ''}</T>
          {p.description ? <T size={13} color="#334155" numberOfLines={2}>{p.description}</T> : null}
          <Facts items={[p.kind, p.mode?.replace('_', ' '), p.duration_months ? `${p.duration_months} months` : null, p.fee_minor ? moneyIn(p.fee_minor, p.currency) : null, p.next_intake_on ? `Next intake ${shortDay(p.next_intake_on)}` : null]} />
          <Cta title="Ask about this course" onPress={() => ask('study', p.title)} label={`Ask about ${p.title}`} />
        </Tile>
      )} />
  );
}

const Chips = ({ options, value, onChange }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
    {options.map(([k, l]) => <Pressable key={l} onPress={() => onChange(k)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: value === k ? c.pinkSoft : c.paper, borderWidth: 1, borderColor: value === k ? c.pink : c.line }}><T size={13} weight="700" color={value === k ? c.pink : '#334155'}>{l}</T></Pressable>)}
  </View>
);

/** Responsive card grid with loading, error and empty states. */
function Grid({ load, render, empty, ask }) {
  const rows = load.data ?? [];
  if (load.error) return <T color={c.red} weight="600">{load.error.message ?? String(load.error)}</T>;
  if (load.loading && !load.data) return <T color={c.mute}>Loading…</T>;
  if (!rows.length) return (
    <View style={{ alignItems: 'center', gap: 8, padding: 32, backgroundColor: c.paper, borderRadius: 22, borderWidth: 1, borderColor: c.line }}>
      <T size={42}>{empty[0]}</T><T weight="800" size={18}>{empty[1]}</T>
      <T color={c.mute} style={{ textAlign: 'center', maxWidth: 440 }}>{empty[2]}</T>
      <Pressable onPress={() => ask('join')}><T color={c.pink} weight="800">Join free →</T></Pressable>
    </View>
  );
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>{rows.map((r) => <View key={r.id} style={{ flexGrow: 1, flexBasis: 300, maxWidth: '100%' }}>{render(r)}</View>)}</View>;
}

/**
 * `tab` / `onTab` are controlled by the landing page so the nav links can jump straight to a tab.
 * `sport` is the landing page's sport filter; `onAsk(action, title)` opens the sign-in flow with that intent.
 */
export function Discover({ tab, onTab, sport, onAsk }) {
  const [text, setText] = useState({});
  const typed = (text[tab] ?? '').trim();
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(typed), 300); return () => clearTimeout(t); }, [typed]);
  const ask = (action, title) => { const i = { action, title }; setIntent(i); onAsk(i); };
  const [head, sub, ph] = COPY[tab];
  const Body = { events: Events, sponsors: Sponsors, health: Health, coaches: Coaches, study: Study }[tab];
  return (
    <View style={{ gap: 16 }}>
      <View>
        <T weight="800" size={28} style={{ letterSpacing: -1 }}>Find support for your game</T>
        <T color={c.mute} size={15} style={{ marginTop: 4 }}>Live events, sponsors, physios and doctors, coaches and study options — browse freely, log in only when you want to apply or book.</T>
      </View>
      <HScroll gap={8}>
        {DISCOVER_TABS.map((t) => (
          <Pressable key={t.key} onPress={() => onTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }} style={{ paddingVertical: 11, paddingHorizontal: 20, borderRadius: 999, backgroundColor: tab === t.key ? c.ink : c.paper, borderWidth: 1, borderColor: tab === t.key ? c.ink : c.line }}>
            <T weight="800" size={14} color={tab === t.key ? c.inkOn : c.mute}>{t.emoji} {t.label}</T>
          </Pressable>
        ))}
      </HScroll>
      <View style={{ gap: 4 }}><T weight="800" size={20}>{head}</T><T size={13} color={c.mute}>{sub}</T></View>
      <TextInput value={text[tab] ?? ''} onChangeText={(v) => setText((p) => ({ ...p, [tab]: v }))} placeholder={ph} placeholderTextColor="#94A3B8" accessibilityLabel={ph}
        style={[fam, { maxWidth: 460, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 }]} />
      <Body key={tab} q={q} sport={sport} ask={ask} />
    </View>
  );
}
