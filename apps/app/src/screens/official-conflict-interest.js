// Official Conflict-of-Interest Declaration & Decision — issue #1000 (REF-R09)
// Role-aware: official sees their declaration wizard + history;
// organiser sees pending declarations + decision controls.
// All content is encrypted server-side. counterparty (plain name) is shown; detail is behind "tap to read".
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError, explain } from '../access';
import { c, r } from '../theme';
import { t } from '../i18n';

// ─── Kind display ─────────────────────────────────────────────────────────────

const KIND_LABEL = {
  team_relationship:    t('oci.kind.team_relationship'),
  family_member:        t('oci.kind.family_member'),
  club_membership:      t('oci.kind.club_membership'),
  financial_interest:   t('oci.kind.financial_interest'),
  association_connection: t('oci.kind.association_connection'),
  previous_involvement: t('oci.kind.previous_involvement'),
  other:                t('oci.kind.other'),
};
const KIND_ICON = {
  team_relationship: '🤝', family_member: '👨‍👩‍👧', club_membership: '🏟️',
  financial_interest: '💰', association_connection: '🏛', previous_involvement: '📋', other: '⚠️',
};
const STATUS_COLOR = {
  open:       (C) => C.sunSoft,
  waived:     (C) => C.mintSoft,
  reassigned: (C) => C.cyanSoft,
  escalated:  (C) => C.redSoft,
  withdrawn:  (C) => C.paper,
};
const STATUS_LABEL = {
  open:       t('oci.status.open'),
  waived:     t('oci.status.waived'),
  reassigned: t('oci.status.reassigned'),
  escalated:  t('oci.status.escalated'),
  withdrawn:  t('oci.status.withdrawn'),
};

function ConflictCard({ item, onDecide, onWithdraw, canDecide, canWithdraw }) {
  const [showDetail, setShowDetail] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const color = STATUS_COLOR[item.status]?.(c) ?? c.paper;
  return (
    <Card color={color} pad={14}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={`${KIND_ICON[item.kind] ?? '⚠️'} ${KIND_LABEL[item.kind] ?? item.kind}`} color={c.violetSoft} />
          <Tag label={STATUS_LABEL[item.status] ?? item.status} color={color} />
          {item.serious ? <Tag label={t('oci.serious')} color={c.redSoft} /> : null}
        </View>
        {item.counterparty ? <T size={14} weight="700">📌 {item.counterparty}</T> : null}
        <T size={12.5} color={c.mute}>{t('oci.raised_at', { date: new Date(item.raised_at).toLocaleDateString() })}</T>

        {item.detail !== null ? (
          <Card color={c.paper} pad={10}><T size={13}>{item.detail}</T></Card>
        ) : (
          <Pressable
            onPress={() => setShowDetail(true)}
            accessibilityRole="button"
            accessibilityLabel={t('oci.show_detail')}
            style={{ paddingVertical: 8, minHeight: 44, alignItems: 'flex-start' }}
          >
            <T size={13} color={c.pink} weight="700">{t('oci.show_detail')} ›</T>
          </Pressable>
        )}

        {item.status === 'open' && canDecide ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            <Btn small title={t('oci.decide.waive')} onPress={() => onDecide(item, 'waive')} style={{ minHeight: 44 }} color={c.mint} />
            <Btn small title={t('oci.decide.reassign')} onPress={() => onDecide(item, 'reassign')} style={{ minHeight: 44 }} color={c.orange} />
            <Btn small title={t('oci.decide.escalate')} onPress={() => onDecide(item, 'escalate')} color={c.paper} ink={c.ink} style={{ minHeight: 44 }} />
          </View>
        ) : null}
        {item.status === 'open' && canWithdraw && item.can_withdraw ? (
          <Btn small title={t('oci.btn.withdraw')} color={c.paper} ink={c.ink} style={{ minHeight: 44 }} onPress={() => onWithdraw(item)} />
        ) : null}
      </View>
    </Card>
  );
}

// ─── Official's declaration wizard ───────────────────────────────────────────

