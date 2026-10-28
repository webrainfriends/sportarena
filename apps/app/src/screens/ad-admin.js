// Advertising — the platform admin's review desk (#524). Only the two platform-admin accounts can use any of it: the API refuses everyone else with
// 403, and the tabs that lead here are hidden for every other role. Decisions are recorded with a reason and take effect on the next request.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { AdCard } from '../ads';
import { StatusTag } from './ad-ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const REASONS = [['prohibited_category', 'Prohibited category'], ['misleading_claim', 'Misleading claim'], ['unsafe_or_harmful', 'Unsafe or harmful'], ['youth_safety', 'Youth safety'], ['landing_page', 'Landing page'], ['intellectual_property', 'Intellectual property'], ['targeting', 'Targeting'], ['other', 'Other']];
const CLAIMS = [['price', 'Prices or discounts'], ['results', 'Results or rankings'], ['availability', 'Availability or limited offers'], ['endorsement', 'Endorsements or reviews'], ['health', 'Health or fitness outcomes']];
const opt = (a) => a.map(([value, label]) => ({ value, label }));
const when = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function Queue({ onOpen }) {
  const [status, setStatus] = useState('submitted');
  const q = useLoad(() => api.get('/admin/advertising/queue', { status }), [status]);
  return (
    <View style={{ gap: 10, marginTop: 10 }}>
      <Seg options={[{ value: 'submitted', label: `Waiting${q.data && status === 'submitted' ? ` (${q.data.waiting})` : ''}` }, { value: 'approved', label: 'Approved' }, { value: 'active', label: 'Live' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'paused', label: 'Paused' }]} value={status} onChange={setStatus} />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : q.data.campaigns.length ? q.data.campaigns.map((k) => (
        <Row key={k.id} onPress={() => onOpen(k.id)} title={k.name} sub={`${k.advertiser_name} · ${k.category_label} · ${k.starts_on}→${k.ends_on}`} right={<StatusTag s={k.status} held={k.held_by_platform} />} />
      )) : <Empty emoji="✅" title="Nothing here" sub={status === 'submitted' ? 'No campaign is waiting for a decision.' : 'No campaigns in this state.'} />}
    </View>
  );
}

function Reports({ onOpen }) {
  const { toast } = useSession();
  const [status, setStatus] = useState('open');
  const [handle, setHandle] = useState(null);
  const r = useLoad(() => api.get('/admin/advertising/reports', { status }), [status]);
  return (
    <View style={{ gap: 10, marginTop: 10 }}>
      <Seg options={[{ value: 'open', label: 'Open' }, { value: 'actioned', label: 'Actioned' }, { value: 'dismissed', label: 'Dismissed' }]} value={status} onChange={setStatus} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : r.data.length ? r.data.map((x) => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{x.headline}</T><Tag label={x.reason.replace(/_/g, ' ')} color={c.sun} /></View>
          <T size={12} color={c.mute}>{x.campaign} · {when(x.created_at)}</T>
          {x.note ? <T size={13} style={{ marginTop: 4 }}>“{x.note}”</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title="Open campaign" color={c.paper} ink={c.ink} onPress={() => onOpen(x.campaign_id)} />
            {x.status === 'open' ? <Btn small title="Handle" onPress={() => setHandle(x)} /> : <T size={12} color={c.mute}>{x.status}{x.outcome && x.outcome !== 'none' ? ` · ${x.outcome}` : ''}</T>}
          </View>
        </Card>
      )) : <Empty emoji="🛡️" title="No reports" sub="Reports from people who were shown an ad appear here." />}
      <FormSheet visible={!!handle} onClose={() => setHandle(null)} title="Handle report" submitLabel="Save" initial={{ outcome: 'none' }}
        fields={[{ key: 'outcome', label: 'Outcome', type: 'chips', options: [{ value: 'none', label: 'No action' }, { value: 'paused', label: 'Pause the campaign' }, { value: 'withdrawn', label: 'Withdraw the campaign' }] }, { key: 'reason', label: 'Why', optional: true, type: 'multiline', hint: 'Required when you pause or withdraw.' }]}
        onSubmit={async (v) => { await api.post(`/admin/advertising/reports/${handle.id}/handle`, v); r.reload(); return 'Saved'; }} />
    </View>
  );
}

