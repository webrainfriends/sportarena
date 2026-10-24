// Trials for players and guardians: find and book a trial (capacity and waitlist are the event's own), then see attendance and, once staff
// release it, the outcome, rubric feedback and follow-up. A guardian can do all of it for a child. Nothing is stored here; it reads the API.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Chip, Empty, H1, Loading, Row, Screen, Seg, T, Tag } from '../ui';
import { DateField, HScroll } from '../pickers';
import { SportSelect } from '../sportpicker';
import { LoadError, explain } from '../access';
import { c } from '../theme';

export const ATTENDANCE = { present: 'Attended', late: 'Attended (late)', left_early: 'Left early', absent: 'Absent', excused: 'Excused' };
export const DECISION = { selected: 'Selected', second_trial: 'Invited to a second trial', waitlist: 'On the waitlist', not_progressing: 'Not progressing this time' };
const BOOKING = { accepted: ['Booked', c.mint], waitlisted: ['Waitlist', c.sun], pending: ['Awaiting confirmation', c.sun], withdrawn: ['Cancelled', c.violetSoft], rejected: ['Declined', c.orange] };
export const when = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Date to be set');

/** Score bars for one assessment, scaled to each dimension's own range. */
export function ScoreBars({ dimensions, scores }) {
  return (
    <View style={{ gap: 8 }}>
      {dimensions.filter((d) => scores[d.key] != null).map((d) => {
        const pct = ((scores[d.key] - d.scale_min) / Math.max(d.scale_max - d.scale_min, 1)) * 100;
        return (
          <View key={d.key} style={{ gap: 3 }} accessible accessibilityLabel={`${d.name}: ${scores[d.key]} out of ${d.scale_max}`}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} weight="600">{d.name}</T><T size={13} color={c.mute}>{scores[d.key]}/{d.scale_max}</T></View>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ width: `${Math.max(pct, 4)}%`, height: 8, backgroundColor: c.violet }} /></View>
          </View>
        );
      })}
    </View>
  );
}

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 18, padding: 14, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;

function Find({ athleteId, reloadMine }) {
  const { toast } = useSession();
  const [sport, setSport] = useState(null), [from, setFrom] = useState(null), [free, setFree] = useState(false), [busy, setBusy] = useState(null);
  const list = useLoad(() => api.get('/events/search', { kind: 'trial', sport: sport || undefined, date_from: from || undefined, open_for_entry: free ? true : undefined, limit: 30 }), [sport, from, free]);
  const book = async (t) => {
    setBusy(t.id);
    try { const r = await api.post(`/trials/${t.id}/book`, athleteId ? { athlete_id: athleteId } : {}); toast(r.status === 'waitlisted' ? 'You are on the waitlist' : r.replay ? 'Already booked' : 'Place booked'); list.reload(); reloadMine(); }
    catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <SportSelect label="Sport" value={sport} onChange={setSport} optional allLabel="All sports" />
        <DateField label="From" value={from} onChange={setFrom} optional hint="Only trials on or after this day" />
        <HScroll><Chip label="Places left only" active={free} onPress={() => setFree(!free)} /></HScroll>
      </Panel>
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : !list.data.items.length
        ? <Empty emoji="🎽" title="No trials found" sub="Nothing matches yet. Clear a filter, or check back — organisers add trials all the time." />
        : list.data.items.map((t) => (
          <Panel key={t.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{t.name}</T>{t.spots_left === 0 ? <Tag label="Full" color={c.sun} /> : t.spots_left != null ? <Tag label={`${t.spots_left} left`} color={c.mint} /> : null}</View>
            <T size={13} color={c.mute}>{[t.sport, when(t.starts_on), t.city].filter(Boolean).join(' · ')}</T>
            <T size={12} color={c.mute}>Turning up to a trial is not selection. You will get dated feedback afterwards.</T>
            {t.registration_open || t.spots_left === 0 ? <Btn small title={t.spots_left === 0 ? 'Join the waitlist' : 'Book a place'} loading={busy === t.id} onPress={() => book(t)} /> : <T size={12} color={c.mute}>Booking is closed.</T>}
          </Panel>
        ))}
    </View>
  );
}

