// Academy Reports & packs (#807), inside Organisation → Academy. One governed flow for the branded PDFs: draft (by a person or a schedule) →
// a different person reviews → approve → issue → (revoke). The screen only calls the API (capabilities academy-report-packs.js); every rule
// (four-eyes, redactions, access, immutability) is enforced there. A figure that cannot be known is "Not available", never 0. All text goes through t().
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { LoadError } from '../access';
import { Btn, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { DateField } from '../pickers';
import { MultiMenuField } from '../menu-field';
import { openProtected } from '../open-file';
import { c } from '../theme';
import { t } from '../i18n';
import { Block, Kpi, Split, Timeline, when } from './academy-ui';
import { useSession } from '../session';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const TONE = { draft: c.violetSoft, in_review: c.sun, approved: c.cyan, issued: c.mint, revoked: c.red, superseded: c.violetSoft, active: c.mint };
const KINDS = ['progress', 'term', 'management', 'finance', 'campus'];
const SCOPE_OF = { progress: 'athlete', term: 'athlete', campus: 'campus', management: 'academy', finance: 'academy' };
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const StatusTag = ({ status }) => <Tag label={t(`arp.st.${status}`)} color={TONE[status]} />;
const subjectOptions = (o, what) => async (q) => api.get(`/organisations/${o.id}/academy/report-subjects`, { what, q: q || undefined });

/** Pick the subject (athlete, group or campus) with search, never typed. */
function SubjectField({ o, kind, value, onChange }) {
  const scope = SCOPE_OF[kind];
  const what = scope === 'campus' ? 'branch' : 'athlete';
  const load = useCallback(subjectOptions(o, what), [o.id, what]);
  return <MultiMenuField label={t(scope === 'campus' ? 'arp.f.campus' : 'arp.f.athlete')} value={value ? [value] : []} onChange={(v) => onChange(v[0] ?? null)} load={load} max={1} placeholder={t('common.search')} title={t(scope === 'campus' ? 'arp.f.campus' : 'arp.f.athlete')} />;
}

/** New draft, or a recurring schedule of drafts. */
function DraftSheet({ o, kind, mode, open, onClose, onDone, toast }) {
  const [subject, setSubject] = useState(null), [from, setFrom] = useState(day(kind === 'term' ? 120 : 90)), [to, setTo] = useState(day(0));
  const [cadence, setCadence] = useState('monthly'), [lookback, setLookback] = useState(90), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  const scope = SCOPE_OF[kind], schedule = mode === 'schedule';
  const loadCohorts = useCallback(subjectOptions(o, 'cohort'), [o.id]);
  if (!kind) return null;
  const needs = schedule ? (scope === 'athlete' || scope === 'campus') : scope !== 'academy';
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (schedule) await api.post(`/organisations/${o.id}/academy/report-schedules`, { kind, cadence, lookback_days: lookback, scope: scope === 'athlete' ? { cohort_id: subject } : scope === 'campus' ? { branch_id: subject } : {} });
      else { const r = await api.post(`/organisations/${o.id}/academy/report-packs`, { kind, subject_id: subject ?? undefined, from, to }); toast?.(t(r.duplicate ? 'arp.toast.exists' : 'arp.toast.created')); onDone(r); }
      if (schedule) { toast?.(t('arp.toast.scheduled')); onDone(null); }
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={open} onClose={onClose} title={t(schedule ? 'arp.sched.new' : 'arp.draft.title', { kind: t(`arp.kind.${kind}`) })}>
      <View style={{ gap: 12 }}>
        {schedule && scope === 'athlete' ? <MultiMenuField label={t('arp.f.group')} value={subject ? [subject] : []} onChange={(v) => setSubject(v[0] ?? null)} load={loadCohorts} max={1} placeholder={t('common.search')} /> : null}
        {!schedule && scope !== 'academy' ? <SubjectField o={o} kind={kind} value={subject} onChange={setSubject} /> : null}
        {schedule && scope === 'campus' ? <SubjectField o={o} kind={kind} value={subject} onChange={setSubject} /> : null}
        {schedule ? (
          <>
            <T weight="600" size={12} color={c.mute}>{t('arp.f.repeats').toUpperCase()}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{['weekly', 'monthly', 'quarterly'].map((k) => <Chip key={k} label={t(`arp.cad.${k}`)} active={cadence === k} onPress={() => setCadence(k)} />)}</View>
            <T weight="600" size={12} color={c.mute}>{t('arp.f.lookback').toUpperCase()}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{[30, 90, 120, 365].map((n) => <Chip key={n} label={t('arp.f.days', { n })} active={lookback === n} onPress={() => setLookback(n)} />)}</View>
          </>
        ) : (
          kind === 'progress' ? null : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <View style={{ flex: 1, minWidth: 150 }}><DateField label={t('arp.f.from')} value={from} onChange={setFrom} max={to} /></View>
              <View style={{ flex: 1, minWidth: 150 }}><DateField label={t('arp.f.to')} value={to} onChange={setTo} min={from} /></View>
            </View>
          )
        )}
        <T size={12} color={c.mute}>{t(schedule ? 'arp.sched.hint' : 'arp.draft.hint')}</T>
        {err ? <T size={13} color={c.red} accessibilityLiveRegion="polite">{err}</T> : null}
        <Btn title={t(schedule ? 'arp.sched.create' : 'arp.btn.create')} onPress={go} loading={busy} disabled={busy || (needs && !subject)} />
      </View>
    </Sheet>
  );
}

