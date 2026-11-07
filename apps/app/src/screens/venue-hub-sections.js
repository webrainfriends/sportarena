// The sections of the venue owner's home. Every number comes from GET /venues/:id/command-centre; a section with nothing yet shows
// what will appear there and the next action, never a made-up figure. Strings go through t(); colours are theme tokens only.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';
import { moneyIn } from '../vtime';
import { useLayout } from '../layout';
import { Kpi, Spark } from './academy-ui';

// singular forms live under <key>_one (repo convention); the plural text carries {n}
const tn = (key, n, params) => t(n === 1 ? `${key}_one` : key, { n, ...params });
const lab = (...parts) => parts.filter(Boolean).join('. ');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const clock = (iso, tz) => { try { return new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz }); } catch { return ''; } };
const dayName = (date) => { try { return new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' }); } catch { return date; } };
const weekdayName = (n) => dayName(new Date(Date.UTC(2024, 0, 7 + n)).toISOString().slice(0, 10));
const hourLabel = (h) => `${h}:00`;
const mm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const ONE = new Set(['maintenance_overdue', 'maintenance_urgent', 'compliance_expired', 'compliance_expiring', 'areas_not_ready', 'review_unanswered', 'coach_requests', 'rfq_decision', 'unpaid_bookings', 'staff_gap', 'event_not_ready']);
const SEV = { 0: [t('vh.sev.now'), c.orange], 1: [t('vh.sev.soon'), c.sun], 2: [t('vh.sev.watch'), c.cyan] };
const VERB = { maintenance_overdue: 'view', maintenance_urgent: 'view', compliance_expired: 'renew', compliance_expiring: 'renew', no_insurance: 'renew', areas_not_ready: 'view', review_unanswered: 'respond', coach_requests: 'review', rfq_decision: 'review', unpaid_bookings: 'collect', staff_gap: 'assign', refunds_owed: 'pay', event_not_ready: 'view' };
const STATE_TONE = { available: c.mint, occupied: c.pink, event: c.violet, blocked: c.sun, maintenance: c.orange };

/** Section frame: a title, an optional action and the body. Keeps every block aligned and labelled. */
export function Block({ title, action, onAction, children, tone }) {
  return (
    <View style={{ marginTop: 22 }} accessibilityRole="summary">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, minHeight: 32 }}>
        <T size={17} weight="800" style={{ flexShrink: 1 }} accessibilityRole="header">{title}</T>
        {action ? <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={action} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}><T size={13} weight="700" color={tone ?? c.pink}>{action}  ›</T></Pressable> : null}
      </View>
      {children}
    </View>
  );
}

