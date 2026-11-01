// Travel channel partners (#704): the platform admin connects hotel / flight partners (online travel sites or gateways) per region. Lives as a tab of the
// platform admin's integration screen (no separate console). The UI only calls /admin/travel-partners; the server enforces platform-admin-only access.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { t } from '../i18n';
import { c } from '../theme';

const wrap = { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const KIND = (k) => (k === 'stay' ? t('tpart.stays') : t('tpart.flights'));
const TONE = { active: c.mint, paused: c.sun, archived: c.violetSoft };

export function TravelPartnersAdmin() {
  const { toast } = useSession();
  const st = useLoad(() => api.get('/admin/travel-partners'), []);
  const [create, setCreate] = useState(false), [edit, setEdit] = useState(null), [secret, setSecret] = useState(null);
  const act = async (fn, msg) => { try { const r = await fn(); await st.reload(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); return r; } catch (e) { toast(e.message); return null; } };
  if (st.loading && !st.data) return <Loading />;
  if (st.error) return <ErrorBox error={st.error} onRetry={st.reload} />;
  const { items, presets } = st.data;
  const kindsOf = (preset) => presets.find((p) => p.key === preset)?.kinds ?? ['stay', 'air'];
  const conn = (v) => (v.api_key ? { url: v.url, ...(v.sandbox_url ? { sandbox_url: v.sandbox_url } : {}), api_key: v.api_key } : undefined);
  const shared = (v) => [
    { key: 'kinds', label: t('tpart.supplies'), type: 'multi', options: kindsOf(v.preset ?? 'other').map((k) => ({ value: k, label: KIND(k) })) },
    { key: 'regions', label: t('tpart.regions'), type: 'countries', optional: true, hint: t('tpart.regions_hint') },
    { key: 'mode', label: t('tpart.mode'), type: 'chips', options: [{ value: 'live', label: t('tpart.live') }, { value: 'sandbox', label: t('tpart.sandbox') }] },
    { key: 'priority', label: t('tpart.priority'), type: 'stepper', min: 1, max: 1000, step: 10, default: 100 },
  ];
  const credFields = (optional) => [
    { key: 'url', label: t('tpart.api_url'), type: 'text', optional, show: (v) => v.preset !== 'sandbox' },
    { key: 'sandbox_url', label: t('tpart.sandbox_url'), type: 'text', optional: true, show: (v) => v.preset !== 'sandbox' },
    { key: 'api_key', label: t('tpart.api_key'), type: 'secret', optional, show: (v) => v.preset !== 'sandbox' },
  ];
  return (
    <View style={{ gap: 12 }}>
      <View style={wrap}><View style={{ flex: 1, minWidth: 200 }}><T weight="800" size={17}>{t('tpart.title')}</T><T size={12.5} color={c.mute}>{t('tpart.sub')}</T></View>
        <Btn small title={t('tpart.add')} accessibilityLabel={t('tpart.add')} onPress={() => setCreate(true)} /></View>
      {!items.length ? <Empty emoji="🏨" title={t('tpart.empty')} sub={t('tpart.empty_sub')} /> : items.map((p) => (
        <Card key={p.id} pad={14} accessibilityLabel={`${p.label}, ${p.preset_name}, ${t(`tpart.status.${p.status}`)}`}>
          <View style={wrap}><T weight="800" size={16} style={{ flex: 1 }}>{p.label}</T><Tag label={t(`tpart.status.${p.status}`)} color={TONE[p.status]} /></View>
          <T size={13} color={c.mute}>{p.preset_name} · {p.kinds.map(KIND).join(' + ')} · {p.mode === 'live' ? t('tpart.live') : t('tpart.sandbox')}</T>
          <T size={13} style={{ marginTop: 4 }}>{p.worldwide ? t('tpart.worldwide') : p.regions.join(', ')}</T>
          <T size={12} color={p.last_error ? c.red : c.mute}>{p.last_error ? t('tpart.last_error', { e: p.last_error }) : p.last_ok_at ? t('tpart.last_ok', { when: new Date(p.last_ok_at).toLocaleString() }) : t('tpart.never_tested')}</T>
          <View style={[wrap, { marginTop: 10 }]}>
            <Btn small color={c.paper} ink={c.ink} title={t('tpart.test')} accessibilityLabel={`${t('tpart.test')}: ${p.label}`} onPress={() => act(() => api.post(`/admin/travel-partners/${p.id}/test`), (r) => (r.ok ? t('tpart.test_ok') : r.message))} />
            <Btn small color={c.paper} ink={c.ink} title={t('tpart.edit')} accessibilityLabel={`${t('tpart.edit')}: ${p.label}`} onPress={() => setEdit(p)} />
            {p.status !== 'archived' ? <Btn small color={c.paper} ink={c.ink} title={p.status === 'active' ? t('tpart.pause') : t('tpart.resume')} accessibilityLabel={`${p.status === 'active' ? t('tpart.pause') : t('tpart.resume')}: ${p.label}`} onPress={() => act(() => api.patch(`/admin/travel-partners/${p.id}`, { status: p.status === 'active' ? 'paused' : 'active' }), t('tpart.saved'))} /> : null}
            {p.status !== 'archived' ? <Btn small color={c.paper} ink={c.red} title={t('tpart.archive')} accessibilityLabel={`${t('tpart.archive')}: ${p.label}`} onPress={() => act(() => api.patch(`/admin/travel-partners/${p.id}`, { status: 'archived' }), t('tpart.saved'))} /> : <Btn small title={t('tpart.resume')} onPress={() => act(() => api.patch(`/admin/travel-partners/${p.id}`, { status: 'active' }), t('tpart.saved'))} />}
          </View>
        </Card>))}

      <FormSheet visible={create} onClose={() => setCreate(false)} title={t('tpart.add')} submitLabel={t('tpart.connect')} initial={{ preset: 'booking_com', kinds: ['stay'], regions: [], mode: 'live', priority: 100 }}
        notice={t('tpart.contract_note')}
        fields={[{ key: 'preset', label: t('tpart.site'), type: 'chips', options: presets.map((p) => ({ value: p.key, label: p.name })) }, { key: 'label', label: t('tpart.name'), type: 'text' }, ...shared({}).map((f) => (f.key === 'kinds' ? { ...f, options: (v) => kindsOf(v.preset).map((k) => ({ value: k, label: KIND(k) })) } : f)), ...credFields(false)]}
        onSubmit={async (v) => {
          const r = await api.post('/admin/travel-partners', { label: v.label, preset: v.preset, kinds: v.kinds.filter((k) => kindsOf(v.preset).includes(k)), regions: v.regions ?? [], mode: v.preset === 'sandbox' ? 'sandbox' : v.mode, priority: v.priority, connection: conn(v) });
          await st.reload(); setSecret(r); return t('tpart.saved');
        }} />

      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.label ?? ''} submitLabel={t('common.save')} notice={t('tpart.creds_note')}
        initial={edit ? { label: edit.label, kinds: edit.kinds, regions: edit.regions, mode: edit.mode, priority: edit.priority, preset: edit.preset } : {}}
        fields={[{ key: 'label', label: t('tpart.name'), type: 'text' }, ...shared({ preset: edit?.preset }), ...credFields(true), { key: 'rotate', label: t('tpart.rotate'), type: 'switch', optional: true }]}
        onSubmit={async (v) => {
          const r = await api.patch(`/admin/travel-partners/${edit.id}`, { label: v.label, kinds: v.kinds, regions: v.regions ?? [], mode: edit.provider_key === 'travel_sandbox' ? undefined : v.mode, priority: v.priority, connection: conn(v), rotate_webhook_secret: !!v.rotate });
          await st.reload(); if (r.webhook_secret) setSecret(r); return t('tpart.saved');
        }} />

      <Sheet visible={!!secret} onClose={() => setSecret(null)} title={t('tpart.secret_title')}>
        {secret ? <View style={{ gap: 10 }}>
          <T size={13}>{t('tpart.secret_note')}</T>
          <T weight="800" selectable accessibilityLabel={t('tpart.secret_title')}>{secret.webhook_secret}</T>
          <T size={12} color={c.mute}>{t('tpart.callback')}: {secret.webhook_path}</T>
          <Btn title={t('tpart.done')} onPress={() => setSecret(null)} />
        </View> : null}
      </Sheet>
    </View>
  );
}
