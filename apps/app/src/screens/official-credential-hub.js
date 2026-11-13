// Official Credential Verification Hub (#993 REF-R02).
// Federation-issued credential lifecycle for the official (self view) and the federation reviewer.
// All data from the server; encrypted private proof revealed only on explicit tap (audit-logged).
// Works on iOS, iPadOS, Android and web. Layout adapts from phone to tablet to desktop.
// All strings through t(). RTL-safe (start/end). Touch targets ≥44pt.
import React, { useState } from 'react';
import { View, Pressable, Platform, Dimensions, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, r, font, grad } from '../theme';
import { t } from '../i18n';

const isTablet = () => Dimensions.get('window').width >= 768;
const isDesktop = () => Dimensions.get('window').width >= 1100;

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_CFG = {
  active:       { label: () => t('credentials_verified'),      color: (C) => C.limeSoft,   icon: '✅' },
  submitted:    { label: () => t('credentials_pending'),       color: (C) => C.cyanSoft,   icon: '📤' },
  under_review: { label: () => t('credentials_under_review'),  color: (C) => C.pinkSoft,   icon: '⏳' },
  needs_info:   { label: () => t('credentials_info_requested'),color: (C) => C.sunSoft,    icon: '❓' },
  expired:      { label: () => t('credentials_expired'),       color: (C) => C.redSoft,    icon: '⛔' },
  revoked:      { label: () => t('credentials_revoked'),       color: (C) => C.orangeSoft, icon: '🚫' },
  rejected:     { label: () => t('credentials_revoked'),       color: (C) => C.redSoft,    icon: '✗'  },
  draft:        { label: () => t('credentials_pending'),       color: (C) => C.violetSoft, icon: '📝' },
};

const statusTag = (status) => {
  const cfg = STATUS_CFG[status] ?? { label: () => status, color: (C) => C.paper, icon: '•' };
  return <Tag label={`${cfg.icon} ${cfg.label()}`} color={cfg.color(c)} />;
};

const SCOPE_EMOJI = { international: '🌐', national: '🏛', regional: '🗺', district: '📍', club: '🏟' };

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

// ─── Shared: Credential card ─────────────────────────────────────────────────

