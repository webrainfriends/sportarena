// Memberships and multi-session passes: what a venue sells, what you hold, using a pass on an invoice, and the venue team's plan manager.
import { t } from '../i18n';
import React, { useState } from 'react';
import { View, TouchableOpacity, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';
import { Collections } from './collections';
import { SportsMulti } from '../sportpicker';

const until = (d) => new Date(d).toLocaleDateString(locale);

const PERKS = [
  { key: 'Locker',                label: () => t('vp.perk_locker') },
  { key: 'Towel',                 label: () => t('vp.perk_towel') },
  { key: 'Priority booking',      label: () => t('vp.perk_priority') },
  { key: 'Coaching clinic',       label: () => t('vp.perk_coaching') },
  { key: 'Shower & changing room',label: () => t('vp.perk_shower') },
  { key: 'Café discount',         label: () => t('vp.perk_cafe') },
  { key: 'Equipment hire',        label: () => t('vp.perk_equipment') },
  { key: 'Free guest pass',       label: () => t('vp.perk_guest_pass') },
  { key: 'Court towel service',   label: () => t('vp.perk_court_towel') },
  { key: 'Video analysis',        label: () => t('vp.perk_video') },
  { key: 'Physio access',         label: () => t('vp.perk_physio') },
  { key: 'Nutrition consult',     label: () => t('vp.perk_nutrition') },
  { key: 'Recovery room',         label: () => t('vp.perk_recovery') },
  { key: 'Strength & conditioning',label: () => t('vp.perk_sc') },
  { key: 'Parking',               label: () => t('vp.perk_parking') },
  { key: 'Laundry service',       label: () => t('vp.perk_laundry') },
];

const TIERS = [
  { value: 'bronze',   emoji: '🥉', label: () => t('vp.tier_bronze') },
  { value: 'silver',   emoji: '🥈', label: () => t('vp.tier_silver') },
  { value: 'gold',     emoji: '🥇', label: () => t('vp.tier_gold') },
  { value: 'platinum', emoji: '💎', label: () => t('vp.tier_platinum') },
  { value: 'elite',    emoji: '👑', label: () => t('vp.tier_elite') },
];

const BADGE_EMOJIS = ['🏅','🥇','⭐','🌟','🎖️','🏆','💫','✨','🔁','💎','👑','🎟️','📦','⚡','🎫','🏷️'];

const DURATION_OPTS = [
  { value: 30,  label: () => t('vp.dur_1m') },
  { value: 90,  label: () => t('vp.dur_3m') },
  { value: 180, label: () => t('vp.dur_6m') },
  { value: 365, label: () => t('vp.dur_1y') },
  { value: 730, label: () => t('vp.dur_2y') },
];
const SESSION_OPTS = [5, 10, 20, 30, 50];

const tierColor = (tier) => ({
  bronze: c.orange, silver: c.mute, gold: c.sun, platinum: c.violet, elite: c.pink,
}[tier] ?? c.pink);

const planIcon = (p) => p?.emoji ?? (p?.kind === 'membership' ? (p?.auto_renew ? '🔁' : '🏅') : (p?.resource_ids?.length ? '📦' : '🎟️'));

// ─── Stepper ────────────────────────────────────────────────────────────────
function Stepper({ value, min = 0, max = 999, step = 1, suffix = '', onChange }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Btn small title="−" disabled={value <= min} onPress={() => onChange(Math.max(min, value - step))} />
      <T weight="700" size={18} style={{ minWidth: 48, textAlign: 'center' }}>{value}{suffix}</T>
      <Btn small title="+" disabled={value >= max} onPress={() => onChange(Math.min(max, value + step))} />
    </View>
  );
}

// ─── Chip row ────────────────────────────────────────────────────────────────
function ChipRow({ options, value, onChange }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        const lbl = typeof o === 'object' ? (typeof o.label === 'function' ? o.label() : o.label) : String(o);
        return <Chip key={v} label={lbl} active={value === v} onPress={() => onChange(v)} />;
      })}
    </View>
  );
}

