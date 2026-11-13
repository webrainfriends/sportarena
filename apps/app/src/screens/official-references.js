// Official References Hub (#1002 REF-R33): referee professional references and endorsements.
// Referee view: request, track, revoke, correct, report. Org view: incoming requests, respond.
// Distinct from official-portfolio.js (portfolio display), officials-reputation.js (public testimony).
import React, { useState, useCallback } from 'react';
import { View, Switch, TextInput, FlatList, Pressable, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, Loading, Screen, T, Tag } from '../ui';
import { DateField, Field } from '../pickers';
import { MenuField, MultiMenuField, FormSheet } from '../menu-field';
import { c, r } from '../theme';
import { t } from '../i18n';

// ─── constants ───────────────────────────────────────────────────────────────

const REF_TYPES = ['federation', 'club', 'assignor', 'academy', 'coach', 'event_organiser'];
const REPORT_REASONS = ['self_endorsement', 'conflict', 'inaccurate', 'abusive', 'spam', 'other'];

const TYPE_COLOR = {
  federation:      c.pink,
  club:            c.cyan,
  assignor:        '#E67E22',
  academy:         '#8E44AD',
  coach:           '#16A085',
  event_organiser: '#2980B9',
};

const STATUS_STYLE = {
  pending:  { bg: c.cyanSoft,   fg: c.cyan },
  approved: { bg: c.mintSoft,   fg: c.mint },
  declined: { bg: c.redSoft,    fg: c.red },
  revoked:  { bg: c.violetSoft, fg: c.mute },
  expired:  { bg: c.line,       fg: c.mute },
};

function statusStyle(ref) {
  if (ref.is_expired) return STATUS_STYLE.expired;
  return STATUS_STYLE[ref.response_status] ?? STATUS_STYLE.pending;
}

function statusLabel(ref) {
  if (ref.is_expired) return t('oref.status.expired');
  return t(`oref.status.${ref.response_status}`) ?? ref.response_status;
}

// ─── small atoms ─────────────────────────────────────────────────────────────

function StatusChip({ item }) {
  const s = statusStyle(item);
  return (
    <View style={{ backgroundColor: s.bg, borderRadius: r.pill, paddingHorizontal: 10, paddingVertical: 3 }}>
      <T size={11} weight="700" color={s.fg}>{statusLabel(item)}</T>
    </View>
  );
}

function TypeBadge({ type }) {
  const color = TYPE_COLOR[type] ?? c.pink;
  return (
    <View style={{ backgroundColor: color + '22', borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
      <T size={10} weight="700" color={color}>{t(`oref.type.${type}`) ?? type}</T>
    </View>
  );
}

function StatChip({ label, value, accent }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.paper, borderRadius: r.card, padding: 12, alignItems: 'center', marginHorizontal: 4 }}>
      <T weight="900" size={22} color={accent ?? c.pink}>{value}</T>
      <T size={10} color={c.mute} style={{ marginTop: 2, textAlign: 'center' }}>{label}</T>
    </View>
  );
}

function SkeletonCard() {
  return (
    <View style={{ backgroundColor: c.paper, borderRadius: r.card, padding: 16, marginBottom: 10, opacity: 0.5 }}>
      <View style={{ width: '60%', height: 14, backgroundColor: c.line, borderRadius: 6, marginBottom: 8 }} />
      <View style={{ width: '40%', height: 11, backgroundColor: c.line, borderRadius: 6, marginBottom: 6 }} />
      <View style={{ width: '30%', height: 11, backgroundColor: c.line, borderRadius: 6 }} />
    </View>
  );
}

// ─── reference card ───────────────────────────────────────────────────────────

