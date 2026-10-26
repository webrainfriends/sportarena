import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';
import { saveText } from '../evidence';

// Beneficiary impact (#303): team/event results read live from the platform, plus milestones, community outcomes and outside results the beneficiary records,
// each with its source, date, unit and sample size. Sharing uses the agreement's existing switch (Performance & reviews). Nothing here changes a payment.
const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const KIND = { result: 'Result', milestone: 'Milestone', community: 'Community outcome' };
const KIND_TONE = { result: c.lime, milestone: c.violetSoft, community: c.sunSoft };
const SOURCES = [{ value: 'organiser_record', label: 'Organiser record' }, { value: 'third_party', label: 'Third party' }, { value: 'self_reported', label: 'Self-reported' }];
const UNITS = ['children', 'participants', 'volunteers', 'hours', 'sessions', 'games', 'seconds', 'metres', 'points', 'of 5'];
const unitOptions = [...UNITS.map((u) => ({ value: u, label: u })), { value: '__other', label: 'Other…' }];
/** Form values -> API body: the unit comes from the chip (or the custom box) and is sent only with an amount. */
const toBody = (v) => { const { unit_pick, unit_other, ...r } = v; const unit = unit_pick === '__other' ? unit_other?.trim() : unit_pick; const hasValue = r.value !== '' && r.value !== undefined && r.value !== null && !Number.isNaN(r.value); if (!hasValue) { delete r.value; delete r.unit; if (r.kind === 'milestone') { delete r.metric; delete r.sample_size; } } else r.unit = unit; if (r.source !== 'third_party') delete r.source_ref; return r; };
const unitInitial = (u) => (!u ? {} : UNITS.includes(u) ? { unit_pick: u } : { unit_pick: '__other', unit_other: u });
const num = (v) => (v === null || v === undefined ? '' : Number(v).toLocaleString());

/** Live participation and game results of a team or event (read-only, source and sample size stated). */
export function TeamEventResults({ data }) {
  if (!data) return null;
  const p = data.participation;
  return (
    <>
      {p ? <Card><T weight="900">Participation</T><T size={12} color={c.mute}>{data.participation.members != null ? `${p.members} active member${p.members === 1 ? '' : 's'}` : `${p.accepted} accepted entr${p.accepted === 1 ? 'y' : 'ies'} (${p.teams} team${p.teams === 1 ? '' : 's'}, ${p.individuals} individual${p.individuals === 1 ? '' : 's'})`} · source: {p.source_label}</T></Card> : null}
      {data.results.length ? data.results.map((r) => (
        <Card key={`${r.sport}-${r.evidence}`}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="900" style={{ flex: 1 }}>{r.sport_name}</T><Tag label={r.evidence_label} color={r.evidence === 'approved_competition' ? c.lime : c.sunSoft} /></View>
          <T size={12} color={c.mute}>{r.wins} won · {r.losses} lost · {r.ties} tied · based on {r.sample_size} game{r.sample_size === 1 ? '' : 's'} · {day(r.first_on)} – {day(r.latest_on)} · {r.source_label}</T>
        </Card>)) : <Empty emoji="🏟️" title="No finished games yet" sub="Results appear here as games are completed on the platform. Different sports are never combined into one score." />}
    </>
  );
}

