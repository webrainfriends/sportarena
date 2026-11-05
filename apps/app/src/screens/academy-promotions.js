// Promotions (#800): the tracked, human-approved path from a progression decision to the athlete's new group, squad and certificate. It lives in
// Academy > Progress (no parallel console). Every figure and action comes from the promotion capabilities; the UI only calls them, and the work
// itself is done by the canonical enrolment, team-invitation and credential capabilities. All text goes through t().
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, ErrorBox, Loading, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { Block, Fact, Kpi, Split, Timeline, when } from './academy-ui';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const TONE = { completed: c.lime, awaiting_acceptance: c.sunSoft, awaiting_final_approval: c.sunSoft, pending_approval: c.violetSoft, approved: c.violetSoft, in_progress: c.violetSoft, partial: c.orangeSoft, rejected: c.orangeSoft, expired: c.orangeSoft, cancelled: undefined, rolled_back: undefined };
const CHECK = { pass: ['✓', c.lime], warn: ['!', c.sunSoft], fail: ['✕', c.orangeSoft] };
const STEP_ICON = { done: '✓', pending: '○', running: '…', failed: '✕', declined: '✕', skipped: '–', compensated: '↺' };
const idem = () => `promo-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const PROMOTION_DECISIONS = ['promote', 'move_programme', 'invite_squad', 'graduate'];
const eventTitle = (ev) => {
  const m = /^step_(.*)_(done|failed|compensated|compensation_failed)$/.exec(ev);
  if (m) return `${t(`promo.step.${m[1]}`)} · ${t(`promo.event.step_${m[2]}`)}`;
  return ev.startsWith('status_') ? `${t('promo.event.status')}: ${t(`promo.status.${ev.slice(7)}`)}` : t(`promo.event.${ev}`);
};
const levelLine = (r) => [r.from_level, r.to_level].filter(Boolean).join(' → ');

/** The step track: what has happened, what is waiting and on whom (never colour alone: every step carries its icon and state word). */
function StepTrack({ steps }) {
  return (
    <View style={{ gap: 6 }} accessibilityRole="list">
      {steps.map((s) => (
        <View key={s.kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 }} accessible accessibilityLabel={`${t(`promo.step.${s.kind}`)}: ${t(`promo.state.${s.state}`)}`}>
          <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: s.state === 'done' ? c.mint : s.state === 'failed' || s.state === 'declined' ? c.orange : c.violetSoft }}>
            <T size={12} weight="800" color={s.state === 'done' || s.state === 'failed' || s.state === 'declined' ? c.onAccent : c.mute}>{STEP_ICON[s.state] ?? '○'}</T>
          </View>
          <View style={{ flex: 1 }}>
            <T size={13} weight="700">{t(`promo.step.${s.kind}`)}</T>
            {s.error ? <T size={12} color={c.orange}>{s.error}</T> : null}
          </View>
          <Tag label={t(`promo.state.${s.state}`)} color={s.state === 'done' ? c.lime : s.state === 'failed' ? c.orangeSoft : undefined} />
        </View>
      ))}
    </View>
  );
}

function Checks({ checks }) {
  if (!checks?.length) return null;
  return (
    <Block title={t('promo.checks')}>
      {checks.map((k) => (
        <View key={k.key} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }} accessible accessibilityLabel={`${t(`promo.check.${k.key}`)}: ${t(`promo.check.${k.status}`)}. ${k.detail}`}>
          <Tag label={`${CHECK[k.status][0]} ${t(`promo.check.${k.status}`)}`} color={CHECK[k.status][1]} />
          <View style={{ flex: 1 }}><T size={13} weight="700">{t(`promo.check.${k.key}`)}</T><T size={12} color={c.mute}>{k.detail}</T></View>
        </View>
      ))}
    </Block>
  );
}

function Detail({ id, staff, archived, toast, onChanged }) {
  const d = useLoad(() => api.get(`/academy/promotions/${id}`), [id]);
  const [busy, setBusy] = useState(false), [ask, setAsk] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const r = d.data;
  const act = async (fn, done) => { setBusy(true); try { await fn(); toast(done); d.reload(); onChanged(); } catch (e) { toast(e.message); d.reload(); } finally { setBusy(false); } };
  const approve = (stage) => act(() => api.post(`/academy/promotions/${r.id}/approve`, { stage, row_version: r.row_version }), t(stage === 'final' ? 'promo.done.final' : 'promo.done.approved'));
  const blocked = (r.checks ?? []).some((k) => k.status === 'fail');
  const canAct = staff && !archived;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800" size={17} style={{ flex: 1, minWidth: 140 }}>{r.athlete_name}</T>
        <Tag label={t(`promo.status.${r.status}`)} color={TONE[r.status]} />
      </View>
      <Fact k={t('promo.decision')} v={t(`promo.decision.${r.decision}`)} />
      <Fact k={t('promo.level')} v={levelLine(r)} />
      <Fact k={t('promo.group')} v={r.to_cohort ? `${r.from_cohort ?? '—'} → ${r.to_cohort}` : null} />
      <Fact k={t('promo.squad')} v={r.team_name} />
      <Fact k={t('promo.expires')} v={when(r.expires_at)} />
      {r.progress ? <T size={12} color={c.mute}>{t('promo.progress', { done: r.progress.done, total: r.progress.total })}</T> : null}
      <Block title={t('promo.steps')}><StepTrack steps={r.steps} /></Block>
      {r.status === 'awaiting_acceptance' ? <T size={13} color={c.mute}>{t('promo.waiting_answer')}</T> : null}
      {r.status === 'awaiting_final_approval' ? <T size={13} color={c.mute}>{t('promo.waiting_final')}</T> : null}
      {staff ? <Checks checks={r.checks} /> : null}
      {r.note ? <Block title={t('promo.note')}><T size={13}>{r.note}</T></Block> : null}
      {canAct ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {r.status === 'pending_approval' ? <Btn small title={t('promo.approve')} loading={busy} disabled={blocked} onPress={() => approve('plan')} accessibilityLabel={blocked ? t('promo.approve_blocked') : t('promo.approve')} /> : null}
          {r.status === 'awaiting_final_approval' ? <Btn small title={t('promo.approve_final')} loading={busy} onPress={() => approve('final')} /> : null}
          {['partial', 'approved', 'in_progress', 'awaiting_acceptance'].includes(r.status) ? <Btn small title={r.status === 'partial' ? t('promo.retry') : t('promo.refresh')} color={c.paper} ink={c.ink} loading={busy} onPress={() => act(() => api.post(`/academy/promotions/${r.id}/advance`), t('promo.done.advanced'))} /> : null}
          {r.status === 'pending_approval' ? <Btn small title={t('promo.cancel')} color={c.paper} ink={c.ink} onPress={() => setAsk('cancel')} /> : null}
          {['partial', 'approved', 'in_progress', 'awaiting_acceptance', 'awaiting_final_approval', 'completed'].includes(r.status) && r.decision !== 'graduate' ? <Btn small title={t('promo.rollback')} color={c.paper} ink={c.ink} onPress={() => setAsk('rollback')} /> : null}
        </View>
      ) : null}
      {blocked && r.status === 'pending_approval' ? <T size={12} color={c.orange}>{t('promo.approve_blocked')}</T> : null}
      <Block title={t('promo.history')}>
        {r.events?.length ? <Timeline items={r.events.map((e) => ({ title: eventTitle(e.event), sub: `${when(e.created_at)}${e.actor ? ` · ${e.actor}` : ''}` }))} /> : <T size={12} color={c.mute}>{t('promo.history_empty')}</T>}
      </Block>
      {ask ? (
        <FormSheet visible onClose={() => setAsk(null)} title={t(`promo.${ask}`)} submitLabel={t(`promo.${ask}`)} fields={[{ key: 'reason', label: t('promo.reason'), hint: t('promo.reason_hint') }]}
          onSubmit={async (v) => { await api.post(`/academy/promotions/${r.id}/${ask}`, { reason: v.reason }); d.reload(); onChanged(); return t(`promo.done.${ask}`); }} />
      ) : null}
    </View>
  );
}

/** Start a promotion for a decision that was recorded in Progress: choose the athlete's enrolment, the destination group, the squad and the certificate. */
export function PlanPromotion({ o, decision, athleteId, onClose, onPlanned }) {
  const mem = useLoad(() => api.get(`/organisations/${o.id}/academy/athletes/${athleteId}/360`).then((x) => x.sections?.memberships?.data ?? []).catch(() => []), [athleteId]);
  const cohorts = useLoad(() => api.get(`/organisations/${o.id}/cohorts`, { limit: 100 }).catch(() => []), [o.id]);
  const [key] = useState(idem);
  const d = decision.decision;
  const live = (mem.data ?? []).filter((m) => ['enrolled', 'paused', 'graduated', 'completed'].includes(m.status));
  const fields = [
    ...(d !== 'invite_squad' ? [{ key: 'enrolment_id', label: t('promo.f.enrolment'), type: 'choice', options: live.map((m) => ({ value: m.id, label: `${m.programme ?? m.group_name} · ${m.group_name}`, sub: m.status })) }] : []),
    ...(d === 'promote' || d === 'move_programme' ? [{ key: 'to_cohort_id', label: t('promo.f.cohort'), type: 'choice', optional: d === 'promote', options: (cohorts.data ?? []).map((k) => ({ value: k.id, label: k.name })) }] : []),
    ...(d === 'promote' || d === 'invite_squad' ? [{ key: 'team_id', label: t('promo.f.team'), type: 'entity', entityKind: 'team', noun: t('promo.f.team_noun'), optional: d === 'promote' }, { key: 'team_role', label: t('promo.f.role'), type: 'chips', options: ['player', 'captain'].map((value) => ({ value, label: t(`promo.f.role.${value}`) })) }] : []),
    ...(d === 'graduate' ? [{ key: 'cert_kind', label: t('promo.f.kind'), type: 'chips', options: ['certificate', 'badge', 'diploma'].map((value) => ({ value, label: t(`promo.f.kind.${value}`) })) }, { key: 'cert_title', label: t('promo.f.cert_title'), optional: true }] : []),
    { key: 'expires_in_days', label: t('promo.f.expires'), type: 'stepper', min: 1, max: 60, hint: t('promo.f.expires_hint') },
    { key: 'note', label: t('promo.f.note'), optional: true },
  ];
  return (
    <FormSheet visible onClose={onClose} title={t('promo.plan')} submitLabel={t('promo.plan_submit')} fields={fields} initial={{ team_role: 'player', cert_kind: 'certificate', expires_in_days: 14, enrolment_id: live[0]?.value }}
      onSubmit={async (v) => { const body = { idempotency_key: key }; for (const f of fields) if (v[f.key]) body[f.key] = v[f.key]; const r = await api.post(`/academy/decisions/${decision.id}/promotion`, body); onPlanned?.(r); return t('promo.done.planned'); }} />
  );
}

/** Academy > Progress > Promotions: the technical director's board of every promotion, graduation and squad transfer in flight. */
export function Promotions({ o, role, archived, toast, focusId }) {
  const staff = role === 'owner' || role === 'admin';
  const [f, setF] = useState('open'), [open, setOpen] = useState(focusId ?? null);
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/promotions`, { status: f, limit: 100 }), [o.id, f]);
  const all = useLoad(() => api.get(`/organisations/${o.id}/academy/promotions`, { limit: 1 }), [o.id]);
  const n = (s) => all.data?.counts?.[s] ?? 0;
  const reload = () => { list.reload(); all.reload(); };
  const body = (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('promo.kpi.waiting')} value={n('pending_approval')} sub={t('promo.kpi.waiting_sub')} tone={n('pending_approval') ? 'alert' : undefined} />
        <Kpi label={t('promo.kpi.answer')} value={n('awaiting_acceptance') + n('awaiting_final_approval')} sub={t('promo.kpi.answer_sub')} />
        <Kpi label={t('promo.kpi.attention')} value={n('partial')} sub={t('promo.kpi.attention_sub')} tone={n('partial') ? 'alert' : undefined} />
        <Kpi label={t('promo.kpi.done')} value={n('completed')} sub={t('promo.kpi.done_sub')} />
      </View>
      <Seg value={f} onChange={setF} color={c.violet} options={['open', 'completed', 'closed'].map((value) => ({ value, label: t(`promo.filter.${value}`) }))} />
      <Panel>
        <Block title={t('promo.title')}>
          <T size={12} color={c.mute}>{t('promo.intro')}</T>
          {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.items.length ? list.data.items.map((r) => (
            <Pressable key={r.id} accessibilityRole="button" accessibilityLabel={`${r.athlete_name}: ${t(`promo.decision.${r.decision}`)}, ${t(`promo.status.${r.status}`)}`} onPress={() => setOpen(r.id)}
              style={{ minHeight: 44, padding: 12, borderRadius: 16, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <T weight="800" size={15} style={{ flex: 1, minWidth: 120 }}>{r.athlete_name}</T>
                <Tag label={t(`promo.status.${r.status}`)} color={TONE[r.status]} />
              </View>
              <T size={12} color={c.mute}>{`${t(`promo.decision.${r.decision}`)}${levelLine(r) ? ` · ${levelLine(r)}` : ''}`}</T>
              <T size={12} color={c.mute}>{t('promo.progress', { done: r.progress.done, total: r.progress.total })}</T>
            </Pressable>
          )) : <Empty emoji="🏅" title={t(`promo.empty.${f}.title`)} sub={t(`promo.empty.${f}.sub`)} />}
        </Block>
      </Panel>
    </View>
  );
  return <Split open={!!open} onClose={() => setOpen(null)} detailTitle={t('promo.detail')} list={body} detail={open ? <Detail key={open} id={open} staff={staff} archived={archived} toast={toast} onChanged={reload} /> : null} />;
}

