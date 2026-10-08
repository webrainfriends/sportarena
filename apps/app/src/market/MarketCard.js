import React from 'react';
import { Linking, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Avatar, Btn, T } from '../ui';
import { MediaGrid } from './media';
import { c, money, when, accentFor } from '../theme';

export const KINDS = {
  wanted: { label: 'Wanted', emoji: '🙋', color: '#4F46E5', cta: 'Apply now' },
  match: { label: 'Match', emoji: '⚔️', color: '#059669', cta: 'Join match' },
  schedule: { label: 'Schedule', emoji: '🗓️', color: '#0284C7', cta: "I'm interested" },
  sale: { label: 'For sale', emoji: '🛍️', color: '#EA580C', cta: 'Contact seller' },
  campaign: { label: 'Campaign', emoji: '📣', color: '#DB2777', cta: 'Learn more' },
  announcement: { label: 'News', emoji: '📰', color: '#475569', cta: 'Reply' },
};

const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/**
 * One marketplace card — used on the public landing page and in the member feed.
 * Visitors can read it; every action that needs an identity calls `gate(intent, post)`, which starts the login flow
 * (signed out) or performs the action (signed in).
 */
export function MarketCard({ p, user, gate, onChanged, feed }) {
  const k = KINDS[p.kind] ?? KINDS.announcement;
  const cta = p.cta_label || k.cta;
  const open = p.status === 'open';
  const tone = k.color;
  const facts = [p.sport ? `${p.sport_emoji ?? ''} ${p.sport}` : null, p.city ? `📍 ${p.city}` : null, p.starts_at ? `🕒 ${when(p.starts_at)}` : null, p.positions ? `👥 ${p.positions} needed` : null].filter(Boolean);
  const applied = p.my_application;
  return (
    <View style={{ backgroundColor: c.paper, borderRadius: feed ? 16 : 22, borderWidth: p.sponsored ? 1.5 : 1, borderColor: p.sponsored ? '#F59E0B' : c.line, overflow: 'hidden', shadowColor: '#0F172A', shadowOpacity: 0.07, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }}>
      {p.media?.length ? <View><MediaGrid media={p.media} height={feed ? 280 : 210} /></View> : (
        <LinearGradient colors={[tone, `${tone}99`]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ height: feed ? 110 : 130, padding: 16, justifyContent: 'flex-end' }}>
          <T size={46} style={{ position: 'absolute', right: 14, top: 8, opacity: 0.9 }}>{p.sport_emoji ?? k.emoji}</T>
        </LinearGradient>
      )}
      <View style={{ position: 'absolute', top: 12, left: 12, flexDirection: 'row', gap: 6 }}>
        <View style={{ backgroundColor: tone, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}><T color="#fff" weight="800" size={11} style={{ letterSpacing: 0.6 }}>{k.emoji} {k.label.toUpperCase()}</T></View>
        {p.sponsored ? <View style={{ backgroundColor: '#F59E0B', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}><T color="#fff" weight="800" size={11} style={{ letterSpacing: 0.6 }}>SPONSORED</T></View> : null}
        {p.sponsor_status === 'pending' && p.is_mine ? <View style={{ backgroundColor: c.violet, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}><T color="#fff" weight="800" size={11}>IN REVIEW</T></View> : null}
      </View>

      <View style={{ padding: 16, gap: 10 }}>
        <Pressable onPress={() => gate('profile', p)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Avatar user={{ ...p.author, handle: p.author.handle ?? p.author.display_name }} size={36} />
          <View style={{ flex: 1 }}>
            <T weight="700" size={13} numberOfLines={1}>{p.author.display_name}{!user ? <T size={12} color={c.mute}>  🔒 profile</T> : null}</T>
            <T size={11} color={c.mute}>{ago(p.created_at)} · {p.visibility === 'members' ? 'Members' : 'Public'}</T>
          </View>
          {!open ? <T size={11} weight="800" color={c.mute}>CLOSED</T> : null}
        </Pressable>
        <T weight="800" size={feed ? 19 : 17} style={{ letterSpacing: -0.4, lineHeight: feed ? 25 : 23 }}>{p.title}</T>
        {p.body ? <T size={14} color="#334155" style={{ lineHeight: 21 }} numberOfLines={feed ? 8 : 3}>{p.body}</T> : null}
        {facts.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{facts.map((f) => <View key={f} style={{ backgroundColor: c.bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}><T size={12} weight="600" color="#334155">{f}</T></View>)}</View> : null}
        {p.price_cents != null ? <T size={22} weight="800" color={tone}>{money(p.price_cents)}</T> : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
          <Pressable onPress={() => gate('react', p)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingRight: 10 }}>
            <T size={16}>{p.my_reaction ? '❤️' : '🤍'}</T><T size={13} weight="700" color={c.mute}>{p.reactions || ''}</T>
          </Pressable>
          <Pressable onPress={() => gate('react', p, 'comments')} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingRight: 10 }}>
            <T size={16}>💬</T><T size={13} weight="700" color={c.mute}>{p.comments || ''}</T>
          </Pressable>
          {p.is_mine && p.applicants ? <T size={12} weight="700" color={c.pink}>{p.applicants} applicant{p.applicants > 1 ? 's' : ''}</T> : null}
          <View style={{ flex: 1 }} />
          {p.is_mine ? <Btn small title="Manage" color={c.paper} onPress={() => gate('manage', p)} />
            : applied ? <T size={13} weight="800" color={applied === 'accepted' ? c.lime : c.mute}>{applied === 'accepted' ? '✓ Accepted' : applied === 'declined' ? 'Declined' : '✓ Applied'}</T>
            : open ? <Btn small title={cta} color={tone} onPress={() => (p.link_url && p.kind === 'campaign' ? Linking.openURL(p.link_url) : gate(p.kind === 'sale' ? 'contact' : 'apply', p))} /> : null}
        </View>
      </View>
    </View>
  );
}
