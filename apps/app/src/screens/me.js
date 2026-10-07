import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api, MCP_URL } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, GradCard, H1, Loading, Row, Screen, Section, StatPill, T, Tag, Bubble } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, grad } from '../theme';

const mask = (v) => (v ? '••••••••' : '—');
const PII = [['email', '✉️ Email'], ['full_name', '🪪 Full name'], ['phone', '📱 Phone'], ['dob', '🎂 Date of birth'], ['national_id', '🆔 National ID'], ['address', '🏠 Address']];

export function Me() {
  const { user, signOut, refresh, toast } = useSession();
  const { push } = useNav();
  const [reveal, setReveal] = useState(false);
  const [edit, setEdit] = useState(false);
  const [sp, setSp] = useState(false);
  const [newToken, setNewToken] = useState(null);
  const [tokForm, setTokForm] = useState(false);
  const dash = useLoad(() => api.get('/dashboard'), []);
  const toks = useLoad(() => api.get('/me/tokens'), []);
  const sports = useLoad(() => api.get('/sports'), []);
  const d = dash.data;

  return (
    <Screen>
      <GradCard colors={[user.avatar_color ?? c.pink, c.violet]} style={{ marginTop: 8 }}>
        <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
          <Avatar user={user} size={72} />
          <View style={{ flex: 1 }}><H1 color="#fff" style={{ fontSize: 26 }}>{user.display_name}</H1><T color="#fff" weight="800">@{user.handle}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{user.roles.map((r) => <Tag key={r} label={r.replace('_', ' ')} color={c.lime} />)}</View></View>
        </View>
      </GradCard>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <StatPill value={d?.points ?? '–'} label="POINTS" color={c.lime} /><StatPill value={d?.trophies ?? '–'} label="TROPHIES" color={c.sun} /><StatPill value={d?.active_policies ?? '–'} label="POLICIES" color={c.cyan} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn small title="View my public page" emoji="👀" color={c.violet} onPress={() => push('Person', { id: user.id })} />
        <Btn small title="Add a sport role" emoji="🎽" color={c.cyan} ink={c.ink} onPress={() => setSp(true)} />
      </View>

      <Section title="Private details" emoji="🔐" color={c.mint}>
        <Card color={c.mintSoft}>
          <T size={12} color={c.mute} weight="700">Encrypted with AES-256-GCM before storage and decrypted only for you. Every read is audit-logged.</T>
          {PII.map(([k, l]) => (
            <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderColor: '#BFEFE0' }}>
              <T weight="800">{l}</T><T weight="700">{reveal ? user[k] ?? '—' : mask(user[k])}</T>
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Btn small title={reveal ? 'Hide' : 'Reveal'} emoji={reveal ? '🙈' : '👁️'} color={c.ink} onPress={() => setReveal(!reveal)} />
            <Btn small title="Edit" emoji="✏️" color={c.pink} onPress={() => setEdit(true)} />
          </View>
        </Card>
      </Section>

      <Section title="Agents & API (MCP)" emoji="🤖" color={c.violet}>
        <Card color={c.violetSoft}>
          <T weight="700">Everything in this app is also an API and an MCP tool. Create a token and plug SportArena into your AI agent.</T>
          <T size={12} color={c.mute} style={{ marginTop: 6 }}>MCP endpoint: {MCP_URL}</T>
          {newToken ? <Card color={c.sunSoft} style={{ marginTop: 10 }} pad={12}><T weight="900">Copy it now — shown once</T><T selectable size={12} weight="700" style={{ marginTop: 4 }}>{newToken}</T></Card> : null}
          {toks.data?.filter((t) => !t.revoked_at).map((t) => (
            <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <T weight="800">🔑 {t.name}</T><Btn small title="Revoke" color={c.paper} ink={c.red} onPress={async () => { await api.del(`/me/tokens/${t.id}`); toks.reload(); }} />
            </View>
          ))}
          <Btn small title="New API token" emoji="➕" color={c.violet} onPress={() => setTokForm(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
        </Card>
      </Section>

      <Btn title="Log out" emoji="👋" color={c.ink} onPress={signOut} style={{ marginTop: 28 }} />

      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Edit details" initial={{ display_name: user.display_name, bio: user.bio, full_name: user.full_name, phone: user.phone, dob: user.dob, national_id: user.national_id, address: user.address }}
        fields={[{ key: 'display_name', label: 'Display name', optional: true }, { key: 'bio', label: 'Bio', optional: true, type: 'multiline' }, { key: 'full_name', label: 'Full name 🔐', optional: true }, { key: 'phone', label: 'Phone 🔐', optional: true }, { key: 'dob', label: 'Date of birth (YYYY-MM-DD) 🔐', optional: true }, { key: 'national_id', label: 'National ID 🔐', optional: true }, { key: 'address', label: 'Address 🔐', optional: true, type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch('/me', v); await refresh(); return 'Saved & encrypted 🔐'; }} />
      <FormSheet visible={sp} onClose={() => setSp(false)} title="Add a sport role" submitLabel="Add"
        fields={[{ key: 'sport', label: 'Sport', type: 'choice', options: (sports.data ?? []).map((s) => ({ value: s.slug, label: `${s.emoji} ${s.name}` })) }, { key: 'role', label: 'Role', type: 'choice', options: ['athlete', 'coach', 'referee', 'physio', 'doctor'] }, { key: 'level', label: 'Level', type: 'choice', options: ['beginner', 'amateur', 'semi_pro', 'pro'] }, { key: 'position', label: 'Position', optional: true }, { key: 'license_no', label: 'License no. 🔐', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/sport-profiles', v); return 'Added 🎽'; }} />
      <FormSheet visible={tokForm} onClose={() => setTokForm(false)} title="New API token" submitLabel="Create" fields={[{ key: 'name', label: 'Name', placeholder: 'My Claude agent' }]}
        onSubmit={async (v) => { const t = await api.post('/me/tokens', v); setNewToken(t.token); toks.reload(); }} />
    </Screen>
  );
}
