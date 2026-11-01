// Payments tab of the Commercial console (#694) — platform admin only. Switch each payment method on or off, country by country.
// The server decides who may do this (403 for everyone else) and every module that takes payment reads the same switches.
import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Card, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { CountryPicker, countryName } from '../country-picker';
import { t } from '../i18n';
import { c } from '../theme';

const METHOD_ICON = { card: '💳', paypal: '🅿️', upi: '📲', netbanking: '🏦', wallet: '👛' };

function MethodRow({ country, m, onSet, busy }) {
  const name = t(`paycountry.method.${m.method}`);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 6 }}>
      <T size={22}>{METHOD_ICON[m.method]}</T>
      <View style={{ flex: 1, gap: 2 }}>
        <T weight="700">{name}</T>
        {!m.server_ready ? <T size={12} color={c.mute}>{t('paycountry.no_keys')}</T> : null}
      </View>
      <Switch value={m.enabled} disabled={busy} onValueChange={(v) => onSet(m.method, v)}
        accessibilityRole="switch" accessibilityLabel={t('paycountry.toggle', { method: name, country: countryName(country) })} accessibilityState={{ checked: m.enabled, disabled: busy }}
        trackColor={{ true: c.violet, false: c.line }} thumbColor="#fff" activeThumbColor="#fff" style={{ minWidth: 44, minHeight: 44 }} />
    </View>
  );
}

export function PaymentCountries() {
  const { toast } = useSession();
  const [country, setCountry] = useState('IN');
  const [busy, setBusy] = useState(false);
  const all = useLoad(() => api.get('/admin/payments/countries'), []);
  const one = useLoad(() => (country ? api.get(`/admin/payments/countries?country=${country}`) : Promise.resolve(null)), [country]);
  const set = async (method, enabled) => {
    setBusy(true);
    try { await api.patch(`/admin/payments/countries/${country}/methods/${method}`, { enabled }); toast(t('paycountry.saved')); await Promise.all([one.reload(), all.reload()]); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const cur = one.data?.countries?.[0];
  const active = (all.data?.countries ?? []).filter((x) => x.enabled_count > 0);
  return (
    <View style={{ gap: 14 }}>
      <T weight="800" size={18}>{t('paycountry.title')}</T>
      <T color={c.mute} size={13}>{t('paycountry.intro')}</T>
      <CountryPicker label={t('paycountry.choose')} value={country} onChange={setCountry} />
      {one.loading && !one.data ? <Loading /> : one.error ? <ErrorBox error={one.error} onRetry={one.reload} /> : cur ? (
        <Card pad={12}>{cur.methods.map((m) => <MethodRow key={m.method} country={country} m={m} onSet={set} busy={busy} />)}</Card>
      ) : null}
      {active.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {active.map((x) => (
            <Tag key={x.country} label={`🌍 ${countryName(x.country)} · ${t('paycountry.on_count', { n: x.enabled_count })}`} color={x.country === country ? c.violetSoft : c.cyanSoft} />
          ))}
        </View>
      ) : all.data ? <Empty emoji="💳" title={t('paycountry.none')} /> : null}
    </View>
  );
}
