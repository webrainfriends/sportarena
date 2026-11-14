import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, ErrorBox, Loading, Screen, T, Tag } from '../ui';
import { PeerSkillGraphPanel } from './peer-skill-graph';
import { t } from '../i18n';
import { useNav } from '../nav';
import { c } from '../theme';

function LevelRing({ level }) {
  const size = 52;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min((level ?? 0) / 7, 1);
  const filled = circ * pct;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: c.line }} />
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: c.pink,
        borderTopColor: pct > 0.75 ? c.pink : 'transparent',
        borderRightColor: pct > 0.5 ? c.pink : 'transparent',
        borderBottomColor: pct > 0.25 ? c.pink : 'transparent',
        borderLeftColor: pct > 0 ? c.pink : 'transparent',
        transform: [{ rotate: '-90deg' }] }} />
      <T weight="900" size={15} color={c.pink}>{level?.toFixed(1) ?? '—'}</T>
    </View>
  );
}

function KpiStrip({ ratings }) {
  const top = ratings[0];
  if (!top) return null;
  const record = top.record ?? {};
  const winPct = (record.wins != null && record.played)
    ? Math.round((record.wins / record.played) * 100)
    : null;
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
      <Card pad={12} style={{ flex: 1, alignItems: 'center' }}>
        <T weight="900" size={22} color={c.pink}>{top.level?.toFixed(1) ?? '—'}</T>
        <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{t('a360.verified_level')}</T>
      </Card>
      <Card pad={12} style={{ flex: 1, alignItems: 'center' }}>
        <T weight="900" size={22} color={c.cyan}>{top.reliability != null ? `${Math.round(top.reliability * 100)}%` : '—'}</T>
        <T size={11} color={c.mute}>{t('a360.rep_reliability')}</T>
      </Card>
      <Card pad={12} style={{ flex: 1, alignItems: 'center' }}>
        <T weight="900" size={22} color={c.mint}>{top.games ?? '—'}</T>
        <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{winPct != null ? `${winPct}% wins` : 'games'}</T>
      </Card>
    </View>
  );
}

function VerifiedLevelSection({ ratings, recruiterView }) {
  return (
    <View style={{ marginBottom: 20 }}>
      <T weight="800" size={15} style={{ marginBottom: 4 }}>{t('a360.verified_level')}</T>
      <T size={12} color={c.mute} style={{ marginBottom: 12 }}>{t('a360.verified_note')}</T>
      {ratings.map((r) => {
        const record = r.record ?? {};
        const hasPeak = r.peak != null && r.peak > (r.level ?? 0);
        return (
          <Card key={r.sport_slug} pad={14} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <LevelRing level={r.level} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T weight="800" size={14}>{r.sport_name ?? r.sport_slug}</T>
                <T size={12} color={c.mute}>{t('a360.score_ring_label', { n: r.level?.toFixed(1) ?? '—' })}</T>
                {record.played ? (
                  <T size={12} color={c.mute}>{record.wins ?? 0}W – {(record.played - (record.wins ?? 0))}L</T>
                ) : null}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                {hasPeak ? <Tag label={`Peak ${r.peak?.toFixed(1)}`} color={c.orangeSoft} /> : null}
                {recruiterView ? <Tag label={t('a360.verified_level')} color={c.mintSoft} /> : null}
              </View>
            </View>
          </Card>
        );
      })}
    </View>
  );
}

function PeerAssessedSection({ ratings, userId, activeSport, onSportChange, isOwn, recruiterView }) {
  if (!activeSport) return null;
  return (
    <View style={{ marginBottom: 20 }}>
      <T weight="800" size={15} style={{ marginBottom: 12 }}>{t('a360.peer_assessed')}</T>
      {ratings.length > 1 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {ratings.map((r) => (
            <Chip
              key={r.sport_slug}
              label={r.sport_name ?? r.sport_slug}
              active={activeSport === r.sport_slug}
              onPress={() => onSportChange(r.sport_slug)}
            />
          ))}
        </View>
      ) : null}
      {recruiterView ? (
        <Tag label={t('a360.show_recruiter_view')} color={c.cyanSoft} style={{ marginBottom: 8 }} />
      ) : null}
      <PeerSkillGraphPanel userId={userId} sportSlug={activeSport} isOwn={isOwn} />
    </View>
  );
}

function ReputationSection({ userId }) {
  const { data, loading, error } = useLoad(() => api.get(`/athletes/${userId}/reputation`).catch((e) => {
    if (e.status === 404 || e.statusCode === 404) return null;
    throw e;
  }), [userId]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const rep = data;
  return (
    <View style={{ marginBottom: 20 }}>
      <T weight="800" size={15} style={{ marginBottom: 12 }}>{t('a360.reputation')}</T>
      {rep ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Card pad={12} style={{ flex: 1, alignItems: 'center' }}>
            <T weight="900" size={20} color={c.mint}>{rep.sportsmanship != null ? rep.sportsmanship.toFixed(1) : '—'}</T>
            <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{t('a360.rep_sportsmanship')}</T>
          </Card>
          <Card pad={12} style={{ flex: 1, alignItems: 'center' }}>
            <T weight="900" size={20} color={c.cyan}>{rep.reliability != null ? rep.reliability.toFixed(1) : '—'}</T>
            <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{t('a360.rep_reliability')}</T>
          </Card>
          <Card pad={12} style={{ flex: 1, alignItems: 'center' }}>
            <T weight="900" size={20} color={c.pink}>{rep.activity != null ? rep.activity.toFixed(1) : '—'}</T>
            <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{t('a360.rep_activity')}</T>
          </Card>
        </View>
      ) : (
        <Card pad={16}>
          <T size={13} color={c.mute} style={{ textAlign: 'center' }}>
            Reputation scores build as you compete, officiate and train with others.
          </T>
        </Card>
      )}
    </View>
  );
}

