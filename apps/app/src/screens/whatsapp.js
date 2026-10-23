// WhatsApp notifications: your own number (verify with a code, switch off) and, for the platform team, the sending numbers.
// The platform number is the default; a dedicated number can be granted to an event, venue, sponsor or provider (see docs/whatsapp.md).
import React, { useState } from 'react';
import { Image, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, HScroll, Loading, T, Tag } from '../ui';
import { EntityPicker } from '../entity-picker';
import { c } from '../theme';

/** Notifications screen: add / verify / stop WhatsApp. `onChanged` reloads the channel switches. */
export function WhatsAppCard({ onChanged }) {
  const { toast } = useSession();
  const st = useLoad(() => api.get('/me/whatsapp'), []);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn, done) => {
    setBusy(true);
    try { await fn(); if (done) toast(done); await st.reload(); onChanged?.(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const s = st.data;
  if (st.loading && !s) return <Card><Loading /></Card>;
  if (st.error) return <Card><ErrorBox error={st.error} onRetry={st.reload} /></Card>;
  return (
    <Card>
      <T weight="700">WhatsApp</T>
      <T size={13} color={c.mute} style={{ marginTop: 2 }}>Bookings, team and event messages on WhatsApp. Security codes and health messages are never sent here.</T>
      {!s.available ? <T size={13} color={c.mute} style={{ marginTop: 8 }}>WhatsApp is not set up on this server yet.</T> : s.state === 'verified' ? (
        <View style={{ marginTop: 10, gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><Tag label="On" /><T size={13}>{s.number}</T></View>
          <Btn small title="Stop WhatsApp" color={c.paper} ink={c.red} loading={busy} style={{ alignSelf: 'flex-start' }} onPress={() => run(() => api.del('/me/whatsapp'), 'WhatsApp turned off')} />
        </View>
      ) : s.state === 'pending_code' ? (
        <View style={{ marginTop: 10, gap: 8 }}>
          <T size={13}>We sent a 6-digit code to {s.number} on WhatsApp.</T>
          <Field label="Code" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title="Confirm" loading={busy} disabled={code.length !== 6} onPress={() => run(async () => { await api.post('/me/whatsapp/confirm', { code }); setCode(''); }, 'WhatsApp is on 💬')} />
            <Btn small title="Use another number" color={c.paper} onPress={() => run(() => api.del('/me/whatsapp'))} />
          </View>
        </View>
      ) : (
        <View style={{ marginTop: 10, gap: 8 }}>
          {s.state === 'opted_out' ? <T size={13} color={c.mute}>WhatsApp is off for {s.number}. Verify a number to switch it back on.</T> : null}
          <Field label="WhatsApp number" hint="with the country code, starting with +" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={24} />
          <Btn small title="Send me a code" loading={busy} disabled={phone.replace(/\D/g, '').length < 8} style={{ alignSelf: 'flex-start' }} onPress={() => run(() => api.post('/me/whatsapp/verify', { phone }), 'Code sent on WhatsApp')} />
        </View>
      )}
    </Card>
  );
}

const SCOPES = [['platform', 'Platform number'], ['event', 'Event'], ['venue', 'Venue'], ['sponsor', 'Sponsor'], ['provider', 'Physio / doctor / coach']];
const asOption = (x) => ({ id: x.id, label: x.name ?? x.display_name ?? x.title, sub: [x.city, x.sport, x.industry].filter(Boolean).join(' · ') });

/** Platform team: the sending numbers, link a new one (QR) and grant a dedicated number to an owner. */
export function WhatsAppNumbers() {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/admin/whatsapp/senders'), []);
  const [kind, setKind] = useState('platform');
  const [label, setLabel] = useState('');
  const [who, setWho] = useState([]);
  const [qr, setQr] = useState(null); // { id, label, qr, status }
  const [busy, setBusy] = useState(false);
  const events = useLoad(() => (kind === 'event' ? api.get('/events', { limit: 100 }) : Promise.resolve(null)), [kind]);
  const venues = useLoad(() => (kind === 'venue' ? api.get('/venues', { limit: 100 }) : Promise.resolve(null)), [kind]);
  const sponsors = useLoad(() => (kind === 'sponsor' ? api.get('/sponsors') : Promise.resolve(null)), [kind]);
  const options = { event: events.data, venue: venues.data, sponsor: sponsors.data }[kind]?.map?.(asOption);
  const ready = label.trim().length >= 2 && (kind === 'platform' || who.length === 1);
  const link = async () => {
    setBusy(true);
    try {
      const r = await api.post('/admin/whatsapp/senders', { label: label.trim(), ...(kind === 'platform' ? {} : { scope_kind: kind, scope_id: who[0].id }) });
      setQr({ id: r.id, label: r.label, qr: r.qr, status: r.status }); setLabel(''); setWho([]); list.reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const refreshQr = async (id) => { try { const r = await api.get(`/admin/whatsapp/senders/${id}/qr`); setQr((q) => ({ ...q, qr: r.qr, status: r.status, phone: r.phone })); list.reload(); } catch (e) { toast(e.message); } };
  const revoke = async (id) => { try { await api.del(`/admin/whatsapp/senders/${id}`); toast('Number revoked'); if (qr?.id === id) setQr(null); list.reload(); } catch (e) { toast(e.message); } };
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>Messages go out from the platform number. A dedicated number can be granted to an event, venue, sponsor or provider as part of their subscription; if it is revoked their messages use the platform number again.</T>
      {!list.data.available ? <Empty emoji="💬" title="Gateway not running" sub="WhatsApp (OpenWA) is not configured on this server." /> : <>
        {list.data.items.length ? list.data.items.map((s) => (
          <Card key={s.id} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 160 }}>
                <T weight="700">{s.label}</T>
                <T size={12} color={c.mute}>{s.scope_kind === 'platform' ? 'Platform number' : `Dedicated · ${s.scope_kind}`}</T>
              </View>
              <Tag label={s.status === 'ready' ? 'Connected' : s.status} />
              {s.status !== 'ready' ? <Btn small title="Show QR" color={c.paper} onPress={() => { setQr({ id: s.id, label: s.label }); refreshQr(s.id); }} /> : null}
              <Btn small title="Revoke" color={c.paper} ink={c.red} onPress={() => revoke(s.id)} />
            </View>
          </Card>
        )) : <Empty emoji="📵" title="No number linked yet" sub="Add the platform number below, then scan the QR in WhatsApp > Linked devices." />}
        {qr ? (
          <Card>
            <T weight="700">{qr.label}</T>
            {qr.status === 'ready' ? <T size={13} color={c.mute}>Connected{qr.phone ? ` as +${qr.phone}` : ''} ✅</T> : <>
              <T size={13} color={c.mute}>Open WhatsApp on the phone > Linked devices > Link a device, and scan this code.</T>
              {qr.qr ? <Image source={{ uri: qr.qr }} style={{ width: 220, height: 220, marginVertical: 8, backgroundColor: '#fff' }} accessibilityLabel="WhatsApp link QR code" /> : <T size={13}>Waiting for a QR code…</T>}
            </>}
            <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title="Refresh" color={c.paper} onPress={() => refreshQr(qr.id)} /><Btn small title="Close" color={c.paper} onPress={() => setQr(null)} /></View>
          </Card>
        ) : null}
        <Card>
          <T weight="700">Add a number</T>
          <HScroll style={{ marginTop: 8 }}>{SCOPES.map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => { setKind(k); setWho([]); }} />)}</HScroll>
          {kind === 'provider' ? <EntityPicker kind="person" label="Provider" noun="physio, doctor or coach" value={who} onChange={setWho} />
            : kind !== 'platform' ? <EntityPicker kind="person" noun={kind} label={SCOPES.find(([k]) => k === kind)[1]} options={options ?? []} value={who} onChange={setWho} /> : null}
          <Field label="Name for this number" value={label} onChangeText={setLabel} maxLength={80} />
          <Btn title="Link number" loading={busy} disabled={!ready} onPress={link} style={{ marginTop: 8 }} />
        </Card>
      </>}
    </View>
  );
}
