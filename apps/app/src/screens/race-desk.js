// Race day (issue #487): the timing desk of a mass-participation race — entrants, bib & chip numbers, waves, course, timing files, exceptions,
// governed status, cutoffs, corrections, protests, results and awards. It lives inside the event console (the "Race day" tab); crew who are not the
// organiser open the same desk for a single race. Every action is a capability call: the server decides who may do what, the screen only hides what a role cannot use.
import { locale } from '../locale';
import React, { useCallback, useState } from 'react';
import { TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { usePoll } from '../live';
import { useSession } from '../session';
import { useNav } from '../nav';
import { A, ABar, ABtn, ACard, AChip, AEmpty, AHero, AG, ARow, AScreen, ASection, AStat, AT, ATabs, ATag, ReasonSheet } from '../arena';
import { ErrorBox, Loading, Sheet, T, Field } from '../ui';
import { FormSheet } from '../FormSheet';
import { Counter } from '../pickers';
import { pickText, saveText } from '../evidence';
import { c } from '../theme';

const fail = (toast) => (e) => toast('' + (e?.message ?? e));
const hms = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '–');
const dayTime = (iso) => (iso ? new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
const localIso = (date, time) => new Date(`${date}T${time}:00`).toISOString();
const nowDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ms2 = (ms) => { if (ms === null || ms === undefined) return '–'; const t = Math.abs(Number(ms)), h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`; };
const KIND_LABEL = {
  missing_read: 'Missing read', out_of_order: 'Out of order', multiple_reads: 'Conflicting reads', negative_time: 'Negative time', unknown_chip: 'Unknown chip', stale_chip: 'Retired chip read',
  no_start_read: 'No start read', no_gun_time: 'No gun time', needs_review: 'Needs a decision', status_conflict: 'Status conflict', ambiguous_read: 'Ambiguous read',
};
const STATUS_TONE = { finished: A.green, started: A.cyan, registered: A.mute, dns: A.sun, dnf: A.orange, dq: A.red, cutoff: A.red };
const CLASS_LABEL = (cls, cats) => (cls === 'overall' ? 'Overall' : cls === 'gender:male' ? 'Men' : cls === 'gender:female' ? 'Women' : cats.find((k) => `category:${k.id}` === cls)?.name ?? cls);
const SOURCES = ['official', 'timing', 'medical', 'protest', 'entrant', 'organiser'];

const useDo = (toast, refresh) => async (fn, msg) => {
  try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg); refresh?.(); return r; } catch (e) { fail(toast)(e); return null; }
};

/** Status labels on the gradient hero: dark glass pills with light text so they stay readable on any colour. */
const HeroTag = ({ label, tone = '#FFFFFF' }) => (
  <View style={{ borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: 'rgba(21,16,48,0.62)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' }}>
    <AT size={10.5} weight="900" color={tone} style={{ letterSpacing: 0.8 }}>{String(label).toUpperCase()}</AT>
  </View>
);

const WHY = {
  missing_read: (x) => `No read at ${x.checkpoint_code}, but later checkpoints were read`,
  out_of_order: (x) => `${x.checkpoint_code} was read before ${x.detail?.after ?? 'an earlier checkpoint'}`,
  multiple_reads: (x) => `Several reads at ${x.checkpoint_code} further apart than the duplicate window; the first counts`,
  negative_time: () => 'The finish read is earlier than the start',
  unknown_chip: (x) => `Chip ${x.detail?.chip ?? x.detail?.bib ?? ''} is not assigned to anyone`,
  stale_chip: (x) => `Chip ${x.detail?.chip ?? x.detail?.bib ?? ''} was read after it was retired`,
  no_start_read: () => 'Finished without a start read, so there is no net time',
  no_gun_time: () => 'The wave has no recorded gun time',
  needs_review: (x) => x.detail?.reason ?? 'An official needs to decide this result',
  status_conflict: (x) => `Marked ${x.detail?.status}, but the timing says ${x.detail?.timing}`,
};

const BibBadge = ({ bib, size = 52 }) => (
  <View accessibilityLabel={bib ? `Bib ${bib}` : 'No bib'} style={{ minWidth: size, height: 40, borderRadius: 10, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: bib ? '#FFFFFF' : A.panel2, borderWidth: 1, borderColor: bib ? '#FFFFFF' : A.line }}>
    <AT size={bib ? 17 : 11} weight="900" color={bib ? '#23252F' : A.mute} num>{bib ?? 'NO BIB'}</AT>
  </View>
);

// ------------------------------------------------------------------------------------------------- the event console tab: races of this event

export function RaceDay({ id, isOrg }) {
  const { toast } = useSession();
  const { push } = useNav();
  const races = useLoad(() => api.get(`/events/${id}/races`), [id]);
  const [setup, setSetup] = useState(false);
  return (
    <>
      <ASection title="Race day" sub="Entrants, bibs & chips, waves, timing and results — for road races, cross-country, cycling, swim meets" />
      {races.error ? <ErrorBox error={races.error} onRetry={races.reload} /> : null}
      {(races.data ?? []).map((r) => (
        <ARow key={r.id} onPress={() => push('RaceDesk', { id: r.id })} left={<View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: A.panel2 }}><AT size={22}>{r.emoji ?? '🏃'}</AT></View>}
          title={r.name} sub={`${r.sport_name} · ${r.result_label ? `${r.result_label} results` : 'no results published yet'}`}
          right={<ATag label={r.public ? 'public page on' : 'public page off'} tone={r.public ? A.green : A.mute} />} />
      ))}
      {races.data && !races.data.length ? <AEmpty emoji="🏁" title="No race set up yet" sub={isOrg ? 'Add a race to register entrants, hand out bibs and chips, start waves, import timing and publish results.' : 'The organiser has not set up a race for this event.'} /> : null}
      {isOrg ? <ABtn title="＋ Set up a race" onPress={() => setSetup(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={setup} onClose={() => setSetup(false)} title="Set up a race" submitLabel="Create race"
        fields={[
          { key: 'name', label: 'Race name', placeholder: '10 km road race' },
          { key: 'sport', label: 'Sport', type: 'sport' },
          { key: 'gender', label: 'Open to', type: 'choice', options: [{ value: 'any', label: 'Everyone' }, { value: 'male', label: 'Men' }, { value: 'female', label: 'Women' }] },
          { key: 'time_basis', label: 'Ranked on', type: 'choice', options: [{ value: 'net', label: 'Chip (net) time' }, { value: 'gun', label: 'Gun time' }], hint: 'Net runs from the runner\'s own start-mat read; gun runs from the wave start.' },
          { key: 'allow_guests', label: 'Allow guest entrants without an account', type: 'switch', default: true },
          { key: 'public', label: 'Show a public live results page', type: 'switch', default: false },
        ]}
        onSubmit={async (v) => {
          const r = await api.post(`/events/${id}/races`, { name: v.name, sport: v.sport, gender: v.gender, rules: { time_basis: v.time_basis, allow_guests: v.allow_guests, public: { enabled: v.public, names: false, splits: false, categories: true } } });
          races.reload();
          push('RaceDesk', { id: r.race.id });
          return 'Race created';
        }} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------- one race

export function RaceDesk({ id, tab: first = 'desk' }) {
  const { toast } = useSession();
  const [tab, setTab] = useState(first);
  const card = useLoad(() => api.get(`/races/${id}`), [id]);
  const desk = useLoad(() => api.get(`/races/${id}/desk`), [id]);
  const reload = useCallback(() => { card.reload(); desk.reload(); }, [card.reload, desk.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoll(desk.reload, tab === 'desk' ? 8000 : 30000);
  if (card.error || desk.error) return <AScreen><ErrorBox error={card.error ?? desk.error} onRetry={reload} /></AScreen>;
  if (!card.data || !desk.data) return <AScreen><Loading /></AScreen>;
  const R = card.data, D = desk.data;
  const P = { id, R, D, reload, toast, go: setTab, access: R.access };
  const reviews = (D.cutoffs.pending ?? 0) + (D.corrections.proposed ?? 0) + (D.corrections.open_protests ?? 0);
  const exceptions = D.exceptions.reduce((a, x) => a + x.n, 0);
  const tabs = [
    { key: 'desk', label: 'Desk', icon: '🧭' },
    { key: 'entrants', label: 'Entrants', icon: '🎽', badge: D.readiness.entrants || undefined },
    { key: 'waves', label: 'Waves & course', icon: '🚦' },
    { key: 'timing', label: 'Timing', icon: '⏱️', badge: exceptions || undefined },
    { key: 'results', label: 'Results', icon: '🏆' },
    { key: 'reviews', label: 'Reviews', icon: '⚖️', badge: reviews || undefined },
  ];
  const rules = R.policy.rules;
  return (
    <AScreen>
      <AHero kicker={`${R.race.sport?.emoji ?? '🏃'} ${R.race.event_name}`} title={R.race.name} sub={`${rules.time_basis === 'net' ? 'Chip (net) time' : 'Gun time'} · duplicate window ${rules.dedupe_window_s}s · policy v${R.policy.version}${R.course ? ` · ${R.course.name}` : ' · no course yet'}`} tone={AG.neon} emoji={R.race.sport?.emoji ?? '🏃'}>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <HeroTag label={D.publication ? `${D.publication.label} v${D.publication.version}` : 'nothing published'} tone={D.final ? '#A7F3D0' : D.publication ? '#FDE68A' : '#FFFFFF'} />
          {D.results_stale ? <HeroTag label="results out of date" tone="#FDBA74" /> : null}
          <HeroTag label={R.access.organizer ? 'organiser' : R.access.chief ? 'chief official' : 'timing crew'} />
        </View>
      </AHero>
      <ATabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'desk' && <DeskTab {...P} />}
      {tab === 'entrants' && <EntrantsTab {...P} />}
      {tab === 'waves' && <WavesTab {...P} />}
      {tab === 'timing' && <TimingTab {...P} />}
      {tab === 'results' && <ResultsTab {...P} />}
      {tab === 'reviews' && <ReviewsTab {...P} />}
    </AScreen>
  );
}

// ------------------------------------------------------------------------------------------------- desk

function DeskTab({ id, D, reload, toast, go, access }) {
  const doIt = useDo(toast, reload);
  const [closing, setClosing] = useState(false);
  const [gun, setGun] = useState(null);
  const [publish, setPublish] = useState(null);
  const todoGo = { bibs: 'entrants', chips: 'entrants', waves: 'entrants', exceptions: 'timing', cutoffs: 'reviews', corrections: 'reviews', protests: 'reviews', publish: 'results', unresolved: null, reconcile: null };
  const reconcile = () => doIt(() => api.post(`/races/${id}/reconcile`, {}), (r) => `Reconciled ${r.entrants} entrants · ${r.changed} updated · ${r.open_exceptions} exceptions`);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="🎽" value={D.readiness.entrants} label="Entrants" />
        <AStat icon="🏃" value={D.finish_queue.on_course} label="Running" />
        <AStat icon="🏁" value={D.statuses.finished ?? 0} label="Finished" />
        <AStat icon="🚫" value={['dns', 'dnf', 'dq', 'cutoff'].reduce((n, k) => n + (D.statuses[k] ?? 0), 0)} label="Out" />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {Object.entries(D.statuses).filter(([k]) => !['registered', 'started', 'finished'].includes(k)).map(([k, n]) => <ATag key={k} label={`${k} ${n}`} tone={STATUS_TONE[k] ?? A.violet} />)}
        {D.statuses.registered ? <ATag label={`${D.statuses.registered} not started`} tone={A.mute} /> : null}
      </View>

      {D.results_stale && D.last_reconcile !== undefined ? (
        <ACard tone={A.orange} style={{ gap: 8 }}>
          <AT size={15} weight="800">New timing data since the last reconciliation</AT>
          <AT size={13} color={A.mute}>Splits, times and the ranking are derived from the reads. Reconcile to bring them up to date.</AT>
          <ABtn small title="Reconcile now" onPress={reconcile} style={{ alignSelf: 'flex-start' }} />
        </ACard>
      ) : null}

      <ASection title="To do next" sub={D.todo.length ? 'Most urgent first' : 'Nothing is waiting on you'} />
      {D.todo.length === 0 ? <AEmpty emoji="✅" title="All clear" sub="Entrants are ready, timing is reconciled and nothing needs a decision." /> : D.todo.map((t) => (
        <ARow key={t.key} tone={t.severity === 'high' ? A.orange : undefined} title={t.label} right={<ATag label={t.count} tone={t.severity === 'high' ? A.orange : A.violet} />}
          onPress={() => (t.key === 'reconcile' ? reconcile() : t.key === 'unresolved' ? setClosing(true) : todoGo[t.key] && go(todoGo[t.key]))} />
      ))}

      <ASection title="Start waves" sub="Capacity is enforced by the server" />
      {D.waves.length === 0 ? <AEmpty emoji="🚦" title="No waves yet" sub="Create waves or corrals under Waves & course." action="Open waves" onAction={() => go('waves')} /> : D.waves.map((w) => (
        <ACard key={w.id} pad={14} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}><AT size={15} weight="800">{w.name}</AT><AT size={12.5} color={A.mute}>{dayTime(w.start_at)}{w.gun_at ? ` · gun ${hms(w.gun_at)}` : ''}</AT></View>
            <ATag label={w.status} tone={w.status === 'started' ? A.green : w.status === 'closed' ? A.sun : A.cyan} />
          </View>
          <ABar pct={(w.assigned / w.capacity) * 100} color={w.assigned >= w.capacity ? A.orange : A.cyan} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <AT size={12.5} color={A.mute} num>{w.assigned} of {w.capacity} places</AT>
            {w.status !== 'started' && w.status !== 'cancelled' ? <ABtn small title="Record gun" tone="live" onPress={() => setGun(w)} /> : null}
          </View>
        </ACard>
      ))}

      <ASection title="Timing mats" sub="Reads received per checkpoint" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {D.reads_per_checkpoint.length ? D.reads_per_checkpoint.map((x) => <AStat key={x.code} icon="📡" value={x.reads} label={`${x.code}${x.last_read ? ` · ${hm(x.last_read)}` : ''}`} />) : <AEmpty emoji="📡" title="No reads yet" sub="Import a timing file or record manual reads under Timing." />}
      </View>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <ATag label={`${D.duplicate_reads} handled duplicate reads`} tone={A.mute} /><ATag label={`${D.missing_reads} with missing reads`} tone={D.missing_reads ? A.sun : A.mute} />
      </View>

      <ASection title="Finish queue" sub={`${D.finish_queue.on_course} still on course`} />
      {D.finish_queue.recent_finishers.length ? D.finish_queue.recent_finishers.map((f) => (
        <ARow key={f.entrant_id} left={<BibBadge bib={f.bib_no} />} title={f.full_name} sub={`${hms(f.finish_at)}`} right={<AT size={16} weight="900" num>{f.time ?? '–'}</AT>} />
      )) : <AEmpty emoji="🏁" title="Nobody has finished yet" />}

      <ASection title="Publication" />
      <ACard style={{ gap: 8 }}>
        <AT size={15} weight="800">{D.publication ? `${D.publication.label} · version ${D.publication.version}` : 'Not published'}</AT>
        <AT size={13} color={A.mute}>{D.publication ? `${D.publication.finishers} finishers · ${dayTime(D.publication.published_at)}` : 'The public page shows results only after a publication.'}{D.unpublished_changes ? ` · ${D.unpublished_changes} result${D.unpublished_changes === 1 ? '' : 's'} changed since` : ''}</AT>
        {access.chief ? (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {!D.final ? <ABtn small title="Publish provisional" tone="neon" onPress={() => setPublish('provisional')} /> : null}
            {!D.final ? <ABtn small title="Publish final" tone="lime" onPress={() => setPublish('final')} /> : <ABtn small title="Publish corrected" tone="lime" onPress={() => setPublish('corrected')} />}
          </View>
        ) : null}
      </ACard>

      <ReasonSheet visible={!!gun} onClose={() => setGun(null)} title={gun ? `Gun: ${gun.name}` : ''} sub={gun?.gun_at ? 'A gun time is already recorded. Say why it changes.' : 'Records the gun time as now and starts the wave.'} presets={['Gun fired', 'Delayed start', 'Corrected after video check']} requireReason={!!gun?.gun_at} confirmLabel="Record gun" tone="live"
        onConfirm={async (reason) => { await doIt(() => api.post(`/race-waves/${gun.id}/gun`, { reason: reason || undefined }), 'Wave started'); setGun(null); }} />
      <ReasonSheet visible={closing} onClose={() => setClosing(false)} title="Close out the race" sub="Entrants who never started become DNS and those who started without finishing become DNF, with the official as the source." presets={['Race complete — closing out']} requireReason={false} confirmLabel="Close out" tone="live"
        onConfirm={async () => { await doIt(() => api.post(`/races/${id}/close-out`, { dry_run: false }), (r) => `DNS ${r.dns} · DNF ${r.dnf}`); setClosing(false); }} />
      <ReasonSheet visible={!!publish} onClose={() => setPublish(null)} title={publish ? `Publish ${publish} results` : ''} sub={publish === 'provisional' ? 'The public page is labelled provisional and can change.' : 'This freezes a snapshot with its provenance. Anything open must be settled first.'} presets={publish === 'corrected' ? ['Corrections approved by the officials'] : ['Results checked by the chief official']} requireReason={false} confirmLabel="Publish" tone="live"
        onConfirm={async (note) => {
          try { const r = await api.post(`/races/${id}/publications`, { label: publish, note: note || undefined }); toast(`Published ${r.label} v${r.version}`); reload(); }
          catch (x) { toast(x.status === 409 && x.details ? `Open items: ${Object.entries(x.details).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}` : '' + x.message); }
          setPublish(null);
        }} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------- entrants

function EntrantsTab({ id, R, D, reload, toast, access }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [ver, setVer] = useState(0);
  const [pages, setPages] = useState({ items: [], next: null, key: '' });
  const [more, setMore] = useState(false);
  const drawer = useEntrantDrawer(R, access, () => { setVer((x) => x + 1); reload(); }, toast);
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState(null);     // 'entrants' | 'chips' | 'bibs'
  const filters = [['all', 'All'], ['bib', 'No bib'], ['chip', 'No chip'], ['wave', 'No wave'], ['dns', 'DNS'], ['dnf', 'DNF'], ['dq', 'DQ']];
  const query = (after) => ({ limit: 50, ...(q.trim() ? { q: q.trim() } : {}), ...(filter === 'bib' || filter === 'chip' || filter === 'wave' ? { missing: filter } : filter !== 'all' ? { state: filter } : {}), ...(after ? { after } : {}) });
  const key = `${q}|${filter}|${ver}`;
  const list = useLoad(async () => { const r = await api.get(`/races/${id}/entrants`, query()); setPages({ items: r.items, next: r.next, key }); return r; }, [id, q, filter, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { setVer((x) => x + 1); reload(); };
  const loadMore = async () => { setMore(true); try { const r = await api.get(`/races/${id}/entrants`, query(pages.next)); setPages((p) => ({ ...p, items: [...p.items, ...r.items], next: r.next })); } catch (e) { fail(toast)(e); } finally { setMore(false); } };
  return (
    <>
      <ACard pad={12} style={{ gap: 10 }}>
        <TextInput value={q} onChangeText={setQ} placeholder="Find by bib, chip or name" placeholderTextColor={A.mute} accessibilityLabel="Find an entrant by bib, chip or name" autoCapitalize="none"
          style={{ minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: A.line, backgroundColor: A.panel2, color: A.ink, paddingHorizontal: 14, fontSize: 16 }} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{filters.map(([k, label]) => <AChip key={k} label={label} active={filter === k} onPress={() => setFilter(k)} />)}</View>
      </ACard>
      {access.organizer ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <ABtn small title="＋ Add entrant" onPress={() => setAdding(true)} />
          <ABtn small tone="ghost" title="Import list" onPress={() => setBulk('entrants')} />
          <ABtn small tone="ghost" title="Assign bibs" onPress={() => setBulk('bibs')} />
          <ABtn small tone="ghost" title="Import chips" onPress={() => setBulk('chips')} />
        </View>
      ) : null}
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
      {pages.items.map((e) => (
        <ARow key={e.id} onPress={() => drawer.open(e)} left={<BibBadge bib={e.bib_no} />} title={e.full_name}
          sub={[e.club, e.category, e.wave, e.chip_ref ? null : 'no chip'].filter(Boolean).join(' · ') || 'No wave or category yet'}
          right={<ATag label={e.race_status} tone={STATUS_TONE[e.race_status] ?? A.violet} />} />
      ))}
      {!list.loading && !pages.items.length ? <AEmpty emoji="🎽" title={q || filter !== 'all' ? 'Nobody matches' : 'No entrants yet'} sub={access.organizer && !q && filter === 'all' ? 'Add entrants one by one, let people enter themselves, or import the registration list.' : undefined} /> : null}
      {pages.next ? <ABtn title={more ? 'Loading…' : 'Load more'} tone="ghost" onPress={loadMore} loading={more} /> : null}

      {drawer.node}
      <AddEntrant visible={adding} onClose={() => setAdding(false)} id={id} R={R} onDone={refresh} />
      <BulkSheet kind={bulk} onClose={() => setBulk(null)} id={id} onDone={refresh} toast={toast} />
    </>
  );
}

/** One drawer for an entrant, opened from the entrant list, an exception, a result or a review: details, history and every action the desk has. */
function useEntrantDrawer(R, access, onChanged, toast) {
  const [entrant, setEntrant] = useState(null);
  const [act, setAct] = useState(null);       // { kind, entrant }
  const open = async (e) => {
    if (e && typeof e === 'object' && e.full_name) return setEntrant(e);
    try { setEntrant((await api.get(`/race-entrants/${typeof e === 'object' ? e.id : e}`)).entrant); } catch (x) { fail(toast)(x); }
  };
  const node = (
    <>
      <EntrantSheet entrant={entrant} access={access} onClose={() => setEntrant(null)} onAct={(kind) => { setAct({ kind, entrant }); setEntrant(null); }} />
      <EntrantActions act={act} R={R} onClose={() => setAct(null)} onDone={onChanged} />
    </>
  );
  return { open, node };
}

function EntrantSheet({ entrant, access, onClose, onAct }) {
  const det = useLoad(() => (entrant ? api.get(`/race-entrants/${entrant.id}`) : Promise.resolve(null)), [entrant?.id]);
  const code = useLoad(() => (entrant?.bib_no ? api.get(`/race-entrants/${entrant.id}/bib-code`) : Promise.resolve(null)), [entrant?.id, entrant?.bib_no]);
  const d = det.data;
  const live = d?.results?.[0];
  return (
    <Sheet visible={!!entrant} onClose={onClose} title={entrant ? `${entrant.bib_no ? `#${entrant.bib_no} ` : ''}${entrant.full_name}` : ''}>
      {entrant ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <ATag label={entrant.race_status} tone={STATUS_TONE[entrant.race_status] ?? A.violet} />
            {entrant.category ? <ATag label={entrant.category} tone={A.cyan} /> : null}
            {entrant.club ? <ATag label={entrant.club} tone={A.mute} /> : null}
            {entrant.wave ? <ATag label={entrant.wave} tone={A.violet} /> : <ATag label="no wave" tone={A.sun} />}
            <ATag label={entrant.chip_ref ? `chip ${entrant.chip_ref}` : 'no chip'} tone={entrant.chip_ref ? A.green : A.sun} />
          </View>
          {live ? <T color={c.mute}>Latest result v{live.version}: {live.official_time_ms != null ? ms2(live.official_time_ms) : 'no official time'} · {live.race_status}{live.flags?.length ? ` · ${live.flags.join(', ')}` : ''}</T> : null}
          {code.data ? <T size={12} color={c.mute}>Bib code {code.data.payload}</T> : null}
          {d?.tags?.length ? (<>
            <T weight="700">Bib & chip history</T>
            {d.tags.map((t) => <T key={t.id} size={13} color={c.mute}>{t.kind} {t.ref} · {t.state}{t.reason ? ` (${t.reason})` : ''}</T>)}
          </>) : null}
          {d?.status_history?.length ? (<>
            <T weight="700">Status history</T>
            {d.status_history.slice(-5).map((h) => <T key={h.id} size={13} color={c.mute}>{h.from_status} → {h.to_status} · {h.source}{h.reason ? ` · ${h.reason}` : ''}</T>)}
          </>) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <ABtn small title="Status" tone="live" onPress={() => onAct('status')} />
            <ABtn small title="Manual read" tone="neon" onPress={() => onAct('read')} />
            <ABtn small title="Replace chip" tone="ghost" onPress={() => onAct('chip')} />
            {entrant.bib_no ? <ABtn small title="Reprint / lost bib" tone="ghost" onPress={() => onAct('bib')} /> : <ABtn small title="Give a bib" tone="ghost" onPress={() => onAct('givebib')} />}
            {access.organizer ? <ABtn small title="Move wave" tone="ghost" onPress={() => onAct('wave')} /> : null}
            {access.organizer ? <ABtn small title="Category" tone="ghost" onPress={() => onAct('category')} /> : null}
            <ABtn small title="Propose correction" tone="sun" onPress={() => onAct('correction')} />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

function EntrantActions({ act, R, onClose, onDone }) {
  const e = act?.entrant;
  const close = () => onClose();
  const done = (msg) => { onDone(); return msg; };
  if (!act) return null;
  const waveOpts = (R.waves ?? []).filter((w) => ['open'].includes(w.status)).map((w) => ({ value: w.id, label: `${w.name} (${w.capacity - w.assigned} left)` }));
  const cps = (R.course?.checkpoints ?? []).map((k) => ({ value: k.code, label: k.label }));
  const statusOpts = (R.statuses ?? []).filter((s) => s !== 'started' && s !== 'finished').map((s) => ({ value: s, label: s === 'registered' ? 'Reinstate' : s.toUpperCase() }));
  const sourceOpts = SOURCES.map((s) => ({ value: s, label: s }));
  switch (act.kind) {
    case 'status': return <FormSheet visible onClose={close} title={`Status: ${e.full_name}`} submitLabel="Record status" fields={[
      { key: 'status', label: 'Status', type: 'chips', options: statusOpts, default: 'dnf' }, { key: 'source', label: 'Source', type: 'chips', options: sourceOpts, default: 'official' },
      { key: 'reason', label: 'Reason (kept in the status history)', type: 'multiline', hint: 'DQ, cutoff and reinstatement need a chief official. DNS is refused if timing shows they started.' }]}
      onSubmit={async (v) => { await api.post(`/race-entrants/${e.id}/status`, v); return done('Status recorded'); }} />;
    case 'read': return <FormSheet visible onClose={close} title={`Manual read: ${e.full_name}`} submitLabel="Record read" fields={[
      { key: 'checkpoint', label: 'Checkpoint', type: 'chips', options: cps, default: cps[cps.length - 1]?.value },
      { key: 'now', label: 'At this moment', type: 'switch', default: true }, { key: 'date', label: 'Date', type: 'date', show: (v) => !v.now, max: nowDate() }, { key: 'time', label: 'Time', type: 'time', step: 1, show: (v) => !v.now }]}
      onSubmit={async (v) => { await api.post(`/race-entrants/${e.id}/manual-reads`, { checkpoint: v.checkpoint, ...(v.now ? {} : { observed_at: localIso(v.date, v.time) }) }); return done('Read recorded as an official manual read'); }} />;
    case 'chip': return <FormSheet visible onClose={close} title={`Replace chip: ${e.full_name}`} submitLabel={e.chip_ref ? 'Reissue chip' : 'Assign chip'} fields={[
      { key: 'ref', label: 'New chip number', placeholder: 'Scan or type the chip id' },
      ...(e.chip_ref ? [{ key: 'reason', label: 'Why', type: 'chips', options: [{ value: 'lost', label: 'Lost' }, { value: 'damaged', label: 'Damaged' }, { value: 'wrong', label: 'Wrong chip' }], default: 'damaged' }, { key: 'swapped_ago', label: 'Swapped how long ago', type: 'stepper', min: 0, max: 600, step: 5, suffix: ' min', default: 0, hint: 'Reads of the old chip before the swap and of the new chip after it all count for this entrant.' }] : [])]}
      onSubmit={async (v) => {
        if (!e.chip_ref) await api.post(`/race-entrants/${e.id}/tags`, { kind: 'chip', ref: v.ref });
        else await api.post(`/race-entrants/${e.id}/tags/reissue`, { kind: 'chip', reason: v.reason, new_ref: v.ref, ...(v.swapped_ago ? { effective_at: new Date(Date.now() - v.swapped_ago * 60000).toISOString() } : {}) });
        return done('Chip saved — still one entrant, one result');
      }} />;
    case 'bib': return <FormSheet visible onClose={close} title={`Bib #${e.bib_no}`} submitLabel="Reissue bib" fields={[
      { key: 'reason', label: 'Why', type: 'chips', options: [{ value: 'lost', label: 'Lost' }, { value: 'damaged', label: 'Damaged' }, { value: 'wrong', label: 'Wrong number' }], default: 'lost' },
      { key: 'new_ref', label: 'New number (leave empty to reprint the same)', optional: true }]}
      onSubmit={async (v) => { await api.post(`/race-entrants/${e.id}/tags/reissue`, { kind: 'bib', reason: v.reason, ...(v.new_ref ? { new_ref: v.new_ref } : {}) }); return done('Bib reissued'); }} />;
    case 'givebib': return <FormSheet visible onClose={close} title={`Bib for ${e.full_name}`} submitLabel="Assign" fields={[{ key: 'ref', label: 'Bib number' }]}
      onSubmit={async (v) => { await api.post(`/race-entrants/${e.id}/tags`, { kind: 'bib', ref: v.ref }); return done('Bib assigned'); }} />;
    case 'wave': return <FormSheet visible onClose={close} title={`Wave for ${e.full_name}`} submitLabel="Move" fields={[
      { key: 'wave', label: 'Wave', type: 'chips', options: waveOpts, default: waveOpts[0]?.value }, { key: 'reason', label: 'Reason (the entrant is told)', optional: true }]}
      onSubmit={async (v) => { await api.post(`/race-waves/${v.wave}/entrants`, { entrant_ids: [e.id], reason: v.reason || undefined }); return done('Wave changed and entrant notified'); }} />;
    case 'category': return <FormSheet visible onClose={close} title={`Category for ${e.full_name}`} submitLabel="Save" fields={[
      { key: 'category_id', label: 'Declared category', type: 'chips', optional: true, options: [{ value: null, label: 'None' }, ...(R.categories ?? []).map((k) => ({ value: k.id, label: k.name }))], hint: 'Always an explicit choice. Never worked out from a name.' }]}
      onSubmit={async (v) => { await api.patch(`/race-entrants/${e.id}`, { category_id: v.category_id ?? null }); return done('Category saved'); }} />;
    case 'correction': return <CorrectionForm e={e} cps={cps} onClose={close} onDone={done} />;
    default: return null;
  }
}

