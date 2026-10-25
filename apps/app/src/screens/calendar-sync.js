import React, { useState } from 'react';
import { Linking, Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Seg, Sheet, Tag, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Counter } from '../pickers';
import { c } from '../theme';
import { localDate, localHHMM, localToIso, todayIn, addDays, WEEKDAYS, timeIn } from '../vtime';
import { locale } from '../locale';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const FEED_KINDS = [['match', 'Matches'], ['team', 'Team'], ['event', 'Events'], ['training', 'Coaching'], ['venue', 'Venues'], ['duty', 'Duty'], ['recovery', 'Recovery'], ['health', 'Health (shown as Busy)']];
const BUFFER_KINDS = [['match', 'Matches'], ['team', 'Team fixtures'], ['training', 'Coaching'], ['event', 'Events'], ['venue', 'Venue bookings'], ['duty', 'Duty']];
const TABS = [{ value: 'subscribe', label: 'Subscribe' }, { value: 'import', label: 'Import' }, { value: 'availability', label: 'Availability' }, { value: 'travel', label: 'Travel' }];
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const fmt12 = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const ago = (iso) => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/** Copy on the web, the share sheet on iOS / iPadOS / Android (which includes Copy). */
export async function copyOrShare(text, toast) {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); toast?.('Link copied'); return; } catch { /* fall through to a prompt-free message */ }
  }
  try { await Share.share({ message: text }); } catch (e) { toast?.(e.message); }
}

/** Run an API call with a busy flag and a toast on failure. */
function useAct(reload, onChanged) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const act = async (fn, done) => {
    setBusy(true);
    try { const r = await fn(); if (done) toast(done); await reload?.(); await onChanged?.(); return r; } catch (e) { toast(e.message); return null; } finally { setBusy(false); }
  };
  return { act, busy };
}

/** Where a panel lives: a bottom sheet on phones, a centred sheet on tablets, and an inline side column on wide screens. */
export function PanelHost({ visible, wide, title, onClose, children }) {
  if (!visible) return null;
  if (wide) {
    return (
      <Card style={{ gap: 12 }} accessibilityLabel={title}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <T size={19} weight="700">{title}</T>
          <Btn small title="Close" color={c.paper} ink={c.ink} onPress={onClose} />
        </View>
        {children}
      </Card>
    );
  }
  return <Sheet visible onClose={onClose} title={title}>{children}</Sheet>;
}

/* ---------------------------------------------------------------- Subscribe ---------------------------------------------------------------- */

