// Travel partner bookings (#704) inside the trip's existing Itinerary (flights) and Stay (hotels) tabs. The UI only calls /trips/:id/bookings and
// /trips/:id/travel/search; every rule (consent, roles, room counts, partner calls) is enforced by the API. Works on phone, tablet, desktop, iOS, Android and web.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, ErrorBox, Loading, Sheet, Tag, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, money, when } from '../theme';
import { t } from '../i18n';
import { localDate } from '../vtime';
import { Wrap, Head, Grid, useAct, useKey, tone, label } from './trip-tabs';

const place = (p) => ({ name: p?.name, country: p?.country ?? undefined, lat: p?.lat ?? undefined, lng: p?.lng ?? undefined });
const STATUS = { held: 'tbook.status.held', booked: 'tbook.status.booked', changed: 'tbook.status.changed', cancelled: 'tbook.status.cancelled', failed: 'tbook.status.failed' };

export function TravelBookings({ id, data, kind, reload }) {
  const { you, party, trip } = data;
  const st = useLoad(() => api.get(`/trips/${id}/bookings`), [id]);
  const { act } = useAct(async () => { await st.reload(); await reload?.(); });
  const key = useKey();
  const [search, setSearch] = useState(false), [offers, setOffers] = useState(null), [down, setDown] = useState([]), [query, setQuery] = useState(null), [pick, setPick] = useState(null), [cancel, setCancel] = useState(null), [block, setBlock] = useState(null);
  const open = !['completed', 'cancelled'].includes(trip.status);
  if (st.loading) return <Loading />;
  if (st.error) return <ErrorBox error={st.error} onRetry={st.reload} />;
  const d = st.data;
  const mine = (b) => b.kind === kind;
  const list = d.bookings.filter(mine);
  const blocks = kind === 'stay' ? d.room_blocks : [];
  const agreed = new Set(d.consented_participant_ids);
  const roster = party.filter((p) => !p.masked);
  const ready = roster.filter((p) => agreed.has(p.id));
  const waiting = roster.filter((p) => !agreed.has(p.id));
  const myId = you.participant_id;
  const travellerField = { key: 'traveller_ids', label: t('tbook.travellers'), type: 'multi', options: ready.map((p) => ({ value: p.id, label: p.display_name })) };
  const cost = d.costs.map((x) => x.partner_bookings_minor > 0 ? money(x.partner_bookings_minor, x.currency) : null).filter(Boolean).join(' · ');

  const searchFields = kind === 'stay'
    ? [{ key: 'where', label: t('tbook.destination'), type: 'place' }, { key: 'in_date', label: t('tbook.dates'), type: 'daterange', toKey: 'out_date' }, { key: 'rooms', label: t('tbook.rooms'), type: 'stepper', min: 1, max: 100, default: 1 }, { key: 'currency', label: t('tbook.currency'), type: 'currency' }]
    : [{ key: 'from', label: t('tbook.origin'), type: 'place' }, { key: 'origin_tz', label: t('tbook.origin_zone'), type: 'timezone' }, { key: 'where', label: t('tbook.destination'), type: 'place' }, { key: 'destination_tz', label: t('tbook.destination_zone'), type: 'timezone' },
      { key: 'dep_date', label: t('tbook.depart_on'), type: 'date' }, { key: 'pax', label: t('tbook.travellers_count'), type: 'stepper', min: 1, max: 300, default: Math.max(1, ready.length) }, { key: 'currency', label: t('tbook.currency'), type: 'currency' }];

  return (
    <View style={{ gap: 12 }}>
      <Head title={t('tbook.title')} sub={d.partners.length ? d.partners.map((x) => (x.mode === 'sandbox' ? `${x.label} (${t('tbook.sandbox_short')})` : x.label)).join(' · ') : t('tbook.not_connected')}
        action={you.ops && open ? <Btn small title={kind === 'stay' ? t('tbook.find_stay') : t('tbook.find_air')} accessibilityLabel={kind === 'stay' ? t('tbook.find_stay') : t('tbook.find_air')} onPress={() => setSearch(true)} /> : null} />

      <Card pad={14}>
        <T weight="800">{t('tbook.consent_title')}</T>
        <T size={12.5} color={c.mute} style={{ marginTop: 2 }}>{t('tbook.consent_body')}</T>
        <Wrap style={{ marginTop: 8 }}>
          {you.ops ? roster.map((p) => <Tag key={p.id} label={`${p.display_name} · ${agreed.has(p.id) ? t('tbook.agreed') : t('tbook.not_agreed')}`} color={agreed.has(p.id) ? c.mint : c.sun} />) : null}
        </Wrap>
        {[myId, ...(you.guardian_of ?? [])].filter(Boolean).map((pid) => (
          <Wrap key={pid} style={{ marginTop: 8 }}>
            <T size={13} style={{ flex: 1 }}>{party.find((p) => p.id === pid)?.display_name ?? ''}</T>
            <Btn small color={agreed.has(pid) ? c.paper : c.pink} ink={agreed.has(pid) ? c.ink : '#fff'} title={agreed.has(pid) ? t('tbook.withdraw') : t('tbook.i_agree')} accessibilityLabel={agreed.has(pid) ? t('tbook.withdraw') : t('tbook.i_agree')}
              onPress={() => act(() => api.post(`/trips/${id}/partner-consent`, { participant_id: pid, granted: !agreed.has(pid) }), t('tbook.saved'))} />
          </Wrap>))}
      </Card>

      {list.length === 0 ? <T size={13} color={c.mute}>{t('tbook.empty')}</T> : (
        <Grid>{list.map((b) => (
          <Card key={b.id} pad={14} accessibilityLabel={`${b.summary}, ${t(STATUS[b.status] ?? 'tbook.status.held')}`}>
            <Wrap><T weight="800" style={{ flex: 1 }}>{b.summary}</T><Tag label={t(STATUS[b.status] ?? 'tbook.status.held')} color={tone(b.status)} /></Wrap>
            <T size={13} style={{ marginTop: 4 }}>{b.starts_local} → {b.ends_local}</T>
            <T size={13} weight="800">{money(b.price_minor, b.currency)}{b.rooms ? ` · ${t('tbook.rooms_n', { n: b.rooms })}` : ''}</T>
            <T size={12} color={c.mute}>{b.terms?.refundable === true && b.cancel_by ? t('tbook.refundable', { when: when(b.cancel_by) }) : b.terms?.refundable === false ? t('tbook.non_refundable') : (b.terms?.note ?? '')}</T>
            {b.partner_label ? <T size={11.5} color={c.mute}>{t('tbook.via', { name: b.partner_label })}</T> : null}
            {b.verified ? <T size={11.5} color={c.mute}>{t('tbook.partner_confirmed', { ref: b.partner_ref })}</T> : null}
            {you.manager && open && ['held', 'booked', 'changed'].includes(b.status) ? (
              <Wrap style={{ marginTop: 10 }}>
                {b.status === 'held' ? <Btn small title={t('tbook.confirm')} accessibilityLabel={t('tbook.confirm')} onPress={() => act(() => api.post(`/trips/${id}/bookings/${b.id}/book`, { row_version: b.row_version }), t('tbook.booked_toast'))} /> : null}
                <Btn small color={c.paper} ink={c.ink} title={t('tbook.cancel')} accessibilityLabel={t('tbook.cancel')} onPress={() => setCancel(b)} />
              </Wrap>) : null}
          </Card>))}</Grid>)}

      {cost ? <T size={12.5} color={c.mute}>{t('tbook.cost', { amount: cost })}</T> : null}

      {blocks.length ? <>
        <Head title={t('tbook.blocks')} sub={t('tbook.blocks_sub')} />
        <Grid>{blocks.map((k) => (
          <Card key={k.id} pad={14}>
            <T weight="800">{k.property_name}</T>
            <T size={13}>{localDate(`${String(k.check_in_on).slice(0, 10)}T12:00:00Z`, 'UTC')} → {localDate(`${String(k.check_out_on).slice(0, 10)}T12:00:00Z`, 'UTC')} · {money(k.rate_minor, k.currency)}</T>
            <T size={12} color={c.mute}>{t('tbook.rooms_left', { n: k.rooms_left })}{k.terms ? ` · ${k.terms}` : ''}</T>
            {you.manager && open && k.rooms_left > 0 ? <Btn small style={{ marginTop: 8 }} title={t('tbook.take_rooms')} accessibilityLabel={t('tbook.take_rooms')} onPress={() => setBlock(k)} /> : null}
          </Card>))}</Grid></> : null}

      <FormSheet visible={search} onClose={() => setSearch(false)} title={kind === 'stay' ? t('tbook.find_stay') : t('tbook.find_air')} submitLabel={t('tbook.search')}
        initial={{ in_date: localDate(trip.depart_at, trip.timezone), out_date: localDate(trip.return_at, trip.timezone), dep_date: localDate(trip.depart_at, trip.timezone), origin_tz: trip.timezone, destination_tz: trip.timezone }}
        fields={searchFields}
        onSubmit={async (v) => {
          const country = v.where.country ?? trip.destination_country;
          if (!country) throw new Error(t('tbook.country_needed'));
          const body = kind === 'stay'
            ? { kind, destination: v.where.name, country, check_in_on: v.in_date, check_out_on: v.out_date, rooms: v.rooms, currency: v.currency, destination_tz: trip.timezone }
            : { kind, origin: v.from.name, destination: v.where.name, country, origin_tz: v.origin_tz, destination_tz: v.destination_tz, depart_on: v.dep_date, pax: v.pax, currency: v.currency };
          const r = await api.post(`/trips/${id}/travel/search`, body);
          setQuery({ ...body, where: v.where, from: v.from, rooms: v.rooms }); setOffers(r.offers); setDown(r.partners.filter((x) => !x.ok).map((x) => x.label)); key.renew(); setSearch(false); return t('tbook.results_n', { n: r.offers.length });
        }} />

      <Sheet visible={!!offers && !pick} onClose={() => setOffers(null)} title={t('tbook.results')}>
        <View style={{ gap: 10 }}>
          {offers && offers.length === 0 ? <T color={c.mute}>{t('tbook.no_results')}</T> : null}
          {down.length ? <T size={12.5} color={c.mute} accessibilityRole="alert">{t('tbook.partners_down', { names: down.join(', ') })}</T> : null}
          {(offers ?? []).map((o) => (
            <Card key={o.offer_ref} pad={14}>
              <Wrap><T weight="800" style={{ flex: 1 }}>{o.summary}</T><Tag label={o.partner.label} color={c.violetSoft} /></Wrap>
              <T size={13}>{when(o.starts_at)} → {when(o.ends_at)}</T>
              <T size={14} weight="800">{money(o.price_minor, o.currency)}</T>
              <T size={12} color={c.mute}>{o.terms?.refundable ? t('tbook.refundable', { when: o.terms.free_cancel_until ? when(o.terms.free_cancel_until) : '' }) : t('tbook.non_refundable')}</T>
              <Btn small style={{ marginTop: 8 }} title={t('tbook.hold')} accessibilityLabel={`${t('tbook.hold')}: ${o.summary}`} onPress={() => setPick(o)} />
            </Card>))}
        </View>
      </Sheet>

      <FormSheet visible={!!pick} onClose={() => setPick(null)} title={pick?.summary ?? ''} submitLabel={t('tbook.hold')}
        notice={waiting.length ? t('tbook.waiting', { names: waiting.map((p) => p.display_name).join(', ') }) : undefined}
        fields={[travellerField]}
        onSubmit={async (v) => {
          const o = pick;
          const body = { kind, partner_key: o.partner.key, offer_ref: o.offer_ref, offer: { summary: o.summary, property_name: o.property_name, starts_at: o.starts_at, ends_at: o.ends_at, tz: o.tz, arrive_tz: o.arrive_tz },
            destination: query.destination, destination_country: query.country, ...(kind === 'air' ? { origin: query.origin } : { rooms: query.rooms }), traveller_ids: v.traveller_ids ?? [], idempotency_key: key.get() };
          await api.post(`/trips/${id}/bookings`, body); setPick(null); setOffers(null); await st.reload(); await reload?.(); return t('tbook.held_toast');
        }} />

      <FormSheet visible={!!cancel} onClose={() => setCancel(null)} title={cancel?.summary ?? ''} submitLabel={t('tbook.cancel')}
        fields={[{ key: 'reason', label: t('tbook.reason'), type: 'text' }]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/bookings/${cancel.id}/cancel`, { row_version: cancel.row_version, reason: v.reason }); await st.reload(); await reload?.(); return t('tbook.cancelled_toast'); }} />

      <FormSheet visible={!!block} onClose={() => setBlock(null)} title={block?.property_name ?? ''} submitLabel={t('tbook.take_rooms')}
        notice={block?.terms ?? undefined}
        fields={[{ key: 'rooms', label: t('tbook.rooms'), type: 'stepper', min: 1, max: Math.max(1, block?.rooms_left ?? 1), default: 1 }, travellerField]}
        onSubmit={async (v) => { await api.post(`/trips/${id}/bookings/room-block`, { room_block_id: block.id, rooms: v.rooms, traveller_ids: v.traveller_ids ?? [], idempotency_key: key.get() }); key.renew(); setBlock(null); await st.reload(); await reload?.(); return t('tbook.booked_toast'); }} />
    </View>
  );
}
