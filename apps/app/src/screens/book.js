import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Bubble, Btn, Card, Chip, Empty, ErrorBox, GradCard, H1, H2, Loading, Row, Screen, Seg, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Reviews } from '../blocks';
import { c, grad, money, when } from '../theme';

const KIND = { court: '🏀', ground: '⚽', pool: '🏊', track: '🏃', room: '🧘', equipment: '🎒' };

export function Book() {
  const { push } = useNav();
  const { has } = useSession();
  const [form, setForm] = useState(false);
  const mine = useLoad(() => api.get('/bookings', { limit: 20 }), []);
  const venues = useLoad(() => api.get('/venues', { limit: 50 }), []);
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Book a spot 📅</H1>
      <T color={c.mute} weight="700">Courts, grounds, pools & kit — grab a slot, no double-bookings, ever.</T>
      <Section title="Your bookings" emoji="🎫" color={c.lime}>
        {mine.loading && !mine.data ? <Loading /> : mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : mine.data.length ? mine.data.map((b) => (
          <Row key={b.id} color={c.limeSoft} left={<Bubble emoji={KIND[b.kind] ?? '📍'} color={c.lime} />} title={`${b.resource_name} · ${b.venue_name}`} sub={`${when(b.starts_at)} → ${new Date(b.ends_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
            right={<Btn small title="Cancel" color={c.paper} ink={c.red} onPress={async () => { await api.del(`/bookings/${b.id}`); mine.reload(); }} />} />
        )) : <Empty emoji="🗓️" title="No upcoming bookings" sub="Pick a venue below." />}
      </Section>
      <Section title="Venues near you" emoji="🏟️" color={c.cyan}>
        {has('venue_manager', 'organizer') ? <Btn title="Register a venue" emoji="➕" color={c.violet} onPress={() => setForm(true)} /> : null}
        {venues.data?.map((v) => <Row key={v.id} onPress={() => push('Venue', { id: v.id })} left={<Bubble emoji={v.emoji} color={c.cyan} />} title={v.name} sub={`${v.city ?? ''} · ${v.resources} spots`} right={v.rating ? <T weight="900">⭐ {v.rating}</T> : null} />)}
      </Section>
      <FormSheet visible={form} onClose={() => setForm(false)} title="Register a venue 🏟️" fields={[{ key: 'name', label: 'Venue name' }, { key: 'city', label: 'City', optional: true }, { key: 'address', label: 'Address', optional: true }]}
        onSubmit={async (v) => { const x = await api.post('/venues', v); venues.reload(); push('Venue', { id: x.id }); return 'Venue added 🏟️'; }} />
    </Screen>
  );
}

const hours = Array.from({ length: 16 }, (_, i) => i + 6);
const nextDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0); return d; });

export function Venue({ id }) {
  const { user, toast } = useSession();
  const v = useLoad(() => api.get(`/venues/${id}`), [id]);
  const [sel, setSel] = useState(null);
  const [dayIdx, setDayIdx] = useState(1);
  const [hour, setHour] = useState(18);
  const [dur, setDur] = useState(1);
  const [qty, setQty] = useState(1);
  const [avail, setAvail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [addRes, setAddRes] = useState(false);
  if (v.loading && !v.data) return <Screen><Loading /></Screen>;
  if (v.error) return <Screen><ErrorBox error={v.error} onRetry={v.reload} /></Screen>;
  const x = v.data;
  const range = () => { const s = new Date(nextDays[dayIdx]); s.setHours(hour); const e = new Date(s.getTime() + dur * 3600e3); return [s.toISOString(), e.toISOString()]; };
  const check = async (r = sel, h = hour, d = dur, di = dayIdx) => {
    if (!r) return;
    const s = new Date(nextDays[di]); s.setHours(h); const e = new Date(s.getTime() + d * 3600e3);
    try { setAvail(await api.get(`/resources/${r.id}/availability`, { from: s.toISOString(), to: e.toISOString() })); } catch { setAvail(null); }
  };
  const pick = (patch) => { const n = { dayIdx, hour, dur, ...patch }; if ('dayIdx' in patch) setDayIdx(n.dayIdx); if ('hour' in patch) setHour(n.hour); if ('dur' in patch) setDur(n.dur); check(sel, n.hour, n.dur, n.dayIdx); };
  const book = async () => {
    setBusy(true);
    try { const [starts_at, ends_at] = range(); const b = await api.post('/bookings', { resource_id: sel.id, starts_at, ends_at, quantity: sel.kind === 'equipment' ? qty : 1 }); toast(`Booked! ${b.price_cents ? money(b.price_cents) : 'Free'} 🎉`); setSel(null); }
    catch (e) { toast('⚠️ ' + e.message); check(); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <GradCard colors={grad.fresh}><T size={56}>{x.emoji}</T><H1 style={{ fontSize: 30 }}>{x.name}</H1><T weight="800">{x.city} {x.address ? `· ${x.address}` : ''}</T></GradCard>
      <Section title="Courts, grounds & kit" emoji="🎯" color={c.lime}>
        {x.owner_id === user.id ? <Btn small title="Add a court / ground / kit" emoji="➕" color={c.violet} onPress={() => setAddRes(true)} style={{ alignSelf: 'flex-start' }} /> : null}
        {x.resources.map((r) => (
          <Row key={r.id} color={sel?.id === r.id ? c.sunSoft : c.paper} onPress={() => { setSel(r); setAvail(null); check(r); }} left={<Bubble emoji={KIND[r.kind]} color={c.limeSoft} />} title={r.name}
            sub={`${r.sport_emoji ?? ''} ${r.sport ?? r.kind}${r.kind === 'equipment' ? ` · ${r.capacity} units` : ''}`} right={<Tag label={r.hourly_rate_cents ? `${money(r.hourly_rate_cents)}/h` : 'Free'} color={c.lime} />} />
        ))}
      </Section>

      {sel ? (
        <Card color={c.sunSoft} style={{ marginTop: 16 }}>
          <H2>Book {sel.name}</H2>
          <T weight="800" style={{ marginTop: 10 }}>Day</T>
          <Seg options={nextDays.map((d, i) => ({ value: i, label: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) }))} value={dayIdx} onChange={(i) => pick({ dayIdx: i })} color={c.pink} />
          <T weight="800">Start</T>
          <Seg options={hours.map((h) => ({ value: h, label: `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}` }))} value={hour} onChange={(h) => pick({ hour: h })} color={c.violet} />
          <T weight="800">Duration</T>
          <Seg options={[1, 2, 3].map((d) => ({ value: d, label: `${d}h` }))} value={dur} onChange={(d) => pick({ dur: d })} color={c.cyan} />
          {sel.kind === 'equipment' ? <><T weight="800">Units</T><Seg options={[1, 2, 3, 5].map((n) => ({ value: n, label: `${n}` }))} value={qty} onChange={setQty} color={c.orange} /></> : null}
          {avail ? <T weight="900" color={avail.available ? '#0A8F5A' : c.red} style={{ marginTop: 8 }}>{avail.available ? `✅ Free · ${avail.free} of ${avail.capacity} available` : '⛔ Taken — try another slot'}</T> : null}
          <Btn title={sel.hourly_rate_cents ? `Book · ${money(sel.hourly_rate_cents * dur * (sel.kind === 'equipment' ? qty : 1))}` : 'Book it'} emoji="⚡" onPress={book} loading={busy} disabled={avail && !avail.available} style={{ marginTop: 12 }} />
        </Card>
      ) : null}

      <Section title="Reviews" emoji="💬" color={c.pink}><Reviews type="venue" id={id} /></Section>
      <FormSheet visible={addRes} onClose={() => setAddRes(false)} title="Add a bookable spot" fields={[{ key: 'kind', label: 'Type', type: 'choice', options: ['court', 'ground', 'pool', 'track', 'room', 'equipment'] }, { key: 'name', label: 'Name' }, { key: 'capacity', label: 'Capacity / units', type: 'number', optional: true }, { key: 'hourly_rate_cents', label: 'Price per hour (paise)', type: 'number', optional: true }]}
        onSubmit={async (b) => { await api.post(`/venues/${id}/resources`, b); v.reload(); return 'Added 🎯'; }} />
    </Screen>
  );
}
