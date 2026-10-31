// Coach-published group classes (#656). One module, three entry points that share the same card and sheet: the coach's "My classes" desk
// (publish, seats, attendance, cancel), a coach's upcoming classes on their profile, and the class sheet athletes join, pay and leave from.
// Everything is the shared cross-platform kit (no web-only APIs); all text goes through t(); layouts use start/end so Urdu flips cleanly.
import React, { useState } from 'react';
import { Linking, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Screen, Seg, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { Pill } from './marketplace';
import { t } from '../i18n';
import { c, when } from '../theme';
import { moneyIn } from '../vtime';

const LEVEL_KEYS = ['beginner', 'amateur', 'semi_pro', 'pro'];
const STATUS_TONE = { confirmed: c.mint, held: c.sun, waitlisted: c.sun, guardian_pending: c.sun, cancelled: c.violetSoft, declined: c.red };

/** Seat dots (filled = taken), capped at 12 so a phone stays readable, with the live count beside them. */
export function ClassSeats({ k }) {
  const n = Math.min(k.max_participants, 12), filled = Math.min(k.taken, n);
  const label = k.is_full ? `${t('cls.full')}${k.waitlist ? ` · ${t('cls.waiting', { n: k.waitlist })}` : ''}` : (k.seats_left === 1 ? t('cls.one_seat_left') : t('cls.seats_left', { n: k.seats_left }));
  return (
    <View accessible accessibilityLabel={t('cls.seats_a11y', { taken: k.taken, max: k.max_participants })} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>{Array.from({ length: n }, (_, i) => <View key={i} style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: i < filled ? c.ink : 'transparent', borderWidth: 1.5, borderColor: c.ink }} />)}</View>
      <T size={13} weight="700" color={k.is_full ? c.red : c.ink}>{label}</T>
    </View>
  );
}

const priceText = (k) => (k.price_cents > 0 ? t('cls.per_seat', { price: moneyIn(k.price_cents, k.currency) }) : t('cls.free'));
const whereText = (k) => (k.place ? [k.place.name, k.place.city].filter(Boolean).join(', ') : t('cls.online'));
const levelText = (k) => (k.skill.min || k.skill.max ? [k.skill.min, k.skill.max].filter(Boolean).map((x) => t(`cls.level.${x}`)).join(' – ') : t('cls.all_levels'));

export function ClassCard({ k, width, onOpen }) {
  return (
    <Card pad={14} onPress={() => onOpen(k)} style={width ? { width } : undefined} accessibilityLabel={`${k.title}, ${when(k.starts_at)}, ${t('cls.open')}`}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
          <T weight="800" size={16} style={{ flex: 1 }}>{k.sport_emoji} {k.title}</T>
          <T weight="800" size={14} color={k.price_cents > 0 ? c.ink : c.mint}>{priceText(k)}</T>
        </View>
        <T size={13} color={c.mute}>{when(k.starts_at)} · {k.duration_min} {t('cls.min')}</T>
        <T size={13} color={c.mute} numberOfLines={1}>{k.is_online ? '💻 ' : '📍 '}{whereText(k)}</T>
        <ClassSeats k={k} />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Pill label={levelText(k).toUpperCase()} />
          {k.is_last_seats ? <Pill label={t('cls.last_seats').toUpperCase()} fg={c.red} bg={c.sunSoft} /> : null}
          {k.status === 'cancelled' ? <Pill label={t('cls.cancelled').toUpperCase()} fg={c.red} bg={c.sunSoft} /> : null}
          {!k.will_run && k.status === 'open' ? <Pill label={t('cls.needs_more', { n: k.needs_participants }).toUpperCase()} /> : null}
        </View>
        <T size={12} color={c.mute}>{k.coach.display_name}</T>
      </View>
    </Card>
  );
}

