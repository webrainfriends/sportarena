// Athlete Performance Integration Hub (#583), app side. All logic is in the API (list_wearable_providers … get_team_wearable_overview); this
// only calls it. `WearablesPanel` lives in the athlete's Recovery panel; `TeamWearables` is the coach's view inside Shared wellness.
// Nothing here labels a person as injured, fit or at risk: readings are descriptive and alerts quote the athlete's own rule.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { TrendChart } from './performance';
import { t } from '../i18n';
import { c } from '../theme';

const TONE = { connected: c.mint, paused: c.sun, error: c.red, revoked: c.violetSoft };
const say = (e) => e?.message ?? t('wr.error');
const when = (d) => (d ? new Date(d).toLocaleString() : t('wr.never'));
const fmt = (v, u) => (v === null || v === undefined ? '–' : ['count', 'kcal', 'au'].includes(u) ? Math.round(v).toLocaleString() : v);
const metricName = (cat, k) => cat.find((m) => m.key === k)?.label ?? k.replace(/_/g, ' ');

function Connection({ cn, cat, onChanged, onEdit }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  const run = async (fn, msg) => { setBusy(true); try { await fn(); await onChanged(); if (msg) toast(msg); } catch (e) { toast(say(e)); } finally { setBusy(false); } };
  const live = cn.status !== 'revoked';
  return (
    <Card pad={14} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800" style={{ flex: 1 }}>{cn.provider_name}</T>
        <Tag label={t(`wr.status.${cn.status}`)} color={TONE[cn.status]} />
      </View>
      <T size={12} color={c.mute}>{cn.push_only ? t('wr.push_only') : t('wr.last_sync', { when: when(cn.last_success_at) })}</T>
      {cn.last_error ? <T size={12} color={c.red}>{cn.last_error}</T> : null}
      <T size={12} color={c.mute}>{t('wr.allowed', { list: cn.metrics_granted.map((k) => metricName(cat, k)).join(', ') })}</T>
      {live ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {!cn.push_only && cn.status !== 'paused' ? <Btn small title={t('wr.sync_now')} loading={busy} onPress={() => run(() => api.post(`/me/wearables/${cn.id}/sync`), t('wr.synced'))} accessibilityLabel={`${t('wr.sync_now')} ${cn.provider_name}`} /> : null}
          <Btn small color={c.paper} ink={c.ink} title={t('wr.edit')} onPress={() => onEdit(cn)} accessibilityLabel={`${t('wr.edit')} ${cn.provider_name}`} />
          <Btn small color={c.paper} ink={c.ink} title={cn.status === 'paused' ? t('wr.resume') : t('wr.pause')} onPress={() => run(() => api.patch(`/me/wearables/${cn.id}`, { version: cn.version, paused: cn.status !== 'paused' }))} accessibilityLabel={`${cn.status === 'paused' ? t('wr.resume') : t('wr.pause')} ${cn.provider_name}`} />
          <Btn small color={c.red} title={t('wr.disconnect')} onPress={() => setAsk(true)} accessibilityLabel={`${t('wr.disconnect')} ${cn.provider_name}`} />
        </View>
      ) : null}
      <Sheet visible={ask} onClose={() => setAsk(false)} title={t('wr.confirm_disconnect', { name: cn.provider_name })}>
        <T size={14}>{t('wr.confirm_body')}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn title={t('wr.disconnect')} color={c.red} loading={busy} onPress={() => run(async () => { await api.post(`/me/wearables/${cn.id}/disconnect`); setAsk(false); })} />
          <Btn title={t('common.cancel')} color={c.paper} ink={c.ink} onPress={() => setAsk(false)} />
        </View>
      </Sheet>
    </Card>
  );
}

