// Guardian side of pickup & handover (#788): today's status per session (arrival, attendance and handover kept apart), confirm-or-stop a pickup,
// a rotating pickup QR, authorised collectors with limits, emergency contacts and standing departure permissions. Replaces the old name-only
// "Pickup & check-in" sheet in Family & guardians; team check-in history is kept. The API enforces every rule; this screen only calls it. All text uses t().
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { explain, LoadError } from '../access';
import { Btn, Card, Empty, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { QrCode } from './passport';
import { useRotating } from '../access-ui';
import { c } from '../theme';
import { locale } from '../locale';
import { relText } from './academy-safety';

const clock = (iso) => { try { return new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
const dayOf = (iso) => { try { return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; } };
const REL = ['parent', 'grandparent', 'sibling', 'relative', 'family_friend', 'neighbour', 'driver', 'transport_service', 'other'];
const modeText = (m) => (m === 'walks_home' ? t('pk.mode_walks') : m === 'transport' ? t('pk.mode_transport') : t('pk.mode_collected'));
const weekday = (d) => { try { return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, d))); } catch { return String(d); } };
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

function stateOf(x) {
  if (x.handover_state === 'handed_over') return { tone: c.pinkSoft, label: t('pk.g_handed'), line: t('pk.g_handed_line', { who: x.collector_name ?? t('pk.collector'), time: clock(x.handed_over_at) }) };
  if (x.handover_state === 'pending_confirmation') return { tone: c.sun, label: t('pk.g_pending'), line: t('pk.g_pending_line', { who: x.collector_name ?? t('pk.collector') }) };
  if (x.handover_state === 'disputed') return { tone: c.red, label: t('pk.g_stopped'), line: t('pk.g_stopped_line') };
  if (['present', 'late', 'left_early'].includes(x.attendance)) return { tone: c.mint, label: t('pk.g_in_care'), line: t('pk.g_in_care_line', { time: clock(x.ends_at) }) };
  return { tone: c.violetSoft, label: t('pk.g_expected'), line: t('pk.g_expected_line', { time: clock(x.starts_at) }) };
}

/** One session today: the family's whole picture, and the decision when somebody is collecting. */
function TodayCard({ child, x, onChange }) {
  const { toast } = useSession();
  const [qr, setQr] = useState(false);
  const st = stateOf(x);
  const decide = async (confirm) => { try { await api.post(`/youth/handovers/${x.handover_id}/confirm`, { confirm }); toast(confirm ? t('pk.g_confirmed') : t('pk.g_stop_done')); onChange(); } catch (e) { toast(explain(e)); } };
  return (
    <Card pad={14} color={x.handover_state === 'pending_confirmation' ? c.sunSoft : c.paper}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800">{x.title}</T><Tag label={st.label} color={st.tone} /></View>
      <T size={12} color={c.mute}>{x.organisation_name} · {clock(x.starts_at)}–{clock(x.ends_at)}</T>
      <T size={13} style={{ marginTop: 4 }}>{st.line}</T>
      {x.handover_state === 'pending_confirmation' ? (
        <View style={{ gap: 8, marginTop: 10 }}>
          <T weight="800">{t('pk.g_confirm_q', { who: x.collector_name ?? t('pk.collector'), name: child.display_name })}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn title={t('pk.g_yes')} onPress={() => decide(true)} style={{ flex: 1 }} /><Btn title={t('pk.g_no')} color={c.paper} ink={c.red} onPress={() => decide(false)} style={{ flex: 1 }} /></View>
        </View>
      ) : null}
      {['present', 'late'].includes(x.attendance) && !x.handover_state ? <Btn small title={t('pk.g_show_qr')} onPress={() => setQr(true)} style={{ alignSelf: 'flex-start', marginTop: 10 }} /> : null}
      {x.handover_state === 'awaiting' && ['present', 'late'].includes(x.attendance) ? <Btn small title={t('pk.g_show_qr')} onPress={() => setQr(true)} style={{ alignSelf: 'flex-start', marginTop: 10 }} /> : null}
      <QrSheet visible={qr} onClose={() => setQr(false)} sessionId={x.session_id} childId={child.id} />
    </Card>
  );
}

function QrSheet({ visible, onClose, sessionId, childId }) {
  const p = useRotating('/me/pickup-pass', { session_id: sessionId, child_id: childId }, visible);
  return (
    <Sheet visible={visible} onClose={onClose} title={t('pk.g_qr_title')}>
      <View style={{ alignItems: 'center', gap: 10 }}>
        {p.data ? <QrCode value={p.data.token} size={240} label={t('pk.g_qr_label')} /> : p.error ? <LoadError error={p.error} /> : <Loading />}
        <T weight="800" size={16}>{p.data?.subject?.label}</T>
        <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{t('pk.g_qr_help')}</T>
      </View>
    </Sheet>
  );
}

