import React, { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { FormSheet } from '../FormSheet';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Section, Sheet, T, Tag } from '../ui';
import { c, money, when } from '../theme';
import { locale } from '../locale';
import { moneyIn } from '../vtime';
import { PaySheet } from '../PaySheet';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SPECIALTIES = ['sports medicine', 'knee', 'shoulder', 'back', 'acl', 'rehab', 'nutrition', 'concussion'];

/** Group ISO slot instants by the day they fall on in the provider's time zone. */
const byDay = (slots, tz) => {
  const day = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const out = new Map();
  for (const s of slots) { const k = day.format(new Date(s)); out.set(k, [...(out.get(k) ?? []), { iso: s, label: time.format(new Date(s)) }]); }
  return [...out.entries()];
};

/**
 * Book a physio/doctor. If they published weekly hours you pick one of their open slots; otherwise you type a time,
 * as before. The reason is encrypted on the server.
 */
export function BookProviderSheet({ provider, followupId, onClose, onDone }) {
  const { toast } = useSession();
  const detail = useLoad(() => (provider ? api.get(`/providers/${provider.id}`).catch(() => null) : Promise.resolve(null)), [provider?.id]);
  const slots = useLoad(() => (provider ? api.get(`/providers/${provider.id}/slots`, { to: new Date(Date.now() + 14 * 864e5).toISOString() }) : Promise.resolve(null)), [provider?.id]);
  const [pick, setPick] = useState(null);
  const [reason, setReason] = useState('');
  const [when2, setWhen] = useState('');
  const [mode, setMode] = useState('in_person');
  const [busy, setBusy] = useState(false);
  const [ext, setExt] = useState(false);
  const services = useLoad(() => (provider ? api.get(`/providers/${provider.id}/services`).catch(() => []) : Promise.resolve([])), [provider?.id]);
  const packs = useLoad(() => (provider ? api.get(`/providers/${provider.id}/packages`).catch(() => []) : Promise.resolve([])), [provider?.id]);
  const owned = useLoad(() => (provider ? api.get('/me/packages').catch(() => []) : Promise.resolve([])), [provider?.id]);
  const [svc, setSvc] = useState(null), [code, setCode] = useState(''), [usePkg, setUsePkg] = useState(null), [quote, setQuote] = useState(null), [quoteErr, setQuoteErr] = useState(null), [payPkg, setPayPkg] = useState(null);
  const askQuote = async (s = svc) => {
    setQuote(null); setQuoteErr(null);
    if (!s) return;
    try { setQuote(await api.get(`/providers/${provider.id}/quote`, { service_id: s.id, ...(code.trim() ? { offer_code: code.trim() } : {}) })); } catch (e) { setQuoteErr(e.message); }
  };
  const usable = (owned.data ?? []).filter((k) => svc && k.service_id === svc.id && k.provider_id === provider?.id && k.sessions_left > 0);
  if (!provider) return null;
  const d = detail.data, grid = slots.data?.grid;
  const external = d?.external_booking;
  const both = d && d.in_person !== false && d.remote_ok;
  const send = async () => {
    setBusy(true);
    try {
      const starts_at = grid ? pick : new Date(when2.replace(' ', 'T')).toISOString();
      await api.post('/appointments', { provider_id: provider.id, starts_at, ...(svc ? { service_id: svc.id, ...(usePkg ? { patient_package_id: usePkg } : code.trim() ? { offer_code: code.trim() } : {}) } : { duration_min: grid ? slots.data.slot_min : 30 }), mode: svc && !svc.delivery_modes.includes(mode) ? svc.delivery_modes[0] : d && d.in_person === false ? 'remote' : mode, reason: reason || undefined, ...(followupId ? { followup_id: followupId } : {}) });
      toast('Request sent — waiting for confirmation'); onDone?.(); onClose();
    } catch (e) { toast(e.message?.includes('Invalid time') ? 'Use the format 2026-11-02 17:30' : e.message); } finally { setBusy(false); }
  };
  const leave = async () => {
    try {
      const r = await api.get(`/providers/${provider.id}/external-booking`);
      if (Platform.OS === 'web') window.open(r.external.url, '_blank', 'noopener'); else await Linking.openURL(r.external.url);
      setExt(true);
    } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Book ${provider.display_name}`}>
      {external ? (
        <Card color={c.sunSoft} pad={12}>
          <T weight="800" size={13}>This provider takes bookings on {external.label}</T>
          <T size={12} color={c.mute}>You will leave Gotmygame. The booking is made on a site run by the provider, under their terms and privacy policy, and Gotmygame does not see what you enter there. Come back and add the booking so it shows in your appointments.</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title={`Open ${external.label}`} color={c.violet} onPress={leave} />
            <Btn small title="I've booked — add it here" color={c.paper} ink={c.ink} onPress={() => setExt(true)} />
          </View>
        </Card>
      ) : null}
      {services.data?.length ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Service</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Chip label="General consultation" active={!svc} onPress={() => { setSvc(null); setQuote(null); setUsePkg(null); }} />
            {services.data.map((s) => <Chip key={s.id} label={`${s.title} · ${s.duration_min} min · ${moneyIn(Number(s.price_cents), s.currency)}`} active={svc?.id === s.id} onPress={() => { setSvc(s); setUsePkg(null); askQuote(s); }} />)}
          </View>
          {svc?.cancellation_policy ? <T size={12} color={c.mute}>Cancellation: {svc.cancellation_policy}</T> : null}
          {svc && !usePkg ? <>
            <Field label="Offer code (optional)" value={code} onChangeText={setCode} placeholder="e.g. SPRING10" />
            <Btn small title="Check price" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => askQuote()} />
            {quote ? <Card color={c.mintSoft} pad={10}><T weight="800">{moneyIn(quote.total_cents, quote.currency)}{quote.discount_cents ? ` (was ${moneyIn(quote.list_price_cents, quote.currency)})` : ''}</T>{quote.offer ? <T size={12} color={c.mute}>Offer applied: {quote.offer.title}</T> : null}</Card> : quoteErr ? <T size={12} color={c.red}>{quoteErr}</T> : null}
          </> : null}
          {usable.length ? <View style={{ gap: 6 }}><T weight="800" size={13}>Use a package session</T><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{usable.map((k) => <Chip key={k.id} label={`${k.title} · ${k.sessions_left} left`} active={usePkg === k.id} onPress={() => setUsePkg(usePkg === k.id ? null : k.id)} />)}</View>{usePkg ? <T size={12} color={c.mute}>Nothing more to pay for this visit.</T> : null}</View> : null}
        </View>
      ) : null}
      {packs.data?.filter((k) => !svc || k.service_id === svc.id).length ? (
        <Card pad={10}>
          <T weight="800" size={13}>Packages from this provider</T>
          {packs.data.filter((k) => !svc || k.service_id === svc.id).map((k) => (
            <View key={k.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
              <View style={{ flex: 1 }}><T size={13} weight="700">{k.title}</T><T size={11} color={c.mute}>{k.sessions} sessions · {moneyIn(Number(k.price_cents), k.currency)}{k.valid_days ? ` · valid ${k.valid_days} days` : ''}{k.refund_terms ? ` · ${k.refund_terms}` : ''}</T></View>
              <Btn small title="Buy" color={c.cyan} onPress={async () => { try { const b = await api.post(`/provider-packages/${k.id}/buy`, {}); owned.reload(); if (b.status === 'awaiting_payment') setPayPkg({ type: 'physio_package', id: b.id, amount: Number(b.price_cents), currency: b.currency, label: k.title }); else toast('Package ready to use'); } catch (e) { toast(e.message); } }} />
            </View>
          ))}
        </Card>
      ) : null}
      {payPkg ? <PaySheet target={payPkg} onClose={() => setPayPkg(null)} onDone={owned.reload} /> : null}
      {slots.loading && !slots.data ? <Loading /> : slots.error ? <ErrorBox error={slots.error} onRetry={slots.reload} /> : grid ? (
        slots.data.slots.length ? byDay(slots.data.slots, slots.data.timezone).map(([day, list]) => (
          <View key={day} style={{ gap: 6 }}>
            <T weight="800" size={13}>{day}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{list.map((s) => <Chip key={s.iso} label={s.label} active={pick === s.iso} onPress={() => setPick(s.iso)} />)}</View>
          </View>
        )) : <Empty emoji="📅" title="No open slots in the next two weeks" sub="Try again later or choose another provider." />
      ) : <Field label="When (2026-11-02 17:30)" value={when2} onChangeText={setWhen} />}
      {grid ? <T size={12} color={c.mute}>Times shown in {slots.data.timezone}.</T> : <T size={12} color={c.mute}>This provider has not published opening hours yet, so they will confirm or suggest another time.</T>}
      {both ? <View style={{ flexDirection: 'row', gap: 6 }}>{[['in_person', 'In person'], ['remote', 'Remote']].map(([v, l]) => <Chip key={v} label={l} active={mode === v} onPress={() => setMode(v)} />)}</View> : null}
      {d?.consult_fee_cents && !svc ? <T size={13}>Fee: <T weight="800">{money(d.consult_fee_cents)}</T> — you pay after the request, before the provider confirms.</T> : null}
      <Field label="What is it about? (encrypted — only you and the provider can read it)" value={reason} onChangeText={setReason} multiline />
      <Btn title="Request appointment" color={c.pink} loading={busy} disabled={grid ? !pick : !when2.trim()} onPress={send} />
      <FormSheet visible={ext} onClose={() => setExt(false)} title="Add your booking" submitLabel="Add to my appointments"
        fields={[{ key: 'reference', label: 'Booking reference or confirmation number' }, { key: 'when', label: 'When (2026-11-02 17:30)' }, { key: 'duration_min', label: 'Minutes', type: 'number', optional: true }]}
        onSubmit={async (v) => { const t = new Date(v.when.replace(' ', 'T')); if (isNaN(t)) throw new Error('Use the format 2026-11-02 17:30'); await api.post('/appointments/external', { provider_id: provider.id, external_reference: v.reference, starts_at: t.toISOString(), duration_min: v.duration_min ?? 30 }); onDone?.(); onClose(); return 'Added — the provider will confirm it'; }} />
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
    await api.post('/me/provider-profile', { provider_type: v.provider_type, headline: v.headline ?? null, bio: v.bio ?? null, clinic: v.clinic ?? null, city: v.city ?? null, in_person: v.in_person, remote_ok: v.remote_ok, specialties: v.specialties ?? [], languages: (v.languages ?? '').split(',').map((x) => x.trim()).filter(Boolean), accepting_patients: v.accepting_patients, consult_fee_cents: v.fee === undefined || v.fee === '' ? null : Math.round(Number(v.fee) * 100), timezone: v.timezone, slot_min: v.slot_min, listed: v.listed, external_booking: v.ext_provider === 'none' || !v.ext_url ? null : { provider: v.ext_provider, url: v.ext_url } });
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
        initial={{ provider_type: p?.provider_type ?? type, headline: p?.headline ?? '', bio: p?.bio ?? '', clinic: p?.clinic ?? '', city: p?.city ?? '', in_person: p?.in_person ?? true, remote_ok: p?.remote_ok ?? false, specialties: p?.specialties ?? [], languages: (p?.languages ?? []).join(', '), accepting_patients: p?.accepting_patients ?? true, ext_provider: p?.external_booking?.provider ?? 'none', ext_url: p?.external_booking?.url ?? '', fee: p?.consult_fee_cents ? String(p.consult_fee_cents / 100) : '', timezone: p?.hours.timezone ?? 'UTC', slot_min: p?.hours.slot_min ?? 30, listed: true }}
        fields={[{ key: 'provider_type', label: 'I am a', type: 'choice', options: ['physio', 'doctor'].filter((r) => user.roles.includes(r)).map((r) => ({ value: r, label: r })) },
          { key: 'headline', label: 'Headline', optional: true }, { key: 'bio', label: 'About you', type: 'multiline', optional: true }, { key: 'clinic', label: 'Clinic', optional: true }, { key: 'city', label: 'City', optional: true },
          { key: 'in_person', label: 'See patients in person', type: 'switch' }, { key: 'remote_ok', label: 'Offer remote consultations', type: 'switch' },
          { key: 'specialties', label: 'Specialties', type: 'multi', optional: true, options: SPECIALTIES }, { key: 'languages', label: 'Languages (comma separated)', optional: true },
          { key: 'fee', label: 'Consultation fee (₹)', type: 'number', optional: true }, { key: 'timezone', label: 'Time zone', type: 'timezone' }, { key: 'slot_min', label: 'Appointment length (minutes)', type: 'stepper', min: 10, max: 240, step: 5 },
          { key: 'ext_provider', label: 'Take bookings on another site?', type: 'choice', options: [{ value: 'none', label: 'No' }, { value: 'calendly', label: 'Calendly' }, { value: 'cal_com', label: 'Cal.com' }, { value: 'generic', label: 'My own site' }], hint: 'Patients are sent there with a notice that they are leaving Gotmygame.' }, { key: 'ext_url', label: 'Booking page address (https://…)', optional: true, show: (v) => v.ext_provider !== 'none' },
          { key: 'accepting_patients', label: 'Accepting new appointments', type: 'switch' }, { key: 'listed', label: 'Show me in search', type: 'switch' }]} />
      <FormSheet visible={form === 'hours'} onClose={() => setForm(null)} title="Opening hours" submitLabel="Save hours"
        initial={{ days, start: p?.hours.windows[0]?.start ?? '09:00', end: p?.hours.windows[0]?.end ?? '17:00' }}
        fields={[{ key: 'days', label: 'Days', type: 'weekdays' }, { key: 'start', label: 'From', type: 'time' }, { key: 'end', label: 'Until', type: 'time' }]}
        onSubmit={async (v) => { await api.post('/me/provider-availability', { windows: v.days.map((weekday) => ({ weekday, start: v.start, end: v.end })) }); prof.reload(); return 'Hours saved'; }} />
    </Section>
  );
}

const CRED = {
  verified: ['Verified', c.lime, 'Your professional verification is current. You can write records, follow-ups and confirm appointments for athletes who shared access.'],
  grace: ['Expired, short grace', c.sunSoft, 'Your verification has expired. For a short time you can only complete appointments already confirmed. Renew now to keep working.'],
  expired: ['Expired', c.orangeSoft, 'Your verification has expired, so new clinical actions are paused. Existing records stay safe and the athlete can still read them.'],
  revoked: ['Revoked', c.pinkSoft, 'The platform team revoked your verification, so clinical actions are paused. Submit a new verification to restore access.'],
  pending: ['Being reviewed', c.cyanSoft, 'Your verification is with the review team. Clinical actions open as soon as it is approved.'],
  not_verified: ['Not verified', c.orangeSoft, 'Athletes can share records with you, but you cannot write or read them until your registration is verified.'],
  role_mismatch: ['Does not match your role', c.orangeSoft, 'Your verified credential does not match the doctor or physio role on your account.'],
  sport_scope: ['Different sport', c.orangeSoft, 'Your credential covers another sport than this athlete plays. Submit a verification for that sport.'],
  jurisdiction: ['Region not accepted', c.orangeSoft, 'Your credential was issued in a region the platform does not currently accept.'],
};

/** Provider: is my professional verification current for clinical work, and where do I renew it? */
export function ClinicalStatusCard() {
  const { goTab } = useNav();
  const st = useLoad(() => api.get('/medical/credential'), []);
  const d = st.data;
  const [label, color, text] = d ? (CRED[d.state] ?? CRED.not_verified) : [];
  return (
    <Card color={c.paper} pad={12}>
      <T weight="900">Your professional verification</T>
      {st.loading && !d ? <Loading /> : st.error ? <ErrorBox error={st.error} onRetry={st.reload} /> : (
        <View style={{ gap: 6, marginTop: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={label} color={color} />{d.expires_at ? <T size={12} color={c.mute}>{d.state === 'verified' ? 'valid until' : 'ended'} {new Date(d.expires_at).toLocaleDateString(locale)}</T> : null}</View>
          <T size={13}>{text}</T>
          {d.renewal ? <Btn small title={d.state === 'not_verified' ? 'Get verified' : 'Renew verification'} accessibilityLabel={d.state === 'not_verified' ? 'Get your professional verification. Opens the Me tab' : 'Renew your professional verification. Opens the Me tab'} color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => goTab('Me')} /> : null}
          {d.renewal ? <T size={11} color={c.mute}>Opens Me, then Verification, where you attach your registration. Renewals are linked to your earlier case.</T> : null}
        </View>
      )}
    </Card>
  );
}

/** Athlete: choose how much of the history a provider sees, with a warning when their verification is not current. */
export function ShareRecordsSheet({ provider, onClose, onDone }) {
  const { toast } = useSession();
  const detail = useLoad(() => (provider ? api.get(`/providers/${provider.id}`).catch(() => null) : Promise.resolve(null)), [provider?.id]);
  const [history, setHistory] = useState('since_grant');
  const [busy, setBusy] = useState(false);
  if (!provider) return null;
  const unverified = detail.data && !(detail.data.verified ?? []).length;
  const share = async () => {
    setBusy(true);
    try {
      const r = await api.post('/medical/grants', { provider_id: provider.id, history });
      toast(r.warning ?? 'Access granted'); onDone?.(); onClose();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Share records with ${provider.name}`}>
      {unverified ? <Card color={c.orangeSoft} pad={12}><T weight="800" size={13}>This provider is not verified right now</T><T size={12}>You can still share, but they will not be able to open or add records until their professional verification is approved or renewed. You can withdraw access at any time.</T></Card> : null}
      <T weight="800" size={13}>What can they see?</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Chip label="Their own notes and anything from now on" active={history === 'since_grant'} onPress={() => setHistory('since_grant')} />
        <Chip label="My whole history" active={history === 'all'} onPress={() => setHistory('all')} />
      </View>
      <T size={12} color={c.mute}>{history === 'all' ? 'They will also see records written earlier by other providers.' : 'Earlier records from other providers stay private.'} You always see everything yourself.</T>
      <Btn title="Share" color={c.violet} loading={busy} onPress={share} />
    </Sheet>
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
            <View style={{ flex: 1 }}><T weight="800">{x.provider_name}</T><T size={12} color={c.mute}>{x.scope === 'full' ? (x.history_scope === 'all' ? 'Records and fit-to-play, whole history' : 'Records and fit-to-play, from the grant onward') : 'Fit-to-play status only'}{x.expires_at ? ` · until ${new Date(x.expires_at).toLocaleDateString(locale)}` : ''}</T></View>
            <Tag label={STATE[x.state][0]} color={STATE[x.state][1]} />
          </View>
          {x.state === 'active' && x.provider_verified === false ? <T size={12} color={c.red} style={{ marginTop: 6 }}>Their professional verification is not current, so they cannot open or add records until it is renewed.</T> : null}
          {x.state === 'active' ? <Btn small title="Withdraw access" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => act(() => api.del(`/medical/grants/${x.provider_id}`), 'Access withdrawn')} /> : null}
        </Card>
      )) : <Empty emoji="🔒" title="Nobody has access" sub="Share records with a provider from an appointment." />}
    </View>
  );
}

