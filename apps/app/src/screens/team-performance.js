// Team / batch performance: how a team or an academy batch is doing across the sessions the coach ran, with findings and recommendations,
// and a consolidated report the coach can hand to an academy, organisation or sponsor. Aggregates only: no athlete is named here or in the report.
// Every figure, finding and suggestion comes from the server (REST/MCP capabilities); this screen only asks and presents.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { Btn, Chip, Empty, ErrorBox, H1, Loading, Screen, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { DateRangeField, todayLocal } from '../pickers';
import { BarRows } from './report-sections';
import { Metric } from './session-workspace';
import { explain } from '../access';
import { t } from '../i18n';
import { c, when } from '../theme';
const colon = (a, b) => `${a}: ${b}`;
const tool = (s) => `🧰 ${s}`;

const TONE = { risk: [c.red, c.redSoft], watch: [c.sun, c.sunSoft], good: [c.mint, c.mintSoft], info: [c.cyan, c.cyanSoft] };
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const pct = (v) => (v == null ? '—' : `${v}%`);
const wk = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function TeamPerformance({ team_id, cohort_id }) {
  const { tablet } = useLayout();
  const { toast } = useSession();
  const { push } = useNav();
  const scopes = useLoad(() => api.get('/coaching/team-performance/scopes'), []);
  const sheets = useLoad(() => api.get('/coaching/rubrics', { limit: 50 }), []);
  const today = todayLocal();
  const [scope, setScope] = useState(team_id ? `team:${team_id}` : cohort_id ? `batch:${cohort_id}` : '');
  const [range, setRange] = useState({ from: addDays(today, -56), to: today });
  const [rubric, setRubric] = useState('');
  const [ai, setAi] = useState(null), [aiBusy, setAiBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const options = useMemo(() => [...(scopes.data?.teams ?? []).map((x) => ({ value: `team:${x.id}`, label: x.name, sub: t('tpf.team') })), ...(scopes.data?.batches ?? []).map((x) => ({ value: `batch:${x.id}`, label: x.name, sub: `${t('tpf.batch')} · ${x.organisation}` }))], [scopes.data]);
  const only = options.length === 1 ? options[0].value : '';
  const chosen = scope || only;
  const [kind, id] = chosen ? chosen.split(':') : [null, null];
  const q = chosen ? { ...(kind === 'team' ? { team_id: id } : { cohort_id: id }), from: range.from, to: range.to, ...(rubric ? { rubric_id: rubric } : {}) } : null;
  const key = JSON.stringify(q);
  const perf = useLoad(() => (q ? api.get('/coaching/team-performance', q) : Promise.resolve(null)), [key]);
  const found = useLoad(() => (q ? api.post('/coaching/team-performance/findings', { ...q, use_ai: false }) : Promise.resolve(null)), [key]);
  const p = perf.data;

  const askAi = async () => {
    setAiBusy(true);
    try { const r = await api.post('/coaching/team-performance/findings', { ...q, use_ai: true }); if (r.ai) setAi(r.ai); else toast(r.ai_available ? t('tpf.ai_failed') : t('tpf.ai_off')); }
    catch (e) { toast(explain(e)); } finally { setAiBusy(false); }
  };
  const summaryText = ai ? [ai.headline, ...ai.suggestions.map((s) => `• ${s.title}: ${s.detail}`)].join('\n') : (found.data?.headline ?? '');

  const header = (
    <>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('tpf.eyebrow').toUpperCase()}</T>
      <H1 style={{ fontSize: tablet ? 30 : 26 }}>{t('tpf.title')}</H1>
      <T color={c.mute}>{t('tpf.sub')}</T>
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 10, marginTop: 12, alignItems: tablet ? 'flex-end' : 'stretch' }}>
        <View style={{ flex: 1 }}><MenuField label={t('tpf.scope')} value={chosen} onChange={setScope} options={options} placeholder={t('tpf.scope_pick')} title={t('tpf.scope')} /></View>
        <View style={{ flex: 1 }}><DateRangeField label={t('tpf.period')} from={range.from} to={range.to} onChange={setRange} /></View>
        <View style={{ flex: 1 }}><MenuField label={t('tpf.sheet')} value={rubric} onChange={setRubric} options={[{ value: '', label: t('tpf.sheet_auto') }, ...(sheets.data ?? []).map((r) => ({ value: r.id, label: r.name, sub: (r.dimensions ?? []).map((x) => x.name).join(', ') }))]} title={t('tpf.sheet')} /></View>
      </View>
    </>
  );
  if (scopes.error) return <Screen wide><ErrorBox error={scopes.error} onRetry={scopes.reload} /></Screen>;
  if (!scopes.data) return <Screen wide><Loading /></Screen>;
  if (!options.length) return <Screen wide>{header}<Empty emoji="🧑‍🤝‍🧑" title={t('tpf.no_scopes')} sub={t('tpf.no_scopes_sub')} /></Screen>;
  if (!chosen) return <Screen wide>{header}<Empty emoji="📊" title={t('tpf.pick_title')} sub={t('tpf.pick_sub')} /></Screen>;
  if (perf.error) return <Screen wide>{header}<ErrorBox error={perf.error} onRetry={perf.reload} /></Screen>;
  if (!p) return <Screen wide>{header}<Loading /></Screen>;
  if (!p.sessions.total) return <Screen wide>{header}<Empty emoji="🗓️" title={t('tpf.no_sessions')} sub={t('tpf.no_sessions_sub')} /></Screen>;

  const dl = p.delivery;
  const hasLoad = p.load.by_week.some((w) => w.au);
  const hasWeeks = p.attendance.by_week.length > 0;
  const strip = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
      <Metric label={t('tpf.m.sessions')} value={String(p.sessions.total)} sub={t('tpf.m.completed', { n: p.sessions.completed })} />
      <Metric label={t('tpf.m.athletes')} value={String(p.athletes.n)} sub={p.shareable ? t('tpf.m.shareable') : t('tpf.m.small')} tone={p.shareable ? c.ink : c.sun} />
      <Metric label={t('tpf.m.attendance')} value={pct(p.attendance.rate)} sub={p.attendance.sessions_without_record ? t('tpf.m.att_missing', { n: p.attendance.sessions_without_record }) : t('tpf.m.att_places', { n: p.attendance.recorded_slots })} tone={p.attendance.rate == null ? c.mute : p.attendance.rate < 75 ? c.red : p.attendance.rate < 85 ? c.sun : c.mint} />
      <Metric label={t('swk.m.load')} value={p.load.total_au ? String(p.load.total_au) : '—'} sub={p.load.total_au ? t('swk.m.load_unit') : t('swk.m.load_hint')} tone={p.load.total_au ? c.violet : c.mute} />
      <Metric label={t('swk.m.intensity')} value={p.load.avg_rpe != null ? String(p.load.avg_rpe) : '—'} sub={t('swk.m.rpe')} tone={p.load.avg_rpe == null ? c.mute : p.load.avg_rpe >= 7.5 ? c.red : p.load.avg_rpe >= 5 ? c.orange : c.cyan} />
      <Metric label={t('tpf.m.delivered')} value={pct(dl.completion_rate)} sub={dl.logged ? t('tpf.m.blocks_logged', { n: dl.logged }) : t('tpf.m.not_logged')} />
    </View>
  );

  const trends = (
    <View style={{ gap: 12 }}>
      <Section title={t('tpf.att_week')} color={c.mint}>{hasWeeks ? <BarRows rows={p.attendance.by_week.map((w) => ({ label: wk(w.week), value: w.rate, max: 100, note: t('tpf.places', { n: w.recorded }) }))} /> : <T size={13} color={c.mute}>{t('tpf.att_none')}</T>}</Section>
      <Section title={t('tpf.load_week')} color={c.violet}>{hasLoad ? <BarRows rows={p.load.by_week.map((w) => ({ label: wk(w.week), value: w.au, max: Math.max(...p.load.by_week.map((x) => x.au), 1), note: [t('tpf.sess_n', { n: w.sessions }), w.avg_rpe != null ? `RPE ${w.avg_rpe}` : null].filter(Boolean).join(' · ') }))} /> : <T size={13} color={c.mute}>{t('tpf.load_none')}</T>}</Section>
    </View>
  );

  const criteria = (
    <Section title={p.sheet ? t('tpf.criteria_on', { sheet: p.sheet.name }) : t('tpf.criteria')} color={c.cyan}>
      {!p.sheet ? <T size={13} color={c.mute}>{t('tpf.criteria_none')}</T> : (
        <View style={{ gap: 10, marginTop: 4 }}>
          {p.criteria.map((x) => {
            if (x.suppressed) return <T key={x.key} size={12} color={c.mute}>{x.name}: {t('tpf.suppressed', { n: p.min_cohort })}</T>;
            return (
            <View key={x.key} accessible accessibilityLabel={colon(x.name, x.avg ?? '-')} style={{ gap: 3 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <T weight="700" size={13}>{x.name}</T>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <T weight="800">{x.avg ?? '—'}<T size={12} color={c.mute}> / {x.scale_max}</T></T>
                  {x.change != null ? <T size={12} weight="800" color={(x.direction === 'lower_is_better' ? x.change < 0 : x.change > 0) ? c.lime : x.change === 0 ? c.mute : c.red}>{x.change > 0 ? `+${x.change}` : String(x.change)}</T> : null}
                  <T size={11} color={c.mute}>{t('tpf.n_athletes', { n: x.n })}</T>
                </View>
              </View>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 8, width: `${Math.round(Math.max(0, Math.min(1, ((x.avg ?? x.scale_min) - x.scale_min) / ((x.scale_max - x.scale_min) || 1))) * 100)}%`, backgroundColor: c.cyan }} /></View>
            </View>
            );
          })}
        </View>
      )}
    </Section>
  );

  const delivery = (
    <Section title={t('tpf.delivery')} color={c.orange}>
      {dl.logged ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: c.violetSoft }}>
            {[[dl.completed, c.mint], [dl.modified, c.sun], [dl.skipped, c.red]].map(([n, col], i) => <View key={i} style={{ flexGrow: n, flexBasis: 0, backgroundColor: col }} />)}
          </View>
          <T size={12} color={c.mute}>{t('tpf.delivery_line', { a: dl.completed, b: dl.modified, s: dl.skipped })}</T>
        </View>
      ) : <T size={13} color={c.mute}>{t('tpf.delivery_none')}</T>}
      <T size={12} color={c.mute} style={{ marginTop: 8 }}>{`${t('swk.m.scored')}: ${pct(p.athletes.scored_rate)} · ${t('tpf.m.goals', { n: p.goals.active + p.goals.achieved })}`}</T>
      <T size={12} color={c.mute} style={{ marginTop: 8 }}>{t('tpf.eval_line', { d: p.evaluations.draft, s: p.evaluations.shared, c: p.evaluations.closed })}</T>
    </Section>
  );

  const f = found.data;
  const findings = (
    <Section title={t('tpf.findings')} color={c.pink}>
      <T size={12} color={c.mute}>{t('tpf.findings_note')}</T>
      {found.error ? <ErrorBox error={found.error} onRetry={found.reload} /> : !f ? <Loading /> : (
        <View style={{ gap: 10, marginTop: 8 }}>
          <T weight="700">{f.headline}</T>
          {f.findings.map((x, i) => {
            const [ink, soft] = TONE[x.tone] ?? TONE.info;
            return (
              <View key={i} accessible style={{ gap: 4, padding: 12, borderRadius: 14, borderLeftWidth: 5, borderLeftColor: ink, backgroundColor: soft }}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" style={{ flexShrink: 1 }}>{x.title}</T><Tag label={t(`tpf.tone.${x.tone}`)} color={c.paper} /></View>
                <T size={13}>{x.detail}</T>
                <T size={12} color={c.mute}>{t('tpf.why')}: {x.why}</T>
                {x.recommendation ? <T size={13} weight="700">{t('tpf.next')}: {x.recommendation}</T> : null}
                {x.drills?.length ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{x.drills.map((d) => <Chip key={d.id} label={tool(d.title)} onPress={() => push('CoachDrills')} />)}</View> : null}
              </View>
            );
          })}
          {ai ? (
            <View style={{ gap: 6, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper }}>
              <Tag label={t('tpf.ai_label')} color={c.violetSoft} />
              <T weight="700">{ai.headline}</T>
              {ai.suggestions.map((s, i) => <View key={i}><T weight="700" size={13}>{s.title}</T><T size={13}>{s.detail}</T></View>)}
              <T size={11} color={c.mute}>{t('tpf.ai_note')}</T>
            </View>
          ) : <Btn small title={t('tpf.ai_btn')} color={c.paper} ink={c.ink} loading={aiBusy} onPress={askAi} accessibilityLabel={t('tpf.ai_btn')} />}
        </View>
      )}
    </Section>
  );

  const list = (
    <Section title={t('tpf.sessions')} color={c.lime}>
      {p.sessions_list.map((s) => (
        <Pressable key={s.id} onPress={() => push('SessionWorkspace', { source_type: s.source_type, source_id: s.source_id, team_id: s.team_id ?? undefined })} accessibilityRole="button" accessibilityLabel={[s.title, s.at ? when(s.at) : ''].join(', ')} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
          <View style={{ flex: 1 }}><T weight="700" numberOfLines={1}>{s.title}</T><T size={12} color={c.mute}>{[t(`swk.source.${s.source_type === 'team_session' ? 'team_session' : s.source_type}`), s.at ? when(s.at) : null].filter(Boolean).join(' · ')}</T></View>
          <Tag label={s.attendance_rate != null ? t('swk.squad.rate', { n: s.attendance_rate }) : t('swk.m.not_recorded')} color={s.attendance_rate == null ? c.violetSoft : c.limeSoft} />
        </Pressable>
      ))}
    </Section>
  );

  return (
    <Screen wide onRefresh={() => { perf.reload(); found.reload(); }}>
      {header}
      {!p.shareable ? <View accessible style={{ marginTop: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.sun, backgroundColor: c.paper }}><T size={13} weight="700" color={c.sun}>{t('tpf.not_shareable', { n: 5 })}</T></View> : null}
      {strip}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <Btn title={t('tpf.create_report')} onPress={() => setCreating(true)} accessibilityLabel={t('tpf.create_report')} />
        {kind === 'team' ? <Btn title={t('tpf.reports')} color={c.paper} ink={c.ink} onPress={() => push('CoachReports', { team_id: id, name: options.find((o) => o.value === chosen)?.label })} /> : null}
      </View>
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 16, alignItems: 'flex-start', marginTop: 8 }}>
        <View style={{ flex: 3, minWidth: 0, gap: 12, width: '100%' }}>{trends}{findings}{list}</View>
        <View style={{ flex: 2, minWidth: tablet ? 280 : 0, gap: 12, width: tablet ? undefined : '100%' }}>{criteria}{delivery}</View>
      </View>
      {creating ? (
        <FormSheet visible onClose={() => setCreating(false)} title={t('tpf.create_report')} submitLabel={t('cs.create')} initial={{ title: `${options.find((o) => o.value === chosen)?.label} · ${t('tpf.review_word')}`, audience: 'coach_private', metrics: true, findings: true, narrative: summaryText }}
          notice={p.shareable ? t('tpf.org_note') : t('tpf.org_blocked', { n: 5 })}
          fields={[
            { key: 'title', label: t('cs.title_label') },
            { key: 'audience', label: t('cs.who_reads'), type: 'chips', options: [['coach_private', t('cs.aud_me')], ...(kind === 'team' ? [['team_staff', t('cs.vis_staff')]] : []), ...(p.shareable ? [['organisation', t('rsh.aud_org')]] : [])].map(([value, label]) => ({ value, label })), default: 'coach_private' },
            { key: 'metrics', label: t('tpf.inc_charts'), type: 'switch', default: true },
            { key: 'findings', label: t('tpf.inc_findings'), type: 'switch', default: true },
            { key: 'narrative', label: t('cs.your_summary'), type: 'multiline', optional: true },
          ]}
          onSubmit={async (v) => {
            const r = await api.post('/coaching/reports', { ...(kind === 'team' ? { team_id: id } : { cohort_id: id }), kind: 'team_performance', title: v.title, audience: v.audience, from: range.from, to: range.to, ...(rubric ? { rubric_id: rubric } : p.sheet ? { rubric_id: p.sheet.id } : {}), selection: { goals: false, actions: false, metrics: !!v.metrics, findings: !!v.findings }, narrative: v.narrative || undefined, narrative_ai: !!ai && !!v.narrative && v.narrative === summaryText });
            setCreating(false); toast(t('cs.report_created')); push('CoachReport', { id: r.id });
          }} />
      ) : null}
    </Screen>
  );
}
