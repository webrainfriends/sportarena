// The public tournament & spectator experience (#501): the event page for everyone (signed in or not), the live centre of a game, following and sharing.
// Everything reads the public projection (/public/...); the UI only calls the API. Works on phone, tablet, desktop web, iOS and Android:
// no web-only APIs without a Platform branch, 44pt touch targets, accessible labels, and lists as well as drawings for tables and brackets.
import { locale } from '../locale';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, Share, View } from 'react-native';
import { API, api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { usePoll } from '../live';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Bubble, Card, Chip, Empty, ErrorBox, H2, Loading, Row, Screen, Seg, Sheet, T, Tag } from '../ui';
import { AdSlot } from '../ads';
import { A, ABracket, ABtn, ACard, AChip, AEmpty, AScreen, ASection, AT, ScoreTicker } from '../arena';
import { StageBoard } from '../bracket-board';
import { StandingsTable } from '../blocks';
import { c } from '../theme';
import { openStored } from '../tender-ui';

// ---------------------------------------------------------------- labels
export const STATE = { live: ['LIVE', c.red], upcoming: ['UPCOMING', c.cyan], in_progress: ['UNDER WAY', c.mint], paused: ['PAUSED', c.sun], completed: ['COMPLETED', c.lime], cancelled: ['CANCELLED', c.mute] };
const RESULT = { live: ['LIVE', c.red], provisional: ['FULL TIME · PROVISIONAL', c.sun], final: ['FINAL', c.lime], scheduled: null, cancelled: ['CANCELLED', c.mute], postponed: ['POSTPONED', c.sun], abandoned: ['ABANDONED', c.red] };
const ALERTS = [['start', 'Kick-off'], ['score', 'Scores'], ['result', 'Results'], ['schedule', 'Schedule changes'], ['media', 'New photos & clips']];
const REACT = { fire: '🔥', clap: '👏', wow: '😮', strong: '💪' };
const stamp = (iso, tz) => { try { return new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }); } catch { return ''; } };
const dayKey = (iso, tz) => { try { return new Date(iso).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz || undefined }); } catch { return ''; } };

export const Pill = ({ label, color = c.cyan, big }) => (
  <View accessibilityLabel={label} style={{ alignSelf: 'flex-start', backgroundColor: color === c.paper ? c.line : `${color}22`, borderRadius: 999, paddingHorizontal: big ? 14 : 10, paddingVertical: big ? 7 : 4, borderWidth: 1, borderColor: `${color}66` }}>
    <T size={big ? 12.5 : 10.5} weight="800" color={color} style={{ letterSpacing: 0.9 }}>{label}</T>
  </View>
);

/** Open a public page URL: the absolute link people can paste anywhere. */
export function absolute(path) {
  if (/^https?:/.test(path)) return path;
  const origin = API.startsWith('/') ? (typeof location !== 'undefined' ? location.origin : '') : API.replace(/\/api\/v1$/, '');
  return `${origin}${path}`;
}

/** Sign-in is the one thing an anonymous visitor cannot do here: send them to the app's front door (web), or tell them. */
function useSignIn() {
  const { toast } = useSession();
  return useCallback(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.assign(window.location.pathname);
    else toast('Sign in to do that');
  }, [toast]);
}

