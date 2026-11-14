import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Switch, StyleSheet, Platform, ActivityIndicator, Alert } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { c, r, fam } from '../theme';
import { useTranslation } from '../i18n';
import { useApi } from '../api';

const DIMENSIONS = {
  hire: ['instruction_quality', 'punctuality', 'communication', 'preparation'],
  appointment: ['expertise', 'bedside_manner', 'punctuality', 'communication'],
  booking: ['facilities', 'cleanliness', 'staff', 'value'],
  event_participation: ['organisation', 'atmosphere', 'officiating', 'facilities'],
  programme_enrolment: ['content', 'scheduling', 'communication', 'value'],
  default: ['quality', 'communication', 'punctuality', 'value'],
};

const ROLES = ['athlete', 'guardian', 'counterparty', 'spectator', 'official'];

const NPS_COLORS = [
  '#E11D48', '#E11D48', '#E11D48', '#E11D48', '#E11D48', '#E11D48', '#E11D48',
  '#D97706', '#D97706',
  '#2F8F5F', '#2F8F5F',
];

function StarPicker({ value, onChange, size = 32 }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <TouchableOpacity key={s} onPress={() => onChange(s)} accessibilityLabel={`${s} star`}>
          <Text style={{ fontSize: size, color: s <= value ? '#F59E0B' : c.line }}>★</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function FeedbackSubmit() {
  const { t } = useTranslation();
  const nav = useNavigation();
  const route = useRoute();
  const api = useApi();
  const { subjectType, subjectId, contextType, contextId } = route.params ?? {};

  const [eligibility, setEligibility] = useState(null);
  const [loadingEligibility, setLoadingEligibility] = useState(true);
  const [step, setStep] = useState('loading');

  const [authorRole, setAuthorRole] = useState('athlete');
  const [rating, setRating] = useState(0);
  const [dimRatings, setDimRatings] = useState({});
  const [nps, setNps] = useState(null);
  const [visibility, setVisibility] = useState('public');
  const [isBlind, setIsBlind] = useState(false);
  const [body, setBody] = useState('');
  const [conflict, setConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const dims = DIMENSIONS[contextType] ?? DIMENSIONS.default;

  useEffect(() => {
    (async () => {
      try {
        const elig = await api.get(`/feedback/eligibility?subject_type=${subjectType}&subject_id=${subjectId}&context_type=${contextType}&context_id=${contextId}`);
        setEligibility(elig);
        setStep(elig.eligible ? 'role' : 'ineligible');
      } catch (_) {
        setStep('ineligible');
      }
      setLoadingEligibility(false);
    })();
  }, []);

  const submit = async () => {
    if (!rating) { Alert.alert(t('feedback_rating_required')); return; }
    if (!body.trim()) { Alert.alert(t('feedback_body_required')); return; }
    if (!conflict) { Alert.alert(t('feedback_conflict_required')); return; }
    setSubmitting(true);
    try {
      await api.post('/testimonials', {
        subject_type: subjectType,
        subject_id: subjectId,
        context_type: contextType,
        context_id: contextId,
        author_role: authorRole,
        rating,
        dimensions_json: dims.map((k) => ({ key: k, label: t(`feedback_dim_${k}`), rating: dimRatings[k] ?? 0 })).filter((d) => d.rating > 0),
        nps_score: nps,
        visibility,
        is_blind: isBlind,
        body,
      });
      nav.goBack();
    } catch (e) {
      Alert.alert(t('feedback_submit_error'), e.message);
    }
    setSubmitting(false);
  };

  if (loadingEligibility) return <View style={s.root}><ActivityIndicator color={c.pink} style={{ marginTop: 100 }} /></View>;

  return (
    <View style={s.root}>
      <View style={s.sheetHeader}>
        <View style={s.dragHandle} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={s.sheetTitle}>{t('feedback_submit_title')}</Text>
          <TouchableOpacity onPress={() => nav.goBack()} style={s.closeBtn}>
            <Text style={{ color: c.mute, fontSize: 16 }}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Subject context */}
        <View style={s.subjectCard}>
          <View style={[s.subjectIcon, { backgroundColor: c.pinkSoft }]}>
            <Text style={{ fontSize: 22 }}>{eligibility?.subject_icon ?? '⭐'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.subjectName}>{eligibility?.subject_label ?? subjectId}</Text>
            <Text style={s.subjectMeta}>{eligibility?.context_label ?? contextType}</Text>
          </View>
        </View>

        {/* Eligibility banner */}
        {eligibility && (
          <View style={[s.eligBanner, { backgroundColor: eligibility.eligible ? c.limeSoft : c.redSoft }]}>
            <Text style={{ fontSize: 18 }}>{eligibility.eligible ? '✅' : '🚫'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: eligibility.eligible ? c.lime : c.red }}>
                {eligibility.eligible ? t('feedback_verified_interaction') : t('feedback_ineligible')}
              </Text>
              {eligibility.window_days != null && (
                <Text style={{ fontSize: 11, color: eligibility.eligible ? c.lime : c.red, marginTop: 2 }}>
                  {t('feedback_window_days', { days: eligibility.window_days })}
                </Text>
              )}
            </View>
          </View>
        )}

        {step === 'ineligible' ? (
          <View style={s.section}>
            <Text style={s.sectionLabel}>{t('feedback_ineligible_reason')}</Text>
            <Text style={{ fontSize: 13, color: c.mute, marginTop: 8 }}>{eligibility?.reason ?? t('feedback_no_interaction')}</Text>
          </View>
        ) : (
          <>
            {/* Role picker */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>{t('feedback_role_picker_label')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {ROLES.map((role) => (
                  <TouchableOpacity
                    key={role}
                    style={[s.chip, authorRole === role && s.chipActive]}
                    onPress={() => setAuthorRole(role)}
                    accessibilityLabel={t(`feedback_role_${role}`)}
                  >
                    <Text style={[s.chipText, authorRole === role && s.chipTextActive]}>{t(`feedback_role_${role}`)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Overall rating */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>{t('feedback_overall_rating')}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                <Text style={{ fontSize: 13, color: c.ink }}>{t('feedback_rating_prompt')}</Text>
                <StarPicker value={rating} onChange={setRating} />
              </View>
            </View>

            {/* Dimension ratings */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>{t('feedback_dimensions_label')}</Text>
              {dims.map((k) => (
                <View key={k} style={s.dimRow}>
                  <Text style={{ fontSize: 13, color: c.ink, flex: 1 }}>{t(`feedback_dim_${k}`)}</Text>
                  <StarPicker value={dimRatings[k] ?? 0} onChange={(v) => setDimRatings((p) => ({ ...p, [k]: v }))} size={22} />
                </View>
              ))}
            </View>

            {/* NPS */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>{t('feedback_nps_label')}</Text>
              <View style={{ flexDirection: 'row', gap: 3, marginTop: 10 }}>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <TouchableOpacity
                    key={n}
                    style={[s.npsBtn, { backgroundColor: nps === n ? NPS_COLORS[n] : c.bg }, nps === n && { opacity: 1 }]}
                    onPress={() => setNps(n)}
                    accessibilityLabel={`NPS ${n}`}
                  >
                    <Text style={{ fontSize: 10, fontWeight: '700', color: nps === n ? '#fff' : c.mute }}>{n}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                <Text style={{ fontSize: 10, color: c.mute }}>{t('feedback_nps_low')}</Text>
                <Text style={{ fontSize: 10, color: c.mute }}>{t('feedback_nps_high')}</Text>
              </View>
            </View>

            {/* Visibility + blind */}
            <View style={s.section}>
              <View style={s.toggleRow}>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.ink }}>{t('feedback_visibility_public')}</Text>
                  <Text style={{ fontSize: 11, color: c.mute }}>{t('feedback_visibility_public_sub')}</Text>
                </View>
                <Switch
                  value={visibility === 'public'}
                  onValueChange={(v) => setVisibility(v ? 'public' : 'private')}
                  trackColor={{ false: c.line, true: c.pink }}
                  thumbColor="#fff"
                />
              </View>
              <View style={[s.toggleRow, { borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10, marginTop: 8 }]}>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.ink }}>{t('feedback_blind_toggle')}</Text>
                  <Text style={{ fontSize: 11, color: c.mute }}>{t('feedback_blind_sub')}</Text>
                </View>
                <Switch
                  value={isBlind}
                  onValueChange={setIsBlind}
                  trackColor={{ false: c.line, true: c.pink }}
                  thumbColor="#fff"
                />
              </View>
            </View>

            {/* Body */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>{t('feedback_body_label')}</Text>
              <TextInput
                style={s.textarea}
                multiline
                numberOfLines={4}
                placeholder={t('feedback_body_placeholder')}
                placeholderTextColor={c.mute}
                value={body}
                onChangeText={setBody}
                accessibilityLabel={t('feedback_body_label')}
              />
              <TouchableOpacity style={s.conflictRow} onPress={() => setConflict((p) => !p)} accessibilityLabel={t('feedback_conflict_label')}>
                <View style={[s.checkbox, conflict && { backgroundColor: c.pink, borderColor: c.pink }]}>
                  {conflict && <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>✓</Text>}
                </View>
                <Text style={{ fontSize: 11, color: c.mute, flex: 1, lineHeight: 16 }}>{t('feedback_conflict_label')}</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[s.submitBtn, (submitting || !rating || !body.trim() || !conflict) && { opacity: 0.5 }]}
              onPress={submit}
              disabled={submitting || !rating || !body.trim() || !conflict}
            >
              {submitting ? <ActivityIndicator color="#fff" /> : <Text style={s.submitBtnText}>{t('feedback_submit_cta')}</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  sheetHeader: { backgroundColor: c.paper, padding: 16, paddingTop: 10, borderBottomWidth: 1, borderBottomColor: c.line },
  dragHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.line, alignSelf: 'center', marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: c.ink, ...fam },
  closeBtn: { width: 32, height: 32, borderRadius: r.pill, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' },
  subjectCard: { backgroundColor: c.paper, borderRadius: r.card, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  subjectIcon: { width: 44, height: 44, borderRadius: r.input, alignItems: 'center', justifyContent: 'center' },
  subjectName: { fontSize: 14, fontWeight: '700', color: c.ink },
  subjectMeta: { fontSize: 12, color: c.mute, marginTop: 1 },
  eligBanner: { borderRadius: r.input, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  section: { backgroundColor: c.paper, borderRadius: r.card, padding: 14, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.06, textTransform: 'uppercase', color: c.mute },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: r.pill, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.bg },
  chipActive: { backgroundColor: c.pink, borderColor: c.pink },
  chipText: { fontSize: 12, fontWeight: '600', color: c.mute },
  chipTextActive: { color: '#fff' },
  dimRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line },
  npsBtn: { flex: 1, height: 34, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  textarea: { backgroundColor: c.bg, borderRadius: r.input, padding: 10, fontSize: 13, color: c.ink, minHeight: 80, marginTop: 8, fontFamily: Platform.OS === 'ios' ? 'System' : 'Roboto' },
  conflictRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 10, marginTop: 8, borderTopWidth: 1, borderTopColor: c.line },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: c.line, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  submitBtn: { backgroundColor: c.pink, borderRadius: r.pill, padding: 16, alignItems: 'center', marginTop: 8, shadowColor: c.pink, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 },
  submitBtnText: { fontSize: 15, fontWeight: '700', color: '#fff', ...fam },
});