function Quality({ q, cat }) {
  const rows = (q.data?.items ?? []).flatMap((i) => i.metrics.map((m) => ({ ...m, provider: i.provider_name, stale: i.stale })));
  const bad = rows.filter((m) => m.warnings.length || m.stale);
  return (
    <Card pad={14} style={{ gap: 6 }}>
      <T weight="800">{t('wr.quality')}</T>
      {!rows.length ? <T size={12} color={c.mute}>{t('wr.no_data')}</T> : !bad.length ? <T size={13} color={c.mint}>{t('wr.q.ok')}</T> : bad.map((m) => (
        <T key={`${m.provider}-${m.metric}`} size={12} color={c.mute}>{m.provider} · {metricName(cat, m.metric)}: {[m.warnings.includes('no_data') ? t('wr.no_data') : m.missing_days ? t('wr.q.missing', { n: m.missing_days }) : null, m.out_of_range ? t('wr.q.range', { n: m.out_of_range }) : null, m.stale ? t('wr.q.stale') : null].filter(Boolean).join(' · ')}</T>
      ))}
    </Card>
  );
}

function Trend({ cat, have }) {
  const [metric, setMetric] = useState(null);
  const key = metric ?? have[0]?.metric ?? null;
  const tr = useLoad(() => (key ? api.get('/me/wearables/trend', { metric: key, days: 30 }) : Promise.resolve(null)), [key]);
  if (!have.length) return null;
  return (
    <Card pad={14} style={{ gap: 8 }}>
      <T weight="800">{t('wr.trend')}</T>
      <MenuField label={t('wr.metric')} value={key} onChange={setMetric} options={have.map((m) => ({ value: m.metric, label: m.label }))} title={t('wr.metric')} />
      {tr.error ? <ErrorBox error={tr.error} onRetry={tr.reload} /> : !tr.data ? <Loading /> : tr.data.points.length ? (
        <>
          <TrendChart points={tr.data.points.map((p) => ({ on: p.date, value: p.value }))} direction="higher" />
          <T size={12} color={c.mute}>{tr.data.label} · {t('wr.avg30')} {tr.data.average} {tr.data.unit}</T>
        </>
      ) : <Empty emoji="📈" title={t('wr.no_data')} />}
    </Card>
  );
}

function Tiles({ dash }) {
  const tiles = dash.data?.tiles ?? [];
  if (!tiles.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {tiles.map((x) => (
        <Card key={x.metric} pad={12} style={{ flexGrow: 1, flexBasis: 150, gap: 2 }} accessibilityLabel={`${x.label} ${x.latest} ${x.unit}`}>
          <T size={12} color={c.mute}>{x.label}</T>
          <T size={22} weight="800">{fmt(x.latest, x.unit)} <T size={12} color={c.mute}>{x.unit}</T></T>
          <T size={11} color={c.mute}>{x.change === null ? t('wr.latest') : t('wr.change7', { v: `${x.change > 0 ? '+' : ''}${fmt(x.change, x.unit)}` })}</T>
        </Card>
      ))}
    </View>
  );
}

