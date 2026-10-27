// Media rights (#482): match-day production (crew, run sheet / call sheet, incidents and changes) and the honest streaming record.
// Crew are real people on real games; the badge shown is the event department's, read live. A stream is a reference to an external stream:
// "live" is only ever what the organiser or partner reported, and the screen says so.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStat, AT, ReasonSheet } from '../arena';
import { ErrorBox, Loading } from '../ui';
import { FormSheet } from '../FormSheet';
import { CREW_ROLES, ZONES, PHASES, PROVIDERS, crewRole, fmtDT, nice, StateTag, Tags } from '../media-ui';

const gameLabel = (g) => `${g.home?.name ?? g.home_name ?? 'TBC'} v ${g.away?.name ?? g.away_name ?? 'TBC'} · ${fmtDT(g.scheduled_at)}`;
const gameOptions = (games) => (games ?? []).filter((g) => !['completed', 'cancelled'].includes(g.status)).slice(0, 40).map((g) => ({ value: g.id, label: gameLabel(g) }));
const BADGE = { none: ['No badge', 'none'], requested: ['Badge requested', 'requested'], issued: ['Badge issued', 'issued'], revoked: ['Badge revoked', 'revoked'] };

/** Crew, run sheet and incidents of an event. `licences` are the caller's own licences in force (a partner assigns only under one); the organiser needs none. */
export function ProductionPanel({ id, isOrg, games, licences = [], canAct }) {
  const { user, toast } = useSession();
  const [game, setGame] = useState(null);
  const d = useLoad(() => api.get(`/events/${id}/media/call-sheet`, game ? { fixture_id: game } : {}), [id, game]);
  const [form, setForm] = useState(null);       // 'crew' | 'run' | 'incident'
  const [edit, setEdit] = useState(null);
  const [release, setRelease] = useState(null);
  const [no, setNo] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const s = d.data;
  const act = isOrg || canAct;
  const respond = async (c, accept, reason) => { try { await api.post(`/media/crew/${c.id}/respond`, { accept, reason }); toast(accept ? 'Confirmed. See you there.' : 'Declined'); d.reload(); } catch (x) { toast(x.message); } };
  const opts = gameOptions(games);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="🎥" value={s.readiness.crew} label="Crew" /><AStat icon="✅" value={s.readiness.ready} label="Ready" /><AStat icon="🪪" value={s.readiness.crew - s.readiness.no_badge} label="Badged" /><AStat icon="⚠️" value={s.readiness.open_incidents} label="Open issues" />
      </View>
      {opts.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <AChip label="Whole event" active={!game} onPress={() => setGame(null)} />
          {opts.slice(0, 8).map((o) => <AChip key={o.value} label={o.label} active={game === o.value} onPress={() => setGame(o.value)} />)}
        </View>
      ) : null}

      <ASection title="Crew" sub="Roles, call times and positions" action={act ? '+ Assign' : undefined} onAction={() => { setEdit(null); setForm('crew'); }} />
      {!s.crew.length ? <AEmpty emoji="🎬" title="No crew assigned" sub={act ? 'Assign producers, camera operators, commentators and photographers to this event or a game.' : 'Nobody is assigned yet.'} action={act ? 'Assign crew' : undefined} onAction={() => setForm('crew')} /> : s.crew.map((c) => (
        <ARow key={c.id} title={`${c.display_name} · ${crewRole(c.role)}`} sub={[c.call_time ? `Call ${fmtDT(c.call_time)}` : null, c.camera_position, c.booth_ref, c.technical_provider, c.partner_name].filter(Boolean).join(' · ') || 'No call time set'}
          right={<><StateTag state={c.status} /><StateTag state={BADGE[c.accreditation][1]} label={BADGE[c.accreditation][0]} />{c.restricted_zones_approved ? <StateTag state="attention" label="Restricted zones" /> : null}{act && !c.mine ? <ABtn small title="Release" tone="ghost" onPress={() => setRelease(c)} /> : null}</>}
          left={<AT size={22}>{c.ready ? '✅' : '🎥'}</AT>} />
      ))}
      {s.crew.filter((c) => c.mine && c.status === 'assigned').map((c) => (
        <ACard key={c.id} tone={A.sun} pad={12} style={{ gap: 8 }}>
          <AT size={15} weight="800">Please confirm your assignment: {crewRole(c.role)}</AT>
          <View style={{ flexDirection: 'row', gap: 8 }}><ABtn small title="Confirm" tone="lime" onPress={() => respond(c, true)} /><ABtn small title="Can't do it" tone="ghost" onPress={() => setNo(c)} /></View>
        </ACard>
      ))}

      <ASection title="Run sheet" sub="Setup, rehearsal, live and teardown" action={act ? '+ Add window' : undefined} onAction={() => setForm('run')} />
      {!s.run_sheet.length ? <AT size={13} color={A.mute}>No windows yet.</AT> : s.run_sheet.map((r) => (
        <ARow key={r.id} title={`${PHASES.find((p) => p.value === r.phase)?.label ?? r.phase} · ${r.title}`} sub={`${fmtDT(r.starts_at)} → ${fmtDT(r.ends_at)}${r.location || r.resource_name || r.venue_name ? ` · ${r.location ?? r.resource_name ?? r.venue_name}` : ''}`} right={<StateTag state={r.status} />} />
      ))}

      <ASection title="Incidents & changes" action="+ Log" onAction={() => setForm('incident')} />
      {!s.incidents.length ? <AT size={13} color={A.mute}>Nothing open.</AT> : s.incidents.map((n) => (
        <ARow key={n.id} title={n.summary} sub={`${nice(n.kind)} · ${n.reported_by_name} · ${fmtDT(n.created_at)}`} right={<><StateTag state={n.severity} /><ABtn small title="Resolve" tone="ghost" onPress={async () => { try { await api.post(`/media/incidents/${n.id}/resolve`, {}); d.reload(); } catch (x) { toast(x.message); } }} /></>} />
      ))}

      <CrewForm visible={form === 'crew'} onClose={() => setForm(null)} id={id} isOrg={isOrg} opts={opts} licences={licences} onDone={() => { d.reload(); }} edit={edit} />
      <FormSheet visible={form === 'run'} onClose={() => setForm(null)} title="Run-sheet window"
        fields={[{ key: 'phase', label: 'Phase', type: 'chips', options: PHASES, default: 'setup' }, { key: 'title', label: 'What happens' }, { key: 'starts_at', label: 'Starts', type: 'datetime' }, { key: 'ends_at', label: 'Ends', type: 'datetime' },
          { key: 'fixture_id', label: 'Game', type: 'chips', optional: true, options: opts }, { key: 'location', label: 'Place', optional: true, hint: 'Broadcast compound, commentary position 2, gate C …' }]}
        submitLabel="Add to run sheet" onSubmit={async (v) => { await api.post(`/events/${id}/media/run-sheet`, v); d.reload(); return 'Added'; }} />
      <FormSheet visible={form === 'incident'} onClose={() => setForm(null)} title="Log an incident or change"
        fields={[{ key: 'kind', label: 'Type', type: 'chips', options: [{ value: 'incident', label: '⚠️ Incident' }, { value: 'change', label: '🔁 Change' }], default: 'incident' }, { key: 'severity', label: 'Severity', type: 'chips', options: [{ value: 'info', label: 'Info' }, { value: 'minor', label: 'Minor' }, { value: 'major', label: 'Major' }, { value: 'critical', label: 'Critical' }], default: 'info' },
          { key: 'summary', label: 'What happened', hint: 'Camera 3 feed lost · kick-off moved 15 min · booth swapped' }, { key: 'fixture_id', label: 'Game', type: 'chips', optional: true, options: opts }, { key: 'detail', label: 'Detail', type: 'multiline', optional: true }]}
        submitLabel="Log it" onSubmit={async (v) => { await api.post(`/events/${id}/media/incidents`, v); d.reload(); return 'Logged. The organiser is told if it is major.'; }} />
      <ReasonSheet visible={!!no} onClose={() => setNo(null)} title="Can't do this assignment" sub="The organiser is told." presets={['Not available', 'Illness', 'Conflict of interest']} confirmLabel="Decline" onConfirm={async (reason) => { await respond(no, false, reason); }} />
      <ReasonSheet visible={!!release} onClose={() => setRelease(null)} title={release ? `Release ${release.display_name}?` : ''} sub="Their assignment ends; the record stays." presets={['Role covered', 'Stood down']} requireReason={false} confirmLabel="Release" onConfirm={async () => { try { await api.post(`/media/crew/${release.id}/release`, {}); d.reload(); } catch (x) { toast(x.message); } }} />
    </>
  );
}

