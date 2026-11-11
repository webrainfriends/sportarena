// Federation Credential Import (#1026 / REF-R28): connector registry, staged credential review, mapping wizard and sync dashboard.
// Federation staff and platform admins can connect external licence databases, map grade nomenclature, and review staged
// credential records before they touch fed_licences. No data flows until a connector is platform-approved and a reviewer accepts.
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
const ADAPTER_LABEL = { api_json: 'REST / JSON API', api_xml: 'XML API', api_csv: 'CSV API', file_import: 'File upload (CSV/JSON)' };
const STATUS_COLOR = { approved: c.mintSoft, pending: c.sunSoft, suspended: c.orangeSoft, archived: c.paper };
const STATUS_LABEL = { approved: t('fed.conn.approved'), pending: t('fed.conn.pending'), suspended: t('fed.conn.suspended'), archived: t('fed.conn.archived') };
const CONN_ICON = { live: '🟢', file_only: '📁', never_synced: '⬜', not_approved: '🔒', failed: '🔴', partial: '🟡', ok: '🟢' };
const STAGED_STATUS_COLOR = { pending: c.sunSoft, matched: c.cyanSoft, conflict: c.orangeSoft, accepted: c.mintSoft, rejected: c.paper, disputed: c.pinkSoft, manual_review: c.violetSoft };
const STAGED_STATUS_LABEL = { pending: t('fed.staged.pending'), matched: t('fed.staged.matched'), conflict: t('fed.staged.conflict'), accepted: t('fed.staged.accepted'), rejected: t('fed.staged.rejected'), disputed: t('fed.staged.disputed'), manual_review: t('fed.staged.manualReview') };
const CONFLICT_LABEL = { grade_mismatch: t('fed.conflict.gradeMismatch'), standing_conflict: t('fed.conflict.standingConflict'), duplicate: t('fed.conflict.duplicate'), unknown_grade: t('fed.conflict.unknownGrade'), identity_ambiguous: t('fed.conflict.identityAmbiguous'), expiry_conflict: t('fed.conflict.expiryConflict') };
const STANDING_COLOR = { active: c.mintSoft, suspended: c.orangeSoft, expired: c.paper, revoked: c.redSoft };

function connHealth(conn) { return CONN_ICON[conn.connection] ?? '⬜'; }

