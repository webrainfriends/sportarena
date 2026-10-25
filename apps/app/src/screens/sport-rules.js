// Tools > Sport rules (#320): the governed definition of each sport's metrics (unit, direction, aggregation, valid range, points) and
// match formats, with every version kept. Everyone can read the rules their results are judged by; only platform admins and appointed
// governors see the edit controls (the server decides: can_govern). Publishing makes a new immutable version — stored results keep theirs.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { SportSelect } from '../sportpicker';
import { RulesetFields } from './scoring-review';
import { openLink } from './pathways';
import { Rulebook } from './rulebook';
import { c, day } from '../theme';

const nice = (s = '') => String(s).replace(/_/g, ' ');
const UNITS = ['s', 'min', 'm', 'cm', 'km', 'kg', 'count', 'points', '%'];
const AGG = { best: 'Best', sum: 'Total', mean: 'Average', last: 'Latest' };
const AGG_HELP = { best: 'The best single result counts (lowest for times).', sum: 'All approved results are added up.', mean: 'The average of approved results.', last: 'The most recent approved result counts.' };
const num = (v) => (Number.isInteger(+v) ? String(+v) : String(Math.round(+v * 1000) / 1000));
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const blank = { label: '', unit: 'count', direction: 'higher', aggregation: 'best', value_kind: 'integer', min_value: 0, max_value: 100, points_mode: 'per_unit', points_value: 1, evidence_required_for: ['imported'], note: '' };

const FIELD = { unit: 'unit', direction: 'direction', aggregation: 'aggregation', value_kind: 'number type', min_value: 'minimum', max_value: 'maximum', points_mode: 'points mode', points_value: 'points' };
const DIFF_KEYS = ['unit', 'direction', 'aggregation', 'value_kind', 'min_value', 'max_value', 'points_mode', 'points_value'];
const differs = (f, std) => (std ? DIFF_KEYS.filter((k) => String(+f[k] || f[k]) !== String(+std[k] || std[k])) : []);
const stdText = (m) => `${m.direction === 'lower' ? 'lower' : 'higher'} wins · ${num(m.min_value)}–${num(m.max_value)} ${m.unit === 'count' ? '' : m.unit} · ${m.points_mode === 'flat' ? `${num(m.points_value)} pts per result` : `${num(m.points_value)} pts per unit`}`;
const copy = async (text, toast) => {
  try {
    if (Platform.OS === 'web' && navigator?.clipboard) { await navigator.clipboard.writeText(text); toast('Rules copied'); } else await Share.share({ message: text });
  } catch (e) { toast(e.message); }
};

const rangeText = (m) => `${num(m.min_value)}–${num(m.max_value)} ${m.unit === 'count' ? '' : m.unit}`.trim();

function Badges({ m }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      <Tag label={`unit ${m.unit}`} color={c.cyan} />
      <Tag label={m.direction === 'lower' ? '↓ lower is better' : '↑ higher is better'} color={c.mint} />
      <Tag label={AGG[m.aggregation]} color={c.sun} />
    </View>
  );
}

