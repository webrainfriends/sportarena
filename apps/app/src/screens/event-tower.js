import React from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { usePoll } from '../live';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { MenuField } from '../menu-field';
import { Btn, Card, ErrorBox, Loading, T, Tag } from '../ui';
import { c, day, money } from '../theme';
import { t } from '../i18n';

// The Event Control Tower (landing page of a person working as an event manager). Everything on it is read from one capability,
// GET /events/:id/control-tower, which composes the modules that already own the data; this file only lays it out. Cards the caller may not
// see come back as { available: false } and are simply not drawn. The API orders the cards for the event's phase (before, during, after).
// Text is built from the structured kinds the API returns, so every language pack renders it.
const SEV = { critical: c.red, high: c.sun, medium: c.cyan, low: c.mute };
const ok = (x) => !!x && x.available !== false;
const n0 = (x) => Number(x ?? 0);

/** Card shell: icon + title, optional status tag, content, and a footer link that opens where the card is worked. */
function Cd({ icon, title, tag, tagColor, onPress, cta, children, wide, cols }) {
  const w = wide ? '100%' : cols === 3 ? '32%' : cols === 2 ? '48.5%' : '100%';
  return (
    <View style={{ width: w, flexGrow: 1 }}>
      <Card onPress={onPress} pad={16} accessibilityLabel={`${title}${tag ? `. ${tag}` : ''}`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 }}>
          <T size={20} accessibilityElementsHidden importantForAccessibility="no">{icon}</T>
          <T weight="800" size={14} style={{ flex: 1, letterSpacing: 0.3 }} accessibilityRole="header">{String(title).toUpperCase()}</T>
          {tag ? <Tag label={tag} color={tagColor} /> : null}
        </View>
        <View style={{ marginTop: 10, gap: 8 }}>{children}</View>
        {cta ? <T weight="700" size={13} color={c.pink} style={{ marginTop: 12 }}>{cta}  ›</T> : null}
      </Card>
    </View>
  );
}

const Row = ({ label, value, color, strong }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 }}>
    <T size={13} color={c.mute} style={{ flex: 1 }} numberOfLines={2}>{label}</T>
    <T size={14} weight={strong ? '800' : '700'} color={color ?? c.ink}>{value}</T>
  </View>
);
const Big = ({ value, sub, color }) => (
  <View>
    <T size={34} weight="800" color={color ?? c.ink} style={{ letterSpacing: -1 }}>{value}</T>
    {sub ? <T size={13} color={c.mute}>{sub}</T> : null}
  </View>
);
const Bar = ({ pct, color = c.pink }) => (
  <View accessibilityElementsHidden importantForAccessibility="no" style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
    <View style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, height: 8, backgroundColor: color }} />
  </View>
);
const Dot = ({ color }) => <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />;
const Empty = ({ text }) => <T size={13} color={c.mute}>{text}</T>;

/** The lifecycle rail: Setup, Registration, Event day, Close. */
function Rail({ steps, index, paused }) {
  return (
    <View accessible accessibilityLabel={steps.map((s, i) => `${t(`tw.stage.${s}`)}${i < index ? '' : i === index ? ` (${paused ? t('tw.st.paused') : t('tw.now')})` : ''}`).join(', ')} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <React.Fragment key={s}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: i === index ? c.pink : c.paper, borderWidth: 1, borderColor: i === index ? c.pink : c.line }}>
            <T size={12} weight="800" color={i === index ? c.onAccent : i < index ? c.lime : c.mute}>{i < index ? '✓' : i === index ? '●' : '○'}</T>
            <T size={12} weight="700" color={i === index ? c.onAccent : i < index ? c.ink : c.mute}>{t(`tw.stage.${s}`)}</T>
          </View>
          {i < steps.length - 1 ? <View style={{ width: 12, height: 2, borderRadius: 1, backgroundColor: i < index ? c.lime : c.line }} /> : null}
        </React.Fragment>
      ))}
    </View>
  );
}

const dayCount = (n) => (n == null ? null : n > 0 ? t('tw.d_togo', { n }) : n === 0 ? t('tw.d_today') : null);
const STATUS_TAG = { draft: c.violetSoft, open: c.mint, ongoing: c.red, paused: c.sun, completed: c.violetSoft, cancelled: c.violetSoft };

