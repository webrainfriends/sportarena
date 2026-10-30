// Streaks and achievements (benchmark gap 9), shown as a tab of the Leaderboard. Everything comes from verified results: approved competition
// results and granted medals, never practice or imports. Each badge says which results earned it ("Why?") and the next tier shows progress.
// The screen only calls GET /me/streaks and GET /me/achievements; the sport family models live on the server.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Card, Empty, ErrorBox, H2, Loading, Row, Sheet, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { c } from '../theme';

const ICON = { results: '🎯', weekly_streak: '🔥', personal_bests: '📈', sports: '🧭', events: '🏟️', medals: '🏅', goal_game_goals: '⚽', goal_game_assists: '🤝', cricket_runs: '🏏', cricket_wickets: '🎳' };
const TIER_TONE = { Bronze: c.orangeSoft, Silver: c.violetSoft, Gold: c.sunSoft, Platinum: c.cyanSoft };

const unitOf = (n, u) => (Number(n) === 1 ? u.replace(/s$/, '') : u);
const Flame = ({ title, value, unit, sub, on }) => (
  <View accessible accessibilityLabel={`${title}: ${value} ${unit}`} style={{ flexGrow: 1, flexBasis: 150, minHeight: 96, padding: 12, borderRadius: 16, backgroundColor: on ? c.sunSoft : c.paper, borderWidth: 1, borderColor: c.line }}>
    <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{title.toUpperCase()}</T>
    <T size={28} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{on ? '🔥 ' : ''}{value} <T size={13} color={c.mute}>{unit}</T></T>
    <T size={12} color={c.mute}>{sub}</T>
  </View>
);

export function StreaksPanel({ sports }) {
  const [sport, setSport] = useState(null);
  const [why, setWhy] = useState(null);
  const q = sport ? { sport } : undefined;
  const st = useLoad(() => api.get('/me/streaks', q), [sport]);
  const ac = useLoad(() => api.get('/me/achievements', q), [sport]);
  if ((st.loading && !st.data) || (ac.loading && !ac.data)) return <Loading />;
  if (st.error || ac.error) return <ErrorBox error={st.error ?? ac.error} onRetry={() => { st.reload(); ac.reload(); }} />;
  const w = st.data.weekly, a = ac.data;
  const empty = !a.totals.results && !a.totals.medals;
  return (
    <View style={{ gap: 10 }}>
      <MenuField label="Sport" title="Choose a sport" value={sport} onChange={setSport} placeholder="All sports" options={[{ value: null, label: 'All sports' }, ...(sports ?? []).map((s) => ({ value: s.slug, label: `${s.emoji ?? ''} ${s.name}`.trim() }))]} />
      <T color={c.mute} size={13}>Only approved competition results and granted medals count. Practice and imported figures never do.</T>
      {empty ? <Empty emoji="🔥" title="No streaks yet" sub="Your first approved competition result starts a weekly streak and earns your first badge." /> : <>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <Flame title="Weekly streak" value={w.current} unit={w.current === 1 ? 'week' : 'weeks'} sub={`Longest ${w.longest} · ${w.weeks} active weeks`} on={w.current > 0} />
          <Flame title="Personal-best run" value={st.data.current_best_run} unit="in a row" sub={`Best run ${st.data.personal_best.reduce((m, s) => Math.max(m, s.longest), 0)}`} on={st.data.current_best_run > 0} />
          <Flame title="Verified results" value={a.totals.results} unit="results" sub={`${a.totals.sports} sport${a.totals.sports === 1 ? '' : 's'} · ${a.totals.events} event${a.totals.events === 1 ? '' : 's'} · ${a.totals.medals} medal${a.totals.medals === 1 ? '' : 's'}`} />
        </View>
        {st.data.personal_best.length ? <>
          <H2>Personal-best runs</H2>
          {st.data.personal_best.slice(0, 6).map((p) => <Row key={`${p.sport}${p.metric}`} title={`${p.sport.replace(/[-_]/g, ' ')} · ${p.metric.replace(/_/g, ' ')}`} sub={`${p.results} verified results${p.family === 'generic' ? ' · generic model' : ''}`} right={<T weight="800">{p.current} now · {p.longest} best</T>} />)}
        </> : null}
        <H2>Badges</H2>
        {a.achievements.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {a.achievements.map((x) => (
            <Card key={x.key} onPress={() => setWhy(x)} accessibilityLabel={`${x.label}. Tap to see why`} color={TIER_TONE[x.tier] ?? c.paper} style={{ flexGrow: 1, flexBasis: 150, minHeight: 88 }}>
              <T size={26}>{ICON[x.group] ?? '🏆'}</T>
              <T weight="800">{x.label}</T>
              <T size={12} color={c.mute}>{x.threshold} {unitOf(x.threshold, x.unit)}</T>
            </Card>
          ))}
        </View> : <Empty emoji="🏅" title="No badges yet" sub="Keep competing: the next tier of each badge is below." />}
        {a.next_up.length ? <>
          <H2>Next up</H2>
          {a.next_up.map((x) => <Row key={x.key} title={`${ICON[x.group] ?? '🏆'} ${x.label}`} sub={`${x.progress} of ${x.threshold} ${unitOf(x.threshold, x.unit)}`} right={<Tag label={`${Math.round((x.progress / x.threshold) * 100)}%`} color={c.cyanSoft} />} />)}
        </> : null}
      </>}
      <Sheet visible={!!why} onClose={() => setWhy(null)} title={why?.label ?? ''}>
        <T color={c.mute}>Earned from these verified results:</T>
        {(why?.evidence ?? []).map((e) => <Row key={e.id} title={`${String(e.sport ?? e.metric).replace(/[-_]/g, ' ')} · ${e.metric.replace(/_/g, ' ')}`} sub={e.on} right={<T weight="800">{e.value}</T>} />)}
        {why && why.evidence.length >= 5 ? <T size={12} color={c.mute}>Showing the first five.</T> : null}
      </Sheet>
    </View>
  );
}
