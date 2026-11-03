// Integration Hub (#597): one place for an organisation to connect outside systems. The catalogue, permissions, credentials, sync health,
// logs, usage, webhooks and record mappings all come from the API (capabilities list_integration_catalogue … subscribe_integration_webhook);
// this screen only calls it. Providers that already have their own console are listed with a link there rather than duplicated.
import React, { useMemo, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H1, H2, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { t } from '../i18n';
import { TravelPartnersAdmin } from './travel-partners';
import { c } from '../theme';

const nice = (s) => String(s).replace(/[._]/g, ' ').replace(/^./, (x) => x.toUpperCase());
const TONE = { connected: c.mint, paused: c.sun, error: c.red, disconnected: c.violetSoft };
const SYNC_CHOICES = [{ value: 0, label: 'Manual' }, { value: 60, label: 'Hourly' }, { value: 360, label: 'Every 6 hours' }, { value: 1440, label: 'Daily' }];
const say = (e) => e?.message ?? 'Something went wrong';

/** A secret that is shown once: copy it now. */
function SecretSheet({ secret, onClose }) {
  const { toast } = useSession();
  const copy = async () => { try { if (Platform.OS === 'web' && navigator?.clipboard) { await navigator.clipboard.writeText(secret); toast('Copied'); } else await Share.share({ message: secret }); } catch { /* shared or cancelled */ } };
  return (
    <Sheet visible onClose={onClose} title={t('ih.secret_once')}>
      <Card pad={12}><T weight="800" selectable style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{secret}</T></Card>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Btn title="Copy" onPress={copy} style={{ flex: 1 }} accessibilityLabel="Copy the secret" />
        <Btn title={t('common.done')} color={c.paper} onPress={onClose} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

const MODES = ['api_pull', 'api_push', 'webhook_in', 'webhook_out', 'file_transfer', 'sso', 'embed', 'other'];
const SECURITY = [['tls', 'TLS (https)'], ['oauth2', 'OAuth 2.0'], ['api_key', 'API key'], ['signed_requests', null], ['ip_allowlist', null], ['mutual_tls', 'Mutual TLS'], ['sso_saml_oidc', 'SSO (SAML / OIDC)'], ['iso_27001', 'ISO 27001'], ['soc2', 'SOC 2'], ['data_protection_compliant', null]];
const secLabel = (k, fixed) => fixed ?? t({ signed_requests: 'ih.sec.signed', ip_allowlist: 'ih.sec.ip', data_protection_compliant: 'ih.sec.dp' }[k]);
const STAGE_TONE = { submitted: c.sun, needs_info: c.orange ?? c.sun, quoted: c.cyan, accepted: c.mint, in_development: c.violetSoft, enabled: c.mint, declined: c.red, withdrawn: c.violetSoft, revoked: c.red };
const money = (q) => (q?.pricing_mode === 'waived' ? t('ih.admin.waived') : q?.price_minor != null ? `${(q.price_minor / 100).toFixed(2)} ${q.currency} · ${t(`ih.quote.billing.${q.billing}`)}` : '');
const stageLabel = (st) => t(st === 'submitted' ? 'ih.access.pending' : st === 'enabled' ? 'ih.access.approved' : `ih.access.${st}`);

/** The integration request form: everything the platform team needs to review, advise a price and plan the work. Used to ask, and to answer questions. */
function RequestForm({ orgId, provider, existing, onClose, onDone }) {
  const custom = !provider && !existing?.provider_key;
  const e = existing ?? {};
  return (
    <FormSheet visible onClose={onClose} title={existing ? t('ih.update') : t('ih.request.title')} submitLabel={existing ? t('ih.update') : t('ih.request.cta')}
      initial={{ integration_name: e.integration_name ?? provider?.name, integration_url: e.integration_url, mode: e.mode ?? 'api_pull', security: e.security ?? ['tls'], personal_data: e.personal_data ?? false, monthly_volume: e.monthly_volume, peak_per_minute: e.peak_per_minute, purpose: e.purpose, starts_on: e.starts_on?.slice?.(0, 10), ends_on: e.ends_on?.slice?.(0, 10), contact_is_requester: e.contact_is_requester ?? true, contact_name: e.contact_name }}
      fields={[
        { key: 'integration_name', label: t('ih.form.name'), show: () => custom || !!existing },
        { key: 'integration_url', label: t('ih.form.url'), input: 'url', optional: true, placeholder: 'https://…' },
        { key: 'mode', type: 'custom', render: ({ v, set }) => <MenuField label={t('ih.form.mode')} value={v.mode ?? 'api_pull'} onChange={(x) => set('mode', x)} options={MODES.map((m) => ({ value: m, label: t(`ih.mode.${m}`) }))} /> },
        { key: 'security', label: t('ih.form.security'), type: 'multimenu', optional: true, options: SECURITY.map(([k, fixed]) => ({ value: k, label: secLabel(k, fixed) })) },
        { key: 'personal_data', label: t('ih.form.personal_data'), type: 'switch' },
        { key: 'monthly_volume', label: t('ih.form.volume'), type: 'number', optional: true },
        { key: 'peak_per_minute', label: t('ih.form.peak'), type: 'number', optional: true },
        { key: 'purpose', label: t('ih.form.purpose'), multiline: true },
        { key: 'starts_on', label: t('ih.form.dates'), type: 'daterange', toKey: 'ends_on', optional: true },
        { key: 'contact_is_requester', label: t('ih.form.contact_me'), type: 'switch' },
        { key: 'contact_name', label: t('ih.form.contact_name'), show: (v) => !v.contact_is_requester },
        { key: 'contact_email', label: t('ih.form.contact_email'), input: 'email', optional: true, show: (v) => !v.contact_is_requester },
        { key: 'contact_phone', label: t('ih.form.contact_phone'), input: 'phone', optional: true, show: (v) => !v.contact_is_requester },
        ...(existing ? [{ key: 'note', label: t('ih.admin.note'), multiline: true, optional: true }] : []),
        ...(!existing && !custom ? [{ key: 'event_id', label: t('ih.request.event'), type: 'entity', entityKind: 'event', noun: 'event', optional: true, hint: t('ih.request.event_hint') }] : []),
      ]}
      onSubmit={async (v) => {
        const body = { ...v };
        for (const k of ['integration_url', 'monthly_volume', 'peak_per_minute', 'contact_email', 'contact_phone', 'starts_on', 'ends_on']) if (body[k] === '' || body[k] == null) delete body[k];
        for (const k of ['monthly_volume', 'peak_per_minute']) if (body[k] != null) body[k] = Number(body[k]);
        delete body.event_id__pick;
        try {
          if (existing) await api.patch(`/integration-access/${existing.id}`, body);
          else await api.post(`/organisations/${orgId}/integration-access`, { ...body, ...(provider ? { provider_key: provider.key } : {}) });
          await onDone(); return t('ih.request.sent');
        } catch (err) { throw new Error(say(err)); }
      }} />
  );
}

/** Progress of one request: the details, the price, and what each side did. */
function RequestDetail({ id, platform, onClose, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/integration-access/${id}`), [id]);
  const [sub, setSub] = useState(null);
  const x = d.data;
  const reload = async () => { await d.reload(); await onChanged(); };
  const answer = async (decision, note) => { try { await api.post(`/integration-access/${id}/quote-response`, { decision, note }); await reload(); toast(t('common.done')); } catch (e) { toast(say(e)); } };
  const decide = async (body) => { try { await api.post(`/admin/integration-access/${id}/decision`, body); setSub(null); await reload(); return t('common.done'); } catch (e) { throw new Error(say(e)); } };
  const withdraw = async () => { try { await api.del(`/integration-access/${id}`); await onChanged(); onClose(); } catch (e) { toast(say(e)); } };
  return (
    <Sheet visible onClose={onClose} title={x?.integration_name ?? t('ih.request.title')}>
      {d.loading && !x ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Tag label={stageLabel(x.status)} color={STAGE_TONE[x.status]} />
            {x.draft ? <Tag label={t('ih.draft')} color={c.violetSoft} /> : null}
            {x.needs_development ? <Tag label={t('ih.admin.needs_dev')} /> : null}
          </View>
          {platform ? <T weight="800">{x.organisation_name}{x.event_name ? ` · ${x.event_name}` : ''}</T> : null}
          <T size={13} color={c.mute}>{[t(`ih.mode.${x.mode}`), x.integration_url, x.personal_data ? t('ih.form.personal_data') : null].filter(Boolean).join(' · ')}</T>
          <T size={13} color={c.mute}>{x.security.map((k) => secLabel(k, SECURITY.find(([s]) => s === k)?.[1])).join(' · ')}</T>
          <T size={13}>{x.purpose}</T>
          <T size={12} color={c.mute}>{[x.monthly_volume != null ? `${x.monthly_volume} / ${t('ih.form.volume').toLowerCase()}` : null, x.starts_on ? `${String(x.starts_on).slice(0, 10)} → ${x.ends_on ? String(x.ends_on).slice(0, 10) : '…'}` : null].filter(Boolean).join(' · ')}</T>
          <T size={12} color={c.mute}>{t('ih.contact')}: {[x.contact_name, x.contact_email, x.contact_phone].filter(Boolean).join(' · ') || '—'}</T>
          {x.quote?.pricing_mode ? <Card pad={12}><T weight="800" size={13}>{t('ih.quote.title')}</T><T size={14}>{money(x.quote)}</T>{x.quote.valid_until ? <T size={12} color={c.mute}>{t('ih.quote.valid', { date: String(x.quote.valid_until).slice(0, 10) })}</T> : null}</Card> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {!platform && x.status === 'quoted' ? <><Btn small title={t('ih.quote.accept')} onPress={() => answer('accept')} /><Btn small color={c.paper} ink={c.red} title={t('ih.quote.reject')} onPress={() => answer('reject', undefined)} /></> : null}
            {!platform && ['submitted', 'needs_info'].includes(x.status) ? <Btn small color={c.paper} title={t('ih.update')} onPress={() => setSub('edit')} /> : null}
            {!platform && ['submitted', 'needs_info', 'quoted', 'accepted', 'in_development'].includes(x.status) ? <Btn small color={c.paper} ink={c.red} title={t('ih.withdraw')} onPress={withdraw} /> : null}
            {platform && x.status === 'submitted' ? <Btn small color={c.paper} title={t('ih.admin.ask')} onPress={() => setSub('request_info')} /> : null}
            {platform && ['submitted', 'quoted'].includes(x.status) ? <Btn small title={t('ih.admin.quote')} onPress={() => setSub('quote')} /> : null}
            {platform && x.status === 'accepted' && x.needs_development ? <Btn small title={t('ih.admin.dev')} onPress={() => decide({ decision: 'start_development' })} /> : null}
            {platform && x.status === 'in_development' ? <Btn small title={t('ih.admin.deploy')} onPress={() => setSub('deploy')} /> : null}
            {platform && x.status === 'accepted' && !x.needs_development ? <Btn small title={t('ih.admin.enable')} onPress={() => decide({ decision: 'enable' })} /> : null}
            {platform && ['submitted', 'needs_info', 'quoted', 'accepted', 'in_development'].includes(x.status) ? <Btn small color={c.paper} ink={c.red} title={t('ih.admin.decline')} onPress={() => setSub('decline')} /> : null}
            {platform && x.status === 'enabled' ? <Btn small color={c.paper} ink={c.red} title={t('ih.admin.revoke')} onPress={() => setSub('revoke')} /> : null}
          </View>
          <H2>{t('ih.timeline')}</H2>
          {x.timeline.map((e, n) => <T key={n} size={12} color={c.mute}>{new Date(e.created_at).toLocaleString()} · {e.actor_side === 'platform' ? 'Platform' : (e.actor ?? '')} · {nice(e.kind)}{e.note ? ` — ${e.note}` : ''}</T>)}
        </View>
      )}
      {sub === 'edit' && x ? <RequestForm orgId={x.organisation_id} existing={x} onClose={() => setSub(null)} onDone={async () => { setSub(null); await reload(); }} /> : null}
      {sub === 'quote' ? (
        <FormSheet visible onClose={() => setSub(null)} title={t('ih.admin.quote')} submitLabel={t('ih.admin.quote')} initial={{ pricing_mode: 'special', currency: 'INR', billing: 'annual', needs_development: x?.needs_development ?? false }}
          fields={[
            { key: 'pricing_mode', label: t('ih.admin.pricing'), type: 'chips', options: [{ value: 'special', label: t('ih.admin.special') }, { value: 'waived', label: t('ih.admin.waived') }] },
            { key: 'currency', label: 'Currency', type: 'currency', show: (v) => v.pricing_mode === 'special' },
            { key: 'price', label: t('ih.admin.price'), type: 'money', currency: (v) => v.currency, show: (v) => v.pricing_mode === 'special' },
            { key: 'billing', label: t('ih.admin.billing'), type: 'chips', options: ['one_time', 'monthly', 'annual'].map((b) => ({ value: b, label: t(`ih.quote.billing.${b}`) })), show: (v) => v.pricing_mode === 'special' },
            { key: 'valid_until', label: t('ih.admin.valid'), type: 'date', optional: true },
            { key: 'needs_development', label: t('ih.admin.needs_dev'), type: 'switch' },
            { key: 'note', label: t('ih.admin.note'), optional: true },
          ]}
          onSubmit={(v) => decide({ decision: 'quote', pricing_mode: v.pricing_mode, ...(v.pricing_mode === 'special' ? { price_minor: v.price, currency: v.currency, billing: v.billing } : {}), valid_until: v.valid_until || undefined, needs_development: v.needs_development, note: v.note })} />
      ) : null}
      {sub === 'deploy' ? (
        <FormSheet visible onClose={() => setSub(null)} title={t('ih.admin.deploy')} submitLabel={t('ih.admin.deploy')}
          fields={[{ key: 'provider_key', label: t('ih.admin.adapter'), type: 'custom', render: ({ v, set }) => <AdapterPick value={v.provider_key} onChange={(k) => set('provider_key', k)} /> }, { key: 'note', label: t('ih.admin.note'), optional: true }]}
          onSubmit={(v) => decide({ decision: 'deploy', provider_key: v.provider_key, note: v.note })} />
      ) : null}
      {['request_info', 'decline', 'revoke'].includes(sub) ? (
        <FormSheet visible onClose={() => setSub(null)} title={t(sub === 'request_info' ? 'ih.admin.ask' : `ih.admin.${sub}`)} submitLabel={t(sub === 'request_info' ? 'ih.admin.ask' : `ih.admin.${sub}`)}
          fields={[{ key: 'note', label: t('ih.admin.note'), multiline: true, optional: sub === 'revoke' }]} onSubmit={(v) => decide({ decision: sub, note: v.note })} />
      ) : null}
    </Sheet>
  );
}

function AdapterPick({ value, onChange }) {
  const cat = useLoad(() => api.get('/integrations/catalogue'), []);
  return <MenuField label={t('ih.admin.adapter')} value={value ?? ''} onChange={onChange} options={(cat.data?.providers ?? []).filter((p) => !p.managed_in).map((p) => ({ value: p.key, label: p.name, sub: nice(p.category) }))} />;
}

function Connect({ orgId, catalogue, onClose, onDone, onSecret, onRequest }) {
  const live = catalogue.providers.filter((p) => !p.managed_in);
  const managed = catalogue.providers.filter((p) => p.managed_in);
  const { push } = useNav();
  const [key, setKey] = useState(live[0]?.key);
  const p = live.find((x) => x.key === key);
  const isCustom = key === '__custom';
  const options = [{ value: '__custom', label: t('ih.form.custom'), sub: t('ih.request.cta') }, ...live.map((x) => ({ value: x.key, label: x.name, sub: x.gated && x.access !== 'enabled' ? `${nice(x.category)} · ${stageLabel(x.access)}` : nice(x.category) })), ...managed.map((x) => ({ value: x.key, label: x.name, sub: t('ih.managed') }))];
  const isManaged = managed.some((m) => m.key === key);
  const locked = isCustom || (!!p && p.gated && p.access !== 'enabled');
  const secretField = (f) => p.credential_fields.includes(f);
  return (
    <FormSheet visible onClose={onClose} title={t('ih.connect')} submitLabel={isManaged ? 'Open' : locked ? t('ih.request.cta') : t('ih.connect')}
      initial={{ mode: 'live', sync: 0 }}
      fields={[
        { key: 'provider', type: 'custom', render: () => (
          <MenuField label={t('ih.provider')} value={key} onChange={setKey} options={options}
            hint={p ? `v${p.version} · ${p.capabilities.map(nice).join(', ')}` : undefined} />) },
        { key: 'lock', type: 'custom', render: () => (locked ? <Card pad={12}><T weight="800" size={13}>{isCustom ? t('ih.form.custom') : stageLabel(p.access)}</T><T size={12} color={c.mute}>{t('ih.request.explain')}</T></Card> : null) },
        { key: 'label', label: 'Name', placeholder: p?.name, show: () => !isManaged && !locked },
        ...(p && !isManaged ? (locked ? [] : p.fields).map((f) => ({ key: `s_${f}`, label: nice(f), type: secretField(f) && f !== 'url' ? 'secret' : 'text', input: f.endsWith('url') ? 'url' : undefined, optional: f === 'sandbox_url' || f === 'device_label' })) : []),
        ...(p?.sandbox && !locked ? [{ key: 'mode', label: t('ih.sandbox'), type: 'chips', options: [{ value: 'live', label: 'Live' }, { value: 'sandbox', label: 'Sandbox' }] }] : []),
        ...(p?.sync && !locked ? [{ key: 'sync', label: 'Sync', type: 'chips', options: SYNC_CHOICES }] : []),
        ...(p && !locked ? [{ key: 'scopes_h', type: 'section', label: t('ih.permissions') }, { key: 'scopes', type: 'custom', render: () => (
          <View style={{ gap: 6 }}>{p.scopes.map((s) => <View key={s.key}><T weight="800" size={13}>{s.label}</T><T size={12} color={c.mute}>{s.description}</T></View>)}</View>) },
        { key: 'accept', label: t('ih.accept'), type: 'switch' }] : []),
      ]}
      onSubmit={async (v) => {
        if (isManaged) { onClose(); push(managed.find((m) => m.key === key).managed_in); return undefined; }
        if (locked) { if (!isCustom && !['none', 'declined', 'revoked', 'withdrawn'].includes(p.access)) throw new Error(stageLabel(p.access)); onClose(); onRequest(isCustom ? { custom: true } : p); return undefined; }
        if (!v.accept) throw new Error(t('ih.accept'));
        const settings = {};
        for (const f of p.fields) if (v[`s_${f}`]) settings[f] = v[`s_${f}`];
        try {
          const r = await api.post(`/organisations/${orgId}/integrations`, { provider_key: key, label: v.label || p.name, mode: v.mode ?? 'live', settings, accept_scopes: p.scopes.map((s) => s.key), ...(v.sync ? { sync_every_minutes: v.sync } : {}) });
          await onDone(); if (r.webhook_secret) onSecret(r); return t('ih.status.connected');
        } catch (e) { throw new Error(say(e)); }
      }} />
  );
}

function Detail({ id, onClose, onChanged, onSecret }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/integrations/${id}`), [id]);
  const [status, setStatus] = useState(undefined);
  const ev = useLoad(() => api.get(`/integrations/${id}/events`, { status, limit: 30 }), [id, status]);
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn, msg) => { setBusy(true); try { const r = await fn(); await d.reload(); await ev.reload(); await onChanged(); toast(typeof msg === 'function' ? msg(r) : msg); return r; } catch (e) { toast(say(e)); } finally { setBusy(false); } };
  const x = d.data;
  return (
    <Sheet visible onClose={onClose} title={x?.label ?? t('ih.title')}>
      {d.loading && !x ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Tag label={t(`ih.status.${x.status}`)} color={TONE[x.status]} />
            <Tag label={`${x.provider_name} v${x.provider_version}`} />
            {x.mode === 'sandbox' ? <Tag label="Sandbox" color={c.sun} /> : null}
            {x.update_available ? <Tag label="Update available" color={c.cyan} /> : null}
          </View>
          <T size={13} color={c.mute}>{t('ih.last_success', { when: x.last_success_at ? new Date(x.last_success_at).toLocaleString() : t('ih.never') })}</T>
          {x.last_error ? <T size={13} color={c.red}>{x.last_error}</T> : null}
          {x.webhook_path ? <T size={12} color={c.mute} selectable>{x.webhook_path}</T> : null}
          <T weight="800">{t('ih.permissions')}</T>
          {x.requested_scopes.map((s) => <T key={s.key} size={12} color={c.mute}>• {s.label}: {s.description}</T>)}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title={t('ih.test')} disabled={busy || x.status === 'disconnected'} onPress={() => run(() => api.post(`/integrations/${id}/test`), (r) => r.message)} />
            {!x.webhook_path ? <Btn small title={t('ih.sync_now')} disabled={busy || x.status !== 'connected' && x.status !== 'error'} onPress={() => run(() => api.post(`/integrations/${id}/sync`), (r) => (r.ok ? t('common.done') : r.refused ? 'Rate limit reached' : r.error))} /> : null}
            <Btn small color={c.paper} title={x.status === 'paused' ? t('ih.resume') : t('ih.pause')} disabled={busy || x.status === 'disconnected'} onPress={() => run(() => api.patch(`/integrations/${id}`, { status: x.status === 'paused' ? 'connected' : 'paused' }), t('common.done'))} />
            <Btn small color={c.paper} title={t('ih.rotate')} disabled={busy || x.status === 'disconnected'} onPress={() => setSub('rotate')} />
            <Btn small color={c.paper} ink={c.red} title={t('ih.revoke')} disabled={busy || x.status === 'disconnected'} onPress={() => run(() => api.post(`/integrations/${id}/credentials/revoke`), t('ih.status.paused'))} />
            <Btn small color={c.paper} ink={c.red} title={t('ih.disconnect')} disabled={busy || x.status === 'disconnected'} onPress={() => run(() => api.del(`/integrations/${id}`), t('ih.status.disconnected'))} />
          </View>
          <H2>{t('ih.usage')}</H2>
          {x.usage.length ? x.usage.map((u) => <T key={u.day} size={12} color={c.mute}>{String(u.day).slice(0, 10)} · {u.calls} calls · {u.failures} failed · {u.refused} refused</T>) : <T size={12} color={c.mute}>{t('empty.nothing')}</T>}
          <H2>{t('ih.log')}</H2>
          <Seg options={[{ value: undefined, label: 'All' }, { value: 'failed', label: 'Failed' }, { value: 'ok', label: 'OK' }]} value={status} onChange={setStatus} />
          {ev.loading && !ev.data ? <Loading /> : (ev.data?.items ?? []).length ? ev.data.items.map((e) => (
            <T key={e.id} size={12} color={e.status === 'failed' ? c.red : c.mute}>{new Date(e.created_at).toLocaleString()} · {nice(e.kind)} · {e.status}{e.message ? ` · ${e.message}` : ''}</T>)) : <T size={12} color={c.mute}>{t('empty.nothing')}</T>}
        </View>
      )}
      {sub === 'rotate' && x ? (
        <FormSheet visible onClose={() => setSub(null)} title={t('ih.rotate')} submitLabel={t('ih.rotate')}
          fields={x.webhook_path ? [{ key: 'n', type: 'section', label: 'A new webhook secret is generated. The old one stops working now.' }] : [{ key: 'api_key', label: 'New API key', type: 'secret', optional: true }, { key: 'url', label: 'New address', input: 'url', optional: true }]}
          onSubmit={async (v) => { try { const body = { settings: Object.fromEntries(Object.entries(v).filter(([k, val]) => ['api_key', 'url'].includes(k) && val)) }; const r = await api.post(`/integrations/${id}/credentials/rotate`, body); setSub(null); await d.reload(); await onChanged(); if (r.webhook_secret) onSecret(r); return t('common.done'); } catch (e) { throw new Error(say(e)); } }} />
      ) : null}
    </Sheet>
  );
}