function CorrectionForm({ e, cps, onClose, onDone }) {
  const kinds = [{ value: 'adjustment', label: 'Time penalty / adjustment' }, { value: 'use_gun_time', label: 'Rank on gun time' }, { value: 'manual_read', label: 'Add a read' }, { value: 'recompute', label: 'Accept late evidence' }, { value: 'status', label: 'Change status' }];
  return (
    <FormSheet visible onClose={onClose} title={`Correction: ${e.full_name}`} submitLabel="Propose" notice="Nothing changes until a chief official approves it. The raw reads are never edited."
      fields={[
        { key: 'kind', label: 'What', type: 'chips', options: kinds, default: 'adjustment' },
        { key: 'seconds', label: 'Seconds (+ penalty, − credit)', type: 'stepper', min: -600, max: 600, step: 5, suffix: ' s', default: 30, show: (v) => v.kind === 'adjustment' },
        { key: 'label', label: 'Label shown on the result', placeholder: 'Drafting, 30 s', show: (v) => v.kind === 'adjustment' },
        { key: 'checkpoint', label: 'Checkpoint', type: 'chips', options: cps, show: (v) => v.kind === 'manual_read', default: cps[cps.length - 1]?.value },
        { key: 'date', label: 'Date', type: 'date', show: (v) => v.kind === 'manual_read', max: nowDate() }, { key: 'time', label: 'Time', type: 'time', step: 1, show: (v) => v.kind === 'manual_read' },
        { key: 'status', label: 'New status', type: 'chips', options: ['dns', 'dnf', 'dq', 'cutoff', 'registered'].map((s) => ({ value: s, label: s })), show: (v) => v.kind === 'status', default: 'dnf' },
        { key: 'reason', label: 'Reason and evidence (stored encrypted)', type: 'multiline' },
      ]}
      onSubmit={async (v) => {
        const payload = v.kind === 'adjustment' ? { ms: v.seconds * 1000, label: v.label } : v.kind === 'manual_read' ? { checkpoint: v.checkpoint, observed_at: localIso(v.date, v.time) } : v.kind === 'status' ? { status: v.status, source: 'official' } : {};
        await api.post(`/race-entrants/${e.id}/corrections`, { kind: v.kind, payload, reason: v.reason });
        return onDone('Correction proposed — waiting for a chief official');
      }} />
  );
}

