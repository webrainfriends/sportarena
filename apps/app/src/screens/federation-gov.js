// Federation OS (#475): the body's governance tabs: calendar, versioned policies, source-linked reports with auditable exports, and setup
// (staff and scoped roles, the recognised hierarchy, status, jurisdiction and sports). The server enforces every permission; controls are hidden for roles that cannot use them.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, Loading, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField, shiftMonth } from '../pickers';
import { saveText } from '../evidence';
import { useSports } from '../sportpicker';
import { LoadError, explain } from '../access';
import { c } from '../theme';
import { BodyPicker, Banner, Metric, StatusTag, fmtDate, fmtRange, todayIso, LEVEL_LABEL, ROLE_LABEL, ROLE_HELP, POLICY_LABEL, statusLabel } from '../federation-ui';
import { Cols, ListCard, Pager, Row2, SwitchRow } from '../federation-bits';

const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
const monthName = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const DATE_KINDS = [['registration_window', 'Registration window'], ['transfer_window', 'Transfer window'], ['congress', 'Congress'], ['administrative', 'Administrative date'], ['official_development', 'Official development'], ['assessment', 'Assessment'], ['deadline', 'Deadline']].map(([value, label]) => ({ value, label }));
const KIND_TONE = { sanctioned_competition: c.mint, registration_window: c.cyan, transfer_window: c.cyan, licence_renewal: c.sun, affiliation_renewal: c.sun, congress: c.violetSoft, deadline: c.pinkSoft };

/** A small reason prompt. */
function ReasonSheet({ visible, onClose, title, body, confirm, danger, onConfirm }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View style={{ gap: 12 }}>
        {body ? <T size={13} color={c.mute}>{body}</T> : null}
        <Field label="Reason" value={reason} onChangeText={setReason} multiline maxLength={500} />
        <Btn title={confirm} color={danger ? c.red : c.pink} loading={busy} disabled={reason.trim().length < 3} onPress={async () => { setBusy(true); try { await onConfirm(reason.trim()); setReason(''); onClose(); } finally { setBusy(false); } }} />
      </View>
    </Sheet>
  );
}

const useBody = (id) => useLoad(() => api.get(`/federation/bodies/${id}`), [id]);