function PolicyTab() {
  const { toast } = useSession();
  const pol = useLoad(() => api.get('/admin/advertising/policy'), []);
  const ov = useLoad(() => api.get('/admin/advertising/overview'), []);
  const [edit, setEdit] = useState(false);
  if ((pol.loading && !pol.data) || (ov.loading && !ov.data)) return <Loading />;
  if (pol.error) return <ErrorBox error={pol.error} onRetry={pol.reload} />;
  const p = pol.data, o = ov.data;
  const save = async (body) => { try { await api.patch('/admin/advertising/policy', body); toast('Saved'); pol.reload(); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 10, marginTop: 10 }}>
      {o ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><StatPill value={o.delivery.impressions} label="VIEWS" /></View>
            <View style={{ flex: 1 }}><StatPill value={o.delivery.clicks} label="CLICKS" /></View>
            <View style={{ flex: 1 }}><StatPill value={o.open_reports} label="OPEN REPORTS" /></View>
          </View>
          <Card>
            <T weight="800">Campaigns</T>
            <T size={13} color={c.mute}>{o.campaigns_by_status.map((x) => `${x.n} ${x.status}`).join(' · ') || 'None yet'}</T>
            {o.funds_by_currency.map((f) => <T key={f.currency} size={13}>{f.currency}: funded {moneyIn(f.funded_minor, f.currency)} · spent {moneyIn(f.spent_minor, f.currency)} · refunded {moneyIn(f.refunded_minor, f.currency)}</T>)}
            <T size={12} weight="700" color={o.reconciliation.mismatched.length ? c.red : c.mute} style={{ marginTop: 4 }}>{o.reconciliation.mismatched.length ? `⚠ ${o.reconciliation.mismatched.length} campaign counter(s) differ from their delivery records` : `✓ All ${o.reconciliation.campaigns_checked} campaigns reconcile to the delivery records`}</T>
          </Card>
        </>
      ) : null}
      <Section title="Rules">
        <Row title="Young people" sub={p.policy.youth_contextual ? 'Approved, contextual-only campaigns may reach young people and youth pages. No profiling.' : 'No ads for young people or on youth pages.'} right={<Btn small title={p.policy.youth_contextual ? 'Turn off' : 'Allow'} color={p.policy.youth_contextual ? c.paper : c.violet} ink={p.policy.youth_contextual ? c.red : '#fff'} onPress={() => save({ youth_contextual: !p.policy.youth_contextual })} />} />
        <Row title="Frequency" sub={`Default ${p.policy.default_frequency} a day, never more than ${p.policy.max_frequency}`} right={<Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => setEdit(true)} />} />
      </Section>
      <Section title="Inventory">
        {p.inventory.map((i) => (
          <Row key={i.code} title={i.label} sub={`${i.max_slots} slot${i.max_slots === 1 ? '' : 's'}`} right={<Btn small title={i.enabled ? 'On sale' : 'Off'} color={i.enabled ? c.mint : c.paper} ink={i.enabled ? '#fff' : c.mute} onPress={() => save({ inventory: [{ code: i.code, enabled: !i.enabled, max_slots: i.max_slots }] })} />} />
        ))}
      </Section>
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Frequency limits" initial={{ default_frequency: p.policy.default_frequency, max_frequency: p.policy.max_frequency }}
        fields={[{ key: 'default_frequency', label: 'Default per person per day', type: 'stepper', min: 1, max: 50 }, { key: 'max_frequency', label: 'Most any campaign may ask for', type: 'stepper', min: 1, max: 100 }]}
        onSubmit={async (v) => { await api.patch('/admin/advertising/policy', v); pol.reload(); return 'Saved'; }} />
    </View>
  );
}

export function AdminAds({ tab, onOpen }) {
  return tab === 'review' ? <Queue onOpen={onOpen} /> : tab === 'reports' ? <Reports onOpen={onOpen} /> : <PolicyTab />;
}

