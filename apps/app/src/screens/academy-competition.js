// Academy → Competition & Squads (#786). Only calls the capabilities in academy-competition.js: the plan points at teams, fixtures, events and
// trips that live elsewhere (the event console, Teams, Trips); this screen never creates them. Squads are published through the Team capability,
// conflicts come from the server, and the participation review lists athletes alphabetically (no ranking by design).
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Empty, ErrorBox, Loading, Seg, T, Tag } from '../ui';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Block, Kpi } from './academy-ui';
import { t } from '../i18n';

const today = () => new Date().toISOString().slice(0, 10);
const Panel = ({ children, style }) => <View style={[{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }, style]}>{children}</View>;
const fmt = (d) => (d ? new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATUS = { draft: c.violetSoft, review: c.cyanSoft, committee: c.sunSoft, published: c.limeSoft, archived: c.line };
const NEXT = { draft: 'review', review: 'committee', committee: 'published' };
const CODES = ['medical_clearance', 'guardian_consent', 'registration', 'travel_booked', 'kit', 'staff_cover', 'exam_review'];
const SEATS = ['head_coach', 'performance_director', 'safeguarding_lead', 'academy_director', 'other'];
const METRICS = ['min_fixture_share_pct', 'min_minutes_per_athlete', 'max_consecutive_matches', 'min_rest_days'];
const KINDTONE = { training: c.cyanSoft, exam: c.sunSoft, staff: c.sunSoft, venue: c.orangeSoft, guardian: c.pinkSoft };

export function Competition({ o, archived, toast }) {
  const [planId, setPlanId] = useState(null);
  const [sec, setSec] = useState('squads');
  const [sheet, setSheet] = useState(null);
  const list = useLoad(() => api.get(`/organisations/${o.id}/season-plans`).catch((e) => ({ error: e })), [o.id]);
  const active = planId ?? list.data?.items?.find((p) => p.status !== 'archived')?.id ?? null;
  const plan = useLoad(() => (active ? api.get(`/season-plans/${active}`) : Promise.resolve(null)), [active]);
  const conf = useLoad(() => (active ? api.get(`/season-plans/${active}/conflicts`) : Promise.resolve(null)), [active, plan.data?.metrics?.entries]);
  const reload = () => { list.reload(); plan.reload(); conf.reload(); };
  const fail = (e) => toast?.(e?.message ?? t('cp.error'));
  if (list.loading && !list.data) return <Loading />;
  if (list.data?.error) return <Empty emoji="🔒" title={t('cp.locked')} sub={t('cp.locked_sub')} />;
  const create = (
    <FormSheet visible={sheet?.type === 'plan'} onClose={() => setSheet(null)} title={t('cp.new_plan')} submitLabel={t('cp.create')} initial={{ range: today() }}
      fields={[{ key: 'name', label: t('cp.f.name'), type: 'text' }, { key: 'range', label: t('cp.f.dates'), type: 'daterange', toKey: 'ends_on' }]}
      onSubmit={async (x) => { const r = await api.post(`/organisations/${o.id}/season-plans`, { name: x.name, starts_on: x.range, ends_on: x.ends_on }); setPlanId(r.id); setSheet(null); reload(); }} />
  );
  if (!list.data?.items?.length) return (
    <Panel style={{ padding: 22, gap: 12 }}>
      <T size={34}>🏟️</T><T size={21} weight="800">{t('cp.empty.title')}</T><T color={c.mute}>{t('cp.empty.body')}</T>
      {!archived ? <Btn title={t('cp.new_plan')} onPress={() => setSheet({ type: 'plan' })} style={{ alignSelf: 'flex-start' }} /> : null}
      {create}
    </Panel>
  );
  if (plan.loading && !plan.data) return <Loading />;
  const p = plan.data;
  if (!p) return <ErrorBox message={t('cp.error')} />;
  const m = p.metrics, blocking = conf.data?.blocking ?? m.blocking_conflicts;
  const advance = async () => { try { await api.post(`/season-plans/${p.id}/status`, { status: NEXT[p.status], row_version: p.row_version }); reload(); } catch (e) { fail(e); } };
  const P = { o, p, reload, fail, toast, archived, setSheet, conf: conf.data };
  return (
    <View style={{ gap: 14 }}>
      <View style={{ backgroundColor: c.violet, borderRadius: 20, padding: 16, gap: 8 }}>
        <T size={11} weight="800" color={c.on} style={{ letterSpacing: 1, opacity: 0.75 }}>{t('cp.hero')}</T>
        <T size={20} weight="800" color={c.on}>{p.name}</T>
        <T size={13} color={c.on} style={{ opacity: 0.8 }}>{fmtDay(p.starts_on)} – {fmtDay(p.ends_on)}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Tag label={t(`cp.status.${p.status}`)} color={STATUS[p.status]} />
          {NEXT[p.status] && !archived ? <Btn small title={t(`cp.advance.${NEXT[p.status]}`)} color={c.paper} ink={c.ink} onPress={advance} /> : null}
          {!archived ? <Btn small title={t('cp.new_plan')} color={c.paper} ink={c.ink} onPress={() => setSheet({ type: 'plan' })} /> : null}
        </View>
        {list.data.items.length > 1 ? <MenuField label={t('cp.switch')} value={p.id} onChange={setPlanId} options={list.data.items.map((x) => ({ value: x.id, label: x.name }))} /> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label={t('cp.kpi.entries')} value={m.entries} sub={t('cp.kpi.published', { n: m.squads_published })} />
        <Kpi label={t('cp.kpi.ready')} value={m.checklist_total ? `${m.checklist_done}/${m.checklist_total}` : '–'} sub={t('cp.kpi.ready_sub')} />
        <Kpi label={t('cp.kpi.conflicts')} value={conf.data?.items?.length ?? m.open_conflicts} sub={blocking ? t('cp.kpi.blocking', { n: blocking }) : t('cp.kpi.none')} tone={blocking ? 'alert' : undefined} onPress={() => setSec('conflicts')} />
        <Kpi label={t('cp.kpi.objectives')} value={p.objectives.length} sub={t('cp.kpi.objectives_sub')} onPress={() => setSec('participation')} />
      </View>
      <Seg value={sec} onChange={setSec} options={['calendar', 'conflicts', 'squads', 'participation'].map((k) => ({ value: k, label: t(`cp.sec.${k}`) }))} />
      {sec === 'calendar' ? <CalendarView {...P} /> : sec === 'conflicts' ? <Conflicts {...P} /> : sec === 'squads' ? <Squads {...P} /> : <Participation {...P} />}
      {create}
      {sheet?.type === 'entry' ? <EntrySheet {...P} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'objective' ? <ObjectiveSheet {...P} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'committee' ? <CommitteeSheet {...P} entry={sheet.entry} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'publish' ? <PublishSheet {...P} entry={sheet.entry} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'decide' ? <DecideSheet {...P} entry={sheet.entry} onClose={() => setSheet(null)} /> : null}
    </View>
  );
}

/** A searchable dropdown as a FormSheet field (long lists never become a row of chips). options may depend on the other values. */
const menu = (key, label, options, optional) => ({ key, type: 'custom', render: ({ v, set }) => <MenuField label={label + (optional ? ` (${t('form.optional')})` : '')} value={typeof v[key] === 'string' ? v[key] : undefined} onChange={(x) => set(key, x)} options={typeof options === 'function' ? options(v) : options} /> });
const useCandidates = (p) => useLoad(() => api.get(`/season-plans/${p.id}/candidates`), [p.id]);

// ------------------------------------------------------------------------------------------------ calendar
function CalendarView({ p }) {
  const cal = useLoad(() => api.get(`/season-plans/${p.id}/calendar`), [p.id, p.metrics.entries]);
  if (cal.loading && !cal.data) return <Loading />;
  const names = Object.fromEntries(p.entries.map((e) => [e.id, e.team_name]));
  if (!cal.data?.items?.length) return <Panel><Empty emoji="🗓️" title={t('cp.cal.empty')} sub={t('cp.cal.empty_sub')} /></Panel>;
  return (
    <Panel>
      <Block title={t('cp.sec.calendar')}>
        {cal.data.items.map((x, n) => (
          <View key={n} accessible accessibilityLabel={`${t(`cp.type.${x.type}`)}, ${names[x.entry_id] ?? ''}, ${fmt(x.starts_at)}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 14, backgroundColor: c.bg, minHeight: 48 }}>
            <Tag label={t(`cp.type.${x.type}`)} color={x.type === 'training' ? c.cyanSoft : c.pinkSoft} />
            <View style={{ flex: 1 }}><T weight="700">{x.title ?? names[x.entry_id]}</T><T size={12} color={c.mute}>{names[x.entry_id]} · {fmt(x.starts_at)}</T></View>
          </View>
        ))}
      </Block>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ conflicts
function Conflicts({ conf, p }) {
  if (!conf) return <Loading />;
  const names = Object.fromEntries(p.entries.map((e) => [e.id, e.team_name]));
  if (!conf.items.length) return <Panel><Empty emoji="✅" title={t('cp.conf.none')} sub={t('cp.conf.none_sub')} /></Panel>;
  return (
    <Panel>
      <Block title={t('cp.sec.conflicts')}>
        {conf.items.map((x, n) => (
          <View key={n} style={{ padding: 12, borderRadius: 14, backgroundColor: x.blocking ? c.redSoft : c.sunSoft, gap: 4 }} accessible accessibilityLabel={`${t(`cp.kind.${x.kind}`)}, ${names[x.entry_id] ?? ''}, ${x.message}`}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Tag label={t(`cp.kind.${x.kind}`)} color={KINDTONE[x.kind] ?? c.line} />
              <Tag label={x.blocking ? t('cp.blocks') : t('cp.chase')} color={c.paper} />
              <T weight="800">{names[x.entry_id]}</T>
            </View>
            <T size={13}>{x.message}</T>
          </View>
        ))}
        <T size={12} color={c.mute}>{t('cp.conf.note')}</T>
      </Block>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ squads
function Squads({ p, reload, fail, setSheet, archived }) {
  const { user } = useSession();
  const flip = async (e, code, state) => {
    try {
      let evidence;
      if (state === 'done') evidence = t('cp.evidence.by', { name: user?.display_name ?? '' });
      await api.post(`/season-plans/${p.id}/entries/${e.id}/checklist`, { code, state, ...(evidence ? { evidence } : {}) }); reload();
    } catch (x) { fail(x); }
  };
  const drop = async (e) => { try { await api.del(`/season-plans/${p.id}/entries/${e.id}`); reload(); } catch (x) { fail(x); } };
  return (
    <View style={{ gap: 12 }}>
      {!archived ? <Btn title={t('cp.add_entry')} onPress={() => setSheet({ type: 'entry' })} style={{ alignSelf: 'flex-start' }} /> : null}
      {!p.entries.length ? <Panel><Empty emoji="🛡️" title={t('cp.squads.empty')} sub={t('cp.squads.empty_sub')} /></Panel> : p.entries.map((e) => {
        const approved = e.committee.filter((a) => a.decision === 'approved').length;
        const mine = e.committee.find((a) => a.user_id === user?.id);
        return (
          <Panel key={e.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 180 }}>
                <T size={16} weight="800">{e.team_name}{e.age_group ? ` · ${e.age_group}` : ''}</T>
                <T size={12} color={c.mute}>{e.event_name}{e.at ? ` · ${fmt(e.at)}` : ''}{e.trip_name ? ` · ✈️ ${e.trip_name}` : ''}</T>
              </View>
              {e.squad_published_at ? <Tag label={t('cp.squad.published')} color={c.limeSoft} /> : <Tag label={t('cp.squad.draft')} color={c.violetSoft} />}
            </View>
            <Block title={t('cp.checklist')}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {e.checklist.map((x) => {
                  const done = x.state !== 'open';
                  return (
                    <Pressable key={x.code} disabled={archived} accessibilityRole="checkbox" accessibilityState={{ checked: done }} accessibilityLabel={t(`cp.chk.${x.code}`)} onPress={() => flip(e, x.code, done ? 'open' : 'done')}
                      style={{ minHeight: 44, paddingHorizontal: 12, borderRadius: 22, justifyContent: 'center', backgroundColor: done ? c.limeSoft : c.bg, borderWidth: 1, borderColor: done ? c.lime : c.line }}>
                      <T size={13} weight="700">{done ? '✓ ' : ''}{t(`cp.chk.${x.code}`)}</T>
                    </Pressable>
                  );
                })}
              </View>
            </Block>
            <Block title={t('cp.committee', { a: approved, n: e.committee.length })} right={!archived ? <Btn small title={t('cp.set_committee')} color={c.paper} ink={c.ink} onPress={() => setSheet({ type: 'committee', entry: e })} /> : null}>
              {e.committee.length ? e.committee.map((a) => (
                <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <T style={{ flex: 1 }}>{a.display_name} · {t(`cp.seat.${a.seat}`)}</T>
                  <Tag label={t(`cp.decision.${a.decision}`)} color={a.decision === 'approved' ? c.limeSoft : a.decision === 'rejected' ? c.redSoft : c.sunSoft} />
                </View>
              )) : <T size={13} color={c.mute}>{t('cp.committee.none')}</T>}
              {mine && mine.decision === 'pending' ? <Btn small title={t('cp.decide')} onPress={() => setSheet({ type: 'decide', entry: e })} style={{ alignSelf: 'flex-start' }} /> : null}
            </Block>
            {!archived ? (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Btn title={t('cp.publish')} onPress={() => setSheet({ type: 'publish', entry: e })} />
                <Btn title={t('cp.unlink')} color={c.paper} ink={c.ink} onPress={() => drop(e)} />
              </View>
            ) : null}
          </Panel>
        );
      })}
    </View>
  );
}

function EntrySheet({ p, onClose, reload, fail }) {
  const cand = useCandidates(p);
  if (cand.loading && !cand.data) return <Loading />;
  const d = cand.data ?? { teams: [], fixtures: [], events: [], cohorts: [], trips: [] };
  return (
    <FormSheet visible onClose={onClose} title={t('cp.add_entry')} submitLabel={t('cp.link')} initial={{}}
      notice={t('cp.entry.notice')}
      fields={[
        menu('team_id', t('cp.f.team'), d.teams.map((x) => ({ value: x.id, label: x.name }))),
        menu('fixture_id', t('cp.f.fixture'), (v) => d.fixtures.filter((f) => f.team_id === v.team_id).map((f) => ({ value: f.id, label: `${f.event_name} · ${fmt(f.scheduled_at)}` })), true),
        menu('event_id', t('cp.f.event'), (v) => d.events.filter((e) => e.team_id === v.team_id).map((e) => ({ value: e.id, label: e.name })), true),
        menu('cohort_id', t('cp.f.cohort'), d.cohorts.map((x) => ({ value: x.id, label: x.name })), true),
        menu('trip_id', t('cp.f.trip'), (v) => d.trips.filter((x) => !x.team_id || x.team_id === v.team_id).map((x) => ({ value: x.id, label: `${x.name} (${x.status})` })), true),
        { key: 'squad_target', label: t('cp.f.squad_target'), type: 'stepper', min: 1, max: 80, default: 18 },
      ]}
      onSubmit={async (x) => { try { await api.post(`/season-plans/${p.id}/entries`, { ...x, ...(x.fixture_id ? { event_id: undefined } : {}) }); onClose(); reload(); } catch (e) { fail(e); throw e; } }} />
  );
}

function CommitteeSheet({ p, entry, onClose, reload, fail }) {
  const cand = useCandidates(p);
  if (cand.loading && !cand.data) return <Loading />;
  const staff = cand.data?.staff ?? [];
  const fields = SEATS.slice(0, 4).map((s) => menu(s, t(`cp.seat.${s}`), staff.map((u) => ({ value: u.user_id, label: u.display_name })), true));
  const initial = Object.fromEntries(entry.committee.map((a) => [a.seat, a.user_id]));
  return (
    <FormSheet visible onClose={onClose} title={t('cp.set_committee')} submitLabel={t('cp.save')} initial={initial} fields={fields}
      onSubmit={async (x) => {
        const members = SEATS.filter((s) => x[s]).map((s) => ({ seat: s, user_id: x[s] }));
        if (!members.length) throw new Error(t('cp.committee.need'));
        try { await api.post(`/season-plans/${p.id}/entries/${entry.id}/committee`, { members }); onClose(); reload(); } catch (e) { fail(e); throw e; }
      }} />
  );
}

function DecideSheet({ p, entry, onClose, reload, fail }) {
  return (
    <FormSheet visible onClose={onClose} title={t('cp.decide')} submitLabel={t('cp.save')} initial={{ decision: 'approved' }}
      fields={[{ key: 'decision', label: t('cp.f.decision'), type: 'choice', options: [{ value: 'approved', label: t('cp.decision.approved') }, { value: 'rejected', label: t('cp.decision.rejected') }] },
        { key: 'evidence', label: t('cp.f.evidence'), type: 'text', multiline: true }]}
      onSubmit={async (x) => { try { await api.post(`/season-plans/${p.id}/entries/${entry.id}/approval`, x); onClose(); reload(); } catch (e) { fail(e); throw e; } }} />
  );
}

function PublishSheet({ p, entry, onClose, reload, fail }) {
  const cand = useCandidates(p);
  if (cand.loading && !cand.data) return <Loading />;
  const team = cand.data?.teams.find((x) => x.id === entry.team_id);
  const opts = (team?.members ?? []).map((m) => ({ value: m.user_id, label: `${m.display_name}${m.availability && m.availability !== 'available' ? ` (${t(`cp.avail.${m.availability}`)})` : ''}` }));
  return (
    <FormSheet visible onClose={onClose} title={t('cp.publish')} submitLabel={t('cp.publish')} initial={{}} notice={t('cp.publish.notice')}
      fields={[{ key: 'players', label: t('cp.f.players'), type: 'multimenu', options: opts }, { key: 'coaches', label: t('cp.f.staff'), type: 'multimenu', optional: true, options: opts }]}
      onSubmit={async (x) => {
        const members = [...(x.players ?? []).map((user_id) => ({ user_id, role: 'player' })), ...(x.coaches ?? []).map((user_id) => ({ user_id, role: 'coach' }))];
        try { await api.post(`/season-plans/${p.id}/entries/${entry.id}/publish-squad`, { members }); onClose(); reload(); } catch (e) { fail(e); throw e; }
      }} />
  );
}

// ------------------------------------------------------------------------------------------------ participation
function Participation({ p, setSheet, archived }) {
  const rev = useLoad(() => api.get(`/season-plans/${p.id}/participation`).catch((e) => ({ error: e })), [p.id]);
  if (rev.loading && !rev.data) return <Loading />;
  if (rev.data?.error) return <Panel><Empty emoji="🔒" title={t('cp.part.locked')} sub={t('cp.part.locked_sub')} /></Panel>;
  const names = Object.fromEntries(p.entries.map((e) => [e.team_id, e.team_name]));
  return (
    <View style={{ gap: 12 }}>
      {!archived ? <Btn title={t('cp.set_objective')} onPress={() => setSheet({ type: 'objective' })} style={{ alignSelf: 'flex-start' }} /> : null}
      {p.objectives.length ? <Panel><Block title={t('cp.objectives')}>{p.objectives.map((x) => <T key={x.id}>• {t(`cp.metric.${x.metric}`)}: {x.target}{x.team_id ? ` (${names[x.team_id] ?? ''})` : ''}</T>)}</Block></Panel> : null}
      {!rev.data.teams.length ? <Panel><Empty emoji="📊" title={t('cp.part.empty')} sub={t('cp.part.empty_sub')} /></Panel> : rev.data.teams.map((tm) => (
        <Panel key={tm.team_id}>
          <T size={16} weight="800">{names[tm.team_id]}</T>
          <T size={12} color={c.mute}>{t('cp.part.fixtures', { done: tm.completed_fixtures, planned: tm.planned_fixtures })}</T>
          {tm.athletes.map((a) => (
            <View key={a.user_id} accessible accessibilityLabel={[a.display_name, t('cp.part.row', { f: a.fixtures_featured, m: a.minutes })].join(', ')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, minHeight: 44, borderTopWidth: 1, borderColor: c.line }}>
              <View style={{ flex: 1 }}>
                <T weight="700">{a.display_name}</T>
                <T size={12} color={c.mute}>{t('cp.part.row', { f: a.fixtures_featured, m: a.minutes })}{a.minutes_unverified_fixtures ? ` · ${t('cp.part.unverified', { n: a.minutes_unverified_fixtures })}` : ''}</T>
                {a.provenance.length ? <T size={11} color={c.mute}>{[...new Set(a.provenance.map((x) => `${t('cp.part.source')} ${x.source}${x.verified ? ' ✓' : ''}`))].join(' · ')}</T> : null}
              </View>
              {a.below_objective ? <Tag label={t('cp.part.below')} color={c.sunSoft} /> : null}
            </View>
          ))}
        </Panel>
      ))}
      <T size={12} color={c.mute}>{t('cp.part.note')}</T>
    </View>
  );
}

function ObjectiveSheet({ p, onClose, reload, fail }) {
  return (
    <FormSheet visible onClose={onClose} title={t('cp.set_objective')} submitLabel={t('cp.save')} initial={{ metric: METRICS[0], target: 60 }}
      fields={[{ key: 'metric', label: t('cp.f.metric'), type: 'choice', options: METRICS.map((k) => ({ value: k, label: t(`cp.metric.${k}`) })) },
        menu('team_id', t('cp.f.team'), [...new Map(p.entries.map((e) => [e.team_id, { value: e.team_id, label: e.team_name }])).values()], true),
        { key: 'target', label: t('cp.f.target'), type: 'stepper', min: 0, max: 1000, default: 60 }]}
      onSubmit={async (x) => { try { await api.post(`/season-plans/${p.id}/objectives`, x); onClose(); reload(); } catch (e) { fail(e); throw e; } }} />
  );
}
