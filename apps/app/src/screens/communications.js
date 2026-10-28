// Communication settings: the one place an organisation (or the platform admin) runs WhatsApp Business + SMS. Channels, approved templates,
// delivery activity and usage. It only calls the communications API (src/capabilities/communications.js); delivery itself is the existing
// notification queue. People manage their own numbers and categories on the Notifications screen (NumberCard, CommsPrefs below).
// One React Native component set: a tab strip on phones, a side rail from tablet width; every control is at least touch-sized and labelled.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { WhatsAppNumbers } from './whatsapp';

const CH = { whatsapp: 'WhatsApp', sms: 'SMS' };
const CHANNEL_OPTIONS = [{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' }];
// state words always carry an icon and a label, never colour alone; "delivered" only ever appears when the provider confirmed it
const STATE = { queued: ['⏳', 'Queued'], sent: ['📤', 'Sent'], delivered: ['✅', 'Delivered'], read: ['👀', 'Read'], failed: ['⚠️', 'Failed'], suppressed: ['⛔', 'Not sent'] };
const STATE_TONE = { delivered: c.limeSoft, read: c.cyanSoft, failed: c.redSoft, suppressed: c.sunSoft, sent: c.sunSoft, queued: c.violetSoft };
const REASON = { not_the_customer: 'Not the customer', opted_out: 'Opted out', quota_exceeded: 'Quota reached', no_template: 'No approved template', switched_off: 'Switched off', category_off: 'Category switched off', unverified: 'Number not verified', suppressed: 'Number suppressed', youth: 'Under 18', no_number: 'No number', no_provider: 'No provider account' };
const reasonWords = (r) => (!r ? null : r.startsWith('missing_variable') ? `Missing data (${r.split(': ')[1] ?? ''})` : r.startsWith('invalid_variable') ? `Not safe to send (${r.split(': ')[1] ?? ''})` : REASON[r] ?? r);
const TEMPLATE_TONE = { active: c.limeSoft, pending: c.sunSoft, draft: c.violetSoft, retired: c.redSoft };
const stamp = (d) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

/** Phone: a tab strip. Tablet and up: a side rail beside the panel. */
function Tabs({ tabs, value, onChange, children }) {
  const { tablet } = useLayout();
  if (!tablet) return <View style={{ gap: 10 }}><Seg options={tabs.map(([v, l]) => ({ value: v, label: l }))} value={value} onChange={onChange} color={c.violet} />{children}</View>;
  return (
    <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start', marginTop: 8 }}>
      <View style={{ width: 190, gap: 6 }}>{tabs.map(([v, l]) => <Chip key={v} label={l} active={v === value} onPress={() => onChange(v)} />)}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 10 }}>{children}</View>
    </View>
  );
}
const Grid = ({ children }) => { const { tablet } = useLayout(); return <View style={{ flexDirection: tablet ? 'row' : 'column', flexWrap: 'wrap', gap: 10 }}>{React.Children.map(children, (ch) => (ch ? <View style={{ flexBasis: tablet ? '48%' : 'auto', flexGrow: 1, minWidth: 0 }}>{ch}</View> : null))}</View>; };
const Meter = ({ used, limit }) => (
  <View accessible accessibilityLabel={limit == null ? `${used} used, no limit` : `${used} of ${limit} used`} style={{ gap: 4 }}>
    <View style={{ height: 8, borderRadius: 99, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ width: `${limit ? Math.min(100, (used / limit) * 100) : 0}%`, height: '100%', backgroundColor: limit && used / limit >= 0.9 ? c.sun : c.pink }} /></View>
    <T size={12} color={c.mute}>{used}{limit == null ? ' this month · no limit' : ` of ${limit} this month`}</T>
  </View>
);
const Load = ({ q, children }) => (q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : children(q.data));