/** One pack in full: data basis, evidence versions, gaps, audience, the frozen content and the history, with the actions the caller's role allows. */
function PackDetail({ o, packId, canReview, me, toast, onChanged }) {
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/report-packs/${packId}`), [o.id, packId]);
  const [busy, setBusy] = useState(false), [note, setNote] = useState(''), [ack, setAck] = useState(false), [err, setErr] = useState(null);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const p = d.data;
  const base = `/organisations/${o.id}/academy/report-packs/${p.id}`;
  const run = async (fn, okMsg) => { setBusy(true); setErr(null); try { await fn(); if (okMsg) toast?.(t(okMsg)); await d.reload(); onChanged?.(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const mine = p.author_id === me;
  const gaps = p.gaps ?? [];
  const rows = [[t('arp.rv.period'), `${when(p.period_from)} – ${when(p.period_to)}`], [t('arp.rv.asof'), when(p.basis?.as_of)], [t('arp.rv.issuer'), p.basis?.issuer], [t('arp.rv.currency'), p.basis?.currencies?.length ? p.basis.currencies.join(', ') : t('arp.rv.no_currency')], [t('arp.rv.version'), t('arp.version', { n: p.version })]];
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}><StatusTag status={p.status} />{p.subject_name ? <Tag label={p.subject_name} /> : null}{p.schedule_id ? <Tag label={t('arp.by_schedule')} color={c.cyan} /> : null}</View>
      <Block title={t('arp.rv.basis')}>
        <T size={12} color={c.mute}>{t(`arp.basis.${p.kind}`)}</T>
        {rows.map(([k, v]) => <View key={k} style={{ flexDirection: 'row', gap: 8 }}><T size={13} color={c.mute} style={{ width: 110 }}>{k}</T><T size={13} weight="700" style={{ flex: 1 }}>{v}</T></View>)}
      </Block>
      <Block title={t('arp.rv.evidence')}>
        {p.evidence.map((e) => <View key={e.key} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={13} style={{ flex: 1 }}>{t(`arp.ev.${e.key}`)}</T><Tag label={e.latest ? t('arp.ev.rows_latest', { n: e.rows, date: when(e.latest) }) : t('arp.ev.rows', { n: e.rows })} color={c.cyan} /></View>)}
      </Block>
      <Block title={t('arp.rv.gaps')} right={<Tag label={String(gaps.length)} color={gaps.length ? c.sun : c.mint} />}>
        {gaps.length ? gaps.map((g, i) => <View key={i} style={{ gap: 1 }}><T size={13} weight="700">{[g.section, g.item].filter(Boolean).join(' · ')}</T><T size={12} color={c.mute}>{g.why}</T></View>) : <T size={13}>{t('arp.rv.gaps_none')}</T>}
        <T size={12} color={c.mute}>{t('arp.rv.gaps_note')}</T>
      </Block>
      <Block title={t('arp.rv.audience')}><T size={13}>{t(`arp.aud.${p.kind}`)}</T></Block>
      <Block title={t('arp.rv.content')}>
        <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, gap: 8, backgroundColor: c.bg }} accessibilityLabel={t('arp.rv.content')}>
          <T weight="800" size={14} color={c.pink}>{p.snapshot.organisation}</T>
          <T size={12} color={c.mute}>{p.snapshot.title} · {p.snapshot.reference}</T>
          {p.snapshot.sections.map((s, i) => (
            <View key={i} style={{ gap: 2 }}>
              <T weight="800" size={13}>{s.title}</T>
              {s.body ? <T size={12}>{s.body}</T> : null}
              {(s.items ?? []).map((it, j) => <View key={j} style={{ flexDirection: 'row', gap: 8 }}><T size={12} color={c.mute} style={{ flex: 1 }}>{it.title}</T><T size={12} weight="700" style={{ flex: 1 }}>{it.value}</T></View>)}
            </View>
          ))}
        </View>
      </Block>
      <Block title={t('arp.rv.history')}><Timeline items={p.events.map((e) => ({ title: t(`arp.act.${e.action}`), sub: `${e.actor_name ?? t('arp.by_schedule')} · ${when(e.created_at)}${e.note ? ` · ${e.note}` : ''}` }))} /></Block>
      {p.review_note && p.status === 'draft' ? <Panel><T weight="800" size={13}>{t('arp.rv.changes_asked')}</T><T size={13}>{p.review_note}</T></Panel> : null}
      {p.revoke_reason ? <Panel><T weight="800" size={13}>{t('arp.rv.revoked_because')}</T><T size={13}>{p.revoke_reason}</T></Panel> : null}
      <T size={12} color={c.mute}>{t('arp.rv.four_eyes')}</T>
      {err ? <T size={13} color={c.red} accessibilityLiveRegion="polite">{err}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {['draft', 'in_review', 'approved'].includes(p.status) ? <Btn small title={t('arp.btn.preview')} color={c.paper} ink={c.ink} onPress={() => run(() => openProtected(`/branded-documents/academy-pack/${p.id}/draft`, 'draft'))} disabled={busy} /> : null}
        {p.status === 'draft' ? <Btn small title={t('arp.btn.submit')} onPress={() => run(() => api.post(`${base}/submit`), 'arp.toast.submitted')} disabled={busy} /> : null}
        {['draft', 'in_review', 'approved', 'issued'].includes(p.status) ? <Btn small title={t('arp.btn.rebuild')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`${base}/new-version`), 'arp.toast.rebuilt')} disabled={busy} /> : null}
        {p.status === 'issued' && p.url ? <Btn small title={t('arp.btn.download')} onPress={() => run(() => openProtected(`/branded-documents/${p.document_id}/file`, 'report'))} disabled={busy} /> : null}
        {p.status === 'approved' && canReview ? <Btn small title={t('arp.btn.issue')} onPress={() => run(() => api.post(`${base}/issue`), 'arp.toast.issued')} disabled={busy} /> : null}
      </View>
      {p.status === 'in_review' && canReview ? (
        mine ? <T size={13} color={c.mute}>{t('arp.rv.not_yours')}</T> : (
          <Panel>
            <Field label={t('arp.f.note')} value={note} onChangeText={setNote} multiline />
            {gaps.length ? <Chip label={t('arp.f.ack')} active={ack} onPress={() => setAck(!ack)} /> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Btn small title={t('arp.btn.approve')} onPress={() => run(() => api.post(`${base}/review`, { decision: 'approve', acknowledge_gaps: ack || undefined, note: note || undefined }), 'arp.toast.approved')} disabled={busy || (gaps.length > 0 && !ack)} />
              <Btn small title={t('arp.btn.changes')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`${base}/review`, { decision: 'request_changes', note }), 'arp.toast.sent_back')} disabled={busy || !note.trim()} />
            </View>
          </Panel>
        )
      ) : null}
      {p.status === 'issued' && canReview ? (
        <Panel>
          <Field label={t('arp.f.reason')} value={note} onChangeText={setNote} multiline />
          <Btn small title={t('arp.btn.revoke')} color={c.red} onPress={() => run(() => api.post(`${base}/revoke`, { reason: note }), 'arp.toast.revoked')} disabled={busy || note.trim().length < 5} />
        </Panel>
      ) : null}
    </View>
  );
}

const lineOf = (p) => `${when(p.period_from)} – ${when(p.period_to)} · ${t('arp.version', { n: p.version })}`;

export function ReportsDesk({ o, role, toast }) {
  const me = useSession().user?.id;
  const { tablet } = useLayout();
  const [tab, setTab] = useState('packs'), [open, setOpen] = useState(null), [sheet, setSheet] = useState(null);
  const hub = useLoad(() => api.get(`/organisations/${o.id}/academy/report-hub`), [o.id]);
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/report-packs`, { limit: 100 }), [o.id]);
  const sched = useLoad(() => (role === 'owner' || role === 'admin' || role === 'finance' ? api.get(`/organisations/${o.id}/academy/report-schedules`) : Promise.resolve([])), [o.id, role]);
  const refresh = () => { hub.reload(); list.reload(); sched.reload(); };
  if (hub.error) return <LoadError error={hub.error} onRetry={hub.reload} />;
  if (!hub.data || !list.data) return <Loading />;
  const h = hub.data, f = h.figures, packs = list.data;
  const queue = packs.filter((p) => ['draft', 'in_review', 'approved'].includes(p.status)), issued = packs.filter((p) => ['issued', 'revoked'].includes(p.status));
  const TABS = [['packs', t('arp.tab.packs')], ['queue', t('arp.tab.queue')], ['schedules', t('arp.tab.schedules')], ['issued', t('arp.tab.issued')]].filter(([k]) => k !== 'schedules' || h.my_role !== 'coach');
  const packRow = (p) => <Row key={p.id} title={`${t(`arp.kind.${p.kind}`)}${p.version > 1 ? ` · v${p.version}` : ''}`} sub={lineOf(p)} right={<StatusTag status={p.status} />} onPress={() => setOpen(p.id)} />;
  const list_ = (
    <View style={{ gap: 12 }}>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('arp.title')}</T><T color={c.mute}>{t('arp.subtitle')}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{TABS.map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('arp.k.awaiting')} value={f.awaiting_review} sub={f.overdue ? t('arp.k.overdue', { n: f.overdue }) : undefined} tone={f.overdue ? 'alert' : undefined} />
        <Kpi label={t('arp.k.issued')} value={f.issued_90d} />
        <Kpi label={t('arp.k.scheduled')} value={f.scheduled} sub={f.next_scheduled_on ? t('arp.k.next', { date: when(f.next_scheduled_on) }) : undefined} />
        <Kpi label={t('arp.k.revoked')} value={f.revoked} sub={t('arp.k.history_kept')} />
      </View>
      {tab === 'packs' ? h.kinds.map((k) => (
        <Panel key={k.kind}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{t(`arp.kind.${k.kind}`)}</T><Tag label={t(`arp.scope.${k.scope}`)} color={c.pinkSoft} /></View>
          <T size={12} color={c.mute}>{t(`arp.aud.${k.kind}`)}</T>
          <T size={12} color={c.mute}>{t('arp.templates', { n: k.templates })}</T>
          {k.can_draft ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Btn small title={t('arp.btn.draft')} onPress={() => setSheet({ kind: k.kind, mode: 'draft' })} /><Btn small title={t('arp.btn.schedule')} color={c.paper} ink={c.ink} onPress={() => setSheet({ kind: k.kind, mode: 'schedule' })} /></View> : <T size={12} color={c.mute}>{t('arp.locked')}</T>}
        </Panel>
      )) : null}
      {tab === 'queue' ? (queue.length ? queue.map(packRow) : <Empty emoji="📋" title={t('arp.queue.empty.title')} sub={t('arp.queue.empty.body')} />) : null}
      {tab === 'issued' ? (issued.length ? issued.map(packRow) : <Empty emoji="📄" title={t('arp.issued.empty.title')} sub={t('arp.issued.empty.body')} />) : null}
      {tab === 'schedules' ? (sched.data?.length ? sched.data.map((s) => (
        <Row key={s.id} title={t(`arp.kind.${s.kind}`)} sub={t('arp.sched.line', { cadence: t(`arp.cad.${s.cadence}`), date: when(s.next_run_on) })} right={s.paused_at ? <Tag label={t('arp.sched.paused')} color={c.sun} /> : <StatusTag status="active" />}
          onPress={async () => { await api.patch(`/organisations/${o.id}/academy/report-schedules/${s.id}`, { row_version: s.row_version, paused: !s.paused_at }).catch((e) => toast?.(e.message)); refresh(); }} />
      )) : <Empty emoji="🗓️" title={t('arp.sched.empty.title')} sub={t('arp.sched.empty.body')} />) : null}
    </View>
  );
  return (
    <>
      <Split list={list_} open={!!open} onClose={() => setOpen(null)} detailTitle={t('arp.rv.title')}
        detail={open ? <PackDetail key={open} o={o} packId={open} canReview={h.can_review} me={me} toast={toast} onChanged={refresh} /> : null} />
      {sheet ? <DraftSheet o={o} kind={sheet.kind} mode={sheet.mode} open onClose={() => setSheet(null)} toast={toast} onDone={(r) => { refresh(); if (r) { setOpen(r.id); setTab('queue'); } }} /> : null}
    </>
  );
}

/** The family / athlete side: issued academy reports for one athlete, with a secure open link. Only issued or withdrawn athlete reports ever appear here. */
export function FamilyReports({ athleteId }) {
  const q = useLoad(() => api.get('/academy/reports', athleteId ? { athlete_id: athleteId } : undefined), [athleteId]);
  const [err, setErr] = useState(null);
  if (q.error) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  if (!q.data.length) return <Panel><T weight="800" size={15}>{t('arp.my.title')}</T><T size={13} color={c.mute}>{t('arp.my.empty')}</T></Panel>;
  return (
    <Panel>
      <T weight="800" size={15}>{t('arp.my.title')}</T>
      {q.data.map((r) => (
        <Row key={r.id} title={t(`arp.kind.${r.kind}`)} sub={r.status === 'revoked' ? t('arp.my.withdrawn') : `${when(r.period_from)} – ${when(r.period_to)}`} right={<StatusTag status={r.status} />}
          onPress={r.url ? async () => { try { setErr(null); await openProtected(`/branded-documents/${r.url.split('/branded-documents/')[1]}`, 'report'); } catch (e) { setErr(e.message); } } : undefined} />
      ))}
      {err ? <T size={13} color={c.red}>{err}</T> : null}
    </Panel>
  );
}
