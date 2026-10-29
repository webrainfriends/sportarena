// One marketplace engagement (#600): the same timeline, quote history, thread and next steps for every provider family. The API says what each side
// may do now (`next`); the buttons here only render that, so no rule is duplicated in the app. Money goes through the shared PaySheet and reviews through
// the shared testimonials, so nothing is re-implemented here.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { Btn, Card, ErrorBox, Field, H1, H2, Loading, Screen, T, Tag } from '../ui';
import { moneyIn } from '../vtime';
import { openPdf } from '../open-file';
import { when } from '../theme';
import { useDo } from './console-utils';
import { StatusTag } from './marketplace-hub';

const label = (s) => String(s ?? '').replace(/_/g, ' ');
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

function Stages({ stages, status }) {
  const closed = ['declined', 'cancelled'].includes(status);
  const at = stages.indexOf(status);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityLabel={`Stage: ${label(status)}`}>
      {stages.map((s, i) => {
        const done = !closed && i < at, now = !closed && i === at;
        return <View key={s} style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999, backgroundColor: now ? c.pink : done ? c.mintSoft : c.violetSoft }}><T weight="600" size={12} color={now ? c.onAccent : done ? c.mint : c.mute}>{label(s)}</T></View>;
      })}
    </View>
  );
}

