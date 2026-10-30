// Competition registration inside the Event console (issue #477): the one place to register players for a competition, decide them, keep the rosters
// within their limits, run the registration windows, grant documented exceptions, track suspensions / clearances and read the eligibility of every
// player. Organisers get the full workspace; team managers and players get their own registration state and the actions they may take. Every rule is
// enforced by the API (REST / OpenAPI / MCP), this screen only calls it. One React Native codebase: iOS, iPadOS, Android and web.
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { A, AAvatar, ABar, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStat, AT, ATag, ReasonSheet } from '../arena';
import { FormSheet } from '../FormSheet';
import { ErrorBox, Field, Loading, Sheet } from '../ui';
import { saveFile } from '../contracts-ui';
import { useDo } from './console-utils';

const STATUS = {
  submitted: ['Awaiting review', A.sun], under_review: ['Under review', A.cyan], registered: ['Registered', A.green], rejected: ['Not accepted', A.red],
  withdrawn: ['Withdrawn', A.mute], suspended: ['Suspended', A.orange], expired: ['Expired', A.mute],
};
const DECISION = { eligible: ['Eligible', A.green, '✓'], ineligible: ['Not eligible', A.red, '✕'], pending: ['Pending', A.sun, '…'], unknown: ['Unknown', A.cyan, '?'] };
const CHECK = { pass: ['✓', A.green], fail: ['✕', A.red], pending: ['…', A.sun], unknown: ['?', A.cyan], waived: ['↷', A.violet] };
const LISTS = [['active', 'Active'], ['reserve', 'Reserve'], ['development', 'Development']];
const ORIGINS = [['unclassified', 'Not set'], ['local', 'Local'], ['homegrown', 'Homegrown'], ['foreign', 'Foreign']];
const KINDS = [['licence', 'Licence'], ['transfer', 'Transfer'], ['loan', 'Loan'], ['disciplinary', 'Suspension / discipline'], ['classification', 'Classification']];
const RULE_LABEL = { window: 'Registration window', division_age: 'Age category', licence: 'Licence', transfer: 'Transfer', loan: 'Loan', classification: 'Classification', disciplinary: 'Suspension', contract: 'Contract', roster_limit: 'Roster limit', quota: 'Quota', guardian_consent: 'Guardian consent' };
const SECTIONS = [['queue', 'Queue'], ['rosters', 'Rosters'], ['windows', 'Windows'], ['exceptions', 'Exceptions'], ['holds', 'Clearances'], ['policy', 'Policy'], ['reports', 'Reports']];
const pick = (a) => a.map(([value, label]) => ({ value, label }));
const dt = (iso, tz) => { try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }); } catch { return String(iso).slice(0, 16); } };
const dOnly = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const endOfDay = (d) => new Date(`${d}T23:59:00`).toISOString();
const Tag = ({ s }) => { const [l, col] = STATUS[s] ?? [s, A.violet]; return <ATag label={l} tone={col} />; };
/** The Arena palette is light-on-dark: inside a light sheet it sits on its own dark panel so every heading stays legible. */
const Dark = ({ children }) => <View style={{ backgroundColor: A.bg, borderRadius: 22, padding: 12 }}>{children}</View>;
const Row = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{children}</View>;

/** A plain-language eligibility answer: the decision and each rule with its reason. */
function Verdict({ d }) {
  const [label, col, mark] = DECISION[d.decision] ?? DECISION.unknown;
  return (
    <ACard tone={col} pad={14} style={{ gap: 8 }}>
      <Row><AT size={22} color={col} weight="900">{mark}</AT><AT size={17} weight="900">{label}</AT></Row>
      {d.checks.map((k, n) => { const [m, kc] = CHECK[k.status] ?? CHECK.unknown; return (
        <View key={n} style={{ flexDirection: 'row', gap: 10 }}>
          <AT size={14} weight="900" color={kc} style={{ width: 18 }}>{m}</AT>
          <AT size={13} weight="600" color={k.status === 'pass' ? A.mute : A.ink} style={{ flex: 1 }}>{k.reason}</AT>
        </View>); })}
    </ACard>
  );
}