function CredCard({ cred, onPress, reviewMode = false }) {
  const expiring = cred.expiring_soon && cred.status === 'active';
  const borderColor = cred.status === 'active' ? (expiring ? c.sun : c.lime) : cred.status === 'under_review' ? c.pink : cred.status === 'expired' || cred.status === 'revoked' ? c.red : c.line;
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${cred.sport_emoji ?? ''} ${cred.licence_type ?? cred.grade}, ${cred.body_name}, ${cred.scope}`}
      style={{ borderStartWidth: 4, borderStartColor: borderColor, marginBottom: 10 }}
    >
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <T weight="800" size={15}>{cred.sport_emoji ?? ''} {cred.licence_type ?? cred.grade}</T>
            <T size={12} color={c.mute}>{cred.body_name}</T>
          </View>
          {statusTag(cred.status)}
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {cred.scope ? <MetaItem label={t('credentials_scope')} value={`${SCOPE_EMOJI[cred.scope] ?? ''} ${t(`credentials_scope_${cred.scope}`)}`} /> : null}
          {cred.licence_no_masked ? <MetaItem label={t('credentials_licence_no')} value={cred.licence_no_masked} /> : null}
          {cred.disciplines?.length ? <MetaItem label={t('credentials_discipline')} value={cred.disciplines.join(' · ')} /> : null}
          {cred.region ? <MetaItem label={t('credentials_region')} value={cred.region} /> : null}
          {cred.issued_on ? <MetaItem label={t('credentials_issued')} value={fmtDate(cred.issued_on)} /> : null}
          {cred.expires_on ? <MetaItem label={t('credentials_expires')} value={fmtDate(cred.expires_on)} alert={expiring || cred.status === 'expired'} /> : null}
        </View>

        {expiring ? (
          <Tag label={`⚠️ ${t('credentials_expiring').replace('{days}', '30')}`} color={c.sunSoft} />
        ) : null}

        {!reviewMode && cred.status === 'active' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
            <Tag label={cred.badge_on_profile ? `🏅 ${t('credentials_badge_on')}` : `· ${t('credentials_badge_off')}`} color={cred.badge_on_profile ? c.pinkSoft : c.violetSoft} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function MetaItem({ label, value, alert }) {
  return (
    <View style={{ gap: 1 }}>
      <T size={10} color={c.mute} weight="600" style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</T>
      <T size={12} weight="700" color={alert ? c.sun : c.ink}>{value}</T>
    </View>
  );
}

// ─── Official self-view ───────────────────────────────────────────────────────

function CredentialList({ credentials, onSelect, reload, sportFilter }) {
  const filtered = sportFilter ? credentials.filter((x) => x.sport_name === sportFilter) : credentials;
  const stats = {
    total: credentials.length,
    verified: credentials.filter((x) => x.status === 'active').length,
    expiring: credentials.filter((x) => x.expiring_soon && x.status === 'active').length,
  };

  return (
    <View style={{ gap: 0 }}>
      {/* Metric strip */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        {[
          { val: stats.total, lbl: 'Total' },
          { val: stats.verified, lbl: t('credentials_verified'), color: c.lime },
          { val: stats.expiring, lbl: t('credentials_expiring'), color: c.sun },
        ].map((m) => (
          <View key={m.lbl} style={{ flex: 1, backgroundColor: c.paper, borderRadius: r.card, padding: 10, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1 }}>
            <T weight="800" size={22} color={m.color ?? c.pink}>{m.val}</T>
            <T size={10} color={c.mute} style={{ marginTop: 2 }}>{m.lbl}</T>
          </View>
        ))}
      </View>

      {!filtered.length ? (
        <Empty label={t('credentials_my')} action={t('credentials_add')} onAction={reload} />
      ) : (
        filtered.map((cred) => <CredCard key={cred.id} cred={cred} onPress={() => onSelect(cred)} />)
      )}
    </View>
  );
}

function CredentialDetail({ cred: initial, onBack, onReload }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/me/credentials/${initial.id}`), [initial.id]);
  const cred = q.data ?? initial;
  const [busy, setBusy] = useState(null);
  const [proofVisible, setProofVisible] = useState(false);
  const [proofValue, setProofValue] = useState(null);
  const [badgeLoading, setBadgeLoading] = useState(false);

  const toggleBadge = async () => {
    setBadgeLoading(true);
    try {
      await api.patch(`/me/credentials/${cred.id}/badge`, { badge_on_profile: !cred.badge_on_profile });
      onReload?.();
      toast(`${!cred.badge_on_profile ? t('credentials_badge_on') : t('credentials_badge_off')}`);
    } catch (e) { toast(e.message ?? t('error.generic'), 'error'); }
    setBadgeLoading(false);
  };

  const revealProof = async () => {
    if (proofVisible) { setProofVisible(false); return; }
    setBusy('proof');
    try {
      const r2 = await api.post(`/me/credentials/${cred.id}/reveal-proof`, {});
      setProofValue(r2.private_proof);
      setProofVisible(true);
    } catch (e) { toast(e.message ?? t('error.generic'), 'error'); }
    setBusy(null);
  };

  const submit = async () => {
    setBusy('submit');
    try {
      await api.post(`/me/credentials/${cred.id}/submit`, {});
      toast(t('credentials_submit'));
      onReload?.();
    } catch (e) { toast(e.message ?? t('error.generic'), 'error'); }
    setBusy(null);
  };

  const startRenewal = async () => {
    setBusy('renew');
    try {
      const r2 = await api.post(`/me/credentials/${cred.id}/renew`, {});
      toast(t('credentials_renew'));
      onReload?.();
    } catch (e) { toast(e.message ?? t('error.generic'), 'error'); }
    setBusy(null);
  };

  const reVerify = async () => {
    setBusy('reverify');
    try {
      await api.post(`/me/credentials/${cred.id}/re-verify`, {});
      toast(t('credentials_re_verify'));
      onReload?.();
    } catch (e) { toast(e.message ?? t('error.generic'), 'error'); }
    setBusy(null);
  };

  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;

  return (
    <View style={{ gap: 12 }}>
      {/* Back */}
      <Pressable
        onPress={onBack}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }}
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
      >
        <T size={22} color={c.pink}>←</T>
        <T size={15} color={c.pink} weight="700">{t('common.back')}</T>
      </Pressable>

      <GradCard colors={grad.hero}>
        <View style={{ gap: 8 }}>
          <T size={22} weight="800" color="#fff">{cred.sport_emoji ?? ''} {cred.licence_type ?? cred.grade}</T>
          <T size={13} color="rgba(255,255,255,0.75)">{cred.body_name}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {statusTag(cred.status)}
            {cred.scope ? <Tag label={`${SCOPE_EMOJI[cred.scope] ?? ''} ${t(`credentials_scope_${cred.scope}`)}`} color={c.violetSoft} /> : null}
          </View>
        </View>
      </GradCard>

      {/* Detail grid */}
      <Card>
        <Section title={t('credentials_hub')}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            <MetaItem label={t('credentials_licence_no')} value={cred.licence_no_masked ?? '—'} />
            <MetaItem label={t('credentials_grade')} value={cred.grade ?? '—'} />
            {cred.disciplines?.length ? <MetaItem label={t('credentials_discipline')} value={cred.disciplines.join(', ')} /> : null}
            <MetaItem label={t('credentials_scope')} value={cred.scope ? `${SCOPE_EMOJI[cred.scope] ?? ''} ${t(`credentials_scope_${cred.scope}`)}` : '—'} />
            {cred.region ? <MetaItem label={t('credentials_region')} value={cred.region} /> : null}
            <MetaItem label={t('credentials_issued')} value={fmtDate(cred.issued_on)} />
            <MetaItem label={t('credentials_expires')} value={fmtDate(cred.expires_on)} alert={cred.expiring_soon || cred.status === 'expired'} />
          </View>
        </Section>
      </Card>

      {/* Private proof reveal */}
      {cred.has_private_proof ? (
        <Card>
          <View style={{ gap: 8 }}>
            <T weight="700" size={14}>🔒 Private Proof</T>
            <T size={12} color={c.mute}>Revealing this is audit-logged.</T>
            {proofVisible ? (
              <View style={{ backgroundColor: c.bg, borderRadius: r.input, padding: 10 }}>
                <T weight="800" size={16} style={{ fontVariant: ['tabular-nums'] }}>{proofValue}</T>
              </View>
            ) : null}
            <Btn
              label={proofVisible ? 'Hide proof' : 'Reveal proof'}
              loading={busy === 'proof'}
              onPress={revealProof}
              color={c.violet}
              accessibilityLabel="Reveal encrypted private proof (audit-logged)"
            />
          </View>
        </Card>
      ) : null}

      {/* Evidence vault */}
      {q.data?.evidence?.length ? (
        <Card>
          <Section title={t('credentials_evidence_vault')}>
            {q.data.evidence.map((ev) => (
              <View key={ev.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line, minHeight: 44 }}>
                <T size={22}>📄</T>
                <View style={{ flex: 1 }}>
                  <T weight="700" size={13}>{ev.file_name}</T>
                  <T size={11} color={c.mute}>{fmtDate(ev.created_at)} · {ev.content_type}</T>
                </View>
              </View>
            ))}
          </Section>
        </Card>
      ) : null}

      {/* Audit trail */}
      {q.data?.audit_trail?.length ? (
        <Card>
          <Section title={t('credentials_audit_trail')}>
            {q.data.audit_trail.slice(0, 8).map((a, i2) => (
              <View key={i2} style={{ flexDirection: 'row', gap: 8, paddingVertical: 6, borderBottomWidth: i2 < 7 ? 1 : 0, borderBottomColor: c.line }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.pink, marginTop: 6 }} />
                <View style={{ flex: 1 }}>
                  <T size={12} color={c.ink}>{a.action?.replace(/_/g, ' ')}</T>
                  <T size={10} color={c.mute}>{fmtDate(a.created_at)}{a.actor_name ? ` · ${a.actor_name}` : ''}</T>
                </View>
              </View>
            ))}
          </Section>
        </Card>
      ) : null}

      {/* Badge toggle */}
      {cred.status === 'active' ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.limeSoft, alignItems: 'center', justifyContent: 'center' }}>
              <T size={22}>🏅</T>
            </View>
            <View style={{ flex: 1 }}>
              <T weight="700" size={14}>{cred.badge_on_profile ? t('credentials_badge_on') : t('credentials_badge_off')}</T>
              <T size={11} color={c.mute}>Visible on your public official profile</T>
            </View>
            <Pressable
              onPress={toggleBadge}
              accessibilityRole="switch"
              accessibilityState={{ checked: cred.badge_on_profile }}
              accessibilityLabel={cred.badge_on_profile ? t('credentials_badge_on') : t('credentials_badge_off')}
              style={{
                width: 44, height: 26, borderRadius: 13,
                backgroundColor: cred.badge_on_profile ? c.pink : c.line,
                justifyContent: 'center',
                paddingHorizontal: 3,
              }}
            >
              {badgeLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                <View style={{
                  width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff',
                  alignSelf: cred.badge_on_profile ? 'flex-end' : 'flex-start',
                  shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 2, elevation: 2,
                }} />
              )}
            </Pressable>
          </View>
        </Card>
      ) : null}

      {/* Actions */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        {['draft', 'rejected', 'needs_info'].includes(cred.status) ? (
          <Btn label={t('credentials_submit')} loading={busy === 'submit'} onPress={submit} />
        ) : null}
        {['active', 'expired'].includes(cred.status) ? (
          <Btn label={t('credentials_re_verify')} loading={busy === 'reverify'} onPress={reVerify} color={c.violet} />
        ) : null}
        {['active', 'expired', 'suspended'].includes(cred.status) ? (
          <Btn label={t('credentials_renew')} loading={busy === 'renew'} onPress={startRenewal} />
        ) : null}
      </View>
    </View>
  );
}

