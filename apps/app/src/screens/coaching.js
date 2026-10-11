// Coaching, both sides of the marketplace.
//   Athlete: Hire (find a coach · post a request · my coaching) -> CoachProfile -> BookCoachSheet, CoachRequest (compare answers).
//   Coach:   CoachDesk (confirm, complete, earnings, reviews), CoachBoard (answer requests), CoachSetup (profile + weekly hours).
import React, { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, H2, Loading, Screen, Section, Seg, Sheet, StatPill, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { SportSelect } from '../sportpicker';
import { Counter, DateField, DayStrip, HScroll, TimeField } from '../pickers';
import { NewCaseSheet } from './cases';
import { SeriesBookingSheet, VenueLine } from './training-venue';
import { BookProviderSheet } from './provider';
import { Grid, PaySheet, Pill, StatusPill, nice, useCols } from './marketplace';
import { c, grad, toneFor } from '../theme';
import { dateTimeIn, localDate, localToIso, moneyIn, timeIn, todayIn, WEEKDAYS } from '../vtime';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
export const price = (cents, currency = 'INR') => moneyIn(Number(cents ?? 0), currency);
const rateOf = (x, currency) => (x.hourly_rate_cents ? `${price(x.hourly_rate_cents, currency)}/hr` : 'Rate on request');
export const AUDIENCES = [['individual', 'Individual'], ['group', 'Group'], ['team', 'Team'], ['event', 'Event']];
export const UNIT = { hour: '/hr', session: '/session', day: '/day', month: '/month', package: ' package' };
export const cardPrice = (k, currency) => `${price(k.price_cents, currency)}${UNIT[k.unit]}${k.per_person ? ' per person' : ''}`;
export const audienceTag = (r) => (r.audience && r.audience !== 'individual' ? `${r.audience[0].toUpperCase()}${r.audience.slice(1)}${r.team_name ? `: ${r.team_name}` : r.event_name ? `: ${r.event_name}` : ''}${r.participants > 1 ? ` · ${r.participants} people` : ''}` : null);
const DELIVERY = { in_person: 'In person', online: 'Online', both: 'In person & online', either: 'In person or online' };
const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'].map((value) => ({ value, label: nice(value).replace(/^./, (x) => x.toUpperCase()) }));
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const useDebounced = (value, ms = 350) => {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
};

const Stars = ({ value, size = 14 }) => <T size={size} color={c.sun} weight="800">{'★'.repeat(Math.round(value))}{'☆'.repeat(5 - Math.round(value))}</T>;
const RatingLine = ({ avg, n, size = 13 }) => (n
  ? <T size={size}><T size={size} weight="800" color={c.sun}>★ {Number(avg).toFixed(1)}</T><T size={size} color={c.mute}> ({n} review{n === 1 ? '' : 's'})</T></T>
  : <T size={size} color={c.mute}>New · no reviews yet</T>);
const Verified = () => <Pill label="✓ VERIFIED" fg={c.lime} bg={c.limeSoft} />;
export const Tile = ({ value, label, hot }) => <StatPill value={value} label={label} color={hot ? c.lime : c.paper} />;
export const Head = ({ eyebrow, title, sub, right }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
    <View style={{ flexShrink: 1 }}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{eyebrow}</T>
      <H1 style={{ fontSize: 28 }}>{title}</H1>
      {sub ? <T size={14} color={c.mute} style={{ marginTop: 2 }}>{sub}</T> : null}
    </View>
    {right}
  </View>
);

/** A yes/no question before something that cannot be undone (cancel, accept). */
export function Confirm({ visible, title, body, yes, danger, onYes, onClose }) {
  const [busy, setBusy] = useState(false);
  if (!visible) return null;
  return (
    <Sheet visible onClose={onClose} title={title}>
      {typeof body === 'string' ? <T size={14} color={c.mute}>{body}</T> : body}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="Not now" color={c.paper} ink={c.ink} onPress={onClose} style={{ flex: 1 }} />
        <Btn title={yes} color={danger ? c.red : c.pink} loading={busy} style={{ flex: 1 }} onPress={async () => { setBusy(true); try { await onYes(); } finally { setBusy(false); } }} />
      </View>
    </Sheet>
  );
}

function ReviewSheet({ hire, onClose, onDone }) {
  const { toast } = useSession();
  const [rating, setRating] = useState(0), [body, setBody] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  if (!hire) return null;
  const send = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/hires/${hire.id}/review`, { rating, ...(body.trim() ? { body: body.trim() } : {}) }); toast('Thanks — your review is public on their profile'); await onDone(); onClose(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Rate ${hire.coach_name}`}>
      <T size={13} color={c.mute}>{hire.sport_emoji} {hire.sport} · {dateTimeIn(hire.starts_at, deviceTz)}. Only athletes who finished a session can review, so ratings stay honest.</T>
      <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
        {[1, 2, 3, 4, 5].map((n) => <Pressable key={n} onPress={() => setRating(n)} accessibilityLabel={`${n} star${n === 1 ? '' : 's'}`} hitSlop={6}><T size={40} color={n <= rating ? c.sun : c.line}>★</T></Pressable>)}
      </View>
      <Field label="What was it like? (optional)" value={body} onChangeText={setBody} multiline />
      {err ? <T color={c.red} weight="800">{err}</T> : null}
      <Btn title="Post review" disabled={!rating} loading={busy} onPress={send} />
    </Sheet>
  );
}

// ================================================================================== BOOK A SESSION
/**
 * Book from one of the coach's rate cards (individual, group, team or event) or their standard hourly rate. With open hours you
 * pick a real slot; otherwise you propose a date and time. A team or event booking names the team or event it is for.
 */
