// Developer Platform (#569): per-app console — Overview, Usage, Webhooks, Tokens, Settings.
import React, { useState } from 'react';
import { Alert, Clipboard, Platform, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, H2, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { t } from '../i18n';
import { c, grad, r } from '../theme';
import { LinearGradient } from 'expo-linear-gradient';

const copy = (v) => { try { Clipboard.setString(String(v)); } catch {} };
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

const PLATFORM_EVENT_TYPES = [
  'registration.created', 'registration.cancelled', 'registration.approved',
  'fixture.published', 'fixture.result_final', 'fixture.result_amended',
  'event.published', 'event.cancelled', 'event.rescheduled',
  'payment.completed', 'payment.refunded', 'ticket.scanned', 'ticket.sold',
  'supplier.award_confirmed', 'supplier.contract_signed',
  'organisation.member_joined', 'organisation.member_left',
];
const EVT_OPTS = PLATFORM_EVENT_TYPES.map((v) => ({ value: v, label: v }));

function MetricTile({ label, value, accent }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 12, padding: 12, alignItems: 'center' }}>
      <T size={24} weight="800" color={accent}>{value}</T>
      <T size={11} color={c.mute} style={{ textAlign: 'center', marginTop: 2 }}>{label}</T>
    </View>
  );
}