const Stat = ({ label, value, sub, tone }) => (
  <View accessible accessibilityLabel={`${label}: ${value}${sub ? `. ${sub}` : ''}`} style={{ flexGrow: 1, flexBasis: 140, minWidth: 130, padding: 12, borderRadius: 14, backgroundColor: c.paper, borderWidth: 1, borderColor: tone === 'alert' ? c.orange : c.line }}>
    <T size={11} weight="800" color={c.mute}>{String(label).toUpperCase()}</T>
    <T size={22} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
    {sub ? <T size={12} color={c.mute}>{sub}</T> : null}
  </View>
);
const Wrap = ({ children, gap = 10 }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>{children}</View>;

/** The four numbers a manager checks first. */
export function KpiRow({ d, onActions }) {
  const k = d.kpis;
  return (
    <Wrap>
      <Kpi label={t('vh.kpi.revenue')} value={moneyIn(k.revenue_cents, k.currency)} sub={d.today?.pos_cents ? t('vh.kpi.revenue_pos', { amount: moneyIn(d.today.pos_cents, k.currency) }) : t('vh.kpi.revenue_sub')} />
      <Kpi label={t('vh.kpi.occupancy')} value={pct(k.occupancy_today)} sub={k.occupancy_now == null ? undefined : t('vh.kpi.occupancy_now', { pct: pct(k.occupancy_now) })} />
      <Kpi label={t('vh.kpi.bookings')} value={String(k.bookings)} sub={tn('vh.kpi.visitors', d.today?.expected_visitors ?? 0)} />
      <Kpi label={t('vh.kpi.actions')} value={String(k.actions_required)} sub={k.actions_required ? t('vh.kpi.actions_sub') : t('vh.kpi.actions_none')} tone={k.actions_required ? 'alert' : undefined} onPress={onActions} />
    </Wrap>
  );
}

const attText = (a) => (ONE.has(a.key) ? tn(`vh.att.${a.key}`, a.count) : t(`vh.att.${a.key}`, { n: a.count }));

export function AttentionList({ items, go, limit }) {
  const list = limit ? items.slice(0, limit) : items;
  if (!list.length) return <Empty emoji="✅" title={t('vh.att.none')} sub={t('vh.att.none_sub')} />;
  return (
    <View style={{ gap: 8 }}>
      {list.map((a) => {
        const [sev, tone] = SEV[a.severity] ?? SEV[2];
        const text = attText(a);
        const verb = t(`vh.act.${VERB[a.key] ?? 'view'}`);
        return (
          <Card key={a.key} pad={12} style={{ borderLeftWidth: 4, borderLeftColor: tone }} accessibilityLabel={lab(sev, text)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Tag label={sev} color={tone} />
              <T weight="700" style={{ flex: 1, minWidth: 160 }}>{text}</T>
              <Btn small title={verb} color={c.paper} onPress={() => go(a.action)} accessibilityLabel={lab(verb, text)} />
            </View>
          </Card>
        );
      })}
    </View>
  );
}

/** One top-level read of the day: what needs attention and what the numbers suggest, with a way to walk through it. */
export function AiManager({ d, onReview }) {
  const n = d.ai_manager.things_to_review;
  const lines = [...d.attention.slice(0, 3).map((a) => attText(a)), ...d.insights.slice(0, 2).map((x) => insightText(x))];
  return (
    <Card pad={16} style={{ borderColor: c.pink, borderWidth: 1 }} accessibilityLabel={n ? tn('vh.ai.title', n) : t('vh.ai.title_none')}>
      <T size={12} weight="800" color={c.pink}>{t('vh.ai.eyebrow').toUpperCase()}</T>
      <T size={20} weight="800" style={{ marginTop: 2 }}>{n ? tn('vh.ai.title', n) : t('vh.ai.title_none')}</T>
      {lines.length ? <View style={{ marginTop: 8, gap: 4 }}>{lines.map((l, i) => <T key={i} size={14} color={c.ink}>•  {l}</T>)}</View> : <T size={13} color={c.mute} style={{ marginTop: 6 }}>{t('vh.ai.quiet')}</T>}
      <View style={{ marginTop: 12, alignSelf: 'flex-start' }}><Btn small title={t('vh.ai.review')} onPress={onReview} /></View>
    </Card>
  );
}

export function insightText(x) {
  const p = { ...x.data };
  if (x.key === 'weekday_quiet') p.day = weekdayName(x.data.weekday);
  if (x.key === 'top_facility') p.amount = moneyIn(x.data.revenue_cents, x.data.currency);
  if (x.key === 'unmet_demand' && x.data.waiting === 1) return t('vh.ins.unmet_demand_one');
  return t(`vh.ins.${x.key}`, p);
}

/** The day as a timeline per facility: each bar is the venue's open hours, blocks are bookings, events, blocks and maintenance. */
export function FacilityTimeline({ d, go }) {
  const { tablet } = useLayout();
  const fac = d.facilities ?? [];
  if (!fac.length) return <Empty emoji="🏟️" title={t('vh.fac.none')} sub={t('vh.fac.none_sub')} />;
  const open = d.day_hours?.open_min ?? 360, close = d.day_hours?.close_min ?? 1320;
  const span = Math.max(60, close - open);
  const KIND = { booking: c.pink, event: c.violet, block: c.sun, maintenance: c.orange };
  const nowMin = (() => { const x = new Date(); return x.getHours() * 60 + x.getMinutes(); })();
  return (
    <View style={{ gap: 10 }}>
      {fac.map((f) => {
        const label = `${f.name}. ${t(`vh.state.${f.state}`)}${f.until ? `, ${t('vh.fac.until', { time: clock(f.until, d.venue.timezone) })}` : ''}`;
        return (
          <Card key={f.id} pad={12} accessibilityLabel={label} style={{ borderLeftWidth: 4, borderLeftColor: STATE_TONE[f.state] ?? c.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <T weight="800" style={{ flex: 1, minWidth: 120 }} numberOfLines={1}>{f.name}</T>
              <Tag label={t(`vh.state.${f.state}`)} color={STATE_TONE[f.state] ?? c.violetSoft} />
              {f.until ? <T size={12} color={c.mute}>{t('vh.fac.until', { time: clock(f.until, d.venue.timezone) })}</T> : f.next_at ? <T size={12} color={c.mute}>{t('vh.fac.next', { time: clock(f.next_at, d.venue.timezone) })}</T> : null}
            </View>
            <View accessible accessibilityRole="image" accessibilityLabel={`${f.name}: ${f.slots.map((s) => `${mm(s.from_min)}–${mm(s.to_min)} ${t(`vh.slot.${s.kind}`)}`).join(', ') || t('vh.fac.free_day')}`}
              style={{ height: 14, borderRadius: 7, backgroundColor: c.mintSoft, marginTop: 10, overflow: 'hidden' }}>
              {f.slots.map((s, i) => {
                const l = Math.max(0, (s.from_min - open) / span), w = Math.max(0.01, (Math.min(close, s.to_min) - Math.max(open, s.from_min)) / span);
                return <View key={i} style={{ position: 'absolute', start: `${l * 100}%`, width: `${Math.min(w, 1 - l) * 100}%`, top: 0, bottom: 0, backgroundColor: KIND[s.kind] ?? c.pink }} />;
              })}
              {nowMin >= open && nowMin <= close ? <View style={{ position: 'absolute', start: `${((nowMin - open) / span) * 100}%`, width: 2, top: 0, bottom: 0, backgroundColor: c.ink }} /> : null}
            </View>
          </Card>
        );
      })}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={11} color={c.mute}>{mm(open)}</T><T size={11} color={c.mute}>{mm(close)}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }} accessibilityLabel={t('vh.fac.legend')}>
        {Object.entries(KIND).map(([k, col]) => <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: col }} /><T size={11} color={c.mute}>{t(`vh.slot.${k}`)}</T></View>)}
      </View>
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 8 }}>
        <Btn small title={t('vh.fac.calendar')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'schedule' } })} />
        <Btn small title={t('vh.fac.block')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'blocks' } })} />
      </View>
    </View>
  );
}

