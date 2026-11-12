// Platform Users console — platform admin only.
// Shows all accounts: login ID (handle + email), roles, storage, AI token usage, API calls, last login.
// Entry: More → Workspaces → "Platform users" (platform_admin role only).
import React, { useState } from 'react';
import { ScrollView, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Card, Empty, ErrorBox, Loading, Row, Screen, Section, Seg, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';

const SORTS = [
  { value: 'last_login', label: t('pu.sort.last_login') },
  { value: 'storage', label: t('pu.sort.storage') },
  { value: 'ai_tokens', label: t('pu.sort.ai_tokens') },
  { value: 'api_calls', label: t('pu.sort.api_calls') },
  { value: 'created', label: t('pu.sort.created') },
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
  if (!ts) return { rel: t('pu.never'), abs: '' };
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  let rel;
  if (mins < 2) rel = t('pu.just_now');
  else if (mins < 60) rel = t('pu.mins_ago', { n: mins });
  else if (hrs < 24) rel = t('pu.hrs_ago', { n: hrs });
  else if (days === 1) rel = t('pu.yesterday');
  else rel = t('pu.days_ago', { n: days });
  const abs = new Date(ts).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { rel, abs };
}

const ROLE_COLOR = {
  platform_admin: { bg: c.pinkSoft, ink: c.pink },
  admin: { bg: c.cyanSoft, ink: c.cyan },
  athlete: { bg: c.limeSoft, ink: c.lime },
  coach: { bg: c.sunSoft, ink: c.sun },
  organizer: { bg: c.orangeSoft, ink: c.orange },
  venue_manager: { bg: c.mintSoft, ink: c.mint },
  physio: { bg: c.cyanSoft, ink: c.cyan },
  doctor: { bg: c.cyanSoft, ink: c.cyan },
};
function roleColor(r) { return ROLE_COLOR[r] ?? { bg: c.line, ink: c.mute }; }

function MetricTile({ label, value, delta }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 14, padding: 10 }}>
      <T style={{ fontSize: 10, color: c.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</T>
      <T style={{ fontSize: 18, fontWeight: '800', color: c.ink, lineHeight: 22 }}>{value}</T>
      {!!delta && <T style={{ fontSize: 10, color: c.lime, marginTop: 2 }}>{delta}</T>}
    </View>
  );
}

function RoleChip({ role }) {
  const col = roleColor(role);
  return (
    <View style={{ backgroundColor: col.bg, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, marginRight: 4, marginBottom: 3 }}>
      <T style={{ fontSize: 10, fontWeight: '700', color: col.ink }}>{role}</T>
    </View>
  );
}

function StatCell({ label, value, sub }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 10, padding: 8, marginHorizontal: 2 }}>
      <T style={{ fontSize: 9, color: c.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{label}</T>
      <T style={{ fontSize: 14, fontWeight: '800', color: c.ink }}>{value}</T>
      {!!sub && <T style={{ fontSize: 10, color: c.mute }}>{sub}</T>}
    </View>
  );
}

function UserCard({ item, wide }) {
  const { rel, abs } = relTime(item.last_login_at);
  const topRoles = (item.roles ?? []).slice(0, 3);

  if (wide) {
    return (
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, marginBottom: 7 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: item.avatar_color || c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontSize: 20 }}>{item.avatar_emoji || '👤'}</T>
        </View>
        <View style={{ flex: 1.3, minWidth: 0 }}>
          <T style={{ fontSize: 15, fontWeight: '700', color: c.ink }}>@{item.handle}</T>
          <T style={{ fontSize: 12, color: c.mute }} numberOfLines={1}>{item.email ?? '—'}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 5 }}>
            {topRoles.map((r) => <RoleChip key={r} role={r} />)}
          </View>
        </View>
        <View style={{ flexDirection: 'row', flex: 1.6 }}>
          <StatCell label={t('pu.col.storage')} value={fmtBytes(item.storage_bytes)} sub={item.doc_count ? `${item.doc_count} docs` : null} />
          <StatCell label={t('pu.col.ai_tokens')} value={fmtTokens(item.ai_tokens_30d)} sub={t('pu.in_out')} />
          <StatCell label={t('pu.col.api_calls')} value={fmtNum(item.api_calls_30d)} />
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
          <T style={{ fontSize: 15, fontWeight: '700', color: c.ink }}>@{item.handle}</T>
          <T style={{ fontSize: 12, color: c.mute }} numberOfLines={1}>{item.email ?? '—'}</T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T style={{ fontSize: 12, fontWeight: '600', color: c.ink }}>{rel}</T>
          <T style={{ fontSize: 10, color: c.mute }}>{abs}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
        {topRoles.map((r) => <RoleChip key={r} role={r} />)}
      </View>
      <View style={{ flexDirection: 'row' }}>
        <StatCell label={t('pu.col.storage')} value={fmtBytes(item.storage_bytes)} sub={item.doc_count ? `${item.doc_count} docs` : null} />
        <StatCell label={t('pu.col.ai_tokens')} value={fmtTokens(item.ai_tokens_30d)} sub={t('pu.in_out')} />
        <StatCell label={t('pu.col.api_calls')} value={fmtNum(item.api_calls_30d)} />
      </View>
    </Card>
  );
}

