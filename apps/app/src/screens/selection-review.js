// Issue #1194: Committee review — voting, comments, conflict declarations
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet , Switch } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi, useApiMutation } from '../api';
import { useNavigation } from '@react-navigation/native';
import { Btn, Card, Chip, Field, Screen } from '../ui';

export default function SelectionReview({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { campaignId, recommendationId } = route?.params ?? {};
  const { data: reviews, refetch } = useApi(`/selection-campaigns/${campaignId}/committee-reviews`);
  const { mutate, loading } = useApiMutation('POST', `/selection-campaigns/${campaignId}/committee-reviews`);
  const S = styles(C);

  const [vote, setVote] = useState(null);
  const [comment, setComment] = useState('');
  const [conflict, setConflict] = useState(false);
  const [conflictNote, setConflictNote] = useState('');
  const [dissent, setDissent] = useState('');

  const submitVote = async () => {
    await mutate({ vote, comment, conflict_declared: conflict, conflict_note: conflictNote, dissent_note: dissent });
    setVote(null); setComment(''); setConflict(false); setConflictNote(''); setDissent('');
    refetch?.();
  };

  const voteColor = { approve: C.lime, challenge: C.sun, abstain: C.mute };
  const voteOptions = ['approve', 'challenge', 'abstain'];

  return (
    <Screen title={t('sel.review.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        {/* Timeline of existing reviews */}
        <Text style={S.sectionTitle}>{t('sel.review.timeline')}</Text>
        {(!reviews?.length) ? (
          <Text style={S.empty}>{t('sel.review.noReviews')}</Text>
        ) : reviews.map(r => (
          <Card key={r.id} style={S.reviewCard}>
            <View style={S.reviewHeader}>
              <Text style={S.reviewerName}>{r.reviewer_name ?? r.reviewer_id}</Text>
              <Chip label={r.vote ?? 'abstain'} color={voteColor[r.vote] ?? C.mute} size="sm" />
            </View>
            {r.comment_enc && <Text style={S.comment}>{r.comment_enc}</Text>}
            {r.conflict_declared && <Chip label={t('sel.review.conflictDeclared')} color={C.red} size="xs" />}
            <Text style={S.ts}>{r.created_at?.slice(0,16)}</Text>
          </Card>
        ))}

        {/* Cast vote */}
        <Card style={S.voteCard}>
          <Text style={S.sectionTitle}>{t('sel.review.castVote')}</Text>
          <View style={S.voteRow}>
            {voteOptions.map(v => (
              <Btn
                key={v}
                label={t(`sel.review.vote.${v}`)}
                variant={vote === v ? 'primary' : 'outline'}
                onPress={() => setVote(v)}
                size="sm"
                style={{ flex: 1 }}
                accessibilityLabel={t(`sel.review.vote.${v}`)}
              />
            ))}
          </View>
          <Field
            label={t('sel.review.comment')}
            value={comment}
            onChangeText={setComment}
            multiline
            numberOfLines={4}
            style={S.field}
            accessibilityLabel={t('sel.review.comment')}
          />
          <Switch
            label={t('sel.review.declareConflict')}
            value={conflict}
            onValueChange={setConflict}
            accessibilityLabel={t('sel.review.declareConflict')}
          />
          {conflict && (
            <Field
              label={t('sel.review.conflictNote')}
              value={conflictNote}
              onChangeText={setConflictNote}
              multiline
              style={S.field}
              accessibilityLabel={t('sel.review.conflictNote')}
            />
          )}
          {vote === 'challenge' && (
            <Field
              label={t('sel.review.dissent')}
              value={dissent}
              onChangeText={setDissent}
              multiline
              style={S.field}
              accessibilityLabel={t('sel.review.dissent')}
            />
          )}
          <Btn
            label={t('sel.review.submitVote')}
            onPress={submitVote}
            loading={loading}
            disabled={!vote}
            style={S.submitBtn}
            accessibilityLabel={t('sel.review.submitVote')}
          />
        </Card>

        <Btn
          label={t('sel.review.proceedApproval')}
          onPress={() => nav.navigate('SelectionApprovalInbox', { campaignId, recommendationId })}
          icon="check"
          accessibilityLabel={t('sel.review.proceedApproval')}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: C.ink, marginBottom: 12 },
  empty: { color: C.mute, fontSize: 13, marginBottom: 16 },
  reviewCard: { padding: 14, marginBottom: 10 },
  reviewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  reviewerName: { fontSize: 13, fontWeight: '700', color: C.ink },
  comment: { fontSize: 13, color: C.ink, marginBottom: 6 },
  ts: { fontSize: 11, color: C.mute },
  voteCard: { padding: 16, marginBottom: 14 },
  voteRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  field: { marginTop: 10 },
  submitBtn: { marginTop: 14 },
});
