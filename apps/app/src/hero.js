import React, { useState } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Avatar, T } from './ui';
import { Icon } from './icons';
import { c, toneFor } from './theme';
import { roleLabel } from './roles';
import { useLayout } from './layout';
import { api, mediaUrl } from './api';
import { useSession } from './session';
import { pickMedia } from './market/media';
import { removeBackground } from './cutout';

const lift = Platform.OS === 'web'
  ? { boxShadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 28px rgba(15,23,42,0.12)' }
  : { shadowColor: '#0F172A', shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 4 };

/** Profile photo for the signed-in account (any role): pick, upload, refresh the session; or go back to the emoji avatar. */
export function useAvatarPhoto() {
  const { refresh, toast } = useSession();
  const [busy, setBusy] = useState(false);
  const run = async (fn, done) => {
    setBusy(true);
    try { await fn(); await refresh(); toast(done); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  // web: remove the background first (falls back to the plain photo if the model can't load or finds no one); `asIs` skips it
  const change = async ({ asIs = false } = {}) => {
    const file = await pickMedia({ photoOnly: true });
    if (!file) return;
    await run(async () => {
      if (Platform.OS === 'web' && !asIs) {
        toast('Removing background…');
        try { await api.upload('/me/avatar', await removeBackground(file.blob), { cutout: 1 }); return; } catch { toast('Couldn’t remove the background — using your photo as is'); }
      }
      await api.upload('/me/avatar', file.blob);
    }, 'Profile photo updated');
  };
  const remove = () => run(() => api.del('/me/avatar'), 'Photo removed');
  return { change, remove, busy };
}

/** Width of the player-card column: phone-sized on every screen, like the reference. */
export const COL = 520;
const nice = (s) => String(s).replace(/_/g, ' ');
/** Whole years from a YYYY-MM-DD date of birth (the signed-in user's own record). */
export const ageOf = (dob) => {
  const d = dob ? new Date(dob) : null;
  if (!d || Number.isNaN(+d)) return null;
  const n = new Date();
  return n.getFullYear() - d.getFullYear() - (n < new Date(n.getFullYear(), d.getMonth(), d.getDate()) ? 1 : 0);
};

const Chip = ({ children, tone }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tone ? tone[1] : c.paper, borderColor: tone ? tone[1] : c.line, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'flex-start' }}>
    {typeof children === 'string' ? <T size={12} weight="700" color={tone ? tone[2] : c.ink}>{children}</T> : children}
  </View>
);

const RoundBtn = ({ icon, onPress, label }) => (
  <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1, ...lift })}>
    <Icon name={icon} color={c.ink} size={20} />
  </Pressable>
);

/**
 * Player card header, light layout: name, sport/club chips and position on the left, the player's photo on the right
 * (emoji avatar until they upload one), faded into a soft sport-tinted backdrop. `profile` is the default entry from
 * /me/sport-profiles (may be undefined until they add a sport).
 */
export function PlayerHero({ user, profile, onBell, onAvatar, pad = 16 }) {
  const photo = useAvatarPhoto();
  const L = useLayout();
  const tone = profile ? toneFor(profile.sport_slug) : null;
  const [first, ...rest] = String(user.display_name).trim().split(/\s+/);
  const W = Math.min(L.width, COL);
  const H = 330;
  const side = Math.round(W * 0.62);
  const nameSize = W < 400 ? 36 : 40;
  return (
    <View style={{ backgroundColor: c.paper, overflow: 'hidden' }}>
      <View style={{ width: '100%', maxWidth: COL, alignSelf: 'center', height: H, paddingHorizontal: pad }}>
        {profile ? <Text pointerEvents="none" style={{ position: 'absolute', left: -40, top: 60, fontSize: 250, opacity: 0.07 }}>{profile.sport_emoji}</Text> : null}
        <View style={{ position: 'absolute', right: 0, top: 8, width: side, height: H - 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Open my profile" onPress={onAvatar} style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            {user.avatar_url
              ? <Image source={{ uri: mediaUrl(user.avatar_url) }} resizeMode={user.avatar_cutout ? 'contain' : 'cover'} accessibilityLabel={`${user.display_name} photo`} style={{ width: '100%', height: '100%', ...(Platform.OS === 'web' ? { objectPosition: user.avatar_cutout ? 'right bottom' : 'top' } : null) }} />
              : <Text style={{ fontSize: side * 0.6, marginTop: 20 }}>{user.avatar_emoji ?? '😎'}</Text>}
          </Pressable>
          {user.avatar_url && !user.avatar_cutout ? (
            <>
              <LinearGradient pointerEvents="none" colors={[c.paper, c.paper + '00']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '45%' }} />
              <LinearGradient pointerEvents="none" colors={[c.paper + '00', c.paper]} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '38%' }} />
              {L.width > COL ? <LinearGradient pointerEvents="none" colors={[c.paper + '00', c.paper]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '18%' }} /> : null}
              <LinearGradient pointerEvents="none" colors={[c.paper, c.paper + '00']} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 36 }} />
            </>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Change profile photo" disabled={photo.busy} onPress={photo.change} hitSlop={8} style={({ pressed }) => ({ position: 'absolute', right: pad, bottom: 64, width: 36, height: 36, borderRadius: 18, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', opacity: photo.busy ? 0.5 : pressed ? 0.8 : 1, ...lift })}>
            <T size={16}>📷</T>
          </Pressable>
        </View>
        <View style={{ position: 'absolute', right: pad, top: 14 }}>
          <RoundBtn icon="Bell" label="Notifications" onPress={onBell} />
        </View>
        <View style={{ position: 'absolute', left: pad, top: 64, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {profile ? <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: tone[1], alignItems: 'center', justifyContent: 'center' }}><T size={22}>{profile.sport_emoji}</T></View> : null}
          {profile?.club ? <Chip>{profile.club}</Chip> : null}
        </View>
        <View style={{ position: 'absolute', left: pad, top: 116, width: '56%' }}>
          <T size={nameSize} weight="800" numberOfLines={1} adjustsFontSizeToFit style={{ letterSpacing: -1.2, lineHeight: nameSize + 4 }}>{first}</T>
          {rest.length ? <T size={nameSize} weight="800" numberOfLines={1} adjustsFontSizeToFit style={{ letterSpacing: -1.2, lineHeight: nameSize + 4 }}>{rest.join(' ')}</T> : null}
          <T size={14} weight="600" color={c.mute} style={{ marginTop: 4 }}>@{user.handle}</T>
        </View>
        <View style={{ position: 'absolute', left: pad, bottom: 56, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {profile && profile.jersey_no !== null && profile.jersey_no !== undefined ? <View style={{ minWidth: 30, height: 30, borderRadius: 9, backgroundColor: tone[0], alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}><T size={13} weight="800" color="#fff">{profile.jersey_no}</T></View> : null}
          <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 1.6 }}>{(profile?.position ?? (user.roles?.[0] ? roleLabel(user.roles[0]) : 'Athlete')).toUpperCase()}</T>
        </View>
      </View>
    </View>
  );
}

