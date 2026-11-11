// REF-R14: Open match self-assignment board — official-facing.
// Browse open match slots, check live eligibility, claim instantly or apply with a note.
// My Applications tab: track status, waitlist position, cancel/withdraw.
import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag, Row } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../menu-field';
import { CalendarPickerField } from '../pickers';
import { LoadError } from '../access';
import { c, grad, r } from '../theme';
import { Metric, money } from '../federation-ui';
import { t } from '../i18n';

// ─── constants ────────────────────────────────────────────────────────────────

const ROLE_LABEL = {
  referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant Referee', scorer: 'Scorer',
  video_assistant_referee: 'VAR', fourth_official: 'Fourth Official', reserve_assistant_referee: 'Reserve AR',
  shot_clock_operator: 'Shot Clock', timekeeper: 'Timekeeper', goal_line_official: 'Goal-line Official',
  technical_official: 'Technical Official', chair_umpire: 'Chair Umpire', match_commissioner: 'Match Commissioner',
  technical_delegate: 'Technical Delegate', starter: 'Starter', marshal: 'Marshal',
};

const APP_STATUS = {
  approved:   ['✅ Confirmed', c.mintSoft],
  pending:    ['⏳ Awaiting decision', c.sunSoft],
  waitlisted: ['🕐 Waitlisted', c.cyanSoft],
  rejected:   ['Not approved', c.paper],
  withdrawn:  ['Withdrawn', c.paper],
  cancelled:  ['Cancelled', c.paper],
};

const CLAIM_MODE = {
  instant:  ['⚡ Instant claim', c.mintSoft],
  approval: ['⏳ Needs approval', c.sunSoft],
};

const ELIG = {
  eligible:  ['✅ Eligible', c.mintSoft],
  ineligible: ['⛔ Not eligible', c.sunSoft],
  partial:   ['⚠️ Check requirements', c.sunSoft],
};

const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const dateShort = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '';

// ─── eligibility checklist ────────────────────────────────────────────────────