function EventSheet({ ev, onClose }) {
  return (
    <Sheet visible={!!ev} onClose={onClose} title={ev?.name ?? ''}>
      {ev ? <View style={{ gap: 8 }}>
        <T color={c.mute}>{ev.starts_on}{ev.ends_on && ev.ends_on !== ev.starts_on ? ` → ${ev.ends_on}` : ''} · {tn('vh.ev.bookings', ev.bookings)}</T>
        <T weight="800">{t('vh.ev.ready', { pct: ev.complete_pct })}</T>
        {ev.checklist.map((x) => <T key={x.key} color={x.done ? c.mint : c.ink} accessibilityLabel={`${t(`vh.chk.${x.key}`)}: ${x.done ? t('vh.ev.done') : t('vh.ev.todo')}`}>{x.done ? '✓' : '○'}  {t(`vh.chk.${x.key}`)}</T>)}
      </View> : null}
    </Sheet>
  );
}

export function BookingsAndEvents({ d, go }) {
  const { tablet } = useLayout();
  const [open, setOpen] = useState(null);
  const up = d.upcoming ?? [], ev = d.events ?? [];
  return (
    <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
      <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', gap: 8 }}>
        <T weight="800" size={14} color={c.mute}>{t('vh.bk.title')}</T>
        {up.length ? up.map((b) => (
          <Card key={b.id} pad={12} accessibilityLabel={lab(clock(b.starts_at, d.venue.timezone), b.area, b.customer)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <T weight="800" style={{ minWidth: 64 }}>{clock(b.starts_at, d.venue.timezone)}</T>
              <T style={{ flex: 1, minWidth: 120 }} numberOfLines={1}>{b.area} · {b.customer}</T>
              <Tag label={t(b.payment_status === 'paid' ? 'vh.bk.paid' : 'vh.bk.unpaid')} color={b.payment_status === 'paid' ? c.mint : c.sun} />
            </View>
          </Card>
        )) : <Empty emoji="📅" title={t('vh.bk.none')} sub={t('vh.bk.none_sub')} />}
        <Btn small title={t('vh.bk.new')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'frontdesk' } })} />
      </View>
      <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', gap: 8 }}>
        <T weight="800" size={14} color={c.mute}>{t('vh.ev.title')}</T>
        {ev.length ? ev.map((e) => (
          <Card key={e.id} pad={12} onPress={() => setOpen(e)} accessibilityLabel={lab(e.name, t('vh.ev.ready', { pct: e.complete_pct }))}>
            <T weight="800" numberOfLines={1}>{e.name}</T>
            <T size={12} color={c.mute}>{e.starts_on} · {tn('vh.ev.bookings', e.bookings)}</T>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, marginTop: 8, overflow: 'hidden' }}><View style={{ width: `${e.complete_pct}%`, height: 8, backgroundColor: e.complete_pct === 100 ? c.mint : c.sun }} /></View>
            <T size={12} weight="700" style={{ marginTop: 4 }}>{t('vh.ev.ready', { pct: e.complete_pct })}</T>
          </Card>
        )) : <Empty emoji="🏆" title={t('vh.ev.none')} sub={t('vh.ev.none_sub')} />}
      </View>
      <EventSheet ev={open} onClose={() => setOpen(null)} />
    </View>
  );
}