// ---------------------------------------------------------------- the page
/** Organisation tab (owner / admin / finance). */
export function Communications({ organisationId, organisationName, archived }) {
  const { user } = useSession();
  const [tab, setTab] = useState('channels');
  const canWrite = !archived;
  return (
    <Tabs tabs={[['channels', 'Channels'], ['templates', 'Templates'], ['activity', 'Activity'], ['usage', 'Usage']]} value={tab} onChange={setTab}>
      {tab === 'channels' ? <ChannelsPanel orgId={organisationId} go={setTab} /> : tab === 'templates' ? <TemplatesPanel orgId={organisationId} orgName={organisationName} canWrite={canWrite} isPlatform={user?.roles?.includes('admin')} /> : tab === 'activity' ? <ActivityPanel orgId={organisationId} canWrite={canWrite} /> : <UsagePanel orgId={organisationId} />}
    </Tabs>
  );
}

function ChannelsPanel({ orgId, go }) {
  const st = useLoad(() => api.get('/communications/settings', { organisation_id: orgId }), [orgId]);
  return (
    <Load q={st}>{(s) => (
      <View style={{ gap: 10 }}>
        <Grid>
          {s.channels.map((ch) => (
            <Card key={ch.channel}>
              <T weight="700">{ch.channel === 'whatsapp' ? 'WhatsApp Business' : 'SMS'}</T>
              <T size={13} color={c.mute}>{ch.status === 'active' ? `${ch.account === 'organisation' ? 'Your own account' : 'Platform account'}${ch.sender_label ? ` · ${ch.sender_label}` : ''}` : 'Not set up yet. The platform team links the provider account.'}</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginVertical: 8 }}>
                <Tag label={ch.status === 'active' ? 'Live' : 'Not set up'} color={ch.status === 'active' ? c.limeSoft : c.sunSoft} />
                <Tag label={`${ch.templates.active} approved template${ch.templates.active === 1 ? '' : 's'}`} />
                {ch.templates.pending ? <Tag label={`${ch.templates.pending} awaiting approval`} color={c.sunSoft} /> : null}
              </View>
              {ch.used != null ? <Meter used={ch.used} limit={ch.limit} /> : null}
              {ch.addon_key ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Add-on: {ch.addon_key}</T> : null}
            </Card>
          ))}
          <Card>
            <T weight="700">Email · push · in-app</T>
            <T size={13} color={c.mute}>Always available, and the fallback if WhatsApp or SMS cannot reach someone. People choose their channels on the Notifications screen.</T>
          </Card>
        </Grid>
        {s.dedicated_numbers?.length ? (
          <Card>
            <T weight="700">Dedicated WhatsApp numbers</T>
            {s.dedicated_numbers.map((n) => <T key={n.id} size={13}>{n.label} · since {stamp(n.entitled_at)}</T>)}
          </Card>
        ) : null}
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T weight="700">Recent problems</T>
            <Btn small title="See all activity" color={c.paper} onPress={() => go('activity')} accessibilityLabel="See all delivery activity" />
          </View>
          {s.recent_failures.length ? s.recent_failures.map((f) => <T key={f.id} size={13} style={{ marginTop: 4 }}>{CH[f.channel]} · {STATE[f.status === 'pending' ? 'queued' : f.status][1]} · {reasonWords(f.last_error) ?? 'provider reported a failure'} · {stamp(f.created_at)}</T>) : <T size={13} color={c.mute} style={{ marginTop: 4 }}>Nothing failed in the last 7 days.</T>}
        </Card>
      </View>
    )}</Load>
  );
}

// ---------------------------------------------------------------- templates
function useCatalogue() { return useLoad(() => api.get('/communications/catalogue'), []); }

