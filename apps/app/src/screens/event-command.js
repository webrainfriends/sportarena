// Event console: the one place to run an event from first idea to the final whistle. Setup checklist, teams and invitations, departments,
// hiring, boards, games (live, schedule, bracket), venue, sponsors, requests, budget and official results, plus lifecycle controls
// (open, start, pause, resume, end). It replaces the separate Tournament console and Plan & budget screens: one feature, one place.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { usePoll } from '../live';
import { useSession } from '../session';
import { useNav } from '../nav';
import { A, ABtn, ACard, AChip, AEmpty, AHero, AScreen, ASection, ASetupSteps, AStat, AT, ATabs, AG, LiveBadge, ReasonSheet, StageRail } from '../arena';
import { ErrorBox, Field, Loading, Sheet, T } from '../ui';
import { c } from '../theme';
import { DepartmentsTab } from './event-departments';
import { BoardTab } from './event-board';
import { FixturesTab } from './match-centre';
import { ResultsTab } from './event-results';
import { TeamsTab } from './event-teams';
import { HiringTab } from './event-hiring';
import { BusinessTab, MoneyTiles } from './event-business';
import { EventVenues } from './event-venues';
import { Requests, Budget } from './event-plan';
import { GameRow } from './event-schedule';

const STEPS = [['draft', 'Setup'], ['open', 'Open'], ['ongoing', 'Running'], ['completed', 'Ended']];
const rank = { draft: 0, open: 1, ongoing: 2, paused: 2, completed: 3, cancelled: 3 };
const TONE = { draft: AG.neon, open: AG.neon, ongoing: AG.hero, paused: AG.sun, completed: ['#059669', '#34D399'], cancelled: ['#475569', '#334155'] };
const when = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : null);

/** Every fixture of the event: the API returns at most 100 per page, so keep paging (a big tournament has hundreds). */
async function allFixtures(id) {
  let out = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await api.get('/fixtures', { event_id: id, limit: 100, offset });
    out = out.concat(page);
    if (page.length < 100) break;
  }
  return out;
}

/** Everything the console tabs share. Organiser-only data is not requested for other viewers. */
function useConsoleData(id, org) {
  const L = (fn) => useLoad(() => (org ? fn() : Promise.resolve(null)), [id, org]); // eslint-disable-line react-hooks/rules-of-hooks
  const fx = useLoad(() => allFixtures(id), [id]);
  const bracket = useLoad(() => api.get(`/events/${id}/bracket`), [id]);
  const venues = L(() => api.get(`/events/${id}/venues`));
  const inv = L(() => api.get(`/events/${id}/invitations`));
  const seeds = L(() => api.get(`/events/${id}/seeds`));
  const roles = L(() => api.get(`/events/${id}/staff-roles`));
  const staff = L(() => api.get(`/events/${id}/staff-assignments`));
  const vend = L(() => api.get(`/events/${id}/vendors`));
  const money = L(() => api.get(`/events/${id}/commercials`));
  const plan = L(() => api.get(`/events/${id}/plan`));
  const all = [fx, bracket, venues, inv, seeds, roles, staff, vend, money, plan];
  return { fx, bracket, venues, inv, seeds, roles, staff, vend, money, plan, reload: () => all.forEach((l) => l.reload()) };
}