function Thread({ id, canSend }) {
  const m = useLoad(() => api.get(`/marketplace/engagements/${id}/messages`), [id]);
  const [text, setText] = useState('');
  const act = useDo(m.reload);
  return (
    <View style={{ gap: 8 }}>
      {m.loading ? <Loading /> : m.error ? <ErrorBox error={m.error} onRetry={m.reload} /> : !m.data.length ? <T size={13} color={c.mute}>No messages yet. Questions and negotiation notes stay here with the engagement.</T>
        : m.data.map((x) => (
          <View key={x.id} style={{ alignSelf: x.mine ? 'flex-end' : 'flex-start', maxWidth: '88%', backgroundColor: x.mine ? c.pinkSoft : c.violetSoft, borderRadius: 14, padding: 10 }}>
            <T size={11} color={c.mute}>{x.mine ? 'You' : x.sender_name} · {when(x.created_at)}</T>
            <T size={14}>{x.body}</T>
          </View>
        ))}
      {canSend ? (
        <View style={{ gap: 6 }}>
          <Field value={text} onChangeText={setText} placeholder="Write a message" multiline maxLength={2000} accessibilityLabel="Message" />
          <Btn small title="Send" disabled={!text.trim()} onPress={() => act(async () => { await api.post(`/marketplace/engagements/${id}/messages`, { body: text.trim() }); setText(''); }, 'Sent')} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : null}
    </View>
  );
}

export function MarketplaceEngagement({ id }) {
  const L = useLayout();
  const r = useLoad(() => api.get(`/marketplace/engagements/${id}`), [id]);
  const cat = useLoad(() => api.get('/marketplace/catalogue'), []);
  const act = useDo(r.reload);
  const [sheet, setSheet] = useState(null);
  const [pay, setPay] = useState(null);
  if (r.loading || cat.loading) return <Screen><Loading /></Screen>;
  if (r.error) return <Screen><ErrorBox error={r.error} onRetry={r.reload} /></Screen>;
  const e = r.data, next = new Set(e.next), me = e.my_side;
  const lastOffer = [...e.quotes].reverse().find((q) => q.status === 'offered');
  const post = (path, body, msg) => act(() => api.post(`/marketplace/engagements/${e.id}${path}`, body ?? {}), msg);
  const reason = (title, path, msg) => setSheet({ title, fields: [{ key: 'reason', label: 'Reason', type: 'multiline' }], run: (v) => post(path, { reason: v.reason }, msg) });
  const quote = (counter) => setSheet({
    title: counter ? 'Counter-offer' : 'Send a quote',
    fields: [{ key: 'amount_minor', label: 'Amount', type: 'money', currency: e.currency }, { key: 'valid_until', label: 'Valid until', type: 'date', optional: true }, { key: 'terms', label: 'Scope and conditions', type: 'multiline', optional: true }],
    run: (v) => post('/quotes', { amount_minor: v.amount_minor ?? 0, ...(v.valid_until ? { valid_until: v.valid_until } : {}), ...(v.terms ? { terms: v.terms } : {}) }, counter ? 'Counter-offer sent' : 'Quote sent'),
  });
  const doc = (type) => act(async () => { const d = await api.post(`/marketplace/engagements/${e.id}/documents`, { type }); await openPdf(`/branded-documents/${d.id}/file`, `${type}-${String(e.id).slice(0, 8)}`); });
  const actions = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {next.has('quote') ? <Btn title="Send a quote" onPress={() => quote(false)} /> : null}
      {next.has('accept_quote') && lastOffer && lastOffer.side !== me ? <Btn title={`Accept ${moneyIn(Number(lastOffer.amount_minor), lastOffer.currency)}`} onPress={() => post('/accept', {}, 'Contract agreed')} /> : null}
      {next.has('counter') && lastOffer && lastOffer.side !== me ? <Btn color={c.paper} title="Counter-offer" onPress={() => quote(true)} /> : null}
      {next.has('schedule') ? <Btn title={e.status === 'scheduled' ? 'Reschedule' : 'Schedule the work'} color={e.status === 'scheduled' ? c.paper : c.pink} onPress={() => setSheet({ title: 'Schedule the work', fields: [{ key: 'starts_at', label: 'Starts', type: 'datetime' }, { key: 'ends_at', label: 'Ends', type: 'datetime', optional: true }], run: (v) => post('/schedule', { starts_at: v.starts_at, ...(v.ends_at ? { ends_at: v.ends_at } : {}), timezone: zone() }, 'Scheduled') })} /> : null}
      {next.has('deliver') ? <Btn title="Mark delivered" onPress={() => setSheet({ title: 'Mark delivered', fields: [{ key: 'note', label: 'Note for the client', type: 'multiline', optional: true }], run: (v) => post('/deliver', v.note ? { note: v.note } : {}, 'Marked delivered') })} /> : null}
      {next.has('accept_delivery') ? <Btn title="Accept delivery" onPress={() => post('/accept-delivery', {}, 'Delivery accepted; invoice raised')} /> : null}
      {next.has('pay') ? <Btn title={`Pay ${moneyIn(Number(e.agreed_minor), e.currency)}`} onPress={() => setPay({ id: e.id, type: 'marketplace_engagement', label: `${e.title} · invoice ${e.invoice?.number ?? ''}`, amount: Number(e.agreed_minor), currency: e.currency })} /> : null}
      {next.has('review') && e.status === 'paid' ? <Btn title="Leave a review" onPress={() => setSheet({ title: `Review ${e.provider.display_name}`, fields: [{ key: 'rating', label: 'Rating', type: 'stepper', min: 1, max: 5, default: 5, suffix: ' / 5' }, { key: 'body', label: 'What was it like?', type: 'multiline' }], run: (v) => act(() => api.post('/testimonials', { subject_type: 'user', subject_id: e.provider.id, rating: v.rating ?? 5, body: v.body }), 'Thanks for your review') })} /> : null}
      {next.has('decline') ? <Btn color={c.paper} title="Decline" onPress={() => reason('Decline this request', '/decline', 'Declined')} /> : null}
      {next.has('cancel') ? <Btn color={c.paper} title="Cancel" onPress={() => reason('Cancel this engagement', '/cancel', 'Cancelled')} /> : null}
    </View>
  );
  const timeline = (
    <Card pad={14}>
      <H2>Timeline</H2>
      <View style={{ gap: 6, marginTop: 8 }}>
        {e.events.filter((x) => x.kind !== 'message').map((x) => <T key={x.id} size={13}><T weight="700" size={13}>{label(x.kind)}</T> · {x.actor ?? 'System'} · {when(x.created_at)}{x.detail?.amount_minor != null ? ` · ${moneyIn(Number(x.detail.amount_minor), e.currency)}` : ''}</T>)}
      </View>
    </Card>
  );
  const quotes = e.quotes.length ? (
    <Card pad={14}>
      <H2>Quotes</H2>
      <View style={{ gap: 8, marginTop: 8 }}>
        {e.quotes.map((q) => (
          <View key={q.id} style={{ gap: 2 }}>
            <T weight="700">v{q.version} · {moneyIn(Number(q.amount_minor), q.currency)} · {q.side === me ? 'you' : q.side} <T size={12} color={c.mute}>{label(q.status)}</T></T>
            {q.valid_until ? <T size={12} color={c.mute}>Valid until {String(q.valid_until).slice(0, 10)}</T> : null}
            {q.terms ? <T size={13}>{q.terms}</T> : null}
          </View>
        ))}
      </View>
    </Card>
  ) : null;
  const handoffs = (
    <Card pad={14}>
      <H2>Contract and money</H2>
      <View style={{ gap: 4, marginTop: 8 }}>
        {e.contract_number ? <T size={13}>Contract <T weight="700" size={13}>{e.contract_number}</T> · {moneyIn(Number(e.agreed_minor), e.currency)} · agreed {when(e.contracted_at)}</T> : <T size={13} color={c.mute}>No contract yet. Accepting an offer creates it.</T>}
        {e.terms_sha256 ? <T size={11} color={c.mute} selectable>Terms fingerprint (SHA-256): {e.terms_sha256}</T> : null}
        {e.starts_at ? <T size={13}>Scheduled {when(e.starts_at)}</T> : null}
        {e.invoice ? <T size={13}>Invoice <T weight="700" size={13}>{e.invoice.number}</T> · {e.invoice.status}{e.invoice.paid_at ? ` ${when(e.invoice.paid_at)}` : ''}</T> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
          {e.contract_number ? <Btn small color={c.paper} title="Agreement PDF" onPress={() => doc('agreement')} /> : null}
          {e.invoice ? <Btn small color={c.paper} title="Invoice PDF" onPress={() => doc('invoice')} /> : null}
        </View>
        {e.credential?.required ? <T size={13} color={e.credential.ok ? c.mint : c.sun}>{e.credential.ok ? `Verified ${label(e.credential.type)} credential` : `No current verified ${label(e.credential.type)} credential`}</T> : null}
      </View>
    </Card>
  );
  return (
    <Screen wide>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}><Tag label={e.family_label ?? e.family} /><StatusTag s={e.status} /></View>
      <H1 style={{ marginTop: 6 }}>{e.title}</H1>
      <T size={14} color={c.mute} style={{ marginBottom: 10 }}>{me === 'buyer' ? `With ${e.provider?.display_name}` : `For ${e.buyer?.display_name}`}{e.budget_minor != null ? ` · budget ${moneyIn(Number(e.budget_minor), e.currency)}` : ''}</T>
      <Stages stages={cat.data.stages} status={e.status} />
      {e.brief ? <Card pad={14} style={{ marginTop: 12 }}><T weight="700" size={13}>The request</T><T size={14}>{e.brief}</T></Card> : null}
      {e.closed_reason ? <T size={13} color={c.sun} style={{ marginTop: 8 }}>Closed: {e.closed_reason}</T> : null}
      <View style={{ marginTop: 12 }}>{actions}</View>
      <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 12, marginTop: 14, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 12, width: L.tablet ? undefined : '100%' }}>{quotes}{timeline}</View>
        <View style={{ flex: 1.2, gap: 12, width: L.tablet ? undefined : '100%' }}><Card pad={14}><H2>Messages</H2><View style={{ marginTop: 8 }}><Thread id={e.id} canSend={next.has('send_message')} /></View></Card></View>
        <View style={{ flex: 1, gap: 12, width: L.tablet ? undefined : '100%' }}>{handoffs}</View>
      </View>
      <FormSheet visible={!!sheet} onClose={() => setSheet(null)} title={sheet?.title ?? ''} fields={sheet?.fields ?? []} onSubmit={async (v) => { await sheet.run(v); setSheet(null); }} />
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={r.reload} /> : null}
    </Screen>
  );
}
