// Smart attendance & access (#510): the shared screens for every place people check in. All the rules are in the API (src/access-layer.js);
// this only calls it, so iOS, iPadOS, Android and the web behave the same and an AI agent over MCP sees the same thing.
//   ScanPanel      staff: scan a rotating pass (camera, or a hardware scanner that types), tap a card or tag, or record by hand with a reason
//   PassSheet      the person (or their guardian): a rotating QR that changes every 30 seconds
//   SiteCodeSheet  staff: the door code to show on a tablet so people can check themselves in
//   HeldList       staff: captures held for review (geofence miss, no location, a differing staff mark)
//   MyCards        RFID / NFC cards, tags and wristbands registered to me (or my child)
//   AccessPoints   doors, gates and readers of a venue or event, with grants
//   AccessInsights anomalies and the report, evidence kept apart from the final record
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { useSession } from './session';
import { explain, LoadError } from './access';
import { Btn, Card, Chip, Empty, Loading, Row, Sheet, T, Tag } from './ui';
import { FormSheet } from './FormSheet';
import { c } from './theme';
import { CameraScan, hasCamera } from './camera-scan';
import { QrCode } from './screens/passport';
import { checkOffline, readToken } from './access-crypto';
import { t } from './i18n';
import { fmtDate, fmtDateTime, fmtTime } from './locale';

