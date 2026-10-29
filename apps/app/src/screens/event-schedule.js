// Scheduling inside the event console's Games tab: plan a group stage or knockout into the booked courts (preview first), block days,
// add public holidays, and the game list by day. Results are NOT entered here: a game's result goes through the match centre and the
// score sheet, so there is one way to make a result official.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { A, ABtn, ACard, ACrest, AChip, AEmpty, ARow, ASection, AT, ATag, LiveBadge } from '../arena';
import { FormSheet } from '../FormSheet';
import { todayLocal } from '../pickers';
import { locale } from '../locale';
import { useDo } from './console-utils';
import { SeedSheet } from '../bracket-studio';

// Game times are venue-local (a 7 pm game in Mumbai is 7 pm for everyone), so every helper takes the venue's time zone.
export const dayLabel = (iso, tz) => new Date(iso).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz || undefined });
export const dayKey = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz || undefined }); // YYYY-MM-DD
const time = (iso, tz) => new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined });

/** One game as a card: crests, names, time or score, court and round. */
export function GameRow({ f, onPress }) {
  const done = f.status === 'completed';
  const win = (side) => done && (f.winner_team_id ? f.winner_team_id === f[`${side}_team_id`] : f[`${side}_score`] > f[`${side === 'home' ? 'away' : 'home'}_score`]);
  const team = (side) => (
    <View style={{ flex: 1, alignItems: 'center', gap: 6 }}>
      <ACrest emoji={f[`${side}_name`] ? f[`${side}_emoji`] : '❔'} color={f[`${side}_color`] ?? A.panel2} size={44} ring={win(side) ? A.green : undefined} />
      <AT size={12.5} weight={win(side) ? '900' : '700'} numberOfLines={2} color={f[`${side}_name`] ? A.ink : A.mute} style={{ textAlign: 'center' }}>{f[`${side}_name`] ?? f[`${side}_placeholder`] ?? 'To be decided'}</AT>
    </View>
  );
  return (
    <ACard pad={14} onPress={onPress} tone={f.status === 'live' ? A.red : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <AT size={11} weight="900" color={A.mute} style={{ letterSpacing: 0.8 }}>{(f.round ?? 'Game').toUpperCase()}</AT>
        <LiveBadge status={f.status} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {team('home')}
        <View style={{ width: 96, alignItems: 'center' }}>
          {done || ['live', 'paused', 'finished'].includes(f.status)
            ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AT size={26} weight="900" num>{f.home_score ?? 0}</AT><AT size={16} color={A.mute}>:</AT><AT size={26} weight="900" num>{f.away_score ?? 0}</AT></View>
            : <View style={{ alignItems: 'center' }}><AT size={20} weight="900">{time(f.scheduled_at, f.venue_timezone)}</AT><AT size={11} weight="800" color={A.mute}>VS</AT></View>}
        </View>
        {team('away')}
      </View>
      {f.resource_name ? <AT size={12} weight="600" color={A.mute} style={{ marginTop: 10 }}>📍 {f.resource_name}{f.duration_min ? ` · ${f.duration_min} min` : ''}</AT> : null}
    </ACard>
  );
}

/** Days with games as chips: tap one to see its games. */
export function DayChips({ days, value, onChange }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
      {days.map((d) => <AChip key={d.date} active={d.date === value} label={`${dayLabel(`${d.date}T12:00:00`)} · ${d.count}`} onPress={() => onChange(d.date)} />)}
    </ScrollView>
  );
}

