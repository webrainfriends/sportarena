// REF-R10: AI crew requirements tab for the Officials Assignment Board.
// Shows governing-body-sourced required crew, deficit alerts, and organiser override.
import React, { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Loading, Section, T, Tag } from '../ui';
import { explain } from '../access';
import { c } from '../theme';
import { t } from '../i18n';

const ROLE_LABEL = {
  referee: 'Referee', umpire: 'Umpire', assistant_referee: 'Assistant referee',
  fourth_official: 'Fourth official', video_assistant_referee: 'VAR',
  scorer: 'Scorer', timekeeper: 'Timekeeper', shot_clock_operator: 'Shot clock',
  line_judge: 'Line judge', stroke_judge: 'Stroke judge', turn_judge: 'Turn judge',
  starter: 'Starter', photo_finish_judge: 'Photo-finish judge',
  chief_timekeeper: 'Chief timekeeper', field_judge: 'Field judge',
  classifier: 'Classifier', match_referee: 'Match referee',
  on_field_umpire: 'On-field umpire', third_umpire: 'Third umpire',
  first_referee: 'First referee', second_referee: 'Second referee',
};

function roleName(r) { return ROLE_LABEL[r] ?? r?.replace(/_/g, ' ') ?? r; }

function ComplianceChip({ status }) {
  if (status === 'compliant') return <Tag label="✅ Full coverage" color={c.mintSoft} />;
  if (status === 'minor_deficit') return <Tag label="⚠️ Minor deficit" color={c.sunSoft} />;
  if (status === 'severe_deficit') return <Tag label="🚨 Severe deficit" color={c.redSoft} />;
  return <Tag label="⏳ Not checked" color={c.violetSoft} />;
}

function RequirementRow({ req, assigned }) {
  const filled = assigned?.filter((a) => a.role === req.crew_role && a.status === 'accepted').length ?? 0;
  const need = req.min_required ?? 1;
  const ok = filled >= need;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <T style={{ flex: 1, fontSize: 14, fontWeight: '600' }}>{roleName(req.crew_role)}</T>
      <T style={{ fontSize: 13, color: c.mute }}>
        {t('official.requirements.fulfilled', { n: filled, total: need })}
      </T>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: ok ? c.mint : filled > 0 ? c.sun : c.red }} />
    </View>
  );
}

