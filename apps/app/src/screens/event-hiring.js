// Hiring for an event: open paid or volunteer positions (referees, medics, volunteers, stalls …), find and invite people, review
// applications, send and track contracts. Departments (who is on which team) are a separate tab; a position is a hire with a fee and a contract.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, ABar, ABtn, ACard, AEmpty, ARow, ASection, AStat, AT, ATag } from '../arena';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { ContractSheet, PositionDocs } from './openings';
import { useDo } from './console-utils';

export const ROLES = [['retail', 'Retail stall'], ['catering', 'Catering'], ['vendor', 'Other vendor'], ['referee', 'Referee'], ['umpire', 'Umpire'], ['linesman', 'Linesman'], ['scorer', 'Scorer'], ['doctor', 'Doctor'], ['physio', 'Physio'], ['medic', 'Medic'], ['volunteer', 'Volunteer'], ['security', 'Security'], ['other', 'Other']];
export const ROLE_ICON = { retail: '🛍️', catering: '🍽️', vendor: '🏪', referee: '🟨', umpire: '🧑‍⚖️', linesman: '🚩', scorer: '📝', doctor: '🩺', physio: '💆', medic: '⛑️', volunteer: '🙋', security: '🛡️', other: '🔧' };
const STATUS_LABEL = { applied: 'applied', contract_sent: 'contract sent', accepted: 'confirmed' };
const STALL = ['retail', 'catering', 'vendor'];
const roleName = (r) => r.title || ROLES.find(([k]) => k === r.role)?.[1];

