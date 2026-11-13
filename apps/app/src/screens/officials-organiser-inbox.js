// Organiser Officials Inbox (REF-R01 / #992): manages proposals, replacements, expiring invitations
// and activity for all officials on this organiser's fixtures. API-first, MCP-enabled.
import React, { useState } from 'react';
import { View, ScrollView, Platform } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Empty, Loading, Screen, Seg, Section, T, Tag } from '../ui';
import { explain } from '../access';
import { c } from '../theme';
import { money, Metric } from '../federation-ui';
import { t } from '../i18n';

const ROLE_LABEL = {
  referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant referee', scorer: 'Scorer',
  video_assistant_referee: 'VAR', fourth_official: 'Fourth official', reserve_assistant_referee: 'Reserve AR',
  shot_clock_operator: 'Shot clock', timekeeper: 'Timekeeper', goal_line_official: 'Goal-line official',
  technical_official: 'Technical official', chair_umpire: 'Chair umpire', match_commissioner: 'Match commissioner',
  technical_delegate: 'Technical delegate', starter: 'Starter', marshal: 'Marshal',
};
const fmt = (iso, tz) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '—';
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const deadlineUrgency = (dl) => { if (!dl) return c.paper; const h = (new Date(dl) - Date.now()) / 36e5; return h < 4 ? '#FFCDD2' : h < 24 ? '#FFF9C4' : c.paper; };

const TABS = ['proposals', 'replace', 'expiring', 'activity'];
const TAB_KEYS = { proposals: 'oorg.tab_proposals', replace: 'oorg.tab_replace', expiring: 'oorg.tab_expiring', activity: 'oorg.tab_activity' };

