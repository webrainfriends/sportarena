import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Avatar, T } from './ui';
import { Icon } from './icons';
import { c, glass, heroGrad, toneFor } from './theme';
import { roleLabel } from './roles';

const lift = Platform.OS === 'web'
  ? { boxShadow: '0 1px 2px rgba(15,23,42,0.05), 0 10px 28px rgba(15,23,42,0.12)' }
  : { shadowColor: '#0F172A', shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 4 };

const Badge = ({ children }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: glass.fill, borderColor: glass.line, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
    {typeof children === 'string' ? <T size={12} weight="700" color={glass.text}>{children}</T> : children}
  </View>
);

const RoundBtn = ({ icon, onPress, label }) => (
  <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, backgroundColor: glass.fill, borderWidth: 1, borderColor: glass.line, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
    <Icon name={icon} color="#fff" size={20} />
  </Pressable>
);

/**
 * Player card header: identity on a deep gradient tinted by the player's default sport.
 * `profile` is the default entry from /me/sport-profiles (may be undefined until they add a sport).
 */
export function PlayerHero({ user, profile, onBell, onAvatar, pad = 16 }) {
  const tone = profile ? toneFor(profile.sport_slug)[0] : c.pink;
  const roles = (user.roles ?? []).slice(0, 3);
  return (
    <LinearGradient colors={heroGrad(tone)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ paddingHorizontal: pad, paddingTop: 14, paddingBottom: 64, overflow: 'hidden', borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}>
      {profile ? <Text pointerEvents="none" style={{ position: 'absolute', right: -24, top: 18, fontSize: 190, opacity: 0.12 }}>{profile.sport_emoji}</Text> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T size={11} weight="700" color={glass.sub} style={{ letterSpacing: 2.4 }}>SPORTARENA</T>
        <RoundBtn icon="Bell" label="Notifications" onPress={onBell} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 14 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open my profile" onPress={onAvatar}><Avatar user={user} size={88} /></Pressable>
        <View style={{ flex: 1, gap: 4 }}>
          <T size={30} weight="800" color={glass.text} numberOfLines={2} style={{ letterSpacing: -0.8 }}>{user.display_name}</T>
          <T size={14} weight="600" color={glass.sub}>@{user.handle}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        {profile ? <Badge><T size={14}>{profile.sport_emoji}</T><T size={12} weight="700" color={glass.text}>{profile.sport}</T></Badge> : null}
        {profile?.club ? <Badge>{profile.club}</Badge> : null}
        {profile?.position ? <Badge>{profile.position}</Badge> : null}
        {profile?.jersey_no !== null && profile?.jersey_no !== undefined ? <Badge>{`#${profile.jersey_no}`}</Badge> : null}
        {roles.map((r) => <Badge key={r}>{roleLabel(r)}</Badge>)}
      </View>
    </LinearGradient>
  );
}

/** White stat tiles that overlap the hero's lower edge. `items` = [[label, value], …]. */
export function StatTiles({ items, pad = 16 }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: pad, marginTop: -44 }}>
      {items.map(([label, value]) => (
        <View key={label} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 20, borderWidth: 1, borderColor: c.line, paddingVertical: 14, paddingHorizontal: 14, ...lift }}>
          <T size={12} weight="600" color={c.mute}>{label}</T>
          <T size={28} weight="800" style={{ letterSpacing: -0.8, marginTop: 6, fontVariant: ['tabular-nums'] }}>{value}</T>
        </View>
      ))}
    </View>
  );
}

/** "Now discussing" strip: a live dot plus a tappable headline row. */
export function NowStrip({ title, sub, onPress, pad = 16 }) {
  return (
    <View style={{ paddingHorizontal: pad, marginTop: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.lime }} />
        <T size={13} weight="700" color={c.pink}>Now discussing</T>
      </View>
      <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ backgroundColor: c.paper, borderRadius: 20, borderWidth: 1, borderColor: c.line, padding: 14, opacity: pressed ? 0.9 : 1, ...lift })}>
        <T weight="700" size={15} numberOfLines={2}>{title}</T>
        {sub ? <T size={12} color={c.mute} style={{ marginTop: 4 }} numberOfLines={1}>{sub}</T> : null}
      </Pressable>
    </View>
  );
}
