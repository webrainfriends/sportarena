// Academy capacity Scenario Studio (#805): the guided builder for a capacity, progression & workforce what-if. Every input is a real control
// (calendar range, steppers, day chips, time pickers, searchable pickers, multi-select) fed by the academy's own baseline. The right-hand
// Live impact panel re-runs the same capability as a dry run (preview: nothing is saved, nothing in the academy changes).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, ErrorBox, Loading, T, Tag, Field } from '../ui';
import { c } from '../theme';
import { t as tr } from '../i18n';
import { moneyIn } from '../vtime';
import { useLayout } from '../layout';
import { Counter, DateRangeField, TimeField } from '../pickers';
import { MenuField, MultiMenuField } from '../menu-field';
import { Bars, Block, Kpi, Meter, when } from './academy-ui';

const idem = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const OBJECTIVES = ['add_cohort', 'promotions', 'grow', 'staffing'];
const STEPS = ['brief', 'demand', 'cohorts', 'constraints', 'review'];
const Card = ({ children, tone, style }) => <View style={[{ padding: 14, borderRadius: 18, backgroundColor: tone ?? c.paper, borderWidth: 1, borderColor: c.line, gap: 10 }, style]}>{children}</View>;
const Row = ({ children, style }) => <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }, style]}>{children}</View>;
const J = (...parts) => parts.join(' ');
const num = (v) => (v == null ? tr('cap.missing') : String(v));
const blankCohort = () => ({ key: idem('co'), name: '', programme_id: undefined, athletes: 12, weekdays: [], start: '17:00', end: '18:00', venue_id: undefined, coach_ids: [], source_cohort_id: undefined, ratio: 0 });

/** The assumptions the API takes, from what the person has filled in so far; incomplete cohorts are left out of the live run. */
export function buildAssumptions(s) {
  const complete = (k) => k.name.trim().length >= 2 && k.programme_id && k.weekdays.length && k.start && k.end && mins(k.end) > mins(k.start);
  return {
    horizon: { from: s.from, to: s.to },
    enrolment_mix: Object.entries(s.mix).filter(([, n]) => n).map(([programme_id, change]) => ({ programme_id, change })),
    promotions: Object.entries(s.promo).filter(([, n]) => n > 0).map(([k, athletes]) => { const [pathway_id, from_level] = k.split(':'); return { pathway_id, from_level, athletes }; }),
    cohorts: s.cohorts.filter(complete).map((k) => ({ name: k.name.trim(), programme_id: k.programme_id, athletes: k.athletes, weekdays: k.weekdays, start_time: k.start, end_time: k.end, coach_ids: k.coach_ids,
      ...(k.venue_id ? { venue_id: k.venue_id } : {}), ...(k.source_cohort_id ? { source_cohort_id: k.source_cohort_id } : {}), ...(k.ratio ? { max_ratio: k.ratio } : {}) })),
    extra_coaches: s.extra_coaches, ...(s.extra_coaches && s.extra_hours ? { extra_coach_hours_week: s.extra_hours } : {}), ...(s.budget ? { budget_minor: s.budget } : {}),
  };
}
const hasInput = (a) => a.enrolment_mix.length + a.promotions.length + a.cohorts.length + a.extra_coaches > 0;

