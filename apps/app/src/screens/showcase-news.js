import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity } from 'react-native';
import { T } from '../ui';
import { palette } from '../theme';

const DEMO_NEWS = [
  { id: '1', category: 'analysis',  sport_id: 'tennis',     headline: 'How Alcaraz changed baseline defence',             deck: 'A deep dive into court geometry and shot selection at Roland Garros.', published_at: '2026-11-14' },
  { id: '2', category: 'results',   sport_id: 'football',   headline: 'Real Madrid Academy U18 win Copa del Rey',          deck: 'Three goals in the final 20 minutes secured the title.', published_at: '2026-11-13' },
  { id: '3', category: 'preview',   sport_id: 'cricket',    headline: 'India U19 squad named for World Cup campaign',      deck: 'Six debutants make the 15-man roster for South Africa.', published_at: '2026-11-12' },
  { id: '4', category: 'news',      sport_id: 'athletics',  headline: 'World record attempt confirmed at Zurich Diamond',  deck: 'Kipchoge sets his sights on the 10 km road world record.', published_at: '2026-11-11' },
  { id: '5', category: 'analysis',  sport_id: 'swimming',   headline: 'The science behind the fastest starts in history',  deck: 'Reaction time, block angle and underwater dolphin kicks.', published_at: '2026-11-10' },
  { id: '6', category: 'results',   sport_id: 'basketball', headline: 'Raptors Academy sweep finals in four games',        deck: 'Dominant rebounding and 3-point efficiency seal the title.', published_at: '2026-11-09' },
  { id: '7', category: 'preview',   sport_id: 'badminton',  headline: 'Asian Championship bracket confirmed for 2026',     deck: 'Six defending champions enter in the top four seeds.', published_at: '2026-11-08' },
  { id: '8', category: 'news',      sport_id: 'hockey',     headline: 'Olympic qualification rules updated for Paris',     deck: 'Continental play-off format confirmed by FIH Board.', published_at: '2026-11-07' },
];
const CATS   = ['all', 'news', 'analysis', 'results', 'preview'];
const SPORTS = ['all', 'tennis', 'football', 'cricket', 'athletics', 'swimming', 'basketball'];

export function ShowcaseNews({ manifest, block, onNavigate }) {
  const [cat, setCat]     = useState('all');
  const [sport, setSport] = useState('all');

  const source = manifest?.news?.length ? manifest.news : DEMO_NEWS;
  const news = source.filter(
    (n) => (cat === 'all' || n.category === cat) && (sport === 'all' || n.sport_id === sport),
  );

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Sports News</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Live editorial coverage across every sport</T>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {CATS.map((v) => (
          <TouchableOpacity key={v} onPress={() => setCat(v)} style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: v === cat ? palette.p2 : 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' }}>
            <T style={{ color: '#fff', fontSize: 12, fontWeight: '600', textTransform: 'capitalize' }}>{v}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {SPORTS.map((v) => (
          <TouchableOpacity key={v} onPress={() => setSport(v)} style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: v === sport ? palette.p3 : 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' }}>
            <T style={{ color: v === sport ? palette.p0 : 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '600', textTransform: 'capitalize' }}>{v}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView style={{ maxHeight: 260 }} showsVerticalScrollIndicator={false}>
        {(news.length ? news : DEMO_NEWS).map((item) => (
          <View key={item.id} style={{ marginBottom: 8, padding: 12, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' }}>
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
              <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20, backgroundColor: 'rgba(208,189,244,0.18)' }}>
                <T style={{ color: palette.p3, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' }}>{item.category}</T>
              </View>
              <T style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, alignSelf: 'center' }}>{item.sport_id} · {item.published_at?.slice(5)}</T>
            </View>
            <T style={{ color: '#fff', fontSize: 14, fontWeight: '700', lineHeight: 20, marginBottom: 2 }}>{item.headline}</T>
            <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, lineHeight: 17 }}>{item.deck}</T>
          </View>
        ))}
      </ScrollView>

      <TouchableOpacity onPress={() => onNavigate?.('news-discovery')} style={{ marginTop: 10, paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Explore live news →</T>
      </TouchableOpacity>
    </View>
  );
}
