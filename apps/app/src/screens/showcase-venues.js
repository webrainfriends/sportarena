import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const SPORTS = ['Football', 'Tennis', 'Basketball', 'Cricket', 'Badminton'];
const SURFACES = ['Natural grass', 'Artificial turf', 'Hard court', 'Clay'];
const TYPES = ['Outdoor', 'Indoor'];
const STEPS = ['Sport', 'Date', 'Time', 'Confirm'];

const isWeb = Platform.OS === 'web';

function PitchSchematic({ sport }) {
  const color = c.pink;
  const bg = c.violetSoft;
  if (isWeb) {
    const isTennis = sport === 'Tennis';
    const isBball = sport === 'Basketball';
    if (isTennis) {
      return (
        <View style={{ alignItems: 'center', marginVertical: 8 }} accessibilityLabel="Tennis court schematic">
          {/* eslint-disable-next-line react-native/no-inline-styles */}
          <div dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 200 100" width="100%" height="120" xmlns="http://www.w3.org/2000/svg">
            <rect x="5" y="5" width="190" height="90" rx="2" fill="${bg}" stroke="${color}" stroke-width="2"/>
            <line x1="100" y1="5" x2="100" y2="95" stroke="${color}" stroke-width="1.5"/>
            <line x1="5" y1="50" x2="195" y2="50" stroke="${color}" stroke-width="1.5"/>
            <line x1="50" y1="5" x2="50" y2="95" stroke="${color}" stroke-width="1" stroke-dasharray="3"/>
            <line x1="150" y1="5" x2="150" y2="95" stroke="${color}" stroke-width="1" stroke-dasharray="3"/>
          </svg>` }} />
        </View>
      );
    }
    if (isBball) {
      return (
        <View style={{ alignItems: 'center', marginVertical: 8 }} accessibilityLabel="Basketball court schematic">
          <div dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 200 100" width="100%" height="120" xmlns="http://www.w3.org/2000/svg">
            <rect x="5" y="5" width="190" height="90" rx="2" fill="${bg}" stroke="${color}" stroke-width="2"/>
            <circle cx="100" cy="50" r="18" fill="none" stroke="${color}" stroke-width="1.5"/>
            <line x1="100" y1="5" x2="100" y2="95" stroke="${color}" stroke-width="1.5"/>
            <rect x="5" y="22" width="40" height="56" rx="2" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3"/>
            <rect x="155" y="22" width="40" height="56" rx="2" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3"/>
          </svg>` }} />
        </View>
      );
    }
    // Football (default)
    return (
      <View style={{ alignItems: 'center', marginVertical: 8 }} accessibilityLabel="Football pitch schematic">
        <div dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 200 120" width="100%" height="130" xmlns="http://www.w3.org/2000/svg">
          <rect x="5" y="5" width="190" height="110" rx="4" fill="${bg}" stroke="${color}" stroke-width="2"/>
          <line x1="100" y1="5" x2="100" y2="115" stroke="${color}" stroke-width="1.5"/>
          <circle cx="100" cy="60" r="22" fill="none" stroke="${color}" stroke-width="1.5"/>
          <circle cx="100" cy="60" r="2" fill="${color}"/>
          <rect x="5" y="34" width="28" height="52" rx="2" fill="none" stroke="${color}" stroke-width="1.5"/>
          <rect x="167" y="34" width="28" height="52" rx="2" fill="none" stroke="${color}" stroke-width="1.5"/>
          <rect x="5" y="46" width="12" height="28" rx="1" fill="none" stroke="${color}" stroke-width="1.5"/>
          <rect x="183" y="46" width="12" height="28" rx="1" fill="none" stroke="${color}" stroke-width="1.5"/>
        </svg>` }} />
      </View>
    );
  }
  // Native fallback — simple rectangle diagram
  return (
    <View accessibilityLabel={`${sport} court schematic`} style={{ height: 100, backgroundColor: bg, borderRadius: r.card, borderWidth: 2, borderColor: color, margin: 8, alignItems: 'center', justifyContent: 'center' }}>
      <T size={12} color={color} weight="600">{sport} court</T>
      <View style={{ position: 'absolute', top: '50%', start: 20, end: 20, height: 1, backgroundColor: color }} />
      <View style={{ position: 'absolute', top: 0, bottom: 0, start: '50%', width: 1, backgroundColor: color }} />
    </View>
  );
}

function ChipRow({ options, value, onChange }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {options.map((o) => {
        const sel = value === o;
        return (
          <Pressable key={o} onPress={() => onChange(o)} accessibilityRole="button" accessibilityLabel={o} accessibilityState={{ selected: sel }}>
            <View style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: r.pill, backgroundColor: sel ? c.pink : c.paper, borderWidth: 1, borderColor: sel ? c.pink : c.line, minHeight: 44, justifyContent: 'center' }}>
              <T size={13} weight="600" color={sel ? '#fff' : c.mute}>{o}</T>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function ShowcaseVenues({ block, manifest, onCta }) {
  const [sport, setSport] = useState('Football');
  const [surface, setSurface] = useState('Natural grass');
  const [type, setType] = useState('Outdoor');
  const [step, setStep] = useState(0);

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Venues</T>

      <View style={{ gap: 10 }}>
        <T size={12} weight="600" color={c.mute}>SPORT</T>
        <ChipRow options={SPORTS} value={sport} onChange={setSport} />
        <T size={12} weight="600" color={c.mute}>SURFACE</T>
        <ChipRow options={SURFACES} value={surface} onChange={setSurface} />
        <T size={12} weight="600" color={c.mute}>TYPE</T>
        <ChipRow options={TYPES} value={type} onChange={setType} />
      </View>

      <Card pad={0} style={{ overflow: 'hidden' }}>
        <PitchSchematic sport={sport} />
        <View style={{ padding: 12 }}>
          <T weight="700" size={14}>{sport} · {surface} · {type}</T>
          <T size={12} color={c.mute}>Court schematic — illustrative only</T>
        </View>
      </Card>

      {/* Booking journey stepper */}
      <Card>
        <T weight="700" size={15} style={{ marginBottom: 12 }}>Booking journey</T>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <Pressable onPress={() => setStep(i)} accessibilityRole="button" accessibilityLabel={`Step ${i + 1}: ${s}`} accessibilityState={{ selected: i === step }}>
                <View style={{ alignItems: 'center', gap: 4 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: i <= step ? c.pink : c.line, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={12} weight="800" color={i <= step ? '#fff' : c.mute}>{i + 1}</T>
                  </View>
                  <T size={10} weight="600" color={i === step ? c.pink : c.mute}>{s}</T>
                </View>
              </Pressable>
              {i < STEPS.length - 1 && <View style={{ flex: 1, height: 2, backgroundColor: i < step ? c.pink : c.line, marginBottom: 16, marginHorizontal: 4 }} />}
            </React.Fragment>
          ))}
        </View>
        <T size={11} color={c.mute} style={{ marginTop: 10 }}>Simulation only — no real availability or pricing shown</T>
      </Card>

      <Btn title="Find real venues →" onPress={() => onCta('venue-discovery')} />
    </View>
  );
}
