// Academy OS 3/3 close-out pieces that plug into the existing Finance, Executive Home and Progress screens (no parallel console): branded PDF
// buttons, the "where the cost figures come from" strip, the by-branch view and branch filter, the Branches panel, real delivery figures
// and the decision follow-through. Every figure comes from an API capability; the UI only calls it. All text goes through t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { openProtected } from '../open-file';
import { c } from '../theme';
import { t } from '../i18n';
import { moneyIn } from '../vtime';
import { Bars, Block, Kpi, pct } from './academy-ui';
import { StatusChip } from './academy-elite';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const idem = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const M = (v, cur) => (v == null ? t('aco.missing') : moneyIn(v, cur));

/** Issue a branded PDF through the shared document stack and open it (a tab on the web, the share / open sheet on a phone or tablet). */
export function PackButton({ label, path, body, name, toast, color }) {
  const [busy, setBusy] = useState(false);
  const spoken = [label, t('aco.pack.hint')].join('. ');
  const run = async () => {
    setBusy(true);
    try { const d = await api.post(path, body ?? {}); await openProtected(`/branded-documents/${d.id}/file`, name); }
    catch (e) { toast?.(e.message); } finally { setBusy(false); }
  };
  return <Btn small title={busy ? t('aco.pack.busy') : label} loading={busy} color={color ?? c.paper} ink={c.ink} onPress={run} accessibilityLabel={spoken} />;
}

/** Where the staff and venue figures came from, and what could not be counted. Hidden when there is nothing to say. */
export function CostSources({ sources }) {
  if (!sources) return null;
  const gaps = [
    sources.payroll_unpriced_timesheets ? t('aco.src.unpriced', { n: sources.payroll_unpriced_timesheets }) : null,
    sources.venue_sessions_unbooked ? t('aco.src.unbooked', { n: sources.venue_sessions_unbooked }) : null,
    sources.manual_entries_superseded ? t('aco.src.superseded', { n: sources.manual_entries_superseded }) : null,
    sources.supplier_requests ? t('arc.src.supplier_n', { n: sources.supplier_requests }) : null,
    sources.payment_fee_lines ? t('arc.src.fees_n', { n: sources.payment_fee_lines }) : null,
  ].filter(Boolean);
  return (
    <View style={{ gap: 4 }} accessibilityRole="summary">
      <T size={12} color={c.mute}>{t('aco.src.body')}</T>
      {gaps.map((g) => <T key={g} size={12} weight="700" color={c.ink}>• {g}</T>)}
    </View>
  );
}

/** Programmes rolled up by branch for one currency. Shown only once a branch exists; programmes without one are an explicit Unassigned group. */
export function ByBranch({ rows, currency }) {
  if (!rows?.length || rows.every((r) => r.branch_id == null)) return null;
  return (
    <Block title={t('aco.branch.by')}>
      <Bars label={t('aco.branch.chart', { cur: currency })} rows={rows.map((b) => ({ label: b.branch_id ? b.name : t('aco.branch.unassigned'), value: b.operating_result_minor, text: `${M(b.operating_result_minor, currency)}${b.contribution_complete ? '' : ` (${t('aco.incomplete')})`}`, tone: b.operating_result_minor < 0 ? c.orange : undefined }))} />
      {rows.map((b) => (
        <Row key={b.branch_id ?? 'none'} title={b.branch_id ? b.name : t('aco.branch.unassigned')} sub={`${t('aco.branch.n_programmes', { n: b.programmes })} · ${t('aco.revenue')} ${M(b.management_revenue_minor, currency)} · ${t('aco.collected')} ${M(b.cash_collected_minor, currency)}${b.venue_level_cost_minor ? ` · ${t('arc.branch.venue_level', { amount: M(b.venue_level_cost_minor, currency) })}` : ''}`}
          right={<Tag label={b.contribution_complete ? pct(b.margin_pct) : t('aco.costs_missing')} color={b.contribution_complete ? undefined : c.sunSoft} />} />
      ))}
    </Block>
  );
}