const FSTATE = { due: ['Due', c.sunSoft], booked: ['Booked', c.cyanSoft], done: ['Done', c.lime], cancelled: ['Cancelled', c.violetSoft] };

/** Add a follow-up to one of my appointments (provider). */
export function AddFollowupSheet({ appointment, onClose, onDone }) {
  return (
    <FormSheet visible={!!appointment} onClose={onClose} title="Agree a follow-up" submitLabel="Add follow-up"
      fields={[{ key: 'due_on', label: 'Due on', type: 'date' }, { key: 'window_end', label: 'Latest date (optional)', type: 'date', optional: true },
        { key: 'instruction_summary', label: 'What should the athlete do?', type: 'multiline', hint: 'The athlete sees this and it appears in reminders. Keep it practical, not a diagnosis.' },
        { key: 'details', label: 'Sensitive details (optional)', type: 'multiline', optional: true, hint: 'Encrypted. Needs the athlete\'s access; visible to them and to you while they allow it.' }]}
      onSubmit={async (v) => { await api.post('/followups', { appointment_id: appointment.id, ...v }); onDone?.(); return 'Follow-up added'; }} />
  );
}

/** Follow-ups for the signed-in person, as athlete or provider. */
export function FollowupsPanel() {
  const { user, toast } = useSession();
  const list = useLoad(() => api.get('/followups', { limit: 50 }), []);
  const [book, setBook] = useState(null);
  const [resched, setResched] = useState(null);
  const [open, setOpen] = useState(null);
  const run = async (fn, m) => { try { await fn(); toast(m); list.reload(); } catch (e) { toast(e.message); } };
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  return (
    <View style={{ gap: 8 }}>
      {list.data.length ? list.data.map((f) => (
        <Card key={f.id} pad={12} color={f.overdue ? c.orangeSoft : c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{f.i_am_athlete ? `With ${f.provider_name}` : `For ${f.athlete_name}`}</T><T size={12} color={c.mute}>Due {f.due_on.slice(0, 10)}{f.window_end ? ` to ${f.window_end.slice(0, 10)}` : ''}{f.overdue ? ' · overdue' : ''}</T></View>
            <Tag label={FSTATE[f.status][0]} color={FSTATE[f.status][1]} />
          </View>
          <T size={13} style={{ marginTop: 6 }}>{f.instruction_summary}</T>
          {open === f.id ? <FollowupDetails id={f.id} /> : f.has_details ? <Btn small title="Show sensitive details (logged)" color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 6 }} onPress={() => setOpen(f.id)} /> : null}
          {['due', 'booked'].includes(f.status) ? (
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {f.i_am_athlete && f.status === 'due' ? <Btn small title="Book the visit" color={c.pink} onPress={() => setBook(f)} /> : null}
              <Btn small title="Mark done" color={c.mint} ink={c.ink} onPress={() => run(() => api.patch(`/followups/${f.id}`, { status: 'done' }), 'Marked done')} />
              {f.status === 'due' ? <Btn small title="Change date" color={c.paper} ink={c.ink} onPress={() => setResched(f)} /> : null}
              <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => run(() => api.patch(`/followups/${f.id}`, { status: 'cancelled' }), 'Cancelled')} />
            </View>
          ) : null}
        </Card>
      )) : <Empty emoji="🗓️" title="No follow-ups" sub="Follow-ups your physio or doctor agrees with you appear here, with reminders." />}
      {book ? <BookProviderSheet provider={{ id: book.provider_id, display_name: book.provider_name }} followupId={book.id} onClose={() => setBook(null)} onDone={list.reload} /> : null}
      <FormSheet visible={!!resched} onClose={() => setResched(null)} title="Change the date" initial={{ due_on: resched?.due_on?.slice(0, 10) }}
        fields={[{ key: 'due_on', label: 'Due on', type: 'date' }, { key: 'window_end', label: 'Latest date (optional)', type: 'date', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/followups/${resched.id}`, { due_on: v.due_on, ...(v.window_end ? { window_end: v.window_end } : {}) }); list.reload(); return 'Date updated'; }} />
    </View>
  );
}

function FollowupDetails({ id }) {
  const d = useLoad(() => api.get(`/followups/${id}`), [id]);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  return <Card color={c.violetSoft} pad={10} style={{ marginTop: 6 }}><T size={13}>{d.data.details_visible ? d.data.details : 'The athlete no longer shares these details with you.'}</T></Card>;
}

/**
 * Find a physio or doctor: search by name, clinic or speciality, filter by type, remote and verified, sort by rating, fee or soonest slot.
 * The single place to find a health professional (Health -> Find a pro); booking opens the same sheet as everywhere else.
 */
export function ProviderSearch({ onBooked }) {
  const { user } = useSession();
  const [book, setBook] = useState(null);
  const [pf, setPf] = useState({ type: '', remote: false, verified: false, sort: 'rating', q: '' });
  const provs = useLoad(() => api.get('/providers/search', { limit: 50, sort: pf.sort, ...(pf.type ? { type: pf.type } : {}), ...(pf.remote ? { remote: true } : {}), ...(pf.verified ? { verified: true } : {}), ...(pf.q.trim() ? { q: pf.q.trim() } : {}) }), [pf.type, pf.remote, pf.verified, pf.sort, pf.q]);
  return (
    <View style={{ gap: 10 }}>
      <Field value={pf.q} onChangeText={(q) => setPf({ ...pf, q })} placeholder="Search by name, clinic or speciality…" />
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {[['', 'Anyone'], ['physio', 'Physios'], ['doctor', 'Doctors']].map(([v, l]) => <Chip key={v} label={l} active={pf.type === v} onPress={() => setPf({ ...pf, type: v })} />)}
        <Chip label="Remote" active={pf.remote} onPress={() => setPf({ ...pf, remote: !pf.remote })} />
        <Chip label="✓ Verified" active={pf.verified} onPress={() => setPf({ ...pf, verified: !pf.verified })} />
        {[['rating', 'Top rated'], ['fee', 'Lowest fee'], ['soonest', 'Soonest']].map(([v, l]) => <Chip key={v} label={l} active={pf.sort === v} onPress={() => setPf({ ...pf, sort: v })} />)}
      </View>
      {provs.error ? <ErrorBox error={provs.error} onRetry={provs.reload} /> : provs.loading && !provs.data ? <Loading /> : !provs.data?.length ? (
        <Empty emoji="🩺" title="No providers match" sub="Try removing a filter." />
      ) : provs.data.map((x) => (
        <Card key={x.id} pad={14}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Avatar user={x} size={48} />
            <View style={{ flex: 1, gap: 3 }}>
              <T weight="800" size={15}>{x.display_name}{x.credential_verified ? ' ✓' : ''}</T>
              <T size={12} color={c.mute}>{[String(x.provider_type ?? '').replace(/_/g, ' '), x.clinic, x.city, x.remote_ok ? 'remote' : null].filter(Boolean).join(' · ')}</T>
              {x.headline ? <T size={12}>{x.headline}</T> : null}
              <T size={12} color={c.mute}>{[x.rating ? `★ ${Number(x.rating).toFixed(1)} (${x.rating_count})` : 'No reviews yet', x.fee_cents ? moneyIn(Number(x.fee_cents), x.currency ?? 'INR') : 'Fee on request', x.accepting_patients === false ? 'not taking new patients' : null].filter(Boolean).join(' · ')}</T>
            </View>
            {x.id !== user.id ? <Btn small title="Book" disabled={x.accepting_patients === false} onPress={() => setBook(x)} /> : null}
          </View>
        </Card>
      ))}
      {book ? <BookProviderSheet provider={book} onClose={() => setBook(null)} onDone={() => { setBook(null); onBooked?.(); }} /> : null}
    </View>
  );
}
