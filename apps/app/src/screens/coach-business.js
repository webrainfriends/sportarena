// The coach as a business: rate cards and specialisations, contracts & commitments with a delivery log, testimonials in both
// directions, and analytics with a downloadable statement. Reached from the Coach desk.
import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Loading, Screen, Section, Seg, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Pill, StatusPill, nice } from './marketplace';
import { AUDIENCES, Confirm, Head, Tile, UNIT, cardPrice, price } from './coaching';
import { c } from '../theme';
import { addDays, moneyIn, todayIn, WEEKDAYS } from '../vtime';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'].map((value) => ({ value, label: nice(value).replace(/^./, (x) => x.toUpperCase()) }));
const UNITS = [['hour', 'Per hour'], ['session', 'Per session'], ['day', 'Per day'], ['month', 'Per month'], ['package', 'Package']].map(([value, label]) => ({ value, label }));
const KINDS = [['contract', 'Contract'], ['retainer', 'Retainer'], ['team', 'Team season'], ['event', 'Event engagement'], ['personal', 'Personal'], ['block', 'Blocked time']].map(([value, label]) => ({ value, label }));
const dayText = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const Stars = ({ value, size = 13 }) => <T size={size} color={c.sun} weight="800">{'★'.repeat(Math.round(value))}{'☆'.repeat(5 - Math.round(value))}</T>;

// ================================================================================== RATE CARDS + SPECIALISATIONS
function CardSheet({ card, specs, currency, onClose, onDone }) {
  const edit = !!card;
  return (
    <FormSheet visible onClose={onClose} title={edit ? 'Edit rate card' : 'New rate card'} submitLabel={edit ? 'Save changes' : 'Add rate card'}
      initial={edit ? { ...card, sport: card.sport_slug ?? undefined, specialisation_id: card.specialisation_id ?? undefined, description: card.description ?? undefined } : { audience: 'individual', delivery: 'in_person', unit: 'hour', duration_min: 60, min_participants: 1, max_participants: 20, sessions_included: 5, active: true }}
      fields={[
        { key: 'title', label: 'Name of this service' },
        { key: 'audience', label: 'Who it is for', type: 'chips', options: AUDIENCES.map(([value, label]) => ({ value, label })) },
        { key: 'sport', label: 'Sport', type: 'sport', optional: true, hint: 'Leave empty for any sport you coach.' },
        ...(specs.length ? [{ key: 'specialisation_id', label: 'Specialisation', type: 'chips', optional: true, options: specs.map((z) => ({ value: z.id, label: z.name })) }] : []),
        { key: 'delivery', label: 'Where', type: 'choice', options: [{ value: 'in_person', label: 'In person' }, { value: 'online', label: 'Online' }, { value: 'both', label: 'Both' }] },
        { key: 'unit', label: 'Priced', type: 'chips', options: UNITS },
        { key: 'price_cents', label: 'Price', type: 'money', currency },
        { key: 'per_person', label: 'Price is per person', type: 'switch', show: (v) => v.audience === 'group' || v.audience === 'event' },
        { key: 'duration_min', label: 'Session length', type: 'stepper', min: 15, max: 1440, step: 15, default: 60, suffix: ' min', show: (v) => v.unit === 'session' || v.unit === 'day' },
        { key: 'min_participants', label: 'Fewest people', type: 'stepper', min: 1, max: 500, default: 1, show: (v) => v.audience !== 'individual' },
        { key: 'max_participants', label: 'Most people', type: 'stepper', min: 1, max: 500, default: 20, show: (v) => v.audience !== 'individual' },
        { key: 'sessions_included', label: 'Sessions in the package', type: 'stepper', min: 1, max: 500, default: 5, show: (v) => v.unit === 'package' },
        { key: 'is_intro', label: 'This is a trial / introductory offer', type: 'switch' },
        { key: 'description', label: 'What is included', type: 'multiline', optional: true },
        { key: 'active', label: 'Available to book', type: 'switch', default: true },
      ]}
      onSubmit={async (v) => {
        const body = { title: v.title, audience: v.audience, delivery: v.delivery, unit: v.unit, price_cents: v.price_cents, per_person: !!v.per_person && (v.audience === 'group' || v.audience === 'event'), is_intro: !!v.is_intro, active: v.active !== false,
          ...(v.sport ? { sport: v.sport } : {}), ...(v.specialisation_id ? { specialisation_id: v.specialisation_id } : {}), ...(v.description ? { description: v.description } : {}),
          ...(v.unit === 'session' || v.unit === 'day' ? { duration_min: v.duration_min } : {}), ...(v.unit === 'package' ? { sessions_included: v.sessions_included } : {}),
          ...(v.audience !== 'individual' ? { min_participants: v.min_participants, max_participants: v.max_participants } : { min_participants: 1 }) };
        if (edit) await api.patch(`/coach/rate-cards/${card.id}`, body); else await api.post('/coach/rate-cards', body);
        await onDone(); return edit ? 'Saved — applies to new bookings' : 'Rate card added';
      }} />
  );
}

