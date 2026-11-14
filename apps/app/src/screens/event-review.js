// Event Reviews — rate an event, public listing, organizer analytics (issue #1190).
// Verified attendees review event quality; organizers see dimension analytics and NPS.
// Privacy threshold k≥3: distribution suppressed below that count.
import React, { useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, ErrorBox, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { t } from '../i18n';
import { c, day } from '../theme';

const ROLES = () => [
  { value: 'participant', label: t('er.role_participant'), icon: '🏅' },
  { value: 'official', label: t('er.role_official'), icon: '🧑‍⚖️' },
  { value: 'coach', label: t('er.role_coach'), icon: '📋' },
  { value: 'ticketed_attendee', label: t('er.role_spectator'), icon: '👥' },
];

const REVIEW_DIMS = () => [
  { key: 'organisation', label: t('er.dim_organisation') },
  { key: 'scheduling', label: t('er.dim_scheduling') },
  { key: 'officiating', label: t('er.dim_officiating') },
  { key: 'venue_readiness', label: t('er.dim_venue') },
  { key: 'safety', label: t('er.dim_safety') },
  { key: 'communication', label: t('er.dim_communication') },
];

const NPS_COLOR = (v) => {
  if (v === null || v === undefined) return c.line;
  if (v <= 6) return '#EF4444';
  if (v <= 8) return '#F59E0B';
  return '#22C55E';
};

function StarRow({ value, onChange, size = 28 }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Pressable key={s} onPress={() => onChange(s)} accessibilityRole="radio" accessibilityState={{ selected: value >= s }} style={{ padding: 4, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <T size={size} color={value >= s ? '#F59E0B' : c.line}>★</T>
        </Pressable>
      ))}
    </View>
  );
}