// ---------------------------------------------------------------------------------------------------------------- cards
function Readiness({ d, open, setup, cols, busy }) {
  if (!ok(d)) return null;
  const go = (fix) => open(fix ?? { tab: 'operations', sub: 'readiness' });
  if (d.needs_setup) {
    return (
      <Cd icon="🎯" title={t('tw.c.readiness')} cols={cols} wide>
        <T weight="700">{t('tw.setup_title')}</T>
        <Empty text={t('tw.setup_sub')} />
        <Btn small title={t('tw.setup_btn')} onPress={setup} loading={busy} style={{ alignSelf: 'flex-start' }} />
      </Cd>
    );
  }
  const col = d.critical ? c.red : d.due_soon ? c.sun : c.lime;
  return (
    <Cd icon="🎯" title={t('tw.c.readiness')} cols={cols} onPress={() => go(d.top_blocker?.fix)} cta={d.blocker_count ? t('tw.view_actions', { n: d.blocker_count }) : undefined}>
      <Big value={`${d.percent}%`} sub={t('tw.ready_sub', { met: d.met, total: d.total })} color={col} />
      <Bar pct={d.percent} color={col} />
      <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
        {d.critical ? <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><Dot color={c.red} /><T size={13} weight="700">{t('tw.critical_n', { n: d.critical })}</T></View> : null}
        {d.due_soon ? <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><Dot color={c.sun} /><T size={13} weight="700">{t('tw.soon_n', { n: d.due_soon })}</T></View> : null}
      </View>
      {d.top_blocker ? <View><T size={11} weight="700" color={c.mute}>{t('tw.top_blocker').toUpperCase()}</T><T size={14} weight="700">{d.top_blocker.title}</T></View> : <T size={13} weight="700" color={c.lime}>{t('tw.all_ready')}</T>}
      {d.next_due ? <View><T size={11} weight="700" color={c.mute}>{t('tw.next_due').toUpperCase()}</T><T size={13}>{d.next_due.title} · {day(d.next_due.due_on)}</T></View> : null}
    </Cd>
  );
}

