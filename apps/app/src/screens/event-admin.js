// Tournament console: one place to run a tournament — set up, invite and seed teams, schedule games, follow the bracket,
// hire crew and bring in vendors and sponsors. Every choice is a picker (people, teams, dates, courts), never an id.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Screen, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { todayLocal } from '../pickers';
import { BracketView, Bar, Crest, GameDays, MatchCard, PillTabs, SectionTitle, SetupSteps, StatTile, TeamCard, TournamentHero, dayKey, dayLabel } from '../tournament-ui';
import { EventVenues } from './event-venues';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const ROLES = [['referee', 'Referee'], ['umpire', 'Umpire'], ['linesman', 'Linesman'], ['scorer', 'Scorer'], ['doctor', 'Doctor'], ['physio', 'Physio'], ['medic', 'Medic'], ['volunteer', 'Volunteer'], ['security', 'Security'], ['other', 'Other']];
const ROLE_ICON = { referee: '🟨', umpire: '🧑‍⚖️', linesman: '🚩', scorer: '📝', doctor: '🩺', physio: '💆', medic: '⛑️', volunteer: '🙋', security: '🛡️', other: '🔧' };
const STATUS_COLOR = { accepted: c.limeSoft, invited: c.sunSoft, declined: c.orangeSoft, withdrawn: c.violetSoft, released: c.violetSoft, expired: c.violetSoft };
const useDo = (toast, refresh) => async (fn, msg) => { try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg); refresh?.(); return r; } catch (x) { toast('' + x.message); return null; } };

export function EventAdmin({ id }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('overview');
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  const fx = useLoad(() => api.get('/fixtures', { event_id: id, limit: 100 }), [id]);
  const venues = useLoad(() => api.get(`/events/${id}/venues`), [id]);
  const inv = useLoad(() => api.get(`/events/${id}/invitations`), [id]);
  const seeds = useLoad(() => api.get(`/events/${id}/seeds`), [id]);
  const bracket = useLoad(() => api.get(`/events/${id}/bracket`), [id]);
  const roles = useLoad(() => api.get(`/events/${id}/staff-roles`), [id]);
  const staff = useLoad(() => api.get(`/events/${id}/staff-assignments`), [id]);
  const vend = useLoad(() => api.get(`/events/${id}/vendors`), [id]);
  const money = useLoad(() => api.get(`/events/${id}/commercials`), [id]);
  const all = [ev, fx, venues, inv, seeds, bracket, roles, staff, vend, money];
  const reload = () => all.forEach((l) => l.reload());
  if (ev.error) return <Screen><ErrorBox error={ev.error} onRetry={ev.reload} /></Screen>;
  if (!ev.data) return <Screen><Loading /></Screen>;
  const e = ev.data, games = fx.data ?? [];
  const accepted = e.entrants.filter((x) => x.team_id);
  const crew = (staff.data ?? []).filter((s) => s.status === 'accepted').length;
  const slots = (venues.data ?? []).reduce((n, v) => n + v.summary.slots, 0);
  const played = games.filter((g) => g.status === 'completed').length;
  const P = { id, e, toast, reload, games, accepted, venues: venues.data ?? [], inv: inv.data ?? [], seeds: seeds.data ?? [], bracket: bracket.data, roles: roles.data ?? [], staff: staff.data ?? [], vend: vend.data ?? [], money: money.data, go: setTab };
  const pending = (inv.data ?? []).filter((n) => n.status === 'invited').length;
  const tabs = [
    { key: 'overview', label: 'Overview', icon: '🏁' }, { key: 'teams', label: 'Teams', icon: '👥', badge: pending || undefined }, { key: 'schedule', label: 'Schedule', icon: '🗓️' },
    { key: 'bracket', label: 'Bracket', icon: '🏆' }, { key: 'venue', label: 'Venue', icon: '🏟️' }, { key: 'crew', label: 'Crew', icon: '🩺' }, { key: 'business', label: 'Business', icon: '💼' },
  ];
  return (
    <Screen wide>
      <TournamentHero e={e} note={e.capacity ? `${accepted.length}/${e.capacity} teams` : undefined}
        stats={[{ icon: '👥', value: accepted.length, label: 'Teams' }, { icon: '⚽', value: `${played}/${games.length}`, label: 'Games played' }, { icon: '🏟️', value: slots, label: 'Court bookings' }, { icon: '🩺', value: crew, label: 'Crew' }]} />
      <View style={{ marginTop: 14 }}><PillTabs tabs={tabs} value={tab} onChange={setTab} /></View>
      <View style={{ gap: 14, marginTop: 14 }}>
        {tab === 'overview' && <Overview {...P} played={played} slots={slots} crew={crew} />}
        {tab === 'teams' && <Teams {...P} />}
        {tab === 'schedule' && <Schedule {...P} />}
        {tab === 'bracket' && <Bracket {...P} />}
        {tab === 'venue' && <EventVenues e={e} toast={toast} onChange={reload} />}
        {tab === 'crew' && <Crew {...P} />}
        {tab === 'business' && <Business {...P} />}
      </View>
    </Screen>
  );
}

