import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { t } from '../i18n';
import { Btn, Card, Chip, ErrorBox, H2, Loading, Tag, T, Wrap } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day } from '../theme';
import { AthleteRating360Panel } from './athlete-rating-360';
import { PerformancePublishSheet, PerformanceFeedSection } from './performance-publish';

const scopes = () => [
  { value: 'private', label: t('ap.scope_private') },
  { value: 'coach', label: t('ap.scope_coach') },
  { value: 'recruiter', label: t('ap.scope_recruiter') },
  { value: 'public', label: t('ap.scope_public') },
];
const scopeLabel = (v) => scopes().find((s) => s.value === v)?.label ?? v;
const sides = () => [
  { value: 'left', label: t('ap.side_left') },
  { value: 'right', label: t('ap.side_right') },
  { value: 'both', label: t('ap.side_both') },
];
const sources = () => [
  { value: 'self', label: t('ap.source_self') },
  { value: 'coach', label: t('ap.source_coach') },
  { value: 'test', label: t('ap.source_test') },
];
const nice = (s) => String(s).replace(/_/g, ' ');
const cap1 = (s) => nice(s).replace(/^./, (x) => x.toUpperCase());

const Row = ({ label, value, scope }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderColor: c.line }}>
    <T weight="700" size={13} color={c.mute} style={{ width: 110 }}>{label}</T>
    <T weight="700" size={14} style={{ flex: 1 }}>{value}</T>
    {scope ? <T size={11.5} color={c.mute} weight="700">{scopeLabel(scope)}</T> : null}
  </View>
);

