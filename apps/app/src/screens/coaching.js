// Coaching, both sides of the marketplace.
//   Athlete: Hire (find a coach · post a request · my coaching) -> CoachProfile -> BookCoachSheet, CoachRequest (compare answers).
//   Coach:   CoachDesk (confirm, complete, earnings, reviews), CoachBoard (answer requests), CoachSetup (profile + weekly hours).
import { locale } from '../locale';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import { openPage } from '../video-player';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useMyCurrency } from '../my-currency';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, H2, Loading, Screen, Section, Seg, Sheet, StatPill, T } from '../ui';
import { AdSlot } from '../ads';
import { MenuField } from '../menu-field';
import { t } from '../i18n';
import { SharedSessionSheet } from './session-workspace';
import { FormSheet } from '../FormSheet';
import { TimelineSheet } from '../Timeline';
import { SportSelect } from '../sportpicker';
import { Counter, DateField, DayStrip, HScroll, TimeField } from '../pickers';
import { NewCaseSheet } from './cases';
import { SeriesBookingSheet, VenueLine } from './training-venue';
import { SeriesSheet } from './coach-series';
import { AdaptiveFilters, AdaptiveLine, AdaptiveProfileBlock, AdjustmentsSheet, CoachAdjustmentsSheet, adaptiveParams, emptyAdaptive } from './coach-adaptive';
import { CoachClassList } from './coach-classes';
import { BuyPackageSheet, SubscribeSheet, isRedeemablePack } from './coach-subscriptions';
import { Grid, PaySheet, Pill, StatusPill, nice, useCols } from './marketplace';
import { c, grad, toneFor } from '../theme';
import { dateTimeIn, localDate, localToIso, moneyIn, timeIn, todayIn, WEEKDAYS } from '../vtime';
import { PlacePicker } from '../place-picker';
import { storage } from '../storage';

