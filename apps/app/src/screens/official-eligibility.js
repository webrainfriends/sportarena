// Official Eligibility Hub — issue #1000 (REF-R09)
// Role-aware: an official sees their own eligibility status for an assignment;
// an event organiser sees the full crew eligibility panel for a fixture.
// All decisions come from the server. This screen shows what comes back and links to the conflict wizard and appeal flow.
import React, { useState } from 'react';
import { View, Pressable, AccessibilityInfo } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError, explain } from '../access';
import { c, r } from '../theme';
import { t } from '../i18n';

// ─── Factor state display ─────────────────────────────────────────────────────

const FACTOR_STATE = {
  eligible:    { icon: '✅', label: t('oe.state.eligible'),    color: (C) => C.mintSoft  },
  pending:     { icon: '⏳', label: t('oe.state.pending'),     color: (C) => C.cyanSoft  },
  ineligible:  { icon: '⛔', label: t('oe.state.ineligible'),  color: (C) => C.redSoft   },
  overridden:  { icon: '🔓', label: t('oe.state.overridden'),  color: (C) => C.sunSoft   },
};

function FactorRow({ factor }) {
  const s = FACTOR_STATE[factor.state] ?? FACTOR_STATE.pending;
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, minHeight: 44 }}
      accessible
      accessibilityLabel={`${factor.label}: ${s.label}${factor.detail ? '. ' + factor.detail : ''}`}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: s.color(c), alignItems: 'center', justifyContent: 'center' }}>
        <T size={18}>{s.icon}</T>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T weight="800" size={14.5}>{factor.label}</T>
        {factor.detail ? <T size={12.5} color={c.mute}>{factor.detail}</T> : null}
        {factor.override_id ? <Tag label={t('oe.override_active')} color={c.sunSoft} /> : null}
      </View>
      <Tag label={s.label} color={s.color(c)} />
    </View>
  );
}

function EligibilityBadge({ eligible, blocking }) {
  if (eligible) return <Tag label={`✅ ${t('oe.badge.eligible')}`} color={c.mintSoft} />;
  const count = blocking?.length ?? 0;
  return <Tag label={`⛔ ${t('oe.badge.ineligible')} · ${count} issue${count === 1 ? '' : 's'}`} color={c.redSoft} />;
}

// ─── Official self-view ───────────────────────────────────────────────────────

