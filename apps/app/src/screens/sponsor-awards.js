import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';

// Award approvals and conditional offers (#289). Brand staff run an award from the program (budget bar, sign-offs, issue);
// the recipient reviews and accepts one exact offer version from their funding screen. The server decides everything.
const fmt = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`.trim(); } };
const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const stamp = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const STATUS = {
  waitlisted: ['Waitlisted', c.sunSoft], pending_approval: ['Pending approval', c.sunSoft], approved: ['Approved — ready to issue', c.mint], issued: ['Issued', c.lime],
  accepted: ['Accepted', c.lime], declined: ['Declined', c.pinkSoft], expired: ['Expired', c.paper], withdrawn: ['Withdrawn', c.paper], rejected: ['Rejected', c.pinkSoft],
};
const STEP = { approver: 'Second approver', finance: 'Finance', legal: 'Legal' };
const STEP_MARK = { approved: '✔', rejected: '✖', pending: '◔' };
const FILTERS = [['all', 'All'], ['pending_approval', 'Pending'], ['approved', 'Ready to issue'], ['issued', 'Issued'], ['waitlisted', 'Waitlist'], ['accepted', 'Accepted']];
const key = () => `issue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const Banner = ({ tone = c.sunSoft, children, action, onAction }) => (
  <View accessibilityRole="alert" style={{ backgroundColor: tone, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <T size={13} style={{ flex: 1 }}>{children}</T>
    {action ? <Btn small title={action} color={c.paper} ink={c.ink} onPress={onAction} accessibilityLabel={action} /> : null}
  </View>
);

const Segments = ({ s }) => {
  const total = s.budget_cents || 1;
  const w = (x) => `${Math.min(100, (x / total) * 100)}%`;
  return (
    <View accessible accessibilityLabel={`Budget: ${fmt(s.accepted_cents, s.currency)} accepted, ${fmt(s.reserved_cents, s.currency)} reserved, ${fmt(s.free_cents, s.currency)} free`}>
      <View style={{ height: 10, borderRadius: 5, backgroundColor: c.paper, overflow: 'hidden', flexDirection: 'row' }}>
        <View style={{ width: w(s.accepted_cents), backgroundColor: c.pink }} />
        <View style={{ width: w(s.reserved_cents), backgroundColor: c.sun }} />
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 4 }}>Accepted {fmt(s.accepted_cents, s.currency)} · Reserved {fmt(s.reserved_cents, s.currency)} · Free {fmt(s.free_cents, s.currency)}{s.waitlisted ? ` · ${s.waitlisted} on the waitlist` : ''}</T>
    </View>
  );
};