function Webhooks({ orgId, installs }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/organisations/${orgId}/integration-webhooks`, { limit: 50 }), [orgId]);
  const cat = useLoad(() => api.get('/integrations/catalogue'), []);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState(null);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}><View style={{ flex: 1 }}><H2>{t('ih.webhooks')}</H2></View><Btn small title="+" onPress={() => setAdding(true)} accessibilityLabel={t('ih.webhooks')} /></View>
      {(q.data?.items ?? []).map((h) => (
        <Card key={h.id} pad={12}>
          <T size={13} weight="800">{h.url}</T><T size={12} color={c.mute}>{h.event_types.map(nice).join(', ')} · {h.status}</T>
          {h.status === 'active' ? <Btn small color={c.paper} ink={c.red} title={t('ih.revoke')} style={{ marginTop: 8, alignSelf: 'flex-start' }} onPress={async () => { try { await api.del(`/integration-webhooks/${h.id}`); await q.reload(); } catch (e) { toast(say(e)); } }} /> : null}
        </Card>))}
      {adding && cat.data ? (
        <FormSheet visible onClose={() => setAdding(false)} title={t('ih.webhooks')} submitLabel={t('ih.connect')}
          fields={[{ key: 'url', label: 'Address (https)', input: 'url' },
            { key: 'event_types', label: 'Events', type: 'multimenu', options: cat.data.event_types.map((e) => ({ value: e, label: nice(e) })) },
            ...(installs.length ? [{ key: 'install_id', label: t('ih.provider'), type: 'choice', optional: true, options: [{ value: '', label: 'All' }, ...installs.map((i) => ({ value: i.id, label: i.label }))] }] : [])]}
          onSubmit={async (v) => { try { const r = await api.post(`/organisations/${orgId}/integration-webhooks`, { url: v.url, event_types: v.event_types, ...(v.install_id ? { install_id: v.install_id } : {}) }); setAdding(false); await q.reload(); setSecret(r.secret); return t('common.done'); } catch (e) { throw new Error(say(e)); } }} />) : null}
      {secret ? <SecretSheet secret={secret} onClose={() => setSecret(null)} /> : null}
    </View>
  );
}

export function IntegrationHub({ organisation_id }) {
  const orgs = useLoad(() => api.get('/organisations', { limit: 100 }), []);
  const mine = useMemo(() => (orgs.data ?? []).filter((o) => o.my_status === 'active' && ['owner', 'admin'].includes(o.my_role) && o.status === 'active'), [orgs.data]);
  const [picked, setPicked] = useState(organisation_id ?? null);
  const org = mine.find((o) => o.id === (picked ?? mine[0]?.id));
  const list = useLoad(() => (org ? api.get(`/organisations/${org.id}/integrations`, { limit: 100 }) : Promise.resolve(null)), [org?.id]);
  const cat = useLoad(() => api.get('/integrations/catalogue', org ? { organisation_id: org.id } : {}), [org?.id]);
  const [adding, setAdding] = useState(false);
  const [requesting, setRequesting] = useState(null);
  const [viewReq, setViewReq] = useState(null);
  const reqs = useLoad(() => (org ? api.get(`/organisations/${org.id}/integration-access`, { limit: 50 }) : Promise.resolve(null)), [org?.id]);
  const [open, setOpen] = useState(null);
  const [secret, setSecret] = useState(null);
  if (orgs.error) return <Screen><H1>{t('ih.title')}</H1><ErrorBox error={orgs.error} onRetry={orgs.reload} /></Screen>;
  if (!orgs.data) return <Screen><H1>{t('ih.title')}</H1><Loading /></Screen>;
  if (!org) return <Screen><H1>{t('ih.title')}</H1><Empty emoji="🔌" title={t('ih.empty')} sub="Only the owners and admins of an organisation can connect integrations." /></Screen>;
  const items = list.data?.items ?? [];
  return (
    <Screen refreshing={list.loading && !!list.data} onRefresh={list.reload} wide>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}><H1>{t('ih.title')}</H1><T size={13} color={c.mute}>{t('ih.subtitle')}</T></View>
        <Btn small title={`+ ${t('ih.connect')}`} onPress={() => setAdding(true)} disabled={!cat.data} accessibilityLabel={t('ih.connect')} />
      </View>
      {mine.length > 1 ? <View style={{ marginTop: 12 }}><MenuField label={t('ih.org')} value={org.id} onChange={setPicked} options={mine.map((o) => ({ value: o.id, label: o.name }))} /></View> : null}
      <View style={{ marginTop: 14, gap: 10 }}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !items.length ? <Empty emoji="🔌" title={t('ih.empty')} /> : items.map((i) => (
          <Card key={i.id} pad={14} onPress={() => setOpen(i.id)} accessibilityLabel={`${i.label}, ${t(`ih.status.${i.status}`)}`}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              <Tag label={t(`ih.status.${i.status}`)} color={TONE[i.status]} /><Tag label={nice(i.category)} />{i.mode === 'sandbox' ? <Tag label="Sandbox" color={c.sun} /> : null}
            </View>
            <T weight="800" size={17}>{i.label}</T>
            <T size={13} color={c.mute}>{i.provider_name} · v{i.provider_version}</T>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('ih.last_success', { when: i.last_success_at ? new Date(i.last_success_at).toLocaleString() : t('ih.never') })}</T>
            {i.last_error ? <T size={12} color={c.red} numberOfLines={2}>{i.last_error}</T> : null}
          </Card>))}
      </View>
      {(reqs.data?.items ?? []).length ? (
        <View style={{ marginTop: 20, gap: 10 }}>
          <H2>{t('ih.requests')}</H2>
          {reqs.data.items.map((r) => (
            <Card key={r.id} pad={14} onPress={() => setViewReq(r.id)} accessibilityLabel={`${r.integration_name}, ${stageLabel(r.status)}`}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}><Tag label={stageLabel(r.status)} color={STAGE_TONE[r.status]} />{r.draft ? <Tag label={t('ih.draft')} color={c.violetSoft} /> : null}{r.event_name ? <Tag label={r.event_name} /> : null}</View>
              <T weight="800" size={16}>{r.integration_name}</T>
              <T size={13} color={c.mute}>{t(`ih.mode.${r.mode}`)}{r.quote?.pricing_mode ? ` · ${money(r.quote)}` : ''}</T>
              {r.status === 'quoted' ? <T size={12} color={c.sun} weight="700">{t('ih.access.quoted')}</T> : null}
            </Card>))}
        </View>) : null}
      <View style={{ marginTop: 20 }}><Webhooks orgId={org.id} installs={items} /></View>
      {adding && cat.data ? <Connect orgId={org.id} catalogue={cat.data} onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await list.reload(); }} onSecret={(r) => setSecret(r.webhook_secret)} onRequest={setRequesting} /> : null}
      {requesting ? <RequestForm orgId={org.id} provider={requesting.custom ? null : requesting} onClose={() => setRequesting(null)} onDone={async () => { setRequesting(null); await cat.reload(); await reqs.reload(); }} /> : null}
      {viewReq ? <RequestDetail id={viewReq} onClose={() => setViewReq(null)} onChanged={async () => { await reqs.reload(); await cat.reload(); await list.reload(); }} /> : null}
      {open ? <Detail id={open} onClose={() => setOpen(null)} onChanged={list.reload} onSecret={(r) => setSecret(r.webhook_secret)} /> : null}
      {secret ? <SecretSheet secret={secret} onClose={() => setSecret(null)} /> : null}
    </Screen>
  );
}

/** Platform admin only (the server enforces it and the entry is hidden for everyone else): review, price, build and enable integration requests. */
export function IntegrationRequests() {
  const [tab, setTab] = useState('requests');
  return (
    <Screen wide>
      <View style={{ marginBottom: 10 }}><Seg options={[{ value: 'requests', label: t('tpart.tab_requests') }, { value: 'travel', label: t('tpart.tab_travel') }]} value={tab} onChange={setTab} /></View>
      {tab === 'travel' ? <TravelPartnersAdmin /> : <IntegrationRequestList />}
    </Screen>
  );
}

function IntegrationRequestList() {
  const [status, setStatus] = useState('open');
  const q = useLoad(() => api.get('/admin/integration-access', { status, limit: 50 }), [status]);
  const [open, setOpen] = useState(null);
  return (
    <View>
      <H1>{t('ih.admin.title')}</H1>
      <MenuField label={t('ih.admin.open')} value={status} onChange={setStatus} options={['open', 'needs_info', 'quoted', 'accepted', 'in_development', 'enabled', 'declined', 'revoked'].map((v) => ({ value: v, label: v === 'open' ? t('ih.admin.open') : stageLabel(v) }))} />
      <View style={{ marginTop: 12, gap: 10 }}>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !(q.data?.items ?? []).length ? <Empty emoji="📭" title={t('ih.admin.empty')} /> : q.data.items.map((r) => (
          <Card key={r.id} pad={14} onPress={() => setOpen(r.id)} accessibilityLabel={`${r.organisation_name}, ${r.integration_name}, ${stageLabel(r.status)}`}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}><Tag label={stageLabel(r.status)} color={STAGE_TONE[r.status]} />{r.needs_development ? <Tag label={t('ih.admin.needs_dev')} /> : null}{r.event_name ? <Tag label={r.event_name} /> : null}</View>
            <T weight="800" size={16}>{r.organisation_name}</T>
            <T size={13} color={c.mute}>{r.integration_name} · {t(`ih.mode.${r.mode}`)}</T>
            <T size={13} style={{ marginTop: 4 }} numberOfLines={2}>{r.purpose}</T>
          </Card>))}
      </View>
      {open ? <RequestDetail id={open} platform onClose={() => setOpen(null)} onChanged={q.reload} /> : null}
    </View>
  );
}
