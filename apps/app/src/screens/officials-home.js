// Officials Home (#88): the match official's own operating view. Today's match, requests to accept or decline, a calendar with clashes, availability,
// my officiating history and "ask the rules" - all read from the canonical assignment, fixture and rulebook capabilities (the same ones agents use over MCP).
// The live scoring console is the existing Match Centre and the result goes through the existing score sheet; this screen links to them rather than copying them.
// The server decides every permission; this only shows what comes back and keeps touch targets large for pitch-side use.
import { FixtureParaSummary } from './para-competition';
import { FixturePermissionsPanel } from './officials-console';
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { todayLocal } from '../pickers';
import { explain, LoadError } from '../access';
import { c, grad } from '../theme';
import { Banner, Metric, money } from '../federation-ui';
import { openPdf } from '../open-file';
import { OfficialCredentialHub } from './official-credential-hub';
import { t } from '../i18n';
import { OfficialProfileWizard } from './official-profile-wizard';
import { Cols } from '../federation-bits';
import { VerificationSection } from './verification';
import { MatchDayPack } from './match-day-pack';
import { RefereeOfflineSync } from './referee-offline-sync';
import { OfficialSafeguardingDesk } from './officials-safeguarding';
import { RulesTab } from './rule-session';
import { AvailabilityTab } from './officials-availability';
import { CalendarTab } from './officials-calendar';
import { OfficialsReputation } from './officials-reputation';

export const ROLE_LABEL = {
  referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant referee', scorer: 'Scorer / timekeeper',
  video_assistant_referee: 'VAR', fourth_official: 'Fourth official', reserve_assistant_referee: 'Reserve AR',
  shot_clock_operator: 'Shot clock', timekeeper: 'Timekeeper', goal_line_official: 'Goal-line official', technical_official: 'Technical official',
};
const STATUS = {
  invited: ['⏳ Awaiting your reply', c.sunSoft], proposed: ['📋 Awaiting organiser review', c.cyanSoft],
  accepted: ['✅ Confirmed', c.mintSoft], confirmed: ['✅ Crew confirmed', c.mintSoft],
  completed: ['🏁 Completed', c.violetSoft], declined: ['Declined', c.paper],
  expired: ['⏱ Invitation expired', c.paper], replaced: ['🔄 Replaced', c.paper],
  withdrawn: ['Withdrawn', c.paper], released: ['Released by organiser', c.paper], cancelled: ['Match cancelled', c.paper],
};
const CRED = {
  verified: ['✅ Verified official', c.mintSoft], expiring: ['⚠️ Verification ending soon', c.sunSoft], expired: ['⛔ Verification expired', c.sunSoft], revoked: ['⛔ Verification revoked', c.sunSoft],
  pending: ['⏳ Verification in review', c.cyanSoft], rejected: ['Verification not approved', c.paper], self_declared: ['Self-declared referee profile', c.paper], none: ['No referee profile yet', c.paper],
};
const DECLINE_REASONS = ['Not available then', 'Too far to travel', 'Clash with another match', 'Not my level or sport'];
const REPORT_TYPES = [
  { value: 'match_report', label: 'Match report' }, { value: 'misconduct', label: 'Misconduct' }, { value: 'send_off', label: 'Send-off / ejection' }, { value: 'abandonment', label: 'Abandonment / suspension' },
  { value: 'venue_incident', label: 'Spectator / venue incident' }, { value: 'equipment_field', label: 'Equipment or field issue' }, { value: 'protest_noted', label: 'Protest noted' }, { value: 'other', label: 'Other' },
];

const PAY = { agreed: ['Fee agreed', c.cyanSoft], due: ['Payment due', c.sunSoft], paid: ['Paid', c.mintSoft], disputed: ['Payment disputed', c.sunSoft] };
const payTag = (a) => (a.fee_minor != null && PAY[a.pay_status] ? <Tag label={`💰 ${money(a.fee_minor, a.fee_currency)} · ${PAY[a.pay_status][0]}${a.pay_confirmed_at ? ' · receipt confirmed' : ''}`} color={PAY[a.pay_status][1]} /> : null);
const when = (iso, tz) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '');
const clock = (iso, tz) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '');
const statusTag = (s) => <Tag label={STATUS[s]?.[0] ?? s} color={STATUS[s]?.[1] ?? c.paper} />;
const roleTag = (r) => <Tag label={ROLE_LABEL[r] ?? r} color={c.violetSoft} />;
/** Returns "HH:MM" string for arrive-by time (kickoff minus reportingMin), in the fixture's timezone. */
const arriveByTime = (scheduledAt, reportingMin, tz) => {
  const d = new Date(new Date(scheduledAt).getTime() - reportingMin * 60000);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
};

const deadlineColor = (dl) => { const h = (new Date(dl) - Date.now()) / 36e5; return h < 4 ? c.sunSoft : h < 24 ? '#FFF3CD' : c.paper; };