export function TemplatesPanel({ orgId, orgName, canWrite, isPlatform }) {
  const { toast } = useSession();
  const cat = useCatalogue();
  const [channel, setChannel] = useState(null);
  const [state, setState] = useState(null);
  const list = useLoad(() => api.get('/communications/templates', { organisation_id: orgId, channel: channel ?? undefined, state: state ?? undefined, limit: 100 }), [orgId, channel, state]);
  const [open, setOpen] = useState(null);       // the template shown in the sheet
  const [editor, setEditor] = useState(null);   // { from? } when creating
  const [preview, setPreview] = useState(null); // template being previewed
  const [shown, setShown] = useState(null);     // preview result
  const uc = (k) => cat.data?.use_cases.find((u) => u.key === k)?.label ?? k.replaceAll('_', ' ');
  const localeName = (l) => cat.data?.locales.find((x) => x.code === l)?.label ?? l;
  const move = async (t, to) => { try { await api.patch(`/communications/templates/${t.id}`, { state: to }); toast(to === 'pending' ? 'Submitted for approval' : to === 'active' ? 'Template is live' : 'Template retired'); setOpen(null); list.reload(); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {[[null, 'All'], ...CHANNEL_OPTIONS.map((o) => [o.value, o.label])].map(([v, l]) => <Chip key={l} label={l} active={channel === v} onPress={() => setChannel(v)} />)}
        {[[null, 'Any state'], ['active', 'Active'], ['pending', 'Pending'], ['draft', 'Draft'], ['retired', 'Retired']].map(([v, l]) => <Chip key={l} label={l} active={state === v} onPress={() => setState(v)} />)}
      </View>
      {canWrite ? <Btn title="New template" onPress={() => setEditor({})} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Create a new message template" /> : null}
      <Load q={list}>{(rows) => (rows.length ? rows.map((t) => (
        <Row key={t.id} title={uc(t.use_case)} sub={`${CH[t.channel]} · ${localeName(t.locale)} · v${t.version}${t.scope === 'platform' && orgId ? ' · platform template' : ''}`} right={<Tag label={t.state} color={TEMPLATE_TONE[t.state]} />} onPress={() => setOpen(t)} />
      )) : <Empty emoji="💬" title="No templates yet" sub="Pick a use case such as Fee due, write the message with the variables it offers, and submit it for approval." />)}</Load>

      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open ? `${uc(open.use_case)} · ${CH[open.channel]}` : ''}>
        {open ? (
          <View style={{ gap: 10 }}>
            <View style={{ backgroundColor: c.limeSoft, borderRadius: 14, padding: 12 }}><T size={14}>{open.body}</T></View>
            <T size={13} color={c.mute}>{localeName(open.locale)} · version {open.version} · {open.state}</T>
            <T size={13}>Variables: {open.variables.map((v) => `${v.name} (${cat.data?.variable_types.find((x) => x.type === v.type)?.label ?? v.type})`).join(', ') || 'none'}</T>
            <T size={13}>Provider template id: {open.provider_template_id ?? 'not set'}</T>
            <T size={13}>If it cannot be delivered: {open.fallback_channel ? `try ${open.fallback_channel === 'email' ? 'email and in-app (always on)' : CH[open.fallback_channel]}` : 'email and in-app only'}</T>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title="Preview" color={c.violet} onPress={() => { setPreview(open); setOpen(null); }} accessibilityLabel="Preview this template" />
              {canWrite && (open.organisation_id || isPlatform) ? <>
                <Btn small title="New version" color={c.paper} onPress={() => { setEditor({ from: open }); setOpen(null); }} accessibilityLabel="Write a new version of this template" />
                {open.state === 'draft' ? <Btn small title="Submit for approval" onPress={() => move(open, 'pending')} /> : null}
                {isPlatform && ['draft', 'pending'].includes(open.state) ? <Btn small title="Mark approved" color={c.lime} onPress={() => move(open, 'active')} accessibilityLabel="Record the provider's approval and make it live" /> : null}
                {open.state !== 'retired' ? <Btn small title="Retire" color={c.paper} ink={c.red} onPress={() => move(open, 'retired')} /> : null}
              </> : null}
            </View>
            {open.state === 'pending' && !isPlatform ? <T size={12} color={c.mute}>Waiting for the platform team to record the provider's approval.</T> : null}
          </View>
        ) : null}
      </Sheet>

      {editor ? <TemplateEditor cat={cat.data} orgId={orgId} from={editor.from} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); list.reload(); toast('Draft saved'); }} /> : null}
      {preview ? <PreviewForm template={preview} orgName={orgName} onClose={() => setPreview(null)} onShown={setShown} /> : null}
      <Sheet visible={!!shown} onClose={() => setShown(null)} title="What the recipient sees">
        {shown ? <View style={{ gap: 8 }}>
          <View style={{ backgroundColor: c.limeSoft, borderRadius: 14, padding: 12 }}><T size={14}>{shown.text}</T></View>
          <T size={12} color={c.mute}>{shown.length} characters{shown.segments ? ` · ${shown.segments} SMS part${shown.segments === 1 ? '' : 's'} (${shown.encoding})` : ''}. Nothing was sent.</T>
        </View> : null}
      </Sheet>
    </View>
  );
}

