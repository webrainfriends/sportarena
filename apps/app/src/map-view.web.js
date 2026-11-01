// Web map: Leaflet + OpenStreetMap tiles, drawn into a div. Pins are divIcons (no image assets), clustered with the shared grid.
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { T } from './ui';
import { c, r } from './theme';
import { t } from './i18n';
import { clusterPins, fitBox, bboxString } from './cluster';
import { pinColor, pinEmoji } from './map-core';

export function MapView({ pins, selectedKey, center, onSelect, onSearchArea, height = 420 }) {
  const host = useRef(null);
  const state = useRef({});
  const [moved, setMoved] = useState(false);
  const cb = useRef({});
  cb.current = { onSelect };

  useEffect(() => {
    let dead = false;
    (async () => {
      const L = (await import('leaflet')).default ?? (await import('leaflet'));
      try { await import('leaflet/dist/leaflet.css'); } catch { /* styles are optional in tests */ }
      if (dead || !host.current) return;
      const map = L.map(host.current, { zoomControl: true, attributionControl: true }).setView(center ? [center.lat, center.lng] : [20.5, 78.9], center ? 12 : 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
      const layer = L.layerGroup().addTo(map);
      state.current = { L, map, layer };
      map.on('moveend', () => { if (state.current.programmatic) { state.current.programmatic = false; return; } setMoved(true); draw(); });
      draw();
    })();
    return () => { dead = true; state.current.map?.remove(); state.current = {}; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = () => {
    const { L, map, layer } = state.current;
    if (!map) return;
    layer.clearLayers();
    const b = map.getBounds();
    for (const g of clusterPins(state.current.pins ?? [], b.getNorth() - b.getSouth())) {
      const first = g.pins[0];
      const sel = g.count === 1 && first.key === state.current.selectedKey;
      const bg = g.count > 1 ? c.violet : pinColor(first.kind);
      const html = `<div style="min-width:44px;height:44px;border-radius:22px;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;font:700 16px system-ui;border:${sel ? 4 : 2}px solid ${sel ? c.sun : '#fff'};box-shadow:0 2px 6px rgba(0,0,0,.3)">${g.count > 1 ? g.count : pinEmoji(first.kind)}</div>`;
      const m = L.marker([g.latitude, g.longitude], { icon: L.divIcon({ html, className: '', iconSize: [44, 44], iconAnchor: [22, 22] }), keyboard: true, title: g.count > 1 ? t('disc.cluster_a11y', { n: g.count }) : t(`disc.kind_${first.kind}`) });
      m.on('click', () => {
        if (g.count > 1) { state.current.map.fitBounds(L.latLngBounds(g.pins.map((p) => [p.latitude, p.longitude])), { padding: [40, 40], maxZoom: 17 }); return; }
        cb.current.onSelect?.(first);
      });
      m.addTo(layer);
    }
  };

  useEffect(() => {
    const s = state.current;
    s.pins = pins; s.selectedKey = selectedKey;
    if (!s.map) return;
    draw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, selectedKey]);

  const lastFit = useRef('');
  useEffect(() => {
    const s = state.current;
    if (!s.map) return;
    const sig = pins.map((p) => p.key).join('|');
    if (sig === lastFit.current) return;
    lastFit.current = sig;
    const b = fitBox(pins, center);
    if (b) { s.programmatic = true; s.map.fitBounds([[b.south, b.west], [b.north, b.east]], { maxZoom: 16 }); setMoved(false); }
  }, [pins, center]);

  const searchHere = () => {
    const b = state.current.map?.getBounds();
    if (!b) return;
    setMoved(false);
    onSearchArea?.(bboxString({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }));
  };

  return (
    <View style={{ height, borderRadius: r?.card ?? 16, overflow: 'hidden', borderWidth: 1, borderColor: c.line, backgroundColor: c.bg }} accessibilityLabel={t('disc.map_a11y')}>
      {React.createElement('div', { ref: host, style: { position: 'absolute', inset: 0 } })}
      {moved && onSearchArea ? (
        <Pressable onPress={searchHere} accessibilityRole="button" accessibilityLabel={t('disc.search_area')} style={{ position: 'absolute', top: 10, alignSelf: 'center', minHeight: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <T weight="800" size={14} color={c.onAccent}>{t('disc.search_area')}</T>
        </Pressable>
      ) : null}
    </View>
  );
}