// ------------------------------------------------------------------ one assignment
function Assignment({ a, tz, onOpen, children, prominent }) {
  return (
    <Card color={prominent ? c.paper : c.paper} onPress={onOpen} accessibilityLabel={`${a.home_name ?? 'TBD'} versus ${a.away_name ?? 'TBD'}, ${when(a.scheduled_at, tz)}, ${ROLE_LABEL[a.role] ?? a.role}, ${a.status}`}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {roleTag(a.role)}
          {statusTag(a.status)}
          {a.needs_ack ? <Tag label="🔔 Changed: acknowledge" color={c.sunSoft} /> : null}
          {a.invitation_deadline && ['invited','proposed'].includes(a.status) ? <Tag label={`⏰ ${t('oal.deadline_label')}: ${when(a.invitation_deadline, tz)}`} color={deadlineColor(a.invitation_deadline)} /> : null}
          {a.locked_at ? <Tag label={`🔒 ${t('officials.lock.badge')}`} color={c.pinkSoft} /> : null}
          {payTag(a)}
        </View>
        <T weight="800" size={prominent ? 22 : 17} style={{ letterSpacing: -0.4 }}>{a.home_name ?? 'TBD'} v {a.away_name ?? 'TBD'}</T>
        <T size={13} color={c.mute}>{a.sport_emoji} {a.event_name}{a.round ? ` · ${a.round}` : ''}</T>
        <T size={14} weight="700">{when(a.scheduled_at, tz)} · {a.duration_min} min</T>
        {a.status === 'accepted' && a.reporting_min > 0 && a.scheduled_at ? (
          <T size={13} color={c.cyan} weight="600">
            ⏱ {t('officials.arrive_by', { time: arriveByTime(a.scheduled_at, a.reporting_min, tz) })}
          </T>
        ) : null}
        {a.resource_name || a.venue_name ? <T size={13} color={c.mute}>📍 {[a.resource_name, a.venue_name].filter(Boolean).join(' · ')}</T> : null}
        {children}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------ Today
function Today({ h, reload, go, tz }) {
  const { toast } = useSession();
  const [declining, setDeclining] = useState(null);
  const [busy, setBusy] = useState(null);
  const respond = async (a, response, reason) => {
    setBusy(a.id);
    try { await api.post(`/official-assignments/${a.id}/respond`, { response, reason }); toast(response === 'accept' ? 'Accepted. You are on the crew.' : 'Declined. The organiser has been told.'); await reload(); }
    catch (e) { toast(explain(e)); await reload(); } finally { setBusy(null); }
  };
  const act = (it) => {
    if (it.kind === 'invitation' || it.kind === 'changed') return null;
    if (it.fixture_id) return () => go('OfficialMatch', { id: it.fixture_id, ...(it.kind === 'report_due' ? { report: true } : {}) });
    if (it.kind === 'credential') return () => go('OfficialsHome', { tab: 'credential' });
    // Invoice-related inbox actions (#1008)
    if (it.kind === 'rci_pending' || it.kind === 'invoice_queried' || it.kind === 'payout_complete') return () => go('OfficialInvoices', { role: 'official' });
    if (it.kind === 'expense_approved_batch_prompt') return () => go('OfficialInvoices', { role: 'official', tab: 'expenses' });
    return null;
  };
  // Everything an official can open, grouped by the job it does: [icon, label, live line from real data, onPress].
  const groups = [
    [t('off.qa.matchday'), [
      ['📅', t('off.qa.assignments'), t('off.qa.this_week', { n: h.stats.this_week }), () => go('OfficialsHome', { tab: 'calendar' })],
      ['📨', t('off.qa.requests'), h.stats.pending ? t('off.qa.to_answer', { n: h.stats.pending }) : t('off.qa.none_waiting'), () => go('OfficialsHome', { tab: 'today' })],
      ['🕒', t('off.qa.availability'), null, () => go('OfficialsHome', { tab: 'availability' })],
      ['🎛️', t('off.qa.console'), h.next ? `${h.next.home_name ?? 'TBD'} v ${h.next.away_name ?? 'TBD'}` : t('off.qa.no_assignment'), h.next ? () => go('OfficialsConsole', { id: h.next.fixture_id }) : null],
    ]],
    [t('off.qa.rules'), [
      ['📖', t('off.qa.rulebook'), null, () => go('OfficialsHome', { tab: 'rules' })],
      ['⚖️', t('off.ql_reports'), null, () => go('OfficialsHome', { tab: 'reports' })],
      ['🏛', t('off.ql_discipline'), null, () => go('DisciplineCases')],
    ]],
    [t('off.qa.career'), [
      ['🗂️', t('off.qa.history'), t('off.qa.completed', { n: h.stats.completed_this_season }), () => go('OfficialsHome', { tab: 'history' })],
      ['🎓', t('off.qa.grade'), null, () => go('OfficialsDevelopment')],
      ['📚', t('refEdu.tab.catalogue'), null, () => go('OfficialsEducation')],
      ['🪪', t('off.qa.verification'), null, () => go('OfficialsHome', { tab: 'credential' })],
      ['💼', t('off.qa.opportunities'), null, () => go('Openings')],
      ['⚡', t('open_slot.title'), t('open_slot.metric_open_sub'), () => go('OpenMatchSlots')],
      ['📂', t('nav.title.OfficialPortfolio'), null, () => go('OfficialPortfolio')],
      ['🛎️', t('officials.svc.title'), t('officials.svc.subtitle'), () => go('OfficialServicesHub')],
    ]],
    [t('off.qa.money'), [
      ['💰', t('off.qa.earnings'), null, () => go('OfficialEarnings')],
      ['💳', t('rc.title'), null, () => go('RateCardCatalog')],
      ['🧾', t('off.qa.invoices'), null, () => go('OfficialInvoices', { role: 'official' })],
      ['🏦', t('off.qa.payout'), null, () => go('OfficialPayoutAccount', { officialId: h.user_id ?? h.official?.user_id })],
      ['📊', t('off.qa.tax'), null, () => go('OfficialTax')],
      ['🌐', t('ointl.title'), null, () => go('OfficialIntlSettings')],
    ]],
  ];
  const matches = (
    <View style={{ gap: 14 }}>
      {h.today.length ? (
        <Section title="Today" color={c.mint}>
          <View style={{ gap: 10 }}>{h.today.map((a) => (
            <Assignment key={a.id} a={a} tz={tz} prominent onOpen={() => go('OfficialMatch', { id: a.fixture_id })}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                <Btn title="Briefing & checks" onPress={() => go('OfficialMatch', { id: a.fixture_id })} style={{ minHeight: 48 }} />
                <Btn title="Open live console" color={c.violet} onPress={() => go('OfficialsConsole', { id: a.fixture_id })} style={{ minHeight: 48 }} />
                <Btn title={t('crew.btn_crew_hub')} color={c.mintSoft} onPress={() => go('OfficialCrewHub', { fixtureId: a.fixture_id })} style={{ minHeight: 48 }} />
              </View>
            </Assignment>
          ))}</View>
        </Section>
      ) : h.next ? (
        <Section title="Next match" color={c.mint}><Assignment a={h.next} tz={tz} prominent onOpen={() => go('OfficialMatch', { id: h.next.fixture_id })} /></Section>
      ) : <Section title={t('off.next_match')} color={c.mint}><Empty emoji="🏁" title="No matches coming up" sub="When an organiser asks you to officiate, the request appears here to accept or decline." /></Section>}

      <MatchDayPack />

      {h.pending_requests.length ? (
        <Section title={`Requests waiting for you (${h.pending_requests.length})`} color={c.sun}>
          <View style={{ gap: 10 }}>{h.pending_requests.map((a) => (
            <Assignment key={a.id} a={a} tz={tz} onOpen={() => {}}>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                <Btn title="Accept" loading={busy === a.id} onPress={() => respond(a, 'accept')} style={{ flex: 1, minHeight: 48 }} accessibilityLabel={`Accept ${a.home_name} versus ${a.away_name}`} />
                <Btn title="Decline" onPress={() => setDeclining(a)} color={c.paper} ink={c.ink} style={{ flex: 1, minHeight: 48 }} accessibilityLabel={`Decline ${a.home_name} versus ${a.away_name}`} />
              </View>
            </Assignment>
          ))}</View>
        </Section>
      ) : null}
    </View>
  );
  const work = (
    <View style={{ gap: 14 }}>
      <Section title={`Needs your attention${h.inbox.length ? ` (${h.inbox.length})` : ''}`} color={c.pink}>
        {h.inbox.length ? <View style={{ gap: 8 }}>{h.inbox.map((it, i) => {
          const onPress = act(it);
          return (
            <Card key={`${it.kind}${it.official_id ?? it.case_id ?? i}`} onPress={onPress ?? undefined} pad={14} accessibilityLabel={`${it.title}. ${it.detail ?? ''}`}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T weight="800" size={14.5} numberOfLines={2}>{it.title}</T>
                  {it.detail ? <T size={12.5} color={c.mute} numberOfLines={2}>{it.detail}</T> : null}
                </View>
                {it.kind === 'changed' ? <Btn title="Acknowledge" onPress={() => respond({ id: it.official_id }, 'accept')} style={{ minHeight: 44, flexShrink: 0 }} /> : onPress ? <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><T size={20} color={c.mute}>›</T></View> : null}
              </View>
            </Card>
          );
        })}</View> : <Empty emoji="✨" title="All clear" sub="No invitations, changes, pre-match checks, reports or disputes need you right now." />}
      </Section>
    </View>
  );
  const actions = (
    <Section title={t('off.qa.title')} color={c.cyan}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {groups.map(([title, items]) => (
          <Card key={title} pad={14} style={{ flexGrow: 1, flexBasis: 280, minWidth: 0 }}>
            <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8, marginBottom: 6 }}>{title.toUpperCase()}</T>
            {items.map(([e, label, sub, onPress], i) => (
              <Pressable key={label} onPress={onPress ?? undefined} disabled={!onPress} accessibilityRole="button" accessibilityState={{ disabled: !onPress }} accessibilityLabel={`${label}${sub ? `, ${sub}` : ''}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderColor: c.line, opacity: onPress ? 1 : 0.55 }}>
                <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T size={17}>{e}</T></View>
                <View style={{ flex: 1 }}>
                  <T weight="700" size={14.5} numberOfLines={1}>{label}</T>
                  {sub ? <T size={12} color={c.mute} numberOfLines={1}>{sub}</T> : null}
                </View>
                {onPress ? <T size={18} color={c.mute}>›</T> : null}
              </Pressable>
            ))}
          </Card>
        ))}
      </View>
    </Section>
  );
  return (
    <View style={{ gap: 14 }}>
      <Cols a={matches} b={work} ratio={[3, 2]} />
      {actions}
      <Sheet visible={!!declining} onClose={() => setDeclining(null)} title="Decline this request">
        <T size={13} color={c.mute}>Tell the organiser why so they can find someone quickly. You can also leave it blank.</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {DECLINE_REASONS.map((r) => <Chip key={r} label={r} onPress={() => { const a = declining; setDeclining(null); respond(a, 'decline', r); }} />)}
        </View>
        <Btn title="Decline without a reason" color={c.paper} ink={c.ink} style={{ marginTop: 12, minHeight: 48 }} onPress={() => { const a = declining; setDeclining(null); respond(a, 'decline'); }} />
      </Sheet>
    </View>
  );
}

// ------------------------------------------------------------------ payment actions (the official's side)
function PayActions({ a, reload }) {
  const { toast } = useSession();
  const { push: go } = useNav();
  const [dispute, setDispute] = useState(false);
  if (!['due', 'paid'].includes(a.pay_status) || a.fee_minor == null) return null;
  const send = async (response, note) => { try { await api.post(`/official-assignments/${a.id}/payment-response`, { response, note }); toast(response === 'confirm' ? 'Receipt confirmed' : 'The organiser has been told'); await reload(); } catch (e) { toast(explain(e)); throw e; } };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {a.pay_status === 'paid' && !a.pay_confirmed_at ? <Btn small title="I received this" onPress={() => send('confirm')} style={{ minHeight: 44 }} /> : null}
      {a.pay_status === 'paid' ? <Btn small title={t('payout.statement')} color={c.violet} accessibilityLabel={t('payout.statement')} onPress={() => go('Earnings')} style={{ minHeight: 44 }} /> : null}
      <Btn small title="Something is wrong" color={c.paper} ink={c.ink} onPress={() => setDispute(true)} style={{ minHeight: 44 }} />
      <FormSheet visible={dispute} onClose={() => setDispute(false)} title="Dispute this payment" submitLabel="Tell the organiser" onSubmit={async (v) => { await send('dispute', v.note); setDispute(false); }}
        fields={[{ key: 'note', label: 'What is wrong (amount, date, not received)', type: 'multiline' }]} />
    </View>
  );
}

// ------------------------------------------------------------------ feedback about me, and the reporting extract
function Feedback() {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/officials/feedback'), []);
  const [reply, setReply] = useState(null);
  const [contest, setContest] = useState(null);
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const f = q.data;
  return (
    <View style={{ gap: 10 }}>
      {!f.enough ? <Empty emoji="🔒" title={`${f.responses} response${f.responses === 1 ? '' : 's'} so far`} sub={`Feedback appears once at least ${f.minimum} people have answered, so nobody can be picked out. It is never one overall score.`} /> : (
        <>
          <Card><View style={{ gap: 8 }}>
            {f.criteria.map((x) => (
              <View key={x.key} accessible accessibilityLabel={`${x.label}: average ${x.average ?? 'none'} from ${x.responses} responses`} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T weight="700">{x.label}</T><T>{x.average ?? 'n/a'} <T size={12} color={c.mute}>/ 5 · {x.responses}</T></T>
              </View>
            ))}
            <T size={12} color={c.mute}>Averages of {f.responses} responses from team managers and event organisers. Authors are never shown.</T>
          </View></Card>
          {f.comments.map((m) => (
            <Card key={m.id} pad={14}><View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Tag label={m.capacity === 'event_official' ? 'Event official' : 'Team official'} color={c.violetSoft} />{m.status === 'contested' ? <Tag label="Under review" color={c.sunSoft} /> : null}</View>
              {m.comment ? <T>"{m.comment}"</T> : null}
              <T size={12} color={c.mute}>{m.event_name}</T>
              {m.reply ? <T size={13}><T weight="800">Your reply: </T>{m.reply}</T> : null}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {m.comment && !m.reply ? <Btn small title="Reply" color={c.paper} ink={c.ink} onPress={() => setReply(m)} style={{ minHeight: 44 }} /> : null}
                {m.status !== 'contested' ? <Btn small title="Ask for a review" color={c.paper} ink={c.ink} onPress={() => setContest(m)} style={{ minHeight: 44 }} /> : null}
              </View>
            </View></Card>
          ))}
        </>
      )}
      <FormSheet visible={!!reply} onClose={() => setReply(null)} title="Reply publicly" submitLabel="Reply" onSubmit={async (v) => { try { await api.post(`/official-feedback/${reply.id}/reply`, { reply: v.reply }); toast('Reply added'); setReply(null); await q.reload(); } catch (e) { toast(explain(e)); throw e; } }} fields={[{ key: 'reply', label: 'Your reply', type: 'multiline' }]} />
      <FormSheet visible={!!contest} onClose={() => setContest(null)} title="Ask the platform team to review" submitLabel="Send for review" notice="Use this for abuse, the wrong match or retaliation. The response stays visible, marked as under review, until it is decided."
        onSubmit={async (v) => { try { await api.post(`/official-feedback/${contest.id}/contest`, { reason: v.reason }); toast('Sent for review'); setContest(null); await q.reload(); } catch (e) { toast(explain(e)); throw e; } }} fields={[{ key: 'reason', label: 'Why', type: 'multiline' }]} />
    </View>
  );
}

function Extracts({ sports }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/officials/extracts'), []);
  const [form, setForm] = useState(false);
  const [share, setShare] = useState(null);
  const [busy, setBusy] = useState(false);
  const year = new Date().getFullYear();
  const build = async (v) => {
    setBusy(true);
    try { const r = await api.post('/me/officials/extracts', { from: v.from, to: v.to, ...(v.sport ? { sport_id: sports.find((s) => s.slug === v.sport)?.id } : {}), client_key: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }); toast(`Extract built (${r.pages} pages)`); setForm(false); await q.reload(); }
    catch (e) { toast(explain(e)); throw e; } finally { setBusy(false); }
  };
  const open = async (x) => { try { await openPdf(`/official-extracts/${x.id}/pdf`, `officiating-extract-${x.period_to}`); } catch (e) { toast(explain(e)); } };
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>A PDF of your assignments, the closure forms in detail (score sheet, sign-offs, your reports and revisions), fees and payment status, linked disputes and feedback. It is a frozen snapshot you own, and you decide who may read it.</T>
      <Btn title="📄 Build a new extract" onPress={() => setForm(true)} loading={busy} style={{ minHeight: 48 }} />
      {q.data.length ? q.data.map((x) => (
        <Card key={x.id} pad={14}><View style={{ gap: 6 }}>
          <T weight="800">{x.period_from} to {x.period_to}</T>
          <T size={12.5} color={c.mute}>{x.counts.assignments} assignments · {x.counts.completed} completed · {x.counts.reports} reports · {x.pages} page{x.pages === 1 ? '' : 's'} · built {new Date(x.created_at).toLocaleDateString()}</T>
          {x.shares.filter((s) => s.active).map((s) => <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><T size={13}>Shared with {s.recipient_name} until {new Date(s.expires_at).toLocaleDateString()}</T><Btn small title="Stop" color={c.paper} ink={c.ink} style={{ minHeight: 44 }} onPress={async () => { try { await api.post(`/me/officials/extract-shares/${s.id}/revoke`, {}); toast('Sharing stopped'); await q.reload(); } catch (e) { toast(explain(e)); } }} /></View>)}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Open PDF" onPress={() => open(x)} style={{ minHeight: 44 }} /><Btn small title="Share" color={c.paper} ink={c.ink} onPress={() => setShare(x)} style={{ minHeight: 44 }} /></View>
        </View></Card>
      )) : <Empty emoji="📄" title="No extracts yet" sub="Build one to keep a complete, dated record of your officiating." />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Build an extract" submitLabel="Build PDF" onSubmit={build}
        fields={[{ key: 'from', label: 'Period', type: 'daterange', toKey: 'to' }, { key: 'sport', label: 'Only this sport (optional)', type: 'sport', optional: true }]} initial={{ from: `${year}-01-01`, to: todayLocal() }} />
      <FormSheet visible={!!share} onClose={() => setShare(null)} title="Share this extract" submitLabel="Share" notice="The person can read the PDF until it expires or you stop sharing. Every read is logged."
        onSubmit={async (v) => { try { await api.post(`/me/officials/extracts/${share.id}/shares`, { recipient_id: v.person, days: v.days }); toast('Shared'); setShare(null); await q.reload(); } catch (e) { toast(explain(e)); throw e; } }}
        fields={[{ key: 'person', label: 'Who', type: 'entity', entityKind: 'person', noun: 'person' }, { key: 'days', label: 'For how many days', type: 'stepper', min: 1, max: 90, default: 14, suffix: 'days' }]} initial={{ days: 14 }} />
    </View>
  );
}

function RecordTab({ sports }) {
  return (
    <View style={{ gap: 14 }}>
      <Section title="Reporting extract (PDF)" color={c.pink}><Extracts sports={sports} /></Section>
      <Section title="Feedback about you" color={c.mint}><Feedback /></Section>
    </View>
  );
}

// ------------------------------------------------------------------ History
function HistoryTab({ go, tz }) {
  const [status, setStatus] = useState(null);
  const q = useLoad(() => api.get('/me/officials/history', { ...(status ? { status } : {}), limit: 50 }), [status]);
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const { items, totals } = q.data;
  return (
    <View style={{ gap: 12 }}>
      {totals.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{totals.map((t) => <Metric key={`${t.sport_name}${t.role}`} value={t.matches} label={`${t.sport_name} · ${ROLE_LABEL[t.role] ?? t.role}`} />)}</View> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {[[null, 'All'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['released', 'Released'], ['withdrawn', 'Withdrawn'], ['declined', 'Declined']].map(([v, l]) => <Chip key={l} label={l} active={status === v} onPress={() => setStatus(v)} />)}
      </View>
      {items.length ? <View style={{ gap: 10 }}>{items.map((a) => (
        <Assignment key={a.id} a={a} tz={tz} onOpen={() => go('OfficialMatch', { id: a.fixture_id })}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {a.verified_at_the_time ? <Tag label="Verified at the time" color={c.mintSoft} /> : null}
            <Tag label={`${a.reports_filed} report${a.reports_filed === 1 ? '' : 's'}`} color={c.paper} />
            {a.disputes_linked ? <Tag label={`${a.disputes_linked} dispute${a.disputes_linked === 1 ? '' : 's'} linked`} color={c.sunSoft} /> : null}
          </View>
          <PayActions a={a} reload={q.reload} />
        </Assignment>
      ))}</View> : <Empty emoji="🗂️" title="No officiating history yet" sub="Matches you have officiated build up here from your assignments." />}
      <T size={12} color={c.mute}>This is a record of what you did, not a rating. There is no score or ranking of officials.</T>
    </View>
  );
}

// ------------------------------------------------------------------ Rules
export function AskRules({ fixtureId, sport }) {
  const [question, setQuestion] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { push } = useNav();
  const ask = async () => {
    setBusy(true); setErr(null);
    try { setOut(await api.get('/officials/rules/ask', { question, ...(fixtureId ? { fixture_id: fixtureId } : { sport }) })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 10 }}>
      <Field label="Ask the rules" value={question} onChangeText={setQuestion} placeholder="e.g. How does a free kick restart play?" maxLength={300} hint="Explains what the rulebook says. It never makes a call, judges a player, issues a card or changes a score." />
      <Btn title="Ask" onPress={ask} loading={busy} disabled={question.trim().length < 3} style={{ minHeight: 48 }} />
      {err ? <LoadError error={err} onRetry={ask} /> : null}
      {out ? (
        <Card color={out.declined ? c.sunSoft : c.paper}>
          <View style={{ gap: 8 }}>
            {out.declined || out.insufficient ? <T>{out.message}</T> : <T>{out.answer}</T>}
            {out.citations?.map((x) => (
              <View key={x.n} style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8, gap: 2 }}>
                <T weight="800" size={13}>[{x.n}] {x.no ? `${x.no} · ` : ''}{x.title}</T>
                <T size={12.5} color={c.mute}>{x.source}</T>
                {x.settings.filter((s) => s.local_change).map((s) => <T key={s.label} size={12.5}>Local rule: {s.label} = {String(s.value)} (standard {String(s.standard)})</T>)}
              </View>
            ))}
            {out.rule_version ? <T size={11.5} color={c.mute}>Rulebook version {out.rule_version.standard_hash}{out.rule_version.local ? ` · local rules "${out.rule_version.local.name}" v${out.rule_version.local.version}` : ''}{out.ai ? ' · explained by AI from the sections above' : ''}</T> : null}
          </View>
        </Card>
      ) : null}
      <Btn small title="📖 Open the full rulebook" color={c.paper} ink={c.ink} onPress={() => push('SportRules', sport ? { sport, tab: 'rulebook' } : {})} style={{ alignSelf: 'flex-start', minHeight: 44 }} />
    </View>
  );
}

// ------------------------------------------------------------------ Reports Tab (all my reports with new status workflow)
const REPORT_STATUS_CHIP = {
  filed:      [t('or.status.filed'),      c.violetSoft],
  revised:    [t('or.status.revised'),    c.violetSoft],
  co_signing: [t('or.status.co_signing'), c.sunSoft],
  submitted:  [t('or.status.submitted'),  c.cyanSoft],
  accepted:   [t('or.status.accepted'),   c.mintSoft],
  queried:    [t('or.status.queried'),    c.redSoft],
};
const INCIDENT_BADGE = { caution: '🟨', send_off: '🟥', suspension: '⚠️', abandonment: '🚫', venue: '🏟️', protest: '🤝', misconduct: '⚠️', other: '📋' };

function ReportStatusTag({ status }) {
  const [label, bg] = REPORT_STATUS_CHIP[status] ?? [status, c.violetSoft];
  return <Tag label={label} color={bg} />;
}

function ReportCard({ r, onView, onProvenance }) {
  const incidents = Array.isArray(r.incidents) ? r.incidents : [];
  const cauCount = incidents.filter((i) => i.type === 'caution').length;
  const soCount = incidents.filter((i) => i.type === 'send_off').length;
  const needsCosign = r.status === 'co_signing';
  const needsAction = r.status === 'queried';
  return (
    <Card onPress={onView} accessibilityLabel={`${r.category?.replace(/_/g, ' ')} report, ${r.status}`}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <ReportStatusTag status={r.status} />
          {needsCosign ? <Tag label={t('or.needs_cosign')} color={c.sunSoft} /> : null}
          {needsAction ? <Tag label={t('or.queried_action')} color={c.redSoft} /> : null}
        </View>
        <T weight="800" size={16}>{r.home_name ?? 'TBD'} v {r.away_name ?? 'TBD'}</T>
        <T size={13} color={c.mute}>{r.event_name ? `${r.event_name} · ` : ''}{r.created_at ? new Date(r.created_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : ''}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={REPORT_TYPES.find((t) => t.value === r.category)?.label ?? r.category} color={c.pinkSoft} />
          {cauCount > 0 ? <Tag label={`🟨 ${cauCount}`} color={c.sunSoft} /> : null}
          {soCount > 0 ? <Tag label={`🟥 ${soCount}`} color={c.redSoft} /> : null}
          {r.disc_case_id ? <Tag label={t('or.disc_case_linked')} color={c.orangeSoft} /> : null}
          {r.attachment_count > 0 ? <Tag label={`📎 ${r.attachment_count}`} color={c.cyanSoft} /> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          <Btn small title={t('or.view')} onPress={onView} style={{ minHeight: 44 }} />
          {r.submitted_hash ? <Btn small title={t('or.provenance')} color={c.pinkSoft} onPress={onProvenance} style={{ minHeight: 44 }} /> : null}
        </View>
      </View>
    </Card>
  );
}

function ReportsTab({ go }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const reports = useLoad(() => api.get('/me/officials/home', { limit: 1, offset: 0 }).then(() =>
    api.get('/discipline/my-cases', { kind: 'all', status: 'all', limit: 1, offset: 0 })
      .catch(() => ({ items: [] }))), []);
  const myReports = useLoad(() => api.get('/fixtures', { my_official_reports: true, limit: 50, offset: 0 }).catch(() => ({ items: [] })), [statusFilter]);
  const cases = useLoad(() => api.get('/discipline/my-cases', { kind: 'all', status: 'all', limit: 20, offset: 0 }), []);
  const caseCount = cases.data?.items?.length ?? 0;
  const items = myReports.data?.items ?? [];

  return (
    <View style={{ gap: 0 }}>
      {caseCount > 0 ? (
        <Section title={t('or.disc_cases_header')} color={c.orange} action={t('or.view_all')} onAction={() => go('DisciplineCases')}>
          <Card color={c.orangeSoft} onPress={() => go('DisciplineCases')}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T size={28}>⚖️</T>
              <View style={{ flex: 1 }}>
                <T weight="800">{t('or.disc_open', { count: caseCount })}</T>
                <T size={13} color={c.mute}>{t('or.disc_open_sub')}</T>
              </View>
              <T size={20} color={c.orange}>›</T>
            </View>
          </Card>
        </Section>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingBottom: 8, flexWrap: 'wrap' }}>
        {[['all', t('or.filter_all')], ['filed', t('or.status.filed')], ['co_signing', t('or.status.co_signing')], ['submitted', t('or.status.submitted')], ['accepted', t('or.status.accepted')], ['queried', t('or.status.queried')]].map(([v, l]) => (
          <Pressable key={v} onPress={() => setStatusFilter(v)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: statusFilter === v ? c.pink : c.paper, minHeight: 44, justifyContent: 'center' }} accessibilityRole="button">
            <T size={12} weight="700" color={statusFilter === v ? '#fff' : c.mute}>{l}</T>
          </Pressable>
        ))}
      </View>
      {myReports.loading ? <Loading /> : items.length === 0 ? (
        <Empty emoji="📋" title={t('or.empty_title')} sub={t('or.empty_sub')} />
      ) : (
        <View style={{ gap: 0 }}>
          {items.map((r) => (
            <ReportCard key={r.id} r={r}
              onView={() => go('OfficialReportDetail', { id: r.id })}
              onProvenance={() => go('OfficialReportProvenance', { id: r.id })} />
          ))}
        </View>
      )}
    </View>
  );
}

// ------------------------------------------------------------------ Set-up: one guided path to being asked and paid
const STEP_ICON = { profile: '🪪', rates: '💳', payout: '🏦', tax: '📊', verification: '✅' };
/** Profile, rate cards, payout account, tax and verification as one checklist. Each row opens the screen that owns that step. */
function SetupCard({ setup, hasSport, open }) {
  const [show, setShow] = useState(false);
  if (!setup) return null;
  const complete = setup.done === setup.total && hasSport;
  const pct = Math.round((setup.done / setup.total) * 100);
  const TONE = { done: [t('off.setup.done'), c.mintSoft], in_progress: [t('off.setup.in_progress'), c.sunSoft], todo: [t('off.setup.todo'), c.violetSoft] };
  const sub = (st) => (st.key === 'profile' && st.state === 'in_progress' ? t('off.setup.profile_pct', { pct: st.progress })
    : st.key === 'rates' && (st.count || st.drafts) ? t('off.setup.rates_n', { n: st.count, d: st.drafts }) : t(`off.setup.${st.key}_sub`));
  return (
    <Card style={{ marginTop: 12 }} pad={16}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8 }}>{t('off.setup.kicker').toUpperCase()}</T>
          <T weight="800" size={18} style={{ letterSpacing: -0.3 }}>{complete ? t('off.setup.complete') : t('off.setup.title', { done: setup.done, total: setup.total })}</T>
        </View>
        {complete ? <Btn small title={t(show ? 'off.setup.hide' : 'off.setup.review')} color={c.paper} ink={c.ink} onPress={() => setShow(!show)} style={{ minHeight: 44 }} />
          : <Btn small title={t('off.setup.continue')} onPress={open[setup.next] ?? open.sport} style={{ minHeight: 44 }} accessibilityLabel={t('off.setup.continue_a11y')} />}
      </View>
      <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }} style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden', marginTop: 10 }}>
        <View style={{ width: `${pct}%`, height: 8, backgroundColor: c.pink }} />
      </View>
      {!complete || show ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          {!hasSport ? (
            <Pressable onPress={open.sport} accessibilityRole="button" accessibilityLabel={t('off.setup.sport')} style={{ flexGrow: 1, flexBasis: 220, minHeight: 64, borderRadius: 14, borderWidth: 1, borderColor: c.line, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T size={20}>🏅</T>
              <View style={{ flex: 1 }}><T weight="700" size={14}>{t('off.setup.sport')}</T><T size={12} color={c.mute}>{t('off.setup.sport_sub')}</T></View>
              <Tag label={TONE.todo[0]} color={TONE.todo[1]} />
            </Pressable>
          ) : null}
          {setup.steps.map((st, i) => (
            <Pressable key={st.key} onPress={open[st.key]} accessibilityRole="button" accessibilityLabel={`${t(`off.setup.${st.key}`)}, ${TONE[st.state][0]}`} style={{ flexGrow: 1, flexBasis: 220, minHeight: 64, borderRadius: 14, borderWidth: 1, borderColor: st.key === setup.next ? c.pink : c.line, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T size={20}>{STEP_ICON[st.key]}</T>
              <View style={{ flex: 1 }}><T weight="700" size={14}>{i + 1}. {t(`off.setup.${st.key}`)}</T><T size={12} color={c.mute} numberOfLines={2}>{sub(st)}</T></View>
              <Tag label={TONE[st.state][0]} color={TONE[st.state][1]} />
            </Pressable>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ Permissions Tab
function PermissionsTab({ fixtureId }) {
  if (!fixtureId) return (
    <Section title={t('official.role_permissions.title')} color={c.violet}>
      <Card><T size={13} color={c.mute}>No upcoming fixture found. Open a match from the overview tab to see your role permissions.</T></Card>
    </Section>
  );
  return (
    <Section title={t('official.role_permissions.title')} color={c.violet}>
      <FixturePermissionsPanel fixtureId={fixtureId} />
    </Section>
  );
}

// ------------------------------------------------------------------ Para Training Alert
// Amber card shown when the official has incomplete mandatory para training for a sport they're
// assigned to officiate. Never shown unless para fixtures are assigned.
function ParaTrainingAlert({ go }) {
  const { data } = useLoad(() => api.get('/para/officiating/my-eligibility').catch(() => null), []);
  if (!data) return null;
  const incomplete = (data.sports ?? []).filter((s) => !s.eligible && s.incomplete_mandatory?.length > 0);
  if (incomplete.length === 0) return null;
  return (
    <Card color={c.sunSoft} style={{ marginTop: 10 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <T size={18} accessibilityElementsHidden>⚠️</T>
        <View style={{ flex: 1, gap: 4 }}>
          <T size={13} weight="800" color={c.sun}>{t('para_training.home_alert_title')}</T>
          <T size={12} color={c.mute}>{t('para_training.home_alert_body', { count: incomplete.length })}</T>
          {incomplete.slice(0, 2).map((s) => (
            <T key={s.sport_id} size={12} color={c.mute}>
              {s.sport_emoji ? `${s.sport_emoji} ` : ''}{s.sport_name}: {s.incomplete_mandatory.map((m) => m.title).join(', ')}
            </T>
          ))}
          {incomplete.length > 2 ? <T size={11} color={c.mute}>{t('para_training.home_alert_more', { count: incomplete.length - 2 })}</T> : null}
        </View>
      </View>
      <Btn
        title={t('para_training.home_alert_cta')}
        size="sm"
        onPress={() => go('OfficialParaTraining')}
        style={{ borderRadius: 20, backgroundColor: c.sun, alignSelf: 'flex-start', marginTop: 8 }}
        accessibilityLabel={t('para_training.home_alert_cta')}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ Officials Home
export function OfficialsHome({ tab: tab0 }) {
  const { push: go } = useNav();
  const L = useLayout();
  const [tab, setTab] = useState(tab0 ?? 'today');
  const [showProfileWizard, setShowProfileWizard] = useState(false);
  const [sportId, setSportId] = useState(null);
  const q = useLoad(() => api.get('/me/officials/home', sportId ? { sport_id: sportId } : {}), [sportId]);
  React.useEffect(() => { if (tab0) setTab(tab0); }, [tab0]);
  if (q.error && !q.data) return <Screen><H1>Officials home</H1><LoadError error={q.error} onRetry={q.reload} /></Screen>;
  if (!q.data) return <Screen><Loading /></Screen>;
  const h = q.data, tz = h.timezone;
  const cred = CRED[h.credential.state] ?? CRED.none;
  const body = tab === 'today' ? <Today h={h} reload={q.reload} go={go} tz={tz} />
    : tab === 'calendar' ? <CalendarTab tz={tz} go={go} sportId={sportId} />
    : tab === 'availability' ? <AvailabilityTab sports={h.sports} go={go} />
    : tab === 'history' ? <HistoryTab go={go} tz={tz} />
    : tab === 'reports' ? <ReportsTab go={go} />
    : tab === 'record' ? <RecordTab sports={h.sports} />
    : tab === 'rules' ? <Section title={t('off.tab_rules')} color={c.violet}>
        <RulesTab fixtureId={h.next?.fixture_id} sport={h.sport?.slug} isOrg={false} />
      </Section>
    : tab === 'permissions' ? <PermissionsTab fixtureId={h.next?.fixture_id} />
    : tab === 'safety' ? <OfficialSafeguardingDesk />
    : tab === 'reputation' ? <OfficialsReputation />
    : <OfficialCredentialHub mode="official" />;
  return (
    <Screen onRefresh={q.reload} refreshing={q.loading}>
      <GradCard colors={grad.hero}>
        <View style={{ gap: 10 }}>
          <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6 }}>OFFICIALS HOME</T>
          <T size={26} weight="800" color="#fff" style={{ letterSpacing: -0.8 }}>{h.sport ? `${h.sport.emoji} ${h.sport.name}` : 'Match official'}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Tag label={cred[0]} color={cred[1]} />
            {h.credential.licence ? <Tag label={`🏅 ${h.credential.licence.licence_type}`} color={c.violetSoft} /> : null}
          </View>
          {h.sports.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{h.sports.map((s) => <Chip key={s.id} label={`${s.emoji} ${s.name}`} active={(sportId ?? h.sport?.id) === s.id} onPress={() => setSportId(s.id)} />)}</View> : null}
        </View>
      </GradCard>
      <SetupCard setup={h.setup} hasSport={!!h.sports.length} open={{
        profile: () => setShowProfileWizard(true), rates: () => go('RateCardCatalog'), payout: () => go('OfficialPayoutAccount', { officialId: h.user_id ?? h.official?.user_id }),
        tax: () => go('OfficialTax'), verification: () => setTab('credential'), sport: () => go('SportProfile'),
      }} />
      {showProfileWizard ? <OfficialProfileWizard onClose={() => setShowProfileWizard(false)} onDone={() => { setShowProfileWizard(false); q.reload(); }} onOpen={(route, params) => { setShowProfileWizard(false); go(route, params); }} /> : null}
      <ParaTrainingAlert go={go} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
        <Metric value={h.stats.this_week} label="Matches this week" onPress={() => setTab('calendar')} />
        <Metric value={h.stats.pending} label="Requests to answer" tone={h.stats.pending ? c.sunSoft : undefined} onPress={() => setTab('today')} />
        <Metric value={h.stats.completed_this_season} label="Completed this season" onPress={() => setTab('history')} />
        <Metric value={h.stats.actions} label="Need attention" tone={h.stats.actions ? c.sunSoft : undefined} onPress={() => setTab('today')} />
      </View>
      <View style={{ marginTop: 12, marginBottom: 12 }}>
        <Seg options={[{ value: 'today', label: t('off.tab_overview') }, { value: 'calendar', label: t('off.tab_calendar') }, { value: 'availability', label: t('off.tab_availability') }, { value: 'history', label: t('off.tab_history') }, { value: 'reports', label: t('off.tab_reports') }, { value: 'record', label: t('off.tab_record') }, { value: 'rules', label: t('off.tab_rules') }, { value: 'permissions', label: t('official.role_permissions.title') }, { value: 'safety', label: t('osg.tab') }, { value: 'credential', label: t('off.tab_credential') }, { value: 'reputation', label: t('reputation.title') }]} value={tab} onChange={setTab} />
      </View>
      {body}
    </Screen>
  );
}

// ------------------------------------------------------------------ One match: briefing, checks, console, report
export function OfficialMatch({ id, report: openReport }) {
  const { toast } = useSession();
  const { push: go } = useNav();
  const L = useLayout();
  const q = useLoad(() => api.get(`/fixtures/${id}/briefing`), [id]);
  const reports = useLoad(() => api.get(`/fixtures/${id}/reports`).catch(() => []), [id]);
  const [rep, setRep] = useState(!!openReport);
  const [rules, setRules] = useState(false);
  const [busy, setBusy] = useState(null);
  const [fee, setFee] = useState(null);
  const [rate, setRate] = useState(null);
  const isOrg = ['organiser', 'admin'].includes(q.data?.my_role);
  const pays = useLoad(() => (isOrg && q.data?.fixture.event_id ? api.get(`/events/${q.data.fixture.event_id}/official-payouts`).catch(() => []) : Promise.resolve([])), [id, isOrg, q.data?.fixture.event_id]);
  const due = useLoad(() => api.get('/me/officials/feedback-due', { limit: 50 }).catch(() => []), [id]);
  if (q.error && !q.data) return <Screen><H1>Match briefing</H1><LoadError error={q.error} onRetry={q.reload} /></Screen>;
  if (!q.data) return <Screen><Loading /></Screen>;
  const b = q.data, tz = b.fixture.timezone;
  const left = b.checklist.filter((x) => !x.done).length;
  const tick = async (item) => {
    setBusy(item.key);
    try { await api.post(`/fixtures/${id}/briefing/checks`, { item_key: item.key, done: !item.done }); await q.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };
  const live = ['scheduled', 'live', 'paused'].includes(b.fixture.status);
  const crew = (
    <Section title="Officiating crew" color={c.violet}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{b.crew.map((m) => (
        <Card key={m.id} pad={12} style={{ minWidth: 150 }}>
          <T weight="800">{m.display_name}</T>
          <View style={{ marginTop: 4, alignSelf: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{roleTag(m.role)}{payTag(m)}</View>
          {(() => { const p = (pays.data ?? []).find((x) => x.assignment_id === m.id); return p?.payout_status ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('payout.officials_status', { status: t(`payout.status_${p.payout_status}`) })}{p.reference ? ` · ${p.reference}` : ''}</T> : p?.pay_status === 'due' ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('payout.officials_waiting')}</T> : null; })()}
          {['organiser', 'admin'].includes(b.my_role) && m.pay_status !== 'paid' ? <Btn small title={m.fee_minor == null ? 'Set fee' : 'Update fee'} color={c.paper} ink={c.ink} onPress={() => setFee(m)} style={{ marginTop: 8, minHeight: 44, alignSelf: 'flex-start' }} /> : null}
        </Card>
      ))}</View>
      <T size={12} color={c.mute}>Only officials who accepted count as crew. Being on the crew gives no organiser or finance access.</T>
    </Section>
  );
  const rulesCard = (
    <Section title="Rules in force" color={c.cyan}>
      <Card><View style={{ gap: 6 }}>
        {b.rules ? <><T weight="800">{b.rules.book}</T><T size={12.5} color={c.mute}>{b.rules.governing_body} · version {b.rules.standard_hash}</T>
          {b.rules.local ? <T>Local rules: <T weight="800">{b.rules.local.name}</T> v{b.rules.local.version}</T> : <T size={12.5} color={c.mute}>No local rules published for this event: standard rules apply.</T>}
          {b.rules.local_changes?.slice(0, 6).map((ch) => <T key={ch.key ?? ch.label} size={12.5}>• {ch.label ?? ch.key}: {String(ch.value)} (standard {String(ch.std)})</T>)}</>
          : <T size={13} color={c.mute}>No governed rulebook for this sport yet. The scoring set-up below is what the console will use.</T>}
        <T weight="800" style={{ marginTop: 6 }}>{b.structure.label}</T>
        <T size={13}>{b.structure.periods.count} × {b.structure.periods.label.toLowerCase()}{b.structure.sets ? ` · best of ${b.structure.sets.best_of}, first to ${b.structure.sets.points_to_win}` : ''}{b.structure.extra_time ? ` · extra time ${b.structure.extra_time.periods}×${b.structure.extra_time.minutes} min` : ''}{b.structure.shootout ? ' · shoot-out if level' : ''}{b.structure.draw_allowed ? ' · draws allowed' : ' · no draws'}</T>
        {b.structure.actions.length ? <T size={12.5} color={c.mute}>Console actions: {b.structure.actions.join(', ')}</T> : null}
        <Btn small title="📖 Ask the rules" color={c.violet} onPress={() => setRules(true)} style={{ alignSelf: 'flex-start', marginTop: 6, minHeight: 44 }} />
      </View></Card>
    </Section>
  );
  const checks = (
    <Section title={`Pre-match checks · ${b.checklist.length - left}/${b.checklist.length}`} color={c.mint}>
      <View style={{ gap: 8 }}>{b.checklist.map((it) => (
        <Card key={it.key} pad={14} onPress={() => tick(it)} accessibilityLabel={`${it.label}: ${it.done ? 'done' : 'not done'}. Double tap to ${it.done ? 'undo' : 'tick'}`} color={it.done ? c.mintSoft : c.paper} style={{ minHeight: 56 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <T size={24}>{busy === it.key ? '…' : it.done ? '✅' : '⬜'}</T>
            <View style={{ flex: 1 }}><T weight="700" size={15}>{it.label}</T>{it.done && it.by ? <T size={11.5} color={c.mute}>{it.by} · {clock(it.at, tz)}</T> : null}</View>
          </View>
        </Card>
      ))}</View>
    </Section>
  );
  const matchInfo = (
    <Card><View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{roleTag(b.my_role)}<Tag label={b.fixture.status} color={c.paper} /></View>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{b.teams.home ?? 'TBD'} v {b.teams.away ?? 'TBD'}</T>
      <T size={13} color={c.mute}>{b.sport.emoji} {b.event.name}{b.fixture.round ? ` · ${b.fixture.round}` : ''}</T>
      <T weight="700">{when(b.fixture.scheduled_at, tz)} · {b.fixture.duration_min} min</T>
      {b.venue.resource || b.venue.name ? <T size={13} color={c.mute}>📍 {[b.venue.resource, b.venue.name, b.venue.city].filter(Boolean).join(' · ')}</T> : null}
      <T size={13} color={c.mute}>Organiser: {b.organiser.name} (contact in the app)</T>
      <T size={12} color={c.mute}>🛟 {b.safety}</T>
    </View></Card>
  );
  const lineups = (
    <Section title="Line-ups" color={c.pink}>
      <Cols a={<Lineup side={b.lineups.home} name={b.teams.home} youth={b.event.youth} />} b={<Lineup side={b.lineups.away} name={b.teams.away} youth={b.event.youth} />} />
    </Section>
  );
  const actions = (
    <Section title="Match day" color={c.sun}>
      <View style={{ gap: 8 }}>
        {live ? <Btn title="🎛️ Open the live console" onPress={() => go('OfficialsConsole', { id })} style={{ minHeight: 56 }} /> : null}
        <Btn title="📝 Result & sign-off (score sheet)" color={c.violet} onPress={() => go('ScoreSheet', { id })} style={{ minHeight: 56 }} />
        <Btn title={t('or.file_report_btn')} color={c.paper} ink={c.ink} onPress={() => setRep(true)} style={{ minHeight: 56 }} />
        <Btn title={t('or.file_full_report_btn')} color={c.pinkSoft} ink={c.pink} onPress={() => go('OfficialReportWizard', { fixtureId: id })} style={{ minHeight: 56 }} />
        <T size={12} color={c.mute}>Scoring, fouls, cards and substitutions are recorded in the live console; undo is an audited correction, and taps are safe to repeat after a lost connection. The result is not official until the score sheet is signed, approved and published. Disputes and appeals go through Support, linked to this match.</T>
      </View>
    </Section>
  );
  const mine = reports.data ?? [];
  return (
    <Screen onRefresh={() => { q.reload(); reports.reload(); }} refreshing={q.loading}>
      <H1>Match briefing</H1>
      {matchInfo}
      <View style={{ height: 12 }} />
      {L.tablet ? <Cols a={<>{checks}{actions}</>} b={<>{crew}<FixtureParaSummary fixtureId={id} />{rulesCard}{lineups}</>} /> : <>{checks}{actions}{crew}<FixtureParaSummary fixtureId={id} />{rulesCard}{lineups}</>}
      {(due.data ?? []).filter((x) => x.fixture_id === id).length ? (
        <Section title="Give feedback on the officials" color={c.sun}>
          <View style={{ gap: 8 }}>{(due.data ?? []).filter((x) => x.fixture_id === id).map((x) => <Card key={x.official_assignment_id} pad={14}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{x.official_name}</T>{roleTag(x.role)}</View><Btn small title="Rate" onPress={() => setRate(x)} style={{ minHeight: 44 }} /></View></Card>)}</View>
          <T size={12} color={c.mute}>Five fixed criteria, no overall score. The official sees the averages and your comment without your name, once at least three people have answered.</T>
        </Section>
      ) : null}
      <Section title={t('or.section_title')} color={c.violet}>
        {mine.length ? (
          <View style={{ gap: 8 }}>
            {mine.map((r) => (
              <Card key={r.id} pad={14} onPress={() => go('OfficialReportDetail', { id: r.id })}>
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <ReportStatusTag status={r.status} />
                    {r.status === 'co_signing' ? <Tag label={t('or.needs_cosign')} color={c.sunSoft} /> : null}
                    {r.status === 'queried' ? <Tag label={t('or.queried_action')} color={c.redSoft} /> : null}
                  </View>
                  <T weight="800">{REPORT_TYPES.find((tp) => tp.value === r.category)?.label ?? r.category}</T>
                  <T size={13}>{r.summary}</T>
                  <T size={11.5} color={c.mute}>{r.author_name} · {t('or.revision')} {r.revision}</T>
                  <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                    <Btn small title={t('or.view')} onPress={() => go('OfficialReportDetail', { id: r.id })} style={{ minHeight: 44 }} />
                    {!r.locked && r.author_id === b?.my_role ? <Btn small title={t('or.submit_btn')} color={c.pink} onPress={() => go('OfficialReportWizard', { fixtureId: id, reportId: r.id })} style={{ minHeight: 44 }} /> : null}
                    {r.submitted_hash ? <Btn small title={t('or.provenance')} color={c.pinkSoft} onPress={() => go('OfficialReportProvenance', { id: r.id })} style={{ minHeight: 44 }} /> : null}
                  </View>
                </View>
              </Card>
            ))}
          </View>
        ) : <Empty emoji="🗒️" title={t('or.no_reports')} />}
      </Section>
      <FormSheet visible={rep} onClose={() => setRep(false)} title="Official report" submitLabel="File report" onSubmit={async (v) => {
        await api.post(`/fixtures/${id}/reports`, { category: v.category, summary: v.summary, note: v.note || undefined, visibility: v.visibility });
        toast('Report filed. The organiser has been told one exists.'); setRep(false); reports.reload();
      }} notice="Operational facts only: what happened and who was involved. Do not record medical detail; clinical information is never stored in a report."
        fields={[{ key: 'category', label: 'Type', type: 'chips', options: REPORT_TYPES }, { key: 'summary', label: 'One-line summary', type: 'text' }, { key: 'note', label: 'Details (kept encrypted)', type: 'multiline', optional: true },
          { key: 'visibility', label: 'Who can read the details', type: 'choice', options: [{ value: 'organiser', label: 'Organiser' }, { value: 'author', label: 'Only me' }] }]}
        initial={{ category: 'match_report', visibility: 'organiser' }} />
      <FormSheet visible={!!fee} onClose={() => setFee(null)} title={`Fee for ${fee?.display_name ?? ''}`} submitLabel="Save" notice="This records the agreed fee. Mark it due and the platform team pays it in a payout; it shows as paid once the payout is recorded."
        onSubmit={async (v) => { try { await api.post(`/official-assignments/${fee.id}/fee`, { fee_minor: v.fee, currency: v.currency, status: v.status, note: v.note || undefined }); toast('Fee recorded'); setFee(null); await q.reload(); } catch (e) { toast(explain(e)); throw e; } }}
        fields={[{ key: 'fee', label: 'Fee', type: 'money', currency: (v) => v.currency }, { key: 'currency', label: 'Currency', type: 'currency' }, { key: 'status', label: 'Status', type: 'choice', options: [{ value: 'agreed', label: 'Agreed' }, { value: 'due', label: 'Due (the platform team pays it)' }] }, { key: 'note', label: 'Note (optional)', optional: true }]}
        initial={{ fee: fee?.fee_minor ?? '', currency: fee?.fee_currency ?? undefined, status: fee?.pay_status && fee.pay_status !== 'none' && fee.pay_status !== 'disputed' ? fee.pay_status : 'agreed' }} />
      <FormSheet visible={!!rate} onClose={() => setRate(null)} title={`Feedback on ${rate?.official_name ?? ''}`} submitLabel="Send feedback"
        onSubmit={async (v) => { try { await api.post(`/official-assignments/${rate.official_assignment_id}/feedback`, { ratings: { communication: v.communication, consistency: v.consistency, game_control: v.game_control, positioning_fitness: v.positioning_fitness, conduct: v.conduct }, comment: v.comment || undefined }); toast('Thank you. Your feedback was recorded.'); setRate(null); await due.reload(); } catch (e) { toast(explain(e)); throw e; } }}
        fields={[['communication', 'Communication'], ['consistency', 'Consistency'], ['game_control', 'Game control'], ['positioning_fitness', 'Positioning and fitness'], ['conduct', 'Professional conduct']].map(([key, label]) => ({ key, label: `${label} (1 to 5)`, type: 'stepper', min: 1, max: 5, default: 3 })).concat([{ key: 'comment', label: 'Comment (optional, kept encrypted)', type: 'multiline', optional: true }])} initial={{ communication: 3, consistency: 3, game_control: 3, positioning_fitness: 3, conduct: 3 }} />
      <Sheet visible={rules} onClose={() => setRules(false)} title="Ask the rules"><AskRules fixtureId={id} sport={b.sport.slug} /></Sheet>
    </Screen>
  );
}

function Lineup({ side, name, youth }) {
  return (
    <Card><View style={{ gap: 4 }}>
      <T weight="800">{name ?? 'TBD'}</T>
      {!side ? <T size={13} color={c.mute}>Team not decided yet.</T> : !side.declared ? <T size={13} color={c.mute}>No line-up declared yet.</T>
        : youth ? <T size={13} color={c.mute}>{side.count} players declared. Names are hidden for youth events.</T>
        : side.players.map((p, i) => <T key={i} size={13.5}>{p.name}{p.status === 'unused_sub' || p.status === 'substitute_on' ? <T size={12} color={c.mute}> · sub</T> : null}</T>)}
    </View></Card>
  );
}

// ------------------------------------------------------------------ event settings (organiser): who may officiate, and whose logo heads the closure reports
const POLICY = [{ value: 'optional', label: 'Anyone with a referee profile' }, { value: 'verified', label: 'Verified officials only' }, { value: 'licensed', label: 'Federation-licensed officials only' }];
export function EventOfficialsSettings({ e, reload }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const kits = useLoad(() => api.get('/brand-kits').catch(() => []), []);
  const withLogo = (kits.data ?? []).filter((k) => k.logo_asset_id && !k.archived_at);
  const kit = withLogo.find((k) => k.id === e.brand_kit_id);
  return (
    <Section title="Officials & report branding" color={c.violet} action="Edit" onAction={() => setOpen(true)}>
      <Card><View style={{ gap: 4 }}>
        <T>🏅 Who may officiate: <T weight="800">{POLICY.find((p) => p.value === (e.official_policy ?? 'optional'))?.label}</T>{e.official_policy === 'licensed' && e.official_min_grade_rank ? <T> · grade rank {e.official_min_grade_rank}+</T> : null}</T>
        <T>🖼️ Logo on referee reports: <T weight="800">{kit ? (kit.display_name ?? kit.name) : 'none chosen'}</T></T>
        <T size={12} color={c.mute}>The rule is enforced by the server whenever someone is asked to officiate. The organisation's own logo is added automatically when the event belongs to an organisation with a brand kit.</T>
      </View></Card>
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Officials & report branding"
        onSubmit={async (v) => { try { await api.patch(`/events/${e.id}`, { official_policy: v.policy, official_min_grade_rank: v.policy === 'licensed' ? v.rank : 0, brand_kit_id: v.kit || null }); toast('Saved'); setOpen(false); await reload?.(); } catch (x) { toast(explain(x)); throw x; } }}
        fields={[{ key: 'policy', label: 'Who may be assigned as an official', type: 'chips', options: POLICY }, { key: 'rank', label: 'Minimum licence grade rank', type: 'stepper', min: 0, max: 20, default: 0, show: (v) => v.policy === 'licensed' },
          { key: 'kit', label: 'Logo on referee reports (a brand kit with a logo)', type: 'chips', optional: true, options: [{ value: '', label: 'None' }, ...withLogo.map((k) => ({ value: k.id, label: k.display_name ?? k.name }))] }]}
        initial={{ policy: e.official_policy ?? 'optional', rank: e.official_min_grade_rank ?? 0, kit: e.brand_kit_id ?? '' }} />
    </Section>
  );
}
