// PS-06: Venue manager — accessibility audit panel. Rich verification metadata per feature,
// outage management and automated booking notifications. All text via t(). No personal data.
import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Loading, Row, T } from '../ui';
import { c, r, font } from '../theme';

const FEATURE_EMOJI = {
  step_free_route: '♿', lift: '🛗', accessible_changing: '🚿', accessible_toilet: '🚻',
  accessible_parking: '🅿️', pool_hoist: '🏊', tactile_markings: '👁', hearing_loop: '🔊',
  quiet_room: '🤫', wheelchair_circulation: '🔄', accessible_viewing: '👀',
  accessible_emergency_egress: '🚨', accessible_drop_off: '🚐',
};

const CONFIDENCE = ['provisional', 'self_reported', 'third_party', 'certified'];
const CONFIDENCE_COLOR = { certified: c.lime, third_party: c.cyan, self_reported: c.sun, provisional: c.mute, unknown: c.mute, expired: c.red };
const CONFIDENCE_BG = { certified: c.limeSoft, third_party: c.cyanSoft, self_reported: c.sunSoft, provisional: c.bg, unknown: c.bg, expired: c.redSoft };

const stateLabel = (s) => t(`acc.state.${s}`) || s;

function StateChip({ state }) {
  const color = CONFIDENCE_COLOR[state] ?? c.mute;
  const bg = CONFIDENCE_BG[state] ?? c.bg;
  return <View style={[ss.chip, { backgroundColor: bg }]}><T size={11} weight="700" color={color}>{stateLabel(state)}</T></View>;
}

