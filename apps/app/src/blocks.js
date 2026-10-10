import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { Avatar, Btn, Card, Empty, Loading, Tag, T } from './ui';
import { FormSheet } from './FormSheet';
import { useSession } from './session';
import { c, day } from './theme';
import { locale } from './locale';

export const Stars = ({ n = 0, size = 16 }) => <T size={size}>{'⭐'.repeat(Math.round(n))}{'▫️'.repeat(5 - Math.round(n))}</T>;

/** Testimonials for any subject, with a "write one" sheet. */
export function Reviews({ type, id, canWrite = true }) {
  const { user, toast } = useSession();
  const [open, setOpen] = useState(false);
  const { data, loading, reload } = useLoad(() => api.get('/testimonials', { subject_type: type, subject_id: id }), [type, id]);
  if (loading && !data) return <Loading />;
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View><T weight="900" size={28}>{data?.avg ?? '–'}</T><T size={12} color={c.mute}>{data?.n ?? 0} review{data?.n === 1 ? '' : 's'}</T></View>
          <Stars n={data?.avg ?? 0} size={20} />
        </View>
      </Card>
      {data?.items?.length ? data.items.map((t) => (
        <Card key={t.id}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Avatar user={{ avatar_color: t.avatar_color, avatar_emoji: t.avatar_emoji, avatar_url: t.avatar_url }} size={36} />
            <View style={{ flex: 1 }}><T weight="900">{t.display_name}</T><T size={11} color={c.mute}>@{t.handle} · {day(t.created_at)}</T></View>
            <Stars n={t.rating} size={12} />
          </View>
          <T style={{ marginTop: 8 }}>{t.body}</T>
        </Card>
      )) : <Empty emoji="💬" title="No reviews yet" sub="Be the first to hype it up." />}
      {user && canWrite ? <Btn title="Write a review" color={c.violet} onPress={() => setOpen(true)} /> : null}
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Your review" submitLabel="Post it"
        fields={[{ key: 'rating', label: 'Rating', type: 'choice', options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: '⭐'.repeat(n) })) }, { key: 'body', label: 'What did you think?', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post('/testimonials', { subject_type: type, subject_id: id, ...v }); reload(); return 'Review posted'; }} />
    </View>
  );
}

const AWARD = { cup: ['🏆', 'Cup'], trophy: ['🏅', 'Trophy'], medal_gold: ['🥇', 'Gold'], medal_silver: ['🥈', 'Silver'], medal_bronze: ['🥉', 'Bronze'], mvp: ['🌟', 'MVP'], badge: ['🎖️', 'Badge'] };
export const awardEmoji = (k) => AWARD[k]?.[0] ?? '🏅';

export function TrophyShelf({ awards }) {
  if (!awards?.length) return <Empty emoji="🏆" title="Trophy cabinet is empty" sub="Win something. We believe in you." />;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {awards.map((a, i) => (
        <Card key={a.id ?? i} color={[c.sunSoft, c.pinkSoft, c.cyanSoft, c.limeSoft][i % 4]} style={{ width: 150 }} pad={12}>
          <T size={34}>{awardEmoji(a.kind)}</T>
          <T weight="900" size={14} style={{ marginTop: 4 }}>{a.name}</T>
          <Tag label={AWARD[a.kind]?.[1] ?? a.kind} color={c.ink} ink="#fff" style={{ marginTop: 6 }} />
        </Card>
      ))}
    </View>
  );
}

export function FixtureCard({ f, onScore }) {
  const done = f.status === 'completed';
  return (
    <Card pad={12}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Tag label={f.round ?? f.event_name ?? 'Game'} color={c.violetSoft} />
        <T size={12} color={c.mute} weight="800">{done ? 'FULL TIME' : f.status === 'live' ? 'LIVE' : new Date(f.scheduled_at).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 6 }}>
        <View style={{ flex: 1, alignItems: 'center' }}><T size={30}>{f.home_emoji}</T><T weight="900" size={13} style={{ textAlign: 'center' }}>{f.home_name}</T></View>
        <View style={{ backgroundColor: c.violet, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 6 }}>
          <T color="#fff" weight="800" size={20}>{done ? `${f.home_score} – ${f.away_score}` : 'VS'}</T>
        </View>
        <View style={{ flex: 1, alignItems: 'center' }}><T size={30}>{f.away_emoji}</T><T weight="900" size={13} style={{ textAlign: 'center' }}>{f.away_name}</T></View>
      </View>
      {f.resource_name ? <T size={12} color={c.mute} style={{ marginTop: 8, textAlign: 'center' }}>📍 {f.resource_name}</T> : null}
      {onScore && !done ? <Btn small title="Enter result" color={c.mint} ink={c.ink} onPress={() => onScore(f)} style={{ marginTop: 10, alignSelf: 'center' }} /> : null}
    </Card>
  );
}

export function StandingsTable({ rows }) {
  if (!rows?.length) return <Empty emoji="📊" title="No table yet" sub="Teams appear here once accepted." />;
  const th = { width: 30, textAlign: 'center' };
  return (
    <Card pad={10}>
      <View style={{ flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1.5, borderColor: c.line }}>
        <T weight="900" size={11} style={{ width: 24 }}>#</T><T weight="900" size={11} style={{ flex: 1 }}>TEAM</T>
        {['P', 'W', 'D', 'L', 'GD'].map((h) => <T key={h} weight="900" size={11} style={th}>{h}</T>)}<T weight="900" size={11} style={{ width: 38, textAlign: 'center' }}>PTS</T>
      </View>
      {rows.map((r, i) => (
        <View key={r.team_id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: i < rows.length - 1 ? 1 : 0, borderColor: c.line }}>
          <View style={{ width: 24 }}><T weight="900">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : r.rank}</T></View>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}><T size={18}>{r.emoji}</T><T weight="900" size={14} numberOfLines={1} style={{ flexShrink: 1 }}>{r.name}</T></View>
          {[r.played, r.won, r.drawn, r.lost, r.goal_diff > 0 ? `+${r.goal_diff}` : r.goal_diff].map((x, k) => <T key={k} size={13} style={th}>{x}</T>)}
          <View style={{ width: 38, alignItems: 'center' }}><View style={{ backgroundColor: i === 0 ? c.ink : c.violetSoft, borderRadius: 8, paddingHorizontal: 6 }}><T weight="800" color={i === 0 ? c.inkOn : c.ink}>{r.points}</T></View></View>
        </View>
      ))}
    </Card>
  );
}
