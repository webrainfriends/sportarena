// Governing body administration (#574, extends #475): the Compliance tab of the federation workspace. Three views of the same canonical records:
// who is in good standing / at risk / non-compliant, the exceptions waiting for a compliance review, and renewal campaigns. Every rule (who may review, who may
// invite, what counts as at risk) is enforced by the API; controls are hidden for roles that cannot use them.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Empty, Field, Loading, Section, Seg, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError, explain } from '../access';
import { c } from '../theme';
import { StatusTag, Metric, fmtDate, fmtRange, addDaysIso, todayIso } from '../federation-ui';
import { ListCard, Pager } from '../federation-bits';

const PAGE = 20;
const useDebounced = (v, ms = 300) => { const [x, setX] = useState(v); useEffect(() => { const t = setTimeout(() => setX(v), ms); return () => clearTimeout(t); }, [v, ms]); return x; };
const REASON = { suspended: 'Suspended', expired: 'Expired', fee_due: 'Fee due', ending_soon: 'Ends within 30 days, no renewal started', open_exception: 'Open compliance exception' };
const STATE = { unreviewed: ['Needs review', 'pending'], remedy_required: ['Fix required', 'needs_info'], accepted: ['Accepted', 'approved'], remedied: ['Fixed', 'approved'] };
const OUTCOME = { renewed: 'Renewed', in_progress: 'Renewing', waiting: 'Waiting', lapsed: 'Lapsed' };
const CAMP = { draft: 'draft', sent: 'submitted', closed: 'ended' };
const TYPE = { affiliation: 'affiliation', licence: 'licence', sanction: 'sanction' };

function Standing({ id, below, go }) {
  const { push } = useNav();
  const [kind, setKind] = useState('affiliation');
  const [standing, setStanding] = useState(null);
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useDebounced(text.trim());
  const reg = useLoad(() => api.get(`/federation/bodies/${id}/compliance`, { kind, include_descendants: below, standing: standing || undefined, q: q || undefined, limit: PAGE, offset }), [id, kind, below, standing, q, offset]);
  const d = reg.data;
  const reset = (fn) => (v) => { fn(v); setOffset(0); };
  return (
    <View style={{ gap: 10 }}>
      <Seg options={[{ value: 'affiliation', label: 'Clubs' }, { value: 'licence', label: 'Licence holders' }]} value={kind} onChange={reset(setKind)} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={d?.counts.good_standing ?? '–'} label="Good standing" onPress={() => reset(setStanding)(standing === 'good_standing' ? null : 'good_standing')} />
        <Metric value={d?.counts.at_risk ?? '–'} label="At risk" tone={d?.counts.at_risk ? c.sunSoft : undefined} onPress={() => reset(setStanding)(standing === 'at_risk' ? null : 'at_risk')} />
        <Metric value={d?.counts.non_compliant ?? '–'} label="Non-compliant" tone={d?.counts.non_compliant ? c.orangeSoft : undefined} onPress={() => reset(setStanding)(standing === 'non_compliant' ? null : 'non_compliant')} />
      </View>
      <Field value={text} onChangeText={reset(setText)} placeholder={kind === 'affiliation' ? 'Search by club or number' : 'Search by name or licence number'} accessibilityLabel="Search the compliance register" />
      <Seg options={[{ value: null, label: 'All' }, { value: 'at_risk', label: 'At risk' }, { value: 'non_compliant', label: 'Non-compliant' }, { value: 'good_standing', label: 'Good standing' }]} value={standing} onChange={reset(setStanding)} />
      {reg.error ? <LoadError error={reg.error} onRetry={reg.reload} /> : !d ? <Loading /> : (
        <>
          {d.items.length ? d.items.map((r) => (
            <ListCard key={r.id} title={r.label} sub={`${r.sub}${r.sport_name ? ` · ${r.sport_name}` : ''}${below ? ` · ${r.body_name}` : ''}`}
              sub2={[r.number, r.ends_on ? `ends ${fmtDate(r.ends_on)}` : null, ...r.reasons.map((x) => REASON[x])].filter(Boolean).join(' · ')}
              status={r.standing} statusLabel={r.standing === 'at_risk' ? 'At risk' : r.standing === 'non_compliant' ? 'Non-compliant' : undefined}
              tone={r.standing === 'non_compliant' ? c.orangeSoft : r.standing === 'at_risk' ? c.sunSoft : undefined}
              onPress={() => push('FederationRecord', { type: kind, id: r.id })} />))
            : <Empty emoji="🛡️" title={standing || q ? 'Nothing matches' : kind === 'affiliation' ? 'No affiliated clubs yet' : 'No licence holders yet'} sub={standing || q ? 'Try removing a filter.' : 'Standing appears here once records are approved.'} />}
          <Pager total={d.total} offset={offset} limit={PAGE} onOffset={setOffset} busy={reg.loading} />
        </>)}
    </View>
  );
}