function CoachEndorsementsSection({ isOwn }) {
  const { push } = useNav();
  return (
    <View style={{ marginBottom: 20 }}>
      <T weight="800" size={15} style={{ marginBottom: 12 }}>{t('a360.coach_endorsements')}</T>
      <Card pad={16}>
        <View style={{ alignItems: 'center', gap: 10, paddingVertical: 8 }}>
          <T size={13} color={c.mute} style={{ textAlign: 'center', lineHeight: 19 }}>
            Coaches you have trained with can endorse your skills and techniques.
          </T>
          {isOwn ? (
            <Btn
              small
              title="Find a coach"
              onPress={() => push('CoachBoard')}
            />
          ) : null}
        </View>
      </Card>
    </View>
  );
}

function PerformancePostsSection({ isOwn }) {
  const { push } = useNav();
  return (
    <View style={{ marginBottom: 20 }}>
      <T weight="800" size={15} style={{ marginBottom: 12 }}>{t('a360.performances_title')}</T>
      <Card pad={16}>
        <View style={{ alignItems: 'center', gap: 10, paddingVertical: 8 }}>
          <T size={13} color={c.mute} style={{ textAlign: 'center', lineHeight: 19 }}>
            Share performance clips, match highlights and training moments to build your public profile.
          </T>
          {isOwn ? (
            <Btn
              small
              title="Share a performance"
              onPress={() => push('PerformancePublish')}
            />
          ) : null}
        </View>
      </Card>
    </View>
  );
}

export function AthleteRating360Screen({ id }) {
  const { user } = useSession();
  const isOwn = !id || id === user?.id;
  const userId = id ?? user?.id;
  const [sportSlug, setSportSlug] = useState(null);
  const [recruiterView, setRecruiterView] = useState(false);

  const { data, loading, error, reload } = useLoad(
    () => userId ? api.get(`/ratings/players/${userId}`) : Promise.resolve(null),
    [userId],
  );

  const ratings = data?.ratings ?? [];
  const activeSport = sportSlug ?? ratings[0]?.sport_slug ?? null;

  if (loading && !data) return <Screen wide><Loading /></Screen>;
  if (error) return <Screen wide><ErrorBox error={error} onRetry={reload} /></Screen>;

  const hasRatings = ratings.length > 0;

  return (
    <Screen wide scrollable>
      <View style={{ padding: 16 }}>
        {hasRatings ? <KpiStrip ratings={ratings} /> : null}

        {isOwn ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 10 }}>
            <View style={{ flex: 1 }}>
              <T weight="700" size={14}>{t('a360.show_recruiter_view')}</T>
              <T size={12} color={c.mute}>Show how recruiters see your profile</T>
            </View>
            <Switch
              value={recruiterView}
              onValueChange={setRecruiterView}
              trackColor={{ false: c.line, true: c.pink }}
              thumbColor="#fff"
              accessibilityLabel={t('a360.show_recruiter_view')}
            />
          </View>
        ) : null}

        {hasRatings ? (
          <VerifiedLevelSection ratings={ratings} recruiterView={recruiterView} />
        ) : (
          <Card pad={16} style={{ marginBottom: 20 }}>
            <View style={{ alignItems: 'center', paddingVertical: 8, gap: 8 }}>
              <T weight="800" size={16}>{t('a360.verified_level')}</T>
              <T size={13} color={c.mute} style={{ textAlign: 'center', lineHeight: 19 }}>
                Your verified competitive level builds as results from sanctioned events are recorded.
              </T>
            </View>
          </Card>
        )}

        {activeSport ? (
          <PeerAssessedSection
            ratings={ratings}
            userId={userId}
            activeSport={activeSport}
            onSportChange={setSportSlug}
            isOwn={isOwn}
            recruiterView={recruiterView}
          />
        ) : (
          <View style={{ marginBottom: 20 }}>
            <T weight="800" size={15} style={{ marginBottom: 12 }}>{t('a360.peer_assessed')}</T>
            <Card pad={16}>
              <T size={13} color={c.mute} style={{ textAlign: 'center', lineHeight: 19 }}>
                Peer skill assessments will appear once you have competed in a sport.
              </T>
            </Card>
          </View>
        )}

        <ReputationSection userId={userId} />
        <CoachEndorsementsSection isOwn={isOwn} />
        <PerformancePostsSection isOwn={isOwn} />
      </View>
    </Screen>
  );
}
