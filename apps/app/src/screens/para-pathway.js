// PS-11: Athlete-owned para-sport development pathway. Bridge layer between existing goals/plans/
// academy-assessments and para-sport competition progression. Classification is read-only (from
// para-outcomes); diagnosis/impairment is never stored or inferred.
import React, { useCallback, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Screen, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Sheet } from '../ui';
import { HScroll } from '../pickers';
import { c } from '../theme';
import { t } from '../i18n';
import { useNav } from '../nav';
import { useLayout } from '../layout';

const STAGES = ['adapted_learning', 'coach_evaluation', 'community_competition', 'official_advancement', 'verified_competition'];
const PROVENANCE_LABELS = ['player_goal', 'coach_observation', 'competition_result', 'academy_assessment', 'learning_outcome', 'other'];
const EVIDENCE_STATES = { submitted: c.sunSoft, under_review: c.sun, approved: c.lime, returned: c.red };

// ------------------------------------------------------------------ stage rail
function StageRail({ milestones_by_stage }) {
  const byStage = milestones_by_stage ?? {};
  return (
    <HScroll style={{ paddingVertical: 16, paddingHorizontal: 8 }}>
      {STAGES.map((stage, i) => {
        const hasItems = (byStage[stage]?.length ?? 0) > 0;
        return (
          <View key={stage} style={{ flexDirection: 'row', alignItems: 'center' }}>
            {i > 0 && (
              <View style={{ width: 20, height: 2, backgroundColor: hasItems ? c.violet : c.line }} />
            )}
            <View style={{ alignItems: 'center', gap: 4 }}>
              <View style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: hasItems ? c.violet : 'transparent',
                borderWidth: 2, borderColor: hasItems ? c.violet : c.line,
                justifyContent: 'center', alignItems: 'center',
              }}>
                <T size={13} color={hasItems ? '#fff' : c.mute} weight="700">
                  {byStage[stage]?.length ?? ''}
                </T>
              </View>
              <T size={10} color={hasItems ? c.violet : c.mute} weight={hasItems ? '700' : '400'}
                 style={{ maxWidth: 72, textAlign: 'center' }}>
                {t('pp.stage.' + stage)}
              </T>
            </View>
          </View>
        );
      })}
    </HScroll>
  );
}

// ------------------------------------------------------------------ metric strip
function MetricStrip({ data }) {
  const total = data?.milestones_total ?? 0;
  const approved = data?.milestones_approved ?? 0;
  const pending = data?.milestones_pending ?? 0;
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginHorizontal: 12, marginBottom: 8 }}>
      <Card pad={12} style={{ flex: 1 }}>
        <T weight="800" size={22}>{total}</T>
        <T size={12} color={c.mute}>{t('pp.metric.total')}</T>
      </Card>
      <Card pad={12} style={{ flex: 1 }}>
        <T weight="800" size={22} color={c.lime}>{approved}</T>
        <T size={12} color={c.mute}>{t('pp.metric.approved')}</T>
      </Card>
      <Card pad={12} style={{ flex: 1 }}>
        <T weight="800" size={22} color={c.sun}>{pending}</T>
        <T size={12} color={c.mute}>{t('pp.metric.pending')}</T>
      </Card>
    </View>
  );
}