/** Brand staff: the awards of a program with their sign-off progress. */
export function ProgramAwards({ program: p, onChanged }) {
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const sum = useLoad(() => api.get(`/sponsorship-programs/${p.id}/award-summary`), [p.id, p.row_version]);
  const list = useLoad(() => api.get(`/sponsorship-programs/${p.id}/awards`, { limit: 100, ...(filter !== 'all' ? { status: filter } : {}) }), [p.id, filter, p.row_version]);
  const reload = () => { sum.reload(); list.reload(); onChanged?.(); };
  return (
    <Section title="Awards" color={c.mint}>
      {sum.error ? <LoadError error={sum.error} onRetry={sum.reload} /> : sum.data ? <Segments s={sum.data} /> : <Loading />}
      {sum.data ? <T size={12} color={c.mute}>Rules: {[sum.data.rules.award_approval_cents != null ? `second approver above ${fmt(sum.data.rules.award_approval_cents, p.currency)}` : null, sum.data.rules.finance_signoff_cents != null ? `finance above ${fmt(sum.data.rules.finance_signoff_cents, p.currency)}` : null, sum.data.rules.legal_signoff_required ? 'legal on every award' : null].filter(Boolean).join(' · ') || 'no extra sign-off'} · offers valid {sum.data.rules.offer_validity_days} days{sum.data.rules.waitlist_enabled ? ' · waitlist on' : ''}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{FILTERS.map(([v, l]) => <Chip key={v} label={l} active={filter === v} onPress={() => setFilter(v)} />)}</View>
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : list.data?.length ? list.data.map((a) => (
        <Card key={a.id} onPress={() => setOpen(a.id)} accessibilityLabel={`${a.target_name ?? a.applicant_name}, ${fmt(a.amount_cents, a.currency)}, ${STATUS[a.status][0]}. Open award`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T weight="900">{a.target_name ?? a.applicant_name}</T><T size={12} color={c.mute}>Round {a.round_seq} · {fmt(a.amount_cents, a.currency)}{a.status === 'issued' ? ` · expires ${stamp(a.expires_at)}` : ''}{a.status === 'waitlisted' ? ` · #${a.waitlist_rank}` : ''}</T></View>
            <Tag label={STATUS[a.status][0]} color={STATUS[a.status][1]} />
          </View>
          {a.status === 'pending_approval' && a.approvals.length ? <T size={12} style={{ marginTop: 4 }}>{a.approvals.map((x) => `${STEP_MARK[x.status]} ${STEP[x.step]}`).join('   ')}</T> : null}
        </Card>
      )) : <Empty emoji="🏅" title={filter === 'all' ? 'No awards yet' : 'No awards in this state'} sub={filter === 'all' ? 'Award an application above to start one; it reserves budget and follows your approval rules.' : undefined} />}
      <AwardSheet id={open} program={p} onClose={() => setOpen(null)} onChanged={reload} />
    </Section>
  );
}

/** One award for brand staff: sign-offs, conditions, letter and the actions their role allows. */
function AwardSheet({ id, program: p, onClose, onChanged }) {
  const { toast } = useSession();
  const [form, setForm] = useState(null); // 'amount' | 'condition' | 'reject:<step>'
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const det = useLoad(() => (id ? api.get(`/program-awards/${id}`) : Promise.resolve(null)), [id]);
  const d = det.data;
  const run = async (fn, m) => {
    setBusy(true);
    try { await fn(); if (m) toast(m); setStale(false); det.reload(); onChanged(); } catch (e) { toast(explain(e)); if (e.status === 409) { setStale(true); det.reload(); } } finally { setBusy(false); }
  };
  const can = (x) => d?.can?.includes(x);
  const editable = d && ['pending_approval', 'approved', 'issued'].includes(d.status) && can('manage');
  const patch = (b) => api.patch(`/program-awards/${d.id}`, { row_version: d.row_version, ...b });
  const sign = (step, decision, note) => api.post(`/program-awards/${d.id}/approvals`, { step, decision, offer_version: d.offer_version, ...(note ? { note } : {}) });
  const open = d?.approvals?.filter((x) => x.status === 'pending') ?? [];
  const left = d?.status === 'pending_approval' ? open : [];
  const mySteps = left.filter((x) => (x.step === 'approver' && can('award_approve')) || (x.step === 'finance' && can('award_finance')) || (x.step === 'legal' && can('award_legal')));
  const why = d?.status === 'pending_approval' ? `Waiting for ${left.map((x) => STEP[x.step].toLowerCase()).join(', ')} sign-off` : d?.status === 'waitlisted' ? 'On the waitlist: no budget is reserved yet' : null;
  return (
    <Sheet visible={!!id} onClose={onClose} title={d ? `Award · ${fmt(d.amount_cents, d.currency)}` : 'Award'}>
      {det.error ? <LoadError error={det.error} onRetry={det.reload} /> : !d ? <Loading /> : (
        <>
          {stale ? <Banner action="Dismiss" onAction={() => setStale(false)}>This award was changed by someone else. The latest version is shown now — review it and try again.</Banner> : null}
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{d.target_name}</T><Tag label={STATUS[d.status][0]} color={STATUS[d.status][1]} /></View>
          <T size={12} color={c.mute}>Asked {fmt(d.requested_cents, d.currency)} · offer version {d.offer_version} · budget {d.reservation === 'held' ? 'reserved' : d.reservation === 'converted' ? 'now an agreement' : d.reservation === 'released' ? 'released' : 'not reserved'}{d.expires_at ? ` · expires ${stamp(d.expires_at)}` : ''}</T>
          {why ? <T size={13}>{why}.</T> : null}
          {d.status === 'rejected' || d.status === 'withdrawn' || d.status === 'expired' || d.status === 'declined' ? <T size={13}>Closed{d.closed_reason ? `: ${d.closed_reason}` : ''}. The reserved budget was released.</T> : null}

          {d.approvals.length ? (
            <View style={{ gap: 6 }}>
              <T weight="900">Sign-offs</T>
              {d.approvals.map((x) => (
                <View key={x.step} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <T style={{ flex: 1 }}>{STEP_MARK[x.status]} {STEP[x.step]} — {x.status}{x.decided_at ? ` · ${stamp(x.decided_at)}` : ''}</T>
                  {d.status === 'pending_approval' && x.status === 'pending' && mySteps.some((m) => m.step === x.step) ? (
                    d.proposed_by_me ? <T size={12} color={c.mute}>You proposed this, so someone else signs</T> : (
                      <View style={{ flexDirection: 'row', gap: 6 }}>
                        <Btn small title="Approve" color={c.mint} ink={c.ink} disabled={busy} onPress={() => run(() => sign(x.step, 'approve'), `${STEP[x.step]} sign-off recorded`)} accessibilityLabel={`Approve ${STEP[x.step]} sign-off`} />
                        <Btn small title="Reject" color={c.paper} ink={c.red} disabled={busy} onPress={() => setForm(`reject:${x.step}`)} accessibilityLabel={`Reject ${STEP[x.step]} sign-off`} />
                      </View>
                    )
                  ) : d.status === 'pending_approval' && x.status === 'pending' ? <T size={12} color={c.mute}>Needs a {STEP[x.step].toLowerCase()} role</T> : null}
                </View>
              ))}
            </View>
          ) : null}

          <View style={{ gap: 6 }}>
            <T weight="900">Conditions</T>
            {d.conditions.length ? d.conditions.map((x) => (
              <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T style={{ flex: 1 }}>{x.met_at ? '☑' : '☐'} {x.text}{x.due_on ? ` · by ${day(x.due_on)}` : ''}{x.blocks_payment ? ' · before payment' : ''}</T>
                {d.status === 'accepted' && can('manage') ? <Btn small title={x.met_at ? 'Undo' : 'Mark met'} color={c.paper} ink={c.ink} disabled={busy} onPress={() => run(() => api.post(`/program-awards/${d.id}/conditions/${x.id}/met`, { met: !x.met_at }), x.met_at ? 'Marked not met' : 'Marked met')} accessibilityLabel={`${x.met_at ? 'Undo' : 'Mark met'}: ${x.text}`} /> : null}
                {editable ? <Btn small title="Remove" color={c.paper} ink={c.red} disabled={busy} onPress={() => run(() => patch({ conditions: d.conditions.filter((y) => y.id !== x.id).map(({ text, due_on, blocks_payment }) => ({ text, due_on: due_on ?? undefined, blocks_payment })) }), 'Condition removed — a new offer version')} accessibilityLabel={`Remove condition ${x.text}`} /> : null}
              </View>
            )) : <T size={12} color={c.mute}>No conditions — the award is unconditional.</T>}
            {editable ? <Btn small title="+ Condition" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('condition')} /> : null}
          </View>

          {d.letter ? <View style={{ gap: 4 }}><T weight="900">Award letter</T><Card><T size={13}>{d.letter}</T></Card></View> : null}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {editable ? <Btn small title="Change amount" color={c.violet} disabled={busy} onPress={() => setForm('amount')} /> : null}
            {d.status === 'approved' && can('manage') ? <Btn title="Issue award" color={c.mint} ink={c.ink} loading={busy} onPress={() => run(() => api.post(`/program-awards/${d.id}/issue`, { offer_version: d.offer_version, idempotency_key: key() }), 'Award issued to the recipient')} accessibilityLabel="Issue the award to the recipient" /> : null}
            {d.status === 'pending_approval' && !mySteps.length && can('manage') ? <Btn title="Issue award" disabled color={c.mint} ink={c.ink} accessibilityLabel="Issue the award (disabled until every sign-off is approved)" /> : null}
            {['waitlisted', 'pending_approval', 'approved', 'issued'].includes(d.status) && can('manage') ? <Btn small title="Withdraw" color={c.paper} ink={c.red} disabled={busy} onPress={() => run(() => api.post(`/program-awards/${d.id}/withdraw`, {}), 'Withdrawn — the budget is released')} /> : null}
            {d.sponsorship_id ? <T size={12} color={c.mute}>Agreement created on acceptance.</T> : null}
          </View>

          {d.events?.length ? (
            <View style={{ gap: 2 }}>
              <T weight="900">History</T>
              {d.events.map((e, i) => <T key={i} size={12} color={c.mute}>{stamp(e.created_at)} · {e.kind.replace(/_/g, ' ')}{e.offer_version ? ` (v${e.offer_version})` : ''}{e.note ? ` — ${e.note}` : ''}</T>)}
            </View>
          ) : null}

          <FormSheet visible={form === 'amount'} onClose={() => setForm(null)} title="Change amount" submitLabel="Save as a new offer version"
            fields={[{ key: 'amount_cents', label: `Amount (asked ${fmt(d.requested_cents, d.currency)})`, type: 'money', currency: d.currency, hint: 'Earlier sign-offs are cleared and an issued offer is taken back until it is approved and issued again.' }]}
            initial={{ amount_cents: d.amount_cents }}
            onSubmit={async (v) => { try { await patch({ amount_cents: v.amount_cents }); } catch (e) { if (e.status === 409) { setStale(true); det.reload(); } throw e; } det.reload(); onChanged(); return 'Saved — a new offer version'; }} />
          <FormSheet visible={form === 'condition'} onClose={() => setForm(null)} title="Add a condition" submitLabel="Add condition"
            fields={[{ key: 'text', label: 'What must happen', hint: 'For example: share the club accounts.' }, { key: 'due_on', label: 'Due by', type: 'date', optional: true }, { key: 'blocks_payment', label: 'Must be met before payment', type: 'switch' }]}
            onSubmit={async (v) => { try { await patch({ conditions: [...d.conditions.map(({ text, due_on, blocks_payment }) => ({ text, due_on: due_on ?? undefined, blocks_payment })), { text: v.text, due_on: v.due_on || undefined, blocks_payment: !!v.blocks_payment }] }); } catch (e) { if (e.status === 409) { setStale(true); det.reload(); } throw e; } det.reload(); onChanged(); return 'Condition added — a new offer version'; }} />
          <FormSheet visible={typeof form === 'string' && form.startsWith('reject:')} onClose={() => setForm(null)} title="Reject this award" submitLabel="Reject and release the budget"
            fields={[{ key: 'note', label: 'Reason', type: 'multiline', optional: true }]}
            onSubmit={async (v) => { const step = form.split(':')[1]; try { await sign(step, 'reject', v.note); } catch (e) { if (e.status === 409) { setStale(true); det.reload(); } throw e; } det.reload(); onChanged(); return 'Rejected — the reserved budget was released'; }} />
        </>
      )}
    </Sheet>
  );
}