/** Write a template: the use case decides which typed variables exist; tapping one inserts it. Free text can never become a variable. */
function TemplateEditor({ cat, orgId, from, onClose, onSaved }) {
  const { toast } = useSession();
  const [uc, setUc] = useState(from?.use_case ?? null);
  const [channel, setChannel] = useState(from?.channel ?? 'whatsapp');
  const [locale, setLocale] = useState(from?.locale ?? 'en-IN');
  const [body, setBody] = useState(from?.body ?? '');
  const [ptid, setPtid] = useState(from?.provider_template_id ?? '');
  const [fallback, setFallback] = useState(from?.fallback_channel ?? null);
  const [busy, setBusy] = useState(false);
  const useCase = cat?.use_cases.find((u) => u.key === uc);
  const typeLabel = (t) => cat.variable_types.find((x) => x.type === t)?.label ?? t;
  const save = async () => {
    setBusy(true);
    try {
      const names = [...new Set([...body.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))];
      await api.post('/communications/templates', { organisation_id: orgId, use_case: uc, channel, locale, body, variables: names.map((name) => ({ name, type: useCase.variables.find((v) => v.name === name)?.type })), provider_template_id: ptid.trim() || undefined, fallback_channel: fallback });
      onSaved();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={from ? 'New version' : 'New template'}>
      {!cat ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <T weight="700" size={13}>Use case</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{cat.use_cases.map((u) => <Chip key={u.key} label={u.label} active={uc === u.key} onPress={() => { if (!from) setUc(u.key); }} />)}</View>
          {useCase?.essential ? <T size={12} color={c.mute}>Essential: sent even when someone has switched this category off. An opt-out (STOP) still always applies.</T> : null}
          <T weight="700" size={13}>Channel</T>
          <View style={{ flexDirection: 'row', gap: 6 }}>{CHANNEL_OPTIONS.map((o) => <Chip key={o.value} label={o.label} active={channel === o.value} onPress={() => !from && setChannel(o.value)} />)}</View>
          <T weight="700" size={13}>Language</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{cat.locales.map((l) => <Chip key={l.code} label={l.label} active={locale === l.code} onPress={() => !from && setLocale(l.code)} />)}</View>
          {useCase ? <>
            <T weight="700" size={13}>Add a variable (typed, filled in by the system)</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{useCase.variables.map((v) => <Chip key={v.name} label={`${v.name} · ${typeLabel(v.type)}`} onPress={() => setBody((b) => `${b}${b && !/\s$/.test(b) ? ' ' : ''}{{${v.name}}}`)} />)}</View>
          </> : <T size={12} color={c.mute}>Pick a use case to see the variables it offers.</T>}
          <Field label="Message" value={body} onChangeText={setBody} multiline maxLength={1024} hint="Notes, health, bank and pricing details can never be inserted. Links go in only through the link variable." />
          <Field label="Provider template id" value={ptid} onChangeText={setPtid} hint={channel === 'sms' ? 'The DLT-registered template id' : 'The approved WhatsApp template name'} maxLength={120} />
          <T weight="700" size={13}>If it cannot be delivered</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {[[null, 'Email & in-app only'], ...CHANNEL_OPTIONS.filter((o) => o.value !== channel).map((o) => [o.value, `Try ${o.label}`])].map(([v, l]) => <Chip key={l} label={l} active={fallback === v} onPress={() => setFallback(v)} />)}
          </View>
          <Btn title="Save draft" loading={busy} disabled={!uc || body.trim().length < 5} onPress={save} accessibilityLabel="Save the template as a draft" />
        </View>
      )}
    </Sheet>
  );
}

