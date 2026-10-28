// Organisation single sign-on for the app (#521): "Continue with your organisation" on the sign-in screen, the return from the identity
// provider, and the one-time "confirm this is your account" step. The identity provider and all checks live on the server (complete_sso);
// this file only moves the person there and back. Web: a full-page redirect and back to /sso/callback. Native: the system browser sheet
// (expo-web-browser) returning to sportarena://sso/callback. Same API calls on every platform.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from './api';
import { storage } from './storage';
import { useSession } from './session';
import { Btn, ErrorBox, Field, Loading, Screen, T } from './ui';
import { c } from './theme';

const NATIVE_CALLBACK = 'sportarena://sso/callback';
const PENDING = 'sso_pending';

/** True on the web page the identity provider sends people back to. Read on every render, so it turns false once the page is cleaned up. */
export const isSsoCallback = () => Platform.OS === 'web' && typeof window !== 'undefined' && /\/sso\/callback\/?$/.test(window.location.pathname);
export const redirectUri = () => (Platform.OS === 'web' ? `${window.location.origin}/sso/callback` : NATIVE_CALLBACK);

/** Turn a callback URL (or search string) into the values complete_sso needs. */
export function readCallback(urlOrSearch) {
  const s = String(urlOrSearch ?? '');
  const q = new URLSearchParams(s.includes('?') ? s.slice(s.indexOf('?') + 1) : s.replace(/^\?/, ''));
  return { code: q.get('code'), state: q.get('state'), ticket: q.get('ticket'), connection_id: q.get('connection_id'), error: q.get('error') ?? q.get('error_description') };
}

/** Find the organisation behind an email and send the person to its identity provider. Resolves to callback params on native, never on web (page navigates). */
export async function beginOrgSso(email) {
  const d = await api.post('/auth/sso/discover', { email });
  if (!d.sso) return { none: true };
  const s = await api.post(`/auth/sso/${d.connection_id}/start`, { redirect_uri: redirectUri() });
  if (Platform.OS === 'web') {
    await storage.set(PENDING, JSON.stringify({ connection_id: d.connection_id }));
    window.location.href = s.url;
    return { redirecting: true, organisation: d.organisation_name };
  }
  const WebBrowser = require('expo-web-browser');
  const r = await WebBrowser.openAuthSessionAsync(s.url, NATIVE_CALLBACK);
  if (r.type !== 'success') return { cancelled: true };
  return { params: { ...readCallback(r.url), connection_id: readCallback(r.url).connection_id ?? d.connection_id } };
}

/** Add another organisation to the account you are signed in with (start_sso_link). */
export async function beginLinkSso(email) {
  const d = await api.post('/auth/sso/discover', { email });
  if (!d.sso) return { none: true };
  const s = await api.post(`/me/sso/${d.connection_id}/start`, { redirect_uri: redirectUri() });
  if (Platform.OS === 'web') { await storage.set(PENDING, JSON.stringify({ connection_id: d.connection_id })); window.location.href = s.url; return { redirecting: true }; }
  const WebBrowser = require('expo-web-browser');
  const r = await WebBrowser.openAuthSessionAsync(s.url, NATIVE_CALLBACK);
  if (r.type !== 'success') return { cancelled: true };
  return { params: { ...readCallback(r.url), connection_id: readCallback(r.url).connection_id ?? d.connection_id } };
}

/**
 * Finish a sign-in from the callback values. Shows what is needed next: a two-step code, the "sign in to your existing account to link it"
 * step (never an automatic merge), or the reason it was refused. onDone() runs once the person is signed in.
 */