export function LiveImpact({ run, busy, cur }) {
  const r = run?.result, p = r?.projection;
  const added = p ? p.demand.reduce((n, d) => n + d.change + d.promoted_in - d.promoted_out, 0) + p.cohorts.reduce((n, k) => n + k.athletes, 0) : null;
  const tone = r?.outcome === 'impossible' ? c.orangeSoft : r?.outcome === 'complete' ? c.lime : c.sunSoft;
  return (
    <Card style={{ borderColor: c.violet }}>
      <Row style={{ justifyContent: 'space-between' }}><T weight="800" size={14}>{tr('cap.live')}</T>{busy ? <T size={12} color={c.mute}>{tr('cap.live_busy')}</T> : r ? <Tag label={tr(`cap.${r.outcome}`)} color={tone} /> : null}</Row>
      {!r ? <T size={12} color={c.mute}>{tr('cap.live_empty')}</T> : r.outcome === 'impossible' ? <View style={{ gap: 4 }}>{r.reasons.slice(0, 4).map((x, i) => <T key={i} size={12}>• {x.message}</T>)}</View> : (
        <>
          <Row>
            <Kpi label={tr('cap.kpi_athletes')} value={added} />
            <Kpi label={tr('cap.kpi_coaches')} value={num(p.workforce.coaches_required)} sub={`${p.workforce.coaches_chosen} ✓`} />
            <Kpi label={tr('cap.kpi_hours')} value={num(p.workforce.coach_hours_week)} />
            <Kpi label={tr('cap.kpi_conflicts')} value={p.totals.conflicts} tone={p.totals.conflicts ? 'alert' : undefined} />
            <Kpi label={tr('cap.kpi_cost')} value={p.totals.cost_minor == null ? tr('cap.missing') : moneyIn(p.totals.cost_minor, cur)} />
          </Row>
          {p.totals.budget ? <Tag label={p.totals.budget.within == null ? tr('cap.budget_unknown') : p.totals.budget.within ? `${tr('cap.within_budget')} · ${moneyIn(p.totals.budget.headroom_minor, cur)}` : `${tr('cap.over_budget')} · ${moneyIn(-p.totals.budget.headroom_minor, cur)}`} color={p.totals.budget.within === false ? c.orangeSoft : c.lime} /> : null}
          {r.missing.length ? <T size={12} color={c.mute}>{tr('cap.gaps')}: {r.missing.length}</T> : null}
          <T size={11} color={c.mute}>{tr('cap.live_note')}</T>
        </>
      )}
    </Card>
  );
}

function Brief({ s, set, b }) {
  const quick = [[tr('cap.q_term'), 28 * 3], [tr('cap.q_12w'), 12 * 7], [tr('cap.q_6m'), 26 * 7]];
  return (
    <View style={{ gap: 14 }}>
      <Field label={tr('cap.f_name')} value={s.name} onChangeText={(x) => set({ name: x })} placeholder={tr('cap.f_name_ph')} />
      <View style={{ gap: 6 }}><T weight="800" size={13}>{tr('cap.f_objective')}</T><Row>{OBJECTIVES.map((o) => <Chip key={o} label={tr(`cap.obj_${o}`)} active={s.objective === o} onPress={() => set({ objective: o })} />)}</Row></View>
      {b.seasons.length ? <MenuField label={tr('cap.f_season')} value={s.season} onChange={(id) => { const x = b.seasons.find((z) => z.id === id); set({ season: id, from: x.starts_on > today() ? x.starts_on : today(), to: x.ends_on }); }} options={b.seasons.map((x) => ({ value: x.id, label: x.name, sub: `${when(x.starts_on)} – ${when(x.ends_on)}` }))} placeholder={tr('cap.f_season_ph')} /> : null}
      <DateRangeField label={tr('cap.f_horizon')} from={s.from} to={s.to} onChange={({ from, to }) => set({ from, to, season: undefined })} min={today()} />
      <Row>{quick.map(([l, d]) => <Chip key={l} label={l} onPress={() => set({ from: addDays(today(), 7), to: addDays(today(), 7 + d), season: undefined })} />)}</Row>
      <Card tone={c.bg}>
        <T weight="800" size={13}>{tr('cap.baseline')}</T>
        <Row>
          <Kpi label={tr('cap.b_programmes')} value={b.programmes.length} />
          <Kpi label={tr('cap.b_coaches')} value={b.coaches.length} sub={`${b.coaches.filter((x) => x.available_hours_week > 0).length} ✓ ${tr('cap.avail')}`} />
          <Kpi label={tr('cap.b_venues')} value={b.venues.length} />
          <Kpi label={tr('cap.b_levels')} value={b.pathways.reduce((n, p) => n + p.levels.length, 0)} />
        </Row>
        <T size={11} color={c.mute}>{tr('cap.fresh')} {new Date(b.taken_at).toLocaleString()}</T>
      </Card>
    </View>
  );
}