function Mine({ athleteId, mine, who }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(null);
  const bookNext = async (f) => { setBusy(f.id); try { const r = await api.post(`/trials/${f.next_event_id}/book`, athleteId ? { athlete_id: athleteId } : {}); toast(r.status === 'waitlisted' ? 'You are on the waitlist' : 'Place booked'); mine.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const cancel = async (b) => { setBusy(b.entry_id); try { await api.post(`/trial-bookings/${b.entry_id}/cancel`, {}); toast('Booking cancelled'); mine.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  if (mine.error) return <LoadError error={mine.error} onRetry={mine.reload} />;
  if (!mine.data) return <Loading />;
  const items = mine.data.items;
  if (!items.length) return <Empty emoji="🎽" title={`${who} ${who === 'You' ? 'have' : 'has'} no trials`} sub="Find a trial near you and book a place. Attendance, feedback and next steps will show up here." />;
  return (
    <View style={{ gap: 12 }}>
      {items.map((b) => {
        const [label, tone] = BOOKING[b.booking_status] ?? [b.booking_status, c.violetSoft];
        const live = ['accepted', 'waitlisted', 'pending'].includes(b.booking_status) && !b.attendance && b.event_status !== 'completed';
        return (
          <Panel key={b.entry_id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{b.sport_emoji} {b.name}</T><Tag label={label} color={tone} /></View>
            <T size={13} color={c.mute}>{[when(b.starts_on), b.venue_name].filter(Boolean).join(' · ')}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {b.attendance ? <Tag label={ATTENDANCE[b.attendance]} color={b.attendance === 'absent' ? c.orange : c.mint} /> : null}
              {b.attendance && !b.outcome && !b.feedback_hidden ? <Tag label="Outcome pending" color={c.sun} /> : null}
            </View>
            {b.feedback_hidden ? <T size={13} color={c.mute}>Feedback is hidden because a guardian has not allowed (or has withdrawn) coaching consent.</T> : null}
            {b.outcome ? <View style={{ backgroundColor: c.violetSoft, borderRadius: 12, padding: 10 }}><T weight="800">{DECISION[b.outcome.decision]}</T>{b.outcome.note ? <T size={13}>{b.outcome.note}</T> : null}</View> : null}
            {b.feedback.map((f) => (
              <View key={f.id} style={{ gap: 8, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10 }}>
                <T size={12} color={c.mute}>Assessed {new Date(f.assessed_at).toLocaleDateString()} by {f.assessor_name} · {f.rubric_name}</T>
                <ScoreBars dimensions={f.dimensions} scores={f.scores} />
                {f.feedback ? <T size={14}>“{f.feedback}”</T> : null}
              </View>
            ))}
            {b.follow_ups.length ? <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10 }}><T weight="800" size={13}>Next steps</T>{b.follow_ups.map((f) => (
              <View key={f.id} style={{ gap: 6 }}>
                <T size={13}>{f.status === 'done' ? '✅' : '•'} {f.title}{f.due_on ? ` · by ${when(f.due_on)}` : ''}</T>
                {f.next_event_id && f.status === 'open' ? (
                  ['accepted', 'pending', 'waitlisted'].includes(f.next_booking_status)
                    ? <Tag label={f.next_booking_status === 'waitlisted' ? `Waitlisted for ${f.next_event_name}` : `Booked: ${f.next_event_name}`} color={c.mint} />
                    : f.next_event_open ? <Btn small title={`Book ${f.next_event_name}${f.next_event_starts_on ? ` · ${when(f.next_event_starts_on)}` : ''}`} loading={busy === f.id} onPress={() => bookNext(f)} /> : <T size={12} color={c.mute}>Booking for {f.next_event_name} is closed.</T>
                ) : null}
              </View>
            ))}</View> : null}
            {live ? <Btn small title="Cancel booking" color={c.paper} ink={c.red} loading={busy === b.entry_id} onPress={() => cancel(b)} /> : null}
          </Panel>
        );
      })}
    </View>
  );
}

export function Trials() {
  const { user } = useSession();
  const [tab, setTab] = useState('find'), [child, setChild] = useState(null);
  const kids = useLoad(() => api.get('/youth/guardian-links', { as: 'guardian', status: 'active' }).catch(() => []), []);
  const children = (kids.data ?? []).filter((l) => l.child_id);
  const athleteId = child ?? undefined;
  const mine = useLoad(() => api.get('/trials/mine', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  const name = child ? children.find((l) => l.child_id === child)?.child?.display_name ?? 'Your child' : 'You';
  return (
    <Screen>
      <H1>Trials</H1>
      <T color={c.mute} style={{ marginTop: 2, marginBottom: 10 }}>Find a trial, book a place, and see your feedback once the coaches release it.</T>
      {children.length ? (
        <HScroll>
          <Chip label={user?.display_name ?? 'Me'} active={!child} onPress={() => setChild(null)} />
          {children.map((l) => <Chip key={l.id} label={l.child?.display_name ?? 'Child'} active={child === l.child_id} onPress={() => setChild(l.child_id)} />)}
        </HScroll>
      ) : null}
      <View style={{ height: 10 }} />
      <Seg options={[{ value: 'find', label: 'Find a trial' }, { value: 'mine', label: 'My trials' }]} value={tab} onChange={setTab} />
      <View style={{ height: 12 }} />
      {tab === 'find' ? <Find athleteId={athleteId} reloadMine={mine.reload} /> : <Mine athleteId={athleteId} mine={mine} who={name} />}
    </Screen>
  );
}
