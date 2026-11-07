// Venue claim flow (#697): unclaimed listing badge, multi-step claim submission, status tracking and
// conflict / dispute handling. All server-enforced: two claimants are detected on the server and
// surfaced to platform staff; personal documents are uploaded as encrypted blobs; audit trail is
// permanent and never deleted.
import React, { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, Share, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, GradCard, H1, H2, Loading, Row, Screen, Section, Seg, T, Tag } from '../ui';
import { c, grad, r } from '../theme';
import { t } from '../i18n';

// ------------------------------------------------------------------ helpers
const daysAgo = (iso) => {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
};
const STATUS_COLOR = {
  submitted: c.sun, under_review: c.sun, approved: c.lime, rejected: c.red,
  withdrawn: c.violetSoft, disputed: c.orange,
};

const DOC_KINDS = [
  { key: 'title_deed', emoji: '📄', label: 'vclaim.doc_title_deed' },
  { key: 'lease_agreement', emoji: '📋', label: 'vclaim.doc_lease' },
  { key: 'trade_licence', emoji: '🏛️', label: 'vclaim.doc_trade_licence' },
  { key: 'id_proof', emoji: '🪪', label: 'vclaim.doc_id_proof' },
];

const ROLES = [
  { key: 'owner', emoji: '🏢', label: 'vclaim.role_owner', sub: 'vclaim.role_owner_sub' },
  { key: 'manager', emoji: '📋', label: 'vclaim.role_manager', sub: 'vclaim.role_manager_sub' },
  { key: 'authorised_agent', emoji: '🤝', label: 'vclaim.role_agent', sub: 'vclaim.role_agent_sub' },
];

const TIMELINE_STEPS = [
  'vclaim.step_submitted', 'vclaim.step_docs_verified', 'vclaim.step_identity',
  'vclaim.step_decision', 'vclaim.step_activated',
];
const STEP_STATUS_INDEX = { submitted: 0, under_review: 2, approved: 4, rejected: 3 };

// ------------------------------------------------------------------ VenueClaimBadge
/** Shown on the venue detail screen when venue.claim_status !== 'claimed'. */
export function VenueClaimBadge({ venue, navigation }) {
  if (!venue || venue.claim_status === 'claimed') return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('vclaim.badge_a11y')}
      onPress={() => navigation.navigate('ClaimSubmit', { venueId: venue.id, venueName: venue.name })}
      style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.sunSoft, borderRadius: r.card, padding: 14, marginVertical: 8, borderWidth: 1, borderColor: c.sun }}>
        <T size={22}>⚠️</T>
        <View style={{ flex: 1 }}>
          <T weight="700" size={14} color={c.sun}>{t('vclaim.badge_title')}</T>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t('vclaim.badge_sub')}</T>
        </View>
        <T size={18} color={c.sun}>›</T>
      </View>
    </Pressable>
  );
}

