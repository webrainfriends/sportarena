// Event console > Public page (#501): what the public may see of this event, and which real sponsorships get a placement on its public pages.
// The public page itself is the Event screen; this tab only sets its policy and slots. Visibility is a choice of chips, switches are chips you toggle,
// sponsors and games are picked from the event's own data (never typed).
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { A, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStat, AT } from '../arena';
import { ErrorBox, Loading } from '../ui';
import { FormSheet } from '../FormSheet';
import { ShareButton } from './spectate';

const VIS = [
  ['public', '🌍 Public', 'Anyone can find and open it, signed in or not.'],
  ['unlisted', '🔗 Link only', 'Not listed in search; anyone with the link can open it.'],
  ['private', '🔒 Private', 'Only the organiser, entrants and crew. Shared links stop working.'],
];
const SLOT = { title_partner: 'Title partner · event page', leaderboard: 'Leaderboard partner · table', scorecard: 'Scorecard partner · live centres', fixture: 'Game partner · one game' };

export function PublicPageTab({ id, e, games = [] }) {
  const { toast } = useSession();
  const { push } = useNav();
  const s = useLoad(() => api.get(`/events/${id}/public-settings`), [id]);
  const pl = useLoad(() => api.get(`/events/${id}/sponsor-placements`, { include_ended: true }), [id]);
  const [adding, setAdding] = useState(false);
  if ((s.loading && !s.data) || (pl.loading && !pl.data)) return <Loading />;
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  const v = s.data;
  const set = async (body, msg) => {
    try { await api.patch(`/events/${id}/public-settings`, body); toast(msg ?? 'Saved'); s.reload(); } catch (x) { toast('' + x.message); }
  };
  const active = (pl.data?.placements ?? []).filter((p) => p.status === 'active');
  const ended = (pl.data?.placements ?? []).filter((p) => p.status === 'ended');
  const unplaced = pl.data?.unplaced_sponsorships ?? [];
  const end = async (p) => { try { await api.post(`/sponsor-placements/${p.id}/end`); toast('Placement ended'); pl.reload(); } catch (x) { toast('' + x.message); } };
  const gameLabel = (g) => `${g.home_name ?? 'TBD'} v ${g.away_name ?? 'TBD'}${g.scheduled_at ? ` · ${new Date(g.scheduled_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}`;

  return (
    <View style={{ gap: 14 }}>
      <ACard>
        <AT size={16} weight="900">The public page</AT>
        <AT size={13} color={A.mute} style={{ marginTop: 4 }}>Fans, families and sponsors see live games, the table, the bracket, awards and approved media. It is built from your event data: change a result or schedule and the page follows, with corrections labelled.</AT>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <ABtn small title="👁 Preview" onPress={() => push('Event', { id })} />
          <ShareButton card={{ type: 'event', id }} arena label="Share event" />
        </View>
      </ACard>

      <ASection title="Who can see it" />
      <View style={{ gap: 8 }}>
        {VIS.map(([k, label, sub]) => (
          <ARow key={k} title={label} sub={sub} onPress={() => (v.visibility === k ? null : set({ visibility: k }, `Event is now ${k === 'unlisted' ? 'link-only' : k}`))} tone={v.visibility === k ? A.violet : undefined}
            right={v.visibility === k ? <AT color={A.green} weight="900">✓</AT> : null} />
        ))}
      </View>
      {v.youth_event ? <AT size={12.5} color={A.sun}>This is a youth event (maximum age under 18): players are never named, it is never indexed by search engines, and fan reactions, MVP votes and sponsor links are switched off.</AT> : null}

      <ASection title="On the page" sub="Switch things on or off. Each change is logged." />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="toolbar">
        <AChip label={`🔎 Search engines ${v.indexable ? 'on' : 'off'}`} active={v.indexable} onPress={() => (v.visibility === 'public' && !v.youth_event ? set({ indexable: !v.indexable }) : toast(v.youth_event ? 'Youth events are never indexed' : 'Only a public event can be indexed'))} />
        <AChip label={`🧑‍⚖️ Match officials ${v.show_officials ? 'shown' : 'hidden'}`} active={v.show_officials} onPress={() => set({ show_officials: !v.show_officials })} />
        <AChip label={`🔥 Fan reactions ${v.reactions ? 'on' : 'off'}`} active={v.reactions} onPress={() => (v.youth_event ? toast('Not available on youth events') : set({ reactions: !v.reactions }))} />
        <AChip label={`⭐ Fan MVP vote ${v.mvp_vote ? 'on' : 'off'}`} active={v.mvp_vote} onPress={() => (v.youth_event ? toast('Not available on youth events') : set({ mvp_vote: !v.mvp_vote }))} />
        <AChip label={v.archived ? '🗄 Archived' : '🗄 Archive'} active={v.archived} onPress={() => set({ archived: !v.archived }, v.archived ? 'Back in discovery' : 'Archived: out of discovery, still reachable by its link')} />
      </View>
      <AT size={12} color={A.mute}>Fan votes are shown as fan votes and never create an official award. Archiving removes the event from discovery but keeps its link working.</AT>
      {v.indexable && !v.effective_indexable ? <AT size={12} color={A.sun}>Search engines are switched on but not applied right now (draft, archived or restricted event).</AT> : null}

      <ASection title="Sponsor placements" sub="Real, active sponsorships of this event. Exposure is measured, never estimated." action={unplaced.length ? 'Add' : null} onAction={() => setAdding(true)} />
      {active.length ? active.map((p) => (
        <ACard key={p.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}><AT weight="800">{p.emoji} {p.sponsor_name}</AT><AT size={12.5} color={A.mute}>{SLOT[p.slot]}{p.fixture_id ? ` · ${gameLabel(games.find((g) => g.id === p.fixture_id) ?? {})}` : ''}</AT></View>
            <ABtn small tone="ghost" title="End" onPress={() => end(p)} />
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <AStat icon="👁" value={p.impressions_served} label="SERVED" /><AStat icon="📆" value={p.impressions_last_7_days} label="LAST 7 DAYS" /><AStat icon="👆" value={p.clicks} label="CLICKS" />
          </View>
          {p.cta_label ? <AT size={12} color={A.mute} style={{ marginTop: 8 }}>Call to action: “{p.cta_label}”</AT> : null}
        </ACard>
      )) : <AEmpty emoji="💎" title="No placements yet" sub={unplaced.length ? 'Give an active sponsor a slot on the public pages.' : 'Placements need an active sponsorship of this event. Agree one under Business → Partners first.'} action={unplaced.length ? 'Add a placement' : undefined} onAction={() => setAdding(true)} />}
      {pl.data?.measured ? <AT size={12} color={A.mute}>{pl.data.measured}</AT> : null}
      {ended.length ? <><ASection title="Ended placements" />{ended.map((p) => <ARow key={p.id} title={`${p.emoji} ${p.sponsor_name}`} sub={`${SLOT[p.slot]} · ${p.impressions_served} served · ${p.clicks} clicks`} />)}</> : null}

      {v.history?.length ? <><ASection title="Change log" />{v.history.slice(0, 6).map((h, i) => <AT key={i} size={12.5} color={A.mute}>{new Date(h.created_at).toLocaleString()} · {h.by}: {Object.entries(h.changes).map(([k, x]) => `${k.replace(/_/g, ' ')} → ${String(x)}`).join(', ')}</AT>)}</> : null}

      <FormSheet visible={adding} onClose={() => setAdding(false)} title="Add a sponsor placement" submitLabel="Add placement"
        fields={[
          { key: 'sponsorship_id', label: 'Sponsor', type: 'chips', options: unplaced.map((u) => ({ value: u.sponsorship_id, label: `${u.emoji} ${u.sponsor_name}` })) },
          { key: 'slot', label: 'Where it appears', type: 'chips', options: Object.entries(SLOT).map(([value, label]) => ({ value, label })) },
          { key: 'fixture_id', label: 'Which game', type: 'chips', show: (x) => x.slot === 'fixture', options: games.filter((g) => !['completed', 'cancelled'].includes(g.status)).slice(0, 40).map((g) => ({ value: g.id, label: gameLabel(g) })) },
          { key: 'cta_label', label: 'Button label (optional)', optional: true, hint: v.youth_event ? 'Not shown on youth events' : 'e.g. Get 10% off' },
          { key: 'cta_url', label: 'Button link (optional, https)', optional: true, keyboard: 'url' },
        ]}
        onSubmit={async (x) => { await api.post(`/events/${id}/sponsor-placements`, { sponsorship_id: x.sponsorship_id, slot: x.slot, fixture_id: x.slot === 'fixture' ? x.fixture_id : undefined, cta_label: x.cta_url ? x.cta_label : undefined, cta_url: x.cta_url || undefined }); pl.reload(); return 'Placement added'; }} />
    </View>
  );
}
