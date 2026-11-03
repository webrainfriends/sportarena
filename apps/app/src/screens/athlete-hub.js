import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';
import { StartTeamSheet } from './play';
import { ActivityCard } from '../social/people';

// The athlete's front door: nine cards, each opening the screen that already does the job (calendar, venues, profile, community,
// coach, physio, teams, learning, people they follow). Previews come from the same endpoints those screens use; nothing is copied.
const when = (iso) => { try { return new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

function Tile({ icon, title, sub, onPress, children, wide }) {
  const label = [title, sub].filter(Boolean).join('. ');
  return (
    <Card onPress={onPress} pad={14} accessibilityLabel={label} style={{ flexGrow: 1, flexBasis: wide ? '100%' : '46%', minHeight: 88, gap: 4 }}>
      <T weight="800" size={wide ? 17 : 15}>{icon} {title}</T>
      {sub ? <T size={13} color={c.mute}>{sub}</T> : null}
      {children}
    </Card>
  );
}

export function AthleteHub({ sport }) {
  const { push, goTab } = useNav();
  const { tablet } = useLayout();
  const [team, setTeam] = useState(false);
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const sched = useLoad(() => api.get('/me/sport-schedule', { from, to }), []);
  const posts = useLoad(() => api.get('/market/posts', { limit: 3, offset: 0 }), []);
  const feed = useLoad(() => api.get('/me/activity-feed', { limit: 3 }), []);
  const next = (sched.data?.items ?? []).slice(0, 3);
  const sportName = sport?.sport ?? null;
  const share = tablet ? '31%' : '46%';
  const T2 = (p) => <Tile {...p} />;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 12 }}>
        {T2({ wide: true, icon: '📅', title: t('ws.hub.calendar'), sub: next.length ? undefined : t('ws.hub.calendar_empty'), onPress: () => goTab('Schedule', { section: 'agenda' }),
          children: next.map((x) => (
            <View key={`${x.source_type}${x.source_id}`} style={{ paddingVertical: 4, borderTopWidth: 1, borderTopColor: c.line }}>
              <T weight="700" size={14} numberOfLines={1}>{x.title}</T>
              <T size={12} color={c.mute}>{when(x.starts_at)}</T>
            </View>
          )) })}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {[
          { icon: '📍', title: t('ws.hub.venue'), sub: sportName ? t('ws.hub.venue_sub', { sport: sportName }) : t('ws.hub.venue_sub_any'), onPress: () => goTab('Schedule', { section: 'book', sport: sport?.sport_slug }) },
          { icon: '🏟️', title: t('ws.hub.event'), sub: t('ws.hub.event_sub'), onPress: () => goTab('Explore', { sport: sport?.sport_slug }) },
          { icon: '🏅', title: t('ws.hub.profile'), sub: t('ws.hub.profile_sub'), onPress: () => goTab('Player') },
          { icon: '🧑‍🏫', title: t('ws.hub.coach'), sub: t('ws.hub.coach_sub'), onPress: () => goTab('Schedule', { section: 'coach' }) },
          { icon: '💼', title: t('ws.hub.sponsor'), sub: t('ws.hub.sponsor_sub'), onPress: () => push('FundingOpportunities', { sport: sport?.sport_slug }) },
          { icon: '🩺', title: t('ws.hub.physio'), sub: t('ws.hub.physio_sub'), onPress: () => push('Health', { tab: 'find' }) },
          { icon: '🤝', title: t('ws.hub.team'), sub: t('ws.hub.team_sub'), onPress: () => setTeam(true) },
          { icon: '🎓', title: t('ws.hub.learn'), sub: t('ws.hub.learn_sub'), onPress: () => push('Pathways') },
        ].map((p) => <View key={p.title} style={{ flexGrow: 1, flexBasis: share, minWidth: 150, display: 'flex' }}><Tile {...p} /></View>)}
      </View>
      <Tile wide icon="💬" title={t('ws.hub.community')} sub={(posts.data ?? []).length ? undefined : t('ws.community_sub')} onPress={() => push('Community')}>
        {(posts.data ?? []).slice(0, 3).map((p) => (
          <View key={p.id} style={{ paddingVertical: 4, borderTopWidth: 1, borderTopColor: c.line }}>
            <T weight="700" size={14} numberOfLines={1}>{p.title}</T>
          </View>
        ))}
      </Tile>
      <View style={{ gap: 10 }}>
        <T weight="800" size={17}>👥 {t('ws.hub.following')}</T>
        {(feed.data ?? []).length ? (
          <>
            {(feed.data ?? []).map((i) => <ActivityCard key={i.key} item={i} onChanged={feed.reload} />)}
            <Btn small title={t('ws.hub.see_all')} color={c.paper} ink={c.ink} onPress={() => push('Community')} />
          </>
        ) : (
          <Card pad={14} onPress={() => push('Network', { section: 'suggestions' })} accessibilityLabel={t('ws.hub.following_find')}>
            <T size={13} color={c.mute}>{t('ws.hub.following_empty')}</T>
            <T weight="700" color={c.pink}>{t('ws.hub.following_find')} →</T>
          </Card>
        )}
      </View>
      <StartTeamSheet visible={team} onClose={() => setTeam(false)} onCreated={() => { setTeam(false); sched.reload(); }} />
    </View>
  );
}
