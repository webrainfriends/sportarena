import React, { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { api } from '../api';
import { Sheet, Btn, T, H2, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { c, r } from '../theme';
import { t } from '../i18n';

// ─── plan type taxonomy ──────────────────────────────────────────────────────
const PLAN_TYPES = [
  {
    tier: 'ph.tier_macro', items: [
      { key: 'annual_plan', icon: '🗓', label: 'ph.type_annual', desc: 'ph.type_annual_desc' },
      { key: 'development_plan', icon: '🧬', label: 'ph.type_dev', desc: 'ph.type_dev_desc' },
      { key: 'competition_plan', icon: '🏆', label: 'ph.type_comp', desc: 'ph.type_comp_desc' },
    ],
  },
  {
    tier: 'ph.tier_meso', items: [
      { key: 'training_block', icon: '🧱', label: 'ph.type_block', desc: 'ph.type_block_desc' },
      { key: 'recovery_block', icon: '🛌', label: 'ph.type_recovery', desc: 'ph.type_recovery_desc' },
      { key: 'return_to_play', icon: '🔄', label: 'ph.type_rtp', desc: 'ph.type_rtp_desc' },
    ],
  },
  {
    tier: 'ph.tier_specialist', items: [
      { key: 'class_plan', icon: '🎓', label: 'ph.type_class', desc: 'ph.type_class_desc' },
      { key: 'nutrition_plan', icon: '🥗', label: 'ph.type_nutrition', desc: 'ph.type_nutrition_desc' },
      { key: 'mental_plan', icon: '🧠', label: 'ph.type_mental', desc: 'ph.type_mental_desc' },
    ],
  },
];

const PHASES = [
  { key: 'preparation', label: 'ph.phase_prep', acwr: [1.0, 1.2] },
  { key: 'pre_competition', label: 'ph.phase_precomp', acwr: [0.9, 1.1] },
  { key: 'competition', label: 'ph.phase_comp', acwr: [0.8, 1.0] },
  { key: 'transition', label: 'ph.phase_trans', acwr: [0.7, 0.9] },
  { key: 'return_to_play', label: 'ph.phase_rtp', acwr: [0.5, 0.8] },
];

const GOALS = [
  { key: 'peak_performance', label: 'ph.goal_peak', icon: '⚡' },
  { key: 'base_fitness', label: 'ph.goal_base', icon: '🏗' },
  { key: 'competition_prep', label: 'ph.goal_compprep', icon: '🎯' },
  { key: 'recovery', label: 'ph.goal_recovery', icon: '🛌' },
  { key: 'rehabilitation', label: 'ph.goal_rehab', icon: '🔄' },
  { key: 'skill_acquisition', label: 'ph.goal_skill', icon: '🎓' },
  { key: 'load_management', label: 'ph.goal_load', icon: '⚖️' },
  { key: 'mental_resilience', label: 'ph.goal_mental', icon: '🧠' },
];

const FOCUS_AREAS = [
  'ph.focus_speed', 'ph.focus_endurance', 'ph.focus_strength', 'ph.focus_power',
  'ph.focus_technical', 'ph.focus_tactical', 'ph.focus_recovery', 'ph.focus_mobility',
  'ph.focus_nutrition', 'ph.focus_mental', 'ph.focus_explosive', 'ph.focus_aerobic',
  'ph.focus_anaerobic', 'ph.focus_agility', 'ph.focus_balance',
];

const INTENSITY_MODELS = [
  { key: 'polarised', label: 'ph.intensity_polarised', zones: [30, 50, 0, 15, 5], desc: 'ph.intensity_polarised_desc' },
  { key: 'pyramidal', label: 'ph.intensity_pyramidal', zones: [20, 40, 0, 25, 15], desc: 'ph.intensity_pyramidal_desc' },
  { key: 'threshold', label: 'ph.intensity_threshold', zones: [10, 47, 0, 43, 0], desc: 'ph.intensity_threshold_desc' },
  { key: 'sweet_spot', label: 'ph.intensity_sweetspot', zones: [15, 40, 0, 35, 10], desc: 'ph.intensity_sweetspot_desc' },
  { key: 'custom', label: 'ph.intensity_custom', zones: [20, 20, 20, 20, 20], desc: 'ph.intensity_custom_desc' },
];

const DURATION_PRESETS = [
  { key: '4w', label: '4 wk', weeks: 4 },
  { key: '6w', label: '6 wk', weeks: 6 },
  { key: '8w', label: '8 wk', weeks: 8 },
  { key: '12w', label: '12 wk', weeks: 12 },
  { key: '16w', label: '16 wk', weeks: 16 },
  { key: '24w', label: '24 wk', weeks: 24 },
  { key: '52w', label: '52 wk', weeks: 52 },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function StepDot({ n, active, done }) {
  const bg = done ? c.lime : active ? c.amethyst : c.line;
  return (
    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <T size={11} weight="700" color={done || active ? c.onAccent : c.mute}>{done ? '✓' : n}</T>
    </View>
  );
}

function StepBar({ step, total }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 20 }}>
      {Array.from({ length: total }, (_, i) => (
        <React.Fragment key={i}>
          <StepDot n={i + 1} active={step === i + 1} done={step > i + 1} />
          {i < total - 1 && <View style={{ flex: 1, height: 2, backgroundColor: step > i + 1 ? c.lime : c.line }} />}
        </React.Fragment>
      ))}
    </View>
  );
}