function Exceptions({ id, below, me, reloadHome }) {
  const { push } = useNav();
  const [open, setOpen] = useState(true);
  const [offset, setOffset] = useState(0);
  const [review, setReview] = useState(null);
  const list = useLoad(() => api.get(`/federation/bodies/${id}/exceptions`, { include_descendants: below, open, limit: PAGE, offset }), [id, below, open, offset]);
  const d = list.data;
  const fields = review ? [
    { key: 'resolution', label: 'Decision', type: 'chips', options: [{ value: 'accepted', label: 'Accept it' }, { value: 'remedy_required', label: 'Require a fix' }, ...(review.state === 'remedy_required' ? [{ value: 'remedied', label: 'Fix confirmed' }] : [])] },
    { key: 'due_on', label: 'Fix due by', type: 'date', show: (v) => v.resolution === 'remedy_required' },
    { key: 'note', label: 'Note for the record', multiline: true, hint: 'Why it is accepted, what must be fixed, or what confirmed the fix.' },
  ] : [];
  return (
    <View style={{ gap: 10 }}>
      <Seg options={[{ value: true, label: 'Open' }, { value: false, label: 'All reviewed and open' }]} value={open} onChange={(v) => { setOpen(v); setOffset(0); }} />
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !d ? <Loading /> : (
        <>
          <T size={12} color={c.mute} accessibilityLiveRegion="polite">{d.total} exception{d.total === 1 ? '' : 's'}{open ? (d.total === 1 ? ' needs attention' : ' need attention') : ''}</T>
          {d.items.length ? d.items.map((e) => (
            <ListCard key={`${e.type}${e.id}${e.kind}`} title={e.label} sub={e.reason}
              sub2={[e.kind === 'event_moved' ? 'Event moved' : 'Approved over a failed requirement', e.by, e.at ? fmtDate(e.at) : null, e.due_on ? `fix due ${fmtDate(e.due_on)}` : null, e.review_note ? `Review: ${e.review_note}` : null].filter(Boolean).join(' · ')}
              status={STATE[e.state][1]} statusLabel={STATE[e.state][0]} tone={e.state === 'unreviewed' ? c.orangeSoft : undefined}
              right={me.can.compliance && (e.state === 'unreviewed' || e.state === 'remedy_required') ? <Btn small title="Review" color={c.pink} onPress={() => setReview(e)} accessibilityLabel={`Review the exception for ${e.label}`} /> : undefined}
              onPress={() => push('FederationRecord', { type: TYPE[e.type], id: e.id })} />))
            : <Empty emoji="🛡️" title={open ? 'No open exceptions' : 'No exceptions'} sub="Every decision met the body's published requirements, or has been reviewed." />}
          <Pager total={d.total} offset={offset} limit={PAGE} onOffset={setOffset} busy={list.loading} />
        </>)}
      <FormSheet visible={!!review} onClose={() => setReview(null)} title={review ? `Review: ${review.label}` : ''} submitLabel="Record review" fields={fields} initial={{ resolution: 'accepted' }}
        onSubmit={async (v) => {
          await api.post(`/federation/bodies/${id}/exceptions/review`, { subject_type: review.type, subject_id: review.id, resolution: v.resolution, note: v.note, due_on: v.resolution === 'remedy_required' ? v.due_on : undefined });
          list.reload(); reloadHome(); return 'Review recorded';
        }} />
    </View>
  );
}