function RegDetail({ id, reg, isOrg, canAct, onDone, onClose }) {
  const hist = useLoad(() => api.get(`/registrations/${reg.id}/history`), [reg.id, reg.row_version]);
  const elig = useLoad(() => (['registered', 'submitted', 'under_review', 'suspended'].includes(reg.status) ? api.get(`/events/${id}/eligibility`, { team_id: reg.team_id, user_id: reg.user_id }) : Promise.resolve(null)), [reg.id, reg.row_version]);
  const [ask, setAsk] = useState(null);       // reject | suspend | withdraw
  const [form, setForm] = useState(null);     // register | list
  const act = useDo(() => { onDone(); });
  const rv = reg.row_version;
  const review = (action, body = {}) => act(() => api.post(`/registrations/${reg.id}/review`, { action, row_version: rv, ...body }), 'Done');
  const live = ['submitted', 'under_review', 'registered', 'suspended'].includes(reg.status);
  return (
    <View style={{ gap: 12 }}>
      <ACard pad={14} style={{ gap: 10 }}>
        <Row>
          <AAvatar user={{ avatar_emoji: reg.avatar_emoji, avatar_color: reg.avatar_color }} size={44} />
          <View style={{ flex: 1 }}><AT size={17} weight="900">{reg.display_name}</AT><AT size={12.5} color={A.mute}>{reg.team_name}{reg.division_name ? ` · ${reg.division_name}` : ''}</AT></View>
          <Tag s={reg.status} />
        </Row>
        <Row>
          <ATag label={`${reg.roster_list} list`} tone={A.violet} />
          {reg.registration_no ? <ATag label={`No. ${reg.registration_no}`} tone={A.cyan} /> : null}
          {reg.origin_class !== 'unclassified' && isOrg ? <ATag label={reg.origin_class} tone={A.mute} /> : null}
          {['late', 'emergency', 'exception'].includes(reg.window_kind) ? <ATag label={`${reg.window_kind} registration`} tone={A.orange} /> : null}
        </Row>
        {reg.effective_from ? <AT size={12} color={A.mute}>Valid {dOnly(reg.effective_from)}{reg.effective_to ? ` → ${dOnly(reg.effective_to)}` : ''}</AT> : null}
      </ACard>
      {elig.data?.decisions?.[0] ? <><ASection title="Eligibility today" sub="Checked on the server against the competition's current policy" /><Verdict d={elig.data.decisions[0]} /></> : null}
      {isOrg && live ? (
        <Row>
          {reg.status === 'submitted' ? <ABtn small tone="neon" title="Start review" onPress={() => review('start_review')} /> : null}
          {['submitted', 'under_review'].includes(reg.status) ? <ABtn small tone="lime" title="Register" onPress={() => setForm('register')} /> : null}
          {['submitted', 'under_review'].includes(reg.status) ? <ABtn small tone="ghost" title="Not accepted" onPress={() => setAsk('reject')} /> : null}
          {reg.status === 'registered' ? <ABtn small tone="sun" title="Suspend" onPress={() => setAsk('suspend')} /> : null}
          {reg.status === 'suspended' ? <ABtn small tone="lime" title="Reinstate" onPress={() => review('reinstate')} /> : null}
          {['registered', 'suspended'].includes(reg.status) ? <ABtn small tone="ghost" title="Expire" onPress={() => review('expire')} /> : null}
        </Row>
      ) : null}
      {canAct && live ? (
        <Row>
          <ABtn small tone="ghost" title="Move list" onPress={() => setForm('list')} />
          <ABtn small tone="ghost" title="Withdraw" onPress={() => setAsk('withdraw')} />
        </Row>
      ) : null}
      <ASection title="History" sub="Who changed what, and when" />
      {hist.loading ? <Loading /> : (hist.data ?? []).map((h) => (
        <ARow key={h.id} title={h.action.replace(/_/g, ' ')} sub={`${h.actor_name ?? 'System'} · ${dt(h.created_at)}${h.note ? ` · ${h.note}` : ''}`} right={h.to_status ? <Tag s={h.to_status} /> : null} />
      ))}
      <ABtn small tone="ghost" title="Close" onPress={onClose} />

      <ReasonSheet visible={ask === 'reject'} onClose={() => setAsk(null)} title="Not accepted" sub="The reason stays with the organiser; the player is told it was not accepted." presets={['Incomplete details', 'Ineligible for this category', 'Duplicate request']} confirmLabel="Not accepted" tone="live" onConfirm={(r) => review('reject', { reason: r })} />
      <ReasonSheet visible={ask === 'suspend'} onClose={() => setAsk(null)} title="Suspend registration" sub="The slot is kept. Reinstating restores it." presets={['Disciplinary hearing', 'Licence under review', 'Eligibility query']} confirmLabel="Suspend" tone="sun" onConfirm={(r) => review('suspend', { reason: r })} />
      <ReasonSheet visible={ask === 'withdraw'} onClose={() => setAsk(null)} title="Withdraw registration" sub="The place is freed. The history is kept." presets={['Injury', 'Moved away', 'Changed team']} confirmLabel="Withdraw" tone="live" requireReason={false}
        onConfirm={(r) => act(() => api.post(`/registrations/${reg.id}/withdraw`, { row_version: rv, reason: r || undefined }), 'Withdrawn')} />
      <FormSheet visible={form === 'register'} onClose={() => setForm(null)} title="Register player" submitLabel="Register" initial={{ roster_list: reg.roster_list, origin_class: reg.origin_class }}
        fields={[
          { key: 'registration_no', label: 'Registration number', optional: true, hint: 'Where the competition issues numbers' },
          { key: 'roster_list', label: 'Roster list', type: 'chips', options: pick(LISTS) },
          { key: 'origin_class', label: 'Origin (declared by you, never inferred)', type: 'chips', options: pick(ORIGINS), hint: 'Used for foreign / homegrown / local quotas' },
          { key: 'effective_from', label: 'Valid from', type: 'date', optional: true },
          { key: 'effective_to', label: 'Valid until', type: 'date', optional: true }]}
        onSubmit={async (v) => { await api.post(`/registrations/${reg.id}/review`, { action: 'register', row_version: rv, ...v }); onDone(); return 'Registered'; }} />
      <FormSheet visible={form === 'list'} onClose={() => setForm(null)} title="Move to another list" submitLabel="Move" initial={{ roster_list: reg.roster_list }}
        fields={[{ key: 'roster_list', label: 'Roster list', type: 'chips', options: pick(LISTS) }, { key: 'reason', label: 'Reason', optional: true }]}
        onSubmit={async (v) => { await api.post(`/registrations/${reg.id}/list`, { row_version: rv, ...v }); onDone(); return 'List updated'; }} />
    </View>
  );
}

