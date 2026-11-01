// Federation governance depth (#574): renewal campaigns and the compliance register, both inside Federation Home. They read the canonical affiliations,
// licences and sanctions through the server (which enforces every permission and jurisdiction limit); controls the role cannot use are hidden.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, Loading, Section, Seg, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError, explain } from '../access';
import { c } from '../theme';
import { Banner, History, Metric, StatusTag, fmtDate, fmtRange, addDaysIso, todayIso } from '../federation-ui';
import { Bar, Cols, ListCard, Pager } from '../federation-bits';
import { useNav } from '../nav';

const STATE = { renewed: ['Renewed', 'active'], in_progress: ['Renewal started', 'under_review'], awaiting: ['Waiting', 'pending'], lapsed: ['Lapsed', 'expired'] };
const CAMP_STATUS = { draft: 'draft', running: 'active', closed: 'ended', cancelled: 'cancelled' };
const EXC_LABEL = { open: 'Open', extended: 'Extended', remedied: 'Remedied', accepted: 'Accepted' };
const EXC_TONE = { open: 'pending', extended: 'under_review', remedied: 'active', accepted: 'ended' };
const TYPE_LABEL = { affiliation: 'Affiliation', licence: 'Licence', sanction: 'Sanction' };

// ------------------------------------------------------------------ campaigns
function CampaignForm({ visible, onClose, id, me, edit, onDone }) {
  const cats = useLoad(() => api.get(`/federation/bodies/${id}`), [id]);
  const juris = useLoad(() => api.get(`/federation/bodies/${id}/jurisdictions`), [id]);
  const b = cats.data;
  const [target, setTarget] = useState(edit?.target ?? 'affiliation');
  const [preview, setPreview] = useState(null);
  const kinds = target === 'affiliation' ? (b?.categories ?? []) : (b?.licence_types ?? []);
  const jurOptions = (juris.data ?? []).map((j) => ({ value: j.id, label: j.name, sub: j.level }));
  const allowTarget = [...(me.can.affiliations ? [{ value: 'affiliation', label: 'Affiliations' }] : []), ...(me.can.licences ? [{ value: 'licence', label: 'Licences' }] : [])];
  const shape = (v) => ({ target, category_ids: v.category_ids ?? [], jurisdiction_ids: v.jurisdiction_ids ?? [], ...(v.sport_id ? { sport_id: v.sport_id } : {}), window_from: v.window_from, window_to: v.window_to });
  return (
    <FormSheet visible={visible} onClose={() => { setPreview(null); onClose(); }} title={edit ? 'Change campaign' : 'New renewal campaign'} submitLabel={edit ? 'Save draft' : 'Save as draft'}
      initial={edit ? { name: edit.name, category_ids: edit.category_ids, jurisdiction_ids: edit.jurisdiction_ids, sport_id: edit.sport_id ?? undefined, window_from: edit.window_from, window_to: edit.window_to, reminder_days: edit.reminder_days, message: edit.message ?? '' }
        : { window_from: todayIso(), window_to: addDaysIso(todayIso(), 60) }}
      fields={[
        { key: 'name', label: 'Campaign name', type: 'text' },
        ...(allowTarget.length > 1 ? [{ type: 'custom', key: '_target', render: () => <Seg options={allowTarget} value={target} onChange={(t) => { setTarget(t); setPreview(null); }} /> }] : []),
        { key: 'window_from', toKey: 'window_to', label: 'Records ending between', type: 'daterange', hint: 'Every approved affiliation or active licence whose end date falls in these dates is covered.' },
        { key: 'category_ids', label: target === 'affiliation' ? 'Affiliation categories' : 'Licence types', type: 'multimenu', options: kinds.map((k) => ({ value: k.id, label: k.name })), optional: true, placeholder: 'All' },
        ...(jurOptions.length ? [{ key: 'jurisdiction_ids', label: 'Regions, states and districts', type: 'multimenu', options: jurOptions, optional: true, placeholder: 'All' }] : []),
        ...((b?.sports ?? []).length > 1 ? [{ key: 'sport_id', label: 'Sport', type: 'chips', options: b.sports.map((s) => ({ value: s.sport_id, label: s.sport_name })), optional: true }] : []),
        { key: 'reminder_days', label: 'Remind them this many days before the end date', type: 'multimenu', options: [60, 45, 30, 21, 14, 7, 3, 1].map((d) => ({ value: d, label: `${d} day${d === 1 ? '' : 's'} before` })), default: [30, 14, 7], hint: 'They are also told when the campaign starts, and once more if the record runs out.' },
        { key: 'message', label: 'Message to include (optional)', type: 'multiline', optional: true },
        { type: 'custom', key: '_preview', render: ({ v }) => (
          <View style={{ gap: 6 }}>
            <Btn small title="Count the records this covers" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }}
              onPress={async () => { try { setPreview(await api.post(`/federation/bodies/${id}/campaigns/preview`, shape(v))); } catch (e) { setPreview({ error: explain(e) }); } }} />
            {preview ? <T size={13} color={preview.error ? c.red : c.ink} accessibilityLiveRegion="polite">{preview.error ?? `${preview.records} record${preview.records === 1 ? '' : 's'} would be covered.`}</T> : null}
          </View>) },
      ]}
      onSubmit={async (v) => {
        const body = { ...shape(v), name: v.name, reminder_days: v.reminder_days?.length ? v.reminder_days : [30, 14, 7], ...(v.message ? { message: v.message } : {}), ...(edit ? { campaign_id: edit.id } : {}) };
        await api.post(`/federation/bodies/${id}/campaigns`, body);
        setPreview(null); onDone(); return edit ? 'Draft saved' : 'Campaign saved. Launch it when you are ready.';
      }} />
  );
}

