// Para rules inside the Event console's Registration tab (#834): rule packs (governed, declarative sport rules locked to the eligibility policy),
// lineup validation with plain-language remediation, override requests and approvals, and the classification-safe eligibility projection.
// Same home as the registration policy (#477): nothing here is a second console. Every rule is decided by the API (REST / OpenAPI / MCP); this
// screen only calls it. One React Native codebase for iOS, iPadOS, Android and web. Only class codes and administrative status are ever shown.
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, ABtn, ACard, AChip, AEmpty, ARow, ASection, AT, ATag } from '../arena';
import { FormSheet } from '../FormSheet';
import { ErrorBox, Loading } from '../ui';
import { MenuField } from '../menu-field';
import { Counter } from '../pickers';
import { t } from '../i18n';
import { useDo } from './console-utils';

const TONE = { pass: A.green, fail: A.red, pending: A.sun, waived: A.violet };
const MARK = { pass: '✓', fail: '✕', pending: '…', waived: '↷' };
const SECTIONS = ['packs', 'lineup', 'overrides', 'entries'];
const dt = (iso) => { try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return String(iso).slice(0, 16); } };
const Row = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{children}</View>;

/** One check line: mark, reason and what to do about it. */
function CheckRow({ k, onOverride }) {
  return (
    <ARow title={`${MARK[k.status] ?? '?'} ${k.reason}`} sub={k.remediation ?? undefined}
      right={<><ATag label={t(`pr.state.${k.status}`)} tone={TONE[k.status] ?? A.mute} />{onOverride && k.status !== 'pass' && k.status !== 'waived' ? <ABtn small tone="ghost" title={t('pr.request_override')} onPress={() => onOverride(k)} /> : null}</>} />
  );
}

