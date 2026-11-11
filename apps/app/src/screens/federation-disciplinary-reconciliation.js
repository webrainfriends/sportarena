// Federation Disciplinary Reconciliation (#1026 / REF-R28): staged disciplinary import, needs_review queue,
// side-by-side review panel, conflict resolution, append-only timeline.
// No data touches gov_cases / disc_sanctions until a reviewer explicitly accepts.
// Accessible on iOS, iPadOS, Android and web. No web-only APIs. RTL-safe (start/end throughout).
import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView, AccessibilityInfo } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, r } from '../theme';
import { Metric, StatusTag, fmtDate } from '../federation-ui';
import { Cols } from '../federation-bits';
import { MenuField } from '../menu-field';
import { DateField } from '../pickers';
import { t } from '../i18n';

// ------------------------------------------------------------------ constants
const DISC_STATUS_COLOR = { pending: c.sunSoft, matched: c.cyanSoft, conflict: c.orangeSoft, accepted: c.mintSoft, rejected: c.paper, disputed: c.pinkSoft, manual_review: c.violetSoft };
const DISC_STATUS_LABEL = { pending: t('fed.disc.pending'), matched: t('fed.disc.matched'), conflict: t('fed.disc.conflict'), accepted: t('fed.disc.accepted'), rejected: t('fed.disc.rejected'), disputed: t('fed.disc.disputed'), manual_review: t('fed.disc.manualReview') };
const CONFLICT_LABEL = { outcome_conflict: t('fed.discConflict.outcomeMismatch'), sanction_mismatch: t('fed.discConflict.sanctionMismatch'), duplicate: t('fed.discConflict.duplicate'), unknown_category: t('fed.discConflict.unknownCategory'), identity_ambiguous: t('fed.discConflict.identityAmbiguous') };
const KIND_COLOR = { discipline: c.orangeSoft, appeal: c.cyanSoft, eligibility_dispute: c.pinkSoft, protest: c.sunSoft, licence_issue: c.violetSoft, waiver: c.mintSoft };
const SANCTION_COLOR = { warning: c.sunSoft, match_suspension: c.orangeSoft, date_suspension: c.orangeSoft, competition_ban: c.redSoft, role_suspension: c.pinkSoft, fine: c.violetSoft, points_deduction: c.cyanSoft, other: c.paper };