/** Preview with typed controls: a name is a text box, an amount a currency field, a date the calendar. Prefilled with what the platform knows. */
function PreviewForm({ template, orgName, onClose, onShown }) {
  const { user, toast } = useSession();
  const fields = template.variables.filter((v) => v.type !== 'link').flatMap((v) => (
    v.type === 'currency' ? [{ key: `${v.name}_cur`, label: `${v.name.replaceAll('_', ' ')} currency`, type: 'currency', default: 'INR' }, { key: v.name, label: v.name.replaceAll('_', ' '), type: 'money', currency: (vals) => vals[`${v.name}_cur`] ?? 'INR' }]
      : [{ key: v.name, label: v.name.replaceAll('_', ' '), type: v.type === 'date' ? 'date' : v.type === 'datetime' ? 'datetime' : 'text' }]));
  const known = { first_name: String(user?.display_name ?? '').split(' ')[0], ...(orgName ? { org_name: orgName } : {}) };
  const initial = Object.fromEntries(template.variables.filter((v) => known[v.name]).map((v) => [v.name, known[v.name]]));
  return (
    <FormSheet visible onClose={onClose} title="Preview" submitLabel="Show preview" fields={fields} initial={initial}
      onSubmit={async (vals) => {
        const values = {};
        for (const v of template.variables) {
          if (v.type === 'link') continue;
          values[v.name] = v.type === 'currency' ? { minor: vals[v.name] ?? 0, currency: vals[`${v.name}_cur`] ?? 'INR' } : vals[v.name];
        }
        try { onShown(await api.post(`/communications/templates/${template.id}/preview`, { values })); onClose(); } catch (e) { toast(e.message); throw e; }
      }} />
  );
}

// ---------------------------------------------------------------- activity
export function ActivityPanel({ orgId, canWrite }) {
  const { toast } = useSession();
  const [channel, setChannel] = useState(null);
  const [state, setState] = useState(null);
  const [pages, setPages] = useState(1);
  const list = useLoad(() => api.get('/communications/deliveries', { organisation_id: orgId, channel: channel ?? undefined, state: state ?? undefined, limit: 25 * pages }), [orgId, channel, state, pages]);
  const cat = useCatalogue();
  const retry = async (d) => { try { await api.post(`/communications/deliveries/${d.id}/retry`); toast('Queued again'); list.reload(); } catch (e) { toast(e.message); } };
  const STEPS = ['queued', 'sent', 'delivered', 'read'];
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {[[null, 'All'], ['failed', 'Failed'], ['suppressed', 'Not sent']].map(([v, l]) => <Chip key={l} label={l} active={state === v} onPress={() => { setState(v); setPages(1); }} />)}
        {CHANNEL_OPTIONS.map((o) => <Chip key={o.value} label={o.label} active={channel === o.value} onPress={() => { setChannel(channel === o.value ? null : o.value); setPages(1); }} />)}
      </View>
      <Load q={list}>{(rows) => (rows.length ? <>
        {rows.map((d) => {
          const reached = STEPS.indexOf(d.state);
          return (
            <Card key={d.id} pad={12}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <T weight="700" style={{ flexShrink: 1 }}>{cat.data?.use_cases.find((u) => u.key === d.use_case)?.label ?? d.use_case} · {d.recipient}</T>
                <Tag label={`${STATE[d.state][0]} ${STATE[d.state][1]}`} color={STATE_TONE[d.state]} />
              </View>
              <T size={12} color={c.mute}>{CH[d.channel]} · {stamp(d.created_at)}{d.fallback_of ? ' · fallback' : ''}</T>
              {reached >= 0 ? <T size={12} style={{ marginTop: 4 }}>{STEPS.map((s, i) => `${i <= reached ? '●' : '○'} ${STATE[s][1]}`).join('   ')}</T> : null}
              {d.reason || d.error_code ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{[reasonWords(d.reason), d.error_code ? `code ${d.error_code}` : null, d.state === 'queued' && d.attempts ? `attempt ${d.attempts}` : null].filter(Boolean).join(' · ')}</T> : null}
              {d.state === 'failed' && canWrite ? <Btn small title="Retry" color={c.paper} onPress={() => retry(d)} style={{ alignSelf: 'flex-start', marginTop: 8 }} accessibilityLabel={`Retry sending to ${d.recipient}`} /> : null}
            </Card>
          );
        })}
        {rows.length >= 25 * pages ? <Btn small title="Show more" color={c.paper} onPress={() => setPages(pages + 1)} style={{ alignSelf: 'flex-start' }} /> : null}
      </> : <Empty emoji="📭" title="Nothing here yet" sub="Messages appear once a fee reminder, booking change or announcement is sent over WhatsApp or SMS." />)}</Load>
    </View>
  );
}