/** One application: what the person wrote, documents both ways, and the organiser's decision (accept = generate a contract). */
function ReviewSheet({ a, e, onClose, reload }) {
  const { toast } = useSession();
  const [docs, setDocs] = useState(false), [accept, setAccept] = useState(false), [contract, setContract] = useState(false);
  const vendor = a.pay_direction === 'applicant_pays';
  const fee = moneyIn(a.proposed_fee_cents ?? a.fee_cents, e.currency);
  const decide = async (decision, extra = {}) => { try { await api.post(`/staff-assignments/${a.id}/decide`, { decision, ...extra }); toast(decision === 'accept' ? 'Contract sent to the applicant' : 'Application declined'); reload(); onClose(); } catch (x) { toast('' + x.message); } };
  return (
    <Sheet visible onClose={onClose} title={a.display_name}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Tag label={`${ROLE_ICON[a.role]} ${a.title || a.role}`} /><Tag label={STATUS_LABEL[a.status] ?? a.status} /><Tag label={vendor ? `Stall fee ${fee}` : `Fee ${fee}`} color={c.limeSoft} />
      </View>
      <T size={12} color={c.mute}>@{a.handle}</T>
      {a.message ? <Card pad={12}><T size={14}>{a.message}</T></Card> : <T color={c.mute}>No message from the applicant.</T>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn small title={`Documents${a.documents ? ` (${a.documents})` : ''}`} color={c.violet} onPress={() => setDocs(true)} />
        {a.contract_id ? <Btn small title="View contract" color={c.paper} ink={c.ink} onPress={() => setContract(true)} /> : null}
      </View>
      {a.status === 'applied' ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn title="Accept & create contract" color={c.lime} onPress={() => setAccept(true)} />
          <Btn title="Decline" color={c.paper} ink={c.red} onPress={() => decide('reject')} />
        </View>
      ) : a.status === 'contract_sent' ? <T size={13} color={c.mute}>Waiting for {a.display_name} to accept the contract.</T> : null}
      {['contract_sent', 'accepted'].includes(a.status) ? <Btn small title="Release" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/staff-assignments/${a.id}/end`, {}); toast('Released'); reload(); onClose(); } catch (x) { toast('' + x.message); } }} style={{ alignSelf: 'flex-start' }} /> : null}
      {docs ? <PositionDocs assignmentId={a.id} title={`${a.display_name} · documents`} onClose={() => setDocs(false)} onChanged={reload} /> : null}
      {contract ? <ContractSheet id={a.contract_id} onClose={() => setContract(false)} onChanged={reload} /> : null}
      <FormSheet visible={accept} onClose={() => setAccept(false)} title="Create the contract" submitLabel="Send contract" initial={{ fee: Number(a.proposed_fee_cents ?? a.fee_cents) || undefined }}
        fields={[{ key: 'fee', label: vendor ? 'Stall fee the vendor pays' : 'Agreed fee', type: 'money', currency: e.currency, optional: true, hint: 'The contract is generated from the event, the position and this fee. The applicant reviews it and accepts to be confirmed.' }, { key: 'terms', label: 'Extra terms', type: 'multiline', optional: true, hint: 'Shown in the contract: reporting time, uniform, payment date, cancellation…' }]}
        onSubmit={async (v) => { await decide('accept', { fee_cents: v.fee ?? undefined, terms: v.terms || undefined }); return null; }} />
    </Sheet>
  );
}

export function HiringTab({ id, e, roles, staff, reload }) {
  const [open, setOpen] = useState(false), [find, setFind] = useState(null), [q, setQ] = useState(''), [review, setReview] = useState(null), [applicantsOf, setApplicantsOf] = useState(null);
  const act = useDo(reload);
  const cands = useLoad(() => (find ? api.get(`/events/${id}/staff-candidates`, { role: find.role, q: q || undefined, limit: 30 }) : Promise.resolve([])), [find?.id, q]);
  const filled = roles.reduce((n, r) => n + r.filled, 0), needed = roles.reduce((n, r) => n + r.needed, 0);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="✅" label="Confirmed" value={filled} tone={A.green} /><AStat icon="📌" label="Places open" value={Math.max(needed - filled, 0)} /><AStat icon="⏳" label="Waiting reply" value={roles.reduce((n, r) => n + r.pending, 0)} tone={A.sun} />
      </View>
      <ABtn title="Open a position" onPress={() => setOpen(true)} />
      {roles.length ? roles.map((r) => (
        <ACard key={r.id} pad={14}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: A.panel2, alignItems: 'center', justifyContent: 'center' }}><AT size={22}>{ROLE_ICON[r.role]}</AT></View>
            <View style={{ flex: 1 }}>
              <AT size={15} weight="800">{roleName(r)}{r.closed_at ? ' · closed' : ''}</AT>
              <AT size={12} weight="600" color={A.mute}>{r.filled}/{r.needed} confirmed{r.pending ? ` · ${r.pending} waiting` : ''}{r.applicants ? ` · ${r.applicants} applied` : ''} · {r.pay_direction === 'applicant_pays' ? (r.fee_cents ? `stall fee ${moneyIn(r.fee_cents, r.currency)}` : 'no stall fee') : r.fee_cents ? `${moneyIn(r.fee_cents, r.currency)} each` : 'unpaid'}{r.is_public === false ? ' · hidden from the arena' : ''}</AT>
            </View>
          </View>
          <View style={{ marginTop: 10 }}><ABar pct={(r.filled / r.needed) * 100} color={r.filled >= r.needed ? A.green : A.magenta} /></View>
          {!r.closed_at ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {r.applicants ? <ABtn small tone="lime" title={`Applicants (${r.applicants})`} onPress={() => setApplicantsOf(r)} /> : null}
              <ABtn small tone="neon" title="Find people" onPress={() => { setFind(r); setQ(''); }} />
              <ABtn small tone="ghost" title="Close" onPress={() => act(() => api.post(`/staff-roles/${r.id}/close`), 'Closed')} />
            </View>
          ) : null}
        </ACard>
      )) : <AEmpty emoji="🩺" title="No positions yet" sub="Referees, scorers, doctors, physios, volunteers and security." />}

      <ASection title="Team sheet" sub="Everyone invited, applied or confirmed" />
      {staff.length ? staff.map((a) => (
        <ARow key={a.id} left={<AT size={24}>{ROLE_ICON[a.role]}</AT>} title={a.display_name} sub={`${a.title || a.role}${a.fee_cents ? ` · ${moneyIn(a.fee_cents, e.currency)}` : ''}`}
          right={<>
            <ATag label={STATUS_LABEL[a.status] ?? a.status} />
            {['applied', 'contract_sent', 'accepted'].includes(a.status) && a.source === 'application' ? <ABtn small tone="neon" title={a.status === 'applied' ? 'Review' : 'Details'} onPress={() => setReview(a)} /> : null}
            {['invited', 'accepted'].includes(a.status) && a.source !== 'application' ? <ABtn small tone="ghost" title="Release" onPress={() => act(() => api.post(`/staff-assignments/${a.id}/end`, {}), 'Released')} /> : null}
          </>} />
      )) : <AT size={13} color={A.mute}>Nobody invited or applied yet.</AT>}

      {applicantsOf ? (
        <Sheet visible onClose={() => setApplicantsOf(null)} title={`Applicants · ${roleName(applicantsOf)}`}>
          {staff.filter((a) => a.role_id === applicantsOf.id && ['applied', 'contract_sent'].includes(a.status)).map((a) => (
            <Row key={a.id} title={a.display_name} sub={`${a.message ? a.message.slice(0, 80) : 'No message'}${a.documents ? ` · ${a.documents} doc${a.documents === 1 ? '' : 's'}` : ''}`} onPress={() => { setApplicantsOf(null); setReview(a); }} right={<Tag label={STATUS_LABEL[a.status]} />} />
          ))}
        </Sheet>
      ) : null}
      {review ? <ReviewSheet a={staff.find((x) => x.id === review.id) ?? review} e={e} onClose={() => setReview(null)} reload={reload} /> : null}

      {find ? (
        <Sheet visible onClose={() => setFind(null)} title={`Find a ${roleName(find)}`}>
          <Field value={q} onChangeText={setQ} placeholder="Search by name…" />
          <T size={12} color={c.mute}>Only people with the right profile who are free on the event dates.</T>
          {cands.loading ? <Loading /> : (cands.data ?? []).length ? cands.data.map((p) => (
            <Row key={p.user_id} title={p.display_name} sub={[p.clinic, p.city, p.level, `@${p.handle}`].filter(Boolean).join(' · ')} right={<Btn small title="Invite" onPress={() => act(async () => { await api.post(`/staff-roles/${find.id}/invite`, { user_id: p.user_id }); setFind(null); }, 'Offer sent')} />} />
          )) : <Empty emoji="🔎" title="Nobody available" sub="Nobody with the right profile is free on these dates." />}
        </Sheet>
      ) : null}

      <FormSheet visible={open} onClose={() => setOpen(false)} title="Open a position" submitLabel="Open position" initial={{ role: 'referee', needed: 1, is_public: true }}
        fields={[{ key: 'role', label: 'Role', type: 'chips', options: ROLES.map(([value, label]) => ({ value, label: `${ROLE_ICON[value]} ${label}` })) }, { key: 'needed', label: 'How many people', type: 'stepper', min: 1, max: 100, default: 1 },
          { key: 'fee', label: 'Fee per person', type: 'money', currency: e.currency, optional: true, show: (v) => !STALL.includes(v.role) },
          { key: 'stall_fee', label: 'Stall fee the vendor pays you', type: 'money', currency: e.currency, optional: true, show: (v) => STALL.includes(v.role) },
          { key: 'notes', label: 'Notes for applicants', type: 'multiline', optional: true, hint: 'Hours, requirements, what to bring. Positions appear on the arena home page for everyone; people apply and you accept them here.' },
          { key: 'is_public', label: 'Show on the arena for anyone to apply', type: 'switch', default: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/staff-roles`, { role: v.role, needed: v.needed || 1, fee_cents: (STALL.includes(v.role) ? v.stall_fee : v.fee) || 0, notes: v.notes || undefined, is_public: v.is_public !== false }); reload(); return 'Position opened. It is now on the arena'; }} />
    </>
  );
}
