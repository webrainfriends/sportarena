// GovernanceCase — full discipline-case detail screen (#479).
// Shows sanctions, evidence, history and all panel/player actions.
// API-first: everything reads from get_governance_case; decisions, appeals and evidence writes go through capability endpoints.
// NO second case store: this is the single home for a governance case's lifecycle.
import React, { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad, useDo } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, GradCard, Loading, Screen, Section, T, Tag } from '../ui';
import { LoadError } from '../access';
import { Banner, Metric, fmtDate } from '../federation-ui';
import { MenuField } from '../menu-field';
import { Counter, DateField, DateTimeField } from '../pickers';
import { SwitchRow, Cols } from '../federation-bits';
import { EntityPicker } from '../entity-picker';
import { c, grad } from '../theme';
import { t } from '../i18n';
import { Status } from './governance';

// ------------------------------------------------------------------ constants
const OUTCOMES_DISCIPLINE = ['upheld', 'no_case'];
const OUTCOMES_WAIVER     = ['granted', 'refused'];
const OUTCOMES_APPEAL     = ['upheld', 'reduced', 'overturned', 'remitted'];
const OUTCOMES_OTHER      = ['upheld', 'no_case'];

const KIND_EMOJI = {
  discipline: '⚖️', appeal: '📋', protest: '🤝',
  eligibility_dispute: '📋', licence_issue: '🪪', waiver: '🤝',
};
const CAT_EMOJI = {
  caution: '🟨', caution_accumulation: '🟨🟨', dismissal: '🟥', violent_conduct: '🟥',
  misconduct: '⚠️', abandonment: '🚫', protest: '🤝', venue_incident: '🏟️',
  eligibility: '📋', licence: '🪪', waiver: '🤝', other: '📄',
};
const FINE_STATES = { imposed: c.sunSoft, invoiced: c.orangeSoft, paid: c.limeSoft, waived: c.violetSoft };
const FINE_COLORS = { imposed: c.sun, invoiced: c.orange, paid: c.lime, waived: c.mute };
const SANCTION_KIND_OPTIONS = [
  { value: 'match_suspension',  label: 'Match suspension' },
  { value: 'date_suspension',   label: 'Date suspension' },
  { value: 'competition_ban',   label: 'Competition ban' },
  { value: 'role_suspension',   label: 'Role suspension' },
  { value: 'fine',              label: 'Fine' },
  { value: 'points_deduction',  label: 'Points deduction' },
  { value: 'warning',           label: 'Warning' },
  { value: 'other',             label: 'Other' },
];
const CURRENCY_OPTIONS = ['EUR', 'GBP', 'USD', 'INR', 'AUD', 'CHF', 'JPY', 'BRL', 'ZAR', 'SGD', 'AED'].map((v) => ({ value: v, label: v }));
const LINK_KIND_OPTIONS = [
  { value: 'official_report',  label: t('gcase.link_report') },
  { value: 'match_event',      label: t('gcase.link_match_event') },
  { value: 'fixture',          label: t('gcase.link_fixture') },
  { value: 'gov_case',         label: t('gcase.link_other') },
];

// ------------------------------------------------------------------ helpers
const pct = (served, total) => total > 0 ? Math.min(100, Math.round((served / total) * 100)) : 0;
const daysLeft = (iso) => {
  if (!iso) return null;
  const d = Math.ceil((new Date(`${iso}T23:59:59Z`) - Date.now()) / 864e5);
  return d >= 0 ? d : null;
};

// ------------------------------------------------------------------ sub-components

function ProgressBar({ value }) {
  return (
    <View style={{ height: 6, backgroundColor: c.line, borderRadius: 999, overflow: 'hidden', marginTop: 4 }}>
      <View style={{ width: `${value}%`, height: '100%', backgroundColor: c.pink, borderRadius: 999 }} />
    </View>
  );
}

