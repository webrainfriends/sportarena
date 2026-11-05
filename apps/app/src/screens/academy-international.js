// International admissions & relocation readiness (#799), inside Organisation > Academy. Staff run the board, the checklist templates and the residences;
// the same checklist opens from an application's review. Every rule (the enrol gate, guardian permission, owner-approved conditions, the passport/visa
// vault) is enforced by the API (capability academy-international.js); this screen only calls it. Passport and visa numbers are never shown here:
// staff see status and expiry, the holder or a verified guardian reveals the number from the family checklist. All text goes through t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Counter } from '../pickers';
import { countryName } from '../country-picker';
import { c } from '../theme';
import { Block, Kpi, Timeline, when } from './academy-ui';

const KINDS = ['eligibility', 'guardian_permission', 'travel_document', 'school', 'residence', 'transport', 'medical', 'custom'];
const RES_KINDS = ['residence_hall', 'host_family', 'apartment', 'partner_hotel', 'other'];
const QUICK = [['passport', 'travel_document'], ['visa', 'travel_document'], ['guardian_legal_permission', 'guardian_permission'], ['school_place', 'school'], ['residence_place', 'residence'], ['arrival_transport', 'transport']];
const opts = (list, key) => list.map((v) => ({ value: v, label: t(`${key}${v}`) }));
const itemTone = (i) => (i.met ? [t('intl.s_met'), c.mint] : i.status === 'rejected' ? [t('intl.s_rejected'), c.red] : i.status === 'submitted' ? [t('intl.s_submitted'), c.sun] : i.issues?.some((x) => ['expired', 'evidence_lapsed', 'passport_validity', 'visa_not_granted', 'document_missing'].includes(x)) ? [t('intl.s_attention'), c.red] : [t('intl.s_open'), c.violetSoft]);
const condTone = (s) => ({ proposed: [t('intl.c_proposed'), c.violetSoft], approved: [t('intl.c_approved'), c.sun], met: [t('intl.c_met'), c.mint], withdrawn: [t('intl.c_withdrawn'), c.violetSoft] }[s] ?? [s, c.violetSoft]);
const issueText = (x) => t(`intl.issue_${x}`);
const dueText = (n) => (n == null ? '' : n < 0 ? t('intl.overdue_by', { n: -n }) : n === 0 ? t('intl.today') : t('intl.in_days', { n }));
const back = (x) => `‹ ${x}`, plus = (x) => `+ ${x}`, dot = (...a) => a.filter(Boolean).join(' · ');
const Alert = ({ tone, children }) => <View style={{ borderRadius: 18, padding: 14, borderWidth: 1, borderColor: tone === 'red' ? c.red : c.orange, backgroundColor: tone === 'red' ? c.redSoft : c.orangeSoft, gap: 4 }} accessibilityRole="alert">{children}</View>;

