// One mandate, seen from either side (#484). The athlete side signs, shares items and revokes; the agent side signs, links deals and keeps its business record.
// Logic lives in the representation capabilities (REST + OpenAPI + MCP); this only calls them.
import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { countryName } from '../country-picker';
import { saveFile } from '../contracts-ui';
import { useLayout } from '../layout';
import { AccessList, Changes, Kv, Ladder, LiveTag, Note, StatusTag, TermsCard, TermsSheet, cash, key, nice, plainDate, say, sentence, useMatrix, useSportMaps, when } from '../representation-ui';

const SUBJECTS = { passport_video: 'Videos', billboard_response: 'Applications', player_contract: 'Contracts', sponsorship: 'Sponsorships', transfer: 'Transfers' };
const EVENT = {
  mandate_drafted: 'Drafted', version_proposed: 'Proposed a version', version_signed: 'Signed', version_declined: 'Declined a version', version_withdrawn: 'Withdrew a version', mandate_active: 'Mandate came into force',
  version_in_force: 'New version came into force', mandate_ended: 'Mandate ended', mandate_expired: 'Mandate expired', grant_made: 'Shared an item', grant_changed: 'Changed what is shared', grant_revoked: 'Stopped sharing an item',
  opportunity_shared: 'Shared an opportunity', opportunity_answered: 'Answered an opportunity', application_drafted: 'Drafted an application', approval_requested: 'Asked for approval', approval_approved: 'Approved', approval_declined: 'Declined',
  approval_cancelled: 'Cancelled a request', contact_logged: 'Logged a conversation', negotiation_note: 'Added a contract note', contract_review: 'Updated a contract review', contract_revision: 'A contract has a new version',
  deal_proposed: 'Proposed commission on a deal', deal_confirmed: 'Confirmed commission on a deal', deal_declined: 'Declined a deal link', deal_ended: 'Ended a deal link', milestone_claimed: 'Claimed a milestone',
  milestone_confirmed: 'Confirmed a milestone', milestone_rejected: 'Rejected a milestone', statement_issued: 'Issued a statement', statement_voided: 'Voided a statement', payment_reported: 'Reported a payment', payment_settled: 'Confirmed a payment',
  commission_adjusted: 'Reduced commission', commission_refunded: 'Recorded a refund', conflict_raised: 'A possible conflict was flagged', conflict_disclosed: 'Disclosed a conflict', conflict_acknowledged: 'Conflict acknowledged',
  conflict_rejected: 'Conflict rejected', conflict_recused: 'Agent stepped back', conflict_withdrawn: 'Conflict withdrawn', agent_suspended: 'Agent suspended', agent_reinstated: 'Agent reinstated',
  profile_visibility_on: 'Showing on public profile', profile_visibility_off: 'Hidden from public profile',
};

function Confirm({ visible, title, body, label, danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <T>{body}</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="Not now" color={c.paper} ink={c.ink} onPress={onClose} style={{ flex: 1 }} />
        <Btn title={label} color={danger ? c.red : c.pink} loading={busy} style={{ flex: 1 }} onPress={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }} />
      </View>
    </Sheet>
  );
}

