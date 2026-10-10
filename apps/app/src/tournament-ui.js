// Shared look for tournament screens: a dark hero with live numbers, team crests, match cards, a real bracket with
// connectors, a "what's left to set up" stepper and pill tabs. Pure presentation — screens pass in data.
import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Btn, Card, T } from './ui';
import { HScroll } from './pickers';
import { locale } from './locale';
import { c, glass, heroGrad } from './theme';

// Game times are venue-local (a 7 pm game in Mumbai is 7 pm for everyone), so every helper takes the venue's time zone.
const clock = (iso, tz) => new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined });
export const dayLabel = (iso, tz) => new Date(iso).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz || undefined });
export const dayKey = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz || undefined }); // YYYY-MM-DD
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/** Round team badge: emoji on the team colour. */
export function Crest({ emoji, color = c.pink, size = 40, ring }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `${color}22`, borderWidth: ring ? 2 : 1, borderColor: ring ?? `${color}55`, alignItems: 'center', justifyContent: 'center' }}>
      <T size={size * 0.5}>{emoji ?? '🏅'}</T>
    </View>
  );
}

/** Translucent number tile for the hero. */
function HeroStat({ icon, value, label }) {
  return (
    <View style={{ flex: 1, minWidth: 86, backgroundColor: glass.fill, borderWidth: 1, borderColor: glass.line, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 12 }}>
      <T size={16}>{icon}</T>
      <T color="#fff" weight="800" size={22} style={{ marginTop: 2 }}>{value}</T>
      <T color={glass.sub} size={11} weight="700" style={{ letterSpacing: 0.5 }}>{label.toUpperCase()}</T>
    </View>
  );
}

export function TournamentHero({ e, stats = [], note, tone = '#4F46E5', children }) {
  const days = e.starts_on ? Math.ceil((Date.parse(String(e.starts_on).slice(0, 10)) - Date.now()) / 864e5) : null;
  const when = e.starts_on ? `${new Date(e.starts_on).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}${e.ends_on && e.ends_on !== e.starts_on ? ` – ${new Date(e.ends_on).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}` : ''}` : 'Dates to be set';
  const phase = e.status === 'completed' ? 'Completed' : e.status === 'ongoing' ? 'Live now' : days == null ? 'Planning' : days > 0 ? `Starts in ${days} day${days === 1 ? '' : 's'}` : days === 0 ? 'Starts today' : 'Underway';
  return (
    <View style={{ borderRadius: 26, overflow: 'hidden' }}>
      <LinearGradient colors={heroGrad(tone)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 20, gap: 14 }}>
        <View pointerEvents="none" style={{ position: 'absolute', right: -50, top: -70, width: 220, height: 220, borderRadius: 110, backgroundColor: '#fff', opacity: 0.07 }} />
        <View pointerEvents="none" style={{ position: 'absolute', right: 60, bottom: -90, width: 160, height: 160, borderRadius: 80, backgroundColor: '#fff', opacity: 0.05 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: glass.fill, borderWidth: 1, borderColor: glass.line, alignItems: 'center', justifyContent: 'center' }}><T size={34}>{e.banner_emoji ?? '🏆'}</T></View>
          <View style={{ flex: 1 }}>
            <T color="#fff" weight="800" size={24} numberOfLines={2} style={{ letterSpacing: -0.5 }}>{e.name}</T>
            <T color={glass.sub} size={13} weight="600">{[e.sport, e.kind, e.city].filter(Boolean).join(' · ')}</T>
          </View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <View style={{ backgroundColor: e.status === 'ongoing' ? '#16A34A' : 'rgba(255,255,255,0.18)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 }}><T color="#fff" size={12} weight="800">{phase}</T></View>
          <View style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 }}><T color="#fff" size={12} weight="800">📅 {when}</T></View>
          {note ? <View style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 }}><T color="#fff" size={12} weight="800">{note}</T></View> : null}
        </View>
        {stats.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{stats.map((s) => <HeroStat key={s.label} {...s} />)}</View> : null}
        {children}
      </LinearGradient>
    </View>
  );
}