/** The athlete-controlled part of one sport card: how you play, what you chose to measure, who may see it, and which affiliations are verified. */
export function AthleteProfilePanel({ p, onChanged }) {
  const { toast } = useSession();
  const prof = useLoad(() => api.get(`/me/sport-profiles/${p.id}/athlete`), [p.id]);
  const meas = useLoad(() => api.get(`/me/sport-profiles/${p.id}/measurements`), [p.id]);
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const reload = async () => { await Promise.all([prof.reload(), meas.reload()]); onChanged?.(); };
  const act = (fn, msg) => async () => { try { await fn(); await reload(); if (msg) toast(msg); } catch (e) { toast(e.message); } };

  if (prof.loading && !prof.data) return <Loading />;
  if (prof.error) return <ErrorBox error={prof.error} onRetry={prof.reload} />;
  const a = prof.data;
  const sc = a.field_scopes ?? {};
  const open = a.options.positions_open;
  const live = (meas.data ?? []).filter((m) => !m.revoked_at);
  const revoked = (meas.data ?? []).filter((m) => m.revoked_at);

  return (
    <View style={{ marginTop: 24 }}>
      <H2>{t('ap.title')}</H2>
      <Card style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T weight="800" size={22} style={{ fontVariant: ['tabular-nums'] }}>{a.completeness.percent}%</T>
          <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: a.completeness.percent }}>
            <View style={{ width: `${a.completeness.percent}%`, height: 8, backgroundColor: c.pink }} />
          </View>
        </View>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>
          {a.completeness.missing.length
            ? t('ap.completeness_missing', { missing: a.completeness.missing.map(nice).join(', ') })
            : t('ap.completeness_done')}
        </T>
        <View style={{ marginTop: 10 }}>
          <Row label={t('ap.dominant_side')} value={a.dominant_side ? cap1(a.dominant_side) : '—'} scope={a.dominant_side ? sc.dominant_side ?? 'private' : null} />
          <Row label={t('ap.positions')} value={a.positions.length ? a.positions.join(', ') : '—'} scope={a.positions.length ? sc.positions ?? 'private' : null} />
          <Row label={t('ap.preferences')} value={a.play_prefs.length ? a.play_prefs.join(', ') : '—'} scope={a.play_prefs.length ? sc.play_prefs ?? 'private' : null} />
          <Row label={t('ap.affiliations')} value={a.affiliations.length ? a.affiliations.map((x) => `✔ ${x.label}`).join('   ') : t('ap.affiliations_none')} scope={a.affiliations.length ? sc.affiliations ?? 'private' : null} />
        </View>
        <View style={{ marginTop: 10, alignItems: 'flex-start' }}><Btn small title={t('ap.edit_btn')} color={c.paper} onPress={() => setEdit(true)} /></View>
      </Card>

      <T weight="800" size={15} style={{ marginTop: 18 }}>{t('ap.measurements_title')}</T>
      <T size={12} color={c.mute}>{t('ap.measurements_hint')}</T>
      <View style={{ gap: 8, marginTop: 8 }}>
        {live.map((m) => (
          <Card key={m.id} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <T weight="800" size={15}>{cap1(m.metric)}: {m.value} {m.unit}</T>
                <T size={12} color={c.mute}>{day(m.measured_on + 'T12:00:00')} · {sources().find((s) => s.value === m.source)?.label}{m.note ? ` · ${m.note}` : ''}</T>
              </View>
              <T size={11.5} color={c.mute} weight="700">{scopeLabel(m.scope)}</T>
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {scopes().map((s) => <Chip key={s.value} label={s.label} active={m.scope === s.value} onPress={act(() => api.patch(`/me/measurements/${m.id}`, { scope: s.value }), t('ap.sharing_updated'))} />)}
              <Pressable hitSlop={8} onPress={act(() => api.post(`/me/measurements/${m.id}/revoke`), t('ap.meas_withdrawn_toast'))} style={{ justifyContent: 'center' }}><T size={13} weight="700" color={c.red}>{t('ap.withdraw')}</T></Pressable>
            </View>
          </Card>
        ))}
        {!live.length ? <T size={13} color={c.mute}>{t('ap.no_measurements')}</T> : null}
        {revoked.map((m) => (
          <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={12.5} color={c.mute} style={{ flex: 1 }}>{t('ap.withdrawn_label', { metric: nice(m.metric), value: m.value, unit: m.unit, date: m.measured_on })}</T>
            <Pressable hitSlop={8} onPress={act(() => api.post(`/me/measurements/${m.id}/restore`), t('ap.meas_restored_toast'))}><T size={13} weight="700">{t('ap.restore')}</T></Pressable>
          </View>
        ))}
      </View>
      <View style={{ marginTop: 10, alignItems: 'flex-start' }}><Btn small title={t('ap.add_measurement')} color={c.paper} onPress={() => setAdding(true)} /></View>

      {edit ? (
        <FormSheet visible onClose={() => setEdit(false)} title={t('ap.edit_title')} submitLabel={t('ap.save')}
          initial={{ dominant_side: a.dominant_side ?? undefined, positions: open ? undefined : a.positions, positions_text: open ? a.positions.join(', ') : undefined, play_prefs: a.play_prefs,
            s_dominant_side: sc.dominant_side ?? 'private', s_positions: sc.positions ?? 'private', s_play_prefs: sc.play_prefs ?? 'private', s_affiliations: sc.affiliations ?? 'private' }}
          fields={[
            { key: 'dominant_side', label: t('ap.form_dominant_side'), type: 'chips', options: sides(), optional: true },
            open ? { key: 'positions_text', label: t('ap.form_positions_open'), optional: true } : { key: 'positions', label: t('ap.form_positions'), type: 'multi', options: a.options.positions, optional: true },
            { key: 'play_prefs', label: t('ap.form_play_prefs'), type: 'multi', options: a.options.play_prefs, optional: true },
            { key: 'sec', label: t('ap.form_scopes_section'), type: 'section' },
            { key: 's_dominant_side', label: t('ap.dominant_side'), type: 'chips', options: scopes() },
            { key: 's_positions', label: t('ap.positions'), type: 'chips', options: scopes() },
            { key: 's_play_prefs', label: t('ap.preferences'), type: 'chips', options: scopes() },
            { key: 's_affiliations', label: t('ap.affiliations'), type: 'chips', options: scopes(), hint: t('ap.form_affiliations_hint') },
          ]}
          onSubmit={async (v) => {
            const positions = open ? String(v.positions_text ?? '').split(',').map((x) => x.trim()).filter(Boolean) : v.positions ?? [];
            await api.patch(`/me/sport-profiles/${p.id}/athlete`, {
              dominant_side: v.dominant_side ?? null, positions, play_prefs: v.play_prefs ?? [],
              field_scopes: { dominant_side: v.s_dominant_side, positions: v.s_positions, play_prefs: v.s_play_prefs, affiliations: v.s_affiliations },
            });
            await reload();
            return t('ap.saved');
          }} />
      ) : null}
      {adding ? (
        <FormSheet visible onClose={() => setAdding(false)} title={t('ap.meas_add_title')} submitLabel={t('ap.meas_save_btn')}
          initial={{ metric: 'height', unit: 'cm', measured_on: new Date().toISOString().slice(0, 10), source: 'self', scope: 'private' }}
          fields={[
            { key: 'metric', label: t('ap.meas_metric'), type: 'chips', options: a.options.metrics.map((m) => ({ value: m.metric, label: m.label })) },
            { key: 'unit', label: t('ap.meas_unit'), type: 'chips', options: (v) => (a.options.metrics.find((m) => m.metric === v.metric)?.units ?? ['cm']).map((u) => ({ value: u, label: u })) },
            { key: 'value', label: t('ap.meas_value'), type: 'number' },
            { key: 'measured_on', label: t('ap.meas_date'), type: 'date', max: new Date().toISOString().slice(0, 10) },
            { key: 'source', label: t('ap.meas_source'), type: 'choice', options: sources() },
            { key: 'scope', label: t('ap.meas_scope'), type: 'chips', options: scopes() },
          ]}
          onSubmit={async (v) => { await api.post(`/me/sport-profiles/${p.id}/measurements`, { ...v, value: Number(v.value) }); await reload(); return t('ap.meas_saved'); }} />
      ) : null}
    </View>
  );
}