export function RevenueOccupancy({ d, go }) {
  const r = d.revenue, o = d.occupancy;
  const cur = d.venue.currency;
  if (!r || !o) return <Empty emoji="📈" title={t('vh.rev.none')} sub={t('vh.rev.none_sub')} />;
  const maxRev = Math.max(1, ...r.by_facility.map((x) => x.revenue_cents));
  return (
    <View style={{ gap: 12 }}>
      <Wrap>
        <Stat label={t('vh.rev.mtd')} value={moneyIn(r.month_to_date_cents, cur)} />
        <Stat label={t('vh.rev.projected')} value={r.projected_month_end_cents == null ? '—' : moneyIn(r.projected_month_end_cents, cur)} sub={r.projected_month_end_cents == null ? t('vh.rev.too_early') : t('vh.rev.run_rate')} />
        <Stat label={t('vh.rev.outstanding')} value={moneyIn(r.outstanding_cents, cur)} tone={r.outstanding_cents > 0 ? 'alert' : undefined} />
        <Stat label={t('vh.rev.refunds')} value={moneyIn(r.refunds_owed_cents, cur)} />
      </Wrap>
      <Card pad={14}>
        <T weight="800">{t('vh.occ.week')}</T>
        <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('vh.occ.sub', { util: pct(o.utilisation), cancel: pct(o.cancellation_rate) })}{o.peak_hour != null ? ` · ${t('vh.occ.peak', { hour: hourLabel(o.peak_hour) })}` : ''}</T>
        <Spark label={t('vh.occ.week')} points={o.series.map((s) => ({ label: dayName(s.date), value: s.bookings }))} />
      </Card>
      <Card pad={14}>
        <T weight="800" style={{ marginBottom: 8 }}>{t('vh.rev.by_facility')}</T>
        {r.by_facility.some((x) => x.revenue_cents > 0)
          ? <View style={{ gap: 10 }}>{r.by_facility.map((x) => (
            <View key={x.id} accessible accessibilityLabel={lab(x.name, moneyIn(x.revenue_cents, cur))} style={{ gap: 3 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={13} weight="700" style={{ flexShrink: 1 }}>{x.name}</T><T size={13} weight="700">{moneyIn(x.revenue_cents, cur)}</T></View>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 8, width: `${Math.round((x.revenue_cents / maxRev) * 100)}%`, backgroundColor: c.cyan }} /></View>
            </View>))}</View>
          : <T size={13} color={c.mute}>{t('vh.rev.by_facility_none')}</T>}
      </Card>
      <Card pad={14}>
        <T weight="800" style={{ marginBottom: 6 }}>{t('vh.rev.categories')}</T>
        {r.categories.map((x) => <View key={x.key} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}><T>{t(`vh.cat.${x.key}`)}</T><T weight="700">{moneyIn(x.cents, cur)}</T></View>)}
        <T size={11} color={c.mute} style={{ marginTop: 6 }}>{t('vh.rev.categories_note')}</T>
      </Card>
      <Btn small title={t('vh.rev.reports')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'reports' } })} />
    </View>
  );
}