// ------------------------------------------------------------------ StagedDiscRow
function StagedDiscRow({ sd, isNeedsReview, onReview }) {
  const accent = isNeedsReview ? c.pinkSoft : DISC_STATUS_COLOR[sd.status] ?? c.paper;
  return (
    <Pressable onPress={() => onReview(sd, isNeedsReview)} accessibilityRole="button"
      accessibilityLabel={`${sd.subject_name ?? t('fed.staged.unmatched')}, ${sd.mapped_kind ?? sd.external_kind}, ${isNeedsReview ? t('fed.disc.needsReview') : DISC_STATUS_LABEL[sd.status]}`}>
      <Card color={accent} style={{ marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1, gap: 3 }}>
            {isNeedsReview ? <T size={11} color={c.pink} weight="700">🔔 {t('fed.disc.needsReview')}</T> : null}
            <T size={14} weight="700">{sd.subject_name ?? (sd.matched_user_id ? `🔒 ${t('fed.staged.matched')}` : `🔒 ${t('fed.staged.unmatched')}`)}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
              {sd.mapped_kind ? <Tag label={sd.mapped_kind.replace(/_/g, ' ')} color={KIND_COLOR[sd.mapped_kind] ?? c.paper} /> : null}
              {sd.mapped_sanction_kind ? <Tag label={sd.mapped_sanction_kind.replace(/_/g, ' ')} color={SANCTION_COLOR[sd.mapped_sanction_kind] ?? c.paper} /> : null}
            </View>
            {sd.incident_date ? <T size={11} color={c.mute}>{t('fed.disc.incident')}: {sd.incident_date}{sd.decided_date ? ` · ${t('fed.disc.decided')}: ${sd.decided_date}` : ''}</T> : null}
            {sd.external_ref ? <T size={11} color={c.mute}>{t('fed.staged.externalRef')}: {sd.external_ref}</T> : null}
            {sd.conflict_type ? <T size={11} color={c.orange}>⚠️ {CONFLICT_LABEL[sd.conflict_type] ?? sd.conflict_type}</T> : null}
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            {!isNeedsReview ? <Tag label={DISC_STATUS_LABEL[sd.status]} color={DISC_STATUS_COLOR[sd.status]} /> : null}
            {sd.outcome ? <T size={11} color={c.mute}>{sd.outcome}</T> : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

// ------------------------------------------------------------------ ReviewSheet (single staged / needs_review record)
function ReviewSheet({ sd, isNeedsReview, onClose, onDone }) {
  const [action, setAction] = useState(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { wide } = useLayout();

  const submit = useCallback(async (chosen) => {
    setLoading(true); setError(null);
    try {
      if (isNeedsReview) {
        // Clearing needs_review on existing gov_case
        await api.post(`/federation-cases/${sd.id}/clear-review`, { review_note: note || undefined, action: chosen });
      } else {
        await api.post(`/federation-staged-disciplinary/${sd.id}/review`, { action: chosen, review_note: note || undefined });
      }
      AccessibilityInfo.announceForAccessibility(t('fed.disc.reviewDone'));
      onDone();
    } catch (e) { setError(e.message ?? t('error.generic')); }
    finally { setLoading(false); }
  }, [sd?.id, isNeedsReview, note, onDone]);

  const isDecided = !isNeedsReview && ['accepted','rejected'].includes(sd?.status);
  const panelStyle = wide ? { flexDirection: 'row', gap: 12 } : { flexDirection: 'column', gap: 12 };

  return (
    <Sheet onClose={onClose} title={isNeedsReview ? t('fed.disc.reviewCaseTitle') : t('fed.disc.reviewStagedTitle')}>
      {sd ? (
        <View style={{ gap: 14 }}>
          <View style={panelStyle}>
            {/* Incoming / staged side */}
            <Card color={isNeedsReview ? c.pinkSoft : c.cyanSoft} style={{ flex: 1 }}>
              <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{isNeedsReview ? t('fed.disc.existingCase') : t('fed.staged.incoming')}</T>
              <T size={15} weight="700">{sd.subject_name ?? `🔒 ${t('fed.staged.unmatched')}`}</T>
              {sd.mapped_kind ? <T size={13} color={c.mute}>{t('fed.disc.kind')}: {sd.external_kind ?? '—'}{sd.mapped_kind ? ` → ${sd.mapped_kind}` : ''}</T> : null}
              {sd.mapped_sanction_kind ? <T size={13} color={c.mute}>{t('fed.disc.sanction')}: {sd.external_sanction_kind ?? '—'} → {sd.mapped_sanction_kind}</T> : null}
              {sd.incident_date ? <T size={12} color={c.mute}>{t('fed.disc.incident')}: {sd.incident_date}</T> : null}
              {sd.decided_date ? <T size={12} color={c.mute}>{t('fed.disc.decided')}: {sd.decided_date}</T> : null}
              {sd.outcome ? <T size={12} color={c.mute}>{t('fed.disc.outcome')}: {sd.outcome}</T> : null}
              {sd.sanction_detail ? (
                Object.entries(sd.sanction_detail).map(([k, v]) => (
                  <T key={k} size={11} color={c.mute}>{k.replace(/_/g, ' ')}: {String(v)}</T>
                ))
              ) : null}
              {sd.match_confidence ? <T size={12} color={sd.match_confidence === 'confirmed' ? c.lime : c.sun}>{t('fed.staged.match')}: {sd.match_confidence}</T> : null}
              {isNeedsReview && sd.review_reason ? <T size={12} color={c.orange}>📌 {sd.review_reason}</T> : null}
            </Card>

            {/* Existing platform record (if any) */}
            {(sd.existing_case_id || sd.existing_sanction_id) ? (
              <Card color={c.violetSoft} style={{ flex: 1 }}>
                <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{t('fed.disc.platformRecord')}</T>
                {sd.existing_case_summary ? (
                  <>
                    <T size={14} weight="700">{sd.existing_case_summary.case_number}</T>
                    <T size={13} color={c.mute}>{t('fed.disc.kind')}: {sd.existing_case_summary.kind}</T>
                    <T size={12} color={c.mute}>{t('fed.disc.outcome')}: {sd.existing_case_summary.outcome ?? '—'}</T>
                    <T size={11} color={c.mute}>{fmtDate(sd.existing_case_summary.created_at)}</T>
                  </>
                ) : (
                  <T size={13} color={c.mute}>{t('fed.disc.existingCaseRef')}: {sd.existing_case_id ?? sd.existing_sanction_id}</T>
                )}
              </Card>
            ) : null}
          </View>

          {/* Conflict banner */}
          {sd.conflict_type ? (
            <Card color={c.orangeSoft}>
              <T size={13} weight="700">⚠️ {CONFLICT_LABEL[sd.conflict_type]}</T>
              {sd.conflict_detail ? Object.entries(sd.conflict_detail).map(([k, v]) => (
                <T key={k} size={12} color={c.mute}>{k.replace(/_/g, ' ')}: {String(v)}</T>
              )) : null}
            </Card>
          ) : null}

          {/* Identity warning */}
          {!sd.matched_user_id ? (
            <Card color={c.sunSoft}><T size={13}>🔒 {t('fed.staged.noMatchWarning')}</T></Card>
          ) : sd.match_confidence !== 'confirmed' ? (
            <Card color={c.sunSoft}><T size={13}>⚠️ {t('fed.staged.probableMatchWarning')}</T></Card>
          ) : null}

          {!isDecided ? (
            <>
              <Field label={t('fed.disc.reviewNote')} value={note} onChange={setNote} multiline placeholder={t('fed.disc.reviewNotePlaceholder')} />
              {error ? <T size={13} color={c.red}>{error}</T> : null}
              <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                {isNeedsReview ? (
                  <>
                    <Btn label={t('fed.disc.clearReview')} disabled={loading} color={c.lime} onPress={() => submit('clear')} accessibilityLabel={t('fed.disc.clearReviewA11y')} />
                    <Btn label={t('fed.disc.flagEscalate')} disabled={loading} color={c.orangeSoft} onPress={() => submit('escalate')} />
                  </>
                ) : (
                  <>
                    <Btn
                      label={t('fed.disc.accept')}
                      disabled={loading || !sd.matched_user_id || sd.match_confidence !== 'confirmed'}
                      color={c.lime} onPress={() => submit('accept')}
                      accessibilityLabel={t('fed.disc.acceptA11y')} />
                    <Btn label={t('fed.disc.reject')} disabled={loading} color={c.orangeSoft} onPress={() => submit('reject')} />
                    <Btn label={t('fed.disc.flagManual')} disabled={loading} color={c.violetSoft} onPress={() => submit('flag_manual')} />
                  </>
                )}
              </View>
            </>
          ) : (
            <Card color={DISC_STATUS_COLOR[sd.status]}>
              <T size={14} weight="700">{DISC_STATUS_LABEL[sd.status]}</T>
              {sd.review_note ? <T size={12} color={c.mute}>{sd.review_note}</T> : null}
              {sd.reviewed_at ? <T size={11} color={c.mute}>{fmtDate(sd.reviewed_at)} · {sd.reviewed_by_name}</T> : null}
            </Card>
          )}
        </View>
      ) : <Loading />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ ConflictResolutionSheet (disciplinary)
function ConflictResolutionSheet({ sd, onClose, onDone }) {
  const [resolution, setResolution] = useState(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const resolve = useCallback(async () => {
    if (!resolution) return;
    setLoading(true); setError(null);
    try {
      await api.post(`/federation-reconciliation-conflicts/${sd.id}/resolve`, { conflict_kind: 'disciplinary', resolution, note: note || undefined });
      onDone();
    } catch (e) { setError(e.message ?? t('error.generic')); }
    finally { setLoading(false); }
  }, [sd?.id, resolution, note, onDone]);

  if (!sd) return null;
  return (
    <Sheet onClose={onClose} title={t('fed.discConflict.resolveTitle')}>
      <View style={{ gap: 14 }}>
        <T size={15} weight="700">⚠️ {CONFLICT_LABEL[sd.conflict_type] ?? sd.conflict_type}</T>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Card color={c.cyanSoft} style={{ flex: 1 }}>
            <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{t('fed.staged.incoming')}</T>
            <T size={14} weight="700">{sd.external_kind ?? '—'} → {sd.mapped_kind ?? '?'}</T>
            {sd.mapped_sanction_kind ? <T size={12} color={c.mute}>{sd.mapped_sanction_kind}</T> : null}
            {sd.outcome ? <T size={12} color={c.mute}>{t('fed.disc.outcome')}: {sd.outcome}</T> : null}
          </Card>
          {sd.existing_case_id ? (
            <Card color={c.violetSoft} style={{ flex: 1 }}>
              <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{t('fed.disc.platformRecord')}</T>
              {sd.existing_case_summary ? (
                <>
                  <T size={14} weight="700">{sd.existing_case_summary.kind}</T>
                  <T size={12} color={c.mute}>{sd.existing_case_summary.outcome ?? '—'}</T>
                </>
              ) : <T size={12} color={c.mute}>{sd.existing_case_id}</T>}
            </Card>
          ) : null}
        </View>

        <T size={14} weight="700">{t('fed.conflict.chooseResolution')}</T>
        <View style={{ gap: 8 }}>
          {[
            { value: 'keep_platform', label: t('fed.conflict.keepPlatform'), desc: t('fed.discConflict.keepPlatformDesc'), color: c.violetSoft },
            { value: 'adopt_external', label: t('fed.conflict.adoptExternal'), desc: t('fed.discConflict.adoptExternalDesc'), color: c.cyanSoft },
            { value: 'escalate', label: t('fed.conflict.escalate'), desc: t('fed.discConflict.escalateDesc'), color: c.sunSoft },
          ].map(opt => (
            <Pressable key={opt.value} onPress={() => setResolution(opt.value)} accessibilityRole="radio" accessibilityState={{ selected: resolution === opt.value }}>
              <Card color={resolution === opt.value ? opt.color : c.paper} style={{ borderWidth: resolution === opt.value ? 2 : 0, borderColor: c.pink }}>
                <T size={14} weight="700">{resolution === opt.value ? '● ' : '○ '}{opt.label}</T>
                <T size={12} color={c.mute}>{opt.desc}</T>
              </Card>
            </Pressable>
          ))}
        </View>
        <Field label={t('fed.conflict.note')} value={note} onChange={setNote} multiline placeholder={t('fed.conflict.notePlaceholder')} />
        {error ? <T size={13} color={c.red}>{error}</T> : null}
        <Btn label={t('fed.conflict.resolve')} disabled={loading || !resolution} color={c.pink} onPress={resolve} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ TimelineSheet (append-only audit log for a subject)
function TimelineSheet({ subjectId, subjectType, onClose }) {
  const events = useLoad(() => api.get('/federation-reconciliation-events', { subject_id: subjectId, subject_type: subjectType }), [subjectId]);
  const ACTION_COLOR = {
    accepted: c.mintSoft, rejected: c.paper, flagged: c.pinkSoft, review_cleared: c.cyanSoft,
    escalated: c.orangeSoft, conflict_resolved: c.limeSoft, staged: c.sunSoft,
  };
  return (
    <Sheet onClose={onClose} title={t('fed.timeline.title')}>
      {events.error ? <LoadError error={events.error} onRetry={events.reload} /> : null}
      {!events.data && !events.error ? <Loading /> : null}
      {events.data?.length === 0 ? <Empty emoji="📜" title={t('fed.timeline.empty')} /> : null}
      {(events.data ?? []).map((ev, i) => (
        <View key={ev.id ?? i} style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
          <View style={{ width: 2, backgroundColor: c.line, marginTop: 6 }} />
          <Card color={ACTION_COLOR[ev.action] ?? c.paper} style={{ flex: 1 }}>
            <T size={13} weight="700">{ev.action.replace(/_/g, ' ')}</T>
            {ev.actor_name ? <T size={12} color={c.mute}>{ev.actor_name}</T> : null}
            <T size={11} color={c.mute}>{fmtDate(ev.created_at)}</T>
            {ev.detail?.note ? <T size={12} style={{ marginTop: 4 }}>{ev.detail.note}</T> : null}
          </Card>
        </View>
      ))}
    </Sheet>
  );
}

// ------------------------------------------------------------------ FlagSheet
function FlagSheet({ caseId, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setLoading(true); setError(null);
    try {
      await api.post(`/federation-cases/${caseId}/flag-review`, { review_reason: reason });
      onDone();
    } catch (e) { setError(e.message ?? t('error.generic')); }
    finally { setLoading(false); }
  };

  return (
    <Sheet onClose={onClose} title={t('fed.disc.flagTitle')}>
      <View style={{ gap: 12 }}>
        <T size={13} color={c.mute}>{t('fed.disc.flagDesc')}</T>
        <Field label={t('fed.disc.flagReason')} value={reason} onChange={setReason} multiline placeholder={t('fed.disc.flagReasonPlaceholder')} />
        {error ? <T size={13} color={c.red}>{error}</T> : null}
        <Btn label={t('fed.disc.flagSubmit')} disabled={loading || !reason.trim()} color={c.pink} onPress={submit} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ ImportSheet (file or API pull)
function ImportSheet({ connectorId, connectorName, onClose, onDone }) {
  const [step, setStep] = useState(0); // 0=choose 1=progress 2=done
  const [mode, setMode] = useState('api_pull');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async () => {
    setLoading(true); setError(null); setStep(1);
    try {
      const res = await api.post(`/federation-connectors/${connectorId}/disciplinary-import`, { mode });
      setResult(res); setStep(2);
    } catch (e) { setError(e.message ?? t('error.generic')); setStep(0); }
    finally { setLoading(false); }
  };

  return (
    <Sheet onClose={onClose} title={t('fed.disc.importTitle')}>
      {step === 2 && result ? (
        <View style={{ gap: 14 }}>
          <Card color={c.mintSoft}>
            <T size={15} weight="700">✅ {t('fed.disc.importDone')}</T>
            <T size={13} color={c.mute}>{result.total_records} {t('fed.disc.importTotal')} · {result.created_count} {t('fed.disc.importNew')} · {result.conflict_count} {t('fed.disc.importConflicts')}</T>
          </Card>
          {result.conflict_count > 0 ? (
            <Card color={c.orangeSoft}><T size={13}>{result.conflict_count} {t('fed.disc.importConflictsHint')}</T></Card>
          ) : null}
          <Btn label={t('common.done')} onPress={onDone} />
        </View>
      ) : step === 1 ? (
        <View style={{ gap: 12, alignItems: 'center', padding: 24 }}>
          <Loading />
          <T size={13} color={c.mute}>{t('fed.disc.importing')}</T>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <T size={13} color={c.mute}>{t('fed.disc.importDesc')} {connectorName}</T>
          <MenuField
            label={t('fed.conn.importMode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'api_pull', label: t('fed.conn.apiPull') },
              { value: 'file_upload', label: t('fed.conn.fileUpload') },
            ]} />
          {error ? <T size={13} color={c.red}>{error}</T> : null}
          <Btn label={t('fed.disc.importStart')} disabled={loading} color={c.pink} onPress={submit} />
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ Main export
export function FederationDisciplinaryReconciliation({ connectorId, bodyId }) {
  const { user } = useSession();
  const [tab, setTab] = useState('queue');
  const [selectedSd, setSelectedSd] = useState(null);
  const [selectedSdIsNeedsReview, setSelectedSdIsNeedsReview] = useState(false);
  const [conflictSd, setConflictSd] = useState(null);
  const [timelineSubject, setTimelineSubject] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [flagCaseId, setFlagCaseId] = useState(null);
  const [filterStatus, setFilterStatus] = useState(null);
  const [filterKind, setFilterKind] = useState(null);

  const queue = useLoad(
    () => api.get('/federation-staged-disciplinary', {
      connector_id: connectorId || undefined,
      body_id: bodyId || undefined,
      status: filterStatus || undefined,
      mapped_kind: filterKind || undefined,
      limit: 50,
    }),
    [connectorId, bodyId, filterStatus, filterKind]);

  const conflicts = useLoad(
    () => api.get('/federation-reconciliation-conflicts', { connector_id: connectorId || undefined, body_id: bodyId || undefined }),
    [connectorId, bodyId]);

  const batches = useLoad(
    () => connectorId ? api.get(`/federation-connectors/${connectorId}/disciplinary-batches`) : Promise.resolve([]),
    [connectorId]);

  const reloadAll = useCallback(() => { queue.reload(); conflicts.reload(); batches.reload(); }, [queue, conflicts, batches]);

  const { wide } = useLayout();
  const queueRows = queue.data ?? [];
  const needsReview = queueRows.filter(r => r.is_needs_review);
  const staged = queueRows.filter(r => !r.is_needs_review);
  const conflictRows = conflicts.data?.disciplinary ?? [];

  const openReview = (sd, isNeedsReview) => { setSelectedSd(sd); setSelectedSdIsNeedsReview(isNeedsReview); };

  const tabs = [
    { value: 'queue', label: `${t('fed.disc.queueTab')}${queueRows.length > 0 ? ` (${queueRows.length})` : ''}` },
    { value: 'conflicts', label: `${t('fed.disc.conflictsTab')}${conflictRows.length > 0 ? ` (${conflictRows.length})` : ''}` },
    { value: 'batches', label: t('fed.disc.batchesTab') },
  ];

  return (
    <Screen refreshing={queue.loading} onRefresh={reloadAll}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <H1>{t('fed.disc.title')}</H1>
        {connectorId ? <Btn label={t('fed.disc.importTitle')} color={c.pink} onPress={() => setShowImport(true)} /> : null}
      </View>
      <T size={13} color={c.mute} style={{ marginBottom: 16 }}>{t('fed.disc.desc')}</T>

      <Seg options={tabs} value={tab} onChange={setTab} style={{ marginBottom: 12 }} />

      {tab === 'queue' ? (
        <View>
          {/* Filters */}
          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {[null, 'pending', 'matched', 'conflict', 'manual_review'].map(s => (
              <Chip key={s ?? 'all'} label={s ? (DISC_STATUS_LABEL[s] ?? s) : t('common.all')} selected={filterStatus === s} onPress={() => setFilterStatus(s)} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {[null, 'discipline', 'appeal', 'eligibility_dispute', 'licence_issue'].map(k => (
              <Chip key={k ?? 'all'} label={k ? k.replace(/_/g, ' ') : t('common.allKinds')} selected={filterKind === k} onPress={() => setFilterKind(k)} />
            ))}
          </View>

          {queue.error ? <LoadError error={queue.error} onRetry={queue.reload} /> : null}
          {!queue.data && !queue.error ? <Loading /> : null}

          {/* Needs review (flagged existing cases) */}
          {needsReview.length > 0 ? (
            <Section title={`🔔 ${t('fed.disc.needsReviewSection')} (${needsReview.length})`}>
              {needsReview.map(sd => <StagedDiscRow key={sd.id} sd={sd} isNeedsReview onReview={openReview} />)}
            </Section>
          ) : null}

          {/* Staged incoming records */}
          {staged.length === 0 && needsReview.length === 0 && queue.data ? (
            <Empty emoji="✅" title={t('fed.disc.queueEmpty')} sub={t('fed.disc.queueEmptySub')} />
          ) : null}
          {staged.map(sd => <StagedDiscRow key={sd.id} sd={sd} isNeedsReview={false} onReview={openReview} />)}
        </View>
      ) : null}

      {tab === 'conflicts' ? (
        <View>
          {conflicts.error ? <LoadError error={conflicts.error} onRetry={conflicts.reload} /> : null}
          {!conflicts.data && !conflicts.error ? <Loading /> : null}
          {conflictRows.length === 0 && conflicts.data ? (
            <Empty emoji="🤝" title={t('fed.discConflict.none')} />
          ) : null}
          {conflictRows.map(sd => (
            <Card key={sd.id} color={c.orangeSoft} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, gap: 3 }}>
                  <T size={14} weight="700">⚠️ {CONFLICT_LABEL[sd.conflict_type] ?? sd.conflict_type}</T>
                  <T size={12} color={c.mute}>{sd.external_kind ?? '—'} → {sd.mapped_kind ?? '?'}{sd.mapped_sanction_kind ? ` · ${sd.mapped_sanction_kind}` : ''}</T>
                  <T size={11} color={c.mute}>{t('fed.staged.externalRef')}: {sd.external_ref}</T>
                </View>
                <View style={{ gap: 6 }}>
                  <Btn label={t('fed.discConflict.resolve')} color={c.pink} onPress={() => setConflictSd(sd)} />
                  <Btn label={t('fed.timeline.view')} color={c.cyanSoft} onPress={() => setTimelineSubject({ id: sd.id, type: 'staged_disciplinary' })} />
                </View>
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {tab === 'batches' ? (
        <View>
          {batches.error ? <LoadError error={batches.error} onRetry={batches.reload} /> : null}
          {!batches.data && !batches.error ? <Loading /> : null}
          {(batches.data ?? []).length === 0 && batches.data ? (
            <Empty emoji="📦" title={t('fed.disc.noBatches')} />
          ) : null}
          {(batches.data ?? []).map(b => (
            <Card key={b.id} color={b.status === 'failed' ? c.redSoft : b.status === 'partial' ? c.orangeSoft : c.paper} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, gap: 3 }}>
                  <T size={14} weight="700">{b.mode === 'api_pull' ? '🔄' : '📁'} {fmtDate(b.created_at)}</T>
                  <T size={12} color={c.mute}>{t('fed.batch.total')}: {b.total_records ?? '?'} · {t('fed.batch.conflicts')}: {b.conflict_count}</T>
                  {b.status === 'failed' ? <T size={12} color={c.red}>❌ {t('fed.batch.failed')}</T> : null}
                </View>
                <Tag label={b.status} color={b.status === 'ok' ? c.mintSoft : b.status === 'failed' ? c.redSoft : c.sunSoft} />
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
                <Metric value={b.created_count} label={t('fed.batch.new')} />
                <Metric value={b.conflict_count} label={t('fed.batch.conflicts')} tone={b.conflict_count > 0 ? c.orangeSoft : undefined} />
                <Metric value={b.failed_count} label={t('fed.batch.failed')} tone={b.failed_count > 0 ? c.redSoft : undefined} />
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {/* Sheets */}
      {selectedSd ? (
        <ReviewSheet sd={selectedSd} isNeedsReview={selectedSdIsNeedsReview} onClose={() => setSelectedSd(null)} onDone={() => { setSelectedSd(null); reloadAll(); }} />
      ) : null}
      {conflictSd ? (
        <ConflictResolutionSheet sd={conflictSd} onClose={() => setConflictSd(null)} onDone={() => { setConflictSd(null); reloadAll(); }} />
      ) : null}
      {timelineSubject ? (
        <TimelineSheet subjectId={timelineSubject.id} subjectType={timelineSubject.type} onClose={() => setTimelineSubject(null)} />
      ) : null}
      {showImport ? (
        <ImportSheet connectorId={connectorId} connectorName={connectorId ?? t('fed.disc.unknownConnector')} onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); reloadAll(); }} />
      ) : null}
      {flagCaseId ? (
        <FlagSheet caseId={flagCaseId} onClose={() => setFlagCaseId(null)} onDone={() => { setFlagCaseId(null); reloadAll(); }} />
      ) : null}
    </Screen>
  );
}
