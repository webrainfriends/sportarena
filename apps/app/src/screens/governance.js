// Governance tabs of Competition Home (#563): Transfers · Discipline · Rule pack & archive. They sit INSIDE the one competition console (no second console);
// every rule is enforced by the API (REST / OpenAPI / MCP) and this screen only calls it. Dates and teams use pickers/menus, fixed choices use chips.
// One React Native codebase: iOS, iPadOS, Android and web. Theme tokens only (Dusk, light and dark). Strings come from t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, H2, Loading, Section, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { MenuField } from '../menu-field';
import { Counter, DateField } from '../pickers';
import { EntityPicker } from '../entity-picker';
import { SwitchRow, Cols } from '../federation-bits';
import { Banner, Metric, fmtDate } from '../federation-ui';
import { useDo } from './console-utils';

const Row = ({ children, style }) => <View style={[{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, style]}>{children}</View>;
const TONE = { draft: c.violetSoft, submitted: c.sunSoft, approved: c.cyanSoft, completed: c.limeSoft, rejected: c.redSoft, withdrawn: c.violetSoft, cancelled: c.violetSoft,
  received: c.sunSoft, under_review: c.sunSoft, interim: c.orangeSoft, decided: c.limeSoft, appealed: c.cyanSoft, closed: c.violetSoft, dismissed: c.violetSoft, active: c.redSoft, stayed: c.sunSoft, overturned: c.violetSoft, expired: c.violetSoft, served: c.limeSoft };
export const Status = ({ s }) => <Tag label={t(`gov.status.${s}`)} color={TONE[s] ?? c.violetSoft} />;
const num = (n) => String(n ?? 0);
const join2 = (a, b) => [a, b].filter(Boolean).join(' ');
const ver = (v) => 'v' + v;

// ------------------------------------------------------------------ Transfers
const KINDS = ['permanent', 'loan', 'loan_extension', 'loan_recall', 'release', 'dual_registration', 'international'];

export function TransfersTab({ comp, season: s, can }) {
  const list = useLoad(() => api.get('/transfers', { season_id: s.id, limit: 50 }), [s.id]);
  const [open, setOpen] = useState(null), [sheet, setSheet] = useState(false);
  const items = list.data?.items ?? [];
  const by = (st) => items.filter((x) => x.status === st).length;
  const win = s.transfer_opens_on || s.transfer_closes_on;
  const today = new Date().toISOString().slice(0, 10);
  const inWindow = win && (!s.transfer_opens_on || today >= s.transfer_opens_on) && (!s.transfer_closes_on || today <= s.transfer_closes_on);
  return (
    <View style={{ gap: 10 }}>
      <Row>
        <Metric value={num(by('submitted'))} label={t('gov.transfers.awaiting')} tone={by('submitted') ? c.sunSoft : undefined} />
        <Metric value={num(by('approved'))} label={t('gov.transfers.ready')} tone={by('approved') ? c.cyanSoft : undefined} />
        <Metric value={num(by('completed'))} label={t('gov.transfers.completed')} />
        <Metric value={!win ? t('gov.transfers.noWindow') : inWindow ? t('gov.transfers.windowOpen') : t('gov.transfers.windowClosed')} label={t('gov.transfers.window')} tone={win ? (inWindow ? c.limeSoft : c.redSoft) : undefined}
          sub={win ? `${fmtDate(s.transfer_opens_on)} → ${fmtDate(s.transfer_closes_on)}` : undefined} />
      </Row>
      <Row style={{ justifyContent: 'space-between' }}><H2>{t('gov.transfers.title')}</H2><Btn small title={t('gov.transfers.new')} onPress={() => setSheet(true)} accessibilityLabel={t('gov.transfers.new')} /></Row>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : items.length ? (
        <Cols a={<>{items.map((x) => (
          <Card key={x.id} onPress={() => setOpen(x.id)} accessibilityLabel={join2(x.player_name, x.kind_label)} style={{ marginBottom: 8 }}>
            <Row><T weight="700" style={{ flex: 1, minWidth: 140 }}>{x.player_name}</T><Status s={x.status} /></Row>
            <T size={13} color={c.mute}>{x.kind_label} · {[x.from_team, x.to_team].filter(Boolean).join(' → ')}</T>
            {x.status === 'submitted' ? <T size={12.5} weight="700" color={c.pink}>{t('gov.transfers.progress', { done: x.approvals.approved, total: x.approvals.required })}</T> : null}
            <Row style={{ marginTop: 4 }}><Tag label={fmtDate(x.effective_on)} color={c.cyanSoft} />{x.loan_ends_on ? <Tag label={join2(t('gov.transfers.loanEnds'), fmtDate(x.loan_ends_on))} color={c.violetSoft} /> : null}
              {x.clearance_status !== 'not_required' ? <Tag label={`${t('gov.transfers.clearance')}: ${t(`gov.clearance.${x.clearance_status}`)}`} color={c.sunSoft} /> : null}
              {x.fee_state !== 'none' ? <Tag label={`${t('gov.transfers.fee')}: ${t(`gov.fee.${x.fee_state}`)}`} color={c.violetSoft} /> : null}</Row>
          </Card>))}</>} b={null} />
      ) : <Empty emoji="🔁" title={t('gov.transfers.emptyTitle')} sub={t('gov.transfers.emptySub')} />}
      {open ? <TransferSheet id={open} onClose={() => { setOpen(null); list.reload(); }} /> : null}
      <NewTransfer visible={sheet} season={s} onClose={() => setSheet(false)} onDone={(x) => { setSheet(false); list.reload(); setOpen(x.id); }} />
      {can ? null : null}
    </View>
  );
}