/** Recipient: the funding offers made to me, with the exact version to accept. */
export function MyOffers({ onChanged }) {
  const [open, setOpen] = useState(null);
  const offers = useLoad(() => api.get('/my/program-awards', { limit: 50 }), []);
  if (offers.error) return <Section title="Offers" color={c.mint}><LoadError error={offers.error} onRetry={offers.reload} /></Section>;
  if (offers.loading && !offers.data) return <Section title="Offers" color={c.mint}><Loading /></Section>;
  if (!offers.data?.length) return null;
  return (
    <Section title="Funding offers" color={c.mint}>
      {offers.data.map((o) => (
        <Card key={o.id} onPress={() => setOpen(o.id)} accessibilityLabel={`${o.program_name}, ${fmt(o.amount_cents, o.currency)}, ${STATUS[o.status][0]}. Open offer`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T weight="900">{o.program_name}</T><T size={12} color={c.mute}>{o.sponsor_name} · {fmt(o.amount_cents, o.currency)}{o.status === 'issued' ? ` · accept before ${stamp(o.expires_at)}` : ''}{o.status === 'waitlisted' ? ` · you are #${o.waitlist_rank} on the waitlist` : ''}</T></View>
            <Tag label={STATUS[o.status][0]} color={STATUS[o.status][1]} />
          </View>
        </Card>
      ))}
      <OfferSheet id={open} onClose={() => setOpen(null)} onChanged={() => { offers.reload(); onChanged?.(); }} />
    </Section>
  );
}

function OfferSheet({ id, onClose, onChanged }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [publicly, setPublicly] = useState(false);
  const det = useLoad(() => (id ? api.get(`/program-awards/${id}`) : Promise.resolve(null)), [id]);
  const d = det.data;
  const respond = async (decision, reason) => {
    setBusy(true);
    try { await api.post(`/program-awards/${d.id}/respond`, { decision, offer_version: d.offer_version, ...(reason ? { reason } : {}), ...(decision === 'accept' && d.target_type === 'athlete' ? { show_publicly: publicly } : {}) }); toast(decision === 'accept' ? 'Accepted — your agreement is in place' : 'Offer declined'); det.reload(); onChanged(); } catch (e) { toast(explain(e)); det.reload(); onChanged(); } finally { setBusy(false); }
  };
  const live = d?.status === 'issued' && !d.expired;
  return (
    <Sheet visible={!!id} onClose={onClose} title="Funding offer">
      {det.error ? <LoadError error={det.error} onRetry={det.reload} /> : !d ? <Loading /> : (
        <>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="900" style={{ flex: 1 }}>{d.program_name}</T><Tag label={d.expired && d.status === 'issued' ? 'Expired' : STATUS[d.status][0]} color={STATUS[d.status][1]} /></View>
          <T size={13}>{d.sponsor_name} offers {fmt(d.amount_cents, d.currency)} · version {d.offer_version}{d.expires_at ? ` · ${live ? 'accept before' : 'expired'} ${stamp(d.expires_at)}` : ''}</T>
          {d.status === 'waitlisted' ? <Banner>You are #{d.waitlist_rank} on the waitlist. We will tell you if funds become available.</Banner> : null}
          {d.status === 'expired' || (d.status === 'issued' && d.expired) ? <Banner tone={c.pinkSoft}>This offer expired. Ask {d.sponsor_name} to issue a new one.</Banner> : null}
          {d.status === 'declined' ? <T size={13}>You declined this offer.</T> : null}
          {d.conditions.length ? (
            <View style={{ gap: 4 }}>
              <T weight="900">Conditions</T>
              {d.conditions.map((x) => <T key={x.id}>{x.met_at ? '☑' : '☐'} {x.text}{x.due_on ? ` · by ${day(x.due_on)}` : ''}{x.blocks_payment ? ' · must be met before payment' : ''}</T>)}
            </View>
          ) : null}
          {d.letter ? <View style={{ gap: 4 }}><T weight="900">Award letter</T><Card><T size={13}>{d.letter}</T></Card></View> : null}
          {live ? (
            <View style={{ gap: 8 }}>
              {d.target_type === 'athlete' ? <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><T size={13} style={{ flex: 1 }}>Show this sponsorship on my profile</T><Chip label={publicly ? 'Public' : 'Private'} active={publicly} onPress={() => setPublicly(!publicly)} /></View> : null}
              <Btn title={`Accept offer v${d.offer_version}`} color={c.mint} ink={c.ink} loading={busy} onPress={() => respond('accept')} accessibilityLabel={`Accept offer version ${d.offer_version} for ${fmt(d.amount_cents, d.currency)}`} />
              <Btn small title="Decline" color={c.paper} ink={c.red} disabled={busy} onPress={() => setDeclining(true)} />
              <T size={12} color={c.mute}>Accepting creates your sponsorship agreement from exactly these terms. Nothing is paid until the sponsor records it and you confirm.</T>
            </View>
          ) : null}
          {d.status === 'accepted' ? <T size={13}>Accepted — the agreement is in your sponsorships.</T> : null}
          <FormSheet visible={declining} onClose={() => setDeclining(false)} title="Decline this offer" submitLabel="Decline offer"
            fields={[{ key: 'reason', label: 'Reason (optional)', type: 'multiline', optional: true }]}
            onSubmit={async (v) => { await api.post(`/program-awards/${d.id}/respond`, { decision: 'decline', offer_version: d.offer_version, ...(v.reason ? { reason: v.reason } : {}) }); det.reload(); onChanged(); return 'Offer declined'; }} />
        </>
      )}
    </Sheet>
  );
}
