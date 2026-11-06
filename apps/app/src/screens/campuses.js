// Campuses (#781): the academy group's hierarchy — region > campus > sport department — with consolidated and per-campus views, branch roles,
// inherited policies, transfers and an audit trail. It lives inside the organisation workspace (Org tab "Campuses") and only calls the
// campus capabilities (/organisations/:id/campuses, /units, /unit-moves ...): the server decides what each role may see and do; this screen
// only hides what a role cannot use. Same shell as the Academy module: a sidebar of sections on tablet/desktop, a row of tabs on a phone.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Seg, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { useLayout } from '../layout';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../menu-field';
import { DateField } from '../pickers';
import { CountryPicker } from '../country-picker';
import { Bars, Block, Kpi, ModuleNav, Split, when } from './academy-ui';
import { t } from '../i18n';
import { TransfersHub, TransferDetail, TransferWizard, ProcessDesigner, PlaceSheet } from './campus-transfers';
import { useSports } from '../sportpicker';

const KIND_ICON = { region: '🌍', campus: '🏫', department: '🏅' };
const TYPES = ['venue', 'team', 'cohort', 'programme', 'enrolment', 'staff', 'supplier', 'organisation'];
const ROLES = ['director', 'sports_lead', 'coach', 'operations', 'finance', 'auditor'];
const POLICY_KEYS = ['currency', 'timezone', 'attendance_min_pct', 'coach_athlete_ratio_max', 'refund_window_days', 'late_fee_grace_days', 'guardian_consent_renewal_months', 'youth_pickup_required', 'report_cadence'];
const today = () => new Date().toISOString().slice(0, 10);
const WIZARD_ZONES = ['Europe/Madrid', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Istanbul', 'Africa/Cairo', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Colombo', 'Asia/Dhaka', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Tokyo', 'Asia/Shanghai', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'America/Mexico_City', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'];
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null));
const Panel = ({ children, style }) => <View style={[{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }, style]}>{children}</View>;
const statusTag = (u) => (u.status === 'active' ? (u.is_default ? <Tag label={t('campus.status.default')} /> : null) : <Tag label={t(`campus.status.${u.status}`)} color={u.status === 'suspended' ? c.sunSoft : c.violetSoft} />);
const pct = (v) => (v == null ? t('campus.kpi.none') : `${v}%`);
const policyText = (key, v) => {
  if (v === undefined || v === null) return t('campus.pol.unset');
  if (key === 'refund_window_days' || key === 'late_fee_grace_days') return t('campus.pol.days', { n: v });
  if (key === 'guardian_consent_renewal_months') return t('campus.pol.months', { n: v });
  if (key === 'attendance_min_pct') return `${v}%`;
  if (key === 'youth_pickup_required') return v ? t('campus.pol.yes') : t('campus.pol.no');
  if (key === 'report_cadence') return t(`campus.pol.${v}`);
  return String(v);
};
const eventText = (e) => {
  const d = e.detail ?? {};
  return t(`campus.ev.${e.action}`, { kind: d.kind ? t(`campus.kind.${d.kind}`).toLowerCase() : '', name: d.name ?? '', count: d.count ?? '', role: d.role ? t(`campus.role.${d.role}`).toLowerCase() : '', key: d.key ? t(`campus.pol.${d.key}`).toLowerCase() : '' });
};

