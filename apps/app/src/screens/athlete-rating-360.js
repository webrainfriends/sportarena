// Athlete Rating 360 — three distinct surfaces: Verified Glicko, Peer-Assessed, Self-Assessed (issue #1190).
// Glicko 1.0–7.0 is computed from verified competitive results only; peer graph is a completely separate surface.
// Visual hierarchy: neutral border → double purple border + glow → muted opacity.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, ErrorBox, Loading, T, Tag } from '../ui';
import { t } from '../i18n';
import { c, day } from '../theme';
import { PeerSkillGraphPanel } from './peer-skill-graph';

const LEVEL_LABEL = { 1: 'Beginner', 2: 'Novice', 3: 'Intermediate', 4: 'Club', 5: 'Competitive', 6: 'Advanced', 7: 'Professional' };

function ScoreRing({ score, maxScore = 7 }) {
  const size = 76;
  const stroke = 7;
  const pct = Math.min(score / maxScore, 1);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: c.line }} />
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: c.pink,
        borderTopColor: pct > 0.75 ? c.pink : 'transparent',
        borderRightColor: pct > 0.5 ? c.pink : 'transparent',
        borderBottomColor: pct > 0.25 ? c.pink : 'transparent',
        borderLeftColor: pct > 0 ? c.pink : 'transparent',
        transform: [{ rotate: '-90deg' }] }} />
      <T weight="900" size={19} color={c.pink}>{score?.toFixed(1)}</T>
    </View>
  );
}

function MiniSparkline({ points }) {
  if (!points || points.length < 2) return null;
  const vals = points.map((p) => p.score ?? p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const W = 80, H = 24;
  const trend = vals.at(-1) > vals[0] ? '↑' : vals.at(-1) < vals[0] ? '↓' : '→';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: W, height: H, backgroundColor: c.line + '44', borderRadius: 4 }}>
        {points.map((p, i) => {
          const x = (i / (points.length - 1)) * (W - 6) + 3;
          const y = H - ((vals[i] - lo) / span) * (H - 6) - 3;
          return <View key={i} style={{ position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: c.pink, left: x - 2, top: y - 2 }} />;
        })}
      </View>
      <T size={14} color={trend === '↑' ? c.mint : trend === '↓' ? c.red : c.mute}>{trend}</T>
    </View>
  );
}

function VerifiedLevelSurface({ userId, sportSlug }) {
  const ratings = useLoad(() => api.get(`/athletes/${userId}/sports/${sportSlug}/skill-ratings`), [userId, sportSlug]);
  if (ratings.loading && !ratings.data) return <Loading />;
  if (ratings.error) return null;
  const d = ratings.data;
  if (!d?.rating) return null;
  return (
    <View style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 14, padding: 16, gap: 12, backgroundColor: c.card }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.pink }} />
        <T weight="900" size={13} style={{ letterSpacing: 0.5 }}>{t('a360.surface_verified').toUpperCase()}</T>
        <View style={{ flex: 1 }} />
        <Tag label="🛡 Glicko" color={c.mintSoft} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <ScoreRing score={d.rating} />
        <View style={{ flex: 1, gap: 6 }}>
          <T weight="900" size={22}>{LEVEL_LABEL[Math.round(d.rating)] ?? t('a360.computing')}</T>
          <T size={12} color={c.mute}>{t('a360.verified_note')}</T>
          <MiniSparkline points={d.trend ?? []} />
        </View>
      </View>
      {d.rated_events ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Tag label={t('a360.events_count', { n: d.rated_events })} color={c.cyanSoft} />
          {d.last_updated ? <Tag label={t('a360.last_updated', { date: day(d.last_updated) })} color={c.mute} /> : null}
        </View>
      ) : null}
      <T size={11.5} color={c.mute} style={{ fontStyle: 'italic' }}>{t('a360.glicko_disclaimer')}</T>
    </View>
  );
}

function PeerAssessedSurface({ userId, sportSlug, isOwn }) {
  return (
    <View style={{
      borderWidth: 2.5, borderColor: c.pink, borderRadius: 14, padding: 16, gap: 10,
      backgroundColor: c.card,
      shadowColor: c.pink, shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.pink }} />
        <T weight="900" size={13} color={c.pink} style={{ letterSpacing: 0.5 }}>{t('a360.surface_peer').toUpperCase()}</T>
        <View style={{ flex: 1 }} />
        <Tag label={t('a360.community_rated')} color={c.violetSoft} textColor={c.pink} />
      </View>
      <PeerSkillGraphPanel userId={userId} sportSlug={sportSlug} isOwn={isOwn} />
    </View>
  );
}