// ------------------------------------------------------------------ calendar
export function CalendarTab({ id, me, below, go }) {
  const { toast } = useSession();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [kind, setKind] = useState(null);
  const [add, setAdd] = useState(false);
  const [cancel, setCancel] = useState(null);
  const body = useBody(id);
  const cal = useLoad(() => api.get(`/federation/bodies/${id}/calendar`, { from: `${month}-01`, to: lastDay(month), include_descendants: below }), [id, month, below]);
  const items = (cal.data?.items ?? []).filter((i) => !kind || i.kind === kind);
  const byDay = useMemo(() => { const m = new Map(); for (const i of items) { const k = i.starts_on; m.set(k, [...(m.get(k) ?? []), i]); } return [...m.entries()]; }, [items]);
  const sports = body.data?.sports ?? [];
  const open = (i) => {
    if (i.source.type === 'event' && i.source.sanction_id) return go('sanctions');
    if (i.source.type === 'affiliations') return go('affiliations', { expiring: 30 });
    if (i.source.type === 'licences') return go('licences', { expiring: 30 });
    return undefined;
  };
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Btn small title="‹" color={c.paper} ink={c.ink} accessibilityLabel="Previous month" onPress={() => setMonth(shiftMonth(month, -1))} />
        <T weight="800" size={17} accessibilityRole="header" accessibilityLiveRegion="polite">{monthName(month)}</T>
        <Btn small title="›" color={c.paper} ink={c.ink} accessibilityLabel="Next month" onPress={() => setMonth(shiftMonth(month, 1))} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Btn small title="Today" color={c.paper} ink={c.ink} onPress={() => setMonth(todayIso().slice(0, 7))} />
        {me.can.governance ? <Btn small title="Add a date" onPress={() => setAdd(true)} /> : null}
      </View>
      <Seg options={[{ value: null, label: 'Everything' }, ...(cal.data?.kinds ?? []).map((k) => ({ value: k.kind, label: k.label }))]} value={kind} onChange={setKind} />
      {cal.error ? <LoadError error={cal.error} onRetry={cal.reload} /> : !cal.data ? <Loading /> : byDay.length ? byDay.map(([d, rows]) => (
        <View key={d} style={{ gap: 8 }}>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5, marginTop: 6 }}>{new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}</T>
          {rows.map((i) => (
            <ListCard key={`${i.kind}${i.source.id ?? i.source.expires_on}${i.body_id}`} title={i.title} sub={`${i.kind_label}${i.starts_on !== i.ends_on ? ` · ${fmtRange(i.starts_on, i.ends_on)}` : ''}${i.sport_name ? ` · ${i.sport_name}` : ''}${below ? ` · ${i.body}` : ''}`} sub2={i.kind === 'sanctioned_competition' ? i.meta : i.kind.endsWith('renewal') ? undefined : i.meta}
              right={<Tag label={i.kind_label} color={KIND_TONE[i.kind] ?? c.violetSoft} />} status={i.flag ? 'suspended' : undefined} statusLabel={i.flag ? 'Dates moved' : undefined} tone={i.flag ? c.orangeSoft : undefined}
              onPress={open(i) ? () => open(i) : (i.source.type === 'federation_date' && me.can.governance ? () => setCancel(i) : undefined)} />))}
        </View>)) : <Empty emoji="🗓️" title="Nothing scheduled this month" sub="Sanctioned competitions, windows, congress, deadlines and the days affiliations and licences expire appear here." />}
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add a federation date" submitLabel="Add" initial={{ kind: 'deadline', starts_on: `${month}-01`, ends_on: `${month}-01` }}
        fields={[{ key: 'kind', label: 'What is it', type: 'chips', options: DATE_KINDS }, { key: 'title', label: 'Title' }, { key: 'starts_on', label: 'Dates', type: 'daterange', toKey: 'ends_on' },
          ...(sports.length > 1 ? [{ key: 'sport_id', label: 'Only for one sport (optional)', type: 'chips', options: sports.map((s) => ({ value: s.sport_id, label: s.sport_name })), optional: true }] : []), { key: 'note', label: 'Note', multiline: true, optional: true }]}
        onSubmit={async (v) => { await api.post(`/federation/bodies/${id}/dates`, v); cal.reload(); return 'Date added'; }} />
      <ReasonSheet visible={!!cancel} onClose={() => setCancel(null)} title={`Cancel “${cancel?.title ?? ''}”`} body="It leaves the calendar but stays in the history with your reason." confirm="Cancel this date" danger
        onConfirm={async (reason) => { try { await api.post(`/federation/dates/${cancel.source.id}/cancel`, { reason }); toast('Date cancelled'); cal.reload(); } catch (e) { toast(explain(e)); } }} />
    </View>
  );
}

// ------------------------------------------------------------------ policies
const L = (key, label) => ({ key, label, kind: 'list' });
const B = (key, label, def = false) => ({ key, label, kind: 'bool', def });
const I = (key, label, min = 0, max = 999, def = 0, optional = false) => ({ key, label, kind: 'int', min, max, def, optional });
const N = (key) => ({ key, label: 'Note', kind: 'text' });
const SPEC = {
  affiliation: [L('required_documents', 'Required documents'), I('min_teams', 'Minimum teams', 0, 500), I('renewal_notice_days', 'Renewal notice (days)', 0, 365, 30)],
  licence: [L('required_documents', 'Required documents'), I('renewal_notice_days', 'Renewal opens (days before expiry)', 0, 365, 30)],
  sanction: [I('lead_time_days', 'Notice needed (days)', 0, 730), B('require_venue', 'A venue must be confirmed'), B('require_ruleset', 'A governed rule version must be chosen'), I('min_ruleset_version', 'Lowest rule version (0 = any)', 0, 999, 0, true),
    I('min_officials', 'Officials confirmed (at least)', 0, 200), I('min_official_grade_rank', 'Official grade rank (at least)', 0, 20), B('require_licensed_officials', 'Officials must hold a federation licence'), B('require_insurance', 'Event insurance must cover the dates'),
    B('require_affiliated_entrants', 'Every entered team must be from an affiliated club'), L('required_documents', 'Required documents')],
  eligibility: [I('min_age', 'Youngest age (0 = no limit)', 0, 99, 0, true), I('max_age', 'Oldest age (0 = no limit)', 0, 99, 0, true), L('categories', 'Categories'), N('note')],
  roster: [I('min_players', 'Smallest roster (0 = none)', 0, 500, 0, true), I('max_players', 'Largest roster (0 = none)', 0, 500, 0, true), I('max_foreign', 'Most foreign players (0 = none)', 0, 500, 0, true), N('note')],
  competition_entry: [B('requires_affiliation', 'Entrants must be affiliated', true), B('requires_licensed_players', 'Players must be licensed', true), I('max_entries_per_club', 'Most entries per club (0 = no limit)', 0, 100, 0, true), N('note')],
  official_grade: [{ key: 'grades', label: 'Grades, one per line as “Level = rank”', kind: 'grades' }, N('note')],
  registration: [I('max_active_clubs', 'Most clubs a player can register with', 1, 10, 1), B('requires_guardian_consent_under_18', 'Guardian consent for under-18s', true), N('note')],
  transfer: [I('max_transfers_per_window', 'Most transfers per window (0 = no limit)', 0, 20, 0, true), I('fee_cap_minor', 'Fee cap in minor units (0 = none)', 0, 1000000000, 0, true), N('note')],
  discipline: [I('points_threshold', 'Points before a suspension (0 = none)', 0, 1000, 0, true), I('suspension_matches', 'Matches suspended', 0, 100, 0, true), I('reset_after_days', 'Points reset after (days, 0 = never)', 0, 3650, 0, true), N('note')],
  para_classification: [B('classification_required', 'Classification is required', true), L('classes', 'Classes'), I('valid_for_months', 'Valid for (months, 0 = no limit)', 0, 120, 0, true), N('note')],
};
const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const fieldsFor = (kind) => (SPEC[kind] ?? []).map((f) => (f.kind === 'bool' ? { key: f.key, label: f.label, type: 'switch', default: f.def } : f.kind === 'int' ? { key: f.key, label: f.label, type: 'stepper', min: f.min, max: f.max, default: f.def }
  : f.kind === 'list' ? { key: f.key, label: `${f.label} (one per line)`, multiline: true, optional: true } : f.kind === 'grades' ? { key: f.key, label: f.label, multiline: true, optional: true } : { key: f.key, label: f.label, multiline: true, optional: true }));
