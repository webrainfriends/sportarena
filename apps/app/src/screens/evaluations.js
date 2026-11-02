// Evaluations: the coach scores an athlete (or a class member) on an evaluation sheet, writes structured feedback and shares it; the athlete, or a
// young person's guardian, rates themselves, answers criterion by criterion, asks questions and acknowledges; both talk it through and the coach closes it.
//   Evaluations      the coach's desk: what is a draft, what waits on the athlete, what waits on me
//   Evaluation       the coach's working sheet: live pillar and overall scores, a radar of the profile against the athlete's own view and the last time,
//                    every criterion with its behaviour anchors, target, change, evidence and comment, written feedback, the thread, share / close / PDF
//   MyEvaluations    what was shared with me (or my child), and what is waiting on me
//   MyEvaluation     the shared version, my self-assessment, my answers, the thread, my trend, PDF
// The server owns the numbers and the rules (who may see what, consent for young people, frozen versions); this screen shows them.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Counter } from '../pickers';
import { RadarChart, TrendChart } from '../eval-charts';
import { saveExport, shareExport } from '../open-file';
import { pillarName, orderOf, isNumeric } from '../eval-pillars';
import { t } from '../i18n';
import { c, when } from '../theme';
import { explain } from '../access';

const STATUS_TONE = { draft: c.mute, shared: c.cyan, responded: c.sun, closed: c.lime };
const REACTIONS = [['agree', c.lime], ['discuss', c.sun], ['disagree', c.red]];
const SELF_COLOR = '#EA580C';

const sign = (n) => (n == null ? '' : n > 0 ? `+${n}` : String(n));
const r1 = (x) => Math.round(x * 10) / 10;
function normalise(d, v) { if (v == null) return null; const span = d.scale_max - d.scale_min; if (!(span > 0) || d.direction === 'target_range') return null; const p = ((v - d.scale_min) / span) * 100; return d.direction === 'lower_is_better' ? 100 - p : p; }
/** Same weighted figures the server computes, so the numbers move as the coach scores; saving returns the server's own. */
function liveSummary(criteria, scoreOf) {
  const pillars = {}; let sum = 0, w = 0, scored = 0;
  for (const d of criteria) {
    const s = scoreOf(d); if (s != null) scored++;
    const n = normalise(d, s); if (n == null || !(d.weight > 0)) continue;
    sum += n * d.weight; w += d.weight; const p = (pillars[d.pillar] ??= { sum: 0, w: 0 }); p.sum += n * d.weight; p.w += d.weight;
  }
  return { overall: w ? r1(sum / w) : null, pillars: Object.fromEntries(Object.entries(pillars).map(([k, p]) => [k, r1(p.sum / p.w)])), scored };
}
const radarAxes = (pillars, labels) => pillars.map((p) => ({ key: p, label: pillarName(p, labels) }));

// ------------------------------------------------------------------ shared pieces

function NumberScore({ d, value, onPick, readOnly }) {
  const step = d.step ?? 1;
  const start = d.target ?? d.scale_min;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      {value == null ? (
        readOnly ? <T color={c.mute}>–</T> : <Btn small title={t('es.enter_value')} color={c.paper} ink={c.ink} onPress={() => onPick(start)} accessibilityLabel={[d.name, t('es.enter_value')].join(': ')} />
      ) : (
        <>
          <Counter value={value} min={d.scale_min} max={d.scale_max} step={step} suffix={d.unit ? ` ${d.unit}` : undefined} onChange={readOnly ? () => {} : onPick} a11y={d.name} />
          {!readOnly ? <Btn small title={t('es.clear_value')} color={c.paper} ink={c.ink} onPress={() => onPick(null)} /> : null}
        </>
      )}
      <T size={12} color={c.mute}>{[`${d.scale_min}–${d.scale_max}${d.unit ? ` ${d.unit}` : ''}`, d.direction === 'lower_is_better' ? t('cs.dir_lower') : d.direction === 'target_range' ? t('cs.dir_target') : null].filter(Boolean).join(' · ')}</T>
    </View>
  );
}

function Scale({ d, value, onPick, previous, self, readOnly, showSelf = true }) {
  if (isNumeric(d)) return (
    <View style={{ gap: 8 }}>
      <NumberScore d={d} value={value} onPick={onPick} readOnly={readOnly} />
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        {previous != null ? <Legend color={c.cyan} text={t('es.legend_last', { n: previous })} /> : null}
        {showSelf && self != null ? <Legend color={SELF_COLOR} text={t('es.legend_self', { n: self })} /> : null}
        {d.target != null ? <Legend color={c.sun} text={t('es.target_n', { n: d.target })} square /> : null}
      </View>
    </View>
  );
  const levels = []; for (let v = d.scale_min; v <= d.scale_max && levels.length < 11; v++) levels.push(v);
  const label = value != null ? d.labels?.[String(value)] : null, anchor = value != null ? d.anchors?.[String(value)] : null;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {levels.map((v) => {
          const on = value === v;
          return (
            <Pressable key={v} disabled={readOnly} onPress={() => onPick(on ? null : v)} accessibilityRole="button" accessibilityState={{ selected: on }}
              accessibilityLabel={[d.name, v, d.labels?.[String(v)], d.target === v ? t('es.target') : null].filter((x) => x != null).join(', ')}
              style={{ minWidth: 48, minHeight: 48, paddingHorizontal: 6, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: on ? c.ink : d.target === v ? c.sun : c.line, backgroundColor: on ? c.ink : c.paper }}>
              <T weight="800" color={on ? c.inkOn : c.ink}>{v}</T>
              <View style={{ flexDirection: 'row', gap: 3, height: 7 }}>
                {previous === v ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.cyan }} /> : null}
                {showSelf && self === v ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: SELF_COLOR }} /> : null}
                {d.target === v ? <View style={{ width: 6, height: 6, borderRadius: 1, backgroundColor: c.sun }} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {label || anchor ? <View style={{ padding: 10, borderRadius: 10, backgroundColor: c.violetSoft, gap: 2 }}>{label ? <T weight="800" size={13}>{label}</T> : null}{anchor ? <T size={13}>{anchor}</T> : null}</View> : null}
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        {previous != null ? <Legend color={c.cyan} text={t('es.legend_last', { n: previous })} /> : null}
        {showSelf && self != null ? <Legend color={SELF_COLOR} text={t('es.legend_self', { n: self })} /> : null}
        {d.target != null ? <Legend color={c.sun} text={t('es.target_n', { n: d.target })} square /> : null}
      </View>
    </View>
  );
}
const Legend = ({ color, text, square }) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 8, height: 8, borderRadius: square ? 2 : 4, backgroundColor: color }} /><T size={12} color={c.mute}>{text}</T></View>;

