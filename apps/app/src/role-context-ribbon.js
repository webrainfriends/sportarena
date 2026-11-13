// Role context ribbon (#1129): always-visible identity strip at the top of every screen showing the
// active role + organisation, with a safe role-switcher that warns when sensitive context will be cleared.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSession } from './session';
import { useWorkspace } from './workspace';
import { roleLabel } from './roles';
import { accentFor, c, r } from './theme';
import { t } from './i18n';
import { Btn, Sheet, T } from './ui';
// All persona role keys from the server workspace definition
const PERSONA_KEYS = ['athlete', 'guardian', 'coach', 'team_manager', 'org_admin', 'event_manager', 'official', 'doctor', 'physio', 'sponsor', 'supplier', 'venue_operator', 'agent', 'media', 'volunteer'];

const CLINICAL_ROLES = new Set(['physio', 'doctor']);

function isClinicalRole(role) {
  return CLINICAL_ROLES.has(role);
}

function RoleItem({ roleKey, label, orgName, isCurrent, onPress }) {
  const dot = accentFor(roleKey);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${t('ctx.ribbon.acting_as')} ${label}${orgName ? `, ${orgName}` : ''}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 48,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 14,
        backgroundColor: isCurrent ? c.pinkSoft : c.bg,
        borderWidth: 2,
        borderColor: isCurrent ? c.pink : 'transparent',
        marginBottom: 8,
      }}
    >
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot, flexShrink: 0 }} />
      <View style={{ flex: 1 }}>
        <T weight="600" size={14}>{label}</T>
        {orgName ? <T size={12} color={c.mute} style={{ marginTop: 1 }}>{orgName}</T> : null}
      </View>
      {isCurrent ? (
        <View style={{ backgroundColor: c.pink, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 }}>
          <T size={10} weight="700" color={c.on} style={{ letterSpacing: 0.5 }}>{t('ctx.ribbon.current').toUpperCase()}</T>
        </View>
      ) : null}
    </Pressable>
  );
}

function SensitiveWarning({ fromRole, toRole }) {
  const show = isClinicalRole(fromRole) || isClinicalRole(toRole);
  if (!show) return null;
  return (
    <View style={{ backgroundColor: c.sunSoft, borderWidth: 1.5, borderColor: c.sun, borderRadius: 12, padding: 12, marginVertical: 10, flexDirection: 'row', gap: 10 }}>
      <T size={18} style={{ flexShrink: 0 }}>⚠️</T>
      <View style={{ flex: 1 }}>
        <T weight="700" size={12} color={c.sun}>{t('ctx.ribbon.sensitive_warning_title')}</T>
        <T size={12} color={c.sun} style={{ marginTop: 2, lineHeight: 17 }}>{t('ctx.ribbon.sensitive_warning_body')}</T>
      </View>
    </View>
  );
}

export function RoleContextRibbon() {
  const { user, activeRole, setActiveRole } = useSession();
  const ws = useWorkspace();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingRole, setPendingRole] = useState(null);
  const [confirming, setConfirming] = useState(false);

  if (!user || !activeRole) return null;

  const orgs = ws?.data?.organisations ?? [];
  const orgName = orgs[0]?.name ?? null;

  const userPersonaRoles = (user.roles ?? []).filter((k) => PERSONA_KEYS.includes(k));
  const displayLabel = roleLabel(activeRole);

  const initials = user.display_name
    ? user.display_name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
    : (user.handle ?? '?').slice(0, 2).toUpperCase();

  function handleRolePress(roleKey) {
    if (roleKey === activeRole) { setSheetOpen(false); return; }
    setPendingRole(roleKey);
    const needsConfirm = isClinicalRole(activeRole) || isClinicalRole(roleKey);
    if (needsConfirm) {
      setConfirming(true);
    } else {
      commitSwitch(roleKey);
    }
  }

  function commitSwitch(roleKey) {
    setActiveRole(roleKey ?? pendingRole);
    setSheetOpen(false);
    setConfirming(false);
    setPendingRole(null);
  }

  function cancelSwitch() {
    setConfirming(false);
    setPendingRole(null);
  }

  return (
    <>
      {/* The ribbon itself */}
      <View
        accessibilityRole="header"
        accessibilityLabel={`${t('ctx.ribbon.acting_as')} ${displayLabel}${orgName ? `, ${orgName}` : ''}`}
        style={{
          backgroundColor: c.violet,
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: 56,
          paddingHorizontal: 16,
          paddingVertical: 10,
          gap: 10,
        }}
      >
        {/* Avatar */}
        <View style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: 'rgba(255,255,255,0.2)',
          borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          {user.avatar_emoji
            ? <T size={16}>{user.avatar_emoji}</T>
            : <T size={12} weight="700" color="#fff">{initials}</T>}
        </View>

        {/* Identity */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <T weight="700" size={13} color="#fff">{displayLabel}</T>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.22)', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 }}>
              <T size={10} weight="700" color="#fff" style={{ letterSpacing: 0.5 }}>{activeRole.replace(/_/g, ' ').toUpperCase()}</T>
            </View>
          </View>
          {orgName ? (
            <T size={11} color="rgba(255,255,255,0.75)" numberOfLines={1} style={{ marginTop: 1 }}>{orgName}</T>
          ) : null}
        </View>

        {/* Switch button */}
        {userPersonaRoles.length > 1 ? (
          <Pressable
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('ctx.ribbon.switch_role')}
            style={{
              backgroundColor: 'rgba(255,255,255,0.18)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.3)',
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 999,
              minHeight: 32,
              justifyContent: 'center',
            }}
          >
            <T size={11} weight="600" color="#fff">{t('ctx.ribbon.switch')} ▾</T>
          </Pressable>
        ) : null}
      </View>

      {/* Role switcher sheet */}
      <Sheet visible={sheetOpen} onClose={() => { setSheetOpen(false); setConfirming(false); setPendingRole(null); }} title={t('ctx.ribbon.switch_role')}>
        <T size={13} color={c.mute} style={{ marginBottom: 16 }}>{t('ctx.ribbon.switch_sub')}</T>

        {!confirming ? (
          userPersonaRoles.map((roleKey) => (
            <RoleItem
              key={roleKey}
              roleKey={roleKey}
              label={roleLabel(roleKey)}
              orgName={orgs[0]?.name ?? null}
              isCurrent={roleKey === activeRole}
              onPress={() => handleRolePress(roleKey)}
            />
          ))
        ) : (
          <>
            <SensitiveWarning fromRole={activeRole} toRole={pendingRole} />
            <Btn title={t('ctx.ribbon.confirm_switch')} onPress={() => commitSwitch(pendingRole)} style={{ marginBottom: 10 }} />
            <Btn title={t('ctx.ribbon.cancel')} onPress={cancelSwitch} color={c.violet} />
          </>
        )}
      </Sheet>
    </>
  );
}

export default RoleContextRibbon;
