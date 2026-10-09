import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Seg, T } from '../ui';
import { c } from '../theme';
import { MarketCard, KINDS } from '../market/MarketCard';
import { Composer } from '../market/Composer';
import { useMarketActions, useResumeIntent } from '../market/actions';
import { PlayerHero, StatTiles, NowStrip, AboutCard, ageOf } from '../hero';
import { ACTIONS, Item } from './athlete-home';
import { SportCard } from './player';
import { localDate } from '../vtime';

const PAGE = 10;

/** Right rail on wide screens: what's waiting on you. */
function Rail({ push }) {
  const mine = useLoad(() => api.get('/market/applications', { limit: 5 }), []);
  const games = useLoad(() => api.get('/market/highlights'), []);
  return (
    <View style={{ gap: 14 }}>
      <Card pad={16}>
        <T weight="800" size={15}>My applications</T>
        {mine.data?.length ? mine.data.map((a) => <Row key={a.id} title={a.title} sub={a.status} color={c.paper} />) : <T size={13} color={c.mute} style={{ marginTop: 6 }}>Apply to a card and track the answer here.</T>}
      </Card>
      {games.data?.games?.length ? (
        <Card pad={16}>
          <T weight="800" size={15}>Coming up</T>
          {games.data.games.slice(0, 4).map((g) => <T key={g.id} size={13} style={{ marginTop: 8 }}>{g.home_name} vs {g.away_name}<T size={12} color={c.mute}>  {new Date(g.scheduled_at).toLocaleDateString()}</T></T>)}
        </Card>
      ) : null}
    </View>
  );
}

/** The member feed: a composer on top, then the same cards as the public page, LinkedIn-style, with reactions, comments and applications. */
export function Feed({ header }) {
  const { user } = useSession();
  const { push } = useNav();
  const L = useLayout();
  const [kind, setKind] = useState(null);
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);
  const [compose, setCompose] = useState(null); // { kind?, ad? }

  const load = useCallback(async (offset) => {
    setBusy(true); setErr(null);
    try { const list = await api.get('/market/posts', { kind: kind ?? undefined, limit: PAGE, offset }); setRows((r) => (offset ? [...r, ...list] : list)); setMore(list.length === PAGE); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }, [kind]);
  useEffect(() => { load(0); }, [load]);
  const onPatch = useCallback((id, patch) => setRows((r) => r.map((p) => (p.id === id ? { ...p, ...patch } : p))), []);
  const { gate, sheets } = useMarketActions({ onPatch });
  useResumeIntent(gate, user, { onPost: () => setCompose({}), onAdvertise: () => setCompose({ ad: true }) });

  const feed = (
    <View style={{ gap: 14 }}>
      <Card pad={14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Avatar user={user} size={44} />
          <Pressable onPress={() => setCompose({})} style={{ flex: 1, borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 18 }}><T color={c.mute} weight="600">Start a post — wanted, match, sale, campaign…</T></Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginTop: 12 }}>
          {Object.entries(KINDS).map(([k, v]) => <Pressable key={k} onPress={() => setCompose({ kind: k })} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: c.bg }}><T size={13} weight="700" color="#334155">{v.emoji} {v.label}</T></Pressable>)}
          <Pressable onPress={() => setCompose({ ad: true })} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: '#FEF3C7' }}><T size={13} weight="700" color="#92400E">⭐ Advertise</T></Pressable>
        </ScrollView>
      </Card>
      <Seg options={[{ value: null, label: '✨ All' }, ...Object.entries(KINDS).map(([k, v]) => ({ value: k, label: `${v.emoji} ${v.label}` }))]} value={kind} onChange={setKind} />
      {err ? <ErrorBox error={err} onRetry={() => load(0)} /> : null}
      {busy && !rows.length ? <Loading /> : !rows.length && !err ? <Empty emoji="📭" title="Nothing here yet" sub="Be the first to post — athletes wanted, a match, kit for sale or a campaign." /> : rows.map((p) => <MarketCard key={p.id} p={p} user={user} gate={gate} feed />)}
      {more ? <Pressable onPress={() => load(rows.length)} disabled={busy} style={{ alignSelf: 'center', borderRadius: 999, borderWidth: 1.5, borderColor: c.ink, paddingVertical: 11, paddingHorizontal: 26 }}><T weight="800">{busy ? 'Loading…' : 'Show more'}</T></Pressable> : null}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: L.bottomPad }}>
        {header}
        <View style={{ padding: L.gutter, width: '100%', maxWidth: L.tablet ? 1000 : 640, alignSelf: 'center' }}>
          {L.tablet ? <View style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}><View style={{ flex: 1.7 }}>{feed}</View><View style={{ flex: 1 }}><Rail push={push} /></View></View> : feed}
        </View>
      </ScrollView>
      {compose ? <Composer visible onClose={() => setCompose(null)} initialKind={compose.kind ?? 'wanted'} ad={compose.ad} onPosted={() => load(0)} /> : null}
      {sheets}
    </View>
  );
}