/** Rule packs: versions, the one the policy is locked to, and a form that builds a pack from the governed class catalogue. */
function Packs({ id, e, setup, reload, isOrg }) {
  const list = useLoad(() => api.get(`/events/${id}/para/rule-packs`).catch((x) => (x.status === 404 ? { packs: [] } : Promise.reject(x))), [id]);
  const catalogue = useLoad(() => (e.sport_id && isOrg ? api.get('/para/class-versions', { sport_id: e.sport_id, limit: 20 }) : Promise.resolve(null)), [e.sport_id, isOrg]);
  const [open, setOpen] = useState(false);
  const act = useDo(() => { list.reload(); reload?.(); });
  const classes = useMemo(() => [...new Set((catalogue.data?.versions ?? []).flatMap((v) => v.classes.map((k) => k.code)))], [catalogue.data]);
  const packs = list.data?.packs ?? [];
  const lockTo = (p) => act(() => api.post(`/events/${id}/registration/policy`, { enforcement: setup?.policy?.enforcement ?? 'blocking', rules: { ...(setup?.policy?.rules ?? {}), para_pack_id: p.id }, note: t('pr.lock_note', { v: p.version }), expected_version: setup?.policy?.version ?? 0 }), t('pr.locked'));
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (list.loading && !list.data) return <Loading />;
  return (
    <>
      <ASection title={t('pr.packs')} sub={t('pr.packs_sub')} action={isOrg ? t('pr.new_pack') : undefined} onAction={() => setOpen(true)} />
      {!packs.length ? <AEmpty emoji="🧩" title={t('pr.no_pack')} sub={t('pr.no_pack_sub')} action={isOrg ? t('pr.new_pack') : undefined} onAction={() => setOpen(true)} /> : packs.map((p) => {
        const locked = list.data.locked_pack_id === p.id;
        const rules = p.definition.rules ?? [];
        return (
          <ACard key={p.id} tone={locked ? A.violet : undefined}>
            <Row><AT weight="800" style={{ flex: 1 }}>{p.title} · v{p.version}</AT>{locked ? <ATag label={t('pr.locked_tag')} tone={A.violet} /> : null}</Row>
            <AT size={12} color={A.mute}>{p.publisher} · {p.source_ref} · {dt(p.created_at)}</AT>
            <Row>{p.definition.classes.map((k) => <ATag key={k.code} label={k.points != null ? `${k.code} · ${k.points}` : k.code} tone={A.cyan} />)}</Row>
            {rules.map((r) => <AT key={r.id} size={12.5}>{`• ${r.label ?? t(`pr.rule.${r.type}`)}${r.max != null ? ` ≤ ${r.max}` : ''}${r.min != null ? ` ≥ ${r.min}` : ''}${r.role ? ` · ${r.role}` : ''}`}</AT>)}
            {isOrg && !locked ? <ABtn small tone="ghost" title={t('pr.lock_policy')} onPress={() => lockTo(p)} accessibilityLabel={t('pr.lock_policy_a11y', { v: p.version })} /> : null}
          </ACard>
        );
      })}
      {!setup?.policy && packs.length && isOrg ? <AT size={12} color={A.mute}>{t('pr.need_policy')}</AT> : null}
      <FormSheet visible={open} onClose={() => setOpen(false)} title={t('pr.new_pack')} submitLabel={t('pr.publish')}
        fields={[
          { key: 'title', label: t('pr.f.title') }, { key: 'publisher', label: t('pr.f.publisher') }, { key: 'source_ref', label: t('pr.f.source') },
          { key: 'codes', label: t('pr.f.classes'), type: 'multimenu', options: classes.map((c) => ({ value: c, label: c })), hint: classes.length ? undefined : t('pr.no_catalogue') },
          { key: 'points', label: t('pr.f.points'), type: 'switch', default: false },
          { key: 'pts', type: 'custom', default: {}, show: (v) => v.points && (v.codes ?? []).length, render: ({ v, set }) => (
            <View style={{ gap: 8 }}>{(v.codes ?? []).map((k) => <Counter key={k} label={k} value={(v.pts ?? {})[k] ?? 1} min={0} max={20} step={0.5} a11y={k} onChange={(x) => set('pts', { ...(v.pts ?? {}), [k]: x })} />)}</View>) },
          { key: 's1', label: t('pr.f.rules'), type: 'section' },
          { key: 'cap', label: t('pr.f.cap'), type: 'stepper', min: 0, max: 100, step: 0.5, default: 0, show: (v) => v.points },
          { key: 'size_min', label: t('pr.f.size_min'), type: 'stepper', min: 0, max: 50, default: 0 }, { key: 'size_max', label: t('pr.f.size_max'), type: 'stepper', min: 0, max: 50, default: 0 },
          { key: 'same_max', label: t('pr.f.same_max'), type: 'stepper', min: 0, max: 50, default: 0 },
          { key: 'role', label: t('pr.f.role'), optional: true }, { key: 'role_min', label: t('pr.f.role_min'), type: 'stepper', min: 1, max: 20, default: 1, show: (v) => !!v.role },
          { key: 'statuses', label: t('pr.f.statuses'), type: 'multi', default: ['confirmed', 'temporary'], options: [{ value: 'confirmed', label: t('pr.status.confirmed') }, { value: 'temporary', label: t('pr.status.temporary') }] }]}
        onSubmit={async (v) => {
          const codes = v.codes ?? [];
          const rules = [];
          if (v.points && v.cap) rules.push({ id: 'cap', type: 'class_points_cap', max: v.cap });
          if (v.size_min || v.size_max) rules.push({ id: 'size', type: 'composition', ...(v.size_min ? { min: v.size_min } : {}), ...(v.size_max ? { max: v.size_max } : {}) });
          if (v.same_max) rules.push({ id: 'balance', type: 'same_class_max', max: v.same_max });
          if (v.role) rules.push({ id: 'role', type: 'role_required', role: v.role, min: v.role_min ?? 1, scope: 'all' });
          await api.post(`/events/${id}/para/rule-packs`, { title: v.title, publisher: v.publisher, source_ref: v.source_ref, expected_version: packs[0]?.version ?? 0,
            definition: { classes: codes.map((code) => ({ code, ...(v.points ? { points: (v.pts ?? {})[code] ?? 1 } : {}) })), status_required: v.statuses?.length ? v.statuses : ['confirmed', 'temporary'], rules } });
          list.reload(); reload?.(); return t('pr.published');
        }} />
    </>
  );
}

