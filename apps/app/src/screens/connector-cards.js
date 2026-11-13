// Tools → Connectors: searchable catalogue of approved venue-booking (and other) connectors.
// Platform admins can register/enable providers; org admins can request access.
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Tag } from '../ui';
import { A, ABtn, ACard, AEmpty, AT, ATag } from '../arena';
import { c } from '../theme';
import { t } from '../i18n';

const REGION_OPTIONS = [
  { key: 'all', label: t('cc.region.all') },
  { key: 'SG', label: t('cc.region.sg') },
  { key: 'IN', label: t('cc.region.in') },
  { key: 'AU', label: t('cc.region.au') },
  { key: '', label: t('cc.region.global') },
];

const CAP_LABEL = {
  'redirect.out': t('cc.cap.redirect_out'),
  'venue.search': t('cc.cap.venue_search'),
  'venue.availability.read': t('cc.cap.avail_read'),
  'venue.price.quote': t('cc.cap.price_quote'),
  'venue.hold': t('cc.cap.hold'),
  'venue.book': t('cc.cap.book'),
  'venue.cancel': t('cc.cap.cancel'),
  'booking.status.read': t('cc.cap.status_read'),
  'booking.webhook': t('cc.cap.webhook'),
};

const ACCESS_TAG = {
  enabled:  { label: t('cc.access.enabled'),  tone: A.green },
  pending:  { label: t('cc.access.pending'),  tone: A.sun },
  none:     { label: t('cc.access.none'),      tone: A.mute },
  requested:{ label: t('cc.access.requested'),tone: A.cyan },
};

function ProviderCard({ p, orgId, isPlatformAdmin, onRequest }) {
  const acc = ACCESS_TAG[p.access] ?? ACCESS_TAG.none;
  const isLinkoutOnly = p.capabilities?.length === 1 && p.capabilities[0] === 'redirect.out';
  const countryFlag = p.country === 'SG' ? '🇸🇬' : p.country === 'IN' ? '🇮🇳' : p.country === 'AU' ? '🇦🇺' : '🌐';

  return (
    <ACard pad={16} style={{ gap: 12 }} accessibilityLabel={p.name}>
      {/* Header row */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: A.panel2, alignItems: 'center', justifyContent: 'center' }}>
          <AT size={28}>{countryFlag}</AT>
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <AT size={15} weight="800" numberOfLines={2}>{p.name}</AT>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <View style={{ backgroundColor: c.cyanSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
              <AT size={11} weight="700" color={c.cyan}>{t('cc.external_provider')}</AT>
            </View>
            {p.sandbox ? <View style={{ backgroundColor: A.sunSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}><AT size={11} weight="700" color={A.sun}>{t('cc.sandbox')}</AT></View> : null}
            {p.country ? <AT size={12} weight="600" color={A.mute}>{p.country}</AT> : null}
          </View>
        </View>
        <ATag tone={acc.tone} label={acc.label} />
      </View>

      {/* Capabilities */}
      {p.capabilities?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {p.capabilities.map((cap) => (
            <View key={cap} style={{ backgroundColor: A.panel2, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}>
              <AT size={11} weight="600">{CAP_LABEL[cap] ?? cap}</AT>
            </View>
          ))}
        </View>
      ) : null}

      {/* Disclaimer for redirect-only */}
      {isLinkoutOnly && p.disclaimer ? (
        <View style={{ backgroundColor: A.sunSoft, borderRadius: 10, padding: 10 }}>
          <AT size={12} weight="600" color={A.mute}>{t('cc.redirect_disclaimer')}</AT>
        </View>
      ) : null}

      {/* Capability note */}
      {p.capability_note ? (
        <AT size={12} color={A.mute}>{p.capability_note}</AT>
      ) : null}

      {/* Scopes */}
      {p.scopes?.length ? (
        <View style={{ gap: 4 }}>
          {p.scopes.map((s) => (
            <AT key={s.key} size={12} color={A.mute}>{s.description}</AT>
          ))}
        </View>
      ) : null}

      {/* CTA */}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {p.access === 'enabled' ? (
          <ABtn small title={t('cc.manage')} onPress={() => onRequest?.('manage', p)} />
        ) : p.access === 'pending' || p.access === 'requested' ? (
          <ABtn small tone="ghost" title={t('cc.access_pending')} onPress={() => onRequest?.('view', p)} />
        ) : isPlatformAdmin ? (
          <ABtn small title={t('cc.activate')} onPress={() => onRequest?.('activate', p)} />
        ) : (
          <ABtn small tone="ghost" title={t('cc.request_access')} onPress={() => onRequest?.('request', p)} />
        )}
        {isLinkoutOnly && p.access === 'enabled' ? (
          <ABtn small tone="ghost" title={t('cc.open_provider')} onPress={() => onRequest?.('open', p)} />
        ) : null}
      </View>
    </ACard>
  );
}

export function ConnectorCards({ orgId, isPlatformAdmin = false, toast }) {
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState('all');

  const params = useMemo(() => {
    const p = { category: 'venue_booking' };
    if (orgId) p.organisation_id = orgId;
    if (region && region !== 'all') p.country = region;
    return p;
  }, [orgId, region]);

  const catalogue = useLoad(() => api.get('/integrations/catalogue', params), [JSON.stringify(params)]);
  const providers = useMemo(() => {
    if (!catalogue.data?.providers) return [];
    const q = search.toLowerCase().trim();
    return catalogue.data.providers
      .filter((p) => p.category === 'venue_booking')
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.country ?? '').toLowerCase().includes(q));
  }, [catalogue.data, search]);

  const handleRequest = (action, p) => {
    // placeholder — full access request flow in integration hub
    toast?.(`${action}: ${p.name}`);
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Search */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>
        <Field
          value={search}
          onChangeText={setSearch}
          placeholder={t('cc.search_placeholder')}
          accessibilityLabel={t('cc.search_placeholder')}
          clearButton
        />
      </View>

      {/* Region filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8, flexDirection: 'row' }}>
        {REGION_OPTIONS.map((r) => (
          <Pressable
            key={r.key}
            onPress={() => setRegion(r.key)}
            accessibilityRole="button"
            accessibilityLabel={r.label}
            style={{ backgroundColor: region === r.key ? A.p2 : c.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 }}
          >
            <AT size={13} weight="700" color={region === r.key ? c.on : A.ink}>{r.label}</AT>
          </Pressable>
        ))}
      </ScrollView>

      {/* Content */}
      {catalogue.loading ? <Loading /> : !providers.length ? (
        <AEmpty emoji="🔌" title={t('cc.empty_title')} sub={search ? t('cc.empty_search') : t('cc.empty_sub')} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <AT size={13} weight="600" color={A.mute} style={{ marginBottom: 4 }}>{t('cc.subtitle')}</AT>
          {providers.map((p) => (
            <ProviderCard key={p.key} p={p} orgId={orgId} isPlatformAdmin={isPlatformAdmin} onRequest={handleRequest} />
          ))}
        </ScrollView>
      )}

      {/* Platform admin FAB: Register provider */}
      {isPlatformAdmin ? (
        <View style={{ position: 'absolute', bottom: 24, right: 20 }}>
          <ABtn title={t('cc.admin_register')} onPress={() => toast?.('Register new provider — coming soon')} />
        </View>
      ) : null}
    </View>
  );
}