function Alerts({ cat, dash }) {
  const rules = useLoad(() => api.get('/me/wearables/alert-rules'), []);
  const [form, setForm] = useState(false);
  const { toast } = useSession();
  return (
    <Card pad={14} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{t('wr.alerts')}</T><Btn small title={t('wr.alert.add')} onPress={() => setForm(true)} accessibilityLabel={t('wr.alert.add')} /></View>
      {(rules.data?.items ?? []).map((r) => (
        <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T size={13} style={{ flex: 1 }}>{r.rule}</T>
          <Btn small color={c.paper} ink={c.ink} title={t('wr.alert.remove')} onPress={async () => { try { await api.patch(`/me/wearables/alert-rules/${r.id}`, { archive: true }); await rules.reload(); } catch (e) { toast(say(e)); } }} accessibilityLabel={`${t('wr.alert.remove')}: ${r.rule}`} />
        </View>
      ))}
      {rules.data && !rules.data.items.length ? <T size={12} color={c.mute}>{t('wr.alert.none')}</T> : null}
      {(dash.data?.alerts ?? []).slice(0, 3).map((a) => <T key={a.id} size={12} color={c.mute}>{a.date} · {a.explanation}</T>)}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('wr.alert.add')} submitLabel={t('common.save')}
        fields={[
          { key: 'metric', label: t('wr.metric'), type: 'custom', render: ({ v, set }) => <MenuField label={t('wr.metric')} value={v.metric} onChange={(x) => set('metric', x)} options={cat.map((m) => ({ value: m.key, label: `${m.label} (${m.unit})` }))} title={t('wr.metric')} /> },
          { key: 'comparator', label: t('wr.alert.when'), type: 'choice', options: [{ value: 'above', label: t('wr.above') }, { value: 'below', label: t('wr.below') }] },
          { key: 'threshold', label: t('wr.alert.threshold'), type: 'number', hint: t('wr.alert.threshold_hint') },
          { key: 'window_days', label: t('wr.alert.window'), type: 'stepper', min: 1, max: 28, default: 1 },
        ]}
        initial={{ comparator: 'above', window_days: 1 }}
        onSubmit={async (v) => { if (!v.metric) throw new Error(t('wr.pick_metric')); try { await api.post('/me/wearables/alert-rules', { ...v, threshold: Number(v.threshold) }); await rules.reload(); return t('wr.saved'); } catch (e) { throw new Error(say(e)); } }} />
      <T size={11} color={c.mute}>{t('wr.alert.note')}</T>
    </Card>
  );
}

/** The athlete's own connected devices, trends, data quality and alerts (own data only). */
export function WearablesPanel() {
  const conns = useLoad(() => api.get('/me/wearables'), []);
  const provs = useLoad(() => api.get('/me/wearables/providers'), []);
  const dash = useLoad(() => api.get('/me/wearables/dashboard'), []);
  const q = useLoad(() => api.get('/me/wearables/quality'), []);
  const [form, setForm] = useState(null); // 'new' | connection
  const all = async () => { await Promise.all([conns.reload(), dash.reload(), q.reload()]); };
  const cat = provs.data?.metrics ?? [];
  const orgs = provs.data?.organisations ?? [];
  const have = (dash.data?.tiles ?? []).map((x) => ({ metric: x.metric, label: x.label }));
  const edit = form && form !== 'new' ? form : null;
  const fields = edit
    ? [{ key: 'metrics', label: t('wr.form.metrics'), type: 'multimenu', options: cat.map((m) => ({ value: m.key, label: `${m.label} (${m.unit})` })) },
      { key: 'sync_every_minutes', label: t('wr.form.every'), type: 'choice', options: [{ value: 60, label: t('wr.every.hour') }, { value: 360, label: t('wr.every.6h') }, { value: 1440, label: t('wr.every.day') }] }]
    : [
      { key: 'organisation_id', label: t('wr.form.org'), type: 'custom', render: ({ v, set }) => <MenuField label={t('wr.form.org')} value={v.organisation_id} onChange={(x) => { set('organisation_id', x); set('provider_key', undefined); }} options={orgs.map((o) => ({ value: o.organisation_id, label: o.organisation_name }))} title={t('wr.form.org')} /> },
      { key: 'provider_key', label: t('wr.form.provider'), type: 'custom', render: ({ v, set }) => <MenuField label={t('wr.form.provider')} value={v.provider_key} onChange={(x) => set('provider_key', x)} options={(orgs.find((o) => o.organisation_id === v.organisation_id)?.providers ?? []).map((p) => ({ value: p.key, label: p.enabled ? p.name : t('wr.form.not_enabled', { name: p.name }), sub: p.scopes?.[0]?.description }))} title={t('wr.form.provider')} /> },
      { key: 'metrics', label: t('wr.form.metrics'), type: 'multimenu', options: cat.map((m) => ({ value: m.key, label: `${m.label} (${m.unit})` })) },
      { key: 'access_token', label: t('wr.form.token'), type: 'secret' },
      { key: 'accept', label: t('wr.form.accept'), type: 'switch', default: false },
    ];
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}><T weight="800" size={16}>{t('wr.title')}</T><T size={12} color={c.mute}>{t('wr.sub')}</T></View>
        <Btn small title={t('wr.add')} onPress={() => setForm('new')} accessibilityLabel={t('wr.add')} />
      </View>
      <Tiles dash={dash} />
      {conns.error ? <ErrorBox error={conns.error} onRetry={conns.reload} /> : !conns.data ? <Loading /> : !conns.data.items.length ? <Empty emoji="⌚" title={t('wr.empty.title')} sub={t('wr.empty.sub')} /> :
        conns.data.items.map((cn) => <Connection key={cn.id} cn={cn} cat={cat} onChanged={all} onEdit={setForm} />)}
      <Trend cat={cat} have={have} />
      <Quality q={q} cat={cat} />
      <Alerts cat={cat} dash={dash} />
      <T size={11} color={c.mute}>{t('wr.disclaimer')}</T>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? edit.provider_name : t('wr.add')} submitLabel={t('common.save')} fields={fields}
        initial={edit ? { metrics: edit.metrics_granted, sync_every_minutes: edit.sync_every_minutes } : { metrics: [] }}
        onSubmit={async (v) => {
          try {
            if (edit) await api.patch(`/me/wearables/${edit.id}`, { version: edit.version, metrics: v.metrics, sync_every_minutes: v.sync_every_minutes });
            else {
              if (!v.accept) throw new Error(t('wr.must_accept'));
              if (!v.organisation_id || !v.provider_key) throw new Error(t('wr.pick_provider'));
              await api.post('/me/wearables', { organisation_id: v.organisation_id, provider_key: v.provider_key, metrics: v.metrics, access_token: v.access_token, accept_scopes: ['wearables.metrics.read'] });
            }
            await all();
            return t('wr.saved');
          } catch (e) { if (e?.details?.code === 'stale_version') await conns.reload(); throw new Error(say(e)); }
        }} />
    </View>
  );
}

