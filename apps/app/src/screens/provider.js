import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Section, Sheet, T, Tag } from '../ui';
import { c, money } from '../theme';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SPECIALTIES = ['sports medicine', 'knee', 'shoulder', 'back', 'acl', 'rehab', 'nutrition', 'concussion'];

/** Group ISO slot instants by the day they fall on in the provider's time zone. */
const byDay = (slots, tz) => {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const out = new Map();
  for (const s of slots) { const k = day.format(new Date(s)); out.set(k, [...(out.get(k) ?? []), { iso: s, label: time.format(new Date(s)) }]); }
  return [...out.entries()];
};

/**
 * Book a physio/doctor. If they published weekly hours you pick one of their open slots; otherwise you type a time,
 * as before. The reason is encrypted on the server.
 */
export function BookProviderSheet({ provider, onClose, onDone }) {
  const { toast } = useSession();
  const slots = useLoad(() => (provider ? api.get(`/providers/${provider.id}/slots`, { to: new Date(Date.now() + 14 * 864e5).toISOString() }) : Promise.resolve(null)), [provider?.id]);
  const [pick, setPick] = useState(null);
  const [reason, setReason] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  if (!provider) return null;
  const grid = slots.data?.grid;
  const send = async () => {
    setBusy(true);
    try {
      const starts_at = grid ? pick : new Date(when.replace(' ', 'T')).toISOString();
      await api.post('/appointments', { provider_id: provider.id, starts_at, duration_min: grid ? slots.data.slot_min : 30, reason: reason || undefined });
      toast('Request sent — waiting for confirmation'); onDone?.(); onClose();
    } catch (e) { toast(e.message?.includes('Invalid time') ? 'Use the format 2026-11-02 17:30' : e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Book ${provider.display_name}`}>
      {slots.loading && !slots.data ? <Loading /> : slots.error ? <ErrorBox error={slots.error} onRetry={slots.reload} /> : grid ? (
        slots.data.slots.length ? byDay(slots.data.slots, slots.data.timezone).map(([d, list]) => (
          <View key={d} style={{ gap: 6 }}>
            <T weight="800" size={13}>{d}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{list.map((s) => <Chip key={s.iso} label={s.label} active={pick === s.iso} onPress={() => setPick(s.iso)} />)}</View>
          </View>
        )) : <Empty emoji="📅" title="No open slots in the next two weeks" sub="Try again later or choose another provider." />
      ) : <Field label="When (2026-11-02 17:30)" value={when} onChangeText={setWhen} />}
      {grid ? <T size={12} color={c.mute}>Times shown in {slots.data.timezone}.</T> : <T size={12} color={c.mute}>This provider has not published opening hours yet, so they will confirm or suggest another time.</T>}
      <Field label="What is it about? (encrypted — only you and the provider can read it)" value={reason} onChangeText={setReason} multiline />
      <Btn title="Request appointment" color={c.pink} loading={busy} disabled={grid ? !pick : !when.trim()} onPress={send} />
    </Sheet>
  );
}

/** Provider's own public profile + weekly hours (Me screen, physio/doctor roles). */
export function ProviderProfileSection() {
  const { user, toast } = useSession();
  const type = user.roles.includes('doctor') ? 'doctor' : 'physio';
  const prof = useLoad(() => api.get(`/providers/${user.id}`).catch((e) => (/not found/i.test(e.message) ? null : Promise.reject(e))), [user.id]);
  const [form, setForm] = useState(null);
  const p = prof.data;
  const save = async (v) => {
    await api.post('/me/provider-profile', { provider_type: v.provider_type, headline: v.headline ?? null, bio: v.bio ?? null, clinic: v.clinic ?? null, city: v.city ?? null, in_person: v.in_person, remote_ok: v.remote_ok, specialties: v.specialties ?? [], languages: (v.languages ?? '').split(',').map((x) => x.trim()).filter(Boolean), accepting_patients: v.accepting_patients, consult_fee_cents: v.fee === undefined || v.fee === '' ? null : Math.round(Number(v.fee) * 100), timezone: v.timezone, slot_min: v.slot_min, listed: v.listed });
    prof.reload(); return 'Profile saved';
  };
  const days = p ? [...new Set(p.hours.windows.map((w) => w.weekday))] : [];
  return (
    <Section title="Provider profile" color={c.mint}>
      <T size={13} color={c.mute}>This is what patients see when they search. Never put patient or clinical information here.</T>
      {prof.loading && !prof.data ? <Loading /> : prof.error ? <ErrorBox error={prof.error} onRetry={prof.reload} /> : (
        <Card color={c.mintSoft} pad={12}>
          {p ? <>
            <T weight="800">{p.headline ?? p.display_name}</T>
            <T size={13}>{[p.clinic, p.city, p.remote_ok ? 'remote available' : null].filter(Boolean).join(' · ') || 'Add your clinic and city'}</T>
            <T size={12} color={c.mute}>{p.hours.windows.length ? `Hours (${p.hours.timezone}): ${p.hours.windows.map((w) => `${DAYS[w.weekday]} ${w.start}-${w.end}`).join(', ')}` : 'No opening hours yet: patients can only request a time'}</T>
          </> : <T size={13}>No profile yet.</T>}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title={p ? 'Edit profile' : 'Create profile'} color={c.pink} onPress={() => setForm('profile')} />
            <Btn small title="Set opening hours" color={c.violet} disabled={!p} onPress={() => setForm('hours')} />
          </View>
        </Card>
      )}
      <FormSheet visible={form === 'profile'} onClose={() => setForm(null)} title="Provider profile" onSubmit={save}
        initial={{ provider_type: p?.provider_type ?? type, headline: p?.headline ?? '', bio: p?.bio ?? '', clinic: p?.clinic ?? '', city: p?.city ?? '', in_person: p?.in_person ?? true, remote_ok: p?.remote_ok ?? false, specialties: p?.specialties ?? [], languages: (p?.languages ?? []).join(', '), accepting_patients: p?.accepting_patients ?? true, fee: p?.consult_fee_cents ? String(p.consult_fee_cents / 100) : '', timezone: p?.hours.timezone ?? 'UTC', slot_min: p?.hours.slot_min ?? 30, listed: true }}
        fields={[{ key: 'provider_type', label: 'I am a', type: 'choice', options: ['physio', 'doctor'].filter((r) => user.roles.includes(r)).map((r) => ({ value: r, label: r })) },
          { key: 'headline', label: 'Headline', optional: true }, { key: 'bio', label: 'About you', type: 'multiline', optional: true }, { key: 'clinic', label: 'Clinic', optional: true }, { key: 'city', label: 'City', optional: true },
          { key: 'in_person', label: 'See patients in person', type: 'switch' }, { key: 'remote_ok', label: 'Offer remote consultations', type: 'switch' },
          { key: 'specialties', label: 'Specialties', type: 'multi', optional: true, options: SPECIALTIES }, { key: 'languages', label: 'Languages (comma separated)', optional: true },
          { key: 'fee', label: 'Consultation fee (₹)', type: 'number', optional: true }, { key: 'timezone', label: 'Time zone', type: 'timezone' }, { key: 'slot_min', label: 'Appointment length (minutes)', type: 'stepper', min: 10, max: 240, step: 5 },
          { key: 'accepting_patients', label: 'Accepting new appointments', type: 'switch' }, { key: 'listed', label: 'Show me in search', type: 'switch' }]} />
      <FormSheet visible={form === 'hours'} onClose={() => setForm(null)} title="Opening hours" submitLabel="Save hours"
        initial={{ days, start: p?.hours.windows[0]?.start ?? '09:00', end: p?.hours.windows[0]?.end ?? '17:00' }}
        fields={[{ key: 'days', label: 'Days', type: 'weekdays' }, { key: 'start', label: 'From', type: 'time' }, { key: 'end', label: 'Until', type: 'time' }]}
        onSubmit={async (v) => { await api.post('/me/provider-availability', { windows: v.days.map((weekday) => ({ weekday, start: v.start, end: v.end })) }); prof.reload(); return 'Hours saved'; }} />
    </Section>
  );
}

/** Athlete: who can see my records, with scope and expiry, and a button to withdraw. */
export function ConsentManager() {
  const { toast } = useSession();
  const g = useLoad(() => api.get('/medical/grants'), []);
  const act = async (fn, m) => { try { await fn(); toast(m); g.reload(); } catch (e) { toast(e.message); } };
  const STATE = { active: ['Active', c.lime], expired: ['Expired', c.orangeSoft], revoked: ['Revoked', c.violetSoft] };
  return (
    <View style={{ gap: 8 }}>
      <T size={13} color={c.mute}>Providers can only see what you share, and you can stop at any time. Everything you grant or withdraw is kept in your history.</T>
      {g.loading && !g.data ? <Loading /> : g.error ? <ErrorBox error={g.error} onRetry={g.reload} /> : g.data.grants.length ? g.data.grants.map((x) => (
        <Card key={x.provider_id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T weight="800">{x.provider_name}</T><T size={12} color={c.mute}>{x.scope === 'full' ? 'Records and fit-to-play' : 'Fit-to-play status only'}{x.expires_at ? ` · until ${new Date(x.expires_at).toLocaleDateString()}` : ''}</T></View>
            <Tag label={STATE[x.state][0]} color={STATE[x.state][1]} />
          </View>
          {x.state === 'active' ? <Btn small title="Withdraw access" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => act(() => api.del(`/medical/grants/${x.provider_id}`), 'Access withdrawn')} /> : null}
        </Card>
      )) : <Empty emoji="🔒" title="Nobody has access" sub="Share records with a provider from an appointment." />}
    </View>
  );
}
