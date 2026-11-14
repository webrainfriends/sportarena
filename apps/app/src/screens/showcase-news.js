import React, { useState, useRef, useEffect } from 'react';
import { View, ScrollView, TouchableOpacity, Platform, LayoutAnimation, UIManager, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { T } from '../ui';
import { palette } from '../theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

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

const SPORT_ACCENT = {
  tennis: 'rgba(132,88,179,0.35)',
  football: 'rgba(47,143,95,0.35)',
  cricket: 'rgba(214,119,6,0.35)',
  athletics: 'rgba(220,50,50,0.35)',
  swimming: 'rgba(0,150,200,0.35)',
  basketball: 'rgba(255,100,0,0.35)',
  badminton: 'rgba(80,180,120,0.35)',
  hockey: 'rgba(0,120,200,0.35)',
};

function ChapterHero() {
  const glow = useRef(new Animated.Value(0.3)).current;
  const bar  = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(glow, { toValue: 0.8, duration: 1800, useNativeDriver: true }),
      Animated.timing(glow, { toValue: 0.3, duration: 1800, useNativeDriver: true }),
    ])).start();
    Animated.timing(bar, { toValue: 1, duration: 600, delay: 200, useNativeDriver: false }).start();
  }, []);
  const accent = 'rgba(160,210,235,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -8, left: -8, right: -8, bottom: -8, borderRadius: 36, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 28 }}>📰</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 4, textAlign: 'center' }}>Sports News</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>Live editorial coverage across every sport</T>
      <Animated.View style={{ height: 2, borderRadius: 1, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

export function ShowcaseNews({ manifest, block, onNavigate }) {
  const [cat, setCat]       = useState('all');
  const [sport, setSport]   = useState('all');
  const [expanded, setExp]  = useState({});
  const source = manifest?.news?.length ? manifest.news : DEMO_NEWS;
  const news = source.filter(
    (n) => (cat === 'all' || n.category === cat) && (sport === 'all' || n.sport_id === sport),
  );
  const items = news.length ? news : DEMO_NEWS;

  const anims = useRef(DEMO_NEWS.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    Animated.stagger(55, anims.map((a) => Animated.timing(a, { toValue: 1, duration: 300, useNativeDriver: true }))).start();
  }, []);

  const toggleExp = (id) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExp((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const glass = {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  };

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <ChapterHero />

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

      <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
        {items.map((item, i) => (
          <Animated.View
            key={item.id}
            style={{
              opacity: anims[Math.min(i, anims.length - 1)],
              transform: [{ translateY: anims[Math.min(i, anims.length - 1)].interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
              marginBottom: 8,
            }}>
            <TouchableOpacity onPress={() => toggleExp(item.id)} activeOpacity={0.85}>
              <View style={[glass, { overflow: 'hidden' }]}>
                <LinearGradient
                  colors={[SPORT_ACCENT[item.sport_id] || 'rgba(132,88,179,0.25)', 'transparent']}
                  style={{ height: 70, width: '100%' }}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                />
                <View style={{ padding: 12, paddingTop: 0, marginTop: -20 }}>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
                    <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20, backgroundColor: 'rgba(208,189,244,0.18)' }}>
                      <T style={{ color: palette.p3, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' }}>{item.category}</T>
                    </View>
                    <T style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, alignSelf: 'center' }}>{item.sport_id} · {item.published_at?.slice(5)}</T>
                  </View>
                  <T style={{ color: '#fff', fontSize: 14, fontWeight: '700', lineHeight: 20, marginBottom: 2 }}>{item.headline}</T>
                  {expanded[item.id] && (
                    <T style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, lineHeight: 17, marginTop: 4 }}>{item.deck}</T>
                  )}
                  <T style={{ color: 'rgba(208,189,244,0.5)', fontSize: 10, marginTop: 4 }}>{expanded[item.id] ? '▲ less' : '▼ more'}</T>
                </View>
              </View>
            </TouchableOpacity>
          </Animated.View>
        ))}
      </ScrollView>

      <TouchableOpacity onPress={() => onNavigate?.('news-discovery')} style={{ marginTop: 10, paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Explore live news →</T>
      </TouchableOpacity>
    </View>
  );
}