function SanctionCard({ s, isStaff, onFineAction }) {
  const superseded = !!s.superseded_at;
  const service = s.service;
  const served = service?.served ?? 0;
  const remaining = service?.remaining ?? (s.matches ?? 0);
  const total = s.matches ?? 0;
  const isBlocking = !superseded && ['interim', 'active'].includes(s.status) && ['match_suspension', 'date_suspension', 'competition_ban', 'role_suspension'].includes(s.kind) && !service?.done;

  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 12, padding: 12, marginBottom: 8, opacity: superseded ? 0.45 : 1 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <T weight="700" size={14} style={superseded ? { textDecorationLine: 'line-through' } : null}>
          {s.kind === 'match_suspension' ? '🚫' : s.kind === 'fine' ? '💰' : s.kind === 'points_deduction' ? '📉' : s.kind === 'warning' ? '⚠️' : '🛑'}{' '}
          {s.kind.replace(/_/g, ' ')}
          {total ? ` · ${total} matches` : ''}
        </T>
        <Status status={s.status} />
        {isBlocking ? <Tag label={t('gcase.blocking')} color={c.redSoft} style={{ color: c.red }} /> : null}
        {s.kind === 'fine' && s.fine_state ? <Tag label={s.fine_state} color={FINE_STATES[s.fine_state] ?? c.sunSoft} style={{ color: FINE_COLORS[s.fine_state] ?? c.sun }} /> : null}
      </View>

      {s.team_name ? <T size={13} color={c.mute} style={{ marginBottom: 4 }}>{s.team_name}{s.starts_on ? ` · From ${fmtDate(s.starts_on)}` : ''}</T> : null}
      {s.starts_on && !s.matches ? <T size={13} color={c.mute} style={{ marginBottom: 4 }}>{fmtDate(s.starts_on)}{s.ends_on ? ` → ${fmtDate(s.ends_on)}` : ''}</T> : null}

      {s.kind === 'match_suspension' && !superseded ? (
        <View style={{ marginTop: 4 }}>
          <ProgressBar value={pct(served, total)} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 }}>
            <T size={12} color={c.mute}>{t('gcase.served_of', { served, total })}</T>
            {isBlocking ? <T size={12} color={c.red} weight="700">🔴 {t('gcase.blocking')}</T> : remaining === 0 ? <T size={12} color={c.lime} weight="700">✓ {t('gcase.not_blocking')}</T> : null}
          </View>
        </View>
      ) : null}

      {s.kind === 'fine' && !superseded && isStaff ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {s.fine_state === 'imposed' ? <Btn small title={t('gcase.mark_invoiced')} color={c.limeSoft} onPress={() => onFineAction(s.id, 'invoiced')} style={{ minHeight: 36, paddingHorizontal: 14 }} /> : null}
          {s.fine_state === 'invoiced' ? <Btn small title={t('gcase.mark_paid')} color={c.limeSoft} onPress={() => onFineAction(s.id, 'paid')} style={{ minHeight: 36, paddingHorizontal: 14 }} /> : null}
          {['imposed', 'invoiced'].includes(s.fine_state) ? <Btn small title={t('gcase.waive_fine')} color={c.violetSoft} onPress={() => onFineAction(s.id, 'waived')} style={{ minHeight: 36, paddingHorizontal: 14 }} /> : null}
        </View>
      ) : null}

      {s.kind === 'points_deduction' && !superseded ? <T size={13} color={c.red} weight="700">📉 -{s.points} pts</T> : null}
      {s.reason && !superseded ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{s.reason}</T> : null}
    </View>
  );
}

function HistoryItem({ ev }) {
  const label = t(`gov.event.${ev.action}`) || ev.action.replace(/_/g, ' ');
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.pink, marginTop: 5, flexShrink: 0 }} />
      <View style={{ flex: 1 }}>
        <T size={13}>{label}{ev.detail?.outcome ? ` — ${ev.detail.outcome}` : ''}</T>
        {ev.detail?.assignee_id ? <T size={12} color={c.mute}>Assigned to panel</T> : null}
      </View>
      <T size={11} color={c.mute}>{ev.created_at ? new Date(ev.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</T>
    </View>
  );
}