/** Lineup validation for one fixture and team (team manager and organiser): the same decision the lock and kick-off use. */
function Lineup({ id, isOrg, teams }) {
  const fixtures = useLoad(() => api.get('/fixtures', { event_id: id, limit: 100 }), [id]);
  const [fx, setFx] = useState(null);
  const [team, setTeam] = useState(null);
  const [res, setRes] = useState(null);
  const [ask, setAsk] = useState(null);
  const { toast } = useSession();
  const f = (fixtures.data ?? []).find((x) => x.id === fx);
  const mine = new Set((teams ?? []).map((x) => x.team_id));
  const options = f ? [f.home_team_id && { value: f.home_team_id, label: f.home_name }, f.away_team_id && { value: f.away_team_id, label: f.away_name }].filter((x) => x && (isOrg || mine.has(x.value))) : [];
  const run = async (t2 = team, fx2 = fx) => { try { setRes(await api.post(`/fixtures/${fx2}/para/lineup-check`, { team_id: t2 })); } catch (x) { setRes(null); toast(x.status === 409 && x.details?.code === 'no_pack' ? t('pr.no_pack') : '' + x.message); } };
  return (
    <>
      <ASection title={t('pr.lineup')} sub={t('pr.lineup_sub')} />
      <MenuField label={t('pr.fixture')} value={fx} onChange={(v) => { setFx(v); setTeam(null); setRes(null); }} options={(fixtures.data ?? []).map((x) => ({ value: x.id, label: `${x.home_name ?? '—'} – ${x.away_name ?? '—'}`, sub: dt(x.scheduled_at) }))} />
      <MenuField label={t('pr.team')} value={team} onChange={(v) => { setTeam(v); run(v); }} options={options} disabled={!fx} />
      {!fx || !team ? <AEmpty emoji="📋" title={t('pr.pick_lineup')} sub={t('pr.pick_lineup_sub')} /> : !res ? <Loading /> : (
        <>
          <ACard tone={res.valid ? A.green : A.red}>
            <Row><AT weight="800" style={{ flex: 1 }}>{res.valid ? (res.pending ? t('pr.lineup_pending') : t('pr.lineup_valid')) : t('pr.lineup_blocked')}</AT><ATag label={`${res.pack.title} v${res.pack.version}`} tone={A.violet} /></Row>
            <AT size={12} color={A.mute}>{t('pr.audited')}</AT>
          </ACard>
          {res.checks.map((k) => <CheckRow key={k.rule} k={k} onOverride={(c) => setAsk(c)} />)}
          {res.member_checks.filter((k) => k.status !== 'pass').map((k) => <CheckRow key={`${k.user_id}`} k={k} onOverride={(c) => setAsk({ ...c, rule: 'member_class' })} />)}
          <ASection title={t('pr.on_sheet')} />
          {res.members.map((m) => <ARow key={m.user_id} title={m.display_name ?? '—'} sub={`${t(`pr.slot.${m.slot}`)}${m.role ? ` · ${m.role}` : ''}`} right={<ATag label={m.class_code ?? t('pr.unclassified')} tone={m.class_code ? A.cyan : A.red} />} />)}
          <ABtn small tone="ghost" title={t('pr.recheck')} onPress={() => run()} />
        </>
      )}
      <FormSheet visible={!!ask} onClose={() => setAsk(null)} title={t('pr.request_override')} submitLabel={t('pr.send_request')}
        fields={[{ key: 'note', type: 'section', label: ask?.reason ?? '' }, { key: 'reason', label: t('pr.f.reason'), type: 'multiline', hint: t('pr.reason_hint') }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/para/overrides`, { team_id: team, rule_id: ask.rule, fixture_id: fx, reason: v.reason }); return t('pr.requested'); }} />
    </>
  );
}

/** Override requests: managers see their own, organisers decide (never their own request). */
function Overrides({ id, isOrg }) {
  const list = useLoad(() => api.get(`/events/${id}/para/overrides`, { limit: 100 }).catch((x) => (x.status === 404 ? [] : Promise.reject(x))), [id]);
  const [decide, setDecide] = useState(null);
  const act = useDo(list.reload);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (list.loading && !list.data) return <Loading />;
  const rows = list.data ?? [];
  return (
    <>
      <ASection title={t('pr.overrides')} sub={t('pr.overrides_sub')} />
      {!rows.length ? <AEmpty emoji="🕊️" title={t('pr.no_overrides')} sub={t('pr.no_overrides_sub')} /> : rows.map((o) => (
        <ARow key={o.id} title={`${o.team_name} · ${o.rule_id}`} sub={`${dt(o.created_at)}${o.effective_to ? ` · ${t('pr.until', { d: dt(o.effective_to) })}` : ''}`}
          right={<><ATag label={t(`pr.ostatus.${o.status}`)} tone={o.status === 'approved' ? A.green : o.status === 'requested' ? A.sun : A.mute} />
            {isOrg && ['requested', 'approved'].includes(o.status) ? <ABtn small tone="ghost" title={o.status === 'approved' ? t('pr.revoke') : t('pr.decide')} onPress={() => setDecide(o)} /> : null}</>} />
      ))}
      <FormSheet visible={!!decide} onClose={() => setDecide(null)} title={t('pr.decide')} submitLabel={t('pr.save_decision')}
        fields={[
          { key: 'decision', label: t('pr.f.decision'), type: 'chips', default: decide?.status === 'approved' ? 'revoked' : 'approved', options: (decide?.status === 'approved' ? ['revoked'] : ['approved', 'rejected']).map((v) => ({ value: v, label: t(`pr.ostatus.${v}`) })) },
          { key: 'until', label: t('pr.f.until'), type: 'date', optional: true }, { key: 'note', label: t('pr.f.note'), type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/para/overrides/${decide.id}/decision`, { decision: v.decision, note: v.note, ...(v.until ? { effective_to: new Date(`${v.until}T23:59:00`).toISOString() } : {}) }); list.reload(); return t('pr.decided'); }} />
    </>
  );
}

