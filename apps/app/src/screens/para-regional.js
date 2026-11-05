// PS-29: India & APAC para-sport regional governance and local programmes discovery.
// Federation connection status (verified API / manual / pending MOU), event divisions,
// accreditation references, and partner-configurable funding opportunities with source verification.
// No official partnerships or state funding are invented: all claims are sourced and disclaimers are mandatory.
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Card, Chip, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { Kpi } from './academy-ui';
import { c } from '../theme';
import { t } from '../i18n';

const COUNTRIES = [
  { iso: null,  flag: '🌍', key: 'psr.all_regions' },
  { iso: 'IN',  flag: '🇮🇳', key: 'psr.india' },
  { iso: 'SG',  flag: '🇸🇬', key: 'psr.singapore' },
  { iso: 'MY',  flag: '🇲🇾', key: 'psr.malaysia' },
  { iso: 'AU',  flag: '🇦🇺', key: 'psr.australia' },
  { iso: 'JP',  flag: '🇯🇵', key: 'psr.japan' },
  { iso: 'LK',  flag: '🇱🇰', key: 'psr.sri_lanka' },
  { iso: 'BD',  flag: '🇧🇩', key: 'psr.bangladesh' },
];

const CONNECTION_TONE = {
  verified_api:  { bg: c.limeSoft,   fg: c.lime,   label: 'psr.verified_api' },
  manual_offline: { bg: c.sunSoft,   fg: c.sun,    label: 'psr.manual_offline' },
  pending_mou:   { bg: c.pinkSoft,   fg: c.pink,   label: 'psr.pending_mou' },
};

const VERIFY_TONE = {
  verified:   { bg: c.limeSoft,   fg: c.lime,   label: 'psr.verification_status_verified' },
  sourced:    { bg: c.cyanSoft,   fg: c.cyan,   label: 'psr.verification_status_sourced' },
  unverified: { bg: c.sunSoft,    fg: c.sun,    label: 'psr.verification_status_unverified' },
};

const day = (d) => (d ? String(d).slice(0, 10) : null);

function ConnectionBadge({ type }) {
  const tone = CONNECTION_TONE[type] ?? CONNECTION_TONE.manual_offline;
  return <Tag label={t(tone.label)} color={tone.bg} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t(tone.label)} />;
}

function VerifyBadge({ status }) {
  const tone = VERIFY_TONE[status] ?? VERIFY_TONE.unverified;
  return <Tag label={t(tone.label)} color={tone.bg} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t(tone.label)} />;
}

