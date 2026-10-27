import React, { useEffect, useMemo, useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Field, Row, Seg, Sheet, T } from '../ui';
import { SportSelect } from '../sportpicker';
import { DateTimeField, Counter } from '../pickers';
import { EntityPicker } from '../entity-picker';
import { RegionPicker } from '../region-picker';
import { CurrencyDropdown } from '../currency-dropdown';
import { currentPosition } from '../location';
import { c, when } from '../theme';

const LEVELS = [['beginner', 'Beginner'], ['amateur', 'Amateur'], ['semi_pro', 'Semi-pro'], ['pro', 'Pro']];
const FORMATS = ['Casual game', 'Practice', 'Match', 'Training drill'];
const DURATIONS = [[45, '45 min'], [60, '1 h'], [90, '1½ h'], [120, '2 h'], [180, '3 h']];
const CANCEL = [[0, 'Any time'], [2, '2 h before'], [6, '6 h before'], [12, '12 h before'], [24, '1 day before'], [48, '2 days before']];
const digits = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };

const Label = ({ children, hint }) => (
  <View style={{ gap: 2 }}><T weight="800" size={13}>{children}</T>{hint ? <T size={12} color={c.mute}>{hint}</T> : null}</View>
);
const Group = ({ label, hint, children }) => <View style={{ gap: 8 }}><Label hint={hint}>{label}</Label>{children}</View>;
const Wrap = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{children}</View>;

/**
 * Host a game (or edit one you host). The venue list only shows places that have a court for the sport and a free slot at that time;
 * picking one does not reserve it — the booking is made (or linked) through the normal booking flow afterwards.
 */