function EligList({ factors = [] }) {
  if (!factors.length) return null;
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {factors.map((f) => (
        <View key={f.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T size={14} style={{ width: 24 }}>{f.state === 'eligible' ? '✅' : f.state === 'blocked' ? '🚫' : '⛔'}</T>
          <View style={{ flex: 1 }}>
            <T size={13} weight="600">{f.label}</T>
            {f.detail ? <T size={12} color={c.mute}>{f.detail}</T> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

// ─── slot card ────────────────────────────────────────────────────────────────

function SlotCard({ slot, onPress }) {
  const elig = slot.my_eligibility;
  const eligible = elig?.eligible;
  const myApp = slot.my_application;
  const mode = CLAIM_MODE[slot.approval_mode];
  const openPlaces = Math.max((slot.slots ?? 1) - (slot.filled ?? 0), 0);
  const hasWaitlist = !openPlaces && slot.allow_waitlist;
  return (
    <Card onPress={onPress} accessibilityLabel={`${slot.role_label} at ${slot.event_name ?? ''}`} style={{ marginBottom: 10 }}>
      <View style={{ gap: 8 }}>
        {/* header tags */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={slot.sport_emoji ?? ''} color={c.violetSoft} />
          <Tag label={slot.role_label} color={c.violetSoft} />
          {mode ? <Tag label={mode[0]} color={mode[1]} /> : null}
          {myApp ? <Tag label={APP_STATUS[myApp.status]?.[0] ?? myApp.status} color={APP_STATUS[myApp.status]?.[1] ?? c.paper} /> : eligible === true ? <Tag label="✅ Eligible" color={c.mintSoft} /> : eligible === false ? <Tag label="⛔ Check eligibility" color={c.sunSoft} /> : null}
          {hasWaitlist ? <Tag label="🕐 Waitlist" color={c.cyanSoft} /> : null}
          {slot.fee_minor != null ? <Tag label={`💰 ${money(slot.fee_minor, slot.fee_currency)}`} color={c.mintSoft} /> : null}
        </View>
        {/* match */}
        <T weight="800" size={17} style={{ letterSpacing: -0.3 }}>{slot.home_name ?? 'TBD'} v {slot.away_name ?? 'TBD'}</T>
        <T size={13} color={c.mute}>{slot.event_name}</T>
        <T size={14} weight="700">{when(slot.fixture_scheduled_at)}</T>
        {slot.venue_name ? <T size={12} color={c.mute}>📍 {slot.venue_name}{slot.venue_city ? `, ${slot.venue_city}` : ''}</T> : null}
        {/* places */}
        {!myApp ? (
          <T size={12} color={c.mute}>{openPlaces > 0 ? `${openPlaces} place${openPlaces !== 1 ? 's' : ''} available` : 'Full — waitlist open'}</T>
        ) : null}
        {slot.min_grade ? <T size={12} color={c.mute}>{t('open_slot.min_grade')}: {slot.min_grade}</T> : null}
      </View>
    </Card>
  );
}

// ─── claim / apply sheet ──────────────────────────────────────────────────────

function ClaimSheet({ slot, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(true);

  React.useEffect(() => {
    api('GET', `/open-match-slots/${slot.id}`).then((d) => { setDetail(d); setDetailLoading(false); }).catch(() => setDetailLoading(false));
  }, [slot.id]);

  const elig = detail?.my_eligibility ?? slot.my_eligibility;
  const myApp = detail?.my_application ?? slot.my_application;
  const openPlaces = detail ? Math.max((detail.slots ?? 1) - (detail.filled ?? 0), 0) : Math.max((slot.slots ?? 1) - (slot.filled ?? 0), 0);
  const willWaitlist = openPlaces === 0 && (detail?.allow_waitlist ?? slot.allow_waitlist);
  const isInstant = (detail?.approval_mode ?? slot.approval_mode) === 'instant';
  const eligible = elig?.eligible;
  const ctaLabel = willWaitlist ? t('open_slot.join_waitlist') : isInstant ? t('open_slot.claim_cta') : t('open_slot.apply_cta');
  const ctaColor = willWaitlist ? c.cyan : isInstant ? c.pink : c.violet;

  async function submit() {
    setLoading(true); setErr(null);
    try {
      await api('POST', `/open-match-slots/${slot.id}/claim`, { note: note.trim() || undefined });
      onDone();
    } catch (e) { setErr(e.message); setLoading(false); }
  }

  return (
    <Sheet onClose={onClose} title={`${slot.role_label} · ${slot.event_name ?? ''}`}>
      {detailLoading ? <Loading /> : (
        <ScrollView style={{ padding: 16 }}>
          {/* match hero */}
          <GradCard colors={grad.hero} style={{ marginBottom: 16, padding: 16, borderRadius: r.card }}>
            <T weight="800" size={22} style={{ color: '#fff', letterSpacing: -0.4, marginBottom: 4 }}>{slot.home_name ?? 'TBD'} v {slot.away_name ?? 'TBD'}</T>
            <T size={14} style={{ color: 'rgba(255,255,255,.85)' }}>{slot.sport_emoji} {slot.event_name}</T>
            <T size={14} weight="700" style={{ color: '#fff', marginTop: 6 }}>{when(slot.fixture_scheduled_at)}</T>
            {slot.venue_name ? <T size={12} style={{ color: 'rgba(255,255,255,.75)', marginTop: 2 }}>📍 {slot.venue_name}{slot.venue_city ? `, ${slot.venue_city}` : ''}</T> : null}
          </GradCard>

          {/* eligibility */}
          <Section title={t('open_slot.eligibility_title')}>
            <Card color={eligible === false ? c.sunSoft : eligible ? c.mintSoft : c.paper} style={{ padding: 12, marginTop: 4 }}>
              <T weight="700" size={14}>{eligible === false ? '⛔ ' + t('open_slot.eligibility_fail') : eligible ? '✅ ' + t('open_slot.eligibility_pass') : t('open_slot.eligibility_checking')}</T>
              <EligList factors={elig?.factors ?? []} />
            </Card>
          </Section>

          {/* fee & terms */}
          {slot.fee_minor != null ? (
            <Section title={t('open_slot.fee_title')}>
              <Card color={c.cyanSoft} style={{ padding: 12, marginTop: 4, gap: 6 }}>
                <Row label={t('open_slot.fee_label')} value={money(slot.fee_minor, slot.fee_currency)} />
                <Row label={t('open_slot.pay_direction')} value={slot.pay_direction === 'organiser_pays' ? t('open_slot.organiser_pays') : t('open_slot.official_invoices')} />
                {slot.reporting_min > 0 ? <Row label={t('open_slot.report_by')} value={`${slot.reporting_min} min before KO`} /> : null}
                <T size={11} color={c.mute} style={{ marginTop: 4 }}>⚠️ {t('open_slot.fee_locked_note')}</T>
              </Card>
            </Section>
          ) : null}

          {/* conflict advisories */}
          {detail?.conflict_advisories?.length ? (
            <Section title={t('open_slot.conflicts_title')}>
              {detail.conflict_advisories.map((ca, i) => (
                <Card key={i} color={c.sunSoft} style={{ padding: 10, marginTop: 4 }}>
                  <T weight="700" size={13}>⚠️ {ca.label}</T>
                  {ca.detail ? <T size={12} color={c.mute}>{ca.detail}</T> : null}
                </Card>
              ))}
            </Section>
          ) : null}

          {/* organiser notes */}
          {slot.notes ? (
            <Section title={t('open_slot.organiser_notes')}>
              <Card color={c.paper} style={{ padding: 12, marginTop: 4 }}><T size={13}>{slot.notes}</T></Card>
            </Section>
          ) : null}

          {/* application note */}
          {!isInstant && !myApp ? (
            <Section title={t('open_slot.note_label')}>
              <Field label={t('open_slot.note_placeholder')} value={note} onChangeText={setNote} multiline numberOfLines={3} style={{ marginTop: 4 }} />
            </Section>
          ) : null}

          {/* waitlist info */}
          {willWaitlist ? (
            <Card color={c.cyanSoft} style={{ padding: 12, marginBottom: 8 }}>
              <T weight="700" size={13}>🕐 {t('open_slot.waitlist_info')}</T>
              <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('open_slot.waitlist_detail')}</T>
            </Card>
          ) : null}

          {err ? <T size={13} color={c.error} style={{ marginBottom: 8 }}>{err}</T> : null}

          {myApp ? (
            <Card color={APP_STATUS[myApp.status]?.[1] ?? c.paper} style={{ padding: 12, marginBottom: 8 }}>
              <T weight="700" size={14}>{APP_STATUS[myApp.status]?.[0] ?? myApp.status}</T>
              {myApp.waitlist_position ? <T size={12} color={c.mute}>{t('open_slot.waitlist_pos', { n: myApp.waitlist_position })}</T> : null}
            </Card>
          ) : (
            <Btn
              label={ctaLabel} color={ctaColor} style={{ marginBottom: 8 }}
              disabled={eligible === false && !willWaitlist} loading={loading}
              onPress={submit}
              accessibilityLabel={ctaLabel}
            />
          )}
          <Btn label={t('common.close')} color={c.paper} onPress={onClose} accessibilityLabel={t('common.close')} />
        </ScrollView>
      )}
    </Sheet>
  );
}

// ─── withdraw / cancel sheet ──────────────────────────────────────────────────

function WithdrawSheet({ app, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const isConfirmed = app.status === 'approved';

  async function submit() {
    setLoading(true); setErr(null);
    try {
      if (isConfirmed) {
        await api('POST', `/open-slot-applications/${app.id}/cancel`, { reason: reason.trim() || 'Withdrawn by official' });
      } else {
        await api('POST', `/open-slot-applications/${app.id}/withdraw`, { reason: reason.trim() || undefined });
      }
      onDone();
    } catch (e) { setErr(e.message); setLoading(false); }
  }

  return (
    <Sheet onClose={onClose} title={isConfirmed ? t('open_slot.cancel_title') : t('open_slot.withdraw_title')}>
      <View style={{ padding: 16, gap: 12 }}>
        {isConfirmed ? (
          <Field label={t('open_slot.cancel_reason')} value={reason} onChangeText={setReason} multiline numberOfLines={3} required />
        ) : (
          <Field label={t('open_slot.withdraw_reason')} value={reason} onChangeText={setReason} multiline numberOfLines={2} />
        )}
        {err ? <T size={13} color={c.error}>{err}</T> : null}
        <Btn label={isConfirmed ? t('open_slot.cancel_cta') : t('open_slot.withdraw_cta')} color={c.pink} loading={loading}
          disabled={isConfirmed && !reason.trim()} onPress={submit} accessibilityLabel={isConfirmed ? t('open_slot.cancel_cta') : t('open_slot.withdraw_cta')} />
        <Btn label={t('common.back')} color={c.paper} onPress={onClose} accessibilityLabel={t('common.back')} />
      </View>
    </Sheet>
  );
}

// ─── My Applications tab ──────────────────────────────────────────────────────

function MyApplicationsTab({ onRefresh, refreshTick }) {
  const [statusFilter, setStatusFilter] = useState(null);
  const [withdrawApp, setWithdrawApp] = useState(null);
  const { data, loading, error, reload } = useLoad(
    () => api('GET', '/me/open-slot-applications', { upcoming: true, status: statusFilter ?? undefined }),
    [statusFilter, refreshTick],
  );

  const STATUS_OPTS = [
    { value: null, label: t('open_slot.filter_all') },
    { value: 'approved', label: t('open_slot.status_approved') },
    { value: 'pending', label: t('open_slot.status_pending') },
    { value: 'waitlisted', label: t('open_slot.status_waitlisted') },
  ];

  if (loading) return <Loading />;
  if (error) return <LoadError onRetry={reload} />;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Seg
        options={STATUS_OPTS} value={statusFilter}
        onChange={setStatusFilter}
        style={{ marginBottom: 16 }}
        accessibilityLabel={t('open_slot.filter_status')}
      />
      {!data?.length ? (
        <Empty title={t('open_slot.my_apps_empty')} subtitle={t('open_slot.my_apps_empty_sub')} />
      ) : (
        data.map((app) => {
          const [statusLabel, statusColor] = APP_STATUS[app.status] ?? [app.status, c.paper];
          return (
            <Card key={app.id} style={{ marginBottom: 10 }} accessibilityLabel={`${ROLE_LABEL[app.role] ?? app.role} at ${app.event_name}`}>
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Tag label={ROLE_LABEL[app.role] ?? app.role} color={c.violetSoft} />
                  <Tag label={statusLabel} color={statusColor} />
                  {app.fee_snapshot?.minor != null ? <Tag label={`💰 ${money(app.fee_snapshot.minor, app.fee_snapshot.currency)}`} color={c.mintSoft} /> : null}
                </View>
                <T weight="800" size={16}>{app.home_name ?? 'TBD'} v {app.away_name ?? 'TBD'}</T>
                <T size={13} color={c.mute}>{app.event_name}</T>
                <T size={14} weight="700">{when(app.scheduled_at)}</T>
                {app.venue_name ? <T size={12} color={c.mute}>📍 {app.venue_name}{app.venue_city ? `, ${app.venue_city}` : ''}</T> : null}
                {app.status === 'waitlisted' && app.waitlist_position ? (
                  <T size={13} color={c.cyan} weight="600">{t('open_slot.waitlist_pos', { n: app.waitlist_position })}</T>
                ) : null}
                {app.fee_snapshot?.minor != null ? (
                  <T size={12} color={c.mute}>⚠️ {t('open_slot.fee_locked')}</T>
                ) : null}
                {['pending', 'waitlisted', 'approved'].includes(app.status) ? (
                  <Btn label={app.status === 'approved' ? t('open_slot.cancel_cta') : t('open_slot.withdraw_cta')}
                    color={c.paper} size="sm" onPress={() => setWithdrawApp(app)}
                    accessibilityLabel={app.status === 'approved' ? t('open_slot.cancel_cta') : t('open_slot.withdraw_cta')} />
                ) : null}
              </View>
            </Card>
          );
        })
      )}
      {withdrawApp ? (
        <WithdrawSheet app={withdrawApp} onClose={() => setWithdrawApp(null)} onDone={() => { setWithdrawApp(null); reload(); onRefresh?.(); }} />
      ) : null}
    </ScrollView>
  );
}

// ─── Browse tab ───────────────────────────────────────────────────────────────

function BrowseTab({ onApplied }) {
  const [filters, setFilters] = useState({ sport: null, role: null, date_from: null, date_to: null, approval_mode: null, eligible_only: false, q: '' });
  const [claimSlot, setClaimSlot] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const setFilter = (k, v) => setFilters((prev) => ({ ...prev, [k]: v }));
  const { wide } = useLayout();

  const { data: summary } = useLoad(() => api('GET', '/me/open-slot-applications', { upcoming: true }), [refreshTick]);
  const confirmedCount = summary?.filter((a) => a.status === 'approved').length ?? 0;
  const pendingCount = summary?.filter((a) => ['pending', 'waitlisted'].includes(a.status)).length ?? 0;

  const { data, loading, error, reload } = useLoad(
    () => api('GET', '/open-match-slots', {
      sport: filters.sport ?? undefined, role: filters.role ?? undefined,
      date_from: filters.date_from ?? undefined, date_to: filters.date_to ?? undefined,
      approval_mode: filters.approval_mode ?? undefined,
      eligible_only: filters.eligible_only || undefined,
      q: filters.q?.trim() || undefined,
      limit: 50,
    }),
    [filters, refreshTick],
  );

  const ROLE_OPTS = Object.entries(ROLE_LABEL).map(([v, l]) => ({ value: v, label: l }));
  const MODE_OPTS = [{ value: null, label: t('open_slot.filter_all') }, { value: 'instant', label: t('open_slot.filter_instant') }, { value: 'approval', label: t('open_slot.filter_approval') }];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      {/* hero metrics */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <Metric label={t('open_slot.metric_open')} value={data?.length ?? '—'} sub={t('open_slot.metric_open_sub')} color={c.pinkSoft} />
        <Metric label={t('open_slot.metric_confirmed')} value={confirmedCount} sub={t('open_slot.metric_confirmed_sub')} color={c.mintSoft} />
        <Metric label={t('open_slot.metric_pending')} value={pendingCount} sub={t('open_slot.metric_pending_sub')} color={c.sunSoft} />
      </View>

      {/* search bar */}
      <Field label={t('open_slot.search_placeholder')} value={filters.q} onChangeText={(v) => setFilter('q', v)} icon="🔍" style={{ marginBottom: 10 }} accessibilityLabel={t('open_slot.search_placeholder')} />

      {/* filter row */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', gap: 8, paddingRight: 16 }}>
          <MenuField label={t('open_slot.filter_role')} value={filters.role} onChange={(v) => setFilter('role', v)} options={ROLE_OPTS} placeholder={t('open_slot.filter_all')} />
          <MenuField label={t('open_slot.filter_mode')} value={filters.approval_mode} onChange={(v) => setFilter('approval_mode', v)} options={MODE_OPTS} />
          <CalendarPickerField label={t('open_slot.filter_from')} value={filters.date_from} onChange={(v) => setFilter('date_from', v)} />
          <CalendarPickerField label={t('open_slot.filter_to')} value={filters.date_to} onChange={(v) => setFilter('date_to', v)} />
          <Chip label={t('open_slot.filter_eligible')} active={filters.eligible_only} onPress={() => setFilter('eligible_only', !filters.eligible_only)} accessibilityLabel={t('open_slot.filter_eligible')} />
        </View>
      </ScrollView>

      {/* results */}
      {loading ? <Loading /> : error ? <LoadError onRetry={reload} /> : !data?.length ? (
        <Empty title={t('open_slot.empty')} subtitle={t('open_slot.empty_sub')} />
      ) : (
        data.map((slot) => (
          <SlotCard key={slot.id} slot={slot} onPress={() => setClaimSlot(slot)} />
        ))
      )}

      {claimSlot ? (
        <ClaimSheet
          slot={claimSlot}
          onClose={() => setClaimSlot(null)}
          onDone={() => { setClaimSlot(null); setRefreshTick((x) => x + 1); onApplied?.(); reload(); }}
        />
      ) : null}
    </ScrollView>
  );
}

// ─── main screen ──────────────────────────────────────────────────────────────

export function OpenMatchSlots() {
  const [tab, setTab] = useState('browse');
  const [myRefreshTick, setMyRefreshTick] = useState(0);
  const TAB_OPTS = [{ value: 'browse', label: t('open_slot.tab_browse') }, { value: 'mine', label: t('open_slot.tab_mine') }];

  return (
    <Screen title={t('open_slot.title')} back accessibilityLabel={t('open_slot.title')}>
      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 2 }}>
        <Seg options={TAB_OPTS} value={tab} onChange={setTab} accessibilityLabel={t('open_slot.tabs_label')} />
      </View>
      {tab === 'browse' ? (
        <BrowseTab onApplied={() => setMyRefreshTick((x) => x + 1)} />
      ) : (
        <MyApplicationsTab refreshTick={myRefreshTick} onRefresh={() => {}} />
      )}
    </Screen>
  );
}
