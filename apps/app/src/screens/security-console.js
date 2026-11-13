// Security console (#1129): platform-admin-only screen for multi-role tenant isolation monitoring.
// Tabs: Access Denied Events | Permission Matrix | Revocations
// Extends the existing PlatformSecurity screen (encryption keys, audit chain) — does not replace it.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { Card, Chip, Empty, ErrorBox, Loading, Screen, Section, Seg, T, Tag } from '../ui';
import { t } from '../i18n';
import { c, r } from '../theme';

const TABS = [
  { key: 'events',  label: () => t('sec.access_denied') },
  { key: 'matrix',  label: () => t('sec.permission_matrix') },
  { key: 'revoke',  label: () => t('sec.revocations') },
];

const SEV_COLOR = { critical: c.red, high: c.orange, medium: c.sun, low: c.lime };
const SEV_LABEL = { critical: 'sec.severity_critical', high: 'sec.severity_high', medium: 'sec.severity_medium', low: 'sec.severity_low' };
const PERM_ICON = { allow: '✓', deny: '✗', conditional: '⚠', na: '—' };
const PERM_COLOR = { allow: c.lime, deny: c.red, conditional: c.sun, na: c.line };

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const ago = (iso) => {
  if (!iso) return '—';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

// ─── Stat tile ────────────────────────────────────────────────────────────────
function StatTile({ value, label, color = c.ink, sub }) {
  return (
    <View style={{ flex: 1, minWidth: 100, backgroundColor: c.paper, borderRadius: r.card, padding: 14, alignItems: 'flex-start', gap: 2 }}>
      <T weight="800" size={28} color={color}>{value ?? '—'}</T>
      <T weight="600" size={11} color={c.mute} style={{ letterSpacing: 0.3 }}>{label}</T>
      {sub ? <T size={11} color={color} weight="600" style={{ marginTop: 3 }}>{sub}</T> : null}
    </View>
  );
}

// ─── Access Denied Events tab ─────────────────────────────────────────────────
function EventsTab() {
  const state = useLoad(() => api.get('/security/access-denied-events', { limit: 50, since_hours: 24 }));
  const L = useLayout();

  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  const { rows = [], stats = {} } = state.data ?? {};

  return (
    <View style={{ gap: 12 }}>
      {/* Stat strip */}
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <StatTile value={stats.idor_attempts}        label={t('sec.idor_attempts')}        color={stats.idor_attempts > 0 ? c.red : c.lime} />
        <StatTile value={stats.total_denied}         label={t('sec.events_24h')}           color={c.orange} />
        <StatTile value={stats.role_boundary_blocks} label={t('sec.role_boundary_blocks')} color={c.violet} />
      </View>

      {/* Event list */}
      {rows.length === 0 ? (
        <Empty title={t('sec.access_denied')} sub="No access-denied events in the last 24 hours." emoji="🛡️" />
      ) : rows.map((ev) => (
        <Card key={ev.id} pad={12}>
          <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 8, alignItems: L.tablet ? 'center' : 'flex-start' }}>
            {/* Severity dot + time */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: L.tablet ? 90 : undefined }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: SEV_COLOR[ev.severity] ?? c.mute }} />
              <T size={12} weight="600" color={SEV_COLOR[ev.severity] ?? c.mute}>{t(SEV_LABEL[ev.severity] ?? 'sec.severity_medium')}</T>
            </View>
            <T size={11} color={c.mute} style={{ minWidth: 60 }}>{ago(ev.at)}</T>
            {/* Actor */}
            <View style={{ flex: 1, minWidth: 0 }}>
              <T weight="600" size={13} numberOfLines={1}>{ev.actor_handle ?? ev.actor_id ?? '(anonymous)'}</T>
              <T size={12} color={c.mute} numberOfLines={1}>{ev.capability ?? ''} · {ev.path ?? ''}</T>
            </View>
            {/* Block reason */}
            <View style={{ maxWidth: L.tablet ? 220 : undefined }}>
              <Tag label={ev.block_reason ?? 'denied'} color={c.redSoft} />
              {ev.mcp_call ? <Tag label="MCP" color={c.cyanSoft} style={{ marginTop: 4 }} /> : null}
            </View>
            {/* Status */}
            <Tag label={t('sec.blocked')} color={c.limeSoft} />
          </View>
        </Card>
      ))}
    </View>
  );
}