/** Filter the P&L / executive view to one branch. Renders nothing until the academy has a branch. */
export function BranchFilter({ o, value, onChange }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/branches`).catch(() => null), [o.id]);
  const live = (list.data?.branches ?? []).filter((b) => !b.archived_at);
  if (!live.length) return null;
  return <MenuField label={t('aco.branch.label')} value={value ?? ''} onChange={(v) => onChange(v || null)} options={[{ value: '', label: t('aco.branch.all') }, ...live.map((b) => ({ value: b.id, label: b.name, sub: b.city ?? undefined }))]} />;
}

/** Real delivery figures from the Academy OS 2/3 sessions. A figure the data cannot show is labelled missing, never 0. */
export function DeliveryFacts({ d }) {
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('aco.deliv.scheduled')} value={d.sessions_scheduled} sub={t('aco.deliv.completed', { n: d.sessions_completed })} />
        <Kpi label={t('aco.deliv.cancelled')} value={d.sessions_cancelled} sub={d.cancellation_rate_pct == null ? t('aco.missing') : t('aco.deliv.rate', { pct: d.cancellation_rate_pct })} tone={d.sessions_cancelled ? 'alert' : undefined} />
        <Kpi label={t('aco.deliv.exceptions')} value={d.staffing_exceptions} sub={d.staffing_capped ? t('aco.deliv.capped', { n: d.staffing_sessions_checked }) : t('aco.deliv.exceptions_sub')} tone={d.staffing_exceptions ? 'alert' : undefined} />
        <Kpi label={t('aco.deliv.attendance')} value={pct(d.attendance_pct)} sub={t('aco.deliv.recorded', { n: d.sessions_recorded })} />
      </View>
      <T size={11} color={c.mute}>{d.formulas?.staffing_exceptions}</T>
    </>
  );
}

// ------------------------------------------------------------------ branches (Settings)
/** Branch profiles: manager, code, target and live figures from the scorecard, with the full set of fields a multi-site academy needs. */
export function Branches({ o, archived, toast }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/branches`), [o.id]);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 }), [o.id]);
  const members = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  const score = useLoad(() => api.get(`/organisations/${o.id}/academy/branch-scorecard`).catch(() => null), [o.id]);
  const [form, setForm] = useState(null), [assign, setAssign] = useState(null), [key, setKey] = useState('');
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const venueOptions = async (q) => (await api.get('/venues', { q: q || undefined, limit: 20 }).catch(() => [])).map((v) => ({ value: v.id, label: v.name, sub: v.city }));
  const live = list.data.branches.filter((b) => !b.archived_at), old = list.data.branches.filter((b) => b.archived_at);
  const progOptions = (progs.data ?? []).map((p) => ({ value: p.id, label: p.title }));
  const people = (members.data ?? []).filter((m) => ['owner', 'admin', 'coach', 'staff'].includes(m.org_role)).map((m) => ({ value: m.id ?? m.user_id, label: m.display_name, sub: m.org_role }));
  const metrics = (b) => (score.data?.branches ?? []).find((x) => x.branch_id === b.id);
  const sheetTitle = assign ? [assign.name, t('aco.branch.programmes')].join(' · ') : '';
  const archive = async (b) => { try { await api.post(`/academy/branches/${b.id}/archive`); list.reload(); } catch (e) { toast?.(e.message); } };
  const initial = form?.id ? { ...form, manager_id: form.manager_id ? [form.manager_id] : [], athlete_target: form.athlete_target ?? 0, opened_on: form.opened_on ? String(form.opened_on).slice(0, 10) : undefined } : { athlete_target: 0 };
  return (
    <Panel>
      <Block title={t('aco.branch.title')} right={!archived ? <Btn small title={t('aco.branch.add')} onPress={() => { setKey(idem('branch')); setForm({}); }} /> : null}>
        <T size={12} color={c.mute}>{t('aco.branch.intro')}</T>
        {live.length ? live.map((b) => {
          const m = metrics(b);
          return (
            <View key={b.id} style={{ padding: 14, borderRadius: 18, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <View style={{ flex: 1, minWidth: 140 }}><T weight="800" size={16}>{b.name}</T>{b.code ? <T size={12} color={c.mute}>{b.code}</T> : null}</View>
                {!archived ? (
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    <Btn small title={t('aco.branch.programmes')} color={c.paper} ink={c.ink} onPress={() => setAssign(b)} />
                    <Btn small title={t('aco.branch.edit')} color={c.paper} ink={c.ink} onPress={() => setForm(b)} />
                    <Btn small title={t('aco.branch.archive')} color={c.paper} ink={c.ink} onPress={() => archive(b)} />
                  </View>) : null}
              </View>
              <T size={12} color={c.mute}>{[b.city, b.address, b.venues.map((v) => v.name).join(', ')].filter(Boolean).join(' · ') || t('aco.branch.no_location')}</T>
              <T size={12}>{b.manager_name ? t('aco.mx.manager', { name: b.manager_name }) : t('aco.mx.no_manager')}{b.opened_on ? ` · ${t('aco.branch.opened_on', { date: String(b.opened_on).slice(0, 10) })}` : ''}</T>
              {m?.people ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <T size={13} weight="800">{t('aco.branch.athletes_n', { n: m.people.athletes })}{m.people.target ? ` / ${m.people.target}` : ''}</T>
                  <StatusChip status={m.people.utilisation.status} text={m.people.utilisation.value == null ? undefined : `${t('aco.mx.util')} ${m.people.utilisation.value}%`} />
                  <StatusChip status={m.delivery.attendance.status} text={m.delivery.attendance.value == null ? undefined : `${t('aco.mx.att')} ${m.delivery.attendance.value}%`} />
                </View>
              ) : null}
              <T size={12} color={c.mute}>{b.programmes.length ? b.programmes.map((p) => p.title).join(' · ') : t('aco.branch.no_programmes')}</T>
            </View>
          );
        }) : <Empty emoji="📍" title={t('aco.branch.empty_title')} sub={t('aco.branch.empty_sub')} />}
        {list.data.unassigned_programmes.length && live.length ? <T size={12} color={c.mute}>{t('aco.branch.n_unassigned', { n: list.data.unassigned_programmes.length })}</T> : null}
        {old.map((b) => <Row key={b.id} title={b.name} sub={t('aco.branch.n_programmes', { n: b.programmes.length })} right={<Tag label={t('aco.branch.archived')} />} />)}
      </Block>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.id ? t('aco.branch.edit') : t('aco.branch.add')} submitLabel={t('aco.save')} initial={initial}
        fields={[
          { key: 'name', label: t('aco.branch.name') }, { key: 'code', label: t('aco.branch.code'), optional: true, hint: t('aco.branch.code_hint') },
          { key: 'manager_id', label: t('aco.branch.manager'), type: 'multimenu', max: 1, options: people, placeholder: t('aco.branch.manager_ph'), optional: true },
          { key: 'city', label: t('aco.branch.city'), optional: true }, { key: 'address', label: t('aco.branch.address'), optional: true },
          { key: 'venue_ids', label: t('aco.branch.venues'), type: 'multimenu', load: venueOptions, placeholder: t('aco.branch.venues_ph'), optional: true },
          { key: 'opened_on', label: t('aco.branch.opened'), type: 'date', optional: true },
          { key: 'athlete_target', label: t('aco.branch.target'), type: 'stepper', min: 0, max: 5000, hint: t('aco.branch.target_hint'), optional: true },
        ]}
        onSubmit={async (v) => {
          const body = { name: v.name, code: v.code || undefined, manager_id: v.manager_id?.[0] || undefined, city: v.city || undefined, address: v.address || undefined, venue_ids: v.venue_ids ?? [], opened_on: v.opened_on || undefined, athlete_target: v.athlete_target > 0 ? v.athlete_target : undefined };
          if (form?.id) await api.post(`/academy/branches/${form.id}`, { ...body, code: v.code || null, manager_id: v.manager_id?.[0] || null, city: v.city || null, address: v.address || null, opened_on: v.opened_on || null, athlete_target: v.athlete_target > 0 ? v.athlete_target : null });
          else await api.post(`/organisations/${o.id}/academy/branches`, { ...body, idempotency_key: key });
          list.reload(); score.reload(); return t('aco.saved');
        }} />
      {assign ? (
        <FormSheet visible onClose={() => setAssign(null)} title={sheetTitle} submitLabel={t('aco.save')} initial={{ programme_ids: assign.programmes.map((p) => p.id) }}
          fields={[{ key: 'programme_ids', label: t('aco.branch.programmes'), type: 'multimenu', options: progOptions, hint: t('aco.branch.assign_hint'), optional: true }]}
          onSubmit={async (v) => {
            const now = new Set(v.programme_ids ?? []), was = new Set(assign.programmes.map((p) => p.id));
            for (const pid of now) if (!was.has(pid)) await api.post(`/academy/programmes/${pid}/branch`, { branch_id: assign.id });
            for (const pid of was) if (!now.has(pid)) await api.post(`/academy/programmes/${pid}/branch`, { branch_id: null });
            list.reload(); score.reload(); return t('aco.saved');
          }} />
      ) : null}
    </Panel>
  );
}

