// Official Payout Account — onboarding, management and admin console (#1018).
// 9 states: not_configured → wizard (4 steps) → pending → verified → failed → held.
// Responsive: phone, tablet (≥768px), desktop (≥1180px).
// All text via t(); RTL-aware; Dusk theme tokens only; API-first.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, I18nManager, StyleSheet } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, H2, Loading, Row, Screen, Section, Seg, Sheet, StatPill, T, Tag, Wrap } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, grad, r } from '../theme';
import { Banner, Metric, money } from '../federation-ui';
import { t } from '../i18n';

const RTL = I18nManager.isRTL;

// ---- constants ---------------------------------------------------------------
const PAYEE_TYPES = [
  { value: 'individual', labelKey: 'opa.payee_individual' },
  { value: 'business',   labelKey: 'opa.payee_business' },
];
const SCHEDULES = [
  { value: 'weekly',      labelKey: 'opa.schedule_weekly' },
  { value: 'fortnightly', labelKey: 'opa.schedule_fortnightly' },
  { value: 'monthly',     labelKey: 'opa.schedule_monthly' },
  { value: 'on_demand',   labelKey: 'opa.schedule_on_demand' },
];
const METHODS = [
  { value: 'bank_transfer',  labelKey: 'opa.method_bank',    icon: '🏦' },
  { value: 'stripe_connect', labelKey: 'opa.method_stripe',  icon: '⚡' },
  { value: 'digital_wallet', labelKey: 'opa.method_wallet',  icon: '📱' },
];
const STATUS_STYLE = {
  pending:    { label: 'opa.status_pending',    color: () => c.sunSoft  },
  verified:   { label: 'opa.status_verified',   color: () => c.limeSoft },
  rejected:   { label: 'opa.status_rejected',   color: () => c.redSoft  },
  superseded: { label: 'opa.status_superseded', color: () => c.paper    },
};

// ---- tiny helpers ------------------------------------------------------------
const statusTag = (s) => <Tag label={t(STATUS_STYLE[s]?.label ?? s)} color={(STATUS_STYLE[s]?.color ?? (() => c.paper))()} />;
const pad = (val = 16) => ({ padding: val });
const row  = (gap = 8) => ({ flexDirection: RTL ? 'row-reverse' : 'row', gap, alignItems: 'center' });
const col  = (gap = 8) => ({ flexDirection: 'column', gap });
const kpi  = (val, lbl) => <StatPill value={val} label={lbl} color={c.paper} />;

// ---- KPI strip ---------------------------------------------------------------
function KpiStrip({ history, pending }) {
  const paid   = (history ?? []).filter(h => h.status === 'paid').reduce((s, h) => s + Number(h.net_minor ?? 0), 0);
  const inFlight = (history ?? []).filter(h => h.status === 'pending').reduce((s, h) => s + Number(h.net_minor ?? 0), 0);
  const currency = history?.[0]?.currency ?? '—';
  return (
    <View style={[row(8), { flexWrap: 'wrap' }]}>
      {kpi(money(paid,     currency), t('opa.kpi_lifetime'))}
      {kpi(money(inFlight, currency), t('opa.kpi_in_flight'))}
      {kpi(String(pending ?? 0),      t('opa.kpi_open_failures'))}
    </View>
  );
}

// ---- fee disclosure card -----------------------------------------------------
function FeeDisclosure({ disclosure }) {
  if (!disclosure) return null;
  const { platform_fee_bp, platform_fee_flat, withholding_bp, currency, payor } = disclosure;
  return (
    <Card color={c.cyanSoft} accessibilityLabel={t('opa.fee_disclosure_aria')}>
      <T weight="700" size={13}>{t('opa.fee_disclosure_title')}</T>
      <View style={col(4)}>
        <T size={12}>{t('opa.fee_payor')}: {payor}</T>
        <T size={12}>{t('opa.fee_platform')}: {(platform_fee_bp / 100).toFixed(2)}%{platform_fee_flat ? ` + ${money(platform_fee_flat, currency)}` : ''}</T>
        {withholding_bp > 0 && <T size={12}>{t('opa.fee_withholding')}: {(withholding_bp / 100).toFixed(2)}%</T>}
        <T size={11} color={c.mute}>{t('opa.fee_note')}</T>
      </View>
    </Card>
  );
}