// ---------------------------------------------------------------- usage
export function UsagePanel({ orgId }) {
  const st = useLoad(() => api.get('/communications/usage', { organisation_id: orgId }), [orgId]);
  const cat = useCatalogue();
  return (
    <Load q={st}>{(u) => (Array.isArray(u) ? (
      u.length ? u.map((r, i) => <Row key={i} title={`${r.organisation ?? 'Platform'} · ${CH[r.channel]}`} sub={`${r.used} counted · ${r.failed} failed`} />) : <Empty emoji="📊" title="No usage yet" />
    ) : (
      <View style={{ gap: 10 }}>
        <Grid>{u.channels.map((ch) => (
          <Card key={ch.channel}>
            <T weight="700">{CH[ch.channel]}</T>
            <Meter used={ch.used} limit={ch.limit} />
            {ch.remaining != null ? <T size={12} color={ch.remaining === 0 ? c.red : c.mute}>{ch.remaining === 0 ? 'Allowance used. Essential messages still send.' : `${ch.remaining} left this month`}</T> : null}
            {ch.addon_key ? <T size={12} color={c.mute}>Add-on: {ch.addon_key}</T> : <T size={12} color={c.mute}>No add-on purchased.</T>}
          </Card>
        ))}</Grid>
        <Card>
          <T weight="700">This month by state</T>
          {u.by_state.length ? u.by_state.map((r, i) => <T key={i} size={13}>{CH[r.channel]} · {STATE[r.state]?.[1] ?? r.state}: {r.n}</T>) : <T size={13} color={c.mute}>No messages yet.</T>}
        </Card>
        <Card>
          <T weight="700">This month by use case</T>
          {u.by_use_case.length ? u.by_use_case.map((r, i) => <T key={i} size={13}>{cat.data?.use_cases.find((x) => x.key === r.use_case)?.label ?? r.use_case} · {CH[r.channel]}: {r.n}</T>) : <T size={13} color={c.mute}>No messages yet.</T>}
        </Card>
      </View>
    ))}</Load>
  );
}

// ---------------------------------------------------------------- platform admin
const PROVIDER_FIELDS = {
  whatsapp_cloud: [['phone_number_id', 'Phone number id', 'text'], ['access_token', 'Access token', 'secret'], ['app_secret', 'App secret (webhook signing)', 'secret'], ['verify_token', 'Webhook verify token', 'secret'], ['waba_id', 'WhatsApp Business account id', 'text', true]],
  sms_http: [['url', 'Gateway URL (https)', 'text'], ['api_key', 'API key', 'secret'], ['sender_id', 'DLT sender header', 'text'], ['webhook_secret', 'Webhook signing secret', 'secret'], ['entity_id', 'DLT principal entity id', 'text', true]],
};

