// Venue + coach services: tie-ups and the shared roster of coaching slots. One panel, two homes —
//   the venue console (Manage → Coaches) and the coach's own screen (CoachVenues). Either side proposes; the other agrees, amends or rejects.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Screen, Section, Sheet, H1, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Stepper } from '../pickers';
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

const AGE_GROUPS = ['u8', 'u10', 'u12', 'u14', 'u16', 'u18', 'u21', 'senior', 'masters'];
const PERF_LEVELS = ['beginner', 'recreational', 'club', 'regional', 'national', 'elite'];
const PARA_CLASS_OPTS = ['general_awareness', 'wheelchair_sport', 'vision_impairment', 'intellectual_disability', 'cerebral_palsy', 'limb_deficiency', 'hearing_impairment'];
const PARA_ADAPTIVE = ['adapted_drills', 'para_equipment', 'communication_boards', 'british_sign', 'auslan', 'simplified_instructions', 'visual_demonstrations'];
const PARA_COMM = ['verbal_cues', 'visual_cues', 'tactile_cues', 'sign_language', 'augmentative_communication', 'simplified_language'];

const loadCoachMarketRate = (venueId, sport, payModel) =>
  api.get(`/venues/${venueId}/coach-market-rate`, { ...(sport ? { sport } : {}), pay_model: payModel }).catch(() => null);

function MarketRateCard({ data, payModel }) {
  if (!data || !data.count) return <T size={12} color={c.mute}>{t('vc.wiz.noMarketData')}</T>;
  const fmt = (v) => payModel === 'revenue_share' ? `${(v / 100).toFixed(1)}%` : `${(v / 100).toFixed(0)}`;
  return (
    <Card pad={10} style={{ backgroundColor: c.accentSoft ?? c.paper }}>
      <T weight="800" size={13}>{t('vc.wiz.marketRate')} · {data.count} {t('vc.wiz.marketAgreed')}</T>
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 6 }}>
        {[['P25', data.p25], ['Median', data.median], ['P75', data.p75]].map(([lbl, val]) => (
          <View key={lbl} style={{ alignItems: 'center' }}>
            <T size={11} color={c.mute}>{lbl}</T>
            <T weight="800" size={15}>{val != null ? fmt(val) : '—'}</T>
          </View>
        ))}
      </View>
    </Card>
  );
}

