import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, ErrorBox, H2, Loading, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day } from '../theme';

const SCOPES = [
  { value: 'private', label: 'Only me' },
  { value: 'coach', label: 'My coaches' },
  { value: 'recruiter', label: 'Recruiters' },
  { value: 'public', label: 'Everyone' },
];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.value, s.label]));
const SIDES = [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }, { value: 'both', label: 'Both' }];
const SOURCES = [{ value: 'self', label: 'Measured by me' }, { value: 'coach', label: 'By my coach' }, { value: 'test', label: 'At a test / trial' }];
const nice = (s) => String(s).replace(/_/g, ' ');
const cap1 = (s) => nice(s).replace(/^./, (x) => x.toUpperCase());

const Row = ({ label, value, scope }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderColor: c.line }}>
    <T weight="700" size={13} color={c.mute} style={{ width: 110 }}>{label}</T>
    <T weight="700" size={14} style={{ flex: 1 }}>{value}</T>
    {scope ? <T size={11.5} color={c.mute} weight="700">{SCOPE_LABEL[scope]}</T> : null}
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
      <H2>Athlete profile</H2>
      <Card style={{ marginTop: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T weight="800" size={22} style={{ fontVariant: ['tabular-nums'] }}>{a.completeness.percent}%</T>
          <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: a.completeness.percent }}>
            <View style={{ width: `${a.completeness.percent}%`, height: 8, backgroundColor: c.lime }} />
          </View>
        </View>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>
          {a.completeness.missing.length ? `Still open: ${a.completeness.missing.map(nice).join(', ')}. Everything here is optional — you choose what to share.` : 'Complete. You choose who sees each part.'}
        </T>
        <View style={{ marginTop: 10 }}>
          <Row label="Dominant side" value={a.dominant_side ? cap1(a.dominant_side) : '—'} scope={a.dominant_side ? sc.dominant_side ?? 'private' : null} />
          <Row label="Positions" value={a.positions.length ? a.positions.join(', ') : '—'} scope={a.positions.length ? sc.positions ?? 'private' : null} />
          <Row label="Preferences" value={a.play_prefs.length ? a.play_prefs.join(', ') : '—'} scope={a.play_prefs.length ? sc.play_prefs ?? 'private' : null} />
          <Row label="Affiliations" value={a.affiliations.length ? a.affiliations.map((x) => `✔ ${x.label}`).join('   ') : 'None verified yet'} scope={a.affiliations.length ? sc.affiliations ?? 'private' : null} />
        </View>
        <View style={{ marginTop: 10, alignItems: 'flex-start' }}><Btn small title="Edit athlete details" color={c.paper} onPress={() => setEdit(true)} /></View>
      </Card>

      <T weight="800" size={15} style={{ marginTop: 18 }}>Measurements</T>
      <T size={12} color={c.mute}>Optional and dated. Stored encrypted, private until you share a measurement, and you can withdraw it at any time.</T>
      <View style={{ gap: 8, marginTop: 8 }}>
        {live.map((m) => (
          <Card key={m.id} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <T weight="800" size={15}>{cap1(m.metric)}: {m.value} {m.unit}</T>
                <T size={12} color={c.mute}>{day(m.measured_on + 'T12:00:00')} · {SOURCES.find((s) => s.value === m.source)?.label}{m.note ? ` · ${m.note}` : ''}</T>
              </View>
              <T size={11.5} color={c.mute} weight="700">{SCOPE_LABEL[m.scope]}</T>
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {SCOPES.map((s) => <Chip key={s.value} label={s.label} active={m.scope === s.value} onPress={act(() => api.patch(`/me/measurements/${m.id}`, { scope: s.value }), 'Sharing updated')} />)}
              <Pressable hitSlop={8} onPress={act(() => api.post(`/me/measurements/${m.id}/revoke`), 'Withdrawn — kept privately')} style={{ justifyContent: 'center' }}><T size={13} weight="700" color={c.red}>Withdraw</T></Pressable>
            </View>
          </Card>
        ))}
        {!live.length ? <T size={13} color={c.mute}>No measurements recorded. Nothing is required.</T> : null}
        {revoked.map((m) => (
          <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={12.5} color={c.mute} style={{ flex: 1 }}>Withdrawn: {nice(m.metric)} {m.value} {m.unit} · {m.measured_on}</T>
            <Pressable hitSlop={8} onPress={act(() => api.post(`/me/measurements/${m.id}/restore`), 'Restored — still private')}><T size={13} weight="700">Restore</T></Pressable>
          </View>
        ))}
      </View>
      <View style={{ marginTop: 10, alignItems: 'flex-start' }}><Btn small title="+ Add measurement" color={c.paper} onPress={() => setAdding(true)} /></View>

      {edit ? (
        <FormSheet visible onClose={() => setEdit(false)} title="Athlete details" submitLabel="Save"
          initial={{ dominant_side: a.dominant_side ?? undefined, positions: open ? undefined : a.positions, positions_text: open ? a.positions.join(', ') : undefined, play_prefs: a.play_prefs,
            s_dominant_side: sc.dominant_side ?? 'private', s_positions: sc.positions ?? 'private', s_play_prefs: sc.play_prefs ?? 'private', s_affiliations: sc.affiliations ?? 'private' }}
          fields={[
            { key: 'dominant_side', label: 'Dominant side (foot / hand)', type: 'chips', options: SIDES, optional: true },
            open ? { key: 'positions_text', label: 'Positions you play (separate with commas)', optional: true } : { key: 'positions', label: 'Positions you play', type: 'multi', options: a.options.positions, optional: true },
            { key: 'play_prefs', label: 'How you like to play', type: 'multi', options: a.options.play_prefs, optional: true },
            { key: 'sec', label: 'Who can see what', type: 'section' },
            { key: 's_dominant_side', label: 'Dominant side', type: 'chips', options: SCOPES },
            { key: 's_positions', label: 'Positions', type: 'chips', options: SCOPES },
            { key: 's_play_prefs', label: 'Preferences', type: 'chips', options: SCOPES },
            { key: 's_affiliations', label: 'Verified affiliations', type: 'chips', options: SCOPES, hint: 'Teams and credentials already verified on Gotmygame.' },
          ]}
          onSubmit={async (v) => {
            const positions = open ? String(v.positions_text ?? '').split(',').map((x) => x.trim()).filter(Boolean) : v.positions ?? [];
            await api.patch(`/me/sport-profiles/${p.id}/athlete`, {
              dominant_side: v.dominant_side ?? null, positions, play_prefs: v.play_prefs ?? [],
              field_scopes: { dominant_side: v.s_dominant_side, positions: v.s_positions, play_prefs: v.s_play_prefs, affiliations: v.s_affiliations },
            });
            await reload();
            return 'Saved';
          }} />
      ) : null}
      {adding ? (
        <FormSheet visible onClose={() => setAdding(false)} title="Add a measurement" submitLabel="Save measurement"
          initial={{ metric: 'height', unit: 'cm', measured_on: new Date().toISOString().slice(0, 10), source: 'self', scope: 'private' }}
          fields={[
            { key: 'metric', label: 'What was measured', type: 'chips', options: a.options.metrics.map((m) => ({ value: m.metric, label: m.label })) },
            { key: 'unit', label: 'Unit', type: 'chips', options: (v) => (a.options.metrics.find((m) => m.metric === v.metric)?.units ?? ['cm']).map((u) => ({ value: u, label: u })) },
            { key: 'value', label: 'Value', type: 'number' },
            { key: 'measured_on', label: 'Measured on', type: 'date', max: new Date().toISOString().slice(0, 10) },
            { key: 'source', label: 'Who measured it', type: 'choice', options: SOURCES },
            { key: 'scope', label: 'Who can see it', type: 'chips', options: SCOPES },
          ]}
          onSubmit={async (v) => { await api.post(`/me/sport-profiles/${p.id}/measurements`, { ...v, value: Number(v.value) }); await reload(); return 'Measurement saved'; }} />
      ) : null}
    </View>
  );
}

/** Archived sport cards: their matches and history are kept, and restoring brings the card back as it was. */
export function ArchivedSports({ onRestored, refreshKey }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/sport-profiles/archived'), [refreshKey]);
  if (!list.data?.length) return null;
  return (
    <Card style={{ marginTop: 18 }}>
      <H2>Archived sports</H2>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>Your matches and history stay safe. Restore a sport to bring its card back.</T>
      {list.data.map((a) => (
        <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line, marginTop: 8 }}>
          <T size={22}>{a.sport_emoji}</T>
          <View style={{ flex: 1 }}>
            <T weight="800" size={14}>{a.sport}</T>
            <T size={12} color={c.mute}>{a.matches_kept} match{a.matches_kept === 1 ? '' : 'es'} kept · archived {day(a.archived_on + 'T12:00:00')}</T>
          </View>
          <Btn small title="Restore" color={c.paper} onPress={async () => { try { await api.post(`/me/sport-profiles/${a.id}/restore`); toast('Sport restored'); await list.reload(); await onRestored?.(); } catch (e) { toast(e.message); } }} />
        </View>
      ))}
    </Card>
  );
}