// ------------------------------------------------------------------ classification panel (read-only)
function ClassificationPanel({ sports, push, readOnly }) {
  if (!sports?.length) return null;
  return (
    <Card pad={14} style={{ backgroundColor: c.violetSoft, marginHorizontal: 12, marginBottom: 12 }}>
      <T size={10} color={c.violet} weight="700" style={{ letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
        {t('pp.class.panel')}
      </T>
      {sports.map((s) => (
        <View key={s.sport} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <T weight="700">{s.sport}</T>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            {s.class_code ? <Tag label={s.class_code} color={c.violet} /> : null}
            <Tag label={s.status ?? t('pp.class.none')} color={s.status === 'confirmed' ? c.lime : c.sunSoft} />
          </View>
        </View>
      ))}
      <T size={11} color={c.mute} style={{ marginTop: 6 }}>{t('pp.class.note')}</T>
      {!readOnly && push ? (
        <Btn small title={t('pp.class.connect')} color={c.paper} ink={c.violet}
             style={{ alignSelf: 'flex-start', marginTop: 8 }}
             onPress={() => push('ParaClassification')} />
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ add milestone sheet
function AddMilestoneSheet({ visible, onClose, onDone, initialStage }) {
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={t('pp.milestone.add')}
      submitLabel={t('pp.milestone.add')}
      fields={[
        { key: 'sport', label: t('pp.field.sport'), type: 'entity', entityKind: 'sport', noun: 'sport', filter: { is_para: true } },
        { key: 'stage', label: t('pp.field.stage'), type: 'chips', options: STAGES.map((s) => ({ value: s, label: t('pp.stage.' + s) })) },
        { key: 'title', label: t('pp.field.title'), maxLength: 160 },
        { key: 'notes', label: t('pp.field.notes'), type: 'multiline', optional: true },
        { key: 'linked_goal_id', label: t('pp.field.linked_goal'), type: 'entity', entityKind: 'goal', noun: 'goal', optional: true },
        { key: 'linked_academy_assessment_id', label: t('pp.field.linked_assessment'), type: 'entity', entityKind: 'academy_assessment', noun: 'assessment', optional: true },
      ]}
      initial={{ stage: initialStage ?? STAGES[0] }}
      onSubmit={async (v) => {
        await api.post('/me/para-pathway/milestones', v);
        onDone();
        return t('pp.milestone.added');
      }}
    />
  );
}

// ------------------------------------------------------------------ add evidence sheet
function AddEvidenceSheet({ visible, onClose, milestoneId, onDone }) {
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={t('pp.evidence.add')}
      submitLabel={t('pp.evidence.add')}
      fields={[
        {
          key: 'provenance_label',
          label: t('pp.evidence.label'),
          type: 'chips',
          options: PROVENANCE_LABELS.map((p) => ({ value: p, label: t('pp.prov.' + p) })),
        },
        { key: 'notes', label: t('pp.field.notes'), type: 'multiline', optional: true },
      ]}
      initial={{}}
      onSubmit={async (v) => {
        await api.post(`/me/para-pathway/milestones/${milestoneId}/evidence`, v);
        onDone();
        return t('pp.evidence.added');
      }}
    />
  );
}

// ------------------------------------------------------------------ request feedback sheet
function RequestFeedbackSheet({ visible, onClose, milestoneId, onDone }) {
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={t('pp.feedback.request')}
      submitLabel={t('pp.feedback.send')}
      fields={[
        { key: 'coach_id', label: t('pp.field.coach'), type: 'entity', entityKind: 'person', role: 'coach', noun: 'coach' },
        { key: 'message', label: t('pp.field.message'), type: 'multiline', optional: true },
      ]}
      initial={{}}
      onSubmit={async (v) => {
        await api.post(`/me/para-pathway/milestones/${milestoneId}/feedback-requests`, v);
        onDone();
        return t('pp.feedback.sent');
      }}
    />
  );
}

// ------------------------------------------------------------------ milestone detail sheet
function MilestoneDetailSheet({ visible, onClose, milestone, onDone }) {
  const [addEv, setAddEv] = useState(false);
  const [reqFb, setReqFb] = useState(false);
  if (!milestone) return null;
  const evidence = milestone.evidence ?? [];
  const feedback = milestone.feedback_requests ?? [];
  return (
    <Sheet visible={visible} onClose={onClose} title={milestone.title}>
      <View style={{ gap: 12 }}>
        <T size={13} color={c.mute}>{t('pp.stage.' + milestone.stage)}</T>
        {milestone.notes ? <T size={14}>{milestone.notes}</T> : null}
        {milestone.linked_goal_title ? (
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <Tag label={t('pp.linked.goal')} color={c.cyan} />
            <T size={13}>{milestone.linked_goal_title}</T>
          </View>
        ) : null}
        {milestone.linked_academy_assessment_title ? (
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <Tag label={t('pp.linked.assessment')} color={c.mint} />
            <T size={13}>{milestone.linked_academy_assessment_title}</T>
          </View>
        ) : null}

        <T weight="700" size={13}>{t('pp.evidence.list')}</T>
        {evidence.length ? evidence.map((ev) => (
          <View key={ev.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 8 }}>
            <View style={{ flex: 1 }}>
              <T size={13}>{t('pp.prov.' + ev.provenance_label)}</T>
              {ev.notes ? <T size={12} color={c.mute}>{ev.notes}</T> : null}
            </View>
            <Tag label={t('pp.ev.' + ev.state)} color={EVIDENCE_STATES[ev.state]} />
          </View>
        )) : <T size={12} color={c.mute}>{t('pp.evidence.none')}</T>}
        <Btn small title={t('pp.evidence.add')} color={c.violet} onPress={() => setAddEv(true)} />

        <T weight="700" size={13}>{t('pp.feedback.list')}</T>
        {feedback.length ? feedback.map((fb) => (
          <View key={fb.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 8 }}>
            <T size={13}>{fb.coach_name}</T>
            <Tag label={t('pp.fb.' + fb.state)} color={fb.state === 'responded' ? c.lime : c.sunSoft} />
          </View>
        )) : <T size={12} color={c.mute}>{t('pp.feedback.none')}</T>}
        <Btn small title={t('pp.feedback.request')} color={c.paper} ink={c.violet} onPress={() => setReqFb(true)} />
      </View>
      <AddEvidenceSheet visible={addEv} onClose={() => setAddEv(false)} milestoneId={milestone.id} onDone={() => { setAddEv(false); onDone(); }} />
      <RequestFeedbackSheet visible={reqFb} onClose={() => setReqFb(false)} milestoneId={milestone.id} onDone={() => { setReqFb(false); onDone(); }} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ milestones by stage
function MilestonesByStage({ data, onAdd, onReload }) {
  const [detail, setDetail] = useState(null);
  const [addStage, setAddStage] = useState(null);
  const byStage = data?.milestones_by_stage ?? {};
  const all = STAGES.flatMap((s) => byStage[s] ?? []);
  if (!all.length) {
    return (
      <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
        <T size={32}>🏅</T>
        <T weight="800" size={18} style={{ textAlign: 'center' }}>{t('pp.empty.title')}</T>
        <T size={14} color={c.mute} style={{ textAlign: 'center' }}>{t('pp.empty.sub')}</T>
        <Btn title={t('pp.milestone.add')} color={c.violet} onPress={onAdd} />
      </View>
    );
  }
  return (
    <>
      <Btn small title={t('pp.milestone.add')} color={c.violet} style={{ alignSelf: 'flex-end', marginRight: 12, marginBottom: 8 }} onPress={onAdd} />
      {STAGES.map((stage) => {
        const items = byStage[stage] ?? [];
        if (!items.length) return null;
        return (
          <Section key={stage} title={t('pp.stage.' + stage)} color={c.violet}
                   action="+ Add" onAction={() => setAddStage(stage)}>
            {items.map((m) => (
              <Card key={m.id} pad={14} onPress={() => setDetail(m)} accessibilityLabel={m.title}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <T weight="700" style={{ flex: 1 }}>{m.title}</T>
                  {m.classification_connection ? (
                    <Tag label={t('pp.class.' + m.classification_connection)} color={m.classification_connection === 'confirmed' ? c.lime : c.sunSoft} />
                  ) : null}
                </View>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {m.evidence_count > 0 && (
                    <Chip label={`${m.evidence_count} ${t('pp.chip.evidence')}`} color={c.violet} />
                  )}
                  {m.feedback_pending > 0 && (
                    <Chip label={`${m.feedback_pending} ${t('pp.chip.feedback')}`} color={c.sun} />
                  )}
                  {m.linked_goal_title && <Tag label={t('pp.linked.goal')} color={c.cyan} />}
                  {m.linked_academy_assessment_title && <Tag label={t('pp.linked.assessment')} color={c.mint} />}
                </View>
              </Card>
            ))}
          </Section>
        );
      })}
      <MilestoneDetailSheet visible={!!detail} onClose={() => setDetail(null)} milestone={detail} onDone={() => { setDetail(null); onReload(); }} />
      <AddMilestoneSheet visible={!!addStage} initialStage={addStage} onClose={() => setAddStage(null)} onDone={() => { setAddStage(null); onReload(); }} />
    </>
  );
}

// ------------------------------------------------------------------ share panel
function AddShareSheet({ visible, onClose, onDone }) {
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={t('pp.share.add')}
      submitLabel={t('pp.share.add')}
      fields={[
        { key: 'shared_with_id', label: t('pp.field.share_with'), type: 'entity', entityKind: 'person_or_org', noun: 'person or organisation' },
        { key: 'scope', label: t('pp.field.scope'), type: 'multi', optional: true, options: STAGES.map((s) => ({ value: s, label: t('pp.stage.' + s) })) },
      ]}
      initial={{}}
      onSubmit={async (v) => {
        await api.post('/me/para-pathway/shares', v);
        onDone();
        return t('pp.share.added');
      }}
    />
  );
}

function SharePanel({ shares, onReload }) {
  const { toast } = useSession();
  const [addVisible, setAddVisible] = useState(false);
  const revoke = async (id) => {
    try {
      await api.del(`/me/para-pathway/shares/${id}`);
      toast(t('pp.share.revoked'));
      onReload();
    } catch (e) {
      toast('' + e.message);
    }
  };
  return (
    <Section title={t('pp.share.title')} color={c.cyan} action={t('pp.share.add')} onAction={() => setAddVisible(true)}>
      <T size={12} color={c.mute}>{t('pp.share.hint')}</T>
      {shares?.length ? shares.map((s) => (
        <Card key={s.id} pad={14}>
          <T weight="800">{s.shared_with_name}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {s.scope?.map((st) => <Tag key={st} label={t('pp.stage.' + st)} />)}
          </View>
          {s.guardian_consent_required ? (
            <T size={12} color={c.sun} style={{ marginTop: 4 }}>{t('pp.share.consent_required')}</T>
          ) : null}
          <Btn small title={t('pp.share.revoke')} color={c.paper} ink={c.red}
               style={{ alignSelf: 'flex-start', marginTop: 10 }}
               onPress={() => revoke(s.id)} />
        </Card>
      )) : <Empty emoji="🔒" title={t('pp.share.empty')} sub={t('pp.share.empty_sub')} />}
      <AddShareSheet visible={addVisible} onClose={() => setAddVisible(false)} onDone={() => { setAddVisible(false); onReload(); }} />
    </Section>
  );
}

// ------------------------------------------------------------------ main athlete screen
export function ParaPathway() {
  const { push } = useNav();
  const { tablet: wide } = useLayout();
  const pw = useLoad(() => api.get('/me/para-pathway'), []);
  const [tab, setTab] = useState('plan');
  const [addVisible, setAddVisible] = useState(false);

  if (pw.error) return <Screen><ErrorBox error={pw.error} onRetry={pw.reload} /></Screen>;
  if (!pw.data) return <Screen><Loading /></Screen>;

  return (
    <Screen onRefresh={pw.reload} title={t('pp.title')}>
      <StageRail milestones_by_stage={pw.data.milestones_by_stage} />
      <MetricStrip data={pw.data} />
      <ClassificationPanel sports={pw.data.para_sports} push={push} />
      <Seg
        value={tab}
        onChange={setTab}
        color={c.violet}
        options={[
          { value: 'plan', label: t('pp.tab.my') },
          { value: 'opps', label: t('pp.tab.explore') },
          { value: 'sharing', label: t('pp.tab.sharing') },
        ]}
      />
      {tab === 'plan' && (
        <MilestonesByStage
          data={pw.data}
          onAdd={() => setAddVisible(true)}
          onReload={pw.reload}
        />
      )}
      {tab === 'opps' && (
        <ParaOpportunities sports={pw.data.para_sports?.map((s) => s.sport)} />
      )}
      {tab === 'sharing' && (
        <SharePanel shares={pw.data.shares} onReload={pw.reload} />
      )}
      <AddMilestoneSheet
        visible={addVisible}
        onClose={() => setAddVisible(false)}
        onDone={() => { setAddVisible(false); pw.reload(); }}
      />
    </Screen>
  );
}

export default ParaPathway;

// ------------------------------------------------------------------ opportunities feed (also used in pathways.js)
export function ParaOpportunities({ sports }) {
  const q = sports?.length ? `?sport=${encodeURIComponent(sports[0])}` : '';
  const opps = useLoad(() => api.get(`/me/para-opportunities${q}`), [q]);
  if (opps.error) return <ErrorBox error={opps.error} onRetry={opps.reload} />;
  if (!opps.data) return <Loading />;
  if (!opps.data.opportunities?.length) {
    return <Empty emoji="🏅" title={t('pp.opp.title')} sub={t('pp.empty.sub')} />;
  }
  return (
    <Section title={t('pp.opp.title')} color={c.cyan}>
      {opps.data.opportunities.map((o) => (
        <Card key={o.id} pad={14}>
          <Row
            title={o.name}
            sub={[o.location, o.date_label].filter(Boolean).join(' · ')}
            right={
              <Tag
                label={t('pp.opp.' + o.eligibility_state)}
                color={
                  o.eligibility_state === 'eligible'
                    ? c.lime
                    : o.eligibility_state === 'pending'
                    ? c.sunSoft
                    : undefined
                }
              />
            }
          />
          <T size={12} color={c.mute}>{t('pp.stage.' + o.stage)}</T>
        </Card>
      ))}
    </Section>
  );
}

// ------------------------------------------------------------------ compact entry card (for pathway-plan.js My plan tab)
export function ParaPathwayEntry() {
  const { push } = useNav();
  const pw = useLoad(() => api.get('/me/para-pathway'), []);
  if (!pw.data && !pw.error) return null; // silent while loading
  if (pw.error) return null;
  const data = pw.data;
  const advancedStage = [...STAGES].reverse().find((s) => (data.milestones_by_stage?.[s]?.length ?? 0) > 0);
  return (
    <Pressable
      onPress={() => push('ParaPathway')}
      accessibilityLabel={t('pp.title')}
      accessibilityRole="button"
    >
      <Card pad={14} style={{ marginHorizontal: 12, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: c.violet }}>
        <T size={10} color={c.violet} weight="700" style={{ letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
          {t('pp.title')}
        </T>
        {advancedStage ? (
          <>
            <T weight="800" size={15}>{t('pp.stage.' + advancedStage)}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <Chip label={`${data.milestones_total ?? 0} ${t('pp.chip.milestones')}`} color={c.violet} />
              {data.milestones_pending > 0 && (
                <Chip label={`${data.milestones_pending} ${t('pp.chip.feedback')}`} color={c.sun} />
              )}
            </View>
          </>
        ) : (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T size={13} color={c.mute}>{t('pp.empty.title')}</T>
            <Btn small title={t('pp.start')} color={c.violet} onPress={() => push('ParaPathway')} />
          </View>
        )}
      </Card>
    </Pressable>
  );
}

// ------------------------------------------------------------------ review evidence sheet (coach view)
function ReviewEvidenceSheet({ visible, onClose, evidence, onDone }) {
  if (!evidence) return null;
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={t('pp.evidence.review')}
      submitLabel={t('pp.evidence.submit_review')}
      fields={[
        {
          key: 'decision',
          label: t('pp.evidence.decision'),
          type: 'chips',
          options: [
            { value: 'approve', label: t('pp.ev.approve') },
            { value: 'return', label: t('pp.ev.return') },
            { value: 'query', label: t('pp.ev.query') },
          ],
        },
        { key: 'notes', label: t('pp.field.notes'), type: 'multiline', optional: true },
      ]}
      initial={{}}
      onSubmit={async (v) => {
        await api.patch(`/para-pathway/evidence/${evidence.id}/review`, v);
        onDone();
        return t('pp.evidence.reviewed');
      }}
    />
  );
}

// ------------------------------------------------------------------ coach milestones view
function CoachMilestonesByStage({ data, athleteId, onReload }) {
  const [reviewEv, setReviewEv] = useState(null);
  const byStage = data?.milestones_by_stage ?? {};
  return (
    <>
      {STAGES.map((stage) => {
        const items = byStage[stage] ?? [];
        if (!items.length) return null;
        return (
          <Section key={stage} title={t('pp.stage.' + stage)} color={c.violet}>
            {items.map((m) => (
              <Card key={m.id} pad={14}>
                <T weight="700">{m.title}</T>
                {m.notes ? <T size={13} color={c.mute} style={{ marginTop: 4 }}>{m.notes}</T> : null}
                {(m.evidence ?? []).length > 0 && (
                  <View style={{ marginTop: 8, gap: 6 }}>
                    <T weight="700" size={12}>{t('pp.evidence.list')}</T>
                    {m.evidence.map((ev) => (
                      <View key={ev.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <View style={{ flex: 1 }}>
                          <T size={13}>{t('pp.prov.' + ev.provenance_label)}</T>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                          <Tag label={t('pp.ev.' + ev.state)} color={EVIDENCE_STATES[ev.state]} />
                          {ev.state === 'submitted' && (
                            <Btn small title={t('pp.evidence.review')} color={c.violet} onPress={() => setReviewEv(ev)} />
                          )}
                        </View>
                      </View>
                    ))}
                  </View>
                )}
                {(m.feedback_requests ?? []).length > 0 && (
                  <View style={{ marginTop: 8, gap: 4 }}>
                    <T weight="700" size={12}>{t('pp.feedback.list')}</T>
                    {m.feedback_requests.map((fb) => (
                      <View key={fb.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <T size={13} style={{ flex: 1 }}>{fb.message ?? t('pp.feedback.no_message')}</T>
                        <Tag label={t('pp.fb.' + fb.state)} color={fb.state === 'responded' ? c.lime : c.sunSoft} />
                      </View>
                    ))}
                  </View>
                )}
              </Card>
            ))}
          </Section>
        );
      })}
      <ReviewEvidenceSheet
        visible={!!reviewEv}
        onClose={() => setReviewEv(null)}
        evidence={reviewEv}
        onDone={() => { setReviewEv(null); onReload(); }}
      />
    </>
  );
}

// ------------------------------------------------------------------ shared para pathway (coach / academy view)
export function SharedParaPathway({ athlete_id, athlete_name }) {
  const pw = useLoad(() => api.get(`/coaching/para-pathway/${athlete_id}`), [athlete_id]);
  if (pw.error) return (
    <Screen>
      <Empty emoji="🔒" title={t('pp.shared.unavailable')} sub={t('pp.shared.unavailable_sub')} />
    </Screen>
  );
  if (!pw.data) return <Screen><Loading /></Screen>;
  return (
    <Screen onRefresh={pw.reload} title={athlete_name ? t('pp.shared.title').replace('{name}', athlete_name) : t('pp.title')}>
      <T size={11} color={c.cyan} weight="700" style={{ padding: 12, letterSpacing: 1 }}>
        {t('pp.shared.milestones')}
      </T>
      <StageRail milestones_by_stage={pw.data.milestones_by_stage} />
      <ClassificationPanel sports={pw.data.para_sports} push={null} readOnly />
      <CoachMilestonesByStage data={pw.data} athleteId={athlete_id} onReload={pw.reload} />
    </Screen>
  );
}