// ─── Permission Matrix tab ────────────────────────────────────────────────────
function MatrixTab() {
  const state = useLoad(() => api.get('/security/permission-matrix'));

  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  const { roles = [], domains = [] } = state.data ?? {};

  return (
    <View style={{ gap: 12 }}>
      <T size={13} color={c.mute}>Every sensitive domain × role. ✓ permitted · ✗ denied (server-enforced) · ⚠ conditional · — not applicable.</T>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          {/* Header row */}
          <View style={{ flexDirection: 'row', backgroundColor: c.bg, borderRadius: r.card, marginBottom: 2 }}>
            <View style={{ width: 170, padding: 10 }}>
              <T weight="700" size={11} color={c.mute} style={{ letterSpacing: 0.6 }}>DOMAIN</T>
            </View>
            {roles.map((roleKey) => (
              <View key={roleKey} style={{ width: 80, padding: 10, alignItems: 'center' }}>
                <T weight="700" size={10} color={c.mute} style={{ letterSpacing: 0.5, textAlign: 'center' }}>{roleKey.replace(/_/g, '\n').toUpperCase()}</T>
              </View>
            ))}
          </View>

          {domains.map((domain) => (
            <View key={domain.key} style={{ flexDirection: 'row', backgroundColor: c.paper, borderBottomWidth: 1, borderColor: c.line }}>
              <View style={{ width: 170, padding: 10, justifyContent: 'center' }}>
                <T weight="600" size={12}>{domain.label}</T>
                <T size={10} color={c.mute} style={{ marginTop: 2 }}>{domain.owner}</T>
              </View>
              {roles.map((roleKey) => {
                const verdict = domain.verdicts?.[roleKey] ?? 'na';
                const icon = PERM_ICON[verdict] ?? '—';
                const color = PERM_COLOR[verdict] ?? c.mute;
                return (
                  <View key={roleKey} style={{ width: 80, padding: 10, alignItems: 'center', justifyContent: 'center' }}>
                    <T weight="800" size={16} color={color}>{icon}</T>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      {/* Legend */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
        {Object.entries(PERM_ICON).map(([k, icon]) => (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <T weight="800" size={14} color={PERM_COLOR[k]}>{icon}</T>
            <T size={11} color={c.mute}>{k}</T>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── Revocations tab ──────────────────────────────────────────────────────────
function RevocationsTab() {
  const state = useLoad(() => api.get('/security/revocation-log', { limit: 50 }));

  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  const { rows = [] } = state.data ?? {};

  return (
    <View style={{ gap: 10 }}>
      {rows.length === 0 ? (
        <Empty title={t('sec.revocations')} sub="No revocation events yet." emoji="✅" />
      ) : rows.map((row) => (
        <Card key={row.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <T size={20}>🚫</T>
            <View style={{ flex: 1 }}>
              <T weight="600" size={13}>{row.user_name ?? row.user_id}</T>
              <T size={12} color={c.mute}>{row.org_name ?? '—'} · {ago(row.at)}</T>
              <T size={12} color={c.mute} style={{ marginTop: 4 }}>Reason: {row.reason}</T>
              {row.notifications_cancelled > 0 ? (
                <T size={11} color={c.orange} style={{ marginTop: 2 }}>{row.notifications_cancelled} notifications cancelled</T>
              ) : null}
            </View>
            <Tag label={row.reason} color={c.redSoft} />
          </View>
        </Card>
      ))}
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export function SecurityConsole() {
  const { hasAny } = useSession();
  const [tab, setTab] = useState('events');

  if (!hasAny('platform_admin', 'admin')) return null;

  const TAB_OPTIONS = TABS.map((tb) => ({ label: tb.label(), value: tb.key }));

  return (
    <Screen>
      <View style={{ gap: 16, padding: 16 }}>
        <T weight="800" size={22}>{t('sec.console.title')}</T>
        <Seg options={TAB_OPTIONS} value={tab} onChange={setTab} />
        {tab === 'events'  && <EventsTab />}
        {tab === 'matrix'  && <MatrixTab />}
        {tab === 'revoke'  && <RevocationsTab />}
      </View>
    </Screen>
  );
}

export default SecurityConsole;