// ---------------------------------------------------------------- share
export function ShareButton({ card, arena, label = 'Share' }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(null);
  const load = async () => {
    try { setOpen(await api.get(`/public/share/${card.type}/${card.id}`)); }
    catch (e) { toast(e.status === 404 ? 'This can only be shared once it is public' : e.status === 409 ? 'This result is not final yet' : '' + e.message); }
  };
  const send = async () => {
    const url = absolute(open.page_path);
    const text = `${open.description}\n${url}`;
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) await navigator.share({ title: open.title, text: open.description, url });
        else if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(url); toast('Link copied'); }
        else toast(url);
      } else await Share.share({ title: open.title, message: text, url });
    } catch { /* the person closed the share sheet */ }
  };
  const Button = arena ? ABtn : Btn;
  return (
    <>
      <Button small title={`↗ ${label}`} {...(arena ? { tone: 'ghost' } : { color: c.paper, ink: c.ink })} onPress={load} accessibilityLabel={`${label} this ${card.type === 'fixture' || card.type === 'result' ? 'game' : card.type}`} />
      <Sheet visible={!!open} onClose={() => setOpen(null)} title="Share">
        {open ? (
          <View style={{ gap: 12 }}>
            <View accessibilityLabel={open.description} style={{ backgroundColor: '#2A2D3A', borderRadius: 18, padding: 18, gap: 8 }}>
              <T size={13} weight="700" color="#B3B9CC">{open.kicker}</T>
              <Pill label={open.label} color={open.state === 'live' ? '#FB7185' : open.state === 'provisional' ? '#FBBF24' : '#5FD39A'} />
              <T size={24} weight="800" color="#fff">{open.title}</T>
              {open.lines.map((l, i) => <T key={i} size={13.5} color="#D0BDF4">{l}</T>)}
            </View>
            <T size={12.5} color={c.mute}>The shared page shows only what the public can already see. If the organiser makes the event private, the link stops working.</T>
            <Btn title={Platform.OS === 'web' ? 'Share or copy link' : 'Share'} onPress={send} />
          </View>
        ) : null}
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------- follow
export function FollowButton({ type, id, name, mine, onChange, arena, compact }) {
  const { user, toast } = useSession();
  const signIn = useSignIn();
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState(mine?.alerts ?? ['start', 'result', 'schedule']);
  const [busy, setBusy] = useState(false);
  const [cur, setCur] = useState(mine ?? null);
  useEffect(() => { setCur(mine ?? null); if (mine) setAlerts(mine.alerts); }, [mine?.id, mine?.alerts?.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k) => setAlerts((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));
  const save = async () => {
    setBusy(true);
    try { const f = await api.post('/me/follows', { subject_type: type, subject_id: id, alerts }); setCur({ id: f.id, alerts: f.alerts }); toast(cur ? 'Alerts updated' : `Following ${name}`); setOpen(false); onChange?.(); }
    catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { await api.del(`/me/follows/${cur.id}`); setCur(null); toast(`Stopped following ${name}`); setOpen(false); onChange?.(); }
    catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };
  const Button = arena ? ABtn : Btn;
  return (
    <>
      <Button small title={cur ? '✓ Following' : '＋ Follow'} {...(arena ? { tone: cur ? 'lime' : 'ghost' } : { color: cur ? c.violetSoft : c.pink, ink: cur ? c.ink : '#fff' })} onPress={() => setOpen(true)} accessibilityLabel={cur ? `Following ${name}. Change alerts` : `Follow ${name}`} />
      <Sheet visible={open} onClose={() => setOpen(false)} title={cur ? `Following ${name}` : `Follow ${name}`}>
        {!user ? (
          <View style={{ gap: 12 }}>
            <T color={c.mute}>Sign in to follow {name} and get alerts when games start, scores change and results are made official.</T>
            <Btn title="Sign in or join" onPress={signIn} />
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <T color={c.mute}>Choose your alerts. Following never gives access to rosters, health, finance or youth information.</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="toolbar">
              {ALERTS.map(([k, label]) => <Chip key={k} label={label} active={alerts.includes(k)} onPress={() => toggle(k)} />)}
            </View>
            {!alerts.length ? <T size={12.5} color={c.mute}>No alerts: you will see it under Following but won't be notified.</T> : null}
            <Btn title={cur ? 'Save alerts' : 'Follow'} loading={busy} onPress={save} />
            {cur ? <Btn title="Unfollow" color={c.paper} ink={c.ink} loading={busy} onPress={stop} /> : null}
          </View>
        )}
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------- games
export function GameCard({ g, onPress }) {
  const r = RESULT[g.label];
  const sc = g.score;
  const home = g.winner_team_id && g.winner_team_id === g.home.team_id, away = g.winner_team_id && g.winner_team_id === g.away.team_id;
  const a11y = `${g.home.name} ${sc ? `${sc.home} to ${sc.away}` : 'versus'} ${g.away.name}. ${r ? r[0].toLowerCase() : stamp(g.scheduled_at, g.timezone)}${g.corrected ? '. Result corrected' : ''}${g.rescheduled ? '. Rescheduled' : ''}`;
  const side = (s, won) => (
    <View style={{ flex: 1, alignItems: 'center', gap: 2 }}><T size={28}>{s.emoji ?? '🛡️'}</T><T weight={won ? '800' : '600'} size={13} style={{ textAlign: 'center' }} numberOfLines={2}>{s.name}</T></View>
  );
  return (
    <Card onPress={onPress} pad={14} accessibilityLabel={a11y}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T size={12} weight="700" color={c.mute}>{[g.round, g.venue?.name ?? g.court].filter(Boolean).join(' · ')}</T>
        {r ? <Pill label={r[0]} color={r[1]} /> : <T size={12} weight="700" color={c.mute}>{stamp(g.scheduled_at, g.timezone)}</T>}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
        {side(g.home, home)}
        <View style={{ minWidth: 84, alignItems: 'center', backgroundColor: c.violetSoft, borderRadius: 12, paddingVertical: 6, paddingHorizontal: 10 }}>
          <T size={22} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{sc ? `${sc.home} – ${sc.away}` : 'v'}</T>
        </View>
        {side(g.away, away)}
      </View>
      {(g.corrected || g.rescheduled) ? (
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 10, justifyContent: 'center' }}>
          {g.corrected ? <Pill label="RESULT CORRECTED" color={c.orange} /> : null}{g.rescheduled ? <Pill label="RESCHEDULED" color={c.sun} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

function GamesList({ id, openGame }) {
  const [filter, setFilter] = useState('all');
  const list = useLoad(() => api.get(`/public/events/${id}/fixtures`, { limit: 100 }), [id]);
  const items = list.data?.items ?? [];
  const shown = items.filter((g) => filter === 'all' || (filter === 'live' ? g.label === 'live' : filter === 'results' ? ['final', 'provisional'].includes(g.label) : g.label === 'scheduled'));
  const groups = [];
  for (const g of shown) { const k = dayKey(g.scheduled_at, g.timezone); const last = groups[groups.length - 1]; if (last?.k === k) last.items.push(g); else groups.push({ k, items: [g] }); }
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  return (
    <View style={{ gap: 10 }}>
      <Seg options={[{ value: 'all', label: 'All' }, { value: 'live', label: 'Live' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'results', label: 'Results' }]} value={filter} onChange={setFilter} />
      {!groups.length ? <Empty emoji="🗓️" title={items.length ? 'Nothing in this view' : 'No games scheduled yet'} sub={items.length ? 'Try another filter.' : 'The schedule appears here as soon as the organiser publishes it.'} /> : groups.map((gr) => (
        <View key={gr.k} style={{ gap: 10 }}>
          <T size={13} weight="800" color={c.mute} accessibilityRole="header">{gr.k}</T>
          {gr.items.map((g) => <GameCard key={g.id} g={g} onPress={() => openGame(g.id)} />)}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- table and bracket
function TableView({ id, openGame }) {
  const t = useLoad(() => api.get(`/public/events/${id}/standings`), [id]);
  const b = useLoad(() => api.get(`/public/events/${id}/bracket`), [id]);
  const [view, setView] = useState('list');
  if ((t.loading && !t.data) || (b.loading && !b.data)) return <Loading />;
  if (t.error) return <ErrorBox error={t.error} onRetry={t.reload} />;
  const label = (x) => (x === 'final' ? ['FINAL TABLE', c.lime] : ['PROVISIONAL TABLE', c.sun]);
  return (
    <View style={{ gap: 12 }}>
      {t.data.rows.length ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Pill label={label(t.data.label)[0]} color={label(t.data.label)[1]} big />
            {t.data.label === 'provisional' && t.data.games_to_finalise ? <T size={12.5} color={c.mute}>{t.data.games_to_finalise} game{t.data.games_to_finalise === 1 ? '' : 's'} still to be made official</T> : null}
          </View>
          <StandingsTable rows={t.data.rows} />
          <T size={11.5} color={c.mute}>Win {t.data.points.win} · draw {t.data.points.draw} · loss {t.data.points.loss}. Only official (completed) games count.</T>
        </>
      ) : null}
      {b.data?.stages?.length ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <H2>Bracket & rounds</H2><Pill label={b.data.label === 'final' ? 'FINAL' : 'PROVISIONAL'} color={b.data.label === 'final' ? c.lime : c.sun} />
          </View>
          <View style={{ backgroundColor: A.bg, borderRadius: 20, padding: 8, gap: 12 }}>
            {b.data.stages.map((s) => <StageBoard key={s.id} stage={s} onGame={(g) => openGame(g.id)} />)}
          </View>
          <T size={11.5} color={c.mute}>Provisional results change when official results are published or corrected, and corrections are labelled. <T size={11.5} weight="800" color={c.mute}>Print, share or embed this bracket</T> from the event’s share link.</T>
        </>
      ) : null}
      {!t.data.rows.length && !b.data?.stages?.length ? <Empty emoji="📊" title="No table yet" sub="Teams and results appear here as the event gets under way." /> : null}
    </View>
  );
}

// ---------------------------------------------------------------- sponsors, media
export function Sponsors({ list, title = 'Partners' }) {
  const { toast } = useSession();
  if (!list?.length) return null;
  const SLOT = { title_partner: 'Title partner', leaderboard: 'Leaderboard partner', scorecard: 'Scorecard partner', fixture: 'Game partner' };
  const go = async (p) => {
    try { const r = await api.post(p.cta.click_path.replace(/^\/?/, '/')); await Linking.openURL(r.url); } catch (e) { toast('' + e.message); }
  };
  return (
    <View style={{ gap: 8 }}>
      <T size={13} weight="800" color={c.mute} accessibilityRole="header">{title.toUpperCase()}</T>
      {list.map((p) => (
        <Row key={p.id} left={<Bubble emoji={p.sponsor.emoji} color={c.sunSoft} />} title={p.sponsor.name} sub={SLOT[p.slot] ?? p.slot}
          right={p.cta ? <Btn small title={p.cta.label} color={c.paper} ink={c.ink} onPress={() => go(p)} /> : null} />
      ))}
    </View>
  );
}

function MediaList({ list }) {
  if (!list?.length) return <Empty emoji="🎞️" title="No media yet" sub="Approved photos, highlights and clips the organiser publishes appear here." />;
  return (
    <View style={{ gap: 10 }}>
      {list.map((m) => (
        <Row key={m.id} onPress={() => Linking.openURL(mediaUrl(m.link))} left={<Bubble emoji={m.kind === 'photo' ? '📷' : m.kind === 'document' ? '📰' : '🎬'} color={c.cyanSoft} />} title={m.title} sub={[m.caption, m.credit ? `Credit: ${m.credit}` : null].filter(Boolean).join(' · ') || m.right_kind.replace(/_/g, ' ')} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- the spectator section of the event page
export function SpectatorBody({ id, p, openGame, goTeam, extra = [] }) {
  const { user } = useSession();
  const [tab, setTab] = useState(p.fixtures.live.length ? 'games' : p.standings.rows.length || p.bracket.rounds.length ? 'table' : 'games');
  const live = useLoad(() => api.get(`/public/events/${id}/fixtures`, { status: 'live', limit: 12 }), [id]);
  usePoll(live.reload, p.event.state === 'live' ? 8000 : 30000);
  const liveNow = live.data?.items ?? p.fixtures.live;
  const tabs = [{ value: 'games', label: 'Games' }, { value: 'table', label: 'Table & bracket' }, { value: 'teams', label: `Teams${p.entrants.length ? ` (${p.entrants.length})` : ''}` }, { value: 'awards', label: 'Awards' }, { value: 'media', label: 'Media' }, ...extra.map((x) => ({ value: x.value, label: x.label }))];
  return (
    <View style={{ gap: 12, marginTop: 8 }}>
      {liveNow.length ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Pill label="LIVE NOW" color={c.red} big /><T size={12.5} color={c.mute}>{liveNow.length} game{liveNow.length === 1 ? '' : 's'} in progress</T></View>
          {liveNow.map((g) => <GameCard key={g.id} g={g} onPress={() => openGame(g.id)} />)}
        </View>
      ) : null}
      {p.sponsors.placements.filter((x) => x.slot === 'title_partner').length ? <Sponsors list={p.sponsors.placements.filter((x) => x.slot === 'title_partner')} title="Presented by" /> : null}
      <AdSlot placement="event_display" eventId={id} sport={p.event.sport?.slug} city={p.event.city || undefined} />
      <Seg options={tabs} value={tab} onChange={setTab} />
      {tab === 'games' && <GamesList id={id} openGame={openGame} />}
      {tab === 'table' && (
        <>
          {p.sponsors.placements.filter((x) => x.slot === 'leaderboard').length ? <Sponsors list={p.sponsors.placements.filter((x) => x.slot === 'leaderboard')} title="Table partner" /> : null}
          <AdSlot placement="scorecard_leaderboard" eventId={id} sport={p.event.sport?.slug} />
          <TableView id={id} openGame={openGame} />
          {p.races.length ? <View style={{ gap: 8 }}><H2>Races</H2>{p.races.map((r) => <Row key={r.id} onPress={() => (goTeam ? goTeam.race(r.id) : null)} left={<Bubble emoji={r.emoji ?? '🏃'} color={c.limeSoft} />} title={r.name} sub={`${r.sport ?? ''} · live results`} />)}</View> : null}
        </>
      )}
      {tab === 'teams' && (
        <View style={{ gap: 10 }}>
          {p.entrants.length ? p.entrants.map((x) => <Row key={x.team_id ?? x.user_id} onPress={user && x.team_id ? () => goTeam.team(x.team_id) : undefined} left={<Bubble emoji={x.emoji ?? '🏃'} color={x.color ?? c.cyan} />} title={x.name} sub={x.handle ? `@${x.handle}` : undefined} />) : <Empty emoji="👥" title="No entrants yet" sub="Teams appear once the organiser accepts them." />}
          <Sponsors list={p.sponsors.supporters.map((s) => ({ id: s.id, slot: 'supporter', sponsor: s, cta: null }))} title="Supporters" />
        </View>
      )}
      {tab === 'awards' && (p.awards.length ? p.awards.map((a) => <Row key={a.id} left={<Bubble emoji={a.kind === 'cup' || a.kind === 'trophy' ? '🏆' : a.kind.startsWith('medal') ? '🏅' : '⭐'} color={c.sunSoft} />} title={a.name} sub={a.team?.name ?? a.athlete?.name} right={<Tag label="Official" color={c.lime} />} />) : <Empty emoji="🏆" title="No awards yet" sub="Official awards are added when the event is completed." />)}
      {tab === 'media' && <MediaList list={p.media} />}
      {extra.find((x) => x.value === tab)?.node}
      {p.event.youth ? <T size={12} color={c.mute}>This is a youth event: players are not named and personal details are never shown.</T> : null}
    </View>
  );
}

// ---------------------------------------------------------------- the public event header (shared by the event page and the signed-out page)
export function EventHeader({ p, mine, onFollowChange }) {
  const e = p.event;
  const st = STATE[e.state] ?? STATE.upcoming;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill label={st[0]} color={st[1]} big />
        {e.visibility === 'unlisted' ? <Pill label="LINK ONLY" color={c.mute} /> : e.visibility === 'private' ? <Pill label="PRIVATE" color={c.mute} /> : null}
        {p.follow.followers ? <T size={12.5} color={c.mute} weight="700">{p.follow.followers} following</T> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <FollowButton type="event" id={e.id} name={e.name} mine={mine} onChange={onFollowChange} />
        <ShareButton card={p.share.card} />
      </View>
    </View>
  );
}

export function EventFacts({ p }) {
  const e = p.event, r = p.registration;
  const d = (x) => (x ? new Date(`${String(x).slice(0, 10)}T00:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : null);
  const facts = [
    e.starts_on ? ['🗓️', [d(e.starts_on), e.ends_on && e.ends_on !== e.starts_on ? d(e.ends_on) : null].filter(Boolean).join(' → ')] : null,
    e.venue ? ['📍', [e.venue.name, e.venue.city].filter(Boolean).join(', ')] : e.city ? ['📍', e.city] : null,
    e.organiser?.name ? ['🏢', `Organised by ${e.organiser.name}`] : null,
    e.format.stages.length ? ['🧩', e.format.stages.map((s) => s.name).join(' → ')] : null,
    e.levels?.length ? ['🎯', `Level: ${e.levels.map((l) => l.replace(/_/g, '-')).join(', ')}`] : null,
    e.min_age || e.max_age ? ['🎂', `Ages ${e.min_age ?? ''}${e.max_age ? `–${e.max_age}` : '+'}`] : null,
    r.open ? ['🪪', `Registration open${r.deadline ? ` until ${d(r.deadline)}` : ''}${r.spots_left != null ? ` · ${r.spots_left} spot${r.spots_left === 1 ? '' : 's'} left` : ''}${r.fee_cents ? '' : ' · free'}`] : null,
  ].filter(Boolean);
  return <View style={{ gap: 6, marginTop: 4 }}>{facts.map(([i, t]) => <T key={t} size={14} color={c.ink}>{i}  {t}</T>)}</View>;
}

// ---------------------------------------------------------------- the signed-out page
/** Signed-out visitors opening a shared link (?event=…&fixture=…): a small navigator that can only open public screens. */
export function PublicShell({ eventId, fixtureId, renderEvent }) {
  const { stack, back } = useNav();
  const signIn = useSignIn();
  const top = stack[stack.length - 1];
  const view = top ? top : fixtureId ? { name: 'LiveCentre', params: { id: fixtureId } } : { name: 'Event', params: { id: eventId } };
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 52, borderBottomWidth: 1, borderColor: c.line }}>
        {top ? <Pressable onPress={back} accessibilityRole="button" accessibilityLabel="Back" style={{ minHeight: 44, minWidth: 44, justifyContent: 'center' }}><T weight="700" color={c.pink}>‹ Back</T></Pressable> : <T weight="800" size={17}>Gotmygame</T>}
        <Btn small title="Sign in" onPress={signIn} />
      </View>
      {view.name === 'LiveCentre' ? <LiveCentre {...view.params} /> : renderEvent(view.params)}
    </View>
  );
}

// ---------------------------------------------------------------- the live centre of one game
const adapt = (v) => ({
  fixture: { status: v.status, round: v.round, home: v.home && { name: v.home.name, emoji: v.home.emoji, color: v.home.color }, away: v.away && { name: v.away.name, emoji: v.away.emoji, color: v.away.color }, final: v.status === 'completed' ? { home: v.score.home, away: v.score.away } : null },
  score: { ...v.score, sets: v.score.sets ?? [] }, ruleset: v.ruleset && { label: v.ruleset.label, kind: v.ruleset.kind, periods: { label: v.ruleset.period_label } }, phase: v.phase ?? {},
});

/** Live updates of the public view: a stream on the web, short polling elsewhere (and as the fallback). */
function usePublicLive(id, enabled) {
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let es = null, timer = null, alive = true;
    const poll = async () => { try { const f = await api.get(`/public/fixtures/${id}`, { refresh: true }); if (alive) setLive(f.live); } catch { /* keep the last view */ } if (alive) timer = setTimeout(poll, 5000); };
    if (Platform.OS === 'web' && typeof EventSource !== 'undefined') {
      es = new EventSource(`${API}/live/public/fixtures/${id}`);
      es.addEventListener('state', (e) => { try { if (alive) setLive(JSON.parse(e.data)); } catch { /* ignore a bad frame */ } });
      es.onerror = () => { es?.close(); es = null; poll(); };
    } else poll();
    return () => { alive = false; es?.close(); clearTimeout(timer); };
  }, [id, enabled]);
  return live;
}

export function LiveCentre({ id }) {
  const { user, toast } = useSession();
  const { push } = useNav();
  const signIn = useSignIn();
  const first = useLoad(() => api.get(`/public/fixtures/${id}`), [id]);
  const [fresh, setFresh] = useState(null); // later reads say refresh=true so polling is not counted as sponsor exposure
  const reload = useCallback(() => api.get(`/public/fixtures/${id}`, { refresh: true }).then(setFresh).catch(() => {}), [id]);
  usePoll(reload, 30000);
  const view = fresh ?? first.data;
  const streamed = usePublicLive(id, !!view && ['live', 'paused', 'finished'].includes(view.fixture.status));
  const v = { loading: first.loading, data: view, error: first.error, reload: first.error ? first.reload : reload };
  if (v.loading && !v.data) return <AScreen><Loading /></AScreen>;
  if (v.error && !v.data) return <AScreen><ErrorBox error={v.error} onRetry={v.reload} /></AScreen>;
  const live = streamed ?? view.live;
  const f = view.fixture;
  const status = streamed?.status ?? f.status;
  const label = RESULT[streamed?.label ?? f.label];
  const eng = view.engagement;
  const react = async (r) => {
    if (!user) return signIn();
    try { await api.post(`/public/fixtures/${id}/reaction`, { reaction: r }); v.reload(); } catch (e) { toast('' + e.message); }
  };
  const vote = async (cid) => {
    if (!user) return signIn();
    try { await api.post(`/public/fixtures/${id}/mvp-vote`, { candidate_id: cid }); toast('Vote counted'); v.reload(); } catch (e) { toast('' + e.message); }
  };
  const scored = view.live.timeline.filter((e) => !['period_start', 'period_end'].includes(e.kind));
  return (
    <AScreen>
      <ScoreTicker g={adapt({ ...live, status, round: f.round })} />
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {label ? <View style={{ backgroundColor: `${label[1]}33`, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}><AT size={12} weight="900" color={status === 'finished' ? A.sun : A.ink}>{label[0]}</AT></View> : <AT size={13} weight="700" color={A.mute}>{stamp(f.scheduled_at, f.timezone)}{f.venue ? ` · ${f.venue.name}` : ''}</AT>}
        {f.corrected ? <View style={{ backgroundColor: `${A.orange}33`, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}><AT size={12} weight="900" color={A.orange}>RESULT CORRECTED</AT></View> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <FollowButton type="fixture" id={id} name={`${f.home.name} v ${f.away.name}`} mine={view.follow.mine} onChange={v.reload} arena />
        <ShareButton card={view.share.result ?? view.share.fixture} arena label={view.share.result ? 'Share result' : 'Share'} />
        <ABtn small tone="ghost" title={`‹ ${view.event.name}`} onPress={() => push('Event', { id: view.event.id })} />
      </View>
      {status === 'finished' ? <AT size={12.5} color={A.mute}>Full time. This result is provisional until the organiser approves the score sheet.</AT> : null}

      {view.streams.filter((s) => s.playback_ref || s.archive_ref).map((s) => (
        <ACard key={s.id} tone={s.state === 'live' ? A.red : undefined} onPress={() => Linking.openURL(s.state === 'ended' && s.archive_ref ? s.archive_ref : s.playback_ref)}>
          <AT weight="800">📺 {s.state === 'live' ? 'Watch live' : s.state === 'ended' ? 'Watch the replay' : 'Stream (starts soon)'}</AT><AT size={12} color={A.mute}>Opens the broadcaster's page</AT>
        </ACard>
      ))}

      {eng.reactions.enabled ? (
        <ACard>
          <AT weight="800" style={{ marginBottom: 8 }}>React</AT>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {eng.reactions.choices.map((r) => <AChip key={r} label={`${REACT[r]} ${eng.reactions.counts[r]}`} active={eng.reactions.mine === r} onPress={() => react(r)} />)}
          </View>
        </ACard>
      ) : null}

      <AdSlot placement="scorecard_leaderboard" eventId={view.event.id} sport={view.event.sport_slug} />
      <ASection title="Timeline" sub={view.live.ruleset.label} />
      {scored.length ? <ACard>{[...scored].reverse().map((e) => (
        <View key={e.seq} style={{ flexDirection: 'row', gap: 10, paddingVertical: 7, alignItems: 'center' }}>
          <AT size={12} weight="800" color={A.mute} style={{ width: 34 }} num>{e.clock_seconds != null ? `${Math.floor(e.clock_seconds / 60)}'` : ''}</AT>
          <AT size={14} weight="700" style={{ flex: 1 }}>{e.label}{e.side ? ` · ${e.side === 'home' ? f.home.name : f.away.name}` : ''}{e.player ? ` — ${e.player.display_name}` : ''}</AT>
        </View>
      ))}</ACard> : <AEmpty emoji="⏱️" title="Nothing yet" sub={status === 'scheduled' ? 'Events appear here as the game is played.' : 'No events were logged.'} />}

      {eng.mvp_vote.enabled ? (
        <>
          <ASection title="Fan MVP" sub={eng.mvp_vote.label} />
          <ACard>
            {eng.mvp_vote.candidates.map((cd) => (
              <Pressable key={cd.id} disabled={!eng.mvp_vote.open} onPress={() => vote(cd.id)} accessibilityRole="button" accessibilityLabel={`Vote for ${cd.display_name}`} accessibilityState={{ selected: eng.mvp_vote.mine === cd.id }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 }}>
                <AT size={20}>{cd.avatar_emoji}</AT><AT weight={eng.mvp_vote.mine === cd.id ? '900' : '600'} style={{ flex: 1 }}>{cd.display_name}</AT><AT color={A.mute} num>{cd.votes}</AT>{eng.mvp_vote.mine === cd.id ? <AT color={A.green}>✓</AT> : null}
              </Pressable>
            ))}
            {!eng.mvp_vote.open ? <AT size={12} color={A.mute} style={{ marginTop: 6 }}>Voting is closed.</AT> : null}
          </ACard>
        </>
      ) : null}

      {view.officials.length ? (<><ASection title="Match officials" /><ACard>{view.officials.map((o, i) => <AT key={i} size={14}>{o.role}: {o.display_name}</AT>)}</ACard></>) : null}
      {view.sponsors.length ? (<><ASection title="Partners" />{view.sponsors.map((s) => <ACard key={s.id}><AT weight="800">{s.sponsor.emoji} {s.sponsor.name}</AT><AT size={12} color={A.mute}>{{ title_partner: 'Title partner', scorecard: 'Scorecard partner', fixture: 'Game partner', leaderboard: 'Leaderboard partner' }[s.slot]}</AT>{s.cta ? <ABtn small tone="ghost" title={s.cta.label} style={{ marginTop: 8 }} onPress={async () => { try { Linking.openURL((await api.post(s.cta.click_path)).url); } catch (e) { toast('' + e.message); } }} /> : null}</ACard>)}</>) : null}
      {view.media.length ? (<><ASection title="Photos & highlights" />{view.media.map((m) => <ACard key={m.id} onPress={() => Linking.openURL(mediaUrl(m.link))}><AT weight="700">{m.kind === 'photo' ? '📷' : '🎬'} {m.title}</AT>{m.credit ? <AT size={12} color={A.mute}>Credit: {m.credit}</AT> : null}</ACard>)}</>) : null}
      {view.corrections.length ? (
        <>
          <ASection title="Changes" sub="Corrections are listed; the earlier official state is kept on record." />
          <ACard>{view.corrections.map((x) => (
            <AT key={x.id} size={13} style={{ paddingVertical: 4 }}>
              {x.kind === 'result' ? `Score ${x.before.home_score ?? 0}–${x.before.away_score ?? 0} → ${x.after.home_score ?? 0}–${x.after.away_score ?? 0}${x.official_before ? ' (official result corrected)' : ''}` : x.kind === 'schedule' ? `Moved to ${stamp(x.after.scheduled_at, f.timezone)}` : `Game ${x.after.status}`}
            </AT>
          ))}</ACard>
        </>
      ) : null}
    </AScreen>
  );
}

// ---------------------------------------------------------------- what I follow
export function Following() {
  const { push } = useNav();
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/follows'), []);
  const [edit, setEdit] = useState(null);
  const feed = useLoad(() => api.get('/me/media-feed', { limit: 12 }), []);
  const openMedia = async (m) => { try { if (m.link?.startsWith('http')) await Linking.openURL(m.link); else await openStored(m.link, m.title); } catch (e) { toast('' + e.message); } };
  const open = (x) => (x.subject_type === 'event' ? push('Event', { id: x.subject_id }) : x.subject_type === 'fixture' ? push('LiveCentre', { id: x.subject_id }) : x.subject_type === 'team' ? push('Team', { id: x.subject_id }) : push('Person', { id: x.subject_id }));
  const NAME = { event: 'Events', team: 'Teams', athlete: 'Athletes', fixture: 'Games' };
  return (
    <Screen>
      <H2 style={{ marginTop: 8 }}>Following</H2>
      <T color={c.mute}>Alerts for the events, teams, athletes and games you follow. Following never gives access to private information.</T>
      {feed.data?.items?.length ? (
        <View style={{ marginTop: 18, gap: 8 }}>
          <T size={13} weight="800" color={c.mute} accessibilityRole="header">NEW PHOTOS & CLIPS</T>
          {feed.data.items.map((m) => (
            <Row key={m.id} onPress={() => openMedia(m)} left={<Bubble emoji={m.kind === 'photo' ? '📸' : '🎞️'} color={c.violetSoft} />} title={m.title} sub={[m.event.name, m.credit].filter(Boolean).join(' · ')} right={<T size={13} weight="800" color={c.violet}>Open</T>} />
          ))}
        </View>
      ) : null}
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty emoji="🔔" title="You are not following anything yet" sub="Open an event, team or live game and tap Follow." /> : (
        Object.keys(NAME).filter((k) => list.data.some((x) => x.subject_type === k)).map((k) => (
          <View key={k} style={{ marginTop: 18, gap: 8 }}>
            <T size={13} weight="800" color={c.mute} accessibilityRole="header">{NAME[k].toUpperCase()}</T>
            {list.data.filter((x) => x.subject_type === k).map((x) => (
              <Row key={x.id} onPress={() => open(x)} left={<Bubble emoji={x.emoji ?? (k === 'fixture' ? '⚽' : '🏆')} color={c.violetSoft} />} title={x.label ?? 'No longer available'}
                sub={x.alerts.length ? x.alerts.map((a) => ALERTS.find((y) => y[0] === a)?.[1]).join(' · ') : 'No alerts'} right={<Btn small title="Alerts" color={c.paper} ink={c.ink} onPress={() => setEdit(x)} />} />
            ))}
          </View>
        ))
      )}
      <Sheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.label ?? 'Alerts'}>
        {edit ? <FollowEditor x={edit} onDone={() => { setEdit(null); list.reload(); }} toast={toast} /> : null}
      </Sheet>
    </Screen>
  );
}

function FollowEditor({ x, onDone, toast }) {
  const [alerts, setAlerts] = useState(x.alerts);
  const [busy, setBusy] = useState(false);
  const run = async (fn, msg) => { setBusy(true); try { await fn(); toast(msg); onDone(); } catch (e) { toast('' + e.message); } finally { setBusy(false); } };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{ALERTS.map(([k, label]) => <Chip key={k} label={label} active={alerts.includes(k)} onPress={() => setAlerts((a) => (a.includes(k) ? a.filter((y) => y !== k) : [...a, k]))} />)}</View>
      <Btn title="Save alerts" loading={busy} onPress={() => run(() => api.post('/me/follows', { subject_type: x.subject_type, subject_id: x.subject_id, alerts }), 'Alerts updated')} />
      <Btn title="Unfollow" color={c.paper} ink={c.ink} loading={busy} onPress={() => run(() => api.del(`/me/follows/${x.id}`), 'Unfollowed')} />
    </View>
  );
}