function Bar({ met, total, tone }) {
  const pct = total ? Math.round((met / total) * 100) : 100;
  return (
    <View style={{ gap: 4 }} accessible accessibilityLabel={t('intl.bar_a11y', { met, total })}>
      <View style={{ height: 8, borderRadius: 6, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: 8, backgroundColor: tone ?? (pct === 100 ? c.lime : pct >= 50 ? c.sun : c.red) }} /></View>
      <T size={12} color={c.mute}>{t('intl.bar_line', { met, total })}</T>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ the desk
export function InternationalDesk({ o, role, archived, toast, focus }) {
  const { tablet } = useLayout();
  const [tab, setTab] = useState('board');
  const [open, setOpen] = useState(focus?.open ?? null);   // an application id
  const [tpl, setTpl] = useState(null);
  const [res, setRes] = useState(null);
  const board = useLoad(() => api.get(`/organisations/${o.id}/academy/international/board`), [o.id]);
  const tpls = useLoad(() => api.get(`/organisations/${o.id}/academy/international/templates`), [o.id]);
  const resid = useLoad(() => api.get(`/organisations/${o.id}/academy/residences`), [o.id]);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`, { limit: 100 }), [o.id]);
  const can = (role === 'owner' || role === 'admin') && !archived;
  if (open) return <CaseView appId={open} o={o} role={role} can={can} toast={toast} onBack={() => { setOpen(null); board.reload(); }} />;
  if (board.error) return <LoadError error={board.error} onRetry={board.reload} />;
  if (!board.data) return <Loading />;
  const s = board.data.summary;
  const tabs = [['board', t('intl.tab_board')], ['templates', t('intl.tab_templates')], ['residences', t('intl.tab_residences')]];
  const col = tablet ? { flex: 1, width: undefined } : { width: '100%' };
  return (
    <View style={{ gap: 12 }}>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('intl.title')}</T><T color={c.mute}>{t('intl.subtitle')}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{tabs.map(([key, label]) => <Chip key={key} label={label} active={tab === key} onPress={() => setTab(key)} />)}</View>
      {tab === 'board' ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Kpi label={t('intl.k_athletes')} value={s.total} sub={t('intl.k_arriving', { n: s.arriving_30d })} />
            <Kpi label={t('intl.k_ready')} value={s.ready} sub={t('intl.k_ready_sub', { n: s.total })} />
            <Kpi label={t('intl.k_blocked')} value={s.blocked} sub={t('intl.k_blocked_sub')} tone={s.blocked ? 'alert' : undefined} />
            <Kpi label={t('intl.k_overdue')} value={s.overdue} sub={t('intl.k_overdue_sub')} tone={s.overdue ? 'alert' : undefined} />
          </View>
          <Card>
            <Block title={t('intl.board_title')}>
              {board.data.cases.length ? board.data.cases.map((k) => (
                <Card key={k.case_id} pad={12} onPress={() => setOpen(k.application_id)} accessibilityLabel={k.athlete_name}>
                  <View style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{k.athlete_name}</T><Tag label={k.ready ? t('intl.ready') : t('intl.not_ready')} color={k.ready ? c.mint : c.orange} /></View>
                    <T size={13} color={c.mute}>{dot(k.programme_title, countryName(k.origin_country), k.arrival_on ? `${t('intl.arrives')} ${when(k.arrival_on)}` : t('intl.no_arrival'))}</T>
                    <Bar met={k.mandatory_met} total={k.mandatory_total} />
                    <T size={12} color={k.overdue_items || k.tasks_overdue ? c.red : c.mute}>{k.next_deadline ? t('intl.next_deadline', { label: k.next_deadline.label, date: when(k.next_deadline.due_on) }) : t('intl.no_deadline')}{k.tasks_open ? ` · ${t('intl.tasks_open', { n: k.tasks_open })}` : ''}</T>
                  </View>
                </Card>
              )) : <Empty emoji="🌍" title={t('intl.empty_board_title')} sub={t('intl.empty_board_sub')} />}
            </Block>
          </Card>
        </>
      ) : null}
      {tab === 'templates' ? (
        <Card>
          <Block title={t('intl.tab_templates')} right={can ? <Btn small title={plus(t('intl.new_template'))} onPress={() => setTpl('new')} /> : null}>
            {tpls.data?.length ? tpls.data.map((x) => (
              <Row key={x.id} onPress={can ? () => setTpl(x) : undefined} left={<T size={22}>🧾</T>} title={x.name} right={<Tag label={t('intl.version', { n: x.version })} color={c.violetSoft} />}
                sub={dot(x.programme_title ?? t('intl.all_programmes'), x.countries.length ? x.countries.map(countryName).join(', ') : t('intl.any_country'), t('intl.items_n', { n: x.items.length }), t('intl.cases_n', { n: x.cases }))} />
            )) : <Empty emoji="🧾" title={t('intl.empty_tpl_title')} sub={t('intl.empty_tpl_sub')} />}
            <T size={12} color={c.mute}>{t('intl.tpl_note')}</T>
          </Block>
        </Card>
      ) : null}
      {tab === 'residences' ? (
        <Card style={col}>
          <Block title={t('intl.tab_residences')} right={can ? <Btn small title={plus(t('intl.new_residence'))} onPress={() => setRes('new')} /> : null}>
            {resid.data?.length ? resid.data.map((r) => (
              <Row key={r.id} onPress={can ? () => setRes(r) : undefined} left={<T size={22}>🏠</T>} title={r.name} right={<Tag label={r.status === 'active' ? t('intl.res_active') : t('intl.res_archived')} color={r.status === 'active' ? c.mint : c.violetSoft} />}
                sub={dot(t(`intl.rk_${r.kind}`), r.capacity != null ? t('intl.res_placed', { n: r.placed, cap: r.capacity }) : t('intl.res_placed_nocap', { n: r.placed }))} />
            )) : <Empty emoji="🏠" title={t('intl.empty_res_title')} sub={t('intl.empty_res_sub')} />}
          </Block>
        </Card>
      ) : null}
      <TemplateSheet o={o} edit={tpl} programmes={progs.data ?? []} onClose={() => setTpl(null)} onSaved={() => { tpls.reload(); toast(t('intl.saved')); }} />
      <ResidenceSheet o={o} edit={res} onClose={() => setRes(null)} onSaved={() => { resid.reload(); toast(t('intl.saved')); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ templates & residences
function TemplateSheet({ o, edit, programmes, onClose, onSaved }) {
  const f = edit && edit !== 'new' ? edit : null;
  const progOptions = [{ value: '', label: t('intl.all_programmes') }, ...programmes.map((p) => ({ value: p.id, label: p.title }))];
  return (
    <FormSheet visible={!!edit} onClose={onClose} title={f ? t('intl.edit_template') : t('intl.new_template')} submitLabel={f ? t('intl.publish_version') : t('common.save')}
      initial={f ? { name: f.name, programme_id: f.programme_id ?? '', countries: f.countries, items: f.items } : { programme_id: '', countries: [], items: [] }}
      fields={[
        { key: 'name', label: t('intl.f_name') },
        { key: 'programme_id', label: t('intl.f_programme'), type: 'custom', render: ({ v, set }) => <MenuField label={t('intl.f_programme')} value={v.programme_id ?? ''} onChange={(x) => set('programme_id', x)} options={progOptions} /> },
        { key: 'countries', label: t('intl.f_countries'), type: 'countries', optional: true, hint: t('intl.f_countries_hint') },
        { key: 'items', label: t('intl.f_items'), type: 'custom', render: ({ v, set }) => <ItemsEditor items={v.items ?? []} onChange={(x) => set('items', x)} /> },
        { key: 'note', label: t('intl.f_note'), optional: true },
      ]}
      onSubmit={async (v) => {
        if (!v.items?.length) throw new Error(t('intl.err_items'));
        const body = { name: v.name, programme_id: v.programme_id || null, countries: v.countries ?? [], note: v.note || undefined, items: v.items.map(({ key, kind, label, mandatory, lead_days, expiry_months }) => ({ key, kind, label, mandatory, lead_days, ...(expiry_months ? { expiry_months } : {}) })) };
        try { await api.post(`/organisations/${o.id}/academy/international/templates`, f ? { ...body, template_id: f.id } : body); onSaved(); return t('intl.saved'); } catch (e) { throw new Error(explain(e)); }
      }} />
  );
}

/** The checklist items of a template: quick-picks for the usual ones, then label, kind, mandatory and how many days before arrival each is due. */
function ItemsEditor({ items, onChange }) {
  const have = new Set(items.map((i) => i.key));
  const add = (key, kind, label) => { let k = key; for (let n = 2; have.has(k); n++) k = `${key}_${n}`; onChange([...items, { key: k, kind, label: label ?? t(`intl.q_${key}`), mandatory: true, lead_days: 30 }]); };
  const patch = (idx, p) => onChange(items.map((x, n) => (n === idx ? { ...x, ...p } : x)));
  return (
    <View style={{ gap: 10 }}>
      <T weight="800" size={13}>{t('intl.f_items')}</T>
      <T size={12} color={c.mute}>{t('intl.quick_add')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{QUICK.filter(([k]) => !have.has(k)).map(([k, kind]) => <Chip key={k} label={plus(t(`intl.q_${k}`))} onPress={() => add(k, kind)} />)}<Chip label={plus(t('intl.q_custom'))} onPress={() => add('custom_item', 'custom', t('intl.q_custom'))} /></View>
      {items.map((it, idx) => (
        <Card key={it.key} pad={12} color={c.violetSoft}>
          <View style={{ gap: 8 }}>
            <Field label={t('intl.i_label')} value={it.label} onChangeText={(x) => patch(idx, { label: x })} maxLength={200} />
            <MenuField label={t('intl.i_kind')} value={it.kind} onChange={(x) => patch(idx, { kind: x })} options={opts(KINDS, 'intl.k_')} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <Chip label={it.mandatory ? t('intl.mandatory') : t('intl.optional')} active={it.mandatory} onPress={() => patch(idx, { mandatory: !it.mandatory })} />
              <Counter value={it.lead_days} onChange={(x) => patch(idx, { lead_days: x })} min={0} max={730} step={5} suffix={` ${t('intl.days_before')}`} a11y={t('intl.i_lead')} />
            </View>
            <Btn small title={t('intl.remove')} color={c.paper} ink={c.ink} onPress={() => onChange(items.filter((_, n) => n !== idx))} style={{ alignSelf: 'flex-start' }} />
          </View>
        </Card>
      ))}
    </View>
  );
}

function ResidenceSheet({ o, edit, onClose, onSaved }) {
  const f = edit && edit !== 'new' ? edit : null;
  return (
    <FormSheet visible={!!edit} onClose={onClose} title={f ? t('intl.edit_residence') : t('intl.new_residence')} submitLabel={t('common.save')}
      initial={f ? { name: f.name, kind: f.kind, capacity: f.capacity ?? 0, status: f.status } : { kind: 'residence_hall', capacity: 20, status: 'active' }}
      fields={[
        { key: 'name', label: t('intl.f_name') },
        { key: 'kind', label: t('intl.f_res_kind'), type: 'chips', options: opts(RES_KINDS, 'intl.rk_') },
        { key: 'capacity', label: t('intl.f_capacity'), type: 'stepper', min: 0, max: 5000, step: 1 },
        { key: 'address', label: t('intl.f_address'), optional: true, hint: t('intl.f_enc_hint') },
        { key: 'contact', label: t('intl.f_contact'), optional: true, hint: t('intl.f_enc_hint') },
        ...(f ? [{ key: 'status', label: t('intl.f_status'), type: 'chips', options: [{ value: 'active', label: t('intl.res_active') }, { value: 'archived', label: t('intl.res_archived') }] }] : []),
      ]}
      onSubmit={async (v) => { try { await api.post(`/organisations/${o.id}/academy/residences`, { ...v, residence_id: f?.id, address: v.address || undefined, contact: v.contact || undefined }); onSaved(); return t('intl.saved'); } catch (e) { throw new Error(explain(e)); } }} />
  );
}

// ------------------------------------------------------------------------------------------------------------------ one case
export function CaseView({ appId, o, role, can, toast, onBack }) {
  const d = useLoad(() => api.get(`/academy/applications/${appId}/international`), [appId]);
  const members = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  const resid = useLoad(() => api.get(`/organisations/${o.id}/academy/residences`).catch(() => []), [o.id]);
  const [decide, setDecide] = useState(null);   // { item, decision }
  const [doc, setDoc] = useState(null);         // 'passport' | 'visa'
  const [cond, setCond] = useState(false);
  const [task, setTask] = useState(false);
  const [edit, setEdit] = useState(false);
  const { tablet } = useLayout();
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const k = d.data, r = k.readiness, owner = role === 'owner';
  const act = async (fn, ok) => { try { await fn(); toast(ok); d.reload(); } catch (e) { toast(explain(e)); } };
  const people = (Array.isArray(members.data) ? members.data : members.data?.members ?? []).filter((m) => m.status === 'active' && ['owner', 'admin'].includes(m.role)).map((m) => ({ value: m.user_id ?? m.id, label: m.display_name ?? m.handle }));
  const days = k.arrival_on ? Math.round((new Date(`${k.arrival_on}T12:00:00Z`) - Date.now()) / 864e5) : null;
  const col = tablet ? { flex: 1, width: undefined } : { width: '100%' };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Btn small title={back(t('intl.title'))} color={c.paper} ink={c.ink} onPress={onBack} /><Tag label={r.ready ? t('intl.ready') : t('intl.not_ready')} color={r.ready ? c.mint : c.orange} /></View>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{k.application.athlete_name}</T><T color={c.mute}>{dot(k.application.programme_title, countryName(k.origin_country), t('intl.template_ver', { n: k.template.version }))}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('intl.k_mandatory')} value={`${r.mandatory_met}/${r.mandatory_total}`} sub={t('intl.k_mandatory_sub')} tone={r.mandatory_met < r.mandatory_total ? 'alert' : undefined} />
        <Kpi label={t('intl.k_conditions')} value={`${r.conditions_met}/${r.conditions_total}`} sub={t('intl.k_conditions_sub')} />
        <Kpi label={t('intl.k_arrival')} value={days == null ? '–' : days} sub={days == null ? t('intl.no_arrival') : days < 0 ? t('intl.days_past') : t('intl.days_to_go')} />
        <Kpi label={t('intl.k_tasks')} value={k.tasks.filter((x) => x.status === 'open').length} sub={t('intl.k_tasks_sub')} />
      </View>
      {!r.ready ? (
        <Alert tone="orange">
          <T weight="700">{t('intl.blocked_title')}</T>
          <T size={13} color={c.mute}>{t('intl.blocked_sub')}</T>
          {r.blocking.map((b, n) => <T key={n} size={13}>{`• ${b.label} — ${b.issues.map(issueText).join(', ')}`}</T>)}
        </Alert>
      ) : <Alert tone="none"><T weight="700">{t('intl.ready_title')}</T><T size={13} color={c.mute}>{t('intl.ready_sub')}</T></Alert>}
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
        <View style={[{ gap: 12 }, col]}>
          <Card>
            <Block title={t('intl.checklist')}>
              {k.items.map((i) => {
                const [label, tone] = itemTone(i);
                return (
                  <Card key={i.id} pad={12} color={c.paper}>
                    <View style={{ gap: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{i.label}</T><Tag label={label} color={tone} /></View>
                      <T size={12} color={c.mute}>{dot(t(`intl.k_${i.kind}`), i.mandatory ? t('intl.mandatory') : t('intl.optional'), i.due_on ? `${t('intl.due')} ${when(i.due_on)}${i.overdue ? ` (${t('intl.overdue')})` : ''}` : null, i.expires_on ? `${t('intl.evidence_expires')} ${when(i.expires_on)}` : null)}</T>
                      {!i.met && i.issues.length ? <T size={12} color={c.red}>{i.issues.map(issueText).join(' · ')}</T> : null}
                      {can ? (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                          {i.status !== 'verified' ? <Btn small title={t('intl.verify')} onPress={() => setDecide({ item: i, decision: 'verify' })} /> : null}
                          {['open', 'submitted', 'verified'].includes(i.status) ? <Btn small title={t('intl.reject')} color={c.paper} ink={c.ink} onPress={() => setDecide({ item: i, decision: 'reject' })} /> : null}
                          {owner && !['eligibility', 'guardian_permission', 'travel_document'].includes(i.kind) && i.status !== 'waived' ? <Btn small title={t('intl.waive')} color={c.paper} ink={c.ink} onPress={() => setDecide({ item: i, decision: 'waive' })} /> : null}
                          {['verified', 'rejected', 'waived'].includes(i.status) ? <Btn small title={t('intl.reopen')} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/international/items/${i.id}/decision`, { decision: 'reopen' }), t('intl.reopened'))} /> : null}
                        </View>
                      ) : null}
                    </View>
                  </Card>
                );
              })}
            </Block>
          </Card>
          <Card>
            <Block title={t('intl.documents')} right={<Tag label={t('intl.vault')} color={c.ink} />}>
              {k.documents.map((x) => (
                <Row key={x.kind} onPress={can ? () => setDoc(x.kind) : undefined} left={<T size={22}>{x.kind === 'passport' ? '🛂' : '🪪'}</T>} title={t(`intl.doc_${x.kind}`)}
                  sub={x.status ? dot(t(`intl.ds_${x.status}`), x.expires_on ? `${t('intl.expires')} ${when(x.expires_on)}` : null) : t('intl.doc_none')} right={x.status ? <Tag label={t('intl.doc_recorded')} color={c.mint} /> : <Tag label={t('intl.s_open')} color={c.violetSoft} />} />
              ))}
              <T size={12} color={c.mute}>{t('intl.vault_note')}</T>
            </Block>
          </Card>
        </View>
        <View style={[{ gap: 12 }, col]}>
          <Card>
            <Block title={t('intl.conditions')} right={can ? <Btn small title={plus(t('intl.add_condition'))} onPress={() => setCond(true)} /> : null}>
              {k.conditions.length ? k.conditions.map((x) => {
                const [label, tone] = condTone(x.status);
                return (
                  <View key={x.id} style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="600" style={{ flex: 1 }}>{x.text}</T><Tag label={label} color={tone} /></View>
                    {can ? (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {x.status === 'proposed' && owner ? <Btn small title={t('intl.approve')} onPress={() => act(() => api.post(`/academy/international/conditions/${x.id}/decision`, { decision: 'approve' }), t('intl.approved'))} /> : null}
                        {x.status === 'proposed' && !owner ? <T size={12} color={c.mute}>{t('intl.awaiting_owner')}</T> : null}
                        {x.status === 'approved' ? <Btn small title={t('intl.mark_met')} onPress={() => act(() => api.post(`/academy/international/conditions/${x.id}/decision`, { decision: 'met' }), t('intl.marked_met'))} /> : null}
                        {['proposed', 'approved'].includes(x.status) && (owner || x.status === 'proposed') ? <Btn small title={t('intl.withdraw')} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/academy/international/conditions/${x.id}/decision`, { decision: 'withdraw' }), t('intl.withdrawn'))} /> : null}
                      </View>
                    ) : null}
                  </View>
                );
              }) : <Empty emoji="📎" title={t('intl.empty_cond_title')} sub={t('intl.empty_cond_sub')} />}
            </Block>
          </Card>
          <Card>
            <Block title={t('intl.arrival_board')} right={can ? <Btn small title={plus(t('intl.add_task'))} onPress={() => setTask(true)} /> : null}>
              {k.tasks.length ? k.tasks.map((x) => (
                <Row key={x.id} left={<T size={20}>{x.status === 'done' ? '✅' : x.status === 'cancelled' ? '⛔' : '⬜'}</T>} title={x.title}
                  sub={dot(x.owner_name, x.due_on ? `${t('intl.due')} ${when(x.due_on)}` : null)}
                  right={can && x.status === 'open' ? <Btn small title={t('intl.done')} color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/academy/international/tasks/${x.id}`, { status: 'done' }), t('intl.task_done'))} /> : null} />
              )) : <Empty emoji="🧳" title={t('intl.empty_task_title')} sub={t('intl.empty_task_sub')} />}
            </Block>
          </Card>
          <Card>
            <Block title={t('intl.links')} right={can ? <Btn small title={t('intl.edit')} color={c.paper} ink={c.ink} onPress={() => setEdit(true)} /> : null}>
              <Row title={t('intl.reviewer')} sub={k.reviewer?.display_name ?? t('intl.any_admin')} />
              <Row title={t('intl.f_arrival')} sub={k.arrival_on ? when(k.arrival_on) : t('intl.no_arrival')} />
              <Row title={t('intl.school')} sub={k.school_name ?? t('intl.not_linked')} />
              <Row title={t('intl.residence')} sub={k.residence_name ?? t('intl.not_linked')} />
              <T size={12} color={c.mute}>{t('intl.links_note')}</T>
            </Block>
          </Card>
        </View>
      </View>
      <Card>
        <Block title={t('intl.history')} right={<Tag label={t('intl.locked')} color={c.ink} />}>
          {k.history?.length ? <Timeline items={k.history.map((e) => ({ title: t(`intl.ev_${e.kind}`), sub: dot(e.actor_name, when(e.created_at)) }))} /> : <Empty emoji="🧾" title={t('intl.empty_hist_title')} sub={t('intl.empty_hist_sub')} />}
          <T size={12} color={c.mute}>{t('intl.history_note')}</T>
        </Block>
      </Card>
      <DecisionSheet ctx={decide} onClose={() => setDecide(null)} onDone={() => { setDecide(null); d.reload(); }} toast={toast} />
      <DocSheet kase={k} kind={doc} onClose={() => setDoc(null)} onDone={() => { setDoc(null); d.reload(); }} />
      <FormSheet visible={cond} onClose={() => setCond(false)} title={t('intl.add_condition')} submitLabel={t('common.save')} initial={{}}
        fields={[{ key: 'text', label: t('intl.f_condition'), hint: t('intl.f_condition_hint') }, { key: 'item_key', label: t('intl.f_link_item'), type: 'chips', optional: true, options: k.items.map((i) => ({ value: i.key, label: i.label })) }]}
        onSubmit={async (v) => { try { await api.post(`/academy/international/${k.id}/conditions`, { text: v.text, item_key: v.item_key || undefined }); d.reload(); return t('intl.saved'); } catch (e) { throw new Error(explain(e)); } }} />
      <FormSheet visible={task} onClose={() => setTask(false)} title={t('intl.add_task')} submitLabel={t('common.save')} initial={{}}
        fields={[{ key: 'title', label: t('intl.f_task') }, { key: 'due_on', label: t('intl.f_due'), type: 'date', optional: true, max: k.arrival_on ?? undefined }, { key: 'owner_id', label: t('intl.f_owner'), type: 'chips', optional: true, options: people }]}
        onSubmit={async (v) => { try { await api.post(`/academy/international/${k.id}/tasks`, { title: v.title, due_on: v.due_on || undefined, owner_id: v.owner_id || undefined }); d.reload(); return t('intl.saved'); } catch (e) { throw new Error(explain(e)); } }} />
      <FormSheet visible={edit} onClose={() => setEdit(false)} title={t('intl.links')} submitLabel={t('common.save')}
        initial={{ arrival_on: k.arrival_on ?? undefined, reviewer_id: k.reviewer?.id ?? '', residence_id: k.residence_id ?? '' }}
        fields={[{ key: 'arrival_on', label: t('intl.f_arrival'), type: 'date', optional: true, min: undefined }, { key: 'reviewer_id', label: t('intl.reviewer'), type: 'chips', optional: true, options: [{ value: '', label: t('intl.any_admin') }, ...people] },
          { key: 'residence_id', label: t('intl.residence'), type: 'custom', render: ({ v, set }) => <MenuField label={t('intl.residence')} value={v.residence_id ?? ''} onChange={(x) => set('residence_id', x)} options={[{ value: '', label: t('intl.not_linked') }, ...(resid.data ?? []).filter((x) => x.status === 'active').map((x) => ({ value: x.id, label: x.name }))]} /> }]}
        onSubmit={async (v) => { try { await api.patch(`/academy/international/${k.id}`, { row_version: k.row_version, arrival_on: v.arrival_on || null, reviewer_id: v.reviewer_id || null, residence_id: v.residence_id || null }); d.reload(); return t('intl.saved'); } catch (e) { throw new Error(explain(e)); } }} />
    </View>
  );
}