/** Platform admin: provider accounts, allowances, the dedicated OpenWA numbers, platform templates and everyone's usage. */
export function CommsPlatform() {
  const { toast } = useSession();
  const [tab, setTab] = useState('accounts');
  const st = useLoad(() => api.get('/communications/settings'), []);
  const [linking, setLinking] = useState(false);
  const [quota, setQuota] = useState(false);
  const [webhook, setWebhook] = useState(null);
  const orgs = st.data?.organisations ?? [];
  const retire = async (p) => { try { await api.del(`/admin/communications/providers/${p.id}`); toast('Account retired'); st.reload(); } catch (e) { toast(e.message); } };
  const linkFields = [
    { key: 'kind', label: 'Provider', type: 'chips', options: [{ value: 'whatsapp_cloud', label: 'WhatsApp Business (Cloud API)' }, { value: 'sms_http', label: 'SMS gateway' }] },
    { key: 'label', label: 'Name', hint: 'e.g. Gotmygame WhatsApp' },
    { key: 'sender_label', label: 'Sender shown to admins', optional: true },
    { key: 'organisation_id', label: 'Only for this organisation', type: 'entity', entityKind: 'person', noun: 'organisation', options: orgs.map((o) => ({ id: o.id, label: o.name, sub: o.city })), optional: true, hint: 'Leave empty for the platform account used by everyone' },
    ...Object.entries(PROVIDER_FIELDS).flatMap(([kind, fs]) => fs.map(([key, label, type, optional]) => ({ key: `cfg_${kind}_${key}`, label, type: type === 'secret' ? 'secret' : 'text', optional, show: (v) => v.kind === kind }))),
  ];
  return (
    <Tabs tabs={[['accounts', 'Accounts'], ['quotas', 'Allowances'], ['numbers', 'WhatsApp numbers'], ['templates', 'Templates'], ['usage', 'Usage']]} value={tab} onChange={setTab}>
      {tab === 'accounts' ? <Load q={st}>{(s) => (
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>Credentials are encrypted and never shown again. Linking a new account closes the old one; history is kept.</T>
          <Btn title="Link an account" onPress={() => setLinking(true)} style={{ alignSelf: 'flex-start' }} />
          {s.providers.length ? s.providers.map((p) => (
            <Row key={p.id} title={`${p.label} · ${CH[p.channel]}`} sub={`${p.organisation_id ? 'One organisation' : 'Platform'} · ${p.effective_to ? `closed ${stamp(p.effective_to)}` : `since ${stamp(p.effective_from)}`}${p.sender_label ? ` · ${p.sender_label}` : ''}`}
              right={p.effective_to ? <Tag label="Closed" /> : <Btn small title="Retire" color={c.paper} ink={c.red} onPress={() => retire(p)} accessibilityLabel={`Retire ${p.label}`} />} />
          )) : <Empty emoji="🔌" title="No provider linked" sub="Link the WhatsApp Business account and the SMS gateway to start sending approved templates." />}
        </View>
      )}</Load> : tab === 'quotas' ? <Load q={st}>{(s) => (
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>Monthly allowance per channel. No row means unlimited. The platform default applies to organisations without their own row. Essential messages never stop at the limit.</T>
          <Btn title="Set an allowance" onPress={() => setQuota(true)} style={{ alignSelf: 'flex-start' }} />
          {s.quotas.length ? s.quotas.map((q) => <Row key={q.id} title={`${q.organisation ?? 'Platform default'} · ${CH[q.channel]}`} sub={`${q.monthly_limit == null ? 'Unlimited' : `${q.monthly_limit} a month`}${q.addon_key ? ` · add-on ${q.addon_key}` : ''}`} />) : <Empty emoji="🎚️" title="No allowances set" sub="Everyone is unlimited until you set one." />}
        </View>
      )}</Load> : tab === 'numbers' ? <WhatsAppNumbers /> : tab === 'templates' ? <TemplatesPanel canWrite isPlatform /> : <UsagePanel />}

      <FormSheet visible={linking} onClose={() => setLinking(false)} title="Link an account" submitLabel="Link" fields={linkFields} initial={{ kind: 'whatsapp_cloud' }}
        onSubmit={async (v) => {
          const config = Object.fromEntries(PROVIDER_FIELDS[v.kind].map(([key]) => [key, v[`cfg_${v.kind}_${key}`]]).filter(([, val]) => val));
          const r = await api.post('/admin/communications/providers', { kind: v.kind, label: v.label, sender_label: v.sender_label || undefined, organisation_id: v.organisation_id || undefined, config });
          setWebhook(r.webhook_path); st.reload();
        }} />
      <FormSheet visible={quota} onClose={() => setQuota(false)} title="Set an allowance" submitLabel="Save"
        fields={[
          { key: 'channel', label: 'Channel', type: 'chips', options: CHANNEL_OPTIONS },
          { key: 'organisation_id', label: 'Organisation', type: 'entity', entityKind: 'person', noun: 'organisation', options: orgs.map((o) => ({ id: o.id, label: o.name, sub: o.city })), optional: true, hint: 'Leave empty for the platform default' },
          { key: 'unlimited', label: 'Unlimited', type: 'switch' },
          { key: 'monthly_limit', label: 'Messages a month', type: 'stepper', min: 0, max: 1000000, step: 100, default: 1000, show: (v) => !v.unlimited },
          { key: 'addon_key', label: 'Paid add-on this belongs to', optional: true, hint: 'A label such as sms_pack_s; no price is fixed in the app' },
        ]} initial={{ channel: 'whatsapp', unlimited: false }}
        onSubmit={async (v) => { await api.post('/admin/communications/quotas', { channel: v.channel, organisation_id: v.organisation_id || undefined, monthly_limit: v.unlimited ? null : Number(v.monthly_limit ?? 1000), addon_key: v.addon_key || undefined }); st.reload(); toast('Allowance saved'); }} />
      <Sheet visible={!!webhook} onClose={() => setWebhook(null)} title="Account linked">
        <T size={13}>Point the provider's delivery-receipt and reply webhook at:</T>
        <T weight="700" selectable style={{ marginVertical: 8 }}>{webhook}</T>
        <T size={12} color={c.mute}>Receipts are accepted only with a valid signature from the secrets you just entered.</T>
      </Sheet>
    </Tabs>
  );
}