function EvidenceRow({ lk, onPress }) {
  const icon = lk.entity_type === 'official_report' ? '📄' : lk.entity_type === 'match_event' ? '⚽' : lk.entity_type === 'fixture' ? '🏟️' : '🔗';
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 4 }}>
      <T size={18}>{icon}</T>
      <View style={{ flex: 1 }}>
        <T size={14} weight="600">{lk.entity_type.replace(/_/g, ' ')}</T>
        <T size={12} color={c.mute}>{lk.entity_id?.slice(0, 12)}…</T>
      </View>
      <T size={18} color={c.mute}>›</T>
    </Pressable>
  );
}

// ------------------------------------------------------------------ sheets

function AssignSheet({ caseId, onDone, onClose }) {
  const [assigneeId, setAssigneeId] = useState('');
  const [hearingAt, setHearingAt] = useState(null);
  const { run, loading, error } = useDo();
  const submit = () => run(async () => {
    await api.post(`/governance/cases/${caseId}/assign`, { assignee_id: assigneeId, hearing_at: hearingAt ?? undefined });
    onDone();
  });
  return (
    <View style={{ gap: 14, padding: 16 }}>
      <T size={18} weight="800">{t('gcase.assign_title')}</T>
      <EntityPicker kind="user" label="Assign to" value={assigneeId} onChange={setAssigneeId} />
      <DateTimeField label={t('gcase.hearing_at')} value={hearingAt} onChange={setHearingAt} />
      {error ? <T size={13} color={c.red}>{error.message}</T> : null}
      <Btn title={t('gcase.assign_ok')} onPress={submit} loading={loading} style={{ minHeight: 52 }} />
    </View>
  );
}