export function OrganiserOfficialsInbox() {
  const { toast } = useSession();
  const { go } = useNav();
  const { isTablet } = useLayout();
  const [tab, setTab] = useState('proposals');
  const [busy, setBusy] = useState(null);
  const [replaceSheet, setReplaceSheet] = useState(null);
  const [replaceReason, setReplaceReason] = useState('');
  const [deadlineSheet, setDeadlineSheet] = useState(null);
  const [deadlineVal, setDeadlineVal] = useState('');

  const { data, loading, error, reload } = useLoad(() => api.get('/me/organiser/officials/inbox'), []);
  const d = data;

  const act = async (action, id, body, successMsg) => {
    setBusy(`${action}-${id}`);
    try { await api.post(`/official-assignments/${id}/${action}`, body ?? {}); toast(successMsg ?? 'Done'); await reload(); }
    catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };

  const confirmCrew = async (fixtureId) => {
    setBusy(`crew-${fixtureId}`);
    try { await api.post(`/fixtures/${fixtureId}/officials/confirm-crew`); toast('Crew confirmed ✓'); await reload(); }
    catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };

  const doReplace = async () => {
    if (!replaceReason.trim()) return toast('Please give a reason');
    setBusy(`replace-${replaceSheet.id}`);
    try { await api.post(`/official-assignments/${replaceSheet.id}/replace`, { reason: replaceReason }); toast('Official replaced'); await reload(); setReplaceSheet(null); setReplaceReason(''); }
    catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };

  const setDeadline = async () => {
    if (!deadlineVal) return toast('Please pick a deadline');
    setBusy(`dl-${deadlineSheet.id}`);
    try { await api.post(`/official-assignments/${deadlineSheet.id}/deadline`, { deadline: deadlineVal }); toast('Deadline set'); await reload(); setDeadlineSheet(null); setDeadlineVal(''); }
    catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };

  if (loading) return <Loading />;
  if (error) return <Empty title="Error" body={explain(error)} />;

  const { proposals = [], needs_replacement = [], expiring = [], activity = [], metrics = {}, crew_ready = [] } = d ?? {};

  return (
    <Screen title={t('oorg.title')}>
      <ScrollView contentContainerStyle={{ padding: isTablet ? 24 : 16, gap: 16 }}>

        {/* Metrics strip */}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Metric label="Proposals" value={metrics.proposals ?? 0} />
          <Metric label="Needs Replace" value={metrics.needs_replacement ?? 0} />
          <Metric label="Expiring" value={metrics.expiring ?? 0} />
          <Metric label="Slots Filled" value={`${metrics.filled ?? 0}/${metrics.required ?? 0}`} />
        </View>

        {/* Confirm crew CTA — shown when all required slots for a fixture are accepted/confirmed */}
        {crew_ready.map((item) => (
          <Card key={item.fixture_id} color={c.mintSoft}>
            <View style={{ gap: 6 }}>
              <T weight="700" size={14}>{t('oorg.confirm_crew')}</T>
              <T size={12} color={c.mute}>{item.event_name} · {item.home_name ?? 'TBD'} v {item.away_name ?? 'TBD'}</T>
              <T size={12}>{t('oorg.confirm_crew_body')}</T>
              <Btn label={t('oorg.confirm_crew')} loading={busy === `crew-${item.fixture_id}`} onPress={() => confirmCrew(item.fixture_id)} />
            </View>
          </Card>
        ))}

        {/* Tabs */}
        <Seg value={tab} onChange={setTab} options={TABS.map((k) => ({ value: k, label: t(TAB_KEYS[k]) }))} />

        {/* Proposals */}
        {tab === 'proposals' ? (
          proposals.length ? proposals.map((p) => (
            <Card key={p.id} color={c.paper}>
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Tag label={ROLE_LABEL[p.role] ?? p.role} color={c.violetSoft} />
                  <Tag label="📋 Proposal" color='#E0F7FA' />
                </View>
                <T weight="700" size={15}>{p.official_display_name ?? 'Official'}</T>
                <T size={13} color={c.mute}>{p.event_name} · {p.home_name ?? 'TBD'} v {p.away_name ?? 'TBD'}</T>
                <T size={13}>{fmt(p.scheduled_at, p.venue_timezone)}</T>
                {/* Stats row */}
                <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
                  {p.ai_score != null ? <StatChip icon="🤖" label={`${t('oorg.ai_score')}: ${p.ai_score}`} /> : null}
                  {p.rating != null ? <StatChip icon="⭐" label={`${p.rating.toFixed(1)}`} /> : null}
                  {p.is_available ? <StatChip icon="✅" label={t('oorg.availability')} color={c.mintSoft} /> : null}
                  {p.conflicts > 0 ? <StatChip icon="⚠️" label={t('oorg.conflicts_found', { n: p.conflicts })} color={c.sunSoft} /> : <StatChip icon="✓" label={t('oorg.conflicts')} color={c.mintSoft} />}
                </View>
                {p.proposal_note ? <T size={12} color={c.mute} style={{ fontStyle: 'italic' }}>"{p.proposal_note}"</T> : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                  <Btn label={t('oorg.accept_proposal')} loading={busy === `confirm-proposal-${p.id}`} onPress={() => act('confirm-proposal', p.id, {}, 'Proposal accepted')} style={{ flex: 1 }} />
                  <Btn label={t('oorg.decline_proposal')} variant="ghost" loading={busy === `decline-proposal-${p.id}`} onPress={() => act('decline-proposal', p.id, { reason: 'Declined by organiser' }, 'Proposal declined')} style={{ flex: 1 }} />
                </View>
                <Btn label={`${t('oorg.deadline_label')} ↗`} variant="ghost" size="sm" onPress={() => { setDeadlineSheet(p); setDeadlineVal(''); }} />
              </View>
            </Card>
          )) : <Empty title={t('oorg.proposals_empty')} />
        ) : null}

        {/* Needs Replace */}
        {tab === 'replace' ? (
          needs_replacement.length ? needs_replacement.map((p) => (
            <Card key={p.id} color={c.paper}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Tag label={ROLE_LABEL[p.role] ?? p.role} color={c.violetSoft} />
                  <Tag label="🔴 Needs replacement" color='#FFCDD2' />
                </View>
                <T weight="700" size={14}>{p.event_name}</T>
                <T size={13} color={c.mute}>{p.home_name ?? 'TBD'} v {p.away_name ?? 'TBD'} · {fmt(p.scheduled_at, p.venue_timezone)}</T>
                {p.reason ? <T size={12} color={c.mute}>{p.reason}</T> : null}
                {replaceSheet?.id === p.id ? (
                  <View style={{ gap: 8, marginTop: 4 }}>
                    <T size={13} weight="600">{t('oorg.replace_reason')}</T>
                    {['Injury', 'Withdrew', 'No-show', 'Upgrade required', 'Other'].map((r) => (
                      <Btn key={r} label={r} variant={replaceReason === r ? 'primary' : 'ghost'} onPress={() => setReplaceReason(r)} style={{ marginBottom: 4 }} />
                    ))}
                    <Btn label={t('oorg.replace')} loading={busy === `replace-${p.id}`} onPress={doReplace} />
                    <Btn label="Cancel" variant="ghost" onPress={() => setReplaceSheet(null)} />
                  </View>
                ) : (
                  <Btn label={t('oorg.replace')} onPress={() => { setReplaceSheet(p); setReplaceReason(''); }} />
                )}
              </View>
            </Card>
          )) : <Empty title={t('oorg.replace_empty')} />
        ) : null}

        {/* Expiring */}
        {tab === 'expiring' ? (
          expiring.length ? expiring.map((p) => (
            <Card key={p.id} color={deadlineUrgency(p.invitation_deadline)}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Tag label={ROLE_LABEL[p.role] ?? p.role} color={c.violetSoft} />
                  <Tag label={`⏰ ${t('oal.deadline_label')}: ${fmt(p.invitation_deadline, p.venue_timezone)}`} color={deadlineUrgency(p.invitation_deadline)} />
                </View>
                <T weight="700" size={14}>{p.official_display_name ?? 'Official'}</T>
                <T size={13} color={c.mute}>{p.event_name} · {fmt(p.scheduled_at, p.venue_timezone)}</T>
                <Btn label={t('oorg.deadline_set')} variant="ghost" size="sm" onPress={() => { setDeadlineSheet(p); setDeadlineVal(''); }} />
              </View>
            </Card>
          )) : <Empty title={t('oorg.expiring_empty')} />
        ) : null}

        {/* Activity */}
        {tab === 'activity' ? (
          activity.length ? activity.map((ev, i) => (
            <Card key={i} color={c.paper} style={{ marginBottom: 6 }}>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <T size={18}>{ev.emoji ?? '·'}</T>
                <View style={{ flex: 1, gap: 2 }}>
                  <T weight="600" size={13}>{ev.title}</T>
                  {ev.detail ? <T size={12} color={c.mute}>{ev.detail}</T> : null}
                  <T size={11} color={c.mute}>{fmtDate(ev.at)}</T>
                </View>
              </View>
            </Card>
          )) : <Empty title={t('oorg.activity_empty')} />
        ) : null}

        {/* Deadline sheet */}
        {deadlineSheet ? (
          <Card color={c.paper} style={{ marginTop: 8 }}>
            <View style={{ gap: 8 }}>
              <T weight="700" size={14}>{t('oorg.deadline_set')} — {deadlineSheet.official_display_name ?? deadlineSheet.role}</T>
              <T size={12} color={c.mute}>Enter a deadline (ISO date-time, must be before the fixture start)</T>
              {/* Simple text input — in production this would be a DateTimePicker */}
              <Card color="#F5F5F5">
                <T size={12} color={c.mute}>e.g. 2026-11-20T18:00:00Z</T>
              </Card>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn label="Set" loading={busy === `dl-${deadlineSheet.id}`} onPress={setDeadline} style={{ flex: 1 }} />
                <Btn label="Cancel" variant="ghost" onPress={() => setDeadlineSheet(null)} style={{ flex: 1 }} />
              </View>
            </View>
          </Card>
        ) : null}

      </ScrollView>
    </Screen>
  );
}

function StatChip({ icon, label, color }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color ?? '#F5F5F5', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
      <T size={11}>{icon}</T>
      <T size={11} weight="600">{label}</T>
    </View>
  );
}