/** The class as the signed-in person sees it: join / leave / pay for athletes, seats + attendance + cancel for the coach. */
export function ClassSheet({ id, onClose, onChanged }) {
  const { user, toast } = useSession();
  const d = useLoad(() => api.get(`/coach/classes/${id}`), [id]);
  const [busy, setBusy] = useState(false), [pay, setPay] = useState(null), [cancelling, setCancelling] = useState(false);
  const k = d.data;
  const reload = async () => { await d.reload(); onChanged?.(); };
  const act = async (fn, ok) => { setBusy(true); try { const r = await fn(); if (ok) toast(ok); await reload(); return r; } catch (e) { toast(e.message ?? t('error.generic')); } finally { setBusy(false); } };
  if (!k) return <Sheet visible onClose={onClose} title={t('cls.open')}>{d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : <Loading />}</Sheet>;
  const mine = k.my.find((m) => !['cancelled', 'declined'].includes(m.status));
  const started = new Date(k.starts_at) <= new Date();
  const payNow = (m) => setPay({ type: 'coach_class_seat', id: m.seat_id, label: k.title, amount: m.amount_cents, currency: k.currency });
  return (
    <Sheet visible onClose={onClose} title={k.title}>
      <View style={{ gap: 12 }}>
        <T color={c.mute}>{k.sport_emoji} {k.sport} · {when(k.starts_at)} · {k.duration_min} {t('cls.min')}</T>
        <T color={c.mute}>{k.is_online ? '💻 ' : '📍 '}{whereText(k)}</T>
        <ClassSeats k={k} />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Pill label={priceText(k).toUpperCase()} /><Pill label={levelText(k).toUpperCase()} />
          <Pill label={(k.will_run ? t('cls.will_run') : t('cls.needs_more', { n: k.needs_participants })).toUpperCase()} fg={k.will_run ? c.mint : c.mute} />
        </View>
        {k.notes ? <T size={14}>{k.notes}</T> : null}
        <T size={12} color={c.mute}>{t('cls.min_note', { n: k.min_participants })} · {t('cls.cancel_policy', { h: k.cancel_before_hours })}</T>

        {k.status === 'cancelled' ? <T weight="700" color={c.red}>{t('cls.cancelled')}{k.cancelled_reason ? `: ${k.cancelled_reason}` : ''}</T> : null}
        {k.online_url ? <Btn small title={t('cls.open_link')} color={c.violet} onPress={() => Linking.openURL(k.online_url)} /> : null}

        {!k.can_manage && k.status === 'open' ? (
          <View style={{ gap: 8 }}>
            {mine ? (
              <>
                <Pill label={t(`cls.status.${mine.status}`).toUpperCase()} fg="#fff" bg={STATUS_TONE[mine.status] ?? c.violet} />
                {mine.status === 'held' ? <T size={13} color={c.mute}>{t('cls.held_until', { time: when(mine.hold_expires_at) })}</T> : null}
                {mine.status === 'held' ? <Btn title={t('cls.pay_seat')} loading={busy} onPress={() => payNow(mine)} /> : null}
                {!started ? <Btn small title={t('cls.leave')} color={c.paper} ink={c.ink} loading={busy} onPress={() => act(() => api.post(`/coach/classes/${k.id}/leave`), t('cls.left'))} /> : null}
              </>
            ) : <Btn title={k.is_full ? t('cls.join_waitlist') : t('cls.join')} loading={busy} disabled={started || user?.id === k.coach.id} onPress={async () => {
              const r = await act(() => api.post(`/coach/classes/${k.id}/join`, { idempotency_key: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` }), null);
              if (r?.status === 'held') payNow(r);
            }} />}
          </View>
        ) : null}

        {k.can_manage ? (
          <View style={{ gap: 10 }}>
            <T weight="800">{t('cls.attendance')}</T>
            {(k.seats ?? []).filter((s) => !['cancelled', 'declined'].includes(s.status)).length === 0 ? <T color={c.mute}>{t('cls.no_seats')}</T> : null}
            {(k.seats ?? []).filter((s) => !['cancelled', 'declined'].includes(s.status)).map((s) => (
              <View key={s.seat_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <T weight="700" style={{ flex: 1, minWidth: 120 }}>{s.person.display_name}{s.person.is_youth ? ` · ${t('cls.young')}` : ''}</T>
                <Pill label={t(`cls.status.${s.status}`).toUpperCase()} fg="#fff" bg={STATUS_TONE[s.status] ?? c.violet} />
                {s.status === 'confirmed' && started && k.status !== 'cancelled' ? (
                  <>
                    <Btn small title={t('cls.attended')} color={s.attendance === 'attended' ? c.mint : c.paper} ink={c.ink} onPress={() => act(() => api.post(`/coach/classes/${k.id}/seats/${s.seat_id}/attendance`, { attendance: 'attended' }))} />
                    <Btn small title={t('cls.no_show')} color={s.attendance === 'no_show' ? c.red : c.paper} ink={c.ink} onPress={() => act(() => api.post(`/coach/classes/${k.id}/seats/${s.seat_id}/attendance`, { attendance: 'no_show' }))} />
                  </>
                ) : null}
              </View>
            ))}
            {k.status === 'open' ? (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {started ? <Btn small title={t('cls.complete')} color={c.violet} loading={busy} onPress={() => act(() => api.post(`/coach/classes/${k.id}/complete`), t('cls.completed'))} /> : null}
                <Btn small title={t('cls.cancel_class')} color={c.red} onPress={() => setCancelling(true)} />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      {cancelling ? (
        <FormSheet visible onClose={() => setCancelling(false)} title={t('cls.cancel_class')} submitLabel={t('cls.cancel_class')} color={c.red} notice={t('cls.cancel_notice')}
          fields={[{ key: 'reason', label: t('cls.reason'), type: 'multiline' }]}
          onSubmit={async (v) => { await api.post(`/coach/classes/${k.id}/cancel`, { reason: v.reason }); await reload(); return t('cls.cancelled'); }} />
      ) : null}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={reload} /> : null}
    </Sheet>
  );
}

function PublishSheet({ cards, currency, onClose, onDone }) {
  const byId = Object.fromEntries(cards.map((x) => [x.id, x]));
  return (
    <FormSheet visible onClose={onClose} title={t('cls.publish')} submitLabel={t('cls.publish')}
      initial={{ rate_card_id: cards[0]?.id, where: 'venue', max_participants: cards[0]?.max_participants ?? 10, min_participants: cards[0]?.min_participants ?? 1, cancel_before_hours: 12, min_cutoff_hours: 12, audience: 'adults' }}
      fields={[
        { key: 'rate_card_id', label: t('cls.rate_card'), type: 'chips', options: cards.map((x) => ({ value: x.id, label: x.title })) },
        { key: 'starts_at', label: t('cls.starts'), type: 'datetime', min: new Date().toISOString(), step: 15 },
        { key: 'where', label: t('cls.where'), type: 'choice', options: [{ value: 'venue', label: t('cls.venue') }, { value: 'online', label: t('cls.online') }] },
        { key: 'venue_id', label: t('cls.venue'), type: 'multimenu', max: 1, placeholder: t('cls.search_venue'), show: (v) => v.where === 'venue', load: async (q) => (await api.get('/venues', { q, limit: 20 })).map((x) => ({ value: x.id, label: x.name, sub: x.city })) },
        { key: 'online_url', label: t('cls.online_link'), show: (v) => v.where === 'online', hint: 'https://' },
        { key: 'max_participants', label: t('cls.seats'), type: 'stepper', min: 1, max: 500, default: 10 },
        { key: 'min_participants', label: t('cls.min_people'), type: 'stepper', min: 1, max: 500, default: 1 },
        { key: 'skill', label: t('cls.level'), type: 'multimenu', optional: true, options: LEVEL_KEYS.map((x) => ({ value: x, label: t(`cls.level.${x}`) })) },
        { key: 'audience', label: t('cls.audience'), type: 'chips', options: ['adults', 'all_ages', 'youth'].map((x) => ({ value: x, label: t(`cls.audience.${x}`) })) },
        { key: 'cancel_before_hours', label: t('cls.refund_until'), type: 'stepper', min: 0, max: 720, step: 1, default: 12, suffix: ' h' },
        { key: 'min_cutoff_hours', label: t('cls.cutoff'), type: 'stepper', min: 0, max: 720, step: 1, default: 12, suffix: ' h' },
        { key: 'notes', label: t('cls.notes'), type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => {
        const lv = (v.skill ?? []).slice().sort((a, b) => LEVEL_KEYS.indexOf(a) - LEVEL_KEYS.indexOf(b));
        const card = byId[v.rate_card_id];
        await api.post('/coach/classes', {
          rate_card_id: v.rate_card_id, starts_at: v.starts_at, max_participants: v.max_participants, min_participants: Math.min(v.min_participants, v.max_participants), audience: v.audience,
          cancel_before_hours: v.cancel_before_hours, min_cutoff_hours: v.min_cutoff_hours, ...(card?.sport ? {} : {}),
          ...(v.where === 'venue' ? { venue_id: v.venue_id?.[0] } : { online_url: v.online_url }), ...(lv.length ? { skill_min: lv[0], skill_max: lv[lv.length - 1] } : {}), ...(v.notes ? { notes: v.notes } : {}),
        });
        await onDone(); return t('cls.published');
      }} />
  );
}

// local header (importing Head from coaching.js would be a cycle: the coach profile there shows these classes)
const Head = ({ eyebrow, title, sub, right }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
    <View style={{ flexShrink: 1 }}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{eyebrow}</T>
      <H1 style={{ fontSize: 28 }}>{title}</H1>
      {sub ? <T size={14} color={c.mute} style={{ marginTop: 2 }}>{sub}</T> : null}
    </View>
    {right}
  </View>
);

/** The coach's "My classes" desk. */
export function CoachClasses() {
  const { user } = useSession();
  const [tab, setTab] = useState('open'), [open, setOpen] = useState(null), [publish, setPublish] = useState(false);
  const list = useLoad(() => api.get('/coach/classes', { mine: true, status: tab, limit: 100 }), [tab]);
  const cards = useLoad(() => api.get('/coach/rate-cards'), []);
  const groupCards = (cards.data?.items ?? cards.data ?? []).filter((x) => x.audience === 'group' && x.active && !x.archived_at);
  const mine = (list.data ?? []).filter((k) => k.coach.id === user.id);
  return (
    <Screen onRefresh={list.reload}>
      <Head eyebrow={t('cls.eyebrow')} title={t('cls.my_title')} sub={t('cls.my_sub')} right={<Btn title={t('cls.publish')} disabled={!groupCards.length} onPress={() => setPublish(true)} accessibilityLabel={t('cls.publish')} />} />
      {cards.data && !groupCards.length ? <Card color={c.sunSoft} pad={14} style={{ marginTop: 12 }}><T>{t('cls.need_card')}</T></Card> : null}
      <View style={{ marginTop: 14 }}><Seg value={tab} onChange={setTab} options={[{ value: 'open', label: t('cls.upcoming') }, { value: 'completed', label: t('cls.past') }, { value: 'cancelled', label: t('cls.cancelled') }]} /></View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !mine.length ? <Empty title={t('cls.empty_coach')} /> : (
        <View style={{ marginTop: 14, gap: 12, flexDirection: 'row', flexWrap: 'wrap' }}>
          {mine.map((k) => <View key={k.id} style={{ flexGrow: 1, flexBasis: 320, maxWidth: 560 }}><ClassCard k={k} onOpen={() => setOpen(k.id)} /></View>)}
        </View>
      )}
      {open ? <ClassSheet id={open} onClose={() => setOpen(null)} onChanged={list.reload} /> : null}
      {publish ? <PublishSheet cards={groupCards} currency={user.currency} onClose={() => setPublish(false)} onDone={async () => { setPublish(false); await list.reload(); }} /> : null}
    </Screen>
  );
}

/** A coach's upcoming public classes, for their profile. Seat counts only. */
export function CoachClassList({ coachId }) {
  const [open, setOpen] = useState(null);
  const list = useLoad(() => api.get('/coach/classes', { coach_id: coachId, limit: 20 }), [coachId]);
  if (!list.data?.length) return null;
  return (
    <View style={{ marginTop: 28, gap: 10 }}>
      <T weight="800" size={18}>{t('cls.upcoming_classes')}</T>
      <View style={{ gap: 12, flexDirection: 'row', flexWrap: 'wrap' }}>{list.data.map((k) => <View key={k.id} style={{ flexGrow: 1, flexBasis: 300, maxWidth: 520 }}><ClassCard k={k} onOpen={() => setOpen(k.id)} /></View>)}</View>
      {open ? <ClassSheet id={open} onClose={() => setOpen(null)} onChanged={list.reload} /> : null}
    </View>
  );
}
