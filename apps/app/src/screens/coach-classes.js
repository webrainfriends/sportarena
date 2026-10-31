// Coach-led group classes (issue #656), one codebase for iOS, iPadOS, Android and web.
//   Athlete: ClassesFinder (a segment of Hire: find a class · my seats) -> CoachClass (join, pay, waitlist, leave).
//   Coach:   CoachClasses (publish and manage) -> CoachClass (roster, attendance, change, cancel). Rate cards stay in CoachRates.
// The screen only calls the API; seats, refunds, the waitlist and guardian rules are enforced on the server.
import React, { useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, H2, Loading, Screen, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { SportSelect } from '../sportpicker';
import { c, when } from '../theme';
import { t } from '../i18n';
import { moneyIn } from '../vtime';
import { Seats } from './find-games';
import { Confirm, Head } from './coaching';
import { Grid, PaySheet, useCols } from './marketplace';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const Wrap = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{children}</View>;
const cost = (k) => (k.price_cents ? moneyIn(k.price_cents, k.currency) : t('cc.free'));
const seatsOf = (k) => ({ max_players: k.seats.max, taken: k.seats.taken, slots_left: k.seats.left, is_full: k.seats.left === 0, waitlist: k.seats.waiting });
const hhmmIn = (iso, tz) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
const dateIn = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso));
const place = (k) => (k.delivery === 'online' ? t('cc.online') : k.venue ? `${k.venue.name}${k.venue.city ? `, ${k.venue.city}` : ''}` : k.location);

/** What the person's own seat says, as a label and a colour. */
export const SEAT = {
  confirmed: ['cc.seat.confirmed', c.mint], held: ['cc.seat.held', c.sun], waitlisted: ['cc.seat.waitlisted', c.sun], guardian_pending: ['cc.seat.guardian_pending', c.sun],
  cancelled: ['cc.seat.cancelled', c.red], expired: ['cc.seat.expired', c.red], removed: ['cc.seat.removed', c.red],
};
const seatLabel = (status) => (SEAT[status] ? t(SEAT[status][0]) : status);

function ClassCard({ k, width, mine, onOpen, coach }) {
  const seat = mine ?? k.my_seats?.[0];
  const st = seat && SEAT[seat.status];
  return (
    <View style={{ width }}>
      <Card onPress={onOpen} pad={16} accessibilityLabel={t('cc.card_a11y', { sport: k.sport.name, title: k.title, when: when(k.starts_at), left: k.seats.left })}>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <T size={22}>{k.sport.emoji}</T>
            <T weight="800" size={13} color={c.mute} style={{ flex: 1 }}>{k.sport.name} · {t('cc.minutes', { n: k.duration_min })}</T>
            {st ? <Tag label={t(st[0])} color={st[1]} /> : <Tag label={cost(k)} color={k.price_cents ? c.violetSoft : c.mint} />}
          </View>
          <T weight="800" size={17}>{k.title}</T>
          <T weight="700" color={c.pink}>{when(k.starts_at)}</T>
          <T size={13} color={c.mute}>{k.delivery === 'online' ? '💻' : '📍'} {place(k)} · {t('cc.with_coach', { name: k.coach.display_name })}</T>
          <Seats g={seatsOf(k)} />
          {k.status !== 'scheduled' ? <Tag label={k.status === 'cancelled' ? t('cc.seat.cancelled') : t('cc.finished')} color={c.red} /> : null}
          {coach && k.status === 'scheduled' && k.delivery === 'in_person' && !k.court_held ? <Tag label={t('cc.court_needed')} color={c.sun} /> : null}
        </View>
      </Card>
    </View>
  );
}