function OfficialConflictView({ assignmentId }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/official-assignments/${assignmentId}/conflicts`), [assignmentId]);
  const [declaring, setDeclaring] = useState(false);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ kind: null, counterparty: '', detail: '', serious: false });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/official-assignments/${assignmentId}/conflicts`, {
        kind: form.kind, counterparty: form.counterparty || undefined,
        detail: form.detail, serious: form.serious,
      });
      toast(t('oci.declare.sent'));
      setDeclaring(false);
      setStep(0);
      setForm({ kind: null, counterparty: '', detail: '', serious: false });
      await q.reload();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  const withdraw = async (item) => {
    try {
      await api.post(`/official-conflicts/${item.id}/withdraw`, {});
      toast(t('oci.withdrawn'));
      await q.reload();
    } catch (e) { toast(explain(e)); }
  };

  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const items = q.data;

  const steps = [
    // Step 0: select kind
    <View key="kind" style={{ gap: 10 }}>
      <T weight="800" size={16}>{t('oci.wizard.step1')}</T>
      <T size={13} color={c.mute}>{t('oci.wizard.step1_sub')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {Object.entries(KIND_LABEL).map(([k, label]) => (
          <Chip
            key={k}
            label={`${KIND_ICON[k]} ${label}`}
            active={form.kind === k}
            onPress={() => setForm((f) => ({ ...f, kind: k }))}
          />
        ))}
      </View>
      <Btn title={t('common.next')} disabled={!form.kind} onPress={() => setStep(1)} style={{ minHeight: 48 }} />
    </View>,

    // Step 1: counterparty + detail
    <View key="detail" style={{ gap: 10 }}>
      <T weight="800" size={16}>{t('oci.wizard.step2')}</T>
      <FormSheet
        embedded
        fields={[
          { key: 'counterparty', label: t('oci.wizard.counterparty_label'), type: 'text', optional: true, placeholder: t('oci.wizard.counterparty_hint') },
          { key: 'detail', label: t('oci.wizard.detail_label'), type: 'multiline', required: true, placeholder: t('oci.wizard.detail_hint') },
        ]}
        value={form}
        onChange={(v) => setForm((f) => ({ ...f, ...v }))}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} onPress={() => setStep(0)} color={c.paper} ink={c.ink} style={{ minHeight: 48 }} />
        <Btn title={t('common.next')} disabled={form.detail.trim().length < 5} onPress={() => setStep(2)} style={{ flex: 1, minHeight: 48 }} />
      </View>
    </View>,

    // Step 2: seriousness toggle + review
    <View key="review" style={{ gap: 12 }}>
      <T weight="800" size={16}>{t('oci.wizard.step3')}</T>
      <Card>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{t('oci.wizard.serious_label')}</T>
              <T size={12.5} color={c.mute}>{t('oci.wizard.serious_hint')}</T>
            </View>
            <Chip label={form.serious ? t('oci.wizard.serious_yes') : t('oci.wizard.serious_no')} active={form.serious} onPress={() => setForm((f) => ({ ...f, serious: !f.serious }))} />
          </View>
        </View>
      </Card>
      <Card color={c.paper}>
        <T weight="700" size={13.5}>{t('oci.wizard.review_heading')}</T>
        <T size={13}>{KIND_ICON[form.kind]} {KIND_LABEL[form.kind]}</T>
        {form.counterparty ? <T size={13}>{form.counterparty}</T> : null}
        <T size={12.5} color={c.mute} style={{ marginTop: 4 }}>{form.detail}</T>
      </Card>
      <T size={12} color={c.mute}>{t('oci.wizard.privacy_note')}</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} onPress={() => setStep(1)} color={c.paper} ink={c.ink} style={{ minHeight: 48 }} />
        <Btn title={t('oci.wizard.submit')} loading={busy} onPress={submit} style={{ flex: 1, minHeight: 48 }} />
      </View>
    </View>,
  ];

  return (
    <View style={{ gap: 14 }}>
      <Btn
        title={`⚠️ ${t('oci.btn.declare')}`}
        onPress={() => { setDeclaring(true); setStep(0); }}
        style={{ minHeight: 52 }}
      />

      {declaring ? (
        <Card>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {[0, 1, 2].map((s) => (
              <View key={s} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: s <= step ? c.pink : c.line }} />
            ))}
          </View>
          {steps[step]}
          <Btn title={t('common.cancel')} color={c.paper} ink={c.ink} style={{ marginTop: 10, minHeight: 44 }} onPress={() => { setDeclaring(false); setStep(0); }} />
        </Card>
      ) : null}

      <Section title={t('oci.section.my_declarations')} color={c.sun}>
        {items.length ? items.map((item) => (
          <ConflictCard
            key={item.id}
            item={{ ...item, can_withdraw: item.raised_by === undefined || true }}
            canDecide={false}
            canWithdraw={item.status === 'open'}
            onWithdraw={withdraw}
            onDecide={() => {}}
          />
        )) : <Empty emoji="✅" title={t('oci.empty.official')} sub={t('oci.empty.official_sub')} />}
      </Section>

      <T size={12} color={c.mute}>{t('oci.privacy_note')}</T>
    </View>
  );
}