function Chip({ label, active, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 20,
        borderWidth: 1.5,
        borderColor: active ? c.amethyst : c.line,
        backgroundColor: active ? c.violetSoft : c.paper,
        minHeight: 44,
        justifyContent: 'center',
      }}
    >
      <T size={13} weight={active ? '700' : '500'} color={active ? c.amethyst : c.ink}>{label}</T>
    </Pressable>
  );
}

function IntensityBar({ zones }) {
  const ZONE_COLORS = [c.lime, '#6EC4F0', '#F5A623', '#E06060', '#B03030'];
  const total = zones.reduce((s, v) => s + v, 0) || 100;
  return (
    <View style={{ flexDirection: 'row', borderRadius: 6, overflow: 'hidden', height: 20, marginVertical: 4 }}>
      {zones.map((v, i) => v > 0 ? (
        <View key={i} style={{ flex: v / total, backgroundColor: ZONE_COLORS[i] }} />
      ) : null)}
    </View>
  );
}

function PlanTypeCard({ item, active, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        borderWidth: 1.5,
        borderColor: active ? c.amethyst : c.line,
        borderRadius: r.card,
        backgroundColor: active ? c.violetSoft : c.paper,
        padding: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 64,
      }}
    >
      <T size={28}>{item.icon}</T>
      <View style={{ flex: 1 }}>
        <T size={14} weight="700" color={active ? c.amethyst : c.ink}>{t(item.label)}</T>
        <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t(item.desc)}</T>
      </View>
      {active && <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: c.amethyst, alignItems: 'center', justifyContent: 'center' }}><T size={12} color={c.onAccent} weight="700">✓</T></View>}
    </Pressable>
  );
}

// ─── SKIP logic: some plan types don't need load/intensity steps ─────────────
const skipLoad = (pt) => ['development_plan', 'nutrition_plan', 'mental_plan', 'class_plan', 'recovery_block'].includes(pt);
const skipIntensity = (pt) => ['development_plan', 'nutrition_plan', 'mental_plan', 'class_plan'].includes(pt);

// ─── main component ───────────────────────────────────────────────────────────

