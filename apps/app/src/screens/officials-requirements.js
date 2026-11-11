// REF-R10/R30: AI crew requirements tab for the Officials Assignment Board.
// Shows governing-body-sourced required crew, deficit alerts, organiser override, and
// REF-R30 crew template apply flow (apply_crew_template_to_event).
import React, { useState } from 'react';
import { View, Pressable, ScrollView, Modal, FlatList } from 'react-native';
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

// REF-R30: Crew Template Picker sheet — lists published templates matching the event's sport.
function CrewTemplatePicker({ eventId, sportCode, onApplied, onClose }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/crew-templates', { sport_code: sportCode, status: 'published', limit: 20 }), [sportCode]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.post(`/events/${eventId}/apply-crew-template`, { template_id: selected.id });
      toast(t('crew_template.applied_success'));
      onApplied?.();
      onClose?.();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.paper, borderRadius: 24, overflow: 'hidden' }}>
      <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: c.line, alignSelf: 'center', marginTop: 12, marginBottom: 16 }} />
      <T style={{ fontSize: 17, fontWeight: '800', color: c.ink, paddingHorizontal: 20, marginBottom: 4 }}>
        {t('crew_template.title')}
      </T>
      <T style={{ fontSize: 13, color: c.mute, paddingHorizontal: 20, marginBottom: 16 }}>
        {t('crew_template.apply_cta')}
      </T>
      {q.loading ? <Loading /> : (
        <FlatList
          data={q.data?.templates ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
          ListEmptyComponent={<T style={{ color: c.mute, padding: 20, textAlign: 'center' }}>{t('crew_template.none_available')}</T>}
          renderItem={({ item, index }) => {
            const isBest = index === 0;
            const isChosen = selected?.id === item.id;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={item.name}
                accessibilityState={{ selected: isChosen }}
                onPress={() => setSelected(item)}
                style={{
                  borderRadius: 16, padding: 14, backgroundColor: c.paper,
                  borderWidth: isChosen ? 2 : 1, borderColor: isChosen ? c.pink : c.line,
                  shadowColor: '#000', shadowOpacity: 0.06, shadowOffset: { width: 0, height: 2 }, shadowRadius: 6,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
                  <T style={{ fontSize: 14, fontWeight: '700', color: c.ink, flex: 1 }}>{item.name}</T>
                  {isBest ? <Tag label={t('crew_template.best_match')} color={c.pinkSoft} /> : null}
                </View>
                <T style={{ fontSize: 12, color: c.mute, marginBottom: 6 }}>
                  {item.level} · {item.governing_body}
                </T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                  {item.slot_count ? <Tag label={`${item.slot_count} ${t('crew_template.slots')}`} color={c.bg} /> : null}
                  {item.content_hash ? (
                    <Tag label={`${t('crew_template.content_hash').slice(0, 4)}: ${item.content_hash.slice(0, 8)}…`} color={c.bg} />
                  ) : null}
                  {item.source_ref ? <Tag label={item.source_ref} color={c.bg} /> : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
      <View style={{ flexDirection: 'row', gap: 10, padding: 16, paddingBottom: 32 }}>
        <Btn title={t('common.cancel')} color={c.bg} ink={c.pink} onPress={onClose} style={{ flex: 1, minHeight: 48 }} />
        <Btn
          title={t('crew_template.apply_cta')}
          color={c.pink} ink="#fff"
          onPress={apply}
          loading={busy}
          disabled={!selected}
          style={{ flex: 2, minHeight: 48 }}
          accessibilityLabel={t('crew_template.apply_cta')}
        />
      </View>
    </View>
  );
}

export function OfficialsRequirementsTab({ fixtureId, eventId, sportCode, isOrganiser }) {
  const q = useLoad(() => api.get(`/fixtures/${fixtureId}/crew-compliance`).catch(() => null), [fixtureId]);
  const alertsQ = useLoad(() => api.get('/crew-ai/alerts', { limit: 50 }).catch(() => []), [fixtureId]);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  if (q.loading && !q.data) return <Loading />;
  const data = q.data;
  if (!data) return <Empty label={t('official.requirements.title')} />;

  const alert = (alertsQ.data ?? []).find((a) => a.fixture_id === fixtureId);
  const requirements = data.requirements ?? [];
  const assigned = data.assigned ?? [];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 2 }}>
      {/* REF-R30: Apply crew template button — only for organisers with an event context */}
      {isOrganiser && eventId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('crew_template.apply_cta')}
          onPress={() => setShowTemplatePicker(true)}
          style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            borderRadius: 999, borderWidth: 1.5, borderColor: c.pinkSoft, padding: 12, marginBottom: 12,
            backgroundColor: c.paper,
          }}
        >
          <T style={{ fontSize: 14, fontWeight: '700', color: c.pink }}>📋 {t('crew_template.apply_cta')}</T>
        </Pressable>
      ) : null}

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

      {/* REF-R30: Crew template picker modal */}
      <Modal
        visible={showTemplatePicker}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowTemplatePicker(false)}
        accessibilityViewIsModal
      >
        <CrewTemplatePicker
          eventId={eventId}
          sportCode={sportCode}
          onApplied={() => { q.reload(); alertsQ.reload(); }}
          onClose={() => setShowTemplatePicker(false)}
        />
      </Modal>
    </ScrollView>
  );
}
