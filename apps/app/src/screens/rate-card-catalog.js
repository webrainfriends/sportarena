// Rate Card Service Catalog (#1015 R34). Standalone management screen for a referee's rate cards.
// Layers on top of official-profile-wizard.js — does not duplicate its logic.
// API: official-rate-card capability (GET /me/official-profile/rate-cards/catalog, etc.)
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, GradCard, H2, ListScreen, Loading, Screen, Section, T, Tag } from '../ui';
import { Banner, Metric, money } from '../federation-ui';
import { LoadError } from '../access';
import { c, grad } from '../theme';
import { t } from '../i18n';

const STATUS_COLOR = { active: c.mintSoft, draft: c.sunSoft, archived: c.violetSoft };
const STATUS_DOT = { active: '●', draft: '◐', archived: '○' };

function RateCardItem({ item: rc, onEdit, onDuplicate, onQuote, onActivate, onDeactivate, busy }) {
  const fmtPct = (v) => (Number(v) > 0 ? `+${v}%` : null);
  const satTag = fmtPct(rc.weekend_sat_pct);
  const sunTag = fmtPct(rc.weekend_sun_pct);
  const holTag = fmtPct(rc.holiday_pct);
  return (
    <Card style={{ gap: 10 }}>
      {/* Header row */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}>
          <T size={22} color="#fff">{rc.sport_emoji ?? '📋'}</T>
        </View>
        <View style={{ flex: 1 }}>
          <T weight="800" size={15}>{rc.name ?? (rc.sport_name ? `${rc.sport_name} · ${rc.role ?? ''}` : t('rc.title'))}</T>
          <T size={12} color={c.mute}>{[rc.sport_name, rc.role, rc.fixture_type].filter(Boolean).join(' · ')}</T>
        </View>
        <View style={{ gap: 4, alignItems: 'flex-end' }}>
          <Tag label={`${STATUS_DOT[rc.status] ?? '○'} ${t(`rc.badge_${rc.status}`)}`} color={STATUS_COLOR[rc.status] ?? c.violetSoft} />
          <Tag label={`v${rc.version_number ?? 1}`} color={c.pinkSoft} />
        </View>
      </View>

      {/* Valid dates */}
      {rc.valid_from ? (
        <T size={11} color={c.mute}>📅 {t('rc.valid_from')} {rc.valid_from}{rc.valid_until ? ` — ${rc.valid_until}` : ''}</T>
      ) : null}

      {/* Price block */}
      <View style={{ backgroundColor: c.violetSoft, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <T size={22} weight="800" color={c.pink}>{money(rc.fee_minor, rc.fee_currency)}</T>
          <T size={12} color={c.mute}>{rc.service_type ? `/${rc.service_type}` : '/match'}{rc.min_fee_minor > 0 ? ` · min ${money(rc.min_fee_minor, rc.fee_currency)}` : ''}</T>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 3 }}>
          {satTag ? <Tag label={`${t('rc.weekend_sat')} ${satTag}`} color={c.sunSoft} /> : null}
          {sunTag ? <Tag label={`${t('rc.weekend_sun')} ${sunTag}`} color={c.sunSoft} /> : null}
          {holTag ? <Tag label={`${t('rc.holiday')} ${holTag}`} color={c.sunSoft} /> : null}
          {rc.overtime_rate_minor > 0 ? <T size={11} color={c.mute}>{money(rc.overtime_rate_minor, rc.fee_currency)}/hr OT</T> : null}
        </View>
      </View>

      {/* Attribute tags */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {rc.is_indicative ? <Tag label={`🌍 ${t('rc.vis_indicative')}`} color={c.cyanSoft} /> : <Tag label={`🔐 ${t('rc.vis_negotiated')}`} color={c.violetSoft} />}
        {rc.includes_travel ? <Tag label={`✈️ ${t('rc.travel_included')}`} color={c.cyanSoft} /> : (rc.travel_allowance_per_km_minor > 0 ? <Tag label={`🚗 ${money(rc.travel_allowance_per_km_minor, rc.fee_currency)}/km`} color={c.cyanSoft} /> : null)}
        {rc.tax_inclusive ? <Tag label={`✓ ${t('rc.tax_inclusive')}`} color={c.mintSoft} /> : null}
        {rc.deposit_type !== 'none' ? <Tag label={`🔒 ${rc.deposit_type === 'pct' ? `${rc.deposit_pct}% ${t('rc.deposit_label')}` : `${money(rc.deposit_minor, rc.fee_currency)} ${t('rc.deposit_label')}`}`} color={c.sunSoft} /> : null}
      </View>

      {/* Actions */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn small title={t('rc.edit')} color={c.paper} ink={c.ink} onPress={() => onEdit(rc)} />
        <Btn small title={t('rc.duplicate')} color={c.paper} ink={c.ink} onPress={() => onDuplicate(rc)} />
        <Btn small title={`📊 ${t('rc.quote')}`} color={c.cyan} onPress={() => onQuote(rc)} />
        {rc.status === 'draft' ? (
          <Btn small title={t('rc.activate')} color={c.lime} onPress={() => onActivate(rc)} loading={busy === rc.id} />
        ) : rc.status === 'active' ? (
          <Btn small title={t('rc.deactivate')} color={c.paper} ink={c.mute} onPress={() => onDeactivate(rc)} loading={busy === rc.id} />
        ) : null}
      </View>
    </Card>
  );
}

export function RateCardCatalog() {
  const { push: go } = useNav();
  const { toast } = useSession();
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(null);
  const q = useLoad(() => api.get('/me/official-profile/rate-cards/catalog'), []);

  if (q.error && !q.data) return <Screen><H2>{t('rc.title')}</H2><LoadError error={q.error} onRetry={q.reload} /></Screen>;
  if (!q.data) return <Screen><Loading /></Screen>;

  const cards = Array.isArray(q.data) ? q.data : [];
  const active = cards.filter((r) => r.status === 'active');
  const draft = cards.filter((r) => r.status === 'draft');
  const archived = cards.filter((r) => r.status === 'archived');
  const avgFee = active.length ? Math.round(active.reduce((s, r) => s + Number(r.fee_minor), 0) / active.length) : 0;
  const avgCur = active[0]?.fee_currency ?? 'GBP';

  const filtered = filter === 'all' ? cards.filter((r) => r.status !== 'archived')
    : filter === 'archived' ? archived
    : cards.filter((r) => r.status === filter);

  const doActivate = async (rc) => {
    setBusy(rc.id);
    try {
      await api.post(`/me/official-profile/rate-cards/${rc.id}/activate`);
      toast(t('rc.activate'));
      q.reload();
    } catch (e) { toast(e.message); }
    finally { setBusy(null); }
  };
  const doDeactivate = async (rc) => {
    setBusy(rc.id);
    try {
      await api.post(`/me/official-profile/rate-cards/${rc.id}/deactivate`);
      toast(t('rc.deactivate'));
      q.reload();
    } catch (e) { toast(e.message); }
    finally { setBusy(null); }
  };
  const doDuplicate = async (rc) => {
    try {
      await api.post(`/me/official-profile/rate-cards/${rc.id}/duplicate`);
      toast(t('rc.duplicate'));
      q.reload();
    } catch (e) { toast(e.message); }
  };

  const header = (
    <View>
      <GradCard colors={grad.hero}>
        <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6 }}>{t('rc.catalog_sub').toUpperCase()}</T>
        <T size={26} weight="800" color="#fff" style={{ letterSpacing: -0.8, marginTop: 4 }}>{t('rc.title')}</T>
        <T size={13} color="rgba(255,255,255,0.8)" style={{ marginTop: 4 }}>{t('rc.catalog_count', { n: cards.length })}</T>
      </GradCard>

      {/* Onboarding banner */}
      {!active.length ? (
        <Banner tone={c.sunSoft} action={t('rc.onboard_cta')} onAction={() => go('RateCardWizard', {})}>
          {t('rc.onboard_title')} — {t('rc.onboard_sub')}
        </Banner>
      ) : null}

      {/* Stats strip */}
      <View style={{ flexDirection: 'row', backgroundColor: c.paper, borderRadius: 14, margin: 12, overflow: 'hidden' }}>
        <Metric value={active.length} label={t('rc.stats_active')} tone={active.length ? c.mintSoft : undefined} />
        <Metric value={draft.length} label={t('rc.stats_draft')} tone={draft.length ? c.sunSoft : undefined} />
        <Metric value={active.length ? money(avgFee, avgCur) : '—'} label={t('rc.stats_avg')} />
        <Metric value={archived.length} label={t('rc.stats_archived')} />
      </View>

      {/* Filter chips */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingBottom: 8 }}>
        {['all','active','draft','archived'].map((s) => (
          <Chip key={s} label={t(s === 'all' ? 'rc.filter_all' : `rc.badge_${s}`)} active={filter === s} onPress={() => setFilter(s)} />
        ))}
      </View>
    </View>
  );

  return (
    <ListScreen
      header={header}
      data={filtered}
      keyExtractor={(r) => r.id}
      renderItem={({ item }) => (
        <RateCardItem
          item={item}
          onEdit={(rc) => go('RateCardWizard', { id: rc.id })}
          onDuplicate={doDuplicate}
          onQuote={(rc) => go('QuoteCalculator', { rateCardId: rc.id, profileId: rc.profile_id })}
          onActivate={doActivate}
          onDeactivate={doDeactivate}
          busy={busy}
        />
      )}
      empty={<Empty emoji="📋" title={t('rc.title')} sub={t('rc.onboard_sub')} />}
      onRefresh={q.reload}
      refreshing={q.loading}
      footer={
        <Btn
          title={`+ ${t('rc.new')}`}
          color={c.pink}
          onPress={() => go('RateCardWizard', {})}
          style={{ margin: 16 }}
          accessibilityLabel={t('rc.new')}
        />
      }
    />
  );
}