// ---- payout history row ------------------------------------------------------
function HistoryRow({ item }) {
  const statusColors = { paid: c.limeSoft, pending: c.sunSoft, failed: c.redSoft };
  return (
    <Row
      title={`${item.event_name ?? t('opa.history_event_unknown')} · ${item.official_role ?? '—'}`}
      sub={item.decided_at ? new Date(item.decided_at).toLocaleDateString() : '—'}
      right={<View style={[row(6)]}>
        <T size={13} weight="700">{money(Number(item.net_minor ?? 0), item.currency)}</T>
        <Tag label={t(STATUS_STYLE[item.status]?.label ?? item.status)} color={(statusColors[item.status] ?? c.paper)} />
      </View>}
      accessibilityLabel={`${item.event_name}, ${money(Number(item.net_minor ?? 0), item.currency)}, ${item.status}`}
    />
  );
}

// ---- failure card ------------------------------------------------------------
function FailureCard({ failure, onResolve }) {
  return (
    <Card color={c.redSoft} accessibilityLabel={t('opa.failure_card_aria')}>
      <T weight="700" color={c.red}>{t('opa.failure_title')}: {failure.failure_code}</T>
      {failure.failure_message ? <T size={13}>{failure.failure_message}</T> : null}
      {failure.amount_cents ? <T size={13}>{money(Number(failure.amount_cents), failure.currency)}</T> : null}
      <T size={12} color={c.mute}>{new Date(failure.attempted_at).toLocaleDateString()}</T>
      {!failure.resolved_at && (
        <Btn small title={t('opa.failure_resolve')} color={c.orange} onPress={() => onResolve(failure.id)} accessibilityLabel={t('opa.failure_resolve_aria')} />
      )}
    </Card>
  );
}

// ---- hold banner -------------------------------------------------------------
function HoldBanner({ account }) {
  if (!account?.held_at || account?.released_at) return null;
  return (
    <Banner tone={c.sunSoft}>
      <T weight="700" color={c.orange}>{t('opa.hold_title')}</T>
      <T size={13}>{account.hold_reason}</T>
      <T size={12} color={c.mute}>{t('opa.hold_contact')}</T>
    </Banner>
  );
}