function AddEntrant({ visible, onClose, id, R, onDone }) {
  const cats = R.categories ?? [];
  return (
    <FormSheet visible={visible} onClose={onClose} title="Add an entrant" submitLabel="Register"
      fields={[
        { key: 'user_id', label: 'Person with an account', type: 'entity', entityKind: 'person', optional: true, noun: 'person', hint: 'Pick an existing member, or leave empty to add a guest.' },
        { key: 'full_name', label: 'Guest name', optional: true, show: (v) => !v.user_id },
        { key: 'gender', label: 'Declared gender', type: 'chips', optional: true, options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }], hint: 'Used only for the race and category gender rules. Never guessed.' },
        { key: 'club', label: 'Club / team', optional: true },
        ...(cats.length ? [{ key: 'category_id', label: 'Category', type: 'chips', optional: true, options: cats.map((k) => ({ value: k.id, label: k.name })) }] : []),
        { key: 'name_public', label: 'Agrees to a public name on the results', type: 'switch', default: false },
      ]}
      onSubmit={async (v) => { await api.post(`/races/${id}/entrants`, { ...v, user_id: v.user_id || undefined }); onDone(); return 'Entrant registered'; }} />
  );
}

/** Bulk entrant list, chip list and bib numbering: always a dry run first, then confirm. */
function BulkSheet({ kind, onClose, id, onDone, toast }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [rep, setRep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState(1);
  const [order, setOrder] = useState('registration');
  const path = kind === 'entrants' ? `/races/${id}/entrants/import` : kind === 'chips' ? `/races/${id}/chips/import` : `/races/${id}/bibs/auto`;
  const body = (dry) => (kind === 'bibs' ? { start, order, dry_run: dry } : { csv: text, dry_run: dry });
  const reset = () => { setText(''); setName(''); setRep(null); onClose(); };
  const pick = async () => { try { const f = await pickText(); if (f) { setText(f.text); setName(f.name); setRep(null); } } catch (e) { fail(toast)(e); } };
  const run = async (dry) => {
    setBusy(true);
    try { const r = await api.post(path, body(dry)); setRep(r); if (!dry) { toast(kind === 'bibs' ? `${r.assigned} bibs assigned` : `${r.created ?? r.assigned} imported`); onDone(); reset(); } }
    catch (e) { setRep(e.details ? { errors: e.details.errors, rejected: e.details.rejected } : null); fail(toast)(e); } finally { setBusy(false); }
  };
  const need = kind === 'entrants' ? 'external_ref, full_name, gender, club, category, wave, bib, chip, seed_s' : 'bib, chip';
  return (
    <Sheet visible={!!kind} onClose={reset} title={kind === 'entrants' ? 'Import the entry list' : kind === 'chips' ? 'Import chip numbers' : 'Assign bib numbers'}>
      {kind === 'bibs' ? (
        <>
          <T color={c.mute}>Numbers are given in order to entrants who have none, skipping any already in use.</T>
          <Counter label="First bib number" value={start} onChange={setStart} min={0} max={999999} step={1} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{[['registration', 'Registration order'], ['wave_seed', 'By wave, then seed']].map(([k, l]) => <AChip key={k} label={l} active={order === k} onPress={() => setOrder(k)} />)}</View>
        </>
      ) : (
        <>
          <T color={c.mute}>CSV with a header row: {need}. {kind === 'entrants' ? 'The external_ref makes importing the same list twice safe.' : ''}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <ABtn small title="Choose a CSV file" onPress={pick} />
            {name ? <T size={13} color={c.mute}>{name} · {text.split(/\r?\n/).filter(Boolean).length - 1} rows</T> : null}
          </View>
          <Field label="…or paste CSV" value={text} onChangeText={(x) => { setText(x); setRep(null); }} multiline minHeight={110} placeholder={`${need}\n`} />
        </>
      )}
      {rep ? (
        <ACard tone={rep.errors?.length ? A.orange : A.green} style={{ gap: 4 }}>
          <AT size={14} weight="800">{rep.dry_run === false ? 'Done' : 'Dry run'}: {rep.will_create ?? rep.will_assign ?? rep.assigned ?? 0} will be {kind === 'chips' ? 'paired' : kind === 'bibs' ? 'numbered' : 'created'}{rep.unchanged ? ` · ${rep.unchanged} already registered` : ''}{rep.rejected ? ` · ${rep.rejected} rows need fixing` : ''}</AT>
          {kind === 'bibs' && rep.first ? <AT size={13} color={A.mute}>{rep.first} … {rep.last}</AT> : null}
          {(rep.errors ?? []).slice(0, 6).map((x, i) => <AT key={i} size={12.5} color={A.mute}>Row {x.row}: {x.message}</AT>)}
        </ACard>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ABtn title="Check first" tone="ghost" loading={busy} onPress={() => run(true)} disabled={kind !== 'bibs' && !text.trim()} style={{ flex: 1 }} />
        <ABtn title="Import now" loading={busy} onPress={() => run(false)} disabled={(kind !== 'bibs' && !text.trim()) || !rep || !!rep.errors?.length} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------- waves, categories, course

function WavesTab({ id, R, reload, toast, access }) {
  const doIt = useDo(toast, reload);
  const [wave, setWave] = useState(null);       // null | {} (new) | wave
  const [auto, setAuto] = useState(false);
  const [cat, setCat] = useState(false);
  const [course, setCourse] = useState(false);
  const [rep, setRep] = useState(null);
  const org = access.organizer;
  const runAuto = async (strategy, dry) => { try { const r = await api.post(`/races/${id}/waves/auto`, { strategy, dry_run: dry }); setRep({ strategy, ...r }); if (!dry) { toast(`${r.placed} placed · ${r.notified} notified`); reload(); setAuto(false); setRep(null); } } catch (e) { fail(toast)(e); } };
  return (
    <>
      <ASection title="Waves, corrals & start groups" sub="Capacity is hard. Moves keep their history and tell the entrant." />
      {R.waves.map((w) => (
        <ACard key={w.id} pad={14} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}><AT size={16} weight="900">{w.name}</AT><AT size={12.5} color={A.mute}>{dayTime(w.start_at)} · {w.basis}{w.basis_note ? ` — ${w.basis_note}` : ''}</AT></View>
            <ATag label={w.status} tone={w.status === 'started' ? A.green : A.cyan} />
          </View>
          <ABar pct={(w.assigned / w.capacity) * 100} color={w.assigned >= w.capacity ? A.orange : A.cyan} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <AT size={12.5} color={A.mute} num>{w.assigned} / {w.capacity}</AT>
            {org && w.status !== 'started' ? <ABtn small tone="ghost" title="Edit" onPress={() => setWave(w)} /> : null}
          </View>
        </ACard>
      ))}
      {!R.waves.length ? <AEmpty emoji="🚦" title="No waves yet" sub="Create a wave for each start group, with its capacity and start time." /> : null}
      {org ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ABtn small title="＋ New wave" onPress={() => setWave({})} /><ABtn small tone="ghost" title="Place entrants automatically" onPress={() => setAuto(true)} /></View> : null}

      <ASection title="Categories" sub="Declared by the organiser; awards use only these and the declared gender" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{R.categories.map((k) => <ATag key={k.id} label={`${k.name} · ${k.entrants}`} tone={A.cyan} />)}</View>
      {!R.categories.length ? <T color={A.mute}>No categories — overall and gender classifications still work.</T> : null}
      {org ? <ABtn small tone="ghost" title="＋ Category" onPress={() => setCat(true)} style={{ alignSelf: 'flex-start' }} /> : null}

      <ASection title="Course & checkpoints" sub="Competition timing points, not navigation" />
      {R.course ? (
        <ACard style={{ gap: 6 }}>
          <AT size={15} weight="800">{R.course.name} · v{R.course.version}</AT>
          {R.course.checkpoints.map((k) => (
            <View key={k.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <ATag label={k.code} tone={k.kind === 'finish' ? A.green : k.kind === 'start' ? A.cyan : A.violet} />
              <AT size={13.5} style={{ flex: 1 }}>{k.label}</AT>
              <AT size={13} color={A.mute} num>{(Number(k.distance_m) / 1000).toFixed(k.distance_m % 1000 ? 2 : 0)} km{k.cutoff_s ? ` · cutoff ${ms2(k.cutoff_s * 1000)}` : ''}</AT>
            </View>
          ))}
        </ACard>
      ) : <AEmpty emoji="🗺️" title="No published course" sub="Timing files can only be imported once the checkpoints are published." />}
      {R.draft_courses.map((d) => org ? <ARow key={d.id} title={`Draft v${d.version}: ${d.name}`} right={<ABtn small title="Publish" onPress={() => doIt(() => api.post(`/race-courses/${d.id}/publish`, {}), 'Course published')} />} /> : null)}
      {org ? <ABtn small tone="ghost" title={R.course ? 'New course version' : '＋ Define the course'} onPress={() => setCourse(true)} style={{ alignSelf: 'flex-start' }} /> : null}

      <WaveForm wave={wave} id={id} categories={R.categories} onClose={() => setWave(null)} onDone={reload} />
      <FormSheet visible={cat} onClose={() => setCat(false)} title="New category" submitLabel="Create" fields={[
        { key: 'name', label: 'Name', placeholder: 'Women 40-44' }, { key: 'kind', label: 'Kind', type: 'chips', options: [{ value: 'age_group', label: 'Age group' }, { value: 'open', label: 'Open' }, { value: 'para', label: 'Para' }, { value: 'custom', label: 'Custom' }], default: 'age_group' },
        { key: 'gender_rule', label: 'Open to', type: 'chips', options: [{ value: 'any', label: 'Anyone' }, { value: 'male', label: 'Men' }, { value: 'female', label: 'Women' }], default: 'any' },
        { key: 'eligibility_ref', label: 'Rule it comes from', optional: true, placeholder: 'Masters rules 12.3' }]}
        onSubmit={async (v) => { await api.post(`/races/${id}/categories`, v); reload(); return 'Category created'; }} />
      <Sheet visible={auto} onClose={() => { setAuto(false); setRep(null); }} title="Place entrants automatically">
        <T color={c.mute}>Fills open waves for entrants who have none. Anyone who does not fit is listed, never squeezed in.</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {[['seed', 'By declared seed (fastest first)'], ['category', 'By category wave'], ['fill', 'In registration order']].map(([k, l]) => <AChip key={k} label={l} active={rep?.strategy === k} onPress={() => runAuto(k, true)} />)}
        </View>
        {rep ? (<ACard style={{ gap: 4 }}>
          <AT size={14} weight="800">{rep.placed} would be placed · {rep.unplaced} do not fit</AT>
          {rep.waves.map((w) => <AT key={w.wave_id} size={12.5} color={A.mute}>{w.name}: +{w.will_add} ({w.free_after} places left)</AT>)}
        </ACard>) : null}
        <ABtn title="Apply" disabled={!rep || !rep.placed} onPress={() => runAuto(rep.strategy, false)} />
      </Sheet>
      <CourseSheet visible={course} onClose={() => setCourse(false)} id={id} onDone={reload} />
    </>
  );
}

function WaveForm({ wave, id, categories, onClose, onDone }) {
  const edit = !!wave?.id;
  const d0 = wave?.start_at ? new Date(wave.start_at) : null;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    <FormSheet visible={!!wave} onClose={onClose} title={edit ? `Edit ${wave.name}` : 'New wave'} submitLabel={edit ? 'Save' : 'Create wave'}
      initial={edit ? { name: wave.name, date: `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`, time: `${pad(d0.getHours())}:${pad(d0.getMinutes())}`, capacity: wave.capacity, basis: wave.basis, basis_note: wave.basis_note ?? '' } : { date: nowDate(), time: '08:00', capacity: 500, basis: 'organiser' }}
      fields={[
        { key: 'name', label: 'Name', placeholder: 'Wave A / Corral 1' }, { key: 'date', label: 'Start date', type: 'date' }, { key: 'time', label: 'Start time', type: 'time', step: 5 },
        { key: 'capacity', label: 'Capacity (hard limit)', type: 'stepper', min: 1, max: 100000, step: 50, suffix: ' places' },
        { key: 'basis', label: 'Built on', type: 'chips', options: [{ value: 'seed', label: 'Expected pace' }, { value: 'category', label: 'Category' }, { value: 'accessibility', label: 'Accessibility' }, { value: 'team', label: 'Team' }, { value: 'organiser', label: 'Organiser policy' }] },
        { key: 'basis_note', label: 'Seed / reference used', optional: true, placeholder: 'Predicted 10 km under 45:00' },
        ...(!edit && categories.length ? [{ key: 'category_id', label: 'Reserved for category', type: 'chips', optional: true, options: categories.map((k) => ({ value: k.id, label: k.name })) }] : []),
        ...(edit ? [{ key: 'reason', label: 'Why (entrants are told if the time moves)', optional: true }] : []),
      ]}
      onSubmit={async (v) => {
        const body = { name: v.name, start_at: localIso(v.date, v.time), capacity: v.capacity, basis: v.basis, basis_note: v.basis_note || undefined };
        if (edit) await api.patch(`/race-waves/${wave.id}`, { ...body, reason: v.reason || undefined }); else await api.post(`/races/${id}/waves`, { ...body, category_id: v.category_id || undefined });
        onDone(); return edit ? 'Wave updated' : 'Wave created';
      }} />
  );
}

/** Course builder: start, any number of split / lap points, finish. Distances in km with a stepper, cutoffs in minutes. */
function CourseSheet({ visible, onClose, id, onDone }) {
  const { toast } = useSession();
  const [name, setName] = useState('');
  const [total, setTotal] = useState(10);
  const [splits, setSplits] = useState([]);
  const [busy, setBusy] = useState(false);
  const addSplit = () => setSplits((s) => [...s, { code: `K${s.length + 1}`, label: `Split ${s.length + 1}`, kind: 'split', km: Math.min(total - 0.5, (s.at(-1)?.km ?? 0) + Math.max(0.5, Math.round(total / 4 * 2) / 2)), cutoff: 0 }]);
  const upd = (i, p) => setSplits((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const save = async (publish) => {
    setBusy(true);
    try {
      const cps = [{ code: 'START', label: 'Start', kind: 'start', distance_m: 0, read_rule: 'last' }, ...splits.map((s) => ({ code: s.code.toUpperCase().replace(/[^A-Z0-9_-]/g, ''), label: s.label, kind: s.kind, distance_m: Math.round(s.km * 1000), ...(s.cutoff ? { cutoff_s: s.cutoff * 60 } : {}) })), { code: 'FIN', label: 'Finish', kind: 'finish', distance_m: Math.round(total * 1000) }];
      const course = await api.post(`/races/${id}/courses`, { name: name || `${total} km`, total_distance_m: Math.round(total * 1000), checkpoints: cps });
      if (publish) await api.post(`/race-courses/${course.id}/publish`, {});
      toast(publish ? 'Course published' : 'Draft saved'); onDone(); onClose();
    } catch (e) { fail(toast)(e); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Define the course">
      <Field label="Course name" value={name} onChangeText={setName} placeholder="10 km city loop" />
      <Counter label="Total distance" value={total} onChange={setTotal} min={0.5} max={500} step={0.5} suffix=" km" />
      <T weight="700">Checkpoints between start and finish</T>
      {splits.map((s, i) => (
        <ACard key={i} pad={12} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Field label="Code" value={s.code} onChangeText={(x) => upd(i, { code: x })} maxLength={8} /></View>
            <View style={{ flex: 2 }}><Field label="Name" value={s.label} onChangeText={(x) => upd(i, { label: x })} /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{[['split', 'Split'], ['lap', 'Lap']].map(([k, l]) => <AChip key={k} label={l} active={s.kind === k} onPress={() => upd(i, { kind: k })} />)}</View>
          <Counter label="Distance" value={s.km} onChange={(x) => upd(i, { km: x })} min={0.1} max={Math.max(0.5, total - 0.1)} step={0.5} suffix=" km" />
          <Counter label="Cutoff (0 = none)" value={s.cutoff} onChange={(x) => upd(i, { cutoff: x })} min={0} max={1440} step={5} suffix=" min" />
          <ABtn small tone="ghost" title="Remove" onPress={() => setSplits((x) => x.filter((_, k) => k !== i))} style={{ alignSelf: 'flex-start' }} />
        </ACard>
      ))}
      <ABtn small tone="ghost" title="＋ Split or lap point" onPress={addSplit} style={{ alignSelf: 'flex-start' }} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ABtn title="Save draft" tone="ghost" loading={busy} onPress={() => save(false)} style={{ flex: 1 }} />
        <ABtn title="Publish" loading={busy} onPress={() => save(true)} style={{ flex: 1 }} />
      </View>
      <T size={12} color={c.mute}>A published course never changes: the next change is a new version, and each result remembers the version it used.</T>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------- timing

function TimingTab({ id, R, D, reload, toast, access }) {
  const doIt = useDo(toast, reload);
  const drawer = useEntrantDrawer(R, access, reload, toast);
  const ex = useLoad(() => api.get(`/races/${id}/exceptions`, { limit: 50 }), [id, D.exceptions.reduce((a, x) => a + x.n, 0), D.last_reconcile?.created_at]);
  const [src, setSrc] = useState(false);
  const [imp, setImp] = useState(false);
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const reconcile = async () => { setBusy(true); try { const r = await api.post(`/races/${id}/reconcile`, {}); toast(`${r.entrants} entrants · ${r.changed} updated · ${r.held_for_review} held for review`); reload(); ex.reload(); } catch (e) { fail(toast)(e); } finally { setBusy(false); } };
  return (
    <>
      <ASection title="Reconciliation" sub={D.last_reconcile ? `Last run ${dayTime(D.last_reconcile.created_at)} · ${D.last_reconcile.entrants} entrants` : 'Not run yet'} />
      <ACard tone={D.results_stale ? A.orange : undefined} style={{ gap: 8 }}>
        <AT size={13.5} color={A.mute}>Raw reads stay untouched. Splits, times and the ranking are derived from them — the same reads always give the same result, and running it again changes nothing.</AT>
        <ABtn title={D.results_stale ? 'Reconcile now' : 'Run again'} loading={busy} onPress={reconcile} style={{ alignSelf: 'flex-start' }} />
      </ACard>

      <ASection title="Timing sources" sub="Where reads come from" />
      {R.sources.map((s) => <ARow key={s.id} title={s.name} sub={`${s.kind.replace(/_/g, ' ')} · ${s.integration === 'manual' ? 'entered by officials' : 'file import'}${s.clock_offset_ms ? ` · clock ${s.clock_offset_ms > 0 ? '+' : ''}${s.clock_offset_ms} ms` : ''}`} />)}
      {!R.sources.length ? <AEmpty emoji="📡" title="No timing source yet" sub="Add a source (chip reads, finish line, scans), then import its file." /> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {access.chief ? <ABtn small tone="ghost" title="＋ Source" onPress={() => setSrc(true)} /> : null}
        <ABtn small title="Import a timing file" onPress={() => setImp(true)} disabled={!R.sources.length || !R.course} />
      </View>
      <T size={12} color={A.mute}>Files in the platform layout (CSV: chip, bib, checkpoint, observed_at, ref, device). No vendor hardware integration is claimed.</T>

      <ASection title="Exceptions" sub="Duplicate reads inside the window are handled automatically; these need a person" />
      {(ex.data?.items ?? []).map((x) => (
        <ARow key={x.id} onPress={x.entrant_id ? () => drawer.open(x.entrant_id) : undefined} left={x.bib_no ? <BibBadge bib={x.bib_no} /> : <View style={{ width: 52, height: 40, borderRadius: 10, backgroundColor: A.panel2, alignItems: 'center', justifyContent: 'center' }}><AT>📡</AT></View>}
          title={`${KIND_LABEL[x.kind] ?? x.kind} · ${x.full_name ?? 'unattributed read'}`} sub={(WHY[x.kind] ?? (() => ''))(x)}
          right={<View style={{ gap: 6 }}>
            {x.read_id ? <ABtn small tone="neon" title="Link" onPress={() => setLink(x)} /> : null}
            <ABtn small tone="ghost" title="Accept" onPress={() => doIt(async () => { await api.post(`/race-exceptions/${x.id}/resolve`, { resolution: 'accepted' }); ex.reload(); }, 'Accepted')} />
          </View>} />
      ))}
      {ex.data && !ex.data.items.length ? <AEmpty emoji="✅" title="No open exceptions" /> : null}
      <ManualRead id={id} R={R} onDone={() => { reload(); ex.reload(); }} />
      {drawer.node}
      <CrewCard eventId={R.race.event_id} access={access} toast={toast} />
      <SourceForm visible={src} onClose={() => setSrc(false)} id={id} onDone={reload} />
      <ImportReads visible={imp} onClose={() => setImp(false)} id={id} R={R} onDone={() => { reload(); ex.reload(); }} toast={toast} />
      <FormSheet visible={!!link} onClose={() => setLink(null)} title="Link this read to an entrant" submitLabel="Propose link" notice="A chief official approves the link; the read itself is never edited." fields={[{ key: 'bib', label: 'Bib number of the entrant' }, { key: 'reason', label: 'Why this read belongs to them', type: 'multiline' }]}
        onSubmit={async (v) => {
          const found = await api.get(`/races/${id}/find`, { q: v.bib });
          const hit = found.find((f) => f.bib_no?.toLowerCase() === v.bib.toLowerCase());
          if (!hit) throw new Error('No entrant with that bib');
          await api.post(`/race-entrants/${hit.id}/corrections`, { kind: 'link_read', payload: { read_id: link.read_id }, reason: v.reason, evidence_read_ids: [link.read_id] });
          return 'Link proposed — waiting for a chief official';
        }} />
    </>
  );
}

/** The timing crew (timekeepers, starters, judges, referees) are the event's existing crew: the same invitations, acceptance and release as the games programme. */
function CrewCard({ eventId, access, toast }) {
  const crew = useLoad(() => api.get(`/events/${eventId}/staff`), [eventId]);
  const [inv, setInv] = useState(false);
  const ROLES = ['timekeeper', 'starter', 'judge', 'referee', 'umpire', 'scorer'];
  const mine = (crew.data ?? []).filter((x) => ROLES.includes(x.role) && ['invited', 'accepted'].includes(x.status));
  return (
    <>
      <ASection title="Timing crew" sub="Timekeepers run the desk; judges and referees are the chief officials who approve corrections and publish" />
      {mine.map((x) => <ARow key={x.id} title={x.display_name} sub={`${x.role}${x.sport ? ` · ${x.sport}` : ''}`} right={<ATag label={x.status} />} />)}
      {crew.data && !mine.length ? <T color={A.mute}>No crew yet. Only you can run the desk until you invite someone.</T> : null}
      {access.organizer ? <ABtn small tone="ghost" title="＋ Invite crew" onPress={() => setInv(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={inv} onClose={() => setInv(false)} title="Invite timing crew" submitLabel="Send invitation" fields={[
        { key: 'role', label: 'Role', type: 'chips', options: ROLES.map((r) => ({ value: r, label: r })), default: 'timekeeper' },
        { key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', role: 'referee', noun: 'official', hint: 'Officials listed on the platform. They must accept before they can use the desk.' }]}
        onSubmit={async (v) => { await api.post(`/events/${eventId}/staff`, { user_id: v.user_id, role: v.role }); crew.reload(); toast('Invitation sent'); }} />
    </>
  );
}

function ManualRead({ id, R, onDone }) {
  const [open, setOpen] = useState(false);
  const cps = (R.course?.checkpoints ?? []).map((k) => ({ value: k.code, label: k.label }));
  if (!R.course) return null;
  return (
    <>
      <ABtn small tone="sun" title="✍️ Record a manual read" onPress={() => setOpen(true)} style={{ alignSelf: 'flex-start' }} />
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Manual official read" submitLabel="Record" notice="Use when a chip failed or a spotter saw the runner. It is stored as evidence from you." fields={[
        { key: 'bib', label: 'Bib number' }, { key: 'checkpoint', label: 'Checkpoint', type: 'chips', options: cps, default: cps[cps.length - 1]?.value }]}
        onSubmit={async (v) => {
          const found = await api.get(`/races/${id}/find`, { q: v.bib });
          const hit = found.find((f) => f.bib_no?.toLowerCase() === v.bib.toLowerCase());
          if (!hit) throw new Error('No entrant with that bib');
          await api.post(`/race-entrants/${hit.id}/manual-reads`, { checkpoint: v.checkpoint });
          onDone(); return `Read recorded for ${hit.full_name}`;
        }} />
    </>
  );
}

function SourceForm({ visible, onClose, id, onDone }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title="Timing source" submitLabel="Add source" fields={[
      { key: 'name', label: 'Name', placeholder: 'Finish gantry' },
      { key: 'kind', label: 'Kind', type: 'chips', options: [{ value: 'chip_reads', label: 'Chip reads' }, { value: 'checkpoint_scan', label: 'Checkpoint scans' }, { value: 'finish_system', label: 'Finish system' }, { value: 'batch_file', label: 'Batch file' }, { value: 'manual_official', label: 'Manual' }], default: 'chip_reads' },
      { key: 'provider_label', label: 'Provider or device (label only)', optional: true },
      { key: 'clock_offset_ms', label: 'Known clock error', type: 'stepper', min: -60000, max: 60000, step: 100, suffix: ' ms', default: 0, hint: 'Added to this device\'s times when reconciling. The raw read is never changed.' }]}
      onSubmit={async (v) => { await api.post(`/races/${id}/sources`, { ...v, integration: v.kind === 'manual_official' ? 'manual' : 'file_import' }); onDone(); return 'Source added'; }} />
  );
}

function ImportReads({ visible, onClose, id, R, onDone, toast }) {
  const [source, setSource] = useState(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [rep, setRep] = useState(null);
  const [busy, setBusy] = useState(false);
  const sid = source ?? R.sources[0]?.id;
  const reset = () => { setText(''); setName(''); setRep(null); onClose(); };
  const pick = async () => { try { const f = await pickText(); if (f) { setText(f.text); setName(f.name); setRep(null); } } catch (e) { fail(toast)(e); } };
  const run = async (dry) => {
    setBusy(true);
    try { const r = await api.post(`/races/${id}/reads/import`, { source_id: sid, csv: text, label: name || undefined, dry_run: dry }); setRep(r); if (!dry) { toast(r.already_imported ? 'That file was already imported — nothing new' : `${r.accepted} reads stored · ${r.duplicate} already known · ${r.rejected} rejected`); onDone(); } }
    catch (e) { fail(toast)(e); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={reset} title="Import a timing file">
      <T color={c.mute}>Importing the same file twice, or overlapping files, never double-counts a read. Late files are fine: results are marked out of date until you reconcile.</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{R.sources.map((s) => <AChip key={s.id} label={s.name} active={sid === s.id} onPress={() => setSource(s.id)} />)}</View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <ABtn small title="Choose a CSV file" onPress={pick} />{name ? <T size={13} color={c.mute}>{name} · {text.split(/\r?\n/).filter(Boolean).length - 1} reads</T> : null}
      </View>
      <Field label="…or paste CSV" value={text} onChangeText={(x) => { setText(x); setRep(null); }} multiline minHeight={110} placeholder={'chip,checkpoint,observed_at,ref\n'} />
      {rep ? (
        <ACard tone={rep.rejected ? A.orange : A.green} style={{ gap: 4 }}>
          <AT size={14} weight="800">{rep.dry_run ? `Check: ${rep.will_accept} new · ${rep.duplicate} already known · ${rep.rejected} rejected` : rep.already_imported ? 'Already imported' : `Stored ${rep.accepted} · ${rep.duplicate} known · ${rep.rejected} rejected`}</AT>
          {(rep.rejects ?? []).slice(0, 5).map((x, i) => <AT key={i} size={12.5} color={A.mute}>Row {x.row}: {x.message}</AT>)}
        </ACard>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ABtn title="Check first" tone="ghost" loading={busy} disabled={!text.trim() || !sid} onPress={() => run(true)} style={{ flex: 1 }} />
        <ABtn title="Import" loading={busy} disabled={!text.trim() || !sid} onPress={() => run(false)} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------- results

function ResultsTab({ id, R, D, toast, access }) {
  const drawer = useEntrantDrawer(R, access, () => {}, toast);
  const [view, setView] = useState('current');
  const [cls, setCls] = useState('overall');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState({ items: [], next: null, label: null });
  const [more, setMore] = useState(false);
  const [exp, setExp] = useState(false);
  const classes = ['overall', 'gender:male', 'gender:female', ...R.categories.map((k) => `category:${k.id}`)];
  const query = (after) => ({ view, classification: cls, limit: 50, ...(q.trim() ? { q: q.trim() } : {}), ...(after ? { after } : {}) });
  const list = useLoad(async () => { const r = await api.get(`/races/${id}/results`, query()); setRows(r); return r; }, [id, view, cls, q, D.publication?.version, D.last_reconcile?.created_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = async () => { setMore(true); try { const r = await api.get(`/races/${id}/results`, query(rows.next)); setRows((p) => ({ ...r, items: [...p.items, ...r.items] })); } catch (e) { fail(toast)(e); } finally { setMore(false); } };
  const awards = useLoad(() => api.get(`/races/${id}/awards`), [id, D.publication?.version]);
  const exportCsv = async () => {
    setExp(true);
    try { let next, csv = ''; do { const r = await api.get(`/races/${id}/export`, { limit: 5000, ...(next ? { after: next } : {}) }); csv += (csv ? r.csv.split('\r\n').slice(1).join('\r\n') : r.csv); next = r.next; } while (next); await saveText(`${R.race.name.replace(/[^A-Za-z0-9]+/g, '-')}-results.csv`, csv); toast('Results exported'); }
    catch (e) { fail(toast)(e); } finally { setExp(false); }
  };
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <AChip label="Live (derived)" active={view === 'current'} onPress={() => setView('current')} /><AChip label={D.publication ? `Published · ${D.publication.label}` : 'Published'} active={view === 'published'} onPress={() => setView('published')} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{classes.map((k) => <AChip key={k} label={CLASS_LABEL(k, R.categories)} active={cls === k} onPress={() => setCls(k)} />)}</View>
      <TextInput value={q} onChangeText={setQ} placeholder="Find a bib or name" placeholderTextColor={A.mute} accessibilityLabel="Find a result" autoCapitalize="none"
        style={{ minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: A.line, backgroundColor: A.panel2, color: A.ink, paddingHorizontal: 14, fontSize: 16 }} />
      {rows.items.map((r) => (
        <ARow key={r.entrant_id} onPress={() => drawer.open(r.entrant_id)} left={<View style={{ width: 44, alignItems: 'center' }}><AT size={20} weight="900" num>{r.rank ?? '–'}</AT>{r.tied ? <AT size={10} color={A.sun}>TIE</AT> : null}</View>}
          title={`${r.bib_no ? `#${r.bib_no} ` : ''}${r.full_name}`} sub={[r.category, r.race_status !== 'finished' ? r.race_status : null, (r.flags ?? []).includes('needs_review') ? 'needs a decision' : (r.flags ?? []).includes('review') ? 'to review' : null].filter(Boolean).join(' · ') || undefined}
          right={<View style={{ alignItems: 'flex-end' }}><AT size={16} weight="900" num>{r.official_time ?? '–'}</AT>{r.gun_time && r.net_time && r.gun_time !== r.net_time ? <AT size={11} color={A.mute} num>gun {r.gun_time}</AT> : null}</View>} />
      ))}
      {!list.loading && !rows.items.length ? <AEmpty emoji="🏆" title={view === 'published' && !D.publication ? 'Nothing published yet' : 'No results yet'} sub="Results appear once timing has been imported and reconciled." /> : null}
      {rows.next ? <ABtn title={more ? 'Loading…' : 'Load more'} tone="ghost" loading={more} onPress={loadMore} /> : null}
 {drawer.node}
      {access.organizer && D.publication ? <ABtn small tone="ghost" title="Export CSV" loading={exp} onPress={exportCsv} style={{ alignSelf: 'flex-start' }} /> : null}

      {awards.data?.classifications?.length ? (
        <>
          <ASection title="Awards" sub={`${awards.data.publication.label} · policy v${awards.data.publication.policy_version}`} />
          {awards.data.classifications.map((g) => (
            <ACard key={g.classification} style={{ gap: 6 }}>
              <AT size={15} weight="900">{g.label}</AT>
              {g.awards.map((a) => <View key={`${g.classification}${a.rank}${a.entrant_id ?? a.house_id}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <AT size={16}>{a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : `${a.rank}.`}</AT><AT size={14} style={{ flex: 1 }}>{a.full_name ?? a.club}{a.bib_no ? ` · #${a.bib_no}` : ''}{a.tied ? ' (tie)' : ''}</AT><AT size={14} num weight="800">{a.time}</AT></View>)}
            </ACard>
          ))}
        </>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------------------------------------- reviews: cutoffs, corrections, protests

function ReviewsTab({ id, D, reload, toast, access }) {
  const cut = useLoad(() => api.get(`/races/${id}/cutoffs`, { review: 'pending', limit: 50 }), [id, D.cutoffs.pending]);
  const cor = useLoad(() => api.get(`/races/${id}/corrections`, { state: 'proposed', limit: 50 }), [id, D.corrections.proposed]);
  const pro = useLoad(() => (access.chief ? api.get(`/races/${id}/protests`, { status: 'open' }) : Promise.resolve([])), [id, D.corrections.open_protests]);
  const [ask, setAsk] = useState(null); // { kind: 'cutoff'|'correction'|'protest', row, decision }
  const refresh = () => { reload(); cut.reload(); cor.reload(); pro.reload(); };
  const decide = async (reason) => {
    const { kind, row, decision } = ask;
    try {
      if (kind === 'cutoff') await api.post(`/race-cutoffs/${row.id}/review`, { decision, reason, official_observation: decision === 'confirm' && row.outcome === 'no_evidence' });
      else if (kind === 'correction') await api.post(`/race-corrections/${row.id}/decision`, { decision, note: reason });
      else await api.post(`/race-protests/${row.id}/decision`, { decision, reason });
      toast('Decision recorded'); refresh();
    } catch (e) { fail(toast)(e); }
    setAsk(null);
  };
  const chief = access.chief;
  return (
    <>
      <ASection title="Cutoffs" sub="A missed cutoff is a read after the limit. No read at all is missing evidence, not a failure." />
      {(cut.data?.items ?? []).map((k) => (
        <ACard key={k.id} pad={12} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <BibBadge bib={k.bib_no} />
            <View style={{ flex: 1 }}><AT size={15} weight="800">{k.full_name}</AT><AT size={12.5} color={A.mute}>{k.label}: {k.outcome === 'no_evidence' ? 'no read at this checkpoint' : `${ms2(k.elapsed_ms)} against a ${ms2(k.cutoff_ms)} cutoff`}</AT></View>
            <ATag label={k.outcome === 'no_evidence' ? 'no evidence' : k.outcome} tone={k.outcome === 'missed' ? A.red : A.sun} />
          </View>
          {chief ? <View style={{ flexDirection: 'row', gap: 8 }}><ABtn small tone="live" title={k.outcome === 'no_evidence' ? 'Confirm (official saw it)' : 'Confirm missed'} onPress={() => setAsk({ kind: 'cutoff', row: k, decision: 'confirm' })} /><ABtn small tone="ghost" title="Waive" onPress={() => setAsk({ kind: 'cutoff', row: k, decision: 'waive' })} /></View> : null}
        </ACard>
      ))}
      {cut.data && !cut.data.items.length ? <AEmpty emoji="✅" title="No cutoff reviews waiting" /> : null}

      <ASection title="Corrections" sub="Every change to evidence or a result goes through a second official" />
      {(cor.data?.items ?? []).map((k) => (
        <ACard key={k.id} pad={12} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><BibBadge bib={k.bib_no} /><View style={{ flex: 1 }}><AT size={15} weight="800">{k.full_name}</AT><AT size={12.5} color={A.mute}>{k.kind.replace(/_/g, ' ')}{k.payload?.ms ? ` · ${k.payload.ms > 0 ? '+' : ''}${k.payload.ms / 1000} s` : ''}</AT></View></View>
          <AT size={13} color={A.mute}>{k.reason}</AT>
          {chief ? <View style={{ flexDirection: 'row', gap: 8 }}><ABtn small tone="lime" title="Approve" onPress={() => setAsk({ kind: 'correction', row: k, decision: 'approve' })} /><ABtn small tone="ghost" title="Reject" onPress={() => setAsk({ kind: 'correction', row: k, decision: 'reject' })} /></View> : null}
        </ACard>
      ))}
      {cor.data && !cor.data.items.length ? <AEmpty emoji="🧾" title="No corrections waiting" /> : null}

      {chief ? (
        <>
          <ASection title="Protests" sub="Opened through the platform's dispute cases" />
          {(pro.data ?? []).map((p) => (
            <ACard key={p.id} pad={12} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><BibBadge bib={p.bib_no} /><View style={{ flex: 1 }}><AT size={15} weight="800">{p.full_name}</AT><AT size={12.5} color={A.mute}>Case #{p.case_no} · {p.approved_corrections} approved correction{p.approved_corrections === 1 ? '' : 's'}</AT></View></View>
              <AT size={13} color={A.mute}>{p.statement}</AT>
              <View style={{ flexDirection: 'row', gap: 8 }}><ABtn small tone="lime" title="Uphold" onPress={() => setAsk({ kind: 'protest', row: p, decision: 'upheld' })} /><ABtn small tone="ghost" title="Reject" onPress={() => setAsk({ kind: 'protest', row: p, decision: 'rejected' })} /></View>
            </ACard>
          ))}
          {pro.data && !pro.data.length ? <AEmpty emoji="🤝" title="No open protests" /> : null}
        </>
      ) : null}
      <ReasonSheet visible={!!ask} onClose={() => setAsk(null)} title={ask ? `${ask.decision[0].toUpperCase()}${ask.decision.slice(1)}` : ''} sub="The reason is recorded with your name and shown to the people affected." presets={['Reviewed with a second official', 'Video evidence checked', 'Rule applied as published']} confirmLabel="Record decision" tone="live" onConfirm={decide} />
    </>
  );
}