function Subscribe({ data, athleteId, reload, onChanged }) {
  const { toast } = useSession();
  const { act, busy } = useAct(reload, onChanged);
  const [kinds, setKinds] = useState(['match', 'team', 'event', 'training', 'venue', 'duty', 'recovery']);
  const [detail, setDetail] = useState('busy');
  const [label, setLabel] = useState('');
  const [made, setMade] = useState(null);
  const toggle = (k) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  const create = async () => {
    const r = await act(() => api.post('/me/calendar-feeds', { athlete_id: athleteId, label: label.trim() || undefined, kinds, detail }), 'Link created');
    if (r) { setMade(r); setLabel(''); }
  };
  const addToApp = async (m) => {
    const target = m.webcal_url ?? m.url;
    if (!target) return toast('Ask the platform team to set the public address first');
    try { await Linking.openURL(target); } catch { await copyOrShare(m.url ?? target, toast); }
  };
  const feeds = data.feeds;
  return (
    <View style={{ gap: 12 }}>
      {!data.sharing_allowed ? (
        <Card color={c.cyanSoft}><T weight="700">{data.is_youth ? 'A parent or guardian arranges sharing' : 'Sharing is switched off'}</T><T size={13}>{data.is_youth ? 'Ask your guardian to allow Calendar sharing under Family & guardians. Nothing is shared until they do.' : 'The guardian\'s Calendar sharing permission is not in force for this young person. Allow it under Family & guardians.'}</T></Card>
      ) : (
        <>
          <T size={13} color={c.mute}>Add a private link to Apple Calendar, Google Calendar or Outlook. It refreshes by itself. You can switch it off at any time.</T>
          <T weight="800" size={13}>WHAT IT CARRIES</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{FEED_KINDS.map(([k, l]) => <Chip key={k} label={l} active={kinds.includes(k)} onPress={() => toggle(k)} />)}</View>
          <T weight="800" size={13}>HOW MUCH IT SHOWS</T>
          <Seg options={[{ value: 'busy', label: 'Busy only' }, { value: 'full', label: 'Full details' }]} value={detail} onChange={setDetail} color={c.pink} />
          <Field label="Name (optional)" value={label} onChangeText={setLabel} placeholder="My phone" maxLength={60} />
          <Btn title="Create link" loading={busy} disabled={!kinds.length} onPress={create} />
        </>
      )}
      {made ? (
        <Card color={c.mintSoft} accessibilityLabel="New calendar link">
          <T weight="800">✓ Link created</T>
          <T size={12} color={c.mute}>This is the only time the link is shown. Anyone who has it can see what it carries.</T>
          <T size={12} selectable numberOfLines={3}>{made.url ?? made.path}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <Btn small title="Add to my calendar app" onPress={() => addToApp(made)} />
            <Btn small title={Platform.OS === 'web' ? 'Copy link' : 'Share / copy link'} color={c.paper} ink={c.ink} onPress={() => copyOrShare(made.url ?? made.path, toast)} />
            {Platform.OS === 'web' && made.webcal_url ? <Btn small title="Google Calendar" color={c.paper} ink={c.ink} onPress={() => Linking.openURL(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(made.webcal_url)}`)} /> : null}
          </View>
        </Card>
      ) : null}
      <T weight="800" size={13}>YOUR LINKS · {feeds.length}</T>
      {feeds.length ? feeds.map((f) => (
        <Card key={f.id} accessibilityLabel={`${f.label || 'Calendar link'}, ${f.status}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{f.label || 'Calendar link'}</T>
              <T size={12} color={c.mute}>{f.detail === 'full' ? 'Full details' : 'Busy only'} · {f.kinds.length} kinds · refreshed {ago(f.last_fetched_at)} · {f.fetch_count} fetches</T>
            </View>
            <Tag label={f.status === 'active' ? 'Active' : 'Switched off'} color={f.status === 'active' ? c.mintSoft : c.line} />
          </View>
          {f.status === 'active' ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Btn small title={f.detail === 'full' ? 'Show only Busy' : 'Show details'} color={c.paper} ink={c.ink} disabled={busy} onPress={() => act(() => api.patch(`/me/calendar-feeds/${f.id}`, { version: f.version, detail: f.detail === 'full' ? 'busy' : 'full' }), 'Updated')} />
              <Btn small title="Switch off" color={c.paper} ink={c.red} disabled={busy} onPress={() => act(() => api.post(`/me/calendar-feeds/${f.id}/revoke`), 'Link switched off')} />
            </View>
          ) : null}
        </Card>
      )) : <Empty emoji="🔗" title="No links yet" sub="Create one to see your Sportarena schedule in your own calendar app." />}
    </View>
  );
}

/* ------------------------------------------------------------------ Import ------------------------------------------------------------------ */

