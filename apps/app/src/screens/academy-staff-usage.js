// Academy Staff Usage — academy owner/admin only.
// Shows staff linked to this organisation: last login, storage, AI token usage, API calls.
// Accessed from the academy workspace (staff tab → "Staff usage" action).
import React, { useState } from 'react';
import { ScrollView, TouchableOpacity, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { Card, Empty, ErrorBox, Loading, Row, Screen, Section, Seg, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';

const SORTS = [
  { value: 'last_login', label: t('asu.sort.last_login') },
  { value: 'storage', label: t('asu.sort.storage') },
  { value: 'ai_tokens', label: t('asu.sort.ai_tokens') },
  { value: 'api_calls', label: t('asu.sort.api_calls') },
  { value: 'name', label: t('asu.sort.name') },
];

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtTokens(n) {
  if (!n) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} K`;
  return `${(n / 1_000_000).toFixed(2)} M`;
}

function fmtNum(n) {
  if (!n) return '—';
  if (n < 10000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)} K`;
  return `${(n / 1_000_000).toFixed(1)} M`;
}

function relTime(ts) {
  if (!ts) return { rel: t('asu.never'), abs: '' };
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  let rel;
  if (mins < 2) rel = t('asu.just_now');
  else if (mins < 60) rel = t('asu.mins_ago', { n: mins });
  else if (hrs < 24) rel = t('asu.hrs_ago', { n: hrs });
  else if (days === 1) rel = t('asu.yesterday');
  else rel = t('asu.days_ago', { n: days });
  const abs = new Date(ts).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { rel, abs };
}

const ORG_ROLE_COLOR = {
  owner: { bg: c.pinkSoft, ink: c.pink },
  admin: { bg: c.cyanSoft, ink: c.cyan },
  coach: { bg: c.sunSoft, ink: c.sun },
  finance: { bg: c.mintSoft, ink: c.mint },
  staff: { bg: c.limeSoft, ink: c.lime },
};

function StatCell({ label, value, sub }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 10, padding: 8, marginHorizontal: 2 }}>
      <T style={{ fontSize: 9, color: c.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{label}</T>
      <T style={{ fontSize: 14, fontWeight: '800', color: c.ink }}>{value}</T>
      {!!sub && <T style={{ fontSize: 10, color: c.mute }}>{sub}</T>}
    </View>
  );
}

const STATE_COLOR = {
  active: c.lime, leave: c.sun, suspended: c.orange, ended: c.mute,
};