export function BookCoachSheet({ coach, onClose, onDone }) {
  const { toast, user } = useSession();
  const detail = useLoad(() => api.get(`/coaches/${coach.id}`), [coach.id]);
  const cards = (detail.data?.rate_cards ?? []).filter((k) => !k.sport_slug || k.sport_slug === coach.sport_slug);
  const [cardId, setCardId] = useState(null);
  const card = cards.find((k) => k.id === cardId) ?? null;
  const [hours, setHours] = useState(60), [people, setPeople] = useState(1), [teamId, setTeamId] = useState(null), [eventId, setEventId] = useState(null);
  const [day, setDay] = useState(null), [pick, setPick] = useState(null), [date, setDate] = useState(), [time, setTime] = useState(), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState(null), [repeat, setRepeat] = useState(false);
  const teams = useLoad(() => (card?.audience === 'team' ? api.get('/teams', { mine: true, limit: 50 }) : Promise.resolve([])), [card?.audience]);
  const events = useLoad(() => (card?.audience === 'event' ? api.get('/events', { organizer_id: user.id, limit: 50 }) : Promise.resolve([])), [card?.audience]);
  const mins = card && card.unit !== 'hour' ? card.duration_min ?? 60 : hours;
  const slots = useLoad(() => (mins <= 480 ? api.get(`/coaches/${coach.id}/slots`, { from: new Date().toISOString(), to: new Date(Date.now() + 21 * 864e5).toISOString(), duration_min: mins }) : Promise.resolve({ grid: false, slots: [], timezone: 'UTC' })), [coach.id, mins]);
  const d = slots.data, tz = d?.timezone ?? 'UTC';
  const byDay = {};
  for (const x of d?.slots ?? []) (byDay[localDate(x, tz)] ??= []).push(x);
  const first = todayIn(tz), avail = Object.fromEntries(Object.keys(byDay).map((k) => [k, 'available']));
  const chosenDay = day ?? Object.keys(byDay).sort()[0];
  const startsAt = d?.grid ? pick : date && time ? localToIso(date, time, deviceTz) : null;
  const rate = card ? Number(card.price_cents) : Number(coach.hourly_rate_cents ?? 0);
  const base = !card || card.unit === 'hour' ? Math.round((rate * mins) / 60) : rate;
  const cost = card?.per_person ? base * people : base;
  const need = card?.audience === 'team' ? !teamId : card?.audience === 'event' ? !eventId : false;
  const choose = (k) => { setCardId(k?.id ?? null); setPeople(k ? k.min_participants : 1); setTeamId(null); setEventId(null); setPick(null); setDay(null); };
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const hire = await api.post('/hires', { coach_id: coach.id, sport: coach.sport_slug, starts_at: startsAt, duration_min: mins, ...(note.trim() ? { note: note.trim() } : {}),
        ...(card ? { rate_card_id: card.id, participants: people, ...(teamId ? { team_id: teamId } : {}), ...(eventId ? { event_id: eventId } : {}) } : {}) });
      toast(hire.payment_status === 'unpaid' ? 'Requested — pay to let the coach confirm' : 'Requested — the coach will confirm');
      await onDone(hire); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Book ${coach.display_name}`}>
      <T size={13} color={c.mute}>{coach.sport_emoji} {coach.sport}</T>
      {cards.length ? (
        <View style={{ gap: 8 }}>
          <T weight="800" size={13}>What do you need?</T>
          <View style={{ gap: 8 }}>
            {coach.hourly_rate_cents ? <Card pad={12} color={!card ? c.pinkSoft : c.paper} onPress={() => choose(null)}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">Standard hourly rate</T><T weight="800">{rateOf(coach, coach.currency)}</T></View><T size={12} color={c.mute}>One person</T></Card> : null}
            {cards.map((k) => (
              <Card key={k.id} pad={12} color={card?.id === k.id ? c.pinkSoft : c.paper} onPress={() => choose(k)}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="700">{k.title}{k.is_intro ? ' · trial' : ''}</T></View><T weight="800">{cardPrice(k, coach.currency)}</T></View>
                <T size={12} color={c.mute}>{[nice(k.audience), k.duration_min && k.unit !== 'hour' ? `${k.duration_min} min` : null, k.audience !== 'individual' ? `${k.min_participants}${k.max_participants ? `–${k.max_participants}` : '+'} people` : null, k.sessions_included ? `${k.sessions_included} sessions` : null].filter(Boolean).join(' · ')}</T>
                {k.description ? <T size={12} color={c.mute}>{k.description}</T> : null}
              </Card>
            ))}
          </View>
        </View>
      ) : null}
      {card && card.audience !== 'individual' ? <Counter label="How many people" value={people} onChange={setPeople} min={card.min_participants} max={card.max_participants ?? 500} /> : null}
      {card?.audience === 'team' ? (
        <View style={{ gap: 6 }}><T weight="800" size={13}>Which team</T>
          {teams.loading && !teams.data ? <Loading /> : !teams.data?.length ? <T size={13} color={c.mute}>You are not on a team yet — create or join one first.</T> : <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{teams.data.map((t) => <Chip key={t.id} label={`${t.emoji ?? ''} ${t.name}`.trim()} active={teamId === t.id} onPress={() => setTeamId(t.id)} />)}</View>}
          <T size={12} color={c.mute}>Only a manager or captain of the team can book for it.</T></View>
      ) : null}
      {card?.audience === 'event' ? (
        <View style={{ gap: 6 }}><T weight="800" size={13}>Which event</T>
          {events.loading && !events.data ? <Loading /> : !events.data?.length ? <T size={13} color={c.mute}>You are not organising an event yet.</T> : <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{events.data.map((e) => <Chip key={e.id} label={e.name} active={eventId === e.id} onPress={() => setEventId(e.id)} />)}</View>}</View>
      ) : null}
      {!card || card.unit === 'hour' ? <Counter label="Session length" value={hours} onChange={(x) => { setHours(x); setPick(null); }} min={30} max={card ? 480 : 240} step={15} suffix=" min" /> : <T size={13} color={c.mute}>Session length is set by the coach: {mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}` : `${mins} min`}.</T>}
      {slots.loading && !d ? <Loading /> : slots.error ? <ErrorBox error={slots.error} onRetry={slots.reload} /> : d.grid ? (
        Object.keys(byDay).length ? (
          <View style={{ gap: 10 }}>
            <T weight="800" size={13}>Pick a day</T>
            <DayStrip from={first} count={21} value={chosenDay} onChange={(x) => { setDay(x); setPick(null); }} avail={avail} />
            <T weight="800" size={13}>Open times</T>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {(byDay[chosenDay] ?? []).map((x) => <Chip key={x} label={timeIn(x, tz)} active={pick === x} onPress={() => setPick(x)} />)}
              {!(byDay[chosenDay] ?? []).length ? <T size={13} color={c.mute}>Nothing open that day — try another.</T> : null}
            </View>
            <T size={12} color={c.mute}>Times shown in the coach's time zone ({tz}).</T>
          </View>
        ) : <Empty emoji="📅" title="No open slots in the next three weeks" sub="Try a shorter session, or post a request and let coaches propose a time." />
      ) : (
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>{mins > 480 ? 'This is a full-day booking.' : 'This coach has not published open hours.'} Propose a date and time and they will confirm it or suggest another.</T>
          <DateField label="Date" value={date} onChange={setDate} min={first} />
          <TimeField label="Start time" value={time} onChange={setTime} step={15} hint="In your time zone." />
        </View>
      )}
      <Field label="What do you want to work on? (optional)" value={note} onChangeText={setNote} multiline />
      <Card color={c.pinkSoft} pad={12}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">Total</T><T weight="800">{rate ? price(cost, coach.currency) : 'Agreed with the coach'}</T></View>
        {card?.unit === 'package' && card.sessions_included ? <T size={12} color={c.mute}>Covers {card.sessions_included} sessions; the coach schedules the rest with you.</T> : null}
        <T size={12} color={c.mute}>You pay after the request; the coach confirms once it is paid. Cancel any time and a paid session is refunded.</T>
      </Card>
      {err ? <T color={c.red} weight="800">{err}</T> : null}
      <Btn title="Request booking" loading={busy} disabled={!startsAt || need} onPress={send} />
      <Btn title="🔁 Repeat weekly or pick several dates" color={c.paper} ink={c.ink} disabled={need} onPress={() => setRepeat(true)} />
      {repeat ? <SeriesBookingSheet coach={coach} card={card} people={people} teamId={teamId} eventId={eventId} minutes={mins} onClose={() => setRepeat(false)} onDone={() => onDone?.({ payment_status: 'not_required', series: true })} onFinish={onClose} /> : null}
    </Sheet>
  );
}

// ================================================================================== POST A REQUEST
export function PostRequestSheet({ visible, onClose, onDone, currency = 'INR' }) {
  const today = todayIn(deviceTz);
  const { user } = useSession();
  const teams = useLoad(() => (visible ? api.get('/teams', { mine: true, limit: 50 }) : Promise.resolve([])), [visible]);
  const events = useLoad(() => (visible ? api.get('/events', { organizer_id: user.id, limit: 50 }) : Promise.resolve([])), [visible]);
  return (
    <FormSheet visible={visible} onClose={onClose} title="Tell coaches what you need" submitLabel="Post request"
      initial={{ delivery: 'either', sessions_per_week: 2, audience: 'individual', participants: 10 }}
      fields={[
        { key: 'audience', label: 'Who is the coaching for', type: 'chips', options: AUDIENCES.map(([value, label]) => ({ value, label })) },
        { key: 'team_id', label: teams.data?.length ? 'Which team' : 'Which team (you are not on a team yet)', type: 'chips', optional: true, options: (teams.data ?? []).map((t) => ({ value: t.id, label: t.name })), show: (v) => v.audience === 'team' && !!teams.data?.length },
        { key: 'event_id', label: events.data?.length ? 'Which event' : 'Which event (you are not organising one yet)', type: 'chips', optional: true, options: (events.data ?? []).map((e) => ({ value: e.id, label: e.name })), show: (v) => v.audience === 'event' && !!events.data?.length },
        { key: 'participants', label: 'How many people', type: 'stepper', min: 2, max: 500, default: 10, show: (v) => v.audience !== 'individual' },
        { key: 'sport', label: 'Sport', type: 'sport' },
        { key: 'title', label: 'Headline', hint: 'One line coaches will see first.' },
        { key: 'goal', label: 'Goals and background', type: 'multiline', optional: true },
        { key: 'level', label: 'Level', type: 'chips', options: LEVELS, optional: true },
        { key: 'delivery', label: 'Where', type: 'choice', options: [{ value: 'either', label: 'Either' }, { value: 'in_person', label: 'In person' }, { value: 'online', label: 'Online' }] },
        { key: 'city', label: 'City', optional: true, show: (v) => v.delivery !== 'online' },
        { key: 'budget_max_cents', label: 'Most you would pay per hour', type: 'money', currency, optional: true },
        { key: 'sessions_per_week', label: 'Sessions per week', type: 'stepper', min: 1, max: 14, default: 2 },
        { key: 'preferred_days', label: 'Preferred days', type: 'weekdays', optional: true },
        { key: 'start_by', label: 'Want to start by', type: 'date', min: today, optional: true },
      ]}
      onSubmit={async (v) => { await api.post('/coach-requests', v); await onDone?.(); return 'Posted — coaches see it in Community and on Open positions'; }} />
  );
}

