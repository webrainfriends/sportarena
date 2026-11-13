// Physio practice setup wizard (#1126): 7-step profile for physio/clinician roles.
import React, { useState, useEffect } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, ErrorBox, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Stepper } from '../pickers';
import { CountryPicker } from '../country-picker';
import { c, r } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';

const STEP_KEYS = ['identity', 'licence', 'clinic', 'services', 'availability', 'payment', 'review'];

function CompletenessBar({ score }) {
  const pct = score ?? 0;
  const fillColor = pct >= 80 ? c.lime : pct >= 50 ? c.sun : c.orange;
  return (
    <View style={{ marginHorizontal: 20, marginBottom: 8, padding: 10, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
        <T size={11} weight="700" color={c.mute}>{t('ppw.completeness.label')}</T>
        <T size={13} weight="800" color={fillColor}>{pct}%</T>
      </View>
      <View style={{ height: 7, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 7, borderRadius: 4, backgroundColor: fillColor }} />
      </View>
    </View>
  );
}

export function PhysioProfileWizard({ onClose: closeProp, onDone, toast: toastProp, stepReached: initialStep = 0 }) {
  const nav = useNav();
  const session = useSession();
  const onClose = closeProp ?? nav.back;
  const toast = toastProp ?? session.toast;
  const opt = useLoad(() => api.get('/me/physio-profile/options'), []);
  const existing = useLoad(() => api.get('/me/physio-profile').catch(e => e?.status === 404 ? null : Promise.reject(e)), []);
  const completeness = useLoad(() => api.get('/me/physio-profile/completeness').catch(() => ({ score: 0 })), []);
  const [profile, setProfile] = useState(null);
  const [step, setStep] = useState(0);
  const [score, setScore] = useState(0);

  useEffect(() => {
    if (existing.data !== undefined && !profile) {
      if (existing.data) { setProfile(existing.data); setStep(Math.max(existing.data.step_reached ?? 0, initialStep)); }
    }
  }, [existing.data]);

  useEffect(() => { if (completeness.data?.score != null) setScore(completeness.data.score); }, [completeness.data]);

  if (opt.error || existing.error) return (
    <Sheet visible onClose={onClose} title={t('ppw.title')}>
      <ErrorBox error={opt.error || existing.error} onRetry={() => { opt.reload(); existing.reload(); }} />
    </Sheet>
  );
  if (!opt.data || existing.data === undefined) return <Sheet visible onClose={onClose} title={t('ppw.title')}><Loading /></Sheet>;

  const O = opt.data;
  const p = profile ?? {};
  const live = p.status === 'published';

  const refreshScore = async () => {
    try { const res = await api.get('/me/physio-profile/completeness'); if (res?.score != null) setScore(res.score); } catch (_) {}
  };

  const save = async (patch, to) => {
    try {
      const row = await api.post('/me/physio-profile', { ...(p.row_version != null ? { row_version: p.row_version } : {}), ...patch, step_reached: Math.max(p.step_reached ?? 0, (to ?? step) + 1) });
      setProfile(row); toast?.(t('ppw.saved')); if (to != null) setStep(to); refreshScore(); return row;
    } catch (e) { throw new Error(explain(e)); }
  };

  const back = () => setStep(s => Math.max(0, s - 1));
  const nextLabel = (k) => t('ppw.next_to', { step: t(`ppw.step.${STEP_KEYS[k]}`) });

  const publish = async () => {
    try { const row = await api.post('/me/physio-profile/publish'); setProfile(row); toast?.(t('ppw.published')); onDone?.(); } catch (e) { toast?.(explain(e)); }
  };
  const retract = async () => {
    try { const row = await api.post('/me/physio-profile/retract'); setProfile(row); toast?.(t('ppw.retracted')); } catch (e) { toast?.(explain(e)); }
  };

  return (
    <Sheet visible onClose={onClose} title={t('ppw.title')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <T size={12} color={c.mute} style={{ flex: 1 }}>{t('ppw.step_n', { n: step + 1, m: STEP_KEYS.length })} · {t(`ppw.step.${STEP_KEYS[step]}`)}</T>
        <Tag label={t(`ppw.status.${p.status ?? 'draft'}`)} color={live ? c.limeSoft : c.sunSoft} />
      </View>
      <Stepper steps={STEP_KEYS.map(k => t(`ppw.step.${k}`))} current={step} onJump={i => { if (p.id || i === 0) setStep(i); }} />
      <CompletenessBar score={score} />

      {step === 0 && (
        <FormSheet inline visible
          initial={{ display_name: p.display_name ?? '', pronouns: p.pronouns ?? '', bio: p.bio ?? '', specialisms: p.specialisms ?? [] }}
          submitLabel={nextLabel(1)}
          onClose={() => {}}
          fields={[
            { key: 'display_name', label: t('ppw.f.display_name') },
            { key: 'pronouns', label: t('ppw.f.pronouns'), type: 'chips', options: (O.pronouns ?? []).map(v => ({ value: v, label: v })), optional: true },
            { key: 'bio', label: t('ppw.f.bio'), type: 'multiline', optional: true },
            { key: 'specialisms', label: t('ppw.f.specialisms'), type: 'chips', options: (O.specialisms ?? []).map(v => ({ value: v, label: t(`ppw.specialism.${v}`) || v })), optional: true },
          ]}
          onSubmit={async x => { await save({ display_name: x.display_name, pronouns: x.pronouns || null, bio: x.bio || undefined, specialisms: x.specialisms }, 1); }}
        />
      )}

      {step === 1 && <LicenceStep profile={p} onSave={save} onBack={back} nextLabel={nextLabel(2)} />}
      {step === 2 && <ClinicStep profile={p} deliveryModes={O.delivery_modes} onSave={save} onBack={back} nextLabel={nextLabel(3)} />}
      {step === 3 && <ServicesStep profile={p} serviceCategories={O.service_categories} onSave={save} onBack={back} nextLabel={nextLabel(4)} />}

      {step === 4 && (
        <FormSheet inline visible
          initial={{ booking_lead_hours: p.appointment_availability?.booking_lead_hours ? String(p.appointment_availability.booking_lead_hours) : '24', cancellation_hours: p.appointment_availability?.cancellation_hours ? String(p.appointment_availability.cancellation_hours) : '24', online_booking: p.appointment_availability?.online_booking ?? true }}
          submitLabel={nextLabel(5)} onBack={back} onClose={() => {}}
          fields={[
            { key: 'online_booking', label: t('ppw.f.online_booking'), type: 'switch' },
            { key: 'booking_lead_hours', label: t('ppw.f.booking_lead'), type: 'number', hint: t('ppw.f.booking_lead_hint') },
            { key: 'cancellation_hours', label: t('ppw.f.cancellation'), type: 'number', hint: t('ppw.f.cancellation_hint') },
          ]}
          onSubmit={async x => { await save({ appointment_availability: { online_booking: x.online_booking, booking_lead_hours: Number(x.booking_lead_hours), cancellation_hours: Number(x.cancellation_hours), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }, 5); }}
        />
      )}

      {step === 5 && (
        <FormSheet inline visible
          initial={{ payout_method: p.payout_method ?? '', tax_country: p.tax_country ?? '', bank_name: '', bank_account: '', privacy_notice_accepted: false }}
          submitLabel={nextLabel(6)} onBack={back} onClose={() => {}}
          fields={[
            { key: 'payout_method', label: t('ppw.f.payout_method'), type: 'menu', options: (O.payout_methods ?? []).map(v => ({ value: v, label: t(`ppw.payout.${v}`) || v })), optional: true },
            { key: 'tax_country', label: t('ppw.f.tax_country'), optional: true },
            { key: 'bank_name', label: t('ppw.f.bank_name'), optional: true },
            { key: 'bank_account', label: t('ppw.f.bank_account'), type: 'password', optional: true, hint: t('ppw.f.bank_enc_hint') },
            { key: 'privacy_notice_accepted', label: t('ppw.f.privacy_notice'), type: 'switch', hint: t('ppw.f.privacy_notice_hint') },
          ]}
          onSubmit={async x => { await save({ payout_method: x.payout_method || undefined, tax_country: x.tax_country || undefined, bank_name: x.bank_name || undefined, bank_account: x.bank_account || undefined, privacy_notice_accepted: x.privacy_notice_accepted }, 6); }}
        />
      )}

      {step === 6 && <PhysioReviewStep profile={p} score={score} onPublish={publish} onRetract={retract} onBack={back} live={live} onDone={onDone} />}
    </Sheet>
  );
}

function LicenceStep({ profile: p, onSave, onBack, nextLabel }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <T size={17} weight="800" style={{ marginBottom: 4 }}>{t('ppw.step.licence')}</T>
      <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('ppw.licence.hint')}</T>
      <Card style={{ padding: 12, backgroundColor: c.cyanSoft, marginBottom: 12 }}>
        <T size={12} color={c.cyan}>🔒 {t('ppw.licence.enc_notice')}</T>
      </Card>
      <FormSheet inline visible
        initial={{ licence_number: '', licence_body: p.licence_body ?? '', licence_expiry: p.licence_expiry ?? '', indemnity_insurer: p.indemnity_insurer ?? '', indemnity_policy: '', indemnity_expiry: p.indemnity_expiry ?? '' }}
        submitLabel={nextLabel}
        onBack={onBack}
        onClose={() => {}}
        fields={[
          { key: 'licence_number', label: t('ppw.f.licence_number'), type: 'password', hint: t('ppw.f.licence_enc_hint') },
          { key: 'licence_body', label: t('ppw.f.licence_body') },
          { key: 'licence_expiry', label: t('ppw.f.licence_expiry'), type: 'date', optional: true },
          { key: 'indemnity_insurer', label: t('ppw.f.indemnity_insurer'), optional: true },
          { key: 'indemnity_policy', label: t('ppw.f.indemnity_policy'), type: 'password', optional: true, hint: t('ppw.f.licence_enc_hint') },
          { key: 'indemnity_expiry', label: t('ppw.f.indemnity_expiry'), type: 'date', optional: true },
        ]}
        onSubmit={async x => { await onSave({ licence_number: x.licence_number || undefined, licence_body: x.licence_body || undefined, licence_expiry: x.licence_expiry || undefined, indemnity_insurer: x.indemnity_insurer || undefined, indemnity_policy: x.indemnity_policy || undefined, indemnity_expiry: x.indemnity_expiry || undefined }, 2); }}
      />
    </ScrollView>
  );
}

function ClinicStep({ profile: p, deliveryModes, onSave, onBack, nextLabel }) {
  const [modes, setModes] = useState(p.delivery_modes ?? []);
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <T size={17} weight="800">{t('ppw.step.clinic')}</T>
      <FormSheet inline visible
        initial={{ clinic_name: p.clinic_name ?? '' }}
        submitLabel={nextLabel}
        onBack={onBack}
        onClose={() => {}}
        fields={[{ key: 'clinic_name', label: t('ppw.f.clinic_name') }]}
        onSubmit={async x => { await onSave({ clinic_name: x.clinic_name, delivery_modes: modes }, 3); }}
      />
      <T size={11} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 1 }}>{t('ppw.f.delivery_modes')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(deliveryModes ?? []).map(m => (
          <Pressable key={m} onPress={() => setModes(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m])}>
            <Tag label={t(`ppw.mode.${m}`) || m} color={modes.includes(m) ? c.pinkSoft : c.violetSoft} textColor={modes.includes(m) ? c.pink : c.mute} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function ServicesStep({ profile: p, serviceCategories, onSave, onBack, nextLabel }) {
  const [services, setServices] = useState(p.services ?? []);
  const [addSvc, setAddSvc] = useState(false);
  const { toast } = useSession();
  const submit = async () => { try { await onSave({ services }, 4); } catch (e) { toast(e.message); } };
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <T size={17} weight="800">{t('ppw.step.services')}</T>
      {services.map((s, i) => (
        <Card key={i} style={{ padding: 12 }}>
          <T size={14} weight="700">{s.name}</T>
          <T size={12} color={c.mute}>{s.duration_minutes} min · {s.fee_currency} {(s.fee_minor / 100).toFixed(2)}</T>
        </Card>
      ))}
      <Btn label={t('ppw.add_service')} ghost icon="Plus" onPress={() => setAddSvc(true)} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Btn label={t('ppw.back')} ghost onPress={onBack} style={{ flex: 1 }} />
        <Btn label={nextLabel} color={c.pink} onPress={submit} style={{ flex: 2 }} />
      </View>
      {addSvc && (
        <FormSheet visible title={t('ppw.add_service')} onClose={() => setAddSvc(false)}
          initial={{ category: 'initial_assessment', name: '', duration_minutes: '60', fee_minor: '', fee_currency: 'EUR' }}
          fields={[
            { key: 'category', label: t('ppw.f.service_cat'), type: 'menu', options: (serviceCategories ?? []).map(v => ({ value: v, label: t(`ppw.service.${v}`) || v })) },
            { key: 'name', label: t('ppw.f.service_name') },
            { key: 'duration_minutes', label: t('ppw.f.duration'), type: 'number' },
            { key: 'fee_minor', label: t('ppw.f.fee'), type: 'number', hint: t('ppw.f.fee_hint') },
            { key: 'fee_currency', label: t('ppw.f.currency') },
          ]}
          onSubmit={x => { setServices(prev => [...prev, { ...x, duration_minutes: Number(x.duration_minutes), fee_minor: Math.round(Number(x.fee_minor) * 100) }]); setAddSvc(false); }}
        />
      )}
    </ScrollView>
  );
}

function PhysioReviewStep({ profile: p, score, onPublish, onRetract, onBack, live, onDone }) {
  const checks = [
    { label: t('ppw.check.identity'), done: !!p.display_name },
    { label: t('ppw.check.licence'), done: !!p.licence_number_enc, required: true },
    { label: t('ppw.check.clinic'), done: !!p.clinic_name },
    { label: t('ppw.check.services'), done: (p.services ?? []).length > 0 },
    { label: t('ppw.check.availability'), done: !!p.appointment_availability },
    { label: t('ppw.check.privacy'), done: !!p.privacy_notice_accepted_at, required: true },
  ];
  const canPublish = checks.filter(ch => ch.required).every(ch => ch.done) && score >= 60;
  const color = score >= 80 ? c.lime : score >= 50 ? c.sun : c.orange;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <T size={17} weight="800">{t('ppw.step.review')}</T>
      <Card style={{ padding: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
          <T size={12} weight="700" color={c.mute}>{t('ppw.completeness.label')}</T>
          <T size={16} weight="800" color={color}>{score}%</T>
        </View>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
          <View style={{ width: `${score}%`, height: 8, borderRadius: 4, backgroundColor: color }} />
        </View>
      </Card>
      {checks.map((ch, i) => (
        <Card key={i} style={{ padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T size={16}>{ch.done ? '✅' : ch.required ? '🔴' : '⚠️'}</T>
          <T size={13} weight="700" color={!ch.done && ch.required ? c.red : c.ink}>{ch.label}</T>
        </Card>
      ))}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        <Btn label={t('ppw.back')} ghost onPress={onBack} style={{ flex: 1 }} />
        {live
          ? <Btn label={t('ppw.retract')} color={c.orange} onPress={onRetract} style={{ flex: 2 }} />
          : <Btn label={t('ppw.publish')} color={c.pink} onPress={onPublish} disabled={!canPublish} style={{ flex: 2 }} />}
      </View>
      {!live && <Btn label={t('ppw.save_draft')} ghost onPress={() => onDone?.()} />}
    </ScrollView>
  );
}