/** 360 panel + performance feed for a sport profile — shows on both own and other athlete profiles. */
export function AthleteProfileRating360Section({ userId, sportSlug, isOwn, selfLevel }) {
  const [posting, setPosting] = useState(false);
  return (
    <View style={{ marginTop: 24, gap: 14 }}>
      {isOwn ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Btn small title={`🏅 ${t('pp.post_cta')}`} onPress={() => setPosting(true)} />
        </View>
      ) : null}
      <AthleteRating360Panel userId={userId} sport={sportSlug} isOwn={isOwn} profile={{ self_level: selfLevel }} />
      <PerformanceFeedSection userId={userId} sport={sportSlug} isOwn={isOwn} />
      {posting ? <PerformancePublishSheet visible onClose={() => setPosting(false)} sportSlug={sportSlug} /> : null}
    </View>
  );
}

const NEED_KEY = {
  wav: 'ap.need.wav', securement: 'ap.need.securement', guide_dog: 'ap.need.guide_dog', hearing_loop: 'ap.need.hearing_loop',
  escort: 'ap.need.escort', manual_support: 'ap.need.manual_support', medication_carry_on: 'ap.need.medication_carry_on',
  rooming_roll_in: 'ap.need.rooming_roll_in', rooming_hoist: 'ap.need.rooming_hoist', rooming_ground_floor: 'ap.need.rooming_ground_floor',
};
const needLabel = (k) => t(NEED_KEY[k] ?? 'ap.need.wav');
const needOpts = () => Object.keys(NEED_KEY).map((k) => ({ value: k, label: needLabel(k) }));

/** Travel assistance: athlete's consented access needs across all open trips they are a party to. */
export function TravelAssistanceSection({ participantId, canEdit }) {
  const { toast } = useSession();
  const [adding, setAdding] = useState(false);
  const st = useLoad(() => api.get('/me/travel-access-needs').catch(() => ({ needs: [] })), [participantId]);
  const needs = st.data?.needs ?? [];
  return (
    <Card style={{ marginTop: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <H2 style={{ flex: 1 }}>{t('ap.travel_title')}</H2>
        {canEdit ? <Btn small title={t('ap.travel_add')} onPress={() => setAdding(true)} /> : null}
      </View>
      <T size={12.5} color={c.mute} style={{ marginBottom: 10 }}>{t('ap.travel_hint')}</T>
      {needs.length ? (
        <Wrap gap={8}>
          {needs.map((n) => (
            <View key={n.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Tag label={needLabel(n.need_type)} color={n.scope === 'provider_minimal' ? c.cyanSoft : c.violetSoft} />
              <T size={10}>{n.scope === 'ops_only' ? '🔒' : '🔓'}</T>
            </View>
          ))}
        </Wrap>
      ) : (
        <T size={13} color={c.mute}>{t('ap.travel_no_needs')}</T>
      )}
      {st.error ? <T size={12} color={c.red} style={{ marginTop: 6 }}>{t('ap.travel_error')}</T> : null}
      {adding ? (
        <FormSheet visible onClose={() => setAdding(false)} title={t('ap.travel_form_title')} submitLabel={t('ap.save')}
          notice={t('ap.travel_notice')}
          fields={[
            { key: 'need_type', label: t('ap.travel_form_type'), type: 'chips', options: needOpts() },
            { key: 'scope', label: t('ap.travel_form_share'), type: 'switch', default: false },
            { key: 'note', label: t('ap.travel_form_note'), type: 'text', optional: true, multiline: true },
          ]}
          onSubmit={async (v) => {
            const trips = await api.get('/trips', { status: 'open', limit: 20 });
            for (const trip of trips ?? []) {
              const party = await api.get(`/trips/${trip.id}/party`).catch(() => ({ party: [] }));
              const me = (party.party ?? []).find((p) => p.user_id === participantId);
              if (me) {
                await api.post(`/trips/${trip.id}/access/needs`, { need_type: v.need_type, scope: v.scope ? 'provider_minimal' : 'ops_only', note: v.note || undefined }).catch(() => {});
              }
            }
            await st.reload();
            setAdding(false);
            toast(t('ap.travel_saved_toast'));
          }} />
      ) : null}
    </Card>
  );
}

/** Archived sport cards: their matches and history are kept, and restoring brings the card back as it was. */
export function ArchivedSports({ onRestored, refreshKey }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/sport-profiles/archived'), [refreshKey]);
  if (!list.data?.length) return null;
  return (
    <Card style={{ marginTop: 18 }}>
      <H2>{t('ap.archived_title')}</H2>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t('ap.archived_hint')}</T>
      {list.data.map((a) => (
        <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line, marginTop: 8 }}>
          <T size={22}>{a.sport_emoji}</T>
          <View style={{ flex: 1 }}>
            <T weight="800" size={14}>{a.sport}</T>
            <T size={12} color={c.mute}>{t('ap.archived_matches', { count: a.matches_kept })} · {t('ap.archived_on', { date: day(a.archived_on + 'T12:00:00') })}</T>
          </View>
          <Btn small title={t('ap.archived_restore')} color={c.paper} onPress={async () => { try { await api.post(`/me/sport-profiles/${a.id}/restore`); toast(t('ap.archived_restored_toast')); await list.reload(); await onRestored?.(); } catch (e) { toast(e.message); } }} />
        </View>
      ))}
    </Card>
  );
}