function CrewForm({ visible, onClose, id, isOrg, opts, licences, onDone }) {
  const fields = [
    { key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', noun: 'person' },
    { key: 'role', label: 'Role', type: 'chips', options: CREW_ROLES, default: 'camera_operator' },
    ...(licences.length ? [{ key: 'licence_id', label: 'Under which licence', type: 'chips', optional: isOrg, options: licences.map((l) => ({ value: l.licence_id ?? l.id, label: l.package_name ?? l.licence_no ?? 'Licence' })), default: licences.length === 1 ? (licences[0].licence_id ?? licences[0].id) : undefined }] : []),
    { key: 'fixture_id', label: 'Game', type: 'chips', optional: true, options: opts, hint: 'Leave empty for the whole event' },
    { key: 'call_time', label: 'Call time', type: 'datetime', optional: true },
    { key: 'zones', label: 'Areas', type: 'multi', options: isOrg ? ZONES : ZONES.filter((z) => !z.label.startsWith('🔒')), default: ['media_centre', 'mixed_zone'], hint: isOrg ? '🔒 areas are restricted: only you can approve them' : 'A media agreement does not open locker rooms or other restricted areas' },
    { key: 'camera_position', label: 'Camera position / commentary booth', optional: true },
    { key: 'technical_provider', label: 'Technical provider', optional: true, hint: 'The company supplying the kit or OB truck' },
  ];
  return (
    <FormSheet visible={visible} onClose={onClose} title="Assign crew" fields={fields} submitLabel="Assign"
      onSubmit={async (v) => { await api.post(`/events/${id}/media/crew`, { ...v, zones: v.zones?.length ? v.zones : ['media_centre'] }); onDone(); return 'Assigned. They will be asked to confirm.'; }} />
  );
}

const STATES = [['scheduled', 'Scheduled'], ['live', 'Live'], ['offline', 'Offline'], ['ended', 'Ended']];
/** External streams for an event: the record of where to watch, with reported state. Nothing here is a video platform. */
export function StreamsPanel({ id, isOrg, games, licences = [], canAct }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/events/${id}/media/streams`), [id]);
  const [form, setForm] = useState(false);
  const [live, setLive] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const act = isOrg || canAct;
  const opts = gameOptions(games);
  const setState = async (st, state, extra = {}) => { try { await api.post(`/media/streams/${st.id}/state`, { state, ...extra }); d.reload(); } catch (x) { toast(x.details?.code === 'playback_required' ? 'Add the playback link first' : x.message); } };
  return (
    <>
      <ACard tone={A.cyan} pad={12} style={{ gap: 4 }}>
        <AT size={13} weight="800">How streaming works here</AT>
        <AT size={12.5} color={A.mute}>SportArena does not host video. A stream is a reference to one on an external provider, and its state is reported by the organiser or the licensed partner. A game is only shown as live when someone has reported it live with a playback link.</AT>
      </ACard>
      <ASection title="Streams" action={act ? '+ Add stream' : undefined} onAction={() => setForm(true)} />
      {!d.data.length ? <AEmpty emoji="📺" title="No streams configured" sub={act ? 'Add the external stream for a game or the whole event. Until you do, none is shown anywhere.' : 'Nothing is configured for this event.'} action={act ? 'Add a stream' : undefined} onAction={() => setForm(true)} /> : d.data.map((st) => (
        <ACard key={st.id} pad={14} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><AT size={15} weight="800">{PROVIDERS[st.provider] ?? st.provider}</AT><AT size={12.5} color={A.mute}>{st.channel_ref}</AT></View>
            <StateTag state={st.display_state} label={st.display_state === 'live' ? 'Reported live' : st.display_state} />
          </View>
          <Tags items={[`${st.access_policy}`, st.fixture_id ? 'One game' : 'Whole event', st.partner_name].filter(Boolean)} tone={A.cyan} />
          <AT size={12.5} color={A.mute}>{st.scheduled_start ? `${fmtDT(st.scheduled_start)}${st.scheduled_end ? ` → ${fmtDT(st.scheduled_end)}` : ''}` : 'No schedule set'}{st.playback_ref ? ' · playback link set' : ' · no playback link'}</AT>
          {act ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{STATES.map(([k, l]) => <AChip key={k} label={l} active={st.state === k} onPress={() => (k === 'live' && !st.playback_ref ? setLive(st) : setState(st, k))} />)}</View> : null}
        </ACard>
      ))}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Add a stream" notice="Only the reference is stored. Provider credentials are never asked for or kept."
        fields={[{ key: 'provider', label: 'Provider', type: 'chips', options: Object.entries(PROVIDERS).map(([value, label]) => ({ value, label })), default: 'youtube' }, { key: 'channel_ref', label: 'Stream or channel reference', hint: 'The stream key name, channel id or event id on the provider (not a secret key)' },
          { key: 'playback_ref', label: 'Playback link (https)', optional: true }, { key: 'scheduled_start', label: 'Starts', type: 'datetime', optional: true }, { key: 'scheduled_end', label: 'Ends', type: 'datetime', optional: true },
          { key: 'access_policy', label: 'Who can watch', type: 'chips', options: [{ value: 'public', label: '🌐 Public' }, { value: 'subscriber', label: '🎟️ Subscribers' }, { value: 'private', label: '🔒 Private' }], default: 'public' },
          { key: 'fixture_id', label: 'Game', type: 'chips', optional: true, options: opts, hint: 'Leave empty for the whole event' },
          ...(licences.length ? [{ key: 'licence_id', label: 'Under which licence', type: 'chips', optional: isOrg, options: licences.map((l) => ({ value: l.licence_id ?? l.id, label: l.package_name ?? 'Licence' })) }] : [])]}
        submitLabel="Add stream" onSubmit={async (v) => { await api.post(`/events/${id}/media/streams`, v); d.reload(); return 'Stream added as scheduled'; }} />
      <FormSheet visible={!!live} onClose={() => setLive(null)} title="Go live" notice="A stream can only be reported live with a link people can use to watch."
        fields={[{ key: 'playback_ref', label: 'Playback link (https)' }]} submitLabel="Report live" onSubmit={async (v) => { await setState(live, 'live', { playback_ref: v.playback_ref }); return 'Reported live'; }} />
    </>
  );
}
