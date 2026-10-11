// Official results of an event: standings, the podium, and every approved score sheet. Only published sheets show here.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { A, ACard, AEmpty, AHero, AScreen, ASection, AT, AG, LiveBadge, PodiumCard } from '../arena';
import { ErrorBox, Loading, Sheet, T } from '../ui';

export function EventResults({ id }) {
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  if (ev.error) return <AScreen><ErrorBox error={ev.error} onRetry={ev.reload} /></AScreen>;
  if (!ev.data) return <AScreen><Loading /></AScreen>;
  return (
    <AScreen>
      <AHero kicker="Official results" title={ev.data.name} sub={ev.data.status === 'completed' ? 'Final standings' : 'Updated as score sheets are published'} tone={AG.hero} emoji="🏆" />
      <ResultsTab id={id} e={ev.data} />
    </AScreen>
  );
}

export function ResultsTab({ id, e }) {
  const table = useLoad(() => api.get(`/events/${id}/standings`), [id]);
  const res = useLoad(() => api.get(`/events/${id}/results`), [id]);
  const [open, setOpen] = useState(null);
  const detail = useLoad(() => (open ? api.get(`/fixtures/${open}/result`) : Promise.resolve(null)), [open]);
  if (table.error || res.error) return <ErrorBox error={table.error ?? res.error} onRetry={() => { table.reload(); res.reload(); }} />;
  if (!table.data || !res.data) return <Loading />;
  const rows = table.data.filter((r) => r.played > 0);
  const d = detail.data;
  return (
    <>
      {e?.status === 'completed' && rows.length >= 1 ? (
        <>
          <ASection title="Podium" />
          <PodiumCard places={rows.slice(0, 3).map((r) => ({ name: `${r.emoji ?? ''} ${r.name}`.trim(), note: `${r.points} pts` }))} />
        </>
      ) : null}

      <ASection title="Standings" sub="From published results only" />
      {rows.length ? (
        <ACard pad={0} style={{ overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 14, backgroundColor: A.panel2 }}>
            <AT size={11} weight="900" color={A.mute} style={{ flex: 1 }}>TEAM</AT>
            {['P', 'W', 'D', 'L', 'GD', 'PTS'].map((h) => <AT key={h} size={11} weight="900" color={A.mute} style={{ width: h === 'PTS' ? 40 : 30, textAlign: 'center' }}>{h}</AT>)}
          </View>
          {rows.map((r, i) => (
            <View key={r.team_id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14, borderTopWidth: 1, borderColor: A.line }}>
              <AT size={13} weight="900" color={i === 0 ? A.sun : A.mute} style={{ width: 22 }}>{i + 1}</AT>
              <AT size={14} weight="800" style={{ flex: 1 }} numberOfLines={1}>{r.emoji} {r.name}</AT>
              {[r.played, r.won, r.drawn, r.lost, r.goals_for - r.goals_against].map((x, k) => <AT key={k} size={13} weight="600" color={A.mute} num style={{ width: 30, textAlign: 'center' }}>{x}</AT>)}
              <AT size={15} weight="900" num style={{ width: 40, textAlign: 'center' }}>{r.points}</AT>
            </View>
          ))}
        </ACard>
      ) : <AEmpty emoji="📊" title="No official results yet" sub="Standings fill in as score sheets are approved and published." />}

      <ASection title="Score sheets" sub={`${res.data.length} published`} />
      {res.data.length ? res.data.map((r) => (
        <ACard key={r.sheet_id} onPress={() => setOpen(r.fixture_id)} pad={14}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <AT size={14.5} weight="800">{r.home_emoji} {r.home_name}  <AT size={17} weight="900" color={A.cyan} num>{r.home_score}–{r.away_score}</AT>  {r.away_emoji} {r.away_name}</AT>
              <AT size={12} color={A.mute} style={{ marginTop: 3 }}>{[r.round, r.totals?.sets?.length ? r.totals.sets.map((s) => `${s.home}–${s.away}`).join(' ') : null, r.version > 1 ? `corrected (v${r.version})` : null].filter(Boolean).join(' · ')}</AT>
            </View>
            <LiveBadge status="completed" />
          </View>
        </ACard>
      )) : <AT size={13} color={A.mute}>Nothing published yet.</AT>}

      <Sheet visible={!!open} onClose={() => setOpen(null)} title="Official score sheet">
        {detail.loading || !d ? <T color="#64748B">Loading…</T> : (
          <>
            <T weight="800" size={18}>{d.fixture.home_name} {d.home_score}–{d.away_score} {d.fixture.away_name}</T>
            {d.totals?.sets?.length ? <T color="#334155">Sets: {d.totals.sets.map((s) => `${s.home}–${s.away}`).join(', ')}</T> : null}
            {d.totals?.periods?.length ? d.totals.periods.map((p) => <T key={p.period} color="#334155">Period {p.period}: {p.home}–{p.away}</T>) : null}
            {d.totals?.stats ? ['home', 'away'].map((s) => Object.keys(d.totals.stats[s] ?? {}).length ? <T key={s} size={13} color="#64748B">{s === 'home' ? d.fixture.home_name : d.fixture.away_name}: {Object.entries(d.totals.stats[s]).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ')}</T> : null) : null}
            <T size={12} color="#64748B">Signed: {d.signoffs.filter((x) => x.decision === 'signed').map((x) => x.role.replace('_manager', ' team').replace('referee', 'officials')).join(', ') || 'by the organiser'}</T>
            {d.versions?.length > 1 ? <T size={12} color="#64748B">Versions: {d.versions.map((x) => `v${x.version} ${x.status}`).join(' → ')}</T> : null}
          </>
        )}
      </Sheet>
    </>
  );
}
