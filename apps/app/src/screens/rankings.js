// Governed player & team rankings (#507), shown inside the Leaderboard: scope and formula on every table, the number of verified results behind
// every row, "Why am I here?" and rank history. The screen only calls the rankings capabilities; eligibility and privacy are decided on the server.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, H2, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day, withUnit } from '../theme';

const STRENGTH = { limited: ['Limited evidence', 'sun'], solid: ['Solid evidence', 'lime'], strong: ['Strong evidence', 'mint'] };
const KIND_LABEL = { metric: 'The metric itself', per_match: 'Per match', per_90: 'Per 90 verified minutes', team_form: 'Team form' };
const AGG_LABEL = { best: 'Best result', sum: 'Total', mean: 'Average', last: 'Most recent' };
const REASON = {
  duplicate: 'Duplicate of another result', outside_window: 'Older than the window', minutes_not_verified: 'Minutes not verified', self_generated: 'Same-owner teams',
};
const UNMET = { below_min_samples: (u) => `${u.have} of the ${u.need} results needed`, too_few_events: (u) => `${u.have} of the ${u.need} different events needed` };
const score = (r, unit) => (unit && unit !== 'count' ? withUnit(r.score, unit) : `${Number(r.score)}`);

/** The scope a version was published with, in words. */
const scopeText = (v) => {
  const s = v.scope ?? {};
  return [s.season && `Season ${s.season}`, s.region && s.region, s.format && s.format, s.position && s.position, s.event_id && 'One event',
    v.window_days && `Last ${v.window_days} days`, v.window_games && `Last ${v.window_games} games`].filter(Boolean).join(' · ') || 'All time, all competitions';
};

export function RankingsPanel({ sport, sports, onOfficial }) {
  const [pick, setPick] = useState(null);
  const [form, setForm] = useState(false);
  const defs = useLoad(() => api.get('/rankings', { sport: sport ?? undefined, limit: 100 }), [sport]);
  const list = defs.data?.definitions ?? [];
  const model = defs.data?.sport_model;
  const chosen = list.find((d) => d.id === pick) ?? list[0];
  if (defs.loading && !defs.data) return <Loading />;
  if (defs.error) return <ErrorBox error={defs.error} onRetry={defs.reload} />;
  return (
    <View style={{ gap: 10, marginTop: 10 }}>
      {model ? <Card color={c.violetSoft} pad={12}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <T weight="800" size={13}>{model.label}</T>
          <Tag label={model.native ? 'Native model' : 'Generic fallback'} color={model.native ? c.lime : c.sunSoft} />
        </View>
        <T size={12} color={c.mute} style={{ marginTop: 4 }}>{model.note}</T>
      </Card> : <T size={12} color={c.mute}>Pick a sport to define a ranking. Every ranking states its scope, formula, version and minimum sample.</T>}
      {list.length ? <View accessibilityLabel="Rankings" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {list.map((d) => <Chip key={d.id} label={`${d.sport_emoji ?? ''} ${d.name} · ${d.subject === 'team' ? 'teams' : 'players'}${d.visibility === 'club' ? ' · club' : ''}`.trim()} active={chosen?.id === d.id} onPress={() => setPick(d.id)} />)}
      </View> : null}
      {chosen ? <RankingTable key={chosen.id} def={chosen} canDefine={!!model?.can_define} onEdit={() => setForm(chosen)} /> : <Empty emoji="🏅" title="No rankings defined yet" sub={sport ? 'A platform admin or appointed rules governor can define a ranking for this sport. Official points are still available.' : 'Choose a sport to see its rankings.'} />}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {sport && model?.can_define ? <Btn small title="Define a ranking" color={c.violet} onPress={() => setForm(true)} /> : null}
        <Btn small title="Official points" color={c.paper} ink={c.ink} onPress={onOfficial} accessibilityLabel="Show the official points leaderboard" />
      </View>
      {sport && form ? <DefineSheet sport={sport} sports={sports} model={model} edit={form === true ? null : form} onClose={() => setForm(false)} onDone={() => { setForm(false); defs.reload(); }} /> : null}
    </View>
  );
}