export function PlanHubSheet({ visible, onClose, athlete, onCreated }) {
  const totalSteps = 5;
  const [step, setStep] = useState(1);
  const [planType, setPlanType] = useState(null);
  const [sport, setSport] = useState(null);
  const [phase, setPhase] = useState(null);
  const [duration, setDuration] = useState(null);
  const [primaryGoal, setPrimaryGoal] = useState(null);
  const [adaptiveMode, setAdaptiveMode] = useState(false);
  const [title, setTitle] = useState('');
  const [weeklysessions, setWeeklySessions] = useState(5);
  const [weeklyhours, setWeeklyHours] = useState(8);
  const [avgRpe, setAvgRpe] = useState(6);
  const [maxRpe, setMaxRpe] = useState(8);
  const [hrv, setHrv] = useState(false);
  const [intensityModel, setIntensityModel] = useState('polarised');
  const [focusAreas, setFocusAreas] = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const reset = () => {
    setStep(1); setPlanType(null); setSport(null); setPhase(null); setDuration(null);
    setPrimaryGoal(null); setAdaptiveMode(false); setTitle(''); setWeeklySessions(5);
    setWeeklyHours(8); setAvgRpe(6); setMaxRpe(8); setHrv(false);
    setIntensityModel('polarised'); setFocusAreas([]); setSaving(false); setErr(null);
  };

  const handleClose = () => { reset(); onClose(); };

  const phaseAcwr = PHASES.find((p) => p.key === phase);
  const selectedModel = INTENSITY_MODELS.find((m) => m.key === intensityModel) ?? INTENSITY_MODELS[0];

  const effectiveSteps = (() => {
    const steps = [1, 2];
    if (!skipLoad(planType)) steps.push(3);
    if (!skipIntensity(planType)) steps.push(4);
    steps.push(5);
    return steps;
  })();

  const stepPos = effectiveSteps.indexOf(step) + 1;
  const isLastStep = step === 5;

  const nextStep = () => {
    const idx = effectiveSteps.indexOf(step);
    if (idx < effectiveSteps.length - 1) setStep(effectiveSteps[idx + 1]);
  };
  const prevStep = () => {
    const idx = effectiveSteps.indexOf(step);
    if (idx > 0) setStep(effectiveSteps[idx - 1]);
  };

  const canProceed = () => {
    if (step === 1) return !!planType;
    if (step === 2) return !!sport && !!phase;
    return true;
  };

  const handleCreate = async () => {
    if (!sport || !planType) return;
    setSaving(true); setErr(null);
    try {
      const durationWeeks = DURATION_PRESETS.find((d) => d.key === duration)?.weeks;
      const startDate = new Date().toISOString().split('T')[0];
      const endDate = durationWeeks
        ? new Date(Date.now() + durationWeeks * 7 * 86400000).toISOString().split('T')[0]
        : undefined;
      const metadata = {
        plan_type: planType,
        phase_type: phase || undefined,
        start_date: startDate,
        end_date: endDate,
        primary_goal: primaryGoal || undefined,
        focus_areas: focusAreas.length ? focusAreas : undefined,
        adaptive_mode: adaptiveMode || undefined,
        intensity_model: skipIntensity(planType) ? undefined : intensityModel,
        intensity_zones: skipIntensity(planType) ? undefined : selectedModel.zones,
        weekly_load_sessions: skipLoad(planType) ? undefined : weeklysessions,
        weekly_load_hours: skipLoad(planType) ? undefined : weeklyhours,
        avg_rpe_target: skipLoad(planType) ? undefined : avgRpe,
        max_rpe: skipLoad(planType) ? undefined : maxRpe,
        hrv_protocol: skipLoad(planType) ? undefined : (hrv || undefined),
        acwr_target_min: phaseAcwr ? phaseAcwr.acwr[0] : undefined,
        acwr_target_max: phaseAcwr ? phaseAcwr.acwr[1] : undefined,
      };
      const typeLabel = t(PLAN_TYPES.flatMap((tier) => tier.items).find((item) => item.key === planType)?.label ?? 'ph.new_plan');
      const planTitle = title.trim() || `${typeLabel} — ${athlete?.display_name ?? ''}`;
      const p = await api.post('/training-plans', {
        athlete_id: athlete.id,
        sport,
        title: planTitle,
        metadata,
      });
      reset();
      onCreated(p);
    } catch (e) {
      setErr(e?.message ?? t('ph.err_generic'));
    } finally {
      setSaving(false);
    }
  };

  const toggleFocus = (key) => {
    setFocusAreas((prev) => prev.includes(key) ? prev.filter((f) => f !== key) : prev.length < 6 ? [...prev, key] : prev);
  };

  const sheetTitle = athlete ? `${t('ph.new_plan_for')} ${athlete.display_name}` : t('ph.new_plan');

  return (
    <Sheet
      visible={visible}
      onClose={handleClose}
      title={sheetTitle}
      footer={
        <View style={{ flex: 1, flexDirection: 'row', gap: 10 }}>
          {step > 1 && (
            <Btn
              small
              title={t('ph.back')}
              color={c.paper}
              ink={c.ink}
              onPress={prevStep}
              style={{ flex: 1 }}
            />
          )}
          {isLastStep ? (
            <Btn
              small
              title={saving ? t('ph.creating') : t('ph.create_draft')}
              color={c.amethyst}
              ink={c.onAccent}
              onPress={handleCreate}
              disabled={saving}
              style={{ flex: 2 }}
            />
          ) : (
            <Btn
              small
              title={t('ph.next')}
              color={canProceed() ? c.amethyst : c.line}
              ink={canProceed() ? c.onAccent : c.mute}
              onPress={canProceed() ? nextStep : undefined}
              disabled={!canProceed()}
              style={{ flex: 2 }}
            />
          )}
        </View>
      }
    >
      <StepBar step={stepPos} total={effectiveSteps.length} />

      {/* ── STEP 1: Plan Type ───────────────────────────────────────────── */}
      {step === 1 && (
        <View style={{ gap: 16 }}>
          <T size={15} weight="700" color={c.ink}>{t('ph.step1_title')}</T>
          <T size={13} color={c.mute}>{t('ph.step1_sub')}</T>
          {PLAN_TYPES.map((tier) => (
            <View key={tier.tier} style={{ gap: 8 }}>
              <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 1, textTransform: 'uppercase' }}>{t(tier.tier)}</T>
              {tier.items.map((item) => (
                <PlanTypeCard key={item.key} item={item} active={planType === item.key} onPress={() => setPlanType(item.key)} />
              ))}
            </View>
          ))}
        </View>
      )}

      {/* ── STEP 2: Sport, Phase, Duration, Goal ────────────────────────── */}
      {step === 2 && (
        <View style={{ gap: 16 }}>
          <T size={15} weight="700" color={c.ink}>{t('ph.step2_title')}</T>

          <MenuField
            label={t('ph.sport_label')}
            value={sport}
            onChange={setSport}
            source="sports"
            accessibilityLabel={t('ph.sport_label')}
          />

          <View style={{ gap: 8 }}>
            <T size={13} weight="600" color={c.ink}>{t('ph.phase_label')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {PHASES.map((p) => (
                <Chip key={p.key} label={t(p.label)} active={phase === p.key} onPress={() => setPhase(p.key)} />
              ))}
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <T size={13} weight="600" color={c.ink}>{t('ph.duration_label')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {DURATION_PRESETS.map((d) => (
                <Chip key={d.key} label={d.label} active={duration === d.key} onPress={() => setDuration(d.key)} />
              ))}
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <T size={13} weight="600" color={c.ink}>{t('ph.goal_label')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {GOALS.map((g) => (
                <Chip key={g.key} label={`${g.icon} ${t(g.label)}`} active={primaryGoal === g.key} onPress={() => setPrimaryGoal(g.key)} />
              ))}
            </View>
          </View>

          {/* Para adaptive mode — shown when sport has is_para flag (detected from sport data) */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: r.card, borderWidth: 1, borderColor: adaptiveMode ? c.amethyst : c.line, backgroundColor: adaptiveMode ? c.violetSoft : c.paper }}>
            <T size={22}>♿</T>
            <View style={{ flex: 1 }}>
              <T size={13} weight="700" color={c.ink}>{t('ph.para_mode_label')}</T>
              <T size={12} color={c.mute}>{t('ph.para_mode_desc')}</T>
            </View>
            <Pressable
              onPress={() => setAdaptiveMode((v) => !v)}
              accessibilityRole="switch"
              accessibilityState={{ checked: adaptiveMode }}
              style={{ width: 44, height: 28, borderRadius: 14, backgroundColor: adaptiveMode ? c.amethyst : c.line, justifyContent: 'center', paddingHorizontal: 2 }}
            >
              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.paper, alignSelf: adaptiveMode ? 'flex-end' : 'flex-start' }} />
            </Pressable>
          </View>
        </View>
      )}

      {/* ── STEP 3: Load Architecture ───────────────────────────────────── */}
      {step === 3 && (
        <View style={{ gap: 16 }}>
          <T size={15} weight="700" color={c.ink}>{t('ph.step3_title')}</T>
          <T size={13} color={c.mute}>{t('ph.step3_sub')}</T>

          {phaseAcwr && (
            <View style={{ padding: 14, borderRadius: r.card, backgroundColor: c.violetSoft, borderWidth: 1, borderColor: c.amethyst, gap: 6 }}>
              <T size={12} weight="700" color={c.amethyst} style={{ letterSpacing: 0.8 }}>{t('ph.acwr_phase_label').toUpperCase()}</T>
              <T size={22} weight="800" color={c.amethyst} style={{ letterSpacing: -0.5 }}>{phaseAcwr.acwr[0].toFixed(1)} – {phaseAcwr.acwr[1].toFixed(1)}</T>
              <T size={12} color={c.mute}>{t('ph.acwr_desc')}</T>
            </View>
          )}

          <View style={{ gap: 8 }}>
            <T size={13} weight="600" color={c.ink}>{t('ph.sessions_per_week')} <T size={15} weight="800" color={c.amethyst}>{weeklysessions}</T></T>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {[3, 4, 5, 6, 7, 8, 10, 12].map((n) => (
                <Chip key={n} label={String(n)} active={weeklysessions === n} onPress={() => setWeeklySessions(n)} />
              ))}
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <T size={13} weight="600" color={c.ink}>{t('ph.hours_per_week')} <T size={15} weight="800" color={c.amethyst}>{weeklyhours}h</T></T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {[4, 6, 8, 10, 12, 15, 20, 25].map((n) => (
                <Chip key={n} label={`${n}h`} active={weeklyhours === n} onPress={() => setWeeklyHours(n)} />
              ))}
            </View>
          </View>

          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1, gap: 8 }}>
              <T size={12} weight="600" color={c.ink}>{t('ph.avg_rpe_label')}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                {[4, 5, 6, 7, 8].map((n) => (
                  <Chip key={n} label={String(n)} active={avgRpe === n} onPress={() => setAvgRpe(n)} />
                ))}
              </View>
            </View>
            <View style={{ flex: 1, gap: 8 }}>
              <T size={12} weight="600" color={c.ink}>{t('ph.max_rpe_label')}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                {[7, 8, 9, 10].map((n) => (
                  <Chip key={n} label={String(n)} active={maxRpe === n} onPress={() => setMaxRpe(n)} />
                ))}
              </View>
            </View>
          </View>

          <Pressable
            onPress={() => setHrv((v) => !v)}
            accessibilityRole="switch"
            accessibilityState={{ checked: hrv }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: r.card, borderWidth: 1, borderColor: hrv ? c.lime : c.line, backgroundColor: hrv ? '#E6FAE6' : c.paper }}
          >
            <T size={22}>💓</T>
            <View style={{ flex: 1 }}>
              <T size={13} weight="700" color={c.ink}>{t('ph.hrv_label')}</T>
              <T size={12} color={c.mute}>{t('ph.hrv_desc')}</T>
            </View>
            <View style={{ width: 44, height: 28, borderRadius: 14, backgroundColor: hrv ? c.lime : c.line, justifyContent: 'center', paddingHorizontal: 2 }}>
              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.paper, alignSelf: hrv ? 'flex-end' : 'flex-start' }} />
            </View>
          </Pressable>
        </View>
      )}

      {/* ── STEP 4: Intensity & Focus ────────────────────────────────────── */}
      {step === 4 && (
        <View style={{ gap: 16 }}>
          <T size={15} weight="700" color={c.ink}>{t('ph.step4_title')}</T>

          <View style={{ gap: 10 }}>
            <T size={13} weight="600" color={c.ink}>{t('ph.intensity_model_label')}</T>
            {INTENSITY_MODELS.map((model) => (
              <Pressable
                key={model.key}
                onPress={() => setIntensityModel(model.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: intensityModel === model.key }}
                style={{
                  borderWidth: 1.5,
                  borderColor: intensityModel === model.key ? c.amethyst : c.line,
                  borderRadius: r.card,
                  backgroundColor: intensityModel === model.key ? c.violetSoft : c.paper,
                  padding: 12,
                  gap: 6,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <T size={13} weight="700" color={intensityModel === model.key ? c.amethyst : c.ink}>{t(model.label)}</T>
                  <T size={12} color={c.mute}>{model.zones.map((z) => `${z}%`).join(' / ')}</T>
                </View>
                <IntensityBar zones={model.zones} />
                <T size={11} color={c.mute}>{t(model.desc)}</T>
              </Pressable>
            ))}
          </View>

          <View style={{ gap: 10 }}>
            <T size={13} weight="600" color={c.ink}>{t('ph.focus_label')} <T size={12} color={c.mute}>{t('ph.focus_max')}</T></T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {FOCUS_AREAS.map((key) => (
                <Chip key={key} label={t(key)} active={focusAreas.includes(key)} onPress={() => toggleFocus(key)} />
              ))}
            </View>
          </View>
        </View>
      )}

      {/* ── STEP 5: Review & Create ──────────────────────────────────────── */}
      {step === 5 && (
        <View style={{ gap: 14 }}>
          <T size={15} weight="700" color={c.ink}>{t('ph.step5_title')}</T>

          <View style={{ padding: 16, borderRadius: r.card, borderWidth: 1, borderColor: c.line, gap: 12 }}>
            <SummaryRow icon="📋" label={t('ph.review_type')} value={planType ? t(PLAN_TYPES.flatMap((tier) => tier.items).find((item) => item.key === planType)?.label ?? 'ph.new_plan') : '—'} />
            <SummaryRow icon="🏅" label={t('ph.review_sport')} value={sport ?? '—'} />
            <SummaryRow icon="📍" label={t('ph.review_phase')} value={phase ? t(PHASES.find((p) => p.key === phase)?.label) : '—'} />
            <SummaryRow icon="📅" label={t('ph.review_duration')} value={duration ? DURATION_PRESETS.find((d) => d.key === duration)?.label ?? '—' : '—'} />
            {primaryGoal && <SummaryRow icon="🎯" label={t('ph.review_goal')} value={t(GOALS.find((g) => g.key === primaryGoal)?.label)} />}
            {!skipLoad(planType) && (
              <>
                <SummaryRow icon="📊" label={t('ph.review_sessions')} value={`${weeklysessions}/wk · ${weeklyhours}h`} />
                <SummaryRow icon="💪" label={t('ph.review_rpe')} value={`avg ${avgRpe} · max ${maxRpe}`} />
                {phaseAcwr && <SummaryRow icon="⚖️" label="ACWR" value={`${phaseAcwr.acwr[0].toFixed(1)} – ${phaseAcwr.acwr[1].toFixed(1)}`} />}
              </>
            )}
            {!skipIntensity(planType) && <SummaryRow icon="📈" label={t('ph.review_intensity')} value={t(INTENSITY_MODELS.find((m) => m.key === intensityModel)?.label)} />}
            {focusAreas.length > 0 && <SummaryRow icon="🎯" label={t('ph.review_focus')} value={focusAreas.map((k) => t(k)).join(', ')} />}
            {adaptiveMode && <SummaryRow icon="♿" label={t('ph.review_para')} value={t('ph.para_enabled')} />}
          </View>

          {err && <T size={13} color={c.error ?? '#D04040'}>{err}</T>}
          <T size={12} color={c.mute}>{t('ph.review_note')}</T>
        </View>
      )}
    </Sheet>
  );
}

function SummaryRow({ icon, label, value }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <T size={16}>{icon}</T>
      <T size={13} color={c.mute} style={{ width: 90 }}>{label}</T>
      <T size={13} weight="600" color={c.ink} style={{ flex: 1 }}>{value}</T>
    </View>
  );
}