const paramsFrom = (kind, v) => {
  const out = {};
  for (const f of SPEC[kind] ?? []) {
    const x = v[f.key];
    if (f.kind === 'bool') out[f.key] = !!x;
    else if (f.kind === 'int') { if (f.optional && !x) continue; out[f.key] = Number(x ?? f.def); }
    else if (f.kind === 'list') out[f.key] = lines(x);
    else if (f.kind === 'grades') out[f.key] = lines(x).map((l) => { const [level, rank] = l.split('='); return { level: level.trim(), min_grade_rank: Number(rank) || 0 }; });
    else if (x?.trim()) out[f.key] = x.trim();
  }
  return out;
};
const show = (v) => (Array.isArray(v) ? (v.length ? v.map((x) => (typeof x === 'object' ? `${x.level} ≥ ${x.min_grade_rank}` : x)).join(', ') : 'none') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
const labelOf = (kind, key) => SPEC[kind]?.find((f) => f.key === key)?.label ?? key.replace(/_/g, ' ');

function PolicySheet({ id, onClose, can, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => (id ? api.get(`/federation/policies/${id}`) : Promise.resolve(null)), [id]);
  const [publish, setPublish] = useState(false);
  const [retire, setRetire] = useState(false);
  const p = d.data;
  const latest = p?.versions?.[0];
  return (
    <Sheet visible={!!id} onClose={onClose} title={p?.title ?? 'Policy'}>
      {d.error ? <LoadError error={d.error} onRetry={d.reload} /> : !p ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={p.kind_label} color={c.cyan} /><Tag label={p.enforced ? 'Enforced at decisions' : 'Governing reference'} color={p.enforced ? c.mint : c.violetSoft} />{p.status === 'retired' ? <StatusTag status="archived" label="Retired" /> : null}</View>
          <T size={12.5} color={c.mute}>{[p.sport_name, p.category, p.season_year ? `Season ${p.season_year}` : 'All seasons'].filter(Boolean).join(' · ')}</T>
          {p.versions.length ? p.versions.map((v) => (
            <Card key={v.id} color={v.in_force ? c.mintSoft : c.paper}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">Version {v.version}</T><StatusTag status={v.in_force ? 'in_force' : new Date(v.effective_from) > new Date() ? 'pending' : 'ended'} label={v.in_force ? 'In force' : new Date(v.effective_from) > new Date() ? 'Starts later' : 'Superseded'} /></View>
              <T size={12} color={c.mute}>Effective {fmtDate(v.effective_from)}</T>
              {v.summary ? <T size={13} style={{ marginTop: 4 }}>{v.summary}</T> : null}
              <View style={{ marginTop: 6 }}>{Object.entries(v.params).map(([k, val]) => <Row2 key={k} k={labelOf(p.kind, k)} v={show(val)} />)}</View>
            </Card>)) : <Empty emoji="📜" title="No version published yet" sub="Publish the first version to put this requirement into effect." />}
          {can && p.status === 'active' ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title="Publish a new version" onPress={() => setPublish(true)} />
              <Btn small title="Retire" color={c.paper} ink={c.ink} onPress={() => setRetire(true)} />
            </View>) : null}
          <T size={11.5} color={c.mute}>Versions are never edited. Decisions made earlier keep the version they used.</T>
        </View>)}
      {p ? (
        <FormSheet visible={publish} onClose={() => setPublish(false)} title="Publish a version" submitLabel="Publish" initial={{ effective_from: todayIso(), ...(latest ? prefill(p.kind, latest.params) : {}) }}
          fields={[{ key: 'effective_from', label: 'Takes effect on', type: 'date', hint: latest ? `Must be after ${fmtDate(latest.effective_from)}.` : undefined }, { key: 'summary', label: 'What changed', multiline: true, optional: true }, ...fieldsFor(p.kind)]}
          onSubmit={async (v) => { await api.post(`/federation/policies/${id}/versions`, { effective_from: v.effective_from, summary: v.summary || undefined, params: paramsFrom(p.kind, v) }); d.reload(); onChanged(); return 'Version published'; }} />) : null}
      <ReasonSheet visible={retire} onClose={() => setRetire(false)} title="Retire this policy" body="Its versions stay, and decisions made under them keep pointing at them." confirm="Retire" danger
        onConfirm={async (reason) => { try { await api.post(`/federation/policies/${id}/retire`, { reason }); toast('Policy retired'); d.reload(); onChanged(); } catch (e) { toast(explain(e)); } }} />
    </Sheet>
  );
}
/** Turn stored params back into the form's text values so a new version starts from the old one. */
function prefill(kind, params) {
  const out = {};
  for (const f of SPEC[kind] ?? []) {
    const x = params[f.key];
    if (x === undefined) continue;
    out[f.key] = f.kind === 'list' ? x.join('\n') : f.kind === 'grades' ? x.map((g) => `${g.level} = ${g.min_grade_rank}`).join('\n') : x;
  }
  return out;
}