function RankingTable({ def, canDefine, onEdit }) {
  const { push } = useNav();
  const [lim, setLim] = useState(25);
  const [why, setWhy] = useState(null);
  const [rules, setRules] = useState(false);
  const t = useLoad(() => api.get(`/rankings/${def.id}`, { limit: lim }), [def.id, lim, def.current_version]);
  if (t.loading && !t.data) return <Loading />;
  if (t.error) return <ErrorBox error={t.error} onRetry={t.reload} />;
  const { version: v, entries, unit } = t.data;
  const team = def.subject === 'team';
  return (
    <View style={{ gap: 10 }}>
      <Card pad={14} accessibilityLabel={`${def.name} scope and formula`}>
        <H2>{def.name}</H2>
        <T size={13} color={c.mute} style={{ marginTop: 2 }}>{scopeText(v)}</T>
        <T size={13} style={{ marginTop: 6 }}>{t.data.formula}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Tag label={`Version ${v.version}`} />
          <Tag label={`Min ${v.min_samples} ${team ? 'games' : 'results'}${v.scope?.event_id ? '' : ` · ${v.min_distinct_events}+ events`}`} />
          <Tag label={v.evidence === 'official' ? 'Approved competition results only' : 'Development data · private'} color={v.evidence === 'official' ? c.lime : c.sunSoft} />
          <Tag label={`${t.data.total} ranked${t.data.not_yet_eligible ? ` · ${t.data.not_yet_eligible} below minimum` : ''}`} color={c.paper} />
        </View>
        <T size={11} color={c.mute} style={{ marginTop: 6 }}>Updated {day(t.data.as_of)} · formula {String(v.formula_hash).slice(0, 8)} · no boost for paid plans</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <Btn small title={rules ? 'Hide rules' : 'Tie & exclusion rules'} color={c.paper} ink={c.ink} onPress={() => setRules(!rules)} />
          {canDefine ? <Btn small title="New version" color={c.paper} ink={c.ink} onPress={onEdit} /> : null}
        </View>
        {rules ? <View style={{ marginTop: 8, gap: 4 }}><T size={12}>{v.tie_rules}</T><T size={12} color={c.mute}>{v.exclusions}</T></View> : null}
      </Card>
      {entries.length ? entries.map((r) => {
        const [sl, sc] = STRENGTH[r.evidence_strength];
        const name = r.subject?.display_name ?? r.subject?.name ?? 'Unknown';
        return (
          <Row key={r.subject?.id ?? r.rank} color={r.rank === 1 ? c.sunSoft : c.paper} onPress={() => setWhy(r.subject?.id)}
            left={<T weight="900" size={20} accessibilityLabel={`Rank ${r.rank}`}>{r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `#${r.rank}`}</T>}
            title={name} sub={`Based on ${r.sample_n} verified ${team ? 'game' : 'result'}${r.sample_n === 1 ? '' : 's'} across ${r.events_n} event${r.events_n === 1 ? '' : 's'}`}
            right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={score(r, unit)} color={c.lime} /><Tag label={sl} color={c[sc] ?? c.sunSoft} /></View>} />
        );
      }) : <Empty emoji="📊" title="Nobody qualifies yet" sub={`A ${team ? 'team' : 'player'} appears once they have ${v.min_samples} eligible ${team ? 'games' : 'results'}${v.scope?.event_id ? '' : ` across ${v.min_distinct_events} events`}. Ranking from fewer would be luck, not form.`} />}
      {entries.length >= lim ? <Btn title="Show more" color={c.paper} ink={c.ink} onPress={() => setLim(lim + 25)} /> : null}
      <WhySheet def={def} subject={why} onClose={() => setWhy(null)} unit={unit} onOpen={(id) => { setWhy(null); push(team ? 'Team' : 'Person', { id }); }} />
    </View>
  );
}