// ------------------------------------------------------------------ ClaimSubmitScreen
export function ClaimSubmitScreen({ route, navigation }) {
  const { venueId, venueName } = route.params ?? {};
  const { toast } = useSession();
  const [step, setStep] = useState(1);
  const [role, setRole] = useState(null);
  const [docs, setDocs] = useState({}); // { [kind]: { name, uri, type } }
  const [statement, setStatement] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const pickDoc = async (kind) => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], copyToCacheDirectory: true });
      if (!res.canceled && res.assets?.[0]) {
        setDocs((prev) => ({ ...prev, [kind]: res.assets[0] }));
      }
    } catch {
      toast(t('vclaim.doc_pick_error'));
    }
  };

  const uploadDocs = async (claimId) => {
    for (const [kind, file] of Object.entries(docs)) {
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', { uri: file.uri, name: file.name, type: file.mimeType ?? 'application/octet-stream' });
      await api.post(`/claims/${claimId}/documents`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const { claim } = await api.post(`/venues/${venueId}/claim`, { role, statement });
      await uploadDocs(claim.id);
      toast(t('vclaim.submitted_toast'));
      navigation.replace('ClaimStatus', { claimId: claim.id });
    } catch (e) {
      toast(t('vclaim.submit_error', { msg: e.message }));
    } finally {
      setSubmitting(false);
    }
  };

  const docCount = Object.keys(docs).length;
  const canNext1 = !!role;
  const canNext2 = docCount >= 2;
  const canNext3 = statement.trim().length >= 10;

  return (
    <Screen onRefresh={undefined}>
      {/* Step indicator */}
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 20 }}>
        {[1, 2, 3, 4].map((n) => (
          <View key={n} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: n <= step ? c.pink : c.line }} />
        ))}
      </View>

      {/* Venue banner */}
      <GradCard colors={grad.hero} style={{ marginBottom: 16 }}>
        <T size={12} color="rgba(255,255,255,0.75)" weight="600">{t('vclaim.claiming')}</T>
        <T size={20} weight="800" color="#fff" style={{ marginTop: 4 }}>{venueName}</T>
      </GradCard>

      {/* Step 1: Role */}
      {step === 1 && (
        <View style={{ gap: 12 }}>
          <H2>{t('vclaim.step1_title')}</H2>
          <T color={c.mute} size={13}>{t('vclaim.step1_sub')}</T>
          {ROLES.map((ro) => (
            <Pressable key={ro.key} onPress={() => setRole(ro.key)} accessibilityRole="radio" accessibilityState={{ checked: role === ro.key }}
              style={{ borderRadius: r.card, borderWidth: role === ro.key ? 2 : 1.5, borderColor: role === ro.key ? c.pink : c.line, backgroundColor: role === ro.key ? c.pinkSoft : c.paper, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72 }}>
              <T size={28}>{ro.emoji}</T>
              <View style={{ flex: 1 }}>
                <T weight="700" size={15} color={role === ro.key ? c.pink : c.ink}>{t(ro.label)}</T>
                <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t(ro.sub)}</T>
              </View>
              {role === ro.key ? <T size={18} color={c.pink}>✓</T> : null}
            </Pressable>
          ))}
          <Btn title={t('vclaim.next')} onPress={() => setStep(2)} disabled={!canNext1} accessibilityLabel={t('vclaim.next')} />
        </View>
      )}

      {/* Step 2: Documents */}
      {step === 2 && (
        <View style={{ gap: 12 }}>
          <H2>{t('vclaim.step2_title')}</H2>
          <T color={c.mute} size={13}>{t('vclaim.step2_sub')}</T>
          {DOC_KINDS.map((dk) => {
            const uploaded = docs[dk.key];
            return (
              <Card key={dk.key} color={uploaded ? c.limeSoft : c.paper}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <T size={24}>{dk.emoji}</T>
                  <View style={{ flex: 1 }}>
                    <T weight="700" size={14}>{t(dk.label)}</T>
                    {uploaded
                      ? <T size={12} color={c.lime} style={{ marginTop: 2 }}>✓ {uploaded.name}</T>
                      : <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t('vclaim.doc_not_uploaded')}</T>}
                  </View>
                  <Btn small title={uploaded ? t('vclaim.doc_replace') : t('vclaim.doc_upload')} color={uploaded ? c.lime : c.pink} onPress={() => pickDoc(dk.key)} accessibilityLabel={`${t('vclaim.doc_upload')} ${t(dk.label)}`} />
                </View>
              </Card>
            );
          })}
          {docCount < 2 ? (
            <View style={{ backgroundColor: c.sunSoft, borderRadius: r.card, padding: 12 }}>
              <T size={12} color={c.sun}>{t('vclaim.min_docs_required', { n: 2 })}</T>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn title={t('vclaim.back')} color={c.paper} ink={c.ink} onPress={() => setStep(1)} style={{ flex: 1 }} accessibilityLabel={t('vclaim.back')} />
            <Btn title={t('vclaim.next')} onPress={() => setStep(3)} disabled={!canNext2} style={{ flex: 1 }} accessibilityLabel={t('vclaim.next')} />
          </View>
        </View>
      )}

      {/* Step 3: Statement */}
      {step === 3 && (
        <View style={{ gap: 12 }}>
          <H2>{t('vclaim.step3_title')}</H2>
          <T color={c.mute} size={13}>{t('vclaim.step3_sub')}</T>
          <Card>
            <T size={12} weight="600" color={c.mute} style={{ letterSpacing: 0.4, marginBottom: 6 }}>{t('vclaim.statement_label').toUpperCase()}</T>
            <View style={{ borderRadius: r.input, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.violetSoft, padding: 12, minHeight: 120 }}>
              <View
                // On web, use a textarea; on native, a TextInput
                // We use TextInput from ui.js Field logic replicated here for multiline
              >
                {Platform.OS === 'web'
                  ? (() => {
                      const { TextInput } = require('react-native');
                      return <TextInput multiline value={statement} onChangeText={setStatement} placeholder={t('vclaim.statement_placeholder')} placeholderTextColor={c.mute} style={{ minHeight: 100, textAlignVertical: 'top', color: c.ink, fontSize: 14 }} />;
                    })()
                  : (() => {
                      const { TextInput } = require('react-native');
                      return <TextInput multiline value={statement} onChangeText={setStatement} placeholder={t('vclaim.statement_placeholder')} placeholderTextColor={c.mute} style={{ minHeight: 100, textAlignVertical: 'top', color: c.ink, fontSize: 14 }} />;
                    })()}
              </View>
            </View>
            <T size={11} color={c.mute} style={{ marginTop: 6 }}>{statement.length} / 2000</T>
          </Card>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn title={t('vclaim.back')} color={c.paper} ink={c.ink} onPress={() => setStep(2)} style={{ flex: 1 }} accessibilityLabel={t('vclaim.back')} />
            <Btn title={t('vclaim.next')} onPress={() => setStep(4)} disabled={!canNext3} style={{ flex: 1 }} accessibilityLabel={t('vclaim.next')} />
          </View>
        </View>
      )}

      {/* Step 4: Review & Submit */}
      {step === 4 && (
        <View style={{ gap: 12 }}>
          <H2>{t('vclaim.step4_title')}</H2>
          <Card>
            <T weight="700" size={13}>{t('vclaim.review_venue')}</T>
            <T size={14} color={c.ink} style={{ marginTop: 4 }}>{venueName}</T>
          </Card>
          <Card>
            <T weight="700" size={13}>{t('vclaim.review_role')}</T>
            <T size={14} color={c.ink} style={{ marginTop: 4 }}>{t(ROLES.find((x) => x.key === role)?.label ?? '')}</T>
          </Card>
          <Card>
            <T weight="700" size={13}>{t('vclaim.review_docs', { n: docCount })}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {Object.entries(docs).map(([kind, file]) => (
                <View key={kind} style={{ backgroundColor: c.limeSoft, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <T size={12} color={c.lime} weight="600">✓ {file.name}</T>
                </View>
              ))}
            </View>
          </Card>
          <View style={{ backgroundColor: c.cyanSoft, borderRadius: r.card, padding: 12 }}>
            <T size={12} color={c.cyan}>{t('vclaim.legal_disclaimer')}</T>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Btn title={t('vclaim.back')} color={c.paper} ink={c.ink} onPress={() => setStep(3)} style={{ flex: 1 }} accessibilityLabel={t('vclaim.back')} />
            <Btn title={t('vclaim.submit')} loading={submitting} onPress={submit} style={{ flex: 1 }} accessibilityLabel={t('vclaim.submit')} />
          </View>
        </View>
      )}
    </Screen>
  );
}

// ------------------------------------------------------------------ ClaimStatusScreen
export function ClaimStatusScreen({ route, navigation }) {
  const { claimId } = route.params ?? {};
  const { toast } = useSession();
  const r2 = useLoad(() => api.get(`/claims/${claimId}`), [claimId]);
  const claim = r2.data?.claim;
  const [withdrawing, setWithdrawing] = useState(false);

  const withdraw = () => {
    Alert.alert(t('vclaim.withdraw_confirm_title'), t('vclaim.withdraw_confirm_body'), [
      { text: t('vclaim.cancel'), style: 'cancel' },
      {
        text: t('vclaim.withdraw'), style: 'destructive',
        onPress: async () => {
          setWithdrawing(true);
          try {
            await api.delete(`/claims/${claimId}`);
            toast(t('vclaim.withdrawn_toast'));
            navigation.goBack();
          } catch (e) {
            toast(e.message);
          } finally {
            setWithdrawing(false);
          }
        },
      },
    ]);
  };

  const stepIndex = claim ? (STEP_STATUS_INDEX[claim.status] ?? 0) : 0;

  if (r2.loading && !claim) return <Screen><Loading /></Screen>;
  if (r2.error) return <Screen><ErrorBox error={r2.error} onRetry={r2.reload} /></Screen>;
  if (!claim) return <Screen><Empty emoji="🔎" title={t('vclaim.not_found')} /></Screen>;

  return (
    <Screen onRefresh={r2.reload}>
      {/* Hero card */}
      <GradCard colors={grad.hero} style={{ marginBottom: 16 }}>
        <T size={12} color="rgba(255,255,255,0.75)" weight="600">{claim.claim_no ?? `CLM-${claimId?.slice(0, 8)}`}</T>
        <T size={22} weight="800" color="#fff" style={{ marginTop: 4 }}>{claim.venue_name}</T>
        <T size={13} color="rgba(255,255,255,0.75)" style={{ marginTop: 2 }}>{t('vclaim.submitted_on', { date: String(claim.submitted_at).slice(0, 10) })}</T>
        <View style={{ marginTop: 10 }}>
          <Tag label={t(`vclaim.status_${claim.status}`)} color={STATUS_COLOR[claim.status] ?? c.violetSoft} />
        </View>
      </GradCard>

      {/* Metric strip */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
        {[
          { label: t('vclaim.metric_docs'), value: String(claim.document_count ?? 0) },
          { label: t('vclaim.metric_days'), value: String(daysAgo(claim.submitted_at)) },
          { label: t('vclaim.metric_status'), value: t(`vclaim.status_${claim.status}`) },
        ].map((m) => (
          <View key={m.label} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.line, alignItems: 'center' }}>
            <T size={18} weight="800">{m.value}</T>
            <T size={11} color={c.mute} style={{ marginTop: 2, textAlign: 'center' }}>{m.label}</T>
          </View>
        ))}
      </View>

      {/* Timeline */}
      <Section title={t('vclaim.timeline_title')} color={c.violet}>
        <Card>
          {TIMELINE_STEPS.map((step, i) => {
            const done = i < stepIndex;
            const active = i === stepIndex;
            return (
              <View key={step} style={{ flexDirection: 'row', gap: 12, paddingVertical: 10, borderBottomWidth: i < TIMELINE_STEPS.length - 1 ? 1 : 0, borderBottomColor: c.line }}>
                <View style={{ width: 24, alignItems: 'center' }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 4, backgroundColor: done ? c.lime : active ? c.sun : c.line }} />
                  {i < TIMELINE_STEPS.length - 1 ? <View style={{ width: 2, flex: 1, backgroundColor: done ? c.lime : c.line, marginTop: 4, marginBottom: -10 }} /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <T size={13} weight={active ? '700' : '500'} color={done ? c.lime : active ? c.sun : c.mute}>{t(step)}</T>
                  {active && claim.reviewer_note ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{claim.reviewer_note}</T> : null}
                </View>
                {done ? <T size={14} color={c.lime}>✓</T> : null}
              </View>
            );
          })}
        </Card>
      </Section>

      {/* Under review alert */}
      {claim.status === 'under_review' ? (
        <View style={{ backgroundColor: c.cyanSoft, borderRadius: r.card, borderLeftWidth: 3, borderLeftColor: c.cyan, padding: 14, marginTop: 16 }}>
          <T size={13} color={c.cyan}>{t('vclaim.review_contact_note')}</T>
        </View>
      ) : null}

      {/* Approved: success + manage */}
      {claim.status === 'approved' ? (
        <View style={{ marginTop: 16, gap: 10 }}>
          <View style={{ backgroundColor: c.limeSoft, borderRadius: r.card, padding: 14 }}>
            <T weight="700" size={15} color={c.lime}>{t('vclaim.approved_title')}</T>
            <T size={13} color={c.mute} style={{ marginTop: 4 }}>{t('vclaim.approved_sub')}</T>
          </View>
          <Btn title={t('vclaim.manage_venue')} onPress={() => navigation.navigate('VenueWorkspace')} color={c.lime} accessibilityLabel={t('vclaim.manage_venue')} />
        </View>
      ) : null}

      {/* Rejected: dispute */}
      {claim.status === 'rejected' ? (
        <View style={{ marginTop: 16, gap: 10 }}>
          <View style={{ backgroundColor: c.redSoft, borderRadius: r.card, borderLeftWidth: 3, borderLeftColor: c.red, padding: 14 }}>
            <T weight="700" size={14} color={c.red}>{t('vclaim.rejected_title')}</T>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>{claim.decision_reason ?? t('vclaim.rejected_no_reason')}</T>
          </View>
          <Btn title={t('vclaim.dispute')} color={c.orange} onPress={() => navigation.navigate('ClaimDispute', { claimId })} accessibilityLabel={t('vclaim.dispute')} />
        </View>
      ) : null}

      {/* Actions */}
      {!['approved', 'rejected', 'withdrawn'].includes(claim.status) ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <Btn small title={t('vclaim.add_docs')} color={c.paper} ink={c.ink} onPress={() => navigation.navigate('ClaimSubmit', { venueId: claim.venue_id, venueName: claim.venue_name })} style={{ flex: 1 }} accessibilityLabel={t('vclaim.add_docs')} />
          <Btn small title={t('vclaim.withdraw')} loading={withdrawing} color={c.redSoft} ink={c.red} onPress={withdraw} style={{ flex: 1 }} accessibilityLabel={t('vclaim.withdraw')} />
        </View>
      ) : null}
    </Screen>
  );
}