const Title = ({ children, action, onAction }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
    <T size={19} weight="700" style={{ letterSpacing: -0.3 }}>{children}</T>
    {action ? <Pressable onPress={onAction}><T size={13} weight="700" color={c.pink}>{action}  ›</T></Pressable> : null}
  </View>
);

/** Home tab: a player card on top (identity, stats, what's on today), then the community feed. */
export default function HomeTab() {
  const { user, toast } = useSession();
  const nav = useNav();
  const L = useLayout();
  const dash = useLoad(() => api.get('/dashboard'), []);
  const sports = useLoad(() => api.get('/me/sport-profiles'), []);
  const sched = useLoad(() => api.get('/me/sport-schedule'), []);
  const hi = useLoad(() => api.get('/market/highlights'), []);
  const profiles = sports.data ?? [];
  const makeDefault = async (p) => { try { await api.post(`/me/sport-profiles/${p.id}/default`); await sports.reload(); toast(`${p.sport} is now your default`); } catch (e) { toast(e.message); } };
  const main = profiles.find((p) => p.is_default) ?? profiles[0];
  const matches = profiles.reduce((a, p) => a + p.summary.matches, 0);
  const items = sched.data?.items ?? [];
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDate(new Date().toISOString(), zone);
  const inbox = items.filter((x) => x.action_required);
  const todays = items.filter((x) => !x.action_required && localDate(x.starts_at, x.all_day ? 'UTC' : zone) === today);
  const game = hi.data?.games?.[0];
  const pad = L.gutter;
  const age = ageOf(user.dob);
  const top = main?.metrics?.[0];
  const tiles = [
    ...(age !== null ? [['Age', age]] : []),
    ['Matches', sports.data ? matches : '–'],
    top ? [String(top.metric).replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase()), Number.isInteger(+top.total) ? +top.total : (+top.total).toFixed(1)] : ['Points', dash.data?.points ?? '–'],
  ];
  if (tiles.length < 3) tiles.push(['Points', dash.data?.points ?? '–']);
  if (tiles.length < 3) tiles.push(['Trophies', dash.data?.trophies ?? '–']);
  const wrap = { paddingHorizontal: pad, width: '100%', maxWidth: L.tablet ? 1000 : 640, alignSelf: 'center' };

  const header = (
    <View>
      <PlayerHero user={user} profile={main} pad={pad} onBell={() => nav.push('Notifications')} onAvatar={() => nav.goTab('Me')} />
      <StatTiles pad={pad} items={tiles} />
      {game ? <NowStrip pad={pad} title={`${game.home_name} vs ${game.away_name}`} date={[new Date(game.scheduled_at).getDate(), new Date(game.scheduled_at).toLocaleString(undefined, { month: 'short' })]} sub={`${new Date(game.scheduled_at).toLocaleString()}${game.event_name ? ` · ${game.event_name}` : ''}`} onPress={() => nav.goTab('Play')} /> : null}
      <View style={[wrap, { marginTop: 22 }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {ACTIONS.map(([emoji, label, go]) => <Chip key={label} label={`${emoji} ${label}`} onPress={() => go(nav)} />)}
        </ScrollView>
        {inbox.length ? <View style={{ marginTop: 26, gap: 10 }}><Title>{`Needs your response (${inbox.length})`}</Title>{inbox.map((x) => <Item key={`i${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />)}</View> : null}
        <View style={{ marginTop: 26, gap: 10 }}>
          <Title action="Full schedule" onAction={() => nav.goTab('Player')}>Today</Title>
          {sched.error ? <ErrorBox error={sched.error} onRetry={sched.reload} /> : sched.loading && !sched.data ? <Loading /> : todays.length ? todays.map((x) => <Item key={`t${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />) : <Empty emoji="🗓️" title="Nothing scheduled today" sub="Find a match, book a venue or hire a coach to fill your week." />}
        </View>
        <View style={{ marginTop: 26 }}>
          <Title action="All sports" onAction={() => nav.goTab('Player')}>My sports</Title>
          {sports.error ? <ErrorBox error={sports.error} onRetry={sports.reload} /> : sports.loading && !sports.data ? <Loading /> : profiles.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingBottom: 6 }}>
              {profiles.map((p) => <SportCard key={p.id} p={p} width={300} onOpen={() => nav.push('SportProfile', { id: p.id })} onDefault={() => makeDefault(p)} onLog={() => nav.push('SportProfile', { id: p.id })} />)}
            </ScrollView>
          ) : (
            <Card><View style={{ gap: 10, alignItems: 'flex-start' }}><T weight="700">Add the sports you play</T><T size={13} color={c.mute}>One card per sport tracks your matches, form and stats.</T><Btn small title="+ Add sport" onPress={() => nav.goTab('Player')} /></View></Card>
          )}
        </View>
        <View style={{ marginTop: 26 }}><AboutCard user={user} profile={main} /></View>
        <View style={{ marginTop: 30 }}><Title>Community</Title></View>
      </View>
    </View>
  );
  return <Feed header={header} />;
}
