// Sponsor wizard (#1126): 5-step first-time sponsor entity setup.
import React, { useState, useEffect } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, ErrorBox, Loading, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, r } from '../theme';
import { explain } from '../access';
import { t } from '../i18n';
import { useNav } from '../nav';
import { useSession } from '../session';
import { CountryPicker } from '../country-picker';

const STEP_KEYS = ['entity_type','brand_identity','contact_billing','authorised_reps','review'];
const ENTITY_TYPES = ['company','charity','individual','partnership','government_body'];

export function SponsorWizard({ onClose: close, onDone, toast: say }) {
  const nav = useNav();
  const session = useSession();
  const onClose = close ?? nav.back;
  const toast = say ?? session.toast;

  const existing = useLoad(() => api.get('/me/sponsor/entities').catch(() => null), []);
  const [step, setStep] = useState(0);
  const [entity, setEntity] = useState(null);
  const [saving, setSaving] = useState(false);
  const [country, setCountry] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [form0, setForm0] = useState({ entity_type: 'company' });
  const [form1, setForm1] = useState({ legal_name: '', trading_name: '', reg_number: '', vat_number: '' });
  const [form2, setForm2] = useState({ contact_email: '', contact_phone: '', billing_address: '' });

  useEffect(() => {
    if (existing.data) {
      const ents = Array.isArray(existing.data) ? existing.data : (existing.data?.entities ?? []);
      if (ents.length > 0) {
        setEntity(ents[0]);
        setStep(ents[0].identity_confirmed ? 4 : 1);
        setForm1({ legal_name: ents[0].legal_name ?? '', trading_name: ents[0].trading_name ?? '', reg_number: ents[0].reg_number ?? '', vat_number: '' });
      }
    }
  }, [existing.data]);

  const save = async (patch, to) => {
    setSaving(true);
    try {
      let row;
      if (!entity) {
        row = await api.post('/me/sponsor/entities', patch);
      } else {
        row = await api.patch(`/me/sponsor/entities/${entity.id}`, patch);
      }
      setEntity(row?.entity ?? row);
      toast?.(t('spw.saved'));
      if (to != null) setStep(to);
      return row;
    } catch (e) { throw new Error(explain(e)); } finally { setSaving(false); }
  };

  if (existing.error) return (
    <Sheet visible onClose={onClose} title={t('spw.title')}>
      <ErrorBox error={existing.error} onRetry={existing.reload} />
    </Sheet>
  );
  if (existing.data === undefined) return (
    <Sheet visible onClose={onClose} title={t('spw.title')}><Loading /></Sheet>
  );

  const ent = entity ?? {};
  const stepTitle = t(`spw.step.${STEP_KEYS[step]}`);

  const steps = [
    // Step 0: Entity Type
    () => (
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <T size={22} weight="900" color={c.ink} style={{ marginBottom: 6 }}>{t('spw.step.entity_type')}</T>
        <T size={13} color={c.mute} style={{ marginBottom: 20 }}>{t('spw.et.hint')}</T>
        {ENTITY_TYPES.map((et) => (
          <Pressable key={et} onPress={() => setForm0((f) => ({ ...f, entity_type: et }))}
            style={{ marginBottom: 10, padding: 16, borderRadius: r.card, borderWidth: 2, borderColor: form0.entity_type === et ? c.pink : c.line, backgroundColor: form0.entity_type === et ? c.pinkSoft : c.paper }}
            accessible accessibilityRole="radio" accessibilityState={{ checked: form0.entity_type === et }}>
            <T size={15} weight="700" color={c.ink}>{t(`spw.entityType.${et}`)}</T>
            <T size={12} color={c.mute}>{t(`spw.entityType.${et}Desc`)}</T>
          </Pressable>
        ))}
        <Btn label={t('cpw.next')} loading={saving} onPress={() => save({ entity_type: form0.entity_type }, 1)} style={{ marginTop: 16 }} />
      </ScrollView>
    ),
    // Step 1: Brand & Legal Identity
    () => (
      <FormSheet title={t('spw.step.brand_identity')} step={1} totalSteps={5} saving={saving}
        fields={[
          { key: 'legal_name', label: t('spw.bi.legalName'), value: form1.legal_name, onChange: (v) => setForm1((f) => ({ ...f, legal_name: v })), required: true },
          { key: 'trading_name', label: t('spw.bi.tradingName'), value: form1.trading_name, onChange: (v) => setForm1((f) => ({ ...f, trading_name: v })), hint: t('spw.bi.tradingNameHint') },
          { key: 'reg_number', label: t('spw.bi.regNumber'), value: form1.reg_number, onChange: (v) => setForm1((f) => ({ ...f, reg_number: v })) },
          { key: 'vat_number', label: t('spw.bi.vatNumber'), value: form1.vat_number, onChange: (v) => setForm1((f) => ({ ...f, vat_number: v })) },
        ]}
        extraContent={<View style={{ marginTop: 12 }}><CountryPicker value={country} onChange={setCountry} label={t('spw.bi.country')} /></View>}
        onNext={() => save({ ...form1, reg_country: country }, 2)}
      />
    ),
    // Step 2: Contact & Billing
    () => (
      <FormSheet title={t('spw.step.contact_billing')} step={2} totalSteps={5} saving={saving}
        fields={[
          { key: 'contact_email', label: t('spw.cb.email'), value: form2.contact_email, onChange: (v) => setForm2((f) => ({ ...f, contact_email: v })), keyboardType: 'email-address' },
          { key: 'contact_phone', label: t('spw.cb.phone'), value: form2.contact_phone, onChange: (v) => setForm2((f) => ({ ...f, contact_phone: v })), keyboardType: 'phone-pad' },
          { key: 'billing_address', label: t('spw.cb.billing'), value: form2.billing_address, onChange: (v) => setForm2((f) => ({ ...f, billing_address: v })), multiline: true },
        ]}
        onNext={() => save(form2, 3)}
      />
    ),
    // Step 3: Authorised Reps
    () => (
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <T size={22} weight="900" color={c.ink} style={{ marginBottom: 4 }}>{t('spw.step.authorised_reps')}</T>
        <T size={13} color={c.mute} style={{ marginBottom: 16 }}>{t('spw.ar.hint')}</T>
        <Card style={{ marginBottom: 12 }}>
          <T size={13} weight="700" color={c.ink}>{t('spw.ar.youAreRep')}</T>
          <T size={12} color={c.mute}>{t('spw.ar.youAreRepBody')}</T>
        </Card>
        <T size={12} color={c.mute} style={{ marginBottom: 16 }}>{t('spw.ar.additionalRepsNote')}</T>
        <Btn label={t('cpw.next')} loading={saving} onPress={() => save({}, 4)} />
      </ScrollView>
    ),
    // Step 4: Review & Confirm
    () => {
      const [confirming, setConfirming] = useState(false);
      const handleConfirm = async () => {
        setConfirming(true); setSubmitError(null);
        try {
          await api.post(`/me/sponsor/entities/${ent.id}/confirm-identity`, {});
          toast?.(t('spw.confirmed'));
          onDone?.();
          onClose();
        } catch (e) { setSubmitError(explain(e)); } finally { setConfirming(false); }
      };
      return (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <T size={22} weight="900" color={c.ink} style={{ marginBottom: 4 }}>{t('spw.step.review')}</T>
          <T size={13} color={c.mute} style={{ marginBottom: 16 }}>{t('spw.rv.hint')}</T>
          <Card style={{ marginBottom: 12 }}>
            <T size={13} weight="700" color={c.ink}>{t('spw.rv.entityType')}</T>
            <T size={12} color={c.mute}>{ent.entity_type ? t(`spw.entityType.${ent.entity_type}`) : '—'}</T>
          </Card>
          <Card style={{ marginBottom: 12 }}>
            <T size={13} weight="700" color={c.ink}>{t('spw.rv.legalName')}</T>
            <T size={12} color={c.mute}>{ent.legal_name ?? '—'}</T>
          </Card>
          {submitError && <ErrorBox error={submitError} style={{ marginBottom: 12 }} />}
          <Btn label={t('spw.rv.confirm')} loading={confirming} onPress={handleConfirm} />
        </ScrollView>
      );
    },
  ];

  const StepComponent = steps[step] ?? steps[4];

  return (
    <Sheet visible onClose={onClose} title={t('spw.title')} subtitle={`${t('spw.stepOf', { n: step + 1, total: 5 })} · ${stepTitle}`}>
      <View style={{ flexDirection: 'row', paddingHorizontal: 20, marginBottom: 12, gap: 4 }}>
        {STEP_KEYS.map((k, i) => (
          <Btn key={k} label={String(i + 1)} variant={i === step ? 'primary' : i < step ? 'ghost' : 'outline'}
            onPress={() => i <= step && setStep(i)}
            style={{ minWidth: 32, paddingHorizontal: 8 }} />
        ))}
      </View>
      <StepComponent />
    </Sheet>
  );
}