function UsageBar({ rows }) {
  if (!rows?.length) return <T size={12} color={c.mute}>{t('empty.nothing')}</T>;
  const max = Math.max(...rows.map((u) => (u.calls ?? 0) + (u.errors ?? 0) + (u.rate_refused ?? 0)), 1);
  const BAR_H = 56;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
        {rows.slice(0, 30).reverse().map((u) => {
          const total = (u.calls ?? 0) + (u.errors ?? 0) + (u.rate_refused ?? 0);
          const h = Math.max(2, Math.round((total / max) * BAR_H));
          const callH = Math.round(((u.calls ?? 0) / Math.max(total, 1)) * h);
          const errH = Math.round(((u.errors ?? 0) / Math.max(total, 1)) * h);
          const refH = h - callH - errH;
          const day = String(u.day ?? '').slice(5, 10);
          return (
            <View key={u.day} style={{ alignItems: 'center', gap: 2 }}>
              <View style={{ width: 18, height: BAR_H, justifyContent: 'flex-end' }}>
                {refH > 0 && <View style={{ height: refH, backgroundColor: c.sun, borderRadius: 2 }} />}
                {errH > 0 && <View style={{ height: errH, backgroundColor: c.red, borderRadius: 2 }} />}
                {callH > 0 && <View style={{ height: callH, backgroundColor: c.mint, borderRadius: 2 }} />}
              </View>
              <T size={9} color={c.mute}>{day}</T>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

function OverviewTab({ app, usage }) {
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <MetricTile label={t('dev.portal.calls_today')} value={app.calls_today ?? 0} accent={c.mint} />
        <MetricTile label={t('dev.portal.errors_today')} value={app.errors_today ?? 0} accent={c.red} />
        <MetricTile label={t('dev.app.active_webhooks')} value={app.active_webhooks ?? 0} accent={c.pink} />
        <MetricTile label={t('dev.app.active_tokens')} value={app.active_tokens ?? 0} accent={c.violet} />
      </View>
      <Card pad={14}>
        <T weight="700" size={13} style={{ marginBottom: 8 }}>{t('dev.app.tab_usage')} (30d)</T>
        <UsageBar rows={usage} />
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
          {[{ color: c.mint, label: 'Calls' }, { color: c.red, label: 'Errors' }, { color: c.sun, label: 'Rate limited' }].map(({ color, label }) => (
            <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
              <T size={10} color={c.mute}>{label}</T>
            </View>
          ))}
        </View>
      </Card>
      {app.client_id ? (
        <Card pad={14}>
          <T weight="700" size={13} style={{ marginBottom: 6 }}>Client ID</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T size={12} color={c.mute} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flex: 1 }} numberOfLines={1}>{app.client_id}</T>
            <Btn micro title={t('dev.app.copy_client_id')} onPress={() => copy(app.client_id)} color={c.pinkSoft} ink={c.pink} />
          </View>
          {app.client_secret_hint ? (
            <>
              <T weight="700" size={13} style={{ marginTop: 10, marginBottom: 4 }}>Client Secret</T>
              <T size={12} color={c.mute} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{app.client_secret_hint}</T>
              <T size={11} color={c.mute}>{t('dev.app.secret_hint_note')}</T>
            </>
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}

function UsageTab({ appId }) {
  const [data, err] = useLoad(() => api.call('get_developer_app_usage', { id: appId, days: 30 }), [appId]);
  if (err) return <ErrorBox message={err.message} />;
  if (!data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      {data.items?.map((row) => (
        <Card key={row.day} pad={12}>
          <T weight="700" size={13} style={{ marginBottom: 6 }}>{String(row.day).slice(0, 10)}</T>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            {[
              { label: t('dev.usage.calls'), val: row.calls ?? 0, color: c.mint },
              { label: t('dev.usage.errors'), val: row.errors ?? 0, color: c.red },
              { label: t('dev.usage.refused'), val: row.rate_refused ?? 0, color: c.sun },
              { label: 'Webhook fires', val: row.webhook_fires ?? 0, color: c.pink },
              { label: 'Webhook failures', val: row.webhook_failures ?? 0, color: c.orange },
            ].map(({ label, val, color }) => (
              <View key={label} style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                <T size={13} weight="700" color={color}>{val}</T>
                <T size={11} color={c.mute}>{label}</T>
              </View>
            ))}
          </View>
        </Card>
      ))}
    </View>
  );
}

function WebhookCard({ hook, appId, onDelete }) {
  const statusColor = hook.status === 'active' ? c.mint : hook.status === 'paused' ? c.sun : c.red;
  return (
    <Card pad={12} style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <T weight="700" size={13} style={{ flex: 1, marginRight: 8 }} numberOfLines={2}>{hook.url}</T>
        <Tag label={hook.status} color={statusColor === c.mint ? c.limeSoft : statusColor === c.sun ? c.sunSoft : c.redSoft} textColor={statusColor} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {(hook.event_types ?? []).map((et) => (
            <Tag key={et} label={et} color={c.pinkSoft} textColor={c.pink} small />
          ))}
        </View>
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, alignItems: 'center' }}>
        <T size={11} color={c.mute}>{t('dev.wh.last_success')}: {hook.last_success_at ? String(hook.last_success_at).slice(0, 16).replace('T', ' ') : '—'}</T>
        {hook.failure_count > 0 && <T size={11} color={c.red}>{hook.failure_count} {t('dev.wh.failures')}</T>}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Btn micro title={t('dev.wh.test')} color={c.pinkSoft} ink={c.pink}
          onPress={() => api.call('test_developer_webhook', { app_id: appId, id: hook.id })} />
        {hook.status === 'active' && (
          <Btn micro title={t('dev.wh.pause')} color={c.sunSoft} ink={c.sun}
            onPress={() => api.call('update_developer_webhook', { app_id: appId, id: hook.id, status: 'paused' })} />
        )}
        {hook.status === 'paused' && (
          <Btn micro title={t('dev.wh.resume')} color={c.limeSoft} ink={c.lime}
            onPress={() => api.call('update_developer_webhook', { app_id: appId, id: hook.id, status: 'active' })} />
        )}
        {hook.status !== 'revoked' && (
          <Btn micro title={t('dev.wh.delete')} color={c.redSoft} ink={c.red} onPress={() => onDelete(hook)} />
        )}
      </View>
    </Card>
  );
}

function AddWebhookSheet({ visible, appId, onClose, onCreated }) {
  const [url, setUrl] = useState('');
  const [eventTypes, setEventTypes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await api.call('create_developer_webhook', { app_id: appId, url, event_types: eventTypes });
      onCreated(res);
    } catch (e) { setErr(e?.message ?? t('error.generic')); }
    finally { setBusy(false); }
  };

  return (
    <FormSheet visible={visible} onClose={onClose} title={t('dev.wh.add')} busy={busy} submitLabel={t('dev.wh.add')} onSubmit={submit}>
      {err ? <ErrorBox message={err} /> : null}
      <FormSheet.Field label={t('dev.wh.url')} required>
        <FormSheet.Input value={url} onChangeText={setUrl} placeholder="https://yourserver.com/webhook" keyboardType="url" autoCapitalize="none" />
      </FormSheet.Field>
      <MenuField label={t('dev.wh.event_types')} options={EVT_OPTS} value={eventTypes} onChange={setEventTypes} multi placeholder={t('dev.wh.select_types')} />
    </FormSheet>
  );
}

function WebhooksTab({ appId }) {
  const [data, err, reload] = useLoad(() => api.call('list_developer_webhooks', { app_id: appId }), [appId]);
  const [showAdd, setShowAdd] = useState(false);
  const [secretInfo, setSecretInfo] = useState(null);

  const handleCreated = (hook) => {
    setShowAdd(false);
    if (hook.webhook_secret) setSecretInfo({ secret: hook.webhook_secret });
    reload();
  };

  const handleDelete = (hook) => {
    Alert.alert(t('dev.wh.delete'), t('dev.wh.delete_confirm'), [
      { text: t('action.cancel'), style: 'cancel' },
      { text: t('dev.wh.delete'), style: 'destructive', onPress: () => api.call('delete_developer_webhook', { app_id: appId, id: hook.id }).then(reload) },
    ]);
  };

  if (err) return <ErrorBox message={err.message} />;
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 10 }}>
        <Btn small title={`+ ${t('dev.wh.add')}`} color={c.pink} ink="#fff" onPress={() => setShowAdd(true)} />
      </View>
      {data == null ? <Loading /> : data.items?.length ? (
        data.items.map((h) => <WebhookCard key={h.id} hook={h} appId={appId} onDelete={handleDelete} />)
      ) : (
        <Empty title={t('dev.wh.empty_title')} body={t('dev.wh.empty_body')} cta={t('dev.wh.add')} onCta={() => setShowAdd(true)} />
      )}
      <AddWebhookSheet visible={showAdd} appId={appId} onClose={() => setShowAdd(false)} onCreated={handleCreated} />
      <Sheet visible={!!secretInfo} onClose={() => setSecretInfo(null)} title={t('dev.wh.secret_title')}>
        <View style={{ backgroundColor: c.bg, borderRadius: r.card, padding: 14, marginBottom: 12 }}>
          <T size={12} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: c.pink }} selectable>{secretInfo?.secret}</T>
        </View>
        <View style={{ backgroundColor: c.sunSoft, borderRadius: 10, padding: 12, marginBottom: 14 }}>
          <T size={13} color={c.sun}>{t('dev.wh.secret_warning')}</T>
        </View>
        <Btn title={t('dev.app.secret_copy')} onPress={() => copy(secretInfo?.secret)} color={c.pink} ink="#fff" full />
      </Sheet>
    </View>
  );
}