function RefCard({ item, onPress }) {
  const tenure = item.tenure_from
    ? `${item.tenure_from}${item.tenure_to ? ' → ' + item.tenure_to : ' → present'}`
    : null;
  return (
    <Pressable
      onPress={() => onPress(item)}
      accessibilityLabel={`${item.org_name ?? item.body_name ?? '—'}, ${statusLabel(item)}`}
      style={{ marginBottom: 10 }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <T weight="800" size={15}>{item.org_name ?? item.body_name ?? '—'}</T>
              {item.sport_emoji ? <T size={16}>{item.sport_emoji}</T> : null}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {item.referee_type ? <TypeBadge type={item.referee_type} /> : null}
              {item.sport_name ? <Tag label={item.sport_name} color={c.cyanSoft} /> : null}
            </View>
            {tenure ? <T size={11} color={c.mute}>{tenure}</T> : null}
            {item.public_summary ? (
              <T size={12} style={{ marginTop: 6, fontStyle: 'italic' }} color={c.mute} numberOfLines={2}>
                "{item.public_summary}"
              </T>
            ) : null}
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            <StatusChip item={item} />
            {item.is_verified ? (
              <View style={{ backgroundColor: c.mintSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
                <T size={10} weight="700" color={c.mint}>✓ {t('oref.badge.verified')}</T>
              </View>
            ) : null}
            {item.is_confidential ? (
              <View style={{ backgroundColor: c.violetSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
                <T size={10} weight="700" color={c.mute}>🔒 {t('oref.badge.confidential')}</T>
              </View>
            ) : null}
            {item.conflict_flag ? (
              <View style={{ backgroundColor: c.sunSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
                <T size={10} weight="700" color={c.sun}>⚠ {t('oref.badge.conflict')}</T>
              </View>
            ) : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

// ─── request wizard ──────────────────────────────────────────────────────────

function RequestReferenceWizard({ visible, onClose, onSaved, sports }) {
  const [step, setStep] = useState(1);
  const [refType, setRefType] = useState(null);
  const [orgId, setOrgId] = useState(null);
  const [tenureFrom, setTenureFrom] = useState('');
  const [tenureTo, setTenureTo] = useState('');
  const [sportId, setSportId] = useState(null);
  const [inviteMethod, setInviteMethod] = useState('verified_association');
  const [inviteeEmail, setInviteeEmail] = useState('');
  const [isConfidential, setIsConfidential] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  const [contextNote, setContextNote] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const reset = () => {
    setStep(1); setRefType(null); setOrgId(null); setTenureFrom(''); setTenureTo('');
    setSportId(null); setInviteMethod('direct'); setInviteeEmail(''); setIsConfidential(false);
    setConsentGiven(false); setContextNote(''); setExpiryDate(''); setError(null);
  };

  const close = () => { reset(); onClose(); };

  const submit = async () => {
    if (!consentGiven) { setError(t('oref.consent.label')); return; }
    setSaving(true); setError(null);
    try {
      await api.post('/me/officials/references', {
        referee_type: refType,
        org_id: orgId ?? undefined,
        sport_id: sportId ?? undefined,
        tenure_from: tenureFrom || undefined,
        tenure_to: tenureTo || undefined,
        sport_context: contextNote.trim() || undefined,
        is_confidential: isConfidential,
        expiry_date: expiryDate || undefined,
        invite_method: inviteMethod,
        invitee_email: inviteeEmail.trim() || undefined,
      });
      reset(); onSaved(); onClose();
    } catch (e) { setError(e.message ?? t('error.generic')); } finally { setSaving(false); }
  };

  const stepTitle = [
    t('oref.step.type'),
    t('oref.step.org'),
    t('oref.step.invite'),
    t('oref.step.consent'),
  ][step - 1];

  return (
    <FormSheet visible={visible} onClose={close} title={`${t('oref.request.cta')} — ${stepTitle}`}>
      {/* step indicator */}
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
        {[1, 2, 3, 4].map((s) => (
          <View key={s} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: s <= step ? c.pink : c.line }} />
        ))}
      </View>

      {step === 1 && (
        <View>
          <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('oref.step.type')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {REF_TYPES.map((type) => {
              const selected = refType === type;
              const color = TYPE_COLOR[type];
              return (
                <Pressable
                  key={type}
                  onPress={() => setRefType(type)}
                  accessibilityLabel={t(`oref.type.${type}`)}
                  style={{
                    backgroundColor: selected ? color : color + '22',
                    borderRadius: r.pill,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    minHeight: 44,
                    justifyContent: 'center',
                  }}>
                  <T size={13} weight="700" color={selected ? '#fff' : color}>{t(`oref.type.${type}`)}</T>
                </Pressable>
              );
            })}
          </View>
          <Btn
            label={t('common.next')}
            onPress={() => { if (!refType) { setError(t('oref.step.type')); return; } setError(null); setStep(2); }}
            style={{ marginTop: 16 }}
          />
          {error ? <T size={12} color={c.red} style={{ marginTop: 4 }}>{error}</T> : null}
        </View>
      )}

      {step === 2 && (
        <View>
          <MultiMenuField
            label={t('oref.step.org')}
            load={(q) => api.get(`/organisations?q=${encodeURIComponent(q)}&limit=10`).then((r) => (r.items ?? []).map((o) => ({ value: o.id, label: o.name })))}
            value={orgId ? [orgId] : []}
            onChange={(vals) => setOrgId(vals[0] ?? null)}
            max={1}
          />
          <DateField label={t('oref.tenure.from')} value={tenureFrom} onChange={setTenureFrom} />
          <DateField label={t('oref.tenure.to')} value={tenureTo} onChange={setTenureTo} />
          <MenuField
            label={t('portfolio.milestone.sport')}
            options={(sports ?? []).map((s) => ({ value: s.id, label: s.name }))}
            value={sportId}
            onChange={setSportId}
            nullable
          />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Btn label={t('common.back')} onPress={() => setStep(1)} style={{ flex: 1 }} outline />
            <Btn label={t('common.next')} onPress={() => setStep(3)} style={{ flex: 1 }} />
          </View>
        </View>
      )}

      {step === 3 && (
        <View>
          <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('oref.step.invite')}</T>
          {[
            { value: 'verified_association', label: t('oref.invite.platform'), icon: '🔗' },
            { value: 'secure_link', label: t('oref.invite.link'), icon: '🔒' },
          ].map((opt) => {
            const sel = inviteMethod === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setInviteMethod(opt.value)}
                accessibilityLabel={opt.label}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, marginBottom: 8,
                  borderRadius: r.card, borderWidth: sel ? 2 : 1,
                  borderColor: sel ? c.pink : c.line,
                  backgroundColor: sel ? c.violetSoft : c.paper,
                  minHeight: 56,
                }}>
                <T size={22}>{opt.icon}</T>
                <View style={{ flex: 1 }}>
                  <T weight="700" size={14} color={sel ? c.pink : c.ink}>{opt.label}</T>
                </View>
                {sel ? <T size={18} color={c.pink}>✓</T> : null}
              </Pressable>
            );
          })}
          {inviteMethod === 'secure_link' ? (
            <Field
              label={t('oref.invite.email')}
              value={inviteeEmail}
              onChangeText={setInviteeEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              placeholder="contact@organisation.com"
            />
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Btn label={t('common.back')} onPress={() => setStep(2)} style={{ flex: 1 }} outline />
            <Btn label={t('common.next')} onPress={() => setStep(4)} style={{ flex: 1 }} />
          </View>
        </View>
      )}

      {step === 4 && (
        <View>
          <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('oref.step.consent')}</T>

          {/* confidential toggle */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1, borderColor: c.line, borderRadius: r.input, marginBottom: 10 }}>
            <View style={{ flex: 1 }}>
              <T weight="700" size={13}>{t('oref.confidential.label')}</T>
              <T size={11} color={c.mute}>{t('oref.confidential.hint')}</T>
            </View>
            <Switch
              value={isConfidential}
              onValueChange={setIsConfidential}
              trackColor={{ true: c.pink, false: c.line }}
              thumbColor={Platform.OS === 'android' ? c.paper : undefined}
            />
          </View>

          {/* expiry date */}
          <DateField label={t('oref.expiry.label')} value={expiryDate} onChange={setExpiryDate} />

          {/* context note */}
          <T weight="600" size={12} color={c.mute} style={{ marginTop: 10, marginBottom: 4 }}>{t('oref.context.label')}</T>
          <TextInput
            value={contextNote}
            onChangeText={setContextNote}
            multiline
            numberOfLines={4}
            placeholder={t('oref.context.hint')}
            placeholderTextColor={c.mute}
            maxLength={500}
            accessibilityLabel={t('oref.context.label')}
            style={{
              borderWidth: 1, borderColor: c.line, borderRadius: r.input,
              padding: 12, minHeight: 88, color: c.ink, fontSize: 14,
              textAlignVertical: 'top',
              ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
            }}
          />

          {/* consent checkbox */}
          <Pressable
            onPress={() => setConsentGiven((v) => !v)}
            accessibilityLabel={t('oref.consent.label')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, padding: 4, minHeight: 44 }}>
            <View style={{
              width: 22, height: 22, borderRadius: 5, borderWidth: 2,
              borderColor: consentGiven ? c.pink : c.line,
              backgroundColor: consentGiven ? c.pink : 'transparent',
              alignItems: 'center', justifyContent: 'center',
            }}>
              {consentGiven ? <T size={13} color="#fff">✓</T> : null}
            </View>
            <T size={13} style={{ flex: 1 }}>{t('oref.consent.label')}</T>
          </Pressable>

          {error ? <T size={12} color={c.red} style={{ marginTop: 6 }}>{error}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <Btn label={t('common.back')} onPress={() => setStep(3)} style={{ flex: 1 }} outline />
            <Btn label={saving ? t('common.loading') : t('oref.request.cta')} onPress={submit} disabled={saving || !consentGiven} style={{ flex: 1 }} />
          </View>
        </View>
      )}
    </FormSheet>
  );
}

// ─── detail sheet ─────────────────────────────────────────────────────────────

function TimelineRow({ icon, label, date, done }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
      <View style={{
        width: 28, height: 28, borderRadius: 14,
        backgroundColor: done ? c.pink : c.line,
        alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <T size={13} color={done ? '#fff' : c.mute}>{icon}</T>
      </View>
      <View style={{ flex: 1 }}>
        <T weight="700" size={13}>{label}</T>
        {date ? <T size={11} color={c.mute}>{date}</T> : null}
      </View>
    </View>
  );
}

function ReferenceDetailSheet({ item, visible, onClose, onRevoke, onCorrection, onReport }) {
  if (!item) return null;
  const responded = item.response_status !== 'pending';
  const published = item.response_status === 'approved' && !item.is_expired;
  return (
    <FormSheet visible={visible} onClose={onClose} title={item.org_name ?? item.body_name ?? '—'}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* header */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {item.referee_type ? <TypeBadge type={item.referee_type} /> : null}
          <StatusChip item={item} />
          {item.is_verified ? (
            <View style={{ backgroundColor: c.mintSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 3 }}>
              <T size={11} weight="700" color={c.mint}>✓ {t('oref.badge.verified')}</T>
            </View>
          ) : null}
        </View>

        {/* tenure */}
        {(item.tenure_from || item.tenure_to) ? (
          <View style={{ backgroundColor: c.violetSoft, borderRadius: r.input, padding: 12, marginBottom: 12 }}>
            <T size={11} color={c.mute}>{t('oref.tenure.from')} {item.tenure_from ?? '—'} → {item.tenure_to ?? t('oref.tenure.present')}</T>
            {item.sport_name ? <T size={12} style={{ marginTop: 4 }}>{item.sport_name} {item.sport_emoji ?? ''}</T> : null}
          </View>
        ) : null}

        {/* public summary */}
        {item.public_summary ? (
          <Card style={{ marginBottom: 12 }}>
            <T size={11} weight="700" color={c.mute} style={{ marginBottom: 4 }}>{t('oref.pub.summary')}</T>
            <T size={13} style={{ fontStyle: 'italic' }}>"{item.public_summary}"</T>
          </Card>
        ) : null}

        {/* confidential notice */}
        {item.is_confidential ? (
          <View style={{ backgroundColor: c.violetSoft, borderRadius: r.input, padding: 12, marginBottom: 12, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T size={18}>🔒</T>
            <T size={12} color={c.mute} style={{ flex: 1 }}>{t('oref.confidential.hint')}</T>
          </View>
        ) : null}

        {/* conflict notice */}
        {item.conflict_flag ? (
          <View style={{ backgroundColor: c.sunSoft, borderRadius: r.input, padding: 12, marginBottom: 12, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T size={18}>⚠</T>
            <View style={{ flex: 1 }}>
              <T size={12} weight="700" color={c.sun}>{t('oref.badge.conflict')}</T>
              {item.conflict_reason ? <T size={11} color={c.sun}>{item.conflict_reason}</T> : null}
            </View>
          </View>
        ) : null}

        {/* expiry */}
        {item.expiry_date ? (
          <T size={11} color={c.mute} style={{ marginBottom: 12 }}>
            {t('oref.expire.note').replace('{{date}}', item.expiry_date)}
          </T>
        ) : null}

        {/* timeline */}
        <T weight="800" size={13} style={{ marginBottom: 10 }}>{t('oref.timeline.label')}</T>
        <TimelineRow icon="📤" label={t('oref.timeline.requested')} date={item.created_at?.slice(0, 10)} done />
        <TimelineRow
          icon={responded ? (item.response_status === 'approved' ? '✅' : '✗') : '⏳'}
          label={t('oref.timeline.responded').replace('{{status}}', item.response_status ?? 'pending')}
          date={item.responded_at?.slice(0, 10)}
          done={responded}
        />
        {item.response_status === 'approved' ? (
          <TimelineRow
            icon={item.is_confidential ? '🔒' : '🌐'}
            label={item.is_confidential ? t('oref.badge.confidential') : t('oref.timeline.published')}
            date={item.responded_at?.slice(0, 10)}
            done={published}
          />
        ) : null}
        {item.revoked_at ? (
          <TimelineRow icon="🚫" label={t('oref.timeline.revoked')} date={item.revoked_at?.slice(0, 10)} done />
        ) : null}

        {/* actions */}
        {item.response_status === 'approved' && !item.is_expired && !item.revoked_at ? (
          <Btn
            label={t('oref.correction.title')}
            onPress={() => { onClose(); onCorrection(item); }}
            outline
            style={{ marginTop: 14 }}
          />
        ) : null}
        {!item.revoked_at ? (
          <Btn
            label={t('oref.revoke.title')}
            onPress={() => { onClose(); onRevoke(item); }}
            outline
            style={{ marginTop: 8, borderColor: c.red }}
            labelStyle={{ color: c.red }}
          />
        ) : null}
        <Btn
          label={t('oref.report.title')}
          onPress={() => { onClose(); onReport(item); }}
          outline
          style={{ marginTop: 8 }}
        />
      </ScrollView>
    </FormSheet>
  );
}

// ─── correction sheet ─────────────────────────────────────────────────────────

function CorrectionSheet({ item, visible, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [proposed, setProposed] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  if (!item) return null;
  const submit = async () => {
    if (!reason.trim()) { setError(t('oref.correction.reason')); return; }
    setSaving(true); setError(null);
    try {
      await api.post(`/me/officials/references/${item.id}/corrections`, { reason: reason.trim(), proposed_change: proposed.trim() || undefined });
      setReason(''); setProposed(''); onSaved(); onClose();
    } catch (e) { setError(e.message ?? t('error.generic')); } finally { setSaving(false); }
  };
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('oref.correction.title')}>
      <Field label={t('oref.correction.reason')} value={reason} onChangeText={setReason} multiline maxLength={800} />
      <Field label={t('oref.correction.proposed')} value={proposed} onChangeText={setProposed} multiline maxLength={1000} placeholder={t('oref.write.placeholder')} />
      {error ? <T size={12} color={c.red} style={{ marginTop: 4 }}>{error}</T> : null}
      <Btn label={saving ? t('common.loading') : t('common.save')} onPress={submit} disabled={saving} style={{ marginTop: 12 }} />
    </FormSheet>
  );
}

// ─── report sheet ─────────────────────────────────────────────────────────────

function ReportSheet({ item, visible, onClose, onSaved }) {
  const [reason, setReason] = useState(null);
  const [detail, setDetail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  if (!item) return null;
  const submit = async () => {
    if (!reason) { setError(t('oref.report.reason')); return; }
    setSaving(true); setError(null);
    try {
      await api.post(`/me/officials/references/${item.id}/reports`, { reason, detail: detail.trim() || undefined });
      setReason(null); setDetail(''); onSaved(); onClose();
    } catch (e) { setError(e.message ?? t('error.generic')); } finally { setSaving(false); }
  };
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('oref.report.title')}>
      <T size={13} color={c.mute} style={{ marginBottom: 10 }}>{t('oref.report.reason')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {REPORT_REASONS.map((rr) => {
          const sel = reason === rr;
          return (
            <Pressable
              key={rr}
              onPress={() => setReason(rr)}
              accessibilityLabel={rr}
              style={{
                backgroundColor: sel ? c.pink : c.violetSoft,
                borderRadius: r.pill, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36,
              }}>
              <T size={12} weight="700" color={sel ? '#fff' : c.pink}>{rr.replace(/_/g, ' ')}</T>
            </Pressable>
          );
        })}
      </View>
      <Field label={t('oref.report.detail')} value={detail} onChangeText={setDetail} multiline maxLength={800} placeholder={t('oref.write.placeholder')} />
      {error ? <T size={12} color={c.red} style={{ marginTop: 4 }}>{error}</T> : null}
      <Btn label={saving ? t('common.loading') : t('oref.report.title')} onPress={submit} disabled={saving} style={{ marginTop: 12 }} />
    </FormSheet>
  );
}

// ─── revoke sheet ─────────────────────────────────────────────────────────────

function RevokeSheet({ item, visible, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  if (!item) return null;
  const submit = async () => {
    setSaving(true); setError(null);
    try {
      await api.post(`/me/officials/references/${item.id}/revoke`, { reason: reason.trim() || undefined });
      setReason(''); onSaved(); onClose();
    } catch (e) { setError(e.message ?? t('error.generic')); } finally { setSaving(false); }
  };
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('oref.revoke.title')}>
      <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('oref.revoke.confirm')}</T>
      <Field label={t('oref.revoke.reason')} value={reason} onChangeText={setReason} maxLength={300} />
      {error ? <T size={12} color={c.red} style={{ marginTop: 4 }}>{error}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Btn label={t('common.cancel')} onPress={onClose} outline style={{ flex: 1 }} />
        <Btn
          label={saving ? t('common.loading') : t('oref.revoke.title')}
          onPress={submit}
          disabled={saving}
          style={{ flex: 1, backgroundColor: c.red }}
        />
      </View>
    </FormSheet>
  );
}

// ─── org respond sheet ───────────────────────────────────────────────────────

function OrgRespondSheet({ item, orgId, visible, onClose, onSaved }) {
  const [refText, setRefText] = useState('');
  const [pubSummary, setPubSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  if (!item) return null;
  const respond = async (response) => {
    setSaving(true); setError(null);
    try {
      await api.post(`/orgs/${orgId}/official-references/${item.id}/respond`, {
        response,
        reference_text: refText.trim() || undefined,
        public_summary: pubSummary.trim() || undefined,
      });
      setRefText(''); setPubSummary(''); onSaved(); onClose();
    } catch (e) { setError(e.message ?? t('error.generic')); } finally { setSaving(false); }
  };
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('oref.org.respond.title')}>
      {/* referee info */}
      <Card style={{ marginBottom: 12 }}>
        <T weight="800" size={14}>{item.referee_name ?? '—'}</T>
        {item.sport_name ? <T size={12} color={c.mute}>{item.sport_name}</T> : null}
        {item.tenure_from ? <T size={11} color={c.mute}>{item.tenure_from} → {item.tenure_to ?? t('oref.tenure.present')}</T> : null}
        {item.context_note ? <T size={12} style={{ marginTop: 6, fontStyle: 'italic' }}>{item.context_note}</T> : null}
        {item.is_confidential ? (
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <T size={14}>🔒</T>
            <T size={11} color={c.mute}>{t('oref.confidential.hint')}</T>
          </View>
        ) : null}
      </Card>

      <T weight="600" size={12} color={c.mute} style={{ marginBottom: 4 }}>{t('oref.org.text.label')}</T>
      <T size={11} color={c.mute} style={{ marginBottom: 6 }}>{t('oref.org.text.hint')}</T>
      <TextInput
        value={refText}
        onChangeText={setRefText}
        multiline
        numberOfLines={6}
        placeholder={t('oref.write.placeholder')}
        placeholderTextColor={c.mute}
        maxLength={2000}
        accessibilityLabel={t('oref.org.text.label')}
        style={{
          borderWidth: 1, borderColor: c.line, borderRadius: r.input,
          padding: 12, minHeight: 120, color: c.ink, fontSize: 14,
          textAlignVertical: 'top',
          ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
        }}
      />

      <Field label={t('oref.pub.summary')} value={pubSummary} onChangeText={setPubSummary} maxLength={300} placeholder={t('oref.pub.summary.hint')} style={{ marginTop: 10 }} />

      {error ? <T size={12} color={c.red} style={{ marginTop: 4 }}>{error}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
        <Btn
          label={saving ? t('common.loading') : t('oref.status.declined')}
          onPress={() => respond('declined')}
          disabled={saving}
          outline
          style={{ flex: 1, borderColor: c.red }}
          labelStyle={{ color: c.red }}
        />
        <Btn
          label={saving ? t('common.loading') : t('oref.status.approved')}
          onPress={() => respond('approved')}
          disabled={saving}
          style={{ flex: 1 }}
        />
      </View>
    </FormSheet>
  );
}

// ─── stat strip ───────────────────────────────────────────────────────────────

function StatStrip({ refs }) {
  const verified = (refs ?? []).filter((r) => r.is_verified && r.response_status === 'approved').length;
  const pending = (refs ?? []).filter((r) => r.response_status === 'pending').length;
  const confidential = (refs ?? []).filter((r) => r.is_confidential && r.response_status === 'approved').length;
  const expired = (refs ?? []).filter((r) => r.is_expired).length;
  return (
    <View style={{ flexDirection: 'row', marginHorizontal: -4, marginBottom: 14 }}>
      <StatChip label={t('oref.stat.verified')} value={verified} accent={c.pink} />
      <StatChip label={t('oref.stat.pending')} value={pending} accent={c.cyan} />
      <StatChip label={t('oref.stat.confidential')} value={confidential} accent={c.mute} />
      <StatChip label={t('oref.stat.expired')} value={expired} accent={c.mute} />
    </View>
  );
}

// ─── main screen ─────────────────────────────────────────────────────────────

export function OfficialReferences({ mode = 'referee', orgId }) {
  useSession();
  const [tab, setTab] = useState('mine');
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  const [refs, refsErr, refsLoading] = useLoad(() => api.get('/me/officials/references'), [reload]);
  const [incoming, , incomingLoading] = useLoad(
    () => (mode === 'org' && orgId) ? api.get(`/orgs/${orgId}/official-references/pending`) : Promise.resolve(null),
    [reload, mode, orgId],
  );
  const [sports] = useLoad(() => api.get('/sports'));

  const [showWizard, setShowWizard] = useState(false);
  const [detailItem, setDetailItem] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [correctionItem, setCorrectionItem] = useState(null);
  const [showCorrection, setShowCorrection] = useState(false);
  const [reportItem, setReportItem] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [revokeItem, setRevokeItem] = useState(null);
  const [showRevoke, setShowRevoke] = useState(false);
  const [respondItem, setRespondItem] = useState(null);
  const [showRespond, setShowRespond] = useState(false);

  const openDetail = (item) => { setDetailItem(item); setShowDetail(true); };
  const openCorrection = (item) => { setCorrectionItem(item); setShowCorrection(true); };
  const openReport = (item) => { setReportItem(item); setShowReport(true); };
  const openRevoke = (item) => { setRevokeItem(item); setShowRevoke(true); };
  const openRespond = (item) => { setRespondItem(item); setShowRespond(true); };

  const listData = refs?.items ?? refs ?? [];

  const TABS = mode === 'org'
    ? [
        { key: 'mine',     label: t('oref.title') },
        { key: 'incoming', label: t('oref.incoming.title') },
      ]
    : [{ key: 'mine', label: t('oref.title') }];

  return (
    <Screen>
      {/* page header */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
        <T weight="900" size={22}>{t('oref.title')}</T>
        <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t('oref.subtitle')}</T>
      </View>

      {/* stat strip */}
      {!refsLoading && listData.length > 0 ? (
        <View style={{ paddingHorizontal: 12 }}>
          <StatStrip refs={listData} />
        </View>
      ) : null}

      {/* tabs */}
      {TABS.length > 1 ? (
        <View style={{ flexDirection: 'row', paddingHorizontal: 16, marginBottom: 10 }}>
          {TABS.map((tb) => (
            <Pressable
              key={tb.key}
              onPress={() => setTab(tb.key)}
              accessibilityLabel={tb.label}
              style={{
                marginEnd: 16, paddingBottom: 8,
                borderBottomWidth: 2, borderBottomColor: tab === tb.key ? c.pink : 'transparent',
                minHeight: 44, justifyContent: 'flex-end',
              }}>
              <T weight="700" size={14} color={tab === tb.key ? c.pink : c.mute}>{tb.label}</T>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* CTA */}
      {tab === 'mine' ? (
        <View style={{ paddingHorizontal: 16, marginBottom: 10 }}>
          <Btn label={`+ ${t('oref.request.cta')}`} onPress={() => setShowWizard(true)} />
        </View>
      ) : null}

      {/* list */}
      {tab === 'mine' ? (
        refsLoading ? (
          <View style={{ padding: 16 }}>
            {[1, 2, 3].map((k) => <SkeletonCard key={k} />)}
          </View>
        ) : refsErr ? (
          <Empty title={t('error.generic')} action={t('common.retry')} onAction={refresh} />
        ) : listData.length === 0 ? (
          <Empty
            title={t('oref.empty.title')}
            body={t('oref.empty.body')}
            action={t('oref.request.cta')}
            onAction={() => setShowWizard(true)}
          />
        ) : (
          <FlatList
            data={listData}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
            renderItem={({ item }) => <RefCard item={item} onPress={openDetail} />}
          />
        )
      ) : null}

      {tab === 'incoming' ? (
        incomingLoading ? (
          <View style={{ padding: 16 }}>
            {[1, 2].map((k) => <SkeletonCard key={k} />)}
          </View>
        ) : (incoming?.items ?? incoming ?? []).length === 0 ? (
          <Empty title={t('oref.incoming.empty')} />
        ) : (
          <FlatList
            data={incoming?.items ?? incoming ?? []}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
            renderItem={({ item }) => (
              <Pressable onPress={() => openRespond(item)} accessibilityLabel={item.referee_name ?? '—'} style={{ marginBottom: 10 }}>
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <T weight="800" size={15}>{item.referee_name ?? '—'}</T>
                      {item.sport_name ? <T size={12} color={c.mute}>{item.sport_name}</T> : null}
                      {item.tenure_from ? (
                        <T size={11} color={c.mute}>{item.tenure_from} → {item.tenure_to ?? 'present'}</T>
                      ) : null}
                      {item.context_note ? (
                        <T size={12} style={{ marginTop: 6, fontStyle: 'italic' }} numberOfLines={2}>{item.context_note}</T>
                      ) : null}
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 6 }}>
                      <StatusChip item={item} />
                      {item.is_confidential ? (
                        <T size={12} color={c.mute}>🔒</T>
                      ) : null}
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                    <Btn label={t('oref.status.declined')} onPress={() => { setRespondItem(item); setShowRespond(true); }} outline style={{ flex: 1 }} />
                    <Btn label={t('oref.status.approved')} onPress={() => openRespond(item)} style={{ flex: 1 }} />
                  </View>
                </Card>
              </Pressable>
            )}
          />
        )
      ) : null}

      {/* sheets */}
      <RequestReferenceWizard
        visible={showWizard}
        onClose={() => setShowWizard(false)}
        onSaved={refresh}
        sports={sports?.items ?? sports ?? []}
      />
      <ReferenceDetailSheet
        item={detailItem}
        visible={showDetail}
        onClose={() => setShowDetail(false)}
        onRevoke={openRevoke}
        onCorrection={openCorrection}
        onReport={openReport}
      />
      <CorrectionSheet
        item={correctionItem}
        visible={showCorrection}
        onClose={() => setShowCorrection(false)}
        onSaved={refresh}
      />
      <ReportSheet
        item={reportItem}
        visible={showReport}
        onClose={() => setShowReport(false)}
        onSaved={refresh}
      />
      <RevokeSheet
        item={revokeItem}
        visible={showRevoke}
        onClose={() => setShowRevoke(false)}
        onSaved={refresh}
      />
      <OrgRespondSheet
        item={respondItem}
        orgId={orgId}
        visible={showRespond}
        onClose={() => setShowRespond(false)}
        onSaved={refresh}
      />
    </Screen>
  );
}

export default OfficialReferences;