// ---- setup wizard -----------------------------------------------------------
function SetupWizard({ officialId, currency, onDone, disclosure }) {
  const [step, setStep]       = useState(1);
  const [saving, setSaving]   = useState(false);
  const { toast }             = useSession();

  const [form, setForm] = useState({
    payee_type:     'individual',
    legal_name:     '',
    tax_country:    '',
    tax_id:         '',
    currency:       currency ?? 'GBP',
    method:         'bank_transfer',
    holder_name:    '',
    account_number: '',
    bank_code:      '',
    payout_schedule:'monthly',
  });
  const set = useCallback((k, v) => setForm(f => ({ ...f, [k]: v })), []);

  const submit = async () => {
    setSaving(true);
    try {
      await api.put(`/officials/${officialId}/payout-account`, form);
      toast(t('opa.wizard_saved'));
      onDone?.();
    } catch (e) {
      toast(e.message);
    } finally {
      setSaving(false);
    }
  };

  const stepTitle = [null, t('opa.step1_title'), t('opa.step2_title'), t('opa.step3_title'), t('opa.step4_title')][step];

  return (
    <View style={col(16)}>
      <View style={[row(8), { flexWrap: 'wrap' }]}>
        {[1,2,3,4].map(n => (
          <Chip key={n} label={`${n}. ${[null, t('opa.step1_short'), t('opa.step2_short'), t('opa.step3_short'), t('opa.step4_short')][n]}`} active={step === n} onPress={() => n < step && setStep(n)} />
        ))}
      </View>

      <H2 color={c.pink}>{stepTitle}</H2>

      {step === 1 && (
        <View style={col(12)}>
          <T size={13} color={c.mute}>{t('opa.step1_hint')}</T>
          <View style={[row(8), { flexWrap: 'wrap' }]}>
            {PAYEE_TYPES.map(pt => (
              <Chip key={pt.value} label={t(pt.labelKey)} active={form.payee_type === pt.value} onPress={() => set('payee_type', pt.value)} />
            ))}
          </View>
          <Field label={t('opa.legal_name')} value={form.legal_name} onChangeText={v => set('legal_name', v)} placeholder={t('opa.legal_name_placeholder')} maxLength={200} accessibilityLabel={t('opa.legal_name')} />
          <Field label={t('opa.tax_country')} value={form.tax_country} onChangeText={v => set('tax_country', v.toUpperCase())} placeholder="GB" maxLength={2} accessibilityLabel={t('opa.tax_country')} />
          <Field label={t('opa.tax_id')} value={form.tax_id} onChangeText={v => set('tax_id', v)} placeholder={t('opa.tax_id_placeholder')} maxLength={50} secure accessibilityLabel={t('opa.tax_id')} />
          <Btn title={t('opa.next')} onPress={() => setStep(2)} disabled={!form.legal_name || !form.tax_country} accessibilityLabel={t('opa.next')} />
        </View>
      )}

      {step === 2 && (
        <View style={col(12)}>
          <T size={13} color={c.mute}>{t('opa.step2_hint')}</T>
          {METHODS.map(m => (
            <Card key={m.value} color={form.method === m.value ? c.pinkSoft : c.paper} onPress={() => set('method', m.value)} accessibilityLabel={t(m.labelKey)}>
              <View style={row(10)}>
                <T size={22}>{m.icon}</T>
                <View style={{ flex: 1 }}>
                  <T weight="700">{t(m.labelKey)}</T>
                  {m.value === 'stripe_connect' && <Tag label={t('opa.method_kyc_required')} color={c.sunSoft} />}
                  {m.value === 'digital_wallet' && <T size={12} color={c.mute}>{t('opa.method_wallet_hint')}</T>}
                </View>
                {form.method === m.value && <T color={c.pink} size={18}>✓</T>}
              </View>
            </Card>
          ))}
          <View style={row(8)}>
            <Btn title={t('opa.back')} color={c.paper} ink={c.ink} onPress={() => setStep(1)} style={{ flex: 1 }} />
            <Btn title={t('opa.next')} onPress={() => setStep(3)} style={{ flex: 1 }} />
          </View>
        </View>
      )}

      {step === 3 && (
        <View style={col(12)}>
          <T size={13} color={c.mute}>{t('opa.step3_hint')}</T>
          <Banner tone={c.limeSoft}><T size={12} color={c.lime}>{t('opa.encrypted_badge')}</T></Banner>
          <Field label={t('opa.holder_name')} value={form.holder_name} onChangeText={v => set('holder_name', v)} placeholder={t('opa.holder_name_placeholder')} maxLength={120} accessibilityLabel={t('opa.holder_name')} />
          <Field label={t('opa.account_number')} value={form.account_number} onChangeText={v => set('account_number', v)} placeholder={t('opa.account_number_placeholder')} maxLength={34} secure accessibilityLabel={t('opa.account_number')} />
          {form.method === 'bank_transfer' && (
            <Field label={t('opa.bank_code')} value={form.bank_code} onChangeText={v => set('bank_code', v)} placeholder={t('opa.bank_code_placeholder')} maxLength={20} accessibilityLabel={t('opa.bank_code')} />
          )}
          <View style={row(8)}>
            <Btn title={t('opa.back')} color={c.paper} ink={c.ink} onPress={() => setStep(2)} style={{ flex: 1 }} />
            <Btn title={t('opa.next')} onPress={() => setStep(4)} disabled={!form.holder_name || !form.account_number} style={{ flex: 1 }} />
          </View>
        </View>
      )}

      {step === 4 && (
        <View style={col(12)}>
          <T size={13} color={c.mute}>{t('opa.step4_hint')}</T>
          <View style={[row(8), { flexWrap: 'wrap' }]}>
            {SCHEDULES.map(s => (
              <Chip key={s.value} label={t(s.labelKey)} active={form.payout_schedule === s.value} onPress={() => set('payout_schedule', s.value)} />
            ))}
          </View>
          <FeeDisclosure disclosure={disclosure} />
          <Card color={c.violetSoft}>
            <T weight="700" size={13}>{t('opa.review_title')}</T>
            <T size={12}>{t('opa.review_method')}: {t(METHODS.find(m => m.value === form.method)?.labelKey ?? form.method)}</T>
            <T size={12}>{t('opa.review_account')}: •••• {form.account_number.replace(/[^A-Za-z0-9]/g,'').slice(-4)}</T>
            <T size={12}>{t('opa.review_schedule')}: {t(SCHEDULES.find(s => s.value === form.payout_schedule)?.labelKey ?? form.payout_schedule)}</T>
          </Card>
          <View style={row(8)}>
            <Btn title={t('opa.back')} color={c.paper} ink={c.ink} onPress={() => setStep(3)} style={{ flex: 1 }} />
            <Btn title={t('opa.submit')} onPress={submit} loading={saving} style={{ flex: 1 }} accessibilityLabel={t('opa.submit_aria')} />
          </View>
        </View>
      )}
    </View>
  );
}