function Campaigns({ id, below, me }) {
  const { toast } = useSession();
  const { push } = useNav();
  const body = useLoad(() => api.get(`/federation/bodies/${id}`), [id]);
  const [offset, setOffset] = useState(0);
  const [add, setAdd] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const list = useLoad(() => api.get(`/federation/bodies/${id}/campaigns`, { limit: PAGE, offset }), [id, offset]);
  const d = list.data;
  const sports = body.data?.sports ?? [];
  const act = async (fn, done) => { setBusy(true); try { await fn(); toast(done); list.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); setConfirm(null); } };
  const fields = [
    { key: 'name', label: 'Campaign name', hint: 'e.g. 2027 affiliation renewals' },
    { key: 'kind', label: 'Who to invite', type: 'chips', options: [{ value: 'affiliation', label: 'Affiliated clubs' }, { value: 'licence', label: 'Licence holders' }] },
    ...(sports.length > 1 ? [{ key: 'sport_id', label: 'Only one sport (optional)', type: 'chips', options: sports.map((s) => ({ value: s.sport_id, label: s.sport_name })), optional: true }] : []),
    { key: 'ends_from', label: 'Running out between', type: 'daterange', toKey: 'ends_to', hint: 'Records whose end date falls in these dates are invited. Ones already renewing are skipped.' },
    { key: 'message', label: 'Message (optional)', multiline: true, optional: true },
  ];
  return (
    <View style={{ gap: 10 }}>
      <Section title="Renewal campaigns" color={c.sun} action={list.data?.can_manage ? 'New campaign' : undefined} onAction={() => setAdd(true)}>
        {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !d ? <Loading /> : d.items.length ? d.items.map((k) => (
          <Card key={k.id} color={c.paper} pad={14} onPress={() => setOpen(k)} accessibilityLabel={`${k.name}. ${k.status}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <T weight="700" size={15}>{k.name}</T>
                <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{k.kind === 'affiliation' ? 'Clubs' : 'Licence holders'}{k.sport_name ? ` · ${k.sport_name}` : ''} · ending {fmtRange(k.ends_from, k.ends_to)}</T>
                <T size={12} color={c.mute} style={{ marginTop: 1 }}>
                  {k.status === 'draft' ? `Would invite ${k.would_invite}` : `Invited ${k.stats.invited} · renewed ${k.stats.renewed} · renewing ${k.stats.in_progress} · waiting ${k.stats.waiting} · lapsed ${k.stats.lapsed}`}
                </T>
              </View>
              <StatusTag status={CAMP[k.status]} label={k.status === 'draft' ? 'Draft' : k.status === 'sent' ? 'Sent' : 'Closed'} />
            </View>
            {d.can_manage && k.status !== 'closed' ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                {k.status === 'draft' ? <Btn small title={`Send to ${k.would_invite}`} color={c.pink} disabled={!k.would_invite} onPress={() => setConfirm({ camp: k, action: 'send' })} accessibilityLabel={`Send ${k.name}`} /> : null}
                {k.status === 'sent' ? <Btn small title="Close campaign" color={c.paper} ink={c.ink} onPress={() => setConfirm({ camp: k, action: 'close' })} accessibilityLabel={`Close ${k.name}`} /> : null}
              </View>) : null}
          </Card>))
          : <Empty emoji="📣" title="No renewal campaigns yet" sub={d.can_manage ? 'Invite the clubs or licence holders whose records run out soon to renew, and watch who does.' : 'Campaigns your registrar or licensing officer runs appear here.'} />}
        <Pager total={d?.total ?? 0} offset={offset} limit={PAGE} onOffset={setOffset} busy={list.loading} />
      </Section>

      <FormSheet visible={add} onClose={() => setAdd(false)} title="New renewal campaign" submitLabel="Create draft" fields={fields} initial={{ kind: 'affiliation', ends_from: todayIso(), ends_to: addDaysIso(todayIso(), 60) }}
        onSubmit={async (v) => { await api.post(`/federation/bodies/${id}/campaigns`, { name: v.name, kind: v.kind, sport_id: v.sport_id || undefined, ends_from: v.ends_from, ends_to: v.ends_to, message: v.message || undefined }); list.reload(); return 'Draft created. Check who it would invite, then send it.'; }} />

      <Sheet visible={!!confirm} onClose={() => setConfirm(null)} title={confirm?.action === 'send' ? 'Send this campaign?' : 'Close this campaign?'}>
        <View style={{ gap: 12 }}>
          <T size={13} color={c.mute}>{confirm?.action === 'send'
            ? `${confirm?.camp.would_invite} ${confirm?.camp.kind === 'affiliation' ? 'club' : 'licence holder'}${confirm?.camp.would_invite === 1 ? '' : 's'} will be told it is time to renew. A campaign is sent once and cannot be recalled.`
            : 'Closing marks the campaign as finished. Who was invited and what became of it stays on record.'}</T>
          <Btn title={confirm?.action === 'send' ? 'Send now' : 'Close campaign'} color={c.pink} loading={busy}
            onPress={() => act(() => api.post(`/federation/campaigns/${confirm.camp.id}/${confirm.action}`), confirm.action === 'send' ? 'Campaign sent' : 'Campaign closed')} />
        </View>
      </Sheet>

      <CampaignDetail camp={open} onClose={() => setOpen(null)} push={push} />
    </View>
  );
}

function CampaignDetail({ camp, onClose, push }) {
  const [outcome, setOutcome] = useState(null);
  const [offset, setOffset] = useState(0);
  const one = useLoad(() => (camp && camp.status !== 'draft' ? api.get(`/federation/campaigns/${camp.id}`, { outcome: outcome || undefined, limit: PAGE, offset }) : Promise.resolve(null)), [camp?.id, outcome, offset]);
  return (
    <Sheet visible={!!camp} onClose={() => { setOutcome(null); setOffset(0); onClose(); }} title={camp?.name ?? ''}>
      <View style={{ gap: 10 }}>
        {camp?.message ? <T size={13} color={c.mute}>“{camp.message}”</T> : null}
        {camp?.status === 'draft' ? <T size={13}>Not sent yet. It would invite {camp.would_invite}.</T> : !one.data ? <Loading /> : (
          <>
            <Seg options={[{ value: null, label: 'All' }, ...Object.entries(OUTCOME).map(([value, label]) => ({ value, label }))]} value={outcome} onChange={(v) => { setOutcome(v); setOffset(0); }} />
            {one.data.items.length ? one.data.items.map((t) => (
              <ListCard key={t.subject_id} title={t.label} sub={`${t.sub} · ${t.number} · ends ${fmtDate(t.ends_on)}`} status={t.outcome === 'renewed' ? 'approved' : t.outcome === 'lapsed' ? 'expired' : t.outcome === 'in_progress' ? 'under_review' : 'pending'} statusLabel={OUTCOME[t.outcome]}
                onPress={() => { onClose(); push('FederationRecord', { type: camp.kind, id: t.renewal_id ?? t.subject_id }); }} />))
              : <Empty emoji="📭" title="Nobody in this view" />}
            <Pager total={one.data.total} offset={offset} limit={PAGE} onOffset={setOffset} busy={one.loading} />
          </>)}
      </View>
    </Sheet>
  );
}

export function ComplianceTab({ id, below, me, reloadHome, preset }) {
  const [view, setView] = useState(preset?.view ?? 'standing');
  return (
    <View style={{ gap: 10 }}>
      <Seg options={[{ value: 'standing', label: 'Standing' }, { value: 'exceptions', label: 'Exceptions' }, { value: 'campaigns', label: 'Renewal campaigns' }]} value={view} onChange={setView} />
      {view === 'standing' ? <Standing id={id} below={below} /> : null}
      {view === 'exceptions' ? <Exceptions id={id} below={below} me={me} reloadHome={reloadHome} /> : null}
      {view === 'campaigns' ? <Campaigns id={id} below={below} me={me} /> : null}
    </View>
  );
}