function DecisionSheet({ ctx, onClose, onDone, toast }) {
  const it = ctx?.item, dec = ctx?.decision;
  const needsDate = dec === 'verify' && (it?.kind === 'guardian_permission' || it?.kind === 'eligibility' || it?.kind === 'medical');
  return (
    <FormSheet visible={!!ctx} onClose={onClose} title={it ? `${t(`intl.${dec}`)} · ${it.label}` : ''} submitLabel={t(`intl.${dec}`)} initial={{ expires_on: it?.expires_on ?? undefined }}
      fields={[
        ...(dec === 'verify' ? [{ key: 'expires_on', label: t('intl.f_evidence_expiry'), type: 'date', optional: !needsDate, hint: it?.kind === 'guardian_permission' ? t('intl.f_expiry_required') : t('intl.f_expiry_optional') }] : []),
        ...(dec !== 'verify' ? [{ key: 'reason', label: dec === 'reject' ? t('intl.f_reject_reason') : t('intl.f_waive_reason'), type: 'multiline' }] : []),
      ]}
      onSubmit={async (v) => { try { await api.post(`/academy/international/items/${it.id}/decision`, { decision: dec, expires_on: v.expires_on || undefined, reason: v.reason || undefined }); onDone(); return t('intl.saved'); } catch (e) { throw new Error(explain(e)); } }} />
  );
}

