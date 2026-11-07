// Academy safeguarding & welfare case orchestration (#784), inside Organisation → Academy → Safety & pickup → Safeguarding cases.
// One home for it: the safety-event queue (#788) stays where it is, a case is opened from it. Every rule is enforced by the API
// (capabilities academy-safeguarding.js); this screen only calls it. Case content is shown only to designated officers, everyone else
// gets a redacted view. Colours come from the Dusk theme tokens (light and dark); all text goes through t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { locale } from '../locale';
import { Block, Kpi } from './academy-ui';

const CATS = ['welfare', 'conduct', 'online', 'injury_neglect', 'pickup', 'other'];
const RISKS = ['low', 'medium', 'high', 'critical'];
const riskColor = (r) => (r === 'critical' || r === 'high' ? c.red : r === 'medium' ? c.sun : c.limeSoft);
const riskText = (r) => t(`sg.risk_${r}`);
const stageText = (s) => t(`sg.st_${s}`);
const when = (iso) => (iso ? new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '–');
const suitColor = (s) => (s === 'cleared' ? c.limeSoft : s === 'expiring' ? c.sun : s === 'not_configured' ? c.violetSoft : c.red);
const opts = (keys, prefix) => keys.map((k) => ({ value: k, label: t(`${prefix}${k}`) }));