// ================================================================================== HIRE (athlete)
function FindCoaches({ onPost, onBook }) {
  const { push } = useNav();
  const { w } = useCols();
  const [f, setF] = useState({ q: '', sport: null, delivery: null, verified: false, rated: false, hours: false, audience: null, intro: false, sort: 'rating', max: undefined, city: '' });
  const [more, setMore] = useState(false);
  const q = useDebounced(f.q);
  const list = useLoad(() => api.get('/coaches', {
    limit: 50, sort: f.sort, ...(q.trim() ? { q: q.trim() } : {}), ...(f.sport ? { sport: f.sport } : {}), ...(f.delivery ? { delivery: f.delivery } : {}),
    ...(f.verified ? { verified: true } : {}), ...(f.rated ? { min_rating: 4 } : {}), ...(f.hours ? { has_hours: true } : {}), ...(f.audience ? { audience: f.audience } : {}), ...(f.intro ? { intro_offer: true } : {}), ...(f.max ? { max_rate_cents: f.max } : {}), ...(f.city.trim() ? { city: f.city.trim() } : {}),
  }), [q, f.sport, f.delivery, f.verified, f.rated, f.hours, f.audience, f.intro, f.sort, f.max, f.city]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const cur = list.data?.[0]?.currency ?? 'INR';
  const active = [f.max, f.city.trim()].filter(Boolean).length;
  return (
    <View style={{ gap: 12, marginTop: 14 }}>
      <GradCard colors={grad.hero} pad={16}>
        <T color="#fff" weight="800" size={17}>Not sure who to pick?</T>
        <T color="#fff" size={13} style={{ opacity: 0.9, marginTop: 2 }}>Say what you need once. Coaches answer with a rate and a first session, and you choose.</T>
        <Btn small title="Post a request" color={c.paper} ink={c.pink} onPress={onPost} style={{ alignSelf: 'flex-start', marginTop: 10 }} />
      </GradCard>
      <Field value={f.q} onChangeText={(x) => set('q', x)} placeholder="Search by name, speciality or headline…" />
      <SportSelect value={f.sport} onChange={(x) => set('sport', x)} allLabel="All sports" />
      <HScroll>{[[null, 'Anyone'], ...AUDIENCES.map(([v, l]) => [v, `For ${l.toLowerCase()}s`])].map(([v, l]) => <Chip key={l} label={l} active={f.audience === v} onPress={() => set('audience', v)} />)}<Chip label="🎁 Trial offer" active={f.intro} onPress={() => set('intro', !f.intro)} /></HScroll>
      <HScroll>
        {[[null, 'Any place'], ['in_person', 'In person'], ['online', 'Online']].map(([v, l]) => <Chip key={l} label={l} active={f.delivery === v} onPress={() => set('delivery', v)} />)}
        <Chip label="✓ Verified" active={f.verified} onPress={() => set('verified', !f.verified)} />
        <Chip label="★ 4 & up" active={f.rated} onPress={() => set('rated', !f.rated)} />
        <Chip label="📅 Open hours" active={f.hours} onPress={() => set('hours', !f.hours)} />
        <Chip label={active ? `More filters · ${active}` : 'More filters'} active={!!active} onPress={() => setMore(true)} />
      </HScroll>
      <HScroll>{[['rating', 'Top rated'], ['rate', 'Lowest rate'], ['sessions', 'Most sessions'], ['name', 'A–Z']].map(([v, l]) => <Chip key={v} label={`↕ ${l}`} active={f.sort === v} onPress={() => set('sort', v)} />)}</HScroll>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !list.data?.length ? (
        <Empty emoji="🧑‍🏫" title="No coach matches" sub="Loosen a filter, or post a request so coaches can come to you." />
      ) : (
        <Grid>
          {list.data.map((x) => {
            const tone = toneFor(x.sport_slug);
            return (
              <View key={`${x.id}${x.sport_slug}`} style={{ width: w }}>
                <Card pad={14} onPress={() => push('CoachProfile', { id: x.id })}>
                  <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <Avatar user={x} size={52} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <T weight="800" size={15}>{x.display_name}</T>
                      {x.tagline || x.headline ? <T size={12} color={c.mute} numberOfLines={1}>{x.tagline ?? x.headline}</T> : null}
                      <RatingLine avg={x.rating} n={x.rating_count} size={12} />
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                    <Pill label={`${x.sport_emoji} ${x.sport}`} fg={tone[2]} bg={tone[1]} />
                    {x.credential_verified ? <Verified /> : null}
                    <Pill label={DELIVERY[x.delivery].toUpperCase()} />
                    {x.city ? <Pill label={x.city.toUpperCase()} /> : null}
                    {x.has_hours ? <Pill label="📅 OPEN HOURS" /> : null}
                    {x.has_intro ? <Pill label="🎁 TRIAL" fg={c.sun} bg={c.sunSoft} /> : null}
                    {(x.audiences ?? []).filter((a) => a !== 'individual').map((a) => <Pill key={a} label={`${a.toUpperCase()}S`} />)}
                    {x.accepting === false ? <Pill label="FULL" fg={c.red} bg={c.redSoft} /> : null}
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                    <View><T weight="800" size={16}>{rateOf(x, x.currency)}</T><T size={12} color={c.mute}>{[nice(x.level), x.experience_years ? `${x.experience_years} yrs` : null, x.sessions_done ? `${x.sessions_done} sessions` : null].filter(Boolean).join(' · ')}</T></View>
                    <Btn small title="Book" disabled={x.accepting === false} onPress={() => onBook(x)} />
                  </View>
                </Card>
              </View>
            );
          })}
        </Grid>
      )}
      <FormSheet visible={more} onClose={() => setMore(false)} title="More filters" submitLabel="Apply" initial={{ max: f.max, city: f.city }}
        fields={[{ key: 'max', label: 'Most per hour', type: 'money', currency: cur, optional: true }, { key: 'city', label: 'City', optional: true }]}
        onSubmit={async (v) => { setF((p) => ({ ...p, max: v.max, city: v.city ?? '' })); }} />
    </View>
  );
}