/** Frosted-white stat tiles with the value at the bottom-right, overlapping the hero's lower edge. `items` = [[label, value], …]. */
export function StatTiles({ items, pad = 16 }) {
  const L = useLayout();
  return (
    <View style={{ width: '100%', maxWidth: COL, alignSelf: 'center', flexDirection: 'row', gap: 10, paddingHorizontal: pad, marginTop: -44 }}>
      {items.map(([label, value]) => (
        <View key={label} style={{ flex: 1, minHeight: 96, justifyContent: 'space-between', backgroundColor: c.paper, borderRadius: 20, borderWidth: 1, borderColor: c.line, padding: 14, ...lift }}>
          <T size={12} weight="600" color={c.mute} numberOfLines={1}>{label}</T>
          <T size={30} weight="800" style={{ letterSpacing: -0.8, textAlign: 'right', fontVariant: ['tabular-nums'] }}>{value}</T>
        </View>
      ))}
    </View>
  );
}

/** "Now discussing" strip: a live dot plus a tappable card with a date column, like a news item. */
export function NowStrip({ title, sub, date, onPress, pad = 16 }) {
  const L = useLayout();
  return (
    <View style={{ width: '100%', maxWidth: COL, alignSelf: 'center', paddingHorizontal: pad, marginTop: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} /></View>
        <T size={13} weight="700" color={c.pink}>Now discussing</T>
      </View>
      <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', gap: 14, backgroundColor: c.paper, borderRadius: 20, borderWidth: 1, borderColor: c.line, padding: 14, opacity: pressed ? 0.9 : 1, ...lift })}>
        {date ? <View style={{ alignItems: 'center', minWidth: 34 }}><T size={20} weight="800" color={c.mute} style={{ lineHeight: 22 }}>{date[0]}</T><T size={12} weight="600" color={c.mute}>{date[1]}</T></View> : null}
        <View style={{ flex: 1 }}>
          <T weight="700" size={15} numberOfLines={2}>{title}</T>
          {sub ? <T size={12} color={c.mute} style={{ marginTop: 4 }} numberOfLines={1}>{sub}</T> : null}
        </View>
      </Pressable>
    </View>
  );
}

/** "ABOUT": the facts on the player card. Rows with no value are left out (no placeholders). */
export function AboutCard({ user, profile }) {
  const rows = [
    ['Full name', user.full_name], ['Sport', profile ? `${profile.sport_emoji} ${profile.sport}` : null], ['Role', profile ? nice(profile.role) : null],
    ['Level', profile ? nice(profile.level) : null], ['Position', profile?.position], ['Club / team', profile?.club],
    ['Jersey', profile?.jersey_no !== null && profile?.jersey_no !== undefined ? `#${profile.jersey_no}` : null],
    ['Experience', profile?.experience_years ? `${profile.experience_years} yrs` : null],
  ].filter(([, v]) => v);
  if (!rows.length && !user.bio) return null;
  return (
    <View>
      <T size={19} weight="700" style={{ letterSpacing: -0.3, marginBottom: 12 }}>About</T>
      <View style={{ backgroundColor: c.paper, borderRadius: 20, borderWidth: 1, borderColor: c.line, padding: 16, gap: 12, ...lift }}>
        {user.bio ? <T size={14} color={c.mute} style={{ lineHeight: 20 }}>{user.bio}</T> : null}
        {rows.map(([k, v]) => (
          <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, borderTopWidth: 1, borderColor: c.line, paddingTop: 12 }}>
            <T size={13} color={c.mute} weight="600">{k}</T>
            <T size={14} weight="700" style={{ flexShrink: 1, textAlign: 'right' }}>{v}</T>
          </View>
        ))}
      </View>
    </View>
  );
}