// ------------------------------------------------------------------ decision follow-through (Progress)
const ACTION = { graduate: 'issue_certificate', invite_squad: 'invite_squad', move_programme: 'move_cohort' };

/** One recorded decision that has a canonical next step. The work is done by the certificate, team-invitation or enrolment-transfer capability. */
function FollowRow({ o, athleteId, d, toast }) {
  const action = ACTION[d.decision];
  const ups = useLoad(() => api.get(`/academy/decisions/${d.id}/follow-ups`).catch(() => []), [d.id]);
  const [open, setOpen] = useState(false);
  const mem = useLoad(() => (open ? api.get(`/organisations/${o.id}/academy/athletes/${athleteId}/360`).then((x) => x.sections?.memberships?.data ?? []).catch(() => []) : Promise.resolve([])), [open, athleteId]);
  const cohorts = useLoad(() => (open && action === 'move_cohort' ? api.get(`/organisations/${o.id}/cohorts`, { limit: 100 }).catch(() => []) : Promise.resolve([])), [open, action]);
  const done = (ups.data ?? []).some((x) => x.kind === action);
  const enrol = (mem.data ?? []).filter((m) => (action === 'issue_certificate' ? ['completed', 'graduated'] : ['enrolled', 'paused']).includes(m.status)).map((m) => ({ value: m.id, label: `${m.programme ?? m.group_name} · ${m.group_name}`, sub: m.status }));
  const fields = action === 'invite_squad'
    ? [{ key: 'team_id', label: t('aco.ft.team'), type: 'entity', entityKind: 'team', noun: t('aco.ft.team_noun') }, { key: 'role', label: t('aco.ft.role'), type: 'chips', options: [{ value: 'player', label: t('aco.ft.role_player') }, { value: 'captain', label: t('aco.ft.role_captain') }] }, { key: 'message', label: t('aco.ft.message'), optional: true }]
    : action === 'issue_certificate'
      ? [{ key: 'enrolment_id', label: t('aco.ft.enrolment'), type: 'choice', options: enrol, hint: enrol.length ? undefined : t('aco.ft.cert_needs') }, { key: 'kind', label: t('aco.ft.kind'), type: 'chips', options: ['certificate', 'badge', 'diploma'].map((value) => ({ value, label: t(`aco.ft.kind.${value}`) })) }, { key: 'title', label: t('aco.ft.cert_title'), optional: true }]
      : [{ key: 'enrolment_id', label: t('aco.ft.enrolment'), type: 'choice', options: enrol }, { key: 'to_cohort_id', label: t('aco.ft.cohort'), type: 'choice', options: (cohorts.data ?? []).map((k) => ({ value: k.id, label: k.name })) }, { key: 'reason', label: t('aco.ft.reason'), optional: true }];
  return (
    <>
      <Row title={t(`aco.ft.title.${action}`)} sub={done ? t(`aco.ft.done.${action}`) : t('aco.ft.sub')}
        right={done ? <Tag label={t('aco.ft.tag_done')} color={c.lime} /> : <Btn small title={t(`aco.ft.btn.${action}`)} onPress={() => setOpen(true)} />} />
      {open ? (
        <FormSheet visible onClose={() => setOpen(false)} title={t(`aco.ft.title.${action}`)} submitLabel={t(`aco.ft.btn.${action}`)} fields={fields}
          initial={{ role: 'player', kind: 'certificate', enrolment_id: enrol[0]?.value }}
          onSubmit={async (v) => { const body = { action }; for (const f of fields) if (v[f.key]) body[f.key] = v[f.key]; await api.post(`/academy/decisions/${d.id}/follow-through`, body); ups.reload(); return t(`aco.ft.done.${action}`); }} />
      ) : null}
    </>
  );
}

/** The next steps for an athlete's graduation / squad / programme-move decisions. Nothing runs by itself: a person presses the button. */
export function FollowThrough({ o, athleteId, history, toast }) {
  const rows = (history ?? []).filter((h) => ACTION[h.decision]).slice(0, 3);
  if (!rows.length) return null;
  return (
    <Block title={t('aco.ft.block')}>
      <T size={12} color={c.mute}>{t('aco.ft.intro')}</T>
      {rows.map((d) => <FollowRow key={d.id} o={o} athleteId={athleteId} d={d} toast={toast} />)}
    </Block>
  );
}

/** Source badge text for a drill-down line. */
export const sourceLabel = (kind) => t(`aco.line.${kind}`);
