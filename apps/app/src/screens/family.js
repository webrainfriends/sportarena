import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { c } from '../theme';

const when = (d) => (d ? new Date(d).toLocaleDateString() : '');
const label = (s) => String(s).replace(/_/g, ' ');
const STATE = {
  invited: ['Waiting for an answer', c.sunSoft], accepted: ['Add proof', c.orangeSoft], pending_review: ['Being checked', c.cyanSoft], active: ['Verified', c.lime],
  declined: ['Declined', c.violetSoft], rejected: ['Not verified', c.pinkSoft], revoked: ['Ended', c.violetSoft],
};
const PURPOSES = {
  participation: ['Take part', 'Join teams, games and events, and be checked in and out.'],
  medical: ['Health sharing', 'Share fit-to-play status and records with a physio or doctor, and book appointments.'],
  media: ['Photos & video', 'Photos and video of them may be used in team and event pages.'],
  contact: ['Messages', 'Let them write in team chats.'],
};
const CONSENT_STATE = { active: ['Allowed', c.lime], expired: ['Expired — renew to allow again', c.orangeSoft], revoked: ['Withdrawn', c.pinkSoft], not_given: ['Not allowed', c.violetSoft], lapsed: ['Paused — guardian not verified', c.orangeSoft] };
const stateTag = (s) => <Tag label={STATE[s]?.[0] ?? label(s)} color={STATE[s]?.[1]} />;