export function EventCommand({ id, tab: first = 'overview' }) {
  const { user, toast } = useSession();
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  const [tab, setTab] = useState(first);
  const [sub, setSub] = useState({ people: 'departments', business: 'partners' });
  const [ask, setAsk] = useState(null);       // 'pause' | 'end' | 'force'
  const [blockers, setBlockers] = useState(0);
  const [busy, setBusy] = useState(false);
  const e = ev.data;
  const isOrg = !!e && !!user && (e.organizer_id === user.id || !!user.roles?.includes('admin'));
  const D = useConsoleData(id, isOrg);
  if (ev.error) return <AScreen><ErrorBox error={ev.error} onRetry={ev.reload} /></AScreen>;
  if (!e) return <AScreen><Loading /></AScreen>;
  const st = e.status;
  const games = D.fx.data ?? [];
  const accepted = (e.entrants ?? []).filter((x) => x.team_id);
  const go = (t, s) => { setTab(t); if (s) setSub((p) => ({ ...p, [t]: s })); };
  const reloadAll = () => { ev.reload(); D.reload(); };
  const run = async (fn, ok) => { setBusy(true); try { const r = await fn(); if (ok) toast(ok); ev.reload(); return r; } catch (x) { toast('' + x.message); return null; } finally { setBusy(false); } };
  const setStatus = (status, ok) => run(() => api.patch(`/events/${id}`, { status }), ok);
  const end = async (force, reason) => {
    setBusy(true);
    try { await api.post(`/events/${id}/end`, { force, reason: reason || undefined }); toast('Event ended. Podium awarded.'); ev.reload(); }
    catch (x) { if (x.status === 409 && x.details?.fixtures) { setBlockers(x.details.fixtures.length); setAsk('force'); } else toast('' + x.message); }
    finally { setBusy(false); }
  };
  const steps = STEPS.map(([k, label], i) => ({ key: k, label: st === 'paused' && k === 'ongoing' ? 'Paused' : label, state: i < rank[st] ? 'done' : i === rank[st] ? 'now' : 'todo' }));
  const waiting = D.plan.data?.requests?.waiting_for_you?.length || undefined;
  const tabs = [
    { key: 'overview', label: 'Overview', icon: '🏁' },
    ...(isOrg ? [{ key: 'teams', label: 'Teams', icon: '👥', badge: (D.inv.data ?? []).filter((n) => n.status === 'invited').length || undefined }] : []),
    { key: 'people', label: 'People', icon: '🧩' },
    { key: 'boards', label: 'Boards', icon: '🗂️' },
    { key: 'games', label: 'Games', icon: '⚡' },
    ...(isOrg ? [{ key: 'venue', label: 'Venue', icon: '🏟️' }, { key: 'business', label: 'Business', icon: '💼', badge: waiting }] : []),
    { key: 'results', label: 'Results', icon: '🏆' },
  ];
  const P = { id, e, isOrg, go, reload: reloadAll };
  const money = D.money.data;

  return (
    <AScreen>
      <AHero kicker={[e.sport, e.city].filter(Boolean).join(' · ')} title={e.name} sub={[when(e.starts_on), when(e.ends_on)].filter(Boolean).join(' → ') || 'Dates to be set'} tone={TONE[st] ?? AG.hero} emoji={e.banner_emoji ?? '🏆'}>
        <View style={{ marginTop: 12 }}><LiveBadge status={st === 'paused' ? 'paused' : st} label={st === 'ongoing' ? 'RUNNING' : undefined} /></View>
        {st === 'paused' && e.pause_reason ? <AT size={13} weight="700" color="#fff" style={{ marginTop: 10 }}>⏸ {e.pause_reason}</AT> : null}
      </AHero>
      <StageRail steps={steps} />

      {isOrg && !['completed', 'cancelled'].includes(st) ? (
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          {st === 'draft' ? <ABtn title="Open registration" tone="neon" loading={busy} onPress={() => setStatus('open', 'Registration is open')} /> : null}
          {st === 'open' ? <ABtn title="⚡ Start the event" tone="live" loading={busy} onPress={() => setStatus('ongoing', 'The event is running')} /> : null}
          {st === 'ongoing' ? <ABtn title="⏸ Pause" tone="sun" onPress={() => setAsk('pause')} /> : null}
          {st === 'paused' ? <ABtn title="▶ Resume event" tone="lime" loading={busy} onPress={() => run(() => api.post(`/events/${id}/resume`, {}), 'Back on')} /> : null}
          {['ongoing', 'paused'].includes(st) ? <ABtn title="🏁 End event" tone="ghost" onPress={() => setAsk('end')} /> : null}
        </View>
      ) : null}

      <ATabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview {...P} D={D} games={games} accepted={accepted} money={money} />}
      {tab === 'teams' && isOrg && <TeamsTab {...P} accepted={accepted} inv={D.inv.data ?? []} seeds={D.seeds.data ?? []} />}
      {tab === 'people' && (
        <>
          {isOrg ? <View style={{ flexDirection: 'row', gap: 8 }}><AChip label="🧩 Departments" active={sub.people === 'departments'} onPress={() => go('people', 'departments')} /><AChip label="🩺 Hiring" active={sub.people === 'hiring'} onPress={() => go('people', 'hiring')} /></View> : null}
          {sub.people === 'hiring' && isOrg ? <HiringTab {...P} roles={D.roles.data ?? []} staff={D.staff.data ?? []} reload={reloadAll} /> : <DepartmentsTab id={id} isOrg={isOrg} />}
        </>
      )}
      {tab === 'boards' && <BoardTab id={id} isOrg={isOrg} />}
      {tab === 'games' && <FixturesTab id={id} isOrg={isOrg} games={games} accepted={accepted} venues={D.venues.data ?? []} bracket={D.bracket.data} reload={reloadAll} goVenue={() => go('venue')} />}
      {tab === 'venue' && isOrg && <EventVenues e={e} toast={toast} onChange={reloadAll} />}
      {tab === 'business' && isOrg && (
        <>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <AChip label="🤝 Partners" active={sub.business === 'partners'} onPress={() => go('business', 'partners')} />
            <AChip label="📨 Requests" badge={waiting} active={sub.business === 'requests'} onPress={() => go('business', 'requests')} />
            <AChip label="💰 Budget" active={sub.business === 'budget'} onPress={() => go('business', 'budget')} />
          </View>
          {sub.business === 'partners' ? <BusinessTab {...P} vend={D.vend.data ?? []} money={money} reload={reloadAll} />
            : D.plan.data ? <Paper>{sub.business === 'requests' ? <Requests id={id} e={e} p={D.plan.data} toast={toast} reload={D.plan.reload} /> : <Budget id={id} p={D.plan.data} toast={toast} reload={D.plan.reload} />}</Paper> : <Loading />}
        </>
      )}
      {tab === 'results' && <ResultsTab id={id} e={e} />}

      <ReasonSheet visible={ask === 'pause'} onClose={() => setAsk(null)} title="Pause the event" sub="Live games freeze, and everyone entered or on the crew is told why." presets={['Rain delay', 'Safety issue', 'Power cut', 'Running behind', 'Medical emergency']} confirmLabel="Pause event" tone="sun"
        onConfirm={(reason) => run(() => api.post(`/events/${id}/pause`, { reason }), 'Event paused')} />
      <Sheet visible={ask === 'end'} onClose={() => setAsk(null)} title="End the event?">
        <T size={14} color="#475569">This closes the event and awards the cup and medals from the standings. Make sure the score sheets are published first.</T>
        <ABtn title="🏁 End the event" tone="live" loading={busy} onPress={async () => { setAsk(null); await end(false); }} />
      </Sheet>
      <ReasonSheet visible={ask === 'force'} onClose={() => setAsk(null)} title={`${blockers} game${blockers === 1 ? ' is' : 's are'} still running`} sub="Ending now marks them abandoned. Say why." presets={['Out of time', 'Venue closing', 'Weather', 'Safety']} confirmLabel="End anyway" tone="live" onConfirm={(reason) => end(true, reason)} />
    </AScreen>
  );
}