function DeficitAlert({ alert, fixtureId, isOrganiser, onDecide }) {
  const { toast } = useSession();
  const [showDecide, setShowDecide] = useState(false);
  const [decision, setDecision] = useState('proceed_degraded');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!alert) return null;
  if (alert.organiser_decision) return (
    <Card style={{ padding: 14, marginBottom: 12, backgroundColor: c.cyanSoft }}>
      <T style={{ fontWeight: '800', fontSize: 14, color: c.cyan }}>
        {alert.organiser_decision === 'proceed_degraded' ? t('official.deficit.proceed_degraded')
          : alert.organiser_decision === 'postpone' ? t('official.deficit.postpone')
          : t('official.deficit.cancelled')}
      </T>
      {alert.organiser_note ? <T style={{ fontSize: 13, color: c.cyan, marginTop: 4 }}>{alert.organiser_note}</T> : null}
      {alert.degradation_factor ? (
        <T style={{ fontSize: 12, color: c.mute, marginTop: 4 }}>
          {t('official.degraded.multiplier_label')}: {alert.degradation_factor}×
        </T>
      ) : null}
    </Card>
  );

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/crew-ai/suggestions/${fixtureId}/accept`, { decision, note: note || undefined });
      toast(t('official.deficit.accept_degradation'));
      setShowDecide(false);
      onDecide?.();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  return (
    <Card style={{ padding: 14, marginBottom: 12, backgroundColor: c.sunSoft }}>
      <T style={{ fontWeight: '900', fontSize: 15, color: c.sun }}>{t('official.requirements.deficit_alert')}</T>
      <T style={{ fontSize: 13, color: c.sun, marginTop: 4 }}>
        {t('official.requirements.deficit_count', { n: (alert.deficit_roles ?? []).length })}
      </T>
      {(alert.deficit_roles ?? []).map((r, i) => (
        <T key={i} style={{ fontSize: 13, color: c.red, marginTop: 2 }}>
          ✗ {roleName(r.crew_role ?? r)}: {r.assigned ?? 0}/{r.required ?? 1}
        </T>
      ))}
      {isOrganiser && !showDecide ? (
        <Btn small title={t('official.deficit.accept_degradation')} color={c.sun} ink="#fff" onPress={() => setShowDecide(true)} style={{ marginTop: 10, minHeight: 44 }} />
      ) : null}
      {showDecide ? (
        <View style={{ marginTop: 10, gap: 8 }}>
          <T style={{ fontWeight: '700', fontSize: 13 }}>Decision</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {['proceed_degraded', 'postpone', 'cancelled'].map((d) => (
              <Chip key={d} label={t(`official.deficit.${d}`)} active={decision === d} onPress={() => setDecision(d)} />
            ))}
          </View>
          <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 10, minHeight: 60, padding: 10 }}>
            <T style={{ color: note ? c.ink : c.mute, fontSize: 13 }} onPress={() => {}}>
              {note || t('official.deficit.organiser_note_placeholder')}
            </T>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small title="Cancel" color={c.line} ink={c.ink} onPress={() => setShowDecide(false)} style={{ flex: 1, minHeight: 44 }} />
            <Btn small title="Confirm" color={c.sun} ink="#fff" onPress={submit} loading={busy} style={{ flex: 2, minHeight: 44 }} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

export function OfficialsRequirementsTab({ fixtureId, isOrganiser }) {
  const q = useLoad(() => api.get(`/fixtures/${fixtureId}/crew-compliance`).catch(() => null), [fixtureId]);
  const alertsQ = useLoad(() => api.get('/crew-ai/alerts', { limit: 50 }).catch(() => []), [fixtureId]);

  if (q.loading && !q.data) return <Loading />;
  const data = q.data;
  if (!data) return <Empty label={t('official.requirements.title')} />;

  const alert = (alertsQ.data ?? []).find((a) => a.fixture_id === fixtureId);
  const requirements = data.requirements ?? [];
  const assigned = data.assigned ?? [];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 2 }}>
      <Section title={t('official.requirements.title')} color={c.violet}>
        <Card style={{ padding: 14, marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <ComplianceChip status={data.compliance_status} />
            {data.governing_body ? (
              <T style={{ fontSize: 12, color: c.mute, flex: 1 }} numberOfLines={1}>
                {t('official.requirements.governing_body')}: {data.governing_body}
              </T>
            ) : null}
          </View>
          {data.source_ref ? (
            <T style={{ fontSize: 12, color: c.mute, marginBottom: 8 }}>
              {t('official.requirements.source_ref')}: {data.source_ref}
            </T>
          ) : null}
          {requirements.length > 0 ? requirements.map((req, i) => (
            <RequirementRow key={i} req={req} assigned={assigned} />
          )) : (
            <T style={{ color: c.mute, fontSize: 13 }}>{t('official.requirements.auto_detected')}</T>
          )}
        </Card>
      </Section>

      <DeficitAlert
        alert={alert}
        fixtureId={fixtureId}
        isOrganiser={isOrganiser}
        onDecide={() => { q.reload(); alertsQ.reload(); }}
      />

      {data.degradation_factor ? (
        <Section title={t('official.degraded.report_banner_title')} color={c.sun}>
          <Card style={{ padding: 14, backgroundColor: c.sunSoft }}>
            <T style={{ fontWeight: '900', fontSize: 16, color: c.sun }}>
              {t('official.degraded.multiplier_label')}: {data.degradation_factor}×
            </T>
            <T style={{ fontSize: 13, color: c.sun, marginTop: 4 }}>
              {t('official.degraded.report_banner_body')}
            </T>
          </Card>
        </Section>
      ) : null}

      {isOrganiser ? (
        <Btn
          title={t('official.requirements.auto_detected')}
          color={c.pink}
          ink="#fff"
          onPress={async () => {
            try {
              await api.post('/crew-ai/suggest', { fixture_id: fixtureId });
              q.reload();
              alertsQ.reload();
            } catch {}
          }}
          style={{ marginTop: 8, minHeight: 44 }}
        />
      ) : null}
    </ScrollView>
  );
}
