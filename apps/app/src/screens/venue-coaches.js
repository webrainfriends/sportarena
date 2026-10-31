// Venue + coach services: tie-ups and the shared roster of coaching slots. One panel, two homes —
//   the venue console (Manage → Coaches) and the coach's own screen (CoachVenues). Either side proposes; the other agrees, amends or rejects.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Screen, Section, H1, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Pill } from './marketplace';
import { Confirm } from './coaching';
import { c } from '../theme';
import { t } from '../i18n';

const when = (iso, tz) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
const tone = (s) => (s === 'agreed' ? [c.lime, c.limeSoft] : s === 'proposed' ? [c.sun, c.sunSoft] : [c.red, c.redSoft]);
const StatusPill = ({ s }) => <Pill label={t(`vc.status.${s}`).toUpperCase()} fg={tone(s)[0]} bg={tone(s)[1]} />;
const mins = (r) => Math.round((+new Date(r.ends_at) - +new Date(r.starts_at)) / 60_000);

/** Buttons for one proposal row: the side whose turn it is can agree, amend or reject; anyone on it can cancel. */
function Actions({ mine, status, onAgree, onAmend, onReject, onCancel }) {
  if (status !== 'proposed' && status !== 'agreed') return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      {status === 'proposed' && mine ? <><Btn small title={t('vc.agree')} onPress={onAgree} /><Btn small title={t('vc.amend')} color={c.paper} ink={c.ink} onPress={onAmend} /><Btn small title={t('vc.reject')} color={c.paper} ink={c.red} onPress={onReject} /></> : null}
      <Btn small title={t('vc.cancel')} color={c.paper} ink={c.ink} onPress={onCancel} accessibilityLabel={t('vc.cancel')} />
    </View>
  );
}

