// Sports medicine & RTP (issue #584): longitudinal injury episode management.
// Surfaces: (1) InjuryEpisodeEntry — clinician entry point inside doctor/physio workspace;
// (2) EpisodeDetailScreen — full episode hub with timeline, RTP protocol, artefacts, impact;
// (3) AthleteEpisodeView — athlete's non-clinical view exported to health-file.js;
// (4) CoachInjuryStatusView — coach's availability-only view exported to team-manage.js.
// All clinical detail (notes, criteria, internal assessments) is hidden from non-clinical views.
import React, { useState, useCallback } from 'react';
import { Platform, View, ScrollView, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, Empty, ErrorBox, GradCard, H2, Loading, Row, Seg, Sheet, StatPill, T, Tag, Wrap } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day, font, grad, r, when } from '../theme';
import { t } from '../i18n';

// ─── constants ──────────────────────────────────────────────────────────────

const BODY_REGIONS = [
  'neck','head','face','shoulder','chest','abdomen','elbow','wrist_hand',
  'upper_back','lower_back','groin','hip','thigh','hamstring','quadriceps',
  'knee','calf','achilles','ankle_foot','core','full_body',
];

const INJURY_TYPES = ['strain','sprain','fracture','contusion','laceration','tendinopathy','concussion','dislocation','nerve','other'];
const MECHANISMS = ['contact','non_contact','overuse','acute_on_chronic','unknown'];
const SEVERITIES = ['minor','moderate','significant','severe'];
const SIDES = ['left','right','bilateral','central','na'];

const STATUS_ORDER = ['active','rehabilitation','restricted_training','return_to_train','return_to_play','closed'];
const STATUS_META = {
  active:             { label: t('inj.status.active'),             color: c.red,    soft: c.redSoft,    emoji: '🩺' },
  rehabilitation:     { label: t('inj.status.rehabilitation'),     color: c.orange, soft: c.orangeSoft, emoji: '🏃' },
  restricted_training:{ label: t('inj.status.restricted_training'),color: c.sun,    soft: c.sunSoft,    emoji: '⚠️' },
  return_to_train:    { label: t('inj.status.return_to_train'),    color: c.cyan,   soft: c.cyanSoft,   emoji: '🔵' },
  return_to_play:     { label: t('inj.status.return_to_play'),     color: c.mint,   soft: c.mintSoft,   emoji: '✅' },
  closed:             { label: t('inj.status.closed'),             color: c.lime,   soft: c.limeSoft,   emoji: '🏆' },
  cancelled:          { label: t('inj.status.cancelled'),          color: c.mute,   soft: c.line,       emoji: '✖️' },
};

const ATHLETE_PHASES = {
  active:             { label: t('inj.athlete_phase.recovery'),        color: c.red },
  rehabilitation:     { label: t('inj.athlete_phase.rehab'),           color: c.orange },
  restricted_training:{ label: t('inj.athlete_phase.limited_training'),color: c.sun },
  return_to_train:    { label: t('inj.athlete_phase.back_to_training'),color: c.cyan },
  return_to_play:     { label: t('inj.athlete_phase.cleared_to_play'), color: c.lime },
  closed:             { label: t('inj.athlete_phase.cleared_to_play'), color: c.lime },
};

const MILESTONE_STATUS_META = {
  pending:     { label: 'Pending',     color: c.mute },
  in_progress: { label: 'In progress', color: c.cyan },
  achieved:    { label: 'Achieved',    color: c.lime },
  failed:      { label: 'Failed',      color: c.red },
  skipped:     { label: 'Skipped',     color: c.mute },
};

const RTP_APPROVAL_META = {
  return_to_train: { label: 'Return-to-Train', color: c.sun,  soft: c.sunSoft  },
  return_to_play:  { label: 'Return-to-Play',  color: c.lime, soft: c.limeSoft },
};

// ─── shared helpers ──────────────────────────────────────────────────────────

const EpStatusChip = ({ status, small }) => {
  const m = STATUS_META[status] ?? STATUS_META.active;
  return <Tag label={m.emoji + ' ' + m.label} color={m.soft} style={small ? { paddingVertical: 3, paddingHorizontal: 8 } : {}} />;
};

const SevChip = ({ severity }) => {
  const col = { minor: c.limeSoft, moderate: c.sunSoft, significant: c.orangeSoft, severe: c.redSoft };
  return severity ? <Tag label={severity.charAt(0).toUpperCase() + severity.slice(1)} color={col[severity] ?? c.line} /> : null;
};

const StatusBar = ({ status }) => {
  const steps = STATUS_ORDER.slice(0, -1); // exclude closed from progress bar
  const idx = steps.indexOf(status);
  return (
    <View style={{ flexDirection: 'row', gap: 4, marginVertical: 8 }}>
      {steps.map((s, i) => {
        const m = STATUS_META[s];
        const done = i < idx;
        const active = i === idx;
        return (
          <View key={s} style={{ flex: 1, height: 6, borderRadius: 3,
            backgroundColor: done ? m.color : active ? m.color : c.line, opacity: done ? 0.6 : active ? 1 : 1 }} />
        );
      })}
    </View>
  );
};

