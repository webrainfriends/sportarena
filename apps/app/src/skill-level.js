// Skill level (#633): the verified level 1.0-7.0 with how far to trust it, on the player passport. One component for iOS, iPadOS, Android and web;
// it only calls the rating capabilities, so who can see what (evidence for the player only, no youth accounts) is decided on the server.
import React, { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';
import { api } from './api';
import { useLoad } from './hooks';
import { Btn, Card, Chip, ErrorBox, H2, Loading, Sheet, T, Tag } from './ui';
import { c, day } from './theme';
import { t } from './i18n';

const STRENGTH = { reliable: ['skill.reliable', c.mint], developing: ['skill.developing', c.sun], provisional: ['skill.provisional', c.violetSoft] };
const MATCH = { beginner: 'skill.beginner', amateur: 'skill.amateur', semi_pro: 'skill.semi_pro', pro: 'skill.pro' };
const sign = (d) => (d > 0 ? `+${d.toFixed(2)}` : d < 0 ? `−${Math.abs(d).toFixed(2)}` : '0.00');

/** 1.0 to 7.0 track with the level marked, so a number always has a place on the scale. */
const Scale = ({ level }) => (
  <View accessible accessibilityLabel={`Level ${level.toFixed(2)} on a scale from 1 to 7`} style={{ height: 22, justifyContent: 'center' }}>
    <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft }} />
    <View style={{ position: 'absolute', left: `${((level - 1) / 6) * 100}%`, marginLeft: -9, width: 18, height: 18, borderRadius: 9, backgroundColor: c.pink, borderWidth: 3, borderColor: c.paper }} />
  </View>
);

