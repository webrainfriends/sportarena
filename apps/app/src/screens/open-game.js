import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card as BaseCard, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, fam, when } from '../theme';
import { locale } from '../locale';
import { BOOKING, STATUS, Seats, costLabel, price } from './find-games';
import { HostGameSheet } from './host-game';

/** A card whose content is spaced, so a title never touches the line under it. */
const Card = ({ children, gap = 6, ...p }) => <BaseCard {...p}><View style={{ gap }}>{children}</View></BaseCard>;

const clock = (iso) => new Date(iso).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const LIVE = ['guardian_pending', 'requested', 'waitlisted', 'confirmed'];
const FIT = { fits: ['Level fits', c.mint], below: ['Below your range', c.sun], above: ['Above your range', c.sun], unknown: ['No level on profile', c.violetSoft], open: ['Any level', c.violetSoft] };
const Wrap = ({ children, gap = 8 }) => <View style={{ flexDirection: 'row', gap, flexWrap: 'wrap', alignItems: 'center' }}>{children}</View>;
const localDate = (iso, tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(iso)); } catch { return iso.slice(0, 10); } };

function JoinSheet({ g, kids, onClose, onDone }) {
  const { toast } = useSession();
  const [who, setWho] = useState(kids.length && g.audience === 'youth' ? kids[0].id : null);
  const [position, setPosition] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(`join-${g.id}-${Math.random().toString(36).slice(2, 10)}`); // a retry of this same tap never makes a second request
  const full = g.is_full;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/open-games/${g.id}/join`, { ...(who ? { on_behalf_of: who } : {}), position: position || undefined, message: message.trim() || undefined, idempotency_key: key.current });
      toast({ confirmed: 'You are in! 🎉', requested: 'Request sent — the host will review it', waitlisted: 'You are on the waitlist', guardian_pending: 'A guardian has been asked to approve' }[r.status] ?? 'Done');
      onDone();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={full ? 'Join the waitlist' : g.approval_mode === 'auto' ? 'Join this game' : 'Ask to join'}
      footer={<><Btn title="Not now" color={c.paper} ink={c.ink} onPress={onClose} style={{ flex: 1 }} /><Btn title={full ? 'Join waitlist' : g.approval_mode === 'auto' ? 'Join' : 'Send request'} onPress={go} loading={busy} style={{ flex: 2 }} /></>}>
      <T size={13} color={c.mute}>{full ? 'Every seat is taken. You move up automatically when one frees.' : g.approval_mode === 'auto' ? 'If your level fits you take a seat straight away; otherwise the host decides.' : 'The host decides. You will be told either way.'} Joining a game never makes you a member of the host’s team.</T>
      {kids.length ? (
        <View style={{ gap: 8 }}><T weight="800" size={13}>Who is playing?</T>
          <Wrap>{g.audience !== 'youth' ? <Chip label="Me" active={!who} onPress={() => setWho(null)} /> : null}{kids.map((k) => <Chip key={k.id} label={`${k.display_name} (my child)`} active={who === k.id} onPress={() => setWho(k.id)} />)}</Wrap>
        </View>
      ) : null}
      {g.role_needs.length ? <View style={{ gap: 8 }}><T weight="800" size={13}>Role you would play (optional)</T><Wrap>{g.role_needs.map((r) => <Chip key={r} label={r} active={position === r} onPress={() => setPosition(position === r ? null : r)} />)}</Wrap></View> : null}
      <Field label="Message to the host (optional)" value={message} onChangeText={setMessage} multiline maxLength={300} placeholder="Where I play, how long I have been playing…" />
      {g.cost.mode !== 'free' ? <T size={13}>Your share: <T weight="800" size={13}>{price(g.cost.per_player_cents, g.cost.currency)}</T>. You pay the host or the venue directly; the host marks it paid.</T> : null}
    </Sheet>
  );
}

function Chat({ g }) {
  const { toast } = useSession();
  const [msgs, setMsgs] = useState([]);
  const [state, setState] = useState({ archived: false, open: true });
  const [text, setText] = useState('');
  const newest = useRef(null);
  const merge = useCallback((incoming) => setMsgs((cur) => {
    const by = new Map(cur.map((m) => [m.message_id, m]));
    for (const m of incoming) by.set(m.message_id, m);
    const all = [...by.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    newest.current = all.length ? all[all.length - 1].created_at : null;
    return all;
  }), []);
  useEffect(() => {
    let alive = true;
    const pull = async (after) => {
      try {
        const r = await api.get(`/open-games/${g.id}/messages`, { limit: 50, ...(after ? { after } : {}) });
        if (alive) { setState({ archived: r.archived, open: r.open !== false && !r.archived }); if (r.messages.length) merge(r.messages); }
      } catch { /* try again next tick */ }
    };
    pull();
    const t = setInterval(() => pull(newest.current), 6000);
    return () => { alive = false; clearInterval(t); };
  }, [g.id, merge]);
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    try { merge([await api.post(`/open-games/${g.id}/messages`, { body })]); setText(''); } catch (e) { toast(e.message); }
  };
  return (
    <Card pad={14} style={{ gap: 4 }}>
      <H2>Game chat</H2>
      <T size={12} color={c.mute}>Only the host and confirmed players. It closes 48 hours after the game and is never your team chat.</T>
      {state.archived ? <T size={13} color={c.mute} style={{ marginTop: 8 }}>This chat has closed.</T> : (
        <View style={{ gap: 8, marginTop: 10 }}>
          {msgs.length ? msgs.map((m) => (
            <View key={m.message_id} style={{ flexDirection: 'row', gap: 8, justifyContent: m.mine ? 'flex-end' : 'flex-start' }}>
              {m.mine ? null : <Avatar user={m} size={28} />}
              <View style={{ maxWidth: '80%', backgroundColor: m.mine ? c.violetSoft : c.paper, borderRadius: 14, padding: 10, borderWidth: 1, borderColor: c.line }}>
                {m.mine ? null : <T size={12} weight="800" color={c.violet}>{m.display_name}</T>}
                <T>{m.body}</T><T size={11} color={c.mute}>{clock(m.created_at)}</T>
              </View>
            </View>
          )) : <T size={13} color={c.mute}>No messages yet. Say hello and agree who brings what.</T>}
          {state.open ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <TextInput value={text} onChangeText={setText} placeholder="Message the group" placeholderTextColor={c.mute} multiline maxLength={1000} accessibilityLabel="Message the group" style={[fam, { flex: 1, minHeight: 46, maxHeight: 120, borderWidth: 1.5, borderColor: c.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, color: c.ink, backgroundColor: c.paper, fontSize: 15 }]} />
              <Btn small title="Send" onPress={send} disabled={!text.trim()} />
            </View>
          ) : <T size={12} color={c.mute}>This game is closed, so no new messages.</T>}
        </View>
      )}
    </Card>
  );
}

function Person({ p, size = 36 }) {
  return <Avatar user={p} size={size} />;
}

function Suggested({ g }) {
  const { toast } = useSession();
  const [list, setList] = useState(null);
  const [sent, setSent] = useState({});
  const load = async () => { try { setList(await api.get(`/open-games/${g.id}/suggested-players`, { limit: 10 })); } catch (e) { toast(e.message); } };
  return (
    <Card pad={14}>
      <H2>Need players?</H2>
      <T size={12} color={c.mute}>People who switched on suggestions, play this sport and are not in the game. Ranked by level fit, a free weekly slot and verified identity — never by payment, and without anyone’s location.</T>
      {list === null ? <Btn small title="Find players" onPress={load} style={{ marginTop: 10, alignSelf: 'flex-start' }} /> : !list.length ? <T size={13} color={c.mute} style={{ marginTop: 8 }}>Nobody matches yet.</T> : (
        <View style={{ gap: 10, marginTop: 10 }}>
          {list.map((p) => (
            <View key={p.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Person p={p} />
              <View style={{ flex: 1 }}><T weight="800">{p.display_name}{p.verified ? ' ✓' : ''}</T><T size={12} color={c.mute}>{p.reasons.map((r) => r.text).join(' · ')}</T></View>
              <Btn small title={sent[p.id] ? 'Invited' : 'Invite'} disabled={!!sent[p.id]} color={c.pink} onPress={async () => { try { await api.post(`/open-games/${g.id}/invites`, { user_id: p.id }); setSent((s) => ({ ...s, [p.id]: true })); } catch (e) { toast(e.message); } }} />
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

function HostPanel({ g, started, reload, setEdit, setCancel }) {
  const { toast } = useSession();
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); reload(); } catch (e) { toast(e.message); } };
  const players = (g.members ?? []).filter((m) => m.status === 'confirmed');
  const waiting = (g.requests ?? []);
  return (
    <View style={{ gap: 14 }}>
      <Card pad={14} color={c.cyanSoft} style={{ gap: 8 }}>
        <H2>You are the host</H2>
        <Wrap><Btn small title="Change game" color={c.paper} ink={c.ink} onPress={() => setEdit(true)} />{started && g.status === 'open' ? <Btn small title="Complete the game" onPress={() => act(async () => { const r = await api.post(`/open-games/${g.id}/complete`); toast(`Game complete — ${r.participants_recorded ?? 0} player${r.participants_recorded === 1 ? '' : 's'} added to their sports history`); })} /> : null}{g.status === 'open' ? <Btn small title="Cancel game" color={c.paper} ink={c.red} onPress={() => setCancel(true)} /> : null}</Wrap>
      </Card>
      {waiting.length ? (
        <Card pad={14} style={{ gap: 4 }}>
          <H2>{`Requests (${waiting.length})`}</H2>
          <T size={12} color={c.mute}>Ranked by: {g.rank_criteria.join(', ')}.</T>
          <View style={{ gap: 12, marginTop: 10 }}>
            {waiting.map((m) => (
              <View key={m.member_id} style={{ gap: 6, borderTopWidth: 1, borderColor: c.line, paddingTop: 10 }}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <Person p={m.person} />
                  <View style={{ flex: 1 }}><T weight="800">{m.person.display_name}{m.fit.verified ? ' ✓' : ''}</T>{m.person.handle ? <T size={12} color={c.mute}>@{m.person.handle}</T> : <T size={12} color={c.mute}>Young player · applied through a guardian</T>}</View>
                  <Tag label={m.status === 'waitlisted' ? 'Waitlist' : m.status === 'guardian_pending' ? 'Guardian first' : 'Request'} color={c.sun} />
                </View>
                <Wrap gap={6}><Tag label={FIT[m.fit.level_fit][0]} color={FIT[m.fit.level_fit][1]} />{m.position ? <Tag label={m.position} color={m.fit.role_match ? c.mint : c.violetSoft} /> : null}{m.applied_by_guardian ? <Tag label="Guardian applied" color={c.cyan} /> : null}</Wrap>
                <T size={12} color={c.mute}>Played {m.facts.games_played} · no-shows {m.facts.no_shows} · late cancellations {m.facts.late_cancellations}{m.facts.under_review ? ` · ${m.facts.under_review} under review` : ''}</T>
                {m.message ? <T size={13}>“{m.message}”</T> : null}
                {m.status !== 'guardian_pending' ? (
                  <Wrap>{m.status !== 'waitlisted' || !m.approved ? <Btn small title="Approve" onPress={() => act(() => api.post(`/open-games/${g.id}/members/${m.member_id}/decision`, { action: 'approve' }), 'Approved')} /> : null}<Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/open-games/${g.id}/members/${m.member_id}/decision`, { action: 'decline' }), 'Declined')} /></Wrap>
                ) : <T size={12} color={c.mute}>A guardian has to approve before you can.</T>}
              </View>
            ))}
          </View>
        </Card>
      ) : null}
      <Card pad={14}>
        <H2>{`Players (${players.length}/${g.max_players})`}</H2>
        {players.length ? (
          <View style={{ gap: 12, marginTop: 8 }}>
            {players.map((m) => (
              <View key={m.member_id} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <Person p={m.person} size={32} />
                  <View style={{ flex: 1 }}><T weight="800">{m.person.display_name}{m.user_id === g.host.id ? ' (you)' : ''}</T>{m.position ? <T size={12} color={c.mute}>{m.position}</T> : null}</View>
                  {m.attendance ? <Tag label={m.attendance === 'attended' ? 'Played' : 'No-show'} color={m.attendance === 'attended' ? c.mint : c.red} /> : null}
                </View>
                <Wrap gap={6}>
                  {m.share_cents > 0 ? <Chip label={m.share_status === 'settled' ? `Paid ${price(m.share_cents, g.cost.currency)} ✓` : m.share_status === 'waived' ? 'Share waived' : `Owes ${price(m.share_cents, g.cost.currency)}`} active={m.share_status === 'settled'} onPress={() => act(() => api.post(`/open-games/${g.id}/members/${m.member_id}/share`, { status: m.share_status === 'settled' ? 'due' : 'settled' }))} /> : null}
                  {started && g.status === 'open' ? <><Chip label="Played" active={m.attendance === 'attended'} onPress={() => act(() => api.post(`/open-games/${g.id}/members/${m.member_id}/attendance`, { attendance: 'attended' }))} /><Chip label="No-show" active={m.attendance === 'no_show'} onPress={() => act(() => api.post(`/open-games/${g.id}/members/${m.member_id}/attendance`, { attendance: 'no_show' }))} /></> : null}
                  {m.user_id !== g.host.id && g.status === 'open' ? <Chip label="Remove" onPress={() => act(() => api.post(`/open-games/${g.id}/members/${m.member_id}/decision`, { action: 'remove' }), 'Removed')} /> : null}
                </Wrap>
                {m.open_appeal ? (
                  <View style={{ backgroundColor: c.sunSoft, borderRadius: 12, padding: 10, gap: 6 }}>
                    <T size={12} weight="800">They asked for a review of the {m.open_appeal.fact === 'no_show' ? 'no-show' : 'late cancellation'}: “{m.open_appeal.reason}”</T>
                    <Wrap><Btn small title="Correct it" onPress={() => act(() => api.post(`/open-game-appeals/${m.open_appeal.id}/resolve`, { outcome: 'corrected' }), 'Corrected')} /><T size={12} color={c.mute}>Or leave it for the platform team.</T></Wrap>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : <T size={13} color={c.mute}>No one yet.</T>}
      </Card>
      {g.status === 'open' ? <Suggested g={g} /> : null}
    </View>
  );
}

/** One open game: the facts, joining, the people, the venue booking state, the game chat and — for the host — requests, shares and attendance. */
export function OpenGame({ id }) {
  const { user, toast } = useSession();
  const { push } = useNav();
  const q = useLoad(() => api.get(`/open-games/${id}`), [id]);
  const links = useLoad(() => (user ? api.get('/youth/guardian-links', { limit: 100 }) : Promise.resolve([])), [user?.id]);
  const [join, setJoin] = useState(false);
  const [edit, setEdit] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [appeal, setAppeal] = useState(null);
  const g = q.data;
  const kids = (links.data ?? []).filter((l) => l.my_side === 'guardian' && l.status === 'active' && l.child).map((l) => l.child);
  if (q.error) return <Screen><ErrorBox error={q.error} onRetry={q.reload} /></Screen>;
  if (!g) return <Screen><Loading /></Screen>;

  const now = Date.now(), start = +new Date(g.starts_at), end = g.ends_at ? +new Date(g.ends_at) : start + 3 * 36e5;
  const started = now >= start, open = g.status === 'open' && !started;
  const mine = g.my.filter((m) => m.user_id !== g.host.id && (LIVE.includes(m.status) || m.late_cancel || m.attendance === 'no_show'));
  const mineLive = g.my.filter((m) => m.user_id !== g.host.id && LIVE.includes(m.status));
  const childName = (uid) => (uid === user?.id ? 'You' : kids.find((k) => k.id === uid)?.display_name ?? 'Your child');
  const [bl, bc] = BOOKING[g.booking_state] ?? BOOKING.no_venue;
  const canJoin = open && !g.can_manage && (mineLive.length === 0 || kids.length > 0);
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); q.reload(); } catch (e) { toast(e.message); } };

  return (
    <Screen wide>
      <View style={{ gap: 6, marginTop: 6 }}>
        <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{g.sport_emoji} {g.sport.toUpperCase()}{g.format ? ` · ${g.format.toUpperCase()}` : ''}</T>
        <H1 style={{ fontSize: 28 }}>{g.title}</H1>
        <T weight="800" size={17} color={c.pink}>{when(g.starts_at)}{g.ends_at ? ` – ${new Date(g.ends_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}` : ''}</T>
        <T color={c.mute}>📍 {g.place.name}{g.place.city ? `, ${g.place.city}` : ''}</T>
        {g.status !== 'open' ? <Tag label={g.status === 'cancelled' ? 'This game was cancelled' : 'This game is over'} color={g.status === 'cancelled' ? c.red : c.violetSoft} /> : null}
      </View>

      <Card pad={16} style={{ marginTop: 14 }}>
        <View style={{ gap: 10 }}>
          <Seats g={g} />
          <Wrap gap={6}><Tag label={g.skill.label} /><Tag label={costLabel(g)} color={g.cost.mode === 'free' ? c.mint : c.violetSoft} />{g.audience !== 'adults' ? <Tag label={g.audience === 'youth' ? `Young players${g.min_age != null ? ` ${g.min_age}–${g.max_age ?? ''}` : ''}` : 'All ages'} color={c.cyan} /> : null}<Tag label={g.approval_mode === 'auto' ? 'Auto-approve if you fit' : 'Host approves'} />{g.venue_id ? <Tag label={bl} color={bc} /> : null}{g.team_name ? <Tag label={`${g.team_emoji ?? ''} ${g.team_name}`.trim()} color={c.sun} /> : null}</Wrap>
          {g.cost.mode === 'split_total' ? <T size={13} color={c.mute}>{price(g.cost.total_cents, g.cost.currency)} split across {g.max_players} seats.</T> : null}
          {g.role_needs.length ? <T size={13}>Looking for: <T weight="800" size={13}>{g.role_needs.join(', ')}</T></T> : null}
          {g.notes ? <T size={14}>{g.notes}</T> : null}
          <Pressable onPress={() => push('Person', { id: g.host.id })} accessibilityRole="link" accessibilityLabel={`Host ${g.host.display_name}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
            <Avatar user={g.host} size={34} /><T>Hosted by <T weight="800">{g.host.display_name}</T>{g.host.verified ? ' ✓ verified' : ''}</T>
          </Pressable>
          <T size={12} color={c.mute}>Cancel before {g.cancel_before_hours} hours to leave without a late-cancellation record.</T>
        </View>
      </Card>

      {g.status === 'open' && g.venue_id && g.booking_state !== 'confirmed' ? (
        <Card pad={14} color={c.sunSoft} style={{ marginTop: 12, gap: 6 }}>
          <T weight="800">{g.booking_state === 'cancelled' ? 'The booking behind this game was cancelled' : 'The court is not booked yet'}</T>
          <T size={13}>{g.can_manage ? 'This game does not hold the court. Book the slot, or link a booking you already have.' : 'The host has not confirmed the court yet. It may change.'}</T>
          {g.can_manage ? <Wrap><Btn small title="Book this slot" onPress={() => push('BookFlow', { venueId: g.venue_id, resourceId: g.resource_id ?? undefined, date: localDate(g.starts_at, g.venue_timezone), time: g.starts_at })} /><Btn small title="Link a booking" color={c.paper} ink={c.ink} onPress={() => setEdit(true)} /></Wrap> : null}
        </Card>
      ) : g.booking?.reservation_id && g.can_manage ? <Btn small title={`Booking ${g.booking.code ?? ''}`} color={c.paper} ink={c.ink} onPress={() => push('Reservation', { id: g.booking.reservation_id })} style={{ marginTop: 12, alignSelf: 'flex-start' }} /> : null}

      {mine.length ? (
        <View style={{ gap: 10, marginTop: 14 }}>
          {mine.map((m) => {
            const st = STATUS[m.status] ?? ['', c.violetSoft];
            const inWindow = m.status === 'confirmed' && now >= start - 60 * 6e4 && now <= end;
            return (
              <Card key={m.id} pad={14} color={c.limeSoft ?? c.paper} style={{ gap: 6 }}>
                <Wrap><T weight="800" style={{ flex: 1 }}>{childName(m.user_id)}</T><Tag label={st[0]} color={st[1]} /></Wrap>
                {m.status === 'guardian_pending' ? <T size={13}>A guardian has to approve this first. They were notified.</T> : null}
                {m.status === 'confirmed' && g.cost.mode !== 'free' && m.share_cents > 0 ? <T size={13}>Your share: {price(Number(m.share_cents), g.cost.currency)} — {m.share_status === 'settled' ? 'paid ✓' : 'pay the host or venue, they will mark it paid'}</T> : null}
                {m.attendance === 'attended' ? <T size={13} color={c.mint}>Attendance recorded ✓</T> : null}
                <Wrap>
                  {inWindow && m.attendance !== 'attended' ? <Btn small title="Check in" onPress={() => act(() => api.post(`/open-games/${g.id}/check-in`, m.user_id === user.id ? {} : { on_behalf_of: m.user_id }), 'Checked in ✓')} /> : null}
                  {LIVE.includes(m.status) && !started ? <Btn small title={m.status === 'confirmed' ? 'Leave game' : 'Withdraw'} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/open-games/${g.id}/leave`, m.user_id === user.id ? {} : { on_behalf_of: m.user_id }), 'Done')} /> : null}
                  {(m.attendance === 'no_show' || m.late_cancel) && !(m.appeal && m.appeal.status === 'open') ? <Btn small title="Ask for a review" color={c.paper} ink={c.ink} onPress={() => setAppeal({ member_id: m.id, fact: m.attendance === 'no_show' ? 'no_show' : 'late_cancel' })} /> : null}
                </Wrap>
                {m.appeal?.status === 'open' ? <T size={12} color={c.mute}>Your review request is open.</T> : null}
              </Card>
            );
          })}
        </View>
      ) : null}
      {canJoin ? (
        <Btn title={!user ? 'Sign in to join' : g.is_full ? 'Join the waitlist' : g.approval_mode === 'auto' ? 'Join this game' : 'Ask to join'} onPress={() => (user ? setJoin(true) : toast('Sign in to join a game'))} style={{ marginTop: 14 }} accessibilityLabel="Join this game" />
      ) : null}

      <View style={{ marginTop: 14, gap: 14 }}>
        <Card pad={14}>
          <H2>Who is playing</H2>
          {g.roster.length ? (
            <View style={{ gap: 10, marginTop: 8 }}>
              {g.roster.map((p) => (
                <Pressable key={p.member_id} onPress={() => push('Person', { id: p.id })} accessibilityRole="link" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
                  <Person p={p} /><View style={{ flex: 1 }}><T weight="700">{p.display_name}</T>{p.position ? <T size={12} color={c.mute}>{p.position}</T> : null}</View>
                </Pressable>
              ))}
              {g.other_players ? <T size={13} color={c.mute}>+ {g.other_players} young player{g.other_players === 1 ? '' : 's'} (names are never shown)</T> : null}
              {g.waitlist ? <T size={13} color={c.mute}>{g.waitlist} on the waitlist</T> : null}
            </View>
          ) : <Empty emoji="🙋" title="Nobody yet" sub="Be the first to join." />}
        </Card>
        {g.chat.available ? <Chat g={g} /> : null}
        {g.can_manage ? <HostPanel g={g} started={started} reload={q.reload} setEdit={setEdit} setCancel={setCancel} /> : null}
      </View>

      {join ? <JoinSheet g={g} kids={kids} onClose={() => setJoin(false)} onDone={() => { setJoin(false); q.reload(); }} /> : null}
      {edit ? <HostGameSheet game={g} onClose={() => setEdit(false)} onDone={() => { setEdit(false); toast('Saved'); q.reload(); }} /> : null}
      <FormSheet visible={cancel} onClose={() => setCancel(false)} title="Cancel this game?" submitLabel="Cancel game" color={c.red}
        notice="Everyone holding a place is told. Your venue booking stays until you cancel it yourself."
        fields={[{ key: 'reason', label: 'Reason (shown to players)', optional: true }]}
        onSubmit={async (v) => { const r = await api.post(`/open-games/${g.id}/cancel`, { reason: v.reason }); q.reload(); return r.note ?? 'Game cancelled'; }} />
      <FormSheet visible={!!appeal} onClose={() => setAppeal(null)} title="Ask for a review" submitLabel="Send"
        notice="The host can correct this record. If they do not, the platform team reviews it. While it is open the record shows as under review."
        fields={[{ key: 'reason', label: 'What is wrong?', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post('/open-game-appeals', { ...appeal, reason: v.reason }); q.reload(); return 'Review requested'; }} />
    </Screen>
  );
}
