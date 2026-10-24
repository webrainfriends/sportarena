// Shared building blocks of the Academy module: status badges that never rely on colour alone, capacity meters, KPI tiles,
// funnel bars, a timeline and a master-detail panel (side column on tablet/desktop, bottom sheet on a phone).
import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { Avatar, Btn, Card, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { c } from '../theme';
import { moneyIn } from '../vtime';

export const STAGE = {
  enquiry: 'Enquiry', trial_requested: 'Trial requested', trial_booked: 'Trial booked', trial_completed: 'Trial done', application_draft: 'Draft', submitted: 'Submitted', under_review: 'In review',
  offered: 'Offer made', waitlisted: 'Waitlisted', declined: 'Declined', offer_accepted: 'Accepted', enrolled: 'Enrolled', withdrawn: 'Withdrawn', expired: 'Expired', cancelled: 'Cancelled',
};
export const STAGE_ICON = { enquiry: '✉️', trial_requested: '🎽', trial_booked: '📅', trial_completed: '✅', application_draft: '📝', submitted: '📨', under_review: '🔎', offered: '🎟️', waitlisted: '⏳', declined: '⛔', offer_accepted: '👍', enrolled: '🏅', withdrawn: '↩️', expired: '⌛', cancelled: '✖️' };
const STAGE_TONE = { enrolled: c.lime, offered: c.sun, offer_accepted: c.lime, waitlisted: c.orangeSoft, declined: c.orangeSoft, withdrawn: c.orangeSoft, expired: c.orangeSoft, cancelled: c.orangeSoft };
export const FUNNEL_STEPS = ['enquiry', 'trial_completed', 'submitted', 'offered', 'enrolled'];
export const FORMATS = [['term_course', 'Term course'], ['rolling', 'Rolling'], ['camp', 'Camp'], ['clinic', 'Clinic'], ['trial_programme', 'Trial programme'], ['one_to_one', 'One-to-one'], ['squad_pathway', 'Squad pathway'], ['custom', 'Custom']];
export const FOCUS = [['recreational', 'Recreational'], ['development', 'Development'], ['elite', 'Elite']];
export const MODES = [['direct', 'Enrol straight away'], ['trial_then_enrol', 'Trial first'], ['application', 'Application & review'], ['invite_only', 'Invite only'], ['waitlist_only', 'Waitlist only']];
export const MODE_HELP = { direct: 'Anyone eligible is enrolled immediately while seats last.', trial_then_enrol: 'People complete a trial before they can apply.', application: 'You review each application and offer a place.', invite_only: 'Only people you invite can join.', waitlist_only: 'Everyone joins the waitlist and you offer places.' };
export const BILLING = [['free', 'Free'], ['one_time', 'One-off fee'], ['term', 'Term, in instalments'], ['monthly', 'Monthly'], ['pack', 'Session pack']];
export const opts = (l) => l.map(([value, label]) => ({ value, label }));
export const lab = (l, k) => l.find(([v]) => v === k)?.[1] ?? k;
export const when = (d) => {
  if (!d) return '';
  const t = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(t)) return '';
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(t.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
};
export const ago = (n) => (n <= 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);
export const hoursLeft = (t) => { const h = Math.round((new Date(t) - Date.now()) / 3600e3); return h <= 0 ? 'expired' : h < 48 ? `${h}h left` : `${Math.round(h / 24)} days left`; };
export const priceLine = (v) => (!v ? '' : v.billing_model === 'free' ? 'Free' : `${moneyIn(v.fee_minor, v.currency)}${v.billing_model === 'monthly' ? ' / month' : v.billing_model === 'pack' ? ` · ${v.sessions_in_pack} sessions` : v.billing_model === 'term' && v.instalments > 1 ? ` · ${v.instalments} instalments` : ''}`);

export const StageBadge = ({ stage }) => <Tag label={`${STAGE_ICON[stage] ?? ''} ${STAGE[stage] ?? stage}`.trim()} color={STAGE_TONE[stage]} />;

export function Initials({ name, user, size = 40 }) {
  return <Avatar user={user} size={size} emoji={user?.avatar_emoji} color={user?.avatar_color} />;
}

/** A tile for a number that matters. Pressable when it leads somewhere. */
export function Kpi({ label, value, sub, tone, onPress, wide }) {
  const hot = tone === 'alert';
  const body = (
    <View style={{ flex: wide ? undefined : 1, minWidth: 140, padding: 14, borderRadius: 18, backgroundColor: hot ? c.orangeSoft : c.paper, borderWidth: 1, borderColor: hot ? c.orange : c.line, gap: 2 }}>
      <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{label.toUpperCase()}</T>
      <T size={28} weight="800" style={{ letterSpacing: -1, fontVariant: ['tabular-nums'] }}>{value}</T>
      {sub ? <T size={12} color={c.mute}>{sub}</T> : null}
    </View>
  );
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value}. ${sub ?? ''}`} onPress={onPress} style={{ flex: wide ? undefined : 1, minWidth: 140 }}>{body}</Pressable> : body;
}

/** Capacity bar with its numbers written out (never colour alone). */
export function Meter({ filled = 0, held = 0, capacity, waitlisted = 0, compact }) {
  if (!capacity) return <T size={13} color={c.mute}>{filled} enrolled · no limit set</T>;
  const total = filled + held;
  const pct = Math.min(100, Math.round((filled / capacity) * 100)), hp = Math.min(100 - pct, Math.round((held / capacity) * 100));
  const full = total >= capacity;
  return (
    <View style={{ gap: 4 }} accessible accessibilityLabel={`${filled} of ${capacity} places filled${held ? `, ${held} held for offers` : ''}${waitlisted ? `, ${waitlisted} waiting` : ''}`}>
      <View style={{ height: compact ? 6 : 8, borderRadius: 6, backgroundColor: c.violetSoft, flexDirection: 'row', overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, backgroundColor: full ? c.orange : c.lime }} />
        <View style={{ width: `${hp}%`, backgroundColor: c.sun }} />
      </View>
      <T size={12} color={c.mute}>{filled}/{capacity} filled{held ? ` · ${held} held` : ''}{waitlisted ? ` · ${waitlisted} waiting` : ''}{full ? ' · full' : ` · ${capacity - total} free`}</T>
    </View>
  );
}

/** Horizontal funnel: bar length is the count, the number and label are always printed. */
export function FunnelBars({ steps }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <View style={{ gap: 8 }}>
      {steps.map((s, i) => (
        <View key={s.label} accessible accessibilityLabel={`${s.label}: ${s.value}${s.rate != null && i ? `, ${s.rate} percent of the previous step` : ''}`} style={{ gap: 3 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} weight="700">{s.label}</T><T size={13} weight="800">{s.value}{s.rate != null && i ? <T size={12} color={c.mute}>  {s.rate}%</T> : null}</T></View>
          <View style={{ height: 10, borderRadius: 6, backgroundColor: c.violetSoft }}><View style={{ height: 10, borderRadius: 6, width: `${Math.max(s.value ? 4 : 0, Math.round((s.value / max) * 100))}%`, backgroundColor: i === steps.length - 1 ? c.lime : c.cyan }} /></View>
        </View>
      ))}
    </View>
  );
}

/** Tiny column chart for a short series. */
export function Spark({ points, label }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <View accessible accessibilityLabel={`${label}: ${points.map((p) => `${p.label} ${p.value}`).join(', ')}`} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 70 }}>
      {points.map((p) => (
        <View key={p.label} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
          <T size={11} weight="800">{p.value}</T>
          <View style={{ width: '70%', height: Math.max(4, Math.round((p.value / max) * 40)), borderRadius: 4, backgroundColor: c.cyan }} />
          <T size={10} color={c.mute}>{p.label}</T>
        </View>
      ))}
    </View>
  );
}

/** Vertical history: when, what, who/why. */
export function Timeline({ items }) {
  return (
    <View style={{ gap: 0 }}>
      {items.map((it, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ alignItems: 'center', width: 14 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 5, backgroundColor: i === items.length - 1 ? c.pink : c.cyan }} />
            {i < items.length - 1 ? <View style={{ flex: 1, width: 2, backgroundColor: c.line }} /> : null}
          </View>
          <View style={{ flex: 1, paddingBottom: 12 }}>
            <T size={13} weight="700">{it.title}</T>
            {it.sub ? <T size={12} color={c.mute}>{it.sub}</T> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Where an application stands on the way to a place. */
export function StageTrack({ stage }) {
  const order = ['enquiry', 'application', 'review', 'offer', 'enrolled'];
  const at = { enquiry: 0, trial_requested: 0, trial_booked: 0, trial_completed: 0, application_draft: 1, submitted: 2, under_review: 2, waitlisted: 3, offered: 3, offer_accepted: 3, enrolled: 4 }[stage];
  const names = { enquiry: 'Enquiry', application: 'Apply', review: 'Review', offer: 'Offer', enrolled: 'Enrolled' };
  if (at == null) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessible accessibilityLabel={`Step ${at + 1} of 5: ${names[order[at]]}`}>
      {order.map((k, i) => (
        <React.Fragment key={k}>
          <View style={{ alignItems: 'center', minWidth: 52 }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: i < at ? c.mint : i === at ? c.pink : c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T size={11} weight="800" color={i <= at ? c.onAccent : c.mute}>{i < at ? '✓' : i + 1}</T></View>
            <T size={10} weight={i === at ? '800' : '500'} color={i === at ? c.ink : c.mute}>{names[k]}</T>
          </View>
          {i < order.length - 1 ? <View style={{ flex: 1, height: 2, backgroundColor: i < at ? c.mint : c.line, marginBottom: 12 }} /> : null}
        </React.Fragment>
      ))}
    </View>
  );
}

/** Master-detail: a right-hand column on tablet/desktop, a bottom sheet on a phone. */
export function Split({ list, detail, detailTitle, onClose, open }) {
  const { tablet } = useLayout();
  if (tablet) {
    return (
      <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, minWidth: 0 }}>{list}</View>
        {open ? <View style={{ width: 420, maxWidth: '45%' }}><Card pad={16}><View style={{ gap: 10 }}><View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="800" size={17} style={{ flex: 1 }}>{detailTitle}</T><Btn small title="Close" color={c.paper} ink={c.ink} onPress={onClose} /></View>{detail}</View></Card></View> : null}
      </View>
    );
  }
  return <>{list}<Sheet visible={!!open} onClose={onClose} title={detailTitle ?? ''}>{detail}</Sheet></>;
}

/** Wide screens: a sidebar of sections; phones: a scrolling row of them. */
export function ModuleNav({ items, value, onChange, badge = {} }) {
  const { tablet } = useLayout();
  const el = (it) => {
    const on = it.key === value;
    return (
      <Pressable key={it.key} onPress={() => onChange(it.key)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={`${it.label}${badge[it.key] ? `, ${badge[it.key]} need attention` : ''}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: tablet ? 11 : 9, paddingHorizontal: 14, borderRadius: 14, backgroundColor: on ? c.ink : tablet ? 'transparent' : c.paper, borderWidth: tablet ? 0 : 1, borderColor: c.line, minHeight: 44 }}>
        <T size={16}>{it.icon}</T>
        <T weight="700" size={14} color={on ? c.bg : c.ink} style={{ flex: tablet ? 1 : undefined }}>{it.label}</T>
        {badge[it.key] ? <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}><T size={11} weight="800" color={c.onAccent}>{badge[it.key]}</T></View> : null}
      </Pressable>
    );
  };
  if (tablet) return <View style={{ width: 210, gap: 4, paddingTop: 4 }} accessibilityRole="tablist">{items.map(el)}</View>;
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }} accessibilityRole="tablist">{items.map(el)}</View>;
}