/** Level after each game, oldest to newest. Drawn in real pixels (measured, never stretched) so the end dot stays round at any width. */
const Trend = ({ points, height = 64 }) => {
  const [width, setWidth] = useState(0);
  if (points.length < 2) return null;
  const ys = points.map((p) => p.level), lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(hi - lo, 0.4);
  const pad = 8, x = (i) => pad + (i / (points.length - 1)) * (width - pad * 2), y = (v) => height - pad - ((v - lo) / span) * (height - pad * 2);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.level).toFixed(1)}`).join(' ');
  return (
    <View accessible accessibilityLabel={t('skill.a11y_trend', { n: points.length, from: ys[0].toFixed(1), to: ys.at(-1).toFixed(1) })} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))} style={{ height }}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Polyline points={line} fill="none" stroke={c.pink} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          <Circle cx={x(points.length - 1)} cy={y(ys.at(-1))} r={4.5} fill={c.pink} />
        </Svg>
      ) : null}
    </View>
  );
};

/** The last 20 verified games as a line; loads by itself so the card above renders at once. */
const TrendFor = ({ userId, slug }) => {
  const h = useLoad(() => api.get(`/ratings/players/${userId}/${slug}/history`, { limit: 20 }), [userId, slug]);
  const pts = [...(h.data?.history ?? [])].reverse();
  return pts.length > 1 ? <View style={{ marginTop: 12 }}><Trend points={pts} /></View> : null;
};

function HowSheet({ onClose, sport }) {
  const info = useLoad(() => api.get('/ratings/models', { sport }), [sport]);
  const h = info.data?.how, m = info.data?.sports?.[0];
  return (
    <Sheet visible onClose={onClose} title={t('skill.how_title')}>
      {info.loading && !info.data ? <Loading /> : info.error ? <ErrorBox error={info.error} onRetry={info.reload} /> : h ? (
        <View style={{ gap: 12 }}>
          {m ? <Card color={c.violetSoft} pad={12}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <T weight="800" size={13}>{m.model}</T>
              <Tag label={m.native ? t('skill.native') : t('skill.fallback')} color={m.native ? c.lime : c.sunSoft} />
            </View>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>{info.data.models[m.family].note}</T>
          </Card> : null}
          {[['The scale', h.scale], ['What counts', h.evidence], ['How reliable is it?', h.reliability], ['How a game moves it', h.weighting], ['Who is rated', h.youth]].map(([t, body]) => (
            <View key={t}><T weight="800" size={13}>{t}</T><T size={13} color={c.mute} style={{ marginTop: 2 }}>{body}</T></View>
          ))}
          <View>
            <T weight="800" size={13}>{t('skill.in_open')}</T>
            <T size={13} color={c.mute} style={{ marginTop: 2 }}>Once your level is reliable it replaces the level you stated: {h.matching.map((b) => `${t(MATCH[b.bucket])} ${b.from.toFixed(1)}–${b.to.toFixed(1)}`).join(', ')}.</T>
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

/** Why one game moved the level, in plain words from the server (only the player and staff can load it). */
function WhyRow({ userId, sport, gameId }) {
  const [open, setOpen] = useState(false);
  const w = useLoad(() => (open ? api.get(`/ratings/players/${userId}/${sport.slug}/games/${gameId}`) : Promise.resolve(null)), [open, userId, sport.slug, gameId]);
  return (
    <View style={{ paddingBottom: 8 }}>
      <View style={{ alignSelf: 'flex-start' }}><Btn small title={t('skill.explain')} color={c.paper} ink={c.ink} onPress={() => setOpen((o) => !o)} accessibilityLabel={t('skill.explain_title')} /></View>
      {open ? (w.loading && !w.data ? <Loading /> : w.error ? <ErrorBox error={w.error} onRetry={w.reload} /> : w.data ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{w.data.explanation}</T> : null) : null}
    </View>
  );
}

function HistorySheet({ userId, sport, onClose }) {
  const h = useLoad(() => api.get(`/ratings/players/${userId}/${sport.slug}/history`, { limit: 50 }), [userId, sport.slug]);
  const rows = h.data?.history ?? [];
  const seen = h.data?.evidence_visible;
  return (
    <Sheet visible onClose={onClose} title={t('skill.history_title', { sport: sport.name })}>
      {h.loading && !h.data ? <Loading /> : h.error ? <ErrorBox error={h.error} onRetry={h.reload} /> : (
        <View style={{ gap: 8 }}>
          <T size={12} color={c.mute}>{seen ? t('skill.history_own') : t('skill.history_public')}</T>
          {rows.map((r, i) => (
            <View key={`${r.played_at}-${i}`}>
            <View accessible accessibilityLabel={`${day(r.played_at)}: level ${r.level.toFixed(2)}, ${sign(r.delta)}${seen ? `, ${r.result}` : ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, borderBottomWidth: 1, borderBottomColor: c.line }}>
              <View style={{ flex: 1 }}>
                <T weight="700" size={14}>{seen ? `${r.result === 'win' ? t('skill.won') : r.result === 'loss' ? t('skill.lost') : t('skill.drew')}${r.event ? ` · ${r.event.name}` : ''}` : day(r.played_at)}</T>
                <T size={12} color={c.mute}>{day(r.played_at)}{seen ?  ` · ${t('skill.chance', { chance: r.expected_win_chance, opp: r.opponent_level.toFixed(1) })}` : ''}</T>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <T weight="800" size={16} style={{ fontVariant: ['tabular-nums'] }}>{r.level.toFixed(2)}</T>
                <T weight="700" size={12} color={r.delta > 0 ? c.lime : r.delta < 0 ? c.red : c.mute}>{sign(r.delta)}</T>
              </View>
            </View>
            {seen && r.game ? <WhyRow userId={userId} sport={sport} gameId={r.game.id} /> : null}
            </View>
          ))}
          {h.data && h.data.total > rows.length ? <T size={12} color={c.mute}>{t('skill.showing', { n: rows.length, total: h.data.total })}</T> : null}
        </View>
      )}
    </Sheet>
  );
}

/**
 * The verified level on a passport. `own` swaps the empty state from nothing to an explanation of how to get a level; for anyone else an empty
 * (or youth, or unknown) result renders nothing, so a missing rating never reveals why it is missing.
 */
