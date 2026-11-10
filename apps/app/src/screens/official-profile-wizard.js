// Official profile onboarding wizard (#991 R00 + godmode): 10-step self-declaration wizard for referee and official roles.
// Auto-saves after every step; resumable from any step_reached. PII never shown in fields — encrypted server-side.
// Godmode additions: CompletenessBar, compliance checklist in Step 4, multi-lang bio in Step 0, portfolio in Step 9.
import React, { useState, useEffect } from 'react';
import { View, Animated } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Stepper } from '../pickers';
import { c } from '../theme';
import { explain } from '../access';
import { t } from '../i18n';
import { useNav } from '../nav';
import { useSession } from '../session';
import { CountryPicker, countryName } from '../country-picker';
import { deviceZone } from '../locale';
import { money } from '../federation-ui';

const PLATFORM_LANGS = ['es','hi','ta','te','ml','mr','kn','bn','or','si','ur','id'];
const LANG_LABELS = { es:'Español',hi:'हिन्दी',ta:'தமிழ்',te:'తెలుగు',ml:'മലയാളം',mr:'मराठी',kn:'ಕನ್ನಡ',bn:'বাংলা',or:'ଓଡ଼ିଆ',si:'සිංහල',ur:'اردو',id:'Bahasa' };
const COMPLIANCE_KINDS = ['dbs_police','safeguarding','fitness_test','insurance','anti_corruption','medical'];
const COMPLIANCE_ICONS = { dbs_police:'🪪', safeguarding:'🛡️', fitness_test:'🏃', insurance:'📋', anti_corruption:'⚖️', medical:'🩺', other_compliance:'📄' };
const PORTFOLIO_KINDS = ['video','article','match_report','interview','other'];

const STEP_KEYS = ['identity','privacy','sports','experience','credentials','references','availability','rates','payout','review'];
const ROLE_OPTS = ['referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee'];
const LEVEL_OPTS = ['grassroots','local','district','county','regional','national','international','olympic'];
const KIND_OPTS = ['licence','certification','course','badge','clearance','first_aid','fitness','safeguarding','other'];
const FIX_TYPES = ['training','friendly','cup','league','tournament','international','other'];
const REL_OPTS = ['governing_body','club','association','colleague','employer','other'];
const YEAR = new Date().getFullYear();

const iso = (v) => (/^[A-Z]{2}$/.test(v ?? '') ? v : '');

