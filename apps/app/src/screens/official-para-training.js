// Para-sport officiating training and eligibility (#1027, R29): requirement checklists per sport,
// evidence upload, verification status and eligibility summary.
// All features available on iOS, iPadOS, Android and web.
import React, { useState, useCallback } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Empty, Field, Loading, Screen, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { todayLocal } from '../pickers';
import { c, r } from '../theme';
import { t } from '../i18n';

// ------------------------------------------------------------------ helpers

const REQ_STATUS_COLOR = {
  verified: c.mintSoft,
  pending: c.cyanSoft,
  rejected: c.redSoft,
  expired: c.sunSoft,
  missing: c.redSoft,
};
const REQ_STATUS_EMOJI = {
  verified: '✅', pending: '⏳', rejected: '❌', expired: '⚠️', missing: '⬜',
};

function EligibilityBadge({ eligible, expiringSoon, loading }) {
  if (loading) return null;
  if (eligible && expiringSoon > 0) return <Tag label={`⚠️ ${t('para_training.expiring_soon', { count: expiringSoon })}`} color={c.sunSoft} />;
  if (eligible) return <Tag label={`✓ ${t('para_training.eligible')}`} color={c.mintSoft} />;
  return <Tag label={t('para_training.not_eligible')} color={c.redSoft} />;
}

function RequirementRow({ req, completion, onUpload }) {
  const status = (() => {
    if (!completion) return 'missing';
    return completion.status;
  })();
  const daysLeft = completion?.expires_on
    ? Math.ceil((new Date(completion.expires_on) - new Date()) / 86400000)
    : null;

  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }}
      accessible
      accessibilityLabel={[
        req.title,
        t(`para_training.status_${status}`),
        daysLeft != null && daysLeft > 0 ? t('para_training.expires_in', { days: daysLeft }) : null,
        completion?.expires_on && daysLeft != null && daysLeft <= 0 ? t('para_training.expired') : null,
      ].filter(Boolean).join(', ')}
    >
      <T size={18} style={{ width: 28, textAlign: 'center' }} accessibilityElementsHidden>
        {REQ_STATUS_EMOJI[status] ?? '⬜'}
      </T>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <T size={13} weight="700" style={{ flex: 1 }}>{req.title}</T>
          <Tag label={t(`para_training.status_${status}`)} color={REQ_STATUS_COLOR[status] ?? c.violetSoft} />
          {req.mandatory && <Tag label={t('para_training.mandatory')} color={c.orangeSoft} />}
        </View>
        {completion?.completed_on && (
          <T size={11} color={c.mute}>
            {t('para_training.completed_on', { date: completion.completed_on })}
            {completion.expires_on ? ` · ${t('para_training.expires', { date: completion.expires_on })}` : ''}
            {daysLeft != null && daysLeft > 0 && daysLeft <= 60 ? ` · ${t('para_training.days_left', { days: daysLeft })}` : ''}
          </T>
        )}
        {status === 'missing' && (
          <T size={11} color={c.mute}>{t('para_training.not_completed')}{req.mandatory ? ` · ${t('para_training.required_to_officiate')}` : ''}</T>
        )}
        {status === 'rejected' && completion?.rejection_note && (
          <T size={11} color={c.red}>{t('para_training.rejected_note')}: {completion.rejection_note}</T>
        )}
        {req.provider && (
          <T size={11} color={c.mute}>{req.provider}</T>
        )}
      </View>
      {['missing', 'rejected', 'expired'].includes(status) && (
        <Btn
          title={t('para_training.upload')}
          size="sm"
          variant="outline"
          onPress={() => onUpload(req)}
          accessibilityLabel={t('para_training.upload_label', { title: req.title })}
          style={{ borderRadius: r.pill }}
        />
      )}
      {status === 'pending' && (
        <Tag label={t('para_training.awaiting_review')} color={c.cyanSoft} />
      )}
    </View>
  );
}

// ------------------------------------------------------------------ Main screen

