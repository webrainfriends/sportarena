// Agreements, billing, announcements and academy settings.
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { Block, Kpi, opts, when } from './academy-ui';

const KINDS = [['participation', 'Participation terms'], ['code_of_conduct', 'Code of conduct'], ['refund_policy', 'Refund policy'], ['media_consent', 'Media consent'], ['equipment', 'Equipment'], ['pickup', 'Pick-up'], ['programme_declaration', 'Programme declaration'], ['other', 'Other']];
const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;

export function Agreements({ o, archived }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/policies`), [o.id]);
  const [make, setMake] = useState(false), [rev, setRev] = useState(null), [read, setRead] = useState(null);
  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <Block title="Agreements & policies" right={!archived ? <Btn small title="＋ New agreement" onPress={() => setMake(true)} /> : null}>
          <T size={12} color={c.mute}>Families acknowledge the exact version they read; it records who agreed, for whom, when and which version. It is an acknowledgement, not a legal e-signature. Published text is never edited: a new version replaces it.</T>
          {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((p) => (
            <Row key={p.id} title={p.title} sub={`${KINDS.find(([k]) => k === p.kind)?.[1] ?? p.kind} · version ${p.current_version} · published ${when(p.published_at)}${p.requires_reconsent ? ' · everyone re-agrees' : ''}`} right={<Tag label={`v${p.current_version}`} />} onPress={() => setRead(p)} />
          )) : <Empty emoji="📜" title="No agreements yet" sub="Add the terms families accept before joining, then require them on a programme." />}
        </Block>
      </Panel>
      {read ? (
        <Panel>
          <Block title={`${read.title} · v${read.current_version}`} right={<Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => setRead(null)} />}>
            <T size={14}>{read.body}</T>
            <T size={11} color={c.mute}>Fingerprint {read.body_sha256.slice(0, 16)}…</T>
            {!archived ? <Btn small title="Publish a new version" color={c.paper} ink={c.ink} onPress={() => setRev(read)} style={{ alignSelf: 'flex-start' }} /> : null}
          </Block>
        </Panel>
      ) : null}
      <FormSheet visible={make} onClose={() => setMake(false)} title="New agreement" submitLabel="Publish"
        fields={[{ key: 'kind', label: 'Type', type: 'chips', options: opts(KINDS) }, { key: 'title', label: 'Title' }, { key: 'body', label: 'Text people will read', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/policies`, v); list.reload(); return 'Published'; }} />
      <FormSheet visible={!!rev} onClose={() => setRev(null)} title={`New version · ${rev?.title ?? ''}`} submitLabel="Publish version" initial={{ body: rev?.body ?? '' }}
        fields={[{ key: 'body', label: 'Updated text', type: 'multiline' }, { key: 'requires_reconsent', label: 'Everyone must agree again', type: 'switch', hint: 'Off: people who agreed to an earlier version stay agreed.' }]}
        onSubmit={async (v) => { await api.post(`/policies/${rev.id}/versions`, v); setRead(null); list.reload(); return 'New version published'; }} />
    </View>
  );
}