function RegRow({ r, onPress, on }) {
  return <ARow tone={on ? A.violet : undefined} onPress={onPress} left={<AAvatar user={{ avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color }} size={40} />} title={r.display_name}
    sub={`${r.team_name}${r.division_name ? ` · ${r.division_name}` : ''} · ${r.roster_list}`} right={<><Tag s={r.status} />{r.flagged ? <ATag label={r.window_kind} tone={A.orange} /> : null}</>} />;
}

// ---------------------------------------------------------------- organiser sections
function Queue({ id, rosters, isOrg, reload, tablet }) {
  const [filter, setFilter] = useState('awaiting');
  const [team, setTeam] = useState(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const regs = useLoad(() => api.get(`/events/${id}/registrations`, { status: filter === 'all' ? undefined : filter === 'awaiting' ? undefined : filter, team_id: team ?? undefined, q: q.trim() || undefined, limit: 100 }), [id, filter, team, q]);
  const rows = (regs.data ?? []).filter((r) => filter !== 'awaiting' || ['submitted', 'under_review'].includes(r.status));
  const done = () => { regs.reload(); reload(); setSel(null); };
  const current = sel ? rows.find((r) => r.id === sel) ?? null : null;
  const list = (
    <View style={{ gap: 10, flex: tablet ? 1 : undefined }}>
      <Row>{[['awaiting', 'Awaiting'], ['registered', 'Registered'], ['suspended', 'Suspended'], ['all', 'All']].map(([k, l]) => <AChip key={k} label={l} active={filter === k} onPress={() => setFilter(k)} />)}</Row>
      {rosters?.teams?.length > 1 ? <Row><AChip label="All teams" active={!team} onPress={() => setTeam(null)} />{rosters.teams.map((t) => <AChip key={t.team_id} label={t.team_name} active={team === t.team_id} onPress={() => setTeam(t.team_id)} />)}</Row> : null}
      <Field value={q} onChangeText={setQ} placeholder="Search by player or registration number…" accessibilityLabel="Search registrations" />
      {regs.loading && !regs.data ? <Loading /> : regs.error ? <ErrorBox error={regs.error} onRetry={regs.reload} /> : !rows.length
        ? <AEmpty emoji="🪪" title={filter === 'awaiting' ? 'Nothing waiting for review' : 'No registrations here'} sub="Players are registered by their team managers or by themselves, or by you from a team's roster." />
        : rows.map((r) => <RegRow key={r.id} r={r} on={sel === r.id} onPress={() => setSel(r.id)} />)}
    </View>
  );
  if (tablet) return <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>{list}<View style={{ flex: 1 }}>{current ? <RegDetail id={id} reg={current} isOrg canAct onDone={done} onClose={() => setSel(null)} /> : <AEmpty emoji="👈" title="Pick a registration" sub="Review it, see the eligibility reasons and the full history." />}</View></View>;
  return <>{list}<Sheet visible={!!current} onClose={() => setSel(null)} title="Registration">{current ? <Dark><RegDetail id={id} reg={current} isOrg canAct onDone={done} onClose={() => setSel(null)} /></Dark> : null}</Sheet></>;
}

function Rosters({ rosters, tablet, goQueue }) {
  if (!rosters) return <Loading />;
  const L = rosters.limits ?? {}, Q = rosters.quotas ?? {};
  return (
    <>
      {rosters.frozen ? <ACard tone={A.orange}><AT weight="800">🧊 Rosters are frozen{rosters.freeze_at ? ` since ${dt(rosters.freeze_at)}` : ''}</AT><AT size={12.5} color={A.mute}>New registrations and list moves are refused unless a window exception is in force.</AT></ACard>
        : rosters.freeze_at ? <ACard><AT weight="800">🧊 Rosters freeze {dt(rosters.freeze_at)}</AT></ACard> : null}
      {!rosters.teams.length ? <AEmpty emoji="👥" title="No teams yet" sub="Teams appear here once they are accepted into the competition." /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {rosters.teams.map((t) => (
            <View key={t.team_id} style={{ flexBasis: tablet ? '48%' : '100%', flexGrow: 1 }}>
              <ACard tone={t.warnings.length ? A.orange : undefined} onPress={() => goQueue(t.team_id)} style={{ gap: 8 }}>
                <Row><AT size={18}>{t.emoji}</AT><AT size={16} weight="900" style={{ flex: 1 }}>{t.team_name}</AT>{t.awaiting ? <ATag label={`${t.awaiting} awaiting`} tone={A.sun} /> : null}</Row>
                <Row><AT size={26} weight="900" num>{t.total}</AT><AT size={13} color={A.mute}>{L.max_total != null ? `of ${L.max_total} registered` : 'registered'}</AT></Row>
                {L.max_total != null ? <ABar pct={(t.total / Math.max(L.max_total, 1)) * 100} color={t.total >= L.max_total ? A.orange : A.green} /> : null}
                <Row>
                  <ATag label={`Active ${t.active}${L.max_active != null ? `/${L.max_active}` : ''}`} tone={A.violet} />
                  <ATag label={`Reserve ${t.reserve}${L.max_reserve != null ? `/${L.max_reserve}` : ''}`} tone={A.cyan} />
                  <ATag label={`Development ${t.development}${L.max_development != null ? `/${L.max_development}` : ''}`} tone={A.mute} />
                </Row>
                {(Q.max_foreign != null || Q.min_homegrown != null || Q.min_local != null) ? <AT size={12} color={A.mute}>Foreign {t.foreign}{Q.max_foreign != null ? `/${Q.max_foreign}` : ''} · Homegrown {t.homegrown}{Q.min_homegrown != null ? ` (min ${Q.min_homegrown})` : ''} · Local {t.local}{Q.min_local != null ? ` (min ${Q.min_local})` : ''}</AT> : null}
                {t.warnings.map((w) => <AT key={w} size={12.5} weight="800" color={A.orange}>⚠ {w}</AT>)}
              </ACard>
            </View>))}
        </View>)}
    </>
  );
}