function SpecSheet({ spec, onClose, onDone }) {
  return (
    <FormSheet visible onClose={onClose} title={spec ? 'Edit specialisation' : 'New specialisation'} submitLabel="Save" initial={spec ? { ...spec, sport: spec.sport_slug, certification: spec.certification ?? undefined, years: spec.years ?? 1 } : { years: 1, levels: [] }}
      fields={[
        { key: 'sport', label: 'Sport', type: 'sport' }, { key: 'name', label: 'Focus', hint: 'The part of the sport you are known for.' },
        { key: 'levels', label: 'Levels you coach', type: 'multi', options: LEVELS, optional: true },
        { key: 'years', label: 'Years of experience', type: 'stepper', min: 0, max: 80, default: 1 },
        { key: 'certification', label: 'Certification', optional: true },
      ]}
      onSubmit={async (v) => { await api.post('/coach/specialisations', { ...(spec ? { id: spec.id } : {}), sport: v.sport, name: v.name, levels: v.levels ?? [], years: v.years, certification: v.certification ?? null }); await onDone(); return 'Saved'; }} />
  );
}

export function CoachRates() {
  const { toast } = useSession();
  const cards = useLoad(() => api.get('/coach/rate-cards'), []);
  const specs = useLoad(() => api.get('/coach/specialisations'), []);
  const [sheet, setSheet] = useState(null), [spec, setSpec] = useState(null), [retire, setRetire] = useState(null);
  const reload = () => Promise.all([cards.reload(), specs.reload()]);
  const cur = cards.data?.[0]?.currency ?? 'INR';
  const toggle = async (k) => { try { await api.patch(`/coach/rate-cards/${k.id}`, { active: !k.active }); await reload(); toast(k.active ? 'Switched off — hidden from booking' : 'Live again'); } catch (e) { toast(e.message); } };
  return (
    <Screen onRefresh={reload}>
      <Head eyebrow="COACH" title="Rate cards" sub="A price for each kind of work: one-to-one, groups, teams, events, retainers and trials." right={<Btn small title="+ New rate card" onPress={() => setSheet({})} />} />
      <View style={{ gap: 10, marginTop: 14 }}>
        {cards.error ? <ErrorBox error={cards.error} onRetry={cards.reload} /> : cards.loading && !cards.data ? <Loading /> : !cards.data.length ? (
          <Empty emoji="🏷️" title="No rate cards yet" sub="Without one, athletes book your standard hourly rate for one person. Add cards to be booked by groups, teams and events too." />
        ) : cards.data.map((k) => (
          <Card key={k.id} pad={14} color={k.active ? c.paper : c.violetSoft}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T weight="800" size={15}>{k.title}</T>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  <Pill label={`FOR ${k.audience.toUpperCase()}`} />{k.is_intro ? <Pill label="🎁 TRIAL" fg={c.sun} bg={c.sunSoft} /> : null}{k.sport ? <Pill label={k.sport.toUpperCase()} /> : null}{k.specialisation ? <Pill label={k.specialisation.toUpperCase()} /> : null}
                  {!k.active ? <Pill label="OFF" fg={c.red} bg={c.redSoft} /> : null}
                </View>
              </View>
              <T weight="800" size={15}>{cardPrice(k, k.currency)}</T>
            </View>
            <T size={12} color={c.mute} style={{ marginTop: 6 }}>{[k.duration_min && k.unit !== 'hour' ? `${k.duration_min} min` : null, k.audience !== 'individual' ? `${k.min_participants}${k.max_participants ? `–${k.max_participants}` : '+'} people` : null, k.sessions_included ? `${k.sessions_included} sessions` : null, `${k.bookings} booking${k.bookings === 1 ? '' : 's'}`, Number(k.income_cents) ? `${price(k.income_cents, k.currency)} earned` : null].filter(Boolean).join(' · ')}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Btn small title="Edit" onPress={() => setSheet(k)} />
              <Btn small title={k.active ? 'Switch off' : 'Switch on'} color={c.paper} ink={c.ink} onPress={() => toggle(k)} />
              <Btn small title="Retire" color={c.paper} ink={c.red} onPress={() => setRetire(k)} />
            </View>
          </Card>
        ))}
      </View>

      <Section title="Specialisations" action="+ Add" onAction={() => setSpec({})}>
        {specs.error ? <ErrorBox error={specs.error} onRetry={specs.reload} /> : !specs.data?.length ? <T size={13} color={c.mute}>Say what you are known for — it shows on your profile, helps search find you and groups your reports.</T> : specs.data.map((z) => (
          <Card key={z.id} pad={12}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <T size={24}>{z.emoji}</T>
              <View style={{ flex: 1 }}>
                <T weight="800">{z.name}</T>
                <T size={12} color={c.mute}>{[z.sport, z.levels.length ? z.levels.map(nice).join(', ') : null, z.years != null ? `${z.years} yrs` : null, z.certification].filter(Boolean).join(' · ')}</T>
                <T size={12} color={c.mute}>{z.sessions_done} session{z.sessions_done === 1 ? '' : 's'} · {price(z.income_cents, cur)}{z.rating ? ` · ★ ${z.rating}` : ''}</T>
              </View>
              <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setSpec({ ...z })} />
            </View>
          </Card>
        ))}
      </Section>
      {sheet ? <CardSheet card={sheet.id ? sheet : null} specs={specs.data ?? []} currency={cur} onClose={() => setSheet(null)} onDone={reload} /> : null}
      {spec ? <SpecSheet spec={spec.id ? spec : null} onClose={() => setSpec(null)} onDone={reload} /> : null}
      <Confirm visible={!!retire} title="Retire this rate card?" yes="Retire" danger onClose={() => setRetire(null)} body="It disappears from your profile and from booking. Sessions already booked on it stay on record."
        onYes={async () => { try { await api.patch(`/coach/rate-cards/${retire.id}`, { archive: true }); setRetire(null); await reload(); toast('Retired'); } catch (e) { toast(e.message); } }} />
    </Screen>
  );
}

