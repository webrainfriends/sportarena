import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, GradCard, H1, Loading, Screen, Seg, Section, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { c, grad } from '../theme';
import { QuickLogFab, QuickLogSheet, ReadinessCard, useReadiness } from './wellness';
import { EditProfileSheet } from './player';

const TONE = { good: ['✅', c.limeSoft], watch: ['🎯', c.sunSoft], info: ['💡', c.violetSoft] };
const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const unit = (r) => (r.unit === '%' ? '%' : r.unit === '/10' ? '/10' : '');
// Where you stand among the cohort: written out as well as drawn, never colour only.
const standing = (p) => (p >= 75 ? 'Top quarter' : p >= 55 ? 'Above the middle' : p >= 45 ? 'Around the middle' : p >= 25 ? 'Below the middle' : 'Bottom quarter');
const fill = (p) => (p >= 55 ? c.lime : p >= 45 ? c.sun : c.red);

function Compare({ r }) {
  return (
    <View accessible accessibilityLabel={`${r.label}: you ${r.mine}${unit(r)}, typical ${r.cohort_median}${unit(r)}. ${standing(r.percentile)}, ahead of ${r.percentile} percent of ${r.n} players.`} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <T weight="700">{r.label}</T>
        <T size={13} color={c.mute}>You <T weight="800" size={15}>{r.mine}{unit(r)}</T> · typical {r.cohort_median}{unit(r)}{r.unit === 'per match' ? ' per match' : ''}</T>
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: c.bg, overflow: 'hidden' }}><View style={{ width: `${Math.max(3, r.percentile)}%`, height: 8, borderRadius: 4, backgroundColor: fill(r.percentile) }} /></View>
      <T size={12} color={c.mute}>{standing(r.percentile)} · ahead of {r.percentile}% of {r.n} players</T>
    </View>
  );
}

/** Your matches, read against other players: by region, level and the whole sport. Numbers first, then a plain-language read-out. */
function SportInsights({ profile, onEdit }) {
  const { push } = useNav();
  const ins = useLoad(() => api.get('/me/insights', { sport_profile_id: profile.id }), [profile.id]);
  const [scope, setScope] = useState(null);
  const d = ins.data;
  if (ins.error) return <ErrorBox error={ins.error} onRetry={ins.reload} />;
  if (ins.loading && !d) return <Loading />;
  if (!d.ready) {
    return (
      <Card>
        <T weight="800" size={16}>{d.profile.sport_emoji} {d.profile.sport}</T>
        <T color={c.mute} style={{ marginTop: 4 }}>{d.reason} {d.matches ? `You have ${d.matches} so far.` : ''}</T>
        <Btn small title="Log a match" onPress={() => push('SportProfile', { id: profile.id })} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
      </Card>
    );
  }
  const sc = d.scopes.find((s) => s.scope === scope) ?? d.scopes.find((s) => s.available) ?? d.scopes[0];
  const f = d.form;
  return (
    <View style={{ gap: 14 }}>
      <GradCard colors={grad.hero}>
        <T size={12} weight="800" color="#fff" style={{ opacity: 0.85 }}>{d.summary.ai ? '✨ AI READ-OUT' : 'READ-OUT FROM YOUR NUMBERS'}</T>
        <T size={20} weight="800" color="#fff" style={{ marginTop: 4, letterSpacing: -0.4 }}>{d.summary.headline}</T>
        <T color="#fff" style={{ marginTop: 8, opacity: 0.92 }}>{d.summary.next_step}</T>
      </GradCard>
      <View style={{ gap: 10 }}>
        {d.summary.insights.map((x, i) => (
          <Card key={i} color={(TONE[x.tone] ?? TONE.info)[1]} pad={14}>
            <T weight="800">{(TONE[x.tone] ?? TONE.info)[0]} {x.title}</T>
            <T size={14} color={c.mute} style={{ marginTop: 3 }}>{x.body}</T>
          </Card>
        ))}
      </View>
      <Section title="How you compare" color={c.cyan}>
        <Seg options={d.scopes.map((s) => ({ value: s.scope, label: s.scope === 'region' ? `📍 ${s.label}` : s.scope === 'level' ? `🎚️ ${nice(d.profile.level)}` : `🌍 All ${d.profile.sport}` }))} value={sc.scope} onChange={setScope} color={c.cyan} />
        <Card>
          {sc.available ? (
            <>
              <T size={12} color={c.mute}>Against {sc.size} other {sc.scope === 'region' ? `players in ${sc.label}` : sc.scope === 'level' ? `${sc.label} players` : `${d.profile.sport} players`}</T>
              {sc.comparisons.map((r) => <Compare key={r.key} r={r} />)}
            </>
          ) : <T color={c.mute}>Not enough players to compare yet ({sc.size} of 5 needed). Comparisons never show fewer than 5 other players, so nobody can be singled out.</T>}
        </Card>
        {d.region_hint ? <Card color={c.sunSoft} pad={14}><T size={13}>{d.region_hint}</T><Btn small title="Set where you play" onPress={() => onEdit(profile)} style={{ marginTop: 8, alignSelf: 'flex-start' }} /></Card> : null}
      </Section>
      <Section title="Recent form" color={c.mint}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {[['Last 5', f.recent], ['Before that', f.previous]].map(([label, x]) => (
            <Card key={label} style={{ flex: 1 }} pad={14}>
              <T size={12} color={c.mute} weight="700">{label.toUpperCase()}</T>
              <T size={22} weight="800" style={{ marginTop: 4 }}>{x.win_rate === null ? '–' : `${x.win_rate}%`}</T><T size={12} color={c.mute}>won · {x.matches} match{x.matches === 1 ? '' : 'es'}</T>
              <T size={13} style={{ marginTop: 4 }}>{x.avg_rating === null ? 'No ratings' : `Rating ${x.avg_rating}`}</T>
            </Card>
          ))}
        </View>
      </Section>
      <T size={12} color={c.mute}>{d.basis}</T>
    </View>
  );
}

