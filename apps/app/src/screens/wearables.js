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

// ---------- Elite extensions: ACWR, Readiness, sRPE ----------

const ZONE_COLOR = () => ({ optimal: c.lime, underload: c.cyan, caution: c.sun, excessive: c.red, no_data: c.mute });
const DIR_SYMBOL = { improving: '↑', stable: '→', declining: '↓', no_data: '–' };

/** ACWR zone pill with accessible label */
function ZonePill({ zone }) {
  const label = t(`acwr.zone.${zone}`);
  return <Tag label={label} color={ZONE_COLOR()[zone] ?? c.mute} accessibilityLabel={`ACWR zone: ${label}`} />;
}

/** Athlete's own ACWR + readiness panel (inside WearablesPanel) */
function LoadInsights() {
  const acwr = useLoad(() => api.get('/me/wearables/acwr'), []);
  const readiness = useLoad(() => api.get('/me/wearables/readiness'), []);
  if (acwr.loading && !acwr.data) return <Loading />;
  const a = acwr.data;
  const r = readiness.data;
  if (!a && !r) return null;
  return (
    <Card pad={14} style={{ gap: 10 }}>
      <T weight="800">{t('acwr.title')}</T>
      {a ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T size={28} weight="800">{a.ratio ?? '–'}</T>
            {a.zone !== 'no_data' ? <ZonePill zone={a.zone} /> : null}
          </View>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <View accessible accessibilityLabel={`Acute load: ${a.acute ?? 'no data'} au`}>
              <T size={11} color={c.mute}>{t('acwr.acute')}</T>
              <T weight="700">{a.acute ?? '–'} <T size={11} color={c.mute}>au</T></T>
            </View>
            <View accessible accessibilityLabel={`Chronic load: ${a.chronic ?? 'no data'} au`}>
              <T size={11} color={c.mute}>{t('acwr.chronic')}</T>
              <T weight="700">{a.chronic ?? '–'} <T size={11} color={c.mute}>au</T></T>
            </View>
            {a.days_with_data !== undefined ? <View accessible accessibilityLabel={`${a.days_with_data} days with data`}><T size={11} color={c.mute}>{t('acwr.days', { n: a.days_with_data })}</T></View> : null}
          </View>
          <T size={11} color={c.mute}>{t(`acwr.desc.${a.zone}`)}</T>
        </View>
      ) : null}
      {r?.score !== null && r?.score !== undefined ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8 }}>
          <View style={{ flex: 1 }}>
            <T size={12} color={c.mute}>{t('readiness.title')}</T>
            <T size={22} weight="800">{r.score} <T size={12} color={c.mute}>/100 {DIR_SYMBOL[r.direction] ?? ''}</T></T>
            <T size={11} color={c.mute}>{t(`readiness.dir.${r.direction}`)}</T>
          </View>
          {(r.components ?? []).map((comp) => (
            <View key={comp.key} style={{ alignItems: 'center', minWidth: 56 }} accessible accessibilityLabel={`${comp.label}: ${comp.value} ${comp.unit}`}>
              <T size={18} weight="800">{comp.score}</T>
              <T size={10} color={c.mute} style={{ textAlign: 'center' }}>{comp.label.split(' ')[0]}</T>
              {comp.delta !== null ? <T size={10} color={comp.delta > 0 ? c.mint : c.red}>{comp.delta > 0 ? '+' : ''}{comp.delta}</T> : null}
            </View>
          ))}
        </View>
      ) : null}
      <T size={11} color={c.mute}>{t('acwr.basis')}</T>
    </Card>
  );
}