function Windows({ id, setup, reload, isOrg }) {
  const [open, setOpen] = useState(false);
  const act = useDo(reload);
  const now = Date.now();
  const state = (w) => (w.retired_at ? ['Retired', A.mute] : w.open_now ? ['Open now', A.green] : new Date(w.opens_at).getTime() > now ? ['Upcoming', A.cyan] : ['Closed', A.red]);
  const ws = setup?.windows ?? [];
  return (
    <>
      <ASection title="Registration windows" sub="Exact boundaries in the timezone they were set in. With no window the competition is open." action={isOrg ? '+ Add window' : undefined} onAction={() => setOpen(true)} />
      {!ws.length ? <AEmpty emoji="🕒" title="Open all the time" sub="Add a window to limit when players can be registered, plus late and emergency windows." action={isOrg ? 'Add a window' : undefined} onAction={() => setOpen(true)} /> : ws.map((w) => {
        const [l, col] = state(w);
        return <ARow key={w.id} title={`${w.label || w.kind[0].toUpperCase() + w.kind.slice(1)} window`} sub={`${dt(w.opens_at, w.timezone)} → ${dt(w.closes_at, w.timezone)} · ${w.timezone.replace(/_/g, ' ')}`}
          right={<><ATag label={l} tone={col} />{isOrg && !w.retired_at ? <ABtn small tone="ghost" title="Retire" onPress={() => act(() => api.post(`/registration/windows/${w.id}/retire`, {}), 'Window retired')} /> : null}</>} />;
      })}
      <ASection title="Divisions" sub="Age categories are explicit birth-date limits you set, never guessed from a profile" action={isOrg ? '+ Add division' : undefined} onAction={() => setOpen('division')} />
      {!(setup?.divisions ?? []).filter((d) => !d.archived_at).length ? <AEmpty emoji="🏷️" title="No divisions" sub="Add divisions or grades if players are registered into categories." /> : setup.divisions.filter((d) => !d.archived_at).map((d) => (
        <ARow key={d.id} title={d.name} sub={[d.grade, d.born_on_or_after ? `born on/after ${dOnly(d.born_on_or_after)}` : null, d.born_on_or_before ? `born on/before ${dOnly(d.born_on_or_before)}` : null].filter(Boolean).join(' · ') || 'Open category'}
          right={isOrg ? <ABtn small tone="ghost" title="Archive" onPress={() => act(() => api.post(`/registration/divisions/${d.id}/archive`, {}), 'Archived')} /> : null} />))}
      <FormSheet visible={open === true} onClose={() => setOpen(false)} title="Add a registration window" submitLabel="Add window" initial={{ kind: 'regular' }}
        fields={[
          { key: 'kind', label: 'Kind', type: 'chips', options: [{ value: 'regular', label: 'Regular' }, { value: 'late', label: 'Late (needs a reason)' }, { value: 'emergency', label: 'Emergency (needs a reason)' }] },
          { key: 'label', label: 'Name', optional: true },
          { key: 'timezone', label: 'Timezone the dates are in', type: 'timezone' },
          { key: 'opens_on', label: 'Opens on', type: 'date' }, { key: 'opens_at_time', label: 'Opens at', type: 'time', optional: true },
          { key: 'closes_on', label: 'Closes on', type: 'date' }, { key: 'closes_at_time', label: 'Closes at', type: 'time', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/registration/windows`, { ...v, label: v.label || undefined }); reload(); return 'Window added'; }} />
      <FormSheet visible={open === 'division'} onClose={() => setOpen(false)} title="Add a division" submitLabel="Add division"
        fields={[{ key: 'name', label: 'Division' }, { key: 'grade', label: 'Grade', optional: true }, { key: 'born_on_or_after', label: 'Born on or after', type: 'date', optional: true, hint: 'The youngest allowed' }, { key: 'born_on_or_before', label: 'Born on or before', type: 'date', optional: true, hint: 'The oldest allowed' }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/registration/divisions`, { ...v, grade: v.grade || undefined }); reload(); return 'Division added'; }} />
    </>
  );
}