function DecisionSheet({ k, onDone }) {
  const isAppeal = k.kind === 'appeal';
  const outcomeOptions = isAppeal ? OUTCOMES_APPEAL : k.kind === 'waiver' ? OUTCOMES_WAIVER : OUTCOMES_DISCIPLINE;
  const [outcome, setOutcome] = useState('');
  const [reason, setReason] = useState('');
  const [sanctions, setSanctions] = useState([]);
  const [reducedMatches, setReducedMatches] = useState(1);
  const [pub, setPub] = useState(false);
  const { run, loading, error } = useDo();

  const addSanction = () => setSanctions((p) => [...p, { kind: 'warning', matches: 1, team_id: '', starts_on: '', ends_on: '', amount_minor: '', currency: 'EUR', points: 1, public: false, reason: '' }]);
  const updateSanction = (idx, patch) => setSanctions((p) => p.map((s, i) => i === idx ? { ...s, ...patch } : s));
  const removeSanction = (idx) => setSanctions((p) => p.filter((_, i) => i !== idx));

  const submit = () => run(async () => {
    if (!outcome) throw new Error('Choose an outcome');
    if (reason.trim().length < 3) throw new Error('Reason must be at least 3 characters');
    const body = isAppeal
      ? { expected_version: k.row_version, outcome, reason, ...(outcome === 'reduced' ? { reduced_matches: reducedMatches } : {}) }
      : { expected_version: k.row_version, outcome, reason, sanctions: sanctions.map((s) => ({ ...s, amount_minor: s.amount_minor ? parseInt(s.amount_minor, 10) : undefined, public: pub })) };
    const ep = isAppeal ? `/governance/appeals/${k.id}/decision` : `/governance/cases/${k.id}/decision`;
    await api.post(ep, body);
    onDone();
  });

  return (
    <ScrollView style={{ maxHeight: 600 }}>
      <View style={{ gap: 14, padding: 16 }}>
        <T size={18} weight="800">{isAppeal ? t('gcase.appeal_decision_title') : t('gcase.decide_title')}</T>
        <MenuField label={t('gcase.outcome_label')} value={outcome} onChange={setOutcome} options={outcomeOptions.map((v) => ({ value: v, label: t(`gcase.outcome.${v}`) }))} />
        <View>
          <T size={12} color={c.mute} style={{ marginBottom: 4, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('gcase.reason_label')}</T>
          <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12, minHeight: 80 }}>
            <T size={14} onPress={undefined}>{reason || <T color={c.mute}>Provide reasons for the decision…</T>}</T>
          </View>
        </View>
        {!isAppeal && outcome === 'upheld' ? (
          <View style={{ gap: 8 }}>
            <T size={13} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('gcase.sanctions_heading')}</T>
            {sanctions.map((s, idx) => (
              <Card key={idx} style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <MenuField label={t('gcase.sanction_kind_label')} value={s.kind} onChange={(v) => updateSanction(idx, { kind: v })} options={SANCTION_KIND_OPTIONS} style={{ flex: 1 }} />
                  <Pressable onPress={() => removeSanction(idx)} accessibilityLabel="Remove sanction" style={{ padding: 8 }}><T size={18} color={c.mute}>✕</T></Pressable>
                </View>
                {s.kind === 'match_suspension' ? <Counter label={t('gcase.matches_label')} value={s.matches} onChange={(v) => updateSanction(idx, { matches: v })} min={1} max={100} /> : null}
                {s.kind === 'match_suspension' ? <EntityPicker kind="team" label={t('gcase.team_label')} value={s.team_id} onChange={(v) => updateSanction(idx, { team_id: v })} /> : null}
                {['date_suspension', 'competition_ban', 'role_suspension'].includes(s.kind) ? (
                  <View style={{ gap: 8 }}>
                    <DateField label={t('gcase.starts_on')} value={s.starts_on} onChange={(v) => updateSanction(idx, { starts_on: v })} />
                    <DateField label={t('gcase.ends_on')} value={s.ends_on} onChange={(v) => updateSanction(idx, { ends_on: v })} />
                  </View>
                ) : null}
                {s.kind === 'fine' ? (
                  <View style={{ gap: 8 }}>
                    <View>
                      <T size={12} color={c.mute} style={{ marginBottom: 4, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('gcase.fine_amount')}</T>
                      <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 10 }}>
                        <T size={14}>{s.amount_minor || <T color={c.mute}>Amount (minor units)</T>}</T>
                      </View>
                    </View>
                    <MenuField label={t('gcase.fine_currency')} value={s.currency} onChange={(v) => updateSanction(idx, { currency: v })} options={CURRENCY_OPTIONS} />
                  </View>
                ) : null}
                {s.kind === 'points_deduction' ? (
                  <Counter label={t('gcase.points_label')} value={s.points} onChange={(v) => updateSanction(idx, { points: v })} min={1} max={100} />
                ) : null}
                <SwitchRow label={t('gcase.public_label')} value={s.public} onChange={(v) => updateSanction(idx, { public: v })} />
              </Card>
            ))}
            <Btn small title={`+ ${t('gcase.add_sanction')}`} color={c.violetSoft} onPress={addSanction} style={{ minHeight: 44 }} />
            <SwitchRow label={t('gcase.public_label')} value={pub} onChange={setPub} />
          </View>
        ) : null}
        {isAppeal && outcome === 'reduced' ? (
          <Counter label={t('gcase.reduced_matches')} value={reducedMatches} onChange={setReducedMatches} min={1} max={99} />
        ) : null}
        {error ? <T size={13} color={c.red}>{error.message}</T> : null}
        <Btn title={t('gcase.submit_decision')} onPress={submit} loading={loading} style={{ minHeight: 52 }} />
      </View>
    </ScrollView>
  );
}

function AppealSheet({ k, onDone }) {
  const [grounds, setGrounds] = useState('');
  const { run, loading, error } = useDo();
  const submit = () => run(async () => {
    if (grounds.trim().length < 10) throw new Error('Grounds must be at least 10 characters');
    await api.post(`/governance/cases/${k.id}/appeal`, { grounds });
    onDone();
  });
  return (
    <View style={{ gap: 14, padding: 16 }}>
      <T size={18} weight="800">{t('gcase.appeal_title')}</T>
      <T size={13} color={c.mute}>{t('gov.disc.interimNote')}</T>
      <View>
        <T size={12} color={c.mute} style={{ marginBottom: 4, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('gcase.grounds_label')}</T>
        <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12, minHeight: 100 }}>
          <T size={14}>{grounds || <T color={c.mute}>{t('gcase.grounds_placeholder')}</T>}</T>
        </View>
      </View>
      {error ? <T size={13} color={c.red}>{error.message}</T> : null}
      <Btn title={t('gcase.submit_appeal')} onPress={submit} loading={loading} style={{ minHeight: 52 }} />
    </View>
  );
}