function limits(d) {
  const bits = [];
  if (d.weekdays?.length) bits.push(d.weekdays.map((n) => weekday(n === 7 ? 7 : n)).join(' '));   // 2024-01-01 is a Monday, so ISO day n is January n
  if (d.from_time && d.to_time) bits.push(`${String(d.from_time).slice(0, 5)}–${String(d.to_time).slice(0, 5)}`);
  if (d.one_time) bits.push(t('pk.g_one_time'));
  if (d.has_passphrase) bits.push(t('pk.g_phrase_set'));
  bits.push(t('pk.g_until', { date: dayOf(d.expires_at) }));
  return bits.join(' · ');
}

export function PickupSheet({ child, onClose }) {
  const { toast } = useSession();
  const ov = useLoad(() => (child ? api.get(`/youth/children/${child.id}/pickup`) : Promise.resolve(null)), [child?.id]);
  const dl = useLoad(() => (child ? api.get(`/youth/children/${child.id}/pickup-delegates`, { limit: 100 }) : Promise.resolve([])), [child?.id]);
  const hist = useLoad(() => (child ? api.get('/youth/check-ins', { child_id: child.id, limit: 10 }) : Promise.resolve([])), [child?.id]);
  const [add, setAdd] = useState(false);
  const [modes, setModes] = useState(false);
  useEffect(() => { if (!child) return undefined; const id = setInterval(() => ov.reload?.(), 20000); return () => clearInterval(id); }, [child?.id]);
  const reload = () => { ov.reload(); dl.reload(); };
  const o = ov.data;
  const live = (dl.data ?? []).filter((d) => d.listed);
  const emergency = live.filter((d) => d.is_emergency);
  const academies = o?.academies ?? [];
  const revoke = async (d) => { try { await api.del(`/youth/pickup-delegates/${d.id}`); toast(t('pk.g_revoked')); reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Sheet visible={!!child} onClose={onClose} title={child ? t('pk.g_title', { name: child.display_name }) : ''}>
      <T size={13} color={c.mute}>{t('pk.g_intro')}</T>
      {ov.error ? <LoadError error={ov.error} onRetry={ov.reload} /> : !o ? <Loading /> : (
        <>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Tag label={t('pk.g_n_collectors', { n: o.collectors })} color={o.collectors ? c.mint : c.sun} /><Tag label={t('pk.g_n_emergency', { n: o.emergency })} color={o.emergency ? c.mint : c.sun} />
            {o.expiring ? <Tag label={t('pk.g_n_expiring', { n: o.expiring })} color={c.sun} /> : null}
          </View>
          <T weight="800" size={13}>{t('pk.g_today')}</T>
          {o.today.length ? o.today.map((x) => <TodayCard key={x.session_id} child={child} x={x} onChange={reload} />) : <Empty emoji="🏟️" title={t('pk.g_today_empty_title')} sub={t('pk.g_today_empty_sub')} />}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T weight="800" size={13}>{t('pk.g_collectors')}</T><Btn small title={t('pk.g_add')} onPress={() => setAdd(true)} />
          </View>
          {dl.loading && !dl.data ? <Loading /> : live.length ? live.map((d) => (
            <Row key={d.id} title={`${d.delegate_display_name ?? d.delegate_name ?? t('pk.unnamed')}${d.relationship ? ` · ${relText(d.relationship)}` : ''}`}
              sub={`${[d.can_collect ? t('pk.g_can_collect') : null, d.is_emergency ? t('pk.g_is_emergency') : null].filter(Boolean).join(' + ')} · ${limits(d)}`}
              right={<Btn small title={t('pk.g_revoke')} color={c.paper} ink={c.red} onPress={() => revoke(d)} accessibilityLabel={t('pk.g_revoke_a11y', { name: d.delegate_display_name ?? d.delegate_name ?? '' })} />} />
          )) : <Empty emoji="🚸" title={t('pk.g_none_title')} sub={t('pk.g_none_sub')} />}
          {emergency.length ? <T size={12} color={c.mute}>{t('pk.g_emergency_order')}</T> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T weight="800" size={13}>{t('pk.g_departure')}</T><Btn small title={t('pk.g_departure_edit')} color={c.violet} onPress={() => setModes(true)} />
          </View>
          <T size={13} color={c.mute}>{o.departure_modes.length ? o.departure_modes.map((m) => modeText(m.mode)).join(' · ') : t('pk.g_departure_none')}</T>
          <T weight="800" size={13}>{t('pk.g_history')}</T>
          {hist.data?.length ? hist.data.map((h) => <T key={h.id} size={12} color={c.mute}>{new Date(h.at).toLocaleString(locale)} · {h.kind === 'drop_off' ? t('pk.g_arrived') : t('pk.g_collected')}</T>) : <T size={12} color={c.mute}>{t('pk.g_history_empty')}</T>}
        </>
      )}
      <FormSheet visible={add} onClose={() => setAdd(false)} title={t('pk.g_add_title')} submitLabel={t('pk.g_add_submit')}
        initial={{ can_collect: true, is_emergency: false, valid_days: 30, one_time: false }}
        fields={[
          { key: 'delegate_user_id', label: t('pk.f_person'), type: 'entity', entityKind: 'person', noun: t('pk.f_person_noun'), optional: true, hint: t('pk.f_person_hint') },
          { key: 'delegate_name', label: t('pk.f_name'), optional: true, hint: t('pk.f_name_hint') },
          { key: 'relationship', label: t('pk.f_relationship'), type: 'chips', options: REL.map((r) => ({ value: r, label: relText(r) })), optional: true },
          { key: 'phone', label: t('pk.f_phone'), input: 'phone', optional: true, hint: t('pk.f_phone_hint') },
          { key: 'can_collect', label: t('pk.f_can_collect'), type: 'switch' },
          { key: 'is_emergency', label: t('pk.f_emergency'), type: 'switch' },
          { key: 'valid_days', label: t('pk.f_valid'), type: 'stepper', min: 1, max: 90, default: 30, suffix: ` ${t('pk.days')}`, hint: t('pk.f_valid_hint') },
          { key: 'weekdays', label: t('pk.f_weekdays'), type: 'weekdays', optional: true, hint: t('pk.f_weekdays_hint') },
          { key: 'from_time', label: t('pk.f_from'), type: 'time', optional: true },
          { key: 'to_time', label: t('pk.f_to'), type: 'time', optional: true },
          { key: 'one_time', label: t('pk.f_one_time'), type: 'switch', hint: t('pk.f_one_time_hint') },
          { key: 'passphrase', label: t('pk.f_phrase'), type: 'secret', optional: true, hint: t('pk.f_phrase_hint') },
          ...(academies.length > 1 ? [{ key: 'organisation_id', label: t('pk.f_academy'), type: 'chips', optional: true, options: [{ value: '', label: t('pk.f_all_academies') }, ...academies.map((a) => ({ value: a.id, label: a.name }))] }] : []),
        ]}
        onSubmit={async (v) => {
          if (!v.delegate_user_id && !v.delegate_name) throw new Error(t('pk.f_need_who'));
          if (!v.can_collect && !v.is_emergency) throw new Error(t('pk.f_need_role'));
          if (!!v.from_time !== !!v.to_time) throw new Error(t('pk.f_need_both_times'));
          const days = Array.isArray(v.weekdays) && v.weekdays.length && v.weekdays.length < 7 ? v.weekdays.map((d) => (d === 0 ? 7 : d)) : undefined;   // the picker uses Sunday = 0, the API ISO 1-7
          await api.post(`/youth/children/${child.id}/pickup-delegates`, {
            delegate_user_id: v.delegate_user_id || undefined, delegate_name: v.delegate_name || undefined, relationship: v.relationship || undefined, phone: v.phone || undefined, can_collect: !!v.can_collect, is_emergency: !!v.is_emergency,
            valid_days: v.can_collect ? v.valid_days : Math.max(v.valid_days, 365), weekdays: days, from_time: v.from_time || undefined, to_time: v.to_time || undefined, timezone: deviceZone(), one_time: !!v.one_time,
            passphrase: v.passphrase || undefined, organisation_id: v.organisation_id || undefined,
          });
          reload();
          return t('pk.g_added');
        }} />
      <FormSheet visible={modes} onClose={() => setModes(false)} title={t('pk.g_departure')} submitLabel={t('common.save')}
        initial={{ walks_home: o?.departure_modes?.some((m) => m.mode === 'walks_home') ?? false, transport: o?.departure_modes?.some((m) => m.mode === 'transport') ?? false }}
        fields={[
          { key: 'walks_home', label: t('pk.mode_walks'), type: 'switch', hint: t('pk.g_walks_hint') },
          { key: 'transport', label: t('pk.mode_transport'), type: 'switch', hint: t('pk.g_transport_hint') },
        ]}
        onSubmit={async (v) => { await api.post(`/youth/children/${child.id}/departure-modes`, { modes: [v.walks_home ? 'walks_home' : null, v.transport ? 'transport' : null].filter(Boolean) }); reload(); return t('pk.g_departure_saved'); }} />
    </Sheet>
  );
}

/** At the top of Family & guardians: any pickup waiting for this guardian's confirmation, across every child, so it cannot be missed. */
export function PendingHandovers({ links }) {
  const kids = (links ?? []).filter((l) => l.my_side === 'guardian' && l.status === 'active').map((l) => l.child);
  const key = kids.map((k) => k.id).join(',');
  const d = useLoad(() => Promise.all(kids.map((k) => api.get(`/youth/children/${k.id}/pickup`).then((o) => o.pending_confirmation.map((p) => ({ ...p, child: k }))).catch(() => []))).then((x) => x.flat()), [key]);
  useEffect(() => { if (!kids.length) return undefined; const id = setInterval(() => d.reload?.(), 20000); return () => clearInterval(id); }, [key]);
  if (!d.data?.length) return null;
  return <View style={{ gap: 8, marginVertical: 8 }}>{d.data.map((x) => <TodayCard key={x.handover_id} child={x.child} x={x} onChange={d.reload} />)}</View>;
}
