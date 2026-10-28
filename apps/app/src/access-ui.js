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

const key = () => `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const clock = (d) => (d ? new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const nice = (s) => String(s ?? '').replace(/_/g, ' ');

export const VERDICT = {
  recorded: ['✓', 'RECORDED', '#15803D'], granted: ['✓', 'ADMIT', '#15803D'], denied: ['✕', 'NOT ACCEPTED', '#B91C1C'],
  pending_review: ['⏸', 'HELD FOR STAFF', '#B45309'], provider_unavailable: ['⚠', 'DOOR NOT OPENED', '#B91C1C'],
};
const REASON_LABEL = { roster_tap: 'Roster tap', device_failure: 'Scanner not working', network_failure: 'No network', forgot_credential: 'Forgot pass or card', guardian_present: 'Guardian is here', correction: 'Correction', other: 'Something else' };
const REASONS_FOR_DESK = ['device_failure', 'network_failure', 'forgot_credential', 'guardian_present', 'other'];
const METHOD_LABEL = { qr: 'Pass / code', nfc: 'Card / tag', rfid: 'Card / tag', manual: 'By hand', self: 'Self', geo: 'Location' };

const useOptions = () => useLoad(() => api.get('/access/options'), []);

/** The outcome of one presentation: colour, a symbol and words (never colour alone), the person, and what to do next. */
export function VerdictCard({ cap, onRelease }) {
  if (!cap) return null;
  const [icon, word, tone] = cap.verdict === 'recorded' && cap.reason_code === 'already_recorded' ? ['✓', 'ALREADY RECORDED', '#15803D'] : VERDICT[cap.verdict] ?? ['•', cap.verdict, '#475569'];
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="assertive" accessibilityLabel={`${word}. ${cap.person?.display_name ?? ''}. ${cap.message ?? ''}`} style={{ borderRadius: 24, backgroundColor: tone, padding: 18, gap: 8 }}>
      <T size={26} weight="800" color="#fff" style={{ letterSpacing: 0.5 }}>{icon} {word}</T>
      {cap.person ? <T size={20} weight="800" color="#fff">{cap.person.display_name}{cap.person.youth ? '  · under 18' : ''}</T> : <T size={16} weight="700" color="#fff">Nobody was identified</T>}
      {cap.message ? <T size={15} weight="700" color="#fff">{cap.message}</T> : null}
      {cap.flags?.includes('offline') ? <T size={13} weight="800" color="#fff">Captured offline · checked by the server when it synced</T> : null}
      {cap.release_candidates?.length ? (
        <View style={{ gap: 6 }}>
          <T size={13} weight="800" color="#fff">Who is collecting?</T>
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
        const t = readToken(payload.token), at = new Date(), verdict = checkOffline(t, at, pack);
        if (verdict === 'ok' && t.domain === domain && t.ref === subjectRef) {
          save([...queue, { ...payload, captured_at: at.toISOString(), device_id: 'this-device' }]);
          const r = { verdict: 'pending_review', message: 'No connection. The pass looks genuine and is saved on this device. It is NOT recorded until it syncs and the server checks it.', flags: ['offline'], person: null };
          setRes(r); note(r);
        } else setRes({ verdict: 'denied', reason_code: verdict, message: verdict === 'expired' ? 'This code has expired. Ask for a fresh one.' : 'This code is not valid.', person: null });
      } else toast(explain(e));
    } finally { setBusy(false); setTimeout(() => input.current?.focus?.(), 50); }
  }, [pack, queue, dir, domain, subjectRef]);

  const submit = (raw) => {
    const t = String(raw ?? code).trim();
    if (!t || busy) return;
    send(body(mode === 'qr' ? { method: 'qr', token: t } : { method: 'nfc', credential: t, provider: 'generic' }));
  };
  const desk = () => who && send(body({ method: 'manual', user_id: who, reason_code: reason }));
  const release = (uid) => last && send({ ...last, idempotency_key: key(), released_to_user_id: uid });
  const sync = async () => {
    if (!queue.length) return;
    try {
      const r = await api.post('/access/captures/sync', { items: queue.map(({ domain: d, subject_ref, method, token, direction, idempotency_key, captured_at, device_id }) => ({ domain: d, subject_ref, method, token, direction, idempotency_key, captured_at, device_id })) });
      const keep = queue.filter((q) => r.results.find((x) => x.idempotency_key === q.idempotency_key)?.status === 'rejected');
      save(keep); setSynced(r); onChange?.();
    } catch (e) { toast(e?.status ? explain(e) : 'Still offline. Your scans are safe on this device.'); }
  };
  useEffect(() => { if (!queue.length) return undefined; const t = setInterval(sync, 20000); return () => clearInterval(t); }, [queue.length]);

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="tablist">
        <Chip label="📱 Pass or code" active={mode === 'qr'} onPress={() => setMode('qr')} />
        <Chip label="💳 Card or tag" active={mode === 'tag'} onPress={() => setMode('tag')} />
        <Chip label="✍️ By hand" active={mode === 'desk'} onPress={() => setMode('desk')} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="➡️ Arriving" active={dir === 'in'} onPress={() => setDir('in')} /><Chip label="⬅️ Leaving" active={dir === 'out'} onPress={() => setDir('out')} />
      </View>
      {mode !== 'desk' ? (
        <>
          {mode === 'qr' && hasCamera ? (cam ? <CameraScan onCode={submit} onClose={() => setCam(false)} /> : <Btn title="📷 Scan with the camera" onPress={() => setCam(true)} accessibilityLabel="Open the camera to scan a pass" />) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput ref={input} value={code} onChangeText={setCode} onSubmitEditing={() => submit()} autoCapitalize="none" autoCorrect={false} autoFocus={Platform.OS === 'web'} returnKeyType="go"
              placeholder={mode === 'qr' ? 'Scan or paste the pass code' : 'Tap the card or tag on the reader'} placeholderTextColor={c.mute}
              accessibilityLabel={mode === 'qr' ? 'Pass code. A hardware scanner types it here.' : 'Card or tag id. A reader that acts as a keyboard types it here.'}
              style={{ flex: 1, minWidth: 0, minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper, paddingHorizontal: 14, fontSize: 16, color: c.ink }} />
            <Btn title="Check" onPress={() => submit()} loading={busy} disabled={!code.trim()} accessibilityLabel="Check this code" />
          </View>
        </>
      ) : (
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>For when a scanner or the network fails. The reason is kept with your name, and the person still has to be on the roster or entitled.</T>
          <T weight="800" size={13}>Who</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {people.length ? people.map((p) => <Chip key={p.user_id} label={p.display_name} active={who === p.user_id} onPress={() => setWho(p.user_id)} />) : <T size={13} color={c.mute}>Open this from a session or team to pick from its people.</T>}
          </View>
          <T weight="800" size={13}>Why</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{REASONS_FOR_DESK.map((r) => <Chip key={r} label={REASON_LABEL[r]} active={reason === r} onPress={() => setReason(r)} />)}</View>
          <Btn title={dir === 'in' ? 'Record arrival' : 'Record departure'} onPress={desk} disabled={!who} loading={busy} />
        </View>
      )}
      <VerdictCard cap={res} onRelease={release} />
      {queue.length ? (
        <Card pad={12} color={c.sunSoft}>
          <T weight="800">⏳ {queue.length} scan{queue.length === 1 ? '' : 's'} waiting · not verified yet</T>
          <T size={12} color={c.mute}>Saved on this device only while the app stays open. The server checks each one when it syncs.</T>
          <Btn small title="Sync now" onPress={sync} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Card>
      ) : null}
      {synced ? <T size={13} color={c.mute}>Synced {synced.synced}{synced.conflicts ? ` · ${synced.conflicts} need a look` : ''}{synced.rejected ? ` · ${synced.rejected} refused` : ''}</T> : null}
      {recent.length ? (
        <View style={{ gap: 4 }}>
          <T size={13} weight="800">Recent</T>
          {recent.map((r, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
              <T size={16} color={VERDICT[r.verdict]?.[2]}>{VERDICT[r.verdict]?.[0] ?? '•'}</T>
              <T size={14} weight="700" style={{ flex: 1 }}>{r.person?.display_name ?? 'Unknown'} · {VERDICT[r.verdict]?.[1] ?? r.verdict}</T>
              <T size={12} color={c.mute}>{METHOD_LABEL[r.method] ?? ''} {clock(r.received_at)}</T>
            </View>
          ))}
        </View>
      ) : null}
      <T size={12} color={c.mute}>{opts.data ? 'A scan is evidence. The attendance or access record changes only when the server accepts it.' : ''}</T>
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
    <Sheet visible={visible} onClose={onClose} title={title ?? 'My pass'}>
      <View style={{ alignItems: 'center', gap: 10 }}>
        {p.data ? <QrCode value={p.data.token} size={240} label="Your rotating pass. Show it to the person at the door." /> : p.error ? <LoadError error={p.error} /> : <Loading />}
        <T weight="800" size={16}>{p.data?.subject?.label}</T>
        <T size={13} color={c.mute} style={{ textAlign: 'center' }}>This code changes every 30 seconds and works once, so a screenshot or a forwarded code will not check anyone in. Keep this screen open while you scan.</T>
      </View>
    </Sheet>
  );
}

export function SiteCodeSheet({ visible, onClose, domain, subjectRef }) {
  const p = useRotating('/access/site-code', { domain, subject_ref: subjectRef }, visible);
  return (
    <Sheet visible={visible} onClose={onClose} title="Door code">
      <View style={{ alignItems: 'center', gap: 10 }}>
        {p.data ? <QrCode value={p.data.token} size={260} label="Door check-in code. People scan it with their own phone." /> : p.error ? <LoadError error={p.error} /> : <Loading />}
        <T weight="800" size={16}>{p.data?.subject?.label}</T>
        <T size={13} color={c.mute} style={{ textAlign: 'center' }}>Show this on a tablet at the door. People open their app, choose Scan, and check themselves in. It refreshes every 30 seconds.</T>
        {p.data?.geo_required ? <Tag label="📍 Their phone must also be at the venue" color={c.sunSoft} /> : null}
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
  if (!d.data.length) return <Empty emoji="✅" title="Nothing waiting for you" sub="Check-ins that need a human decision (outside the venue, no location, a mark staff already set) appear here." />;
  return (
    <View style={{ gap: 8 }}>
      {d.data.map((h) => (
        <Card key={h.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T weight="800" style={{ flex: 1 }}>{h.person?.display_name ?? 'Unknown'}</T><Tag label={`${clock(h.received_at)} · ${METHOD_LABEL[h.method] ?? h.method}`} />
          </View>
          <T size={13} color={c.mute}>{h.message}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small title="Accept" onPress={() => setPick({ h, decision: 'accepted' })} accessibilityLabel={`Accept ${h.person?.display_name}`} />
            <Btn small title="Don't accept" color={c.paper} ink={c.ink} onPress={() => setPick({ h, decision: 'rejected' })} />
          </View>
        </Card>
      ))}
      <FormSheet visible={!!pick} onClose={() => setPick(null)} title={pick?.decision === 'accepted' ? 'Accept this check-in' : "Don't accept this check-in"} submitLabel="Save"
        fields={[{ key: 'reason', label: 'Why? (kept with your name)' }]}
        onSubmit={async (v) => { try { await api.post(`/access/captures/${pick.h.id}/review`, { decision: pick.decision, reason: v.reason }); } catch (e) { throw new Error(explain(e)); } d.reload(); reload?.(); toast?.('Saved'); return pick.decision === 'accepted' ? 'Recorded, with your reason.' : 'Kept as evidence only.'; }} />
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
          <T size={13} color={c.mute}>{[p.subtitle, p.athlete && !p.athlete.is_me ? `for ${p.athlete.display_name}` : null, p.starts_at ? clock(p.starts_at) : null].filter(Boolean).join(' · ')}</T>
          <Btn small title="Show pass" onPress={() => setOpen(p)} style={{ alignSelf: 'flex-start', marginTop: 8 }} accessibilityLabel={`Show the pass for ${p.title}`} />
        </Card>
      )) : <Empty emoji="🎟️" title="No pass needed right now" sub="Sessions, matches, venue bookings and event badges appear here when they are about to start." />}
      <Btn title="💳 My cards and wristbands" color={c.paper} ink={c.ink} onPress={onOpenCards} />
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
  const act = async (id, action) => { try { await api.post(`/access/credentials/${id}/end`, { action }); toast(action === 'revoke' ? 'Removed' : action === 'suspend' ? 'Paused' : 'Active again'); } catch (e) { toast(explain(e)); } d.reload(); };
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>A card, tag or wristband is only a key to look you up. What it opens is always decided from your current booking, enrolment or accreditation.</T>
      {d.data.filter((x) => x.status !== 'revoked').map((x) => (
        <Row key={x.id} title={x.label ?? (x.kind === 'nfc' ? 'NFC tag' : 'RFID card')} sub={`${x.kind.toUpperCase()} · ${x.provider}${x.expires_at ? ` · until ${new Date(x.expires_at).toLocaleDateString()}` : ''}`}
          right={<View style={{ flexDirection: 'row', gap: 6 }}><Tag label={x.status === 'active' ? '✓ Active' : '⏸ Paused'} color={x.status === 'active' ? c.lime : c.sunSoft} />
            <Chip label={x.status === 'active' ? 'Pause' : 'Resume'} onPress={() => act(x.id, x.status === 'active' ? 'suspend' : 'restore')} /><Chip label="Remove" onPress={() => act(x.id, 'revoke')} /></View>} />
      ))}
      {!d.data.filter((x) => x.status !== 'revoked').length ? <Empty emoji="💳" title="No cards or tags yet" sub="Add the card or wristband your academy or venue gave you." /> : null}
      <Btn title="＋ Add a card or tag" onPress={() => setAdd(true)} />
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add a card or tag" submitLabel="Add" initial={{ kind: 'nfc' }}
        fields={[{ key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'nfc', label: 'NFC tag or wristband' }, { value: 'rfid', label: 'RFID card' }] },
          { key: 'identifier', label: 'Card or tag number', hint: 'Tap it on a reader, or type the number printed on it. It is only used to make a lookup key and is never stored or shown again.' },
          { key: 'label', label: 'Name (so you can tell them apart)', optional: true }]}
        onSubmit={async (v) => { try { await api.post('/access/credentials', { kind: v.kind, identifier: v.identifier, label: v.label || undefined, user_id: userId }); } catch (e) { throw new Error(explain(e)); } d.reload(); return 'Added.'; }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ access points
const POINT_KIND = [['door', 'Door'], ['gate', 'Gate'], ['turnstile', 'Turnstile'], ['smart_lock', 'Smart lock'], ['locker_bank', 'Locker bank'], ['reader', 'Reader']];
export function AccessPoints({ venueId, eventId, zones = [] }) {
  const { toast } = useSession();
  const scope = venueId ? { venue_id: venueId } : { event_id: eventId };
  const d = useLoad(() => api.get('/access/points', scope), [venueId, eventId]);
  const opts = useOptions();
  const [add, setAdd] = useState(false), [secret, setSecret] = useState(null), [grants, setGrants] = useState(null), [scan, setScan] = useState(null), [code, setCode] = useState(null);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const providers = opts.data?.providers ?? [{ key: 'manual', label: 'Front desk (no hardware)' }];
  const domain = venueId ? 'venue_access' : 'event_gate';
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>Doors, gates and readers. Entry is decided from live bookings, memberships and accreditations. A controller must confirm before anything counts as opened.</T>
      {d.data.map((p) => (
        <Card key={p.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{p.name}</T><Tag label={`${nice(p.kind)} · ${providers.find((x) => x.key === p.provider)?.label ?? p.provider}`} /></View>
          <T size={12} color={c.mute}>{p.geo_checkin ? `📍 Location check-in within ${p.geo_radius_m} m · ` : ''}admits ${p.early_min} min before a booking</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <Chip label="Scan here" onPress={() => setScan(p)} /><Chip label="Door code" onPress={() => setCode(p)} />
            {p.provider !== 'manual' ? <Chip label="Grants" onPress={() => setGrants(p)} /> : null}
            {p.provider !== 'manual' ? <Chip label="New secret" onPress={async () => { try { const r = await api.patch(`/access/points/${p.id}`, { rotate_secret: true }); setSecret(r); } catch (e) { toast(explain(e)); } }} /> : null}
            <Chip label="Archive" onPress={async () => { try { await api.patch(`/access/points/${p.id}`, { archive: true }); d.reload(); } catch (e) { toast(explain(e)); } }} />
          </View>
        </Card>
      ))}
      {!d.data.length ? <Empty emoji="🚪" title="No access points yet" sub="Add the front desk, a gate or a smart lock to start recording who comes in." /> : null}
      <Btn title="＋ Add an access point" onPress={() => setAdd(true)} />
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Add an access point" submitLabel="Add" initial={{ kind: 'door', provider: 'manual', geo_radius_m: 150, early_min: 15 }}
        fields={[{ key: 'name', label: 'Name' }, { key: 'kind', label: 'What is it', type: 'chips', options: POINT_KIND.map(([value, label]) => ({ value, label })) },
          ...(eventId && zones.length ? [{ key: 'zone_id', label: 'Which zone does it guard', type: 'chips', optional: true, options: zones.map((z) => ({ value: z.id, label: z.name })) }] : []),
          { key: 'provider', label: 'How does it open', type: 'chips', options: providers.map((x) => ({ value: x.key, label: x.label })) },
          { key: 'endpoint_url', label: 'Controller address (https)', optional: true, show: (v) => v.provider !== 'manual', hint: 'Commands are signed with a secret shown once after you save.' },
          ...(venueId ? [{ key: 'geo_checkin', label: 'Also require the phone to be at the venue', type: 'switch', default: false }, { key: 'geo_radius_m', label: 'How close (metres)', type: 'stepper', min: 50, max: 2000, step: 50, default: 150, show: (v) => v.geo_checkin }, { key: 'early_min', label: 'Let people in this many minutes early', type: 'stepper', min: 0, max: 240, step: 5, default: 15 }] : [])]}
        onSubmit={async (v) => { try { const r = await api.post('/access/points', { ...scope, name: v.name, kind: v.kind, provider: v.provider, zone_id: v.zone_id || undefined, endpoint_url: v.provider !== 'manual' ? v.endpoint_url : undefined, geo_checkin: !!v.geo_checkin, geo_radius_m: v.geo_radius_m ?? 150, early_min: v.early_min ?? 15 }); if (r.secret) setSecret(r); } catch (e) { throw new Error(explain(e)); } d.reload(); return 'Added.'; }} />
      <Sheet visible={!!secret} onClose={() => setSecret(null)} title="Controller secret">
        <View style={{ gap: 8 }}>
          <T>Copy this into the controller now. It signs every command and event, and it is not shown again.</T>
          <T selectable weight="800" size={15} style={{ padding: 12, borderRadius: 12, backgroundColor: c.paper }}>{secret?.secret}</T>
        </View>
      </Sheet>
      <Sheet visible={!!scan} onClose={() => setScan(null)} title={`Scan · ${scan?.name ?? ''}`}>{scan ? <ScanPanel domain={domain} subjectRef={scan.id} /> : null}</Sheet>
      <SiteCodeSheet visible={!!code} onClose={() => setCode(null)} domain={domain} subjectRef={code?.id} />
      <Sheet visible={!!grants} onClose={() => setGrants(null)} title={`Grants · ${grants?.name ?? ''}`}>{grants ? <Grants point={grants} /> : null}</Sheet>
    </View>
  );
}

function Grants({ point }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/access/points/${point.id}/grants`), [point.id]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const STATE = { active: ['✓ Active', c.lime], revoke_pending: ['⏳ Revoking · controller has not confirmed', c.sunSoft], revoked: ['Revoked', c.violetSoft], expired: ['Expired', c.violetSoft] };
  return (
    <View style={{ gap: 8 }}>
      <T size={13} color={c.mute}>Temporary credentials the controller holds. They end when the booking, locker or badge behind them ends.</T>
      {d.data.map((g) => (
        <Row key={g.id} title={`${g.display_name} · ${nice(g.source_type)}`} sub={`${clock(g.valid_from)}–${clock(g.valid_to)}${g.revoke_reason ? ` · ${nice(g.revoke_reason)}` : ''}`}
          right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Tag label={STATE[g.status][0]} color={STATE[g.status][1]} />{g.status === 'active' ? <Chip label="Revoke now" onPress={async () => { try { await api.post(`/access/grants/${g.id}/revoke`); toast('Revoked'); } catch (e) { toast(explain(e)); } d.reload(); }} /> : null}</View>} />
      ))}
      {!d.data.length ? <Empty emoji="🔑" title="No grants" sub="Issue one from a booking or locker." /> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ insights
const ANOMALY = { qr_replay: 'A pass was used twice', rapid_repeat: 'Scanned twice in quick succession', concurrent_use: 'Arrived in two places at once', outside_window: 'Outside the check-in window', geofence_mismatch: 'Phone was away from the venue', membership_inactive: 'Membership not active', booking_cancelled: 'Booking was cancelled', accreditation_cancelled: 'Accreditation revoked or suspended', unknown_credential: 'Unknown card or tag', credential_inactive: 'Card or tag paused or expired', provider_unavailable: 'Door controller unreachable', offline_conflict: 'Offline scan no longer holds' };
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
        <T weight="800">Final record</T>
        <T size={12} color={c.mute}>{from} to {to} · from the {nice(final?.source ?? 'records')}. A scan changes this only when the server accepts it.</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {final?.by_status ? Object.entries(final.by_status).map(([k, n]) => <Tag key={k} label={`${n} ${nice(k)}`} />) : null}
          {final?.by_result ? final.by_result.map((r) => <Tag key={r.result} label={`${r.n} ${nice(r.result)}`} />) : null}
          {final?.attendance_rate != null ? <Tag label={`${final.attendance_rate}% attended`} color={c.lime} /> : null}
          {final?.no_show_rate != null ? <Tag label={`${final.no_show_rate}% no-show`} color={c.sunSoft} /> : null}
          {final?.arrived != null ? <Tag label={`${final.arrived} arrived`} color={c.lime} /> : null}
          {final?.checked_in != null ? <Tag label={`${final.checked_in} checked in`} color={c.lime} /> : null}
        </View>
      </Card>
      <Card pad={14}>
        <T weight="800">Capture evidence · {evidence.total}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {evidence.by_method.map((m) => <Tag key={m.method} label={`${m.n} ${METHOD_LABEL[m.method] ?? m.method}`} />)}
          {evidence.offline ? <Tag label={`${evidence.offline} offline`} color={c.sunSoft} /> : null}
          {evidence.held_for_review ? <Tag label={`${evidence.held_for_review} held`} color={c.orangeSoft} /> : null}
        </View>
        {evidence.denials_by_reason.length ? <View style={{ marginTop: 8, gap: 2 }}><T size={13} weight="800">Why people were turned away</T>{evidence.denials_by_reason.map((d) => <T key={d.reason_code} size={13}>{d.n} · {d.message ?? nice(d.reason_code)}</T>)}</View> : null}
      </Card>
      <T weight="800">Worth a look</T>
      <T size={12} color={c.mute}>Reported without judgement. Nothing here blocks or accuses anyone by itself.</T>
      {an.data?.length ? an.data.map((a) => (
        <Row key={a.id} title={ANOMALY[a.kind] ?? nice(a.kind)} sub={`${a.person ?? 'Unknown'} · ${new Date(a.created_at).toLocaleString()}`} right={<Chip label="Review" onPress={() => setRev(a)} />} />
      )) : <Empty emoji="🙂" title="Nothing to look at" sub="Replayed passes, repeated scans and mismatches show up here." />}
      <FormSheet visible={!!rev} onClose={() => setRev(null)} title="Review" submitLabel="Save" initial={{ status: 'reviewed' }}
        fields={[{ key: 'status', label: 'Outcome', type: 'chips', options: [{ value: 'reviewed', label: 'Looked into it' }, { value: 'dismissed', label: 'Nothing to act on' }] }, { key: 'note', label: 'Note (kept private)' }]}
        onSubmit={async (v) => { try { await api.post(`/access/anomalies/${rev.id}/review`, v); } catch (e) { throw new Error(explain(e)); } an.reload(); toast?.('Saved'); return 'Saved.'; }} />
    </View>
  );
}