function MyRequests({ onPost, reloadOverview }) {
  const { push } = useNav();
  const reqs = useLoad(() => api.get('/coach-requests/mine', { limit: 50 }), []);
  return (
    <View style={{ gap: 10, marginTop: 14 }}>
      <Card color={c.pinkSoft} pad={14}>
        <T weight="800" size={15}>Let coaches come to you</T>
        <T size={13} color={c.mute}>Post your sport, goals, budget and schedule. Verified coaches answer with their rate and a first session; you compare and accept one.</T>
        <Btn small title="+ Post a request" onPress={onPost} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
      </Card>
      {reqs.error ? <ErrorBox error={reqs.error} onRetry={reqs.reload} /> : reqs.loading && !reqs.data ? <Loading /> : !reqs.data?.length ? (
        <Empty emoji="📝" title="No requests yet" sub="Your posted requests and the answers waiting for you show up here." />
      ) : reqs.data.map((r) => (
        <Card key={r.id} pad={14} onPress={() => push('CoachRequest', { id: r.id })}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <T size={26}>{r.sport_emoji}</T>
            <View style={{ flex: 1 }}>
              <T weight="800" size={15}>{r.title}</T>
              <T size={12} color={c.mute}>{[r.sport, r.sessions_per_week ? `${r.sessions_per_week}×/week` : null, r.budget_max_cents ? `up to ${price(r.budget_max_cents, r.currency)}/hr` : null, DELIVERY[r.delivery]].filter(Boolean).join(' · ')}</T>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              <StatusPill s={r.status} />
              {r.pending_responses ? <Pill label={`${r.pending_responses} ANSWER${r.pending_responses === 1 ? '' : 'S'} TO REVIEW`} fg={c.sun} bg={c.sunSoft} /> : r.status === 'open' ? <T size={12} color={c.mute}>Waiting for coaches</T> : null}
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

const paying = (hire, coachName) => ({ type: 'coach_hire', id: hire.id, amount: Number(hire.total_cents), label: `Coaching · ${coachName}` });

function Session({ h, who, children }) {
  const { push } = useNav();
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View style={{ width: 54, alignItems: 'center', backgroundColor: c.pinkSoft, borderRadius: 14, paddingVertical: 6 }}>
          <T size={11} weight="800" color={c.pink}>{new Date(h.starts_at).toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</T>
          <T size={20} weight="800">{new Date(h.starts_at).getDate()}</T>
        </View>
        <View style={{ flex: 1 }}>
          <Pressable onPress={() => h.coach_id && who === 'coach' && push('CoachProfile', { id: h.coach_id })}><T weight="800" size={15}>{who === 'coach' ? h.coach_name : h.athlete_name}</T></Pressable>
          <T size={12} color={c.mute}>{h.sport_emoji} {h.sport} · {dateTimeIn(h.starts_at, deviceTz)} · {h.duration_min} min</T>
          {h.note ? <T size={12} color={c.mute} numberOfLines={2}>“{h.note}”</T> : null}
          {['requested', 'confirmed'].includes(h.status) && new Date(h.starts_at) > new Date() ? <VenueLine venue={h.venue} onBook={() => push('TrainingVenue', { ids: [h.id] })} /> : null}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <StatusPill s={h.status} />
          {h.payment_status === 'unpaid' ? <StatusPill s="unpaid" /> : h.payment_status === 'paid' ? <StatusPill s="paid" /> : null}
        </View>
      </View>
      {children ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>{children}</View> : null}
    </Card>
  );
}

function MyCoaching({ ov, reloadOverview, goFind, goRequests }) {
  const { toast, user } = useSession();
  const { push } = useNav();
  const [payTarget, setPayTarget] = useState(null), [rev, setRev] = useState(null), [cancel, setCancel] = useState(null), [disp, setDisp] = useState(null);
  const ledger = useLoad(() => api.get('/coaching/payments', { as: 'athlete', limit: 30 }), []);
  const a = ov.athlete, cur = ov.currency;
  const reloadAll = () => Promise.all([reloadOverview(), ledger.reload()]);
  const doCancel = async () => { try { await api.patch(`/hires/${cancel.id}`, { status: 'cancelled' }); setCancel(null); await reloadAll(); toast(cancel.payment_status === 'paid' ? 'Cancelled — your payment is refunded' : 'Session cancelled'); } catch (e) { toast(e.message); } };
  const empty = !a.upcoming.length && !ledger.data?.length && !a.to_review.length;
  return (
    <View style={{ gap: 6, marginTop: 14 }}>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Tile value={a.upcoming.length} label="UPCOMING" />
        <Tile value={price(a.spend.due_cents, cur)} label="TO PAY" hot={Number(a.spend.due_cents) > 0} />
        <Tile value={price(a.spend.spent_cents, cur)} label="BOOKED" />
        <Tile value={a.spend.sessions_completed} label="DONE" />
      </View>
      {user.roles.includes('coach') ? <Btn small title="Open my coach desk" color={c.violet} onPress={() => push('CoachDesk')} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
      {a.upcoming.filter((h) => !h.venue).length ? <Card color={c.cyanSoft} pad={12} onPress={() => push('TrainingVenue')} style={{ marginTop: 8 }}><T weight="800">📍 {a.upcoming.filter((h) => !h.venue).length} upcoming session{a.upcoming.filter((h) => !h.venue).length === 1 ? '' : 's'} without a court</T><T size={12} color={c.mute}>Book one venue for several sessions at once, or a court per session. The coach is told.</T></Card> : null}
      {empty ? <View style={{ marginTop: 10 }}><Empty emoji="🧑‍🏫" title="No coaching yet" sub="Book a coach or post a request. Your sessions, payments and reviews all live here." /><Btn small title="Find a coach" onPress={goFind} style={{ alignSelf: 'center' }} /></View> : null}

      {a.awaiting_payment.length || a.to_review.length || a.requests.new_answers ? (
        <Section title="Needs you">
          {a.requests.new_answers ? <Card color={c.sunSoft} pad={12} onPress={goRequests}><T weight="800">{a.requests.new_answers} coach answer{a.requests.new_answers === 1 ? '' : 's'} waiting</T><T size={12} color={c.mute}>Open “My requests” to compare and choose.</T></Card> : null}
          {a.awaiting_payment.map((h) => <Session key={h.id} h={h} who="coach"><Btn small title={`Pay ${price(h.total_cents, cur)}`} onPress={() => setPayTarget(paying(h, h.coach_name))} /></Session>)}
          {a.to_review.map((h) => <Session key={h.id} h={h} who="coach"><Btn small title="★ Rate this session" onPress={() => setRev(h)} /></Session>)}
        </Section>
      ) : null}

      {a.upcoming.length ? (
        <Section title="Your schedule">
          {a.upcoming.map((h) => (
            <Session key={h.id} h={h} who="coach">
              {h.payment_status === 'unpaid' ? <Btn small title={`Pay ${price(h.total_cents, cur)}`} onPress={() => setPayTarget(paying(h, h.coach_name))} /> : null}
              <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setCancel(h)} />
            </Session>
          ))}
          {a.plan_sessions.map((p) => <Card key={p.id} pad={12} onPress={() => push('CoachPlan', { id: p.plan_id })}><T weight="700">{p.title}</T><T size={12} color={c.mute}>Training plan with {p.coach_name} · {dateTimeIn(p.starts_at, deviceTz)}</T></Card>)}
        </Section>
      ) : null}

      <Section title="Payments">
        {ledger.error ? <ErrorBox error={ledger.error} onRetry={ledger.reload} /> : ledger.loading && !ledger.data ? <Loading /> : !ledger.data?.length ? <T size={13} color={c.mute}>Nothing paid or due yet.</T> : (
          <>
            {Number(a.spend.refunded_cents) > 0 ? <T size={12} color={c.mute}>Refunded to you so far: {price(a.spend.refunded_cents, cur)}</T> : null}
            {ledger.data.map((p) => (
              <Card key={p.id} pad={12}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <T weight="700">{p.counterparty_name}</T>
                    <T size={12} color={c.mute}>{p.sport_emoji} {p.sport} · {dateTimeIn(p.starts_at, deviceTz)}{p.paid_at ? ` · paid ${new Date(p.paid_at).toLocaleDateString()}` : ''}{p.refunded_at ? ` · refunded ${new Date(p.refunded_at).toLocaleDateString()}` : ''}</T>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <T weight="800">{price(p.total_cents, p.currency)}</T>
                    <StatusPill s={p.status === 'cancelled' && p.payment_status === 'unpaid' ? 'cancelled' : p.payment_status === 'not_required' ? 'pay_direct' : p.payment_status} />
                  </View>
                </View>
                {p.payment_status === 'unpaid' && p.status !== 'cancelled' ? <View style={{ marginTop: 8, flexDirection: 'row' }}><Btn small title="Pay now" onPress={() => setPayTarget(paying(p, p.counterparty_name))} /></View> : null}
                {p.payment_status === 'paid' ? <Pressable onPress={() => setDisp(p)} style={{ marginTop: 6 }}><T size={12} weight="700" color={c.mute}>Payment problem?</T></Pressable> : null}
              </Card>
            ))}
          </>
        )}
      </Section>

      {payTarget ? <PaySheet target={payTarget} onClose={() => setPayTarget(null)} onDone={reloadAll} /> : null}
      {rev ? <ReviewSheet hire={rev} onClose={() => setRev(null)} onDone={reloadAll} /> : null}
      <Confirm visible={!!cancel} title="Cancel this session?" yes="Cancel session" danger onClose={() => setCancel(null)} onYes={doCancel}
        body={cancel ? `${cancel.coach_name} will be told.${cancel.payment_status === 'paid' ? ' Your payment is refunded.' : ''}` : ''} />
      <NewCaseSheet visible={!!disp} onClose={() => setDisp(null)} kind="dispute" category="provider_payment" links={disp ? [{ type: 'coach_hire', id: disp.id }] : []} />
    </View>
  );
}

function Providers() {
  const { toast } = useSession();
  const [book, setBook] = useState(null);
  const [pf, setPf] = useState({ type: '', remote: false, verified: false, sort: 'rating', q: '' });
  const provs = useLoad(() => api.get('/providers/search', { limit: 50, sort: pf.sort, ...(pf.type ? { type: pf.type } : {}), ...(pf.remote ? { remote: true } : {}), ...(pf.verified ? { verified: true } : {}), ...(pf.q.trim() ? { q: pf.q.trim() } : {}) }), [pf.type, pf.remote, pf.verified, pf.sort, pf.q]);
  const appts = useLoad(() => api.get('/appointments', { limit: 30 }), []);
  const setAppt = async (a, status) => { try { await api.patch(`/appointments/${a.id}`, { status }); await appts.reload(); toast(`Appointment ${status}`); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 10, marginTop: 14 }}>
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
              <T size={12} color={c.mute}>{[nice(x.provider_type), x.clinic, x.city, x.remote_ok ? 'remote' : null].filter(Boolean).join(' · ')}</T>
              {x.headline ? <T size={12}>{x.headline}</T> : null}
              <T size={12} color={c.mute}>{[x.rating ? `★ ${Number(x.rating).toFixed(1)} (${x.rating_count})` : 'No reviews yet', x.fee_cents ? `${price(x.fee_cents, x.currency)}` : 'Fee on request', x.accepting_patients === false ? 'not taking new patients' : null].filter(Boolean).join(' · ')}</T>
            </View>
            <Btn small title="Book" disabled={x.accepting_patients === false} onPress={() => setBook(x)} />
          </View>
        </Card>
      ))}
      <H2 style={{ marginTop: 14 }}>My appointments</H2>
      {!appts.data?.length ? <T size={13} color={c.mute}>No appointments yet.</T> : appts.data.map((a) => (
        <Card key={a.id} pad={14}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T weight="800" size={15}>Appointment · {a.provider_name}</T><T size={12} color={c.mute}>{dateTimeIn(a.starts_at, deviceTz)} · {a.duration_min} min{a.reason ? ` · ${a.reason}` : ''}</T></View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              <StatusPill s={a.status} />
              {['requested', 'confirmed'].includes(a.status) ? <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setAppt(a, 'cancelled')} /> : null}
            </View>
          </View>
        </Card>
      ))}
      {book ? <BookProviderSheet provider={book} onClose={() => setBook(null)} onDone={appts.reload} /> : null}
    </View>
  );
}

export function Hire() {
  const [tab, setTab] = useState('find');
  const [post, setPost] = useState(false), [book, setBook] = useState(null), [paying2, setPaying] = useState(null);
  const ov = useLoad(() => api.get('/coaching/overview'), []);
  const o = ov.data;
  const waiting = o?.athlete.requests.new_answers ?? 0, todo = o ? o.athlete.awaiting_payment.length + o.athlete.to_review.length : 0;
  const tabs = [
    { value: 'find', label: 'Find a coach' },
    { value: 'requests', label: waiting ? `My requests · ${waiting} new` : 'My requests' },
    { value: 'mine', label: todo ? `My coaching · ${todo}` : 'My coaching' },
    { value: 'med', label: 'Physios & doctors' },
  ];
  return (
    <Screen wide onRefresh={ov.reload}>
      <Head eyebrow="HIRE" title="Build your team around you" sub="Find a coach, or post what you need and let coaches come to you." />
      <View style={{ marginTop: 14 }}><Seg options={tabs} value={tab} onChange={setTab} /></View>
      {tab === 'find' ? <FindCoaches onPost={() => setPost(true)} onBook={setBook} /> : null}
      {tab === 'requests' ? <MyRequests onPost={() => setPost(true)} reloadOverview={ov.reload} /> : null}
      {tab === 'mine' ? (ov.error ? <ErrorBox error={ov.error} onRetry={ov.reload} /> : !o ? <Loading /> : <MyCoaching ov={o} reloadOverview={ov.reload} goFind={() => setTab('find')} goRequests={() => setTab('requests')} />) : null}
      {tab === 'med' ? <Providers /> : null}
      <PostRequestSheet visible={post} onClose={() => setPost(false)} currency={o?.currency} onDone={async () => { await ov.reload(); setTab('requests'); }} />
      {book ? <BookCoachSheet coach={book} onClose={() => setBook(null)} onDone={async (hire) => { await ov.reload(); setTab('mine'); if (hire.payment_status === 'unpaid') setPaying(paying(hire, book.display_name)); }} /> : null}
      {paying2 ? <PaySheet target={paying2} onClose={() => setPaying(null)} onDone={ov.reload} /> : null}
    </Screen>
  );
}