/** Coach: athletes who currently share wearables with me (the API re-checks consent on every call). */
export function TeamWearables() {
  const d = useLoad(() => api.get('/wearables/team'), []);
  const athletes = d.data?.athletes ?? [];
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!athletes.length && !(d.data?.unavailable ?? []).length) return null;
  return (
    <View style={{ gap: 8 }}>
      <T weight="800" size={16}>{t('wr.team.title')}</T>
      <T size={12} color={c.mute}>{t('wr.team.sub')}</T>
      {athletes.map((a) => (
        <Card key={a.share_id} pad={14} style={{ gap: 6 }}>
          <T weight="800">{a.athlete.display_name}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {a.metrics.map((m) => (
              <View key={m.metric} style={{ flexBasis: 150, flexGrow: 1 }} accessible accessibilityLabel={`${m.label} ${m.latest ?? ''} ${m.unit}`}>
                <T size={12} color={c.mute}>{m.label}</T>
                <T weight="800">{fmt(m.latest, m.unit)} <T size={11} color={c.mute}>{m.unit}</T></T>
                <T size={11} color={c.mute}>{m.change === null ? '' : t('wr.team.change', { v: `${m.change > 0 ? '+' : ''}${fmt(m.change, m.unit)}` })}{m.missing_days ? ` · ${t('wr.team.missing', { n: m.missing_days })}` : ''}</T>
              </View>
            ))}
          </View>
          {!a.metrics.length ? <T size={12} color={c.mute}>{t('wr.no_data')}</T> : null}
        </Card>
      ))}
      {(d.data?.unavailable ?? []).map((u) => <T key={u.athlete.id} size={12} color={c.mute}>{u.athlete.display_name}: {u.reason}</T>)}
      <T size={11} color={c.mute}>{t('wr.disclaimer')}</T>
    </View>
  );
}