function OfficialEligibilityView({ assignmentId }) {
  const { toast } = useSession();
  const { push: go } = useNav();
  const q = useLoad(() => api.get(`/official-assignments/${assignmentId}/eligibility`), [assignmentId]);
  const overrides = useLoad(() => api.get(`/official-assignments/${assignmentId}/eligibility/overrides`), [assignmentId]);
  const [appealing, setAppealing] = useState(false);
  const [busy, setBusy] = useState(false);

  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const { eligible, factors, blocking } = q.data;

  const submitAppeal = async ({ grounds, note }) => {
    setBusy(true);
    try {
      await api.post(`/official-assignments/${assignmentId}/eligibility/appeal`, { grounds, supporting_note: note || undefined });
      toast(t('oe.appeal.sent'));
      setAppealing(false);
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  return (
    <View style={{ gap: 14 }}>
      <Card>
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <T weight="800" size={17}>{t('oe.section.eligibility')}</T>
            <EligibilityBadge eligible={eligible} blocking={blocking} />
          </View>
          <T size={13} color={c.mute}>{t('oe.eligibility_note')}</T>
        </View>
        <View style={{ marginTop: 8 }}>
          {factors.map((f) => <FactorRow key={f.key} factor={f} />)}
        </View>
      </Card>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn
          title={`⚠️ ${t('oe.btn.declare_conflict')}`}
          onPress={() => go('OfficialConflictInterest', { assignmentId })}
          color={c.sunSoft} ink={c.ink}
          style={{ minHeight: 48 }}
          accessibilityLabel={t('oe.btn.declare_conflict')}
        />
        {!eligible && (
          <Btn
            title={`📝 ${t('oe.btn.appeal')}`}
            onPress={() => setAppealing(true)}
            color={c.paper} ink={c.ink}
            style={{ minHeight: 48 }}
          />
        )}
      </View>

      {overrides.data?.length ? (
        <Section title={t('oe.section.overrides')} color={c.sunSoft}>
          {overrides.data.map((ov) => (
            <Card key={ov.id} pad={12}>
              <T weight="800" size={13.5}>{t('oe.override.factor', { factor: ov.factor_key })}</T>
              <T size={12.5} color={c.mute}>{t('oe.override.by', { name: ov.granted_by_name })} · {t('oe.override.expires', { date: new Date(ov.override_expires_at).toLocaleDateString() })}</T>
            </Card>
          ))}
        </Section>
      ) : null}

      <T size={12} color={c.mute}>{t('oe.privacy_note')}</T>

      <FormSheet
        visible={appealing}
        onClose={() => setAppealing(false)}
        title={t('oe.appeal.title')}
        submitLabel={t('oe.appeal.submit')}
        notice={t('oe.appeal.notice')}
        onSubmit={submitAppeal}
        fields={[
          { key: 'grounds', label: t('oe.appeal.grounds_label'), type: 'multiline', required: true },
          { key: 'note', label: t('oe.appeal.note_label'), type: 'multiline', optional: true },
        ]}
      />
    </View>
  );
}

// ─── Organiser crew eligibility view ─────────────────────────────────────────

function CrewEligibilityRow({ member, onGrantOverride, onViewConflicts }) {
  const [expanded, setExpanded] = useState(false);
  const { eligible, blocking, factors, role, display_name, status } = member;
  return (
    <Card pad={14}>
      <Pressable
        onPress={() => setExpanded((x) => !x)}
        accessibilityRole="button"
        accessibilityLabel={`${display_name}, ${role}, ${eligible ? 'eligible' : `ineligible: ${blocking.join(', ')}`}. Tap to ${expanded ? 'collapse' : 'expand'}.`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <T weight="800" size={15}>{display_name}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Tag label={role.replace(/_/g, ' ')} color={c.violetSoft} />
            <Tag label={status} color={status === 'accepted' ? c.mintSoft : c.sunSoft} />
            <EligibilityBadge eligible={eligible} blocking={blocking} />
          </View>
        </View>
        <T size={22} color={c.mute}>{expanded ? '∧' : '∨'}</T>
      </Pressable>

      {expanded ? (
        <View style={{ marginTop: 10, gap: 10 }}>
          {factors.map((f) => <FactorRow key={f.key} factor={f} />)}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            {blocking.filter((b) => b !== 'suspension' && b !== 'conflicts').map((b) => (
              <Btn
                key={b}
                small
                title={t('oe.btn.grant_override_for', { factor: b })}
                color={c.sunSoft} ink={c.ink}
                style={{ minHeight: 44 }}
                onPress={() => onGrantOverride({ assignmentId: member.assignment_id, factorKey: b })}
              />
            ))}
            <Btn
              small
              title={t('oe.btn.view_conflicts')}
              color={c.paper} ink={c.ink}
              style={{ minHeight: 44 }}
              onPress={() => onViewConflicts(member.assignment_id)}
            />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

function CrewEligibilityView({ fixtureId }) {
  const { toast } = useSession();
  const { push: go } = useNav();
  const q = useLoad(() => api.get(`/fixtures/${fixtureId}/officials/eligibility`), [fixtureId]);
  const [overrideTarget, setOverrideTarget] = useState(null); // { assignmentId, factorKey }
  const [busy, setBusy] = useState(false);

  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const crew = q.data;
  const allEligible = crew.every((m) => m.eligible);

  const submitOverride = async ({ reason, expires }) => {
    setBusy(true);
    try {
      await api.post(`/official-assignments/${overrideTarget.assignmentId}/eligibility/override`, {
        factor_key: overrideTarget.factorKey,
        reason,
        override_expires_at: expires,
      });
      toast(t('oe.override.granted'));
      setOverrideTarget(null);
      await q.reload();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <T weight="800" size={17}>{t('oe.crew.title')}</T>
        {allEligible
          ? <Tag label={`✅ ${t('oe.crew.all_eligible')}`} color={c.mintSoft} />
          : <Tag label={`⚠️ ${crew.filter((m) => !m.eligible).length} ${t('oe.crew.issues')}`} color={c.sunSoft} />}
      </View>

      {crew.length ? crew.map((m) => (
        <CrewEligibilityRow
          key={m.assignment_id}
          member={m}
          onGrantOverride={setOverrideTarget}
          onViewConflicts={(aId) => go('OfficialConflictInterest', { assignmentId: aId, organiserView: true })}
        />
      )) : <Empty emoji="👥" title={t('oe.crew.empty')} sub={t('oe.crew.empty_sub')} />}

      <T size={12} color={c.mute}>{t('oe.privacy_note')}</T>

      <FormSheet
        visible={!!overrideTarget}
        onClose={() => setOverrideTarget(null)}
        title={t('oe.override.title', { factor: overrideTarget?.factorKey ?? '' })}
        submitLabel={t('oe.override.submit')}
        notice={t('oe.override.notice')}
        onSubmit={submitOverride}
        fields={[
          { key: 'reason', label: t('oe.override.reason_label'), type: 'multiline', required: true },
          { key: 'expires', label: t('oe.override.expires_label'), type: 'datetime', required: true },
        ]}
      />
    </View>
  );
}

// ─── Entry point (screen) ─────────────────────────────────────────────────────

/**
 * OfficialEligibility — mounted as a screen.
 * Props:
 *   assignmentId: UUID  — official self-view
 *   fixtureId: UUID     — organiser crew view
 */
export function OfficialEligibility({ assignmentId, fixtureId }) {
  return (
    <Screen>
      <GradCard colors={['#8458B3', '#494D5F']}>
        <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6 }}>{t('oe.header_label')}</T>
        <T size={24} weight="800" color="#fff" style={{ letterSpacing: -0.6, marginTop: 4 }}>
          {fixtureId ? t('oe.crew.heading') : t('oe.heading')}
        </T>
        <T size={13} color="rgba(255,255,255,0.75)" style={{ marginTop: 6 }}>
          {fixtureId ? t('oe.crew.sub') : t('oe.sub')}
        </T>
      </GradCard>

      {assignmentId ? <OfficialEligibilityView assignmentId={assignmentId} /> : null}
      {fixtureId ? <CrewEligibilityView fixtureId={fixtureId} /> : null}
      {!assignmentId && !fixtureId ? <Empty emoji="⚖️" title={t('oe.empty')} sub={t('oe.empty_sub')} /> : null}
    </Screen>
  );
}
