// Developer Portal (#569): Developer Platform hub — register apps, view usage, access docs.
import React, { useState } from 'react';
import { Clipboard, Linking, Platform, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, H1, H2, Loading, Screen, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { t } from '../i18n';
import { c, grad, r } from '../theme';
import { LinearGradient } from 'expo-linear-gradient';

const SCOPE_OPTS = [
  { value: 'read', label: t('dev.scope.read') },
  { value: 'write', label: t('dev.scope.write') },
  { value: 'payment', label: t('dev.scope.payment') },
];
const copy = (v) => { try { Clipboard.setString(String(v)); } catch {} };

function HeroPanel() {
  return (
    <LinearGradient colors={grad.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={{ borderRadius: r.card, padding: 20, marginBottom: 16 }}>
      <T size={22} weight="800" color="#fff" style={{ marginBottom: 4 }}>{t('dev.portal.title')}</T>
      <T size={14} color="rgba(255,255,255,0.78)" style={{ marginBottom: 14 }}>{t('dev.portal.subtitle')}</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Tag label={t('dev.portal.api_first')} color="rgba(255,255,255,0.22)" textColor="#fff" />
        <Tag label={t('dev.portal.oauth2')} color="rgba(255,255,255,0.22)" textColor="#fff" />
        <Tag label={t('dev.portal.webhooks')} color="rgba(255,255,255,0.22)" textColor="#fff" />
        <Tag label={t('dev.portal.sandbox')} color="rgba(255,255,255,0.22)" textColor="#fff" />
      </View>
    </LinearGradient>
  );
}

function AppCard({ app, onPress }) {
  const statusColor = app.status === 'active' ? c.mint : app.status === 'suspended' ? c.sun : c.red;
  const sandboxBg = app.sandbox_mode ? c.sunSoft : c.pinkSoft;
  const sandboxColor = app.sandbox_mode ? c.sun : c.pink;
  return (
    <Card pad={14} style={{ marginBottom: 10 }} onPress={onPress} accessibilityLabel={`${app.name} developer app`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <T weight="700" size={16}>{app.name}</T>
          {app.description ? <T size={13} color={c.mute} numberOfLines={1}>{app.description}</T> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Tag label={app.sandbox_mode ? t('dev.app.sandbox_badge') : t('dev.app.live_badge')} color={sandboxBg} textColor={sandboxColor} />
          <Tag label={app.status} color={statusColor === c.mint ? c.limeSoft : statusColor === c.sun ? c.sunSoft : c.redSoft} textColor={statusColor} />
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <T size={11} color={c.mute} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flex: 1 }} numberOfLines={1}>{app.client_id}</T>
        <Btn micro title={t('dev.app.copy_client_id')} onPress={() => copy(app.client_id)} color={c.pinkSoft} ink={c.pink} />
      </View>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        <MetricTile label={t('dev.portal.calls_today')} value={app.calls_today ?? 0} accent={c.mint} />
        <MetricTile label={t('dev.portal.errors_today')} value={app.errors_today ?? 0} accent={c.red} />
        <MetricTile label={t('dev.portal.webhooks_today')} value={app.webhook_fires_today ?? 0} accent={c.pink} />
      </View>
    </Card>
  );
}

function MetricTile({ label, value, accent }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 10, padding: 8, alignItems: 'center' }}>
      <T size={20} weight="800" color={accent}>{value}</T>
      <T size={10} color={c.mute} style={{ textAlign: 'center' }}>{label}</T>
    </View>
  );
}

function QuickLinks() {
  const links = [
    { key: 'dev.portal.docs_link', url: 'https://docs.gotmygame.com/api' },
    { key: 'dev.portal.oauth_guide', url: 'https://docs.gotmygame.com/api/oauth' },
    { key: 'dev.portal.webhook_ref', url: 'https://docs.gotmygame.com/api/webhooks' },
    { key: 'dev.portal.sandbox_guide', url: 'https://docs.gotmygame.com/api/sandbox' },
  ];
  return (
    <View style={{ marginTop: 12 }}>
      <H2>{t('dev.portal.quick_links')}</H2>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {links.map(({ key, url }) => (
          <Btn key={key} small title={t(key)} color={c.pinkSoft} ink={c.pink}
            onPress={() => Linking.openURL(url)} accessibilityLabel={`${t(key)} - opens in browser`} />
        ))}
      </View>
    </View>
  );
}

