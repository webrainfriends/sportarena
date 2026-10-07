import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../api';
import { useSession } from '../session';
import { Btn, Card, Chip, Field, Screen, T } from '../ui';
import { c, grad, fam } from '../theme';

const ROLES = [
  ['athlete', 'Athlete'], ['coach', 'Coach'], ['referee', 'Referee'], ['organizer', 'Organizer'],
  ['venue_manager', 'Venue'], ['sponsor', 'Sponsor'], ['physio', 'Physio'], ['doctor', 'Doctor'], ['supplier', 'Supplier'],
];
const DEMOS = [['aarav', 'Aarav · Athlete'], ['kavya_events', 'Kavya · Organizer'], ['arena_one', 'Arena One · Venue'], ['volt_drink', 'Volt · Sponsor'], ['dr_rhea', 'Dr Rhea · Doctor']];

export default function Auth() {
  const { signIn } = useSession();
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ roles: ['athlete'] });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const toggle = (r) => setF((p) => ({ ...p, roles: p.roles.includes(r) ? p.roles.filter((x) => x !== r) : [...p.roles, r] }));

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const res = mode === 'login'
        ? await api.post('/auth/login', { email: f.email, password: f.password })
        : await api.post('/auth/register', { handle: (f.handle ?? '').toLowerCase(), display_name: f.display_name, email: f.email, password: f.password, roles: f.roles.length ? f.roles : ['athlete'], phone: f.phone || undefined, full_name: f.full_name || undefined });
      await signIn(res);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <LinearGradient colors={grad.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 20, padding: 26, marginTop: 20, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', right: -30, top: -20, width: 120, height: 260, backgroundColor: c.lime, opacity: 0.16, transform: [{ skewX: '-18deg' }] }} />
        <View style={{ position: 'absolute', right: 60, top: -20, width: 36, height: 260, backgroundColor: '#fff', opacity: 0.08, transform: [{ skewX: '-18deg' }] }} />
        <Text style={[fam, { color: c.lime, fontWeight: '700', fontSize: 12, letterSpacing: 2.5 }]}>THE HOME OF SPORT</Text>
        <Text style={[fam, { color: '#fff', fontWeight: '800', fontSize: 40, letterSpacing: -1.2, marginTop: 10 }]}>SportArena</Text>
        <T color="#C6D0EA" weight="500" size={15} style={{ marginTop: 8, lineHeight: 22 }}>Teams. Fixtures. Venues. Performance. Everything your game runs on, in one place.</T>
      </LinearGradient>

      <View style={{ flexDirection: 'row', backgroundColor: '#E4E8F1', borderRadius: 12, padding: 4, marginTop: 20 }}>
        {[['login', 'Log in'], ['register', 'Create account']].map(([k, l]) => (
          <Pressable key={k} onPress={() => setMode(k)} style={{ flex: 1, paddingVertical: 11, borderRadius: 9, alignItems: 'center', backgroundColor: mode === k ? c.paper : 'transparent' }}>
            <T weight="700" size={14} color={mode === k ? c.ink : c.mute}>{l}</T>
          </Pressable>
        ))}
      </View>
      <Card style={{ marginTop: 12 }} pad={20}>
        <View style={{ gap: 16 }}>
          {mode === 'register' && <>
            <Field label="Handle" value={f.handle} onChangeText={set('handle')} placeholder="goal_machine" hint="Letters, numbers and _ · shown publicly" />
            <Field label="Display name" value={f.display_name} onChangeText={set('display_name')} placeholder="Priya Sharma" />
          </>}
          <Field label="Email" value={f.email} onChangeText={set('email')} keyboardType="email-address" placeholder="you@example.com" />
          <Field label="Password" value={f.password} onChangeText={set('password')} secure placeholder="10+ characters" />
          {mode === 'register' && <>
            <View style={{ gap: 8 }}>
              <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>I AM A…</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {ROLES.map(([k, l]) => <Chip key={k} label={l} active={f.roles.includes(k)} onPress={() => toggle(k)} color={c.pink} />)}
              </View>
            </View>
            <View style={{ backgroundColor: c.pinkSoft, borderRadius: 12, padding: 14, gap: 12 }}>
              <View>
                <T weight="700" size={14}>Private by design</T>
                <T size={12} color={c.mute} style={{ marginTop: 2, lineHeight: 18 }}>Your email, name, phone and ID are encrypted before they reach our database and are only decrypted for you.</T>
              </View>
              <Field label="Full name (optional)" value={f.full_name} onChangeText={set('full_name')} />
              <Field label="Phone (optional)" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
            </View>
          </>}
          {err ? <T color={c.red} weight="600" size={13}>{err}</T> : null}
          <Btn title={mode === 'login' ? 'Log in' : 'Create my account'} onPress={submit} loading={busy} />
        </View>
      </Card>

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
