import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Avatar, Card, Empty, ErrorBox, Loading, Row, Seg, T } from '../ui';
import { c } from '../theme';
import { MarketCard, KINDS } from '../market/MarketCard';
import { Composer } from '../market/Composer';
import { useMarketActions, useResumeIntent } from '../market/actions';
import Home from './home';

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
export function Feed() {
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
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: L.gutter, paddingBottom: L.bottomPad, width: '100%', maxWidth: L.tablet ? 1000 : 640, alignSelf: 'center' }}>
        {L.tablet ? <View style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}><View style={{ flex: 1.7 }}>{feed}</View><View style={{ flex: 1 }}><Rail push={push} /></View></View> : feed}
      </ScrollView>
      {compose ? <Composer visible onClose={() => setCompose(null)} initialKind={compose.kind ?? 'wanted'} ad={compose.ad} onPosted={() => load(0)} /> : null}
      {sheets}
    </View>
  );
}

/** Home tab: the member feed by default, with the personal season dashboard one tap away. */
export default function HomeTab() {
  const [view, setView] = useState('feed');
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 6 }}><Seg options={[{ value: 'feed', label: '📰 Feed' }, { value: 'season', label: '🏅 My season' }]} value={view} onChange={setView} /></View>
      {view === 'feed' ? <Feed /> : <Home />}
    </View>
  );
}