// ---- verified view -----------------------------------------------------------
function VerifiedView({ account, history, failures, disclosure, officialId, onReplace }) {
  const [tab, setTab]       = useState('overview');
  const { toast }           = useSession();

  const resolveFailure = async (failureId) => {
    try {
      await api.post(`/officials/${officialId}/payout-account/failures/${failureId}/resolve`, {});
      toast(t('opa.failure_resolved'));
      failures?.reload?.();
    } catch (e) { toast(e.message); }
  };

  return (
    <View style={col(16)}>
      <HoldBanner account={account} />
      <KpiStrip history={history?.data} pending={(failures?.data ?? []).filter(f => !f.resolved_at).length} />
      {statusTag(account.status)}
      <Card color={c.paper}>
        <T weight="700">{t('opa.account_title')}</T>
        <T size={13}>{t('opa.method_label')}: {t(METHODS.find(m => m.value === account.method)?.labelKey ?? account.method)}</T>
        <T size={13}>{t('opa.account_last4')}: •••• {account.last4}</T>
        <T size={13}>{t('opa.schedule_label')}: {t(SCHEDULES.find(s => s.value === account.payout_schedule)?.labelKey ?? 'opa.schedule_monthly')}</T>
      </Card>
      <Seg
        options={[
          { value: 'overview', label: t('opa.tab_overview') },
          { value: 'history',  label: t('opa.tab_history') },
          { value: 'fees',     label: t('opa.tab_fees') },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'overview' && (
        <View style={col(8)}>
          {(failures?.data ?? []).filter(f => !f.resolved_at).map(f => (
            <FailureCard key={f.id} failure={f} onResolve={resolveFailure} />
          ))}
          {!(failures?.data ?? []).filter(f => !f.resolved_at).length && (
            <Empty emoji="✅" title={t('opa.no_failures_title')} sub={t('opa.no_failures_sub')} />
          )}
        </View>
      )}
      {tab === 'history' && (
        <View style={col(4)}>
          {history?.loading && !history?.data ? <Loading /> : null}
          {(history?.data ?? []).length === 0 && <Empty emoji="💸" title={t('opa.history_empty')} sub={t('opa.history_empty_sub')} />}
          {(history?.data ?? []).map(h => <HistoryRow key={h.id} item={h} />)}
        </View>
      )}
      {tab === 'fees' && <FeeDisclosure disclosure={disclosure?.data} />}
      <Btn small title={t('opa.replace_account')} color={c.paper} ink={c.pink} onPress={onReplace} accessibilityLabel={t('opa.replace_account_aria')} />
    </View>
  );
}

// ---- pending view ------------------------------------------------------------
function PendingView({ account }) {
  return (
    <View style={col(16)}>
      <Banner tone={c.cyanSoft}>
        <T weight="700">{t('opa.pending_title')}</T>
        <T size={13}>{t('opa.pending_body')}</T>
      </Banner>
      <Card color={c.paper}>
        <T weight="700">{t('opa.account_title')}</T>
        <T size={13}>{t('opa.account_last4')}: •••• {account.last4}</T>
        <T size={13}>{t('opa.method_label')}: {t(METHODS.find(m => m.value === account.method)?.labelKey ?? account.method)}</T>
        {statusTag(account.status)}
      </Card>
      <T size={12} color={c.mute}>{t('opa.pending_note')}</T>
    </View>
  );
}

// ---- main export -------------------------------------------------------------
export function OfficialPayoutAccount({ officialId, currency = 'GBP' }) {
  const { layout }  = useLayout?.() ?? { layout: {} };
  const { tablet }  = useLayout();
  const { toast }   = useSession();

  const [replacing, setReplacing] = useState(false);

  const account    = useLoad(() => api.get(`/officials/${officialId}/payout-account`, { currency }).catch(e => (e.status === 404 ? null : Promise.reject(e))), [officialId, currency, replacing]);
  const history    = useLoad(() => account.data?.id ? api.get(`/officials/${officialId}/payout-account/history`, { currency, limit: 25, offset: 0 }) : null, [account.data?.id]);
  const failures   = useLoad(() => account.data?.id ? api.get(`/officials/${officialId}/payout-account/failures`, { resolved: false, limit: 25, offset: 0 }) : null, [account.data?.id]);
  const disclosure = useLoad(() => api.get(`/officials/${officialId}/payout-account/fee-disclosure`, { currency }), [officialId, currency]);

  const acc = account.data;

  if (account.loading && !acc) return <Loading />;
  if (account.error) return <ErrorBox error={account.error} onRetry={account.reload} />;

  const isHeld      = acc?.held_at && !acc?.released_at;
  const isVerified  = acc?.status === 'verified';
  const isPending   = acc?.status === 'pending';
  const noAccount   = !acc;
  const isReplacing = replacing && (isVerified || isPending);

  const content = (
    <View style={col(20)}>
      <GradCard colors={grad.hero}>
        <H1 color="#fff">{t('opa.screen_title')}</H1>
        <T color="rgba(255,255,255,0.8)" size={14}>{t('opa.screen_subtitle')}</T>
      </GradCard>

      {(noAccount || isReplacing) && (
        <Card color={c.paper}>
          {noAccount && !isReplacing && (
            <Banner tone={c.sunSoft}>
              <T weight="700" color={c.orange}>{t('opa.not_configured_title')}</T>
              <T size={13}>{t('opa.not_configured_body')}</T>
            </Banner>
          )}
          <SetupWizard
            officialId={officialId}
            currency={currency}
            disclosure={disclosure.data}
            onDone={() => { setReplacing(false); account.reload(); failures.reload?.(); }}
          />
        </Card>
      )}

      {isHeld && !isReplacing && (
        <Card color={c.orangeSoft}>
          <HoldBanner account={acc} />
          <T size={13}>{t('opa.hold_body')}</T>
        </Card>
      )}

      {isPending && !isReplacing && <PendingView account={acc} />}

      {isVerified && !isReplacing && (
        <VerifiedView
          account={acc}
          history={history}
          failures={failures}
          disclosure={disclosure}
          officialId={officialId}
          onReplace={() => setReplacing(true)}
        />
      )}
    </View>
  );

  if (tablet) {
    return (
      <Screen wide>
        <View style={{ flexDirection: RTL ? 'row-reverse' : 'row', gap: 24, alignItems: 'flex-start' }}>
          <View style={{ flex: 2 }}>{content}</View>
          {isVerified && !isReplacing && (
            <View style={{ flex: 1 }}>
              <Section title={t('opa.fee_disclosure_title')} color={c.cyan}>
                <FeeDisclosure disclosure={disclosure.data} />
              </Section>
            </View>
          )}
        </View>
      </Screen>
    );
  }

  return <Screen>{content}</Screen>;
}

// ---- admin console ----------------------------------------------------------
export function AdminOfficialPayoutAccounts() {
  const { tablet } = useLayout();
  const { toast }  = useSession();
  const [status, setStatus] = useState('pending');
  const [detail, setDetail] = useState(null);
  const [holdSheet, setHoldSheet] = useState(null);
  const [auditSheet, setAuditSheet] = useState(null);

  const list = useLoad(() => api.get('/admin/officials/payout-accounts', { status, limit: 50, offset: 0 }), [status]);

  const decide = async (id, decision, reason, kyc) => {
    try {
      await api.post(`/admin/officials/payout-accounts/${id}/verify`, { decision, reason, kyc_provider: kyc ?? undefined });
      toast(decision === 'verify' ? t('opa.admin_verified') : t('opa.admin_rejected'));
      list.reload(); setDetail(null);
    } catch (e) { toast(e.message); }
  };
  const hold = async (id, reason) => {
    try {
      await api.post(`/admin/officials/payout-accounts/${id}/hold`, { reason });
      toast(t('opa.admin_held')); list.reload(); setHoldSheet(null);
    } catch (e) { toast(e.message); }
  };
  const release = async (id) => {
    try {
      await api.post(`/admin/officials/payout-accounts/${id}/release`, {});
      toast(t('opa.admin_released')); list.reload();
    } catch (e) { toast(e.message); }
  };
  const reveal = async (id, fields) => {
    try {
      const r = await api.get(`/admin/officials/payout-accounts/${id}/reveal`, { fields });
      return r;
    } catch (e) { toast(e.message); return null; }
  };

  return (
    <Screen wide={tablet}>
      <H2>{t('opa.admin_title')}</H2>
      <Seg
        options={['pending','verified','rejected','held','superseded'].map(s => ({ value: s, label: t(`opa.admin_filter_${s}`) }))}
        value={status}
        onChange={setStatus}
      />
      {list.loading && !list.data ? <Loading /> : null}
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
      {(list.data ?? []).map(a => (
        <Row key={a.id}
          title={`${a.owner} · ${a.currency} ····${a.last4}`}
          sub={`${t(METHODS.find(m => m.value === a.method)?.labelKey ?? a.method)} · ${new Date(a.created_at).toLocaleDateString()}`}
          right={<View style={[row(6)]}>{statusTag(a.status)}{a.held_at && !a.released_at ? <Tag label={t('opa.admin_on_hold')} color={c.sunSoft} /> : null}</View>}
          onPress={() => setDetail(a)}
          accessibilityLabel={`${a.owner} ${a.currency} ${a.status}`}
        />
      ))}
      {(list.data ?? []).length === 0 && !list.loading && <Empty emoji="🏦" title={t('opa.admin_empty')} sub="" />}

      {/* Detail sheet */}
      <Sheet visible={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.owner} · ${detail.currency}` : ''}>
        {detail && (
          <View style={col(12)}>
            {statusTag(detail.status)}
            <T size={13}>{t('opa.review_method')}: {t(METHODS.find(m => m.value === detail.method)?.labelKey ?? detail.method)}</T>
            <T size={13}>{t('opa.account_last4')}: •••• {detail.last4}</T>
            {detail.decision_reason ? <T size={12} color={c.mute}>{detail.decision_reason}</T> : null}
            <AdminReveal accountId={detail.id} onReveal={reveal} />
            {detail.status === 'pending' && (
              <View style={[row(8)]}>
                <Btn small title={t('opa.admin_verify')} onPress={() => decide(detail.id, 'verify', 'Verified by platform team', null)} style={{ flex: 1 }} />
                <Btn small title={t('opa.admin_reject')} color={c.paper} ink={c.red} onPress={() => decide(detail.id, 'reject', 'Failed KYC checks', null)} style={{ flex: 1 }} />
              </View>
            )}
            {detail.status === 'verified' && (!detail.held_at || detail.released_at) && (
              <Btn small title={t('opa.admin_hold')} color={c.sunSoft} ink={c.orange} onPress={() => setHoldSheet(detail)} />
            )}
            {detail.held_at && !detail.released_at && (
              <Btn small title={t('opa.admin_release')} color={c.limeSoft} ink={c.lime} onPress={() => release(detail.id)} />
            )}
            <Btn small title={t('opa.admin_audit_trail')} color={c.paper} ink={c.violet} onPress={() => { setAuditSheet(detail); setDetail(null); }} />
          </View>
        )}
      </Sheet>

      {/* Hold sheet */}
      <FormSheet
        visible={!!holdSheet}
        onClose={() => setHoldSheet(null)}
        title={t('opa.hold_sheet_title')}
        submitLabel={t('opa.hold_submit')}
        fields={[{ key: 'reason', label: t('opa.hold_reason_label'), hint: t('opa.hold_reason_hint') }]}
        onSubmit={async (v) => { await hold(holdSheet?.id, v.reason); return t('opa.admin_held'); }}
      />

      {/* Audit trail sheet */}
      <Sheet visible={!!auditSheet} onClose={() => setAuditSheet(null)} title={t('opa.admin_audit_trail')}>
        {auditSheet && <AdminAuditTrail accountId={auditSheet.id} />}
      </Sheet>
    </Screen>
  );
}

function AdminReveal({ accountId, onReveal }) {
  const [revealed, setRevealed] = useState(null);
  const [loading, setLoading]   = useState(false);
  const { toast }               = useSession();
  const go = async () => {
    setLoading(true);
    const r = await onReveal(accountId, ['bank_details', 'legal_name', 'tax_id']);
    setLoading(false);
    if (r) setRevealed(r);
    else toast(t('opa.reveal_failed'));
  };
  if (revealed) return (
    <Card color={c.sunSoft}>
      <T size={12} weight="700" color={c.orange}>{t('opa.reveal_audit_note')}</T>
      {revealed.legal_name    && <T size={12}>{t('opa.legal_name')}: {revealed.legal_name}</T>}
      {revealed.tax_id        && <T size={12}>{t('opa.tax_id')}: {revealed.tax_id}</T>}
      {revealed.bank_details  && <T size={12}>{t('opa.holder_name')}: {revealed.bank_details.holder_name}</T>}
      {revealed.bank_details  && <T size={12}>{t('opa.account_number')}: {revealed.bank_details.account_number}</T>}
    </Card>
  );
  return <Btn small title={t('opa.admin_reveal')} color={c.paper} ink={c.violet} loading={loading} onPress={go} accessibilityLabel={t('opa.admin_reveal_aria')} />;
}

function AdminAuditTrail({ accountId }) {
  const audit = useLoad(() => api.get(`/admin/officials/payout-accounts/${accountId}/audit`, { limit: 50, offset: 0 }), [accountId]);
  if (audit.loading) return <Loading />;
  if (audit.error)   return <ErrorBox error={audit.error} onRetry={audit.reload} />;
  if (!(audit.data ?? []).length) return <Empty emoji="📋" title={t('opa.admin_audit_empty')} sub="" />;
  return (
    <View style={col(4)}>
      {(audit.data ?? []).map(e => (
        <Row key={e.id} title={e.action.replace(/_/g, ' ')} sub={`${e.actor} · ${new Date(e.created_at).toLocaleString()}`} accessibilityLabel={`${e.action} by ${e.actor}`} />
      ))}
    </View>
  );
}