function StaffCard({ item, wide }) {
  const { rel, abs } = relTime(item.last_login_at);
  const roleCol = ORG_ROLE_COLOR[item.org_role] ?? { bg: c.line, ink: c.mute };
  const stateColor = STATE_COLOR[item.state] ?? c.mute;

  if (wide) {
    return (
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, marginBottom: 7 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: item.avatar_color || c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontSize: 20 }}>{item.avatar_emoji || '👤'}</T>
        </View>
        <View style={{ flex: 1.4, minWidth: 0 }}>
          <T style={{ fontSize: 15, fontWeight: '700', color: c.ink }}>{item.display_name}</T>
          <T style={{ fontSize: 12, color: c.mute }}>@{item.handle}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 5, gap: 4 }}>
            <View style={{ backgroundColor: roleCol.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
              <T style={{ fontSize: 10, fontWeight: '700', color: roleCol.ink }}>{item.org_role}</T>
            </View>
            {item.job_title && (
              <T style={{ fontSize: 11, color: c.mute, alignSelf: 'center' }}>{item.job_title}</T>
            )}
            {item.state && item.state !== 'active' && (
              <View style={{ backgroundColor: c.line, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                <T style={{ fontSize: 10, fontWeight: '600', color: stateColor }}>{item.state}</T>
              </View>
            )}
          </View>
        </View>
        <View style={{ flexDirection: 'row', flex: 1.6 }}>
          <StatCell label={t('asu.col.storage')} value={fmtBytes(item.storage_bytes)} sub={item.doc_count ? `${item.doc_count} docs` : null} />
          <StatCell label={t('asu.col.ai_tokens')} value={fmtTokens(item.ai_tokens_30d)} sub={t('asu.in_out')} />
          <StatCell label={t('asu.col.api_calls')} value={fmtNum(item.api_calls_30d)} />
        </View>
        <View style={{ alignItems: 'flex-end', minWidth: 90 }}>
          <T style={{ fontSize: 13, fontWeight: '600', color: c.ink }}>{rel}</T>
          <T style={{ fontSize: 10, color: c.mute, textAlign: 'right' }}>{abs}</T>
        </View>
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 8, padding: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: item.avatar_color || c.pinkSoft, alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
          <T style={{ fontSize: 18 }}>{item.avatar_emoji || '👤'}</T>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={{ fontSize: 15, fontWeight: '700', color: c.ink }}>{item.display_name}</T>
          <T style={{ fontSize: 12, color: c.mute }}>@{item.handle}{item.job_title ? ` · ${item.job_title}` : ''}</T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T style={{ fontSize: 12, fontWeight: '600', color: c.ink }}>{rel}</T>
          <T style={{ fontSize: 10, color: c.mute }}>{abs}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8, gap: 4 }}>
        <View style={{ backgroundColor: roleCol.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
          <T style={{ fontSize: 10, fontWeight: '700', color: roleCol.ink }}>{item.org_role}</T>
        </View>
        {item.state && item.state !== 'active' && (
          <View style={{ backgroundColor: c.line, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
            <T style={{ fontSize: 10, fontWeight: '600', color: stateColor }}>{item.state}</T>
          </View>
        )}
      </View>
      <View style={{ flexDirection: 'row' }}>
        <StatCell label={t('asu.col.storage')} value={fmtBytes(item.storage_bytes)} sub={item.doc_count ? `${item.doc_count} docs` : null} />
        <StatCell label={t('asu.col.ai_tokens')} value={fmtTokens(item.ai_tokens_30d)} sub={t('asu.in_out')} />
        <StatCell label={t('asu.col.api_calls')} value={fmtNum(item.api_calls_30d)} />
      </View>
    </Card>
  );
}

export function AcademyStaffUsage({ route }) {
  const orgId = route?.params?.id;
  const { isTablet } = useLayout();
  const [sort, setSort] = useState('last_login');
  const [order] = useState('desc');
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const { data, loading, error, reload } = useLoad(
    () => orgId ? api.get(`/organisations/${orgId}/academy/staff/usage`, { sort, order, limit: LIMIT, offset }) : null,
    [orgId, sort, order, offset],
  );

  if (!orgId) {
    return <Screen><Empty emoji="🏫" title={t('asu.no_org')} sub="" /></Screen>;
  }

  return (
    <Screen>
      {/* Header */}
      <View style={{ backgroundColor: c.paper, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: c.line }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          <T style={{ fontSize: 22, fontWeight: '800', color: c.ink }}>{t('asu.title')}</T>
          {data?.meta && (
            <View style={{ backgroundColor: c.cyanSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
              <T style={{ fontSize: 12, fontWeight: '700', color: c.cyan }}>{t('asu.total', { n: data.meta.total })}</T>
            </View>
          )}
        </View>
        <T style={{ fontSize: 13, color: c.mute }}>{t('asu.sub')}</T>
      </View>

      {/* Sort selector */}
      <View style={{ backgroundColor: c.paper, borderBottomWidth: 1, borderBottomColor: c.line }}>
        <Seg
          value={sort}
          onChange={(v) => { setSort(v); setOffset(0); }}
          options={SORTS}
          style={{ paddingHorizontal: 12, paddingVertical: 8 }}
        />
      </View>

      {/* List */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
        {loading && !data && <Loading />}
        {!!error && <ErrorBox error={error} onRetry={reload} />}
        {!!data && (
          <>
            <Section label={t('asu.section_label')} />
            {data.staff.map((item) => (
              <StaffCard key={item.id} item={item} wide={isTablet} />
            ))}
            {data.staff.length === 0 && <Empty emoji="👥" title={t('asu.empty_title')} sub={t('asu.empty_sub')} />}

            {/* Pagination */}
            {(offset > 0 || data.staff.length === LIMIT) && (
              <Row style={{ justifyContent: 'center', gap: 16, marginTop: 8 }}>
                {offset > 0 && (
                  <TouchableOpacity onPress={() => setOffset(Math.max(0, offset - LIMIT))}>
                    <T style={{ color: c.pink, fontWeight: '700' }}>{t('asu.prev')}</T>
                  </TouchableOpacity>
                )}
                {data.staff.length === LIMIT && (
                  <TouchableOpacity onPress={() => setOffset(offset + LIMIT)}>
                    <T style={{ color: c.pink, fontWeight: '700' }}>{t('asu.next')}</T>
                  </TouchableOpacity>
                )}
              </Row>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