/** Player > Insights: overview numbers, readiness, then the AI read-out and comparisons for the chosen sport. */
export function Insights() {
  const { push } = useNav();
  const sports = useLoad(() => api.get('/me/sport-profiles'), []);
  const dash = useLoad(() => api.get('/dashboard'), []);
  const rd = useReadiness();
  const [sel, setSel] = useState(null);
  const [edit, setEdit] = useState(null);
  const [quickLog, setQuickLog] = useState(false);
  const all = sports.data ?? [];
  const athlete = all.filter((p) => p.role === 'athlete');
  const cur = athlete.find((p) => p.id === sel) ?? athlete[0];
  const matches = all.reduce((a, p) => a + p.summary.matches, 0);
  const tiles = [['Matches', sports.data ? matches : '–', 'All sports, official and logged'], ['Official pts', dash.data?.points ?? '–', 'Approved results']];
  return (
    <View style={{ flex: 1 }}>
      <Screen onRefresh={() => { sports.reload(); dash.reload(); rd.reload(); }}>
        <H1 style={{ marginTop: 8 }}>Insights</H1>
        <T color={c.mute} weight="600">How you are doing, compared with players in your region, at your level and across your sport.</T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          {tiles.map(([label, value, sub]) => (
            <Card key={label} style={{ flex: 1 }} pad={14}><T size={12} color={c.mute} weight="700">{label.toUpperCase()}</T><T size={28} weight="800" style={{ marginTop: 4 }}>{value}</T><T size={11} color={c.mute}>{sub}</T></Card>
          ))}
        </View>
        <View style={{ marginTop: 14 }}><ReadinessCard rd={rd} onLog={() => setQuickLog(true)} onOpen={() => push('Health')} /></View>
        <View style={{ marginTop: 18, gap: 12 }}>
          {sports.error ? <ErrorBox error={sports.error} onRetry={sports.reload} /> : sports.loading && !sports.data ? <Loading /> : !athlete.length ? (
            <Empty emoji="🏅" title="Add a sport to get insights" sub="Add the sports you play under My sports, log your matches, and your numbers are read against other players." />
          ) : (
            <>
              {athlete.length > 1 ? <HScroll>{athlete.map((p) => <Chip key={p.id} label={`${p.sport_emoji} ${p.sport}`} active={p.id === cur.id} onPress={() => setSel(p.id)} />)}</HScroll> : null}
              <SportInsights key={cur.id} profile={cur} onEdit={setEdit} />
            </>
          )}
        </View>
      </Screen>
      <QuickLogFab onPress={() => setQuickLog(true)} bottom={110} />
      <QuickLogSheet visible={quickLog} onClose={() => setQuickLog(false)} onDone={rd.reload} />
      {edit ? <EditProfileSheet p={edit} onClose={() => setEdit(null)} onDone={sports.reload} /> : null}
    </View>
  );
}