export function PlatformUsers() {
  const { user } = useSession();
  const { isTablet } = useLayout();
  const ins = useSafeAreaInsets();
  const [sort, setSort] = useState('last_login');
  const [order] = useState('desc');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const { data, loading, error, reload } = useLoad(
    () => api.get('/admin/users', { sort, order, search: search || undefined, limit: LIMIT, offset }),
    [sort, order, search, offset],
  );

  if (!user?.roles?.includes('platform_admin')) {
    return (
      <Screen>
        <Empty emoji="🔒" title={t('pu.locked_title')} sub={t('pu.locked_sub')} />
      </Screen>
    );
  }

  const meta = data?.meta;

  return (
    <Screen scroll={false}>
      {/* Header */}
      <View style={{ backgroundColor: c.paper, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: c.line }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          <T style={{ fontSize: 22, fontWeight: '800', color: c.ink }}>{t('pu.title')}</T>
          {!!meta && (
            <View style={{ backgroundColor: c.pinkSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
              <T style={{ fontSize: 12, fontWeight: '700', color: c.pink }}>{t('pu.total', { n: meta.total_users })}</T>
            </View>
          )}
        </View>
        <T style={{ fontSize: 13, color: c.mute }}>{t('pu.sub')}</T>
      </View>

      {/* Metric strip */}
      {!!meta && (
        <View style={{ backgroundColor: c.paper, flexDirection: 'row', gap: 8, padding: 12, borderBottomWidth: 1, borderBottomColor: c.line }}>
          <MetricTile label={t('pu.metric.users')} value={(meta.total_users ?? 0).toLocaleString()} delta={meta.new_7d ? t('pu.metric.new_7d', { n: meta.new_7d }) : null} />
          <MetricTile label={t('pu.metric.ai_tokens')} value={fmtTokens(meta.total_ai_tokens_30d)} delta={t('pu.last_30d')} />
          <MetricTile label={t('pu.metric.api_calls')} value={fmtNum(meta.total_api_calls_30d)} delta={t('pu.last_30d')} />
          <MetricTile label={t('pu.metric.active')} value={(meta.active_7d ?? 0).toLocaleString()} delta={t('pu.last_7d')} />
        </View>
      )}

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
            <Section label={t('pu.section_label', { sort: SORTS.find((s) => s.value === sort)?.label ?? '' })} />
            {data.users.map((item) => (
              <UserCard key={item.id} item={item} wide={isTablet} />
            ))}
            {data.users.length === 0 && <Empty emoji="👥" title={t('pu.empty_title')} sub={t('pu.empty_sub')} />}
          </>
        )}
      </ScrollView>

      {/* Sticky pagination footer — always visible */}
      {!!data && (() => {
        const total = data.meta?.total ?? (offset + data.users.length);
        const from = total === 0 ? 0 : offset + 1;
        const to = offset + data.users.length;
        const hasNext = to < total;
        const hasPrev = offset > 0;
        if (!hasPrev && !hasNext) return null;
        return (
          <View style={{ backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10, paddingBottom: 10 + ins.bottom, paddingHorizontal: 16 }}>
            <T style={{ textAlign: 'center', fontSize: 12, color: c.mute, marginBottom: 8 }}>
              {t('pu.showing', { from, to, total })}
            </T>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 24 }}>
              <TouchableOpacity
                onPress={() => setOffset(Math.max(0, offset - LIMIT))}
                disabled={!hasPrev}
                style={{ paddingVertical: 8, paddingHorizontal: 20, borderRadius: 8, backgroundColor: hasPrev ? c.pinkSoft : c.wash }}
              >
                <T style={{ color: hasPrev ? c.pink : c.mute, fontWeight: '700' }}>{t('pu.prev')}</T>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setOffset(offset + LIMIT)}
                disabled={!hasNext}
                style={{ paddingVertical: 8, paddingHorizontal: 20, borderRadius: 8, backgroundColor: hasNext ? c.pinkSoft : c.wash }}
              >
                <T style={{ color: hasNext ? c.pink : c.mute, fontWeight: '700' }}>{t('pu.next')}</T>
              </TouchableOpacity>
            </View>
          </View>
        );
      })()}
    </Screen>
  );
}