// ---------------------------------------------------------------- CompletenessBar
function CompletenessBar({ score }) {
  const pct = score ?? 0;
  const fillColor = pct >= 80 ? c.lime : pct >= 50 ? c.sun : c.orange;
  return (
    <View style={{ marginHorizontal: 20, marginBottom: 8, padding: 10, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line }}
      accessible accessibilityLabel={t('opw.completeness.a11y', { pct })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
        <T size={11} weight="700" color={c.mute}>{t('opw.completeness.label')}</T>
        <T size={13} weight="800" color={fillColor}>{pct}%</T>
      </View>
      <View style={{ height: 7, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 7, borderRadius: 4, backgroundColor: fillColor }} />
      </View>
    </View>
  );
}

export function OfficialProfileWizard({ onClose: close, onDone, toast: say, onOpen }) {
  const nav = useNav();
  const session = useSession();
  const onClose = close ?? nav.back;
  const toast = say ?? session.toast;
  const leave = (route, params) => { if (onOpen) onOpen(route, params); else nav.push(route, params); };
  const [nat, setNat] = useState(null), [taxCountry, setTaxCountry] = useState(null);
  const opt = useLoad(() => api.get('/me/official-profile/options'), []);
  const existing = useLoad(() => api.get('/me/official-profile').catch((e) => (e?.status === 404 ? null : Promise.reject(e))), []);
  const completeness = useLoad(() => api.get('/me/official-profile/completeness').catch(() => ({ score: 0, guidance: [] })), []);
  const [profile, setProfile] = useState(null);
  const [step, setStep] = useState(0);
  const [creds, setCreds] = useState([]);
  const [expEntries, setExpEntries] = useState([]);
  const [addCred, setAddCred] = useState(false);
  const [bioTranslations, setBioTranslations] = useState({});
  const [activeLang, setActiveLang] = useState('hi');
  const [portfolioLinks, setPortfolioLinks] = useState([]);
  const [addPortfolio, setAddPortfolio] = useState(false);
  const [completenessScore, setCompletenessScore] = useState(0);

  useEffect(() => {
    if (existing.data !== undefined && !profile) {
      if (existing.data) {
        setProfile(existing.data);
        setStep(existing.data.step_reached ?? 0);
        setCreds(existing.data.credentials ?? []);
        setExpEntries(existing.data.experience ?? []);
        setBioTranslations(existing.data.bio_translations ?? {});
        setPortfolioLinks(existing.data.portfolio_links ?? []);
      }
    }
  }, [existing.data]);

  useEffect(() => {
    if (completeness.data?.score != null) setCompletenessScore(completeness.data.score);
  }, [completeness.data]);

  if (opt.error || existing.error) return (
    <Sheet visible onClose={onClose} title={t('opw.wiz.title')}>
      <ErrorBox error={opt.error || existing.error} onRetry={() => { opt.reload(); existing.reload(); }} />
    </Sheet>
  );
  if (!opt.data || existing.data === undefined) return (
    <Sheet visible onClose={onClose} title={t('opw.wiz.title')}><Loading /></Sheet>
  );

  const O = opt.data;
  const sportOpts = O.sports.map((s) => ({ value: s.id, label: `${s.emoji ?? '🏅'} ${s.name}` }));
  const p = profile ?? {};

  const refreshCompleteness = async () => {
    try {
      const r = await api.get('/me/official-profile/completeness');
      if (r?.score != null) setCompletenessScore(r.score);
    } catch (_) {}
  };

  const save = async (patch, to) => {
    try {
      const row = await api.post('/me/official-profile', {
        ...(p.row_version != null ? { row_version: p.row_version } : {}),
        ...patch,
        step_reached: Math.max(p.step_reached ?? 0, (to ?? step) + 1),
      });
      setProfile(row);
      toast?.(t('opw.wiz.saved'));
      if (to != null) setStep(to);
      refreshCompleteness();
      return row;
    } catch (e) { throw new Error(explain(e)); }
  };

  const saveBioTranslations = async (translations) => {
    try {
      await api.put('/me/official-profile/bio-translations', { translations });
      setBioTranslations(translations);
      refreshCompleteness();
    } catch (e) { throw new Error(explain(e)); }
  };

  const savePortfolio = async (links) => {
    try {
      await api.put('/me/official-profile/portfolio', { links });
      setPortfolioLinks(links);
      refreshCompleteness();
    } catch (e) { throw new Error(explain(e)); }
  };

  const saveSports = async (sports, to) => {
    try {
      await api.put('/me/official-profile/sports', { sports });
      toast?.(t('opw.wiz.saved'));
      if (to != null) setStep(to);
    } catch (e) { throw new Error(explain(e)); }
  };

  const saveExp = async (entries, to) => {
    try {
      await api.put('/me/official-profile/experience', { entries });
      setExpEntries(entries);
      toast?.(t('opw.wiz.saved'));
      if (to != null) setStep(to);
    } catch (e) { throw new Error(explain(e)); }
  };

  const saveRefs = async (refs, to) => {
    try {
      await api.put('/me/official-profile/references', { references: refs });
      toast?.(t('opw.wiz.saved'));
      if (to != null) setStep(to);
    } catch (e) { throw new Error(explain(e)); }
  };

  const back = () => setStep((s) => Math.max(0, s - 1));
  const nextLabel = (k) => t('opw.wiz.next_to', { step: t(`opw.wiz.s.${STEP_KEYS[k]}`) });
  const live = p.status === 'published';

  return (
    <Sheet visible onClose={onClose} title={t('opw.wiz.title')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <T size={12} color={c.mute} style={{ flex: 1 }}>{t('opw.wiz.step', { n: step + 1, m: STEP_KEYS.length })} · {t(`opw.wiz.s.${STEP_KEYS[step]}`)}</T>
        <Tag label={t(`opw.status.${p.status ?? 'draft'}`)} color={live ? c.mintSoft : c.sunSoft} />
      </View>
      <Stepper
        steps={STEP_KEYS.map((k) => t(`opw.wiz.s.${k}`))}
        current={step}
        onJump={(i) => { if (p.id || i === 0) setStep(i); }}
      />

      <CompletenessBar score={completenessScore} />

      {/* Step 0: Identity */}
      {step === 0 && (
        <View style={{ gap: 14 }}>
        <CountryPicker label={t('opw.f.nationality')} value={nat ?? iso(p.nationality)} onChange={setNat} optional hint={p.nationality && !iso(p.nationality) ? t('opw.f.country_legacy', { v: p.nationality }) : undefined} />
        <FormSheet inline visible
          initial={{ display_name_pref: p.display_name_pref ?? '', bio: p.bio ?? '', preferred_pronouns: p.preferred_pronouns ?? '' }}
          submitLabel={nextLabel(1)}
          onClose={() => {}}
          fields={[
            { key: 'display_name_pref', label: t('opw.f.display_name'), hint: t('opw.f.display_name_hint'), optional: true },
            { key: 'bio', label: t('opw.f.bio'), type: 'multiline', optional: true, hint: t('opw.f.bio_hint') },
            { key: 'preferred_pronouns', label: t('opw.f.pronouns'), type: 'chips', options: ['he/him','she/her','they/them','prefer_not_to_say'].map((v) => ({ value: v, label: t(`opw.pronoun.${v}`) })), optional: true },
          ]}
          onSubmit={async (x) => {
            await save({ display_name_pref: x.display_name_pref || null, bio: x.bio || null, preferred_pronouns: x.preferred_pronouns || null, ...(nat != null ? { nationality: nat || null } : {}) }, 1);
          }}
        />
        {/* Multi-language bio expander — elite academies search in native language */}
        <LanguageBioExpander
          translations={bioTranslations}
          activeLang={activeLang}
          onChangeLang={setActiveLang}
          onSave={saveBioTranslations}
        />
        </View>
      )}

      {/* Step 1: Privacy */}
      {step === 1 && (
        <FormSheet inline visible
          initial={{ privacy_show_sports: p.privacy_show_sports ?? true, privacy_show_experience: p.privacy_show_experience ?? true, privacy_show_credentials: p.privacy_show_credentials ?? true, privacy_show_rates: p.privacy_show_rates ?? true }}
          submitLabel={nextLabel(2)}
          onBack={back}
          onClose={() => {}}
          fields={[
            { key: 'privacy_show_sports', label: t('opw.f.show_sports'), type: 'switch', hint: t('opw.f.show_sports_hint') },
            { key: 'privacy_show_experience', label: t('opw.f.show_experience'), type: 'switch', hint: t('opw.f.show_experience_hint') },
            { key: 'privacy_show_credentials', label: t('opw.f.show_credentials'), type: 'switch', hint: t('opw.f.show_credentials_hint') },
            { key: 'privacy_show_rates', label: t('opw.f.show_rates'), type: 'switch', hint: t('opw.f.show_rates_hint') },
          ]}
          onSubmit={async (x) => { await save(x, 2); }}
        />
      )}

      {/* Step 2: Sports & Roles */}
      {step === 2 && (
        <SportsStep profile={p} sportOpts={sportOpts} onSave={saveSports} onBack={back} nextLabel={nextLabel(3)} />
      )}

      {/* Step 3: Experience */}
      {step === 3 && (
        <ExperienceStep profile={p} sportOpts={sportOpts} entries={expEntries} setEntries={setExpEntries} onSave={saveExp} onBack={back} nextLabel={nextLabel(4)} />
      )}

      {/* Step 4: Credentials + Compliance */}
      {step === 4 && (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T size={15} weight="800" style={{ flex: 1 }}>{t('opw.cred.section_title')}</T>
            <Btn small title={t('opw.cred.add')} color={c.paper} ink={c.ink} onPress={() => setAddCred(true)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('opw.cred.add')} />
          </View>
          {!creds.length
            ? <Card color={c.violetSoft}><T size={13}>{t('opw.cred.none')}</T></Card>
            : creds.map((cr) => (
              <Card key={cr.id} pad={12}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <T weight="800">{cr.credential_name}</T>
                    <T size={12} color={c.mute}>{cr.issuing_body} · {t(`opw.cred_kind.${cr.kind}`)} {cr.level_label ? `· ${cr.level_label}` : ''}</T>
                    {cr.expiry_date ? <T size={12} color={cr.status === 'expired' ? c.red : c.mute}>{cr.status === 'expired' ? t('opw.cred.expired') : t('opw.cred.expires', { d: cr.expiry_date })}</T> : null}
                  </View>
                  <Tag label={t(`opw.cred.status.${cr.status}`)} color={cr.status === 'expired' ? c.sunSoft : cr.status === 'active' ? c.mintSoft : c.violetSoft} />
                </View>
              </Card>
            ))}
          {addCred && (
            <FormSheet visible onClose={() => setAddCred(false)} title={t('opw.cred.add')} submitLabel={t('common.save')}
              initial={{ kind: 'licence' }}
              fields={[
                { key: 'kind', label: t('opw.f.cred_kind'), type: 'chips', options: KIND_OPTS.map((v) => ({ value: v, label: t(`opw.cred_kind.${v}`) })) },
                { key: 'issuing_body', label: t('opw.f.issuing_body') },
                { key: 'credential_name', label: t('opw.f.cred_name') },
                { key: 'level_label', label: t('opw.f.cred_level'), optional: true, hint: t('opw.f.cred_level_hint') },
                { key: 'issue_date', label: t('opw.f.issue_date'), type: 'date', optional: true },
                { key: 'expiry_date', label: t('opw.f.expiry_date'), type: 'date', optional: true },
                { key: 'reference_no', label: t('opw.f.ref_no'), optional: true, hint: t('opw.f.ref_no_hint') },
              ]}
              onSubmit={async (x) => {
                const cred = await api.post('/me/official-profile/credentials', {
                  kind: x.kind, issuing_body: x.issuing_body, credential_name: x.credential_name,
                  level_label: x.level_label || null, issue_date: x.issue_date || null,
                  expiry_date: x.expiry_date || null, reference_no: x.reference_no || null,
                });
                setCreds((cs) => [...cs, cred]);
                setAddCred(false);
                refreshCompleteness();
              }}
            />
          )}
          {/* Compliance checklist — elite academies require structured mandatory items */}
          <ComplianceChecklist profileId={p?.id} onUpdate={() => refreshCompleteness()} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={back} accessibilityLabel={t('common.back')} />
            <Btn title={nextLabel(5)} onPress={async () => { await save({ step_reached: 5 }, 5); }} accessibilityLabel={nextLabel(5)} />
          </View>
          <T size={11} color={c.mute}>{t('opw.wiz.autosave')}</T>
        </View>
      )}

      {/* Step 5: References */}
      {step === 5 && (
        <ReferencesStep profile={p} onSave={saveRefs} onBack={back} nextLabel={nextLabel(6)} />
      )}

      {/* Step 6: Availability & Travel */}
      {step === 6 && (
        <AvailabilityStep onSave={async (_, to) => { await save({ step_reached: 7 }, to); }} onBack={back} nextLabel={nextLabel(7)} />
      )}

      {/* Step 7: Rate Cards */}
      {step === 7 && (
        <RatesStep onOpen={leave} onNext={() => save({}, 8)} onBack={back} nextLabel={nextLabel(8)} />
      )}

      {/* Step 8: Payout & Tax */}
      {step === 8 && (
        <View style={{ gap: 14 }}>
        <CountryPicker label={t('opw.f.tax_country')} value={taxCountry ?? iso(p.tax_country)} onChange={setTaxCountry} optional hint={p.tax_country && !iso(p.tax_country) ? t('opw.f.country_legacy', { v: p.tax_country }) : undefined} />
        <FormSheet inline visible
          initial={{ vat_registered: p.vat_registered ?? false, payout_method: p.payout_method ?? 'bank_transfer' }}
          submitLabel={nextLabel(9)}
          onBack={back}
          onClose={() => {}}
          fields={[
            { key: 'vat_registered', label: t('opw.f.vat_registered'), type: 'switch', hint: t('opw.f.vat_registered_hint') },
            { key: 'vat_number', label: t('opw.f.vat_number'), optional: true, hint: t('opw.f.encrypted_hint') },
            { key: 'payout_method', label: t('opw.f.payout_method'), type: 'chips', options: [{ value: 'bank_transfer', label: t('opw.payout.bank_transfer') }, { value: 'stripe', label: t('opw.payout.stripe') }, { value: 'other', label: t('opw.payout.other') }] },
            { type: 'section', label: t('opw.f.bank_section') },
            { key: 'bank_sort_code', label: t('opw.f.sort_code'), optional: true, hint: t('opw.f.encrypted_hint') },
            { key: 'bank_account', label: t('opw.f.account_number'), optional: true, hint: t('opw.f.encrypted_hint') },
            { key: 'bank_iban', label: t('opw.f.iban'), optional: true, hint: t('opw.f.encrypted_hint') },
          ]}
          onSubmit={async (x) => {
            await save({
              ...(taxCountry != null ? { tax_country: taxCountry || null } : {}), vat_registered: x.vat_registered,
              vat_number: x.vat_number || null, payout_method: x.payout_method,
              bank_sort_code: x.bank_sort_code || null, bank_account: x.bank_account || null, bank_iban: x.bank_iban || null,
            }, 9);
          }}
        />
        </View>
      )}

      {/* Step 9: Review & Publish */}
      {step === 9 && (
        <ReviewStep profile={p} onBack={back} portfolioLinks={portfolioLinks}
          onPublish={async () => {
            const row = await api.post('/me/official-profile/publish', { row_version: p.row_version });
            setProfile((pr) => ({ ...pr, ...row }));
            toast?.(t('opw.published'));
            onDone?.();
          }}
          onRetract={async () => {
            const row = await api.post('/me/official-profile/retract', { row_version: p.row_version });
            setProfile((pr) => ({ ...pr, ...row }));
            toast?.(t('opw.retracted'));
          }}
          onAddPortfolio={async (link) => {
            const updated = [...portfolioLinks, link].slice(0, 10);
            await savePortfolio(updated);
          }}
          onRemovePortfolio={async (idx) => {
            const updated = portfolioLinks.filter((_, i) => i !== idx);
            await savePortfolio(updated);
          }}
        />
      )}

      {step > 0 && step < 9 && <T size={11} color={c.mute}>{t('opw.wiz.autosave')}</T>}
    </Sheet>
  );
}

// ---------------------------------------------------------------- Sports step
function SportsStep({ profile, sportOpts, onSave, onBack, nextLabel }) {
  const [rows, setRows] = useState(profile?.sports ?? []);
  const [draft, setDraft] = useState({ sport_id: null, role: 'referee', discipline: '', primary_sport: false });
  const [err, setErr] = useState(null);

  const add = () => {
    if (!draft.sport_id || !draft.role) return;
    setRows((rs) => [...rs.filter((r) => !(r.sport_id === draft.sport_id && r.role === draft.role)), { ...draft }]);
    setDraft((d) => ({ ...d, sport_id: null, discipline: '' }));
  };

  return (
    <View style={{ gap: 12 }}>
      {rows.length ? rows.map((r, i) => (
        <Card key={`${r.sport_id}${r.role}`} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800">{sportOpts.find((s) => s.value === r.sport_id)?.label ?? r.sport_id}</T>
              <T size={12} color={c.mute}>{t(`opw.role.${r.role}`)} {r.discipline ? `· ${r.discipline}` : ''} {r.primary_sport ? '· ★' : ''}</T>
            </View>
            <Btn small title={t('common.remove')} color={c.paper} ink={c.ink} onPress={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
          </View>
        </Card>
      )) : <T size={13} color={c.mute}>{t('opw.sports.none')}</T>}
      <Card>
        <T weight="800">{t('opw.sports.add')}</T>
        <MenuField label={t('opw.f.sport')} value={draft.sport_id} onChange={(v) => setDraft((d) => ({ ...d, sport_id: v }))} options={sportOpts} placeholder={t('common.choose')} />
        <MenuField label={t('opw.f.role')} value={draft.role} onChange={(v) => setDraft((d) => ({ ...d, role: v }))} options={ROLE_OPTS.map((v) => ({ value: v, label: t(`opw.role.${v}`) }))} />
        <FormSheet inline visible
          initial={{ discipline: draft.discipline, primary_sport: draft.primary_sport }}
          fields={[
            { key: 'discipline', label: t('opw.f.discipline'), optional: true, hint: t('opw.f.discipline_hint') },
            { key: 'primary_sport', label: t('opw.f.primary'), type: 'switch' },
          ]}
          onSubmit={(x) => setDraft((d) => ({ ...d, discipline: x.discipline, primary_sport: x.primary_sport }))}
          onClose={() => {}}
        />
        <Btn small title={t('opw.sports.add_btn')} disabled={!draft.sport_id || !draft.role} onPress={add} style={{ alignSelf: 'flex-start' }} />
      </Card>
      {err ? <T color={c.red} size={13}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={nextLabel} disabled={!rows.length} onPress={async () => { try { await onSave(rows, 3); } catch (e) { setErr(e.message); } }} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Experience step
function ExperienceStep({ profile, sportOpts, entries, setEntries, onSave, onBack, nextLabel }) {
  const [draft, setDraft] = useState({ sport_id: null, role: 'referee', level: 'local', body_name: '', competition_name: '', from_year: YEAR - 2, to_year: null, match_count_est: 0 });
  const [err, setErr] = useState(null);

  const add = () => {
    if (!draft.sport_id || !draft.body_name) return;
    setEntries((es) => [...es, { ...draft, display_order: es.length }]);
    setDraft((d) => ({ ...d, sport_id: null, body_name: '', competition_name: '' }));
  };

  return (
    <View style={{ gap: 12 }}>
      {entries.length ? entries.map((e, i) => (
        <Card key={i} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800">{e.body_name}</T>
              <T size={12} color={c.mute}>{sportOpts.find((s) => s.value === e.sport_id)?.label ?? e.sport_id} · {t(`opw.role.${e.role}`)} · {t(`opw.level.${e.level}`)}</T>
              {e.competition_name ? <T size={12} color={c.mute}>{e.competition_name}</T> : null}
              <T size={12} color={c.mute}>{e.from_year ? `${e.from_year}${e.to_year ? ` – ${e.to_year}` : ' – present'}` : ''} {e.match_count_est ? `· ~${e.match_count_est} matches` : ''}</T>
            </View>
            <Btn small title={t('common.remove')} color={c.paper} ink={c.ink} onPress={() => setEntries((es) => es.filter((_, j) => j !== i))} />
          </View>
        </Card>
      )) : <T size={13} color={c.mute}>{t('opw.exp.none')}</T>}
      <Card>
        <T weight="800">{t('opw.exp.add')}</T>
        <MenuField label={t('opw.f.sport')} value={draft.sport_id} onChange={(v) => setDraft((d) => ({ ...d, sport_id: v }))} options={sportOpts} placeholder={t('common.choose')} />
        <MenuField label={t('opw.f.role')} value={draft.role} onChange={(v) => setDraft((d) => ({ ...d, role: v }))} options={ROLE_OPTS.map((v) => ({ value: v, label: t(`opw.role.${v}`) }))} />
        <MenuField label={t('opw.f.level')} value={draft.level} onChange={(v) => setDraft((d) => ({ ...d, level: v }))} options={LEVEL_OPTS.map((v) => ({ value: v, label: t(`opw.level.${v}`) }))} />
        <FormSheet inline visible
          initial={{ body_name: draft.body_name, competition_name: draft.competition_name, from_year: draft.from_year, to_year: draft.to_year, match_count_est: draft.match_count_est }}
          fields={[
            { key: 'body_name', label: t('opw.f.body_name') },
            { key: 'competition_name', label: t('opw.f.competition_name'), optional: true },
            { key: 'from_year', label: t('opw.f.from_year'), type: 'stepper', min: 1950, max: YEAR },
            { key: 'to_year', label: t('opw.f.to_year'), type: 'stepper', min: 1950, max: YEAR, optional: true },
            { key: 'match_count_est', label: t('opw.f.matches_est'), type: 'stepper', min: 0, max: 99999, step: 10 },
          ]}
          onSubmit={(x) => setDraft((d) => ({ ...d, body_name: x.body_name, competition_name: x.competition_name, from_year: x.from_year, to_year: x.to_year || null, match_count_est: x.match_count_est }))}
          onClose={() => {}}
        />
        <Btn small title={t('opw.exp.add_btn')} disabled={!draft.sport_id || !draft.body_name} onPress={add} style={{ alignSelf: 'flex-start' }} />
      </Card>
      {err ? <T color={c.red} size={13}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={nextLabel} onPress={async () => { try { await onSave(entries, 4); } catch (e) { setErr(e.message); } }} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- References step
function ReferencesStep({ profile, onSave, onBack, nextLabel }) {
  const [refs, setRefs] = useState([]);
  const [draft, setDraft] = useState({ referee_name: '', role_title: '', organisation: '', relationship: 'colleague', contact_email: '', contact_phone: '', consent_given: false });
  const [err, setErr] = useState(null);

  const add = () => {
    if (!draft.referee_name) return;
    setRefs((rs) => [...rs, { ...draft, display_order: rs.length }]);
    setDraft((d) => ({ ...d, referee_name: '', role_title: '', organisation: '', contact_email: '', contact_phone: '' }));
  };

  return (
    <View style={{ gap: 12 }}>
      {refs.length ? refs.map((r, i) => (
        <Card key={i} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800">{r.referee_name}</T>
              <T size={12} color={c.mute}>{r.role_title ? `${r.role_title} · ` : ''}{r.organisation ?? ''} · {t(`opw.rel.${r.relationship}`)}</T>
              {r.consent_given ? <Tag label={t('opw.ref.consent_given')} color={c.mintSoft} /> : null}
            </View>
            <Btn small title={t('common.remove')} color={c.paper} ink={c.ink} onPress={() => setRefs((rs) => rs.filter((_, j) => j !== i))} />
          </View>
        </Card>
      )) : <T size={13} color={c.mute}>{t('opw.ref.none')}</T>}
      {refs.length < 3 && (
        <Card>
          <T weight="800">{t('opw.ref.add')}</T>
          <FormSheet inline visible
            initial={draft}
            fields={[
              { key: 'referee_name', label: t('opw.f.ref_name'), hint: t('opw.f.encrypted_hint') },
              { key: 'role_title', label: t('opw.f.ref_title'), optional: true },
              { key: 'organisation', label: t('opw.f.ref_org'), optional: true },
              { key: 'relationship', label: t('opw.f.relationship'), type: 'chips', options: REL_OPTS.map((v) => ({ value: v, label: t(`opw.rel.${v}`) })) },
              { key: 'contact_email', label: t('opw.f.ref_email'), optional: true, hint: t('opw.f.ref_contact_hint') },
              { key: 'contact_phone', label: t('opw.f.ref_phone'), optional: true, hint: t('opw.f.ref_contact_hint') },
              { key: 'consent_given', label: t('opw.f.ref_consent'), type: 'switch', hint: t('opw.f.ref_consent_hint') },
            ]}
            onSubmit={(x) => setDraft(x)}
            onClose={() => {}}
          />
          <Btn small title={t('opw.ref.add_btn')} disabled={!draft.referee_name} onPress={add} style={{ alignSelf: 'flex-start' }} />
        </Card>
      )}
      {err ? <T color={c.red} size={13}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={nextLabel} onPress={async () => { try { await onSave(refs, 6); } catch (e) { setErr(e.message); } }} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Availability step
// Availability has one home: the Availability tab of Officials Home (#994). This step shows what is saved there and moves on;
// it no longer keeps a second copy of the timezone, travel range and gap between matches.
function AvailabilityStep({ onSave, onBack, nextLabel }) {
  const q = useLoad(() => api.get('/me/officials/availability').catch(() => null), []);
  const [err, setErr] = useState(null);
  if (q.loading && !q.data) return <Loading />;
  const p = q.data?.prefs, s = q.data?.summary;
  const rows = p ? [
    [t('oav.pref.timezone'), p.timezone],
    [t('oav.m.open'), s.open_minutes_week == null ? t('oav.m.any') : t('oav.m.hours', { n: Math.round(s.open_minutes_week / 6) / 10 })],
    [t('oav.pref.gap'), p.buffer_min ? t('oav.n_min', { n: p.buffer_min }) : t('oav.none')],
    [t('oav.pref.range'), p.travel_km ? t('oav.n_km', { n: p.travel_km }) : t('oav.not_set')],
    [t('oav.pref.region'), p.region || t('oav.not_set')],
    [t('oav.m.blocked'), String(s.blocked_days_90)],
  ] : [];
  return (
    <View style={{ gap: 12 }}>
      <Card color={c.cyanSoft}><T size={13}>{t('oav.wiz.hint')}</T></Card>
      {rows.length ? <Card><View style={{ gap: 6 }}>{rows.map(([k, v]) => (
        <View key={k} style={{ flexDirection: 'row', gap: 12 }} accessible accessibilityLabel={`${k}: ${v}`}><T size={13} color={c.mute} style={{ flex: 1 }}>{k}</T><T size={13.5} weight="700" style={{ flex: 1 }}>{v}</T></View>
      ))}</View></Card> : <Empty emoji="🗓️" title={t('oav.wiz.empty_title')} sub={t('oav.wiz.empty_sub')} />}
      {err ? <T color={c.red} size={13}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {onBack ? <View style={{ flex: 1 }}><Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} /></View> : null}
        <View style={{ flex: 1 }}><Btn title={nextLabel} onPress={async () => { try { await onSave(null, 7); } catch (e) { setErr(explain(e)); } }} /></View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Rates step
// Rate cards have one home, the rate card catalogue (rate-card-catalog.js, rate-card-wizard.js). This step shows what is on file there and opens it;
// it never keeps a second, simpler copy of a rate, and leaving the step can never replace or archive a card.
function RatesStep({ onOpen, onNext, onBack, nextLabel }) {
  const q = useLoad(() => api.get('/me/official-profile/rate-cards/catalog'), []);
  const [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  const cards = Array.isArray(q.data) ? q.data.filter((r) => r.status !== 'archived') : [];
  const active = cards.filter((r) => r.status === 'active');
  const next = async () => { setBusy(true); setErr(null); try { await onNext(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[[active.length, t('opw.rates.m_active')], [cards.length - active.length, t('opw.rates.m_draft')], [new Set(cards.map((r) => r.sport_id).filter(Boolean)).size, t('opw.rates.m_sports')]].map(([v, label]) => (
          <View key={label} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line, paddingVertical: 10, paddingHorizontal: 12 }}>
            <T weight="800" size={20}>{v}</T><T size={11} color={c.mute} weight="600">{label}</T>
          </View>
        ))}
      </View>
      {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !q.data ? <Loading /> : cards.length ? cards.map((r) => (
        <Card key={r.id} pad={12} onPress={() => onOpen('RateCardWizard', { id: r.id })} accessibilityLabel={t('opw.rates.edit_a11y', { name: r.name ?? r.sport_name ?? t('opw.rates.card') })}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <T weight="800">{r.name ?? ([r.sport_name, ROLE_OPTS.includes(r.role) ? t(`opw.role.${r.role}`) : r.role].filter(Boolean).join(' · ') || t('opw.rates.card'))}</T>
              <T size={12} color={c.mute}>{[r.sport_name ?? t('opw.rates.all_sports'), ROLE_OPTS.includes(r.role) ? t(`opw.role.${r.role}`) : r.role ?? t('opw.rates.all_roles'), FIX_TYPES.includes(r.fixture_type) ? t(`opw.fix.${r.fixture_type}`) : r.fixture_type].filter(Boolean).join(' · ')}</T>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <T weight="800" size={16} color={c.pink}>{money(r.fee_minor, r.fee_currency)}</T>
              <Tag label={t(`opw.rates.st_${r.status}`)} color={r.status === 'active' ? c.mintSoft : c.sunSoft} />
            </View>
          </View>
        </Card>
      )) : <Empty emoji="💳" title={t('opw.rates.empty')} sub={t('opw.rates.empty_sub')} />}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn title={t('opw.rates.new')} onPress={() => onOpen('RateCardWizard', {})} style={{ minHeight: 48 }} />
        {cards.length ? <Btn title={t('opw.rates.manage')} color={c.paper} ink={c.ink} onPress={() => onOpen('RateCardCatalog')} style={{ minHeight: 48 }} /> : null}
      </View>
      <T size={12} color={c.mute}>{t('opw.rates.return_note')}</T>
      {err ? <T color={c.red} size={13}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={nextLabel} onPress={next} loading={busy} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Review & Publish step
function ReviewStep({ profile: p, portfolioLinks, onBack, onPublish, onRetract, onAddPortfolio, onRemovePortfolio }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showAddPortfolio, setShowAddPortfolio] = useState(false);
  const compliance = useLoad(() => (p?.id ? api.get('/me/official-profile/compliance').catch(() => null) : Promise.resolve(null)), [p?.id]);
  const live = p?.status === 'published';
  const checks = [
    { label: t('opw.review.has_sport'), ok: (p?.sports?.length ?? 0) > 0 },
    { label: t('opw.review.has_name'), ok: !!(p?.display_name_pref) },
    { label: t('opw.review.has_experience'), ok: (p?.experience?.length ?? 0) > 0 },
    { label: t('opw.review.has_credentials'), ok: (p?.credentials?.length ?? 0) > 0 },
    { label: t('opw.review.has_payout'), ok: !!(p?.payout_method) },
  ];
  const blockers = checks.filter((ch) => !ch.ok);
  const pct = Math.round((checks.filter((ch) => ch.ok).length / checks.length) * 100);
  const complianceAlerts = compliance.data?.items?.filter((i) => ['expiring_soon','expired','missing'].includes(i.status)) ?? [];
  const blockingCompliance = complianceAlerts.filter((i) => i.mandatory && ['expired','missing'].includes(i.status));
  const links = portfolioLinks ?? [];

  return (
    <View style={{ gap: 12 }}>
      <Card>
        <T weight="800">{t('opw.review.readiness', { pct })}</T>
        <View style={{ height: 10, borderRadius: 6, backgroundColor: c.violetSoft, overflow: 'hidden', marginTop: 6 }}>
          <View style={{ width: `${pct}%`, height: 10, backgroundColor: blockers.length ? c.orange : c.lime }} />
        </View>
      </Card>
      {blockers.length ? (
        <Card color={c.orangeSoft}>
          <T weight="800">{t('opw.review.blockers')}</T>
          {blockers.map((b) => <T key={b.label} size={13}>✕ {b.label}</T>)}
        </Card>
      ) : (
        <Card color={c.mintSoft}>
          <T weight="800">{t('opw.review.ready')}</T>
          {checks.map((ch) => <T key={ch.label} size={13}>✓ {ch.label}</T>)}
        </Card>
      )}

      {/* Compliance alerts */}
      {complianceAlerts.length > 0 && (
        <Card color={blockingCompliance.length ? c.orangeSoft : c.sunSoft}>
          <T weight="800" style={{ marginBottom: 6 }}>{t('opw.compliance.alerts_title')}</T>
          {complianceAlerts.map((item) => (
            <View key={item.kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <T size={16}>{COMPLIANCE_ICONS[item.kind] ?? '📄'}</T>
              <View style={{ flex: 1 }}>
                <T size={13} weight="700">{t(`opw.compliance.kind.${item.kind}`)}</T>
                <T size={12} color={c.mute}>
                  {item.status === 'expiring_soon' ? t('opw.compliance.expires_in', { n: item.days_until_expiry })
                   : item.status === 'expired' ? t('opw.compliance.expired_on', { d: item.expires_at ?? '' })
                   : t(`opw.compliance.status.${item.status}`)}
                </T>
              </View>
              <Tag label={t(`opw.compliance.status.${item.status}`)}
                color={item.status === 'ok' ? c.mintSoft : item.status === 'expiring_soon' ? c.sunSoft : c.orangeSoft} />
            </View>
          ))}
          {blockingCompliance.length > 0 && (
            <T size={12} color={c.red} style={{ marginTop: 4 }}>{t('opw.compliance.blocking', { n: blockingCompliance.length })}</T>
          )}
        </Card>
      )}

      {/* Career Portfolio */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <T weight="800" style={{ flex: 1 }}>{t('opw.portfolio.title')}</T>
          {links.length < 10 && (
            <Btn small title={t('opw.portfolio.add')} color={c.paper} ink={c.ink}
              onPress={() => setShowAddPortfolio(true)} accessibilityLabel={t('opw.portfolio.add')} />
          )}
        </View>
        {!links.length
          ? <T size={13} color={c.mute}>{t('opw.portfolio.empty')}</T>
          : links.map((lnk, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, borderBottomWidth: i < links.length - 1 ? 1 : 0, borderBottomColor: c.line }}>
              <View style={{ flex: 1 }}>
                <T size={13} weight="700">{lnk.label || t(`opw.portfolio.kind.${lnk.kind}`)}</T>
                <T size={11} color={c.mute} numberOfLines={1}>{lnk.url}</T>
              </View>
              <Tag label={t(`opw.portfolio.kind.${lnk.kind}`)} color={c.violetSoft} />
              <Btn small title={t('opw.portfolio.remove')} color={c.paper} ink={c.red}
                onPress={() => onRemovePortfolio?.(i)} accessibilityLabel={t('opw.portfolio.remove')} />
            </View>
          ))
        }
        {links.length >= 10 && <T size={11} color={c.mute} style={{ marginTop: 4 }}>{t('opw.portfolio.max')}</T>}
      </Card>

      {showAddPortfolio && (
        <FormSheet visible onClose={() => setShowAddPortfolio(false)}
          title={t('opw.portfolio.add')} submitLabel={t('common.save')}
          initial={{ kind: 'video', label: '', url: '' }}
          fields={[
            { key: 'kind', label: t('opw.f.cred_kind'), type: 'chips', options: PORTFOLIO_KINDS.map((v) => ({ value: v, label: t(`opw.portfolio.kind.${v}`) })) },
            { key: 'label', label: t('opw.portfolio.label_placeholder'), optional: true },
            { key: 'url', label: 'URL', hint: t('opw.portfolio.url_placeholder') },
          ]}
          onSubmit={async (x) => {
            await onAddPortfolio?.({ kind: x.kind, label: x.label || '', url: x.url });
            setShowAddPortfolio(false);
          }}
        />
      )}

      {err ? <T color={c.red} size={13}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} accessibilityLabel={t('common.back')} />
        {!live && (
          <Btn title={t('opw.publish')} disabled={blockers.length > 0 || blockingCompliance.length > 0} busy={busy} onPress={async () => {
            setBusy(true);
            try { await onPublish(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
          }} accessibilityLabel={t('opw.publish')} />
        )}
        {live && (
          <Btn title={t('opw.retract')} color={c.paper} ink={c.red} busy={busy} onPress={async () => {
            setBusy(true);
            try { await onRetract(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
          }} accessibilityLabel={t('opw.retract')} />
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- LanguageBioExpander
// Lets elite officials add bio text in 12 platform languages so international academies can find them in their native script.
function LanguageBioExpander({ translations, activeLang, onChangeLang, onSave }) {
  const [expanded, setExpanded] = useState(false);
  const [local, setLocal] = useState(translations ?? {});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setLocal(translations ?? {}); }, [translations]);

  const covered = Object.keys(local).filter((k) => (local[k] ?? '').trim().length > 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(local);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  };

  return (
    <Card style={{ gap: 8 }}>
      <View accessible accessibilityRole="button" accessibilityLabel={t('opw.bio_langs.title')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
        onTouchEnd={() => setExpanded((v) => !v)}>
        <T weight="800" style={{ flex: 1 }}>{t('opw.bio_langs.title')}</T>
        {covered.length > 0 && <Tag label={t('opw.bio_langs.coverage', { n: covered.length })} color={c.mintSoft} />}
        <T size={18} color={c.mute}>{expanded ? '▲' : '▼'}</T>
      </View>
      {!expanded ? (
        <T size={12} color={c.mute}>{t('opw.bio_langs.hint')}</T>
      ) : (
        <View style={{ gap: 10 }}>
          <T size={12} color={c.mute}>{t('opw.bio_langs.hint')}</T>
          {/* Language tab strip */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {PLATFORM_LANGS.map((lang) => {
              const hasBio = (local[lang] ?? '').trim().length > 0;
              return (
                <Btn key={lang} small title={LANG_LABELS[lang]} accessibilityLabel={LANG_LABELS[lang]}
                  color={activeLang === lang ? c.pink : hasBio ? c.mintSoft : c.paper}
                  ink={activeLang === lang ? '#fff' : c.ink}
                  onPress={() => onChangeLang(lang)} />
              );
            })}
          </View>
          {/* Text area for active language — right-to-left for Urdu */}
          <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 10, minHeight: 100,
            ...(activeLang === 'ur' ? { writingDirection: 'rtl' } : {}) }}>
            <FormSheet inline visible
              initial={{ bio: local[activeLang] ?? '' }}
              fields={[{ key: 'bio', label: t('opw.bio_langs.placeholder', { lang: LANG_LABELS[activeLang] }), type: 'multiline', optional: true }]}
              onSubmit={(x) => setLocal((l) => ({ ...l, [activeLang]: x.bio || '' }))}
              onClose={() => {}}
            />
          </View>
          <Btn title={saved ? t('opw.bio_langs.saved') : t('opw.bio_langs.save')}
            color={saved ? c.mintSoft : c.pink} ink={saved ? c.ink : '#fff'}
            loading={saving} onPress={handleSave}
            accessibilityLabel={t('opw.bio_langs.save')} />
        </View>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- ComplianceChecklist
// Structured mandatory-clearance tracking for elite academies: DBS, safeguarding, fitness, insurance, anti-corruption.
// Reads from /me/official-profile/compliance and writes via /me/official-profile/compliance/:kind.
function ComplianceChecklist({ profileId, onUpdate }) {
  const q = useLoad(() => (profileId ? api.get('/me/official-profile/compliance').catch(() => null) : Promise.resolve(null)), [profileId]);
  const [uploadKind, setUploadKind] = useState(null);
  const [err, setErr] = useState(null);

  if (!profileId) return null;
  if (!q.data && !q.error) return null;

  const items = q.data?.items ?? [];

  const statusColor = (s) => ({
    ok: c.mintSoft, expiring_soon: c.sunSoft, expired: c.orangeSoft, missing: c.violetSoft, suspended: c.orangeSoft,
  }[s] ?? c.violetSoft);

  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T size={15} weight="800" style={{ flex: 1 }}>{t('opw.compliance.title')}</T>
        {q.data?.blocking_count > 0 && (
          <Tag label={`${q.data.blocking_count} blocking`} color={c.orangeSoft} />
        )}
      </View>
      <T size={12} color={c.mute}>{t('opw.compliance.hint')}</T>
      {items.map((item) => (
        <Card key={item.kind} pad={12} color={statusColor(item.status)}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={22}>{COMPLIANCE_ICONS[item.kind] ?? '📄'}</T>
            <View style={{ flex: 1 }}>
              <T weight="800" size={13}>{t(`opw.compliance.kind.${item.kind}`)}</T>
              {item.credential_name ? <T size={12} color={c.mute}>{item.credential_name}{item.issuing_body ? ` · ${item.issuing_body}` : ''}</T> : null}
              {item.status === 'expiring_soon' && item.days_until_expiry != null
                ? <T size={12} color={c.sun}>{t('opw.compliance.expires_in', { n: item.days_until_expiry })}</T>
                : item.status === 'expired' && item.expires_at
                  ? <T size={12} color={c.red}>{t('opw.compliance.expired_on', { d: item.expires_at })}</T>
                  : null}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Tag label={t(`opw.compliance.status.${item.status}`)} color={statusColor(item.status)} />
              <Btn small title={item.status === 'missing' ? t('opw.compliance.add') : t('opw.compliance.update')}
                color={c.paper} ink={c.ink} onPress={() => setUploadKind(item.kind)}
                accessibilityLabel={item.status === 'missing' ? t('opw.compliance.add') : t('opw.compliance.update')} />
            </View>
          </View>
        </Card>
      ))}
      {/* COMPLIANCE_KINDS not yet in items (fresh profile) */}
      {COMPLIANCE_KINDS.filter((k) => !items.find((i) => i.kind === k)).map((k) => (
        <Card key={k} pad={12} color={c.violetSoft}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={22}>{COMPLIANCE_ICONS[k] ?? '📄'}</T>
            <View style={{ flex: 1 }}>
              <T weight="800" size={13}>{t(`opw.compliance.kind.${k}`)}</T>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Tag label={t('opw.compliance.status.missing')} color={c.violetSoft} />
              <Btn small title={t('opw.compliance.add')} color={c.paper} ink={c.ink}
                onPress={() => setUploadKind(k)} accessibilityLabel={t('opw.compliance.add')} />
            </View>
          </View>
        </Card>
      ))}
      {err ? <T color={c.red} size={13}>{err}</T> : null}
      {uploadKind && (
        <FormSheet visible onClose={() => setUploadKind(null)}
          title={`${t('opw.compliance.add')} — ${t(`opw.compliance.kind.${uploadKind}`)}`}
          submitLabel={t('common.save')}
          initial={{ issuing_body: '', credential_name: '', issue_date: '', expiry_date: '', mandatory: false, alert_days_before: 30 }}
          fields={[
            { key: 'issuing_body', label: t('opw.f.issuing_body') },
            { key: 'credential_name', label: t('opw.f.cred_name') },
            { key: 'issue_date', label: t('opw.f.issue_date'), type: 'date', optional: true },
            { key: 'expiry_date', label: t('opw.f.expiry_date'), type: 'date', optional: true },
            { key: 'mandatory', label: 'Mandatory for assignments', type: 'switch', optional: true },
            { key: 'alert_days_before', label: 'Alert days before expiry', type: 'stepper', min: 7, max: 180, step: 7, optional: true },
          ]}
          onSubmit={async (x) => {
            try {
              await api.put(`/me/official-profile/compliance/${uploadKind}`, {
                kind: uploadKind, issuing_body: x.issuing_body, credential_name: x.credential_name,
                issue_date: x.issue_date || undefined, expiry_date: x.expiry_date || undefined,
                mandatory: x.mandatory, alert_days_before: x.alert_days_before,
              });
              setUploadKind(null);
              q.reload();
              onUpdate?.();
            } catch (e) { setErr(e?.message ?? 'Save failed'); }
          }}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------- Public profile view
export function OfficialProfileView({ profileId, onClose }) {
  const data = useLoad(() => api.get(`/official-profiles/${profileId}`), [profileId]);
  if (data.error) return (
    <Sheet visible onClose={onClose} title={t('nav.title.OfficialProfileView')}>
      <ErrorBox error={data.error} onRetry={data.reload} />
    </Sheet>
  );
  if (!data.data) return <Sheet visible onClose={onClose} title={t('nav.title.OfficialProfileView')}><Loading /></Sheet>;
  const p = data.data;
  return (
    <Sheet visible onClose={onClose} title={p.display_name}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <T size={36}>{p.avatar_emoji ?? '🏟️'}</T>
          <View style={{ flex: 1 }}>
            <T weight="800" size={20}>{p.display_name}</T>
            <T size={13} color={c.mute}>@{p.handle}{p.preferred_pronouns ? ` · ${p.preferred_pronouns}` : ''}{p.nationality ? ` · ${iso(p.nationality) ? countryName(p.nationality) : p.nationality}` : ''}</T>
            {p.highest_level ? <Tag label={t(`opw.level.${p.highest_level}`)} color={c.violetSoft} /> : null}
          </View>
        </View>
        {(p.started_year || p.total_matches_est) ? (
          <Card color={c.cyanSoft}>
            <View style={{ flexDirection: 'row', gap: 24, flexWrap: 'wrap' }}>
              {p.started_year ? <View><T size={22} weight="800">{new Date().getFullYear() - p.started_year}y</T><T size={11} color={c.mute}>{t('opw.view.experience')}</T></View> : null}
              {p.total_matches_est ? <View><T size={22} weight="800">~{p.total_matches_est}</T><T size={11} color={c.mute}>{t('opw.view.matches')}</T></View> : null}
            </View>
          </Card>
        ) : null}
        {p.sports?.length ? (
          <Card>
            <T weight="800">{t('opw.view.sports')}</T>
            {p.sports.map((s, i) => <T key={i} size={13}>{t(`opw.role.${s.role}`)} {s.discipline ? `(${s.discipline})` : ''} {s.primary_sport ? '★' : ''}</T>)}
          </Card>
        ) : null}
        {p.credentials?.length ? (
          <Card>
            <T weight="800">{t('opw.view.credentials')}</T>
            {p.credentials.map((cr, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T size={13} style={{ flex: 1 }}>{cr.credential_name} · {cr.issuing_body}</T>
                <Tag label={t(`opw.cred.status.${cr.status}`)} color={cr.status === 'active' ? c.mintSoft : c.sunSoft} />
              </View>
            ))}
          </Card>
        ) : null}
        {p.rates?.length ? (
          <Card>
            <T weight="800">{t('opw.view.rates')}</T>
            {p.rates.slice(0, 4).map((r, i) => <T key={i} size={13}>{(r.fee_minor / 100).toFixed(2)} {r.fee_currency} · {t(`opw.fix.${r.fixture_type}`)}</T>)}
          </Card>
        ) : null}
      </View>
    </Sheet>
  );
}