/** Days that have games: weekday over date, with the number of games. days: [{ date: 'YYYY-MM-DD', count }]. */
export function GameDays({ days, value, onChange }) {
  return (
    <HScroll gap={8}>
      {days.map((d) => {
        const on = d.date === value, dt = new Date(`${d.date}T12:00:00Z`);
        return (
          <Pressable key={d.date} onPress={() => onChange(d.date)} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={{ width: 64, paddingVertical: 10, borderRadius: 20, alignItems: 'center', gap: 4, backgroundColor: on ? c.pink : c.paper, borderWidth: 1, borderColor: on ? c.pink : c.line }}>
            <T size={11} weight="800" color={on ? '#E0E7FF' : c.mute}>{dt.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' }).toUpperCase()}</T>
            <T size={20} weight="800" color={on ? '#fff' : c.ink}>{dt.getUTCDate()}</T>
            <T size={10} weight="700" color={on ? '#E0E7FF' : c.mute}>{dt.toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' })}</T>
            <View style={{ backgroundColor: on ? '#fff' : c.pinkSoft, borderRadius: 8, paddingHorizontal: 6 }}><T size={10} weight="800" color={c.pink}>{d.count} game{d.count === 1 ? '' : 's'}</T></View>
          </Pressable>
        );
      })}
    </HScroll>
  );
}

/** Scrollable pill tabs. tabs: [{ key, label, icon, badge }]. */
export function PillTabs({ tabs, value, onChange }) {
  return (
    <HScroll gap={8}>
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <Pressable key={t.key} onPress={() => onChange(t.key)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, backgroundColor: on ? c.ink : c.paper, borderWidth: 1, borderColor: on ? c.ink : c.line }}>
            <T size={14}>{t.icon}</T>
            <T size={13} weight="800" color={on ? '#fff' : c.ink}>{t.label}</T>
            {t.badge ? <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: on ? '#fff' : c.pink, alignItems: 'center', justifyContent: 'center' }}><T size={10} weight="800" color={on ? c.ink : '#fff'}>{t.badge}</T></View> : null}
          </Pressable>
        );
      })}
    </HScroll>
  );
}

export function SectionTitle({ title, sub, action, onAction }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 8 }}>
      <View style={{ flex: 1 }}>
        <T weight="800" size={19} style={{ letterSpacing: -0.3 }}>{title}</T>
        {sub ? <T color={c.mute} size={13}>{sub}</T> : null}
      </View>
      {action ? <Pressable onPress={onAction} hitSlop={10}><T color={c.pink} weight="800" size={13}>{action} ›</T></Pressable> : null}
    </View>
  );
}

/** Number tile (money, counts). */
export function StatTile({ icon, value, label, tone = c.paper, ink = c.ink }) {
  return (
    <View style={{ flex: 1, minWidth: 120, backgroundColor: tone, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: c.line }}>
      {icon ? <T size={18}>{icon}</T> : null}
      <T weight="800" size={20} color={ink} style={{ marginTop: 4 }}>{value}</T>
      <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.5 }}>{label.toUpperCase()}</T>
    </View>
  );
}

/** Thin progress bar. */
export function Bar({ pct, color = c.pink, height = 8, track = c.violetSoft }) {
  return <View style={{ height, borderRadius: height / 2, backgroundColor: track, overflow: 'hidden' }}><View style={{ width: `${clamp(pct, 0, 100)}%`, height, borderRadius: height / 2, backgroundColor: color }} /></View>;
}

/** Checklist with a progress header; the first unfinished step is highlighted with its action. steps: [{ key, title, sub, done, cta, onPress }]. */
export function SetupSteps({ steps }) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <Card pad={16}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T weight="800" size={16}>{done === steps.length ? 'Everything is set up 🎉' : 'Set up your tournament'}</T>
        <T weight="800" size={13} color={c.pink}>{done}/{steps.length}</T>
      </View>
      <View style={{ marginTop: 8, marginBottom: 6 }}><Bar pct={(done / steps.length) * 100} color={done === steps.length ? c.lime : c.pink} /></View>
      {steps.map((s, i) => {
        const isNext = next?.key === s.key;
        return (
          <Pressable key={s.key} onPress={s.onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
            <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: s.done ? c.lime : isNext ? c.pink : c.violetSoft }}>
              <T size={13} weight="800" color={s.done || isNext ? '#fff' : c.mute}>{s.done ? '✓' : i + 1}</T>
            </View>
            <View style={{ flex: 1 }}>
              <T weight="700" size={14} color={s.done ? c.mute : c.ink} style={s.done ? { textDecorationLine: 'line-through' } : null}>{s.title}</T>
              {s.sub ? <T size={12} color={c.mute}>{s.sub}</T> : null}
            </View>
            {isNext && s.cta ? <Btn small title={s.cta} onPress={s.onPress} /> : <T color={c.mute} size={18}>›</T>}
          </Pressable>
        );
      })}
    </Card>
  );
}

