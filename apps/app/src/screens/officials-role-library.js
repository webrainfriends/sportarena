// REF-R30: Official Role Library (#1028).
// Sport-specific role taxonomy: browse roles by sport and family, view full detail
// (qualifications, duties, platform permissions, rule pack source). Platform admin can
// create, edit and archive roles via the upsert_sport_official_role capability.
// Reuses ROLE_LABEL / ROLE_ICON from officials-crew.js.
import React, { useState } from 'react';
import { View, ScrollView, FlatList, Pressable, Platform } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, grad, r as radius } from '../theme';
import { t } from '../i18n';
import { ROLE_LABEL, ROLE_ICON } from './officials-crew';

const FAMILY_LABEL = {
  match_official:         t('official_role_library.family_match'),
  video_official:         t('official_role_library.family_video'),
  technical_official:     t('official_role_library.family_technical'),
  administrative_official: t('official_role_library.family_administrative'),
  safety_official:        t('official_role_library.family_safety'),
  support_official:       t('official_role_library.family_support'),
};

const FAMILY_COLOR = {
  match_official:          c.pinkSoft,
  video_official:          '#E8E0F5',
  technical_official:      c.cyanSoft,
  administrative_official: c.sunSoft,
  safety_official:         c.redSoft,
  support_official:        c.mintSoft,
};

const FAMILY_INK = {
  match_official:          c.pink,
  video_official:          c.violet,
  technical_official:      c.cyan,
  administrative_official: c.sun,
  safety_official:         c.red,
  support_official:        c.mint,
};

function FamilyChip({ family }) {
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, backgroundColor: FAMILY_COLOR[family] ?? c.bg }}>
      <T style={{ fontSize: 10, fontWeight: '800', color: FAMILY_INK[family] ?? c.mute, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {FAMILY_LABEL[family] ?? family?.replace(/_/g, ' ')}
      </T>
    </View>
  );
}

function RoleRow({ role, onPress }) {
  const icon = ROLE_ICON[role.role_key] ?? '🧑‍⚖️';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${role.display_name}, ${FAMILY_LABEL[role.family] ?? role.family}, ${role.governing_body ?? ''}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'flex-start', gap: 12,
        paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.line,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: FAMILY_COLOR[role.family] ?? c.bg, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ fontSize: 22 }}>{icon}</T>
      </View>
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: 15, fontWeight: '700', color: c.ink, marginBottom: 2 }}>{role.display_name}</T>
        <T style={{ fontSize: 12, color: c.mute, lineHeight: 18 }} numberOfLines={2}>
          {(role.duties ?? [])[0] ?? role.governing_body ?? ''}
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
          <FamilyChip family={role.family} />
          {role.governing_body ? <Tag label={role.governing_body} color={c.mintSoft} /> : null}
          {role.min_grade ? <Tag label={role.min_grade} color={c.bg} /> : null}
          {role.mandatory === false ? <Tag label={t('official_role_library.optional')} color={c.bg} /> : null}
        </View>
      </View>
      <T style={{ fontSize: 20, color: c.mute, alignSelf: 'center' }}>›</T>
    </Pressable>
  );
}

function QualRow({ cred }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: c.cyanSoft, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ fontSize: 16 }}>🎓</T>
      </View>
      <T style={{ flex: 1, fontSize: 14, fontWeight: '600', color: c.ink }}>{cred.label}</T>
      <T style={{ fontSize: 11, fontWeight: '700', color: cred.required ? c.red : c.sun }}>
        {cred.required ? t('official_role_library.required') : t('official_role_library.recommended')}
      </T>
    </View>
  );
}

function PermRow({ perm }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <T style={{ fontSize: 16 }}>{perm.granted ? '✅' : '🚫'}</T>
      <T style={{ flex: 1, fontSize: 13, color: c.ink }}>{perm.label}</T>
      <T style={{ fontSize: 12, fontWeight: '700', color: perm.granted ? c.mint : c.mute }}>
        {perm.granted ? t('official_role_library.permission_granted') : t('official_role_library.permission_denied')}
      </T>
    </View>
  );
}

