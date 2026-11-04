// Academy safety & pickup (#788): the staff desk for one session (arrival, attendance and handover as separate facts, guardian-confirmed custody,
// offline-safe) and the management oversight (metrics, trend, exceptions, late pickups, collectors, offline queue, escalation settings).
// Every rule is enforced by the API (capabilities academy-pickup.js / guardian-pickup.js); this screen only calls it. All text goes through t().
import React, { useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { CameraScan, hasCamera } from '../camera-scan';
import { c } from '../theme';
import { locale } from '../locale';
import { Bars, Block, Initials, Kpi } from './academy-ui';
import { isOffline, newKey, flushQueue, dismissItem, queueHandover, useQueue } from '../pickup-queue';

// ------------------------------------------------------------------------------------------------------------------ words
const phaseInfo = () => ({
  expected: [t('pk.phase_expected'), c.violetSoft], no_show: [t('pk.phase_no_show'), c.red], in_care: [t('pk.phase_in_care'), c.mint], pending_confirmation: [t('pk.phase_pending'), c.sun], late: [t('pk.phase_late'), c.sun],
  handed_over: [t('pk.phase_handed'), c.pinkSoft], disputed: [t('pk.phase_disputed'), c.red], attending: [t('pk.phase_attending'), c.mint], absent: [t('pk.phase_absent'), c.violetSoft], excused: [t('pk.phase_excused'), c.violetSoft], not_held: [t('pk.phase_not_held'), c.violetSoft],
});
const reasonText = (code) => ({
  not_on_list: t('pk.r_not_on_list'), revoked: t('pk.r_revoked'), expired: t('pk.r_expired'), already_used: t('pk.r_already_used'), outside_allowed_time: t('pk.r_outside_time'), guardian_pickup_scope_withheld: t('pk.r_scope'),
  passphrase_missing: t('pk.r_phrase_missing'), passphrase_wrong: t('pk.r_phrase_wrong'), verify_identity: t('pk.r_verify'), choose_collector: t('pk.r_choose'), no_guardian_permission_walks_home: t('pk.r_no_walk'), no_guardian_permission_transport: t('pk.r_no_transport'),
}[code] ?? t('pk.r_unknown'));
const kindText = (k) => ({
  blocked_pickup: t('pk.k_blocked'), late_pickup: t('pk.k_late'), no_show: t('pk.k_no_show'), override: t('pk.k_override'), unconfirmed_handover: t('pk.k_unconfirmed'), disputed_handover: t('pk.k_disputed'),
  offline_conflict: t('pk.k_offline'), welfare_concern: t('pk.k_welfare'), incident: t('pk.k_incident'),
}[k] ?? k);
const tick = (text) => `✓ ${text}`;
const evTitle = (e) => `${kindText(e.kind)} · ${e.athlete_name}`;
const sevColor = (s) => (s === 'high' ? c.red : s === 'medium' ? c.sun : c.violetSoft);
const sevText = (s) => ({ high: t('pk.sev_high'), medium: t('pk.sev_medium'), low: t('pk.sev_low') }[s] ?? s);
const statusText = (s) => ({ open: t('pk.st_open'), acknowledged: t('pk.st_ack'), escalated: t('pk.st_escalated'), resolved: t('pk.st_resolved') }[s] ?? s);
const modeText = (m) => ({ collected: t('pk.mode_collected'), walks_home: t('pk.mode_walks'), transport: t('pk.mode_transport') }[m] ?? m);
const relText = (r) => ({ parent: t('pk.rel_parent'), grandparent: t('pk.rel_grandparent'), sibling: t('pk.rel_sibling'), relative: t('pk.rel_relative'), family_friend: t('pk.rel_family_friend'), neighbour: t('pk.rel_neighbour'), driver: t('pk.rel_driver'), transport_service: t('pk.rel_transport_service'), other: t('pk.rel_other') }[r] ?? r);
export { relText };
const hhmm = (iso) => { try { return new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

/** Arrival, attendance, ready, handed over: four steps whose state is also written out, never colour alone. */
function Steps({ a }) {
  const arrived = ['present', 'late', 'left_early'].includes(a.attendance);
  const done = a.phase === 'handed_over';
  const bad = ['no_show', 'disputed'].includes(a.phase);
  const warn = a.phase === 'late' || a.phase === 'pending_confirmation';
  const segs = [arrived ? c.lime : bad ? c.red : c.line, arrived ? c.lime : bad ? c.red : c.line, done ? c.lime : warn ? c.sun : arrived ? c.pink : bad ? c.red : c.line, done ? c.lime : bad ? c.red : c.line];
  return <View accessible accessibilityLabel={t('pk.steps_a11y')} style={{ flexDirection: 'row', gap: 4, marginTop: 6 }}>{segs.map((col, i) => <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: col }} />)}</View>;
}

// ------------------------------------------------------------------------------------------------------------------ the session desk
function useBoard(sessionId) {
  const cache = useRef(null);
  const d = useLoad(() => api.get(`/academy/sessions/${sessionId}/pickup`).then((r) => { cache.current = r; return r; }), [sessionId]);
  useEffect(() => { const id = setInterval(() => d.reload?.(), 30000); return () => clearInterval(id); }, [sessionId]);
  const offline = !!d.error && isOffline(d.error) && !!cache.current;
  return { ...d, data: d.data ?? (offline ? cache.current : null), offline };
}

export function PickupTab({ s }) {
  const { toast, user } = useSession();
  const { tablet } = useLayout();
  const b = useBoard(s.id);
  const queue = useQueue(user.id);
  const [open, setOpen] = useState(null);
  const [report, setReport] = useState(null);
  const [contacts, setContacts] = useState(null);
  useEffect(() => { if (!b.offline && queue.some((x) => x.state === 'waiting')) flushQueue().then(() => b.reload?.()).catch(() => {}); }, [b.offline, queue.length]);
  if (b.error && !b.data) return <LoadError error={b.error} onRetry={b.reload} />;
  if (!b.data) return <Loading />;
  const board = b.data, P = phaseInfo();
  const k = board.kpis;
  const mine = queue.filter((x) => x.session_id === s.id);
  const act = async (fn, ok) => { try { await fn(); toast(ok); b.reload(); } catch (e) { toast(explain(e)); } };
  const panel = open ? <HandoverPanel s={s} a={open} board={board} onClose={() => setOpen(null)} onDone={() => { setOpen(null); b.reload(); }} /> : null;
  const roster = (
    <View style={{ gap: 4, flex: 1, minWidth: 0 }}>
      {board.athletes.length === 0 ? <Empty emoji="🧒" title={t('pk.empty_roster_title')} sub={t('pk.empty_roster_sub')} /> : board.athletes.map((a) => {
        const [label, tone] = P[a.phase] ?? [a.phase, c.violetSoft];
        const level = a.handover?.escalation_level ?? 0;
        return (
          <Card key={a.user_id} pad={14}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Initials name={a.display_name} user={a} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800">{a.display_name}</T><Tag label={a.phase === 'late' ? t('pk.late_by', { n: a.minutes_late }) : label} color={tone} /></View>
                <T size={12} color={c.mute}>
                  {a.arrived_at ? t('pk.arrived_at', { time: hhmm(a.arrived_at) }) : t('pk.not_arrived')}
                  {a.handover?.state === 'handed_over' ? ` · ${t('pk.handed_at', { time: hhmm(a.handover.handed_over_at) })} · ${modeText(a.handover.mode)}` : ''}
                  {a.handover?.checks?.length ? ` · ${t('pk.checks_n', { n: a.handover.checks.length })}` : ''}
                  {level ? ` · ${t('pk.escalation', { n: level })}` : ''}
                  {a.handover?.offline ? ` · ${t('pk.recorded_offline')}` : ''}
                </T>
                {a.needs_handover ? <Steps a={a} /> : null}
              </View>
            </View>
            {a.needs_handover ? (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10, justifyContent: 'flex-end' }}>
                {['in_care', 'late', 'pending_confirmation'].includes(a.phase) ? <Btn small title={t('pk.btn_call')} color={c.paper} ink={c.ink} onPress={async () => { try { setContacts(await api.get(`/academy/sessions/${s.id}/pickup/contacts`, { athlete_id: a.user_id })); } catch (e) { toast(explain(e)); } }} /> : null}
                {a.phase === 'late' || (a.phase === 'pending_confirmation' && a.minutes_late > 0) ? <Btn small title={level >= 3 ? t('pk.btn_escalated') : t('pk.btn_escalate')} color={c.paper} ink={c.ink} disabled={level >= 3} onPress={() => act(() => api.post(`/academy/sessions/${s.id}/pickup/escalate`, { athlete_id: a.user_id, level: Math.min(3, Math.max(1, level + 1)) }), t('pk.escalated_ok'))} /> : null}
                {['in_care', 'late', 'pending_confirmation', 'disputed'].includes(a.phase) ? <Btn small title={a.phase === 'pending_confirmation' ? t('pk.btn_override') : t('pk.btn_handover')} onPress={() => setOpen(a)} accessibilityLabel={t('pk.btn_handover_a11y', { name: a.display_name })} /> : null}
                {['no_show', 'in_care', 'late', 'disputed'].includes(a.phase) ? <Btn small title={t('pk.btn_report')} color={c.paper} ink={c.red} onPress={() => setReport(a)} /> : null}
              </View>
            ) : null}
          </Card>
        );
      })}
    </View>
  );
  return (
    <View style={{ gap: 12 }}>
      {b.offline ? <Card color={c.sunSoft} pad={12}><T weight="800">{t('pk.offline_title')}</T><T size={13} color={c.mute}>{t('pk.offline_sub', { time: hhmm(board.issued_at) })}</T></Card> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('pk.kpi_expected')} value={k.expected} /><Kpi label={t('pk.kpi_arrived')} value={k.arrived} /><Kpi label={t('pk.kpi_in_care')} value={k.in_care} sub={k.pending_confirmation ? t('pk.kpi_waiting', { n: k.pending_confirmation }) : undefined} />
        <Kpi label={t('pk.kpi_handed')} value={k.handed_over} /><Kpi label={t('pk.kpi_late')} value={k.late} tone={k.late ? 'alert' : undefined} /><Kpi label={t('pk.kpi_exceptions')} value={k.exceptions} tone={k.exceptions ? 'alert' : undefined} />
      </View>
      <T size={12} color={c.mute}>{t('pk.policy_line', { a: board.policy.late_after_min, b: board.policy.second_after_min, c: board.policy.officer_after_min })} · {board.policy.require_guardian_confirmation ? t('pk.confirm_required') : t('pk.confirm_not_required')}</T>
      {mine.length ? <QueueCard items={mine} toast={toast} onChange={b.reload} /> : null}
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
        {roster}
        {tablet && panel ? <View style={{ width: 340 }}>{panel}</View> : null}
      </View>
      {!tablet ? <Sheet visible={!!open} onClose={() => setOpen(null)} title={open ? t('pk.panel_title', { name: open.display_name }) : ''}>{panel}</Sheet> : null}
      <ContactsSheet data={contacts} onClose={() => setContacts(null)} />
      <ReportSheet open={!!report} athlete={report} orgId={s.organisation_id} sessionId={s.id} onClose={() => setReport(null)} onDone={b.reload} />
    </View>
  );
}

