// Parent carpool coordination (feature 2).
// Privacy: exact addresses never shown; only area_label is public until a seat is confirmed.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { FormSheet } from '../FormSheet';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, H2, HScroll, Loading, Row, Screen, Section, T, Tag } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';

const VEHICLE_OPTIONS = ['car','minivan','van','other'].map(v => ({ value: v, label: t(`cpool.vehicle.${v}`) }));
const SEATS = [1,2,3,4,5,6,7,8].map(n => ({ value: n, label: String(n) }));

function OfferCard({ offer, myBooking, onRequest, myOffer }) {
  const isFull = offer.status === 'full';
  const confirmed = Number(offer.confirmed_count ?? 0);
  return (
    <Card pad={14} color={myOffer ? c.pinkSoft : c.paper} accessibilityLabel={`${offer.driver_name} from ${offer.area_label}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Avatar user={{ display_name: offer.driver_name, avatar_url: offer.driver_avatar, avatar_emoji: offer.driver_emoji, avatar_color: offer.driver_color }} size={32} />
          <View>
            <T weight="700">{offer.driver_name}</T>
            {offer.driver_avg_rating && <T size={12} color={c.sun}>{'★'.repeat(Math.round(Number(offer.driver_avg_rating)))}</T>}
          </View>
        </View>
        <View style={{ gap: 4, alignItems: 'flex-end' }}>
          {offer.driver_licence_verified && <Tag label={t('cpool.verified_driver')} color={c.lime} />}
          {offer.return_offered && <Tag label={t('cpool.return_offered')} color={c.cyan} />}
        </View>
      </View>
      <T size={13} style={{ marginTop: 8 }}>📍 {offer.area_label}</T>
      <T size={12} color={c.mute}>{t('cpool.departure')}: {new Date(offer.departure_time).toLocaleString()}</T>
      <T size={12} color={c.mute}>{t('cpool.seats')}: {confirmed}/{offer.seats_available}</T>
      <View style={{ marginTop: 10 }}>
        {!myOffer && !myBooking && !isFull && (
          <Btn small title={t('cpool.request_seat')} color={c.pink} onPress={() => onRequest(offer)} />
        )}
        {!myOffer && !myBooking && isFull && <Tag label={t('cpool.full')} color={c.mute} />}
        {myBooking && <Tag label={`${myBooking.toUpperCase()}`} color={myBooking === 'confirmed' ? c.lime : c.sun} />}
        {myOffer && <Tag label="Your offer" color={c.pink} />}
      </View>
    </Card>
  );
}

export function Carpool({ eventId }) {
  const [filter, setFilter] = useState('all');
  const [offerSheet, setOfferSheet] = useState(false);
  const [requestTarget, setRequestTarget] = useState(null);
  const { toast } = useSession();

  const carpools = useLoad(() => api.get(`/events/${eventId}/carpool-offers`), [eventId]);
  const myBookings = useLoad(() => api.get('/me/carpool-bookings'), []);

  const myOfferId = (myBookings.data?.offers ?? []).find(o => o.event_id === eventId)?.id;
  const myBookingMap = Object.fromEntries((carpools.data?.offers ?? []).map(o => [o.id, o.my_booking_status]));

  const handleOfferSubmit = async (data) => {
    await api.post(`/events/${eventId}/carpool-offers`, {
      ...data,
      departure_location: data.departure_location,
      area_label: data.area_label,
      seats_available: Number(data.seats_available),
      return_offered: !!data.return_offered,
    });
    carpools.reload();
    return t('cpool.offer_created');
  };

  const handleRequest = async (data) => {
    await api.post(`/carpool-offers/${requestTarget.id}/bookings`, data);
    carpools.reload();
    return t('cpool.seat_requested');
  };

  if (carpools.loading && !carpools.data) return <Loading />;
  if (carpools.error) return <ErrorBox error={carpools.error} onRetry={carpools.reload} />;

  const offers = carpools.data?.offers ?? [];
  const ridesAvail = offers.filter(o => o.status !== 'cancelled').length;
  const seatsFree = offers.reduce((sum, o) => sum + Math.max(0, o.seats_available - Number(o.confirmed_count ?? 0)), 0);

  return (
    <Screen title={t('cpool.title')}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {/* Privacy card */}
        <Card color={c.cyanSoft} pad={12} accessibilityLabel={t('cpool.privacy_title')}>
          <T weight="700" size={13}>🔒 {t('cpool.privacy_title')}</T>
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('cpool.privacy_body')}</T>
        </Card>

        {/* Stats */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Card pad={12} style={{ flex: 1 }}><T weight="800" size={20} style={{ textAlign: 'center' }}>{ridesAvail}</T><T size={12} color={c.mute} style={{ textAlign: 'center' }}>{t('cpool.rides_available')}</T></Card>
          <Card pad={12} style={{ flex: 1 }}><T weight="800" size={20} style={{ textAlign: 'center' }}>{seatsFree}</T><T size={12} color={c.mute} style={{ textAlign: 'center' }}>{t('cpool.seats_free')}</T></Card>
        </View>

        {/* CTAs */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {!myOfferId && <Btn title={t('cpool.offer_ride')} color={c.pink} style={{ flex: 1 }} onPress={() => setOfferSheet(true)} />}
          <Btn title={t('cpool.need_ride')} color={c.paper} ink={c.ink} style={{ flex: 1 }} onPress={() => { /* scroll to list */ }} />
        </View>

        {/* Offer list */}
        {offers.length === 0 ? (
          <Empty emoji="🚗" title={t('cpool.empty')} sub={t('cpool.empty_sub')} />
        ) : (
          offers.map(offer => (
            <OfferCard
              key={offer.id}
              offer={offer}
              myBooking={myBookingMap[offer.id]}
              myOffer={offer.id === myOfferId}
              onRequest={setRequestTarget}
            />
          ))
        )}
      </ScrollView>

      {/* Offer form */}
      <FormSheet
        visible={offerSheet}
        onClose={() => setOfferSheet(false)}
        title={t('cpool.offer_ride')}
        initial={{ area_label: '', departure_location: '', departure_time: '', seats_available: 2, return_offered: false, vehicle_type: 'car' }}
        fields={[
          { key: 'area_label', label: t('cpool.area_label'), type: 'text', hint: t('cpool.area_label_hint') },
          { key: 'departure_location', label: 'Full pickup address (private)', type: 'text', hint: 'Only shared with confirmed passengers' },
          { key: 'departure_time', label: t('cpool.departure'), type: 'datetime' },
          { key: 'seats_available', label: t('cpool.seats'), type: 'menu', options: SEATS },
          { key: 'vehicle_type', label: t('cpool.vehicle_type'), type: 'menu', options: VEHICLE_OPTIONS },
          { key: 'return_offered', label: t('cpool.return_offered'), type: 'switch' },
          { key: 'notes', label: t('cpool.notes'), type: 'text', multiline: true },
        ]}
        onSubmit={handleOfferSubmit}
      />

      {/* Request seat form */}
      <FormSheet
        visible={!!requestTarget}
        onClose={() => setRequestTarget(null)}
        title={t('cpool.request_seat')}
        initial={{ pickup_area_label: '' }}
        fields={[
          { key: 'pickup_area_label', label: t('cpool.area_label'), type: 'text', hint: 'Your general area — exact address shared after confirmation' },
        ]}
        onSubmit={handleRequest}
      />
    </Screen>
  );
}