export function SsoFinish({ params, onDone, onCancel }) {
  const { signIn } = useSession();
  const [step, setStep] = useState('working');       // working | mfa | link | error
  const [err, setErr] = useState(null);
  const [mfaToken, setMfaToken] = useState(null);
  const [link, setLink] = useState(null);
  const [f, setF] = useState({ email: '', password: '', code: '' });
  const [busy, setBusy] = useState(false);
  const ran = useRef(false);

  const handle = async (res) => {
    if (res.mfa_required) { setMfaToken(res.mfa_token); setStep('mfa'); return; }
    if (res.link_required) { setLink(res); setStep('link'); return; }
    await signIn(res);
    onDone?.();
  };
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        if (params.error) throw new Error('Your organisation sign-in did not complete. Please try again.');
        let connection_id = params.connection_id;
        if (!connection_id) { try { connection_id = JSON.parse((await storage.get(PENDING)) ?? '{}').connection_id; } catch { /* none */ } }
        await storage.del(PENDING);
        await handle(await api.post('/auth/sso/complete', params.ticket ? { ticket: params.ticket } : { connection_id, state: params.state, code: params.code }));
      } catch (e) { setErr(e.message); setStep('error'); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = (fn) => async () => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const submitMfa = guard(async () => handle(await api.post('/auth/login/mfa', { mfa_token: mfaToken, code: f.code.trim() })));
  const submitLink = guard(async () => {
    const res = await api.post('/auth/login', { email: f.email, password: f.password });
    if (res.mfa_required) { setMfaToken(res.mfa_token); setStep('mfa'); return; }
    await signIn(res);
    const linked = await api.post('/auth/sso/link', { link_token: link.link_token });
    await handle(linked);
  });

  if (step === 'working') return <View style={{ padding: 24 }}><Loading /><T color={c.mute} style={{ textAlign: 'center', marginTop: 8 }}>Signing you in with your organisation…</T></View>;
  return (
    <View style={{ gap: 12, padding: 16 }}>
      {step === 'error' ? (
        <>
          <ErrorBox error={{ message: err ?? 'Sign-in failed' }} />
          <Btn title="Back to sign in" onPress={onCancel} />
        </>
      ) : step === 'mfa' ? (
        <>
          <T weight="800" size={18}>Two-step verification</T>
          <T color={c.mute}>Enter the 6-digit code from your authenticator app, or a recovery code.</T>
          <Field label="Code" value={f.code} onChangeText={(x) => setF((p) => ({ ...p, code: x }))} keyboardType="number-pad" maxLength={20} />
          {err ? <T color={c.red}>{err}</T> : null}
          <Btn title="Verify" onPress={submitMfa} loading={busy} disabled={f.code.trim().length < 6} />
        </>
      ) : (
        <>
          <T weight="800" size={18}>You already have an account</T>
          <T color={c.mute}>{link?.message} We never join accounts automatically. Sign in below to confirm it is yours ({link?.email_hint}).</T>
          <Field label="Email" value={f.email} onChangeText={(x) => setF((p) => ({ ...p, email: x }))} keyboardType="email-address" />
          <Field label="Password" value={f.password} onChangeText={(x) => setF((p) => ({ ...p, password: x }))} secure />
          {err ? <T color={c.red}>{err}</T> : null}
          <Btn title="Sign in and link my organisation" onPress={submitLink} loading={busy} disabled={!f.email || !f.password} />
          <Btn title="Cancel" color={c.paper} ink={c.ink} onPress={onCancel} />
        </>
      )}
    </View>
  );
}

/** The web landing for /sso/callback after the identity provider sends the person back. */
export function SsoCallbackScreen() {
  const params = readCallback(window.location.search);
  const leave = () => { try { window.history.replaceState({}, '', '/'); } catch { /* ignore */ } window.location.reload(); };
  return <Screen><SsoFinish params={params} onDone={() => { try { window.history.replaceState({}, '', '/'); } catch { /* ignore */ } }} onCancel={leave} /></Screen>;
}

/** "Continue with your organisation": uses the email already typed on the sign-in form. */
export function OrgSsoButton({ email, onResult, onError }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await beginOrgSso(String(email ?? '').trim());
      if (r.none) onError?.('No organisation single sign-on was found for that email. Use your password or Google/Apple instead.');
      else if (r.params) onResult?.(r.params);
    } catch (e) { onError?.(e.message); } finally { setBusy(false); }
  };
  return <Btn title="Continue with your organisation" onPress={go} loading={busy} disabled={!/.+@.+\..+/.test(String(email ?? ''))} color={c.paper} ink={c.ink} accessibilityLabel="Continue with your organisation single sign-on" style={{ alignSelf: 'center', width: 300, maxWidth: '100%' }} />;
}