function RoleDetail({ role, onEdit, canAdmin }) {
  if (!role) return null;
  const creds = Array.isArray(role.requires_credentials) ? role.requires_credentials : [];
  const duties = Array.isArray(role.duties) ? role.duties : [];
  const perms = Array.isArray(role.permissions) ? role.permissions : [];

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      {/* Hero */}
      <GradCard
        colors={grad.hero}
        accessibilityLabel={`${role.display_name}, ${role.sport_name ?? role.sport_code}`}
        style={{ padding: 20, borderRadius: 18, marginBottom: 2 }}
      >
        <T style={{ fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.8)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
          {FAMILY_LABEL[role.family] ?? role.family} · {role.sport_name ?? role.sport_code}
        </T>
        <T style={{ fontSize: 22, fontWeight: '800', color: '#fff', lineHeight: 28, marginBottom: 6 }}>
          {role.display_name}
        </T>
        <T style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', lineHeight: 20 }} numberOfLines={3}>
          {duties[0] ?? ''}
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {[
            role.min_count === role.max_count ? `×${role.min_count}` : `×${role.min_count}–${role.max_count}`,
            role.governing_body,
            role.source_version ? `v${role.source_version}` : null,
          ].filter(Boolean).map((v, i) => (
            <View key={i} style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 }}>
              <T style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{v}</T>
            </View>
          ))}
        </View>
      </GradCard>

      {/* Meta */}
      <Card style={{ padding: 14 }}>
        {[
          { label: t('official_role_library.rule_pack'), value: role.source ? `${role.source} ${role.source_version ?? ''}`.trim() : '—' },
          { label: t('official_role_library.effective_from'), value: role.effective_from ?? '—' },
          { label: t('official_role_library.governing_body'), value: role.governing_body ?? '—' },
          { label: t('official_role_library.family_label'), value: FAMILY_LABEL[role.family] ?? role.family },
          { label: t('official_role_library.mandatory'), value: role.mandatory ? t('common.yes') : t('common.no') },
          { label: t('official_role_library.crew_count'), value: role.min_count === role.max_count ? String(role.min_count) : `${role.min_count}–${role.max_count}` },
        ].map(({ label, value }) => (
          <View key={label} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <T style={{ fontSize: 13, color: c.mute }}>{label}</T>
            <T style={{ fontSize: 13, fontWeight: '600', color: c.ink, textAlign: 'right', maxWidth: '60%' }}>{value}</T>
          </View>
        ))}
      </Card>

      {/* Required qualifications */}
      {creds.length > 0 ? (
        <Section title={t('official_role_library.qualifications')} color={c.cyan}>
          <Card style={{ padding: 14 }}>
            {creds.map((cr, i) => <QualRow key={i} cred={cr} />)}
          </Card>
        </Section>
      ) : null}

      {/* Duties */}
      {duties.length > 0 ? (
        <Section title={t('official_role_library.duties')} color={c.pink}>
          <Card style={{ padding: 14 }}>
            {duties.map((d, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 8, borderBottomWidth: i < duties.length - 1 ? 1 : 0, borderBottomColor: c.line }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.pink, marginTop: 5, flexShrink: 0 }} />
                <T style={{ flex: 1, fontSize: 13, color: c.ink, lineHeight: 20 }}>{d}</T>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {/* Platform permissions */}
      {perms.length > 0 ? (
        <Section title={t('official_role_library.permissions')} color={c.violet}>
          <Card style={{ padding: 14 }}>
            {perms.map((p, i) => <PermRow key={i} perm={p} />)}
          </Card>
        </Section>
      ) : null}

      {canAdmin ? (
        <Btn
          title={t('official_role_library.archive_role')}
          color={c.redSoft} ink={c.red}
          onPress={onEdit}
          style={{ marginTop: 8, minHeight: 48 }}
          accessibilityLabel={t('official_role_library.archive_role')}
        />
      ) : null}
    </ScrollView>
  );
}