const WIN = { fontWeight: '900' };
/** One game: crests either side, score or time in the middle, round / court underneath. */
export function MatchCard({ f, onPress, onScore, spotlight }) {
  const done = f.status === 'completed', live = f.status === 'live';
  const homeWon = done && (f.winner_team_id ? f.winner_team_id === f.home_team_id : f.home_score > f.away_score);
  const awayWon = done && (f.winner_team_id ? f.winner_team_id === f.away_team_id : f.away_score > f.home_score);
  const Team = ({ name, emoji, color, ph, won }) => (
    <View style={{ flex: 1, alignItems: 'center', gap: 6 }}>
      <Crest emoji={name ? emoji : '❔'} color={color ?? c.mute} size={spotlight ? 56 : 46} ring={won ? c.lime : undefined} />
      <T size={13} weight={won ? '900' : '700'} numberOfLines={2} style={{ textAlign: 'center' }} color={name ? c.ink : c.mute}>{name ?? ph ?? 'To be decided'}</T>
    </View>
  );
  return (
    <Card pad={14} onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <View style={{ backgroundColor: c.violetSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}><T size={11} weight="800" color={c.mute}>{(f.round ?? 'Game').toUpperCase()}</T></View>
        {live ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.red }} /><T size={11} weight="800" color={c.red}>LIVE</T></View>
          : done ? <T size={11} weight="800" color={c.lime}>FULL TIME</T> : <T size={12} weight="700" color={c.mute}>{dayLabel(f.scheduled_at, f.venue_timezone)}</T>}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Team name={f.home_name} emoji={f.home_emoji} color={f.home_color} ph={f.home_placeholder} won={homeWon} />
        <View style={{ width: 92, alignItems: 'center' }}>
          {done || live ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T size={26} style={homeWon ? WIN : { fontWeight: '600' }} color={homeWon ? c.ink : c.mute}>{f.home_score ?? 0}</T>
              <T size={16} color={c.mute}>:</T>
              <T size={26} style={awayWon ? WIN : { fontWeight: '600' }} color={awayWon ? c.ink : c.mute}>{f.away_score ?? 0}</T>
            </View>
          ) : (
            <View style={{ alignItems: 'center' }}>
              <T size={20} weight="800" style={{ letterSpacing: -0.5 }}>{clock(f.scheduled_at, f.venue_timezone)}</T>
              <T size={11} weight="700" color={c.mute}>VS</T>
            </View>
          )}
        </View>
        <Team name={f.away_name} emoji={f.away_emoji} color={f.away_color} ph={f.away_placeholder} won={awayWon} />
      </View>
      {f.resource_name || onScore ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderColor: c.line }}>
          <T size={12} color={c.mute} weight="600">{f.resource_name ? `📍 ${f.resource_name}${f.duration_min ? ` · ${f.duration_min} min` : ''}` : ''}</T>
          {onScore && !done && f.home_team_id && f.away_team_id ? <Btn small title="Enter result" onPress={() => onScore(f)} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- bracket
const SLOT_H = 112, CARD_H = 92, COL_W = 196, GAP_W = 30;

function BracketGame({ g }) {
  const done = g.status === 'completed';
  const Row = ({ name, emoji, ph, score, won }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: CARD_H / 2 - 4, paddingHorizontal: 10, backgroundColor: won ? c.limeSoft : 'transparent' }}>
      <T size={16}>{name ? emoji ?? '🏅' : '❔'}</T>
      <T size={12} weight={won ? '900' : '600'} color={name ? c.ink : c.mute} numberOfLines={1} style={{ flex: 1 }}>{name ?? ph ?? 'TBD'}</T>
      {done ? <T size={14} weight={won ? '900' : '600'} color={won ? c.ink : c.mute}>{score}</T> : null}
    </View>
  );
  const hw = done && g.winner_team_id === g.home_team_id, aw = done && g.winner_team_id === g.away_team_id;
  return (
    <View style={{ width: COL_W, height: CARD_H, borderRadius: 14, backgroundColor: c.paper, borderWidth: 1, borderColor: done ? c.lime : c.line, overflow: 'hidden', justifyContent: 'center' }}>
      <Row name={g.home_name} emoji={g.home_emoji} ph={g.home_placeholder} score={g.home_score} won={hw} />
      <View style={{ height: 1, backgroundColor: c.line }} />
      <Row name={g.away_name} emoji={g.away_emoji} ph={g.away_placeholder} score={g.away_score} won={aw} />
      <T size={10} color={c.mute} weight="700" style={{ position: 'absolute', right: 8, bottom: 1 }}>{g.status !== 'completed' && g.scheduled_at ? `${dayLabel(g.scheduled_at, g.venue_timezone)} ${clock(g.scheduled_at, g.venue_timezone)}` : ''}</T>
    </View>
  );
}