// ---------------------------------------------------------------- overview
function Overview({ e, games, accepted, seeds, bracket, venues, slots, crew, vend, money, toast, reload, go }) {
  const [score, setScore] = useState(null);
  const upcoming = games.filter((g) => g.status !== 'completed' && g.status !== 'cancelled').sort((a, b) => +new Date(a.scheduled_at) - +new Date(b.scheduled_at));
  const next = upcoming[0];
  const sponsors = vend.filter((v) => v.kind === 'sponsor' && v.status === 'accepted').length;
  const steps = [
    { key: 'venue', title: 'Book a venue & courts', sub: slots ? `${slots} court booking${slots === 1 ? '' : 's'} at ${venues.find((v) => v.summary.slots)?.name ?? 'your venue'}` : 'Choose a venue with courts for your sport', done: slots > 0, cta: 'Find venue', onPress: () => go('venue') },
    { key: 'teams', title: 'Invite teams', sub: accepted.length ? `${accepted.length} team${accepted.length === 1 ? '' : 's'} in${e.capacity ? ` of ${e.capacity}` : ''}` : 'Rank teams from past results and invite them', done: accepted.length >= 2, cta: 'Invite', onPress: () => go('teams') },
    { key: 'seeds', title: 'Seed the teams', sub: seeds.length ? 'Seeds set from results' : 'Strongest team gets seed 1', done: seeds.length >= 2, cta: 'Seed', onPress: () => go('teams') },
    { key: 'sched', title: 'Schedule the games', sub: games.length ? `${games.length} games scheduled` : 'Fit games into free courts, skipping holidays', done: games.length > 0, cta: 'Plan', onPress: () => go('schedule') },
    { key: 'bracket', title: 'Knockout bracket', sub: bracket?.rounds?.length ? 'Bracket is live' : 'Quarter-finals → semi-finals → final', done: !!bracket?.rounds?.length, cta: 'Create', onPress: () => go('schedule') },
    { key: 'crew', title: 'Hire referees & medical cover', sub: crew ? `${crew} confirmed` : 'Referees, doctors, physios, volunteers', done: crew > 0, cta: 'Hire', onPress: () => go('crew') },
    { key: 'biz', title: 'Sponsors & vendors', sub: sponsors ? `${sponsors} sponsor${sponsors === 1 ? '' : 's'}` : 'Bring in sponsors and retail stalls', done: sponsors > 0 || vend.some((v) => v.status === 'accepted'), cta: 'Add', onPress: () => go('business') },
  ];
  return (
    <>
      <SetupSteps steps={steps} />
      <SectionTitle title="Up next" action={games.length ? 'All games' : undefined} onAction={() => go('schedule')} />
      {next ? <MatchCard f={next} spotlight onScore={setScore} /> : <Empty emoji="🗓️" title="No games scheduled yet" sub="Plan the schedule once teams are in." />}
      {money ? (
        <>
          <SectionTitle title="Money" sub={`In ${e.currency ?? 'INR'}`} action="Details" onAction={() => go('business')} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <StatTile icon="📥" label="Income" value={moneyIn(money.income_cents, money.currency)} tone={c.limeSoft} />
            <StatTile icon="📤" label="Crew cost" value={moneyIn(money.expected_cost_cents, money.currency)} tone={c.sunSoft} />
            <StatTile icon="📊" label="Net" value={moneyIn(money.net_cents, money.currency)} />
          </View>
        </>
      ) : null}
      <ResultSheet score={score} onClose={() => setScore(null)} onSaved={reload} />
    </>
  );
}