function CoachInviteWizard({ venue, coachOptions, venueOptions, venueSide, onClose, onDone }) {
  const { toast } = useSession();
  const STEPS = [t('vc.wiz.s1'), t('vc.wiz.s2'), t('vc.wiz.s3'), t('vc.wiz.s4')];
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    kind: 'independent', pay_model: 'revenue_share', share_pct: 70,
    session_format: 'group', age_groups: [], performance_levels: [],
    max_sessions_per_day: 4, max_students_per_session: 20,
    contract_type: 'independent', probation_months: 3, notice_period_days: 30,
    bonus_model: 'none', kit_provided: false, equipment_allocated: false, non_compete: false, media_consent: false,
    review_period: 'quarterly', kpi_retention_pct: 80, kpi_feedback_min: 4.0, kpi_ranking_lift: 0,
    para_classification_awareness: [], para_adaptive_experience: [], para_comm_adaptations: [],
    para_guide_role: false, para_equipment_trained: false,
  });
  const [marketRate, setMarketRate] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (step === 2 && venue?.id) {
      loadCoachMarketRate(venue.id, form.sports?.[0], form.pay_model).then(setMarketRate);
    }
  }, [step, venue?.id, form.sports, form.pay_model]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const step1Fields = [
    venueSide ? { key: 'coach_id', label: t('vc.coach'), type: 'choice', options: coachOptions } : { key: 'venue_id', label: t('vc.venue'), type: 'choice', options: venueOptions },
    { key: 'kind', label: t('vc.kindLabel'), type: 'chips', options: [{ value: 'staff', label: t('vc.kind.staff') }, { value: 'independent', label: t('vc.kind.independent') }, { value: 'visiting_specialist', label: t('vc.kind.visiting_specialist') }, { value: 'master_clinician', label: t('vc.kind.master_clinician') }] },
    { key: 'sports', label: t('vc.sports'), type: 'sports', optional: true },
    { key: 'session_format', label: t('vc.wiz.sessionFormat'), type: 'chips', options: [{ value: '1on1', label: t('vc.wiz.fmt.1on1') }, { value: 'small_group', label: t('vc.wiz.fmt.small_group') }, { value: 'group', label: t('vc.wiz.fmt.group') }, { value: 'squad', label: t('vc.wiz.fmt.squad') }] },
    { key: 'age_groups', label: t('vc.wiz.ageGroups'), type: 'multimenu', optional: true, options: AGE_GROUPS.map((g) => ({ value: g, label: t(`vc.wiz.age.${g}`) })) },
    { key: 'performance_levels', label: t('vc.wiz.perfLevels'), type: 'multimenu', optional: true, options: PERF_LEVELS.map((l) => ({ value: l, label: t(`vc.wiz.perf.${l}`) })) },
    { key: 'max_sessions_per_day', label: t('vc.wiz.maxSessions'), type: 'stepper', min: 1, max: 12, step: 1 },
    { key: 'max_students_per_session', label: t('vc.wiz.maxStudents'), type: 'stepper', min: 1, max: 100, step: 1 },
  ];
  const step2Fields = [
    { key: 'contract_type', label: t('vc.wiz.contractType'), type: 'chips', options: [{ value: 'staff', label: t('vc.wiz.ct.staff') }, { value: 'independent', label: t('vc.wiz.ct.independent') }, { value: 'visiting_specialist', label: t('vc.wiz.ct.visiting_specialist') }, { value: 'master_clinician', label: t('vc.wiz.ct.master_clinician') }] },
    { key: 'pay_model', label: t('vc.payModel'), type: 'chips', options: [{ value: 'revenue_share', label: t('vc.pay.revenue_share') }, { value: 'flat_fee', label: t('vc.pay.flat_fee') }, { value: 'staff', label: t('vc.pay.staff') }] },
    { key: 'share_pct', label: t('vc.share'), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', show: (v) => v.pay_model === 'revenue_share' },
    { key: 'flat_fee_cents', label: t('vc.flatFee'), type: 'money', currency: venue?.currency ?? 'INR', show: (v) => v.pay_model === 'flat_fee' },
    { key: 'start_date', label: t('vc.wiz.startDate'), type: 'date', optional: true },
    { key: 'end_date', label: t('vc.wiz.endDate'), type: 'date', optional: true },
    { key: 'probation_months', label: t('vc.wiz.probation'), type: 'chips', options: [{ value: 0, label: t('vc.wiz.prob.none') }, { value: 1, label: '1 mo' }, { value: 3, label: '3 mo' }, { value: 6, label: '6 mo' }] },
    { key: 'notice_period_days', label: t('vc.wiz.notice'), type: 'stepper', min: 7, max: 180, step: 7, suffix: ' days' },
    { key: 'bonus_model', label: t('vc.wiz.bonusModel'), type: 'chips', options: [{ value: 'none', label: t('vc.wiz.bonus.none') }, { value: 'win_based', label: t('vc.wiz.bonus.win_based') }, { value: 'milestone', label: t('vc.wiz.bonus.milestone') }, { value: 'retention', label: t('vc.wiz.bonus.retention') }] },
    { key: 'bonus_trigger', label: t('vc.wiz.bonusTrigger'), type: 'multiline', optional: true, show: (v) => v.bonus_model && v.bonus_model !== 'none' },
    { key: 'bonus_per_trigger_cents', label: t('vc.wiz.bonusAmount'), type: 'money', currency: venue?.currency ?? 'INR', optional: true, show: (v) => v.bonus_model && v.bonus_model !== 'none' },
    { key: 'kit_provided', label: t('vc.wiz.kitProvided'), type: 'switch' },
    { key: 'equipment_allocated', label: t('vc.wiz.equipmentAllocated'), type: 'switch' },
    { key: 'non_compete', label: t('vc.wiz.nonCompete'), type: 'switch' },
    { key: 'media_consent', label: t('vc.wiz.mediaConsent'), type: 'switch' },
    { key: 'note', label: t('vc.note'), type: 'multiline', optional: true },
  ];
  const step4Fields = [
    { key: 'para_classification_awareness', label: t('vc.wiz.paraClassAware'), type: 'multimenu', optional: true, options: PARA_CLASS_OPTS.map((v) => ({ value: v, label: t(`para.class.${v}`) })) },
    { key: 'para_adaptive_experience', label: t('vc.wiz.paraAdaptiveExp'), type: 'multimenu', optional: true, options: PARA_ADAPTIVE.map((v) => ({ value: v, label: t(`para.adaptive.${v}`) })) },
    { key: 'para_comm_adaptations', label: t('vc.wiz.paraCommAdapt'), type: 'multimenu', optional: true, options: PARA_COMM.map((v) => ({ value: v, label: t(`para.comm.${v}`) })) },
    { key: 'para_guide_role', label: t('vc.wiz.paraGuideRole'), type: 'switch' },
    { key: 'para_equipment_trained', label: t('vc.wiz.paraEquipTrained'), type: 'switch' },
    { key: 'internal_note', label: t('vc.wiz.internalNote'), type: 'multiline', optional: true },
  ];

  const submit = async (stepVals) => {
    const merged = { ...form, ...stepVals };
    setForm(merged);
    if (step < 3) { setStep(step + 1); return; }
    setBusy(true);
    try {
      const { share_pct, ...rest } = merged;
      await api.post('/venue-coach-ties', {
        ...rest, venue_id: venue?.id ?? merged.venue_id,
        ...(merged.pay_model === 'revenue_share' ? { share_bp: Math.round((share_pct ?? 70) * 100) } : {}),
        sport_ids: merged.sports ?? [],
      });
      toast(t('vc.sent')); onDone(); onClose();
    } catch (e) { toast(e.message); setBusy(false); }
  };

  const stepFields = [step1Fields, step2Fields, [], step4Fields][step];
  const stepInitial = form;

  return (
    <Sheet visible onClose={onClose} title={venueSide ? t('vc.invite') : t('vc.requestTie')}>
      <Stepper steps={STEPS} current={step} onJump={(i) => i < step && setStep(i)} />
      {step === 2 ? (
        <View style={{ gap: 12 }}>
          <MarketRateCard data={marketRate} payModel={form.pay_model} />
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>{t('vc.wiz.reviewPeriod')}</T>
            <FormSheet visible={false} fields={[
              { key: 'review_period', label: t('vc.wiz.reviewPeriod'), type: 'chips', options: [{ value: 'monthly', label: t('vc.wiz.rev.monthly') }, { value: 'quarterly', label: t('vc.wiz.rev.quarterly') }, { value: 'biannual', label: t('vc.wiz.rev.biannual') }] },
            ]} initial={form} onSubmit={() => {}} />
          </View>
          <FormSheet visible onClose={() => {}} title="" submitLabel={t('common.next')}
            fields={[
              { key: 'review_period', label: t('vc.wiz.reviewPeriod'), type: 'chips', options: [{ value: 'monthly', label: t('vc.wiz.rev.monthly') }, { value: 'quarterly', label: t('vc.wiz.rev.quarterly') }, { value: 'biannual', label: t('vc.wiz.rev.biannual') }] },
              { key: 'kpi_retention_pct', label: t('vc.wiz.kpiRetention'), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%' },
              { key: 'kpi_feedback_min', label: t('vc.wiz.kpiFeedback'), type: 'stepper', min: 0, max: 5, step: 0.1, suffix: '/5' },
              { key: 'kpi_ranking_lift', label: t('vc.wiz.kpiRanking'), type: 'stepper', min: 0, max: 500, step: 1 },
            ]}
            initial={form}
            onSubmit={(v) => submit(v)} />
          {step > 0 ? <Btn small title={t('common.back')} color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} /> : null}
        </View>
      ) : (
        <>
          <FormSheet visible onClose={onClose} title="" submitLabel={step < 3 ? t('common.next') : t('vc.send')}
            fields={stepFields} initial={stepInitial} onSubmit={submit} />
          {step > 0 ? <Btn small title={t('common.back')} color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ marginTop: 8 }} /> : null}
        </>
      )}
    </Sheet>
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
        <CoachInviteWizard venue={venue} coachOptions={coachOptions} venueOptions={venueOptions} venueSide={venueSide} onClose={() => setSheet(null)} onDone={reload} />
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
