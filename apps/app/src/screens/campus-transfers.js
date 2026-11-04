// Campus transfer workflow screens (#781): the tracker (awaiting me / in progress / completed), one transfer's stage-by-stage progress with the
// actions each role can take, the three-step request wizard that previews the process before it starts, the process designer an academy uses to
// configure its own steps, and the card an athlete or guardian sees to acknowledge a transfer. Only calls the capabilities in
// org-campus-transfers.js; the server decides who may do what and this screen only hides what a role cannot use.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../menu-field';
import { DateField } from '../pickers';
import { Block, when } from './academy-ui';
import { t } from '../i18n';

const TYPES = ['enrolment', 'staff', 'cohort', 'programme', 'team', 'venue', 'supplier', 'organisation'];
const TYPE_ICON = { enrolment: '🧑‍🎓', staff: '🧑‍🏫', cohort: '👥', programme: '🏅', team: '🛡️', venue: '🏟️', supplier: '🧰', organisation: '🏛️' };
const REASONS = ['relocation', 'pathway_progression', 'reorganisation', 'capacity', 'performance', 'family_request', 'data_correction', 'other'];
const KIND_ICON = { approval: '✅', checklist: '☑️', acknowledge: '✍️' };
const STATUS_TONE = { approved: c.limeSoft, done: c.limeSoft, rejected: c.redSoft, declined: c.redSoft, pending: c.sunSoft, skipped: c.violetSoft };
const TR_TONE = { completed: c.limeSoft, rejected: c.redSoft, failed: c.redSoft, cancelled: c.violetSoft, scheduled: c.cyanSoft, in_progress: c.sunSoft };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null));
const Panel = ({ children, style }) => <View style={[{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }, style]}>{children}</View>;
const names = (l) => (l?.length ? l.join(', ') : t('campus.tr.nobody'));
/** Join the parts that exist with a space (icons, names and numbers). */
const cat = (...parts) => parts.filter((x) => x !== undefined && x !== null && x !== '').join(' ');
const typeLabel = (k) => t(`campus.type.${k}`);

// ------------------------------------------------------------------------------------------------------------------------ the tracker
export function TransfersHub({ o, staff, toast, setSheet, openTransfer, refresh, changes }) {
  const [view, setView] = useState('active');
  const list = useLoad(() => (view === 'log' ? Promise.resolve(null) : api.get(`/organisations/${o.id}/transfers`, { view, limit: 60 })), [o.id, view]);
  const me = useLoad(() => api.get(`/organisations/${o.id}/transfers`, { view: 'awaiting_me', limit: 60 }).catch(() => []), [o.id]);
  const rollback = async (m) => { try { await api.post(`/organisations/${o.id}/unit-changes/${m.id}/rollback`, {}); toast?.(t('campus.rolled')); refresh(); changes.reload(); } catch (e) { toast?.(e.message); } };
  const waiting = me.data?.length ?? 0;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Btn title={t('campus.tr.new')} onPress={() => setSheet({ type: 'transfer' })} />
        <Btn title={t('campus.tr.process')} color={c.paper} ink={c.ink} onPress={() => setSheet({ type: 'designer' })} />
      </View>
      <Seg value={view} onChange={setView} options={[{ value: 'awaiting_me', label: `${t('campus.tr.view.awaiting_me')}${waiting ? ` (${waiting})` : ''}` }, { value: 'active', label: t('campus.tr.view.active') }, { value: 'closed', label: t('campus.tr.view.closed') }, ...(staff ? [{ value: 'log', label: t('campus.tr.view.log') }] : [])]} />
      {view === 'log' ? (
        <Panel><Block title={t('campus.tr.view.log')}>
          {(changes.data ?? []).map((m) => (
            <View key={m.id} style={{ padding: 12, borderRadius: 14, backgroundColor: c.bg, gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><Tag label={t(`campus.moves.kind.${m.kind}`)} color={m.rolled_back_at ? c.violetSoft : c.pinkSoft} /><T weight="800" style={{ flex: 1 }}>{m.summary?.moved ? t('campus.moves.n', { n: m.summary.moved, name: m.summary.to_name }) : m.summary?.campus?.name ?? ''}</T></View>
              <T size={12} color={c.mute}>{t('campus.moves.by', { name: m.by_name })} · {t('campus.moves.effective', { date: when(m.effective_on) })}</T>
              {m.rolled_back_at ? <T size={12} color={c.mute}>{t('campus.moves.rolled', { date: when(m.rolled_back_at) })}</T> : staff ? <Btn small title={t('campus.moves.rollback')} color={c.paper} ink={c.ink} onPress={() => rollback(m)} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          ))}
          {changes.data && !changes.data.length ? <Empty emoji="🔁" title={t('campus.moves.empty')} sub={t('campus.moves.empty_sub')} /> : null}
        </Block></Panel>
      ) : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((x) => <TransferRow key={x.id} x={x} onPress={() => openTransfer(x.id)} />)
        : <Empty emoji={view === 'awaiting_me' ? '🎉' : '🔁'} title={view === 'awaiting_me' ? t('campus.tr.empty_me') : t('campus.tr.empty')} sub={view === 'awaiting_me' ? t('campus.tr.empty_me_sub') : t('campus.tr.empty_sub')} />}
    </View>
  );
}

/** One segment per required step: written out beside it, never colour alone. */
const Steps = ({ done, total }) => <View accessible accessibilityLabel={t('campus.tr.progress', { done, total })} style={{ flexDirection: 'row', gap: 4 }}>{Array.from({ length: total }, (_, n) => <View key={n} style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: n < done ? c.lime : c.violetSoft }} />)}</View>;