// ─── Multi-select grid ───────────────────────────────────────────────────────
function MultiGrid({ options, value, onChange }) {
  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const sel = value.includes(o.key);
        return (
          <TouchableOpacity key={o.key} onPress={() => toggle(o.key)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12,
              borderRadius: 10, borderWidth: 1.5, borderColor: sel ? c.pink : c.line,
              backgroundColor: sel ? (c.pinkSoft + '44') : c.paper }}>
            <T size={12} color={sel ? c.pink : c.mute}>{sel ? '✓' : '○'}</T>
            <T size={13} weight={sel ? '700' : '500'} color={sel ? c.ink : c.mute}>{typeof o.label === 'function' ? o.label() : o.label}</T>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Emoji picker ─────────────────────────────────────────────────────────────
function EmojiRow({ value, onChange }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {BADGE_EMOJIS.map((e) => (
        <TouchableOpacity key={e} onPress={() => onChange(e)}
          style={{ width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
            borderWidth: 1.5, borderColor: value === e ? c.pink : c.line,
            backgroundColor: value === e ? (c.pinkSoft + '33') : c.paper }}>
          <T size={22}>{e}</T>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Step header with progress bar ───────────────────────────────────────────
function WizardHeader({ title, subtitle, step, total, onClose }) {
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 16, paddingBottom: 0 }}>
        <View style={{ flex: 1 }}>
          <T weight="800" size={18}>{title}</T>
          {subtitle ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{subtitle}</T> : null}
        </View>
        <Btn small title="✕" color={c.paper} onPress={onClose} />
      </View>
      <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 16, paddingTop: 10 }}>
        {Array.from({ length: total }).map((_, i) => (
          <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i < step ? c.pinkSoft : i === step ? c.pink : c.line }} />
        ))}
      </View>
      <T size={11} weight="700" color={c.pink} style={{ paddingHorizontal: 16, paddingTop: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        {t('vp.step_of', { n: step + 1, total })}
      </T>
    </View>
  );
}

// ─── Field label ─────────────────────────────────────────────────────────────
function FL({ label, hint, optional }) {
  return (
    <View style={{ marginBottom: 6 }}>
      <T weight="700" size={12} color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.7 }}>
        {label}{optional ? <T size={12} color={c.mute} style={{ fontWeight: '400', textTransform: 'none' }}> ({t('form.optional')})</T> : null}
      </T>
      {hint ? <T size={11} color={c.mute} style={{ marginTop: 2 }}>{hint}</T> : null}
    </View>
  );
}

// ─── Info box ────────────────────────────────────────────────────────────────
function InfoBox({ text }) {
  return (
    <View style={{ padding: 12, backgroundColor: c.violetSoft, borderRadius: 10, borderLeftWidth: 3, borderLeftColor: c.pink }}>
      <T size={12} color={c.mute}>{text}</T>
    </View>
  );
}