function EditSheet({ venueId, feature, record, onClose, onSaved }) {
  const [confidence, setConfidence] = useState(record?.confidence ?? 'self_reported');
  const [source, setSource] = useState(record?.source ?? '');
  const [assessor, setAssessor] = useState(record?.assessor_name ?? '');
  const [evidenceRef, setEvidenceRef] = useState(record?.evidence_ref ?? '');
  const [lastChecked, setLastChecked] = useState(record?.last_checked ?? '');
  const [expiresAt, setExpiresAt] = useState(record?.expires_at ?? '');
  const [notes, setNotes] = useState(record?.feature_detail?.notes ?? '');
  const [liftWidth, setLiftWidth] = useState(String(record?.feature_detail?.lift_width_mm ?? ''));
  const [liftDepth, setLiftDepth] = useState(String(record?.feature_detail?.lift_depth_mm ?? ''));
  const [hoistWeight, setHoistWeight] = useState(String(record?.feature_detail?.hoist_weight_kg ?? ''));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const detail = {};
      if (notes) detail.notes = notes;
      if (feature === 'lift' && liftWidth) detail.lift_width_mm = Number(liftWidth);
      if (feature === 'lift' && liftDepth) detail.lift_depth_mm = Number(liftDepth);
      if (feature === 'pool_hoist' && hoistWeight) detail.hoist_weight_kg = Number(hoistWeight);
      await api.patch(`/venues/${venueId}/access-features/${feature}`, {
        confidence, source: source || undefined, assessor_name: assessor || undefined,
        evidence_ref: evidenceRef || undefined, last_checked: lastChecked || undefined,
        expires_at: expiresAt || undefined, feature_detail: Object.keys(detail).length ? detail : undefined,
      });
      onSaved();
    } catch (e) { setErr(explain(e)); } finally { setSaving(false); }
  };

  return (
    <View style={ss.sheet}>
      <View style={ss.handle} />
      <T size={17} weight="800" style={{ marginBottom: 16 }}>{t('acc.audit.title')} — {t(`acc.feat.${feature}`)}</T>
      <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.confidence').toUpperCase()}</T>
      <View style={ss.chipRow}>
        {CONFIDENCE.map((v) => (
          <Pressable key={v} onPress={() => setConfidence(v)} style={[ss.chip, { backgroundColor: v === confidence ? c.pink : c.bg, borderWidth: 1, borderColor: v === confidence ? c.pink : c.line }]} accessibilityLabel={stateLabel(v)} accessibilityRole="radio">
            <T size={12} weight="700" color={v === confidence ? '#fff' : c.mute}>{stateLabel(v)}</T>
          </Pressable>
        ))}
      </View>
      <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.source').toUpperCase()}</T>
      <TextInput style={ss.input} value={source} onChangeText={setSource} accessibilityLabel={t('acc.source')} />
      <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.assessor').toUpperCase()}</T>
      <TextInput style={ss.input} value={assessor} onChangeText={setAssessor} accessibilityLabel={t('acc.assessor')} />
      <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.evidence').toUpperCase()}</T>
      <TextInput style={ss.input} value={evidenceRef} onChangeText={setEvidenceRef} accessibilityLabel={t('acc.evidence')} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.checked').toUpperCase()}</T>
          <TextInput style={ss.input} value={lastChecked} onChangeText={setLastChecked} placeholder="YYYY-MM-DD" accessibilityLabel={t('acc.checked')} />
        </View>
        <View style={{ flex: 1 }}>
          <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.expires').toUpperCase()}</T>
          <TextInput style={ss.input} value={expiresAt} onChangeText={setExpiresAt} placeholder="YYYY-MM-DD" accessibilityLabel={t('acc.expires')} />
        </View>
      </View>
      {feature === 'lift' && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.detail.lift_width').toUpperCase()}</T>
            <TextInput style={ss.input} value={liftWidth} onChangeText={setLiftWidth} keyboardType="numeric" accessibilityLabel={t('acc.detail.lift_width')} />
          </View>
          <View style={{ flex: 1 }}>
            <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.detail.lift_depth').toUpperCase()}</T>
            <TextInput style={ss.input} value={liftDepth} onChangeText={setLiftDepth} keyboardType="numeric" accessibilityLabel={t('acc.detail.lift_depth')} />
          </View>
        </View>
      )}
      {feature === 'pool_hoist' && (
        <>
          <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.detail.hoist_weight').toUpperCase()}</T>
          <TextInput style={ss.input} value={hoistWeight} onChangeText={setHoistWeight} keyboardType="numeric" accessibilityLabel={t('acc.detail.hoist_weight')} />
        </>
      )}
      <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.detail.notes').toUpperCase()}</T>
      <TextInput style={[ss.input, { minHeight: 56 }]} value={notes} onChangeText={setNotes} multiline accessibilityLabel={t('acc.detail.notes')} />
      {err ? <T size={12} color={c.red} style={{ marginBottom: 8 }}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Pressable style={[ss.btn, { flex: 1, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
          <T size={14} weight="700" color={c.ink}>{t('common.cancel')}</T>
        </Pressable>
        <Pressable style={[ss.btn, { flex: 1, backgroundColor: c.pink }]} onPress={save} disabled={saving} accessibilityRole="button" accessibilityLabel={t('common.save')}>
          <T size={14} weight="700" color="#fff">{saving ? t('common.loading') : t('common.save')}</T>
        </Pressable>
      </View>
    </View>
  );
}

function OutageSheet({ venueId, feature, onClose, onRaised }) {
  const [reason, setReason] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const confirm = async () => {
    setSaving(true); setErr(null);
    try {
      await api.post(`/venues/${venueId}/access-outages`, { feature, reason: reason || undefined, ends_at: endsAt || undefined });
      onRaised();
    } catch (e) { setErr(explain(e)); } finally { setSaving(false); }
  };

  return (
    <View style={ss.sheet}>
      <View style={ss.handle} />
      <T size={17} weight="800" color={c.sun} style={{ marginBottom: 8 }}>⚠ {t('acc.outage.title')}</T>
      <T size={13} color={c.mute} style={{ marginBottom: 14 }}>{t('acc.feat.' + feature)} · {t('acc.outage.reason')}</T>
      <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.outage.reason').toUpperCase()}</T>
      <TextInput style={ss.input} value={reason} onChangeText={setReason} accessibilityLabel={t('acc.outage.reason')} />
      <T size={10} weight="800" color={c.mute} style={ss.label}>{t('acc.outage.ends_at').toUpperCase()}</T>
      <TextInput style={ss.input} value={endsAt} onChangeText={setEndsAt} placeholder="YYYY-MM-DD" accessibilityLabel={t('acc.outage.ends_at')} />
      {err ? <T size={12} color={c.red} style={{ marginBottom: 8 }}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Pressable style={[ss.btn, { flex: 1, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
          <T size={14} weight="700" color={c.ink}>{t('common.cancel')}</T>
        </Pressable>
        <Pressable style={[ss.btn, { flex: 1, backgroundColor: c.sun }]} onPress={confirm} disabled={saving} accessibilityRole="button" accessibilityLabel={t('acc.outage.raise')}>
          <T size={14} weight="700" color="#fff">{saving ? t('common.loading') : t('acc.outage.raise')}</T>
        </Pressable>
      </View>
    </View>
  );
}

export function VenueAccessAudit({ v, toast }) {
  const { wide } = useLayout();
  const data = useLoad(() => api.get(`/venues/${v.id}/access-features`), [v.id]);
  const [editFeature, setEditFeature] = useState(null);
  const [outageFeature, setOutageFeature] = useState(null);

  if (data.error) return <LoadError error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;

  const features = data.data.features;
  const certified = features.filter((f) => f.state === 'certified').length;
  const thirdParty = features.filter((f) => f.state === 'third_party').length;
  const selfReported = features.filter((f) => f.state === 'self_reported').length;
  const notRecorded = features.filter((f) => f.state === 'unknown').length;
  const outages = features.filter((f) => f.outage_active).length;

  const resolveOutage = async (outageId) => {
    try { await api.patch(`/venues/${v.id}/access-outages/${outageId}/resolve`); data.reload(); } catch (e) { toast?.(explain(e)); }
  };

  const kpis = [
    { label: t('acc.state.certified'), value: certified, color: c.lime },
    { label: t('acc.state.third_party'), value: thirdParty, color: c.cyan },
    { label: t('acc.state.self_reported'), value: selfReported, color: c.sun },
    { label: t('acc.state.unknown'), value: notRecorded, color: c.mute },
    { label: t('acc.check.outage'), value: outages, color: c.red },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
      <T size={17} weight="800">{t('acc.audit.title')}</T>

      {/* KPI strip */}
      <View style={ss.kpiRow}>
        {kpis.map((k) => (
          <View key={k.label} style={ss.kpi}>
            <T size={22} weight="800" color={k.color}>{k.value}</T>
            <T size={10} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>{k.label}</T>
          </View>
        ))}
      </View>

      {/* Active outage banner */}
      {outages > 0 && (
        <View style={[ss.banner, { borderColor: c.sun, backgroundColor: c.sunSoft }]}>
          <T size={13} weight="800" color={c.sun}>⚠ {features.filter((f) => f.outage_active).map((f) => t(`acc.feat.${f.feature}`)).join(', ')} — {t('acc.outage.active')}</T>
        </View>
      )}

      {/* Feature cards in 2-col grid on wide, single on phone */}
      <View style={wide ? ss.grid2 : null}>
        {features.map((feat) => (
          <View key={feat.feature} style={[ss.featCard, feat.outage_active && ss.featCardOutage, feat.state === 'unknown' && ss.featCardGap, wide && { flex: 1, minWidth: 300 }]}>
            <View style={ss.featRow}>
              <T size={20}>{FEATURE_EMOJI[feat.feature] ?? '♿'}</T>
              <View style={{ flex: 1, marginInlineStart: 10 }}>
                <T size={14} weight="700">{t(`acc.feat.${feat.feature}`)}</T>
                {feat.last_checked ? <T size={11} color={c.mute}>{t('acc.checked')}: {feat.last_checked}</T> : null}
              </View>
              <StateChip state={feat.state} />
            </View>
            {feat.expires_at && !feat.expired && new Date(feat.expires_at) < new Date(Date.now() + 90 * 864e5) && (
              <View style={[ss.banner, { borderColor: c.sun, backgroundColor: c.sunSoft, marginTop: 6 }]}>
                <T size={11} weight="700" color={c.sun}>⚠ {t('acc.expires')}: {feat.expires_at}</T>
              </View>
            )}
            {feat.outage_active && (
              <View style={[ss.banner, { borderColor: c.sun, backgroundColor: c.sunSoft, marginTop: 6 }]}>
                <T size={12} weight="800" color={c.sun}>{t('acc.outage.active')}</T>
                {feat.outage_reason ? <T size={11} color={c.mute}>{feat.outage_reason}</T> : null}
              </View>
            )}
            <View style={ss.btnRow}>
              <Pressable style={[ss.btn, { backgroundColor: c.bg, borderWidth: 1, borderColor: c.line }]} onPress={() => setEditFeature(feat)} accessibilityRole="button" accessibilityLabel={`${t('common.save')} ${t(`acc.feat.${feat.feature}`)}`}>
                <T size={12} weight="700" color={c.ink}>Edit</T>
              </Pressable>
              {feat.outage_active
                ? <Pressable style={[ss.btn, { backgroundColor: c.limeSoft }]} onPress={() => resolveOutage(feat.outage_id)} accessibilityRole="button" accessibilityLabel={t('acc.outage.resolve')}>
                    <T size={12} weight="700" color={c.lime}>{t('acc.outage.resolve')}</T>
                  </Pressable>
                : <Pressable style={[ss.btn, { backgroundColor: c.sunSoft }]} onPress={() => setOutageFeature(feat.feature)} accessibilityRole="button" accessibilityLabel={t('acc.outage.raise')}>
                    <T size={12} weight="700" color={c.sun}>{t('acc.outage.title')}</T>
                  </Pressable>}
            </View>
          </View>
        ))}
      </View>

      {/* Edit modal */}
      <Modal visible={!!editFeature} animationType="slide" transparent presentationStyle="overFullScreen">
        <View style={ss.overlay}>
          {editFeature && (
            <EditSheet
              venueId={v.id} feature={editFeature.feature} record={editFeature}
              onClose={() => setEditFeature(null)}
              onSaved={() => { setEditFeature(null); data.reload(); }}
            />
          )}
        </View>
      </Modal>

      {/* Outage modal */}
      <Modal visible={!!outageFeature} animationType="slide" transparent presentationStyle="overFullScreen">
        <View style={ss.overlay}>
          {outageFeature && (
            <OutageSheet
              venueId={v.id} feature={outageFeature}
              onClose={() => setOutageFeature(null)}
              onRaised={() => { setOutageFeature(null); data.reload(); }}
            />
          )}
        </View>
      </Modal>
    </ScrollView>
  );
}

const ss = StyleSheet.create({
  kpiRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  kpi: { flex: 1, minWidth: 60, backgroundColor: c.paper, borderRadius: r.input, padding: 10, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  chip: { borderRadius: r.pill, paddingVertical: 4, paddingHorizontal: 10, alignSelf: 'flex-start' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  banner: { borderWidth: 1.5, borderRadius: r.input, padding: 10, marginBottom: 4 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  featCard: { backgroundColor: c.paper, borderRadius: r.card, padding: 13, marginBottom: 9, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  featCardOutage: { borderWidth: 1.5, borderColor: c.sun },
  featCardGap: { borderWidth: 1.5, borderColor: c.line, borderStyle: 'dashed' },
  featRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  btn: { borderRadius: r.input, paddingVertical: 8, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { backgroundColor: c.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.line, alignSelf: 'center', marginBottom: 12 },
  label: { textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 5 },
  input: { backgroundColor: c.bg, borderWidth: 1.5, borderColor: c.line, borderRadius: r.input, padding: 10, color: c.ink, fontSize: 14, marginBottom: 10 },
});