const DaysSince = ({ date }) => {
  if (!date) return null;
  const days = Math.floor((Date.now() - new Date(date)) / 86_400_000);
  return <T size={12} color={c.mute}>{days === 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`}</T>;
};

function useAct(reload) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const act = useCallback(async (fn, success) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (success) setMsg({ ok: true, text: success }); if (reload) reload(); }
    catch (e) { setMsg({ ok: false, text: e?.message ?? 'Something went wrong' }); }
    finally { setBusy(false); }
  }, [reload]);
  return { act, busy, msg };
}

// ─── clinician: open new episode ─────────────────────────────────────────────

export function NewEpisodeSheet({ athleteId, visible, onClose, onCreated }) {
  const { act, busy, msg } = useAct(null);
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={t('inj.open_episode')}
      color={c.red}
      submitLabel={t('inj.open_episode')}
      busy={busy}
      msg={msg}
      fields={[
        { key: 's_core', label: 'Injury details', type: 'section' },
        { key: 'occurred_on', label: t('inj.occurred_on'), type: 'date', required: true },
        { key: 'body_region', label: t('inj.body_region'), type: 'select',
          options: BODY_REGIONS.map((v) => ({ value: v, label: v.replace(/_/g, ' ') })), required: true },
        { key: 'side', label: t('inj.side'), type: 'chips',
          options: SIDES.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })), required: true },
        { key: 'injury_type', label: t('inj.injury_type'), type: 'chips',
          options: INJURY_TYPES.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })), required: true },
        { key: 's_detail', label: 'Clinical context', type: 'section' },
        { key: 'mechanism', label: t('inj.mechanism'), type: 'chips',
          options: MECHANISMS.map((v) => ({ value: v, label: v.replace(/_/g, ' ') })), optional: true },
        { key: 'severity', label: t('inj.severity'), type: 'chips',
          options: SEVERITIES.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })), optional: true },
        { key: 'first_assessment_on', label: 'First assessed', type: 'date', optional: true },
        { key: 'expected_return_on', label: t('inj.expected_return'), type: 'date', optional: true,
          hint: 'Clinician estimate — never a guarantee. Shared with athlete; coaches only see it if you opt in.' },
        { key: 's_context', label: 'History', type: 'section' },
        { key: 'is_recurrence', label: t('inj.is_recurrence'), type: 'toggle', optional: true,
          hint: 'Has this athlete had this injury at this site before?' },
      ]}
      onSubmit={async (v) => {
        const ep = await api.post(`/athletes/${athleteId}/injury-episodes`, {
          occurred_on: v.occurred_on,
          body_region: v.body_region,
          side: v.side,
          injury_type: v.injury_type,
          mechanism: v.mechanism || undefined,
          severity: v.severity || undefined,
          first_assessment_on: v.first_assessment_on || undefined,
          expected_return_on: v.expected_return_on || undefined,
          is_recurrence: !!v.is_recurrence,
        });
        if (onCreated) onCreated(ep);
        return t('inj.episode_opened_confirm');
      }}
    />
  );
}

// ─── clinician: episode list entry point ─────────────────────────────────────

export function InjuryEpisodeEntry({ athleteId, athleteName }) {
  const q = useLoad(() => api.get(`/athletes/${athleteId}/injury-episodes`, { limit: 50 }), [athleteId]);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null);

  if (selected) {
    return <EpisodeDetailScreen episodeId={selected} onBack={() => { setSelected(null); q.reload(); }} forClinician />;
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <H2>{t('inj.episodes_title')}</H2>
        <Btn small title={t('inj.open_episode')} color={c.red} onPress={() => setCreating(true)} />
      </View>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : (
        (q.data?.length === 0)
          ? <Empty emoji="🩺" title="No injury episodes" sub="Open an episode to start tracking an injury from first assessment through to return-to-play." />
          : (q.data ?? []).map((ep) => (
              <Pressable key={ep.id} onPress={() => setSelected(ep.id)} accessibilityRole="button" accessibilityLabel={`Episode ${ep.episode_ref}`}>
                <Card>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 6 }}>
                    <View style={{ gap: 2, flex: 1 }}>
                      <T weight="800">{ep.episode_ref}</T>
                      <T size={13} color={c.mute}>{ep.body_region?.replace(/_/g, ' ')} {ep.side && ep.side !== 'na' ? `· ${ep.side}` : ''} · {ep.injury_type?.replace(/_/g, ' ')}</T>
                    </View>
                    <EpStatusChip status={ep.status} small />
                  </View>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                    <SevChip severity={ep.severity} />
                    <T size={12} color={c.mute}>{ep.occurred_on ? day(ep.occurred_on) : ''}</T>
                    <DaysSince date={ep.occurred_on} />
                    {ep.expected_return_on && ep.status !== 'closed' ? (
                      <T size={12} color={c.mint}>Expected return: {day(ep.expected_return_on)}</T>
                    ) : null}
                  </View>
                </Card>
              </Pressable>
            ))
      )}
      <NewEpisodeSheet athleteId={athleteId} visible={creating} onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); q.reload(); }} />
    </View>
  );
}

// ─── episode detail screen ────────────────────────────────────────────────────

export function EpisodeDetailScreen({ episodeId, onBack, forClinician = false }) {
  const q = useLoad(() => api.get(`/injury-episodes/${episodeId}`), [episodeId]);
  const [tab, setTab] = useState('overview');

  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const ep = q.data;
  if (!ep) return null;

  const tabs = [
    { value: 'overview',   label: 'Overview',   emoji: '📋' },
    { value: 'rtp',        label: 'RTP Protocol', emoji: '🏁' },
    { value: 'timeline',   label: 'Timeline',   emoji: '📅' },
    { value: 'artefacts',  label: 'Artefacts',  emoji: '🔗' },
    { value: 'impact',     label: 'Impact',     emoji: '⚽' },
    ...(forClinician ? [{ value: 'sharing', label: 'Sharing', emoji: '👥' }] : []),
  ];

  const TabBody = {
    overview:  () => <EpisodeOverview ep={ep} reload={q.reload} forClinician={forClinician} />,
    rtp:       () => <RTPProtocolPanel episodeId={episodeId} ep={ep} reload={q.reload} forClinician={forClinician} />,
    timeline:  () => <EpisodeTimeline episodeId={episodeId} forClinician={forClinician} />,
    artefacts: () => <EpisodeArtefacts episodeId={episodeId} ep={ep} reload={q.reload} forClinician={forClinician} />,
    impact:    () => <EpisodeImpactPanel episodeId={episodeId} ep={ep} reload={q.reload} forClinician={forClinician} />,
    sharing:   () => <EpisodeSharing episodeId={episodeId} ep={ep} reload={q.reload} />,
  }[tab];

  return (
    <View style={{ gap: 0 }}>
      {/* Header */}
      <GradCard colors={grad.sunset} pad={16}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <View style={{ gap: 4, flex: 1 }}>
            {onBack ? <Btn small title="← Back" color="transparent" ink={c.line} onPress={onBack} style={{ alignSelf: 'flex-start', marginBottom: 4 }} /> : null}
            <T weight="900" size={20} color="#fff">{ep.episode_ref}</T>
            <T size={14} color="rgba(255,255,255,0.8)">{ep.body_region?.replace(/_/g, ' ')} {ep.side && ep.side !== 'na' ? `· ${ep.side}` : ''}</T>
            <T size={13} color="rgba(255,255,255,0.7)">{ep.injury_type?.replace(/_/g, ' ')} · occurred {ep.occurred_on ? day(ep.occurred_on) : ''}</T>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <EpStatusChip status={ep.status} />
            {forClinician ? <SevChip severity={ep.severity} /> : null}
          </View>
        </View>
        <StatusBar status={ep.status} />
        <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
          {ep.expected_return_on && ep.status !== 'closed' ? (
            <T size={12} color="rgba(255,255,255,0.9)">Expected return: {day(ep.expected_return_on)}</T>
          ) : null}
          {ep.actual_return_on ? (
            <T size={12} color="rgba(255,255,255,0.9)">Returned: {day(ep.actual_return_on)}</T>
          ) : null}
        </View>
      </GradCard>

      <View style={{ marginTop: 8 }}>
        <Seg options={tabs} value={tab} onChange={setTab} color={STATUS_META[ep.status]?.color ?? c.red} />
      </View>

      <View style={{ marginTop: 8 }}>
        {TabBody ? <TabBody /> : null}
      </View>
    </View>
  );
}

// ─── overview tab ─────────────────────────────────────────────────────────────

function EpisodeOverview({ ep, reload, forClinician }) {
  const [transitioning, setTransitioning] = useState(false);
  const [closing, setClosing] = useState(false);
  const { act, busy, msg } = useAct(reload);

  const NEXT_STATUS = {
    active: 'rehabilitation',
    rehabilitation: 'restricted_training',
    restricted_training: 'return_to_train',
    return_to_train: 'return_to_play',
    return_to_play: 'closed',
  };
  const nextStatus = NEXT_STATUS[ep.status];

  return (
    <View style={{ gap: 10 }}>
      {/* Key metrics strip */}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <StatPill value={ep.occurred_on ? Math.floor((Date.now() - new Date(ep.occurred_on)) / 86_400_000) : '—'} label="Days since injury" color={c.redSoft} />
        {ep.expected_return_on ? (
          <StatPill
            value={Math.max(0, Math.floor((new Date(ep.expected_return_on) - Date.now()) / 86_400_000))}
            label="Days to exp. return"
            color={c.mintSoft}
          />
        ) : null}
        {ep.is_recurrence ? <StatPill value="⚠️" label="Recurrence" color={c.orangeSoft} /> : null}
      </View>

      {/* Episode info card */}
      <Card>
        <H2>Episode details</H2>
        <View style={{ gap: 6, marginTop: 8 }}>
          <Detail label="Ref" value={ep.episode_ref} />
          <Detail label="Body region" value={ep.body_region?.replace(/_/g, ' ')} />
          <Detail label="Side" value={ep.side} />
          <Detail label="Type" value={ep.injury_type?.replace(/_/g, ' ')} />
          <Detail label="Mechanism" value={ep.mechanism?.replace(/_/g, ' ')} />
          {forClinician ? <Detail label="Severity" value={ep.severity} /> : null}
          <Detail label="Occurred" value={ep.occurred_on ? day(ep.occurred_on) : '—'} />
          {ep.first_assessment_on ? <Detail label="First assessed" value={day(ep.first_assessment_on)} /> : null}
          {ep.sport_id ? <Detail label="Sport context" value={ep.sport_name ?? ep.sport_id} /> : null}
          {ep.actual_return_on ? <Detail label="Returned to play" value={day(ep.actual_return_on)} /> : null}
        </View>
      </Card>

      {/* Clinician actions */}
      {forClinician && ep.status !== 'closed' && ep.status !== 'cancelled' ? (
        <Card>
          <H2>Actions</H2>
          <View style={{ gap: 8, marginTop: 8 }}>
            {nextStatus ? (
              <Btn title={`Advance to ${STATUS_META[nextStatus]?.label ?? nextStatus}`}
                color={STATUS_META[nextStatus]?.color ?? c.mint}
                onPress={() => setTransitioning(nextStatus)} />
            ) : null}
            <Btn title="Close episode" color={c.lime} onPress={() => setClosing(true)} />
            <Btn title="Cancel episode" color={c.mute} ink={c.ink}
              onPress={() => act(() => api.post(`/injury-episodes/${ep.id}/transition`, { to_status: 'cancelled' }),
                'Episode cancelled')} />
          </View>
          {msg ? <T size={13} color={msg.ok ? c.lime : c.red} style={{ marginTop: 8 }}>{msg.text}</T> : null}
        </Card>
      ) : null}

      {/* Transition sheet */}
      <FormSheet
        visible={!!transitioning}
        onClose={() => setTransitioning(false)}
        title={`Advance to ${STATUS_META[transitioning]?.label ?? ''}`}
        color={STATUS_META[transitioning]?.color ?? c.mint}
        submitLabel="Confirm transition"
        fields={[
          { key: 'note', label: 'Clinical note (optional)', type: 'multiline', optional: true,
            hint: 'Encrypted — only visible to clinical team.' },
        ]}
        onSubmit={async (v) => {
          await api.post(`/injury-episodes/${ep.id}/transition`, { to_status: transitioning, note: v.note || undefined });
          setTransitioning(false);
          reload();
          return `Advanced to ${STATUS_META[transitioning]?.label}`;
        }}
      />

      {/* Close sheet */}
      <FormSheet
        visible={closing}
        onClose={() => setClosing(false)}
        title="Close episode"
        color={c.lime}
        submitLabel="Close episode"
        fields={[
          { key: 'actual_return_on', label: 'Actual return date', type: 'date', required: true },
          { key: 'outcome_note', label: 'Outcome note (optional)', type: 'multiline', optional: true,
            hint: 'Encrypted — only visible to clinical team.' },
        ]}
        onSubmit={async (v) => {
          await api.post(`/injury-episodes/${ep.id}/close`, {
            actual_return_on: v.actual_return_on,
            outcome_note: v.outcome_note || undefined,
          });
          setClosing(false);
          reload();
          return 'Episode closed';
        }}
      />
    </View>
  );
}

const Detail = ({ label, value }) =>
  value ? (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <T size={13} color={c.mute} style={{ width: 110, flexShrink: 0 }}>{label}</T>
      <T size={13} style={{ flex: 1, textTransform: 'capitalize' }}>{value}</T>
    </View>
  ) : null;

// ─── RTP protocol tab ─────────────────────────────────────────────────────────

function RTPProtocolPanel({ episodeId, ep, reload, forClinician }) {
  const q = useLoad(() => api.get(`/injury-episodes/${episodeId}/rtp`), [episodeId]);
  const [editingMilestones, setEditingMilestones] = useState(false);
  const [updatingMilestone, setUpdatingMilestone] = useState(null);
  const [issuingApproval, setIssuingApproval] = useState(null); // 'return_to_train' | 'return_to_play'
  const [revokingApproval, setRevokingApproval] = useState(null);
  const { act, busy, msg } = useAct(q.reload);

  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;

  const { milestones = [], approvals = [] } = q.data ?? {};
  const liveRTT = approvals.find((a) => a.approval_type === 'return_to_train' && !a.revoked_at && a.status !== 'deferred');
  const liveRTP = approvals.find((a) => a.approval_type === 'return_to_play' && !a.revoked_at && a.status !== 'deferred');
  const allMilestonesAchieved = milestones.length > 0 && milestones.every((m) => ['achieved','skipped'].includes(m.status));

  return (
    <View style={{ gap: 12 }}>
      {/* RTP approval cards */}
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <ApprovalCard label="Return-to-Train" approval={liveRTT} color={c.sun} soft={c.sunSoft}
          onIssue={forClinician ? () => setIssuingApproval('return_to_train') : null}
          onRevoke={forClinician && liveRTT ? () => setRevokingApproval(liveRTT) : null} />
        <ApprovalCard label="Return-to-Play" approval={liveRTP} color={c.lime} soft={c.limeSoft}
          onIssue={forClinician ? () => setIssuingApproval('return_to_play') : null}
          onRevoke={forClinician && liveRTP ? () => setRevokingApproval(liveRTP) : null} />
      </View>

      {/* Milestone stages */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <H2>RTP Milestones</H2>
        {forClinician ? <Btn small title={milestones.length ? 'Edit stages' : 'Set protocol'} color={c.red} onPress={() => setEditingMilestones(true)} /> : null}
      </View>

      {milestones.length === 0 ? (
        <Empty emoji="🏁" title="No RTP protocol set" sub={forClinician ? 'Set the milestone stages that must be achieved before return-to-play approval.' : 'Your clinician will set up the return-to-play milestones.'} />
      ) : (
        <View style={{ gap: 8 }}>
          {milestones.map((m, idx) => (
            <MilestoneCard key={m.id} m={m} idx={idx} forClinician={forClinician}
              onUpdate={forClinician ? () => setUpdatingMilestone(m) : null} />
          ))}
          {forClinician && allMilestonesAchieved && !liveRTP ? (
            <Card color={c.limeSoft}>
              <T size={13} color={c.lime} weight="700">All milestones achieved — ready to issue Return-to-Play</T>
              <Btn title="Issue Return-to-Play" color={c.lime} style={{ marginTop: 8 }} onPress={() => setIssuingApproval('return_to_play')} />
            </Card>
          ) : null}
        </View>
      )}

      {/* Set milestones sheet */}
      <SetMilestonesSheet episodeId={episodeId} existing={milestones} visible={editingMilestones}
        onClose={() => { setEditingMilestones(false); q.reload(); }} />

      {/* Update milestone sheet */}
      {updatingMilestone ? (
        <UpdateMilestoneSheet milestone={updatingMilestone} episodeId={episodeId}
          visible={!!updatingMilestone} onClose={() => { setUpdatingMilestone(null); q.reload(); }} />
      ) : null}

      {/* Issue approval sheet */}
      {issuingApproval ? (
        <IssueApprovalSheet type={issuingApproval} episodeId={episodeId}
          visible={!!issuingApproval} onClose={() => { setIssuingApproval(null); q.reload(); reload?.(); }} />
      ) : null}

      {/* Revoke approval sheet */}
      <FormSheet
        visible={!!revokingApproval}
        onClose={() => setRevokingApproval(null)}
        title="Revoke approval"
        color={c.red}
        submitLabel="Revoke"
        fields={[{ key: 'reason', label: 'Reason for revocation', type: 'multiline', required: true,
          hint: 'Encrypted — only visible to the clinical team.' }]}
        onSubmit={async (v) => {
          await api.post(`/injury-episodes/${episodeId}/rtp/approvals/${revokingApproval.id}/revoke`, { reason: v.reason });
          setRevokingApproval(null); q.reload(); reload?.();
          return 'Approval revoked';
        }}
      />
    </View>
  );
}

function ApprovalCard({ label, approval, color, soft, onIssue, onRevoke }) {
  const issued = approval && !approval.revoked_at;
  return (
    <Card color={issued ? soft : c.paper} style={{ flex: 1, minWidth: 150 }}>
      <T weight="800" size={13}>{label}</T>
      {issued ? (
        <View style={{ gap: 4, marginTop: 6 }}>
          <Tag label={approval.status.charAt(0).toUpperCase() + approval.status.slice(1)} color={color} />
          <T size={12} color={c.mute}>Issued: {day(approval.approved_on)}</T>
          {approval.valid_until ? <T size={12} color={c.mute}>Valid until: {day(approval.valid_until)}</T> : null}
          {approval.load_restrictions?.length ? (
            <View style={{ marginTop: 4, gap: 2 }}>
              <T size={12} weight="700">Restrictions:</T>
              {approval.load_restrictions.map((x, i) => <T key={i} size={12} color={c.mute}>• {x.activity}: {x.limit}</T>)}
            </View>
          ) : <T size={12} color={c.lime}>No restrictions</T>}
          {onRevoke ? <Btn small title="Revoke" color={c.redSoft} ink={c.red} onPress={onRevoke} style={{ marginTop: 6 }} /> : null}
        </View>
      ) : (
        <View style={{ gap: 6, marginTop: 6 }}>
          <T size={12} color={c.mute}>Not yet issued</T>
          {onIssue ? <Btn small title={`Issue ${label}`} color={color} onPress={onIssue} /> : null}
        </View>
      )}
    </Card>
  );
}

function MilestoneCard({ m, idx, forClinician, onUpdate }) {
  const meta = MILESTONE_STATUS_META[m.status] ?? MILESTONE_STATUS_META.pending;
  const isOverdue = m.target_date && m.target_date < new Date().toISOString().slice(0, 10) && !['achieved','failed','skipped'].includes(m.status);
  return (
    <Card color={isOverdue ? c.redSoft : c.paper}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: meta.color, alignItems: 'center', justifyContent: 'center' }}>
          <T size={12} color="#fff" weight="800">{idx + 1}</T>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="700">{m.stage_name}</T>
          {forClinician && m.criteria ? <T size={12} color={c.mute}>{m.criteria}</T> : null}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            <Tag label={meta.label} color={meta.color === c.mute ? c.line : meta.color + '30'} />
            {m.target_date ? <T size={12} color={isOverdue ? c.red : c.mute}>Target: {day(m.target_date)}</T> : null}
            {m.achieved_on ? <T size={12} color={c.lime}>Achieved: {day(m.achieved_on)}</T> : null}
          </View>
          {isOverdue ? <T size={12} color={c.red} weight="700">Overdue</T> : null}
          {m.evidence && forClinician ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Evidence: {m.evidence}</T> : null}
        </View>
        {forClinician && !['achieved','failed','skipped'].includes(m.status) ? (
          <Btn small title="Update" color={c.violet} ink="#fff" onPress={onUpdate} />
        ) : null}
      </View>
    </Card>
  );
}

function SetMilestonesSheet({ episodeId, existing, visible, onClose }) {
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Set RTP milestones"
      color={c.red}
      submitLabel="Save protocol"
      fields={[
        { key: 'hint', label: 'Protocol stages', type: 'section' },
        ...[1,2,3,4,5,6].flatMap((n) => [
          { key: `stage_name_${n}`, label: `Stage ${n}: name`, type: 'text', optional: n > 2,
            default: existing[n-1]?.stage_name ?? ['Symptom-free rest','Light aerobic exercise','Sport-specific exercise','Non-contact drills','Full-contact practice','Return to competition'][n-1] ?? '',
          },
          { key: `criteria_${n}`, label: `Stage ${n}: pass criteria`, type: 'multiline', optional: n > 2,
            show: (v) => !!v[`stage_name_${n}`],
            default: existing[n-1]?.criteria ?? '',
            hint: 'Encrypted. What must be demonstrated to advance? e.g. "Zero pain at rest and with daily activity for 24h"'
          },
          { key: `target_${n}`, label: `Stage ${n}: target date`, type: 'date', optional: true,
            show: (v) => !!v[`stage_name_${n}`],
            default: existing[n-1]?.target_date ?? '',
          },
        ]),
      ]}
      onSubmit={async (v) => {
        const milestones = [1,2,3,4,5,6].filter((n) => v[`stage_name_${n}`]).map((n) => ({
          stage_order: n,
          stage_name: v[`stage_name_${n}`],
          criteria: v[`criteria_${n}`] || '',
          target_date: v[`target_${n}`] || undefined,
        }));
        await api.put(`/injury-episodes/${episodeId}/rtp/milestones`, { milestones });
        return 'Protocol saved';
      }}
    />
  );
}

function UpdateMilestoneSheet({ milestone, episodeId, visible, onClose }) {
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={`Update: ${milestone.stage_name}`}
      color={c.mint}
      submitLabel="Update milestone"
      fields={[
        { key: 'status', label: 'Status', type: 'chips', required: true,
          options: [
            { value: 'in_progress', label: 'In progress' },
            { value: 'achieved',    label: 'Achieved' },
            { value: 'failed',      label: 'Failed' },
            { value: 'skipped',     label: 'Skipped' },
          ],
          default: milestone.status,
        },
        { key: 'achieved_on', label: 'Achievement date', type: 'date', optional: true,
          show: (v) => v.status === 'achieved' },
        { key: 'evidence', label: 'Evidence note', type: 'multiline', optional: true,
          hint: 'Encrypted. What was demonstrated? Link to encounter or test result if relevant.' },
      ]}
      onSubmit={async (v) => {
        await api.patch(`/injury-episodes/${episodeId}/rtp/milestones/${milestone.id}`, {
          status: v.status,
          achieved_on: v.achieved_on || undefined,
          evidence: v.evidence || undefined,
        });
        return 'Milestone updated';
      }}
    />
  );
}

function IssueApprovalSheet({ type, episodeId, visible, onClose }) {
  const meta = RTP_APPROVAL_META[type];
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={`Issue ${meta.label}`}
      color={meta.color}
      submitLabel={`Issue ${meta.label}`}
      fields={[
        { key: 'status', label: 'Decision', type: 'chips', required: true,
          options: [
            { value: 'approved',    label: 'Approved — full clearance' },
            { value: 'conditional', label: 'Conditional — with restrictions' },
            { value: 'deferred',    label: 'Deferred — not yet ready' },
          ],
        },
        { key: 'approved_on', label: 'Assessment date', type: 'date', required: true },
        { key: 'valid_until', label: 'Valid until (optional)', type: 'date', optional: true,
          hint: 'After this date the approval expires and a new one is needed.' },
        { key: 's_restrictions', label: 'Load restrictions', type: 'section' },
        { key: 'restrictions_hint', label: null, type: 'info',
          text: 'These restrictions are shared with coaching staff. Write what the athlete CAN and CANNOT do — no diagnosis, no clinical detail.' },
        ...[1,2,3,4].flatMap((n) => [
          { key: `restr_activity_${n}`, label: `Restriction ${n}: activity`, type: 'text', optional: n > 1 },
          { key: `restr_limit_${n}`, label: `Restriction ${n}: limit`, type: 'text', optional: n > 1,
            show: (v) => !!v[`restr_activity_${n}`] },
        ]),
        { key: 's_clinical', label: 'Clinical notes (private)', type: 'section' },
        { key: 'internal_assessment', label: 'Clinical rationale', type: 'multiline', required: true,
          hint: 'Encrypted. Never shared with coaching staff or athlete. Your clinical reasoning for this decision.' },
        { key: 'evidence_refs', label: 'Evidence references', type: 'multiline', optional: true,
          hint: 'Encrypted. Links to investigations, encounter notes or outcomes used as evidence.' },
        { key: 'conditions', label: 'Conditions (if conditional)', type: 'multiline', optional: true,
          show: (v) => v.status === 'conditional',
          hint: 'Encrypted. What must be met for full clearance.' },
      ]}
      onSubmit={async (v) => {
        const load_restrictions = [1,2,3,4]
          .filter((n) => v[`restr_activity_${n}`])
          .map((n) => ({ activity: v[`restr_activity_${n}`], limit: v[`restr_limit_${n}`] ?? '' }));
        await api.post(`/injury-episodes/${episodeId}/rtp/approvals`, {
          approval_type: type,
          status: v.status,
          approved_on: v.approved_on,
          valid_until: v.valid_until || undefined,
          load_restrictions,
          internal_assessment: v.internal_assessment,
          evidence_refs: v.evidence_refs || undefined,
          conditions: v.conditions || undefined,
        });
        return `${meta.label} issued`;
      }}
    />
  );
}

// ─── timeline tab ─────────────────────────────────────────────────────────────

function EpisodeTimeline({ episodeId, forClinician }) {
  const q = useLoad(() => api.get(`/injury-episodes/${episodeId}/timeline`), [episodeId]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const { events = [], links = [], impact = [] } = q.data ?? {};

  const all = [
    ...events.map((e) => ({ ...e, _kind: 'event', _at: e.at })),
    ...links.map((l) => ({ ...l, _kind: 'link', _at: l.linked_at })),
    ...impact.map((i) => ({ ...i, _kind: 'impact', _at: i.recorded_at })),
  ].sort((a, b) => new Date(b._at) - new Date(a._at));

  if (!all.length) return <Empty emoji="📅" title="No events yet" sub="Status changes, linked artefacts and missed sessions appear here." />;

  return (
    <View style={{ gap: 6 }}>
      {all.map((item, idx) => (
        <TimelineItem key={`${item._kind}:${item.id}:${idx}`} item={item} forClinician={forClinician} />
      ))}
    </View>
  );
}

function TimelineItem({ item, forClinician }) {
  const eventIcons = { opened:'🩺', status_change:'🔄', severity_set:'📊', expected_return_set:'📆',
    artifact_linked:'🔗', impact_recorded:'⚽', note_added:'📝', closed:'🏆' };
  if (item._kind === 'event') {
    return (
      <Card>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <T size={18}>{eventIcons[item.event_type] ?? '•'}</T>
          <View style={{ flex: 1, gap: 1 }}>
            <T weight="700" size={14}>{item.event_type.replace(/_/g, ' ')}</T>
            {item.to_status ? <T size={12} color={c.mute}>→ {STATUS_META[item.to_status]?.label ?? item.to_status}</T> : null}
            {forClinician && item.note ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{item.note}</T> : null}
            <T size={11} color={c.mute}>{when(item.at)} · {item.by_name ?? 'Clinician'}</T>
          </View>
        </View>
      </Card>
    );
  }
  if (item._kind === 'link') {
    return (
      <Card>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <T size={18}>🔗</T>
          <View style={{ flex: 1 }}>
            <T size={13} weight="700">{item.artifact_type?.replace(/_/g, ' ')} linked</T>
            <T size={11} color={c.mute}>{when(item.linked_at)} · {item.linked_by_name ?? 'Clinician'}</T>
          </View>
        </View>
      </Card>
    );
  }
  if (item._kind === 'impact') {
    return (
      <Card color={c.sunSoft}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <T size={18}>⚽</T>
          <View style={{ flex: 1 }}>
            <T size={13} weight="700">Missed {item.impact_type}: {item.reference_label ?? day(item.reference_date)}</T>
            <T size={11} color={c.mute}>{day(item.reference_date)}</T>
          </View>
        </View>
      </Card>
    );
  }
  return null;
}

// ─── artefacts tab ────────────────────────────────────────────────────────────

function EpisodeArtefacts({ episodeId, ep, reload, forClinician }) {
  const q = useLoad(() => api.get(`/injury-episodes/${episodeId}/timeline`), [episodeId]);
  const [linking, setLinking] = useState(false);
  const links = q.data?.links ?? [];

  const byType = {};
  for (const l of links) {
    if (!byType[l.artifact_type]) byType[l.artifact_type] = [];
    byType[l.artifact_type].push(l);
  }

  return (
    <View style={{ gap: 10 }}>
      {forClinician ? (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Btn small title="Link artefact" color={c.violet} onPress={() => setLinking(true)} />
        </View>
      ) : null}
      {Object.keys(byType).length === 0 ? (
        <Empty emoji="🔗" title="No artefacts linked" sub={forClinician ? 'Link encounters, treatment plans, investigations and clearances to this episode.' : 'Your clinical team will link records to this episode.'} />
      ) : (
        Object.entries(byType).map(([type, items]) => (
          <Card key={type}>
            <T weight="700" size={13} style={{ textTransform: 'capitalize' }}>{type.replace(/_/g, ' ')}s ({items.length})</T>
            <View style={{ gap: 4, marginTop: 6 }}>
              {items.map((l) => (
                <T key={l.id} size={12} color={c.mute}>• Linked {when(l.linked_at)}</T>
              ))}
            </View>
          </Card>
        ))
      )}
      <FormSheet
        visible={linking}
        onClose={() => { setLinking(false); q.reload(); }}
        title="Link artefact"
        color={c.violet}
        submitLabel="Link"
        fields={[
          { key: 'artifact_type', label: 'Artefact type', type: 'chips', required: true,
            options: ['encounter','treatment_plan','care_plan','investigation','referral','clearance'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') })) },
          { key: 'artifact_id', label: 'Artefact ID', type: 'text', required: true,
            hint: 'Paste the ID of the encounter, treatment plan, investigation, etc.' },
        ]}
        onSubmit={async (v) => {
          await api.post(`/injury-episodes/${episodeId}/links`, { artifact_type: v.artifact_type, artifact_id: v.artifact_id });
          return 'Artefact linked';
        }}
      />
    </View>
  );
}

// ─── impact tab ──────────────────────────────────────────────────────────────

function EpisodeImpactPanel({ episodeId, ep, reload, forClinician }) {
  const q = useLoad(() => api.get(`/injury-episodes/${episodeId}/timeline`), [episodeId]);
  const [adding, setAdding] = useState(false);
  const impact = q.data?.impact ?? [];

  const totals = impact.reduce((acc, i) => { acc[i.impact_type] = (acc[i.impact_type] ?? 0) + 1; return acc; }, {});

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {Object.entries(totals).map(([type, count]) => (
          <StatPill key={type} value={count} label={`${type}s missed`} color={c.sunSoft} />
        ))}
      </View>

      {forClinician ? (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Btn small title={t('inj.impact_add')} color={c.sun} onPress={() => setAdding(true)} />
        </View>
      ) : null}

      {impact.length === 0 ? (
        <Empty emoji="⚽" title={t('inj.impact_title')} sub="Record sessions and fixtures missed due to this injury." />
      ) : (
        <View style={{ gap: 6 }}>
          {impact.map((i) => (
            <Card key={i.id} color={c.sunSoft}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <T weight="700" size={13}>{i.impact_type.charAt(0).toUpperCase() + i.impact_type.slice(1)}</T>
                  <T size={12} color={c.mute}>{i.reference_label ?? day(i.reference_date)}</T>
                </View>
                <T size={12} color={c.mute}>{day(i.reference_date)}</T>
              </View>
            </Card>
          ))}
        </View>
      )}

      <FormSheet
        visible={adding}
        onClose={() => { setAdding(false); q.reload(); }}
        title={t('inj.impact_add')}
        color={c.sun}
        submitLabel="Record"
        fields={[
          { key: 'impact_type', label: 'Type', type: 'chips', required: true,
            options: [
              { value: 'session', label: 'Training session' },
              { value: 'fixture', label: 'Fixture / match' },
              { value: 'training_day', label: 'Training day' },
            ] },
          { key: 'reference_date', label: 'Date', type: 'date', required: true },
          { key: 'reference_label', label: 'Label (e.g. "Cup final")', type: 'text', optional: true },
        ]}
        onSubmit={async (v) => {
          await api.post(`/injury-episodes/${episodeId}/impact`, {
            impact_type: v.impact_type,
            reference_date: v.reference_date,
            reference_label: v.reference_label || undefined,
          });
          return 'Recorded';
        }}
      />
    </View>
  );
}

// ─── sharing tab (clinician only) ─────────────────────────────────────────────

function EpisodeSharing({ episodeId, ep, reload }) {
  const q = useLoad(() => api.get(`/injury-episodes/${episodeId}`), [episodeId]);
  const [adding, setAdding] = useState(false);
  const shares = q.data?.coach_shares ?? [];
  const { act } = useAct(q.reload);

  return (
    <View style={{ gap: 10 }}>
      <Card color={c.cyanSoft}>
        <T size={13} weight="700">What coaches will see</T>
        <T size={12} color={c.mute} style={{ marginTop: 4 }}>
          Availability status · Expected return date (if opted in) · Load restrictions from the most recent approved RTP decision (if opted in).{'\n'}
          No diagnosis, body region, mechanism, severity, clinical notes or provider name is ever shared.
        </T>
      </Card>

      {shares.length > 0 ? (
        shares.map((s) => (
          <Card key={s.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View>
                <T weight="700">Team: {s.team_name ?? s.team_id}</T>
                <T size={12} color={c.mute}>
                  {s.show_expected_return ? '✓ Expected return ' : '– Expected return '}
                  {s.show_restrictions ? '✓ Restrictions' : '– Restrictions'}
                </T>
              </View>
              <Btn small title="Revoke" color={c.redSoft} ink={c.red}
                onPress={() => act(() => api.delete(`/injury-episodes/${episodeId}/coach-share/${s.team_id}`), 'Share revoked')} />
            </View>
          </Card>
        ))
      ) : (
        <Empty emoji="👥" title="Not shared with any team" sub="Share availability info with a team. Coaches will see only the fields you allow." />
      )}

      <Btn title="Share with a team" color={c.cyan} onPress={() => setAdding(true)} />

      <FormSheet
        visible={adding}
        onClose={() => { setAdding(false); q.reload(); }}
        title="Share with team"
        color={c.cyan}
        submitLabel="Share"
        fields={[
          { key: 'team_id', label: 'Team ID', type: 'text', required: true, hint: 'Paste the team ID to share with' },
          { key: 'show_expected_return', label: 'Share expected return date', type: 'toggle', optional: true, default: true },
          { key: 'show_restrictions', label: 'Share load restrictions (from approved RTP)', type: 'toggle', optional: true,
            hint: 'Only restrictions, never diagnosis or clinical notes.' },
        ]}
        onSubmit={async (v) => {
          await api.post(`/injury-episodes/${episodeId}/coach-share`, {
            team_id: v.team_id,
            show_expected_return: !!v.show_expected_return,
            show_restrictions: !!v.show_restrictions,
          });
          return 'Shared';
        }}
      />
    </View>
  );
}

// ─── clinician alerts panel ───────────────────────────────────────────────────

export function InjuryAlertsPanel() {
  const q = useLoad(() => api.get('/me/injury-alerts'), []);
  const { act } = useAct(q.reload);

  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;

  const { alerts = [] } = q.data ?? {};
  if (!alerts.length) return (
    <Card color={c.limeSoft}>
      <T size={13} weight="700" color={c.lime}>No overdue alerts</T>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>All injury episodes are on track.</T>
    </Card>
  );

  const sevColor = { high: c.red, medium: c.orange, low: c.sun };
  return (
    <View style={{ gap: 6 }}>
      <H2>Injury Alerts ({alerts.length})</H2>
      {alerts.map((a) => (
        <Card key={a.id} color={a.severity === 'high' ? c.redSoft : a.severity === 'medium' ? c.orangeSoft : c.sunSoft}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Tag label={a.severity.toUpperCase()} color={sevColor[a.severity] ?? c.sun} />
                <T size={13} weight="700">{a.athlete_name}</T>
                <T size={12} color={c.mute}>{a.episode_ref}</T>
              </View>
              <T size={13}>{a.detail}</T>
              <T size={12} color={c.mute}>{a.suggested_action}</T>
            </View>
            <Btn small title="Snooze 7d" color={c.line} ink={c.mute}
              onPress={() => act(() => api.post('/me/injury-alerts/dismiss', { alert_id: a.id, snooze_days: 7 }), 'Snoozed')} />
          </View>
        </Card>
      ))}
    </View>
  );
}

// ─── ATHLETE VIEW: exported to health-file.js ────────────────────────────────

export function MyInjuries() {
  const q = useLoad(() => api.get('/me/injury-episodes', { limit: 20 }), []);
  const [selected, setSelected] = useState(null);

  if (selected) {
    return <EpisodeDetailScreen episodeId={selected} onBack={() => setSelected(null)} forClinician={false} />;
  }

  return (
    <View style={{ gap: 10 }}>
      <Card color={c.redSoft}>
        <T weight="800">{t('inj.my_injuries_title')}</T>
        <T size={12} color={c.mute} style={{ marginTop: 2 }}>
          Your injury history and return-to-play progress, managed by your clinical team. Clinical notes are private to your doctors and physios.
        </T>
      </Card>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : (
        (q.data?.length === 0)
          ? <Empty emoji="🩺" title="No injury episodes" sub="When a doctor or physio opens an injury episode for you it appears here." />
          : (q.data ?? []).map((ep) => <AthleteEpisodeCard key={ep.id} ep={ep} onPress={() => setSelected(ep.id)} />)
      )}
    </View>
  );
}

function AthleteEpisodeCard({ ep, onPress }) {
  const phase = ATHLETE_PHASES[ep.status] ?? ATHLETE_PHASES.active;
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <T weight="800">{ep.episode_ref}</T>
            <T size={13} color={c.mute}>{ep.body_region?.replace(/_/g, ' ')} · {ep.occurred_on ? day(ep.occurred_on) : ''}</T>
          </View>
          <Tag label={phase.label} color={phase.color} />
        </View>
        <StatusBar status={ep.status} />
        {ep.expected_return_on && ep.status !== 'closed' ? (
          <T size={12} color={c.mint} style={{ marginTop: 4 }}>Expected return: {day(ep.expected_return_on)}</T>
        ) : null}
        {ep.status === 'closed' && ep.actual_return_on ? (
          <T size={12} color={c.lime} style={{ marginTop: 4 }}>Returned to play: {day(ep.actual_return_on)}</T>
        ) : null}
      </Card>
    </Pressable>
  );
}

// ─── COACH VIEW: exported to team-manage.js ───────────────────────────────────

export function TeamInjuryStatus({ teamId }) {
  const q = useLoad(() => api.get(`/teams/${teamId}/injury-status`), [teamId]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return null; // coach view: fail silently if no data
  const members = q.data ?? [];
  if (!members.length) return null;

  return (
    <View style={{ gap: 8 }}>
      <H2>Injury status</H2>
      <Card color={c.cyanSoft}>
        <T size={12} color={c.mute}>{t('inj.coach_no_detail')}</T>
      </Card>
      {members.map((m) => (
        <CoachMemberCard key={m.user_id} member={m} teamId={teamId} />
      ))}
    </View>
  );
}

function CoachMemberCard({ member, teamId }) {
  const [expanded, setExpanded] = useState(false);
  const detailQ = useLoad(
    () => expanded ? api.get(`/teams/${teamId}/members/${member.user_id}/availability-detail`) : Promise.resolve(null),
    [expanded, teamId, member.user_id],
  );

  return (
    <Card color={c.orangeSoft}>
      <Pressable onPress={() => setExpanded(!expanded)} accessibilityRole="button">
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ gap: 2 }}>
            <T weight="800">{member.display_name}</T>
            <Tag label="Injured" color={c.redSoft} />
            {member.expected_return_on ? <T size={12} color={c.mint}>Expected return: {day(member.expected_return_on)}</T> : null}
          </View>
          <T size={20}>{expanded ? '▲' : '▼'}</T>
        </View>
      </Pressable>

      {expanded && detailQ.data ? (
        <View style={{ marginTop: 10, gap: 8 }}>
          {(detailQ.data.episodes ?? []).map((ep, i) => (
            <View key={ep.id ?? i} style={{ gap: 4 }}>
              {ep.expected_return_on ? <T size={12} color={c.mint}>Expected return: {day(ep.expected_return_on)}</T> : null}
              {ep.load_restrictions?.length ? (
                <View style={{ gap: 2 }}>
                  <T size={12} weight="700">Load restrictions:</T>
                  {ep.load_restrictions.map((x, j) => (
                    <T key={j} size={12} color={c.mute}>• {x.activity}: {x.limit}</T>
                  ))}
                  {ep.rtp_valid_until ? <T size={11} color={c.mute}>Restrictions valid until: {day(ep.rtp_valid_until)}</T> : null}
                </View>
              ) : null}
              {ep.conditions ? <T size={12} color={c.orange}>Conditions: {ep.conditions}</T> : null}
            </View>
          ))}
          <Card color={c.line} style={{ padding: 10 }}>
            <T size={11} color={c.mute}>{t('inj.coach_no_detail')}</T>
          </Card>
        </View>
      ) : null}
    </Card>
  );
}