function ReviewFlagSheet({ k, onDone }) {
  const [note, setNote] = useState('');
  const { run: runStand, loading: ls } = useDo();
  const { run: runWith, loading: lw } = useDo();
  const stand = () => runStand(async () => { await api.post(`/governance/cases/${k.id}/review-flag`, { action: 'confirm' }); onDone(); });
  const withdraw = () => runWith(async () => { await api.post(`/governance/cases/${k.id}/review-flag`, { action: 'withdraw' }); onDone(); });
  return (
    <View style={{ gap: 14, padding: 16 }}>
      <T size={18} weight="800">{t('gcase.review_title')}</T>
      <T size={13} color={c.mute}>{t('gcase.review_detail')}</T>
      <View>
        <T size={12} color={c.mute} style={{ marginBottom: 4, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('gcase.review_reason')}</T>
        <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12, minHeight: 60 }}>
          <T size={14}>{note || <T color={c.mute}>Optional note…</T>}</T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn title={t('gcase.confirm_stands')} color={c.limeSoft} onPress={stand} loading={ls} style={{ flex: 1, minHeight: 52 }} />
        <Btn title={t('gcase.withdraw_case')} color={c.sunSoft} onPress={withdraw} loading={lw} style={{ flex: 1, minHeight: 52 }} />
      </View>
    </View>
  );
}

function AddEvidenceSheet({ k, onDone }) {
  const [kind, setKind] = useState('official_report');
  const [entityId, setEntityId] = useState('');
  const { run, loading, error } = useDo();
  const submit = () => run(async () => {
    if (!entityId.trim()) throw new Error('Enter an entity ID');
    await api.post(`/governance/cases/${k.id}/evidence`, { entity_type: kind, entity_id: entityId });
    onDone();
  });
  return (
    <View style={{ gap: 14, padding: 16 }}>
      <T size={18} weight="800">{t('gcase.add_evidence')}</T>
      <MenuField label={t('gcase.evidence_kind')} value={kind} onChange={setKind} options={LINK_KIND_OPTIONS} />
      <View>
        <T size={12} color={c.mute} style={{ marginBottom: 4, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 }}>ID</T>
        <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 10 }}>
          <T size={14}>{entityId || <T color={c.mute}>Paste the record ID…</T>}</T>
        </View>
      </View>
      {error ? <T size={13} color={c.red}>{error.message}</T> : null}
      <Btn title={t('gcase.add_evidence')} onPress={submit} loading={loading} style={{ minHeight: 52 }} />
    </View>
  );
}

// ------------------------------------------------------------------ main screen

