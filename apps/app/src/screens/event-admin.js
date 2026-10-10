import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H2, Loading, Row, Screen, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, money } from '../theme';

const ROLES = ['referee', 'umpire', 'linesman', 'scorer', 'doctor', 'physio', 'medic', 'volunteer', 'security', 'other'];
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const rn = (n) => (n == null ? '–' : Number(n).toFixed(2));

/** Organiser console for a tournament: invitations & seeding, schedule & bracket, staff, vendors & sponsors. */
export function EventAdmin({ id }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('people');
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  if (ev.loading && !ev.data) return <Screen><Loading /></Screen>;
  if (ev.error) return <Screen><ErrorBox error={ev.error} onRetry={ev.reload} /></Screen>;
  const e = ev.data;
  return (
    <Screen>
      <H2>{e.banner_emoji} {e.name}</H2>
      <T color={c.mute}>{e.sport} · {e.kind} · {e.entrants.length} in</T>
      <View style={{ marginTop: 12 }}>
        <Seg value={tab} onChange={setTab} color={c.violet}
          options={[{ value: 'people', label: 'Invite', emoji: '✉️' }, { value: 'plan', label: 'Schedule', emoji: '🗓️' }, { value: 'staff', label: 'Staff', emoji: '🩺' }, { value: 'vendors', label: 'Vendors', emoji: '🛍️' }]} />
      </View>
      <View style={{ gap: 12, marginTop: 12 }}>
        {tab === 'people' && <People e={e} toast={toast} reloadEvent={ev.reload} />}
        {tab === 'plan' && <Plan e={e} toast={toast} />}
        {tab === 'staff' && <Staff e={e} toast={toast} />}
        {tab === 'vendors' && <Vendors e={e} toast={toast} />}
      </View>
    </Screen>
  );
}

function useAct(toast, reload) {
  return (fn, msg) => async () => { try { await fn(); toast(msg); reload?.(); } catch (x) { toast('' + x.message); } };
}