export default function OfficialsRoleLibraryScreen() {
  const { user } = useSession();
  const { width } = useLayout();
  const nav = useNav();
  const isTablet = width >= 744;
  const canAdmin = user?.roles?.includes('platform_admin') || user?.roles?.includes('admin');

  const [sportFilter, setSportFilter] = useState('all');
  const [selectedRole, setSelectedRole] = useState(null);
  const [showDetail, setShowDetail] = useState(false);

  const sportsQ = useLoad(() => api.get('/sports', { limit: 20 }), []);
  const rolesQ = useLoad(
    () => sportFilter === 'all'
      ? api.get('/official-roles', { limit: 200 })
      : api.get(`/sports/${sportFilter}/official-roles`).then((d) => ({ roles: d.roles })),
    [sportFilter],
  );

  const sports = [{ id: 'all', name: t('official_role_library.all_sports'), slug: 'all' }, ...(sportsQ.data?.sports ?? [])];
  const roles = rolesQ.data?.roles ?? [];

  // Group by family
  const grouped = {};
  for (const role of roles) {
    const fam = role.family ?? 'match_official';
    if (!grouped[fam]) grouped[fam] = [];
    grouped[fam].push(role);
  }
  const families = Object.keys(grouped).sort();

  const totalRoles = roles.length;
  const totalFamilies = families.length;
  const govBodies = [...new Set(roles.map((r) => r.governing_body).filter(Boolean))].length;

  const openRole = (role) => {
    setSelectedRole(role);
    if (!isTablet) setShowDetail(true);
  };

  const archiveRole = async () => {
    if (!selectedRole) return;
    try {
      await api.post(`/official-roles/${selectedRole.id}/archive`, {});
      rolesQ.reload();
      setSelectedRole(null);
      if (!isTablet) setShowDetail(false);
    } catch {}
  };

  const content = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {/* Sport filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: 6, paddingRight: 8 }}>
          {sports.slice(0, 8).map((s) => (
            <Pressable
              key={s.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: sportFilter === s.id }}
              onPress={() => setSportFilter(s.id)}
              style={{
                borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
                backgroundColor: sportFilter === s.id ? c.pink : c.bg,
                borderWidth: 1, borderColor: sportFilter === s.id ? c.pink : c.line,
              }}
            >
              <T style={{ fontSize: 13, fontWeight: '600', color: sportFilter === s.id ? '#fff' : c.mute }}>{s.name}</T>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {/* Metric strip */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[
          { v: totalRoles, l: t('official_role_library.metric_roles') },
          { v: totalFamilies, l: t('official_role_library.metric_families') },
          { v: govBodies || '—', l: t('official_role_library.metric_governing_bodies') },
        ].map(({ v, l }) => (
          <View key={l} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 14, padding: 12, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.05, shadowOffset: { width: 0, height: 2 }, shadowRadius: 4 }}>
            <T style={{ fontSize: 20, fontWeight: '800', color: c.ink }}>{v}</T>
            <T style={{ fontSize: 10, fontWeight: '600', color: c.mute, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2, textAlign: 'center' }}>{l}</T>
          </View>
        ))}
      </View>

      {rolesQ.loading && !rolesQ.data ? <Loading /> : null}
      {rolesQ.error ? <LoadError onRetry={rolesQ.reload} /> : null}

      {families.map((fam) => (
        <View key={fam}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <T style={{ fontSize: 12, fontWeight: '700', color: c.mute, textTransform: 'uppercase', letterSpacing: 0.6 }}>
              {FAMILY_LABEL[fam] ?? fam?.replace(/_/g, ' ')}
            </T>
            <T style={{ fontSize: 13, color: c.mute }}>{grouped[fam].length}</T>
          </View>
          <Card style={{ padding: 14 }}>
            {grouped[fam].map((role) => (
              <RoleRow
                key={role.id}
                role={role}
                onPress={() => openRole(role)}
              />
            ))}
          </Card>
        </View>
      ))}

      {roles.length === 0 && !rolesQ.loading ? (
        <Empty
          label={t('official_role_library.empty')}
          sublabel={t('official_role_library.empty_sub')}
        />
      ) : null}
    </ScrollView>
  );

  if (isTablet) {
    return (
      <Screen
        title={t('official_role_library.title')}
        right={canAdmin ? <Pressable accessibilityRole="button" onPress={() => nav.push('OfficialRoleEdit')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
          <T style={{ color: c.pink, fontWeight: '700', fontSize: 14 }}>{t('official_role_library.new')}</T>
        </Pressable> : null}
      >
        <View style={{ flex: 1, flexDirection: 'row', gap: 0 }}>
          <View style={{ width: 320, borderRightWidth: 1, borderRightColor: c.line }}>
            {content}
          </View>
          <View style={{ flex: 1 }}>
            {selectedRole
              ? <RoleDetail role={selectedRole} onEdit={archiveRole} canAdmin={canAdmin} />
              : <Empty label={t('official_role_library.select_prompt')} />}
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      title={t('official_role_library.title')}
      right={canAdmin ? <Pressable accessibilityRole="button" onPress={() => nav.push('OfficialRoleEdit')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
        <T style={{ color: c.pink, fontWeight: '700', fontSize: 14 }}>{t('official_role_library.new')}</T>
      </Pressable> : null}
    >
      {content}
      <Sheet visible={showDetail} onClose={() => setShowDetail(false)} accessibilityLabel={selectedRole?.display_name ?? ''}>
        <RoleDetail role={selectedRole} onEdit={archiveRole} canAdmin={canAdmin} />
      </Sheet>
    </Screen>
  );
}