// ================================================================================== COMMITMENTS
function CommitmentSheet({ teams, currency, onClose, onDone }) {
  return (
    <FormSheet visible onClose={onClose} title="New contract or commitment" submitLabel="Add to my schedule" initial={{ kind: 'contract', duration_min: 60 }}
      fields={[
        { key: 'kind', label: 'What is it', type: 'chips', options: KINDS },
        { key: 'title', label: 'Title' },
        { key: 'sport', label: 'Sport', type: 'sport', optional: true },
        { key: 'team_id', label: 'Which team', type: 'chips', optional: true, options: teams.map((t) => ({ value: t.id, label: t.name })), show: (v) => v.kind === 'team' && teams.length > 0 },
        { key: 'client_name', label: 'Client (academy, school, club…)', optional: true, show: (v) => v.kind !== 'personal' && v.kind !== 'block' },
        { key: 'starts_on', label: 'Starts', type: 'date' },
        { key: 'ends_on', label: 'Ends', type: 'date', optional: true, hint: 'Leave empty if it has no end date.' },
        { key: 'weekdays', label: 'Repeats on', type: 'weekdays', optional: true, hint: 'Leave empty for a single date.' },
        { key: 'start', label: 'Start time', type: 'time', step: 15 },
        { key: 'duration_min', label: 'Length', type: 'stepper', min: 15, max: 1440, step: 15, default: 60, suffix: ' min' },
        { key: 'fee_cents', label: 'Fee', type: 'money', currency, optional: true, show: (v) => v.kind !== 'personal' && v.kind !== 'block' },
        { key: 'fee_unit', label: 'Fee is', type: 'choice', options: [{ value: 'session', label: 'Per session' }, { value: 'month', label: 'Per month' }, { value: 'total', label: 'In total' }], show: (v) => v.fee_cents !== '' && v.fee_cents !== undefined && v.kind !== 'personal' && v.kind !== 'block' },
        { key: 'notes', label: 'Notes', type: 'multiline', optional: true },
      ]}
      onSubmit={async (v) => {
        const r = await api.post('/coach/commitments', { kind: v.kind, title: v.title, starts_on: v.starts_on, start: v.start, duration_min: v.duration_min, weekdays: v.weekdays ?? [],
          ...(v.sport ? { sport: v.sport } : {}), ...(v.team_id ? { team_id: v.team_id } : {}), ...(v.client_name ? { client_name: v.client_name } : {}), ...(v.ends_on ? { ends_on: v.ends_on } : {}), ...(v.notes ? { notes: v.notes } : {}),
          ...(v.fee_cents !== undefined ? { fee_cents: v.fee_cents, fee_unit: v.fee_unit ?? 'session' } : {}) });
        await onDone(); return r.clashes?.length ? `Added — it clashes with ${r.clashes.length} other session${r.clashes.length === 1 ? '' : 's'}; check your schedule` : 'Added to your schedule';
      }} />
  );
}