// ─── Organiser decision view ──────────────────────────────────────────────────

function OrganiserConflictView({ assignmentId }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/official-assignments/${assignmentId}/conflicts`), [assignmentId]);
  const [decisionTarget, setDecisionTarget] = useState(null); // { item, decision }
  const [busy, setBusy] = useState(false);

  const decide = async ({ note }) => {
    setBusy(true);
    try {
      await api.post(`/official-conflicts/${decisionTarget.item.id}/decision`, {
        decision: decisionTarget.decision,
        decision_note: note || undefined,
        row_version: decisionTarget.item.version,
      });
      toast(t(`oci.decide.done.${decisionTarget.decision}`));
      setDecisionTarget(null);
      await q.reload();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const items = q.data;
  const open = items.filter((i) => i.status === 'open');
  const decided = items.filter((i) => i.status !== 'open');

  return (
    <View style={{ gap: 14 }}>
      <Section title={`${t('oci.section.pending')} (${open.length})`} color={open.length ? c.sunSoft : c.paper}>
        {open.length ? open.map((item) => (
          <ConflictCard
            key={item.id}
            item={item}
            canDecide
            canWithdraw={false}
            onDecide={(it, dec) => setDecisionTarget({ item: it, decision: dec })}
            onWithdraw={() => {}}
          />
        )) : <Empty emoji="✅" title={t('oci.empty.organiser')} sub={t('oci.empty.organiser_sub')} />}
      </Section>

      {decided.length ? (
        <Section title={t('oci.section.decided')} color={c.paper}>
          {decided.map((item) => (
            <ConflictCard key={item.id} item={item} canDecide={false} canWithdraw={false} onDecide={() => {}} onWithdraw={() => {}} />
          ))}
        </Section>
      ) : null}

      <T size={12} color={c.mute}>{t('oci.privacy_note')}</T>

      <FormSheet
        visible={!!decisionTarget}
        onClose={() => setDecisionTarget(null)}
        title={t(`oci.decide.form_title.${decisionTarget?.decision ?? 'waive'}`)}
        submitLabel={t(`oci.decide.form_submit.${decisionTarget?.decision ?? 'waive'}`)}
        notice={decisionTarget?.decision === 'reassign' ? t('oci.decide.reassign_notice') : undefined}
        onSubmit={decide}
        fields={[{ key: 'note', label: t('oci.decide.note_label'), type: 'multiline', optional: true }]}
      />
    </View>
  );
}

// ─── Entry point (screen) ─────────────────────────────────────────────────────

/**
 * OfficialConflictInterest — mounted as a screen.
 * Props:
 *   assignmentId: UUID  — always required
 *   organiserView: bool — true = organiser decision panel
 */
export function OfficialConflictInterest({ assignmentId, organiserView }) {
  const heading = organiserView ? t('oci.heading.organiser') : t('oci.heading.official');
  const sub = organiserView ? t('oci.sub.organiser') : t('oci.sub.official');
  return (
    <Screen>
      <GradCard colors={['#8458B3', '#D0BDF4']}>
        <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6 }}>{t('oci.header_label')}</T>
        <T size={24} weight="800" color="#fff" style={{ letterSpacing: -0.6, marginTop: 4 }}>{heading}</T>
        <T size={13} color="rgba(255,255,255,0.75)" style={{ marginTop: 6 }}>{sub}</T>
      </GradCard>

      {organiserView
        ? <OrganiserConflictView assignmentId={assignmentId} />
        : <OfficialConflictView assignmentId={assignmentId} />}
    </Screen>
  );
}