function Demand({ s, set, b }) {
  return (
    <View style={{ gap: 14 }}>
      <Block title={tr('cap.sec_mix')}>
        {b.programmes.length ? b.programmes.map((p) => {
          const change = s.mix[p.id] ?? 0, projected = p.enrolled + change;
          return (
            <Card key={p.id}>
              <Row style={{ justifyContent: 'space-between' }}><View style={{ flex: 1 }}><T weight="800" size={14}>{p.title}</T><T size={12} color={c.mute}>{p.sport}</T></View>
                <Counter value={change} min={-p.enrolled} max={500} onChange={(n) => set({ mix: { ...s.mix, [p.id]: n } })} a11y={p.title} /></Row>
              <Meter filled={p.enrolled} capacity={p.capacity} waitlisted={p.waitlisted} />
              <Row><Tag label={J(tr('cap.waitlist'), p.waitlisted)} /><Tag label={J(tr('cap.offers'), p.offers_open)} /><Tag label={J(tr('cap.review'), p.in_review)} /></Row>
              {change ? <Bars label={p.title} rows={[{ label: tr('cap.projected'), value: p.capacity ? Math.round((projected / p.capacity) * 100) : projected, text: p.capacity ? `${projected}/${p.capacity} · ${Math.round((projected / p.capacity) * 100)}%` : `${projected}`, tone: p.capacity && projected > p.capacity ? c.orange : undefined }]} /> : null}
            </Card>
          );
        }) : <T size={12} color={c.mute}>{tr('cap.no_programmes')}</T>}
      </Block>
      <Block title={tr('cap.sec_promo')}>
        <T size={12} color={c.mute}>{tr('cap.promo_note')}</T>
        {b.pathways.length ? b.pathways.map((w) => (
          <Card key={w.id}>
            <T weight="800" size={14}>{w.title}</T>
            {w.levels.map((l, i) => {
              const k = `${w.id}:${l.key}`, last = i === w.levels.length - 1, out = s.promo[k] ?? 0;
              return (
                <View key={l.key} style={{ gap: 6, paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
                  <Row style={{ justifyContent: 'space-between' }}><T weight="700" size={13} style={{ flex: 1 }}>{l.title}</T>
                    {last ? <Tag label={tr('cap.last_level')} /> : <Counter value={out} min={0} max={l.athletes} onChange={(n) => set({ promo: { ...s.promo, [k]: n } })} a11y={l.title} />}</Row>
                  <Meter filled={l.athletes - out + (i && s.promo[`${w.id}:${w.levels[i - 1].key}`] ? s.promo[`${w.id}:${w.levels[i - 1].key}`] : 0)} capacity={l.seats ?? undefined} />
                </View>
              );
            })}
          </Card>
        )) : <T size={12} color={c.mute}>{tr('cap.no_pathways')}</T>}
      </Block>
    </View>
  );
}

function CohortCard({ k, update, remove, b, s, orgId, index }) {
  const prog = b.programmes.find((p) => p.id === k.programme_id);
  const venues = b.venues.filter((v) => !prog || !v.sports.length || v.sports.some((x) => x.toLowerCase() === String(prog.sport).toLowerCase()));
  const venue = b.venues.find((v) => v.id === k.venue_id);
  const [slots, setSlots] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  const dur = k.start && k.end ? mins(k.end) - mins(k.start) : 0;
  const find = async () => {
    setBusy(true); setErr(null);
    try { setSlots(await api.post(`/organisations/${orgId}/academy/capacity-scenarios/slots`, { horizon: { from: s.from, to: s.to }, weekdays: k.weekdays, duration_min: dur > 0 ? dur : 60, earliest: 360, latest: 1320, venue_id: k.venue_id, coach_ids: k.coach_ids, source_cohort_id: k.source_cohort_id })); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const maxBooked = venue ? Math.max(1, ...venue.booked_hours_by_weekday) : 1;
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}><T weight="800" size={14}>{tr('cap.cohort_n', { n: index + 1 })}</T><Btn small title={tr('cap.remove')} color={c.paper} ink={c.ink} onPress={remove} /></Row>
      <Field label={tr('cap.f_cohort')} value={k.name} onChangeText={(x) => update({ name: x })} placeholder={tr('cap.f_cohort_ph')} />
      <MenuField label={tr('cap.f_cohort_prog')} value={k.programme_id} onChange={(v) => update({ programme_id: v, venue_id: undefined })} options={b.programmes.map((p) => ({ value: p.id, label: p.title, sub: `${p.sport} · ${p.enrolled}${p.capacity ? `/${p.capacity}` : ''}` }))} placeholder={tr('cap.pick')} />
      <Counter value={k.athletes} min={1} max={500} onChange={(n) => update({ athletes: n })} label={tr('cap.f_athletes')} a11y={tr('cap.f_athletes')} />
      <View style={{ gap: 6 }}><T weight="800" size={13}>{tr('cap.f_days')}</T>
        <Row>{DAYS.map(([d, n]) => <Chip key={d} label={n} active={k.weekdays.includes(d)} onPress={() => update({ weekdays: k.weekdays.includes(d) ? k.weekdays.filter((x) => x !== d) : [...k.weekdays, d] })} />)}</Row></View>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1, minWidth: 150 }}><TimeField label={tr('cap.f_start')} value={k.start} onChange={(v) => update({ start: v, end: mins(k.end) > mins(v) ? k.end : clock(mins(v) + (dur > 0 ? dur : 60)) })} step={15} /></View>
        <View style={{ flex: 1, minWidth: 150 }}><TimeField label={tr('cap.f_end')} value={k.end} onChange={(v) => update({ end: v })} step={15} /></View>
      </Row>
      <Row>{[60, 75, 90, 120].map((m) => <Chip key={m} label={J(m, tr('cap.min'))} active={dur === m} onPress={() => update({ end: clock(mins(k.start) + m) })} />)}</Row>
      <MenuField label={tr('cap.f_venue')} value={k.venue_id} onChange={(v) => update({ venue_id: v })} options={venues.map((v) => ({ value: v.id, label: v.name, sub: `${v.city ?? ''} ${v.sports.join(', ')} · ${v.resources} ${tr('cap.courts')}` }))} placeholder={tr('cap.pick_optional')} hint={prog && venues.length < b.venues.length ? tr('cap.venue_filtered', { sport: prog.sport }) : undefined} />
      {venue ? (
        <View style={{ gap: 4 }} accessible accessibilityLabel={`${tr('cap.week_booked')}: ${venue.booked_hours_by_weekday.map((h, d) => `${DAYS.find(([x]) => x === d)?.[1]} ${h}`).join(', ')}`}>
          <T size={11} weight="800" color={c.mute}>{tr('cap.week_booked').toUpperCase()}</T>
          <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-end', gap: 6 }}>
            {DAYS.map(([d, n]) => { const h = venue.booked_hours_by_weekday[d] ?? 0, on = k.weekdays.includes(d); return (
              <View key={d} style={{ flex: 1, alignItems: 'center', gap: 3 }}>
                <T size={10} color={c.mute}>{h}h</T>
                <View style={{ height: 40, width: '100%', justifyContent: 'flex-end', backgroundColor: c.violetSoft, borderRadius: 6 }}><View style={{ height: Math.max(2, Math.round((h / maxBooked) * 40)), borderRadius: 6, backgroundColor: on ? c.pink : c.mute }} /></View>
                <T size={10} weight={on ? '800' : '500'}>{n}</T>
              </View>); })}
          </Row>
        </View>
      ) : null}
      <MultiMenuField label={tr('cap.f_coaches')} value={k.coach_ids} onChange={(v) => update({ coach_ids: v })} max={12} placeholder={tr('cap.pick_optional')}
        options={b.coaches.map((x) => ({ value: x.id, label: x.name, sub: x.available_hours_week ? `${x.assigned_hours_week}h / ${x.available_hours_week}h ${tr('cap.per_week')}` : tr('cap.no_availability') }))} />
      <MenuField label={tr('cap.f_source')} value={k.source_cohort_id} onChange={(v) => update({ source_cohort_id: v })} options={b.cohorts.map((x) => ({ value: x.id, label: x.name, sub: `${x.enrolled} ${tr('cap.athletes')}` }))} placeholder={tr('cap.pick_optional')} hint={tr('cap.source_hint')} />
      <Counter value={k.ratio} min={0} max={100} onChange={(n) => update({ ratio: n })} label={tr('cap.f_ratio')} a11y={tr('cap.f_ratio')} />
      <Btn small title={busy ? tr('cap.finding') : tr('cap.find_slots')} onPress={find} disabled={busy || !k.weekdays.length} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} />
      {err ? <ErrorBox error={err} /> : null}
      {slots ? (
        <View style={{ gap: 6 }}>
          <T size={12} color={c.mute}>{slots.note}</T>
          <Row>{slots.suggestions.map((x) => <Chip key={x.start_time} label={J(x.start_time, '·', x.total ? tr('cap.n_conflicts', { n: x.total }) : tr('cap.clear'))} active={k.start === x.start_time} onPress={() => update({ start: x.start_time, end: x.end_time })} />)}</Row>
        </View>
      ) : null}
    </Card>
  );
}

