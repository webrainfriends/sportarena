// Venue facility operations (#585), inside the venue console: readiness of every area, check-in, assets, preventive maintenance, incidents,
// staff shifts, booking series and income reconciliation. Work orders stay in the Maintenance tab; money in Front desk / Reports.
// One codebase for iOS, iPadOS, Android and web: shared components only, 44pt targets (Btn/Chip/Row), start/end layout, strings through t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Section, Seg, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { addDays, dateTimeIn, moneyIn, todayIn } from '../vtime';

const day = (d) => (d ? String(d).slice(0, 10) : '');
const STATUS_COLOR = { ready: c.mintSoft, attention: c.sunSoft, not_ready: c.redSoft, unchecked: c.paper };
const DUTIES = ['general', 'reception', 'maintenance', 'lifeguard', 'groundskeeper', 'coach_liaison'];
const dutyOptions = () => DUTIES.map((value) => ({ value, label: t(`vf.duty.${value}`) }));
const areaOptions = (v) => v.resources.map((r) => ({ value: r.id, label: `${r.sport_emoji ?? ''} ${r.name}`.trim(), sub: r.kind }));
const pick = (x) => (Array.isArray(x) ? x[0] || undefined : x || undefined);

/** The panel: sections for what the signed-in person may use (floor staff see the daily ones, managers everything). */
export function FacilityPanel({ v, go }) {
  const me = useLoad(() => api.get(`/venues/${v.id}/me`), [v.id]);
  const [sec, setSec] = useState('readiness');
  if (me.loading && !me.data) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} onRetry={me.reload} />;
  const mgr = me.data.level === 'manager';
  const SECTIONS = [['readiness', t('vf.sec.readiness')], ['incidents', t('vf.sec.incidents')], ['shifts', t('vf.sec.shifts')], ['assets', t('vf.sec.assets')],
    ...(mgr ? [['preventive', t('vf.sec.preventive')], ['series', t('vf.sec.series')], ['income', t('vf.sec.income')]] : [])];
  const P = { v, mgr, me: me.data };
  return (
    <View style={{ gap: 10 }}>
      {go ? <Row onPress={() => go('access')} color={c.cyanSoft} title={`🚪 ${t('vf.sec.checkin')}`} sub="Doors & attendance" right={<T color={c.pink} weight="700">›</T>} /> : null}
      <Seg options={SECTIONS.map(([value, label]) => ({ value, label }))} value={sec} onChange={setSec} color={c.cyan} />
      {sec === 'readiness' ? <Readiness {...P} /> : sec === 'incidents' ? <Incidents {...P} /> : sec === 'shifts' ? <Shifts {...P} /> : sec === 'assets' ? <Assets {...P} /> : sec === 'preventive' ? <Preventive {...P} /> : sec === 'series' ? <Series {...P} /> : <Income {...P} />}
    </View>
  );
}