/** One campaign as the reviewer sees it, with the decisions only the platform admin can make. */
export function AdminDecision({ data, onChanged }) {
  const { toast } = useSession();
  const k = data.campaign;
  const cr = data.creatives[0];
  const [form, setForm] = useState(null);
  const ad = cr ? { label: k.landing?.type === 'entity' ? 'Promoted' : 'Sponsored', advertiser: { name: k.advertiser_name }, headline: cr.headline, body: cr.body, cta: cr.cta, image_url: cr.media_id ? `/api/v1/market/media/${cr.media_id}` : null, image_alt: cr.alt_text } : null;
  const submitted = k.status === 'submitted';
  const running = ['active', 'scheduled'].includes(k.status);
  const run = async (path, body, msg) => { await api.post(`/admin/advertising/campaigns/${k.id}/${path}`, body); onChanged(); return msg; };
  return (
    <Screen onRefresh={onChanged} wide>
      <H1 style={{ marginTop: 8, fontSize: 26 }}>{k.name}</H1>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginVertical: 6 }}><StatusTag s={k.status} held={k.held_by_platform} /><T size={13} color={c.mute}>{k.advertiser_name} ({data.advertiser.kind}) · {k.category_label}</T></View>
      {!k.category_allowed ? <Card color={c.orangeSoft} pad={12}><T weight="800">This category cannot be advertised. It can only be rejected.</T></Card> : null}
      {ad ? <Section title="The ad"><AdCard ad={ad} preview /></Section> : null}
      <Section title="What to check">
        <Card>
          <T size={13}><T weight="800" size={13}>Claims declared: </T>{cr?.claim_labels?.length ? cr.claim_labels.join(', ') : 'none'}</T>
          <T size={13}><T weight="800" size={13}>Destination: </T>{k.landing ? (k.landing.type === 'external' ? k.landing.url : `${k.landing.entity_type} page on Gotmygame`) : 'none'}</T>
          <T size={13}><T weight="800" size={13}>Placements: </T>{data.placements.map((p) => p.label).join(', ')}</T>
          <T size={13}><T weight="800" size={13}>Targeting: </T>{[k.sports.length ? `sports ${k.sports.join(', ')}` : 'any sport', k.countries.length ? `countries ${k.countries.join(', ')}` : null, k.cities.length ? `cities ${k.cities.join(', ')}` : null, k.keywords.length ? `words ${k.keywords.join(', ')}` : null, `audience ${k.audience}`].filter(Boolean).join(' · ')}</T>
          <T size={13}><T weight="800" size={13}>Billing: </T>{k.billing_model} · {moneyIn(k.rate_minor, k.currency)} · budget {moneyIn(k.budget_minor, k.currency)} · {k.starts_on}→{k.ends_on}</T>
        </Card>
      </Section>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {submitted ? <><Btn small title="Approve" color={c.mint} disabled={!k.category_allowed} onPress={() => setForm('approve')} /><Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => setForm('reject')} /></> : null}
        {running ? <Btn small title="Pause" color={c.paper} ink={c.ink} onPress={() => setForm('pause')} /> : null}
        {k.status === 'paused' && k.held_by_platform ? <Btn small title="Lift the pause" color={c.mint} onPress={() => setForm('release')} /> : null}
        {!['ended', 'withdrawn'].includes(k.status) ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => setForm('withdraw')} /> : null}
      </View>
      {data.reviews.length ? <Section title="Earlier decisions">{data.reviews.map((r, i) => <Row key={i} title={`${r.decision} · ${r.reviewer}`} sub={`${String(r.reason_category ?? '').replace(/_/g, ' ')}${r.reason ? ` — ${r.reason}` : ''}`} right={<T size={12} color={c.mute}>{when(r.created_at)}</T>} />)}</Section> : null}
      {data.open_reports ? <T size={13} color={c.red} weight="700" style={{ marginTop: 10 }}>{data.open_reports} open report{data.open_reports === 1 ? '' : 's'} on this campaign.</T> : null}

      <FormSheet visible={form === 'approve'} onClose={() => setForm(null)} title="Approve" submitLabel="Approve" initial={{ claims_checked: cr?.claims?.filter((x) => x !== 'none') ?? [], youth_contextual: false }}
        notice="Approving means you read the ad and checked each claim it declares against the advertiser’s page."
        fields={[{ key: 'claims_checked', label: 'Claims you checked', type: 'multi', optional: true, options: opt(CLAIMS) }, { key: 'youth_contextual', label: 'Safe for approved, contextual delivery to young people', type: 'switch', hint: 'Only takes effect while the platform policy allows ads for young people.' }]}
        onSubmit={(v) => run('review', { decision: 'approved', ...v }, 'Approved — the advertiser was told')} />
      <FormSheet visible={form === 'reject'} onClose={() => setForm(null)} title="Reject" submitLabel="Reject" initial={{ reason_category: 'misleading_claim' }}
        fields={[{ key: 'reason_category', label: 'Reason', type: 'chips', options: opt(REASONS) }, { key: 'reason', label: 'What should they change?', type: 'multiline' }]}
        onSubmit={(v) => run('review', { decision: 'rejected', ...v }, 'Rejected — the advertiser was told why')} />
      {['pause', 'withdraw', 'release'].map((a) => (
        <FormSheet key={a} visible={form === a} onClose={() => setForm(null)} title={a === 'pause' ? 'Pause' : a === 'withdraw' ? 'Withdraw' : 'Lift the pause'} submitLabel="Confirm" initial={{ reason_category: 'other' }}
          fields={[...(a === 'release' ? [] : [{ key: 'reason_category', label: 'Reason', type: 'chips', options: opt(REASONS) }]), { key: 'reason', label: 'Note for the advertiser', type: 'multiline' }]}
          onSubmit={(v) => run('stop', { action: a, ...v }, a === 'withdraw' ? 'Withdrawn' : a === 'pause' ? 'Paused — it stopped showing' : 'The pause was lifted')} />
      ))}
    </Screen>
  );
}
