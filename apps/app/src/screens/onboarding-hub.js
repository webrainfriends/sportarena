// Cross-role onboarding hub (#1126): 6-role setup overview with completeness rings and CTAs.
import React, { useCallback } from 'react';
import { View, ScrollView, Pressable, Platform } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { c, r } from '../theme';
import { t } from '../i18n';
import { useNav } from '../nav';

const SECTION_ORDER = ['personal','organisation'];

function RingProgress({ score, size = 48 }) {
  const pct = Math.min(100, Math.max(0, score ?? 0));
  const fillColor = pct >= 80 ? c.lime : pct >= 50 ? c.sun : pct > 0 ? c.orange : c.line;
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;
  if (Platform.OS === 'web') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <svg width={size} height={size} style={{ position: 'absolute' }}>
          <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke={c.line} strokeWidth={4} />
          <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke={fillColor} strokeWidth={4}
            strokeDasharray={`${dash} ${circumference}`} strokeLinecap="round"
            transform={`rotate(-90 ${size/2} ${size/2})`} />
        </svg>
        <T size={10} weight="800" color={fillColor}>{pct}%</T>
      </View>
    );
  }
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', borderRadius: size/2, borderWidth: 3, borderColor: fillColor }}>
      <T size={9} weight="800" color={fillColor}>{pct}%</T>
    </View>
  );
}

function statusChip(status) {
  if (status === 'published') return { label: t('onb.status.published'), bg: c.lime, ink: '#fff' };
  if (status === 'in_progress') return { label: t('onb.status.in_progress'), bg: c.sun, ink: '#fff' };
  return { label: t('onb.status.not_started'), bg: c.line, ink: c.mute };
}

export function OnboardingRoleCard({ role, label, icon, section, status, completeness_pct, step_reached, entry_route, entry_params, dismissed, onSetup, onDismiss }) {
  const chip = statusChip(status);
  const canSetup = status !== 'published';
  return (
    <Card style={{ marginBottom: 12, padding: 16 }} accessible accessibilityLabel={`${label}: ${chip.label}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <RingProgress score={completeness_pct} size={52} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <T size={22}>{icon}</T>
            <T size={16} weight="800" color={c.ink}>{label}</T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ backgroundColor: chip.bg, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
              <T size={11} weight="700" color={chip.ink}>{chip.label}</T>
            </View>
            {status === 'in_progress' && step_reached != null && (
              <T size={11} color={c.mute}>{t('onb.card.stepN', { n: step_reached + 1 })}</T>
            )}
          </View>
        </View>
        {status === 'published' && <T size={22}>✅</T>}
      </View>
      {canSetup && (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          <Btn label={status === 'in_progress' ? t('onb.card.resume') : t('onb.card.setup')} variant="primary" onPress={() => onSetup?.(entry_route, entry_params)} style={{ flex: 1 }} />
          {!dismissed && status === 'not_started' && (
            <Btn label={t('onb.card.later')} variant="ghost" onPress={() => onDismiss?.(role)} />
          )}
        </View>
      )}
      {status === 'published' && (
        <Btn label={t('onb.card.edit')} variant="outline" onPress={() => onSetup?.(entry_route, entry_params)} style={{ marginTop: 10 }} />
      )}
    </Card>
  );
}

export function RoleSetupBanner({ onPress }) {
  const roles = useLoad(() => api.get('/me/onboarding/roles'), []);
  if (roles.loading || roles.error) return null;
  const incomplete = (roles.data ?? []).filter((row) => row.status !== 'published' && !row.dismissed);
  if (incomplete.length === 0) return null;
  return (
    <Pressable onPress={onPress}
      style={{ marginHorizontal: 16, marginBottom: 12, borderRadius: r.card, backgroundColor: c.pinkSoft, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}
      accessible accessibilityRole="button" accessibilityLabel={t('onb.banner.a11y', { count: incomplete.length })}>
      <T size={24}>🎯</T>
      <View style={{ flex: 1 }}>
        <T size={14} weight="800" color={c.ink}>{t('onb.banner.title')}</T>
        <T size={12} color={c.mute}>{t('onb.banner.body', { count: incomplete.length })}</T>
      </View>
      <T size={18} color={c.pink}>›</T>
    </Pressable>
  );
}

export function OnboardingHub({ onClose: close }) {
  const nav = useNav();
  const onClose = close ?? nav.back;
  const roles = useLoad(() => api.get('/me/onboarding/roles'), []);

  const handleSetup = useCallback((route, params) => {
    nav.push(route, params ?? {});
  }, [nav]);

  const handleDismiss = useCallback(async (role) => {
    try {
      await api.post(`/me/onboarding/roles/${role}/dismiss`, {});
      roles.reload();
    } catch (_) {}
  }, [roles]);

  if (roles.error) return (
    <View style={{ padding: 20 }}>
      <ErrorBox error={roles.error} onRetry={roles.reload} />
    </View>
  );
  if (!roles.data) return <Loading />;

  const data = roles.data ?? [];
  const sections = SECTION_ORDER.map((sec) => ({
    key: sec,
    label: t(`onb.section.${sec}`),
    items: data.filter((row) => row.section === sec),
  }));

  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
      <View style={{ marginBottom: 20, padding: 16, borderRadius: r.card, backgroundColor: c.pinkSoft }}>
        <T size={22} weight="900" color={c.ink} style={{ marginBottom: 4 }}>{t('onb.hub.title')}</T>
        <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('onb.hub.subtitle')}</T>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <View style={{ alignItems: 'center' }}>
            <T size={28} weight="900" color={c.pink}>{data.filter((row) => row.status === 'published').length}</T>
            <T size={11} color={c.mute}>{t('onb.hub.published')}</T>
          </View>
          <View style={{ alignItems: 'center' }}>
            <T size={28} weight="900" color={c.sun}>{data.filter((row) => row.status === 'in_progress').length}</T>
            <T size={11} color={c.mute}>{t('onb.hub.inProgress')}</T>
          </View>
          <View style={{ alignItems: 'center' }}>
            <T size={28} weight="900" color={c.mute}>{data.filter((row) => row.status === 'not_started').length}</T>
            <T size={11} color={c.mute}>{t('onb.hub.notStarted')}</T>
          </View>
        </View>
      </View>
      {sections.map((sec) => (
        <View key={sec.key}>
          <T size={12} weight="700" color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.8 }}>{sec.label.toUpperCase()}</T>
          {sec.items.map((role) => (
            <OnboardingRoleCard key={role.role} {...role} onSetup={handleSetup} onDismiss={handleDismiss} />
          ))}
        </View>
      ))}
      <Btn label={t('onb.hub.close')} variant="ghost" onPress={onClose} style={{ marginTop: 12 }} />
    </ScrollView>
  );
}