function DocSheet({ kase, kind, onClose, onDone }) {
  const cur = kase.documents.find((x) => x.kind === kind);
  const statuses = kind === 'passport' ? ['held', 'not_held', 'unknown'] : ['not_required', 'required', 'submitted', 'approved', 'unknown'];
  return (
    <FormSheet visible={!!kind} onClose={onClose} title={kind ? t(`intl.doc_${kind}`) : ''} submitLabel={t('common.save')}
      initial={{ status: cur?.status ?? statuses[0], expires_on: cur?.expires_on ?? undefined }}
      fields={[{ key: 'status', label: t('intl.f_doc_status'), type: 'chips', options: statuses.map((s) => ({ value: s, label: t(`intl.ds_${s}`) })) }, { key: 'expires_on', label: t('intl.f_doc_expiry'), type: 'date', optional: true, hint: t('intl.f_doc_expiry_hint') }]}
      onSubmit={async (v) => { try { await api.post(`/academy/international/${kase.id}/documents/${kind}`, { status: v.status, expires_on: v.expires_on || null }); onDone(); return t('intl.saved'); } catch (e) { throw new Error(explain(e)); } }} />
  );
}

// ------------------------------------------------------------------------------------------------------------------ start from an application's review
/** Shown inside an application's review: the readiness at a glance, or the way to open an international checklist. */
export function IntlPanel({ app, o, archived, toast, onOpen }) {
  const d = useLoad(() => api.get(`/academy/applications/${app.id}/international`).catch((e) => (e?.status === 404 ? null : Promise.reject(e))), [app.id]);
  const [start, setStart] = useState(false);
  const resid = useLoad(() => api.get(`/organisations/${o.id}/academy/residences`).catch(() => []), [o.id]);
  const members = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  if (d.error) return null;
  if (d.data === undefined) return null;
  const people = (Array.isArray(members.data) ? members.data : members.data?.members ?? []).filter((m) => m.status === 'active' && ['owner', 'admin'].includes(m.role)).map((m) => ({ value: m.user_id ?? m.id, label: m.display_name ?? m.handle }));
  const k = d.data;
  return (
    <Block title={t('intl.panel_title')} right={k ? <Tag label={k.readiness.ready ? t('intl.ready') : t('intl.not_ready')} color={k.readiness.ready ? c.mint : c.orange} /> : null}>
      {k ? (
        <>
          <Bar met={k.readiness.mandatory_met} total={k.readiness.mandatory_total} />
          <T size={13} color={c.mute}>{dot(countryName(k.origin_country), k.arrival_on ? `${t('intl.arrives')} ${when(k.arrival_on)}` : t('intl.no_arrival'), k.readiness.blocking.length ? t('intl.blocking_n', { n: k.readiness.blocking.length }) : null)}</T>
          <Btn small title={t('intl.open_checklist')} onPress={() => onOpen?.(app.id)} style={{ alignSelf: 'flex-start' }} />
        </>
      ) : (
        <>
          <T size={13} color={c.mute}>{t('intl.panel_sub')}</T>
          {!archived ? <Btn small title={t('intl.start')} onPress={() => setStart(true)} style={{ alignSelf: 'flex-start' }} /> : null}
        </>
      )}
      <FormSheet visible={start} onClose={() => setStart(false)} title={t('intl.start')} submitLabel={t('intl.start')} initial={{}}
        fields={[
          { key: 'origin_country', label: t('intl.f_origin'), type: 'country', hint: t('intl.f_origin_hint') },
          { key: 'arrival_on', label: t('intl.f_arrival'), type: 'date', optional: true, hint: t('intl.f_arrival_hint') },
          { key: 'reviewer_id', label: t('intl.reviewer'), type: 'chips', optional: true, options: people },
          { key: 'residence_id', label: t('intl.residence'), type: 'custom', render: ({ v, set }) => <MenuField label={t('intl.residence')} value={v.residence_id ?? ''} onChange={(x) => set('residence_id', x)} options={[{ value: '', label: t('intl.not_linked') }, ...(resid.data ?? []).filter((x) => x.status === 'active').map((x) => ({ value: x.id, label: x.name }))]} /> },
        ]}
        onSubmit={async (v) => { try { await api.post(`/academy/applications/${app.id}/international`, { origin_country: v.origin_country, arrival_on: v.arrival_on || undefined, reviewer_id: v.reviewer_id || undefined, residence_id: v.residence_id || undefined }); d.reload(); toast(t('intl.started')); return t('intl.started'); } catch (e) { throw new Error(explain(e)); } }} />
    </Block>
  );
}