export function MandateDetail({ id, onBack, onChanged, mode }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/representation/mandates/${id}`), [id]);
  const matrix = useMatrix();
  const maps = useSportMaps();
  const wide = useLayout().width >= 900;
  const [sheet, setSheet] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const m = q.data;
  const athleteSide = ['athlete', 'guardian', 'youth'].includes(m.side);
  const decideSide = ['athlete', 'guardian'].includes(m.side);
  const cur = m.current;
  const done = () => { q.reload(); onChanged?.(); };
  const act = async (fn, ok) => { setBusy(true); try { await fn(); if (ok) toast(ok); done(); } catch (e) { toast(say(e)); } finally { setBusy(false); } };
  const doc = async () => { try { const d = await api.get(`/representation/mandates/${id}/document`); await saveFile(d.filename, d.text, 'text/plain'); } catch (e) { toast(say(e)); } };
  const agentView = { licences: m.standing?.licences, kind: m.agent?.kind, young: false };

  return (
    <View style={{ gap: 14 }}>
      {onBack && !wide ? <Btn small title="‹ All" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} /> : null}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 200 }}>
            <T weight="800" size={18}>{athleteSide ? m.agent.display_name : m.athlete.display_name}</T>
            <T size={13} color={c.mute}>{m.mandate_no} · {athleteSide ? (m.agent.kind === 'agency' ? 'Agency' : 'Agent') : 'Athlete'}</T>
          </View>
          <View style={{ gap: 4, alignItems: 'flex-end' }}><LiveTag m={m} />{m.standing?.verified ? <Tag label="Verified agent" color={c.mint} /> : <Tag label="Not verified" color={c.pinkSoft} />}</View>
        </View>
        {m.status === 'active' && !m.live ? <View style={{ marginTop: 10 }}><Note tone={c.pinkSoft}>The agent has no access to anything right now: {nice(m.not_live_reason)}. Your terms, notes and commission records stay.</Note></View> : null}
        {m.status === 'revoked' ? <View style={{ marginTop: 10 }}><Note tone={c.violetSoft}>Ended {when(m.ended_at)}{m.end_kind ? ` · ${nice(m.end_kind)}` : ''}. Access stopped immediately; the records below stay.</Note></View> : null}
      </Card>

      {m.pending ? (
        <Card color={c.sunSoft}>
          <T weight="800">Version {m.pending.version} is waiting for signatures</T>
          <T size={13} color={c.mute} style={{ marginTop: 2 }}>Proposed by {m.pending.proposed_by_name}{m.pending.reason ? ` · "${m.pending.reason}"` : ''}. Waiting for: {m.pending.waiting_for.map(nice).join(', ') || 'nobody'}.</T>
          <View style={{ marginTop: 8 }}>
            {m.pending.version === 1 || !cur ? <TermsCard v={m.pending} matrix={matrix.data} sports={maps.byId} /> : <><T weight="800" size={13} style={{ marginBottom: 4 }}>What changes</T><Changes changes={m.pending.changes} matrix={matrix.data} sports={maps.byId} /></>}
          </View>
          {m.pending.version === 1 || !cur ? <View style={{ marginTop: 10 }}><AccessList version={m.pending} matrix={matrix.data} /></View> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {m.can.sign_as.length ? <Btn small title={`Sign as ${m.can.sign_as.map(nice).join(' and ')}`} loading={busy} onPress={() => act(() => api.post(`/representation/mandates/${id}/versions/${m.pending.version}/decision`, { decision: 'sign' }), 'Signed')} /> : null}
            {m.can.sign_as.length ? <Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/representation/mandates/${id}/versions/${m.pending.version}/decision`, { decision: 'decline' }), 'Declined')} /> : null}
            {m.can.withdraw ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/representation/mandates/${id}/versions/${m.pending.version}/withdraw`), 'Withdrawn')} /> : null}
          </View>
        </Card>
      ) : null}
      {m.status === 'draft' ? (
        <Card color={c.sunSoft}>
          <T weight="800">A draft - nothing is shared until it is agreed</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn small title="Edit terms" color={c.paper} ink={c.ink} onPress={() => setSheet('edit')} />
            <Btn small title="Send for signature" loading={busy} onPress={() => act(() => api.post(`/representation/mandates/${id}/send`, { row_version: m.row_version }), 'Sent')} />
          </View>
        </Card>
      ) : null}

      {cur ? <Section title="Agreed terms" color={c.violet}><TermsCard v={cur} matrix={matrix.data} sports={maps.byId} /></Section> : m.status === 'draft' ? <Section title="Draft terms" color={c.violet}><TermsCard v={m.versions[0]} matrix={matrix.data} sports={maps.byId} /></Section> : null}

      {cur ? <Section title="What the agent can see and do" color={c.violet}><Card><AccessList version={cur} matrix={matrix.data} /></Card></Section> : null}

      <Section title="Who the agent is" color={c.violet}>
        <Card>
          {m.standing?.verified ? (
            <View style={{ gap: 4 }}>
              <T weight="800">Checked by the SportArena review team</T>
              {m.standing.checked.map((x) => <T key={x.key} size={13}>✓ {x.label}{x.note ? ` - ${x.note}` : ''}</T>)}
              <T size={12} color={c.mute}>Valid until {plainDate(m.standing.expires_at)}. This is not a statement that the agent is licensed everywhere, and not legal advice.</T>
            </View>
          ) : <T size={13} color={c.mute}>Not verified by SportArena right now.</T>}
          {m.standing?.licences?.length ? <View style={{ marginTop: 10, gap: 6 }}>{m.standing.licences.map((l) => <View key={l.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T size={13} style={{ flex: 1 }}>{l.issuing_body} · {l.grade || 'Registration'} · {l.jurisdiction}{l.reference_last4 ? ` · …${l.reference_last4}` : ''}{l.valid_to ? ` · until ${plainDate(l.valid_to)}` : ''}</T><Tag label={l.standing} color={l.standing === 'verified' ? c.mint : l.standing === 'expired' ? c.pinkSoft : c.violetSoft} /></View>)}</View> : null}
        </Card>
      </Section>

      {m.grants.length || decideSide ? <GrantsSection m={m} canGrant={decideSide && m.status === 'active'} reload={done} /> : null}

      {m.deals?.length || (cur?.commission?.length && m.status === 'active') ? <DealsSection m={m} athleteSide={athleteSide} decideSide={decideSide} reload={done} /> : null}
      <ConflictsSection m={m} athleteSide={athleteSide} decideSide={decideSide} />

      <Section title="Actions" color={c.violet}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn small title="Open the document" color={c.paper} ink={c.ink} onPress={doc} />
          {m.can.amend ? <Btn small title={m.status === 'expired' ? 'Renew' : 'Propose a change'} color={c.paper} ink={c.ink} onPress={() => setSheet(m.status === 'expired' ? 'renew' : 'amend')} /> : null}
          {m.status === 'active' && m.live ? <Btn small title="Renew early" color={c.paper} ink={c.ink} onPress={() => setSheet('renew')} /> : null}
          {m.can.revoke ? <Btn small title={athleteSide ? 'Revoke now' : 'End from my side'} color={c.red} onPress={() => setConfirm('end')} /> : m.can.end ? <Btn small title="End from my side" color={c.red} onPress={() => setConfirm('end')} /> : null}
        </View>
        {decideSide && m.status === 'active' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <View style={{ flex: 1 }}><T weight="700">Show on my public profile</T><T size={12} color={c.mute}>Off by default. Shows who represents you, never terms or commission.</T></View>
            <Switch accessibilityLabel="Show representation on my public profile" value={m.show_on_profile} onValueChange={(show) => act(() => api.post(`/representation/mandates/${id}/profile-visibility`, { show }))} trackColor={{ true: c.pink }} />
          </View>
        ) : null}
      </Section>

      <Section title="History" color={c.violet}>
        {m.events.length ? m.events.slice(0, 40).map((e) => (
          <Row key={e.seq} title={EVENT[e.action] ?? sentence(e.action)} sub={`${e.actor ?? 'The platform'} · ${nice(e.actor_side)} · ${when(e.created_at)}`} />
        )) : <Empty emoji="🕘" title="Nothing yet" />}
      </Section>

      <TermsSheet visible={sheet === 'edit' || sheet === 'amend' || sheet === 'renew'} onClose={() => setSheet(null)} agent={agentView}
        title={sheet === 'edit' ? 'Edit the draft' : sheet === 'renew' ? 'Renew' : 'Propose a change'} submitLabel={sheet === 'edit' ? 'Save draft' : 'Propose for signature'}
        version={sheet === 'renew' ? { ...cur, starts_on: cur?.ends_on, ends_on: undefined } : sheet === 'edit' ? m.versions[0] : cur}
        notice={sheet === 'edit' ? null : 'Nothing changes until every required party signs. Until then the agreed version stays in force.'}
        onSubmit={async (terms) => {
          if (sheet === 'edit') await api.patch(`/representation/mandates/${id}`, { row_version: m.row_version, terms });
          else await api.post(`/representation/mandates/${id}/versions`, { kind: sheet === 'renew' ? 'renewal' : 'amendment', base_version: m.current_version, terms });
          setSheet(null); done();
        }} />
      <Confirm visible={confirm === 'end'} title={athleteSide ? 'Revoke this representation?' : 'End this mandate?'} danger label={athleteSide ? 'Revoke now' : 'End it'}
        body={athleteSide ? 'The agent loses all access to your information immediately and every shared item closes. The agreed terms, notes, commission records and history are kept.' : 'You lose access to the athlete\'s information immediately. Your records and commission history are kept.'}
        onClose={() => setConfirm(null)} onConfirm={async () => { await act(() => api.post(`/representation/mandates/${id}/end`, {}), 'Ended'); setConfirm(null); }} />
    </View>
  );
}

// ------------------------------------------------------------------ what is shared
function GrantsSection({ m, canGrant, reload }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const live = m.grants.filter((g) => !g.revoked_at);
  const allowed = m.current ? Object.entries({ passport_video: 'recruitment_materials', billboard_response: 'opportunity_applications', player_contract: 'contract_workflow', sponsorship: 'sponsorship_discussions' }).filter(([, cat]) => m.current.data_access.includes(cat)).map(([t]) => t) : [];
  const titles = useLoad(async () => (await api.get(`/representation/mandates/${m.id}/grants`)).reduce((o, g) => ({ ...o, [g.id]: g.title }), {}), [m.id, m.grants.length]);
  return (
    <Section title="Shared with the agent" color={c.violet} action={canGrant && allowed.length ? 'Share an item' : undefined} onAction={() => setOpen(true)}>
      {live.length ? live.map((g) => (
        <Row key={g.id} title={titles.data?.[g.id] ?? SUBJECTS[g.subject_type]} sub={`${SUBJECTS[g.subject_type]} · ${g.level === 'participate' ? 'may comment' : 'view only'} · since ${when(g.granted_at)}`}
          right={canGrant || m.side === 'youth' ? <Btn small title="Stop" color={c.paper} ink={c.ink} onPress={async () => { try { await api.del(`/representation/grants/${g.id}`); toast('Stopped sharing'); reload(); } catch (e) { toast(say(e)); } }} /> : null} />
      )) : <Card><T size={13} color={c.mute}>{m.status === 'active' ? `Nothing private is shared. The agent sees only what anyone can see on your public passport${m.current?.data_access.includes('public_passport') ? '' : ' - and not even that, unless you allow it'}.` : 'Nothing is shared until the mandate is agreed and in force.'}</T></Card>}
      <ShareSheet visible={open} onClose={() => setOpen(false)} m={m} allowed={allowed} onDone={() => { setOpen(false); reload(); }} />
    </Section>
  );
}
function ShareSheet({ visible, onClose, m, allowed, onDone }) {
  const { toast } = useSession();
  const [type, setType] = useState(allowed[0]);
  const items = useLoad(() => (visible && type ? api.get(`/representation/mandates/${m.id}/grantable`, { subject_type: type }) : Promise.resolve(null)), [visible, type, m.id]);
  const share = async (it, level) => { try { await api.post(`/representation/mandates/${m.id}/grants`, { subject_type: type, subject_id: it.id, level }); toast('Shared'); onDone(); } catch (e) { toast(say(e)); } };
  return (
    <Sheet visible={visible} onClose={onClose} title="Share one item">
      <T size={13} color={c.mute}>Only the item you pick is shared, and only while the mandate is live. You can stop at any time.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{allowed.map((t) => <Chip key={t} label={SUBJECTS[t]} active={type === t} onPress={() => setType(t)} />)}</View>
      {items.loading ? <Loading /> : items.data?.items?.length ? items.data.items.map((it) => (
        <Row key={it.id} title={it.title} sub={it.sub ? nice(it.sub) : undefined} right={it.shared ? <Tag label="Shared" color={c.mint} /> : (
          <View style={{ gap: 6 }}><Btn small title="Share" onPress={() => share(it, 'view')} />{type === 'player_contract' ? <Btn small title="Share + may comment" color={c.paper} ink={c.ink} onPress={() => share(it, 'participate')} /> : null}</View>)} />
      )) : <Empty emoji="🗂️" title="Nothing to share here" sub={items.data?.reason ?? 'You have no items of this kind yet.'} />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ commission on deals
function DealsSection({ m, athleteSide, decideSide, reload }) {
  const { toast } = useSession();
  const [pay, setPay] = useState(null);
  const deals = m.deals;
  const details = useLoad(async () => Object.fromEntries(await Promise.all(deals.map(async (d) => [d.id, await api.get(`/representation/deals/${d.id}`)]))), [m.id, deals.length, JSON.stringify(deals.map((d) => d.ladder))]);
  const act = async (fn, ok) => { try { await fn(); toast(ok); reload(); } catch (e) { toast(say(e)); } };
  return (
    <Section title="Commission" color={c.violet}>
      {deals.length ? deals.map((d) => {
        const full = details.data?.[d.id];
        return (
          <Card key={d.id}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 180 }}><T weight="800">{nice(d.deal_type)} · {d.deal_ref}</T><T size={12} color={c.mute}>{full?.term?.text ?? ''}</T></View>
              <Tag label={d.status} color={d.status === 'confirmed' ? c.mint : d.status === 'proposed' ? c.sun : c.violetSoft} />
            </View>
            <View style={{ marginTop: 8 }}><Ladder ladder={d.ladder} currency={d.currency} /></View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {d.status === 'proposed' ? <Btn small title="Confirm" onPress={() => act(() => api.post(`/representation/deals/${d.id}/decision`, { decision: 'confirm' }), 'Confirmed')} /> : null}
              {d.status === 'proposed' ? <Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/representation/deals/${d.id}/decision`, { decision: 'decline' }), 'Declined')} /> : null}
              {!athleteSide && d.status === 'confirmed' && d.ladder.uninvoiced_cents > 0 ? <Btn small title="Issue statement" onPress={() => act(() => api.post(`/representation/deals/${d.id}/statements`, {}), 'Statement issued')} /> : null}
              {!athleteSide && d.status === 'confirmed' && d.ladder.invoiced_cents > d.ladder.settled_cents ? <Btn small title="Confirm payment received" color={c.paper} ink={c.ink} onPress={() => setPay({ d, who: 'agent' })} /> : null}
              {decideSide && d.status === 'confirmed' && d.ladder.invoiced_cents > d.ladder.reported_cents ? <Btn small title="I paid" color={c.paper} ink={c.ink} onPress={() => setPay({ d, who: 'athlete' })} /> : null}
            </View>
            {full?.milestones?.length ? <View style={{ marginTop: 8, gap: 6 }}>{full.milestones.map((x) => (
              <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <T size={13} style={{ flex: 1 }}>Milestone: {nice(x.milestone_key)} - {x.status}</T>
                {decideSide && x.status === 'claimed' ? <><Btn small title="Confirm" onPress={() => act(() => api.post(`/representation/milestones/${x.id}/decision`, { decision: 'confirm' }), 'Confirmed')} /><Btn small title="Reject" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/representation/milestones/${x.id}/decision`, { decision: 'reject' }), 'Rejected')} /></> : null}
              </View>))}</View> : null}
            {full?.statements?.length ? <View style={{ marginTop: 8 }}>{full.statements.map((s) => <T key={s.id} size={12} color={c.mute}>{s.statement_no} · {cash(s.amount_cents, s.currency)} · {s.status} · {plainDate(s.issued_at)}</T>)}</View> : null}
          </Card>
        );
      }) : <Card><T size={13} color={c.mute}>No deal carries commission yet. Share a contract or sponsorship, then link it to an agreed commission term.</T></Card>}
      {!athleteSide || decideSide ? <Btn small title="Link a deal" color={c.paper} ink={c.ink} onPress={() => setPay({ link: true })} style={{ alignSelf: 'flex-start' }} /> : null}
      {pay?.link ? <LinkDeal m={m} onClose={() => setPay(null)} onDone={() => { setPay(null); reload(); }} /> : null}
      {pay?.d ? (
        <FormSheet visible onClose={() => setPay(null)} title={pay.who === 'agent' ? 'Confirm payment received' : 'Tell your agent you paid'} submitLabel={pay.who === 'agent' ? 'Confirm received' : 'Report payment'}
          notice={pay.who === 'agent' ? 'Only this makes the money "settled".' : 'This is your report. It is settled only when the agent confirms they received it.'}
          fields={[{ key: 'amount_cents', label: 'Amount', type: 'money', currency: pay.d.currency }, { key: 'reference', label: pay.who === 'agent' ? 'Bank or payment reference' : 'Your payment reference', type: 'text' }]}
          initial={{ amount_cents: Math.max(0, pay.who === 'agent' ? pay.d.ladder.invoiced_cents - pay.d.ladder.settled_cents : pay.d.ladder.invoiced_cents - pay.d.ladder.reported_cents) }}
          onSubmit={async (v) => { await api.post(pay.who === 'agent' ? `/representation/deals/${pay.d.id}/payments` : `/representation/deals/${pay.d.id}/payments-reported`, { amount_cents: v.amount_cents, reference: v.reference }); setPay(null); toast('Recorded'); reload(); }} />
      ) : null}
    </Section>
  );
}
function LinkDeal({ m, onClose, onDone }) {
  const { toast } = useSession();
  const [type, setType] = useState('player_contract');
  const grants = m.grants.filter((g) => !g.revoked_at && g.subject_type === type);
  const titles = useLoad(async () => (await api.get(`/representation/mandates/${m.id}/grants`)).reduce((o, g) => ({ ...o, [g.id]: g.title }), {}), [m.id]);
  const terms = (m.current?.commission ?? []).filter((t) => t.applies_to.includes(type));
  const [term, setTerm] = useState(terms[0]?.key);
  const link = async (g) => { try { await api.post(`/representation/mandates/${m.id}/deals`, { deal_type: type, deal_id: g.subject_id, term_key: term ?? terms[0]?.key }); toast('Proposed - the other side confirms'); onDone(); } catch (e) { toast(say(e)); } };
  return (
    <Sheet visible onClose={onClose} title="Link a deal to commission">
      <T size={13} color={c.mute}>Pick one shared deal and the agreed commission term that applies. The other side confirms before anything accrues. A deal is counted once, however often it is amended.</T>
      <View style={{ flexDirection: 'row', gap: 6 }}>{[['player_contract', 'Contract'], ['sponsorship', 'Sponsorship']].map(([k, l]) => <Chip key={k} label={l} active={type === k} onPress={() => { setType(k); setTerm(undefined); }} />)}</View>
      {terms.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{terms.map((t) => <Chip key={t.key} label={t.label} active={(term ?? terms[0].key) === t.key} onPress={() => setTerm(t.key)} />)}</View> : null}
      {!terms.length ? <Note>No commission term in this mandate applies to that kind of deal.</Note> : grants.length ? grants.map((g) => <Row key={g.id} title={titles.data?.[g.id] ?? 'Shared item'} onPress={() => link(g)} right={<T size={13} weight="700" color={c.pink}>Link ›</T>} />) : <Empty emoji="🔗" title="Nothing shared of this kind" sub="Share the deal first." />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ conflicts
function ConflictsSection({ m, athleteSide, decideSide }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const list = useLoad(() => api.get(`/representation/mandates/${m.id}/conflicts`), [m.id, m.open_conflicts]);
  const [note, setNote] = useState(null);
  const decide = async (cf, decision) => { try { await api.post(`/representation/conflicts/${cf.id}/decision`, { decision }); toast('Recorded'); list.reload(); } catch (e) { toast(say(e)); } };
  const rows = list.data ?? [];
  if (!rows.length && m.status !== 'active') return null;
  return (
    <Section title="Conflicts of interest" color={c.violet} action={m.status === 'active' ? 'Disclose one' : undefined} onAction={() => setOpen(true)}>
      {rows.length ? rows.map((cf) => (
        <Card key={cf.id} color={cf.status === 'open' ? c.sunSoft : c.paper}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" style={{ flex: 1 }}>{sentence(cf.kind)}{cf.counterparty ? ` · ${cf.counterparty}` : ''}</T><Tag label={cf.status} color={cf.status === 'open' ? c.sun : c.violetSoft} /></View>
          {cf.detail ? <T size={13} style={{ marginTop: 4 }}>{cf.detail}</T> : null}
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>Flagged by {cf.raised_by === 'system' ? 'SportArena\'s automatic comparison' : cf.raised_by}. SportArena does not decide whether it is acceptable.{cf.can_acknowledge ? '' : ' Under policy it cannot simply be accepted.'}</T>
          {cf.status === 'open' || cf.status === 'acknowledged' ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {decideSide && cf.status === 'open' && cf.can_acknowledge ? <Btn small title="I understand and accept" onPress={() => decide(cf, 'acknowledge')} /> : null}
              {decideSide ? <Btn small title="Reject" color={c.paper} ink={c.ink} onPress={() => decide(cf, 'reject')} /> : null}
              {!athleteSide ? <Btn small title="Step back (recuse)" color={c.paper} ink={c.ink} onPress={() => decide(cf, 'recuse')} /> : null}
              {cf.status === 'open' && cf.raised_by !== 'system' && ((athleteSide && cf.raised_by === 'athlete') || (!athleteSide && cf.raised_by === 'agent')) ? <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => decide(cf, 'withdraw')} /> : null}
            </View>) : null}
        </Card>
      )) : <Card><T size={13} color={c.mute}>None disclosed or flagged. Anyone on the mandate can disclose one: representing both sides of a negotiation, an interest in a club or sponsor, dual representation, or a related-party relationship.</T></Card>}
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Disclose a conflict of interest" submitLabel="Disclose"
        fields={[{ key: 'kind', label: 'What kind', type: 'chips', options: [{ value: 'opposing_sides', label: 'Opposing sides' }, { value: 'agent_interest', label: 'Agent interest' }, { value: 'dual_representation', label: 'Dual representation' }, { value: 'related_party', label: 'Related party' }] },
          { key: 'counterparty', label: 'Who it involves', type: 'text', optional: true }, { key: 'detail', label: 'What the situation is', type: 'multiline' }]}
        initial={{ kind: 'agent_interest' }} onSubmit={async (v) => { await api.post(`/representation/mandates/${m.id}/conflicts`, { kind: v.kind, counterparty: v.counterparty || undefined, detail: v.detail }); setOpen(false); toast('Disclosed'); list.reload(); }} />
    </Section>
  );
}
export { key };

/** The commission and conflicts sections of one mandate on their own, for the agent's Commissions and Conflicts tabs. */
export function DealsPanel({ id }) {
  const q = useLoad(() => api.get(`/representation/mandates/${id}`), [id]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const m = q.data;
  const athleteSide = ['athlete', 'guardian', 'youth'].includes(m.side);
  return <DealsSection m={m} athleteSide={athleteSide} decideSide={['athlete', 'guardian'].includes(m.side)} reload={q.reload} />;
}
export function ConflictsPanel({ id }) {
  const q = useLoad(() => api.get(`/representation/mandates/${id}`), [id]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const m = q.data;
  return <ConflictsSection m={m} athleteSide={['athlete', 'guardian', 'youth'].includes(m.side)} decideSide={['athlete', 'guardian'].includes(m.side)} />;
}