/** "Why am I here?" — the verified results, the formula, what was left out and the limits, plus movement over time. */
export function WhySheet({ def, subject, onClose, unit, onOpen }) {
  const { user } = useSession();
  const why = useLoad(() => (subject ? api.get(`/rankings/${def.id}/subjects/${subject}/why`) : Promise.resolve(null)), [def.id, subject]);
  const hist = useLoad(() => (subject ? api.get(`/rankings/${def.id}/subjects/${subject}/history`, { limit: 12 }) : Promise.resolve(null)), [def.id, subject]);
  const w = why.data;
  const points = (hist.data?.history ?? []).slice().reverse();
  const worst = Math.max(1, ...points.map((p) => p.rank));
  return (
    <Sheet visible={!!subject} onClose={onClose} title="Why am I here?">
      {why.loading && !w ? <Loading /> : why.error ? <ErrorBox error={why.error} onRetry={why.reload} /> : w ? <View style={{ gap: 10 }}>
        <T weight="800" size={18}>{w.status === 'ranked' ? `Rank ${w.rank}` : 'Not ranked yet'}{w.score != null ? ` · ${score(w, unit)}` : ''}</T>
        <T size={13}>{w.formula}</T>
        <T size={12} color={c.mute}>{w.weighting}</T>
        {w.unmet?.length ? w.unmet.map((u, k) => <Tag key={k} label={(UNMET[u.code] ?? (() => u.code))(u)} color={c.sunSoft} />) : null}
        <H2>Results counted ({w.sample_n})</H2>
        {w.included.map((r) => <Row key={r.id} title={day(r.on)} sub={r.points != null ? `${r.goals_for}–${r.goals_against} · ${r.points} pts` : r.minutes ? `${r.minutes} min` : undefined} right={r.value != null ? <Tag label={unit && unit !== 'count' ? withUnit(r.value, unit) : `${r.value}`} /> : undefined} />)}
        {Object.keys(w.excluded_counts ?? {}).length ? <>
          <H2>Left out</H2>
          {Object.entries(w.excluded_counts).map(([k, n]) => <T key={k} size={13}>{n} × {REASON[k] ?? k}</T>)}
        </> : null}
        {points.length ? <>
          <H2>Movement over time</H2>
          {points.length > 1 ? <View accessibilityLabel={`Rank history: ${points.map((p) => p.rank).join(', ')}`} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 64 }}>
            {points.map((p) => <View key={p.snapshot_id} style={{ flex: 1, maxWidth: 32, height: `${Math.max(12, 100 - ((p.rank - 1) / worst) * 80)}%`, backgroundColor: c.violet, borderRadius: 4 }} />)}
          </View> : null}
          <T size={11} color={c.mute}>{points.length > 1 ? 'Each bar is a published snapshot (taller = higher rank), newest on the right. ' : ''}Earlier snapshots are never rewritten, even when the formula changes. Latest: rank {points[points.length - 1].rank} on {day(points[points.length - 1].as_of)} under version {points[points.length - 1].version}{points.length > 1 ? '' : ' (first snapshot)'}.</T>
        </> : <T size={12} color={c.mute}>No snapshots yet; movement appears after the first weekly snapshot.</T>}
        <H2>Limits of this data</H2>
        {w.limits.map((l, k) => <T key={k} size={12} color={c.mute}>• {l}</T>)}
        {onOpen && subject !== user?.id ? <Btn small title="Open profile" color={c.paper} ink={c.ink} onPress={() => onOpen(subject)} /> : null}
      </View> : null}
    </Sheet>
  );
}

