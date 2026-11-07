// PS-21: Para-sport staff credentials wallet and track browser.
// Three tabs: My Credentials · Renewal Due · Browse Tracks.
// Works on iOS, iPadOS, Android and web. Adapts from phone to tablet/desktop.
// Classifier-candidate credentials carry an explicit "learning only" note.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, TouchableOpacity, Platform, TextInput, StyleSheet } from 'react-native';
import { useTheme } from '../theme';
import { useLoad, useLayout } from '../hooks';
import { api } from '../api';
import { t } from '../i18n';
import { Seg, Card, Chip, Empty, Row, Btn, T, Tag, Section } from '../ui';
import { MenuField } from '../fields';

// ── small helpers ─────────────────────────────────────────────────────────────

function statusColor(status, c) {
  return { valid: c.lime, expiring_soon: c.sun, expired: c.red, revoked: c.mute }[status] ?? c.mute;
}
function statusSoftColor(status, c) {
  return { valid: c.limeSoft, expiring_soon: c.sunSoft, expired: c.redSoft, revoked: c.violetSoft }[status] ?? c.violetSoft;
}
function statusLabel(status) {
  return t(`paraStaffCred.${status === 'expiring_soon' ? 'expiringSoon' : status}`);
}
const ROLE_OPTS = ['adaptive_coach', 'para_referee', 'technical_official', 'guide_support', 'classifier_candidate'];
function roleLabel(r) { return t(`paraStaffCred.roleCategory.${r}`); }
function levelLabel(l) { return l ? t(`paraStaffCred.level.${l}`) : null; }

// ── Credential card ──────────────────────────────────────────────────────────

function CredCard({ cred, push, c, s }) {
  const statusBg = statusSoftColor(cred.expiry_status, c);
  const statusFg = statusColor(cred.expiry_status, c);
  return (
    <TouchableOpacity
      style={[s.card, { borderLeftColor: statusFg, borderLeftWidth: 4 }]}
      onPress={() => push('ParaStaffCredDetail', { id: cred.id })}
      accessibilityLabel={`${cred.title} - ${statusLabel(cred.expiry_status)}`}
    >
      <Row style={{ gap: 10 }}>
        <T style={[s.emoji]}>{cred.sport_emoji ?? '♿'}</T>
        <View style={{ flex: 1 }}>
          <T style={s.credTitle} numberOfLines={2}>{cred.title}</T>
          <T style={s.credMeta}>{cred.track_title}</T>
        </View>
        <Chip style={{ backgroundColor: statusBg }}>
          <T style={{ color: statusFg, fontSize: 11, fontWeight: '600' }}>{statusLabel(cred.expiry_status)}</T>
        </Chip>
      </Row>
      <Row style={{ marginTop: 6, gap: 8, flexWrap: 'wrap' }}>
        <Tag style={{ backgroundColor: c.violetSoft }}>{roleLabel(cred.role_category)}</Tag>
        {cred.level_key && <Tag style={{ backgroundColor: c.cyanSoft }}>{levelLabel(cred.level_key)}</Tag>}
        {cred.sport_name && <Tag style={{ backgroundColor: c.pinkSoft }}>{cred.sport_name}</Tag>}
      </Row>
      {cred.expires_on && (
        <T style={[s.credMeta, { marginTop: 4 }]}>
          {cred.days_to_expiry != null && cred.days_to_expiry > 0
            ? t('paraStaffCred.expiresIn', { n: cred.days_to_expiry })
            : cred.expired ? t('paraStaffCred.expiredAgo', { n: Math.abs(cred.days_to_expiry ?? 0) })
            : ''}
        </T>
      )}
      {cred.classification_candidate_only && (
        <T style={[s.classifierNote]}>{t('paraStaffCred.classifierNote')}</T>
      )}
    </TouchableOpacity>
  );
}

// ── Tab 1: My Credentials ────────────────────────────────────────────────────