function CampaignDetail({ campaignId, onClose, me, id, onChanged }) {
  const { toast } = useSession();
  const [state, setState] = useState(undefined);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const q = useLoad(() => api.get(`/federation/campaigns/${campaignId}`, { state, limit: 20, offset }), [campaignId, state, offset]);
  const d = q.data;
  const act = async (path, msg, body = {}) => { setBusy(true); try { await api.post(`/federation/campaigns/${campaignId}/${path}`, body); toast(msg); q.reload(); onChanged(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  if (q.error && !d) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!d) return <Loading />;
  const p = d.progress;
  const total = p ? p.renewed + p.in_progress + p.awaiting + p.lapsed : 0;
  return (
    <View style={{ gap: 10 }}>
      <Btn small title="Back to campaigns" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={onClose} />
      <Card color={c.paper}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" size={18} style={{ flex: 1 }} accessibilityRole="header">{d.name}</T><StatusTag status={CAMP_STATUS[d.status]} label={d.status === 'running' ? 'Running' : undefined} /></View>
        <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{d.target === 'affiliation' ? 'Affiliations' : 'Licences'} ending {fmtRange(d.window_from, d.window_to)} · reminders {d.reminder_days.join(', ')} days before</T>
        {p ? (
          <View style={{ gap: 10, marginTop: 12 }}>
            <Bar label="Renewed" value={p.renewed} max={total} sub={total ? `${Math.round((p.renewed / total) * 100)}% of ${total} covered records` : undefined} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <Metric value={p.in_progress} label="Renewal started" /><Metric value={p.awaiting} label="Waiting" /><Metric value={p.lapsed} label="Lapsed" tone={p.lapsed ? c.sunSoft : undefined} />
            </View>
          </View>) : <T size={12.5} color={c.mute} style={{ marginTop: 8 }}>A draft. Nothing is sent until you launch it.</T>}
        {d.can_manage ? (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {d.status === 'draft' ? <Btn small title="Launch" loading={busy} onPress={() => act('launch', 'Campaign launched')} /> : null}
            {d.status === 'draft' ? <Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => setEdit(true)} /> : null}
            {['draft', 'running'].includes(d.status) ? <Btn small title={d.status === 'draft' ? 'Cancel draft' : 'Close campaign'} color={c.paper} ink={c.ink} loading={busy} onPress={() => act('close', d.status === 'draft' ? 'Draft cancelled' : 'Campaign closed')} /> : null}
          </View>) : null}
      </Card>
      {p ? (
        <Section title="Covered records" color={c.cyan}>
          <Seg options={[{ value: '', label: 'All' }, ...Object.entries(STATE).map(([value, [label]]) => ({ value, label }))]} value={state ?? ''} onChange={(v) => { setState(v || undefined); setOffset(0); }} />
          {d.recipients.length ? d.recipients.map((r) => (
            <ListCard key={r.subject_id} title={r.label} sub={`Ends ${fmtDate(r.ends_on)}${r.jurisdiction_name ? ` · ${r.jurisdiction_name}` : ''}`} sub2={r.reminders ? `${r.reminders} notice${r.reminders === 1 ? '' : 's'} sent${r.last_reminded_at ? `, last ${fmtDate(r.last_reminded_at)}` : ''}` : undefined}
              status={STATE[r.state][1]} statusLabel={STATE[r.state][0]} />)) : <Empty emoji="🔁" title="Nothing in this view" />}
          <Pager total={d.total} offset={offset} limit={20} onOffset={setOffset} busy={q.loading} />
        </Section>) : null}
      <History history={d.history} title="Campaign history" />
      <CampaignForm visible={edit} onClose={() => setEdit(false)} id={id} me={me} edit={d} onDone={() => { setEdit(false); q.reload(); onChanged(); }} />
    </View>
  );
}

export function CampaignsTab({ id, me }) {
  const q = useLoad(() => api.get(`/federation/bodies/${id}/campaigns`, { limit: 50 }), [id]);
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState(null);
  const canRun = !me.read_only_via_parent && (me.can.affiliations || me.can.licences);
  if (open) return <CampaignDetail campaignId={open} id={id} me={me} onClose={() => setOpen(null)} onChanged={q.reload} />;
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  return (
    <View style={{ gap: 8 }}>
      <Section title="Renewal campaigns" color={c.sun} action={canRun ? 'New campaign' : undefined} onAction={() => setForm(true)}>
        {q.data.items.length ? q.data.items.map((k) => {
          const p = k.progress, total = p ? p.renewed + p.in_progress + p.awaiting + p.lapsed : 0;
          return <ListCard key={k.id} title={k.name} sub={`${k.target === 'affiliation' ? 'Affiliations' : 'Licences'} ending ${fmtRange(k.window_from, k.window_to)}`}
            sub2={p ? `${total ? Math.round((p.renewed / total) * 100) : 0}% renewed · ${p.renewed} of ${total} · ${p.lapsed} lapsed` : 'Draft — nothing sent yet'} status={CAMP_STATUS[k.status]} statusLabel={k.status === 'running' ? 'Running' : undefined} onPress={() => setOpen(k.id)} />;
        }) : <Empty emoji="🔁" title="No renewal campaign yet" sub={canRun ? 'Start one to remind every club or licence holder whose record is about to end, and watch who renews.' : 'Registrars and licensing officers run these.'} />}
      </Section>
      <CampaignForm visible={form} onClose={() => setForm(false)} id={id} me={me} onDone={() => { setForm(false); q.reload(); }} />
    </View>
  );
}

// ------------------------------------------------------------------ compliance
function ReviewSheet({ exc, onClose, onDone }) {
  return (
    <FormSheet visible={!!exc} onClose={onClose} title="Review exception" submitLabel="Record review" initial={{ outcome: 'remedied', review_due: addDaysIso(todayIso(), 30) }}
      fields={[
        { type: 'custom', key: '_ctx', render: () => <T size={13} color={c.mute}>{exc?.label} · {exc?.reason}</T> },
        { key: 'outcome', label: 'Outcome', type: 'chips', options: [{ value: 'remedied', label: 'Remedied' }, { value: 'extended', label: 'Extend' }, { value: 'accepted', label: 'Accept as is' }], hint: 'Remedied: the requirement is now met. Extend: keep it open to a new date. Accept: a standing, justified exception.' },
        { key: 'review_due', label: 'Next review date', type: 'date', min: addDaysIso(todayIso(), 1), show: (v) => v.outcome === 'extended' },
        { key: 'note', label: 'What did you find? (kept in the history)', type: 'multiline' },
      ]}
      onSubmit={async (v) => { await api.post(`/federation/exceptions/${exc.id}/review`, { outcome: v.outcome, note: v.note, ...(v.outcome === 'extended' ? { review_due: v.review_due } : {}), version: exc.row_version }); onDone(); return 'Review recorded'; }} />
  );
}

export function ComplianceTab({ id, me, below }) {
  const { push } = useNav();
  const [status, setStatus] = useState('open');
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const [review, setReview] = useState(null);
  const standing = useLoad(() => api.get(`/federation/bodies/${id}/compliance`, { include_descendants: below }), [id, below]);
  const list = useLoad(() => api.get(`/federation/bodies/${id}/exceptions`, { status, subject_type: type || undefined, include_descendants: below, limit: 20, offset }), [id, below, status, type, offset]);
  const s = standing.data;
  const reload = () => { standing.reload(); list.reload(); };
  const tiles = useMemo(() => s ? [['affiliations', 'Affiliations', 'affiliation'], ['licences', 'Licences', 'licence'], ['sanctions', 'Sanctions', 'sanction']] : [], [s]);
  if (standing.error && !s) return <LoadError error={standing.error} onRetry={standing.reload} />;
  if (!s) return <Loading />;
  return (
    <View style={{ gap: 8 }}>
      {s.scope.limited_to_jurisdictions ? <Banner tone={c.cyanSoft}>Your role covers some regions only, so you see standing and exceptions for those.</Banner> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {tiles.map(([k, label]) => <Metric key={k} value={s[k].good_standing} label={`${label} in good standing`} sub={`${s[k].in_force} in force · ${s[k].under_exception} under exception · ${s[k].expiring_30} ending in 30 days`} />)}
        <Metric value={s.exceptions.open} label="Open exceptions" tone={s.exceptions.open ? c.sunSoft : undefined} sub={`${s.exceptions.resolved} resolved`} />
        <Metric value={s.exceptions.overdue} label="Review overdue" tone={s.exceptions.overdue ? c.redSoft : undefined} onPress={() => { setStatus('overdue'); setOffset(0); }} />
      </View>
      <Section title="Compliance exceptions" color={c.orange}>
        <Seg options={[{ value: 'open', label: 'Open' }, { value: 'overdue', label: 'Overdue' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]} value={status} onChange={(v) => { setStatus(v); setOffset(0); }} />
        <Seg options={[{ value: '', label: 'Everything' }, { value: 'affiliation', label: 'Affiliations' }, { value: 'licence', label: 'Licences' }, { value: 'sanction', label: 'Sanctions' }]} value={type} onChange={(v) => { setType(v); setOffset(0); }} />
        {list.error && !list.data ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.items.length ? list.data.items.map((e) => (
          <ListCard key={e.id} title={e.label} status={e.overdue ? 'expired' : EXC_TONE[e.status]} statusLabel={e.overdue ? 'Review overdue' : EXC_LABEL[e.status]}
            sub={`${TYPE_LABEL[e.subject_type]} · approved over: ${e.failed.map((f) => f.label).join('; ') || e.reason}`}
            sub2={[e.reason, e.decided_by_name, ['open', 'extended'].includes(e.status) ? `review by ${fmtDate(e.review_due)}` : e.review_note].filter(Boolean).join(' · ')} tone={e.overdue ? c.redSoft : undefined}
            onPress={() => push('FederationRecord', { type: e.subject_type, id: e.subject_id })}
            right={me.can.exceptions && ['open', 'extended'].includes(e.status) && !me.read_only_via_parent ? <Btn small title="Review" onPress={() => setReview(e)} /> : undefined} />))
          : <Empty emoji="🛡️" title="Nothing here" sub="Every decision met its published requirements, or the exceptions in this view are all reviewed." />}
        {list.data ? <Pager total={list.data.total} offset={offset} limit={20} onOffset={setOffset} busy={list.loading} /> : null}
      </Section>
      <ReviewSheet exc={review} onClose={() => setReview(null)} onDone={() => { setReview(null); reload(); }} />
    </View>
  );
}
