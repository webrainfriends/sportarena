// Jersey numbers by team, event, game or tournament. The number on a sport profile is the default; a number set here wins for that one scope.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day } from '../theme';

const KINDS = [{ value: 'team', label: 'Team' }, { value: 'event', label: 'Event' }, { value: 'tournament', label: 'Tournament' }, { value: 'game', label: 'Game' }];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));

export function JerseyNumbers() {
  const mine = useLoad(() => api.get('/jersey-numbers'), []);
  const [form, setForm] = useState(null); // {} = new, row = changing a number
  const scopes = useLoad(async () => {
    if (!form) return null;
    const [teams, events, games] = await Promise.all([
      api.get('/teams', { mine: true }).catch(() => []), api.get('/events', { limit: 50 }).catch(() => []), api.get('/fixtures', { limit: 50 }).catch(() => []),
    ]);
    const arr = (x) => (Array.isArray(x) ? x : x?.items ?? []);
    return { teams: arr(teams), events: arr(events), games: arr(games) };
  }, [!!form]);
  const S = scopes.data ?? { teams: [], events: [], games: [] };
  const pick = (list, label) => list.map((x) => ({ value: x.id, label: label(x) }));
  const fields = [
    { key: 'scope_kind', label: 'This number is for a', type: 'chips', options: KINDS },
    { key: 'team_id', label: 'Team', type: 'chips', show: (v) => v.scope_kind === 'team', options: pick(S.teams, (t) => t.name), hint: S.teams.length ? undefined : 'Join or create a team first.' },
    { key: 'event_id', label: 'Event', type: 'chips', show: (v) => v.scope_kind === 'event', options: pick(S.events, (e) => e.name) },
    { key: 'tournament_id', label: 'Tournament', type: 'chips', show: (v) => v.scope_kind === 'tournament', options: pick(S.events.filter((e) => ['tournament', 'league'].includes(e.kind)), (e) => e.name) },
    { key: 'game_id', label: 'Game', type: 'chips', show: (v) => v.scope_kind === 'game', options: pick(S.games, (g) => `${g.home_name ?? g.event_name}${g.away_name ? ` v ${g.away_name}` : ''} · ${day(g.scheduled_at)}`) },
    { key: 'number', label: 'Jersey number', type: 'stepper', min: 0, max: 999, default: 10 },
  ];
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <T weight="800" size={16}>Numbers by team, event or game</T>
        <Btn small title="＋ Add a number" onPress={() => setForm({})} accessibilityLabel="Add a jersey number for a team, event or game" />
      </View>
      <T size={12} color={c.mute}>Your sport profile number is the default. A number set here is used for that team, event, game or tournament only.</T>
      {mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : !mine.data ? <Loading /> : mine.data.length ? mine.data.map((r) => (
        <Row key={r.id} title={`#${r.number} · ${r.scope_name ?? KIND_LABEL[r.scope_kind]}`} sub={KIND_LABEL[r.scope_kind]} right={<Tag label={`#${r.number}`} />}
          onPress={() => setForm({ scope_kind: r.scope_kind, [`${r.scope_kind}_id`]: r.scope_id, number: r.number })} />
      )) : <Empty emoji="🔢" title="No special numbers" sub="Add one when you wear a different number for a team, event, game or tournament." />}
      {form ? (
        <FormSheet visible onClose={() => setForm(null)} title="Jersey number" submitLabel="Save number" initial={form} fields={fields}
          onSubmit={async (v) => {
            const scope_id = v[`${v.scope_kind}_id`];
            if (!scope_id) throw new Error(`Choose the ${KIND_LABEL[v.scope_kind].toLowerCase()}`);
            await api.post('/jersey-numbers', { scope_kind: v.scope_kind, scope_id, number: v.number });
            mine.reload();
            return 'Number saved';
          }} />
      ) : null}
    </View>
  );
}