// ================================================================================== COACH PROFILE
export function CoachProfile({ id }) {
  const { user } = useSession();
  const { push } = useNav();
  const d = useLoad(() => api.get(`/coaches/${id}`), [id]);
  const [sport, setSport] = useState(null), [book, setBook] = useState(false), [paying2, setPaying] = useState(null);
  const p = d.data;
  if (d.loading && !p) return <Screen><Loading /></Screen>;
  if (d.error) return <Screen><ErrorBox error={d.error} onRetry={d.reload} /></Screen>;
  const mine = user.id === p.id, cur = p.currency;
  const sp = p.sports.find((x) => x.slug === sport) ?? p.sports[0];
  const verified = p.verified.some((b) => b.type === 'coach');
  const hoursByDay = DAY_ORDER.map((wd) => [wd, p.hours.windows.filter((x) => x.weekday === wd)]).filter(([, l]) => l.length);
  const maxN = Math.max(1, ...p.rating.breakdown.map((b) => b.count));
  return (
    <Screen onRefresh={d.reload}>
      <GradCard colors={grad.hero} style={{ marginTop: 8 }}>
        <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
          <Avatar user={p} size={72} />
          <View style={{ flex: 1, gap: 4 }}>
            <T color="#fff" weight="800" size={22}>{p.display_name}</T>
            {p.profile.tagline ?? p.profile.headline ? <T color="#fff" size={13} style={{ opacity: 0.9 }}>{p.profile.tagline ?? p.profile.headline}</T> : null}
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{verified ? <Verified /> : null}{p.profile.city ? <Pill label={p.profile.city.toUpperCase()} /> : null}<Pill label={DELIVERY[p.profile.delivery].toUpperCase()} /></View>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <Tile value={p.rating.count ? Number(p.rating.avg).toFixed(1) : '—'} label="RATING" />
          <Tile value={p.stats.sessions_done} label="SESSIONS" />
          <Tile value={p.stats.athletes} label="ATHLETES" />
          <Tile value={sp?.hourly_rate_cents ? price(sp.hourly_rate_cents, cur) : '—'} label="PER HOUR" />
        </View>
      </GradCard>

      <Section title="About">
        <T size={14}>{p.profile.about ?? p.bio ?? 'This coach has not written an introduction yet.'}</T>
        {p.profile.specialties?.length ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{p.profile.specialties.map((s) => <Pill key={s} label={s.toUpperCase()} />)}</View> : null}
        {p.profile.languages?.length ? <T size={12} color={c.mute}>Speaks {p.profile.languages.join(', ')}</T> : null}
      </Section>

      {p.rate_cards.length ? (
        <Section title="Services & prices">
          {p.rate_cards.map((k) => (
            <Card key={k.id} pad={12}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <View style={{ flex: 1 }}><T weight="800">{k.title}</T><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}><Pill label={`FOR ${k.audience.toUpperCase()}`} />{k.is_intro ? <Pill label="🎁 TRIAL OFFER" fg={c.sun} bg={c.sunSoft} /> : null}{k.sport ? <Pill label={k.sport.toUpperCase()} /> : null}</View></View>
                <T weight="800" size={15}>{cardPrice(k, cur)}</T>
              </View>
              <T size={12} color={c.mute} style={{ marginTop: 4 }}>{[k.duration_min && k.unit !== 'hour' ? `${k.duration_min} min` : null, k.audience !== 'individual' ? `${k.min_participants}${k.max_participants ? `–${k.max_participants}` : '+'} people` : null, k.sessions_included ? `${k.sessions_included} sessions` : null, DELIVERY[k.delivery]].filter(Boolean).join(' · ')}</T>
              {k.description ? <T size={13} style={{ marginTop: 4 }}>{k.description}</T> : null}
            </Card>
          ))}
        </Section>
      ) : null}
      {p.specialisations.length ? (
        <Section title="Specialisations">
          {p.specialisations.map((z) => <Card key={z.id} pad={12}><T weight="800">{z.emoji} {z.name}</T><T size={12} color={c.mute}>{[z.sport, z.levels.length ? `for ${z.levels.map(nice).join(', ')}` : null, z.years != null ? `${z.years} yrs` : null, z.certification].filter(Boolean).join(' · ')}</T></Card>)}
        </Section>
      ) : null}
      {p.profile.intro_video_url ? <Btn small title="▶ Watch introduction" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(p.profile.intro_video_url)} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
      <Section title="Sports & rates">
        {p.sports.map((s) => (
          <Card key={s.slug} pad={12} color={sp?.slug === s.slug && p.sports.length > 1 ? c.pinkSoft : c.paper} onPress={() => setSport(s.slug)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T size={24}>{s.emoji}</T>
              <View style={{ flex: 1 }}><T weight="800">{s.name}</T><T size={12} color={c.mute}>{[nice(s.level), s.experience_years ? `${s.experience_years} yrs` : null, s.club].filter(Boolean).join(' · ')}</T></View>
              <T weight="800">{rateOf(s, cur)}</T>
            </View>
          </Card>
        ))}
      </Section>

      <Section title="Weekly hours">
        {hoursByDay.length ? (
          <Card pad={12}>
            {hoursByDay.map(([wd, list]) => <View key={wd} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T weight="700">{WEEKDAYS[wd]}</T><T color={c.mute}>{list.map((x) => `${x.start}–${x.end}`).join(', ')}</T></View>)}
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>{p.hours.timezone}{p.next_available_at ? ` · next open ${dateTimeIn(p.next_available_at, p.hours.timezone)}` : ''}</T>
          </Card>
        ) : <T size={13} color={c.mute}>No fixed hours yet. Propose a time and the coach will confirm it.</T>}
      </Section>

      <Section title={`Reviews${p.rating.count ? ` · ${Number(p.rating.avg).toFixed(1)} ★` : ''}`}>
        {p.rating.count ? (
          <Card pad={12}>
            {p.rating.breakdown.map((b) => (
              <View key={b.rating} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}>
                <T size={12} weight="700" style={{ width: 24 }}>{b.rating}★</T>
                <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: c.violetSoft }}><View style={{ width: `${(100 * b.count) / maxN}%`, height: 8, borderRadius: 4, backgroundColor: c.sun }} /></View>
                <T size={12} color={c.mute} style={{ width: 24, textAlign: 'right' }}>{b.count}</T>
              </View>
            ))}
          </Card>
        ) : <T size={13} color={c.mute}>No reviews yet. Reviews come only from athletes who finished a session.</T>}
        {p.reviews.map((r) => (
          <Card key={r.id} pad={12}>
            {r.pinned ? <T size={11} weight="800" color={c.sun} style={{ marginBottom: 4 }}>📌 PINNED BY THE COACH</T> : null}
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Avatar user={{ avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color, avatar_url: r.avatar_url, display_name: r.author_name }} size={34} />
              <View style={{ flex: 1 }}><T weight="700">{r.author_name}</T><Stars value={r.rating} size={12} /></View>
              <T size={11} color={c.mute}>{new Date(r.created_at).toLocaleDateString()}</T>
            </View>
            {r.body ? <T size={13} style={{ marginTop: 6 }}>{r.body}</T> : null}
            {r.reply ? <View style={{ marginTop: 8, backgroundColor: c.violetSoft, borderRadius: 10, padding: 10 }}><T size={12} weight="800" color={c.mute}>Reply from {p.display_name}</T><T size={13}>{r.reply}</T></View> : null}
          </Card>
        ))}
      </Section>

      <View style={{ marginTop: 16, gap: 8 }}>
        {mine ? <Btn title="Edit my profile & hours" onPress={() => push('CoachSetup')} /> : <Btn title={p.profile.accepting === false ? 'Not taking new athletes' : `Book a ${sp?.name ?? ''} session`} disabled={p.profile.accepting === false || !sp} onPress={() => setBook(true)} />}
      </View>
      {book && sp ? <BookCoachSheet coach={{ id: p.id, display_name: p.display_name, sport_slug: sp.slug, sport: sp.name, sport_emoji: sp.emoji, hourly_rate_cents: sp.hourly_rate_cents, currency: cur }} onClose={() => setBook(false)}
        onDone={async (hire) => { if (hire.payment_status === 'unpaid') setPaying(paying(hire, p.display_name)); else push('CoachDesk'); }} /> : null}
      {paying2 ? <PaySheet target={paying2} onClose={() => setPaying(null)} onDone={async () => {}} /> : null}
    </Screen>
  );
}

// ================================================================================== A REQUEST AND ITS ANSWERS
const answerTags = (all) => {
  const open = all.filter((x) => x.status === 'pending');
  const tags = new Map();
  const add = (x, t) => tags.set(x.id, [...(tags.get(x.id) ?? []), t]);
  if (open.length > 1) {
    const low = Math.min(...open.map((x) => Number(x.rate_cents_hour)));
    open.filter((x) => Number(x.rate_cents_hour) === low).forEach((x) => add(x, 'Lowest rate'));
    const rated = open.filter((x) => x.rating);
    if (rated.length) { const top = Math.max(...rated.map((x) => x.rating)); rated.filter((x) => x.rating === top).forEach((x) => add(x, 'Top rated')); }
    const most = Math.max(...open.map((x) => x.sessions_done));
    if (most > 0) open.filter((x) => x.sessions_done === most).forEach((x) => add(x, 'Most experienced'));
  }
  return tags;
};