export function Billing({ o, archived }) {
  const [status, setStatus] = useState('awaiting_payment'), [overdue, setOverdue] = useState(false);
  const dash = useLoad(() => api.get(`/organisations/${o.id}/academy/dashboard`), [o.id]);
  const list = useLoad(() => api.get(`/organisations/${o.id}/charges`, { status, overdue: overdue || undefined, limit: 100 }), [o.id, status, overdue]);
  const [fund, setFund] = useState(null), [refund, setRefund] = useState(null);
  const deals = useLoad(() => api.get(`/organisations/${o.id}/academy/partners`).then((p) => p.sponsorship.filter((x) => x.status === 'active')).catch(() => []), [o.id]);
  const money = dash.data?.money?.by_currency ?? [];
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {money.map((m) => <Kpi key={m.currency} label={`${m.currency} outstanding`} value={moneyIn(m.outstanding_minor, m.currency)} sub={`billed ${moneyIn(m.billed_minor, m.currency)} · paid ${moneyIn(m.paid_minor, m.currency)}`} tone={Number(m.overdue_minor) ? 'alert' : undefined} />)}
        {money.map((m) => <Kpi key={`o${m.currency}`} label={`${m.currency} overdue`} value={moneyIn(m.overdue_minor, m.currency)} sub={`due in 14 days ${moneyIn(m.due_14d_minor, m.currency)}`} tone={Number(m.overdue_minor) ? 'alert' : undefined} />)}
        {!money.length ? <Kpi label="Fees" value="–" sub="Nothing billed yet" /> : null}
      </View>
      <Panel>
        <Block title="Tuition & fees">
          <T size={11} color={c.mute}>Each row is the snapshot taken at enrolment. Currencies are never added together. “Paid” means the customer paid; it does not mean the academy has been paid out.</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {[['awaiting_payment', 'Unpaid'], ['paid', 'Paid'], ['waived', 'Waived'], ['refunded', 'Refunded'], ['cancelled', 'Cancelled']].map(([v, l]) => <Chip key={v} label={l} active={status === v && !overdue} onPress={() => { setStatus(v); setOverdue(false); }} />)}
            <Chip label="⚠️ Overdue only" active={overdue} onPress={() => { setStatus('awaiting_payment'); setOverdue(!overdue); }} />
          </ScrollView>
          {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((ch) => (
            <Row key={ch.id} title={`${ch.display_name} · ${ch.kind}`} sub={`${moneyIn(ch.amount_minor, ch.currency)} · due ${when(ch.due_on)}${ch.funded_minor > 0 ? ` · ${moneyIn(ch.funded_minor, ch.currency)} ${ch.funding_source}-funded` : ''}${ch.discount_minor > 0 ? ` · ${moneyIn(ch.discount_minor, ch.currency)} discount` : ''}${ch.paid_at ? ` · paid ${when(ch.paid_at)}` : ''}`}
              right={ch.overdue ? <Tag label="Overdue" color={c.orangeSoft} /> : <Tag label={ch.status.replace('_', ' ')} color={ch.status === 'paid' ? c.lime : undefined} />} onPress={archived ? undefined : () => (ch.status === 'awaiting_payment' ? setFund(ch) : ch.status === 'paid' ? setRefund(ch) : undefined)} />
          )) : <Empty emoji="💷" title="Nothing here" sub="Fees appear when someone enrols in a priced programme." />}
          <T size={11} color={c.mute}>Tap an unpaid charge to record a scholarship, bursary or sponsor-funded amount, or a paid one to refund.</T>
        </Block>
      </Panel>
      <FormSheet visible={!!fund} onClose={() => setFund(null)} title="Scholarship or funding" submitLabel="Apply funding" initial={{ funding_source: 'scholarship' }}
        fields={[{ key: 'funding_source', label: 'Funded by', type: 'chips', options: [{ value: 'scholarship', label: 'Scholarship' }, { value: 'bursary', label: 'Bursary' }, { value: 'sponsor', label: 'Sponsor' }] },
          { key: 'sponsorship_id', label: 'Sponsorship agreement', type: 'entity', entityKind: 'sponsorship', noun: 'agreement', options: (deals.data ?? []).map((x) => ({ id: x.sponsorship_id, label: x.sponsor, sub: x.target_type === 'group' ? 'supports a group' : 'supports the academy' })), show: (v) => v.funding_source === 'sponsor' },
          { key: 'funded_minor', label: 'Funded amount', type: 'money', currency: () => fund?.currency ?? 'GBP' }, { key: 'funding_ref', label: 'Reference', optional: true, hint: 'The price is not edited: the funded part is recorded as its own source.' }]}
        onSubmit={async (v) => { await api.post(`/academy-charges/${fund.id}/funding`, v); list.reload(); dash.reload(); return 'Funding recorded'; }} />
      <FormSheet visible={!!refund} onClose={() => setRefund(null)} title="Refund this payment" submitLabel="Refund"
        fields={[{ key: 'amount_minor', label: 'Amount (empty = all)', type: 'money', currency: () => refund?.currency ?? 'GBP', optional: true }]}
        onSubmit={async (v) => { const r = await api.post(`/academy-charges/${refund.id}/refund`, { ...v, idempotency_key: `refund-${refund.id.slice(0, 8)}-${Date.now()}` }); list.reload(); dash.reload(); return `Refunded ${moneyIn(r.refunded_minor, r.currency)}`; }} />
    </View>
  );
}

