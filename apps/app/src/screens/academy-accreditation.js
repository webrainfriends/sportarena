// Academy accreditation (#806): the external frameworks an academy is accredited under, the evidence each one needs (linked by reference to compliance
// records and credentials, read live), audits with findings and corrective actions, and the decision trail. Every rule is enforced by the API
// (capability academy-accreditation.js); this screen only calls it. All text goes through t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Loading, Row, Screen, T, Tag } from '../ui';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { Block, Kpi, Timeline, when } from './academy-ui';

const KINDS = ['coaching_standard', 'safeguarding', 'facility', 'licence', 'quality', 'welfare', 'other'];
const EVIDENCE = ['coach_credentials', 'compliance_record', 'policy', 'facility', 'insurance', 'curriculum', 'other'];
const AUDIT_KINDS = ['on_site', 'document_review', 'remote'];
const SCOPES = ['coaches', 'premises', 'safeguarding', 'insurance', 'curriculum', 'finance'];
const SEVERITY = ['high', 'medium', 'low', 'observation'];
const opts = (list, key) => list.map((v) => ({ value: v, label: t(`${key}${v}`) }));
const health = (h) => ({ active: [t('acc.h_active'), c.mint], expiring: [t('acc.h_expiring'), c.sun], expired: [t('acc.h_expired'), c.red], draft: [t('acc.h_draft'), c.violetSoft], suspended: [t('acc.h_suspended'), c.sun], archived: [t('acc.h_archived'), c.violetSoft] }[h] ?? [h, c.violetSoft]);
const evState = (s) => ({ valid: [t('acc.e_valid'), c.mint], expiring: [t('acc.e_expiring'), c.sun], lapsed: [t('acc.e_lapsed'), c.red], missing: [t('acc.e_missing'), c.orange] }[s] ?? [s, c.violetSoft]);
const sev = (s) => ({ high: [t('acc.s_high'), c.red], medium: [t('acc.s_medium'), c.sun], low: [t('acc.s_low'), c.cyan], observation: [t('acc.s_observation'), c.violetSoft] }[s] ?? [s, c.violetSoft]);
const auditState = (s) => ({ scheduled: [t('acc.a_scheduled'), c.cyan], findings_issued: [t('acc.a_findings_issued'), c.sun], resubmitted: [t('acc.a_resubmitted'), c.pinkSoft], closed: [t('acc.a_closed'), c.mint], cancelled: [t('acc.a_cancelled'), c.violetSoft] }[s] ?? [s, c.violetSoft]);
const back = (x) => `‹ ${x}`, plus = (x) => `+ ${x}`, dot = (a, b) => `${a} · ${b}`;
const Alert = ({ tone, children }) => <View style={{ borderRadius: 18, padding: 14, borderWidth: 1, borderColor: tone === 'red' ? c.red : c.orange, backgroundColor: tone === 'red' ? c.redSoft : c.orangeSoft, gap: 2 }}>{children}</View>;
const decisionText = (d) => (d ? t(`acc.d_${d}`) : t('acc.d_none'));
const barColour = (p) => (p >= 90 ? c.lime : p >= 60 ? c.sun : c.red);
const dueText = (n) => (n == null ? '' : n < 0 ? t('acc.overdue_by', { n: -n }) : n === 0 ? t('acc.today') : t('acc.in_days', { n }));

function Bar({ pct, met, required }) {
  if (pct == null) return <T size={12} color={c.mute}>{t('acc.no_checklist')}</T>;
  return (
    <View style={{ gap: 4 }} accessible accessibilityLabel={t('acc.compliance_a11y', { pct, met, required })}>
      <View style={{ height: 8, borderRadius: 6, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: 8, backgroundColor: barColour(pct) }} /></View>
      <T size={12} color={c.mute}>{t('acc.compliance_line', { pct, met, required })}</T>
    </View>
  );
}

const FrameworkRow = ({ f, onPress }) => {
  const [label, tone] = health(f.health);
  return (
    <Row onPress={onPress} left={<T size={22}>🎖️</T>} title={f.name} right={<Tag label={label} color={tone} />}
      sub={`${f.body_name}${f.level ? ` · ${f.level}` : ''}${f.expires_on || f.next_due_on ? ` · ${t('acc.due')} ${when(f.expires_on ?? f.next_due_on)}` : ''}`} />
  );
};