/** Define a ranking or publish its next version. Choices come from the sport's real data; direction and unit come from the governed metric. */
function DefineSheet({ sport, sports, model, edit, onClose, onDone }) {
  const { toast } = useSession();
  const kindOpts = (model?.kinds ?? ['metric']).map((k) => ({ value: k, label: KIND_LABEL[k] }));
  const sportRow = (sports ?? []).find((s) => s.slug === sport || s.id === sport);
  const fields = [
    { key: 'name', label: 'Name', hint: 'What people will see, for example “Goals per 90”', maxLength: 80 },
    { key: 'subject', label: 'Ranks', type: 'chips', options: [{ value: 'player', label: 'Players' }, { value: 'team', label: 'Teams (form)' }] },
    { key: 'formula_kind', label: 'Formula', type: 'chips', options: kindOpts, show: (v) => v.subject === 'player', hint: 'Only formulas this sport’s model supports are offered.' },
    { key: 'metric', label: 'Metric', type: 'chips', options: (model?.metrics ?? []).map((m) => ({ value: m, label: m.replace(/_/g, ' ') })), show: (v) => v.subject === 'player', hint: 'Metrics with approved results in this sport. Direction (lower or higher is better) comes from the governed metric.' },
    { key: 'aggregation', label: 'Combine results as', type: 'chips', options: Object.entries(AGG_LABEL).map(([value, label]) => ({ value, label })), show: (v) => v.subject === 'player' && (v.formula_kind ?? 'metric') === 'metric' },
    { key: 'min_samples', label: 'Minimum results to appear', type: 'stepper', min: 1, max: 100, default: 3, hint: 'Public rankings need at least 3.' },
    { key: 'min_distinct_events', label: 'Minimum different events', type: 'stepper', min: 1, max: 20, default: 2, hint: 'Stops one lucky event deciding a ranking.' },
    { key: 'window', label: 'Period', type: 'chips', optional: true, options: [{ value: 'all', label: 'All time' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last 12 months' }], default: 'all', show: (v) => v.subject === 'player' },
    { key: 'window_games', label: 'Latest games counted', type: 'stepper', min: 1, max: 50, default: 5, show: (v) => v.subject === 'team' },
    { key: 'season', label: 'Season', type: 'chips', optional: true, options: [{ value: 'any', label: 'Any' }, ...[0, 1, 2].map((k) => ({ value: String(new Date().getFullYear() - k), label: String(new Date().getFullYear() - k) }))], default: 'any' },
    { key: 'format', label: 'Competition type', type: 'chips', optional: true, options: [{ value: 'any', label: 'Any' }, ...['tournament', 'league', 'friendly'].map((x) => ({ value: x, label: x }))], default: 'any' },
    ...(model?.cities?.length ? [{ key: 'region', label: 'City', type: 'chips', optional: true, options: [{ value: 'any', label: 'Anywhere' }, ...model.cities.map((x) => ({ value: x, label: x }))], default: 'any' }] : []),
    ...(model?.positions?.length ? [{ key: 'position', label: 'Position', type: 'chips', optional: true, options: [{ value: 'any', label: 'All positions' }, ...model.positions.map((x) => ({ value: x, label: x }))], default: 'any', show: (v) => v.subject === 'player', hint: 'Only people who list this position are compared.' }] : []),
    { key: 'note', label: 'Why this version (optional)', type: 'multiline', optional: true },
  ];
  const submit = async (v) => {
    const pick = (x) => (x && x !== 'any' && x !== 'all' ? x : undefined);
    const team = v.subject === 'team';
    const r = await api.post('/rankings', {
      definition_id: edit?.id, expected_version: edit?.current_version ?? 0, sport, subject: v.subject, name: v.name,
      formula_kind: team ? 'team_form' : (v.formula_kind ?? 'metric'), metric: team ? undefined : v.metric, aggregation: v.aggregation ?? 'best',
      min_samples: v.min_samples, min_distinct_events: v.min_distinct_events, window_days: !team && pick(v.window) ? Number(v.window) : undefined, window_games: team ? v.window_games : undefined,
      scope: { season: pick(v.season) ? Number(v.season) : undefined, format: pick(v.format), region: pick(v.region), position: team ? undefined : pick(v.position) }, note: v.note || undefined,
      client_key: `rk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    toast(`Published ${r.definition.name} · version ${r.version.version}`);
    onDone();
  };
  return <FormSheet visible onClose={onClose} title={edit ? `New version of ${edit.name}` : `Define a ranking${sportRow ? ` · ${sportRow.name}` : ''}`} submitLabel="Publish" fields={fields} initial={edit ? { name: edit.name, subject: edit.subject, formula_kind: edit.formula_kind, metric: edit.metric, min_samples: edit.min_samples, min_distinct_events: edit.min_distinct_events } : { subject: 'player' }} onSubmit={submit} />;
}
