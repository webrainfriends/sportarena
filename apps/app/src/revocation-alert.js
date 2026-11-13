// Revocation alert (#1129): shown when the API returns 403 with code 'membership_revoked' or
// 'access_revoked'. Informs the user what was removed, confirms stale data was cleared, and
// offers to view the security history.
import React from 'react';
import { Pressable, View } from 'react-native';
import { c, r } from './theme';
import { t } from './i18n';
import { T } from './ui';

/**
 * @param {{ orgName: string, reason?: string, activeRole?: string, activeOrg?: string,
 *           screensCleared?: number, linksCleared?: number, exportsCleared?: number,
 *           onDismiss: () => void, onViewHistory: () => void }} props
 */
export function RevocationAlert({ orgName, reason, activeRole, activeOrg, screensCleared = 0, linksCleared = 0, exportsCleared = 0, onDismiss, onViewHistory }) {
  const body = t('revoke.body').replace('{org}', orgName ?? '—');
  const sessionSafe = activeRole && activeOrg
    ? t('revoke.session_safe').replace('{role}', activeRole).replace('{org}', activeOrg)
    : null;
  const clearedBody = screensCleared + linksCleared + exportsCleared > 0
    ? t('revoke.cleared_body')
        .replace('{screens}', String(screensCleared))
        .replace('{links}',   String(linksCleared))
        .replace('{exports}', String(exportsCleared))
    : null;

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={{
        backgroundColor: c.redSoft,
        borderWidth: 2,
        borderColor: c.red,
        borderRadius: r.card,
        padding: 16,
        gap: 12,
      }}
    >
      {/* Header */}
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <T size={22} style={{ flexShrink: 0 }}>🚫</T>
        <View style={{ flex: 1 }}>
          <T weight="700" size={15} color={c.red}>{t('revoke.title')}</T>
          <T size={13} color={c.red} style={{ marginTop: 4, lineHeight: 19 }}>{body}</T>
        </View>
      </View>

      {/* What was cleared */}
      {clearedBody ? (
        <View style={{ backgroundColor: c.redSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, gap: 4 }}>
          <T weight="600" size={12} color={c.red}>{t('revoke.cleared_title')}</T>
          <T size={12} color={c.red}>{clearedBody}</T>
        </View>
      ) : null}

      {/* Session unaffected notice */}
      {sessionSafe ? (
        <View style={{ backgroundColor: c.limeSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <T size={15}>✅</T>
          <T size={12} color={c.lime} style={{ flex: 1 }}>{sessionSafe}</T>
        </View>
      ) : null}

      {/* Actions */}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={t('revoke.understand')}
          style={{ flex: 1, minWidth: 120, backgroundColor: c.red, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center' }}
        >
          <T weight="700" size={13} color="#fff">{t('revoke.understand')}</T>
        </Pressable>
        {onViewHistory ? (
          <Pressable
            onPress={onViewHistory}
            accessibilityRole="button"
            accessibilityLabel={t('revoke.view_history')}
            style={{ flex: 1, minWidth: 120, backgroundColor: c.redSoft, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1.5, borderColor: c.red }}
          >
            <T weight="700" size={13} color={c.red}>{t('revoke.view_history')}</T>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default RevocationAlert;