export function Demand({ d, go }) {
  const w = d.demand;
  if (!w || (!w.waitlist.length && !w.coach_requests.length)) return <Empty emoji="🧲" title={t('vh.dem.none')} sub={t('vh.dem.none_sub')} />;
  return (
    <View style={{ gap: 8 }}>
      {w.waitlist.map((x) => (
        <Card key={`${x.resource_id}${x.starts_at}`} pad={12} accessibilityLabel={tn('vh.dem.waiting', x.waiting, { area: x.resource_name })}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T weight="700" style={{ flex: 1, minWidth: 150 }}>{x.resource_name} · {new Date(x.starts_at).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: d.venue.timezone })}</T>
            <Tag label={t('vh.dem.waiting_tag', { n: x.waiting })} color={c.sun} />
            <Btn small title={t('vh.dem.respond')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'blocks' } })} />
          </View>
        </Card>
      ))}
      {w.coach_requests.map((x) => (
        <Card key={x.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <T weight="700" style={{ flex: 1, minWidth: 150 }}>{t('vh.dem.coach', { name: x.coach })}</T>
            <Btn small title={t('vh.act.review')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'coaches' } })} />
          </View>
        </Card>
      ))}
    </View>
  );
}

export function Procurement({ d, go }) {
  const p = d.procurement;
  return (
    <View style={{ gap: 12 }}>
      {p ? <Wrap>
        <Stat label={t('vh.proc.open')} value={String(p.open)} />
        <Stat label={t('vh.proc.responses')} value={String(p.responses)} />
        <Stat label={t('vh.proc.evaluation')} value={String(p.evaluation)} tone={p.evaluation ? 'alert' : undefined} />
        <Stat label={t('vh.proc.awarded')} value={String(p.awarded)} />
      </Wrap> : null}
      <T size={12} color={c.mute}>{t('vh.proc.hint')}</T>
      <Wrap gap={8}>
        <Btn small title={t('vh.proc.create')} onPress={() => go({ route: 'TenderBuilder', params: { venue_id: d.venue.id } })} />
        <Btn small title={t('vh.proc.find')} color={c.paper} onPress={() => go({ route: 'Marketplace' })} />
        <Btn small title={t('vh.proc.zone')} color={c.paper} onPress={() => go({ route: 'TenderZone' })} />
      </Wrap>
    </View>
  );
}

