// Elite venue compliance register: licences, certificates and permits for a venue — with compliance
// score, 12-month expiry forecast, category breakdown, renewal workflow, finance tracking, configurable
// reminder cadence, issuing authority, jurisdiction, verification status and document attachments.
// Lives in the venue Documents tab. Items are archived, never deleted.
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { useSession } from '../session';

// ── constants ──────────────────────────────────────────────────────────────────
const KINDS = ['licence', 'fire', 'safety', 'pool', 'food', 'accessibility', 'tax', 'permit', 'other'];

const CATEGORIES = ['operating', 'safety', 'sports_grade', 'food_bev', 'health_medical', 'environmental', 'finance_tax', 'employment', 'events', 'other'];

const CAT_SUB_TYPES = {
  operating: ['Sports Facility Licence', 'Municipal Operating Permit', 'Business Registration', 'Sports Club Registration', 'Company Trading Licence'],
  safety: ['Fire Safety Certificate', 'Structural Inspection', 'Electrical Safety (EICR)', 'Gas Safety Certificate', 'Pool Safety Inspection', 'Sports Equipment Inspection', 'Crowd Safety Certificate', 'Accessibility Inspection'],
  sports_grade: ['ITF Court Certification', 'FIFA Pitch Licence', 'World Athletics Track Cert', 'BWF Court Grade', 'World Aquatics Pool Cert', 'World Rugby Pitch Standard', 'UCI Velodrome Grade', 'FIH Pitch Certification'],
  food_bev: ['Food Premises Licence', 'Food Handler Certificate', 'Alcohol Licence', 'Food Safety Management Cert', 'Catering Permit'],
  health_medical: ['First Aid Certificate', 'AED Defibrillator Registration', 'Medical Personnel on Site', 'Sports Medicine Facility Cert', 'Physiotherapy Licence'],
  environmental: ['Noise Permit', 'Waste Management Licence', 'Water Quality Certificate', 'Floodlight Permit', 'Environmental Impact Approval'],
  finance_tax: ['VAT / GST Registration', 'Business Tax Certificate', 'Charity Registration', 'Trading Licence', 'Anti-money Laundering Cert'],
  employment: ['Employer Registration', 'Working Visa Licence', 'DBS / Background Check Approval', 'Child Safeguarding Certificate', 'Coach Licensing (National Body)'],
  events: ['Public Event Permit', 'Road Closure Permit', 'Public Gathering Licence', 'Alcohol at Events Permit', 'Temporary Structures Permit', 'Security Licence'],
  other: ['Other Licence', 'Other Certificate', 'Other Permit'],
};

const CAT_EMOJI = { operating: '🏟️', safety: '🔒', sports_grade: '🏅', food_bev: '🍽️', health_medical: '⚕️', environmental: '🌿', finance_tax: '📊', employment: '👤', events: '🎟️', other: '📋' };
const KIND_EMOJI = { licence: '📋', fire: '🔥', safety: '🔒', pool: '🏊', food: '🍽️', accessibility: '♿', tax: '📊', permit: '🎟️', other: '📋', insurance: '🛡️', contract: '📄' };
const RENEWAL_STAGES = ['not_started', 'applied', 'in_review', 'issued'];
const VERIFICATION_STATUSES = ['self_reported', 'third_party', 'certified'];
const DEFAULT_REMINDER_DAYS = [90, 60, 30, 14, 7, 1];
const TONE = { expired: c.orange, soon: c.sun, ok: c.mint };
const SOON_DAYS = 30;

// ── helpers ───────────────────────────────────────────────────────────────────
const daysUntil = (iso) => iso ? Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.now()) / 86400_000) : null;
const fmtDate = (iso) => iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
const statusOf = (d) => d == null ? 'ok' : d < 0 ? 'expired' : d <= SOON_DAYS ? 'soon' : 'ok';

function daysTag(item) {
  const d = daysUntil(item.expires_on);
  if (d == null) return null;
  if (d < 0) return { label: t('vh.cs.expired'), color: c.orange };
  if (d === 0) return { label: t('vh.cs.today'), color: c.red };
  if (d <= SOON_DAYS) return { label: t('vh.cs.days', { n: d }), color: c.sun };
  return { label: t('vh.cs.ok'), color: c.mint };
}

