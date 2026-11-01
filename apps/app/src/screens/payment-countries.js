// Payments tab of the Commercial console (#694) — platform admin only. Switch each payment method on or off, country by country.
// The server decides who may do this (403 for everyone else) and every module that takes payment reads the same switches.
import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Sheet, T, Tag } from '../ui';
import { DateField } from '../pickers';
import { moneyIn } from '../vtime';
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

/** One provider's keys: where each live value comes from, and a write-only way to set or clear it. A stored secret is never shown, only its last four characters. */
function ProviderKeys() {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/admin/payments/providers'), []);
  const [edit, setEdit] = useState(null);   // { provider, key }
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (v) => {
    setBusy(true);
    try { await api.post(`/admin/payments/providers/${edit.provider}/keys/${edit.key}`, { value: v }); toast(t('paycountry.saved')); setEdit(null); setValue(''); await list.reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 10 }}>
      <T weight="800" size={18}>{t('paykeys.title')}</T>
      <T color={c.mute} size={13}>{t('paykeys.intro')}</T>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (list.data?.providers ?? []).map((p) => (
        <Card key={p.provider} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <T weight="800" style={{ flex: 1 }}>{p.provider === 'paypal' ? 'PayPal' : p.provider === 'stripe' ? 'Stripe' : 'Razorpay'}</T>
            <Tag label={p.ready ? t('paykeys.ready') : t('paykeys.not_ready')} color={p.ready ? c.limeSoft : c.sunSoft} />
          </View>
          {p.fields.map((f) => (
            <View key={f.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="700" size={14}>{t(`paykeys.field.${f.key}`)}</T>
                <T size={12} color={c.mute}>{t(`paykeys.source.${f.source}`)}{f.last4 ? ` · …${f.last4}` : ''}</T>
              </View>
              <Btn small title={f.source === 'app' ? t('paykeys.replace') : t('paykeys.set')} color={c.paper} ink={c.ink} onPress={() => { setValue(''); setEdit({ provider: p.provider, key: f.key }); }} accessibilityLabel={`${t('paykeys.set')} ${t(`paykeys.field.${f.key}`)}`} />
            </View>
          ))}
        </Card>
      ))}
      <Sheet visible={!!edit} onClose={() => setEdit(null)} title={edit ? t(`paykeys.field.${edit.key}`) : ''}>
        <T size={13} color={c.mute}>{t('paykeys.write_only')}</T>
        <Field label={t('paykeys.value')} value={value} onChangeText={setValue} secure accessibilityLabel={t('paykeys.value')} />
        <Btn title={t('paykeys.save')} onPress={() => save(value.trim())} loading={busy} disabled={value.trim().length < 4} />
        <Btn title={t('paykeys.clear')} color={c.paper} ink={c.ink} onPress={() => save(null)} loading={busy} />
      </Sheet>
    </View>
  );
}

/** Settlement reconciliation: pick a date range with the calendar, run it, see what matched and what needs attention. */
function Settlements() {
  const { toast } = useSession();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const list = useLoad(() => api.get('/admin/payments/settlements'), []);
  const run = async () => {
    setBusy(true);
    try { setResult(await api.post('/admin/payments/reconcile', { from, to })); await list.reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 10 }}>
      <T weight="800" size={18}>{t('recon.title')}</T>
      <T color={c.mute} size={13}>{t('recon.intro')}</T>
      <DateField label={t('recon.from')} value={from} onChange={setFrom} max={today} />
      <DateField label={t('recon.to')} value={to} onChange={setTo} min={from} max={today} />
      <Btn title={t('recon.run')} onPress={run} loading={busy} accessibilityLabel={t('recon.run')} />
      {result ? <T weight="700">{t('recon.result', { settlements: result.settlements, items: result.items, flagged: result.flagged })}</T> : null}
      {list.loading && !list.data ? <Loading /> : (list.data ?? []).length ? (list.data ?? []).map((x) => (
        <Card key={x.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T weight="700">{x.provider_ref}{x.utr ? ` · ${x.utr}` : ''}</T>
              <T size={12} color={c.mute}>{x.settled_at ? String(x.settled_at).slice(0, 10) : ''} · {t('recon.fees', { amount: moneyIn(Number(x.fees_minor) + Number(x.tax_minor), x.currency) })}</T>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <T weight="800">{moneyIn(Number(x.amount_minor), x.currency)}</T>
              {Number(x.items_flagged) > 0 ? <Tag label={t('recon.flagged', { n: Number(x.items_flagged) })} color={c.sunSoft} /> : <Tag label={t('recon.clean')} color={c.limeSoft} />}
            </View>
          </View>
        </Card>
      )) : <Empty emoji="🏦" title={t('recon.none')} />}
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
      <ProviderKeys />
      <Settlements />
    </View>
  );
}