function RegisterAppSheet({ visible, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [redirectUris, setRedirectUris] = useState('');
  const [scopes, setScopes] = useState(['read']);
  const [sandbox, setSandbox] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const uris = redirectUris.split('\n').map((s) => s.trim()).filter(Boolean);
      const res = await api.call('create_developer_app', { name, description: description || undefined, website_url: websiteUrl || undefined, redirect_uris: uris, allowed_scopes: scopes, sandbox_mode: sandbox });
      onCreated(res);
    } catch (e) { setErr(e?.message ?? t('error.generic')); }
    finally { setBusy(false); }
  };

  return (
    <FormSheet visible={visible} onClose={onClose} title={t('dev.app.create_title')} busy={busy}
      submitLabel={t('dev.portal.register_app')} onSubmit={submit}>
      {err ? <ErrorBox message={err} /> : null}
      <FormSheet.Field label={t('dev.app.name')} required>
        <FormSheet.Input value={name} onChangeText={setName} placeholder={t('dev.app.name_placeholder')} maxLength={120} />
      </FormSheet.Field>
      <FormSheet.Field label={t('dev.app.description')}>
        <FormSheet.Input value={description} onChangeText={setDescription} multiline numberOfLines={3} maxLength={1000} />
      </FormSheet.Field>
      <FormSheet.Field label={t('dev.app.website')}>
        <FormSheet.Input value={websiteUrl} onChangeText={setWebsiteUrl} placeholder="https://" keyboardType="url" autoCapitalize="none" />
      </FormSheet.Field>
      <FormSheet.Field label={t('dev.app.redirect_uris')} hint={t('dev.app.redirect_uris_hint')}>
        <FormSheet.Input value={redirectUris} onChangeText={setRedirectUris} multiline numberOfLines={3} placeholder="https://yourapp.com/callback" autoCapitalize="none" />
      </FormSheet.Field>
      <MenuField label={t('dev.app.allowed_scopes')} options={SCOPE_OPTS} value={scopes} onChange={setScopes} multi />
      <FormSheet.Field label={t('dev.app.sandbox')}>
        <FormSheet.Switch value={sandbox} onValueChange={setSandbox} hint={t('dev.app.sandbox_hint')} />
      </FormSheet.Field>
    </FormSheet>
  );
}

function SecretSheet({ visible, app, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!app) return null;
  const doCopy = () => { copy(app.client_secret); setCopied(true); };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('dev.app.secret_title')}>
      <View style={{ backgroundColor: c.bg, borderRadius: r.card, padding: 16, marginBottom: 16 }}>
        <T size={13} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: c.pink, letterSpacing: 0.5 }} selectable>{app.client_secret}</T>
      </View>
      <View style={{ backgroundColor: c.sunSoft, borderRadius: 10, padding: 12, marginBottom: 16, flexDirection: 'row', gap: 10 }}>
        <T size={18}>⚠️</T>
        <T size={13} color={c.sun} style={{ flex: 1 }}>{t('dev.app.secret_warning')}</T>
      </View>
      <Btn title={copied ? t('dev.app.secret_copied') : t('dev.app.secret_copy')} onPress={doCopy} color={c.pink} ink="#fff" full />
    </Sheet>
  );
}

export default function DeveloperPortal() {
  const nav = useNav();
  const [apps, appsErr, reload] = useLoad(() => api.call('list_developer_apps', {}), []);
  const [showRegister, setShowRegister] = useState(false);
  const [newApp, setNewApp] = useState(null);
  const [showSecret, setShowSecret] = useState(false);

  const handleCreated = (app) => {
    setShowRegister(false);
    setNewApp(app);
    setShowSecret(true);
    reload();
  };

  if (appsErr) return <Screen><ErrorBox message={appsErr.message} /></Screen>;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <HeroPanel />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <H2>{t('dev.portal.my_apps')}</H2>
          <Btn title={`+ ${t('dev.portal.register_app')}`} color={c.pink} ink="#fff" onPress={() => setShowRegister(true)} accessibilityLabel={t('dev.portal.register_app')} />
        </View>
        {apps == null ? <Loading /> : apps.items?.length ? (
          apps.items.map((app) => (
            <AppCard key={app.id} app={app} onPress={() => nav.push('DeveloperAppDetail', { appId: app.id })} />
          ))
        ) : (
          <Empty title={t('dev.portal.empty_title')} body={t('dev.portal.empty_body')} cta={t('dev.portal.register_app')} onCta={() => setShowRegister(true)} />
        )}
        <QuickLinks />
      </ScrollView>
      <RegisterAppSheet visible={showRegister} onClose={() => setShowRegister(false)} onCreated={handleCreated} />
      <SecretSheet visible={showSecret} app={newApp} onClose={() => setShowSecret(false)} />
    </Screen>
  );
}
