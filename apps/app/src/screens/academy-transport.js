import React, { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { c } from '../theme';
import { t } from '../i18n';
import { T, Btn, Chip, Card, Row, Loading, Empty, Tag, Field, Sheet } from '../ui';
import { Kpi, Block } from './academy-ui';
import { explain, LoadError } from '../access';
import { FormSheet } from '../FormSheet';

const KIND_LABELS = { school_run: () => t('transport.kind.schoolRun'), training_commute: () => t('transport.kind.trainingCommute'), event_shuttle: () => t('transport.kind.eventShuttle'), other: () => t('transport.kind.other') };
const DIR_LABELS = { outbound: () => t('transport.direction.outbound'), return: () => t('transport.direction.return'), both: () => t('transport.direction.both') };
const STATUS_COLOR = { active: c.lime, paused: c.sun, archived: c.mute };

function RouteStops({ stops, routeId, canWrite, onReload }) {
  const [add, setAdd] = useState(false);
  return (
    <Block title={t('transport.stops')}>
      {stops.length ? stops.map((s) => (
        <Row key={s.id} title={s.name} sub={[s.gps_allowed ? t('transport.gpsAllowed') : null, s.address || null].filter(Boolean).join(' · ')} left={<Tag label={String(s.sequence)} />} />
      )) : <T size={13} color={c.mute}>{t('transport.noRoutes')}</T>}
      {canWrite ? <Btn small title={t('transport.addStop')} onPress={() => setAdd(true)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('transport.addStop')} /> : null}
      <FormSheet visible={add} onClose={() => setAdd(false)} title={t('transport.addStop')} submitLabel={t('common.save')}
        fields={[
          { key: 'sequence', label: 'Position', type: 'number', min: 1, max: 100 },
          { key: 'name', label: t('transport.stop') },
          { key: 'address', label: 'Address', hint: 'Stored encrypted' },
          { key: 'gps_allowed', label: t('transport.gpsAllowed'), type: 'switch', hint: t('transport.gpsAllowedExplain') },
        ]}
        onSubmit={async (v) => {
          await api.post(`/academy/transport/routes/${routeId}/stops`, { sequence: v.sequence, name: v.name, address: v.address || undefined, gps_allowed: !!v.gps_allowed });
          onReload();
          return 'Stop added';
        }} />
    </Block>
  );
}

function RouteVehicles({ vehicles, routeId, canWrite, onReload }) {
  const [add, setAdd] = useState(false);
  return (
    <Block title={t('transport.vehicles')}>
      {vehicles.length ? vehicles.map((v) => (
        <Row key={v.id} title={`${v.description ?? t('transport.vehicle')} · ${t('transport.capacity')}: ${v.capacity}`} sub={[v.driver_name ? `${t('transport.driver')}: ${v.driver_name}` : null, v.valid_until ? `until ${String(v.valid_until).slice(0, 10)}` : null].filter(Boolean).join(' · ')} />
      )) : <T size={13} color={c.mute}>No vehicles assigned.</T>}
      {canWrite ? <Btn small title={t('transport.addVehicle')} onPress={() => setAdd(true)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('transport.addVehicle')} /> : null}
      <FormSheet visible={add} onClose={() => setAdd(false)} title={t('transport.addVehicle')} submitLabel={t('common.save')}
        fields={[
          { key: 'description', label: 'Description', hint: 'e.g. 55-seat coach, blue' },
          { key: 'capacity', label: t('transport.capacity'), type: 'number', min: 1, max: 500 },
          { key: 'registration', label: t('transport.registration'), hint: 'Stored encrypted' },
          { key: 'driver_name', label: t('transport.driver'), hint: 'Stored encrypted' },
          { key: 'driver_phone', label: 'Driver phone', hint: 'Stored encrypted' },
          { key: 'valid_from', label: 'Valid from', type: 'date' },
          { key: 'valid_until', label: 'Valid until', type: 'date' },
        ]}
        onSubmit={async (v) => {
          await api.post(`/academy/transport/routes/${routeId}/vehicles`, { ...v, capacity: Number(v.capacity) });
          onReload();
          return 'Vehicle assigned';
        }} />
    </Block>
  );
}

function RouteSchedules({ schedules, vehicles, routeId, canWrite, onReload }) {
  const [add, setAdd] = useState(false);
  const vehicleOpts = vehicles.map((v) => ({ value: v.id, label: v.description ?? t('transport.vehicle') }));
  return (
    <Block title={t('transport.schedules')}>
      {schedules.length ? schedules.map((s) => (
        <Row key={s.id} title={[s.outbound_depart_time ? `Out ${s.outbound_depart_time}` : null, s.return_depart_time ? `Ret ${s.return_depart_time}` : null].filter(Boolean).join(' · ') || 'Schedule'} sub={[s.schedule_date ? String(s.schedule_date).slice(0, 10) : s.recurrence?.length ? `Runs ${s.recurrence.join(',')}` : null, s.seats_total ? `${s.seats_total} seats` : null].filter(Boolean).join(' · ')} right={<Tag label={s.status} color={STATUS_COLOR[s.status]} />} />
      )) : <T size={13} color={c.mute}>No schedules yet.</T>}
      {canWrite ? <Btn small title={t('transport.addSchedule')} onPress={() => setAdd(true)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('transport.addSchedule')} /> : null}
      <FormSheet visible={add} onClose={() => setAdd(false)} title={t('transport.addSchedule')} submitLabel={t('common.save')}
        fields={[
          { key: 'outbound_depart_time', label: t('transport.departureTime'), type: 'time' },
          { key: 'return_depart_time', label: t('transport.returnTime'), type: 'time' },
          { key: 'schedule_date', label: 'Single date (optional)', type: 'date' },
          { key: 'seats_total', label: t('transport.seatLimit'), type: 'number', min: 1 },
          ...(vehicleOpts.length ? [{ key: 'vehicle_id', label: t('transport.vehicle'), type: 'menu', options: vehicleOpts }] : []),
        ]}
        onSubmit={async (v) => {
          await api.post(`/academy/transport/routes/${routeId}/schedules`, { outbound_depart_time: v.outbound_depart_time || undefined, return_depart_time: v.return_depart_time || undefined, schedule_date: v.schedule_date || undefined, seats_total: v.seats_total ? Number(v.seats_total) : undefined, vehicle_id: v.vehicle_id || undefined });
          onReload();
          return 'Schedule created';
        }} />
    </Block>
  );
}

// Detail content — no Sheet wrapper; shared by phone (inside Sheet) and tablet (inline Card)
function RouteDetailContent({ route, orgId, canWrite, toast }) {
  const d = useLoad(() => api.get(`/academy/transport/routes/${route.id}`), [route.id]);
  const [sub, setSub] = useState('stops');
  if (!d.data) return <Loading />;
  const stops = d.data.stops ?? [];
  const vehicles = d.data.vehicles ?? [];
  const schedules = d.data.schedules ?? [];
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Tag label={KIND_LABELS[route.kind]?.()} />
        <Tag label={DIR_LABELS[route.direction]?.()} />
        <Tag label={route.status} color={STATUS_COLOR[route.status]} />
        {route.supplier_name ? <Tag label={route.supplier_name} /> : route.operator_name ? <T size={13} color={c.mute}>{route.operator_name}</T> : null}
        <T size={12} color={c.mute}>{route.stop_count} stops · {route.active_schedules} active schedules</T>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">
        {[['stops', t('transport.stops')], ['vehicles', t('transport.vehicles')], ['schedules', t('transport.schedules')]].map(([k, l]) => (
          <Chip key={k} label={l} active={sub === k} onPress={() => setSub(k)} />
        ))}
      </View>
      {sub === 'stops' ? <RouteStops stops={stops} routeId={route.id} canWrite={canWrite} onReload={d.reload} /> :
       sub === 'vehicles' ? <RouteVehicles vehicles={vehicles} routeId={route.id} canWrite={canWrite} onReload={d.reload} /> :
       <RouteSchedules schedules={schedules} vehicles={vehicles} routeId={route.id} canWrite={canWrite} onReload={d.reload} />}
    </View>
  );
}

