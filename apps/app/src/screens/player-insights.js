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

const DIRECTION = { lower: 'Lower is better', higher: 'Higher is better', unknown: 'Direction not defined' };

function Compare({ r, results }) {
  const cover = `Recorded in ${r.coverage.recorded} of ${r.coverage.total} ${results ? 'results' : 'matches'}${r.coverage.recorded < r.coverage.total ? ' (others had no figure)' : ''}`;
  const ranked = r.status === 'ranked';
  return (
    <View accessible accessibilityLabel={`${r.label}: you ${r.mine}${unit(r)}${r.cohort_median != null ? `, typical ${r.cohort_median}${unit(r)}` : ''}. ${DIRECTION[r.direction]}. ${cover}. ${ranked ? `${standing(r.percentile)}, ahead of ${r.percentile} percent of ${r.n} players.` : r.note}`} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 4 }}>
        <T weight="700">{r.label}</T>
        <T size={13} color={c.mute}>You <T weight="800" size={15}>{r.mine}{unit(r)}</T>{r.cohort_median != null ? ` · typical ${r.cohort_median}${unit(r)}` : ''}{r.unit === 'per match' || r.unit === 'per result' || r.unit?.startsWith('best') ? ` ${r.unit}` : ''}</T>
      </View>
      {ranked ? <View style={{ height: 8, borderRadius: 4, backgroundColor: c.bg, overflow: 'hidden' }}><View style={{ width: `${Math.max(3, r.percentile)}%`, height: 8, borderRadius: 4, backgroundColor: fill(r.percentile) }} /></View> : null}
      <T size={12} color={c.mute}>{ranked ? `${standing(r.percentile)} · ahead of ${r.percentile}% of ${r.n} players · ` : `${r.note} · `}{DIRECTION[r.direction]}</T>
      <T size={12} color={c.mute}>{cover}</T>
    </View>
  );
}

/** Evidence, position and match format: what the comparison is drawn from. Position and format are only offered when they apply. */
function Controls({ d, f, setF }) {
  const opts = d.options;
  return (
    <View style={{ gap: 10 }}>
      <Seg options={opts.evidences.map((e) => ({ value: e.key, label: e.key === 'official' ? '🏆 Official results' : '📝 Self-logged' }))} value={f.evidence} onChange={(v) => setF({ evidence: v, position: f.position, match_type: v === 'official' ? undefined : f.match_type })} color={c.violet} />
      {opts.positions.length ? <HScroll><Chip label="Any position" active={!f.position} onPress={() => setF({ ...f, position: undefined })} />{opts.positions.map((p) => <Chip key={p} label={p} active={f.position?.toLowerCase() === p.toLowerCase()} onPress={() => setF({ ...f, position: p })} />)}</HScroll> : null}
      {f.evidence === 'self_reported' && opts.match_types.length > 1 ? <HScroll><Chip label="Any format" active={!f.match_type} onPress={() => setF({ ...f, match_type: undefined })} />{opts.match_types.map((m) => <Chip key={m} label={nice(m)} active={f.match_type === m} onPress={() => setF({ ...f, match_type: m })} />)}</HScroll> : null}
    </View>
  );
}

/** Your own ratings of your matches. Not peer or coach ratings, and said so. */
function RatingTrend({ t }) {
  const arrow = t.trend === 'up' ? '▲ rising' : t.trend === 'down' ? '▼ slipping' : t.trend === 'flat' ? '■ steady' : null;
  return (
    <Card pad={14}>
      <T size={12} color={c.mute} weight="700">YOUR SELF-RATINGS</T>
      {t.rated_matches === 0 ? <T color={c.mute} style={{ marginTop: 4 }}>You have not rated any matches yet. Add a rating when you log a match to see your own trend.</T> : (
        <>
          <T size={22} weight="800" style={{ marginTop: 4 }}>{t.recent.avg ?? '–'} <T size={13} color={c.mute}>last {t.recent.n} · before {t.previous.avg ?? '–'} ({t.previous.n})</T></T>
          <T size={13} style={{ marginTop: 2 }}>{t.sufficient ? `${arrow}${t.change ? ` by ${Math.abs(t.change)}` : ''}` : `Rate at least 3 matches in each window to see a trend (${t.rated_matches} rated so far).`}</T>
        </>
      )}
      <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t.label}</T>
    </Card>
  );
}