function Import({ data, athleteId, reload, onChanged }) {
  const { act, busy } = useAct(reload, onChanged);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const add = async () => {
    const r = await act(() => api.post('/me/calendar-imports', { athlete_id: athleteId, url: url.trim(), label: label.trim() || undefined }));
    if (r) { setUrl(''); setLabel(''); }
  };
  return (
    <View style={{ gap: 12 }}>
      {!data.sharing_allowed ? (
        <Card color={c.cyanSoft}><T weight="700">{data.is_youth ? 'A parent or guardian arranges this' : 'Sharing is switched off'}</T><T size={13}>Importing another calendar needs the guardian's Calendar sharing permission.</T></Card>
      ) : (
        <>
          <T size={13} color={c.mute}>Bring in your Google, Apple or Outlook calendar as busy time, so clashes show up here. Paste its secret iCal (.ics) address. Only the times are kept, never the titles, places or people.</T>
          <Field label="Calendar address" value={url} onChangeText={setUrl} keyboardType="url" placeholder="https://… or webcal://…" hint="Google: Settings → your calendar → Secret address in iCal format. Apple: Share calendar → Public calendar." />
          <Field label="Name (optional)" value={label} onChangeText={setLabel} placeholder="Work" maxLength={60} />
          <Btn title="Import as busy time" loading={busy} disabled={url.trim().length < 8} onPress={add} />
        </>
      )}
      <T weight="800" size={13}>IMPORTED CALENDARS · {data.imports.length}</T>
      {data.imports.length ? data.imports.map((m) => (
        <Card key={m.id} accessibilityLabel={`${m.label || m.source_host}, ${m.status}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{m.label || m.source_host}</T>
              <T size={12} color={m.status === 'error' ? c.red : c.mute}>{m.status === 'error' ? `Could not sync: ${m.last_error}. Your last busy time is kept.` : `${m.event_count} busy blocks · synced ${ago(m.last_synced_at)}`}</T>
              <T size={12} color={c.mute}>{m.source_host} · busy time only</T>
            </View>
            <Tag label={m.status === 'ok' ? 'Synced' : m.status === 'error' ? 'Needs attention' : 'Pending'} color={m.status === 'ok' ? c.mintSoft : m.status === 'error' ? c.redSoft : c.sunSoft} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title={m.status === 'error' ? 'Try again' : 'Sync now'} disabled={busy} onPress={() => act(() => api.post(`/me/calendar-imports/${m.id}/sync`), 'Synced')} />
            <Btn small title="Remove" color={c.paper} ink={c.red} disabled={busy} onPress={() => act(() => api.post(`/me/calendar-imports/${m.id}/remove`), 'Removed. Your history is kept.')} />
          </View>
        </Card>
      )) : <Empty emoji="📥" title="No calendars imported" sub="Import one so personal commitments and conflicts show up in one place." />}
    </View>
  );
}

/* ---------------------------------------------------------- Availability + Travel ---------------------------------------------------------- */

function usePrefsSave(data, athleteId, reload, onChanged) {
  const { act, busy } = useAct(reload, onChanged);
  const save = (patch, done) => act(() => api.post('/me/calendar-preferences', { athlete_id: athleteId, version: data.version, ...patch }), done);
  return { save, busy };
}

function Availability({ data, athleteId, reload, onChanged }) {
  const { save, busy } = usePrefsSave(data, athleteId, reload, onChanged);
  const [adding, setAdding] = useState(false);
  const [zoning, setZoning] = useState(false);
  const toIn = (w) => ({ weekday: w.weekday, from_time: w.from_time, to_time: w.to_time });
  const remove = (w) => save({ windows: data.windows.filter((x) => x.id !== w.id).map(toIn) }, 'Window removed');
  return (
    <View style={{ gap: 12 }}>
      <T size={13} color={c.mute}>When you are usually free to play, train or travel. Anything scheduled outside these hours is flagged, never cancelled. Hours are local wall-clock time, so they stay put when the clocks change.</T>
      <Card onPress={() => setZoning(true)} accessibilityLabel={`Time zone ${data.timezone}. Change`}>
        <T size={12} weight="800" color={c.mute}>YOUR TIME ZONE</T>
        <T weight="700">{data.version === 0 && data.timezone === 'UTC' ? `${deviceTz} (this device)` : data.timezone} ›</T>
      </Card>
      {WEEK.map((d) => {
        const ws = data.windows.filter((w) => w.weekday === d);
        return (
          <View key={d} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
            <T weight="800" style={{ width: 44 }}>{WEEKDAYS[d]}</T>
            <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {ws.length ? ws.map((w) => <Chip key={w.id} label={`${fmt12(w.from_time)} – ${fmt12(w.to_time)}  ✕`} active onPress={() => !busy && remove(w)} />) : <T size={13} color={c.mute}>Not set</T>}
            </View>
          </View>
        );
      })}
      <Btn title="+ Add hours" color={c.paper} ink={c.ink} onPress={() => setAdding(true)} />
      <FormSheet visible={adding} onClose={() => setAdding(false)} title="Add available hours" submitLabel="Add"
        initial={{ days: [1, 2, 3, 4, 5], from: '18:00', to: '21:00' }}
        fields={[
          { key: 'days', label: 'Which days', type: 'weekdays' },
          { key: 'from', label: 'From', type: 'time', step: 30 },
          { key: 'to', label: 'Until', type: 'time', step: 30 },
        ]}
        onSubmit={async (v) => {
          if (!v.days?.length) throw new Error('Pick at least one day');
          if (v.to <= v.from) throw new Error('The end time must be after the start');
          const to = v.to === '24:00' ? '23:59' : v.to;
          const merged = [...data.windows.map(toIn), ...v.days.map((weekday) => ({ weekday, from_time: v.from, to_time: to }))];
          await api.post('/me/calendar-preferences', { athlete_id: athleteId, version: data.version, windows: merged });
          await reload(); await onChanged?.();
          return 'Hours added';
        }} />
      <FormSheet visible={zoning} onClose={() => setZoning(false)} title="Your time zone" submitLabel="Save" initial={{ timezone: data.version === 0 ? deviceTz : data.timezone }}
        fields={[{ key: 'timezone', label: 'Time zone', type: 'timezone' }]}
        onSubmit={async (v) => { await api.post('/me/calendar-preferences', { athlete_id: athleteId, version: data.version, timezone: v.timezone }); await reload(); await onChanged?.(); return 'Time zone saved'; }} />
    </View>
  );
}

function Travel({ data, athleteId, reload, onChanged }) {
  const { save, busy } = usePrefsSave(data, athleteId, reload, onChanged);
  const start = Object.fromEntries(BUFFER_KINDS.map(([k]) => { const b = data.buffers.find((x) => x.kind === k); return [k, { before_min: b?.before_min ?? 0, after_min: b?.after_min ?? 0 }]; }));
  const [v, setV] = useState(start);
  const set = (k, f, n) => setV((p) => ({ ...p, [k]: { ...p[k], [f]: n } }));
  return (
    <View style={{ gap: 12 }}>
      <T size={13} color={c.mute}>How long you need to get to and from each kind of commitment. If two commitments are closer together than that, you get a travel warning.</T>
      {BUFFER_KINDS.map(([k, l]) => (
        <Card key={k} accessibilityLabel={`${l} travel time`}>
          <T weight="700">{l}</T>
          <Counter label="Travel before" value={v[k].before_min} min={0} max={480} step={5} suffix=" min" onChange={(n) => set(k, 'before_min', n)} />
          <Counter label="Travel after" value={v[k].after_min} min={0} max={480} step={5} suffix=" min" onChange={(n) => set(k, 'after_min', n)} />
        </Card>
      ))}
      <Btn title="Save travel times" loading={busy} onPress={() => save({ buffers: BUFFER_KINDS.map(([k]) => ({ kind: k, ...v[k] })) }, 'Travel times saved')} />
    </View>
  );
}

/** Calendar sync: subscribe, import, availability and travel. `athleteId` is for a verified guardian acting for a young person. */
export function CalendarSyncPanel({ athleteId, initialTab = 'subscribe', onChanged }) {
  const [tab, setTab] = useState(initialTab);
  const d = useLoad(() => api.get('/me/calendar-sync', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  const Body = { subscribe: Subscribe, import: Import, availability: Availability, travel: Travel }[tab];
  return (
    <View style={{ gap: 12 }}>
      <Seg options={TABS} value={tab} onChange={setTab} color={c.pink} />
      {d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : d.loading && !d.data ? <Loading /> : <Body key={`${tab}-${d.data.version}`} data={d.data} athleteId={athleteId} reload={d.reload} onChanged={onChanged} />}
    </View>
  );
}

/** A guardian's entry point for a young person (opened from Family & guardians). */
export function GuardianCalendarSheet({ child, onClose }) {
  if (!child) return null;
  return <Sheet visible onClose={onClose} title={`${child.display_name ?? 'Calendar'} · calendar`}><CalendarSyncPanel athleteId={child.id} /></Sheet>;
}

/* ---------------------------------------------------------------- Conflicts ---------------------------------------------------------------- */

const SEVERITY = { high: ['Clash', c.redSoft], medium: ['Not enough travel time', c.sunSoft], info: ['Outside your hours', c.cyanSoft] };

function Resolution({ r, conflict, busy, run, onMove, nav }) {
  if (r.action === 'move') return <Btn small title={r.label} color={c.paper} ink={c.ink} disabled={busy} onPress={() => onMove(conflict.items.find((i) => i.source_id === r.source_id))} />;
  if (r.action === 'remove') return <Btn small title={r.label} color={c.paper} ink={c.red} disabled={busy} onPress={() => run(() => api.post(`/me/blocks/${r.args.id}/archive`), 'Removed from your calendar')} />;
  if (r.action === 'rsvp_no') return <Btn small title={r.label} color={c.paper} ink={c.ink} disabled={busy} onPress={() => run(() => api.post(`/teams/${r.args.id}/attendance`, { ...(r.args.fixture_id ? { fixture_id: r.args.fixture_id } : { event_id: r.args.event_id }), rsvp: 'no' }), 'Marked as out. Your manager is told.')} />;
  if (r.action === 'external') return <Btn small title="Sync other calendars" color={c.paper} ink={c.ink} disabled={busy} onPress={() => run(async () => { const s = await api.get('/me/calendar-sync'); for (const m of s.imports) await api.post(`/me/calendar-imports/${m.id}/sync`); })} />;
  const { screen, params = {} } = r.link ?? {};
  return <Btn small title="Open to change it" color={c.paper} ink={c.ink} onPress={() => (screen === 'Health' ? nav.push('Health') : screen === 'Event' && params.id ? nav.push('Event', params) : nav.goTab('Schedule', { section: 'agenda' }))} />;
}

/** Every clash on the calendar with what you can do about it. Bookings and appointments are never cancelled from here. */
export function ConflictsPanel({ athleteId, onChanged, days = 28 }) {
  const nav = useNav();
  const { toast } = useSession();
  const today = todayIn(deviceTz);
  const d = useLoad(() => api.get('/me/schedule-conflicts', { from: today, to: addDays(today, days - 1), ...(athleteId ? { athlete_id: athleteId } : {}) }), [athleteId, days]);
  const [moving, setMoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn, done) => {
    setBusy(true);
    try { await fn(); if (done) toast(done); await d.reload(); await onChanged?.(); } catch (e) { toast(e.message); await d.reload(); } finally { setBusy(false); }
  };
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (d.loading && !d.data) return <Loading />;
  const { conflicts, summary } = d.data;
  const when = (i) => `${new Date(i.starts_at).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: i.timezone })} · ${timeIn(i.starts_at, i.timezone)}–${timeIn(i.ends_at, i.timezone)} · ${i.duration_min} min${i.duration_assumed ? ' (assumed)' : ''}`;
  return (
    <View style={{ gap: 12 }}>
      <T size={13} color={c.mute}>Next {days} days, using the real length of each commitment and your travel times. Nothing is changed unless you choose.</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Tag label={`${summary.overlap} clash${summary.overlap === 1 ? '' : 'es'}`} color={c.redSoft} />
        <Tag label={`${summary.travel_buffer} travel`} color={c.sunSoft} />
        <Tag label={`${summary.outside_availability} outside hours`} color={c.cyanSoft} />
      </View>
      {conflicts.length ? conflicts.map((cf) => {
        const [name, tone] = SEVERITY[cf.severity];
        return (
          <Card key={cf.id} style={{ gap: 8 }} accessibilityLabel={`${name}. ${cf.message}`}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{cf.message}</T><Tag label={name} color={tone} /></View>
            {cf.items.map((i) => <T key={`${i.source_type}${i.source_id}`} size={13} color={c.mute}>{i.title} · {when(i)}</T>)}
            {cf.items.some((i) => ['booking', 'appointment', 'coach_hire'].includes(i.source_type)) ? <T size={12} color={c.mute}>Bookings and appointments are never cancelled automatically.</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {cf.resolutions.map((r) => <Resolution key={`${r.action}${r.source_id}`} r={r} conflict={cf} busy={busy} run={run} onMove={setMoving} nav={nav} />)}
            </View>
          </Card>
        );
      }) : <Empty emoji="✅" title="No conflicts" sub="Nothing overlaps, and everything fits your travel times and hours." />}
      <FormSheet visible={!!moving} onClose={() => setMoving(null)} title="Move this block" submitLabel="Move"
        initial={moving ? { date: localDate(moving.starts_at, deviceTz), start: localHHMM(moving.starts_at, deviceTz), end: localHHMM(moving.ends_at, deviceTz) } : undefined}
        fields={[{ key: 'date', label: 'Day', type: 'date' }, { key: 'start', label: 'From', type: 'time', step: 15 }, { key: 'end', label: 'Until', type: 'time', step: 15 }]}
        onSubmit={async (v) => {
          if (v.end <= v.start) throw new Error('The end time must be after the start');
          const res = d.data.conflicts.flatMap((x) => x.resolutions).find((r) => r.action === 'move' && r.source_id === moving.source_id);
          await api.patch(`/me/blocks/${moving.source_id}`, { version: res.args.version, starts_at: localToIso(v.date, v.start, deviceTz), ends_at: localToIso(v.date, v.end === '24:00' ? '23:59' : v.end, deviceTz), timezone: deviceTz });
          await d.reload(); await onChanged?.();
          return 'Block moved';
        }} />
    </View>
  );
}