function Exceptions({ id, setup }) {
  const list = useLoad(() => api.get(`/events/${id}/registration/exceptions`, { limit: 100 }), [id]);
  const [open, setOpen] = useState(false);
  const act = useDo(list.reload);
  const waivable = setup?.policy?.rules?.waivable ?? [];
  return (
    <>
      <ASection title="Eligibility exceptions" sub="Documented, time-limited, never overwriting the rule or the registration" action={waivable.length ? '+ Grant exception' : undefined} onAction={() => setOpen(true)} />
      {!waivable.length ? <AEmpty emoji="📜" title="No waivable rules" sub="Choose which rules can be waived in the Policy section first. Only those can have exceptions." /> : null}
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !(list.data ?? []).length && waivable.length ? <AEmpty emoji="🕊️" title="No exceptions granted" /> : (list.data ?? []).map((x) => (
        <ARow key={x.id} title={`${x.display_name} · ${RULE_LABEL[x.rule_key] ?? x.rule_key}`} sub={`${x.reason} · until ${dt(x.effective_to)} · granted by ${x.granted_by_name}`}
          right={<><ATag label={x.revoked_at ? 'Revoked' : x.in_force ? 'In force' : 'Ended'} tone={x.in_force ? A.green : A.mute} />{x.in_force ? <ABtn small tone="ghost" title="Revoke" onPress={() => act(() => api.post(`/registration/exceptions/${x.id}/revoke`, { reason: 'Revoked by the organiser' }), 'Revoked')} /> : null}</>} />))}
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Grant an exception" submitLabel="Grant exception"
        fields={[
          { key: 'user_id', label: 'Player', type: 'entity', entityKind: 'person', role: 'athlete' },
          { key: 'rule_key', label: 'Rule to waive', type: 'chips', options: waivable.map((w) => ({ value: w, label: RULE_LABEL[w] ?? w })) },
          { key: 'reason', label: 'Reason', type: 'multiline', hint: 'Kept encrypted; visible to organisers only' },
          { key: 'evidence', label: 'Evidence reference', optional: true, hint: 'A case or document reference' },
          { key: 'until', label: 'Valid until', type: 'date' }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/registration/exceptions`, { user_id: v.user_id, rule_key: v.rule_key, reason: v.reason, evidence: v.evidence || undefined, effective_to: endOfDay(v.until) }); list.reload(); return 'Exception granted'; }} />
    </>
  );
}

function Holds({ id, isOrg }) {
  const [kind, setKind] = useState(null);
  const list = useLoad(() => api.get(`/events/${id}/registration/dependencies`, { kind: kind ?? undefined, limit: 100 }), [id, kind]);
  const [open, setOpen] = useState(false);
  const tone = { clear: A.green, pending: A.sun, blocked: A.red };
  return (
    <>
      <ASection title="Suspensions & clearances" sub="References to licence, transfer, loan, disciplinary and classification records held elsewhere" action={isOrg ? '+ Record' : undefined} onAction={() => setOpen(true)} />
      <Row><AChip label="All" active={!kind} onPress={() => setKind(null)} />{KINDS.map(([k, l]) => <AChip key={k} label={l} active={kind === k} onPress={() => setKind(k)} />)}</Row>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !(list.data ?? []).length ? <AEmpty emoji="🧾" title="Nothing recorded" sub="Record a suspension, a pending transfer or a confirmed licence to make it count in eligibility." /> : list.data.map((x) => (
        <ARow key={x.id} title={`${x.display_name} · ${KINDS.find(([k]) => k === x.kind)?.[1]}`} sub={[x.source_label, x.source_ref, x.valid_until ? `until ${dOnly(x.valid_until)}` : null].filter(Boolean).join(' · ') || 'No reference'} right={<ATag label={x.status} tone={tone[x.status]} />} />))}
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Record a clearance or suspension" submitLabel="Record"
        fields={[
          { key: 'user_id', label: 'Player', type: 'entity', entityKind: 'person', role: 'athlete' },
          { key: 'kind', label: 'What', type: 'chips', options: pick(KINDS) },
          { key: 'status', label: 'State', type: 'chips', options: [{ value: 'clear', label: 'Clear' }, { value: 'pending', label: 'Pending' }, { value: 'blocked', label: 'Blocked / suspended' }] },
          { key: 'valid_from', label: 'From', type: 'date', optional: true }, { key: 'valid_until', label: 'Until', type: 'date', optional: true },
          { key: 'source_label', label: 'Where the record is held', optional: true, hint: 'For example the federation or the disciplinary panel' },
          { key: 'source_ref', label: 'Record reference', optional: true },
          { key: 'note', label: 'Private note', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/registration/dependencies`, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null))); list.reload(); return 'Recorded'; }} />
    </>
  );
}