function PillarBars({ summary, self, change, order, labels }) {
  return (
    <View style={{ gap: 8 }}>
      {order.filter((p) => summary[p] != null).map((p) => (
        <View key={p} accessible accessibilityLabel={`${pillarName(p, labels)}: ${summary[p]}${self?.[p] != null ? `, ${t('es.self')} ${self[p]}` : ''}`} style={{ gap: 3 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" size={13}>{pillarName(p, labels)}</T><T size={13} weight="800">{summary[p]}{change?.[p] != null ? `  ${sign(change[p])}` : ''}</T></View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 8, width: `${summary[p]}%`, backgroundColor: c.pink }} /></View>
          {self?.[p] != null ? <View style={{ height: 4, borderRadius: 2, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 4, width: `${self[p]}%`, backgroundColor: SELF_COLOR }} /></View> : null}
        </View>
      ))}
    </View>
  );
}

function Thread({ items, onPost, closed, criteria, me }) {
  const [body, setBody] = useState(''), [key, setKey] = useState('');
  return (
    <View style={{ gap: 8 }}>
      {items.length === 0 ? <T size={13} color={c.mute}>{t('es.thread_empty')}</T> : items.map((m) => (
        <View key={m.id ?? m.created_at} style={{ padding: 10, borderRadius: 12, backgroundColor: m.author_role === 'coach' ? c.violetSoft : c.mintSoft, gap: 2 }}>
          <T size={12} weight="800">{m.author} · {t(`es.role.${m.author_role}`)} · {when(m.created_at)}{m.criterion_key ? ` · ${criteria.find((x) => x.key === m.criterion_key)?.name ?? ''}` : ''}</T>
          <T>{m.body}</T>
        </View>
      ))}
      {!closed ? (
        <View style={{ gap: 8 }}>
          <MenuField value={key} onChange={setKey} placeholder={t('es.about_all')} title={t('es.about')} options={[{ value: '', label: t('es.about_all') }, ...criteria.map((x) => ({ value: x.key, label: x.name }))]} />
          <Field value={body} onChangeText={setBody} multiline minHeight={70} maxLength={2000} placeholder={t('es.write_message')} accessibilityLabel={t('es.write_message')} />
          <Btn small title={t('es.send')} disabled={!body.trim()} onPress={async () => { await onPost(body.trim(), key || undefined); setBody(''); setKey(''); }} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : <T size={12} color={c.mute}>{t('es.closed_note')}</T>}
    </View>
  );
}


const SECTION_KEYS = ['summary', 'scores', 'comments', 'evidence', 'feedback', 'response', 'conversation'];

/** Export or pass on an evaluation: choose the copy and what goes in, then download, share on WhatsApp or any app, or send it to the athlete in the app. */
function ExportSheet({ d, onClose }) {
  const { toast } = useSession();
  const [copy, setCopy] = useState(d.version ? 'shared' : 'working');
  const [sections, setSections] = useState(SECTION_KEYS);
  const [priv, setPriv] = useState(false), [note, setNote] = useState(''), [busy, setBusy] = useState(null);
  const query = { copy, sections: sections.join(','), ...(copy === 'working' && priv ? { include_private: true } : {}) };
  const toggle = (k) => setSections((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]));
  const get = () => api.get(`/coaching/evaluations/${d.id}/export`, query);
  const run = async (what, fn) => { setBusy(what); try { await fn(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const text = t('es.wa_text', { title: d.title, name: d.athlete?.display_name ?? '' });
  return (
    <Sheet visible onClose={onClose} title={t('es.export_title')}>
      <View style={{ gap: 12 }}>
        <View style={{ padding: 12, borderRadius: 12, backgroundColor: c.sunSoft }}><T size={13} weight="700">{t('es.export_warning')}</T></View>
        <View style={{ gap: 6 }}>
          <T weight="700" size={12} color={c.mute} style={{ letterSpacing: 0.6 }}>{t('es.copy_which').toUpperCase()}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Chip label={t('es.copy_shared')} active={copy === 'shared'} onPress={() => d.version && setCopy('shared')} />
            <Chip label={t('es.copy_working')} active={copy === 'working'} onPress={() => setCopy('working')} />
          </View>
          <T size={12} color={c.mute}>{copy === 'shared' ? (d.version ? t('es.copy_shared_hint') : t('es.share_first')) : t('es.copy_working_hint')}</T>
        </View>
        <View style={{ gap: 6 }}>
          <T weight="700" size={12} color={c.mute} style={{ letterSpacing: 0.6 }}>{t('es.sections').toUpperCase()}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{SECTION_KEYS.map((k) => <Chip key={k} label={t(`es.sec.${k}`)} active={sections.includes(k)} onPress={() => toggle(k)} />)}</View>
          {copy === 'working' ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T style={{ flex: 1 }} size={13}>{t('es.include_private')}</T><Chip label={priv ? t('common.yes') : t('common.no')} active={priv} onPress={() => setPriv(!priv)} /></View> : null}
        </View>
        <View style={{ gap: 8 }}>
          <Btn title={t('es.download')} color={c.paper} ink={c.ink} loading={busy === 'dl'} disabled={!sections.length || (copy === 'shared' && !d.version)} onPress={() => run('dl', async () => { await saveExport(await get()); toast(t('es.pdf_ready')); })} />
          <Btn title={t('es.share_apps')} loading={busy === 'share'} disabled={!sections.length || (copy === 'shared' && !d.version)} accessibilityLabel={t('es.share_apps')}
            onPress={() => run('share', async () => { const r = await shareExport(await get(), text); toast(r === 'downloaded' ? t('es.wa_fallback') : t('es.pdf_ready')); })} />
          <View style={{ gap: 8, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.line }}>
            <T weight="800">{t('es.send_athlete', { name: d.athlete?.display_name ?? '' })}</T>
            <T size={12} color={c.mute}>{d.version ? t('es.send_hint') : t('es.share_first')}</T>
            <Field value={note} onChangeText={setNote} multiline minHeight={64} maxLength={500} placeholder={t('es.send_note')} accessibilityLabel={t('es.send_note')} />
            <Btn title={t('es.send_in_app')} loading={busy === 'send'} disabled={!d.version || !sections.length}
              onPress={() => run('send', async () => { await api.post(`/coaching/evaluations/${d.id}/send`, { sections, ...(note.trim() ? { note: note.trim() } : {}) }); toast(t('es.sent_done', { name: d.athlete?.display_name ?? '' })); onClose(); })} />
          </View>
        </View>
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ coach desk

const FILTERS = ['all', 'draft', 'shared', 'responded', 'closed'];
export function Evaluations({ athlete_id }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [status, setStatus] = useState('all'), [make, setMake] = useState(false);
  const list = useLoad(() => api.get('/coaching/evaluations', { ...(status === 'all' ? {} : { status }), ...(athlete_id ? { athlete_id } : {}), limit: 100 }), [status, athlete_id]);
  const athletes = useLoad(() => api.get('/coach/athletes'), []);
  const sheets = useLoad(() => api.get('/coaching/rubrics', { limit: 100 }), []);
  const people = (Array.isArray(athletes.data) ? athletes.data : athletes.data?.items ?? []);
  const waiting = (list.data ?? []).filter((e) => e.waiting_on === 'coach').length;
  return (
    <Screen onRefresh={list.reload}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('es.eyebrow').toUpperCase()}</T>
      <H1>{t('nav.title.Evaluations')}</H1>
      <T color={c.mute} size={14}>{t('es.desk_sub')}</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <Btn title={t('es.new_evaluation')} onPress={() => setMake(true)} disabled={!people.length || !sheets.data?.length} />
        <Btn title={t('es.sheets_title')} color={c.paper} ink={c.ink} onPress={() => push('CoachRubrics')} />
      </View>
      {waiting ? <T weight="700" color={c.sun} style={{ marginTop: 8 }}>{t('es.waiting_on_you', { n: waiting })}</T> : null}
      <View style={{ marginVertical: 12 }}><Seg value={status} onChange={setStatus} options={FILTERS.map((f) => ({ value: f, label: f === 'all' ? t('common.all') : t(`es.status.${f}`) }))} /></View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty emoji="📋" title={t('es.empty')} sub={t('es.empty_sub')} /> : (
        <View style={{ gap: 8 }}>
          {list.data.map((e) => (
            <Row key={e.id} title={e.title} sub={[e.athlete_name, e.overall != null ? t('es.overall_n', { n: e.overall }) : null, when(e.updated_at)].filter(Boolean).join(' · ')} onPress={() => push('Evaluation', { id: e.id })}
              right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Tag label={t(`es.status.${e.status}`)} />{e.waiting_on === 'coach' ? <T size={12} weight="800" color={c.sun}>{t('es.on_you')}</T> : e.waiting_on === 'athlete' ? <T size={12} color={c.mute}>{t('es.on_athlete')}</T> : null}</View>} />
          ))}
        </View>
      )}
      {make ? (
        <FormSheet visible onClose={() => setMake(false)} title={t('es.new_evaluation')} submitLabel={t('es.create')} initial={{ context_type: 'period', athlete_id: athlete_id ?? '' }}
          fields={[
            { key: 'athlete_id', label: t('es.athlete'), type: 'custom', render: ({ v, set }) => <MenuField label={t('es.athlete')} value={v.athlete_id ?? ''} onChange={(x) => set('athlete_id', x)} placeholder={t('common.choose')} options={people.map((p) => ({ value: p.id ?? p.athlete_id, label: p.display_name ?? p.name, sub: p.handle }))} /> },
            { key: 'rubric_id', label: t('es.sheet'), type: 'custom', render: ({ v, set }) => <MenuField label={t('es.sheet')} value={v.rubric_id ?? ''} onChange={(x) => set('rubric_id', x)} placeholder={t('common.choose')} options={(sheets.data ?? []).map((r) => ({ value: r.id, label: r.name, sub: t('es.criteria_n', { n: r.dimensions.length }) }))} /> },
            { key: 'context_type', label: t('es.context'), type: 'chips', options: ['period', 'session', 'match', 'trial', 'custom'].map((x) => ({ value: x, label: t(`es.context.${x}`) })) },
            { key: 'title', label: t('es.title_optional'), optional: true },
            { key: 'period_from', toKey: 'period_to', label: t('es.period'), type: 'daterange', optional: true },
            { key: 'request_self_assessment', label: t('es.ask_self'), type: 'switch', hint: t('es.ask_self_hint') },
          ]}
          onSubmit={async (v) => {
            if (!v.athlete_id || !v.rubric_id) throw new Error(t('es.pick_both'));
            const r = await api.post('/coaching/evaluations', { athlete_id: v.athlete_id, rubric_id: v.rubric_id, context_type: v.context_type, ...(v.title ? { title: v.title } : {}), ...(v.period_from ? { period_from: v.period_from, period_to: v.period_to ?? v.period_from } : {}), request_self_assessment: !!v.request_self_assessment });
            setMake(false); push('Evaluation', { id: r.id }); return null;
          }} />
      ) : null}
    </Screen>
  );
}

// ------------------------------------------------------------------ coach working sheet

export function Evaluation({ id }) {
  const { toast } = useSession();
  const { tablet } = useLayout();
  const q = useLoad(() => api.get(`/coaching/evaluations/${id}`), [id]);
  const [scores, setScores] = useState({}), [narr, setNarr] = useState({}), [title, setTitle] = useState(null);
  const [busy, setBusy] = useState(false), [share, setShare] = useState(false), [open, setOpen] = useState(null), [ev, setEvidence] = useState(null), [exportOpen, setExportOpen] = useState(false);
  const d = q.data;
  useEffect(() => { setScores({}); setNarr({}); setTitle(null); }, [d?.row_version]);
  const merged = (k) => ({ ...(d?.criteria.find((x) => x.key === k) ?? {}), ...(scores[k] ?? {}) });
  const dirty = Object.keys(scores).length > 0 || Object.keys(narr).length > 0 || title != null;
  const live = useMemo(() => (d ? liveSummary(d.criteria, (x) => (scores[x.key]?.score !== undefined ? scores[x.key].score : x.score)) : null), [d, scores]);
  const pillars = useMemo(() => orderOf(d?.criteria ?? []), [d]);
  if (q.error) return <Screen><ErrorBox error={q.error} onRetry={q.reload} /></Screen>;
  if (!d) return <Screen><Loading /></Screen>;
  const closed = !!d.closed_at;
  const setScore = (k, p) => setScores((x) => ({ ...x, [k]: { ...(x[k] ?? {}), ...p } }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { row_version: d.row_version };
      if (Object.keys(scores).length) body.scores = Object.fromEntries(Object.entries(scores).map(([k, e]) => [k, { ...(e.score !== undefined ? { score: e.score } : {}), ...(e.comment !== undefined ? { comment: e.comment || null } : {}), ...(e.evidence !== undefined ? { evidence: e.evidence } : {}) }]));
      if (Object.keys(narr).length) body.narrative = narr;
      if (title != null) body.title = title;
      await api.patch(`/coaching/evaluations/${id}`, body); toast(t('es.saved')); await q.reload();
    } catch (e) { toast(explain(e)); await q.reload(); } finally { setBusy(false); }
  };
  const run = async (fn, done) => { setBusy(true); try { await fn(); toast(done); await q.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const selfOverall = d.summary.self_overall;
  const chart = (
    <View style={{ gap: 10 }}>
      <RadarChart size={tablet ? 300 : 280} axes={radarAxes(pillars, d.pillar_labels)} a11y={radarAxes(pillars, d.pillar_labels).map((a) => `${a.label}: ${live.pillars[a.key] ?? '-'}`).join(', ')}
        series={[{ label: t('es.coach'), values: live.pillars, color: c.pink }, ...(d.summary.self_pillars ? [{ label: t('es.self'), values: Object.fromEntries(Object.entries(d.summary.self_pillars).map(([k, p]) => [k, p.score])), color: SELF_COLOR, dashed: true }] : [])]} />
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}><Legend color={c.pink} text={t('es.coach')} />{d.summary.self_pillars ? <Legend color={SELF_COLOR} text={t('es.self')} /> : null}</View>
    </View>
  );
  const summary = (
    <View style={{ gap: 12 }}>
      <Section title={t('es.summary')} color={c.pink}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <T size={44} weight="800">{live.overall ?? '–'}</T><T color={c.mute} style={{ marginBottom: 8 }}>/ 100</T>
          {d.summary.change != null && !dirty ? <T weight="800" color={d.summary.change >= 0 ? c.lime : c.red} style={{ marginBottom: 8 }}>{t('es.since_last', { n: sign(d.summary.change) })}</T> : null}
        </View>
        {selfOverall != null ? <T size={13} color={c.mute}>{t('es.self_overall', { n: selfOverall })}</T> : null}
        <T size={12} color={c.mute}>{t('es.scored_of', { a: live.scored, n: d.criteria.length })} · {t('es.computed_note')}</T>
        {chart}
        <PillarBars order={pillars} labels={d.pillar_labels} summary={live.pillars} self={Object.fromEntries(Object.entries(d.summary.self_pillars ?? {}).map(([k, p]) => [k, p.score]))} change={dirty ? null : d.summary.pillar_change} />
      </Section>
      <Section title={t('es.workflow')} color={c.cyan}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['draft', 'shared', 'responded', 'closed'].map((s) => <Tag key={s} label={t(`es.status.${s}`)} color={s === d.status ? c.mint : c.violetSoft} />)}</View>
        <T size={13} color={c.mute}>{[d.version ? t('es.version_n', { n: d.version }) : t('es.not_shared'), d.shared_at ? when(d.shared_at) : null, d.self_submitted_at ? t('es.self_in') : d.self_requested ? t('es.self_waiting') : null, d.acknowledged_at ? t('es.acknowledged') : null].filter(Boolean).join(' · ')}</T>
        {d.unshared_changes ? <T size={13} weight="700" color={c.sun}>{t('es.unshared_changes')}</T> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {!closed ? <Btn small title={d.version ? t('es.share_again') : t('es.share')} disabled={dirty || busy} onPress={() => setShare(true)} /> : null}
          {!closed && d.version ? <Btn small title={t('es.close')} color={c.paper} ink={c.ink} disabled={busy} onPress={() => run(() => api.post(`/coaching/evaluations/${id}/close`), t('es.closed_done'))} /> : null}
          {!closed && !d.self_requested && !d.version ? <Btn small title={t('es.ask_self')} color={c.paper} ink={c.ink} onPress={() => run(() => api.patch(`/coaching/evaluations/${id}`, { row_version: d.row_version, request_self_assessment: true }), t('es.self_asked'))} /> : null}
          <Btn small title={t('es.share_export')} color={c.paper} ink={c.ink} onPress={() => setExportOpen(true)} />
        </View>
        {dirty ? <T size={12} color={c.mute}>{t('st.save_first')}</T> : null}
      </Section>
    </View>
  );
  const body = (
    <View style={{ gap: 12 }}>
      {pillars.map((p) => (
        <View key={p} style={{ gap: 10 }}>
          <T weight="800" size={18}>{pillarName(p, d.pillar_labels)}{live.pillars[p] != null ? `  ·  ${live.pillars[p]}` : ''}</T>
          {d.criteria.filter((x) => x.pillar === p).map((x) => {
            const m = merged(x.key), score = scores[x.key]?.score !== undefined ? scores[x.key].score : x.score, comment = scores[x.key]?.comment ?? x.comment ?? '', evid = scores[x.key]?.evidence ?? x.evidence ?? [];
            const gap = x.self != null && score != null ? r1(x.self - score) : null;
            return (
              <View key={x.key} style={{ gap: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: open === x.key ? c.ink : c.line, backgroundColor: c.paper }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <View style={{ flex: 1, minWidth: 160 }}><T weight="800" size={16}>{x.name}</T>{x.description ? <T size={13} color={c.mute}>{x.description}</T> : null}</View>
                  {x.change != null && scores[x.key]?.score === undefined ? <T weight="800" color={x.change >= 0 ? c.lime : c.red}>{t('es.vs_last', { n: sign(x.change) })}</T> : null}
                  {gap ? <Tag label={t('es.gap_n', { n: sign(gap) })} color={Math.abs(gap) >= 2 ? c.sun : c.violetSoft} /> : null}
                  {x.reaction ? <Tag label={t(`es.reaction.${x.reaction}`)} color={x.reaction === 'agree' ? c.mint : x.reaction === 'disagree' ? c.orange : c.sun} /> : null}
                </View>
                <Scale d={x} value={score ?? null} previous={x.previous} self={x.self} readOnly={closed} onPick={(v) => setScore(x.key, { score: v })} />
                {x.self_comment ? <View style={{ padding: 10, borderRadius: 10, backgroundColor: c.mintSoft }}><T size={12} weight="800" color={SELF_COLOR}>{t('es.self')}</T><T size={13}>{x.self_comment}</T></View> : null}
                <Field label={t('es.comment')} value={comment} onChangeText={(v) => setScore(x.key, { comment: v })} multiline minHeight={64} maxLength={2000} hint={x.evidence_hint ? t('es.look_for', { text: x.evidence_hint }) : undefined} />
                {evid.map((e, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                    <Tag label={t(`es.evidence.${e.type}`)} /><T size={13} style={{ flex: 1 }}>{[e.at, e.text, e.url].filter(Boolean).join(' · ')}</T>
                    {!closed ? <Btn small title="✕" color={c.paper} ink={c.ink} onPress={() => setScore(x.key, { evidence: evid.filter((_, j) => j !== i) })} accessibilityLabel={t('cp.remove')} /> : null}
                  </View>
                ))}
                {!closed ? <Btn small title={t('es.add_evidence')} color={c.paper} ink={c.ink} onPress={() => setEvidence({ key: x.key, evid })} style={{ alignSelf: 'flex-start' }} /> : null}
              </View>
            );
          })}
        </View>
      ))}
      <Section title={t('es.feedback')} color={c.violet}>
        <View style={{ gap: 12 }}>
          {[['strengths', 'es.strengths'], ['development', 'es.development'], ['cues', 'es.cues'], ['next_steps', 'es.next_steps']].map(([k, label]) => (
            <Field key={k} label={t(label)} value={narr[k] ?? d.narrative[k] ?? ''} onChangeText={(v) => setNarr((x) => ({ ...x, [k]: v }))} multiline minHeight={88} maxLength={3000} />
          ))}
          <Field label={t('es.private')} value={narr.private ?? d.narrative.private ?? ''} onChangeText={(v) => setNarr((x) => ({ ...x, private: v }))} multiline minHeight={70} maxLength={4000} hint={t('es.private_hint')} />
        </View>
      </Section>
      {d.response?.comment || d.response?.questions ? (
        <Section title={t('es.athlete_response')} color={c.mint}>
          {d.response.comment ? <T>{d.response.comment}</T> : null}{d.response.questions ? <T weight="700">{t('es.questions')}: {d.response.questions}</T> : null}
        </Section>
      ) : null}
      <Section title={t('es.conversation')} color={c.cyan}>
        <Thread items={d.thread} criteria={d.criteria} closed={closed || !d.version} onPost={async (b, k) => { try { await api.post(`/coaching/evaluations/${id}/messages`, { body: b, criterion_key: k }); await q.reload(); } catch (e) { toast(explain(e)); } }} />
        {!d.version ? <T size={12} color={c.mute}>{t('es.thread_after_share')}</T> : null}
      </Section>
    </View>
  );
  return (
    <Screen wide>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{[t('es.eyebrow'), t(`es.context.${d.context_type}`)].join(' · ').toUpperCase()}</T>
      <H1 style={{ fontSize: tablet ? 28 : 24 }}>{title ?? d.title}</H1>
      <T color={c.mute}>{[d.athlete?.display_name, d.sheet?.name, d.period_from ? `${String(d.period_from).slice(0, 10)} – ${d.period_to ? String(d.period_to).slice(0, 10) : ''}` : null].filter(Boolean).join(' · ')}</T>
      {dirty ? (
        <View accessible style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, marginTop: 10, borderRadius: 14, borderWidth: 1, borderColor: c.sun, backgroundColor: c.paper }}>
          <T weight="700" color={c.sun} style={{ flex: 1, minWidth: 140 }}>{t('st.unsaved')}</T>
          <Btn small title={t('st.discard')} color={c.paper} ink={c.ink} onPress={() => { setScores({}); setNarr({}); setTitle(null); }} /><Btn small title={t('cp.save_plan')} loading={busy} onPress={save} />
        </View>
      ) : null}
      <View style={{ marginTop: 12 }}>
        {tablet ? <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}><View style={{ flex: 3, minWidth: 0 }}>{body}</View><View style={{ flex: 2, minWidth: 300 }}>{summary}</View></View> : <View style={{ gap: 12 }}>{summary}{body}</View>}
      </View>
      {exportOpen ? <ExportSheet d={d} onClose={() => setExportOpen(false)} /> : null}
      {share ? (
        <FormSheet visible onClose={() => setShare(false)} title={d.version ? t('es.share_again') : t('es.share')} submitLabel={t('es.share')} initial={{}} notice={t('es.share_notice')}
          fields={[{ key: 'note', label: t('es.share_note'), type: 'multiline', optional: true }]}
          onSubmit={async (v) => { await api.post(`/coaching/evaluations/${id}/share`, { ...(v.note ? { note: v.note } : {}) }); setShare(false); await q.reload(); return t('es.shared_done'); }} />
      ) : null}
      {ev ? (
        <FormSheet visible onClose={() => setEvidence(null)} title={t('es.add_evidence')} submitLabel={t('common.save')} initial={{ type: 'note' }}
          fields={[{ key: 'type', label: t('es.evidence_type'), type: 'chips', options: ['note', 'clip', 'link'].map((x) => ({ value: x, label: t(`es.evidence.${x}`) })) }, { key: 'text', label: t('es.evidence_text'), type: 'multiline', optional: true },
            { key: 'url', label: t('es.evidence_url'), optional: true, show: (v) => v.type !== 'note', hint: 'https://' }, { key: 'at', label: t('es.evidence_at'), optional: true, show: (v) => v.type === 'clip', hint: '12:40' }]}
          onSubmit={async (v) => { setScore(ev.key, { evidence: [...ev.evid, { type: v.type, ...(v.text ? { text: v.text } : {}), ...(v.url ? { url: v.url } : {}), ...(v.at ? { at: v.at } : {}) }] }); setEvidence(null); return null; }} />
      ) : null}
    </Screen>
  );
}

// ------------------------------------------------------------------ athlete (or guardian)

export function MyEvaluations({ athlete_id }) {
  const { push } = useNav();
  const list = useLoad(() => api.get('/me/coaching-evaluations', { ...(athlete_id ? { athlete_id } : {}), limit: 100 }), [athlete_id]);
  const WAIT = { self_assessment: 'es.wait_self', response: 'es.wait_response', acknowledge: 'es.wait_ack' };
  return (
    <Screen onRefresh={list.reload}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('es.eyebrow').toUpperCase()}</T>
      <H1>{t('nav.title.MyEvaluations')}</H1>
      <T color={c.mute} size={14}>{t('es.mine_sub')}</T>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty emoji="📋" title={t('es.mine_empty')} sub={t('es.mine_empty_sub')} /> : (
        <View style={{ marginTop: 12, gap: 8 }}>
          {list.data.map((e) => (
            <Row key={e.id} title={e.title} sub={[e.coach_name, e.overall != null ? t('es.overall_n', { n: e.overall }) : null, e.shared_at ? when(e.shared_at) : null].filter(Boolean).join(' · ')} onPress={() => push('MyEvaluation', { id: e.id })}
              right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Tag label={t(`es.status.${e.status}`)} />{e.waiting_on_you ? <T size={12} weight="800" color={c.sun}>{t(WAIT[e.waiting_on_you])}</T> : null}</View>} />
          ))}
        </View>
      )}
    </Screen>
  );
}

