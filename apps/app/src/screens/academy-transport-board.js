import React, { useState, useRef } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { c } from '../theme';
import { t } from '../i18n';
import { T, Btn, Chip, Card, Row, Loading, LoadError, Empty, Tag, Sheet } from '../ui';
import { Initials, Kpi, Block } from './academy-ui';
import { explain } from '../access';

const uid = () => `tc-${Math.random().toString(36).slice(2)}-${Date.now()}`;

function AthleteBoardCard({ athlete, onAction, onContact, busy }) {
  const approved = !!athlete.approved_at;
  const lastEvent = athlete.latest_check_in_event;
  const boarded = lastEvent === 'boarded';
  const noShow = lastEvent === 'no_show';
  const refused = lastEvent === 'refused';
  const done = boarded || noShow || refused;

  return (
    <Card pad={12} color={done ? (boarded ? c.mintSoft : c.redSoft) : c.paper} style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Initials name={athlete.display_name} size={36} />
        <View style={{ flex: 1, minWidth: 120 }}>
          <T weight="800" size={15}>{athlete.display_name}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
            {approved ? <Tag label="✓" color={c.mint} /> : <Tag label={t('transport.approvalRequired')} color={c.sun} />}
            {lastEvent ? <Tag label={lastEvent} color={boarded ? c.mint : c.red} /> : null}
          </View>
        </View>
        <Btn small title="📞" color={c.paper} ink={c.ink} onPress={() => onContact(athlete)} accessibilityLabel={t('transport.emergencyContact')} style={{ minWidth: 44, minHeight: 44 }} />
      </View>
      {!done ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <Btn title={t('transport.boarded')} loading={busy === athlete.athlete_id + 'boarded'} disabled={!!busy} onPress={() => onAction(athlete, 'boarded')} style={{ flex: 1, minHeight: 44 }} accessibilityLabel={`${t('transport.boarded')} ${athlete.display_name}`} />
          <Btn title={t('transport.noShow')} color={c.paper} ink={c.sun} loading={busy === athlete.athlete_id + 'no_show'} disabled={!!busy} onPress={() => onAction(athlete, 'no_show')} style={{ flex: 1, minHeight: 44 }} accessibilityLabel={`${t('transport.noShow')} ${athlete.display_name}`} />
          <Btn title={t('transport.refusedEntry')} color={c.paper} ink={c.red} loading={busy === athlete.athlete_id + 'refused'} disabled={!!busy} onPress={() => onAction(athlete, 'refused')} style={{ minWidth: 44, minHeight: 44 }} accessibilityLabel={`${t('transport.refusedEntry')} ${athlete.display_name}`} />
        </View>
      ) : null}
    </Card>
  );
}

function StopCard({ stop, athletes, direction, onAction, onContact, busy }) {
  const mine = athletes.filter((a) => a.stop_id === stop.id);
  if (!mine.length) return null;
  return (
    <Block title={`${stop.sequence}. ${stop.name}`}>
      {mine.map((a) => <AthleteBoardCard key={a.athlete_id} athlete={a} onAction={onAction} onContact={onContact} busy={busy} />)}
    </Block>
  );
}

function ContactSheet({ contact, onClose }) {
  const contacts = useLoad(() => contact ? api.get(`/youth/children/${contact.athlete_id}/pickup-contacts`) : Promise.resolve(null), [contact?.athlete_id]);
  const all = [...(contacts.data?.guardians ?? []), ...(contacts.data?.emergency ?? [])];
  return (
    <Sheet visible={!!contact} onClose={onClose} title={contact ? `${t('transport.emergencyContact')}: ${contact.display_name}` : ''}>
      {contact ? (
        !contacts.data ? <Loading /> : all.length ? all.map((p, i) => (
          <Row key={i} title={p.name ?? 'Unknown'} sub={[p.relationship, p.phone].filter(Boolean).join(' · ')} />
        )) : <T size={14} color={c.mute}>No emergency contacts on file.</T>
      ) : null}
    </Sheet>
  );
}