function TransferSheet({ id, onClose }) {
  const q = useLoad(() => api.get(`/transfers/${id}`), [id]);
  const act = useDo(() => q.reload());
  const x = q.data;
  const post = (path, body) => act(() => api.post(`/transfers/${id}/${path}`, { expected_version: x.version, ...body }), t('gov.done'));
  return (
    <Sheet visible onClose={onClose} title={x ? `${x.kind_label}` : t('gov.transfers.title')} footer={x && x.status === 'approved' ? <Btn title={t('gov.transfers.complete')} onPress={() => post('complete')} /> : x?.status === 'draft' ? <Btn title={t('gov.transfers.submit')} onPress={() => post('submit')} /> : null}>
      {!x ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <Row><Status s={x.status} /><Tag label={ver(x.version)} color={c.violetSoft} /><T style={{ flex: 1 }} weight="700">{[x.from_team?.name, x.to_team?.name].filter(Boolean).join(' → ')}</T></Row>
          {!x.window.ok ? <Banner tone={c.redSoft}>{x.window.reason}</Banner> : <Banner tone={c.limeSoft}>{x.window.reason}</Banner>}
          <Section title={t('gov.transfers.parties')} color={c.mute}>
            {x.approvals.required.map((p) => {
              const d = x.approvals.decisions.find((y) => y.party === p);
              return (
                <Row key={p} style={{ paddingVertical: 6 }}>
                  <T style={{ flex: 1, minWidth: 140 }}>{x.approvals.labels[p]}</T>
                  {d ? <Tag label={t(`gov.decision.${d.decision}`)} color={d.decision === 'approved' ? c.limeSoft : c.redSoft} /> : <Tag label={t('gov.transfers.waiting')} color={c.sunSoft} />}
                  {x.status === 'submitted' && x.my_parties.includes(p) ? <>
                    <Btn small title={t('gov.approve')} onPress={() => post('decision', { party: p, decision: 'approved' })} accessibilityLabel={join2(t('gov.approve'), x.approvals.labels[p])} />
                    <Btn small color={c.paper} ink={c.ink} title={t('gov.reject')} onPress={() => post('decision', { party: p, decision: 'rejected' })} accessibilityLabel={join2(t('gov.reject'), x.approvals.labels[p])} /></> : null}
                </Row>);
            })}
          </Section>
          <Section title={t('gov.history')} color={c.mute}>
            {x.events.map((e, i) => <T key={i} size={12.5} color={c.mute} style={{ paddingVertical: 2 }}>{fmtDate(e.created_at)} · {t(`gov.event.${e.action}`)}{e.version ? ` · v${e.version}` : ''}</T>)}
          </Section>
        </View>)}
    </Sheet>
  );
}