const COACH_WIZARD_DRAFT_KEY = 'coach_wizard_draft';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
export const price = (cents, currency) => moneyIn(cents, currency);
const rateOf = (x, currency) => (x.hourly_rate_cents ? `${price(x.hourly_rate_cents, currency)}/hr` : 'Rate on request');
export const AUDIENCES = [['individual', 'Individual'], ['group', 'Group'], ['team', 'Team'], ['event', 'Event']];
export const UNIT = { hour: '/hr', session: '/session', day: '/day', month: '/month', package: ' package' };
export const cardPrice = (k, currency) => `${price(k.price_cents, currency)}${UNIT[k.unit]}${k.per_person ? ' per person' : ''}`;
export const audienceTag = (r) => (r.audience && r.audience !== 'individual' ? `${r.audience[0].toUpperCase()}${r.audience.slice(1)}${r.team_name ? `: ${r.team_name}` : r.event_name ? `: ${r.event_name}` : ''}${r.participants > 1 ? ` · ${r.participants} people` : ''}` : null);
export const COACHING_STYLES = [['player_led', 'Player-led'], ['technical', 'Technical'], ['tactical', 'Tactical'], ['game_based', 'Game-based'], ['athlete_development', 'Athlete development'], ['holistic', 'Holistic'], ['performance', 'Performance'], ['fun_and_participation', 'Fun and participation'], ['discipline', 'Discipline'], ['data_informed', 'Data-informed']];
const styleName = (k) => COACHING_STYLES.find(([v]) => v === k)?.[1] ?? k;
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
export function Confirm({ visible, title, body, yes, danger, onYes, onClose, askReason }) {
  const [busy, setBusy] = useState(false), [reason, setReason] = useState('');
  useEffect(() => { if (!visible) setReason(''); }, [visible]);
  if (!visible) return null;
  return (
    <Sheet visible onClose={onClose} title={title}>
      {typeof body === 'string' ? <T size={14} color={c.mute}>{body}</T> : body}
      {askReason ? <Field label={askReason} value={reason} onChangeText={setReason} multiline maxLength={500} hint="Optional. Both of you can see it in the booking history." /> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="Not now" color={c.paper} ink={c.ink} onPress={onClose} style={{ flex: 1 }} />
        <Btn title={yes} color={danger ? c.red : c.pink} loading={busy} style={{ flex: 1 }} onPress={async () => { setBusy(true); try { await onYes(reason.trim() || undefined); } finally { setBusy(false); } }} />
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

/** Round icon tiles on a soft panel, four to a row: the way to browse by type, or to reach the tools of a screen. */
export function IconGrid({ items, value, onChange, cols = 4, tint = c.pinkSoft }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 }}>
      {items.map((it) => {
        const on = value !== undefined && value === it.value;
        return (
          <Pressable key={String(it.key ?? it.value ?? it.label)} onPress={() => (it.onPress ? it.onPress() : onChange?.(it.value))} accessibilityRole="button" accessibilityLabel={it.label}
            style={({ pressed }) => ({ width: `${100 / cols}%`, alignItems: 'center', gap: 6, paddingHorizontal: 2, opacity: pressed ? 0.8 : 1 })}>
            <View style={{ width: 62, height: 62, borderRadius: 31, backgroundColor: on ? c.pink : c.paper, borderWidth: on ? 0 : 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', shadowColor: '#0F172A', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 }}>
              <T size={28}>{it.emoji}</T>
              {it.badge ? <View style={{ position: 'absolute', top: -2, right: -2, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: c.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}><T size={11} weight="800" color={c.onAccent}>{it.badge}</T></View> : null}
            </View>
            <T size={12} weight={on ? '800' : '600'} color={on ? c.pink : c.mute} style={{ textAlign: 'center' }} numberOfLines={2}>{it.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The coach's tools as one tidy grid (desk, board, athletes, profile, schedule, rates, commitments, reviews, analytics, courts…). */
export function CoachToolGrid({ push, counts = {} }) {
  const tools = [
    ['🗂️', 'Desk', 'CoachDesk'], ['📬', 'Request board', 'CoachBoard', counts.board], ['🏃', 'Athletes', 'CoachAthletes'], ['🤝', 'Shared wellness', 'SharedWellness'], ['📄', 'Shared reports', 'SharedSeasonReports'], ['🎬', 'Recruitment', 'PassportDesk'], ['🪪', 'Profile & hours', 'CoachSetup'], ['🎖️', t('adp.title'), 'CoachAdaptive'],
    ['📅', 'Schedule', 'CoachCalendar'], ['🏫', 'Academy week', 'AcademyAgenda'], ['🏷️', 'Rate cards', 'CoachRates'], ['🎽', 'My classes', 'CoachClasses'], ['🏟️', t('vc.title'), 'CoachVenues'], ['📑', 'Commitments', 'CoachCommitments'], ['⭐', 'Reviews', 'CoachReviews', counts.reviews],
    ['🧠', 'Performance Studio', 'PerformanceStudio'], ['📊', t('nav.title.TeamPerformance'), 'TeamPerformance'], ['🧰', 'Drill library', 'CoachDrills'], ['👥', 'Saved groups', 'CoachGroups'], ['📋', t('nav.title.Evaluations'), 'Evaluations'], ['📏', t('es.sheets_title'), 'CoachRubrics'], ['📈', 'Analytics', 'CoachAnalytics'], ['📝', 'Training plans', 'MyPlans', null, { as: 'coach' }], ['📍', 'Courts', 'TrainingVenue', counts.courts], ['🔁', 'Recurring booking', 'RecurringVenue'],
  ];
  return (
    <Card pad={16} color={c.violetSoft}>
      <IconGrid items={tools.map(([emoji, label, page, badge, params]) => ({ emoji, label, badge, onPress: () => push(page, params ?? {}) }))} />
    </Card>
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
  const cards = (detail.data?.rate_cards ?? []).filter((k) => k.unit !== 'month' && !isRedeemablePack(k) && (!k.sport_slug || k.sport_slug === coach.sport_slug));   // a monthly card is subscribed to on the profile, not booked per session
  const [cardId, setCardId] = useState(null), [athleteId, setAthleteId] = useState(user.id);
  const kids = useLoad(() => api.get('/youth/guardian-links', { as: 'guardian', status: 'active', limit: 50 }).catch(() => []), []);
  const intro = useLoad(() => api.get(`/coaches/${coach.id}/intro-status`, athleteId !== user.id ? { athlete_id: athleteId } : {}).catch(() => ({ offers: [] })), [coach.id, athleteId]);
  const introUsed = (k) => k.is_intro && k.audience === 'individual' && (intro.data?.offers ?? []).some((o) => o.rate_card_id === k.id && !o.available);
  const card = cards.find((k) => k.id === cardId) ?? null;
  // an included session of a monthly subscription with this coach covers the booking (individual sessions only)
  const subs = useLoad(() => api.get('/me/coach-subscriptions', { limit: 50 }).catch(() => []), []);
  const mySub = (subs.data ?? []).find((s) => s.coach_id === coach.id && s.athlete_id === athleteId && s.i_pay && s.sessions_left > 0 && ['active', 'past_due', 'paused'].includes(s.status));
  // a prepaid package of this coach (for this athlete) can cover the session too: one "Pay with" choice for single / subscription / package
  const pkgs = useLoad(() => api.get('/me/coach-packages', { status: 'open', limit: 50 }).catch(() => []), []);
  const myPkgs = (pkgs.data ?? []).filter((p) => p.coach_id === coach.id && p.athlete_id === athleteId && p.i_pay && p.status === 'active' && p.sessions_left > 0 && (!p.sport_slug || p.sport_slug === coach.sport_slug));
  const [fund, setFund] = useState(null);
  const indiv = !card || card.audience === 'individual';
  const payPick = !indiv ? 'pay' : fund && (fund === 'pay' || (fund === 'sub' && mySub) || myPkgs.some((p) => `pkg:${p.id}` === fund)) ? fund : myPkgs[0] ? `pkg:${myPkgs[0].id}` : mySub ? 'sub' : 'pay';
  const useIncluded = payPick === 'sub', pkgId = payPick.startsWith('pkg:') ? payPick.slice(4) : null;
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
  const choose = (k) => { if (k && introUsed(k)) return; setCardId(k?.id ?? null); setPeople(k ? k.min_participants : 1); setTeamId(null); setEventId(null); setPick(null); setDay(null); };
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const hire = await api.post('/hires', { coach_id: coach.id, sport: coach.sport_slug, starts_at: startsAt, duration_min: mins, ...(note.trim() ? { note: note.trim() } : {}),
        ...(athleteId !== user.id ? { athlete_id: athleteId } : {}),
        ...(mySub && useIncluded ? { subscription_id: mySub.id } : {}), ...(pkgId ? { package_id: pkgId } : {}),
        ...(card ? { rate_card_id: card.id, participants: people, ...(teamId ? { team_id: teamId } : {}), ...(eventId ? { event_id: eventId } : {}) } : {}) });
      toast(hire.payment_status === 'unpaid' ? 'Requested — pay to let the coach confirm' : 'Requested — the coach will confirm');
      await onDone(hire); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={`Book ${coach.display_name}`}>
      <T size={13} color={c.mute}>{coach.sport_emoji} {coach.sport}</T>
      {kids.data?.length ? <MenuField label={t('coaching.bookingFor')} value={athleteId} onChange={(v) => { setAthleteId(v); setCardId(null); }} options={[{ value: user.id, label: user.display_name }, ...kids.data.map((l) => ({ value: l.child_id, label: l.child?.display_name ?? 'Child' }))]} /> : null}
      {indiv && (myPkgs.length || mySub) ? (
        <View style={{ gap: 8 }}>
          <T weight="800" size={13}>{t('pkg.payWith')}</T>
          <Card pad={12} color={payPick === 'pay' ? c.pinkSoft : c.paper} onPress={() => setFund('pay')} accessibilityLabel={t('pkg.paySingle')}><T weight="700">{payPick === 'pay' ? '✓ ' : ''}{t('pkg.paySingle')}</T></Card>
          {mySub ? (
            <Card pad={12} color={payPick === 'sub' ? c.mintSoft : c.paper} onPress={() => setFund('sub')} accessibilityLabel={`${t('coachSub.bookIncluded')}. ${t('coachSub.sessionsLeft', { n: mySub.sessions_left })}`}>
              <T weight="800">{payPick === 'sub' ? '✓ ' : ''}{t('coachSub.bookIncluded')}</T><T size={12} color={c.mute}>{t('coachSub.sessionsLeft', { n: mySub.sessions_left })} · {mySub.title}</T>
            </Card>
          ) : null}
          {myPkgs.map((p) => (
            <Card key={p.id} pad={12} color={payPick === `pkg:${p.id}` ? c.mintSoft : c.paper} onPress={() => setFund(`pkg:${p.id}`)} accessibilityLabel={t('pkg.use', { title: p.title, n: p.sessions_left })}>
              <T weight="800">{payPick === `pkg:${p.id}` ? '✓ ' : ''}{t('pkg.use', { title: p.title, n: p.sessions_left })}</T>
              {p.expires_at ? <T size={12} color={c.mute}>{t('pkg.expires', { date: new Date(p.expires_at).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) })}</T> : null}
            </Card>
          ))}
        </View>
      ) : null}
      {cards.length ? (
        <View style={{ gap: 8 }}>
          <T weight="800" size={13}>What do you need?</T>
          <View style={{ gap: 8 }}>
            {coach.hourly_rate_cents ? <Card pad={12} color={!card ? c.pinkSoft : c.paper} onPress={() => choose(null)}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">Standard hourly rate</T><T weight="800">{rateOf(coach, coach.currency)}</T></View><T size={12} color={c.mute}>One person</T></Card> : null}
            {cards.map((k) => (
              <Card key={k.id} pad={12} color={card?.id === k.id ? c.pinkSoft : c.paper} onPress={() => choose(k)} accessibilityLabel={introUsed(k) ? `${k.title}. ${t('coaching.introUsed')}` : k.title} style={introUsed(k) ? { opacity: 0.6 } : undefined}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="700">{k.title}{k.is_intro ? ' · trial' : ''}</T></View><T weight="800">{cardPrice(k, k.currency ?? coach.currency)}</T></View>
                {introUsed(k) ? <T size={12} weight="700" color={c.sun}>{t('coaching.introUsed')}</T> : null}
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
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">Total</T><T weight="800">{pkgId ? t('pkg.covered') : useIncluded ? t('coachSub.included') : rate ? price(cost, coach.currency) : 'Agreed with the coach'}</T></View>
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
export function PostRequestSheet({ visible, onClose, onDone, currency: given }) {
  const myCur = useMyCurrency();
  const currency = given ?? myCur;
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
        { key: 'city', label: 'City or area', type: 'region', optional: true, show: (v) => v.delivery !== 'online' },
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
  const [more, setMore] = useState(false), [showAll, setShowAll] = useState(false), [ad, setAd] = useState(emptyAdaptive);
  const everyone = useLoad(() => api.get('/coaches', { limit: 100 }), []);
  const types = [...(everyone.data ?? []).reduce((m, x) => m.set(x.sport_slug, { slug: x.sport_slug, name: x.sport, emoji: x.sport_emoji, n: (m.get(x.sport_slug)?.n ?? 0) + 1 }), new Map()).values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const q = useDebounced(f.q);
  const list = useLoad(() => api.get('/coaches', {
    limit: 50, sort: f.sort, ...adaptiveParams(ad), ...(q.trim() ? { q: q.trim() } : {}), ...(f.sport ? { sport: f.sport } : {}), ...(f.delivery ? { delivery: f.delivery } : {}),
    ...(f.verified ? { verified: true } : {}), ...(f.rated ? { min_rating: 4 } : {}), ...(f.hours ? { has_hours: true } : {}), ...(f.audience ? { audience: f.audience } : {}), ...(f.intro ? { intro_offer: true } : {}), ...(f.max ? { max_rate_cents: f.max } : {}), ...(f.city.trim() ? { city: f.city.trim() } : {}),
  }), [q, f.sport, f.delivery, f.verified, f.rated, f.hours, f.audience, f.intro, f.sort, f.max, f.city, JSON.stringify(ad)]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const myCur = useMyCurrency();
  const cur = list.data?.[0]?.currency ?? myCur;
  const active = [f.max, f.city.trim()].filter(Boolean).length;
  return (
    <View style={{ gap: 12, marginTop: 14 }}>
      <GradCard colors={grad.hero} pad={16}>
        <T color="#fff" weight="800" size={17}>Not sure who to pick?</T>
        <T color="#fff" size={13} style={{ opacity: 0.9, marginTop: 2 }}>Say what you need once. Coaches answer with a rate and a first session, and you choose.</T>
        <Btn small title="Post a request" color={c.paper} ink={c.pink} onPress={onPost} style={{ alignSelf: 'flex-start', marginTop: 10 }} />
      </GradCard>
      <Field value={f.q} onChangeText={(x) => set('q', x)} placeholder="Search by name, speciality or headline…" />
      <GradCard colors={grad.hero} pad={16}>
        <T color="#fff" weight="800" size={17}>Type of coach</T>
        <T color="#fff" size={12} style={{ opacity: 0.85, marginBottom: 12 }}>Pick a sport to see the coaches who teach it.</T>
        <Card pad={14} color={c.violetSoft}>
          <IconGrid value={f.sport ?? null} onChange={(v) => set('sport', v)} items={[{ value: null, key: 'all', emoji: '✨', label: 'All coaches' }, ...types.slice(0, showAll ? 40 : 10).map((t) => ({ value: t.slug, emoji: t.emoji, label: t.name })), { key: 'more', emoji: showAll ? '▴' : '⋯', label: showAll ? 'Fewer' : 'More', onPress: () => setShowAll(!showAll) }]} />
        </Card>
      </GradCard>
      <HScroll>{[[null, 'Anyone'], ...AUDIENCES.map(([v, l]) => [v, `For ${l.toLowerCase()}s`])].map(([v, l]) => <Chip key={l} label={l} active={f.audience === v} onPress={() => set('audience', v)} />)}<Chip label="🎁 Trial offer" active={f.intro} onPress={() => set('intro', !f.intro)} /></HScroll>
      <HScroll>
        {[[null, 'Any place'], ['in_person', 'In person'], ['online', 'Online']].map(([v, l]) => <Chip key={l} label={l} active={f.delivery === v} onPress={() => set('delivery', v)} />)}
        <Chip label="✓ Verified" active={f.verified} onPress={() => set('verified', !f.verified)} />
        <Chip label="★ 4 & up" active={f.rated} onPress={() => set('rated', !f.rated)} />
        <Chip label="📅 Open hours" active={f.hours} onPress={() => set('hours', !f.hours)} />
        <Chip label={active ? `More filters · ${active}` : 'More filters'} active={!!active} onPress={() => setMore(true)} />
      </HScroll>
      <HScroll>{[['rating', 'Top rated'], ['rate', 'Lowest rate'], ['sessions', 'Most sessions'], ['name', 'A–Z']].map(([v, l]) => <Chip key={v} label={`↕ ${l}`} active={f.sort === v} onPress={() => set('sort', v)} />)}</HScroll>
      <AdaptiveFilters value={ad} onChange={setAd} />
      <AdSlot placement="featured_coach" sport={f.sport || undefined} />
      <AdSlot placement="search_sponsored" q={f.q} sport={f.sport || undefined} />
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
                  <AdaptiveLine a={x.adaptive} />
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
        fields={[{ key: 'max', label: 'Most per hour', type: 'money', currency: cur, optional: true }, { key: 'city', label: 'City or area', type: 'region', optional: true }]}
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
  const { user } = useSession();
  const [hist, setHist] = useState(false), [shared, setShared] = useState(false), [adj, setAdj] = useState(false);
  const ran = ['confirmed', 'completed'].includes(h.status);
  const upcoming = ['requested', 'confirmed'].includes(h.status) && new Date(h.starts_at) > new Date();
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
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>{children}<Btn small title="History" color={c.paper} ink={c.mute} accessibilityLabel="Show the history of this session" onPress={() => setHist(true)} />
        {upcoming ? <Btn small title={t('adp.adj_title')} color={c.paper} ink={c.ink} accessibilityLabel={t('adp.adj_title')} onPress={() => setAdj(true)} /> : null}
        {ran && who === 'athlete' ? <Btn small title={t('swk.open')} accessibilityLabel={t('swk.open')} onPress={() => push('SessionWorkspace', { source_type: 'coach_hire', source_id: h.id })} /> : null}
        {ran && who === 'coach' ? <Btn small title={t('swk.athlete.open')} color={c.paper} ink={c.ink} accessibilityLabel={t('swk.athlete.open')} onPress={() => setShared(true)} /> : null}
      </View>
      {adj ? (who === 'coach' ? <AdjustmentsSheet hire={h} onClose={() => setAdj(false)} /> : <CoachAdjustmentsSheet hire={h} onClose={() => setAdj(false)} />) : null}   {/* `who` names the person shown on the card: 'coach' means the viewer is the athlete */}
      {shared ? <SharedSessionSheet hireId={h.id} onClose={() => setShared(false)} /> : null}
      {hist ? <TimelineSheet kind="hire" id={h.id} meId={user.id} title="Session history" onClose={() => setHist(false)} /> : null}
    </Card>
  );
}

function MyCoaching({ ov, reloadOverview, goFind, goRequests }) {
  const { toast, user } = useSession();
  const { push } = useNav();
  const [payTarget, setPayTarget] = useState(null), [rev, setRev] = useState(null), [cancel, setCancel] = useState(null), [disp, setDisp] = useState(null), [series, setSeries] = useState(null);
  const ledger = useLoad(() => api.get('/coaching/payments', { as: 'athlete', limit: 30 }), []);
  const a = ov.athlete, cur = ov.currency;
  const reloadAll = () => Promise.all([reloadOverview(), ledger.reload()]);
  const doCancel = async (reason) => { try { await api.patch(`/hires/${cancel.id}`, { status: 'cancelled', ...(reason ? { reason } : {}) }); setCancel(null); await reloadAll(); toast(cancel.payment_status === 'paid' ? 'Cancelled — your payment is refunded' : 'Session cancelled'); } catch (e) { toast(e.message); } };
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
          {a.awaiting_payment.map((h) => <Session key={h.id} h={h} who="coach">{h.series_pay_mode === 'once' ? <Btn small title={t('series.manage')} onPress={() => setSeries(h.series_id)} /> : <Btn small title={`Pay ${price(h.total_cents, cur)}`} onPress={() => setPayTarget(paying(h, h.coach_name))} />}</Session>)}
          {a.to_review.map((h) => <Session key={h.id} h={h} who="coach"><Btn small title="★ Rate this session" onPress={() => setRev(h)} /></Session>)}
        </Section>
      ) : null}

      {a.upcoming.length ? (
        <Section title="Your schedule">
          {a.upcoming.map((h) => (
            <Session key={h.id} h={h} who="coach">
              {h.payment_status === 'unpaid' && h.series_pay_mode !== 'once' ? <Btn small title={`Pay ${price(h.total_cents, cur)}`} onPress={() => setPayTarget(paying(h, h.coach_name))} /> : null}
              {h.series_id ? <Btn small title={t('series.manage')} color={c.violet} accessibilityLabel={t('series.manage')} onPress={() => setSeries(h.series_id)} /> : null}
              {h.series_id && h.series_pay_mode === 'once' ? null : <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setCancel(h)} />}
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
                    <T size={12} color={c.mute}>{p.sport_emoji} {p.sport} · {dateTimeIn(p.starts_at, deviceTz)}{p.paid_at ? ` · paid ${new Date(p.paid_at).toLocaleDateString(locale)}` : ''}{p.refunded_at ? ` · refunded ${new Date(p.refunded_at).toLocaleDateString(locale)}` : ''}</T>
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
      {series ? <SeriesSheet id={series} who="athlete" onClose={() => setSeries(null)} onChanged={reloadAll} /> : null}
      {rev ? <ReviewSheet hire={rev} onClose={() => setRev(null)} onDone={reloadAll} /> : null}
      <Confirm visible={!!cancel} title="Cancel this session?" yes="Cancel session" danger askReason="Why are you cancelling?" onClose={() => setCancel(null)} onYes={doCancel}
        body={cancel ? `${cancel.coach_name} will be told.${cancel.payment_status === 'paid' ? ' Your payment is refunded.' : ''}` : ''} />
      <NewCaseSheet visible={!!disp} onClose={() => setDisp(null)} kind="dispute" category="provider_payment" links={disp ? [{ type: 'coach_hire', id: disp.id }] : []} />
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
  ];
  return (
    <Screen wide onRefresh={ov.reload}>
      <Head eyebrow="HIRE" title="Build your team around you" sub="Find a coach, or post what you need and let coaches come to you." />
      <View style={{ marginTop: 14 }}><Seg options={tabs} value={tab} onChange={setTab} /></View>
      {tab === 'find' ? <FindCoaches onPost={() => setPost(true)} onBook={setBook} /> : null}
      {tab === 'requests' ? <MyRequests onPost={() => setPost(true)} reloadOverview={ov.reload} /> : null}
      {tab === 'mine' ? (ov.error ? <ErrorBox error={ov.error} onRetry={ov.reload} /> : !o ? <Loading /> : <MyCoaching ov={o} reloadOverview={ov.reload} goFind={() => setTab('find')} goRequests={() => setTab('requests')} />) : null}
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
  const [sport, setSport] = useState(null), [book, setBook] = useState(false), [paying2, setPaying] = useState(null), [subCard, setSubCard] = useState(null), [pkgCard, setPkgCard] = useState(null);
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

      {p.profile.philosophy || p.profile.coaching_styles?.length ? (
        <Section title="Coaching philosophy">
          {p.profile.philosophy ? <T size={14}>{p.profile.philosophy}</T> : null}
          {p.profile.coaching_styles?.length ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{p.profile.coaching_styles.map((k) => <Pill key={k} label={styleName(k).toUpperCase()} />)}</View> : null}
        </Section>
      ) : null}

      <CoachClassList coachId={p.id} />

      {p.rate_cards.length ? (
        <Section title="Services & prices">
          {p.rate_cards.map((k) => (
            <Card key={k.id} pad={12}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <View style={{ flex: 1 }}><T weight="800">{k.title}</T><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}><Pill label={`FOR ${k.audience.toUpperCase()}`} />{k.is_intro ? <Pill label="🎁 TRIAL OFFER" fg={c.sun} bg={c.sunSoft} /> : null}{k.sport ? <Pill label={k.sport.toUpperCase()} /> : null}</View></View>
                <T weight="800" size={15}>{cardPrice(k, k.currency ?? cur)}</T>
              </View>
              <T size={12} color={c.mute} style={{ marginTop: 4 }}>{[k.duration_min && k.unit !== 'hour' ? `${k.duration_min} min` : null, k.audience !== 'individual' ? `${k.min_participants}${k.max_participants ? `–${k.max_participants}` : '+'} people` : null, k.sessions_included ? `${k.sessions_included} sessions` : null, DELIVERY[k.delivery]].filter(Boolean).join(' · ')}</T>
              {k.description ? <T size={13} style={{ marginTop: 4 }}>{k.description}</T> : null}
              {isRedeemablePack(k) ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{k.valid_days ? t('pkg.summary', { n: k.sessions_included, days: k.valid_days }) : t('pkg.summaryNoExpiry', { n: k.sessions_included })}</T> : null}
              {isRedeemablePack(k) && !mine ? <Btn small title={t('pkg.buy')} accessibilityLabel={`${t('pkg.buy')} · ${k.title}`} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setPkgCard(k)} /> : null}
              {k.unit === 'month' && !mine ? <Btn small title={t('coachSub.subscribe')} accessibilityLabel={`${t('coachSub.subscribe')} · ${k.title}`} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => setSubCard(k)} /> : null}
            </Card>
          ))}
        </Section>
      ) : null}
      {pkgCard ? <BuyPackageSheet card={pkgCard} coach={p} currency={cur} onClose={() => setPkgCard(null)} onDone={() => { setPkgCard(null); d.reload(); }} /> : null}
      {subCard ? <SubscribeSheet card={subCard} coach={p} currency={cur} onClose={() => setSubCard(null)} onDone={() => { setSubCard(null); d.reload(); }} /> : null}
      {p.specialisations.length ? (
        <Section title="Specialisations">
          {p.specialisations.map((z) => <Card key={z.id} pad={12}><T weight="800">{z.emoji} {z.name}</T><T size={12} color={c.mute}>{[z.sport, z.levels.length ? `for ${z.levels.map(nice).join(', ')}` : null, z.years != null ? `${z.years} yrs` : null, z.certification].filter(Boolean).join(' · ')}</T></Card>)}
        </Section>
      ) : null}
      {p.profile.intro_video_url ? <Btn small title="▶ Watch introduction" color={c.paper} ink={c.ink} onPress={() => openPage(p.profile.intro_video_url)} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
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
              <T size={11} color={c.mute}>{new Date(r.created_at).toLocaleDateString(locale)}</T>
            </View>
            {r.body ? <T size={13} style={{ marginTop: 6 }}>{r.body}</T> : null}
            {r.reply ? <View style={{ marginTop: 8, backgroundColor: c.violetSoft, borderRadius: 10, padding: 10 }}><T size={12} weight="800" color={c.mute}>Reply from {p.display_name}</T><T size={13}>{r.reply}</T></View> : null}
          </Card>
        ))}
      </Section>

      <View style={{ marginTop: 16 }}><AdaptiveProfileBlock coachId={p.id} /></View>
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
  const myCur = useMyCurrency();   // an answer without a rate card is quoted in the coach's own country currency
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
        { key: 'rate_cents_hour', label: 'Your rate per hour', type: 'money', currency: myCur, optional: true, hint: 'Leave empty to use your profile rate for this sport.', show: (v) => !v.rate_card_id },
        { key: 'date', label: 'First session: date', type: 'date', min: today },
        { key: 'time', label: 'First session: start time', type: 'time', step: 15 },
        { key: 'duration_min', label: 'Session length', type: 'stepper', min: 15, max: 480, step: 15, default: 60, suffix: ' min', show: (v) => !v.rate_card_id || byId[v.rate_card_id]?.unit === 'hour' },
        { key: 'message', label: 'Message to the athlete', type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => { await api.post(`/coach-requests/${r.id}/respond`, { starts_at: localToIso(v.date, v.time, deviceTz), ...(v.duration_min ? { duration_min: v.duration_min } : {}), ...(v.rate_card_id ? { rate_card_id: v.rate_card_id } : v.rate_cents_hour !== undefined ? { rate_cents_hour: v.rate_cents_hour } : {}), ...(v.message ? { message: v.message } : {}) }); await onDone(); return 'Answer sent — the athlete has been told'; }} />
  );
}

// ── Elite coaching wizard helpers ─────────────────────────────────────────────

const COACH_TIERS = ['foundation', 'club', 'regional', 'national', 'elite', 'international'];
const ATHLETE_LEVELS = ['mini', 'youth', 'u21', 'senior', 'masters', 'elite', 'para'];
const SPECIALISATIONS = ['technical', 'tactical', 'physical', 'mental', 'video', 'sc', 'nutrition', 'injury', 'youth', 'highperf', 'teamdyn', 'movement'];
const SESSION_FORMATS = ['oneToOne', 'smallGroup', 'team', 'online', 'camp', 'videoReview', 'programme'];
const PEAK_LEVELS = ['recreational', 'club', 'regional', 'national', 'international'];
const DBS_OPTS = ['valid', 'pending', 'not_required'];
const NOTICE_OPTS = [{ value: 0, key: 'sameDay' }, { value: 24, key: 'h24' }, { value: 48, key: 'h48' }, { value: 168, key: 'week' }, { value: 336, key: 'twoWeeks' }, { value: 720, key: 'month' }];
const MIN_COMMITMENT_OPTS = ['single', 'monthly', 'quarterly', 'seasonal', 'annual'];
const WEEKDAY_OPTS = [
  { value: 1, key: 'mon' }, { value: 2, key: 'tue' }, { value: 3, key: 'wed' },
  { value: 4, key: 'thu' }, { value: 5, key: 'fri' }, { value: 6, key: 'sat' }, { value: 0, key: 'sun' },
];

// Language list (ISO 639-1 → display name)
const LANG_OPTIONS = [
  { value: 'en', label: 'English' }, { value: 'es', label: 'Español' }, { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' }, { value: 'pt', label: 'Português' }, { value: 'it', label: 'Italiano' },
  { value: 'zh', label: '中文' }, { value: 'ja', label: '日本語' }, { value: 'ar', label: 'العربية' },
  { value: 'hi', label: 'हिन्दी' }, { value: 'ta', label: 'தமிழ்' }, { value: 'te', label: 'తెలుగు' },
  { value: 'ml', label: 'മലയാളം' }, { value: 'mr', label: 'मराठी' }, { value: 'bn', label: 'বাংলা' },
  { value: 'kn', label: 'ಕನ್ನಡ' }, { value: 'or', label: 'ଓଡ଼ିଆ' }, { value: 'si', label: 'සිංහල' },
  { value: 'ur', label: 'اردو' }, { value: 'id', label: 'Bahasa Indonesia' }, { value: 'ru', label: 'Русский' },
  { value: 'ko', label: '한국어' }, { value: 'tr', label: 'Türkçe' }, { value: 'nl', label: 'Nederlands' },
  { value: 'sv', label: 'Svenska' }, { value: 'pl', label: 'Polski' },
];

function WizardStepBar({ step, total }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, marginBottom: 20 }} accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: total, now: step }}>
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={{ flex: 1, height: 3, borderRadius: 99, backgroundColor: i < step ? c.pink : c.line }} />
      ))}
    </View>
  );
}

function SectionLabel({ label }) {
  return <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1, marginTop: 20, marginBottom: 8 }}>{label.toUpperCase()}</T>;
}

function ChipRow({ options, value, onChange, multiSelect }) {
  const arr = Array.isArray(value) ? value : (value ? [value] : []);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((opt) => {
        const active = arr.includes(opt.value);
        return (
          <Pressable key={opt.value} accessibilityRole="button" accessibilityLabel={opt.label} accessibilityState={{ selected: active }}
            style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 99, borderWidth: 1.5, borderColor: active ? c.pink : c.line, backgroundColor: active ? c.pinkSoft : c.paper, minHeight: 44 }}
            onPress={() => {
              if (multiSelect) {
                onChange(active ? arr.filter((v) => v !== opt.value) : [...arr, opt.value]);
              } else {
                onChange(active ? null : opt.value);
              }
            }}>
            <T size={13} weight={active ? '700' : '400'} color={active ? c.pink : c.ink}>{opt.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

function LicenceForm({ visible, initial, onSave, onClose }) {
  const [form, setForm] = useState(initial ?? { issuing_body: '', licence_level: '', licence_no: '', country: '', expires_on: null });
  const f = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  if (!visible) return null;
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 12, padding: 16, marginTop: 8, borderWidth: 1, borderColor: c.line }}>
      <Field label={t('coach.sport.licence.issuingBody')} value={form.issuing_body} onChangeText={f('issuing_body')} placeholder={t('coach.sport.licence.issuingBodyPlaceholder')} />
      <Field label={t('coach.sport.licence.level')} value={form.licence_level} onChangeText={f('licence_level')} placeholder={t('coach.sport.licence.levelPlaceholder')} />
      <Field label={t('coach.sport.licence.number')} value={form.licence_no} onChangeText={f('licence_no')} hint={t('coach.sport.licence.numberHint')} secureTextEntry />
      <MenuField label={t('coach.sport.licence.country')} value={form.country} onChange={f('country')}
        options={[{ value: 'AU', label: 'Australia' }, { value: 'GB', label: 'United Kingdom' }, { value: 'US', label: 'United States' }, { value: 'IN', label: 'India' }, { value: 'ES', label: 'Spain' }, { value: 'FR', label: 'France' }, { value: 'DE', label: 'Germany' }, { value: 'BR', label: 'Brazil' }, { value: 'AR', label: 'Argentina' }, { value: 'PT', label: 'Portugal' }, { value: 'IT', label: 'Italy' }, { value: 'NL', label: 'Netherlands' }, { value: 'LK', label: 'Sri Lanka' }]} />
      <DateField label={t('coach.sport.licence.expires')} value={form.expires_on} onChange={f('expires_on')} optional />
      <Btn title={t('coach.sport.licence.saveBtn')} color={c.pink} onPress={() => { if (form.issuing_body.trim()) onSave(form); }} style={{ marginTop: 8 }} />
      <Btn title={t('coach.sport.wizard.back')} color={c.paper} ink={c.ink} onPress={onClose} style={{ marginTop: 6 }} />
    </View>
  );
}

function CareerForm({ visible, initial, onSave, onClose }) {
  const [form, setForm] = useState(initial ?? { org_name: '', role: '', city: '', country: '', started_year: '', ended_year: '', is_current: false });
  const f = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  if (!visible) return null;
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 12, padding: 16, marginTop: 8, borderWidth: 1, borderColor: c.line }}>
      <Field label={t('coach.sport.career.orgName')} value={form.org_name} onChangeText={f('org_name')} />
      <Field label={t('coach.sport.career.role')} value={form.role} onChangeText={f('role')} placeholder={t('coach.sport.career.rolePlaceholder')} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label={t('coach.sport.career.city')} value={form.city} onChangeText={f('city')} /></View>
        <View style={{ flex: 1 }}><Field label={t('coach.sport.career.country')} value={form.country} onChangeText={f('country')} /></View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label={t('coach.sport.career.startedYear')} value={String(form.started_year || '')} onChangeText={(v) => f('started_year')(v.replace(/\D/g, ''))} keyboardType="numeric" /></View>
        <View style={{ flex: 1 }}><Field label={t('coach.sport.career.endedYear')} value={String(form.ended_year || '')} onChangeText={(v) => f('ended_year')(v.replace(/\D/g, ''))} keyboardType="numeric" editable={!form.is_current} /></View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, minHeight: 44 }}>
        <Switch value={form.is_current} onValueChange={(v) => setForm((p) => ({ ...p, is_current: v, ended_year: v ? '' : p.ended_year }))} trackColor={{ true: c.pink }} />
        <T size={14}>{t('coach.sport.career.isCurrent')}</T>
      </View>
      <Btn title={t('coach.sport.career.saveBtn')} color={c.pink} onPress={() => { if (form.org_name.trim()) onSave(form); }} style={{ marginTop: 8 }} />
      <Btn title={t('coach.sport.wizard.back')} color={c.paper} ink={c.ink} onPress={onClose} style={{ marginTop: 6 }} />
    </View>
  );
}

/** Elite 5-step coach sport wizard — replaces the old 4-field flat FormSheet. */
export function AddCoachSportSheet({ visible, onClose, onDone, initialSport, currency: given }) {
  const myCur = useMyCurrency();
  const currency = given ?? myCur;
  const { toast } = useSession?.() ?? { toast: () => {} };

  // wizard state
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [profileId, setProfileId] = useState(null); // set after step 1 POSTs

  // step 1
  const [sport, setSport] = useState(initialSport ?? null);
  const [tier, setTier] = useState(null);
  const [athleteLevels, setAthleteLevels] = useState([]);
  const [paraEnabled, setParaEnabled] = useState(false);
  const [yearsCoaching, setYearsCoaching] = useState(1);
  const [peakLevel, setPeakLevel] = useState(null);

  // step 2
  const [licences, setLicences] = useState([]);
  const [showLicenceForm, setShowLicenceForm] = useState(false);
  const [editLicenceIdx, setEditLicenceIdx] = useState(null);
  const [dbsStatus, setDbsStatus] = useState(null);
  const [dbsIssuedOn, setDbsIssuedOn] = useState(null);
  const [firstAidExpires, setFirstAidExpires] = useState(null);
  const [degree, setDegree] = useState('');

  // step 3
  const [specialisations, setSpecialisations] = useState([]);
  const [formats, setFormats] = useState([]);
  const [bio, setBio] = useState('');
  const [coachingLanguages, setCoachingLanguages] = useState([]);

  // step 4
  const [career, setCareer] = useState([]);
  const [showCareerForm, setShowCareerForm] = useState(false);
  const [editCareerIdx, setEditCareerIdx] = useState(null);
  const [coachingCountries, setCoachingCountries] = useState([]);

  // step 5
  const [bookingNotice, setBookingNotice] = useState(24);
  const [weeklyHours, setWeeklyHours] = useState(10);
  const [travelWilling, setTravelWilling] = useState(false);
  const [baseLocation, setBaseLocation] = useState(null);
  const [sessionDuration, setSessionDuration] = useState(60);
  const [maxAthletes, setMaxAthletes] = useState(5);
  const [minCommitment, setMinCommitment] = useState(null);
  const [travelRadius, setTravelRadius] = useState(100);
  const [availableDays, setAvailableDays] = useState([]);

  const reset = () => {
    storage.del(COACH_WIZARD_DRAFT_KEY).catch(() => {});
    setStep(1); setErr(null); setProfileId(null);
    setSport(initialSport ?? null); setTier(null); setAthleteLevels([]); setParaEnabled(false); setYearsCoaching(1); setPeakLevel(null);
    setLicences([]); setShowLicenceForm(false); setEditLicenceIdx(null); setDbsStatus(null); setDbsIssuedOn(null); setFirstAidExpires(null); setDegree('');
    setSpecialisations([]); setFormats([]); setBio(''); setCoachingLanguages([]);
    setCareer([]); setShowCareerForm(false); setEditCareerIdx(null); setCoachingCountries([]);
    setBookingNotice(24); setWeeklyHours(10); setTravelWilling(false);
    setBaseLocation(null);
    setSessionDuration(60); setMaxAthletes(5); setMinCommitment(null); setTravelRadius(100); setAvailableDays([]);
  };

  // Load draft when wizard opens; leave draft intact when it closes (so it can be resumed)
  useEffect(() => {
    if (!visible) return;
    storage.get(COACH_WIZARD_DRAFT_KEY).then((raw) => {
      if (!raw) return;
      try {
        const d = JSON.parse(raw);
        if (d.sport) setSport(d.sport);
        if (d.tier !== undefined) setTier(d.tier);
        if (d.athleteLevels) setAthleteLevels(d.athleteLevels);
        if (d.paraEnabled !== undefined) setParaEnabled(d.paraEnabled);
        if (d.yearsCoaching) setYearsCoaching(d.yearsCoaching);
        if (d.peakLevel !== undefined) setPeakLevel(d.peakLevel);
        if (d.licences) setLicences(d.licences);
        if (d.dbsStatus !== undefined) setDbsStatus(d.dbsStatus);
        if (d.dbsIssuedOn !== undefined) setDbsIssuedOn(d.dbsIssuedOn);
        if (d.firstAidExpires !== undefined) setFirstAidExpires(d.firstAidExpires);
        if (d.degree !== undefined) setDegree(d.degree);
        if (d.specialisations) setSpecialisations(d.specialisations);
        if (d.formats) setFormats(d.formats);
        if (d.bio !== undefined) setBio(d.bio);
        if (d.coachingLanguages) setCoachingLanguages(d.coachingLanguages);
        if (d.career) setCareer(d.career);
        if (d.coachingCountries) setCoachingCountries(d.coachingCountries);
        if (d.bookingNotice !== undefined) setBookingNotice(d.bookingNotice);
        if (d.weeklyHours !== undefined) setWeeklyHours(d.weeklyHours);
        if (d.travelWilling !== undefined) setTravelWilling(d.travelWilling);
        if (d.baseLocation !== undefined) setBaseLocation(d.baseLocation);
        if (d.sessionDuration) setSessionDuration(d.sessionDuration);
        if (d.maxAthletes) setMaxAthletes(d.maxAthletes);
        if (d.minCommitment !== undefined) setMinCommitment(d.minCommitment);
        if (d.travelRadius) setTravelRadius(d.travelRadius);
        if (d.availableDays) setAvailableDays(d.availableDays);
        if (d.profileId) setProfileId(d.profileId);
        if (d.step > 1) setStep(d.step);
      } catch {}
    }).catch(() => {});
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save draft whenever any field changes while the wizard is open
  useEffect(() => {
    if (!visible) return;
    const draft = {
      step, profileId, sport, tier, athleteLevels, paraEnabled, yearsCoaching, peakLevel,
      licences, dbsStatus, dbsIssuedOn, firstAidExpires, degree,
      specialisations, formats, bio, coachingLanguages,
      career, coachingCountries,
      bookingNotice, weeklyHours, travelWilling,
      baseLocation, sessionDuration, maxAthletes,
      minCommitment, travelRadius, availableDays,
    };
    storage.set(COACH_WIZARD_DRAFT_KEY, JSON.stringify(draft)).catch(() => {});
  }, [ // eslint-disable-line react-hooks/exhaustive-deps
    visible, step, profileId, sport, tier, athleteLevels, paraEnabled, yearsCoaching, peakLevel,
    licences, dbsStatus, dbsIssuedOn, firstAidExpires, degree,
    specialisations, formats, bio, coachingLanguages,
    career, coachingCountries,
    bookingNotice, weeklyHours, travelWilling,
    baseLocation, sessionDuration, maxAthletes,
    minCommitment, travelRadius, availableDays,
  ]);

  const goNext = async () => {
    setErr(null);
    if (step === 1) {
      if (!sport) { setErr('Please select a sport.'); return; }
      if (profileId) { setStep(2); return; } // sport profile already created in a previous session — skip POST
      setBusy(true);
      try {
        const res = await api.post('/me/sport-profiles', { sport, role: 'coach', experience_years: yearsCoaching });
        setProfileId(res.id ?? res.sport_profile?.id);
        setStep(2);
        if (paraEnabled) { try { await api.post('/me/coach-adaptive', { sport }); } catch {} }
      } catch (e) { setErr(e.message); } finally { setBusy(false); }
      return;
    }
    if (step < 5) { setStep((s) => s + 1); return; }
    // Step 5 → finish
    setBusy(true);
    try {
      const id = profileId;
      const patch = {
        coaching_tier: tier ?? undefined,
        athlete_levels: athleteLevels,
        coaching_specialisations: specialisations,
        session_formats: formats,
        coaching_bio: bio.trim() || undefined,
        peak_playing_level: peakLevel,
        booking_notice_hours: bookingNotice,
        weekly_hours: weeklyHours,
        travel_willing: travelWilling,
        coaching_languages: coachingLanguages,
        dbs_status: dbsStatus,
        dbs_issued_on: dbsIssuedOn,
        first_aid_expires_on: firstAidExpires,
        coaching_degree: degree.trim() || undefined,
        travel_radius_km:     travelWilling && travelRadius ? travelRadius : undefined,
        available_days:       availableDays.length ? availableDays : undefined,
        min_commitment:       minCommitment ?? undefined,
        max_athletes:         maxAthletes > 0 ? maxAthletes : undefined,
        session_duration_min: sessionDuration > 0 ? sessionDuration : undefined,
        base_city:            baseLocation?.name ?? undefined,
        base_lat:             baseLocation?.lat ?? undefined,
        base_lng:             baseLocation?.lng ?? undefined,
      };
      await api.patch(`/me/sport-profiles/${id}/coach`, patch);
      // persist licences
      for (const lic of licences) {
        await api.post(`/me/sport-profiles/${id}/coach/licences`, lic).catch(() => {});
      }
      // persist career
      for (const entry of career) {
        await api.post(`/me/sport-profiles/${id}/coach/career`, entry).catch(() => {});
      }
      await storage.del(COACH_WIZARD_DRAFT_KEY).catch(() => {});
      toast?.(t('coach.sport.wizard.successToast'));
      await onDone?.();
      onClose?.();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  if (!visible) return null;

  const TOTAL = 5;
  const tierOpts = COACH_TIERS.map((v) => ({ value: v, label: t(`coach.sport.tier.${v}`) }));
  const athleteLevelOpts = ATHLETE_LEVELS.map((v) => ({ value: v, label: t(`coach.sport.athleteLevels.${v}`) }));
  const specOpts = SPECIALISATIONS.map((v) => ({ value: v, label: t(`coach.sport.specialisations.${v}`) }));
  const formatOpts = SESSION_FORMATS.map((v) => ({ value: v, label: t(`coach.sport.formats.${v}`) }));
  const peakOpts = PEAK_LEVELS.map((v) => ({ value: v, label: t(`coach.sport.peakLevel.${v}`) }));
  const dbsOpts = DBS_OPTS.map((v) => ({ value: v, label: t(`coach.sport.dbs.${v}`) }));
  const noticeOpts = NOTICE_OPTS.map((o) => ({ value: o.value, label: t(`coach.sport.bookingNotice.${o.key}`) }));

  const stepTitles = [1, 2, 3, 4, 5].map((s) => t(`coach.sport.wizard.step${s}Title`));
  const stepSubs = [1, 2, 3, 4, 5].map((s) => t(`coach.sport.wizard.step${s}Sub`));

  return (
    <Sheet visible onClose={() => { reset(); onClose?.(); }} title={t('coach.sport.wizard.title')}>
      <WizardStepBar step={step} total={TOTAL} />
      <T weight="800" size={20} style={{ marginBottom: 4 }}>{stepTitles[step - 1]}</T>
      <T size={13} color={c.mute} style={{ marginBottom: 16 }}>{stepSubs[step - 1]}</T>

      {/* ── Step 1: Sport & Tier ───────────────────────────────────────────────── */}
      {step === 1 && (
        <View>
          <SportSelect label={t('coach.sport.wizard.step1Title')} value={sport} onChange={setSport} />
          <SectionLabel label={t('coach.sport.tier.label')} />
          <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('coach.sport.tier.hint')}</T>
          <ChipRow options={tierOpts} value={tier} onChange={setTier} multiSelect={false} />

          <SectionLabel label={t('coach.sport.athleteLevels.label')} />
          <ChipRow options={athleteLevelOpts} value={athleteLevels} onChange={setAthleteLevels} multiSelect />

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, minHeight: 44, padding: 12, borderRadius: 12, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line }}>
            <Switch value={paraEnabled} onValueChange={setParaEnabled} trackColor={{ true: c.pink }} accessibilityLabel={t('coach.sport.para.toggle')} />
            <View style={{ flex: 1 }}>
              <T size={14} weight="600">{t('coach.sport.para.toggle')}</T>
              <T size={12} color={c.mute}>{t('coach.sport.para.toggleSub')}</T>
            </View>
          </View>

          <SectionLabel label={t('coach.sport.yearsCoaching.label')} />
          <Counter value={yearsCoaching} onChange={setYearsCoaching} min={0} max={60} accessibilityLabel={t('coach.sport.yearsCoaching.label')} />

          <SectionLabel label={t('coach.sport.peakLevel.label')} />
          <ChipRow options={peakOpts} value={peakLevel} onChange={setPeakLevel} multiSelect={false} />
        </View>
      )}

      {/* ── Step 2: Licences & Credentials ───────────────────────────────────── */}
      {step === 2 && (
        <View>
          <SectionLabel label={t('coach.sport.licence.sectionTitle')} />
          <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('coach.sport.wizard.licenceEncHint')}</T>
          {licences.map((lic, i) => (
            <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderRadius: 10, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line, marginBottom: 6 }}>
              <View style={{ flex: 1 }}>
                <T weight="700" size={14}>{lic.issuing_body}</T>
                <T size={12} color={c.mute}>{[lic.licence_level, lic.country].filter(Boolean).join(' · ')}{lic.expires_on ? ` · exp ${lic.expires_on}` : ''}</T>
              </View>
              <Pressable style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }} onPress={() => { setEditLicenceIdx(i); setShowLicenceForm(true); }}>
                <T size={13} color={c.pink}>{t('coach.sport.licence.editBtn')}</T>
              </Pressable>
              <Pressable style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }} onPress={() => setLicences((p) => p.filter((_, j) => j !== i))}>
                <T size={13} color={c.mute}>{t('coach.sport.licence.removeBtn')}</T>
              </Pressable>
            </View>
          ))}
          {!showLicenceForm && (
            <Btn title={t('coach.sport.licence.addBtn')} color={c.paper} ink={c.pink} style={{ borderWidth: 1.5, borderColor: c.pink, marginBottom: 4 }}
              onPress={() => { setEditLicenceIdx(null); setShowLicenceForm(true); }} />
          )}
          <LicenceForm visible={showLicenceForm} initial={editLicenceIdx != null ? licences[editLicenceIdx] : null}
            onSave={(form) => {
              if (editLicenceIdx != null) setLicences((p) => p.map((x, i) => i === editLicenceIdx ? form : x));
              else setLicences((p) => [...p, form]);
              setShowLicenceForm(false); setEditLicenceIdx(null);
            }}
            onClose={() => { setShowLicenceForm(false); setEditLicenceIdx(null); }} />

          <SectionLabel label={t('coach.sport.safeguarding.sectionTitle')} />
          <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('coach.sport.dbs.status')}</T>
          <ChipRow options={dbsOpts} value={dbsStatus} onChange={setDbsStatus} multiSelect={false} />
          {dbsStatus === 'valid' && (
            <DateField label={t('coach.sport.dbs.issuedOn')} value={dbsIssuedOn} onChange={setDbsIssuedOn} optional />
          )}
          <DateField label={t('coach.sport.firstAid.expires')} value={firstAidExpires} onChange={setFirstAidExpires} optional />
          <Field label={t('coach.sport.degree.label')} value={degree} onChangeText={setDegree} placeholder={t('coach.sport.degree.placeholder')} optional />
        </View>
      )}

      {/* ── Step 3: Specialisations & Methods ─────────────────────────────────── */}
      {step === 3 && (
        <View>
          <SectionLabel label={t('coach.sport.specialisations.label')} />
          <ChipRow options={specOpts} value={specialisations} onChange={setSpecialisations} multiSelect />

          <SectionLabel label={t('coach.sport.formats.label')} />
          <ChipRow options={formatOpts} value={formats} onChange={setFormats} multiSelect />

          <SectionLabel label={t('coach.sport.bio.label')} />
          <View style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, padding: 12, minHeight: 100 }}>
            <TextInput value={bio} onChangeText={(v) => setBio(v.slice(0, 300))} placeholder={t('coach.sport.bio.placeholder')} multiline style={{ color: c.ink, fontSize: 14, lineHeight: 22 }} placeholderTextColor={c.mute} accessibilityLabel={t('coach.sport.bio.label')} />
          </View>
          <T size={11} color={c.mute} style={{ marginTop: 4 }}>{bio.length}/300 · {t('coach.sport.bio.hint')}</T>

          <SectionLabel label={t('coach.sport.languages.label')} />
          <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('coach.sport.languages.hint')}</T>
          <ChipRow options={LANG_OPTIONS.slice(0, 12)} value={coachingLanguages} onChange={setCoachingLanguages} multiSelect />
        </View>
      )}

      {/* ── Step 4: Career ────────────────────────────────────────────────────── */}
      {step === 4 && (
        <View>
          <SectionLabel label={t('coach.sport.career.sectionTitle')} />
          {career.map((entry, i) => (
            <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderRadius: 10, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line, marginBottom: 6 }}>
              <View style={{ flex: 1 }}>
                <T weight="700" size={14}>{entry.org_name}</T>
                <T size={12} color={c.mute}>{[entry.role, entry.city, entry.country].filter(Boolean).join(' · ')}</T>
                <T size={12} color={c.mute}>{entry.started_year}{entry.is_current ? ' – present' : entry.ended_year ? ` – ${entry.ended_year}` : ''}</T>
              </View>
              <Pressable style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }} onPress={() => { setEditCareerIdx(i); setShowCareerForm(true); }}>
                <T size={13} color={c.pink}>{t('coach.sport.career.saveBtn')}</T>
              </Pressable>
              <Pressable style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }} onPress={() => setCareer((p) => p.filter((_, j) => j !== i))}>
                <T size={13} color={c.mute}>{t('coach.sport.career.removeBtn')}</T>
              </Pressable>
            </View>
          ))}
          {!showCareerForm && (
            <Btn title={t('coach.sport.career.addBtn')} color={c.paper} ink={c.pink} style={{ borderWidth: 1.5, borderColor: c.pink, marginBottom: 4 }}
              onPress={() => { setEditCareerIdx(null); setShowCareerForm(true); }} />
          )}
          <CareerForm visible={showCareerForm} initial={editCareerIdx != null ? career[editCareerIdx] : null}
            onSave={(form) => {
              if (editCareerIdx != null) setCareer((p) => p.map((x, i) => i === editCareerIdx ? form : x));
              else setCareer((p) => [...p, form]);
              setShowCareerForm(false); setEditCareerIdx(null);
            }}
            onClose={() => { setShowCareerForm(false); setEditCareerIdx(null); }} />
        </View>
      )}

      {/* ── Step 5: Availability ──────────────────────────────────────────────── */}
      {step === 5 && (
        <View>
          {/* B — BOOKING & CAPACITY */}
          <SectionLabel label={t('coach.sport.booking.sectionTitle')} />
          <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('coach.sport.bookingNotice.label')}</T>
          <ChipRow options={noticeOpts} value={bookingNotice} onChange={setBookingNotice} multiSelect={false} />

          <SectionLabel label={t('coach.sport.sessionDuration.label')} />
          <Counter value={sessionDuration} onChange={setSessionDuration} min={30} max={300} step={15}
            suffix={t('coach.sport.sessionDuration.suffix')} accessibilityLabel={t('coach.sport.sessionDuration.label')} />

          <SectionLabel label={t('coach.sport.maxAthletes.label')} />
          <Counter value={maxAthletes} onChange={setMaxAthletes} min={1} max={100}
            suffix={t('coach.sport.maxAthletes.suffix')} accessibilityLabel={t('coach.sport.maxAthletes.label')} />

          <SectionLabel label={t('coach.sport.minCommitment.label')} />
          <ChipRow
            options={MIN_COMMITMENT_OPTS.map((v) => ({ value: v, label: t(`coach.sport.minCommitment.${v}`) }))}
            value={minCommitment} onChange={setMinCommitment} multiSelect={false} />

          {/* C — LOCATION & TRAVEL */}
          <SectionLabel label={t('coach.sport.location.sectionTitle')} />
          <PlacePicker label={t('coach.sport.baseCity.label')} value={baseLocation} onChange={setBaseLocation}
            hint={t('coach.sport.baseCity.hint')} optional />

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, minHeight: 44, padding: 12, borderRadius: 12, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line }}>
            <Switch value={travelWilling} onValueChange={setTravelWilling} trackColor={{ true: c.pink }} accessibilityLabel={t('coach.sport.travel.label')} />
            <View style={{ flex: 1 }}>
              <T size={14} weight="600">{t('coach.sport.travel.label')}</T>
              <T size={12} color={c.mute}>{t('coach.sport.travel.sub')}</T>
            </View>
          </View>
          {travelWilling && (
            <View style={{ marginTop: 12 }}>
              <SectionLabel label={t('coach.sport.travelRadius.label')} />
              <Counter value={travelRadius} onChange={setTravelRadius} min={10} max={5000} step={10}
                suffix={t('coach.sport.travelRadius.suffix')} accessibilityLabel={t('coach.sport.travelRadius.label')} />
            </View>
          )}

          {/* D — WEEKLY SCHEDULE */}
          <SectionLabel label={t('coach.sport.schedule.sectionTitle')} />
          <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('coach.sport.weeklyHours.label')}</T>
          <Counter value={weeklyHours} onChange={setWeeklyHours} min={1} max={80} suffix={t('coach.sport.weeklyHours.suffix')} accessibilityLabel={t('coach.sport.weeklyHours.label')} />

          <SectionLabel label={t('coach.sport.availableDays.label')} />
          <ChipRow
            options={WEEKDAY_OPTS.map((d) => ({ value: d.value, label: t(`coach.sport.weekday.${d.key}`) }))}
            value={availableDays} onChange={setAvailableDays} multiSelect />

          <View style={{ marginTop: 16, padding: 14, borderRadius: 12, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line }}>
            <T size={13} weight="600" style={{ marginBottom: 4 }}>{t('coach.sport.wizard.rateCardNudgeTitle')}</T>
            <T size={12} color={c.mute}>{t('coach.sport.wizard.rateCardNudgeSub')}</T>
          </View>
          <T size={12} color={c.mute} style={{ marginTop: 12, marginBottom: 4 }}>{t('coach.sport.wizard.finishHint')}</T>
        </View>
      )}

      {err ? <T size={13} color={c.red} style={{ marginTop: 8 }}>{err}</T> : null}

      {/* Nav buttons */}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
        {step > 1 && (
          <Btn title={t('coach.sport.wizard.back')} color={c.paper} ink={c.ink} style={{ flex: 1 }} onPress={() => setStep((s) => s - 1)} />
        )}
        <Btn
          title={step < TOTAL ? t('coach.sport.wizard.continue') : t('coach.sport.wizard.finish')}
          color={c.pink} loading={busy} style={{ flex: 2 }}
          onPress={goNext} />
      </View>
    </Sheet>
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
                <View style={{ alignItems: 'flex-end' }}><T weight="800" size={16}>{price(x.rate_cents_hour, x.currency ?? cur)}/hr</T>{x.status !== 'pending' ? <StatusPill s={x.status} /> : null}</View>
              </View>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {x.credential_verified ? <Verified /> : null}
                {(tags.get(x.id) ?? []).map((t) => <Pill key={t} label={t.toUpperCase()} fg={c.pink} bg={c.pinkSoft} />)}
              </View>
              <T size={13} style={{ marginTop: 8 }}>First session <T weight="800" size={13}>{dateTimeIn(x.proposed_starts_at, deviceTz)}</T> · {x.duration_min} min · {price(x.first_session_cents, x.currency ?? cur)}</T>
              {x.message ? <T size={13} color={c.mute} style={{ marginTop: 4 }}>“{x.message}”</T> : null}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {x.status === 'pending' && r.status === 'open' ? <Btn small title="Accept & book" onPress={() => setAccept(x)} /> : null}
                {x.status === 'pending' && r.status === 'open' ? <Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => decide(x, 'decline')} /> : null}
                <Btn small title="View profile" color={c.paper} ink={c.ink} onPress={() => push('CoachProfile', { id: x.coach_id })} />
              </View>
            </Card>
          ))}
          {r.status === 'open' ? <Btn small title="Close this request" color={c.paper} ink={c.red} onPress={() => setClosing(true)} style={{ alignSelf: 'flex-start' }} /> : null}
          {r.status === 'filled' ? <Btn small title="Go to my coaching" onPress={() => goTab('Schedule', { section: 'coach' })} style={{ alignSelf: 'flex-start' }} /> : null}
        </Section>
      ) : (
        <Section title="Your answer">
          {r.my_response ? (
            <Card pad={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T weight="800" size={16}>{price(r.my_response.rate_cents_hour, r.my_response.currency ?? cur)}/hr</T><StatusPill s={r.my_response.status} /></View>
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
        body={accept ? `First session ${dateTimeIn(accept.proposed_starts_at, deviceTz)} for ${price(accept.first_session_cents, accept.currency ?? cur)}. The coach has already agreed, so it is confirmed as soon as you pay. Other coaches are told you chose someone else.` : ''} />
      <Confirm visible={closing} title="Close this request?" yes="Close request" danger onClose={() => setClosing(false)} onYes={close} body="Coaches with pending answers are told. The request stays in your history." />
      <Confirm visible={!!withdraw} title="Withdraw your answer?" yes="Withdraw" danger onClose={() => setWithdraw(null)} body="The athlete will no longer see it."
        onYes={async () => { try { await api.post(`/coach-responses/${withdraw.id}/withdraw`); setWithdraw(null); await q.reload(); toast('Answer withdrawn'); } catch (e) { toast(e.message); } }} />
      <AddCoachSportSheet visible={addSport} onClose={() => setAddSport(false)} initialSport={r.sport_slug} onDone={async () => { await refresh(); await q.reload(); }} />
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
  const move = async (reason) => {
    try { await api.patch(`/hires/${act.h.id}`, { status: act.status, ...(reason && act.status === 'cancelled' ? { reason } : {}) }); setAct(null); await reloadAll(); toast({ confirmed: 'Confirmed', completed: 'Marked complete — the athlete can now review', cancelled: 'Declined' }[act.status]); } catch (e) { toast(e.message); setAct(null); }
  };
  return (
    <Screen wide onRefresh={reloadAll}>
      <GradCard colors={grad.hero} style={{ marginTop: 8 }}>
        <T color="#fff" weight="700" size={11} style={{ letterSpacing: 2.5, opacity: 0.8 }}>COACH DESK</T>
        <T color="#fff" weight="800" size={24} style={{ marginTop: 2 }}>Your coaching, at a glance</T>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <Tile value={k.upcoming.length} label="UPCOMING" />
          <Tile value={k.to_confirm.length} label="TO CONFIRM" hot={k.to_confirm.length > 0} />
          <Tile value={price(k.earnings.earned_cents, cur)} label="EARNED" />
          <Tile value={price(k.earnings.awaiting_payment_cents, cur)} label="TO COLLECT" />
          <Tile value={k.rating.n ? `${Number(k.rating.avg).toFixed(1)}★` : '—'} label="RATING" />
        </View>
      </GradCard>
      <View style={{ marginTop: 14 }}><CoachToolGrid push={push} counts={{ board: k.board_open || null, reviews: k.unanswered_reviews.length || null, courts: k.upcoming.filter((h) => h.status === 'confirmed' && !h.venue).length || null }} /></View>
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
              <View style={{ flex: 1 }}><T weight="700">{p.counterparty_name}</T><T size={12} color={c.mute}>{p.sport_emoji} {p.sport} · {dateTimeIn(p.starts_at, deviceTz)}{p.paid_at ? ` · paid ${new Date(p.paid_at).toLocaleDateString(locale)}` : ''}</T></View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800">{price(p.total_cents, p.currency)}</T><StatusPill s={p.status === 'cancelled' && p.payment_status === 'unpaid' ? 'cancelled' : p.payment_status === 'not_required' ? 'pay_direct' : p.payment_status} /></View>
            </View>
          </Card>
        ))}
      </Section>

      <Confirm visible={!!act} title={act?.status === 'confirmed' ? 'Confirm this session?' : act?.status === 'completed' ? 'Mark as complete?' : 'Cancel this session?'} yes={act?.status === 'confirmed' ? 'Confirm' : act?.status === 'completed' ? 'Mark complete' : 'Cancel session'} danger={act?.status === 'cancelled'} askReason={act?.status === 'cancelled' ? 'Why is it being cancelled?' : undefined} onClose={() => setAct(null)} onYes={move}
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
          <T size={13} weight="700" style={{ marginTop: 8 }}>Coaching philosophy</T>
          <T size={13}>{pr.philosophy ?? 'Say how you coach and what you value. Athletes see it on your profile, and your AI drafts follow it.'}</T>
          {pr.coaching_styles?.length ? <T size={12} color={c.mute}>{pr.coaching_styles.map(styleName).join(' · ')}</T> : null}
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
          { key: 'philosophy', label: 'Your coaching philosophy', type: 'multiline', optional: true, hint: 'What you value and how you coach. Shown on your public profile; do not include player names.' },
          { key: 'coaching_styles', label: 'How you coach', type: 'multi', optional: true, options: COACHING_STYLES.map(([value, label]) => ({ value, label })) },
          { key: 'city', label: 'City or area', type: 'region', optional: true },
          { key: 'delivery', label: 'How you coach', type: 'choice', options: [{ value: 'in_person', label: 'In person' }, { value: 'online', label: 'Online' }, { value: 'both', label: 'Both' }] },
          { key: 'specialties', label: 'Specialities', optional: true, hint: 'Separate with commas.' }, { key: 'languages', label: 'Languages', optional: true, hint: 'Separate with commas.' },
          { key: 'timezone', label: 'Your time zone', type: 'timezone' },
          { key: 'slot_min', label: 'Session slot length', type: 'stepper', min: 15, max: 240, step: 15, default: 60, suffix: ' min' },
          { key: 'accepting', label: 'Taking new athletes', type: 'switch', default: true }, { key: 'listed', label: 'Show me in search', type: 'switch', default: true },
        ]}
        onSubmit={async (v) => {
          const list = (x) => (x ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          await api.post('/me/coach-profile', { tagline: v.tagline ?? null, intro_video_url: v.intro_video_url ?? null, serves: v.serves?.length ? v.serves : ['individual'], travel_km: v.travel_km || null, philosophy: v.philosophy ?? null, coaching_styles: v.coaching_styles ?? [], headline: v.headline ?? null, bio: v.bio ?? null, city: v.city ?? null, delivery: v.delivery, specialties: list(v.specialties), languages: list(v.languages), timezone: v.timezone, slot_min: v.slot_min, accepting: v.accepting, listed: v.listed });
          await d.reload(); return 'Profile saved';
        }} />
      <AddCoachSportSheet visible={addSport} onClose={() => setAddSport(false)} onDone={async () => { await refresh(); await d.reload(); }} />
    </Screen>
  );
}