export function Announcements({ o, archived }) {
  const hist = useLoad(() => api.get(`/organisations/${o.id}/academy/announcements`), [o.id]);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 }), [o.id]);
  const [compose, setCompose] = useState(false);
  const GROUPS = [['enrolled', 'Enrolled athletes'], ['waitlisted', 'Waitlist'], ['offered', 'Offers pending'], ['submitted', 'Applicants']];
  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <Block title="Announcements" right={!archived ? <Btn small title="＋ New announcement" onPress={() => setCompose(true)} /> : null}>
          <T size={12} color={c.mute}>Goes to the athlete, or to their guardians for a young person, once each, through the shared notification delivery. Messages open the app; details are never in the preview.</T>
          {hist.error ? <ErrorBox error={hist.error} onRetry={hist.reload} /> : !hist.data ? <Loading /> : hist.data.length ? hist.data.map((n) => <Row key={n.id} title={n.title} sub={`${n.body.slice(0, 90)}${n.body.length > 90 ? '…' : ''} · ${n.programme ?? 'All programmes'} · ${n.audience} people · ${when(n.created_at)}`} />) : <Empty emoji="📣" title="Nothing sent yet" sub="Tell a programme's families about a change, a reminder or good news." />}
        </Block>
      </Panel>
      <FormSheet visible={compose} onClose={() => setCompose(false)} title="New announcement" submitLabel="Send" initial={{ stages: ['enrolled'] }}
        fields={[
          { key: 'programme_id', label: 'Programme', type: 'chips', optional: true, options: (progs.data ?? []).filter((p) => p.status !== 'archived').map((p) => ({ value: p.id, label: p.title })), hint: 'Leave empty for every programme.' },
          { key: 'stages', label: 'Who', type: 'multi', options: GROUPS.map(([value, label]) => ({ value, label })) },
          { key: 'title', label: 'Title' }, { key: 'body', label: 'Message', type: 'multiline', hint: 'Up to 500 characters. Do not include personal or health details.' }]}
        onSubmit={async (v) => {
          const stages = v.stages.flatMap((s) => (s === 'offered' ? ['offered', 'offer_accepted'] : s === 'submitted' ? ['submitted', 'under_review'] : [s]));
          const body = { ...v, stages, idempotency_key: `ann-${Date.now()}` };
          const preview = await api.post(`/organisations/${o.id}/announcements`, { ...body, dry_run: true });
          if (!preview.audience) throw new Error('No one matches that audience');
          await api.post(`/organisations/${o.id}/announcements`, body); hist.reload(); return `Sending to ${preview.audience} ${preview.audience === 1 ? 'person' : 'people'}`;
        }} />
    </View>
  );
}

export function Settings({ o, archived }) {
  const prof = useLoad(() => api.get(`/organisations/${o.id}/academy`), [o.id]);
  const [edit, setEdit] = useState(false);
  if (prof.error) return <ErrorBox error={prof.error} onRetry={prof.reload} />;
  if (!prof.data) return <Loading />;
  const p = prof.data;
  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <Block title="Academy profile" right={!archived ? <Btn small title="Edit" onPress={() => setEdit(true)} /> : null}>
          {[['Legal / trading name', p.legal_name], ['Sports', (p.sports ?? []).join(', ')], ['Focus', p.focus], ['Ages', p.age_min != null ? `${p.age_min}–${p.age_max ?? '+'}` : null], ['Currency', p.currency], ['Timezone', p.timezone], ['Preferred contact', p.contact_channel], ['Policies page', p.policy_url]].map(([k, v]) => v ? <View key={k} style={{ flexDirection: 'row', gap: 8 }}><T size={13} color={c.mute} style={{ width: 140 }}>{k}</T><T size={13} weight="700" style={{ flex: 1 }}>{String(v)}</T></View> : null)}
          <Tag label={p.listed ? 'Listed in programme discovery' : 'Not listed'} color={p.listed ? c.lime : c.orangeSoft} />
          {!p.row_version ? <T size={13} color={c.mute}>Set your academy profile so families can find your published programmes.</T> : null}
        </Block>
      </Panel>
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Academy profile" initial={p}
        fields={[
          { key: 'legal_name', label: 'Legal / trading name', optional: true }, { key: 'sports', label: 'Sports offered', type: 'sports', optional: true },
          { key: 'focus', label: 'Focus', type: 'chips', options: [{ value: 'recreational', label: 'Recreational' }, { value: 'development', label: 'Development' }, { value: 'elite', label: 'Elite' }, { value: 'mixed', label: 'Mixed' }] },
          { key: 'age_min', label: 'Youngest age', type: 'stepper', min: 0, max: 99, optional: true }, { key: 'age_max', label: 'Oldest age', type: 'stepper', min: 0, max: 99, optional: true },
          { key: 'currency', label: 'Currency', type: 'currency' }, { key: 'timezone', label: 'Timezone', type: 'timezone', optional: true },
          { key: 'contact_channel', label: 'Preferred contact', type: 'chips', optional: true, options: [{ value: 'platform', label: 'In the app' }, { value: 'email', label: 'Email' }, { value: 'phone', label: 'Phone' }] },
          { key: 'policy_url', label: 'Policies web page', input: 'url', optional: true }, { key: 'listed', label: 'List in programme discovery', type: 'switch', hint: 'Only published programmes marked public are shown.' }]}
        onSubmit={async (v) => { await api.patch(`/organisations/${o.id}/academy`, { ...v, row_version: p.row_version }); prof.reload(); return 'Saved'; }} />
    </View>
  );
}