function NewTransfer({ visible, season: s, onClose, onDone }) {
  const [f, setF] = useState({ kind: 'permanent', player: [], from: [], to: [], effective_on: null, loan_ends_on: null });
  const act = useDo();
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const loan = ['loan', 'loan_extension'].includes(f.kind);
  const ok = f.player[0] && f.effective_on && (f.kind === 'release' || f.to[0]) && (!loan || f.loan_ends_on);
  return (
    <Sheet visible={visible} onClose={onClose} title={t('gov.transfers.new')} footer={<Btn title={t('gov.transfers.create')} disabled={!ok} onPress={async () => {
      const r = await act(() => api.post('/transfers', { kind: f.kind, season_id: s.id, player_id: f.player[0], from_team_id: f.from[0] || undefined, to_team_id: f.kind === 'release' ? undefined : f.to[0], effective_on: f.effective_on, loan_ends_on: loan ? f.loan_ends_on : undefined }), t('gov.done'));
      if (r) onDone(r);
    }} />}>
      <View style={{ gap: 12 }}>
        <MenuField label={t('gov.transfers.type')} value={f.kind} onChange={set('kind')} options={KINDS.map((k) => ({ value: k, label: t(`gov.kind.${k}`) }))} />
        <EntityPicker kind="person" label={t('gov.transfers.player')} value={f.player} onChange={set('player')} role="athlete" />
        <EntityPicker kind="team" label={t('gov.transfers.from')} value={f.from} onChange={set('from')} sport={s.sport_id} />
        {f.kind === 'release' ? null : <EntityPicker kind="team" label={t('gov.transfers.to')} value={f.to} onChange={set('to')} sport={s.sport_id} />}
        <DateField label={t('gov.transfers.effective')} value={f.effective_on} onChange={set('effective_on')} />
        {loan ? <DateField label={t('gov.transfers.loanEnds')} value={f.loan_ends_on} onChange={set('loan_ends_on')} min={f.effective_on ?? undefined} /> : null}
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Discipline
export function DisciplineTab({ comp, can }) {
  const q = useLoad(() => api.get('/governance/cases', { competition_id: comp.id, limit: 50 }).catch((e) => (e.status === 404 ? { items: [], staff: false } : Promise.reject(e))), [comp.id]);
  const pol = useLoad(() => api.get(`/competitions/${comp.id}/discipline-policy`), [comp.id]);
  const [open, setOpen] = useState(null), [kind, setKind] = useState('all'), [policy, setPolicy] = useState(false);
  const all = q.data?.items ?? [];
  const items = kind === 'all' ? all : all.filter((x) => x.kind === kind);
  const live = all.reduce((n, x) => n + (x.live_sanctions ?? 0), 0);
  const kinds = ['all', 'discipline', 'appeal', 'protest', 'eligibility_dispute', 'waiver', 'licence_issue'];
  const p = pol.data;
  return (
    <View style={{ gap: 10 }}>
      <Row>
        <Metric value={num(live)} label={t('gov.disc.liveSanctions')} tone={live ? c.redSoft : undefined} />
        <Metric value={num(all.filter((x) => ['received', 'under_review', 'interim'].includes(x.status)).length)} label={t('gov.disc.open')} />
        <Metric value={num(all.filter((x) => x.kind === 'appeal' && x.status !== 'closed').length)} label={t('gov.disc.appeals')} />
        <Metric value={num(all.filter((x) => x.needs_review).length)} label={t('gov.disc.flagged')} tone={all.some((x) => x.needs_review) ? c.sunSoft : undefined} />
      </Row>
      {p ? (
        <Card>
          <Row><H2 style={{ flex: 1 }}>{t('gov.disc.policy')}{p.current ? ` · v${p.current.version}` : ''}</H2><Tag label={p.vocabulary.native ? t('gov.disc.native') : t('gov.disc.fallback')} color={p.vocabulary.native ? c.limeSoft : c.sunSoft} />
            {can ? <Btn small title={t('gov.disc.publish')} onPress={() => setPolicy(true)} /> : null}</Row>
          <T size={13} color={c.mute}>{p.vocabulary.caution} · {p.vocabulary.dismissal} · {p.vocabulary.misconduct}</T>
          {p.current ? <T size={13}>{p.current.rules.caution_thresholds.map((x) => t('gov.disc.threshold', { count: x.count, matches: x.suspension_matches })).join(' · ') || t('gov.disc.noThresholds')} · {t('gov.disc.appealWindow', { days: p.current.rules.appeal_window_days })}</T>
            : <T size={13} color={c.mute}>{t('gov.disc.noPolicy')}</T>}
          {!p.vocabulary.native ? <T size={12} color={c.mute}>{p.vocabulary.note}</T> : null}
        </Card>) : null}
      <Seg options={kinds.map((k) => ({ value: k, label: t(`gov.case.${k}`) }))} value={kind} onChange={setKind} />
      {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : !q.data ? <Loading /> : items.length ? items.map((x) => (
        <Card key={x.id} onPress={() => setOpen(x.id)} accessibilityLabel={`${t(`gov.case.${x.kind}`)} ${x.subject_name ?? x.subject_team ?? ''}`}>
          <Row><T weight="700" style={{ flex: 1, minWidth: 140 }}>{x.subject_name ?? x.subject_team}</T><Status s={x.status} />{x.needs_review ? <Tag label={t('gov.disc.needsReview')} color={c.sunSoft} /> : null}</Row>
          <T size={13} color={c.mute}>{t(`gov.case.${x.kind}`)} · {x.category.replace(/_/g, ' ')}{x.auto ? ` · ${t('gov.disc.auto')}` : ''}{x.policy_version ? ` · v${x.policy_version}` : ''}</T>
          {x.appeal_deadline ? <T size={12} color={c.mute}>{t('gov.disc.appealBy', { date: fmtDate(x.appeal_deadline) })}</T> : null}
        </Card>)) : <Empty emoji="⚖️" title={t('gov.disc.emptyTitle')} sub={t('gov.disc.emptySub')} />}
      {open ? <CaseSheet id={open} onClose={() => { setOpen(null); q.reload(); }} /> : null}
      <PolicySheet visible={policy} compId={comp.id} onClose={() => setPolicy(false)} onDone={() => { setPolicy(false); pol.reload(); }} />
    </View>
  );
}

function CaseSheet({ id, onClose }) {
  const q = useLoad(() => api.get(`/governance/cases/${id}`), [id]);
  const act = useDo(() => q.reload());
  const k = q.data;
  return (
    <Sheet visible onClose={onClose} title={k ? t(`gov.case.${k.kind}`) : t('gov.disc.title')} footer={k?.status === 'decided' && k.appeal_open ? <Btn title={t('gov.disc.fileAppeal')} onPress={() => act(() => api.post(`/governance/cases/${id}/appeal`, { grounds: t('gov.disc.appealGrounds') }), t('gov.done'))} /> : null}>
      {!k ? <Loading /> : (
        <View style={{ gap: 12 }}>
          <Row><Status s={k.status} />{k.needs_review ? <Tag label={t('gov.disc.needsReview')} color={c.sunSoft} /> : null}<T weight="700" style={{ flex: 1 }}>{k.subject_name}</T></Row>
          {k.status === 'interim' ? <Banner tone={c.orangeSoft}>{t('gov.disc.interimNote')}</Banner> : null}
          {k.summary ? <T>{k.summary}</T> : null}
          <Section title={t('gov.disc.sanctions')} color={c.mute}>
            {k.sanctions.length ? k.sanctions.map((s) => (
              <Card key={s.id} color={c.bg} style={{ marginBottom: 6 }}>
                <Row><T weight="700" style={{ flex: 1 }}>{t(`gov.sanction.${s.kind}`)}{s.matches ? ` · ${s.matches}` : ''}</T><Status s={s.status} /></Row>
                {s.service ? <T size={13} color={c.mute}>{t('gov.disc.served', { served: s.service.served, total: s.matches })}</T> : null}
                {s.fine_state ? <T size={13} color={c.mute}>{t('gov.transfers.fee')}: {t(`gov.fine.${s.fine_state}`)}</T> : null}
              </Card>)) : <T color={c.mute}>{t('gov.disc.noSanctions')}</T>}
          </Section>
          <Section title={t('gov.history')} color={c.mute}>{k.events.map((e, i) => <T key={i} size={12.5} color={c.mute} style={{ paddingVertical: 2 }}>{fmtDate(e.created_at)} · {t(`gov.event.${e.action}`)}</T>)}</Section>
        </View>)}
    </Sheet>
  );
}

function PolicySheet({ visible, compId, onClose, onDone }) {
  const [f, setF] = useState({ c1: 5, m1: 1, c2: 10, m2: 2, dism: 2, appeal: 3, stay: false, fine: false, points: false });
  const act = useDo();
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Sheet visible={visible} onClose={onClose} title={t('gov.disc.publish')} footer={<Btn title={t('gov.disc.publishGo')} onPress={async () => {
      const r = await act(() => api.post(`/competitions/${compId}/discipline-policy`, { rules: { caution_thresholds: [{ count: f.c1, suspension_matches: f.m1 }, { count: f.c2, suspension_matches: f.m2 }], dismissal: { suspension_matches: f.dism, interim: true }, appeal_window_days: f.appeal, stay_on_appeal: f.stay, fine_authority: f.fine, points_deduction_authority: f.points } }), t('gov.done'));
      if (r) onDone();
    }} />}>
      <View style={{ gap: 12 }}>
        <Counter label={t('gov.disc.cautionsFirst')} value={f.c1} min={1} max={50} onChange={set('c1')} />
        <Counter label={t('gov.disc.matchesFirst')} value={f.m1} min={1} max={20} onChange={set('m1')} />
        <Counter label={t('gov.disc.cautionsSecond')} value={f.c2} min={f.c1 + 1} max={100} onChange={set('c2')} />
        <Counter label={t('gov.disc.matchesSecond')} value={f.m2} min={f.m1} max={30} onChange={set('m2')} />
        <Counter label={t('gov.disc.dismissalMatches')} value={f.dism} min={1} max={30} onChange={set('dism')} />
        <Counter label={t('gov.disc.appealDays')} value={f.appeal} min={0} max={60} onChange={set('appeal')} />
        <SwitchRow label={t('gov.disc.stay')} sub={t('gov.disc.staySub')} value={f.stay} onChange={set('stay')} />
        <SwitchRow label={t('gov.disc.fineAuth')} value={f.fine} onChange={set('fine')} />
        <SwitchRow label={t('gov.disc.pointsAuth')} value={f.points} onChange={set('points')} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Rule pack & archive
export function ArchiveTab({ comp, season: s, can }) {
  const pack = useLoad(() => api.get(`/seasons/${s.id}/rule-pack`), [s.id]);
  const packs = useLoad(() => (can ? api.get(`/competitions/${comp.id}/rule-packs`, { limit: 20 }) : Promise.resolve(null)), [comp.id, can]);
  const arch = useLoad(() => api.get(`/seasons/${s.id}/archive-pack`).catch((e) => (e.status === 404 ? null : Promise.reject(e))), [s.id]);
  const act = useDo(() => { pack.reload(); packs.reload(); arch.reload(); });
  const cur = pack.data?.current;
  const closed = ['completed', 'archived'].includes(s.status);
  return (
    <View style={{ gap: 10 }}>
      <Row>
        <Metric value={cur ? `v${cur.version}` : '—'} label={t('gov.pack.inForce')} sub={cur ? cur.name : t('gov.pack.none')} />
        <Metric value={num(pack.data?.history?.length)} label={t('gov.pack.earlier')} />
        <Metric value={arch.data ? (arch.data.intact ? t('gov.archive.intact') : t('gov.archive.broken')) : t('gov.archive.open')} label={t('gov.archive.status')} tone={arch.data?.intact ? c.limeSoft : undefined} />
      </Row>
      <Card>
        <Row><H2 style={{ flex: 1 }}>{t('gov.pack.title')}</H2>{closed ? <Tag label={t('gov.pack.closed')} color={c.sunSoft} /> : null}</Row>
        {cur ? <>
          <T size={13} color={c.mute}>{cur.name} · {t('gov.pack.hash')} {cur.hash.slice(0, 12)}…{cur.backfilled ? ` · ${t('gov.pack.backfilled')}` : ''}</T>
          <Row style={{ marginTop: 6 }}>{Object.keys(cur.content).filter((k) => !k.endsWith('_version') && k !== 'eligibility_enforcement').map((k) => <Tag key={k} label={t(`gov.pack.part.${k}`)} color={c.cyanSoft} />)}</Row>
        </> : <T color={c.mute}>{t('gov.pack.emptySub')}</T>}
      </Card>
      {packs.data?.items?.length ? <Section title={t('gov.pack.available')} color={c.mute}>{packs.data.items.map((p) => (
        <Card key={p.id} style={{ marginBottom: 6 }}>
          <Row><T weight="700" style={{ flex: 1, minWidth: 140 }}>v{p.version} · {p.name}</T>{cur?.pack_id === p.id ? <Tag label={t('gov.pack.inForce')} color={c.limeSoft} /> : !closed ? <Btn small title={t('gov.pack.pin')} onPress={() => act(() => api.post(`/seasons/${s.id}/rule-pack`, { pack_id: p.id }), t('gov.done'))} /> : null}</Row>
          <T size={12} color={c.mute}>{(p.seasons ?? []).map((x) => x.label).join(', ') || t('gov.pack.unused')}</T>
        </Card>))}</Section> : null}
      <Card>
        <Row><H2 style={{ flex: 1 }}>{t('gov.archive.title')}</H2>{arch.data ? <Tag label={fmtDate(arch.data.sealed_at)} color={c.limeSoft} /> : null}</Row>
        {arch.data ? <T size={13} color={c.mute}>{t('gov.pack.hash')} {arch.data.hash.slice(0, 16)}…</T> : <T color={c.mute}>{closed ? t('gov.archive.readyToSeal') : t('gov.archive.notYet')}</T>}
        {can && closed && !arch.data ? <Btn small title={t('gov.archive.seal')} onPress={() => act(() => api.post(`/seasons/${s.id}/archive-pack`, {}), t('gov.done'))} style={{ marginTop: 8 }} /> : null}
      </Card>
    </View>
  );
}
