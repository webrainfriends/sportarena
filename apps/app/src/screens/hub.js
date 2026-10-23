import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Bubble, Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, H2, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { explain, LoadError } from '../access';
import { FormSheet } from '../FormSheet';
import { AddFollowupSheet, ClinicalStatusCard, ConsentManager, FollowupsPanel, ProviderSearch, ShareRecordsSheet } from './provider';
import { MyRehab, PracticePanel } from './physio-practice';
import { PrivacyHub } from './health-privacy';
import { SportSelect, SportPicker } from '../sportpicker';
import { EntityPicker } from '../entity-picker';
import { DateField } from '../pickers';
import { ModuleHero, ModuleSheet } from './module-hero';
import { PaySheet } from '../PaySheet';
import { TimelineSheet } from '../Timeline';
import { Confirm } from './coaching';
import { RecoveryPanel } from './wellness';
import { DoctorEntry } from './doctor';
import { fmt as fmtBudget } from './sponsor-budgets';
import { MyHealthFile } from './health-file';
import { BeneficiaryFinder } from './sponsor-beneficiaries';
import { c, grad, money, day, when, withUnit, unitName } from '../theme';

const STATUS_TAG = { recorded: ['Private', null], submitted: ['Waiting for approval', 'sun'], approved: ['Approved', 'lime'], disputed: ['Disputed — not counted', 'orangeSoft'], rejected: ['Rejected', 'orangeSoft'], superseded: ['Replaced by a correction', 'cyanSoft'] };
const STEP = { submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected', disputed: 'Problem reported', corrected: 'Correction proposed', superseded: 'Replaced by a correction' };
const thisYear = new Date().getFullYear();
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const fixtureLabel = (f) => `${f.home_name ?? 'TBC'} vs ${f.away_name ?? 'TBC'} · ${day(f.scheduled_at)}`;

function ResultRow({ r, mine, onAct, onHistory }) {
  const [label, tone] = STATUS_TAG[r.status] ?? [r.status, null];
  const official = r.provenance === 'approved_competition';
  return (
    <Card>
      <T weight="900">{r.emoji} {r.metric.replace(/_/g, ' ')} · {withUnit(r.value, r.unit)}</T>
      <T size={12} color={c.mute}>{mine ? '' : `${r.display_name} · `}{r.event_name ? `${r.event_name} · ` : ''}{day(r.achieved_on)}{official && r.official_points != null ? ` · ${r.official_points} official pts` : ''}</T>
      {r.decision_note && ['disputed', 'rejected'].includes(r.status) ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Reason: {r.decision_note}</T> : null}
      {r.evidence_ref ? <T size={12} color={c.mute} numberOfLines={1}>Evidence: {r.evidence_ref}</T> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
        <Tag label={r.evidence_label} color={official ? c.mintSoft : c.violetSoft} />
        {tone ? <Tag label={label} color={c[tone]} /> : null}
        {onAct}
        {official && onHistory ? <Btn small title="History" color={c.paper} ink={c.ink} onPress={() => onHistory(r.id)} /> : null}
      </View>
    </Card>
  );
}

/** Every step a result went through, with who and why. */
function HistorySheet({ id, onClose }) {
  const h = useLoad(() => (id ? api.get(`/performances/${id}/history`) : Promise.resolve([])), [id]);
  return (
    <Sheet visible={!!id} onClose={onClose} title="Result history">
      {h.loading && !h.data ? <Loading /> : h.error ? <ErrorBox error={h.error} onRetry={h.reload} /> : h.data?.length ? h.data.map((l) => (
        <Card key={l.id}>
          <T weight="800">{STEP[l.action] ?? l.action}</T>
          <T size={12} color={c.mute}>{l.actor} · {when(l.at)}</T>
          {l.note ? <T size={13} style={{ marginTop: 4 }}>{l.note}</T> : null}
          {l.snapshot?.value !== undefined ? <T size={12} color={c.mute}>Recorded value {l.snapshot.value}{l.snapshot.official_points != null ? ` · ${l.snapshot.official_points} official pts` : ''}</T> : null}
        </Card>
      )) : <Empty emoji="🕘" title="No history yet" sub="Steps appear here as officials decide on this result." />}
    </Sheet>
  );
}

/** An official submits a competition result: event, optional game, athlete, metric, value, date and evidence. A second official approves it. */
function SubmitResultSheet({ visible, onClose, events, onDone }) {
  const { toast } = useSession();
  const [eventId, setEventId] = useState(null);
  const [fixtureId, setFixtureId] = useState(null);
  const [sport, setSport] = useState(null);
  const [athlete, setAthlete] = useState([]);
  const [metric, setMetric] = useState(null);
  const [other, setOther] = useState(false);
  const [value, setValue] = useState('');
  const [date, setDate] = useState(todayIso());
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const key = useRef(newKey());
  const fixtures = useLoad(() => (eventId ? api.get('/fixtures', { event_id: eventId, limit: 50 }) : Promise.resolve([])), [eventId]);
  const known = useLoad(() => (sport ? api.get('/scoring-rules', { sport }) : Promise.resolve(null)), [sport]);
  const rule = useLoad(() => (sport && metric ? api.get('/scoring-rules', { sport, metric }) : Promise.resolve(null)), [sport, metric]);
  useEffect(() => { if (visible) setErr(null); }, [visible]);
  const pickEvent = (e) => { setEventId(e.id); setFixtureId(null); setAthlete([]); if (e.sport_slug) { setSport(e.sport_slug); setMetric(null); setOther(false); } };
  const unit = rule.data?.rule?.unit;
  const submit = async () => {
    setErr(null);
    const n = Number(String(value).replace(',', '.'));
    if (!eventId) return setErr('Pick the event this result belongs to.');
    if (!sport) return setErr('Pick the sport.');
    if (!athlete.length) return setErr('Pick the athlete.');
    if (!metric?.trim()) return setErr('Say what was measured.');
    if (value === '' || !Number.isFinite(n)) return setErr('Enter the result as a number.');
    setBusy(true);
    try {
      await api.post('/performances', { user_id: athlete[0].id, sport, metric: metric.trim(), value: n, event_id: eventId, fixture_id: fixtureId ?? undefined, achieved_on: date || undefined, evidence_ref: evidence.trim() || undefined, client_key: key.current });
      key.current = newKey();
      setValue(''); setAthlete([]); setEvidence('');
      toast('Result submitted — a second official needs to approve it');
      onDone(); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Submit a competition result">
      {!events?.length ? <Empty emoji="🗓️" title="No events to submit for" sub="Results can be submitted for events you organise or officiate." /> : <>
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Event</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{events.map((e) => <Chip key={e.id} label={e.name} active={e.id === eventId} onPress={() => pickEvent(e)} />)}</View>
        </View>
        {eventId ? <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Game (optional)</T>
          {fixtures.loading && !fixtures.data ? <Loading /> : fixtures.error ? <ErrorBox error={fixtures.error} onRetry={fixtures.reload} /> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Chip label="Whole event" active={fixtureId === null} onPress={() => setFixtureId(null)} />
            {(fixtures.data ?? []).map((f) => <Chip key={f.id} label={fixtureLabel(f)} active={f.id === fixtureId} onPress={() => setFixtureId(f.id)} />)}
          </View>}
        </View> : null}
        <SportPicker label="Sport" value={sport} onChange={(s) => { setSport(s); setMetric(null); setOther(false); }} />
        <EntityPicker kind="person" label="Athlete" value={athlete} onChange={setAthlete} sport={sport ?? undefined} />
        {sport ? <View style={{ gap: 6 }}>
          <T weight="800" size={13}>What was measured</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(known.data?.metrics ?? []).map((m) => <Chip key={m.metric} label={m.metric.replace(/_/g, ' ')} active={!other && metric === m.metric} onPress={() => { setOther(false); setMetric(m.metric); }} />)}
            <Chip label="Another metric" active={other} onPress={() => { setOther(true); setMetric(''); }} />
          </View>
          {other ? <Field label="Metric name" value={metric ?? ''} onChangeText={setMetric} placeholder="goals, assists, 100m_time_s …" hint="Names ending in _s are timed in seconds, names ending in _m are distances in metres; anything else is a whole-number count." /> : null}
        </View> : null}
        <Field label={`Result${unit ? ` (${unitName(unit)})` : ''}`} value={value} onChangeText={(x) => setValue(x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" hint={rule.data?.rule ? `${rule.data.rule.direction === 'lower' ? 'Lower is better.' : 'Higher is better.'} Allowed ${rule.data.rule.min} to ${rule.data.rule.max}.` : undefined} />
        <DateField label="Date achieved" value={date} onChange={setDate} max={todayIso()} />
        <Field label="Evidence reference (optional)" value={evidence} onChangeText={setEvidence} placeholder="Link or timing-sheet number" />
        {err ? <T color={c.red} weight="800" accessibilityRole="alert">{err}</T> : null}
        <Btn title="Submit result" color={c.pink} loading={busy} onPress={submit} />
      </>}
    </Sheet>
  );
}

export function Leaderboard() {
  const { push } = useNav();
  const { user, has, toast } = useSession();
  const [tab, setTab] = useState('rank');
  const [sport, setSport] = useState(null);
  const [season, setSeason] = useState(null);
  const [category, setCategory] = useState(null);
  const [metric, setMetric] = useState(null);
  const [lim, setLim] = useState(25);
  const [evFilter, setEvFilter] = useState(null);
  const [history, setHistory] = useState(null);
  const [form, setForm] = useState(null); // 'practice' | 'submit' | { reject: id } | { dispute: id } | { correct: {id, unit} }
  const crew = useLoad(() => api.get('/events', { as_official: true, limit: 1 }), []); // accepted officiating crew need not hold an organiser/referee role
  const isOfficial = has('organizer', 'referee', 'admin') || (crew.data?.length ?? 0) > 0;
  const sports = useLoad(() => api.get('/sports'), []);
  const rules = useLoad(() => (sport ? api.get('/scoring-rules', { sport }) : Promise.resolve(null)), [sport]);
  const lb = useLoad(() => api.get('/leaderboard', { sport: sport ?? undefined, metric: metric ?? undefined, season: season ?? undefined, category: category ?? undefined, limit: lim }), [sport, metric, season, category, lim]);
  const mine = useLoad(() => api.get('/performances', { user_id: user.id, limit: 100 }), [user.id]);
  const queue = useLoad(() => (isOfficial ? Promise.all([api.get('/performances', { status: 'submitted', limit: 100 }), api.get('/performances', { status: 'disputed', limit: 100 })]).then(([a, b]) => [...b, ...a].filter((r) => r.provenance === 'approved_competition')) : Promise.resolve([])), [isOfficial]);
  const events = useLoad(async () => {
    if (!isOfficial) return [];
    const admin = has('admin');
    const scope = admin ? {} : { as_official: true };
    const [open, done] = await Promise.all([
      api.get('/events', { ...scope, limit: 50 }),
      api.get('/events', { ...scope, status: 'completed', limit: 50 }),
    ]);
    const seen = new Map();
    for (const e of [...open, ...done]) seen.set(e.id, e);
    return [...seen.values()];
  }, [isOfficial]);
  const evResults = useLoad(() => (evFilter ? api.get('/performances', { event_id: evFilter, provenance: 'approved_competition', limit: 100 }) : Promise.resolve([])), [evFilter]);
  const refresh = () => { mine.reload(); queue.reload(); lb.reload(); evResults.reload(); };
  const act = async (fn, msg) => { try { await fn(); toast(msg); refresh(); } catch (e) { toast('' + e.message); } };
  const pickSport = (v) => { setSport(v); setMetric(null); setLim(25); };
  const lower = lb.data?.[0]?.ranking === 'lower_is_better';
  const metricRule = rules.data?.metrics?.find((m) => m.metric === metric)?.rule;
  const categories = [...new Set((sports.data ?? []).map((s) => s.category).filter(Boolean))].sort();
  const todo = queue.data ?? [];
  const workRow = (r) => {
    const blocked = r.recorded_by === user.id || r.user_id === user.id;
    return (
      <ResultRow key={r.id} r={r} onHistory={setHistory} onAct={<>
        {['submitted', 'disputed'].includes(r.status) ? (blocked ? <Tag label="Waiting for another official" color={c.sunSoft} /> : <>
          <Btn small title="Approve" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/performances/${r.id}/approve`, {}), 'Result approved')} />
          <Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => setForm({ reject: r.id })} /></>) : null}
        {['approved', 'disputed'].includes(r.status) ? <Btn small title="Correct" color={c.paper} ink={c.ink} onPress={() => setForm({ correct: { id: r.id, unit: r.unit } })} /> : null}
      </>} />
    );
  };
  return (
    <Screen>
      <H1>Leaderboard</H1>
      <Seg options={[{ value: 'rank', label: 'Rankings', emoji: '🏆' }, { value: 'mine', label: 'My results', emoji: '📈' }, ...(isOfficial ? [{ value: 'approve', label: `Officials${todo.length ? ` (${todo.length})` : ''}`, emoji: '✅' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'rank' ? <>
        <SportSelect allLabel="All sports" value={sport} onChange={pickSport} />
        {categories.length ? <View accessibilityLabel="Sport category filter" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Chip label="All categories" active={category === null} onPress={() => { setCategory(null); setLim(25); }} />
          {categories.map((k) => <Chip key={k} label={k.replace(/_/g, ' ')} active={category === k} onPress={() => { setCategory(k); setLim(25); }} />)}
        </View> : null}
        <View accessibilityLabel="Season filter" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Chip label="All time" active={season === null} onPress={() => { setSeason(null); setLim(25); }} />
          {[0, 1, 2].map((k) => <Chip key={k} label={`${thisYear - k}`} active={season === thisYear - k} onPress={() => { setSeason(thisYear - k); setLim(25); }} />)}
        </View>
        {sport && rules.data?.metrics?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Chip label="Overall points" active={metric === null} onPress={() => setMetric(null)} />
          {rules.data.metrics.map((m) => <Chip key={m.metric} label={`${m.metric.replace(/_/g, ' ')}${m.rule.direction === 'lower' ? ' ↓' : ''}`} active={metric === m.metric} onPress={() => setMetric(m.metric)} />)}
        </View> : null}
        <T size={12} color={c.mute} style={{ marginTop: 8 }}>Only results approved by event officials count. Practice you log yourself never changes the rankings. {metric ? (lower ? 'Lowest time ranks first; equal times go to whoever achieved that time first.' : 'Highest value ranks first; equal values go to whoever achieved that value first.') : 'Ties go to the athlete with more approved results, then the one approved earliest.'}</T>
        <View style={{ gap: 10, marginTop: 10 }}>
          {lb.loading && !lb.data ? <Loading /> : lb.error ? <ErrorBox error={lb.error} onRetry={lb.reload} /> : lb.data?.length ? <>
            {lb.data.map((a) => (
              <Row key={a.id} color={a.rank === 1 ? c.sunSoft : c.paper} onPress={() => push('Person', { id: a.id })} left={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="900" size={20}>{a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : `#${a.rank}`}</T><Avatar user={a} size={40} /></View>}
                title={a.display_name} sub={`${a.entries} approved result${a.entries === 1 ? '' : 's'} · ${a.evidence_label}`} right={<Tag label={metric ? withUnit(a.best, metricRule?.unit ?? (lower ? 's' : 'count')) : `${a.points} pts`} color={c.lime} />} />
            ))}
            {lb.data.length >= lim ? <Btn title="Show more" color={c.paper} ink={c.ink} onPress={() => setLim(lim + 25)} /> : null}
          </> : <Empty emoji="📈" title="No approved results yet" sub={season || category || sport ? 'Nothing matches these filters. Try widening them.' : 'Results appear here once an event official approves them.'} />}
        </View>
      </> : null}
      {tab === 'mine' ? <View style={{ gap: 10, marginTop: 10 }}>
        <Btn title="Log practice" color={c.violet} onPress={() => setForm('practice')} />
        <T size={12} color={c.mute}>Practice is private to you and labelled as self-reported (or imported, with your evidence). Competition results are submitted by event officials and appear here once entered.</T>
        {mine.loading && !mine.data ? <Loading /> : mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : mine.data?.filter((r) => r.user_id === user.id).length ? mine.data.filter((r) => r.user_id === user.id).map((r) => (
          <ResultRow key={r.id} r={r} mine onHistory={setHistory} onAct={r.provenance === 'approved_competition' && ['approved', 'submitted'].includes(r.status) ? <Btn small title="Something's wrong" color={c.paper} ink={c.red} onPress={() => setForm({ dispute: r.id })} /> : null} />
        )) : <Empty emoji="📝" title="No results yet" sub="Log a practice session to start your history." />}
      </View> : null}
      {tab === 'approve' && isOfficial ? <View style={{ gap: 10, marginTop: 10 }}>
        <Btn title="Submit a result" color={c.pink} onPress={() => setForm('submit')} />
        <T size={12} color={c.mute}>A result needs a second official: you can’t approve or reject one you submitted, or your own. Disputed results are listed first and are not counted until decided.</T>
        <H2>Waiting for a decision</H2>
        {queue.loading && !queue.data ? <Loading /> : queue.error ? <ErrorBox error={queue.error} onRetry={queue.reload} /> : todo.length ? todo.map((r) => workRow(r)) : <Empty emoji="✅" title="Nothing waiting" sub="Submitted and disputed results that need a decision show up here." />}
        <H2>Results for an event</H2>
        {events.loading && !events.data ? <Loading /> : events.error ? <ErrorBox error={events.error} onRetry={events.reload} /> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(events.data ?? []).length ? events.data.map((e) => <Chip key={e.id} label={e.name} active={evFilter === e.id} onPress={() => setEvFilter(evFilter === e.id ? null : e.id)} />) : <T size={12} color={c.mute}>You have no events to manage results for.</T>}
        </View>}
        {evFilter ? (evResults.loading && !evResults.data ? <Loading /> : evResults.error ? <ErrorBox error={evResults.error} onRetry={evResults.reload} /> : evResults.data?.length ? evResults.data.map((r) => workRow(r)) : <Empty emoji="📈" title="No results for this event" sub="Submit the first one above." />) : null}
      </View> : null}
      {tab === 'approve' && !isOfficial ? <Empty emoji="🔒" title="Officials only" sub="Only event organisers, referees and admins can approve results." /> : null}
      <HistorySheet id={history} onClose={() => setHistory(null)} />
      <SubmitResultSheet visible={form === 'submit'} onClose={() => setForm(null)} events={events.data} onDone={refresh} />
      <FormSheet visible={form === 'practice'} onClose={() => setForm(null)} title="Log practice" submitLabel="Save practice"
        fields={[{ key: 'sport', label: 'Sport', type: 'sport' }, { key: 'metric', label: 'What did you measure?', hint: 'For example goals, assists or 100m_time_s' }, { key: 'value', label: 'Result', type: 'number', input: 'decimal', hint: 'Seconds for a time, metres for a distance, otherwise a count' }, { key: 'achieved_on', label: 'Date', type: 'date', optional: true, max: todayIso() },
          { key: 'imported', label: 'Imported from another app or device', type: 'switch', hint: 'Labelled as imported evidence. It still never changes official rankings.' },
          { key: 'evidence_ref', label: 'Evidence reference', hint: 'A link or an id from the source app', show: (v) => !!v.imported }]}
        onSubmit={async (v) => { await api.post('/performances', { sport: v.sport, metric: v.metric, value: Number(v.value), achieved_on: v.achieved_on || undefined, imported: v.imported || undefined, evidence_ref: v.imported ? v.evidence_ref : undefined }); setForm(null); toast(v.imported ? 'Imported result saved' : 'Practice saved'); mine.reload(); }} />
      <FormSheet visible={!!form?.reject} onClose={() => setForm(null)} title="Reject this result" submitLabel="Reject result" color={c.red}
        fields={[{ key: 'reason', label: 'Why is it being rejected?', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/performances/${form.reject}/reject`, { reason: v.reason }); setForm(null); toast('Result rejected'); refresh(); }} />
      <FormSheet visible={!!form?.dispute} onClose={() => setForm(null)} title="Report a problem with this result" submitLabel="Report problem" color={c.red}
        fields={[{ key: 'reason', label: 'What is wrong?', type: 'multiline', hint: 'The result stops counting in the rankings until an official has reviewed it.' }]}
        onSubmit={async (v) => { await api.post(`/performances/${form.dispute}/dispute`, { reason: v.reason }); setForm(null); toast('Reported — an official will review it'); refresh(); }} />
      <FormSheet visible={!!form?.correct} onClose={() => setForm(null)} title="Correct this result" submitLabel="Propose correction"
        fields={[{ key: 'value', label: `Corrected result (${unitName(form?.correct?.unit)})`, type: 'number', input: 'decimal', hint: 'The original keeps counting until a different official approves the correction.' }, { key: 'reason', label: 'Why is it being corrected?', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/performances/${form.correct.id}/correct`, { value: Number(v.value), reason: v.reason }); setForm(null); toast('Correction sent for approval'); refresh(); }} />
    </Screen>
  );
}

export function Awards() {
  const aw = useLoad(() => api.get('/awards', { limit: 100 }), []);
  const E = { cup: '🏆', trophy: '🏅', medal_gold: '🥇', medal_silver: '🥈', medal_bronze: '🥉', mvp: '🌟', badge: '🎖️' };
  return (
    <Screen>
      <ModuleHero name="Awards" title="Trophy room" sub="Cups, medals and MVPs" stats={[{ icon: 'Awards', value: aw.data?.length || null, label: 'Awards' }]} />
      <ModuleSheet><View style={{ gap: 10 }}>{aw.loading && !aw.data ? <Loading /> : aw.data?.length ? aw.data.map((a, i) => <Row key={a.id} color={[c.sunSoft, c.pinkSoft, c.cyanSoft][i % 3]} left={<Bubble emoji={E[a.kind]} color={c.paper} />} title={a.name} sub={`${a.team_name ?? a.display_name ?? ''}${a.event_name ? ' · ' + a.event_name : ''}`} />) : <Empty emoji="🏆" title="Nothing awarded yet" />}</View></ModuleSheet>
    </Screen>
  );
}

export function Health() {
  const { user, has, toast } = useSession();
  const [tab, setTab] = useState(has('athlete') ? 'recovery' : has('physio', 'doctor') ? 'practice' : 'find');
  const [paying, setPaying] = useState(null);
  const [fu, setFu] = useState(null);
  const [share, setShare] = useState(null);
  const [hist, setHist] = useState(null), [cancelA, setCancelA] = useState(null);
  const appts = useLoad(() => api.get('/appointments', { limit: 30 }), []);
  const recs = useLoad(() => api.get('/medical/records', { limit: 30 }), []);
  const visits = useLoad(() => api.get('/medical/encounters', { limit: 30 }), []);
  const isProv = has('physio', 'doctor') && !!user.roles?.some((r) => r === 'physio' || r === 'doctor');   // a platform admin is not a clinician
  const region = useLoad(() => api.get('/me/health/region'), []);
  const act = async (fn, msg) => { try { await fn(); toast(msg); appts.reload(); } catch (e) { toast('' + e.message); } };
  return (
    <Screen>
      <H1>Health</H1>
      <Card color={c.mintSoft} pad={12}><T weight="900">Consent-first medical privacy</T><T size={12} color={c.mute}>Notes are encrypted. Doctors and physios only see your records after you grant access — and every read is logged.</T></Card>
      {region.data && (!region.data.country || region.data.needs_notice) ? <Card color={c.sunSoft} pad={12} onPress={() => setTab('consent')} style={{ marginTop: 10 }}><T weight="900">{region.data.country ? 'The privacy rules changed — please read them' : 'Choose the country whose health-privacy rules apply to you'}</T><T size={12} color={c.mute}>Eleven countries are supported. It takes a minute and tells you your rights, deadlines and who can see what.</T><T size={12} weight="800" color={c.pink} style={{ marginTop: 6 }}>Open Privacy ›</T></Card> : null}
      {isProv ? <View style={{ marginTop: 10 }}><DoctorEntry /></View> : null}
      {isProv ? <View style={{ marginTop: 10 }}><ClinicalStatusCard /></View> : null}
      <View style={{ marginTop: 10 }}><Seg options={[...(has('athlete') ? [{ value: 'recovery', label: 'Recovery', emoji: '💚' }] : []), { value: 'find', label: 'Find a pro', emoji: '🔎' }, ...(isProv ? [{ value: 'practice', label: 'My practice', emoji: '🩺' }] : []), { value: 'rehab', label: 'My plans', emoji: '📝' }, { value: 'appts', label: 'Appointments', emoji: '📅' }, { value: 'records', label: 'My records', emoji: '📋' }, { value: 'file', label: 'My file', emoji: '🗂️' }, { value: 'followups', label: 'Follow-ups', emoji: '🗓️' }, { value: 'consent', label: 'Privacy', emoji: '🔒' }]} value={tab} onChange={setTab} color={c.mint} /></View>
      <View style={{ gap: 10, marginTop: 8 }}>
        {tab === 'recovery' && <RecoveryPanel />}
        {tab === 'find' && <ProviderSearch onBooked={() => { appts.reload(); setTab('appts'); }} />}
        {tab === 'practice' && isProv && <PracticePanel />}
        {tab === 'rehab' && <MyRehab />}
        {tab === 'consent' && <PrivacyHub onChanged={region.reload} />}
        {tab === 'consent' && <ConsentManager />}
        {tab === 'file' && <MyHealthFile />}
        {tab === 'followups' && <FollowupsPanel />}
        {tab === 'appts' && (appts.data?.length ? appts.data.map((a) => (
          <Card key={a.id}><T weight="900">{a.athlete_id === user.id ? `With ${a.provider_name}` : `Athlete: ${a.athlete_name}`}</T><T size={13} color={c.mute}>{when(a.starts_at)} · {a.duration_min} min</T>{a.reason ? <T size={13} style={{ marginTop: 4 }}>“{a.reason}”</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={a.status} color={a.status === 'confirmed' ? c.lime : c.sun} />{a.payment_status === 'unpaid' ? <Tag label="unpaid" color={c.orangeSoft} /> : a.payment_status === 'paid' ? <Tag label="paid" color={c.lime} /> : null}{a.source === 'external' ? <Tag label="external" color={c.cyanSoft} /> : null}
              {a.athlete_id === user.id && a.payment_status === 'unpaid' && a.status !== 'cancelled' ? <Btn small title={`Pay ${money(a.fee_cents)}`} color={c.pink} onPress={() => setPaying({ type: 'appointment', id: a.id, amount: a.fee_cents, currency: a.currency, label: `Appointment with ${a.provider_name}` })} /> : null}
              {a.provider_id === user.id && ['confirmed', 'completed'].includes(a.status) ? <Btn small title="Add follow-up" color={c.violet} onPress={() => setFu(a)} /> : null}
              {a.provider_id === user.id && a.status === 'requested' ? <Btn small title="Confirm" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/appointments/${a.id}`, { status: 'confirmed' }), 'Confirmed')} /> : null}
              {['requested', 'confirmed'].includes(a.status) ? <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setCancelA(a)} /> : null}
              <Btn small title="History" color={c.paper} ink={c.mute} accessibilityLabel="Show the history of this appointment" onPress={() => setHist(a.id)} />
              {a.provider_id === user.id && a.status === 'confirmed' && new Date(a.starts_at) <= new Date() ? <Btn small title="Complete" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/appointments/${a.id}`, { status: 'completed' }), 'Completed')} /> : null}
              {a.athlete_id === user.id && !['cancelled', 'completed'].includes(a.status) ? <>
                <Btn small title="Share records" color={c.violet} onPress={() => setShare({ id: a.provider_id, name: a.provider_name })} />
                <Btn small title="Revoke" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/medical/grants/${a.provider_id}`), 'Access revoked')} /></> : null}
            </View></Card>
        )) : <Empty emoji="📅" title="No appointments" />)}
        {tab === 'records' && visits.data?.filter((v) => v.status === 'signed' && v.visit_summary).map((v) => (
          <Card key={v.id}><Tag label="Visit summary" color={c.mint} />
            {v.visit_summary.problem ? <T weight="900" style={{ marginTop: 6 }}>{v.visit_summary.problem}</T> : null}
            {v.visit_summary.plan ? <T size={13} color={c.mute}>Plan: {v.visit_summary.plan}</T> : null}
            {v.visit_summary.actions ? <T size={13} color={c.mute}>What to do: {v.visit_summary.actions}</T> : null}
            {v.visit_summary.follow_up_date ? <T size={13} color={c.mute}>Follow-up: {v.visit_summary.follow_up_date}</T> : null}
            {v.visit_summary.escalation ? <T size={13} color={c.mute}>If it gets worse: {v.visit_summary.escalation}</T> : null}
            <T size={11} color={c.mute}>Dr {v.provider_name} · {day(v.signed_at)}</T>
            {v.patient_ack_at ? <T size={11} color={c.mute}>You marked this as read</T> : <Btn small title="Mark as read" color={c.mint} ink={c.ink} onPress={() => act(async () => { await api.post(`/medical/encounters/${v.id}/acknowledge`, {}); visits.reload(); }, 'Marked as read')} />}
          </Card>
        ))}
        {tab === 'records' && (recs.data?.length ? recs.data.map((r) => <Card key={r.id}><View style={{ flexDirection: 'row', gap: 8 }}><Tag label={r.kind} color={c.cyan} />{r.clearance ? <Tag label={r.clearance.replace('_', ' ')} color={r.clearance === 'cleared' ? c.lime : c.orange} /> : null}</View><T weight="900" style={{ marginTop: 6 }}>{r.summary}</T>{r.details ? <T size={13} color={c.mute}>{r.details}</T> : null}<T size={11} color={c.mute}>{r.provider_name} · {day(r.created_at)}</T></Card>) : <Empty emoji="📋" title="No records" sub="Records written by providers you've granted access appear here." />)}
      </View>
      {hist ? <TimelineSheet kind="appointment" id={hist} meId={user.id} title="Appointment history" onClose={() => setHist(null)} /> : null}
      <Confirm visible={!!cancelA} title="Cancel this appointment?" yes="Cancel appointment" danger askReason="Why are you cancelling?" onClose={() => setCancelA(null)}
        body={cancelA ? `${cancelA.athlete_id === user.id ? cancelA.provider_name : cancelA.athlete_name} will be told.${cancelA.payment_status === 'paid' ? ' The payment is refunded.' : ''}` : ''}
        onYes={async (reason) => { await act(() => api.patch(`/appointments/${cancelA.id}`, { status: 'cancelled', ...(reason ? { reason } : {}) }), cancelA.payment_status === 'paid' ? 'Cancelled — the payment is refunded' : 'Cancelled'); setCancelA(null); }} />
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={appts.reload} /> : null}
      <ShareRecordsSheet provider={share} onClose={() => setShare(null)} onDone={() => { appts.reload(); }} />
      <AddFollowupSheet appointment={fu} onClose={() => setFu(null)} onDone={() => { setFu(null); }} />
    </Screen>
  );
}

/** Athletes that colleges and academies introduced to the sponsor's brands (the athlete agreed to this). */
function Introductions({ brands, onOffer }) {
  const list = useLoad(async () => (await Promise.all(brands.map(async (b) => (await api.get(`/sponsors/${b.id}/introductions`, { status: 'introduced', limit: 50 })).map((x) => ({ ...x, brand: b.name }))))).flat(), [brands.map((b) => b.id).join()]);
  if (!list.data?.length) return null;
  return (
    <Section title="Introduced by institutions" color={c.mint}>
      {list.data.map((a) => (
        <Row key={a.id} left={<Avatar user={{ ...a, avatar_emoji: a.avatar_emoji, avatar_color: a.avatar_color }} />} title={a.display_name} sub={`${a.institution}${a.programme_title ? ` · ${a.programme_title}` : ''}${a.sport ? ` · ${a.sport}` : ''}${a.note ? `\n“${a.note}”` : ''}\nFor ${a.brand}`}
          right={<Btn small title="Send offer" onPress={() => onOffer(a)} />} />
      ))}
    </Section>
  );
}

// Brand owners and entity admins/portfolio managers act as managers; an entity viewer only reads.
const asSponsorRole = (r) => (['owner', 'admin', 'portfolio_manager'].includes(r) ? 'manager' : r === 'viewer' ? 'auditor' : r);


const BRAND_INDUSTRIES = ['Sports & fitness', 'Apparel & footwear', 'Food & beverage', 'Health & nutrition', 'Banking & finance', 'Insurance', 'Technology', 'Telecom', 'Automotive', 'Travel & hospitality', 'Media & entertainment', 'Retail & e-commerce', 'Education', 'Real estate', 'Energy'];
const BRAND_COLORS = [{ value: '#16a34a', label: 'Green' }, { value: '#2563eb', label: 'Blue' }, { value: '#7c3aed', label: 'Violet' }, { value: '#db2777', label: 'Pink' }, { value: '#dc2626', label: 'Red' }, { value: '#ea580c', label: 'Orange' }, { value: '#ca8a04', label: 'Gold' }, { value: '#0f766e', label: 'Teal' }, { value: '#111827', label: 'Black' }];
const BRAND_ICONS = ['💎', '🏆', '⚡', '🔥', '🌿', '🚀', '🎯', '🏅', '⭐', '🛡️'];
const OFFERS = [{ value: 'cash', label: 'Cash' }, { value: 'equipment', label: 'Equipment' }, { value: 'apparel', label: 'Apparel' }, { value: 'travel', label: 'Travel' }, { value: 'nutrition', label: 'Nutrition' }, { value: 'coaching', label: 'Coaching' }, { value: 'media', label: 'Media & promotion' }];
const BACKS = [{ value: 'athlete', label: 'Athletes' }, { value: 'team', label: 'Teams' }, { value: 'event', label: 'Events' }];
const BRAND_FIELDS = [
  { key: 's1', type: 'section', label: 'Identity' },
  { key: 'name', label: 'Brand name' },
  { key: 'tagline', label: 'Tagline', optional: true, hint: 'One line shown under your name, up to 120 characters.' },
  { key: 'emoji', label: 'Icon', type: 'chips', options: BRAND_ICONS, default: '💎' },
  { key: 'brand_color', label: 'Brand colour', type: 'chips', options: BRAND_COLORS, optional: true },
  { key: 'industry', label: 'Industry', type: 'chips', options: BRAND_INDUSTRIES, optional: true },
  { key: 'about', label: 'About the brand', type: 'multiline', optional: true, hint: 'What you do and why you sponsor sport. Shown publicly.' },
  { key: 'founded_year', label: 'Founded in', type: 'stepper', min: 1800, max: new Date().getFullYear(), default: new Date().getFullYear(), optional: true },
  { key: 'country', label: 'Country', type: 'country', optional: true },
  { key: 's2', type: 'section', label: 'What you sponsor' },
  { key: 'backs', label: 'Who you back', type: 'multi', options: BACKS, optional: true },
  { key: 'offers', label: 'What you can offer', type: 'multi', options: OFFERS, optional: true, hint: 'Athletes who are looking for these are matched to you.' },
  { key: 'sports', label: 'Sports you support', type: 'sports', optional: true, hint: 'Leave empty to back any sport.' },
  { key: 'regions', label: 'Cities and areas', type: 'regions', optional: true, hint: 'Leave empty to sponsor anywhere.' },
  { key: 'budget_currency', label: 'Budget currency', type: 'currency', default: 'INR' },
  { key: 'budget_min_cents', label: 'Yearly budget from', type: 'money', currency: (v) => v.budget_currency ?? 'INR', optional: true },
  { key: 'budget_max_cents', label: 'Yearly budget up to', type: 'money', currency: (v) => v.budget_currency ?? 'INR', optional: true, hint: 'Only your brand managers see the budget.' },
  { key: 's3', type: 'section', label: 'Online' },
  { key: 'website', label: 'Website', input: 'url', optional: true },
  { key: 'link_instagram', label: 'Instagram', input: 'url', optional: true },
  { key: 'link_linkedin', label: 'LinkedIn', input: 'url', optional: true },
  { key: 'link_x', label: 'X', input: 'url', optional: true },
  { key: 'link_youtube', label: 'YouTube', input: 'url', optional: true },
  { key: 's4', type: 'section', label: 'Private contact' },
  { key: 'contact_name', label: 'Contact person', optional: true },
  { key: 'contact_email', label: 'Contact email', input: 'email', optional: true, hint: 'Encrypted — never shown publicly.' },
  { key: 'contact_phone', label: 'Contact phone', input: 'phone', optional: true, hint: 'Encrypted — never shown publicly.' },
];
const LINK_KEYS = ['instagram', 'linkedin', 'x', 'youtube'];
const brandInitial = (b) => ({ ...b, ...Object.fromEntries(LINK_KEYS.map((k) => [`link_${k}`, b.links?.[k]])), budget_currency: b.budget_currency ?? 'INR' });
/** Form values -> API body. When editing, anything left empty is sent as null so it can be cleared. */
const brandBody = (v, editing) => {
  const { link_instagram, link_linkedin, link_x, link_youtube, ...rest } = v;
  const links = Object.fromEntries(Object.entries({ instagram: link_instagram, linkedin: link_linkedin, x: link_x, youtube: link_youtube }).filter(([, x]) => x));
  const body = { ...rest, links, ...Object.fromEntries(['sports', 'regions', 'offers', 'backs'].map((k) => [k, rest[k] ?? []])) };
  if (editing) for (const k of ['tagline', 'brand_color', 'industry', 'about', 'founded_year', 'country', 'website', 'contact_name', 'contact_email', 'contact_phone', 'budget_min_cents', 'budget_max_cents']) body[k] ??= null;
  if (body.budget_min_cents == null && body.budget_max_cents == null) delete body.budget_currency;
  for (const k of Object.keys(body)) if (body[k] === undefined || (body[k] === null && !editing)) delete body[k];
  return body;
};

export function Sponsors() {
  const { has, user, toast } = useSession();
  const { push } = useNav();
  const [form, setForm] = useState(null);
  const [offerTo, setOfferTo] = useState(null);
  const [editBrand, setEditBrand] = useState(null);
  const [q, setQ] = useState('');
  const dir = useLoad(() => api.get('/sponsors', { limit: 50 }), []);
  const mine = useLoad(() => api.get('/sponsors', { mine: true, limit: 50 }), []);
  const deals = useLoad(() => api.get('/sponsorships', { limit: 100 }), []);
  const evs = useLoad(() => api.get('/events', { limit: 50 }), []);
  // authorized budgets an offer can draw on (#293): one list per brand the person may read budgets of
  const budgets = useLoad(async () => {
    const bs = (mine.data ?? []).filter((b) => ['manager', 'finance', 'approver', 'auditor'].includes(b.my_role));
    const all = await Promise.all(bs.map((b) => api.get('/sponsorship-budgets', { sponsor_id: b.id, status: 'active', limit: 100 }).catch(() => [])));
    return all.flat().filter((x) => x.kind !== 'program');
  }, [mine.data]);
  const budgetOf = (id) => (budgets.data ?? []).find((x) => x.id === id);
  const profile = useLoad(() => api.get('/me/sponsorship-profile'), []);
  const athletes = useLoad(() => (has('sponsor') ? api.get('/sponsorable-athletes', { limit: 30, ...(q.trim() ? { q: q.trim() } : {}) }) : Promise.resolve([])), [q]);
  const act = async (fn, m) => { try { await fn(); toast(m); deals.reload(); } catch (e) { toast(explain(e)); if (e.status === 409) deals.reload(); } };
  const pr = profile.data;
  // my sponsor role per brand decides which deal buttons are offered (the server still enforces it)
  const roleOf = (sponsorId) => asSponsorRole((mine.data ?? []).find((b) => b.id === sponsorId)?.my_role);
  const mayDeal = (d, action) => !roleOf(d.sponsor_id) || { withdraw: ['manager', 'approver'], end: ['manager', 'approver'] }[action].includes(roleOf(d.sponsor_id));
  return (
    <Screen>
      <H1>Sponsors</H1>
      {has('sponsor') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}><Btn small title="Create brand" color={c.violet} onPress={() => setForm('brand')} /><Btn small title="Propose a deal" color={c.pink} onPress={() => setForm('deal')} /></View> : null}
      {has('sponsor') && (mine.data ?? []).length ? <BeneficiaryFinder brands={mine.data} onSent={deals.reload} /> : null}
      {has('athlete') ? (
        <Section title="Open to sponsors" color={c.mint}>
          <T size={13} color={c.mute}>Off by default. When you turn it on, sponsors can find your name, sports and pitch — never your contact details — and send you offers you can accept or decline.</T>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <Chip label={pr?.open_to_sponsors ? '✓ Open to offers' : 'Not open to offers'} active={!!pr?.open_to_sponsors} onPress={() => act(() => api.post('/me/sponsorship-profile', { open_to_sponsors: !pr?.open_to_sponsors }).then(profile.reload), pr?.open_to_sponsors ? 'Hidden from sponsors' : 'Sponsors can find you')} />
            <Btn small title="Edit pitch" color={c.violet} onPress={() => setForm('pitch')} />
          </View>
          {pr?.pitch ? <T size={13} style={{ marginTop: 6 }}>{pr.pitch}</T> : null}
          {pr?.verified_sponsors_only ? <T size={12} color={c.mute}>Only verified sponsors can send you offers.</T> : null}
        </Section>
      ) : null}
      <Section title="Funding programs" color={c.lime}>
        <T size={13} color={c.mute}>Sponsors run funding programs in rounds; athletes, teams and event organisers apply to the ones that are open. Awards become agreements here.</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <Btn small title="Sponsorship calls" color={c.pink} onPress={() => push('FundingOpportunities')} />
          <Btn small title="Beneficiary portfolio" color={c.violet} onPress={() => push('SponsorPortfolio')} />
          {mine.data?.length ? <Btn small title="Run programs" color={c.violet} onPress={() => push('SponsorPrograms')} /> : null}
          {mine.data?.some((b) => ['manager', 'finance', 'approver', 'auditor'].includes(b.my_role)) ? <Btn small title="Budgets" color={c.paper} ink={c.ink} onPress={() => push('SponsorBudgets')} /> : null}
        </View>
      </Section>
      <Section title="Your deals" color={c.sun}>
        {deals.data?.length ? deals.data.map((d) => (
          <Card key={d.id} color={c.sunSoft}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Bubble emoji={d.sponsor_emoji} color={c.paper} /><View style={{ flex: 1 }}><T weight="900">{d.sponsor_name}{d.sponsor_verified ? ' ✓' : ''} → {d.target_name ?? d.target_type}</T><T size={12} color={c.mute}>{[d.amount_cents ? money(d.amount_cents) : null, d.in_kind].filter(Boolean).join(' + ') || 'Support offered'}{d.starts_on ? ` · ${day(d.starts_on)} to ${d.ends_on ? day(d.ends_on) : 'open'}` : ''}</T></View><View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={d.status.replace('_', ' ')} color={d.status === 'active' ? c.lime : d.status === 'proposed' ? c.sunSoft : c.pinkSoft} />{d.program_id ? <Tag label="Funding award" color={c.mint} /> : null}</View></View>
            {d.objectives ? <T size={12} style={{ marginTop: 6 }}><T size={12} weight="800">Objectives: </T>{d.objectives}</T> : null}
            {d.deliverables ? <T size={12}><T size={12} weight="800">Deliverables: </T>{d.deliverables}</T> : null}
            {d.message ? <T size={12} color={c.mute}>“{d.message}”</T> : null}
            {d.decision_reason ? <T size={12} color={c.mute}>Reply: {d.decision_reason}</T> : null}
            {d.agreement_ref ? <Btn small title={`Open agreement ${d.agreement_ref}`} color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => push('SponsorDeal', { id: d.id })} /> : null}
            {d.status === 'proposed' && !d.i_am_sponsor ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Accept" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'active' }), 'Deal on!')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'declined' }), 'Declined')} />{d.target_type === 'athlete' ? <Btn small title="Accept & show on sponsor page" color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'active', show_publicly: true }), 'Deal on, shown publicly')} /> : null}</View> : null}
            {d.i_am_sponsor && d.budget_approval === 'pending' ? <T size={12} color={c.mute}>Waiting for budget approval — the recipient has not been told about this offer yet.</T> : null}
            {d.status === 'proposed' && d.i_am_sponsor && mayDeal(d, 'withdraw') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Withdraw offer" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsorships/${d.id}/withdraw`), 'Offer withdrawn')} /></View> : null}
            {['active', 'paused'].includes(d.status) && mayDeal(d, 'end') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="End deal" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'ended' }), 'Deal ended')} /></View> : null}
          </Card>
        )) : <Empty emoji="🤝" title="No deals yet" />}
      </Section>
      {has('sponsor') && mine.data?.length ? <Introductions brands={mine.data} onOffer={(a) => setOfferTo({ id: a.athlete_id, display_name: a.display_name })} /> : null}
      {has('sponsor') ? (
        <Section title="Athletes open to sponsors" color={c.cyan}>
          <Field value={q} onChangeText={setQ} placeholder="Search athletes by name or pitch…" />
          {athletes.loading && !athletes.data ? <Loading /> : athletes.error ? <ErrorBox error={athletes.error} onRetry={athletes.reload} /> : athletes.data?.length ? athletes.data.map((a) => (
            <Row key={a.id} left={<Avatar user={a} />} title={`${a.display_name}${a.verified?.length ? ' ✓' : ''}`} sub={[a.sports.join(', '), a.looking_for.join(', '), a.pitch].filter(Boolean).join(' · ')} right={<Btn small title="Offer" color={c.pink} onPress={() => setOfferTo(a)} />} />
          )) : <Empty emoji="🏅" title="No athletes found" sub="Athletes only appear here after they opt in." />}
        </Section>
      ) : null}
      <Section title="Your brands" color={c.violet}>
        {mine.error ? <LoadError error={mine.error} onRetry={mine.reload} /> : mine.loading && !mine.data ? <Loading /> : mine.data?.length ? mine.data.map((s) => (
          <Row key={s.id} left={<Bubble emoji={s.emoji} color={c.sun} />} title={s.name}
            sub={[s.tagline, s.industry, s.organisation_name ? `Run by ${s.organisation_name}` : 'Individual brand', asSponsorRole(s.my_role) !== 'manager' ? { evaluator: 'You evaluate and review; you cannot pay or sign', finance: 'You report payments; you cannot change terms', legal: 'You review and change terms; you cannot pay', approver: 'You propose, revise and withdraw; you cannot pay', auditor: 'Read-only, with exports' }[asSponsorRole(s.my_role)] : null].filter(Boolean).join(' · ')}
            right={<View style={{ alignItems: 'flex-end', gap: 6 }}><Tag label={{ manager: 'Manager', evaluator: 'Evaluator', finance: 'Finance', legal: 'Legal', approver: 'Approver', auditor: 'Auditor' }[asSponsorRole(s.my_role)] ?? 'Staff'} />
              {asSponsorRole(s.my_role) === 'manager' ? <Btn small title="Edit profile" color={c.violet} onPress={async () => { try { setEditBrand(await api.get(`/sponsors/${s.id}`)); } catch (e) { toast(explain(e)); } }} /> : null}
              {s.organisation_id ? <Btn small title="Open workspace" color={c.paper} ink={c.ink} onPress={() => push('Org', { id: s.organisation_id })} /> : asSponsorRole(s.my_role) === 'manager' && !s.identity_confirmed ? <Btn small title="Link to an organisation" color={c.paper} ink={c.ink} onPress={() => push('Orgs')} /> : null}</View>} />
        )) : <Empty emoji="🏷️" title="No brands yet" sub="Create a brand, or ask an organisation manager to invite you to theirs." />}
        <T size={12} color={c.mute}>Link a brand to an organisation (open it, then Teams, events, venues & brands) to let that organisation's staff work its deals under their roles; staff and departments are managed there.</T>
      </Section>
      <Section title="Brands" color={c.pink}>{dir.data?.map((s) => <Row key={s.id} left={<Bubble emoji={s.emoji} color={c.sun} />} title={s.name} sub={s.industry ?? s.website} />)}</Section>
      <FormSheet visible={form === 'brand'} onClose={() => setForm(null)} title="Create your brand" submitLabel="Create brand" fields={BRAND_FIELDS}
        onSubmit={async (v) => { await api.post('/sponsors', brandBody(v, false)); dir.reload(); mine.reload(); return 'Brand created — finish its profile any time from Your brands'; }} />
      <FormSheet visible={!!editBrand} onClose={() => setEditBrand(null)} title={`Edit ${editBrand?.name ?? 'brand'}`} fields={BRAND_FIELDS} initial={editBrand ? brandInitial(editBrand) : {}}
        onSubmit={async (v) => { await api.patch(`/sponsors/${editBrand.id}`, brandBody(v, true)); dir.reload(); mine.reload(); return 'Brand profile saved'; }} />
      <FormSheet visible={form === 'pitch'} onClose={() => setForm(null)} title="Your sponsor pitch" initial={{ pitch: pr?.pitch ?? '', looking_for: pr?.looking_for ?? [], verified_sponsors_only: !!pr?.verified_sponsors_only }}
        fields={[{ key: 'pitch', label: 'What should sponsors know about you?', type: 'multiline', optional: true, hint: 'Shown to sponsors. Do not include contact details.' }, { key: 'looking_for', label: 'What are you looking for?', type: 'multi', optional: true, options: ['cash', 'equipment', 'travel', 'coaching', 'apparel', 'nutrition', 'media'] }, { key: 'verified_sponsors_only', label: 'Only verified sponsors may send offers', type: 'switch' }]}
        onSubmit={async (v) => { await api.post('/me/sponsorship-profile', { open_to_sponsors: !!pr?.open_to_sponsors, pitch: v.pitch ?? null, looking_for: v.looking_for ?? [], verified_sponsors_only: v.verified_sponsors_only }); profile.reload(); return 'Saved'; }} />
      <FormSheet visible={form === 'deal'} onClose={() => setForm(null)} title="Propose sponsorship" submitLabel="Send offer"
        fields={[{ key: 'sponsor_id', label: 'Brand', type: 'choice', options: (mine.data ?? []).map((s) => ({ value: s.id, label: `${s.emoji} ${s.name}` })) }, { key: 'target_id', label: 'Event', type: 'choice', options: (evs.data ?? []).map((e) => ({ value: e.id, label: `${e.banner_emoji} ${e.name}` })) }, { key: 'amount', label: 'Amount (₹)', type: 'number' }, { key: 'in_kind', label: 'In-kind support', optional: true }]}
        onSubmit={async (v) => { await api.post('/sponsorships', { sponsor_id: v.sponsor_id, target_type: 'event', target_id: v.target_id, amount_cents: Math.round(v.amount * 100), in_kind: v.in_kind }); deals.reload(); return 'Offer sent'; }} />
      <FormSheet visible={!!offerTo} onClose={() => setOfferTo(null)} title={`Offer to ${offerTo?.display_name ?? ''}`} submitLabel="Send offer"
        fields={[{ key: 'sponsor_id', label: 'Brand', type: 'choice', options: (mine.data ?? []).map((s) => ({ value: s.id, label: `${s.emoji} ${s.name}` })) },
          { key: 'amount', label: 'Amount (₹, 0 if only in-kind)', type: 'number' }, { key: 'in_kind', label: 'In-kind support', optional: true },
          { key: 'starts_on', label: 'Starts', type: 'date' }, { key: 'ends_on', label: 'Ends', type: 'date' },
          { key: 'sec', type: 'section', label: 'Fixed-term monthly support (optional)' },
          { key: 'instalments', label: 'Monthly payments (0 = none)', type: 'stepper', min: 0, max: 36, default: 0 },
          { key: 'budget_id', label: 'Draw on a budget', type: 'chips', optional: true, hint: 'Optional. The offer is then limited by what that budget has authorized, and the payments use its currency.', options: (v) => (budgets.data ?? []).filter((x) => x.sponsor_id === v.sponsor_id).map((x) => ({ value: x.id, label: `${x.name} (${fmtBudget(x.available_cents, x.currency)} free)` })), show: (v) => v.instalments > 0 && (budgets.data ?? []).some((x) => x.sponsor_id === v.sponsor_id) },
          { key: 'currency', label: 'Currency', type: 'chips', options: ['INR', 'SGD', 'USD', 'EUR', 'GBP', 'AED'], default: 'INR', show: (v) => v.instalments > 0 && !v.budget_id }, { key: 'monthly_cents', label: 'Each month', type: 'money', currency: (v) => budgetOf(v.budget_id)?.currency ?? v.currency ?? 'INR', show: (v) => v.instalments > 0 }, { key: 'first_due_on', label: 'First payment due', type: 'date', show: (v) => v.instalments > 0 },
          { key: 'objectives', label: 'Objectives', type: 'multiline', optional: true }, { key: 'deliverables', label: 'What you expect from the athlete', type: 'multiline' }, { key: 'message', label: 'Personal message', type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          const { instalments, currency, monthly_cents, first_due_on, sec, ...rest } = v;
          const lines = instalments > 0 ? [{ kind: 'money', label: 'Monthly support', currency: budgetOf(v.budget_id)?.currency ?? currency, amount_cents: monthly_cents, cadence: 'monthly', first_due_on, instalments }] : undefined;
          const sent = await api.post('/sponsorships', { target_type: 'athlete', target_id: offerTo.id, ...rest, budget_id: lines ? v.budget_id : undefined, amount_cents: Math.round((v.amount ?? 0) * 100), amount: undefined, lines }); deals.reload();
          return sent.budget_approval === 'pending' ? 'Saved — it is above the budget threshold, so a second approver must approve it before the athlete is told' : 'Offer sent — they will be notified';
        }} />
    </Screen>
  );
}

