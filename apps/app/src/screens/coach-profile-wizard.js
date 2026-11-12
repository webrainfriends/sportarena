// Coach profile wizard (#1126): 7-step self-declaration profile for coach roles.
// Patterned on official-profile-wizard.js. Auto-saves each step; resumable from step_reached.
import React, { useState, useEffect } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, ErrorBox, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Stepper } from '../pickers';
import { CountryPicker } from '../country-picker';
import { c, r } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';

const STEP_KEYS = ['identity', 'sports', 'experience', 'availability', 'offerings', 'payout', 'review'];

function CompletenessBar({ score }) {
  const pct = score ?? 0;
  const fillColor = pct >= 80 ? c.lime : pct >= 50 ? c.sun : c.orange;
  return (
    <View
      style={{ marginHorizontal: 20, marginBottom: 8, padding: 10, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line }}
      accessible
      accessibilityLabel={t('cpw.completeness.a11y', { pct })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
        <T size={11} weight="700" color={c.mute}>{t('cpw.completeness.label')}</T>
        <T size={13} weight="800" color={fillColor}>{pct}%</T>
      </View>
      <View style={{ height: 7, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 7, borderRadius: 4, backgroundColor: fillColor }} />
      </View>
    </View>
  );
}

export function CoachProfileWizard({ onClose: closeProp, onDone, toast: toastProp, stepReached: initialStep = 0 }) {
  const nav = useNav();
  const session = useSession();
  const onClose = closeProp ?? nav.back;
  const toast = toastProp ?? session.toast;
  const opt = useLoad(() => api.get('/me/coach-profile/options'), []);
  const existing = useLoad(() => api.get('/me/coach-profile').catch(e => e?.status === 404 ? null : Promise.reject(e)), []);
  const completeness = useLoad(() => api.get('/me/coach-profile/completeness').catch(() => ({ score: 0, checks: [] })), []);

  const [profile, setProfile] = useState(null);
  const [step, setStep] = useState(0);
  const [score, setScore] = useState(0);

  useEffect(() => {
    if (existing.data !== undefined && !profile) {
      if (existing.data) {
        setProfile(existing.data);
        setStep(Math.max(existing.data.step_reached ?? 0, initialStep));
      }
    }
  }, [existing.data]);

  useEffect(() => {
    if (completeness.data?.score != null) setScore(completeness.data.score);
  }, [completeness.data]);

  if (opt.error || existing.error) return (
    <Sheet visible onClose={onClose} title={t('cpw.title')}>
      <ErrorBox error={opt.error || existing.error} onRetry={() => { opt.reload(); existing.reload(); }} />
    </Sheet>
  );
  if (!opt.data || existing.data === undefined) return <Sheet visible onClose={onClose} title={t('cpw.title')}><Loading /></Sheet>;

  const O = opt.data;
  const p = profile ?? {};
  const live = p.status === 'published';

  const refreshScore = async () => {
    try { const res = await api.get('/me/coach-profile/completeness'); if (res?.score != null) setScore(res.score); } catch (_) {}
  };

  const save = async (patch, to) => {
    try {
      const row = await api.post('/me/coach-profile', {
        ...(p.row_version != null ? { row_version: p.row_version } : {}),
        ...patch,
        step_reached: Math.max(p.step_reached ?? 0, (to ?? step) + 1),
      });
      setProfile(row);
      toast?.(t('cpw.saved'));
      if (to != null) setStep(to);
      refreshScore();
      return row;
    } catch (e) { throw new Error(explain(e)); }
  };

  const back = () => setStep(s => Math.max(0, s - 1));
  const nextLabel = (k) => t('cpw.next_to', { step: t(`cpw.step.${STEP_KEYS[k]}`) });
  const sportOpts = (O.sports ?? []).map(s => ({ value: s.id, label: `${s.emoji ?? '🏅'} ${s.name}` }));

  const publish = async () => {
    try {
      const row = await api.post('/me/coach-profile/publish');
      setProfile(row);
      toast?.(t('cpw.published'));
      onDone?.();
    } catch (e) { toast?.(explain(e)); }
  };

  const retract = async () => {
    try {
      const row = await api.post('/me/coach-profile/retract');
      setProfile(row);
      toast?.(t('cpw.retracted'));
    } catch (e) { toast?.(explain(e)); }
  };

  return (
    <Sheet visible onClose={onClose} title={t('cpw.title')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <T size={12} color={c.mute} style={{ flex: 1 }}>{t('cpw.step_n', { n: step + 1, m: STEP_KEYS.length })} · {t(`cpw.step.${STEP_KEYS[step]}`)}</T>
        <Tag label={t(`cpw.status.${p.status ?? 'draft'}`)} color={live ? c.limeSoft : c.sunSoft} />
      </View>
      <Stepper steps={STEP_KEYS.map(k => t(`cpw.step.${k}`))} current={step} onJump={i => { if (p.id || i === 0) setStep(i); }} />
      <CompletenessBar score={score} />

      {step === 0 && (
        <View style={{ gap: 14 }}>
          <CountryPicker label={t('cpw.f.nationality')} value={p.nationality_code ?? ''} onChange={v => save({ nationality_code: v })} optional />
          <FormSheet inline visible
            initial={{ display_name_pref: p.display_name_pref ?? '', bio: p.bio ?? '', pronouns: p.pronouns ?? '', coaching_since: p.coaching_since ? String(p.coaching_since) : '' }}
            submitLabel={nextLabel(1)}
            onClose={() => {}}
            fields={[
              { key: 'display_name_pref', label: t('cpw.f.display_name'), hint: t('cpw.f.display_name_hint') },
              { key: 'bio', label: t('cpw.f.bio'), type: 'multiline', optional: true, hint: t('cpw.f.bio_hint') },
              { key: 'pronouns', label: t('cpw.f.pronouns'), type: 'chips', options: (O.pronouns ?? []).map(v => ({ value: v, label: t(`cpw.pronoun.${v}`) })), optional: true },
              { key: 'coaching_since', label: t('cpw.f.coaching_since'), type: 'number', optional: true, hint: t('cpw.f.coaching_since_hint') },
            ]}
            onSubmit={async x => { await save({ display_name_pref: x.display_name_pref || undefined, bio: x.bio || undefined, pronouns: x.pronouns || null, coaching_since: x.coaching_since ? Number(x.coaching_since) : undefined }, 1); }}
          />
        </View>
      )}

      {step === 1 && (
        <SportQualStep profile={p} sportOpts={sportOpts} levelOpts={O.levels} qualKinds={O.qual_kinds} onSave={save} onBack={back} nextLabel={nextLabel(2)} />
      )}
      {step === 2 && (
        <ExperienceRefStep profile={p} onSave={save} onBack={back} nextLabel={nextLabel(3)} />
      )}
      {step === 3 && (
        <AvailabilityStep profile={p} onSave={save} onBack={back} nextLabel={nextLabel(4)} />
      )}
      {step === 4 && (
        <OfferingsStep profile={p} offeringTypes={O.offering_types} onSave={save} onBack={back} nextLabel={nextLabel(5)} />
      )}
      {step === 5 && (
        <PayoutStep profile={p} payoutMethods={O.payout_methods} onSave={save} onBack={back} nextLabel={nextLabel(6)} />
      )}
      {step === 6 && (
        <ReviewStep profile={p} score={score} onPublish={publish} onRetract={retract} onBack={back} live={live} onDone={onDone} />
      )}
    </Sheet>
  );
}

function SportQualStep({ profile: p, sportOpts, levelOpts, qualKinds, onSave, onBack, nextLabel }) {
  const [sports, setSports] = useState(p.sports ?? []);
  const [quals, setQuals] = useState(p.qualifications ?? []);
  const [addSport, setAddSport] = useState(false);
  const [addQual, setAddQual] = useState(null);
  const { toast } = useSession();

  const submit = async () => {
    try { await onSave({ sports, qualifications: quals }, 2); } catch (e) { toast(e.message); }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <T size={17} weight="800">{t('cpw.step.sports')}</T>
      <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{t('cpw.sports.hint')}</T>
      {sports.map((s, i) => {
        const sport = sportOpts.find(o => o.value === s.sport_id);
        return (
          <Card key={i} style={{ padding: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <T size={15} weight="700">{sport?.label ?? s.sport_id}</T>
              {s.primary_sport && <Tag label={t('cpw.primary')} color={c.pinkSoft} />}
            </View>
            <T size={12} color={c.mute}>{t(`cpw.level.${s.level}`) || s.level} · {s.coaching_since_year ?? ''}</T>
            {quals.filter(q => q.sport_id === s.sport_id).map((q, qi) => (
              <View key={qi} style={{ marginTop: 8, backgroundColor: c.violetSoft, borderRadius: 10, padding: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <T size={13} weight="700">{q.title}</T>
                  <T size={11} color={c.mute}>{q.issuing_body ?? ''}{q.expiry_year ? ` · ${t('cpw.expires')} ${q.expiry_year}` : ''}</T>
                </View>
                {(!q.expiry_year || q.expiry_year >= new Date().getFullYear()) ? <Tag label={t('cpw.active')} color={c.limeSoft} /> : <Tag label={t('cpw.expired')} color={c.orangeSoft} />}
              </View>
            ))}
            <Btn label={t('cpw.add_qual')} ghost icon="Plus" small onPress={() => setAddQual(s.sport_id)} style={{ marginTop: 8 }} />
          </Card>
        );
      })}
      <Btn label={t('cpw.add_sport')} ghost icon="Plus" onPress={() => setAddSport(true)} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Btn label={t('cpw.back')} ghost onPress={onBack} style={{ flex: 1 }} />
        <Btn label={nextLabel} color={c.pink} onPress={submit} style={{ flex: 2 }} />
      </View>
      {addSport && (
        <FormSheet visible title={t('cpw.add_sport')} onClose={() => setAddSport(false)}
          initial={{ sport_id: '', level: 'national', primary_sport: sports.length === 0, coaching_since_year: '' }}
          fields={[
            { key: 'sport_id', label: t('cpw.f.sport'), type: 'menu', options: sportOpts },
            { key: 'level', label: t('cpw.f.level'), type: 'menu', options: (levelOpts ?? []).map(v => ({ value: v, label: v })) },
            { key: 'coaching_since_year', label: t('cpw.f.since'), type: 'number', optional: true },
          ]}
          onSubmit={x => { setSports(prev => [...prev, { sport_id: x.sport_id, level: x.level, primary_sport: x.primary_sport, coaching_since_year: x.coaching_since_year ? Number(x.coaching_since_year) : undefined }]); setAddSport(false); }}
        />
      )}
      {addQual && (
        <FormSheet visible title={t('cpw.add_qual')} onClose={() => setAddQual(null)}
          initial={{ kind: 'licence', title: '', issuing_body: '', issue_year: '', expiry_year: '', licence_number: '' }}
          fields={[
            { key: 'kind', label: t('cpw.f.qual_kind'), type: 'menu', options: (qualKinds ?? []).map(v => ({ value: v, label: v })) },
            { key: 'title', label: t('cpw.f.qual_title') },
            { key: 'issuing_body', label: t('cpw.f.issuing_body'), optional: true },
            { key: 'expiry_year', label: t('cpw.f.expiry_year'), type: 'number', optional: true },
            { key: 'licence_number', label: t('cpw.f.licence_number'), type: 'password', optional: true, hint: t('cpw.f.licence_hint') },
          ]}
          onSubmit={x => { setQuals(prev => [...prev, { ...x, sport_id: addQual, issue_year: x.issue_year ? Number(x.issue_year) : undefined, expiry_year: x.expiry_year ? Number(x.expiry_year) : undefined }]); setAddQual(null); }}
        />
      )}
    </ScrollView>
  );
}

function ExperienceRefStep({ profile: p, onSave, onBack, nextLabel }) {
  const [exp, setExp] = useState(p.experience ?? []);
  const [refs, setRefs] = useState(p.references_data ?? []);
  const [addExp, setAddExp] = useState(false);
  const [addRef, setAddRef] = useState(false);
  const { toast } = useSession();

  const submit = async () => {
    try { await onSave({ experience: exp, references_data: refs }, 3); } catch (e) { toast(e.message); }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <T size={17} weight="800">{t('cpw.step.experience')}</T>
      <T size={13} color={c.mute}>{t('cpw.exp.hint')}</T>
      {exp.map((e, i) => (
        <Card key={i} style={{ padding: 12 }}>
          <T size={14} weight="700">{e.role_title}</T>
          <T size={12} color={c.mute}>{e.organisation} · {e.from_year}–{e.is_current ? t('cpw.present') : (e.to_year ?? '')}</T>
          {e.achievements ? <T size={12} color={c.ink} style={{ marginTop: 4 }}>{e.achievements}</T> : null}
        </Card>
      ))}
      <Btn label={t('cpw.add_experience')} ghost icon="Plus" onPress={() => setAddExp(true)} />
      <T size={11} weight="700" color={c.mute} style={{ marginTop: 8, textTransform: 'uppercase', letterSpacing: 1 }}>{t('cpw.references')}</T>
      <T size={12} color={c.mute}>{t('cpw.refs.hint')}</T>
      {refs.map((ref, i) => (
        <Card key={i} style={{ padding: 12 }}>
          <T size={14} weight="700">{ref.name}</T>
          <T size={12} color={c.mute}>{ref.role_title} · {ref.organisation}</T>
          {ref.consent_given && <Tag label={t('cpw.consent_given')} color={c.limeSoft} style={{ marginTop: 4 }} />}
        </Card>
      ))}
      {refs.length < 3 && <Btn label={t('cpw.add_reference')} ghost icon="Plus" onPress={() => setAddRef(true)} />}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Btn label={t('cpw.back')} ghost onPress={onBack} style={{ flex: 1 }} />
        <Btn label={nextLabel} color={c.pink} onPress={submit} style={{ flex: 2 }} />
      </View>
      {addExp && (
        <FormSheet visible title={t('cpw.add_experience')} onClose={() => setAddExp(false)}
          initial={{ role_title: '', organisation: '', from_year: '', to_year: '', is_current: false, achievements: '' }}
          fields={[
            { key: 'role_title', label: t('cpw.f.role_title') },
            { key: 'organisation', label: t('cpw.f.organisation') },
            { key: 'from_year', label: t('cpw.f.from_year'), type: 'number' },
            { key: 'is_current', label: t('cpw.f.is_current'), type: 'switch' },
            { key: 'to_year', label: t('cpw.f.to_year'), type: 'number', optional: true },
            { key: 'achievements', label: t('cpw.f.achievements'), type: 'multiline', optional: true },
          ]}
          onSubmit={x => { setExp(prev => [...prev, { ...x, from_year: Number(x.from_year), to_year: x.to_year ? Number(x.to_year) : undefined }]); setAddExp(false); }}
        />
      )}
      {addRef && (
        <FormSheet visible title={t('cpw.add_reference')} onClose={() => setAddRef(false)}
          initial={{ name: '', role_title: '', organisation: '', contact_email: '', consent_given: false }}
          fields={[
            { key: 'name', label: t('cpw.f.ref_name') },
            { key: 'role_title', label: t('cpw.f.role_title') },
            { key: 'organisation', label: t('cpw.f.organisation') },
            { key: 'contact_email', label: t('cpw.f.email'), type: 'email', optional: true },
            { key: 'consent_given', label: t('cpw.f.ref_consent'), type: 'switch', hint: t('cpw.f.ref_consent_hint') },
          ]}
          onSubmit={x => { setRefs(prev => [...prev, x]); setAddRef(false); }}
        />
      )}
    </ScrollView>
  );
}

function AvailabilityStep({ profile: p, onSave, onBack, nextLabel }) {
  const { toast } = useSession();
  const submit = async (x) => {
    try {
      await onSave({ availability: { remote_available: x.remote_available, travel_radius_km: x.travel_radius_km ? Number(x.travel_radius_km) : undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }, 4);
    } catch (e) { toast(e.message); }
  };
  const av = p.availability ?? {};
  return (
    <FormSheet inline visible
      initial={{ remote_available: av.remote_available ?? false, travel_radius_km: av.travel_radius_km ? String(av.travel_radius_km) : '' }}
      submitLabel={nextLabel}
      onBack={onBack}
      onClose={() => {}}
      fields={[
        { key: 'remote_available', label: t('cpw.f.remote'), type: 'switch', hint: t('cpw.f.remote_hint') },
        { key: 'travel_radius_km', label: t('cpw.f.travel_radius'), type: 'number', optional: true, hint: t('cpw.f.travel_hint') },
      ]}
      onSubmit={submit}
    />
  );
}

function OfferingsStep({ profile: p, offeringTypes, onSave, onBack, nextLabel }) {
  const [offerings, setOfferings] = useState(p.offerings ?? []);
  const [addOff, setAddOff] = useState(false);
  const { toast } = useSession();
  const submit = async () => {
    try { await onSave({ offerings }, 5); } catch (e) { toast(e.message); }
  };
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <T size={17} weight="800">{t('cpw.step.offerings')}</T>
      <T size={13} color={c.mute}>{t('cpw.offerings.hint')}</T>
      {offerings.map((o, i) => (
        <Card key={i} style={{ padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View>
            <T size={14} weight="700">{t(`cpw.offering.${o.type}`) || o.type}</T>
            <T size={12} color={c.mute}>{o.duration_minutes} min · {o.fee_currency} {(o.fee_minor / 100).toFixed(2)}</T>
          </View>
          {o.remote_available && <Tag label={t('cpw.remote')} color={c.cyanSoft} />}
        </Card>
      ))}
      <Btn label={t('cpw.add_offering')} ghost icon="Plus" onPress={() => setAddOff(true)} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Btn label={t('cpw.back')} ghost onPress={onBack} style={{ flex: 1 }} />
        <Btn label={nextLabel} color={c.pink} onPress={submit} style={{ flex: 2 }} />
      </View>
      {addOff && (
        <FormSheet visible title={t('cpw.add_offering')} onClose={() => setAddOff(false)}
          initial={{ type: 'individual', duration_minutes: '60', fee_minor: '', fee_currency: 'EUR', remote_available: false, trial_available: false }}
          fields={[
            { key: 'type', label: t('cpw.f.offering_type'), type: 'menu', options: (offeringTypes ?? []).map(v => ({ value: v, label: t(`cpw.offering.${v}`) || v })) },
            { key: 'duration_minutes', label: t('cpw.f.duration'), type: 'number' },
            { key: 'fee_minor', label: t('cpw.f.fee'), type: 'number', hint: t('cpw.f.fee_hint') },
            { key: 'fee_currency', label: t('cpw.f.currency'), hint: 'e.g. EUR, USD, GBP' },
            { key: 'remote_available', label: t('cpw.f.remote'), type: 'switch' },
            { key: 'trial_available', label: t('cpw.f.trial'), type: 'switch' },
          ]}
          onSubmit={x => { setOfferings(prev => [...prev, { ...x, duration_minutes: Number(x.duration_minutes), fee_minor: Math.round(Number(x.fee_minor) * 100) }]); setAddOff(false); }}
        />
      )}
    </ScrollView>
  );
}

function PayoutStep({ profile: p, payoutMethods, onSave, onBack, nextLabel }) {
  const { toast } = useSession();
  const submit = async (x) => {
    try {
      await onSave({ payout_method: x.payout_method || undefined, tax_country: x.tax_country || undefined, bank_name: x.bank_name || undefined, bank_account: x.bank_account || undefined, bank_routing: x.bank_routing || undefined }, 6);
    } catch (e) { toast(e.message); }
  };
  return (
    <FormSheet inline visible
      initial={{ payout_method: p.payout_method ?? '', tax_country: p.tax_country ?? '', bank_name: '', bank_account: '', bank_routing: '' }}
      submitLabel={nextLabel}
      onBack={onBack}
      onClose={() => {}}
      fields={[
        { key: 'payout_method', label: t('cpw.f.payout_method'), type: 'menu', options: (payoutMethods ?? []).map(v => ({ value: v, label: t(`cpw.payout.${v}`) || v })), optional: true },
        { key: 'tax_country', label: t('cpw.f.tax_country'), optional: true },
        { key: 'bank_name', label: t('cpw.f.bank_name'), optional: true },
        { key: 'bank_account', label: t('cpw.f.bank_account'), type: 'password', optional: true, hint: t('cpw.f.bank_enc_hint') },
        { key: 'bank_routing', label: t('cpw.f.bank_routing'), type: 'password', optional: true, hint: t('cpw.f.bank_enc_hint') },
      ]}
      onSubmit={submit}
    />
  );
}

function ReviewStep({ profile: p, score, onPublish, onRetract, onBack, live, onDone }) {
  const checks = [
    { label: t('cpw.check.identity'), done: !!p.display_name_pref },
    { label: t('cpw.check.sports'), done: (p.sports ?? []).length > 0 },
    { label: t('cpw.check.experience'), done: (p.experience ?? []).length > 0 },
    { label: t('cpw.check.availability'), done: !!p.availability },
    { label: t('cpw.check.offerings'), done: (p.offerings ?? []).length > 0 },
    { label: t('cpw.check.payout'), done: !!p.payout_method, optional: true },
  ];
  const color = score >= 80 ? c.lime : score >= 50 ? c.sun : c.orange;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <T size={17} weight="800">{t('cpw.step.review')}</T>
      <Card style={{ padding: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
          <T size={12} weight="700" color={c.mute}>{t('cpw.completeness.label')}</T>
          <T size={16} weight="800" color={color}>{score}%</T>
        </View>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
          <View style={{ width: `${score}%`, height: 8, borderRadius: 4, backgroundColor: color }} />
        </View>
        <T size={11} color={c.mute} style={{ marginTop: 6 }}>{score >= 60 ? t('cpw.ready_to_publish') : t('cpw.not_ready', { needed: 60 - score })}</T>
      </Card>
      {checks.map((ch, i) => (
        <Card key={i} style={{ padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T size={16}>{ch.done ? '✅' : ch.optional ? '⚠️' : '❌'}</T>
          <View>
            <T size={13} weight="700" color={!ch.done && !ch.optional ? c.red : c.ink}>{ch.label}</T>
            {!ch.done && ch.optional && <T size={11} color={c.mute}>{t('cpw.optional_ok')}</T>}
          </View>
        </Card>
      ))}
      <Card style={{ padding: 14 }}>
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 8 }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T size={20}>👤</T></View>
          <View>
            <T size={16} weight="800">{p.display_name_pref ?? t('cpw.unnamed')}</T>
            <T size={12} color={c.mute}>{t('cpw.preview.subtitle', { since: p.coaching_since ?? '–' })}</T>
          </View>
        </View>
        {p.bio ? <T size={13} numberOfLines={3}>{p.bio}</T> : null}
      </Card>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        <Btn label={t('cpw.back')} ghost onPress={onBack} style={{ flex: 1 }} />
        {live
          ? <Btn label={t('cpw.retract')} color={c.orange} onPress={onRetract} style={{ flex: 2 }} />
          : <Btn label={t('cpw.publish')} color={c.pink} onPress={onPublish} disabled={score < 60} style={{ flex: 2 }} />}
      </View>
      {!live && <Btn label={t('cpw.save_draft')} ghost onPress={() => onDone?.()} />}
    </ScrollView>
  );
}