// ─── Reviewer queue ───────────────────────────────────────────────────────────

function ReviewQueueRow({ item, onPress }) {
  const isUrgent = item.status === 'info_requested';
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${item.holder_name}, ${item.licence_type ?? item.grade}, ${item.status}`}
      style={{ borderStartWidth: isUrgent ? 4 : 0, borderStartColor: c.sun, marginBottom: 8 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T size={16} weight="800" color={c.pink}>{(item.holder_name ?? '?')[0]}</T>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800" size={14}>{item.holder_name}</T>
          <T size={12} color={c.mute}>{item.sport_emoji} {item.licence_type ?? item.grade} · {item.body_name}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
            {statusTag(item.status)}
            {isUrgent ? <Tag label="⚡ Urgent" color={c.sunSoft} /> : null}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <T size={10} color={c.mute}>{fmtDate(item.created_at)}</T>
          {item.request_no ? <T size={10} color={c.mute}>{item.request_no}</T> : null}
        </View>
      </View>
    </Card>
  );
}

function ReviewDetail({ review: initial, onBack, onReload }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/credential-reviews/${initial.id}`), [initial.id]);
  const [busy, setBusy] = useState(null);
  const [notes, setNotes] = useState('');
  const [checklist, setChecklist] = useState({});

  const decide = async (decision) => {
    setBusy(decision);
    try {
      await api.post(`/credential-reviews/${initial.id}/decide`, { decision, reviewer_notes: notes || undefined, checklist });
      toast(`${decision === 'approved' ? '✅ ' : decision === 'rejected' ? '✗ ' : '📨 '}${t(`credentials_${decision}`)}`);
      onReload?.();
      onBack?.();
    } catch (e) { toast(e.message ?? t('error.generic'), 'error'); }
    setBusy(null);
  };

  const toggleCheck = async (key, val) => {
    const updated = { ...checklist, [key]: val };
    setChecklist(updated);
    try { await api.patch(`/credential-reviews/${initial.id}/checklist`, { checklist: { [key]: val } }); } catch {}
  };

  const data = q.data;

  return (
    <View style={{ gap: 12 }}>
      <Pressable onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }} accessibilityRole="button" accessibilityLabel={t('common.back')}>
        <T size={22} color={c.pink}>←</T>
        <T size={15} color={c.pink} weight="700">{t('common.back')}</T>
      </Pressable>

      {!data ? <Loading /> : null}
      {q.error && !data ? <LoadError error={q.error} onRetry={q.reload} /> : null}

      {data ? (
        <>
          <GradCard colors={grad.hero}>
            <View style={{ gap: 6 }}>
              <T size={18} weight="800" color="#fff">{data.licence?.sport_name ?? ''} · {data.licence?.grade ?? ''}</T>
              <T size={13} color="rgba(255,255,255,0.75)">{data.review?.request_no}</T>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {statusTag(data.review?.status)}
                {data.licence?.scope ? <Tag label={`${SCOPE_EMOJI[data.licence.scope] ?? ''} ${t(`credentials_scope_${data.licence.scope}`)}`} color={c.violetSoft} /> : null}
              </View>
            </View>
          </GradCard>

          <Card>
            <Section title={t('credentials_hub')}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                <MetaItem label={t('credentials_licence_no')} value={data.licence?.licence_no_masked ?? '—'} />
                <MetaItem label={t('credentials_grade')} value={data.licence?.grade ?? '—'} />
                {data.licence?.disciplines?.length ? <MetaItem label={t('credentials_discipline')} value={data.licence.disciplines.join(', ')} /> : null}
                {data.licence?.region ? <MetaItem label={t('credentials_region')} value={data.licence.region} /> : null}
              </View>
            </Section>
          </Card>

          {/* Evidence list */}
          {data.evidence?.length ? (
            <Card>
              <Section title={t('credentials_evidence_vault')}>
                {data.evidence.map((ev) => (
                  <View key={ev.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line, minHeight: 44 }}>
                    <T size={22}>🔒</T>
                    <View style={{ flex: 1 }}>
                      <T weight="700" size={13}>{ev.file_name}</T>
                      <T size={11} color={c.mute}>{fmtDate(ev.created_at)}</T>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Decrypt ${ev.file_name} (audit-logged)`}
                      onPress={async () => {
                        try {
                          await api.post(`/credential-reviews/${initial.id}/evidence/${ev.id}/decrypt`, {});
                          toast('Evidence decrypted — this action has been logged');
                        } catch (e) { toast(e.message, 'error'); }
                      }}
                      style={{ backgroundColor: c.pinkSoft, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, minHeight: 32, justifyContent: 'center' }}
                    >
                      <T size={12} weight="700" color={c.pink}>🔓 Decrypt</T>
                    </Pressable>
                  </View>
                ))}
              </Section>
            </Card>
          ) : null}

          {/* Reviewer checklist */}
          <Card>
            <Section title={t('credentials_checklist')}>
              {[
                { key: 'licence_matches_records', label: 'Licence number matches federation records' },
                { key: 'training_hours_verified', label: 'Training hours verified (minimum requirement met)' },
                { key: 'assessment_on_file', label: 'Assessment score on file' },
                { key: 'no_disciplinary_blocks', label: 'No active disciplinary blocks' },
              ].map((item) => (
                <Pressable
                  key={item.key}
                  onPress={() => toggleCheck(item.key, !(checklist[item.key] ?? data.review?.checklist?.[item.key]))}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, minHeight: 44 }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: !!(checklist[item.key] ?? data.review?.checklist?.[item.key]) }}
                  accessibilityLabel={item.label}
                >
                  <View style={{
                    width: 22, height: 22, borderRadius: 6,
                    borderWidth: 2,
                    borderColor: (checklist[item.key] ?? data.review?.checklist?.[item.key]) ? c.lime : c.line,
                    backgroundColor: (checklist[item.key] ?? data.review?.checklist?.[item.key]) ? c.limeSoft : c.paper,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    {(checklist[item.key] ?? data.review?.checklist?.[item.key]) ? <T size={13} color={c.lime}>✓</T> : null}
                  </View>
                  <T size={13}>{item.label}</T>
                </Pressable>
              ))}
            </Section>
          </Card>

          {/* Reviewer notes */}
          <Card>
            <T weight="700" size={14} style={{ marginBottom: 6 }}>{t('credentials_reviewer_notes')}</T>
            <T size={11} color={c.mute} style={{ marginBottom: 8 }}>Private — not visible to the applicant</T>
            {data.review?.reviewer_notes ? (
              <View style={{ backgroundColor: c.bg, borderRadius: r.input, padding: 10, marginBottom: 8 }}>
                <T size={13}>{data.review.reviewer_notes}</T>
              </View>
            ) : null}
          </Card>

          {/* Decision buttons */}
          {['pending', 'under_review', 'info_requested'].includes(data.review?.status) ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 20 }}>
              <Btn label={`✗ ${t('credentials_reject')}`} loading={busy === 'rejected'} onPress={() => decide('rejected')} color={c.red} />
              <Btn label={`📨 ${t('credentials_request_info')}`} loading={busy === 'info_requested'} onPress={() => decide('info_requested')} color={c.violet} />
              <Btn label={`✓ ${t('credentials_approve')}`} loading={busy === 'approved'} onPress={() => decide('approved')} color={c.lime} />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

// ─── Main exported component ──────────────────────────────────────────────────

export function OfficialCredentialHub({ mode: mode0 = 'official', userId }) {
  const [mode, setMode] = useState(mode0);
  const [selected, setSelected] = useState(null);
  const [selectedReview, setSelectedReview] = useState(null);
  const [sportFilter, setSportFilter] = useState(null);
  const qCreds = useLoad(() => mode === 'official' ? api.get('/me/credentials') : Promise.resolve([]), [mode]);
  const qQueue = useLoad(() => mode === 'reviewer' ? api.get('/credential-reviews', { limit: 50 }) : Promise.resolve([]), [mode]);
  const wide = isTablet();
  const creds = qCreds.data ?? [];
  const queue = qQueue.data ?? [];
  const sports = [...new Set(creds.map((x) => x.sport_name).filter(Boolean))];

  const loading = mode === 'official' ? qCreds.loading : qQueue.loading;
  const error = mode === 'official' ? qCreds.error : qQueue.error;
  const reload = mode === 'official' ? qCreds.reload : qQueue.reload;

  const inner = (
    <View style={{ flex: 1 }}>
      {/* Mode selector — only show if the caller passes mode=reviewer or admin */}
      {mode0 === 'reviewer' ? (
        <View style={{ flexDirection: 'row', marginBottom: 12 }}>
          <Seg
            options={[{ value: 'official', label: t('credentials_my') }, { value: 'reviewer', label: t('credentials_review_queue') }]}
            value={mode}
            onChange={setMode}
          />
        </View>
      ) : null}

      {loading && !creds.length && !queue.length ? <Loading /> : null}
      {error && !creds.length && !queue.length ? <LoadError error={error} onRetry={reload} /> : null}

      {/* Official self-view */}
      {mode === 'official' ? (
        wide && selected ? (
          <View style={{ flexDirection: 'row', gap: 16, flex: 1 }}>
            <View style={{ width: 320 }}>
              {sports.length > 1 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  <Chip label="All" active={!sportFilter} onPress={() => setSportFilter(null)} />
                  {sports.map((s) => <Chip key={s} label={s} active={sportFilter === s} onPress={() => setSportFilter(s)} />)}
                </View>
              ) : null}
              <CredentialList credentials={creds} onSelect={setSelected} reload={reload} sportFilter={sportFilter} />
            </View>
            <View style={{ flex: 1 }}>
              <CredentialDetail cred={selected} onBack={() => setSelected(null)} onReload={() => { qCreds.reload(); setSelected(null); }} />
            </View>
          </View>
        ) : selected ? (
          <CredentialDetail cred={selected} onBack={() => setSelected(null)} onReload={() => { qCreds.reload(); setSelected(null); }} />
        ) : (
          <View>
            {sports.length > 1 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                <Chip label="All" active={!sportFilter} onPress={() => setSportFilter(null)} />
                {sports.map((s) => <Chip key={s} label={s} active={sportFilter === s} onPress={() => setSportFilter(s)} />)}
              </View>
            ) : null}
            <CredentialList credentials={creds} onSelect={setSelected} reload={reload} sportFilter={sportFilter} />
          </View>
        )
      ) : null}

      {/* Reviewer queue */}
      {mode === 'reviewer' ? (
        wide && selectedReview ? (
          <View style={{ flexDirection: 'row', gap: 16, flex: 1 }}>
            <View style={{ width: 320 }}>
              {queue.map((item) => <ReviewQueueRow key={item.id} item={item} onPress={() => setSelectedReview(item)} />)}
            </View>
            <View style={{ flex: 1 }}>
              <ReviewDetail review={selectedReview} onBack={() => setSelectedReview(null)} onReload={reload} />
            </View>
          </View>
        ) : selectedReview ? (
          <ReviewDetail review={selectedReview} onBack={() => setSelectedReview(null)} onReload={reload} />
        ) : (
          <View>
            {queue.length ? queue.map((item) => <ReviewQueueRow key={item.id} item={item} onPress={() => setSelectedReview(item)} />) : (
              <Empty label={t('credentials_review_queue')} />
            )}
          </View>
        )
      ) : null}
    </View>
  );

  return inner;
}
