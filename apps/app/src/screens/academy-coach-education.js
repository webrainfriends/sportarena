// Academy OS P1 / #791: Coach Education hub — My CPD, Module Library, Review Queue, Appeals.
import React, { useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';

const KINDS = ['induction', 'cpd', 'credential', 'recertification', 'assessment', 'workshop', 'conference', 'other'];
const EVIDENCE_KINDS = ['certificate', 'external_course', 'reflection', 'observation_ref', 'credential_ref', 'attendance', 'other'];
const PILLARS = ['technical', 'tactical', 'physical', 'mental', 'lifestyle'];

const kpiColor = { approved: c.green, overdue: c.red, in_progress: c.amber, assigned: c.mute };

function KpiStrip({ stats }) {
  const items = [
    { key: 'completed', label: t('cEdu.kpi.completed'), value: stats.mandatory_done ?? 0, color: c.green },
    { key: 'overdue', label: t('cEdu.kpi.overdue'), value: stats.overdue ?? 0, color: c.red },
    { key: 'inProgress', label: t('cEdu.kpi.inProgress'), value: stats.in_progress ?? 0, color: c.amber },
    { key: 'cpdHours', label: t('cEdu.kpi.cpdHours'), value: Number(stats.cpd_hours_earned ?? 0).toFixed(1), color: c.pink },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
      {items.map((it) => (
        <Card key={it.key} style={{ flex: 1, alignItems: 'center', paddingVertical: 12 }}>
          <T size={22} weight="800" color={it.color}>{it.value}</T>
          <T size={11} color={c.mute} style={{ marginTop: 2, textAlign: 'center' }}>{it.label}</T>
        </Card>
      ))}
    </View>
  );
}

function StatusTag({ status }) {
  const colors = {
    approved: c.green, assigned: c.mute, in_progress: c.amber, submitted: c.blue,
    rejected: c.red, appealing: c.amber, expired: c.mute,
  };
  return <Tag color={colors[status] ?? c.mute}>{t(`cEdu.mod.kind.${status}`) ?? status}</Tag>;
}

// ── Module Library (TD/admin view) ────────────────────────────────────────────
export function EduModuleLibrary({ org }) {
  const [sheet, setSheet] = useState(null);
  const [form, setForm] = useState({});
  const { data: modules, reload, loading, error } = useLoad(() =>
    api('GET', `/organisations/${org.id}/academy/edu-modules`, { query: { status: 'all', limit: 100 } }),
  );

  const save = async () => {
    try {
      if (form.id) {
        await api('PATCH', `/academy/edu-modules/${form.id}`, { body: { ...form } });
      } else {
        await api('POST', `/organisations/${org.id}/academy/edu-modules`, { body: { ...form } });
      }
      setSheet(null);
      reload();
    } catch (e) { alert(explain(e)); }
  };

  const publish = async (mod) => {
    try {
      await api('PATCH', `/academy/edu-modules/${mod.id}`, { body: { row_version: mod.row_version, status: 'published' } });
      reload();
    } catch (e) { alert(explain(e)); }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  return (
    <View>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <T weight="700">{t('cEdu.mod.lib')}</T>
        <Btn label={t('cEdu.mod.new')} size="sm" onPress={() => { setForm({ kind: 'cpd', mandatory: false }); setSheet('module'); }} />
      </Row>
      {(!modules || modules.length === 0) ? (
        <Empty title={t('cEdu.empty.modules')} action={{ label: t('cEdu.mod.new'), onPress: () => { setForm({ kind: 'cpd', mandatory: false }); setSheet('module'); } }} />
      ) : modules.map((m) => (
        <Card key={m.id} style={{ marginBottom: 8 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <T weight="600">{m.title}</T>
              <Row style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                <Tag>{t(`cEdu.mod.kind.${m.kind}`)}</Tag>
                {m.pillar && <Tag color={c.pink}>{t(`cEdu.pillar.${m.pillar}`)}</Tag>}
                {m.mandatory && <Tag color={c.amber}>Mandatory</Tag>}
                <Tag color={m.status === 'published' ? c.green : c.mute}>{m.status}</Tag>
              </Row>
              {m.cpd_hours != null && <T size={12} color={c.mute} style={{ marginTop: 4 }}>{m.cpd_hours}h CPD</T>}
            </View>
            <View style={{ gap: 6, alignItems: 'flex-end' }}>
              <Btn label={t('cEdu.mod.edit')} size="xs" onPress={() => { setForm({ ...m }); setSheet('module'); }} />
              {m.status === 'draft' && <Btn label={t('cEdu.mod.publish')} size="xs" variant="primary" onPress={() => publish(m)} />}
            </View>
          </Row>
        </Card>
      ))}
      <FormSheet visible={sheet === 'module'} title={form.id ? t('cEdu.mod.edit') : t('cEdu.mod.new')} onClose={() => setSheet(null)} onSave={save}>
        <T style={{ marginBottom: 4 }}>{t('cEdu.mod.f.title')}</T>
        {/* title input */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mod.f.kind')}</T>
        {/* kind segmented */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mod.f.pillar')}</T>
        {/* pillar picker */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mod.f.cpdHours')}</T>
        {/* cpd_hours number */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mod.f.mandatory')}</T>
        {/* mandatory switch */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mod.f.description')}</T>
        {/* description textarea */}
      </FormSheet>
    </View>
  );
}

// ── My CPD Board (coach view) ─────────────────────────────────────────────────
export function MyCpdBoard({ org }) {
  const [sheet, setSheet] = useState(null);
  const [selected, setSelected] = useState(null);
  const { data: assignments, reload, loading, error } = useLoad(() =>
    api('GET', `/organisations/${org.id}/academy/my-edu-assignments`, { query: { status: 'all', limit: 100 } }),
  );

  const submitCompletion = async (asnId, body) => {
    try {
      await api('POST', `/academy/edu-assignments/${asnId}/completions`, { body });
      reload();
      setSheet(null);
    } catch (e) { alert(explain(e)); }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  return (
    <View>
      {(!assignments || assignments.length === 0) ? (
        <Empty title={t('cEdu.empty.assignments')} />
      ) : assignments.map((a) => (
        <Card key={a.id} style={{ marginBottom: 8 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <T weight="600">{a.module_title}</T>
              <Row style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                <Tag>{t(`cEdu.mod.kind.${a.kind}`)}</Tag>
                {a.mandatory && <Tag color={c.amber}>Mandatory</Tag>}
                <Tag color={kpiColor[a.status] ?? c.mute}>{a.status}</Tag>
              </Row>
              {a.due_on && (
                <T size={12} color={a.due_on < new Date().toISOString().slice(0, 10) ? c.red : c.mute} style={{ marginTop: 4 }}>
                  {a.due_on < new Date().toISOString().slice(0, 10) ? t('cEdu.asn.overdue', { n: Math.ceil((new Date() - new Date(a.due_on)) / 86400000) }) : t('cEdu.asn.due', { date: a.due_on })}
                </T>
              )}
              {a.cpd_hours != null && <T size={12} color={c.mute}>{a.cpd_hours}h CPD</T>}
            </View>
            {!['approved', 'expired'].includes(a.status) && (
              <Btn label={a.status === 'assigned' ? t('cEdu.asn.start') : t('cEdu.asn.continue')} size="sm" onPress={() => { setSelected(a); setSheet('completion'); }} />
            )}
          </Row>
        </Card>
      ))}
      <FormSheet visible={sheet === 'completion'} title={t('cEdu.cmp.submit')} onClose={() => setSheet(null)}
        onSave={() => submitCompletion(selected?.id, { evidence_kind: 'certificate', idempotency_key: `${selected?.id}-${Date.now()}` })}>
        <T style={{ marginBottom: 4 }}>{t('cEdu.mod.f.kind')}</T>
        {/* evidence_kind picker */}
        <T style={{ marginBottom: 4, marginTop: 12 }}>{t('cEdu.mod.f.description')}</T>
        {/* evidence_note */}
      </FormSheet>
    </View>
  );
}

// ── Review Queue (TD/admin) ───────────────────────────────────────────────────
export function ReviewQueue({ org }) {
  const { data: completions, reload, loading, error } = useLoad(() =>
    api('GET', `/organisations/${org.id}/academy/edu-completions`, { query: { status: 'submitted', limit: 100 } }),
  );

  const decide = async (completionId, decision, note) => {
    try {
      await api('POST', `/academy/edu-completions/${completionId}/review`, { body: { decision, review_note: note } });
      reload();
    } catch (e) { alert(explain(e)); }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  return (
    <View>
      {(!completions || completions.length === 0) ? (
        <Empty title="No completions pending review." />
      ) : completions.map((comp) => (
        <Card key={comp.id} style={{ marginBottom: 8 }}>
          <T weight="600">{comp.module_title}</T>
          <T size={12} color={c.mute}>{t(`cEdu.cmp.evidenceKind.${comp.evidence_kind}`)}</T>
          {comp.evidence_url && <T size={12} color={c.blue}>{comp.evidence_url}</T>}
          {comp.evidence_note && <T size={12} color={c.ink}>{comp.evidence_note}</T>}
          <Row style={{ gap: 8, marginTop: 8 }}>
            <Btn label={t('cEdu.cmp.approve')} size="sm" variant="primary" onPress={() => decide(comp.id, 'approved', null)} />
            <Btn label={t('cEdu.cmp.reject')} size="sm" variant="danger" onPress={() => decide(comp.id, 'rejected', null)} />
          </Row>
        </Card>
      ))}
    </View>
  );
}

// ── Appeals Panel ──────────────────────────────────────────────────────────────
export function AppealPanel({ org }) {
  const { data: completions, reload, loading, error } = useLoad(() =>
    api('GET', `/organisations/${org.id}/academy/edu-completions`, { query: { status: 'rejected', limit: 100 } }),
  );

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  return (
    <View>
      {(!completions || completions.length === 0) ? (
        <Empty title="No open appeals." />
      ) : completions.map((comp) => (
        <Card key={comp.id} style={{ marginBottom: 8 }}>
          <T weight="600">{comp.module_title}</T>
          <Tag color={c.amber}>{t('cEdu.apl.pending')}</Tag>
        </Card>
      ))}
    </View>
  );
}

// ── Coach Edu Hub (main entry point) ─────────────────────────────────────────
export default function CoachEduHub({ org, role }) {
  const [tab, setTab] = useState('overview');
  const { width } = useWindowDimensions();
  const wide = width >= 768;

  const isGovern = role === 'admin' || role === 'owner' || role === 'td';

  const { data: myStats, loading: statsLoading } = useLoad(() =>
    isGovern
      ? api('GET', `/organisations/${org.id}/academy/coach-edu-report`)
      : api('GET', `/organisations/${org.id}/academy/my-edu-assignments`, { query: { status: 'all', limit: 200 } }),
  );

  const tabs = [
    { key: 'overview', label: t('cEdu.tab.overview') },
    { key: 'myCpd', label: t('cEdu.tab.myCpd') },
    ...(isGovern ? [
      { key: 'library', label: t('cEdu.mod.lib') },
      { key: 'review', label: t('cEdu.tab.review') },
      { key: 'appeals', label: t('cEdu.tab.appeals') },
    ] : []),
  ];

  const overviewStats = isGovern
    ? (myStats?.module_stats?.[0] ?? {})
    : (() => {
        const rows = myStats ?? [];
        return {
          mandatory_done: rows.filter((r) => r.mandatory && r.status === 'approved').length,
          overdue: rows.filter((r) => r.due_on && r.due_on < new Date().toISOString().slice(0, 10)).length,
          in_progress: rows.filter((r) => r.status === 'in_progress').length,
          cpd_hours_earned: rows.reduce((s, r) => s + (r.status === 'approved' ? Number(r.cpd_hours ?? 0) : 0), 0),
        };
      })();

  return (
    <View style={{ flex: 1 }}>
      <Seg tabs={tabs} active={tab} onChange={setTab} style={{ marginBottom: 16 }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {tab === 'overview' && (
          <View>
            <T size={18} weight="800" style={{ marginBottom: 12 }}>{t('cEdu.title')}</T>
            {!statsLoading && <KpiStrip stats={overviewStats} />}
            <T color={c.mute} size={13}>{t('cEdu.season')}</T>
          </View>
        )}
        {tab === 'myCpd' && <MyCpdBoard org={org} />}
        {tab === 'library' && isGovern && <EduModuleLibrary org={org} />}
        {tab === 'review' && isGovern && <ReviewQueue org={org} />}
        {tab === 'appeals' && isGovern && <AppealPanel org={org} />}
      </ScrollView>
    </View>
  );
}