/** The athlete's (or their guardian's) own view: what is happening to them, which steps are done, and the squad invitation they must answer. No fees, checks or staff notes. */
export function MyPromotions({ athlete, toast }) {
  const q = athlete?.is_me ? undefined : { athlete_id: athlete.id };
  const d = useLoad(() => api.get('/me/academy/promotions', q), [athlete?.id]);
  const [busy, setBusy] = useState(false);
  if (d.error || !d.data) return d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : <Loading />;
  const answer = async (r, accept) => { setBusy(true); try { await api.post(`/teams/${r.needs_my_answer.team_id}/invitations/respond`, { accept }); toast(t(accept ? 'promo.mine.accepted' : 'promo.mine.declined')); d.reload(); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  return (
    <Panel>
      <Block title={t('promo.mine.title')}>
        <T size={12} color={c.mute}>{t('promo.mine.sub')}</T>
        {d.data.length ? d.data.map((r) => (
          <View key={r.id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, borderWidth: 1, borderColor: c.line, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <T weight="800" size={15} style={{ flex: 1, minWidth: 120 }}>{t(`promo.decision.${r.decision}`)}{levelLine(r) ? ` · ${levelLine(r)}` : ''}</T>
              <Tag label={t(`promo.status.${r.status}`)} color={TONE[r.status]} />
            </View>
            <StepTrack steps={r.steps} />
            {r.needs_my_answer ? (
              <View style={{ gap: 8 }}>
                <T size={13}>{t('promo.mine.answer')}</T>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Btn small title={t('promo.mine.accept')} loading={busy} onPress={() => answer(r, true)} />
                  <Btn small title={t('promo.mine.decline')} color={c.paper} ink={c.ink} onPress={() => answer(r, false)} />
                </View>
              </View>
            ) : null}
          </View>
        )) : <Empty emoji="🏅" title={t('promo.mine.empty_title')} sub={t('promo.mine.empty_sub')} />}
      </Block>
    </Panel>
  );
}