const LIMIT_FIELDS = [['max_total', 'Maximum players per team'], ['max_active', 'Maximum on the active list'], ['max_reserve', 'Maximum on the reserve list'], ['max_development', 'Maximum on the development list']];
function Policy({ id, setup, reload, isOrg }) {
  const [open, setOpen] = useState(false);
  const p = setup?.policy, r = p?.rules ?? {};
  const act = useDo(reload);
  const initial = useMemo(() => ({
    enforcement: p?.enforcement ?? 'blocking', playing_lists: r.playing_lists ?? ['active', 'reserve'], check_division_age: r.check_division_age ?? true, require_team_affiliation: r.require_team_affiliation ?? true,
    require_guardian_consent: r.require_guardian_consent ?? true, require_contract: r.require_contract ?? false, recheck_at_start: r.recheck_at_start ?? true, required_clearances: r.required_clearances ?? [],
    waivable: r.waivable ?? [], block_on: r.block_on ?? ['ineligible'], ...Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, r.roster?.[k] ?? 0])),
    max_foreign: r.quotas?.max_foreign ?? 0, min_homegrown: r.quotas?.min_homegrown ?? 0, min_local: r.quotas?.min_local ?? 0,
    freeze_date: r.roster?.freeze_at ? r.roster.freeze_at.slice(0, 10) : undefined, freeze_time: r.roster?.freeze_at ? new Date(r.roster.freeze_at).toTimeString().slice(0, 5) : undefined,
  }), [p?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (x) => (x ? x : undefined);
  const line = (k, v) => <Row key={k}><AT size={13} color={A.mute} style={{ flex: 1 }}>{k}</AT><AT size={13} weight="800">{v}</AT></Row>;
  return (
    <>
      <ASection title="Eligibility policy" sub={p ? `Version ${p.version} · each change is a new version; locked matches keep the version they used` : 'No policy yet: eligibility is not enforced'} action={isOrg ? (p ? 'Edit' : 'Create policy') : undefined} onAction={() => setOpen(true)} />
      {!p ? <AEmpty emoji="⚖️" title="No policy published" sub="Publish a policy to set roster limits, quotas, required clearances and how strictly selection and kick-off are checked." action={isOrg ? 'Create policy' : undefined} onAction={() => setOpen(true)} /> : (
        <ACard style={{ gap: 8 }}>
          {line('Enforcement', p.enforcement === 'blocking' ? 'Blocks selection and kick-off' : 'Warns only')}
          {line('Lists that can play', (r.playing_lists ?? []).join(', '))}
          {line('Roster limits', LIMIT_FIELDS.map(([k]) => r.roster?.[k] != null ? `${k.replace('max_', '')} ${r.roster[k]}` : null).filter(Boolean).join(' · ') || 'None')}
          {line('Quotas', [r.quotas?.max_foreign != null ? `max ${r.quotas.max_foreign} foreign` : null, r.quotas?.min_homegrown != null ? `min ${r.quotas.min_homegrown} homegrown` : null, r.quotas?.min_local != null ? `min ${r.quotas.min_local} local` : null].filter(Boolean).join(' · ') || 'None')}
          {line('Required clearances', (r.required_clearances ?? []).join(', ') || 'None')}
          {line('Age category / contract / guardian consent', [r.check_division_age ? 'age' : null, r.require_contract ? 'contract' : null, r.require_guardian_consent ? 'consent' : null].filter(Boolean).join(' · ') || 'Off')}
          {line('Roster freeze', r.roster?.freeze_at ? dt(r.roster.freeze_at) : 'Not set')}
          {line('Rules that can be waived', (r.waivable ?? []).map((w) => RULE_LABEL[w]).join(', ') || 'None')}
          {line('Stops play when', (r.block_on ?? ['ineligible']).join(' / '))}
        </ACard>)}
      {(setup?.versions ?? []).length > 1 ? <><ASection title="Earlier versions" />{setup.versions.slice(1).map((v) => <ARow key={v.id} title={`Version ${v.version}`} sub={`${v.enforcement} · ${dt(v.created_at)}${v.note ? ` · ${v.note}` : ''}`} />)}</> : null}
      <FormSheet visible={open} onClose={() => setOpen(false)} title={p ? 'New policy version' : 'Create the eligibility policy'} submitLabel="Publish" initial={initial}
        fields={[
          { key: 'enforcement', label: 'How strictly', type: 'choice', options: [{ value: 'blocking', label: 'Block' }, { value: 'advisory', label: 'Warn only' }] },
          { key: 'block_on', label: 'Stop selection and kick-off when a player is', type: 'multi', options: [{ value: 'ineligible', label: 'Not eligible' }, { value: 'pending', label: 'Pending' }, { value: 'unknown', label: 'Unknown' }] },
          { key: 'playing_lists', label: 'Lists whose players can play', type: 'multi', options: pick(LISTS) },
          { key: 's1', label: 'Roster limits (0 = no limit)', type: 'section' },
          ...LIMIT_FIELDS.map(([k, label]) => ({ key: k, label, type: 'stepper', min: 0, max: 500 })),
          { key: 'freeze_date', label: 'Freeze rosters on', type: 'date', optional: true }, { key: 'freeze_time', label: 'Freeze at', type: 'time', optional: true },
          { key: 's2', label: 'Quotas (0 = none)', type: 'section' },
          { key: 'max_foreign', label: 'Maximum foreign players', type: 'stepper', min: 0, max: 100 },
          { key: 'min_homegrown', label: 'Minimum homegrown players', type: 'stepper', min: 0, max: 100 }, { key: 'min_local', label: 'Minimum local players', type: 'stepper', min: 0, max: 100 },
          { key: 's3', label: 'Checks', type: 'section' },
          { key: 'check_division_age', label: 'Check the birth-date category', type: 'switch' }, { key: 'require_team_affiliation', label: 'Must be an active member of the team', type: 'switch' },
          { key: 'require_guardian_consent', label: 'Young people need guardian consent', type: 'switch' }, { key: 'require_contract', label: 'Must hold an active player contract', type: 'switch' },
          { key: 'recheck_at_start', label: 'Check again at kick-off', type: 'switch' },
          { key: 'required_clearances', label: 'Must hold a clear', type: 'multi', optional: true, options: [{ value: 'licence', label: 'Licence' }, { value: 'classification', label: 'Classification' }] },
          { key: 'waivable', label: 'Rules an exception may waive', type: 'multi', optional: true, options: Object.entries(RULE_LABEL).map(([value, label]) => ({ value, label })) },
          { key: 'note', label: 'What changed', optional: true }]}
        onSubmit={async (v) => {
          const roster = Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, n(v[k])]).filter(([, x]) => x != null));
          if (v.freeze_date) roster.freeze_at = new Date(`${v.freeze_date}T${v.freeze_time || '00:00'}:00`).toISOString();
          const quotas = Object.fromEntries(['max_foreign', 'min_homegrown', 'min_local'].map((k) => [k, n(v[k])]).filter(([, x]) => x != null));
          await api.post(`/events/${id}/registration/policy`, { enforcement: v.enforcement, note: v.note || undefined, expected_version: p?.version ?? 0,
            rules: { playing_lists: v.playing_lists, check_division_age: v.check_division_age, require_team_affiliation: v.require_team_affiliation, require_guardian_consent: v.require_guardian_consent, require_contract: v.require_contract,
              recheck_at_start: v.recheck_at_start, required_clearances: v.required_clearances ?? [], waivable: v.waivable ?? [], block_on: v.block_on, roster, quotas } });
          reload(); return 'Policy published';
        }} />
    </>
  );
}

