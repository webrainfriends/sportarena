// A venue's spectator capacity and seating map (#480 follow-up): the zones of its stands with a price point, a colour and a default price.
// One editor, used by the venue setup wizard (onboarding) and by the venue console's Seating tab, so a venue describes its seating once and every
// event held there imports it. All rules (capacity versus seats, who may edit, zones in use) are enforced by the API.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Loading, T } from '../ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { t } from '../i18n';

export const PRICE_POINTS = ['premium', 'vip', 'standard', 'economy', 'family', 'accessible', 'custom'];
export const POINT_COLOUR = { premium: '#FBBF24', vip: '#9B72C6', standard: '#8B5CF6', economy: '#22D3EE', family: '#34D399', accessible: '#A3E635', custom: '#FB923C' };
export const pointLabel = (p) => t(`seat.point.${p}`);

/** A little stand drawn as rows of dots, in the zone's colour: the same picture the buyer sees on the seat map. */
export function ZoneThumb({ zone, size = 6 }) {
  const rows = Math.min(zone.rows_count, 5), per = Math.min(zone.seats_per_row, 12);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ gap: 2 }}>
      {Array.from({ length: rows }, (_, r) => <View key={r} style={{ flexDirection: 'row', gap: 2 }}>{Array.from({ length: per }, (_, n) => <View key={n} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: zone.colour }} />)}</View>)}
    </View>
  );
}

export function SeatingEditor({ v, onChanged, compact }) {
  const { toast } = useSession();
  const map = useLoad(() => api.get(`/venues/${v.id}/seating`), [v.id]);
  const [form, setForm] = useState(null), [cap, setCap] = useState(false);
  const reload = () => { map.reload(); onChanged?.(); };
  if (map.loading && !map.data) return <Loading />;
  const d = map.data;
  if (!d) return <T color={c.mute}>{map.error?.message}</T>;
  const edit = form?.id ? d.zones.find((z) => z.id === form.id) : null;
  return (
    <View style={{ gap: 12 }}>
      {compact ? null : <T size={18} weight="800">{t('seat.title')}</T>}
      <T color={c.mute} size={13}>{t('seat.intro')}</T>
      <Card pad={14} style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <T weight="800">{t('seat.capacity')}</T>
            <T size={12} color={c.mute}>{d.spectator_capacity != null ? t('seat.capacity_line', { cap: d.spectator_capacity, seats: d.total_seats }) : t('seat.capacity_unset')}</T>
          </View>
          <T size={24} weight="800">{d.spectator_capacity ?? '–'}</T>
          <Btn small title={d.spectator_capacity != null ? t('seat.change') : t('seat.set')} color={c.paper} ink={c.ink} onPress={() => setCap(true)} accessibilityLabel={t('seat.capacity')} />
        </View>
      </Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T weight="800" style={{ flex: 1 }}>{t('seat.zones')} · {d.total_seats} {t('seat.seats')}</T>
        <Btn small title={t('seat.add_zone')} onPress={() => setForm({})} accessibilityLabel={t('seat.add_zone')} />
      </View>
      {d.zones.length ? d.zones.map((z) => (
        <Card key={z.id} pad={14} onPress={() => setForm(z)} accessibilityLabel={`${z.name}, ${pointLabel(z.price_point)}`} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 6, alignSelf: 'stretch', borderRadius: 3, backgroundColor: z.colour }} />
            <View style={{ flex: 1, gap: 2 }}>
              <T weight="800" size={16}>{z.name}</T>
              <T size={12} color={c.mute}>{pointLabel(z.price_point)} · {z.rows_count} × {z.seats_per_row} = {z.seats} {t('seat.seats')}</T>
              <T size={13} weight="700">{z.default_price_minor ? t('seat.default_price', { price: moneyIn(z.default_price_minor, d.currency) }) : t('seat.no_default_price')}</T>
            </View>
            <ZoneThumb zone={z} />
          </View>
        </Card>
      )) : <Card pad={14}><T weight="700">{t('seat.no_zones')}</T><T size={12} color={c.mute}>{t('seat.no_zones_sub')}</T></Card>}

      <FormSheet visible={cap} onClose={() => setCap(false)} title={t('seat.capacity')} submitLabel={t('common.save')} initial={{ spectator_capacity: d.spectator_capacity ?? '' }}
        fields={[{ key: 'spectator_capacity', label: t('seat.capacity'), type: 'number', optional: true, hint: t('seat.capacity_hint') }]}
        onSubmit={async (x) => { await api.patch(`/venues/${v.id}/seating`, { spectator_capacity: x.spectator_capacity === '' || x.spectator_capacity == null ? null : Number(x.spectator_capacity) }); reload(); return null; }} />
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? t('seat.edit_zone') : t('seat.add_zone')} submitLabel={edit ? t('common.save') : t('seat.create')}
        initial={edit ? { ...edit } : { price_point: 'standard', rows_count: 10, seats_per_row: 20, default_price_minor: '' }}
        fields={[
          { key: 'name', label: t('seat.zone_name') },
          { key: 'price_point', label: t('seat.price_point'), type: 'chips', options: PRICE_POINTS.map((p) => ({ value: p, label: pointLabel(p) })), hint: t('seat.price_point_hint') },
          { key: 'rows_count', label: t('seat.rows'), type: 'stepper', min: 1, max: 100 },
          { key: 'seats_per_row', label: t('seat.seats_per_row'), type: 'stepper', min: 1, max: 200 },
          { key: 'default_price_minor', label: t('seat.default_price_label'), type: 'money', currency: d.currency, optional: true, hint: t('seat.default_price_hint') },
        ]}
        onSubmit={async (x) => {
          const body = { name: x.name, price_point: x.price_point, rows_count: x.rows_count, seats_per_row: x.seats_per_row, default_price_minor: Number(x.default_price_minor) || 0, colour: POINT_COLOUR[x.price_point] };   // a zone takes the colour of its price point, so a map always reads the same way
          if (edit) await api.patch(`/seat-zones/${edit.id}`, body); else await api.post(`/venues/${v.id}/seat-zones`, body);
          toast(t('seat.saved')); reload(); return null;
        }} />
      {edit ? <Btn small title={t('seat.archive_zone')} color={c.paper} ink={c.ink} onPress={async () => { try { await api.patch(`/seat-zones/${edit.id}`, { archived: true }); setForm(null); reload(); } catch (e) { toast(e.message); } }} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}
