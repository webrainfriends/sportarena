// Competition Season, Division & League management (#476): ONE place for a persistent competition. The list of competitions, and Competition Home with
// Overview · Seasons · Divisions · Teams · Fixtures · Standings · Registration · Rules · History · Reports. Every rule is enforced by the API (REST / OpenAPI / MCP);
// this screen only calls it. Games, teams and results stay the canonical event records (the season is an event), so the event console is not duplicated here.
// One React Native codebase: iOS, iPadOS, Android and web. Dates, times, sports, teams and divisions use pickers and menus, never free text.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Field, GradCard, H1, H2, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { MenuField } from '../menu-field';
import { Counter, DateField, DateRangeField, TimeField, DateTimeField } from '../pickers';
import { SportSelect } from '../sportpicker';
import { CountryPicker, countryName } from '../country-picker';
import { saveFile } from '../contracts-ui';
import { SwitchRow, Cols } from '../federation-bits';
import { Banner, Metric, fmtDate, fmtRange } from '../federation-ui';
import { useDo } from './console-utils';

const STATUS = { draft: ['Draft', c.violetSoft], open: ['Registration open', c.cyanSoft], active: ['In play', c.limeSoft], completed: ['Completed', c.sunSoft], archived: ['Archived', c.violetSoft] };
const MEMBER = { applied: ['Applied', c.sunSoft], invited: ['Invited', c.cyanSoft], accepted: ['In', c.limeSoft], waitlisted: ['Waitlist', c.orangeSoft], withdrawn: ['Withdrawn', c.violetSoft], removed: ['Removed', c.redSoft] };
const LEVELS = ['elite', 'professional', 'semi_pro', 'amateur', 'recreational', 'school', 'youth'].map((v) => ({ value: v, label: v.replace('_', '-').replace(/^./, (x) => x.toUpperCase()) }));
const GENDERS = [{ value: 'open', label: 'Open' }, { value: 'men', label: 'Men' }, { value: 'women', label: 'Women' }, { value: 'mixed', label: 'Mixed' }];
const KINDS = [{ value: 'division', label: 'Division' }, { value: 'conference', label: 'Conference' }, { value: 'pool', label: 'Pool' }, { value: 'category', label: 'Category' }];
const TABS = ['overview', 'seasons', 'divisions', 'teams', 'fixtures', 'standings', 'registration', 'rules', 'history', 'reports'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
const MOVE = { champion: ['Champion', c.sunSoft], promotion: ['Promoted', c.limeSoft], relegation: ['Relegated', c.redSoft], playoff: ['Playoff', c.cyanSoft], qualification: ['Qualified', c.cyanSoft], stay: ['Stays', c.violetSoft] };
const Pill = ({ map, k }) => <Tag label={(map[k] ?? [k])[0]} color={(map[k] ?? [])[1] ?? c.violetSoft} />;
const Row = ({ children, style }) => <View style={[{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, style]}>{children}</View>;
const opts = (rows, f) => (rows ?? []).map(f);
/** Previous / Next for an API page that does not report a total: there is a next page while a full page came back. */
const Pager = ({ count, offset, limit, onOffset, busy }) => (offset === 0 && count < limit ? null : (
  <Row style={{ justifyContent: 'space-between' }}>
    <Btn small title="Previous" color={c.paper} ink={c.ink} disabled={offset === 0 || busy} onPress={() => onOffset(Math.max(0, offset - limit))} />
    <T size={12} color={c.mute}>Page {Math.floor(offset / limit) + 1}</T>
    <Btn small title="Next" color={c.paper} ink={c.ink} disabled={count < limit || busy} onPress={() => onOffset(offset + limit)} />
  </Row>));
const money = (n) => (n > 0 ? `+${n}` : `${n}`);

// ------------------------------------------------------------------ list of competitions + create
export function Competitions({ id }) {
  return id ? <CompetitionHome id={id} /> : <CompetitionList />;
}

function CompetitionList() {
  const { push } = useNav();
  const { user } = useSession();
  const [q, setQ] = useState(''), [mine, setMine] = useState(false), [offset, setOffset] = useState(0), [sheet, setSheet] = useState(false);
  const list = useLoad(() => api.get('/competitions', { q: q || undefined, mine: mine || undefined, limit: 20, offset }), [q, mine, offset]);
  const canCreate = (user?.roles ?? []).some((r) => ['organizer', 'admin', 'platform_admin'].includes(r));
  return (
    <Screen refreshing={list.loading} onRefresh={list.reload} wide>
      <H1>Competitions</H1>
      <T color={c.mute} style={{ marginTop: 4 }}>Leagues and cups that last across seasons: divisions, tables, promotion and relegation.</T>
      <View style={{ marginTop: 12, gap: 10 }}>
        <Field label="Search" value={q} onChangeText={(v) => { setQ(v); setOffset(0); }} placeholder="Name of a competition" />
        <Row><Seg options={[{ value: false, label: 'All public' }, { value: true, label: 'Mine' }]} value={mine} onChange={(v) => { setMine(v); setOffset(0); }} />{canCreate ? <Btn small title="New competition" onPress={() => setSheet(true)} /> : null}</Row>
      </View>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : (
        <View style={{ marginTop: 12, gap: 8 }}>
          {list.data.items.length ? list.data.items.map((x) => (
            <Card key={x.id} onPress={() => push('Competitions', { id: x.id })} accessibilityLabel={`Open ${x.name}`}>
              <Row><T size={20}>{x.emoji}</T><View style={{ flex: 1, minWidth: 160 }}><T weight="700" size={16}>{x.name}</T><T size={12.5} color={c.mute}>{[x.sport_name, x.country && countryName(x.country), x.level?.replace('_', '-'), x.current_season && `Season ${x.current_season}`].filter(Boolean).join(' · ')}</T></View>{!x.is_public ? <Tag label="Private" /> : null}<Tag label={`${x.seasons} season${x.seasons === 1 ? '' : 's'}`} /></Row>
            </Card>
          )) : <Empty emoji="🏆" title="No competitions yet" sub={canCreate ? 'Create the first one with “New competition”.' : 'Competitions appear here when their organisers publish them.'} />}
          <Pager count={list.data.items.length} offset={offset} limit={20} onOffset={setOffset} busy={list.loading} />
        </View>)}
      <CreateCompetition visible={sheet} onClose={() => setSheet(false)} onDone={(x) => { setSheet(false); push('Competitions', { id: x.id }); }} />
    </Screen>
  );
}

function CreateCompetition({ visible, onClose, onDone }) {
  const [f, setF] = useState({ name: '', sport: null, country: null, level: 'amateur', gender: 'open', is_public: true, organisation_id: null });
  const orgs = useLoad(() => (visible ? api.get('/organisations', { mine: true }).catch(() => []) : Promise.resolve([])), [visible]);
  const act = useDo();
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const ok = f.name.trim().length >= 2 && f.sport;
  return (
    <Sheet visible={visible} onClose={onClose} title="New competition" footer={<Btn title="Create competition" disabled={!ok} onPress={async () => { const r = await act(() => api.post('/competitions', { ...f, name: f.name.trim(), country: f.country ?? undefined, organisation_id: f.organisation_id ?? undefined }), 'Competition created'); if (r) onDone(r); }} />}>
      <View style={{ gap: 12 }}>
        <Field label="Name" value={f.name} onChangeText={set('name')} placeholder="e.g. City Football League" maxLength={120} />
        <SportSelect label="Sport" value={f.sport} onChange={set('sport')} />
        <MenuField label="Governing organisation" value={f.organisation_id} onChange={set('organisation_id')} placeholder="None (just me)" options={[{ value: null, label: 'None (just me)' }, ...opts(Array.isArray(orgs.data) ? orgs.data : orgs.data?.items, (o) => ({ value: o.id, label: o.name }))]} />
        <CountryPicker label="Country" value={f.country} onChange={set('country')} optional />
        <MenuField label="Level" value={f.level} onChange={set('level')} options={LEVELS} />
        <Seg options={GENDERS} value={f.gender} onChange={set('gender')} />
        <SwitchRow label="Public profile" sub="Anyone can find it once it is active" value={f.is_public} onChange={set('is_public')} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Competition Home
function CompetitionHome({ id }) {
  const [tab, setTab] = useState('overview'), [sid, setSid] = useState(null), [seasonSheet, setSeasonSheet] = useState(false);
  const comp = useLoad(() => api.get(`/competitions/${id}`), [id]);
  const h = comp.data;
  const current = useMemo(() => h?.seasons.find((s) => s.id === sid) ?? h?.seasons.find((s) => ['active', 'open'].includes(s.status)) ?? h?.seasons[0] ?? null, [h, sid]);
  const season = useLoad(() => (current ? api.get(`/seasons/${current.id}`) : Promise.resolve(null)), [current?.id]);
  const reloadAll = () => { comp.reload(); season.reload(); };
  if (comp.error && !h) return <Screen><H1>Competition</H1><ErrorBox error={comp.error} onRetry={comp.reload} /></Screen>;
  if (!h) return <Screen><Loading /></Screen>;
  const s = season.data;
  const P = { comp: h, season: s, can: h.can_manage, reload: reloadAll, go: setTab };
  return (
    <Screen refreshing={comp.loading} onRefresh={reloadAll} wide>
      <GradCard pad={20}>
        <T size={12} color="#fff" weight="700" style={{ letterSpacing: 0.6 }}>{[h.sport?.emoji, h.sport?.name, h.organisation?.name].filter(Boolean).join(' · ').toUpperCase()}</T>
        <H1 color="#fff" style={{ marginTop: 4 }}>{h.name}</H1>
        <T color="#fff" size={13} style={{ marginTop: 4 }}>{[h.country && countryName(h.country), h.level?.replace('_', '-'), h.gender !== 'open' ? h.gender : null, h.age_group].filter(Boolean).join(' · ')}</T>
        {h.defending_champion ? <T color="#fff" weight="700" style={{ marginTop: 8 }}>🏆 Defending champion: {h.defending_champion.name} ({h.defending_champion.season})</T> : null}
      </GradCard>
      <View style={{ marginTop: 12, gap: 10 }}>
        <Row>
          <View style={{ flex: 1, minWidth: 220 }}><MenuField label="Season" value={current?.id ?? null} onChange={setSid} placeholder="No season yet" options={opts(h.seasons, (x) => ({ value: x.id, label: x.label, sub: STATUS[x.status]?.[0] }))} /></View>
          {h.can_manage ? <Btn small title="New season" onPress={() => setSeasonSheet(true)} /> : null}
        </Row>
        <Seg options={TABS} value={tab} onChange={setTab} />
      </View>
      <View style={{ marginTop: 10 }}>
        {tab === 'seasons' ? <SeasonsTab {...P} pick={(x) => { setSid(x); setTab('overview'); }} /> : null}
        {tab === 'history' ? <HistoryTab {...P} /> : null}
        {tab !== 'seasons' && tab !== 'history' && !current ? <Empty emoji="📅" title="No season yet" sub={h.can_manage ? 'Add a season to start building divisions and fixtures.' : 'The organiser has not published a season.'} /> : null}
        {tab !== 'seasons' && tab !== 'history' && current && !s ? (season.error ? <ErrorBox error={season.error} onRetry={season.reload} /> : <Loading />) : null}
        {s && tab === 'overview' ? <Overview {...P} /> : null}
        {s && tab === 'divisions' ? <DivisionsTab {...P} /> : null}
        {s && tab === 'teams' ? <TeamsTab {...P} /> : null}
        {s && tab === 'fixtures' ? <FixturesTab {...P} /> : null}
        {s && tab === 'standings' ? <StandingsTab {...P} /> : null}
        {s && tab === 'registration' ? <RegistrationTab {...P} /> : null}
        {s && tab === 'rules' ? <RulesTab {...P} /> : null}
        {s && tab === 'reports' ? <ReportsTab {...P} /> : null}
      </View>
      <SeasonSheet visible={seasonSheet} onClose={() => setSeasonSheet(false)} compId={id} onDone={(x) => { setSeasonSheet(false); setSid(x.id); reloadAll(); }} />
    </Screen>
  );
}

function SeasonSheet({ visible, onClose, compId, onDone }) {
  const [label, setLabel] = useState(''), [dates, setDates] = useState({}), [reg, setReg] = useState({}), [tr, setTr] = useState({});
  const act = useDo();
  return (
    <Sheet visible={visible} onClose={onClose} title="New season" footer={<Btn title="Create season" disabled={!label.trim() || !dates.from || !dates.to} onPress={async () => {
      const r = await act(() => api.post(`/competitions/${compId}/seasons`, { label: label.trim(), starts_on: dates.from, ends_on: dates.to, registration_opens_on: reg.from, registration_closes_on: reg.to, transfer_opens_on: tr.from, transfer_closes_on: tr.to }), 'Season created (rules copied from the last one)');
      if (r) { setLabel(''); setDates({}); setReg({}); setTr({}); onDone(r); }
    }} />}>
      <View style={{ gap: 12 }}>
        <Field label="Season label" value={label} onChangeText={setLabel} placeholder="e.g. 2026/27" maxLength={60} />
        <DateRangeField label="Season dates" from={dates.from} to={dates.to} onChange={setDates} />
        <DateRangeField label="Registration window" from={reg.from} to={reg.to} onChange={setReg} optional hint="Teams can apply only inside this window." />
        <DateRangeField label="Transfer window" from={tr.from} to={tr.to} onChange={setTr} optional />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Overview (lifecycle + season end)
function Overview({ comp, season: s, can, reload }) {
  const act = useDo(reload);
  const [done, setDone] = useState(false);
  const st = STATUS[s.status];
  const next = { draft: ['Open registration', 'open'], open: ['Start play', 'active'] }[s.status];
  return (
    <View style={{ gap: 10 }}>
      <Row><H2>{s.label}</H2><Tag label={st[0]} color={st[1]} /><T color={c.mute} size={13}>{fmtRange(s.starts_on, s.ends_on)}</T></Row>
      <Row style={{ gap: 10 }}>
        <Metric value={s.counts.accepted} label="Teams in" sub={s.counts.pending ? `${s.counts.pending} waiting` : undefined} />
        <Metric value={s.divisions.length} label="Divisions" />
        <Metric value={s.divisions.reduce((n, d) => n + d.fixtures, 0)} label="Fixtures" />
        <Metric value={`v${s.rule_version}`} label="Rules in force" />
      </Row>
      {s.registration_window ? <Banner tone={s.registration_window.open_now ? c.limeSoft : c.sunSoft}>Registration {s.registration_window.open_now ? 'is open' : 'is closed'}{s.registration_window.closes_on ? ` until ${fmtDate(s.registration_window.closes_on)}` : ''}.</Banner> : null}
      {can && next ? <Btn title={next[0]} onPress={() => act(() => api.post(`/seasons/${s.id}/status`, { status: next[1] }), `${next[0]}: done`)} /> : null}
      {can && s.status === 'active' ? <Btn title="Complete season…" color={c.violet} onPress={() => setDone(true)} /> : null}
      {can && s.status === 'completed' ? <SeasonEnd season={s} comp={comp} reload={reload} /> : null}
      {s.champion_team_id ? <Card><T weight="700">🏆 Champion</T><T color={c.mute}>Recorded when the season completed; it never changes afterwards.</T></Card> : null}
      <Sheet visible={done} onClose={() => setDone(false)} title="Complete this season?" footer={<Btn title="Freeze the tables and complete" onPress={async () => { setDone(false); await act(() => api.post(`/seasons/${s.id}/complete`, {}), 'Season completed: final tables frozen'); }} />}>
        <T>Every division’s final table is frozen with the rules in force (v{s.rule_version}). Teams, divisions, rounds and results of this season are then closed and can never be rewritten.</T>
        <T color={c.mute} size={13}>If games are still unfinished you will be told how many; nothing is completed until they are played, cancelled or decided.</T>
      </Sheet>
    </View>
  );
}

/** Promotion / relegation / qualification: proposals from the frozen tables, then a person confirms each into a next-season division. */
function SeasonEnd({ season: s, comp, reload }) {
  const act = useDo(reload);
  const moves = useLoad(() => api.get(`/seasons/${s.id}/movements`, { limit: 100 }), [s.id]);
  const later = comp.seasons.filter((x) => x.id !== s.id && ['draft', 'open', 'active'].includes(x.status));
  const [nextId, setNextId] = useState(later[0]?.id ?? null);
  const nxt = useLoad(() => (nextId ? api.get(`/seasons/${nextId}`) : Promise.resolve(null)), [nextId]);
  const [pick, setPick] = useState({});
  const items = moves.data?.items ?? [];
  const divs = opts(nxt.data?.divisions?.filter((d) => !d.archived_at), (d) => ({ value: d.id, label: d.name, sub: `Tier ${d.tier}` }));
  const suggest = (m) => nxt.data?.divisions?.find((d) => d.tier === m.to_tier && !d.archived_at)?.id ?? null;
  const chosen = (m) => pick[m.id] ?? suggest(m);
  const todo = items.filter((m) => m.status === 'proposed');
  return (
    <Section title="Season end: promotion, relegation & invitations" color={c.sun}>
      <T color={c.mute} size={13}>Proposals come from the frozen tables and this season’s rules. Nothing is created for next season until you confirm.</T>
      <Row style={{ marginVertical: 8 }}><Btn small title={items.length ? 'Refresh proposals' : 'Propose movements'} onPress={async () => { await act(() => api.post(`/seasons/${s.id}/movements/propose`, {}), 'Proposals ready'); moves.reload(); }} /></Row>
      {items.length ? <MenuField label="Invite into season" value={nextId} onChange={setNextId} placeholder="Add the next season first" options={opts(later, (x) => ({ value: x.id, label: x.label }))} /> : null}
      {items.map((m) => (
        <Card key={m.id} style={{ marginTop: 8 }}>
          <Row><T weight="700" style={{ flex: 1, minWidth: 140 }}>{m.rank}. {m.team_name}</T><Pill map={MOVE} k={m.kind} /><T size={12} color={c.mute}>{m.from_division}</T>{m.status !== 'proposed' ? <Tag label={m.status} /> : null}</Row>
          {m.status === 'proposed' && nextId ? (
            <View style={{ marginTop: 8, gap: 8 }}>
              <MenuField label="Next-season division" value={chosen(m)} onChange={(v) => setPick((p) => ({ ...p, [m.id]: v }))} placeholder="Choose a division" options={divs} />
              <Row><Btn small title="Confirm & invite" disabled={!chosen(m)} onPress={async () => { await act(() => api.post(`/seasons/${s.id}/movements/confirm`, { next_season_id: nextId, decisions: [{ movement_id: m.id, action: 'confirm', division_id: chosen(m) }] }), 'Invitation sent'); moves.reload(); }} />
                <Btn small color={c.paper} ink={c.ink} title="Decline" onPress={async () => { await act(() => api.post(`/seasons/${s.id}/movements/confirm`, { next_season_id: nextId, decisions: [{ movement_id: m.id, action: 'decline' }] }), 'Declined'); moves.reload(); }} /></Row>
            </View>) : null}
        </Card>))}
      {todo.length === 0 && items.length ? <T color={c.mute} size={13} style={{ marginTop: 6 }}>Every movement has been decided. Teams accept their invitation in the next season.</T> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ Seasons / History
function SeasonsTab({ comp, can, pick }) {
  return (
    <View style={{ gap: 8 }}>
      {comp.seasons.length ? comp.seasons.map((x) => (
        <Card key={x.id} onPress={() => pick(x.id)} accessibilityLabel={`Open season ${x.label}`}>
          <Row><View style={{ flex: 1, minWidth: 140 }}><T weight="700" size={16}>{x.label}</T><T size={12.5} color={c.mute}>{fmtRange(x.starts_on, x.ends_on)} · {x.divisions} division{x.divisions === 1 ? '' : 's'} · {x.teams} teams</T></View>
            {x.champion_name ? <Tag label={`🏆 ${x.champion_name}`} color={c.sunSoft} /> : null}<Tag label={STATUS[x.status][0]} color={STATUS[x.status][1]} /></Row>
        </Card>)) : <Empty emoji="📅" title="No seasons yet" sub={can ? 'Use “New season” above.' : undefined} />}
    </View>
  );
}

function HistoryTab({ comp }) {
  const [offset, setOffset] = useState(0);
  const hist = useLoad(() => api.get(`/competitions/${comp.id}/history`, { limit: 10, offset }), [comp.id, offset]);
  if (hist.error) return <ErrorBox error={hist.error} onRetry={hist.reload} />;
  if (!hist.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      <T color={c.mute} size={13}>Completed seasons are read from their frozen records: later rule, team or division changes never rewrite them.</T>
      {hist.data.items.length ? hist.data.items.map((s) => (
        <Card key={s.id}>
          <Row><H2 style={{ flex: 1 }}>{s.label}</H2>{s.champion_name ? <Tag label={`🏆 ${s.champion_name}`} color={c.sunSoft} /> : <Tag label="No single champion" />}</Row>
          <T size={12.5} color={c.mute}>{fmtRange(s.starts_on, s.ends_on)}</T>
          {s.divisions.map((d) => (
            <View key={d.division_id} style={{ marginTop: 8 }}>
              <T weight="700">{d.name} <T size={12} color={c.mute}>· rules v{d.rule_version} · {d.members.length} teams</T></T>
              {d.table.slice(0, 3).map((r) => <T key={r.team_id} size={13.5}>{r.rank}. {r.name} — {r.points} pts</T>)}
            </View>))}
        </Card>)) : <Empty emoji="🏛️" title="No finished seasons yet" sub="Champions and final tables appear here once a season is completed." />}
      <Pager count={hist.data.items.length} offset={offset} limit={10} onOffset={setOffset} busy={hist.loading} />
    </View>
  );
}

// ------------------------------------------------------------------ Divisions
function DivisionsTab({ season: s, can, reload }) {
  const [f, setF] = useState(null);
  const act = useDo(reload);
  const closed = ['completed', 'archived'].includes(s.status);
  return (
    <View style={{ gap: 8 }}>
      {can && !closed ? <Row><Btn small title="Add division" onPress={() => setF({ name: '', kind: 'division', tier: Math.min(20, (s.divisions.at(-1)?.tier ?? 0) + (s.divisions.length ? 1 : 1)), capacity: null, gender: 'open' })} /></Row> : null}
      {s.divisions.length ? s.divisions.map((d) => (
        <Card key={d.id}>
          <Row><View style={{ flex: 1, minWidth: 140 }}><T weight="700" size={16}>{d.name}</T><T size={12.5} color={c.mute}>{d.kind} · tier {d.tier}{d.capacity ? ` · up to ${d.capacity} teams` : ''}{d.gender !== 'open' ? ` · ${d.gender}` : ''}</T></View>
            <Tag label={`${d.teams} team${d.teams === 1 ? '' : 's'}`} />{d.archived_at ? <Tag label="Archived" /> : null}
            {can && !closed ? <Btn small color={c.paper} ink={c.ink} title={d.archived_at ? 'Restore' : 'Archive'} onPress={() => act(() => api.patch(`/divisions/${d.id}`, { archived: !d.archived_at }), 'Updated')} /> : null}</Row>
        </Card>)) : <Empty emoji="🧩" title="No divisions yet" sub="Add a division, conference or pool, then place teams in it." />}
      <Sheet visible={!!f} onClose={() => setF(null)} title="Add a division" footer={f ? <Btn title="Add" disabled={!f.name.trim()} onPress={async () => { const r = await act(() => api.post(`/seasons/${s.id}/divisions`, { ...f, name: f.name.trim(), capacity: f.capacity ?? undefined }), 'Division added'); if (r) setF(null); }} /> : null}>
        {f ? <View style={{ gap: 12 }}>
          <Field label="Name" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} placeholder="e.g. Premier Division" maxLength={80} />
          <Seg options={KINDS} value={f.kind} onChange={(v) => setF({ ...f, kind: v })} />
          <Counter label="Tier (1 = top)" value={f.tier} min={1} max={20} onChange={(v) => setF({ ...f, tier: v })} />
          <SwitchRow label="Limit the number of teams" value={f.capacity != null} onChange={(v) => setF({ ...f, capacity: v ? 12 : null })} />
          {f.capacity != null ? <Counter label="Capacity" value={f.capacity} min={2} max={128} onChange={(v) => setF({ ...f, capacity: v })} /> : null}
          <Seg options={GENDERS} value={f.gender} onChange={(v) => setF({ ...f, gender: v })} />
        </View> : null}
      </Sheet>
    </View>
  );
}

// ------------------------------------------------------------------ Teams (accepted roster by division) and Registration (applications)
function useMemberships(s, status) {
  return useLoad(() => api.get(`/seasons/${s.id}/memberships`, { status, limit: 100 }), [s.id, status]);
}

function TeamsTab({ season: s, can, reload }) {
  const m = useMemberships(s, 'accepted');
  const [mv, setMv] = useState(null);
  const act = useDo(() => { m.reload(); reload(); });
  const closed = ['completed', 'archived'].includes(s.status);
  if (!m.data) return m.error ? <ErrorBox error={m.error} onRetry={m.reload} /> : <Loading />;
  const groups = s.divisions.map((d) => [d, m.data.items.filter((x) => x.division_id === d.id)]).filter(([, r]) => r.length);
  return (
    <View style={{ gap: 10 }}>
      {groups.length ? groups.map(([d, rows]) => (
        <Section key={d.id} title={`${d.name} · ${rows.length}${d.capacity ? ` of ${d.capacity}` : ''}`} color={c.cyan}>
          {rows.map((x) => (
            <Card key={x.id} style={{ marginBottom: 6 }}>
              <Row><T size={18}>{x.emoji}</T><T weight="700" style={{ flex: 1, minWidth: 140 }}>{x.team_name}</T>
                {can && !closed ? <><Btn small color={c.paper} ink={c.ink} title="Move" onPress={() => setMv({ id: x.id, name: x.team_name, division_id: null, reason: '' })} /><Btn small color={c.paper} ink={c.red} title="Remove" onPress={() => setMv({ id: x.id, name: x.team_name, remove: true, reason: '' })} /></> : null}</Row>
            </Card>))}
        </Section>)) : <Empty emoji="👥" title="No teams in yet" sub="Teams apply under Registration, or the organiser adds them there." />}
      <Sheet visible={!!mv} onClose={() => setMv(null)} title={mv?.remove ? `Remove ${mv?.name}` : `Move ${mv?.name}`} footer={mv ? <Btn title={mv.remove ? 'Remove from season' : 'Move team'} disabled={mv.reason.trim().length < 3 || (!mv.remove && !mv.division_id)} onPress={async () => {
        const r = await act(() => (mv.remove ? api.post(`/memberships/${mv.id}/decision`, { action: 'remove', reason: mv.reason.trim() }) : api.post(`/memberships/${mv.id}/move`, { division_id: mv.division_id, reason: mv.reason.trim() })), mv.remove ? 'Team removed' : 'Team moved');
        if (r) setMv(null);
      }} /> : null}>
        {mv ? <View style={{ gap: 12 }}>
          {!mv.remove ? <MenuField label="New division" value={mv.division_id} onChange={(v) => setMv({ ...mv, division_id: v })} options={opts(s.divisions.filter((d) => !d.archived_at), (d) => ({ value: d.id, label: d.name, sub: `Tier ${d.tier}` }))} /> : null}
          <Field label="Reason (kept in the history)" value={mv.reason} onChangeText={(v) => setMv({ ...mv, reason: v })} multiline maxLength={500} />
        </View> : null}
      </Sheet>
    </View>
  );
}

function RegistrationTab({ season: s, can, reload }) {
  const all = useLoad(() => api.get(`/seasons/${s.id}/memberships`, { limit: 100 }), [s.id]);
  // a team manager registers their own teams; the organiser can search every team of the competition's sport
  const mine = useLoad(() => api.get('/teams', can ? { sport: s.competition.sport, limit: 100 } : { mine: true, limit: 100 }), [can, s.competition.sport]);
  const [team, setTeam] = useState(null), [div, setDiv] = useState(null);
  const act = useDo(() => { all.reload(); reload(); });
  const w = s.registration_window;
  const items = all.data?.items ?? [];
  const live = new Set(items.filter((x) => ['applied', 'invited', 'accepted', 'waitlisted'].includes(x.status)).map((x) => x.team_id));
  const myTeams = (Array.isArray(mine.data) ? mine.data : mine.data?.items ?? []).filter((t) => !live.has(t.id));
  const closed = ['completed', 'archived'].includes(s.status);
  const divOpts = opts(s.divisions.filter((d) => !d.archived_at), (d) => ({ value: d.id, label: d.name, sub: `Tier ${d.tier}` }));
  return (
    <View style={{ gap: 10 }}>
      {w ? <Banner tone={w.open_now ? c.limeSoft : c.sunSoft}>{w.open_now ? 'Registration is open' : 'Registration is closed'}: {fmtRange(w.opens_on, w.closes_on)}</Banner> : <Banner tone={c.cyanSoft}>No registration window is set; teams can apply while the season is open.</Banner>}
      {!closed && (can || s.status === 'open') ? (
        <Section title={can ? 'Add a team' : 'Register your team'} color={c.pink}>
          <View style={{ gap: 10 }}>
            <MenuField label="Team" value={team} onChange={setTeam} placeholder={myTeams.length ? 'Choose a team' : 'No team available'} options={opts(myTeams, (t) => ({ value: t.id, label: t.name, sub: t.city }))} />
            <MenuField label="Division" value={div} onChange={setDiv} placeholder="Let the organiser decide" options={[{ value: null, label: 'Let the organiser decide' }, ...divOpts]} />
            <Row><Btn title="Apply" disabled={!team} onPress={async () => { const r = await act(() => api.post(`/seasons/${s.id}/memberships`, { team_id: team, division_id: div ?? undefined }), 'Application sent'); if (r) setTeam(null); }} />
              {can ? <Btn color={c.violet} title="Add and accept" disabled={!team || !div} onPress={async () => { const r = await act(() => api.post(`/seasons/${s.id}/memberships`, { team_id: team, division_id: div, accept: true }), 'Team accepted'); if (r) setTeam(null); }} /> : null}</Row>
          </View>
        </Section>) : null}
      <Section title="Applications & invitations" color={c.sun}>
        {items.filter((x) => ['applied', 'invited', 'waitlisted'].includes(x.status)).map((x) => (
          <Card key={x.id} style={{ marginBottom: 6 }}>
            <Row><T weight="700" style={{ flex: 1, minWidth: 140 }}>{x.emoji} {x.team_name}</T><Pill map={MEMBER} k={x.status} />{x.division_name ? <T size={12} color={c.mute}>{x.division_name}</T> : null}</Row>
            {x.eligibility?.checks ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{x.eligibility.checks.filter((k) => k.pass !== null).map((k) => `${k.pass ? '✓' : '✕'} ${k.note}`).join(' · ')}</T> : null}
            {!closed ? <Row style={{ marginTop: 8 }}>
              {(can || x.status === 'invited') ? <Btn small title="Accept" disabled={!x.division_id && !divOpts.length} onPress={() => act(() => api.post(`/memberships/${x.id}/decision`, { action: 'accept', division_id: x.division_id ?? divOpts[0]?.value }), 'Accepted')} /> : null}
              {can ? <Btn small color={c.paper} ink={c.ink} title="Waitlist" onPress={() => act(() => api.post(`/memberships/${x.id}/decision`, { action: 'waitlist' }), 'Waitlisted')} /> : null}
              <Btn small color={c.paper} ink={c.red} title="Withdraw" onPress={() => act(() => api.post(`/memberships/${x.id}/decision`, { action: 'withdraw', reason: 'Withdrawn by the team' }), 'Withdrawn')} /></Row> : null}
          </Card>))}
        {!items.some((x) => ['applied', 'invited', 'waitlisted'].includes(x.status)) ? <Empty emoji="✅" title="Nothing waiting" /> : null}
      </Section>
      {can ? <History id={s.id} /> : null}
    </View>
  );
}

function History({ id }) {
  const [offset, setOffset] = useState(0);
  const h = useLoad(() => api.get(`/seasons/${id}/membership-history`, { limit: 10, offset }), [id, offset]);
  if (!h.data?.items.length) return null;
  return (
    <Section title="Membership history" color={c.mute}>
      {h.data.items.map((e) => <T key={e.id} size={13} style={{ paddingVertical: 2 }}>{fmtDate(e.created_at)} · {e.team_name} · {e.action}{e.from_division_name ? ` (${e.from_division_name} → ${e.division_name})` : e.division_name ? ` · ${e.division_name}` : ''}{e.reason ? ` — ${e.reason}` : ''}</T>)}
      <Pager count={h.data.items.length} offset={offset} limit={10} onOffset={setOffset} busy={h.loading} />
    </Section>
  );
}

// ------------------------------------------------------------------ Fixtures
function useDivision(s) {
  const [d, setD] = useState(null);
  const sel = d ?? s.divisions.find((x) => !x.archived_at)?.id ?? null;
  return [sel, setD, s.divisions.find((x) => x.id === sel)];
}
const DivisionPick = ({ s, value, onChange }) => <MenuField label="Division" value={value} onChange={onChange} placeholder="No division yet" options={opts(s.divisions.filter((d) => !d.archived_at), (d) => ({ value: d.id, label: d.name, sub: `Tier ${d.tier} · ${d.teams} teams` }))} />;

function FixturesTab({ season: s, can, reload }) {
  const [did, setDid, div] = useDivision(s);
  const [offset, setOffset] = useState(0), [gen, setGen] = useState(null), [dec, setDec] = useState(null);
  const fx = useLoad(() => (did ? api.get(`/divisions/${did}/fixtures`, { limit: 30, offset }) : Promise.resolve(null)), [did, offset]);
  const act = useDo(() => { fx.reload(); reload(); });
  const closed = ['completed', 'archived'].includes(s.status);
  if (!div) return <Empty emoji="🧩" title="Add a division first" />;
  const rows = fx.data?.items ?? [];
  const byRound = rows.reduce((m, f) => ((m[f.round_label ?? 'Unassigned'] ??= []).push(f), m), {});
  return (
    <View style={{ gap: 10 }}>
      <DivisionPick s={s} value={did} onChange={(v) => { setDid(v); setOffset(0); }} />
      {can && !closed && div.fixtures === 0 ? <Btn title="Generate the season’s fixtures" onPress={() => setGen({ double: true, first_round_on: s.starts_on?.slice(0, 10), days: 7, kickoff: '18:00' })} /> : null}
      {fx.error ? <ErrorBox error={fx.error} onRetry={fx.reload} /> : !fx.data ? <Loading /> : rows.length ? Object.entries(byRound).map(([round, list]) => (
        <Section key={round} title={round} color={c.cyan}>
          {list.map((f) => (
            <Card key={f.id} style={{ marginBottom: 6 }}>
              <Row><View style={{ flex: 1, minWidth: 180 }}>
                <T weight="700">{`${f.home_name} ${f.status === 'completed' && f.outcome === 'played' ? `${f.home_score}–${f.away_score}` : 'v'} ${f.away_name}`}</T>
                <T size={12.5} color={c.mute}>{new Date(f.scheduled_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</T></View>
                {f.outcome !== 'played' ? <Tag label={f.outcome.replace('_', ' ')} color={c.redSoft} /> : <Tag label={f.status} color={f.status === 'completed' ? c.limeSoft : f.status === 'postponed' ? c.sunSoft : c.violetSoft} />}
                {can && !closed ? <Btn small color={c.paper} ink={c.ink} title="Decide" onPress={() => setDec({ f, kind: 'postpone', reason: '', scheduled_at: null })} /> : null}</Row>
              {f.outcome_reason || f.postponed_reason ? <T size={12} color={c.mute}>{f.outcome_reason ?? f.postponed_reason}</T> : null}
            </Card>))}
        </Section>)) : <Empty emoji="🗓️" title="No fixtures yet" sub="Generate a round robin or link existing games of this event." />}
      <Pager count={rows.length} offset={offset} limit={30} onOffset={setOffset} busy={fx.loading} />
      <Sheet visible={!!gen} onClose={() => setGen(null)} title="Generate fixtures" footer={gen ? <Btn title="Generate" disabled={!gen.first_round_on} onPress={async () => { const r = await act(() => api.post(`/divisions/${did}/generate-fixtures`, { double: gen.double, first_round_on: gen.first_round_on, days_between_rounds: gen.days, kickoff: gen.kickoff }), (x) => `${x.fixtures} games in ${x.rounds} rounds`); if (r) setGen(null); }} /> : null}>
        {gen ? <View style={{ gap: 12 }}>
          <T color={c.mute} size={13}>One round robin of the {div.teams} accepted teams in {div.name}. Games are ordinary fixtures of this season’s event.</T>
          <SwitchRow label="Home and away" sub="Everyone plays everyone twice" value={gen.double} onChange={(v) => setGen({ ...gen, double: v })} />
          <DateField label="First round" value={gen.first_round_on} min={s.starts_on?.slice(0, 10)} onChange={(v) => setGen({ ...gen, first_round_on: v })} />
          <TimeField label="Kick-off" value={gen.kickoff} onChange={(v) => setGen({ ...gen, kickoff: v })} />
          <Counter label="Days between rounds" value={gen.days} min={1} max={30} onChange={(v) => setGen({ ...gen, days: v })} />
        </View> : null}
      </Sheet>
      <Sheet visible={!!dec} onClose={() => setDec(null)} title="Decide this fixture" footer={dec ? <Btn title="Save decision" disabled={dec.reason.trim().length < 3 || (dec.kind === 'reschedule' && !dec.scheduled_at)} onPress={async () => {
        const body = { reason: dec.reason.trim(), ...(dec.kind === 'postpone' ? { postpone: true } : dec.kind === 'reschedule' ? { postpone: false, scheduled_at: dec.scheduled_at } : dec.kind === 'played' ? { outcome: 'played' } : { outcome: dec.kind }) };
        const r = await act(() => api.post(`/competition-fixtures/${dec.f.id}/decision`, body), 'Decision recorded'); if (r) setDec(null);
      }} /> : null}>
        {dec ? <View style={{ gap: 12 }}>
          <T weight="700">{dec.f.home_name} v {dec.f.away_name}</T>
          <Seg options={[{ value: 'postpone', label: 'Postpone' }, { value: 'reschedule', label: 'Reschedule' }, { value: 'forfeit_home', label: 'Home forfeits' }, { value: 'forfeit_away', label: 'Away forfeits' }, { value: 'double_forfeit', label: 'Both forfeit' }, { value: 'played', label: 'Clear forfeit' }]} value={dec.kind} onChange={(v) => setDec({ ...dec, kind: v })} />
          {dec.kind === 'reschedule' ? <DateTimeField label="New date and time" value={dec.scheduled_at} onChange={(v) => setDec({ ...dec, scheduled_at: v })} /> : null}
          <Field label="Reason (kept in the record)" value={dec.reason} onChangeText={(v) => setDec({ ...dec, reason: v })} multiline maxLength={500} />
          <T size={12} color={c.mute}>The match result is never edited. A forfeit changes the table only, using this season’s forfeit rule.</T>
        </View> : null}
      </Sheet>
    </View>
  );
}

// ------------------------------------------------------------------ Standings
const COLS = [['P', 'played'], ['W', 'won'], ['D', 'drawn'], ['L', 'lost']];
function StandingsTab({ season: s, can, reload }) {
  const [did, setDid, div] = useDivision(s);
  const st = useLoad(() => (did ? api.get(`/divisions/${did}/standings`) : Promise.resolve(null)), [did]);
  const [adj, setAdj] = useState(null);
  const act = useDo(() => { st.reload(); reload(); });
  if (!div) return <Empty emoji="🧩" title="Add a division first" />;
  const d = st.data;
  const closed = ['completed', 'archived'].includes(s.status);
  return (
    <View style={{ gap: 10 }}>
      <DivisionPick s={s} value={did} onChange={setDid} />
      {st.error ? <ErrorBox error={st.error} onRetry={st.reload} /> : !d ? <Loading /> : (
        <>
          <Row><Tag label={d.source === 'snapshot' ? '❄️ Final, frozen' : 'Live'} color={d.source === 'snapshot' ? c.sunSoft : c.limeSoft} /><Tag label={`Rules v${d.rule_version}`} /><T size={11} color={c.mute}>{d.hash.slice(0, 10)}</T></Row>
          <Card pad={8}>
            <View style={{ flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 6 }}>
              <T size={11} color={c.mute} style={{ width: 26 }}>#</T><T size={11} color={c.mute} style={{ flex: 1 }}>TEAM</T>
              {COLS.map(([l]) => <T key={l} size={11} color={c.mute} style={{ width: 28, textAlign: 'center' }}>{l}</T>)}
              <T size={11} color={c.mute} style={{ width: 52, textAlign: 'center' }}>{d.unit.for}–{d.unit.against}</T><T size={11} color={c.mute} style={{ width: 36, textAlign: 'center' }}>ADJ</T><T size={11} color={c.mute} style={{ width: 36, textAlign: 'right' }}>PTS</T>
            </View>
            {d.table.map((r) => (
              <View key={r.team_id} accessible accessibilityLabel={`${r.rank}. ${r.name}, ${r.points} points from ${r.played} played`} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, paddingHorizontal: 6, borderTopWidth: 1, borderTopColor: c.line }}>
                <T weight="700" size={13} style={{ width: 26 }}>{r.rank}</T><T weight="600" size={14} style={{ flex: 1 }} numberOfLines={1}>{r.name}</T>
                {COLS.map(([l, k]) => <T key={l} size={13} style={{ width: 28, textAlign: 'center' }}>{r[k]}</T>)}
                <T size={13} style={{ width: 52, textAlign: 'center' }}>{r.for}–{r.against}</T><T size={13} color={r.adjustment ? c.red : c.mute} style={{ width: 36, textAlign: 'center' }}>{r.adjustment ? money(r.adjustment) : '·'}</T><T weight="800" size={14} style={{ width: 36, textAlign: 'right' }}>{r.points}</T>
              </View>))}
            {!d.table.length ? <Empty emoji="📊" title="No teams in this division yet" /> : null}
          </Card>
          {d.unit.generic ? <T size={12} color={c.mute}>This sport has no dedicated score unit yet: the table counts the recorded score as a generic “Score”.</T> : <T size={12} color={c.mute}>Scores counted as {d.unit.unit.toLowerCase()}. Ties are broken in the order set in Rules.</T>}
          {can && !closed && d.source === 'live' ? <Btn small title="Adjust points…" onPress={() => setAdj({ team_id: null, delta: -1, reason: '' })} /> : null}
          {d.adjustments.length ? (
            <Section title="Adjustments" color={c.orange}>
              {d.adjustments.map((a) => (
                <Row key={a.id} style={{ paddingVertical: 4 }}><T weight="700" color={a.points_delta < 0 ? c.red : c.lime} style={{ width: 40 }}>{money(a.points_delta)}</T><T style={{ flex: 1, minWidth: 140 }} size={13.5}>{a.team_name} — {a.reason}{a.reverses_id ? ' (reversal)' : ''}</T>
                  {can && d.source === 'live' && !a.reverses_id && !d.adjustments.some((x) => x.reverses_id === a.id) ? <Btn small color={c.paper} ink={c.ink} title="Reverse" onPress={() => setAdj({ reverse: a, reason: '' })} /> : null}</Row>))}
            </Section>) : null}
          <Sheet visible={!!adj} onClose={() => setAdj(null)} title={adj?.reverse ? 'Reverse an adjustment' : 'Adjust points'} footer={adj ? <Btn title="Record adjustment" disabled={adj.reason.trim().length < 3 || (!adj.reverse && (!adj.team_id || !adj.delta))} onPress={async () => {
            const body = adj.reverse ? { team_id: adj.reverse.team_id, reverses_id: adj.reverse.id, reason: adj.reason.trim() } : { team_id: adj.team_id, points_delta: adj.delta, reason: adj.reason.trim() };
            const r = await act(() => api.post(`/divisions/${did}/adjustments`, body), 'Adjustment recorded'); if (r) setAdj(null);
          }} /> : null}>
            {adj ? <View style={{ gap: 12 }}>
              {adj.reverse ? <T>Reverse {money(adj.reverse.points_delta)} for {adj.reverse.team_name}: {adj.reverse.reason}</T> : <>
                <MenuField label="Team" value={adj.team_id} onChange={(v) => setAdj({ ...adj, team_id: v })} options={opts(d.table, (r) => ({ value: r.team_id, label: r.name }))} />
                <Counter label="Points (− deduct, + award)" value={adj.delta} min={-100} max={100} onChange={(v) => setAdj({ ...adj, delta: v })} /></>}
              <Field label="Reason (public in the table notes)" value={adj.reason} onChangeText={(v) => setAdj({ ...adj, reason: v })} multiline maxLength={500} />
              <T size={12} color={c.mute}>Adjustments are separate, append-only entries; match results are never edited.</T>
            </View> : null}
          </Sheet>
        </>)}
    </View>
  );
}

// ------------------------------------------------------------------ Rules (versioned)
function RulesTab({ season: s, can, reload }) {
  const rules = useLoad(() => api.get(`/seasons/${s.id}/rules`, { limit: 20 }), [s.id]);
  const act = useDo(() => { rules.reload(); reload(); });
  const r0 = s.rules;
  const [f, setF] = useState(null);
  const closed = ['completed', 'archived'].includes(s.status);
  const labels = s.tiebreaker_labels;
  const edit = f ?? null;
  const move = (i, d) => { const t = [...edit.tiebreakers]; [t[i], t[i + d]] = [t[i + d], t[i]]; setF({ ...edit, tiebreakers: t }); };
  return (
    <View style={{ gap: 10 }}>
      <Card>
        <Row><H2 style={{ flex: 1 }}>Rules in force · v{s.rule_version}</H2>{can && !closed ? <Btn small title="New version…" onPress={() => setF({ ...r0, points: { ...r0.points }, forfeit: { ...r0.forfeit }, movement: { ...r0.movement }, tiebreakers: [...r0.tiebreakers], note: '' })} /> : null}</Row>
        <T>Win {r0.points.win} · Draw {r0.points.draw} · Loss {r0.points.loss} · Forfeit awards {r0.forfeit.winner_for}–{r0.forfeit.winner_against}</T>
        <T color={c.mute} size={13}>Ties: {r0.tiebreakers.map((t) => labels[t]).join(' → ')}</T>
        <T color={c.mute} size={13}>Season end: promote {r0.movement.promote}, relegate {r0.movement.relegate}, playoff {r0.movement.playoff}, qualify {r0.movement.qualify}</T>
      </Card>
      {rules.data ? <Section title="Versions" color={c.mute}>{rules.data.items.map((v) => <T key={v.version} size={13} style={{ paddingVertical: 2 }}>v{v.version} · {fmtDate(v.created_at)} · {v.by}{v.note ? ` — ${v.note}` : ''}</T>)}</Section> : null}
      <Sheet visible={!!edit} onClose={() => setF(null)} title="New rules version" footer={edit ? <Btn title="Publish version" onPress={async () => {
        const r = await act(() => api.post(`/seasons/${s.id}/rules`, { rules: { points: edit.points, forfeit: edit.forfeit, tiebreakers: edit.tiebreakers, movement: edit.movement }, note: edit.note.trim() || undefined }), 'New rules version published'); if (r) setF(null);
      }} /> : null}>
        {edit ? <View style={{ gap: 12 }}>
          <Counter label="Points for a win" value={edit.points.win} min={0} max={10} onChange={(v) => setF({ ...edit, points: { ...edit.points, win: v } })} />
          <Counter label="Points for a draw" value={edit.points.draw} min={0} max={10} onChange={(v) => setF({ ...edit, points: { ...edit.points, draw: v } })} />
          <Counter label="Points for a loss" value={edit.points.loss} min={0} max={10} onChange={(v) => setF({ ...edit, points: { ...edit.points, loss: v } })} />
          <Counter label="Forfeit: score for the other side" value={edit.forfeit.winner_for} min={0} max={20} onChange={(v) => setF({ ...edit, forfeit: { ...edit.forfeit, winner_for: v } })} />
          <T weight="700">Tie-breakers, in order</T>
          {edit.tiebreakers.map((t, i) => (
            <Row key={t}><T style={{ flex: 1, minWidth: 140 }}>{i + 1}. {labels[t]}</T>
              <Btn small color={c.paper} ink={c.ink} title="▲" disabled={i === 0} accessibilityLabel={`Move ${labels[t]} up`} onPress={() => move(i, -1)} />
              <Btn small color={c.paper} ink={c.ink} title="▼" disabled={i === edit.tiebreakers.length - 1} accessibilityLabel={`Move ${labels[t]} down`} onPress={() => move(i, 1)} /></Row>))}
          <Counter label="Promoted" value={edit.movement.promote} min={0} max={20} onChange={(v) => setF({ ...edit, movement: { ...edit.movement, promote: v } })} />
          <Counter label="Relegated" value={edit.movement.relegate} min={0} max={20} onChange={(v) => setF({ ...edit, movement: { ...edit.movement, relegate: v } })} />
          <Counter label="Playoff places" value={edit.movement.playoff} min={0} max={20} onChange={(v) => setF({ ...edit, movement: { ...edit.movement, playoff: v } })} />
          <Counter label="Qualify for the championship" value={edit.movement.qualify} min={0} max={20} onChange={(v) => setF({ ...edit, movement: { ...edit.movement, qualify: v } })} />
          <Field label="Why the change" value={edit.note} onChangeText={(v) => setF({ ...edit, note: v })} maxLength={500} />
        </View> : null}
      </Sheet>
    </View>
  );
}

// ------------------------------------------------------------------ Reports
function ReportsTab({ season: s, can }) {
  const rep = useLoad(() => (can ? api.get(`/seasons/${s.id}/report`) : Promise.resolve(null)), [s.id, can]);
  const { toast } = useSession();
  if (!can) return <Empty emoji="🔒" title="Reports are for the organiser" />;
  if (rep.error) return <ErrorBox error={rep.error} onRetry={rep.reload} />;
  if (!rep.data) return <Loading />;
  const d = rep.data;
  return (
    <View style={{ gap: 10 }}>
      <Row><Btn small title="Download CSV" onPress={async () => { try { const r = await api.get(`/seasons/${s.id}/report`, { format: 'csv' }); await saveFile(r.filename, r.content, r.content_type); } catch (e) { toast('' + e.message); } }} /><Tag label={`Rules v${d.rule_version}`} /><Tag label={`${d.movements.confirmed} movements confirmed`} /></Row>
      <Cols a={<>{d.divisions.map((x) => (
        <Card key={x.division_id} style={{ marginBottom: 8 }}>
          <Row><T weight="700" style={{ flex: 1 }}>{x.name}</T>{x.frozen ? <Tag label="Frozen" color={c.sunSoft} /> : null}</Row>
          <T size={13} color={c.mute}>{x.teams} teams · {x.played} of {x.total} games played · {x.forfeits} forfeits · {x.postponed} postponed · {x.adjustments} adjustments</T>
        </Card>))}</>} b={null} />
    </View>
  );
}