export function Campuses({ o, role, archived, toast, go }) {
  const staff = role === 'owner' || role === 'admin';
  const { tablet } = useLayout();
  const [sec, setSec] = useState('overview');
  const [f, setF] = useState({});
  const [open, setOpen] = useState(null);   // { kind: 'unit' | 'transfer', id }
  const openId = open?.id ?? null, setOpenId = (idv) => setOpen(idv ? { kind: 'unit', id: idv } : null);
  const [sheet, setSheet] = useState(null);   // { type: 'adopt' } | { type: 'unit', kind, parent_id?, edit? } | { type: 'move', to?, object_type?, ids? }
  const q = useMemo(() => clean({ region_id: f.region_id, country: f.country, sport: f.sport, as_of: f.as_of }), [f]);
  const ov = useLoad(() => api.get(`/organisations/${o.id}/campuses`, q), [o.id, JSON.stringify(q)]);
  const changes = useLoad(() => (sec === 'moves' ? api.get(`/organisations/${o.id}/unit-changes`, { limit: 50 }) : Promise.resolve(null)), [o.id, sec]);
  const audit = useLoad(() => (sec === 'audit' ? api.get(`/organisations/${o.id}/campus-audit`, { limit: 60 }).catch(() => []) : Promise.resolve(null)), [o.id, sec]);
  const refresh = () => { ov.reload(); changes.reload(); audit.reload(); };

  if (ov.error) return <ErrorBox error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <Loading />;
  const d = ov.data, units = d.units;
  const canAudit = staff || d.scope.roles.some((r) => ['director', 'auditor'].includes(r));
  const items = [{ key: 'overview', label: t('campus.sec.overview'), icon: '📊' }, { key: 'structure', label: t('campus.sec.structure'), icon: '🧭' }, ...(true ? [{ key: 'moves', label: t('campus.sec.moves'), icon: '🔁' }] : []), ...(canAudit ? [{ key: 'audit', label: t('campus.sec.audit'), icon: '🧾' }] : [])];
  const P = { o, d, staff, archived, toast, f, setF, setSheet, setSec, openUnit: setOpenId, openTransfer: (idv) => setOpen({ kind: 'transfer', id: idv }), refresh, tablet };
  const empty = !d.setup_done;
  const body = empty && sec !== 'structure' ? <SetupHero {...P} /> : sec === 'overview' ? <Overview {...P} /> : sec === 'structure' ? <Structure {...P} /> : sec === 'moves' ? <TransfersHub {...P} changes={changes} /> : <Audit {...P} audit={audit} />;
  return (
    <View style={{ flexDirection: tablet ? 'row' : 'column', gap: tablet ? 20 : 0, marginTop: 10, alignItems: 'flex-start' }}>
      <ModuleNav items={items} value={sec} onChange={setSec} />
      <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', minWidth: 0, marginTop: tablet ? 0 : 12, gap: 14 }}>
        <Split open={!!open} onClose={() => setOpen(null)} detailTitle={open?.kind === 'transfer' ? t('campus.tr.title') : units.find((u) => u.id === openId)?.name ?? ''} list={body} detail={open ? (open.kind === 'transfer' ? <TransferDetail key={open.id} o={o} id={open.id} toast={toast} onChanged={refresh} /> : <UnitPanel key={openId} {...P} unitId={openId} />) : null} />
      </View>
      {sheet?.type === 'adopt' ? <CampusSetupWizard o={o} toast={toast} refresh={refresh} setSec={setSec} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'unit' ? <UnitForm {...P} spec={sheet} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'move' ? <PlaceSheet {...P} spec={sheet} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'transfer' ? <TransferWizard {...P} spec={sheet} onClose={() => setSheet(null)} onDone={() => { setSheet(null); refresh(); setSec('moves'); }} /> : null}
      {sheet?.type === 'designer' ? <ProcessDesigner {...P} onClose={() => setSheet(null)} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ first run
function SetupHero({ staff, setSheet, setSec, d }) {
  return (
    <Panel style={{ padding: 22, gap: 16 }}>
      <T size={40}>🏛️</T>
      <View style={{ gap: 6 }}>
        <T size={22} weight="900">{t('campus.setup.title')}</T>
        <T color={c.mute}>{t('campus.setup.body')}</T>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(['region', 'campus', 'department']).map((k) => <Tag key={k} label={`${KIND_ICON[k]} ${t(`campus.kind.${k}`)}`} />)}
      </View>
      {staff ? (
        <View style={{ gap: 8 }}>
          <Btn title={t('campus.setup.cta')} onPress={() => setSheet({ type: 'adopt' })} />
          <Btn title={t('campus.setup.scratch')} color={c.paper} ink={c.ink} onPress={() => setSec('structure')} />
        </View>
      ) : <Empty emoji="🔒" title={d.organisation.name} />}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ overview
function Overview({ d, f, setF, openUnit, tablet }) {
  const campuses = d.units.filter((u) => u.kind === 'campus' && !u.context_only);
  const rows = d.units.filter((u) => !u.context_only && u.kind !== 'department' && u.metrics);
  const T0 = d.totals;
  const opt = (list) => [{ value: '', label: t('campus.f.all') }, ...list];
  const filtered = f.region_id || f.country || f.sport || f.as_of;
  const cur = T0.money ?? [];
  return (
    <View style={{ gap: 14 }}>
      <Panel style={{ backgroundColor: c.violetSoft }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <T size={18}>{d.scope.all ? '🌐' : '🔒'}</T>
          <T weight="800" style={{ flex: 1 }}>{d.scope.all ? t('campus.scope.all') : t('campus.scope.partial', { names: d.units.filter((u) => !u.context_only && u.my_roles.length && !d.units.some((p) => p.id === u.parent_id && !p.context_only)).map((u) => u.name).join(', ') })}</T>
          {d.scope.roles.map((r) => <Tag key={r} label={t(`campus.role.${r}`)} color={c.paper} />)}
        </View>
        {!d.scope.all ? <T size={12} color={c.mute}>{t('campus.scope.partial_note')}</T> : null}
      </Panel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Kpi label={t('campus.kpi.campuses')} value={campuses.length} sub={t('campus.kpi.depts', { n: d.units.filter((u) => u.kind === 'department' && !u.context_only).length })} />
        <Kpi label={t('campus.kpi.athletes')} value={T0.athletes} sub={d.unassigned?.athletes ? t('campus.kpi.unassigned', { n: d.unassigned.athletes }) : t('campus.kpi.live_programmes', { n: T0.programmes })} tone={d.unassigned?.athletes ? 'alert' : undefined} />
        <Kpi label={t('campus.kpi.coaches')} value={T0.coaches} sub={T0.athletes_per_coach ? t('campus.kpi.per_coach', { n: T0.athletes_per_coach }) : undefined} />
        <Kpi label={t('campus.kpi.venues')} value={T0.venues} sub={t('campus.kpi.teams', { n: T0.teams })} />
        <Kpi label={t('campus.kpi.attendance')} value={pct(T0.attendance_pct)} sub={t('campus.kpi.30d')} />
        <Kpi label={t('campus.kpi.fill')} value={pct(T0.fill_pct)} sub={T0.capacity ? t('campus.kpi.capacity', { n: T0.capacity }) : undefined} />
        {cur.map((m) => <Kpi key={m.currency} label={t('campus.kpi.outstanding', { currency: m.currency })} value={moneyIn(m.outstanding_minor, m.currency)} sub={m.overdue_minor ? t('campus.kpi.overdue', { amount: moneyIn(m.overdue_minor, m.currency) }) : undefined} tone={m.overdue_minor ? 'alert' : undefined} />)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {d.regions.length ? <View style={{ flex: 1, minWidth: tablet ? 150 : 140 }}><MenuField label={t('campus.f.region')} value={f.region_id ?? ''} onChange={(v) => setF({ ...f, region_id: v || undefined })} options={opt(d.regions.map((r) => ({ value: r.id, label: r.name })))} /></View> : null}
        {d.countries.length ? <View style={{ flex: 1, minWidth: tablet ? 150 : 140 }}><MenuField label={t('campus.f.country')} value={f.country ?? ''} onChange={(v) => setF({ ...f, country: v || undefined })} options={opt(d.countries.map((x) => ({ value: x, label: x })))} /></View> : null}
        {d.sports.length ? <View style={{ flex: 1, minWidth: tablet ? 150 : 140 }}><MenuField label={t('campus.f.sport')} value={f.sport ?? ''} onChange={(v) => setF({ ...f, sport: v || undefined })} options={opt(d.sports.map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) })))} /></View> : null}
        <View style={{ flex: 1, minWidth: tablet ? 150 : 140 }}><DateField label={t('campus.f.asof')} value={f.as_of} onChange={(v) => setF({ ...f, as_of: v })} optional max={today()} /></View>
      </View>
      {filtered ? <Btn small title={t('campus.f.clear')} color={c.paper} ink={c.ink} onPress={() => setF({})} style={{ alignSelf: 'flex-start' }} /> : null}
      <Panel>
        <Block title={t('campus.cmp.title')}>
          {rows.length ? (
            <View style={{ gap: 12 }}>
              <Bars label={t('campus.cmp.athletes')} rows={rows.filter((u) => u.kind === 'campus').map((u) => ({ label: u.name, value: u.metrics.athletes, text: String(u.metrics.athletes) }))} />
              {tablet ? <HeadRow /> : null}
              {rows.map((u) => <CompareRow key={u.id} u={u} d={d} tablet={tablet} onPress={() => openUnit(u.id)} />)}
            </View>
          ) : <Empty emoji="🔎" title={t('campus.cmp.empty')} />}
          <T size={12} color={c.mute}>{t('campus.cmp.note')}</T>
        </Block>
      </Panel>
    </View>
  );
}
const COLS = [['athletes', 'campus.cmp.athletes'], ['coaches', 'campus.cmp.coaches'], ['venues', 'campus.cmp.venues'], ['programmes', 'campus.cmp.programmes'], ['fill_pct', 'campus.cmp.fill'], ['attendance_pct', 'campus.cmp.attendance']];
const HeadRow = () => (
  <View style={{ flexDirection: 'row', paddingHorizontal: 10, gap: 8 }}>
    <T size={11} weight="800" color={c.mute} style={{ flex: 2.2 }}>{t('campus.kpi.campuses').toUpperCase()}</T>
    {COLS.map(([k, label]) => <T key={k} size={11} weight="800" color={c.mute} style={{ flex: 1, textAlign: 'right' }}>{t(label).toUpperCase()}</T>)}
    <T size={11} weight="800" color={c.mute} style={{ flex: 1.3, textAlign: 'right' }}>{t('campus.cmp.overdue').toUpperCase()}</T>
  </View>
);
function CompareRow({ u, d, tablet, onPress }) {
  const m = u.metrics, region = d.units.find((x) => x.id === u.parent_id);
  const over = (m.money ?? []).filter((x) => x.overdue_minor).map((x) => moneyIn(x.overdue_minor, x.currency)).join(' · ') || t('campus.kpi.none');
  const val = (k) => (k.endsWith('pct') ? pct(m[k]) : m[k]);
  const name = (
    <View style={{ flex: tablet ? 2.2 : undefined, gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><T>{KIND_ICON[u.kind]}</T><T weight="800">{u.name}</T>{statusTag(u)}</View>
      <T size={12} color={c.mute}>{region ? `${region.name} · ` : ''}{u.city ?? u.country ?? t(`campus.kind.${u.kind}`)} · {t('campus.cmp.source', { name: u.name })}</T>
    </View>
  );
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={t('campus.a11y.open', { name: u.name })} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 8, minHeight: 44 }}>
      {tablet ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {name}
          {COLS.map(([k]) => <T key={k} weight="700" style={{ flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }}>{val(k)}</T>)}
          <T weight="700" size={13} color={over === t('campus.kpi.none') ? c.mute : c.orange} style={{ flex: 1.3, textAlign: 'right' }}>{over}</T>
        </View>
      ) : (
        <>
          {name}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
            {COLS.map(([k, label]) => <View key={k} style={{ minWidth: 70 }}><T size={11} color={c.mute}>{t(label)}</T><T weight="800">{val(k)}</T></View>)}
            <View style={{ minWidth: 70 }}><T size={11} color={c.mute}>{t('campus.cmp.overdue')}</T><T weight="800" color={over === t('campus.kpi.none') ? c.ink : c.orange}>{over}</T></View>
          </View>
        </>
      )}
    </Pressable>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ structure
function Structure({ d, staff, setSheet, openUnit }) {
  const kids = (id) => d.units.filter((u) => u.parent_id === id);
  const shownIds = new Set(d.units.map((u) => u.id));
  const roots = d.units.filter((u) => !u.parent_id || !shownIds.has(u.parent_id));
  const Node = ({ u, depth }) => (
    <View style={{ gap: 6 }}>
      <Pressable onPress={() => (u.context_only ? null : openUnit(u.id))} accessibilityRole="button" accessibilityLabel={t('campus.a11y.unit', { kind: t(`campus.kind.${u.kind}`), name: u.name, status: t(`campus.status.${u.status}`) })}
        style={{ marginLeft: depth * 18, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, minHeight: 52, borderRadius: 14, backgroundColor: u.context_only ? 'transparent' : c.bg, borderWidth: u.context_only ? 1 : 0, borderColor: c.line, borderStyle: 'dashed' }}>
        <T size={20}>{KIND_ICON[u.kind]}</T>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><T weight="800">{u.name}</T>{u.code ? <Tag label={u.code} color={c.paper} /> : null}{statusTag(u)}{u.sport ? <Tag label={u.sport} color={c.cyanSoft} /> : null}</View>
          <T size={12} color={c.mute}>{t(`campus.kind.${u.kind}`)}{u.city ? ` · ${u.city}` : ''}{u.country ? ` · ${u.country}` : ''} · {t('campus.tree.since', { date: when(u.valid_from) })}{u.metrics ? ` · ${t('campus.tree.count', { athletes: u.metrics.athletes, venues: u.metrics.venues })}` : ''}</T>
        </View>
        {u.can_manage && u.kind === 'campus' && u.status === 'active' ? <Btn small title={t('campus.tree.add_dept')} color={c.paper} ink={c.ink} onPress={() => setSheet({ type: 'unit', kind: 'department', parent_id: u.id })} /> : null}
      </Pressable>
      {kids(u.id).map((k) => <Node key={k.id} u={k} depth={depth + 1} />)}
    </View>
  );
  return (
    <Panel>
      <Block title={t('campus.tree.title')} right={staff ? <View style={{ flexDirection: 'row', gap: 6 }}><Btn small title={t('campus.tree.add_region')} color={c.paper} ink={c.ink} onPress={() => setSheet({ type: 'unit', kind: 'region' })} /><Btn small title={t('campus.tree.add_campus')} onPress={() => setSheet({ type: 'unit', kind: 'campus' })} /></View> : null}>
        {roots.length ? roots.map((u) => <Node key={u.id} u={u} depth={0} />) : <Empty emoji="🧭" title={t('campus.tree.empty')} sub={t('campus.tree.empty_sub')} />}
      </Block>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ unit detail
function UnitPanel({ o, d, staff, toast, setSheet, refresh, unitId, openUnit }) {
  const [tab, setTab] = useState('assets');
  const det = useLoad(() => api.get(`/organisations/${o.id}/units/${unitId}`), [o.id, unitId]);
  if (det.error) return <ErrorBox error={det.error} onRetry={det.reload} />;
  if (!det.data) return <Loading />;
  const x = det.data, u = x.unit;
  const reload = () => { det.reload(); refresh(); };
  const setStatus = async (status) => { try { await api.patch(`/organisations/${o.id}/units/${u.id}`, { status, row_version: u.row_version }); toast?.(t(`campus.${status === 'active' ? 'reactivated' : status}`)); reload(); } catch (e) { toast?.(e.message); } };
  const total = TYPES.reduce((n, k) => n + x.assets[k].length, 0);
  return (
    <View style={{ gap: 12 }}>
      <T size={12} color={c.mute}>{x.path.map((p) => p.name).join('  ›  ')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}><Tag label={`${KIND_ICON[u.kind]} ${t(`campus.kind.${u.kind}`)}`} />{statusTag(u)}{x.my_roles.map((r) => <Tag key={r} label={t(`campus.role.${r}`)} color={c.limeSoft} />)}</View>
      {x.can_manage ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {u.status !== 'archived' ? <Btn small title={t('campus.unit.edit')} color={c.paper} ink={c.ink} onPress={() => setSheet({ type: 'unit', kind: u.kind, edit: u })} /> : null}
          {u.status === 'active' ? <Btn small title={t('campus.unit.move_here')} onPress={() => setSheet({ type: 'move', to: u.id })} /> : null}
          {u.status === 'active' ? <Btn small title={t('campus.unit.suspend')} color={c.paper} ink={c.ink} onPress={() => setStatus('suspended')} /> : null}
          {u.status === 'suspended' ? <Btn small title={t('campus.unit.reactivate')} onPress={() => setStatus('active')} /> : null}
          {u.status !== 'archived' && !total ? <Btn small title={t('campus.unit.archive')} color={c.paper} ink={c.red} onPress={() => setStatus('archived')} /> : null}
        </View>
      ) : null}
      <Seg value={tab} onChange={setTab} options={[{ value: 'assets', label: t('campus.unit.tab.assets') }, { value: 'people', label: t('campus.unit.tab.people') }, { value: 'policies', label: t('campus.unit.tab.policies') }, { value: 'activity', label: t('campus.unit.tab.activity') }]} />
      {tab === 'assets' ? <Assets x={x} total={total} setSheet={setSheet} /> : tab === 'people' ? <Roles {...{ o, x, toast, reload, setSheet }} /> : tab === 'policies' ? <Policies {...{ o, x, toast, reload }} /> : <UnitActivity o={o} unitId={u.id} />}
    </View>
  );
}
function Assets({ x, total, setSheet }) {
  if (!total) return <Empty emoji="📍" title={t('campus.unit.nothing')} sub={t('campus.unit.nothing_sub')} />;
  return (
    <View style={{ gap: 12 }}>
      {!x.people_visible ? <T size={12} color={c.mute}>{t('campus.unit.restricted')}</T> : null}
      {TYPES.filter((k) => x.assets[k].length).map((k) => (
        <View key={k} style={{ gap: 6 }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{`${t(`campus.type.${k}`)} · ${x.assets[k].length}`.toUpperCase()}</T>
          {x.assets[k].slice(0, 40).map((a) => (
            <View key={a.link_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 12, backgroundColor: c.bg, minHeight: 44 }}>
              <View style={{ flex: 1 }}><T weight="700">{a.label}</T><T size={12} color={c.mute}>{[a.sub, a.unit_id !== x.unit.id ? t('campus.unit.in', { name: a.unit_name }) : t('campus.unit.on_since', { date: when(a.since) })].filter(Boolean).join(' · ')}</T></View>
              {x.can_manage ? <Btn small title={t('campus.unit.move')} color={c.paper} ink={c.ink} onPress={() => setSheet({ type: 'transfer', object_type: k, from: a.unit_id, ids: [a.object_id] })} /> : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
function Roles({ o, x, toast, reload, setSheet }) {
  const [adding, setAdding] = useState(false);
  const members = useLoad(() => (x.can_manage ? api.get(`/organisations/${o.id}/members`, { limit: 100 }) : Promise.resolve([])), [o.id, x.can_manage]);
  const end = async (r) => { try { await api.del(`/organisations/${o.id}/units/${r.unit_id}/roles/${r.id}`); toast?.(t('campus.ended')); reload(); } catch (e) { toast?.(e.message); } };
  return (
    <View style={{ gap: 10 }}>
      <T size={12} color={c.mute}>{t('campus.role.help')}</T>
      {x.roles.length ? x.roles.map((r) => (
        <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, backgroundColor: c.bg, minHeight: 52 }}>
          <View style={{ flex: 1 }}>
            <T weight="700">{r.display_name}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={t(`campus.role.${r.role}`)} color={c.pinkSoft} /><T size={12} color={c.mute}>{r.inherited_from ? t('campus.role.inherited', { name: r.inherited_from }) : r.inherit ? '↓' : ''}{r.valid_to ? ` · ${when(r.valid_to)}` : ''}</T></View>
          </View>
          {x.can_manage && !r.inherited_from ? <Btn small title={t('campus.role.end')} color={c.paper} ink={c.ink} onPress={() => end(r)} /> : null}
        </View>
      )) : <Empty emoji="👥" title={t('campus.role.nobody')} />}
      {x.can_manage ? <Btn small title={t('campus.role.add')} onPress={() => setAdding(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={adding} onClose={() => setAdding(false)} title={t('campus.role.add')} submitLabel={t('campus.role.add')}
        fields={[
          { key: 'person', label: t('campus.role.person'), type: 'chips', options: (members.data ?? []).map((m) => ({ value: m.handle, label: m.display_name })) },
          { key: 'role', label: t('campus.role.role'), type: 'chips', options: ROLES.map((r) => ({ value: r, label: t(`campus.role.${r}`) })) },
          { key: 'inherit', label: t('campus.role.inherit'), type: 'switch', default: true },
          { key: 'valid_to', label: t('campus.role.to'), type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/units/${x.unit.id}/roles`, clean(v)); toast?.(t('campus.saved')); reload(); }} />
    </View>
  );
}
function Policies({ o, x, toast, reload }) {
  const [edit, setEdit] = useState(null);
  const field = (key) => ({
    currency: { key: 'value', type: 'currency', label: t('campus.pol.currency') }, timezone: { key: 'value', type: 'timezone', label: t('campus.pol.timezone') },
    attendance_min_pct: { key: 'value', type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', default: 80, label: t('campus.pol.attendance_min_pct') },
    coach_athlete_ratio_max: { key: 'value', type: 'stepper', min: 1, max: 100, default: 12, label: t('campus.pol.coach_athlete_ratio_max') },
    refund_window_days: { key: 'value', type: 'stepper', min: 0, max: 365, step: 1, default: 14, label: t('campus.pol.refund_window_days') },
    late_fee_grace_days: { key: 'value', type: 'stepper', min: 0, max: 60, default: 5, label: t('campus.pol.late_fee_grace_days') },
    guardian_consent_renewal_months: { key: 'value', type: 'stepper', min: 1, max: 36, default: 12, label: t('campus.pol.guardian_consent_renewal_months') },
    youth_pickup_required: { key: 'value', type: 'switch', default: true, label: t('campus.pol.youth_pickup_required') },
    report_cadence: { key: 'value', type: 'choice', options: ['weekly', 'monthly', 'termly'].map((v) => ({ value: v, label: t(`campus.pol.${v}`) })), label: t('campus.pol.report_cadence') },
  }[key]);
  const reset = async (key) => { try { await api.del(`/organisations/${o.id}/units/${x.unit.id}/policies/${key}`); toast?.(t('campus.saved')); reload(); } catch (e) { toast?.(e.message); } };
  return (
    <View style={{ gap: 8 }}>
      {POLICY_KEYS.map((k) => {
        const p = x.policies[k];
        return (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, backgroundColor: c.bg, minHeight: 52 }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{t(`campus.pol.${k}`)}</T>
              <T size={12} color={c.mute}>{p ? `${policyText(k, p.value)} · ${p.inherited ? t('campus.pol.inherited', { name: p.from_name }) : t('campus.pol.own')}${p.overrides ? ` · ${t('campus.pol.overrides')}` : ''}` : t('campus.pol.unset')}</T>
            </View>
            {x.can_manage ? <Btn small title={t('campus.pol.set')} color={c.paper} ink={c.ink} onPress={() => setEdit(k)} /> : null}
            {x.can_manage && p && !p.inherited ? <Btn small title={t('campus.pol.reset')} color={c.paper} ink={c.ink} onPress={() => reset(k)} /> : null}
          </View>
        );
      })}
      {edit ? <FormSheet visible onClose={() => setEdit(null)} title={t(`campus.pol.${edit}`)} fields={[field(edit)]} initial={{ value: x.policies[edit]?.value }}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/units/${x.unit.id}/policies`, { key: edit, value: v.value }); toast?.(t('campus.saved')); setEdit(null); reload(); }} /> : null}
    </View>
  );
}
function UnitActivity({ o, unitId }) {
  const a = useLoad(() => api.get(`/organisations/${o.id}/campus-audit`, { unit_id: unitId, limit: 30 }).catch(() => null), [o.id, unitId]);
  if (a.loading) return <Loading />;
  if (!a.data) return <Empty emoji="🔒" title={t('campus.unit.restricted')} />;
  return <EventList rows={a.data} />;
}
function EventList({ rows }) {
  if (!rows.length) return <Empty emoji="🧾" title={t('campus.audit.empty')} sub={t('campus.audit.empty_sub')} />;
  return (
    <View style={{ gap: 8 }}>
      {rows.map((e) => (
        <View key={e.id} style={{ padding: 10, borderRadius: 12, backgroundColor: c.bg, gap: 2 }}>
          <T size={14}><T weight="800">{e.actor_name ?? '–'}</T> {eventText(e)}</T>
          <T size={12} color={c.mute}>{e.unit_name ? `${e.unit_name} · ` : ''}{new Date(e.at).toLocaleString()}</T>
        </View>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ transfers and audit
function Audit({ audit }) {
  if (!audit.data) return <Loading />;
  return <Panel><Block title={t('campus.audit.title')}><EventList rows={audit.data} /></Block></Panel>;
}

// ── Campus setup wizard (4 steps) ─────────────────────────────────────────────
function CampusSetupWizard({ o, toast, refresh, setSec, onClose }) {
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('single');
  const [v, setV] = useState({ name: '', code: '', country: undefined, city: o.city ?? '', timezone: undefined, effective_on: undefined });
  const [depts, setDepts] = useState([]);
  const [pre, setPre] = useState(null);
  const [busy, setBusy] = useState(false);
  const sportsList = useSports();

  const set = (k, x) => setV((p) => ({ ...p, [k]: x }));
  const cleanBody = () => {
    const b = { name: v.name.trim() || 'Main campus' };
    if (v.code?.trim()) b.code = v.code.trim().toUpperCase();
    if (v.country) b.country = v.country;
    if (v.city?.trim()) b.city = v.city.trim();
    if (v.timezone) b.timezone = v.timezone;
    if (v.effective_on) b.effective_on = v.effective_on;
    return b;
  };

  const toReview = async () => {
    setBusy(true);
    try {
      const p = await api.post(`/organisations/${o.id}/campuses/adopt`, { ...cleanBody(), dry_run: true });
      setPre(p);
      setStep(4);
    } catch (e) { toast?.(e.message); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/organisations/${o.id}/campuses/adopt`, { ...cleanBody(), idempotency_key: `adopt-${o.id}-${Date.now()}` });
      for (const sport of depts) {
        const sp = (sportsList.data ?? []).find((s) => s.slug === sport);
        try {
          await api.post(`/organisations/${o.id}/units`, {
            kind: 'department', sport, parent_id: r.unit.id,
            name: sp ? `${sp.name} department` : `${sport.charAt(0).toUpperCase() + sport.slice(1)} department`,
            ...(r.effective_on ? { valid_from: r.effective_on } : {}),
          });
        } catch { /* don't block overall setup for a single dept failure */ }
      }
      toast?.(t('campus.sw.review.done'));
      refresh();
      onClose();
    } catch (e) { toast?.(e.message); }
    finally { setBusy(false); }
  };

  const dots = (
    <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', paddingBottom: 4 }}>
      {Array.from({ length: 4 }, (_, i) => (
        <View key={i} style={{ height: 7, width: i + 1 === step ? 20 : 7, borderRadius: 999, backgroundColor: i + 1 === step ? c.pink : c.line }} />
      ))}
    </View>
  );
  const stepTag = <Tag label={t('campus.sw.step', { n: step, total: 4 })} color={c.pinkSoft} />;
  const suggestions = [...new Set([o.city ? `${o.city} campus` : null, o.name ? `${o.name} campus` : null, 'Main campus'].filter(Boolean))];

  if (step === 1) return (
    <Sheet visible onClose={onClose} title={t('campus.setup.cta')}
      footer={<View style={{ flex: 1, gap: 8 }}>{dots}<Btn title={t('campus.sw.continue')} onPress={() => { if (mode === 'full') { onClose(); setSec('structure'); } else setStep(2); }} /></View>}>
      {stepTag}
      <View style={{ gap: 6 }}>
        <T size={20} weight="900">{t('campus.sw.mode.title')}</T>
        <T color={c.mute}>{t('campus.sw.mode.note')}</T>
      </View>
      <View style={{ gap: 8 }}>
        <_OptionCard icon="🎯" title={t('campus.sw.mode.single')} desc={t('campus.sw.mode.single_desc')} badge={t('campus.sw.mode.single_rec')} selected={mode === 'single'} onPress={() => setMode('single')} />
        <_OptionCard icon="🌐" title={t('campus.sw.mode.full')} desc={t('campus.sw.mode.full_desc')} selected={mode === 'full'} onPress={() => setMode('full')} />
      </View>
    </Sheet>
  );

  if (step === 2) return (
    <Sheet visible onClose={onClose} title={t('campus.setup.cta')}
      footer={<View style={{ flex: 1, gap: 8 }}>{dots}<View style={{ flexDirection: 'row', gap: 8 }}><Btn title={t('campus.sw.back')} color={c.paper} ink={c.ink} onPress={() => setStep(1)} style={{ flex: 0.6 }} /><Btn title={t('campus.sw.continue')} onPress={() => setStep(3)} style={{ flex: 1 }} /></View></View>}>
      {stepTag}
      <View style={{ gap: 4 }}>
        <T size={18} weight="800">{t('campus.sw.profile.title')}</T>
        <T size={13} color={c.mute}>{t('campus.sw.profile.sub')}</T>
      </View>
      <View style={{ gap: 6 }}>
        <Field label={t('campus.sw.profile.name')} value={v.name} onChangeText={(x) => set('name', x)} placeholder="e.g. Manacor campus" maxLength={80} />
        {suggestions.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {suggestions.map((s) => <Chip key={s} label={s} active={v.name === s} onPress={() => set('name', v.name === s ? '' : s)} />)}
          </View>
        ) : null}
      </View>
      <Field label={`${t('campus.sw.profile.code')} (${t('form.optional')})`} value={v.code} onChangeText={(x) => set('code', x.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16))} placeholder="e.g. MAN · BCN" hint={t('campus.sw.profile.code_hint')} maxLength={16} />
      <CountryPicker label={t('campus.sw.profile.country')} value={v.country} onChange={(x) => set('country', x)} optional />
      <Field label={`${t('campus.sw.profile.city')} (${t('form.optional')})`} value={v.city} onChangeText={(x) => set('city', x)} placeholder={t('campus.sw.profile.city')} maxLength={80} />
      <MenuField label={`${t('campus.sw.profile.tz')} (${t('form.optional')})`} value={v.timezone ?? ''} onChange={(x) => set('timezone', x || undefined)} options={[{ value: '', label: t('campus.sw.profile.tz_none') }, ...WIZARD_ZONES.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))]} />
      <DateField label={`${t('campus.sw.profile.from')} (${t('form.optional')})`} value={v.effective_on} onChange={(x) => set('effective_on', x)} optional hint={t('campus.sw.profile.from_hint')} />
    </Sheet>
  );

  if (step === 3) return (
    <Sheet visible onClose={onClose} title={t('campus.setup.cta')}
      footer={<View style={{ flex: 1, gap: 8 }}>{dots}<View style={{ flexDirection: 'row', gap: 8 }}><Btn title={t('campus.sw.back')} color={c.paper} ink={c.ink} onPress={() => setStep(2)} style={{ flex: 0.6 }} /><Btn title={t('campus.sw.continue')} onPress={toReview} loading={busy} style={{ flex: 1 }} /></View></View>}>
      {stepTag}
      <View style={{ gap: 4 }}>
        <T size={18} weight="800">{t('campus.sw.depts.title')}</T>
        <T size={13} color={c.mute}>{t('campus.sw.depts.sub')}</T>
      </View>
      {sportsList.loading ? <Loading /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
          {(sportsList.data ?? []).slice(0, 28).map((s) => (
            <Chip key={s.slug} label={s.name} active={depts.includes(s.slug)} onPress={() => setDepts((p) => p.includes(s.slug) ? p.filter((x) => x !== s.slug) : [...p, s.slug])} />
          ))}
        </View>
      )}
      {depts.length > 0 ? (
        <View style={{ backgroundColor: c.violetSoft, borderRadius: 14, padding: 14, gap: 8 }}>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{t('campus.sw.depts.preview', { name: v.name.trim() || t('campus.kind.campus') }).toUpperCase()}</T>
          {depts.map((slug) => {
            const sp = (sportsList.data ?? []).find((s) => s.slug === slug);
            return (
              <View key={slug} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: c.paper, borderRadius: 10 }}>
                <T size={16}>🏅</T>
                <T weight="700" style={{ flex: 1 }}>{(sp?.name ?? slug)} {t('campus.sw.depts.dept_sfx')}</T>
                <Tag label={t('campus.sw.depts.new')} color={c.pinkSoft} />
              </View>
            );
          })}
          <T size={12} color={c.mute}>{t('campus.sw.depts.note')}</T>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1.5, borderColor: c.line }}>
          <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}>
            <T weight="900" color={c.paper}>✓</T>
          </View>
          <View style={{ flex: 1 }}>
            <T weight="700">{t('campus.sw.depts.skip')}</T>
            <T size={12} color={c.mute}>{t('campus.sw.depts.skip_sub')}</T>
          </View>
        </View>
      )}
    </Sheet>
  );

  return (
    <Sheet visible onClose={onClose} title={t('campus.setup.cta')}
      footer={<View style={{ flex: 1, gap: 8 }}>{dots}<View style={{ flexDirection: 'row', gap: 8 }}><Btn title={t('campus.sw.back')} color={c.paper} ink={c.ink} onPress={() => setStep(3)} style={{ flex: 0.6 }} /><Btn title={t('campus.sw.review.confirm')} onPress={confirm} loading={busy} style={{ flex: 1 }} /></View></View>}>
      {stepTag}
      <View style={{ gap: 4 }}>
        <T size={18} weight="800">{t('campus.sw.review.title')}</T>
        <T size={13} color={c.mute}>{t('campus.sw.review.sub')}</T>
      </View>
      <Panel>
        <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{t('campus.sw.review.campus').toUpperCase()}</T>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <T size={22}>🏫</T>
          <View style={{ flex: 1, gap: 6 }}>
            <T size={15} weight="900">{v.name.trim() || 'Main campus'}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
              {v.code ? <Tag label={v.code.toUpperCase()} color={c.pinkSoft} /> : null}
              {v.country ? <Tag label={v.country} /> : null}
              {v.city ? <Tag label={v.city} /> : null}
              {v.timezone ? <Tag label={v.timezone.replace(/_/g, ' ')} /> : null}
            </View>
          </View>
        </View>
      </Panel>
      {pre ? (
        <Panel>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{t('campus.sw.review.objects').toUpperCase()}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(pre.will_point).filter(([, n]) => n > 0).map(([k, n]) => (
              <View key={k} style={{ alignItems: 'center', backgroundColor: c.bg, borderRadius: 10, padding: 10, minWidth: 68 }}>
                <T size={22} weight="900">{n}</T>
                <T size={10} weight="800" color={c.mute} style={{ textAlign: 'center', letterSpacing: 0.3, textTransform: 'uppercase' }}>{t(`campus.type.${k}`)}</T>
              </View>
            ))}
          </View>
          {pre.athletes_following > 0 ? (
            <View style={{ backgroundColor: c.limeSoft, borderRadius: 10, padding: 10 }}>
              <T size={13} weight="700" color={c.lime}>{t('campus.sw.review.athletes', { n: pre.athletes_following })}</T>
            </View>
          ) : null}
          <T size={12} color={c.mute}>{t('campus.setup.unchanged')}</T>
        </Panel>
      ) : null}
      {depts.length > 0 ? (
        <Panel>
          <T size={12} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{t('campus.sw.review.depts').toUpperCase()}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {depts.map((slug) => {
              const sp = (sportsList.data ?? []).find((s) => s.slug === slug);
              return <Tag key={slug} label={`🏅 ${sp?.name ?? slug}`} color={c.pinkSoft} />;
            })}
          </View>
        </Panel>
      ) : null}
      <View style={{ backgroundColor: c.limeSoft, borderRadius: 14, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <T size={18}>🛡️</T>
        <View style={{ flex: 1, gap: 4 }}>
          <T size={14} weight="800" color={c.lime}>{t('campus.sw.review.safe')}</T>
          <T size={12} color={c.lime} style={{ lineHeight: 17 }}>{t('campus.sw.review.safe_body')}</T>
        </View>
      </View>
    </Sheet>
  );
}

function _OptionCard({ icon, title, desc, badge, selected, onPress }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }}
      style={{ borderWidth: 2, borderColor: selected ? c.pink : c.line, borderRadius: 16, padding: 16, backgroundColor: selected ? '#F8F5FE' : c.paper }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 20, height: 20, borderRadius: 999, borderWidth: 2, borderColor: selected ? c.pink : c.line, alignItems: 'center', justifyContent: 'center', marginTop: 2, flexShrink: 0 }}>
          {selected ? <View style={{ width: 10, height: 10, borderRadius: 999, backgroundColor: c.pink }} /> : null}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T size={18}>{icon}</T>
            <T size={14} weight="800">{title}</T>
          </View>
          <T size={13} color={c.mute} style={{ lineHeight: 18 }}>{desc}</T>
          {badge ? <View style={{ alignSelf: 'flex-start', backgroundColor: c.limeSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, marginTop: 2 }}><T size={11} weight="800" color={c.lime}>{badge}</T></View> : null}
        </View>
      </View>
    </Pressable>
  );
}

function UnitForm({ o, d, toast, refresh, spec, onClose }) {
  const edit = spec.edit, kind = spec.kind;
  const parents = d.units.filter((u) => !u.context_only && u.status !== 'archived' && u.id !== edit?.id && (kind === 'department' ? u.kind === 'campus' : kind === 'campus' ? u.kind === 'region' : kind === 'region' ? u.kind === 'region' : false));
  const fields = [
    { key: 'name', label: t('campus.form.name'), type: 'text' },
    ...(kind !== 'region' || true ? [{ key: 'code', label: t('campus.form.code'), hint: t('campus.form.code_hint'), optional: true }] : []),
    ...(kind === 'department' ? [{ key: 'sport', label: t('campus.form.sport'), type: 'sport' }] : []),
    ...(kind === 'department' && !edit ? [] : [{ key: 'country', label: t('campus.form.country'), type: 'country', optional: true }]),
    ...(kind === 'campus' ? [{ key: 'city', label: t('campus.form.city'), optional: true }, { key: 'timezone', label: t('campus.form.timezone'), type: 'timezone', optional: true }] : []),
    ...(kind !== 'department' || !spec.parent_id ? [{ key: 'parent_id', label: t('campus.form.parent'), type: 'chips', optional: true, options: [{ value: '', label: t('campus.form.region_none') }, ...parents.map((p) => ({ value: p.id, label: p.name }))] }] : []),
    ...(!edit ? [{ key: 'valid_from', label: t('campus.form.starts'), type: 'date', optional: true }] : []),
  ];
  return (
    <FormSheet visible onClose={onClose} title={edit ? t('campus.form.edit', { name: edit.name }) : t(`campus.form.new_${kind === 'department' ? 'dept' : kind}`)} fields={fields}
      initial={edit ? { ...edit, parent_id: edit.parent_id ?? '' } : { parent_id: spec.parent_id ?? '' }}
      onSubmit={async (val) => {
        if (edit) await api.patch(`/organisations/${o.id}/units/${edit.id}`, { ...clean({ name: val.name, code: val.code, country: val.country, city: val.city, timezone: val.timezone, sport: val.sport }), ...(val.parent_id !== (edit.parent_id ?? '') ? { parent_id: val.parent_id || null } : {}), row_version: edit.row_version });
        else await api.post(`/organisations/${o.id}/units`, { kind, ...clean({ name: val.name, code: val.code, country: val.country, city: val.city, timezone: val.timezone, sport: val.sport, valid_from: val.valid_from }), ...(val.parent_id || spec.parent_id ? { parent_id: val.parent_id || spec.parent_id } : {}) });
        toast?.(t('campus.saved')); refresh(); onClose();
      }} />
  );
}