function ScoreRing({ score }) {
  const r = 24, cx = 28, cy = 28, stroke = 5;
  const circ = 2 * Math.PI * r;
  const fill = circ * (1 - score / 100);
  const color = score >= 80 ? c.mint : score >= 60 ? c.sun : c.orange;
  return (
    <View style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center' }}>
      {Platform.OS === 'web' ? (
        <svg width={56} height={56} viewBox="0 0 56 56" style={{ position: 'absolute', top: 0, left: 0 }}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={stroke} />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#fff" strokeWidth={stroke}
            strokeDasharray={circ} strokeDashoffset={fill}
            strokeLinecap="round" transform={`rotate(-90 ${cx} ${cy})`} />
        </svg>
      ) : null}
      <T size={16} weight="900" color="#fff">{score}</T>
    </View>
  );
}

// ── compliance score hero ─────────────────────────────────────────────────────
function ScoreHero({ analytics }) {
  if (!analytics) return null;
  const { score, valid, expiring, expired, total_annual_cents, annual_currency } = analytics;
  const grade = score >= 90 ? t('vcr.grade.excellent') : score >= 80 ? t('vcr.grade.good') : score >= 60 ? t('vcr.grade.fair') : t('vcr.grade.poor');
  return (
    <View style={{ margin: 12, borderRadius: 18, overflow: 'hidden', backgroundColor: c.violet }}>
      <View style={{ padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <ScoreRing score={score} />
        <View style={{ flex: 1 }}>
          <T size={11} weight="700" style={{ letterSpacing: 0.6, textTransform: 'uppercase', opacity: 0.7 }} color="#fff">{t('vcr.score_label')}</T>
          <T size={20} weight="900" color="#fff" style={{ marginTop: 2 }}>{grade}</T>
          <T size={12} color="rgba(255,255,255,0.75)" weight="500" style={{ marginTop: 2 }}>{t('vcr.score_sub', { n: expired + expiring })}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.15)' }}>
        {[
          { label: t('vcr.stat.valid'), value: valid, color: c.mint },
          { label: t('vcr.stat.expiring'), value: expiring, color: c.sun },
          { label: t('vcr.stat.expired'), value: expired, color: c.orange },
          ...(total_annual_cents && annual_currency ? [{ label: t('vcr.stat.annual'), value: `${annual_currency} ${(total_annual_cents / 100).toFixed(0)}`, color: c.cyan }] : []),
        ].map(({ label, value, color }, i) => (
          <View key={i} style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderLeftWidth: i ? 1 : 0, borderLeftColor: 'rgba(255,255,255,0.15)' }}>
            <T size={18} weight="900" color={color}>{value}</T>
            <T size={9} weight="700" color="rgba(255,255,255,0.6)" style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 1 }}>{label}</T>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── expiry insight strip ───────────────────────────────────────────────────────
function InsightStrip({ items }) {
  const urgent = items.filter((x) => x.source === 'compliance' && x.expires_on && daysUntil(x.expires_on) != null && daysUntil(x.expires_on) <= SOON_DAYS && daysUntil(x.expires_on) >= 0);
  const expired = items.filter((x) => x.source === 'compliance' && x.expires_on && daysUntil(x.expires_on) < 0);
  if (!urgent.length && !expired.length) return null;
  const first = expired[0] ?? urgent[0];
  const days = daysUntil(first.expires_on);
  const msg = days < 0 ? t('vcr.insight.expired', { name: first.title }) : t('vcr.insight.expiring', { name: first.title, n: days });
  const bg = days < 0 ? c.orangeSoft : c.sunSoft;
  const accent = days < 0 ? c.orange : c.sun;
  return (
    <View style={{ marginHorizontal: 12, marginBottom: 8, borderRadius: 10, backgroundColor: bg, borderLeftWidth: 3, borderLeftColor: accent, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 }}>
      <T size={15}>{days < 0 ? '⚠️' : '🕐'}</T>
      <T size={12} weight="600" color={accent} style={{ flex: 1 }}>{msg}</T>
    </View>
  );
}

// ── category filter tabs ───────────────────────────────────────────────────────
function CategoryTabs({ active, onChange, byCat }) {
  const tabs = [null, ...CATEGORIES.filter((cat) => byCat?.[cat])];
  if (tabs.length <= 2) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 6 }}>
      {tabs.map((cat) => {
        const isActive = active === cat;
        return (
          <Pressable key={cat ?? 'all'} onPress={() => onChange(cat)}
            style={{ borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: isActive ? c.pink : c.paper, borderWidth: 1.5, borderColor: isActive ? c.pink : c.line }}>
            <T size={12} weight="700" color={isActive ? '#fff' : c.mute}>{cat ? `${CAT_EMOJI[cat]} ${t(`vcr.cat.${cat}`)}` : t('common.all')}</T>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ── compliance item card ───────────────────────────────────────────────────────
function CompItem({ item, onRenew, onArchive, onDetail }) {
  const dt = daysTag(item);
  const emoji = CAT_EMOJI[item.category] ?? KIND_EMOJI[item.kind] ?? '📋';
  const catBg = { operating: c.accentSoft ?? c.pinkSoft, safety: c.orangeSoft, sports_grade: c.cyanSoft, food_bev: c.sunSoft, health_medical: c.mintSoft, environmental: c.limeSoft, finance_tax: c.limeSoft, employment: c.violetSoft, events: c.pinkSoft, other: c.line };
  const iconBg = catBg[item.category] ?? c.line;
  return (
    <Pressable onPress={() => onDetail(item)} accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${dt ? dt.label : t('vcr.no_expiry')}`}>
      <Card pad={0} style={{ overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 13 }}>
          <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <T size={18}>{emoji}</T>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T weight="800" size={14} numberOfLines={1}>{item.title}</T>
            {item.issuing_authority ? <T size={11} color={c.mute} weight="500" numberOfLines={1}>{item.issuing_authority}{item.jurisdiction_country ? ` · ${item.jurisdiction_country}` : ''}</T> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 5 }}>
              {dt ? <Tag label={dt.label} color={dt.color} /> : null}
              {item.category ? <Tag label={t(`vcr.cat.${item.category}`)} color={c.accentSoft ?? c.pinkSoft} /> : null}
              {item.verification_status === 'certified' ? <Tag label={t('vcr.verified.certified')} color={c.mint} /> : null}
              {item.renewal_stage && item.renewal_stage !== 'not_started' ? <Tag label={t(`vcr.renewal.${item.renewal_stage}`)} color={c.cyanSoft} /> : null}
            </View>
          </View>
        </View>
        <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingHorizontal: 13, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T size={11} color={c.mute}>{item.issued_on ? `${t('vcr.issued_short')} ${fmtDate(item.issued_on)}` : ''}{item.expires_on ? ` · ${t('vcr.expires_short')} ${fmtDate(item.expires_on)}` : ''}</T>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {item.source === 'compliance' ? <>
              <Btn small title={t('vcr.renew')} color={c.paper} onPress={() => onRenew(item)} />
              <Btn small title={t('vcr.archive')} color={c.paper} onPress={() => onArchive(item)} />
            </> : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

// ── item detail sheet ──────────────────────────────────────────────────────────
function DetailSheet({ item, venueId, visible, onClose, onChanged }) {
  const { toast } = useSession();
  if (!item) return null;
  const dt = daysTag(item);
  const emoji = CAT_EMOJI[item.category] ?? KIND_EMOJI[item.kind] ?? '📋';
  const run = async (fn, msg) => { try { await fn(); toast?.(msg); onChanged(); onClose(); } catch (e) { toast?.(explain(e)); } };
  return (
    <FormSheet visible={visible} onClose={onClose} title={item.title}
      fields={[
        { key: 'expires_on', label: t('vcr.expires'), type: 'date' },
        { key: 'renewal_stage', label: t('vcr.renewal_stage'), type: 'chips', options: RENEWAL_STAGES.map((v) => ({ value: v, label: t(`vcr.renewal.${v}`) })) },
      ]}
      initial={{ expires_on: item.expires_on ?? '', renewal_stage: item.renewal_stage ?? 'not_started' }}
      submitLabel={t('vcr.save_renewal')}
      notice={[
        `${emoji} ${t(`vcr.cat.${item.category ?? 'other'}`)}`,
        item.issuing_authority ? `📍 ${item.issuing_authority}${item.jurisdiction_country ? ` (${item.jurisdiction_country})` : ''}` : null,
        dt ? `${dt.label}` : null,
        item.annual_fee_cents ? `${t('vcr.annual_fee')}: ${item.annual_fee_currency ?? ''} ${(item.annual_fee_cents / 100).toFixed(2)}` : null,
        item.conditions_notes ? `📝 ${item.conditions_notes.slice(0, 100)}${item.conditions_notes.length > 100 ? '…' : ''}` : null,
      ].filter(Boolean).join('  ·  ')}
      extra={
        <Btn small title={t('vcr.archive')} color={c.paper} style={{ alignSelf: 'flex-start' }}
          onPress={() => run(() => api.patch(`/venues/${venueId}/compliance/${item.id}`, { archived: true }), t('vcr.archived'))} />
      }
      onSubmit={async (v) => {
        await api.patch(`/venues/${venueId}/compliance/${item.id}`, { expires_on: v.expires_on || null, renewal_stage: v.renewal_stage });
        onChanged();
        return t('vcr.saved');
      }} />
  );
}

// ── add form — 4-step wizard ───────────────────────────────────────────────────
const STEP_FIELDS = [
  // Step 1 — Type & Identity
  (values) => [
    { key: 'category', label: t('vcr.category'), type: 'chips', options: CATEGORIES.map((v) => ({ value: v, label: `${CAT_EMOJI[v]} ${t(`vcr.cat.${v}`)}` })) },
    { key: 'sub_type', label: t('vcr.sub_type'), type: 'chips', optional: true,
      options: (vals) => (CAT_SUB_TYPES[vals.category] ?? CAT_SUB_TYPES.other).map((v) => ({ value: v, label: v })) },
    { key: 'title', label: t('vcr.name') },
    { key: 'kind', label: t('vcr.legacy_kind'), type: 'chips', options: KINDS.map((v) => ({ value: v, label: t(`vh.ck.${v}`) })) },
    { key: 'issuing_authority', label: t('vcr.issuing_authority'), optional: true },
    { key: 'jurisdiction_country', label: t('vcr.jurisdiction'), type: 'country', optional: true },
    { key: 'jurisdiction_region', label: t('vcr.region'), optional: true },
  ],
  // Step 2 — Dates & Renewal
  (values) => [
    { key: 'reference', label: t('vcr.reference'), optional: true, hint: t('vcr.reference_hint') },
    { key: 'issued_on', label: t('vcr.issued'), type: 'date', optional: true },
    { key: 'expires_on', label: t('vcr.expires'), type: 'date', optional: true },
    { key: 'reminder_days', label: t('vcr.reminder_days'), type: 'multi',
      options: [1, 7, 14, 30, 60, 90, 180].map((n) => ({ value: n, label: t('vcr.days_before', { n }) })),
      hint: t('vcr.reminder_days_hint') },
    { key: 'renewal_stage', label: t('vcr.renewal_stage'), type: 'chips', optional: true,
      options: RENEWAL_STAGES.map((v) => ({ value: v, label: t(`vcr.renewal.${v}`) })) },
    { key: 'renewal_ref', label: t('vcr.renewal_ref'), optional: true },
    { key: 'renewal_expected_on', label: t('vcr.renewal_expected'), type: 'date', optional: true },
  ],
  // Step 3 — People & Coverage
  (values) => [
    { key: 'responsible_user_id', label: t('vcr.responsible'), type: 'entity', entityKind: 'person', noun: t('common.person'), optional: true, hint: t('vcr.responsible_hint') },
    { key: 'verification_status', label: t('vcr.verification'), type: 'chips', optional: true,
      options: VERIFICATION_STATUSES.map((v) => ({ value: v, label: t(`vcr.verified.${v}`) })) },
    { key: 'conditions_notes', label: t('vcr.conditions'), type: 'multiline', optional: true, hint: t('vcr.conditions_hint') },
  ],
  // Step 4 — Finance & Documents
  (values) => [
    { key: 'annual_fee_cents', label: t('vcr.annual_fee'), type: 'money', optional: true,
      currency: (vals) => vals.annual_fee_currency ?? 'USD' },
    { key: 'annual_fee_currency', label: t('vcr.currency'), type: 'currency', optional: true },
    { key: 'last_paid_on', label: t('vcr.last_paid'), type: 'date', optional: true },
    { key: 'renewal_estimate_cents', label: t('vcr.renewal_estimate'), type: 'money', optional: true,
      currency: (vals) => vals.annual_fee_currency ?? 'USD' },
    { key: 'document_id', label: t('vcr.document'), type: 'files', optional: true, max: 3, documents: true, hint: t('vcr.document_hint') },
  ],
];

const STEP_TITLES = ['vcr.step1', 'vcr.step2', 'vcr.step3', 'vcr.step4'];

function AddWizard({ venueId, visible, onClose, onSaved }) {
  const { toast } = useSession();
  const [step, setStep] = useState(0);
  const [data, setData] = useState({});

  const handleClose = () => { setStep(0); setData({}); onClose(); };
  const isLast = step === STEP_FIELDS.length - 1;

  const handleSubmit = async (vals) => {
    const merged = { ...data, ...vals };
    if (!isLast) {
      setData(merged);
      setStep((s) => s + 1);
      return null; // suppress FormSheet's auto-close
    }
    // Final step — submit everything
    const payload = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length)));
    // reminder_days: convert from multi (array of numbers)
    if (payload.reminder_days) payload.reminder_days = payload.reminder_days.map(Number);
    // money fields: FormSheet submits in minor units already
    await api.post(`/venues/${venueId}/compliance`, payload);
    setStep(0); setData({});
    onSaved();
    return t('vcr.saved');
  };

  return (
    <FormSheet visible={visible} onClose={handleClose}
      title={t(STEP_TITLES[step])}
      notice={step > 0 ? `${t('vcr.step_progress', { current: step + 1, total: STEP_FIELDS.length })} · ${data.title ?? ''}` : undefined}
      onBack={step > 0 ? () => setStep((s) => s - 1) : undefined}
      submitLabel={isLast ? t('vcr.save_to_register') : t('vcr.continue')}
      fields={STEP_FIELDS[step](data)}
      initial={data}
      onSubmit={handleSubmit} />
  );
}

// ── main component ────────────────────────────────────────────────────────────
export function VenueComplianceRegister({ venueId }) {
  const { toast } = useSession();
  const [addOpen, setAddOpen] = useState(false);
  const [detailItem, setDetailItem] = useState(null);
  const [catFilter, setCatFilter] = useState(null);
  const reg = useLoad(() => api.get(`/venues/${venueId}/compliance`), [venueId]);
  const run = async (fn, msg) => { try { await fn(); toast?.(msg); reg.reload(); } catch (e) { toast?.(explain(e)); } };

  if (reg.error) return <ErrorBox error={reg.error} onRetry={reg.reload} />;
  if (!reg.data) return <Loading />;

  const { items = [], analytics } = reg.data;
  const ownItems = items.filter((x) => x.source === 'compliance');
  const filtered = catFilter ? ownItems.filter((x) => (x.category ?? 'other') === catFilter) : items;
  const insights = items.filter((x) => x.source === 'compliance');

  return (
    <View style={{ gap: 10, marginBottom: 20 }}>
      <View style={{ paddingHorizontal: 0 }}>
        <T size={17} weight="800" style={{ marginBottom: 2 }}>{t('vcr.title')}</T>
        <T size={13} color={c.mute}>{t('vcr.sub')}</T>
      </View>

      <ScoreHero analytics={analytics} />
      <InsightStrip items={insights} />
      <CategoryTabs active={catFilter} onChange={setCatFilter} byCat={analytics?.by_category} />

      <View style={{ gap: 8 }}>
        {filtered.length ? filtered.map((item) => (
          <CompItem key={`${item.source}${item.id}`} item={item}
            onRenew={(i) => setDetailItem(i)}
            onArchive={(i) => run(() => api.patch(`/venues/${venueId}/compliance/${i.id}`, { archived: true }), t('vcr.archived'))}
            onDetail={(i) => { if (i.source === 'compliance') setDetailItem(i); }} />
        )) : <Empty emoji="📜" title={t('vh.co.none')} sub={t('vh.co.none_sub')} />}
      </View>

      <Btn title={t('vcr.add')} onPress={() => setAddOpen(true)} />

      <AddWizard venueId={venueId} visible={addOpen} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); reg.reload(); }} />
      <DetailSheet item={detailItem} venueId={venueId} visible={!!detailItem} onClose={() => setDetailItem(null)} onChanged={reg.reload} />
    </View>
  );
}