function Consents({ child, onClose }) {
  const { toast } = useSession();
  const d = useLoad(() => (child ? api.get(`/youth/children/${child.id}/consents`) : Promise.resolve(null)), [child?.id]);
  const run = async (fn, msg) => { try { await fn(); toast(msg); d.reload(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible={!!child} onClose={onClose} title={child ? `${child.display_name}'s permissions` : 'Permissions'}>
      {d.loading && !d.data ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : d.data ? <>
        <T size={13} color={c.mute}>Each permission is separate and runs out on its own. If any guardian withdraws one, it stops for everyone.</T>
        {d.data.consents.map((k) => (
          <Card key={k.purpose} pad={12} color={c.paper}>
            <T weight="800">{PURPOSES[k.purpose][0]}</T>
            <T size={12} color={c.mute}>{PURPOSES[k.purpose][1]}</T>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
              <Tag label={CONSENT_STATE[k.state][0]} color={CONSENT_STATE[k.state][1]} />
              {k.state === 'active' ? <T size={12} color={c.mute}>until {when(k.expires_at)}</T> : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {k.state === 'active'
                ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => run(() => api.del(`/youth/children/${child.id}/consents/${k.purpose}`), 'Permission withdrawn')} />
                : <Btn small title={k.state === 'not_given' ? 'Allow' : 'Allow again'} color={c.pink} onPress={() => run(() => api.post(`/youth/children/${child.id}/consents`, { purpose: k.purpose }), 'Permission saved')} />}
            </View>
          </Card>
        ))}
        {d.data.history.length ? <><T weight="800" size={13}>History</T>
          {d.data.history.slice(0, 15).map((h, i) => <T key={i} size={12} color={c.mute}>{when(h.created_at)} · {PURPOSES[h.purpose][0]} {h.action === 'grant' ? 'allowed' : 'withdrawn'} by {h.actor_name ?? 'someone'}</T>)}</> : null}
      </> : null}
    </Sheet>
  );
}

function Pickup({ child, onClose }) {
  const { toast } = useSession();
  const d = useLoad(() => (child ? api.get(`/youth/children/${child.id}/pickup-delegates`) : Promise.resolve([])), [child?.id]);
  const hist = useLoad(() => (child ? api.get('/youth/check-ins', { child_id: child.id, limit: 10 }) : Promise.resolve([])), [child?.id]);
  const [form, setForm] = useState(false);
  return (
    <Sheet visible={!!child} onClose={onClose} title={child ? `${child.display_name}: pickup & check-in` : 'Pickup'}>
      <T size={13} color={c.mute}>Coaches can only hand a child to a verified guardian or to someone listed here, for the dates you choose.</T>
      <Btn title="Allow someone to collect" color={c.pink} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {d.loading && !d.data ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : d.data?.length ? d.data.map((x) => (
        <Row key={x.id} title={x.delegate_display_name ?? x.delegate_name} sub={x.active ? `Allowed until ${when(x.expires_at)}` : x.revoked_at ? 'Withdrawn' : 'Expired'}
          right={x.active ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/youth/pickup-delegates/${x.id}`); toast('Withdrawn'); d.reload(); } catch (e) { toast(e.message); } }} /> : null} />
      )) : <Empty emoji="🚸" title="No one else is allowed to collect" sub="Only verified guardians can collect until you add someone." />}
      <T weight="800" size={13}>Recent check-ins</T>
      {hist.data?.length ? hist.data.map((h) => <T key={h.id} size={12} color={c.mute}>{new Date(h.at).toLocaleString()} · {h.kind === 'drop_off' ? 'Arrived' : 'Collected'}</T>) : <T size={12} color={c.mute}>Nothing recorded yet. Coaches and guardians check children in and out from the team.</T>}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Allow someone to collect" submitLabel="Allow"
        fields={[
          { key: 'delegate_handle', label: 'Their username (if they have an account)', optional: true, hint: 'Leave empty to add just a name.' },
          { key: 'delegate_name', label: 'Their name', optional: true, hint: 'Stored encrypted. Show it to the coach at pickup.' },
          { key: 'valid_days', label: 'For how many days?', type: 'stepper', min: 1, max: 90, default: 30, suffix: ' days' },
        ]}
        onSubmit={async (v) => {
          if (!v.delegate_handle && !v.delegate_name) throw new Error('Enter a username or a name');
          await api.post(`/youth/children/${child.id}/pickup-delegates`, { child_id: child.id, delegate_handle: v.delegate_handle || undefined, delegate_name: v.delegate_name || undefined, valid_days: v.valid_days });
          d.reload();
          return 'They can now collect';
        }} />
    </Sheet>
  );
}

function LinkCard({ l, reload, onConsents, onPickup }) {
  const { toast } = useSession();
  const [ev, setEv] = useState(false);
  const run = async (fn, msg) => { try { await fn(); toast(msg); reload(); } catch (e) { toast(e.message); } };
  const mine = l.my_side;
  const other = mine === 'guardian' ? l.child : l.guardian;
  const waitingOnMe = l.status === 'invited' && l.requested_by !== (mine === 'guardian' ? l.guardian_id : l.child_id);
  return (
    <Card pad={14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800">{other?.display_name} <T size={12} color={c.mute}>({mine === 'guardian' ? 'your child' : 'your guardian'} · {label(l.relationship)})</T></T>
        {stateTag(l.status)}
      </View>
      {l.status === 'active' ? <T size={12} color={c.mute}>Verified until {when(l.expires_at)}. Renew by asking again before it ends.</T> : null}
      {l.status === 'rejected' && l.decision_note ? <T size={12} color={c.mute}>Reason: {l.decision_note}</T> : null}
      {l.needs_existing_guardian_approval && ['invited', 'accepted', 'pending_review'].includes(l.status) ? <T size={12} color={c.mute}>Another guardian already looks after this child, so they need to approve this request first.</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        {waitingOnMe ? <>
          <Btn small title="Accept" color={c.pink} onPress={() => run(() => api.post(`/youth/guardian-links/${l.id}/respond`, { accept: true }), 'Accepted')} />
          <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => run(() => api.post(`/youth/guardian-links/${l.id}/respond`, { accept: false }), 'Declined')} />
        </> : null}
        {mine === 'guardian' && ['accepted', 'pending_review'].includes(l.status) ? <Btn small title={l.status === 'accepted' ? 'Add proof' : 'Add more proof'} color={c.violet} onPress={() => setEv(true)} /> : null}
        {mine === 'guardian' && l.status === 'active' ? <>
          <Btn small title="Permissions" color={c.pink} onPress={() => onConsents(l.child)} />
          <Btn small title="Pickup & check-in" color={c.violet} onPress={() => onPickup(l.child)} />
        </> : null}
        {(mine === 'guardian' && ['active', 'invited', 'accepted', 'pending_review'].includes(l.status)) || (l.requested_by === (mine === 'guardian' ? l.guardian_id : l.child_id) && ['invited', 'accepted', 'pending_review'].includes(l.status))
          ? <Btn small title={l.status === 'active' ? 'End link' : 'Withdraw request'} color={c.paper} ink={c.red} onPress={() => run(() => api.post(`/youth/guardian-links/${l.id}/revoke`, { reason: 'Ended from the app' }), 'Link ended')} /> : null}
      </View>
      <FormSheet visible={ev} onClose={() => setEv(false)} title="Proof of relationship" submitLabel="Send for checking"
        fields={[
          { key: 'label', label: 'What is it?', hint: 'For example: birth certificate or court order.' },
          { key: 'reference', label: 'Link or reference number', hint: 'An https:// link to the document, or its reference number. Only the platform team can open it.' },
        ]}
        onSubmit={async (v) => { await api.post(`/youth/guardian-links/${l.id}/evidence`, { evidence: { label: v.label, reference: v.reference } }); reload(); return 'Sent. The platform team will check it.'; }} />
    </Card>
  );
}

function ApprovalRequests() {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/youth/guardian-links', { approvals: true, limit: 50 }), []);
  if (!q.data?.length) return null;
  return (
    <Section title="Needs your approval" color={c.orange}>
      {q.data.map((l) => (
        <Card key={l.id} pad={14}>
          <T weight="800">{l.guardian?.display_name} asked to be a guardian of {l.child?.display_name}</T>
          <T size={12} color={c.mute}>Approve only if you know this person. The platform team still checks their proof.</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small title="Approve" color={c.pink} onPress={async () => { try { await api.post(`/youth/guardian-links/${l.id}/approve`, {}); toast('Approved'); q.reload(); } catch (e) { toast(e.message); } }} />
          </View>
        </Card>
      ))}
    </Section>
  );
}

function Review() {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/youth/reviews', { limit: 50 }), []);
  const [open, setOpen] = useState(null);
  const [ev, setEv] = useState(null);
  const show = async (l) => { try { setEv(await api.get(`/youth/guardian-links/${l.id}/evidence`)); setOpen(l); } catch (e) { toast(e.message); } };
  return (
    <Section title="Guardian checks (platform team)" color={c.violet}>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : q.data?.length ? q.data.map((l) => (
        <Row key={l.id} onPress={() => show(l)} title={`${l.guardian?.display_name} → ${l.child?.display_name}`} sub={`${label(l.relationship)} · asked ${when(l.created_at)}${l.needs_existing_guardian_approval ? ' · needs existing guardian approval' : ''}`} />
      )) : <Empty emoji="✅" title="Nothing waiting" sub="New guardian requests with proof appear here." />}
      <Sheet visible={!!open} onClose={() => { setOpen(null); setEv(null); }} title="Check guardian proof">
        {ev?.map((e) => <Card key={e.id} pad={12}><T weight="800">{e.label ?? 'Evidence'}</T><T size={12} selectable>{e.reference ?? e.file?.name}</T></Card>)}
        <T size={12} color={c.mute}>Opening this was logged. Approve only when the proof shows this adult is responsible for this child.</T>
        <DecisionButtons l={open} done={() => { setOpen(null); setEv(null); q.reload(); }} />
      </Sheet>
    </Section>
  );
}

function DecisionButtons({ l, done }) {
  const { toast } = useSession();
  const [form, setForm] = useState(null);
  if (!l) return null;
  return <>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Btn title="Verify" color={c.pink} onPress={() => setForm('approve')} />
      <Btn title="Reject" color={c.paper} ink={c.red} onPress={() => setForm('reject')} />
    </View>
    <FormSheet visible={!!form} onClose={() => setForm(null)} title={form === 'approve' ? 'Verify this guardian' : 'Reject this request'} submitLabel="Save"
      fields={[
        { key: 'note', label: 'Note for the record', type: 'multiline', hint: 'What you checked. The guardian sees this if rejected.' },
        { key: 'exceptional', label: 'Exceptional review (no existing guardian approval)', type: 'switch', default: false, show: () => form === 'approve' },
      ]}
      onSubmit={async (v) => { try { await api.post(`/youth/guardian-links/${l.id}/decision`, { decision: form, note: v.note, exceptional: !!v.exceptional }); } catch (e) { toast(e.message); throw e; } done(); return form === 'approve' ? 'Guardian verified' : 'Request rejected'; }} />
  </>;
}

/** Pushed screen: family links, permissions, pickup — for guardians and for young people. */
export function Family() {
  const { user } = useSession();
  const st = useLoad(() => api.get('/me/youth'), []);
  const links = useLoad(() => api.get('/youth/guardian-links', { limit: 100 }), []);
  const [ask, setAsk] = useState(null);
  const [consents, setConsents] = useState(null);
  const [pickup, setPickup] = useState(null);
  const reload = () => { st.reload(); links.reload(); };
  const status = st.data;
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Family & guardians</H1>
      <T size={13} color={c.mute}>A guardian looks after a young person's permissions and who can collect them. Nobody can make themselves a guardian: the other person accepts, and the platform team checks proof.</T>
      {st.loading && !st.data ? <Loading /> : st.error ? <ErrorBox error={st.error} onRetry={st.reload} /> : status?.is_youth ? (
        <Card color={c.cyanSoft}>
          <T weight="800">Your account is a young person's account</T>
          <T size={13}>Your profile is private. You become independent on {status.independent_on}.</T>
          <T size={13} color={c.mute}>{status.active_guardians ? `${status.active_guardians} verified guardian${status.active_guardians > 1 ? 's' : ''}.` : 'You need a verified guardian before you can join teams or share health information.'}</T>
        </Card>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginVertical: 10 }}>
        {status?.is_youth
          ? <Btn title="Ask a parent or guardian" color={c.pink} onPress={() => setAsk('child')} />
          : <Btn title="Add a child I look after" color={c.pink} onPress={() => setAsk('guardian')} />}
      </View>
      <Section title="Family links" color={c.pink}>
        {links.loading && !links.data ? <Loading /> : links.error ? <ErrorBox error={links.error} onRetry={links.reload} /> : links.data?.length
          ? links.data.map((l) => <LinkCard key={l.id} l={l} reload={reload} onConsents={setConsents} onPickup={setPickup} />)
          : <Empty emoji="👨‍👩‍👧" title="No family links yet" sub={status?.is_youth ? 'Ask a parent or guardian to link with your account.' : 'Add a child you look after to manage their permissions.'} />}
      </Section>
      <ApprovalRequests />
      {user.roles.includes('admin') ? <Review /> : null}
      <FormSheet visible={!!ask} onClose={() => setAsk(null)} title={ask === 'child' ? 'Ask a guardian' : 'Add a child'} submitLabel="Send request"
        fields={[
          { key: 'handle', label: ask === 'child' ? "Your guardian's username" : "Your child's username", hint: ask === 'child' ? 'They must be an adult with an account.' : 'The child needs an account with their date of birth. They will be asked to accept.' },
          { key: 'relationship', label: 'Relationship', type: 'chips', options: ['parent', 'legal_guardian', 'foster_carer', 'other'].map((x) => ({ value: x, label: label(x) })), default: 'parent' },
        ]}
        onSubmit={async (v) => { await api.post('/youth/guardian-links', { handle: v.handle.trim(), as: ask === 'child' ? 'child' : 'guardian', relationship: v.relationship }); reload(); return 'Request sent. They will be asked to accept.'; }} />
      <Consents child={consents} onClose={() => setConsents(null)} />
      <Pickup child={pickup} onClose={() => setPickup(null)} />
    </Screen>
  );
}
