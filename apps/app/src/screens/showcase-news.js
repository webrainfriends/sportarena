import React, { useState } from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T, Wrap } from '../ui';

const LOCALES = { headline: 'Sports News', filter_all: 'All', cta: 'Explore live news →', empty_title: 'No news yet', empty_sub: 'Stories will appear here when published.' };

function StoryCard({ item, onPress }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={item.headline} style={({ pressed }) => ({ opacity: pressed ? 0.88 : 1 })}>
      <View style={{ width: 280, backgroundColor: c.paper, borderRadius: r.card, overflow: 'hidden', borderWidth: 1, borderColor: c.line }}>
        <View style={{ height: 110, backgroundColor: c.pinkSoft, justifyContent: 'flex-end', padding: 12 }}>
          <View style={{ backgroundColor: c.pink, alignSelf: 'flex-start', paddingVertical: 3, paddingHorizontal: 8, borderRadius: r.pill }}>
            <T size={10} weight="700" color="#fff">{(item.category ?? 'general').toUpperCase()}</T>
          </View>
        </View>
        <View style={{ padding: 12, gap: 4 }}>
          <T weight="700" size={14} numberOfLines={2}>{item.headline}</T>
          {item.deck ? <T size={12} color={c.mute} numberOfLines={2}>{item.deck}</T> : null}
          {item.published_at ? <T size={11} color={c.mute}>{new Date(item.published_at).toLocaleDateString()}</T> : null}
        </View>
      </View>
    </Pressable>
  );
}

export function ShowcaseNews({ block, manifest, onCta }) {
  const news = manifest?.news ?? [];
  const categories = ['All', ...Array.from(new Set(news.map((n) => n.category).filter(Boolean)))];
  const [cat, setCat] = useState('All');

  const filtered = cat === 'All' ? news : news.filter((n) => n.category === cat);
  const cover = filtered[0] ?? null;

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{LOCALES.headline}</T>

      {/* Category filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {categories.map((k) => {
          const sel = cat === k;
          return (
            <Pressable key={k} onPress={() => setCat(k)} accessibilityRole="button" accessibilityLabel={k} accessibilityState={{ selected: sel }}>
              <View style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: r.pill, backgroundColor: sel ? c.ink : c.paper, borderWidth: 1, borderColor: sel ? c.ink : c.line, minHeight: 44, justifyContent: 'center' }}>
                <T size={13} weight="600" color={sel ? c.inkOn : c.mute}>{k}</T>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Cover story */}
      {cover ? (
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <View style={{ height: 160, backgroundColor: c.violetSoft, justifyContent: 'flex-end' }}>
            <View style={{ position: 'absolute', bottom: 0, start: 0, end: 0, padding: 16, backgroundColor: 'rgba(42,45,58,0.72)' }}>
              <View style={{ backgroundColor: c.pink, alignSelf: 'flex-start', paddingVertical: 3, paddingHorizontal: 8, borderRadius: r.pill, marginBottom: 6 }}>
                <T size={10} weight="700" color="#fff">{(cover.category ?? 'general').toUpperCase()}</T>
              </View>
              <T weight="800" size={17} color="#fff" numberOfLines={2}>{cover.headline}</T>
            </View>
          </View>
          {cover.deck ? <View style={{ padding: 14 }}><T size={13} color={c.mute}>{cover.deck}</T></View> : null}
        </Card>
      ) : (
        <Card>
          <T weight="700" size={16}>{LOCALES.empty_title}</T>
          <T size={13} color={c.mute}>{LOCALES.empty_sub}</T>
        </Card>
      )}

      {/* Story cards rail */}
      {filtered.length > 1 && (
        <FlatList
          horizontal
          data={filtered.slice(1)}
          keyExtractor={(item) => item.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 12 }}
          renderItem={({ item }) => <StoryCard item={item} onPress={() => onCta('news-discovery')} />}
        />
      )}

      <Btn title={LOCALES.cta} onPress={() => onCta('news-discovery')} />
    </View>
  );
}
