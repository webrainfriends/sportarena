import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { c, r } from '../theme';
import { T } from '../ui';
import { ShowcaseNews } from './showcase-news';
import { ShowcaseAthletes } from './showcase-athletes';
import { ShowcaseVenues } from './showcase-venues';
import { ShowcaseAcademies } from './showcase-academies';
import { ShowcaseMatches } from './showcase-matches';
import { ShowcaseCoaches } from './showcase-coaches';
import { ShowcasePhysios } from './showcase-physios';
import { ShowcaseSponsors } from './showcase-sponsors';
import { ShowcaseSuppliers } from './showcase-suppliers';
import { ShowcaseLearn } from './showcase-learn';

const CHAPTERS = [
  { key: 'news',      label: '📰 News',        Component: ShowcaseNews },
  { key: 'athletes',  label: '🏃 Athletes',     Component: ShowcaseAthletes },
  { key: 'venues',    label: '🏟️ Venues',        Component: ShowcaseVenues },
  { key: 'academies', label: '🏫 Academies',     Component: ShowcaseAcademies },
  { key: 'matches',   label: '🏆 Matches',       Component: ShowcaseMatches },
  { key: 'coaches',   label: '🧑‍🏫 Coaches',      Component: ShowcaseCoaches },
  { key: 'physios',   label: '🩺 Physios',       Component: ShowcasePhysios },
  { key: 'sponsors',  label: '🤝 Sponsors',      Component: ShowcaseSponsors },
  { key: 'suppliers', label: '🔧 Suppliers',     Component: ShowcaseSuppliers },
  { key: 'learn',     label: '📚 Learn',         Component: ShowcaseLearn },
];

function ChipNav({ active, onSelect }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
      {CHAPTERS.map(({ key, label }) => {
        const sel = active === key;
        return (
          <Pressable key={key} onPress={() => onSelect(key)} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: sel }}
            style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
            <View style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: r.pill, backgroundColor: sel ? c.pink : c.paper, borderWidth: 1.5, borderColor: sel ? c.pink : c.line, minHeight: 44, justifyContent: 'center' }}>
              <T weight="700" size={13} color={sel ? '#fff' : c.ink}>{label}</T>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function SideNav({ active, onSelect }) {
  return (
    <View style={{ width: 200, gap: 4, paddingTop: 8 }}>
      {CHAPTERS.map(({ key, label }) => {
        const sel = active === key;
        return (
          <Pressable key={key} onPress={() => onSelect(key)} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: sel }}
            style={{ paddingVertical: 12, paddingHorizontal: 16, borderRadius: r.card, backgroundColor: sel ? c.pinkSoft : 'transparent', minHeight: 44 }}>
            <T weight={sel ? '700' : '500'} size={14} color={sel ? c.pink : c.ink}>{label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ShowcaseLanding({ manifest, onNavigate, previewMode }) {
  const { width } = useWindowDimensions();
  const [activeKey, setActiveKey] = useState('news');
  if (!manifest) return null;

  const wide = width >= 768;
  const chapter = CHAPTERS.find((c) => c.key === activeKey) ?? CHAPTERS[0];
  const { Component } = chapter;
  const block = manifest.blocks?.find((b) => b.config?.chapter === activeKey) ?? null;
  const onCta = previewMode ? () => {} : (routeKey) => onNavigate?.(routeKey);

  if (wide) {
    return (
      <View style={{ flexDirection: 'row', backgroundColor: c.bg, minHeight: 480, borderRadius: r.card, overflow: 'hidden', marginVertical: 16 }}>
        <View style={{ borderEndWidth: 1, borderEndColor: c.line }}>
          <SideNav active={activeKey} onSelect={setActiveKey} />
        </View>
        <View style={{ flex: 1, padding: 24 }}>
          {previewMode && (
            <View style={{ backgroundColor: c.sun, paddingVertical: 8, paddingHorizontal: 16, borderRadius: r.card, marginBottom: 16 }}>
              <T weight="700" size={12} color="#fff">PREVIEW MODE — CTAs disabled</T>
            </View>
          )}
          <Component block={block} manifest={manifest} onCta={onCta} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ backgroundColor: c.bg }}>
      <ChipNav active={activeKey} onSelect={setActiveKey} />
      {previewMode && (
        <View style={{ backgroundColor: c.sun, paddingVertical: 8, paddingHorizontal: 16, marginHorizontal: 16, borderRadius: r.card, marginBottom: 8 }}>
          <T weight="700" size={12} color="#fff">PREVIEW MODE — CTAs disabled</T>
        </View>
      )}
      <View style={{ padding: 16 }}>
        <Component block={block} manifest={manifest} onCta={onCta} />
      </View>
    </View>
  );
}
