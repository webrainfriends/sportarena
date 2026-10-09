import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api, MCP_URL } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, GradCard, H1, Loading, Row, Screen, Section, StatPill, T, Tag, Bubble } from '../ui';
import { FormSheet } from '../FormSheet';
import { FavouriteSports } from '../sportpicker';
import { c, grad } from '../theme';
import { useAvatarPhoto } from '../hero';
import { ROLES, roleLabel } from '../roles';
import { VerificationQueue, VerificationSection } from './verification';
import { CaseQueue } from './cases';
import { ProviderProfileSection } from './provider';

const mask = (v) => (v ? '••••••••' : '—');
const PII = [['email', 'Email'], ['full_name', 'Full name'], ['phone', 'Phone'], ['dob', 'Date of birth'], ['national_id', 'National ID'], ['address', 'Address']];

export function Me() {
  const { user, signOut, refresh, toast, activeRole, setActiveRole } = useSession();
  const { push } = useNav();
  const [reveal, setReveal] = useState(false);
  const [edit, setEdit] = useState(false);
  const [sp, setSp] = useState(false);
  const [rolesForm, setRolesForm] = useState(false);
  const [newToken, setNewToken] = useState(null);
  const [tokForm, setTokForm] = useState(false);
  const photo = useAvatarPhoto();
  const dash = useLoad(() => api.get('/dashboard'), []);
  const toks = useLoad(() => api.get('/me/tokens'), []);
  const d = dash.data;

  return (
    <Screen>
      <GradCard colors={[user.avatar_color ?? c.pink, c.violet]} style={{ marginTop: 8 }}>
        <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
          <Avatar user={user} size={72} />
          <View style={{ flex: 1 }}><H1 color="#fff" style={{ fontSize: 26 }}>{user.display_name}</H1><T color="#fff" weight="800">@{user.handle}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{user.roles.map((r) => <Tag key={r} label={roleLabel(r)} color={c.lime} />)}</View></View>
        </View>
      </GradCard>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn small title={user.avatar_url ? '📷 Change photo' : '📷 Add profile photo'} color={c.paper} ink={c.ink} loading={photo.busy} onPress={photo.change} />
        <Btn small title="Upload without cut-out" color={c.paper} ink={c.ink} disabled={photo.busy} onPress={() => photo.change({ asIs: true })} />
        {user.avatar_url ? <Btn small title="Remove photo" color={c.paper} ink={c.ink} disabled={photo.busy} onPress={photo.remove} /> : null}
      </View>
      <Section title="Acting as" color={c.cyan}>
        <T size={13} color={c.mute}>One login, several roles. Pick the one you want to use right now — the app shows that role's tools.</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {user.roles.map((r) => <Chip key={r} label={roleLabel(r)} active={r === activeRole} onPress={() => { setActiveRole(r); toast(`Now acting as ${roleLabel(r)}`); }} />)}
        </View>
        <Btn small title="Add or remove roles" color={c.paper} ink={c.ink} onPress={() => setRolesForm(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
      </Section>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <StatPill value={d?.points ?? '–'} label="POINTS" color={c.lime} /><StatPill value={d?.trophies ?? '–'} label="TROPHIES" color={c.sun} /><StatPill value={d?.active_policies ?? '–'} label="POLICIES" color={c.cyan} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn small title="View my public page" color={c.violet} onPress={() => push('Person', { id: user.id })} />
        <Btn small title="Add a sport role" color={c.cyan} ink={c.ink} onPress={() => setSp(true)} />
        {user.roles.includes('coach') ? <Btn small title="Coach home" color={c.violet} onPress={() => push('CoachHome')} /> : null}
        <Btn small title="My training plans" color={c.paper} ink={c.ink} onPress={() => push('MyPlans')} />
        <Btn small title="Family & guardians" color={c.paper} ink={c.ink} onPress={() => push('Family')} />
        <Btn small title="Support & disputes" color={c.paper} ink={c.ink} onPress={() => push('Support')} />
        <Btn small title="My organisations" color={c.paper} ink={c.ink} onPress={() => push('Orgs')} />
        {user.roles.includes('insurer') ? <Btn small title="Insurer desk" color={c.violet} onPress={() => push('InsurerDesk')} /> : null}
        <Btn small title="My insurance" color={c.paper} ink={c.ink} onPress={() => push('Insurance')} />
      </View>

      <Section title="Favourite sports & games" color={c.sun}><FavouriteSports /></Section>

      <Section title="Private details" color={c.mint}>
        <Card color={c.mintSoft}>
          <T size={12} color={c.mute} weight="700">Encrypted with AES-256-GCM before storage and decrypted only for you. Every read is audit-logged.</T>
          {PII.map(([k, l]) => (
            <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderColor: c.line }}>
              <T weight="800">{l}</T><T weight="700">{reveal ? user[k] ?? '—' : mask(user[k])}</T>
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Btn small title={reveal ? 'Hide' : 'Reveal'} emoji={reveal ? '🙈' : '👁️'} color={c.ink} onPress={() => setReveal(!reveal)} />
            <Btn small title="Edit" color={c.pink} onPress={() => setEdit(true)} />
          </View>
        </Card>
      </Section>

      {user.roles.some((r) => ['physio', 'doctor'].includes(r)) ? <ProviderProfileSection /> : null}
      <VerificationSection />
      {user.roles.includes('admin') ? <VerificationQueue /> : null}
      {user.roles.includes('admin') ? <CaseQueue /> : null}

      <Section title="Agents & API (MCP)" color={c.violet}>
        <Card color={c.violetSoft}>
          <T weight="700">Everything in this app is also an API and an MCP tool. Create a token and plug SportArena into your AI agent.</T>
          <T size={12} color={c.mute} style={{ marginTop: 6 }}>MCP endpoint: {MCP_URL}</T>
          {newToken ? <Card color={c.sunSoft} style={{ marginTop: 10 }} pad={12}><T weight="900">Copy it now — shown once</T><T selectable size={12} weight="700" style={{ marginTop: 4 }}>{newToken}</T></Card> : null}
          {toks.data?.filter((t) => !t.revoked_at).map((t) => (
            <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <T weight="800">🔑 {t.name}</T><Btn small title="Revoke" color={c.paper} ink={c.red} onPress={async () => { await api.del(`/me/tokens/${t.id}`); toks.reload(); }} />
            </View>
          ))}
          <Btn small title="New API token" color={c.violet} onPress={() => setTokForm(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
        </Card>
      </Section>

      <Btn title="Log out" color={c.ink} onPress={signOut} style={{ marginTop: 28 }} />

      <FormSheet visible={rolesForm} onClose={() => setRolesForm(false)} title="Add or remove roles" submitLabel="Save" initial={{ roles: user.roles }}
        fields={[{ key: 'roles', label: 'My roles (your venues, events and bookings are kept if you drop one)', type: 'multi', options: ROLES.map(([value, label]) => ({ value, label })) }]}
        onSubmit={async (v) => {
          const next = v.roles ?? [];
          await api.patch('/me/roles', { add: next.filter((r) => !user.roles.includes(r)), remove: user.roles.filter((r) => !next.includes(r)) });
          const me = await refresh();
          if (!me.roles.includes(activeRole)) setActiveRole(me.roles[0]);
          if (next.includes('insurer') && !user.roles.includes('insurer')) { setActiveRole('insurer'); push('InsurerDesk'); return 'Insurer role added: set up your profile'; }
          return 'Roles updated';
        }} />
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Edit details" initial={{ display_name: user.display_name, bio: user.bio, full_name: user.full_name, phone: user.phone, dob: user.dob, national_id: user.national_id, address: user.address }}
        fields={[{ key: 'display_name', label: 'Display name', optional: true }, { key: 'bio', label: 'Bio', optional: true, type: 'multiline' }, { key: 'full_name', label: 'Full name', optional: true }, { key: 'phone', label: 'Phone', optional: true }, { key: 'dob', label: 'Date of birth (YYYY-MM-DD)', optional: true }, { key: 'national_id', label: 'National ID', optional: true }, { key: 'address', label: 'Address', optional: true, type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch('/me', v); await refresh(); return 'Saved & encrypted'; }} />
      <FormSheet visible={sp} onClose={() => setSp(false)} title="Add a sport role" submitLabel="Add"
        fields={[{ key: 'sport', label: 'Sport', type: 'sport' }, { key: 'role', label: 'Role', type: 'choice', options: ['athlete', 'coach', 'referee', 'physio', 'doctor'] }, { key: 'level', label: 'Level', type: 'choice', options: ['beginner', 'amateur', 'semi_pro', 'pro'] }, { key: 'position', label: 'Position', optional: true }, { key: 'license_no', label: 'License no.', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/sport-profiles', v); return 'Added'; }} />
      <FormSheet visible={tokForm} onClose={() => setTokForm(false)} title="New API token" submitLabel="Create" fields={[{ key: 'name', label: 'Name', placeholder: 'My Claude agent' }]}
        onSubmit={async (v) => { const t = await api.post('/me/tokens', v); setNewToken(t.token); toks.reload(); }} />
    </Screen>
  );
}