// ================================================================================== ATHLETE: FIND + MY SEATS
export function ClassesFinder() {
  const { push } = useNav();
  const { cols, w } = useCols();
  const [view, setView] = useState('find'), [sport, setSport] = useState(null), [delivery, setDelivery] = useState(null), [seatsOnly, setSeatsOnly] = useState(false);
  const found = useLoad(() => api.get('/coach-classes', { ...(sport ? { sport } : {}), ...(delivery ? { delivery } : {}), ...(seatsOnly ? { has_seats: true } : {}), limit: 50 }), [sport, delivery, seatsOnly]);
  const mine = useLoad(() => api.get('/me/coach-classes', { limit: 50 }), []);
  const list = view === 'find' ? found : mine;
  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      <Seg options={[{ value: 'find', label: t('cc.find') }, { value: 'mine', label: mine.data?.length ? t('cc.my_seats_n', { n: mine.data.length }) : t('cc.my_seats') }]} value={view} onChange={setView} />
      {view === 'find' ? (
        <View style={{ gap: 10 }}>
          <SportSelect label={t('cc.sport')} value={sport} onChange={setSport} optional allLabel={t('cc.all_sports')} />
          <Wrap>
            {[[null, 'cc.any'], ['in_person', 'cc.in_person'], ['online', 'cc.online']].map(([v, l]) => <Chip key={l} label={t(l)} active={delivery === v} onPress={() => setDelivery(v)} />)}
            <Chip label={t('cc.seats_available')} active={seatsOnly} onPress={() => setSeatsOnly(!seatsOnly)} />
          </Wrap>
        </View>
      ) : null}
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !list.data.length ? (
        view === 'find'
          ? <Empty emoji="🎽" title={t('cc.empty_find_title')} sub={t('cc.empty_find_sub')} />
          : <Empty emoji="🎟️" title={t('cc.empty_mine_title')} sub={t('cc.empty_mine_sub')} />
      ) : (
        <Grid>
          {list.data.map((x) => {
            const k = view === 'find' ? x : x.class;
            return <ClassCard key={x.seat_id ?? k.id} k={k} width={cols === 1 ? '100%' : w} mine={view === 'mine' ? x : undefined} onOpen={() => push('CoachClass', { id: k.id })} />;
          })}
        </Grid>
      )}
    </View>
  );
}

// ================================================================================== DETAIL (athlete, guardian and coach)
function JoinSheet({ k, kids, onClose, onDone }) {
  const { toast } = useSession();
  const [who, setWho] = useState(kids.length && k.audience === 'youth' ? kids[0].id : null);
  const key = useRef(`join-${k.id}-${Math.random().toString(36).slice(2, 10)}`);   // a retry of this tap never makes a second seat
  const full = k.seats.left === 0;
  const go = async () => {   // errors propagate so the sheet shows them (full, age band, consent…)
    const r = await api.post(`/coach-classes/${k.id}/join`, { ...(who ? { on_behalf_of: who } : {}), idempotency_key: key.current });
    toast({ confirmed: t('cc.toast.confirmed'), held: t('cc.toast.held'), waitlisted: t('cc.seat.waitlisted'), guardian_pending: t('cc.toast.guardian') }[r.status] ?? t('common.done'));
    onDone(r);
    return null;
  };
  return (
    <FormSheet visible onClose={onClose} title={full ? t('cc.join_waitlist') : t('cc.join_this')} submitLabel={full ? t('cc.join_waitlist_btn') : k.price_cents ? t('cc.hold_seat', { price: cost(k) }) : t('cc.join')}
      fields={[
        ...(kids.length ? [{ key: 'who', label: t('cc.who_joining'), type: 'custom', render: () => (
          <Wrap>{k.audience !== 'youth' ? <Chip label={t('cc.me')} active={!who} onPress={() => setWho(null)} /> : null}{kids.map((x) => <Chip key={x.id} label={t('cc.my_child', { name: x.display_name })} active={who === x.id} onPress={() => setWho(x.id)} />)}</Wrap>
        ) }] : []),
        { key: 'info', label: '', type: 'custom', render: () => (
          <T size={13} color={c.mute}>{full ? t('cc.info_full') : k.price_cents ? t('cc.info_paid') : t('cc.info_free')}</T>
        ) },
      ]}
      onSubmit={go} />
  );
}