function ResultSheet({ score, onClose, onSaved }) {
  const knockout = score && ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final', 'third_place'].includes(score.round_kind);
  return (
    <FormSheet visible={!!score} onClose={onClose} title={score ? `${score.home_name} vs ${score.away_name}` : ''} submitLabel="Save result" initial={{ home_score: 0, away_score: 0 }}
      fields={[{ key: 'home_score', label: score?.home_name ?? 'Home', type: 'stepper', min: 0, max: 999, default: 0 }, { key: 'away_score', label: score?.away_name ?? 'Away', type: 'stepper', min: 0, max: 999, default: 0 },
        ...(knockout ? [{ key: 'winner_team_id', label: 'If level, who won (extra time / penalties)?', type: 'choice', optional: true, options: [{ value: score.home_team_id, label: score.home_name }, { value: score.away_team_id, label: score.away_name }] }] : [])]}
      onSubmit={async (v) => { await api.post(`/fixtures/${score.id}/result`, { home_score: v.home_score, away_score: v.away_score, winner_team_id: v.winner_team_id || undefined }); onSaved(); return knockout ? 'Result saved — the winner moves on' : 'Result saved'; }} />
  );
}

// ---------------------------------------------------------------- teams
function Teams({ id, e, accepted, inv, seeds, toast, reload }) {
  const [q, setQ] = useState(''), [rulesOpen, setRulesOpen] = useState(false);
  const sug = useLoad(() => api.get(`/events/${id}/suggestions`, { limit: 100 }), [id]);
  const rules = useLoad(() => api.get(`/events/${id}/rules`), [id]);
  const refresh = () => { sug.reload(); rules.reload(); reload(); };
  const act = useDo(toast, refresh);
  const seedOf = useMemo(() => new Map(seeds.map((s) => [s.team_id, s])), [seeds]);
  const items = (sug.data?.items ?? []).filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || (t.city ?? '').toLowerCase().includes(q.toLowerCase()));
  const max = Math.max(...(sug.data?.items ?? []).map((t) => t.rating), 1);
  const r = (k) => rules.data?.find((x) => x.kind === k)?.params;
  const cities = [...new Set((sug.data?.items ?? []).map((t) => t.city).filter(Boolean))];
  const open = inv.filter((n) => n.status === 'invited');
  return (
    <>
      <SectionTitle title={`Teams in (${accepted.length}${e.capacity ? `/${e.capacity}` : ''})`} />
      {accepted.length ? accepted.map((t) => { const s = seedOf.get(t.team_id); return <TeamCard key={t.entry_id} team={t} seed={s?.seed} rating={s?.rating ?? undefined} maxRating={max} note={s ? `${s.source} seed` : 'Not seeded yet'} />; }) : <Empty emoji="👥" title="No teams yet" sub="Invite teams below — they appear here once they accept." />}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="Seed from results" onPress={() => act(() => api.post(`/events/${id}/seeds/compute`, { method: 'rating' }), 'Teams seeded')} disabled={accepted.length < 2} />
        <Btn small title="Seed from standings" color={c.violet} onPress={() => act(() => api.post(`/events/${id}/seeds/compute`, { method: 'standings' }), 'Teams seeded')} disabled={accepted.length < 2} />
      </View>

      <SectionTitle title="Recommended to invite" sub="Ranked from past results — recent wins and goal difference, adjusted for few games" action="Rules" onAction={() => setRulesOpen(true)} />
      {rules.data?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{rules.data.map((x) => <Tag key={x.id} label={`${x.kind.replace(/_/g, ' ')}${Object.keys(x.params).length ? `: ${Object.values(x.params).join(', ')}` : ''}`} color={c.pinkSoft} />)}</View> : null}
      <Field value={q} onChangeText={setQ} placeholder="Search teams by name or city…" />
      {sug.loading && !sug.data ? <Loading /> : items.length ? items.map((t) => (
        <TeamCard key={t.team_id} team={t} rating={t.rating} maxRating={max} note={`#${t.rank} · ${t.played} games · ${t.won}W ${t.drawn}D ${t.lost}L${t.city ? ` · ${t.city}` : ''}`}
          right={<Btn small title="Invite" onPress={() => act(() => api.post(`/events/${id}/invitations`, { invitees: [{ team_id: t.team_id }], source: 'ranking' }), `${t.name} invited`)} />} />
      )) : <Empty emoji="🔎" title={q ? 'No team matches' : 'No candidates'} sub={q ? 'Try another name or city.' : 'Teams of this sport that are not already in or invited show up here.'} />}
      {items.length > 1 && !q ? <Btn title={`Invite the top ${Math.min(items.length, e.capacity ? Math.max((e.capacity - accepted.length - open.length), 1) : items.length)}`} color={c.violet}
        onPress={() => act(() => api.post(`/events/${id}/invitations`, { invitees: items.slice(0, e.capacity ? Math.max(e.capacity - accepted.length - open.length, 1) : items.length).map((t) => ({ team_id: t.team_id })), source: 'ranking' }), 'Invitations sent')} /> : null}

      <SectionTitle title="Invitations" />
      {inv.length ? inv.map((n) => (
        <Row key={n.id} left={<Crest emoji={n.team_emoji ?? '🏃'} size={40} />} title={n.team_name ?? n.user_name} sub={`${n.source}${n.rating ? ` · rating ${Number(n.rating).toFixed(2)}` : ''}`}
          right={<><View style={{ backgroundColor: STATUS_COLOR[n.status], borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}><T size={11} weight="800">{n.status}</T></View>{n.status === 'invited' ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/event-invitations/${n.id}/withdraw`), 'Withdrawn')} /> : null}</>} />
      )) : <Empty emoji="✉️" title="Nobody invited yet" />}

      <FormSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} title="Who should be invited?" submitLabel="Save rules"
        initial={{ top: r('invite_top_n')?.n, city: r('city')?.city, min_games: r('min_games')?.n }}
        fields={[
          { key: 'top', label: 'Only the strongest N teams', type: 'stepper', min: 1, max: 500, optional: true },
          { key: 'min_games', label: 'At least this many past games', type: 'stepper', min: 0, max: 100, optional: true },
          ...(cities.length ? [{ key: 'city', label: 'Only teams from', type: 'chips', optional: true, options: cities }] : []),
        ]}
        onSubmit={async (v) => {
          const next = [];
          if (v.top) next.push({ kind: 'invite_top_n', params: { n: v.top } });
          if (v.city) next.push({ kind: 'city', params: { city: v.city } });
          if (v.min_games) next.push({ kind: 'min_games', params: { n: v.min_games } });
          for (const x of rules.data ?? []) if (['min_rating', 'exclude_team', 'seeding', 'note'].includes(x.kind)) next.push({ kind: x.kind, params: x.params });
          await api.post(`/events/${id}/rules`, { rules: next }); refresh(); return 'Rules saved';
        }} />
    </>
  );
}

// ---------------------------------------------------------------- schedule
function Schedule({ id, e, games, accepted, venues, toast, reload }) {
  const [form, setForm] = useState(null), [preview, setPreview] = useState(null), [dayOff, setDayOff] = useState(false), [holiday, setHoliday] = useState(false), [score, setScore] = useState(null);
  const cal = useLoad(() => api.get(`/events/${id}/calendar`), [id]);
  const refresh = () => { cal.reload(); reload(); };
  const act = useDo(toast, refresh);
  const venue = venues.find((v) => v.chosen) ?? venues[0];
  const byDay = games.reduce((m, g) => { const k = dayKey(g.scheduled_at, g.venue_timezone); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const dates = Object.keys(byDay).sort();
  const [sel, setSel] = useState(null);
  const day = sel && byDay[sel] ? sel : (dates.find((d) => d >= new Date().toLocaleDateString('en-CA')) ?? dates[0]);
  const shown = games.filter((g) => !day || dayKey(g.scheduled_at, g.venue_timezone) === day).sort((a, b) => +new Date(a.scheduled_at) - +new Date(b.scheduled_at));
  const args = (v) => ({ format: form, from_date: v.window, to_date: v.windowTo ?? v.window, match_duration_min: v.duration, rest_min: v.rest, max_per_team_per_day: v.perDay, third_place: !!v.third_place, respect_holidays: v.holidays !== false, from: v.from ?? 'seeds', top_n: v.top || undefined });
  const planFields = [
    { key: 'window', toKey: 'windowTo', label: 'Play between', type: 'daterange', min: todayLocal(), hint: 'The scheduler fits games into your venue’s free court slots inside these days.' },
    { key: 'duration', label: 'Game length (minutes)', type: 'stepper', min: 10, max: 240, step: 5, default: 60 },
    { key: 'rest', label: 'Rest between a team’s games (minutes)', type: 'stepper', min: 0, max: 600, step: 15, default: 60 },
    { key: 'perDay', label: 'Most games per team per day', type: 'stepper', min: 1, max: 6, default: 1 },
    { key: 'holidays', label: 'Skip public holidays', type: 'switch' },
  ];
  return (
    <>
      {!venue ? (
        <Card color={c.sunSoft}><T weight="800">Book a venue first</T><T color={c.mute} size={13}>Games are placed on the courts you book — open the Venue tab.</T></Card>
      ) : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T size={20}>{venue.emoji ?? '🏟️'}</T><T weight="700" style={{ flex: 1 }}>{venue.name}</T><Tag label={`${venue.summary.courts} courts`} color={c.cyanSoft} /></View>}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="Plan group stage" onPress={() => setForm('round_robin')} disabled={accepted.length < 2} />
        <Btn small title="Plan knockout" color={c.violet} onPress={() => setForm('knockout')} disabled={accepted.length < 2} />
        <Btn small title="Block a day" color={c.paper} ink={c.ink} onPress={() => setDayOff(true)} />
        <Btn small title="Public holiday" color={c.paper} ink={c.ink} onPress={() => setHoliday(true)} />
      </View>
      {accepted.length < 2 ? <T size={12} color={c.mute}>Accept at least two teams to plan games.</T> : null}

      {preview ? (
        <Card color={c.limeSoft} pad={14}>
          <T weight="800" size={16}>Preview · {preview.items.length - preview.unplaced.length} of {preview.items.length} games fit at {preview.venue.name}</T>
          {Object.keys(preview.skipped_dates).length ? <T color={c.mute} size={12}>Skipped: {Object.entries(preview.skipped_dates).map(([d, why]) => `${dayLabel(`${d}T12:00:00`)} (${why})`).join(', ')}</T> : null}
          <View style={{ gap: 10, marginTop: 10 }}>{preview.items.slice(0, 24).map((it) => (
            <MatchCard key={it.key} f={{ round: it.round, scheduled_at: it.scheduled_at ?? new Date().toISOString(), home_name: it.home_name, home_emoji: it.home_emoji, home_color: it.home_color, home_placeholder: it.home_placeholder ?? '—', away_name: it.away_name, away_emoji: it.away_emoji, away_color: it.away_color, away_placeholder: it.away_placeholder ?? '—', resource_name: it.resource_name, duration_min: it.duration_min, venue_timezone: preview.venue.timezone, status: 'scheduled' }} />
          ))}</View>
          {preview.unplaced.length ? <T color={c.red} weight="800" style={{ marginTop: 8 }}>{preview.unplaced.length} game(s) do not fit — widen the dates or book more courts.</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Btn title="Create these games" disabled={!!preview.unplaced.length} onPress={() => act(async () => { await api.post(`/events/${id}/schedule`, preview.args); setPreview(null); }, 'Schedule created')} />
            <Btn title="Dismiss" color={c.paper} ink={c.ink} onPress={() => setPreview(null)} />
          </View>
        </Card>
      ) : null}

      <SectionTitle title="Games" sub={games.length ? `${games.length} scheduled` : undefined} />
      {games.length ? (
        <>
          <GameDays days={dates.map((d) => ({ date: d, count: byDay[d] }))} value={day} onChange={setSel} />
          {shown.length ? shown.map((g) => <MatchCard key={g.id} f={g} onScore={setScore} />) : <Empty emoji="😴" title="No games this day" />}
        </>
      ) : <Empty emoji="🗓️" title="No games yet" sub="Plan a group stage or knockout — we fit the games into your booked courts with no clashes." />}

      <SectionTitle title="Days off" sub="Public holidays of the venue’s country and city are skipped automatically" />
      {cal.data?.length ? cal.data.map((d) => <Row key={d.id} title={`${dayLabel(`${String(d.on_date).slice(0, 10)}T12:00:00`)} · ${d.kind.replace('_', ' ')}`} sub={d.label ?? ''} right={<Btn small title="Lift" color={c.paper} ink={c.ink} onPress={() => act(() => api.del(`/events/${id}/calendar/${d.id}`), 'Lifted')} />} />) : <T color={c.mute} size={13}>No blocked days.</T>}

      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form === 'knockout' ? 'Plan the knockout' : 'Plan the group stage'} submitLabel="Preview games"
        initial={{ duration: 60, rest: 60, perDay: 1, holidays: true, from: 'seeds' }}
        fields={[...planFields,
          ...(form === 'knockout' ? [
            { key: 'from', label: 'Who plays', type: 'choice', options: [{ value: 'seeds', label: 'By seed' }, { value: 'standings', label: 'Top of the table' }] },
            { key: 'top', label: 'Only the first N teams', type: 'stepper', min: 2, max: 32, optional: true },
            { key: 'third_place', label: 'Third-place game', type: 'switch' }] : [])]}
        onSubmit={async (v) => { if (!v.window) throw new Error('Pick the days to play between'); const a = args(v); const p = await api.post(`/events/${id}/schedule/preview`, a); setPreview({ ...p, args: a }); return 'Preview ready'; }} />
      <FormSheet visible={dayOff} onClose={() => setDayOff(false)} title="Block a day" submitLabel="Block" initial={{ kind: 'blackout' }}
        fields={[{ key: 'on_date', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type', type: 'choice', options: [{ value: 'blackout', label: 'Blackout' }, { value: 'rest_day', label: 'Rest day' }, { value: 'holiday', label: 'Holiday' }] }, { key: 'label', label: 'Note', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/calendar`, { days: [{ on_date: v.on_date, kind: v.kind, label: v.label || undefined }] }); refresh(); return 'Day blocked'; }} />
      <HolidaySheet visible={holiday} onClose={() => setHoliday(false)} venue={venue} toast={toast} onSaved={refresh} />
      <ResultSheet score={score} onClose={() => setScore(null)} onSaved={reload} />
    </>
  );
}

function HolidaySheet({ visible, onClose, venue, onSaved }) {
  const v = useLoad(() => (venue && visible ? api.get(`/venues/${venue.id}`) : Promise.resolve(null)), [venue?.id, visible]);
  const country = v.data?.country;
  return (
    <FormSheet visible={visible} onClose={onClose} title="Public holiday" submitLabel="Save"
      fields={[{ key: 'on_date', label: 'Date', type: 'date' }, { key: 'label', label: 'Name of the holiday' },
        ...(country ? [] : [{ key: 'country', label: 'Country', hint: 'Set a venue country to skip this step next time.' }]), { key: 'local', label: `Only in ${venue?.city ?? 'this city'}`, type: 'switch', optional: true }]}
      onSubmit={async (f) => { await api.post('/holidays', { country: country ?? f.country, region: f.local ? venue?.city : undefined, days: [{ on_date: f.on_date, label: f.label }] }); onSaved(); return 'Holiday saved — scheduling will skip it'; }} />
  );
}

// ---------------------------------------------------------------- bracket
function Bracket({ bracket, go }) {
  return bracket?.rounds?.length ? <BracketView data={bracket} /> : (
    <Card pad={20}>
      <T size={44} style={{ textAlign: 'center' }}>🏆</T>
      <T weight="800" size={18} style={{ textAlign: 'center' }}>No knockout yet</T>
      <T color={c.mute} style={{ textAlign: 'center', marginTop: 4 }}>Seed the teams, book courts, then plan a knockout: quarter-finals, semi-finals and the final fill in as results come in.</T>
      <Btn title="Plan the knockout" onPress={() => go('schedule')} style={{ marginTop: 12 }} />
    </Card>
  );
}

// ---------------------------------------------------------------- crew
function Crew({ id, e, roles, staff, toast, reload }) {
  const [open, setOpen] = useState(false), [find, setFind] = useState(null), [q, setQ] = useState('');
  const act = useDo(toast, reload);
  const cands = useLoad(() => (find ? api.get(`/events/${id}/staff-candidates`, { role: find.role, q: q || undefined, limit: 30 }) : Promise.resolve([])), [find?.id, q]);
  const filled = roles.reduce((n, r) => n + r.filled, 0), needed = roles.reduce((n, r) => n + r.needed, 0);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <StatTile icon="✅" label="Confirmed" value={filled} tone={c.limeSoft} /><StatTile icon="📌" label="Places open" value={Math.max(needed - filled, 0)} /><StatTile icon="⏳" label="Waiting reply" value={roles.reduce((n, r) => n + r.pending, 0)} tone={c.sunSoft} />
      </View>
      <Btn title="Open a position" onPress={() => setOpen(true)} />
      {roles.length ? roles.map((r) => (
        <Card key={r.id} pad={14}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}><T size={22}>{ROLE_ICON[r.role]}</T></View>
            <View style={{ flex: 1 }}>
              <T weight="800" size={15}>{r.title || ROLES.find(([k]) => k === r.role)?.[1]}{r.closed_at ? ' · closed' : ''}</T>
              <T size={12} color={c.mute}>{r.filled}/{r.needed} confirmed{r.pending ? ` · ${r.pending} waiting` : ''} · {r.fee_cents ? `${moneyIn(r.fee_cents, r.currency)} each` : 'unpaid'}</T>
            </View>
          </View>
          <View style={{ marginTop: 10 }}><Bar pct={(r.filled / r.needed) * 100} color={r.filled >= r.needed ? c.lime : c.pink} /></View>
          {!r.closed_at ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}><Btn small title="Find people" onPress={() => { setFind(r); setQ(''); }} /><Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/staff-roles/${r.id}/close`), 'Closed')} /></View> : null}
        </Card>
      )) : <Empty emoji="🩺" title="No positions yet" sub="Referees, scorers, doctors, physios, volunteers and security." />}
      <SectionTitle title="Team sheet" />
      {staff.length ? staff.map((a) => (
        <Row key={a.id} left={<T size={24}>{ROLE_ICON[a.role]}</T>} title={a.display_name} sub={`${a.title || a.role}${a.fee_cents ? ` · ${moneyIn(a.fee_cents, e.currency)}` : ''}`}
          right={<><View style={{ backgroundColor: STATUS_COLOR[a.status], borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}><T size={11} weight="800">{a.status}</T></View>{['invited', 'accepted'].includes(a.status) ? <Btn small title="Release" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/staff-assignments/${a.id}/end`, {}), 'Released')} /> : null}</>} />
      )) : <T color={c.mute}>Nobody invited yet.</T>}

      {find ? (
        <Sheet visible onClose={() => setFind(null)} title={`Find a ${find.title || find.role}`}>
          <Field value={q} onChangeText={setQ} placeholder="Search by name…" />
          <T size={12} color={c.mute}>Only people with the right profile who are free on the event dates.</T>
          {cands.loading ? <Loading /> : (cands.data ?? []).length ? cands.data.map((p) => (
            <Row key={p.user_id} title={p.display_name} sub={[p.clinic, p.city, p.level, `@${p.handle}`].filter(Boolean).join(' · ')} right={<Btn small title="Invite" onPress={() => act(async () => { await api.post(`/staff-roles/${find.id}/invite`, { user_id: p.user_id }); setFind(null); }, 'Offer sent')} />} />
          )) : <Empty emoji="🔎" title="Nobody available" sub="Nobody with the right profile is free on these dates." />}
        </Sheet>
      ) : null}
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Open a position" submitLabel="Open position" initial={{ role: 'referee', needed: 1 }}
        fields={[{ key: 'role', label: 'Role', type: 'chips', options: ROLES.map(([value, label]) => ({ value, label: `${ROLE_ICON[value]} ${label}` })) }, { key: 'needed', label: 'How many people', type: 'stepper', min: 1, max: 100, default: 1 }, { key: 'fee', label: 'Fee per person', type: 'money', currency: e.currency, optional: true }, { key: 'notes', label: 'Notes for applicants', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/staff-roles`, { role: v.role, needed: v.needed || 1, fee_cents: v.fee || 0, notes: v.notes || undefined }); reload(); return 'Position opened'; }} />
    </>
  );
}

// ---------------------------------------------------------------- business: vendors, sponsors, retail
const KINDS = [['sponsor', '💎', 'Sponsor'], ['retail', '🛍️', 'Retail stall'], ['catering', '🍽️', 'Catering'], ['other', '🔧', 'Other']];
function Business({ id, e, vend, money, toast, reload }) {
  const [invite, setInvite] = useState(false);
  const prods = useLoad(() => api.get(`/events/${id}/products`), [id]);
  const act = useDo(toast, () => { reload(); prods.reload(); });
  return (
    <>
      {money ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <StatTile icon="🎟️" label="Entry fees" value={moneyIn(money.entry_fees_cents, money.currency)} /><StatTile icon="💎" label="Sponsors" value={moneyIn(money.sponsors.cents, money.currency)} tone={c.limeSoft} />
          <StatTile icon="🛍️" label="Vendor fees" value={moneyIn(money.vendors.pitch_fees_cents, money.currency)} /><StatTile icon="📤" label="Crew cost" value={moneyIn(money.staff.cost_cents, money.currency)} tone={c.sunSoft} /><StatTile icon="📊" label="Net" value={moneyIn(money.net_cents, money.currency)} />
        </View>
      ) : null}
      <Btn title="Invite a sponsor or vendor" onPress={() => setInvite(true)} />
      {vend.length ? vend.map((v) => (
        <Row key={v.id} left={<T size={26}>{KINDS.find(([k]) => k === v.kind)?.[1]}</T>} title={v.sponsor_name ?? v.vendor_name} sub={`${v.kind}${v.fee_cents ? ` · ${moneyIn(v.fee_cents, v.currency)}` : ''}${v.in_kind ? ` · ${v.in_kind}` : ''}`}
          right={<><View style={{ backgroundColor: STATUS_COLOR[v.status] ?? c.violetSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}><T size={11} weight="800">{v.status}</T></View>{v.status === 'accepted' ? <Btn small title="End" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/event-vendors/${v.id}/end`), 'Ended')} /> : null}</>} />
      )) : <Empty emoji="💼" title="No sponsors or vendors yet" sub="Invite a brand to sponsor, or shops and caterers to run stalls." />}
      <SectionTitle title="On sale at the event" />
      {prods.data?.length ? prods.data.map((p) => <Row key={p.id} left={<T size={24}>{p.emoji}</T>} title={p.name} sub={`${moneyIn(p.price_cents, e.currency)} · ${p.seller_name}`} />) : <T color={c.mute}>Confirmed retail vendors list their shop products here.</T>}
      {invite ? <InviteSheet id={id} e={e} onClose={() => setInvite(false)} onSent={reload} /> : null}
    </>
  );
}

