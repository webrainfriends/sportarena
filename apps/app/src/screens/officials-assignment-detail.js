// Official Assignment Detail (REF-R01 / #992): full view of one officiating assignment with lifecycle
// state flow, schedule-change acknowledgement, deadline countdown, history timeline, pay status.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Empty, Loading, Screen, Section, T, Tag } from '../ui';
import { explain } from '../access';
import { c } from '../theme';
import { money } from '../federation-ui';
import { t } from '../i18n';

const ROLE_LABEL = {
  referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant referee', scorer: 'Scorer / timekeeper',
  video_assistant_referee: 'VAR', fourth_official: 'Fourth official', reserve_assistant_referee: 'Reserve AR',
  shot_clock_operator: 'Shot clock', timekeeper: 'Timekeeper', goal_line_official: 'Goal-line official',
  technical_official: 'Technical official', chair_umpire: 'Chair umpire', match_commissioner: 'Match commissioner',
  technical_delegate: 'Technical delegate', starter: 'Starter', marshal: 'Marshal',
};

const STATE_COLOR = {
  invited: c.sunSoft, proposed: '#E0F7FA', accepted: c.mintSoft, confirmed: c.mintSoft,
  declined: c.paper, expired: c.paper, withdrawn: c.paper, released: c.paper,
  replaced: c.paper, cancelled: c.paper, completed: '#EDE7F6',
};

const PAY_LABEL = { agreed: 'Fee agreed', due: 'Payment due', paid: 'Paid ✓', disputed: 'Disputed' };
const PAY_COLOR = { agreed: '#E0F7FA', due: c.sunSoft, paid: c.mintSoft, disputed: c.sunSoft };

const fmt = (iso, tz) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '—';
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const deadlineUrgency = (dl) => { const h = (new Date(dl) - Date.now()) / 36e5; return h < 0 ? '#FFCDD2' : h < 4 ? c.sunSoft : h < 24 ? '#FFF9C4' : '#E8F5E9'; };

const HISTORY_ICON = {
  invited: '📨', proposed: '📋', accepted: '✅', confirmed: '🔒',
  declined: '❌', expired: '⏱', withdrawn: '↩️', released: '🔓',
  replaced: '🔄', cancelled: '🚫', completed: '🏁',
};