// ------------------------------------------------------------------ readiness
function Readiness({ v }) {
  const { toast } = useSession();
  const board = useLoad(() => api.get(`/venues/${v.id}/readiness`), [v.id]);
  const [area, setArea] = useState(null);
  const b = board.data;
  return (
    <Section title={t('vf.sec.readiness')} color={c.mint}>
      <T color={c.mute} size={13}>{t('vf.ready.intro')}</T>
      {b ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{['ready', 'attention', 'not_ready', 'unchecked'].map((k) => <StatPill key={k} label={t(`vf.status.${k}`)} value={String(b.totals[k])} />)}</View> : null}
      {board.loading && !b ? <Loading /> : board.error ? <ErrorBox error={board.error} onRetry={board.reload} /> : b.areas.length ? b.areas.map((a) => (
        <Card key={a.resource_id} pad={12} color={STATUS_COLOR[a.status]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T style={{ flex: 1 }} weight="800">{a.name}</T><Tag label={t(`vf.status.${a.status}`)} />
          </View>
          <T size={12} color={c.mute}>{[t(`vf.kind.${a.kind}`), a.checked_at ? t('vf.ready.last', { who: a.checked_by_name, when: dateTimeIn(a.checked_at, v.timezone) }) : t('vf.ready.never'), a.stale && a.checked_at ? t('vf.ready.stale') : null, a.open_work_orders ? t('vf.ready.jobs', { n: a.open_work_orders }) : null].filter(Boolean).join(' · ')}</T>
          {a.failing.length ? <T size={12} color={c.red}>{a.failing.map((k) => t(`vf.ready.${k}`)).join(', ')}</T> : null}
          <Btn small title={t('vf.ready.check')} color={c.violet} onPress={() => setArea(a)} accessibilityLabel={t('vf.ready.check_a11y', { name: a.name })} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Card>
      )) : <Empty emoji="🏟️" title={t('vf.ready.none')} sub={t('vf.ready.none_sub')} />}
      <FormSheet visible={!!area} onClose={() => setArea(null)} title={area ? t('vf.ready.check_a11y', { name: area.name }) : ''} submitLabel={t('common.save')}
        fields={area ? [...area.template.map((i) => ({ key: `i_${i.key}`, label: `${t(`vf.ready.${i.key}`)}${i.critical ? ' *' : ''}`, type: 'switch', default: true })),
          { key: 'notes', label: t('vf.notes'), type: 'multiline', optional: true }, { key: 'raise', label: t('vf.ready.raise'), type: 'switch', default: false }] : []}
        onSubmit={async (f) => { const r = await api.post(`/resources/${area.resource_id}/readiness`, { items: area.template.map((i) => ({ key: i.key, ok: !!f[`i_${i.key}`] })), notes: f.notes || undefined, raise_work_order: !!f.raise }); board.reload(); toast(t(`vf.status.${r.status}`)); return t(`vf.status.${r.status}`); }} />
    </Section>
  );
}

// ------------------------------------------------------------------ assets
const CONDITIONS = ['new', 'good', 'fair', 'poor', 'out_of_service'];
function Assets({ v, mgr }) {
  const [edit, setEdit] = useState(null);
  const list = useLoad(() => api.get(`/venues/${v.id}/assets`, { limit: 100 }), [v.id]);
  return (
    <Section title={t('vf.sec.assets')} color={c.orange}>
      <T color={c.mute} size={13}>{t('vf.as.intro')}</T>
      {mgr ? <Btn small title={t('vf.as.add')} color={c.violet} onPress={() => setEdit({})} style={{ alignSelf: 'flex-start' }} /> : null}
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((a) => (
        <Row key={a.id} onPress={mgr ? () => setEdit(a) : undefined} color={a.condition === 'out_of_service' ? c.redSoft : c.paper} title={`${a.name}${a.asset_tag ? ` · ${a.asset_tag}` : ''}`}
          sub={[t(`vf.cond.${a.condition}`), a.resource_name, a.location, a.warranty_expiring ? t('vf.as.warranty', { date: day(a.warranty_until) }) : null, a.open_work_orders ? t('vf.ready.jobs', { n: a.open_work_orders }) : null].filter(Boolean).join(' · ')} />
      )) : <Empty emoji="🧰" title={t('vf.as.none')} sub={t('vf.as.none_sub')} />}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.id ? edit.name : t('vf.as.add')} submitLabel={t('common.save')}
        fields={[{ key: 'name', label: t('vf.name') }, { key: 'asset_tag', label: t('vf.as.tag'), optional: true },
          { key: 'resource_id', label: t('vf.area'), type: 'multimenu', max: 1, optional: true, options: areaOptions(v) },
          { key: 'condition', label: t('vf.as.condition'), type: 'chips', default: 'good', options: CONDITIONS.map((value) => ({ value, label: t(`vf.cond.${value}`) })) },
          { key: 'location', label: t('vf.as.location'), optional: true }, { key: 'serial_no', label: t('vf.as.serial'), optional: true },
          { key: 'purchased_on', label: t('vf.as.purchased'), type: 'date', optional: true }, { key: 'warranty_until', label: t('vf.as.warranty_until'), type: 'date', optional: true }]}
        initial={edit?.id ? { ...edit, resource_id: edit.resource_id ? [edit.resource_id] : [], purchased_on: day(edit.purchased_on) || undefined, warranty_until: day(edit.warranty_until) || undefined } : {}}
        onSubmit={async (f) => {
          const body = { name: f.name, asset_tag: f.asset_tag || undefined, resource_id: pick(f.resource_id), condition: f.condition, location: f.location || undefined, serial_no: f.serial_no || undefined, purchased_on: f.purchased_on || undefined, warranty_until: f.warranty_until || undefined };
          if (edit.id) await api.patch(`/venue-assets/${edit.id}`, { ...body, resource_id: body.resource_id ?? null }); else await api.post(`/venues/${v.id}/assets`, body);
          list.reload(); return t('vf.saved');
        }} />
    </Section>
  );
}

