// Coach Business CRM (issue #517). Lead pipeline, client lifecycle, retention analytics,
// outreach campaigns, and video review — all without leaving the app.
// Beats Upper Hand, Playo, GotSport, Hudl, TeamSnap, RAMP, PlayAtomic, play.book.
import React, { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Screen, Seg, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../pickers';
import { c } from '../theme';
import { t } from '../i18n';

const STAGES = ['new_lead','contacted','trial_offered','trial_booked','trial_completed','proposal_offered','won','lost','nurture'];
const STAGE_COLOR = {
  new_lead:'#e8f4fd', contacted:'#d1ecf1', trial_offered:'#fff3cd', trial_booked:'#d4edda',
  trial_completed:'#cce5ff', proposal_offered:'#e2d9f3', won:'#d4f5d4', lost:'#f8d7da', nurture:'#fefefe',
};
const SOURCE_KINDS = ['marketplace_enquiry','billboard_response','referral','academy_team_context','manual_entry'];
const LOSS_REASONS = ['price','availability','programme_fit','sport_mismatch','location','chose_another_coach','unresponsive','unknown'];
const COMM_KINDS = ['note','call','meeting','email','message','trial_offer','trial_outcome','proposal_sent','proposal_response','decision'];
const CAMPAIGN_KINDS = ['programme_announcement','availability_slots','package_renewal','clinic_camp','re_engagement','general'];
const CVR_STATUSES = ['awaiting_upload','uploaded','under_review','review_complete','acknowledged','archived'];

const newKey = () => `crm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const pct = (n, d) => d > 0 ? `${Math.round((n / d) * 100)}%` : '—';

// ── Shared components ─────────────────────────────────────────────────────────

function StageChip({ stage, overdue }) {
  return (
    <View style={{ backgroundColor: STAGE_COLOR[stage] ?? c.grayLight, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start', flexDirection:'row', gap:4, alignItems:'center' }}>
      {overdue && <T size={10}>⚠️</T>}
      <T size={11} weight="600">{t(`crm.stage.${stage}`, stage.replace(/_/g,' '))}</T>
    </View>
  );
}

function MetricStrip({ items }) {
  return (
    <View style={{ flexDirection:'row', gap:8, flexWrap:'wrap', marginBottom:12 }}>
      {items.map(({ label, value, accent }) => (
        <Card key={label} pad={10} style={{ flex:1, minWidth:80, alignItems:'center', gap:2 }}>
          <T size={22} weight="800" color={accent ?? c.ink}>{value}</T>
          <T size={11} color={c.mute} style={{ textAlign:'center' }}>{label}</T>
        </Card>
      ))}
    </View>
  );
}

// ── Lead card ─────────────────────────────────────────────────────────────────

function LeadCard({ lead, onPress }) {
  const overdueDays = lead.next_action_on && new Date(lead.next_action_on) < new Date()
    ? Math.round((Date.now() - new Date(lead.next_action_on).getTime()) / 86400000) : null;
  return (
    <Card onPress={onPress} pad={12} style={{ marginBottom:8 }} accessibilityLabel={`${lead.athlete_name ?? t('crm.unknownAthlete')} ${t(`crm.stage.${lead.stage}`, lead.stage)}`}>
      <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
        <T weight="700" style={{ flex:1 }}>{lead.athlete_name ?? t('crm.unknownAthlete')}</T>
        <StageChip stage={lead.stage} overdue={!!overdueDays} />
      </View>
      <T size={12} color={c.mute}>{t(`crm.source.${lead.source_kind}`, lead.source_kind.replace(/_/g,' '))}</T>
      {lead.next_action_on && (
        <T size={12} color={overdueDays ? c.red : c.mute}>
          {overdueDays ? t('crm.overdueBy', { days: overdueDays }) : t('crm.nextAction', { date: new Date(lead.next_action_on).toLocaleDateString() })}
        </T>
      )}
    </Card>
  );
}

// ── Leads kanban ─────────────────────────────────────────────────────────────

function LeadsTab({ coachId }) {
  const { width } = useWindowDimensions();
  const isWide = width >= 768;
  const { push } = useNav();
  const [addOpen, setAddOpen] = useState(false);
  const pipeline = useLoad(() => api.get('/coach/crm/leads', { coach_id: coachId }), [coachId]);
  const kpis = pipeline.data?.kpis;

  if (pipeline.loading) return <Loading />;
  if (pipeline.error) return <ErrorBox error={pipeline.error} retry={pipeline.reload} />;

  const byStage = pipeline.data?.by_stage ?? {};

  return (
    <View style={{ flex:1 }}>
      {kpis && (
        <MetricStrip items={[
          { label: t('crm.kpiActive'), value: kpis.active },
          { label: t('crm.kpiInTrial'), value: kpis.in_trial },
          { label: t('crm.kpiWon'), value: kpis.won, accent: c.green },
          { label: t('crm.kpiOverdue'), value: kpis.overdue, accent: kpis.overdue > 0 ? c.red : undefined },
        ]} />
      )}
      <ScrollView horizontal={isWide} style={{ flex:1 }} showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: isWide ? 'row' : 'column', gap:12, padding:4 }}>
          {STAGES.map(stage => (
            <View key={stage} style={{ width: isWide ? 220 : '100%' }}>
              <T weight="700" size={13} style={{ marginBottom:6 }}>{t(`crm.stage.${stage}`, stage.replace(/_/g,' '))} ({(byStage[stage] ?? []).length})</T>
              {(byStage[stage] ?? []).map(lead => (
                <LeadCard key={lead.id} lead={lead} onPress={() => push('LeadDetail', { lead_id: lead.id, coach_id: coachId })} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      <Btn label={t('crm.addLead')} onPress={() => setAddOpen(true)} style={{ margin:12 }} accessibilityLabel={t('crm.addLead')} />
      {addOpen && <AddLeadSheet coachId={coachId} onClose={() => { setAddOpen(false); pipeline.reload(); }} />}
    </View>
  );
}

// ── Add lead sheet ────────────────────────────────────────────────────────────

function AddLeadSheet({ coachId, onClose }) {
  const [form, setForm] = useState({ source_kind: 'manual_entry', marketing_consent: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const sports = useLoad(() => api.get('/sports'), []);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post('/coach/crm/leads', { coach_id: coachId, sport_id: form.sport_id, source_kind: form.source_kind, athlete_name: form.athlete_name || undefined, next_action_on: form.next_action_on || undefined, marketing_consent: form.marketing_consent });
      onClose();
    } catch (e) { setErr(e.message ?? t('crm.errSave')); }
    setBusy(false);
  };

  return (
    <FormSheet title={t('crm.addLead')} onClose={onClose}>
      {err && <ErrorBox error={err} />}
      <Field label={t('crm.athleteName')} value={form.athlete_name ?? ''} onChangeText={v => setForm(f => ({ ...f, athlete_name: v }))} accessibilityLabel={t('crm.athleteName')} />
      <MenuField label={t('crm.sport')} value={form.sport_id} options={(sports.data ?? []).map(s => ({ label: s.name, value: s.id }))} onSelect={v => setForm(f => ({ ...f, sport_id: v }))} accessibilityLabel={t('crm.sport')} />
      <MenuField label={t('crm.sourceKind')} value={form.source_kind} options={SOURCE_KINDS.map(k => ({ label: t(`crm.source.${k}`, k), value: k }))} onSelect={v => setForm(f => ({ ...f, source_kind: v }))} accessibilityLabel={t('crm.sourceKind')} />
      <Field label={t('crm.nextAction')} value={form.next_action_on ?? ''} onChangeText={v => setForm(f => ({ ...f, next_action_on: v }))} placeholder="YYYY-MM-DD" inputMode="numeric" accessibilityLabel={t('crm.nextAction')} />
      <Btn label={t('crm.save')} onPress={submit} loading={busy} accessibilityLabel={t('crm.save')} />
    </FormSheet>
  );
}

// ── Lead detail screen ────────────────────────────────────────────────────────

export function LeadDetail({ route }) {
  const { lead_id, coach_id } = route?.params ?? {};
  const [tab, setTab] = useState('overview');
  const lead = useLoad(() => api.get(`/coach/crm/leads/${lead_id}`), [lead_id]);
  const { push } = useNav();
  const [moveOpen, setMoveOpen] = useState(false);
  const [commOpen, setCommOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState(false);

  if (lead.loading) return <Screen title={t('crm.lead')}><Loading /></Screen>;
  if (lead.error) return <Screen title={t('crm.lead')}><ErrorBox error={lead.error} retry={lead.reload} /></Screen>;

  const ld = lead.data;
  return (
    <Screen title={ld.athlete_name ?? t('crm.lead')}>
      <Seg value={tab} onChange={setTab} options={[
        { label: t('crm.tabOverview'), value: 'overview' },
        { label: t('crm.tabComms'), value: 'comms' },
        { label: t('crm.tabTrial'), value: 'trial' },
        { label: t('crm.tabHistory'), value: 'history' },
      ]} />
      {tab === 'overview' && (
        <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:16, gap:12 }}>
          <MetricStrip items={[
            { label: t('crm.stage'), value: t(`crm.stage.${ld.stage}`, ld.stage) },
            { label: t('crm.source'), value: t(`crm.source.${ld.source_kind}`, ld.source_kind) },
            { label: t('crm.sla'), value: ld.sla_days ? `${ld.sla_days}d` : '—' },
          ]} />
          {ld.next_action_on && <T color={ld.overdue ? c.red : c.mute}>{t('crm.nextAction')}: {ld.next_action_on}</T>}
          {ld.loss_reason && <T color={c.red}>{t('crm.lossReason')}: {t(`crm.lossReason.${ld.loss_reason}`, ld.loss_reason)}</T>}
          {ld.loss_note && <T color={c.mute}>{ld.loss_note}</T>}
          <Btn label={t('crm.moveStage')} onPress={() => setMoveOpen(true)} accessibilityLabel={t('crm.moveStage')} />
          {moveOpen && <MoveStageSheet lead={ld} onClose={() => { setMoveOpen(false); lead.reload(); }} />}
        </ScrollView>
      )}
      {tab === 'comms' && (
        <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:16, gap:8 }}>
          {(ld.communications ?? []).length === 0 && <Empty label={t('crm.emptyComms')} />}
          {(ld.communications ?? []).map(c => (
            <Card key={c.id} pad={10} style={{ gap:4 }}>
              <Row>
                <Chip label={t(`crm.comm.${c.kind}`, c.kind)} />
                <T size={12} color={c.mute}>{new Date(c.created_at).toLocaleDateString()}</T>
              </Row>
              {c.summary && <T size={13}>{c.summary}</T>}
              {c.follow_up_on && <T size={12} color={c.mute}>{t('crm.followUpOn')}: {c.follow_up_on}</T>}
            </Card>
          ))}
          <Btn label={t('crm.logComm')} onPress={() => setCommOpen(true)} accessibilityLabel={t('crm.logComm')} />
          {commOpen && <LogCommSheet leadId={lead_id} onClose={() => { setCommOpen(false); lead.reload(); }} />}
        </ScrollView>
      )}
      {tab === 'trial' && (
        <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:16, gap:8 }}>
          <Btn label={t('crm.createTrial')} onPress={() => setTrialOpen(true)} accessibilityLabel={t('crm.createTrial')} />
          {trialOpen && <CreateTrialSheet coachId={coach_id} leadId={lead_id} onClose={() => { setTrialOpen(false); lead.reload(); }} />}
        </ScrollView>
      )}
      {tab === 'history' && (
        <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:16, gap:8 }}>
          <EventHistory leadId={lead_id} />
        </ScrollView>
      )}
    </Screen>
  );
}

function MoveStageSheet({ lead, onClose }) {
  const [stage, setStage] = useState(lead.stage);
  const [lossReason, setLossReason] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      await api.patch(`/coach/crm/leads/${lead.id}/stage`, { stage, loss_reason: lossReason || undefined, row_version: lead.row_version });
      onClose();
    } catch (e) { setErr(e.message ?? t('crm.errSave')); }
    setBusy(false);
  };

  return (
    <FormSheet title={t('crm.moveStage')} onClose={onClose}>
      {err && <ErrorBox error={err} />}
      <MenuField label={t('crm.stage')} value={stage} options={STAGES.map(s => ({ label: t(`crm.stage.${s}`, s), value: s }))} onSelect={setStage} accessibilityLabel={t('crm.stage')} />
      {stage === 'lost' && (
        <MenuField label={t('crm.lossReason')} value={lossReason} options={LOSS_REASONS.map(r => ({ label: t(`crm.lossReason.${r}`, r), value: r }))} onSelect={setLossReason} accessibilityLabel={t('crm.lossReason')} />
      )}
      <Btn label={t('crm.save')} onPress={submit} loading={busy} accessibilityLabel={t('crm.save')} />
    </FormSheet>
  );
}

function LogCommSheet({ leadId, onClose }) {
  const [form, setForm] = useState({ kind: 'note', summary: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ikey = useMemo(() => newKey(), []);

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      await api.post(`/coach/crm/leads/${leadId}/communications`, { kind: form.kind, summary: form.summary, idempotency_key: ikey });
      onClose();
    } catch (e) { setErr(e.message ?? t('crm.errSave')); }
    setBusy(false);
  };

  return (
    <FormSheet title={t('crm.logComm')} onClose={onClose}>
      {err && <ErrorBox error={err} />}
      <MenuField label={t('crm.commKind')} value={form.kind} options={COMM_KINDS.map(k => ({ label: t(`crm.comm.${k}`, k), value: k }))} onSelect={v => setForm(f => ({ ...f, kind: v }))} accessibilityLabel={t('crm.commKind')} />
      <Field label={t('crm.commSummary')} value={form.summary} onChangeText={v => setForm(f => ({ ...f, summary: v }))} multiline accessibilityLabel={t('crm.commSummary')} />
      <Btn label={t('crm.save')} onPress={submit} loading={busy} accessibilityLabel={t('crm.save')} />
    </FormSheet>
  );
}

function CreateTrialSheet({ coachId, leadId, onClose }) {
  const [form, setForm] = useState({ scheduled_on: '', duration_min: 60, price_cents: 0, currency: 'AUD' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const sports = useLoad(() => api.get('/sports'), []);

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      await api.post('/coach/crm/trials', { coach_id: coachId, lead_id: leadId, sport_id: form.sport_id, scheduled_on: form.scheduled_on, duration_min: form.duration_min, price_cents: form.price_cents, currency: form.currency });
      onClose();
    } catch (e) { setErr(e.message ?? t('crm.errSave')); }
    setBusy(false);
  };

  return (
    <FormSheet title={t('crm.createTrial')} onClose={onClose}>
      {err && <ErrorBox error={err} />}
      <MenuField label={t('crm.sport')} value={form.sport_id} options={(sports.data ?? []).map(s => ({ label: s.name, value: s.id }))} onSelect={v => setForm(f => ({ ...f, sport_id: v }))} accessibilityLabel={t('crm.sport')} />
      <Field label={t('crm.scheduledOn')} value={form.scheduled_on} onChangeText={v => setForm(f => ({ ...f, scheduled_on: v }))} placeholder="YYYY-MM-DD" inputMode="numeric" accessibilityLabel={t('crm.scheduledOn')} />
      <Field label={t('crm.durationMin')} value={String(form.duration_min)} onChangeText={v => setForm(f => ({ ...f, duration_min: parseInt(v) || 60 }))} inputMode="numeric" accessibilityLabel={t('crm.durationMin')} />
      <Btn label={t('crm.save')} onPress={submit} loading={busy} accessibilityLabel={t('crm.save')} />
    </FormSheet>
  );
}

function EventHistory({ leadId }) {
  const events = useLoad(() => api.get(`/coach/crm/leads/${leadId}/history`), [leadId]);
  if (events.loading) return <Loading />;
  if (!events.data?.length) return <Empty label={t('crm.emptyHistory')} />;
  return (
    <>
      {events.data.map(e => (
        <Card key={e.id} pad={10} style={{ gap:2 }}>
          <T weight="600" size={13}>{e.action.replace(/_/g,' ')}</T>
          {(e.from_stage || e.to_stage) && <T size={12} color={c.mute}>{e.from_stage} → {e.to_stage}</T>}
          <T size={11} color={c.mute}>{new Date(e.created_at).toLocaleString()}</T>
        </Card>
      ))}
    </>
  );
}

// ── Clients / lifecycle dashboard ─────────────────────────────────────────────

function ClientsTab({ coachId }) {
  const { width } = useWindowDimensions();
  const isWide = width >= 768;
  const dash = useLoad(() => api.get('/coach/crm/dashboard', { coach_id: coachId }), [coachId]);

  if (dash.loading) return <Loading />;
  if (dash.error) return <ErrorBox error={dash.error} retry={dash.reload} />;
  const d = dash.data ?? {};

  return (
    <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:16, gap:16 }}>
      <MetricStrip items={[
        { label: t('crm.dashActive'), value: d.active_clients ?? 0 },
        { label: t('crm.dashOverdue'), value: (d.overdue_payments ?? []).length, accent: (d.overdue_payments ?? []).length > 0 ? c.red : undefined },
        { label: t('crm.dashExpiring'), value: (d.expiring_packages ?? []).length, accent: (d.expiring_packages ?? []).length > 0 ? c.amber : undefined },
        { label: t('crm.dashFollowUps'), value: (d.follow_ups ?? []).length, accent: (d.follow_ups ?? []).length > 0 ? c.amber : undefined },
      ]} />

      <Section title={t('crm.dashUpcoming')} items={d.upcoming_sessions ?? []} renderItem={item => (
        <Card key={item.id} pad={10} style={{ marginBottom:6 }}>
          <T weight="600">{item.display_name}</T>
          <T size={12} color={c.mute}>{new Date(item.starts_at).toLocaleString()} · {item.duration_min}min</T>
        </Card>
      )} />

      <Section title={t('crm.dashInactive')} items={d.inactive_clients ?? []} renderItem={item => (
        <Card key={item.athlete_id} pad={10} style={{ marginBottom:6 }}>
          <T weight="600">{item.display_name}</T>
          <T size={12} color={c.red}>{t('crm.inactiveDays', { days: item.days_inactive })}</T>
        </Card>
      )} />

      <Section title={t('crm.dashRenewals')} items={d.subscription_renewals ?? []} renderItem={item => (
        <Card key={item.id} pad={10} style={{ marginBottom:6 }}>
          <T weight="600">{item.display_name}</T>
          <T size={12} color={c.amber}>{t('crm.renewsOn', { date: new Date(item.renews_at).toLocaleDateString() })}</T>
        </Card>
      )} />
    </ScrollView>
  );
}

function Section({ title, items, renderItem }) {
  if (!items?.length) return null;
  return (
    <View style={{ gap:6 }}>
      <T weight="700" size={15}>{title} ({items.length})</T>
      {items.map(renderItem)}
    </View>
  );
}

// ── Analytics tab ─────────────────────────────────────────────────────────────

function AnalyticsTab({ coachId }) {
  const analytics = useLoad(() => api.get('/coach/crm/analytics', { coach_id: coachId }), [coachId]);
  if (analytics.loading) return <Loading />;
  if (analytics.error) return <ErrorBox error={analytics.error} retry={analytics.reload} />;
  const a = analytics.data ?? {};
  const f = a.funnel ?? {};
  const att = a.attendance ?? {};
  const pkg = a.package_utilisation ?? {};

  return (
    <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:16, gap:16 }}>
      <T weight="700" size={16}>{t('crm.kpiFunnel')}</T>
      <MetricStrip items={[
        { label: t('crm.kpiEnquiries'), value: f.total_leads ?? 0 },
        { label: t('crm.kpiEnquiryToTrial'), value: `${f.enquiry_to_trial_pct ?? 0}%` },
        { label: t('crm.kpiTrialToWon'), value: `${f.trial_to_won_pct ?? 0}%`, accent: c.green },
        { label: t('crm.kpiWon'), value: f.won ?? 0, accent: c.green },
      ]} />

      <T weight="700" size={16}>{t('crm.kpiAttendance')}</T>
      <MetricStrip items={[
        { label: t('crm.kpiAttended'), value: att.attended ?? 0, accent: c.green },
        { label: t('crm.kpiNoShow'), value: att.no_show ?? 0, accent: c.red },
        { label: t('crm.kpiAttendancePct'), value: att.attendance_pct != null ? `${att.attendance_pct}%` : '—' },
      ]} />

      <T weight="700" size={16}>{t('crm.kpiPackages')}</T>
      <MetricStrip items={[
        { label: t('crm.kpiPackagesSold'), value: pkg.packages_sold ?? 0 },
        { label: t('crm.kpiUtilisation'), value: pkg.utilisation_pct != null ? `${pkg.utilisation_pct}%` : '—' },
      ]} />

      {(a.revenue_by_service ?? []).length > 0 && (
        <View style={{ gap:6 }}>
          <T weight="700" size={16}>{t('crm.kpiRevenue')}</T>
          {a.revenue_by_service.map(r => (
            <Card key={r.purpose_type} pad={10}>
              <Row>
                <T style={{ flex:1 }}>{r.purpose_type.replace(/_/g,' ')}</T>
                <T weight="700">{(r.total_cents / 100).toFixed(2)}</T>
              </Row>
            </Card>
          ))}
        </View>
      )}

      {(a.source_attribution ?? []).length > 0 && (
        <View style={{ gap:6 }}>
          <T weight="700" size={16}>{t('crm.kpiSources')}</T>
          {a.source_attribution.map(s => (
            <Card key={s.source_kind} pad={10}>
              <Row>
                <T style={{ flex:1 }}>{t(`crm.source.${s.source_kind}`, s.source_kind)}</T>
                <T>{s.leads} → {s.won}</T>
              </Row>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ── Campaigns tab ─────────────────────────────────────────────────────────────

function CampaignsTab({ coachId }) {
  const [createOpen, setCreateOpen] = useState(false);
  const list = useLoad(() => api.get('/coach/crm/campaigns', { coach_id: coachId }), [coachId]);

  if (list.loading) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} retry={list.reload} />;

  return (
    <View style={{ flex:1 }}>
      <ScrollView style={{ flex:1 }} contentContainerStyle={{ padding:16, gap:8 }}>
        {!(list.data?.campaigns?.length) && <Empty label={t('crm.emptyCampaigns')} />}
        {(list.data?.campaigns ?? []).map(camp => (
          <Card key={camp.id} pad={12} style={{ gap:6 }}>
            <Row>
              <T weight="700" style={{ flex:1 }}>{camp.name}</T>
              <Chip label={t(`crm.campaignStatus.${camp.status}`, camp.status)} />
            </Row>
            <T size={12} color={c.mute}>{t(`crm.campaignKind.${camp.kind}`, camp.kind.replace(/_/g,' '))}</T>
            {camp.sent_at && <T size={12} color={c.mute}>{t('crm.sentAt', { date: new Date(camp.sent_at).toLocaleDateString() })} · {camp.delivered_count}/{camp.recipient_count}</T>}
          </Card>
        ))}
      </ScrollView>
      <Btn label={t('crm.createCampaign')} onPress={() => setCreateOpen(true)} style={{ margin:12 }} accessibilityLabel={t('crm.createCampaign')} />
      {createOpen && <CreateCampaignSheet coachId={coachId} onClose={() => { setCreateOpen(false); list.reload(); }} />}
    </View>
  );
}

function CreateCampaignSheet({ coachId, onClose }) {
  const [form, setForm] = useState({ kind: 'general', name: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      await api.post('/coach/crm/campaigns', { coach_id: coachId, name: form.name, kind: form.kind });
      onClose();
    } catch (e) { setErr(e.message ?? t('crm.errSave')); }
    setBusy(false);
  };

  return (
    <FormSheet title={t('crm.createCampaign')} onClose={onClose}>
      {err && <ErrorBox error={err} />}
      <Field label={t('crm.campaignName')} value={form.name} onChangeText={v => setForm(f => ({ ...f, name: v }))} accessibilityLabel={t('crm.campaignName')} />
      <MenuField label={t('crm.campaignKind')} value={form.kind} options={CAMPAIGN_KINDS.map(k => ({ label: t(`crm.campaignKind.${k}`, k.replace(/_/g,' ')), value: k }))} onSelect={v => setForm(f => ({ ...f, kind: v }))} accessibilityLabel={t('crm.campaignKind')} />
      <Btn label={t('crm.save')} onPress={submit} loading={busy} accessibilityLabel={t('crm.save')} />
    </FormSheet>
  );
}

// ── Video Review screen ───────────────────────────────────────────────────────

export function CoachVideoReview({ route }) {
  const { coach_id } = route?.params ?? {};
  const { user } = useSession();
  const isCoach = user?.id === coach_id;
  const [feedbackOpen, setFeedbackOpen] = useState(null);

  const list = useLoad(
    () => isCoach
      ? api.get('/coach/video-review', { coach_id })
      : api.get('/me/video-review'),
    [isCoach, coach_id],
  );

  const requests = list.data?.requests ?? [];

  return (
    <Screen title={t('cvr.title')}>
      {list.loading && <Loading />}
      {list.error && <ErrorBox error={list.error} retry={list.reload} />}
      {!list.loading && !requests.length && <Empty label={t('cvr.empty')} />}
      <ScrollView contentContainerStyle={{ padding:16, gap:8 }}>
        {requests.map(req => (
          <Card key={req.id} pad={12} style={{ gap:6 }} onPress={() => setFeedbackOpen(req.id)} accessibilityLabel={`${req.display_name ?? req.coach_name} ${t(`cvr.status.${req.status}`, req.status)}`}>
            <Row>
              <T weight="700" style={{ flex:1 }}>{req.display_name ?? req.coach_name}</T>
              <Chip label={t(`cvr.status.${req.status}`, req.status.replace(/_/g,' '))} />
            </Row>
            <T size={12} color={c.mute}>{new Date(req.created_at).toLocaleDateString()}</T>
          </Card>
        ))}
      </ScrollView>
      {feedbackOpen && (
        <VideoReviewDetail reviewId={feedbackOpen} isCoach={isCoach} onClose={() => { setFeedbackOpen(null); list.reload(); }} />
      )}
    </Screen>
  );
}

function VideoReviewDetail({ reviewId, isCoach, onClose }) {
  const review = useLoad(() => api.get(`/coach/video-review/${reviewId}`), [reviewId]);
  const [feedbackText, setFeedbackText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (review.loading) return <Loading />;
  if (review.error) return <FormSheet title={t('cvr.detail')} onClose={onClose}><ErrorBox error={review.error} /></FormSheet>;

  const r = review.data;

  const submitFeedback = async () => {
    setErr(null); setBusy(true);
    try {
      await api.patch(`/coach/video-review/${reviewId}/complete`, { feedback: feedbackText, row_version: r.row_version });
      onClose();
    } catch (e) { setErr(e.message ?? t('crm.errSave')); }
    setBusy(false);
  };

  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.patch(`/coach/video-review/${reviewId}/acknowledge`, { row_version: r.row_version });
      onClose();
    } catch (e) { setErr(e.message ?? t('crm.errSave')); }
    setBusy(false);
  };

  return (
    <FormSheet title={t('cvr.detail')} onClose={onClose}>
      {err && <ErrorBox error={err} />}
      <Chip label={t(`cvr.status.${r.status}`, r.status)} />
      {r.brief && (
        <Card pad={10}><T weight="700">{t('cvr.brief')}</T><T style={{ marginTop:4 }}>{r.brief}</T></Card>
      )}
      {r.feedback && (
        <Card pad={10}><T weight="700">{t('cvr.feedback')}</T><T style={{ marginTop:4 }}>{r.feedback}</T></Card>
      )}
      {(r.timestamps_json ?? []).length > 0 && (
        <View style={{ gap:4 }}>
          <T weight="700">{t('cvr.timestamps')}</T>
          {r.timestamps_json.map((ts, i) => (
            <T key={i} size={13}>{ts.t_secs}s — {ts.label}{ts.action_text ? ` · ${ts.action_text}` : ''}</T>
          ))}
        </View>
      )}
      {(r.assignments_json ?? []).length > 0 && (
        <View style={{ gap:4 }}>
          <T weight="700">{t('cvr.assignments')}</T>
          {r.assignments_json.map((a, i) => (
            <Row key={i}>
              <T size={13} style={{ flex:1 }}>{a.description}</T>
              {a.due_on && <T size={12} color={c.mute}>{a.due_on}</T>}
            </Row>
          ))}
        </View>
      )}
      {isCoach && r.status === 'under_review' && (
        <>
          <Field label={t('cvr.writeFeedback')} value={feedbackText} onChangeText={setFeedbackText} multiline accessibilityLabel={t('cvr.writeFeedback')} />
          <Btn label={t('cvr.submitFeedback')} onPress={submitFeedback} loading={busy} accessibilityLabel={t('cvr.submitFeedback')} />
        </>
      )}
      {!isCoach && r.status === 'review_complete' && (
        <Btn label={t('cvr.acknowledge')} onPress={acknowledge} loading={busy} accessibilityLabel={t('cvr.acknowledge')} />
      )}
    </FormSheet>
  );
}

// ── Main CoachCRM screen ──────────────────────────────────────────────────────

export function CoachCRM({ route }) {
  const { coach_id } = route?.params ?? {};
  const { user } = useSession();
  const coachId = coach_id ?? user?.id;
  const [tab, setTab] = useState('leads');

  return (
    <Screen title={t('crm.title')}>
      <Seg value={tab} onChange={setTab} options={[
        { label: t('crm.tabLeads'),     value: 'leads' },
        { label: t('crm.tabClients'),   value: 'clients' },
        { label: t('crm.tabAnalytics'), value: 'analytics' },
        { label: t('crm.tabCampaigns'), value: 'campaigns' },
      ]} />
      {tab === 'leads'     && <LeadsTab coachId={coachId} />}
      {tab === 'clients'   && <ClientsTab coachId={coachId} />}
      {tab === 'analytics' && <AnalyticsTab coachId={coachId} />}
      {tab === 'campaigns' && <CampaignsTab coachId={coachId} />}
    </Screen>
  );
}