function RespondSheet({ r, mine, onClose, onDone }) {
  const today = todayIn(deviceTz);
  const { push } = useNav();
  const cards = useLoad(() => api.get('/coach/rate-cards'), []);
  const fit = (cards.data ?? []).filter((k) => k.active && k.audience === r.audience && (!k.sport_slug || k.sport_slug === r.sport_slug));
  if (cards.loading && !cards.data) return <Sheet visible onClose={onClose} title="Answer"><Loading /></Sheet>;
  if (r.audience !== 'individual' && !fit.length) {
    return (
      <Sheet visible onClose={onClose} title="Add a rate card first">
        <T size={14} color={c.mute}>This request is for a {r.audience}. Quote one of your {r.audience} rate cards so the price is clear. You have none for {r.sport} yet.</T>
        <Btn title={`Create a ${r.audience} rate card`} onPress={() => { onClose(); push('CoachRates'); }} />
      </Sheet>
    );
  }
  const byId = Object.fromEntries(fit.map((k) => [k.id, k]));
  return (
    <FormSheet visible onClose={onClose} title={mine ? 'Update your answer' : `Answer: ${r.title}`} submitLabel={mine ? 'Update answer' : 'Send answer'} initial={{ duration_min: mine?.duration_min ?? 60, rate_cents_hour: mine && !mine.rate_card_id ? Number(mine.rate_cents_hour) : undefined, rate_card_id: mine?.rate_card_id ?? undefined }}
      fields={[
        ...(fit.length ? [{ key: 'rate_card_id', label: 'Quote from your rate cards', type: 'chips', optional: r.audience === 'individual', options: fit.map((k) => ({ value: k.id, label: `${k.title} · ${cardPrice(k, r.currency)}` })) }] : []),
        { key: 'rate_cents_hour', label: 'Your rate per hour', type: 'money', currency: r.currency, optional: true, hint: 'Leave empty to use your profile rate for this sport.', show: (v) => !v.rate_card_id },
        { key: 'date', label: 'First session: date', type: 'date', min: today },
        { key: 'time', label: 'First session: start time', type: 'time', step: 15 },
        { key: 'duration_min', label: 'Session length', type: 'stepper', min: 15, max: 480, step: 15, default: 60, suffix: ' min', show: (v) => !v.rate_card_id || byId[v.rate_card_id]?.unit === 'hour' },
        { key: 'message', label: 'Message to the athlete', type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => { await api.post(`/coach-requests/${r.id}/respond`, { starts_at: localToIso(v.date, v.time, deviceTz), ...(v.duration_min ? { duration_min: v.duration_min } : {}), ...(v.rate_card_id ? { rate_card_id: v.rate_card_id } : v.rate_cents_hour !== undefined ? { rate_cents_hour: v.rate_cents_hour } : {}), ...(v.message ? { message: v.message } : {}) }); await onDone(); return 'Answer sent — the athlete has been told'; }} />
  );
}

/** A person who wants to coach a sport: adds it as a coaching profile with their hourly rate. Also makes them a coach. */
export function AddCoachSportSheet({ visible, onClose, onDone, initialSport, currency = 'INR' }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title="Coach this sport" submitLabel="Add and continue" initial={{ sport: initialSport, level: 'amateur', experience_years: 1 }}
      fields={[
        { key: 'sport', label: 'Sport', type: 'sport' },
        { key: 'level', label: 'Level you coach at', type: 'chips', options: LEVELS },
        { key: 'hourly_rate_cents', label: 'Your usual rate per hour', type: 'money', currency, optional: true, hint: 'You can add rate cards for groups, teams and events later.' },
        { key: 'experience_years', label: 'Years coaching', type: 'stepper', min: 0, max: 60, default: 1 },
      ]}
      onSubmit={async (v) => { await api.post('/me/sport-profiles', { ...v, role: 'coach' }); await onDone?.(); return 'You can now answer requests in this sport'; }} />
  );
}

export function CoachRequest({ id }) {
  const { toast, refresh } = useSession();
  const { push, goTab } = useNav();
  const q = useLoad(() => api.get(`/coach-requests/${id}`), [id]);
  const [addSport, setAddSport] = useState(false);
  const [accept, setAccept] = useState(null), [closing, setClosing] = useState(false), [respond, setRespond] = useState(false), [paying2, setPaying] = useState(null), [withdraw, setWithdraw] = useState(null);
  const r = q.data;
  if (q.loading && !r) return <Screen><Loading /></Screen>;
  if (q.error) return <Screen><ErrorBox error={q.error} onRetry={q.reload} /></Screen>;
  const tags = answerTags(r.responses);
  const cur = r.currency;
  const decide = async (x, decision) => {
    try {
      const out = await api.post(`/coach-responses/${x.id}/decision`, { decision });
      setAccept(null); await q.reload();
      if (decision === 'accept') { toast(out.hire.payment_status === 'unpaid' ? 'Session reserved — pay to confirm it' : 'Booked — see it in My coaching'); if (out.hire.payment_status === 'unpaid') setPaying(paying(out.hire, x.display_name)); } else toast('Declined');
    } catch (e) { toast(e.message); setAccept(null); }
  };
  const close = async () => { try { await api.post(`/coach-requests/${r.id}/close`); setClosing(false); await q.reload(); toast('Request closed'); } catch (e) { toast(e.message); } };
  return (
    <Screen onRefresh={q.reload}>
      <Card pad={16} style={{ marginTop: 8 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <T size={30}>{r.sport_emoji}</T>
          <View style={{ flex: 1 }}><T weight="800" size={18}>{r.title}</T><T size={12} color={c.mute}>{r.sport}{r.level ? ` · ${nice(r.level)}` : ''}</T>{audienceTag(r) ? <View style={{ marginTop: 4 }}><Pill label={`FOR ${audienceTag(r).toUpperCase()}`} fg={c.pink} bg={c.pinkSoft} /></View> : null}</View>
          <StatusPill s={r.status} />
        </View>
        {r.goal ? <T size={14} style={{ marginTop: 10 }}>{r.goal}</T> : null}
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          <Pill label={DELIVERY[r.delivery].toUpperCase()} />
          {r.city ? <Pill label={r.city.toUpperCase()} /> : null}
          {r.budget_max_cents ? <Pill label={`UP TO ${price(r.budget_max_cents, cur)}/HR`.toUpperCase()} /> : null}
          {r.sessions_per_week ? <Pill label={`${r.sessions_per_week}×/WEEK`} /> : null}
          {r.preferred_days?.length ? <Pill label={r.preferred_days.map((d) => WEEKDAYS[d]).join(' ').toUpperCase()} /> : null}
          {r.start_by ? <Pill label={`START BY ${new Date(`${r.start_by}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }).toUpperCase()}`} /> : null}
        </View>
        {!r.i_am_owner ? <T size={12} color={c.mute} style={{ marginTop: 10 }}>Posted by {r.athlete_display_name}</T> : null}
      </Card>

      {r.i_am_owner ? (
        <Section title={`Answers · ${r.responses.length}`}>
          {!r.responses.length ? <Empty emoji="⏳" title="No answers yet" sub={r.status === 'open' ? 'Coaches of this sport have been told. Answers appear here as they arrive.' : 'This request had no answers.'} /> : null}
          {r.responses.map((x) => (
            <Card key={x.id} pad={14} color={x.status === 'accepted' ? c.limeSoft : c.paper}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <Avatar user={x} size={48} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T weight="800" size={15}>{x.display_name}</T>
                  <RatingLine avg={x.rating} n={x.rating_count} size={12} />
                  <T size={12} color={c.mute}>{x.sessions_done} session{x.sessions_done === 1 ? '' : 's'} coached</T>
                </View>
                <View style={{ alignItems: 'flex-end' }}><T weight="800" size={16}>{price(x.rate_cents_hour, cur)}/hr</T>{x.status !== 'pending' ? <StatusPill s={x.status} /> : null}</View>
              </View>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {x.credential_verified ? <Verified /> : null}
                {(tags.get(x.id) ?? []).map((t) => <Pill key={t} label={t.toUpperCase()} fg={c.pink} bg={c.pinkSoft} />)}
              </View>
              <T size={13} style={{ marginTop: 8 }}>First session <T weight="800" size={13}>{dateTimeIn(x.proposed_starts_at, deviceTz)}</T> · {x.duration_min} min · {price(x.first_session_cents, cur)}</T>
              {x.message ? <T size={13} color={c.mute} style={{ marginTop: 4 }}>“{x.message}”</T> : null}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {x.status === 'pending' && r.status === 'open' ? <Btn small title="Accept & book" onPress={() => setAccept(x)} /> : null}
                {x.status === 'pending' && r.status === 'open' ? <Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => decide(x, 'decline')} /> : null}
                <Btn small title="View profile" color={c.paper} ink={c.ink} onPress={() => push('CoachProfile', { id: x.coach_id })} />
              </View>
            </Card>
          ))}
          {r.status === 'open' ? <Btn small title="Close this request" color={c.paper} ink={c.red} onPress={() => setClosing(true)} style={{ alignSelf: 'flex-start' }} /> : null}
          {r.status === 'filled' ? <Btn small title="Go to my coaching" onPress={() => goTab('Player')} style={{ alignSelf: 'flex-start' }} /> : null}
        </Section>
      ) : (
        <Section title="Your answer">
          {r.my_response ? (
            <Card pad={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T weight="800" size={16}>{price(r.my_response.rate_cents_hour, cur)}/hr</T><StatusPill s={r.my_response.status} /></View>
              <T size={13} style={{ marginTop: 6 }}>First session {dateTimeIn(r.my_response.proposed_starts_at, deviceTz)} · {r.my_response.duration_min} min</T>
              {r.my_response.message ? <T size={13} color={c.mute}>“{r.my_response.message}”</T> : null}
              {r.my_response.status === 'pending' && r.status === 'open' ? (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}><Btn small title="Edit answer" onPress={() => setRespond(true)} /><Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => setWithdraw(r.my_response)} /></View>
              ) : null}
              {r.my_response.status === 'accepted' ? <Btn small title="Open coach desk" onPress={() => push('CoachDesk')} style={{ alignSelf: 'flex-start', marginTop: 10 }} /> : null}
            </Card>
          ) : r.status !== 'open' ? <T size={13} color={c.mute}>This request is no longer open.</T> : !r.can_respond?.is_coach || !r.can_respond?.coaches_this_sport ? (
            <Card color={c.sunSoft} pad={14}>
              <T weight="800">{!r.can_respond?.is_coach ? 'Only coaches can answer' : `You do not coach ${r.sport} yet`}</T>
              <T size={13} color={c.mute}>Add {r.sport} as a coaching sport with your rate and you can answer straight away. It takes a minute.</T>
              <Btn small title={`Coach ${r.sport}`} onPress={() => setAddSport(true)} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
            </Card>
          ) : <Btn title="Answer this request" onPress={() => setRespond(true)} />}
        </Section>
      )}

      <Confirm visible={!!accept} title={`Book ${accept?.display_name ?? ''}?`} yes="Accept & book" onClose={() => setAccept(null)} onYes={() => decide(accept, 'accept')}
        body={accept ? `First session ${dateTimeIn(accept.proposed_starts_at, deviceTz)} for ${price(accept.first_session_cents, cur)}. The coach has already agreed, so it is confirmed as soon as you pay. Other coaches are told you chose someone else.` : ''} />
      <Confirm visible={closing} title="Close this request?" yes="Close request" danger onClose={() => setClosing(false)} onYes={close} body="Coaches with pending answers are told. The request stays in your history." />
      <Confirm visible={!!withdraw} title="Withdraw your answer?" yes="Withdraw" danger onClose={() => setWithdraw(null)} body="The athlete will no longer see it."
        onYes={async () => { try { await api.post(`/coach-responses/${withdraw.id}/withdraw`); setWithdraw(null); await q.reload(); toast('Answer withdrawn'); } catch (e) { toast(e.message); } }} />
      <AddCoachSportSheet visible={addSport} onClose={() => setAddSport(false)} initialSport={r.sport_slug} currency={r.currency} onDone={async () => { await refresh(); await q.reload(); }} />
      {respond ? <RespondSheet r={r} mine={r.my_response?.status === 'pending' ? r.my_response : null} onClose={() => setRespond(false)} onDone={q.reload} /> : null}
      {paying2 ? <PaySheet target={paying2} onClose={() => setPaying(null)} onDone={q.reload} /> : null}
    </Screen>
  );
}

// ================================================================================== COACH SIDE
/** Open coaching requests as cards. Coaches see their own sports first; `defaultAll` shows every sport (Open positions). */
export function CoachRequestList({ defaultAll = false }) {
  const { push } = useNav();
  const [all, setAll] = useState(defaultAll), [sport, setSport] = useState(null);
  const q = useLoad(() => api.get('/coach-requests', { limit: 50, ...(sport ? { sport } : {}), ...(all ? { all_sports: true } : {}) }), [all, sport]);
  return (
    <View>
      <View style={{ marginTop: 12, gap: 8 }}>
        <SportSelect value={sport} onChange={setSport} allLabel={defaultAll ? 'All sports' : 'My sports'} />
        {!sport && !defaultAll ? <View style={{ flexDirection: 'row' }}><Chip label="Include sports I do not coach" active={all} onPress={() => setAll(!all)} /></View> : null}
      </View>
      <View style={{ gap: 10, marginTop: 12 }}>
        {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : q.loading && !q.data ? <Loading /> : !q.data?.length ? (
          <Empty emoji="📭" title="No open requests" sub="Athletes, groups, teams and events looking for a coach appear here, and coaches of the sport are notified." />
        ) : q.data.map((r) => (
          <Card key={r.id} pad={14} onPress={() => push('CoachRequest', { id: r.id })}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <Avatar user={{ avatar_emoji: r.athlete_avatar_emoji, avatar_color: r.athlete_avatar_color, avatar_url: r.athlete_avatar_url, handle: r.athlete_handle, display_name: r.athlete_display_name }} size={44} />
              <View style={{ flex: 1 }}>
                <T weight="800" size={15}>{r.title}</T>
                <T size={12} color={c.mute}>{[r.athlete_display_name, `${r.sport_emoji} ${r.sport}`, audienceTag(r), r.level ? nice(r.level) : null, r.city, DELIVERY[r.delivery]].filter(Boolean).join(' · ')}</T>
                <T size={12} color={c.mute}>{[r.sessions_per_week ? `${r.sessions_per_week}×/week` : null, r.budget_max_cents ? `up to ${price(r.budget_max_cents, r.currency)}/hr` : null, `${r.responses} answer${r.responses === 1 ? '' : 's'} so far`].filter(Boolean).join(' · ')}</T>
              </View>
              {r.my_response ? <StatusPill s={r.my_response.status} /> : <Btn small title="View & answer" onPress={() => push('CoachRequest', { id: r.id })} />}
            </View>
          </Card>
        ))}
      </View>
    </View>
  );
}

export function CoachBoard() {
  return (
    <Screen>
      <Head eyebrow="COACH" title="Request board" sub="Athletes, groups, teams and events looking for a coach. Answer with your rate and a first session; they choose." />
      <CoachRequestList />
    </Screen>
  );
}

export function CoachDesk() {
  const { toast, user } = useSession();
  const { push } = useNav();
  const ov = useLoad(() => api.get('/coaching/overview'), []);
  const ledger = useLoad(() => api.get('/coaching/payments', { as: 'coach', limit: 30 }), []);
  const [reply, setReply] = useState(null), [act, setAct] = useState(null);
  const o = ov.data;
  if (ov.loading && !o) return <Screen><Loading /></Screen>;
  if (ov.error) return <Screen><ErrorBox error={ov.error} onRetry={ov.reload} /></Screen>;
  if (!o.coach) return <Screen><Empty emoji="🧑‍🏫" title="This is for coaches" sub="Add the coach role in your profile to take bookings." /></Screen>;
  const k = o.coach, cur = o.currency;
  const reloadAll = () => Promise.all([ov.reload(), ledger.reload()]);
  const move = async () => {
    try { await api.patch(`/hires/${act.h.id}`, { status: act.status }); setAct(null); await reloadAll(); toast({ confirmed: 'Confirmed', completed: 'Marked complete — the athlete can now review', cancelled: 'Declined' }[act.status]); } catch (e) { toast(e.message); setAct(null); }
  };
  return (
    <Screen wide onRefresh={reloadAll}>
      <Head eyebrow="COACH" title="Coach desk" sub="Confirm sessions, track earnings and answer reviews." right={<Btn small title="Profile & hours" color={c.violet} onPress={() => push('CoachSetup')} />} />
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <Tile value={k.upcoming.length} label="UPCOMING" />
        <Tile value={k.to_confirm.length} label="TO CONFIRM" hot={k.to_confirm.length > 0} />
        <Tile value={price(k.earnings.earned_cents, cur)} label="EARNED" />
        <Tile value={price(k.earnings.awaiting_payment_cents, cur)} label="AWAITING PAYMENT" />
        <Tile value={k.rating.n ? `${Number(k.rating.avg).toFixed(1)}★` : '—'} label="RATING" />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn small title={k.board_open ? `Request board · ${k.board_open} open` : 'Request board'} onPress={() => push('CoachBoard')} />
        <Btn small title="Schedule" color={c.paper} ink={c.ink} onPress={() => push('CoachCalendar')} />
        <Btn small title="Commitments" color={c.paper} ink={c.ink} onPress={() => push('CoachCommitments')} />
        <Btn small title="Rate cards" color={c.paper} ink={c.ink} onPress={() => push('CoachRates')} />
        <Btn small title="Reviews" color={c.paper} ink={c.ink} onPress={() => push('CoachReviews')} />
        <Btn small title="Analytics" color={c.paper} ink={c.ink} onPress={() => push('CoachAnalytics')} />
        <Btn small title="My athletes" color={c.paper} ink={c.ink} onPress={() => push('CoachAthletes')} />
        <Btn small title="My public profile" color={c.paper} ink={c.ink} onPress={() => push('CoachProfile', { id: user.id })} />
      </View>

      {k.upcoming.filter((h) => h.status === 'confirmed' && !h.venue).length ? <Card color={c.cyanSoft} pad={12} onPress={() => push('TrainingVenue')} style={{ marginTop: 12 }}><T weight="800">📍 {k.upcoming.filter((h) => h.status === 'confirmed' && !h.venue).length} confirmed session{k.upcoming.filter((h) => h.status === 'confirmed' && !h.venue).length === 1 ? '' : 's'} without a court</T><T size={12} color={c.mute}>Book a venue for them in one go; the athlete or team is told.</T></Card> : null}
      {k.to_confirm.length ? (
        <Section title="To confirm">
          {k.to_confirm.map((h) => (
            <Session key={h.id} h={{ ...h, athlete_name: h.athlete_name }} who="athlete">
              {h.payment_status === 'unpaid'
                ? <T size={12} color={c.mute}>Waiting for {h.athlete_name} to pay, then you can confirm.</T>
                : <Btn small title="Confirm" onPress={() => setAct({ h, status: 'confirmed' })} />}
              <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => setAct({ h, status: 'cancelled' })} />
            </Session>
          ))}
        </Section>
      ) : null}

      <Section title="Upcoming sessions">
        {!k.upcoming.length ? <Empty emoji="🗓️" title="Nothing booked yet" sub="Keep your hours and rate up to date, and answer requests on the board." /> : k.upcoming.filter((h) => h.status === 'confirmed').map((h) => (
          <Session key={h.id} h={h} who="athlete">
            <Btn small title="Mark complete" onPress={() => setAct({ h, status: 'completed' })} />
            <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setAct({ h, status: 'cancelled' })} />
          </Session>
        ))}
      </Section>

      {k.unanswered_reviews.length ? (
        <Section title="Reviews to answer">
          {k.unanswered_reviews.map((r) => (
            <Card key={r.id} pad={12}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">{r.author_name}</T><Stars value={r.rating} /></View>{r.body ? <T size={13}>{r.body}</T> : null}<Btn small title="Reply" onPress={() => setReply(r)} style={{ alignSelf: 'flex-start', marginTop: 8 }} /></Card>
          ))}
        </Section>
      ) : null}

      <Section title="Earnings">
        {ledger.error ? <ErrorBox error={ledger.error} onRetry={ledger.reload} /> : ledger.loading && !ledger.data ? <Loading /> : !ledger.data?.length ? <T size={13} color={c.mute}>Nothing yet.</T> : ledger.data.map((p) => (
          <Card key={p.id} pad={12}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="700">{p.counterparty_name}</T><T size={12} color={c.mute}>{p.sport_emoji} {p.sport} · {dateTimeIn(p.starts_at, deviceTz)}{p.paid_at ? ` · paid ${new Date(p.paid_at).toLocaleDateString()}` : ''}</T></View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800">{price(p.total_cents, p.currency)}</T><StatusPill s={p.status === 'cancelled' && p.payment_status === 'unpaid' ? 'cancelled' : p.payment_status === 'not_required' ? 'pay_direct' : p.payment_status} /></View>
            </View>
          </Card>
        ))}
      </Section>

      <Confirm visible={!!act} title={act?.status === 'confirmed' ? 'Confirm this session?' : act?.status === 'completed' ? 'Mark as complete?' : 'Cancel this session?'} yes={act?.status === 'confirmed' ? 'Confirm' : act?.status === 'completed' ? 'Mark complete' : 'Cancel session'} danger={act?.status === 'cancelled'} onClose={() => setAct(null)} onYes={move}
        body={act ? `${act.h.athlete_name} · ${dateTimeIn(act.h.starts_at, deviceTz)}.${act.status === 'cancelled' && act.h.payment_status === 'paid' ? ' Their payment is refunded.' : ''}${act.status === 'completed' ? ' They will be asked to review the session.' : ''}` : ''} />
      <FormSheet visible={!!reply} onClose={() => setReply(null)} title="Reply to review" submitLabel="Post reply" fields={[{ key: 'reply', label: 'Your reply (public, one per review)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/coach-reviews/${reply.id}/reply`, { reply: v.reply }); await ov.reload(); return 'Reply posted'; }} />
    </Screen>
  );
}