/** A labelled fact row inside a panel. */
export const Fact = ({ k, v }) => (v == null || v === '' ? null : <View style={{ flexDirection: 'row', gap: 8 }}><T size={13} color={c.mute} style={{ width: 118 }}>{k}</T><T size={13} weight="700" style={{ flex: 1 }}>{v}</T></View>);

export const Block = ({ title, right, children }) => (
  <View style={{ gap: 8, paddingTop: 6 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}><T weight="800" size={14} style={{ flex: 1 }}>{title}</T>{right}</View>
    {children}
  </View>
);

/** Render an academy invoice (a paid one is the receipt) as a branded PDF and open it. Web opens it in a tab; the phone apps point to the web version. */
export async function openInvoicePdf(invoiceId, toast) {
  try {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return toast?.('Invoices and receipts open in the web app');
    const d = await api.post('/branded-documents/invoice', { invoice_id: invoiceId });
    const url = URL.createObjectURL(await api.download(`/branded-documents/${d.id}/file`));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { toast?.(e.message); }
}

/** The branded enrolment letter as a PDF: family members get the standard letter, staff may add a welcome note and pick a published template. */
export async function openEnrolmentLetter(enrolmentId, toast, body = {}) {
  try {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return toast?.('Letters open in the web app');
    const d = await api.post(`/academy/enrolments/${enrolmentId}/letter`, body);
    const url = URL.createObjectURL(await api.download(`/branded-documents/${d.id}/file`));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { toast?.(e.message); }
}

/** Staff: issue the enrolment letter with an optional welcome note and one of the academy's published letter templates. */
export function LetterSheet({ enrolment, orgId, onClose, toast }) {
  const tpl = useLoad(() => (enrolment ? api.get('/document-templates', { family: 'enrolment_letter' }).catch(() => []) : Promise.resolve([])), [enrolment?.enrolment_id, orgId]);
  const mine = (tpl.data ?? []).filter((t) => t.organisation_id === orgId && t.latest_version);
  return (
    <FormSheet visible={!!enrolment} onClose={onClose} title={`Enrolment letter · ${enrolment?.display_name ?? ''}`} submitLabel="Issue letter (PDF)"
      fields={[
        { key: 'note', label: 'Welcome note', type: 'multiline', optional: true },
        ...(mine.length ? [{ key: 'template_id', label: 'Letter template', type: 'chips', optional: true, options: mine.map((t) => ({ value: t.id, label: t.name })) }] : []),
      ]}
      onSubmit={async (v) => { await openEnrolmentLetter(enrolment.enrolment_id, toast, { note: v.note || undefined, template_id: v.template_id || undefined }); return 'Letter issued'; }} />
  );
}