const ROSTER = { confirmed: 'cc.roster.confirmed', held: 'cc.roster.held', waitlisted: 'cc.seat.waitlisted', guardian_pending: 'cc.seat.guardian_pending' };
function RosterRow({ r, started, onMark }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, flexWrap: 'wrap' }}>
      <Avatar user={r} size={34} />
      <View style={{ flex: 1, minWidth: 140 }}>
        <T weight="700" size={14}>{r.display_name}</T>
        <T size={12} color={c.mute}>{ROSTER[r.status] ? t(ROSTER[r.status]) : r.status}{r.payment_status === 'paid' ? ` · ${t('cc.paid')}` : ''}</T>
      </View>
      {r.status === 'confirmed' && started ? (
        <Wrap>
          <Chip label={t('cc.attended')} active={r.attendance === 'attended'} onPress={() => onMark(r, 'attended')} />
          <Chip label={t('cc.no_show')} active={r.attendance === 'no_show'} onPress={() => onMark(r, 'no_show')} />
        </Wrap>
      ) : null}
    </View>
  );
}

export function CoachClass({ id }) {
  const { user, toast } = useSession();
  const { push } = useNav();
  const cls = useLoad(() => api.get(`/coach-classes/${id}`), [id]);
  const links = useLoad(() => (user ? api.get('/youth/guardian-links', { limit: 100 }) : Promise.resolve([])), [user?.id]);
  const [join, setJoin] = useState(false), [paying, setPaying] = useState(null), [cancel, setCancel] = useState(false), [leaving, setLeaving] = useState(null), [edit, setEdit] = useState(false);
  const k = cls.data;
  if (cls.error) return <Screen><ErrorBox error={cls.error} onRetry={cls.reload} /></Screen>;
  if (!k) return <Screen><Loading /></Screen>;
  const kids = (links.data ?? []).filter((l) => l.my_side === 'guardian' && l.status === 'active' && l.child).map((l) => l.child);
  const isCoach = !!k.roster, started = new Date(k.starts_at) <= new Date(), open = k.status === 'scheduled' && !started;
  const live = (k.my_seats ?? []).filter((s) => ['guardian_pending', 'waitlisted', 'held', 'confirmed'].includes(s.status));
  const done = async () => { await cls.reload(); };
  const mark = async (r, attendance) => { try { await api.post(`/coach/classes/${k.id}/attendance`, { entries: [{ seat_id: r.seat_id, attendance }] }); await cls.reload(); } catch (e) { toast(e.message); } };
  const decide = async (s, approve) => {   // a guardian answers a young person's request; consent is checked on the server
    try { const r = await api.post(`/coach-class-seats/${s.seat_id}/guardian-decision`, { approve }); toast(approve ? (r.status === 'held' ? t('cc.approved_pay') : t('cc.approved')) : t('cc.declined')); await cls.reload(); } catch (e) { toast(e.message); }
  };
  const payTarget = (s) => ({ type: 'coach_class_seat', id: s.seat_id, label: `${k.title}${s.for_user ? ` · ${s.for_user.display_name}` : ''}`, amount: s.price_cents, currency: k.currency });
  const needed = Math.max(0, k.min_participants - k.seats.confirmed);
  return (
    <Screen wide onRefresh={cls.reload}>
      <Head eyebrow={`${k.sport.emoji} ${k.sport.name.toUpperCase()}`} title={k.title} sub={`${when(k.starts_at)} · ${t('cc.minutes', { n: k.duration_min })}`} />
      <View style={{ gap: 12, marginTop: 14 }}>
        {k.status === 'cancelled' ? <Card color={c.redSoft} pad={14}><T weight="800" color={c.red}>{k.cancelled_by === 'min_not_met' ? t('cc.cancelled_min') : t('cc.cancelled_note')}</T>{k.cancelled_reason ? <T size={13}>{k.cancelled_reason}</T> : null}</Card> : null}
        <Card pad={16}>
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Avatar user={{ ...k.coach, id: k.coach.id }} size={40} />
              <View style={{ flex: 1 }}>
                <T weight="800">{k.coach.display_name}</T>
                <T size={12} color={c.mute}>{t('cc.coach')}</T>
              </View>
              <Btn small title={t('cc.profile')} color={c.paper} ink={c.ink} onPress={() => push('CoachProfile', { id: k.coach.id })} />
            </View>
            <T size={14}>{k.delivery === 'online' ? '💻' : '📍'} {place(k)}</T>
            {k.online_link ? <Btn small title={t('cc.open_link')} onPress={() => Linking.openURL(k.online_link)} style={{ alignSelf: 'flex-start' }} /> : k.delivery === 'online' && open ? <T size={12} color={c.mute}>{t('cc.link_after')}</T> : null}
            <Wrap>
              <Tag label={cost(k)} color={k.price_cents ? c.violetSoft : c.mint} />
              {k.audience !== 'all' ? <Tag label={k.audience === 'youth' ? t('cc.young') : t('cc.adults')} color={c.cyan} /> : null}
              {k.min_age != null || k.max_age != null ? <Tag label={t('cc.ages', { range: `${k.min_age ?? 0}${k.max_age != null ? `–${k.max_age}` : '+'}` })} color={c.cyan} /> : null}
            </Wrap>
            <Seats g={seatsOf(k)} />
            <T size={13} color={c.mute}>{k.seats.confirmed >= k.min_participants ? t('cc.on', { n: k.min_participants }) : t(needed === 1 ? 'cc.needs_one' : 'cc.needs_many', { n: needed, when: when(k.cutoff_at) })}</T>
            {k.notes ? <T size={14}>{k.notes}</T> : null}
          </View>
        </Card>

        {live.map((s) => (
          <Card key={s.seat_id} pad={16} color={c.violetSoft}>
            <View style={{ gap: 8 }}>
              <T weight="800">{s.for_user ? `${s.for_user.display_name}: ` : ''}{seatLabel(s.status)}{s.status === 'waitlisted' && s.position ? ` · #${s.position}` : ''}</T>
              {s.status === 'held' ? <T size={13} color={c.mute}>{t('cc.pay_by', { when: when(s.pay_by) })}</T> : null}
              {s.status === 'confirmed' && k.price_cents ? <T size={13} color={c.mute}>{t('cc.leave_refund', { when: when(k.cutoff_at) })}</T> : null}
              <Wrap>
                {s.status === 'guardian_pending' && s.for_user ? <Btn title={t('cc.approve')} onPress={() => decide(s, true)} /> : null}
                {s.status === 'guardian_pending' && s.for_user ? <Btn title={t('cc.decline')} color={c.paper} ink={c.ink} onPress={() => decide(s, false)} /> : null}
                {s.status === 'held' ? <Btn title={t('cc.pay', { price: moneyIn(s.price_cents, k.currency) })} onPress={() => setPaying(payTarget(s))} /> : null}
                {open && s.status !== 'guardian_pending' ? <Btn title={s.status === 'waitlisted' ? t('cc.leave_waitlist') : t('cc.give_up')} color={c.paper} ink={c.ink} onPress={() => setLeaving(s)} /> : null}
              </Wrap>
            </View>
          </Card>
        ))}

        {!isCoach && open && !live.length ? (
          <Btn title={k.seats.left === 0 ? t('cc.join_waitlist') : k.price_cents ? t('cc.join_price', { price: cost(k) }) : t('cc.join_free')} accessibilityLabel={t('cc.join_this')} onPress={() => (user ? setJoin(true) : toast(t('cc.sign_in')))} />
        ) : null}
        {!isCoach && open && live.length && kids.length ? <Btn title={t('cc.book_child')} color={c.paper} ink={c.ink} onPress={() => setJoin(true)} /> : null}

        {isCoach ? (
          <Card pad={16}>
            <H2>{t('cc.who_coming', { taken: k.seats.taken, max: k.max_participants })}</H2>
            <View style={{ marginVertical: 8 }}>{k.roster.length ? k.roster.map((r) => <RosterRow key={r.seat_id} r={r} started={started} onMark={mark} />) : <T size={13} color={c.mute}>{t('cc.nobody')}</T>}</View>
            {k.pending_refunds ? <T size={13} color={c.red} style={{ marginTop: 6 }}>{t('cc.refunds_pending', { n: k.pending_refunds })}</T> : null}
            {k.delivery === 'in_person' && k.status === 'scheduled' ? (
              <View style={{ gap: 6 }}>
                <T size={13} weight="700" color={k.court_held ? c.mint : c.sun}>{k.court_held ? t('cc.court_held') : t('cc.court_none')}</T>
                {!k.court_held ? <Btn small title={t('cc.court_book')} accessibilityLabel={t('cc.court_book')} onPress={() => push('TrainingVenue', { ids: [k.id] })} style={{ alignSelf: 'flex-start' }} /> : null}
              </View>
            ) : null}
            <Wrap>
              {k.status === 'scheduled' ? <Btn small title={t('cc.change')} onPress={() => setEdit(true)} /> : null}
              {k.status !== 'cancelled' ? <Btn small title={t('cc.open_studio')} color={c.paper} ink={c.ink} onPress={() => push('CoachSession', { source_type: 'coach_class', source_id: k.id })} /> : null}
              {k.status === 'scheduled' ? <Btn small title={t('cc.cancel_class')} color={c.red} onPress={() => setCancel(true)} /> : null}
            </Wrap>
          </Card>
        ) : null}
      </View>

      {join ? <JoinSheet k={k} kids={kids} onClose={() => setJoin(false)} onDone={async (r) => { setJoin(false); await done(); if (r.status === 'held') setPaying(payTarget({ ...r, for_user: null })); }} /> : null}
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={done} /> : null}
      <Confirm visible={!!leaving} title={t('cc.give_up_q')} yes={t('cc.give_up_yes')} danger onClose={() => setLeaving(null)}
        body={leaving?.status === 'confirmed' && k.price_cents ? (new Date() < new Date(k.cutoff_at) ? t('cc.give_up_body_refund') : t('cc.give_up_body_late')) : t('cc.give_up_body')}
        onYes={async () => { try { await api.post(`/coach-classes/${k.id}/leave`, leaving.for_user ? { on_behalf_of: leaving.for_user.id } : {}); toast(t('cc.seat.expired')); setLeaving(null); await done(); } catch (e) { toast(e.message); } }} />
      <Confirm visible={cancel} title={t('cc.cancel_q')} yes={t('cc.cancel_class')} danger askReason={t('cc.cancel_reason')} onClose={() => setCancel(false)}
        body={t('cc.cancel_body', { n: k.roster?.filter((r) => r.payment_status === 'paid').length ?? 0 })}
        onYes={async (reason) => { try { await api.post(`/coach/classes/${k.id}/cancel`, { reason }); toast(t('cc.class_cancelled')); setCancel(false); await done(); } catch (e) { toast(e.message); } }} />
      {edit ? (
        <FormSheet visible onClose={() => setEdit(false)} title={t('cc.change_title')} submitLabel={t('common.save')} initial={{ max_participants: k.max_participants, min_participants: k.min_participants, notes: k.notes ?? undefined, location: k.location ?? undefined }}
          fields={[
            { key: 'max_participants', label: t('cc.seats'), type: 'stepper', min: 1, max: 500, hint: t('cc.seats_hint') },
            { key: 'min_participants', label: t('cc.minimum'), type: 'stepper', min: 1, max: 500 },
            ...(k.delivery === 'in_person' ? [{ key: 'location', label: t('cc.meeting_point'), optional: true }] : [{ key: 'online_link', label: t('cc.new_link'), type: 'text', optional: true }]),
            { key: 'notes', label: t('cc.notes'), type: 'multiline', optional: true },
          ]}
          onSubmit={async (v) => { await api.patch(`/coach/classes/${k.id}`, v); await done(); return t('cc.saved'); }} />
      ) : null}
    </Screen>
  );
}