function MyCredentials({ push, c, s }) {
  const [role, setRole] = useState(null);
  const [creds, loading] = useLoad(() => api.get('/me/para-staff-credentials', { role_category: role, limit: 50 }), [role]);
  if (loading) return <Empty loading />;
  if (!creds?.length) return (
    <View style={s.tabContent}>
      <Empty icon="ribbon" label={t('paraStaffCred.emptyMyCredentials')} action={t('paraStaffCred.browseTracks')} />
    </View>
  );
  return (
    <ScrollView style={s.tabContent} contentContainerStyle={{ paddingBottom: 32 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        <Row style={{ gap: 8, paddingHorizontal: 16 }}>
          <Chip selected={!role} onPress={() => setRole(null)} label="All" />
          {ROLE_OPTS.map((r) => (
            <Chip key={r} selected={role === r} onPress={() => setRole(role === r ? null : r)} label={roleLabel(r)} />
          ))}
        </Row>
      </ScrollView>
      {creds.map((cr) => <CredCard key={cr.id} cred={cr} push={push} c={c} s={s} />)}
    </ScrollView>
  );
}

// ── Tab 2: Renewal Due ───────────────────────────────────────────────────────

function RenewalDue({ push, c, s }) {
  const [creds, loading] = useLoad(() => api.get('/me/para-staff-credentials', { expiring_days: 90, limit: 50 }));
  if (loading) return <Empty loading />;
  if (!creds?.length) return <View style={s.tabContent}><Empty icon="checkmark-circle" label={t('paraStaffCred.emptyRenewal')} /></View>;

  const expiring = creds.filter((cr) => cr.expiry_status !== 'revoked');
  return (
    <ScrollView style={s.tabContent} contentContainerStyle={{ paddingBottom: 32 }}>
      {expiring.map((cr) => (
        <Card key={cr.id} style={s.card}>
          <Row style={{ gap: 10, alignItems: 'flex-start' }}>
            <T style={s.emoji}>{cr.sport_emoji ?? '♿'}</T>
            <View style={{ flex: 1 }}>
              <T style={s.credTitle}>{cr.title}</T>
              <T style={[s.credMeta, { color: cr.expiry_status === 'expired' ? c.red : c.sun }]}>
                {cr.days_to_expiry != null && cr.days_to_expiry > 0
                  ? t('paraStaffCred.expiresIn', { n: cr.days_to_expiry })
                  : t('paraStaffCred.expired')}
              </T>
            </View>
            <Btn
              small
              label={t('paraStaffCred.enrol')}
              onPress={() => push('ParaStaffTrackDetail', { id: cr.para_track_id })}
              accessibilityLabel={t('paraStaffCred.enrol')}
            />
          </Row>
          <Row style={{ marginTop: 8, gap: 8 }}>
            <Tag style={{ backgroundColor: c.violetSoft }}>{roleLabel(cr.role_category)}</Tag>
            {cr.renewal_months && <Tag style={{ backgroundColor: c.sunSoft }}>{t('paraStaffCred.renewalPeriod', { n: cr.renewal_months })}</Tag>}
          </Row>
        </Card>
      ))}
    </ScrollView>
  );
}

// ── Track card ───────────────────────────────────────────────────────────────

function TrackCard({ track, push, c, s }) {
  return (
    <TouchableOpacity
      style={s.card}
      onPress={() => push('ParaStaffTrackDetail', { id: track.id })}
      accessibilityLabel={`${track.title} - ${roleLabel(track.role_category)}`}
    >
      <Row style={{ gap: 10, alignItems: 'flex-start' }}>
        <T style={s.emoji}>{track.sport_emoji ?? '♿'}</T>
        <View style={{ flex: 1 }}>
          <T style={s.credTitle} numberOfLines={2}>{track.title}</T>
          <T style={s.credMeta}>{track.body_name ?? track.publisher_org_name ?? ''}</T>
        </View>
        {track.level_key && (
          <Chip style={{ backgroundColor: c.cyanSoft }}>
            <T style={{ color: c.cyan, fontSize: 11 }}>{levelLabel(track.level_key)}</T>
          </Chip>
        )}
      </Row>
      <Row style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
        <Tag style={{ backgroundColor: c.violetSoft }}>{roleLabel(track.role_category)}</Tag>
        {track.sport_name && <Tag style={{ backgroundColor: c.pinkSoft }}>{track.sport_name}</Tag>}
        {track.renewal_months && <Tag style={{ backgroundColor: c.sunSoft }}>{t('paraStaffCred.renewalPeriod', { n: track.renewal_months })}</Tag>}
        {track.role_category === 'classifier_candidate' && (
          <Tag style={{ backgroundColor: c.orangeSoft }}><T style={{ fontSize: 10, color: c.orange }}>Learning only</T></Tag>
        )}
      </Row>
      {track.prerequisites?.length > 0 && (
        <T style={[s.credMeta, { marginTop: 6 }]}>
          {t('paraStaffCred.prerequisiteLabel')}: {track.prerequisites.map((p) => p.label).join(', ')}
        </T>
      )}
    </TouchableOpacity>
  );
}

// ── Tab 3: Browse Tracks ─────────────────────────────────────────────────────

function BrowseTracks({ push, c, s }) {
  const [role, setRole] = useState(null);
  const [sport, setSport] = useState(null);
  const [sportQuery, setSportQuery] = useState('');
  const [tracks, loading] = useLoad(
    () => api.get('/para/staff/tracks', { role_category: role, sport: sport ?? undefined, limit: 50 }),
    [role, sport],
  );
  if (loading) return <Empty loading />;
  return (
    <ScrollView style={s.tabContent} contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
        <MenuField
          label={t('common.search')}
          placeholder="Sport…"
          value={sport}
          query={sportQuery}
          onQueryChange={setSportQuery}
          onSelect={setSport}
          fetch={(q) => api.get('/sports', { q, limit: 20 })}
          itemLabel={(s) => `${s.emoji ?? ''} ${s.name}`}
          itemValue={(s) => s.id}
          accessibilityLabel="Filter by sport"
          style={{ marginBottom: 8 }}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        <Row style={{ gap: 8, paddingHorizontal: 16 }}>
          <Chip selected={!role} onPress={() => setRole(null)} label="All roles" />
          {ROLE_OPTS.map((r) => (
            <Chip key={r} selected={role === r} onPress={() => setRole(role === r ? null : r)} label={roleLabel(r)} />
          ))}
        </Row>
      </ScrollView>
      {!tracks?.length
        ? <Empty icon="list" label={t('paraStaffCred.emptyBrowse')} />
        : tracks.map((tr) => <TrackCard key={tr.id} track={tr} push={push} c={c} s={s} />)}
    </ScrollView>
  );
}

// ── Root screen ──────────────────────────────────────────────────────────────

export function ParaStaffCred({ push }) {
  const { c, r } = useTheme();
  const { isTablet } = useLayout();
  const [tab, setTab] = useState('my');

  const s = makeStyles(c, r, isTablet);

  return (
    <View style={s.root}>
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { value: 'my',     label: t('paraStaffCred.myCredentials') },
          { value: 'renew',  label: t('paraStaffCred.renewalDue') },
          { value: 'browse', label: t('paraStaffCred.browseTracks') },
        ]}
        style={{ marginHorizontal: 16, marginBottom: 8 }}
      />
      {tab === 'my'     && <MyCredentials  push={push} c={c} s={s} />}
      {tab === 'renew'  && <RenewalDue     push={push} c={c} s={s} />}
      {tab === 'browse' && <BrowseTracks   push={push} c={c} s={s} />}
    </View>
  );
}