export function HostGameSheet({ game, onClose, onDone }) {
  const edit = !!game;
  const [sport, setSport] = useState(game?.sport_slug ?? '');
  const [startsAt, setStartsAt] = useState(game?.starts_at ? new Date(game.starts_at).toISOString() : undefined);
  const [duration, setDuration] = useState(game?.ends_at ? Math.round((new Date(game.ends_at) - new Date(game.starts_at)) / 6e4) : 90);
  const [placeKind, setPlaceKind] = useState(game && !game.venue_id ? 'place' : 'venue');
  const [venue, setVenue] = useState(game?.venue_id ? { id: game.venue_id, label: game.place.name, currency: game.cost.currency } : null);
  const [court, setCourt] = useState(game?.resource_id ?? null);
  const [location, setLocation] = useState(game && !game.venue_id ? game.place.name ?? '' : '');
  const [city, setCity] = useState(game?.place_city ?? '');
  const [booking, setBooking] = useState(game?.booking_id ?? null);
  const [maxPlayers, setMax] = useState(game?.max_players ?? 10);
  const [minPlayers, setMin] = useState(game?.min_players ?? 4);
  const [hostPlays, setHostPlays] = useState(true);
  const [skillMin, setSkillMin] = useState(game?.skill_min ?? null);
  const [skillMax, setSkillMax] = useState(game?.skill_max ?? null);
  const [format, setFormat] = useState(game?.format ?? null);
  const [roles, setRoles] = useState((game?.role_needs ?? []).join(', '));
  const [audience, setAudience] = useState(game?.audience ?? 'adults');
  const [ageLimited, setAgeLimited] = useState(game?.min_age != null || game?.max_age != null);
  const [minAge, setMinAge] = useState(game?.min_age ?? 8);
  const [maxAge, setMaxAge] = useState(game?.max_age ?? 14);
  const [costMode, setCostMode] = useState(game?.cost.mode ?? 'free');
  const [amount, setAmount] = useState(game ? String(game.cost.total_cents / 10 ** digits(game.cost.currency)) : '');
  const [currency, setCurrency] = useState(game?.cost.currency);
  const [approval, setApproval] = useState(game?.approval_mode ?? 'host');
  const [visibility, setVisibility] = useState(game?.visibility ?? 'public');
  const [team, setTeam] = useState(game?.team_id ? [{ id: game.team_id, label: game.team_name ?? 'Team' }] : []);
  const [forTeam, setForTeam] = useState(!!game?.team_id);
  const [cancelHours, setCancelHours] = useState(game?.cancel_before_hours ?? 6);
  const [notes, setNotes] = useState(game?.notes ?? '');
  const [pos, setPos] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const endsAt = startsAt ? new Date(+new Date(startsAt) + duration * 6e4).toISOString() : null;
  const today = new Date().toISOString().slice(0, 10);
  useEffect(() => { currentPosition().then(setPos); }, []);

  // real venues with a court for this sport and room at this time
  const venues = useLoad(() => (placeKind === 'venue' && sport && startsAt && !edit ? api.get('/venues', { sport, available_from: startsAt, available_to: endsAt, limit: 8, ...(pos ? { lat: pos.lat, lng: pos.lng, sort: 'distance' } : { sort: 'rating' }) }) : Promise.resolve([])), [placeKind, sport, startsAt, duration, pos?.lat]);
  const detail = useLoad(() => (venue?.id ? api.get(`/venues/${venue.id}`) : Promise.resolve(null)), [venue?.id]);
  const courts = (detail.data?.resources ?? []).filter((r) => r.kind !== 'equipment' && (!r.sport_slug || r.sport_slug === sport));
  // bookings I already hold that cover this game
  const mine = useLoad(() => (startsAt ? api.get('/reservations', { upcoming: true, limit: 50 }) : Promise.resolve([])), [startsAt, duration]);
  const covering = useMemo(() => (mine.data ?? []).flatMap((r) => r.bookings.map((b) => ({ ...b, code: r.code }))).filter((b) => b.status === 'confirmed' && startsAt && new Date(b.starts_at) <= new Date(startsAt) && new Date(b.ends_at) >= new Date(endsAt)), [mine.data, startsAt, duration]);
  const teams = useLoad(() => api.get('/teams', { mine: true, limit: 50 }), []);
  const teamOpts = (teams.data ?? []).map((t) => ({ id: t.id, label: t.name, sub: t.sport ?? '', emoji: t.emoji }));

  const level = (setter, cur) => (k) => setter(cur === k ? null : k);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (!sport && !edit) throw new Error('Pick the sport');
      if (!startsAt) throw new Error('Pick the date and time');
      if (placeKind === 'venue' && !venue && !booking) throw new Error('Pick a venue, or switch to a public place');
      if (placeKind === 'place' && !location.trim()) throw new Error('Name the public place');
      if (costMode !== 'free' && !(Number(amount.replace(/,/g, '')) > 0)) throw new Error('Enter the amount');
      if (visibility === 'team' && !team.length) throw new Error('Pick the team that can see this game');
      const cur = currency ?? venue?.currency;
      const body = {
        starts_at: startsAt, duration_minutes: duration, max_players: maxPlayers, min_players: Math.min(minPlayers, maxPlayers),
        skill_min: skillMin, skill_max: skillMax, format, role_needs: roles.split(',').map((x) => x.trim()).filter(Boolean),
        audience, min_age: audience !== 'adults' && ageLimited ? minAge : null, max_age: audience !== 'adults' && ageLimited ? Math.max(maxAge, minAge) : null,
        cost_mode: costMode, cost_cents: costMode === 'free' ? 0 : Math.round(Number(amount.replace(/,/g, '')) * 10 ** digits(cur)), ...(costMode !== 'free' && cur ? { currency: cur } : {}),
        approval_mode: approval, visibility, cancel_before_hours: cancelHours, notes: notes.trim() || null,
        ...(placeKind === 'venue' ? { venue_id: venue?.id, resource_id: court ?? undefined, booking_id: booking ?? undefined } : { location: location.trim(), place_city: city || undefined }),
      };
      if (edit) {
        if (placeKind === 'venue' && !booking) body.booking_id = null;
        const g = await api.patch(`/open-games/${game.id}`, body);
        onDone(g);
      } else {
        const g = await api.post('/open-games', { sport, ...body, host_plays: hostPlays, team_id: team[0]?.id });
        onDone(g);
      }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Sheet visible onClose={onClose} title={edit ? 'Change your game' : 'Host a game'}
      footer={<><Btn title="Cancel" color={c.paper} ink={c.ink} onPress={onClose} style={{ flex: 1 }} /><Btn title={edit ? 'Save changes' : 'Create game'} onPress={submit} loading={busy} style={{ flex: 2 }} /></>}>
      <T size={13} color={c.mute}>Creating a game does not book the court. You book the slot (or link a booking you already have) and the game shows the live booking state.</T>
      {!edit ? <SportSelect label="Sport" value={sport} onChange={setSport} /> : null}
      <View style={{ gap: 6 }}>
        <DateTimeField label="Date" value={startsAt} onChange={setStartsAt} min={today} step={15} />
        <Wrap>{DURATIONS.map(([m, l]) => <Chip key={m} label={l} active={duration === m} onPress={() => setDuration(m)} />)}</Wrap>
      </View>

      <Group label="Where" hint={placeKind === 'venue' ? 'Venues with a court for this sport and a free slot at that time.' : 'A park or ground. Never a home address.'}>
        <Seg options={[{ value: 'venue', label: 'At a venue' }, { value: 'place', label: 'Public place' }]} value={placeKind} onChange={setPlaceKind} />
        {placeKind === 'venue' ? (
          <View style={{ gap: 8 }}>
            {venue ? <Wrap><Chip active label={`🏟 ${venue.label}  ✕`} onPress={() => { setVenue(null); setCourt(null); setBooking(null); }} /></Wrap> : null}
            {!venue && !edit ? (!sport || !startsAt ? <T size={13} color={c.mute}>Pick the sport and time to see venues that are free.</T> : venues.loading && !venues.data ? <T size={13} color={c.mute}>Looking for free courts…</T> : !(venues.data ?? []).length ? <T size={13} color={c.mute}>No venue has a free court for this sport then. Try another time, or use a public place.</T> : (venues.data ?? []).map((v) => (
              <Row key={v.id} title={v.name} sub={[v.city, v.distance_km != null ? `${Math.round(v.distance_km)} km` : null, v.min_hourly_rate_cents != null ? `from ${(v.min_hourly_rate_cents / 100).toFixed(0)} ${v.currency}/h` : null].filter(Boolean).join(' · ')} onPress={() => { setVenue({ id: v.id, label: v.name, currency: v.currency }); setCurrency((x) => x ?? v.currency); }} />
            ))) : null}
            {venue && courts.length ? <Group label="Court"><Wrap>{courts.map((r) => <Chip key={r.id} label={r.name} active={court === r.id} onPress={() => setCourt(court === r.id ? null : r.id)} />)}</Wrap></Group> : null}
            {covering.length ? (
              <Group label="Use a booking I already have" hint="Links the game to your confirmed slot.">
                <Wrap>{covering.map((b) => <Chip key={b.id} label={`${b.venue_name} · ${b.resource_name} · ${when(b.starts_at)}`} active={booking === b.id} onPress={() => { if (booking === b.id) setBooking(null); else { setBooking(b.id); setVenue({ id: b.venue_id, label: b.venue_name, currency: b.currency }); setCourt(b.resource_id); } }} />)}</Wrap>
              </Group>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Field label="Place name" value={location} onChangeText={setLocation} placeholder="Riverside ground, north gate" maxLength={120} />
            <RegionPicker label="City or area" optional value={city} onChange={setCity} />
          </View>
        )}
      </Group>

      <Group label="Players" hint="Seats include you if you are playing.">
        <Counter label="Seats in total" value={maxPlayers} onChange={(n) => { setMax(n); if (minPlayers > n) setMin(n); }} min={2} max={60} />
        <Counter label="Needed to go ahead" value={Math.min(minPlayers, maxPlayers)} onChange={setMin} min={1} max={maxPlayers} />
        {!edit ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><T weight="600" style={{ flex: 1 }}>I am playing too</T><Switch accessibilityLabel="I am playing too" value={hostPlays} onValueChange={setHostPlays} trackColor={{ true: c.pink }} /></View> : null}
      </Group>

      <Group label="Level" hint="From and to. Leave both empty for everyone.">
        <T size={12} weight="700" color={c.mute}>FROM</T><Wrap>{LEVELS.map(([k, l]) => <Chip key={k} label={l} active={skillMin === k} onPress={() => level(setSkillMin, skillMin)(k)} />)}</Wrap>
        <T size={12} weight="700" color={c.mute}>TO</T><Wrap>{LEVELS.map(([k, l]) => <Chip key={k} label={l} active={skillMax === k} onPress={() => level(setSkillMax, skillMax)(k)} />)}</Wrap>
      </Group>
      <Group label="Format"><Wrap>{FORMATS.map((f) => <Chip key={f} label={f} active={format === f} onPress={() => setFormat(format === f ? null : f)} />)}</Wrap></Group>
      <Field label="Roles you need (optional, separate with commas)" value={roles} onChangeText={setRoles} placeholder="Goalkeeper, Defender" />

      <Group label="Who can play" hint="Young players can only join with a guardian's approval, and are never named publicly.">
        <Seg options={[{ value: 'adults', label: 'Adults' }, { value: 'all_ages', label: 'All ages' }, { value: 'youth', label: 'Young players' }]} value={audience} onChange={setAudience} />
        {audience !== 'adults' ? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><T weight="600" style={{ flex: 1 }}>Limit by age</T><Switch accessibilityLabel="Limit by age" value={ageLimited} onValueChange={setAgeLimited} trackColor={{ true: c.pink }} /></View>
            {ageLimited ? <><Counter label="Youngest age" value={minAge} onChange={setMinAge} min={3} max={99} /><Counter label="Oldest age" value={Math.max(maxAge, minAge)} onChange={setMaxAge} min={minAge} max={99} /></> : null}
          </View>
        ) : null}
      </Group>

      <Group label="Cost" hint="Shown to everyone before they join. Players pay you or the venue directly; you mark who has paid.">
        <Seg options={[{ value: 'free', label: 'Free' }, { value: 'per_player', label: 'Each pays' }, { value: 'split_total', label: 'Split the court' }]} value={costMode} onChange={setCostMode} />
        {costMode !== 'free' ? (
          <View style={{ gap: 8 }}>
            <CurrencyDropdown value={currency ?? venue?.currency} onChange={setCurrency} />
            <Field label={costMode === 'per_player' ? 'Amount each player pays' : 'Total cost to split between all seats'} value={amount} onChangeText={(x) => setAmount(x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder="0" />
          </View>
        ) : null}
      </Group>

      <Group label="Joining">
        <Seg options={[{ value: 'host', label: 'I approve each person' }, { value: 'auto', label: 'Auto-approve players who fit' }]} value={approval} onChange={setApproval} />
        <T size={12} color={c.mute}>{approval === 'auto' ? 'People inside your level range take a seat straight away; anyone outside it waits for you.' : 'Everyone waits for your OK. When the game is full they join the waitlist.'}</T>
      </Group>
      <Group label="Who can see it">
        <Wrap>{[['public', 'Everyone'], ['team', 'My team only'], ['link', 'Only with the link']].map(([k, l]) => <Chip key={k} label={l} active={visibility === k} onPress={() => setVisibility(k)} />)}</Wrap>
        {visibility === 'team' || forTeam ? <EntityPicker kind="team" noun="team" label="Team" optional={visibility !== 'team'} options={teamOpts} value={team} onChange={setTeam} /> : <Chip label="+ Hosting for a team" onPress={() => setForTeam(true)} />}
      </Group>
      <Group label="Leaving late" hint="A seat given up after this is recorded as a late cancellation. It can be appealed.">
        <Wrap>{CANCEL.map(([h, l]) => <Chip key={h} label={l} active={cancelHours === h} onPress={() => setCancelHours(h)} />)}</Wrap>
      </Group>
      <Field label="Notes for players (optional)" value={notes} onChangeText={setNotes} multiline maxLength={500} placeholder="Bring a light and a dark shirt." />
      {err ? <T color={c.red} weight="800">{err}</T> : null}
    </Sheet>
  );
}
