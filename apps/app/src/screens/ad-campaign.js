// One campaign (#524): the ad as people will see it, where it stands in review, the money, and what it has delivered — every number added up from the
// same delivery records the platform's own reports use. Actions appear only when the API says they are possible.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Confirm } from './coaching';
import { PaySheet } from '../PaySheet';
import { AdCard } from '../ads';
import { CampaignWizard } from './ad-wizard';
import { AdminDecision } from './ad-admin';
import { Meter, StatusTag } from './ad-ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const ACTION_LABEL = { created: 'Created', creative_saved: 'Ad saved', edited: 'Edited', returned_to_draft: 'Sent back to draft', submitted: 'Sent for review', approved: 'Approved', rejected: 'Rejected', funded: 'Funds added', funding_invoice_created: 'Funding invoice raised', funding_invoice_void: 'Funding invoice cancelled', scheduled: 'Scheduled', activated: 'Went live', paused: 'Paused', resumed: 'Resumed', ended: 'Ended', withdrawn: 'Withdrawn', refunded: 'Refund issued', platform_pause: 'Paused by the platform', platform_withdraw: 'Withdrawn by the platform', platform_release: 'Platform pause lifted' };

function NextStep({ d }) {
  const k = d.campaign, can = d.can;
  const funded = k.funded_minor - k.refunded_minor;
  let text = null;
  if (k.status === 'draft' || k.status === 'rejected') text = d.needs_before_submit.length ? `Before you can send it: ${d.needs_before_submit.join('; ')}.` : 'Ready. Send it for review.';
  else if (k.status === 'submitted') text = 'With the review team. You will be told as soon as it is decided.';
  else if (k.status === 'approved') text = funded >= (k.billing_model === 'flat' ? k.rate_minor : k.rate_minor) ? 'Approved and funded. Start it when you are ready.' : 'Approved. Add funds, then start it.';
  else if (k.status === 'scheduled') text = `Starts on ${day(k.starts_on)}.`;
  else if (k.status === 'active') text = k.remaining_minor <= 0 ? 'The funds are used up.' : `Live. ${moneyIn(k.remaining_minor, k.currency)} left.`;
  else if (k.status === 'paused') text = k.held_by_platform ? 'Paused by the review team. Contact them to have it lifted.' : 'Paused. Resume it, or change it and send it for review again.';
  else if (d.refundable_minor > 0) text = `${moneyIn(d.refundable_minor, k.currency)} of unspent funds can be refunded.`;
  if (!text) return null;
  return <Card color={c.sunSoft} pad={12}><T size={13} weight="700">{text}</T></Card>;
}