export default function OfficialParaTrainingScreen({ route }) {
  const { official_id } = route?.params ?? {};   // if set, viewing another official's eligibility
  const { session } = useSession();
  const { toast } = useSession();
  const { wide } = useLayout();
  const isSelf = !official_id || official_id === session?.user?.id;
  const targetId = official_id ?? session?.user?.id;

  const { data: eligData, loading: eligLoading, reload: reloadElig } = useLoad(
    () => isSelf ? api.get('/para/officiating/my-eligibility') : api.get(`/para/officiating/eligibility/${targetId}`),
    [targetId],
  );
  const { data: compData, loading: compLoading, reload: reloadComp } = useLoad(
    () => isSelf ? api.get('/para/officiating/completions') : Promise.resolve({ completions: [] }),
    [targetId, isSelf],
  );
  const { data: reqData, loading: reqLoading } = useLoad(() => api.get('/para/officiating/requirements'), []);

  const [uploadSheet, setUploadSheet] = useState(null); // the requirement being uploaded for
  const [uploadForm, setUploadForm] = useState({ completed_on: todayLocal(), expires_on: '', cert_ref: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const [sportFilter, setSportFilter] = useState('');

  const submitEvidence = async () => {
    if (!uploadForm.completed_on) { toast(t('para_training.date_required')); return; }
    setSubmitting(true);
    try {
      await api.post('/para/officiating/completions', {
        requirement_id: uploadSheet.id,
        completed_on: uploadForm.completed_on,
        expires_on: uploadForm.expires_on || undefined,
        cert_ref: uploadForm.cert_ref || undefined,
        notes: uploadForm.notes || undefined,
      });
      await Promise.all([reloadElig(), reloadComp()]);
      setUploadSheet(null);
      setUploadForm({ completed_on: todayLocal(), expires_on: '', cert_ref: '', notes: '' });
      toast(t('para_training.submitted'));
    } catch (e) {
      toast(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (eligLoading || reqLoading) return <Screen title={t('para_training.title')}><Loading /></Screen>;

  const sports = eligData?.sports ?? [];
  const completionsByReq = {};
  for (const c of compData?.completions ?? []) completionsByReq[c.requirement_id] = c;

  // Group requirements by sport
  const reqsBySport = {};
  for (const req of reqData?.requirements ?? []) {
    if (!reqsBySport[req.sport_id]) reqsBySport[req.sport_id] = { sport_name: req.sport_name, sport_slug: req.sport_slug, sport_emoji: req.sport_emoji, reqs: [] };
    reqsBySport[req.sport_id].reqs.push(req);
  }

  const totalEligible = sports.filter((s) => s.eligible).length;
  const totalInProgress = sports.filter((s) => !s.eligible && s.incomplete_mandatory.some((m) => completionsByReq[m.requirement_id]?.status === 'pending')).length;
  const totalExpired = sports.reduce((n, s) => n + (s.expiring_soon?.length ?? 0), 0);
  const totalExpiring = sports.reduce((n, s) => n + (s.expiring_soon?.filter((e) => e.days_left <= 60).length ?? 0), 0);

  const sportOptions = [{ value: '', label: t('common.all') }, ...sports.map((s) => ({ value: s.sport_id, label: `${s.sport_emoji ?? ''} ${s.sport_name}` }))];
  const filteredSports = sportFilter ? sports.filter((s) => s.sport_id === sportFilter) : sports;

  // Card color for a sport's eligibility status
  const sportCardColor = (s) => {
    if (s.eligible && s.expiring_soon?.length > 0) return c.sunSoft;
    if (s.eligible) return c.mintSoft;
    return s.incomplete_mandatory.some((m) => completionsByReq[m.requirement_id]?.status === 'pending') ? c.cyanSoft : c.redSoft;
  };

  return (
    <Screen title={t('para_training.title')}>
      <ScrollView contentContainerStyle={{ gap: 14, paddingHorizontal: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

        {/* Metric strip */}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
          {[
            { val: totalEligible, lbl: t('para_training.metric_eligible'), color: c.pink },
            { val: sports.length - totalEligible, lbl: t('para_training.metric_incomplete'), color: c.sun },
            { val: totalExpiring, lbl: t('para_training.metric_expiring'), color: c.red },
          ].map(({ val, lbl, color }) => (
            <View key={lbl} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 14, padding: 12, alignItems: 'center' }} accessible accessibilityLabel={`${val} ${lbl}`}>
              <T size={28} weight="800" color={color}>{val}</T>
              <T size={11} weight="700" color={c.mute} style={{ textAlign: 'center', marginTop: 2 }}>{lbl}</T>
            </View>
          ))}
        </View>

        {/* Alert for expiring soon */}
        {sports.flatMap((s) => s.expiring_soon ?? []).filter((e) => e.days_left <= 60).map((e) => (
          <Card key={e.requirement_id} color={c.sunSoft}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <T size={16} accessibilityElementsHidden>⚠️</T>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={13} weight="800" color={c.sun}>{t('para_training.expiring_alert', { title: e.title, days: e.days_left })}</T>
                <T size={12} color={c.mute}>{t('para_training.expiring_alert_hint', { date: e.expires_on })}</T>
              </View>
            </View>
            <Btn
              title={t('para_training.upload_renewal')}
              size="sm"
              onPress={() => {
                const req = reqData?.requirements?.find((r) => r.id === e.requirement_id);
                if (req) setUploadSheet(req);
              }}
              style={{ borderRadius: r.pill, backgroundColor: c.sun, alignSelf: 'flex-start' }}
              accessibilityLabel={t('para_training.upload_renewal_label', { title: e.title })}
            />
          </Card>
        ))}

        {/* Sport filter */}
        <MenuField
          label={t('para_training.filter_sport')}
          options={sportOptions}
          value={sportFilter}
          onChange={setSportFilter}
          accessibilityLabel={t('para_training.filter_sport')}
        />

        {/* Per-sport requirement cards */}
        {filteredSports.map((sport) => {
          const sportReqs = reqsBySport[sport.sport_id]?.reqs ?? sport.incomplete_mandatory?.map((m) => ({ id: m.requirement_id, title: m.title, mandatory: true })) ?? [];
          return (
            <View key={sport.sport_id}>
              <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
                {sport.sport_emoji} {sport.sport_name}
              </T>
              <Card color={sportCardColor(sport)}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <T size={16} weight="800" style={{ flex: 1 }}>
                    {t('para_training.officiating_title', { sport: sport.sport_name })}
                  </T>
                  <EligibilityBadge eligible={sport.eligible} expiringSoon={sport.expiring_soon?.length ?? 0} />
                </View>

                {/* Requirements list for this sport */}
                {sportReqs.length > 0
                  ? sportReqs.map((req, idx) => (
                      <View key={req.id} style={{ borderTopWidth: idx === 0 ? 1 : 0, borderTopColor: c.line, paddingTop: idx === 0 ? 10 : 0 }}>
                        <RequirementRow
                          req={req}
                          completion={completionsByReq[req.id]}
                          onUpload={setUploadSheet}
                        />
                      </View>
                    ))
                  : <T size={13} color={c.mute}>{t('para_training.no_reqs')}</T>
                }
              </Card>
            </View>
          );
        })}

        {filteredSports.length === 0 && (
          <Empty label={t('para_training.no_sports')} />
        )}
      </ScrollView>

      {/* Upload evidence sheet */}
      <FormSheet
        open={!!uploadSheet}
        onClose={() => setUploadSheet(null)}
        title={t('para_training.upload_title')}
        fields={[
          { type: 'static', label: t('para_training.requirement'), value: uploadSheet?.title ?? '' },
          { type: 'date', label: t('para_training.completed_on'), key: 'completed_on', required: true },
          { type: 'date', label: t('para_training.expires_on'), key: 'expires_on', hint: t('para_training.expires_on_hint') },
          { type: 'text', label: t('para_training.cert_ref'), key: 'cert_ref', hint: t('para_training.cert_ref_hint'), secure: false, maxLength: 300 },
          { type: 'text', label: t('para_training.notes'), key: 'notes', multiline: true, maxLength: 1000 },
        ]}
        value={uploadForm}
        onChange={(k, v) => setUploadForm((f) => ({ ...f, [k]: v }))}
        onSubmit={submitEvidence}
        submitLabel={t('para_training.submit_evidence')}
        loading={submitting}
        disclaimer={t('para_training.cert_disclaimer')}
      />
    </Screen>
  );
}