export function CoachCommitments() {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/coach/commitments', { limit: 100 }), []);
  const home = useLoad(() => api.get('/coach/home'), []);
  const [add, setAdd] = useState(false), [act, setAct] = useState(null);
  const when = (x) => `${x.weekdays.length ? x.weekdays.map((d) => WEEKDAYS[d]).join(', ') : dayText(x.starts_on)} · ${x.timezone === 'UTC' ? '' : ''}${String(Math.floor(x.start_min / 60)).padStart(2, '0')}:${String(x.start_min % 60).padStart(2, '0')} · ${x.duration_min} min`;
  const log = async (x, on_date, status) => { try { await api.post(`/coach/commitments/${x.id}/log`, { on_date, status }); await list.reload(); toast(status === 'delivered' ? 'Logged as delivered' : 'Marked as not held'); } catch (e) { toast(e.message); } };
  const move = async () => { try { await api.patch(`/coach/commitments/${act.x.id}`, { status: act.status }); setAct(null); await list.reload(); toast('Updated'); } catch (e) { toast(e.message); setAct(null); } };
  const cur = list.data?.[0]?.currency ?? 'INR';
  return (
    <Screen onRefresh={list.reload}>
      <Head eyebrow="COACH" title="Contracts & commitments" sub="Seasons, retainers, events and blocked time. They fill your schedule and keep athletes from booking over them." right={<Btn small title="+ New" onPress={() => setAdd(true)} />} />
      <View style={{ gap: 10, marginTop: 14 }}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !list.data.length ? (
          <Empty emoji="📑" title="No commitments yet" sub="Add the team you coach every Tuesday, an academy retainer or an event you are booked for." />
        ) : list.data.map((x) => (
          <Card key={x.id} pad={14}>
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <T weight="800" size={15}>{x.title}</T>
                <T size={12} color={c.mute}>{[nice(x.kind), x.team_name ?? x.event_name ?? x.client_user_name ?? x.client_name, x.sport].filter(Boolean).join(' · ')}</T>
                <T size={12} color={c.mute}>{when(x)}</T>
                <T size={12} color={c.mute}>{dayText(x.starts_on)}{x.ends_on ? ` → ${dayText(x.ends_on)}` : ' · no end date'}{x.fee_cents != null ? ` · ${price(x.fee_cents, x.currency)} ${x.fee_unit === 'total' ? 'total' : `per ${x.fee_unit}`}` : ''}</T>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}>
                <StatusPill s={x.status === 'active' ? 'active' : x.status === 'ended' ? 'completed' : x.status} />
                <T size={12} weight="700">{x.delivered}{x.scheduled_total ? ` / ${x.scheduled_total}` : ''} delivered</T>
              </View>
            </View>
            {x.upcoming.length ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Next: {x.upcoming.map((u) => dayText(u.on_date)).join(' · ')}</T> : null}
            {x.to_log?.length ? (
              <View style={{ marginTop: 8, gap: 6 }}>
                <T size={12} weight="800" color={c.sun}>{x.overdue} past session{x.overdue === 1 ? '' : 's'} to log</T>
                {x.to_log.map((d) => (
                  <View key={d} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T style={{ flex: 1 }} size={13}>{dayText(d)}</T>
                    <Btn small title="Delivered" onPress={() => log(x, d, 'delivered')} /><Btn small title="Not held" color={c.paper} ink={c.ink} onPress={() => log(x, d, 'skipped')} />
                  </View>
                ))}
              </View>
            ) : null}
            {x.status === 'active' || x.status === 'paused' ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {x.status === 'active' ? <Btn small title="Pause" color={c.paper} ink={c.ink} onPress={() => setAct({ x, status: 'paused' })} /> : <Btn small title="Resume" onPress={() => setAct({ x, status: 'active' })} />}
                <Btn small title="Mark ended" color={c.paper} ink={c.ink} onPress={() => setAct({ x, status: 'ended' })} />
                <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setAct({ x, status: 'cancelled' })} />
              </View>
            ) : null}
          </Card>
        ))}
      </View>
      {add ? <CommitmentSheet teams={home.data?.teams ?? []} currency={cur} onClose={() => setAdd(false)} onDone={list.reload} /> : null}
      <Confirm visible={!!act} title={act ? { paused: 'Pause this commitment?', active: 'Resume this commitment?', ended: 'Mark as ended?', cancelled: 'Cancel this commitment?' }[act.status] : ''} yes="Yes" danger={act?.status === 'cancelled'} onClose={() => setAct(null)} onYes={move}
        body={act ? { paused: 'Its dates leave your schedule and athletes can book those times again.', active: 'Its dates return to your schedule and block booking.', ended: 'Delivered sessions stay on record.', cancelled: 'Its dates leave your schedule. A cancelled commitment cannot be reopened; delivered sessions stay on record.' }[act.status] : ''} />
    </Screen>
  );
}