export function AccreditationDesk({ o, role, archived, toast }) {
  const { tablet } = useLayout();
  const [tab, setTab] = useState('overview');
  const [fw, setFw] = useState(null);
  const [au, setAu] = useState(null);
  const [edit, setEdit] = useState(null);       // 'new' | a framework
  const [schedule, setSchedule] = useState(null); // a framework id
  const ov = useLoad(() => api.get(`/organisations/${o.id}/academy/accreditation`), [o.id]);
  const people = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  const trail = useLoad(() => (tab === 'history' ? api.get(`/organisations/${o.id}/academy/accreditation/trail`) : Promise.resolve(null)), [o.id, tab, ov.data]);
  if (ov.error) return <LoadError error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <Loading />;
  const d = ov.data, k = d.kpis, can = d.can_manage && !archived;
  const members = (Array.isArray(people.data) ? people.data : people.data?.members ?? []).filter((m) => m.status === 'active').map((m) => ({ value: m.user_id ?? m.id, label: m.display_name ?? m.handle }));
  const reload = () => ov.reload();
  const tabs = [['overview', t('acc.tab_overview')], ['frameworks', t('acc.tab_frameworks')], ['audits', t('acc.tab_audits')], ['findings', t('acc.tab_actions')], ['history', t('acc.tab_history')]];
  const go = (key) => { setTab(key); setFw(null); setAu(null); };
  if (fw) return <FrameworkView id={fw} o={o} can={can} members={members} toast={toast} onBack={() => { setFw(null); reload(); }} onSchedule={() => setSchedule(fw)} onOpenAudit={(id) => { setFw(null); setTab('audits'); setAu(id); }} schedule={schedule} setSchedule={setSchedule} />;
  if (au) return <AuditView id={au} o={o} can={can} members={members} toast={toast} onBack={() => { setAu(null); reload(); }} />;
  const urgent = d.frameworks.filter((f) => ['expired', 'expiring'].includes(f.health)).sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0))[0];
  const col = tablet ? { flex: 1, width: undefined } : { width: '100%' };
  return (
    <View style={{ gap: 12 }}>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('acc.title')}</T><T color={c.mute}>{t('acc.subtitle')}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{tabs.map(([key, label]) => <Chip key={key} label={label} active={tab === key} onPress={() => go(key)} />)}</View>
      {tab === 'overview' ? (
        <>
          {urgent ? (
            <Alert tone={urgent.health === 'expired' ? 'red' : 'orange'}>
              <T weight="700">{urgent.health === 'expired' ? t('acc.alert_expired', { name: urgent.name }) : t('acc.alert_due', { name: urgent.name, n: urgent.days_left })}</T>
              <T size={13} color={c.mute}>{t('acc.alert_sub', { date: when(urgent.expires_on ?? urgent.next_due_on), n: urgent.open_findings })}</T>
              <View style={{ flexDirection: 'row', marginTop: 8 }}><Btn small title={t('acc.open_framework')} onPress={() => setFw(urgent.id)} /></View>
            </Alert>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Kpi label={t('acc.k_frameworks')} value={k.frameworks} sub={t('acc.k_active', { n: k.active })} />
            <Kpi label={t('acc.k_compliance')} value={k.avg_compliance_pct == null ? '–' : `${k.avg_compliance_pct}%`} sub={t('acc.k_compliance_sub')} />
            <Kpi label={t('acc.k_expiring')} value={k.expiring + k.expired} sub={k.expired ? t('acc.k_expired', { n: k.expired }) : t('acc.k_none_expired')} tone={k.expiring + k.expired ? 'alert' : undefined} />
            <Kpi label={t('acc.k_findings')} value={k.open_findings} sub={t('acc.k_actions', { n: k.open_actions })} tone={k.open_findings ? 'alert' : undefined} onPress={() => go('findings')} />
          </View>
          <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
            <Card style={col}>
              <Block title={t('acc.health_title')} right={can ? <Btn small title={t('acc.configure')} color={c.paper} ink={c.ink} onPress={() => setEdit('new')} /> : null}>
                {d.frameworks.length ? d.frameworks.map((f) => (
                  <Card key={f.id} pad={12} onPress={() => setFw(f.id)} accessibilityLabel={f.name}>
                    <View style={{ gap: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{f.name}</T><Tag label={health(f.health)[0]} color={health(f.health)[1]} /></View>
                      <T size={13} color={c.mute}>{f.body_name}{f.days_left != null ? ` · ${dueText(f.days_left)}` : ''}</T>
                      <Bar pct={f.compliance.pct} met={f.compliance.met} required={f.compliance.required} />
                    </View>
                  </Card>
                )) : <Empty emoji="🎖️" title={t('acc.empty_fw_title')} sub={t('acc.empty_fw_sub')} />}
              </Block>
            </Card>
            <Card style={col}>
              <Block title={t('acc.upcoming_title')}>
                {d.audits.length ? d.audits.map((a) => <Row key={a.id} onPress={() => setAu(a.id)} left={<T size={20}>📅</T>} title={a.framework_name} sub={`${auditState(a.status)[0]} · ${t(`acc.k_${a.kind}`)} · ${when(a.scheduled_on)}${a.inspector_name ? ` · ${a.inspector_name}` : ''}`} />)
                  : <Empty emoji="📅" title={t('acc.empty_audit_title')} sub={t('acc.empty_audit_sub')} />}
              </Block>
            </Card>
          </View>
        </>
      ) : null}
      {tab === 'frameworks' ? (
        <Card>
          <Block title={t('acc.tab_frameworks')} right={can ? <Btn small title={t('acc.configure')} onPress={() => setEdit('new')} /> : null}>
            {d.frameworks.length ? d.frameworks.map((f) => <FrameworkRow key={f.id} f={f} onPress={() => setFw(f.id)} />) : <Empty emoji="🎖️" title={t('acc.empty_fw_title')} sub={t('acc.empty_fw_sub')} />}
          </Block>
        </Card>
      ) : null}
      {tab === 'audits' ? <AuditList o={o} frameworks={d.frameworks} can={can} onOpen={setAu} onSchedule={(id) => setSchedule(id)} /> : null}
      {tab === 'findings' ? (
        <Card>
          <Block title={t('acc.actions_title')}>
            {d.actions.length ? d.actions.map((y) => <Row key={y.id} onPress={() => setAu(y.audit_id)} left={<Tag label={sev(y.severity)[0]} color={sev(y.severity)[1]} />} title={y.title} sub={`${y.ref} · ${y.framework_name}${y.owner_name ? ` · ${y.owner_name}` : ''}${y.due_on ? ` · ${y.overdue ? t('acc.overdue_by', { n: Math.max(1, Math.round((Date.now() - new Date(`${y.due_on}T12:00:00`)) / 864e5)) }) : when(y.due_on)}` : ''}`} color={y.overdue ? c.orangeSoft : undefined} />)
              : <Empty emoji="✅" title={t('acc.empty_actions_title')} sub={t('acc.empty_actions_sub')} />}
          </Block>
        </Card>
      ) : null}
      {tab === 'history' ? (
        <Card>
          <Block title={t('acc.trail_title')} right={<Tag label={t('acc.locked')} color={c.ink} />}>
            {!trail.data ? <Loading /> : trail.data.length ? <Timeline items={trail.data.map((e) => ({ title: t(`acc.ev_${e.kind}`), sub: `${e.actor_name ?? ''} · ${when(e.created_at)}` }))} /> : <Empty emoji="🧾" title={t('acc.empty_trail_title')} sub={t('acc.empty_trail_sub')} />}
            <T size={12} color={c.mute}>{t('acc.trail_note')}</T>
          </Block>
        </Card>
      ) : null}
      <FrameworkSheet o={o} edit={edit} onClose={() => setEdit(null)} members={members} toast={toast} onSaved={(f) => { reload(); if (f && edit === 'new') setFw(f.id); }} />
      <AuditSheet frameworkId={schedule} onClose={() => setSchedule(null)} toast={toast} onSaved={(a) => { reload(); setTab('audits'); setFw(null); setAu(a.id); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ framework create / edit
function FrameworkSheet({ o, edit, onClose, members, toast, onSaved }) {
  const f = edit && edit !== 'new' ? edit : null;
  return (
    <FormSheet visible={!!edit} onClose={onClose} title={f ? t('acc.edit_framework') : t('acc.new_framework')} submitLabel={t('common.save')}
      initial={f ? { name: f.name, body_name: f.body_name, kind: f.kind, level: f.level ?? '', owner_id: f.owner_id ?? '', cycle_months: f.cycle_months, next_due_on: f.next_due_on ?? undefined, expires_on: f.expires_on ?? undefined, remind_days: f.remind_days, status: f.status } : { kind: 'coaching_standard', cycle_months: 12, remind_days: 60, status: 'active' }}
      fields={[
        { key: 'body_name', label: t('acc.f_body'), hint: t('acc.f_body_hint') },
        { key: 'name', label: t('acc.f_name') },
        { key: 'kind', label: t('acc.f_kind'), type: 'chips', options: opts(KINDS, 'acc.kind_') },
        { key: 'level', label: t('acc.f_level'), optional: true },
        { key: 'owner_id', label: t('acc.f_owner'), type: 'chips', optional: true, options: [{ value: '', label: t('acc.f_owner_none') }, ...members] },
        { key: 'cycle_months', label: t('acc.f_cycle'), type: 'chips', options: [6, 12, 24, 36, 60].map((n) => ({ value: n, label: t('acc.months', { n }) })) },
        { key: 'next_due_on', label: t('acc.f_next_due'), type: 'date', optional: true },
        { key: 'expires_on', label: t('acc.f_expires'), type: 'date', optional: true },
        { key: 'remind_days', label: t('acc.f_remind'), type: 'chips', options: [30, 60, 90, 180].map((n) => ({ value: n, label: t('acc.days', { n }) })) },
        ...(f ? [{ key: 'status', label: t('acc.f_status'), type: 'chips', options: opts(['draft', 'active', 'suspended', 'archived'], 'acc.h_') }] : []),
      ]}
      onSubmit={async (v) => {
        const body = { ...v, owner_id: v.owner_id || undefined, level: v.level || undefined };
        try { const r = f ? await api.patch(`/academy/accreditation-frameworks/${f.id}`, { ...body, row_version: f.row_version }) : await api.post(`/organisations/${o.id}/academy/accreditation-frameworks`, body); onSaved(r); return t('acc.saved'); } catch (e) { throw new Error(explain(e)); }
      }} />
  );
}

// ------------------------------------------------------------------------------------------------------------------ one framework
function FrameworkView({ id, o, can, members, toast, onBack, onOpenAudit, onSchedule, schedule, setSchedule }) {
  const [tab, setTab] = useState('overview');
  const [link, setLink] = useState(null);       // requirement being given evidence
  const [req, setReq] = useState(false);
  const [edit, setEdit] = useState(null);
  const d = useLoad(() => api.get(`/academy/accreditation-frameworks/${id}`), [id]);
  const audits = useLoad(() => api.get(`/organisations/${o.id}/academy/audits`, { framework_id: id }), [o.id, id]);
  const options = useLoad(() => (link ? api.get(`/organisations/${o.id}/academy/accreditation-evidence-options`) : Promise.resolve(null)), [o.id, link?.id]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const f = d.data, [hl, ht] = health(f.health), cm = f.compliance;
  const act = async (fn, ok) => { try { await fn(); toast(ok); d.reload(); } catch (e) { toast(explain(e)); } };
  const evOptions = options.data ? [...options.data.records.map((r) => ({ value: `comp_record:${r.id}`, label: `${r.label}${r.person_name ? ` · ${r.person_name}` : ''}`, sub: `${r.status}${r.expires_on ? ` · ${when(r.expires_on)}` : ''}` })), ...options.data.credentials.map((r) => ({ value: `credential:${r.id}`, label: `${r.label} · ${r.person_name}`, sub: `${r.status}${r.expires_on ? ` · ${when(r.expires_on)}` : ''}` }))] : [];
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Btn small title={back(t('acc.tab_frameworks'))} color={c.paper} ink={c.ink} onPress={onBack} /><Tag label={hl} color={ht} /></View>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{f.name}</T><T color={c.mute}>{f.body_name}{f.level ? ` · ${f.level}` : ''}{f.owner_name ? ` · ${f.owner_name}` : ''}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{[['overview', t('acc.tab_overview')], ['evidence', t('acc.tab_evidence')], ['audits', t('acc.tab_audits')]].map(([key, label]) => <Chip key={key} label={label} active={tab === key} onPress={() => setTab(key)} />)}</View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('acc.k_compliance')} value={cm.pct == null ? '–' : `${cm.pct}%`} sub={t('acc.k_met', { met: cm.met, required: cm.required })} tone={cm.pct != null && cm.pct < 60 ? 'alert' : undefined} />
        <Kpi label={t('acc.k_missing')} value={cm.missing + cm.lapsed} sub={t('acc.k_lapsed', { n: cm.lapsed })} tone={cm.missing + cm.lapsed ? 'alert' : undefined} />
        <Kpi label={t('acc.k_findings')} value={f.open_findings} sub={t('acc.k_actions', { n: f.open_actions })} tone={f.open_findings ? 'alert' : undefined} />
        <Kpi label={t('acc.k_next')} value={f.days_left == null ? '–' : f.days_left} sub={f.days_left == null ? t('acc.no_date') : f.days_left < 0 ? t('acc.days_past') : t('acc.days_left')} tone={f.health === 'expired' || f.health === 'expiring' ? 'alert' : undefined} />
      </View>
      {tab === 'overview' ? (
        <Card>
          <Block title={t('acc.config_title')} right={can ? <Btn small title={t('acc.edit')} color={c.paper} ink={c.ink} onPress={() => setEdit(f)} /> : null}>
            <Row title={t('acc.f_body')} sub={f.body_name} /><Row title={t('acc.f_kind')} sub={t(`acc.kind_${f.kind}`)} /><Row title={t('acc.f_owner')} sub={f.owner_name ?? t('acc.f_owner_none')} />
            <Row title={t('acc.f_cycle')} sub={t('acc.months', { n: f.cycle_months })} /><Row title={t('acc.f_next_due')} sub={f.next_due_on ? when(f.next_due_on) : t('acc.no_date')} /><Row title={t('acc.f_expires')} sub={f.expires_on ? when(f.expires_on) : t('acc.no_date')} /><Row title={t('acc.f_remind')} sub={t('acc.days', { n: f.remind_days })} />
            {can ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title={t('acc.schedule_audit')} onPress={onSchedule} /></View> : null}
            <Card color={c.violetSoft} pad={12}><T size={13}>{t('acc.federation_note')}</T></Card>
          </Block>
        </Card>
      ) : null}
      {tab === 'evidence' ? (
        <Card>
          <Block title={t('acc.required_title')} right={can ? <Btn small title={t('acc.add_requirement')} color={c.paper} ink={c.ink} onPress={() => setReq(true)} /> : null}>
            <Card color={c.violetSoft} pad={12}><T size={13}>{t('acc.by_reference')}</T></Card>
            {f.requirements.length ? f.requirements.map((q) => {
              const [label, tone] = evState(q.state);
              return (
                <Card key={q.id} pad={12}>
                  <View style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="700" style={{ flex: 1 }}>{q.title}</T><Tag label={label} color={tone} /></View>
                    <T size={12} color={c.mute}>{t(`acc.ek_${q.evidence_kind}`)}{q.required ? '' : ` · ${t('acc.optional')}`}</T>
                    {q.evidence.map((e) => (
                      <View key={`${e.ref_kind}${e.ref_id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 12, backgroundColor: c.bg }}>
                        <T size={16}>{e.ref_kind === 'credential' ? '🪪' : '📄'}</T>
                        <View style={{ flex: 1 }}><T size={13} weight="700">{e.label}</T><T size={12} color={c.mute}>{evState(e.state)[0]}{e.expires_on ? ` · ${when(e.expires_on)}` : ''}{e.derived ? ` · ${t('acc.derived')}` : ''}</T></View>
                        {can && e.link_id ? <Btn small title={t('acc.unlink')} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/accreditation-evidence/${e.link_id}/unlink`), t('acc.unlinked'))} /> : null}
                      </View>
                    ))}
                    {can ? <View style={{ flexDirection: 'row' }}><Btn small title={t('acc.link_evidence')} color={q.state === 'valid' ? c.paper : c.pink} ink={c.ink} onPress={() => setLink(q)} /></View> : null}
                  </View>
                </Card>
              );
            }) : <Empty emoji="📋" title={t('acc.empty_req_title')} sub={t('acc.empty_req_sub')} />}
          </Block>
        </Card>
      ) : null}
      {tab === 'audits' ? (
        <Card>
          <Block title={t('acc.tab_audits')} right={can ? <Btn small title={t('acc.schedule_audit')} onPress={onSchedule} /> : null}>
            {!audits.data ? <Loading /> : audits.data.length ? audits.data.map((a) => <Row key={a.id} onPress={() => onOpenAudit(a.id)} title={`${t(`acc.k_${a.kind}`)} · ${when(a.scheduled_on)}`} sub={`${decisionText(a.decision)}${a.score != null ? ` · ${a.score}/100` : ''} · ${t('acc.findings_n', { n: a.findings_open })}`} right={<Tag label={auditState(a.status)[0]} color={auditState(a.status)[1]} />} />) : <Empty emoji="📅" title={t('acc.empty_audit_title')} sub={t('acc.empty_audit_sub')} />}
          </Block>
        </Card>
      ) : null}
      <FormSheet visible={!!link} onClose={() => setLink(null)} title={link?.title ?? ''} submitLabel={t('acc.link_evidence')}
        fields={[{ key: 'evidence', label: t('acc.pick_evidence'), type: 'multi', options: evOptions, hint: t('acc.pick_evidence_hint') }]}
        onSubmit={async (v) => {
          if (!v.evidence?.length) throw new Error(t('acc.pick_one'));
          try { for (const x of v.evidence) { const [kind, ref] = x.split(':'); await api.post(`/academy/accreditation-frameworks/${id}/evidence`, { requirement_id: link.id, ...(kind === 'credential' ? { credential_id: ref } : { comp_record_id: ref }) }); } d.reload(); return t('acc.linked'); } catch (e) { throw new Error(explain(e)); }
        }} />
      <FormSheet visible={req} onClose={() => setReq(false)} title={t('acc.add_requirement')} submitLabel={t('common.save')} initial={{ evidence_kind: 'coach_credentials', required: true }}
        fields={[{ key: 'title', label: t('acc.r_title') }, { key: 'evidence_kind', label: t('acc.r_kind'), type: 'chips', options: opts(EVIDENCE, 'acc.ek_') }, { key: 'required', label: t('acc.r_required'), type: 'switch' }]}
        onSubmit={async (v) => { try { await api.post(`/academy/accreditation-frameworks/${id}/requirements`, { requirement: v }); d.reload(); return t('acc.saved'); } catch (e) { throw new Error(explain(e)); } }} />
      <FrameworkSheet o={o} edit={edit} onClose={() => setEdit(null)} members={members} toast={toast} onSaved={() => d.reload()} />
      <AuditSheet frameworkId={schedule} onClose={() => setSchedule(null)} toast={toast} onSaved={(a) => onOpenAudit(a.id)} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ audits
function AuditList({ o, frameworks, can, onOpen, onSchedule }) {
  const a = useLoad(() => api.get(`/organisations/${o.id}/academy/audits`), [o.id]);
  const live = frameworks.filter((f) => f.status !== 'archived');
  return (
    <Card>
      <Block title={t('acc.tab_audits')} right={can && live.length === 1 ? <Btn small title={t('acc.schedule_audit')} onPress={() => onSchedule(live[0].id)} /> : null}>
        {can && live.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{live.map((f) => <Chip key={f.id} label={plus(f.name)} onPress={() => onSchedule(f.id)} />)}</View> : null}
        {!a.data ? <Loading /> : a.data.length ? a.data.map((x) => <Row key={x.id} onPress={() => onOpen(x.id)} left={<T size={20}>📅</T>} title={x.framework_name} sub={`${t(`acc.k_${x.kind}`)} · ${when(x.scheduled_on)}${x.inspector_name ? ` · ${x.inspector_name}` : ''}${x.score != null ? ` · ${x.score}/100` : ''}`} right={<Tag label={auditState(x.status)[0]} color={auditState(x.status)[1]} />} />) : <Empty emoji="📅" title={t('acc.empty_audit_title')} sub={t('acc.empty_audit_sub')} />}
      </Block>
    </Card>
  );
}

function AuditSheet({ frameworkId, onClose, toast, onSaved }) {
  return (
    <FormSheet visible={!!frameworkId} onClose={onClose} title={t('acc.schedule_audit')} submitLabel={t('acc.schedule_audit')} initial={{ kind: 'on_site', scope: [] }}
      fields={[
        { key: 'kind', label: t('acc.au_kind'), type: 'chips', options: opts(AUDIT_KINDS, 'acc.k_') },
        { key: 'scheduled_on', label: t('acc.au_date'), type: 'date' },
        { key: 'starts_at', label: t('acc.au_start'), type: 'time', optional: true },
        { key: 'ends_at', label: t('acc.au_end'), type: 'time', optional: true },
        { key: 'venue_name', label: t('acc.au_venue'), optional: true },
        { key: 'scope', label: t('acc.au_scope'), type: 'multi', optional: true, options: opts(SCOPES, 'acc.sc_') },
        { key: 'inspector_id', label: t('acc.au_inspector'), type: 'entity', entityKind: 'person', noun: t('acc.au_inspector_noun'), optional: true, hint: t('acc.au_inspector_hint') },
      ]}
      onSubmit={async (v) => { try { const a = await api.post(`/academy/accreditation-frameworks/${frameworkId}/audits`, { ...v, inspector_id: v.inspector_id || undefined }); onSaved(a); return t('acc.scheduled'); } catch (e) { throw new Error(explain(e)); } }} />
  );
}

export function AuditView({ id, o, can, members = [], toast, onBack, inspector }) {
  const [tab, setTab] = useState('findings');
  const [finding, setFinding] = useState(false);
  const [action, setAction] = useState(null);   // finding to add an action to
  const [decide, setDecide] = useState(false);
  const d = useLoad(() => api.get(`/academy/audits/${id}`), [id]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const a = d.data, [sl, st] = auditState(a.status);
  const mayRecord = (can || inspector) && !['closed', 'cancelled'].includes(a.status);
  const act = async (fn, ok) => { try { await fn(); toast(ok); d.reload(); } catch (e) { toast(explain(e)); } };
  const blocking = a.findings.filter((x) => x.status === 'open' && ['high', 'medium'].includes(x.severity)).length;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Btn small title={back(t('common.back'))} color={c.paper} ink={c.ink} onPress={onBack} /><Tag label={sl} color={st} /></View>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{a.framework_name}</T><T color={c.mute}>{t(`acc.k_${a.kind}`)} · {when(a.scheduled_on)}{a.starts_at ? ` · ${a.starts_at}${a.ends_at ? `–${a.ends_at}` : ''}` : ''}{a.inspector_name ? ` · ${a.inspector_name}` : ''}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('acc.k_score')} value={a.score ?? '–'} sub={t('acc.out_of')} />
        <Kpi label={t('acc.k_decision')} value={decisionText(a.decision)} wide />
        <Kpi label={t('acc.k_open')} value={a.findings_open} sub={t('acc.k_of', { n: a.findings_total })} tone={a.findings_open ? 'alert' : undefined} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{[['findings', t('acc.tab_findings')], ['signoff', t('acc.tab_signoff')], ['history', t('acc.tab_history')]].map(([key, label]) => <Chip key={key} label={label} active={tab === key} onPress={() => setTab(key)} />)}</View>
      {tab === 'findings' ? (
        <>
          {a.status === 'findings_issued' && a.resubmit_by && can ? (
            <Card color={c.orangeSoft} pad={14}>
              <T weight="700">{t('acc.resubmit_by', { date: when(a.resubmit_by) })}</T>
              <T size={13} color={c.mute}>{blocking ? t('acc.resubmit_blocked', { n: blocking }) : t('acc.resubmit_ready')}</T>
              <View style={{ flexDirection: 'row', marginTop: 8 }}><Btn small title={t('acc.resubmit')} disabled={!!blocking} onPress={() => act(() => api.post(`/academy/audits/${id}/resubmit`, {}), t('acc.resubmitted'))} /></View>
            </Card>
          ) : null}
          <Card>
            <Block title={t('acc.tab_findings')} right={mayRecord ? <Btn small title={t('acc.add_finding')} onPress={() => setFinding(true)} /> : null}>
              {a.findings.length ? a.findings.map((x) => (
                <Card key={x.id} pad={12} color={x.status === 'open' ? c.paper : c.mintSoft}>
                  <View style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><Tag label={sev(x.severity)[0]} color={sev(x.severity)[1]} /><T weight="700" style={{ flex: 1 }}>{x.ref} · {x.title}</T>{x.status !== 'open' ? <Tag label={t(`acc.fs_${x.status}`)} color={c.mint} /> : null}</View>
                    {x.detail ? <T size={13} color={c.mute}>{x.detail}</T> : null}
                    {x.actions.length ? <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.8 }}>{t('acc.actions_head').toUpperCase()}</T> : null}
                    {x.actions.map((y) => (
                      <View key={y.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 6, borderTopWidth: 1, borderColor: c.line }}>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: y.status === 'done' ? c.lime : y.overdue ? c.red : c.sun }} />
                        <View style={{ flex: 1 }}><T size={13}>{y.title}</T><T size={12} color={c.mute}>{y.status === 'open' ? `${y.owner_name ?? t('acc.no_owner')}${y.due_on ? ` · ${y.overdue ? t('acc.overdue') : when(y.due_on)}` : ''}` : t(`acc.as_${y.status}`)}</T></View>
                        {y.status === 'open' && (can || y.owner_id === inspector) ? <Btn small title={t('acc.mark_done')} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/audit-actions/${y.id}/complete`, {}), t('acc.done'))} /> : null}
                      </View>
                    ))}
                    {x.status === 'open' && mayRecord ? (
                      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                        <Btn small title={t('acc.add_action')} color={c.paper} ink={c.ink} onPress={() => setAction(x)} />
                        {can ? <Btn small title={t('acc.mark_resolved')} onPress={() => act(() => api.post(`/academy/audit-findings/${x.id}/resolve`, {}), t('acc.resolved'))} /> : null}
                      </View>
                    ) : null}
                  </View>
                </Card>
              )) : <Empty emoji="🔎" title={t('acc.empty_findings_title')} sub={t('acc.empty_findings_sub')} />}
            </Block>
          </Card>
        </>
      ) : null}
      {tab === 'signoff' ? (
        <Card>
          <Block title={t('acc.signoff_title')} right={mayRecord && (can || inspector) ? <Btn small title={t('acc.record_decision')} onPress={() => setDecide(true)} /> : null}>
            <Row title={t('acc.au_inspector')} sub={a.inspector_name ?? t('acc.no_inspector')} />
            <Row title={t('acc.k_decision')} sub={a.decision ? `${decisionText(a.decision)} · ${a.score}/100` : t('acc.d_none')} />
            {a.summary ? <Row title={t('acc.summary')} sub={a.summary} /> : null}
            {a.scope?.length ? <Row title={t('acc.au_scope')} sub={a.scope.map((s) => t(`acc.sc_${s}`)).join(', ')} /> : null}
            <Card color={c.violetSoft} pad={12}><T size={13}>{t('acc.federation_note')}</T></Card>
            {can && a.status === 'scheduled' ? <View style={{ flexDirection: 'row' }}><Btn small title={t('acc.cancel_audit')} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/audits/${id}/cancel`, {}), t('acc.cancelled'))} /></View> : null}
          </Block>
        </Card>
      ) : null}
      {tab === 'history' ? (
        <Card><Block title={t('acc.trail_title')} right={<Tag label={t('acc.locked')} color={c.ink} />}>
          {a.trail.length ? <Timeline items={a.trail.map((e) => ({ title: t(`acc.ev_${e.kind}`), sub: `${e.actor_name ?? ''} · ${when(e.created_at)}` }))} /> : <Empty emoji="🧾" title={t('acc.empty_trail_title')} sub={t('acc.empty_trail_sub')} />}
          <T size={12} color={c.mute}>{t('acc.trail_note')}</T></Block></Card>
      ) : null}
      <FormSheet visible={finding} onClose={() => setFinding(false)} title={t('acc.add_finding')} submitLabel={t('common.save')} initial={{ severity: 'medium' }}
        fields={[
          { key: 'severity', label: t('acc.fi_severity'), type: 'chips', options: opts(SEVERITY, 'acc.s_') },
          { key: 'title', label: t('acc.fi_title') },
          { key: 'detail', label: t('acc.fi_detail'), type: 'multiline', optional: true },
          { key: 'action_title', label: t('acc.fi_action'), optional: true, hint: t('acc.fi_action_hint') },
          { key: 'action_owner', label: t('acc.fi_owner'), type: 'chips', optional: true, options: [{ value: '', label: t('acc.f_owner_none') }, ...members] },
          { key: 'action_due', label: t('acc.fi_due'), type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { try { await api.post(`/academy/audits/${id}/findings`, { severity: v.severity, title: v.title, detail: v.detail || undefined, actions: v.action_title ? [{ title: v.action_title, owner_id: v.action_owner || undefined, due_on: v.action_due || undefined }] : [] }); d.reload(); return t('acc.saved'); } catch (e) { throw new Error(explain(e)); } }} />
      <FormSheet visible={!!action} onClose={() => setAction(null)} title={t('acc.add_action')} submitLabel={t('common.save')}
        fields={[{ key: 'title', label: t('acc.fi_action') }, { key: 'owner_id', label: t('acc.fi_owner'), type: 'chips', optional: true, options: [{ value: '', label: t('acc.f_owner_none') }, ...members] }, { key: 'due_on', label: t('acc.fi_due'), type: 'date', optional: true }]}
        onSubmit={async (v) => { try { await api.post(`/academy/audit-findings/${action.id}/actions`, { title: v.title, owner_id: v.owner_id || undefined, due_on: v.due_on || undefined }); d.reload(); return t('acc.saved'); } catch (e) { throw new Error(explain(e)); } }} />
      <FormSheet visible={decide} onClose={() => setDecide(false)} title={t('acc.record_decision')} submitLabel={t('acc.record_decision')} initial={{ decision: 'pass', score: 80 }}
        fields={[
          { key: 'decision', label: t('acc.k_decision'), type: 'chips', options: opts(['pass', 'conditional_pass', 'fail'], 'acc.d_') },
          { key: 'score', label: t('acc.k_score'), type: 'stepper', min: 0, max: 100, step: 1, suffix: ' / 100' },
          { key: 'resubmit_by', label: t('acc.f_resubmit_by'), type: 'date', optional: true, show: (v) => v.decision === 'conditional_pass' },
          { key: 'summary', label: t('acc.summary'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { try { await api.post(`/academy/audits/${id}/decision`, { decision: v.decision, score: v.score, resubmit_by: v.decision === 'conditional_pass' ? v.resubmit_by : undefined, summary: v.summary || undefined }); d.reload(); return t('acc.decided'); } catch (e) { throw new Error(explain(e)); } }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ the inspector's own audits
/** A person named as an inspector sees only the audits assigned to them, never the rest of the academy. */
export function InspectorAudits() {
  const { toast, user } = useSession();
  const [open, setOpen] = useState(null);
  const l = useLoad(() => api.get('/academy/audits/mine'), []);
  return (
    <Screen>
      {l.error ? <LoadError error={l.error} onRetry={l.reload} /> : !l.data ? <Loading /> : open ? <AuditView id={open} can={false} inspector={user.id} toast={toast} onBack={() => { setOpen(null); l.reload(); }} /> : (
        <View style={{ gap: 12 }}>
          <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('acc.mine_title')}</T><T color={c.mute}>{t('acc.mine_sub')}</T></View>
          <Card>
            <Block title={t('acc.tab_audits')}>
              {l.data.length ? l.data.map((a) => <Row key={a.id} onPress={() => setOpen(a.id)} left={<T size={20}>📅</T>} title={dot(a.organisation_name, a.framework_name)} sub={`${t(`acc.k_${a.kind}`)} · ${when(a.scheduled_on)}`} right={<Tag label={auditState(a.status)[0]} color={auditState(a.status)[1]} />} />)
                : <Empty emoji="📅" title={t('acc.mine_empty_title')} sub={t('acc.mine_empty_sub')} />}
            </Block>
          </Card>
        </View>
      )}
    </Screen>
  );
}

/** Shown in My organisations only to someone who has been named as an inspector. */
export function MyAuditsCard({ onOpen }) {
  const l = useLoad(() => api.get('/academy/audits/mine').catch(() => []), []);
  const n = (l.data ?? []).filter((a) => ['scheduled', 'findings_issued', 'resubmitted'].includes(a.status)).length;
  if (!n) return null;
  return <Row onPress={onOpen} left={<T size={22}>🎖️</T>} title={t('acc.mine_title')} sub={t('acc.mine_card_sub', { n })} right={<Tag label={String(n)} color={c.pinkSoft} />} />;
}