/** Games grouped by day with a day picker. onOpen(game) opens the match centre. */
export function GamesByDay({ games, onOpen }) {
  const byDay = games.reduce((m, g) => { const k = dayKey(g.scheduled_at, g.venue_timezone); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const dates = Object.keys(byDay).sort();
  const [sel, setSel] = useState(null);
  const day = sel && byDay[sel] ? sel : (dates.find((d) => d >= new Date().toLocaleDateString('en-CA')) ?? dates[0]);
  const shown = games.filter((g) => !day || dayKey(g.scheduled_at, g.venue_timezone) === day).sort((a, b) => +new Date(a.scheduled_at) - +new Date(b.scheduled_at));
  if (!games.length) return <AEmpty emoji="🗓️" title="No games yet" sub="Plan a group stage or knockout below. Games are fitted into your booked courts with no clashes." />;
  return (
    <>
      <DayChips days={dates.map((d) => ({ date: d, count: byDay[d] }))} value={day} onChange={setSel} />
      {shown.length ? shown.map((g) => <GameRow key={g.id} f={g} onPress={() => onOpen(g)} />) : <AEmpty emoji="😴" title="No games this day" />}
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
      onSubmit={async (f) => { await api.post('/holidays', { country: country ?? f.country, region: f.local ? venue?.city : undefined, days: [{ on_date: f.on_date, label: f.label }] }); onSaved(); return 'Holiday saved. Scheduling will skip it'; }} />
  );
}

const FORMAT_LABEL = { round_robin: 'group stage', knockout: 'knockout', double_elimination: 'double elimination', swiss: 'Swiss rounds', pools: 'pools' };

/** Organiser tools: plan any stage (group, knockout, double elimination, Swiss, pools) with a preview, seeds & draw, block days, public holidays. */
export function SchedulePlanner({ id, accepted, venues, reload, goVenue }) {
  const [form, setForm] = useState(null), [preview, setPreview] = useState(null), [dayOff, setDayOff] = useState(false), [holiday, setHoliday] = useState(false), [seeds, setSeeds] = useState(false);
  const cal = useLoad(() => api.get(`/events/${id}/calendar`), [id]);
  const fmts = useLoad(() => api.get('/bracket-formats'), []);
  const refresh = () => { cal.reload(); reload(); };
  const act = useDo(refresh);
  const venue = venues.find((v) => v.chosen) ?? venues[0];
  const n = accepted.length;
  const policies = (fmts.data?.swiss.policies ?? []).map((p) => ({ value: p.id, label: p.label }));
  const templates = [{ value: 'none', label: 'None' }, ...(fmts.data?.repechage_templates ?? []).map((t) => ({ value: t.id, label: t.label }))];
  /** The API call for the chosen format; `over` carries a reordered field / a fresh random draw from the seeds sheet. */
  const args = (v, over = {}) => {
    const fc = {};
    if (form === 'knockout' || form === 'double_elimination') {
      if (v.series === 'best_of') fc.tie = { mode: 'best_of', best_of: v.best_of ?? 3, home_rotation: 'alternate', apply_to: v.finalSingle ? 'except_final' : 'all' };
      if (v.series === 'legs') fc.tie = { mode: 'legs', legs: v.legs ?? 2, away_goals: !!v.away_goals, apply_to: v.finalSingle ? 'except_final' : 'all' };
    }
    if (form === 'knockout') {
      if (v.placement && v.placement !== 'none') fc.placement_up_to = Number(v.placement);
      if (v.consolation) fc.consolation = true;
      if (v.repechage && v.repechage !== 'none') fc.repechage_template = v.repechage;
    }
    if (form === 'double_elimination' && v.reset) fc.reset = true;
    if (form === 'swiss') fc.swiss = { rounds: v.rounds, policy: v.policy, first_round: v.first_round, allow_rematch: !!v.allow_rematch };
    if (form === 'pools') fc.pools = { pool_count: v.pool_count, draw: v.pool_draw, advance_per_pool: v.advance, wildcards: v.wildcards || undefined, third_place: !!v.third_place };
    const ordered = over.order ?? v.order;
    return { format: form, from_date: v.window, to_date: v.windowTo ?? v.window, match_duration_min: v.duration, rest_min: v.rest, max_per_team_per_day: v.perDay, third_place: !!v.third_place && form === 'knockout', respect_holidays: v.holidays !== false,
      from: v.from ?? 'seeds', top_n: v.top || undefined, format_config: fc, publish: !v.draft, ...(ordered ? { team_ids: ordered } : {}), ...(over.draw ? { draw: over.draw } : {}) };
  };
  const planFields = [
    { key: 'window', toKey: 'windowTo', label: 'Play between', type: 'daterange', min: todayLocal(), hint: 'The scheduler fits games into your venue’s free court slots inside these days.' },
    { key: 'duration', label: 'Game length (minutes)', type: 'stepper', min: 10, max: 240, step: 5, default: 60 },
    { key: 'rest', label: 'Rest between a team’s games (minutes)', type: 'stepper', min: 0, max: 600, step: 15, default: 60 },
    { key: 'perDay', label: 'Most games per team per day', type: 'stepper', min: 1, max: 6, default: 1 },
    { key: 'holidays', label: 'Skip public holidays', type: 'switch' },
  ];
  const series = [{ value: 'single', label: 'Single game' }, { value: 'best_of', label: 'Best of N' }, { value: 'legs', label: 'Two or more legs' }];
  const fields = [...planFields,
    ...(form === 'knockout' ? [
      { key: 'from', label: 'Who plays', type: 'choice', options: [{ value: 'seeds', label: 'By seed' }, { value: 'standings', label: 'Top of the table' }] },
      { key: 'top', label: 'Only the first N teams', type: 'stepper', min: 2, max: 32, optional: true },
      { key: 'third_place', label: 'Third-place game', type: 'switch' },
      { key: 'placement', label: 'Play-offs for other places', type: 'choice', options: [{ value: 'none', label: 'No' }, { value: '8', label: 'Up to 8th' }, { value: '16', label: 'Up to 16th' }] },
      { key: 'consolation', label: 'Second-chance bracket for first-round losers', type: 'switch' },
      { key: 'repechage', label: 'Repechage (generated once both finalists are known)', type: 'chips', options: templates }] : []),
    ...(form === 'double_elimination' ? [{ key: 'reset', label: 'Grand-final reset game (only played if the losers-bracket champion wins the first final)', type: 'switch' }] : []),
    ...(form === 'knockout' || form === 'double_elimination' ? [
      { key: 'series', label: 'Each tie is', type: 'choice', options: series },
      { key: 'best_of', label: 'Best of', type: 'stepper', min: 3, max: 9, step: 2, default: 3, show: (v) => v.series === 'best_of' },
      { key: 'legs', label: 'Legs', type: 'stepper', min: 2, max: 4, default: 2, show: (v) => v.series === 'legs' },
      { key: 'away_goals', label: 'Away goals break a level aggregate (off unless your competition rules say so)', type: 'switch', show: (v) => v.series === 'legs' },
      { key: 'finalSingle', label: 'The final is a single game', type: 'switch', show: (v) => v.series && v.series !== 'single' }] : []),
    ...(form === 'swiss' ? [
      { key: 'rounds', label: 'Rounds', type: 'stepper', min: 1, max: 15, default: Math.max(1, Math.ceil(Math.log2(Math.max(2, n)))), hint: 'Only the first round is paired now; each later round is paired from the results.' },
      { key: 'policy', label: 'Pairing policy', type: 'chips', options: policies },
      { key: 'first_round', label: 'First round', type: 'choice', options: [{ value: 'seeded', label: 'By seed' }, { value: 'random', label: 'Random draw' }] },
      { key: 'allow_rematch', label: 'Allow a rematch if there is no other pairing', type: 'switch' }] : []),
    ...(form === 'pools' ? [
      { key: 'pool_count', label: 'Pools', type: 'stepper', min: 2, max: 16, default: 2 },
      { key: 'pool_draw', label: 'Draw', type: 'choice', options: [{ value: 'snake', label: 'Snake by seed' }, { value: 'pots', label: 'Pots (random within)' }] },
      { key: 'advance', label: 'Teams going through from each pool', type: 'stepper', min: 1, max: 8, default: 2 },
      { key: 'wildcards', label: 'Best next-placed teams who also go through', type: 'stepper', min: 0, max: 8, default: 0 },
      { key: 'third_place', label: 'Third-place game in the knockout', type: 'switch' }] : []),
    { key: 'draft', label: 'Keep as a draft until I publish it', type: 'switch', hint: 'Spectators see nothing until you publish. Seeds and the draw stay editable.' },
  ];
  const initial = { duration: 60, rest: 60, perDay: 1, holidays: true, from: 'seeds', draft: true, series: 'single', placement: 'none', repechage: 'none', policy: 'score_group_dutch', first_round: 'seeded', pool_draw: 'snake', best_of: 3, legs: 2, advance: 2, wildcards: 0, pool_count: 2 };
  const runPreview = async (a) => { const p = await api.post(`/events/${id}/schedule/preview`, a); setPreview({ ...p, args: a }); return p; };
  return (
    <>
      <ASection title="Plan the schedule" sub="Fitted into your booked courts, clash-free" />
      {!venue ? (
        <ACard tone={A.sun}><AT weight="800">Book a venue first</AT><AT size={13} color={A.mute} style={{ marginTop: 2 }}>Games are placed on the courts you book.</AT><ABtn small title="Open the Venue tab" onPress={goVenue} style={{ marginTop: 10, alignSelf: 'flex-start' }} /></ACard>
      ) : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AT size={20}>{venue.emoji ?? '🏟️'}</AT><AT weight="800" style={{ flex: 1 }}>{venue.name}</AT><ATag tone={A.cyan} label={`${venue.summary.courts} courts`} /></View>}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <ABtn small title="Group stage" onPress={() => setForm('round_robin')} disabled={n < 2} />
        <ABtn small tone="neon" title="Knockout" onPress={() => setForm('knockout')} disabled={n < 2} />
        <ABtn small tone="neon" title="Double elimination" onPress={() => setForm('double_elimination')} disabled={n < 3} />
        <ABtn small tone="neon" title="Swiss" onPress={() => setForm('swiss')} disabled={n < 4} />
        <ABtn small tone="neon" title="Pools → knockout" onPress={() => setForm('pools')} disabled={n < 4} />
        <ABtn small tone="ghost" title="Block a day" onPress={() => setDayOff(true)} />
        <ABtn small tone="ghost" title="Public holiday" onPress={() => setHoliday(true)} />
      </View>
      {n < 2 ? <AT size={12} color={A.mute}>Accept at least two teams to plan games.</AT> : null}

      {preview ? (
        <ACard tone={A.green} style={{ gap: 8 }}>
          <AT size={16} weight="900">Preview · {preview.items.length - preview.unplaced.length} of {preview.items.length} games fit at {preview.venue.name}</AT>
          <AT size={12} color={A.mute}>{FORMAT_LABEL[preview.format]} · {preview.algorithm}{preview.draw_seed ? ` · draw seed ${preview.draw_seed}` : ''}</AT>
          {preview.warnings?.map((w, i) => <AT key={i} size={12.5} color={A.sun}>⚠️ {w}</AT>)}
          {Object.keys(preview.skipped_dates).length ? <AT size={12} color={A.mute}>Skipped: {Object.entries(preview.skipped_dates).map(([d, why]) => `${dayLabel(`${d}T12:00:00`)} (${why})`).join(', ')}</AT> : null}
          {preview.items.slice(0, 30).map((it) => (
            <View key={it.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: A.panel2, borderRadius: 14, padding: 10 }}>
              <View style={{ flex: 1 }}>
                <AT size={13.5} weight="800">{it.home_emoji ?? ''} {it.home_name ?? it.home_placeholder ?? '—'}  vs  {it.away_emoji ?? ''} {it.away_name ?? it.away_placeholder ?? '—'}</AT>
                <AT size={12} color={A.mute}>{it.scheduled_at ? `${dayLabel(it.scheduled_at, preview.venue.timezone)} · ${time(it.scheduled_at, preview.venue.timezone)}` : 'Not placed'}{it.resource_name ? ` · ${it.resource_name}` : ''}{it.round ? ` · ${it.round}` : ''}</AT>
                {it.reason ? <AT size={11.5} color={A.mute}>{it.reason}</AT> : null}
              </View>
            </View>
          ))}
          {preview.items.length > 30 ? <AT size={12} color={A.mute}>…and {preview.items.length - 30} more games</AT> : null}
          {preview.bye ? <AT size={12.5} color={A.mute}>Bye this round: {accepted.find((a) => a.team_id === preview.bye.team)?.name} ({preview.bye.reason})</AT> : null}
          {preview.unplaced.length ? <AT color={A.red} weight="800">{preview.unplaced.length} game(s) do not fit. Widen the dates or book more courts. Nothing is created until every game has a slot.</AT> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <ABtn title={preview.args.publish ? 'Create and publish' : 'Create as draft'} tone="lime" disabled={!!preview.unplaced.length} onPress={() => act(async () => { await api.post(`/events/${id}/schedule`, { ...preview.args, draw: { mode: 'seeded', protect_top: 0, draw_seed: preview.draw_seed } , team_ids: preview.format === 'round_robin' ? undefined : preview.field }); setPreview(null); }, preview.args.publish ? 'Schedule created and published' : 'Draft created: review it, then publish')} />
            {preview.format !== 'round_robin' ? <ABtn title="Seeds & draw" tone="ghost" onPress={() => setSeeds(true)} /> : null}
            <ABtn title="Dismiss" tone="ghost" onPress={() => setPreview(null)} />
          </View>
        </ACard>
      ) : null}

      <ASection title="Days off" sub="Public holidays of the venue’s country and city are skipped automatically" />
      {cal.data?.length ? cal.data.map((d) => <ARow key={d.id} title={`${dayLabel(`${String(d.on_date).slice(0, 10)}T12:00:00`)} · ${d.kind.replace('_', ' ')}`} sub={d.label ?? ''} right={<ABtn small tone="ghost" title="Lift" onPress={() => act(() => api.del(`/events/${id}/calendar/${d.id}`), 'Lifted')} />} />) : <AT size={13} color={A.mute}>No blocked days.</AT>}

      <FormSheet visible={!!form} onClose={() => setForm(null)} title={`Plan the ${FORMAT_LABEL[form] ?? ''}`} submitLabel="Preview games" initial={initial} fields={fields}
        onSubmit={async (v) => {
          if (!v.window) throw new Error('Pick the days to play between');
          if (v.series === 'best_of' && (v.best_of ?? 3) % 2 === 0) throw new Error('A series needs an odd number of games');
          await runPreview(args(v));
          return 'Preview ready';
        }} />
      <SeedSheet visible={seeds} onClose={() => setSeeds(false)} eventId={id} format={preview?.format} teams={accepted.map((a) => ({ team_id: a.team_id, name: a.name, city: a.city }))} start={preview?.field} poolCount={preview?.config?.pools?.pool_count}
        title="Seeds & draw" confirmLabel="Preview with this order"
        onApply={async (body) => {
          const base = { ...preview.args };
          const next = body.mode === 'random' ? { ...base, team_ids: preview.field, draw: { mode: 'random', protect_top: body.protect_top } } : { ...base, team_ids: body.order, draw: { mode: 'seeded', protect_top: 0 } };
          await runPreview(next); setSeeds(false);
        }} />
      <FormSheet visible={dayOff} onClose={() => setDayOff(false)} title="Block a day" submitLabel="Block" initial={{ kind: 'blackout' }}
        fields={[{ key: 'on_date', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type', type: 'choice', options: [{ value: 'blackout', label: 'Blackout' }, { value: 'rest_day', label: 'Rest day' }, { value: 'holiday', label: 'Holiday' }] }, { key: 'label', label: 'Note', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/calendar`, { days: [{ on_date: v.on_date, kind: v.kind, label: v.label || undefined }] }); refresh(); return 'Day blocked'; }} />
      <HolidaySheet visible={holiday} onClose={() => setHoliday(false)} venue={venue} onSaved={refresh} />
    </>
  );
}
