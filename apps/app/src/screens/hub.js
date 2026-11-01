import React, { useEffect, useRef, useState } from 'react';
import { YouthAuthorizations } from './sponsor-youth';
import { HandOverBrand } from './sponsor-ownership';
import { asSponsorRole, SPONSOR_ROLE_LABEL } from '../sponsor-roles';
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
import { WellnessSharing } from './wellness-sharing';
import { DoctorEntry } from './doctor';
import { money as curMoney } from '../offer-lines';
import { MyHealthFile } from './health-file';
import { StreaksPanel } from './streaks';
import { RankingsPanel } from './rankings';
import { c, grad, money, day, when, withUnit } from '../theme';
import { t, tEnum } from '../i18n';

const STATUS_TAG = { recorded: [t('hub.st_private'), null], submitted: [t('hub.st_submitted'), 'sun'], approved: [t('hub.step_approved'), 'lime'], disputed: [t('hub.st_disputed'), 'orangeSoft'], rejected: [t('hub.step_rejected'), 'orangeSoft'], superseded: [t('hub.st_superseded'), 'cyanSoft'] };
const STEP = { submitted: t('hub.step_submitted'), approved: t('hub.step_approved'), rejected: t('hub.step_rejected'), disputed: t('hub.step_disputed'), corrected: t('hub.step_corrected'), superseded: t('hub.st_superseded') };
const unitLabel = (u) => (u === 's' ? t('hub.unit_seconds') : u === 'm' ? t('hub.unit_metres') : t('hub.unit_count'));
/** The scoring rule for the chosen metric, as one readable hint. */
const ruleHint = (d) => {
  const r = d?.rule;
  if (!r) return undefined;
  const std = d.standard && (d.standard.min_value !== r.min || d.standard.max_value !== r.max) ? ` ${t('hub.std_range', { min: d.standard.min_value, max: d.standard.max_value })}` : '';
  return `${r.direction === 'lower' ? t('hub.lower_better') : t('hub.higher_better')} ${t('hub.allowed', { min: r.min, max: r.max })} ${t('hub.rule_ver', { v: r.version })}${r.governed ? ` (${t('hub.governed')})` : ''}.${std}`;
};
const thisYear = new Date().getFullYear();
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const fixtureLabel = (f) => `${t('hub.vs', { home: f.home_name ?? t('hub.tbc'), away: f.away_name ?? t('hub.tbc') })} · ${day(f.scheduled_at)}`;

function ResultRow({ r, mine, onAct, onHistory }) {
  const [label, tone] = STATUS_TAG[r.status] ?? [r.status, null];
  const official = r.provenance === 'approved_competition';
  return (
    <Card>
      <T weight="900">{r.emoji} {r.metric.replace(/_/g, ' ')} · {withUnit(r.value, r.unit)}</T>
      <T size={12} color={c.mute}>{mine ? '' : `${r.display_name} · `}{r.event_name ? `${r.event_name} · ` : ''}{day(r.achieved_on)}{official && r.official_points != null ? ` · ${t('hub.official_pts', { n: r.official_points })}` : ''}</T>
      {r.decision_note && ['disputed', 'rejected'].includes(r.status) ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('hub.reason_line', { text: r.decision_note })}</T> : null}
      {r.evidence_ref ? <T size={12} color={c.mute} numberOfLines={1}>{t('hub.evidence_line', { text: r.evidence_ref })}</T> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
        <Tag label={r.evidence_label} color={official ? c.mintSoft : c.violetSoft} />
        {tone ? <Tag label={label} color={c[tone]} /> : null}
        {onAct}
        {official && onHistory ? <Btn small title={t('hub.history')} color={c.paper} ink={c.ink} onPress={() => onHistory(r.id)} /> : null}
      </View>
    </Card>
  );
}