function TokensTab({ appId }) {
  const [data, err, reload] = useLoad(() => api.call('list_developer_app_tokens', { id: appId }), [appId]);
  const revoke = (tokenId) => {
    Alert.alert(t('dev.token.revoke'), t('dev.token.revoke_confirm'), [
      { text: t('action.cancel'), style: 'cancel' },
      { text: t('dev.token.revoke'), style: 'destructive', onPress: () => api.call('revoke_developer_app_token', { id: appId, token_id: tokenId }).then(reload) },
    ]);
  };
  if (err) return <ErrorBox message={err.message} />;
  return (
    <View>
      {data == null ? <Loading /> : data.items?.length ? (
        data.items.map((tok) => (
          <Card key={tok.id} pad={12} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <T size={12} color={c.mute}>{t('dev.token.user')}: {tok.user_id ?? '(service account)'}</T>
                <T size={11} color={c.mute}>{t('dev.token.scopes')}: {(tok.scopes ?? []).join(', ')}</T>
                <T size={11} color={c.mute}>{t('dev.token.last_used')}: {fmtDate(tok.last_used_at)}</T>
                <T size={11} color={c.mute}>{t('dev.token.expires')}: {fmtDate(tok.expires_at)}</T>
              </View>
              <Btn micro title={t('dev.token.revoke')} color={c.redSoft} ink={c.red} onPress={() => revoke(tok.id)} />
            </View>
          </Card>
        ))
      ) : (
        <Empty title={t('dev.token.empty_title')} body={t('dev.token.empty_body')} />
      )}
    </View>
  );
}