/** Recorded milestones, community outcomes and outside results of one agreement. */
export function ImpactEvidence({ deal, shared }) {
  const { toast } = useSession();
  const sponsor = deal.role === 'sponsor', recipient = deal.role === 'recipient' && !deal.youth?.minor_self;
  const [history, setHistory] = useState(false);
  const [form, setForm] = useState(null); // 'record' | { fix: item } | { withdraw: item }
  const q = useLoad(async () => { try { return { data: await api.get(`/sponsorships/${deal.id}/impact`, { limit: 100, ...(history ? { history: true } : {}) }) }; } catch (e) { return { error: e }; } }, [deal.id, history, shared]);
  const r = q.data?.data, err = q.data?.error;
  const reload = () => q.reload();
  const exportCsv = async () => { try { const x = await api.get(`/sponsorships/${deal.id}/impact-export`); await saveText(x.filename, x.csv); toast(`${x.rows} row${x.rows === 1 ? '' : 's'} exported`); } catch (e) { toast(explain(e)); } };
  const canExport = recipient || !deal.can || deal.can.includes('export');
  const fields = (it) => [
    { key: 'kind', label: 'What is it?', type: 'chips', options: [{ value: 'community', label: 'Community outcome' }, { value: 'milestone', label: 'Development milestone' }, { value: 'result', label: 'Result from outside' }], show: () => !it },
    { key: 'title', label: 'Title' },
    { key: 'metric', label: 'What was measured', optional: true, hint: 'e.g. children coached, sessions run', show: (v) => v.kind !== 'milestone' },
    { key: 'value', label: 'Amount', type: 'number', optional: true, show: (v) => v.kind !== 'milestone' },
    { key: 'unit_pick', label: 'Unit', type: 'chips', optional: true, options: unitOptions, show: (v) => v.kind !== 'milestone' && v.value !== '' && v.value !== undefined },
    { key: 'unit_other', label: 'Other unit', show: (v) => v.unit_pick === '__other' && v.kind !== 'milestone' && v.value !== '' && v.value !== undefined },
    { key: 'sample_size', label: 'Based on how many', type: 'stepper', min: 1, max: 100000, step: 1, default: 1, hint: 'People, games or sessions behind the figure', show: (v) => v.kind === 'community' || (v.kind !== 'milestone' && v.value !== '' && v.value !== undefined) },
    { key: 'source', label: 'Where it comes from', type: 'chips', options: SOURCES },
    { key: 'source_ref', label: 'Who issued it', hint: 'The body or record the figure comes from', show: (v) => v.source === 'third_party' },
    { key: 'occurred_on', label: 'Date', type: 'date' },
    { key: 'period_end', label: 'Period ends', type: 'date', optional: true },
    { key: 'note', label: 'Notes (kept private to both sides)', type: 'multiline', optional: true },
    ...(it ? [{ key: 'reason', label: 'Why are you correcting it?', type: 'multiline' }] : []),
  ];
  return (
    <>
      <T weight="900" style={{ marginTop: 6 }}>Impact evidence</T>
      <T size={12} color={c.mute}>Milestones, community outcomes and results from outside the platform, entered by the beneficiary and labelled with their source. Not verified by Gotmygame, and they never change a payment or the agreement.</T>
      {q.loading && !q.data ? <Loading /> : err && sponsor ? <Empty emoji="🔒" title="Not shared" sub={err.status === 403 ? err.message : 'Impact evidence is available once the beneficiary accepts and shares it.'} /> : err ? <LoadError error={err} onRetry={reload} /> : r ? (
        <>
          {r.items.length ? r.items.map((x) => (
            <Card key={x.id} color={x.status === 'current' ? undefined : c.paper}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="900" style={{ flex: 1 }}>{x.title}</T><Tag label={KIND[x.kind]} color={KIND_TONE[x.kind]} /></View>
              <T size={12} color={c.mute}>{x.value !== null ? `${num(x.value)} ${x.unit}${x.metric ? ` (${x.metric.replace(/_/g, " ")})` : ''} · ` : ''}{x.sample_size ? `based on ${num(x.sample_size)} · ` : x.value !== null ? 'sample size not stated · ' : ''}{day(x.occurred_on)}{x.period_end ? ` – ${day(x.period_end)}` : ''} · {x.source_label}{x.source_ref ? `: ${x.source_ref}` : ''}</T>
              {x.note ? <T size={12}>{x.note}</T> : null}
              {x.corrected ? <T size={12} color={c.mute}>Corrected: {x.correction_reason}</T> : null}
              {x.status !== 'current' ? <T size={12} color={c.mute}>{x.status === 'superseded' ? 'Replaced by a correction' : `Withdrawn: ${x.correction_reason}`}</T> : null}
              {recipient && x.status === 'current' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}><Btn small title="Correct" color={c.paper} ink={c.ink} onPress={() => setForm({ fix: x })} accessibilityLabel={`Correct ${x.title}`} /><Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => setForm({ withdraw: x })} accessibilityLabel={`Withdraw ${x.title}`} /></View> : null}
            </Card>))
            : <Empty emoji="🌱" title="No impact evidence yet" sub={recipient ? 'Record a milestone or community outcome. Add the source and how many people it is based on.' : 'Nothing recorded yet in what is shared. Different metrics and units are never combined into one score.'} />}
          {r.total > r.items.length ? <T size={12} color={c.mute}>Showing {r.items.length} of {r.total}.</T> : null}
        </>) : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {recipient && ['active', 'paused', 'ended', 'term_expired', 'completed'].includes(deal.status) ? <Btn small title="Record impact" color={c.mint} ink={c.ink} onPress={() => setForm('record')} /> : null}
        {r && (recipient || shared) ? <Chip label={history ? 'Showing corrections ✓' : 'Show corrections'} active={history} onPress={() => setHistory(!history)} /> : null}
        {r && canExport ? <Btn small title="Export (CSV)" color={c.paper} ink={c.ink} onPress={exportCsv} accessibilityLabel="Export impact evidence as a CSV file" /> : null}
      </View>

      <FormSheet visible={form === 'record'} onClose={() => setForm(null)} title="Record impact" submitLabel="Save" fields={fields(null)} initial={{ kind: 'community', source: 'organiser_record' }}
        onSubmit={async (v) => { await api.post(`/sponsorships/${deal.id}/impact`, toBody(v)); reload(); return 'Saved'; }} />
      <FormSheet visible={!!form?.fix} onClose={() => setForm(null)} title="Correct a figure" submitLabel="Save correction" fields={fields(form?.fix)}
        initial={form?.fix ? { ...form.fix, kind: form.fix.kind, period_end: form.fix.period_end ?? undefined, metric: form.fix.metric ?? '', ...unitInitial(form.fix.unit), source_ref: form.fix.source_ref ?? '', note: form.fix.note ?? '' } : undefined}
        onSubmit={async (v) => { const { kind, ...rest } = toBody(v); try { await api.post(`/sponsorship-impact/${form.fix.id}/correction`, { ...rest, row_version: form.fix.row_version }); } catch (e) { if (e.status === 409) reload(); throw e; } reload(); return 'Corrected — the old figure is kept in the history'; }} />
      <FormSheet visible={!!form?.withdraw} onClose={() => setForm(null)} title="Withdraw this record" submitLabel="Withdraw" fields={[{ key: 'reason', label: 'Why?', type: 'multiline' }]}
        onSubmit={async (v) => { try { await api.post(`/sponsorship-impact/${form.withdraw.id}/withdraw`, { ...v, row_version: form.withdraw.row_version }); } catch (e) { if (e.status === 409) reload(); throw e; } reload(); return 'Withdrawn — kept in the history'; }} />
    </>
  );
}

