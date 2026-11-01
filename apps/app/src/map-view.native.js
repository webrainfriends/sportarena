// iOS / iPadOS / Android map: react-native-maps (Apple Maps on iOS, Google Maps on Android). Same props and clustering as the web map.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import RNMap, { Marker } from 'react-native-maps';
import { T } from './ui';
import { c, r } from './theme';
import { t } from './i18n';
import { clusterPins, fitBox, bboxString } from './cluster';
import { pinColor, pinEmoji } from './map-core';

export function MapView({ pins, selectedKey, center, onSelect, onSearchArea, height = 420 }) {
  const ref = useRef(null);
  const [region, setRegion] = useState(null);
  const [moved, setMoved] = useState(false);
  const programmatic = useRef(false);
  const groups = useMemo(() => clusterPins(pins, region?.latitudeDelta ?? 0.4), [pins, region]);

  const sig = pins.map((p) => p.key).join('|');
  useEffect(() => {
    const b = fitBox(pins, center);
    if (!b || !ref.current) return;
    programmatic.current = true;
    ref.current.animateToRegion({ latitude: (b.south + b.north) / 2, longitude: (b.west + b.east) / 2, latitudeDelta: Math.max(b.north - b.south, 0.02), longitudeDelta: Math.max(b.east - b.west, 0.02) }, 300);
    setMoved(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, center?.lat, center?.lng]);

  const searchHere = () => {
    if (!region) return;
    setMoved(false);
    onSearchArea?.(bboxString({ south: region.latitude - region.latitudeDelta / 2, north: region.latitude + region.latitudeDelta / 2, west: region.longitude - region.longitudeDelta / 2, east: region.longitude + region.longitudeDelta / 2 }));
  };

  return (
    <View style={{ height, borderRadius: r?.card ?? 16, overflow: 'hidden', borderWidth: 1, borderColor: c.line }} accessibilityLabel={t('disc.map_a11y')}>
      <RNMap
        ref={ref} style={{ flex: 1 }} showsUserLocation={false} toolbarEnabled={false}
        initialRegion={center ? { latitude: center.lat, longitude: center.lng, latitudeDelta: 0.3, longitudeDelta: 0.3 } : { latitude: 20.5, longitude: 78.9, latitudeDelta: 25, longitudeDelta: 25 }}
        onRegionChangeComplete={(rg) => { setRegion(rg); if (programmatic.current) programmatic.current = false; else setMoved(true); }}
      >
        {groups.map((g) => {
          const first = g.pins[0];
          const sel = g.count === 1 && first.key === selectedKey;
          const bg = g.count > 1 ? c.violet : pinColor(first.kind);
          return (
            <Marker key={g.key} coordinate={{ latitude: g.latitude, longitude: g.longitude }} tracksViewChanges={false}
              accessibilityLabel={g.count > 1 ? t('disc.cluster_a11y', { n: g.count }) : t(`disc.kind_${first.kind}`)}
              onPress={() => (g.count > 1 ? ref.current?.fitToCoordinates(g.pins.map((p) => ({ latitude: p.latitude, longitude: p.longitude })), { edgePadding: { top: 60, right: 60, bottom: 60, left: 60 }, animated: true }) : onSelect?.(first))}>
              <View style={{ minWidth: 44, height: 44, borderRadius: 22, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', borderWidth: sel ? 4 : 2, borderColor: sel ? c.sun : '#fff' }}>
                <T weight="800" size={16} color="#fff">{g.count > 1 ? String(g.count) : pinEmoji(first.kind)}</T>
              </View>
            </Marker>
          );
        })}
      </RNMap>
      {moved && onSearchArea ? (
        <Pressable onPress={searchHere} accessibilityRole="button" accessibilityLabel={t('disc.search_area')} style={{ position: 'absolute', top: 10, alignSelf: 'center', minHeight: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}>
          <T weight="800" size={14} color={c.onAccent}>{t('disc.search_area')}</T>
        </Pressable>
      ) : null}
    </View>
  );
}