/** `venue` set = the venue team's view; unset = the coach's own. */
export function VenueCoachesPanel({ venue }) {
  const { toast } = useSession();
  const venueSide = !!venue;
  const q = venue ? { venue_id: venue.id } : {};
  const ties = useLoad(() => api.get('/venue-coach-ties', q), [venue?.id]);
  const roster = useLoad(() => api.get('/venue-coach-roster', q), [venue?.id]);
  const coaches = useLoad(() => (venueSide ? api.get('/coaches', { limit: 100 }).catch(() => []) : Promise.resolve([])), [venue?.id]);
  const venues = useLoad(() => (venueSide ? Promise.resolve([]) : api.get('/venues', { limit: 100 }).catch(() => [])), [venue?.id]);
  const courts = useLoad(() => (venue ? api.get(`/venues/${venue.id}/resources`).catch(() => []) : Promise.resolve([])), [venue?.id]);
  const [sheet, setSheet] = useState(null);    // { kind:'tie'|'slots'|'amend-tie'|'amend-slot', row? }
  const [ask, setAsk] = useState(null);        // { title, yes, danger, run(reason) }
  const reload = async () => { await Promise.all([ties.reload(), roster.reload()]); };
  const act = async (path, body, msg) => { try { await api.post(path, body); toast(msg ?? 'Done'); await reload(); } catch (e) { toast(e.message); } };
  if ((ties.loading && !ties.data) || (roster.loading && !roster.data)) return <Loading />;
  if (ties.error) return <ErrorBox error={ties.error} onRetry={ties.reload} />;
  const mine = (r) => r.waiting_on === (venueSide ? 'venue' : 'coach');
  const coachOptions = (coaches.data ?? []).map((x) => ({ value: x.id, label: x.display_name }));
  const venueOptions = (venues.data ?? []).map((x) => ({ value: x.id, label: x.name }));
  const tz = venue?.timezone;
  return (
    <View style={{ gap: 14 }}>
      <Section title={t('vc.ties')} action={venueSide ? t('vc.invite') : t('vc.requestTie')} onAction={() => setSheet({ kind: 'tie' })}>
        {!ties.data?.length ? <Empty emoji="🤝" title={t('vc.noTies')} /> : ties.data.map((r) => (
          <Card key={r.id} pad={12} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="800">{venueSide ? r.coach_name : r.venue_name}</T>
                <T size={12} color={c.mute}>{t(`vc.kind.${r.kind}`)}{r.pay_model === 'revenue_share' && r.share_bp != null ? ` · ${r.share_bp / 100}%` : ''}{r.pay_model === 'flat_fee' && r.flat_fee_cents != null ? ` · ${r.flat_fee_cents / 100}` : ''}</T></View>
              <StatusPill s={r.status} />
            </View>
            {r.status === 'proposed' ? <T size={12} weight="700" color={mine(r) ? c.sun : c.mute}>{mine(r) ? t('vc.waitingOnYou') : t('vc.waitingOnThem')}</T> : null}
            <Actions mine={mine(r)} status={r.status}
              onAgree={() => act(`/venue-coach-ties/${r.id}/respond`, { decision: 'agree' })}
              onAmend={() => setSheet({ kind: 'amend-tie', row: r })}
              onReject={() => setAsk({ title: t('vc.reject'), yes: t('vc.reject'), danger: true, run: (reason) => act(`/venue-coach-ties/${r.id}/respond`, { decision: 'reject', ...(reason ? { reason } : {}) }) })}
              onCancel={() => setAsk({ title: t('vc.cancel'), yes: t('vc.cancel'), danger: true, run: (reason) => act(`/venue-coach-ties/${r.id}/cancel`, reason ? { reason } : {}) })} />
          </Card>
        ))}
      </Section>
      <Section title={t('vc.roster')} action={t('vc.proposeSlots')} onAction={() => setSheet({ kind: 'slots' })}>
        {!roster.data?.length ? <Empty emoji="📅" title={t('vc.noSlots')} /> : roster.data.map((r) => (
          <Card key={r.id} pad={12} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="800">{when(r.starts_at, tz)} · {mins(r)} min</T>
                <T size={12} color={c.mute}>{[venueSide ? r.coach_name : r.venue_name, r.court_name, r.sport].filter(Boolean).join(' · ')}</T></View>
              <StatusPill s={r.status} />
            </View>
            {r.status === 'proposed' ? <T size={12} weight="700" color={mine(r) ? c.sun : c.mute}>{mine(r) ? t('vc.waitingOnYou') : t('vc.waitingOnThem')}</T> : null}
            <Actions mine={mine(r)} status={r.status}
              onAgree={() => act(`/venue-coach-slots/${r.id}/respond`, { decision: 'agree' })}
              onAmend={() => setSheet({ kind: 'amend-slot', row: r })}
              onReject={() => setAsk({ title: t('vc.reject'), yes: t('vc.reject'), danger: true, run: (reason) => act(`/venue-coach-slots/${r.id}/respond`, { decision: 'reject', ...(reason ? { reason } : {}) }) })}
              onCancel={() => setAsk({ title: t('vc.cancel'), yes: t('vc.cancel'), danger: true, run: (reason) => act(`/venue-coach-slots/${r.id}/cancel`, reason ? { reason } : {}) })} />
          </Card>
        ))}
      </Section>

      {sheet?.kind === 'tie' ? (
        <FormSheet visible onClose={() => setSheet(null)} title={venueSide ? t('vc.invite') : t('vc.requestTie')} submitLabel={t('vc.send')}
          initial={{ kind: 'independent', pay_model: 'revenue_share', share_pct: 70 }}
          fields={[
            venueSide ? { key: 'coach_id', label: t('vc.coach'), type: 'choice', options: coachOptions } : { key: 'venue_id', label: t('vc.venue'), type: 'choice', options: venueOptions },
            { key: 'kind', label: t('vc.kindLabel'), type: 'chips', options: [{ value: 'staff', label: t('vc.kind.staff') }, { value: 'independent', label: t('vc.kind.independent') }] },
            { key: 'pay_model', label: t('vc.payModel'), type: 'chips', options: [{ value: 'revenue_share', label: t('vc.pay.revenue_share') }, { value: 'flat_fee', label: t('vc.pay.flat_fee') }, { value: 'staff', label: t('vc.pay.staff') }] },
            { key: 'share_pct', label: t('vc.share'), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', show: (v) => v.pay_model === 'revenue_share' },
            { key: 'flat_fee_cents', label: t('vc.flatFee'), type: 'money', currency: venue?.currency ?? 'INR', show: (v) => v.pay_model === 'flat_fee' },
            { key: 'sports', label: t('vc.sports'), type: 'sports', optional: true },
            { key: 'note', label: t('vc.note'), type: 'multiline', optional: true },
          ]}
          onSubmit={async (v) => {
            const { share_pct, ...rest } = v;
            await api.post('/venue-coach-ties', { ...rest, venue_id: venue?.id ?? v.venue_id, ...(v.pay_model === 'revenue_share' ? { share_bp: Math.round(share_pct * 100) } : {}) });
            await reload(); return t('vc.sent');
          }} />
      ) : null}
      {sheet?.kind === 'amend-tie' ? (
        <FormSheet visible onClose={() => setSheet(null)} title={t('vc.amend')} submitLabel={t('vc.send')}
          initial={{ pay_model: sheet.row.pay_model, share_pct: (sheet.row.share_bp ?? 7000) / 100, flat_fee_cents: sheet.row.flat_fee_cents ?? undefined }}
          fields={[
            { key: 'pay_model', label: t('vc.payModel'), type: 'chips', options: [{ value: 'revenue_share', label: t('vc.pay.revenue_share') }, { value: 'flat_fee', label: t('vc.pay.flat_fee') }, { value: 'staff', label: t('vc.pay.staff') }] },
            { key: 'share_pct', label: t('vc.share'), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', show: (v) => v.pay_model === 'revenue_share' },
            { key: 'flat_fee_cents', label: t('vc.flatFee'), type: 'money', currency: venue?.currency ?? 'INR', show: (v) => v.pay_model === 'flat_fee' },
          ]}
          onSubmit={async (v) => { const { share_pct, ...rest } = v; await api.post(`/venue-coach-ties/${sheet.row.id}/respond`, { decision: 'amend', ...rest, ...(v.pay_model === 'revenue_share' ? { share_bp: Math.round(share_pct * 100) } : {}) }); await reload(); return t('vc.sent'); }} />
      ) : null}
      {sheet?.kind === 'slots' ? (
        <FormSheet visible onClose={() => setSheet(null)} title={t('vc.proposeSlots')} submitLabel={t('vc.send')} initial={{ start: '17:00', duration_min: 60, weekdays: [] }}
          fields={[
            venueSide ? { key: 'coach_id', label: t('vc.coach'), type: 'choice', options: coachOptions } : { key: 'venue_id', label: t('vc.venue'), type: 'choice', options: venueOptions },
            { key: 'sport', label: t('vc.sport'), type: 'sport', optional: true },
            ...(venueSide ? [{ key: 'resource_id', label: t('vc.court'), type: 'choice', optional: true, options: (courts.data ?? []).map((x) => ({ value: x.id, label: x.name })) }] : []),
            { key: 'starts_on', label: t('vc.dates'), toKey: 'ends_on', type: 'daterange', min: new Date().toISOString().slice(0, 10) },
            { key: 'weekdays', label: t('vc.weekdays'), type: 'weekdays', optional: true },
            { key: 'start', label: t('vc.start'), type: 'time' },
            { key: 'duration_min', label: t('vc.length'), type: 'stepper', min: 15, max: 480, step: 15, suffix: ' min' },
            { key: 'price_cents', label: t('vc.price'), type: 'money', currency: venue?.currency ?? 'INR', optional: true },
          ]}
          onSubmit={async (v) => { const body = { ...v, venue_id: venue?.id ?? v.venue_id, ...(!v.weekdays?.length ? { extra_dates: [v.starts_on], ends_on: undefined } : {}) }; await api.post('/venue-coach-slots', body); await reload(); return t('vc.sent'); }} />
      ) : null}
      {sheet?.kind === 'amend-slot' ? (
        <FormSheet visible onClose={() => setSheet(null)} title={t('vc.amend')} submitLabel={t('vc.send')} initial={{ starts_at: sheet.row.starts_at, duration_min: mins(sheet.row) }}
          fields={[
            { key: 'starts_at', label: t('vc.start'), type: 'datetime', min: new Date().toISOString() },
            { key: 'duration_min', label: t('vc.length'), type: 'stepper', min: 15, max: 480, step: 15, suffix: ' min' },
          ]}
          onSubmit={async (v) => { await api.post(`/venue-coach-slots/${sheet.row.id}/respond`, { decision: 'amend', ...v }); await reload(); return t('vc.sent'); }} />
      ) : null}
      <Confirm visible={!!ask} title={ask?.title} yes={ask?.yes} danger={ask?.danger} askReason onYes={async (reason) => { await ask.run(reason); setAsk(null); }} onClose={() => setAsk(null)} />
    </View>
  );
}

/** The coach's own home for venue work (Coach desk → Venues). */
export function CoachVenues() {
  return <Screen wide><H1 style={{ marginTop: 8 }}>{t('vc.coachTitle')}</H1><VenueCoachesPanel /></Screen>;
}
