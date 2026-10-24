// Partners & risk: the sponsors who fund the academy, the physios / doctors it works with, and legal matters opened for it. All three are
// views onto their own canonical modules. This screen stores only the business link to a provider; it never shows clinical data, agreement
// terms or legal content, and the athlete's minimal fit status appears only when the athlete (or a guardian) chose to share it.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { Block, Fact, when } from './academy-ui';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const REL = [['preferred', 'Preferred'], ['retained', 'Retained'], ['on_call', 'On call'], ['programme_cover', 'Programme cover'], ['event_cover', 'Event cover'], ['referral_partner', 'Referral partner']];
const CLEAR = { cleared: 'Cleared', restricted: 'Restricted', not_cleared: 'Not cleared', expired: 'Expired', unknown: 'Unknown', not_shared: 'Not shared' };

export function Partners({ o, role, archived, toast }) {
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/partners`), [o.id]);
  const providers = useLoad(() => (role === 'finance' ? Promise.resolve([]) : api.get(`/organisations/${o.id}/academy/providers`)), [o.id, role]);
  const progs = useLoad(() => (role === 'finance' ? Promise.resolve([]) : api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 })), [o.id, role]);
  const [add, setAdd] = useState(null);
  const staff = role === 'owner' || role === 'admin';
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const p = d.data;
  return (
    <View style={{ gap: 14 }}>
      <Panel>
        <Block title="Sponsors & scholarships">
          <T size={12} color={c.mute}>From the Sponsorship module. You see only agreements you may see there, never their terms. A sponsor-funded fee is linked to its agreement on the charge (Finance → Charges).</T>
          {p.sponsorship.length ? p.sponsorship.map((s) => (
            <View key={s.sponsorship_id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 3 }}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="800" size={14} style={{ flex: 1 }}>{s.sponsor}</T><Tag label={s.status} color={s.status === 'active' ? c.lime : undefined} /></View>
              <T size={12} color={c.mute}>{s.target_type === 'group' ? 'Supports a group' : 'Supports the academy'}{s.starts_on ? ` · ${when(s.starts_on)}` : ''}{s.ends_on ? ` – ${when(s.ends_on)}` : ''}</T>
              <T size={12}>{s.currency ? `Committed ${moneyIn(s.committed_cents, s.currency)} · received ${moneyIn(s.received_cents, s.currency)}` : 'Money amounts not labelled with a currency'} · {s.beneficiaries_funded} athlete{s.beneficiaries_funded === 1 ? '' : 's'} funded</T>
              <T size={12} color={s.overdue_obligations ? c.orange : c.mute}>{s.overdue_obligations ? `⚠ ${s.overdue_obligations} obligation${s.overdue_obligations === 1 ? '' : 's'} overdue` : s.next_due_on ? `Next due ${when(s.next_due_on)}` : 'No upcoming obligations'}</T>
            </View>
          )) : <Empty emoji="🤝" title="No sponsor agreements" sub="Agreements that target your academy or one of its groups appear here." />}
        </Block>
      </Panel>
      {role === 'finance' ? null : (
        <Panel>
          <Block title="Health network" right={staff && !archived ? <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title="＋ Physio" onPress={() => setAdd('physio')} /><Btn small title="＋ Doctor" color={c.paper} ink={c.ink} onPress={() => setAdd('doctor')} /></View> : null}>
            <T size={12} color={c.mute}>Verified physios and doctors the academy works with. This is a business relationship only: it gives the academy no access to any clinical record. Athletes and guardians book and consent in Health.</T>
            {providers.data?.length ? providers.data.map((x) => (
              <Row key={x.id} title={`${x.display_name} · ${x.provider_type}`} sub={`${REL.find(([k]) => k === x.relation)?.[1]}${x.programme ? ` · ${x.programme}` : ''} · ${[x.clinic, x.city].filter(Boolean).join(', ') || 'no clinic listed'}${x.remote_ok ? ' · remote' : ''}${x.note ? ` · ${x.note}` : ''}`}
                right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={x.verified_now ? '✔ Verified' : '⚠ Verification lapsed'} color={x.verified_now ? c.lime : c.orangeSoft} />{staff && !archived ? <Btn small title="End" color={c.paper} ink={c.ink} onPress={async () => { await api.post(`/academy/providers/${x.id}/revoke`, {}); providers.reload(); d.reload(); toast('Association ended'); }} /> : null}</View>} />
            )) : <Empty emoji="🩺" title="No providers associated" sub={staff ? 'Add a verified physio or doctor to build your care network.' : 'The academy has not added a provider yet.'} />}
            {p.health ? (
              <View style={{ gap: 4 }}>
                <Fact k="Fit status shared" v={`${p.health.clearance_shared_for} of ${p.health.enrolled_athletes} enrolled athletes`} />
                {Object.keys(p.health.clearance_states).length ? <T size={13}>{Object.entries(p.health.clearance_states).map(([k, n]) => `${n} ${CLEAR[k] ?? k}`).join(' · ')}</T> : null}
                <T size={11} color={c.mute}>Only the status an athlete or guardian chose to share: no diagnosis, treatment or reason. Check each athlete’s status on their Families page.</T>
              </View>
            ) : null}
          </Block>
        </Panel>
      )}
      {p.legal ? (
        <Panel>
          <Block title="Legal">
            <T size={12} color={c.mute}>Status and dates of matters opened for the academy through the Legal module. Strategy and documents stay with the lawyer and client there.</T>
            {p.legal.length ? p.legal.map((l) => <Row key={l.intake_id} title={`${l.practice_area} · ${l.jurisdiction}`} sub={`opened ${when(l.created_at)}${l.activated_at ? ` · active since ${when(l.activated_at)}` : ''}${l.closed_at ? ` · closed ${when(l.closed_at)}` : ''}`} right={<Tag label={(l.matter_status ?? l.intake_status).replace('_', ' ')} />} />) : <Empty emoji="⚖️" title="No legal matters" sub="Find a lawyer from the Legal section and act for the academy to see its status here." />}
          </Block>
        </Panel>
      ) : null}
      <FormSheet visible={!!add} onClose={() => setAdd(null)} title={add === 'doctor' ? 'Associate a doctor' : 'Associate a physio'} submitLabel="Associate" initial={{ relation: 'preferred' }}
        fields={[{ key: 'provider_id', label: add === 'doctor' ? 'Doctor' : 'Physio', type: 'entity', role: add, noun: add ?? 'provider' }, { key: 'relation', label: 'Relationship', type: 'chips', options: REL.map(([value, label]) => ({ value, label })) },
          { key: 'programme_id', label: 'Covers programme', type: 'entity', entityKind: 'programme', noun: 'programme', optional: true, options: (progs.data ?? []).map((x) => ({ id: x.id, label: x.title, sub: x.sport })), show: (v) => v.relation === 'programme_cover' },
          { key: 'note', label: 'Note', optional: true, hint: 'For example “first call for sprains”. Do not put any athlete’s details here.' }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/providers`, v); providers.reload(); d.reload(); return 'Associated. They have no access to any athlete record.'; }} />
    </View>
  );
}
