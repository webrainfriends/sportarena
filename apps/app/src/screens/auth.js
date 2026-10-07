import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../api';
import { useSession } from '../session';
import { Btn, Card, Chip, Field, H1, Screen, T, Seg } from '../ui';
import { c, grad } from '../theme';

const ROLES = [
  ['athlete', '🏃', 'Athlete'], ['coach', '📣', 'Coach'], ['referee', '🟨', 'Referee'], ['organizer', '🎪', 'Organizer'],
  ['venue_manager', '🏟️', 'Venue'], ['sponsor', '💎', 'Sponsor'], ['physio', '💆', 'Physio'], ['doctor', '🩺', 'Doctor'], ['supplier', '📦', 'Supplier'],
];
const DEMOS = [['aarav', '🦁 Aarav (athlete)'], ['kavya_events', '🎪 Kavya (organizer)'], ['arena_one', '🏟️ Venue'], ['volt_drink', '⚡ Sponsor'], ['dr_rhea', '🩺 Doctor']];

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
      <LinearGradient colors={grad.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 28, borderWidth: 2.5, borderColor: c.ink, padding: 22, marginTop: 24, overflow: 'hidden' }}>
        <Text style={{ fontSize: 54, position: 'absolute', right: 16, top: 8 }}>⚽🏀🏏</Text>
        <Text style={{ fontSize: 64, marginTop: 30 }}>🏆</Text>
        <H1 color="#fff" style={{ fontSize: 44 }}>SportArena</H1>
        <T color="#fff" weight="800" size={16}>The home for everyone who dreams of sport. Teams. Games. Glory. ✨</T>
      </LinearGradient>

      <View style={{ marginTop: 20 }}>
        <Seg options={[{ value: 'login', label: 'Log in', emoji: '👋' }, { value: 'register', label: 'Join the arena', emoji: '🚀' }]} value={mode} onChange={setMode} color={c.pink} />
      </View>
      <Card style={{ marginTop: 10 }}>
        <View style={{ gap: 12 }}>
          {mode === 'register' && <>
            <Field label="Handle" value={f.handle} onChangeText={set('handle')} placeholder="goal_machine" hint="a-z, 0-9 and _ · public" />
            <Field label="Display name" value={f.display_name} onChangeText={set('display_name')} placeholder="Priya ⚡" />
          </>}
          <Field label="Email" value={f.email} onChangeText={set('email')} keyboardType="email-address" placeholder="you@example.com" />
          <Field label="Password" value={f.password} onChangeText={set('password')} secure placeholder="10+ characters" />
          {mode === 'register' && <>
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>I am a…</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {ROLES.map(([k, e, l]) => <Chip key={k} emoji={e} label={l} active={f.roles.includes(k)} onPress={() => toggle(k)} color={c.violet} />)}
              </View>
            </View>
            <Card color={c.mintSoft} pad={12}>
              <T weight="900">🔐 Private by design</T>
              <T size={12} color={c.mute} style={{ marginTop: 2 }}>Your email, name, phone and ID are encrypted before they touch our database and only ever decrypted for you.</T>
              <View style={{ gap: 10, marginTop: 10 }}>
                <Field label="Full name (optional)" value={f.full_name} onChangeText={set('full_name')} />
                <Field label="Phone (optional)" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
              </View>
            </Card>
          </>}
          {err ? <T color={c.red} weight="800">⚠️ {err}</T> : null}
          <Btn title={mode === 'login' ? "Let's go" : 'Create my account'} emoji="🔥" onPress={submit} loading={busy} />
        </View>
      </Card>

      {__DEV__ && mode === 'login' ? (
        <Card color={c.sunSoft} style={{ marginTop: 14 }} pad={12}>
          <T weight="900">🧪 Demo accounts <T size={12} color={c.mute}>(password: sportarena-demo)</T></T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {DEMOS.map(([h, l]) => <Chip key={h} label={l} active={false} onPress={() => setF({ ...f, email: `${h}@demo.sportarena.dev`, password: 'sportarena-demo' })} />)}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}