export function TransportBoardTab({ o, toast }) {
  const ov = useLoad(() => api.get(`/organisations/${o.id}/academy/transport`), [o.id]);
  const [scheduleId, setScheduleId] = useState(null);
  const [direction, setDirection] = useState('outbound');
  const board = useLoad(() => scheduleId ? api.get(`/academy/transport/schedules/${scheduleId}/board`) : Promise.resolve(null), [scheduleId]);
  const [busy, setBusy] = useState(null);
  const [contact, setContact] = useState(null);
  const [pending, setPending] = useState([]);
  const keyRef = useRef({});

  if (ov.error) return <LoadError error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <Loading />;

  const allSchedules = (ov.data.routes ?? []).flatMap((r) => r.schedules.map((s) => ({ ...s, route_name: r.name, route_id: r.route_id })));

  const handleAction = async (athlete, event) => {
    const key = keyRef.current[athlete.athlete_id + event] ?? uid();
    keyRef.current[athlete.athlete_id + event] = key;
    if (!scheduleId) return;
    const stop = board.data?.stops?.find((s) => s.id === athlete.stop_id) ?? board.data?.stops?.[0];
    if (!stop) { toast('No stop found for athlete'); return; }
    setBusy(athlete.athlete_id + event);
    try {
      await api.post(`/academy/transport/schedules/${scheduleId}/checkin`, {
        athlete_id: athlete.athlete_id, stop_id: stop.id, direction, event,
        idempotency_key: key, offline: false,
      });
      board.reload();
    } catch (e) {
      if (e?.status === 0 || e?.message?.includes('network')) {
        setPending((p) => [...p, { athlete_id: athlete.athlete_id, stop_id: stop.id, direction, event, idempotency_key: key, captured_at: new Date().toISOString(), label: `${athlete.display_name} · ${event}` }]);
        toast(`${athlete.display_name} queued offline`);
      } else {
        toast(explain(e));
      }
    } finally {
      setBusy(null);
    }
  };

  const flushPending = async () => {
    if (!pending.length) return;
    try {
      const res = await api.post('/academy/transport/checkins/sync', { items: pending });
      toast(`Synced ${res.synced}, already synced ${res.already_synced}, rejected ${res.rejected?.length ?? 0}`);
      setPending([]);
      board.reload();
    } catch (e) {
      toast(explain(e));
    }
  };

  const athletes = board.data?.athletes ?? [];
  const stops = board.data?.stops ?? [];
  const boarded = athletes.filter((a) => a.latest_check_in_event === 'boarded').length;
  const noShows = athletes.filter((a) => a.latest_check_in_event === 'no_show').length;
  const remaining = athletes.filter((a) => !a.latest_check_in_event).length;

  if (!allSchedules.length) return <Empty emoji="🚌" title={t('transport.boardEmpty')} sub="No transport schedules running today." />;

  return (
    <View style={{ gap: 12 }}>
      {pending.length ? (
        <Card color={c.sunSoft} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <T weight="800">{t('transport.syncPending', { n: pending.length })}</T>
            <Btn small title={t('transport.syncOffline')} onPress={flushPending} accessibilityLabel={t('transport.syncOffline')} />
          </View>
        </Card>
      ) : null}

      <Block title="Select run">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {allSchedules.map((s) => (
            <Chip key={s.schedule_id} label={`${s.route_name} ${s.outbound_depart_time ?? ''}`} active={scheduleId === s.schedule_id} onPress={() => setScheduleId(s.schedule_id)} />
          ))}
        </View>
        {scheduleId ? (
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
            <Chip label={t('transport.direction.outbound')} active={direction === 'outbound'} onPress={() => setDirection('outbound')} />
            <Chip label={t('transport.direction.return')} active={direction === 'return'} onPress={() => setDirection('return')} />
          </View>
        ) : null}
      </Block>

      {scheduleId && athletes.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Kpi label={t('transport.boarded')} value={boarded} />
          <Kpi label={t('transport.remaining')} value={remaining} />
          {noShows ? <Kpi label={t('transport.noShow')} value={noShows} tone="alert" /> : null}
        </View>
      ) : null}

      {!scheduleId ? null : !board.data ? <Loading /> : !athletes.length ? <Empty emoji="📋" title={t('transport.noBookings')} sub="No athletes booked on this run." /> : (
        stops.map((stop) => (
          <StopCard key={stop.id} stop={stop} athletes={athletes} direction={direction} onAction={handleAction} onContact={setContact} busy={busy} />
        ))
      )}

      <ContactSheet contact={contact} onClose={() => setContact(null)} />
    </View>
  );
}