export function AdCampaign({ id, admin }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/advertising/campaigns/${id}`).catch((e) => (admin ? api.get(`/admin/advertising/campaigns/${id}`).then((x) => ({ __admin: x })) : Promise.reject(e))), [id]);
  const rep = useLoad(() => api.get(`/advertising/campaigns/${id}/report`).catch(() => null), [id]);
  const policy = useLoad(() => api.get('/advertising/policy'), []);
  const [edit, setEdit] = useState(false);
  const [fund, setFund] = useState(false);
  const [pay, setPay] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const reload = () => { d.reload(); rep.reload(); };
  if (d.loading && !d.data) return <Screen><Loading /></Screen>;
  if (d.error) return <Screen><ErrorBox error={d.error} onRetry={d.reload} /></Screen>;
  if (d.data.__admin) return <AdminDecision data={d.data.__admin} onChanged={d.reload} />;
  const data = d.data, k = data.campaign, can = data.can, m = data.money, r = rep.data;
  const cr = data.creatives.find((x) => x.id === k.current_creative_id) ?? data.creatives[0];
  const act = async (path, msg, body = {}) => { try { await api.post(`/advertising/campaigns/${id}/${path}`, body); toast(msg); reload(); } catch (e) { toast(e.message); } };
  const ad = cr ? { label: k.disclosure, advertiser: { name: data.advertiser_name }, headline: cr.headline, body: cr.body, cta: cr.cta, image_url: cr.media_id ? `/api/v1/market/media/${cr.media_id}` : null, image_alt: cr.alt_text } : null;
  const last = data.reviews[0];

  return (
    <Screen onRefresh={reload} wide>
      <H1 style={{ marginTop: 8, fontSize: 26 }}>{k.name}</H1>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginVertical: 6 }}>
        <StatusTag s={k.status} held={k.held_by_platform} />
        <T size={13} color={c.mute}>{k.category_label} · {day(k.starts_on)}–{day(k.ends_on)}</T>
      </View>
      <NextStep d={data} />

      {last && (k.status === 'rejected' || last.decision === 'paused' || last.decision === 'withdrawn') ? (
        <Card color={c.orangeSoft} pad={12} style={{ marginTop: 10 }}><T weight="800" size={14}>{last.decision === 'rejected' ? 'Why it was not approved' : 'Why the platform stopped it'}</T><T size={13}>{String(last.reason_category ?? '').replace(/_/g, ' ')}{last.reason ? ` — ${last.reason}` : ''}</T></Card>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {can.edit ? <Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => setEdit(true)} /> : null}
        {can.submit ? <Btn small title="Send for review" onPress={() => act('submit', 'Sent for review')} /> : null}
        {can.fund ? <Btn small title="Add funds" color={c.violet} onPress={() => setFund(true)} /> : null}
        {can.start ? <Btn small title="Start" color={c.mint} onPress={() => act('start', 'Started')} /> : null}
        {can.pause ? <Btn small title="Pause" color={c.paper} ink={c.ink} onPress={() => act('pause', 'Paused — it stopped showing')} /> : null}
        {can.resume ? <Btn small title="Resume" color={c.mint} onPress={() => act('resume', 'Resumed')} /> : null}
        {can.end ? <Btn small title="End" color={c.paper} ink={c.ink} onPress={() => setConfirm('end')} /> : null}
        {can.withdraw ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => setConfirm('withdraw')} /> : null}
        {data.refundable_minor > 0 ? <Btn small title={`Refund ${moneyIn(data.refundable_minor, k.currency)}`} color={c.violet} onPress={() => setConfirm('refund')} /> : null}
      </View>

      {ad ? <Section title="How it looks"><AdCard ad={ad} preview /><T size={12} color={c.mute}>People see this label on every placement. The ⓘ lets them see why it appeared, hide it or report it.</T></Section> : null}

      <Section title="Funds">
        <Card>
          <Meter spent={m.spent_minor} of={Math.min(m.budget_minor, m.funded_minor - m.refunded_minor) || m.budget_minor} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
            {[['Budget', m.budget_minor], ['Funded', m.funded_minor], ['Spent', m.spent_minor], ['Left', m.remaining_minor], ...(m.refunded_minor ? [['Refunded', m.refunded_minor]] : [])].map(([l, v]) => (
              <View key={l}><T size={11} color={c.mute} weight="700">{l.toUpperCase()}</T><T weight="800">{moneyIn(v, k.currency)}</T></View>))}
          </View>
          <T size={12} color={c.mute} style={{ marginTop: 8 }}>{k.billing_model === 'flat' ? 'Flat fee, taken when it starts.' : k.billing_model === 'cpm' ? `${moneyIn(k.rate_minor, k.currency)} per 1,000 views.` : `${moneyIn(k.rate_minor, k.currency)} per click.`} Delivery stops the moment the funds run out.</T>
          <T size={12} color={m.reconciliation.spend_matches && m.reconciliation.funds_match ? c.mute : c.red} weight="700" style={{ marginTop: 4 }}>{m.reconciliation.spend_matches && m.reconciliation.funds_match ? '✓ Spend and funds agree with the delivery records and payments.' : '⚠ Spend does not match the records — the platform has been told.'}</T>
        </Card>
        {data.fundings.map((f) => (
          <Row key={f.id} title={f.number} sub={`${f.status === 'awaiting_payment' ? 'Unpaid' : f.status === 'paid' ? 'Paid' : 'Cancelled'}${f.refunded_minor ? ` · refunded ${moneyIn(f.refunded_minor, f.currency)}` : ''}`}
            right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800">{moneyIn(f.amount_minor, f.currency)}</T>{f.status === 'awaiting_payment' ? <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="Pay" onPress={() => setPay({ id: f.id, type: 'ad_funding', label: `Advertising funds ${f.number}`, amount: f.amount_minor, currency: f.currency })} /><Btn small title="Cancel" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/advertising/fundings/${f.id}/void`); reload(); } catch (e) { toast(e.message); } }} /></View> : null}</View>} />
        ))}
      </Section>

      <Section title="Performance">
        {r ? (
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}><StatPill value={r.impressions} label="VIEWS" /></View>
              <View style={{ flex: 1 }}><StatPill value={r.clicks} label="CLICKS" /></View>
              <View style={{ flex: 1 }}><StatPill value={r.ctr == null ? '—' : `${r.ctr}%`} label="CLICK RATE" /></View>
            </View>
            {r.by_day.length ? (
              <Card>
                <T weight="800" size={13}>Views by day</T>
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 70, marginTop: 8 }} accessible accessibilityLabel={`Views by day: ${r.by_day.map((x) => `${x.day} ${x.impressions}`).join(', ')}`}>
                  {r.by_day.slice(-21).map((x) => <View key={x.day} style={{ flex: 1, height: `${Math.max(4, (x.impressions / Math.max(...r.by_day.map((y) => y.impressions), 1)) * 100)}%`, backgroundColor: c.violet, borderRadius: 3 }} />)}
                </View>
              </Card>
            ) : <Empty emoji="📊" title="Nothing shown yet" sub="Numbers appear here as soon as the ad is served." />}
            {r.by_placement.map((x) => <Row key={x.placement} title={x.placement.replace(/_/g, ' ')} sub={`${x.impressions} views · ${x.clicks} clicks`} />)}
            {r.not_charged ? <T size={12} color={c.mute}>{r.not_charged} event{r.not_charged === 1 ? '' : 's'} not charged ({r.not_charged_reasons.map((x) => `${x.n} ${x.reason.replace(/_/g, ' ')}`).join(', ')}).</T> : null}
            <Card color={c.paper} pad={12}>
              <T weight="800" size={13}>How this is measured</T>
              <T size={12} color={c.mute}>Views: {r.definitions.impressions}</T>
              <T size={12} color={c.mute}>Clicks: {r.definitions.clicks}</T>
              <T size={12} color={c.mute}>Reach: {r.definitions.unique_reach}</T>
              <T size={12} color={c.mute}>Conversions: {r.definitions.conversions}</T>
            </Card>
          </>
        ) : <Loading />}
      </Section>

      <Section title="History">
        {data.timeline.map((t, i) => <T key={i} size={13}><T weight="700" size={13}>{ACTION_LABEL[t.action] ?? t.action.replace(/_/g, ' ')}</T>  <T size={12} color={c.mute}>{new Date(t.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</T></T>)}
      </Section>

      <CampaignWizard visible={edit} onClose={() => setEdit(false)} advertiser={{ advertiser_id: k.advertiser_id, name: data.advertiser_name, academies: [] }} policy={policy.data} campaign={data} onDone={reload} />
      <FormSheet visible={fund} onClose={() => setFund(false)} title="Add funds" submitLabel="Create invoice" initial={{ amount_minor: Math.max(0, k.budget_minor - (k.funded_minor - k.refunded_minor)) }}
        notice={`The most you can add is the rest of the budget (${moneyIn(Math.max(0, k.budget_minor - (k.funded_minor - k.refunded_minor)), k.currency)}). The money counts once the payment is confirmed.`}
        fields={[{ key: 'amount_minor', label: 'Amount', type: 'money', currency: k.currency }]}
        onSubmit={async (v) => { const f = await api.post(`/advertising/campaigns/${id}/fund`, { amount_minor: v.amount_minor }); reload(); setPay({ id: f.id, type: 'ad_funding', label: `Advertising funds ${f.number}`, amount: f.amount_minor, currency: f.currency }); }} />
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={reload} /> : null}
      <Confirm visible={confirm === 'end'} title="End this campaign?" yes="End campaign" danger onClose={() => setConfirm(null)} onYes={async () => { await act('end', 'Ended'); setConfirm(null); }}
        body="It stops showing now and cannot be restarted. Unspent funds can then be refunded." />
      <Confirm visible={confirm === 'withdraw'} title="Withdraw this campaign?" yes="Withdraw" danger onClose={() => setConfirm(null)} onYes={async () => { await act('withdraw', 'Withdrawn'); setConfirm(null); }}
        body="It stops at once and cannot be restarted. If it never showed, a flat fee is credited back." />
      <Confirm visible={confirm === 'refund'} title="Refund the unspent funds?" yes="Refund" onClose={() => setConfirm(null)}
        onYes={async () => { try { const out = await api.post(`/advertising/campaigns/${id}/refund-balance`); toast(`Refunded ${moneyIn(out.refunded_minor, out.currency)} to the original payment method`); reload(); } catch (e) { toast(e.message); } setConfirm(null); }}
        body={`${moneyIn(data.refundable_minor, k.currency)} goes back to the card or account that paid.`} />
    </Screen>
  );
}