function Cohorts({ s, set, b, orgId }) {
  return (
    <View style={{ gap: 12 }}>
      <T size={12} color={c.mute}>{tr('cap.cohorts_note')}</T>
      {s.cohorts.map((k, i) => <CohortCard key={k.key} k={k} index={i} b={b} s={s} orgId={orgId} update={(p) => set({ cohorts: s.cohorts.map((x) => (x.key === k.key ? { ...x, ...p } : x)) })} remove={() => set({ cohorts: s.cohorts.filter((x) => x.key !== k.key) })} />)}
      {s.cohorts.length < 6 ? <Btn title={J('＋', tr('cap.add_cohort'))} onPress={() => set({ cohorts: [...s.cohorts, blankCohort()] })} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}

function Constraints({ s, set, b }) {
  const cur = b.currency;
  return (
    <View style={{ gap: 14 }}>
      <Card>
        <T weight="800" size={14}>{tr('cap.sec_hires')}</T>
        <T size={12} color={c.mute}>{b.staff_cost ? tr('cap.rate_source', { rate: moneyIn(b.staff_cost.per_hour_minor, b.staff_cost.currency), hours: b.staff_cost.hours }) : tr('cap.rate_missing')}</T>
        <Counter value={s.extra_coaches} min={0} max={50} onChange={(n) => set({ extra_coaches: n })} label={tr('cap.f_extra_coaches')} a11y={tr('cap.f_extra_coaches')} />
        {s.extra_coaches ? <Counter value={s.extra_hours} min={1} max={80} step={1} onChange={(n) => set({ extra_hours: n })} label={tr('cap.f_extra_hours')} suffix=" h" a11y={tr('cap.f_extra_hours')} /> : null}
      </Card>
      <Card>
        <T weight="800" size={14}>{tr('cap.sec_budget')}</T>
        <Field label={`${tr('cap.f_budget')}${cur ? ` · ${cur}` : ''}`} value={s.budget_text} keyboardType="decimal-pad" placeholder={tr('cap.optional')} onChangeText={(x) => { const t = x.replace(/[^0-9.]/g, ''); set({ budget_text: t, budget: t ? Math.round(parseFloat(t) * 100) || 0 : 0 }); }} />
        <T size={11} color={c.mute}>{tr('cap.budget_note')}</T>
      </Card>
    </View>
  );
}

function Review({ s, a, run, b }) {
  const r = run?.result;
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <T weight="800" size={14}>{s.name || tr('cap.unnamed')}</T>
        <T size={12} color={c.mute}>{when(s.from)} – {when(s.to)} · {tr(`cap.obj_${s.objective}`)}</T>
        <T size={13}>{[a.enrolment_mix.length ? `${tr('cap.sec_mix')}: ${a.enrolment_mix.map((m) => `${b.programmes.find((p) => p.id === m.programme_id)?.title} ${m.change > 0 ? '+' : ''}${m.change}`).join(', ')}` : null, a.promotions.length ? `${tr('cap.sec_promo')}: ${a.promotions.reduce((n, x) => n + x.athletes, 0)}` : null, a.extra_coaches ? `${tr('cap.f_extra_coaches')}: ${a.extra_coaches}` : null].filter(Boolean).join(' · ') || ' '}</T>
        {a.cohorts.map((k) => <T key={k.name} size={13}>• {k.name}: {k.athletes} · {k.weekdays.map((d) => DAYS.find(([x]) => x === d)?.[1]).join(' ')} {k.start_time}–{k.end_time}</T>)}
      </Card>
      {r?.missing?.length ? <Card tone={c.sunSoft}><T weight="800" size={13}>{tr('cap.gaps')}</T>{r.missing.map((m, i) => <T key={i} size={12}>• {m.cohort ? `${m.cohort}: ` : ''}{m.message}</T>)}</Card> : null}
      {r?.outcome === 'impossible' ? <Card tone={c.orangeSoft}><T weight="800" size={13}>{tr('cap.reasons')}</T>{r.reasons.map((m, i) => <T key={i} size={12}>• {m.message}</T>)}</Card> : null}
      <T size={12} color={c.mute}>{tr('cap.review_note')}</T>
    </View>
  );
}

export function ScenarioStudio({ o, onClose, onSaved }) {
  const { tablet } = useLayout();
  const base = useLoad(() => api.get(`/organisations/${o.id}/academy/capacity/baseline`), [o.id]);
  const [step, setStep] = useState(0), [key] = useState(() => idem('cap'));
  const [s, setS] = useState({ name: '', objective: 'add_cohort', season: undefined, from: addDays(today(), 7), to: addDays(today(), 7 + 12 * 7), mix: {}, promo: {}, cohorts: [], extra_coaches: 0, extra_hours: 6, budget: 0, budget_text: '' });
  const set = (p) => setS((x) => ({ ...x, ...p }));
  const a = useMemo(() => buildAssumptions(s), [s]);
  const [run, setRun] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState(null), [saving, setSaving] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!hasInput(a) || s.to < s.from) { setRun(null); return undefined; }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try { const r = await api.post(`/organisations/${o.id}/academy/capacity-scenarios`, { name: s.name.trim().length >= 2 ? s.name.trim() : 'Preview', assumptions: a, preview: true }); if (my === seq.current) setRun(r); }
      catch (e) { if (my === seq.current) setErr(e); } finally { if (my === seq.current) setBusy(false); }
    }, 700);
    return () => clearTimeout(t);
  }, [JSON.stringify(a)]);
  const b = base.data;
  const save = async () => {
    setSaving(true); setErr(null);
    try { await api.post(`/organisations/${o.id}/academy/capacity-scenarios`, { name: s.name.trim(), assumptions: a, idempotency_key: key }); onSaved(); } catch (e) { setErr(e); } finally { setSaving(false); }
  };
  if (base.error) return <ErrorBox error={base.error} onRetry={base.reload} />;
  if (!b) return <Loading />;
  const canSave = s.name.trim().length >= 2 && hasInput(a);
  const body = [<Brief key="b" s={s} set={set} b={b} />, <Demand key="d" s={s} set={set} b={b} />, <Cohorts key="c" s={s} set={set} b={b} orgId={o.id} />, <Constraints key="k" s={s} set={set} b={b} />, <Review key="r" s={s} a={a} run={run} b={b} />][step];
  return (
    <View style={{ gap: 12 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Btn small title={J('←', tr('cap.back'))} onPress={onClose} color={c.paper} ink={c.ink} />
        <T weight="800" size={16} style={{ flex: 1 }}>{tr('cap.studio')}</T>
      </Row>
      <Row accessibilityRole="tablist">{STEPS.map((k, i) => <Chip key={k} label={`${i + 1} · ${tr(`cap.step_${k}`)}`} active={step === i} onPress={() => setStep(i)} />)}</Row>
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
        {!tablet ? <View style={{ width: '100%' }}><LiveImpact run={run} busy={busy} cur={b.currency} /></View> : null}
        <View style={{ flex: tablet ? 1.7 : undefined, width: tablet ? undefined : '100%', gap: 12 }}>
          {body}
          {err ? <ErrorBox error={err} /> : null}
          <Row style={{ justifyContent: 'space-between' }}>
            <Btn title={tr('cap.prev')} onPress={() => setStep(Math.max(0, step - 1))} disabled={step === 0} color={c.paper} ink={c.ink} />
            {step < STEPS.length - 1 ? <Btn title={tr('cap.next')} onPress={() => setStep(step + 1)} /> : <Btn title={saving ? tr('cap.saving') : tr('cap.run')} onPress={save} disabled={!canSave || saving} />}
          </Row>
          {step === STEPS.length - 1 && !canSave ? <T size={12} color={c.mute}>{tr('cap.need_name_input')}</T> : null}
        </View>
        {tablet ? <View style={{ flex: 1 }}><LiveImpact run={run} busy={busy} cur={b.currency} /></View> : null}
      </View>
    </View>
  );
}