/** Sheet footer: the error sits right above the buttons so it is never scrolled out of sight. */
function Foot({ err, onClose, children }) {
  return (
    <View style={{ flex: 1, gap: 8 }}>
      {err ? <T weight="700" size={13} color={c.red} accessibilityRole="alert">{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>{children}<Btn title="Cancel" color={c.violet} onPress={onClose} /></View>
    </View>
  );
}

function MetricEditor({ sport, start, onClose, onDone }) {
  const { toast } = useSession();
  const [f, setF] = useState(start.form);
  const [step, setStep] = useState(f.value_kind === 'integer' ? 1 : 0.1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const key = useRef(newKey());
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const [std, setStd] = useState(start.standard ?? null);
  const touched = useRef(!!start.key);
  const name = start.key ?? f.label.trim();
  // the standard rule for this metric name, so a new metric starts from the platform baseline instead of a blank form
  useEffect(() => {
    if (!name) return undefined;
    const t = setTimeout(async () => {
      try {
        const r = await api.get('/scoring-rules', { sport, metric: name });
        setStd(r.standard);
        if (!touched.current) setF((x) => ({ ...x, ...r.standard, evidence_required_for: x.evidence_required_for, note: x.note, label: x.label }));
      } catch { /* the editor still works without the baseline */ }
    }, start.key ? 0 : 500);
    return () => clearTimeout(t);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  const diff = differs(f, std);
  const apply = (patch) => { touched.current = true; set(patch); };
  const toStandard = () => { if (std) { touched.current = true; set({ ...std }); } };
  const save = async (reset = false) => {
    setErr(null);
    if (!f.label.trim()) return setErr('Give the metric a name.');
    if (!reset && !(f.min_value < f.max_value)) return setErr('The minimum must be lower than the maximum.');
    if (!reset && diff.length && !f.note.trim()) return setErr(`This differs from the standard rule (${diff.map((k) => FIELD[k]).join(', ')}). Say why below.`);
    setBusy(true);
    try {
      await api.post('/metric-definitions', { sport, metric: start.key ?? f.label.trim(), expected_version: start.version, ...f, label: f.label.trim(), note: f.note.trim() || undefined, reset_to_standard: reset || undefined, client_key: key.current });
      toast(reset ? `${f.label.trim()} reset to the standard` : `${f.label.trim()} v${start.version + 1} published`);
      onDone();
    } catch (e) { setErr(e.message); key.current = newKey(); } finally { setBusy(false); }
  };
  const evid = (k) => f.evidence_required_for.includes(k);
  return (
    <Sheet visible onClose={onClose} title={start.key ? `Edit ${f.label} → v${start.version + 1}` : 'New metric'}
      footer={<Foot err={err} onClose={onClose}><Btn title={start.key ? `Publish v${start.version + 1}` : 'Publish v1'} loading={busy} onPress={() => save(false)} /></Foot>}>
      {start.key ? null : <Field label="Metric name" value={f.label} onChangeText={(label) => set({ label })} placeholder="e.g. 100 m time, rebounds" maxLength={60} />}
      {std ? (
        <Card color={diff.length ? c.orangeSoft : c.mintSoft} pad={12}>
          <T weight="800" size={13}>Standard rule</T>
          <T size={13}>{stdText(std)}</T>
          <T size={12} color={c.mute}>{diff.length ? `Your version differs in: ${diff.map((k) => FIELD[k]).join(', ')}.` : 'Your version matches the standard.'}</T>
          {diff.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}><Btn small title="Use standard values" color={c.violet} onPress={toStandard} />{start.key ? <Btn small title="Publish as standard" color={c.violet} loading={busy} onPress={() => save(true)} /> : null}</View> : null}
        </Card>
      ) : null}
      <T weight="800" size={13}>Unit</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{UNITS.map((u) => <Chip key={u} label={u} active={f.unit === u} onPress={() => apply({ unit: u })} />)}</View>
      <T weight="800" size={13}>Who wins</T>
      <Seg options={[{ label: '↑ Higher is better', value: 'higher' }, { label: '↓ Lower is better', value: 'lower' }]} value={f.direction} onChange={(direction) => apply({ direction })} />
      <T weight="800" size={13}>How results combine</T>
      <Seg options={Object.entries(AGG).map(([value, label]) => ({ label, value }))} value={f.aggregation} onChange={(aggregation) => apply({ aggregation })} />
      <T size={12} color={c.mute}>{AGG_HELP[f.aggregation]}</T>
      <T weight="800" size={13}>Numbers allowed</T>
      <Seg options={[{ label: 'Whole numbers', value: 'integer' }, { label: 'Decimals', value: 'decimal' }]} value={f.value_kind} onChange={(value_kind) => { setStep(value_kind === 'integer' ? 1 : 0.1); set(value_kind === 'integer' ? { value_kind, min_value: Math.round(f.min_value), max_value: Math.round(f.max_value) } : { value_kind }); }} />
      <T weight="800" size={13}>Valid range</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(f.value_kind === 'integer' ? [1, 10, 100] : [0.1, 1, 10, 100]).map((s) => <Chip key={s} label={`Step ${s}`} active={step === s} onPress={() => setStep(s)} />)}</View>
      <Counter label="Minimum" value={f.min_value} min={-1000000} max={f.max_value - step} step={step} onChange={(min_value) => apply({ min_value })} suffix={f.unit === 'count' ? '' : ` ${f.unit}`} />
      <Counter label="Maximum" value={f.max_value} min={f.min_value + step} max={1000000} step={step} onChange={(max_value) => apply({ max_value })} suffix={f.unit === 'count' ? '' : ` ${f.unit}`} />
      <T weight="800" size={13}>Official points</T>
      <Seg options={[{ label: 'Same for every result', value: 'flat' }, { label: 'Per unit', value: 'per_unit' }]} value={f.points_mode} onChange={(points_mode) => apply({ points_mode })} />
      <Counter label={f.points_mode === 'flat' ? 'Points per result' : 'Points per unit'} value={f.points_value} min={0} max={1000} onChange={(points_value) => apply({ points_value })} suffix=" pts" />
      <T weight="800" size={13}>Claims that must come with evidence</T>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Chip label="Self-reported" active={evid('self_reported')} onPress={() => apply({ evidence_required_for: evid('self_reported') ? f.evidence_required_for.filter((x) => x !== 'self_reported') : [...f.evidence_required_for, 'self_reported'] })} />
        <Chip label="Imported" active={evid('imported')} onPress={() => apply({ evidence_required_for: evid('imported') ? f.evidence_required_for.filter((x) => x !== 'imported') : [...f.evidence_required_for, 'imported'] })} />
      </View>
      <T size={12} color={c.mute}>Only approved competition results ever rank. Self-reported and imported figures stay labelled and never count towards official rankings.</T>
      <Field label={diff.length ? 'Why this differs from the standard (required)' : 'Why this change (optional)'} value={f.note} onChangeText={(note) => set({ note })} multiline maxLength={300} />
      <T size={12} color={c.mute}>Publishing creates a new version for results recorded from now on. Results already stored keep the version they were scored under.</T>
    </Sheet>
  );
}

function History({ def, onClose }) {
  const d = useLoad(() => api.get(`/metric-definitions/${def.id}`), [def.id]);
  return (
    <Sheet visible onClose={onClose} title={`${def.label} · history`}>
      {d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !d.data ? <Loading /> : d.data.versions.map((v) => (
        <Card key={v.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">Version {v.version}</T><T size={12} color={c.mute}>{day(v.created_at)}{v.published_by ? ` · ${v.published_by}` : ''}</T></View>
          <T size={13}>{rangeText(v)} · {v.direction === 'lower' ? 'lower' : 'higher'} wins · {AGG[v.aggregation]} · {v.points_mode === 'flat' ? `${num(v.points_value)} pts per result` : `${num(v.points_value)} pts per unit`}</T>
          {v.changes.length && v.version > 1 ? <T size={12} color={c.mute}>Changed: {v.changes.map((x) => `${nice(x.field)} ${Array.isArray(x.from) ? x.from.join('/') : x.from} → ${Array.isArray(x.to) ? x.to.join('/') : x.to}`).join('; ')}</T> : null}
          {v.note ? <T size={12}>“{v.note}”</T> : null}
          <T size={12} color={c.mute}>{v.results} stored result{v.results === 1 ? '' : 's'} scored under this version</T>
        </Card>
      ))}
    </Sheet>
  );
}

function Metrics({ sport }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/metric-definitions', { sport, include_retired: true }), [sport]);
  const [edit, setEdit] = useState(null);
  const [hist, setHist] = useState(null);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const { can_govern: gov, metrics } = list.data;
  const open = (m) => setEdit({ key: m.key, version: m.current_version, standard: m.standard, form: { ...blank, label: m.label, unit: m.unit, direction: m.direction, aggregation: m.aggregation, value_kind: m.value_kind, min_value: +m.min_value, max_value: +m.max_value, points_mode: m.points_mode, points_value: +m.points_value, evidence_required_for: m.evidence_required_for } });
  const retire = async (m) => { try { await api.post(`/metric-definitions/${m.id}/status`, { retired: m.status !== 'retired' }); toast(m.status === 'retired' ? 'Metric restored' : 'Metric retired — history kept'); list.reload(); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 12 }}>
      {gov ? <Btn title="+ New metric" onPress={() => setEdit({ key: null, version: 0, form: blank })} /> : null}
      {!metrics.length ? <Empty emoji="📏" title="No governed metrics yet" sub={gov ? 'Until you publish one, results use the built-in rule for the metric name.' : 'Results in this sport use the platform’s built-in rules until a governed metric is published.'} /> : metrics.map((m) => (
        <Card key={m.id} pad={14} accessibilityLabel={`${m.label}, version ${m.current_version}`} color={m.status === 'retired' ? c.violetSoft : c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><H2>{m.label}</H2><Tag label={m.status === 'retired' ? 'retired' : `v${m.current_version}`} color={m.status === 'retired' ? c.orange : c.mint} /></View>
          <Badges m={m} />
          {m.differs_from_standard?.length ? <Tag label="differs from standard" color={c.orange} /> : null}
          <T size={13}>Range {rangeText(m)} · {m.points_mode === 'flat' ? `${num(m.points_value)} pts per result` : `${num(m.points_value)} pts per unit`}</T>
          <T size={12} color={m.differs_from_standard?.length ? c.orange : c.mute}>Standard: {stdText(m.standard)}{m.differs_from_standard?.length ? ` — differs in ${m.differs_from_standard.map((k) => FIELD[k]).join(', ')}` : ' — matches'}</T>
          <T size={12} color={c.mute}>Ranks: approved competition only{m.evidence_required_for.length ? ` · Evidence needed for ${m.evidence_required_for.map(nice).join(' & ')} claims` : ''}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title="History" color={c.violet} onPress={() => setHist(m)} />
            {gov && m.status !== 'retired' ? <Btn small title="Edit" onPress={() => open(m)} /> : null}
            {gov ? <Btn small title={m.status === 'retired' ? 'Restore' : 'Retire'} color={c.violet} onPress={() => retire(m)} /> : null}
          </View>
        </Card>
      ))}
      {edit ? <MetricEditor key={edit.key ?? 'new'} sport={sport} start={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} /> : null}
      {hist ? <History def={hist} onClose={() => setHist(null)} /> : null}
    </View>
  );
}

/** The platform's standard game rules for a sport, always shown whatever has been governed on top, with a way to take them away. */
function RuleCards({ items }) {
  return items.map((r, k) => (
    <Card key={r.id ?? `${r.title}-${k}`} pad={14}>
      <T weight="700" size={16}>{r.title}</T>
      <T style={{ marginTop: 6 }}>{r.body}</T>
      {r.source_url ? <Btn small title="Official source" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={() => openLink(r.source_url)} /> : null}
    </Card>
  ));
}

function Standard({ sport }) {
  const { toast } = useSession();
  const rules = useLoad(() => api.get(`/sports/${sport}/rules`), [sport]);
  if (rules.error) return <ErrorBox error={rules.error} onRetry={rules.reload} />;
  if (!rules.data) return <Loading />;
  const d = rules.data;
  const text = [`${d.sport.name} — standard rules`, ...d.scoring.map((r) => `\n${r.title}\n${r.body}`), ...d.rules.map((r) => `\n${r.title}\n${r.body}${r.source_url ? `\nSource: ${r.source_url}` : ''}`),
    '\nStandard metric rules', ...d.standard_metrics.map((m) => `${m.kind}: ${stdText(m)}`)].join('\n');
  return (
    <View style={{ gap: 12 }}>
      <Card color={c.mintSoft} pad={14}>
        <T weight="800">Standard rules {d.sport.emoji}</T>
        <T size={13}>This is the platform baseline for {d.sport.name}. Governed metrics and formats are always compared with it, and can be reset to it at any time.</T>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}><Btn small title="Copy these rules" onPress={() => copy(text, toast)} /></View>
      </Card>
      {d.in_force ? (
        <Card color={d.in_force.differs_from_standard ? c.orangeSoft : c.paper} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T weight="800">Governed format in force</T><Tag label={`v${d.in_force.version}`} color={c.mint} /></View>
          <T size={13}>{d.in_force.differs_from_standard ? 'Games of this sport start under a governed format that differs from the standard below.' : 'The governed format matches the standard.'}</T>
          {d.in_force.differs_from_standard ? d.in_force.scoring.map((r) => <T key={r.title} size={13}><T weight="700" size={13}>{r.title}: </T>{r.body.replace(/\n/g, '; ')}</T>) : null}
        </Card>
      ) : <T size={12} color={c.mute}>No governed format has been published — games use the standard rules below.</T>}
      <H2>How a game is scored (standard)</H2>
      {d.scoring.length ? <RuleCards items={d.scoring} /> : <Empty emoji="🧮" title="Scored by entering totals" sub="This sport has no built-in scoring events; the referee enters the totals on the score sheet." />}
      {d.rules.length ? <><H2>Rules of the game</H2><RuleCards items={d.rules} /></> : null}
      <H2>Standard metric rules</H2>
      {d.standard_metrics.map((m) => (
        <Card key={m.kind} pad={12} color={m.probe.startsWith(d.default_metric_kind === 'time' ? 'time' : d.default_metric_kind === 'distance' ? 'distance' : '~') ? c.violetSoft : c.paper}>
          <T weight="700">{m.kind}</T><T size={13}>{stdText(m)}</T>
        </Card>
      ))}
    </View>
  );
}

function FormatEditor({ sport, start, onClose, onDone }) {
  const { toast } = useSession();
  const [rs, setRs] = useState(start.ruleset);
  const [fk, setFk] = useState(start.format_key);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const key = useRef(newKey());
  const save = async (reset = false) => {
    setBusy(true); setErr(null);
    try {
      await api.post('/ruleset-versions', reset ? { sport, format_key: fk, expected_version: start.version, reset_to_standard: true, client_key: key.current } : { sport, format_key: fk, expected_version: start.version, ruleset: rs, note: note.trim() || undefined, client_key: key.current });
      toast(reset ? 'Reset to the standard rules' : `${rs.label} v${start.version + 1} published`);
      onDone();
    } catch (e) { setErr(e.message); key.current = newKey(); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title={start.version ? `Edit ${rs.label} → v${start.version + 1}` : 'New match format'}
      footer={<Foot err={err} onClose={onClose}><Btn title={`Publish v${start.version + 1}`} loading={busy} onPress={() => save(false)} /></Foot>}>
      <Card color={c.mintSoft} pad={12}>
        <T weight="800" size={13}>Starts from the standard rules</T>
        <T size={12}>Any change from the standard needs a reason below. You can always go back to the standard — history is kept.</T>
        <Btn small title="Publish the standard rules" color={c.violet} loading={busy} onPress={() => save(true)} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
      </Card>
      {start.version ? null : <Field label="Format name" value={rs.label} onChangeText={(label) => { setRs({ ...rs, label }); setFk(label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'format'); }} placeholder="e.g. Best of 5, Short halves" />}
      <RulesetFields rs={rs} onChange={setRs} />
      <Field label="Why this differs from the standard (required if it does)" value={note} onChangeText={setNote} multiline maxLength={300} />
      <T size={12} color={c.mute}>Games already started keep the version they started with. New games use the newest "default" version; events can pick any named format.</T>
    </Sheet>
  );
}

function Formats({ sport }) {
  const list = useLoad(() => api.get('/ruleset-versions', { sport, limit: 100 }), [sport]);
  const [edit, setEdit] = useState(null);
  const [open, setOpen] = useState(null);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const { can_govern: gov, versions } = list.data;
  const groups = versions.reduce((m, v) => ({ ...m, [v.format_key]: [...(m[v.format_key] ?? []), v] }), {});
  // start from the rules this sport's games use today, so a governor edits rather than writes from scratch
  const startNew = () => setEdit({ format_key: 'default', version: 0, ruleset: list.data.starting_point });
  return (
    <View style={{ gap: 12 }}>
      <Card color={c.mintSoft} pad={12}><T weight="800" size={13}>Standard: {list.data.standard.label}</T><T size={12}>The platform baseline. Governed formats are compared with it; games use it until a format is published.</T></Card>
      {gov ? <Btn title="+ New format" onPress={startNew} /> : null}
      {!Object.keys(groups).length ? <Empty emoji="🏟️" title="No governed match formats yet" sub="Games use the sport’s built-in scoring rules until a format is published." /> : Object.entries(groups).map(([k, vs]) => (
        <Card key={k} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><H2>{vs[0].label}</H2><Tag label={`v${vs[0].version}`} color={c.mint} /></View>
          <T size={12} color={c.mute}>{k === 'default' ? 'Applied to this sport’s games automatically' : `Format “${nice(k)}” — events can choose it`} · {vs[0].ruleset.kind.replace('_', ' ')}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small title={open === k ? 'Hide versions' : `${vs.length} version${vs.length === 1 ? '' : 's'}`} color={c.violet} onPress={() => setOpen(open === k ? null : k)} />
            {gov ? <Btn small title="Edit" onPress={() => setEdit({ format_key: k, version: vs[0].version, ruleset: vs[0].ruleset })} /> : null}
          </View>
          {open === k ? vs.map((v) => <T key={v.id} size={12} color={c.mute}>v{v.version} · {day(v.created_at)}{v.note ? ` · ${v.note}` : ''}</T>) : null}
        </Card>
      ))}
      {edit ? <FormatEditor key={edit.format_key + edit.version} sport={sport} start={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} /> : null}
    </View>
  );
}

export function SportRules({ sport: sport0, tab: tab0 }) {
  const [sport, setSport] = useState(sport0 ?? null);
  const [tab, setTab] = useState(tab0 ?? 'rulebook');
  return (
    <Screen>
      <H1>Rules & rulebook</H1>
      <T color={c.mute}>Read the rules of each sport as cards, open the official book, and localise the rules your competition changes. Scoring metrics and match formats sit beside them, and every version is kept so past results are never silently re-scored.</T>
      <SportSelect label="Sport" value={sport} onChange={setSport} />
      {sport ? (
        <>
          <Seg options={[{ label: 'Rulebook', value: 'rulebook' }, { label: 'How it is scored', value: 'standard' }, { label: 'Metrics', value: 'metrics' }, { label: 'Match formats', value: 'formats' }]} value={tab} onChange={setTab} />
          {tab === 'rulebook' ? <RulebookOrFallback key={sport} sport={sport} /> : tab === 'standard' ? <Standard key={sport} sport={sport} /> : tab === 'metrics' ? <Metrics key={sport} sport={sport} /> : <Formats key={sport} sport={sport} />}
        </>
      ) : <Empty emoji="📏" title="Pick a sport" sub="See its rules, how its games are scored and how its results are measured." />}
    </Screen>
  );
}

/** Sports with a written rulebook get the cards; the rest still show the scoring baseline and any rules the platform team wrote. */
function RulebookOrFallback({ sport }) {
  const list = useLoad(() => api.get('/rulebook'), []);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const has = list.data.some((b) => b.slug === sport || (sport === 'rugby-sevens' && b.slug === 'rugby'));
  return has ? <Rulebook sport={sport === 'rugby-sevens' ? 'rugby' : sport} /> : <><Card color={c.violetSoft} pad={12}><T size={13}>A written rulebook for this sport is not ready yet. Here are its scoring rules and anything the platform team has written.</T></Card><Standard sport={sport} /></>;
}