/** The comparison itself: cohort chooser, ranked rows, your own figures when the cohort is too small. Shared by the player and by authorised staff. */
function BenchmarkBody({ d, region }) {
  const [scope, setScope] = useState(null);
  const sc = d.scopes.find((s) => s.scope === scope) ?? d.scopes.find((s) => s.available) ?? d.scopes[0];
  const results = d.evidence === 'official';
  return (
    <>
      <Seg options={d.scopes.map((s) => ({ value: s.scope, label: s.scope === 'region' ? `📍 ${s.label}` : s.scope === 'level' ? `🎚️ ${nice(d.profile.level)}` : `🌍 All ${d.profile.sport}` }))} value={sc.scope} onChange={setScope} color={c.cyan} />
      <Card>
        <T size={12} color={c.mute}>{d.evidence_label}{d.filters.position ? ` · ${d.filters.position}` : ''}{d.filters.match_type ? ` · ${nice(d.filters.match_type)}` : ''}</T>
        {sc.available ? (
          <>
            <T size={12} color={c.mute}>Against {sc.size} other {sc.scope === 'region' ? `players in ${sc.label}` : sc.scope === 'level' ? `${sc.label} players` : `${d.profile.sport} players`}</T>
            {sc.comparisons.map((r) => <Compare key={r.key} r={r} results={results} />)}
          </>
        ) : (
          <>
            <T color={c.mute} style={{ marginTop: 4 }}>Not enough players to compare yet ({sc.size} of 5 needed{d.filters.position || d.filters.match_type ? ' with these filters' : ''}). Comparisons never show fewer than 5 other players, so nobody can be singled out.</T>
            {d.my_metrics?.length ? <T weight="700" style={{ marginTop: 10 }}>Your figures</T> : null}
            {(d.my_metrics ?? []).filter((r) => r.status === 'insufficient_data' || r.status === 'cohort_too_small').map((r) => <Compare key={r.key} r={{ ...r, note: r.status === 'insufficient_data' ? r.note : 'No cohort yet' }} results={results} />)}
          </>
        )}
      </Card>
      {region}
    </>
  );
}

/** Not ready: say exactly why, keep the filters so they can be changed. */
function NotReady({ d, f, setF, children }) {
  return (
    <Card>
      <T weight="800" size={16}>{d.profile.sport_emoji} {d.profile.sport}</T>
      <T color={c.mute} style={{ marginTop: 4 }}>{d.reason} {d.matches ? `You have ${d.matches} so far.` : ''}</T>
      {d.options && d.code !== 'guardian_consent_required' ? <View style={{ marginTop: 10 }}><Controls d={d} f={f} setF={setF} /></View> : null}
      {children}
    </Card>
  );
}

/** Staff and guardians: an athlete's benchmarks, aggregates only, shown while the athlete's consent and relationship stand. */
export function AthleteBenchmarks({ athlete_id }) {
  const [f, setF] = useState({ evidence: 'self_reported' });
  const q = useLoad(() => api.get(`/athletes/${athlete_id}/benchmarks`, f), [athlete_id, f.evidence, f.position, f.match_type]);
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (q.loading && !d) return <Loading />;
  if (!d.ready) return <NotReady d={d} f={f} setF={setF} />;
  return (
    <View style={{ gap: 12 }}>
      <Card color={c.violetSoft} pad={12}><T size={13}>Viewing {d.viewer === 'guardian' ? 'as guardian' : 'with coaching access'}: totals and averages only, shown while consent and the coaching relationship stand.</T></Card>
      <Controls d={d} f={f} setF={setF} />
      <BenchmarkBody d={d} />
      <RatingTrend t={d.self_rating_trend} />
      <T size={12} color={c.mute}>{d.basis}</T>
    </View>
  );
}

/** Your matches, read against other players: by region, level and the whole sport. Numbers first, then a plain-language read-out. */
function SportInsights({ profile, onEdit }) {
  const { push } = useNav();
  const [f, setF] = useState({ evidence: 'self_reported' });
  const ins = useLoad(() => api.get('/me/insights', { sport_profile_id: profile.id, ...f }), [profile.id, f.evidence, f.position, f.match_type]);
  const d = ins.data;
  if (ins.error) return <ErrorBox error={ins.error} onRetry={ins.reload} />;
  if (ins.loading && !d) return <Loading />;
  if (!d.ready) {
    return (
      <NotReady d={d} f={f} setF={setF}>
        {d.code === 'not_enough_data' && !f.position && !f.match_type && d.evidence === 'self_reported' ? <Btn small title="Log a match" onPress={() => push('SportProfile', { id: profile.id })} style={{ marginTop: 10, alignSelf: 'flex-start' }} /> : null}
      </NotReady>
    );
  }
  const form = d.form;
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
        <Controls d={d} f={f} setF={setF} />
        <BenchmarkBody d={d} region={d.region_hint ? <Card color={c.sunSoft} pad={14}><T size={13}>{d.region_hint}</T><Btn small title="Set where you play" onPress={() => onEdit(profile)} style={{ marginTop: 8, alignSelf: 'flex-start' }} /></Card> : null} />
      </Section>
      <Section title="Your self-ratings" color={c.violet}><RatingTrend t={d.self_rating_trend} /></Section>
      <Section title="Recent form" color={c.mint}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {[['Last 5', form.recent], ['Before that', form.previous]].map(([label, x]) => (
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