// ------------------------------------------------------------------------------------------------------------------ the family's own checklist
/** The athlete's (or verified guardian's) view: what is needed by when, the passport/visa vault with its reveal, approved conditions and the arrival plan. */
export function FamilyChecklist({ applicationId, toast }) {
  const d = useLoad(() => api.get(`/academy/applications/${applicationId}/international`).catch((e) => (e?.status === 404 || e?.status === 403 ? null : Promise.reject(e))), [applicationId]);
  const [doc, setDoc] = useState(null);
  const [shown, setShown] = useState(null);
  if (d.error || !d.data) return null;
  const k = d.data, r = k.readiness;
  const act = async (fn, ok) => { try { await fn(); toast(ok); d.reload(); } catch (e) { toast(explain(e)); } };
  const reveal = (kind) => act(async () => { setShown({ kind, ...(await api.get(`/academy/international/${k.id}/documents/${kind}/reveal`)) }); }, t('intl.revealed'));
  return (
    <Block title={t('intl.family_title')} right={<Tag label={r.ready ? t('intl.ready') : t('intl.not_ready')} color={r.ready ? c.mint : c.orange} />}>
      <T size={13} color={c.mute}>{k.arrival_on ? t('intl.family_sub', { date: when(k.arrival_on) }) : t('intl.family_sub_nodate')}</T>
      <Bar met={r.mandatory_met} total={r.mandatory_total} />
      {k.items.map((i) => {
        const [label, tone] = itemTone(i);
        return (
          <Card key={i.id} pad={12}>
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{i.label}</T><Tag label={label} color={tone} /></View>
              <T size={12} color={c.mute}>{dot(i.mandatory ? t('intl.mandatory') : t('intl.optional'), i.due_on ? `${t('intl.due')} ${when(i.due_on)}` : null)}</T>
              {['open', 'rejected'].includes(i.status) ? <Btn small title={t('intl.mark_ready')} onPress={() => act(() => api.post(`/academy/international/items/${i.id}/submit`, {}), t('intl.submitted'))} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          </Card>
        );
      })}
      <T weight="800" size={13}>{t('intl.documents')}</T>
      {k.documents.map((x) => (
        <Row key={x.kind} left={<T size={22}>{x.kind === 'passport' ? '🛂' : '🪪'}</T>} title={t(`intl.doc_${x.kind}`)} sub={x.status ? dot(t(`intl.ds_${x.status}`), x.expires_on ? `${t('intl.expires')} ${when(x.expires_on)}` : null) : t('intl.doc_none')}
          right={<View style={{ flexDirection: 'row', gap: 6 }}><Btn small title={t('intl.update')} color={c.paper} ink={c.ink} onPress={() => setDoc(x.kind)} />{x.status ? <Btn small title={t('intl.reveal')} color={c.paper} ink={c.ink} onPress={() => reveal(x.kind)} /> : null}</View>} />
      ))}
      <T size={12} color={c.mute}>{t('intl.family_vault_note')}</T>
      {k.conditions.length ? <><T weight="800" size={13}>{t('intl.conditions')}</T>{k.conditions.map((x) => <Row key={x.id} title={x.text} right={<Tag label={condTone(x.status)[0]} color={condTone(x.status)[1]} />} />)}</> : null}
      {k.tasks.length ? <><T weight="800" size={13}>{t('intl.arrival_board')}</T>{k.tasks.map((x) => <Row key={x.id} left={<T size={20}>{x.status === 'done' ? '✅' : '⬜'}</T>} title={x.title} sub={x.due_on ? `${t('intl.due')} ${when(x.due_on)}` : undefined} />)}</> : null}
      <FormSheet visible={!!doc} onClose={() => setDoc(null)} title={doc ? t(`intl.doc_${doc}`) : ''} submitLabel={t('common.save')}
        initial={{ status: k.documents.find((x) => x.kind === doc)?.status ?? (doc === 'passport' ? 'held' : 'required'), expires_on: k.documents.find((x) => x.kind === doc)?.expires_on ?? undefined }}
        fields={[{ key: 'status', label: t('intl.f_doc_status'), type: 'chips', options: (doc === 'passport' ? ['held', 'not_held', 'unknown'] : ['not_required', 'required', 'submitted', 'approved', 'unknown']).map((s) => ({ value: s, label: t(`intl.ds_${s}`) })) },
          { key: 'expires_on', label: t('intl.f_doc_expiry'), type: 'date', optional: true }, { key: 'number', label: t('intl.f_doc_number'), optional: true, hint: t('intl.f_doc_number_hint') }, { key: 'evidence_ref', label: t('intl.f_doc_ref'), optional: true }]}
        onSubmit={async (v) => { try { await api.post(`/academy/international/${k.id}/documents/${doc}`, { status: v.status, expires_on: v.expires_on || null, ...(v.number ? { number: v.number } : {}), ...(v.evidence_ref ? { evidence_ref: v.evidence_ref } : {}) }); d.reload(); return t('intl.saved'); } catch (e) { throw new Error(explain(e)); } }} />
      <Sheet visible={!!shown} onClose={() => setShown(null)} title={shown ? t(`intl.doc_${shown.kind}`) : ''}>
        {shown ? (
          <View style={{ gap: 8 }}>
            <Row title={t('intl.f_doc_number')} sub={shown.number ?? t('intl.doc_none')} />
            <Row title={t('intl.f_doc_ref')} sub={shown.evidence_ref ?? t('intl.doc_none')} />
            <T size={12} color={c.mute}>{t('intl.reveal_note')}</T>
            <Btn title={t('intl.hide')} onPress={() => setShown(null)} />
          </View>
        ) : null}
      </Sheet>
    </Block>
  );
}