/** Every step a result went through, with who and why. */
function HistorySheet({ id, onClose }) {
  const h = useLoad(() => (id ? api.get(`/performances/${id}/history`) : Promise.resolve([])), [id]);
  return (
    <Sheet visible={!!id} onClose={onClose} title={t('hub.result_history')}>
      {h.loading && !h.data ? <Loading /> : h.error ? <ErrorBox error={h.error} onRetry={h.reload} /> : h.data?.length ? h.data.map((l) => (
        <Card key={l.id}>
          <T weight="800">{STEP[l.action] ?? l.action}</T>
          <T size={12} color={c.mute}>{l.actor} · {when(l.at)}</T>
          {l.note ? <T size={13} style={{ marginTop: 4 }}>{l.note}</T> : null}
          {l.snapshot?.value !== undefined ? <T size={12} color={c.mute}>{t('hub.recorded_value', { v: l.snapshot.value })}{l.snapshot.official_points != null ? ` · ${t('hub.official_pts', { n: l.snapshot.official_points })}` : ''}</T> : null}
        </Card>
      )) : <Empty emoji="🕘" title={t('hub.no_history')} sub={t('hub.no_history_sub')} />}
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
    if (!eventId) return setErr(t('hub.err_event'));
    if (!sport) return setErr(t('hub.err_sport'));
    if (!athlete.length) return setErr(t('hub.err_athlete'));
    if (!metric?.trim()) return setErr(t('hub.err_metric'));
    if (value === '' || !Number.isFinite(n)) return setErr(t('hub.err_number'));
    setBusy(true);
    try {
      await api.post('/performances', { user_id: athlete[0].id, sport, metric: metric.trim(), value: n, event_id: eventId, fixture_id: fixtureId ?? undefined, achieved_on: date || undefined, evidence_ref: evidence.trim() || undefined, client_key: key.current });
      key.current = newKey();
      setValue(''); setAthlete([]); setEvidence('');
      toast(t('hub.submitted_toast'));
      onDone(); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('hub.submit_title')}>
      {!events?.length ? <Empty emoji="🗓️" title={t('hub.no_events_submit')} sub={t('hub.no_events_submit_sub')} /> : <>
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>{t('hub.event')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{events.map((e) => <Chip key={e.id} label={e.name} active={e.id === eventId} onPress={() => pickEvent(e)} />)}</View>
        </View>
        {eventId ? <View style={{ gap: 6 }}>
          <T weight="800" size={13}>{t('hub.game_optional')}</T>
          {fixtures.loading && !fixtures.data ? <Loading /> : fixtures.error ? <ErrorBox error={fixtures.error} onRetry={fixtures.reload} /> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Chip label={t('hub.whole_event')} active={fixtureId === null} onPress={() => setFixtureId(null)} />
            {(fixtures.data ?? []).map((f) => <Chip key={f.id} label={fixtureLabel(f)} active={f.id === fixtureId} onPress={() => setFixtureId(f.id)} />)}
          </View>}
        </View> : null}
        <SportPicker label={t('cs.sport')} value={sport} onChange={(s) => { setSport(s); setMetric(null); setOther(false); }} />
        <EntityPicker kind="person" label={t('cs.aud_athlete')} value={athlete} onChange={setAthlete} sport={sport ?? undefined} />
        {sport ? <View style={{ gap: 6 }}>
          <T weight="800" size={13}>{t('hub.measured')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(known.data?.metrics ?? []).map((m) => <Chip key={m.metric} label={m.metric.replace(/_/g, ' ')} active={!other && metric === m.metric} onPress={() => { setOther(false); setMetric(m.metric); }} />)}
            <Chip label={t('hub.another_metric')} active={other} onPress={() => { setOther(true); setMetric(''); }} />
          </View>
          {other ? <Field label={t('hub.metric_name')} value={metric ?? ''} onChangeText={setMetric} placeholder={t('hub.metric_ph')} hint={t('hub.metric_hint')} /> : null}
        </View> : null}
        <Field label={unit ? t('hub.result_unit', { unit: unitLabel(unit) }) : t('hub.result')} value={value} onChangeText={(x) => setValue(x.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" hint={ruleHint(rule.data)} />
        <DateField label={t('hub.date_achieved')} value={date} onChange={setDate} max={todayIso()} />
        <Field label={t('hub.evidence_opt')} value={evidence} onChangeText={setEvidence} placeholder={t('hub.evidence_ph')} />
        {err ? <T color={c.red} weight="800" accessibilityRole="alert">{err}</T> : null}
        <Btn title={t('hub.submit_result')} color={c.pink} loading={busy} onPress={submit} />
      </>}
    </Sheet>
  );
}

export function Leaderboard() {
  const { push } = useNav();
  const { user, has, toast } = useSession();
  const [tab, setTab] = useState('rank');
  const [view, setView] = useState('governed'); // governed rankings (scope, formula, sample, why) or the plain official-points table
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
        {['submitted', 'disputed'].includes(r.status) ? (blocked ? <Tag label={t('hub.waiting_other')} color={c.sunSoft} /> : <>
          <Btn small title={t('enum.approve')} color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/performances/${r.id}/approve`, {}), t('hub.result_approved'))} />
          <Btn small title={t('enum.reject')} color={c.paper} ink={c.red} onPress={() => setForm({ reject: r.id })} /></>) : null}
        {['approved', 'disputed'].includes(r.status) ? <Btn small title={t('hub.correct')} color={c.paper} ink={c.ink} onPress={() => setForm({ correct: { id: r.id, unit: r.unit } })} /> : null}
      </>} />
    );
  };
  return (
    <Screen>
      <H1>{t('nav.title.Leaderboard')}</H1>
      <Seg options={[{ value: 'rank', label: t('hub.tab_rankings'), emoji: '🏆' }, { value: 'mine', label: t('hub.tab_mine'), emoji: '📈' }, { value: 'streaks', label: t('hub.tab_streaks'), emoji: '🔥' }, ...(isOfficial ? [{ value: 'approve', label: `${t('hub.tab_officials')}${todo.length ? ` (${todo.length})` : ''}`, emoji: '✅' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'rank' ? <>
        <SportSelect allLabel={t('cs.all_sports')} value={sport} onChange={pickSport} />
        <View style={{ marginTop: 8 }}><Seg options={[{ value: 'governed', label: t('hub.by_formula'), emoji: '🏅' }, { value: 'points', label: t('hub.official_points'), emoji: '🔢' }]} value={view} onChange={setView} /></View>
        {view === 'governed' ? <RankingsPanel sport={sport} sports={sports.data} onOfficial={() => setView('points')} /> : null}
      </> : null}
      {tab === 'streaks' ? <StreaksPanel sports={sports.data} /> : null}
      {tab === 'rank' && view === 'points' ? <>
        {categories.length ? <View accessibilityLabel={t('hub.a11y_category')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Chip label={t('hub.all_categories')} active={category === null} onPress={() => { setCategory(null); setLim(25); }} />
          {categories.map((k) => <Chip key={k} label={k.replace(/_/g, ' ')} active={category === k} onPress={() => { setCategory(k); setLim(25); }} />)}
        </View> : null}
        <View accessibilityLabel={t('hub.a11y_season')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Chip label={t('hub.all_time')} active={season === null} onPress={() => { setSeason(null); setLim(25); }} />
          {[0, 1, 2].map((k) => <Chip key={k} label={`${thisYear - k}`} active={season === thisYear - k} onPress={() => { setSeason(thisYear - k); setLim(25); }} />)}
        </View>
        {sport && rules.data?.metrics?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Chip label={t('hub.overall_points')} active={metric === null} onPress={() => setMetric(null)} />
          {rules.data.metrics.map((m) => <Chip key={m.metric} label={`${m.metric.replace(/_/g, ' ')}${m.rule.direction === 'lower' ? ' ↓' : ''}`} active={metric === m.metric} onPress={() => setMetric(m.metric)} />)}
        </View> : null}
        <T size={12} color={c.mute} style={{ marginTop: 8 }}>{t('hub.rank_note')} {metric ? (lower ? t('hub.tie_lower') : t('hub.tie_higher')) : t('hub.tie_default')}</T>
        <View style={{ gap: 10, marginTop: 10 }}>
          {lb.loading && !lb.data ? <Loading /> : lb.error ? <ErrorBox error={lb.error} onRetry={lb.reload} /> : lb.data?.length ? <>
            {lb.data.map((a) => (
              <Row key={a.id} color={a.rank === 1 ? c.sunSoft : c.paper} onPress={() => push('Person', { id: a.id })} left={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="900" size={20}>{a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : `#${a.rank}`}</T><Avatar user={a} size={40} /></View>}
                title={a.display_name} sub={a.entries === 1 ? t('hub.approved_one', { n: a.entries, label: a.evidence_label }) : t('hub.approved_many', { n: a.entries, label: a.evidence_label })} right={<Tag label={metric ? withUnit(a.best, metricRule?.unit ?? (lower ? 's' : 'count')) : t('hub.pts', { n: a.points })} color={c.lime} />} />
            ))}
            {lb.data.length >= lim ? <Btn title={t('hub.show_more')} color={c.paper} ink={c.ink} onPress={() => setLim(lim + 25)} /> : null}
          </> : <Empty emoji="📈" title={t('hub.no_approved')} sub={season || category || sport ? t('hub.no_match_filters') : t('hub.results_appear')} />}
        </View>
      </> : null}
      {tab === 'mine' ? <View style={{ gap: 10, marginTop: 10 }}>
        <Btn title={t('hub.log_practice')} color={c.violet} onPress={() => setForm('practice')} />
        <T size={12} color={c.mute}>{t('hub.practice_note')}</T>
        {mine.loading && !mine.data ? <Loading /> : mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : mine.data?.filter((r) => r.user_id === user.id).length ? mine.data.filter((r) => r.user_id === user.id).map((r) => (
          <ResultRow key={r.id} r={r} mine onHistory={setHistory} onAct={r.provenance === 'approved_competition' && ['approved', 'submitted'].includes(r.status) ? <Btn small title={t('hub.somethings_wrong')} color={c.paper} ink={c.red} onPress={() => setForm({ dispute: r.id })} /> : null} />
        )) : <Empty emoji="📝" title={t('hub.no_results')} sub={t('hub.no_results_sub')} />}
      </View> : null}
      {tab === 'approve' && isOfficial ? <View style={{ gap: 10, marginTop: 10 }}>
        <Btn title={t('hub.submit_a_result')} color={c.pink} onPress={() => setForm('submit')} />
        <T size={12} color={c.mute}>{t('hub.second_official_note')}</T>
        <H2>{t('hub.waiting_decision')}</H2>
        {queue.loading && !queue.data ? <Loading /> : queue.error ? <ErrorBox error={queue.error} onRetry={queue.reload} /> : todo.length ? todo.map((r) => workRow(r)) : <Empty emoji="✅" title={t('hub.nothing_waiting')} sub={t('hub.nothing_waiting_sub')} />}
        <H2>{t('hub.results_for_event')}</H2>
        {events.loading && !events.data ? <Loading /> : events.error ? <ErrorBox error={events.error} onRetry={events.reload} /> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(events.data ?? []).length ? events.data.map((e) => <Chip key={e.id} label={e.name} active={evFilter === e.id} onPress={() => setEvFilter(evFilter === e.id ? null : e.id)} />) : <T size={12} color={c.mute}>{t('hub.no_events_manage')}</T>}
        </View>}
        {evFilter ? (evResults.loading && !evResults.data ? <Loading /> : evResults.error ? <ErrorBox error={evResults.error} onRetry={evResults.reload} /> : evResults.data?.length ? evResults.data.map((r) => workRow(r)) : <Empty emoji="📈" title={t('hub.no_results_event')} sub={t('hub.no_results_event_sub')} />) : null}
      </View> : null}
      {tab === 'approve' && !isOfficial ? <Empty emoji="🔒" title={t('hub.officials_only')} sub={t('hub.officials_only_sub')} /> : null}
      <HistorySheet id={history} onClose={() => setHistory(null)} />
      <SubmitResultSheet visible={form === 'submit'} onClose={() => setForm(null)} events={events.data} onDone={refresh} />
      <FormSheet visible={form === 'practice'} onClose={() => setForm(null)} title={t('hub.log_practice')} submitLabel={t('hub.save_practice')}
        fields={[{ key: 'sport', label: t('cs.sport'), type: 'sport' }, { key: 'metric', label: t('hub.measure_q'), hint: t('hub.measure_hint') }, { key: 'value', label: t('hub.result'), type: 'number', input: 'decimal', hint: t('hub.result_hint') }, { key: 'achieved_on', label: t('cs.date'), type: 'date', optional: true, max: todayIso() },
          { key: 'imported', label: t('hub.imported'), type: 'switch', hint: t('hub.imported_hint') },
          { key: 'evidence_ref', label: t('hub.evidence_ref'), hint: t('hub.evidence_ref_hint'), show: (v) => !!v.imported }]}
        onSubmit={async (v) => { await api.post('/performances', { sport: v.sport, metric: v.metric, value: Number(v.value), achieved_on: v.achieved_on || undefined, imported: v.imported || undefined, evidence_ref: v.imported ? v.evidence_ref : undefined }); setForm(null); toast(v.imported ? t('hub.imported_saved') : t('hub.practice_saved')); mine.reload(); }} />
      <FormSheet visible={!!form?.reject} onClose={() => setForm(null)} title={t('hub.reject_title')} submitLabel={t('hub.reject_submit')} color={c.red}
        fields={[{ key: 'reason', label: t('hub.reject_why'), type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/performances/${form.reject}/reject`, { reason: v.reason }); setForm(null); toast(t('hub.rejected_toast')); refresh(); }} />
      <FormSheet visible={!!form?.dispute} onClose={() => setForm(null)} title={t('hub.dispute_title')} submitLabel={t('hub.dispute_submit')} color={c.red}
        fields={[{ key: 'reason', label: t('hub.dispute_what'), type: 'multiline', hint: t('hub.dispute_hint') }]}
        onSubmit={async (v) => { await api.post(`/performances/${form.dispute}/dispute`, { reason: v.reason }); setForm(null); toast(t('hub.dispute_toast')); refresh(); }} />
      <FormSheet visible={!!form?.correct} onClose={() => setForm(null)} title={t('hub.correct_title')} submitLabel={t('hub.correct_submit')}
        fields={[{ key: 'value', label: t('hub.corrected_result', { unit: unitLabel(form?.correct?.unit) }), type: 'number', input: 'decimal', hint: t('hub.correct_hint') }, { key: 'reason', label: t('hub.correct_why'), type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/performances/${form.correct.id}/correct`, { value: Number(v.value), reason: v.reason }); setForm(null); toast(t('hub.correct_toast')); refresh(); }} />
    </Screen>
  );
}