function Attention({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="🚨" title={t('tw.c.attention')} cols={cols} tag={d.critical ? t('tw.critical_n', { n: d.critical }) : undefined} tagColor={c.sun}>
      {d.items.length ? (
        <>
          <Big value={d.total} sub={t('tw.att_n', { n: d.total })} color={d.critical ? c.red : c.ink} />
          {d.items.map((a, i) => (
            <Pressable key={`${a.kind}${i}`} onPress={() => open(a.fix)} accessibilityRole="button" accessibilityLabel={`${a.kind === 'requirement' ? a.title : t(`tw.k.${a.kind}`)}${a.kind === 'requirement' ? '' : `: ${a.n}`}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
              <Dot color={SEV[a.severity] ?? c.mute} />
              <T size={13.5} style={{ flex: 1 }} numberOfLines={2}>{a.kind === 'requirement' ? a.title : t(`tw.k.${a.kind}`)}</T>
              {a.kind === 'requirement' ? null : <T weight="800" size={14} color={SEV[a.severity]}>{a.n}</T>}
              <T color={c.pink} weight="700" accessibilityElementsHidden>›</T>
            </Pressable>
          ))}
        </>
      ) : <><T size={26}>✅</T><T weight="700">{t('tw.att_none')}</T></>}
    </Cd>
  );
}

function TodayNext({ d, open, cols }) {
  const live = d.live_count > 0;
  const m = d.milestone;
  const mText = m && (m.kind === 'requirement_due' ? m.title : t(`tw.m.${m.kind}`));
  return (
    <Cd icon="🗓️" title={t('tw.c.today_next')} cols={cols} tag={live ? t('tw.live_now', { n: d.live_count }) : undefined} tagColor={c.sun} onPress={() => open({ tab: 'games' })}>
      {live ? d.live.map((g) => <View key={g.id}><T weight="700">{g.home} {t('tw.vs')} {g.away}</T>{g.round_kind ? <T size={12} color={c.mute}>{g.round_kind}</T> : null}</View>) : null}
      {d.next ? (
        <View><T size={11} weight="700" color={c.mute}>{t('tw.up_next').toUpperCase()}</T><T weight="700">{d.next.home} {t('tw.vs')} {d.next.away}</T><T size={12.5} color={c.mute}>{new Date(d.next.scheduled_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</T></View>
      ) : null}
      {m ? (
        <View><T size={11} weight="700" color={c.mute}>{t('tw.next_milestone').toUpperCase()}</T><T weight="700">{mText}</T><T size={12.5} color={c.mute}>{day(m.at)} · {m.days === 0 ? t('tw.d_today') : t('tw.in_n_days', { n: m.days })}</T></View>
      ) : null}
      {d.deadlines_this_week > 1 ? <T size={12.5} color={c.mute}>{t('tw.deadlines_week', { n: d.deadlines_this_week })}</T> : null}
      {!live && !d.next && !m ? <Empty text={t('tw.no_schedule')} /> : null}
    </Cd>
  );
}

function Operations({ d, open, cols, wide }) {
  if (!ok(d)) return null;
  const tone = { normal: c.lime, attention: c.sun, critical: c.red, paused: c.sun }[d.state];
  const idle = d.event.status === 'draft' || d.event.status === 'open';
  return (
    <Cd icon="📟" title={t('tw.c.operations')} cols={cols} wide={wide} tag={idle ? t('tw.op.idle') : t(`tw.op.${d.state}`)} tagColor={tone === c.red ? c.orange : c.sun} onPress={() => open({ tab: 'operations' })} cta={t('tw.open_ops')}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 6 }}>
        {[
          ['🔴', t('tw.m_live'), d.games.live], ['⏭️', t('tw.m_remaining'), d.remaining], ['🚨', t('tw.k.incident'), d.incidents.open],
          ['🎫', t('tw.m_checkedin'), d.access.checked_in], ['⛔', t('tw.m_refused'), d.access.refused], ['🧱', t('tw.k.task_blocked'), d.tasks.blocked],
          ['⏰', t('tw.k.task_overdue'), d.tasks.overdue], ['🧩', t('tw.m_crew'), d.crew.active],
        ].map(([ic, label, v]) => (
          <View key={label} accessible accessibilityLabel={`${label}: ${v}`} style={{ minWidth: 170, flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
            <T size={16}>{ic}</T><T size={13} color={c.mute} style={{ flex: 1 }} numberOfLines={2}>{label}</T><T weight="800">{v}</T>
          </View>
        ))}
      </View>
    </Cd>
  );
}

function People({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="👥" title={t('tw.c.participants')} cols={cols} onPress={() => open({ tab: d.entries.pending ? 'teams' : 'registration' })} cta={d.entries.pending + d.registrations.pending ? t('tw.review_pending') : undefined}>
      <View style={{ flexDirection: 'row', gap: 20 }}><Big value={d.teams} sub={t('tw.p_teams')} /><Big value={d.athletes} sub={t('tw.p_athletes')} /></View>
      <Row label={t('tw.p_confirmed')} value={d.registrations.confirmed} />
      <Row label={t('tw.p_pending')} value={d.entries.pending + d.registrations.pending} color={d.entries.pending + d.registrations.pending ? c.sun : undefined} />
      <Row label={t('tw.p_invites')} value={d.invitations.waiting} />
      {d.accreditation ? <Row label={t('tw.p_accredited')} value={`${d.accreditation.approved} · ${t('tw.p_acc_pending')} ${d.accreditation.pending}`} /> : null}
    </Cd>
  );
}

function Finance({ d, open, cols }) {
  if (!ok(d)) return null;
  const m = (x) => money(x, d.currency);
  return (
    <Cd icon="💰" title={t('tw.c.finance')} cols={cols} onPress={() => open({ tab: 'business', sub: 'budget' })}>
      <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        <Big value={m(d.income_cents)} sub={t('tw.f_income')} color={c.lime} />
        <Big value={m(d.cost_cents)} sub={t('tw.f_cost')} />
        <Big value={m(d.net_cents)} sub={t('tw.f_net')} color={d.net_cents < 0 ? c.red : c.ink} />
      </View>
      <Row label={`🎟️ ${t('tw.f_entry')}`} value={m(d.split.entry_cents)} />
      <Row label={`💎 ${t('tw.f_sponsors')}`} value={m(d.split.sponsor_cents)} />
      <Row label={`🛍️ ${t('tw.f_vendors')}`} value={m(d.split.vendor_cents)} />
      {d.budget_used_pct != null ? <><Bar pct={d.budget_used_pct} color={d.budget_used_pct > 90 ? c.red : c.pink} /><T size={12.5} color={c.mute}>{t('tw.f_budget', { pct: Math.round(d.budget_used_pct) })}</T></> : null}
    </Cd>
  );
}

function Venue({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="🏟️" title={t('tw.c.venue')} cols={cols} onPress={() => open({ tab: 'venue' })} cta={t('tw.open_venue')} tag={d.issues.length ? t('tw.v_issues') : undefined} tagColor={c.sun}>
      {d.venues ? (
        <>
          <View style={{ flexDirection: 'row', gap: 20 }}><Big value={d.venues} sub={t('tw.v_venues')} /><Big value={d.areas} sub={t('tw.v_areas')} /></View>
          <Row label={t('tw.v_bookings')} value={d.bookings} />
          {d.pending_requests ? <Row label={t('tw.v_requests')} value={d.pending_requests} color={c.sun} /> : null}
          {d.issues.slice(0, 2).map((x) => <T key={x.title} size={13} color={c.sun}>⚠ {x.title}</T>)}
          {d.next_booking ? <View><T size={11} weight="700" color={c.mute}>{t('tw.v_next').toUpperCase()}</T><T size={13}>{d.next_booking.resource} · {new Date(d.next_booking.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</T></View> : null}
        </>
      ) : <Empty text={t('tw.v_none')} />}
    </Cd>
  );
}

function Workforce({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="🧩" title={t('tw.c.workforce')} cols={cols} onPress={() => open({ tab: 'people', sub: d.open_positions ? 'hiring' : 'departments' })} cta={t('tw.manage_workforce')}>
      <Big value={d.departments} sub={t('tw.w_depts')} />
      <Row label={t('tw.w_staff')} value={`${d.filled} / ${d.needed}`} />
      {d.needed ? <Bar pct={(d.filled / d.needed) * 100} color={c.mint} /> : null}
      <Row label={t('tw.w_officials')} value={d.officials.confirmed} />
      <Row label={t('tw.w_open')} value={d.open_positions} color={d.open_positions ? c.sun : undefined} />
      {d.applicants ? <Row label={t('tw.w_applicants')} value={d.applicants} /> : null}
      {d.most_urgent ? <T size={13} color={c.sun}>⚠ {d.most_urgent.title} · {t('tw.w_urgent', { n: d.most_urgent.open })}</T> : null}
    </Cd>
  );
}

function Tickets({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="🎟️" title={t('tw.c.tickets')} cols={cols} onPress={() => open({ tab: 'tickets' })}>
      <Big value={d.sold} sub={t('tw.t_sold')} />
      <Row label={t('tw.t_scanned')} value={d.scanned_in} />
      <Row label={t('tw.t_refunded')} value={d.refunded} />
      <Row label={t('tw.m_checkedin')} value={d.checked_in_crew} />
      <Row label={t('tw.m_refused')} value={d.refused} color={d.refused ? c.sun : undefined} />
    </Cd>
  );
}

function Commercial({ d, open, cols, currency }) {
  if (!ok(d)) return null;
  const inv = d.inventory;
  return (
    <Cd icon="🤝" title={t('tw.c.commercial')} cols={cols} onPress={() => open({ tab: 'business', sub: 'partners' })} cta={t('tw.c_manage')}>
      <Big value={money(d.sponsors.value_cents, currency)} sub={t('tw.c_value')} />
      <Row label={t('tw.c_sponsors')} value={d.sponsors.active} />
      {d.sponsors.awaiting ? <Row label={t('tw.c_awaiting')} value={d.sponsors.awaiting} color={c.sun} /> : null}
      <Row label={t('tw.c_vendors')} value={`${d.vendors.accepted}${d.vendors.invited ? ` · ${t('tw.c_invited')} ${d.vendors.invited}` : ''}`} />
      {inv ? <><Row label={t('tw.c_inventory')} value={`${inv.allocated} / ${inv.total}`} />{inv.total ? <Bar pct={(inv.allocated / inv.total) * 100} color={c.cyan} /> : null}</> : null}
    </Cd>
  );
}

function Procurement({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="📋" title={t('tw.c.procurement')} cols={cols} onPress={() => open({ tab: 'business', sub: 'services' })}>
      {d.active || d.awarded ? (
        <>
          <View style={{ flexDirection: 'row', gap: 20 }}><Big value={d.active} sub={t('tw.pr_active')} /><Big value={d.proposals} sub={t('tw.pr_proposals')} /></View>
          {d.awaiting_evaluation ? <Row label={t('tw.pr_eval')} value={d.awaiting_evaluation} color={c.sun} /> : null}
          {d.closing_soon ? <Row label={t('tw.pr_closing')} value={d.closing_soon} color={c.sun} /> : null}
          <Row label={t('tw.pr_awarded')} value={d.awarded} />
          {d.latest.map((p) => <T key={p.id} size={12.5} color={c.mute} numberOfLines={1}>{p.title} · {t('tw.pr_n', { n: p.proposals })}</T>)}
        </>
      ) : <Empty text={t('tw.pr_none')} />}
    </Cd>
  );
}

function Compliance({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="🛡️" title={t('tw.c.compliance')} cols={cols} onPress={() => open({ tab: 'compliance' })} cta={d.actions ? t('tw.co_actions', { n: d.actions }) : undefined}>
      {d.total ? (
        <>
          <Big value={`${d.percent}%`} sub={t('tw.co_pct', { pct: d.percent })} color={d.counts.blocked ? c.red : d.actions ? c.sun : c.lime} />
          <Bar pct={d.percent} color={d.counts.blocked ? c.red : c.lime} />
          {d.items.map((x, i) => <View key={`${x.title}${i}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Dot color={x.blocking ? c.red : c.sun} /><T size={13} style={{ flex: 1 }} numberOfLines={1}>{x.title}</T></View>)}
          {!d.actions ? <T size={13} weight="700" color={c.lime}>{t('tw.co_clear')}</T> : null}
        </>
      ) : <Empty text={t('tw.co_none')} />}
    </Cd>
  );
}

function Media({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="📣" title={t('tw.c.media')} cols={cols} onPress={() => open({ tab: d.published ? 'broadcast' : 'public' })}>
      <Row label={`🌐 ${t('tw.me_public')}`} value={d.published ? t('tw.me_published') : t('tw.me_unpublished')} color={d.published ? c.lime : c.sun} />
      <Row label={`📡 ${t('tw.me_streams')}`} value={d.streams} />
      {d.live_streams ? <Row label={t('tw.me_live')} value={d.live_streams} color={c.red} /> : null}
    </Cd>
  );
}

function Travel({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="🚌" title={t('tw.c.travel')} cols={cols} onPress={() => open({ tab: 'travel' })}>
      <Row label={t('tw.tr_trips')} value={d.trips} />
      <Row label={t('tw.tr_issues')} value={d.open_issues} color={d.open_issues ? c.sun : undefined} />
    </Cd>
  );
}

function Results({ d, open, cols }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="🏆" title={t('tw.c.results')} cols={cols} onPress={() => open({ tab: 'results' })}>
      <Big value={d.completed} sub={t('tw.r_done', { n: d.total })} />
      {d.total ? <Bar pct={(d.completed / d.total) * 100} color={c.lime} /> : null}
      <Row label={t('tw.m_remaining')} value={d.remaining} />
      {d.awaiting_confirmation ? <Row label={t('tw.r_confirm')} value={d.awaiting_confirmation} color={c.sun} /> : null}
    </Cd>
  );
}

function AI({ d, open, onPlan }) {
  if (!ok(d)) return null;
  return (
    <Cd icon="🤖" title={t('tw.c.ai')} wide tag={d.total ? String(d.total) : undefined} tagColor={c.sun}>
      <T weight="700">{d.total ? t('tw.ai_n', { n: d.total }) : t('tw.ai_none')}</T>
      {d.recommendations.map((r, i) => (
        <Pressable key={`${r.kind}${i}`} onPress={() => open(r.fix)} accessibilityRole="button" accessibilityLabel={t(`tw.ai.${r.kind}`, r.params)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', minHeight: 44 }}>
          <Dot color={SEV[r.severity] ?? c.mute} /><T size={13.5} style={{ flex: 1 }}>{t(`tw.ai.${r.kind}`, r.params)}</T><T color={c.pink} weight="700" accessibilityElementsHidden>›</T>
        </Pressable>
      ))}
      {d.can_plan && onPlan ? <Btn small title={t('tw.ai_plan')} onPress={onPlan} style={{ alignSelf: 'flex-start', marginTop: 4 }} /> : null}
    </Cd>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the tower
/**
 * One event's control tower. `onOpen({tab, sub})` opens the console tab that owns a card; `onPlan` starts the (user-triggered) AI plan.
 * `embedded` drops the header (the console draws its own hero and lifecycle controls).
 */
export function EventTower({ id, onOpen, onPlan, onPreview, onCommand, embedded }) {
  const { width } = useLayout();
  const { toast } = useSession();
  const tw = useLoad(() => api.get(`/events/${id}/control-tower`), [id]);
  const [busy, setBusy] = React.useState(false);
  const live = tw.data?.phase === 'during';
  usePoll(() => { if (live) tw.reload(); }, 15000);
  if (tw.error && !tw.data) return <ErrorBox error={tw.error} onRetry={tw.reload} />;
  if (!tw.data) return <Loading />;
  const d = tw.data, k = d.cards, e = d.event;
  const cols = width >= 1100 ? 3 : width >= 700 ? 2 : 1;
  const setup = async () => { setBusy(true); try { await api.post(`/events/${id}/ops/requirements/standard`, {}); tw.reload(); } catch (x) { toast(`${x.message}`); } finally { setBusy(false); } };
  const open = (fix) => onOpen?.(fix ?? { tab: 'operations' });
  const render = {
    readiness: () => <Readiness key="readiness" d={k.readiness} open={open} setup={setup} busy={busy} cols={cols} />,
    attention: () => <Attention key="attention" d={k.attention} open={open} cols={cols} />,
    today_next: () => <TodayNext key="today_next" d={k.today_next} open={open} cols={cols} />,
    operations: () => <Operations key="operations" d={k.operations} open={open} cols={cols} wide={d.card_order[0] === 'operations'} />,
    participants: () => <People key="participants" d={k.participants} open={open} cols={cols} />,
    finance: () => <Finance key="finance" d={k.finance} open={open} cols={cols} />,
    venue: () => <Venue key="venue" d={k.venue} open={open} cols={cols} />,
    workforce: () => <Workforce key="workforce" d={k.workforce} open={open} cols={cols} />,
    tickets: () => <Tickets key="tickets" d={k.tickets} open={open} cols={cols} />,
    commercial: () => <Commercial key="commercial" d={k.commercial} open={open} cols={cols} currency={e.currency} />,
    procurement: () => <Procurement key="procurement" d={k.procurement} open={open} cols={cols} />,
    compliance: () => <Compliance key="compliance" d={k.compliance} open={open} cols={cols} />,
    media: () => <Media key="media" d={k.media} open={open} cols={cols} />,
    travel: () => <Travel key="travel" d={k.travel} open={open} cols={cols} />,
    results: () => <Results key="results" d={k.results} open={open} cols={cols} />,
    ai: () => <AI key="ai" d={k.ai} open={open} onPlan={onPlan} />,
  };
  const left = dayCount(e.days_to_go);
  return (
    <View style={{ gap: 14 }}>
      {embedded ? null : (
        <Card pad={18}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <T size={34} accessibilityElementsHidden>{e.emoji ?? '🏆'}</T>
            <View style={{ flex: 1 }}>
              <T size={22} weight="800" style={{ letterSpacing: -0.6 }} accessibilityRole="header">{e.name}</T>
              <T size={13} color={c.mute}>{[e.starts_on ? `${day(e.starts_on)}${e.ends_on && e.ends_on !== e.starts_on ? ` – ${day(e.ends_on)}` : ''}` : null, e.city, e.sport].filter(Boolean).join(' · ')}</T>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <Tag label={t(`tw.st.${e.status}`)} color={STATUS_TAG[e.status]} />
            {left ? <T size={13} weight="700" color={c.mute}>{left}</T> : null}
            {e.paused && e.pause_reason ? <T size={13} color={c.sun}>⏸ {e.pause_reason}</T> : null}
          </View>
          <View style={{ marginTop: 12 }}><Rail steps={d.stage.steps} index={d.stage.index} paused={d.stage.paused} /></View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <Btn small title={t('tw.open_command')} onPress={onCommand} />
            {d.access.organiser ? <Btn small color={c.paper} ink={c.ink} title={t('tw.preview_public')} onPress={onPreview} /> : null}
          </View>
        </Card>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' }}>
        {d.card_order.map((key) => render[key]?.())}
      </View>
    </View>
  );
}

/** Headline strip over several events: how many need attention, start within 7 days, are on track. */
export function EventsStrip({ tower }) {
  if (!tower) return null;
  const Cell = ({ n, label, color }) => (
    <View accessible accessibilityLabel={`${label}: ${n}`} style={{ flex: 1, minHeight: 64, backgroundColor: c.paper, borderRadius: 16, borderWidth: 1, borderColor: c.line, padding: 12, justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Dot color={color} /><T size={24} weight="800">{n}</T></View>
      <T size={12} weight="700" color={c.mute} numberOfLines={2}>{label}</T>
    </View>
  );
  return (
    <View style={{ gap: 10 }}>
      <T weight="800" size={18} accessibilityRole="header">{t('tw.manage_n', { n: tower.total })}</T>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Cell n={tower.attention} label={t('tw.b_attention')} color={c.red} />
        <Cell n={tower.starting_soon} label={t('tw.b_soon')} color={c.sun} />
        <Cell n={tower.on_track} label={t('tw.b_ok')} color={c.lime} />
      </View>
    </View>
  );
}

const BUCKET = { attention: [c.red, 'tw.b_attention_one'], soon: [c.sun, 'tw.b_soon_one'], on_track: [c.lime, 'tw.b_ok_one'] };

/**
 * The landing page of the event role: the strip over all the events I run, a picker (searchable, the list can grow), the events that need me,
 * and the selected event's control tower. Tapping a card opens the console tab that owns it (deep link with tab and sub-tab).
 */
export function EventTowerHome({ tower, push, goTab }) {
  const evs = tower?.events ?? [];
  const [sel, setSel] = React.useState(null);
  if (!tower) return null;
  if (!evs.length) {
    return (
      <Card pad={20}>
        <T size={34}>🏆</T>
        <T size={18} weight="800" style={{ marginTop: 6 }}>{t('tw.empty_title')}</T>
        <T color={c.mute} style={{ marginTop: 4 }}>{t('tw.empty_sub')}</T>
        <Btn small title={t('tw.create')} onPress={() => goTab('Schedule', { section: 'manage' })} style={{ alignSelf: 'flex-start', marginTop: 14 }} />
      </Card>
    );
  }
  const cur = evs.find((e) => e.id === sel) ?? evs.find((e) => e.phase === 'during') ?? evs.find((e) => e.bucket === 'attention') ?? evs[0];
  const needs = evs.filter((e) => e.bucket !== 'on_track' && e.id !== cur.id).slice(0, 3);
  const open = (fix) => push('EventCommand', { id: cur.id, tab: fix?.tab ?? 'overview', sub: fix?.sub });
  return (
    <View style={{ gap: 14 }}>
      <EventsStrip tower={tower} />
      {evs.length > 1 ? (
        <MenuField title={t('tw.pick_event')} label={t('tw.pick_event')} value={cur.id} onChange={setSel}
          options={evs.map((e) => ({ value: e.id, label: `${e.emoji ?? '🏆'} ${e.name}`, sub: [t(`tw.st.${e.status}`), e.readiness_percent != null ? t('tw.ready_pct', { pct: e.readiness_percent }) : null, dayCount(e.days_to_go)].filter(Boolean).join(' · ') }))} />
      ) : null}
      {needs.map((e) => (
        <Card key={e.id} onPress={() => setSel(e.id)} pad={14} accessibilityLabel={`${e.name}. ${t(BUCKET[e.bucket][1])}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
            <Dot color={BUCKET[e.bucket][0]} />
            <View style={{ flex: 1 }}><T weight="700" numberOfLines={1}>{e.emoji ?? '🏆'} {e.name}</T><T size={12.5} color={c.mute}>{[t(BUCKET[e.bucket][1]), e.readiness_percent != null ? t('tw.ready_pct', { pct: e.readiness_percent }) : null, dayCount(e.days_to_go)].filter(Boolean).join(' · ')}</T></View>
            <T color={c.pink} weight="700" accessibilityElementsHidden>›</T>
          </View>
        </Card>
      ))}
      <EventTower key={cur.id} id={cur.id} onOpen={open} onCommand={() => open(null)} onPreview={() => push('Event', { id: cur.id })} onPlan={() => push('EventCommand', { id: cur.id, tab: 'overview', plan: true })} />
    </View>
  );
}