// ------------------------------------------------------------------ preventive maintenance schedule
const EVERY = [7, 30, 90, 180, 365];
function Preventive({ v }) {
  const [form, setForm] = useState(false);
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/venues/${v.id}/pm-templates`, { include_paused: true }), [v.id]);
  const assets = useLoad(() => api.get(`/venues/${v.id}/assets`, { limit: 100 }), [v.id]);
  const today = todayIn(v.timezone);
  const toggle = async (x) => { try { await api.patch(`/venue-pm-templates/${x.id}`, { active: !x.active }); list.reload(); } catch (e) { toast(e.message); } };
  return (
    <Section title={t('vf.sec.preventive')} color={c.lime}>
      <T color={c.mute} size={13}>{t('vf.pm.intro')}</T>
      <Btn small title={t('vf.pm.add')} color={c.violet} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((x) => (
        <Card key={x.id} pad={12} color={x.active ? c.paper : c.sunSoft}>
          <T weight="800">{x.title}</T>
          <T size={12} color={c.mute}>{[x.resource_name ?? x.asset_name ?? t('vf.pm.whole'), t('vf.pm.every', { n: x.every_days }), t('vf.pm.next', { date: day(x.next_due_on) }), x.checklist.length ? t('vf.pm.steps', { n: x.checklist.length }) : null].filter(Boolean).join(' · ')}</T>
          <Btn small title={x.active ? t('vf.pm.pause') : t('vf.pm.resume')} color={c.paper} ink={c.ink} onPress={() => toggle(x)} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Card>
      )) : <Empty emoji="🗓️" title={t('vf.pm.none')} sub={t('vf.pm.none_sub')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('vf.pm.add')} submitLabel={t('common.save')}
        fields={[{ key: 'title', label: t('vf.pm.title') },
          { key: 'resource_id', label: t('vf.area'), type: 'multimenu', max: 1, optional: true, options: areaOptions(v) },
          { key: 'asset_id', label: t('vf.as.one'), type: 'multimenu', max: 1, optional: true, options: (assets.data ?? []).map((a) => ({ value: a.id, label: a.name, sub: a.asset_tag })) },
          { key: 'every_days', label: t('vf.pm.repeat'), type: 'chips', default: 30, options: EVERY.map((value) => ({ value, label: t('vf.pm.every', { n: value }) })) },
          { key: 'first_due_on', label: t('vf.pm.first'), type: 'date' },
          { key: 'steps', label: t('vf.pm.steps_label'), type: 'multiline', optional: true, hint: t('vf.pm.steps_hint') }]}
        initial={{ first_due_on: addDays(today, 7) }}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/pm-templates`, { title: f.title, resource_id: pick(f.resource_id), asset_id: pick(f.asset_id), every_days: f.every_days, first_due_on: f.first_due_on, checklist: String(f.steps ?? '').split('\n').map((s) => s.trim()).filter(Boolean) }); list.reload(); return t('vf.saved'); }} />
    </Section>
  );
}

