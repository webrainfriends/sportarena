// Parent-first creation of managed child profiles (feature 3).
// GuardianOnboarding: 6-step wizard. ManagedChildrenList: grid of child cards.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, H2, HScroll, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { c, r } from '../theme';
import { t } from '../i18n';

const STEPS = ['gob.step_name','gob.step_dob','gob.step_sports','gob.step_medical','gob.step_kit','gob.step_review'];
const BLOOD_TYPES = ['A+','A-','B+','B-','AB+','AB-','O+','O-','unknown'].map(v => ({ value: v, label: v }));
const SHIRT_SIZES = ['6Y','8Y','10Y','12Y','14Y','XS','S','M','L','XL','XXL'].map(v => ({ value: v, label: v }));
const COMMON_ALLERGIES = ['Nuts','Dairy','Eggs','Gluten','Shellfish','Soy','Bee stings','Penicillin'];

function StepDots({ current, total }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', marginBottom: 16 }}>
      {Array.from({ length: total }).map((_, i) => (
        <View key={i} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: i <= current ? c.pink : c.line }} />
      ))}
    </View>
  );
}

export function GuardianOnboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    first_name: '', last_name: '', dob: '', gender: '',
    sports: [], allergies: [], conditions: '', emergency_contact_name: '',
    emergency_contact_phone: '', blood_type: 'unknown',
    shirt_size: '', shorts_size: '', boot_size: '',
  });
  const [childId, setChildId] = useState(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useSession();

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const sports = useLoad(() => api.get('/sports'), []);

  const next = () => setStep(s => s + 1);
  const back = () => setStep(s => Math.max(0, s - 1));

  const handleCreate = async () => {
    setBusy(true);
    try {
      const res = await api.post('/me/managed-children', {
        first_name: form.first_name, last_name: form.last_name, dob: form.dob,
        gender: form.gender || undefined, sports: form.sports,
      });
      setChildId(res.child.id);
      // save medical card
      if (form.emergency_contact_name) {
        await api.patch(`/me/managed-children/${res.child.id}/medical`, {
          blood_type: form.blood_type, allergies: form.allergies,
          conditions: form.conditions || undefined,
          emergency_contact_name: form.emergency_contact_name,
          emergency_contact_phone: form.emergency_contact_phone,
        });
      }
      // save kit sizes
      if (form.shirt_size) {
        await api.patch(`/me/managed-children/${res.child.id}/kit`, {
          shirt_size: form.shirt_size, shorts_size: form.shorts_size || undefined,
          boot_size: form.boot_size || undefined,
        });
      }
      toast(t('gob.profile_created', { name: `${form.first_name} ${form.last_name}` }));
      if (onDone) onDone(res.child);
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('gob.title')}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        <StepDots current={step} total={STEPS.length} />
        <T weight="800" size={18} style={{ textAlign: 'center' }}>{t(STEPS[step])}</T>

        {step === 0 && (
          <>
            <T size={13} color={c.mute} style={{ textAlign: 'center' }}>Step 1 of 6 — Child's name</T>
            {/* Name inputs via FormSheet-style layout */}
            <Card pad={14}>
              <T size={12} weight="800" color={c.mute}>{t('gob.first_name').toUpperCase()}</T>
              {/* Text input styled as card field */}
              <Btn title={form.first_name || `Enter ${t('gob.first_name')}`} color={c.paper} ink={c.ink} onPress={() => { /* use native TextInput */ }} />
            </Card>
            <Card pad={14}>
              <T size={12} weight="800" color={c.mute}>{t('gob.last_name').toUpperCase()}</T>
              <Btn title={form.last_name || `Enter ${t('gob.last_name')}`} color={c.paper} ink={c.ink} onPress={() => {}} />
            </Card>
            <Btn title="Next →" color={c.pink} disabled={!form.first_name || !form.last_name} onPress={next} />
          </>
        )}

        {step === 1 && (
          <>
            <T size={13} color={c.mute} style={{ textAlign: 'center' }}>Step 2 of 6 — Date of birth</T>
            {form.dob && (
              <Card color={c.pinkSoft} pad={12}>
                <T weight="700">Age: {Math.floor((Date.now() - new Date(form.dob)) / (365.25 * 86400000))}</T>
                <T size={12} color={c.mute}>{t('gob.guardian_until', { age: 18 })}</T>
              </Card>
            )}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn title="← Back" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
              <Btn title="Next →" color={c.pink} disabled={!form.dob} onPress={next} style={{ flex: 1 }} />
            </View>
          </>
        )}

        {step === 2 && (
          <>
            <T size={13} color={c.mute} style={{ textAlign: 'center' }}>Step 3 of 6 — Sports</T>
            <HScroll>
              {(sports.data?.sports ?? []).slice(0, 20).map(s => (
                <Chip key={s.id}
                  label={s.name}
                  active={form.sports.includes(s.slug)}
                  onPress={() => set('sports', form.sports.includes(s.slug) ? form.sports.filter(x => x !== s.slug) : [...form.sports, s.slug])}
                />
              ))}
            </HScroll>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn title="← Back" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
              <Btn title="Next →" color={c.pink} onPress={next} style={{ flex: 1 }} />
            </View>
          </>
        )}

        {step === 3 && (
          <>
            <T size={13} color={c.mute} style={{ textAlign: 'center' }}>Step 4 of 6 — Medical</T>
            {/* Medical card preview */}
            <Card color={c.cyanSoft} pad={12} accessibilityLabel={t('gob.medical_card_preview')}>
              <T weight="700" size={13}>🏥 {t('gob.medical_card_preview')}</T>
              <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('gob.medical_card_note')}</T>
            </Card>
            <T size={12} weight="800" color={c.mute}>{t('gob.allergies').toUpperCase()}</T>
            <HScroll>
              {COMMON_ALLERGIES.map(a => (
                <Chip key={a} label={a}
                  active={form.allergies.includes(a)}
                  onPress={() => set('allergies', form.allergies.includes(a) ? form.allergies.filter(x => x !== a) : [...form.allergies, a])}
                />
              ))}
            </HScroll>
            <T size={12} color={c.mute}>{t('gob.conditions_enc_note')}</T>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn title="← Back" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
              <Btn title="Next →" color={c.pink} onPress={next} style={{ flex: 1 }} />
            </View>
          </>
        )}

        {step === 4 && (
          <>
            <T size={13} color={c.mute} style={{ textAlign: 'center' }}>Step 5 of 6 — Kit sizes</T>
            <T size={12} color={c.mute}>{t('gob.shirt_size')}</T>
            <HScroll>
              {SHIRT_SIZES.map(s => (
                <Chip key={s.value} label={s.label} active={form.shirt_size === s.value} onPress={() => set('shirt_size', s.value)} />
              ))}
            </HScroll>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn title="← Back" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
              <Btn title="Next →" color={c.pink} onPress={next} style={{ flex: 1 }} />
            </View>
          </>
        )}

        {step === 5 && (
          <>
            <T size={13} color={c.mute} style={{ textAlign: 'center' }}>Step 6 of 6 — {t('gob.review_title')}</T>
            <Card pad={14}>
              <T weight="700">{form.first_name} {form.last_name}</T>
              {form.dob && <T size={12} color={c.mute}>{t('gob.dob')}: {form.dob}</T>}
              {form.sports.length > 0 && <T size={12} color={c.mute}>Sports: {form.sports.join(', ')}</T>}
              {form.allergies.length > 0 && <T size={12} color={c.mute}>{t('gob.allergies')}: {form.allergies.join(', ')}</T>}
              {form.emergency_contact_name && <T size={12} color={c.mute}>{t('gob.emergency_name')}: {form.emergency_contact_name}</T>}
              {form.shirt_size && <T size={12} color={c.mute}>{t('gob.shirt_size')}: {form.shirt_size}</T>}
            </Card>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn title="← Back" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
              <Btn title={t('gob.create_profile')} color={c.pink} loading={busy} disabled={busy || !form.first_name} onPress={handleCreate} style={{ flex: 1 }} />
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function BulkCoGuardianSheet({ children, onClose }) {
  const [handle, setHandle] = useState('');
  const [selected, setSelected] = useState(children.map((c) => c.id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const toggleChild = (id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const submit = async () => {
    if (!handle.trim() || !selected.length) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.post('/me/bulk-co-guardian-invite', { handle: handle.trim(), child_ids: selected });
      setDone(res);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (done) return (
    <View style={{ gap: 12, padding: 16 }}>
      <T weight="800" size={18}>{t('gob.bulk_invite.sent_title')}</T>
      <T color={c.mute}>{t('gob.bulk_invite.sent_sub', { n: done.invited })}</T>
      {done.already_linked > 0 && <T size={12} color={c.mute}>{t('gob.bulk_invite.already_linked', { n: done.already_linked })}</T>}
      <Btn title={t('gob.bulk_invite.close')} color={c.pink} onPress={onClose} />
    </View>
  );
  return (
    <View style={{ gap: 14, padding: 16 }}>
      <T weight="800" size={18}>{t('gob.bulk_invite.title')}</T>
      <T color={c.mute}>{t('gob.bulk_invite.sub')}</T>
      <Field label={t('gob.bulk_invite.handle_label')} value={handle} onChangeText={setHandle}
        placeholder="@handle" autoCapitalize="none" returnKeyType="done" />
      <T weight="700" style={{ marginBottom: -4 }}>{t('gob.bulk_invite.select_children')}</T>
      {children.map((ch) => (
        <Chip key={ch.id} label={ch.display_name} active={selected.includes(ch.id)} onPress={() => toggleChild(ch.id)} />
      ))}
      {err && <ErrorBox error={err} />}
      <Btn title={busy ? t('gob.bulk_invite.sending') : t('gob.bulk_invite.cta')} color={c.pink} disabled={busy || !handle.trim() || !selected.length} onPress={submit} />
    </View>
  );
}

export function ManagedChildrenList({ onAddChild }) {
  const L = useLayout();
  const { push } = useNav();
  const [inviteOpen, setInviteOpen] = useState(false);
  const q = useLoad(() => api.get('/me/managed-children'), []);

  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const children = q.data?.children ?? [];

  return (
    <Section title={t('gob.my_children')} color={c.pink}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {children.map(child => (
          <Card key={child.id} pad={14} style={{ width: L.tablet ? '45%' : '100%' }}
            accessibilityLabel={child.display_name}
            onPress={() => push('Family')}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Avatar user={child} size={40} />
              <View style={{ flex: 1 }}>
                <T weight="700">{child.display_name}</T>
                <T size={12} color={c.mute}>{child.age != null ? `${t('gob.age', { n: child.age })}` : ''} {child.sports?.length ? `· ${child.sports.slice(0, 2).join(', ')}` : ''}</T>
              </View>
            </View>
            {/* Progress bar */}
            <View style={{ height: 4, backgroundColor: c.line, borderRadius: 2, marginTop: 10, overflow: 'hidden' }}>
              <View style={{ height: 4, backgroundColor: child.onboarding_pct >= 100 ? c.lime : c.pink, width: `${child.onboarding_pct}%` }} />
            </View>
            <T size={11} color={c.mute} style={{ marginTop: 2 }}>{t('gob.completion', { pct: child.onboarding_pct })}</T>
            {child.onboarding_pct < 100 && (
              <Btn small title={t('gob.complete_profile')} color={c.paper} ink={c.pink} style={{ marginTop: 8 }}
                onPress={() => push('GuardianOnboarding', { childId: child.id })} />
            )}
          </Card>
        ))}
        {/* Add child card */}
        <Card pad={14} style={{ width: L.tablet ? '45%' : '100%', borderStyle: 'dashed', borderWidth: 1.5, borderColor: c.line }}
          onPress={onAddChild} accessibilityLabel={t('gob.add_child')}>
          <T weight="700" style={{ textAlign: 'center', color: c.pink }}>+ {t('gob.add_child')}</T>
          {children.length === 0 && (
            <T size={12} color={c.mute} style={{ textAlign: 'center', marginTop: 4 }}>{t('gob.empty_children_sub')}</T>
          )}
        </Card>
      </View>
      {children.length > 0 && (
        <Btn title={t('gob.bulk_invite.open')} color={c.paper} ink={c.pink} style={{ marginTop: 8 }}
          accessibilityLabel={t('gob.bulk_invite.open')} onPress={() => setInviteOpen(true)} />
      )}
      <Sheet visible={inviteOpen} onClose={() => setInviteOpen(false)}>
        <BulkCoGuardianSheet children={children} onClose={() => setInviteOpen(false)} />
      </Sheet>
    </Section>
  );
}