// ------------------------------------------------------------------ ConnectorCard
function ConnectorCard({ conn, onPress }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${conn.name} connector, ${STATUS_LABEL[conn.status]}, ${conn.staged_pending} pending`}>
      <Card color={c.paper} style={{ marginBottom: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1, gap: 4 }}>
            <T size={15} weight="700">{connHealth(conn)} {conn.name}</T>
            <T size={12} color={c.mute}>{ADAPTER_LABEL[conn.adapter]} · {conn.body_name}{conn.sport_name ? ` · ${conn.sport_name}` : ''}</T>
            {conn.last_sync_at ? <T size={12} color={c.mute}>{t('fed.conn.lastSync')} {fmtDate(conn.last_sync_at)}</T> : <T size={12} color={c.mute}>{t('fed.conn.neverSynced')}</T>}
            {conn.backoff_until && new Date(conn.backoff_until) > new Date() ? <T size={12} color={c.orange}>{t('fed.conn.backoffUntil')} {fmtDate(conn.backoff_until)}</T> : null}
          </View>
          <Tag label={STATUS_LABEL[conn.status]} color={STATUS_COLOR[conn.status]} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          <Metric value={conn.staged_pending} label={t('fed.conn.stagePending')} tone={conn.staged_pending > 0 ? c.sunSoft : undefined} />
          <Metric value={conn.staged_accepted} label={t('fed.conn.stageAccepted')} />
          <Metric value={conn.disc_pending} label={t('fed.conn.discPending')} tone={conn.disc_pending > 0 ? c.orangeSoft : undefined} />
        </View>
      </Card>
    </Pressable>
  );
}

// ------------------------------------------------------------------ StagedCredentialRow
function StagedCredentialRow({ sc, onReview }) {
  return (
    <Pressable onPress={() => onReview(sc)} accessibilityRole="button" accessibilityLabel={`${sc.holder_name ?? t('fed.staged.unmatched')}, ${sc.external_grade} grade, ${STAGED_STATUS_LABEL[sc.status]}`}>
      <Card color={sc.status === 'conflict' ? c.orangeSoft : sc.status === 'accepted' ? c.mintSoft : c.paper} style={{ marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flex: 1, gap: 3 }}>
            <T size={14} weight="700">{sc.holder_name ?? `🔒 ${t('fed.staged.unmatched')}`}</T>
            <T size={12} color={c.mute}>
              {t('fed.staged.externalGrade')}: {sc.external_grade ?? '—'}
              {sc.mapped_grade && sc.mapped_grade !== sc.external_grade ? ` → ${sc.mapped_grade}` : ''}
            </T>
            {sc.issued_on ? <T size={11} color={c.mute}>{t('fed.staged.issued')} {sc.issued_on} {sc.expires_on ? `· ${t('fed.staged.expires')} ${sc.expires_on}` : ''}</T> : null}
            {sc.conflict_type ? <T size={11} color={c.orange}>⚠️ {CONFLICT_LABEL[sc.conflict_type] ?? sc.conflict_type}</T> : null}
            {sc.match_confidence ? <T size={11} color={c.mute}>{t('fed.staged.match')}: {sc.match_confidence}</T> : null}
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Tag label={STAGED_STATUS_LABEL[sc.status]} color={STAGED_STATUS_COLOR[sc.status]} />
            {sc.mapped_standing ? <Tag label={sc.mapped_standing} color={STANDING_COLOR[sc.mapped_standing] ?? c.paper} /> : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

// ------------------------------------------------------------------ ReviewSheet (single staged credential)
function ReviewSheet({ sc, connectorId, onClose, onDone }) {
  const [action, setAction] = useState(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = useCallback(async (chosen) => {
    setLoading(true); setError(null);
    try {
      await api.post(`/federation-staged-credentials/${sc.id}/review`, { action: chosen, review_note: note || undefined });
      AccessibilityInfo.announceForAccessibility(t('fed.staged.reviewDone'));
      onDone();
    } catch (e) { setError(e.message ?? t('error.generic')); }
    finally { setLoading(false); }
  }, [sc.id, note, onDone]);

  const isDecided = ['accepted','rejected'].includes(sc?.status);
  return (
    <Sheet onClose={onClose} title={t('fed.staged.reviewTitle')}>
      {sc ? (
        <View style={{ gap: 14 }}>
          {/* Staged side */}
          <Card color={c.cyanSoft}>
            <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{t('fed.staged.incoming')}</T>
            <T size={15} weight="700">{sc.holder_name ?? `🔒 ${t('fed.staged.unmatched')}`}</T>
            <T size={13} color={c.mute}>{t('fed.staged.externalGrade')}: {sc.external_grade ?? '—'}{sc.mapped_grade ? ` → ${sc.mapped_grade}` : ' ⚠️ unmapped'}</T>
            <T size={13} color={c.mute}>{t('fed.staged.standing')}: {sc.external_standing ?? '—'}{sc.mapped_standing ? ` → ${sc.mapped_standing}` : ''}</T>
            {sc.issued_on ? <T size={12} color={c.mute}>{sc.issued_on} → {sc.expires_on ?? '∞'}</T> : null}
            {sc.match_confidence ? <T size={12} color={sc.match_confidence === 'confirmed' ? c.lime : c.sun}>{t('fed.staged.match')}: {sc.match_confidence}</T> : null}
          </Card>

          {/* Conflict detail */}
          {sc.conflict_type ? (
            <Card color={c.orangeSoft}>
              <T size={13} weight="700">⚠️ {CONFLICT_LABEL[sc.conflict_type]}</T>
              {sc.conflict_detail ? <T size={12} color={c.mute}>{JSON.stringify(sc.conflict_detail)}</T> : null}
              {sc.existing_licence_no ? <T size={12} color={c.mute}>{t('fed.staged.existingLicence')}: {sc.existing_licence_no} ({sc.existing_licence_status})</T> : null}
            </Card>
          ) : null}

          {/* Identity warning */}
          {!sc.matched_user_id ? (
            <Card color={c.sunSoft}><T size={13}>🔒 {t('fed.staged.noMatchWarning')}</T></Card>
          ) : sc.match_confidence !== 'confirmed' ? (
            <Card color={c.sunSoft}><T size={13}>⚠️ {t('fed.staged.probableMatchWarning')}</T></Card>
          ) : null}

          {!isDecided ? (
            <>
              <Field label={t('fed.staged.reviewNote')} value={note} onChange={setNote} multiline placeholder={t('fed.staged.reviewNotePlaceholder')} />
              {error ? <T size={13} color={c.red}>{error}</T> : null}
              <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                <Btn
                  label={t('fed.staged.accept')}
                  disabled={loading || !sc.matched_user_id || sc.match_confidence !== 'confirmed' || !sc.licence_type_id}
                  color={c.lime} onPress={() => submit('accept')}
                  accessibilityLabel={t('fed.staged.acceptA11y')} />
                <Btn label={t('fed.staged.reject')} disabled={loading} color={c.orangeSoft} onPress={() => submit('reject')} />
                <Btn label={t('fed.staged.flagManual')} disabled={loading} color={c.violetSoft} onPress={() => submit('flag_manual')} />
              </View>
            </>
          ) : (
            <Card color={STAGED_STATUS_COLOR[sc.status]}>
              <T size={14} weight="700">{STAGED_STATUS_LABEL[sc.status]}</T>
              {sc.review_note ? <T size={12} color={c.mute}>{sc.review_note}</T> : null}
              {sc.reviewed_at ? <T size={11} color={c.mute}>{fmtDate(sc.reviewed_at)} · {sc.reviewed_by_name}</T> : null}
            </Card>
          )}
        </View>
      ) : <Loading />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ ConflictResolutionSheet
function ConflictResolutionSheet({ sc, onClose, onDone }) {
  const [resolution, setResolution] = useState(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const resolve = useCallback(async () => {
    if (!resolution) return;
    setLoading(true); setError(null);
    try {
      await api.post(`/federation-reconciliation-conflicts/${sc.id}/resolve`, { conflict_kind: 'credential', resolution, note: note || undefined });
      onDone();
    } catch (e) { setError(e.message ?? t('error.generic')); }
    finally { setLoading(false); }
  }, [sc?.id, resolution, note, onDone]);

  if (!sc) return null;
  const conflictLabel = CONFLICT_LABEL[sc.conflict_type] ?? sc.conflict_type;
  return (
    <Sheet onClose={onClose} title={t('fed.conflict.resolveTitle')}>
      <View style={{ gap: 14 }}>
        <T size={15} weight="700">⚠️ {conflictLabel}</T>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {/* Staged (incoming) */}
          <Card color={c.cyanSoft} style={{ flex: 1 }}>
            <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{t('fed.conflict.incoming')}</T>
            <T size={14} weight="700">{sc.holder_name ?? t('fed.staged.unmatched')}</T>
            <T size={12} color={c.mute}>{t('fed.staged.externalGrade')}: {sc.external_grade ?? '—'}</T>
            <T size={12} color={c.mute}>{t('fed.staged.mappedGrade')}: {sc.mapped_grade ?? '—'}</T>
            <T size={12} color={c.mute}>{t('fed.staged.standing')}: {sc.mapped_standing ?? '—'}</T>
          </Card>
          {/* Existing (platform) */}
          <Card color={c.violetSoft} style={{ flex: 1 }}>
            <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{t('fed.conflict.existing')}</T>
            <T size={14} weight="700">{t('fed.conflict.platformRecord')}</T>
            {sc.existing_licence_no ? <T size={12} color={c.mute}>{t('fed.staged.existingLicence')}: {sc.existing_licence_no}</T> : null}
            {sc.existing_licence_status ? <T size={12} color={c.mute}>{t('fed.staged.standing')}: {sc.existing_licence_status}</T> : null}
            {sc.conflict_detail ? Object.entries(sc.conflict_detail).map(([k, v]) => (
              <T key={k} size={11} color={c.mute}>{k.replace(/_/g, ' ')}: {String(v)}</T>
            )) : null}
          </Card>
        </View>

        <T size={14} weight="700">{t('fed.conflict.chooseResolution')}</T>
        <View style={{ gap: 8 }}>
          {[
            { value: 'keep_platform', label: t('fed.conflict.keepPlatform'), desc: t('fed.conflict.keepPlatformDesc'), color: c.violetSoft },
            { value: 'adopt_external', label: t('fed.conflict.adoptExternal'), desc: t('fed.conflict.adoptExternalDesc'), color: c.cyanSoft },
            { value: 'escalate', label: t('fed.conflict.escalate'), desc: t('fed.conflict.escalateDesc'), color: c.sunSoft },
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

// ------------------------------------------------------------------ MappingSheet
function MappingSheet({ conn, onClose, onDone }) {
  const [mapping, setMapping] = useState(conn?.mapping ?? {});
  const [newExtGrade, setNewExtGrade] = useState('');
  const [newPlatGrade, setNewPlatGrade] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const addEntry = () => {
    if (!newExtGrade.trim()) return;
    setMapping(m => ({ ...m, [newExtGrade.trim()]: newPlatGrade.trim() }));
    setNewExtGrade(''); setNewPlatGrade('');
  };
  const removeEntry = (k) => setMapping(m => { const n = { ...m }; delete n[k]; return n; });

  const save = async () => {
    setLoading(true); setError(null);
    try {
      await api.post(`/federation-connectors/${conn.id}/mapping`, { mapping, row_version: conn.row_version });
      onDone();
    } catch (e) { setError(e.message ?? t('error.generic')); }
    finally { setLoading(false); }
  };

  return (
    <Sheet onClose={onClose} title={t('fed.mapping.title')}>
      <View style={{ gap: 12 }}>
        <T size={13} color={c.mute}>{t('fed.mapping.desc')}</T>
        {Object.entries(mapping).length === 0 ? (
          <Card color={c.sunSoft}><T size={13}>{t('fed.mapping.empty')}</T></Card>
        ) : (
          <Card color={c.paper}>
            {Object.entries(mapping).map(([ext, plat]) => (
              <View key={ext} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 }}>
                <T size={13} style={{ flex: 1 }}>{ext}</T>
                <T size={13} color={c.mute}>→</T>
                <T size={13} style={{ flex: 1 }} weight="700">{plat || <T size={13} color={c.orange}>⚠️ unmapped</T>}</T>
                <Pressable onPress={() => removeEntry(ext)} accessibilityRole="button" accessibilityLabel={`${t('common.remove')} ${ext}`}>
                  <T size={12} color={c.red}>✕</T>
                </Pressable>
              </View>
            ))}
          </Card>
        )}
        <Card color={c.cyanSoft}>
          <T size={12} weight="700" style={{ marginBottom: 8 }}>{t('fed.mapping.addEntry')}</T>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <Field label={t('fed.mapping.externalGrade')} value={newExtGrade} onChange={setNewExtGrade} style={{ flex: 1 }} placeholder="FIFA Grade 3" />
            <T size={18} style={{ marginBottom: 8 }}>→</T>
            <Field label={t('fed.mapping.platformGrade')} value={newPlatGrade} onChange={setNewPlatGrade} style={{ flex: 1 }} placeholder="grade_3" />
            <Btn label={t('common.add')} onPress={addEntry} color={c.pink} />
          </View>
        </Card>
        {error ? <T size={13} color={c.red}>{error}</T> : null}
        <Btn label={t('common.save')} disabled={loading} color={c.lime} onPress={save} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ RegisterConnectorSheet
function RegisterConnectorSheet({ onClose, onDone }) {
  const [form, setForm] = useState({ holder_role: 'official', adapter: 'file_import', sync_ttl_hours: 24 });
  const [step, setStep] = useState(0); // 0=basics 1=connection 2=done
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    setLoading(true); setError(null);
    try {
      await api.post('/federation-connectors', form);
      setStep(2);
    } catch (e) { setError(e.message ?? t('error.generic')); }
    finally { setLoading(false); }
  };

  return (
    <Sheet onClose={onClose} title={t('fed.conn.registerTitle')}>
      {step === 2 ? (
        <View style={{ gap: 14 }}>
          <Card color={c.mintSoft}><T size={15} weight="700">✅ {t('fed.conn.registered')}</T><T size={13} color={c.mute}>{t('fed.conn.registeredDesc')}</T></Card>
          <Btn label={t('common.done')} onPress={onDone} />
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <T size={13} color={c.mute}>{t('fed.conn.registerDesc')}</T>
          <Field label={t('fed.conn.name')} value={form.name ?? ''} onChange={v => set('name', v)} placeholder={t('fed.conn.namePlaceholder')} />
          <Field label={t('fed.conn.bodyId')} value={form.body_id ?? ''} onChange={v => set('body_id', v)} placeholder={t('fed.conn.bodyIdPlaceholder')} />
          <MenuField
            label={t('fed.conn.adapter')}
            value={form.adapter}
            onChange={v => set('adapter', v)}
            options={Object.entries(ADAPTER_LABEL).map(([v, l]) => ({ value: v, label: l }))} />
          <MenuField
            label={t('fed.conn.holderRole')}
            value={form.holder_role}
            onChange={v => set('holder_role', v)}
            options={['athlete','coach','official','administrator','other'].map(v => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))} />
          {form.adapter !== 'file_import' ? (
            <>
              <Field label={t('fed.conn.endpointUrl')} value={form.endpoint_url ?? ''} onChange={v => set('endpoint_url', v)} placeholder="https://api.federation.example/licences" autoCapitalize="none" keyboardType="url" />
              <Field label={t('fed.conn.token')} value={form.token ?? ''} onChange={v => set('token', v)} secureTextEntry placeholder={t('fed.conn.tokenPlaceholder')} />
            </>
          ) : null}
          {error ? <T size={13} color={c.red}>{error}</T> : null}
          <Btn label={t('fed.conn.register')} disabled={loading || !form.name || !form.body_id} color={c.pink} onPress={submit} />
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ SyncDashboardTab
function SyncDashboardTab({ connId, summary, reload }) {
  if (!summary) return <Loading />;
  const sc = summary.staged_credentials ?? [];
  const sd = summary.staged_disciplinary ?? [];
  const total = (arr) => arr.reduce((a, r) => a + r.n, 0);
  const byStatus = (arr, s) => arr.find(r => r.status === s)?.n ?? 0;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={byStatus(sc, 'pending')} label={t('fed.dash.credPending')} tone={byStatus(sc, 'pending') > 0 ? c.sunSoft : undefined} />
        <Metric value={byStatus(sc, 'conflict')} label={t('fed.dash.credConflict')} tone={byStatus(sc, 'conflict') > 0 ? c.orangeSoft : undefined} />
        <Metric value={byStatus(sc, 'accepted')} label={t('fed.dash.credAccepted')} />
        <Metric value={byStatus(sc, 'disputed')} label={t('fed.dash.credDisputed')} tone={byStatus(sc, 'disputed') > 0 ? c.pinkSoft : undefined} />
        <Metric value={summary.stale_licences} label={t('fed.dash.staleLicences')} tone={summary.stale_licences > 0 ? c.sunSoft : undefined} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={byStatus(sd, 'pending')} label={t('fed.dash.discPending')} tone={byStatus(sd, 'pending') > 0 ? c.sunSoft : undefined} />
        <Metric value={byStatus(sd, 'conflict')} label={t('fed.dash.discConflict')} tone={byStatus(sd, 'conflict') > 0 ? c.orangeSoft : undefined} />
        <Metric value={byStatus(sd, 'accepted')} label={t('fed.dash.discAccepted')} />
      </View>

      {summary.conflict_types?.length > 0 ? (
        <Section title={t('fed.dash.conflictBreakdown')}>
          <Card color={c.paper}>
            {summary.conflict_types.map(r => (
              <View key={r.conflict_type} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
                <T size={13}>{CONFLICT_LABEL[r.conflict_type] ?? r.conflict_type}</T>
                <T size={13} weight="700">{r.n}</T>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {summary.recent_events?.length > 0 ? (
        <Section title={t('fed.dash.recentActivity')}>
          {summary.recent_events.map((ev, i) => (
            <Card key={i} color={c.paper} style={{ marginBottom: 6 }}>
              <T size={13} weight="700">{ev.action.replace(/_/g, ' ')}</T>
              <T size={11} color={c.mute}>{fmtDate(ev.created_at)}</T>
            </Card>
          ))}
        </Section>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ ConnectorDetailScreen
function ConnectorDetailScreen({ conn: initConn, onBack }) {
  const [conn, setConn] = useState(initConn);
  const [tab, setTab] = useState('queue');
  const [selectedSc, setSelectedSc] = useState(null);
  const [conflictSc, setConflictSc] = useState(null);
  const [showMapping, setShowMapping] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [filterStatus, setFilterStatus] = useState(null);

  const staged = useLoad(() => api.get('/federation-staged-credentials', { connector_id: conn.id, status: filterStatus || undefined, limit: 50 }), [conn.id, filterStatus]);
  const conflicts = useLoad(() => api.get('/federation-reconciliation-conflicts', { connector_id: conn.id }), [conn.id]);
  const summary = useLoad(() => api.get(`/federation-connectors/${conn.id}/reconciliation-summary`), [conn.id]);

  const reloadAll = useCallback(() => { staged.reload(); conflicts.reload(); summary.reload(); }, [staged, conflicts, summary]);

  const triggerSync = useCallback(async () => {
    setSyncing(true); setSyncError(null);
    try {
      await api.post(`/federation-connectors/${conn.id}/sync`, {});
      reloadAll();
    } catch (e) { setSyncError(e.message ?? t('error.generic')); }
    finally { setSyncing(false); }
  }, [conn.id, reloadAll]);

  const bulkAccept = useCallback(async () => {
    const latestBatch = staged.data?.[0];
    if (!latestBatch) return;
    try {
      await api.post('/federation-staged-credentials/bulk-review', { batch_id: latestBatch.batch_id, action: 'accept' });
      reloadAll();
    } catch { /* noop */ }
  }, [staged.data, reloadAll]);

  const { wide } = useLayout();
  const sc = staged.data ?? [];
  const conflictRows = [...(conflicts.data?.credentials ?? [])];
  const matchedCount = sc.filter(r => r.match_confidence === 'confirmed' && r.status === 'matched').length;

  const tabs = [
    { value: 'queue', label: t('fed.conn.queueTab') },
    { value: 'conflicts', label: `${t('fed.conn.conflictsTab')}${conflictRows.length > 0 ? ` (${conflictRows.length})` : ''}` },
    { value: 'mapping', label: t('fed.conn.mappingTab') },
    { value: 'dashboard', label: t('fed.conn.dashboardTab') },
  ];

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16, flexWrap: 'wrap' }}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <T size={15} color={c.pink}>← {t('common.back')}</T>
        </Pressable>
        <T size={18} weight="700" style={{ flex: 1 }}>{connHealth(conn)} {conn.name}</T>
        <Tag label={STATUS_LABEL[conn.status]} color={STATUS_COLOR[conn.status]} />
        {conn.status === 'approved' && conn.adapter !== 'file_import' ? (
          <Btn label={syncing ? t('common.loading') : t('fed.conn.syncNow')} disabled={syncing} color={c.cyanSoft} onPress={triggerSync} />
        ) : null}
        <Btn label={t('fed.mapping.title')} color={c.violetSoft} onPress={() => setShowMapping(true)} />
      </View>
      {syncError ? <T size={13} color={c.red} style={{ paddingHorizontal: 16 }}>{syncError}</T> : null}

      <Seg options={tabs} value={tab} onChange={setTab} style={{ paddingHorizontal: 16 }} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
        {tab === 'queue' ? (
          <>
            {/* Filter chips */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {[null, 'pending', 'matched', 'conflict', 'manual_review'].map(s => (
                <Chip key={s ?? 'all'} label={s ? (STAGED_STATUS_LABEL[s] ?? s) : t('common.all')} selected={filterStatus === s} onPress={() => setFilterStatus(s)} />
              ))}
            </View>
            {matchedCount > 0 ? (
              <Card color={c.cyanSoft}>
                <T size={13}>{matchedCount} {t('fed.queue.bulkAcceptReady')}</T>
                <Btn label={t('fed.queue.bulkAccept')} color={c.lime} onPress={bulkAccept} style={{ marginTop: 8 }} />
              </Card>
            ) : null}
            {staged.error ? <LoadError error={staged.error} onRetry={staged.reload} /> : null}
            {!staged.data && !staged.error ? <Loading /> : null}
            {sc.length === 0 ? <Empty emoji="✅" title={t('fed.queue.empty')} sub={t('fed.queue.emptySub')} /> : null}
            {sc.map(s => <StagedCredentialRow key={s.id} sc={s} onReview={setSelectedSc} />)}
          </>
        ) : null}

        {tab === 'conflicts' ? (
          <>
            {conflictRows.length === 0 ? <Empty emoji="🤝" title={t('fed.conflict.none')} /> : null}
            {conflictRows.map(s => (
              <Pressable key={s.id} onPress={() => setConflictSc(s)} accessibilityRole="button">
                <Card color={c.orangeSoft} style={{ marginBottom: 8 }}>
                  <T size={14} weight="700">⚠️ {CONFLICT_LABEL[s.conflict_type] ?? s.conflict_type}</T>
                  <T size={12} color={c.mute}>{s.holder_name ?? t('fed.staged.unmatched')} · {s.external_grade} → {s.mapped_grade ?? '?'}</T>
                  <T size={11} color={c.mute}>{t('fed.staged.externalRef')}: {s.external_ref}</T>
                </Card>
              </Pressable>
            ))}
          </>
        ) : null}

        {tab === 'mapping' ? (
          <View style={{ gap: 12 }}>
            <T size={13} color={c.mute}>{t('fed.mapping.tabDesc')}</T>
            {Object.keys(conn.mapping ?? {}).length === 0 ? (
              <Card color={c.sunSoft}><T size={13}>{t('fed.mapping.empty')}</T></Card>
            ) : (
              <Card color={c.paper}>
                {Object.entries(conn.mapping ?? {}).map(([ext, plat]) => (
                  <View key={ext} style={{ flexDirection: 'row', paddingVertical: 6, gap: 8 }}>
                    <T size={13} style={{ flex: 1 }}>{ext}</T>
                    <T size={13} color={c.mute}>→</T>
                    <T size={13} style={{ flex: 1 }} weight="700">{plat || <T size={13} color={c.orange}>⚠️</T>}</T>
                  </View>
                ))}
              </Card>
            )}
            <Btn label={t('fed.mapping.edit')} color={c.pink} onPress={() => setShowMapping(true)} />
          </View>
        ) : null}

        {tab === 'dashboard' ? <SyncDashboardTab connId={conn.id} summary={summary.data} reload={reloadAll} /> : null}
      </ScrollView>

      {/* Sheets */}
      {selectedSc ? (
        <ReviewSheet sc={selectedSc} connectorId={conn.id} onClose={() => setSelectedSc(null)} onDone={() => { setSelectedSc(null); reloadAll(); }} />
      ) : null}
      {conflictSc ? (
        <ConflictResolutionSheet sc={conflictSc} onClose={() => setConflictSc(null)} onDone={() => { setConflictSc(null); reloadAll(); }} />
      ) : null}
      {showMapping ? (
        <MappingSheet conn={conn} onClose={() => setShowMapping(false)} onDone={() => { setShowMapping(false); reloadAll(); }} />
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ Main export
export function FederationCredentialImport({ bodyId }) {
  const { user } = useSession();
  const isAdmin = user?.roles?.includes('admin');
  const [selectedConn, setSelectedConn] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [filterStatus, setFilterStatus] = useState(null);

  const connectors = useLoad(
    () => api.get('/federation-connectors', { body_id: bodyId || undefined, status: filterStatus || undefined }),
    [bodyId, filterStatus]);

  const { wide } = useLayout();
  const list = connectors.data ?? [];

  if (selectedConn) {
    return <ConnectorDetailScreen conn={selectedConn} onBack={() => setSelectedConn(null)} />;
  }

  return (
    <Screen refreshing={connectors.loading} onRefresh={connectors.reload}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <H1>{t('fed.import.title')}</H1>
        {isAdmin ? <Btn label={t('fed.conn.register')} color={c.pink} onPress={() => setShowRegister(true)} /> : null}
      </View>
      <T size={13} color={c.mute} style={{ marginBottom: 16 }}>{t('fed.import.desc')}</T>

      {/* Status filter */}
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {[null, 'approved', 'pending', 'suspended'].map(s => (
          <Chip key={s ?? 'all'} label={s ? (STATUS_LABEL[s] ?? s) : t('common.all')} selected={filterStatus === s} onPress={() => setFilterStatus(s)} />
        ))}
      </View>

      {connectors.error ? <LoadError error={connectors.error} onRetry={connectors.reload} /> : null}
      {!connectors.data && !connectors.error ? <Loading /> : null}
      {list.length === 0 && connectors.data ? (
        <Empty emoji="🔌" title={t('fed.import.noConnectors')} sub={isAdmin ? t('fed.import.noConnectorsAdmin') : t('fed.import.noConnectorsMember')} />
      ) : null}
      {list.map(conn => (
        <ConnectorCard key={conn.id} conn={conn} onPress={() => setSelectedConn(conn)} />
      ))}

      {showRegister ? (
        <RegisterConnectorSheet onClose={() => setShowRegister(false)} onDone={() => { setShowRegister(false); connectors.reload(); }} />
      ) : null}
    </Screen>
  );
}
