// Developer Platform (#569): OAuth consent screen — shown when a third-party app requests access.
// Deep-linked from /oauth/authorize?... . Renders app info + scope list; user taps Allow or Deny.
import React, { useEffect, useState } from 'react';
import { Image, Linking, Platform, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useNav } from '../nav';
import { Btn, Card, ErrorBox, Loading, Screen, T, Tag } from '../ui';
import { t } from '../i18n';
import { c, grad, r } from '../theme';
import { LinearGradient } from 'expo-linear-gradient';

const SCOPE_DESC = {
  read: 'dev.scope.read_desc',
  write: 'dev.scope.write_desc',
  payment: 'dev.scope.payment_desc',
  clinical: 'dev.scope.clinical_desc',
};
const SCOPE_WARN = {
  write: 'oauth.warning_write',
  payment: 'oauth.warning_payment',
  clinical: 'oauth.warning_clinical',
};
const SCOPE_ICON = { read: '👁', write: '✏️', payment: '💳', clinical: '🏥' };

function ScopeRow({ scope }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
      <T size={20}>{SCOPE_ICON[scope] ?? '🔑'}</T>
      <View style={{ flex: 1 }}>
        <T weight="700" size={14}>{scope}</T>
        <T size={13} color={c.mute}>{t(SCOPE_DESC[scope] ?? 'dev.scope.read_desc')}</T>
      </View>
    </View>
  );
}

function WarningBanner({ scopes }) {
  const warns = scopes.filter((s) => SCOPE_WARN[s]);
  if (!warns.length) return null;
  return (
    <View style={{ backgroundColor: c.sunSoft, borderRadius: 12, padding: 14, gap: 4, marginBottom: 14 }}>
      {warns.map((s) => (
        <View key={s} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <T size={16}>⚠️</T>
          <T size={13} color={c.sun} style={{ flex: 1 }}>{t(SCOPE_WARN[s])}</T>
        </View>
      ))}
    </View>
  );
}

export default function OAuthConsent({ route }) {
  const nav = useNav();
  const params = route?.params ?? {};
  const { client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method } = params;

  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!client_id) { setErr(t('oauth.invalid_client')); return; }
    api.call('oauth_authorize', { client_id, redirect_uri, response_type: response_type ?? 'code', scope, state, code_challenge, code_challenge_method })
      .then(setInfo).catch((e) => setErr(e?.message ?? t('error.generic')));
  }, [client_id]);

  const deny = () => {
    const params = new URLSearchParams({ error: 'access_denied' });
    if (state) params.set('state', state);
    const url = `${redirect_uri}?${params}`;
    if (Platform.OS === 'web') { window.location.href = url; }
    else { Linking.openURL(url); nav.goBack(); }
  };

  const allow = async () => {
    setBusy(true);
    try {
      const res = await api.call('oauth_consent', { client_id, redirect_uri, response_type: response_type ?? 'code', scope, state, code_challenge, code_challenge_method });
      if (Platform.OS === 'web') { window.location.href = res.redirect_to; }
      else { Linking.openURL(res.redirect_to); nav.goBack(); }
    } catch (e) {
      setErr(e?.message ?? t('error.generic'));
      setBusy(false);
    }
  };

  if (!client_id) return <Screen><ErrorBox message={t('oauth.invalid_client')} /></Screen>;
  if (err) return <Screen><ErrorBox message={err} /></Screen>;
  if (!info) return <Screen><Loading /></Screen>;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20 }} showsVerticalScrollIndicator={false}>
        <LinearGradient colors={grad.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={{ borderRadius: r.card, padding: 20, alignItems: 'center', marginBottom: 20 }}>
          {info.app.logo_url ? (
            <Image source={{ uri: info.app.logo_url }} style={{ width: 56, height: 56, borderRadius: 14, marginBottom: 12 }} />
          ) : (
            <View style={{ width: 56, height: 56, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center', marginBottom: 12 }}>
              <T size={28}>🔗</T>
            </View>
          )}
          <T size={18} weight="800" color="#fff" style={{ textAlign: 'center' }}>{info.app.name}</T>
          <T size={14} color="rgba(255,255,255,0.78)" style={{ textAlign: 'center', marginTop: 4 }}>{t('oauth.wants_access')}</T>
          {info.sandbox_mode && <Tag label="Sandbox" color="rgba(255,255,255,0.22)" textColor="#fff" style={{ marginTop: 8 }} />}
        </LinearGradient>

        <Card pad={16} style={{ marginBottom: 16 }}>
          <T weight="700" size={15} style={{ marginBottom: 8 }}>{t('oauth.permissions_requested')}</T>
          {info.scopes.map((s) => <ScopeRow key={s} scope={s} />)}
        </Card>

        <WarningBanner scopes={info.scopes} />

        <Card pad={14} style={{ marginBottom: 20, backgroundColor: c.bg }}>
          <T size={12} color={c.mute}>{t('oauth.revoke_note')}</T>
          {info.app.website_url ? (
            <T size={12} color={c.pink} style={{ marginTop: 4 }} onPress={() => Linking.openURL(info.app.website_url)}>{info.app.website_url}</T>
          ) : null}
        </Card>

        <View style={{ gap: 10, marginTop: 'auto', paddingBottom: 20 }}>
          <Btn title={t('oauth.allow')} onPress={allow} busy={busy} color={c.pink} ink="#fff" full
            accessibilityLabel={t('oauth.allow')} />
          <Btn title={t('oauth.deny')} onPress={deny} color={c.bg} ink={c.mute} full
            accessibilityLabel={t('oauth.deny')} />
        </View>
      </ScrollView>
    </Screen>
  );
}