function SettingsTab({ app, onRevoked }) {
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description ?? '');
  const [busy, setBusy] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState(null);

  const save = async () => {
    setBusy(true);
    try { await api.call('update_developer_app', { id: app.id, name, description: description || undefined }); }
    catch {} finally { setBusy(false); }
  };

  const rotateSecret = async () => {
    Alert.alert(t('dev.app.rotate_secret'), t('dev.app.rotate_secret_confirm'), [
      { text: t('action.cancel'), style: 'cancel' },
      { text: t('dev.app.rotate_secret'), onPress: async () => {
        const res = await api.call('rotate_developer_app_secret', { id: app.id });
        setRotatedSecret(res.client_secret);
      }},
    ]);
  };

  const revokeApp = () => {
    Alert.alert(t('dev.app.revoke_app'), t('dev.app.revoke_confirm'), [
      { text: t('action.cancel'), style: 'cancel' },
      { text: t('dev.app.revoke_app'), style: 'destructive', onPress: async () => { await api.call('revoke_developer_app', { id: app.id }); onRevoked(); } },
    ]);
  };

  return (
    <View style={{ gap: 14 }}>
      <Card pad={14}>
        <T weight="700" size={14} style={{ marginBottom: 10 }}>{t('dev.app.settings_basic')}</T>
        <FormSheet.Field label={t('dev.app.name')}>
          <FormSheet.Input value={name} onChangeText={setName} />
        </FormSheet.Field>
        <FormSheet.Field label={t('dev.app.description')}>
          <FormSheet.Input value={description} onChangeText={setDescription} multiline numberOfLines={3} />
        </FormSheet.Field>
        <Btn title={t('action.save')} onPress={save} busy={busy} color={c.pink} ink="#fff" full />
      </Card>
      <Card pad={14}>
        <T weight="700" size={14} style={{ marginBottom: 6 }}>{t('dev.app.rotate_secret')}</T>
        <T size={13} color={c.mute} style={{ marginBottom: 10 }}>{t('dev.app.rotate_secret_body')}</T>
        <Btn title={t('dev.app.rotate_secret')} onPress={rotateSecret} color={c.sunSoft} ink={c.sun} />
      </Card>
      {app.status !== 'revoked' && (
        <Card pad={14} style={{ borderColor: c.red, borderWidth: 1 }}>
          <T weight="700" size={14} color={c.red} style={{ marginBottom: 6 }}>{t('dev.app.revoke_app')}</T>
          <T size={13} color={c.mute} style={{ marginBottom: 10 }}>{t('dev.app.revoke_body')}</T>
          <Btn title={t('dev.app.revoke_app')} onPress={revokeApp} color={c.redSoft} ink={c.red} />
        </Card>
      )}
      <Sheet visible={!!rotatedSecret} onClose={() => setRotatedSecret(null)} title={t('dev.app.secret_title')}>
        <View style={{ backgroundColor: c.bg, borderRadius: r.card, padding: 14, marginBottom: 12 }}>
          <T size={12} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: c.pink }} selectable>{rotatedSecret}</T>
        </View>
        <View style={{ backgroundColor: c.sunSoft, borderRadius: 10, padding: 12, marginBottom: 14 }}>
          <T size={13} color={c.sun}>{t('dev.app.secret_warning')}</T>
        </View>
        <Btn title={t('dev.app.secret_copy')} onPress={() => copy(rotatedSecret)} color={c.pink} ink="#fff" full />
      </Sheet>
    </View>
  );
}

export default function DeveloperAppDetail({ route }) {
  const appId = route?.params?.appId;
  const nav = useNav();
  const [tab, setTab] = useState('overview');
  const [app, appErr, reload] = useLoad(() => api.call('get_developer_app', { id: appId }), [appId]);

  if (appErr) return <Screen><ErrorBox message={appErr.message} /></Screen>;
  if (!app) return <Screen><Loading /></Screen>;

  const tabs = [
    { key: 'overview', label: t('dev.app.tab_overview') },
    { key: 'usage', label: t('dev.app.tab_usage') },
    { key: 'webhooks', label: t('dev.app.tab_webhooks') },
    { key: 'tokens', label: t('dev.app.tab_tokens') },
    { key: 'settings', label: t('dev.app.tab_settings') },
  ];

  return (
    <Screen>
      <View style={{ padding: 16, paddingBottom: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
          <T size={20} weight="800" style={{ flex: 1 }}>{app.name}</T>
          <Tag label={app.sandbox_mode ? t('dev.app.sandbox_badge') : t('dev.app.live_badge')}
            color={app.sandbox_mode ? c.sunSoft : c.pinkSoft}
            textColor={app.sandbox_mode ? c.sun : c.pink} />
        </View>
        <Seg value={tab} onChange={setTab} options={tabs} scrollable />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        {tab === 'overview' && <OverviewTab app={app} usage={app.usage_30d} />}
        {tab === 'usage' && <UsageTab appId={appId} />}
        {tab === 'webhooks' && <WebhooksTab appId={appId} />}
        {tab === 'tokens' && <TokensTab appId={appId} />}
        {tab === 'settings' && <SettingsTab app={app} onRevoked={() => { reload(); nav.goBack(); }} />}
      </ScrollView>
    </Screen>
  );
}
