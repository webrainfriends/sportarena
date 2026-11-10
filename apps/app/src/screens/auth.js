import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../api';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Field, Screen, Sheet, T } from '../ui';
import { c, grad, fam } from '../theme';
import { ROLES } from '../roles';
import { INTENT_COPY } from '../market/intent';
import GoogleButton from '../google-button';
import AppleButton from '../apple-button';
import { OrgSsoButton, SsoFinish } from '../sso';
import { Logo } from '../logo';
import { Wordmark } from '../wordmark';
import { t } from '../i18n';
import { CountryPicker, countryName } from '../country-picker';
import { locale, deviceZone } from '../locale';


const DEMOS = [['aarav', 'Aarav · Athlete'], ['kavya_events', 'Kavya · Organizer'], ['arena_one', 'Arena One · Venue'], ['volt_drink', 'Volt · Sponsor'], ['dr_rhea', 'Dr Rhea · Doctor']];

// `intent` (from the public marketplace) says what the visitor came to do, so the sign-in feels guided and returns them to it.
const INTENT_ROLE = { advertise: 'sponsor' };

const TZ_COUNTRY = { 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Colombo': 'LK', 'Asia/Dubai': 'AE', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Bangkok': 'TH', 'America/New_York': 'US', 'America/Los_Angeles': 'US', 'America/Chicago': 'US', 'America/Toronto': 'CA', 'Europe/London': 'GB', 'Australia/Sydney': 'AU' };
const inferDeviceCountry = () => { try { const reg = new Intl.Locale(locale).region; if (reg && /^[A-Z]{2}$/.test(reg)) return reg; } catch {} return TZ_COUNTRY[deviceZone] ?? null; };

