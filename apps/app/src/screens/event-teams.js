// Teams of an event: who is in, seeding, who to invite (ranked from past results, or search any team) and the invitations sent.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { A, ABar, ABtn, ACard, ACrest, AEmpty, ARow, ASection, AT, ATag } from '../arena';
import { EntityPicker } from '../entity-picker';
import { FormSheet } from '../FormSheet';
import { Field, Loading } from '../ui';
import { useDo } from './console-utils';

function TeamRow({ team, seed, rating, maxRating = 1, note, right }) {
  return (
    <ACard pad={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View>
          <ACrest emoji={team.emoji} color={team.color ?? A.violet} size={46} />
          {seed ? <View style={{ position: 'absolute', right: -6, top: -6, minWidth: 22, height: 22, borderRadius: 11, backgroundColor: A.magenta, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}><AT size={11} weight="900" color="#fff">{seed}</AT></View> : null}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <AT size={15} weight="800" numberOfLines={1}>{team.name}</AT>
          {note ? <AT size={12} weight="600" color={A.mute} numberOfLines={1}>{note}</AT> : null}
          {rating != null ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1 }}><ABar pct={(rating / Math.max(maxRating, 0.01)) * 100} height={6} color={A.cyan} /></View><AT size={11} weight="800" color={A.mute} num>{Number(rating).toFixed(2)}</AT></View> : null}
        </View>
        {right}
      </View>
    </ACard>
  );
}

export function TeamsTab({ id, e, accepted, inv, seeds, reload }) {
  const [q, setQ] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [picked, setPicked] = useState([]);
  const sug = useLoad(() => api.get(`/events/${id}/suggestions`, { limit: 100 }), [id]);
  const rules = useLoad(() => api.get(`/events/${id}/rules`), [id]);
  const refresh = () => { sug.reload(); rules.reload(); reload(); };
  const act = useDo(refresh);
  const seedOf = useMemo(() => new Map(seeds.map((s) => [s.team_id, s])), [seeds]);
  const all = sug.data?.items ?? [];
  const items = all.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || (t.city ?? '').toLowerCase().includes(q.toLowerCase()));
  const max = Math.max(...all.map((t) => t.rating), 1);
  const r = (k) => rules.data?.find((x) => x.kind === k)?.params;
  const cities = [...new Set(all.map((t) => t.city).filter(Boolean))];
  const open = inv.filter((n) => n.status === 'invited');
  const room = e.capacity ? Math.max(e.capacity - accepted.length - open.length, 1) : items.length;
  return (
    <>
      <ASection title={`Teams in · ${accepted.length}${e.capacity ? `/${e.capacity}` : ''}`} />
      {accepted.length ? accepted.map((t) => { const s = seedOf.get(t.team_id); return <TeamRow key={t.entry_id} team={t} seed={s?.seed} rating={s?.rating ?? undefined} maxRating={max} note={s ? `${s.source} seed` : 'Not seeded yet'} />; }) : <AEmpty emoji="👥" title="No teams yet" sub="Invite teams below. They appear here once they accept." />}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <ABtn small title="Seed from results" tone="neon" onPress={() => act(() => api.post(`/events/${id}/seeds/compute`, { method: 'rating' }), 'Teams seeded')} disabled={accepted.length < 2} />
        <ABtn small title="Seed from standings" tone="ghost" onPress={() => act(() => api.post(`/events/${id}/seeds/compute`, { method: 'standings' }), 'Teams seeded')} disabled={accepted.length < 2} />
      </View>

      <ASection title="Invite a team" sub="Search any team of this sport" />
      <ACard style={{ gap: 10 }}>
        <EntityPicker kind="team" multi label="Teams" sport={e.sport_slug} value={picked} onChange={setPicked} />
        {picked.length ? <ABtn small title={`Invite ${picked.length}`} onPress={() => act(async () => { await api.post(`/events/${id}/invitations`, { invitees: picked.map((p) => ({ team_id: p.id })), source: 'manual' }); setPicked([]); }, 'Invitations sent')} /> : null}
      </ACard>

      <ASection title="Recommended" sub="Ranked from past results: recent wins and goal difference, adjusted for few games" action="Rules" onAction={() => setRulesOpen(true)} />
      {rules.data?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{rules.data.map((x) => <ATag key={x.id} tone={A.violet} label={`${x.kind.replace(/_/g, ' ')}${Object.keys(x.params).length ? `: ${Object.values(x.params).join(', ')}` : ''}`} />)}</View> : null}
      <Field value={q} onChangeText={setQ} placeholder="Filter recommendations by name or city…" />
      {sug.loading && !sug.data ? <Loading /> : items.length ? items.map((t) => (
        <TeamRow key={t.team_id} team={t} rating={t.rating} maxRating={max} note={`#${t.rank} · ${t.played} games · ${t.won}W ${t.drawn}D ${t.lost}L${t.city ? ` · ${t.city}` : ''}`}
          right={<ABtn small title="Invite" onPress={() => act(() => api.post(`/events/${id}/invitations`, { invitees: [{ team_id: t.team_id }], source: 'ranking' }), `${t.name} invited`)} />} />
      )) : <AEmpty emoji="🔎" title={q ? 'No team matches' : 'No candidates'} sub={q ? 'Try another name or city.' : 'Teams of this sport that are not already in or invited show up here.'} />}
      {items.length > 1 && !q ? <ABtn title={`Invite the top ${Math.min(items.length, room)}`} tone="neon" onPress={() => act(() => api.post(`/events/${id}/invitations`, { invitees: items.slice(0, room).map((t) => ({ team_id: t.team_id })), source: 'ranking' }), 'Invitations sent')} /> : null}

      <ASection title="Invitations" />
      {inv.length ? inv.map((n) => (
        <ARow key={n.id} left={<ACrest emoji={n.team_emoji ?? '🏃'} size={40} />} title={n.team_name ?? n.user_name} sub={`${n.source}${n.rating ? ` · rating ${Number(n.rating).toFixed(2)}` : ''}`}
          right={<><ATag label={n.status} />{n.status === 'invited' ? <ABtn small tone="ghost" title="Withdraw" onPress={() => act(() => api.post(`/event-invitations/${n.id}/withdraw`), 'Withdrawn')} /> : null}</>} />
      )) : <AEmpty emoji="✉️" title="Nobody invited yet" />}

      <FormSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} title="Who should be invited?" submitLabel="Save rules"
        initial={{ top: r('invite_top_n')?.n, city: r('city')?.city, min_games: r('min_games')?.n }}
        fields={[
          { key: 'top', label: 'Only the strongest N teams', type: 'stepper', min: 1, max: 500, optional: true },
          { key: 'min_games', label: 'At least this many past games', type: 'stepper', min: 0, max: 100, optional: true },
          ...(cities.length ? [{ key: 'city', label: 'Only teams from', type: 'chips', optional: true, options: cities }] : []),
        ]}
        onSubmit={async (v) => {
          const next = [];
          if (v.top) next.push({ kind: 'invite_top_n', params: { n: v.top } });
          if (v.city) next.push({ kind: 'city', params: { city: v.city } });
          if (v.min_games) next.push({ kind: 'min_games', params: { n: v.min_games } });
          for (const x of rules.data ?? []) if (['min_rating', 'exclude_team', 'seeding', 'note'].includes(x.kind)) next.push({ kind: x.kind, params: x.params });
          await api.post(`/events/${id}/rules`, { rules: next }); refresh(); return 'Rules saved';
        }} />
    </>
  );
}