function GovernanceCard({ gov }) {
  const tone = CONNECTION_TONE[gov.federation_connection_type] ?? CONNECTION_TONE.manual_offline;
  return (
    <Card pad={14} style={{ gap: 8 }} accessibilityLabel={`${gov.sport_id} ${t(tone.label)}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800">{gov.sport_id}</T>
          <T size={12} color={c.mute}>{gov.governing_body}</T>
        </View>
        <ConnectionBadge type={gov.federation_connection_type} />
      </View>
      {gov.source_url ? <T size={12} color={c.cyan}>{gov.source_url}</T> : null}
      {day(gov.effective_from) ? <T size={12} color={c.mute}>{t('psr.effective')}: {day(gov.effective_from)}{day(gov.effective_to) ? ` → ${day(gov.effective_to)}` : ''}</T> : null}
      {gov.federation_connection_type !== 'verified_api' ? (
        <View style={{ backgroundColor: c.sunSoft, borderRadius: 10, padding: 10 }}>
          <T size={11} color={c.sun}>{t('psr.no_api_notice')}</T>
        </View>
      ) : null}
      <T size={11} color={c.mute}>{t('psr.not_official_partner')}</T>
    </Card>
  );
}

function ProgrammeCard({ prog }) {
  const hasGrant = prog.grant_min_minor != null || prog.grant_max_minor != null;
  const grantText = hasGrant
    ? `${prog.currency ?? ''} ${prog.grant_min_minor != null ? prog.grant_min_minor : ''}${prog.grant_max_minor != null ? ` – ${prog.grant_max_minor}` : ''}`.trim()
    : null;
  return (
    <Card pad={14} style={{ gap: 8 }} accessibilityLabel={`${prog.name} ${prog.issuing_body}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800">{prog.name}</T>
          <T size={12} color={c.mute}>{prog.issuing_body}</T>
        </View>
        <VerifyBadge status={prog.verification_status} />
      </View>
      {prog.eligibility_rules ? (
        <View style={{ gap: 2 }}>
          <T size={11} weight="800" color={c.mute}>{t('psr.eligibility').toUpperCase()}</T>
          <T size={13}>{prog.eligibility_rules}</T>
        </View>
      ) : null}
      {grantText ? (
        <View style={{ gap: 2 }}>
          <T size={11} weight="800" color={c.mute}>{t('psr.grant_range').toUpperCase()}</T>
          <T size={13}>{grantText}</T>
        </View>
      ) : null}
      {prog.source_url ? <T size={12} color={c.cyan}>{t('psr.source')}: {prog.source_url}</T> : null}
      {prog.disclaimer ? (
        <View style={{ backgroundColor: c.sunSoft, borderRadius: 10, padding: 10 }}>
          <T size={11} color={c.sun}>{prog.disclaimer}</T>
        </View>
      ) : (
        <T size={11} color={c.mute}>{t('psr.not_official_partner')}</T>
      )}
    </Card>
  );
}

export function ParaRegional() {
  const [country, setCountry] = useState(null);

  const gov = useLoad(
    () => api.get('/para/regional-governance', { ...(country ? { country_iso: country } : {}), limit: 100 }),
    [country]);
  const progs = useLoad(
    () => api.get('/para/local-programmes', { ...(country ? { country_iso: country } : {}), limit: 100 }),
    [country]);

  const govList = gov.data?.governance ?? [];
  const progList = progs.data?.programmes ?? [];

  const countryCount = new Set([...govList.map((g) => g.country_iso), ...progList.map((p) => p.country_iso)]).size;
  const verifiedApi = govList.filter((g) => g.federation_connection_type === 'verified_api').length;

  return (
    <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 32 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <Kpi label={t('ps.kpi_sports')} value={String(govList.length || '—')} sub={t('psr.federation_connections')} />
        <Kpi label={t('psr.verified_api')} value={String(verifiedApi || '—')} sub="Verified API" />
        <Kpi label={t('psr.local_programmes')} value={String(progList.length || '—')} sub="Programmes" />
        <Kpi label="Countries" value={String(countryCount || '—')} sub="Regions" />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -4 }} contentContainerStyle={{ flexDirection: 'row', gap: 8, paddingHorizontal: 4 }}>
        {COUNTRIES.map((ct) => (
          <Chip
            key={ct.iso ?? 'all'}
            label={`${ct.flag} ${t(ct.key)}`}
            active={country === ct.iso}
            onPress={() => setCountry(ct.iso)}
            accessibilityLabel={t(ct.key)}
          />
        ))}
      </ScrollView>

      <T size={13} weight="800" color={c.mute} accessibilityRole="header">{t('psr.federation_connections').toUpperCase()}</T>
      {gov.error ? <ErrorBox error={gov.error} onRetry={gov.reload} /> : !gov.data ? <Loading /> : govList.length
        ? govList.map((g) => <GovernanceCard key={g.id} gov={g} />)
        : <Empty emoji="🏛" title={t('psr.no_governance')} sub={t('psr.no_governance')} />}

      <T size={13} weight="800" color={c.mute} accessibilityRole="header" style={{ marginTop: 4 }}>{t('psr.local_programmes').toUpperCase()}</T>
      {progs.error ? <ErrorBox error={progs.error} onRetry={progs.reload} /> : !progs.data ? <Loading /> : progList.length
        ? progList.map((p) => <ProgrammeCard key={p.id} prog={p} />)
        : <Empty emoji="📋" title={t('psr.no_programmes')} sub={t('psr.no_programmes')} />}
    </ScrollView>
  );
}