export default function Auth({ intent, initialMode, onClose } = {}) {
  const { signIn } = useSession();
  const { push } = useNav();
  const [mode, setMode] = useState(initialMode ?? 'login');
  const deviceCountry = React.useMemo(inferDeviceCountry, []);
  const [f, setF] = useState({ roles: [INTENT_ROLE[intent?.action] ?? 'athlete'], country: deviceCountry ?? '' });
  const [countryPreview, setCountryPreview] = useState(null);
  const copy = intent ? INTENT_COPY[intent.action] : null;
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);
  const [mfaToken, setMfaToken] = useState(null);
  const [pending, setPending] = useState(null);       // a NEW Google/Apple person who has not chosen their role yet: { kind, credential, name, nonce }
  const [pickRoles, setPickRoles] = useState([INTENT_ROLE[intent?.action] ?? 'athlete']);
  const [ssoParams, setSsoParams] = useState(null);   // callback values of an organisation sign-in that returned in-app (native)

  // Links from security emails open the app with ?reset_password=<code> or ?verify_email=<code>.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof location === 'undefined') return;
    const q = new URLSearchParams(location.search);
    const clean = () => { try { window.history.replaceState(null, '', location.pathname); } catch { /* ignore */ } };
    if (q.get('reset_password')) { setF((p) => ({ ...p, code: q.get('reset_password') })); setMode('reset'); clean(); }
    else if (q.get('apple_error')) { setErr(q.get('apple_error')); clean(); }
    else if (q.get('apple_role')) { setPending({ kind: 'apple_web' }); clean(); }
    else if (q.get('apple_mfa')) { setMfaToken(q.get('apple_mfa')); setF((p) => ({ ...p, mfa: '' })); setMode('mfa'); clean(); }
    else if (q.get('verify_email')) {
      api.post('/auth/verify-email', { token: q.get('verify_email') }).then(() => setInfo(t('auth.email_confirmed')), (e) => setErr(e.message));
      clean();
    }
  }, []);
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const toggle = (r) => setF((p) => ({ ...p, roles: p.roles.includes(r) ? p.roles.filter((x) => x !== r) : [...p.roles, r] }));

  // Fetch residency preview when country changes in registration form
  useEffect(() => {
    if (mode !== 'register' || !f.country) { setCountryPreview(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.get('/data-residency/preview', { country: f.country }).then((r) => { if (!cancelled) setCountryPreview(r); }).catch(() => {});
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [f.country, mode]);

  const saveCountryAfterSignIn = async (country) => {
    if (!country) {
      // No country could be inferred — send to DataResidency screen to pick it
      push('DataResidency');
      return;
    }
    try {
      await api.patch('/me/home-country', { home_country: country });
      const preview = countryPreview ?? await api.get('/data-residency/preview', { country });
      if (!preview?.supported) push('DataResidencyConsent', { country });
    } catch { /* non-fatal */ }
  };

  const withGoogle = async (credential) => {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const res = await api.post('/auth/google', { credential, require_role: true });
      if (res.needs_role) { setPending({ kind: 'google', credential, suggested_country: res.suggested_country }); return; }
      if (res.mfa_required) { setMfaToken(res.mfa_token); setF((p) => ({ ...p, mfa: '' })); setMode('mfa'); return; }
      await signIn(res);
      await saveCountryAfterSignIn(res.suggested_country || deviceCountry);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const withApple = async ({ credential, name, nonce }) => {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const res = await api.post('/auth/apple', { credential, name, nonce, require_role: true });
      if (res.needs_role) { setPending({ kind: 'apple', credential, name, nonce }); return; }
      if (res.mfa_required) { setMfaToken(res.mfa_token); setF((p) => ({ ...p, mfa: '' })); setMode('mfa'); return; }
      await signIn(res);
      await saveCountryAfterSignIn(deviceCountry);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  // A new Google/Apple person has chosen their role(s): the account is created with them, then they are signed in.
  const finishRole = async () => {
    if (!pending || !pickRoles.length) return;
    setBusy(true); setErr(null);
    try {
      const res = pending.kind === 'google' ? await api.post('/auth/google', { credential: pending.credential, roles: pickRoles })
        : pending.kind === 'apple' ? await api.post('/auth/apple', { credential: pending.credential, name: pending.name, nonce: pending.nonce, roles: pickRoles })
          : await api.post('/auth/apple/complete', { roles: pickRoles });
      setPending(null);
      if (res.mfa_required) { setMfaToken(res.mfa_token); setF((p) => ({ ...p, mfa: '' })); setMode('mfa'); return; }
      await signIn(res);
      await saveCountryAfterSignIn((pending?.suggested_country) || deviceCountry);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const togglePick = (r) => setPickRoles((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));

  const submit = async () => {
    setBusy(true); setErr(null); setInfo(null);
    try {
      if (mode === 'forgot') {
        const r = await api.post('/auth/password-reset', { email: f.email });
        setInfo(r.message); setMode('reset'); return;
      }
      if (mode === 'reset') {
        await api.post('/auth/password-reset/confirm', { token: (f.code ?? '').trim(), new_password: f.password });
        setF((p) => ({ ...p, password: '', code: '' })); setMode('login'); setInfo(t('auth.password_changed')); return;
      }
      if (mode === 'mfa') {
        await signIn(await api.post('/auth/login/mfa', { mfa_token: mfaToken, code: (f.mfa ?? '').trim() }));
        return;
      }
      if (mode === 'register' && !f.country) { setErr(t('residency.country_required')); setBusy(false); return; }
      const res = mode === 'login'
        ? await api.post('/auth/login', { email: f.email, password: f.password })
        : await api.post('/auth/register', { handle: (f.handle ?? '').toLowerCase(), display_name: f.display_name, email: f.email, password: f.password, roles: f.roles.length ? f.roles : ['athlete'], phone: f.phone || undefined, full_name: f.full_name || undefined });
      if (res.mfa_required) { setMfaToken(res.mfa_token); setF((p) => ({ ...p, mfa: '', password: '' })); setMode('mfa'); return; }
      await signIn(res);
      if (mode === 'register') await saveCountryAfterSignIn(f.country);
    } catch (e) {
      setErr(e.message);
      if (mode === 'mfa' && /sign in again|expired/i.test(e.message)) { setMode('login'); setMfaToken(null); }
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <Sheet visible={!!pending} onClose={() => setPending(null)} title={t('auth.choose_role')}>
        <T size={13} color={c.mute}>{t('auth.choose_role_sub')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 12 }}>
          {ROLES.map(([k, l]) => <Chip key={k} label={l} active={pickRoles.includes(k)} onPress={() => togglePick(k)} />)}
        </View>
        {err ? <T color={c.red} size={13} weight="600">{err}</T> : null}
        <Btn title={t('auth.choose_role_continue')} onPress={finishRole} loading={busy} disabled={busy || !pickRoles.length} accessibilityLabel={t('auth.choose_role_continue')} />
      </Sheet>
      {onClose ? <Pressable onPress={onClose} style={{ paddingTop: 14, paddingBottom: 2, alignSelf: 'flex-start' }}><T color={c.pink} weight="700">{t('auth.back_arena')}</T></Pressable> : null}
      {copy ? (
        <View style={{ backgroundColor: c.pinkSoft, borderRadius: 18, padding: 16, marginTop: 8, gap: 4 }}>
          <T weight="800" size={16} color={c.pink}>{copy[0]}</T>
          {intent.title ? <T weight="700" size={14}>“{intent.title}”</T> : null}
          <T size={13} color={c.mute} style={{ lineHeight: 19 }}>{copy[1]}</T>
        </View>
      ) : null}
      <LinearGradient colors={grad.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 28, padding: 26, minHeight: 190, justifyContent: 'flex-end', marginTop: 20, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', right: -40, top: -60, width: 200, height: 200, borderRadius: 100, backgroundColor: '#fff', opacity: 0.12 }} />
        <View style={{ position: 'absolute', right: 80, bottom: -60, width: 120, height: 120, borderRadius: 60, backgroundColor: '#fff', opacity: 0.08 }} />
        <Logo size={96} style={{ marginBottom: 14 }} />
        <Text style={[fam, { color: '#fff', opacity: 0.65, fontWeight: '700', fontSize: 12, letterSpacing: 2.5 }]}>{t('auth.home_of_sport')}</Text>
        <Wordmark width={300} tagline onDark style={{ marginTop: 10 }} />
        <T color="#E5EAF5" weight="500" size={15} style={{ marginTop: 8, lineHeight: 22 }}>{t('auth.tagline')}</T>
      </LinearGradient>

      {['login', 'register'].includes(mode) ? <View style={{ flexDirection: 'row', backgroundColor: c.line, borderRadius: 999, padding: 4, marginTop: 20 }}>
        {[['login', t('auth.login')], ['register', t('auth.register')]].map(([k, l]) => (
          <Pressable key={k} onPress={() => setMode(k)} style={{ flex: 1, paddingVertical: 11, borderRadius: 999, alignItems: 'center', backgroundColor: mode === k ? c.paper : 'transparent' }}>
            <T weight="700" size={14} color={mode === k ? c.ink : c.mute}>{l}</T>
          </Pressable>
        ))}
      </View> : null}
      <Card style={{ marginTop: 12 }} pad={20}>
        <View style={{ gap: 16 }}>
          {mode === 'register' && <>
            <Field label={t('auth.handle')} value={f.handle} onChangeText={set('handle')} placeholder="goal_machine" hint={t('auth.handle_hint')} />
            <Field label={t('auth.display_name')} value={f.display_name} onChangeText={set('display_name')} placeholder="Priya Sharma" />
          </>}
          {info ? <T color={c.mint} weight="700" size={13} accessibilityRole="alert">{info}</T> : null}
          {mode === 'mfa' ? <>
            <T weight="800" size={16}>{t('auth.mfa_title')}</T>
            <T size={13} color={c.mute}>{t('auth.mfa_help')}</T>
            <Field label={t('auth.code')} value={f.mfa} onChangeText={set('mfa')} placeholder="123456" keyboardType="number-pad" />
          </> : null}
          {mode === 'forgot' ? <>
            <T weight="800" size={16}>{t('auth.forgot_title')}</T>
            <T size={13} color={c.mute}>{t('auth.forgot_help')}</T>
            <Field label={t('auth.email')} value={f.email} onChangeText={set('email')} keyboardType="email-address" placeholder="you@example.com" />
          </> : null}
          {mode === 'reset' ? <>
            <T weight="800" size={16}>{t('auth.reset_title')}</T>
            <T size={13} color={c.mute}>{t('auth.reset_help')}</T>
            <Field label={t('auth.reset_code')} value={f.code} onChangeText={set('code')} placeholder="sp_..." />
            <Field label={t('auth.new_password')} value={f.password} onChangeText={set('password')} secure placeholder={t('auth.password_ph')} />
          </> : null}
          {['login', 'register'].includes(mode) ? <>
            <Field label={t('auth.email')} value={f.email} onChangeText={set('email')} keyboardType="email-address" placeholder="you@example.com" />
            <Field label={t('auth.password')} value={f.password} onChangeText={set('password')} secure placeholder={t('auth.password_ph')} />
          </> : null}
          {mode === 'register' && <>
            <View style={{ gap: 8 }}>
              <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('auth.i_am')}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {ROLES.map(([k, l]) => <Chip key={k} label={l} active={f.roles.includes(k)} onPress={() => toggle(k)} />)}
              </View>
            </View>
            <View style={{ backgroundColor: c.bg, borderRadius: 14, padding: 14, gap: 12 }}>
              <View>
                <T weight="700" size={14}>{t('auth.private_title')}</T>
                <T size={12} color={c.mute} style={{ marginTop: 2, lineHeight: 18 }}>{t('auth.private_body')}</T>
              </View>
              <Field label={t('auth.full_name')} value={f.full_name} onChangeText={set('full_name')} />
              <Field label={t('auth.phone')} value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
            </View>
            <CountryPicker label={t('residency.country_label')} value={f.country ?? ''} onChange={set('country')} hint={f.country ? (countryPreview === null ? t('residency.preview_loading') : countryPreview?.supported ? t('residency.supported_banner', { region: countryName(f.country) }) : t('residency.unsupported_banner', { country: countryName(f.country) })) : t('residency.country_required_hint')} />
          </>}
          {err ? <T color={c.red} weight="600" size={13}>{err}</T> : null}
          <Btn title={{ login: t('auth.login'), register: t('auth.btn_register'), mfa: t('auth.btn_mfa'), forgot: t('auth.btn_forgot'), reset: t('auth.btn_reset') }[mode]} onPress={submit} loading={busy} />
          {['login', 'register'].includes(mode) ? <>
            <T size={12} color={c.mute} style={{ textAlign: 'center' }}>{t('auth.or')}</T>
            <GoogleButton onCredential={withGoogle} onError={setErr} />
            <AppleButton onCredential={withApple} onError={setErr} />
            {mode === 'login' ? <OrgSsoButton email={f.email} onResult={setSsoParams} onError={setErr} /> : null}
            <T size={11} color={c.mute} style={{ textAlign: 'center', lineHeight: 16 }}>{t('auth.review_note')}</T>
          </> : null}
          {mode === 'login' ? <Pressable onPress={() => { setErr(null); setInfo(null); setMode('forgot'); }} accessibilityRole="button" style={{ alignSelf: 'center', paddingVertical: 8 }}><T color={c.pink} weight="700" size={13}>{t('auth.forgot_link')}</T></Pressable> : null}
          {mode === 'forgot' ? <Pressable onPress={() => { setErr(null); setMode('reset'); }} accessibilityRole="button" style={{ alignSelf: 'center', paddingVertical: 8 }}><T color={c.pink} weight="700" size={13}>{t('auth.have_code')}</T></Pressable> : null}
          {['forgot', 'reset', 'mfa'].includes(mode) ? <Pressable onPress={() => { setErr(null); setInfo(null); setMfaToken(null); setMode('login'); }} accessibilityRole="button" style={{ alignSelf: 'center', paddingVertical: 8 }}><T color={c.mute} weight="700" size={13}>{t('auth.back_login')}</T></Pressable> : null}
        </View>
      </Card>

      <Sheet visible={!!ssoParams} onClose={() => setSsoParams(null)} title={t('auth.org_signin')}>
        {ssoParams ? <SsoFinish params={ssoParams} onDone={() => setSsoParams(null)} onCancel={() => setSsoParams(null)} /> : null}
      </Sheet>

      {__DEV__ && mode === 'login' ? (
        <Card style={{ marginTop: 14 }} pad={14}>
          <T weight="700" size={13}>Demo accounts <T size={12} color={c.mute}>· password: sportarena-demo</T></T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {DEMOS.map(([h, l]) => <Chip key={h} label={l} active={false} onPress={() => setF({ ...f, email: `${h}@demo.sportarena.dev`, password: 'sportarena-demo' })} />)}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}