function TransferRow({ x, onPress }) {
  const who = x.labels.filter(Boolean).join(', ');
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${typeLabel(x.object_type)}: ${who}. ${x.from.name} to ${x.to.name}. ${t(`campus.tr.status.${x.status}`)}`}
      style={{ padding: 14, borderRadius: 18, backgroundColor: c.paper, borderWidth: 1, borderColor: x.mine_to_act ? c.pink : c.line, gap: 8, minHeight: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={24}>{TYPE_ICON[x.object_type]}</T>
        <View style={{ flex: 1 }}>
          <T weight="800">{who}{x.count > 3 ? ` ${t('campus.tr.plus', { n: x.count - 3 })}` : ''}</T>
          <T size={13} color={c.mute}>{typeLabel(x.object_type)} · {t('campus.tr.from_to', { from: x.from.name, to: x.to.name })} · {t('campus.tr.effective', { date: when(x.effective_on) })}</T>
        </View>
        <Tag label={t(`campus.tr.status.${x.status}`)} color={TR_TONE[x.status]} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Tag label={t(`campus.reason.${x.reason_code}`)} color={c.paper} />
        {x.overdue ? <Tag label={t('campus.tr.overdue')} color={c.orangeSoft} /> : null}
        {x.mine_to_act ? <Tag label={t('campus.tr.view.awaiting_me')} color={c.pinkSoft} /> : null}
        {x.status === 'in_progress' ? <T size={12} color={c.mute} style={{ flex: 1 }}>{t('campus.tr.progress', { done: x.progress.done, total: x.progress.total })}{x.awaiting.length ? ` · ${t('campus.tr.awaiting', { names: x.awaiting.join(', ') })}` : ''}</T> : null}
      </View>
      {x.status === 'in_progress' && x.progress.total ? <Steps done={x.progress.done} total={x.progress.total} /> : null}
      {x.failure ? <T size={12} color={c.red}>{t('campus.tr.failed', { why: x.failure })}</T> : null}
    </Pressable>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ one transfer
export function TransferDetail({ o, id, toast, onChanged }) {
  const q = useLoad(() => api.get(`/organisations/${o.id}/transfers/${id}`), [o.id, id]);
  const [asking, setAsking] = useState(null);   // { step, decision } waiting for a reason
  const [ticked, setTicked] = useState({});
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const x = q.data, stages = [...new Set(x.steps.map((s) => s.stage))];
  const act = async (step, body) => { try { const r = await api.post(`/organisations/${o.id}/transfers/${x.id}/steps/${step.id}`, body); toast?.(t('campus.tr.decision_saved')); setAsking(null); q.reload(); onChanged?.(r); } catch (e) { toast?.(e.message); } };
  const cancel = async () => { try { await api.post(`/organisations/${o.id}/transfers/${x.id}/cancel`, {}); toast?.(t('campus.tr.cancelled')); q.reload(); onChanged?.(); } catch (e) { toast?.(e.message); } };
  const doneItems = (s) => (ticked[s.id] ?? s.items.map((it, n) => (it.done ? n : null)).filter((n) => n !== null));
  const toggle = (s, n) => { const cur = doneItems(s); setTicked({ ...ticked, [s.id]: cur.includes(n) ? cur.filter((k) => k !== n) : [...cur, n] }); };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Tag label={cat(TYPE_ICON[x.object_type], typeLabel(x.object_type))} /><Tag label={t(`campus.tr.status.${x.status}`)} color={TR_TONE[x.status]} /><Tag label={t(`campus.reason.${x.reason_code}`)} color={c.paper} />
      </View>
      <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.violetSoft, gap: 4 }}>
        <T weight="800" size={16}>{t('campus.tr.from_to', { from: x.from.name, to: x.to.name })}</T>
        <T size={13}>{t('campus.tr.effective', { date: when(x.effective_on) })} · {t('campus.tr.by', { name: x.requested_by_name })}</T>
        <T size={12} color={c.mute}>{t('campus.tr.moving')}: {x.objects.map((m) => m.label).join(', ')}</T>
        {x.note ? <T size={13}>{x.note}</T> : null}
        {x.failure ? <T size={13} color={c.red}>{t('campus.tr.failed', { why: x.failure })}</T> : null}
      </View>
      {stages.map((st) => (
        <View key={st} style={{ gap: 8 }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{`${t('campus.tr.stage', { n: st })} · ${t('campus.tr.parallel')}`.toUpperCase()}</T>
          {x.steps.filter((s) => s.stage === st).map((s) => (
            <View key={s.id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 6, borderWidth: s.can_act ? 1.5 : 0, borderColor: c.pink, opacity: s.status === 'skipped' ? 0.6 : 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T size={18}>{KIND_ICON[s.kind]}</T>
                <View style={{ flex: 1 }}><T weight="800">{s.label}</T><T size={12} color={c.mute}>{t(`campus.kindstep.${s.kind}`)} · {t(`campus.steprole.${s.role}`)}{s.due_on ? ` · ${t('campus.tr.due', { date: when(s.due_on) })}` : ''}</T></View>
                <Tag label={s.status === 'pending' ? (s.open ? t('campus.tr.open') : t('campus.tr.stepstatus.pending')) : t(`campus.tr.stepstatus.${s.status}`)} color={STATUS_TONE[s.status]} />
              </View>
              {s.overdue ? <Tag label={t('campus.tr.overdue')} color={c.orangeSoft} style={{ alignSelf: 'flex-start' }} /> : null}
              {s.status === 'pending' && !s.open ? <T size={12} color={c.mute}>{t('campus.tr.waiting_stage')}</T> : null}
              {s.status === 'pending' ? <T size={12} color={c.mute}>{t('campus.tr.who', { names: names(s.approvers) })}</T> : null}
              {s.decided_by_name ? <T size={12} color={c.mute}>{t('campus.tr.decided', { name: s.decided_by_name, date: when(s.decided_at) })}{s.override ? ` · ${t('campus.tr.override')}` : ''}</T> : null}
              {s.note ? <T size={12}>“{s.note}”</T> : null}
              {s.kind === 'checklist' && s.status !== 'skipped' ? (
                <View style={{ gap: 4 }}>
                  {s.items.map((it, n) => {
                    const on = s.can_act ? doneItems(s).includes(n) : it.done;
                    return <Pressable key={n} disabled={!s.can_act} onPress={() => toggle(s, n)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={it.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
                      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: c.pink, backgroundColor: on ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{on ? <T size={12} weight="800" color={c.onAccent}>✓</T> : null}</View>
                      <T style={{ flex: 1 }}>{it.label}</T>
                    </Pressable>;
                  })}
                </View>
              ) : null}
              {s.can_act ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {s.kind === 'approval' ? <><Btn small title={t('campus.tr.approve')} onPress={() => (s.authority === 'override' ? setAsking({ step: s, decision: 'approve' }) : act(s, { decision: 'approve' }))} /><Btn small title={t('campus.tr.reject')} color={c.paper} ink={c.red} onPress={() => setAsking({ step: s, decision: 'reject' })} /></> : null}
                  {s.kind === 'checklist' ? <><Btn small title={t('campus.tr.save')} color={c.paper} ink={c.ink} onPress={() => act(s, { decision: 'save', items_done: doneItems(s) })} /><Btn small title={t('campus.tr.complete')} disabled={doneItems(s).length < s.items.length} onPress={() => (s.authority === 'override' ? setAsking({ step: s, decision: 'complete' }) : act(s, { decision: 'complete', items_done: doneItems(s) }))} /></> : null}
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ))}
      {x.can_cancel ? <Btn small title={t('campus.tr.cancel')} color={c.paper} ink={c.red} onPress={cancel} style={{ alignSelf: 'flex-start' }} /> : null}
      <Block title={t('campus.tr.timeline')}>
        {x.timeline.map((e) => <View key={e.id} style={{ paddingVertical: 4 }}><T size={13}><T weight="800" size={13}>{e.actor_name ?? '–'}</T> {t(`campus.ev.${e.action}`, { step: e.detail?.step ?? '' })}</T><T size={11} color={c.mute}>{new Date(e.at).toLocaleString()}{e.detail?.override ? ` · ${t('campus.tr.override')}` : ''}</T></View>)}
      </Block>
      {asking ? <ReasonSheet asking={asking} onClose={() => setAsking(null)} onSubmit={(note) => act(asking.step, { decision: asking.decision, ...(asking.decision === 'complete' ? { items_done: doneItems(asking.step) } : {}), note })} /> : null}
    </View>
  );
}
function ReasonSheet({ asking, onClose, onSubmit }) {
  const [note, setNote] = useState('');
  return (
    <Sheet visible onClose={onClose} title={asking.step.label} footer={<Btn title={asking.decision === 'reject' ? t('campus.tr.reject') : t('campus.tr.approve')} disabled={note.trim().length < 5} onPress={() => onSubmit(note.trim())} />}>
      {asking.step.authority === 'override' && asking.decision !== 'reject' ? <T size={13} color={c.mute}>{t('campus.tr.override_needed')}</T> : null}
      <Field label={t('campus.tr.reason_needed')} value={note} onChangeText={setNote} multiline />
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ the request wizard
export function TransferWizard({ o, d, spec, toast, onClose, onDone }) {
  const sources = useMemo(() => d.units.filter((u) => !u.context_only && u.kind !== 'region' && u.status !== 'archived' && (d.scope.all || u.my_roles.some((r) => ['director', 'sports_lead', 'operations'].includes(r)))), [d]);
  const [step, setStep] = useState(1);
  const [v, setV] = useState({ type: spec.object_type ?? 'enrolment', from: spec.from ?? [...sources].filter((u) => u.kind === 'campus').sort((a, b) => (b.metrics?.athletes ?? 0) - (a.metrics?.athletes ?? 0))[0]?.id ?? sources[0]?.id ?? '', ids: spec.ids ?? [], to: '', on: undefined, reason: 'relocation', note: '' });
  const [pre, setPre] = useState(null);
  const [busy, setBusy] = useState(false);
  const flows = useLoad(() => api.get(`/organisations/${o.id}/transfer-flows`), [o.id]);
  const dests = useLoad(() => (v.from ? api.get(`/organisations/${o.id}/transfer-destinations`, { from_unit_id: v.from }) : Promise.resolve([])), [o.id, v.from]);
  const flow = flows.data?.flows.find((f) => f.object_type === v.type);
  const earliest = addDays(today(), flow?.min_notice_days ?? 0);
  const set = (k, x) => { setV({ ...v, [k]: x }); setPre(null); };
  const load = useMemo(() => async (q) => (await api.get(`/organisations/${o.id}/campus-candidates`, clean({ object_type: v.type, q, unit_id: v.from, limit: 40 }))).items.map((i) => ({ value: i.id, label: i.label, sub: i.sub })), [o.id, v.type, v.from]);
  const body = () => ({ object_type: v.type, object_ids: v.ids, to_unit_id: v.to, reason_code: v.reason, ...clean({ effective_on: v.on, note: v.note }) });
  const review = async () => { setBusy(true); try { setPre(await api.post(`/organisations/${o.id}/transfers`, { ...body(), dry_run: true })); setStep(3); } catch (e) { toast?.(e.message); } finally { setBusy(false); } };
  const start = async () => { setBusy(true); try { await api.post(`/organisations/${o.id}/transfers`, { ...body(), idempotency_key: `tr-${o.id}-${Date.now()}` }); toast?.(t('campus.wiz.started')); onDone(); } catch (e) { toast?.(e.message); } finally { setBusy(false); } };
  const can1 = v.from && v.ids.length, can2 = v.to && (!v.on || v.on >= earliest || (flow?.allow_backdate && d.scope.all));
  const footer = (
    <View style={{ flexDirection: 'row', gap: 8, flex: 1 }}>
      {step > 1 ? <Btn title={t('campus.wiz.back')} color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} /> : null}
      <View style={{ flex: 1 }} />
      {step === 1 ? <Btn title={t('campus.wiz.next')} disabled={!can1} onPress={() => setStep(2)} /> : step === 2 ? <Btn title={t('campus.wiz.next')} disabled={!can2} loading={busy} onPress={review} /> : <Btn title={t('campus.wiz.start')} loading={busy} onPress={start} />}
    </View>
  );
  return (
    <Sheet visible onClose={onClose} title={t('campus.tr.new')} footer={footer}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {[1, 2, 3].map((n) => <View key={n} style={{ flex: 1, gap: 4 }}><View style={{ height: 6, borderRadius: 3, backgroundColor: n <= step ? c.pink : c.line }} /><T size={11} weight={n === step ? '800' : '600'} color={n === step ? c.ink : c.mute}>{n}. {t(`campus.wiz.step${n}`)}</T></View>)}
      </View>
      {step === 1 ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{TYPES.filter((k) => d.scope.all || k !== 'organisation').map((k) => <Chip key={k} label={cat(TYPE_ICON[k], typeLabel(k))} active={v.type === k} onPress={() => setV({ ...v, type: k, ids: [] }) || setPre(null)} />)}</View>
          <MenuField label={t('campus.wiz.source')} value={v.from} onChange={(x) => setV({ ...v, from: x, ids: [], to: '' })} options={sources.map((u) => ({ value: u.id, label: u.name, sub: t(`campus.kind.${u.kind}`) }))} />
          <MultiMenuField label={t('campus.wiz.pick')} value={v.ids} onChange={(x) => set('ids', x)} load={load} placeholder={typeLabel(v.type)} max={50} />
          {flow ? <View style={{ padding: 10, borderRadius: 12, backgroundColor: c.violetSoft }}><T size={12} weight="800">{flow.configured ? flow.name : t('campus.wiz.default')}</T>{flow.configured ? <T size={12} color={c.mute}>{flow.steps.map((s) => s.label).join(' → ') || t('campus.des.empty')}</T> : null}</View> : null}
        </>
      ) : step === 2 ? (
        <>
          <MenuField label={t('campus.wiz.dest')} value={v.to} onChange={(x) => set('to', x)} options={(dests.data ?? []).map((u) => ({ value: u.id, label: u.name, sub: u.path }))} />
          <DateField label={t('campus.wiz.date')} value={v.on ?? earliest} onChange={(x) => set('on', x)} min={flow?.allow_backdate && d.scope.all ? undefined : earliest} hint={flow?.min_notice_days ? t('campus.wiz.notice', { n: flow.min_notice_days, date: when(earliest) }) : undefined} />
          <View style={{ gap: 6 }}><T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('campus.wiz.reason').toUpperCase()}</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{REASONS.map((r) => <Chip key={r} label={t(`campus.reason.${r}`)} active={v.reason === r} onPress={() => set('reason', r)} />)}</View></View>
          <Field label={t('campus.wiz.note')} value={v.note} onChangeText={(x) => set('note', x)} multiline />
        </>
      ) : pre ? <Review pre={pre} /> : <Loading />}
    </Sheet>
  );
}
function Review({ pre }) {
  const stages = [...new Set(pre.process.steps.map((s) => s.stage))];
  return (
    <View style={{ gap: 10 }}>
      <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.violetSoft, gap: 2 }}>
        <T weight="800" size={16}>{t('campus.tr.from_to', { from: pre.from.name, to: pre.to.name })}</T>
        <T size={13}>{pre.objects.map((o) => o.label).join(', ')}</T>
        <T size={12} color={c.mute}>{t('campus.tr.effective', { date: when(pre.effective_on) })} · {t(`campus.reason.${pre.reason_code}`)}</T>
      </View>
      {pre.warnings.length ? <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.orangeSoft, gap: 4 }}><T weight="800">{t('campus.wiz.warn')}</T>{pre.warnings.map((w) => <T key={w} size={13}>{w}</T>)}</View> : null}
      <T weight="800">{t('campus.wiz.review_head')}</T>
      {!pre.process.configured ? <T size={12} color={c.mute}>{t('campus.wiz.default')}</T> : null}
      {stages.map((st) => (
        <View key={st} style={{ gap: 6 }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{t('campus.tr.stage', { n: st }).toUpperCase()}</T>
          {pre.process.steps.filter((s) => s.stage === st).map((s) => (
            <View key={s.seq} style={{ padding: 10, borderRadius: 12, backgroundColor: c.bg, gap: 2, opacity: s.skipped ? 0.55 : 1 }}>
              <T weight="700">{KIND_ICON[s.kind]} {s.label}</T>
              <T size={12} color={c.mute}>{t(`campus.steprole.${s.role}`)}{s.due_on ? ` · ${t('campus.tr.due', { date: when(s.due_on) })}` : ''}{s.skipped ? ` · ${t('campus.wiz.skipped')}` : ''}</T>
              {!s.skipped ? <T size={12} color={s.approvers.length ? c.ink : c.orange}>{t('campus.tr.who', { names: names(s.approvers) })}</T> : null}
              {s.items.length ? <T size={12} color={c.mute}>{t('campus.wiz.checklist', { items: s.items.join(' · ') })}</T> : null}
            </View>
          ))}
        </View>
      ))}
      <T weight="800" size={13}>{t('campus.wiz.stays')}</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[['athletes', pre.stays_attached.athletes], ['sessions', pre.stays_attached.upcoming_sessions], ['charges', pre.stays_attached.open_charges], ['engagements', pre.stays_attached.engagements]].filter(([, n]) => n).map(([k, n]) => <Tag key={k} label={`${n} ${t(`campus.move.${k}`)}`} color={c.paper} />)}</View>
      <T size={12} color={c.mute}>{pre.preserved}</T>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ the process designer
const slug = (label, taken) => { const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'step'); let k = base, n = 2; while (taken.includes(k)) k = `${base.slice(0, 20)}_${n++}`; return k; };
const toApi = (s) => ({ key: s.key, label: s.label, kind: s.kind, role: s.role, stage: s.stage, required: s.required !== false, ...(s.sla_days ? { sla_days: s.sla_days } : {}), only_youth: !!s.only_youth, items: s.items ?? [] });

export function ProcessDesigner({ o, d, toast, onClose }) {
  const flows = useLoad(() => api.get(`/organisations/${o.id}/transfer-flows`), [o.id]);
  const [type, setType] = useState('enrolment');
  const [draft, setDraft] = useState(null);   // { name, steps, min_notice_days, allow_backdate } while editing
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!flows.data) return <Sheet visible onClose={onClose} title={t('campus.des.title')}><Loading /></Sheet>;
  const f = flows.data.flows.find((x) => x.object_type === type), can = flows.data.can_configure;
  const cur = draft ?? { name: f.configured ? f.name : `${typeLabel(type)} transfer`, steps: f.steps, min_notice_days: f.min_notice_days, allow_backdate: f.allow_backdate };
  const edit = (patch) => setDraft({ ...cur, ...patch });
  const stages = Math.max(1, ...cur.steps.map((s) => s.stage));
  const save = async () => { setBusy(true); try { const r = await api.post(`/organisations/${o.id}/transfer-flows`, { object_type: type, name: cur.name, steps: cur.steps.map(toApi), min_notice_days: cur.min_notice_days, allow_backdate: cur.allow_backdate }); toast?.(t('campus.des.saved', { n: r.version })); setDraft(null); flows.reload(); } catch (e) { toast?.(e.message); } finally { setBusy(false); } };
  const upsert = (s, stage) => { const keys = cur.steps.filter((x) => x.key !== s.key).map((x) => x.key); const next = { ...s, stage, key: s.key ?? slug(s.label, keys) }; edit({ steps: s.key && cur.steps.some((x) => x.key === s.key) ? cur.steps.map((x) => (x.key === s.key ? next : x)) : [...cur.steps, next] }); };
  const remove = (s) => { const left = cur.steps.filter((x) => x.key !== s.key); const used = [...new Set(left.map((x) => x.stage))].sort((a, b) => a - b); edit({ steps: left.map((x) => ({ ...x, stage: used.indexOf(x.stage) + 1 })) }); };
  const roleOpts = (kind) => (kind === 'acknowledge' ? ['person'] : ['source_director', 'destination_director', 'sports_lead', 'finance', 'admin']).map((r) => ({ value: r, label: t(`campus.steprole.${r}`) }));
  const fields = [
    { key: 'label', label: t('campus.des.label'), type: 'text' },
    { key: 'kind', label: t('campus.des.kind_label'), type: 'chips', options: ['approval', 'checklist', ...(['enrolment', 'staff'].includes(type) ? ['acknowledge'] : [])].map((k) => ({ value: k, label: t(`campus.kindstep.${k}`) })) },
    { key: 'role', label: t('campus.des.role_label'), type: 'chips', options: (vals) => roleOpts(vals.kind) },
    { key: 'stage', label: t('campus.des.stage'), type: 'stepper', min: 1, max: stages + 1, default: 1, hint: t('campus.des.stage_help') },
    { key: 'required', label: t('campus.des.required'), type: 'switch', default: true },
    { key: 'sla_days', label: t('campus.des.sla'), type: 'stepper', min: 0, max: 60, default: 3 },
    { key: 'only_youth', label: t('campus.des.only_youth'), type: 'switch', default: false, show: (vals) => vals.kind === 'acknowledge' },
    { key: 'items', label: t('campus.des.items'), type: 'custom', default: [], show: (vals) => vals.kind === 'checklist', render: ({ v, set }) => <Items label={t('campus.des.items')} value={v.items ?? []} onChange={(x) => set('items', x)} /> },
  ];
  return (
    <Sheet visible onClose={onClose} title={t('campus.des.title')} footer={can ? <Btn title={t('campus.des.save')} loading={busy} disabled={!draft} onPress={save} /> : null}>
      <T size={13} color={c.mute}>{t('campus.des.sub')}</T>
      <MenuField label={t('campus.des.kind')} value={type} onChange={(x) => { setType(x); setDraft(null); }} options={TYPES.map((k) => ({ value: k, label: `${TYPE_ICON[k]} ${typeLabel(k)}` }))} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}><Tag label={f.configured ? t('campus.des.version', { n: f.version }) : t('campus.des.default')} color={f.configured ? c.limeSoft : c.sunSoft} />{!can ? <T size={12} color={c.mute}>{t('campus.des.read_only')}</T> : null}</View>
      {can && TEMPLATE_BTN(flows.data.templates[type], (steps) => edit({ steps }))}
      <Field label={t('campus.des.name')} value={cur.name} onChangeText={(x) => edit({ name: x })} />
      {!cur.steps.length ? <Empty emoji="🧩" title={t('campus.des.empty')} /> : null}
      {Array.from({ length: stages }, (_, n) => n + 1).map((st) => (
        <View key={st} style={{ gap: 6, padding: 10, borderRadius: 16, borderWidth: 1, borderColor: c.line, borderStyle: 'dashed' }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{`${t('campus.tr.stage', { n: st })} · ${t('campus.tr.parallel')}`.toUpperCase()}</T>
          {cur.steps.filter((s) => s.stage === st).map((s) => (
            <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 12, backgroundColor: c.bg }}>
              <T size={18}>{KIND_ICON[s.kind]}</T>
              <View style={{ flex: 1 }}><T weight="700">{s.label}</T><T size={12} color={c.mute}>{t(`campus.kindstep.${s.kind}`)} · {t(`campus.steprole.${s.role}`)}{s.sla_days ? ` · ${t('campus.pol.days', { n: s.sla_days })}` : ''}{s.required === false ? ' · optional' : ''}</T>{s.items?.length ? <T size={12} color={c.mute}>{s.items.join(' · ')}</T> : null}</View>
              {can ? <><Btn small title={t('campus.unit.edit')} color={c.paper} ink={c.ink} onPress={() => setEditing({ step: s })} /><Btn small title={t('campus.des.remove')} color={c.paper} ink={c.red} onPress={() => remove(s)} /></> : null}
            </View>
          ))}
          {can ? <Btn small title={t('campus.des.add_step')} color={c.paper} ink={c.ink} onPress={() => setEditing({ stage: st })} style={{ alignSelf: 'flex-start' }} /> : null}
        </View>
      ))}
      {can && cur.steps.length ? <Btn small title={t('campus.des.add_stage')} color={c.paper} ink={c.ink} onPress={() => setEditing({ stage: stages + 1 })} style={{ alignSelf: 'flex-start' }} /> : null}
      {can ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T weight="700" style={{ flex: 1 }}>{t('campus.des.notice')}</T>
            <Btn small title="−" color={c.paper} ink={c.ink} disabled={!cur.min_notice_days} onPress={() => edit({ min_notice_days: Math.max(0, cur.min_notice_days - 1) })} accessibilityLabel="−" />
            <T weight="800" style={{ minWidth: 70, textAlign: 'center' }}>{t('campus.pol.days', { n: cur.min_notice_days })}</T>
            <Btn small title="+" color={c.paper} ink={c.ink} onPress={() => edit({ min_notice_days: Math.min(120, cur.min_notice_days + 1) })} accessibilityLabel="+" />
          </View>
          <Chip label={t('campus.des.backdate')} active={cur.allow_backdate} onPress={() => edit({ allow_backdate: !cur.allow_backdate })} />
        </View>
      ) : null}
      {editing ? <FormSheet visible onClose={() => setEditing(null)} title={editing.step ? t('campus.des.edit_step') : t('campus.des.new_step')} fields={fields}
        initial={editing.step ? { ...editing.step, sla_days: editing.step.sla_days ?? 0 } : { stage: editing.stage, kind: 'approval', role: 'destination_director', required: true, sla_days: 3 }}
        onSubmit={async (val) => { if (val.kind === 'checklist' && !(val.items ?? []).length) throw new Error(t('campus.des.items')); upsert({ ...editing.step, ...val, items: val.kind === 'checklist' ? val.items : [], only_youth: val.kind === 'acknowledge' && !!val.only_youth }, val.stage); setEditing(null); }} /> : null}
    </Sheet>
  );
}
const TEMPLATE_BTN = (tpl, apply) => (tpl ? <Btn small title={t('campus.des.template')} color={c.paper} ink={c.ink} onPress={() => apply(tpl)} style={{ alignSelf: 'flex-start' }} /> : null);
function Items({ label, value, onChange }) {
  const [x, setX] = useState('');
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      {value.map((it, n) => <View key={`${it}${n}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T style={{ flex: 1 }}>• {it}</T><Btn small title={t('campus.des.remove')} color={c.paper} ink={c.red} onPress={() => onChange(value.filter((_, k) => k !== n))} /></View>)}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={x} onChangeText={setX} placeholder={t('campus.des.add_item')} /></View><Btn small title="+" disabled={x.trim().length < 3 || value.length >= 12} onPress={() => { onChange([...value, x.trim()]); setX(''); }} accessibilityLabel={t('campus.des.add_item')} /></View>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ placing what is not on a campus yet
export function PlaceSheet({ o, d, spec, toast, refresh, onClose }) {
  const [v, setV] = useState({ to: spec.to ?? '', type: spec.object_type ?? 'cohort', ids: [], on: undefined });
  const [pre, setPre] = useState(null);
  const [busy, setBusy] = useState(false);
  const targets = d.units.filter((u) => !u.context_only && u.status === 'active' && u.can_manage && (['venue', 'supplier'].includes(v.type) ? u.kind === 'campus' : true));
  const body = (x) => ({ to_unit_id: v.to, items: [{ object_type: v.type, object_ids: v.ids }], ...clean({ effective_on: v.on }), ...x });
  const set = (k, x) => { setV({ ...v, [k]: x }); setPre(null); };
  const run = async (real) => { setBusy(true); try { if (!real) setPre(await api.post(`/organisations/${o.id}/unit-moves`, body({ dry_run: true }))); else { await api.post(`/organisations/${o.id}/unit-moves`, body({ idempotency_key: `pl-${o.id}-${Date.now()}` })); toast?.(t('campus.place.done')); refresh(); onClose(); } } catch (e) { toast?.(e.message); } finally { setBusy(false); } };
  const load = useMemo(() => async (q) => (await api.get(`/organisations/${o.id}/campus-candidates`, clean({ object_type: v.type, q, unplaced_only: true, limit: 40 }))).items.map((i) => ({ value: i.id, label: i.label, sub: i.sub })), [o.id, v.type]);
  return (
    <Sheet visible onClose={onClose} title={t('campus.place.title')} footer={pre ? <Btn title={t('campus.place.go')} onPress={() => run(true)} loading={busy} disabled={!pre.moving} /> : <Btn title={t('campus.place.preview')} onPress={() => run(false)} loading={busy} disabled={!v.to || !v.ids.length} />}>
      <T size={13} color={c.mute}>{t('campus.place.help')}</T>
      <MenuField label={t('campus.move.what')} value={v.type} onChange={(x) => { setV({ ...v, type: x, ids: [], to: '' }); setPre(null); }} options={TYPES.filter((k) => d.scope.all || k !== 'organisation').map((k) => ({ value: k, label: typeLabel(k) }))} />
      <MultiMenuField label={typeLabel(v.type)} value={v.ids} onChange={(x) => set('ids', x)} load={load} placeholder={t('campus.move.pick')} />
      <MenuField label={t('campus.move.to')} value={v.to} onChange={(x) => set('to', x)} options={targets.map((u) => ({ value: u.id, label: u.name, sub: t(`campus.kind.${u.kind}`) }))} />
      <DateField label={t('campus.move.date')} value={v.on} onChange={(x) => set('on', x)} optional />
      {pre ? <View style={{ gap: 6, padding: 12, borderRadius: 14, backgroundColor: c.violetSoft }}><Tag label={t('campus.move.moving', { n: pre.moving })} color={c.pinkSoft} style={{ alignSelf: 'flex-start' }} />{pre.lines.map((l) => <T key={l.object_id} size={13}>{l.label ?? l.object_id} → {l.to_name}</T>)}<T size={12} color={c.mute}>{pre.preserved}</T></View> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ the athlete / guardian / staff member answers for themselves
export function MyTransferAcknowledgements() {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/transfer-acknowledgements').catch(() => []), []);
  const [asking, setAsking] = useState(null);
  if (!q.data?.length) return null;
  const answer = async (x, decision, note) => { try { await api.post(`/me/transfer-acknowledgements/${x.step_id}`, clean({ decision, note })); toast?.(t('campus.ack.thanks')); setAsking(null); q.reload(); } catch (e) { toast?.(e.message); } };
  return (
    <View style={{ gap: 10 }}>
      {q.data.map((x) => (
        <Panel key={x.step_id} style={{ borderColor: c.pink }}>
          <T weight="800" size={16}>{t('campus.ack.title')}</T>
          <T>{t('campus.ack.body', { person: x.person_name, from: x.from_name, to: x.to_name, date: when(x.effective_on) })}</T>
          <T size={12} color={c.mute}>{x.organisation_name}{x.answering_as === 'guardian' ? ` · ${t('campus.ack.guardian')}` : ''}{x.due_on ? ` · ${t('campus.tr.due', { date: when(x.due_on) })}` : ''}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title={t('campus.ack.yes')} onPress={() => answer(x, 'acknowledge')} /><Btn small title={t('campus.ack.no')} color={c.paper} ink={c.red} onPress={() => setAsking(x)} /></View>
        </Panel>
      ))}
      {asking ? <DeclineSheet onClose={() => setAsking(null)} onSubmit={(note) => answer(asking, 'decline', note)} /> : null}
    </View>
  );
}
function DeclineSheet({ onClose, onSubmit }) {
  const [note, setNote] = useState('');
  return <Sheet visible onClose={onClose} title={t('campus.ack.no')} footer={<Btn title={t('campus.ack.no')} onPress={() => onSubmit(note.trim())} />}><Field label={t('campus.ack.note')} value={note} onChangeText={setNote} multiline /></Sheet>;
}
