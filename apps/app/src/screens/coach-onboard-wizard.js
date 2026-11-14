// Coach onboarding wizard — 7-step guided journey from new coach to live profile.
// Phone: scrollable step list. Tablet/desktop: fixed sidebar + active step main area.
// Each step links to the existing screen that does the work (no duplication).
import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useGo } from '../workspace';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { Btn, Card, Chip, ErrorBox, H1, Loading, Screen, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';

const STEP_ORDER = ['profile', 'sports', 'drills', 'classes', 'rates', 'payout', 'publish'];

function stepIcon(key, done) {
  if (done) return '✓';
  const icons = { profile: '👤', sports: '🏅', drills: '🗂', classes: '📅', rates: '💰', payout: '🏦', publish: '🚀' };
  return icons[key] ?? '•';
}

function Bar({ done, total }) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: total, now: done }} accessibilityLabel={t('cow.n_of', { done, total })} style={{ height: 6, borderRadius: 3, backgroundColor: c.violetSoft, overflow: 'hidden' }}>
      <View style={{ width: `${total ? (done / total) * 100 : 0}%`, height: 6, backgroundColor: c.mint }} />
    </View>
  );
}

function StepDot({ n, done, active, onPress }) {
  const bg = done ? c.mint : active ? c.pink : c.violetSoft;
  const ink = done || active ? c.onAccent : c.mute;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', borderWidth: active ? 2 : 0, borderColor: c.pink }}>
      <T size={12} weight="800" color={ink}>{done ? '✓' : n}</T>
    </Pressable>
  );
}

function StepCard({ step, n, active, tablet, onPress }) {
  const done = step.done;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={t('cow.open_step', { title: t(`cow.step.${step.key}.label`) })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14,
        backgroundColor: active ? c.violetSoft : 'transparent',
        borderRadius: 10, borderWidth: active && !tablet ? 2 : 0, borderColor: c.pink }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: done ? c.mint : active ? c.pinkSoft : c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
        <T size={15} weight="800" color={done ? c.onAccent : active ? c.pink : c.mute}>{done ? '✓' : n}</T>
      </View>
      <View style={{ flex: 1 }}>
        <T weight={active ? '800' : '600'} color={done ? c.mute : active ? c.ink : c.ink} style={{ textDecorationLine: done ? 'line-through' : 'none' }}>{t(`cow.step.${step.key}.label`)}</T>
        {active ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t(`cow.step.${step.key}.why`)}</T> : null}
      </View>
      {done ? null : <T size={12} weight="700" color={active ? c.pink : c.mute}>{active ? t('cow.open_step_active') : '›'}</T>}
    </Pressable>
  );
}

function ActiveStepDetail({ step, onGo }) {
  const icon = stepIcon(step.key, step.done);
  return (
    <Card pad={20} color={c.violetSoft} style={{ flex: 1 }}>
      <T size={28}>{icon}</T>
      <T weight="800" size={18} style={{ marginTop: 8 }}>{t(`cow.step.${step.key}.title`)}</T>
      <T size={14} color={c.mute} style={{ marginTop: 6, lineHeight: 22 }}>{t(`cow.step.${step.key}.why`)}</T>
      <View style={{ marginTop: 6, padding: 12, backgroundColor: c.mintSoft, borderRadius: 8 }}>
        <T size={12} weight="700" color={c.mint}>{t('cow.tip_label')}</T>
        <T size={12.5} color={c.ink} style={{ marginTop: 4, lineHeight: 18 }}>{t(`cow.step.${step.key}.tip`)}</T>
      </View>
      <View style={{ marginTop: 16 }}>
        <Btn title={step.done ? t('cow.edit_step') : t('cow.open_step_active')} onPress={onGo} />
      </View>
    </Card>
  );
}

export function CoachOnboardWizard({ step: initialStep }) {
  const { push, pop } = useNav();
  const go = useGo();
  const { tablet } = useLayout();
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/launch-checklist', { persona: 'coach' }), []);
  const d = q.data;

  const steps = (d?.steps ?? []).filter((s) => STEP_ORDER.includes(s.key)).sort((a, b) => STEP_ORDER.indexOf(a.key) - STEP_ORDER.indexOf(b.key));
  const firstIncomplete = steps.find((s) => !s.done);
  const defaultActive = initialStep ?? firstIncomplete?.key ?? steps[0]?.key;
  const [activeKey, setActiveKey] = React.useState(defaultActive);
  React.useEffect(() => { if (defaultActive && !activeKey) setActiveKey(defaultActive); }, [defaultActive]);

  const activeStep = steps.find((s) => s.key === activeKey) ?? steps[0];

  const openStep = (s) => {
    if (!s?.target) return;
    go(s.target);
  };

  const done = steps.filter((s) => s.done).length;
  const total = steps.length;

  if (q.error) return <Screen onRefresh={q.reload}><ErrorBox error={q.error} onRetry={q.reload} /></Screen>;
  if (!d) return <Screen><Loading /></Screen>;

  if (done === total && total > 0) {
    return (
      <Screen wide>
        <View style={{ alignItems: 'center', paddingVertical: 40, gap: 12 }}>
          <T size={48}>🚀</T>
          <H1 style={{ textAlign: 'center' }}>{t('cow.all_done_toast')}</H1>
          <T size={14} color={c.mute} style={{ textAlign: 'center' }}>{t('cow.setup_steps')}</T>
          <Btn title={t('cow.done')} onPress={() => go({ screen: 'CoachHome', params: {} })} />
        </View>
      </Screen>
    );
  }

  if (tablet) {
    return (
      <Screen wide scrollable={false}>
        <View style={{ flexDirection: 'row', flex: 1, gap: 16 }}>
          {/* Sidebar */}
          <View style={{ width: 280, gap: 4 }}>
            <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2, marginBottom: 4 }}>{t('cow.title')}</T>
            <Bar done={done} total={total} />
            <T size={12} color={c.mute} style={{ marginTop: 4, marginBottom: 12 }}>{t('cow.n_of', { done, total })}</T>
            {steps.map((s, i) => (
              <StepCard key={s.key} step={s} n={i + 1} active={activeKey === s.key} tablet onPress={() => setActiveKey(s.key)} />
            ))}
          </View>
          {/* Main */}
          <View style={{ flex: 1 }}>
            {activeStep ? <ActiveStepDetail step={activeStep} onGo={() => openStep(activeStep)} /> : null}
          </View>
        </View>
      </Screen>
    );
  }

  // Phone layout
  return (
    <Screen wide onRefresh={q.reload} refreshing={q.loading && !!d}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('cow.title')}</T>
      <H1 style={{ fontSize: 24, marginTop: 2 }}>{t('cow.setup_steps')}</H1>
      <View style={{ marginTop: 10 }}>
        <Bar done={done} total={total} />
        <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('cow.n_of', { done, total })}</T>
      </View>
      <View style={{ marginTop: 16, gap: 10 }}>
        {steps.map((s, i) => (
          <StepCard key={s.key} step={s} n={i + 1} active={activeKey === s.key} tablet={false}
            onPress={() => { setActiveKey(s.key); if (activeKey === s.key) openStep(s); }} />
        ))}
      </View>
      {activeStep && !activeStep.done ? (
        <View style={{ marginTop: 20 }}>
          <Btn title={t('cow.open_step_active')} onPress={() => openStep(activeStep)} />
        </View>
      ) : null}
    </Screen>
  );
}
