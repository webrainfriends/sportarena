// PS-03: Athlete full sharing history & data subject access (DSAR).
// Shows cross-organisation access log, all shares, export and correction request.
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useSession } from '../session';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Btn, Card, Empty, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { needLabel, dayText } from './academy-inclusion';

const STATUS_COLOR = { active: c.lime, lapsed: c.sun, revoked: c.orange };
const LOG_ICON = {
  share_granted: '🔗', share_viewed: '👁', share_revoked: '🚫', share_revised: '✏️',
  contact_preferences_viewed: '📞', checklist_item_arranged: '✅', dsar_export: '⬇️', correction_requested: '📝',
};

export function AccommodationHistory({ athleteId }) {
  const { toast } = useSession();
  const [page, setPage] = useState(1);
  const [correcting, setCorrecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const d = useLoad(() => api.get('/me/accommodations/history', { ...(athleteId ? { athlete_id: athleteId } : {}), page }), [athleteId, page]);

  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;

  const doExport = async () => {
    setExporting(true);
    try {
      const data = await api.post('/me/accommodations/export', athleteId ? { athlete_id: athleteId } : {});
      toast(t('inc.hist_exported'));
    } catch (e) { toast(explain(e)); } finally { setExporting(false); }
  };

  const submitCorrection = async (v) => {
    try {
      await api.post('/me/accommodations/correction-request', { ...(athleteId ? { athlete_id: athleteId } : {}), description: v.description });
      toast(t('inc.hist_correction_sent')); setCorrecting(false); d.reload();
    } catch (e) { throw new Error(explain(e)); }
  };

  const correctionFields = [
    { key: 'description', label: t('inc.hist_correction_desc'), type: 'multiline', maxLength: 1000, hint: t('inc.hist_correction_hint') },
  ];

  const { shares, access_log, correction_requests } = d.data;

  return (
    <View style={{ gap: 12 }}>
      {/* hero */}
      <View style={{ backgroundColor: c.pink, borderRadius: 16, padding: 16, gap: 4 }}>
        <T weight="800" size={18} color="#FFF">{t('inc.hist_title')}</T>
        <T size={13} color="rgba(255,255,255,0.82)">{t('inc.hist_sub')}</T>
      </View>

      {/* DSAR + correction actions */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn style={{ flex: 1 }} title={t('inc.hist_export')} loading={exporting} onPress={doExport} accessibilityLabel={t('inc.hist_export_a11y')} />
        <Btn style={{ flex: 1 }} title={t('inc.hist_correction')} color={c.mute} onPress={() => setCorrecting(true)} accessibilityLabel={t('inc.hist_correction_a11y')} />
      </View>

      {/* open correction requests */}
      {correction_requests.filter((r) => r.status === 'pending' || r.status === 'in_review').map((r) => (
        <Card key={r.id} style={{ backgroundColor: c.sunSoft }}>
          <Row title={t('inc.hist_corr_open')} sub={t('inc.hist_corr_since', { date: dayText(r.created_at) })} right={<Tag label={t(`inc.corr_status_${r.status}`)} color={c.sun} />} />
        </Card>
      ))}

      {/* access log */}
      <T weight="700" size={13} color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('inc.hist_log_title')}</T>
      {!access_log.length ? (
        <Card><Empty emoji="📋" title={t('inc.hist_log_empty')} sub={t('inc.hist_log_empty_sub')} /></Card>
      ) : (
        <Card style={{ padding: 0, paddingHorizontal: 14 }}>
          {access_log.slice(0, 20).map((e, idx) => (
            <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: idx < access_log.length - 1 ? 1 : 0, borderBottomColor: c.line }}>
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <T size={14}>{LOG_ICON[e.kind] ?? '•'}</T>
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <T weight="600" size={13}>{t(`inc.ev_${e.kind}`, { name: e.actor_name })}</T>
                <T size={12} color={c.mute}>{e.detail ? `${e.detail} · ` : ''}{dayText(e.created_at)}</T>
              </View>
            </View>
          ))}
        </Card>
      )}

      {/* share history */}
      <T weight="700" size={13} color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('inc.hist_shares_title')}</T>
      {!shares.length ? (
        <Card><T size={13} color={c.mute}>{t('inc.hist_shares_none')}</T></Card>
      ) : shares.map((s) => (
        <Card key={s.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1, gap: 3 }}>
              <T weight="700" size={14}>{s.org_name}</T>
              <T size={12} color={c.mute}>{s.needs.map((n) => needLabel(n.key)).join(' · ')}</T>
              {s.purpose_key ? <T size={12} color={c.mute}>{t(`inc.purpose_${s.purpose_key}`)}</T> : null}
              <T size={12} color={c.mute}>{dayText(s.created_at)} → {dayText(s.expires_at)}</T>
            </View>
            <Tag label={t(`inc.status_${s.status}`)} color={STATUS_COLOR[s.status]} />
          </View>
        </Card>
      ))}

      {page > 1 ? <Btn title={t('inc.hist_prev')} color={c.mute} onPress={() => setPage((p) => Math.max(1, p - 1))} /> : null}
      {shares.length === 50 ? <Btn title={t('inc.hist_next')} onPress={() => setPage((p) => p + 1)} /> : null}

      <FormSheet visible={correcting} onClose={() => setCorrecting(false)} title={t('inc.hist_correction')} fields={correctionFields} submitLabel={t('inc.hist_correction_submit')} onSubmit={submitCorrection} />
    </View>
  );
}