// Phone: bottom Sheet. Tablet: inline Card panel (never a modal).
function RouteDetail({ route, tablet, orgId, canWrite, toast, onClose }) {
  if (tablet) {
    if (!route) return null;
    return (
      <Card pad={14} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <T weight="800" size={16} style={{ flex: 1 }}>{route.name}</T>
          <Btn small title={t('common.close')} color={c.paper} ink={c.ink} onPress={onClose} accessibilityLabel={t('common.close')} />
        </View>
        <RouteDetailContent route={route} orgId={orgId} canWrite={canWrite} toast={toast} />
      </Card>
    );
  }
  return (
    <Sheet visible={!!route} onClose={onClose} title={route?.name ?? ''}>
      {route ? <RouteDetailContent route={route} orgId={orgId} canWrite={canWrite} toast={toast} /> : null}
    </Sheet>
  );
}

export function TransportTab({ o, toast, admin, perms }) {
  const { width } = useWindowDimensions();
  const tablet = width >= 768;
  const canWrite = admin || (perms ?? []).includes('suppliers');
  const ov = useLoad(() => api.get(`/organisations/${o.id}/academy/transport`), [o.id]);
  const routes = useLoad(() => api.get(`/organisations/${o.id}/academy/transport/routes`), [o.id]);
  const [add, setAdd] = useState(false);
  const [selected, setSelected] = useState(null);
  const [filterKind, setFilterKind] = useState(null);

  if (routes.error) return <LoadError error={routes.error} onRetry={routes.reload} />;

  const overview = ov.data ?? {};
  const totalRoutes = (routes.data ?? []).filter((r) => r.status === 'active').length;
  const todayRuns = (overview.routes ?? []).reduce((n, r) => n + r.schedules.length, 0);
  const unapproved = (overview.routes ?? []).reduce((n, r) => n + r.schedules.reduce((m, s) => m + s.unapproved, 0), 0);

  const kinds = ['school_run', 'training_commute', 'event_shuttle', 'other'];
  const filtered = filterKind ? (routes.data ?? []).filter((r) => r.kind === filterKind) : (routes.data ?? []);

  const list = (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('transport.activeRoutes')} value={totalRoutes} />
        <Kpi label={t('transport.todayRuns')} value={todayRuns} />
        {unapproved ? <Kpi label={t('transport.unapproved')} value={unapproved} tone="alert" /> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {kinds.map((k) => <Chip key={k} label={KIND_LABELS[k]()} active={filterKind === k} onPress={() => setFilterKind(filterKind === k ? null : k)} />)}
      </View>
      {!routes.data ? <Loading /> : filtered.length ? filtered.map((r) => (
        <Row key={r.id} title={r.name} sub={[KIND_LABELS[r.kind]?.(), r.operator_name ?? r.supplier_name, `${r.stop_count} stops`].filter(Boolean).join(' · ')} right={<Tag label={r.status} color={STATUS_COLOR[r.status]} />} onPress={() => setSelected(r)} accessibilityLabel={r.name} />
      )) : <Empty emoji="🚌" title={t('transport.noRoutes')} sub={t('transport.noRoutesSub')} />}
      {canWrite ? <Btn small title={t('transport.addRoute')} onPress={() => setAdd(true)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('transport.addRoute')} /> : null}
    </View>
  );

  return (
    <View style={{ gap: 12 }}>
      {tablet && selected ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>{list}</View>
          <View style={{ width: 360 }}>
            <RouteDetail route={selected} tablet orgId={o.id} canWrite={canWrite} toast={toast} onClose={() => setSelected(null)} />
          </View>
        </View>
      ) : list}
      {!tablet ? <RouteDetail route={selected} orgId={o.id} canWrite={canWrite} toast={toast} onClose={() => setSelected(null)} /> : null}
      <FormSheet visible={add} onClose={() => setAdd(false)} title={t('transport.addRoute')} submitLabel={t('common.save')}
        fields={[
          { key: 'name', label: t('transport.routeName') },
          { key: 'kind', label: t('transport.routeKind'), type: 'chips', options: kinds.map((k) => ({ value: k, label: KIND_LABELS[k]() })) },
          { key: 'direction', label: t('transport.routeDirection'), type: 'chips', options: ['outbound', 'return', 'both'].map((d) => ({ value: d, label: DIR_LABELS[d]() })), default: 'both' },
          { key: 'operator_name', label: t('transport.operator'), hint: 'Enter operator name or link a transport supplier above.' },
          { key: 'notes', label: 'Notes', type: 'multiline' },
        ]}
        onSubmit={async (v) => {
          await api.post(`/organisations/${o.id}/academy/transport/routes`, { name: v.name, kind: v.kind, direction: v.direction || 'both', operator_name: v.operator_name || undefined, notes: v.notes || undefined });
          routes.reload();
          return 'Route created';
        }} />
    </View>
  );
}