// ---------------------------------------------------------------- invitations, rules, seeds
function People({ e, toast, reloadEvent }) {
  const id = e.id;
  const sug = useLoad(() => api.get(`/events/${id}/suggestions`), [id]);
  const inv = useLoad(() => api.get(`/events/${id}/invitations`), [id]);
  const seeds = useLoad(() => api.get(`/events/${id}/seeds`), [id]);
  const rules = useLoad(() => api.get(`/events/${id}/rules`), [id]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const reload = () => { sug.reload(); inv.reload(); seeds.reload(); reloadEvent(); };
  const act = useAct(toast, reload);
  const top = rules.data?.find((r) => r.kind === 'invite_top_n')?.params.n;
  const city = rules.data?.find((r) => r.kind === 'city')?.params.city;
  const minGames = rules.data?.find((r) => r.kind === 'min_games')?.params.n;
  return (
    <>
      <Card>
        <T weight="800">Rules</T>
        <T color={c.mute} style={{ marginTop: 4 }}>{rules.data?.length ? rules.data.map((r) => `${r.kind.replace(/_/g, ' ')}${Object.keys(r.params).length ? ` (${Object.values(r.params).join(', ')})` : ''}`).join(' · ') : 'No rules yet — suggestions rank every team of this sport.'}</T>
        <Btn small title="Edit rules" onPress={() => setRulesOpen(true)} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
      </Card>

      <H2>Suggested by results</H2>
      {sug.loading && !sug.data ? <Loading /> : sug.data?.items?.length ? sug.data.items.map((t) => (
        <Row key={t.team_id} title={`#${t.rank} ${t.emoji ?? ''} ${t.name}`} sub={`Rating ${rn(t.rating)} · ${t.played} games${t.city ? ` · ${t.city}` : ''}`}
          right={<Btn small title="Invite" onPress={act(() => api.post(`/events/${id}/invitations`, { invitees: [{ team_id: t.team_id }], source: 'ranking' }), 'Invitation sent')} />} />
      )) : <Empty emoji="📈" title="No candidates" sub="Teams of this sport that are not already in or invited show up here." />}
      {sug.data?.items?.length ? <Btn title={`Invite all ${sug.data.items.length}`} color={c.violet} onPress={act(() => api.post(`/events/${id}/invitations`, { invitees: sug.data.items.map((t) => ({ team_id: t.team_id })), source: 'ranking' }), 'Invitations sent')} /> : null}

      <H2>Invitations</H2>
      {inv.data?.length ? inv.data.map((n) => (
        <Row key={n.id} title={n.team_name ?? n.user_name} sub={`${n.source}${n.seed_hint ? ` · seed ${n.seed_hint}` : ''}`}
          right={<><Tag label={n.status} color={n.status === 'accepted' ? c.mint : n.status === 'invited' ? c.sun : c.paper} />{n.status === 'invited' ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={act(() => api.post(`/event-invitations/${n.id}/withdraw`), 'Withdrawn')} /> : null}</>} />
      )) : <Empty emoji="✉️" title="Nobody invited yet" />}

      <H2>Seeds</H2>
      {seeds.data?.length ? seeds.data.map((s) => <Row key={s.team_id} title={`${s.seed}. ${s.emoji ?? ''} ${s.name}`} sub={`${s.source} · rating ${rn(s.rating)}`} />) : <Empty emoji="🔢" title="Not seeded" sub="Accept at least two teams, then compute seeds from past results." />}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="Seed from results" onPress={act(() => api.post(`/events/${id}/seeds/compute`, { method: 'rating' }), 'Seeded')} />
        <Btn small title="Seed from standings" color={c.violet} onPress={act(() => api.post(`/events/${id}/seeds/compute`, { method: 'standings' }), 'Seeded')} />
      </View>

      <FormSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} title="Invitation rules" submitLabel="Save rules"
        initial={{ top: top ?? '', city: city ?? '', min_games: minGames ?? '' }}
        fields={[
          { key: 'top', label: 'Invite only the top N teams', type: 'number', optional: true },
          { key: 'city', label: 'Only teams from city', optional: true },
          { key: 'min_games', label: 'At least this many past games', type: 'number', optional: true },
        ]}
        onSubmit={async (v) => {
          const next = [];
          if (v.top) next.push({ kind: 'invite_top_n', params: { n: Number(v.top) } });
          if (v.city) next.push({ kind: 'city', params: { city: v.city } });
          if (v.min_games) next.push({ kind: 'min_games', params: { n: Number(v.min_games) } });
          for (const r of rules.data ?? []) if (['min_rating', 'exclude_team', 'seeding', 'note'].includes(r.kind)) next.push({ kind: r.kind, params: r.params });
          await api.post(`/events/${id}/rules`, { rules: next }); rules.reload(); sug.reload(); return 'Rules saved';
        }} />
    </>
  );
}