/** The classification-safe projection: class code, administrative status, accepted or not, and why. An athlete sees only their own entry. */
export function ParaEntries({ id, mine }) {
  const proj = useLoad(() => api.get(`/events/${id}/para/eligibility`, { limit: 100 }).catch((x) => (x.status === 404 ? { pack: null, rows: [] } : Promise.reject(x))), [id]);
  if (proj.error) return <ErrorBox error={proj.error} onRetry={proj.reload} />;
  if (proj.loading && !proj.data) return <Loading />;
  const d = proj.data;
  if (!d.pack) return mine ? null : <AEmpty emoji="🧩" title={t('pr.no_pack')} sub={t('pr.no_pack_sub')} />;
  const accepted = d.rows.filter((r) => r.decision === 'accepted').length;
  return (
    <>
      <ASection title={mine ? t('pr.entry_why') : t('pr.entries')} sub={t('pr.privacy')} />
      {!mine ? <Row><ATag label={t('pr.n_accepted', { n: accepted, total: d.rows.length })} tone={A.green} /><ATag label={`${d.pack.title} v${d.pack.version}`} tone={A.violet} /></Row> : null}
      {!d.rows.length ? <AEmpty emoji="🪪" title={t('pr.no_entries')} /> : d.rows.map((r) => (
        <ARow key={r.registration_id} title={r.display_name} sub={`${r.reason}${r.remediation ? ` — ${r.remediation}` : ''}`}
          right={<><ATag label={r.class_code ? `${r.class_code}${r.class_status ? ` · ${t(`pr.status.${r.class_status}`)}` : ''}` : t('pr.unclassified')} tone={A.cyan} /><ATag label={t(`pr.decision.${r.decision}`)} tone={r.decision === 'accepted' ? A.green : r.decision === 'pending' ? A.sun : A.red} /></>} />
      ))}
    </>
  );
}

/** The Para rules section of the Registration tab (organiser), also the manager's lineup tools (teams = their teams). */
export function ParaRules({ id, e, setup, reload, isOrg, teams }) {
  const [section, setSection] = useState('packs');
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
        {SECTIONS.filter((k) => isOrg || k !== 'packs').map((k) => <AChip key={k} label={t(`pr.tab.${k}`)} active={section === k} onPress={() => setSection(k)} />)}
      </ScrollView>
      {section === 'packs' ? <Packs id={id} e={e} setup={setup} reload={reload} isOrg={isOrg} /> : null}
      {section === 'lineup' ? <Lineup id={id} isOrg={isOrg} teams={teams} /> : null}
      {section === 'overrides' ? <Overrides id={id} isOrg={isOrg} /> : null}
      {section === 'entries' ? <ParaEntries id={id} /> : null}
    </>
  );
}
