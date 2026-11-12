// Role picker (#1126): first-time and return role selection with 6 role tiles.
import React, { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Btn, Card, T } from '../ui';
import { c, r } from '../theme';
import { t } from '../i18n';
import { useNav } from '../nav';

const PERSONAL_ROLES = [
  { role: 'coach', icon: '🎯', labelKey: 'rp.role.coach', descKey: 'rp.role.coachDesc', route: 'CoachProfileWizard' },
  { role: 'official', icon: '🏳️', labelKey: 'rp.role.official', descKey: 'rp.role.officialDesc', route: 'OfficialProfileWizard' },
  { role: 'physio', icon: '🩺', labelKey: 'rp.role.physio', descKey: 'rp.role.physioDesc', route: 'PhysioProfileWizard' },
  { role: 'sponsor', icon: '🏆', labelKey: 'rp.role.sponsor', descKey: 'rp.role.sponsorDesc', route: 'SponsorWizard' },
];
const ORG_ROLES = [
  { role: 'academy', icon: '🏫', labelKey: 'rp.role.academy', descKey: 'rp.role.academyDesc', route: 'AcademySetup', params: { kind: 'academy' } },
  { role: 'organisation', icon: '🏟️', labelKey: 'rp.role.organisation', descKey: 'rp.role.organisationDesc', route: 'OrgWizard' },
];

function RoleTile({ role, icon, labelKey, descKey, selected, onPress }) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1, minWidth: 140, maxWidth: 200 }}
      accessible accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
      accessibilityLabel={`${t(labelKey)}: ${t(descKey)}`}>
      <Card style={{ padding: 16, borderWidth: 2, borderColor: selected ? c.pink : c.line, borderRadius: r.card, alignItems: 'center', gap: 8 }}>
        <T size={36}>{icon}</T>
        <T size={15} weight="800" color={c.ink} style={{ textAlign: 'center' }}>{t(labelKey)}</T>
        <T size={12} color={c.mute} style={{ textAlign: 'center' }}>{t(descKey)}</T>
        {selected && (
          <View style={{ position: 'absolute', top: 10, right: 10, width: 22, height: 22, borderRadius: 11, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}>
            <T size={14} color="#fff" weight="900">✓</T>
          </View>
        )}
      </Card>
    </Pressable>
  );
}

export function RolePicker({ onClose: close, onDone }) {
  const nav = useNav();
  const onClose = close ?? nav.back;
  const [selected, setSelected] = useState([]);
  const toggle = (role) => setSelected((prev) => prev.includes(role) ? prev.filter((x) => x !== role) : [...prev, role]);

  const handleContinue = () => {
    if (selected.length === 0) return;
    if (onDone) { onDone(selected); return; }
    const allRoles = [...PERSONAL_ROLES, ...ORG_ROLES];
    const first = allRoles.find((x) => selected.includes(x.role));
    if (first) nav.push(first.route, first.params ?? {});
    else onClose();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
      <T size={28} weight="900" color={c.ink} style={{ marginBottom: 6 }}>{t('rp.title')}</T>
      <T size={14} color={c.mute} style={{ marginBottom: 24 }}>{t('rp.subtitle')}</T>

      <T size={12} weight="700" color={c.mute} style={{ marginBottom: 10, letterSpacing: 0.8 }}>{t('rp.section.personal').toUpperCase()}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
        {PERSONAL_ROLES.map((role) => (
          <RoleTile key={role.role} {...role} selected={selected.includes(role.role)} onPress={() => toggle(role.role)} />
        ))}
      </View>

      <T size={12} weight="700" color={c.mute} style={{ marginBottom: 10, letterSpacing: 0.8 }}>{t('rp.section.organisation').toUpperCase()}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 32 }}>
        {ORG_ROLES.map((role) => (
          <RoleTile key={role.role} {...role} selected={selected.includes(role.role)} onPress={() => toggle(role.role)} />
        ))}
      </View>

      <Btn label={selected.length > 0 ? t('rp.continue', { count: selected.length }) : t('rp.selectAtLeastOne')} disabled={selected.length === 0} onPress={handleContinue} />
      <Btn label={t('rp.skip')} variant="ghost" onPress={onClose} style={{ marginTop: 10 }} />
    </ScrollView>
  );
}