export function OfficialAssignmentDetail({ route }) {
  const id = route?.params?.id;
  const { toast } = useSession();
  const { go } = useNav();
  const { isTablet } = useLayout();
  const [busy, setBusy] = useState(null);
  const [declineReason, setDeclineReason] = useState('');
  const [showDecline, setShowDecline] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');

  const { data, loading, error, reload } = useLoad(() => api.get(`/official-assignments/${id}`), [id]);
  const a = data;

  const act = async (action, body) => {
    setBusy(action);
    try {
      await api.post(`/official-assignments/${id}/${action}`, body ?? {});
      toast(action === 'acknowledge' ? t('oal.ack_cta') + ' ✓' : action === 'respond' && body?.response === 'accept' ? t('oal.accept') + ' ✓' : t('oal.decline') + ' ✓');
      await reload();
    } catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };

  const withdraw = async () => {
    if (!withdrawReason.trim()) return toast('Please give a reason');
    setBusy('withdraw');
    try { await api.post(`/official-assignments/${id}/withdraw`, { reason: withdrawReason }); toast('Withdrawn'); await reload(); }
    catch (e) { toast(explain(e)); } finally { setBusy(null); setShowWithdraw(false); }
  };

  if (loading) return <Loading />;
  if (error || !a) return <Empty title="Not found" body="This assignment is not available." />;

  const tz = a.venue_timezone;
  const isOpen = ['invited', 'proposed', 'accepted', 'confirmed'].includes(a.status);
  const deadlinePassed = a.invitation_deadline && new Date(a.invitation_deadline) < new Date();

  return (
    <Screen title={t('oal.title')} back>
      <ScrollView contentContainerStyle={{ padding: isTablet ? 24 : 16, gap: 16 }}>

        {/* State banner */}
        <Card color={STATE_COLOR[a.status] ?? c.paper}>
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Tag label={ROLE_LABEL[a.role] ?? a.role} color={c.violetSoft} />
              <Tag label={t(`oal.state.${a.status}`) ?? a.status} color={STATE_COLOR[a.status] ?? c.paper} />
              {a.needs_ack ? <Tag label="🔔 Schedule changed" color={c.sunSoft} /> : null}
            </View>
            <T weight="800" size={20}>{a.home_name ?? 'TBD'} v {a.away_name ?? 'TBD'}</T>
            <T size={13} color={c.mute}>{a.sport_emoji} {a.event_name}{a.round ? ` · ${a.round}` : ''}</T>
            <T size={14} weight="700">{fmt(a.scheduled_at, tz)} · {a.duration_min} min</T>
          </View>
        </Card>

        {/* Schedule-change acknowledgement */}
        {a.needs_ack ? (
          <Card color={c.sunSoft}>
            <View style={{ gap: 8 }}>
              <T weight="700" size={15}>{t('oal.ack_title')}</T>
              <T size={13}>{a.ack_required_reason ?? t('oal.ack_body')}</T>
              <Btn label={t('oal.ack_cta')} loading={busy === 'acknowledge'} onPress={() => act('acknowledge')} />
            </View>
          </Card>
        ) : null}

        {/* Invitation deadline */}
        {a.invitation_deadline && ['invited', 'proposed'].includes(a.status) ? (
          <Card color={deadlineUrgency(a.invitation_deadline)}>
            <T size={13} weight="600">⏰ {t('oal.deadline_label')}: {fmt(a.invitation_deadline, tz)}{deadlinePassed ? ' — EXPIRED' : ''}</T>
          </Card>
        ) : null}

        {/* Accept / Decline — invited only */}
        {a.status === 'invited' ? (
          <View style={{ gap: 8 }}>
            <Btn label={t('oal.accept')} loading={busy === 'respond-accept'} onPress={() => act('respond', { response: 'accept' })} />
            {showDecline ? (
              <View style={{ gap: 8 }}>
                <T size={13} weight="600">Reason (optional)</T>
                <Card color={c.paper}>
                  {['Not available then', 'Too far to travel', 'Clash with another match', 'Not my level or sport'].map((r) => (
                    <Btn key={r} label={r} variant={declineReason === r ? 'primary' : 'ghost'} onPress={() => setDeclineReason(r)} style={{ marginBottom: 4 }} />
                  ))}
                </Card>
                <Btn label={t('oal.decline') + ' — confirm'} loading={busy === 'respond-decline'} onPress={() => act('respond', { response: 'decline', reason: declineReason || undefined })} />
                <Btn label="Cancel" variant="ghost" onPress={() => setShowDecline(false)} />
              </View>
            ) : (
              <Btn label={t('oal.decline')} variant="ghost" onPress={() => setShowDecline(true)} />
            )}
          </View>
        ) : null}

        {/* Withdraw — accepted/confirmed */}
        {['accepted', 'confirmed'].includes(a.status) ? (
          showWithdraw ? (
            <View style={{ gap: 8 }}>
              <T size={13} weight="600">Reason for withdrawing</T>
              <Card color={c.paper}>
                <T size={13} style={{ marginBottom: 6 }}>Please explain so the organiser can arrange a replacement.</T>
                {['Injury', 'Personal emergency', 'Travel issue', 'Conflict of interest', 'Other'].map((r) => (
                  <Btn key={r} label={r} variant={withdrawReason === r ? 'primary' : 'ghost'} onPress={() => setWithdrawReason(r)} style={{ marginBottom: 4 }} />
                ))}
              </Card>
              <Btn label={t('oal.withdraw') + ' — confirm'} loading={busy === 'withdraw'} onPress={withdraw} />
              <Btn label="Cancel" variant="ghost" onPress={() => setShowWithdraw(false)} />
            </View>
          ) : (
            <Btn label={t('oal.withdraw')} variant="ghost" onPress={() => setShowWithdraw(true)} />
          )
        ) : null}

        {/* Match details */}
        <Section title="Match details">
          <Card color={c.paper}>
            <View style={{ gap: 6 }}>
              <Row label={t('oal.fixture')} value={`${a.home_name ?? 'TBD'} v ${a.away_name ?? 'TBD'}`} />
              <Row label={t('oal.event')} value={a.event_name} />
              <Row label={t('oal.role')} value={ROLE_LABEL[a.role] ?? a.role} />
              <Row label="Start" value={fmt(a.scheduled_at, tz)} />
              <Row label={t('oal.duration')} value={`${a.duration_min} min`} />
              {a.reporting_min > 0 ? <Row label={t('oal.reporting_time')} value={fmt(new Date(new Date(a.scheduled_at).getTime() - a.reporting_min * 60000), tz)} /> : null}
              {a.venue_name ? <Row label={t('oal.venue')} value={[a.resource_name, a.venue_name, a.venue_city].filter(Boolean).join(' · ')} /> : null}
            </View>
          </Card>
        </Section>

        {/* Fee & pay */}
        {a.fee_minor != null ? (
          <Section title="Payment">
            <Card color={c.paper}>
              <View style={{ gap: 6 }}>
                <Row label={t('oal.fee')} value={money(a.fee_minor, a.fee_currency)} />
                {a.pay_status ? <Row label={t('oal.pay_status')} value={PAY_LABEL[a.pay_status] ?? a.pay_status} valueColor={PAY_COLOR[a.pay_status]} /> : null}
                {a.pay_confirmed_at ? <Row label="Receipt confirmed" value={fmtDate(a.pay_confirmed_at)} /> : null}
              </View>
            </Card>
          </Section>
        ) : null}

        {/* History */}
        <Section title={t('oal.history')}>
          {a.history?.length ? (
            a.history.map((h, i) => (
              <Card key={i} color={c.paper} style={{ marginBottom: 6 }}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                  <T size={18}>{HISTORY_ICON[h.to] ?? '·'}</T>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T weight="700" size={13}>{t(`oal.state.${h.to}`) ?? h.to}</T>
                    {h.reason ? <T size={12} color={c.mute}>{h.reason}</T> : null}
                    <T size={11} color={c.mute}>{fmtDate(h.at)}</T>
                  </View>
                </View>
              </Card>
            ))
          ) : <T size={13} color={c.mute}>{t('oal.history_empty')}</T>}
        </Section>

      </ScrollView>
    </Screen>
  );
}

function Row({ label, value, valueColor }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
      <T size={12} color={c.mute} style={{ flex: 1 }}>{label}</T>
      <T size={13} weight="600" color={valueColor ?? c.ink} style={{ flex: 2, textAlign: 'right' }}>{value ?? '—'}</T>
    </View>
  );
}