export function MyEvaluation({ id }) {
  const { toast } = useSession();
  const { tablet } = useLayout();
  const q = useLoad(() => api.get(`/me/coaching-evaluations/${id}`), [id]);
  const trend = useLoad(() => (q.data ? api.get('/coaching/evaluation-trend', { rubric_id: q.data.rubric.id, ...(q.data.viewer === 'guardian' ? { athlete_id: q.data.athlete_id } : {}) }) : Promise.resolve(null)), [q.data?.rubric?.id, q.data?.viewer]);
  const [self, setSelf] = useState({}), [react, setReact] = useState({}), [comment, setComment] = useState(null), [questions, setQuestions] = useState(null), [busy, setBusy] = useState(false);
  const d = q.data;
  useEffect(() => { setSelf({}); setReact({}); }, [d?.row_version, d?.stage]);
  if (q.error) return <Screen><ErrorBox error={q.error} onRetry={q.reload} /></Screen>;
  if (!d) return <Screen><Loading /></Screen>;
  const shared = d.stage === 'shared', closed = !!d.closed_at;
  const pillars = orderOf(d.criteria);
  const selfScore = (x) => (self[x.key]?.score !== undefined ? self[x.key].score : x.self);
  const selfLive = liveSummary(d.criteria, selfScore);
  const run = async (fn, done) => { setBusy(true); try { await fn(); if (done) toast(done); await q.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const pts = (trend.data?.points ?? []);
  return (
    <Screen wide>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('es.eyebrow').toUpperCase()}</T>
      <H1 style={{ fontSize: tablet ? 28 : 24 }}>{d.title}</H1>
      <T color={c.mute}>{[d.coach_name, d.sheet?.name, d.shared_at ? when(d.shared_at) : null, d.version ? t('es.version_n', { n: d.version }) : null].filter(Boolean).join(' · ')}</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginVertical: 8 }}><Tag label={t(`es.status.${d.status}`)} />{d.acknowledged_at ? <Tag label={t('es.acknowledged')} color={c.mint} /> : null}{d.viewer === 'guardian' ? <Tag label={t('es.as_guardian')} /> : null}</View>
      {!shared ? <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.sunSoft }}><T weight="700">{t('es.self_intro')}</T></View> : null}
      {shared && d.shared_note ? <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.violetSoft, marginBottom: 8 }}><T weight="700">{t('es.note_from_coach')}</T><T>{d.shared_note}</T></View> : null}
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
        <View style={{ flex: tablet ? 3 : undefined, gap: 12, minWidth: 0, alignSelf: 'stretch' }}>
          {pillars.map((p) => (
            <View key={p} style={{ gap: 10 }}>
              <T weight="800" size={18}>{pillarName(p, d.pillar_labels)}{shared && d.summary.pillars[p] ? `  ·  ${d.summary.pillars[p].score}` : ''}</T>
              {d.criteria.filter((x) => x.pillar === p).map((x) => (
                <View key={x.key} style={{ gap: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <View style={{ flex: 1, minWidth: 160 }}><T weight="800" size={16}>{x.name}</T>{x.description ? <T size={13} color={c.mute}>{x.description}</T> : null}</View>
                    {shared && x.change != null ? <T weight="800" color={x.change >= 0 ? c.lime : c.red}>{t('es.vs_last', { n: sign(x.change) })}</T> : null}
                  </View>
                  {shared ? <Scale d={x} value={x.score} previous={x.previous} self={selfScore(x)} readOnly onPick={() => {}} /> : null}
                  {shared && x.comment ? <T>{x.comment}</T> : null}
                  {shared && x.evidence?.length ? x.evidence.map((e, i) => <T key={i} size={13} color={c.mute}>{t(`es.evidence.${e.type}`)}: {[e.at, e.text, e.url].filter(Boolean).join(' · ')}</T>) : null}
                  {!closed ? (
                    <View style={{ gap: 8, padding: 10, borderRadius: 12, backgroundColor: c.mintSoft }}>
                      <T weight="800" size={13} color={SELF_COLOR}>{t('es.my_view')}</T>
                      <Scale d={{ ...x, target: null }} value={selfScore(x) ?? null} showSelf={false} onPick={(v) => setSelf((s) => ({ ...s, [x.key]: { ...(s[x.key] ?? {}), score: v } }))} />
                      <Field value={self[x.key]?.comment ?? x.self_comment ?? ''} onChangeText={(v) => setSelf((s) => ({ ...s, [x.key]: { ...(s[x.key] ?? {}), comment: v } }))} multiline minHeight={56} maxLength={1000} placeholder={t('es.my_comment')} accessibilityLabel={[t('es.my_comment'), x.name].join(': ')} />
                    </View>
                  ) : x.self != null ? <T size={13}>{t('es.legend_self', { n: x.self })}{x.self_comment ? ` · ${x.self_comment}` : ''}</T> : null}
                  {shared && !closed ? (
                    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                      {REACTIONS.map(([r]) => <Chip key={r} label={t(`es.reaction.${r}`)} active={(react[x.key] ?? x.reaction) === r} onPress={() => setReact((s) => ({ ...s, [x.key]: r }))} />)}
                    </View>
                  ) : shared && x.reaction ? <Tag label={t(`es.reaction.${x.reaction}`)} /> : null}
                </View>
              ))}
            </View>
          ))}
          {shared ? (
            <Section title={t('es.feedback')} color={c.violet}>
              {[['strengths', 'es.strengths'], ['development', 'es.development'], ['cues', 'es.cues'], ['next_steps', 'es.next_steps']].filter(([k]) => d.narrative[k]).map(([k, label]) => <View key={k} style={{ gap: 2 }}><T weight="800">{t(label)}</T><T>{d.narrative[k]}</T></View>)}
            </Section>
          ) : null}
          {!closed ? (
            <Section title={t('es.my_answer')} color={c.mint}>
              <View style={{ gap: 10 }}>
                {Object.keys(self).length ? <Btn small title={t('es.save_self')} loading={busy} onPress={() => run(() => api.post(`/me/coaching-evaluations/${id}/self`, { scores: Object.fromEntries(Object.entries(self).map(([k, e]) => [k, { ...(e.score !== undefined ? { score: e.score } : {}), ...(e.comment !== undefined ? { comment: e.comment || null } : {}) }])) }), t('es.self_saved'))} style={{ alignSelf: 'flex-start' }} /> : null}
                {shared ? (
                  <>
                    <Field label={t('es.my_overall_comment')} value={comment ?? d.response?.comment ?? ''} onChangeText={setComment} multiline minHeight={80} maxLength={2000} />
                    <Field label={t('es.my_questions')} value={questions ?? d.response?.questions ?? ''} onChangeText={setQuestions} multiline minHeight={70} maxLength={2000} />
                    <Btn title={t('es.send_response')} loading={busy} onPress={() => run(() => api.post(`/me/coaching-evaluations/${id}/respond`, { reactions: react, ...(comment != null ? { comment } : {}), ...(questions != null ? { questions } : {}) }), t('es.response_sent'))} />
                    {!d.acknowledged_at ? <Btn small title={t('es.acknowledge')} color={c.paper} ink={c.ink} loading={busy} onPress={() => run(() => api.post(`/me/coaching-evaluations/${id}/acknowledge`), t('es.acknowledged'))} style={{ alignSelf: 'flex-start' }} /> : null}
                  </>
                ) : null}
              </View>
            </Section>
          ) : null}
          {shared ? <Section title={t('es.conversation')} color={c.cyan}><Thread items={d.thread} criteria={d.criteria} closed={closed} onPost={async (b, k) => { try { await api.post(`/coaching/evaluations/${id}/messages`, { body: b, criterion_key: k }); await q.reload(); } catch (e) { toast(explain(e)); } }} /></Section> : null}
        </View>
        {shared ? (
          <View style={{ flex: tablet ? 2 : undefined, gap: 12, minWidth: tablet ? 300 : undefined, alignSelf: 'stretch' }}>
            <Section title={t('es.summary')} color={c.pink}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}><T size={44} weight="800">{d.summary.overall ?? '–'}</T><T color={c.mute} style={{ marginBottom: 8 }}>/ 100</T>{d.summary.change != null ? <T weight="800" color={d.summary.change >= 0 ? c.lime : c.red} style={{ marginBottom: 8 }}>{t('es.since_last', { n: sign(d.summary.change) })}</T> : null}</View>
              <T size={12} color={c.mute}>{t('es.computed_note')}</T>
              <RadarChart size={tablet ? 300 : 280} axes={radarAxes(pillars, d.pillar_labels)} a11y={radarAxes(pillars, d.pillar_labels).map((a) => `${a.label}: ${d.summary.pillars[a.key]?.score ?? '-'}`).join(', ')}
                series={[{ label: t('es.coach'), values: Object.fromEntries(Object.entries(d.summary.pillars).map(([k, p]) => [k, p.score])), color: c.pink }, ...(selfLive.scored ? [{ label: t('es.self'), values: selfLive.pillars, color: SELF_COLOR, dashed: true }] : [])]} />
              <PillarBars order={pillars} labels={d.pillar_labels} summary={Object.fromEntries(Object.entries(d.summary.pillars).map(([k, p]) => [k, p.score]))} self={selfLive.scored ? selfLive.pillars : null} change={d.summary.pillar_change} />
            </Section>
            {pts.length > 1 ? (
              <Section title={t('es.trend')} color={c.cyan}>
                <TrendChart width={tablet ? 300 : 300} points={pts.map((p) => ({ at: p.at, values: { overall: p.overall } }))} lines={[{ key: 'overall', label: t('es.overall'), color: c.pink }]} a11y={pts.map((p) => `${when(p.at)}: ${p.overall}`).join(', ')} />
                <T size={12} color={c.mute}>{pts.map((p) => p.overall).join(' → ')}</T>
              </Section>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title={t('es.pdf')} color={c.paper} ink={c.ink} onPress={() => api.get(`/coaching/evaluations/${id}/export`).then(saveExport).then(() => toast(t('es.pdf_ready'))).catch((e) => toast(explain(e)))} />
              <Btn small title={t('es.share_apps')} color={c.paper} ink={c.ink} onPress={() => api.get(`/coaching/evaluations/${id}/export`).then((o) => shareExport(o, t('es.wa_text', { title: d.title, name: '' }))).catch((e) => toast(explain(e)))} />
            </View>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
