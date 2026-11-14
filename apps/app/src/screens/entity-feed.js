// Entity Feed — public feed for a team, academy, venue, event, coach or organisation (issue #522).
// FeedCard and EntityFollowButton are exported for reuse in feed.js and other screens.
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, FlatList } from 'react-native';
import { useTranslation } from '../i18n/index.js';
import { c, r } from '../theme.js';
import { api } from '../api.js';

// ── SponsoredLabel ────────────────────────────────────────────────────────────
export function SponsoredLabel({ promoted }) {
  const { t } = useTranslation();
  return (
    <View style={{ backgroundColor: promoted ? c.violet : c.mute, borderRadius: r.xs, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color: c.paper, letterSpacing: 0.5 }}>
        {promoted ? t('cf.promoted') : t('cf.sponsored')}
      </Text>
    </View>
  );
}

// ── FeedCard ──────────────────────────────────────────────────────────────────
export function FeedCard({ card, onPress }) {
  const { t } = useTranslation();
  const kinds = {
    result: t('cf.card_result'), fixture: t('cf.card_fixture'), achievement: t('cf.card_achievement'),
    clip: t('cf.card_clip'), announcement: t('cf.card_announcement'), challenge: t('cf.card_challenge'),
    ranking: t('cf.card_ranking'), post: t('cf.card_post'),
  };
  const relativeTime = (iso) => {
    if (!iso) return '';
    const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  };
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={kinds[card.card_kind] || card.card_kind}
      onPress={() => onPress?.(card)}
      style={{ backgroundColor: c.paper, borderRadius: r.md, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.line }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ backgroundColor: c.bg, borderRadius: r.xs, paddingHorizontal: 7, paddingVertical: 3 }}>
            <Text style={{ fontSize: 11, fontWeight: '600', color: c.mute }}>{kinds[card.card_kind] || card.card_kind}</Text>
          </View>
          {card.sport_name ? (
            <Text style={{ fontSize: 12, color: c.mute }}>{card.sport_name}</Text>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {card.is_promoted && <SponsoredLabel promoted />}
          {card.is_sponsored && !card.is_promoted && <SponsoredLabel />}
          <Text style={{ fontSize: 11, color: c.mute }}>{relativeTime(card.published_at)}</Text>
        </View>
      </View>
      {card.title ? <Text style={{ fontSize: 15, fontWeight: '600', color: c.ink, marginBottom: 6 }}>{card.title}</Text> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 4 }}>
        <Text style={{ fontSize: 13, color: c.mute }}>
          {card.reactions_count > 0 ? `♥ ${card.reactions_count}` : t('cf.be_first_react')}
        </Text>
        {card.comments_count > 0 && (
          <Text style={{ fontSize: 13, color: c.mute }}>💬 {card.comments_count}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── EntityFollowButton ────────────────────────────────────────────────────────
export function EntityFollowButton({ entity_kind, entity_id, initialFollowing = false, followersCount = 0, onToggle }) {
  const { t } = useTranslation();
  const [following, setFollowing] = useState(initialFollowing);
  const [count, setCount] = useState(followersCount);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (following) {
        await api.delete(`/feed/follow/${entity_kind}/${entity_id}`);
        setFollowing(false);
        setCount((n) => Math.max(0, n - 1));
      } else {
        await api.post(`/feed/follow/${entity_kind}/${entity_id}`);
        setFollowing(true);
        setCount((n) => n + 1);
      }
      onToggle?.(following);
    } finally {
      setLoading(false);
    }
  }, [following, loading, entity_kind, entity_id]);

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={following ? t('cf.unfollow') : t('cf.follow')}
      onPress={toggle}
      style={{
        backgroundColor: following ? c.line : c.pink,
        borderRadius: r.full,
        paddingHorizontal: 18,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        opacity: loading ? 0.6 : 1,
        minWidth: 90,
        justifyContent: 'center',
        minHeight: 44,
      }}
    >
      {loading
        ? <ActivityIndicator size="small" color={following ? c.ink : c.paper} />
        : <Text style={{ fontSize: 14, fontWeight: '700', color: following ? c.ink : c.paper }}>{following ? t('cf.unfollow') : t('cf.follow')}</Text>}
    </TouchableOpacity>
  );
}

// ── EntityFeed ────────────────────────────────────────────────────────────────
export function EntityFeed({ route }) {
  const { t } = useTranslation();
  const { entity_kind, entity_id } = route?.params ?? {};
  const [data, setData] = useState(null);
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [followState, setFollowState] = useState({ following: false, count: 0 });

  const load = useCallback(async (before = null) => {
    if (!entity_kind || !entity_id) return;
    if (before) setLoadingMore(true); else setLoading(true);
    try {
      const qs = before ? `?before=${encodeURIComponent(before)}` : '';
      const res = await api.get(`/feed/public/${entity_kind}/${entity_id}${qs}`);
      if (!before) {
        setData(res);
        setCards(res.cards ?? []);
        setFollowState({ following: false, count: res.followers_count ?? 0 });
        // Check own follow state
        try {
          const fRes = await api.get(`/feed/follow/${entity_kind}/${entity_id}`);
          setFollowState({ following: fRes.following, count: fRes.followers_count ?? res.followers_count });
        } catch { /* unauthenticated */ }
      } else {
        setCards((prev) => [...prev, ...(res.cards ?? [])]);
      }
      const last = (res.cards ?? []).slice(-1)[0];
      setCursor(last ? `${last.published_at}|${last.id}` : null);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [entity_kind, entity_id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
      <ActivityIndicator color={c.pink} size="large" />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderColor: c.line, backgroundColor: c.paper }}>
        <View>
          <Text style={{ fontSize: 18, fontWeight: '700', color: c.ink }}>{data?.name ?? t('cf.entity_feed_title')}</Text>
          <Text style={{ fontSize: 13, color: c.mute, marginTop: 2 }}>
            {`${followState.count} ${t('cf.followers')}`}
          </Text>
        </View>
        <EntityFollowButton
          entity_kind={entity_kind}
          entity_id={entity_id}
          initialFollowing={followState.following}
          followersCount={followState.count}
          onToggle={(wasFollowing) => setFollowState((s) => ({ ...s, following: !wasFollowing, count: !wasFollowing ? s.count + 1 : Math.max(0, s.count - 1) }))}
        />
      </View>
      {/* Cards */}
      <FlatList
        data={cards}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 14 }}
        renderItem={({ item }) => <FeedCard card={item} />}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <Text style={{ fontSize: 24, marginBottom: 10 }}>📭</Text>
            <Text style={{ fontSize: 16, fontWeight: '600', color: c.ink }}>{t('cf.no_posts')}</Text>
            <Text style={{ fontSize: 13, color: c.mute, textAlign: 'center', marginTop: 6, paddingHorizontal: 40 }}>{t('cf.no_posts_body')}</Text>
          </View>
        }
        onEndReached={() => { if (cursor && !loadingMore) load(cursor); }}
        onEndReachedThreshold={0.3}
        ListFooterComponent={loadingMore ? <ActivityIndicator color={c.pink} style={{ padding: 20 }} /> : null}
      />
    </View>
  );
}
