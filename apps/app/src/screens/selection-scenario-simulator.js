// Issue #1194: Scenario Simulator — SVG formation canvas, drag-and-drop squad builder
import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { Svg, Rect, Circle, Text as SvgText, Line } from 'react-native-svg';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useNavigation } from '@react-navigation/native';
import { MenuField } from '../menu-field';
import { Btn, Card, Screen } from '../ui';

const { width: W } = Dimensions.get('window');
const PITCH_W = Math.min(W - 32, 400);
const PITCH_H = PITCH_W * 1.5;

const FORMATIONS = {
  '4-3-3': [[{ x: 0.5, y: 0.9, pos: 'GK' }],[{ x:0.15,y:0.75,pos:'LB'},{x:0.38,y:0.75,pos:'CB'},{x:0.62,y:0.75,pos:'CB'},{x:0.85,y:0.75,pos:'RB'}],[{x:0.25,y:0.55,pos:'CM'},{x:0.5,y:0.52,pos:'CM'},{x:0.75,y:0.55,pos:'CM'}],[{x:0.15,y:0.3,pos:'LW'},{x:0.5,y:0.25,pos:'ST'},{x:0.85,y:0.3,pos:'RW'}]],
  '4-4-2': [[{ x: 0.5, y: 0.9, pos: 'GK' }],[{x:0.1,y:0.75,pos:'LB'},{x:0.35,y:0.75,pos:'CB'},{x:0.65,y:0.75,pos:'CB'},{x:0.9,y:0.75,pos:'RB'}],[{x:0.1,y:0.5,pos:'LM'},{x:0.35,y:0.5,pos:'CM'},{x:0.65,y:0.5,pos:'CM'},{x:0.9,y:0.5,pos:'RM'}],[{x:0.35,y:0.25,pos:'ST'},{x:0.65,y:0.25,pos:'ST'}]],
  '3-5-2': [[{ x: 0.5, y: 0.9, pos: 'GK' }],[{x:0.25,y:0.72,pos:'CB'},{x:0.5,y:0.72,pos:'CB'},{x:0.75,y:0.72,pos:'CB'}],[{x:0.1,y:0.5,pos:'LWB'},{x:0.3,y:0.52,pos:'CM'},{x:0.5,y:0.5,pos:'CM'},{x:0.7,y:0.52,pos:'CM'},{x:0.9,y:0.5,pos:'RWB'}],[{x:0.35,y:0.25,pos:'ST'},{x:0.65,y:0.25,pos:'ST'}]],
};

export default function SelectionScenarioSimulator({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { campaignId, result } = route?.params ?? {};
  const [formation, setFormation] = useState('4-3-3');
  const [assignments, setAssignments] = useState({});
  const S = styles(C);

  const positions = (FORMATIONS[formation] ?? []).flat();
  const rankedCandidates = result?.ranked_candidates ?? [];

  const assign = (posIdx, candidateId) => {
    setAssignments(a => ({ ...a, [posIdx]: candidateId }));
  };

  const candidateForPos = (idx) => {
    const id = assignments[idx];
    return rankedCandidates.find(c => c.candidate_id === id);
  };

  return (
    <Screen title={t('sel.simulator.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        <Card style={S.formCard}>
          <MenuField
            label={t('sel.simulator.formation')}
            value={formation}
            options={Object.keys(FORMATIONS).map(f => ({ value: f, label: f }))}
            onChange={setFormation}
            accessibilityLabel={t('sel.simulator.formation')}
          />
        </Card>

        <Card style={S.pitchCard}>
          <Text style={S.heading}>{t('sel.simulator.canvas')}</Text>
          <Svg width={PITCH_W} height={PITCH_H} accessibilityLabel={t('sel.simulator.pitch')}>
            {/* Pitch */}
            <Rect x={0} y={0} width={PITCH_W} height={PITCH_H} fill="#2F8F5F" rx={8} />
            {/* Centre circle */}
            <Circle cx={PITCH_W/2} cy={PITCH_H/2} r={PITCH_W*0.12} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} />
            {/* Centre line */}
            <Line x1={0} y1={PITCH_H/2} x2={PITCH_W} y2={PITCH_H/2} stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} />
            {/* Penalty areas */}
            <Rect x={PITCH_W*0.2} y={PITCH_H*0.78} width={PITCH_W*0.6} height={PITCH_H*0.18} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} />
            <Rect x={PITCH_W*0.2} y={PITCH_H*0.04} width={PITCH_W*0.6} height={PITCH_H*0.18} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} />

            {positions.map((pos, idx) => {
              const cx = pos.x * PITCH_W;
              const cy = pos.y * PITCH_H;
              const player = candidateForPos(idx);
              return (
                <React.Fragment key={idx}>
                  <Circle cx={cx} cy={cy} r={18} fill={player ? '#8458B3' : 'rgba(255,255,255,0.3)'} />
                  <SvgText x={cx} y={cy - 2} textAnchor="middle" fontSize={9} fill="white" fontWeight="700">
                    {pos.pos}
                  </SvgText>
                  {player && (
                    <SvgText x={cx} y={cy + 10} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.9)">
                      {(player.candidate_name ?? '').split(' ').pop()?.slice(0,8)}
                    </SvgText>
                  )}
                </React.Fragment>
              );
            })}
          </Svg>
        </Card>

        <Card style={S.assignCard}>
          <Text style={S.heading}>{t('sel.simulator.assign')}</Text>
          {positions.map((pos, idx) => (
            <View key={idx} style={S.assignRow}>
              <Text style={S.posLabel}>{pos.pos}</Text>
              <MenuField
                value={assignments[idx] ?? null}
                options={[{ value: null, label: t('sel.simulator.unassigned') }, ...rankedCandidates.map(c => ({ value: c.candidate_id, label: c.candidate_name ?? c.candidate_id }))]}
                onChange={v => assign(idx, v)}
                style={S.assignPicker}
                accessibilityLabel={`${pos.pos} ${t('sel.simulator.assign')}`}
              />
            </View>
          ))}
        </Card>

        <Btn
          label={t('sel.simulator.saveScenario')}
          onPress={() => {}}
          accessibilityLabel={t('sel.simulator.saveScenario')}
        />
        <Btn
          label={t('sel.recommendation.start')}
          onPress={() => nav.navigate('SelectionRecommendation', { campaignId, assignments, formation })}
          icon="check-circle"
          style={{ marginTop: 10 }}
          accessibilityLabel={t('sel.recommendation.start')}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  formCard: { padding: 14, marginBottom: 14 },
  pitchCard: { padding: 14, marginBottom: 14, alignItems: 'center' },
  heading: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 12 },
  assignCard: { padding: 14, marginBottom: 14 },
  assignRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 10 },
  posLabel: { fontSize: 13, fontWeight: '700', color: C.pink, width: 36 },
  assignPicker: { flex: 1 },
});