function Reports({ id }) {
  const rep = useLoad(() => api.get(`/events/${id}/registration/report`), [id]);
  const { toast } = useSession();
  if (rep.loading && !rep.data) return <Loading />;
  if (rep.error) return <ErrorBox error={rep.error} onRetry={rep.reload} />;
  const d = rep.data;
  const exportCsv = async () => { try { const f = await api.get(`/events/${id}/registration/report`, { format: 'csv' }); const how = await saveFile(f.filename, f.csv); toast(how === 'cancelled' ? 'Cancelled' : `${f.rows} registrations exported. This download is logged.`); } catch (x) { toast('' + x.message); } };
  return (
    <>
      <ASection title="Registration report" sub="The same numbers every time for the same data" />
      <Row>{d.totals.map((t) => <AStat key={t.status} value={t.n} label={STATUS[t.status]?.[0] ?? t.status} />)}</Row>
      <ABtn tone="neon" title="Export registrations (CSV)" onPress={exportCsv} />
      <ASection title="Roster compliance" />
      {d.rosters.teams.map((t) => <ARow key={t.team_id} title={t.team_name} sub={`${t.total} registered · ${t.awaiting} awaiting · ${t.suspended} suspended`} right={t.warnings.length ? <ATag label={t.warnings[0]} tone={A.orange} /> : <ATag label="Compliant" tone={A.green} />} />)}
      {d.exceptions_in_force.length || d.open_dependencies.length ? <ASection title="Open items" /> : null}
      {d.exceptions_in_force.map((x) => <ARow key={x.rule_key} title={`${x.n} exception${x.n === 1 ? '' : 's'} in force`} sub={RULE_LABEL[x.rule_key] ?? x.rule_key} />)}
      {d.open_dependencies.map((x) => <ARow key={`${x.kind}${x.status}`} title={`${x.n} ${x.kind} ${x.status}`} sub="Open clearance dependencies" />)}
    </>
  );
}

// ---------------------------------------------------------------- team managers and players
function Mine({ id, e, rosters, reload }) {
  const { user } = useSession();
  const regs = useLoad(() => api.get(`/events/${id}/registrations`, { limit: 100 }), [id]);
  const [sel, setSel] = useState(null);
  const [open, setOpen] = useState(false);
  const teams = rosters?.teams ?? [];
  const entrants = (e.entrants ?? []).filter((x) => x.team_id);
  const rows = regs.data ?? [];
  const done = () => { regs.reload(); reload(); setSel(null); };
  const current = rows.find((r) => r.id === sel) ?? null;
  const manages = teams.length > 0;
  return (
    <>
      <ASection title={manages ? 'Your registrations' : 'My registration'} sub={manages ? 'Register players and keep your roster in order' : 'Where you stand in this competition'} action="+ Register" onAction={() => setOpen(true)} />
      {rosters?.frozen ? <ACard tone={A.orange}><AT weight="800">🧊 Rosters are frozen</AT><AT size={12.5} color={A.mute}>Contact the organiser to register a player now.</AT></ACard> : null}
      {regs.loading && !regs.data ? <Loading /> : regs.error ? <ErrorBox error={regs.error} onRetry={regs.reload} /> : !rows.length ? <AEmpty emoji="🪪" title="No registrations yet" sub={manages ? 'Register your players so they can be selected for matches.' : 'Register with your team to be selectable for matches.'} action="Register" onAction={() => setOpen(true)} /> : rows.map((r) => <RegRow key={r.id} r={r} on={sel === r.id} onPress={() => setSel(r.id)} />)}
      <Sheet visible={!!current} onClose={() => setSel(null)} title="Registration">{current ? <Dark><RegDetail id={id} reg={current} isOrg={false} canAct={manages || current.user_id === user?.id} onDone={done} onClose={() => setSel(null)} /></Dark> : null}</Sheet>
      <RegisterForm id={id} open={open} onClose={() => setOpen(false)} teams={manages ? teams : entrants.map((x) => ({ team_id: x.team_id, team_name: x.name }))} self={!manages} onDone={done} />
    </>
  );
}