/** Pre-award evidence for one application. Brand reviewers see what the applicant shared; the applicant chooses what to share (or stops sharing). */
export function ApplicationEvidence({ application, side, onChanged }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(false);
  const q = useLoad(async () => { if (!open || side !== 'reviewer') return null; try { return { data: await api.get(`/program-applications/${application.id}/evidence`) }; } catch (e) { return { error: e }; } }, [application.id, open, side]);
  const ev = q.data?.data, err = q.data?.error;
  const athlete = application.target_type === 'athlete';
  const stop = async () => { try { await api.post(`/program-applications/${application.id}/evidence-share`, { enabled: false }); toast('Sharing stopped'); onChanged?.(); } catch (e) { toast(explain(e)); onChanged?.(); } };
  const start = async (v) => { await api.post(`/program-applications/${application.id}/evidence-share`, { enabled: true, ...(athlete ? Object.fromEntries((v.sections ?? []).map((k) => [k, true])) : {}), expires_in_days: v.days ?? 60 }); onChanged?.(); return 'Sharing on'; };
  if (side === 'applicant') {
    if (!['submitted'].includes(application.status) && !application.evidence_shared) return null;
    return (
      <View style={{ marginTop: 6, gap: 6 }}>
        <T size={12} color={c.mute}>{application.evidence_shared ? 'You are sharing evidence with this sponsor for this application.' : 'Optional: let the sponsor see your evidence for this application. You choose what, and can stop at any time.'}</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {application.status === 'submitted' ? <Btn small title={application.evidence_shared ? 'Change what I share' : 'Share evidence'} color={c.mint} ink={c.ink} onPress={() => setForm(true)} /> : null}
          {application.evidence_shared ? <Btn small title="Stop sharing" color={c.paper} ink={c.red} onPress={stop} /> : null}
        </View>
        <FormSheet visible={form} onClose={() => setForm(false)} title="Share evidence" submitLabel="Share"
          fields={[
            ...(athlete ? [{ key: 'sections', label: 'Show the sponsor', type: 'multi', options: [{ value: 'show_results', label: 'Approved results' }, { value: 'show_awards', label: 'Awards' }, { value: 'show_matches', label: 'Match history' }, { value: 'show_credentials', label: 'Certificates' }, { value: 'show_career', label: 'Club career' }, { value: 'show_video', label: 'Approved video' }, { value: 'show_references', label: 'Coach references' }] }]
              : [{ key: 'info', type: 'section', label: 'Shares your live game results and entries' }]),
            { key: 'days', label: 'Share for', type: 'chips', options: [{ value: 30, label: '30 days' }, { value: 60, label: '60 days' }, { value: 90, label: '90 days' }], default: 60 },
          ]}
          onSubmit={async (v) => { const out = await start(v); return out; }} />
      </View>);
  }
  return (
    <View style={{ marginTop: 6 }}>
      <Btn small title={open ? 'Hide shared evidence' : 'Shared evidence'} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setOpen(!open)} accessibilityLabel="Show the evidence this applicant shared" />
      {open ? (q.loading && !q.data ? <Loading /> : err ? <LoadError error={err} onRetry={q.reload} /> : ev ? (
        <Card color={c.paper}>
          {ev.state === 'not_shared' ? <T size={12} color={c.mute}>The applicant has not shared evidence for this application.</T> : null}
          {ev.state === 'revoked' ? <T size={12} color={c.mute}>The applicant stopped sharing (or the share expired). Nothing is shown.</T> : null}
          {ev.state === 'closed' ? <T size={12} color={c.mute}>This application is no longer under review.</T> : null}
          {ev.state === 'shared' && ev.passport ? (
            <>
              <T weight="900">Shared passport sections</T>
              {ev.passport.verified_results?.length ? ev.passport.verified_results.map((x) => <T key={`${x.sport_slug}-${x.metric}`} size={12}>{x.sport} · {x.metric}: best {x.best}{x.unit ? ` ${x.unit}` : ''} ({x.results} approved result{x.results === 1 ? '' : 's'})</T>) : null}
              {ev.passport.awards?.length ? ev.passport.awards.map((x, n) => <T key={n} size={12}>🏅 {x.name}{x.event_name ? ` · ${x.event_name}` : ''}{x.year ? ` (${x.year})` : ''}</T>) : null}
              {ev.passport.career?.length ? ev.passport.career.map((x) => <T key={x.sport_slug} size={12}>{x.sport_slug}: {x.matches} matches ({x.official_matches} official), {x.wins}W {x.losses}L</T>) : null}
              {ev.passport.credentials?.length ? <T size={12}>{ev.passport.credentials.length} certificate{ev.passport.credentials.length === 1 ? '' : 's'} shared</T> : null}
              <T size={12} color={c.mute}>{ev.note} Shared until {day(ev.expires_at)}.</T>
            </>) : null}
          {ev.state === 'shared' && ev.team_event ? <><TeamEventResults data={ev.team_event} /><T size={12} color={c.mute}>{ev.note}</T></> : null}
        </Card>) : null) : null}
    </View>
  );
}