// ------------------------------------------------------------------ DisputeScreen (inline)
export function ClaimDisputeScreen({ route, navigation }) {
  const { claimId } = route.params ?? {};
  const { toast } = useSession();
  const [grounds, setGrounds] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (grounds.trim().length < 20) { toast(t('vclaim.dispute_too_short')); return; }
    setSubmitting(true);
    try {
      await api.post(`/claims/${claimId}/dispute`, { grounds });
      toast(t('vclaim.dispute_submitted'));
      navigation.goBack();
    } catch (e) {
      toast(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen>
      <H1 style={{ marginBottom: 8 }}>{t('vclaim.dispute_title')}</H1>
      <T color={c.mute} size={13}>{t('vclaim.dispute_sub')}</T>
      <Card style={{ marginTop: 16 }}>
        <T size={12} weight="600" color={c.mute} style={{ letterSpacing: 0.4, marginBottom: 8 }}>{t('vclaim.dispute_grounds_label').toUpperCase()}</T>
        {(() => {
          const { TextInput } = require('react-native');
          return (
            <TextInput multiline value={grounds} onChangeText={setGrounds} placeholder={t('vclaim.dispute_placeholder')} placeholderTextColor={c.mute}
              style={{ borderRadius: r.input, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.violetSoft, padding: 12, minHeight: 120, textAlignVertical: 'top', color: c.ink, fontSize: 14 }} />
          );
        })()}
      </Card>
      <View style={{ marginTop: 16 }}>
        <Btn title={t('vclaim.dispute_submit')} loading={submitting} onPress={submit} accessibilityLabel={t('vclaim.dispute_submit')} />
      </View>
    </Screen>
  );
}

// ------------------------------------------------------------------ MyClaimsScreen
export function MyClaimsScreen({ navigation }) {
  const r2 = useLoad(() => api.get('/me/claims'), []);
  const claims = r2.data?.claims ?? [];

  const actionFor = (claim) => {
    if (claim.status === 'rejected') return { label: t('vclaim.dispute'), screen: 'ClaimDispute', params: { claimId: claim.id } };
    if (claim.status === 'approved') return { label: t('vclaim.manage_venue'), screen: 'VenueWorkspace', params: {} };
    return { label: t('vclaim.view'), screen: 'ClaimStatus', params: { claimId: claim.id } };
  };

  return (
    <Screen onRefresh={r2.reload}>
      <H1 style={{ marginTop: 8 }}>{t('vclaim.my_claims_title')}</H1>
      <T color={c.mute} weight="700" size={14}>{t('vclaim.my_claims_sub')}</T>

      {r2.loading && !claims.length ? <Loading /> : r2.error ? <ErrorBox error={r2.error} onRetry={r2.reload} /> : !claims.length ? (
        <Empty emoji="🏟️" title={t('vclaim.no_claims_title')} sub={t('vclaim.no_claims_sub')} />
      ) : (
        <Section title={t('vclaim.my_claims_section')} color={c.violet}>
          {claims.map((claim) => {
            const action = actionFor(claim);
            return (
              <Row
                key={claim.id}
                title={claim.venue_name}
                sub={`${claim.claim_no} · ${String(claim.submitted_at).slice(0, 10)}`}
                right={
                  <View style={{ gap: 6, alignItems: 'flex-end' }}>
                    <Tag label={t(`vclaim.status_${claim.status}`)} color={STATUS_COLOR[claim.status] ?? c.violetSoft} />
                    <Pressable onPress={() => navigation.navigate(action.screen, action.params)} accessibilityRole="button" accessibilityLabel={action.label}
                      style={{ backgroundColor: c.pinkSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, minHeight: 28 }}>
                      <T size={12} weight="700" color={c.pink}>{action.label}</T>
                    </Pressable>
                  </View>
                }
              />
            );
          })}
        </Section>
      )}
    </Screen>
  );
}