/** Back-office screens (requests, budget) keep the app's own light/dark palette on a panel inside the dark console. */
function Paper({ children }) {
  return <View style={{ backgroundColor: c.bg, borderRadius: 24, paddingHorizontal: 12, paddingBottom: 14, overflow: 'hidden' }}>{children}</View>;
}

function Overview({ id, e, isOrg, go, D, games, accepted, money }) {
  const { push } = useNav();
  const depts = useLoad(() => api.get(`/events/${id}/departments`), [id]);
  const plans = useLoad(() => api.get(`/events/${id}/plans`), [id]);
  const live = useLoad(() => api.get(`/events/${id}/live`), [id]);
  const hist = useLoad(() => (isOrg ? api.get(`/events/${id}/status-history`) : Promise.resolve([])), [id, isOrg]);
  const [plan, setPlan] = useState(false);
  usePoll(live.reload, 8000);
  const n = depts.data?.length ?? 0;
  const venues = D.venues.data ?? [], slots = venues.reduce((k, v) => k + v.summary.slots, 0);
  const crew = (D.staff.data ?? []).filter((x) => x.status === 'accepted').length;
  const sponsors = (D.vend.data ?? []).filter((v) => v.kind === 'sponsor' && v.status === 'accepted').length;
  const next = games.filter((g) => !['completed', 'cancelled', 'abandoned'].includes(g.status)).sort((a, b) => +new Date(a.scheduled_at) - +new Date(b.scheduled_at))[0];
  const played = games.filter((g) => g.status === 'completed').length;
  const steps = [
    { key: 'venue', title: 'Book a venue & courts', sub: slots ? `${slots} court booking${slots === 1 ? '' : 's'} at ${venues.find((v) => v.summary.slots)?.name ?? 'your venue'}` : 'Choose a venue with courts for your sport', done: slots > 0, cta: 'Find venue', onPress: () => go('venue') },
    { key: 'teams', title: 'Invite teams', sub: accepted.length ? `${accepted.length} team${accepted.length === 1 ? '' : 's'} in${e.capacity ? ` of ${e.capacity}` : ''}` : 'Rank teams from past results and invite them', done: accepted.length >= 2, cta: 'Invite', onPress: () => go('teams') },
    { key: 'seeds', title: 'Seed the teams', sub: (D.seeds.data ?? []).length ? 'Seeds set from results' : 'Strongest team gets seed 1', done: (D.seeds.data ?? []).length >= 2, cta: 'Seed', onPress: () => go('teams') },
    { key: 'sched', title: 'Schedule the games', sub: games.length ? `${games.length} games scheduled` : 'Fit games into free courts, skipping holidays', done: games.length > 0, cta: 'Plan', onPress: () => go('games') },
    { key: 'bracket', title: 'Knockout bracket', sub: D.bracket.data?.rounds?.length ? 'Bracket is live' : 'Quarter-finals → semi-finals → final', done: !!D.bracket.data?.rounds?.length, cta: 'Create', onPress: () => go('games') },
    { key: 'depts', title: 'Set up departments', sub: n ? `${n} department${n === 1 ? '' : 's'}` : 'Medical, media, volunteers, officials…', done: n > 0, cta: 'Create', onPress: () => go('people', 'departments') },
    { key: 'crew', title: 'Hire referees & medical cover', sub: crew ? `${crew} confirmed` : 'Referees, doctors, physios, volunteers', done: crew > 0, cta: 'Hire', onPress: () => go('people', 'hiring') },
    { key: 'boards', title: 'Plan the work on boards', sub: plans.data?.length ? `${plans.data.length} board${plans.data.length === 1 ? '' : 's'}` : 'Give each department its tasks', done: !!plans.data?.length, cta: 'Plan', onPress: () => go('boards') },
    { key: 'biz', title: 'Sponsors & vendors', sub: sponsors ? `${sponsors} sponsor${sponsors === 1 ? '' : 's'}` : 'Bring in sponsors and retail stalls', done: sponsors > 0 || (D.vend.data ?? []).some((v) => v.status === 'accepted'), cta: 'Add', onPress: () => go('business', 'partners') },
  ];
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="👥" value={accepted.length} label="Teams" /><AStat icon="⚽" value={`${played}/${games.length}`} label="Played" /><AStat icon="🔴" value={live.data?.filter((g) => g.fixture.status === 'live').length ?? 0} label="Live now" /><AStat icon="🧩" value={n} label="Departments" />
      </View>

      {isOrg ? <ASetupSteps steps={steps} title="Get the event ready" /> : null}

      {isOrg ? (
        <ACard tone={A.violet} style={{ gap: 8 }}>
          <AT size={18} weight="900">🤖 Plan it with AI</AT>
          <AT size={13} color={A.mute}>Get the departments this event needs and starter tasks for each, dated backwards from day one. You review everything before it is created.</AT>
          <ABtn small title={n ? 'Suggest what is missing' : 'Suggest a plan'} onPress={() => setPlan(true)} style={{ alignSelf: 'flex-start' }} />
        </ACard>
      ) : null}

      <ASection title="Up next" action={games.length ? 'All games' : undefined} onAction={() => go('games')} />
      {next ? <GameRow f={next} onPress={() => push('MatchCentre', { id: next.id })} /> : <AEmpty emoji="🗓️" title="No games scheduled yet" sub={isOrg ? 'Plan the schedule once teams are in.' : 'Fixtures will appear here.'} />}

      {isOrg && money ? <><ASection title="Money" sub={`In ${e.currency ?? 'INR'}`} action="Details" onAction={() => go('business', 'budget')} /><MoneyTiles money={money} short /></> : null}

      {isOrg && e.sport === 'Multi-sport games' ? <ABtn tone="neon" title="Run the games programme (sports, houses, timetable)" onPress={() => push('Games', { id })} /> : null}

      {isOrg && hist.data?.length ? (
        <>
          <ASection title="Event log" sub="Every status change" />
          <ACard pad={12} style={{ gap: 6 }}>
            {[...hist.data].reverse().slice(0, 6).map((h) => (
              <AT key={h.id} size={12.5} color={A.mute}>{new Date(h.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · <AT size={12.5} weight="800" color={A.ink}>{h.from_status} → {h.to_status}</AT>{h.actor_name ? ` · ${h.actor_name}` : ''}{h.reason ? ` · ${h.reason}` : ''}</AT>
            ))}
          </ACard>
        </>
      ) : null}
      {!isOrg && !n ? <AEmpty emoji="🏁" title="The organiser is setting things up" sub="Departments, games and results will appear here." /> : null}
      <PlanSheet visible={plan} onClose={() => setPlan(false)} id={id} onDone={() => { depts.reload(); go('people', 'departments'); }} />
    </>
  );
}

function PlanSheet({ visible, onClose, id, onDone }) {
  const { toast } = useSession();
  const [notes, setNotes] = useState('');
  const [res, setRes] = useState(null);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const suggest = async () => {
    setBusy(true);
    try { const r = await api.post(`/events/${id}/ai/plan`, { notes: notes.trim() || undefined }); setRes(r); setPick(Object.fromEntries(r.departments.map((d) => [d.name, true]))); } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const chosen = res.departments.filter((d) => pick[d.name]);
      const r = await api.post(`/events/${id}/ai/plan/apply`, { departments: chosen });
      toast(`Created ${r.departments} department${r.departments === 1 ? '' : 's'} and ${r.cards} task${r.cards === 1 ? '' : 's'}`); setRes(null); onClose(); onDone();
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={() => { setRes(null); onClose(); }} title="Plan with AI">
      {!res ? (
        <>
          <Field label="Anything to consider? (optional)" value={notes} onChangeText={setNotes} multiline hint="e.g. outdoor courts, monsoon season, first time hosting" />
          <ABtn title="Suggest a plan" onPress={suggest} loading={busy} />
        </>
      ) : (
        <>
          <T size={12} color="#64748B">{res.ai ? 'Written by AI from your event details.' : 'Built from your event details with built-in rules (AI is off).'} Untick anything you do not want.</T>
          {res.departments.length ? res.departments.map((d) => (
            <View key={d.name} style={{ gap: 4 }}>
              <AChip label={`${pick[d.name] ? '✓' : '○'} ${d.name} · ${d.cards.length} tasks`} active={pick[d.name]} onPress={() => setPick({ ...pick, [d.name]: !pick[d.name] })} />
              {d.why ? <T size={12} color="#64748B">{d.why}</T> : null}
            </View>
          )) : <T color="#475569">Nothing more to suggest: you already have the departments this event needs.</T>}
          {res.departments.length ? <ABtn title={`Create ${Object.values(pick).filter(Boolean).length} departments`} onPress={apply} loading={busy} disabled={!Object.values(pick).some(Boolean)} /> : null}
        </>
      )}
    </Sheet>
  );
}