// ================================================================================== TESTIMONIALS
export function CoachReviews() {
  const { toast, user } = useSession();
  const [tab, setTab] = useState('received');
  const prof = useLoad(() => api.get(`/coaches/${user.id}`).catch(() => null), [user.id]);
  const recv = useLoad(() => api.get('/coach/testimonials', { dir: 'received', limit: 100 }), []);
  const given = useLoad(() => api.get('/coach/testimonials', { dir: 'given', limit: 100 }), []);
  const hires = useLoad(() => api.get('/hires', { limit: 100 }), []);
  const athletes = useLoad(() => api.get('/coach/athletes', { limit: 100 }), []);
  const [reply, setReply] = useState(null), [write, setWrite] = useState(false);
  const toAsk = (hires.data ?? []).filter((h) => h.i_am_coach && h.status === 'completed' && !h.review_id);
  const pin = async (r) => { try { await api.post(`/coach-reviews/${r.id}/pin`, { pinned: !r.pinned }); await recv.reload(); toast(r.pinned ? 'Unpinned' : 'Pinned to your profile'); } catch (e) { toast(e.message); } };
  const ask = async (h) => { try { await api.post(`/hires/${h.id}/request-review`); await hires.reload(); toast('Asked for a review'); } catch (e) { toast(e.message); } };
  const rating = prof.data?.rating;
  return (
    <Screen onRefresh={() => { recv.reload(); given.reload(); hires.reload(); }}>
      <Head eyebrow="COACH" title="Reviews & testimonials" sub="What people say about you, and what you say about the athletes you coach." />
      {rating?.count ? <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, flexWrap: 'wrap' }}><Tile value={`${Number(rating.avg).toFixed(1)}★`} label="RATING" /><Tile value={rating.count} label="REVIEWS" /><Tile value={(recv.data ?? []).filter((r) => r.pinned).length} label="PINNED" /></View> : null}
      <View style={{ marginTop: 12 }}><Seg options={[{ value: 'received', label: 'About me' }, { value: 'ask', label: toAsk.length ? `Ask for reviews · ${toAsk.length}` : 'Ask for reviews' }, { value: 'given', label: 'I wrote' }]} value={tab} onChange={setTab} /></View>
      {tab === 'received' ? (
        <View style={{ gap: 10, marginTop: 12 }}>
          {recv.error ? <ErrorBox error={recv.error} onRetry={recv.reload} /> : recv.loading && !recv.data ? <Loading /> : !recv.data.length ? <Empty emoji="⭐" title="No reviews yet" sub="After a completed session, ask the athlete, team or organiser for a review in the next tab." /> : recv.data.map((r) => (
            <Card key={r.id} pad={14}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <Avatar user={{ avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color, avatar_url: r.avatar_url, display_name: r.author_name }} size={36} />
                <View style={{ flex: 1 }}><T weight="700">{r.author_name}</T><Stars value={r.rating} /><T size={11} color={c.mute}>{[r.sport, r.audience !== 'individual' ? nice(r.audience) : null, new Date(r.session_at).toLocaleDateString()].filter(Boolean).join(' · ')}</T></View>
                {r.pinned ? <Pill label="📌 PINNED" fg={c.sun} bg={c.sunSoft} /> : null}
              </View>
              {r.body ? <T size={13} style={{ marginTop: 6 }}>{r.body}</T> : null}
              {r.reply ? <View style={{ marginTop: 8, backgroundColor: c.violetSoft, borderRadius: 10, padding: 10 }}><T size={12} weight="800" color={c.mute}>Your reply</T><T size={13}>{r.reply}</T></View> : null}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                {!r.reply ? <Btn small title="Reply" onPress={() => setReply(r)} /> : null}
                <Btn small title={r.pinned ? 'Unpin' : 'Pin to profile'} color={c.paper} ink={c.ink} onPress={() => pin(r)} />
              </View>
            </Card>
          ))}
        </View>
      ) : null}
      {tab === 'ask' ? (
        <View style={{ gap: 10, marginTop: 12 }}>
          {!toAsk.length ? <Empty emoji="🙌" title="Nothing waiting" sub="Completed sessions that have no review yet appear here, so you can ask once." /> : toAsk.map((h) => (
            <Card key={h.id} pad={12}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <View style={{ flex: 1 }}><T weight="700">{h.hirer_name}</T><T size={12} color={c.mute}>{h.sport_emoji} {h.sport} · {new Date(h.starts_at).toLocaleDateString()}{h.audience !== 'individual' ? ` · ${nice(h.audience)}` : ''}</T></View>
                {h.review_requested_at ? <T size={12} weight="700" color={c.mute}>Asked ✓</T> : <Btn small title="Ask for a review" onPress={() => ask(h)} />}
              </View>
            </Card>
          ))}
        </View>
      ) : null}
      {tab === 'given' ? (
        <View style={{ gap: 10, marginTop: 12 }}>
          <Btn small title="+ Write a testimonial" onPress={() => setWrite(true)} style={{ alignSelf: 'flex-start' }} />
          {given.error ? <ErrorBox error={given.error} onRetry={given.reload} /> : given.loading && !given.data ? <Loading /> : !given.data.length ? <Empty emoji="✍️" title="You have not written any" sub="A good word from their coach helps an athlete get picked. You can write for people you actively coach." /> : given.data.map((t) => (
            <Card key={t.id} pad={12}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <Avatar user={{ avatar_emoji: t.avatar_emoji, avatar_color: t.avatar_color, avatar_url: t.avatar_url, display_name: t.athlete_name }} size={34} />
                <View style={{ flex: 1 }}><T weight="700">{t.athlete_name}</T><Stars value={t.rating} /></View>
              </View>
              <T size={13} style={{ marginTop: 6 }}>{t.body}</T>
            </Card>
          ))}
        </View>
      ) : null}
      {reply ? <FormSheet visible onClose={() => setReply(null)} title={`Reply to ${reply.author_name}`} submitLabel="Post reply" fields={[{ key: 'reply', label: 'Your reply (public, one per review)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/coach-reviews/${reply.id}/reply`, { reply: v.reply }); await recv.reload(); return 'Reply posted'; }} /> : null}
      {write ? <FormSheet visible onClose={() => setWrite(false)} title="Write a testimonial" submitLabel="Publish" initial={{ rating: 5 }}
        fields={[
          { key: 'athlete_id', label: athletes.data?.length ? 'For which athlete' : 'For which athlete (you have none yet)', type: 'chips', optional: true, options: (athletes.data ?? []).map((a) => ({ value: a.id, label: a.display_name })) },
          { key: 'rating', label: 'Rating', type: 'stepper', min: 1, max: 5, default: 5, suffix: ' ★' },
          { key: 'body', label: 'What stands out about them', type: 'multiline' },
        ]}
        onSubmit={async (v) => { if (!v.athlete_id) throw new Error('Choose the athlete'); await api.post(`/coach/athletes/${v.athlete_id}/testimonial`, { rating: v.rating, body: v.body }); await given.reload(); return 'Published on their profile'; }} /> : null}
    </Screen>
  );
}

// ================================================================================== ANALYTICS
const Bars = ({ rows, label = (r) => r.key, value = (r) => r.income_cents, fmt, color = c.pink }) => {
  const max = Math.max(1, ...rows.map(value));
  return rows.map((r, n) => (
    <View key={`${label(r)}${n}`} style={{ gap: 3, marginVertical: 3 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={13} weight="700" style={{ flex: 1 }} numberOfLines={1}>{nice(label(r))}</T><T size={13} color={c.mute}>{fmt(r)}</T></View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft }}><View style={{ height: 8, borderRadius: 4, width: `${Math.max(2, (100 * value(r)) / max)}%`, backgroundColor: color }} /></View>
    </View>
  ));
};

export function CoachAnalytics() {
  const { toast } = useSession();
  const [days, setDays] = useState(90);
  const to = todayIn(deviceTz), from = addDays(to, -(days - 1));
  const a = useLoad(() => api.get('/coach/analytics', { from, to }), [days]);
  const d = a.data, cur = d?.currency ?? 'INR';
  const money = (x) => moneyIn(Number(x ?? 0), cur);
  const download = async () => {
    try {
      const r = await api.get('/coach/report', { from, to });
      if (Platform.OS === 'web' && typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); toast(`${r.rows} lines exported`); }
      else toast('Open SportArena in a browser to download the statement');
    } catch (e) { toast(e.message); }
  };
  const maxMonth = Math.max(1, ...(d?.by_month ?? []).map((m) => m.income_cents));
  const kv = (rows, fmt) => (rows.length ? <Bars rows={rows} fmt={fmt} /> : <T size={13} color={c.mute}>Nothing in this period.</T>);
  return (
    <Screen wide onRefresh={a.reload}>
      <Head eyebrow="COACH" title="Analytics" sub="How your coaching business is doing." right={<Btn small title="⬇ Statement (CSV)" color={c.paper} ink={c.ink} onPress={download} />} />
      <View style={{ marginTop: 12 }}><Seg options={[{ value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }, { value: 365, label: 'Last year' }]} value={days} onChange={setDays} /></View>
      {a.error ? <ErrorBox error={a.error} onRetry={a.reload} /> : a.loading && !d ? <Loading /> : (
        <>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <Tile value={money(d.totals.income_cents)} label="SESSION INCOME" hot />
            <Tile value={d.totals.sessions_completed} label="SESSIONS DONE" />
            <Tile value={d.totals.hours_delivered} label="HOURS" />
            <Tile value={d.totals.clients} label="CLIENTS" />
            <Tile value={d.ratings.count ? `${Number(d.ratings.avg).toFixed(1)}★` : '—'} label="RATING" />
            <Tile value={d.utilisation.pct != null ? `${d.utilisation.pct}%` : '—'} label="BUSY" />
          </View>
          {Number(d.totals.outstanding_cents) ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{money(d.totals.outstanding_cents)} still waiting to be paid.</T> : null}

          <Section title="Income by month">
            {d.by_month.length ? (
              <Card pad={14}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: 130 }}>
                  {d.by_month.map((m) => (
                    <View key={m.month} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                      <T size={10} color={c.mute}>{m.income_cents ? money(m.income_cents) : ''}</T>
                      <View style={{ width: '70%', minHeight: 3, height: `${Math.max(3, (100 * m.income_cents) / maxMonth) * 0.78}%`, borderRadius: 6, backgroundColor: c.pink }} />
                      <T size={11} weight="700" style={{ marginTop: 4 }}>{new Date(`${m.month}-15T12:00:00`).toLocaleDateString(undefined, { month: 'short' })}</T>
                    </View>
                  ))}
                </View>
                <T size={12} color={c.mute} style={{ marginTop: 6 }}>{d.by_month.map((m) => `${new Date(`${m.month}-15T12:00:00`).toLocaleDateString(undefined, { month: 'short' })}: ${m.sessions} sessions, ${m.hours} h`).join(' · ')}</T>
              </Card>
            ) : <T size={13} color={c.mute}>No sessions in this period.</T>}
          </Section>

          <Section title="Where the work comes from">
            <Card pad={14}><T weight="800" size={13}>By client type</T>{kv(d.by_audience, (r) => `${money(r.income_cents)} · ${r.sessions}`)}</Card>
            <Card pad={14}><T weight="800" size={13}>By sport</T>{kv(d.by_sport, (r) => `${money(r.income_cents)} · ${r.sessions}`)}</Card>
            <Card pad={14}><T weight="800" size={13}>By rate card</T>{kv(d.by_rate_card, (r) => `${money(r.income_cents)} · ${r.sessions}`)}</Card>
            <Card pad={14}><T weight="800" size={13}>By specialisation</T>{kv(d.by_specialisation, (r) => `${money(r.income_cents)} · ${r.sessions}`)}</Card>
          </Section>

          <Section title="Clients & requests">
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              <Tile value={d.totals.repeat_rate_pct != null ? `${d.totals.repeat_rate_pct}%` : '—'} label="REPEAT CLIENTS" />
              <Tile value={d.requests.win_rate_pct != null ? `${d.requests.win_rate_pct}%` : '—'} label="REQUESTS WON" />
              <Tile value={d.cancellations.rate_pct != null ? `${d.cancellations.rate_pct}%` : '—'} label="CANCELLED" />
            </View>
            <T size={13} color={c.mute}>You answered {d.requests.answered} request{d.requests.answered === 1 ? '' : 's'}: {d.requests.won} won, {d.requests.lost} not chosen, {d.requests.pending} waiting. Cancellations: {d.cancellations.by_coach} by you, {d.cancellations.by_client} by clients.</T>
          </Section>

          <Section title="Your time">
            <Card pad={14}>
              <T weight="800">{d.utilisation.pct != null ? `${d.utilisation.pct}% of your open hours are booked` : 'Set weekly open hours to see how busy you are'}</T>
              <T size={13} color={c.mute}>{d.utilisation.committed_hours} h booked or committed of {d.utilisation.available_hours} h open. {d.utilisation.basis}.</T>
              <T size={13} style={{ marginTop: 6 }}>Commitments: {d.commitments.sessions_delivered} of {d.commitments.sessions_scheduled} sessions delivered{d.commitments.income_cents ? ` · ${money(d.commitments.income_cents)} from contracts and retainers` : ''}.</T>
            </Card>
          </Section>
          {d.ratings.by_month.length ? <Section title="Ratings by month"><Card pad={14}><Bars rows={d.ratings.by_month} label={(r) => r.month} value={(r) => r.avg} fmt={(r) => `${r.avg} ★ · ${r.n}`} color={c.sun} /></Card></Section> : null}
        </>
      )}
    </Screen>
  );
}