export function GovernanceCase({ id: caseId }) {
  const { go } = useNav();
  const { user } = useSession();
  const { tablet } = useLayout();
  const kase = useLoad(() => api.get(`/governance/cases/${caseId}`), [caseId]);
  const { run: runFine } = useDo();

  const [sheet, setSheet] = useState(null); // 'decide' | 'appeal' | 'assign' | 'review' | 'evidence'

  if (kase.error) return <LoadError error={kase.error} retry={kase.reload} />;
  if (!kase.data) return <Loading />;

  const k = kase.data;
  const isStaff = !!k.can_decide;
  const isSubject = user?.id === k.subject_user_id;
  const appealOpen = !!k.appeal_open;
  const dLeft = daysLeft(k.appeal_deadline);
  const catEmoji = CAT_EMOJI[k.category] ?? KIND_EMOJI[k.kind] ?? '📋';
  const sanctions = k.sanctions ?? [];
  const activeSanctions = sanctions.filter((s) => !s.superseded_at && ['interim', 'active', 'stayed'].includes(s.status));
  const supersededSanctions = sanctions.filter((s) => !!s.superseded_at || s.status === 'overturned' || s.status === 'served');

  const onFineAction = (sId, state) => runFine(async () => {
    await api.post(`/discipline/sanctions/${sId}/fine-state`, { state });
    kase.reload();
  });

  // Action bar: context-sensitive
  const ActionBar = () => {
    if (isStaff && k.needs_review) {
      return (
        <View style={[{ flexDirection: 'row', gap: 10, padding: 16, backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.line }, tablet ? {} : { position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
          <Btn title={t('gcase.review_title')} color={c.sunSoft} onPress={() => setSheet('review')} style={{ flex: 1, minHeight: 52 }} />
        </View>
      );
    }
    if (isStaff && k.kind === 'appeal' && ['received', 'under_review'].includes(k.status)) {
      return (
        <View style={[{ flexDirection: 'row', gap: 10, padding: 16, backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.line }, tablet ? {} : { position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
          <Btn title={t('gcase.assign_btn')} color={c.violetSoft} onPress={() => setSheet('assign')} style={{ flex: 1, minHeight: 52 }} />
          <Btn title={t('gcase.appeal_btn') + ' → Decide'} onPress={() => setSheet('decide')} style={{ flex: 1, minHeight: 52 }} />
        </View>
      );
    }
    if (isStaff && ['received', 'under_review', 'interim'].includes(k.status)) {
      return (
        <View style={[{ flexDirection: 'row', gap: 10, padding: 16, backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.line }, tablet ? {} : { position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
          <Btn title={t('gcase.assign_btn')} color={c.violetSoft} onPress={() => setSheet('assign')} style={{ flex: 1, minHeight: 52 }} />
          <Btn title={t('gcase.decide_btn')} onPress={() => setSheet('decide')} style={{ flex: 1, minHeight: 52 }} />
        </View>
      );
    }
    if (!isStaff && appealOpen && (isSubject || k.appeal_open)) {
      return (
        <View style={[{ flexDirection: 'row', gap: 10, padding: 16, backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.line }, tablet ? {} : { position: 'absolute', bottom: 0, left: 0, right: 0 }]}>
          <Btn title={t('gcase.appeal_btn')} onPress={() => setSheet('appeal')} style={{ flex: 1, minHeight: 52 }} />
        </View>
      );
    }
    return null;
  };

  const MainContent = () => (
    <View style={{ gap: 0 }}>
      {/* Interim banner */}
      {k.status === 'interim' ? (
        <Banner tone="orange" icon="⏸" style={{ margin: 12, marginBottom: 0 }}>
          <T size={13} weight="700" color={c.orange}>{t('gcase.interim_banner')}</T>
          <T size={12} color={c.orange}>{t('gcase.interim_detail')}</T>
        </Banner>
      ) : null}

      {/* Source-corrected review flag */}
      {k.needs_review ? (
        <Banner tone="sun" icon="⚠️" style={{ margin: 12, marginBottom: 0 }}>
          <T size={13} weight="700" color={c.sun}>{t('gov.disc.needsReview')}</T>
          <T size={12} color={c.sun}>{t('gcase.review_detail')}</T>
        </Banner>
      ) : null}

      {/* Metric strip */}
      <View style={{ flexDirection: 'row', flexWrap: 'nowrap', gap: 8, paddingHorizontal: 12, paddingVertical: 10, overflow: 'scroll' }}>
        {activeSanctions.length > 0 ? <Metric value={activeSanctions.length} label={t('disc.m_sanctions')} accent={c.red} /> : null}
        {k.appeal_deadline ? <Metric value={dLeft != null ? `${dLeft}d` : '—'} label={t('disc.appeal_deadline')} accent={c.sun} /> : null}
        {k.hearing_at ? <Metric value={new Date(k.hearing_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} label={t('gcase.hearing_scheduled')} accent={c.violet} /> : null}
        {k.assigned_to ? <Metric value="●" label={t('gcase.assigned_to')} accent={c.cyan} /> : null}
      </View>

      {/* Subject */}
      <Section title={t('gcase.subject')} style={{ marginHorizontal: 12 }}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <T size={16} weight="800" color={c.pink}>{(k.subject_name ?? '?').charAt(0).toUpperCase()}</T>
            </View>
            <View style={{ flex: 1 }}>
              {k.subject_is_youth && !isSubject && !isStaff
                ? <T size={14} weight="700" color={c.mute}>{t('gcase.youth_private')}</T>
                : <T size={15} weight="800">{k.subject_name ?? '—'}</T>}
              <T size={13} color={c.mute}>{k.subject_role ?? ''}</T>
            </View>
            {k.policy_version ? <Tag label={`v${k.policy_version}`} color={c.violetSoft} style={{ color: c.violet }} /> : null}
          </View>
          {k.stay ? <Banner tone="sun" icon="⏸" style={{ marginTop: 8 }}><T size={12} color={c.sun}>{t('gcase.stay_note')}</T></Banner> : null}
          {k.decision ? <View style={{ marginTop: 8, backgroundColor: k.outcome === 'upheld' ? c.limeSoft : c.violetSoft, borderRadius: 10, padding: 10 }}><T size={13} color={k.outcome === 'upheld' ? c.lime : c.mute}>{k.decision}</T></View> : null}
        </Card>
      </Section>

      {/* Appeal open CTA */}
      {!isStaff && appealOpen ? (
        <View style={{ marginHorizontal: 12, marginTop: 10, backgroundColor: c.limeSoft, borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T size={18}>📋</T>
          <View style={{ flex: 1 }}>
            <T size={14} weight="800" color={c.lime}>{t('gcase.appeal_open')}</T>
            {dLeft != null ? <T size={12} color={c.mute}>{t('gcase.days_remaining', { n: dLeft })}</T> : null}
          </View>
        </View>
      ) : null}

      {/* Sanctions */}
      {sanctions.length > 0 ? (
        <Section title={`${t('gcase.sanctions_heading')} (${sanctions.length})`} style={{ marginHorizontal: 12 }}>
          <Card>
            {activeSanctions.map((s) => <SanctionCard key={s.id} s={s} isStaff={isStaff} onFineAction={onFineAction} />)}
            {supersededSanctions.map((s) => <SanctionCard key={s.id} s={s} isStaff={isStaff} onFineAction={onFineAction} />)}
          </Card>
        </Section>
      ) : null}
    </View>
  );

  const RightContent = () => (
    <View style={{ gap: 0 }}>
      {/* Evidence */}
      <Section title={t('gcase.evidence_heading')} style={{ marginHorizontal: 12 }}>
        <Card>
          {k.links?.length > 0
            ? k.links.map((lk) => (
                <EvidenceRow key={lk.entity_id} lk={lk} onPress={() => {
                  if (lk.entity_type === 'official_report') go('OfficialReportDetail', { id: lk.entity_id });
                  else if (lk.entity_type === 'gov_case') go('GovernanceCase', { id: lk.entity_id });
                }} />
              ))
            : <T size={13} color={c.mute}>{t('gcase.no_evidence')}</T>}
          <Pressable onPress={() => setSheet('evidence')} accessibilityRole="button" style={{ marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: c.violetSoft, alignItems: 'center', minHeight: 44 }}>
            <T size={13} weight="700" color={c.mute}>+ {t('gcase.add_evidence')}</T>
          </Pressable>
        </Card>
      </Section>

      {/* Policy card */}
      {k.policy ? (
        <Section title={`${t('gov.disc.policy')} v${k.policy.version}`} style={{ marginHorizontal: 12 }}>
          <Card>
            <T size={12} color={c.mute} style={{ lineHeight: 20 }}>{JSON.stringify(k.policy.rules, null, 0)?.slice(0, 300)}</T>
          </Card>
        </Section>
      ) : null}

      {/* History */}
      <Section title={t('gcase.history_heading')} style={{ marginHorizontal: 12 }}>
        <Card>
          {(k.events ?? []).map((ev, i) => <HistoryItem key={i} ev={ev} />)}
        </Card>
      </Section>

      {tablet ? <ActionBar /> : null}
    </View>
  );

  return (
    <Screen onRefresh={kase.reload} refreshing={kase.loading} style={{ paddingBottom: tablet ? 0 : 100 }}>
      {/* Hero */}
      <GradCard grad={grad.hero} style={{ margin: 0, borderRadius: 0, paddingHorizontal: 16, paddingVertical: 20 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
          <Tag label={`${KIND_EMOJI[k.kind] ?? '⚖️'} ${t(`disc.kind.${k.kind}`) ?? k.kind}`} color="rgba(255,255,255,.18)" style={{ color: '#fff' }} />
          <Status status={k.status} />
          {k.auto ? <Tag label={t('disc.auto_triggered')} color="rgba(96,165,250,.22)" style={{ color: '#BFDBFE' }} /> : null}
          {k.needs_review ? <Tag label={t('disc.needs_review')} color="rgba(251,191,36,.22)" style={{ color: '#FDE68A' }} /> : null}
        </View>
        <T size={11} weight="700" color="rgba(255,255,255,.65)" style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>
          {t('gcase.ref')} #{k.id?.slice(0, 8)} · {t('gcase.policy_v', { v: k.policy_version ?? '—' })}
        </T>
        <T size={22} weight="800" color="#fff" style={{ letterSpacing: -0.4, lineHeight: 26, marginBottom: 4 }}>
          {catEmoji} {k.category?.replace(/_/g, ' ') ?? k.kind}
        </T>
        <T size={13} color="rgba(255,255,255,.85)">{k.competition_name ?? k.sport_id ?? ''}</T>
      </GradCard>

      {tablet ? (
        <Cols>
          <View style={{ borderRightWidth: 1, borderRightColor: c.line }}>
            <MainContent />
          </View>
          <RightContent />
        </Cols>
      ) : (
        <View>
          <MainContent />
          <RightContent />
        </View>
      )}

      {/* Sheet overlays */}
      {sheet === 'decide' ? (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 20 }}>
          <Pressable onPress={() => setSheet(null)} accessibilityLabel="Close" style={{ alignSelf: 'center', width: 36, height: 4, backgroundColor: c.line, borderRadius: 2, margin: 10 }} />
          <DecisionSheet k={k} onDone={() => { setSheet(null); kase.reload(); }} />
        </View>
      ) : null}
      {sheet === 'appeal' ? (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 20 }}>
          <Pressable onPress={() => setSheet(null)} accessibilityLabel="Close" style={{ alignSelf: 'center', width: 36, height: 4, backgroundColor: c.line, borderRadius: 2, margin: 10 }} />
          <AppealSheet k={k} onDone={() => { setSheet(null); kase.reload(); }} />
        </View>
      ) : null}
      {sheet === 'assign' ? (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 20 }}>
          <Pressable onPress={() => setSheet(null)} accessibilityLabel="Close" style={{ alignSelf: 'center', width: 36, height: 4, backgroundColor: c.line, borderRadius: 2, margin: 10 }} />
          <AssignSheet caseId={k.id} onDone={() => { setSheet(null); kase.reload(); }} onClose={() => setSheet(null)} />
        </View>
      ) : null}
      {sheet === 'review' ? (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 20 }}>
          <Pressable onPress={() => setSheet(null)} accessibilityLabel="Close" style={{ alignSelf: 'center', width: 36, height: 4, backgroundColor: c.line, borderRadius: 2, margin: 10 }} />
          <ReviewFlagSheet k={k} onDone={() => { setSheet(null); kase.reload(); }} />
        </View>
      ) : null}
      {sheet === 'evidence' ? (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 20 }}>
          <Pressable onPress={() => setSheet(null)} accessibilityLabel="Close" style={{ alignSelf: 'center', width: 36, height: 4, backgroundColor: c.line, borderRadius: 2, margin: 10 }} />
          <AddEvidenceSheet k={k} onDone={() => { setSheet(null); kase.reload(); }} />
        </View>
      ) : null}

      {!tablet ? <ActionBar /> : null}
    </Screen>
  );
}
