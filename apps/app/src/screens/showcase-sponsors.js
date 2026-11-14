import React, { useState } from 'react';
import { View, TouchableOpacity, ScrollView } from 'react-native';
import { T } from '../ui';
import { palette } from '../theme';

const TIERS = [
  { key: 'presenting', label: 'Presenting',       rights: 'Logo on all event collateral, naming rights, 60 s activation slot, media partner access', value: '£50 000+' },
  { key: 'associate',  label: 'Associate',        rights: 'Logo on digital assets, 30 s activation, social media mentions, athlete meet', value: '£15 000+' },
  { key: 'media',      label: 'Media partner',    rights: 'Broadcast credits, editorial placement, athlete interview access, digital banner', value: '£8 000+' },
  { key: 'supplier',   label: 'Official supplier', rights: 'Product placement, kit branding, locker room supply, B2B hospitality', value: '£5 000+' },
];
const CATEGORIES = ['Academies', 'Tournaments', 'Athletes', 'Venues', 'National federations'];
const OUTCOMES   = ['Brand reach', 'Youth engagement', 'B2B hospitality', 'Media placement', 'Data & insights'];

export function ShowcaseSponsors({ manifest, block, onNavigate }) {
  const [tier, setTier]         = useState('presenting');
  const [cat, setCat]           = useState('Academies');
  const [outcomes, setOutcomes] = useState(['Brand reach', 'Youth engagement']);
  const t = TIERS.find((x) => x.key === tier);
  const toggle = (o) => setOutcomes((prev) => prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]);

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Sponsorship</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Connect your brand with athletes, academies and events</T>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {CATEGORIES.map((c) => (
          <TouchableOpacity key={c} onPress={() => setCat(c)} style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: c === cat ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: c === cat ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' }}>{c}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>SPONSORSHIP TIER</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {TIERS.map((x) => (
          <TouchableOpacity key={x.key} onPress={() => setTier(x.key)} style={{ flex: 1, minWidth: 80, padding: 8, borderRadius: 10, backgroundColor: x.key === tier ? palette.p2 : 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', alignItems: 'center' }}>
            <T style={{ color: x.key === tier ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '700', textAlign: 'center' }}>{x.label}</T>
            <T style={{ color: x.key === tier ? palette.p3 : 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '600', marginTop: 2 }}>{x.value}</T>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ padding: 12, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', marginBottom: 12 }}>
        <T style={{ color: palette.p3, fontSize: 11, fontWeight: '700', marginBottom: 4 }}>WHAT YOU GET — {t.label.toUpperCase()}</T>
        <T style={{ color: 'rgba(255,255,255,0.78)', fontSize: 12, lineHeight: 18 }}>{t.rights}</T>
      </View>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>YOUR OBJECTIVES</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {OUTCOMES.map((o) => {
          const sel = outcomes.includes(o);
          return (
            <TouchableOpacity key={o} onPress={() => toggle(o)} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: sel ? palette.p3 + '40' : 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: sel ? palette.p3 : 'rgba(255,255,255,0.15)' }}>
              <T style={{ color: sel ? palette.p3 : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' }}>{o}</T>
            </TouchableOpacity>
          );
        })}
      </View>

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Become a sponsor →</T>
      </TouchableOpacity>
    </View>
  );
}
