// Create an event in four short steps: what (name, type), which sports (one or many), when (a calendar range) and where
// (venues that really have courts for those sports, one booking request per venue), then the details. A single sport
// makes a normal event; several make a multi-sport programme with one discipline per sport.
import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Field, Loading, Sheet, T } from '../ui';
import { Counter, DateField, DateRangeField, todayLocal } from '../pickers';
import { SportsMulti, useSports } from '../sportpicker';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const KINDS = ['tournament', 'league', 'friendly', 'camp', 'trial'];
const STEPS = ['Basics', 'Sports', 'When & where', 'Details'];

export function CreateEvent({ visible, onClose, onCreated }) {
  const { toast } = useSession();
  const sports = useSports();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: '', kind: 'tournament', description: '', sports: [], from: undefined, to: undefined, city: '', picks: {}, capacity: 0, fee: '', deadline: undefined, sponsors: false });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const multi = f.sports.length > 1;
  const slugs = f.sports.join(',');
  const finder = useLoad(() => (visible && step === 2 && f.sports.length ? api.get('/venue-finder', { sports: slugs, city: f.city.trim() || undefined }) : Promise.resolve([])), [visible, step, slugs, f.city]);
  const by = new Map((sports.data ?? []).map((x) => [x.slug, x]));

  const can = [() => f.name.trim().length >= 2, () => f.sports.length >= 1, () => !!f.from, () => true][step]();
  const togglePick = (slug, venueId) => setF((p) => { const cur = p.picks[slug] ?? []; return { ...p, picks: { ...p.picks, [slug]: cur.includes(venueId) ? cur.filter((x) => x !== venueId) : [...cur, venueId] } }; });
  const venueRequests = () => {
    const m = new Map();
    for (const [slug, ids] of Object.entries(f.picks)) for (const id of ids) { if (!f.sports.includes(slug)) continue; m.set(id, [...(m.get(id) ?? []), slug]); }
    return [...m].map(([venue_id, vs]) => ({ venue_id, sports: vs }));
  };
  const venueName = (id) => finder.data?.flatMap((s) => s.venues).find((v) => v.id === id)?.name ?? 'Venue';

  const create = async () => {
    setBusy(true);
    try {
      const fee = Number(String(f.fee).replace(/,/g, ''));
      const body = {
        name: f.name.trim(), kind: f.kind, sports: f.sports, starts_on: f.from, ends_on: f.to ?? f.from, ...(f.description.trim() ? { description: f.description.trim() } : {}), ...(f.city.trim() ? { city: f.city.trim() } : {}),
        ...(f.capacity ? { capacity: f.capacity } : {}), ...(fee > 0 ? { entry_fee_cents: Math.round(fee * 100) } : {}), ...(f.deadline ? { registration_deadline: new Date(`${f.deadline}T23:59:00`).toISOString() } : {}),
        seeking_sponsors: f.sponsors, venue_requests: venueRequests(),
      };
      const ev = await api.post('/events', body);
      const asked = ev.venue_requests?.length ?? 0;
      toast(`Event created${asked ? ` — ${asked} venue booking request${asked > 1 ? 's' : ''} sent` : ''}`);
      onClose();
      onCreated?.(ev);
    } catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Create an event">
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {STEPS.map((s, i) => <View key={s} style={{ flex: 1, gap: 4 }}><View style={{ height: 4, borderRadius: 2, backgroundColor: i <= step ? c.pink : c.line }} /><T size={11} weight={i === step ? '800' : '500'} color={i === step ? c.ink : c.mute}>{s}</T></View>)}
      </View>

      {step === 0 ? (
        <View style={{ gap: 12 }}>
          <Field label="Event name" value={f.name} onChangeText={(x) => set('name', x)} placeholder="e.g. Inter-school Sports Day" />
          <View style={{ gap: 6 }}><T weight="800" size={13}>Type</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{KINDS.map((k) => <Chip key={k} label={k} active={f.kind === k} onPress={() => set('kind', k)} />)}</View></View>
          <Field label="Description (optional)" value={f.description} onChangeText={(x) => set('description', x)} multiline />
        </View>
      ) : null}

      {step === 1 ? (
        <View style={{ gap: 10 }}>
          <SportsMulti label="Sports in this event" value={f.sports} onChange={(x) => set('sports', x)} />
          <T size={13} color={c.mute}>{!f.sports.length ? 'Pick one sport for a normal event, or several for an Olympics-style programme with houses, nominations and one timetable.' : multi ? `Multi-sport event: each of the ${f.sports.length} sports becomes a discipline you can schedule, staff and score.` : 'A single-sport event. Add another sport to turn it into a multi-sport programme.'}</T>
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ gap: 12 }}>
          <DateRangeField label="Event dates" from={f.from} to={f.to} min={todayLocal()} onChange={({ from, to }) => setF((p) => ({ ...p, from, to }))} hint="Tap the first and last day on the calendar." />
          <Field label="City (optional)" value={f.city} onChangeText={(x) => set('city', x)} placeholder="Narrows the venue suggestions" />
          <T weight="800" size={13}>Venues — we only suggest venues that have courts or grounds for each sport</T>
          {finder.loading ? <Loading /> : (finder.data ?? []).map((s) => (
            <View key={s.sport} style={{ gap: 6 }}>
              <T weight="800">{s.emoji} {s.name}</T>
              {s.venues.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {s.venues.map((v) => <Chip key={v.id} label={`${v.name}${v.city ? ` · ${v.city}` : ''} · ${v.spots} spot${v.spots > 1 ? 's' : ''}${v.from_rate_cents ? ` · from ${moneyIn(v.from_rate_cents)}/h` : ''}`} active={(f.picks[s.sport] ?? []).includes(v.id)} onPress={() => togglePick(s.sport, v.id)} />)}
                </View>
              ) : <T size={12} color={c.mute}>No listed venue has {s.name.toLowerCase()} facilities{f.city ? ` in ${f.city}` : ''}. You can add one later from the planning workspace.</T>}
            </View>
          ))}
          {venueRequests().length ? (
            <View style={{ gap: 4, borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 12, backgroundColor: c.paper }}>
              <T weight="800" size={13}>A booking request will go to:</T>
              {venueRequests().map((r) => <T key={r.venue_id} size={13}>• {venueName(r.venue_id)} — {r.sports.map((x) => by.get(x)?.name ?? x).join(', ')}</T>)}
              <T size={12} color={c.mute}>for {f.from ? `${f.from}${f.to && f.to !== f.from ? ` to ${f.to}` : ''}` : 'your dates'}. Each venue answers with a quote; you finalize from the planning workspace.</T>
            </View>
          ) : null}
        </View>
      ) : null}

      {step === 3 ? (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}><View style={{ flex: 1 }}><T weight="800" size={13}>Capacity (0 = no limit)</T></View><Counter value={f.capacity} onChange={(x) => set('capacity', x)} min={0} max={100000} step={10} /></View>
          <Field label="Entry fee per entrant (optional)" value={String(f.fee)} onChangeText={(x) => set('fee', x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder="0 = free" />
          <DateField label="Registration closes" value={f.deadline} onChange={(x) => set('deadline', x)} optional min={todayLocal()} max={f.from} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><T weight="800" size={13}>Looking for sponsors</T><T size={12} color={c.mute}>Shown on the event so sponsors can offer support.</T></View><Switch value={f.sponsors} onValueChange={(x) => set('sponsors', x)} trackColor={{ true: c.pink }} /></View>
          <View style={{ gap: 4, borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 12, backgroundColor: c.paper }}>
            <T weight="800">{f.name}</T>
            <T size={13} color={c.mute}>{f.kind} · {f.sports.map((x) => by.get(x)?.name ?? x).join(', ')}</T>
            <T size={13} color={c.mute}>{f.from}{f.to && f.to !== f.from ? ` → ${f.to}` : ''}{f.city ? ` · ${f.city}` : ''}</T>
            <T size={13} color={c.mute}>{venueRequests().length ? `${venueRequests().length} venue request(s)` : 'No venue requests yet'}</T>
          </View>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : null}
        {step < 3 ? <Btn title="Next" disabled={!can} onPress={() => setStep(step + 1)} style={{ flex: 2 }} /> : <Btn title="Create event" loading={busy} onPress={create} style={{ flex: 2 }} />}
      </View>
    </Sheet>
  );
}