function RegisterForm({ id, open, onClose, teams, self, staff, onDone }) {
  const [team, setTeam] = useState(null);
  const chosen = team ?? (teams.length === 1 ? teams[0].team_id : null);
  // managers pick from their own team's active members; the organiser searches everyone (the server checks membership either way)
  const members = useLoad(() => (chosen && !self && !staff ? api.get(`/teams/${chosen}/roster`) : Promise.resolve(null)), [chosen, self, staff]);
  const setup = useLoad(() => (open ? api.get(`/events/${id}/registration/setup`).catch(() => null) : Promise.resolve(null)), [id, open]);
  const opts = staff ? undefined : (members.data?.members ?? []).filter((m) => m.status === 'active' && m.team_role !== 'coach').map((m) => ({ id: m.id, label: m.display_name, sub: m.position ?? '', emoji: m.avatar_emoji, color: m.avatar_color }));
  const ds = (setup.data?.divisions ?? []).filter((d) => !d.archived_at);
  const close = () => { setTeam(null); onClose(); };
  if (open && !chosen) {
    return (
      <Sheet visible onClose={close} title={self ? 'Register with which team?' : 'Which team?'}>
        <View style={{ gap: 8 }}>{teams.length ? teams.map((t) => <ARow key={t.team_id} title={t.team_name} onPress={() => setTeam(t.team_id)} />) : <AEmpty emoji="👥" title="No team to register with" sub="Teams appear here once they are entered in the competition." />}</View>
      </Sheet>
    );
  }
  return (
    <FormSheet visible={open} onClose={close} title={self ? 'Register with your team' : 'Register a player'} submitLabel="Submit registration" initial={{ roster_list: 'active' }}
      fields={[
        ...(self ? [] : [{ key: 'user_id', label: 'Player', type: 'entity', entityKind: 'person', noun: 'player', role: 'athlete', options: opts }]),
        ...(ds.length ? [{ key: 'division_id', label: 'Division', type: 'chips', optional: true, options: ds.map((d) => ({ value: d.id, label: d.name })) }] : []),
        { key: 'roster_list', label: 'Roster list', type: 'chips', options: pick(LISTS) },
        { key: 'reason', label: 'Reason', optional: true, hint: 'Needed for a late or emergency registration' }]}
      onSubmit={async (v) => { await api.post(`/events/${id}/registrations`, { team_id: chosen, user_id: self ? undefined : v.user_id, division_id: v.division_id || undefined, roster_list: v.roster_list, reason: v.reason || undefined }); onDone(); setTeam(null); return 'Registration submitted'; }} />
  );
}

// ---------------------------------------------------------------- the tab
/** The registration programmes (forms, fees, waivers, capacity) of this event live in the universal registration engine; this is the way in from the event console. */
function Programmes({ id }) {
  const { push } = useNav();
  const list = useLoad(() => api.get('/registration-programmes', { scope: 'managed', event_id: id, limit: 20 }).catch(() => []), [id]);
  return (
    <>
      <ASection title="Registration forms and fees" sub="Questions, waivers, fees, capacity and waiting list for this event" />
      {(list.data ?? []).map((p) => <ARow key={p.id} title={p.title} sub={`${p.kind_label} · ${p.status}`} onPress={() => push('RegistrationManage', { id: p.id })} />)}
      <ABtn tone="neon" title={list.data?.length ? 'Add another registration form' : 'Set up registration forms'} onPress={() => push('RegistrationSetup', { kind: 'competition', event_id: id })} />
    </>
  );
}

export function RegistrationTab({ id, e, isOrg, reload }) {
  const { tablet } = useLayout();
  const [section, setSection] = useState('queue');
  const setup = useLoad(() => api.get(`/events/${id}/registration/setup`).catch((x) => (x.status === 404 ? { none: true } : Promise.reject(x))), [id]);
  const rosters = useLoad(() => api.get(`/events/${id}/rosters`).catch((x) => (x.status === 404 ? null : Promise.reject(x))), [id]);
  const [reg, setReg] = useState(false);
  const refresh = () => { setup.reload(); rosters.reload(); reload?.(); };
  if (setup.error) return <ErrorBox error={setup.error} onRetry={setup.reload} />;
  if (setup.loading && !setup.data) return <Loading />;
  const S = setup.data?.none ? null : setup.data;
  const awaiting = (rosters.data?.teams ?? []).reduce((a, t) => a + t.awaiting, 0);
  const registered = (rosters.data?.teams ?? []).reduce((a, t) => a + t.total, 0);
  const open = (S?.windows ?? []).some((w) => w.open_now);

  if (!isOrg) return <Mine id={id} e={e} rosters={rosters.data} reload={refresh} />;
  return (
    <>
      <Programmes id={id} />
      <Row>
        <AStat icon="⏳" value={awaiting} label="Awaiting" tone={awaiting ? A.sun : undefined} />
        <AStat icon="✅" value={registered} label="Registered" />
        <AStat icon="🕒" value={S?.windows?.length ? (open ? 'Open' : 'Closed') : 'Open'} label="Window" />
        <AStat icon="⚖️" value={S?.policy ? `v${S.policy.version}` : '—'} label="Policy" />
      </Row>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
        {SECTIONS.map(([k, l]) => <AChip key={k} label={l} active={section === k} onPress={() => setSection(k)} badge={k === 'queue' && awaiting ? awaiting : undefined} />)}
      </ScrollView>
      <ABtn small tone="neon" title="+ Register a player" onPress={() => setReg(true)} style={{ alignSelf: 'flex-start' }} />
      {section === 'queue' ? <Queue id={id} rosters={rosters.data} isOrg reload={refresh} tablet={tablet} /> : null}
      {section === 'rosters' ? <Rosters rosters={rosters.data} tablet={tablet} goQueue={() => setSection('queue')} /> : null}
      {section === 'windows' ? <Windows id={id} setup={S} reload={refresh} isOrg /> : null}
      {section === 'exceptions' ? <Exceptions id={id} setup={S} /> : null}
      {section === 'holds' ? <Holds id={id} isOrg /> : null}
      {section === 'policy' ? <Policy id={id} setup={S} reload={refresh} isOrg /> : null}
      {section === 'reports' ? <Reports id={id} /> : null}
      <RegisterForm id={id} open={reg} onClose={() => setReg(false)} teams={(e.entrants ?? []).filter((x) => x.team_id).map((x) => ({ team_id: x.team_id, team_name: x.name }))} self={false} staff onDone={refresh} />
    </>
  );
}