/** sRPE entry and log panel */
function SRPELog() {
  const { toast } = useSession();
  const logs = useLoad(() => api.get('/me/wearables/srpe', { days: 28 }), []);
  const [form, setForm] = useState(false);
  const RPE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => ({ value: v, label: `${v} – ${t(`srpe.rpe.${v}`)}` }));
  return (
    <Card pad={14} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <T weight="800" style={{ flex: 1 }}>{t('srpe.title')}</T>
        <Btn small title={t('srpe.add')} onPress={() => setForm(true)} accessibilityLabel={t('srpe.add')} />
      </View>
      <T size={12} color={c.mute}>{t('srpe.sub')}</T>
      {(logs.data?.items ?? []).slice(0, 7).map((r) => (
        <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} accessible accessibilityLabel={`${r.logged_on} RPE ${r.rpe} × ${r.duration_minutes} min${r.sport ? ` ${r.sport}` : ''} = ${r.session_load} au`}>
          <T size={12} color={c.mute} style={{ width: 86 }}>{r.logged_on}</T>
          <T size={13} weight="700" style={{ width: 50 }}>RPE {r.rpe}</T>
          <T size={12} color={c.mute} style={{ flex: 1 }}>{r.duration_minutes} min{r.sport ? ` · ${r.sport}` : ''}</T>
          <T size={13} weight="700">{r.session_load} <T size={10} color={c.mute}>au</T></T>
        </View>
      ))}
      {logs.data && !logs.data.items.length ? <T size={12} color={c.mute}>{t('srpe.empty')}</T> : null}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('srpe.add')} submitLabel={t('common.save')}
        fields={[
          { key: 'rpe', label: t('srpe.rpe_label'), type: 'choice', options: RPE_OPTIONS },
          { key: 'duration_minutes', label: t('srpe.duration'), type: 'stepper', min: 1, max: 600, default: 60 },
          { key: 'sport', label: t('srpe.sport'), type: 'text', optional: true },
          { key: 'notes', label: t('srpe.notes'), type: 'text', optional: true, multiline: true },
        ]}
        initial={{ duration_minutes: 60 }}
        onSubmit={async (v) => {
          if (!v.rpe) throw new Error(t('srpe.pick_rpe'));
          await api.post('/me/wearables/srpe', { rpe: v.rpe, duration_minutes: v.duration_minutes, sport: v.sport || undefined, notes: v.notes || undefined });
          await logs.reload();
          return t('srpe.saved');
        }}
        onError={(e) => toast(e?.message ?? t('wr.error'))} />
    </Card>
  );
}