// ── Track detail screen ──────────────────────────────────────────────────────

export function ParaStaffTrackDetail({ id, push }) {
  const { c, r } = useTheme();
  const [track, loading] = useLoad(() => api.get(`/para/staff/tracks/${id}`));
  const s = makeStyles(c, r, false);

  if (loading) return <Empty loading />;
  if (!track) return <Empty icon="alert-circle" label={t('error.generic')} />;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Row style={{ gap: 10, marginBottom: 16, alignItems: 'flex-start' }}>
        <T style={{ fontSize: 36 }}>{track.sport_emoji ?? '♿'}</T>
        <View style={{ flex: 1 }}>
          <T style={{ fontSize: 18, fontWeight: '700', color: c.ink }}>{track.title}</T>
          {track.body_name ?? track.publisher_org_name
            ? <T style={{ fontSize: 13, color: c.mute, marginTop: 2 }}>{track.body_name ?? track.publisher_org_name}</T>
            : null}
        </View>
      </Row>

      {track.summary && <T style={{ fontSize: 14, color: c.ink, lineHeight: 22, marginBottom: 16 }}>{track.summary}</T>}

      <Row style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <Tag style={{ backgroundColor: c.violetSoft }}>{roleLabel(track.role_category)}</Tag>
        {track.level_key && <Tag style={{ backgroundColor: c.cyanSoft }}>{levelLabel(track.level_key)}</Tag>}
        {track.sport_name && <Tag style={{ backgroundColor: c.pinkSoft }}>{track.sport_name}</Tag>}
        {track.renewal_months && <Tag style={{ backgroundColor: c.sunSoft }}>{t('paraStaffCred.renewalPeriod', { n: track.renewal_months })}</Tag>}
        {track.scope_countries?.length === 0 && <Tag style={{ backgroundColor: c.limeSoft }}>{t('paraStaffCred.scope.global')}</Tag>}
      </Row>

      {track.role_category === 'classifier_candidate' && (
        <Card style={{ backgroundColor: c.orangeSoft, padding: 12, marginBottom: 16, borderRadius: r.card }}>
          <T style={{ color: c.orange, fontSize: 13 }}>{t('paraStaffCred.classifierNote')}</T>
        </Card>
      )}

      {track.prerequisites?.length > 0 && (
        <Section title={t('paraStaffCred.prerequisiteLabel')} style={{ marginBottom: 16 }}>
          {track.prerequisites.map((p) => (
            <Row key={p.id} style={{ gap: 8, marginBottom: 6 }}>
              <T style={{ color: c.pink }}>•</T>
              <T style={{ color: c.ink, fontSize: 14 }}>{p.label}</T>
            </Row>
          ))}
        </Section>
      )}

      <Btn
        label={t('paraStaffCred.enrol')}
        onPress={() => { /* deep link to enrolment flow */ }}
        style={{ marginTop: 8 }}
        accessibilityLabel={t('paraStaffCred.enrol')}
      />
    </ScrollView>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(c, r, isTablet) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    tabContent: { flex: 1 },
    card: {
      backgroundColor: c.paper,
      borderRadius: r.card,
      padding: 14,
      marginHorizontal: isTablet ? 24 : 16,
      marginBottom: 10,
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    },
    credTitle: { fontSize: 14, fontWeight: '700', color: c.ink, flex: 1 },
    credMeta: { fontSize: 12, color: c.mute, marginTop: 2 },
    emoji: { fontSize: 22 },
    classifierNote: {
      fontSize: 11, color: c.orange, marginTop: 6,
      backgroundColor: c.orangeSoft, padding: 6, borderRadius: 6,
    },
  });
}
