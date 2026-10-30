import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Loading, Row, T } from '../ui';
import { HScroll } from '../pickers';
import { OpenPositions, ResumeApply } from './openings';
import { c } from '../theme';
import { MarketCard, KINDS } from '../market/MarketCard';
import { Composer } from '../market/Composer';
import { useMarketActions, useResumeIntent } from '../market/actions';
import { PlayerHero, COL } from '../hero';
import { ACTIONS } from './athlete-home';
import { WorkspaceBody, WorkspaceHeader, WorkspaceSettings, useWorkspace } from './command-centre';
import { locale } from '../locale';
import { DoctorEntry } from './doctor';
import { AdSlot } from '../ads';

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
          {games.data.games.slice(0, 4).map((g) => <T key={g.id} size={13} style={{ marginTop: 8 }}>{g.home_name} vs {g.away_name}<T size={12} color={c.mute}>  {new Date(g.scheduled_at).toLocaleDateString(locale)}</T></T>)}
        </Card>
      ) : null}
    </View>
  );
}

/** The member feed: a composer on top, then the same cards as the public page, LinkedIn-style, with reactions, comments and applications. */
export function Feed({ header, narrow }) {
  const { user } = useSession();
  const { push } = useNav();
  const L = useLayout();
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);
  const [compose, setCompose] = useState(null); // { kind?, ad? }
  const [resumeApply, setResumeApply] = useState(null);

  const load = useCallback(async (offset) => {
    setBusy(true); setErr(null);
    try { const list = await api.get('/market/posts', { limit: PAGE, offset }); setRows((r) => (offset ? [...r, ...list] : list)); setMore(list.length === PAGE); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(0); }, [load]);
  const onPatch = useCallback((id, patch) => setRows((r) => r.map((p) => (p.id === id ? { ...p, ...patch } : p))), []);
  const { gate, sheets } = useMarketActions({ onPatch });
  useResumeIntent(gate, user, { onPost: () => setCompose({}), onAdvertise: () => setCompose({ ad: true }), onBook: (b) => push('BookFlow', { venueId: b.venueId, resourceId: b.resourceId, date: b.date, time: b.time }), onApplyPosition: setResumeApply });

  const feed = (
    <View style={{ gap: 14 }}>
      <Card pad={14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Avatar user={user} size={44} />
          <Pressable onPress={() => setCompose({})} style={{ flex: 1, borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 18 }}><T color={c.mute} weight="600">Start a post — wanted, match, sale, campaign…</T></Pressable>
        </View>
        <HScroll style={{ marginTop: 12 }}>
          {Object.entries(KINDS).map(([k, v]) => <Pressable key={k} onPress={() => setCompose({ kind: k })} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: c.bg }}><T size={13} weight="700" color="#334155">{v.emoji} {v.label}</T></Pressable>)}
          <Pressable onPress={() => setCompose({ ad: true })} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: c.sunSoft }}><T size={13} weight="700" color="#92400E">⭐ Advertise</T></Pressable>
        </HScroll>
      </Card>
      <View style={{ gap: 8 }}>
        <T size={19} weight="700" style={{ letterSpacing: -0.3 }}>💼 Open positions</T>
        <OpenPositions compact limit={3} onSeeAll={() => push('Openings')} onOpenMine={() => push('Openings')} />
      </View>
      {err ? <ErrorBox error={err} onRetry={() => load(0)} /> : null}
      {busy && !rows.length ? <Loading /> : !rows.length && !err ? <Empty emoji="📭" title="Nothing here yet" sub="Be the first to post — athletes wanted, a match, kit for sale or a campaign." /> : rows.map((p, i) => <React.Fragment key={p.id}><MarketCard p={p} user={user} gate={gate} feed />{i === 2 ? <AdSlot placement="sponsored_post" style={{ marginVertical: 6 }} /> : null}</React.Fragment>)}
      {more ? <Pressable onPress={() => load(rows.length)} disabled={busy} style={{ alignSelf: 'center', borderRadius: 999, borderWidth: 1.5, borderColor: c.ink, paddingVertical: 11, paddingHorizontal: 26 }}><T weight="800">{busy ? 'Loading…' : 'Show more'}</T></Pressable> : null}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: L.bottomPad }}>
        {header}
        <View style={{ padding: L.gutter, width: '100%', maxWidth: narrow ? COL : L.tablet ? 1000 : 640, alignSelf: 'center' }}>
          {L.tablet && !narrow ? <View style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}><View style={{ flex: 1.7 }}>{feed}</View><View style={{ flex: 1 }}><Rail push={push} /></View></View> : feed}
        </View>
      </ScrollView>
      {compose ? <Composer visible onClose={() => setCompose(null)} initialKind={compose.kind ?? 'wanted'} ad={compose.ad} onPosted={() => load(0)} /> : null}
      {sheets}
      {resumeApply ? <ResumeApply positionId={resumeApply} onDone={() => setResumeApply(null)} /> : null}
    </View>
  );
}

const Title = ({ children, action, onAction }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
    <T size={19} weight="700" style={{ letterSpacing: -0.3 }}>{children}</T>
    {action ? <Pressable onPress={onAction}><T size={13} weight="700" color={c.pink}>{action}  ›</T></Pressable> : null}
  </View>
);

/** Home: one command centre per role (Today, Actions, Calendar, Inbox, Work, Insights) plus the community feed. Playing stats live in Player; planning and booking in Schedule. */
export default function HomeTab() {
  const { user } = useSession();
  const nav = useNav();
  const L = useLayout();
  const ws = useWorkspace();
  const [section, setSection] = useState('today');
  const [settings, setSettings] = useState(false);
  const sports = useLoad(() => api.get('/me/sport-profiles'), []);
  const profiles = sports.data ?? [];
  const main = profiles.find((p) => p.is_default) ?? profiles[0];
  const pad = L.gutter;
  const community = section === 'community';
  const wrap = { paddingHorizontal: pad, width: '100%', maxWidth: community ? COL : L.tablet ? 1000 : COL, alignSelf: 'center' };

  const header = (
    <View>
      <PlayerHero user={user} profile={main} pad={pad} onBell={() => setSection('inbox')} onAvatar={() => nav.goTab('Me')} />
      <View style={[wrap, { marginTop: 18 }]}>
        <HScroll>
          {ACTIONS.map(([emoji, label, go]) => <Chip key={label} label={`${emoji} ${label}`} onPress={() => go(nav)} />)}
        </HScroll>
        <View style={{ marginTop: 16 }}><DoctorEntry /></View>
        <View style={{ marginTop: 22 }}>
          <WorkspaceHeader ws={ws} section={section} onSection={setSection} onSettings={() => setSettings(true)} />
          {community ? null : <WorkspaceBody ws={ws} section={section} />}
        </View>
        {community ? <View style={{ marginTop: 30 }}><Title>Community</Title></View> : null}
      </View>
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      {community ? <Feed header={header} narrow /> : <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: L.bottomPad }}>{header}</ScrollView>}
      <WorkspaceSettings ws={ws} visible={settings} onClose={() => setSettings(false)} />
    </View>
  );
}