export function SkillLevelCard({ userId, own = false }) {
  const [pick, setPick] = useState(null);
  const [sheet, setSheet] = useState(null);
  const r = useLoad(() => api.get(`/ratings/players/${userId}`), [userId]);
  if (r.loading && !r.data) return own ? <Card pad={16}><Loading /></Card> : null;
  if (r.error) return own ? <ErrorBox error={r.error} onRetry={r.reload} /> : null;
  const list = r.data?.ratings ?? [];
  if (!list.length) {
    return own ? (
      <Card pad={16}>
        <H2>{t('skill.title')}</H2>
        <T size={13} color={c.mute} style={{ marginTop: 6 }}>{t('skill.empty')}</T>
        <View style={{ marginTop: 12, alignSelf: 'flex-start' }}><Btn small title={t('skill.how_btn')} color={c.paper} ink={c.ink} onPress={() => setSheet('how')} /></View>
        {sheet === 'how' ? <HowSheet onClose={() => setSheet(null)} /> : null}
      </Card>
    ) : null;
  }
  const cur = list.find((x) => x.sport.slug === pick) ?? list[0];
  const [labelKey, tone] = STRENGTH[cur.strength];
  const label = t(labelKey);
  return (
    <Card pad={16}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <H2>{t('skill.title')}</H2>
        <Tag label={label} color={tone} />
      </View>
      {list.length > 1 ? <View accessibilityLabel={t('skill.sports_with')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {list.map((x) => <Chip key={x.sport.slug} label={`${x.sport.emoji ?? ''} ${x.sport.name}`.trim()} active={cur.sport.slug === x.sport.slug} onPress={() => setPick(x.sport.slug)} />)}
      </View> : <T size={13} color={c.mute} style={{ marginTop: 2 }}>{cur.sport.emoji} {cur.sport.name}</T>}
      <View accessible accessibilityLabel={t('skill.a11y_level', { level: cur.level.toFixed(2), strength: label, n: cur.games })} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 12 }}>
        <T weight="800" size={52} style={{ letterSpacing: -2, fontVariant: ['tabular-nums'], lineHeight: 56 }}>{cur.level.toFixed(2)}</T>
        <T size={13} color={c.mute} style={{ paddingBottom: 10 }}>{t('skill.games', { n: cur.games })}</T>
      </View>
      <View style={{ marginTop: 10 }}><Scale level={cur.level} /></View>
      <TrendFor userId={userId} slug={cur.sport.slug} />
      <View style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <T weight="700" size={12} color={c.mute}>{t('skill.reliability')}</T>
          <T weight="800" size={12}>{cur.reliability}%</T>
        </View>
        <View accessible accessibilityLabel={t('skill.a11y_rel', { n: cur.reliability })} style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, marginTop: 4, overflow: 'hidden' }}>
          <View style={{ width: `${cur.reliability}%`, height: 8, backgroundColor: tone === c.violetSoft ? c.mute : tone }} />
        </View>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>{cur.matches_as ? t('skill.is_reliable', { bucket: t(MATCH[cur.matches_as]) }) : t('skill.not_reliable')}</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {[[`${cur.wins}-${cur.draws}-${cur.losses}`, t('skill.wdl')], [cur.peak_level.toFixed(1), t('skill.peak')]].map(([v, l]) => (
          <View key={l} style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 14, backgroundColor: c.bg }}>
            <T weight="800" size={18} style={{ fontVariant: ['tabular-nums'] }}>{v}</T>
            <T weight="700" size={10} color={c.mute} style={{ letterSpacing: 0.9, marginTop: 2 }}>{l}</T>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
        <Btn small title={t('skill.history_btn')} color={c.violet} onPress={() => setSheet('history')} />
        <Btn small title={t('skill.how_btn2')} color={c.paper} ink={c.ink} onPress={() => setSheet('how')} />
      </View>
      {sheet === 'how' ? <HowSheet sport={cur.sport.slug} onClose={() => setSheet(null)} /> : null}
      {sheet === 'history' ? <HistorySheet userId={userId} sport={cur.sport} onClose={() => setSheet(null)} /> : null}
    </Card>
  );
}