export function SafeguardingDesk({ o, role, toast }) {
  const admin = role === 'owner' || role === 'admin';
  const [tab, setTab] = useState('cases');
  const [raise, setRaise] = useState(false);
  const ov = useLoad(() => api.get(`/organisations/${o.id}/academy/safeguarding`).catch((e) => (e?.status === 403 ? { restricted: true } : Promise.reject(e))), [o.id]);
  const d = ov.data;
  const tabs = [['cases', t('sg.tab_cases')], ['officers', t('sg.tab_officers')], ['suitability', t('sg.tab_suitability')], ...(admin ? [['policy', t('sg.tab_policy')]] : [])];
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1, minWidth: 220 }}><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('sg.title')}</T><T color={c.mute}>{t('sg.subtitle')}</T></View>
        <Btn title={t('sg.raise')} onPress={() => setRaise(true)} accessibilityLabel={t('sg.raise')} />
      </View>
      {ov.error ? <LoadError error={ov.error} onRetry={ov.reload} /> : !d ? <Loading /> : d.restricted ? (
        <Card color={c.violetSoft} pad={14}><T weight="800">{t('sg.restricted_title')}</T><T size={13} color={c.mute}>{t('sg.restricted')}</T></Card>
      ) : (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Kpi label={t('sg.k_open')} value={d.open} />
            <Kpi label={t('sg.k_unassigned')} value={d.unassigned} tone={d.unassigned ? 'alert' : undefined} />
            <Kpi label={t('sg.k_overdue')} value={d.overdue} tone={d.overdue ? 'alert' : undefined} />
            <Kpi label={t('sg.k_escalated')} value={d.escalated} />
            <Kpi label={t('sg.k_review')} value={d.awaiting_review} tone={d.awaiting_review ? 'alert' : undefined} sub={t('sg.k_review_sub')} />
            <Kpi label={t('sg.k_median')} value={d.median_days_to_close ?? '–'} />
            <Kpi label={t('sg.k_cleared')} value={d.roster.pct_cleared == null ? '–' : `${d.roster.pct_cleared}%`} sub={t('sg.k_cleared_sub', { a: d.roster.cleared, b: d.roster.staff })} />
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{tabs.map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</View>
          {tab === 'cases' ? <Cases o={o} toast={toast} onChanged={ov.reload} /> : null}
          {tab === 'officers' ? <Officers o={o} toast={toast} admin={admin} onChanged={ov.reload} /> : null}
          {tab === 'suitability' ? <Suitability o={o} /> : null}
          {tab === 'policy' && admin ? <Policy o={o} toast={toast} /> : null}
        </>
      )}
      <ConcernSheet o={o} visible={raise} onClose={() => setRaise(false)} toast={toast} onDone={ov.reload} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ raise a concern
/** Any staff member, an athlete or a guardian can raise one. The reporter gets a receipt only. */
export function ConcernSheet({ o, visible, onClose, toast, onDone, athleteId }) {
  const campuses = useLoad(() => (visible ? api.get(`/organisations/${o.id}/campuses`).catch(() => null) : Promise.resolve(null)), [visible, o.id]);
  const athletes = useLoad(() => (visible && !athleteId ? api.get(`/organisations/${o.id}/academy/safeguarding/athletes`, { limit: 100 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] })), [visible, o.id]);
  const units = (campuses.data?.units ?? []).filter((u) => u.kind === 'campus');
  const staff = useLoad(() => (visible ? api.get(`/organisations/${o.id}/members`).catch(() => []) : Promise.resolve([])), [visible, o.id]);
  const people = (Array.isArray(staff.data) ? staff.data : staff.data?.members ?? []).filter((m) => m.status === 'active');
  return (
    <FormSheet visible={visible} onClose={onClose} title={t('sg.raise_title')} submitLabel={t('sg.raise_send')}
      notice={<T size={13} color={c.mute}>{t('sg.raise_notice')}</T>}
      initial={{ category: 'welfare', risk: 'medium' }}
      fields={[
        ...(athleteId ? [] : [{ key: 'athlete', label: t('sg.f_athlete'), type: 'multimenu', max: 1, options: (athletes.data?.items ?? []).map((a) => ({ value: a.athlete_id, label: a.display_name })) }]),
        { key: 'category', label: t('sg.f_category'), type: 'chips', options: opts(CATS, 'sg.cat_') },
        { key: 'risk', label: t('sg.f_risk'), type: 'chips', options: opts(RISKS, 'sg.risk_'), hint: t('sg.f_risk_hint') },
        { key: 'summary', label: t('sg.f_summary'), type: 'multiline', hint: t('sg.f_summary_hint') },
        ...(units.length ? [{ key: 'campus', label: t('sg.f_campus'), type: 'multimenu', max: 1, optional: true, options: units.map((u) => ({ value: u.id, label: u.name })) }] : []),
        ...(people.length ? [{ key: 'about', label: t('sg.f_about'), type: 'multimenu', max: 1, optional: true, options: people.map((m) => ({ value: m.user_id ?? m.id, label: m.display_name ?? m.handle })), hint: t('sg.f_about_hint') }] : []),
      ]}
      onSubmit={async (v) => {
        const r = await api.post(`/organisations/${o.id}/academy/safeguarding/cases`, { athlete_id: athleteId ?? v.athlete?.[0], category: v.category, risk: v.risk, summary: v.summary, unit_id: v.campus?.[0], conflicted_user_id: v.about?.[0], idempotency_key: `app-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
        onDone?.();
        return t('sg.receipt', { no: r.case_no });
      }} />
  );
}

// ------------------------------------------------------------------------------------------------------------------ cases
const FILTERS = [['open', 'sg.f_open'], ['mine', 'sg.f_mine'], ['unassigned', 'sg.f_unassigned'], ['high', 'sg.f_high'], ['closed', 'sg.st_closed']];
function Cases({ o, toast, onChanged }) {
  const [flt, setFlt] = useState('open');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const query = { limit: 100, q: q || undefined, ...(flt === 'open' ? { status: 'open' } : flt === 'mine' ? { status: 'open', mine: true } : flt === 'unassigned' ? { status: 'open', unassigned: true } : flt === 'high' ? { status: 'open', risk: 'high' } : { status: 'closed' }) };
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/safeguarding/cases`, query), [o.id, flt, q]);
  if (d.error) return <Card color={c.violetSoft} pad={14}><T weight="800">{t('sg.restricted_title')}</T><T size={13} color={c.mute}>{t('sg.restricted')}</T></Card>;
  return (
    <Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{FILTERS.map(([k, l]) => <Chip key={k} label={t(l)} active={flt === k} onPress={() => setFlt(k)} />)}</View>
      <Field label={t('common.search')} value={q} onChangeText={setQ} placeholder={t('sg.search')} />
      {!d.data ? <Loading /> : !d.data.items.length ? <Empty emoji="🛡️" title={t('sg.empty_title')} sub={t('sg.empty_sub')} /> : (
        <View style={{ gap: 4, marginTop: 8 }}>
          {d.data.items.map((k) => (
            <Row key={k.id} title={`${k.case_no} · ${k.athlete_name ?? ''}`} sub={`${t(`sg.cat_${k.category}`)} · ${k.campus_name ? `${k.campus_name} · ` : ''}${k.status === 'closed' ? t('sg.st_closed') : `${t('sg.due_escalate')} ${when(k.escalate_due_at)}`}${k.assignee_name ? ` · ${k.assignee_name}` : ` · ${t('sg.unassigned')}`}`} onPress={() => setOpen(k)}
              right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Tag label={riskText(k.risk)} color={riskColor(k.risk)} /><Tag label={k.overdue ? t('sg.overdue') : stageText(k.status)} color={k.overdue ? c.red : undefined} /></View>} />
          ))}
        </View>
      )}
      <CaseSheet id={open?.id} no={open?.case_no} onClose={() => setOpen(null)} toast={toast} onChanged={() => { d.reload(); onChanged?.(); }} />
    </Card>
  );
}

function CaseSheet({ id, no, onClose, toast, onChanged }) {
  const full = useLoad(() => (id ? api.get(`/academy/safeguarding/cases/${id}`) : Promise.resolve(null)), [id]);
  const [form, setForm] = useState(null);
  const k = full.data;
  const run = async (body, msg = t('sg.updated')) => { try { await api.patch(`/academy/safeguarding/cases/${id}`, { row_version: k.row_version, ...body }); toast(msg); setForm(null); full.reload(); onChanged?.(); } catch (e) { toast(explain(e)); } };
  const closed = k?.status === 'closed';
  return (
    <Sheet visible={!!id} onClose={onClose} title={no ?? ''}>
      {full.error ? <LoadError error={full.error} onRetry={full.reload} /> : !k ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Tag label={riskText(k.risk)} color={riskColor(k.risk)} /><Tag label={stageText(k.status)} /><Tag label={t(`sg.cat_${k.category}`)} /><Tag label={t(`sg.tier_${k.tier}`)} />{k.overdue ? <Tag label={t('sg.overdue')} color={c.red} /> : null}
          </View>
          <Card color={c.sunSoft} pad={12}><T size={13} weight="700">🔒 {t('sg.case_restricted')}</T></Card>
          <Block title={t('sg.case_summary')}><T size={14}>{k.summary ?? '–'}</T>{k.outcome ? <T size={14} color={c.lime}>{t('sg.f_outcome')}: {k.outcome}</T> : null}</Block>
          <Block title={t('sg.case_deadlines')}>
            <Row title={t('sg.due_ack')} sub={k.acknowledged_at ? `✓ ${when(k.acknowledged_at)}` : when(k.ack_due_at)} />
            <Row title={t('sg.due_review')} sub={when(k.review_due_at)} />
            <Row title={t('sg.due_escalate')} sub={when(k.escalate_due_at)} />
            <Row title={t('sg.case_assignee')} sub={k.assignee_name ?? t('sg.unassigned')} />
            <Row title={t('sg.case_retention')} sub={k.retention_until ? String(k.retention_until).slice(0, 10) : '–'} />
          </Block>
          {!closed ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {!k.acknowledged_at ? <Btn small title={t('sg.a_ack')} color={c.violet} onPress={() => run({ action: 'acknowledge' })} /> : null}
              <Btn small title={t('sg.a_reclassify')} color={c.paper} ink={c.pink} onPress={() => setForm('risk')} />
              <Btn small title={t('sg.a_assign')} color={c.paper} ink={c.pink} onPress={() => setForm('assign')} />
              <Btn small title={t('sg.a_advance')} color={c.paper} ink={c.pink} onPress={() => setForm('stage')} />
              <Btn small title={t('sg.a_escalate')} color={c.paper} ink={c.red} onPress={() => run({ action: 'escalate' })} />
              <Btn small title={t('sg.a_close')} onPress={() => setForm('close')} />
            </View>
          ) : null}
          <Block title={t('sg.case_reports')}>
            {!k.report_rules.length ? <T size={13} color={c.mute}>{t('sg.no_rule')}</T> : k.report_rules.map((r) => <Row key={r.id} title={`${r.jurisdiction} · ${r.authority_label}`} sub={`${r.notify_within_hours ? t('sg.within_h', { n: r.notify_within_hours }) : ''}${r.guidance ? ` ${r.guidance}` : ''}`} />)}
            <T size={12} color={c.mute}>{t('sg.human_review')}</T>
            {k.report_decisions.map((x) => <Row key={x.id} title={t(`sg.dec_${x.decision}`)} sub={`${x.rationale} · ${x.decided_by} · ${when(x.decided_at)}`} />)}
            {!closed ? <Btn small title={t('sg.a_decide')} color={c.paper} ink={c.pink} onPress={() => setForm('decide')} /> : null}
          </Block>
          <Block title={t('sg.case_actions')}>
            {k.actions.map((a) => <Row key={a.id} title={t(`sg.ak_${a.kind}`)} sub={`${a.owner_name ?? ''}${a.due_at ? ` · ${when(a.due_at)}` : ''}${a.note ? ` · ${a.note}` : ''}`} right={a.status === 'open' && !closed ? <Btn small title={t('sg.a_done')} color={c.violet} onPress={async () => { try { await api.post(`/academy/safeguarding/cases/${id}/actions`, { action_id: a.id, status: 'done' }); full.reload(); } catch (e) { toast(explain(e)); } }} /> : <Tag label={t(`sg.as_${a.status}`)} />} />)}
            {!closed ? <Btn small title={t('sg.a_add_action')} color={c.paper} ink={c.pink} onPress={() => setForm('action')} /> : null}
          </Block>
          <Block title={t('sg.case_evidence')}>
            {k.evidence.length ? k.evidence.map((e) => <Row key={e.id} title={e.label} sub={`${t(`sg.ev_${e.kind}`)} · ${when(e.added_at)}`} />) : <T size={13} color={c.mute}>{t('sg.ev_none')}</T>}
            {!closed ? <Btn small title={t('sg.a_add_evidence')} color={c.paper} ink={c.pink} onPress={() => setForm('evidence')} /> : null}
          </Block>
          <Block title={t('sg.case_log')}>{k.log.map((l, i) => <T key={i} size={12} color={c.mute}>{when(l.created_at)} · {l.actor_name ?? t('pk.system')} · {l.kind}{l.detail ? ` (${l.detail})` : ''}</T>)}</Block>

          <FormSheet visible={form === 'risk'} onClose={() => setForm(null)} title={t('sg.a_reclassify')} submitLabel={t('common.save')} initial={{ risk: k.risk }}
            fields={[{ key: 'risk', label: t('sg.f_risk'), type: 'chips', options: opts(RISKS, 'sg.risk_'), hint: t('sg.f_risk_hint') }]} onSubmit={async (v) => { await run({ action: 'reclassify', risk: v.risk }); return t('sg.updated'); }} />
          <FormSheet visible={form === 'assign'} onClose={() => setForm(null)} title={t('sg.a_assign')} submitLabel={t('common.save')}
            fields={[{ key: 'who', label: t('sg.case_assignee'), type: 'multimenu', max: 1, options: k.assignable.map((p) => ({ value: p.user_id, label: p.name, sub: t(`sg.tier_${p.tier}`) })), hint: t('sg.assign_hint') }]} onSubmit={async (v) => { await run({ action: 'assign', assignee_id: v.who?.[0] }); return t('sg.updated'); }} />
          <FormSheet visible={form === 'stage'} onClose={() => setForm(null)} title={t('sg.a_advance')} submitLabel={t('common.save')} initial={{ status: 'action' }}
            fields={[{ key: 'status', label: t('sg.f_stage'), type: 'chips', options: ['assessment', 'action', 'review'].map((s) => ({ value: s, label: stageText(s) })) }]} onSubmit={async (v) => { await run({ action: 'advance', status: v.status }); return t('sg.updated'); }} />
          <FormSheet visible={form === 'close'} onClose={() => setForm(null)} title={t('sg.a_close')} submitLabel={t('sg.a_close')} initial={{ close_reason: 'resolved' }} notice={<T size={13} color={c.mute}>{t('sg.close_notice')}</T>}
            fields={[{ key: 'close_reason', label: t('sg.f_reason'), type: 'chips', options: ['resolved', 'no_further_action', 'referred', 'monitoring_ended'].map((s) => ({ value: s, label: t(`sg.cr_${s}`) })) }, { key: 'outcome', label: t('sg.f_outcome'), type: 'multiline' }]}
            onSubmit={async (v) => { await run({ action: 'close', outcome: v.outcome, close_reason: v.close_reason }); return t('sg.updated'); }} />
          <FormSheet visible={form === 'decide'} onClose={() => setForm(null)} title={t('sg.a_decide')} submitLabel={t('common.save')} initial={{ decision: 'reported' }} notice={<T size={13} color={c.mute}>{t('sg.human_review')}</T>}
            fields={[...(k.report_rules.length ? [{ key: 'rule', label: t('sg.f_rule'), type: 'multimenu', max: 1, optional: true, options: k.report_rules.map((r) => ({ value: r.id, label: `${r.jurisdiction} · ${r.authority_label}` })) }] : []), { key: 'decision', label: t('sg.f_decision'), type: 'chips', options: ['reported', 'not_required', 'deferred'].map((s) => ({ value: s, label: t(`sg.dec_${s}`) })) }, { key: 'rationale', label: t('sg.f_rationale'), type: 'multiline', hint: t('sg.f_rationale_hint') }]}
            onSubmit={async (v) => { await api.post(`/academy/safeguarding/cases/${id}/report-decision`, { rule_id: v.rule?.[0], decision: v.decision, rationale: v.rationale }); full.reload(); onChanged?.(); return t('sg.updated'); }} />
          <FormSheet visible={form === 'action'} onClose={() => setForm(null)} title={t('sg.a_add_action')} submitLabel={t('common.save')} initial={{ kind: 'risk_review' }}
            fields={[{ key: 'kind', label: t('sg.f_kind'), type: 'chips', options: ['risk_review', 'guardian_contact', 'referral', 'training_or_checks', 'monitoring', 'report_review', 'other'].map((s) => ({ value: s, label: t(`sg.ak_${s}`) })) }, { key: 'owner', label: t('sg.f_owner'), type: 'multimenu', max: 1, optional: true, options: k.assignable.map((p) => ({ value: p.user_id, label: p.name })) }, { key: 'due_at', label: t('sg.f_due'), type: 'datetime', optional: true }, { key: 'note', label: t('sg.f_note'), type: 'multiline', optional: true }]}
            onSubmit={async (v) => { await api.post(`/academy/safeguarding/cases/${id}/actions`, { kind: v.kind, owner_id: v.owner?.[0], due_at: v.due_at || undefined, note: v.note || undefined }); full.reload(); return t('sg.updated'); }} />
          <FormSheet visible={form === 'evidence'} onClose={() => setForm(null)} title={t('sg.a_add_evidence')} submitLabel={t('common.save')} notice={<T size={13} color={c.mute}>{t('sg.ev_notice')}</T>}
            fields={[{ key: 'label', label: t('sg.f_label'), type: 'text' }, { key: 'url', label: t('sg.f_link'), type: 'text', hint: t('sg.f_link_hint') }]}
            onSubmit={async (v) => { await api.post(`/academy/safeguarding/cases/${id}/evidence`, { kind: 'link', label: v.label, url: v.url }); full.reload(); return t('sg.updated'); }} />
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ officers
function Officers({ o, toast, admin, onChanged }) {
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/safeguarding/officers`), [o.id]);
  const members = useLoad(() => (admin ? api.get(`/organisations/${o.id}/members`).catch(() => []) : Promise.resolve([])), [o.id, admin]);
  const campuses = useLoad(() => (admin ? api.get(`/organisations/${o.id}/campuses`).catch(() => null) : Promise.resolve(null)), [o.id, admin]);
  const [open, setOpen] = useState(false);
  const [ending, setEnding] = useState(null);
  const people = (Array.isArray(members.data) ? members.data : members.data?.members ?? []).filter((m) => m.status === 'active');
  const units = (campuses.data?.units ?? []).filter((u) => u.kind === 'campus');
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  return (
    <Card>
      <Block title={t('sg.off_title')} right={admin ? <Btn small title={t('sg.off_designate')} onPress={() => setOpen(true)} /> : null}>
        <T size={12} color={c.mute}>{t('sg.off_hint')}</T>
        {!d.data.items.length ? <Empty emoji="🧑‍⚖️" title={t('sg.off_empty')} sub={t('sg.off_empty_sub')} /> : d.data.items.map((p) => (
          <Row key={p.id} title={p.name} sub={`${t(`sg.tier_${p.tier}`)} · ${p.campus_name ?? t('sg.all_campuses')}`}
            right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Tag label={t(`sg.su_${p.suitability}`)} color={suitColor(p.suitability)} />{admin ? <Btn small title={t('sg.off_end')} color={c.paper} ink={c.red} onPress={() => setEnding(p)} /> : null}</View>} />
        ))}
      </Block>
      <FormSheet visible={open} onClose={() => setOpen(false)} title={t('sg.off_designate')} submitLabel={t('common.save')} initial={{ tier: '1' }}
        fields={[
          { key: 'user', label: t('sg.f_person'), type: 'multimenu', max: 1, options: people.map((m) => ({ value: m.user_id ?? m.id, label: m.display_name ?? m.handle })), hint: t('sg.off_cleared_hint') },
          { key: 'tier', label: t('sg.f_tier'), type: 'chips', options: [1, 2, 3].map((n) => ({ value: String(n), label: t(`sg.tier_${n}`) })) },
          ...(units.length ? [{ key: 'campus', label: t('sg.f_campus'), type: 'multimenu', max: 1, optional: true, options: units.map((u) => ({ value: u.id, label: u.name })), hint: t('sg.f_campus_hint') }] : []),
        ]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/safeguarding/officers`, { user_id: v.user?.[0], tier: Number(v.tier), unit_id: v.campus?.[0] }); d.reload(); onChanged?.(); return t('sg.updated'); }} />
      <FormSheet visible={!!ending} onClose={() => setEnding(null)} title={t('sg.off_end')} submitLabel={t('sg.off_end')} notice={<T size={13} color={c.mute}>{t('sg.off_end_notice')}</T>}
        fields={[{ key: 'reason', label: t('sg.f_reason_text'), type: 'text' }]}
        onSubmit={async (v) => { await api.post(`/academy/safeguarding/officers/${ending.id}/end`, { reason: v.reason }); d.reload(); onChanged?.(); return t('sg.updated'); }} />
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------------ suitability
function Suitability({ o }) {
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/safeguarding/suitability`, { limit: 100 }), [o.id]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  return (
    <Card>
      <Block title={t('sg.su_title')}>
        <T size={12} color={c.mute}>{t('sg.su_hint')}</T>
        {d.data.configured === false ? <Card color={c.violetSoft} pad={12}><T size={13}>{t('sg.su_none_hint')}</T></Card> : null}
        {!d.data.items.length ? <Empty emoji="🪪" title={t('sg.su_empty')} /> : d.data.items.map((s) => (
          <Row key={s.user_id} title={s.name} sub={s.reasons[0] ?? (s.sessions_to_reassign ? t('sg.su_reassign', { n: s.sessions_to_reassign }) : s.title ?? '')} right={<Tag label={t(`sg.su_${s.state}`)} color={suitColor(s.state)} />} />
        ))}
      </Block>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------------ policy, boundaries, reporting rules
function Policy({ o, toast }) {
  const p = useLoad(() => api.get(`/organisations/${o.id}/academy/safeguarding/policy`), [o.id]);
  const [edit, setEdit] = useState(false);
  const [rule, setRule] = useState(false);
  if (p.error) return <LoadError error={p.error} onRetry={p.reload} />;
  if (!p.data) return <Loading />;
  const d = p.data;
  const hr = (m) => RISKS.map((r) => `${riskText(r)} ${m[r]}${t('sg.h')}`).join(' · ');
  const initial = { ...Object.fromEntries(RISKS.flatMap((r) => [[`ack_${r}`, d.ack_hours[r]], [`rev_${r}`, d.review_hours[r]], [`esc_${r}`, d.escalate_after_hours[r]]])), retention_years: d.retention_years, require_guardian_copy: d.require_guardian_copy, allow_private_channels: d.allow_private_channels, quiet_from: d.quiet_from?.slice(0, 5), quiet_to: d.quiet_to?.slice(0, 5) };
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <Block title={t('sg.pol_title')} right={<Btn small title={t('sg.pol_edit')} onPress={() => setEdit(true)} />}>
          <Row title={t('sg.pol_ack')} sub={hr(d.ack_hours)} /><Row title={t('sg.pol_review')} sub={hr(d.review_hours)} /><Row title={t('sg.pol_escalate')} sub={hr(d.escalate_after_hours)} />
          <Row title={t('sg.pol_retention')} sub={t('sg.years', { n: d.retention_years })} />
          <Row title={t('sg.pol_guardian')} sub={d.require_guardian_copy ? t('pk.yes') : t('pk.no')} /><Row title={t('sg.pol_private')} sub={d.allow_private_channels ? t('pk.yes') : t('pk.no')} />
          <Row title={t('sg.pol_quiet')} sub={d.quiet_from ? `${d.quiet_from.slice(0, 5)}–${d.quiet_to?.slice(0, 5)}` : '–'} />
          {d.defaults ? <T size={12} color={c.mute}>{t('sg.pol_default')}</T> : <T size={12} color={c.mute}>{t('pk.policy_version', { n: d.version })}</T>}
        </Block>
      </Card>
      <Card>
        <Block title={t('sg.rules_title')} right={<Btn small title={t('sg.rule_add')} onPress={() => setRule(true)} />}>
          <T size={12} color={c.mute}>{t('sg.human_review')}</T>
          {!d.rules.length ? <Empty emoji="⚖️" title={t('sg.rules_empty')} sub={t('sg.rules_empty_sub')} /> : d.rules.map((r) => <Row key={r.id} title={`${r.jurisdiction} · ${t(`sg.cat_${r.incident_type}`)}`} sub={`${r.authority_label}${r.notify_within_hours ? ` · ${t('sg.within_h', { n: r.notify_within_hours })}` : ''}`} />)}
        </Block>
      </Card>
      <FormSheet visible={edit} onClose={() => setEdit(false)} title={t('sg.pol_title')} submitLabel={t('common.save')} initial={initial}
        fields={[
          ...RISKS.flatMap((r) => [
            { key: `ack_${r}`, label: `${t('sg.pol_ack')} · ${riskText(r)}`, type: 'stepper', min: 1, max: 2160, step: 1, suffix: ` ${t('sg.h')}` },
            { key: `rev_${r}`, label: `${t('sg.pol_review')} · ${riskText(r)}`, type: 'stepper', min: 1, max: 2160, step: 4, suffix: ` ${t('sg.h')}` },
            { key: `esc_${r}`, label: `${t('sg.pol_escalate')} · ${riskText(r)}`, type: 'stepper', min: 1, max: 2160, step: 4, suffix: ` ${t('sg.h')}` },
          ]),
          { key: 'retention_years', label: t('sg.pol_retention'), type: 'stepper', min: 1, max: 50, step: 1, suffix: ` ${t('sg.y')}` },
          { key: 'require_guardian_copy', label: t('sg.pol_guardian'), type: 'switch', hint: t('sg.pol_guardian_hint') },
          { key: 'allow_private_channels', label: t('sg.pol_private'), type: 'switch', hint: t('sg.pol_private_hint') },
          { key: 'quiet_from', label: t('sg.pol_quiet_from'), type: 'time', optional: true }, { key: 'quiet_to', label: t('sg.pol_quiet_to'), type: 'time', optional: true },
        ]}
        onSubmit={async (v) => {
          const m = (pre) => Object.fromEntries(RISKS.map((r) => [r, Number(v[`${pre}_${r}`])]));
          await api.post(`/organisations/${o.id}/academy/safeguarding/policy`, { ack_hours: m('ack'), review_hours: m('rev'), escalate_after_hours: m('esc'), retention_years: v.retention_years, require_guardian_copy: v.require_guardian_copy, allow_private_channels: v.allow_private_channels, quiet_from: v.quiet_from || null, quiet_to: v.quiet_to || null });
          p.reload(); return t('sg.updated');
        }} />
      <FormSheet visible={rule} onClose={() => setRule(false)} title={t('sg.rule_add')} submitLabel={t('common.save')} initial={{ incident_type: 'welfare' }} notice={<T size={13} color={c.mute}>{t('sg.human_review')}</T>}
        fields={[
          { key: 'jurisdiction', label: t('sg.f_juris'), type: 'country', hint: t('sg.f_juris_hint') },
          { key: 'incident_type', label: t('sg.f_category'), type: 'chips', options: opts(CATS, 'sg.cat_') },
          { key: 'authority_label', label: t('sg.f_authority'), type: 'text' },
          { key: 'notify_within_hours', label: t('sg.f_within'), type: 'stepper', min: 1, max: 720, step: 4, default: 24, suffix: ` ${t('sg.h')}` },
          { key: 'guidance', label: t('sg.f_guidance'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/safeguarding/report-rules`, { jurisdiction: v.jurisdiction, incident_type: v.incident_type, authority_label: v.authority_label, notify_within_hours: v.notify_within_hours, guidance: v.guidance || undefined }); p.reload(); return t('sg.updated'); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ athlete / guardian view
/** Safe communication: what the academy may and may not do, who the officers are, and a private way to raise a concern. Never shows whether a case exists. */
export function SafeCommunication({ o, athleteId, toast }) {
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/safeguarding/mine`, { athlete_id: athleteId }), [o.id, athleteId]);
  const [raise, setRaise] = useState(false);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const b = d.data.boundaries;
  return (
    <Card>
      <Block title={t('sg.fam_title')}>
        <T size={13} color={c.mute}>{t('sg.fam_sub')}</T>
        <Row title={t('sg.fam_academy_channel')} sub={t('sg.fam_academy_channel_sub')} />
        <Row title={t('sg.pol_guardian')} sub={b.guardian_copied ? t('pk.yes') : t('pk.no')} />
        <Row title={t('sg.pol_private')} sub={b.private_channels_allowed ? t('pk.yes') : t('pk.no')} />
        {b.quiet_from ? <Row title={t('sg.pol_quiet')} sub={`${b.quiet_from.slice(0, 5)}–${b.quiet_to?.slice(0, 5)}`} /> : null}
      </Block>
      <Block title={t('sg.fam_officers')}>
        {d.data.officers.length ? d.data.officers.map((p, i) => <Row key={i} title={p.name} sub={t(`sg.tier_${p.tier}`)} />) : <T size={13} color={c.mute}>{t('sg.fam_no_officers')}</T>}
        <Btn title={t('sg.fam_talk')} onPress={() => setRaise(true)} accessibilityLabel={t('sg.fam_talk')} />
        <T size={12} color={c.mute}>{t('sg.fam_emergency')}</T>
      </Block>
      <ConcernSheet o={o} visible={raise} onClose={() => setRaise(false)} toast={toast} athleteId={athleteId} />
    </Card>
  );
}