/** Pairs of games in a round feed one game in the next: a bracket line joins them. */
function Connector({ count, height }) {
  const slot = height / count;
  return (
    <View style={{ width: GAP_W, height }}>
      {Array.from({ length: Math.floor(count / 2) }, (_, i) => (
        <View key={i} style={{ position: 'absolute', left: 0, top: (2 * i + 0.5) * slot, height: slot, width: GAP_W / 2, borderTopWidth: 2, borderBottomWidth: 2, borderRightWidth: 2, borderColor: c.line }}>
          <View style={{ position: 'absolute', left: GAP_W / 2 - 2, top: slot / 2 - 1, width: GAP_W / 2 + 2, height: 2, backgroundColor: c.line }} />
        </View>
      ))}
    </View>
  );
}

/** Whole bracket as scrolling columns (Round of 16 → … → Final), plus a bronze game and the champion. */
export function BracketView({ data }) {
  const rounds = (data?.rounds ?? []).filter((r) => r.kind !== 'third_place');
  const third = data?.rounds?.find((r) => r.kind === 'third_place')?.games?.[0];
  if (!rounds.length) return null;
  // positions come from each game's bracket slot on the full tree, so byes leave gaps instead of squashing later rounds
  const R = rounds.length, H = 2 ** (R - 1) * SLOT_H;
  return (
    <View style={{ gap: 12 }}>
      {data.champion ? (
        <LinearGradient colors={['#F59E0B', '#EA580C']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <T size={40}>🏆</T>
          <View style={{ flex: 1 }}><T color="#fff" size={12} weight="800" style={{ letterSpacing: 1 }}>CHAMPIONS</T><T color="#fff" size={22} weight="800">{data.champion.name}</T></View>
        </LinearGradient>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 6, paddingHorizontal: 2 }}>
        {rounds.map((r, i) => {
          const slots = 2 ** (R - 1 - i), slotH = H / slots;
          return (
            <React.Fragment key={r.kind}>
              <View style={{ width: COL_W }}>
                <T size={12} weight="800" color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.6 }}>{r.label.toUpperCase()}</T>
                <View style={{ height: H }}>
                  {r.games.map((g) => <View key={g.id} style={{ position: 'absolute', top: (g.slot ?? 0) * slotH + (slotH - CARD_H) / 2 }}><BracketGame g={g} /></View>)}
                </View>
              </View>
              {i < R - 1 ? <View style={{ paddingTop: 28 }}><Connector count={slots} height={H} /></View> : null}
            </React.Fragment>
          );
        })}
      </ScrollView>
      {third ? (<View style={{ gap: 6 }}><T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.6 }}>THIRD PLACE</T><BracketGame g={third} /></View>) : null}
    </View>
  );
}

/** A team in a list: crest, name, seed badge and a strength bar. */
export function TeamCard({ team, seed, rating, maxRating = 1, note, right }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: c.paper, borderRadius: 18, borderWidth: 1, borderColor: c.line }}>
      <View>
        <Crest emoji={team.emoji} color={team.color ?? c.pink} size={46} />
        {seed ? <View style={{ position: 'absolute', right: -6, top: -6, minWidth: 22, height: 22, borderRadius: 11, backgroundColor: c.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}><T size={10} weight="800" color="#fff">#{seed}</T></View> : null}
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <T weight="800" size={15} numberOfLines={1}>{team.name}</T>
        {note ? <T size={12} color={c.mute} numberOfLines={1}>{note}</T> : null}
        {rating != null ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1 }}><Bar pct={(rating / Math.max(maxRating, 0.01)) * 100} height={6} /></View><T size={11} weight="800" color={c.pink}>{Number(rating).toFixed(2)}</T></View> : null}
      </View>
      {right}
    </View>
  );
}
