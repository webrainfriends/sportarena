// Academy capacity, progression & workforce scenarios (#805). It lives inside Finance → Forecast beside the commercial scenarios (#395), reading and
// writing the same scenario store, so there is one list and one archive. Every figure is a what-if over the academy's own records: nothing here
// changes a roster, booking, enrolment, cost or curriculum, and a recommendation only records a person's decision.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t as tr } from '../i18n';
import { moneyIn } from '../vtime';
import { Bars, Block, Fact, Kpi, when } from './academy-ui';
import { ScenarioStudio } from './academy-capacity-studio';

const idem = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const OUTCOME = { complete: ['cap.complete', () => c.lime], incomplete: ['cap.incomplete', () => c.sunSoft], impossible: ['cap.impossible', () => c.orangeSoft] };
const Pill = ({ outcome }) => <Tag label={tr(OUTCOME[outcome]?.[0] ?? 'cap.incomplete')} color={(OUTCOME[outcome] ?? OUTCOME.incomplete)[1]()} />;
const Card = ({ children, tone }) => <View style={{ padding: 12, borderRadius: 16, backgroundColor: tone ?? c.bg, gap: 6 }}>{children}</View>;
const Sub = ({ children }) => <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.6, marginTop: 4 }}>{String(children).toUpperCase()}</T>;
const Row = ({ children }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
const num = (v) => (v == null ? tr('cap.missing') : String(v));

function Detail({ s, o, onChanged }) {
  const r = s.result, p = r.projection, cur = p?.totals.cost_currency;
  const [decide, setDecide] = useState(null);
  const decisions = useLoad(() => api.get(`/academy/capacity-scenarios/${s.id}`), [s.id]);
  const done = new Map((decisions.data?.decisions ?? []).map((d) => [d.candidate_key, d]));
  if (r.outcome === 'impossible') {
    return (
      <Card tone={c.orangeSoft}>
        <T weight="800" size={13}>{tr('cap.reasons')}</T>
        {r.reasons.map((x, i) => <T key={i} size={13}>• {x.message}</T>)}
        <T size={12} color={c.mute}>{r.note}</T>
      </Card>
    );
  }
  const added = p.demand.reduce((n, d) => n + d.change + d.promoted_in - d.promoted_out, 0) + p.cohorts.reduce((n, k) => n + k.athletes, 0);
  return (
    <View style={{ gap: 10 }}>
      <Row>
        <Kpi label={tr('cap.kpi_athletes')} value={added} />
        <Kpi label={tr('cap.kpi_coaches')} value={num(p.workforce.coaches_required)} sub={p.workforce.coaches_chosen ? `${p.workforce.coaches_chosen} ✓` : undefined} />
        <Kpi label={tr('cap.kpi_hours')} value={num(p.workforce.coach_hours_week)} />
        <Kpi label={tr('cap.kpi_conflicts')} value={p.totals.conflicts} tone={p.totals.conflicts ? 'alert' : undefined} />
        <Kpi label={tr('cap.kpi_cost')} value={p.totals.cost_minor == null ? tr('cap.missing') : moneyIn(p.totals.cost_minor, cur)} />
      </Row>
      {r.missing.length ? (
        <Card tone={c.sunSoft}>
          <T weight="800" size={13}>{tr('cap.gaps')}</T>
          {r.missing.map((m, i) => <T key={i} size={12}>• {m.cohort ? `${m.cohort}: ` : ''}{m.message}</T>)}
        </Card>
      ) : null}
      {p.demand.some((d) => d.change || d.promoted_in || d.promoted_out) ? (
        <Block title={tr('cap.congestion')}>
          <Bars label={tr('cap.congestion')} rows={p.demand.filter((d) => d.change || d.promoted_in || d.promoted_out).map((d) => ({ label: d.title, value: d.congestion_pct ?? d.projected, text: d.capacity ? `${d.projected}/${d.capacity} · ${d.congestion_pct}%` : `${d.projected}`, tone: d.over_capacity_by > 0 ? c.orange : undefined }))} />
        </Block>
      ) : null}
      {p.pathways.some((w) => w.levels.some((l) => l.promoted_out || l.promoted_in)) ? (
        <Block title={tr('cap.pathway')}>
          {p.pathways.map((w) => <Bars key={w.id} label={w.title} rows={w.levels.map((l) => ({ label: `${w.title} · ${l.title}`, value: l.projected, text: l.seats == null ? `${l.athletes} → ${l.projected}` : `${l.athletes} → ${l.projected} / ${l.seats}`, tone: l.bottleneck ? c.orange : undefined }))} />)}
        </Block>
      ) : null}
      <Block title={tr('cap.cost_title')}>
        <Bars label={tr('cap.cost_title')} rows={[{ label: tr('cap.c_staff'), value: p.cohorts.reduce((n, k) => n + (k.cost.staff_minor ?? 0), 0), text: p.cohorts.some((k) => k.cost.staff_minor == null) ? tr('cap.missing') : moneyIn(p.cohorts.reduce((n, k) => n + k.cost.staff_minor, 0), cur) },
          { label: tr('cap.c_venue'), value: p.cohorts.reduce((n, k) => n + (k.cost.venue_minor ?? 0), 0), text: p.cohorts.some((k) => k.venue && k.cost.venue_minor == null) ? tr('cap.missing') : moneyIn(p.cohorts.reduce((n, k) => n + (k.cost.venue_minor ?? 0), 0), cur) },
          { label: tr('cap.c_hires'), value: p.totals.hire_cost_minor ?? 0, text: p.totals.hire_cost_minor == null ? tr('cap.missing') : moneyIn(p.totals.hire_cost_minor, cur) },
          ...(p.totals.budget ? [{ label: tr('cap.f_budget'), value: p.totals.budget.budget_minor, text: moneyIn(p.totals.budget.budget_minor, cur) }] : [])]} />
      </Block>
      {p.cohorts.some((k) => k.coaches.length) ? (
        <Block title={tr('cap.coach_load')}>
          <Bars label={tr('cap.coach_load')} rows={p.cohorts.flatMap((k) => k.coaches).map((x) => ({ label: x.name, value: x.load_pct ?? 0, text: x.load_pct == null ? tr('cap.missing') : `${x.load_pct}%`, tone: x.overloaded ? c.orange : undefined }))} />
        </Block>
      ) : null}
      {p.cohorts.map((k) => (
        <Card key={k.name}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" size={14} style={{ flex: 1 }}>{k.name}</T><Tag label={`${k.athletes} · ${k.sessions_in_horizon}×`} /></View>
          <Fact k={tr('cap.f_coaches')} v={`${num(k.coaches_required)} ${k.ratio ? `(1:${k.ratio})` : ''} · ${k.coaches_chosen} ✓`} />
          <Fact k={tr('cap.f_venue')} v={k.venue?.name} />
          <Fact k={tr('cap.kpi_cost')} v={k.cost.total_minor == null ? tr('cap.missing') : moneyIn(k.cost.total_minor, k.cost.currency)} />
          {k.coaches.map((x) => <Fact key={x.user_id} k={x.name} v={x.load_pct == null ? tr('cap.missing') : `${x.assigned_hours_week}h + ${x.proposed_hours_week}h / ${x.available_hours_week}h · ${x.load_pct}%`} />)}
          <Sub>{tr('cap.conflicts')}</Sub>
          {[...k.conflicts.venue, ...k.conflicts.staff, ...k.conflicts.school].length
            ? [...k.conflicts.venue, ...k.conflicts.staff, ...k.conflicts.school].slice(0, 8).map((x, i) => <T key={i} size={12}>• {when(x.date)} — {x.message}</T>)
            : <T size={12} color={c.mute}>{tr('cap.none')}</T>}
        </Card>
      ))}
      {r.candidates.length ? (
        <Block title={tr('cap.candidates')}>
          <T size={12} color={c.mute}>{tr('cap.candidates_note')}</T>
          {r.candidates.map((x) => {
            const d = done.get(x.key);
            return (
              <Card key={x.key}>
                <T weight="800" size={13}>{x.title}</T>
                <T size={12}>{x.why}</T>
                <Tag label={`${tr('cap.open_in')} ${x.owner_screen}`} />
                <T size={11} color={c.mute}>{x.rule}</T>
                {d ? <Tag label={`${tr(`cap.${d.decision === 'approved' ? 'approve' : d.decision === 'declined' ? 'decline' : 'defer'}`)} · ${d.reason}`} />
                  : <Row>{['approved', 'declined', 'deferred'].map((k) => <Btn key={k} small title={tr(`cap.${k === 'approved' ? 'approve' : k === 'declined' ? 'decline' : 'defer'}`)} color={k === 'approved' ? c.pink : c.paper} ink={k === 'approved' ? undefined : c.ink} onPress={() => setDecide({ cand: x.key, decision: k })} />)}</Row>}
              </Card>
            );
          })}
        </Block>
      ) : null}
      <Block title={tr('cap.sources')}>
        {s.baseline.sources.map((x) => <T key={x.key} size={12} color={c.mute}>• {x.label} — {x.from}</T>)}
      </Block>
      <FormSheet visible={!!decide} onClose={() => setDecide(null)} title={tr('cap.candidates')} submitLabel={tr('cap.record')} fields={[{ key: 'reason', label: tr('cap.why_reason'), type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/academy/capacity-scenarios/${s.id}/decisions`, { candidate_key: decide.cand, decision: decide.decision, reason: v.reason, idempotency_key: idem('dec') }); decisions.reload(); onChanged?.(); return tr('cap.decided'); }} />
    </View>
  );
}

export function CapacityScenarios({ o, archived }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/scenarios`, { kind: 'capacity', limit: 50 }), [o.id]);
  const base = useLoad(() => api.get(`/organisations/${o.id}/academy/capacity/baseline`), [o.id]);
  const [studio, setStudio] = useState(false), [open, setOpen] = useState(null), [pick, setPick] = useState([]), [cmp, setCmp] = useState(null), [err, setErr] = useState(null);
  const b = base.data;
  const togglePick = (id) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 4 ? [...p, id] : p));
  const compare = async () => { setErr(null); try { setCmp(await api.get(`/organisations/${o.id}/academy/capacity-scenarios/compare`, { scenario_ids: pick.join(',') })); } catch (e) { setErr(e); } };
  if (studio) return <ScenarioStudio o={o} onClose={() => setStudio(false)} onSaved={() => { setStudio(false); list.reload(); }} />;
  return (
    <View style={{ gap: 10 }}>
      <Block title={tr('cap.title')} right={!archived ? <Btn small title={`＋ ${tr('cap.new')}`} onPress={() => setStudio(true)} /> : null}>
        <T size={12} color={c.mute}>{tr('cap.intro')}</T>
        {b ? (
          <Row>
            <Kpi label={tr('cap.b_programmes')} value={b.programmes.length} />
            <Kpi label={tr('cap.b_coaches')} value={b.coaches.length} sub={`${b.coaches.filter((x) => x.available_hours_week > 0).length} ✓`} />
            <Kpi label={tr('cap.b_venues')} value={b.venues.length} />
            <Kpi label={tr('cap.b_levels')} value={b.pathways.reduce((n, p) => n + p.levels.length, 0)} />
          </Row>
        ) : null}
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((s) => (
          <Card key={s.id}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <T weight="800" size={14} style={{ flex: 1 }}>{s.name}</T><Pill outcome={s.outcome} /><Tag label={tr('cap.not_actuals')} color={c.sunSoft} />
            </View>
            <T size={12} color={c.mute}>{when(s.horizon_from)} – {when(s.horizon_to)}</T>
            <Row>
              <Btn small title={open === s.id ? '▲' : '▼'} color={c.paper} ink={c.ink} onPress={() => setOpen(open === s.id ? null : s.id)} />
              <Chip label={tr('cap.compare')} active={pick.includes(s.id)} onPress={() => togglePick(s.id)} />
              {!archived ? <Btn small title={tr('cap.archive')} color={c.paper} ink={c.ink} onPress={async () => { await api.post(`/academy/scenarios/${s.id}/archive`, {}); list.reload(); }} /> : null}
            </Row>
            {open === s.id ? <Detail s={s} o={o} onChanged={list.reload} /> : null}
          </Card>
        )) : <Empty emoji="🧭" title={tr('cap.empty_t')} sub={tr('cap.empty_s')} />}
        {pick.length >= 2 ? <Btn small title={`${tr('cap.compare')} (${pick.length})`} onPress={compare} style={{ alignSelf: 'flex-start' }} /> : pick.length ? <T size={12} color={c.mute}>{tr('cap.compare_pick')}</T> : null}
        {err ? <ErrorBox error={err} /> : null}
        {cmp ? (
          <Card>
            <Tag label={cmp.same_baseline ? tr('cap.same_base') : tr('cap.diff_base')} color={cmp.same_baseline ? c.lime : c.sunSoft} />
            {cmp.scenarios.map((x) => (
              <View key={x.scenario_id} style={{ gap: 2 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}><T weight="800" size={13} style={{ flex: 1 }}>{x.name}</T><Pill outcome={x.outcome} /></View>
                <T size={12}>{tr('cap.kpi_athletes')} {num(x.athletes_added)} · {tr('cap.kpi_coaches')} {num(x.coaches_required)} · {tr('cap.kpi_hours')} {num(x.coach_hours_week)} · {tr('cap.kpi_conflicts')} {num(x.conflicts)} · {tr('cap.kpi_cost')} {x.cost_minor == null ? tr('cap.missing') : moneyIn(x.cost_minor, x.cost_currency)}</T>
              </View>
            ))}
          </Card>
        ) : null}
      </Block>
    </View>
  );
}
