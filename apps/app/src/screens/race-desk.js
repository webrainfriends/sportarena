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
import { t, tEnum } from '../i18n';

const fail = (toast) => (e) => toast('' + (e?.message ?? e));
const hms = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '–');
const dayTime = (iso) => (iso ? new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
const localIso = (date, time) => new Date(`${date}T${time}:00`).toISOString();
const nowDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ms2 = (ms) => { if (ms === null || ms === undefined) return '–'; const abs = Math.abs(Number(ms)), h = Math.floor(abs / 3600000), m = Math.floor(abs / 60000) % 60, s = Math.floor(abs / 1000) % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`; };
const KIND_LABEL = {
  missing_read: t('rd.k_missing_read'), out_of_order: t('rd.k_out_of_order'), multiple_reads: t('rd.k_multiple_reads'), negative_time: t('rd.k_negative_time'), unknown_chip: t('rd.k_unknown_chip'), stale_chip: t('rd.k_stale_chip'),
  no_start_read: t('rd.k_no_start_read'), no_gun_time: t('rd.k_no_gun_time'), needs_review: t('rd.k_needs_review'), status_conflict: t('rd.k_status_conflict'), ambiguous_read: t('rd.k_ambiguous_read'),
};
const STATUS_TONE = { finished: A.green, started: A.cyan, registered: A.mute, dns: A.sun, dnf: A.orange, dq: A.red, cutoff: A.red };
const CLASS_LABEL = (cls, cats) => (cls === 'overall' ? t('enum.overall') : cls === 'gender:male' ? t('rd.men') : cls === 'gender:female' ? t('rd.women') : cats.find((k) => `category:${k.id}` === cls)?.name ?? cls);
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
  missing_read: (x) => t('rd.w_missing_read', { cp: x.checkpoint_code }),
  out_of_order: (x) => t('rd.w_out_of_order', { cp: x.checkpoint_code, after: x.detail?.after ?? t('rd.earlier_cp') }),
  multiple_reads: (x) => t('rd.w_multiple_reads', { cp: x.checkpoint_code }),
  negative_time: () => t('rd.w_negative_time'),
  unknown_chip: (x) => t('rd.w_unknown_chip', { chip: x.detail?.chip ?? x.detail?.bib ?? '' }),
  stale_chip: (x) => t('rd.w_stale_chip', { chip: x.detail?.chip ?? x.detail?.bib ?? '' }),
  no_start_read: () => t('rd.w_no_start_read'),
  no_gun_time: () => t('rd.w_no_gun_time'),
  needs_review: (x) => x.detail?.reason ?? t('rd.w_needs_review'),
  status_conflict: (x) => t('rd.w_status_conflict', { status: x.detail?.status ?? '', timing: x.detail?.timing ?? '' }),
};

const BibBadge = ({ bib, size = 52 }) => (
  <View accessibilityLabel={bib ? t('rd.bib_n', { n: bib }) : t('rd.no_bib')} style={{ minWidth: size, height: 40, borderRadius: 10, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: bib ? '#FFFFFF' : A.panel2, borderWidth: 1, borderColor: bib ? '#FFFFFF' : A.line }}>
    <AT size={bib ? 17 : 11} weight="900" color={bib ? '#23252F' : A.mute} num>{bib ?? t('rd.no_bib_caps')}</AT>
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
      <ASection title={t('nav.title.RaceDesk')} sub={t('rd.race_day_sub')} />
      {races.error ? <ErrorBox error={races.error} onRetry={races.reload} /> : null}
      {(races.data ?? []).map((r) => (
        <ARow key={r.id} onPress={() => push('RaceDesk', { id: r.id })} left={<View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: A.panel2 }}><AT size={22}>{r.emoji ?? '🏃'}</AT></View>}
          title={r.name} sub={t('rd.results_line', { sport: r.sport_name, result: r.result_label ? t('rd.results_of', { label: tEnum(r.result_label) }) : t('rd.no_results_published') })}
          right={<ATag label={r.public ? t('rd.public_on') : t('rd.public_off')} tone={r.public ? A.green : A.mute} />} />
      ))}
      {races.data && !races.data.length ? <AEmpty emoji="🏁" title={t('rd.no_race')} sub={isOrg ? t('rd.no_race_org') : t('rd.no_race_crew')} /> : null}
      {isOrg ? <ABtn title={t('rd.set_up_btn')} onPress={() => setSetup(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={setup} onClose={() => setSetup(false)} title={t('rd.set_up_title')} submitLabel={t('rd.create_race')}
        fields={[
          { key: 'name', label: t('rd.race_name'), placeholder: t('rd.race_name_ph') },
          { key: 'sport', label: t('cs.sport'), type: 'sport' },
          { key: 'gender', label: t('rd.open_to'), type: 'choice', options: [{ value: 'any', label: t('rd.everyone') }, { value: 'male', label: t('rd.men') }, { value: 'female', label: t('rd.women') }] },
          { key: 'time_basis', label: t('rd.ranked_on'), type: 'choice', options: [{ value: 'net', label: t('rd.net_time') }, { value: 'gun', label: t('rd.gun_time') }], hint: t('rd.basis_hint') },
          { key: 'allow_guests', label: t('rd.allow_guests'), type: 'switch', default: true },
          { key: 'public', label: t('rd.public_page'), type: 'switch', default: false },
        ]}
        onSubmit={async (v) => {
          const r = await api.post(`/events/${id}/races`, { name: v.name, sport: v.sport, gender: v.gender, rules: { time_basis: v.time_basis, allow_guests: v.allow_guests, public: { enabled: v.public, names: false, splits: false, categories: true } } });
          races.reload();
          push('RaceDesk', { id: r.race.id });
          return t('rd.race_created');
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
    { key: 'desk', label: t('rd.tab_desk'), icon: '🧭' },
    { key: 'entrants', label: t('rd.tab_entrants'), icon: '🎽', badge: D.readiness.entrants || undefined },
    { key: 'waves', label: t('rd.tab_waves'), icon: '🚦' },
    { key: 'timing', label: t('rd.tab_timing'), icon: '⏱️', badge: exceptions || undefined },
    { key: 'results', label: t('rd.tab_results'), icon: '🏆' },
    { key: 'reviews', label: t('rd.tab_reviews'), icon: '⚖️', badge: reviews || undefined },
  ];
  const rules = R.policy.rules;
  return (
    <AScreen>
      <AHero kicker={`${R.race.sport?.emoji ?? '🏃'} ${R.race.event_name}`} title={R.race.name} sub={t('rd.hero_sub', { basis: rules.time_basis === 'net' ? t('rd.net_time') : t('rd.gun_time'), window: rules.dedupe_window_s, policy: R.policy.version, course: R.course ? ` · ${R.course.name}` : ` · ${t('rd.no_course_yet')}` })} tone={AG.neon} emoji={R.race.sport?.emoji ?? '🏃'}>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <HeroTag label={D.publication ? t('rd.pub_tag', { label: tEnum(D.publication.label), v: D.publication.version }) : t('rd.nothing_published')} tone={D.final ? '#A7F3D0' : D.publication ? '#FDE68A' : '#FFFFFF'} />
          {D.results_stale ? <HeroTag label={t('rd.results_stale')} tone="#FDBA74" /> : null}
          <HeroTag label={R.access.organizer ? t('rd.role_org') : R.access.chief ? t('rd.role_chief') : t('rd.role_crew')} />
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
  const reconcile = () => doIt(() => api.post(`/races/${id}/reconcile`, {}), (r) => t('rd.reconciled', { e: r.entrants, c: r.changed, x: r.open_exceptions }));
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="🎽" value={D.readiness.entrants} label={t('rd.tab_entrants')} />
        <AStat icon="🏃" value={D.finish_queue.on_course} label={t('rd.running')} />
        <AStat icon="🏁" value={D.statuses.finished ?? 0} label={t('enum.finished')} />
        <AStat icon="🚫" value={['dns', 'dnf', 'dq', 'cutoff'].reduce((n, k) => n + (D.statuses[k] ?? 0), 0)} label={t('rd.out')} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {Object.entries(D.statuses).filter(([k]) => !['registered', 'started', 'finished'].includes(k)).map(([k, n]) => <ATag key={k} label={t('rd.status_n', { status: tEnum(k), n })} tone={STATUS_TONE[k] ?? A.violet} />)}
        {D.statuses.registered ? <ATag label={t('rd.not_started_n', { n: D.statuses.registered })} tone={A.mute} /> : null}
      </View>

      {D.results_stale && D.last_reconcile !== undefined ? (
        <ACard tone={A.orange} style={{ gap: 8 }}>
          <AT size={15} weight="800">{t('rd.stale_title')}</AT>
          <AT size={13} color={A.mute}>{t('rd.stale_sub')}</AT>
          <ABtn small title={t('rd.reconcile_now')} onPress={reconcile} style={{ alignSelf: 'flex-start' }} />
        </ACard>
      ) : null}

      <ASection title={t('rd.todo_next')} sub={D.todo.length ? t('rd.most_urgent') : t('rd.nothing_waiting')} />
      {D.todo.length === 0 ? <AEmpty emoji="✅" title={t('rd.all_clear')} sub={t('rd.all_clear_sub')} /> : D.todo.map((td) => (
        <ARow key={td.key} tone={td.severity === 'high' ? A.orange : undefined} title={td.label} right={<ATag label={td.count} tone={td.severity === 'high' ? A.orange : A.violet} />}
          onPress={() => (td.key === 'reconcile' ? reconcile() : td.key === 'unresolved' ? setClosing(true) : todoGo[td.key] && go(todoGo[td.key]))} />
      ))}

      <ASection title={t('rd.start_waves')} sub={t('rd.capacity_server')} />
      {D.waves.length === 0 ? <AEmpty emoji="🚦" title={t('rd.no_waves')} sub={t('rd.no_waves_sub')} action={t('rd.open_waves')} onAction={() => go('waves')} /> : D.waves.map((w) => (
        <ACard key={w.id} pad={14} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}><AT size={15} weight="800">{w.name}</AT><AT size={12.5} color={A.mute}>{dayTime(w.start_at)}{w.gun_at ? ` · ${t('rd.gun_at', { t: hms(w.gun_at) })}` : ''}</AT></View>
            <ATag label={tEnum(w.status)} tone={w.status === 'started' ? A.green : w.status === 'closed' ? A.sun : A.cyan} />
          </View>
          <ABar pct={(w.assigned / w.capacity) * 100} color={w.assigned >= w.capacity ? A.orange : A.cyan} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <AT size={12.5} color={A.mute} num>{t('rd.places_of', { a: w.assigned, c: w.capacity })}</AT>
            {w.status !== 'started' && w.status !== 'cancelled' ? <ABtn small title={t('rd.record_gun')} tone="live" onPress={() => setGun(w)} /> : null}
          </View>
        </ACard>
      ))}

      <ASection title={t('rd.timing_mats')} sub={t('rd.reads_per_cp')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {D.reads_per_checkpoint.length ? D.reads_per_checkpoint.map((x) => <AStat key={x.code} icon="📡" value={x.reads} label={`${x.code}${x.last_read ? ` · ${hm(x.last_read)}` : ''}`} />) : <AEmpty emoji="📡" title={t('rd.no_reads')} sub={t('rd.no_reads_sub')} />}
      </View>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <ATag label={t('rd.dup_reads', { n: D.duplicate_reads })} tone={A.mute} /><ATag label={t('rd.missing_reads_n', { n: D.missing_reads })} tone={D.missing_reads ? A.sun : A.mute} />
      </View>

      <ASection title={t('rd.finish_queue')} sub={t('rd.on_course', { n: D.finish_queue.on_course })} />
      {D.finish_queue.recent_finishers.length ? D.finish_queue.recent_finishers.map((f) => (
        <ARow key={f.entrant_id} left={<BibBadge bib={f.bib_no} />} title={f.full_name} sub={`${hms(f.finish_at)}`} right={<AT size={16} weight="900" num>{f.time ?? '–'}</AT>} />
      )) : <AEmpty emoji="🏁" title={t('rd.nobody_finished')} />}

      <ASection title={t('rd.publication')} />
      <ACard style={{ gap: 8 }}>
        <AT size={15} weight="800">{D.publication ? t('rd.pub_version', { label: tEnum(D.publication.label), v: D.publication.version }) : t('cs.not_published_tag')}</AT>
        <AT size={13} color={A.mute}>{D.publication ? t('rd.pub_line', { n: D.publication.finishers, when: dayTime(D.publication.published_at) }) : t('rd.pub_note')}{D.unpublished_changes ? ` · ${t(D.unpublished_changes === 1 ? 'rd.changed_one' : 'rd.changed_many', { n: D.unpublished_changes })}` : ''}</AT>
        {access.chief ? (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {!D.final ? <ABtn small title={t('rd.pub_prov')} tone="neon" onPress={() => setPublish('provisional')} /> : null}
            {!D.final ? <ABtn small title={t('rd.pub_final')} tone="lime" onPress={() => setPublish('final')} /> : <ABtn small title={t('rd.pub_corr')} tone="lime" onPress={() => setPublish('corrected')} />}
          </View>
        ) : null}
      </ACard>

      <ReasonSheet visible={!!gun} onClose={() => setGun(null)} title={gun ? t('rd.gun_title', { name: gun.name }) : ''} sub={gun?.gun_at ? t('rd.gun_sub_changed') : t('rd.gun_sub_new')} presets={[t('rd.preset_gun_fired'), t('rd.preset_delayed'), t('rd.preset_video')]} requireReason={!!gun?.gun_at} confirmLabel={t('rd.record_gun')} tone="live"
        onConfirm={async (reason) => { await doIt(() => api.post(`/race-waves/${gun.id}/gun`, { reason: reason || undefined }), t('rd.wave_started')); setGun(null); }} />
      <ReasonSheet visible={closing} onClose={() => setClosing(false)} title={t('rd.close_out')} sub={t('rd.close_out_sub')} presets={[t('rd.preset_complete')]} requireReason={false} confirmLabel={t('rd.close_out_btn')} tone="live"
        onConfirm={async () => { await doIt(() => api.post(`/races/${id}/close-out`, { dry_run: false }), (r) => t('rd.closed_out', { dns: r.dns, dnf: r.dnf })); setClosing(false); }} />
      <ReasonSheet visible={!!publish} onClose={() => setPublish(null)} title={publish ? t('rd.publish_title', { label: tEnum(publish) }) : ''} sub={publish === 'provisional' ? t('rd.pub_sub_prov') : t('rd.pub_sub_final')} presets={publish === 'corrected' ? [t('rd.preset_corr_ok')] : [t('rd.preset_chief_ok')]} requireReason={false} confirmLabel={t('rd.publish')} tone="live"
        onConfirm={async (note) => {
          try { const r = await api.post(`/races/${id}/publications`, { label: publish, note: note || undefined }); toast(t('rd.published_toast', { label: tEnum(r.label), v: r.version })); reload(); }
          catch (x) { toast(x.status === 409 && x.details ? t('rd.open_items', { list: Object.entries(x.details).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ') }) : '' + x.message); }
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
  const filters = [['all', t('common.all')], ['bib', t('rd.f_no_bib')], ['chip', t('rd.f_no_chip')], ['wave', t('rd.f_no_wave')], ['dns', t('enum.dns')], ['dnf', t('enum.dnf')], ['dq', t('enum.dq')]];
  const query = (after) => ({ limit: 50, ...(q.trim() ? { q: q.trim() } : {}), ...(filter === 'bib' || filter === 'chip' || filter === 'wave' ? { missing: filter } : filter !== 'all' ? { state: filter } : {}), ...(after ? { after } : {}) });
  const key = `${q}|${filter}|${ver}`;
  const list = useLoad(async () => { const r = await api.get(`/races/${id}/entrants`, query()); setPages({ items: r.items, next: r.next, key }); return r; }, [id, q, filter, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { setVer((x) => x + 1); reload(); };
  const loadMore = async () => { setMore(true); try { const r = await api.get(`/races/${id}/entrants`, query(pages.next)); setPages((p) => ({ ...p, items: [...p.items, ...r.items], next: r.next })); } catch (e) { fail(toast)(e); } finally { setMore(false); } };
  return (
    <>
      <ACard pad={12} style={{ gap: 10 }}>
        <TextInput value={q} onChangeText={setQ} placeholder={t('rd.find_ph')} placeholderTextColor={A.mute} accessibilityLabel={t('rd.find_a11y')} autoCapitalize="none"
          style={{ minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: A.line, backgroundColor: A.panel2, color: A.ink, paddingHorizontal: 14, fontSize: 16 }} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{filters.map(([k, label]) => <AChip key={k} label={label} active={filter === k} onPress={() => setFilter(k)} />)}</View>
      </ACard>
      {access.organizer ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <ABtn small title={t('rd.add_entrant')} onPress={() => setAdding(true)} />
          <ABtn small tone="ghost" title={t('rd.import_list')} onPress={() => setBulk('entrants')} />
          <ABtn small tone="ghost" title={t('rd.assign_bibs')} onPress={() => setBulk('bibs')} />
          <ABtn small tone="ghost" title={t('rd.import_chips')} onPress={() => setBulk('chips')} />
        </View>
      ) : null}
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
      {pages.items.map((e) => (
        <ARow key={e.id} onPress={() => drawer.open(e)} left={<BibBadge bib={e.bib_no} />} title={e.full_name}
          sub={[e.club, e.category, e.wave, e.chip_ref ? null : t('rd.no_chip_lc')].filter(Boolean).join(' · ') || t('rd.no_wave_cat')}
          right={<ATag label={tEnum(e.race_status)} tone={STATUS_TONE[e.race_status] ?? A.violet} />} />
      ))}
      {!list.loading && !pages.items.length ? <AEmpty emoji="🎽" title={q || filter !== 'all' ? t('rd.nobody_matches') : t('rd.no_entrants')} sub={access.organizer && !q && filter === 'all' ? t('rd.no_entrants_sub') : undefined} /> : null}
      {pages.next ? <ABtn title={more ? t('common.loading') : t('rd.load_more')} tone="ghost" onPress={loadMore} loading={more} /> : null}

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
            <ATag label={tEnum(entrant.race_status)} tone={STATUS_TONE[entrant.race_status] ?? A.violet} />
            {entrant.category ? <ATag label={entrant.category} tone={A.cyan} /> : null}
            {entrant.club ? <ATag label={entrant.club} tone={A.mute} /> : null}
            {entrant.wave ? <ATag label={entrant.wave} tone={A.violet} /> : <ATag label={t('rd.no_wave_lc')} tone={A.sun} />}
            <ATag label={entrant.chip_ref ? t('rd.chip_ref', { ref: entrant.chip_ref }) : t('rd.no_chip_lc')} tone={entrant.chip_ref ? A.green : A.sun} />
          </View>
          {live ? <T color={c.mute}>{t('rd.latest_result', { v: live.version, time: live.official_time_ms != null ? ms2(live.official_time_ms) : t('rd.no_official_time'), status: tEnum(live.race_status), flags: live.flags?.length ? ` · ${live.flags.join(', ')}` : '' })}</T> : null}
          {code.data ? <T size={12} color={c.mute}>{t('rd.bib_code', { payload: code.data.payload })}</T> : null}
          {d?.tags?.length ? (<>
            <T weight="700">{t('rd.bib_chip_history')}</T>
            {d.tags.map((tg) => <T key={tg.id} size={13} color={c.mute}>{tEnum(tg.kind)} {tg.ref} · {tEnum(tg.state)}{tg.reason ? ` (${tEnum(tg.reason)})` : ''}</T>)}
          </>) : null}
          {d?.status_history?.length ? (<>
            <T weight="700">{t('rd.status_history')}</T>
            {d.status_history.slice(-5).map((h) => <T key={h.id} size={13} color={c.mute}>{tEnum(h.from_status)} → {tEnum(h.to_status)} · {tEnum(h.source)}{h.reason ? ` · ${h.reason}` : ''}</T>)}
          </>) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <ABtn small title={t('cs.status')} tone="live" onPress={() => onAct('status')} />
            <ABtn small title={t('rd.manual_read')} tone="neon" onPress={() => onAct('read')} />
            <ABtn small title={t('rd.replace_chip')} tone="ghost" onPress={() => onAct('chip')} />
            {entrant.bib_no ? <ABtn small title={t('rd.reprint_bib')} tone="ghost" onPress={() => onAct('bib')} /> : <ABtn small title={t('rd.give_bib')} tone="ghost" onPress={() => onAct('givebib')} />}
            {access.organizer ? <ABtn small title={t('rd.move_wave')} tone="ghost" onPress={() => onAct('wave')} /> : null}
            {access.organizer ? <ABtn small title={t('cs.category')} tone="ghost" onPress={() => onAct('category')} /> : null}
            <ABtn small title={t('rd.propose_correction')} tone="sun" onPress={() => onAct('correction')} />
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
  const waveOpts = (R.waves ?? []).filter((w) => ['open'].includes(w.status)).map((w) => ({ value: w.id, label: t('rd.wave_left', { name: w.name, n: w.capacity - w.assigned }) }));
  const cps = (R.course?.checkpoints ?? []).map((k) => ({ value: k.code, label: k.label }));
  const statusOpts = (R.statuses ?? []).filter((s) => s !== 'started' && s !== 'finished').map((s) => ({ value: s, label: s === 'registered' ? t('rd.reinstate') : tEnum(s) }));
  const sourceOpts = SOURCES.map((s) => ({ value: s, label: tEnum(s) }));
  switch (act.kind) {
    case 'status': return <FormSheet visible onClose={close} title={t('rd.status_title', { name: e.full_name })} submitLabel={t('rd.record_status')} fields={[
      { key: 'status', label: t('cs.status'), type: 'chips', options: statusOpts, default: 'dnf' }, { key: 'source', label: t('rd.source'), type: 'chips', options: sourceOpts, default: 'official' },
      { key: 'reason', label: t('rd.reason_history'), type: 'multiline', hint: t('rd.status_hint') }]}
      onSubmit={async (v) => { await api.post(`/race-entrants/${e.id}/status`, v); return done(t('rd.status_recorded')); }} />;
    case 'read': return <FormSheet visible onClose={close} title={t('rd.manual_title', { name: e.full_name })} submitLabel={t('rd.record_read')} fields={[
      { key: 'checkpoint', label: t('rd.checkpoint'), type: 'chips', options: cps, default: cps[cps.length - 1]?.value },
      { key: 'now', label: t('rd.at_moment'), type: 'switch', default: true }, { key: 'date', label: t('cs.date'), type: 'date', show: (v) => !v.now, max: nowDate() }, { key: 'time', label: t('rd.time'), type: 'time', step: 1, show: (v) => !v.now }]}
      onSubmit={async (v) => { await api.post(`/race-entrants/${e.id}/manual-reads`, { checkpoint: v.checkpoint, ...(v.now ? {} : { observed_at: localIso(v.date, v.time) }) }); return done(t('rd.read_recorded')); }} />;
    case 'chip': return <FormSheet visible onClose={close} title={t('rd.chip_title', { name: e.full_name })} submitLabel={e.chip_ref ? t('rd.reissue_chip') : t('rd.assign_chip')} fields={[
      { key: 'ref', label: t('rd.new_chip'), placeholder: t('rd.new_chip_ph') },
      ...(e.chip_ref ? [{ key: 'reason', label: t('rd.why'), type: 'chips', options: [{ value: 'lost', label: t('rd.lost') }, { value: 'damaged', label: t('rd.damaged') }, { value: 'wrong', label: t('rd.wrong_chip') }], default: 'damaged' }, { key: 'swapped_ago', label: t('rd.swapped_ago'), type: 'stepper', min: 0, max: 600, step: 5, suffix: ` ${t('rd.min_unit')}`, default: 0, hint: t('rd.swapped_hint') }] : [])]}
      onSubmit={async (v) => {
        if (!e.chip_ref) await api.post(`/race-entrants/${e.id}/tags`, { kind: 'chip', ref: v.ref });
        else await api.post(`/race-entrants/${e.id}/tags/reissue`, { kind: 'chip', reason: v.reason, new_ref: v.ref, ...(v.swapped_ago ? { effective_at: new Date(Date.now() - v.swapped_ago * 60000).toISOString() } : {}) });
        return done(t('rd.chip_saved'));
      }} />;
    case 'bib': return <FormSheet visible onClose={close} title={t('rd.bib_title', { n: e.bib_no })} submitLabel={t('rd.reissue_bib')} fields={[
      { key: 'reason', label: t('rd.why'), type: 'chips', options: [{ value: 'lost', label: t('rd.lost') }, { value: 'damaged', label: t('rd.damaged') }, { value: 'wrong', label: t('rd.wrong_number') }], default: 'lost' },
      { key: 'new_ref', label: t('rd.new_number'), optional: true }]}
      onSubmit={async (v) => { await api.post(`/race-entrants/${e.id}/tags/reissue`, { kind: 'bib', reason: v.reason, ...(v.new_ref ? { new_ref: v.new_ref } : {}) }); return done(t('rd.bib_reissued')); }} />;
    case 'givebib': return <FormSheet visible onClose={close} title={t('rd.bib_for', { name: e.full_name })} submitLabel={t('rd.assign')} fields={[{ key: 'ref', label: t('rd.bib_number') }]}
      onSubmit={async (v) => { await api.post(`/race-entrants/${e.id}/tags`, { kind: 'bib', ref: v.ref }); return done(t('rd.bib_assigned')); }} />;
    case 'wave': return <FormSheet visible onClose={close} title={t('rd.wave_for', { name: e.full_name })} submitLabel={t('rd.move')} fields={[
      { key: 'wave', label: t('rd.wave'), type: 'chips', options: waveOpts, default: waveOpts[0]?.value }, { key: 'reason', label: t('rd.reason_told'), optional: true }]}
      onSubmit={async (v) => { await api.post(`/race-waves/${v.wave}/entrants`, { entrant_ids: [e.id], reason: v.reason || undefined }); return done(t('rd.wave_changed')); }} />;
    case 'category': return <FormSheet visible onClose={close} title={t('rd.category_for', { name: e.full_name })} submitLabel={t('common.save')} fields={[
      { key: 'category_id', label: t('rd.declared_cat'), type: 'chips', optional: true, options: [{ value: null, label: t('rd.none_opt') }, ...(R.categories ?? []).map((k) => ({ value: k.id, label: k.name }))], hint: t('rd.cat_hint') }]}
      onSubmit={async (v) => { await api.patch(`/race-entrants/${e.id}`, { category_id: v.category_id ?? null }); return done(t('rd.cat_saved')); }} />;
    case 'correction': return <CorrectionForm e={e} cps={cps} onClose={close} onDone={done} />;
    default: return null;
  }
}

function CorrectionForm({ e, cps, onClose, onDone }) {
  const kinds = [{ value: 'adjustment', label: t('rd.ck_adjustment') }, { value: 'use_gun_time', label: t('rd.ck_gun') }, { value: 'manual_read', label: t('rd.ck_read') }, { value: 'recompute', label: t('rd.ck_late') }, { value: 'status', label: t('rd.ck_status') }];
  return (
    <FormSheet visible onClose={onClose} title={t('rd.corr_title', { name: e.full_name })} submitLabel={t('rd.propose')} notice={t('rd.corr_notice')}
      fields={[
        { key: 'kind', label: t('rd.what'), type: 'chips', options: kinds, default: 'adjustment' },
        { key: 'seconds', label: t('rd.seconds'), type: 'stepper', min: -600, max: 600, step: 5, suffix: ` ${t('rd.sec_unit')}`, default: 30, show: (v) => v.kind === 'adjustment' },
        { key: 'label', label: t('rd.result_label'), placeholder: t('rd.result_label_ph'), show: (v) => v.kind === 'adjustment' },
        { key: 'checkpoint', label: t('rd.checkpoint'), type: 'chips', options: cps, show: (v) => v.kind === 'manual_read', default: cps[cps.length - 1]?.value },
        { key: 'date', label: t('cs.date'), type: 'date', show: (v) => v.kind === 'manual_read', max: nowDate() }, { key: 'time', label: t('rd.time'), type: 'time', step: 1, show: (v) => v.kind === 'manual_read' },
        { key: 'status', label: t('rd.new_status'), type: 'chips', options: ['dns', 'dnf', 'dq', 'cutoff', 'registered'].map((s) => ({ value: s, label: tEnum(s) })), show: (v) => v.kind === 'status', default: 'dnf' },
        { key: 'reason', label: t('rd.reason_evidence'), type: 'multiline' },
      ]}
      onSubmit={async (v) => {
        const payload = v.kind === 'adjustment' ? { ms: v.seconds * 1000, label: v.label } : v.kind === 'manual_read' ? { checkpoint: v.checkpoint, observed_at: localIso(v.date, v.time) } : v.kind === 'status' ? { status: v.status, source: 'official' } : {};
        await api.post(`/race-entrants/${e.id}/corrections`, { kind: v.kind, payload, reason: v.reason });
        return onDone(t('rd.corr_proposed'));
      }} />
  );
}

function AddEntrant({ visible, onClose, id, R, onDone }) {
  const cats = R.categories ?? [];
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('rd.add_title')} submitLabel={t('rd.register')}
      fields={[
        { key: 'user_id', label: t('rd.person_acct'), type: 'entity', entityKind: 'person', optional: true, noun: t('rd.noun_person'), hint: t('rd.person_hint') },
        { key: 'full_name', label: t('rd.guest_name'), optional: true, show: (v) => !v.user_id },
        { key: 'gender', label: t('rd.declared_gender'), type: 'chips', optional: true, options: [{ value: 'male', label: t('rd.male') }, { value: 'female', label: t('rd.female') }, { value: 'other', label: t('rd.other') }], hint: t('rd.gender_hint') },
        { key: 'club', label: t('rd.club_team'), optional: true },
        ...(cats.length ? [{ key: 'category_id', label: t('cs.category'), type: 'chips', optional: true, options: cats.map((k) => ({ value: k.id, label: k.name })) }] : []),
        { key: 'name_public', label: t('rd.public_name'), type: 'switch', default: false },
      ]}
      onSubmit={async (v) => { await api.post(`/races/${id}/entrants`, { ...v, user_id: v.user_id || undefined }); onDone(); return t('rd.entrant_registered'); }} />
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
    try { const r = await api.post(path, body(dry)); setRep(r); if (!dry) { toast(kind === 'bibs' ? t('rd.bibs_assigned', { n: r.assigned }) : t('rd.n_imported', { n: r.created ?? r.assigned })); onDone(); reset(); } }
    catch (e) { setRep(e.details ? { errors: e.details.errors, rejected: e.details.rejected } : null); fail(toast)(e); } finally { setBusy(false); }
  };
  const need = kind === 'entrants' ? 'external_ref, full_name, gender, club, category, wave, bib, chip, seed_s' : 'bib, chip';
  return (
    <Sheet visible={!!kind} onClose={reset} title={kind === 'entrants' ? t('rd.bulk_entrants') : kind === 'chips' ? t('rd.bulk_chips') : t('rd.bulk_bibs')}>
      {kind === 'bibs' ? (
        <>
          <T color={c.mute}>{t('rd.bibs_help')}</T>
          <Counter label={t('rd.first_bib')} value={start} onChange={setStart} min={0} max={999999} step={1} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{[['registration', t('rd.ord_reg')], ['wave_seed', t('rd.ord_wave')]].map(([k, l]) => <AChip key={k} label={l} active={order === k} onPress={() => setOrder(k)} />)}</View>
        </>
      ) : (
        <>
          <T color={c.mute}>{t('rd.csv_help', { need, extra: kind === 'entrants' ? t('rd.csv_extra') : '' })}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <ABtn small title={t('rd.choose_csv')} onPress={pick} />
            {name ? <T size={13} color={c.mute}>{t('rd.file_rows', { name, n: text.split(/\r?\n/).filter(Boolean).length - 1 })}</T> : null}
          </View>
          <Field label={t('rd.paste_csv')} value={text} onChangeText={(x) => { setText(x); setRep(null); }} multiline minHeight={110} placeholder={`${need}\n`} />
        </>
      )}
      {rep ? (
        <ACard tone={rep.errors?.length ? A.orange : A.green} style={{ gap: 4 }}>
          <AT size={14} weight="800">{t('rd.bulk_result', { head: rep.dry_run === false ? t('rd.done_word') : t('rd.dry_run'), n: rep.will_create ?? rep.will_assign ?? rep.assigned ?? 0, verb: kind === 'chips' ? t('rd.verb_paired') : kind === 'bibs' ? t('rd.verb_numbered') : t('rd.verb_created'), extra: `${rep.unchanged ? ` · ${t('rd.already_reg', { n: rep.unchanged })}` : ''}${rep.rejected ? ` · ${t('rd.rows_fix', { n: rep.rejected })}` : ''}` })}</AT>
          {kind === 'bibs' && rep.first ? <AT size={13} color={A.mute}>{rep.first} … {rep.last}</AT> : null}
          {(rep.errors ?? []).slice(0, 6).map((x, i) => <AT key={i} size={12.5} color={A.mute}>{t('rd.row_msg', { row: x.row, message: x.message })}</AT>)}
        </ACard>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ABtn title={t('rd.check_first')} tone="ghost" loading={busy} onPress={() => run(true)} disabled={kind !== 'bibs' && !text.trim()} style={{ flex: 1 }} />
        <ABtn title={t('rd.import_now')} loading={busy} onPress={() => run(false)} disabled={(kind !== 'bibs' && !text.trim()) || !rep || !!rep.errors?.length} style={{ flex: 1 }} />
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
  const runAuto = async (strategy, dry) => { try { const r = await api.post(`/races/${id}/waves/auto`, { strategy, dry_run: dry }); setRep({ strategy, ...r }); if (!dry) { toast(t('rd.placed_notified', { placed: r.placed, notified: r.notified })); reload(); setAuto(false); setRep(null); } } catch (e) { fail(toast)(e); } };
  return (
    <>
      <ASection title={t('rd.waves_title')} sub={t('rd.waves_sub')} />
      {R.waves.map((w) => (
        <ACard key={w.id} pad={14} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}><AT size={16} weight="900">{w.name}</AT><AT size={12.5} color={A.mute}>{dayTime(w.start_at)} · {tEnum(w.basis)}{w.basis_note ? ` — ${w.basis_note}` : ''}</AT></View>
            <ATag label={tEnum(w.status)} tone={w.status === 'started' ? A.green : A.cyan} />
          </View>
          <ABar pct={(w.assigned / w.capacity) * 100} color={w.assigned >= w.capacity ? A.orange : A.cyan} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <AT size={12.5} color={A.mute} num>{w.assigned} / {w.capacity}</AT>
            {org && w.status !== 'started' ? <ABtn small tone="ghost" title={t('rd.edit')} onPress={() => setWave(w)} /> : null}
          </View>
        </ACard>
      ))}
      {!R.waves.length ? <AEmpty emoji="🚦" title={t('rd.no_waves')} sub={t('rd.no_waves_sub2')} /> : null}
      {org ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ABtn small title={t('rd.new_wave_btn')} onPress={() => setWave({})} /><ABtn small tone="ghost" title={t('rd.auto_btn')} onPress={() => setAuto(true)} /></View> : null}

      <ASection title={t('rd.categories')} sub={t('rd.categories_sub')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{R.categories.map((k) => <ATag key={k.id} label={`${k.name} · ${k.entrants}`} tone={A.cyan} />)}</View>
      {!R.categories.length ? <T color={A.mute}>{t('rd.no_categories')}</T> : null}
      {org ? <ABtn small tone="ghost" title={t('rd.add_cat_btn')} onPress={() => setCat(true)} style={{ alignSelf: 'flex-start' }} /> : null}

      <ASection title={t('rd.course_title')} sub={t('rd.course_sub')} />
      {R.course ? (
        <ACard style={{ gap: 6 }}>
          <AT size={15} weight="800">{t('rd.course_name_v', { name: R.course.name, v: R.course.version })}</AT>
          {R.course.checkpoints.map((k) => (
            <View key={k.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <ATag label={k.code} tone={k.kind === 'finish' ? A.green : k.kind === 'start' ? A.cyan : A.violet} />
              <AT size={13.5} style={{ flex: 1 }}>{k.label}</AT>
              <AT size={13} color={A.mute} num>{(Number(k.distance_m) / 1000).toFixed(k.distance_m % 1000 ? 2 : 0)} {t('rd.km_unit')}{k.cutoff_s ? ` · ${t('rd.cutoff_part', { t: ms2(k.cutoff_s * 1000) })}` : ''}</AT>
            </View>
          ))}
        </ACard>
      ) : <AEmpty emoji="🗺️" title={t('rd.no_course')} sub={t('rd.no_course_sub')} />}
      {R.draft_courses.map((d) => org ? <ARow key={d.id} title={t('rd.draft_course', { v: d.version, name: d.name })} right={<ABtn small title={t('rd.publish')} onPress={() => doIt(() => api.post(`/race-courses/${d.id}/publish`, {}), t('rd.course_published'))} />} /> : null)}
      {org ? <ABtn small tone="ghost" title={R.course ? t('rd.new_course_version') : t('rd.define_course')} onPress={() => setCourse(true)} style={{ alignSelf: 'flex-start' }} /> : null}

      <WaveForm wave={wave} id={id} categories={R.categories} onClose={() => setWave(null)} onDone={reload} />
      <FormSheet visible={cat} onClose={() => setCat(false)} title={t('rd.new_cat_title')} submitLabel={t('cs.create')} fields={[
        { key: 'name', label: t('access.name'), placeholder: t('rd.cat_name_ph') }, { key: 'kind', label: t('cs.kind'), type: 'chips', options: [{ value: 'age_group', label: t('rd.cat_age') }, { value: 'open', label: t('rd.cat_open') }, { value: 'para', label: t('rd.cat_para') }, { value: 'custom', label: t('enum.custom') }], default: 'age_group' },
        { key: 'gender_rule', label: t('rd.open_to'), type: 'chips', options: [{ value: 'any', label: t('rd.anyone') }, { value: 'male', label: t('rd.men') }, { value: 'female', label: t('rd.women') }], default: 'any' },
        { key: 'eligibility_ref', label: t('rd.rule_from'), optional: true, placeholder: t('rd.rule_ph') }]}
        onSubmit={async (v) => { await api.post(`/races/${id}/categories`, v); reload(); return t('rd.cat_created'); }} />
      <Sheet visible={auto} onClose={() => { setAuto(false); setRep(null); }} title={t('rd.auto_btn')}>
        <T color={c.mute}>{t('rd.auto_help')}</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {[['seed', t('rd.st_seed')], ['category', t('rd.st_cat')], ['fill', t('rd.st_fill')]].map(([k, l]) => <AChip key={k} label={l} active={rep?.strategy === k} onPress={() => runAuto(k, true)} />)}
        </View>
        {rep ? (<ACard style={{ gap: 4 }}>
          <AT size={14} weight="800">{t('rd.would_place', { placed: rep.placed, unplaced: rep.unplaced })}</AT>
          {rep.waves.map((w) => <AT key={w.wave_id} size={12.5} color={A.mute}>{t('rd.wave_add', { name: w.name, add: w.will_add, free: w.free_after })}</AT>)}
        </ACard>) : null}
        <ABtn title={t('cs.apply')} disabled={!rep || !rep.placed} onPress={() => runAuto(rep.strategy, false)} />
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
    <FormSheet visible={!!wave} onClose={onClose} title={edit ? t('rd.edit_wave', { name: wave.name }) : t('rd.new_wave_title')} submitLabel={edit ? t('common.save') : t('rd.create_wave')}
      initial={edit ? { name: wave.name, date: `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`, time: `${pad(d0.getHours())}:${pad(d0.getMinutes())}`, capacity: wave.capacity, basis: wave.basis, basis_note: wave.basis_note ?? '' } : { date: nowDate(), time: '08:00', capacity: 500, basis: 'organiser' }}
      fields={[
        { key: 'name', label: t('access.name'), placeholder: t('rd.wave_name_ph') }, { key: 'date', label: t('rd.start_date'), type: 'date' }, { key: 'time', label: t('cs.start_time'), type: 'time', step: 5 },
        { key: 'capacity', label: t('rd.capacity'), type: 'stepper', min: 1, max: 100000, step: 50, suffix: ` ${t('rd.places_unit')}` },
        { key: 'basis', label: t('rd.built_on'), type: 'chips', options: [{ value: 'seed', label: t('rd.bo_seed') }, { value: 'category', label: t('rd.bo_category') }, { value: 'accessibility', label: t('rd.bo_access') }, { value: 'team', label: t('rd.bo_team') }, { value: 'organiser', label: t('rd.bo_organiser') }] },
        { key: 'basis_note', label: t('rd.seed_ref'), optional: true, placeholder: t('rd.seed_ph') },
        ...(!edit && categories.length ? [{ key: 'category_id', label: t('rd.reserved_cat'), type: 'chips', optional: true, options: categories.map((k) => ({ value: k.id, label: k.name })) }] : []),
        ...(edit ? [{ key: 'reason', label: t('rd.why_moves'), optional: true }] : []),
      ]}
      onSubmit={async (v) => {
        const body = { name: v.name, start_at: localIso(v.date, v.time), capacity: v.capacity, basis: v.basis, basis_note: v.basis_note || undefined };
        if (edit) await api.patch(`/race-waves/${wave.id}`, { ...body, reason: v.reason || undefined }); else await api.post(`/races/${id}/waves`, { ...body, category_id: v.category_id || undefined });
        onDone(); return edit ? t('rd.wave_updated') : t('rd.wave_created');
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
  const addSplit = () => setSplits((s) => [...s, { code: `K${s.length + 1}`, label: t('rd.split_n', { n: s.length + 1 }), kind: 'split', km: Math.min(total - 0.5, (s.at(-1)?.km ?? 0) + Math.max(0.5, Math.round(total / 4 * 2) / 2)), cutoff: 0 }]);
  const upd = (i, p) => setSplits((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const save = async (publish) => {
    setBusy(true);
    try {
      const cps = [{ code: 'START', label: 'Start', kind: 'start', distance_m: 0, read_rule: 'last' }, ...splits.map((s) => ({ code: s.code.toUpperCase().replace(/[^A-Z0-9_-]/g, ''), label: s.label, kind: s.kind, distance_m: Math.round(s.km * 1000), ...(s.cutoff ? { cutoff_s: s.cutoff * 60 } : {}) })), { code: 'FIN', label: 'Finish', kind: 'finish', distance_m: Math.round(total * 1000) }];
      const course = await api.post(`/races/${id}/courses`, { name: name || `${total} km`, total_distance_m: Math.round(total * 1000), checkpoints: cps });
      if (publish) await api.post(`/race-courses/${course.id}/publish`, {});
      toast(publish ? t('rd.course_published') : t('rd.draft_saved')); onDone(); onClose();
    } catch (e) { fail(toast)(e); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('rd.define_title')}>
      <Field label={t('rd.course_name')} value={name} onChangeText={setName} placeholder={t('rd.course_ph')} />
      <Counter label={t('rd.total_distance')} value={total} onChange={setTotal} min={0.5} max={500} step={0.5} suffix={` ${t('rd.km_unit')}`} />
      <T weight="700">{t('rd.cp_between')}</T>
      {splits.map((s, i) => (
        <ACard key={i} pad={12} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Field label={t('rd.code')} value={s.code} onChangeText={(x) => upd(i, { code: x })} maxLength={8} /></View>
            <View style={{ flex: 2 }}><Field label={t('access.name')} value={s.label} onChangeText={(x) => upd(i, { label: x })} /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{[['split', t('enum.split')], ['lap', t('enum.lap')]].map(([k, l]) => <AChip key={k} label={l} active={s.kind === k} onPress={() => upd(i, { kind: k })} />)}</View>
          <Counter label={t('rd.distance')} value={s.km} onChange={(x) => upd(i, { km: x })} min={0.1} max={Math.max(0.5, total - 0.1)} step={0.5} suffix={` ${t('rd.km_unit')}`} />
          <Counter label={t('rd.cutoff_none')} value={s.cutoff} onChange={(x) => upd(i, { cutoff: x })} min={0} max={1440} step={5} suffix={` ${t('rd.min_unit')}`} />
          <ABtn small tone="ghost" title={t('access.remove')} onPress={() => setSplits((x) => x.filter((_, k) => k !== i))} style={{ alignSelf: 'flex-start' }} />
        </ACard>
      ))}
      <ABtn small tone="ghost" title={t('rd.add_split')} onPress={addSplit} style={{ alignSelf: 'flex-start' }} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ABtn title={t('rd.save_draft')} tone="ghost" loading={busy} onPress={() => save(false)} style={{ flex: 1 }} />
        <ABtn title={t('rd.publish')} loading={busy} onPress={() => save(true)} style={{ flex: 1 }} />
      </View>
      <T size={12} color={c.mute}>{t('rd.course_note')}</T>
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
  const reconcile = async () => { setBusy(true); try { const r = await api.post(`/races/${id}/reconcile`, {}); toast(t('rd.reconcile_done', { e: r.entrants, c: r.changed, h: r.held_for_review })); reload(); ex.reload(); } catch (e) { fail(toast)(e); } finally { setBusy(false); } };
  return (
    <>
      <ASection title={t('rd.reconciliation')} sub={D.last_reconcile ? t('rd.last_run', { when: dayTime(D.last_reconcile.created_at), n: D.last_reconcile.entrants }) : t('rd.not_run')} />
      <ACard tone={D.results_stale ? A.orange : undefined} style={{ gap: 8 }}>
        <AT size={13.5} color={A.mute}>{t('rd.recon_note')}</AT>
        <ABtn title={D.results_stale ? t('rd.reconcile_now') : t('rd.run_again')} loading={busy} onPress={reconcile} style={{ alignSelf: 'flex-start' }} />
      </ACard>

      <ASection title={t('rd.timing_sources')} sub={t('rd.where_reads')} />
      {R.sources.map((s) => <ARow key={s.id} title={s.name} sub={`${tEnum(s.kind)} · ${s.integration === 'manual' ? t('rd.src_manual') : t('rd.src_file')}${s.clock_offset_ms ? ` · ${t('rd.clock_part', { off: `${s.clock_offset_ms > 0 ? '+' : ''}${s.clock_offset_ms}` })}` : ''}`} />)}
      {!R.sources.length ? <AEmpty emoji="📡" title={t('rd.no_src')} sub={t('rd.no_src_sub')} /> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {access.chief ? <ABtn small tone="ghost" title={t('rd.add_src')} onPress={() => setSrc(true)} /> : null}
        <ABtn small title={t('rd.import_file')} onPress={() => setImp(true)} disabled={!R.sources.length || !R.course} />
      </View>
      <T size={12} color={A.mute}>{t('rd.layout_note')}</T>

      <ASection title={t('rd.exceptions')} sub={t('rd.exceptions_sub')} />
      {(ex.data?.items ?? []).map((x) => (
        <ARow key={x.id} onPress={x.entrant_id ? () => drawer.open(x.entrant_id) : undefined} left={x.bib_no ? <BibBadge bib={x.bib_no} /> : <View style={{ width: 52, height: 40, borderRadius: 10, backgroundColor: A.panel2, alignItems: 'center', justifyContent: 'center' }}><AT>📡</AT></View>}
          title={`${KIND_LABEL[x.kind] ?? x.kind} · ${x.full_name ?? t('rd.unattributed')}`} sub={(WHY[x.kind] ?? (() => ''))(x)}
          right={<View style={{ gap: 6 }}>
            {x.read_id ? <ABtn small tone="neon" title={t('rd.link')} onPress={() => setLink(x)} /> : null}
            <ABtn small tone="ghost" title={t('access.accept')} onPress={() => doIt(async () => { await api.post(`/race-exceptions/${x.id}/resolve`, { resolution: 'accepted' }); ex.reload(); }, t('rd.accepted'))} />
          </View>} />
      ))}
      {ex.data && !ex.data.items.length ? <AEmpty emoji="✅" title={t('rd.no_exceptions')} /> : null}
      <ManualRead id={id} R={R} onDone={() => { reload(); ex.reload(); }} />
      {drawer.node}
      <CrewCard eventId={R.race.event_id} access={access} toast={toast} />
      <SourceForm visible={src} onClose={() => setSrc(false)} id={id} onDone={reload} />
      <ImportReads visible={imp} onClose={() => setImp(false)} id={id} R={R} onDone={() => { reload(); ex.reload(); }} toast={toast} />
      <FormSheet visible={!!link} onClose={() => setLink(null)} title={t('rd.link_title')} submitLabel={t('rd.propose_link')} notice={t('rd.link_notice')} fields={[{ key: 'bib', label: t('rd.bib_of_entrant') }, { key: 'reason', label: t('rd.why_belongs'), type: 'multiline' }]}
        onSubmit={async (v) => {
          const found = await api.get(`/races/${id}/find`, { q: v.bib });
          const hit = found.find((f) => f.bib_no?.toLowerCase() === v.bib.toLowerCase());
          if (!hit) throw new Error(t('rd.no_entrant_bib'));
          await api.post(`/race-entrants/${hit.id}/corrections`, { kind: 'link_read', payload: { read_id: link.read_id }, reason: v.reason, evidence_read_ids: [link.read_id] });
          return t('rd.link_proposed');
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
      <ASection title={t('rd.crew')} sub={t('rd.crew_sub')} />
      {mine.map((x) => <ARow key={x.id} title={x.display_name} sub={`${tEnum(x.role)}${x.sport ? ` · ${x.sport}` : ''}`} right={<ATag label={tEnum(x.status)} />} />)}
      {crew.data && !mine.length ? <T color={A.mute}>{t('rd.no_crew')}</T> : null}
      {access.organizer ? <ABtn small tone="ghost" title={t('rd.invite_crew')} onPress={() => setInv(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={inv} onClose={() => setInv(false)} title={t('rd.invite_title')} submitLabel={t('rd.send_invite')} fields={[
        { key: 'role', label: t('rd.role'), type: 'chips', options: ROLES.map((r) => ({ value: r, label: tEnum(r) })), default: 'timekeeper' },
        { key: 'user_id', label: t('rd.person'), type: 'entity', entityKind: 'person', role: 'referee', noun: t('rd.noun_official'), hint: t('rd.officials_hint') }]}
        onSubmit={async (v) => { await api.post(`/events/${eventId}/staff`, { user_id: v.user_id, role: v.role }); crew.reload(); toast(t('rd.invite_sent')); }} />
    </>
  );
}

function ManualRead({ id, R, onDone }) {
  const [open, setOpen] = useState(false);
  const cps = (R.course?.checkpoints ?? []).map((k) => ({ value: k.code, label: k.label }));
  if (!R.course) return null;
  return (
    <>
      <ABtn small tone="sun" title={t('rd.record_manual')} onPress={() => setOpen(true)} style={{ alignSelf: 'flex-start' }} />
      <FormSheet visible={open} onClose={() => setOpen(false)} title={t('rd.manual_official_title')} submitLabel={t('rd.record')} notice={t('rd.manual_notice')} fields={[
        { key: 'bib', label: t('rd.bib_number') }, { key: 'checkpoint', label: t('rd.checkpoint'), type: 'chips', options: cps, default: cps[cps.length - 1]?.value }]}
        onSubmit={async (v) => {
          const found = await api.get(`/races/${id}/find`, { q: v.bib });
          const hit = found.find((f) => f.bib_no?.toLowerCase() === v.bib.toLowerCase());
          if (!hit) throw new Error(t('rd.no_entrant_bib'));
          await api.post(`/race-entrants/${hit.id}/manual-reads`, { checkpoint: v.checkpoint });
          onDone(); return t('rd.read_for', { name: hit.full_name });
        }} />
    </>
  );
}

function SourceForm({ visible, onClose, id, onDone }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('rd.src_title')} submitLabel={t('rd.add_source')} fields={[
      { key: 'name', label: t('access.name'), placeholder: t('rd.gantry') },
      { key: 'kind', label: t('cs.kind'), type: 'chips', options: ['chip_reads', 'checkpoint_scan', 'finish_system', 'batch_file', 'manual_official'].map((k) => ({ value: k, label: tEnum(k) })), default: 'chip_reads' },
      { key: 'provider_label', label: t('rd.provider'), optional: true },
      { key: 'clock_offset_ms', label: t('rd.clock_error'), type: 'stepper', min: -60000, max: 60000, step: 100, suffix: ` ${t('rd.ms_unit')}`, default: 0, hint: t('rd.clock_hint') }]}
      onSubmit={async (v) => { await api.post(`/races/${id}/sources`, { ...v, integration: v.kind === 'manual_official' ? 'manual' : 'file_import' }); onDone(); return t('rd.src_added'); }} />
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
    try { const r = await api.post(`/races/${id}/reads/import`, { source_id: sid, csv: text, label: name || undefined, dry_run: dry }); setRep(r); if (!dry) { toast(r.already_imported ? t('rd.already_imported_toast') : t('rd.reads_stored', { a: r.accepted, d: r.duplicate, r: r.rejected })); onDone(); } }
    catch (e) { fail(toast)(e); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={reset} title={t('rd.import_file')}>
      <T color={c.mute}>{t('rd.import_help')}</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{R.sources.map((s) => <AChip key={s.id} label={s.name} active={sid === s.id} onPress={() => setSource(s.id)} />)}</View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <ABtn small title={t('rd.choose_csv')} onPress={pick} />{name ? <T size={13} color={c.mute}>{t('rd.file_reads', { name, n: text.split(/\r?\n/).filter(Boolean).length - 1 })}</T> : null}
      </View>
      <Field label={t('rd.paste_csv')} value={text} onChangeText={(x) => { setText(x); setRep(null); }} multiline minHeight={110} placeholder={'chip,checkpoint,observed_at,ref\n'} />
      {rep ? (
        <ACard tone={rep.rejected ? A.orange : A.green} style={{ gap: 4 }}>
          <AT size={14} weight="800">{rep.dry_run ? t('rd.check_line', { n: rep.will_accept, d: rep.duplicate, r: rep.rejected }) : rep.already_imported ? t('rd.already_imported') : t('rd.stored_line', { a: rep.accepted, d: rep.duplicate, r: rep.rejected })}</AT>
          {(rep.rejects ?? []).slice(0, 5).map((x, i) => <AT key={i} size={12.5} color={A.mute}>{t('rd.row_msg', { row: x.row, message: x.message })}</AT>)}
        </ACard>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ABtn title={t('rd.check_first')} tone="ghost" loading={busy} disabled={!text.trim() || !sid} onPress={() => run(true)} style={{ flex: 1 }} />
        <ABtn title={t('rd.import')} loading={busy} disabled={!text.trim() || !sid} onPress={() => run(false)} style={{ flex: 1 }} />
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
    try { let next, csv = ''; do { const r = await api.get(`/races/${id}/export`, { limit: 5000, ...(next ? { after: next } : {}) }); csv += (csv ? r.csv.split('\r\n').slice(1).join('\r\n') : r.csv); next = r.next; } while (next); await saveText(`${R.race.name.replace(/[^A-Za-z0-9]+/g, '-')}-results.csv`, csv); toast(t('rd.exported')); }
    catch (e) { fail(toast)(e); } finally { setExp(false); }
  };
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <AChip label={t('rd.live_derived')} active={view === 'current'} onPress={() => setView('current')} /><AChip label={D.publication ? t('rd.published_label', { label: tEnum(D.publication.label) }) : t('cs.published')} active={view === 'published'} onPress={() => setView('published')} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{classes.map((k) => <AChip key={k} label={CLASS_LABEL(k, R.categories)} active={cls === k} onPress={() => setCls(k)} />)}</View>
      <TextInput value={q} onChangeText={setQ} placeholder={t('rd.find_result_ph')} placeholderTextColor={A.mute} accessibilityLabel={t('rd.find_result')} autoCapitalize="none"
        style={{ minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: A.line, backgroundColor: A.panel2, color: A.ink, paddingHorizontal: 14, fontSize: 16 }} />
      {rows.items.map((r) => (
        <ARow key={r.entrant_id} onPress={() => drawer.open(r.entrant_id)} left={<View style={{ width: 44, alignItems: 'center' }}><AT size={20} weight="900" num>{r.rank ?? '–'}</AT>{r.tied ? <AT size={10} color={A.sun}>{t('rd.tie')}</AT> : null}</View>}
          title={`${r.bib_no ? `#${r.bib_no} ` : ''}${r.full_name}`} sub={[r.category, r.race_status !== 'finished' ? tEnum(r.race_status) : null, (r.flags ?? []).includes('needs_review') ? t('rd.needs_decision_lc') : (r.flags ?? []).includes('review') ? t('rd.to_review') : null].filter(Boolean).join(' · ') || undefined}
          right={<View style={{ alignItems: 'flex-end' }}><AT size={16} weight="900" num>{r.official_time ?? '–'}</AT>{r.gun_time && r.net_time && r.gun_time !== r.net_time ? <AT size={11} color={A.mute} num>{t('rd.gun_time_line', { t: r.gun_time })}</AT> : null}</View>} />
      ))}
      {!list.loading && !rows.items.length ? <AEmpty emoji="🏆" title={view === 'published' && !D.publication ? t('rd.nothing_pub_yet') : t('rd.no_results')} sub={t('rd.results_sub')} /> : null}
      {rows.next ? <ABtn title={more ? t('common.loading') : t('rd.load_more')} tone="ghost" loading={more} onPress={loadMore} /> : null}
 {drawer.node}
      {access.organizer && D.publication ? <ABtn small tone="ghost" title={t('rd.export_csv')} loading={exp} onPress={exportCsv} style={{ alignSelf: 'flex-start' }} /> : null}

      {awards.data?.classifications?.length ? (
        <>
          <ASection title={t('rd.awards')} sub={t('rd.awards_sub', { label: tEnum(awards.data.publication.label), v: awards.data.publication.policy_version })} />
          {awards.data.classifications.map((g) => (
            <ACard key={g.classification} style={{ gap: 6 }}>
              <AT size={15} weight="900">{g.label}</AT>
              {g.awards.map((a) => <View key={`${g.classification}${a.rank}${a.entrant_id ?? a.house_id}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <AT size={16}>{a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : `${a.rank}.`}</AT><AT size={14} style={{ flex: 1 }}>{a.full_name ?? a.club}{a.bib_no ? ` · #${a.bib_no}` : ''}{a.tied ? ` ${t('rd.tie_part')}` : ''}</AT><AT size={14} num weight="800">{a.time}</AT></View>)}
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
      toast(t('rd.decision_recorded')); refresh();
    } catch (e) { fail(toast)(e); }
    setAsk(null);
  };
  const chief = access.chief;
  return (
    <>
      <ASection title={t('rd.cutoffs')} sub={t('rd.cutoffs_sub')} />
      {(cut.data?.items ?? []).map((k) => (
        <ACard key={k.id} pad={12} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <BibBadge bib={k.bib_no} />
            <View style={{ flex: 1 }}><AT size={15} weight="800">{k.full_name}</AT><AT size={12.5} color={A.mute}>{k.outcome === 'no_evidence' ? t('rd.cut_noevidence', { label: k.label }) : t('rd.cut_missed', { label: k.label, elapsed: ms2(k.elapsed_ms), cutoff: ms2(k.cutoff_ms) })}</AT></View>
            <ATag label={tEnum(k.outcome)} tone={k.outcome === 'missed' ? A.red : A.sun} />
          </View>
          {chief ? <View style={{ flexDirection: 'row', gap: 8 }}><ABtn small tone="live" title={k.outcome === 'no_evidence' ? t('rd.confirm_saw') : t('rd.confirm_missed')} onPress={() => setAsk({ kind: 'cutoff', row: k, decision: 'confirm' })} /><ABtn small tone="ghost" title={t('rd.waive')} onPress={() => setAsk({ kind: 'cutoff', row: k, decision: 'waive' })} /></View> : null}
        </ACard>
      ))}
      {cut.data && !cut.data.items.length ? <AEmpty emoji="✅" title={t('rd.no_cutoffs')} /> : null}

      <ASection title={t('rd.corrections')} sub={t('rd.corrections_sub')} />
      {(cor.data?.items ?? []).map((k) => (
        <ACard key={k.id} pad={12} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><BibBadge bib={k.bib_no} /><View style={{ flex: 1 }}><AT size={15} weight="800">{k.full_name}</AT><AT size={12.5} color={A.mute}>{tEnum(k.kind)}{k.payload?.ms ? ` · ${k.payload.ms > 0 ? '+' : ''}${k.payload.ms / 1000} s` : ''}</AT></View></View>
          <AT size={13} color={A.mute}>{k.reason}</AT>
          {chief ? <View style={{ flexDirection: 'row', gap: 8 }}><ABtn small tone="lime" title={t('rd.approve')} onPress={() => setAsk({ kind: 'correction', row: k, decision: 'approve' })} /><ABtn small tone="ghost" title={t('rd.reject')} onPress={() => setAsk({ kind: 'correction', row: k, decision: 'reject' })} /></View> : null}
        </ACard>
      ))}
      {cor.data && !cor.data.items.length ? <AEmpty emoji="🧾" title={t('rd.no_corrections')} /> : null}

      {chief ? (
        <>
          <ASection title={t('rd.protests')} sub={t('rd.protests_sub')} />
          {(pro.data ?? []).map((p) => (
            <ACard key={p.id} pad={12} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><BibBadge bib={p.bib_no} /><View style={{ flex: 1 }}><AT size={15} weight="800">{p.full_name}</AT><AT size={12.5} color={A.mute}>{t(p.approved_corrections === 1 ? 'rd.case_one' : 'rd.case_many', { no: p.case_no, n: p.approved_corrections })}</AT></View></View>
              <AT size={13} color={A.mute}>{p.statement}</AT>
              <View style={{ flexDirection: 'row', gap: 8 }}><ABtn small tone="lime" title={t('rd.uphold')} onPress={() => setAsk({ kind: 'protest', row: p, decision: 'upheld' })} /><ABtn small tone="ghost" title={t('rd.reject')} onPress={() => setAsk({ kind: 'protest', row: p, decision: 'rejected' })} /></View>
            </ACard>
          ))}
          {pro.data && !pro.data.length ? <AEmpty emoji="🤝" title={t('rd.no_protests')} /> : null}
        </>
      ) : null}
      <ReasonSheet visible={!!ask} onClose={() => setAsk(null)} title={ask ? tEnum(ask.decision) : ''} sub={t('rd.reason_sub')} presets={[t('rd.preset_second'), t('rd.preset_video_ok'), t('rd.preset_rule')]} confirmLabel={t('rd.record_decision')} tone="live" onConfirm={decide} />
    </>
  );
}
