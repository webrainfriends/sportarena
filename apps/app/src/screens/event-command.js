// Event Command Centre: one place to run an event from first idea to the final whistle. Lifecycle controls (open, start, pause,
// resume, end), departments, boards, fixtures with live games, and the official results — all in the Arena look.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { usePoll } from '../live';
import { useSession } from '../session';
import { useNav } from '../nav';
import { A, ABtn, ACard, AChip, AEmpty, AHero, AScreen, ASection, AT, ATabs, AG, LiveBadge, ReasonSheet, StageRail } from '../arena';
import { ErrorBox, Field, Loading, Sheet, T } from '../ui';
import { DepartmentsTab } from './event-departments';
import { BoardTab } from './event-board';
import { FixturesTab } from './match-centre';
import { ResultsTab } from './event-results';

const STEPS = [['draft', 'Setup'], ['open', 'Open'], ['ongoing', 'Running'], ['completed', 'Ended']];
const rank = { draft: 0, open: 1, ongoing: 2, paused: 2, completed: 3, cancelled: 3 };
const TONE = { draft: AG.neon, open: AG.neon, ongoing: AG.hero, paused: AG.sun, completed: ['#059669', '#34D399'], cancelled: ['#475569', '#334155'] };
const when = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : null);

export function EventCommand({ id, tab: first = 'overview' }) {
  const { user, toast } = useSession();
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  const [tab, setTab] = useState(first);
  const [ask, setAsk] = useState(null);       // 'pause' | 'end' | 'force'
  const [blockers, setBlockers] = useState(0);
  const [busy, setBusy] = useState(false);
  if (ev.error) return <AScreen><ErrorBox error={ev.error} onRetry={ev.reload} /></AScreen>;
  if (!ev.data) return <AScreen><Loading /></AScreen>;
  const e = ev.data;
  const isOrg = !!user && (e.organizer_id === user.id || user.roles?.includes('admin'));
  const st = e.status;
  const run = async (fn, ok) => { setBusy(true); try { const r = await fn(); if (ok) toast(ok); ev.reload(); return r; } catch (x) { toast('' + x.message); return null; } finally { setBusy(false); } };
  const setStatus = (status, ok) => run(() => api.patch(`/events/${id}`, { status }), ok);
  const end = async (force, reason) => {
    setBusy(true);
    try { await api.post(`/events/${id}/end`, { force, reason: reason || undefined }); toast('Event ended. Podium awarded.'); ev.reload(); }
    catch (x) { if (x.status === 409 && x.details?.fixtures) { setBlockers(x.details.fixtures.length); setAsk('force'); } else toast('' + x.message); }
    finally { setBusy(false); }
  };
  const steps = STEPS.map(([k, label], i) => ({ key: k, label: st === 'paused' && k === 'ongoing' ? 'Paused' : label, state: i < rank[st] ? 'done' : i === rank[st] ? 'now' : 'todo' }));
  const tabs = [{ key: 'overview', label: 'Overview', icon: '🏁' }, { key: 'depts', label: 'Teams', icon: '🧩' }, { key: 'boards', label: 'Boards', icon: '🗂️' }, { key: 'games', label: 'Games', icon: '⚡' }, { key: 'results', label: 'Results', icon: '🏆' }];

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
      {tab === 'overview' && <Overview id={id} e={e} isOrg={isOrg} go={setTab} />}
      {tab === 'depts' && <DepartmentsTab id={id} isOrg={isOrg} />}
      {tab === 'boards' && <BoardTab id={id} isOrg={isOrg} />}
      {tab === 'games' && <FixturesTab id={id} isOrg={isOrg} />}
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

function Overview({ id, e, isOrg, go }) {
  const { push } = useNav();
  const depts = useLoad(() => api.get(`/events/${id}/departments`), [id]);
  const live = useLoad(() => api.get(`/events/${id}/live`), [id]);
  const hist = useLoad(() => (isOrg ? api.get(`/events/${id}/status-history`) : Promise.resolve([])), [id, isOrg]);
  const [plan, setPlan] = useState(false);
  usePoll(live.reload, 8000);
  const n = depts.data?.length ?? 0;
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {[[n, 'Departments', '🧩'], [live.data?.filter((g) => g.fixture.status === 'live').length ?? 0, 'Live now', '🔴'], [e.entrants?.length ?? 0, 'Entrants', '👥']].map(([v, l, i]) => (
          <ACard key={l} pad={12} style={{ flex: 1, alignItems: 'center' }}><AT size={22}>{i}</AT><AT size={26} weight="900" num>{v}</AT><AT size={11} weight="800" color={A.mute}>{l.toUpperCase()}</AT></ACard>
        ))}
      </View>

      {isOrg ? (
        <ACard tone={A.violet} style={{ gap: 8 }}>
          <AT size={18} weight="900">🤖 Plan it with AI</AT>
          <AT size={13} color={A.mute}>Get the departments this event needs and starter tasks for each, dated backwards from day one. You review everything before it is created.</AT>
          <ABtn small title={n ? 'Suggest what is missing' : 'Suggest a plan'} onPress={() => setPlan(true)} style={{ alignSelf: 'flex-start' }} />
        </ACard>
      ) : null}

      <ASection title="Jump to" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <AChip label="🧩 Departments" onPress={() => go('depts')} /><AChip label="🗂️ Boards" onPress={() => go('boards')} /><AChip label="⚡ Games" onPress={() => go('games')} /><AChip label="🏆 Results" onPress={() => go('results')} />
        {isOrg ? <><AChip label="Tournament console" onPress={() => push('EventAdmin', { id })} /><AChip label="Plan & budget" onPress={() => push('EventPlan', { id })} /></> : null}
      </View>

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
      <PlanSheet visible={plan} onClose={() => setPlan(false)} id={id} onDone={() => { depts.reload(); go('depts'); }} />
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