// ─── Live preview card ───────────────────────────────────────────────────────
function PlanPreviewCard({ f }) {
  return (
    <View style={{ borderRadius: 16, padding: 16, overflow: 'hidden',
      backgroundColor: c.violet }}>
      {f.tier ? <T size={10} weight="800" color={c.pinkSoft} style={{ textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>
        {TIERS.find((t) => t.value === f.tier)?.emoji ?? ''} {TIERS.find((t) => t.value === f.tier)?.label() ?? ''}
      </T> : null}
      <T weight="800" size={20} color={c.on}>{f.emoji ?? '🏅'} {f.name || '—'}</T>
      {f.tagline ? <T size={12} color={c.on} style={{ opacity: 0.8, marginTop: 2 }}>{f.tagline}</T> : null}
      {f.price_cents > 0 ? <T size={13} color={c.on} style={{ opacity: 0.9, marginTop: 6 }}>
        {f.currency} {(f.price_cents / 100).toLocaleString()}
        {f.kind === 'membership' ? (` · ${DURATION_OPTS.find((d) => d.value === f.duration_days)?.label() ?? ''} · ${f.discount_pct ?? 0}% ${t('vp.off_booking')}`) : (f.sessions ? ` · ${f.sessions} ${t('vp.sessions')}` : '')}
      </T> : null}
      {f.includes?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {f.includes.slice(0, 5).map((k) => (
            <View key={k} style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)' }}>
              <T size={10} color={c.on} weight="600">{k}</T>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ─── PLAN WIZARD ─────────────────────────────────────────────────────────────
function PlanWizard({ v, kind, visible, onClose, onDone }) {
  const isMem = kind === 'membership' || kind === 'subscription';
  const totalSteps = isMem ? 5 : 4;
  const stepTitles = isMem
    ? [t('vp.s1'), t('vp.s2_mem'), t('vp.s3_mem'), t('vp.s4_mem'), t('vp.s5')]
    : [t('vp.s1'), t('vp.s2_pass'), t('vp.s3_pass'), t('vp.s5')];

  const defaults = {
    tier: 'gold', emoji: isMem ? '🏅' : '🎟️', name: '', tagline: '', sport_slugs: [],
    price_cents: 0, joining_fee_cents: 0, duration_days: 180, billing_period: 30, discount_pct: 20,
    early_bird_price_cents: 0, early_bird_days: 30,
    ent_days: [], ent_from: '', ent_to: '', ent_guests: 0,
    priority_hrs: 0, max_members: 0,
    includes: [], coaching_hours: 0, auto_renew: kind === 'subscription',
    sessions: 10, valid_days: 90, session_value_cents: 0, resource_ids: [],
    description: '', notes: '',
    currency: v.currency,
    kind: isMem ? 'membership' : 'pass',
  };

  const [step, setStep] = useState(0);
  const [f, setF] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const { toast } = useSession();

  const set = (k, x) => setF((p) => ({ ...p, [k]: x }));

  const reset = () => { setStep(0); setF(defaults); };
  const close = () => { reset(); onClose(); };

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        kind: f.kind,
        name: f.name,
        description: f.description || undefined,
        price_cents: f.price_cents,
        tier: f.tier || undefined,
        emoji: f.emoji || undefined,
        tagline: f.tagline || undefined,
        sport_slugs: f.sport_slugs,
        includes: f.includes,
        coaching_hours: f.coaching_hours,
        booking_lead_priority_hours: f.priority_hrs,
        max_members: f.max_members > 0 ? f.max_members : undefined,
        joining_fee_cents: f.joining_fee_cents > 0 ? f.joining_fee_cents : undefined,
        early_bird_price_cents: f.early_bird_price_cents > 0 ? f.early_bird_price_cents : undefined,
        early_bird_days: f.early_bird_days > 0 ? f.early_bird_days : undefined,
        auto_renew: f.auto_renew,
      };
      if (isMem) {
        payload.duration_days = f.auto_renew ? f.billing_period : f.duration_days;
        payload.discount_bp = Math.round(f.discount_pct * 100);
        payload.entitlements = {
          days: f.ent_days, from: f.ent_from || undefined, to: f.ent_to || undefined, guest_quota: f.ent_guests,
        };
      } else {
        payload.sessions = f.sessions;
        payload.valid_days = f.valid_days;
        payload.session_value_cents = f.session_value_cents > 0 ? f.session_value_cents : undefined;
        payload.resource_ids = f.resource_ids;
      }
      await api.post(`/venues/${v.id}/plans`, payload);
      toast(isMem ? (f.auto_renew ? t('vp.created_sub') : t('vp.created_mem')) : (f.resource_ids.length ? t('vp.created_pkg') : t('vp.created_pass')));
      await onDone?.();
      close();
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const headerSub = () => {
    const parts = [];
    if (f.tier) parts.push(TIERS.find((t) => t.value === f.tier)?.label() ?? '');
    if (f.name) parts.push(f.name);
    return parts.join(' · ');
  };

  const renderStep = () => {
    if (step === 0) return (
      <View style={{ gap: 14 }}>
        <View>
          <FL label={t('vp.tier')} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {TIERS.map((ti) => (
              <Chip key={ti.value} label={`${ti.emoji} ${ti.label()}`} active={f.tier === ti.value}
                onPress={() => set('tier', ti.value)} />
            ))}
          </View>
        </View>
        <View>
          <FL label={t('vp.name')} />
          <Field value={f.name} onChangeText={(x) => set('name', x)} placeholder={isMem ? t('vp.name_mem_hint') : t('vp.name_pass_hint')} />
        </View>
        <View>
          <FL label={t('vp.emoji')} />
          <EmojiRow value={f.emoji} onChange={(x) => set('emoji', x)} />
        </View>
        <View>
          <FL label={t('vp.tagline')} optional hint={t('vp.tagline_hint')} />
          <Field value={f.tagline} onChangeText={(x) => set('tagline', x)} placeholder={t('vp.tagline_placeholder')} />
        </View>
        <View>
          <FL label={t('vp.sport_slugs')} optional hint={t('vp.sport_slugs_hint')} />
          <SportsMulti value={f.sport_slugs} onChange={(x) => set('sport_slugs', x)} />
        </View>
        {!isMem && (
          <View>
            <FL label={t('vp.courts')} optional hint={t('vp.courts_hint')} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {v.resources.map((r) => (
                <Chip key={r.id} label={`${r.sport_emoji ?? ''} ${r.name}`.trim()}
                  active={f.resource_ids.includes(r.id)}
                  onPress={() => set('resource_ids', f.resource_ids.includes(r.id) ? f.resource_ids.filter((x) => x !== r.id) : [...f.resource_ids, r.id])} />
              ))}
            </View>
          </View>
        )}
      </View>
    );

    if (step === 1 && isMem) return (
      <View style={{ gap: 14 }}>
        <View>
          <FL label={t('vp.price_mem')} />
          <FormSheet inline fields={[{ key: 'price_cents', label: t('vp.price_mem'), type: 'money', currency: v.currency }]}
            initial={{ price_cents: f.price_cents || '' }} onSubmit={() => {}} />
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <FL label={t('vp.joining_fee')} optional hint={t('vp.joining_fee_hint')} />
          </View>
        </View>
        <View>
          <FL label={t('vp.price_mem')} />
          <FormSheet inline
            fields={[
              { key: 'price_cents', label: t('vp.price_mem'), type: 'money', currency: v.currency },
              { key: 'joining_fee_cents', label: t('vp.joining_fee'), type: 'money', currency: v.currency, optional: true },
              f.auto_renew
                ? { key: 'billing_period', label: t('vp.billing_period'), type: 'chips', default: 30, options: [{ value: 30, label: t('vp.dur_1m') }, { value: 90, label: t('vp.dur_3m') }, { value: 365, label: t('vp.dur_1y') }] }
                : { key: 'duration_days', label: t('vp.duration'), type: 'chips', default: 180, options: DURATION_OPTS.map((d) => ({ value: d.value, label: d.label() })) },
              { key: 'discount_pct', label: t('vp.discount'), type: 'stepper', min: 5, max: 90, step: 5, default: 20, suffix: '%' },
              { key: '_eb', type: 'section', label: t('vp.early_bird') },
              { key: 'early_bird_price_cents', label: t('vp.eb_price'), type: 'money', currency: v.currency, optional: true },
              { key: 'early_bird_days', label: t('vp.eb_days'), type: 'stepper', min: 1, max: 365, step: 1, default: 30, suffix: ` ${t('vp.eb_days_unit')}`, optional: true },
            ]}
            initial={{ price_cents: f.price_cents || '', joining_fee_cents: f.joining_fee_cents || '', duration_days: f.duration_days, billing_period: f.billing_period, discount_pct: f.discount_pct, early_bird_price_cents: f.early_bird_price_cents || '', early_bird_days: f.early_bird_days }}
            onSubmit={async (vals) => {
              setF((p) => ({ ...p, ...vals }));
            }} />
        </View>
      </View>
    );

    if (step === 1 && !isMem) return (
      <View style={{ gap: 14 }}>
        <View>
          <FL label={t('vp.sessions')} />
          <ChipRow options={SESSION_OPTS} value={f.sessions} onChange={(x) => set('sessions', x)} />
        </View>
        <FormSheet inline
          fields={[
            { key: 'price_cents', label: t('vp.price_pass'), type: 'money', currency: v.currency },
            { key: 'session_value_cents', label: t('vp.session_value'), type: 'money', currency: v.currency, optional: true, hint: t('vp.session_value_hint') },
            { key: '_eb', type: 'section', label: t('vp.early_bird') },
            { key: 'early_bird_price_cents', label: t('vp.eb_price'), type: 'money', currency: v.currency, optional: true },
            { key: 'early_bird_days', label: t('vp.eb_days'), type: 'stepper', min: 1, max: 90, step: 1, default: 14, suffix: ` ${t('vp.eb_days_unit')}`, optional: true },
          ]}
          initial={{ price_cents: f.price_cents || '', session_value_cents: f.session_value_cents || '', early_bird_price_cents: f.early_bird_price_cents || '', early_bird_days: f.early_bird_days }}
          onSubmit={async (vals) => { setF((p) => ({ ...p, ...vals })); }} />
      </View>
    );

    if (step === 2 && isMem) return (
      <View style={{ gap: 14 }}>
        <InfoBox text={t('vp.ent_hint')} />
        <View>
          <FL label={t('vp.access_days')} />
          <FormSheet inline
            fields={[{ key: 'ent_days', label: t('vp.access_days'), type: 'weekdays', hint: t('vf.ent.days_hint') }]}
            initial={{ ent_days: f.ent_days }}
            onSubmit={async (vals) => { setF((p) => ({ ...p, ...vals })); }} />
        </View>
        <View>
          <FL label={t('vp.access_window')} optional />
          <FormSheet inline
            fields={[
              { key: 'ent_from', label: t('vf.ent.from'), type: 'time', optional: true },
              { key: 'ent_to', label: t('vf.ent.to'), type: 'time', optional: true },
            ]}
            initial={{ ent_from: f.ent_from, ent_to: f.ent_to }}
            onSubmit={async (vals) => { setF((p) => ({ ...p, ...vals })); }} />
        </View>
        <View>
          <FL label={t('vp.priority_lead')} hint={t('vp.priority_lead_hint')} />
          <Stepper value={f.priority_hrs} min={0} max={720} step={12} suffix={` ${t('vp.priority_lead_unit')}`}
            onChange={(x) => set('priority_hrs', x)} />
        </View>
        <View>
          <FL label={t('vf.ent.guests')} />
          <Stepper value={f.ent_guests} min={0} max={20} onChange={(x) => set('ent_guests', x)} />
        </View>
        <View>
          <FL label={t('vp.capacity')} optional hint={t('vp.capacity_hint')} />
          <Stepper value={f.max_members} min={0} max={10000} step={5} suffix={f.max_members > 0 ? ` ${t('vp.capacity_unit')}` : ''}
            onChange={(x) => set('max_members', x)} />
          {f.max_members === 0 ? <T size={11} color={c.mute} style={{ marginTop: 4 }}>{t('vp.capacity_unlimited')}</T> : null}
        </View>
      </View>
    );

    if (step === 2 && !isMem) return (
      <View style={{ gap: 14 }}>
        <View>
          <FL label={t('vp.valid_days')} />
          <ChipRow
            options={DURATION_OPTS.map((d) => ({ value: d.value, label: d.label() }))}
            value={f.valid_days}
            onChange={(x) => set('valid_days', x)} />
        </View>
        <View>
          <FL label={t('vp.perks')} optional />
          <MultiGrid options={PERKS} value={f.includes} onChange={(x) => set('includes', x)} />
        </View>
        <View>
          <FL label={t('vp.capacity')} optional hint={t('vp.capacity_hint')} />
          <Stepper value={f.max_members} min={0} max={10000} step={5}
            suffix={f.max_members > 0 ? ` ${t('vp.capacity_unit')}` : ''}
            onChange={(x) => set('max_members', x)} />
          {f.max_members === 0 ? <T size={11} color={c.mute} style={{ marginTop: 4 }}>{t('vp.capacity_unlimited')}</T> : null}
        </View>
      </View>
    );

    if (step === 3 && isMem) return (
      <View style={{ gap: 14 }}>
        <View>
          <FL label={t('vp.perks')} />
          <MultiGrid options={PERKS} value={f.includes} onChange={(x) => set('includes', x)} />
        </View>
        <View>
          <FL label={t('vp.coaching_hrs')} hint={t('vp.coaching_hrs_hint')} />
          <Stepper value={f.coaching_hours} min={0} max={500} suffix={` ${t('vp.coaching_hrs_unit')}`}
            onChange={(x) => set('coaching_hours', x)} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <T weight="700" size={14}>{t('vp.autorenew')}</T>
            <T size={12} color={c.mute}>{t('vp.autorenew_hint')}</T>
          </View>
          <TouchableOpacity onPress={() => set('auto_renew', !f.auto_renew)}>
            <View style={{ width: 44, height: 24, borderRadius: 999, backgroundColor: f.auto_renew ? c.pink : c.line, padding: 2, justifyContent: 'center', alignItems: f.auto_renew ? 'flex-end' : 'flex-start' }}>
              <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' }} />
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );

    // Final step (step 4 for mem, step 3 for pass)
    return (
      <View style={{ gap: 14 }}>
        <PlanPreviewCard f={f} />
        <View>
          <FL label={t('vp.mkt_desc')} optional />
          <Field multiline value={f.description} onChangeText={(x) => set('description', x)}
            placeholder={t('vp.mkt_desc_placeholder')} style={{ minHeight: 60 }} />
        </View>
        <View>
          <FL label={t('vp.notes')} optional />
          <Field multiline value={f.notes} onChangeText={(x) => set('notes', x)}
            placeholder={t('vp.notes_placeholder')} style={{ minHeight: 48 }} />
        </View>
      </View>
    );
  };

  const isLast = step === totalSteps - 1;
  const publishLabel = isMem
    ? (f.auto_renew ? t('vp.publish_sub') : t('vp.publish_mem'))
    : (f.resource_ids.length ? t('vp.publish_pkg') : t('vp.publish_pass'));

  const typeTitle = kind === 'membership' ? t('vp.mem.title') : kind === 'subscription' ? t('vp.sub.title') : kind === 'pass' ? t('vp.pass.title') : t('vp.pkg.title');

  return (
    <Sheet visible={visible} onClose={close}>
      <WizardHeader title={typeTitle} subtitle={headerSub()} step={step} total={totalSteps} onClose={close} />
      <T weight="800" size={18} style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>{stepTitles[step]}</T>
      <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}>
        {renderStep()}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 10, padding: 16 }}>
        {step > 0 ? <Btn title={t('common.back')} color={c.paper} onPress={() => setStep((s) => s - 1)} /> : null}
        <View style={{ flex: 1 }}>
          {isLast
            ? <Btn title={publishLabel} loading={busy} onPress={submit} />
            : <Btn title={t('common.next')} onPress={() => setStep((s) => s + 1)} />}
        </View>
      </View>
    </Sheet>
  );
}

/** On the venue page: what's for sale and what you already hold here. */
export function VenuePlans({ venue, onChanged }) {
  const { user, toast } = useSession();
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(null);
  if (!venue.plans?.length) return null;
  const buy = async (p) => {
    if (!user) { toast(t('vp.sign_in_to_buy')); return; }
    setBusy(p.id);
    try {
      const up = await api.post(`/venue-plans/${p.id}/buy`, {});
      setPay({ id: up.id, type: 'venue_plan', label: p.name, amount: Number(up.price_cents), currency: up.currency });
    } catch (e) { toast(e.message); } finally { setBusy(null); }
  };
  return (
    <Card color={c.violetSoft}>
      <T weight="700" size={16}>{t('vp.section_title_short')}</T>
      {venue.my_member_discount_bp > 0 ? <T size={13} weight="700" style={{ marginTop: 4 }}>{t('vp.member_active', { pct: venue.my_member_discount_bp / 100, until: until(venue.my_membership_until) })}</T> : null}
      {venue.my_pass_sessions > 0 ? <T size={13} weight="700">{t('vp.pass_sessions_held', { n: venue.my_pass_sessions })}</T> : null}
      {venue.plans.map((p) => (
        <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <T size={18}>{planIcon(p)}</T>
              <T weight="700">{p.name}</T>
              {p.tier ? <Tag label={p.tier} color={tierColor(p.tier)} small /> : null}
            </View>
            {p.tagline ? <T size={12} color={c.mute} style={{ marginTop: 1 }}>{p.tagline}</T> : null}
            <T size={12} color={c.mute}>{p.kind === 'membership' ? t('vp.mem_summary', { pct: p.discount_bp / 100, days: p.duration_days }) : t('vp.pass_summary', { sessions: p.sessions, days: p.valid_days, value: moneyIn(p.session_value_cents, venue.currency) })}</T>
            {p.includes?.length ? <T size={12} color={c.mute}>{t('vp.includes')}: {p.includes.join(' · ')}</T> : null}
            {p.coaching_hours > 0 ? <T size={12} color={c.mute}>{t('vp.coaching_hrs_included', { n: p.coaching_hours })}</T> : null}
            {p.auto_renew ? <T size={12} color={c.mute}>{t('vp.subscription_note')}</T> : null}
          </View>
          <Btn small title={moneyIn(p.price_cents, venue.currency)} loading={busy === p.id} onPress={() => buy(p)} />
        </View>
      ))}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={() => onChanged?.()} /> : null}
    </Card>
  );
}

/** On the Wallet screen: everything you hold. */
export function MyPlans() {
  const { toast } = useSession();
  const plans = useLoad(() => api.get('/me/plans'), []);
  const [pay, setPay] = useState(null);
  return (
    <Section title={t('vp.wallet_title')} color={c.violet}>
      {plans.loading && !plans.data ? <Loading /> : plans.data?.length ? plans.data.map((p) => (
        <Row key={p.id} onPress={p.status === 'awaiting_payment' ? () => setPay({ id: p.id, type: 'venue_plan', label: p.name, amount: Number(p.price_cents), currency: p.currency }) : undefined}
          title={`${p.emoji ?? '🎟️'} ${p.name} · ${p.venue_name}`}
          sub={p.status === 'awaiting_payment' ? t('vp.tap_to_pay') : p.kind === 'membership' ? t('vp.mem_wallet_sub', { pct: p.discount_bp / 100, status: p.status === 'expired' ? t('vp.ended') : t('vp.until'), until: until(p.expires_at) }) : t('vp.pass_wallet_sub', { left: p.sessions_left, total: p.sessions_total, status: p.status === 'expired' ? t('vp.ended') : t('vp.until'), until: until(p.expires_at) })}
          right={<Tag label={p.status.replace('_', ' ')} color={p.status === 'active' ? c.mint : p.status === 'awaiting_payment' ? c.sun : c.violetSoft} />} />
      )) : <T size={13} color={c.mute}>{t('vp.wallet_empty')}</T>}
      {pay ? <PaySheet target={pay} onClose={() => setPay(null)} onDone={plans.reload} /> : null}
    </Section>
  );
}

/** "Use my pass" for an open invoice. */
export function PassApplySheet({ invoice, onClose, onDone }) {
  const { toast } = useSession();
  const plans = useLoad(() => api.get('/me/plans', { venue_id: invoice.venue_id }), []);
  const [busy, setBusy] = useState(false);
  const passes = (plans.data ?? []).filter((p) => p.kind === 'pass' && p.status === 'active' && p.sessions_left > 0);
  const due = invoice.total_cents - (invoice.credits_cents ?? 0);
  return (
    <Sheet visible onClose={onClose} title={t('vp.pay_with_pass')}>
      {plans.loading ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <T>{t('vp.amount_due')}: <T weight="700">{moneyIn(due, invoice.currency)}</T></T>
          {passes.map((p) => <T key={p.id} size={13} color={c.mute}>{p.emoji ?? '🎟️'} {p.name}: {p.sessions_left} {t('vp.sessions_left')}, {t('vp.each_pays')} {moneyIn(p.session_value_cents, p.currency)} · {t('vp.until')} {until(p.expires_at)}</T>)}
          <T size={13} color={c.mute}>{t('vp.pass_apply_note')}</T>
          <Btn title={passes.length ? t('vp.use_my_pass') : t('vp.no_sessions_left')} disabled={!passes.length} loading={busy} onPress={async () => {
            setBusy(true);
            try { const r = await api.post(`/invoices/${invoice.id}/pass`, {}); toast(r.paid ? t('vp.pass_paid', { n: r.sessions_used }) : t('vp.pass_partial', { n: r.sessions_used })); await onDone?.(); onClose(); } catch (e) { toast(e.message); } finally { setBusy(false); }
          }} />
        </View>
      )}
    </Sheet>
  );
}

/** Venue console tab: define, stop selling, and see how plans are doing. */
export function PlansManager({ v }) {
  const [form, setForm] = useState(null); // 'membership' | 'subscription' | 'pass' | 'package'
  const plans = useLoad(() => api.get(`/venues/${v.id}/plans`), [v.id]);
  const report = useLoad(() => api.get(`/venues/${v.id}/plans/report`), [v.id]);
  const reload = () => { plans.reload(); report.reload(); };
  const rows = report.data?.plans ?? [];
  const meta = (id) => (plans.data ?? []).find((p) => p.id === id);
  const courtNames = (ids) => ids.map((rid) => v.resources.find((r) => r.id === rid)?.name).filter(Boolean).join(', ');
  return (
    <>
      <Section title={t('vp.section_title')} color={c.violet}>
        <T color={c.mute} size={13}>{t('vp.section_intro', { currency: v.currency })}</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title={t('vp.btn_mem')} onPress={() => setForm('membership')} />
          <Btn small title={t('vp.btn_sub')} onPress={() => setForm('subscription')} />
          <Btn small title={t('vp.btn_pass')} color={c.violet} onPress={() => setForm('pass')} />
          <Btn small title={t('vp.btn_pkg')} color={c.violet} onPress={() => setForm('package')} />
        </View>
        {report.data ? (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <StatPill label={t('vp.stat_revenue')} value={moneyIn(report.data.revenue_cents, v.currency)} />
            <StatPill label={t('vp.stat_holders')} value={String(report.data.active_holders ?? 0)} />
            <StatPill label={t('vp.stat_sessions')} value={String(report.data.sessions_outstanding ?? 0)} />
            <StatPill label={t('vp.stat_plans')} value={String(rows.filter((r) => r.active).length)} />
          </View>
        ) : null}
        {rows.length ? rows.map((p) => {
          const m = meta(p.id);
          return (
            <Card key={p.id}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <T size={28}>{planIcon(m)}</T>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <T weight="700">{p.name}</T>
                    {m?.tier ? <Tag label={m.tier} color={tierColor(m.tier)} small /> : null}
                    {!p.active ? <Tag label={t('vp.not_on_sale')} color={c.mute} small /> : null}
                  </View>
                  {m?.tagline ? <T size={12} color={c.mute} style={{ marginTop: 1 }}>{m.tagline}</T> : null}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {m?.auto_renew ? <Tag label={t('vp.subscription_tag')} color={c.sun} small /> : null}
                    {m?.resource_ids?.length ? <Tag label={`${t('vp.courts_tag')}: ${courtNames(m.resource_ids)}`} color={c.violet} small /> : null}
                    {m?.coaching_hours > 0 ? <Tag label={t('vp.coaching_hrs_tag', { n: m.coaching_hours })} color={c.mint} small /> : null}
                    {m?.max_members ? <Tag label={t('vp.cap_tag', { n: m.max_members })} color={c.mute} small /> : null}
                    {m?.sport_slugs?.length ? <Tag label={m.sport_slugs.join(', ')} color={c.cyan} small /> : null}
                  </View>
                  <T size={12} color={c.mute} style={{ marginTop: 4 }}>{p.sold} {t('vp.sold')} · {p.active_holders} {t('vp.active')}{p.kind === 'pass' ? ` · ${p.sessions_outstanding} ${t('vp.sessions_pending')}` : ''} · {moneyIn(Number(p.revenue_cents), v.currency)}</T>
                </View>
                <Btn small title={p.active ? t('vp.stop_selling') : t('vp.sell_again')} color={c.paper}
                  onPress={async () => { await api.patch(`/venue-plans/${p.id}`, { active: !p.active }); reload(); }} />
              </View>
            </Card>
          );
        }) : <Empty emoji="🎟️" title={t('vp.no_plans')} sub={t('vp.no_plans_sub')} />}
      </Section>
      <Section title={t('vp.renewals_title')} color={c.violet}>
        <T color={c.mute} size={13}>{t('vp.renewals_intro')}</T>
        <Collections target={{ venue_id: v.id }} />
      </Section>
      <PlanWizard v={v} kind={form} visible={!!form} onClose={() => setForm(null)} onDone={reload} />
    </>
  );
}