export function PoliciesTab({ id, me }) {
  const kinds = useLoad(() => api.get('/federation/policy-kinds'), []);
  const body = useBody(id);
  const list = useLoad(() => api.get(`/federation/bodies/${id}/policies`, { include_inherited: true }), [id]);
  const [open, setOpen] = useState(null);
  const [add, setAdd] = useState(false);
  const sports = body.data?.sports ?? [];
  const year = new Date().getFullYear();
  const groups = useMemo(() => { const m = new Map(); for (const p of list.data ?? []) m.set(p.kind, [...(m.get(p.kind) ?? []), p]); return [...m.entries()]; }, [list.data]);
  return (
    <View style={{ gap: 6 }}>
      <T size={12.5} color={c.mute}>Administrative requirements by sport, category and season. Playing and scoring rules live in the rulebook. A body with no policy of its own inherits the nearest one above it.</T>
      {me.can.governance ? <Btn small title="New requirement" onPress={() => setAdd(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : groups.length ? groups.map(([kind, rows]) => (
        <Section key={kind} title={POLICY_LABEL[kind] ?? kind} color={c.cyan}>
          {rows.map((p) => (
            <ListCard key={p.id} title={p.title} sub={[p.sport_name, p.category, p.season_year ? `Season ${p.season_year}` : null].filter(Boolean).join(' · ') || 'All sports, categories and seasons'}
              sub2={p.current ? `Version ${p.current.version} since ${fmtDate(p.current.effective_from)}${p.upcoming ? ` · version ${p.upcoming.version} from ${fmtDate(p.upcoming.effective_from)}` : ''}` : p.upcoming ? `Starts ${fmtDate(p.upcoming.effective_from)}` : 'No version in force'}
              status={p.status === 'retired' ? 'archived' : p.inherited ? 'pending' : p.enforced ? 'in_force' : undefined} statusLabel={p.status === 'retired' ? 'Retired' : p.inherited ? `From ${p.body_name}` : p.enforced ? 'Enforced' : 'Reference'} onPress={() => setOpen(p.id)} />))}
        </Section>)) : <Empty emoji="📜" title="No requirements published" sub="Publish what clubs, people and organisers must meet: affiliation documents, licence conditions, sanctioning conditions and more." />}
      <PolicySheet id={open} onClose={() => setOpen(null)} can={me.can.governance} onChanged={list.reload} />
      <FormSheet visible={add} onClose={() => setAdd(false)} title="New requirement" submitLabel="Create" initial={{ kind: 'sanction', season: 'all' }}
        fields={[{ key: 'kind', label: 'Kind', type: 'chips', options: (kinds.data ?? []).map((k) => ({ value: k.kind, label: `${k.label}${k.enforced ? ' ✓' : ''}` })), hint: '✓ = enforced when decisions are made. The rest are published governing references.' },
          { key: 'title', label: 'Title' }, ...(sports.length ? [{ key: 'sport_id', label: 'Only for one sport (optional)', type: 'chips', options: sports.map((s) => ({ value: s.sport_id, label: s.sport_name })), optional: true }] : []),
          { key: 'category', label: 'Category (optional)', optional: true, hint: 'A club category, licence role (athlete, coach, official…) or age group this applies to.' },
          { key: 'season', label: 'Season', type: 'chips', options: [{ value: 'all', label: 'All seasons' }, { value: String(year), label: String(year) }, { value: String(year + 1), label: String(year + 1) }] }]}
        onSubmit={async (v) => { const p = await api.post(`/federation/bodies/${id}/policies`, { kind: v.kind, title: v.title, sport_id: v.sport_id || undefined, category: v.category || '', season_year: v.season === 'all' ? undefined : Number(v.season) }); list.reload(); setOpen(p.id); return 'Created. Publish its first version.'; }} />
    </View>
  );
}

// ------------------------------------------------------------------ reports
const REPORTS = [['affiliations', 'Affiliations'], ['licences', 'Licences'], ['sanctions', 'Sanctions'], ['jurisdiction', 'Jurisdiction']];
const HIDE = /(^|_)id$/;
const VAL = (k, v) => (k === 'status_as_of' && v ? statusLabel(v) : v);
const HEAD = (k) => k.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const PAGE = 25;

export function ReportsTab({ id, below }) {
  const { toast } = useSession();
  const { tablet } = useLayout();
  const body = useBody(id);
  const [report, setReport] = useState('affiliations');
  const [asOf, setAsOf] = useState(null);
  const [season, setSeason] = useState(null);
  const [sport, setSport] = useState(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const year = new Date().getFullYear();
  const q = { include_descendants: below, as_of: asOf || undefined, season_year: report === 'jurisdiction' ? undefined : season || undefined, sport_id: report === 'jurisdiction' ? undefined : sport || undefined };
  const res = useLoad(() => api.get(`/federation/bodies/${id}/reports/${report}`, { ...q, limit: PAGE, offset }), [id, report, below, asOf, season, sport, offset]);
  const log = useLoad(() => api.get(`/federation/bodies/${id}/exports`, { limit: 10 }), [id]);
  const d = res.data;
  const reset = (fn) => (v) => { fn(v); setOffset(0); };
  const exportCsv = async () => {
    setBusy(true);
    try { const out = await api.get(`/federation/bodies/${id}/reports/${report}`, { ...q, format: 'csv' }); await saveText(out.filename, out.csv); toast(`Exported ${out.rows} rows`); log.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const cols = (d?.columns ?? []).filter((k) => !HIDE.test(k));
  const wide = tablet && cols.length <= 8;
  return (
    <View style={{ gap: 10 }}>
      <Seg options={REPORTS.map(([value, label]) => ({ value, label }))} value={report} onChange={(v) => { setReport(v); setOffset(0); }} />
      <Cols
        a={<DateField label="In force on" value={asOf} onChange={reset(setAsOf)} optional max={todayIso()} hint="Leave empty for today." />}
        b={report !== 'jurisdiction' ? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{[year - 1, year, year + 1].map((y) => <Chip key={y} label={`${report === 'affiliations' ? 'Season' : 'Year'} ${y}`} active={season === y} onPress={() => reset(setSeason)(season === y ? null : y)} />)}</View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{(body.data?.sports ?? []).map((s) => <Chip key={s.sport_id} label={s.sport_name} active={sport === s.sport_id} onPress={() => reset(setSport)(sport === s.sport_id ? null : s.sport_id)} />)}</View>
          </View>) : <T size={12.5} color={c.mute}>The hierarchy with what each body has in force on the date.</T>} />
      {res.error ? <LoadError error={res.error} onRetry={res.reload} /> : !d ? <Loading /> : (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {Object.entries(d.totals).map(([k, v]) => <Metric key={k} value={v} label={HEAD(k)} />)}
          </View>
          <T size={12} color={c.mute}>As of {fmtDate(d.as_of)} · {d.scope.bodies} bod{d.scope.bodies === 1 ? 'y' : 'ies'} · every row links to its source record and carries its effective dates.{d.truncated ? ' Showing the first 5,000 rows.' : ''}</T>
          <Btn small title="Export to spreadsheet (CSV)" color={c.violet} loading={busy} onPress={exportCsv} style={{ alignSelf: 'flex-start' }} />
          {d.rows.length ? (wide ? (
            <Card color={c.paper} pad={0}>
              <View style={{ flexDirection: 'row', padding: 10, borderBottomWidth: 1, borderColor: c.line }}>{cols.map((k) => <T key={k} size={11} weight="800" color={c.mute} style={{ flex: 1, paddingRight: 6 }}>{HEAD(k).toUpperCase()}</T>)}</View>
              {d.rows.map((r, n) => <View key={n} style={{ flexDirection: 'row', padding: 10, borderBottomWidth: n < d.rows.length - 1 ? 1 : 0, borderColor: c.line }}>{cols.map((k) => <T key={k} size={12.5} style={{ flex: 1, paddingRight: 6 }}>{VAL(k, r[k]) ?? '—'}</T>)}</View>)}
            </Card>) : d.rows.map((r, n) => (
            <Card key={n} color={c.paper}>
              <T weight="700">{r[cols[1]] ?? r[cols[0]]}</T>
              <View style={{ marginTop: 6 }}>{cols.filter((k) => k !== cols[1]).map((k) => <Row2 key={k} k={HEAD(k)} v={VAL(k, r[k])} />)}</View>
            </Card>))) : <Empty emoji="📄" title="Nothing in force on that date" sub="Try another date, season or sport." />}
          <Pager total={d.total} offset={offset} limit={PAGE} onOffset={setOffset} busy={res.loading} />
        </>)}
      <Section title="Export log" color={c.sun}>
        {log.data?.length ? log.data.map((e) => <ListCard key={e.id} title={`${HEAD(e.report)} · ${e.row_count} rows`} sub={`${e.exported_by} · ${fmtDate(e.created_at)} · as of ${fmtDate(e.as_of)}`} sub2={`SHA-256 ${e.sha256.slice(0, 16)}…`} />) : <Empty emoji="🧾" title="No exports yet" sub="Every export is logged with who took it and a fingerprint of the file." />}
      </Section>
    </View>
  );
}

// ------------------------------------------------------------------ setup
export function SetupTab({ id, me, home, reloadHome }) {
  const { toast } = useSession();
  const { push } = useNav();
  const sports = useSports();
  const body = useBody(id);
  const roles = useLoad(() => api.get(`/federation/bodies/${id}/roles`), [id]);
  const links = useLoad(() => api.get(`/federation/bodies/${id}/links`, { limit: 50 }), [id]);
  const mine = useLoad(() => api.get('/federation/mine', { limit: 100 }).catch(() => []), []);
  const [grant, setGrant] = useState(false);
  const [edit, setEdit] = useState(false);
  const [status, setStatus] = useState(null);
  const [propose, setPropose] = useState(false);
  const [endLink, setEndLink] = useState(null);
  const [revoke, setRevoke] = useState(null);
  const b = body.data;
  const orgId = mine.data?.find((x) => x.id === id)?.organisation_id;
  const spById = useMemo(() => Object.fromEntries((sports.data ?? []).map((s) => [s.id, s.slug])), [sports.data]);
  const slugToId = useMemo(() => Object.fromEntries((sports.data ?? []).map((s) => [s.slug, s.id])), [sports.data]);
  const act = async (fn, msg) => { try { await fn(); toast(msg); links.reload(); body.reload(); reloadHome(); } catch (e) { toast(explain(e)); } };
  const admin = me.admin;
  return (
    <View style={{ gap: 6 }}>
      {!admin ? <Banner>Only the body's owners and admins change its setup. You can see who runs it and how it is recognised.</Banner> : null}
      <Cols
        a={<>
          <Section title="Who runs this body" color={c.cyan} action={admin ? 'Give a role' : undefined} onAction={() => setGrant(true)}>
            {roles.error ? <LoadError error={roles.error} onRetry={roles.reload} /> : !roles.data ? <Loading /> : (
              <>
                {roles.data.owners.map((o) => <ListCard key={`o${o.id}`} title={o.display_name} sub={`@${o.handle}`} status="active" statusLabel={o.role === 'owner' ? 'Owner' : 'Admin'} />)}
                {roles.data.roles.map((r) => <ListCard key={r.role_id} title={r.display_name} sub={`${ROLE_LABEL[r.role]}${r.sport_name ? ` · ${r.sport_name} only` : ' · all sports'}`} sub2={ROLE_HELP[r.role]} right={admin ? <Btn small title="Revoke" color={c.paper} ink={c.ink} onPress={() => setRevoke(r)} /> : undefined} />)}
                {!roles.data.roles.length ? <T size={12.5} color={c.mute}>No scoped roles yet. Give someone one job — registrar, licensing officer, sanctioning officer, secretary, compliance or auditor — without giving them the whole body.</T> : null}
              </>)}
          </Section>
          <Section title="Recognition" color={c.mint} action={admin ? 'Ask or invite' : undefined} onAction={() => setPropose(true)}>
            {b && !b.parent && !(links.data ?? []).length ? <T size={12.5} color={c.mute}>Not recognised under another body, and no bodies recognised below.</T> : null}
            {(links.data ?? []).map((l) => {
              const iAmParent = l.parent_id === id;
              const other = iAmParent ? l.child_name : l.parent_name;
              const mineAsk = (l.requested_side === 'parent') === iAmParent;
              return (
                <ListCard key={l.id} title={other} sub={`${iAmParent ? 'Recognised below you' : 'Your parent'} · ${l.effective_from ? `since ${fmtDate(l.effective_from)}` : fmtDate(l.created_at)}${l.effective_to ? ` until ${fmtDate(l.effective_to)}` : ''}`} sub2={l.reason ?? undefined} status={l.status}
                  right={admin && l.status === 'requested' ? (mineAsk ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/federation/links/${l.id}/respond`, { decision: 'withdraw' }), 'Request withdrawn')} />
                    : <View style={{ gap: 6 }}><Btn small title="Recognise" onPress={() => act(() => api.post(`/federation/links/${l.id}/respond`, { decision: 'recognise' }), 'Recognised')} /><Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/federation/links/${l.id}/respond`, { decision: 'decline' }), 'Declined')} /></View>)
                    : admin && l.status === 'recognised' ? <Btn small title="End" color={c.paper} ink={c.ink} onPress={() => setEndLink(l)} /> : undefined} />);
            })}
          </Section>
        </>}
        b={<>
          <Section title="Profile and jurisdiction" color={c.sun} action={admin ? 'Edit' : undefined} onAction={() => setEdit(true)}>
            {b ? (
              <Card color={c.paper}>
                <Row2 k="Level" v={LEVEL_LABEL[b.level]} /><Row2 k="Abbreviation" v={b.abbreviation} /><Row2 k="Country" v={b.country} /><Row2 k="State" v={b.state} /><Row2 k="Region" v={b.region} /><Row2 k="District" v={b.district} />
                <Row2 k="Sports" v={b.sports.map((s) => `${s.sport_name}${s.discipline ? ` · ${s.discipline}` : ''}`).join(', ')} /><Row2 k="Contact" v={[b.website, b.contact_email, b.contact_phone].filter(Boolean).join(' · ')} />
                {orgId ? <Btn small title="Legal details and contacts (organisation)" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={() => push('Org', { id: orgId })} /> : null}
              </Card>) : <Loading />}
          </Section>
          <Section title="Status" color={c.orange}>
            <Card color={c.paper}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><StatusTag status={home.body.status} /><T size={13} color={c.mute} style={{ flex: 1 }}>{home.body.status === 'active' ? 'Taking applications and decisions.' : 'Not taking new applications or decisions. Everything issued stays readable.'}</T></View>
              {admin ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  {home.body.status !== 'active' ? <Btn small title="Reinstate" onPress={() => setStatus('active')} /> : null}
                  {home.body.status === 'active' ? <Btn small title="Suspend" color={c.paper} ink={c.ink} onPress={() => setStatus('suspended')} /> : null}
                  {home.body.status !== 'archived' ? <Btn small title="Archive" color={c.paper} ink={c.ink} onPress={() => setStatus('archived')} /> : null}
                </View>) : null}
            </Card>
          </Section>
        </>} />

      <FormSheet visible={grant} onClose={() => setGrant(false)} title="Give a role" submitLabel="Give role" initial={{ role: 'registrar' }}
        fields={[{ key: 'user_id', label: 'Person', type: 'entity', noun: 'person' }, { key: 'role', label: 'Role', type: 'chips', options: Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })), hint: 'Each role does one job. None can see a club\'s finance, coaching notes or medical data.' },
          ...((b?.sports ?? []).length > 1 ? [{ key: 'sport_id', label: 'Only for one sport (optional)', type: 'chips', options: b.sports.map((s) => ({ value: s.sport_id, label: s.sport_name })), optional: true }] : [])]}
        onSubmit={async (v) => { await api.post(`/federation/bodies/${id}/roles`, { user_id: v.user_id, role: v.role, sport_id: v.sport_id || undefined }); roles.reload(); return 'Role given'; }} />
      <ReasonSheet visible={!!revoke} onClose={() => setRevoke(null)} title={`Revoke ${revoke ? ROLE_LABEL[revoke.role] : ''}`} body={revoke ? `${revoke.display_name} loses this role at once. The grant stays in the history.` : ''} confirm="Revoke" danger
        onConfirm={async () => { await act(() => api.del(`/federation/bodies/${id}/roles/${revoke.role_id}`), 'Role revoked'); roles.reload(); }} />
      <ReasonSheet visible={!!endLink} onClose={() => setEndLink(null)} title="End recognition" body="The link is kept with its end date. Nothing either body has issued is touched." confirm="End recognition" danger
        onConfirm={async (reason) => act(() => api.post(`/federation/links/${endLink.id}/end`, { reason }), 'Recognition ended')} />
      <ReasonSheet visible={!!status} onClose={() => setStatus(null)} title={status === 'active' ? 'Reinstate this body' : status === 'suspended' ? 'Suspend this body' : 'Archive this body'} confirm={status === 'active' ? 'Reinstate' : status === 'suspended' ? 'Suspend' : 'Archive'} danger={status !== 'active'}
        onConfirm={async (reason) => act(() => api.post(`/federation/bodies/${id}/status`, { status, reason }), 'Status updated')} />
      {b ? (
        <FormSheet visible={edit} onClose={() => setEdit(false)} title="Level, jurisdiction and sports" submitLabel="Save"
          initial={{ level: b.level, country: b.country ?? '', state: b.state ?? '', region: b.region ?? '', district: b.district ?? '', sports: b.sports.map((s) => spById[s.sport_id]).filter(Boolean) }}
          fields={[{ key: 'level', label: 'Governing level', type: 'chips', options: Object.entries(LEVEL_LABEL).map(([value, label]) => ({ value, label })) }, { key: 'country', label: 'Country', type: 'country', optional: true },
            { key: 'state', label: 'State or province', optional: true }, { key: 'region', label: 'Region', optional: true }, { key: 'district', label: 'District', optional: true }, { key: 'sports', label: 'Sports governed', type: 'sports' }]}
          onSubmit={async (v) => {
            const keep = new Map(b.sports.map((s) => [s.sport_id, s.discipline]));
            await api.patch(`/federation/bodies/${id}`, { level: v.level, country: v.country || null, state: v.state || null, region: v.region || null, district: v.district || null,
              sports: (v.sports ?? []).map((slug) => ({ sport_id: slugToId[slug], discipline: keep.get(slugToId[slug]) ?? '' })).filter((s) => s.sport_id) });
            body.reload(); reloadHome(); return 'Saved';
          }} />) : null}
      <ProposeSheet visible={propose} onClose={() => setPropose(false)} id={id} onDone={() => { links.reload(); body.reload(); reloadHome(); }} />
    </View>
  );
}

function ProposeSheet({ visible, onClose, id, onDone }) {
  const { toast } = useSession();
  const [dir, setDir] = useState('under');
  const [other, setOther] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.post('/federation/links', { parent_id: dir === 'under' ? other.id : id, child_id: dir === 'under' ? id : other.id, reason: reason || undefined });
      toast('Sent'); onDone(); onClose(); setOther(null); setReason('');
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Recognition between bodies">
      <View style={{ gap: 12 }}>
        <Seg options={[{ value: 'under', label: 'Ask to sit under a body' }, { value: 'over', label: 'Invite a body below us' }]} value={dir} onChange={(v) => { setDir(v); setOther(null); }} />
        <BodyPicker label={dir === 'under' ? 'Parent body' : 'Body to invite'} value={other} onChange={setOther} />
        <Field label="Message (optional)" value={reason} onChangeText={setReason} multiline maxLength={500} />
        <T size={12} color={c.mute}>The other body answers. A body sits under one parent at a time, and the hierarchy can never loop.</T>
        <Btn title="Send" disabled={!other} loading={busy} onPress={go} />
      </View>
    </Sheet>
  );
}