function SelfAssessedSurface({ profile }) {
  const level = profile?.self_level;
  return (
    <View style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 14, padding: 16, gap: 10, backgroundColor: c.card, opacity: 0.75 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.mute }} />
        <T weight="900" size={13} color={c.mute} style={{ letterSpacing: 0.5 }}>{t('a360.surface_self').toUpperCase()}</T>
        <View style={{ flex: 1 }} />
        <View style={{ backgroundColor: c.line, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
          <T size={11} weight="700" color={c.mute}>{t('a360.not_matchmaking')}</T>
        </View>
      </View>
      {level ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 52, height: 52, borderRadius: 26, borderWidth: 2, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
            <T weight="900" size={16} color={c.mute}>{level}</T>
          </View>
          <T size={14} color={c.mute}>{LEVEL_LABEL[level] ?? level}</T>
        </View>
      ) : (
        <T size={13} color={c.mute}>{t('a360.self_not_set')}</T>
      )}
      <T size={12} color={c.mute} style={{ fontStyle: 'italic' }}>{t('a360.self_disclaimer')}</T>
    </View>
  );
}

function CoachEndorsementCard({ endorsement }) {
  return (
    <Card pad={14} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.cyanSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T weight="900" size={16} color={c.cyan}>{(endorsement.coach_name ?? '?')[0]}</T>
        </View>
        <View style={{ flex: 1 }}>
          <T weight="800" size={14}>{endorsement.coach_name}</T>
          <View style={{ flexDirection: 'row', gap: 4, marginTop: 2 }}>
            <Tag label={endorsement.coach_role ?? t('a360.coach')} color={c.cyanSoft} />
            {endorsement.verified ? <Tag label="✓ Verified" color={c.mintSoft} /> : null}
          </View>
        </View>
      </View>
      {endorsement.quote ? <T size={13} color={c.mute} style={{ lineHeight: 19, fontStyle: 'italic' }}>"{endorsement.quote}"</T> : null}
    </Card>
  );
}

function ReputationStrip({ reputation }) {
  if (!reputation) return null;
  const items = [
    { label: t('a360.rep_sportsmanship'), value: reputation.sportsmanship, icon: '🤝' },
    { label: t('a360.rep_reliability'), value: reputation.reliability, icon: '📌' },
    { label: t('a360.rep_activity'), value: reputation.activity_level, icon: '⚡' },
  ].filter((i) => i.value);
  if (!items.length) return null;
  return (
    <View>
      <T weight="700" size={12} color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.5 }}>{t('a360.reputation').toUpperCase()}</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {items.map((item) => (
          <View key={item.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.card, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: c.line }}>
            <T size={14}>{item.icon}</T>
            <T size={12.5} weight="700">{item.value}</T>
            <T size={11} color={c.mute}>{item.label}</T>
          </View>
        ))}
      </View>
    </View>
  );
}

export function AthleteRating360Panel({ userId, sport, isOwn, profile }) {
  const { push } = useNav();
  const endorsements = useLoad(() => api.get(`/athletes/${userId}/coach-feedback`, { limit: 2 }), [userId]);
  const reputation = useLoad(() => api.get(`/athletes/${userId}/reputation`).catch(() => null), [userId]);

  if (!sport) {
    return (
      <Card pad={16} style={{ alignItems: 'center' }}>
        <T size={13} color={c.mute}>{t('a360.select_sport')}</T>
      </Card>
    );
  }

  return (
    <View style={{ gap: 14 }}>
      <T weight="900" size={17}>⭐ {t('a360.section_title')}</T>

      <VerifiedLevelSurface userId={userId} sportSlug={sport} />
      <PeerAssessedSurface userId={userId} sportSlug={sport} isOwn={isOwn} />
      <SelfAssessedSurface profile={profile} />

      <ReputationStrip reputation={reputation.data} />

      {(endorsements.data?.feedback ?? []).length > 0 ? (
        <View style={{ gap: 8 }}>
          <T weight="700" size={13} color={c.mute} style={{ letterSpacing: 0.5 }}>{t('a360.endorsements').toUpperCase()}</T>
          {(endorsements.data.feedback ?? []).slice(0, 2).map((e) => (
            <CoachEndorsementCard key={e.id} endorsement={e} />
          ))}
        </View>
      ) : null}

      {isOwn ? (
        <Pressable onPress={() => push('RecruiterView', { userId, sport })} accessibilityRole="button"
          style={{ padding: 16, borderWidth: 1.5, borderColor: c.pink, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56 }}>
          <T size={18}>🔍</T>
          <T weight="800" size={15} color={c.pink}>{t('a360.recruiter_view_cta')}</T>
        </Pressable>
      ) : null}
    </View>
  );
}