function HoursEditor({ initial, onSave }) {
  const [rows, setRows] = useState(initial), [add, setAdd] = useState(false), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const { toast } = useSession();
  const change = (next) => { setRows(next); setDirty(true); };
  const save = async () => { setBusy(true); try { await onSave(rows); setDirty(false); toast('Hours saved'); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  return (
    <View style={{ gap: 8 }}>
      {DAY_ORDER.map((wd) => {
        const list = rows.map((x, i) => ({ ...x, i })).filter((x) => x.weekday === wd);
        return (
          <View key={wd} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T weight="700" style={{ width: 44 }}>{WEEKDAYS[wd]}</T>
            <View style={{ flex: 1, flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {list.length ? list.map((x) => <Chip key={x.i} active label={`${x.start}–${x.end}  ✕`} onPress={() => change(rows.filter((_, i) => i !== x.i))} />) : <T size={13} color={c.mute}>Closed</T>}
            </View>
          </View>
        );
      })}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        <Btn small title="+ Add hours" onPress={() => setAdd(true)} />
        <Btn small title="Save hours" color={c.violet} disabled={!dirty} loading={busy} onPress={save} />
      </View>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add open hours" submitLabel="Add" initial={{ weekdays: [1, 2, 3, 4, 5] }}
        fields={[{ key: 'weekdays', label: 'Days', type: 'weekdays' }, { key: 'start', label: 'From', type: 'time', step: 30 }, { key: 'end', label: 'Until', type: 'time', step: 30 }]}
        onSubmit={async (v) => {
          if (v.start >= v.end) throw new Error('Until must be after From');
          const fresh = v.weekdays.map((weekday) => ({ weekday, start: v.start, end: v.end }));
          const clash = fresh.find((n) => rows.some((x) => x.weekday === n.weekday && n.start < x.end && x.start < n.end));
          if (clash) throw new Error(`${WEEKDAYS[clash.weekday]} already has hours that overlap — remove them first`);
          change([...rows, ...fresh]);
        }} />
    </View>
  );
}

export function CoachSetup() {
  const { user, refresh } = useSession();
  const { push } = useNav();
  const d = useLoad(() => api.get(`/coaches/${user.id}`).catch((e) => (/not found/i.test(e.message) ? { empty: true } : Promise.reject(e))), [user.id]);
  const [edit, setEdit] = useState(false), [addSport, setAddSport] = useState(false);
  if (d.loading && !d.data) return <Screen><Loading /></Screen>;
  if (d.error) return <Screen><ErrorBox error={d.error} onRetry={d.reload} /></Screen>;
  const p = d.data;
  if (p.empty) return <Screen><Empty emoji="🧑‍🏫" title="Add a coaching sport first" sub="Add a sport you coach with your rate, then set up your public profile, rate cards and hours." /><Btn title="Add a coaching sport" onPress={() => setAddSport(true)} style={{ alignSelf: 'center' }} /><AddCoachSportSheet visible={addSport} onClose={() => setAddSport(false)} onDone={async () => { await refresh(); await d.reload(); }} /></Screen>;
  const pr = p.profile;
  return (
    <Screen onRefresh={d.reload}>
      <Head eyebrow="COACH" title="Profile & hours" sub="What athletes see when they search, and when they can book you." />
      <Section title="Public profile" action="Edit" onAction={() => setEdit(true)}>
        <Card pad={14}>
          <T weight="800" size={16}>{pr.headline ?? 'Add a headline'}</T>
          {pr.tagline ? <T size={13} color={c.pink} weight="700">{pr.tagline}</T> : null}
          <T size={12} color={c.mute}>{`Coaches ${(pr.serves ?? ['individual']).map((x) => `${x}s`).join(', ')}${pr.travel_km ? ` · travels up to ${pr.travel_km} km` : ''}`}</T>
          <T size={13} color={c.mute}>{[pr.city, DELIVERY[pr.delivery], pr.accepting ? 'taking new athletes' : 'not taking new athletes', pr.listed ? null : 'hidden from search'].filter(Boolean).join(' · ')}</T>
          <T size={13} style={{ marginTop: 6 }}>{pr.about ?? 'Write a short introduction so athletes know your approach.'}</T>
          {pr.specialties?.length ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Specialities: {pr.specialties.join(', ')}</T> : null}
        </Card>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="Rate cards & specialisations" onPress={() => push('CoachRates')} />
          <Btn small title="Add a sport I coach" color={c.paper} ink={c.ink} onPress={() => setAddSport(true)} />
        </View>
        <Btn small title="See how athletes see me" color={c.paper} ink={c.ink} onPress={() => push('CoachProfile', { id: user.id })} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title={`Weekly hours · ${p.hours.timezone}`}>
        <T size={13} color={c.mute}>Athletes can book only inside these hours, one slot every {p.hours.slot_min} minutes. With no hours, athletes propose a time and you confirm.</T>
        <HoursEditor initial={p.hours.windows} onSave={async (windows) => { await api.post('/me/coach-availability', { windows }); await d.reload(); }} />
      </Section>
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Edit public profile" submitLabel="Save" initial={{ ...pr, serves: pr.serves ?? ['individual'], travel_km: pr.travel_km ?? 0, bio: pr.about, specialties: (pr.specialties ?? []).join(', '), languages: (pr.languages ?? []).join(', ') }}
        fields={[
          { key: 'headline', label: 'Headline', optional: true }, { key: 'tagline', label: 'Tagline (one line ad)', optional: true, hint: 'Shown on your card in search.' },
          { key: 'serves', label: 'Who you coach', type: 'multi', options: AUDIENCES.map(([value, label]) => ({ value, label: `${label}s` })) },
          { key: 'travel_km', label: 'Willing to travel (km)', type: 'stepper', min: 0, max: 500, step: 5, default: 0, suffix: ' km' },
          { key: 'intro_video_url', label: 'Introduction video link (https)', optional: true }, { key: 'bio', label: 'About you', type: 'multiline', optional: true },
          { key: 'city', label: 'City', optional: true },
          { key: 'delivery', label: 'How you coach', type: 'choice', options: [{ value: 'in_person', label: 'In person' }, { value: 'online', label: 'Online' }, { value: 'both', label: 'Both' }] },
          { key: 'specialties', label: 'Specialities', optional: true, hint: 'Separate with commas.' }, { key: 'languages', label: 'Languages', optional: true, hint: 'Separate with commas.' },
          { key: 'timezone', label: 'Your time zone', type: 'timezone' },
          { key: 'slot_min', label: 'Session slot length', type: 'stepper', min: 15, max: 240, step: 15, default: 60, suffix: ' min' },
          { key: 'accepting', label: 'Taking new athletes', type: 'switch', default: true }, { key: 'listed', label: 'Show me in search', type: 'switch', default: true },
        ]}
        onSubmit={async (v) => {
          const list = (x) => (x ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          await api.post('/me/coach-profile', { tagline: v.tagline ?? null, intro_video_url: v.intro_video_url ?? null, serves: v.serves?.length ? v.serves : ['individual'], travel_km: v.travel_km || null, headline: v.headline ?? null, bio: v.bio ?? null, city: v.city ?? null, delivery: v.delivery, specialties: list(v.specialties), languages: list(v.languages), timezone: v.timezone, slot_min: v.slot_min, accepting: v.accepting, listed: v.listed });
          await d.reload(); return 'Profile saved';
        }} />
      <AddCoachSportSheet visible={addSport} onClose={() => setAddSport(false)} onDone={async () => { await refresh(); await d.reload(); }} />
    </Screen>
  );
}