// ================================================================================== COACH: PUBLISH + MANAGE
const CUTOFFS = () => [2, 6, 12, 24, 48].map((h) => ({ value: h, label: t('cc.cutoff_h', { h }) }));

/** Publish one class, or a weekly series, from a group rate card. The venue list only holds venues that have a court for the card's sport. */
export function PublishClassSheet({ card, onClose, onDone }) {
  const { toast } = useSession();
  const sport = card.sport_slug;
  const max = card.max_participants ?? 12;
  const perSeat = (v) => (card.per_person ? card.price_cents : Math.ceil(card.price_cents / Math.max(1, v.max_participants ?? max)));
  return (
    <FormSheet visible onClose={onClose} title={t('cc.publish_title', { card: card.title })} submitLabel={t('cc.publish')}
      initial={{ title: card.title, delivery: card.delivery === 'online' ? 'online' : 'in_person', max_participants: Math.min(max, 12), min_participants: Math.max(card.min_participants, 1), cutoff_hours: 12, audience: 'all', repeat: false, weeks: 4 }}
      fields={[
        { key: 'title', label: t('cc.class_name') },
        ...(card.sport_slug ? [] : [{ key: 'sport', label: t('cc.sport'), type: 'sport' }]),
        { key: 'starts_at', label: t('cc.starts'), type: 'datetime', min: new Date().toISOString(), step: 15 },
        { key: 'repeat', label: t('cc.repeat'), type: 'switch' },
        { key: 'weeks', label: t('cc.weeks'), type: 'stepper', min: 2, max: 26, default: 4, show: (v) => v.repeat },
        ...(card.delivery === 'both' ? [{ key: 'delivery', label: t('cc.where'), type: 'choice', options: [{ value: 'in_person', label: t('cc.in_person') }, { value: 'online', label: t('cc.online') }] }] : []),
        { key: 'venue', label: t('cc.venue'), type: 'multimenu', max: 1, optional: true, placeholder: t('cc.choose_venue'), show: (v) => v.delivery !== 'online',
          hint: sport ? t('cc.venue_hint_sport') : t('cc.venue_hint_any'),
          load: async (q) => (await api.get('/venues', { ...(sport ? { sport } : {}), ...(q ? { q } : {}), limit: 20 })).map((x) => ({ value: x.id, label: x.name, sub: x.city })) },
        { key: 'location', label: t('cc.or_meeting'), optional: true, show: (v) => v.delivery !== 'online', hint: t('cc.meeting_hint') },
        { key: 'online_link', label: t('cc.class_link'), input: 'url', placeholder: 'https://', show: (v) => v.delivery === 'online' },
        { key: 'max_participants', label: t('cc.seats'), type: 'stepper', min: 1, max: card.max_participants ?? 500, default: Math.min(max, 12) },
        { key: 'min_participants', label: t('cc.minimum'), type: 'stepper', min: Math.max(card.min_participants, 1), max: 500, default: 1 },
        { key: 'cutoff_hours', label: t('cc.decide'), type: 'chips', options: CUTOFFS(), hint: t('cc.decide_hint') },
        { key: 'audience', label: t('cc.who_can'), type: 'choice', options: [{ value: 'all', label: t('cc.everyone') }, { value: 'adults', label: t('cc.adults') }, { value: 'youth', label: t('cc.young') }] },
        { key: 'price', label: '', type: 'custom', render: ({ v }) => <T size={13} color={c.mute}>{t('cc.each_seat', { price: perSeat(v) ? moneyIn(perSeat(v), card.currency) : t('cc.nothing_free') })}</T> },
        { key: 'notes', label: t('cc.notes'), type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => {
        const online = v.delivery === 'online';
        const base = {
          rate_card_id: card.id, title: v.title, delivery: v.delivery ?? 'in_person', max_participants: v.max_participants, min_participants: v.min_participants, cutoff_hours: v.cutoff_hours, audience: v.audience,
          ...(card.sport_slug ? {} : { sport: v.sport }), ...(v.notes ? { notes: v.notes } : {}),
          ...(online ? { online_link: v.online_link } : { ...(v.venue?.[0] ? { venue_id: v.venue[0] } : {}), ...(v.location ? { location: v.location } : {}) }),
        };
        if (!v.starts_at) throw new Error(t('cc.pick_start'));
        const body = v.repeat
          ? { ...base, repeat: { start: hhmmIn(v.starts_at, deviceTz), timezone: deviceTz, starts_on: dateIn(v.starts_at, deviceTz), count: v.weeks, weekdays: [new Date(v.starts_at).getDay()] } }
          : { ...base, starts_at: v.starts_at };
        const r = await api.post('/coach/classes', body);
        await onDone?.(r);
        toast(r.skipped.length ? t('cc.published_skipped', { n: r.classes.length, skipped: r.skipped.length }) : r.classes.length > 1 ? t('cc.published_many', { n: r.classes.length }) : t('cc.published_one'));
        return null;
      }} />
  );
}

export function CoachClasses() {
  const { push } = useNav();
  const { cols, w } = useCols();
  const [when2, setWhen] = useState('upcoming'), [pick, setPick] = useState(false), [card, setCard] = useState(null);
  const list = useLoad(() => api.get('/coach/classes', { when: when2, limit: 100 }), [when2]);
  const cards = useLoad(() => api.get('/coach/rate-cards'), []);
  const groups = (cards.data ?? []).filter((x) => x.audience === 'group' && x.active);
  return (
    <Screen wide onRefresh={list.reload}>
      <Head eyebrow={t('cc.eyebrow')} title={t('cc.your_classes')} sub={t('cc.your_classes_sub')}
        right={<Btn small title={t('cc.publish_btn')} onPress={() => (groups.length === 1 ? setCard(groups[0]) : setPick(true))} />} />
      <View style={{ marginTop: 14 }}><Seg options={[{ value: 'upcoming', label: t('cc.upcoming') }, { value: 'past', label: t('cc.past') }]} value={when2} onChange={setWhen} /></View>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !list.data.length ? (
        <Empty emoji="🎽" title={when2 === 'upcoming' ? t('cc.none_scheduled') : t('empty.nothing')} sub={groups.length || cards.loading ? t('cc.empty_coach_a') : t('cc.empty_coach_b')} />
      ) : (
        <Grid>{list.data.map((k) => <ClassCard key={k.id} k={k} coach width={cols === 1 ? '100%' : w} onOpen={() => push('CoachClass', { id: k.id })} />)}</Grid>
      )}
      {!groups.length && !cards.loading ? <Btn title={t('cc.add_card')} color={c.paper} ink={c.ink} onPress={() => push('CoachRates')} style={{ marginTop: 14 }} /> : null}
      <FormSheet visible={pick} onClose={() => setPick(false)} title={t('cc.which_card')} submitLabel={t('common.next')} initial={{}}
        fields={[{ key: 'card', label: t('cc.group_card'), type: 'chips', options: groups.map((x) => ({ value: x.id, label: x.title })) }]}
        onSubmit={async (v) => { setPick(false); setCard(groups.find((x) => x.id === v.card)); return null; }} />
      {card ? <PublishClassSheet card={card} onClose={() => setCard(null)} onDone={async () => { setCard(null); await list.reload(); }} /> : null}
    </Screen>
  );
}
