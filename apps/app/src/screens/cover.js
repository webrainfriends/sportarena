// Cover: someone else pays your bills — a sponsor, a club, a parent, a friend — under an agreement both sides approve.
// One screen for both roles: "Pays for me" (athletes, doctors, physios, lawyers, suppliers, anyone) and "I pay for others" (sponsors, organisations, families).
// All rules are enforced by the API; this screen only asks and shows.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Seg, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { AskForCover, termFields, termBody } from './cover-ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';

const TONE = { requested: [c.sunSoft, 'waiting'], active: [c.mint, 'active'], declined: [c.violetSoft, 'declined'], revoked: [c.violetSoft, 'ended'], cancelled: [c.violetSoft, 'withdrawn'], expired: [c.violetSoft, 'expired'], used_up: [c.violetSoft, 'used up'] };
const BLOCK = { over_total_cap: 'over the total limit', over_per_bill_cap: 'over the per-bill limit', already_used: 'already used', not_active: 'not active', currency: 'different currency' };
const day = (d) => (d ? new Date(d).toLocaleDateString(locale) : '');

/** The terms in plain words: what it covers, for how long, and the limits. */
function termsLine(m) {
  const kinds = m.bill_type ? `this ${m.purposes[0]?.label.toLowerCase()}` : m.purposes.map((p) => p.label.toLowerCase()).join(', ');
  const when = m.term === 'one_time' ? (m.bill_type ? '' : 'one payment') : m.term === 'duration' ? `until ${day(m.valid_until)}` : 'until someone ends it';
  const caps = [m.max_per_bill_minor ? `up to ${moneyIn(m.max_per_bill_minor, m.currency)} per bill` : null, m.max_total_minor ? `${moneyIn(m.max_total_minor, m.currency)} in total` : null].filter(Boolean).join(', ');
  return [kinds, when, caps, m.auto_send ? 'every bill is sent automatically' : m.term === 'one_time' ? '' : 'only bills sent to the payer'].filter(Boolean).join(' · ');
}

