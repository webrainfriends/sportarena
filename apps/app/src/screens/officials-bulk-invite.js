// Officials Bulk Invite Wizard — Issue #1005 (R13)
// 5-step wizard: select fixtures → choose role → pick officials → fee & message → review & send.
// Works on iOS, iPadOS, Android and web.
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, Field, Loading, Screen, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, r } from '../theme';
import { t } from '../i18n';
import { money } from '../federation-ui';
import { CurrencyField } from '../money-field';

const OFFICIAL_ROLES = ['referee', 'umpire', 'linesman', 'scorer'];
const ROLE_LABEL = {
  referee: t('officials.role.referee'),
  umpire: t('officials.role.umpire'),
  linesman: t('officials.role.linesman'),
  scorer: t('officials.role.scorer'),
};

// ─── Step indicator ───────────────────────────────────────────────────────────
function StepBar({ step, total = 5 }) {
  const labels = [
    t('officials.bulk.step1'),
    t('officials.bulk.step2'),
    t('officials.bulk.step3'),
    t('officials.bulk.step4'),
    t('officials.bulk.step5'),
  ];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 0, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'flex-start' }}>
      {labels.map((lbl, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ alignItems: 'center', gap: 4 }}>
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: done ? c.pink : active ? c.violet : c.line, alignItems: 'center', justifyContent: 'center', ...(active ? { shadowColor: c.pink, shadowOpacity: 0.4, shadowRadius: 6 } : {}) }}>
                <T size={12} weight="800" color={done || active ? c.on : c.mute}>{done ? '✓' : i + 1}</T>
              </View>
              <T size={9} weight="600" color={active ? c.ink : c.mute} style={{ textAlign: 'center', maxWidth: 50 }}>{lbl}</T>
            </View>
            {i < total - 1 ? <View style={{ width: 36, height: 2, backgroundColor: done ? c.pink : c.line, marginTop: 13, marginHorizontal: 2 }} /> : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

// ─── Step 1: Select fixtures ──────────────────────────────────────────────────
function StepFixtures({ eventId, selectedIds, onToggle, onNext }) {
  const q = useLoad(() => api.get(`/events/${eventId}/officials/board`, { uncovered_only: false, limit: 100 }), [eventId]);
  if (q.loading) return <Loading />;
  if (q.error) return <LoadError error={q.error} onRetry={q.reload} />;
  const fixtures = q.data?.fixtures ?? [];
  return (
    <View style={{ flex: 1 }}>
      <T weight="700" style={{ margin: 16, marginBottom: 8 }}>{t('officials.bulk.pick_fixtures')}</T>
      <T size={13} color={c.mute} style={{ marginHorizontal: 16, marginBottom: 12 }}>{t('officials.bulk.pick_fixtures_hint')}</T>
      <ScrollView style={{ flex: 1 }}>
        {fixtures.map((f) => {
          const sel = selectedIds.has(f.id);
          return (
            <Card key={f.id} color={sel ? c.pinkSoft : c.paper} style={{ margin: 8, marginVertical: 4, borderWidth: 1.5, borderColor: sel ? c.pink : c.line }}
              onPress={() => onToggle(f.id)} accessibilityRole="checkbox" accessibilityState={{ checked: sel }}
              accessibilityLabel={`${f.home_name ?? 'TBD'} vs ${f.away_name ?? 'TBD'}`}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: sel ? c.pink : c.line, backgroundColor: sel ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {sel ? <T size={12} color={c.on} weight="800">✓</T> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <T weight="700">{f.round ? `${f.round} · ` : ''}{f.home_name ?? 'TBD'} v {f.away_name ?? 'TBD'}</T>
                  {f.scheduled_at ? <T size={12} color={c.mute}>{new Date(f.scheduled_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</T> : <T size={12} color={c.mute}>{t('officials.bulk.not_scheduled')}</T>}
                  {f.venue_name ? <T size={12} color={c.mute}>📍 {f.venue_name}</T> : null}
                </View>
                {/* Uncovered slots count */}
                {Object.values(f.crew ?? {}).flat().filter((o) => ['invited','accepted'].includes(o.status)).length < 4
                  ? <Chip label={`${4 - Object.values(f.crew ?? {}).flat().filter((o) => ['invited','accepted'].includes(o.status)).length} open`} color={c.redSoft} small />
                  : <Chip label="Covered ✓" color={c.mintSoft} small />}
              </View>
            </Card>
          );
        })}
      </ScrollView>
      <View style={{ padding: 16, flexDirection: 'row', gap: 10 }}>
        <T size={13} color={c.mute} style={{ flex: 1, alignSelf: 'center' }}>{selectedIds.size} {t('officials.bulk.selected')}</T>
        <Btn title={`${t('common.next')} →`} onPress={onNext} disabled={selectedIds.size === 0} style={{ flex: 1, minHeight: 48 }} />
      </View>
    </View>
  );
}

// ─── Step 2: Choose role ──────────────────────────────────────────────────────
function StepRole({ role, onSelect, onNext, onBack }) {
  return (
    <View style={{ flex: 1, padding: 16 }}>
      <T weight="700" style={{ marginBottom: 8 }}>{t('officials.bulk.pick_role')}</T>
      <T size={13} color={c.mute} style={{ marginBottom: 16 }}>{t('officials.bulk.pick_role_hint')}</T>
      <View style={{ gap: 10, flex: 1 }}>
        {OFFICIAL_ROLES.map((r) => (
          <Card key={r} color={role === r ? c.pinkSoft : c.paper} style={{ borderWidth: 1.5, borderColor: role === r ? c.pink : c.line }}
            onPress={() => onSelect(r)} accessibilityRole="radio" accessibilityState={{ checked: role === r }}
          >
            <T weight="700">{ROLE_LABEL[r]}</T>
          </Card>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <Btn title={`← ${t('common.back')}`} onPress={onBack} color={c.paper} ink={c.ink} style={{ flex: 1, minHeight: 48 }} />
        <Btn title={`${t('common.next')} →`} onPress={onNext} disabled={!role} style={{ flex: 1, minHeight: 48 }} />
      </View>
    </View>
  );
}

// ─── Step 3: Pick officials ───────────────────────────────────────────────────
function StepOfficials({ eventId, role, fixtureIds, selectedUsers, onToggle, onNext, onBack }) {
  const q = useLoad(() => api.get(`/events/${eventId}/officials/pool`, { role, limit: 50 }), [eventId, role]);
  if (q.loading) return <Loading />;
  if (q.error) return <LoadError error={q.error} onRetry={q.reload} />;
  const officials = q.data?.officials ?? [];
  return (
    <View style={{ flex: 1 }}>
      <T weight="700" style={{ margin: 16, marginBottom: 4 }}>{t('officials.bulk.pick_officials')}</T>
      <T size={13} color={c.mute} style={{ marginHorizontal: 16, marginBottom: 12 }}>{t('officials.bulk.pick_officials_hint', { role: ROLE_LABEL[role] ?? role, count: fixtureIds.length })}</T>
      <ScrollView style={{ flex: 1 }}>
        {officials.length === 0 ? <Empty icon="👤" label={t('officials.board.no_pool')} /> : null}
        {officials.map((o) => {
          const sel = selectedUsers.has(o.id);
          // Count available days
          const avDays = Object.values(o.availability ?? {}).filter((v) => v === 'available').length;
          const totalDays = Object.keys(o.availability ?? {}).length;
          return (
            <Card key={o.id} color={sel ? c.pinkSoft : c.paper} style={{ margin: 8, marginVertical: 4, borderWidth: 1.5, borderColor: sel ? c.pink : c.line }}
              onPress={() => onToggle(o.id)} accessibilityRole="checkbox" accessibilityState={{ checked: sel }}
              accessibilityLabel={o.display_name}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: sel ? c.pink : c.line, backgroundColor: sel ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {sel ? <T size={12} color={c.on} weight="800">✓</T> : null}
                </View>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.violet, alignItems: 'center', justifyContent: 'center' }}>
                  <T size={13} weight="800" color={c.on}>{(o.display_name ?? '').split(' ').map((w) => w[0]).join('').slice(0, 2)}</T>
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <T weight="700">{o.display_name}</T>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                    {o.grade_name ? <Chip label={o.grade_name} color={c.pinkSoft} small /> : null}
                    {o.base_city ? <Chip label={o.base_city} color={c.cyanSoft} small /> : null}
                    {o.verification_expires_at ? <Chip label="✅ Verified" color={c.mintSoft} small /> : null}
                    {totalDays > 0 ? (
                      <Chip
                        label={avDays === totalDays ? `🟢 ${t('officials.bulk.avail_all')}` : avDays > 0 ? `🟡 ${avDays}/${totalDays} days` : `🔴 ${t('officials.bulk.avail_none')}`}
                        color={avDays === totalDays ? c.mintSoft : avDays > 0 ? c.sunSoft : c.redSoft}
                        small
                      />
                    ) : null}
                  </View>
                </View>
              </View>
            </Card>
          );
        })}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 10, padding: 16 }}>
        <Btn title={`← ${t('common.back')}`} onPress={onBack} color={c.paper} ink={c.ink} style={{ flex: 1, minHeight: 48 }} />
        <Btn title={`${t('common.next')} →`} onPress={onNext} disabled={selectedUsers.size === 0} style={{ flex: 1, minHeight: 48 }} />
      </View>
    </View>
  );
}

// ─── Step 4: Fee & message ────────────────────────────────────────────────────
function StepFee({ feeMinor, feeCurrency, message, onChange, onNext, onBack }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <T weight="700" size={18}>{t('officials.bulk.fee_title')}</T>
      <T size={13} color={c.mute}>{t('officials.bulk.fee_hint')}</T>
      <Card color={c.paper}>
        <T size={12} color={c.mute} weight="700" style={{ marginBottom: 8 }}>{t('officials.bulk.fee_per_match')}</T>
        <CurrencyField
          value={feeMinor}
          currency={feeCurrency}
          onChangeValue={(v, cur) => onChange({ feeMinor: v, feeCurrency: cur })}
          label={t('officials.bulk.fee_label')}
          hint={t('officials.bulk.fee_hint2')}
        />
      </Card>
      <Card color={c.paper}>
        <Field
          label={t('officials.bulk.message_label')}
          value={message}
          onChangeText={(v) => onChange({ message: v })}
          placeholder={t('officials.bulk.message_placeholder')}
          maxLength={1000}
          multiline
          hint={t('officials.bulk.message_hint')}
        />
      </Card>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn title={`← ${t('common.back')}`} onPress={onBack} color={c.paper} ink={c.ink} style={{ flex: 1, minHeight: 48 }} />
        <Btn title={`${t('common.next')} →`} onPress={onNext} style={{ flex: 1, minHeight: 48 }} />
      </View>
    </ScrollView>
  );
}

// ─── Step 5: Review & send ────────────────────────────────────────────────────
function StepReview({ eventId, fixtureIds, userIds, role, feeMinor, feeCurrency, message, onBack, onDone }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const handleSend = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await api.post(`/events/${eventId}/officials/bulk-invite`, {
        role,
        fixture_ids: fixtureIds,
        user_ids: userIds,
        ...(feeMinor ? { fee_minor: feeMinor, fee_currency: feeCurrency } : {}),
        ...(message ? { message } : {}),
      });
      setResult(res);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (result) {
    return (
      <View style={{ flex: 1, padding: 16, gap: 16 }}>
        <Card color={c.mintSoft}>
          <T size={22} weight="800">🎉 {t('officials.bulk.sent_title')}</T>
          <T size={15} style={{ marginTop: 6 }}>{t('officials.bulk.sent_body', { count: result.sent?.length ?? 0 })}</T>
          {result.skipped?.length > 0 ? <T size={13} color={c.mute} style={{ marginTop: 4 }}>{t('officials.bulk.sent_skipped', { count: result.skipped.length })}</T> : null}
          {result.errors?.length > 0 ? <T size={13} color={c.red} style={{ marginTop: 4 }}>{t('officials.bulk.sent_errors', { count: result.errors.length })}</T> : null}
        </Card>
        <Btn title={t('officials.bulk.go_to_board')} onPress={onDone} style={{ minHeight: 48 }} />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <T weight="700" size={18}>{t('officials.bulk.review_title')}</T>
      <Card color={c.violetSoft}>
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T size={13} color={c.mute}>{t('officials.bulk.role')}</T>
            <T size={13} weight="700">{ROLE_LABEL[role] ?? role}</T>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T size={13} color={c.mute}>{t('officials.bulk.fixtures')}</T>
            <T size={13} weight="700">{fixtureIds.length}</T>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T size={13} color={c.mute}>{t('officials.bulk.officials_count')}</T>
            <T size={13} weight="700">{userIds.length}</T>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T size={13} color={c.mute}>{t('officials.bulk.total_invites')}</T>
            <T size={13} weight="700" color={c.pink}>{fixtureIds.length * userIds.length}</T>
          </View>
          {feeMinor ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <T size={13} color={c.mute}>{t('officials.bulk.fee_per_match')}</T>
              <T size={13} weight="700">{money(feeMinor, feeCurrency)}</T>
            </View>
          ) : null}
        </View>
      </Card>
      {message ? (
        <Card color={c.paper}>
          <T size={12} color={c.mute} weight="700" style={{ marginBottom: 4 }}>{t('officials.bulk.message_label')}</T>
          <T size={13}>{message}</T>
        </Card>
      ) : null}
      <Card color={c.sunSoft}>
        <T size={13}>⚠️ {t('officials.bulk.no_silent_booking')}</T>
      </Card>
      {err ? <T size={13} color={c.red}>{err}</T> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn title={`← ${t('common.back')}`} onPress={onBack} color={c.paper} ink={c.ink} style={{ flex: 1, minHeight: 48 }} />
        <Btn title={`📧 ${t('officials.bulk.send_all', { count: fixtureIds.length * userIds.length })}`} onPress={handleSend} loading={busy} style={{ flex: 1, minHeight: 48 }} />
      </View>
    </ScrollView>
  );
}

// ─── Wizard root ──────────────────────────────────────────────────────────────
export function OfficialsBulkInvite({ event_id, fixture_ids: prefillFixtures }) {
  const { back } = useNav();
  const [step, setStep] = useState(0);
  const [fixtureIds, setFixtureIds] = useState(new Set(prefillFixtures ?? []));
  const [role, setRole] = useState(null);
  const [userIds, setUserIds] = useState(new Set());
  const [feeMinor, setFeeMinor] = useState(null);
  const [feeCurrency, setFeeCurrency] = useState('USD');
  const [message, setMessage] = useState('');

  const toggleFixture = (id) => setFixtureIds((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const toggleUser = (id) => setUserIds((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, paddingBottom: 0 }}>
        <T size={18} weight="800" style={{ flex: 1 }}>{t('officials.bulk.wizard_title')}</T>
        <Btn title={t('common.cancel')} onPress={back} small color={c.paper} ink={c.ink} style={{ minHeight: 44 }} />
      </View>
      <StepBar step={step} />
      <View style={{ flex: 1 }}>
        {step === 0 && <StepFixtures eventId={event_id} selectedIds={fixtureIds} onToggle={toggleFixture} onNext={() => setStep(1)} />}
        {step === 1 && <StepRole role={role} onSelect={setRole} onNext={() => setStep(2)} onBack={() => setStep(0)} />}
        {step === 2 && <StepOfficials eventId={event_id} role={role} fixtureIds={[...fixtureIds]} selectedUsers={userIds} onToggle={toggleUser} onNext={() => setStep(3)} onBack={() => setStep(1)} />}
        {step === 3 && (
          <StepFee
            feeMinor={feeMinor} feeCurrency={feeCurrency} message={message}
            onChange={({ feeMinor: f, feeCurrency: fc, message: m }) => { if (f !== undefined) setFeeMinor(f); if (fc !== undefined) setFeeCurrency(fc); if (m !== undefined) setMessage(m); }}
            onNext={() => setStep(4)} onBack={() => setStep(2)}
          />
        )}
        {step === 4 && (
          <StepReview
            eventId={event_id} fixtureIds={[...fixtureIds]} userIds={[...userIds]}
            role={role} feeMinor={feeMinor} feeCurrency={feeCurrency} message={message}
            onBack={() => setStep(3)} onDone={back}
          />
        )}
      </View>
    </Screen>
  );
}

export default OfficialsBulkInvite;
