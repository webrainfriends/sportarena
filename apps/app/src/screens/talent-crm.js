// Talent CRM & Recruiting Pipeline (issue #582). Club-side 10-stage prospect pipeline
// for elite academies — Nadal, Barcelona, Real Madrid. Beats Hudl, TeamSnap, RAMP, PlayAtomic.
// Three tabs: Pipeline (Kanban by stage), Boards (shortlist comparison), Analytics (funnel, ageing, scouts).
import React, { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Screen, Seg, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../pickers';
import { c, when } from '../theme';
import { t } from '../i18n';

const STAGES = ['prospect', 'identified', 'watching', 'scouted', 'trial', 'shortlisted', 'negotiating', 'offered', 'signed', 'rejected'];
const STAGE_COLOR = { prospect: c.violetSoft, identified: c.cyanSoft, watching: c.cyanSoft, scouted: c.sunSoft, trial: c.sunSoft, shortlisted: c.pinkSoft, negotiating: c.pinkSoft, offered: c.limeSoft, signed: '#d4f5d4', rejected: c.grayLight };
const PRIORITY_COLOR = { high: c.red, normal: c.ink, low: c.mute, watchlist: c.violet };
const COMM_KINDS = ['note', 'call', 'meeting', 'email', 'message', 'decision', 'trial_outcome', 'offer_sent', 'offer_response'];
const EVAL_BASES = ['live_viewing', 'video', 'match_report', 'trial', 'profile_only'];
const SOURCE_KINDS = ['manual', 'billboard', 'scouting', 'transfer', 'academy', 'referral'];
const PRIORITIES = ['high', 'normal', 'low', 'watchlist'];

const newKey = () => `tc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function StagePill({ stage }) {
  return (
    <View style={{ backgroundColor: STAGE_COLOR[stage] ?? c.grayLight, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <T size={11} weight="600">{t(`tc.stage.${stage}`, stage)}</T>
    </View>
  );
}
function PriorityDot({ priority }) {
  return <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: PRIORITY_COLOR[priority] ?? c.mute }} />;
}
function OverduePill() {
  return (
    <View style={{ backgroundColor: '#ffdede', borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 }}>
      <T size={10} weight="700" color={c.red}>{t('tc.overdue', 'OVERDUE')}</T>
    </View>
  );
}

// ── Prospect card (Kanban) ─────────────────────────────────────────────────
function ProspectCard({ p, onPress }) {
  return (
    <Pressable onPress={() => onPress(p)} accessibilityRole="button" accessibilityLabel={`${p.display_name}, ${t(`tc.stage.${p.stage}`, p.stage)}`} style={{ marginBottom: 8 }}>
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <PriorityDot priority={p.priority} />
          <T size={14} weight="600" style={{ flex: 1 }} numberOfLines={1}>{p.display_name}</T>
          {p.last_eval_overall != null ? (
            <View style={{ backgroundColor: p.last_eval_overall >= 7 ? c.limeSoft : p.last_eval_overall >= 5 ? c.sunSoft : c.pinkSoft, borderRadius: 999, minWidth: 24, alignItems: 'center', paddingHorizontal: 4 }}>
              <T size={12} weight="700">{p.last_eval_overall}</T>
            </View>
          ) : null}
        </View>
        <T size={12} color={c.mute}>{p.sport?.name ?? ''}{p.position ? ` · ${p.position}` : ''}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {p.sla_overdue ? <OverduePill /> : <T size={11} color={c.mute}>{p.days_in_stage}d</T>}
          {p.scout_names ? <T size={11} color={c.mute} numberOfLines={1} style={{ flex: 1 }}>{p.scout_names}</T> : null}
        </View>
      </Card>
    </Pressable>
  );
}

// ── Pipeline tab ───────────────────────────────────────────────────────────
function PipelineTab({ orgId, onProspect }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const [sport, setSport] = useState(null);
  const [addStage, setAddStage] = useState(null);
  const [adding, setAdding] = useState(false);
  const { toast } = useSession();

  const data = useLoad(() => api.get(`/organisations/${orgId}/talent-crm/prospects`, { ...(sport ? { sport_id: sport } : {}) }), [orgId, sport]);
  const sports = useLoad(() => api.get('/sports'), []);

  const sportOptions = (sports.data ?? []).map((s) => ({ value: s.id, label: `${s.emoji ?? ''} ${s.name}` }));

  const addProspect = async (v) => {
    setAdding(true);
    try {
      const body = { sport_id: v.sport_id, source_kind: v.source_kind ?? 'manual', priority: v.priority ?? 'normal', position: v.position || undefined };
      if (v.athlete_name) body.athlete_name = v.athlete_name;
      await api.post(`/organisations/${orgId}/talent-crm/prospects`, body);
      setAddStage(null);
      data.reload();
      toast(t('tc.addedProspect', 'Prospect added'));
    } catch (e) { toast(e.message); }
    setAdding(false);
  };

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;

  const { by_stage = {}, kpis = {} } = data.data ?? {};

  const kpiRow = (
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
      {[
        { label: t('tc.kpiTotal', 'Prospects'), value: kpis.total ?? 0 },
        { label: t('tc.kpiSigned', 'Signed'), value: kpis.signed ?? 0 },
        { label: t('tc.kpiOverdue', 'Overdue'), value: kpis.overdue ?? 0, urgent: (kpis.overdue ?? 0) > 0 },
        { label: t('tc.kpiConversion', 'Conv %'), value: `${kpis.conversion_rate ?? 0}%` },
      ].map((m) => (
        <View key={m.label} style={{ flex: 1, alignItems: 'center', backgroundColor: m.urgent ? '#ffdede' : c.paper, borderRadius: 10, padding: 8, minHeight: 56 }}>
          <T size={22} weight="700" color={m.urgent ? c.red : c.ink}>{m.value}</T>
          <T size={10} color={c.mute} style={{ textAlign: 'center' }}>{m.label}</T>
        </View>
      ))}
    </View>
  );

  if (isTablet) {
    return (
      <View style={{ flex: 1 }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          {kpiRow}
          <MenuField label={t('tc.filterSport', 'Filter by sport')} options={[{ value: '', label: t('tc.allSports', 'All sports') }, ...sportOptions]} value={sport ?? ''} onChange={(v) => setSport(v || null)} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}>
          {STAGES.map((stage) => (
            <View key={stage} style={{ width: 220 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <StagePill stage={stage} />
                <T size={12} weight="600" color={c.mute}>{(by_stage[stage] ?? []).length}</T>
                {!['signed', 'rejected'].includes(stage) ? (
                  <Pressable onPress={() => setAddStage(stage)} accessibilityRole="button" accessibilityLabel={t('tc.addProspect', 'Add prospect')} style={{ marginStart: 'auto', minWidth: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={18} color={c.mute}>+</T>
                  </Pressable>
                ) : null}
              </View>
              {(by_stage[stage] ?? []).map((p) => <ProspectCard key={p.id} p={p} onPress={onProspect} />)}
            </View>
          ))}
        </ScrollView>
        <AddProspectSheet visible={!!addStage} initialStage={addStage} orgId={orgId} sportOptions={sportOptions} onClose={() => setAddStage(null)} onSubmit={addProspect} loading={adding} />
      </View>
    );
  }

  // Phone: segmented stage picker + card list
  const [activeStage, setActiveStage] = useState('prospect');
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>{kpiRow}</View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 44 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 6, alignItems: 'center' }}>
        {STAGES.map((s) => (
          <Pressable key={s} onPress={() => setActiveStage(s)} accessibilityRole="tab" accessibilityState={{ selected: s === activeStage }}
            style={{ minHeight: 36, paddingHorizontal: 12, borderRadius: 999, backgroundColor: s === activeStage ? c.ink : c.paper, borderWidth: 1, borderColor: s === activeStage ? c.ink : c.line, justifyContent: 'center' }}>
            <T size={12} weight="600" color={s === activeStage ? c.inkOn : c.mute}>{t(`tc.stage.${s}`, s)} {(by_stage[s] ?? []).length}</T>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {(by_stage[activeStage] ?? []).length ? (by_stage[activeStage]).map((p) => <ProspectCard key={p.id} p={p} onPress={onProspect} />) : (
          <Empty emoji="📋" title={t('tc.emptyStage', 'No prospects at this stage')} sub={t('tc.emptyStageHint', 'Add a prospect or move one here from an adjacent stage.')} />
        )}
        {!['signed', 'rejected'].includes(activeStage) ? <Btn title={t('tc.addProspect', '+ Add prospect')} onPress={() => setAddStage(activeStage)} /> : null}
      </ScrollView>
      <AddProspectSheet visible={!!addStage} initialStage={addStage} orgId={orgId} sportOptions={sportOptions} onClose={() => setAddStage(null)} onSubmit={addProspect} loading={adding} />
    </View>
  );
}

function AddProspectSheet({ visible, initialStage, orgId, sportOptions, onClose, onSubmit, loading }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('tc.addProspect', 'Add prospect')} submitLabel={t('tc.add', 'Add')} loading={loading}
      fields={[
        { key: 'athlete_name', label: t('tc.fieldName', 'Athlete name (off-platform)'), optional: true },
        { key: 'sport_id', label: t('tc.fieldSport', 'Sport'), type: 'menu', options: sportOptions },
        { key: 'position', label: t('tc.fieldPosition', 'Position'), optional: true },
        { key: 'source_kind', label: t('tc.fieldSource', 'Source'), type: 'chips', options: SOURCE_KINDS.map((k) => ({ value: k, label: t(`tc.source.${k}`, k) })), default: 'manual' },
        { key: 'priority', label: t('tc.fieldPriority', 'Priority'), type: 'chips', options: PRIORITIES.map((k) => ({ value: k, label: t(`tc.priority.${k}`, k) })), default: 'normal' },
      ]}
      onSubmit={onSubmit}
    />
  );
}

// ── Prospect file / detail ─────────────────────────────────────────────────
function ProspectFile({ prospectId, onClose, onChanged }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('overview');
  const [moving, setMoving] = useState(false);
  const [moveStage, setMoveStage] = useState(null);

  const data = useLoad(() => (prospectId ? api.get(`/talent-crm/prospects/${prospectId}`) : null), [prospectId]);
  const p = data.data;

  const moveToStage = async (toStage) => {
    setMoving(true);
    try {
      await api.post(`/talent-crm/prospects/${prospectId}/stage`, { to_stage: toStage, row_version: p.row_version });
      setMoveStage(null);
      data.reload();
      onChanged?.();
      toast(t('tc.stageMoved', 'Stage updated'));
    } catch (e) {
      if (e.details?.code === 'stale_version') { toast(t('tc.staleVersion', 'Changed elsewhere — reload and try again')); data.reload(); }
      else toast(e.message);
    }
    setMoving(false);
  };

  if (!prospectId) return null;
  if (data.loading && !p) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;

  const tabs = [['overview', t('tc.tabOverview', 'Overview')], ['evals', t('tc.tabEvals', 'Evaluations')], ['comms', t('tc.tabComms', 'Communication')], ['history', t('tc.tabHistory', 'History')]];

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: c.line, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T size={18} weight="700" style={{ flex: 1 }}>{p.display_name}</T>
          {onClose ? <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><T size={22}>×</T></Pressable> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <StagePill stage={p.stage} />
          <View style={{ backgroundColor: PRIORITY_COLOR[p.priority] ?? c.mute, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
            <T size={11} weight="600" color="#fff">{t(`tc.priority.${p.priority}`, p.priority)}</T>
          </View>
          {p.sla_overdue ? <OverduePill /> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {!['signed', 'rejected'].includes(p.stage) ? (
            <Btn small title={t('tc.moveStage', 'Move stage')} onPress={() => setMoveStage(true)} />
          ) : null}
        </View>
      </View>

      <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.line }}>
        {tabs.map(([key, label]) => (
          <Pressable key={key} onPress={() => setTab(key)} accessibilityRole="tab" accessibilityState={{ selected: key === tab }}
            style={{ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: key === tab ? c.pink : 'transparent' }}>
            <T size={12} weight={key === tab ? '700' : '400'} color={key === tab ? c.ink : c.mute}>{label}</T>
          </Pressable>
        ))}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {tab === 'overview' ? <OverviewTab p={p} toast={toast} onChanged={data.reload} /> : null}
        {tab === 'evals' ? <EvalsTab prospectId={prospectId} orgId={p.org_id} toast={toast} /> : null}
        {tab === 'comms' ? <CommsTab prospectId={prospectId} toast={toast} /> : null}
        {tab === 'history' ? <HistoryTab events={p.history ?? []} /> : null}
      </ScrollView>

      <FormSheet visible={!!moveStage} onClose={() => setMoveStage(null)} title={t('tc.moveStage', 'Move to stage')} submitLabel={t('tc.move', 'Move')}
        fields={[
          { key: 'to_stage', label: t('tc.targetStage', 'Stage'), type: 'chips', options: STAGES.filter((s) => s !== p.stage).map((s) => ({ value: s, label: t(`tc.stage.${s}`, s) })) },
          { key: 'note', label: t('tc.moveNote', 'Note (optional)'), optional: true, type: 'multiline' },
        ]}
        onSubmit={async (v) => { await moveToStage(v.to_stage); }} loading={moving}
      />
    </View>
  );
}

function OverviewTab({ p, toast, onChanged }) {
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 6 }}>
        <T size={12} weight="700" color={c.mute}>{t('tc.sport', 'Sport & position')}</T>
        <T size={15}>{p.sport_name ?? ''} {p.position ? `· ${p.position}` : ''}</T>
      </View>
      <View style={{ gap: 6 }}>
        <T size={12} weight="700" color={c.mute}>{t('tc.source', 'Source')}</T>
        <T size={15}>{t(`tc.source.${p.source_kind}`, p.source_kind)}</T>
      </View>
      {p.notes ? <View style={{ gap: 6 }}><T size={12} weight="700" color={c.mute}>{t('tc.notes', 'Notes')}</T><T size={14}>{p.notes}</T></View> : null}
      {p.decision_rationale ? <View style={{ gap: 6 }}><T size={12} weight="700" color={c.mute}>{t('tc.decisionRationale', 'Decision rationale')}</T><T size={14}>{p.decision_rationale}</T></View> : null}
      <View style={{ gap: 6 }}>
        <T size={12} weight="700" color={c.mute}>{t('tc.assignedScouts', 'Assigned scouts')}</T>
        {(p.assignments ?? []).length ? p.assignments.map((a) => (
          <View key={a.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <T size={14}>{a.scout_name}</T>
            <T size={12} color={c.mute}>{t(`tc.scoutRole.${a.role}`, a.role)}</T>
            {a.completed_at ? <T size={11} color={c.mute}>{t('tc.completed', 'Completed')}</T> : null}
          </View>
        )) : <T size={13} color={c.mute}>{t('tc.noScouts', 'No scouts assigned')}</T>}
      </View>
    </View>
  );
}

function EvalsTab({ prospectId, orgId, toast }) {
  const data = useLoad(() => api.get(`/talent-crm/prospects/${prospectId}/evaluations`), [prospectId]);
  const templates = useLoad(() => api.get(`/organisations/${orgId}/talent-crm/evaluation-templates`), [orgId]);
  const [addForm, setAddForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (v) => {
    setSubmitting(true);
    try {
      const ratings = {};
      Object.entries(v).forEach(([k, val]) => { if (k.startsWith('crit_')) ratings[k.slice(5)] = Number(val); });
      await api.post(`/talent-crm/prospects/${prospectId}/evaluations`, {
        template_id: v.template_id || undefined,
        basis: v.basis,
        observed_on: v.observed_on || undefined,
        ratings,
        notes: v.notes || undefined,
        idempotency_key: newKey(),
      });
      setAddForm(false);
      data.reload();
      toast(t('tc.evalSaved', 'Evaluation saved'));
    } catch (e) { toast(e.message); }
    setSubmitting(false);
  };

  const templateOptions = [{ value: '', label: t('tc.customTemplate', 'Custom (no template)') }, ...(templates.data ?? []).map((t2) => ({ value: t2.id, label: t2.name }))];

  return (
    <View style={{ gap: 12 }}>
      <Btn small title={t('tc.addEval', '+ New evaluation')} onPress={() => setAddForm(true)} />
      {data.loading && !data.data ? <Loading /> : (data.data ?? []).length ? (data.data).map((e) => (
        <Card key={e.id} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T size={15} weight="700">{e.scout_name}</T>
            {e.overall != null ? (
              <View style={{ backgroundColor: e.overall >= 7 ? c.limeSoft : e.overall >= 5 ? c.sunSoft : c.pinkSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                <T size={13} weight="700">{e.overall}/10</T>
              </View>
            ) : null}
            <T size={12} color={c.mute} style={{ marginStart: 'auto' }}>{new Date(e.created_at).toLocaleDateString()}</T>
          </View>
          <T size={12} color={c.mute}>{t(`tc.evalBasis.${e.basis}`, e.basis)}{e.observed_on ? ` · ${e.observed_on}` : ''}{e.template_name ? ` · ${e.template_name}` : ''}</T>
          {e.notes ? <T size={13}>{e.notes}</T> : null}
        </Card>
      )) : <Empty emoji="📊" title={t('tc.noEvals', 'No evaluations yet')} sub={t('tc.noEvalsHint', 'Add the first evaluation to start tracking this prospect\'s quality.')} />}

      <FormSheet visible={addForm} onClose={() => setAddForm(false)} title={t('tc.newEval', 'New evaluation')} submitLabel={t('tc.saveEval', 'Save evaluation')} loading={submitting}
        fields={[
          { key: 'template_id', label: t('tc.evalTemplate', 'Template'), type: 'menu', options: templateOptions, optional: true },
          { key: 'basis', label: t('tc.evalBasis', 'Basis'), type: 'chips', options: EVAL_BASES.map((b) => ({ value: b, label: t(`tc.evalBasis.${b}`, b) })) },
          { key: 'observed_on', label: t('tc.evalObservedOn', 'Observed on'), type: 'date', optional: true },
          { key: 'crit_technical', label: t('tc.evalCritTechnical', 'Technical (0–10)'), type: 'stepper', min: 0, max: 10, default: 5, optional: true },
          { key: 'crit_tactical', label: t('tc.evalCritTactical', 'Tactical (0–10)'), type: 'stepper', min: 0, max: 10, default: 5, optional: true },
          { key: 'crit_physical', label: t('tc.evalCritPhysical', 'Physical (0–10)'), type: 'stepper', min: 0, max: 10, default: 5, optional: true },
          { key: 'crit_mental', label: t('tc.evalCritMental', 'Mental (0–10)'), type: 'stepper', min: 0, max: 10, default: 5, optional: true },
          { key: 'notes', label: t('tc.evalNotes', 'Notes'), type: 'multiline', optional: true },
        ]}
        onSubmit={submit}
      />
    </View>
  );
}

function CommsTab({ prospectId, toast }) {
  const data = useLoad(() => api.get(`/talent-crm/prospects/${prospectId}/communications`), [prospectId]);
  const [addForm, setAddForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (v) => {
    setSubmitting(true);
    try {
      await api.post(`/talent-crm/prospects/${prospectId}/communications`, { kind: v.kind, summary: v.summary, follow_up_on: v.follow_up_on || undefined, idempotency_key: newKey() });
      setAddForm(false);
      data.reload();
      toast(t('tc.commLogged', 'Logged'));
    } catch (e) { toast(e.message); }
    setSubmitting(false);
  };

  const KIND_EMOJI = { note: '📝', call: '📞', meeting: '🤝', email: '📧', message: '💬', decision: '⚖️', trial_outcome: '🏃', offer_sent: '📄', offer_response: '📬' };

  return (
    <View style={{ gap: 12 }}>
      <Btn small title={t('tc.logComm', '+ Log communication')} onPress={() => setAddForm(true)} />
      {data.loading && !data.data ? <Loading /> : (data.data ?? []).length ? (data.data).map((c2) => (
        <Card key={c2.id} style={{ gap: 4, borderStartWidth: 3, borderStartColor: c.cyanSoft }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T size={16}>{KIND_EMOJI[c2.kind] ?? '📝'}</T>
            <T size={14} weight="600">{c2.actor_name}</T>
            <T size={12} color={c.mute} style={{ marginStart: 'auto' }}>{new Date(c2.created_at).toLocaleDateString()}</T>
          </View>
          <T size={13}>{c2.summary}</T>
          {c2.follow_up_on ? <T size={11} color={c.mute}>{t('tc.followUp', 'Follow-up')}: {c2.follow_up_on}</T> : null}
        </Card>
      )) : <Empty emoji="💬" title={t('tc.noComms', 'No communications yet')} sub={t('tc.noCommsHint', 'Log calls, meetings and decisions to build a full recruitment history.')} />}

      <FormSheet visible={addForm} onClose={() => setAddForm(false)} title={t('tc.logComm', 'Log communication')} submitLabel={t('tc.log', 'Log')} loading={submitting}
        fields={[
          { key: 'kind', label: t('tc.commKind', 'Type'), type: 'chips', options: COMM_KINDS.map((k) => ({ value: k, label: `${KIND_EMOJI[k]} ${t(`tc.comm.${k}`, k)}` })), default: 'note' },
          { key: 'summary', label: t('tc.commSummary', 'Summary'), type: 'multiline' },
          { key: 'follow_up_on', label: t('tc.commFollowUp', 'Follow-up date'), type: 'date', optional: true },
        ]}
        onSubmit={submit}
      />
    </View>
  );
}

function HistoryTab({ events }) {
  const ACTION_EMOJI = { created: '🌱', stage_moved: '→', evaluation_added: '📊', scout_assigned: '👤', assignment_completed: '✅', archived: '🗃️', handoff_initiated: '🤝', decision_logged: '⚖️', updated: '✏️' };
  if (!events.length) return <Empty emoji="📋" title={t('tc.noHistory', 'No history yet')} />;
  return (
    <View style={{ gap: 8 }}>
      {events.map((e, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <T size={16} style={{ width: 24 }}>{ACTION_EMOJI[e.action] ?? '•'}</T>
          <View style={{ flex: 1 }}>
            <T size={13} weight="600">{e.action.replace(/_/g, ' ')}{e.from_stage ? ` (${e.from_stage} → ${e.to_stage})` : ''}</T>
            <T size={12} color={c.mute}>{e.actor_name} · {new Date(e.created_at).toLocaleDateString()}</T>
          </View>
        </View>
      ))}
    </View>
  );
}

// ── Boards tab ─────────────────────────────────────────────────────────────
function BoardsTab({ orgId }) {
  const { toast } = useSession();
  const [openBoard, setOpenBoard] = useState(null);
  const [createForm, setCreateForm] = useState(false);
  const data = useLoad(() => api.get(`/organisations/${orgId}/talent-crm/boards`), [orgId]);
  const sports = useLoad(() => api.get('/sports'), []);
  const sportOptions = (sports.data ?? []).map((s) => ({ value: s.id, label: `${s.emoji ?? ''} ${s.name}` }));

  const createBoard = async (v) => {
    try {
      await api.post(`/organisations/${orgId}/talent-crm/boards`, { name: v.name, sport_id: v.sport_id || undefined, position: v.position || undefined });
      setCreateForm(false);
      data.reload();
      toast(t('tc.boardCreated', 'Board created'));
    } catch (e) { toast(e.message); }
  };

  if (openBoard) return <BoardDetail boardId={openBoard} orgId={orgId} onBack={() => setOpenBoard(null)} />;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Btn title={t('tc.newBoard', '+ New shortlist board')} onPress={() => setCreateForm(true)} />
      {data.loading && !data.data ? <Loading /> : (data.data ?? []).length ? (data.data).map((b) => (
        <Pressable key={b.id} onPress={() => setOpenBoard(b.id)} accessibilityRole="button" accessibilityLabel={`${b.name}, ${b.entry_count} prospects`}>
          <Card style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T size={15} weight="700" style={{ flex: 1 }}>{b.name}</T>
              <T size={13} color={c.mute}>{b.entry_count}</T>
            </View>
            {(b.sport_name || b.position) ? <T size={12} color={c.mute}>{[b.sport_name, b.position].filter(Boolean).join(' · ')}</T> : null}
            {(b.preview_names ?? []).length ? <T size={12} color={c.mute} numberOfLines={1}>{b.preview_names.join(', ')}{b.entry_count > 4 ? ` +${b.entry_count - 4}` : ''}</T> : null}
          </Card>
        </Pressable>
      )) : <Empty emoji="📋" title={t('tc.noBoards', 'No shortlist boards')} sub={t('tc.noBoardsHint', 'Create a board to compare prospects side-by-side for a position.')} />}

      <FormSheet visible={createForm} onClose={() => setCreateForm(false)} title={t('tc.newBoard', 'New shortlist board')} submitLabel={t('tc.create', 'Create')}
        fields={[
          { key: 'name', label: t('tc.boardName', 'Board name') },
          { key: 'sport_id', label: t('tc.boardSport', 'Sport'), type: 'menu', options: [{ value: '', label: t('tc.allSports', 'Any sport') }, ...sportOptions], optional: true },
          { key: 'position', label: t('tc.boardPosition', 'Position'), optional: true },
        ]}
        onSubmit={createBoard}
      />
    </ScrollView>
  );
}

function BoardDetail({ boardId, orgId, onBack }) {
  const { toast } = useSession();
  const data = useLoad(() => api.get(`/talent-crm/boards/${boardId}`), [boardId]);
  const { board, entries = [] } = data.data ?? {};
  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={t('tc.back', 'Back')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><T size={18}>←</T></Pressable>
        <T size={16} weight="700" style={{ flex: 1 }}>{board?.name}</T>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        {entries.length ? entries.map((e) => (
          <Card key={e.entry_id} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {e.rank ? <T size={16} weight="700" color={c.mute}>#{e.rank}</T> : null}
              <T size={15} weight="700" style={{ flex: 1 }}>{e.display_name}</T>
              {e.last_overall != null ? (
                <View style={{ backgroundColor: e.last_overall >= 7 ? c.limeSoft : e.last_overall >= 5 ? c.sunSoft : c.pinkSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <T size={13} weight="700">{e.last_overall}/10</T>
                </View>
              ) : null}
            </View>
            <StagePill stage={e.stage} />
            {e.last_scout_name ? <T size={12} color={c.mute}>{t('tc.lastEvalBy', 'Last eval by')} {e.last_scout_name}{e.eval_date ? ` · ${e.eval_date}` : ''}</T> : null}
            {e.notes ? <T size={13}>{e.notes}</T> : null}
          </Card>
        )) : <Empty emoji="👥" title={t('tc.emptyBoard', 'Board is empty')} sub={t('tc.emptyBoardHint', 'Go to a prospect\'s file and add them to this board.')} />}
      </ScrollView>
    </View>
  );
}

// ── Analytics tab ──────────────────────────────────────────────────────────
function AnalyticsTab({ orgId }) {
  const data = useLoad(() => api.get(`/organisations/${orgId}/talent-crm/analytics`), [orgId]);
  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const { funnel = [], kpis = {}, ageing = [], by_source = [], by_scout = [] } = data.data ?? {};

  const maxCount = Math.max(1, ...funnel.map((f) => f.count));

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 20 }}>
      {/* KPI strip */}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {[
          { label: t('tc.kpiTotal', 'Total'), value: kpis.total ?? 0 },
          { label: t('tc.kpiSigned', 'Signed'), value: kpis.signed ?? 0 },
          { label: t('tc.kpiConversion', 'Conversion'), value: `${kpis.conversion_rate ?? 0}%` },
          { label: t('tc.kpiMedianDays', 'Median days'), value: kpis.median_days_signed ?? '—' },
        ].map((m) => (
          <View key={m.label} style={{ flex: 1, flexBasis: 120, backgroundColor: c.paper, borderRadius: 10, padding: 12, minHeight: 64, alignItems: 'center' }}>
            <T size={24} weight="700">{m.value}</T>
            <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{m.label}</T>
          </View>
        ))}
      </View>

      {/* Stage funnel */}
      <View style={{ gap: 8 }}>
        <T size={15} weight="700">{t('tc.analyticsFunnel', 'Pipeline funnel')}</T>
        {funnel.map((f) => (
          <View key={f.stage} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T size={12} style={{ width: 100 }}>{t(`tc.stage.${f.stage}`, f.stage)}</T>
              <View style={{ flex: 1, height: 20, backgroundColor: c.line, borderRadius: 4, overflow: 'hidden' }}>
                <View style={{ width: `${(f.count / maxCount) * 100}%`, height: '100%', backgroundColor: STAGE_COLOR[f.stage] ?? c.cyanSoft }} />
              </View>
              <T size={12} weight="600" style={{ width: 30, textAlign: 'end' }}>{f.count}</T>
            </View>
          </View>
        ))}
      </View>

      {/* Ageing alerts */}
      {ageing.length ? (
        <View style={{ gap: 8 }}>
          <T size={15} weight="700" color={c.red}>{t('tc.agingAlerts', 'Ageing alerts')} ({ageing.length})</T>
          {ageing.slice(0, 10).map((a) => (
            <View key={a.prospect_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff4f4', borderRadius: 8, padding: 10 }}>
              <T size={12} style={{ flex: 1 }}>{t(`tc.stage.${a.stage}`, a.stage)}</T>
              <T size={12} color={c.red} weight="600">{a.days_in_stage}d / {a.sla_days}d SLA</T>
            </View>
          ))}
        </View>
      ) : null}

      {/* Source quality */}
      {by_source.length ? (
        <View style={{ gap: 8 }}>
          <T size={15} weight="700">{t('tc.analyticsBySource', 'Source quality')}</T>
          {by_source.map((s) => (
            <View key={s.source_kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T size={13} style={{ width: 110 }}>{t(`tc.source.${s.source_kind}`, s.source_kind)}</T>
              <T size={13} weight="600">{s.count}</T>
              <T size={12} color={c.mute}>({s.signed} signed, {s.count > 0 ? Math.round((s.signed / s.count) * 100) : 0}%)</T>
            </View>
          ))}
        </View>
      ) : null}

      {/* Scout performance */}
      {by_scout.length ? (
        <View style={{ gap: 8 }}>
          <T size={15} weight="700">{t('tc.analyticsByScout', 'Scout performance')}</T>
          {by_scout.map((s) => (
            <Row key={s.id} title={s.display_name} sub={`${s.evaluations} ${t('tc.evaluations', 'evals')} · ${s.prospects_advanced} ${t('tc.advanced', 'advanced')}`} />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

// ── Root screen ────────────────────────────────────────────────────────────
export function TalentCRM({ route }) {
  const { org_id: orgId } = route?.params ?? {};
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const [tab, setTab] = useState('pipeline');
  const [openProspect, setOpenProspect] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  if (!orgId) {
    return (
      <Screen title={t('tc.title', 'Talent CRM')}>
        <Empty emoji="🏟️" title={t('tc.noOrg', 'No organisation selected')} sub={t('tc.noOrgHint', 'Open Talent CRM from your organisation workspace or team.')} />
      </Screen>
    );
  }

  const tabs = [['pipeline', t('tc.tabPipeline', 'Pipeline')], ['boards', t('tc.tabBoards', 'Boards')], ['analytics', t('tc.tabAnalytics', 'Analytics')]];

  if (isTablet && openProspect) {
    return (
      <Screen title={t('tc.title', 'Talent CRM')}>
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.line, paddingHorizontal: 16 }}>
              {tabs.map(([key, label]) => (
                <Pressable key={key} onPress={() => setTab(key)} accessibilityRole="tab" accessibilityState={{ selected: key === tab }}
                  style={{ minHeight: 48, paddingHorizontal: 14, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: key === tab ? c.pink : 'transparent' }}>
                  <T size={13} weight={key === tab ? '700' : '400'} color={key === tab ? c.ink : c.mute}>{label}</T>
                </Pressable>
              ))}
            </View>
            {tab === 'pipeline' ? <PipelineTab orgId={orgId} onProspect={(p) => setOpenProspect(p.id)} /> : null}
            {tab === 'boards' ? <BoardsTab orgId={orgId} /> : null}
            {tab === 'analytics' ? <AnalyticsTab orgId={orgId} /> : null}
          </View>
          <View style={{ width: 380, borderStartWidth: 1, borderStartColor: c.line }}>
            <ProspectFile key={openProspect} prospectId={openProspect} onClose={() => setOpenProspect(null)} onChanged={() => setReloadKey((k) => k + 1)} />
          </View>
        </View>
      </Screen>
    );
  }

  if (openProspect) {
    return (
      <Screen title={t('tc.title', 'Talent CRM')}>
        <ProspectFile key={openProspect} prospectId={openProspect} onClose={() => setOpenProspect(null)} onChanged={() => { setReloadKey((k) => k + 1); setOpenProspect(null); }} />
      </Screen>
    );
  }

  return (
    <Screen title={t('tc.title', 'Talent CRM')}>
      <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.line }}>
        {tabs.map(([key, label]) => (
          <Pressable key={key} onPress={() => setTab(key)} accessibilityRole="tab" accessibilityState={{ selected: key === tab }}
            style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: key === tab ? c.pink : 'transparent' }}>
            <T size={13} weight={key === tab ? '700' : '400'} color={key === tab ? c.ink : c.mute}>{label}</T>
          </Pressable>
        ))}
      </View>
      {tab === 'pipeline' ? <PipelineTab key={reloadKey} orgId={orgId} onProspect={(p) => setOpenProspect(p.id)} /> : null}
      {tab === 'boards' ? <BoardsTab orgId={orgId} /> : null}
      {tab === 'analytics' ? <AnalyticsTab orgId={orgId} /> : null}
    </Screen>
  );
}