export function Awards() {
  const aw = useLoad(() => api.get('/awards', { limit: 100 }), []);
  const E = { cup: '🏆', trophy: '🏅', medal_gold: '🥇', medal_silver: '🥈', medal_bronze: '🥉', mvp: '🌟', badge: '🎖️' };
  return (
    <Screen>
      <ModuleHero name="Awards" title={t('hub.trophy_room')} sub={t('hub.trophy_sub')} stats={[{ icon: 'Awards', value: aw.data?.length || null, label: t('rd.awards') }]} />
      <ModuleSheet><View style={{ gap: 10 }}>{aw.loading && !aw.data ? <Loading /> : aw.data?.length ? aw.data.map((a, i) => <Row key={a.id} color={[c.sunSoft, c.pinkSoft, c.cyanSoft][i % 3]} left={<Bubble emoji={E[a.kind]} color={c.paper} />} title={a.name} sub={`${a.team_name ?? a.display_name ?? ''}${a.event_name ? ' · ' + a.event_name : ''}`} />) : <Empty emoji="🏆" title={t('hub.nothing_awarded')} />}</View></ModuleSheet>
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
      <H1>{t('nav.title.Health')}</H1>
      <Card color={c.mintSoft} pad={12}><T weight="900">{t('hub.privacy_card_title')}</T><T size={12} color={c.mute}>{t('hub.privacy_card_sub')}</T></Card>
      {region.data && (!region.data.country || region.data.needs_notice) ? <Card color={c.sunSoft} pad={12} onPress={() => setTab('consent')} style={{ marginTop: 10 }}><T weight="900">{region.data.country ? t('hub.privacy_changed') : t('hub.privacy_choose')}</T><T size={12} color={c.mute}>{t('hub.privacy_eleven')}</T><T size={12} weight="800" color={c.pink} style={{ marginTop: 6 }}>{t('hub.open_privacy')}</T></Card> : null}
      {isProv ? <View style={{ marginTop: 10 }}><DoctorEntry /></View> : null}
      {isProv ? <View style={{ marginTop: 10 }}><ClinicalStatusCard /></View> : null}
      <View style={{ marginTop: 10 }}><Seg options={[...(has('athlete') ? [{ value: 'recovery', label: t('enum.recovery'), emoji: '💚' }] : []), { value: 'find', label: t('hub.h_find'), emoji: '🔎' }, ...(isProv ? [{ value: 'practice', label: t('hub.h_practice'), emoji: '🩺' }] : []), { value: 'rehab', label: t('hub.h_plans'), emoji: '📝' }, { value: 'appts', label: t('hub.h_appts'), emoji: '📅' }, { value: 'records', label: t('hub.h_records'), emoji: '📋' }, { value: 'file', label: t('hub.h_file'), emoji: '🗂️' }, { value: 'followups', label: t('hub.h_followups'), emoji: '🗓️' }, { value: 'consent', label: t('hub.h_privacy'), emoji: '🔒' }]} value={tab} onChange={setTab} color={c.mint} /></View>
      <View style={{ gap: 10, marginTop: 8 }}>
        {tab === 'recovery' && <><RecoveryPanel /><WellnessSharing /></>}
        {tab === 'find' && <ProviderSearch onBooked={() => { appts.reload(); setTab('appts'); }} />}
        {tab === 'practice' && isProv && <PracticePanel />}
        {tab === 'rehab' && <MyRehab />}
        {tab === 'consent' && <PrivacyHub onChanged={region.reload} />}
        {tab === 'consent' && <ConsentManager />}
        {tab === 'file' && <MyHealthFile />}
        {tab === 'followups' && <FollowupsPanel />}
        {tab === 'appts' && (appts.data?.length ? appts.data.map((a) => (
          <Card key={a.id}><T weight="900">{a.athlete_id === user.id ? t('hub.with_provider', { name: a.provider_name }) : t('hub.athlete_name', { name: a.athlete_name })}</T><T size={13} color={c.mute}>{when(a.starts_at)} · {t('hub.n_min', { n: a.duration_min })}</T>{a.reason ? <T size={13} style={{ marginTop: 4 }}>“{a.reason}”</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={tEnum(a.status)} color={a.status === 'confirmed' ? c.lime : c.sun} />{a.payment_status === 'unpaid' ? <Tag label={tEnum('unpaid')} color={c.orangeSoft} /> : a.payment_status === 'paid' ? <Tag label={tEnum('paid')} color={c.lime} /> : null}{a.source === 'external' ? <Tag label={tEnum('external')} color={c.cyanSoft} /> : null}
              {a.athlete_id === user.id && a.payment_status === 'unpaid' && a.status !== 'cancelled' ? <Btn small title={t('hub.pay', { amount: money(a.fee_cents, a.currency) })} color={c.pink} onPress={() => setPaying({ type: 'appointment', id: a.id, amount: a.fee_cents, currency: a.currency, label: t('hub.appt_with', { name: a.provider_name }) })} /> : null}
              {a.provider_id === user.id && ['confirmed', 'completed'].includes(a.status) ? <Btn small title={t('hub.add_followup')} color={c.violet} onPress={() => setFu(a)} /> : null}
              {a.provider_id === user.id && a.status === 'requested' ? <Btn small title={t('enum.confirm')} color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/appointments/${a.id}`, { status: 'confirmed' }), t('hub.confirmed'))} /> : null}
              {['requested', 'confirmed'].includes(a.status) ? <Btn small title={t('common.cancel')} color={c.paper} ink={c.red} onPress={() => setCancelA(a)} /> : null}
              <Btn small title={t('hub.history')} color={c.paper} ink={c.mute} accessibilityLabel={t('hub.a11y_appt_history')} onPress={() => setHist(a.id)} />
              {a.provider_id === user.id && a.status === 'confirmed' && new Date(a.starts_at) <= new Date() ? <Btn small title={t('hub.complete')} color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/appointments/${a.id}`, { status: 'completed' }), t('enum.completed'))} /> : null}
              {a.athlete_id === user.id && !['cancelled', 'completed'].includes(a.status) ? <>
                <Btn small title={t('hub.share_records')} color={c.violet} onPress={() => setShare({ id: a.provider_id, name: a.provider_name })} />
                <Btn small title={t('hub.revoke')} color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/medical/grants/${a.provider_id}`), t('hub.access_revoked'))} /></> : null}
            </View></Card>
        )) : <Empty emoji="📅" title={t('hub.no_appts')} />)}
        {tab === 'records' && visits.data?.filter((v) => v.status === 'signed' && v.visit_summary).map((v) => (
          <Card key={v.id}><Tag label={t('hub.visit_summary')} color={c.mint} />
            {v.visit_summary.problem ? <T weight="900" style={{ marginTop: 6 }}>{v.visit_summary.problem}</T> : null}
            {v.visit_summary.plan ? <T size={13} color={c.mute}>{t('hub.plan_is', { text: v.visit_summary.plan })}</T> : null}
            {v.visit_summary.actions ? <T size={13} color={c.mute}>{t('hub.what_to_do', { text: v.visit_summary.actions })}</T> : null}
            {v.visit_summary.follow_up_date ? <T size={13} color={c.mute}>{t('hub.followup_is', { text: v.visit_summary.follow_up_date })}</T> : null}
            {v.visit_summary.escalation ? <T size={13} color={c.mute}>{t('hub.if_worse', { text: v.visit_summary.escalation })}</T> : null}
            <T size={11} color={c.mute}>{t('hub.dr_line', { name: v.provider_name, day: day(v.signed_at) })}</T>
            {v.patient_ack_at ? <T size={11} color={c.mute}>{t('hub.you_read')}</T> : <Btn small title={t('hub.mark_read')} color={c.mint} ink={c.ink} onPress={() => act(async () => { await api.post(`/medical/encounters/${v.id}/acknowledge`, {}); visits.reload(); }, t('hub.marked_read_toast'))} />}
          </Card>
        ))}
        {tab === 'records' && (recs.data?.length ? recs.data.map((r) => <Card key={r.id}><View style={{ flexDirection: 'row', gap: 8 }}><Tag label={tEnum(r.kind)} color={c.cyan} />{r.clearance ? <Tag label={tEnum(r.clearance)} color={r.clearance === 'cleared' ? c.lime : c.orange} /> : null}</View><T weight="900" style={{ marginTop: 6 }}>{r.summary}</T>{r.details ? <T size={13} color={c.mute}>{r.details}</T> : null}<T size={11} color={c.mute}>{r.provider_name} · {day(r.created_at)}</T></Card>) : <Empty emoji="📋" title={t('hub.no_records')} sub={t('hub.no_records_sub')} />)}
      </View>
      {hist ? <TimelineSheet kind="appointment" id={hist} meId={user.id} title={t('hub.appt_history')} onClose={() => setHist(null)} /> : null}
      <Confirm visible={!!cancelA} title={t('hub.cancel_appt_q')} yes={t('hub.cancel_appt')} danger askReason={t('hub.cancel_why')} onClose={() => setCancelA(null)}
        body={cancelA ? `${t('hub.will_be_told', { name: cancelA.athlete_id === user.id ? cancelA.provider_name : cancelA.athlete_name })}${cancelA.payment_status === 'paid' ? ` ${t('hub.refunded')}` : ''}` : ''}
        onYes={async (reason) => { await act(() => api.patch(`/appointments/${cancelA.id}`, { status: 'cancelled', ...(reason ? { reason } : {}) }), cancelA.payment_status === 'paid' ? t('hub.cancelled_refund') : t('enum.cancelled')); setCancelA(null); }} />
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
    <Section title={t('hub.introduced')} color={c.mint}>
      {list.data.map((a) => (
        <Row key={a.id} left={<Avatar user={{ ...a, avatar_emoji: a.avatar_emoji, avatar_color: a.avatar_color }} />} title={a.display_name} sub={`${a.institution}${a.programme_title ? ` · ${a.programme_title}` : ''}${a.sport ? ` · ${a.sport}` : ''}${a.note ? `\n“${a.note}”` : ''}\n${t('hub.for_brand', { brand: a.brand })}`}
          right={<Btn small title={t('hub.send_offer')} onPress={() => onOffer(a)} />} />
      ))}
    </Section>
  );
}



// the stored value stays the English name (existing brands keep matching); only the label is translated
const BRAND_INDUSTRIES = [['Sports & fitness', t('hub.ind_sports_fitness')], ['Apparel & footwear', t('hub.ind_apparel_footwear')], ['Food & beverage', t('hub.ind_food_beverage')], ['Health & nutrition', t('hub.ind_health_nutrition')], ['Banking & finance', t('hub.ind_banking_finance')], ['Insurance', t('hub.ind_insurance')], ['Technology', t('hub.ind_technology')], ['Telecom', t('hub.ind_telecom')], ['Automotive', t('hub.ind_automotive')], ['Travel & hospitality', t('hub.ind_travel_hospitality')], ['Media & entertainment', t('hub.ind_media_entertainment')], ['Retail & e-commerce', t('hub.ind_retail_ecommerce')], ['Education', t('hub.ind_education')], ['Real estate', t('hub.ind_real_estate')], ['Energy', t('hub.ind_energy')]].map(([value, label]) => ({ value, label }));
const BRAND_COLORS = [{ value: '#16a34a', label: t('hub.col_green') }, { value: '#2563eb', label: t('hub.col_blue') }, { value: '#7c3aed', label: t('hub.col_violet') }, { value: '#db2777', label: t('hub.col_pink') }, { value: '#dc2626', label: t('hub.col_red') }, { value: '#ea580c', label: t('hub.col_orange') }, { value: '#ca8a04', label: t('hub.col_gold') }, { value: '#0f766e', label: t('hub.col_teal') }, { value: '#111827', label: t('hub.col_black') }];
const BRAND_ICONS = ['💎', '🏆', '⚡', '🔥', '🌿', '🚀', '🎯', '🏅', '⭐', '🛡️'];
const OFFERS = ['cash', 'equipment', 'apparel', 'travel', 'nutrition', 'coaching', 'media'].map((value) => ({ value, label: tEnum(value) }));
const BACKS = [{ value: 'athlete', label: t('hub.back_athletes') }, { value: 'team', label: t('hub.back_teams') }, { value: 'event', label: t('hub.back_events') }];
const ROLE_NOTE = { evaluator: t('hub.role_evaluator'), finance: t('hub.role_finance'), legal: t('hub.role_legal'), approver: t('hub.role_approver'), auditor: t('hub.role_auditor'), viewer: t('hub.role_viewer') };
const BRAND_FIELDS = [
  { key: 's1', type: 'section', label: t('hub.f_identity') },
  { key: 'name', label: t('hub.f_brand_name') },
  { key: 'tagline', label: t('hub.f_tagline'), optional: true, hint: t('hub.f_tagline_hint') },
  { key: 'emoji', label: t('hub.f_icon'), type: 'chips', options: BRAND_ICONS, default: '💎' },
  { key: 'brand_color', label: t('hub.f_brand_colour'), type: 'chips', options: BRAND_COLORS, optional: true },
  { key: 'industry', label: t('hub.f_industry'), type: 'chips', options: BRAND_INDUSTRIES, optional: true },
  { key: 'about', label: t('hub.f_about'), type: 'multiline', optional: true, hint: t('hub.f_about_hint') },
  { key: 'founded_year', label: t('hub.f_founded'), type: 'stepper', min: 1800, max: new Date().getFullYear(), default: new Date().getFullYear(), optional: true },
  { key: 'country', label: t('place.country'), type: 'country', optional: true },
  { key: 's2', type: 'section', label: t('hub.f_what_sponsor') },
  { key: 'backs', label: t('hub.f_back'), type: 'multi', options: BACKS, optional: true },
  { key: 'offers', label: t('hub.f_offer'), type: 'multi', options: OFFERS, optional: true, hint: t('hub.f_offer_hint') },
  { key: 'sports', label: t('hub.f_sports'), type: 'sports', optional: true, hint: t('hub.f_sports_hint') },
  { key: 'regions', label: t('hub.f_regions'), type: 'regions', optional: true, hint: t('hub.f_regions_hint') },
  { key: 'budget_currency', label: t('hub.f_budget_cur'), type: 'currency', default: 'INR' },
  { key: 'budget_min_cents', label: t('hub.f_budget_from'), type: 'money', currency: (v) => v.budget_currency ?? 'INR', optional: true },
  { key: 'budget_max_cents', label: t('hub.f_budget_to'), type: 'money', currency: (v) => v.budget_currency ?? 'INR', optional: true, hint: t('hub.f_budget_hint') },
  { key: 's3', type: 'section', label: t('hub.f_online') },
  { key: 'website', label: t('hub.f_website'), input: 'url', optional: true },
  { key: 'link_instagram', label: t('hub.f_instagram'), input: 'url', optional: true },
  { key: 'link_linkedin', label: t('hub.f_linkedin'), input: 'url', optional: true },
  { key: 'link_x', label: t('hub.f_x'), input: 'url', optional: true },
  { key: 'link_youtube', label: t('hub.f_youtube'), input: 'url', optional: true },
  { key: 's4', type: 'section', label: t('hub.f_private_contact') },
  { key: 'contact_name', label: t('hub.f_contact_person'), optional: true },
  { key: 'contact_email', label: t('hub.f_contact_email'), input: 'email', optional: true, hint: t('hub.f_encrypted_hint') },
  { key: 'contact_phone', label: t('hub.f_contact_phone'), input: 'phone', optional: true, hint: t('hub.f_encrypted_hint') },
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

/** Sponsor home header: what needs this person now, and the cash picture. Each currency stands alone; reported money and estimates are labelled, never merged into confirmed cash. */
function HomeSummary({ home }) {
  const { push } = useNav();
  if (home.loading && !home.data) return <Loading />;
  if (home.error) return <LoadError error={home.error} onRetry={home.reload} />;
  const h = home.data;
  const todo = [
    [h.offers_to_answer, t('hub.td_offer_one'), t('hub.td_offer_many'), null],
    [h.payments_to_confirm, t('hub.td_pay_one'), t('hub.td_pay_many'), null],
    [h.endorsements_to_review, t('hub.td_endorse_one'), t('hub.td_endorse_many'), null],
    [h.overdue, t('hub.td_overdue_one'), t('hub.td_overdue_many'), c.red],
    [h.due_30_days, t('hub.td_due30_one'), t('hub.td_due30_many'), null],
    [h.offers_awaiting_reply, t('hub.td_waiting_one'), t('hub.td_waiting_many'), null],
  ].filter(([n]) => n > 0);
  const live = h.agreements.some((x) => ['proposed', 'active', 'paused'].includes(x.status));
  if (!todo.length && !h.totals.length && !live) return null;
  return (
    <>
      <Section title={t('hub.needs_you')} color={c.sun}>
        {todo.length ? todo.map(([n, one, many, tone]) => <T key={one} accessibilityRole="text" color={tone ?? c.ink}><T weight="900" color={tone ?? c.ink}>{n}</T> {n === 1 ? one : many}</T>) : <T color={c.mute}>{t('hub.nothing_needs')}</T>}
      </Section>
      {h.totals.length ? (
        <Section title={t('hub.committed_cash')} color={c.mint}>
          {h.totals.map((tt) => (
            <Card key={tt.currency}>
              <T weight="900" size={20}>{curMoney(Number(tt.committed_cents), tt.currency)}</T>
              <T size={12} color={c.mute}>{t('hub.confirmed_received', { amount: curMoney(Number(tt.confirmed_cents), tt.currency) })}{Number(tt.reported_unverified_cents) ? ` · ${t('hub.reported_unconfirmed', { amount: curMoney(Number(tt.reported_unverified_cents), tt.currency) })}` : ''}</T>
            </Card>))}
          {h.estimated_not_cash.map((e) => <T key={e.currency} size={12} color={c.mute}>{t('hub.estimate_note', { amount: curMoney(Number(e.estimated_cents), e.currency) })}</T>)}
          <T size={12} color={c.mute}>{t('hub.currency_note')}</T>
        </Section>) : null}
    </>
  );
}

export function Sponsors() {
  const { has, user, toast } = useSession();
  const { push } = useNav();
  const [form, setForm] = useState(null);
  const [editBrand, setEditBrand] = useState(null);
  const [handOver, setHandOver] = useState(null);
  const dir = useLoad(() => api.get('/sponsors', { limit: 50 }), []);
  const mine = useLoad(() => api.get('/sponsors', { mine: true, limit: 50 }), []);
  const invites = useLoad(() => api.get('/me/sponsor-identities', { limit: 1 }).then((r) => r.invitations ?? []).catch(() => []), []); // invitations to a sponsor team, answered here
  const deals = useLoad(() => api.get('/sponsorships', { limit: 100 }), []);
  const home = useLoad(() => api.get('/sponsorship-summary'), []);
  const profile = useLoad(() => api.get('/me/sponsorship-profile'), []);
  const act = async (fn, m) => { try { await fn(); toast(m); deals.reload(); home.reload(); } catch (e) { toast(explain(e)); if (e.status === 409) deals.reload(); } };
  const pr = profile.data;
  // my sponsor role per brand decides which deal buttons are offered (the server still enforces it)
  const roleOf = (sponsorId) => asSponsorRole((mine.data ?? []).find((b) => b.id === sponsorId)?.my_role);
  const mayDeal = (d, action) => !roleOf(d.sponsor_id) || { withdraw: ['manager', 'approver'], end: ['manager', 'approver'] }[action].includes(roleOf(d.sponsor_id));
  return (
    <Screen>
      <H1>{t('nav.title.Sponsors')}</H1>
      {invites.data?.length ? (
        <Section title={t('hub.invites_title')} color={c.sun}>
          {invites.data.map((i) => (
            <Row key={i.representative_id} title={i.legal_name ?? t('hub.a_sponsor')} sub={`${SPONSOR_ROLE_LABEL[i.role] ?? i.role}${i.invited_by ? ` · ${t('hub.invited_by', { name: i.invited_by })}` : ''}. ${t('hub.invite_access')}`}
              right={<View style={{ flexDirection: 'row', gap: 6 }}>
                <Btn small title={t('access.accept')} color={c.violet} onPress={() => act(() => api.post(`/sponsor-representatives/${i.representative_id}/response`, { accept: true }).then(() => { invites.reload(); mine.reload(); }), t('hub.joined_team'))} accessibilityLabel={t('hub.a11y_accept_inv', { name: i.legal_name ?? t('hub.a_sponsor') })} />
                <Btn small title={t('cls.decline')} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/sponsor-representatives/${i.representative_id}/response`, { accept: false }).then(() => invites.reload()), t('hub.inv_declined'))} accessibilityLabel={t('hub.a11y_decline_inv', { name: i.legal_name ?? t('hub.a_sponsor') })} />
              </View>} />
          ))}
        </Section>
      ) : null}
      {has('sponsor') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}><Btn small title={t('hub.new_offer')} color={c.pink} onPress={() => push('SponsorOffer')} accessibilityLabel={t('hub.a11y_new_offer')} /><Btn small title={t('hub.create_brand')} color={c.violet} onPress={() => setForm('brand')} /></View> : null}
      <HomeSummary home={home} />
      {has('athlete') ? (
        <Section title={t('hub.open_title')} color={c.mint}>
          <T size={13} color={c.mute}>{t('hub.open_note')}</T>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <Chip label={pr?.open_to_sponsors ? t('hub.open_to_offers') : t('hub.not_open')} active={!!pr?.open_to_sponsors} onPress={() => act(() => api.post('/me/sponsorship-profile', { open_to_sponsors: !pr?.open_to_sponsors }).then(profile.reload), pr?.open_to_sponsors ? t('hub.hidden_from_sponsors') : t('hub.sponsors_can_find'))} />
            <Btn small title={t('hub.edit_pitch')} color={c.violet} onPress={() => setForm('pitch')} />
          </View>
          {pr?.pitch ? <T size={13} style={{ marginTop: 6 }}>{pr.pitch}</T> : null}
          {pr?.verified_sponsors_only ? <T size={12} color={c.mute}>{t('hub.verified_only_note')}</T> : null}
        </Section>
      ) : null}
      <Section title={t('hub.funding_title')} color={c.lime}>
        <T size={13} color={c.mute}>{t('hub.funding_note')}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <Btn small title={t('hub.b_calls')} color={c.pink} onPress={() => push('FundingOpportunities')} />
          <Btn small title={t('hub.b_portfolio')} color={c.violet} onPress={() => push('SponsorPortfolio')} />
          <Btn small title={t('hub.b_reports')} color={c.violet} onPress={() => push('SponsorReports')} />
          <Btn small title={t('hub.b_roi')} color={c.violet} onPress={() => push('SponsorRoi')} />
          {mine.data?.length ? <Btn small title={t('hub.b_run')} color={c.violet} onPress={() => push('SponsorPrograms')} /> : null}
          {mine.data?.some((b) => ['manager', 'finance', 'approver', 'auditor'].includes(b.my_role)) ? <Btn small title={t('hub.b_budgets')} color={c.paper} ink={c.ink} onPress={() => push('SponsorBudgets')} /> : null}
        </View>
      </Section>
      <Section title={t('hub.deals_title')} color={c.sun}>
        {deals.data?.length ? deals.data.map((d) => (
          <Card key={d.id} color={c.sunSoft}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Bubble emoji={d.sponsor_emoji} color={c.paper} /><View style={{ flex: 1 }}><T weight="900">{d.sponsor_name}{d.sponsor_verified ? ' ✓' : ''} → {d.target_name ?? d.target_type}</T><T size={12} color={c.mute}>{[d.amount_cents ? money(d.amount_cents, d.currency) : null, d.in_kind].filter(Boolean).join(' + ') || t('hub.support_offered')}{d.starts_on ? ` · ${t('hub.date_range', { from: day(d.starts_on), to: d.ends_on ? day(d.ends_on) : t('hub.open_ended') })}` : ''}</T></View><View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={tEnum(d.status)} color={d.status === 'active' ? c.lime : d.status === 'proposed' ? c.sunSoft : c.pinkSoft} />{d.program_id ? <Tag label={t('hub.funding_award')} color={c.mint} /> : null}</View></View>
            {d.objectives ? <T size={12} style={{ marginTop: 6 }}><T size={12} weight="800">{t('hub.objectives')} </T>{d.objectives}</T> : null}
            {d.deliverables ? <T size={12}><T size={12} weight="800">{t('hub.deliverables')} </T>{d.deliverables}</T> : null}
            {d.message ? <T size={12} color={c.mute}>“{d.message}”</T> : null}
            {d.decision_reason ? <T size={12} color={c.mute}>{t('hub.reply_line', { text: d.decision_reason })}</T> : null}
            {d.agreement_ref ? <Btn small title={t('hub.open_agreement', { ref: d.agreement_ref })} color={c.violet} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => push('SponsorDeal', { id: d.id })} /> : null}
            {d.status === 'proposed' && !d.i_am_sponsor && d.agreement_ref ? <Btn small title={t('hub.review_answer')} color={c.pink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => push('SponsorDeal', { id: d.id })} accessibilityLabel={t('hub.a11y_review_offer', { name: d.sponsor_name })} /> : null}
            {d.status === 'proposed' && !d.i_am_sponsor && !d.agreement_ref ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title={t('access.accept')} color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'active' }), t('hub.deal_on'))} /><Btn small title={t('cls.decline')} color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'declined' }), t('enum.declined'))} />{d.target_type === 'athlete' ? <Btn small title={t('hub.accept_show')} color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'active', show_publicly: true }), t('hub.deal_on_public'))} /> : null}</View> : null}
            {d.i_am_sponsor && d.budget_approval === 'pending' ? <T size={12} color={c.mute}>{t('hub.budget_wait')}</T> : null}
            {d.status === 'proposed' && d.i_am_sponsor && mayDeal(d, 'withdraw') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title={t('hub.withdraw_offer')} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsorships/${d.id}/withdraw`), t('hub.offer_withdrawn'))} /></View> : null}
            {['active', 'paused'].includes(d.status) && mayDeal(d, 'end') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title={t('hub.end_deal')} color={c.paper} ink={c.red} onPress={() => push('SponsorDeal', { id: d.id })} /></View> : null}
          </Card>
        )) : <Empty emoji="🤝" title={t('hub.no_deals')} />}
      </Section>
      {has('sponsor') && mine.data?.length ? <Introductions brands={mine.data} onOffer={(a) => push('SponsorOffer', { target: { type: 'athlete', id: a.athlete_id, name: a.display_name } })} /> : null}
      {has('sponsor') && mine.data?.length ? <YouthAuthorizations brands={mine.data} onOffer={(a) => push('SponsorOffer', { target: { type: 'athlete', id: a.id, name: a.display_name } })} /> : null}
      <Section title={t('hub.your_brands')} color={c.violet}>
        {mine.error ? <LoadError error={mine.error} onRetry={mine.reload} /> : mine.loading && !mine.data ? <Loading /> : mine.data?.length ? mine.data.map((s) => (
          <Row key={s.id} left={<Bubble emoji={s.emoji} color={c.sun} />} title={s.name}
            sub={[s.tagline, s.industry, s.organisation_name ? t('hub.run_by', { name: s.organisation_name }) : t('hub.individual_brand'), asSponsorRole(s.my_role) !== 'manager' ? ROLE_NOTE[asSponsorRole(s.my_role)] : null].filter(Boolean).join(' · ')}
            right={<View style={{ alignItems: 'flex-end', gap: 6 }}><Tag label={SPONSOR_ROLE_LABEL[s.my_role] ?? t('hub.team')} />
              <Btn small title={t('hub.team_identity')} color={c.paper} ink={c.ink} onPress={() => push('SponsorIdentity', { id: s.id })} accessibilityLabel={t('hub.a11y_team_identity', { name: s.name })} />
              {asSponsorRole(s.my_role) === 'manager' ? <Btn small title={t('hub.edit_profile')} color={c.violet} onPress={async () => { try { setEditBrand(await api.get(`/sponsors/${s.id}`)); } catch (e) { toast(explain(e)); } }} /> : null}
              {asSponsorRole(s.my_role) === 'manager' && (!s.identity_confirmed || s.organisation_id) ? <Btn small title={t('hub.hand_over')} color={c.paper} ink={c.ink} onPress={() => setHandOver(s)} accessibilityLabel={t('hub.a11y_hand_over', { name: s.name })} /> : null}
              {s.organisation_id && asSponsorRole(s.my_role) !== 'viewer' ? <Btn small title={t('hub.open_workspace')} color={c.paper} ink={c.ink} onPress={() => push('Org', { id: s.organisation_id })} /> : null}</View>} />
        )) : <Empty emoji="🏷️" title={t('hub.no_brands')} sub={t('hub.no_brands_sub')} />}
        <T size={12} color={c.mute}>{t('hub.brands_note')}</T>
      </Section>
      <Section title={t('hub.brands')} color={c.pink}>{dir.data?.map((s) => <Row key={s.id} left={<Bubble emoji={s.emoji} color={c.sun} />} title={s.name} sub={s.industry ?? s.website} />)}</Section>
      <FormSheet visible={form === 'brand'} onClose={() => setForm(null)} title={t('hub.create_your_brand')} submitLabel={t('hub.create_brand')} fields={BRAND_FIELDS}
        onSubmit={async (v) => { await api.post('/sponsors', brandBody(v, false)); dir.reload(); mine.reload(); return t('hub.brand_created'); }} />
      <FormSheet visible={!!editBrand} onClose={() => setEditBrand(null)} title={editBrand?.name ? t('hub.edit_brand', { name: editBrand.name }) : t('hub.edit_brand_default')} fields={BRAND_FIELDS} initial={editBrand ? brandInitial(editBrand) : {}}
        onSubmit={async (v) => { await api.patch(`/sponsors/${editBrand.id}`, brandBody(v, true)); dir.reload(); mine.reload(); return t('hub.brand_saved'); }} />
      <HandOverBrand brand={handOver} visible={!!handOver} onClose={() => setHandOver(null)} onDone={() => { mine.reload(); dir.reload(); }} toast={toast} />
      <FormSheet visible={form === 'pitch'} onClose={() => setForm(null)} title={t('hub.pitch_title')} initial={{ pitch: pr?.pitch ?? '', looking_for: pr?.looking_for ?? [], verified_sponsors_only: !!pr?.verified_sponsors_only }}
        fields={[{ key: 'pitch', label: t('hub.pitch_q'), type: 'multiline', optional: true, hint: t('hub.pitch_hint') }, { key: 'looking_for', label: t('hub.looking_q'), type: 'multi', optional: true, options: OFFERS }, { key: 'verified_sponsors_only', label: t('hub.verified_only_switch'), type: 'switch' }]}
        onSubmit={async (v) => { await api.post('/me/sponsorship-profile', { open_to_sponsors: !!pr?.open_to_sponsors, pitch: v.pitch ?? null, looking_for: v.looking_for ?? [], verified_sponsors_only: v.verified_sponsors_only }); profile.reload(); return t('access.saved'); }} />
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
      <H1>{t('nav.title.Supply')}</H1>
      <Btn small title={t('hub.add_stock_item')} color={c.orange} onPress={() => setForm('item')} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
      <Section title={t('hub.inventory')} color={c.orange}>
        {inv.data?.length ? inv.data.map((i) => (
          <Card key={i.id} color={i.low_stock ? c.orangeSoft : c.paper} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}><T weight="900">{i.name}</T><T size={12} color={c.mute}>{tEnum(i.category)} · {t('hub.reorder_at', { n: i.reorder_level })}</T>{i.low_stock ? <Tag label={t('hub.low_stock')} color={c.red} ink="#fff" style={{ marginTop: 4 }} /> : null}</View>
              <Btn small title="−" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/inventory/${i.id}/adjust`, { delta: -1 }))} />
              <T weight="900" size={20} style={{ minWidth: 34, textAlign: 'center' }}>{i.quantity}</T>
              <Btn small title="+" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/inventory/${i.id}/adjust`, { delta: 1 }))} />
            </View>
            {i.low_stock ? <Btn small title={t('hub.reorder')} color={c.ink} onPress={() => setForm({ order: i })} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
          </Card>
        )) : <Empty emoji="📦" title={t('hub.no_stock')} />}
      </Section>
      <Section title={t('hub.orders')} color={c.cyan}>
        {ord.data?.length ? ord.data.map((o) => (
          <Row key={o.id} left={<Bubble emoji="🚚" color={c.cyanSoft} />} title={`${o.quantity} × ${o.item_name}`} sub={`${o.supplier}${o.expected_on ? ' · ' + t('hub.by_date', { date: day(o.expected_on) }) : ''}`}
            right={o.status === 'ordered' || o.status === 'shipped' ? <Btn small title={t('hub.received')} color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/supply-orders/${o.id}`, { status: 'received' }), t('hub.stock_updated'))} /> : <Tag label={tEnum(o.status)} color={c.lime} />} />
        )) : <Empty emoji="🚚" title={t('hub.no_orders')} />}
      </Section>
      <FormSheet visible={form === 'item'} onClose={() => setForm(null)} title={t('hub.add_stock')} fields={[{ key: 'name', label: t('hub.f_item') }, { key: 'category', label: t('cs.category'), type: 'choice', options: ['equipment', 'apparel', 'nutrition', 'medical', 'merch', 'other'].map((value) => ({ value, label: tEnum(value) })) }, { key: 'quantity', label: t('hub.f_quantity'), type: 'number' }, { key: 'reorder_level', label: t('hub.f_reorder_at'), type: 'number', optional: true }]}
        onSubmit={async (v) => { await api.post('/inventory', v); inv.reload(); return t('hub.added'); }} />
      <FormSheet visible={!!form?.order} onClose={() => setForm(null)} title={t('hub.reorder_title', { name: form?.order?.name ?? '' })} fields={[{ key: 'supplier', label: t('hub.f_supplier') }, { key: 'quantity', label: t('hub.f_quantity'), type: 'number' }]}
        onSubmit={async (v) => { await api.post('/supply-orders', { item_id: form.order.id, ...v }); ord.reload(); return t('hub.order_placed'); }} />
    </Screen>
  );
}
