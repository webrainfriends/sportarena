// Issue #1194: Coach recommendation — propose squad with rationale
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi, useApiMutation } from '../api';
import { Screen } from '../components/Screen';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { MultiMenuField } from '../components/MultiMenuField';
import { useNavigation } from '@react-navigation/native';

export default function SelectionRecommendation({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { campaignId, formation } = route?.params ?? {};
  const { data: nominations } = useApi(`/selection-campaigns/${campaignId}/nominations`);
  const { mutate, loading } = useApiMutation('POST', `/selection-campaigns/${campaignId}/recommendations`);
  const S = styles(C);

  const [starters, setStarters] = useState([]);
  const [reserves, setReserves] = useState([]);
  const [development, setDevelopment] = useState([]);
  const [tacticalNotes, setTacticalNotes] = useState('');
  const [rationale, setRationale] = useState('');

  const eligible = (nominations ?? []).filter(n => n.eligibility_status === 'eligible');
  const opts = eligible.map(n => ({ value: n.id, label: n.candidate_name ?? n.candidate_id }));

  const submit = async () => {
    const result = await mutate({
      starters, reserves, development_list: development,
      formation, tactical_notes: tacticalNotes, rationale: { general: rationale }, status: 'submitted',
    });
    if (result) nav.navigate('SelectionReview', { campaignId, recommendationId: result.id });
  };

  return (
    <Screen title={t('sel.recommendation.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.recommendation.starters')}</Text>
          <Text style={S.hint}>{t('sel.recommendation.eligibleOnly')}</Text>
          <MultiMenuField
            label={t('sel.recommendation.starters')}
            value={starters}
            options={opts}
            onChange={setStarters}
            max={15}
            accessibilityLabel={t('sel.recommendation.starters')}
          />
        </Card>

        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.recommendation.reserves')}</Text>
          <MultiMenuField
            label={t('sel.recommendation.reserves')}
            value={reserves}
            options={opts}
            onChange={setReserves}
            max={10}
            accessibilityLabel={t('sel.recommendation.reserves')}
          />
        </Card>

        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.recommendation.development')}</Text>
          <MultiMenuField
            label={t('sel.recommendation.development')}
            value={development}
            options={opts}
            onChange={setDevelopment}
            max={20}
            accessibilityLabel={t('sel.recommendation.development')}
          />
        </Card>

        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.recommendation.rationale')}</Text>
          <TextField
            label={t('sel.recommendation.tacticalNotes')}
            value={tacticalNotes}
            onChangeText={setTacticalNotes}
            multiline
            numberOfLines={4}
            accessibilityLabel={t('sel.recommendation.tacticalNotes')}
          />
          <TextField
            label={t('sel.recommendation.generalRationale')}
            value={rationale}
            onChangeText={setRationale}
            multiline
            numberOfLines={6}
            style={S.rationalField}
            accessibilityLabel={t('sel.recommendation.generalRationale')}
          />
        </Card>

        <Button
          label={t('sel.recommendation.submit')}
          onPress={submit}
          loading={loading}
          disabled={starters.length === 0}
          accessibilityLabel={t('sel.recommendation.submit')}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  card: { padding: 16, marginBottom: 14 },
  heading: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 8 },
  hint: { fontSize: 12, color: C.lime, marginBottom: 10 },
  rationalField: { marginTop: 10 },
});