function QueueCard({ items, toast, onChange }) {
  return (
    <Card color={c.sunSoft} pad={12}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <T weight="800">{t('pk.queue_title', { n: items.length })}</T>
        <Btn small title={t('pk.queue_send')} onPress={async () => { try { await flushQueue(); onChange?.(); } catch (e) { toast(explain(e)); } }} />
      </View>
      <T size={12} color={c.mute}>{t('pk.queue_sub')}</T>
      {items.map((x) => (
        <View key={x.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center', paddingTop: 8, flexWrap: 'wrap' }}>
          <T size={13} style={{ flex: 1 }}>{x.label} · {hhmm(x.at)}</T>
          {x.state === 'conflict' ? <><Tag label={t('pk.queue_conflict')} color={c.red} /><Btn small title={t('pk.queue_dismiss')} color={c.paper} ink={c.ink} onPress={() => dismissItem(x.id)} /></> : <Tag label={t('pk.queue_waiting')} color={c.sun} />}
          {x.state === 'conflict' && x.message ? <T size={12} color={c.mute} style={{ width: '100%' }}>{x.message}</T> : null}
        </View>
      ))}
    </Card>
  );
}

function ContactsSheet({ data, onClose }) {
  return (
    <Sheet visible={!!data} onClose={onClose} title={t('pk.contacts_title')}>
      <T size={12} color={c.mute}>{t('pk.contacts_help')}</T>
      {[...(data?.guardians ?? []), ...(data?.emergency ?? [])].map((p, i) => (
        <Row key={i} title={p.name ?? t('pk.unnamed')} sub={[p.relationship, p.phone].filter(Boolean).join(' · ') || t('pk.no_phone')}
          right={p.phone ? <Btn small title={t('pk.call')} onPress={() => Linking.openURL(`tel:${String(p.phone).replace(/[^+\d]/g, '')}`)} accessibilityLabel={t('pk.call_a11y', { name: p.name ?? '' })} /> : null} />
      ))}
      {!data?.guardians?.length && !data?.emergency?.length ? <Empty emoji="📵" title={t('pk.no_contacts')} sub={t('pk.no_contacts_sub')} /> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ hand over
function HandoverPanel({ s, a, board, onClose, onDone }) {
  const { toast, user } = useSession();
  const key = useRef(newKey());
  const opts = a.collectors.map((x, i) => ({ value: String(i), label: `${x.name ?? t('pk.unnamed')} · ${x.kind === 'guardian' ? t('pk.guardian') : x.relationship ? relText(x.relationship) : t('pk.collector')}`, sub: x.needs_passphrase ? t('pk.needs_phrase') : undefined }));
  const [who, setWho] = useState(opts.length === 1 ? '0' : '');
  const [mode, setMode] = useState('collected');
  const [phrase, setPhrase] = useState('');
  const [code, setCode] = useState('');
  const [cam, setCam] = useState(false);
  const [attested, setAttested] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [override, setOverride] = useState(a.phase === 'pending_confirmation');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(null);
  const col = who === '' ? null : a.collectors[Number(who)];
  const payload = () => ({
    athlete_id: a.user_id, mode, collector_user_id: mode === 'collected' ? col?.user_id ?? undefined : undefined, delegate_id: mode === 'collected' && !col?.user_id ? col?.delegate_id : undefined,
    passphrase: phrase || undefined, pass_token: code.trim() || undefined, attested,
  });
  const toggle = (x) => setAttested((p) => (p.includes(x) ? p.filter((y) => y !== x) : [...p, x]));
  const verify = async () => {
    setBusy(true); setBlocked(null);
    try { setVerdict(await api.post(`/academy/sessions/${s.id}/pickup/verify`, payload())); } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true);
    const body = { ...payload(), idempotency_key: key.current, override_reason: override && why.trim().length >= 10 ? why.trim() : undefined };
    try {
      const r = await api.post(`/academy/sessions/${s.id}/pickup/handover`, body);
      toast(r.awaiting_guardian ? t('pk.done_waiting') : t('pk.done_ok'));
      onDone();
    } catch (e) {
      if (isOffline(e)) { await queueHandover(user.id, s.id, `${a.display_name} · ${modeText(mode)}`, { ...body, captured_at: new Date().toISOString() }); toast(t('pk.saved_offline')); onDone(); }
      else if (e.status === 403) setBlocked(e);
      else toast(explain(e));
    } finally { setBusy(false); }
  };
  const ok = verdict?.ok;
  const need = mode === 'collected' ? !!col : true;
  return (
    <Card pad={14}>
      <T weight="800" size={16}>{t('pk.panel_title', { name: a.display_name })}</T>
      {blocked ? (
        <Card color={c.redSoft} pad={12}><T weight="800" color={c.red}>{t('pk.blocked_title')}</T><T size={13}>{t('pk.blocked_sub')}</T><T size={12} color={c.mute}>{(blocked.details?.reasons ?? []).map(reasonText).join(' · ')}</T></Card>
      ) : null}
      <T weight="800" size={13} style={{ marginTop: 8 }}>{t('pk.departure')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{['collected', 'walks_home', 'transport'].map((m) => <Chip key={m} label={modeText(m)} active={mode === m} onPress={() => { setMode(m); setVerdict(null); }} />)}</View>
      {mode === 'collected' ? (
        <>
          {opts.length ? <MenuField label={t('pk.who')} value={who} onChange={(v) => { setWho(v); setVerdict(null); }} options={opts} placeholder={t('pk.who_ph')} /> : <Card color={c.sunSoft} pad={10}><T size={13}>{t('pk.no_collectors')}</T></Card>}
          {col?.needs_passphrase ? <Field label={t('pk.phrase')} value={phrase} onChangeText={setPhrase} secure accessibilityLabel={t('pk.phrase')} /> : null}
          <T weight="800" size={13}>{t('pk.checks')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {hasCamera ? <Chip label={cam ? t('pk.close_camera') : t('pk.scan_qr')} active={!!code || cam} onPress={() => setCam((v) => !v)} /> : null}
            <Chip label={t('pk.id_seen')} active={attested.includes('id_seen')} onPress={() => toggle('id_seen')} />
            <Chip label={t('pk.photo_match')} active={attested.includes('photo_match')} onPress={() => toggle('photo_match')} />
          </View>
          {cam && hasCamera ? <CameraScan onCode={(x) => { setCode(x); setCam(false); setVerdict(null); }} onClose={() => setCam(false)} /> : null}
          <Field label={t('pk.qr_code')} value={code} onChangeText={(x) => { setCode(x); setVerdict(null); }} placeholder={t('pk.qr_ph')} accessibilityLabel={t('pk.qr_code')} />
        </>
      ) : <T size={13} color={c.mute}>{t('pk.standing_permission')}</T>}
      {verdict ? (
        <View style={{ gap: 6, marginTop: 4 }}>
          {ok ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Tag label={tick(t('pk.tick_authorised'))} color={c.mint} />{verdict.checks.includes('qr') ? <Tag label={tick(t('pk.tick_qr'))} color={c.mint} /> : null}{verdict.checks.includes('passphrase') ? <Tag label={tick(t('pk.tick_phrase'))} color={c.mint} /> : null}
            {verdict.checks.includes('id_seen') ? <Tag label={tick(t('pk.id_seen'))} color={c.mint} /> : null}{verdict.checks.includes('photo_match') ? <Tag label={tick(t('pk.photo_match'))} color={c.mint} /> : null}
          </View> : <Card color={c.redSoft} pad={10}><T weight="800" color={c.red}>{t('pk.not_authorised')}</T><T size={13}>{verdict.reasons.map(reasonText).join(' · ')}</T></Card>}
        </View>
      ) : null}
      {ok && board.policy.require_guardian_confirmation ? (
        <View style={{ gap: 6 }}>
          <Chip label={t('pk.override_toggle')} active={override} onPress={() => setOverride((v) => !v)} />
          {override ? <Field label={t('pk.override_reason')} value={why} onChangeText={setWhy} multiline hint={t('pk.override_hint')} accessibilityLabel={t('pk.override_reason')} /> : <T size={12} color={c.mute}>{t('pk.guardian_asked')}</T>}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title={t('pk.verify')} color={c.violet} loading={busy} disabled={!need} onPress={verify} />
        <Btn title={t('pk.confirm_handover', { time: hhmm(new Date().toISOString()) })} loading={busy} disabled={!need || !ok || (override && why.trim().length < 10 && board.policy.require_guardian_confirmation && a.phase === 'pending_confirmation')} onPress={confirm} style={{ flex: 1 }} />
        <Btn small title={t('common.cancel')} color={c.paper} ink={c.ink} onPress={onClose} />
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------------ report
function ReportSheet({ open, athlete, orgId, sessionId, onClose, onDone }) {
  return (
    <FormSheet visible={open} onClose={onClose} title={athlete ? t('pk.report_title', { name: athlete.display_name }) : ''} submitLabel={t('pk.report_submit')}
      fields={[
        { key: 'kind', label: t('pk.report_kind'), type: 'chips', options: [{ value: 'welfare_concern', label: t('pk.k_welfare') }, { value: 'incident', label: t('pk.k_incident') }], default: 'welfare_concern' },
        { key: 'severity', label: t('pk.report_severity'), type: 'chips', options: [{ value: 'low', label: t('pk.sev_low') }, { value: 'medium', label: t('pk.sev_medium') }, { value: 'high', label: t('pk.sev_high') }], default: 'medium' },
        { key: 'summary', label: t('pk.report_summary'), type: 'multiline', hint: t('pk.report_hint') },
      ]}
      initial={{ kind: 'welfare_concern', severity: 'medium' }}
      onSubmit={async (v) => { await api.post(`/organisations/${orgId}/academy/safety/events`, { athlete_id: athlete.user_id, session_id: sessionId, kind: v.kind, severity: v.severity, summary: v.summary }); onDone?.(); return t('pk.report_done'); }} />
  );
}

// ------------------------------------------------------------------------------------------------------------------ management oversight
const TABS = () => [['overview', t('pk.tab_overview')], ['exceptions', t('pk.tab_exceptions')], ['late', t('pk.tab_late')], ['collectors', t('pk.tab_collectors')], ['offline', t('pk.tab_offline')]];
const LATE_KINDS = ['late_pickup', 'no_show', 'unconfirmed_handover'];

export function SafetyDesk({ o, role, toast }) {
  const [tab, setTab] = useState('overview');
  const { tablet } = useLayout();
  const admin = role === 'owner' || role === 'admin';
  const ov = useLoad(() => api.get(`/organisations/${o.id}/academy/safety`), [o.id]);
  const tabs = [...TABS(), ...(admin ? [['settings', t('pk.tab_settings')]] : [])];
  if (ov.error) return <LoadError error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <Loading />;
  const d = ov.data, k = d.kpis;
  const anyLate = d.trend.some((x) => x.late_pickups > 0);
  return (
    <View style={{ gap: 12 }}>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('pk.title')}</T><T color={c.mute}>{t('pk.subtitle')}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{tabs.map(([key, label]) => <Chip key={key} label={label} active={tab === key} onPress={() => setTab(key)} />)}</View>
      {tab === 'overview' ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Kpi label={t('pk.m_on_site')} value={k.on_site} /><Kpi label={t('pk.m_on_time')} value={k.on_time_pct == null ? '–' : `${k.on_time_pct}%`} /><Kpi label={t('pk.m_late')} value={k.late_pickups_today} tone={k.late_pickups_today ? 'alert' : undefined} />
            <Kpi label={t('pk.m_no_show')} value={k.no_shows_today} tone={k.no_shows_today ? 'alert' : undefined} /><Kpi label={t('pk.m_pending')} value={k.pending_confirmation} /><Kpi label={t('pk.m_verified')} value={k.verified_handover_pct == null ? '–' : `${k.verified_handover_pct}%`} />
            <Kpi label={t('pk.m_open')} value={k.open_events} tone={k.open_events ? 'alert' : undefined} />
          </View>
          <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
            <Card style={{ flex: 1, width: tablet ? undefined : '100%' }}>
              <Block title={t('pk.trend_title', { n: d.trend.length })}>
                {anyLate ? <Bars label={t('pk.trend_title', { n: d.trend.length })} rows={d.trend.map((x) => ({ label: x.week, value: x.late_pickups, text: String(x.late_pickups) }))} /> : <Empty emoji="📈" title={t('pk.trend_empty_title')} sub={t('pk.trend_empty_sub')} />}
              </Block>
            </Card>
            <Card style={{ flex: 1, width: tablet ? undefined : '100%' }}>
              <Block title={t('pk.queue_head')}>
                <EventRows rows={d.queue} empty={t('pk.queue_empty')} detail={d.can_see_details} o={o} toast={toast} reload={ov.reload} />
              </Block>
            </Card>
          </View>
          <Card color={c.violetSoft} pad={12}><T size={13}>{t('pk.ladder', { a: d.policy.late_after_min, b: d.policy.second_after_min, c: d.policy.officer_after_min })}</T><T size={12} color={c.mute}>{t('pk.ladder_privacy')}</T>{d.policy.is_default ? <T size={12} color={c.mute}>{t('pk.ladder_default')}</T> : null}</Card>
        </>
      ) : null}
      {tab === 'exceptions' ? <EventList o={o} toast={toast} detail={d.can_see_details} reload={ov.reload} /> : null}
      {tab === 'late' ? <EventList o={o} toast={toast} detail={d.can_see_details} kinds={LATE_KINDS} reload={ov.reload} /> : null}
      {tab === 'offline' ? <><OfflineHere /><EventList o={o} toast={toast} detail={d.can_see_details} kinds={['offline_conflict']} reload={ov.reload} /></> : null}
      {tab === 'collectors' ? (
        <Card>
          <Block title={t('pk.cov_title')}>
            <Kpi label={t('pk.cov_youth')} value={d.coverage.youth_athletes} wide />
            <Kpi label={t('pk.cov_without')} value={d.coverage.without_live_guardian_pickup} tone={d.coverage.without_live_guardian_pickup ? 'alert' : undefined} sub={t('pk.cov_sub')} wide />
            {d.coverage.athletes_without_guardian.length ? d.coverage.athletes_without_guardian.map((x) => <Row key={x.athlete_id} title={x.display_name} sub={t('pk.cov_row')} />) : <Empty emoji="✅" title={t('pk.cov_ok_title')} sub={t('pk.cov_ok_sub')} />}
          </Block>
        </Card>
      ) : null}
      {tab === 'settings' && admin ? <PolicyForm o={o} toast={toast} onSaved={ov.reload} /> : null}
    </View>
  );
}

function OfflineHere() {
  const { user, toast } = useSession();
  const q = useQueue(user.id);
  return q.length ? <QueueCard items={q} toast={toast} /> : <Card pad={12}><T size={13} color={c.mute}>{t('pk.offline_clear')}</T></Card>;
}

function EventRows({ rows, empty, detail, o, toast, reload }) {
  const [open, setOpen] = useState(null);
  if (!rows.length) return <Empty emoji="🛡️" title={empty} sub={t('pk.events_empty_sub')} />;
  return (
    <View style={{ gap: 4 }}>
      {rows.map((e) => (
        <Row key={e.id} title={evTitle(e)} sub={`${e.session_title ? `${e.session_title} · ` : ''}${new Date(e.opened_at).toLocaleString(locale)}`} onPress={() => setOpen(e)}
          right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Tag label={sevText(e.severity)} color={sevColor(e.severity)} /><Tag label={statusText(e.status)} /></View>} />
      ))}
      <EventSheet ev={open} detail={detail} onClose={() => setOpen(null)} toast={toast} onChanged={() => { setOpen(null); reload?.(); }} o={o} />
    </View>
  );
}

function EventList({ o, toast, detail, kinds, reload }) {
  const [status, setStatus] = useState('unresolved');
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/safety/events`, { status, limit: 100 }), [o.id, status]);
  const rows = (d.data ?? []).filter((e) => !kinds || kinds.includes(e.kind));
  return (
    <Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{[['unresolved', t('pk.f_open')], ['resolved', t('pk.st_resolved')]].map(([k, l]) => <Chip key={k} label={l} active={status === k} onPress={() => setStatus(k)} />)}</View>
      {d.error ? <LoadError error={d.error} onRetry={d.reload} /> : !d.data ? <Loading /> : <EventRows rows={rows} empty={t('pk.events_empty')} detail={detail} o={o} toast={toast} reload={() => { d.reload(); reload?.(); }} />}
    </Card>
  );
}

function EventSheet({ ev, detail, onClose, toast, onChanged }) {
  const full = useLoad(() => (ev && detail ? api.get(`/academy/safety/events/${ev.id}`) : Promise.resolve(null)), [ev?.id, detail]);
  const [resolve, setResolve] = useState(false);
  const run = async (action, note) => { try { await api.patch(`/academy/safety/events/${ev.id}`, { action, note }); toast(t('pk.event_updated')); onChanged(); } catch (e) { toast(explain(e)); } };
  const f = full.data;
  return (
    <Sheet visible={!!ev} onClose={onClose} title={ev ? evTitle(ev) : ''}>
      {ev ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={sevText(ev.severity)} color={sevColor(ev.severity)} /><Tag label={statusText(ev.status)} /></View>
          {!detail ? <Card color={c.violetSoft} pad={12}><T size={13}>{t('pk.restricted')}</T></Card> : full.error ? <LoadError error={full.error} /> : !f ? <Loading /> : (
            <>
              {f.summary ? <Card color={c.violetSoft} pad={12}><T weight="800" size={13}>{t('pk.notes')}</T><T size={14}>{f.summary}</T></Card> : null}
              {f.resolution ? <Card color={c.limeSoft} pad={12}><T weight="800" size={13}>{t('pk.resolution')}</T><T size={14}>{f.resolution}</T></Card> : null}
              <Block title={t('pk.history')}>{f.history.map((h, i) => <T key={i} size={12} color={c.mute}>{new Date(h.created_at).toLocaleString(locale)} · {h.actor_name ?? t('pk.system')} · {h.kind}</T>)}</Block>
              {ev.status !== 'resolved' ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {ev.status === 'open' ? <Btn small title={t('pk.ack')} color={c.violet} onPress={() => run('acknowledge')} /> : null}
                  {ev.status !== 'escalated' ? <Btn small title={t('pk.escalate_event')} color={c.paper} ink={c.red} onPress={() => run('escalate')} /> : null}
                  <Btn small title={t('pk.resolve')} onPress={() => setResolve(true)} />
                </View>
              ) : null}
            </>
          )}
        </View>
      ) : null}
      <FormSheet visible={resolve} onClose={() => setResolve(false)} title={t('pk.resolve')} submitLabel={t('pk.resolve')} fields={[{ key: 'note', label: t('pk.resolve_note'), type: 'multiline', hint: t('pk.report_hint') }]}
        onSubmit={async (v) => { await api.patch(`/academy/safety/events/${ev.id}`, { action: 'resolve', note: v.note }); onChanged(); return t('pk.event_updated'); }} />
    </Sheet>
  );
}

function PolicyForm({ o, toast, onSaved }) {
  const p = useLoad(() => api.get(`/organisations/${o.id}/academy/safety/policy`), [o.id]);
  const staff = useLoad(() => api.get(`/organisations/${o.id}/members`).catch(() => []), [o.id]);
  const [open, setOpen] = useState(false);
  if (p.error) return <LoadError error={p.error} onRetry={p.reload} />;
  if (!p.data) return <Loading />;
  const d = p.data;
  const people = (Array.isArray(staff.data) ? staff.data : staff.data?.members ?? []).filter((m) => m.status === 'active');
  return (
    <Card>
      <Block title={t('pk.policy_title')} right={<Btn small title={t('pk.policy_edit')} onPress={() => setOpen(true)} />}>
        <Row title={t('pk.p_late')} sub={t('pk.minutes', { n: d.late_after_min })} /><Row title={t('pk.p_second')} sub={t('pk.minutes', { n: d.second_after_min })} /><Row title={t('pk.p_officer')} sub={t('pk.minutes', { n: d.officer_after_min })} />
        <Row title={t('pk.p_no_show')} sub={t('pk.minutes', { n: d.no_show_after_min })} /><Row title={t('pk.p_confirm_timeout')} sub={t('pk.minutes', { n: d.confirm_timeout_min })} />
        <Row title={t('pk.p_require')} sub={d.require_guardian_confirmation ? t('pk.yes') : t('pk.no')} />
        {d.is_default ? <T size={12} color={c.mute}>{t('pk.ladder_default')}</T> : <T size={12} color={c.mute}>{t('pk.policy_version', { n: d.version })}</T>}
      </Block>
      <FormSheet visible={open} onClose={() => setOpen(false)} title={t('pk.policy_title')} submitLabel={t('common.save')}
        initial={{ late_after_min: d.late_after_min, second_after_min: d.second_after_min, officer_after_min: d.officer_after_min, no_show_after_min: d.no_show_after_min, confirm_timeout_min: d.confirm_timeout_min, require_guardian_confirmation: d.require_guardian_confirmation, safeguarding_officer_id: d.safeguarding_officer_id ?? '' }}
        fields={[
          { key: 'late_after_min', label: t('pk.p_late'), type: 'stepper', min: 1, max: 240, step: 5, suffix: ` ${t('pk.min')}` },
          { key: 'second_after_min', label: t('pk.p_second'), type: 'stepper', min: 1, max: 480, step: 5, suffix: ` ${t('pk.min')}` },
          { key: 'officer_after_min', label: t('pk.p_officer'), type: 'stepper', min: 1, max: 720, step: 5, suffix: ` ${t('pk.min')}` },
          { key: 'no_show_after_min', label: t('pk.p_no_show'), type: 'stepper', min: 1, max: 240, step: 5, suffix: ` ${t('pk.min')}` },
          { key: 'confirm_timeout_min', label: t('pk.p_confirm_timeout'), type: 'stepper', min: 1, max: 120, step: 5, suffix: ` ${t('pk.min')}` },
          { key: 'require_guardian_confirmation', label: t('pk.p_require'), type: 'switch', hint: t('pk.p_require_hint') },
          { key: 'safeguarding_officer_id', label: t('pk.p_officer_person'), type: 'chips', optional: true, options: [{ value: '', label: t('pk.p_officer_auto') }, ...people.map((m) => ({ value: m.user_id ?? m.id, label: m.display_name ?? m.handle }))], hint: t('pk.p_officer_hint') },
        ]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/safety/policy`, { ...v, safeguarding_officer_id: v.safeguarding_officer_id || null }); p.reload(); onSaved?.(); return t('pk.policy_saved'); }} />
    </Card>
  );
}
