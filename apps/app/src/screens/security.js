// Account security on the Me screen: API tokens (scopes, expiry, resources), signed-in devices, two-step verification, email, password.
import React, { useState } from 'react';
import { Linking, Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField } from '../pickers';
import { EntityPicker } from '../entity-picker';
import { QrCode } from './passport';
import { c } from '../theme';

const SCOPES = [
  ['read', 'Read', 'View data your account can see'],
  ['write', 'Write', 'Create and change things (includes read)'],
  ['payment', 'Payments', 'Pay, top up and settle money'],
  ['clinical', 'Health data', 'Medical records, appointments, wellness'],
  ['admin', 'Admin', 'Platform administration and managing tokens'],
];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map(([k, l]) => [k, l]));
const RESOURCE_KINDS = [['venue', 'Venues'], ['team', 'Teams'], ['event', 'Events'], ['organisation', 'Organisations']];

const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  if (m < 60 * 36) return `${Math.round(m / 60)} hours ago`;
  return `${Math.round(m / 1440)} days ago`;
};
/** "Chrome on Windows"-style label from a user agent; the raw string is never shown. */
export function deviceLabel(ua) {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  const app = /Expo|okhttp|CFNetwork/.test(ua) ? 'Gotmygame app' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'App or browser';
  return os ? `${app} on ${os}` : app;
}
const copy = async (text, toast, what) => {
  try {
    if (Platform.OS === 'web' && navigator.clipboard) { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
    else await Share.share({ message: text });
  } catch { toast('Could not copy. Select the text and copy it by hand.'); }
};

/** Pick venues/teams/events/organisations a token may touch. Search-and-pick from the person's own, never typed ids. */
function ResourcePicker({ value, onChange }) {
  const { user } = useSession();
  const [kind, setKind] = useState('venue');
  const lists = useLoad(async () => {
    const safe = (p) => p.catch(() => []);
    const [venue, team, event, organisation] = await Promise.all([
      safe(api.get('/me/venues')), safe(api.get('/teams', { mine: true, limit: 100 })), safe(api.get('/events', { organizer_id: user.id, limit: 100 })), safe(api.get('/organisations')),
    ]);
    const item = (x, sub) => ({ id: x.id, label: x.name ?? x.title, sub: sub ?? [x.sport, x.city].filter(Boolean).join(' · '), emoji: x.emoji });
    return { venue: venue.map((x) => item(x, x.city)), team: team.map((x) => item(x)), event: event.map((x) => item(x, x.starts_on ?? x.sport_slug)), organisation: organisation.map((x) => item(x, x.kind)) };
  }, [user.id]);
  const picked = (k) => (value[k] ?? []);
  const count = Object.values(value).reduce((n, l) => n + l.length, 0);
  return (
    <View style={{ gap: 8 }}>
      <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>LIMIT TO SPECIFIC ITEMS (OPTIONAL)</T>
      <T size={12} color={c.mute}>{count ? `${count} selected. The token will only work on these.` : 'Nothing selected: the token works on everything its permissions allow.'}</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {RESOURCE_KINDS.map(([k, l]) => <Chip key={k} label={`${l}${picked(k).length ? ` (${picked(k).length})` : ''}`} active={kind === k} onPress={() => setKind(k)} />)}
      </View>
      {lists.loading ? <T size={12} color={c.mute}>Loading your items…</T> : (lists.data?.[kind]?.length
        ? <EntityPicker key={kind} kind="team" noun={RESOURCE_KINDS.find(([k]) => k === kind)[1].slice(0, -1).toLowerCase()} multi label={RESOURCE_KINDS.find(([k]) => k === kind)[1]} options={lists.data[kind]} value={picked(kind)} onChange={(v) => onChange({ ...value, [kind]: v })} />
        : <T size={12} color={c.mute}>You have no {RESOURCE_KINDS.find(([k]) => k === kind)[1].toLowerCase()} to choose from.</T>)}
    </View>
  );
}

function NewTokenSheet({ visible, onClose, onCreated }) {
  const { user } = useSession();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(['read']);
  const [expiry, setExpiry] = useState(undefined);
  const [res, setRes] = useState({});
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const options = SCOPES.filter(([k]) => k !== 'admin' || user.roles.includes('admin'));
  const toggle = (k) => setScopes((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const today = new Date().toISOString().slice(0, 10);
  const submit = async () => {
    if (!name.trim()) return setErr('Give the token a name so you can recognise it later.');
    if (!scopes.length) return setErr('Choose at least one permission.');
    setBusy(true); setErr(null);
    try {
      const resources = RESOURCE_KINDS.flatMap(([k]) => (res[k] ?? []).map((r) => ({ type: k, id: r.id })));
      const t = await api.post('/me/tokens', {
        name: name.trim(), scopes,
        expires_at: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : undefined,
        resources: resources.length ? resources : undefined,
      });
      setName(''); setScopes(['read']); setExpiry(undefined); setRes({});
      onCreated(t.token);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="New API token">
      <Field label="Name" value={name} onChangeText={setName} placeholder="My Claude agent" />
      <View style={{ gap: 8 }}>
        <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>WHAT IT MAY DO</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {options.map(([k, l]) => <Chip key={k} label={l} active={scopes.includes(k)} onPress={() => toggle(k)} />)}
        </View>
        {options.filter(([k]) => scopes.includes(k)).map(([k, , d]) => <T key={k} size={12} color={c.mute}>• {SCOPE_LABEL[k]}: {d}</T>)}
        <T size={12} color={c.mute}>A token can never do more than your own account can.</T>
      </View>
      <DateField label="Expires on" value={expiry} onChange={setExpiry} optional min={today} hint={expiry ? 'The token stops working at the end of this day.' : 'No date: the token works until you revoke it.'} />
      <ResourcePicker value={res} onChange={setRes} />
      {err ? <T color={c.red} weight="600" size={13} accessibilityRole="alert">{err}</T> : null}
      <Btn title="Create token" onPress={submit} loading={busy} />
    </Sheet>
  );
}

export function TokensSection({ mcpUrl }) {
  const { toast } = useSession();
  const toks = useLoad(() => api.get('/me/tokens'), []);
  const [form, setForm] = useState(false);
  const [secret, setSecret] = useState(null);
  const active = (toks.data ?? []).filter((t) => !t.revoked_at);
  return (
    <Section title="Agents & API (MCP)" color={c.violet}>
      <Card color={c.violetSoft}>
        <T weight="700">Everything in this app is also an API and an MCP tool. Create a token, choose what it may do, and plug Gotmygame into your AI agent.</T>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>MCP endpoint: {mcpUrl}</T>
        {secret ? (
          <Card color={c.sunSoft} style={{ marginTop: 10 }} pad={12}>
            <T weight="900">Copy it now. It is shown only once.</T>
            <T selectable size={12} weight="700" style={{ marginTop: 4 }}>{secret}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Btn small title="Copy" onPress={() => copy(secret, toast, 'Token')} />
              <Btn small title="I have saved it" color={c.paper} ink={c.ink} onPress={() => setSecret(null)} />
            </View>
          </Card>
        ) : null}
        {toks.error ? <ErrorBox error={toks.error} onRetry={toks.reload} /> : null}
        {!toks.loading && !toks.error && !active.length ? <Empty emoji="🔑" title="No API tokens yet" sub="Create one to let a script or AI agent act for you, with only the permissions you choose." /> : null}
        {active.map((t) => (
          <View key={t.id} style={{ marginTop: 10, gap: 4, paddingTop: 10, borderTopWidth: 1, borderColor: c.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <T weight="800" style={{ flex: 1 }}>🔑 {t.name}</T>
              <Btn small title="Revoke" color={c.paper} ink={c.red} onPress={async () => { await api.del(`/me/tokens/${t.id}`); toast('Token revoked. It stopped working immediately.'); toks.reload(); }} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {t.legacy_full ? <Tag label="Full access (created before permissions existed)" color={c.red} /> : t.scopes.map((s) => <Tag key={s} label={SCOPE_LABEL[s] ?? s} color={c.cyan} />)}
              {t.resources?.length ? <Tag label={`Limited to ${t.resources.length} item${t.resources.length === 1 ? '' : 's'}`} color={c.sun} /> : null}
            </View>
            <T size={12} color={t.expired ? c.red : c.mute}>{t.expired ? `Expired ${when(t.expires_at)}` : t.expires_at ? `Expires ${when(t.expires_at)}` : 'Never expires'} · Last used {ago(t.last_used_at)}</T>
            {t.legacy_full ? <T size={12} color={c.mute}>Create a new token with fewer permissions, then revoke this one.</T> : null}
          </View>
        ))}
        <Btn small title="New API token" color={c.violet} onPress={() => setForm(true)} style={{ marginTop: 12, alignSelf: 'flex-start' }} />
      </Card>
      <NewTokenSheet visible={form} onClose={() => setForm(false)} onCreated={(tok) => { setSecret(tok); setForm(false); toks.reload(); }} />
    </Section>
  );
}

/** Turn on two-step verification: password, scan/enter the secret, confirm a code, then save the recovery codes (shown once). */
function MfaSetupSheet({ visible, onClose, onDone }) {
  const { toast } = useSession();
  const [step, setStep] = useState('password');
  const [pw, setPw] = useState('');
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = (fn) => async () => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const close = () => { const enabled = step === 'codes'; setStep('password'); setPw(''); setCode(''); setSetup(null); setCodes(null); setErr(null); onClose(); if (enabled) onDone(); };
  return (
    <Sheet visible={visible} onClose={close} title="Two-step verification">
      {step === 'password' ? <>
        <T size={13} color={c.mute}>After your password, you will also enter a 6-digit code from an authenticator app. Confirm your password to start.</T>
        <Field label="Password" value={pw} onChangeText={setPw} secure />
        {err ? <T color={c.red} weight="600" size={13} accessibilityRole="alert">{err}</T> : null}
        <Btn title="Continue" loading={busy} onPress={run(async () => { setSetup(await api.post('/me/mfa/setup', { password: pw })); setPw(''); setStep('code'); })} />
      </> : null}
      {step === 'code' && setup ? <>
        <T size={13} color={c.mute}>Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), or enter the key by hand.</T>
        <View style={{ alignSelf: 'center' }}><QrCode value={setup.otpauth_uri} size={190} label="QR code for your authenticator app" /></View>
        <T selectable size={13} weight="700" style={{ textAlign: 'center' }}>{setup.secret.match(/.{1,4}/g).join(' ')}</T>
        {Platform.OS !== 'web' ? <Btn small title="Open in authenticator app" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(setup.otpauth_uri)} style={{ alignSelf: 'center' }} /> : null}
        <Field label="6-digit code" value={code} onChangeText={(x) => setCode(x.replace(/[^0-9]/g, '').slice(0, 6))} keyboardType="number-pad" placeholder="123456" />
        {err ? <T color={c.red} weight="600" size={13} accessibilityRole="alert">{err}</T> : null}
        <Btn title="Turn on" loading={busy} onPress={run(async () => { const r = await api.post('/me/mfa/enable', { code }); setCodes(r.recovery_codes); setStep('codes'); })} />
      </> : null}
      {step === 'codes' && codes ? <>
        <T weight="800">Save your recovery codes</T>
        <T size={13} color={c.mute}>Each code works once if you lose your phone. They are shown only now. Store them somewhere safe.</T>
        <Card color={c.sunSoft} pad={12}>{codes.map((x) => <T key={x} selectable weight="700" style={{ fontVariant: ['tabular-nums'] }}>{x}</T>)}</Card>
        <Btn small title="Copy all" color={c.paper} ink={c.ink} onPress={() => copy(codes.join('\n'), toast, 'Recovery codes')} style={{ alignSelf: 'flex-start' }} />
        <Btn title="I have saved them" onPress={close} />
      </> : null}
    </Sheet>
  );
}

export function SecuritySection() {
  const { toast, signOut } = useSession();
  const st = useLoad(() => api.get('/me/security'), []);
  const sess = useLoad(() => api.get('/me/sessions'), []);
  const [mfaSheet, setMfaSheet] = useState(false);
  const [offForm, setOffForm] = useState(false);
  const [pwForm, setPwForm] = useState(false);
  const s = st.data;
  return (
    <Section title="Account security" color={c.mint}>
      <Card color={c.mintSoft}>
        {st.error ? <ErrorBox error={st.error} onRetry={st.reload} /> : null}
        {s ? <>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800">Email {s.email_verified ? 'confirmed' : 'not confirmed yet'}</T>
              <T size={12} color={c.mute}>{s.email_verified ? 'We can reach you if you ever need to reset your password.' : 'Confirm it so you can recover your account.'}</T>
            </View>
            {!s.email_verified ? <Btn small title="Send email" onPress={async () => { try { await api.post('/me/email/verification'); toast('Check your inbox for the confirmation link'); } catch (e) { toast(e.message); } }} /> : <Tag label="Confirmed" color={c.mint} />}
          </View>
          <View style={{ height: 1, backgroundColor: c.line, marginVertical: 12 }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800">Two-step verification {s.mfa_enabled ? 'is on' : 'is off'}</T>
              <T size={12} color={c.mute}>
                {s.mfa_enabled ? `${s.recovery_codes_left} recovery code${s.recovery_codes_left === 1 ? '' : 's'} left.` : s.mfa_required_for_role ? 'Your role handles health or platform data, so you should turn this on.' : 'Adds a code from your phone after your password.'}
              </T>
            </View>
            {s.mfa_enabled ? <Btn small title="Turn off" color={c.paper} ink={c.red} onPress={() => setOffForm(true)} /> : <Btn small title="Turn on" onPress={() => setMfaSheet(true)} />}
          </View>
          <View style={{ height: 1, backgroundColor: c.line, marginVertical: 12 }} />
          <Btn small title="Change password" color={c.paper} ink={c.ink} onPress={() => setPwForm(true)} style={{ alignSelf: 'flex-start' }} />
        </> : null}
      </Card>

      <Card style={{ marginTop: 12 }}>
        <T weight="800">Where you are signed in</T>
        {sess.error ? <ErrorBox error={sess.error} onRetry={sess.reload} /> : null}
        {!sess.loading && !sess.error && !sess.data?.length ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>No device sessions to show. Sign in again to start one.</T> : null}
        {(sess.data ?? []).map((x) => (
          <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 10, marginTop: 10, borderTopWidth: 1, borderColor: c.line }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{deviceLabel(x.user_agent)} {x.current ? <Tag label="This device" color={c.mint} /> : null}</T>
              <T size={12} color={c.mute}>Active {ago(x.last_seen_at)} · signed in {when(x.created_at)}</T>
            </View>
            {!x.current ? <Btn small title="Sign out" color={c.paper} ink={c.red} onPress={async () => { await api.del(`/me/sessions/${x.id}`); toast('That device was signed out'); sess.reload(); }} /> : null}
          </View>
        ))}
        <Btn small title="Sign out everywhere" color={c.paper} ink={c.red} style={{ marginTop: 12, alignSelf: 'flex-start' }}
          onPress={async () => { try { await api.post('/auth/logout-all'); } catch { /* fall through to local sign-out */ } await signOut(); }} />
      </Card>

      <MfaSetupSheet visible={mfaSheet} onClose={() => setMfaSheet(false)} onDone={() => { st.reload(); sess.reload(); }} />
      <FormSheet visible={offForm} onClose={() => setOffForm(false)} title="Turn off two-step verification" submitLabel="Turn off"
        fields={[{ key: 'password', label: 'Password', type: 'secret' }, { key: 'code', label: 'Authenticator code or a recovery code', hint: 'Other devices will be signed out.' }]}
        onSubmit={async (v) => { await api.post('/me/mfa/disable', v); st.reload(); sess.reload(); return 'Two-step verification is off'; }} />
      <FormSheet visible={pwForm} onClose={() => setPwForm(false)} title="Change password" submitLabel="Change password"
        fields={[{ key: 'current_password', label: 'Current password', type: 'secret' }, { key: 'new_password', label: 'New password', type: 'secret', hint: 'At least 10 characters. Your other devices will be signed out.' }]}
        onSubmit={async (v) => { await api.post('/me/password', v); sess.reload(); return 'Password changed'; }} />
    </Section>
  );
}