function InviteSheet({ id, e, onClose, onSent }) {
  const [kind, setKind] = useState(null), [q, setQ] = useState(''), [target, setTarget] = useState(null);
  const pk = kind === 'sponsor' ? 'sponsor' : 'supplier';
  const found = useLoad(() => (kind && !target ? api.get(`/events/${id}/partners`, { kind: pk, q: q || undefined, limit: 30 }) : Promise.resolve([])), [kind, q, target]);
  return (
    <Sheet visible onClose={onClose} title={target ? `Invite ${target.name}` : 'Invite a sponsor or vendor'}>
      {!kind ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{KINDS.map(([k, icon, label]) => <Chip key={k} label={`${icon} ${label}`} onPress={() => setKind(k)} />)}</View>
        : !target ? (
          <>
            <Chip label={`${KINDS.find(([k]) => k === kind)[1]} ${KINDS.find(([k]) => k === kind)[2]}  ✕`} active onPress={() => setKind(null)} />
            <Field value={q} onChangeText={setQ} placeholder={kind === 'sponsor' ? 'Search sponsor brands…' : 'Search suppliers and shops…'} />
            {found.loading ? <Loading /> : (found.data ?? []).length ? found.data.map((x) => <Row key={x.id} left={<T size={24}>{x.emoji ?? '🏷️'}</T>} title={x.name} sub={x.city ?? ''} onPress={() => setTarget(x)} />) : <Empty emoji="🔎" title="No match" sub="Try another search." />}
          </>
        ) : (
          <FormSheet inline visible onClose={onClose} title="" onBack={() => setTarget(null)} submitLabel="Send invitation"
            fields={[{ key: 'fee', label: kind === 'sponsor' ? 'Sponsorship amount' : 'Stall / pitch fee', type: 'money', currency: e.currency, optional: true }, ...(kind === 'sponsor' ? [{ key: 'in_kind', label: 'In-kind support (kit, drinks, prizes…)', optional: true }] : []), { key: 'notes', label: 'Message', type: 'multiline', optional: true }]}
            onSubmit={async (v) => { await api.post(`/events/${id}/vendors`, { kind, ...(kind === 'sponsor' ? { sponsor_id: target.id } : { vendor_user_id: target.id }), fee_cents: v.fee || 0, in_kind: v.in_kind || undefined, notes: v.notes || undefined }); onSent(); onClose(); return 'Invitation sent'; }} />
        )}
    </Sheet>
  );
}