function DimRow({ dim, rating, comment, onRate, onComment }) {
  const low = rating > 0 && rating <= 3;
  return (
    <View style={{ paddingVertical: 12, borderBottomWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <T weight="700" size={14} style={{ flex: 1 }}>{dim.label}</T>
        <StarRow value={rating} onChange={onRate} size={22} />
      </View>
      {low ? (
        <View style={{ marginTop: 6 }}>
          <T size={12.5} color={c.mute} style={{ marginBottom: 6 }}>{t('er.low_prompt')}</T>
          <TextInput value={comment ?? ''} onChangeText={onComment} multiline placeholder={t('er.low_placeholder')} placeholderTextColor={c.mute}
            style={{ borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, fontSize: 13, color: c.fg, minHeight: 60 }} accessibilityLabel={t('er.low_placeholder')} />
        </View>
      ) : null}
    </View>
  );
}

function NpsSelector({ value, onChange }) {
  return (
    <View>
      <T weight="700" size={13} style={{ marginBottom: 4 }}>{t('er.nps_label')}</T>
      <T size={12} color={c.mute} style={{ marginBottom: 10 }}>{t('er.nps_sub')}</T>
      <View style={{ flexDirection: 'row', gap: 3 }}>
        {Array.from({ length: 11 }, (_, i) => i).map((v) => (
          <Pressable key={v} onPress={() => onChange(v)} accessibilityRole="radio" accessibilityState={{ selected: value === v }}
            style={{ flex: 1, height: 40, borderRadius: 6, backgroundColor: value === v ? NPS_COLOR(v) : c.line, alignItems: 'center', justifyContent: 'center', borderWidth: value === v ? 0 : 1, borderColor: c.line }}>
            <T size={value === v ? 13 : 12} weight={value === v ? '800' : '400'} color={value === v ? '#fff' : c.mute}>{v}</T>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
        <T size={11} color={c.mute}>{t('er.nps_low')}</T>
        <T size={11} color={c.mute}>{t('er.nps_high')}</T>
      </View>
    </View>
  );
}

export function RateEventSheet({ visible, onClose, eventId, eventName }) {
  const { toast } = useSession();
  const [role, setRole] = useState('');
  const [overall, setOverall] = useState(0);
  const [dims, setDims] = useState(() => REVIEW_DIMS().map((d) => ({ key: d.key, rating: 0, comment: '' })));
  const [nps, setNps] = useState(null);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const eligibility = useLoad(() => eventId ? api.get(`/events/${eventId}/review-eligibility`) : null, [eventId]);

  const setDimRating = (key, v) => setDims((prev) => prev.map((d) => d.key === key ? { ...d, rating: v } : d));
  const setDimComment = (key, v) => setDims((prev) => prev.map((d) => d.key === key ? { ...d, comment: v } : d));

  const submit = async () => {
    if (!role) { toast(t('er.error_role')); return; }
    if (!overall) { toast(t('er.error_overall')); return; }
    setSubmitting(true);
    try {
      await api.post(`/events/${eventId}/reviews`, {
        reviewer_role: role,
        overall,
        dimensions: dims.filter((d) => d.rating > 0).map((d) => ({ key: d.key, rating: d.rating, comment: d.comment || undefined })),
        nps_score: nps,
        body: body || undefined,
      });
      toast(t('er.submitted_toast'));
      onClose?.();
    } catch (e) {
      toast(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!visible) return null;
  const elig = eligibility.data;
  const isEligible = elig?.eligible;
  const dimDefs = REVIEW_DIMS();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.canvas }}>
      <View style={{ padding: 20, gap: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T weight="900" size={16} style={{ flex: 1 }}>⭐ {t('er.sheet_title')}</T>
          <Pressable hitSlop={12} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('er.close')}><T size={22} color={c.mute}>✕</T></Pressable>
        </View>
        {eventName ? <T size={13} color={c.mute}>{eventName}</T> : null}

        {elig && !isEligible ? (
          <View style={{ backgroundColor: c.redSoft, borderRadius: 10, padding: 14, flexDirection: 'row', gap: 10 }}>
            <T size={18}>⚠️</T>
            <T size={13} color={c.red} style={{ flex: 1 }}>{elig.reason ?? t('er.not_eligible')}</T>
          </View>
        ) : elig?.verified ? (
          <View style={{ backgroundColor: c.mintSoft, borderRadius: 10, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T size={16}>✅</T>
            <T size={13} color={c.mint}>{t('er.eligible_verified', { type: elig.evidence_type })}</T>
          </View>
        ) : (
          <View style={{ backgroundColor: c.sunSoft, borderRadius: 10, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T size={16}>⏳</T>
            <T size={13} color="#92400E">{t('er.eligible_pending')}</T>
          </View>
        )}

        <View>
          <T weight="700" size={14} style={{ marginBottom: 10 }}>{t('er.role_label')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {ROLES().map((r) => (
              <Chip key={r.value} label={`${r.icon} ${r.label}`} active={role === r.value} onPress={() => setRole(r.value)} />
            ))}
          </View>
        </View>

        <View>
          <T weight="700" size={14} style={{ marginBottom: 8 }}>{t('er.overall_label')}</T>
          <StarRow value={overall} onChange={setOverall} size={32} />
        </View>

        <View>
          <T weight="700" size={14} style={{ marginBottom: 4 }}>{t('er.dimensions_title')}</T>
          <T size={12} color={c.mute} style={{ marginBottom: 10 }}>{t('er.dimensions_sub')}</T>
          {dimDefs.map((d, i) => (
            <DimRow key={d.key} dim={d} rating={dims[i].rating} comment={dims[i].comment} onRate={(v) => setDimRating(d.key, v)} onComment={(v) => setDimComment(d.key, v)} />
          ))}
        </View>

        <NpsSelector value={nps} onChange={setNps} />

        <View>
          <T weight="700" size={14} style={{ marginBottom: 8 }}>{t('er.body_label')}</T>
          <TextInput value={body} onChangeText={setBody} multiline placeholder={t('er.body_placeholder')} placeholderTextColor={c.mute}
            style={{ borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 12, fontSize: 14, color: c.fg, minHeight: 80, lineHeight: 20 }} accessibilityLabel={t('er.body_label')} />
        </View>

        <View style={{ backgroundColor: c.mute + '22', borderRadius: 8, padding: 12 }}>
          <T size={12} color={c.mute}>{t('er.privacy_note')}</T>
        </View>

        <Btn title={submitting ? t('er.submitting') : t('er.submit_btn')} onPress={submit} disabled={submitting || !isEligible} />
      </View>
    </ScrollView>
  );
}

function ReviewCard({ review }) {
  const [showResp, setShowResp] = useState(false);
  return (
    <Card pad={14} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T weight="800" size={14} color={c.pink}>{(review.author_initials ?? '?')}</T>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T weight="700" size={14}>{review.author_name ?? t('er.anonymous')}</T>
            {review.verified ? <Tag label={t('er.verified_chip')} color={c.mintSoft} /> : null}
          </View>
          <T size={12} color={c.mute}>{ROLES().find((r) => r.value === review.reviewer_role)?.label} · {day(review.created_at)}</T>
        </View>
        <View style={{ flexDirection: 'row' }}>
          {Array.from({ length: 5 }, (_, i) => (
            <T key={i} size={14} color={i < review.overall ? '#F59E0B' : c.line}>★</T>
          ))}
        </View>
      </View>
      {review.body ? <T size={13.5} style={{ lineHeight: 20 }}>{review.body}</T> : null}
      {review.organizer_response ? (
        <Pressable onPress={() => setShowResp(!showResp)} accessibilityRole="button">
          <View style={{ backgroundColor: c.cyanSoft, borderRadius: 8, padding: 10, flexDirection: 'row', gap: 8 }}>
            <T size={14}>💬</T>
            <View style={{ flex: 1 }}>
              <T weight="700" size={12.5} color={c.cyan}>{t('er.organizer_response')}</T>
              {showResp ? <T size={13} style={{ marginTop: 4, lineHeight: 19 }}>{review.organizer_response}</T> : <T size={12} color={c.mute}>{t('er.tap_to_read')}</T>}
            </View>
          </View>
        </Pressable>
      ) : null}
    </Card>
  );
}

export function EventReviewsTab({ eventId, isOrganizer }) {
  const data = useLoad(() => api.get(`/events/${eventId}/reviews`), [eventId]);
  const [role, setRole] = useState('all');

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const d = data.data;

  if (d?.suppressed) {
    return (
      <Card pad={20} style={{ alignItems: 'center', gap: 8 }}>
        <T size={30}>🔒</T>
        <T weight="700" size={15} style={{ textAlign: 'center' }}>{t('er.suppressed_title')}</T>
        <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{t('er.suppressed_sub', { n: d.threshold ?? 3 })}</T>
      </Card>
    );
  }

  const reviews = (d?.reviews ?? []).filter((r) => role === 'all' || r.reviewer_role === role);
  const roleCounts = d?.role_counts ?? {};

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Chip label={t('er.all_roles')} active={role === 'all'} onPress={() => setRole('all')} />
        {ROLES().filter((r) => roleCounts[r.value]).map((r) => (
          <Chip key={r.value} label={`${r.icon} ${r.label} (${roleCounts[r.value]})`} active={role === r.value} onPress={() => setRole(r.value)} />
        ))}
      </View>
      {!reviews.length ? (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <T size={13} color={c.mute}>{t('er.no_reviews')}</T>
        </View>
      ) : reviews.map((r) => <ReviewCard key={r.id} review={r} />)}
    </View>
  );
}

function DimBar({ label, score, maxScore = 5 }) {
  const pct = Math.min((score / maxScore) * 100, 100);
  const low = score <= 3.5;
  const barColor = low ? '#EF4444' : '#8458B3';
  return (
    <View style={{ gap: 4, marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T size={13} weight="700">{label}</T>
          {low ? <T size={16}>⚠️</T> : null}
        </View>
        <T size={13} weight="800" color={barColor}>{score?.toFixed(1)}/5</T>
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 8, borderRadius: 4, backgroundColor: barColor }} />
      </View>
    </View>
  );
}

export function OrganizerReviewAnalyticsSheet({ visible, onClose, eventId }) {
  const data = useLoad(() => eventId ? api.get(`/events/${eventId}/review-analytics`) : null, [eventId]);

  if (!visible) return null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.canvas }}>
      <View style={{ padding: 20, gap: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T weight="900" size={16} style={{ flex: 1 }}>{t('er.analytics_title')}</T>
          <Pressable hitSlop={12} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('er.close')}><T size={22} color={c.mute}>✕</T></Pressable>
        </View>
        {data.loading ? <Loading /> : data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> : (() => {
          const d = data.data;
          if (!d) return <T color={c.mute}>{t('er.no_data')}</T>;
          const nps = d.nps_score;
          const npsColor = nps >= 50 ? c.mint : nps >= 0 ? c.sun : c.red;
          return (
            <View style={{ gap: 16 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <Card pad={14} style={{ flex: 1, minWidth: 120, alignItems: 'center' }}>
                  <T weight="900" size={22} color={c.pink}>{d.overall_avg?.toFixed(1)}</T>
                  <View style={{ flexDirection: 'row' }}>{Array.from({ length: 5 }, (_, i) => <T key={i} size={12} color={i < Math.round(d.overall_avg) ? '#F59E0B' : c.line}>★</T>)}</View>
                  <T size={11} color={c.mute} style={{ marginTop: 2 }}>{t('er.kpi_overall')}</T>
                </Card>
                <Card pad={14} style={{ flex: 1, minWidth: 120, alignItems: 'center' }}>
                  <T weight="900" size={22}>{d.review_count}</T>
                  <T size={11} color={c.mute} style={{ marginTop: 2 }}>{t('er.kpi_count')}</T>
                </Card>
                <Card pad={14} style={{ flex: 1, minWidth: 120, alignItems: 'center' }}>
                  <T weight="900" size={22}>{d.response_rate}%</T>
                  <T size={11} color={c.mute} style={{ marginTop: 2 }}>{t('er.kpi_response')}</T>
                </Card>
                <Card pad={14} style={{ flex: 1, minWidth: 120, alignItems: 'center' }}>
                  <T weight="900" size={22} color={npsColor}>{nps >= 0 ? '+' : ''}{nps}</T>
                  {d.nps_vs_last ? <T size={11} color={d.nps_vs_last > 0 ? c.mint : c.red}>{d.nps_vs_last > 0 ? '↑' : '↓'} {Math.abs(d.nps_vs_last)} vs last</T> : null}
                  <T size={11} color={c.mute}>{t('er.kpi_nps')}</T>
                </Card>
              </View>
              {d.benchmark ? (
                <View style={{ backgroundColor: c.cyanSoft, borderRadius: 10, padding: 12 }}>
                  <T size={13} color={c.cyan}>{d.benchmark}</T>
                </View>
              ) : null}
              <Card pad={14}>
                <T weight="700" size={14} style={{ marginBottom: 12 }}>{t('er.dimensions_title')}</T>
                {REVIEW_DIMS().map((dim) => {
                  const score = d.dimension_averages?.[dim.key] ?? 0;
                  return <DimBar key={dim.key} label={dim.label} score={score} />;
                })}
              </Card>
              {d.priority_actions?.length ? (
                <Card pad={14}>
                  <T weight="700" size={14} style={{ marginBottom: 8 }}>🎯 {t('er.priority_title')}</T>
                  {d.priority_actions.map((a, i) => (
                    <View key={i} style={{ flexDirection: 'row', gap: 8, paddingVertical: 6 }}>
                      <T size={13} color={c.pink} weight="800">{i + 1}.</T>
                      <T size={13} style={{ flex: 1, lineHeight: 19 }}>{a}</T>
                    </View>
                  ))}
                </Card>
              ) : null}
              {d.nps_promoters != null ? (
                <Card pad={14}>
                  <T weight="700" size={14} style={{ marginBottom: 10 }}>{t('er.nps_breakdown')}</T>
                  {[
                    { label: t('er.nps_promoters'), pct: d.nps_promoters, color: '#22C55E' },
                    { label: t('er.nps_passives'), pct: d.nps_passives, color: '#F59E0B' },
                    { label: t('er.nps_detractors'), pct: d.nps_detractors, color: '#EF4444' },
                  ].map((s) => (
                    <View key={s.label} style={{ marginBottom: 8 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <T size={13}>{s.label}</T>
                        <T size={13} weight="800" color={s.color}>{s.pct}%</T>
                      </View>
                      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden', marginTop: 4 }}>
                        <View style={{ width: `${s.pct}%`, height: 6, borderRadius: 3, backgroundColor: s.color }} />
                      </View>
                    </View>
                  ))}
                </Card>
              ) : null}
            </View>
          );
        })()}
      </View>
    </ScrollView>
  );
}