export function Supply() {
  const { toast } = useSession();
  const [form, setForm] = useState(null);
  const inv = useLoad(() => api.get('/inventory', { limit: 100 }), []);
  const ord = useLoad(() => api.get('/supply-orders', { limit: 50 }), []);
  const act = async (fn, m) => { try { await fn(); inv.reload(); ord.reload(); if (m) toast(m); } catch (e) { toast('' + e.message); } };
  return (
    <Screen>
      <H1>Supply chain</H1>
      <Btn small title="Add stock item" color={c.orange} onPress={() => setForm('item')} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
      <Section title="Inventory" color={c.orange}>
        {inv.data?.length ? inv.data.map((i) => (
          <Card key={i.id} color={i.low_stock ? c.orangeSoft : c.paper} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}><T weight="900">{i.name}</T><T size={12} color={c.mute}>{i.category} · reorder at {i.reorder_level}</T>{i.low_stock ? <Tag label="low stock" color={c.red} ink="#fff" style={{ marginTop: 4 }} /> : null}</View>
              <Btn small title="−" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/inventory/${i.id}/adjust`, { delta: -1 }))} />
              <T weight="900" size={20} style={{ minWidth: 34, textAlign: 'center' }}>{i.quantity}</T>
              <Btn small title="+" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/inventory/${i.id}/adjust`, { delta: 1 }))} />
            </View>
            {i.low_stock ? <Btn small title="Reorder" color={c.ink} onPress={() => setForm({ order: i })} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
          </Card>
        )) : <Empty emoji="📦" title="No stock tracked" />}
      </Section>
      <Section title="Orders" color={c.cyan}>
        {ord.data?.length ? ord.data.map((o) => (
          <Row key={o.id} left={<Bubble emoji="🚚" color={c.cyanSoft} />} title={`${o.quantity} × ${o.item_name}`} sub={`${o.supplier}${o.expected_on ? ' · by ' + day(o.expected_on) : ''}`}
            right={o.status === 'ordered' || o.status === 'shipped' ? <Btn small title="Received" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/supply-orders/${o.id}`, { status: 'received' }), 'Stock updated')} /> : <Tag label={o.status} color={c.lime} />} />
        )) : <Empty emoji="🚚" title="No orders" />}
      </Section>
      <FormSheet visible={form === 'item'} onClose={() => setForm(null)} title="Add stock" fields={[{ key: 'name', label: 'Item' }, { key: 'category', label: 'Category', type: 'choice', options: ['equipment', 'apparel', 'nutrition', 'medical', 'merch', 'other'] }, { key: 'quantity', label: 'Quantity', type: 'number' }, { key: 'reorder_level', label: 'Reorder at', type: 'number', optional: true }]}
        onSubmit={async (v) => { await api.post('/inventory', v); inv.reload(); return 'Added'; }} />
      <FormSheet visible={!!form?.order} onClose={() => setForm(null)} title={`Reorder ${form?.order?.name ?? ''}`} fields={[{ key: 'supplier', label: 'Supplier' }, { key: 'quantity', label: 'Quantity', type: 'number' }]}
        onSubmit={async (v) => { await api.post('/supply-orders', { item_id: form.order.id, ...v }); ord.reload(); return 'Order placed'; }} />
    </Screen>
  );
}
