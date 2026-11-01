// Shared pieces of the social graph UI: a person row with its actions, and the activity card. Phone, tablet, desktop and web share them;
// every string goes through t() and layouts use start/end so right-to-left (Urdu) mirrors correctly. All logic lives in the API.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { Avatar, Btn, Card, Chip, T, Tag } from '../ui';
import { c, when } from '../theme';
import { t } from '../i18n';

/** 44pt-tall secondary action used in rows and menus. */
export function Small({ label, onPress, tone, disabled }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}
      style={({ pressed }) => ({ minHeight: 44, minWidth: 44, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1.5, borderColor: tone ?? c.line, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : pressed ? 0.85 : 1 })}>
      <T size={13} weight="700" color={tone ?? c.ink}>{label}</T>
    </Pressable>
  );
}

/** One person with whatever actions the list gives them. */
export function PersonRow({ p, sub, children }) {
  return (
    <Card pad={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Avatar user={p} size={44} />
        <View style={{ flex: 1, minWidth: 140 }}>
          <T weight="800" size={15} numberOfLines={1}>{p.display_name}</T>
          <T size={12.5} color={c.mute} numberOfLines={1}>@{p.handle}{sub ? ` · ${sub}` : ''}</T>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{children}</View>
      </View>
    </Card>
  );
}

const VIS_KEY = { public: 'social.vis_public', followers: 'social.vis_followers', friends: 'social.vis_friends', private: 'social.vis_private' };
export const visLabel = (v) => t(VIS_KEY[v] ?? VIS_KEY.followers);

/** What the item says, built only from the canonical fields the API returns (never free text). */
export function itemText(i) {
  const d = i.data ?? {};
  if (i.kind === 'result') return t('social.item_result', { sport: i.sport?.name ?? '' });
  if (i.kind === 'achievement') return t('social.item_achievement', { award: d.name ?? d.award });
  if (i.kind === 'streak') return t('social.item_streak', { n: d.weeks });
  if (i.kind === 'hosted_game') return t('social.item_hosted', { title: d.title });
  return t('social.item_rating', { before: Math.round(d.before), after: Math.round(d.after) });
}
const ICON = { result: '🏅', achievement: '🏆', streak: '🔥', hosted_game: '🎟️', rating: '📈' };

/** One feed item. `mine` shows the visibility control; otherwise a menu to mute, report or block. */
export function ActivityCard({ item, mine, onChanged }) {
  const { toast } = useSession();
  const [menu, setMenu] = useState(false);
  const run = (fn, msg) => async () => { try { await fn(); setMenu(false); if (msg) toast(msg); onChanged?.(); } catch (e) { toast(e.message); } };
  const a = item.actor;
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar user={a} size={40} />
        <View style={{ flex: 1 }}>
          <T weight="800" size={14.5} numberOfLines={1}>{a.display_name}</T>
          <T size={12} color={c.mute}>{when(item.at)}</T>
        </View>
        <Pressable onPress={() => setMenu(!menu)} accessibilityRole="button" accessibilityLabel={`${a.display_name}: ${t('social.more')}`} hitSlop={6}
          style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><T size={20} weight="800" color={c.mute}>⋯</T></Pressable>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <T size={26}>{ICON[item.kind]}</T>
        <View style={{ flex: 1, gap: 4 }}>
          <T weight="700" size={15}>{itemText(item)}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {item.kind === 'result' || item.kind === 'rating' ? <Tag label={t('social.verified')} color={c.mintSoft} /> : null}
            {item.sport ? <Tag label={item.sport.name} color={c.violetSoft} /> : null}
            {mine ? <Tag label={`${t('social.visible_to')}: ${visLabel(item.visibility)}`} color={c.sunSoft} /> : null}
          </View>
        </View>
      </View>
      {menu ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {mine ? (
            <>
              {['public', 'followers', 'friends', 'private'].map((v) => <Chip key={v} label={visLabel(v)} active={item.visibility === v} onPress={run(() => api.patch(`/me/activity/${item.kind}/${item.source_id}`, { visibility: v }))} />)}
              <Small label={item.hidden ? t('social.show') : t('social.hide')} onPress={run(() => api.patch(`/me/activity/${item.kind}/${item.source_id}`, { hidden: !item.hidden }))} />
            </>
          ) : (
            <>
              <Small label={t('social.mute')} onPress={run(() => api.patch(`/me/mutes/${a.id}`, { muted: true }), t('social.muted'))} />
              <Small label={t('social.report')} onPress={run(() => api.post('/social/reports', { target_type: 'activity', target_id: item.key, reason: 'inaccurate' }), t('social.reported'))} />
              <Small label={t('social.block')} tone={c.red} onPress={run(() => api.post('/me/contact-blocks', { user_id: a.id, blocked: true }), t('social.blocked'))} />
            </>
          )}
        </View>
      ) : null}
    </Card>
  );
}

export { Btn };