// ---------------------------------------------------------------- schedule, calendar, bracket
function Plan({ e, toast }) {
  const id = e.id;
  const br = useLoad(() => api.get(`/events/${id}/bracket`), [id]);
  const cal = useLoad(() => api.get(`/events/${id}/calendar`), [id]);
  const [form, setForm] = useState(null); // 'round_robin' | 'knockout'
  const [preview, setPreview] = useState(null);
  const [day, setDay] = useState(false);
  const [holiday, setHoliday] = useState(false);
  const reload = () => { br.reload(); cal.reload(); };
  const act = useAct(toast, reload);
  const args = (v) => ({ format: form, from_date: v.from_date, to_date: v.to_date || undefined, venue_id: v.venue_id || e.venue_id || undefined, match_duration_min: Number(v.match_duration_min) || 90, rest_min: Number(v.rest_min) || 60, third_place: !!v.third_place, respect_holidays: v.respect_holidays !== false });
  return (
    <>
      {!e.venue_id ? <Card color={c.sunSoft}><T>This event has no venue yet — set one on the event so games can be placed on its courts.</T></Card> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="Plan group stage" onPress={() => setForm('round_robin')} />
        <Btn small title="Plan knockout" color={c.violet} onPress={() => setForm('knockout')} />
        <Btn small title="Block a day" color={c.paper} ink={c.ink} onPress={() => setDay(true)} />
        <Btn small title="Add public holiday" color={c.paper} ink={c.ink} onPress={() => setHoliday(true)} />
      </View>

      {preview ? (
        <Card color={c.limeSoft}>
          <T weight="800">Preview — {preview.items.length - preview.unplaced.length} of {preview.items.length} games fit at {preview.venue.name}</T>
          {Object.keys(preview.skipped_dates).length ? <T color={c.mute}>Skipped: {Object.entries(preview.skipped_dates).map(([d, why]) => `${d} (${why})`).join(', ')}</T> : null}
          {preview.items.slice(0, 40).map((it) => <T key={it.key} style={{ marginTop: 4 }}>{it.round}: {it.home_team_id ? '' : it.home_placeholder} vs {it.away_team_id ? '' : it.away_placeholder} — {it.scheduled_at ? `${when(it.scheduled_at)} · ${it.resource_name}` : '⚠️ no slot'}</T>)}
          {preview.unplaced.length ? <T color={c.pink} weight="800" style={{ marginTop: 8 }}>Widen the date window or add courts: {preview.unplaced.length} game(s) cannot be placed.</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Btn small title="Create fixtures" disabled={!!preview.unplaced.length} onPress={act(async () => { await api.post(`/events/${id}/schedule`, preview.args); setPreview(null); }, 'Schedule created')} />
            <Btn small title="Dismiss" color={c.paper} ink={c.ink} onPress={() => setPreview(null)} />
          </View>
        </Card>
      ) : null}

      <H2>Bracket</H2>
      {br.data?.rounds?.length ? br.data.rounds.map((r) => (
        <Card key={r.kind}>
          <T weight="900">{r.label}</T>
          {r.games.map((g) => (
            <T key={g.id} style={{ marginTop: 6 }}>
              {(g.home_name ?? g.home_placeholder)} {g.status === 'completed' ? `${g.home_score}–${g.away_score}` : 'vs'} {(g.away_name ?? g.away_placeholder)}{g.winner_team_id ? ' ✔' : ''}
              <T color={c.mute} size={12}>{'  '}{when(g.scheduled_at)}{g.resource_name ? ` · ${g.resource_name}` : ''}</T>
            </T>
          ))}
        </Card>
      )) : <Empty emoji="🏆" title="No knockout yet" sub="Seed the teams, then plan a knockout: quarter-finals, semi-finals and the final." />}
      {br.data?.champion ? <Card color={c.sunSoft}><T weight="900" size={18}>🏆 Champions: {br.data.champion.name}</T></Card> : null}

      <H2>Blocked days</H2>
      {cal.data?.length ? cal.data.map((d) => (
        <Row key={d.id} title={`${d.on_date.slice(0, 10)} · ${d.kind.replace('_', ' ')}`} sub={d.label ?? ''} right={<Btn small title="Lift" color={c.paper} ink={c.ink} onPress={act(() => api.del(`/events/${id}/calendar/${d.id}`), 'Lifted')} />} />
      )) : <T color={c.mute}>None. Public holidays of the venue’s country/city are skipped automatically.</T>}

      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form === 'knockout' ? 'Plan knockout' : 'Plan group stage'} submitLabel="Preview"
        initial={{ match_duration_min: 90, rest_min: 60, respect_holidays: true }}
        fields={[
          { key: 'from_date', label: 'First possible day', type: 'date' },
          { key: 'to_date', label: 'Last possible day', type: 'date', optional: true },
          { key: 'match_duration_min', label: 'Game length (minutes)', type: 'number' },
          { key: 'rest_min', label: 'Rest between a team’s games (minutes)', type: 'number' },
          ...(form === 'knockout' ? [{ key: 'third_place', label: 'Third-place game', type: 'switch' }] : []),
          { key: 'respect_holidays', label: 'Skip public holidays', type: 'switch' },
        ]}
        onSubmit={async (v) => { const a = args(v); const p = await api.post(`/events/${id}/schedule/preview`, a); setPreview({ ...p, args: a }); return 'Preview ready'; }} />
      <FormSheet visible={day} onClose={() => setDay(false)} title="Block a day" submitLabel="Block" initial={{ kind: 'blackout' }}
        fields={[{ key: 'on_date', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type', type: 'choice', options: [{ value: 'blackout', label: 'Blackout' }, { value: 'rest_day', label: 'Rest day' }, { value: 'holiday', label: 'Holiday' }] }, { key: 'label', label: 'Note', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/calendar`, { days: [{ on_date: v.on_date, kind: v.kind, label: v.label || undefined }] }); reload(); return 'Day blocked'; }} />
      <FormSheet visible={holiday} onClose={() => setHoliday(false)} title="Public holiday" submitLabel="Save"
        fields={[{ key: 'country', label: 'Country (as on the venue)' }, { key: 'region', label: 'City, if local', optional: true }, { key: 'on_date', label: 'Date', type: 'date' }, { key: 'label', label: 'Name' }]}
        onSubmit={async (v) => { await api.post('/holidays', { country: v.country, region: v.region || undefined, days: [{ on_date: v.on_date, label: v.label }] }); return 'Holiday saved'; }} />
    </>
  );
}

// ---------------------------------------------------------------- staff
function Staff({ e, toast }) {
  const id = e.id;
  const roles = useLoad(() => api.get(`/events/${id}/staff-roles`), [id]);
  const staff = useLoad(() => api.get(`/events/${id}/staff-assignments`), [id]);
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState(null); // role being filled
  const [people, setPeople] = useState([]);
  const reload = () => { roles.reload(); staff.reload(); };
  const act = useAct(toast, reload);
  const search = async (r) => { setFind(r); setPeople(await api.get(`/events/${id}/staff-candidates`, { role: r.role }).catch(() => [])); };
  return (
    <>
      <Btn small title="Open a position" onPress={() => setOpen(true)} style={{ alignSelf: 'flex-start' }} />
      {roles.data?.length ? roles.data.map((r) => (
        <Card key={r.id}>
          <T weight="800">{r.title || r.role} · {r.filled}/{r.needed} confirmed{r.pending ? ` · ${r.pending} pending` : ''}{r.closed_at ? ' · closed' : ''}</T>
          <T color={c.mute}>{r.fee_cents ? `Fee ${money(r.fee_cents)}` : 'Unpaid / volunteer'}</T>
          {!r.closed_at ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small title="Find people" onPress={() => search(r)} />
            <Btn small title="Close" color={c.paper} ink={c.ink} onPress={act(() => api.post(`/staff-roles/${r.id}/close`), 'Closed')} />
          </View> : null}
          {find?.id === r.id ? (people.length ? people.map((p) => (
            <Row key={p.user_id} title={p.display_name} sub={p.clinic ?? p.level ?? `@${p.handle}`} right={<Btn small title="Invite" onPress={act(async () => { await api.post(`/staff-roles/${r.id}/invite`, { user_id: p.user_id }); setFind(null); }, 'Offer sent')} />} />
          )) : <T color={c.mute} style={{ marginTop: 8 }}>Nobody available with the right profile on these dates.</T>) : null}
        </Card>
      )) : <Empty emoji="🩺" title="No positions yet" sub="Referees, scorers, doctors, physios, volunteers and security." />}
      <H2>Team sheet</H2>
      {staff.data?.length ? staff.data.map((a) => (
        <Row key={a.id} title={a.display_name} sub={`${a.title || a.role}${a.fee_cents ? ` · ${money(a.fee_cents)}` : ''}`}
          right={<><Tag label={a.status} color={a.status === 'accepted' ? c.mint : a.status === 'invited' ? c.sun : c.paper} />{['invited', 'accepted'].includes(a.status) ? <Btn small title="Release" color={c.paper} ink={c.ink} onPress={act(() => api.post(`/staff-assignments/${a.id}/end`, {}), 'Released')} /> : null}</>} />
      )) : <T color={c.mute}>No one invited yet.</T>}
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Open a position" submitLabel="Open" initial={{ role: 'referee', needed: 1 }}
        fields={[{ key: 'role', label: 'Role', type: 'chips', options: ROLES }, { key: 'needed', label: 'How many', type: 'number' }, { key: 'fee', label: 'Fee per person', type: 'money', currency: e.currency, optional: true }, { key: 'notes', label: 'Notes', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/staff-roles`, { role: v.role, needed: Number(v.needed) || 1, fee_cents: v.fee || 0, notes: v.notes || undefined }); reload(); return 'Position opened'; }} />
    </>
  );
}

// ---------------------------------------------------------------- vendors, sponsors, retail
function Vendors({ e, toast }) {
  const id = e.id;
  const vend = useLoad(() => api.get(`/events/${id}/vendors`), [id]);
  const prods = useLoad(() => api.get(`/events/${id}/products`), [id]);
  const money_ = useLoad(() => api.get(`/events/${id}/commercials`), [id]);
  const [form, setForm] = useState(false);
  const reload = () => { vend.reload(); prods.reload(); money_.reload(); };
  const act = useAct(toast, reload);
  const m = money_.data;
  return (
    <>
      {m ? (
        <Card color={c.limeSoft}>
          <T weight="900">Money (minor units shown as currency)</T>
          <T>Entry fees {money(m.entry_fees_cents)} · Sponsors {money(m.sponsors.cents)} · Vendor fees {money(m.vendors.pitch_fees_cents)}</T>
          <T>Staff cost {money(m.staff.cost_cents)} · {m.staff.open_places} places open</T>
          <T weight="800">Net {money(m.net_cents)}</T>
        </Card>
      ) : null}
      <Btn small title="Invite a vendor or sponsor" onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {vend.data?.length ? vend.data.map((v) => (
        <Row key={v.id} title={v.sponsor_name ?? v.vendor_name} sub={`${v.kind}${v.fee_cents ? ` · ${money(v.fee_cents)}` : ''}${v.in_kind ? ` · ${v.in_kind}` : ''}`}
          right={<><Tag label={v.status} color={v.status === 'accepted' ? c.mint : v.status === 'invited' ? c.sun : c.paper} />{v.status === 'accepted' ? <Btn small title="End" color={c.paper} ink={c.ink} onPress={act(() => api.post(`/event-vendors/${v.id}/end`), 'Ended')} /> : null}</>} />
      )) : <Empty emoji="🛍️" title="No vendors or sponsors yet" />}
      <H2>On sale at the event</H2>
      {prods.data?.length ? prods.data.map((p) => <Row key={p.id} title={`${p.emoji} ${p.name}`} sub={`${money(p.price_cents)} · ${p.seller_name}`} />) : <T color={c.mute}>Retail vendors list their shop products here once confirmed.</T>}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Invite" submitLabel="Send invitation" initial={{ kind: 'retail' }}
        fields={[
          { key: 'kind', label: 'Type', type: 'choice', options: [{ value: 'retail', label: 'Retail' }, { value: 'catering', label: 'Catering' }, { value: 'sponsor', label: 'Sponsor' }, { value: 'other', label: 'Other' }] },
          { key: 'target', label: 'Sponsor id (sponsors) or user id (others)' },
          { key: 'fee', label: 'Fee / sponsorship amount', type: 'money', currency: e.currency, optional: true },
          { key: 'in_kind', label: 'In-kind support', optional: true },
        ]}
        onSubmit={async (v) => {
          await api.post(`/events/${id}/vendors`, { kind: v.kind, ...(v.kind === 'sponsor' ? { sponsor_id: v.target } : { vendor_user_id: v.target }), fee_cents: v.fee || 0, in_kind: v.in_kind || undefined });
          reload(); return 'Invitation sent';
        }} />
    </>
  );
}