export function AssetsAndStaff({ d, go }) {
  const { tablet } = useLayout();
  const a = d.assets, s = d.staff;
  return (
    <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
      <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', gap: 8 }}>
        <T weight="800" size={14} color={c.mute}>{t('vh.as.title')}</T>
        {a ? <>
          <Wrap gap={8}>
            {['new', 'good', 'fair', 'poor', 'out_of_service'].map((k) => <Stat key={k} label={t(`vh.cond.${k}`)} value={String(a.condition[k] ?? 0)} tone={['poor', 'out_of_service'].includes(k) && a.condition[k] ? 'alert' : undefined} />)}
          </Wrap>
          <T size={13} color={c.mute}>{t('vh.as.facts', { pm: a.pm_overdue, warranty: a.warranty_expiring, spend: moneyIn(a.spend_30d_cents, d.venue.currency) })}</T>
          {a.open_work.length ? a.open_work.map((w) => (
            <Card key={w.id} pad={10}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <T weight="700" style={{ flex: 1, minWidth: 140 }} numberOfLines={1}>{w.title}{w.area ? ` · ${w.area}` : ''}</T>
              {w.due_on ? <T size={12} color={c.mute}>{w.due_on}</T> : null}
              <Tag label={t(`vh.prio.${w.priority}`)} color={w.priority === 'urgent' ? c.orange : w.priority === 'high' ? c.sun : c.violetSoft} />
            </View></Card>
          )) : <Empty emoji="🛠️" title={t('vh.as.none')} sub={t('vh.as.none_sub')} />}
        </> : null}
        <Btn small title={t('vh.as.raise')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'maintenance' } })} />
      </View>
      <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', gap: 8 }}>
        <T weight="800" size={14} color={c.mute}>{t('vh.st.title')}</T>
        {s && (s.team.length || s.on_shift.length) ? <>
          <Wrap gap={8}>
            {s.team.map((x) => {
              const on = s.on_shift.find((y) => y.duty === x.duty)?.n ?? 0;
              return <Stat key={x.duty} label={t(`vf.duty.${x.duty}`)} value={`${on}/${x.n}`} sub={t('vh.st.on_shift')} />;
            })}
          </Wrap>
          {s.late_or_missed ? <Tag label={tn('vh.st.late', s.late_or_missed)} color={c.orange} /> : null}
        </> : <Empty emoji="👷" title={t('vh.st.none')} sub={t('vh.st.none_sub')} />}
        <Btn small title={t('vh.st.roster')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'facility' } })} />
      </View>
    </View>
  );
}

export function Customer({ d, go }) {
  const x = d.customer;
  if (!x) return null;
  return (
    <View style={{ gap: 10 }}>
      <Wrap>
        <Stat label={t('vh.cx.rating')} value={x.rating == null ? '—' : `${x.rating} ★`} sub={tn('vh.cx.reviews', x.reviews)} />
        <Stat label={t('vh.cx.new')} value={String(x.new_reviews_30d)} sub={t('vh.cx.last30')} />
        <Stat label={t('vh.cx.awaiting')} value={String(x.awaiting_reply)} tone={x.awaiting_reply ? 'alert' : undefined} />
        <Stat label={t('vh.cx.repeat')} value={pct(x.repeat_rate)} sub={x.customers_90d ? tn('vh.cx.customers', x.customers_90d) : t('vh.cx.no_history')} />
      </Wrap>
      <Btn small title={x.awaiting_reply ? t('vh.act.respond') : t('vh.cx.open')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'reviews' } })} />
    </View>
  );
}