/** The athlete's own connected devices, trends, data quality, ACWR, readiness, sRPE and alerts (own data only). */
export function WearablesPanel() {
  const conns = useLoad(() => api.get('/me/wearables'), []);
  const provs = useLoad(() => api.get('/me/wearables/providers'), []);
  const dash = useLoad(() => api.get('/me/wearables/dashboard'), []);
  const q = useLoad(() => api.get('/me/wearables/quality'), []);
  const [form, setForm] = useState(null);
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
      <LoadInsights />
      {conns.error ? <ErrorBox error={conns.error} onRetry={conns.reload} /> : !conns.data ? <Loading /> : !conns.data.items.length ? <Empty emoji="⌚" title={t('wr.empty.title')} sub={t('wr.empty.sub')} /> :
        conns.data.items.map((cn) => <Connection key={cn.id} cn={cn} cat={cat} onChanged={all} onEdit={setForm} />)}
      <Trend cat={cat} have={have} />
      <SRPELog />
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

/** Coach: athletes who currently share wearables with me — metric overview + ACWR zone grid + readiness summary. */
export function TeamWearables() {
  const d = useLoad(() => api.get('/wearables/team'), []);
  const acwrD = useLoad(() => api.get('/wearables/team/acwr'), []);
  const srpeD = useLoad(() => api.get('/wearables/team/srpe'), []);
  const [tab, setTab] = useState('metrics'); // 'metrics' | 'acwr' | 'srpe'
  const athletes = d.data?.athletes ?? [];
  const acwrAthletes = acwrD.data?.athletes ?? [];
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!athletes.length && !(d.data?.unavailable ?? []).length && !acwrAthletes.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <T weight="800" size={16}>{t('wr.team.title')}</T>
      <T size={12} color={c.mute}>{t('wr.team.sub')}</T>
      {/* Tab switcher */}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {[['metrics', t('wr.team.tab.metrics')], ['acwr', t('wr.team.tab.acwr')], ['srpe', t('wr.team.tab.srpe')]].map(([key, label]) => (
          <Btn key={key} small title={label} color={tab === key ? c.pink : c.paper} ink={tab === key ? c.on : c.ink} onPress={() => setTab(key)} accessibilityLabel={label} accessibilityState={{ selected: tab === key }} />
        ))}
      </View>

      {tab === 'metrics' && (
        <>
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
        </>
      )}

      {tab === 'acwr' && (
        <View style={{ gap: 6 }}>
          {/* Squad summary strip */}
          {acwrAthletes.length > 0 ? (
            <Card pad={12} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
              {['optimal', 'caution', 'excessive', 'underload'].map((z) => {
                const n = acwrAthletes.filter((a) => a.zone === z).length;
                return n > 0 ? (
                  <View key={z} style={{ alignItems: 'center' }} accessible accessibilityLabel={`${n} athletes in ${t(`acwr.zone.${z}`)} zone`}>
                    <T size={22} weight="800" color={ZONE_COLOR()[z]}>{n}</T>
                    <T size={10} color={c.mute}>{t(`acwr.zone.${z}`)}</T>
                  </View>
                ) : null;
              })}
            </Card>
          ) : null}
          {acwrAthletes.map((a) => (
            <Card key={a.athlete.id} pad={14} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <View style={{ flex: 1 }}>
                <T weight="800">{a.athlete.display_name}</T>
                {a.readiness_score !== null && a.readiness_score !== undefined ? (
                  <T size={12} color={c.mute}>{t('readiness.title')}: {a.readiness_score}/100 {DIR_SYMBOL[a.readiness_direction] ?? ''}</T>
                ) : null}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <T size={22} weight="800" color={ZONE_COLOR()[a.zone] ?? c.mute}>{a.ratio ?? '–'}</T>
                <ZonePill zone={a.zone} />
                <T size={11} color={c.mute}>{t('acwr.acute')}: {a.acute ?? '–'} · {t('acwr.chronic')}: {a.chronic ?? '–'}</T>
              </View>
            </Card>
          ))}
          {!acwrAthletes.length ? <Empty emoji="📊" title={t('acwr.team.empty')} sub={t('acwr.team.empty_sub')} /> : null}
          <T size={11} color={c.mute}>{t('acwr.basis')}</T>
        </View>
      )}

      {tab === 'srpe' && (
        <View style={{ gap: 6 }}>
          {(srpeD.data?.athletes ?? []).map((a) => (
            <Card key={a.athlete.id} pad={14} style={{ gap: 6 }}>
              <T weight="800">{a.athlete.display_name}</T>
              {a.logs.slice(0, 5).map((r) => (
                <View key={r.logged_on + (r.sport ?? '')} style={{ flexDirection: 'row', gap: 8 }}>
                  <T size={12} color={c.mute} style={{ width: 86 }}>{r.logged_on}</T>
                  <T size={12} weight="700" style={{ width: 48 }}>RPE {r.rpe}</T>
                  <T size={12} color={c.mute} style={{ flex: 1 }}>{r.duration_minutes} min{r.sport ? ` · ${r.sport}` : ''}</T>
                  <T size={12} weight="700">{r.session_load} <T size={10} color={c.mute}>au</T></T>
                </View>
              ))}
              {!a.logs.length ? <T size={12} color={c.mute}>{t('srpe.empty')}</T> : null}
            </Card>
          ))}
          {!(srpeD.data?.athletes ?? []).length ? <Empty emoji="🏋️" title={t('srpe.team.empty')} sub={t('srpe.team.empty_sub')} /> : null}
        </View>
      )}

      {(d.data?.unavailable ?? []).map((u) => <T key={u.athlete.id} size={12} color={c.mute}>{u.athlete.display_name}: {u.reason}</T>)}
      <T size={11} color={c.mute}>{t('wr.disclaimer')}</T>
    </View>
  );
}