function Agreement({ m, onChange, view }) {
  const { toast } = useSession();
  const [tone, label] = TONE[m.status] ?? TONE.requested;
  const answer = async (decision) => { try { await api.post(`/cover/${m.id}/decision`, { decision }); toast(decision === 'accept' ? 'Accepted' : 'Declined'); onChange(); } catch (e) { toast(e.message); } };
  const end = async () => { try { await api.post(`/cover/${m.id}/end`, {}); toast(m.status === 'requested' ? 'Withdrawn' : 'Ended — takes effect on the next payment'); onChange(); } catch (e) { toast(e.message); } };
  const who = view === 'for_me' ? m.payer_name : m.beneficiary_name;
  return (
    <Card color={m.can_answer ? c.sunSoft : c.paper}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <T weight="800" size={16} style={{ flex: 1 }}>{view === 'for_me' ? `${who} pays` : `You pay for ${who}`}{m.payer_kind === 'organisation' && view === 'for_me' ? ' · organisation' : ''}</T>
        <Tag label={label} color={tone} />
      </View>
      <T size={13} color={c.mute}>{termsLine(m)}</T>
      {m.used_minor > 0 || m.uses > 0 ? <T size={13}>Paid so far: {moneyIn(m.used_minor, m.currency ?? 'INR')} in {m.uses} payment{m.uses === 1 ? '' : 's'}</T> : null}
      {m.note ? <T size={12} color={c.mute}>“{m.note}”</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {m.can_answer ? <><Btn small title="Accept" color={c.mint} onPress={() => answer('accept')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => answer('decline')} /></> : null}
        {m.can_end && !m.can_answer ? <Btn small title={m.status === 'requested' ? 'Withdraw' : 'End'} color={c.paper} ink={c.red} onPress={end} /> : null}
      </View>
    </Card>
  );
}

export function Cover({ ask }) {
  const { toast } = useSession();
  const [view, setView] = useState('for_me');
  const list = useLoad(() => api.get('/cover', { view, limit: 100 }), [view]);
  const inbox = useLoad(() => (view === 'i_pay' ? api.get('/cover/inbox') : Promise.resolve([])), [view]);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const [asking, setAsking] = useState(!!ask);
  const [offer, setOffer] = useState(false);
  const [pay, setPay] = useState(null);
  const reload = () => { list.reload(); inbox.reload(); };
  const mine = list.data ?? [];
  const waiting = mine.filter((m) => m.can_answer);
  const rest = mine.filter((m) => !m.can_answer);
  const ownable = (orgs.data ?? []).filter((o) => o.my_status === 'active' && ['owner', 'admin'].includes(o.my_role));
  return (
    <Screen onRefresh={reload}>
      <H1 style={{ marginTop: 8 }}>Who pays</H1>
      <T color={c.mute} weight="600">A sponsor, a club, a parent or a friend can pay your bookings, sessions, fees and memberships — once, for a period, or until someone ends it. Both sides approve, and either can stop it at any time.</T>
      <View style={{ marginVertical: 10 }}><Seg options={[{ value: 'for_me', label: 'Pays for me' }, { value: 'i_pay', label: 'I pay for others' }]} value={view} onChange={setView} /></View>

      {view === 'i_pay' ? (
        <Section title="Bills waiting for you" color={c.sun}>
          {inbox.loading && !inbox.data ? <Loading /> : inbox.data?.length ? inbox.data.map((b) => (
            <Row key={`${b.purpose_type}${b.purpose_id}`} title={`${b.label} · ${b.beneficiary_name}`} sub={b.payable ? `${b.since ? day(b.since) : ''}` : `Cannot be paid: ${BLOCK[b.blocked_by] ?? b.blocked_by}`}
              right={b.payable ? <View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="800">{moneyIn(b.amount_minor, b.currency)}</T><Btn small title="Pay" onPress={() => setPay({ id: b.purpose_id, type: b.purpose_type, label: `${b.label} for ${b.beneficiary_name}`, amount: b.amount_minor, currency: b.currency })} /></View> : <T weight="800" color={c.mute}>{moneyIn(b.amount_minor, b.currency)}</T>} />
          )) : <T size={13} color={c.mute}>Nothing to pay right now. Bills appear here when someone you cover sends one, or automatically if you agreed that.</T>}
        </Section>
      ) : null}

      {waiting.length ? <Section title={view === 'for_me' ? 'Offers for you' : 'Requests to answer'} color={c.pink}>{waiting.map((m) => <Agreement key={m.id} m={m} view={view} onChange={reload} />)}</Section> : null}
      <Section title={view === 'for_me' ? 'Your agreements' : 'Agreements you pay under'} color={c.mint}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : rest.length ? rest.map((m) => <Agreement key={m.id} m={m} view={view} onChange={reload} />)
          : <Empty emoji="🤝" title={view === 'for_me' ? 'Nobody pays for you yet' : 'You are not paying for anyone yet'} sub={view === 'for_me' ? 'Ask a sponsor, a club or a family member — or accept an offer when one arrives.' : 'Offer to pay for an athlete, a team-mate or a family member, or approve a request.'} />}
      </Section>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        {view === 'for_me' ? <Btn small title="＋ Ask someone to cover me" onPress={() => setAsking(true)} /> : <Btn small title="＋ Offer to pay for someone" onPress={() => setOffer(true)} />}
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 8 }}>Payers see what a bill is and its amount — never the provider, the service or any health detail. Payments stay in the payer's name and any refund goes back to them.</T>

      {asking ? <AskForCover bill={ask} onClose={() => setAsking(false)} onDone={reload} /> : null}
      <FormSheet visible={offer} onClose={() => setOffer(false)} title="Offer to pay" submitLabel="Send offer" initial={{ term: 'unlimited', purposes: ['venue_invoice'], as: 'me' }}
        fields={termFields([{ key: 'person', label: 'Who for?', type: 'entity', entityKind: 'person', noun: 'person' },
          ...(ownable.length ? [{ key: 'as', label: 'Paying as', type: 'chips', options: [{ value: 'me', label: 'Me' }, ...ownable.map((o) => ({ value: o.id, label: o.name }))] }] : [])])}
        onSubmit={async (v) => { await api.post('/cover/offers', { beneficiary_id: v.person, ...(v.as && v.as !== 'me' ? { as_org_id: v.as } : {}), ...termBody(v) }); reload(); return 'Offer sent — they will be asked to accept'; }} />
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={reload} /> : null}
    </Screen>
  );
}