export function Compliance({ d, go }) {
  const x = d.compliance;
  const TONE = { expired: c.orange, soon: c.sun, ok: c.mint };
  return (
    <View style={{ gap: 8 }}>
      {x?.items.length ? x.items.slice(0, 6).map((i) => (
        <Card key={`${i.source}${i.id}`} pad={10} accessibilityLabel={`${i.title ?? t(`vh.ck.${i.kind}`)}. ${t(`vh.cs.${i.status}`)}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <T weight="700" style={{ flex: 1, minWidth: 140 }} numberOfLines={1}>{i.title ?? t(`vh.ck.${i.kind}`)}</T>
            {i.expires_on ? <T size={12} color={c.mute}>{i.expires_on}</T> : null}
            <Tag label={i.days_left == null ? t('vh.cs.ok') : i.days_left < 0 ? t('vh.cs.expired') : tn('vh.cs.days', i.days_left)} color={TONE[i.status]} />
          </View>
        </Card>
      )) : <Empty emoji="📜" title={t('vh.co.none')} sub={t('vh.co.none_sub')} />}
      {x && !x.has_insurance ? <Tag label={t('vh.att.no_insurance')} color={c.sun} /> : null}
      <Btn small title={t('vh.co.manage')} color={c.paper} onPress={() => go({ route: 'Manage', params: { id: d.venue.id, tab: 'docs' } })} />
    </View>
  );
}

export function Opportunities({ d, go }) {
  const list = d.opportunities ?? [];
  const ins = d.insights ?? [];
  if (!list.length && !ins.length) return <Empty emoji="💡" title={t('vh.op.none')} sub={t('vh.op.none_sub')} />;
  return (
    <View style={{ gap: 8 }}>
      {ins.map((x) => <Card key={x.key} pad={12} accessibilityLabel={insightText(x)}><T>💡  {insightText(x)}</T></Card>)}
      {list.map((o) => (
        <Card key={o.key} pad={12}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <T style={{ flex: 1, minWidth: 160 }}>{t(`vh.opp.${o.key}`)}</T>
          <Btn small title={t(`vh.opp.${o.key}_cta`)} color={c.paper} onPress={() => go(o.action)} />
        </View></Card>
      ))}
    </View>
  );
}

/** Adaptive equipment summary for the venue hub: availability strip + quick CTA. */
export function AdaptiveEquipmentSection({ venueId, go }) {
  const { data, loading } = useLoad(() => api.get(`/venues/${venueId}/adaptive-equipment/readiness`), [venueId]);
  if (loading) return null;
  const assets = data?.assets ?? [];
  const available = assets.filter((a) => a.readiness === 'ready').length;
  const needsService = assets.filter((a) => a.readiness === 'needs_service').length;
  const onLoan = assets.filter((a) => a.status === 'on_loan').length;
  if (!assets.length) return <Empty emoji="♿" title={t('vh.aeq.none')} sub={t('vh.aeq.none_sub')} />;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Stat label={t('vh.aeq.available')} value={String(available)} />
        <Stat label={t('vh.aeq.on_loan')} value={String(onLoan)} tone={onLoan ? undefined : undefined} />
        {needsService > 0 ? <Stat label={t('vh.aeq.needs_service')} value={String(needsService)} tone="alert" /> : null}
      </View>
      {assets.slice(0, 4).map((a) => (
        <Card key={a.id} pad={12} accessibilityLabel={`${a.name}: ${t(`adaptiveEquip.type.${a.type}`)}, ${t(`adaptiveEquip.status.${a.readiness}`)}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T weight="700" style={{ flex: 1 }} numberOfLines={1}>{a.name}</T>
            <Tag label={t(`adaptiveEquip.type.${a.type}`)} color={c.violet} />
            <Tag label={a.readiness === 'ready' ? t('vh.aeq.ready') : t('vh.aeq.not_ready')} color={a.readiness === 'ready' ? c.mint : c.orange} />
          </View>
        </Card>
      ))}
      {assets.length > 4 ? <T size={12} color={c.mute} style={{ textAlign: 'right' }}>{t('vh.aeq.more', { n: assets.length - 4 })}</T> : null}
      <Btn small title={t('vh.aeq.manage')} color={c.paper} onPress={() => go({ route: 'AdaptiveEquipmentHub', params: { venueId } })} />
    </View>
  );
}
