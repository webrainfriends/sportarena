// Discipline: the Discipline tab of the Event console (#479). Cards from the canonical match record feed cases; the published policy decides what is automatic; a panel decides
// the rest; sanctions are served match by match; fines and points deductions go through team finance and the standings. All logic is in the API (capabilities "Discipline"),
// so iOS, iPadOS, Android and web behave the same. Nothing here is ever public: suspensions are not on profiles, rosters or exports.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useDo } from './console-utils';
import { A, ABar, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStat, AT, ATag } from '../arena';
import { FormSheet } from '../FormSheet';
import { ErrorBox, Loading, Sheet } from '../ui';
import { t } from '../i18n';
import { locale } from '../locale';
import { VerificationPanel } from './verification-request';

const stamp = (d) => (d ? new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const CATEGORIES = ['violent_conduct', 'serious_foul_play', 'abusive_language', 'dissent', 'persistent_infringement', 'team_misconduct', 'coach_misconduct', 'official_misconduct', 'ineligible_player', 'other'];
export const SANCTIONS = ['warning', 'match_suspension', 'date_suspension', 'competition_ban', 'role_suspension', 'fine', 'points_deduction', 'other'];
const STATE_TONE = { opened: A.sun, under_review: A.cyan, decided: A.green, closed: A.mute, withdrawn: A.mute };
export const heading = (...parts) => parts.filter(Boolean).join(' · ');
const opts = (prefix, list) => list.map((v) => ({ value: v, label: t(`${prefix}.${v}`) }));

export function DisciplineTab({ id, scope, sub, setSub }) {
  const view = sub || 'overview';
  const views = [['overview', t('disc.tab.overview')], ['cases', t('disc.tab.cases')], ...(scope.as === 'organiser' ? [['policy', t('disc.tab.policy')], ['panel', t('disc.tab.panel')]] : []), ['verify', t('disc.tab.verify')]];
  const P = { id, scope, setSub };
  return (
    <>
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {views.map(([k, label]) => <AChip key={k} label={label} active={view === k} onPress={() => setSub(k)} />)}
      </View>
      {view === 'overview' && <Overview {...P} />}
      {view === 'cases' && <Cases {...P} />}
      {view === 'policy' && scope.as === 'organiser' && <Policy {...P} />}
      {view === 'panel' && scope.as === 'organiser' && <Panel {...P} />}
      {view === 'verify' && <VerificationPanel competitionId={scope.competition_id} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------- overview
function Overview({ scope, setSub }) {
  const r = useLoad(() => api.get(`/competitions/${scope.competition_id}/discipline`, { season_id: scope.season_id }), [scope.season_id]);
  const act = useDo(r.reload);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const d = r.data, m = d.metrics;
  const max = Math.max(1, ...d.cards_by_team.map((x) => x.n));
  const byTeam = Object.values(d.cards_by_team.reduce((o, x) => { (o[x.team_id ?? 'none'] ??= { name: x.team_name ?? '—', n: 0 }).n += x.n; return o; }, {}));
  return (
    <>
      {!d.policy ? (
        <ACard tone={A.sun}>
          <AT size={15} weight="900">{t('disc.nopolicy.title')}</AT>
          <AT size={13} weight="600" color={A.mute} style={{ marginTop: 4 }}>{t('disc.nopolicy.sub')}</AT>
          {scope.as === 'organiser' ? <ABtn small title={t('disc.policy.publish')} onPress={() => setSub('policy')} style={{ marginTop: 10, alignSelf: 'flex-start' }} /> : null}
        </ACard>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="📂" value={m.open_cases} label={t('disc.m.open')} />
        <AStat icon="⛔" value={m.people_suspended} label={t('disc.m.suspended')} tone={m.people_suspended ? A.red : undefined} />
        <AStat icon="⚖️" value={m.appeals_open} label={t('disc.m.appeals')} />
        <AStat icon="🚩" value={m.flagged_for_reevaluation} label={t('disc.m.flagged')} tone={m.flagged_for_reevaluation ? A.orange : undefined} />
      </View>
      {scope.can_decide && d.policy ? <ABtn small tone="ghost" title={t('disc.sweep')} onPress={() => act(() => api.post(`/competitions/${scope.competition_id}/discipline/sweep`, { season_id: scope.season_id }), (x) => t('disc.sweep.done', { n: x.opened }))} style={{ alignSelf: 'flex-start' }} /> : null}
      <ASection title={t('disc.cards.title')} sub={t('disc.cards.sub')} />
      {byTeam.length ? byTeam.map((x) => (
        <ACard key={x.name} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><AT size={14} weight="800">{x.name}</AT><AT size={14} weight="900" num>{x.n}</AT></View>
          <View style={{ marginTop: 8 }}><ABar pct={(x.n / max) * 100} color={A.orange} /></View>
        </ACard>
      )) : <AEmpty emoji="🟨" title={t('disc.cards.empty')} sub={t('disc.cards.empty_sub')} />}
      <ASection title={t('disc.watch.title')} sub={t('disc.watch.sub')} />
      {d.watchlist.length ? d.watchlist.map((w) => (
        <ARow key={w.player_id} title={w.display_name ?? '—'} sub={t('disc.watch.row', { cards: w.cards, points: w.points })}
          right={w.points_to_next_threshold != null ? <ATag label={t('disc.watch.to_next', { n: w.points_to_next_threshold })} tone={w.points_to_next_threshold <= 1 ? A.red : A.sun} /> : null} />
      )) : <AEmpty emoji="👀" title={t('disc.watch.empty')} sub={t('disc.watch.empty_sub')} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------- cases
function Cases({ scope }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(false);
  const r = useLoad(() => api.get(`/competitions/${scope.competition_id}/discipline/cases`, { season_id: scope.season_id, ...(status ? { status } : {}), limit: 100 }), [scope.season_id, status]);
  const act = useDo(r.reload);
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <AChip label={t('common.all')} active={!status} onPress={() => setStatus(null)} />
        {['opened', 'under_review', 'decided', 'closed'].map((s) => <AChip key={s} label={t(`disc.state.${s}`)} active={status === s} onPress={() => setStatus(s)} color={STATE_TONE[s]} />)}
      </View>
      <ABtn small title={t('disc.case.open')} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (r.data ?? []).length ? r.data.map((k) => (
        <ARow key={k.id} onPress={() => setOpen(k.id)} title={heading(k.case_no, k.subject_name ?? k.team_name ?? '—')}
          sub={[t(`disc.cat.${k.category}`), k.team_name, stamp(k.created_at)].filter(Boolean).join(' · ')}
          right={<><ATag label={t(`disc.state.${k.status}`)} tone={STATE_TONE[k.status]} />{k.reevaluation === 'flagged' ? <ATag label={t('disc.flagged')} tone={A.orange} /> : null}{k.interim_status === 'interim_suspension' ? <ATag label={t('disc.interim')} tone={A.red} /> : null}</>} />
      )) : <AEmpty emoji="📂" title={t('disc.cases.empty')} sub={t('disc.cases.empty_sub')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('disc.case.open')} submitLabel={t('disc.case.open')} notice={t('disc.notfinding')}
        fields={[
          { key: 'subject_kind', label: t('disc.f.about'), type: 'chips', options: opts('disc.subject', ['player', 'team', 'coach', 'official']) },
          { key: 'subject_user_id', label: t('disc.f.person'), type: 'entity', entityKind: 'person', noun: t('disc.f.person'), show: (v) => v.subject_kind !== 'team' },
          { key: 'subject_team_id', label: t('disc.f.team'), type: 'entity', entityKind: 'team', noun: t('disc.f.team'), show: (v) => v.subject_kind === 'team' },
          { key: 'team_id', label: t('disc.f.plays_for'), type: 'entity', entityKind: 'team', noun: t('disc.f.team'), optional: true, show: (v) => v.subject_kind !== 'team' },
          { key: 'category', label: t('disc.f.category'), type: 'chips', options: opts('disc.cat', CATEGORIES) },
          { key: 'summary', label: t('disc.f.summary'), type: 'multiline', hint: t('disc.f.summary_hint') },
          { key: 'interim', label: t('disc.f.interim'), type: 'chips', options: opts('disc.interim_s', ['none', 'pending_review', 'interim_suspension']), optional: true, show: () => scope.can_decide },
        ]}
        initial={{ subject_kind: 'player', category: 'dissent', interim: 'none' }}
        onSubmit={async (v) => { await api.post(`/competitions/${scope.competition_id}/discipline/cases`, { season_id: scope.season_id, source: 'manual_referral', ...v, subject_user_id: v.subject_kind === 'team' ? undefined : v.subject_user_id, subject_team_id: v.subject_kind === 'team' ? v.subject_team_id : undefined }); setForm(false); r.reload(); }} />
      {open ? <CaseSheet id={open} scope={scope} onClose={() => { setOpen(null); r.reload(); }} act={act} /> : null}
    </>
  );
}

function CaseSheet({ id, scope, onClose }) {
  const r = useLoad(() => api.get(`/discipline/cases/${id}`), [id]);
  const act = useDo(r.reload);
  const [decide, setDecide] = useState(false);
  const [ruling, setRuling] = useState(null);
  const [evid, setEvid] = useState(false);
  const k = r.data;
  const live = k?.decisions?.find((d) => !d.superseded_at);
  return (
    <Sheet visible onClose={onClose} title={k ? k.case_no : t('disc.case.title')}>
      {r.loading && !k ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : k ? (
        <View style={{ gap: 12 }}>
          <ACard tone={A.sun}><AT size={12.5} weight="700">{k.notice}</AT></ACard>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <ATag label={t(`disc.state.${k.status}`)} tone={STATE_TONE[k.status]} />
            <ATag label={t(`disc.cat.${k.category}`)} />
            {k.interim_status !== 'none' ? <ATag label={t(`disc.interim_s.${k.interim_status}`)} tone={A.red} /> : null}
            {k.reevaluation === 'flagged' ? <ATag label={t('disc.flagged')} tone={A.orange} /> : null}
          </View>
          {k.subject_name ? <AT size={15} weight="800">{k.subject_name}</AT> : null}
          {k.summary ? <AT size={14} weight="600">{k.summary}</AT> : null}
          {k.reevaluation === 'flagged' ? <ACard tone={A.orange}><AT size={13} weight="700">{t('disc.flagged_sub')}</AT>{scope.can_decide ? <ABtn small tone="ghost" title={t('disc.reviewed')} onPress={() => act(() => api.post(`/discipline/cases/${id}/transition`, { action: 'mark_reevaluated' }), t('disc.reviewed.done'))} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}</ACard> : null}

          <ASection title={t('disc.sanctions')} />
          {k.sanctions.filter((s) => ['active', 'stayed'].includes(s.status)).length ? k.sanctions.filter((s) => ['active', 'stayed'].includes(s.status)).map((s) => (
            <ACard key={s.id} pad={12}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <AT size={14} weight="900">{s.label || t(`disc.sanction.${s.kind}`)}</AT>
                <ATag label={s.status === 'stayed' ? t('disc.stayed') : t('disc.in_force')} tone={s.status === 'stayed' ? A.sun : A.red} />
              </View>
              {s.service ? (
                <View style={{ marginTop: 8, gap: 6 }}>
                  <ABar pct={(s.service.served / s.service.matches) * 100} color={A.green} />
                  <AT size={12.5} weight="700" color={A.mute}>{t('disc.served', { served: s.service.served, matches: s.service.matches, remaining: s.service.remaining })}</AT>
                </View>
              ) : null}
              {s.effective_from || s.effective_to ? <AT size={12.5} weight="600" color={A.mute} style={{ marginTop: 4 }}>{[stamp(s.effective_from), stamp(s.effective_to)].filter(Boolean).join(' → ')}</AT> : null}
              {s.kind === 'fine' ? <AT size={12.5} weight="700" style={{ marginTop: 4 }}>{(s.amount_minor / 100).toLocaleString(locale, { style: 'currency', currency: s.currency || 'INR' })}</AT> : null}
              {s.kind === 'points_deduction' ? <AT size={12.5} weight="700" style={{ marginTop: 4 }}>−{s.points} {t('disc.points')}</AT> : null}
              {scope.can_decide ? <ABtn small tone="ghost" title={t('disc.lift')} onPress={() => setRuling({ lift: s.id })} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
            </ACard>
          )) : <AEmpty emoji="🕊️" title={t('disc.sanctions.empty')} />}

          <ASection title={t('disc.decisions')} />
          {k.decisions.length ? k.decisions.map((d) => (
            <ACard key={d.id} pad={12} tone={d.superseded_at ? undefined : A.green}>
              <AT size={13} weight="900">{t(`disc.dkind.${d.kind}`)} · {t(`disc.outcome.${d.outcome}`)}{d.automatic ? ` · ${t('disc.automatic')}` : ''}</AT>
              <AT size={12} weight="600" color={A.mute}>{stamp(d.created_at)}{d.decided_by_name ? ` · ${d.decided_by_name}` : ''}{d.superseded_at ? ` · ${t('disc.superseded')}` : ''}</AT>
              {d.reason ? <AT size={13.5} weight="600" style={{ marginTop: 6 }}>{d.reason}</AT> : null}
            </ACard>
          )) : <AEmpty emoji="⚖️" title={t('disc.decisions.empty')} />}

          {k.appeals?.length ? <><ASection title={t('disc.appeals')} />{k.appeals.map((a) => (
            <ARow key={a.id} title={t(`disc.astate.${a.status}`)} sub={`${t('disc.deadline')}: ${stamp(a.deadline_on)}`}
              right={['lodged', 'under_review'].includes(a.status) && scope.can_decide ? <ABtn small title={t('disc.rule')} onPress={() => setRuling({ appeal: a.id })} /> : null} />
          ))}</> : null}

          {k.evidence ? <><ASection title={t('disc.evidence')} action={t('disc.evidence.add')} onAction={() => setEvid(true)} />{k.evidence.length ? k.evidence.map((e) => <ARow key={e.id} title={e.title} sub={`${t(`disc.ekind.${e.kind}`)} · ${stamp(e.created_at)}`} />) : <AEmpty emoji="🗂️" title={t('disc.evidence.empty')} />}</> : null}
          {k.history ? <><ASection title={t('disc.history')} />{k.history.map((h) => <AT key={h.id} size={12.5} weight="600" color={A.mute}>{stamp(h.created_at)} · {h.action.replace(/_/g, ' ')}{h.reason ? ` — ${h.reason}` : ''}</AT>)}</> : null}

          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {k.status === 'opened' && k.as !== 'subject' && k.as !== 'team' ? <ABtn small tone="ghost" title={t('disc.start_review')} onPress={() => act(() => api.post(`/discipline/cases/${id}/transition`, { action: 'start_review' }), t('disc.updated'))} /> : null}
            {scope.can_decide && ['opened', 'under_review'].includes(k.status) ? <ABtn small title={t('disc.decide')} onPress={() => setDecide(true)} /> : null}
            {scope.can_decide && k.status === 'decided' ? <ABtn small tone="ghost" title={t('disc.amend')} onPress={() => setDecide(true)} /> : null}
            {scope.can_decide && k.status === 'decided' ? <ABtn small tone="ghost" title={t('disc.close')} onPress={() => act(() => api.post(`/discipline/cases/${id}/transition`, { action: 'close' }), t('disc.updated'))} /> : null}
          </View>
          <DecisionForm visible={decide} onClose={() => setDecide(false)} id={id} live={live} done={() => { setDecide(false); r.reload(); }} />
          <FormSheet visible={!!ruling} onClose={() => setRuling(null)} title={ruling?.lift ? t('disc.lift') : t('disc.rule')} submitLabel={t('common.save')}
            fields={ruling?.lift ? [{ key: 'reason', label: t('disc.f.reason'), type: 'multiline' }] : [{ key: 'outcome', label: t('disc.f.ruling'), type: 'chips', options: opts('disc.astate', ['upheld', 'reduced', 'overturned', 'remitted']) }, { key: 'reason', label: t('disc.f.reason'), type: 'multiline' }, ...sanctionFields((v) => v.outcome === 'reduced')]}
            initial={{ outcome: 'overturned' }}
            onSubmit={async (v) => { if (ruling.lift) await api.post(`/discipline/sanctions/${ruling.lift}/lift`, { reason: v.reason }); else await api.post(`/discipline/appeals/${ruling.appeal}/ruling`, { outcome: v.outcome, reason: v.reason, sanctions: v.outcome === 'reduced' ? sanctionsOf(v) : [] }); setRuling(null); r.reload(); }} />
          <FormSheet visible={evid} onClose={() => setEvid(false)} title={t('disc.evidence.add')} submitLabel={t('common.save')}
            fields={[{ key: 'kind', label: t('disc.f.ekind'), type: 'chips', options: opts('disc.ekind', ['report', 'video', 'statement', 'document', 'other']) }, { key: 'title', label: t('disc.f.etitle') }, { key: 'body', label: t('disc.f.ebody'), type: 'multiline', optional: true }]}
            initial={{ kind: 'statement' }} onSubmit={async (v) => { await api.post(`/discipline/cases/${id}/evidence`, v); setEvid(false); r.reload(); }} />
        </View>
      ) : null}
    </Sheet>
  );
}

/** The sanction fields, one control for each kind of answer: matches a stepper, dates a calendar range, a fine a currency amount, points a stepper. */
function sanctionFields(when = () => true) {
  const has = (v, k) => when(v) && (v.kinds ?? []).includes(k);
  return [
    { key: 'kinds', label: t('disc.f.sanctions'), type: 'multi', options: opts('disc.sanction', SANCTIONS), show: when },
    { key: 'matches', label: t('disc.f.matches'), type: 'stepper', min: 1, max: 50, default: 1, show: (v) => has(v, 'match_suspension') },
    { key: 'effective_from', toKey: 'effective_to', label: t('disc.f.dates'), type: 'daterange', show: (v) => has(v, 'date_suspension') || has(v, 'competition_ban') || has(v, 'role_suspension') },
    { key: 'amount_minor', label: t('disc.f.fine'), type: 'money', currency: 'INR', show: (v) => has(v, 'fine') },
    { key: 'points', label: t('disc.f.points'), type: 'stepper', min: 1, max: 30, default: 3, show: (v) => has(v, 'points_deduction') },
    { key: 'label', label: t('disc.f.label'), optional: true, show: (v) => has(v, 'other') || has(v, 'warning') },
  ];
}
function sanctionsOf(v) {
  return (v.kinds ?? []).map((kind) => ({
    kind,
    ...(kind === 'match_suspension' ? { matches: v.matches } : {}),
    ...(['date_suspension', 'competition_ban', 'role_suspension'].includes(kind) && v.effective_from ? { effective_from: v.effective_from, ...(v.effective_to ? { effective_to: v.effective_to } : {}) } : {}),
    ...(kind === 'fine' ? { amount_minor: v.amount_minor } : {}),
    ...(kind === 'points_deduction' ? { points: v.points } : {}),
    ...(['other', 'warning'].includes(kind) && v.label ? { label: v.label } : {}),
  }));
}
function DecisionForm({ visible, onClose, id, live, done }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={live ? t('disc.amend') : t('disc.decide')} submitLabel={t('common.save')} notice={t('disc.decide_notice')}
      fields={[{ key: 'outcome', label: t('disc.f.outcome'), type: 'chips', options: opts('disc.outcome', ['upheld', 'dismissed', 'no_further_action']) }, { key: 'reason', label: t('disc.f.reason'), type: 'multiline', hint: t('disc.f.reason_hint') }, ...sanctionFields((v) => v.outcome === 'upheld')]}
      initial={{ outcome: 'upheld', kinds: [] }}
      onSubmit={async (v) => { await api.post(`/discipline/cases/${id}/decision`, { outcome: v.outcome, reason: v.reason, sanctions: v.outcome === 'upheld' ? sanctionsOf(v) : [] }); done(); }} />
  );
}

// ---------------------------------------------------------------------------------------------------------------- policy
const NUM = (v, d) => (v == null ? d : v);
function Policy({ scope }) {
  const r = useLoad(() => api.get(`/competitions/${scope.competition_id}/discipline/policy`, { season_id: scope.season_id }), [scope.season_id]);
  const [form, setForm] = useState(false);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const cur = r.data.current, p = cur?.params ?? r.data.defaults;
  const acc = p.accumulation?.[0], red = (p.direct ?? []).find((d) => d.kind === 'red_card'), sec = p.second_caution;
  const initial = {
    yellow: NUM(p.card_points?.yellow_card, 1), acc_points: acc?.points ?? 5, acc_matches: acc?.matches ?? 1, red_matches: red?.matches ?? 1, second_on: !!sec, second_matches: sec?.matches ?? 1,
    scope: p.scope, abandoned: !!p.abandoned_counts, window: p.appeal_window_days, stay: !!p.stay_on_appeal, fines: !!p.authority?.fines, fine_cap: p.authority?.fine_cap_minor ?? undefined, deduct: !!p.authority?.points_deduction, points_cap: p.authority?.points_cap ?? 6,
  };
  return (
    <>
      <ACard tone={cur ? A.green : A.sun}>
        <AT size={15} weight="900">{cur ? t('disc.policy.version', { n: cur.version }) : t('disc.nopolicy.title')}</AT>
        <AT size={13} weight="600" color={A.mute} style={{ marginTop: 4 }}>{t('disc.policy.sub')}</AT>
        <ABtn small title={t('disc.policy.publish')} onPress={() => setForm(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
      </ACard>
      {cur ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <AStat icon="🟨" value={acc ? `${acc.points}→${acc.matches}` : '—'} label={t('disc.p.accumulate')} />
          <AStat icon="🟥" value={red?.matches ?? '—'} label={t('disc.p.red')} />
          <AStat icon="⏱️" value={p.appeal_window_days} label={t('disc.p.window')} />
        </View>
      ) : null}
      <ASection title={t('disc.policy.history')} />
      {r.data.history.length ? r.data.history.map((h) => <ARow key={h.id} title={t('disc.policy.version', { n: h.version })} sub={[stamp(h.created_at), h.note].filter(Boolean).join(' · ')} />) : <AEmpty emoji="📜" title={t('disc.policy.history_empty')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('disc.policy.publish')} submitLabel={t('disc.policy.publish')} notice={t('disc.policy.immutable')} initial={initial}
        fields={[
          { key: 'yellow', label: t('disc.p.yellow'), type: 'stepper', min: 0, max: 5 },
          { key: 'acc_points', label: t('disc.p.acc_points'), type: 'stepper', min: 1, max: 20 },
          { key: 'acc_matches', label: t('disc.p.acc_matches'), type: 'stepper', min: 1, max: 10 },
          { key: 'red_matches', label: t('disc.p.red'), type: 'stepper', min: 1, max: 20 },
          { key: 'second_on', label: t('disc.p.second'), type: 'switch' },
          { key: 'second_matches', label: t('disc.p.second_matches'), type: 'stepper', min: 1, max: 10, show: (v) => v.second_on },
          { key: 'scope', label: t('disc.p.scope'), type: 'chips', options: opts('disc.scope', ['competition', 'sport']) },
          { key: 'abandoned', label: t('disc.p.abandoned'), type: 'switch' },
          { key: 'window', label: t('disc.p.window'), type: 'stepper', min: 1, max: 60 },
          { key: 'stay', label: t('disc.p.stay'), type: 'switch' },
          { key: 'fines', label: t('disc.p.fines'), type: 'switch' },
          { key: 'fine_cap', label: t('disc.p.fine_cap'), type: 'money', currency: 'INR', optional: true, show: (v) => v.fines },
          { key: 'deduct', label: t('disc.p.deduct'), type: 'switch' },
          { key: 'points_cap', label: t('disc.p.points_cap'), type: 'stepper', min: 1, max: 30, show: (v) => v.deduct },
        ]}
        onSubmit={async (v) => {
          await api.post(`/competitions/${scope.competition_id}/discipline/policy`, { season_id: scope.season_id, params: {
            card_points: { yellow_card: v.yellow, green_card: v.yellow },
            accumulation: v.yellow ? [{ points: v.acc_points, matches: v.acc_matches }] : [],
            direct: [{ kind: 'red_card', matches: v.red_matches }],
            second_caution: v.second_on ? { kind: 'yellow_card', matches: v.second_matches } : null,
            scope: v.scope, abandoned_counts: !!v.abandoned, appeal_window_days: v.window, stay_on_appeal: !!v.stay,
            authority: { fines: !!v.fines, points_deduction: !!v.deduct, fine_cap_minor: v.fines && v.fine_cap ? v.fine_cap : null, points_cap: v.deduct ? v.points_cap : null },
          } });
          setForm(false); r.reload();
        }} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------- panel
function Panel({ scope }) {
  const r = useLoad(() => api.get(`/competitions/${scope.competition_id}/discipline/panel`), []);
  const act = useDo(r.reload);
  const [form, setForm] = useState(false);
  return (
    <>
      <AT size={13} weight="600" color={A.mute}>{t('disc.panel.sub')}</AT>
      <ABtn small title={t('disc.panel.add')} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (r.data ?? []).length ? r.data.map((m) => (
        <ARow key={m.id} title={m.display_name} sub={t(`disc.role.${m.role}`)} right={<ABtn small tone="ghost" title={t('disc.panel.end')} onPress={() => act(() => api.post(`/competitions/${scope.competition_id}/discipline/panel/${m.user_id}/end`, {}), t('disc.updated'))} />} />
      )) : <AEmpty emoji="🧑‍⚖️" title={t('disc.panel.empty')} sub={t('disc.panel.empty_sub')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('disc.panel.add')} submitLabel={t('common.save')} initial={{ role: 'panel' }}
        fields={[{ key: 'user_id', label: t('disc.f.person'), type: 'entity', entityKind: 'person', noun: t('disc.f.person') }, { key: 'role', label: t('disc.f.role'), type: 'chips', options: opts('disc.role', ['panel', 'secretary']) }]}
        onSubmit={async (v) => { await api.post(`/competitions/${scope.competition_id}/discipline/panel`, v); setForm(false); r.reload(); }} />
    </>
  );
}