const key = () => `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const clock = (d) => (d ? fmtTime(d) : '');
const nice = (s) => String(s ?? '').replace(/_/g, ' ');

export const VERDICT = {
  recorded: ['✓', t('access.v_recorded'), '#15803D'], granted: ['✓', t('access.v_admit'), '#15803D'], denied: ['✕', t('access.v_denied'), '#B91C1C'],
  pending_review: ['⏸', t('access.v_held'), '#B45309'], provider_unavailable: ['⚠', t('access.v_door'), '#B91C1C'],
};
const REASON_LABEL = { roster_tap: t('access.r_roster'), device_failure: t('access.r_device'), network_failure: t('access.r_network'), forgot_credential: t('access.r_forgot'), guardian_present: t('access.r_guardian'), correction: t('access.r_correction'), other: t('access.r_other') };
const REASONS_FOR_DESK = ['device_failure', 'network_failure', 'forgot_credential', 'guardian_present', 'other'];
const METHOD_LABEL = { qr: t('access.m_pass'), nfc: t('access.m_card'), rfid: t('access.m_card'), manual: t('access.m_hand'), self: t('access.m_self'), geo: t('access.m_geo') };

const useOptions = () => useLoad(() => api.get('/access/options'), []);

/** The outcome of one presentation: colour, a symbol and words (never colour alone), the person, and what to do next. */
export function VerdictCard({ cap, onRelease }) {
  if (!cap) return null;
  const [icon, word, tone] = cap.verdict === 'recorded' && cap.reason_code === 'already_recorded' ? ['✓', t('access.v_already'), '#15803D'] : VERDICT[cap.verdict] ?? ['•', cap.verdict, '#475569'];
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="assertive" accessibilityLabel={`${word}. ${cap.person?.display_name ?? ''}. ${cap.message ?? ''}`} style={{ borderRadius: 24, backgroundColor: tone, padding: 18, gap: 8 }}>
      <T size={26} weight="800" color="#fff" style={{ letterSpacing: 0.5 }}>{icon} {word}</T>
      {cap.person ? <T size={20} weight="800" color="#fff">{cap.person.display_name}{cap.person.youth ? `  · ${t('access.under18')}` : ''}</T> : <T size={16} weight="700" color="#fff">{t('access.nobody')}</T>}
      {cap.booking ? <T size={15} weight="700" color="#fff">{cap.booking.resource_name} · {new Date(cap.booking.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: cap.booking.timezone })}–{new Date(cap.booking.ends_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: cap.booking.timezone })}</T> : null}
      {cap.message ? <T size={15} weight="700" color="#fff">{cap.message}</T> : null}
      {cap.flags?.includes('offline') ? <T size={13} weight="800" color="#fff">{t('access.offline_note')}</T> : null}
      {cap.release_candidates?.length ? (
        <View style={{ gap: 6 }}>
          <T size={13} weight="800" color="#fff">{t('access.collecting')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {cap.release_candidates.map((r) => <Chip key={r.user_id} label={`${r.display_name} · ${r.relation}`} onPress={() => onRelease?.(r.user_id)} />)}
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ the scanner
const queues = new Map();   // subject -> [{...capture body}] kept for this app session only (never written to disk: it names people)

export function ScanPanel({ domain, subjectRef, people = [], youthDirection = true, onChange }) {
  const { toast } = useSession();
  const opts = useOptions();
  const sk = `${domain}:${subjectRef}`;
  const [mode, setMode] = useState('qr'), [dir, setDir] = useState('in'), [code, setCode] = useState(''), [cam, setCam] = useState(false), [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null), [last, setLast] = useState(null), [recent, setRecent] = useState([]), [queue, setQueue] = useState(queues.get(sk) ?? []);
  const [who, setWho] = useState(null), [reason, setReason] = useState('device_failure'), [pack, setPack] = useState(null), [synced, setSynced] = useState(null);
  const input = useRef(null);
  const canPack = domain === 'academy_session' || domain === 'team_event';
  useEffect(() => { if (canPack) api.get('/access/offline-pack', { domain, subject_ref: subjectRef }).then(setPack).catch(() => setPack(null)); }, [domain, subjectRef]);
  const save = (q) => { queues.set(sk, q); setQueue(q); };
  const note = (r) => setRecent((p) => [r, ...p].slice(0, 8));

  const body = (extra) => ({ domain, subject_ref: subjectRef, direction: dir, idempotency_key: key(), ...extra });
  const send = useCallback(async (payload) => {
    setBusy(true);
    try {
      const out = await api.post('/access/captures', payload);
      setRes(out.capture); note(out.capture); setLast(payload); setCode(''); onChange?.();
    } catch (e) {
      if (!e?.status && pack && payload.method === 'qr') {   // no connection: a staff device with the pack may keep going, labelled unverified
        const tok = readToken(payload.token), at = new Date(), verdict = checkOffline(tok, at, pack);
        if (verdict === 'ok' && tok.domain === domain && tok.ref === subjectRef) {
          save([...queue, { ...payload, captured_at: at.toISOString(), device_id: 'this-device' }]);
          const r = { verdict: 'pending_review', message: t('access.offline_msg'), flags: ['offline'], person: null };
          setRes(r); note(r);
        } else setRes({ verdict: 'denied', reason_code: verdict, message: verdict === 'expired' ? t('access.expired') : t('access.invalid'), person: null });
      } else toast(explain(e));
    } finally { setBusy(false); setTimeout(() => input.current?.focus?.(), 50); }
  }, [pack, queue, dir, domain, subjectRef]);

  const submit = (raw) => {
    const entered = String(raw ?? code).trim();
    if (!entered || busy) return;
    send(body(mode === 'qr' ? { method: 'qr', token: entered } : { method: 'nfc', credential: entered, provider: 'generic' }));
  };
  const desk = () => who && send(body({ method: 'manual', user_id: who, reason_code: reason }));
  const release = (uid) => last && send({ ...last, idempotency_key: key(), released_to_user_id: uid });
  const sync = async () => {
    if (!queue.length) return;
    try {
      const r = await api.post('/access/captures/sync', { items: queue.map(({ domain: d, subject_ref, method, token, direction, idempotency_key, captured_at, device_id }) => ({ domain: d, subject_ref, method, token, direction, idempotency_key, captured_at, device_id })) });
      const keep = queue.filter((q) => r.results.find((x) => x.idempotency_key === q.idempotency_key)?.status === 'rejected');
      save(keep); setSynced(r); onChange?.();
    } catch (e) { toast(e?.status ? explain(e) : t('access.still_offline')); }
  };
  useEffect(() => { if (!queue.length) return undefined; const timer = setInterval(sync, 20000); return () => clearInterval(timer); }, [queue.length]);

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="tablist">
        <Chip label={t('access.mode_pass')} active={mode === 'qr'} onPress={() => setMode('qr')} />
        <Chip label={t('access.mode_card')} active={mode === 'tag'} onPress={() => setMode('tag')} />
        <Chip label={t('access.mode_hand')} active={mode === 'desk'} onPress={() => setMode('desk')} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label={t('access.arriving')} active={dir === 'in'} onPress={() => setDir('in')} /><Chip label={t('access.leaving')} active={dir === 'out'} onPress={() => setDir('out')} />
      </View>
      {mode !== 'desk' ? (
        <>
          {mode === 'qr' && hasCamera ? (cam ? <CameraScan onCode={submit} onClose={() => setCam(false)} /> : <Btn title={t('access.camera')} onPress={() => setCam(true)} accessibilityLabel={t('access.camera_a11y')} />) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput ref={input} value={code} onChangeText={setCode} onSubmitEditing={() => submit()} autoCapitalize="none" autoCorrect={false} autoFocus={Platform.OS === 'web'} returnKeyType="go"
              placeholder={mode === 'qr' ? t('access.ph_pass') : t('access.ph_card')} placeholderTextColor={c.mute}
              accessibilityLabel={mode === 'qr' ? t('access.a11y_pass') : t('access.a11y_card')}
              style={{ flex: 1, minWidth: 0, minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper, paddingHorizontal: 14, fontSize: 16, color: c.ink }} />
            <Btn title={t('access.check')} onPress={() => submit()} loading={busy} disabled={!code.trim()} accessibilityLabel={t('access.check_a11y')} />
          </View>
        </>
      ) : (
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>{t('access.desk_help')}</T>
          <T weight="800" size={13}>{t('access.who')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {people.length ? people.map((p) => <Chip key={p.user_id} label={p.display_name} active={who === p.user_id} onPress={() => setWho(p.user_id)} />) : <T size={13} color={c.mute}>{t('access.no_people')}</T>}
          </View>
          <T weight="800" size={13}>{t('access.why')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{REASONS_FOR_DESK.map((r) => <Chip key={r} label={REASON_LABEL[r]} active={reason === r} onPress={() => setReason(r)} />)}</View>
          <Btn title={dir === 'in' ? t('access.rec_in') : t('access.rec_out')} onPress={desk} disabled={!who} loading={busy} />
        </View>
      )}
      <VerdictCard cap={res} onRelease={release} />
      {queue.length ? (
        <Card pad={12} color={c.sunSoft}>
          <T weight="800">{t(queue.length === 1 ? 'access.waiting_one' : 'access.waiting_many', { n: queue.length })}</T>
          <T size={12} color={c.mute}>{t('access.waiting_note')}</T>
          <Btn small title={t('access.sync_now')} onPress={sync} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Card>
      ) : null}
      {synced ? <T size={13} color={c.mute}>{t('access.synced', { n: synced.synced })}{synced.conflicts ? ` ${t('access.synced_look', { n: synced.conflicts })}` : ''}{synced.rejected ? ` ${t('access.synced_refused', { n: synced.rejected })}` : ''}</T> : null}
      {recent.length ? (
        <View style={{ gap: 4 }}>
          <T size={13} weight="800">{t('access.recent')}</T>
          {recent.map((r, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
              <T size={16} color={VERDICT[r.verdict]?.[2]}>{VERDICT[r.verdict]?.[0] ?? '•'}</T>
              <T size={14} weight="700" style={{ flex: 1 }}>{r.person?.display_name ?? t('access.unknown')} · {VERDICT[r.verdict]?.[1] ?? r.verdict}</T>
              <T size={12} color={c.mute}>{METHOD_LABEL[r.method] ?? ''} {clock(r.received_at)}</T>
            </View>
          ))}
        </View>
      ) : null}
      <T size={12} color={c.mute}>{opts.data ? t('access.evidence_note') : ''}</T>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ rotating QR
function useRotating(path, query, visible) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    if (!visible) return undefined;
    let live = true, timer;
    const load = async () => {
      try { const d = await api.get(path, query); if (!live) return; setState({ data: d, error: null }); timer = setTimeout(load, Math.max(5, d.refresh_in_s - 4) * 1000); }
      catch (e) { if (live) { setState((s) => ({ ...s, error: e })); timer = setTimeout(load, 8000); } }
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [visible, path, JSON.stringify(query)]);
  return state;
}

export function PassSheet({ visible, onClose, domain, subjectRef, athleteId, title }) {
  const p = useRotating('/access/pass', { domain, subject_ref: subjectRef, athlete_id: athleteId }, visible);
  return (
    <Sheet visible={visible} onClose={onClose} title={title ?? t('access.my_pass')}>
      <View style={{ alignItems: 'center', gap: 10 }}>
        {p.data ? <QrCode value={p.data.token} size={240} label={t('access.pass_label')} /> : p.error ? <LoadError error={p.error} /> : <Loading />}
        <T weight="800" size={16}>{p.data?.subject?.label}</T>
        <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{t('access.pass_help')}</T>
      </View>
    </Sheet>
  );
}

export function SiteCodeSheet({ visible, onClose, domain, subjectRef }) {
  const p = useRotating('/access/site-code', { domain, subject_ref: subjectRef }, visible);
  return (
    <Sheet visible={visible} onClose={onClose} title={t('access.door_code')}>
      <View style={{ alignItems: 'center', gap: 10 }}>
        {p.data ? <QrCode value={p.data.token} size={260} label={t('access.door_label')} /> : p.error ? <LoadError error={p.error} /> : <Loading />}
        <T weight="800" size={16}>{p.data?.subject?.label}</T>
        <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{t('access.door_help')}</T>
        {p.data?.geo_required ? <Tag label={t('access.geo_tag')} color={c.sunSoft} /> : null}
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ held captures
export function HeldList({ scope, reload }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get('/access/captures', { ...scope, unresolved: true }), [JSON.stringify(scope)]);
  const [pick, setPick] = useState(null);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  if (!d.data.length) return <Empty emoji="✅" title={t('access.held_empty_title')} sub={t('access.held_empty_sub')} />;
  return (
    <View style={{ gap: 8 }}>
      {d.data.map((h) => (
        <Card key={h.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T weight="800" style={{ flex: 1 }}>{h.person?.display_name ?? t('access.unknown')}</T><Tag label={`${clock(h.received_at)} · ${METHOD_LABEL[h.method] ?? h.method}`} />
          </View>
          <T size={13} color={c.mute}>{h.message}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small title={t('access.accept')} onPress={() => setPick({ h, decision: 'accepted' })} accessibilityLabel={t('access.accept_a11y', { name: h.person?.display_name ?? '' })} />
            <Btn small title={t('access.reject')} color={c.paper} ink={c.ink} onPress={() => setPick({ h, decision: 'rejected' })} />
          </View>
        </Card>
      ))}
      <FormSheet visible={!!pick} onClose={() => setPick(null)} title={pick?.decision === 'accepted' ? t('access.accept_title') : t('access.reject_title')} submitLabel={t('common.save')}
        fields={[{ key: 'reason', label: t('access.why_reason') }]}
        onSubmit={async (v) => { try { await api.post(`/access/captures/${pick.h.id}/review`, { decision: pick.decision, reason: v.reason }); } catch (e) { throw new Error(explain(e)); } d.reload(); reload?.(); toast?.(t('access.saved')); return pick.decision === 'accepted' ? t('access.accepted_msg') : t('access.rejected_msg'); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ my passes + cards
export function MyPasses({ onOpenCards }) {
  const d = useLoad(() => api.get('/me/access/passes'), []);
  const [open, setOpen] = useState(null);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      {d.data.length ? d.data.map((p, i) => (
        <Card key={`${p.domain}${p.subject_ref}${p.athlete?.id}${i}`} pad={14}>
          <T weight="800" size={16}>{p.title}</T>
          <T size={13} color={c.mute}>{[p.subtitle, p.athlete && !p.athlete.is_me ? t('access.for_person', { name: p.athlete.display_name }) : null, p.starts_at ? clock(p.starts_at) : null].filter(Boolean).join(' · ')}</T>
          <Btn small title={t('access.show_pass')} onPress={() => setOpen(p)} style={{ alignSelf: 'flex-start', marginTop: 8 }} accessibilityLabel={t('access.show_pass_a11y', { title: p.title })} />
        </Card>
      )) : <Empty emoji="🎟️" title={t('access.no_pass_title')} sub={t('access.no_pass_sub')} />}
      <Btn title={t('access.my_cards_btn')} color={c.paper} ink={c.ink} onPress={onOpenCards} />
      <PassSheet visible={!!open} onClose={() => setOpen(null)} domain={open?.domain} subjectRef={open?.subject_ref} athleteId={open?.athlete && !open.athlete.is_me ? open.athlete.id : undefined} title={open?.title} />
    </View>
  );
}

export function MyCards({ userId }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get('/access/credentials', userId ? { user_id: userId } : undefined), [userId]);
  const [add, setAdd] = useState(false);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const act = async (id, action) => { try { await api.post(`/access/credentials/${id}/end`, { action }); toast(action === 'revoke' ? t('access.removed') : action === 'suspend' ? t('access.paused') : t('access.active_again')); } catch (e) { toast(explain(e)); } d.reload(); };
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>{t('access.cards_help')}</T>
      {d.data.filter((x) => x.status !== 'revoked').map((x) => (
        <Row key={x.id} title={x.label ?? (x.kind === 'nfc' ? t('access.nfc_tag') : t('access.rfid_card'))} sub={`${x.kind.toUpperCase()} · ${x.provider}${x.expires_at ? ` · ${t('access.until', { date: fmtDate(x.expires_at) })}` : ''}`}
          right={<View style={{ flexDirection: 'row', gap: 6 }}><Tag label={x.status === 'active' ? t('access.tag_active') : t('access.tag_paused')} color={x.status === 'active' ? c.lime : c.sunSoft} />
            <Chip label={x.status === 'active' ? t('access.pause') : t('access.resume')} onPress={() => act(x.id, x.status === 'active' ? 'suspend' : 'restore')} /><Chip label={t('access.remove')} onPress={() => act(x.id, 'revoke')} /></View>} />
      ))}
      {!d.data.filter((x) => x.status !== 'revoked').length ? <Empty emoji="💳" title={t('access.no_cards_title')} sub={t('access.no_cards_sub')} /> : null}
      <Btn title={t('access.add_card_btn')} onPress={() => setAdd(true)} />
      <FormSheet visible={add} onClose={() => setAdd(false)} title={t('access.add_card_title')} submitLabel={t('access.add')} initial={{ kind: 'nfc' }}
        fields={[{ key: 'kind', label: t('access.type'), type: 'chips', options: [{ value: 'nfc', label: t('access.opt_nfc') }, { value: 'rfid', label: t('access.opt_rfid') }] },
          { key: 'identifier', label: t('access.card_number'), hint: t('access.card_number_hint') },
          { key: 'label', label: t('access.card_name'), optional: true }]}
        onSubmit={async (v) => { try { await api.post('/access/credentials', { kind: v.kind, identifier: v.identifier, label: v.label || undefined, user_id: userId }); } catch (e) { throw new Error(explain(e)); } d.reload(); return t('access.added'); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ access points
const POINT_KIND = [['door', t('access.pk_door')], ['gate', t('access.pk_gate')], ['turnstile', t('access.pk_turnstile')], ['smart_lock', t('access.pk_lock')], ['locker_bank', t('access.pk_locker')], ['reader', t('access.pk_reader')]];
export function AccessPoints({ venueId, eventId, zones = [] }) {
  const { toast } = useSession();
  const scope = venueId ? { venue_id: venueId } : { event_id: eventId };
  const d = useLoad(() => api.get('/access/points', scope), [venueId, eventId]);
  const opts = useOptions();
  const [add, setAdd] = useState(false), [secret, setSecret] = useState(null), [grants, setGrants] = useState(null), [scan, setScan] = useState(null), [code, setCode] = useState(null);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const providers = opts.data?.providers ?? [{ key: 'manual', label: t('access.front_desk') }];
  const domain = venueId ? 'venue_access' : 'event_gate';
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>{t('access.points_help')}</T>
      {d.data.map((p) => (
        <Card key={p.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{p.name}</T><Tag label={`${POINT_KIND.find(([k]) => k === p.kind)?.[1] ?? nice(p.kind)} · ${providers.find((x) => x.key === p.provider)?.label ?? p.provider}`} /></View>
          <T size={12} color={c.mute}>{p.geo_checkin ? `${t('access.points_geo', { m: p.geo_radius_m })} · ` : ''}{t('access.points_early', { n: p.early_min })}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <Chip label={t('access.scan_here')} onPress={() => setScan(p)} /><Chip label={t('access.door_code')} onPress={() => setCode(p)} />
            {p.provider !== 'manual' ? <Chip label={t('access.grants')} onPress={() => setGrants(p)} /> : null}
            {p.provider !== 'manual' ? <Chip label={t('access.new_secret')} onPress={async () => { try { const r = await api.patch(`/access/points/${p.id}`, { rotate_secret: true }); setSecret(r); } catch (e) { toast(explain(e)); } }} /> : null}
            <Chip label={t('access.archive')} onPress={async () => { try { await api.patch(`/access/points/${p.id}`, { archive: true }); d.reload(); } catch (e) { toast(explain(e)); } }} />
          </View>
        </Card>
      ))}
      {!d.data.length ? <Empty emoji="🚪" title={t('access.no_points_title')} sub={t('access.no_points_sub')} /> : null}
      <Btn title={t('access.add_point_btn')} onPress={() => setAdd(true)} />
      <FormSheet visible={add} onClose={() => setAdd(false)} title={t('access.add_point_title')} submitLabel={t('access.add')} initial={{ kind: 'door', provider: 'manual', geo_radius_m: 150, early_min: 15 }}
        fields={[{ key: 'name', label: t('access.name') }, { key: 'kind', label: t('addr.what'), type: 'chips', options: POINT_KIND.map(([value, label]) => ({ value, label })) },
          ...(eventId && zones.length ? [{ key: 'zone_id', label: t('access.zone'), type: 'chips', optional: true, options: zones.map((z) => ({ value: z.id, label: z.name })) }] : []),
          { key: 'provider', label: t('access.provider'), type: 'chips', options: providers.map((x) => ({ value: x.key, label: x.label })) },
          { key: 'endpoint_url', label: t('access.endpoint'), optional: true, show: (v) => v.provider !== 'manual', hint: t('access.endpoint_hint') },
          ...(venueId ? [{ key: 'geo_checkin', label: t('access.geo_switch'), type: 'switch', default: false }, { key: 'geo_radius_m', label: t('access.geo_radius'), type: 'stepper', min: 50, max: 2000, step: 50, default: 150, show: (v) => v.geo_checkin }, { key: 'early_min', label: t('access.early_min'), type: 'stepper', min: 0, max: 240, step: 5, default: 15 }] : [])]}
        onSubmit={async (v) => { try { const r = await api.post('/access/points', { ...scope, name: v.name, kind: v.kind, provider: v.provider, zone_id: v.zone_id || undefined, endpoint_url: v.provider !== 'manual' ? v.endpoint_url : undefined, geo_checkin: !!v.geo_checkin, geo_radius_m: v.geo_radius_m ?? 150, early_min: v.early_min ?? 15 }); if (r.secret) setSecret(r); } catch (e) { throw new Error(explain(e)); } d.reload(); return t('access.added'); }} />
      <Sheet visible={!!secret} onClose={() => setSecret(null)} title={t('access.secret_title')}>
        <View style={{ gap: 8 }}>
          <T>{t('access.secret_body')}</T>
          <T selectable weight="800" size={15} style={{ padding: 12, borderRadius: 12, backgroundColor: c.paper }}>{secret?.secret}</T>
        </View>
      </Sheet>
      <Sheet visible={!!scan} onClose={() => setScan(null)} title={t('access.scan_title', { name: scan?.name ?? '' })}>{scan ? <ScanPanel domain={domain} subjectRef={scan.id} /> : null}</Sheet>
      <SiteCodeSheet visible={!!code} onClose={() => setCode(null)} domain={domain} subjectRef={code?.id} />
      <Sheet visible={!!grants} onClose={() => setGrants(null)} title={t('access.grants_title', { name: grants?.name ?? '' })}>{grants ? <Grants point={grants} /> : null}</Sheet>
    </View>
  );
}

function Grants({ point }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/access/points/${point.id}/grants`), [point.id]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const STATE = { active: [t('access.tag_active'), c.lime], revoke_pending: [t('access.gs_revoking'), c.sunSoft], revoked: [t('access.gs_revoked'), c.violetSoft], expired: [t('access.gs_expired'), c.violetSoft] };
  return (
    <View style={{ gap: 8 }}>
      <T size={13} color={c.mute}>{t('access.grants_help')}</T>
      {d.data.map((g) => (
        <Row key={g.id} title={`${g.display_name} · ${nice(g.source_type)}`} sub={`${clock(g.valid_from)}–${clock(g.valid_to)}${g.revoke_reason ? ` · ${nice(g.revoke_reason)}` : ''}`}
          right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Tag label={STATE[g.status][0]} color={STATE[g.status][1]} />{g.status === 'active' ? <Chip label={t('access.revoke_now')} onPress={async () => { try { await api.post(`/access/grants/${g.id}/revoke`); toast(t('access.revoked_toast')); } catch (e) { toast(explain(e)); } d.reload(); }} /> : null}</View>} />
      ))}
      {!d.data.length ? <Empty emoji="🔑" title={t('access.no_grants_title')} sub={t('access.no_grants_sub')} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ insights
const ANOMALY = { qr_replay: t('access.an_replay'), rapid_repeat: t('access.an_rapid'), concurrent_use: t('access.an_concurrent'), outside_window: t('access.an_window'), geofence_mismatch: t('access.an_geo'), membership_inactive: t('access.an_member'), booking_cancelled: t('access.an_booking'), accreditation_cancelled: t('access.an_accred'), unknown_credential: t('access.an_unknown'), credential_inactive: t('access.an_inactive'), provider_unavailable: t('access.an_provider'), offline_conflict: t('access.an_offline') };
export function AccessInsights({ scope }) {
  const { toast } = useSession();
  const rep = useLoad(() => api.get('/access/report', scope), [JSON.stringify(scope)]);
  const an = useLoad(() => api.get('/access/anomalies', { ...scope, status: 'open' }), [JSON.stringify(scope)]);
  const [rev, setRev] = useState(null);
  if (rep.error) return <LoadError error={rep.error} onRetry={rep.reload} />;
  if (!rep.data) return <Loading />;
  const { evidence, final, from, to } = rep.data;
  return (
    <View style={{ gap: 12 }}>
      <Card pad={14}>
        <T weight="800">{t('access.final_record')}</T>
        <T size={12} color={c.mute}>{t('access.final_line', { from, to, source: final?.source ? nice(final.source) : t('access.records') })}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {final?.by_status ? Object.entries(final.by_status).map(([k, n]) => <Tag key={k} label={`${n} ${nice(k)}`} />) : null}
          {final?.by_result ? final.by_result.map((r) => <Tag key={r.result} label={`${r.n} ${nice(r.result)}`} />) : null}
          {final?.attendance_rate != null ? <Tag label={t('access.attended', { n: final.attendance_rate })} color={c.lime} /> : null}
          {final?.no_show_rate != null ? <Tag label={t('access.no_show', { n: final.no_show_rate })} color={c.sunSoft} /> : null}
          {final?.arrived != null ? <Tag label={t('access.arrived', { n: final.arrived })} color={c.lime} /> : null}
          {final?.checked_in != null ? <Tag label={t('access.checked_in', { n: final.checked_in })} color={c.lime} /> : null}
        </View>
      </Card>
      <Card pad={14}>
        <T weight="800">{t('access.evidence', { n: evidence.total })}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {evidence.by_method.map((m) => <Tag key={m.method} label={`${m.n} ${METHOD_LABEL[m.method] ?? m.method}`} />)}
          {evidence.offline ? <Tag label={t('access.n_offline', { n: evidence.offline })} color={c.sunSoft} /> : null}
          {evidence.held_for_review ? <Tag label={t('access.n_held', { n: evidence.held_for_review })} color={c.orangeSoft} /> : null}
        </View>
        {evidence.denials_by_reason.length ? <View style={{ marginTop: 8, gap: 2 }}><T size={13} weight="800">{t('access.turned_away')}</T>{evidence.denials_by_reason.map((d) => <T key={d.reason_code} size={13}>{d.n} · {d.message ?? nice(d.reason_code)}</T>)}</View> : null}
      </Card>
      <T weight="800">{t('access.worth_look')}</T>
      <T size={12} color={c.mute}>{t('access.worth_note')}</T>
      {an.data?.length ? an.data.map((a) => (
        <Row key={a.id} title={ANOMALY[a.kind] ?? nice(a.kind)} sub={`${a.person ?? t('access.unknown')} · ${fmtDateTime(a.created_at)}`} right={<Chip label={t('access.review')} onPress={() => setRev(a)} />} />
      )) : <Empty emoji="🙂" title={t('access.nothing_title')} sub={t('access.nothing_sub')} />}
      <FormSheet visible={!!rev} onClose={() => setRev(null)} title={t('access.review')} submitLabel={t('common.save')} initial={{ status: 'reviewed' }}
        fields={[{ key: 'status', label: t('access.outcome'), type: 'chips', options: [{ value: 'reviewed', label: t('access.looked') }, { value: 'dismissed', label: t('access.dismissed') }] }, { key: 'note', label: t('access.note_private') }]}
        onSubmit={async (v) => { try { await api.post(`/access/anomalies/${rev.id}/review`, v); } catch (e) { throw new Error(explain(e)); } an.reload(); toast?.(t('access.saved')); return t('access.saved_dot'); }} />
    </View>
  );
}