// ---------------------------------------------------------------- the person's own controls (Notifications screen)
const LOCALES_FALLBACK = [{ code: 'en-IN', label: 'English' }];

/** Which kinds of WhatsApp / SMS message a person wants, their language, and the consent on record. Their numbers are in NumberCard. */
export function CommsPrefs({ onChanged }) {
  const { toast } = useSession();
  const cat = useCatalogue();
  const prefs = useLoad(() => api.get('/me/notification-preferences'), []);
  const consents = useLoad(() => api.get('/me/communication-consents', { limit: 6 }), []);
  const set = async (patch) => { try { await api.patch('/me/notification-preferences', patch); prefs.reload(); onChanged?.(); } catch (e) { toast(e.message); } };
  if (prefs.loading && !prefs.data) return <Card><Loading /></Card>;
  if (prefs.error) return <Card><ErrorBox error={prefs.error} onRetry={prefs.reload} /></Card>;
  const off = prefs.data.comm_categories_off ?? [];
  return (
    <Card>
      <T weight="700">What can come by WhatsApp or SMS</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {(cat.data?.categories ?? []).map((k) => <Chip key={k.key} label={k.label} active={!off.includes(k.key)} onPress={() => set({ comm_categories_off: off.includes(k.key) ? off.filter((x) => x !== k.key) : [...off, k.key] })} />)}
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 6 }}>Safety and venue-change notices are essential and cannot be switched off. Replying STOP to any message opts you out of everything else on that channel. Messages about a young player go to their guardians' own numbers.</T>
      <T weight="700" size={13} style={{ marginTop: 12 }}>Message language</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        {(cat.data?.locales ?? LOCALES_FALLBACK).map((l) => <Chip key={l.code} label={l.label} active={prefs.data.comm_locale === l.code} onPress={() => set({ comm_locale: l.code })} />)}
      </View>
      {consents.data?.length ? <>
        <T weight="700" size={13} style={{ marginTop: 12 }}>Consent on record</T>
        {consents.data.map((x) => <T key={x.id} size={12} color={c.mute}>{CH[x.channel]} · {x.action === 'opt_in' ? 'agreed' : 'opted out'} · {String(x.source).replaceAll('_', ' ')} · {stamp(x.created_at)}</T>)}
      </> : null}
    </Card>
  );
}