// ------------------------------------------------------------------ incidents
const KINDS = ['injury', 'safety', 'damage', 'security', 'other'];
const SEV = ['minor', 'moderate', 'serious', 'critical'];
function Incidents({ v, mgr }) {
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('open');
  const list = useLoad(() => api.get(`/venues/${v.id}/incidents`, { status: filter, limit: 100 }), [v.id, filter]);
  const detail = useLoad(() => (open ? api.get(`/venue-incidents/${open.id}`) : Promise.resolve(null)), [open?.id]);
  return (
    <Section title={t('vf.sec.incidents')} color={c.red}>
      <T color={c.mute} size={13}>{t('vf.in.intro')}</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['open', 'resolved', 'all'].map((k) => <Chip key={k} label={t(`vf.in.f.${k}`)} active={filter === k} onPress={() => setFilter(k)} />)}</View>
      <Btn small title={t('vf.in.report')} color={c.violet} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((n) => (
        <Row key={n.id} onPress={() => setOpen(n)} color={['serious', 'critical'].includes(n.severity) && n.status !== 'resolved' ? c.redSoft : c.paper} title={`${t(`vf.in.kind.${n.kind}`)} · ${n.summary}`}
          sub={[t(`vf.in.sev.${n.severity}`), t(`vf.in.status.${n.status}`), n.resource_name, dateTimeIn(n.occurred_at, v.timezone)].filter(Boolean).join(' · ')} />
      )) : <Empty emoji="🩹" title={t('vf.in.none')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('vf.in.report')} submitLabel={t('common.save')}
        fields={[{ key: 'kind', label: t('vf.in.kind_label'), type: 'chips', default: 'safety', options: KINDS.map((value) => ({ value, label: t(`vf.in.kind.${value}`) })) },
          { key: 'severity', label: t('vf.in.sev_label'), type: 'chips', default: 'minor', options: SEV.map((value) => ({ value, label: t(`vf.in.sev.${value}`) })) },
          { key: 'resource_id', label: t('vf.area'), type: 'multimenu', max: 1, optional: true, options: areaOptions(v) },
          { key: 'summary', label: t('vf.in.summary') }, { key: 'details', label: t('vf.in.details'), type: 'multiline', optional: true, hint: t('vf.in.details_hint') },
          { key: 'raise', label: t('vf.in.raise'), type: 'switch', default: false }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/incidents`, { kind: f.kind, severity: f.severity, resource_id: pick(f.resource_id), summary: f.summary, details: f.details || undefined, raise_work_order: !!f.raise }); list.reload(); return t('vf.saved'); }} />
      <FormSheet visible={!!open} onClose={() => setOpen(null)} title={open ? open.summary : ''} submitLabel={mgr ? t('common.save') : t('common.close')}
        fields={[{ key: 'd', type: 'section', label: detail.data?.details ?? (detail.loading ? t('common.loading') : t('vf.in.no_details')) },
          ...(mgr ? [{ key: 'status', label: t('vf.in.status_label'), type: 'chips', default: open?.status, options: ['open', 'investigating', 'resolved'].map((value) => ({ value, label: t(`vf.in.status.${value}`) })) },
            { key: 'resolution', label: t('vf.in.resolution'), type: 'multiline', optional: true, show: (x) => x.status === 'resolved' }] : [])]}
        initial={{ status: open?.status, resolution: open?.resolution ?? '' }}
        onSubmit={async (f) => { if (mgr && f.status !== open.status) { await api.patch(`/venue-incidents/${open.id}`, { status: f.status, resolution: f.resolution || undefined }); list.reload(); } return t('vf.saved'); }} />
    </Section>
  );
}

// ------------------------------------------------------------------ shifts
function Shifts({ v, mgr }) {
  const { user, toast } = useSession();
  const [form, setForm] = useState(false);
  const list = useLoad(() => api.get(`/venues/${v.id}/shifts`, { limit: 100 }), [v.id]);
  const team = useLoad(() => (mgr ? api.get(`/venues/${v.id}/staff`) : Promise.resolve([])), [v.id, mgr]);
  const act = async (fn) => { try { await fn(); list.reload(); } catch (e) { toast(e.message); } };
  return (
    <Section title={t('vf.sec.shifts')} color={c.pink}>
      <T color={c.mute} size={13}>{t(mgr ? 'vf.sh.intro_mgr' : 'vf.sh.intro')}</T>
      {mgr ? <Btn small title={t('vf.sh.add')} color={c.violet} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((s) => (
        <Card key={s.id} pad={12} color={s.status === 'cancelled' ? c.sunSoft : c.paper}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T style={{ flex: 1 }} weight="800">{s.display_name}</T><Tag label={t(`vf.sh.status.${s.status}`)} /></View>
          <T size={12} color={c.mute}>{[t(`vf.duty.${s.duty}`), `${dateTimeIn(s.starts_at, v.timezone)} → ${dateTimeIn(s.ends_at, v.timezone)}`, s.hours_worked != null ? t('vf.sh.hours', { n: s.hours_worked }) : null].filter(Boolean).join(' · ')}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {s.user_id === user?.id && s.status === 'scheduled' ? <Btn small title={t('vf.sh.in')} onPress={() => act(() => api.post(`/venue-shifts/${s.id}/clock`, { action: 'in' }))} /> : null}
            {s.user_id === user?.id && s.status === 'clocked_in' ? <Btn small title={t('vf.sh.out')} onPress={() => act(() => api.post(`/venue-shifts/${s.id}/clock`, { action: 'out' }))} /> : null}
            {mgr && s.status === 'scheduled' ? <Btn small title={t('common.cancel')} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/venue-shifts/${s.id}/cancel`, {}))} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🕒" title={t('vf.sh.none')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('vf.sh.add')} submitLabel={t('common.save')}
        fields={[{ key: 'user_id', label: t('vf.sh.person'), type: 'multimenu', max: 1, options: (team.data ?? []).map((p) => ({ value: p.id, label: p.display_name, sub: p.role })) },
          { key: 'starts_at', label: t('vf.sh.starts'), type: 'datetime', step: 15 }, { key: 'ends_at', label: t('vf.sh.ends'), type: 'datetime', step: 15 },
          { key: 'duty', label: t('vf.sh.duty'), type: 'chips', optional: true, options: dutyOptions() }, { key: 'notes', label: t('vf.notes'), optional: true }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/shifts`, { user_id: pick(f.user_id), starts_at: f.starts_at, ends_at: f.ends_at, duty: f.duty || undefined, notes: f.notes || undefined }); list.reload(); return t('vf.saved'); }} />
    </Section>
  );
}

// ------------------------------------------------------------------ booking series
function Series({ v }) {
  const { toast } = useSession();
  const [form, setForm] = useState(false);
  const list = useLoad(() => api.get(`/venues/${v.id}/booking-series`), [v.id]);
  const today = todayIn(v.timezone);
  const end = async (s) => { try { const r = await api.post(`/venue-booking-series/${s.id}/cancel`, {}); toast(t('vf.se.released', { n: r.released })); list.reload(); } catch (e) { toast(e.message); } };
  return (
    <Section title={t('vf.sec.series')} color={c.violet}>
      <T color={c.mute} size={13}>{t('vf.se.intro')}</T>
      <Btn small title={t('vf.se.add')} color={c.violet} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((s) => (
        <Card key={s.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T style={{ flex: 1 }} weight="800">{s.title}</T><Tag label={t(`vf.se.status.${s.status}`)} /></View>
          <T size={12} color={c.mute}>{[s.resource_name, `${s.start_time}–${s.end_time}`, t('vf.se.upcoming', { n: s.upcoming }), s.next_at ? t('vf.se.next', { when: dateTimeIn(s.next_at, v.timezone) }) : null].filter(Boolean).join(' · ')}</T>
          {s.status === 'active' ? <Btn small title={t('vf.se.end')} color={c.paper} ink={c.red} onPress={() => end(s)} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
        </Card>
      )) : <Empty emoji="🔁" title={t('vf.se.none')} sub={t('vf.se.none_sub')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('vf.se.add')} submitLabel={t('vf.se.hold')}
        fields={[{ key: 'title', label: t('vf.se.title') }, { key: 'resource_id', label: t('vf.area'), type: 'multimenu', max: 1, options: areaOptions(v) },
          { key: 'start', label: t('vf.se.start'), type: 'time' }, { key: 'end', label: t('vf.se.endtime'), type: 'time' },
          { key: 'weekdays', label: t('vf.se.days'), type: 'weekdays' }, { key: 'starts_on', label: t('vf.se.from'), type: 'date' },
          { key: 'count', label: t('vf.se.count'), type: 'stepper', min: 1, max: 60, default: 8 }]}
        initial={{ starts_on: addDays(today, 1), start: '18:00', end: '19:00' }}
        onSubmit={async (f) => { const r = await api.post(`/venues/${v.id}/booking-series`, { title: f.title, resource_id: pick(f.resource_id), start: f.start, end: f.end, weekdays: f.weekdays, starts_on: f.starts_on, count: f.count }); list.reload(); return r.skipped.length ? t('vf.se.held_skipped', { held: r.held, skipped: r.skipped.length }) : t('vf.se.held', { n: r.held }); }} />
    </Section>
  );
}

// ------------------------------------------------------------------ income reconciliation
const RANGES = [7, 30, 90];
function Income({ v }) {
  const [r, setR] = useState(1);
  const to = todayIn(v.timezone), from = addDays(to, -(RANGES[r] - 1));
  const q = useLoad(() => api.get(`/venues/${v.id}/income`, { from, to }), [v.id, r]);
  const d = q.data;
  return (
    <Section title={t('vf.sec.income')} color={c.mint}>
      <T color={c.mute} size={13}>{t('vf.inc.intro')}</T>
      <Seg options={RANGES.map((n, value) => ({ value, label: t('vf.inc.days', { n }) }))} value={r} onChange={setR} color={c.mint} />
      {q.loading && !d ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : (
        <>
          {d.exceptions ? <Card color={c.sunSoft} pad={10}><T weight="700" size={13}>⚠ {t('vf.inc.exceptions', { n: d.exceptions })}</T></Card> : null}
          {d.currencies.map((x) => (
            <Card key={x.currency} pad={12}>
              <T weight="800" size={16}>{x.currency}</T>
              {[[t('vf.inc.pos_taken'), x.pos.taken_cents], [t('vf.inc.pos_refunded'), x.pos.refunded_cents], [t('vf.inc.pos_net'), x.pos.net_cents], [t('vf.inc.bookings_paid'), Number(x.bookings.paid_cents)], [t('vf.inc.bookings_due'), Number(x.bookings.outstanding_cents)]].map(([l, n]) => (
                <View key={l} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} color={c.mute}>{l}</T><T size={13} weight="700">{moneyIn(n, x.currency)}</T></View>
              ))}
              {x.pos.by_tender.map((tn) => <T key={tn.method} size={12} color={c.mute}>{t(`vf.tender.${tn.method}`)}: {moneyIn(tn.taken_cents - tn.refunded_cents, x.currency)}</T>)}
              {x.unposted_online.tenders ? <T size={12} color={c.red}>{t('vf.inc.unposted', { n: x.unposted_online.tenders })}</T> : null}
            </Card>
          ))}
          <Card pad={12}>
            <T weight="800">{t('vf.inc.till')}</T>
            <T size={13} color={c.mute}>{t('vf.inc.till_line', { closed: d.till.closed, variance: moneyIn(Number(d.till.variance_cents), v.currency) })}</T>
            {d.till.pending_review ? <T size={12} color={c.red}>{t('vf.inc.pending', { n: d.till.pending_review })}</T> : null}
          </Card>
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ multi-venue operations (a section of "All my venues")
export function NetworkOps({ from, to }) {
  const q = useLoad(() => api.get('/venue-network', { from, to }), [from, to]);
  const d = q.data;
  if (q.loading && !d) return <Loading />;
  if (q.error || !d?.venues.length) return null;
  const a = d.attention;
  return (
    <Section title={t('vf.net.title')} color={c.cyan}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <StatPill label={t('vf.net.overdue')} value={String(a.maintenance_overdue)} /><StatPill label={t('vf.net.urgent')} value={String(a.urgent_work_orders)} />
        <StatPill label={t('vf.net.incidents')} value={String(a.serious_incidents)} /><StatPill label={t('vf.net.not_ready')} value={String(a.areas_not_ready)} />
      </View>
      {d.venues.map((x) => (
        <Card key={x.id} pad={12}>
          <T weight="800">{x.name}</T>
          <T size={12} color={c.mute}>{[x.city, x.currency, x.utilisation != null ? t('vf.net.util', { pct: Math.round(x.utilisation * 100) }) : null, moneyIn(x.revenue_cents, x.currency)].filter(Boolean).join(' · ')}</T>
          <T size={12} color={c.mute}>{t('vf.net.line', { open: x.maintenance.open, overdue: x.maintenance.overdue, inc: x.incidents.open, nr: x.readiness.not_ready, ci: x.check_ins.today, shift: x.on_shift })}</T>
        </Card>
      ))}
    </Section>
  );
}
