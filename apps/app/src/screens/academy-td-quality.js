// Academy OS P1 / #791: TD Quality Observations and Coach Improvement Plans.
import React, { useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';

const PILLARS = ['technical', 'tactical', 'physical', 'mental', 'lifestyle'];
const OBS_STATUS_COLORS = { draft: c.mute, submitted: c.amber, released: c.green };
const PLAN_STATUS_COLORS = { active: c.green, review: c.amber, completed: c.mute, withdrawn: c.mute };

// ── Pure-RN pillar bar chart ──────────────────────────────────────────────────
function PillarBarsChart({ data }) {
  const max = 5;
  if (!data || data.length === 0) return null;
  return (
    <View style={{ marginVertical: 8 }}>
      <T size={12} weight="700" color={c.mute} style={{ marginBottom: 6 }}>{t('cEdu.obs.qualityTrend')}</T>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 80, gap: 8 }}>
        {data.map((d) => (
          <View key={d.pillar} style={{ flex: 1, alignItems: 'center' }}>
            <T size={10} weight="800" color={c.pink}>{Number(d.avg ?? 0).toFixed(1)}</T>
            <View style={{ width: '100%', height: ((d.avg ?? 0) / max) * 70, backgroundColor: c.pinkSoft ?? c.pink + '33', borderRadius: 4 }} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        {data.map((d) => (
          <T key={d.pillar} size={10} color={c.mute} style={{ flex: 1, textAlign: 'center' }}>{t(`cEdu.pillar.${d.pillar}`)}</T>
        ))}
      </View>
    </View>
  );
}

// ── Rating stars ──────────────────────────────────────────────────────────────
function RatingRow({ value, onChange, label }) {
  return (
    <View style={{ marginBottom: 8 }}>
      {label && <T size={12} color={c.mute} style={{ marginBottom: 4 }}>{label}</T>}
      <Row style={{ gap: 6 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => onChange?.(n)} style={{ padding: 6, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <T size={22} color={n <= (value ?? 0) ? c.amber : c.mute}>★</T>
          </Pressable>
        ))}
      </Row>
    </View>
  );
}

// ── Observation Form ──────────────────────────────────────────────────────────
export function ObservationForm({ org, observation, onSave, onClose }) {
  const [form, setForm] = useState({
    overall_rating: observation?.overall_rating ?? null,
    pillar_ratings: observation?.pillar_ratings ?? {},
    next_steps: observation?.next_steps ?? '',
    strengths: '',
    development: '',
    ...(observation ?? {}),
  });

  const save = async () => {
    try {
      if (observation?.id) {
        await api('PATCH', `/academy/td-observations/${observation.id}`, {
          body: { ...form, row_version: observation.row_version },
        });
      } else {
        await api('POST', `/organisations/${org.id}/academy/td-observations`, { body: form });
      }
      onSave?.();
    } catch (e) { alert(explain(e)); }
  };

  const setPillarRating = (pillar, key, val) => {
    setForm((f) => ({
      ...f,
      pillar_ratings: {
        ...f.pillar_ratings,
        [pillar]: { ...(f.pillar_ratings?.[pillar] ?? {}), [key]: val },
      },
    }));
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <T weight="700" style={{ marginBottom: 12 }}>{t('cEdu.obs.pillars')}</T>
      {PILLARS.map((pillar) => (
        <View key={pillar} style={{ marginBottom: 12 }}>
          <T size={13} weight="600" color={c.pink} style={{ marginBottom: 4 }}>{t(`cEdu.pillar.${pillar}`)}</T>
          <RatingRow
            value={Object.values(form.pillar_ratings?.[pillar] ?? {}).reduce((s, v) => s + v, 0) / Math.max(Object.keys(form.pillar_ratings?.[pillar] ?? {}).length, 1)}
            label={t(`cEdu.pillar.${pillar}`)}
          />
        </View>
      ))}
      <T weight="700" style={{ marginBottom: 8 }}>{t('cEdu.obs.overall')}</T>
      <RatingRow value={form.overall_rating} onChange={(v) => setForm((f) => ({ ...f, overall_rating: v }))} />
      <T size={12} color={c.mute} style={{ marginVertical: 8 }}>{t('cEdu.obs.privateNote')}</T>
      <T style={{ marginBottom: 4 }}>{t('cEdu.obs.strengths')}</T>
      {/* strengths textarea */}
      <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.obs.development')}</T>
      {/* development textarea */}
      <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.obs.nextSteps')}</T>
      {/* next_steps textarea */}
      <Btn label={observation?.id ? 'Save' : t('cEdu.obs.submit')} variant="primary" style={{ marginTop: 20 }} onPress={save} />
    </ScrollView>
  );
}

// ── Observation List ──────────────────────────────────────────────────────────
export function ObservationList({ org, role }) {
  const [sheet, setSheet] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const isGovern = role === 'admin' || role === 'owner' || role === 'td';

  const { data: observations, reload, loading, error } = useLoad(() =>
    api('GET', `/organisations/${org.id}/academy/td-observations`, { query: { status: filterStatus, limit: 100 } }),
    [filterStatus],
  );

  const submit = async (obs) => {
    try {
      await api('POST', `/academy/td-observations/${obs.id}/submit`, { body: { row_version: obs.row_version } });
      reload();
    } catch (e) { alert(explain(e)); }
  };

  const release = async (obs) => {
    try {
      await api('POST', `/academy/td-observations/${obs.id}/release`, { body: { row_version: obs.row_version } });
      reload();
    } catch (e) { alert(explain(e)); }
  };

  // Compute pillar averages across all observations for the chart
  const pillarData = PILLARS.map((pillar) => {
    const ratings = (observations ?? []).flatMap((obs) => {
      const pr = obs.pillar_ratings ?? {};
      return Object.values(pr[pillar] ?? {}).map(Number);
    }).filter(Boolean);
    return { pillar, avg: ratings.length ? ratings.reduce((s, v) => s + v, 0) / ratings.length : 0 };
  });

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  return (
    <View>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <T weight="700">{t('cEdu.obs.title')}</T>
        {isGovern && <Btn label={t('cEdu.obs.newObs')} size="sm" onPress={() => { setSelected(null); setSheet('obs'); }} />}
      </Row>
      <Seg tabs={[{ key: 'all', label: 'All' }, { key: 'draft', label: t('cEdu.obs.draft') }, { key: 'submitted', label: 'Submitted' }, { key: 'released', label: t('cEdu.obs.released') }]}
        active={filterStatus} onChange={setFilterStatus} style={{ marginBottom: 12 }} />
      <PillarBarsChart data={pillarData} />
      {(!observations || observations.length === 0) ? (
        <Empty title={t('cEdu.empty.observations')} action={isGovern ? { label: t('cEdu.obs.newObs'), onPress: () => { setSelected(null); setSheet('obs'); } } : undefined} />
      ) : observations.map((obs) => (
        <Card key={obs.id} style={{ marginBottom: 8 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <T size={12} color={c.mute}>{new Date(obs.created_at).toLocaleDateString()}</T>
              <Row style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                <Tag color={OBS_STATUS_COLORS[obs.status] ?? c.mute}>{obs.status}</Tag>
                {obs.overall_rating != null && (
                  <Tag color={c.amber}>{'★'.repeat(obs.overall_rating)}</Tag>
                )}
              </Row>
            </View>
            <View style={{ gap: 6, alignItems: 'flex-end' }}>
              {isGovern && obs.status === 'draft' && (
                <Btn label={t('cEdu.obs.submit')} size="xs" onPress={() => submit(obs)} />
              )}
              {isGovern && obs.status === 'submitted' && (
                <Btn label={t('cEdu.obs.release')} size="xs" variant="primary" onPress={() => release(obs)} />
              )}
            </View>
          </Row>
        </Card>
      ))}
      <FormSheet visible={sheet === 'obs'} title={t('cEdu.obs.newObs')} onClose={() => setSheet(null)} onSave={() => { reload(); setSheet(null); }}>
        <ObservationForm org={org} observation={selected} onSave={() => { reload(); setSheet(null); }} onClose={() => setSheet(null)} />
      </FormSheet>
    </View>
  );
}

// ── Improvement Plan Detail ───────────────────────────────────────────────────
export function ImprovementPlanDetail({ plan, org, role, onBack }) {
  const [sheet, setSheet] = useState(null);
  const [form, setForm] = useState({});
  const isGovern = role === 'admin' || role === 'owner' || role === 'td';

  const { data: fullPlan, reload, loading, error } = useLoad(() =>
    api('GET', `/academy/improvement-plans/${plan.id}`),
    [plan.id],
  );

  const addAction = async () => {
    try {
      await api('POST', `/academy/improvement-plans/${plan.id}/actions`, { body: form });
      reload();
      setSheet(null);
    } catch (e) { alert(explain(e)); }
  };

  const updateAction = async (action, status) => {
    try {
      await api('PATCH', `/academy/improvement-actions/${action.id}`, { body: { row_version: action.row_version, status } });
      reload();
    } catch (e) { alert(explain(e)); }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  const p = fullPlan ?? plan;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <Btn label="← Back" size="sm" variant="ghost" onPress={onBack} style={{ marginBottom: 12 }} />
      <Card style={{ marginBottom: 16 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T weight="700" style={{ flex: 1 }}>{p.title}</T>
          <Tag color={PLAN_STATUS_COLORS[p.status] ?? c.mute}>{t(`cEdu.imp.status.${p.status}`)}</Tag>
        </Row>
        <Row style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {(p.focus_pillars ?? []).map((pillar) => (
            <Tag key={pillar} color={c.pink}>{t(`cEdu.pillar.${pillar}`)}</Tag>
          ))}
        </Row>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>
          {t('cEdu.imp.starts')}: {p.starts_on}
          {p.review_on ? ` · ${t('cEdu.imp.review')}: ${p.review_on}` : ''}
          {p.ends_on ? ` · ${t('cEdu.imp.ends')}: ${p.ends_on}` : ''}
        </T>
        {p.summary && <T size={13} style={{ marginTop: 8 }}>{p.summary}</T>}
      </Card>

      <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <T weight="700">Actions</T>
        {isGovern && p.status !== 'completed' && p.status !== 'withdrawn' && (
          <Btn label={t('cEdu.imp.addAction')} size="sm" onPress={() => { setForm({ kind: 'cpd' }); setSheet('action'); }} />
        )}
      </Row>
      {(!p.actions || p.actions.length === 0) ? (
        <Empty title="No actions yet." />
      ) : p.actions.map((act) => (
        <Card key={act.id} style={{ marginBottom: 8, paddingStart: 12, borderStartWidth: 3, borderStartColor: act.status === 'done' ? c.green : act.status === 'cancelled' ? c.mute : c.amber }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <T weight="600">{act.title}</T>
              <Row style={{ gap: 6, marginTop: 4 }}>
                <Tag>{t(`cEdu.imp.action.kind.${act.kind}`)}</Tag>
                <Tag color={act.status === 'done' ? c.green : act.status === 'cancelled' ? c.mute : c.amber}>{act.status}</Tag>
              </Row>
              {act.due_on && <T size={12} color={c.mute} style={{ marginTop: 4 }}>Due: {act.due_on}</T>}
              {act.evidence && <T size={12} color={c.mute}>{act.evidence}</T>}
            </View>
            {act.status === 'open' && (
              <Btn label="Done" size="xs" onPress={() => updateAction(act, 'done')} />
            )}
          </Row>
        </Card>
      ))}

      <FormSheet visible={sheet === 'action'} title={t('cEdu.imp.addAction')} onClose={() => setSheet(null)} onSave={addAction}>
        <T style={{ marginBottom: 4 }}>Action title</T>
        {/* title input */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>Type</T>
        {/* kind picker */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>Due date</T>
        {/* due_on date picker */}
      </FormSheet>
    </ScrollView>
  );
}

// ── TD Quality Hub (main) ─────────────────────────────────────────────────────
export default function TdQualityHub({ org, role }) {
  const [tab, setTab] = useState('observations');
  const [selectedPlan, setSelectedPlan] = useState(null);
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const isGovern = role === 'admin' || role === 'owner' || role === 'td';

  const { data: plans, reload: reloadPlans, loading: plansLoading, error: plansError } = useLoad(() =>
    api('GET', `/organisations/${org.id}/academy/improvement-plans`, { query: { status: 'all', limit: 100 } }),
  );

  const [sheet, setSheet] = useState(null);
  const [form, setForm] = useState({});

  const createPlan = async () => {
    try {
      await api('POST', `/organisations/${org.id}/academy/improvement-plans`, { body: form });
      reloadPlans();
      setSheet(null);
    } catch (e) { alert(explain(e)); }
  };

  if (selectedPlan) {
    return <ImprovementPlanDetail plan={selectedPlan} org={org} role={role} onBack={() => setSelectedPlan(null)} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <Seg
        tabs={[
          { key: 'observations', label: t('cEdu.tab.observations') },
          { key: 'plans', label: t('cEdu.tab.plans') },
        ]}
        active={tab}
        onChange={setTab}
        style={{ marginBottom: 16 }}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {tab === 'observations' && <ObservationList org={org} role={role} />}
        {tab === 'plans' && (
          <View>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <T weight="700">{t('cEdu.imp.title')}</T>
              {isGovern && <Btn label={t('cEdu.imp.newPlan')} size="sm" onPress={() => { setForm({ focus_pillars: [], status: 'active' }); setSheet('plan'); }} />}
            </Row>
            {plansLoading ? <Loading /> : plansError ? <ErrorBox error={plansError} retry={reloadPlans} /> : (
              (!plans || plans.length === 0) ? (
                <Empty title={t('cEdu.empty.plans')} action={isGovern ? { label: t('cEdu.imp.newPlan'), onPress: () => { setForm({ focus_pillars: [], status: 'active' }); setSheet('plan'); } } : undefined} />
              ) : plans.map((p) => (
                <Pressable key={p.id} onPress={() => setSelectedPlan(p)}>
                  <Card style={{ marginBottom: 8 }}>
                    <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <View style={{ flex: 1 }}>
                        <T weight="600">{p.title}</T>
                        <Row style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                          <Tag color={PLAN_STATUS_COLORS[p.status] ?? c.mute}>{t(`cEdu.imp.status.${p.status}`)}</Tag>
                          {(p.focus_pillars ?? []).slice(0, 2).map((pillar) => (
                            <Tag key={pillar} color={c.pink} size="xs">{t(`cEdu.pillar.${pillar}`)}</Tag>
                          ))}
                        </Row>
                        <T size={12} color={c.mute} style={{ marginTop: 4 }}>
                          {p.open_actions ?? 0} open · {p.done_actions ?? 0} done
                        </T>
                      </View>
                      <T size={20} color={c.mute}>›</T>
                    </Row>
                  </Card>
                </Pressable>
              ))
            )}
            <FormSheet visible={sheet === 'plan'} title={t('cEdu.imp.newPlan')} onClose={() => setSheet(null)} onSave={createPlan}>
              <T style={{ marginBottom: 4 }}>Plan title</T>
              {/* title input */}
              <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.imp.focusPillars')}</T>
              {/* focus_pillars multi-select */}
              <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.imp.starts')}</T>
              {/* starts_on date picker */}
              <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.imp.review')}</T>
              {/* review_on date picker */}
            </FormSheet>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
